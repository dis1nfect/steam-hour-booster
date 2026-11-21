'use strict';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const appWindow = window.__TAURI__.window.getCurrentWindow();

const HOUR = 3600000;
const MAX_ENTRIES = 32;
const LOG_LIMIT = 200;
const STEPS = ['account', 'password', 'guard', 'wait'];
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ui = {
  glassHost: $('hourglass'),
  wordmark: document.querySelector('.wordmark'), splashLine: document.querySelector('.splash-line'),
  loginCard: $('login-card'), loginAccount: $('login-account'), loginPassword: $('login-password'),
  loginError: $('login-error'), waitText: $('wait-text'), guardHint: $('guard-hint'), guardHintText: $('guard-hint-text'),
  guardBoxes: [...document.querySelectorAll('.guard-boxes input')],
  state: $('state'), stateText: $('state-text'), timer: $('timer'), turns: $('turns'), turnsWord: $('turns-word'),
  boost: $('boost'), boostLabel: $('boost-label'),
  addForm: $('add-form'), addGame: $('add-game'), games: $('games'), gamesEmpty: $('games-empty'), gameCount: $('game-count'),
  title: $('title'), titlePreview: $('title-preview'), titlePreviewText: $('title-preview-text'),
  invisible: $('invisible'), force: $('force'), log: $('log'),
  avatar: $('avatar'), persona: $('persona'), accountName: $('account-name'), signout: $('signout'), toast: $('toast'),
  accountsToggle: $('accounts-toggle'), accountsPanel: $('accounts-panel'), accountsList: $('accounts-list'),
  accountsEmpty: $('accounts-empty'), addAccount: $('add-account'), closeAccounts: $('close-accounts'), openLogs: $('open-logs'),
};

let settings = { accounts: {}, activeAccount: '', resumeBoost: false };
let accountList = []; // [{ name, hasToken }] from the Rust side
let view = 'splash';
let connected = false;
let boosting = false;
let status = 'offline';
let promptId = null;
let lastWarn = '';
let lastError = '';
let leaving = false;     // the user asked to stop (sign out / switch), so no error on exit
let signingOut = false;
let pendingSwitch = null; // account to connect after the old booster exits
let pendingAdd = false;   // show the login view after the old booster exits
let turnsShown = 0;
let splashCancelled = false;
let deferredForget = null; // account token to delete after the booster has exited
let currentRun = null;    // identifies the booster process, so a stale exit can't reset a newer run

const EMPTY_ACCOUNT = () => ({ games: [], customTitle: '', invisible: false, force: false });

function normalizeSettings(saved) {
  const accounts = {};
  const source = saved?.accounts && typeof saved.accounts === 'object' && !Array.isArray(saved.accounts)
    ? saved.accounts
    : {};
  for (const [name, raw] of Object.entries(source)) {
    const a = raw && typeof raw === 'object' ? raw : {};
    accounts[name] = {
      games: Array.isArray(a.games) ? a.games.filter((id) => Number.isInteger(id)) : [],
      customTitle: typeof a.customTitle === 'string' ? a.customTitle : '',
      invisible: Boolean(a.invisible),
      force: Boolean(a.force),
    };
  }
  const names = Object.keys(accounts);
  let activeAccount = typeof saved?.activeAccount === 'string' ? saved.activeAccount : '';
  if (!activeAccount) activeAccount = names[0] ?? '';
  if (activeAccount && !accounts[activeAccount]) accounts[activeAccount] = EMPTY_ACCOUNT();
  return { accounts, activeAccount, resumeBoost: Boolean(saved?.resumeBoost) };
}

function ensureAccount(name) {
  if (!name) return EMPTY_ACCOUNT();
  if (!settings.accounts[name]) settings.accounts[name] = EMPTY_ACCOUNT();
  return settings.accounts[name];
}

const currentAccount = () => settings.accounts[settings.activeAccount] ?? EMPTY_ACCOUNT();

