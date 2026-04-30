// popup.js - Lens Translator (Firefox-first)
'use strict';

const CHUNK_SIZE = 4000;
const REQUEST_TIMEOUT_MS = 10000;
const STOPPED_BY_USER_ERROR = 'Stopped by user';
const RATE_LIMIT_WINDOW_MS = 3000;
const RATE_LIMIT_MAX_REQUESTS = 12;
const SCAN_CONCURRENCY = 3;
const SCAN_BATCH_DELAY_MS = 300;
const SCAN_CHUNK_CAP = 200;

const S = {
  theme: 'dark', fontSize: 14, targetLang: 'en',
  viewMode: 'sidepanel', deeplKey: '',
  provider: 'google',
  activeTab: 'paste', isTranslating: false, outputMode: null,
  scanChunks: [], selectionText: '', inPlaceOn: false, scanTabId: null,
  scanAbortRequested: false, detectedLang: null,
};

const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);
const inSidebar = window.self !== window.top;
const sidebarChannelId = new URLSearchParams(window.location.search).get('channel');
let sidebarPort = null;
const activeScanControllers = new Set();
const translationRequestTimes = [];

document.addEventListener('DOMContentLoaded', async () => {
  if (inSidebar) {
    document.documentElement.classList.add('lens-sidebar');
    document.body.classList.add('lens-sidebar');
    const app = document.getElementById('app');
    if (app) {
      app.style.maxHeight = '100vh';
      app.style.height = '100vh';
      app.style.minHeight = '100vh';
    }
    document.body.style.height = '100vh';
    document.body.style.maxHeight = '100vh';
    document.body.style.minHeight = '100vh';
    document.documentElement.style.height = '100vh';
    document.documentElement.style.maxHeight = '100vh';
    document.documentElement.style.minHeight = '100vh';
    await initSidebarBridge();
  }
  await loadPrefs();
  applyTheme();
  applyFontSize();
  setTargetLang(S.targetLang);
  updateProviderBadge();
  attachListeners();
  updateScanStopButton();
});

async function loadPrefs() {
  // Read local prefs first, isolated — a session storage failure must not
  // prevent theme, fontSize, targetLang, or viewMode from loading.
  let localPrefs = {};
  try {
    localPrefs = await chrome.storage.local.get([
      'deeplKey',
      'fontSize',
      'theme',
      'targetLang',
      'viewMode',
    ]);
    if (localPrefs.fontSize) S.fontSize = Number(localPrefs.fontSize);
    if (localPrefs.theme) S.theme = localPrefs.theme;
    if (localPrefs.targetLang) S.targetLang = localPrefs.targetLang;
    if (localPrefs.viewMode) S.viewMode = localPrefs.viewMode;
    if (!localPrefs.targetLang) {
      const bl = navigator.language?.split('-')[0] || 'en';
      const sel = $('target-lang');
      if (sel && Array.from(sel.options).some(o => o.value === bl)) S.targetLang = bl;
    }
  } catch (e) {
    console.warn('Lens: prefs load error', e);
  }

  // DeepL key — session storage handled separately so a failure there
  // does not affect theme or other preferences loaded above.
  try {
    const session = await chrome.storage.session.get(['deeplKey']);
    if (session.deeplKey) {
      S.deeplKey = session.deeplKey;
      S.provider = 'deepl';
    } else if (localPrefs.deeplKey) {
      S.deeplKey = localPrefs.deeplKey;
      S.provider = 'deepl';
      await chrome.storage.session.set({ deeplKey: localPrefs.deeplKey });
      await chrome.storage.local.remove('deeplKey');
    }
  } catch {}
}

async function savePrefs() {
  await chrome.storage.local.set({
    theme: S.theme,
    fontSize: S.fontSize,
    targetLang: S.targetLang,
    viewMode: S.viewMode,
  });
}

