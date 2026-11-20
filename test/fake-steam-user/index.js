'use strict';
// Minimal stand-in for steam-user, used only by the committed test suite.
// It is injected into the booster child process by register.js; node_modules is
// never modified. Behaviour is selected with FAKE_SCENARIO and results are
// appended as JSON lines to FAKE_LOG.
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const repoRoot = path.resolve(__dirname, '..', '..');
const EResult = require(path.join(repoRoot, 'node_modules', 'steam-user', 'enums', 'EResult.js'));
const EPersonaState = require(path.join(repoRoot, 'node_modules', 'steam-user', 'enums', 'EPersonaState.js'));

const scenario = process.env.FAKE_SCENARIO || 'basic';
const logFile = process.env.FAKE_LOG;

function record(kind, data = {}) {
  if (!logFile) return;
  fs.appendFileSync(logFile, `${JSON.stringify({ kind, ...data })}\n`);
}

function resultError(eresult) {
  const err = new Error(EResult[eresult] || String(eresult));
  err.eresult = eresult;
  return err;
}

class FakeSteamUser extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.steamID = { getSteamID64: () => '76561198000000000' };
    this.persona = null;
    this.blockedScheduled = false;
  }

  logOn(details = {}) {
    // Never record the password itself, only whether it was altered.
    record('logOn', {
      usedToken: Boolean(details.refreshToken),
      accountName: details.accountName,
      hasPassword: Boolean(details.password),
      passwordHasOuterSpaces: typeof details.password === 'string' && details.password !== details.password.trim(),
    });

    if (scenario === 'rate-limit') {
      setImmediate(() => this.emit('error', resultError(EResult.RateLimitExceeded)));
      return;
    }
    if (scenario === 'token-invalid' && details.refreshToken) {
      setImmediate(() => this.emit('error', resultError(EResult.InvalidPassword)));
      return;
    }
    if (scenario === 'needs-guard' && details.password) {
      setImmediate(() => {
        this.emit('steamGuard', null, (code) => {
          record('guard', { code });
          this.finishLogOn();
        }, false);
      });
      return;
    }
    setImmediate(() => this.finishLogOn());
  }

  finishLogOn() {
    this.emit('loggedOn');
    if (process.env.FAKE_REFRESH_TOKEN) this.emit('refreshToken', process.env.FAKE_REFRESH_TOKEN);
  }

  setPersona(state) {
    this.persona = state;
    record('persona', { state });
  }

  gamesPlayed(apps, force) {
    const list = Array.isArray(apps) ? apps : [apps];
    record('games', { apps: list, force: Boolean(force) });
    if (scenario === 'blocked' && !this.blockedScheduled && list.length) {
      this.blockedScheduled = true;
      setTimeout(() => this.emit('playingState', true, 123456), 50);
      setTimeout(() => this.emit('playingState', false, 0), 2600);
    }
  }

  logOff() {
    record('logOff');
  }

  getProductInfo(ids) {
    const apps = {};
    for (const id of ids) apps[id] = { appinfo: { common: { name: `Game ${id}` } } };
    return Promise.resolve({ apps, packages: {}, unknownApps: [], unknownPackages: [] });
  }
}

FakeSteamUser.EResult = EResult;
FakeSteamUser.EPersonaState = EPersonaState;

module.exports = FakeSteamUser;
