// PC-98配列ソフトキーボードのキー配列定義。
// player.ts(ソフトキーボード本体)と、後続タスクで作るパッド割当ピッカーの両方から参照する
// 共通モジュールとして切り出したもの。スキャンコードは NP2kai sdl/kbtrans.c を出典とする。

export interface KbdKeyDef {
  label: string;
  code: number;
  w?: number;
  mod?: 'oneshot' | 'lock';
}

// PC-98配列ソフトキーボードのキー定義(np2側キーコード)。
// index 0..6 が通常キーボード部、index 7以降(KBD_TENKEY_ROW_START〜)がテンキーブロック。
// テンキーは通常の数字キー行と見分けが付くよう、player.ts側で別のCSSクラス(kbd-row-tenkey)を
// 付与して描画する(通常行と同じ KbdKeyDef[][] のまま行を追加しているだけなので、この配列自体の
// 型・描画ループは変えていない)。
export const KBD_ROWS: KbdKeyDef[][] = [
  [
    { label: 'ESC', code: 0x00 },
    { label: 'F1', code: 0x62 },
    { label: 'F2', code: 0x63 },
    { label: 'F3', code: 0x64 },
    { label: 'F4', code: 0x65 },
    { label: 'F5', code: 0x66 },
    { label: 'F6', code: 0x67 },
    { label: 'F7', code: 0x68 },
    { label: 'F8', code: 0x69 },
    { label: 'F9', code: 0x6a },
    { label: 'F10', code: 0x6b },
    { label: 'STOP', code: 0x60 },
  ],
  [
    { label: '1', code: 0x01 },
    { label: '2', code: 0x02 },
    { label: '3', code: 0x03 },
    { label: '4', code: 0x04 },
    { label: '5', code: 0x05 },
    { label: '6', code: 0x06 },
    { label: '7', code: 0x07 },
    { label: '8', code: 0x08 },
    { label: '9', code: 0x09 },
    { label: '0', code: 0x0a },
    { label: '-', code: 0x0b },
    { label: '^', code: 0x0c },
    { label: '\\', code: 0x0d },
    { label: 'BS', code: 0x0e, w: 1.4 },
  ],
  [
    { label: 'TAB', code: 0x0f, w: 1.4 },
    { label: 'Q', code: 0x10 },
    { label: 'W', code: 0x11 },
    { label: 'E', code: 0x12 },
    { label: 'R', code: 0x13 },
    { label: 'T', code: 0x14 },
    { label: 'Y', code: 0x15 },
    { label: 'U', code: 0x16 },
    { label: 'I', code: 0x17 },
    { label: 'O', code: 0x18 },
    { label: 'P', code: 0x19 },
    { label: '@', code: 0x1a },
    { label: '[', code: 0x1b },
    { label: 'RET', code: 0x1c, w: 1.4 },
  ],
  [
    { label: 'CTRL', code: 0x74, w: 1.8, mod: 'oneshot' },
    { label: 'A', code: 0x1d },
    { label: 'S', code: 0x1e },
    { label: 'D', code: 0x1f },
    { label: 'F', code: 0x20 },
    { label: 'G', code: 0x21 },
    { label: 'H', code: 0x22 },
    { label: 'J', code: 0x23 },
    { label: 'K', code: 0x24 },
    { label: 'L', code: 0x25 },
    { label: ';', code: 0x26 },
    { label: ':', code: 0x27 },
    { label: ']', code: 0x28 },
  ],
  [
    { label: 'SHIFT', code: 0x70, w: 2, mod: 'oneshot' },
    { label: 'Z', code: 0x29 },
    { label: 'X', code: 0x2a },
    { label: 'C', code: 0x2b },
    { label: 'V', code: 0x2c },
    { label: 'B', code: 0x2d },
    { label: 'N', code: 0x2e },
    { label: 'M', code: 0x2f },
    { label: ',', code: 0x30 },
    { label: '.', code: 0x31 },
    { label: '/', code: 0x32 },
    { label: '_', code: 0x33 },
  ],
  [
    { label: 'CAPS', code: 0x71, mod: 'lock' },
    { label: 'かな', code: 0x72, mod: 'lock' },
    { label: 'GRPH', code: 0x73, mod: 'oneshot' },
    { label: 'NFER', code: 0x51 },
    { label: 'SPACE', code: 0x34, w: 3.5 },
    { label: 'XFER', code: 0x35 },
    { label: 'INS', code: 0x38 },
    { label: 'DEL', code: 0x39 },
  ],
  [
    { label: 'RUP', code: 0x36 },
    { label: 'RDN', code: 0x37 },
    { label: 'HOME', code: 0x3e },
    { label: 'HELP', code: 0x3f },
    { label: '←', code: 0x3b },
    { label: '↓', code: 0x3d },
    { label: '↑', code: 0x3a },
    { label: '→', code: 0x3c },
  ],
  // --- ここからテンキーブロック(実機配列、出典: NP2kai sdl/kbtrans.c:109-126) ---
  [
    { label: '-', code: 0x40 },
    { label: '/', code: 0x41 },
    { label: '7', code: 0x42 },
    { label: '8', code: 0x43 },
    { label: '9', code: 0x44 },
    { label: '*', code: 0x45 },
  ],
  [
    { label: '4', code: 0x46 },
    { label: '5', code: 0x47 },
    { label: '6', code: 0x48 },
    { label: '+', code: 0x49 },
  ],
  [
    { label: '1', code: 0x4a },
    { label: '2', code: 0x4b },
    { label: '3', code: 0x4c },
    { label: '=', code: 0x4d },
  ],
  [
    { label: '0', code: 0x4e },
    { label: ',', code: 0x4f },
    { label: '.', code: 0x50 },
  ],
];

