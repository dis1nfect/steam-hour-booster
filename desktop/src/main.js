'use strict';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const MAX_ENTRIES = 32;
const LOG_LIMIT = 200;
const STATUS_TEXT = { stopped: 'Stopped', connecting: 'Connecting', boosting: 'Boosting', paused: 'Paused: playing elsewhere' };

const $ = (id) => document.getElementById(id);
const el = {
  status: $('status'), persona: $('persona'), timer: $('timer'), toggle: $('toggle'), banner: $('banner'),
  settings: $('settings'), lockedHint: $('locked-hint'),
  account: $('account'), forget: $('forget'),
  addGame: $('add-game'), addBtn: $('add-btn'), games: $('games'), gamesEmpty: $('games-empty'), gameCount: $('game-count'),
  title: $('title'), invisible: $('invisible'), force: $('force'),
  log: $('log'),
  prompt: $('prompt'), promptForm: $('prompt-form'), promptTitle: $('prompt-title'), promptMessage: $('prompt-message'),
  promptInput: $('prompt-input'), promptCancel: $('prompt-cancel'),
};

let settings = { accountName: '', games: [], customTitle: '', invisible: false, force: false };
let running = false;
let promptId = null;

// Game names are only known after Steam answers, so remember them between runs.
let gameNames = {};
try { gameNames = JSON.parse(localStorage.getItem('gameNames') || '{}'); } catch { /* storage unavailable */ }
const rememberNames = () => { try { localStorage.setItem('gameNames', JSON.stringify(gameNames)); } catch { /* ignore */ } };

// ---------- helpers ----------

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function addLog(msg, level = 'info') {
  const li = document.createElement('li');
  li.className = level;
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString();
  const text = document.createElement('span');
  text.textContent = msg;
  li.append(time, text);
  const atBottom = el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 24;
  el.log.append(li);
  while (el.log.children.length > LOG_LIMIT) el.log.firstElementChild.remove();
  if (atBottom) el.log.scrollTop = el.log.scrollHeight;
}

function showBanner(msg) {
  el.banner.textContent = msg;
  el.banner.hidden = !msg;
}

function setStatus(state) {
  el.status.dataset.state = state;
  el.status.textContent = STATUS_TEXT[state] ?? state;
}

function setRunning(value) {
  running = value;
  el.toggle.textContent = value ? 'Stop boosting' : 'Start boosting';
  el.toggle.dataset.running = String(value);
  el.settings.disabled = value;
  el.lockedHint.hidden = !value;
  if (!value) {
    setStatus('stopped');
    closePrompt();
  }
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

// ---------- settings ----------

function renderGames() {
  el.games.replaceChildren(...settings.games.map((id) => {
    const li = document.createElement('li');
    const idEl = document.createElement('span');
    idEl.className = 'id';
    idEl.textContent = id;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = gameNames[id] ?? '';
    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.type = 'button';
    remove.title = `Remove ${gameNames[id] ?? id}`;
    remove.setAttribute('aria-label', remove.title);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      settings.games = settings.games.filter((g) => g !== id);
      renderGames();
      save();
    });
    li.append(idEl, name, remove);
    return li;
  }));
  const max = MAX_ENTRIES - (settings.customTitle.trim() ? 1 : 0);
  el.gameCount.textContent = `${settings.games.length} / ${max}`;
  el.gamesEmpty.hidden = settings.games.length > 0;
}

function fillForm() {
  el.account.value = settings.accountName;
  el.title.value = settings.customTitle;
  el.invisible.checked = settings.invisible;
  el.force.checked = settings.force;
  renderGames();
}

function readForm() {
  settings.accountName = el.account.value.trim();
  settings.customTitle = el.title.value;
  settings.invisible = el.invisible.checked;
  settings.force = el.force.checked;
}

let saveTimer = null;
function save() {
  readForm();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await invoke('save_settings', { settings });
      showBanner('');
    } catch (e) {
      showBanner(String(e));
    }
  }, 300);
}

