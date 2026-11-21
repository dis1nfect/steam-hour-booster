# Steam Hour Booster

Logs into Steam and idles one or more games to add playtime, optionally showing a custom "In non-Steam game" title. No Steam client needed.

It comes in two versions that share the same Steam logic (`booster.js`, one dependency: `steam-user`):

| | Desktop app | Command line |
| --- | --- | --- |
| For | Everyday use on Windows | Servers, a Raspberry Pi, scripts |
| Install | Installer from [Releases](../../releases) | `npm install` |
| Runs | In the tray, with a window | In a terminal |
| Needs | Node.js 18.3+ | Node.js 18.3+ |

Both can boost up to 32 games at once (31 with a custom title). Both pause while you play on another PC and resume when you stop.

## Desktop app

### Install

1. Install **Node.js 18.3 or newer** from [nodejs.org](https://nodejs.org). The app runs the booster with it.
2. Download `Steam.Hour.Booster_<version>_x64-setup.exe` from the latest [release](../../releases) and run it.
3. Windows SmartScreen may warn about an unknown publisher, because the installer isn't code-signed. Click **More info**, then **Run anyway**.

It installs for your user only (no admin rights needed). Uninstall it from Windows Settings → Apps.

### Use

- **Sign in** with your account name, password and Steam Guard code, or approve the sign-in in the Steam mobile app. After that the app signs in by itself on every start. Your password is only sent to Steam and never stored.
- **Add games** by app ID or by pasting a store link. The app ID is the number in the link: `store.steampowered.com/app/730/`. Each game shows its Steam artwork, and its name once you're signed in.
- **Custom title** (optional): what friends see as "In non-Steam game". It takes one of the 32 slots.
- Press **Start boosting**. Changes to games, title and options apply right away, even while boosting. **Pause boosting** keeps you signed in.
- **Appear invisible to friends** hides you while boosting. **Take over if I start a game on another PC** makes the booster take the account back instead of waiting.
- The hourglass streams sand while boosting and turns over once per boosted hour. If boosting was on when you quit, it resumes on the next start.

### Tray

- **Minimize** hides the window to the tray. Click the tray icon to bring it back.
- **Right-click** the tray icon to start or pause boosting, or to quit.
- **Close** quits the app and signs the booster out of Steam.
- **Sign out** (bottom of the window) forgets the saved login.

Only one copy runs at a time; opening it again brings the existing window to the front.

The app keeps its settings and saved login in your user profile (`%APPDATA%\app.steamhourbooster.desktop`), separate from the command line's `.session` folder.

## Command line

### Setup

```powershell
npm install
```

Optionally copy `config.example.json` to `config.json` and fill it in:

```json
{
  "accountName": "your_steam_username",
  "games": [730, 440, 570],
  "customTitle": "Boosting hours",
  "invisible": false,
  "force": false
}
```

### Usage

```powershell
node booster.js
```

Or without a config file:

```powershell
node booster.js -u your_steam_username -g 730,440,570 -t "Boosting hours"
```

| Option | Description |
| --- | --- |
| `-u, --user` | Steam account name |
| `-g, --games` | Comma-separated app IDs (the number in the store URL, e.g. `730`) |
| `-t, --title` | Custom title shown as your current game |
| `-c, --config` | Use a different config file |
| `--invisible` | Appear invisible to friends |
| `--no-invisible` | Override config `"invisible": true` and appear online |
| `-f, --force` | Kick another session that is playing on this account (otherwise it waits) |
| `--no-force` | Override config `"force": true` and don't take over other sessions |
| `--logout` | Delete the saved session for the account |

Command-line options override the config file. Stop with Ctrl+C.

### Login

- The first run asks for your password and Steam Guard code (or lets you approve the login in the Steam mobile app). You can also set the `STEAM_PASSWORD` environment variable.
- After that a refresh token is saved in `.session/<account>.token`, so later runs need no password. Treat that file like a password; `--logout` deletes it.
- If you start a game on another device, the booster pauses and resumes once you stop (unless `--force` is set, which takes the session back).

## Building the desktop app

Needs Rust and the Visual Studio C++ Build Tools, plus `npm install` in the project root (the installer bundles the root `booster.js` and `node_modules`).

```powershell
cd desktop
npm install
npx tauri dev
```

`npx tauri build` makes the installer in `desktop/src-tauri/target/release/bundle/nsis/`.

`desktop/src/` is the window (plain HTML, CSS and JavaScript, no build step). `desktop/src-tauri/` is the Rust shell that runs `node booster.js --ipc --idle` in the background and talks to it in JSON lines.

## Tests

```powershell
npm test
```

The suite drives the CLI and the `--ipc` protocol against a fake `steam-user` in temporary folders. It needs no Steam account or network access and never touches `.session/`.

## Note

Idling games may go against Steam's Subscriber Agreement, and some games ignore or reset idled hours. Use at your own risk.
