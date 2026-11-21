// Desktop shell for booster.js: a window, a tray icon, and a background
// `node booster.js --ipc --idle` process that does the Steam work.
//
// Lifecycle: connect (log in) -> boost on/off any number of times -> disconnect.

// GUI subsystem in every build, so Windows never opens a console window next to the app.
// Tests need the console subsystem so their output is visible.
#![cfg_attr(not(test), windows_subsystem = "windows")]

mod crashlog;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::path::BaseDirectory;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent, Wry};

const MAX_ENTRIES: usize = 32; // Steam's limit, the custom title counts as one
const TRAY_ID: &str = "main";
const STDERR_TAIL_LINES: usize = 50;

/// Per-account form values. Each account owns its own games and title.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
struct AccountSettings {
    games: Vec<u32>,
    custom_title: String,
    invisible: bool,
    force: bool,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    accounts: BTreeMap<String, AccountSettings>,
    active_account: String,
    /// Global, owned by booster events, not by the per-account form.
    resume_boost: bool,
    // Read-only legacy shape from before the account manager. Never written back.
    #[serde(default, skip_serializing)]
    account_name: String,
    #[serde(default, skip_serializing)]
    games: Vec<u32>,
    #[serde(default, skip_serializing)]
    custom_title: String,
    #[serde(default, skip_serializing)]
    invisible: bool,
    #[serde(default, skip_serializing)]
    force: bool,
}

struct Running {
    run: u64,
    account: String,
    child: Child,
    stdin: ChildStdin,
    /// Set only when the user asked to stop, so a clean 0 exit isn't logged as a crash.
    stopped_by_user: bool,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
}

#[derive(Default)]
struct AppState {
    running: Mutex<Option<Running>>,
    boosting: AtomicBool,
    toggle_item: Mutex<Option<MenuItem<Wry>>>,
    next_run: AtomicU64,
    /// Serializes read-modify-write cycles on settings.json. The form and the
    /// booster's status reader both update the file.
    settings_lock: Mutex<()>,
}

// ---------- settings ----------

/// Same rule as booster.js (/^\w+$/). Also keeps the name safe to use in a file path.
fn valid_account(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn normalize(mut s: Settings) -> Settings {
    // Drop map keys that could not name a token file.
    s.accounts.retain(|name, _| valid_account(name));

    // Old settings.json kept a single account at the top level.
    if s.accounts.is_empty() && valid_account(&s.account_name) {
        s.accounts.insert(
            s.account_name.clone(),
            AccountSettings {
                games: std::mem::take(&mut s.games),
                custom_title: std::mem::take(&mut s.custom_title),
                invisible: s.invisible,
                force: s.force,
            },
        );
        s.active_account = s.account_name.clone();
    }

    if !s.active_account.is_empty() && !valid_account(&s.active_account) {
        s.active_account.clear();
    }
    if s.active_account.is_empty() {
        s.active_account = s.accounts.keys().next().cloned().unwrap_or_default();
    }
    if !s.active_account.is_empty() && !s.accounts.contains_key(&s.active_account) {
        s.accounts.insert(s.active_account.clone(), AccountSettings::default());
    }
    s
}

fn validate(s: &Settings) -> Result<(), String> {
    if !s.active_account.is_empty() && !valid_account(&s.active_account) {
        return Err("Account name may only contain letters, numbers and underscores.".into());
    }
    for (name, account) in &s.accounts {
        if !valid_account(name) {
            return Err("Account name may only contain letters, numbers and underscores.".into());
        }
        if account.games.contains(&0) {
            return Err(format!("{name}: 0 is not a valid app ID."));
        }
        let has_title = !account.custom_title.trim().is_empty();
        let max = MAX_ENTRIES - usize::from(has_title);
        if account.games.len() > max {
            return Err(format!(
                "{name}: Steam allows at most {max} games{}.",
                if has_title { " alongside a custom title" } else { "" }
            ));
        }
    }
    Ok(())
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn session_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("session"))
}

