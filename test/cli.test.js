'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, token } = require('./helpers');

test('--idle without --ipc exits 1 and prints no JSON', { timeout: 15000 }, async (t) => {
  const b = start(t, {
    cli: true,
    config: {},
    args: ['--idle', '-u', 'testuser', '-g', '730'],
  });

  assert.equal(await b.waitForExit(), 1);
  assert.equal(b.stdout.join('\n').trim(), '', 'the CLI must not print IPC JSON');
  assert.match(b.stderr.join(''), /--idle is only valid together with --ipc/);
});

test('CLI mode never writes JSON lines', { timeout: 20000 }, async (t) => {
  const b = start(t, {
    cli: true,
    config: {},
    args: ['-u', 'testuser', '-g', '730', '-t', 'Title'],
    account: 'testuser',
    tokenText: token(),
  });

  await b.waitForCondition(() => b.stdout.some((line) => /Logged in|Boosting/.test(line)));
  assert.ok(b.stdout.some((line) => /Logged in/.test(line)), 'the CLI should log in');

  for (const line of b.stdout) {
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    assert.ok(!parsed || typeof parsed !== 'object' || !('type' in parsed), `IPC JSON leaked to CLI stdout: ${line}`);
  }

  await b.terminate();
});

test('CLI passwords keep leading/trailing spaces', { timeout: 20000 }, async (t) => {
  const b = start(t, {
    cli: true,
    config: {},
    args: ['-u', 'testuser', '-g', '730'],
  });

  b.child.stdin.write('  secret  \n');
  const login = await b.waitForCondition(() => b.fakeEvents().find((e) => e.kind === 'logOn'));
  assert.equal(login.passwordHasOuterSpaces, true, 'the CLI must not trim the password');

  await b.terminate();
});
