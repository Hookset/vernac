// background.js — Lens Translator (Firefox-first)
'use strict';

// MSG is defined inline here because importScripts is unreliable in MV3
// service workers. All other contexts load shared/messages.js instead.
// Keep these values in sync with shared/messages.js.
const MSG = {
  TOGGLE_SIDEBAR:            'TOGGLE_SIDEBAR',
  CLOSE_SIDEBAR:             'CLOSE_SIDEBAR',
  OPEN_SIDEBAR_WITH_PENDING: 'OPEN_SIDEBAR_WITH_PENDING',
  SIDEBAR_OPENED:            'SIDEBAR_OPENED',
  SIDEBAR_CLOSED:            'SIDEBAR_CLOSED',
  SCAN_PAGE:                 'SCAN_PAGE',
  SCAN_MORE_PAGE:            'SCAN_MORE_PAGE',
  HIGHLIGHT_CHUNK:           'HIGHLIGHT_CHUNK',
  CLEAR_SCAN:                'CLEAR_SCAN',
  APPLY_IN_PLACE:            'APPLY_IN_PLACE',
  REVERT_IN_PLACE:           'REVERT_IN_PLACE',
  GET_SELECTION:             'GET_SELECTION',
  CHUNK_CLICKED:             'CHUNK_CLICKED',
  OPEN_SETTINGS_TAB:         'OPEN_SETTINGS_TAB',
  SET_VIEW_MODE:             'SET_VIEW_MODE',
  SET_BADGE:                 'SET_BADGE',
  CLEAR_BADGE:               'CLEAR_BADGE',
  SET_CONTEXT_MENU:          'SET_CONTEXT_MENU',
  CREATE_SIDEBAR_CHANNEL:    'CREATE_SIDEBAR_CHANNEL',
  GET_SIDEBAR_CHANNEL_SECRET:'GET_SIDEBAR_CHANNEL_SECRET',
  DELETE_SIDEBAR_CHANNEL:    'DELETE_SIDEBAR_CHANNEL',
  LENS_INIT_CHANNEL:         'LENS_INIT_CHANNEL',
  LENS_READY:                'LENS_READY',
  LENS_SCAN_PAGE:            'LENS_SCAN_PAGE',
  LENS_SCAN_MORE_PAGE:       'LENS_SCAN_MORE_PAGE',
  LENS_SCAN_RESULT:          'LENS_SCAN_RESULT',
  LENS_SCAN_MORE_RESULT:     'LENS_SCAN_MORE_RESULT',
  LENS_STOP_WATCHING:        'LENS_STOP_WATCHING',
  LENS_HIGHLIGHT_CHUNK:      'LENS_HIGHLIGHT_CHUNK',
  LENS_CHUNK_CLICKED:        'LENS_CHUNK_CLICKED',
  LENS_NEW_CONTENT_AVAILABLE:'LENS_NEW_CONTENT_AVAILABLE',
  LENS_APPLY_IN_PLACE:       'LENS_APPLY_IN_PLACE',
  LENS_REVERT_IN_PLACE:      'LENS_REVERT_IN_PLACE',
  LENS_CLEAR_SCAN:           'LENS_CLEAR_SCAN',
  LENS_TRANSLATE_SELECTION:  'LENS_TRANSLATE_SELECTION',
};

const sidebarChannels = new Map();
const DEBUG = false;
const POST_INJECT_RETRY_ATTEMPTS = 5;
const POST_INJECT_RETRY_DELAY_MS = 120;
const SIDEBAR_CHANNEL_TTL_MS = 60_000;
const SIDEBAR_CHANNEL_INDEX_KEY = 'sidebarChannelIds';
const SIDEBAR_CHANNEL_KEY_PREFIX = 'sidebarChannel:';

function debugWarn(...args) {
  if (DEBUG) {
    console.warn('[Lens]', ...args);
  }
}

function isSettingsPageUrl(url) {
  if (!url) return false;
  const settingsUrl = chrome.runtime.getURL('popup/settings.html');
  return url === settingsUrl || url.startsWith(`${settingsUrl}?`) || url.startsWith(`${settingsUrl}#`);
}

async function updateActionStateForTab(tabId, url) {
  if (!tabId) return;
  try {
    if (isSettingsPageUrl(url)) {
      await chrome.action.disable(tabId);
    } else {
      await chrome.action.enable(tabId);
    }
  } catch (e) {
    debugWarn('Failed to update toolbar action state', e);
  }
}