async function doTranslate(text, options = {}) {
  const trackScan = options.trackScan === true;
  if (S.provider === 'deepl' && S.deeplKey) {
    return translateDeepL(text, S.targetLang, S.deeplKey, trackScan);
  }
  return translateGoogle(text, S.targetLang, trackScan);
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
  trackScan = false
) {
  await waitForTranslationSlot(trackScan);
  const controller = new AbortController();
  let timedOut = false;
  if (trackScan) activeScanControllers.add(controller);
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (trackScan && S.scanAbortRequested) {
        throw new Error(STOPPED_BY_USER_ERROR);
      }
      if (timedOut) {
        throw new Error('Request timed out. Please try again.');
      }
      throw new Error('Request was interrupted. Please try again.');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (trackScan) activeScanControllers.delete(controller);
  }
}

async function waitForTranslationSlot(trackScan = false) {
  while (true) {
    if (trackScan && S.scanAbortRequested) {
      throw new Error(STOPPED_BY_USER_ERROR);
    }

    const now = Date.now();
    while (
      translationRequestTimes.length &&
      now - translationRequestTimes[0] >= RATE_LIMIT_WINDOW_MS
    ) {
      translationRequestTimes.shift();
    }

    if (translationRequestTimes.length < RATE_LIMIT_MAX_REQUESTS) {
      translationRequestTimes.push(now);
      return;
    }

    const waitMs = Math.min(250, Math.max(100, RATE_LIMIT_WINDOW_MS - (now - translationRequestTimes[0])));
    await new Promise(resolve => {
      setTimeout(resolve, waitMs);
    });
  }
}

async function translateGoogle(text, targetLang, trackScan = false) {
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', 'auto');
  url.searchParams.set('tl', targetLang);
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', text);

  const resp = await fetchWithTimeout(url.toString(), {}, REQUEST_TIMEOUT_MS, trackScan);
  if (!resp.ok) throw new Error(`Google Translate: ${resp.status}`);
  const data = await resp.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error('Google Translate: unexpected response format');
  }
  const translated = data[0].filter(Boolean).map(s => (Array.isArray(s) ? s[0] : '') || '').join('');
  return { translated: translated || '', detectedLang: data[2] || null };
}

