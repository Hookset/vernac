// content.js — Vernac (Firefox-first)
(function () {
  'use strict';

  const _lensGuard = Symbol.for('lens-translator.injected');
  if (window[_lensGuard]) return;
  window[_lensGuard] = true;

  // ── Scan constants ─────────────────────────────────────────────────────────
  const SCAN_SELECTOR = [
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'li', 'blockquote', 'td', 'th', 'figcaption', 'dt', 'dd',
    'a', 'span', 'div', 'section', 'button',
  ].join(', ');

  const BLOCK_CHILDREN = new Set(['P','H1','H2','H3','H4','H5','H6','LI',
    'BLOCKQUOTE','TD','TH','FIGCAPTION','DT','DD','DIV','SECTION','ARTICLE']);

  const SKIP_ROLES = new Set(['navigation','banner','contentinfo','complementary',
    'search','toolbar','menubar','menu','dialog','alertdialog','status','log']);

  const CONTAINER_TAGS = new Set(['DIV','SECTION','ARTICLE','MAIN','ASIDE','TD','TH']);
  const SIDEBAR_IFRAME_WIDTH_PX = 480;
  const SIDEBAR_CLOSE_STRIP_WIDTH_PX = 16;
  const SIDEBAR_TOTAL_WIDTH_PX = SIDEBAR_IFRAME_WIDTH_PX + SIDEBAR_CLOSE_STRIP_WIDTH_PX;

  // ── State ──────────────────────────────────────────────────────────────────
  let floatingBtn    = null;
  let selectionTimer = null;
  let lastText       = '';
  let scanChunks     = [];
  let originalNodeMap = new Map();
  let sidebarFrame   = null;
  let sidebarReady   = false;
  let pendingMessage = null; // queued until sidebar signals ready
  let newContentObserver = null; // watches for new DOM content after scan
  let sidebarPort    = null;
  let sidebarChannel = null;
  let sidebarToggleTab = null;
  let previousBodyMarginRight = null;
  let viewMode = 'popup';
  let floatingBtnEnabled = true;
  const EXTENSION_ORIGIN = chrome.runtime.getURL('').slice(0, -1);

  // ── Sidebar management ─────────────────────────────────────────────────────
  async function openSidebar(callback) {
    if (sidebarFrame) {
      // Already open — just call back immediately if ready, else queue
      if (sidebarReady && callback) callback();
      else if (callback) pendingMessage = callback;
      return;
    }

    sidebarReady   = false;
    pendingMessage = callback || null;

    try {
      sidebarChannel = await createSidebarChannel();
    } catch {
      sidebarChannel = null;
      pendingMessage = null;
      return;
    }

    // Wrapper holds iframe + close strip
    const wrapper = document.createElement('div');
    wrapper.id = '__lens-sidebar-wrapper__';

    // Close strip on the left edge
    const closeStrip = document.createElement('button');
    closeStrip.id = '__lens-sidebar-close__';
    closeStrip.title = 'Close Vernac';
    closeStrip.appendChild(createSvgIcon('14', '14', [
      ['path', { d: 'M15 18l-6-6 6-6' }],
    ]));
    closeStrip.addEventListener('click', closeSidebar);

    const frame = document.createElement('iframe');
    frame.id  = '__lens-sidebar-frame__';
    frame.src = chrome.runtime.getURL(`popup/popup.html?channel=${encodeURIComponent(sidebarChannel.id)}`);
    frame.addEventListener('load', initSidebarBridge, { once: true });

    wrapper.appendChild(closeStrip);
    wrapper.appendChild(frame);
    document.body.appendChild(wrapper);
    sidebarFrame = frame;
    previousBodyMarginRight = document.body.style.marginRight;
    document.body.style.marginRight = `${SIDEBAR_TOTAL_WIDTH_PX}px`;
    updateSidebarToggleTab();

    // Tell background to clear the popup so toolbar click won't open it on top
    chrome.runtime.sendMessage({ type: MSG.SIDEBAR_OPENED }).catch(() => {});

    // The sidebar bridge is established on iframe load using an authenticated MessagePort.
  }

  async function closeSidebar() {
    if (!sidebarFrame) return;

    // Stop watching for new content
    stopWatchingForNewContent();
    // Revert any in-place translations before losing the original HTML map
    revertInPlace();
    // Then clean up scan state and remaining highlight classes
    clearScan();
    document.querySelectorAll('.__lens-in-place__').forEach(el =>
      el.classList.remove('__lens-in-place__')
    );
    document.querySelectorAll('.__lens-chunk-active__').forEach(el =>
      el.classList.remove('__lens-chunk-active__')
    );

    const wrapper = document.getElementById('__lens-sidebar-wrapper__');
    if (wrapper) wrapper.remove();
    else sidebarFrame.remove();
    if (sidebarPort) {
      sidebarPort.onmessage = null;
      sidebarPort.close();
      sidebarPort = null;
    }
    await cleanupSidebarChannel();
    sidebarFrame   = null;
    sidebarReady   = false;
    pendingMessage = null;
    document.body.style.marginRight = previousBodyMarginRight || '';
    previousBodyMarginRight = null;
    updateSidebarToggleTab();
    chrome.runtime.sendMessage({ type: MSG.SIDEBAR_CLOSED }).catch(() => {});
  }

  function toggleSidebar() {
    if (sidebarFrame) closeSidebar().catch(() => {});
    else openSidebar().catch(() => {});
  }

  function createSidebarToggleTab() {
    if (sidebarToggleTab) return;

    sidebarToggleTab = document.createElement('button');
    sidebarToggleTab.id = '__lens-sidebar-toggle__';
    sidebarToggleTab.type = 'button';
    sidebarToggleTab.title = 'Open Vernac sidebar';
    sidebarToggleTab.setAttribute('aria-label', 'Open Vernac sidebar');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M9 18l6-6-6-6');
    svg.appendChild(path);
    sidebarToggleTab.appendChild(svg);
    sidebarToggleTab.addEventListener('click', () => openSidebar());
    document.documentElement.appendChild(sidebarToggleTab);
  }

  function createSvgIcon(width, height, children) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round');

    children.forEach(([tag, attrs]) => {
      const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
      Object.entries(attrs).forEach(([name, value]) => child.setAttribute(name, value));
      svg.appendChild(child);
    });

    return svg;
  }

  function updateSidebarToggleTab() {
    createSidebarToggleTab();
    const shouldShow = viewMode !== 'popup' && !sidebarFrame;
    sidebarToggleTab.classList.toggle('visible', shouldShow);
  }

  async function initSidebarToggleTab() {
    try {
      const d = await chrome.storage.local.get('viewMode');
      if (d.viewMode) viewMode = d.viewMode;
    } catch (e) { console.warn('[Vernac] Failed to load viewMode pref', e); }

    updateSidebarToggleTab();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.viewMode) return;
      viewMode = changes.viewMode.newValue || 'popup';
      updateSidebarToggleTab();
    });
  }

  async function initFloatingButtonPreference() {
    try {
      const d = await chrome.storage.local.get('floatingBtn');
      floatingBtnEnabled = d.floatingBtn !== false;
    } catch (e) { console.warn('[Vernac] Failed to load floatingBtn pref', e); }

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.floatingBtn) {
        floatingBtnEnabled = changes.floatingBtn.newValue !== false;
        if (!floatingBtnEnabled) hideBtn();
      }
    });
  }

  function sendToSidebar(msg) {
    if (sidebarPort) {
      sidebarPort.postMessage(msg);
    }
  }

  function onSidebarPortMessage(e) {
    switch (e.data?.type) {
      case MSG.LENS_READY:
        sidebarReady = true;
        if (pendingMessage) {
          pendingMessage();
          pendingMessage = null;
        }
        break;

      case MSG.LENS_SCAN_PAGE: {
        const chunks = scanPage();
        sendToSidebar({ type: MSG.LENS_SCAN_RESULT, chunks });
        // Start watching for new content after initial scan
        startWatchingForNewContent();
        break;
      }

      case MSG.LENS_SCAN_MORE_PAGE: {
        // Only scan elements NOT already tagged (new content loaded since last scan)
        stopWatchingForNewContent();
        const newChunks = scanPageNewOnly();
        sendToSidebar({ type: MSG.LENS_SCAN_MORE_RESULT, chunks: newChunks });
        startWatchingForNewContent();
        break;
      }

      case MSG.LENS_STOP_WATCHING:
        stopWatchingForNewContent();
        break;

      case MSG.LENS_HIGHLIGHT_CHUNK:
        setActiveChunk(e.data.chunkId);
        break;

      case MSG.LENS_CLEAR_SCAN:
        clearScan();
        break;

      case MSG.LENS_APPLY_IN_PLACE:
        if (e.data.translations) applyInPlace(e.data.translations);
        break;

      case MSG.LENS_REVERT_IN_PLACE:
        revertInPlace();
        break;
    }
  }

  function initSidebarBridge() {
    if (!sidebarFrame?.contentWindow || !sidebarChannel) return;

    try {
      const channel = new MessageChannel();
      sidebarPort = channel.port1;
      sidebarPort.onmessage = onSidebarPortMessage;
      sidebarPort.start?.();

      sidebarFrame.contentWindow.postMessage(
        {
          type: MSG.LENS_INIT_CHANNEL,
          channelId: sidebarChannel.id,
          secret: sidebarChannel.secret,
        },
        EXTENSION_ORIGIN,
        [channel.port2]
      );
    } catch {
      closeSidebar().catch(() => {});
    }
  }

  async function createSidebarChannel() {
    const response = await chrome.runtime.sendMessage({ type: MSG.CREATE_SIDEBAR_CHANNEL });
    if (!response?.id || !response?.secret) throw new Error('Failed to create sidebar channel');
    return { id: response.id, secret: response.secret };
  }

  async function cleanupSidebarChannel() {
    if (!sidebarChannel?.id) {
      sidebarChannel = null;
      return;
    }
    const channelId = sidebarChannel.id;
    sidebarChannel = null;
    await chrome.runtime.sendMessage({ type: MSG.DELETE_SIDEBAR_CHANNEL, channelId }).catch(() => {});
  }

  // ── Translate via sidebar ──────────────────────────────────────────────────
  function translateInSidebar(text) {
    openSidebar(() => {
      sendToSidebar({ type: MSG.LENS_TRANSLATE_SELECTION, text });
    });
  }

  // ── Floating button ────────────────────────────────────────────────────────
  function getOrCreateBtn() {
    if (floatingBtn) return floatingBtn;
    floatingBtn = document.createElement('button');
    floatingBtn.id = '__lens-floating-btn__';
    floatingBtn.type = 'button';
    floatingBtn.appendChild(createSvgIcon('13', '13', [
      ['circle', { cx: '11', cy: '11', r: '7' }],
      ['line', { x1: '16.5', y1: '16.5', x2: '21', y2: '21' }],
      ['line', { x1: '8', y1: '11', x2: '14', y2: '11' }],
      ['line', { x1: '11', y1: '8', x2: '11', y2: '14' }],
    ]));
    const label = document.createElement('span');
    label.textContent = 'Translate';
    floatingBtn.appendChild(label);
    floatingBtn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
    floatingBtn.addEventListener('click', onBtnClick);
    document.body.appendChild(floatingBtn);
    return floatingBtn;
  }

  function showBtn(rect, text) {
    lastText = text;
    const btn = getOrCreateBtn();
    const sx = window.scrollX, sy = window.scrollY, bw = 112;
    let x = rect.left + sx + rect.width / 2 - bw / 2;
    let y = rect.bottom + sy + 9;
    x = Math.max(sx + 4, Math.min(x, sx + window.innerWidth - bw - 4));
    btn.style.left = `${x}px`;
    btn.style.top  = `${y}px`;
    btn.classList.add('visible');
  }

  function hideBtn() { floatingBtn?.classList.remove('visible'); }

  function onBtnClick() {
    const text = lastText;
    if (!text) return;
    hideBtn();
    translateInSidebar(text);
  }

  // ── Selection listener ─────────────────────────────────────────────────────
  document.addEventListener('mouseup', async e => {
    if (e.target.closest('#__lens-floating-btn__') ||
        e.target.closest('#__lens-sidebar-frame__')) return;

    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(async () => {
      const sel  = window.getSelection();
      const text = sel?.toString().trim();
      if (text && text.length > 3 && sel.rangeCount > 0) {
        if (!floatingBtnEnabled) return;
        const range = sel.getRangeAt(0);
        const rect  = range.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) showBtn(rect, text);
      } else {
        hideBtn();
      }
    }, 180);
  });

  document.addEventListener('mousedown', e => {
    if (e.target.closest('#__lens-floating-btn__') ||
        e.target.closest('#__lens-sidebar-frame__')) return;
    hideBtn();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') hideBtn();
  });

  // ── Page scanning ──────────────────────────────────────────────────────────
  function filterScanElements(elements, seen) {
    return elements.filter(el => {
      const text = (el.innerText || '').trim();
      if (text.length < 2) return false;
      if (el.closest('#__lens-floating-btn__, #__lens-sidebar-wrapper__')) return false;
      if (el.closest('code, pre, script, style, noscript, svg, footer')) return false;
      const role = el.getAttribute('role');
      if (role && SKIP_ROLES.has(role)) return false;
      if (CONTAINER_TAGS.has(el.tagName)) {
        const hasBlockChild = Array.from(el.children).some(c => BLOCK_CHILDREN.has(c.tagName));
        if (hasBlockChild) return false;
      }
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.1) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 10) return false;
      if (seen.has(text)) return false;
      seen.add(text);
      return true;
    });
  }

  function scanPage() {
    clearScan();
    const seen = new Set();
    const usable = filterScanElements(
      Array.from(document.body.querySelectorAll(SCAN_SELECTOR)), seen
    );
    usable.forEach((el, i) => {
      el.setAttribute('data-lens-chunk', String(i));
      el.classList.add('__lens-chunk__');
      el.addEventListener('click', onPageChunkClick);
      scanChunks.push({ id: i, element: el });
    });
    return scanChunks.map(c => ({ id: c.id, text: (c.element.innerText || '').trim() }));
  }

  function scanPageNewOnly() {
    const seen = new Set();
    const nextId = scanChunks.length;
    const newChunks = [];
    const untagged = Array.from(document.body.querySelectorAll(SCAN_SELECTOR))
      .filter(el => !el.hasAttribute('data-lens-chunk'));
    filterScanElements(untagged, seen).forEach(el => {
      const id = nextId + newChunks.length;
      el.setAttribute('data-lens-chunk', String(id));
      el.classList.add('__lens-chunk__');
      el.addEventListener('click', onPageChunkClick);
      scanChunks.push({ id, element: el });
      newChunks.push({ id, text: (el.innerText || '').trim() });
    });
    return newChunks;
  }

  function clearScan() {
    stopWatchingForNewContent();
    if (originalNodeMap.size > 0) {
      revertInPlace();
    }
    scanChunks.forEach(({ element }) => {
      element.removeAttribute('data-lens-chunk');
      element.classList.remove('__lens-chunk__', '__lens-chunk-active__', '__lens-in-place__');
      element.removeEventListener('click', onPageChunkClick);
    });
    scanChunks = [];
    originalNodeMap.clear();
  }

  function onPageChunkClick(e) {
    if (!scanChunks.length) return;
    const id = parseInt(e.currentTarget.getAttribute('data-lens-chunk'), 10);
    if (isNaN(id)) return;
    setActiveChunk(id);
    // Notify sidebar if open, otherwise try background
    if (sidebarPort) {
      sendToSidebar({ type: MSG.LENS_CHUNK_CLICKED, chunkId: id });
    } else {
      chrome.runtime.sendMessage({ type: MSG.CHUNK_CLICKED, chunkId: id }).catch(() => {});
    }
  }

  function setActiveChunk(id) {
    document.querySelectorAll('.__lens-chunk-active__').forEach(el =>
      el.classList.remove('__lens-chunk-active__'));
    const chunk = scanChunks.find(c => c.id === id);
    if (chunk) {
      chunk.element.classList.add('__lens-chunk-active__');
      chunk.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // ── In-place translation ───────────────────────────────────────────────────
  function applyInPlace(translations) {
    translations.forEach(({ id, translated }) => {
      const normalizedId = Number(id);
      if (!Number.isFinite(normalizedId)) return;
      const chunk = scanChunks.find(c => c.id === normalizedId);
      if (!chunk) return;
      if (!originalNodeMap.has(normalizedId)) originalNodeMap.set(normalizedId, cloneChildNodes(chunk.element));
      // Replace text nodes only — preserves <a> hrefs, <img> tags, and all attributes
      replaceTextNodes(chunk.element, translated);
      chunk.element.classList.add('__lens-in-place__');
    });
  }

  // Replace visible text in an element while preserving all HTML structure (links, imgs, etc.)
  function replaceTextNodes(el, translated) {
    // Collect ALL text nodes in the subtree (depth-first)
    const allTextNodes = [];
    const walk = node => {
      node.childNodes.forEach(child => {
        if (child.nodeType === Node.TEXT_NODE) {
          if (child.textContent.trim().length > 0) allTextNodes.push(child);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          // Don't descend into script/style
          if (!['SCRIPT','STYLE','NOSCRIPT'].includes(child.tagName)) walk(child);
        }
      });
    };
    walk(el);

    if (allTextNodes.length === 0) return; // nothing to replace

    // Put the full translation in the first text node, blank the rest
    // This keeps all <a> tags, <img> tags etc. intact
    allTextNodes[0].textContent = translated;
    for (let i = 1; i < allTextNodes.length; i++) {
      allTextNodes[i].textContent = '';
    }
  }

  function cloneChildNodes(el) {
    return Array.from(el.childNodes, node => node.cloneNode(true));
  }

  function revertInPlace() {
    originalNodeMap.forEach((nodes, id) => {
      const normalizedId = Number(id);
      const chunk = scanChunks.find(c => c.id === normalizedId);
      const targetEl = chunk?.element || document.querySelector(`[data-lens-chunk="${normalizedId}"]`);
      if (targetEl) {
        targetEl.replaceChildren(...nodes.map(node => node.cloneNode(true)));
        targetEl.classList.remove('__lens-in-place__');
      }
    });
    originalNodeMap.clear();
  }

  // ── New content detection (for Scan More) ────────────────────────────────────
  let _watchDebounceTimer = null;

  function startWatchingForNewContent() {
    stopWatchingForNewContent();

    newContentObserver = new MutationObserver(() => {
      // Check if there are any elements with text that don't have data-lens-chunk yet
      clearTimeout(_watchDebounceTimer);
      _watchDebounceTimer = setTimeout(() => {
        const hasNew = hasUntranslatedContent();
        if (hasNew && sidebarPort) {
          sendToSidebar({ type: MSG.LENS_NEW_CONTENT_AVAILABLE });
        }
      }, 800); // debounce — wait for dynamic content to settle
    });

    newContentObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function stopWatchingForNewContent() {
    clearTimeout(_watchDebounceTimer);
    _watchDebounceTimer = null;
    if (newContentObserver) {
      newContentObserver.disconnect();
      newContentObserver = null;
    }
  }

  function hasUntranslatedContent() {
    // Quick check: are there visible text-bearing elements without data-lens-chunk?
    const candidates = document.querySelectorAll('p, h1, h2, h3, h4, li, a, span, div, button');
    for (const el of candidates) {
      if (el.hasAttribute('data-lens-chunk')) continue;
      if (el.closest('#__lens-floating-btn__, #__lens-sidebar-wrapper__')) continue;
      if (el.closest('code, pre, script, style, noscript, svg, footer')) continue;
      const text = (el.innerText || '').trim();
      if (text.length < 2) continue;
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      return true;
    }
    return false;
  }

  // ── Messages from popup/background ────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        switch (msg.type) {
          case MSG.SCAN_PAGE:        sendResponse({ chunks: scanPage() }); break;
          case MSG.SCAN_MORE_PAGE:   sendResponse({ chunks: scanPageNewOnly() }); break;
          case MSG.HIGHLIGHT_CHUNK:  setActiveChunk(msg.chunkId); sendResponse({ ok: true }); break;
          case MSG.CLEAR_SCAN:       clearScan(); sendResponse({ ok: true }); break;
          case MSG.APPLY_IN_PLACE:   applyInPlace(msg.translations); sendResponse({ ok: true }); break;
          case MSG.REVERT_IN_PLACE:  revertInPlace(); sendResponse({ ok: true }); break;
          case MSG.GET_SELECTION:    sendResponse({ text: window.getSelection()?.toString().trim() || '' }); break;
          case MSG.TOGGLE_SIDEBAR:   toggleSidebar(); sendResponse({ ok: true }); break;
          case MSG.CLOSE_SIDEBAR:
            if (msg.viewMode) viewMode = msg.viewMode;
            closeSidebar();
            updateSidebarToggleTab();
            sendResponse({ ok: true });
            break;
          case MSG.OPEN_SIDEBAR_WITH_PENDING:
            translateInSidebar(msg.text);
            sendResponse({ ok: true });
            break;
          default: sendResponse({ ok: false });
        }
      } catch (err) { sendResponse({ error: err.message }); }
    })();
    return true;
  });

  initSidebarToggleTab();
  initFloatingButtonPreference();

})();
