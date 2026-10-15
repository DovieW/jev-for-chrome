/**
 * Trusted input through the DevTools protocol (chrome.debugger). Events dispatched this way
 * are what a mouse and keyboard produce: `isTrusted` is true, CSS :hover applies, javascript:
 * links and framework handlers that ignore scripted events all work, and the page's own CSP
 * is what applies. This is how nanobrowser, Taxy and browser-use drive pages.
 *
 * Attaching is best effort. It fails when DevTools already owns the tab, when another
 * extension is attached, or on pages extensions cannot touch; the caller then falls back to
 * synthetic events. ("debugger" cannot be an optional permission in Chrome, so it is required.) Chrome shows an info bar on the tab while attached and
 * detaches when the user dismisses it; that ends the run.
 */
export class TrustedInput {
  private tabId: number | null = null;
  private listening = false;
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();
  /** Called when the user cancels the debugging session from Chrome's info bar. */
  public onCancelled: ((tabId: number) => void) | null = null;

  public get attachedTab(): number | null {
    return this.tabId;
  }

  /** True when the debugger API exists in this context (unit tests and some builds lack it). */
  public static available(): boolean {
    return typeof chrome !== 'undefined' && typeof chrome.debugger !== 'undefined';
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Attaches to the tab; a stop during attachment invalidates and releases the late session. */
  public attach(tabId: number): Promise<boolean> {
    const generation = this.generation;
    return this.serialize(async () => {
      if (generation !== this.generation || !TrustedInput.available()) return false;
      if (this.tabId === tabId) return true;
      await this.release();
      if (generation !== this.generation) return false;
      if (!this.listening) {
        this.listening = true;
        chrome.debugger.onDetach.addListener((source, reason) => {
          if (source.tabId !== this.tabId) return;
          const cancelled = this.tabId;
          this.tabId = null;
          this.generation++;
          if (reason === 'canceled_by_user' && cancelled !== null) this.onCancelled?.(cancelled);
        });
      }
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
      } catch {
        return false;
      }
      this.tabId = tabId;
      if (generation !== this.generation) {
        await this.release();
        return false;
      }
      return true;
    });
  }

  public detach(): Promise<void> {
    this.generation++;
    return this.serialize(() => this.release());
  }

  private async release(): Promise<void> {
    const tabId = this.tabId;
    this.tabId = null;
    if (tabId === null) return;
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Already gone (tab closed, user cancelled).
    }
  }

  /** Pin a multi-command gesture to its original session, including across Stop/restart. */
  private commandsForSession() {
    const tabId = this.tabId;
    const generation = this.generation;
    return (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (tabId === null || tabId !== this.tabId || generation !== this.generation) {
        return Promise.reject(new Error('Trusted input is not attached to the original session'));
      }
      return chrome.debugger.sendCommand({ tabId }, method, params) as Promise<unknown>;
    };
  }

  /** One left click at viewport coordinates: move (so :hover applies), press, release. */
  public async click(x: number, y: number): Promise<void> {
    const send = this.commandsForSession();
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  /** Inserts text at the caret of the focused element, as an IME commit would. */
  public async insertText(text: string): Promise<void> {
    const send = this.commandsForSession();
    await send('Input.insertText', { text });
  }

  /** A real Enter keystroke in the focused element: submits forms, picks suggestions. */
  public async pressEnter(): Promise<void> {
    const send = this.commandsForSession();
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...key });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  }
}