async function updateActionStateForActiveTab(activeInfo) {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    await updateActionStateForTab(tab.id, tab.url);
  } catch (e) {
    debugWarn('Failed to update active toolbar action state', e);
  }
}

async function updateActionStateForActiveTabs() {
  try {
    const tabs = await chrome.tabs.query({ active: true });
    await Promise.all(tabs.map(tab => updateActionStateForTab(tab.id, tab.url)));
  } catch (e) {
    debugWarn('Failed to update active toolbar action states', e);
  }
}

function delay(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function sendMessageWithRetry(tabId, payload, attempts = 1, delayMs = 0) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await chrome.tabs.sendMessage(tabId, payload);
    } catch (e) {
      lastError = e;
      if (attempt < attempts && delayMs > 0) {
        await delay(delayMs);
      }
    }
  }
  throw lastError || new Error('Failed to send tab message');
}

async function ensureContentInjected(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['shared/messages.js', 'content.js'] });
  await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
}
function sidebarChannelKey(channelId) {
  return `${SIDEBAR_CHANNEL_KEY_PREFIX}${channelId}`;
}

async function getSidebarChannelIds() {
  const stored = await chrome.storage.session.get(SIDEBAR_CHANNEL_INDEX_KEY);
  return Array.isArray(stored[SIDEBAR_CHANNEL_INDEX_KEY])
    ? stored[SIDEBAR_CHANNEL_INDEX_KEY].filter(id => typeof id === 'string')
    : [];
}

async function setSidebarChannelIds(ids) {
  await chrome.storage.session.set({
    [SIDEBAR_CHANNEL_INDEX_KEY]: Array.from(new Set(ids.filter(id => typeof id === 'string'))),
  });
}

async function persistSidebarChannel(id, channel) {
  const record = {
    ...channel,
    expiresAt: Date.now() + SIDEBAR_CHANNEL_TTL_MS,
  };
  sidebarChannels.set(id, record);
  await chrome.storage.session.set({ [sidebarChannelKey(id)]: record });
  const ids = await getSidebarChannelIds();
  await setSidebarChannelIds([...ids, id]);
  return record;
}

async function deleteSidebarChannel(id) {
  if (!id) return;
  sidebarChannels.delete(id);
  await chrome.storage.session.remove(sidebarChannelKey(id));
  await setSidebarChannelIds((await getSidebarChannelIds()).filter(channelId => channelId !== id));
}

async function getSidebarChannel(id) {
  if (!id) return null;
  let channel = sidebarChannels.get(id) || null;
  if (!channel) {
    const stored = await chrome.storage.session.get(sidebarChannelKey(id));
    channel = stored[sidebarChannelKey(id)] || null;
    if (channel) sidebarChannels.set(id, channel);
  }

  if (!channel) return null;
  if (!channel.expiresAt || channel.expiresAt < Date.now()) {
    await deleteSidebarChannel(id);
    return null;
  }
  return channel;
}

async function cleanupExpiredSidebarChannels() {
  const ids = await getSidebarChannelIds();
  if (!ids.length) return;

  const keys = ids.map(sidebarChannelKey);
  const stored = await chrome.storage.session.get(keys);
  const now = Date.now();
  const keepIds = [];
  const removeKeys = [];

  for (const id of ids) {
    const key = sidebarChannelKey(id);
    const channel = stored[key] || sidebarChannels.get(id) || null;
    if (!channel || !channel.expiresAt || channel.expiresAt < now) {
      sidebarChannels.delete(id);
      removeKeys.push(key);
    } else {
      keepIds.push(id);
      sidebarChannels.set(id, channel);
    }
  }

  if (removeKeys.length) {
    await chrome.storage.session.remove(removeKeys);
    await setSidebarChannelIds(keepIds);
  }
}

