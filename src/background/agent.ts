import { buildJevRequest, validateChoiceAnswer } from '../shared/action-space';
import { activeJevModel, callJevProvider } from '../shared/providers';
import { createFieldContext, generateFieldText, generateStartingUrl, NoFieldValueError } from '../shared/text-helper';
import {
  ActResult,
  AgentProgress,
  ChoiceQuestion,
  AgentStepLog,
  AppSettings,
  DEFAULT_SETTINGS,
  PageAction,
  PageSnapshot,
  PrepareResult,
  RecentAction,
} from '../shared/types';
import { TrustedInput } from './input';
import { addBrowserActions, buildStartupRequest, BrowserTab } from '../shared/browser-tabs';
import { RunHistoryStore, RunRecorder } from './run-history';
import type { TraceSpan } from '../shared/trace';

/** Semantic fingerprint of an observation: URL, scroll, visible text and the element table. */
export function computePageFingerprint(snapshot: PageSnapshot): string {
  const semantics = snapshot.actions.map(({ rect, ...a }) => a);
  return JSON.stringify([snapshot.url, Math.round(snapshot.scroll.y), snapshot.text, semantics]);
}

interface PageSummary {
  url: string;
  title: string;
  textLength: number;
  scrollY: number;
  fingerprint: string;
}

const summarize = (s: PageSnapshot): PageSummary => ({
  url: s.url,
  title: s.title,
  textLength: s.text.length,
  scrollY: s.scroll.y,
  fingerprint: computePageFingerprint(s),
});

/** Describes, in words the model can use, what an action visibly did. */
export function describeOutcome(before: PageSummary, after: PageSummary): string {
  if (after.url !== before.url) return `navigated to ${after.url}`;
  if (after.title !== before.title) return `page changed: "${after.title}"`;
  if (Math.abs(after.textLength - before.textLength) > 50) return 'page content changed (something opened, closed or loaded; same URL)';
  if (Math.abs(after.scrollY - before.scrollY) > 40) return 'scrolled';
  if (after.fingerprint !== before.fingerprint) return 'minor change on the page';
  return 'no visible change';
}

/** DONE / BLOCKED are accepted only when the independent cross-check does not contradict them. */
const GOAL_DONE_MIN = 0.5;
const STUCK_MIN = 0.5;

/**
 * Errors Chrome raises when the page navigated (or its document was replaced) while a message
 * was in flight. The action itself ran; only the reply was lost.
 */
export function isNavigationError(message: string): boolean {
  return (
    /back\/forward cache/i.test(message) ||
    /message (channel|port) (is |was )?closed/i.test(message) ||
    /Receiving end does not exist/i.test(message) ||
    /Frame was removed/i.test(message) ||
    /Extension context invalidated/i.test(message)
  );
}

const OP_BY_KIND: Record<string, string> = { click: 'CLICK', fill: 'TYPE_TEXT', select: 'SELECT', scroll: '', wait: '', key: '' };

function readNoul(answer: any): number | undefined {
  const v = answer?.noul ?? answer?.probability;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined;
}

const INTERNAL_PREFIXES = ['chrome://', 'chrome-extension://', 'edge://', 'about:', 'view-source:', 'devtools://'];

