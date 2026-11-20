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
