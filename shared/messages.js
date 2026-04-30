/* exported MSG */
// Shared message type constants across all extension contexts.
// background.js keeps its own inline copy — importScripts is unreliable in MV3
// service workers — keep both in sync when adding new message types.
// All other contexts load this file directly: content_scripts entry in
// manifest.json (content.js) and <script> tags (popup.js, settings.js).
'use strict';

const MSG = {
  // ── Background ↔ content ──────────────────────────────────────────────────
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

  // ── Background ↔ popup / settings ────────────────────────────────────────
  OPEN_SETTINGS_TAB:  'OPEN_SETTINGS_TAB',
  SET_VIEW_MODE:      'SET_VIEW_MODE',
  SET_BADGE:          'SET_BADGE',
  CLEAR_BADGE:        'CLEAR_BADGE',
  SET_CONTEXT_MENU:   'SET_CONTEXT_MENU',

  // ── Sidebar channel management (content → background) ────────────────────
  CREATE_SIDEBAR_CHANNEL:    'CREATE_SIDEBAR_CHANNEL',
  GET_SIDEBAR_CHANNEL_SECRET:'GET_SIDEBAR_CHANNEL_SECRET',
  DELETE_SIDEBAR_CHANNEL:    'DELETE_SIDEBAR_CHANNEL',

  // ── Sidebar bridge (content ↔ popup via MessageChannel) ──────────────────
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
