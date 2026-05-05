/* exported loadDeeplKey */
'use strict';

// Reads the DeepL API key from the user's chosen storage location. Persistent
// local storage is only used when the user explicitly opts in.
async function loadDeeplKey(localPrefs = {}) {
  try {
    if (localPrefs.rememberDeeplKey === true && localPrefs.deeplKey) {
      await chrome.storage.session.set({ deeplKey: localPrefs.deeplKey });
      return localPrefs.deeplKey;
    }

    const session = await chrome.storage.session.get(['deeplKey']);
    if (session.deeplKey) return session.deeplKey;

    if (localPrefs.deeplKey) {
      await chrome.storage.session.set({ deeplKey: localPrefs.deeplKey });
      await chrome.storage.local.remove('deeplKey');
      return localPrefs.deeplKey;
    }
  } catch (e) {
    console.warn('[Vernac] session storage error', e);
  }
  return '';
}