async function translateDeepL(text, targetLang, apiKey, trackScan = false) {
  const isFree = apiKey.endsWith(':fx');
  const endpoint = isFree
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';
  const deeplLang = targetLang === 'zh' ? 'ZH-HANS' : targetLang.toUpperCase().replace('-', '_');

  const resp = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `DeepL-Auth-Key ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ text, target_lang: deeplLang }).toString(),
  }, REQUEST_TIMEOUT_MS, trackScan);

  if (!resp.ok) {
    if (resp.status === 403) throw new Error('DeepL: invalid API key');
    if (resp.status === 456) throw new Error('DeepL: quota exceeded');
    throw new Error(`DeepL error ${resp.status}`);
  }
  const data = await resp.json();
  return {
    translated: data.translations[0].text,
    detectedLang: data.translations[0].detected_source_language?.toLowerCase() || null,
  };
}

function attachListeners() {
  $$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  $('paste-input').addEventListener('input', onPasteInput);
  $('paste-input').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doPasteTranslate(); }
  });
  $('paste-clear').addEventListener('click', clearPaste);
  $('paste-btn').addEventListener('click', doPasteTranslate);

  $('selection-btn').addEventListener('click', doSelectionTranslate);

  $('scan-btn').addEventListener('click', doScan);
  $('scan-stop-btn').addEventListener('click', stopScanTranslation);
  $('in-place-toggle').addEventListener('change', onInPlaceToggle);
  $('revert-btn').addEventListener('click', doRevert);
  $('rescan-btn').addEventListener('click', doScan);
  $('scanmore-btn').addEventListener('click', doScanMore);

  $('target-lang').addEventListener('change', e => { S.targetLang = e.target.value; savePrefs(); });
  $('copy-btn').addEventListener('click', copyOutput);
  $('output-close').addEventListener('click', closeOutput);

  $('settings-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: MSG.OPEN_SETTINGS_TAB }).catch(() => {});
    if (!inSidebar) setTimeout(() => window.close(), 100);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (changes.deeplKey !== undefined && (areaName === 'session' || areaName === 'local')) {
      S.deeplKey = changes.deeplKey.newValue || '';
      S.provider = S.deeplKey ? 'deepl' : 'google';
      updateProviderBadge();
    }
    if (changes.targetLang?.newValue) { S.targetLang = changes.targetLang.newValue; setTargetLang(S.targetLang); }
    if (changes.theme?.newValue) { S.theme = changes.theme.newValue; applyTheme(); }
    if (changes.fontSize?.newValue) { S.fontSize = Number(changes.fontSize.newValue); applyFontSize(); }
  });

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === MSG.CHUNK_CLICKED) highlightOutChunk(msg.chunkId);
  });
}

function applyTheme() {
  const html = document.documentElement;
  html.classList.remove('theme-dark', 'theme-light');
  let t = S.theme;
  if (t === 'system') t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  html.classList.add(`theme-${t}`);
}

function applyFontSize() {
  document.documentElement.style.setProperty('--output-font-size', `${S.fontSize}px`);
  const outputBody = $('output-body');
  if (outputBody) outputBody.style.fontSize = `${S.fontSize}px`;
}

function setTargetLang(lang) {
  S.targetLang = lang;
  const sel = $('target-lang');
  if (Array.from(sel.options).some(o => o.value === lang)) sel.value = lang;
  else sel.value = 'en';
}

function updateProviderBadge() {
  const badge = $('out-provider');
  if (!badge) return;
  badge.textContent = S.provider === 'deepl' ? 'DeepL' : 'Google';
  badge.classList.toggle('deepl', S.provider === 'deepl');
}

function setScanOutputLayout(active) {
  $('app')?.classList.toggle('scan-output-active', active);
}

function setPopupOutputLayout(active) {
  if (inSidebar) return;
  document.documentElement.classList.toggle('popup-output-active', active);
  document.body.classList.toggle('popup-output-active', active);
}

function switchTab(name) {
  S.activeTab = name;
  $$('.tab').forEach(t => {
    const a = t.dataset.tab === name;
    t.classList.toggle('active', a);
    t.setAttribute('aria-selected', String(a));
  });
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${name}`));
  if (name === 'selection') pollSelection();
}

async function pollSelection() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const r = await chrome.tabs.sendMessage(tab.id, { type: MSG.GET_SELECTION });
    if (r?.text?.length > 3) { S.selectionText = r.text; showSelectionLoaded(r.text); }
  } catch {}
}

function showSelectionLoaded(text) {
  $('selection-empty').classList.add('hidden');
  $('selection-loaded').classList.remove('hidden');
  $('selection-preview-text').textContent = text.length > 220 ? `${text.slice(0, 217)}...` : text;
}

function onPasteInput() {
  const val = $('paste-input').value;
  $('char-count').textContent = val.length.toLocaleString();
  $('paste-clear').classList.toggle('hidden', !val);
  $('paste-btn').disabled = !val.trim();
}

function clearPaste() {
  $('paste-input').value = '';
  onPasteInput();
  $('paste-input').focus();
}

async function doPasteTranslate() {
  const text = $('paste-input').value.trim();
  if (!text || S.isTranslating) return;
  await runTranslation(chunkText(text), 'paste');
}

async function doSelectionTranslate() {
  const text = S.selectionText;
  if (!text || S.isTranslating) return;
  await runTranslation(chunkText(text), 'selection');
}

async function doScanMore() {
  if (S.isTranslating) return;
  $('scanmore-btn')?.classList.add('hidden');
  if (inSidebar) {
    S.scanTabId = await getActiveTabId();
    postToSidebarHost({ type: MSG.LENS_SCAN_MORE_PAGE });
  } else {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      const r = await chrome.tabs.sendMessage(tab.id, { type: MSG.SCAN_MORE_PAGE });
      if (r?.chunks?.length) {
        const newChunks = r.chunks.map(c => ({ ...c, translated: null }));
        S.scanChunks.push(...newChunks);
        S.scanTabId = tab.id;
        await runScanTranslation(newChunks, tab.id);
      }
    } catch {}
  }
}