fn reserved_account(name: &str) -> bool {
    let name = name.to_lowercase();
    matches!(name.as_str(), "con" | "prn" | "aux" | "nul")
        || (name.len() == 4
            && (name.starts_with("com") || name.starts_with("lpt"))
            && matches!(name.as_bytes()[3], b'1'..=b'9'))
}

fn token_file(app: &AppHandle, account: &str) -> Result<PathBuf, String> {
    if !valid_account(account) {
        return Err("Enter a valid account name first.".into());
    }
    let name = account.to_lowercase();
    // Must match WINDOWS_RESERVED in booster.js: device names need a prefix.
    let file = if reserved_account(&name) {
        format!("_{name}.token")
    } else {
        format!("{name}.token")
    };
    Ok(session_dir(app)?.join(file))
}

/// Reverse of token_file's naming, for token files that predate settings.json.
fn account_from_token_file(file_name: &str) -> Option<String> {
    let base = file_name.strip_suffix(".token")?;
    if let Some(rest) = base.strip_prefix('_') {
        if reserved_account(rest) && valid_account(rest) {
            return Some(rest.to_string());
        }
    }
    valid_account(base).then(|| base.to_string())
}

fn load_settings(app: &AppHandle) -> Settings {
    config_dir(app)
        .ok()
        .and_then(|dir| fs::read_to_string(dir.join("settings.json")).ok())
        .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
        .map(normalize)
        .unwrap_or_default()
}

fn store_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    validate(s)?;
    let text = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    let dir = config_dir(app)?;
    let path = dir.join("settings.json");
    let tmp = dir.join("settings.json.tmp");
    // Write-then-rename: readers never see a half-written settings file.
    fs::write(&tmp, text).map_err(|e| format!("Could not save settings: {e}"))?;
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Could not save settings: {e}"));
    }
    Ok(())
}

fn booster_config(s: &Settings) -> Result<Value, String> {
    let account = s
        .accounts
        .get(&s.active_account)
        .ok_or("Choose a Steam account first.")?;
    Ok(json!({
        "accountName": s.active_account,
        "games": account.games,
        "customTitle": account.custom_title.trim(),
        "invisible": account.invisible,
        "force": account.force,
    }))
}

// ---------- tray and window helpers ----------

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // Show first: a window hidden while minimized has to be visible before it can be restored.
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn refresh_tray(app: &AppHandle, status: &str) {
    let state = app.state::<AppState>();
    let connected = state.running.lock().unwrap().is_some();
    let boosting = state.boosting.load(Ordering::SeqCst);
    if let Some(item) = state.toggle_item.lock().unwrap().as_ref() {
        let _ = item.set_text(if connected && boosting { "Pause boosting" } else { "Start boosting" });
    }
    let label = match status {
        "boosting" => "boosting",
        "paused" => "paused (playing elsewhere)",
        "idle" => "logged in, not boosting",
        "connecting" => "connecting...",
        _ => "offline",
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(format!("Steam Hour Booster - {label}")));
    }
}

fn report_error(app: &AppHandle, msg: &str) {
    let _ = app.emit("booster", json!({ "type": "error", "msg": msg }));
}

// ---------- crash log ----------

fn crash_log_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_log_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("crash.log"))
}

fn log_crash(app: &AppHandle, summary: &str, details: &str) {
    if let Some(path) = crash_log_path(app) {
        crashlog::append_entry(&path, summary, details);
    }
}

// ---------- booster process ----------

fn booster_script(app: &AppHandle) -> Result<PathBuf, String> {
    // Installed app: bundled next to the executable as a resource.
    if let Ok(path) = app.path().resolve("booster/booster.js", BaseDirectory::Resource) {
        if path.is_file() {
            return Ok(path);
        }
    }
    // Development: the repository root, two levels above src-tauri.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("booster.js");
    if dev.is_file() {
        return Ok(dev);
    }
    Err("Could not find booster.js next to the app.".into())
}

