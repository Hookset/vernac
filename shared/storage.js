/* exported loadDeeplKey */
'use strict';

// Reads the DeepL API key from session storage, migrating it from local
// storage if it was saved there by an older version of the extension.
async function loadDeeplKey(localPrefs = {}) {
  try {
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
