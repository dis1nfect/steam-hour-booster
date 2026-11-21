// Desktop shell for booster.js: a window, a tray icon, and a background
// `node booster.js --ipc --idle` process that does the Steam work.
//
// Lifecycle: connect (log in) -> boost on/off any number of times -> disconnect.

// GUI subsystem in every build, so Windows never opens a console window next to the app.
#![windows_subsystem = "windows"]

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::path::BaseDirectory;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent, Wry};

const MAX_ENTRIES: usize = 32; // Steam's limit, the custom title counts as one
const TRAY_ID: &str = "main";

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    account_name: String,
    games: Vec<u32>,
    custom_title: String,
    invisible: bool,
    force: bool,
    /// Whether boosting was on when the app last ran, so it can pick up where it left off.
    resume_boost: bool,
}

struct Running {
    run: u64,
    child: Child,
    stdin: ChildStdin,
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

fn validate(s: &Settings) -> Result<(), String> {
    if !s.account_name.is_empty() && !valid_account(&s.account_name) {
        return Err("Account name may only contain letters, numbers and underscores.".into());
    }
    if s.games.contains(&0) {
        return Err("0 is not a valid app ID.".into());
    }
    let has_title = !s.custom_title.trim().is_empty();
    let max = MAX_ENTRIES - usize::from(has_title);
    if s.games.len() > max {
        return Err(format!(
            "Steam allows at most {max} games{}.",
            if has_title { " alongside a custom title" } else { "" }
        ));
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

fn token_file(app: &AppHandle, account: &str) -> Result<PathBuf, String> {
    if !valid_account(account) {
        return Err("Enter a valid account name first.".into());
    }
    let name = account.to_lowercase();
    // Must match WINDOWS_RESERVED in booster.js: device names need a prefix.
    let reserved = matches!(name.as_str(), "con" | "prn" | "aux" | "nul")
        || (name.len() == 4
            && (name.starts_with("com") || name.starts_with("lpt"))
            && matches!(name.as_bytes()[3], b'1'..=b'9'));
    let file = if reserved { format!("_{name}.token") } else { format!("{name}.token") };
    Ok(session_dir(app)?.join(file))
}

fn load_settings(app: &AppHandle) -> Settings {
    config_dir(app)
        .ok()
        .and_then(|dir| fs::read_to_string(dir.join("settings.json")).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
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

fn booster_config(s: &Settings) -> Value {
    json!({
        "accountName": s.account_name,
        "games": s.games,
        "customTitle": s.custom_title.trim(),
        "invisible": s.invisible,
        "force": s.force,
    })
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
    if !valid_account(&s.account_name) {
        return Err("Enter your Steam account name first.".into());
    }

    // The booster reads its settings from a config file, so nothing has to be escaped on the command line.
    let script = booster_script(app)?;
    let cfg_path = config_dir(app)?.join("booster-config.json");
    fs::write(&cfg_path, booster_config(s).to_string())
        .map_err(|e| format!("Could not write the booster config: {e}"))?;

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
            Err(e) => return Err(format!("Could not start the booster: {e}")),
        }
    }
    let mut child = spawned
        .ok_or_else(|| "Node.js was not found. Install it from nodejs.org, then restart the app.".to_string())?;
    let (Some(mut stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
        let _ = child.kill();
        return Err("Could not connect to the booster process.".into());
    };
    if boost {
        // Queued until the login finishes.
        let _ = writeln!(stdin, "{}", json!({ "type": "boost", "on": true })).and_then(|_| stdin.flush());
    }

    let run = state.next_run.fetch_add(1, Ordering::SeqCst) + 1;
    *running = Some(Running { run, child, stdin });
    drop(running);
    // A queued boost is about to be processed; reflect it in the tray right away.
    state.boosting.store(boost, Ordering::SeqCst);

    refresh_tray(app, "connecting");
    let _ = app.emit("booster-started", json!({ "boost": boost, "run": run }));

    let handle = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
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
    let code = loop {
        match running.child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = running.child.kill();
                break running.child.wait().ok().and_then(|status| status.code());
            }
        }
    };
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
    let run = match send_to_booster(app, &json!({ "type": "stop" })) {
        Ok(run) => run,
        Err(_) => {
            if let Some(r) = app.state::<AppState>().running.lock().unwrap().as_mut() {
                let _ = r.child.kill();
            }
            return;
        }
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
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    load_settings(&app)
}

/// Saves the settings and, while logged in, applies them right away.
#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let s = {
        let state = app.state::<AppState>();
        let _guard = state.settings_lock.lock().unwrap();
        let mut s = settings;
        s.resume_boost = load_settings(&app).resume_boost; // owned by the booster's state, not the form
        store_settings(&app, &s)?;
        s
    };
    if app.state::<AppState>().running.lock().unwrap().is_some() {
        let mut message = booster_config(&s);
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
        let mut s = settings;
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
    let connected = state.running.lock().unwrap().is_some();
    ConnectionState { connected, boosting: connected && state.boosting.load(Ordering::SeqCst) }
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

// ---------- app ----------

fn on_tray_toggle(app: &AppHandle) {
    let state = app.state::<AppState>();
    let connected = state.running.lock().unwrap().is_some();
    let result = if connected {
        set_boosting(app, !state.boosting.load(Ordering::SeqCst))
    } else {
        let s = load_settings(app);
        // Without a saved login the window has to ask for the password.
        if !has_saved_login(app.clone(), s.account_name.clone()) {
            show_window(app);
        }
        connect_booster(app, &s, true)
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
            forget_login
        ])
        .setup(|app| {
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