/// Where to look for Node: `node` on PATH first (respects the user's choice of version),
/// then the standard Windows install locations. The app can start without Node on its
/// PATH, e.g. with nvm-windows or when Node was installed after Explorer started.
fn node_candidates() -> Vec<PathBuf> {
    let mut candidates = vec![PathBuf::from("node")];
    #[cfg(windows)]
    {
        let under = |var: &str, rest: &[&str]| {
            std::env::var_os(var).map(|base| rest.iter().fold(PathBuf::from(base), |p, part| p.join(part)))
        };
        candidates.extend(
            [
                under("ProgramFiles", &["nodejs", "node.exe"]),
                under("LOCALAPPDATA", &["Programs", "nodejs", "node.exe"]),
                under("NVM_SYMLINK", &["node.exe"]),
            ]
            .into_iter()
            .flatten()
            .filter(|path| path.is_file()),
        );
    }
    candidates
}

/// Log in. With `boost`, boosting starts as soon as the login succeeds.
fn connect_booster(app: &AppHandle, s: &Settings, boost: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut running = state.running.lock().unwrap();
    if running.is_some() {
        return Err("Already logged in.".into());
    }
    validate(s)?;
    if !valid_account(&s.active_account) {
        return Err("Enter your Steam account name first.".into());
    }
    let config = booster_config(s)?;

    // The booster reads its settings from a config file, so nothing has to be escaped on the command line.
    let script = match booster_script(app) {
        Ok(script) => script,
        Err(message) => {
            log_crash(app, "Could not find booster.js", &message);
            return Err(message);
        }
    };
    let cfg_path = config_dir(app)?.join("booster-config.json");
    if let Err(e) = fs::write(&cfg_path, config.to_string()) {
        let message = format!("Could not write the booster config: {e}");
        log_crash(app, "Could not write the booster config", &message);
        return Err(message);
    }

    let session = session_dir(app)?;
    let mut spawned = None;
    for node in node_candidates() {
        let mut cmd = Command::new(&node);
        cmd.arg(&script)
            .args(["--ipc", "--idle", "-c"])
            .arg(&cfg_path)
            .env("BOOSTER_DATA_DIR", &session)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(dir) = script.parent() {
            cmd.current_dir(dir);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        match cmd.spawn() {
            Ok(child) => {
                spawned = Some(child);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue, // try the next location
            Err(e) => {
                let message = format!("Could not start the booster: {e}");
                log_crash(app, "Could not start the booster", &message);
                return Err(message);
            }
        }
    }
    let mut child = match spawned {
        Some(child) => child,
        None => {
            let message = "Node.js was not found. Install it from nodejs.org, then restart the app.";
            log_crash(app, "Could not start the booster", message);
            return Err(message.to_string());
        }
    };
    let (Some(mut stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
        let _ = child.kill();
        let message = "Could not connect to the booster process.";
        log_crash(app, "Could not start the booster", message);
        return Err(message.into());
    };
    if boost {
        // Queued until the login finishes.
        let _ = writeln!(stdin, "{}", json!({ "type": "boost", "on": true })).and_then(|_| stdin.flush());
    }

    let stderr_tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LINES)));
    let run = state.next_run.fetch_add(1, Ordering::SeqCst) + 1;
    *running = Some(Running {
        run,
        account: s.active_account.clone(),
        child,
        stdin,
        stopped_by_user: false,
        stderr_tail: stderr_tail.clone(),
    });
    drop(running);
    // A queued boost is about to be processed; reflect it in the tray right away.
    state.boosting.store(boost, Ordering::SeqCst);

    refresh_tray(app, "connecting");
    let _ = app.emit("booster-started", json!({ "boost": boost, "run": run }));

    let handle = app.clone();
    let tail = stderr_tail;
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                if let Ok(mut buffer) = tail.lock() {
                    if buffer.len() >= STDERR_TAIL_LINES {
                        buffer.pop_front();
                    }
                    buffer.push_back(line.clone());
                }
                let _ = handle.emit("booster", json!({ "type": "log", "level": "warn", "msg": line }));
            }
        }
    });

    let handle = app.clone();
    thread::spawn(move || {
        let mut last_status = String::new();
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let event: Value = serde_json::from_str(&line)
                .unwrap_or_else(|_| json!({ "type": "log", "level": "info", "msg": line }));
            if let Some(message) = crashlog::event_line(&event) {
                log_crash(&handle, "Booster error", &message);
            }
            match event["type"].as_str() {
                Some("status") => {
                    let status = event["state"].as_str().unwrap_or_default();
                    if status != last_status {
                        let boosting = matches!(status, "boosting" | "paused");
                        handle.state::<AppState>().boosting.store(boosting, Ordering::SeqCst);
                        refresh_tray(&handle, status);
                        last_status = status.to_string();
                    }
                }
                Some("boosting") => {
                    let on = event["on"].as_bool().unwrap_or(false);
                    let state = handle.state::<AppState>();
                    state.boosting.store(on, Ordering::SeqCst);
                    refresh_tray(&handle, &last_status);
                    let _guard = state.settings_lock.lock().unwrap();
                    let mut s = load_settings(&handle);
                    if s.resume_boost != on {
                        s.resume_boost = on;
                        let _ = store_settings(&handle, &s);
                    }
                }
                _ => {}
            }
            let _ = handle.emit("booster", event);
        }
        on_booster_exit(&handle, run);
    });

    Ok(())
}

