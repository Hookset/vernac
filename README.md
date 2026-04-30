# Lens - Translator

A Firefox-first browser extension for translating text on any page. Paste text, translate selections, scan full pages, and optionally use your own DeepL key.

> Currently pending approval - available soon on the [Firefox Add-ons store](https://addons.mozilla.org/en-US/firefox/) · GPL v3 License

---

## Features

- **Paste mode** - paste or type text directly into the popup
- **Selection mode** - select text on a page and translate it from the floating Lens button
- **Scan Page mode** - extract readable page text and translate it chunk by chunk
- **Chunk mapping** - click translated chunks to highlight their source text on the page
- **In-place translation** - replace page text directly, with one-click revert
- **Context menu translation** - right-click selected text and choose **Translate with Lens**
- **Google Translate by default** - works without an account or API key
- **Optional DeepL support** - enter your own DeepL Free or Pro API key in settings
- **65+ languages** - includes auto-detect source language support
- **Sidebar or popup view** - choose how Lens opens from settings
- **Dark, light, and system themes** - shared across popup, sidebar, and settings
- **Local preferences** - target language, theme, font size, and view mode stay on your device

---

## Installation

### From the Firefox Add-ons store
Search for **Lens - Translator** on [addons.mozilla.org](https://addons.mozilla.org).

### Load locally (for development)

1. Clone or download this repo
2. Open Firefox and navigate to `about:debugging`
3. Click **This Firefox** -> **Load Temporary Add-on**
4. Select `manifest.json` from the project folder

### Chrome / Edge / Brave

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this folder

---

## Project structure

```text
lens-translator/
|-- manifest.json          # Extension manifest (MV3)
|-- background.js          # Context menu, toolbar state, and message routing
|-- content.js             # Floating button, page scanning, sidebar bridge, highlights
|-- content.css            # Styles injected into pages
|-- shared/
|   `-- messages.js        # Shared message constants
|-- popup/
|   |-- popup.html         # Popup/sidebar UI
|   |-- popup.css          # Main UI styles
|   |-- popup.js           # Translation, scan, settings, and sidebar logic
|   |-- settings.html      # Settings page
|   |-- settings.js        # Settings behavior
|   `-- theme-tokens.css   # Shared light/dark theme variables
|-- scripts/
|   `-- check-message-constants.ps1
`-- icons/                 # Extension icons
```

---

## How it works

Lens runs as a plain JavaScript browser extension with no build step.

- `content.js` detects selections, injects the floating button, scans page text, and manages the in-page sidebar
- `popup/popup.js` handles translation requests, scan output, chunk navigation, in-place replacement, and user preferences
- `background.js` owns the context menu, toolbar action state, and browser message routing
- `shared/messages.js` keeps message names consistent across extension contexts

By default, Lens uses Google's public translate endpoint. Users can switch to DeepL by saving their own API key in settings. DeepL keys are stored in browser session storage and clear when the browser closes.

---

## Privacy

- No analytics
- No tracking
- No account required
- Preferences are stored locally in browser storage
- DeepL keys are stored in session storage only
- Page text is sent only to the selected translation provider when you request translation

---

## Support

Lens is free, open source, and always will be. If it's useful to you, a small Bitcoin tip is appreciated but never expected.

**BTC:** `bc1qwfdml65sjj8gevakezxpeyex53q09sa2j8u2dh`

---

## License

GPL v3 - see [LICENSE](https://github.com/Hookset/lens-translator/blob/main/LICENSE)
