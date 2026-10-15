# Privacy policy — Jev for Chrome

Last updated: 2026-10-14

Jev for Chrome is a browser extension that automates the tab you point it at, using a decision model (TypeSafe Jev or OpenAI Decisions) and a small text model that you configure yourself. It is a community project, not affiliated with TypeSafe or Browser Use.

## What the extension does with data

- **No page observation until you start a run.** The extension reads a tab only after you submit a goal through Run, Step, or a transcribed voice task, and only on that tab.
- **During a run, each decision cycle sends requests to the decision provider you chose** (OpenRouter, TypeSafe, Cloudflare Workers AI or OpenAI Decisions). These requests contain: your goal, the current tab's URL, title and visible text (up to 6,000 characters), the list of interactive elements with their labels, current values and link targets, and the last ten actions taken.
- **Tab awareness sends titles, URLs, and identifiers of open normal HTTP(S) tabs to the selected decision provider** so it can choose an existing tab or open a new one. Internal browser pages and incognito tabs are excluded from this list. Background tabs’ page contents are not read unless the run switches to them.
- **When the model decides to type into a field, one request goes to the text model you chose** (OpenRouter, DeepSeek or an OpenAI-compatible endpoint) with the goal, the field's label and the same page text.
- **Starting from a new, blank, or internal browser tab first sends your goal, the current tab URL, and eligible open-tab metadata to the decision provider.** No internal page contents are read. The decision model can switch directly to an existing tab without a text-helper call. Only when it chooses **OPEN_TAB** is your goal sent to the text helper to select an HTTP(S) starting URL. The extension then navigates a blank/new tab or opens a separate task tab for other internal pages, before reading the web page or attaching the debugger.
- **Voice tasks capture microphone audio only after you invoke the shortcut or microphone button.** A visible panel shows recording status and a live waveform. Sending the recording uploads it to OpenAI’s `gpt-4o-mini-transcribe` transcription endpoint; the returned transcript becomes the task goal. Escape or Cancel during recording discards it without uploading. During transcription, cancelling aborts the request and prevents its transcript from starting a task. Recordings are capped at two minutes.
- **Password fields are never read or filled.** Browser internal pages are never observed. Chrome new-tab pages and `about:blank` are navigated to a regular page; other internal pages remain open while the extension creates a separate task tab.
- **Nothing is sent anywhere else.** There is no telemetry, no analytics, no crash reporting and no server operated by the author.

## What is stored, and where

- Your API keys and settings are stored in `chrome.storage.local` on your device only. They are sent solely to the provider they belong to, as an authorization header. An empty helper key may reuse the matching OpenRouter key or, for the official OpenAI endpoint only, the OpenAI Decisions key. Custom compatible endpoints require their own helper key.
- Recordings are held only in the extension recorder’s memory. They are deleted after a successful handoff or cancellation; a failed transcription may be retried until you cancel. Audio is not saved to browser storage or disk.
- The latest five task traces are saved in `chrome.storage.local`, with a size limit of 1.2 MB per run. They include goals, page observations, open-tab metadata, model inputs and answers, generated text, execution checks, errors, and timings. API headers are never recorded; configured API keys are redacted from diagnostic text. Audio and private model reasoning are not included. Large inputs or responses can be omitted to fit the limit, with a visible notice. **Run history** lets you inspect, export, or delete them; exports are created only when you click **Export JSON**. "Copy trace" in the popup copies the current activity log only when clicked. Nothing is uploaded by the history page.
- **Open JSON** reads the export you select into the history page's memory for inspection. It does not save it to run history, replay browser actions, or send it to a model. Closing the file or the page discards the imported view.

## Third parties

The providers you configure process the data described above under their own terms and privacy policies: [OpenRouter](https://openrouter.ai/privacy), [TypeSafe](https://typesafe.ai), [Cloudflare](https://www.cloudflare.com/privacypolicy/), [DeepSeek](https://platform.deepseek.com), [OpenAI](https://developers.openai.com/api/docs/guides/your-data), or whichever OpenAI-compatible endpoint you enter. The author has no access to that data.

## Permissions

- `activeTab`, `tabs`, `scripting` and the `<all_urls>` host permission: needed to read the tab you started a run on, to inject the page script that executes clicks and typing, and to follow a link that opens a new tab. They are not used on other tabs.
- `offscreen`: to capture microphone audio and compute its waveform in an extension document. Chrome separately asks for microphone access in a visible extension setup window.
- `storage`: to keep your settings, keys, and the latest five task traces on your device.
- `debugger`: to send the clicks and keystrokes of a run to that tab through Chrome's DevTools protocol, so the page receives real user input. It is attached only while a run is active on that tab and detached when the run ends. Nothing is read through it. Chrome shows a "started debugging" bar on the tab while it is attached; you can turn the feature off in Options (Chrome does not allow this permission to be optional).

## Contact

Questions and issues: https://github.com/chy4pro/jev-for-chrome/issues
