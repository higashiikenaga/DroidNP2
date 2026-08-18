import { describe, expect, it, vi } from 'vitest';
import {
  applyInputPanelTransition,
  inputPanelUiState,
  type InputPanelActions,
} from '../src/ui/input-panel.ts';

function actions(log: string[]): InputPanelActions {
  return {
    releaseKeyboard: vi.fn(() => log.push('release-keyboard')),
    releasePad: vi.fn(() => log.push('release-pad')),
    releaseTrackpad: vi.fn(() => log.push('release-trackpad')),
    setKeyboardVisible: vi.fn((visible) => log.push(`keyboard-${visible}`)),
    setPadVisible: vi.fn((visible) => log.push(`pad-${visible}`)),
    setTrackpadVisible: vi.fn((visible) => log.push(`trackpad-${visible}`)),
  };
}

describe('inputPanelUiState', () => {
  it('すべて非表示ならチップを出さない', () => {
    expect(
      inputPanelUiState({ keyboardVisible: false, padVisible: false, trackpadVisible: false }),
    ).toEqual({
      chipVisible: false,
      keyboardPressed: false,
      padPressed: false,
      trackpadPressed: false,
    });
  });

  it.each([
    [{ keyboardVisible: true, padVisible: false, trackpadVisible: false }, true, false, false],
    [{ keyboardVisible: false, padVisible: true, trackpadVisible: false }, false, true, false],
    [{ keyboardVisible: false, padVisible: false, trackpadVisible: true }, false, false, true],
  ] as const)(
    'いずれかが表示中ならチップと対応する押下状態を出す',
    (state, keyboardPressed, padPressed, trackpadPressed) => {
      expect(inputPanelUiState(state)).toEqual({
        chipVisible: true,
        keyboardPressed,
        padPressed,
        trackpadPressed,
      });
    },
  );
});

describe('inputPanelUiState.chipVisible(document.bodyのinput-panel-open状態クラスの一次情報源)', () => {
  // player.ts の syncInputPanelUi() は document.body.classList.toggle('input-panel-open', ...)
  // にこの chipVisible をそのまま渡す(キーボード/パッド/トラックパッドのいずれかの表示中だけ
  // 1画面へ収める措置を効かせるため)。DOM操作自体はjsdom無しのこのテスト環境では検証できないが、
  // 「3パネルのうち1つでも表示中ならtrue、全部非表示ならfalse」という一次情報源の真偽表だけは
  // ここで固定しておく(rescale()のheightConstrained判定・fd-slots非表示CSSの発火条件そのもの)。
  it.each([
    [{ keyboardVisible: false, padVisible: false, trackpadVisible: false }, false],
    [{ keyboardVisible: true, padVisible: false, trackpadVisible: false }, true],
    [{ keyboardVisible: false, padVisible: true, trackpadVisible: false }, true],
    [{ keyboardVisible: false, padVisible: false, trackpadVisible: true }, true],
    [{ keyboardVisible: true, padVisible: true, trackpadVisible: true }, true],
  ] as const)('%o → chipVisible=%s', (state, expected) => {
    expect(inputPanelUiState(state).chipVisible).toBe(expected);
  });
});

describe('applyInputPanelTransition', () => {
  it('キーボードからパッドへ切り替える前にsoftkeyboard由来のキーを解放する', () => {
    const log: string[] = [];
    const next = applyInputPanelTransition(
      { keyboardVisible: true, padVisible: false, trackpadVisible: false },
      'pad',
      actions(log),
    );
    expect(next).toEqual({ keyboardVisible: false, padVisible: true, trackpadVisible: false });
    expect(log).toEqual(['release-keyboard', 'keyboard-false', 'pad-true']);
  });

  it('パッドからキーボードへ切り替える前にvpad由来のキーを解放する', () => {
    const log: string[] = [];
    const next = applyInputPanelTransition(
      { keyboardVisible: false, padVisible: true, trackpadVisible: false },
      'keyboard',
      actions(log),
    );
    expect(next).toEqual({ keyboardVisible: true, padVisible: false, trackpadVisible: false });
    expect(log).toEqual(['release-pad', 'pad-false', 'keyboard-true']);
  });

  it('キーボードからトラックパッドへ切り替える前にsoftkeyboard由来のキーを解放する', () => {
    const log: string[] = [];
    const next = applyInputPanelTransition(
      { keyboardVisible: true, padVisible: false, trackpadVisible: false },
      'trackpad',
      actions(log),
    );
    expect(next).toEqual({ keyboardVisible: false, padVisible: false, trackpadVisible: true });
    expect(log).toEqual(['release-keyboard', 'keyboard-false', 'trackpad-true']);
  });

  it('トラックパッドから閉じるときは押し込み中のボタンを解放してから非表示化する', () => {
    const log: string[] = [];
    const next = applyInputPanelTransition(
      { keyboardVisible: false, padVisible: false, trackpadVisible: true },
      'closed',
      actions(log),
    );
    expect(next).toEqual({ keyboardVisible: false, padVisible: false, trackpadVisible: false });
    expect(log).toEqual(['release-trackpad', 'trackpad-false']);
  });

  it('トラックパッドからパッドへ切り替える前にトラックパッド由来のボタンを解放する', () => {
    const log: string[] = [];
    const next = applyInputPanelTransition(
      { keyboardVisible: false, padVisible: false, trackpadVisible: true },
      'pad',
      actions(log),
    );
    expect(next).toEqual({ keyboardVisible: false, padVisible: true, trackpadVisible: false });
    expect(log).toEqual(['release-trackpad', 'trackpad-false', 'pad-true']);
  });

  it('全閉時は表示中の全入力源を解放する', () => {
    const log: string[] = [];
    applyInputPanelTransition(
      { keyboardVisible: true, padVisible: true, trackpadVisible: true },
      'closed',
      actions(log),
    );
    expect(log).toEqual([
      'release-keyboard',
      'keyboard-false',
      'release-pad',
      'pad-false',
      'release-trackpad',
      'trackpad-false',
    ]);
  });
});
