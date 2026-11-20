# Steam Hour Booster

A small CLI that logs into Steam and idles one or more games to add playtime, optionally showing a custom "in game" title. One dependency (`steam-user`), no Steam client needed.

## Setup

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

## Usage

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
| `-f, --force` | Kick another session that is playing on this account (otherwise it waits) |
| `--logout` | Delete the saved session for the account |

Up to 32 entries can be played at once (31 games if a custom title is set).

## Login

- The first run asks for your password and Steam Guard code (or lets you approve the login in the Steam mobile app). You can also set the `STEAM_PASSWORD` environment variable.
- After that a refresh token is saved in `.session/<account>.token`, so later runs need no password. Treat that file like a password; `--logout` deletes it.
- If you start a game on another device, the booster pauses and resumes once you stop (unless `--force` is set, which takes the session back).

Stop with Ctrl+C.

## Desktop app

`desktop/` holds a small Tauri app with a window and a tray icon. It runs `booster.js` in the background, so it needs Node.js installed, plus `npm install` in the project root.

- **Sign in** on the login page with your account name, password and Steam Guard code (or approve it in the Steam mobile app). After that the app signs in by itself on every start. It keeps its own saved login, separate from the CLI's `.session` folder.
- On the main page, add games by app ID or store link, set an optional title, and press **Start boosting**. Changes apply right away, even while boosting. **Pause** keeps you signed in.
- The hourglass streams while boosting and turns over once per boosted hour. If boosting was on when you quit, it resumes on the next start.
- **Minimizing hides the window to the tray.** Click the tray icon to bring it back; right-click it to start or pause boosting, or quit. Closing the window quits the app and logs the booster off. **Sign out** forgets the saved login.

Build it (needs Rust and the Visual Studio C++ Build Tools):

```powershell
cd desktop
npm install
npx tauri dev
```

`npx tauri build` makes an installer in `desktop/src-tauri/target/release/bundle/nsis/`.