fn on_booster_exit(app: &AppHandle, run: u64) {
    let state = app.state::<AppState>();
    let finished = {
        let mut running = state.running.lock().unwrap();
        if running.as_ref().map(|r| r.run) == Some(run) { running.take() } else { None }
    };
    // A newer run (or the app's shutdown path) already owns this process. Emitting
    // an exit event here would clobber the live run's UI state.
    let Some(mut running) = finished else { return; };
    // stdout closing normally means the booster has exited. If the process lingers anyway,
    // don't block forever: request_stop's kill timer can no longer see this run.
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut killed = false;
    let code = loop {
        match running.child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = running.child.kill();
                killed = true;
                break running.child.wait().ok().and_then(|status| status.code());
            }
        }
    };
    if killed || (code != Some(0) && !running.stopped_by_user) {
        // Give the stderr reader a moment to drain the final lines.
        thread::sleep(Duration::from_millis(50));
        let tail = running
            .stderr_tail
            .lock()
            .map(|buffer| buffer.iter().cloned().collect::<Vec<_>>().join("\n"))
            .unwrap_or_default();
        let details = format!(
            "exit code: {code:?}\nkilled after 5s wait: {killed}\naccount: {}\nlast stderr:\n{tail}",
            running.account
        );
        log_crash(app, "Booster exited unexpectedly", &details);
    }
    state.boosting.store(false, Ordering::SeqCst);
    refresh_tray(app, "offline");
    let _ = app.emit("booster-exit", json!({ "code": code, "run": run }));
}

fn send_to_booster(app: &AppHandle, message: &Value) -> Result<u64, String> {
    let state = app.state::<AppState>();
    let mut running = state.running.lock().unwrap();
    let r = running.as_mut().ok_or("Not logged in.")?;
    writeln!(r.stdin, "{message}")
        .and_then(|_| r.stdin.flush())
        .map_err(|e| format!("Could not reach the booster: {e}"))?;
    Ok(r.run)
}

/// Ask the booster to log off; kill it if it hasn't exited after a few seconds.
fn request_stop(app: &AppHandle) {
    let run = {
        let state = app.state::<AppState>();
        let mut running = state.running.lock().unwrap();
        let Some(r) = running.as_mut() else { return; };
        let written = writeln!(r.stdin, "{}", json!({ "type": "stop" })).and_then(|_| r.stdin.flush());
        if written.is_ok() {
            // A clean 0 exit here is user-caused and must not be logged as a crash.
            r.stopped_by_user = true;
        } else {
            let _ = r.child.kill();
        }
        r.run
    };
    let handle = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(4));
        if let Some(r) = handle.state::<AppState>().running.lock().unwrap().as_mut() {
            if r.run == run {
                let _ = r.child.kill();
            }
        }
    });
}

