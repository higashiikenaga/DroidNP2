export type InputPanelKind = 'keyboard' | 'pad' | 'trackpad';

export interface InputPanelState {
  keyboardVisible: boolean;
  padVisible: boolean;
  trackpadVisible: boolean;
}

export interface InputPanelUiState {
  chipVisible: boolean;
  keyboardPressed: boolean;
  padPressed: boolean;
  trackpadPressed: boolean;
}

export interface InputPanelActions {
  releaseKeyboard(): void;
  releasePad(): void;
  releaseTrackpad(): void;
  setKeyboardVisible(visible: boolean): void;
  setPadVisible(visible: boolean): void;
  setTrackpadVisible(visible: boolean): void;
}

/** チップの表示条件とaria-pressedを、3パネルの表示状態だけから決める。 */
export function inputPanelUiState(state: InputPanelState): InputPanelUiState {
  return {
    chipVisible: state.keyboardVisible || state.padVisible || state.trackpadVisible,
    keyboardPressed: state.keyboardVisible,
    padPressed: state.padVisible,
    trackpadPressed: state.trackpadVisible,
  };
}

/**
 * 入力パネルを切り替える。閉じる側は非表示化より先に入力源を解放し、
 * 同時表示とゲスト側のキー固着/ボタン固着を防ぐ。
 */
export function applyInputPanelTransition(
  current: InputPanelState,
  target: InputPanelKind | 'closed',
  actions: InputPanelActions,
): InputPanelState {
  const next: InputPanelState = {
    keyboardVisible: target === 'keyboard',
    padVisible: target === 'pad',
    trackpadVisible: target === 'trackpad',
  };
  if (current.keyboardVisible && !next.keyboardVisible) {
    actions.releaseKeyboard();
    actions.setKeyboardVisible(false);
  }
  if (current.padVisible && !next.padVisible) {
    actions.releasePad();
    actions.setPadVisible(false);
  }
  if (current.trackpadVisible && !next.trackpadVisible) {
    actions.releaseTrackpad();
    actions.setTrackpadVisible(false);
  }
  if (!current.keyboardVisible && next.keyboardVisible) actions.setKeyboardVisible(true);
  if (!current.padVisible && next.padVisible) actions.setPadVisible(true);
  if (!current.trackpadVisible && next.trackpadVisible) actions.setTrackpadVisible(true);
  return next;
}
