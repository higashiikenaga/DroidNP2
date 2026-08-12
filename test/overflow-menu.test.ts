import { describe, expect, it } from 'vitest';
import {
  ALL_TOOLBAR_ACTIONS,
  ALWAYS_VISIBLE_ACTIONS,
  backToOverflowRoot,
  CLOSED_OVERFLOW_MENU_STATE,
  isWideOverflowMenu,
  OVERFLOW_GROUP_ORDER,
  OVERFLOW_GROUPS,
  ROOT_OVERFLOW_MENU_STATE,
  selectOverflowGroup,
  toggleOverflowMenu,
  type ToolbarActionId,
} from '../src/ui/overflow-menu.ts';

describe('グループ定義', () => {
  it('常時表示は要件通りの7個ちょうど', () => {
    expect(ALWAYS_VISIBLE_ACTIONS).toEqual([
      'machineReset',
      'saveState',
      'loadState',
      'screenshot',
      'fullscreen',
      'virtualKbd',
      'gamepad',
    ]);
  });

  it('オーバーフローの2グループが要件通りの内訳', () => {
    expect(OVERFLOW_GROUP_ORDER).toEqual(['mouse', 'tools']);
    expect(OVERFLOW_GROUPS.mouse).toEqual(['mouseCapture', 'mouseResync', 'resetOriginal']);
    expect(OVERFLOW_GROUPS.tools).toEqual(['pasteText', 'romManager', 'diskLibrary', 'fileManager', 'debuggerOpen']);
  });

  it('常時表示とオーバーフローの間で重複が無い(1つの操作は1箇所にしか属さない)', () => {
    const overflowIds = OVERFLOW_GROUP_ORDER.flatMap((g) => OVERFLOW_GROUPS[g]);
    const seen = new Set<ToolbarActionId>();
    for (const id of [...ALWAYS_VISIBLE_ACTIONS, ...overflowIds]) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it('ALL_TOOLBAR_ACTIONS は常時表示7個+オーバーフロー8個=15個', () => {
    expect(ALL_TOOLBAR_ACTIONS).toHaveLength(15);
  });
});

describe('isWideOverflowMenu', () => {
  it('640px以上はカスケード(wide)', () => {
    expect(isWideOverflowMenu(640)).toBe(true);
    expect(isWideOverflowMenu(1280)).toBe(true);
  });

  it('640px未満は差し替え式(narrow)', () => {
    expect(isWideOverflowMenu(639)).toBe(false);
    expect(isWideOverflowMenu(375)).toBe(false);
  });
});

describe('オーバーフローメニューの開閉状態遷移', () => {
  it('閉状態から「…」を押すとrootが開く', () => {
    expect(toggleOverflowMenu(CLOSED_OVERFLOW_MENU_STATE)).toEqual(ROOT_OVERFLOW_MENU_STATE);
  });

  it('root/group/cascadeいずれから「…」を押しても閉じる(トグル)', () => {
    expect(toggleOverflowMenu(ROOT_OVERFLOW_MENU_STATE)).toEqual(CLOSED_OVERFLOW_MENU_STATE);
    expect(toggleOverflowMenu({ level: 'group', group: 'mouse' })).toEqual(CLOSED_OVERFLOW_MENU_STATE);
    expect(toggleOverflowMenu({ level: 'cascade', group: 'tools' })).toEqual(CLOSED_OVERFLOW_MENU_STATE);
  });

  it('広い画面でグループ行を選ぶとcascadeへ遷移し、親は閉じない想定の状態になる', () => {
    expect(selectOverflowGroup('mouse', true)).toEqual({ level: 'cascade', group: 'mouse' });
  });

  it('狭い画面でグループ行を選ぶとgroup(差し替え)へ遷移する', () => {
    expect(selectOverflowGroup('tools', false)).toEqual({ level: 'group', group: 'tools' });
  });

  it('差し替え式の「← 戻る」はrootへ戻る', () => {
    expect(backToOverflowRoot()).toEqual(ROOT_OVERFLOW_MENU_STATE);
  });
});
