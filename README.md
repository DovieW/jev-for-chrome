<p align="center"><img src="assets/logo.png" width="96" alt="Jev for Chrome"></p>

<h1 align="center">Jev for Chrome</h1>

<p align="center">
  <a href="https://github.com/chy4pro/jev-for-chrome/actions/workflows/check.yml"><img src="https://github.com/chy4pro/jev-for-chrome/actions/workflows/check.yml/badge.svg" alt="check"></a>
  <a href="https://chromewebstore.google.com/detail/jev-for-chrome/eilccpbbmfhmlkgfbmkjjffdhcemdbig"><img src="https://img.shields.io/chrome-web-store/v/eilccpbbmfhmlkgfbmkjjffdhcemdbig?label=Chrome%20Web%20Store" alt="Chrome Web Store"></a>
  <a href="https://github.com/chy4pro/jev-for-chrome/releases"><img src="https://img.shields.io/github/v/release/chy4pro/jev-for-chrome?display_name=tag" alt="release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/chy4pro/jev-for-chrome" alt="license"></a>
</p>

A Chrome extension that drives the tab you are looking at with [TypeSafe Jev](https://typesafe.ai), a decision model that picks the next click, keystroke or dropdown value in a few hundred milliseconds instead of generating text. It is a Manifest V3 port of [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast): same observation format, same questions, same execution rules. Community project, not affiliated with TypeSafe or Browser Use.

You can also select **OpenAI Decisions (GPT-6 Luna)** to choose actions directly through OpenAI, using the same browser observation and execution loop.

[English](README.md) | [简体中文](README_CN.md)

![Google Flights, one-way Zurich to London on September 20 2026, driven by the extension in headless Chromium at real speed](docs/demo.gif)

*One goal typed into the popup. Ten decisions, about thirteen seconds, recorded at real speed by the test harness ([webm](docs/demo.webm)); the numbered badges are the elements the model could see.*

## Why an extension

- **Your browser, your sessions.** It runs in the tab you already have open, with your cookies and logins, on your normal Chrome profile. Nothing to install besides the extension; no Python, no Playwright, no second browser.
- **Sites that turn away automated browsers are not a problem.** In a datacenter headless browser the test suite is stopped by Cloudflare's "verify you are human" page on several sites; the same pages open normally in a real Chrome profile, and the model just sees the page.
- **Watch it and step it.** Badges show what the model sees, a status bar shows the decision and its latency, **Step** executes one decision at a time, **Copy trace** exports the run for a bug report.
- **Same policy as the reference, and a few things it does not do yet.** Links that open new tabs are followed, wrapped links are clicked where they render, controls hidden under other blocks are not offered, and two independent probability checks veto a premature DONE.

| | Jev for Chrome | jev-ultrafast | jev-browser (jkudish) | browser-use |
|---|---|---|---|---|
| Runs in | your own Chrome tab and profile | a Chrome tab owned by Browser Harness (CDP) | a Playwright browser | Playwright or Browser Use cloud |
| Runtime you need | Chrome | Python, uv, Browser Harness | Node | Python |
| Who decides each step | Jev: operation + element in one request | Jev: operation + element in one request | Jev picks the action; goal/stuck checks | an LLM |
| Who writes typed text | small text model | small text model | text model or heuristic | the LLM |

Descriptions of the other projects are taken from their READMEs in September 2026.

## How it works

1. The content script reads the visible page: every interactive element gets a code-owned index, a role, an accessible name and its current value. Visible text is captured up to 6,000 characters. No screenshots.
2. The background worker sends one request to Jev with the goal, the element table and recent actions. Jev answers two questions at once: which operation (`CLICK`, `TYPE_TEXT`, `SELECT`, `SCROLL_*`, `WAIT`, `DONE`, `BLOCKED`) and, for each operation, which element. Only the target head of the chosen operation is used.
3. If the operation is `TYPE_TEXT`, a small chat model (DeepSeek, Gemini, anything OpenAI-compatible) turns the goal and field context into the exact string to type. The extension never guesses field values itself.
4. The page prepares the target (still fresh, scrolled into view, stopped moving, not covered) and the input is dispatched through Chrome's DevTools protocol, so the page receives a real click or keystroke, as from a mouse and keyboard. That is how nanobrowser, Taxy and browser-use drive pages; it needs the `debugger` permission (Chrome does not allow it to be optional), and it can be switched off in Options, in which case synthetic DOM events are used. A click is dispatched once. Enter is never pressed implicitly: when a focused text field holds text, a separate `PRESS_ENTER` control is offered and the model has to choose it (this is the one addition to the reference action space; sites like arXiv and Wolfram Alpha have no submit button).

Jev has no memory between calls, so everything it needs is in the `state` of each request: the task; the current URL, title and visible text; every element with its role, current value, link target (`href`) and the heading it sits under (`section`); the recent actions with what each one visibly did ("navigated to …", "page content changed", "no visible change"); and the URLs visited so far. The rules reference these fields by name, as the TypeSafe docs recommend.

The same request also asks two independent yes/no questions: is the task already achieved on this page, and are the recent actions stuck? They are answered without seeing the action choice, so they act as an honest cross-check: a DONE the goal check does not support (below 50%) is withheld once and the model is told what is still missing; a BLOCKED the stuck check does not support is treated the same way. The popup shows both probabilities on every step, and **Copy trace** puts the whole run on the clipboard as JSON for bug reports.

Jev returns a probability over the offered candidates, so every step in the popup shows what the model considered and how sure it was. Answers are validated strictly: an unknown candidate or an inconsistent distribution (beyond the provider's two-decimal rounding) is asked once more, then stops the run rather than being "repaired". A control that is chosen three times within six steps, even when each click changes the page (a menu that opens and closes), ends the run as BLOCKED after the model has been warned.

## Results

Every task below was run through the built extension in headless Chromium (real service worker, content script, popup) with OpenRouter. Tasks come from this extension's popup, from the reference project, from demos people posted on X (Steve Krouse's jev + kernel playground, jkudish/jev-browser, Vlad Terin's Codex adapter) and from WebVoyager-style sites. "Result" is an independent check of the final URL or page text, not the model's DONE. Full traces of the recorded run: [docs/e2e-suite-2026-09-19.md](docs/e2e-suite-2026-09-19.md).

| Source | Task | Result | Steps | Time |
|---|---|---|---|---|
| Popup | Google Flights, one-way Zurich → London, Sep 20 2026 | ✅ | 14 | 21 s |
| Popup | Wikipedia: search Taylor Swift, open Early life | ✅ | 3 | 9.6 s |
| Popup | Add the highest-rated product to the cart (OpenCart demo) | ✅ | 5 | 6.8 s |
| Reference | Wikipedia: open Gödel's incompleteness theorems | ✅ | 2 | 5.0 s |
| X / Krouse | Wikiracing: Rubber duck → Eiffel Tower, links only | ✅ | 2 | 6.3 s |
| X / Krouse | Hacker News: open comments of the top story | ✅ | 1 | 2.0 s |
| X / Krouse | Val Town: find the Airtable API examples | ❌ | 3 | 7.3 s |
| X / jev-browser | Wikipedia: Coffee → Espresso | ✅ | 1 | 3.2 s |
| X / jev-browser | GitHub: open the newest browser-use release | ✅ | 2 | 5.2 s |
| X / jev-browser | Wikipedia: search Ristretto, stop on the article | ❌ | 0 | 5.5 s |
| X / Terin | Python docs: open the tutorial's Data Structures chapter | ❌ | 1 | 5.6 s |
| WebVoyager-style | Wiktionary: look up serendipity | ✅ | 3 | 12.5 s |
| WebVoyager | arXiv: search "Attention Is All You Need", open the abstract | ❌ | 6 | 22.4 s |
| WebVoyager | Hugging Face: open openai/whisper-large-v3 | ✅ | 3 | 10.7 s |
| WebVoyager | Wolfram Alpha: derivative of x³ sin x | ✅ | 4 | 8.3 s |
| WebVoyager-style | Wikibooks Cookbook: open the banana bread recipe | ✅ | 3 | 7.4 s |
| WebVoyager | BBC: open the technology section | ✅ | 1 | 2.7 s |

13 of 17 in this run; across seven rounds the same suite scored 9, 10, 11, 14, 13, 13 and 13 while executor and loop bugs were being fixed, and individual tasks flip between runs. The misses in this run:

- **Ristretto** and **Python docs**: the text model behind OpenRouter answered HTTP 429 (rate limited) on the first TYPE_TEXT; both passed in earlier rounds. Transient statuses are now retried three times with longer backoff.
- **Val Town**: the hop to docs.val.town ends on a browser error page in this headless environment, where no content script can run.
- **arXiv**: the model had the results' `href`s and the "sort by relevance" dropdown and still paged through date-sorted results, then opened a 2026 paper with the same title. A model decision, not missing context.

The cart task failed in six rounds before this one for an executor reason worth knowing: after sorting, that shop keeps the old product cards in the DOM underneath the new list. They passed every visibility check, so the model kept being offered a link nobody could click. The observer now hit-tests every control and drops the ones another block covers. Google Flights in the Chinese interface (`hl=zh-CN`, locale zh-CN) also completes, in 10 steps; its one premature DONE, before the results had loaded, was vetoed by the goal check.

Sites behind Cloudflare's "verify you are human" page (Cambridge Dictionary, Allrecipes, demo.nopcommerce.com, demo.opencart.com) stop at that page in a headless datacenter browser; the model correctly reports BLOCKED there. `E2E_TASKS=scripts/e2e-tasks.json npm run e2e:ext` reproduces the table.

## Install

**From the Chrome Web Store** (recommended): install [Jev for Chrome](https://chromewebstore.google.com/detail/jev-for-chrome/eilccpbbmfhmlkgfbmkjjffdhcemdbig), then [configure](#configure) a model key. The install prompt asks to *read and change all your data on all websites* (a run can be started on any site, and the extension has to read and act on that page) and for the page debugger (trusted input: clicks and keystrokes go through Chrome's DevTools protocol, and Chrome shows a "started debugging this browser" bar while clicks or keystrokes are dispatched). What is read and where it is sent: [What leaves your browser](#what-leaves-your-browser) and [docs/PRIVACY.md](docs/PRIVACY.md).

Each version goes through Chrome's review before the store serves it, so the store can be a version behind the Releases page; the store badge at the top shows the version it serves.

**From a release**: on the [Releases page](https://github.com/chy4pro/jev-for-chrome/releases), under **Assets**, download `jev-for-chrome-extension-<version>.zip` (not **Source code**). Unzip it, open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick the unzipped folder: the one that directly contains `manifest.json`.

If Chrome says *Manifest file is missing or unreadable*, the folder you picked has no `manifest.json` at its top level. Usually that is the **Source code** download, which is the repository: its manifest is in `public/` and it has to be built first (see below). Releases up to 1.5.3 named the asset `jev-for-chrome-<version>.zip`, the same name GitHub gives the source archive, so the two unzipped to the same folder name.

**From source**:

```bash
git clone https://github.com/chy4pro/jev-for-chrome.git
cd jev-for-chrome
npm install
npm run build
```

Then load the `dist/` folder the same way.

## Configure

Open the extension's Options page.

**Decision provider** (pick one; OpenRouter remains the default):

| Provider | Endpoint | Model |
|---|---|---|
| OpenRouter | `https://openrouter.ai/api/alpha/decisions` | `typesafe/jev-1.13` |
| TypeSafe.ai | `https://api.typesafe.ai/v1/systemone` | `jev-latest` |
| Cloudflare Workers AI | `https://api.cloudflare.com/client/v4/accounts/{id}/ai/run` | `typesafe/jev` |
| OpenAI Decisions | `https://api.openai.com/v1/decisions` | `gpt-6-luna` |

**Text helper** (field text and new-tab starting URLs): OpenRouter, DeepSeek direct, OpenAI, or any OpenAI-compatible base URL. Selecting OpenAI fills in `gpt-6-luna`; explicitly saved models are preserved. If the helper uses OpenRouter or the official OpenAI endpoint, its key can be left empty when the matching decision-provider key is set. Custom endpoints require their own helper key.

For official OpenAI text requests, choose **Standard** (default) or **Fast (Priority)** processing. Priority is faster and costs more; the setting applies to field text and starting URLs. OpenAI requests use `max_completion_tokens`; Luna text requests disable reasoning for these short outputs.

The [OpenAI Decisions API](https://developers.openai.com/api/docs/guides/decisions) is a separate decision model from TypeSafe Jev. The adapter sends named choice and predicate questions, translates the answer distributions, and rejects malformed or refused answers before acting. A target with only one candidate is selected locally.

**Runtime**: max steps per run, delay between steps, and whether to draw the numbered badges on the page.

The **Test** button on each provider sends a tiny real request and shows the answer, so you can check a key before starting a run.

## Use

Click the toolbar icon, type a goal, press **Run**. **Step** executes exactly one action so you can watch decisions one at a time; **Stop** aborts. Optional **Page labels** show numbered badges on selectable controls; they are off by default.

On a new, blank, or internal browser page, the decision model first receives your goal and the open web tabs' titles and URLs. It can choose **SWITCH_TAB** to reuse a relevant tab without calling the text helper. Only an explicit **OPEN_TAB** decision asks the helper for a starting URL. The extension then navigates the current blank/new tab, or opens a separate web tab from an internal page such as `chrome://extensions`, preserving that internal page. This counts as one action: **Step** pauses after navigation; **Run** continues automatically. No internal page content is observed. Decision failures never fall back to the helper, and missing helper keys or invalid URLs leave the tab unchanged.

**Voice tasks:** press **Ctrl+Shift+Space** (**Command+Shift+Space** on macOS) to open the bottom-center recording panel. Press the shortcut again or click **Send task** to transcribe and run your spoken goal. **Escape** cancels without sending an unfinished recording. The microphone button in the popup opens the same panel. Chrome requests microphone permission once through an extension setup window. Change the shortcut at `chrome://extensions/shortcuts`; Settings → Behavior shows its current assignment. Voice transcription uses `gpt-4o-mini-transcribe` and reuses the official OpenAI text-helper key, falling back to the official OpenAI Decisions key. Audio stays in memory and is discarded after success or cancellation; failed uploads can be retried. Recordings are limited to two minutes. Starting voice capture on an internal browser page opens a separate Google tab first.

During a run, Jev sees the titles and URLs of open normal web tabs. It can **SWITCH_TAB** to a relevant existing tab or **OPEN_TAB** when the task belongs elsewhere and no suitable tab is open. Opening a task tab preserves your source page. Startup uses the same decision model to select an existing tab or request a new destination. Only the chosen tab’s page content is observed. OpenAI Decisions selects the operation first, then requests only that operation’s target.

**Run history:** open **Settings → Run history** or the history icon in the popup. The latest five tasks are saved locally, including failed and stopped runs. The default **Model calls** view puts each actual API request beside its response: the exact goal, page text, searchable controls and tabs, instructions, offered choices, model parameters, returned probabilities, helper messages, token usage, and request latency. It distinguishes model confidence from option probability, and model answers from targets selected locally by the extension. HTTP success and extension processing failures are shown separately. **Raw JSON** retains the saved request and response bodies, with credentials redacted. Failed HTTP attempts also retain bounded response bodies for diagnosis.

Use **Execution trace** for the full decision path, including prepared inputs, page observations, browser actions, retries, and local checks. Parent timings include nested requests; the latency breakdown counts them once. **Issues only** highlights failures and reconsidered choices. Export a run as JSON or use **Open JSON** to inspect an existing export locally in memory, without modifying saved history or replaying actions. Duplicate page observations and prepared states are omitted before actual API bodies when storage fills. API bodies can still be omitted if they alone exceed the limit; the page marks these omissions and missing responses. Runs interrupted by an extension restart retain their last saved events. Missing events and responses in older exports cannot be reconstructed.

Runs stop on `DONE`, on `BLOCKED`, after three consecutive actions that changed nothing on the page, when the step budget is exhausted, or on any provider error. A `DONE` or `BLOCKED` given with less than 50% confidence is asked once more after the page settles before it counts. Contradictory or alternating verdicts get only one reconsideration without an action, then stop with an explicit diagnostic instead of looping. A covered target is reported back to the model and withheld after two attempts while alternatives remain. When the text helper returns `{"text":null}`, nothing is typed: that typing target is excluded until the page changes, and the decision model receives feedback to choose another action. Run continues automatically; Step pauses for the next decision. Four consecutive field rejections stop with a request for a more specific goal. Malformed replies and API failures still stop as errors. `DONE` is the model's opinion, not proof; check the page.

## What leaves your browser

The full statement is in [docs/PRIVACY.md](docs/PRIVACY.md).

Each step sends one request to the decision provider you chose (OpenRouter, TypeSafe, Cloudflare or OpenAI Decisions) containing: your goal, the current tab's URL, title and visible text (up to 6,000 characters), the table of interactive elements with their labels, current values and link targets, and the last ten actions. When the model decides to type, one request goes to the text model with the goal, the field and the same page text. When the decision model requests a starting URL, that helper request sends only your goal. Sending a voice task uploads the recorded microphone audio to OpenAI for transcription; its transcript becomes your goal. Cancelled recordings are discarded. There is no telemetry. API keys stay in `chrome.storage.local` on your machine. Password fields are never read or filled. Internal browser pages are never observed; starting a run there opens a separate web tab. The `<all_urls>` permission exists because the extension has to read the tab you point it at; page observation is limited to the run’s tab, and the voice panel appears only when you invoke recording. The `debugger` permission is used only to send clicks and keystrokes to the run's tab through the DevTools protocol; Chrome shows a "started debugging" bar on that tab while clicks or keystrokes are dispatched, and nothing is read through it.

## What is and isn't handled

Works: links, buttons, text inputs, textareas, contenteditable, native `<select>`, checkboxes and radios that are actually rendered, ARIA roles (`button`, `link`, `combobox`, `option`, `tab`, `menuitem`, ...), autocomplete lists, in-page and cross-page navigation, scrolling, and links that open a new tab: the agent follows the tab its click opened, continues there, and returns to the opener if that tab is closed.

Not handled: elements inside shadow roots or iframes, canvas UIs, file uploads, drag and drop, keyboard-only widgets, and natively hidden checkboxes/radios styled through their label (the model cannot see them). Password fields are never observed or filled. Internal browser pages are not observed. New-tab pages navigate to a regular page; other internal pages open a separate task tab. Hover-only layers inside a product card are clicked through; anything under a dialog or page-wide overlay is not. Hover-only menus open under trusted input, since the pointer really moves there.

Same policy and same boundaries as the reference implementation; two websites do not prove general reliability.

## Built on jev-dev-kit

The strict answer validation, the request and answer types and the text helper's reply contract come from [jev-dev-kit](https://github.com/chy4pro/jev-dev-kit), a small framework extracted from this extension: Jev only chooses, candidates and text come through explicit providers, and the loop machinery is shared. This extension keeps the browser-specific parts: the element table, the rules, trusted input and tab handling.

## Roadmap

What comes next, including an MCP server so other agents can use Jev as their executor, is in [ROADMAP.md](ROADMAP.md).

## Development

The popup and Settings use local [shadcn/ui](https://ui.shadcn.com/) components, Radix primitives, and Lucide SVG icons. Shared colors and typography live in `src/ui/styles.css`. The existing Vite build compiles React, TypeScript, and Tailwind; there are no remote UI scripts or fonts.

```bash
npm run check      # typecheck + unit tests + production build
npm test           # vitest
npm run typecheck
npm run e2e:providers  # built extension, mocked OpenAI APIs and local pages
npm run e2e:voice      # synthetic microphone, real recorder/UI, local API mocks
```

Tests cover the action space and answer validation, provider adapters and retry policy, the text helper parser, DOM snapshot classification, the content script boot guard, the in-page executor (jsdom) and the agent loop (mocked `chrome`). They never call a paid API. `scripts/test_live_e2e.ts` runs two real requests when `OPENROUTER_API_KEY` is set.

### Running the built extension in a real browser

```bash
npx playwright install chromium          # once
npm run e2e:ext                          # smoke: boots everything, expects a clear missing-key error
OPENROUTER_API_KEY=... npm run e2e:ext   # full run with real decisions
```

The script loads `dist/` into Playwright's Chromium (new headless, no display needed), writes settings into `chrome.storage`, opens the options page, the popup and a real web page, runs the goal through the real service worker and content script, and writes `run.log` plus screenshots per step to `.e2e-out/`. Variables: `E2E_URL`, `E2E_GOAL`, `E2E_MAX_STEPS`, `E2E_OUT`, `CHROMIUM_PATH`. The popup accepts `?tabId=` so a test (or a detached window) can target a specific tab.

On a machine without root, fetch Chromium's missing shared libraries with `apt-get download`, extract them with `dpkg -x` and point `LD_LIBRARY_PATH` and `FONTCONFIG_FILE` at the result; that is how the container this was developed in runs it.

```
src/
  background/agent.ts        observe → decide → act loop, budgets, deadlock detection
  background/index.ts        message router, settings storage
  content/snapshot.ts        DOM observation, node identity cache, freshness guards
  content/executor.ts        stale-safe click / fill / select / scroll
  content/overlay.ts         badges and status bar
  shared/action-space.ts     element table, Jev questions, strict answer validation
  shared/text-helper.ts      TYPE_TEXT value generation
  shared/providers/          TypeSafe, OpenRouter, Cloudflare, OpenAI adapters
  popup/, options/           React + shadcn/ui screens
  components/ui/             Local shadcn components (Radix primitives)
  ui/styles.css              Shared neutral theme
public/manifest.json         MV3 manifest (copied into dist/)
```

## Keywords

browser agent, web agent, browser automation, chrome extension, manifest v3, typesafe jev, jev-1.13, system 1 model, non-autoregressive, decision model, openrouter decisions api, cloudflare workers ai, browser-use, jev-ultrafast, dom automation, ai agent, web automation, typescript, react, vite

## License

MIT