let gameNames = {};
try { gameNames = JSON.parse(localStorage.getItem('gameNames') || '{}'); } catch { /* storage unavailable */ }
const rememberNames = () => { try { localStorage.setItem('gameNames', JSON.stringify(gameNames)); } catch { /* ignore */ } };

const glass = new Hourglass($('hourglass-canvas'));
const fx = new Fx($('fx'));

// ---------- views and the travelling hourglass ----------

function placeGlass(instant = false) {
  const slot = document.querySelector(`#view-${view} .slot`);
  const r = slot.getBoundingClientRect();
  const host = ui.glassHost;
  if (instant) host.classList.add('no-move');
  Object.assign(host.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  if (instant) { void host.offsetWidth; host.classList.remove('no-move'); }
}
addEventListener('resize', () => placeGlass(true));

function setView(name) {
  view = name;
  document.body.dataset.view = name;
  fx.setAmbient(name === 'login' && !reduceMotion);
  placeGlass();
  renderState();
}

function setStep(step, waitText) {
  const index = STEPS.indexOf(step);
  ui.loginCard.querySelectorAll('.step').forEach((el) => el.classList.toggle('past', STEPS.indexOf(el.dataset.step) < index));
  ui.loginCard.dataset.step = step;
  if (waitText) ui.waitText.textContent = waitText;
  glass.setFlowing(step === 'wait');
  setTimeout(() => {
    const first = ui.loginCard.querySelector(`.step[data-step="${step}"] input`);
    if (first && view === 'login') first.focus();
  }, 380);
}

function loginError(msg, shake = true) {
  ui.loginError.textContent = msg || '';
  if (msg && shake && !reduceMotion) {
    ui.loginCard.classList.remove('shake');
    void ui.loginCard.offsetWidth;
    ui.loginCard.classList.add('shake');
  }
}

function toast(msg) {
  ui.toast.textContent = msg;
  ui.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { ui.toast.hidden = true; }, 4500);
}

// ---------- startup animation ----------

async function playSplash() {
  for (const word of ui.wordmark.querySelectorAll(':scope > span')) {
    const text = word.textContent;
    word.textContent = '';
    for (const c of text) {
      const ch = document.createElement('span');
      ch.className = 'ch';
      ch.textContent = c;
      word.append(ch);
    }
  }
  const chars = [...ui.wordmark.querySelectorAll('.ch')];
  placeGlass(true);

  if (reduceMotion) {
    chars.forEach((c) => c.classList.add('in'));
    ui.splashLine.classList.add('in');
    return sleep(400);
  }
  if (splashCancelled) return;
  glass.setProgress(1, true);            // starts with all the sand at the bottom...
  await glass.animateReveal(750);
  if (splashCancelled) { glass.setFlowing(false); return; }
  await glass.flip(ui.glassHost, 950);   // ...and is turned over, which starts the clock
  if (splashCancelled) { glass.setFlowing(false); return; }
  glass.setFlowing(true);
  chars.forEach((c, i) => setTimeout(() => c.classList.add('in'), i * 55));
  setTimeout(() => ui.splashLine.classList.add('in'), chars.length * 55 + 150);
  await sleep(chars.length * 55 + 1100);
}

// ---------- odometer timer ----------

const odometer = { text: '', strips: [] };