function addGame() {
  const id = parseAppId(el.addGame.value);
  if (id === null) return showBanner('Enter an app ID (a number) or a Steam store link.');
  if (settings.games.includes(id)) return showBanner(`${id} is already in the list.`);
  const max = MAX_ENTRIES - (el.title.value.trim() ? 1 : 0);
  if (settings.games.length >= max) return showBanner(`Steam allows at most ${max} games at once.`);
  settings.games.push(id);
  el.addGame.value = '';
  showBanner('');
  renderGames();
  save();
}

// ---------- login prompt ----------

function openPrompt(ev) {
  promptId = ev.id;
  const isPassword = ev.kind === 'password';
  el.promptTitle.textContent = isPassword ? 'Steam password' : ev.kind === 'guard' ? 'Steam Guard' : 'Steam login';
  el.promptMessage.textContent = isPassword
    ? `${ev.message}. It is sent to Steam only and never saved.`
    : ev.message;
  el.promptInput.type = ev.hidden ? 'password' : 'text';
  el.promptInput.value = '';
  el.promptInput.autocomplete = ev.kind === 'guard' ? 'one-time-code' : 'off';
  if (!el.prompt.open) el.prompt.showModal();
  el.promptInput.focus();
}

function closePrompt() {
  promptId = null;
  el.promptInput.value = '';
  if (el.prompt.open) el.prompt.close();
}

el.promptForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = el.promptInput.value.trim();
  if (!value || promptId === null) return;
  const id = promptId;
  closePrompt();
  try { await invoke('answer_prompt', { id, value }); } catch (err) { showBanner(String(err)); }
});

// Cancelling a login prompt stops the booster; there is nothing else it could do.
el.promptCancel.addEventListener('click', () => { closePrompt(); invoke('stop_boost'); });
el.prompt.addEventListener('cancel', (e) => { e.preventDefault(); el.promptCancel.click(); });

// ---------- booster events ----------

listen('booster', ({ payload: ev }) => {
  switch (ev.type) {
    case 'log':
      addLog(ev.msg, ev.level);
      break;
    case 'error':
      addLog(ev.msg, 'error');
      showBanner(ev.msg);
      break;
    case 'prompt':
      openPrompt(ev);
      break;
    case 'promptCancelled':
      if (ev.id === promptId) closePrompt();
      break;
    case 'status':
      setStatus(ev.state);
      el.timer.textContent = fmtDuration(ev.boostedMs);
      break;
    case 'games':
      for (const g of ev.games) if (g.name) gameNames[g.id] = g.name;
      rememberNames();
      renderGames();
      break;
    case 'persona':
      el.persona.textContent = ev.name;
      el.persona.hidden = !ev.name;
      break;
  }
});

listen('booster-started', () => {
  setRunning(true);
  setStatus('connecting');
  el.timer.textContent = '00:00:00';
  showBanner('');
});

listen('booster-exit', ({ payload }) => {
  setRunning(false);
  el.persona.hidden = true;
  if (payload.code !== 0 && payload.code !== null && el.banner.hidden) {
    showBanner(`The booster stopped unexpectedly (exit code ${payload.code}). See Activity for details.`);
  }
  addLog('Booster stopped.');
});

// ---------- controls ----------

el.toggle.addEventListener('click', async () => {
  if (running) return invoke('stop_boost');
  readForm();
  clearTimeout(saveTimer);
  try {
    await invoke('start_boost', { settings });
  } catch (e) {
    showBanner(String(e));
  }
});

el.addBtn.addEventListener('click', addGame);
el.addGame.addEventListener('keydown', (e) => { if (e.key === 'Enter') addGame(); });
for (const input of [el.account, el.title]) input.addEventListener('input', () => { save(); renderGames(); });
for (const box of [el.invisible, el.force]) box.addEventListener('change', save);

el.forget.addEventListener('click', async () => {
  try {
    const removed = await invoke('forget_login', { account: el.account.value.trim() });
    addLog(removed ? 'Saved login removed. You will be asked for your password next time.' : 'There was no saved login for this account.');
    showBanner('');
  } catch (e) {
    showBanner(String(e));
  }
});

// ---------- start ----------

(async () => {
  settings = { ...settings, ...(await invoke('get_settings')) };
  fillForm();
  setRunning(await invoke('is_running'));
})();
