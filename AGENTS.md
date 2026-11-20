# AGENTS.md

Steam hour booster: a Node CLI (`booster.js`, single dependency `steam-user`) plus a Tauri 2 desktop shell in `desktop/` that drives the CLI as a child process. `npm test` runs a dependency-free `node:test` suite (CLI + IPC against a fake `steam-user`); there is no linter, formatter or CI.

## Layout and wiring
- `booster.js` (root) is the only Steam logic. The desktop app never talks to Steam itself.
- `desktop/src-tauri/src/main.rs` spawns `node booster.js --ipc --idle -c <appConfigDir>/booster-config.json` with `BOOSTER_DATA_DIR=<appDataDir>/session`. It requires `node` on PATH at runtime, including in the installed app.
- `desktop/src/` is a plain static frontend (no bundler/npm deps): `index.html` loads `hourglass.js`, `fx.js`, `main.js` as classic scripts and uses `window.__TAURI__` (`withGlobalTauri: true`). There is no frontend build step or dev server.
- Release bundle copies the root `booster.js` and the **root** `node_modules/` as resources (`tauri.conf.json` -> `bundle.resources`), so run `npm install` in the repo root before `npx tauri build`. In dev, `main.rs` falls back to `CARGO_MANIFEST_DIR/../../booster.js`.

## IPC protocol (keep both sides in sync)
- `--ipc`: booster writes JSON lines on stdout (`log`, `status`, `prompt`, `promptCancelled`, `loggedOn`, `persona`, `games`, `boosting`, `configError`, `error`, `stopped`) and reads JSON lines on stdin (`boost`, `config`, `answer`, `stop`). Closing stdin = shutdown.
- In IPC mode never write plain text to stdout; use `log`/`warn`/`emit`. Non-JSON stdout lines get wrapped as logs by Rust, stderr is shown as warnings.
- IPC command handlers must throw / emit `configError`, not call `die()` (which exits the process). `die()` uses `fs.writeSync` so the final error survives `process.exit`.
- Rules duplicated in Rust and JS that must stay identical: account-name regex `^\w+$` (`valid_account`), 32-entry limit with custom title counting as one (`MAX_ENTRIES`), Windows reserved device-name token filenames (`WINDOWS_RESERVED` / `token_file`, prefixed with `_`).
- Adding a Tauri command: register it in `generate_handler!` in `main.rs`; window permissions live in `desktop/src-tauri/capabilities/default.json`. CSP in `tauri.conf.json` blocks inline scripts/styles and external hosts except the Steam CDN images.

## Commands
- CLI: `npm install` then `node booster.js -u <account> -g 730,440 -t "Title"` (or a `config.json`, see `config.example.json`). `--ipc`/`--idle` are for the desktop app only.
- Desktop (needs Rust + MSVC Build Tools): `cd desktop; npm install; npx tauri dev`. `npx tauri build` produces an NSIS installer only.
- Rust check without launching: `cargo check` in `desktop/src-tauri`.
- Tests: `npm test` (Node >= 18.13 for `t.after`; the booster itself needs >= 18.3 for `util.parseArgs`). The fake lives in `test/fake-steam-user/` and is injected with `--require`; never edit `node_modules`. Each test uses its own `os.tmpdir()` folder, never `.session/`.

## Gotchas
- Real Steam logins are rate-limited per IP (`RateLimitExceeded`); avoid repeated password login attempts while testing. `.session/*.token` and `config.json` are secrets and gitignored; never commit or print them.
- Saved-token handling is deliberate: tokens are not deleted on local `exp` checks or transient errors, only when Steam rejects them. Don't "simplify" this.
- Desktop settings (`settings.json` in the app config dir) are written atomically under `settings_lock`; `resume_boost` is owned by booster events, not the form.
- `tutorial.html` is a standalone user guide, not part of either app.