function setTimer(ms) {
  const s = Math.floor(ms / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const text = `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  if (text === odometer.text) return;
  ui.timer.setAttribute('aria-label', text);

  if (text.length !== odometer.text.length) { // first run, or hours grew a digit
    ui.timer.replaceChildren();
    odometer.strips = [];
    for (const c of text) {
      if (c === ':') {
        const colon = document.createElement('span');
        colon.className = 'colon';
        colon.textContent = ':';
        ui.timer.append(colon);
        odometer.strips.push(null);
        continue;
      }
      const digit = document.createElement('span');
      digit.className = 'digit';
      const strip = document.createElement('span');
      strip.className = 'strip snap';
      for (const d of '01234567890') {
        const n = document.createElement('span');
        n.textContent = d;
        strip.append(n);
      }
      strip.addEventListener('transitionend', () => {
        if (strip.dataset.pos !== '10') return; // rolled 9 -> second 0; jump back to the first 0 unseen
        strip.classList.add('snap');
        strip.dataset.pos = '0';
        strip.style.transform = 'translateY(0)';
        void strip.offsetWidth;
        strip.classList.remove('snap');
      });
      digit.append(strip);
      ui.timer.append(digit);
      odometer.strips.push(strip);
    }
    odometer.text = '';
  }

  [...text].forEach((c, i) => {
    const strip = odometer.strips[i];
    if (!strip) return;
    const before = odometer.text[i];
    const pos = before === '9' && c === '0' && !reduceMotion ? 10 : Number(c);
    strip.dataset.pos = String(pos);
    strip.style.transform = `translateY(${-pos * 56}px)`;
    if (!odometer.text) requestAnimationFrame(() => strip.classList.remove('snap'));
  });
  odometer.text = text;
}

// ---------- state ----------

function renderState() {
  const s = connected ? status : 'offline';
  const n = currentAccount().games.length;
  const labels = {
    offline: 'Offline',
    connecting: 'Connecting',
    idle: 'Signed in, ready',
    boosting: `Boosting ${n} game${n === 1 ? '' : 's'}`,
    paused: 'Paused, playing elsewhere',
  };
  ui.state.dataset.state = s;
  ui.stateText.textContent = labels[s] ?? s;
  ui.boost.dataset.on = String(connected && boosting);
  ui.boostLabel.textContent = !connected ? 'Sign in and boost' : boosting ? 'Pause boosting' : 'Start boosting';
  const flowing = s === 'boosting';
  ui.glassHost.classList.toggle('flowing', flowing && view === 'main');
  if (view === 'main') glass.setFlowing(flowing);
}

function onStatus(ev) {
  status = ev.state;
  setTimer(ev.boostedMs);
  const turns = Math.floor(ev.boostedMs / HOUR);
  ui.turns.textContent = turns;
  ui.turnsWord.textContent = turns === 1 ? 'turn' : 'turns';
  if (turns > turnsShown) {
    turnsShown = turns;
    glass.flip(ui.glassHost); // a full hour: turn the glass over
  } else if (!glass.flipping) {
    glass.setProgress((ev.boostedMs % HOUR) / HOUR);
  }
  renderState();
}

// ---------- settings ----------

function readForm() {
  if (!settings.activeAccount) return;
  const account = ensureAccount(settings.activeAccount);
  account.customTitle = ui.title.value;
  account.invisible = ui.invisible.checked;
  account.force = ui.force.checked;
}

function fillForm() {
  const account = currentAccount();
  ui.loginAccount.value = settings.activeAccount;
  ui.title.value = account.customTitle;
  ui.invisible.checked = account.invisible;
  ui.force.checked = account.force;
  ui.accountName.textContent = settings.activeAccount;
  document.querySelectorAll('.acct-echo').forEach((el) => { el.textContent = settings.activeAccount; });
  renderTitlePreview();
  renderGames();
  renderAccounts();
}

let saveTimer = null;
function save() {
  readForm();
  if (!settings.activeAccount) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await invoke('save_settings', { settings }); } catch (e) { toast(String(e)); }
  }, 350);
}

function renderTitlePreview() {
  const t = ui.title.value.trim();
  ui.titlePreview.hidden = !t;
  ui.titlePreviewText.textContent = t;
}

/** Accepts "730", or a store link like https://store.steampowered.com/app/730/Name/ */
function parseAppId(text) {
  const t = text.trim();
  const fromLink = t.match(/\/app\/(\d+)/);
  const digits = fromLink ? fromLink[1] : t;
  if (!/^\d+$/.test(digits)) return null;
  const id = Number(digits);
  return id > 0 && id <= 0xffffffff ? id : null;
}

const maxGames = () => MAX_ENTRIES - (ui.title.value.trim() ? 1 : 0);

function gameArt(id) {
  const art = document.createElement('span');
  art.className = 'art';
  art.textContent = ((gameNames[id] ?? '#') || '#')[0].toUpperCase();
  const urls = [
    `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${id}/capsule_184x69.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/capsule_184x69.jpg`,
  ];
  const img = new Image();
  img.alt = '';
  img.addEventListener('load', () => img.classList.add('ok'));
  img.addEventListener('error', () => { if (urls.length) img.src = urls.shift(); else img.remove(); });
  img.src = urls.shift();
  art.append(img);
  return art;
}

const rows = new Map(); // app ID -> <li>

function renderGames() {
  const games = currentAccount().games;
  for (const [id, li] of rows) if (!games.includes(id)) { li.remove(); rows.delete(id); }
  games.forEach((id, index) => {
    let li = rows.get(id);
    if (!li) {
      li = document.createElement('li');
      const text = document.createElement('span');
      text.className = 'game-text';
      const name = document.createElement('span');
      name.className = 'game-name';
      const idEl = document.createElement('span');
      idEl.className = 'game-id';
      idEl.textContent = id;
      text.append(name, idEl);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.textContent = '×';
      remove.addEventListener('click', () => removeGame(id));
      li.append(gameArt(id), text, remove);
      rows.set(id, li);
    }
    const name = li.querySelector('.game-name');
    name.textContent = gameNames[id] ?? 'Name appears once signed in';
    name.classList.toggle('pending', !gameNames[id]);
    const label = `Remove ${gameNames[id] ?? id}`;
    li.querySelector('.remove').title = label;
    li.querySelector('.remove').setAttribute('aria-label', label);
    // Keep list order, but only move rows that are out of place: moving a row in the
    // DOM restarts its slide-in animation, and this runs on every title keystroke.
    const here = ui.games.children[index];
    if (here !== li) ui.games.insertBefore(li, here ?? null);
  });
  ui.gameCount.textContent = `${games.length} / ${maxGames()}`;
  ui.gamesEmpty.hidden = games.length > 0;
  renderState();
}

function addGame(e) {
  e.preventDefault();
  if (!settings.activeAccount) return toast('Add an account first.');
  const account = ensureAccount(settings.activeAccount);
  const id = parseAppId(ui.addGame.value);
  if (id === null) return toast('Enter an app ID (a number) or a Steam store link.');
  if (account.games.includes(id)) return toast(`${gameNames[id] ?? id} is already in the list.`);
  if (account.games.length >= maxGames()) return toast(`Steam allows at most ${maxGames()} games at once.`);
  account.games.push(id);
  ui.addGame.value = '';
  renderGames();
  save();
}

function removeGame(id) {
  if (!settings.activeAccount) return;
  const account = ensureAccount(settings.activeAccount);
  const li = rows.get(id);
  account.games = account.games.filter((g) => g !== id);
  save();
  if (!li || reduceMotion) return renderGames();
  li.classList.add('out');
  li.addEventListener('animationend', () => renderGames(), { once: true });
}

function renderAccounts() {
  const saved = accountList.filter((account) => account.hasToken);
  ui.accountsList.replaceChildren();
  for (const { name } of saved) {
    const li = document.createElement('li');
    if (name === settings.activeAccount) li.classList.add('active');

    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'account-pick';
    pick.textContent = name;
    pick.title = `Switch to ${name}`;
    pick.addEventListener('click', () => switchAccount(name));

    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'btn-link account-forget';
    forget.textContent = 'Forget';
    forget.title = `Forget ${name}`;
    forget.addEventListener('click', () => forgetAccount(name));

    li.append(pick, forget);
    ui.accountsList.append(li);
  }
  ui.accountsEmpty.hidden = saved.length > 0;
}

function setAccountsOpen(open) {
  ui.accountsPanel.hidden = !open;
  ui.accountsToggle.setAttribute('aria-expanded', String(open));
  if (open) {
    refreshAccounts();
    ui.accountsPanel.scrollIntoView({ block: 'nearest' });
  }
}

async function refreshAccounts() {
  try {
    const list = await invoke('list_accounts');
    accountList = Array.isArray(list) ? list : [];
    renderAccounts();
  } catch { /* the list is cosmetic */ }
}

async function refreshSettings() {
  const [saved, list] = await Promise.all([invoke('get_settings'), invoke('list_accounts')]);
  settings = normalizeSettings(saved);
  accountList = Array.isArray(list) ? list : [];
  fillForm();
}

/** Stop the current boost via the booster event path, so resumeBoost is cleared. */
async function stopBoostIfNeeded() {
  if (connected && boosting) {
    try { await invoke('set_boost', { on: false }); } catch { /* the stop that follows is still safe */ }
  }
}

async function switchAccount(name) {
  if (!name || signingOut || pendingSwitch || pendingAdd) return;
  if (name === settings.activeAccount && connected) { setAccountsOpen(false); return; }

  const previous = settings.activeAccount;
  // Capture edits for the old account before changing the active one.
  readForm();
  try { await invoke('save_settings', { settings }); } catch (e) { toast(String(e)); return; }

  settings.activeAccount = name;
  ensureAccount(name);
  fillForm();
  try { await invoke('save_settings', { settings }); } catch (e) {
    settings.activeAccount = previous;
    ensureAccount(previous);
    fillForm();
    toast(String(e));
    return;
  }
  setAccountsOpen(false);
  ui.persona.textContent = 'Not signed in';
  ui.avatar.textContent = '?';

  if (connected) {
    // A switch must not leave the previous account boosting (or resume it next start).
    await stopBoostIfNeeded();
    leaving = true;
    pendingSwitch = name;
    invoke('disconnect');
    return;
  }
  setView('main');
  connect(false);
}

function showLoginForNewAccount() {
  ui.loginAccount.value = '';
  ui.persona.textContent = 'Not signed in';
  ui.avatar.textContent = '?';
  setView('login');
  setStep('account');
}

async function beginAddAccount() {
  if (signingOut || pendingSwitch || pendingAdd) return;
  setAccountsOpen(false);
  promptId = null;
  loginError('', false);
  // Keep the current account's edits before the booster goes away.
  readForm();
  try { await invoke('save_settings', { settings }); } catch (e) { toast(String(e)); return; }
  if (connected) {
    // Stop the old account's boost before logging in another account.
    await stopBoostIfNeeded();
    leaving = true;
    pendingAdd = true;
    invoke('disconnect');
    return;
  }
  showLoginForNewAccount();
}

async function forgetAccount(name) {
  if (!name || signingOut || pendingSwitch || pendingAdd) return;
  // Keep the current account's edits; refreshSettings below reloads from disk.
  readForm();
  try { await invoke('save_settings', { settings }); } catch (e) { toast(String(e)); return; }
  if (name === settings.activeAccount && connected) {
    await stopBoostIfNeeded();
    signingOut = true;
    leaving = true;
    deferredForget = name;
    invoke('disconnect');
    return;
  }
  const wasActive = name === settings.activeAccount;
  try {
    await invoke('forget_account', { account: name });
    await refreshSettings();
  } catch (e) {
    toast(String(e));
    return;
  }
  if (wasActive) {
    setView('login');
    setStep('account');
    ui.loginAccount.value = '';
  }
}

// ---------- login ----------

async function connect(boost) {
  readForm();
  lastError = '';
  lastWarn = '';
  try {
    await invoke('connect', { settings, boost });
  } catch (e) {
    if (view === 'login') { setStep('account'); loginError(String(e)); } else toast(String(e));
  }
}

ui.loginCard.querySelector('.step[data-step="account"]').addEventListener('submit', (e) => {
  e.preventDefault();
  const account = ui.loginAccount.value.trim();
  if (!/^\w+$/.test(account)) return loginError('Account names only use letters, numbers and underscores.');
  loginError('');
  // Steam account names are case-insensitive; reuse an existing entry's spelling.
  const existing = Object.keys(settings.accounts).find((name) => name.toLowerCase() === account.toLowerCase());
  const canonical = existing || account;
  settings.activeAccount = canonical;
  ensureAccount(canonical);
  fillForm();
  if (promptId !== null) { // the booster asked for a username before it could start
    save();
    answer(canonical, 'Connecting to Steam');
    return;
  }
  setStep('wait', 'Connecting to Steam');
  connect(false);
});

async function answer(value, waitText) {
  if (promptId === null) return;
  const id = promptId;
  promptId = null;
  loginError('', false);
  setStep('wait', waitText);
  try { await invoke('answer_prompt', { id, value }); } catch (e) { loginError(String(e)); }
}

ui.loginCard.querySelector('.step[data-step="password"]').addEventListener('submit', (e) => {
  e.preventDefault();
  const pw = ui.loginPassword.value;
  if (!pw) return loginError('Enter your password.');
  ui.loginPassword.value = '';
  answer(pw, 'Signing in');
});

function submitGuard() {
  const code = ui.guardBoxes.map((b) => b.value).join('');
  if (code.length < 5) return loginError('Enter all 5 characters of the code.');
  answer(code, 'Checking the code');
}
ui.loginCard.querySelector('.step[data-step="guard"]').addEventListener('submit', (e) => { e.preventDefault(); submitGuard(); });

ui.guardBoxes.forEach((box, i) => {
  const clean = (t) => t.toUpperCase().replace(/[^A-Z0-9]/g, '');
  box.addEventListener('input', () => {
    box.value = clean(box.value).slice(-1);
    box.classList.toggle('filled', Boolean(box.value));
    if (box.value && i < 4) ui.guardBoxes[i + 1].focus();
    if (ui.guardBoxes.every((b) => b.value)) submitGuard();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !box.value && i > 0) {
      const prev = ui.guardBoxes[i - 1];
      prev.value = '';
      prev.classList.remove('filled');
      prev.focus();
      e.preventDefault();
    } else if (e.key === 'ArrowLeft' && i > 0) ui.guardBoxes[i - 1].focus();
    else if (e.key === 'ArrowRight' && i < 4) ui.guardBoxes[i + 1].focus();
  });
  box.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = clean(e.clipboardData.getData('text')).slice(0, 5);
    [...text].forEach((c, j) => { ui.guardBoxes[j].value = c; ui.guardBoxes[j].classList.add('filled'); });
    ui.guardBoxes[Math.min(text.length, 4)].focus();
    if (text.length === 5) submitGuard();
  });
});

ui.loginCard.querySelectorAll('.back').forEach((btn) => btn.addEventListener('click', () => {
  leaving = true;
  promptId = null;
  loginError('', false);
  setStep('account');
  invoke('disconnect');
}));

function onPrompt(ev) {
  promptId = ev.id;
  if (view !== 'login') setView('login');
  if (ev.kind === 'username') {
    ui.loginAccount.value = settings.activeAccount || '';
    setStep('account');
  } else if (ev.kind === 'password') {
    setStep('password');
  } else if (ev.kind === 'guard') {
    ui.guardBoxes.forEach((b) => { b.value = ''; b.classList.remove('filled'); });
    const email = /email/i.test(ev.message);
    ui.guardHintText.textContent = email
      ? ev.message.replace(/^Steam Guard code sent to your email/i, 'Check your email').replace(/[()]/g, '')
      : 'Or approve the sign-in in the Steam mobile app.';
    ui.guardHint.querySelector('.phone').hidden = email;
    setStep('guard');
  }
  if (lastWarn) { loginError(lastWarn); lastWarn = ''; }
}

async function finishLogin() {
  if (view !== 'login') return;
  loginError('', false);
  const r = ui.glassHost.getBoundingClientRect();
  glass.setFlowing(true);
  await fx.dissolve(ui.loginCard, { x: r.left + r.width / 2, y: r.top + r.height * 0.3 });
  setView('main');
  refreshAccounts();
  setTimeout(refreshAccounts, 1500); // a first-time refresh token can be saved just after loggedOn
  setTimeout(() => {
    ui.loginCard.getAnimations().forEach((a) => a.cancel());
    setStep('account');
  }, 900);
}

// ---------- events from the booster ----------

listen('booster', ({ payload: ev }) => {
  switch (ev.type) {
    case 'log':
      addLog(ev.msg, ev.level);
      if (ev.level === 'warn') lastWarn = ev.msg;
      break;
    case 'error':
      addLog(ev.msg, 'error');
      lastError = ev.msg;
      if (!connected) { // e.g. a tray start that could not begin
        if (view === 'login') loginError(ev.msg); else toast(ev.msg);
      }
      break;
    case 'prompt':
      onPrompt(ev);
      break;
    case 'promptCancelled':
      if (ev.id === promptId) {
        promptId = null;
        if (view === 'login') setStep('wait', 'Approved, signing in');
      }
      break;
    case 'loggedOn':
      lastWarn = '';
      finishLogin();
      break;
    case 'status':
      onStatus(ev);
      break;
    case 'boosting':
      boosting = ev.on;
      renderState();
      break;
    case 'configError':
      toast(ev.msg);
      break;
    case 'games':
      for (const g of ev.games) if (g.name) gameNames[g.id] = g.name;
      rememberNames();
      renderGames();
      break;
    case 'persona':
      ui.persona.textContent = ev.name;
      ui.avatar.textContent = (ev.name || '?').trim()[0]?.toUpperCase() ?? '?';
      break;
  }
});

listen('booster-started', ({ payload }) => {
  currentRun = payload?.run ?? null;
  connected = true;
  boosting = Boolean(payload?.boost);
  status = 'connecting';
  turnsShown = 0;
  lastError = '';
  lastWarn = '';
  glass.setProgress(0, true);
  setTimer(0);
  renderState();
});

listen('booster-exit', ({ payload }) => {
  if (currentRun !== null && payload?.run !== currentRun) return; // an older process exited
  currentRun = null;
  connected = false;
  boosting = false;
  status = 'offline';
  promptId = null;
  lastWarn = '';
  glass.setFlowing(false);
  const wasLeaving = leaving;
  leaving = false;
  const switching = pendingSwitch;
  const adding = pendingAdd;
  pendingSwitch = null;
  pendingAdd = false;

  if (switching) {
    setView('main');
    addLog(`Switched to ${switching}.`);
    connect(false); // never auto-start boosting on a switch
  } else if (adding) {
    showLoginForNewAccount();
  } else if (signingOut) {
    signingOut = false;
    setView('login');
    setStep('account');
    // Delete the token only after the booster is gone; otherwise it could save
    // a renewed token again during its shutdown.
    if (deferredForget) {
      const account = deferredForget;
      deferredForget = null;
      invoke('forget_account', { account })
        .then(refreshSettings)
        .catch((e) => toast(String(e)));
    }
  } else if (view === 'login') {
    setStep('account');
    if (!wasLeaving && lastError) loginError(lastError);
  } else if (!wasLeaving && lastError) {
    toast(lastError);
  }
  if (!switching && !adding) addLog('Signed out of Steam.');
  renderState();
});

function addLog(msg, level = 'info') {
  const li = document.createElement('li');
  li.className = level;
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString();
  const text = document.createElement('span');
  text.textContent = msg;
  li.append(time, text);
  const atBottom = ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight < 24;
  ui.log.append(li);
  while (ui.log.children.length > LOG_LIMIT) ui.log.firstElementChild.remove();
  if (atBottom) ui.log.scrollTop = ui.log.scrollHeight;
}

// ---------- controls ----------

ui.boost.addEventListener('click', async () => {
  if (!connected) return connect(true);
  const on = !boosting;
  if (on && !currentAccount().games.length && !ui.title.value.trim()) return toast('Add at least one game or a custom title first.');
  boosting = on; // optimistic; the booster confirms with a 'boosting' event
  renderState();
  try { await invoke('set_boost', { on }); } catch (e) { boosting = !on; renderState(); toast(String(e)); }
});

ui.accountsToggle.addEventListener('click', () => setAccountsOpen(ui.accountsPanel.hidden));
ui.closeAccounts.addEventListener('click', () => setAccountsOpen(false));
ui.addAccount.addEventListener('click', beginAddAccount);
ui.openLogs.addEventListener('click', () => invoke('open_logs_folder').catch((e) => toast(String(e))));

ui.addForm.addEventListener('submit', addGame);
ui.title.addEventListener('input', () => {
  // The title takes one of Steam's 32 slots; with a full list, saving would fail.
  if (ui.title.value.trim() && currentAccount().games.length >= MAX_ENTRIES) {
    ui.title.value = '';
    toast(`Remove a game first: Steam allows ${MAX_ENTRIES} entries, and the title uses one.`);
  }
  renderTitlePreview();
  renderGames();
  save();
});
for (const box of [ui.invisible, ui.force]) box.addEventListener('change', save);

ui.signout.addEventListener('click', async () => {
  if (signingOut || pendingSwitch || pendingAdd) return;
  setAccountsOpen(false);
  const account = settings.activeAccount;
  ui.persona.textContent = 'Not signed in';
  ui.avatar.textContent = '?';
  if (connected) {
    await stopBoostIfNeeded();
    signingOut = true;
    leaving = true;
    deferredForget = account || null;
    invoke('disconnect');
    return; // the token is deleted in booster-exit, once the booster can no longer renew it
  }
  setView('login');
  setStep('account');
  try {
    if (account) {
      await invoke('forget_account', { account });
      await refreshSettings();
    }
  } catch (e) { toast(String(e)); }
});

$('win-min').addEventListener('click', () => appWindow.minimize()); // the app hides itself to the tray
$('win-close').addEventListener('click', () => appWindow.close());

// ---------- start ----------

(async () => {
  let skip;
  const skipped = new Promise((resolve) => { skip = resolve; });
  const skipSplash = () => { splashCancelled = true; skip(); };
  $('view-splash').addEventListener('click', skipSplash);
  addEventListener('keydown', skipSplash, { once: true });

  const ready = (async () => {
    const [saved, state, list] = await Promise.all([
      invoke('get_settings'),
      invoke('connection_state'),
      invoke('list_accounts'),
    ]);
    settings = normalizeSettings(saved);
    if (state.connected && state.account) {
      settings.activeAccount = state.account;
      ensureAccount(state.account);
    }
    accountList = Array.isArray(list) ? list : [];
    // Tokens can outlive settings.json; adopt one so those accounts aren't lost.
    if (!settings.activeAccount) {
      const savedAccount = accountList.find((account) => account.hasToken);
      if (savedAccount) {
        settings.activeAccount = savedAccount.name;
        ensureAccount(savedAccount.name);
      }
    }
    fillForm();
    const hasLogin = settings.activeAccount ? await invoke('has_saved_login', { account: settings.activeAccount }) : false;
    return { state, hasLogin };
  })();

  await Promise.race([playSplash(), skipped]);
  const { state, hasLogin } = await ready;
  glass.setFlowing(false);

  if (state.connected) {
    connected = true;
    boosting = state.boosting;
    setView('main');
  } else if (hasLogin) {
    setView('main');
    const account = currentAccount();
    connect(settings.resumeBoost && (account.games.length > 0 || Boolean(account.customTitle.trim())));
  } else if (settings.activeAccount) {
    setView('login');
    setStep('account');
    ui.loginAccount.value = settings.activeAccount;
  } else {
    setView('login');
    setStep('account');
  }
})();
