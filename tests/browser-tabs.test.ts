import { expect, it } from 'vitest';
import { buildJevRequest } from '../src/shared/action-space';
import { addBrowserActions } from '../src/shared/browser-tabs';

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
