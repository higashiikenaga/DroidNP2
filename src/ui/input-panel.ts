export type InputPanelKind = 'keyboard' | 'pad';

export interface InputPanelState {
  keyboardVisible: boolean;
  padVisible: boolean;
}

export interface InputPanelUiState {
  chipVisible: boolean;
  keyboardPressed: boolean;
  padPressed: boolean;
}

export interface InputPanelActions {
  releaseKeyboard(): void;
  releasePad(): void;
  setKeyboardVisible(visible: boolean): void;
  setPadVisible(visible: boolean): void;
}

/** チップの表示条件とaria-pressedを、両パネルの表示状態だけから決める。 */
export function inputPanelUiState(state: InputPanelState): InputPanelUiState {
  return {
    chipVisible: state.keyboardVisible || state.padVisible,
    keyboardPressed: state.keyboardVisible,
    padPressed: state.padVisible,
  };
}

/**
 * 入力パネルを切り替える。閉じる側は非表示化より先に入力源を解放し、
 * 同時表示とゲスト側のキー固着を防ぐ。
 */
export function applyInputPanelTransition(
  current: InputPanelState,
  target: InputPanelKind | 'closed',
  actions: InputPanelActions,
): InputPanelState {
  const next: InputPanelState = {
    keyboardVisible: target === 'keyboard',
    padVisible: target === 'pad',
  };
  if (current.keyboardVisible && !next.keyboardVisible) {
    actions.releaseKeyboard();
    actions.setKeyboardVisible(false);
  }
  if (current.padVisible && !next.padVisible) {
    actions.releasePad();
    actions.setPadVisible(false);
  }
  if (!current.keyboardVisible && next.keyboardVisible) actions.setKeyboardVisible(true);
  if (!current.padVisible && next.padVisible) actions.setPadVisible(true);
  return next;
}
