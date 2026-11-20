#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { parseArgs } = require('util');
const SteamUser = require('steam-user');

const { EResult, EPersonaState } = SteamUser;
const MAX_ENTRIES = 32; // Steam's limit on simultaneously "played" entries
const MAX_APP_ID = 0xFFFFFFFF; // Steam app IDs are unsigned 32-bit integers
// --ipc: driven by the desktop app. Output becomes JSON lines on stdout, prompts and
// commands arrive as JSON lines on stdin.
const IPC = process.argv.includes('--ipc');
const SESSION_DIR = process.env.BOOSTER_DATA_DIR
  ? path.resolve(process.env.BOOSTER_DATA_DIR)
  : path.join(__dirname, '.session');
const RETRY_ELSEWHERE_MS = 5 * 60 * 1000;
const RETRY_NETWORK_MS = 30 * 1000;

const HELP = `
Steam Hour Booster

Usage: node booster.js [options]

Options:
  -u, --user <name>      Steam account name
  -g, --games <ids>      Comma-separated app IDs, e.g. 730,440,570
  -t, --title <text>     Custom "in game" title shown on your profile
  -c, --config <file>    Config file (default: ./config.json)
      --invisible        Appear invisible to friends while boosting
  -f, --force            Take over if the account is playing elsewhere
      --logout           Delete the saved login session and exit
      --ipc              JSON mode used by the desktop app
      --idle             With --ipc: log in, but wait for a "boost" command
  -h, --help             Show this help

CLI options override the config file. The password is prompted for
(or read from the STEAM_PASSWORD env var) only when no saved session exists.
`;

// ---------- output ----------

const isTTY = !IPC && process.stdout.isTTY;
// JSON lines are an IPC-only protocol; never pollute normal CLI stdout with them.
const emit = (event) => { if (IPC) process.stdout.write(`${JSON.stringify(event)}\n`); };
const clearLine = () => { if (isTTY) process.stdout.write('\r\x1b[K'); };
const stamp = () => new Date().toLocaleTimeString();
const log = (msg) => {
  if (IPC) return emit({ type: 'log', level: 'info', msg });
  clearLine(); console.log(`[${stamp()}] ${msg}`);
};
const warn = (msg) => {
  if (IPC) return emit({ type: 'log', level: 'warn', msg });
  clearLine(); console.warn(`[${stamp()}] ! ${msg}`);
};
function die(msg) {
  if (IPC) {
    // fs.writeSync, unlike process.stdout.write, cannot be dropped by the
    // process.exit below, so the desktop app always receives the final error.
    try { fs.writeSync(1, `${JSON.stringify({ type: 'error', msg })}\n`); } catch { /* ignore */ }
  } else { clearLine(); console.error(`Error: ${msg}`); }
  process.exit(1);
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

// ---------- prompts ----------

let activePrompt = null;
let promptSeq = 0;
const pendingAnswers = new Map();

// kind tells the desktop app which dialog to show: 'username', 'password' or 'guard'.
function ask(question, hidden = false, kind = 'text') {
  if (IPC) {
    return new Promise((resolve) => {
      if (activePrompt) cancelPrompt(); // a newer question supersedes the old one
      const id = ++promptSeq;
      // Passwords may legitimately contain leading/trailing spaces; other answers are trimmed.
      pendingAnswers.set(id, (value) => resolve(kind === 'password' ? value : value.trim()));
      activePrompt = { id };
      emit({ type: 'prompt', id, kind, hidden, message: question.replace(/:\s*$/, '') });
    });
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      // Only use terminal mode for a real TTY; forcing it on piped input can
      // garble output or leave the stream in a bad state.
      terminal: Boolean(process.stdin.isTTY),
    });
    activePrompt = rl;

    let muted = false;
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      if (activePrompt === rl) activePrompt = null;
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(kind === 'password' ? answer : answer.trim());
    };

    rl._writeToOutput = (s) => { if (!muted) rl.output.write(s); };
    rl.on('SIGINT', () => {
      rl.cancelled = true;
      rl.close();
      shutdown();
    });
    // Input can end before an answer arrives (Ctrl+D, a closed pipe, ...).
    // Canceled prompts are handled by cancelPrompt() and must stay silent.
    rl.on('close', () => {
      if (!settled && !rl.cancelled) die('No input available.');
    });
    rl.question(question, finish);
    muted = hidden; // prompt text is already written; hide what the user types
  });
}

