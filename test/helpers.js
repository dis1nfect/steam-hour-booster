'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BOOSTER = path.join(ROOT, 'booster.js');
const REGISTER = path.join(__dirname, 'fake-steam-user', 'register.js');

// Must match booster.js and desktop/src-tauri/src/main.rs.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function tokenName(account) {
  const name = account.toLowerCase();
  return `${WINDOWS_RESERVED.test(name) ? '_' : ''}${name}.token`;
}

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** A structurally valid Steam refresh token. `expired` only changes the exp claim. */
function token({ expired = false, iss = 'steam', aud = ['client'] } = {}) {
  const exp = Math.floor(Date.now() / 1000) + (expired ? -3600 : 3600);
  return `${base64url({ alg: 'EdDSA', typ: 'JWT' })}.${base64url({ iss, aud, exp })}.sig`;
}

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shb-test-'));
}

/**
 * Spawn `booster.js` against the fake steam-user in an isolated temp directory.
 * IPC tests get `--ipc --idle -c <cfg>`; CLI tests pass `cli: true` and their own args.
 */
function start(t, options = {}) {
  const {
    scenario = 'basic',
    config = {},
    args = [],
    cli = false,
    account = config.accountName,
    tokenText,
    env = {},
    timeout = 10000,
  } = options;

  const dir = makeDir();
  const session = path.join(dir, 'session');
  fs.mkdirSync(session, { recursive: true });
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(config));
  if (tokenText) {
    if (!account) throw new Error('tokenText requires an account');
    fs.writeFileSync(path.join(session, tokenName(account)), tokenText);
  }

  const fakeLog = path.join(dir, 'fake.log');
  const fullArgs = cli
    ? ['-c', cfgPath, ...args]
    : ['--ipc', '--idle', '-c', cfgPath, ...args];

  const child = spawn(process.execPath, ['--require', REGISTER, BOOSTER, ...fullArgs], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_OPTIONS: '', // keep a developer's --inspect/--require flags out of the child
      BOOSTER_DATA_DIR: session,
      FAKE_LOG: fakeLog,
      FAKE_SCENARIO: scenario,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const events = [];
  const stdout = [];
  const stderr = [];
  let pending = [];
  let buffered = '';
  let exited = false;
  let exitCode = null;
  let spawnError = null;

  child.stdin.on('error', () => { /* the child may exit before we write */ });
  child.on('error', (err) => { spawnError = err; });

  const deliver = (event) => {
    events.push(event);
    pending = pending.filter((waiter) => {
      if (!waiter.predicate(event)) return true;
      clearTimeout(waiter.timer);
      waiter.resolve(event);
      return false;
    });
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    let index;
    while ((index = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, index).replace(/\r$/, '');
      buffered = buffered.slice(index + 1);
      if (!line.trim()) continue;
      stdout.push(line);
      try {
        deliver(JSON.parse(line));
      } catch {
        deliver({ type: 'raw', line });
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));

  child.on('exit', (code, signal) => {
    exited = true;
    exitCode = code;
    if (buffered.trim()) {
      stdout.push(buffered.replace(/\r$/, ''));
      buffered = '';
    }
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      const detail = spawnError ? `spawn error: ${spawnError.message}; ` : '';
      waiter.reject(new Error(`${detail}booster exited (code=${code}, signal=${signal}) while waiting; stderr=${stderr.join('')}`));
    }
    pending = [];
  });

  const waitFor = (predicate, ms = timeout) => {
    const found = events.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out after ${ms}ms; stdout=${JSON.stringify(stdout)}; stderr=${JSON.stringify(stderr.join(''))}`));
      }, ms);
      pending.push({ predicate, resolve, reject, timer });
    });
  };

  const waitForExit = (ms = timeout) => {
    if (exited) return Promise.resolve(exitCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`booster did not exit within ${ms}ms`)), ms);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  };

  const waitForCondition = async (predicate, ms = timeout) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = predicate();
      if (value) return value;
      if (Date.now() >= deadline) throw new Error(`condition timed out after ${ms}ms; stdout=${JSON.stringify(stdout)}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const send = (message) => {
    if (exited) throw new Error('booster already exited');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const fakeEvents = () => {
    if (!fs.existsSync(fakeLog)) return [];
    return fs.readFileSync(fakeLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };
  const games = () => fakeEvents().filter((event) => event.kind === 'games');

  const stop = async () => {
    if (!exited) send({ type: 'stop' });
    return waitForExit();
  };

  const terminate = async () => {
    if (!exited) child.kill();
    return waitForExit(3000).catch(() => null);
  };

  const dispose = async () => {
    await terminate();
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch { /* best effort */ }
  };
  t.after(dispose);

  return {
    dir,
    session,
    cfgPath,
    child,
    events,
    stdout,
    stderr,
    waitFor,
    waitForExit,
    waitForCondition,
    send,
    fakeEvents,
    games,
    stop,
    terminate,
    get exited() { return exited; },
    get exitCode() { return exitCode; },
  };
}

module.exports = { ROOT, BOOSTER, REGISTER, start, token, tokenName, makeDir };
