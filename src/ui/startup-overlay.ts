export interface StartupOverlayButtons {
  plain: EventTarget;
  freeDos?: EventTarget;
  library: EventTarget;
}

export interface StartupOverlayActions {
  startPlain(): void;
  startFreeDos(): void;
  openLibrary(): void;
}

/**
 * 起動操作は明示的な3ボタンだけへ結び付ける。
 * かつてはオーバーレイの余白クリックも「ディスク無しで起動」扱いにしていたが、
 * ボタンを狙って少し外しただけで意図せず起動する誤爆があるため撤廃した。
 * 同じ理由で将来また足されることのないよう、この経緯をここに残しておく。
 */
export function bindStartupOverlayButtons(
  buttons: StartupOverlayButtons,
  actions: StartupOverlayActions,
): void {
  buttons.plain.addEventListener('click', actions.startPlain);
  buttons.freeDos?.addEventListener('click', actions.startFreeDos);
  buttons.library.addEventListener('click', actions.openLibrary);
}
