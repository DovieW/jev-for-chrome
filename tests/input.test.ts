import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrustedInput } from '../src/background/input';

function installChrome(opts: { absent?: boolean; attachError?: string } = {}) {
  const commands: Array<{ method: string; params: any }> = [];
  let onDetach: ((source: any, reason: string) => void) | null = null;
  const debuggerMock = {
      attach: vi.fn(async () => {
        if (opts.attachError) throw new Error(opts.attachError);
      }),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async (_target: any, method: string, params: any) => {
        commands.push({ method, params });
        return {};
      }),
      onDetach: { addListener: vi.fn((fn: any) => { onDetach = fn; }) },
  };
  const chromeMock = { debugger: debuggerMock };
  vi.stubGlobal('chrome', opts.absent ? {} : chromeMock);
  return { chromeMock, commands, fireDetach: (source: any, reason: string) => onDetach?.(source, reason) };
}

describe('TrustedInput', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('attaches once per tab and dispatches a move-press-release click', async () => {
    const { chromeMock, commands } = installChrome();
    const input = new TrustedInput();
    expect(await input.attach(7)).toBe(true);
    expect(await input.attach(7)).toBe(true);
    expect(chromeMock.debugger.attach).toHaveBeenCalledTimes(1);
    expect(chromeMock.debugger.attach).toHaveBeenCalledWith({ tabId: 7 }, '1.3');

    await input.click(10, 20);
    expect(commands.map((c) => `${c.method}:${c.params.type}`)).toEqual([
      'Input.dispatchMouseEvent:mouseMoved',
      'Input.dispatchMouseEvent:mousePressed',
      'Input.dispatchMouseEvent:mouseReleased',
    ]);
    expect(commands[1].params).toMatchObject({ x: 10, y: 20, button: 'left', clickCount: 1 });
  });

  it('types with insertText and sends a real Enter keystroke', async () => {
    const { commands } = installChrome();
    const input = new TrustedInput();
    await input.attach(7);
    await input.insertText('hello');
    await input.pressEnter();
    expect(commands[0]).toEqual({ method: 'Input.insertText', params: { text: 'hello' } });
    expect(commands[1].params).toMatchObject({ type: 'keyDown', key: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
    expect(commands[2].params).toMatchObject({ type: 'keyUp', key: 'Enter' });
  });

  it('reports false without the API or when Chrome refuses to attach', async () => {
    installChrome({ absent: true });
    expect(await new TrustedInput().attach(7)).toBe(false);
    installChrome({ attachError: 'Another debugger is already attached to the tab with id: 7.' });
    const input = new TrustedInput();
    expect(await input.attach(7)).toBe(false);
    expect(input.attachedTab).toBeNull();
    await expect(input.click(1, 1)).rejects.toThrow('not attached');
  });

  it('cleans up an attachment that completes after Stop and serializes the next attachment', async () => {
    const { chromeMock } = installChrome();
    const input = new TrustedInput();
    let complete!: () => void;
    chromeMock.debugger.attach.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
    const attaching = input.attach(7);
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    const stopping = input.detach();
    const next = input.attach(8);
    complete();
    expect(await attaching).toBe(false);
    await stopping;
    expect(await next).toBe(true);
    expect(chromeMock.debugger.detach).toHaveBeenCalledExactlyOnceWith({ tabId: 7 });
    expect(input.attachedTab).toBe(8);
  });

  it('never sends the rest of an old gesture into a new debugger session', async () => {
    const { chromeMock, commands } = installChrome();
    const input = new TrustedInput();
    await input.attach(7);
    let release!: () => void;
    chromeMock.debugger.sendCommand.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({}); }));
    const click = input.click(1, 2);
    const rejected = expect(click).rejects.toThrow('original session');
    await input.detach();
    await input.attach(8);
    release();
    await rejected;
    expect(commands).toHaveLength(0);
    expect(chromeMock.debugger.sendCommand).toHaveBeenCalledTimes(1);
  });

  it('moves between tabs by detaching first, and notices when the user cancels', async () => {
    const { chromeMock, fireDetach } = installChrome();
    const input = new TrustedInput();
    const cancelled: number[] = [];
    input.onCancelled = (tabId) => cancelled.push(tabId);
    await input.attach(7);
    await input.attach(8);
    expect(chromeMock.debugger.detach).toHaveBeenCalledWith({ tabId: 7 });
    expect(input.attachedTab).toBe(8);

    fireDetach({ tabId: 8 }, 'canceled_by_user');
    expect(input.attachedTab).toBeNull();
    expect(cancelled).toEqual([8]);
    fireDetach({ tabId: 8 }, 'target_closed');
    expect(cancelled).toEqual([8]);
  });
});
