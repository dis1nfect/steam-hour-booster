// Desktop shell for booster.js: a window for settings, a tray icon, and a
// background `node booster.js --ipc` process that does the Steam work.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
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
}

struct Running {
    run: u64,
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
struct AppState {
    running: Mutex<Option<Running>>,
    toggle_item: Mutex<Option<MenuItem<Wry>>>,
    next_run: AtomicU64,
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
    fs::write(config_dir(app)?.join("settings.json"), text).map_err(|e| format!("Could not save settings: {e}"))
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

fn set_toggle_text(app: &AppHandle, running: bool) {
    if let Some(item) = app.state::<AppState>().toggle_item.lock().unwrap().as_ref() {
        let _ = item.set_text(if running { "Stop boosting" } else { "Start boosting" });
    }
}

fn set_tooltip(app: &AppHandle, state: &str) {
    let label = match state {
        "boosting" => "boosting",
        "paused" => "paused (playing elsewhere)",
        "connecting" => "connecting...",
        _ => "stopped",
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

fn start_booster(app: &AppHandle, s: Settings) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut running = state.running.lock().unwrap();
    if running.is_some() {
        return Err("The booster is already running.".into());
    }
    validate(&s)?;
    if !valid_account(&s.account_name) {
        return Err("Enter your Steam account name first.".into());
    }
    if s.games.is_empty() && s.custom_title.trim().is_empty() {
        return Err("Add at least one game or a custom title.".into());
    }

    // The booster reads its settings from a config file, so nothing has to be escaped on the command line.
    let script = booster_script(app)?;
    let cfg_path = config_dir(app)?.join("booster-config.json");
    let cfg = json!({
        "accountName": s.account_name,
        "games": s.games,
        "customTitle": s.custom_title.trim(),
        "invisible": s.invisible,
        "force": s.force,
    });
    fs::write(&cfg_path, cfg.to_string()).map_err(|e| format!("Could not write the booster config: {e}"))?;

    let mut cmd = Command::new("node");
    cmd.arg(&script)
        .arg("--ipc")
        .arg("-c")
        .arg(&cfg_path)
        .env("BOOSTER_DATA_DIR", session_dir(app)?)
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

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "Node.js was not found. Install it from nodejs.org, then restart the app.".to_string()
        } else {
            format!("Could not start the booster: {e}")
        }
    })?;
    let (Some(stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
        let _ = child.kill();
        return Err("Could not connect to the booster process.".into());
    };

    let run = state.next_run.fetch_add(1, Ordering::SeqCst) + 1;
    *running = Some(Running { run, child, stdin });
    drop(running);

    set_toggle_text(app, true);
    set_tooltip(app, "connecting");
    let _ = app.emit("booster-started", ());

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
        let mut last_state = String::new();
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let event: Value = serde_json::from_str(&line)
                .unwrap_or_else(|_| json!({ "type": "log", "level": "info", "msg": line }));
            if event["type"] == "status" {
                let state = event["state"].as_str().unwrap_or_default();
                if state != last_state {
                    set_tooltip(&handle, state);
                    last_state = state.to_string();
                }
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
    let code = finished.and_then(|mut r| r.child.wait().ok()).and_then(|status| status.code());
    set_toggle_text(app, false);
    set_tooltip(app, "stopped");
    let _ = app.emit("booster-exit", json!({ "code": code }));
}

fn send_to_booster(app: &AppHandle, message: &Value) -> Result<u64, String> {
    let state = app.state::<AppState>();
    let mut running = state.running.lock().unwrap();
    let r = running.as_mut().ok_or("The booster is not running.")?;
    writeln!(r.stdin, "{message}")
        .and_then(|_| r.stdin.flush())
        .map_err(|e| format!("Could not reach the booster: {e}"))?;
    Ok(r.run)
}

/// Ask the booster to log off; kill it if it hasn't exited after a few seconds.
fn request_stop(app: &AppHandle) {
    let run = match send_to_booster(app, &json!({ "type": "stop" })) {
        Ok(run) => run,
        Err(_) => match app.state::<AppState>().running.lock().unwrap().as_mut() {
            Some(r) => {
                let _ = r.child.kill();
                return;
            }
            None => return,
        },
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

// ---------- commands for the window ----------

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    load_settings(&app)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    store_settings(&app, &settings)
}

#[tauri::command]
fn start_boost(app: AppHandle, settings: Settings) -> Result<(), String> {
    store_settings(&app, &settings)?;
    start_booster(&app, settings)
}

#[tauri::command]
fn stop_boost(app: AppHandle) {
    request_stop(&app);
}

#[tauri::command]
fn is_running(app: AppHandle) -> bool {
    app.state::<AppState>().running.lock().unwrap().is_some()
}

#[tauri::command]
fn answer_prompt(app: AppHandle, id: u64, value: String) -> Result<(), String> {
    send_to_booster(&app, &json!({ "type": "answer", "id": id, "value": value })).map(|_| ())
}

#[tauri::command]
fn forget_login(app: AppHandle, account: String) -> Result<bool, String> {
    if !valid_account(&account) {
        return Err("Enter a valid account name first.".into());
    }
    let file = session_dir(&app)?.join(format!("{}.token", account.to_lowercase()));
    match fs::remove_file(&file) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("Could not delete the saved login: {e}")),
    }
}

// ---------- app ----------

fn main() {
    let app = tauri::Builder::default()
        // A second launch just brings the running app to the front (two boosters would fight over the account).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_window(app)))
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            start_boost,
            stop_boost,
            is_running,
            answer_prompt,
            forget_login
        ])
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Show window", true, None::<&str>)?;
            let toggle = MenuItem::with_id(app, "toggle", "Start boosting", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &toggle, &quit])?;
            *app.state::<AppState>().toggle_item.lock().unwrap() = Some(toggle);

            let mut tray = TrayIconBuilder::with_id(TRAY_ID)
                .tooltip("Steam Hour Booster - stopped")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_window(app),
                    "toggle" => {
                        if app.state::<AppState>().running.lock().unwrap().is_some() {
                            request_stop(app);
                        } else if let Err(e) = start_booster(app, load_settings(app)) {
                            show_window(app);
                            report_error(app, &e);
                        }
                    }
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
