// settings.js - Vernac Settings Page
'use strict';

const $ = id => document.getElementById(id);

const S = {
  theme: 'dark', fontSize: 14, targetLang: 'en',
  viewMode: 'popup', deeplKey: '',
  floatingBtn: true, contextMenu: true,
};

document.addEventListener('DOMContentLoaded', async () => {
  await load();
  applyTheme(S.theme);
  syncUI();
  attachListeners();
  const v = $('about-version');
  if (v) v.textContent = `Vernac v${chrome.runtime.getManifest().version}`;
});

async function load() {
  let localPrefs = {};
  try {
    localPrefs = await chrome.storage.local.get([
      'deeplKey',
      'theme',
      'fontSize',
      'targetLang',
      'viewMode',
      'floatingBtn',
      'contextMenu',
    ]);
    if (localPrefs.theme) S.theme = localPrefs.theme;
    if (localPrefs.fontSize) S.fontSize = Number(localPrefs.fontSize);
    if (localPrefs.targetLang) S.targetLang = localPrefs.targetLang;
    if (localPrefs.viewMode) S.viewMode = localPrefs.viewMode;
    if (typeof localPrefs.floatingBtn !== 'undefined') S.floatingBtn = !!localPrefs.floatingBtn;
    if (typeof localPrefs.contextMenu !== 'undefined') S.contextMenu = !!localPrefs.contextMenu;
  } catch (e) {
    console.warn('Vernac: settings prefs load error', e);
  }

  S.deeplKey = await loadDeeplKey(localPrefs);
}

async function save() {
  await chrome.storage.local.set({
    floatingBtn: S.floatingBtn,
    contextMenu: S.contextMenu,
    theme: S.theme,
    fontSize: S.fontSize,
    targetLang: S.targetLang,
    viewMode: S.viewMode,
  });
}

function applyTheme(choice) {
  let effective = choice;
  if (choice === 'system') {
    effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  const root = document.documentElement;
  root.classList.remove('theme-dark', 'theme-light');
  root.classList.add(`theme-${effective}`);
}

function syncUI() {
  document.querySelectorAll('#theme-ctrl .seg').forEach(b =>
    b.classList.toggle('active', b.dataset.value === S.theme));
  $('font-val').textContent = S.fontSize;
  document.querySelectorAll('#view-ctrl .seg').forEach(b =>
    b.classList.toggle('active', b.dataset.value === S.viewMode));
  const spNote = $('sidepanel-note');
  if (spNote) spNote.style.display = S.viewMode === 'sidepanel' ? '' : 'none';
  $('target-lang').value = S.targetLang;
  $('floating-toggle').checked = S.floatingBtn;
  $('context-toggle').checked = S.contextMenu;
  if (S.deeplKey) {
    $('deepl-input').value = S.deeplKey;
    setKeyStatus('DeepL active', 'ok');
  }
  updateProviderUI();
}

function updateProviderUI() {
  const dot = $('provider-dot');
  const name = $('provider-name');
  const sub = $('provider-sub');
  const pill = $('provider-pill');
  const info = $('provider-info');

  if (S.deeplKey) {
    if (dot) { dot.classList.remove('dim'); dot.style.background = 'var(--success)'; }
    if (name) name.textContent = 'DeepL';
    if (sub) sub.textContent = 'Using your API key · Higher quality';
    if (pill) { pill.textContent = 'Active'; pill.className = 'provider-pill'; }
    if (info) info.textContent = 'DeepL is active. Your key is stored only for this browser session and only sent to DeepL\'s API. Remove the key to switch back to Google Translate.';
  } else {
    if (dot) { dot.classList.remove('dim'); }
    if (name) name.textContent = 'Google Translate';
    if (sub) sub.textContent = 'Free for all users · No account required';
    if (pill) { pill.textContent = 'Active'; pill.className = 'provider-pill google'; }
    if (info) info.textContent = 'Vernac uses Google Translate by default. It is completely free for all users and requires no account or sign-up. Translation requests are sent directly from your browser to Google\'s API.';
  }
}

function setKeyStatus(msg, cls) {
  const el = $('key-status');
  if (!el) return;
  el.textContent = msg;
  el.className = `key-status ${cls || ''}`;
}

function attachListeners() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      const sec = $(`section-${btn.dataset.section}`);
      if (sec) sec.classList.add('active');
    });
  });

  $('back-btn').addEventListener('click', () => {
    chrome.tabs.getCurrent()
      .then(tab => {
        if (tab?.id) return chrome.tabs.remove(tab.id);
        window.close();
        return undefined;
      })
      .catch(() => window.close());
  });

  document.querySelectorAll('#theme-ctrl .seg').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#theme-ctrl .seg').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    S.theme = b.dataset.value;
    applyTheme(S.theme);
    save();
  }));

  $('font-down').addEventListener('click', () => {
    S.fontSize = Math.max(11, S.fontSize - 1);
    $('font-val').textContent = S.fontSize;
    const preview = $('font-preview');
    if (preview) preview.style.fontSize = `${S.fontSize}px`;
    save();
  });
  $('font-up').addEventListener('click', () => {
    S.fontSize = Math.min(19, S.fontSize + 1);
    $('font-val').textContent = S.fontSize;
    const preview = $('font-preview');
    if (preview) preview.style.fontSize = `${S.fontSize}px`;
    save();
  });

  document.querySelectorAll('#view-ctrl .seg').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#view-ctrl .seg').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    S.viewMode = b.dataset.value;
    const spNote = $('sidepanel-note');
    if (spNote) spNote.style.display = S.viewMode === 'sidepanel' ? '' : 'none';
    save();
    chrome.runtime.sendMessage({ type: MSG.SET_VIEW_MODE, mode: S.viewMode }).catch(() => {});
  }));

  $('target-lang').addEventListener('change', e => { S.targetLang = e.target.value; save(); });

  $('floating-toggle').addEventListener('change', e => { S.floatingBtn = e.target.checked; save(); });
  $('context-toggle').addEventListener('change', e => {
    S.contextMenu = e.target.checked;
    chrome.runtime.sendMessage({ type: MSG.SET_CONTEXT_MENU, enabled: S.contextMenu }).catch(() => {});
    save();
  });

  $('key-show').addEventListener('click', () => {
    const inp = $('deepl-input');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });
  $('key-save').addEventListener('click', saveKey);
  $('key-clear').addEventListener('click', clearKey);
  $('deepl-input').addEventListener('keydown', e => { if (e.key === 'Enter') saveKey(); });
}

async function saveKey() {
  const key = $('deepl-input').value.trim();
  if (!key) { clearKey(); return; }
  if (key.length < 20) { setKeyStatus('Key looks too short - check and try again', 'err'); return; }
  S.deeplKey = key;
  await chrome.storage.session.set({ deeplKey: key });
  await chrome.storage.local.remove('deeplKey').catch(() => {});
  setKeyStatus('Saved - DeepL is now active', 'ok');
  updateProviderUI();
}

async function clearKey() {
  S.deeplKey = '';
  $('deepl-input').value = '';
  await chrome.storage.session.remove('deeplKey');
  await chrome.storage.local.remove('deeplKey').catch(() => {});
  setKeyStatus('Key removed - back to Google Translate', '');
  updateProviderUI();
  setTimeout(() => setKeyStatus('', ''), 2500);
}