async function doScan() {
  if (S.isTranslating) return;

  if (inSidebar) {
    S.scanTabId = await getActiveTabId();
    S.detectedLang = null;
    postToSidebarHost({ type: MSG.LENS_SCAN_PAGE });
    return;
  }

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error();
  } catch {
    showOutError('Cannot access the current tab.');
    return;
  }

  let chunks;
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: MSG.SCAN_PAGE });
    chunks = r?.chunks;
  } catch {
    showOutError('Could not scan this page. Try refreshing it.');
    return;
  }

  if (!chunks?.length) {
    showOutError('No translatable content found on this page.');
    return;
  }

  S.scanChunks = chunks.map(c => ({ ...c, translated: null }));
  S.scanTabId = tab.id;
  S.scanAbortRequested = false;
  S.detectedLang = null;
  $('scanmore-btn')?.classList.add('hidden');
  await runScanTranslation(S.scanChunks, tab.id);
}

function updateScanStopButton() {
  const btn = $('scan-stop-btn');
  if (!btn) return;
  const active = S.isTranslating && S.outputMode === 'scan';
  btn.disabled = !active;
}

function stopScanTranslation() {
  if (!S.isTranslating || S.outputMode !== 'scan') return;
  S.scanAbortRequested = true;
  activeScanControllers.forEach(controller => controller.abort());
  activeScanControllers.clear();
  $('out-progress').textContent = 'Stopping...';
  if (inSidebar) postToSidebarHost({ type: MSG.LENS_STOP_WATCHING });
  updateScanStopButton();
}

function prepareScanOutput(chunks) {
  openOutput();
  $('out-progress').textContent = `0 / ${chunks.length}`;
  $('output-loader').classList.remove('hidden');
  $('output-body').innerHTML = '';
  $('scan-footer').classList.remove('hidden');
  $('revert-btn').classList.add('hidden');

  chunks.forEach(c => {
    const el = makeChunkEl(c.id, '');
    el.classList.add('skeleton');
    $('output-body').appendChild(el);
  });

  const capped = chunks.slice(0, SCAN_CHUNK_CAP);
  return {
    capped,
    hasCap: chunks.length > SCAN_CHUNK_CAP,
  };
}

function formatScanProgress(done, total, hasCap) {
  return `${done} / ${total}${hasCap ? ` (capped at ${SCAN_CHUNK_CAP})` : ''}`;
}

function updateScanProgress(done, total, hasCap) {
  $('out-progress').textContent = formatScanProgress(done, total, hasCap);
}

function setDetectedLanguage(detectedLang) {
  if (S.detectedLang || !detectedLang) return false;
  S.detectedLang = detectedLang;
  const dl = $('detected-lang');
  dl.textContent = detectedLang;
  dl.classList.add('active');
  return S.detectedLang === S.targetLang;
}

function getOutputChunkEl(chunk) {
  return $('output-body').querySelector(`[data-cid="${chunk.id}"]`);
}

function markScanChunkResult(chunk, translatedText) {
  chunk.translated = translatedText;
  const el = getOutputChunkEl(chunk);
  if (el) {
    el.classList.remove('skeleton');
    el.textContent = translatedText;
  }
}

function markScanChunkFailed(chunk, error) {
  const el = getOutputChunkEl(chunk);
  if (!el) return;

  el.classList.remove('skeleton');
  if (error?.message === STOPPED_BY_USER_ERROR || S.scanAbortRequested) {
    el.textContent = '[stopped]';
    el.style.opacity = '0.45';
  } else {
    el.textContent = '[failed]';
    el.style.opacity = '0.4';
  }
}

async function translateScanChunk(chunk) {
  if (S.scanAbortRequested) return { processed: false, sameLanguage: false };

  try {
    const r = await doTranslate(chunk.text, { trackScan: true });
    markScanChunkResult(chunk, r.translated);
    return {
      processed: true,
      sameLanguage: setDetectedLanguage(r.detectedLang),
    };
  } catch (e) {
    markScanChunkFailed(chunk, e);
    return { processed: true, sameLanguage: false };
  }
}

