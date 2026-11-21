'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start, token, tokenName } = require('./helpers');

const config = (overrides = {}) => ({
  accountName: 'testuser',
  games: [730],
  customTitle: '',
  invisible: false,
  force: false,
  ...overrides,
});

const sameApps = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);

test('passwords keep leading/trailing spaces; guard codes are trimmed', { timeout: 20000 }, async (t) => {
  const b = start(t, { scenario: 'needs-guard', config: config() });

  const password = await b.waitFor((e) => e.type === 'prompt' && e.kind === 'password');
  b.send({ type: 'answer', id: password.id, value: '  secret  ' });

  const guard = await b.waitFor((e) => e.type === 'prompt' && e.kind === 'guard');
  b.send({ type: 'answer', id: guard.id, value: ' abcde ' });

  await b.waitFor((e) => e.type === 'loggedOn');

  const events = b.fakeEvents();
  const login = events.find((e) => e.kind === 'logOn');
  assert.equal(login.passwordHasOuterSpaces, true, 'the password must reach steam-user unchanged');
  const guardEvent = events.find((e) => e.kind === 'guard');
  assert.equal(guardEvent.code, 'abcde', 'the guard code should be trimmed');

  assert.equal(await b.stop(), 0);
});

test('a non-boolean force in a config command is rejected and not applied', { timeout: 20000 }, async (t) => {
  const b = start(t, { config: config(), tokenText: token() });
  await b.waitFor((e) => e.type === 'loggedOn');

  b.send({ type: 'boost', on: true });
  await b.waitFor((e) => e.type === 'boosting' && e.on === true);

  b.send({ type: 'config', force: 'false' });
  await b.waitFor((e) => e.type === 'configError');

  // A later valid command proves the stored force is still false.
  b.send({ type: 'config', games: [440] });
  await b.waitForCondition(() => b.games().find((g) => sameApps(g.apps, [440]) && g.force === false));

  assert.equal(await b.stop(), 0);
});

test('a config command only changes its own fields; config while boosting uses startBoost; stop exits 0', { timeout: 25000 }, async (t) => {
  const b = start(t, { config: config({ customTitle: 'Title', force: true, invisible: true }), tokenText: token() });
  await b.waitFor((e) => e.type === 'loggedOn');
  await b.waitForCondition(() => b.fakeEvents().some((e) => e.kind === 'persona' && e.state === 7));

  b.send({ type: 'boost', on: true });
  await b.waitFor((e) => e.type === 'boosting' && e.on === true);
  await b.waitForCondition(() => b.games().some((g) => sameApps(g.apps, ['Title', 730]) && g.force === true));

  // No title/force/invisible: all three must be preserved.
  b.send({ type: 'config', games: [570] });
  await b.waitForCondition(() => b.games().some((g) => sameApps(g.apps, ['Title', 570]) && g.force === true));

  const personas = b.fakeEvents().filter((e) => e.kind === 'persona');
  assert.equal(personas.at(-1).state, 7, 'invisible must not change');

  assert.equal(await b.stop(), 0, 'stop should exit cleanly');
});

test('an expired-by-clock token is still tried (clock skew is tolerated)', { timeout: 20000 }, async (t) => {
  const b = start(t, { config: config(), tokenText: token({ expired: true }) });
  await b.waitFor((e) => e.type === 'loggedOn');

  assert.equal(b.fakeEvents().find((e) => e.kind === 'logOn').usedToken, true);
  assert.equal(b.events.some((e) => e.type === 'prompt'), false, 'no password prompt for a token Steam accepts');
  assert.equal(fs.existsSync(path.join(b.session, tokenName('testuser'))), true);

  assert.equal(await b.stop(), 0);
});

test('a token rejected by Steam is deleted and falls back to a password prompt', { timeout: 20000 }, async (t) => {
  const b = start(t, { scenario: 'token-invalid', config: config(), tokenText: token() });

  const password = await b.waitFor((e) => e.type === 'prompt' && e.kind === 'password');
  assert.equal(b.fakeEvents().find((e) => e.kind === 'logOn').usedToken, true);
  assert.equal(fs.existsSync(path.join(b.session, tokenName('testuser'))), false, 'the rejected token should be deleted');

  b.send({ type: 'answer', id: password.id, value: 'pw' });
  await b.waitFor((e) => e.type === 'loggedOn');

  const calls = b.fakeEvents().filter((e) => e.kind === 'logOn');
  assert.equal(calls.at(-1).usedToken, false, 'the retry should use a password');

  assert.equal(await b.stop(), 0);
});

test('a fatal login error is written as a JSON line before exit', { timeout: 20000 }, async (t) => {
  const b = start(t, { scenario: 'rate-limit', config: config(), tokenText: token() });

  const error = await b.waitFor((e) => e.type === 'error');
  assert.match(error.msg, /rate-limiting/);
  assert.equal(await b.waitForExit(), 1);
  assert.ok(b.stdout.some((line) => {
    try { return JSON.parse(line).type === 'error'; } catch { return false; }
  }), 'the JSON error must be on stdout');
});