/// Used when the app quits: log off cleanly, but never hang the exit.
fn stop_blocking(app: &AppHandle) {
    let taken = app.state::<AppState>().running.lock().unwrap().take();
    if let Some(mut r) = taken {
        let _ = writeln!(r.stdin, "{}", json!({ "type": "stop" })).and_then(|_| r.stdin.flush());
        let deadline = Instant::now() + Duration::from_millis(2500);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = r.child.try_wait() {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        let _ = r.child.kill();
        let _ = r.child.wait();
    }
}

fn set_boosting(app: &AppHandle, on: bool) -> Result<(), String> {
    send_to_booster(app, &json!({ "type": "boost", "on": on })).map(|_| ())
}

// ---------- commands for the window ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionState {
    connected: bool,
    boosting: bool,
    account: Option<String>,
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    load_settings(&app)
}

/// Saves the settings and, while logged in, applies them to the active account.
#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let s = {
        let state = app.state::<AppState>();
        let _guard = state.settings_lock.lock().unwrap();
        let mut s = normalize(settings);
        s.resume_boost = load_settings(&app).resume_boost; // owned by the booster's state, not the form
        store_settings(&app, &s)?;
        s
    };
    // Only push a live config to the process that is running this account. A
    // switch changes activeAccount before the old process has exited.
    let same_account = {
        let state = app.state::<AppState>();
        let running = state.running.lock().unwrap();
        running.as_ref().map(|r| r.account == s.active_account).unwrap_or(false)
    };
    if same_account {
        let mut message = booster_config(&s)?;
        message["type"] = json!("config");
        send_to_booster(&app, &message)?;
    }
    Ok(())
}

#[tauri::command]
fn connect(app: AppHandle, settings: Settings, boost: bool) -> Result<(), String> {
    let s = {
        let state = app.state::<AppState>();
        let _guard = state.settings_lock.lock().unwrap();
        let mut s = normalize(settings);
        s.resume_boost = load_settings(&app).resume_boost;
        store_settings(&app, &s)?;
        s
    };
    connect_booster(&app, &s, boost)
}

#[tauri::command]
fn set_boost(app: AppHandle, on: bool) -> Result<(), String> {
    set_boosting(&app, on)
}

#[tauri::command]
fn disconnect(app: AppHandle) {
    request_stop(&app);
}

#[tauri::command]
fn connection_state(app: AppHandle) -> ConnectionState {
    let state = app.state::<AppState>();
    let running = state.running.lock().unwrap();
    let connected = running.is_some();
    ConnectionState {
        connected,
        boosting: connected && state.boosting.load(Ordering::SeqCst),
        account: running.as_ref().map(|r| r.account.clone()),
    }
}

#[tauri::command]
fn answer_prompt(app: AppHandle, id: u64, value: String) -> Result<(), String> {
    send_to_booster(&app, &json!({ "type": "answer", "id": id, "value": value })).map(|_| ())
}

#[tauri::command]
fn has_saved_login(app: AppHandle, account: String) -> bool {
    token_file(&app, &account).map(|f| f.is_file()).unwrap_or(false)
}

#[tauri::command]
fn forget_login(app: AppHandle, account: String) -> Result<bool, String> {
    match fs::remove_file(token_file(&app, &account)?) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("Could not delete the saved login: {e}")),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountInfo {
    name: String,
    has_token: bool,
}

#[tauri::command]
fn list_accounts(app: AppHandle) -> Vec<AccountInfo> {
    let s = load_settings(&app);
    let mut names: BTreeMap<String, String> = s
        .accounts
        .keys()
        .map(|name| (name.to_lowercase(), name.clone()))
        .collect();
    // Tokens are the source of truth for "saved"; include any that predate settings.json.
    if let Ok(dir) = session_dir(&app) {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let file_name = entry.file_name();
                if let Some(file_name) = file_name.to_str() {
                    if let Some(name) = account_from_token_file(file_name) {
                        names.entry(name.to_lowercase()).or_insert(name);
                    }
                }
            }
        }
    }
    names
        .into_values()
        .map(|name| AccountInfo {
            has_token: token_file(&app, &name).map(|file| file.is_file()).unwrap_or(false),
            name,
        })
        .collect()
}