async function translateScanBatch(batch, progress) {
  await Promise.all(batch.map(async chunk => {
    const { processed, sameLanguage } = await translateScanChunk(chunk);
    if (sameLanguage) progress.sameLanguage = true;
    if (processed) {
      progress.done++;
      updateScanProgress(progress.done, progress.total, progress.hasCap);
    }
  }));
}

function getBatchTranslations(batch) {
  return batch
    .filter(c => c.translated)
    .map(c => ({ id: c.id, translated: c.translated }));
}

async function applyBatchInPlace(batch, tabId) {
  if (!S.inPlaceOn) return;

  const batchTranslations = getBatchTranslations(batch);
  if (!batchTranslations.length) return;

  const targetTabId = tabId || S.scanTabId;
  if (targetTabId) {
    await chrome.tabs.sendMessage(targetTabId, { type: MSG.APPLY_IN_PLACE, translations: batchTranslations }).catch(() => {});
    $('revert-btn').classList.remove('hidden');
  } else if (inSidebar) {
    postToSidebarHost({ type: MSG.LENS_APPLY_IN_PLACE, translations: batchTranslations });
    $('revert-btn').classList.remove('hidden');
  }
}

async function delayBetweenScanBatches(index, total) {
  if (index + SCAN_CONCURRENCY < total && !S.scanAbortRequested) {
    await new Promise(res => {
      setTimeout(res, SCAN_BATCH_DELAY_MS);
    });
  }
}

function markPendingScanChunksStopped(chunks) {
  chunks.forEach(chunk => {
    if (chunk.translated) return;
    const el = getOutputChunkEl(chunk);
    if (el && el.classList.contains('skeleton')) {
      el.classList.remove('skeleton');
      el.textContent = '[stopped]';
      el.style.opacity = '0.45';
    }
  });
}

async function runScanTranslation(chunks, tabId) {
  S.isTranslating = true;
  S.scanAbortRequested = false;
  S.outputMode = 'scan';
  updateScanStopButton();
  try {
    const { capped, hasCap } = prepareScanOutput(chunks);
    const progress = {
      done: 0,
      total: capped.length,
      hasCap,
      sameLanguage: false,
    };

    for (let i = 0; i < capped.length; i += SCAN_CONCURRENCY) {
      const batch = capped.slice(i, i + SCAN_CONCURRENCY);

      if (S.scanAbortRequested) break;

      await translateScanBatch(batch, progress);

      if (S.scanAbortRequested) break;

      if (!progress.sameLanguage) await applyBatchInPlace(batch, tabId);

      await delayBetweenScanBatches(i, capped.length);
    }

    if (S.scanAbortRequested) {
      markPendingScanChunksStopped(capped);
      $('out-progress').textContent = `Stopped at ${formatScanProgress(progress.done, capped.length, hasCap)}`;
    } else {
      $('out-progress').textContent = `${progress.done} chunks`;
    }
  } catch (e) {
    showOutError(`Scan failed: ${e.message || 'Unknown error'}`);
  } finally {
    $('output-loader').classList.add('hidden');
    S.isTranslating = false;
    S.scanAbortRequested = false;
    activeScanControllers.clear();
    updateScanStopButton();
    applyFontSize();
  }
}

function makeChunkEl(id, text) {
  const el = document.createElement('div');
  el.className = 'out-chunk';
  el.dataset.cid = id;
  el.textContent = text;
  el.addEventListener('click', () => onOutChunkClick(id));
  return el;
}

async function onOutChunkClick(id) {
  highlightOutChunk(id);
  try {
    if (S.scanTabId) {
      await chrome.tabs.sendMessage(S.scanTabId, { type: MSG.HIGHLIGHT_CHUNK, chunkId: id });
    } else if (inSidebar) {
      postToSidebarHost({ type: MSG.LENS_HIGHLIGHT_CHUNK, chunkId: id });
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: MSG.HIGHLIGHT_CHUNK, chunkId: id });
    }
  } catch {}
}