test('a Windows device-name account uses its prefixed token file', { timeout: 20000 }, async (t) => {
  const b = start(t, {
    config: config({ accountName: 'con', games: [] }),
    account: 'con',
    tokenText: token(),
    env: { FAKE_REFRESH_TOKEN: 'renewed-token' },
  });
  await b.waitFor((e) => e.type === 'loggedOn');

  assert.equal(b.fakeEvents().find((e) => e.kind === 'logOn').usedToken, true);

  const reservedFile = path.join(b.session, '_con.token');
  await b.waitForCondition(() => fs.existsSync(reservedFile));
  await b.waitForCondition(() => {
    try { return fs.readFileSync(reservedFile, 'utf8') === 'renewed-token'; } catch { return false; }
  });

  assert.equal(await b.stop(), 0);
});

test('pauses while another device is playing and resumes when it stops', { timeout: 25000 }, async (t) => {
  const b = start(t, { scenario: 'blocked', config: config({ customTitle: 'T' }), tokenText: token() });
  await b.waitFor((e) => e.type === 'loggedOn');

  b.send({ type: 'boost', on: true });
  await b.waitFor((e) => e.type === 'boosting' && e.on === true);
  await b.waitFor((e) => e.type === 'log' && /playing on another device/.test(e.msg));
  // Without --force nothing may be sent while blocked.
  assert.equal(b.games().length, 1);
  await b.waitFor((e) => e.type === 'status' && e.state === 'paused');

  await b.waitFor((e) => e.type === 'log' && /free again, resuming boost/.test(e.msg));
  await b.waitForCondition(() => b.games().length >= 2);
  assert.equal(b.games().some((g) => g.force === true), false);

  assert.equal(await b.stop(), 0);
});

test('--force takes the session back from another device', { timeout: 25000 }, async (t) => {
  const b = start(t, { scenario: 'blocked', config: config({ customTitle: 'T' }), tokenText: token(), args: ['--force'] });
  await b.waitFor((e) => e.type === 'loggedOn');

  b.send({ type: 'boost', on: true });
  await b.waitFor((e) => e.type === 'boosting' && e.on === true);
  await b.waitFor((e) => e.type === 'log' && /taking over \(--force\)/.test(e.msg));
  await b.waitForCondition(() => b.games().some((g) => g.force === true && sameApps(g.apps, ['T', 730])));

  await b.waitFor((e) => e.type === 'log' && /free again, resuming boost/.test(e.msg));
  await b.waitForCondition(() => b.games().length >= 3);

  assert.equal(await b.stop(), 0);
});

// The desktop app sends `boost` right after spawning (tray start, resumed session),
// usually before the login finishes. The command must not be lost.
test('a boost sent before login starts boosting once logged in', { timeout: 20000 }, async (t) => {
  const b = start(t, { config: config({ customTitle: 'T' }), tokenText: token() });
  b.send({ type: 'boost', on: true });

  await b.waitFor((e) => e.type === 'loggedOn');
  await b.waitForCondition(() => b.games().some((g) => sameApps(g.apps, ['T', 730])));
  await b.waitFor((e) => e.type === 'status' && e.state === 'boosting');

  assert.equal(await b.stop(), 0);
});

test('config commands sent before login are applied after loggedOn', { timeout: 20000 }, async (t) => {
  const b = start(t, { scenario: 'slow-login', config: config(), tokenText: token() });
  b.send({ type: 'boost', on: true });
  b.send({ type: 'config', games: [570], customTitle: 'New' });

  // Both commands are processed while login is still pending; nothing may be played yet.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(b.games().length, 0, 'no gamesPlayed while logged out');

  await b.waitFor((e) => e.type === 'loggedOn');
  await b.waitForCondition(() => b.games().some((g) => sameApps(g.apps, ['New', 570])));
  assert.equal(b.games().some((g) => sameApps(g.apps, [730])), false, 'the old list must not be played');

  assert.equal(await b.stop(), 0);
});

test('config commands sent after a disconnect are applied on the next login', { timeout: 25000 }, async (t) => {
  const b = start(t, { scenario: 'reconnect', config: config(), tokenText: token() });
  await b.waitFor((e) => e.type === 'loggedOn');

  b.send({ type: 'boost', on: true });
  await b.waitFor((e) => e.type === 'boosting' && e.on === true);
  await b.waitForCondition(() => b.games().some((g) => sameApps(g.apps, [730])));

  await b.waitFor((e) => e.type === 'log' && /Disconnected from Steam/.test(e.msg));
  b.send({ type: 'config', games: [570], customTitle: 'New' });

  // The reconnect is still 700+ ms away; the edit must only be stored.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(b.games().length, 1, 'no gamesPlayed while disconnected');

  await b.waitForCondition(() => b.events.filter((e) => e.type === 'loggedOn').length >= 2);
  await b.waitForCondition(() => b.games().some((g) => sameApps(g.apps, ['New', 570])));

  const calls = b.games();
  assert.equal(calls.length, 2);
  assert.equal(sameApps(calls[0].apps, [730]), true);
  assert.equal(sameApps(calls.at(-1).apps, ['New', 570]), true);

  assert.equal(await b.stop(), 0);
});

test('a custom title counts against Steam\'s 32-entry limit', { timeout: 20000 }, async (t) => {
  const games = Array.from({ length: 32 }, (_, index) => 730 + index);
  const b = start(t, { config: config({ games }), tokenText: token() });
  await b.waitFor((e) => e.type === 'loggedOn');

  b.send({ type: 'config', games, customTitle: 'Title' });
  const error = await b.waitFor((e) => e.type === 'configError');
  assert.match(error.msg, /at most 31 games alongside a custom title/);

  assert.equal(await b.stop(), 0);
});
