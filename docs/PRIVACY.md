# Privacy policy — Jev for Chrome

Last updated: 2026-10-14

Jev for Chrome is a browser extension that automates the tab you point it at, using a decision model (TypeSafe Jev or OpenAI Decisions) and a small text model that you configure yourself. It is a community project, not affiliated with TypeSafe or Browser Use.

## What the extension does with data

- **Nothing happens until you start a run.** The extension reads a tab only after you type a goal into its popup and press Run or Step, and only on that tab.
- **During a run, each step sends one request to the decision provider you chose** (OpenRouter, TypeSafe, Cloudflare Workers AI or OpenAI Decisions). That request contains: your goal, the current tab's URL, title and visible text (up to 6,000 characters), the list of interactive elements with their labels, current values and link targets, and the last ten actions taken.
- **When the model decides to type into a field, one request goes to the text model you chose** (OpenRouter, DeepSeek or an OpenAI-compatible endpoint) with the goal, the field's label and the same page text.
- **Starting from a new or blank tab sends only your goal to the configured text helper** to select an HTTP(S) starting URL. The extension navigates the same tab before reading it or attaching the debugger.
- **Password fields are never read or filled.** Browser internal pages are refused; Chrome new-tab pages and `about:blank` are navigated to a regular page before observation.
- **Nothing is sent anywhere else.** There is no telemetry, no analytics, no crash reporting and no server operated by the author.

## What is stored, and where

- Your API keys and settings are stored in `chrome.storage.local` on your device only. They are sent solely to the provider they belong to, as an authorization header. An empty helper key may reuse the matching OpenRouter key or, for the official OpenAI endpoint only, the OpenAI Decisions key. Custom compatible endpoints require their own helper key.
- Run logs (the decisions shown in the popup) are kept in memory while the extension's service worker is alive and are discarded afterwards. "Copy trace" puts a run on your clipboard only when you click it.

## Third parties

The providers you configure process the data described above under their own terms and privacy policies: [OpenRouter](https://openrouter.ai/privacy), [TypeSafe](https://typesafe.ai), [Cloudflare](https://www.cloudflare.com/privacypolicy/), [DeepSeek](https://platform.deepseek.com), [OpenAI](https://developers.openai.com/api/docs/guides/your-data), or whichever OpenAI-compatible endpoint you enter. The author has no access to that data.

## Permissions

- `activeTab`, `tabs`, `scripting` and the `<all_urls>` host permission: needed to read the tab you started a run on, to inject the page script that executes clicks and typing, and to follow a link that opens a new tab. They are not used on other tabs.
- `storage`: to keep your settings and keys on your device.
- `debugger`: to send the clicks and keystrokes of a run to that tab through Chrome's DevTools protocol, so the page receives real user input. It is attached only while a run is active on that tab and detached when the run ends. Nothing is read through it. Chrome shows a "started debugging" bar on the tab while it is attached; you can turn the feature off in Options (Chrome does not allow this permission to be optional).

## Contact

Questions and issues: https://github.com/chy4pro/jev-for-chrome/issues