function highlightOutChunk(id) {
  $$('.out-chunk').forEach(el => el.classList.remove('active'));
  const el = $('output-body').querySelector(`[data-cid="${id}"]`);
  if (el) { el.classList.add('active'); el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
}

function onInPlaceToggle(e) {
  S.inPlaceOn = e.target.checked;
  $('in-place-warning').classList.toggle('hidden', !S.inPlaceOn);
  const isSameLang = S.detectedLang !== null && S.detectedLang === S.targetLang;
  if (S.inPlaceOn && !isSameLang && S.scanChunks.some(c => c.translated)) {
    applyInPlace(S.scanChunks, S.scanTabId);
  }
}

async function applyInPlace(chunks, tabId) {
  const translations = chunks.filter(c => c.translated).map(c => ({ id: c.id, translated: c.translated }));
  if (!translations.length) return;
  try {
    const targetTabId = tabId || S.scanTabId;
    if (targetTabId) {
      await chrome.tabs.sendMessage(targetTabId, { type: MSG.APPLY_IN_PLACE, translations });
    } else if (inSidebar) {
      postToSidebarHost({ type: MSG.LENS_APPLY_IN_PLACE, translations });
    }
    $('revert-btn').classList.remove('hidden');
  } catch {}
}

async function doRevert() {
  if (S.isTranslating && S.outputMode === 'scan') {
    stopScanTranslation();
  }
  try {
    if (S.scanTabId) {
      await chrome.tabs.sendMessage(S.scanTabId, { type: MSG.REVERT_IN_PLACE });
    } else if (inSidebar) {
      postToSidebarHost({ type: MSG.LENS_REVERT_IN_PLACE });
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: MSG.REVERT_IN_PLACE });
    }
  } catch {}
  $('revert-btn').classList.add('hidden');
}

async function runTranslation(chunks, mode) {
  S.isTranslating = true;
  try {
    S.outputMode = mode;
    openOutput();
    $('out-progress').textContent = chunks.length > 1 ? `0 / ${chunks.length}` : '';
    $('output-loader').classList.remove('hidden');
    $('output-body').innerHTML = '';
    $('scan-footer').classList.add('hidden');

    let full = '';
    let detected = null;
    for (let i = 0; i < chunks.length; i++) {
      try {
        const r = await doTranslate(chunks[i]);
        full += (i > 0 ? ' ' : '') + r.translated;
        if (!detected && r.detectedLang) {
          detected = r.detectedLang;
          const dl = $('detected-lang');
          dl.textContent = r.detectedLang;
          dl.classList.add('active');
        }
        if (chunks.length > 1) $('out-progress').textContent = `${i + 1} / ${chunks.length}`;
      } catch (e) {
        full += ` [Error: ${e.message}]`;
      }
    }

    $('out-progress').textContent = '';
    const el = document.createElement('div');
    el.style.lineHeight = '1.7';
    el.textContent = full;
    $('output-body').appendChild(el);
    applyFontSize();
  } catch (e) {
    showOutError(`Translation failed: ${e.message || 'Unknown error'}`);
  } finally {
    $('output-loader').classList.add('hidden');
    S.isTranslating = false;
    applyFontSize();
  }
}

function chunkText(text) {
  if (text.length <= CHUNK_SIZE) return [text];
  const chunks = [];
  const parts = text.split(/(?<=[.!?。！？])\s+/);
  let cur = '';
  for (const part of parts) {
    if ((cur + ' ' + part).length > CHUNK_SIZE && cur) {
      chunks.push(cur.trim());
      cur = part;
    } else {
      cur += (cur ? ' ' : '') + part;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

function openOutput() {
  $('output-wrap').classList.remove('hidden');
  setPopupOutputLayout(true);
  setScanOutputLayout(S.outputMode === 'scan');
  updateProviderBadge();
  applyFontSize();
}

function closeOutput() {
  if (S.isTranslating && S.outputMode === 'scan') {
    stopScanTranslation();
  }
  $('output-wrap').classList.add('hidden');
  $('output-body').innerHTML = '';
  $('output-loader').classList.add('hidden');
  $('scan-footer').classList.add('hidden');
  setPopupOutputLayout(false);
  setScanOutputLayout(false);
  $('detected-lang').textContent = 'auto';
  $('detected-lang').classList.remove('active');
  S.outputMode = null;
  S.scanChunks = [];
  S.detectedLang = null;
  const previousScanTabId = S.scanTabId;
  S.scanTabId = null;
  if (previousScanTabId) {
    chrome.tabs.sendMessage(previousScanTabId, { type: MSG.CLEAR_SCAN }).catch(() => {});
  } else if (inSidebar) {
    postToSidebarHost({ type: MSG.LENS_CLEAR_SCAN });
  } else {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: MSG.CLEAR_SCAN }).catch(() => {});
    });
  }
  updateScanStopButton();
}