function cancelPrompt() {
  if (!activePrompt) return;
  if (IPC) {
    pendingAnswers.delete(activePrompt.id);
    emit({ type: 'promptCancelled', id: activePrompt.id });
    activePrompt = null;
    return;
  }
  activePrompt.cancelled = true;
  activePrompt.close();
  activePrompt = null;
  process.stdout.write('\n');
}

// ---------- config ----------

function parseCli() {
  try {
    return parseArgs({
      options: {
        user: { type: 'string', short: 'u' },
        games: { type: 'string', short: 'g' },
        title: { type: 'string', short: 't' },
        config: { type: 'string', short: 'c' },
        invisible: { type: 'boolean' },
        force: { type: 'boolean', short: 'f' },
        logout: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        ipc: { type: 'boolean' },
        idle: { type: 'boolean' },
      },
    }).values;
  } catch (e) {
    die(`${e.message}\nRun with --help for usage.`);
  }
}

function loadConfig(file, explicit) {
  if (!fs.existsSync(file)) {
    if (explicit) die(`Config file not found: ${file}`);
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    die(`Could not read ${file}: ${e.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    die(`Could not read ${file}: expected a JSON object.`);
  }
  return parsed;
}

function configBool(cliValue, cfgValue, name) {
  if (typeof cliValue === 'boolean') return cliValue;
  if (cfgValue === undefined) return false;
  if (typeof cfgValue !== 'boolean') die(`"${name}" in the config must be true or false.`);
  return cfgValue;
}

function configString(cfgValue, name) {
  if (cfgValue === undefined || cfgValue === null) return '';
  if (typeof cfgValue !== 'string') die(`"${name}" in the config must be a string.`);
  return cfgValue;
}

// IPC commands come from the desktop app. Bad values must reject the command,
// not terminate the booster, so these throw instead of calling die().
function commandBool(value, name) {
  if (typeof value !== 'boolean') throw new Error(`"${name}" must be true or false.`);
  return value;
}

function commandString(value, name) {
  if (typeof value !== 'string') throw new Error(`"${name}" must be a string.`);
  return value;
}

function parseGames(input, fail = die) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(',');
  const ids = [];
  for (const entry of raw) {
    const s = String(entry).trim();
    if (!s) continue;
    if (!/^\d+$/.test(s) || Number(s) <= 0) fail(`Invalid app ID: "${s}"`);
    const id = Number(s);
    if (!Number.isSafeInteger(id) || id > MAX_APP_ID) fail(`Invalid app ID: "${s}"`);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

// ---------- saved session (refresh token) ----------

// Windows treats these as device names even with an extension (e.g. "con.token"),
// which would make reading/writing the token hit the console instead of a file.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const tokenPath = (account) => {
  const name = account.toLowerCase();
  return path.join(SESSION_DIR, `${WINDOWS_RESERVED.test(name) ? `_${name}` : name}.token`);
};

// steam-user validates the token asynchronously and terminates the process on a
// structurally bad one, so check that here and fall back to a password login instead.
// The `exp` claim is deliberately not trusted: a wrong local clock must not delete a
// valid session. Steam rejects a genuinely expired token, and the error handler then
// deletes it and prompts for a password.
function isUsableToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const aud = Array.isArray(payload.aud) ? payload.aud : typeof payload.aud === 'string' ? [payload.aud] : [];
    return payload.iss === 'steam' && aud.includes('client');
  } catch {
    return false;
  }
}

function readToken(account) {
  let token;
  try { token = fs.readFileSync(tokenPath(account), 'utf8').trim(); } catch { return null; }
  if (!token) return null;
  if (isUsableToken(token)) return token;
  warn('Saved session is expired or damaged. Please log in again.');
  deleteToken(account);
  return null;
}

function saveToken(account, token) {
  if (typeof token !== 'string' || !token) return;
  const file = tokenPath(account);
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(SESSION_DIR, 0o700); } catch { /* e.g. Windows */ }
    // Write to a temporary file first so a crash can't leave a truncated token.
    fs.writeFileSync(tmp, token, { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* e.g. Windows */ }
  } catch (e) {
    // Never let a failed token write crash the client (this runs in an event handler).
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    warn(`Could not save the login session: ${e.message}`);
  }
}

function deleteToken(account) {
  try {
    fs.rmSync(tokenPath(account), { force: true });
    return true;
  } catch (e) {
    warn(`Could not delete the saved session: ${e.message}`);
    return false;
  }
}

// ---------- desktop app commands (--ipc) ----------

function listenForCommands() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    let cmd;
    try { cmd = JSON.parse(line); } catch { return; }
    if (cmd?.type === 'stop') return shutdown();
    if (cmd?.type === 'answer') {
      if (!pendingAnswers.has(cmd.id)) return;
      const resolve = pendingAnswers.get(cmd.id);
      pendingAnswers.delete(cmd.id);
      if (activePrompt?.id === cmd.id) activePrompt = null;
      return resolve(String(cmd.value ?? ''));
    }
    onCommand(cmd ?? {});
  });
  rl.on('close', () => shutdown()); // the desktop app went away
}

// ---------- main ----------

let shutdown = () => process.exit(0);
let onCommand = () => {}; // 'boost' and 'config' commands, set up in main()

const limitError = (games, title) => {
  const max = MAX_ENTRIES - (title ? 1 : 0);
  return games.length > max
    ? `Steam allows at most ${max} games${title ? ' alongside a custom title' : ''} (got ${games.length}).`
    : null;
};

async function main() {
  const args = parseCli();
  if (args.help) return console.log(HELP);
  if (IPC) listenForCommands();

  const cfg = loadConfig(args.config ?? path.join(__dirname, 'config.json'), args.config !== undefined);
  const account = String(args.user ?? configString(cfg.accountName, 'accountName')).trim() || (await ask('Steam username: ', false, 'username'));
  if (!/^\w+$/.test(account)) die('Account name may only contain letters, numbers and underscores.');

  if (args.logout) {
    if (!deleteToken(account)) die(`Could not remove the saved session for ${account}.`);
    return log(`Saved session for ${account} removed.`);
  }

  // --idle (desktop app only): log in, but wait for a 'boost' command before playing.
  if (args.idle && !IPC) die('--idle is only valid together with --ipc.');
  const idle = IPC && Boolean(args.idle);
  let games = parseGames(args.games ?? cfg.games);
  let title = String(args.title ?? configString(cfg.customTitle, 'customTitle')).trim();
  let invisible = configBool(args.invisible, cfg.invisible, 'invisible');
  let force = configBool(args.force, cfg.force, 'force');

  if (!idle && !games.length && !title) die('No games to boost. Use --games 730,440 or set "games" in config.json.');
  const tooMany = limitError(games, title);
  if (tooMany) die(tooMany);

  // A string entry shows as a non-Steam game, i.e. the custom title. It goes first so it is what friends see.
  const playingList = () => (title ? [title, ...games] : games);

  const client = new SteamUser({ dataDirectory: SESSION_DIR, renewRefreshTokens: true, autoRelogin: true });

  let shuttingDown = false;
  let usedToken = false;
  let loggingIn = false;
  let loggedIn = false;
  let wantBoost = !idle;
  let blocked = false;
  const named = new Set(); // app IDs whose names were already looked up
  let retryTimer = null;
  let boostedMs = 0;
  let activeSince = null;
  let statusTimer = null;

  const startClock = () => { if (activeSince === null) activeSince = Date.now(); };
  const stopClock = () => {
    if (activeSince !== null) boostedMs += Date.now() - activeSince;
    activeSince = null;
  };
  const totalBoosted = () => boostedMs + (activeSince !== null ? Date.now() - activeSince : 0);

  if (IPC) {
    const state = () => (!loggedIn ? 'connecting' : !wantBoost ? 'idle' : blocked ? 'paused' : 'boosting');
    const sendStatus = () => emit({ type: 'status', state: state(), boostedMs: totalBoosted() });
    statusTimer = setInterval(sendStatus, 1000);
    sendStatus();
  } else if (isTTY) {
    statusTimer = setInterval(() => {
      if (activeSince === null) return;
      process.stdout.write(`\r\x1b[KBoosting ${games.length} game(s)${title ? ` as "${title}"` : ''} | ${fmtDuration(totalBoosted())}  (Ctrl+C to stop)`);
    }, 1000);
  } else {
    statusTimer = setInterval(() => { if (activeSince !== null) log(`Boosted for ${fmtDuration(totalBoosted())}`); }, 30 * 60 * 1000);
  }

  async function logOn() {
    if (loggingIn) return;
    loggingIn = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    try {
      const token = readToken(account);
      usedToken = Boolean(token);
      if (token) {
        log(`Logging in as ${account} using saved session...`);
        client.logOn({ refreshToken: token });
      } else {
        const password = process.env.STEAM_PASSWORD || (await ask(`Password for ${account}: `, true, 'password'));
        if (!password) die('Password is required.');
        log(`Logging in as ${account}...`);
        client.logOn({ accountName: account, password });
      }
    } finally {
      loggingIn = false;
    }
  }

  function retryIn(ms) {
    if (retryTimer) return;
    log(`Retrying in ${Math.round(ms / 1000)}s...`);
    retryTimer = setTimeout(() => logOn().catch((e) => die(e.message)), ms);
  }

  function startBoost() {
    if (!wantBoost || !loggedIn || !playingList().length) return;
    client.gamesPlayed(playingList(), force);
    if (!blocked) startClock();
  }

  function setBoost(on) {
    if (on && !playingList().length) {
      emit({ type: 'configError', msg: 'Add at least one game or a custom title first.' });
      if (IPC) emit({ type: 'boosting', on: wantBoost }); // let the app reset its button
      return;
    }
    if (on === wantBoost) return;
    wantBoost = on;
    if (on) {
      if (loggedIn) log(`Boosting ${games.length} game(s)${title ? ` with custom title "${title}"` : ''}`);
      startBoost();
    } else {
      stopClock();
      if (loggedIn) client.gamesPlayed([]);
      log('Boosting paused.');
    }
    if (IPC) emit({ type: 'boosting', on: wantBoost });
  }

  // Looks up names for games not seen before (all of them on the first login).
  async function showGameNames() {
    const ids = games.filter((id) => !named.has(id));
    if (!ids.length || !loggedIn) return;
    ids.forEach((id) => named.add(id));
    try {
      const { apps, unknownApps } = await client.getProductInfo(ids, [], true);
      if (IPC) {
        emit({ type: 'games', games: ids.map((id) => ({ id, name: apps[id]?.appinfo?.common?.name ?? null })) });
      } else for (const id of ids) {
        const name = apps[id]?.appinfo?.common?.name;
        log(`  - ${id}${name ? `: ${name}` : ''}`);
      }
      if (unknownApps?.length) warn(`Unknown app IDs (no hours will be added): ${unknownApps.join(', ')}`);
    } catch {
      ids.forEach((id) => named.delete(id));
      if (!IPC) log(`  Games: ${ids.join(', ')}`);
    }
  }

  // Live changes from the desktop app.
  onCommand = (cmd) => {
    try {
      if (cmd.type === 'boost') return setBoost(cmd.on === undefined ? true : commandBool(cmd.on, 'on'));
      if (cmd.type !== 'config') return;
      const fail = (msg) => { throw new Error(msg); };
      const newGames = cmd.games === undefined ? games : parseGames(cmd.games, fail);
      const newTitle = cmd.customTitle === undefined ? title : commandString(cmd.customTitle, 'customTitle').trim();
      const newForce = cmd.force === undefined ? force : commandBool(cmd.force, 'force');
      const newInvisible = cmd.invisible === undefined ? invisible : commandBool(cmd.invisible, 'invisible');
      const err = limitError(newGames, newTitle);
      if (err) fail(err);
      games = newGames;
      title = newTitle;
      force = newForce;
      if (newInvisible !== invisible) {
        invisible = newInvisible;
        if (loggedIn) client.setPersona(invisible ? EPersonaState.Invisible : EPersonaState.Online);
      }
      if (wantBoost && !playingList().length) setBoost(false); // the last game was removed
      else if (wantBoost) startBoost(); // picks up the new list and restarts the clock if needed
      showGameNames();
    } catch (e) {
      emit({ type: 'configError', msg: e.message });
    }
  };

  client.on('steamGuard', async (domain, callback, lastCodeWrong) => {
    if (lastCodeWrong) warn('That code was wrong, try again.');
    const prompt = domain
      ? `Steam Guard code sent to your email (${domain}): `
      : 'Steam Guard code from your mobile app (or approve the login in the app): ';
    let code = '';
    while (!code) code = await ask(prompt, false, 'guard');
    callback(code);
  });

  client.on('refreshToken', (token) => saveToken(account, token));

  if (IPC) client.on('accountInfo', (name) => emit({ type: 'persona', name }));

  client.on('loggedOn', () => {
    cancelPrompt(); // e.g. login approved in the mobile app while the code prompt was open
    loggedIn = true;
    const steamId = client.steamID.getSteamID64();
    log(`Logged in (SteamID ${steamId})`);
    if (IPC) emit({ type: 'loggedOn', steamId });
    client.setPersona(invisible ? EPersonaState.Invisible : EPersonaState.Online);
    if (wantBoost) {
      startBoost();
      log(`Boosting ${games.length} game(s)${title ? ` with custom title "${title}"` : ''}${IPC ? '' : ':'}`); // the CLI lists the games next
    } else {
      log('Ready. Press Start to boost.');
    }
    showGameNames();
  });

  client.on('playingState', (isBlocked, playingApp) => {
    if (isBlocked === blocked) return; // nothing changed

    blocked = isBlocked;
    if (!wantBoost) return; // not playing anything, so another device playing doesn't matter
    if (isBlocked) {
      stopClock();
      if (force) { // once per episode, so a failed kick can't loop
        // steam-user only kicks once it knows we're blocked, which can arrive after our first gamesPlayed.
        log(`Account is playing elsewhere (app ${playingApp}); taking over (--force).`);
        startBoost(); // the clock starts again once Steam reports us unblocked
      } else {
        warn(`This account is playing on another device (app ${playingApp}). Waiting for it to stop... (--force takes over)`);
      }
      return;
    }

    log('Account is free again, resuming boost.');
    startBoost();
  });

  client.on('disconnected', (eresult, msg) => {
    stopClock();
    loggedIn = false;
    blocked = false; // Steam re-sends the playing state after reconnecting
    if (!shuttingDown) warn(`Disconnected from Steam (${msg || eresult}). Reconnecting...`);
  });

  client.on('error', (err) => {
    stopClock();
    loggedIn = false;
    blocked = false;

    switch (err.eresult) {
      case EResult.LoggedInElsewhere:
      case EResult.LogonSessionReplaced:
        warn('Session was taken over by another login.');
        return retryIn(RETRY_ELSEWHERE_MS);
      case EResult.RateLimitExceeded:
      case EResult.AccountLoginDeniedThrottle:
        return die('Steam is rate-limiting logins from this IP. Wait ~30 minutes and try again.');
      case EResult.NoConnection:
      case EResult.ServiceUnavailable:
      case EResult.TryAnotherCM:
      case EResult.Timeout:
      case EResult.Busy:
      case EResult.ConnectFailed:
      case EResult.HandshakeFailed:
      case EResult.IOFailure:
      case EResult.RemoteDisconnect:
        warn(`Steam unreachable (${err.message}).`);
        return retryIn(RETRY_NETWORK_MS);
      case EResult.Banned:
      case EResult.AccountDisabled:
      case EResult.Suspended:
      case EResult.AccountDeleted:
      case EResult.AccountNotFound:
      case EResult.ParentalControlRestricted:
        return die(`Steam rejected this login: ${err.message}.`);
    }

    if (!usedToken) {
      // Password login: only a wrong password can be fixed by asking again.
      if (err.eresult === EResult.InvalidPassword) {
        // Re-trying a fixed env password would just get the IP rate-limited.
        if (process.env.STEAM_PASSWORD) return die('Wrong username or password (STEAM_PASSWORD).');
        warn('Wrong username or password.');
        return logOn().catch((e) => die(e.message));
      }
      return die(`Steam login failed: ${err.message}`);
    }

    // A saved session was used. Only throw it away when Steam says it is no
    // longer valid; other failures (a CM hiccup, a timeout, ...) must not log
    // the user out.
    const tokenRejected = [
      EResult.InvalidPassword,
      EResult.AccessDenied,
      EResult.Expired,
      EResult.Revoked,
      EResult.InvalidSignature,
      EResult.CachedCredentialInvalid,
    ].includes(err.eresult);

    if (!tokenRejected) {
      warn(`Steam login failed (${err.message}).`);
      return retryIn(RETRY_NETWORK_MS);
    }

    warn(`Saved session no longer valid (${err.message}). Please log in again.`);
    deleteToken(account);
    logOn().catch((e) => die(e.message));
  });

  shutdown = () => {
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    cancelPrompt();
    stopClock();
    clearInterval(statusTimer);
    clearTimeout(retryTimer);
    log(`Stopping. Boosted for ${fmtDuration(boostedMs)} this run.`);
    try {
      client.gamesPlayed([]);
      client.logOff();
    } catch { /* not connected */ }
    if (IPC) emit({ type: 'stopped', boostedMs });
    setTimeout(() => process.exit(0), 1000);
  };

  await logOn();
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
// Last resort for errors thrown inside the Steam library, so they end with a readable message.
process.on('unhandledRejection', (e) => die(e?.message ?? String(e)));

main().catch((e) => die(e.message));