/// Forget one account: delete its token and its settings entry. The account must
/// not be the one currently running; the UI stops the booster first.
#[tauri::command]
fn forget_account(app: AppHandle, account: String) -> Result<bool, String> {
    if !valid_account(&account) {
        return Err("Enter a valid account name first.".into());
    }
    let busy = {
        let state = app.state::<AppState>();
        let running = state.running.lock().unwrap();
        running.as_ref().map(|r| r.account == account).unwrap_or(false)
    };
    if busy {
        return Err("Stop the booster before forgetting this account.".into());
    }
    let removed = match fs::remove_file(token_file(&app, &account)?) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(format!("Could not delete the saved login: {e}")),
    };
    let state = app.state::<AppState>();
    let _guard = state.settings_lock.lock().unwrap();
    let mut s = load_settings(&app);
    s.accounts.remove(&account);
    if s.active_account == account {
        s.active_account.clear();
    }
    store_settings(&app, &s)?;
    Ok(removed)
}

#[tauri::command]
fn open_logs_folder(app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";
    Command::new(program)
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("Could not open {}: {e}", dir.display()))?;
    Ok(())
}

// ---------- app ----------

fn on_tray_toggle(app: &AppHandle) {
    let state = app.state::<AppState>();
    let connected = state.running.lock().unwrap().is_some();
    let result = if connected {
        set_boosting(app, !state.boosting.load(Ordering::SeqCst))
    } else {
        let s = load_settings(app);
        if s.active_account.is_empty() {
            show_window(app);
            Err("Add a Steam account first.".to_string())
        } else {
            // Without a saved login the window has to ask for the password.
            if !has_saved_login(app.clone(), s.active_account.clone()) {
                show_window(app);
            }
            connect_booster(app, &s, true)
        }
    };
    if let Err(e) = result {
        show_window(app);
        report_error(app, &e);
    }
}