function showOutError(msg) {
  openOutput();
  const errEl = document.createElement('div');
  errEl.className = 'out-error';
  errEl.textContent = msg;
  $('output-body').appendChild(errEl);
  $('output-loader').classList.add('hidden');
}

async function copyOutput() {
  const text = $('output-body').innerText?.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const btn = $('copy-btn');
    btn.classList.add('ok');
    btn.title = 'Copied!';
    setTimeout(() => { btn.classList.remove('ok'); btn.title = 'Copy all'; }, 1600);
  } catch {}
}

async function initSidebarBridge() {
  if (!sidebarChannelId) return;
  window.addEventListener('message', onSidebarInitMessage);
}

async function onSidebarInitMessage(e) {
  if (e.data?.type !== MSG.LENS_INIT_CHANNEL) return;
  if (sidebarPort) return;
  if (e.source !== window.parent) return;
  if (!sidebarChannelId || e.data.channelId !== sidebarChannelId) return;

  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: MSG.GET_SIDEBAR_CHANNEL_SECRET,
      channelId: sidebarChannelId,
    });
  } catch {
    return;
  }

  const expectedSecret = response?.secret;
  const expectedOrigin = response?.origin;
  const port = e.ports?.[0];
  if (!expectedOrigin || e.origin !== expectedOrigin) return;
  if (!expectedSecret || !port || e.data.secret !== expectedSecret) return;

  sidebarPort = port;
  sidebarPort.onmessage = onSidebarHostMessage;
  sidebarPort.start?.();
  window.removeEventListener('message', onSidebarInitMessage);
  postToSidebarHost({ type: MSG.LENS_READY });
}

function onSidebarHostMessage(e) {
  if (!e.data?.type) return;

  switch (e.data.type) {
    case MSG.LENS_TRANSLATE_SELECTION: {
      if (!e.data.text) return;
      const text = e.data.text;
      S.selectionText = text;
      switchTab('selection');
      showSelectionLoaded(text);
      // Defer one frame so the tab-switch paint completes before translation starts
      setTimeout(() => doSelectionTranslate(), 80);
      break;
    }

    case MSG.LENS_SCAN_RESULT: {
      const chunks = e.data.chunks;
      if (!chunks?.length) {
        showOutError('No translatable content found on this page.');
        return;
      }
      S.scanChunks = chunks.map(c => ({ ...c, translated: null }));
      S.detectedLang = null;
      $('scanmore-btn')?.classList.add('hidden');
      runScanTranslation(S.scanChunks, null);
      break;
    }

    case MSG.LENS_CHUNK_CLICKED:
      highlightOutChunk(e.data.chunkId);
      break;

    case MSG.LENS_NEW_CONTENT_AVAILABLE: {
      const btn = $('scanmore-btn');
      if (btn && !S.isTranslating) {
        btn.classList.remove('hidden');
        btn.textContent = 'Scan more';
      }
      break;
    }

    case MSG.LENS_SCAN_MORE_RESULT: {
      const newChunks = e.data.chunks;
      if (!newChunks?.length) return;
      const mappedChunks = newChunks.map(c => ({ ...c, translated: null }));
      S.scanChunks.push(...mappedChunks);
      runScanTranslation(mappedChunks, null);
      break;
    }
  }
}

function postToSidebarHost(message) {
  if (sidebarPort) sidebarPort.postMessage(message);
}

async function getActiveTabId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id || null;
  } catch {
    return null;
  }
}