// ── Firefox keepalive + re-apply view mode on background wake ────────────────
try {
  chrome.alarms.create('lens-keepalive', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener(() => {
    // Re-apply view mode each time the alarm fires — ensures popup state
    // is correct even after Firefox suspends and restarts the background script
    applyViewMode().catch(e => debugWarn('keepalive applyViewMode failed', e));
    cleanupExpiredSidebarChannels().catch(e => debugWarn('sidebar channel cleanup failed', e));
  });
} catch (e) {
  debugWarn('keepalive alarm setup failed', e);
}

// ── Startup: restore correct popup state ─────────────────────────────────────
chrome.runtime.onStartup.addListener(() => {
  applyViewMode().catch(e => debugWarn('startup applyViewMode failed', e));
  updateActionStateForActiveTabs().catch(e => debugWarn('startup action state update failed', e));
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(async () => {
    chrome.contextMenus.create({
      id: 'lens-translate-selection',
      title: 'Translate with Lens',
      contexts: ['selection'],
    });
    try {
      const d = await chrome.storage.local.get('contextMenu');
      if (d.contextMenu === false) {
        await chrome.contextMenus.update('lens-translate-selection', { visible: false });
      }
    } catch (e) {
      debugWarn('Failed to restore contextMenu visibility on install', e);
    }
  });
  applyViewMode().catch(e => debugWarn('installed applyViewMode failed', e));
  updateActionStateForActiveTabs().catch(e => debugWarn('installed action state update failed', e));
});

chrome.tabs.onActivated.addListener(activeInfo => {
  updateActionStateForActiveTab(activeInfo);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || tab.active) {
    updateActionStateForTab(tabId, changeInfo.url || tab.url);
  }
});

async function applyViewMode() {
  try {
    const d = await chrome.storage.local.get('viewMode');
    // In sidebar mode the toolbar click fires onClicked instead of opening popup
    // Default is sidepanel; only restore popup if explicitly set to popup
    if (d.viewMode === 'popup') {
      await chrome.action.setPopup({ popup: 'popup/popup.html' });
    } else {
      await chrome.action.setPopup({ popup: '' });
    }
  } catch (e) {
    debugWarn('applyViewMode failed', e);
  }
}


applyViewMode().catch(e => debugWarn('initial applyViewMode failed', e));
updateActionStateForActiveTabs().catch(e => debugWarn('initial action state update failed', e));
// ── Toolbar icon clicked ──────────────────────────────────────────────────────
// Fires in two cases:
//   (a) viewMode=sidepanel → popup is cleared, so this always fires
//   (b) viewMode=popup AND a sidebar is currently open on the page
//       (we clear popup when sidebar opens so this fires to toggle it off)
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  if (isSettingsPageUrl(tab.url)) {
    await updateActionStateForTab(tab.id, tab.url);
    return;
  }
  try {
    await sendMessageWithRetry(tab.id, { type: MSG.TOGGLE_SIDEBAR });
  } catch (e) {
    debugWarn('TOGGLE_SIDEBAR direct send failed, attempting injection', e);
    try {
      await ensureContentInjected(tab.id);
      await sendMessageWithRetry(
        tab.id,
        { type: MSG.TOGGLE_SIDEBAR },
        POST_INJECT_RETRY_ATTEMPTS,
        POST_INJECT_RETRY_DELAY_MS
      );
    } catch (err) {
      debugWarn('TOGGLE_SIDEBAR injection/retry failed', err);
    }
  }
});

