import { expect, it } from 'vitest';
import { buildJevRequest } from '../src/shared/action-space';
import { addBrowserActions, buildStartupRequest } from '../src/shared/browser-tabs';

it('offers startup routing from tab metadata, with no invented page observation or typing actions', () => {
  const tabs = [{ id: 9, windowId: 2, title: 'WhatsApp', url: 'https://web.whatsapp.com/' }];
  const { request, actionSpace, tabTargets } = buildStartupRequest('test', 'Find the example conversation in WhatsApp', 'chrome://newtab/', tabs, 7);
  expect(Object.keys(actionSpace.operations).sort()).toEqual(['BLOCKED', 'OPEN_TAB', 'SWITCH_TAB']);
  expect(Object.keys(request.questions).sort()).toEqual(['operation', 'switch_tab_target']);
  expect(request.state.page.text).toBe('');
  expect(request.state.elements).toEqual([]);
  expect(request.state.browser).toEqual({ active_tab_id: 7, open_tabs: tabs });
  expect(tabTargets['9']).toEqual(tabs[0]);
  expect((request.questions.operation.instructions as any).rules).toContain('explicitly requests the text helper');
  expect(request.state.observation_notice).toContain('No page content was observed');
});

it('omits SWITCH_TAB when no eligible destination is open', () => {
  const { request, actionSpace } = buildStartupRequest('test', 'Find a page', 'about:blank', [], 7);
  expect(Object.keys(actionSpace.operations).sort()).toEqual(['BLOCKED', 'OPEN_TAB']);
  expect(request.questions.switch_tab_target).toBeUndefined();
});

it('offers code-owned tab ids, preserves current page targets, and includes tab metadata', () => {
  const { request, actionSpace } = buildJevRequest('m', { url: 'https://example.com', title: 'Example', text: '', w: 100, h: 100, omitted_actions: 0, scroll: { y: 0, height: 100 }, actions: [{ id: 'a', node: 1, kind: 'click', label: 'Link' }] }, 'Find YouTube OLED videos', []);
  const tabs = [{ id: 7, windowId: 1, title: 'Example', url: 'https://example.com' }, { id: 9, windowId: 2, title: 'YouTube', url: 'https://www.youtube.com/' }];
  const targets = addBrowserActions(request, actionSpace, tabs, 7);
  expect(Object.keys(targets)).toEqual(['9']);
  expect(actionSpace.operations).toHaveProperty('OPEN_TAB');
  expect(actionSpace.operations).toHaveProperty('SWITCH_TAB');
  expect(actionSpace.targets.CLICK['1'].id).toBe('a');
  expect(request.state.browser).toEqual({ active_tab_id: 7, open_tabs: tabs });
  expect(request.questions.switch_tab_target.criteria).toEqual({ '9': { title: 'YouTube', url: 'https://www.youtube.com/' } });
});