/** Only blank/new-tab pages may be replaced without observing their contents. */
export function isStartingPage(url: string): boolean {
  return /^(?:chrome:\/\/(?:newtab|new-tab-page)\/?|about:blank)(?:[?#].*)?$/.test(url);
}

const MAX_CONSECUTIVE_STALE = 4;
/** DONE/BLOCKED below this confidence is confirmed by a second look before the run ends. */
const TERMINAL_CONFIRM_THRESHOLD = 0.5;
const DEADLOCK_RUN = 3;
/** Same target executed this many times within the last REPEAT_WINDOW actions ends the run. */
const REPEAT_LIMIT = 3;
const REPEAT_WINDOW = 6;

export class AgentRunner {
  private progress: AgentProgress = {
    status: 'idle',
    goal: '',
    currentStep: 0,
    maxSteps: DEFAULT_SETTINGS.maxSteps,
    logs: [],
  };

  private settings: AppSettings = DEFAULT_SETTINGS;
  private history: RecentAction[] = [];
  private activeTabId: number | null = null;
  /** The popup may keep targeting the original tab after bootstrap opens a task tab. */
  private startTabId: number | null = null;
  private runToken = 0;

  private lastFingerprint: string | null = null;
  private lastSummary: PageSummary | null = null;
  /** Tabs the run came from, most recent last, so a closed follow-up tab returns to its opener. */
  private tabStack: number[] = [];
  private pendingTab: { from: number; to: number; closed: boolean } | null = null;
  private tabNote: string | null = null;
  /** Trusted input via chrome.debugger; attached per run when the setting is on and permitted. */
  private input = new TrustedInput();
  /** Avoid repeating a failed attachment on every decision in a continuous run. */
  private inputAttemptedTab: number | null = null;

  private recorder?: RunRecorder;

  constructor(private runHistory = new RunHistoryStore()) {
    this.input.onCancelled = () => {
      if (this.progress.status !== 'running') return;
      this.stop();
      this.progress.lastError = 'Stopped: debugging was cancelled from the browser bar.';
      this.broadcastUpdate();
    };
    // A click may open a new tab (target=_blank, window.open). Like a person, the agent
    // follows it; when that tab closes it returns to the tab that opened it.
    try {
      chrome.tabs.onCreated.addListener((tab) => this.onTabCreated(tab));
      chrome.tabs.onRemoved.addListener((tabId) => this.onTabRemoved(tabId));
    } catch {
      // Not running inside an extension (unit tests without tab events)
    }
  }

  private onTabCreated(tab: chrome.tabs.Tab): void {
    if (this.progress.status !== 'running' || tab.id === undefined) return;
    if (this.activeTabId === null || tab.openerTabId !== this.activeTabId) return;
    this.tabStack.push(this.activeTabId);
    this.pendingTab = { from: this.activeTabId, to: tab.id, closed: false };
    this.activeTabId = tab.id;
  }

  private onTabRemoved(tabId: number): void {
    if (tabId !== this.activeTabId || this.tabStack.length === 0) return;
    const back = this.tabStack.pop()!;
    this.pendingTab = { from: tabId, to: back, closed: true };
    this.activeTabId = back;
  }

  /** Brings a newly opened (or restored) tab to the front and waits for it before observing. */
  private async followTab(): Promise<void> {
    const pending = this.pendingTab;
    if (!pending) return;
    this.pendingTab = null;
    this.lastFingerprint = null; // a different document: the previous action's outcome is "opened a tab"
    this.tabNote = pending.closed ? 'the tab closed; back on the previous tab' : 'opened a new tab and switched to it';
    await chrome.tabs.update(pending.to, { active: true }).catch(() => undefined);
    await this.waitForTabToLoad(pending.to);
    await this.attachInput(pending.to);
    this.sendStatus({ text: this.tabNote });
  }
  private startUrl = '';
  private visitedUrls: string[] = [];
  private consecutiveStale = 0;
  private decisionCount = 0;
  private targetFailureCount = new Map<string, number>();
  private unfillableTargetIds = new Set<string>();
  private lastTargetActionId: string | null = null;
  private lastStaleNotice: string | null = null;
  private pendingTerminal: string | null = null;
  private vetoed: 'DONE' | 'BLOCKED' | null = null;
  /** One inconsistent answer is asked again; a second one ends the run. */
  private invalidAnswerRetried = false;
  /** Text generated for a decision that turned out stale; reused only for an identical helper input. */
  private pendingText: { key: string; text: string } | null = null;

  public setSettings(settings: AppSettings): void {
    this.settings = settings;
    this.recorder?.addSecrets([settings.openai.apiKey, settings.openrouter.apiKey, settings.typesafe.apiKey, settings.cloudflare.apiToken, settings.textHelper.apiKey].map(key => key.trim()));
    if (this.progress.status !== 'running') {
      this.progress.maxSteps = settings.maxSteps || DEFAULT_SETTINGS.maxSteps;
    }
  }

  public getProgress(): AgentProgress {
    return this.progress;
  }

  private reset(goal: string, tabId: number): void {
    this.recorder?.finish('stopped', this.progress.currentStep, 'A new task was started.');
    this.recorder = new RunRecorder(this.runHistory, { goal, provider: this.settings.activeProvider, model: activeJevModel(this.settings), helperModel: this.settings.textHelper.model, maxSteps: this.settings.maxSteps }, [this.settings.openai.apiKey, this.settings.openrouter.apiKey, this.settings.typesafe.apiKey, this.settings.cloudflare.apiToken, this.settings.textHelper.apiKey].map(key => key.trim()));
    this.runToken++;
    this.activeTabId = tabId;
    this.startTabId = tabId;
    this.inputAttemptedTab = null;
    this.history = [];
    this.lastFingerprint = null;
    this.lastSummary = null;
    this.tabStack = [];
    this.pendingTab = null;
    this.tabNote = null;
    this.startUrl = '';
    this.visitedUrls = [];
    this.consecutiveStale = 0;
    this.decisionCount = 0;
    this.targetFailureCount.clear();
    this.unfillableTargetIds.clear();
    this.lastTargetActionId = null;
    this.lastStaleNotice = null;
    this.pendingTerminal = null;
    this.vetoed = null;
    this.invalidAnswerRetried = false;
    this.pendingText = null;
    this.progress = {
      status: 'running',
      runId: this.recorder.run.id,
      goal,
      currentStep: 0,
      maxSteps: this.settings.maxSteps || DEFAULT_SETTINGS.maxSteps,
      logs: [],
    };
  }

  public async start(goal: string, tabId: number): Promise<void> {
    if (this.progress.status === 'running') return;
    this.reset(goal, tabId);
    const token = this.runToken;
    this.broadcastUpdate();
    const recorder = this.recorder!;
    await this.loop(token);
    if (token === this.runToken) this.finalizeHistory();
    await recorder.flush();
  }

  /** Executes exactly one step. A new goal, or a finished run, starts over; a paused run continues. */
  public async step(goal: string, tabId: number): Promise<void> {
    if (this.progress.status === 'running') return;
    const continuing = this.progress.status === 'paused' && goal === this.progress.goal && (tabId === this.activeTabId || tabId === this.startTabId);
    if (!continuing) {
      this.reset(goal, tabId);
    } else {
      this.runToken++;
      this.progress.status = 'running';
      this.inputAttemptedTab = null;
    }
    const token = this.runToken;

    if (this.progress.currentStep >= this.progress.maxSteps) {
      this.finish('blocked', `Reached the ${this.progress.maxSteps}-step budget.`);
      this.finalizeHistory();
      return;
    }

    this.broadcastUpdate();
    const cont = await this.executeOneStep(token);
    if (token === this.runToken && this.progress.status === 'running') {
      this.progress.status = cont ? 'paused' : 'idle';
    }
    if (token !== this.runToken) return;
    if (this.progress.status !== 'running') void this.input.detach();
    this.finalizeHistory();
    this.broadcastUpdate();
    await this.recorder?.flush();
  }

  public stop(): void {
    this.recorder?.finish('stopped', this.progress.currentStep);
    this.runToken++;
    void this.input.detach();
    if (this.progress.status === 'running' || this.progress.status === 'paused') {
      this.progress.status = 'idle';
    }
    this.broadcastUpdate();
    this.sendStatus({ clear: true });
  }

  private async loop(token: number): Promise<void> {
    while (token === this.runToken && this.progress.status === 'running') {
      if (this.progress.currentStep >= this.progress.maxSteps) {
        this.finish('blocked', `Reached the ${this.progress.maxSteps}-step budget without DONE.`);
        break;
      }
      const cont = await this.executeOneStep(token);
      if (!cont) break;
      if (token === this.runToken && this.settings.stepDelayMs > 0) {
        const delay = this.recorder?.span('wait', 'Configured step delay', { delayMs: this.settings.stepDelayMs });
        await new Promise((resolve) => setTimeout(resolve, this.settings.stepDelayMs));
        delay?.end();
      }
    }
  }

  /** Resolves when the tab finishes loading, or after a timeout. */
  private async waitForTabToLoad(tabId: number, timeoutMs = 8000): Promise<void> {
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      };
      const listener = (updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
      };
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs
        .get(tabId)
        .then((tab) => {
          if (tab.status === 'complete') finish();
        })
        .catch(() => finish());
      setTimeout(finish, timeoutMs);
    });
    // Let the new document run its first frames before observing.
    await new Promise((r) => setTimeout(r, 150));
  }

  private lastPingError = '';

  private async readOpenTabs(trace: TraceSpan): Promise<BrowserTab[]> {
    return trace.measure('observe', 'Read open tabs', undefined, async () =>
      (await chrome.tabs.query({}) || [])
        .filter(tab => tab.id !== undefined && !tab.incognito && /^https?:/.test(tab.pendingUrl || tab.url || ''))
        .map(tab => ({ id: tab.id!, windowId: tab.windowId, title: (tab.title || '').slice(0, 160), url: tab.pendingUrl || tab.url || '' })));
  }

  /** Returns true when startup handled this cycle (including blocked/invalid decisions). */
  private async bootstrap(tabId: number, token: number, trace: TraceSpan): Promise<boolean> {
    const tab = await chrome.tabs.get(tabId);
    if (token !== this.runToken) return true;
    const originalUrl = tab.pendingUrl || tab.url || '';
    const replaceTab = isStartingPage(originalUrl);
    if (!replaceTab && !INTERNAL_PREFIXES.some((prefix) => originalUrl.startsWith(prefix))) return false;
    const started = Date.now();
    if (this.decisionCount >= this.progress.maxSteps * 2) {
      this.finish('blocked', 'Reached the model-call budget for this run.');
      return true;
    }
    const tabs = await this.readOpenTabs(trace);
    if (token !== this.runToken) return true;
    const { request, actionSpace, tabTargets } = buildStartupRequest(activeJevModel(this.settings), this.progress.goal, originalUrl, tabs, tabId, this.lastStaleNotice || undefined);
    this.lastStaleNotice = null;
    const decision = trace.child('decision', 'Choose starting tab or page', request);
    let response;
    try {
      this.decisionCount++;
      response = await callJevProvider(this.settings, request, decision);
      decision.end(response);
    } catch (error) {
      decision.fail(error);
      throw error;
    }
    if (token !== this.runToken) return true;
    let chosen;
    let matching: BrowserTab | undefined;
    try {
      chosen = validateChoiceAnswer(response.answers?.operation, actionSpace.operations);
      if (chosen.choice === 'SWITCH_TAB') {
        const target = validateChoiceAnswer(response.answers?.switch_tab_target, tabTargets);
        matching = tabTargets[target.choice];
      }
    } catch (error: any) {
      this.rejectAnswer(`Invalid starting-page decision: ${error?.message || String(error)}`, trace);
      return true;
    }
    if (chosen.choice === 'BLOCKED') {
      this.finish('blocked', 'The decision model could not choose a starting page for this task.');
      return true;
    }
    const current = await chrome.tabs.get(tabId);
    if (token !== this.runToken) return true;
    if ((current.pendingUrl || current.url || '') !== originalUrl) {
      throw new Error('The tab changed while choosing a starting action. Start a new run on the current page.');
    }
    // The text helper is invoked only after the decision model explicitly selects OPEN_TAB.
    let url: string;
    if (chosen.choice === 'OPEN_TAB') {
      url = await trace.measure('helper', 'Choose starting URL', { goal: this.progress.goal, requestedBy: 'OPEN_TAB' }, span => generateStartingUrl(this.settings, this.progress.goal, span));
    } else if (matching) {
      url = matching.url;
    } else {
      throw new Error('The starting action has no valid destination.');
    }
    if (token !== this.runToken) return true;
    let taskTabId = tabId;
    const sourceNow = await chrome.tabs.get(tabId);
    if (token !== this.runToken) return true;
    if ((sourceNow.pendingUrl || sourceNow.url || '') !== originalUrl) throw new Error('The source tab changed while choosing a starting page. Start the task again.');
    const navigation = trace.child('action', matching ? 'Reuse starting tab' : replaceTab ? 'Navigate blank tab' : 'Open starting tab', { url, sourceTabId: tabId });
    if (matching) {
      const live = await chrome.tabs.get(matching.id);
      if (token !== this.runToken) return true;
      if (live.incognito || (live.pendingUrl || live.url) !== url) throw new Error('The selected open tab changed. Start the task again.');
      await chrome.tabs.update(matching.id, { active: true });
      if (chrome.windows?.update) await chrome.windows.update(live.windowId, { focused: true });
      taskTabId = matching.id;
      this.activeTabId = taskTabId;
    } else if (replaceTab) {
      await chrome.tabs.update(tabId, { url });
    } else {
      // Chrome's own UI cannot be observed. Keep it open and start on a normal web tab.
      // No opener is set: closing the task tab must not send the agent back into Chrome UI.
      const taskTab = await chrome.tabs.create({ url, active: true, ...(current.windowId !== undefined ? { windowId: current.windowId } : {}) });
      if (token !== this.runToken) return true;
      if (taskTab.id === undefined) throw new Error('Could not identify the new task tab.');
      taskTabId = taskTab.id;
      this.activeTabId = taskTabId;
      this.lastFingerprint = null;
      this.lastSummary = null;
      this.inputAttemptedTab = null;
    }
    if (token !== this.runToken) return true;
    const operation = matching ? 'SWITCH_TAB' : replaceTab ? 'NAVIGATE' : 'OPEN_TAB';
    navigation.end({ url, tabId: taskTabId, operation, requestedOperation: chosen.choice });
    this.progress.currentStep++;
    this.history.push({ step: this.progress.currentStep, action: `${operation} ${url}`, kind: 'navigate', url, page_changed: true, outcome: `${matching ? 'switched to an open tab' : 'navigated to'} ${url}` });
    this.addLog({ step: this.progress.currentStep, timestamp: Date.now(), operation, targetLabel: matching ? 'Switched to the chosen open tab' : replaceTab ? 'Starting page requested by decision model' : 'Opened a task tab', targetValue: url, confidence: chosen.confidence, probabilities: chosen.probabilities, latencyMs: Date.now() - started, provider: this.settings.activeProvider });
    this.broadcastUpdate();
    await trace.measure('wait', 'Wait for starting page', { tabId: taskTabId }, () => this.waitForTabToLoad(taskTabId));
    if (token !== this.runToken) return true;
    await this.ensureContentScriptReady(taskTabId);
    return true;
  }

  private async ping(tabId: number): Promise<boolean> {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      return !!res?.pong;
    } catch (err: any) {
      this.lastPingError = err?.message || String(err);
      return false;
    }
  }

  /** Makes sure a single content script instance is listening in the tab. */
  private async ensureContentScriptReady(tabId: number): Promise<void> {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || '';
    if (INTERNAL_PREFIXES.some((p) => url.startsWith(p))) {
      throw new Error(
        `Cannot run on internal browser page (${url}). Open a regular web page and try again.`
      );
    }
    // Inject as soon as a document exists instead of waiting for the load event: the script
    // guards against double registration, so a later manifest injection is harmless.
    let injectError = '';
    for (let attempt = 0; attempt < 6; attempt++) {
      if (await this.ping(tabId)) return;
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      } catch (err: any) {
        injectError = err?.message || String(err);
      }
      const current = attempt >= 3 ? await chrome.tabs.get(tabId).catch(() => null) : null;
      if (current?.status === 'loading') await this.waitForTabToLoad(tabId, 2000);
      else await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
    if (!(await this.ping(tabId))) {
      throw new Error(
        `Content script did not respond after injection (${this.lastPingError || 'no reply'}${injectError ? `; inject: ${injectError}` : ''}). Reload the page and try again.`
      );
    }
  }

  /**
   * One observe → decide → act cycle. Returns false when the run has ended.
   * A stale decision is discarded and the page is observed again without recording a step.
   */
  private async executeOneStep(token: number): Promise<boolean> {
    const recorder = this.recorder!;
    const cycle = recorder.span('cycle', `Decision cycle ${recorder.run.nodes.filter(n => n.kind === 'cycle').length + 1}`, { step: this.progress.currentStep + 1, tabId: this.activeTabId });
    try {
      const result = await this.executeTracedStep(token, cycle);
      cycle.end({ continue: result }, token !== this.runToken ? 'cancelled' : this.progress.status === 'error' ? 'error' : 'ok');
      return result;
    } catch (error: any) {
      cycle.fail(error);
      if (token === this.runToken) this.finish('error', error?.message || String(error));
      return false;
    } finally {
      void recorder.flush();
    }
  }

  private async executeTracedStep(token: number, trace: TraceSpan): Promise<boolean> {
    if (token !== this.runToken) return false;
    if (this.pendingTab) await trace.measure('wait', 'Follow opened or restored tab', undefined, () => this.followTab());
    if (token !== this.runToken) return false;
    const tabId = this.activeTabId;
    if (tabId === null) {
      this.finish('error', 'No active tab identified');
      return false;
    }

    // 1. Observe
    let observation: TraceSpan | undefined;
    let snapshot: PageSnapshot;
    try {
      if (await this.bootstrap(tabId, token, trace)) {
        return token === this.runToken && this.progress.status === 'running';
      }
      if (token !== this.runToken) return false;
      observation = trace.child('observe', 'Read page and prepare input', { tabId });
      await this.ensureContentScriptReady(tabId);
      if (token !== this.runToken) return false;
      if (this.inputAttemptedTab !== tabId) await this.attachInput(tabId);
      if (token !== this.runToken) return false;
      const response = await chrome.tabs.sendMessage(tabId, { type: 'CONTENT_OBSERVE' });
      if (!response?.success || !response.snapshot) {
        throw new Error(response?.error || 'Failed to capture page DOM snapshot');
      }
      snapshot = response.snapshot;
      observation.end({ url: snapshot.url, title: snapshot.title, text: snapshot.text.slice(0, 6000), actions: snapshot.actions.length, omittedActions: snapshot.omitted_actions, input: this.progress.inputNote || 'Trusted input attached' });
    } catch (err: any) {
      if (observation) observation.fail(err);
      else trace.event('Page startup failed', { error: err?.message || String(err) }, 'error');
      if (token === this.runToken) this.finish('error', `Page startup / observe failed: ${err?.message || String(err)}`);
      return false;
    }
    if (token !== this.runToken) return false;

    // 2. Resolve what the previous action did and detect deadlocks
    const summary = summarize(snapshot);
    const fingerprint = summary.fingerprint;
    // Reconsider rejected fields after navigation or a visible page change.
    if (fingerprint !== this.lastFingerprint) this.unfillableTargetIds.clear();
    if (!this.startUrl) this.startUrl = snapshot.url;
    if (this.visitedUrls[this.visitedUrls.length - 1] !== snapshot.url) this.visitedUrls.push(snapshot.url);
    const last = this.history[this.history.length - 1];
    if (last && last.page_changed === undefined && this.tabNote) {
      last.outcome = `${this.tabNote}: ${snapshot.url}`;
      last.url = snapshot.url;
      last.page_changed = true;
      this.tabNote = null;
    } else if (last && last.page_changed === undefined && this.lastSummary) {
      last.outcome = describeOutcome(this.lastSummary, summary);
      last.url = snapshot.url;
      last.page_changed = fingerprint !== this.lastFingerprint;
      if (!last.page_changed && this.lastTargetActionId && last.kind !== 'wait') {
        const count = (this.targetFailureCount.get(this.lastTargetActionId) || 0) + 1;
        this.targetFailureCount.set(this.lastTargetActionId, count);
      } else if (last.page_changed) {
        this.targetFailureCount.clear();
      }
    }
    if (last?.outcome) trace.event('Previous action outcome', last);
    this.lastFingerprint = fingerprint;
    this.lastSummary = summary;

    const recent = this.history.slice(-DEADLOCK_RUN);
    if (
      recent.length === DEADLOCK_RUN &&
      recent.every((h) => h.page_changed === false && h.kind !== 'wait')
    ) {
      this.finish(
        'blocked',
        `${DEADLOCK_RUN} consecutive actions produced no change on the page. Inspect the page or adjust the goal.`
      );
      return false;
    }

    // 3. Loop feedback for the model. Toggling the same control (a menu that opens and closes)
    //    changes the page every time, so repeats are tracked separately from "no change".
    let warning: string | undefined;
    const repeatedAction = last?.action && last.kind !== 'wait' ? last.action : null;
    const repeated = repeatedAction ? this.repeatCount(repeatedAction) : 0;
    if (repeated >= REPEAT_LIMIT) {
      this.finish('blocked', `The same action "${repeatedAction}" was repeated ${repeated} times without reaching the goal.`);
      return false;
    }
    const suppressedTargetIds = Array.from(this.targetFailureCount.entries())
      .filter(([, count]) => count >= 2)
      .map(([id]) => id);
    if (last && last.page_changed === false && last.kind !== 'wait') {
      warning = `ATTENTION: Previous action "${last.action}" resulted in NO visible change on the page. Do NOT repeat the exact same action. Try an alternative target, scroll, or submit button.`;
    } else if (repeated >= 2 && repeatedAction) {
      warning = `ATTENTION: "${repeatedAction}" has now been executed ${repeated} times and did not advance the goal. Do NOT choose it again; use a different control that moves toward the goal.`;
      // Ids are per snapshot; withhold whatever on this page carries the same operation and label.
      for (const a of snapshot.actions) {
        if (a.node !== undefined && `${OP_BY_KIND[a.kind] || ''} ${a.label}` === repeatedAction) suppressedTargetIds.push(a.id);
      }
    }
    const fieldNotice = this.unfillableTargetIds.size
      ? 'ATTENTION: Fields rejected by the text helper remain unavailable for TYPE_TEXT on this unchanged page. Choose a different action that advances the goal.'
      : undefined;
    warning = [warning, this.lastStaleNotice || fieldNotice].filter(Boolean).join('\n') || undefined;
    this.lastStaleNotice = null;

    // 4. Decide
    if (this.decisionCount >= this.progress.maxSteps * 2) {
      this.finish('blocked', 'Reached the model-call budget for this run.');
      return false;
    }
    const { request, actionSpace } = buildJevRequest(
      activeJevModel(this.settings),
      snapshot,
      this.progress.goal,
      this.history,
      { warning, suppressedTargetIds, unfillableTargetIds: [...this.unfillableTargetIds] },
      { start_url: this.startUrl, steps_taken: this.history.length, visited_urls: this.visitedUrls.slice(-6) }
    );
    let tabs: BrowserTab[];
    try {
      tabs = await this.readOpenTabs(trace);
    } catch (err: any) {
      this.finish('error', `Could not list open tabs: ${err?.message || String(err)}`);
      return false;
    }
    if (token !== this.runToken) return false;
    const tabTargets = addBrowserActions(request, actionSpace, tabs, tabId);
    if (this.vetoed) {
      // The previous verdict was contradicted by its cross-check; withhold it this time.
      delete actionSpace.operations[this.vetoed];
      delete (request.questions.operation as ChoiceQuestion).criteria[this.vetoed];
      this.vetoed = null;
    }

    const started = Date.now();
    const decision = trace.child('decision', 'Choose operation and target', request);
    let jevResponse;
    try {
      this.decisionCount++;
      jevResponse = await callJevProvider(this.settings, request, decision);
      decision.end(jevResponse);
    } catch (err: any) {
      decision.fail(err);
      if (token === this.runToken) this.finish('error', `Decision failed: ${err?.message || String(err)}`);
      return false;
    }
    const latencyMs = Date.now() - started;
    if (token !== this.runToken) return false;

    let operationAnswer;
    try {
      operationAnswer = validateChoiceAnswer(jevResponse.answers?.operation, actionSpace.operations);
    } catch (err: any) {
      return this.rejectAnswer(`Invalid operation choice: ${err?.message || String(err)}`, trace);
    }
    const operation = operationAnswer.choice;
    const provider = this.settings.activeProvider;
    const goalDone = readNoul(jevResponse.answers?.goal_done);
    const stuck = readNoul(jevResponse.answers?.stuck);

    if (operation === 'DONE' && goalDone !== undefined && goalDone < GOAL_DONE_MIN) {
      trace.event('DONE rejected by goal check', { goalDone, threshold: GOAL_DONE_MIN, next: 'Observe again with DONE withheld' }, 'skipped');
      this.vetoed = 'DONE';
      this.lastStaleNotice = `ATTENTION: DONE was proposed, but the independent goal check says the task is not achieved yet (probability ${goalDone.toFixed(2)}). Something in the task is still missing; act on it.`;
      this.addLog({ step: this.progress.currentStep, timestamp: Date.now(), operation: 'DONE (vetoed)', confidence: operationAnswer.confidence, latencyMs, provider, probabilities: operationAnswer.probabilities, goalDone, stuck });
      this.broadcastUpdate();
      return true;
    }
    if (operation === 'BLOCKED' && stuck !== undefined && stuck < STUCK_MIN && this.history.length < REPEAT_WINDOW) {
      trace.event('BLOCKED rejected by progress check', { stuck, threshold: STUCK_MIN, next: 'Observe again with BLOCKED withheld' }, 'skipped');
      this.vetoed = 'BLOCKED';
      this.lastStaleNotice = `ATTENTION: BLOCKED was proposed, but the independent progress check does not see a dead end (stuck probability ${stuck.toFixed(2)}). Choose a control that moves toward the task.`;
      this.addLog({ step: this.progress.currentStep, timestamp: Date.now(), operation: 'BLOCKED (vetoed)', confidence: operationAnswer.confidence, latencyMs, provider, probabilities: operationAnswer.probabilities, goalDone, stuck });
      this.broadcastUpdate();
      return true;
    }

    if (operation === 'DONE' || operation === 'BLOCKED') {
      if (operationAnswer.confidence < TERMINAL_CONFIRM_THRESHOLD && this.pendingTerminal !== operation) {
        // A hesitant verdict gets one more look after the page settles; only a repeat ends the run.
        this.pendingTerminal = operation;
        this.sendStatus({ text: operation === 'DONE' ? 'Checking whether the task is complete…' : 'Checking for another way forward…', latencyMs });
        await trace.measure('wait', 'Confirm low-confidence verdict', { operation, confidence: operationAnswer.confidence, threshold: TERMINAL_CONFIRM_THRESHOLD }, () => new Promise(r => setTimeout(r, 600)));
        return true;
      }
      this.addLog({
        step: this.progress.currentStep,
        timestamp: Date.now(),
        operation,
        confidence: operationAnswer.confidence,
        latencyMs,
        provider,
        probabilities: operationAnswer.probabilities,
        goalDone,
        stuck,
      });
      this.finish(operation === 'DONE' ? 'done' : 'blocked');
      this.sendStatus({ text: operation === 'DONE' ? 'Done' : 'Blocked', latencyMs });
      return false;
    }

    this.pendingTerminal = null;

    if (operation === 'OPEN_TAB' || operation === 'SWITCH_TAB') {
      const navigation = trace.child('action', operation === 'OPEN_TAB' ? 'Open task tab' : 'Switch to open tab');
      try {
        let destination: chrome.tabs.Tab | undefined;
        let targetUrl: string;
        if (operation === 'SWITCH_TAB') {
          const choice = validateChoiceAnswer(jevResponse.answers?.switch_tab_target, tabTargets);
          const offered = tabTargets[choice.choice];
          targetUrl = offered.url;
          const live = await chrome.tabs.get(offered.id);
          if (token !== this.runToken) return false;
          if (live.incognito || (live.pendingUrl || live.url) !== offered.url) {
            navigation.end({ reason: 'Selected tab URL changed; reconsider navigation' }, 'skipped');
            this.lastStaleNotice = 'The selected tab changed. Reconsider the current open tabs.';
            return true;
          }
          destination = (await chrome.tabs.update(offered.id, { active: true })) || live;
          if (destination?.windowId !== undefined && chrome.windows?.update) await chrome.windows.update(destination.windowId, { focused: true });
        } else {
          targetUrl = await navigation.measure('helper', 'Choose new tab URL', { goal: this.progress.goal }, span => generateStartingUrl(this.settings, this.progress.goal, span));
          if (token !== this.runToken) return false;
          const source = await chrome.tabs.get(tabId);
          if (token !== this.runToken) return false;
          if ((source.pendingUrl || source.url) !== snapshot.url) {
            navigation.end({ reason: 'Source page changed; reconsider navigation' }, 'skipped');
            this.lastStaleNotice = 'The current page changed while choosing a new tab. Reconsider navigation.';
            return true;
          }
          destination = await chrome.tabs.create({ url: targetUrl, active: true, ...(source.windowId !== undefined ? { windowId: source.windowId } : {}) });
        }
        if (token !== this.runToken) return false;
        if (destination?.id === undefined) throw new Error('Could not identify the destination tab.');
        await this.input.detach();
        if (token !== this.runToken) return false;
        this.tabStack.push(tabId);
        this.activeTabId = destination.id;
        this.pendingTab = null;
        this.lastFingerprint = null;
        this.lastSummary = null;
        this.inputAttemptedTab = null;
        this.lastTargetActionId = null;
        this.targetFailureCount.clear();
        this.consecutiveStale = 0;
        this.invalidAnswerRetried = false;
        this.progress.currentStep++;
        this.history.push({ step: this.progress.currentStep, action: `${operation} ${targetUrl}`, kind: 'navigate', url: targetUrl, page_changed: true, outcome: `${operation === 'SWITCH_TAB' ? 'switched to an open tab' : 'opened a task tab'}: ${targetUrl}` });
        this.addLog({ step: this.progress.currentStep, timestamp: Date.now(), operation, targetLabel: operation === 'SWITCH_TAB' ? 'Switched to an open tab' : 'Opened a task tab', targetValue: targetUrl, latencyMs: Date.now() - started, provider });
        this.broadcastUpdate();
        navigation.end({ url: targetUrl, tabId: destination.id });
        await trace.measure('wait', 'Wait for destination page', { tabId: destination.id }, () => this.waitForTabToLoad(destination!.id!));
        if (token !== this.runToken) return false;
        await this.ensureContentScriptReady(destination.id);
        return true;
      } catch (err: any) {
        navigation.fail(err);
        if (token === this.runToken) this.finish('error', `Tab navigation failed: ${err?.message || String(err)}`);
        return false;
      }
    }

    // 5. Resolve the target from the selected operation's head only
    let targetAction: PageAction | undefined;
    let targetConfidence = operationAnswer.confidence;
    if (operation in actionSpace.targets) {
      try {
        const targetAnswer = validateChoiceAnswer(
          jevResponse.answers?.[`${operation.toLowerCase()}_target`],
          actionSpace.targets[operation]
        );
        targetAction = actionSpace.targets[operation][targetAnswer.choice];
        targetConfidence = targetAnswer.confidence;
      } catch (err: any) {
        return this.rejectAnswer(`Invalid target choice: ${err?.message || String(err)}`, trace);
      }
    } else if (operation in actionSpace.controls) {
      targetAction = actionSpace.controls[operation];
    }
    if (!targetAction) {
      this.finish('error', `Could not find target action for operation: ${operation}`);
      return false;
    }

    // 6. TYPE_TEXT: the helper supplies the value; reuse it only for an identical input after a stale retry
    let generatedText: string | undefined;
    if (operation === 'TYPE_TEXT') {
      const context = createFieldContext(
        this.progress.goal,
        targetAction,
        { title: snapshot.title, text: snapshot.text },
        this.history
      );
      const key = JSON.stringify(context);
      if (this.pendingText && this.pendingText.key === key) {
        generatedText = this.pendingText.text;
        trace.event('Reused text from the previous attempt', { text: generatedText });
      } else {
        try {
          generatedText = await trace.measure('helper', 'Generate field text', context, span => generateFieldText(this.settings, context, span));
        } catch (err: any) {
          if (token !== this.runToken) return false;
          const message = err?.message || String(err);
          if (!(err instanceof NoFieldValueError)) {
            this.finish('error', `Text helper failed: ${message}`);
            return false;
          }
          // A valid null is feedback about this field. Do not write or retry it on
          // the unchanged page; let the decision model choose another way forward.
          this.pendingText = null;
          this.unfillableTargetIds.add(targetAction.id);
          this.consecutiveStale++;
          trace.event('Field rejected by text helper', {
            target: { id: targetAction.id, label: targetAction.label },
            reason: 'The helper returned null; no text was written.',
            next: this.consecutiveStale >= MAX_CONSECUTIVE_STALE ? 'Stop after repeated field rejections' : 'Observe again with this typing target excluded until the page changes',
          }, 'skipped');
          if (this.consecutiveStale >= MAX_CONSECUTIVE_STALE) {
            this.finish('blocked', 'The text helper could not supply values for several selected fields. Try a more specific goal or a different page.');
            return false;
          }
          this.lastStaleNotice = `ATTENTION: No value for the field "${targetAction.label}" can be derived from the goal. Nothing was written, and TYPE_TEXT on this field is excluded until the page changes. Choose another field, click, navigate, or switch tabs to advance the goal; choose BLOCKED if no supported action can help.`;
          this.broadcastUpdate();
          return true;
        }
        this.pendingText = { key, text: generatedText };
      }
      if (token !== this.runToken) return false;
    }

    // 7. Act (never retried)
    this.sendStatus({ text: `${operation} ${targetAction.label}`.slice(0, 120), latencyMs });
    let navigated = false;
    const action = trace.child('action', `${operation} ${targetAction.label}`, { target: targetAction, text: generatedText });
    try {
      const result = await this.act(tabId, targetAction, generatedText, action);
      action.end(result, result.ok ? 'ok' : 'skipped');
      if (token !== this.runToken) return false;
      if (!result.ok) {
        if (result.code === 'invalid') {
          this.finish('error', `Act execution failed: ${result.message}`);
          return false;
        }
        this.consecutiveStale++;
        if (this.consecutiveStale >= MAX_CONSECUTIVE_STALE) {
          this.finish('error', `Page kept changing before actions could run: ${result.message}`);
          return false;
        }
        // A covered or vanished target counts as a miss: the model is told, and after two
        // misses the target is withheld while alternatives exist.
        this.targetFailureCount.set(targetAction.id, (this.targetFailureCount.get(targetAction.id) || 0) + 1);
        this.lastStaleNotice = `ATTENTION: The target "${targetAction.label}" could not be acted on (${result.message}). If an overlay or dialog is open, act inside it or close it; otherwise choose a different target.`;
        this.broadcastUpdate();
        // A covered or vanished target usually means the page is still loading or animating
        // (an in-page sort or filter that swaps the list); give it more time before looking again.
        await trace.measure('wait', 'Wait before observing again', { delayMs: 500 * this.consecutiveStale }, () => new Promise(r => setTimeout(r, 500 * this.consecutiveStale)));
        return true; // observe again; nothing was executed
      }
    } catch (err: any) {
      if (token !== this.runToken) return false;
      const message = err?.message || String(err);
      if (!isNavigationError(message)) {
        action.fail(err);
        this.finish('error', `Act execution failed: ${message}`);
        return false;
      }
      // The action ran and the page navigated before it could reply; the action still counts.
      action.end({ navigation: 'Page navigated before replying; action counted' });
      navigated = true;
    }

    // 8. Record execution before observing again
    this.consecutiveStale = 0;
    this.invalidAnswerRetried = false;
    this.pendingText = null;
    this.lastTargetActionId = targetAction.id;
    this.history.push({
      step: this.progress.currentStep + 1,
      action: `${operation} ${targetAction.label}`,
      kind: targetAction.kind,
      text: generatedText,
      page_changed: undefined,
    });
    this.progress.currentStep++;
    this.addLog({
      step: this.progress.currentStep,
      timestamp: Date.now(),
      operation,
      targetId: targetAction.id,
      targetLabel: targetAction.label,
      targetValue: generatedText,
      confidence: targetConfidence,
      latencyMs,
      provider,
      probabilities: operationAnswer.probabilities,
      goalDone,
      stuck,
    });
    this.broadcastUpdate();

    // A click, select or Enter may have started a navigation that only shows up as the tab
    // loading; observing the old document now would hand the model a page that is about to
    // disappear.
    const settle = trace.child('wait', 'Wait for navigation');
    if (this.pendingTab) {
      await this.followTab();
    } else if (navigated) {
      await this.waitForTabToLoad(tabId);
    } else {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab?.status === 'loading') await this.waitForTabToLoad(tabId);
    }
    settle.end();
    return true;
  }

  /** An inconsistent model answer is not executed. The first one is simply asked again. */
  private rejectAnswer(message: string, trace: TraceSpan): boolean {
    trace.event('Invalid model answer', { message, retrying: !this.invalidAnswerRetried }, 'skipped');
    if (!this.invalidAnswerRetried) {
      this.invalidAnswerRetried = true;
      this.lastStaleNotice = null;
      this.broadcastUpdate();
      return true;
    }
    this.finish('error', message);
    return false;
  }

  /** How often the same operation + label was executed within the recent window (counting the last action). */
  private repeatCount(action: string): number {
    return this.history.slice(-REPEAT_WINDOW).filter((h) => h.action === action && h.kind !== 'wait').length;
  }

  private addLog(log: AgentStepLog): void {
    this.progress.logs.unshift(log);
    if (this.progress.logs.length > 50) this.progress.logs.pop();
  }

  /** Attaches trusted input when enabled; records why not so the trace shows which path ran. */
  private async attachInput(tabId: number): Promise<void> {
    this.inputAttemptedTab = tabId;
    if (!this.settings.trustedInput) {
      this.progress.inputNote = 'Trusted input is off in settings; using synthetic events.';
    } else if (await this.input.attach(tabId)) {
      delete this.progress.inputNote;
    } else {
      this.progress.inputNote = TrustedInput.available()
        ? 'Could not attach the debugger (DevTools open on this tab?); using synthetic events.'
        : 'The debugger API is unavailable in this browser; using synthetic events.';
    }
    this.broadcastUpdate();
  }

  /**
   * One action: the page checks, scrolls and focuses the target, then the input is dispatched
   * through the DevTools protocol when attached, or with synthetic events otherwise. A
   * trusted dispatch that throws falls back to synthetic on the already prepared target.
   */
  private async act(tabId: number, action: PageAction, text: string | undefined, trace: TraceSpan): Promise<ActResult> {
    if (this.input.attachedTab !== tabId) {
      const result: ActResult | undefined = await chrome.tabs.sendMessage(tabId, { type: 'CONTENT_ACT', action, text });
      return result ?? { ok: false, code: 'failed', message: 'No reply from the page.' };
    }
    const prep: PrepareResult | undefined = await trace.measure('action', 'Validate and prepare target', undefined, () => chrome.tabs.sendMessage(tabId, { type: 'CONTENT_PREPARE', action, text }));
    if (!prep) return { ok: false, code: 'failed', message: 'No reply from the page.' };
    if (!prep.ok) return prep;
    if (prep.done) return { ok: true, via: 'page' };
    const dispatch = trace.child('action', 'Dispatch trusted input');
    try {
      if (action.kind === 'click') {
        await this.input.click(prep.x, prep.y);
      } else if (action.kind === 'fill') {
        await this.input.click(prep.x, prep.y);
        await this.input.insertText(text ?? '');
      } else if (action.kind === 'key') {
        await this.input.pressEnter();
      } else {
        dispatch.end({ kind: action.kind }, 'error');
        return { ok: false, code: 'invalid', message: `Unknown action kind: ${String(action.kind)}` };
      }
      dispatch.end();
    } catch (err: any) {
      dispatch.fail(err);
      // The session was lost mid-action (tab navigated away, user cancelled): synthetic events
      // on the target the page already prepared are the closest equivalent.
      const fallback: ActResult | undefined = await trace.measure('action', 'Fall back to synthetic input', undefined, () => chrome.tabs.sendMessage(tabId, { type: 'CONTENT_DISPATCH', action, text }));
      return fallback ?? { ok: false, code: 'failed', message: err?.message || String(err) };
    }
    await trace.measure('wait', 'Wait for page to settle', undefined, () => chrome.tabs.sendMessage(tabId, { type: 'CONTENT_SETTLE' }).catch(() => undefined));
    return { ok: true, via: 'cdp' };
  }

  private finish(status: 'done' | 'blocked' | 'error', message?: string): void {
    void this.input.detach();
    this.progress.status = status;
    if (message) {
      this.progress.lastError = message;
    } else {
      delete this.progress.lastError;
    }
    this.broadcastUpdate();
    if (status !== 'done') this.sendStatus({ text: message || status });
  }

  private finalizeHistory(): void {
    const { status, currentStep, lastError } = this.progress;
    if (status === 'paused' || status === 'running') this.recorder?.update(status, currentStep, lastError);
    else this.recorder?.finish(status === 'idle' ? 'stopped' : status, currentStep, lastError);
  }

  private broadcastUpdate(): void {
    const { status, currentStep, lastError } = this.progress;
    this.recorder?.update(status === 'idle' ? 'stopped' : status, currentStep, lastError);
    try {
      chrome.runtime
        .sendMessage({ type: 'PROGRESS_UPDATE', progress: this.progress })
        .catch(() => {
          // Popup might be closed
        });
    } catch {
      // No receiver available
    }
  }

  private sendStatus(payload: { text?: string; latencyMs?: number; clear?: boolean }): void {
    if (this.activeTabId === null) return;
    try {
      chrome.tabs.sendMessage(this.activeTabId, { type: 'CONTENT_STATUS', ...payload }).catch(() => {
        // Tab may be navigating
      });
    } catch {
      // Tab gone
    }
  }
}