fn main() {
    let app = tauri::Builder::default()
        // A second launch just brings the running app to the front (two boosters would fight over the account).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_window(app)))
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            connect,
            set_boost,
            disconnect,
            connection_state,
            answer_prompt,
            has_saved_login,
            forget_login,
            list_accounts,
            forget_account,
            open_logs_folder
        ])
        .setup(|app| {
            // Persist legacy single-account settings in the new shape once at startup.
            {
                let state = app.state::<AppState>();
                let _guard = state.settings_lock.lock().unwrap();
                let s = load_settings(app.handle());
                let _ = store_settings(app.handle(), &s);
            }

            // Write panics to crash.log before the default hook prints (and before abort).
            if let Some(path) = crash_log_path(app.handle()) {
                let previous = std::panic::take_hook();
                std::panic::set_hook(Box::new(move |info| {
                    crashlog::append_entry_from_panic(&path, "Rust panic", &info.to_string());
                    previous(info);
                }));
            }

            let show = MenuItem::with_id(app, "show", "Show window", true, None::<&str>)?;
            let toggle = MenuItem::with_id(app, "toggle", "Start boosting", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &toggle, &quit])?;
            *app.state::<AppState>().toggle_item.lock().unwrap() = Some(toggle);

            let mut tray = TrayIconBuilder::with_id(TRAY_ID)
                .tooltip("Steam Hour Booster - offline")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_window(app),
                    "toggle" => on_tray_toggle(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Minimizing hides the window; the tray icon brings it back.
            if let WindowEvent::Resized(_) = event {
                if window.is_minimized().unwrap_or(false) {
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to start the app");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            stop_blocking(app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Settings {
        normalize(serde_json::from_str::<Settings>(text).expect("valid settings JSON"))
    }

    #[test]
    fn migrates_legacy_single_account_settings() {
        let s = parse(
            r#"{
                "accountName": "Alice",
                "games": [730, 440],
                "customTitle": "Title",
                "invisible": true,
                "force": true,
                "resumeBoost": true
            }"#,
        );
        assert_eq!(s.active_account, "Alice");
        let account = &s.accounts["Alice"];
        assert_eq!(account.games, vec![730, 440]);
        assert_eq!(account.custom_title, "Title");
        assert!(account.invisible);
        assert!(account.force);
        assert!(s.resume_boost);

        let text = serde_json::to_string(&s).unwrap();
        assert!(text.contains("\"accounts\""));
        assert!(text.contains("\"activeAccount\":\"Alice\""));
        assert!(!text.contains("accountName"), "legacy keys must not be written back");
    }

    #[test]
    fn parses_the_accounts_map_and_active_account() {
        let s = parse(
            r#"{
                "accounts": {
                    "Alice": {"games": [730], "customTitle": "", "invisible": false, "force": false},
                    "Bob": {"games": [570], "customTitle": "B", "invisible": true, "force": true}
                },
                "activeAccount": "Bob",
                "resumeBoost": false
            }"#,
        );
        assert_eq!(s.accounts.len(), 2);
        assert_eq!(s.active_account, "Bob");
        assert_eq!(s.accounts["Bob"].games, vec![570]);
        assert!(s.accounts["Bob"].invisible);
    }

    #[test]
    fn drops_invalid_account_keys_and_picks_a_valid_active_account() {
        let s = parse(
            r#"{
                "accounts": {
                    "bad name": {"games": [730]},
                    "Alice": {"games": [440]}
                },
                "activeAccount": "bad name"
            }"#,
        );
        assert!(!s.accounts.contains_key("bad name"));
        assert_eq!(s.active_account, "Alice");
    }

    #[test]
    fn does_not_migrate_an_invalid_legacy_account_name() {
        let s = parse(r#"{"accountName": "bad name", "games": [730]}"#);
        assert!(s.accounts.is_empty());
        assert_eq!(s.active_account, "");
    }

    #[test]
    fn creates_a_default_entry_for_an_unknown_active_account() {
        let s = parse(r#"{"accounts": {}, "activeAccount": "Bob"}"#);
        assert_eq!(s.active_account, "Bob");
        assert!(s.accounts.contains_key("Bob"));
    }

    #[test]
    fn validates_limits_per_account() {
        let games = (0..MAX_ENTRIES).map(|index| 730 + index as u32).collect();
        let mut s = Settings::default();
        s.active_account = "Alice".into();
        s.accounts.insert(
            "Alice".into(),
            AccountSettings {
                games,
                custom_title: "Title".into(),
                ..AccountSettings::default()
            },
        );
        let error = validate(&s).unwrap_err();
        assert!(error.contains("Alice"));
        assert!(error.contains("at most 31"));
    }

    #[test]
    fn token_file_names_round_trip() {
        assert_eq!(account_from_token_file("alice.token").as_deref(), Some("alice"));
        assert_eq!(account_from_token_file("_con.token").as_deref(), Some("con"));
        assert_eq!(account_from_token_file("_alice.token").as_deref(), Some("_alice"));
        assert_eq!(account_from_token_file("bad name.token"), None);
        assert_eq!(account_from_token_file("alice.txt"), None);
        assert!(reserved_account("con"));
        assert!(reserved_account("COM1"));
        assert!(!reserved_account("alice"));
    }

    #[test]
    fn booster_config_uses_the_active_account() {
        let mut s = Settings::default();
        s.accounts.insert(
            "Alice".into(),
            AccountSettings {
                games: vec![730],
                ..AccountSettings::default()
            },
        );
        s.accounts.insert(
            "Bob".into(),
            AccountSettings {
                games: vec![570],
                custom_title: "Title".into(),
                invisible: true,
                force: true,
            },
        );
        s.active_account = "Bob".into();
        let config = booster_config(&s).unwrap();
        assert_eq!(config["accountName"].as_str(), Some("Bob"));
        assert_eq!(config["games"][0].as_u64(), Some(570));
        assert_eq!(config["customTitle"].as_str(), Some("Title"));
        assert_eq!(config["invisible"].as_bool(), Some(true));
        assert_eq!(config["force"].as_bool(), Some(true));
    }
}