// ── Context menu ─────────────────────────────────────────────────────────────
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'lens-translate-selection') return;
  const rawText = info.selectionText?.trim();
  if (!tab?.id || !rawText) return;
  // Cap to avoid sending enormous payloads to the translation API
  const text = rawText.slice(0, 4000);

  try {
    await sendMessageWithRetry(tab.id, { type: MSG.OPEN_SIDEBAR_WITH_PENDING, text });
  } catch (e) {
    debugWarn('OPEN_SIDEBAR_WITH_PENDING direct send failed, attempting injection', e);
    try {
      await ensureContentInjected(tab.id);
      await sendMessageWithRetry(
        tab.id,
        { type: MSG.OPEN_SIDEBAR_WITH_PENDING, text },
        POST_INJECT_RETRY_ATTEMPTS,
        POST_INJECT_RETRY_DELAY_MS
      );
    } catch (err) {
      debugWarn('OPEN_SIDEBAR_WITH_PENDING injection/retry failed', err);
    }
  }
});

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Reject messages from unexpected senders (e.g. injected scripts on pages)
  if (sender.id !== chrome.runtime.id) {
    debugWarn('Rejected message from unexpected sender', sender?.id, msg?.type);
    return;
  }

  switch (msg.type) {

    // Content script tells us a sidebar just opened on a tab:
    // Temporarily clear the popup so toolbar click toggles sidebar (not opens popup)
    case MSG.SIDEBAR_OPENED:
      chrome.action.setPopup({ popup: '' })
        .catch(e => debugWarn('Failed to clear popup on SIDEBAR_OPENED', e));
      break;

    // Content script tells us the sidebar closed:
    // Restore popup if viewMode is still 'popup'
    case MSG.SIDEBAR_CLOSED:
      (async () => {
        const d = await chrome.storage.local.get('viewMode')
          .catch(e => {
            debugWarn('Failed to read viewMode on SIDEBAR_CLOSED', e);
            return {};
          });
        // Only restore popup if explicitly set to 'popup' — default (undefined) stays sidebar
        if (d.viewMode === 'popup') {
          await chrome.action.setPopup({ popup: 'popup/popup.html' })
            .catch(e => debugWarn('Failed to restore popup on SIDEBAR_CLOSED', e));
        }
      })();
      break;

    // Settings page requests a tab open (needed when called from within iframe)
    case MSG.OPEN_SETTINGS_TAB: {
      (async () => {
        const settingsUrl = chrome.runtime.getURL('popup/settings.html');
        const existing = await chrome.tabs.query({ url: settingsUrl });
        if (existing?.length > 0) {
          await chrome.tabs.update(existing[0].id, { active: true });
          await chrome.windows.update(existing[0].windowId, { focused: true });
        } else {
          const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
          const normalWin = wins.find(w => w.focused) || wins[0];
          if (normalWin) {
            await chrome.tabs.create({ url: settingsUrl, windowId: normalWin.id });
            await chrome.windows.update(normalWin.id, { focused: true });
          } else {
            await chrome.windows.create({ url: settingsUrl, type: 'normal', width: 1100, height: 750 });
          }
        }
      })().catch(e => debugWarn('Failed to open settings tab', e));
      break;
    }

    case MSG.SET_VIEW_MODE:
      (async () => {
        if (msg.mode === 'sidepanel') {
          await chrome.action.setPopup({ popup: '' });
        } else {
          await chrome.action.setPopup({ popup: 'popup/popup.html' });
          // Close any open sidebars
          const tabs = await chrome.tabs.query({});
          for (const t of tabs) {
            if (t.id) {
              chrome.tabs.sendMessage(t.id, { type: MSG.CLOSE_SIDEBAR, viewMode: msg.mode })
                .catch(e => debugWarn('Failed to close sidebar while switching to popup mode', e));
            }
          }
        }
        sendResponse({ ok: true });
      })();
      return true;

    case MSG.SET_BADGE:
      chrome.action.setBadgeText({ text: msg.text || '' });
      chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
      break;

    case MSG.CLEAR_BADGE:
      chrome.action.setBadgeText({ text: '' });
      break;

    case MSG.SET_CONTEXT_MENU:
      chrome.contextMenus.update('lens-translate-selection',
        { visible: !!msg.enabled }).catch(e => debugWarn('Failed to update context menu visibility', e));
      break;

    case MSG.CREATE_SIDEBAR_CHANNEL: {
      (async () => {
        const id = randomToken();
        const secret = randomToken();
        await persistSidebarChannel(id, {
          secret,
          origin: getOrigin(sender?.tab?.url),
        });
        sendResponse({ id, secret });
      })().catch(e => {
        debugWarn('Failed to create sidebar channel', e);
        sendResponse({ error: 'Failed to create sidebar channel' });
      });
      return true;
    }

    case MSG.GET_SIDEBAR_CHANNEL_SECRET: {
      (async () => {
        const channel = await getSidebarChannel(msg.channelId);
        sendResponse({
          secret: channel?.secret || null,
          origin: channel?.origin || null,
        });
      })().catch(e => {
        debugWarn('Failed to read sidebar channel', e);
        sendResponse({ secret: null, origin: null });
      });
      return true;
    }

    case MSG.DELETE_SIDEBAR_CHANNEL:
      deleteSidebarChannel(msg.channelId)
        .then(() => sendResponse({ ok: true }))
        .catch(e => {
          debugWarn('Failed to delete sidebar channel', e);
          sendResponse({ ok: false });
        });
      return true;
  }
});

function randomToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function getOrigin(url) {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
