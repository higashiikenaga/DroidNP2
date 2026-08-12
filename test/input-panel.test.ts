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
    setKeyboardVisible: vi.fn((visible) => log.push(`keyboard-${visible}`)),
    setPadVisible: vi.fn((visible) => log.push(`pad-${visible}`)),
  };
}

describe('inputPanelUiState', () => {
  it('両方とも非表示ならチップを出さない', () => {
    expect(inputPanelUiState({ keyboardVisible: false, padVisible: false })).toEqual({
      chipVisible: false,
      keyboardPressed: false,
      padPressed: false,
    });
  });

  it.each([
    [{ keyboardVisible: true, padVisible: false }, true, false],
    [{ keyboardVisible: false, padVisible: true }, false, true],
  ] as const)('いずれかが表示中ならチップと対応する押下状態を出す', (state, keyboardPressed, padPressed) => {
    expect(inputPanelUiState(state)).toEqual({ chipVisible: true, keyboardPressed, padPressed });
  });
});

describe('applyInputPanelTransition', () => {
  it('キーボードからパッドへ切り替える前にsoftkeyboard由来のキーを解放する', () => {
    const log: string[] = [];
    const next = applyInputPanelTransition({ keyboardVisible: true, padVisible: false }, 'pad', actions(log));
    expect(next).toEqual({ keyboardVisible: false, padVisible: true });
    expect(log).toEqual(['release-keyboard', 'keyboard-false', 'pad-true']);
  });

  it('パッドからキーボードへ切り替える前にvpad由来のキーを解放する', () => {
    const log: string[] = [];
    const next = applyInputPanelTransition({ keyboardVisible: false, padVisible: true }, 'keyboard', actions(log));
    expect(next).toEqual({ keyboardVisible: true, padVisible: false });
    expect(log).toEqual(['release-pad', 'pad-false', 'keyboard-true']);
  });

  it('全閉時は表示中の両入力源を解放する', () => {
    const log: string[] = [];
    applyInputPanelTransition({ keyboardVisible: true, padVisible: true }, 'closed', actions(log));
    expect(log).toEqual(['release-keyboard', 'keyboard-false', 'release-pad', 'pad-false']);
  });
});