/** KBD_ROWS のうち、この index 以降がテンキーブロック(通常キーと分けてCSS装飾するための境界)。 */
export const KBD_TENKEY_ROW_START = 7;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
}

export interface KbdRowElements {
  /** kbd-panel へそのまま append できる行要素(kbd-row / kbd-row-tenkey)。 */
  rows: HTMLDivElement[];
  /** 各キーのDOM(kbd-key)と対応する定義。イベント配線は呼び出し側の責務。 */
  buttons: Array<{ def: KbdKeyDef; button: HTMLButtonElement }>;
}

/**
 * KBD_ROWS を実際のDOM(行/ボタン)へ変換する共通処理。
 * player.ts(ソフトキーボード本体、押下でキー送信・oneshot修飾の自動解除などの挙動を持つ)と
 * gamepad-ui.ts(パッド割当ピッカー、押下でキーを「選択」するだけで送信はしない)の両方から
 * 同じ見た目(クラス名・flex幅)を作るために切り出した。イベントリスナーは一切付けない
 * (呼び出し側ごとに挙動が全く異なるため、ここに混ぜると両方の意図が読めなくなる)。
 */
export function buildKbdRows(): KbdRowElements {
  const rows: HTMLDivElement[] = [];
  const buttons: Array<{ def: KbdKeyDef; button: HTMLButtonElement }> = [];
  KBD_ROWS.forEach((row, rowIndex) => {
    const isTenkeyRow = rowIndex >= KBD_TENKEY_ROW_START;
    const rowEl = el('div', { class: isTenkeyRow ? 'kbd-row kbd-row-tenkey' : 'kbd-row' });
    for (const def of row) {
      const keyBtn = el('button', { type: 'button', class: 'kbd-key' }, [def.label]);
      if (def.w) keyBtn.style.flexGrow = String(def.w);
      rowEl.append(keyBtn);
      buttons.push({ def, button: keyBtn });
    }
    rows.push(rowEl);
  });
  return { rows, buttons };
}

/** KBD_ROWS 上の code から表示ラベルを引く(見つからなければ16進表記)。パッド割当ピッカーの表示用。 */
export function labelForKeyCode(code: number): string {
  for (const row of KBD_ROWS) {
    for (const def of row) {
      if (def.code === code) return def.label;
    }
  }
  return `0x${code.toString(16).padStart(2, '0')}`;
}
