import { describe, expect, it } from 'vitest';
import { isTenkeyCode, KBD_ROWS, KBD_TENKEY_ROW_START, labelForKeyCode } from '../src/ui/kbd-layout.ts';

// テンキー各キーの期待コード(出典: NP2kai sdl/kbtrans.c:109-126。推測で書かないこと)。
const EXPECTED_TENKEY_CODES: Record<string, number> = {
  'KP-': 0x40,
  'KP/': 0x41,
  KP7: 0x42,
  KP8: 0x43,
  KP9: 0x44,
  'KP*': 0x45,
  KP4: 0x46,
  KP5: 0x47,
  KP6: 0x48,
  'KP+': 0x49,
  KP1: 0x4a,
  KP2: 0x4b,
  KP3: 0x4c,
  'KP=': 0x4d,
  KP0: 0x4e,
  'KP,': 0x4f,
  'KP.': 0x50,
};

describe('KBD_ROWS', () => {
  it('全キーのcodeが0x00-0x7fの範囲内である', () => {
    for (const row of KBD_ROWS) {
      for (const key of row) {
        expect(key.code).toBeGreaterThanOrEqual(0x00);
        expect(key.code).toBeLessThanOrEqual(0x7f);
      }
    }
  });

  // 同じキーが意図的に複数存在する行はない(通常キーボード部・テンキー部で
  // コード帯が完全に分かれているため、正しく実装されていれば重複は発生しない)。
  it('スキャンコードの重複が無い(意図的な重複キーは存在しない)', () => {
    const seen = new Map<number, string>();
    const duplicates: string[] = [];
    for (const row of KBD_ROWS) {
      for (const key of row) {
        const prevLabel = seen.get(key.code);
        if (prevLabel !== undefined) {
          duplicates.push(`0x${key.code.toString(16)}: ${prevLabel} vs ${key.label}`);
        } else {
          seen.set(key.code, key.label);
        }
      }
    }
    expect(duplicates).toEqual([]);
  });

  it(`KBD_TENKEY_ROW_START(${KBD_TENKEY_ROW_START})以降がテンキーブロック(4行・17キー)である`, () => {
    const tenkeyRows = KBD_ROWS.slice(KBD_TENKEY_ROW_START);
    expect(tenkeyRows).toHaveLength(4);
    const flatKeys = tenkeyRows.flat();
    expect(flatKeys).toHaveLength(17);
  });

  it('テンキーの各キーが実機配列どおりの正しいスキャンコードを持つ', () => {
    const tenkeyRows = KBD_ROWS.slice(KBD_TENKEY_ROW_START);
    // ラベルは通常キーと同じ表記('-', '7'等)を使う設計のため、コード値の集合で照合する
    // (EXPECTED_TENKEY_CODESの値の集合と、テンキー行の全コードの集合が一致することを見る)。
    const actualCodes = tenkeyRows.flat().map((k) => k.code).sort((a, b) => a - b);
    const expectedCodes = Object.values(EXPECTED_TENKEY_CODES).sort((a, b) => a - b);
    expect(actualCodes).toEqual(expectedCodes);

    // 行ごとの構成(実機のテンキー4行配置)も検証する。
    expect(tenkeyRows[0].map((k) => k.code)).toEqual([0x40, 0x41, 0x42, 0x43, 0x44, 0x45]); // -  /  7  8  9  *
    expect(tenkeyRows[1].map((k) => k.code)).toEqual([0x46, 0x47, 0x48, 0x49]); // 4  5  6  +
    expect(tenkeyRows[2].map((k) => k.code)).toEqual([0x4a, 0x4b, 0x4c, 0x4d]); // 1  2  3  =
    expect(tenkeyRows[3].map((k) => k.code)).toEqual([0x4e, 0x4f, 0x50]); // 0  ,  .
  });

  // player.ts はテンキー表示/非表示トグルキーを「テンキー直前の通常行
  // (index KBD_TENKEY_ROW_START - 1)」の末尾へ追加する(kbd-layout.ts/KBD_ROWS自体は
  // ピッカーとの共用のため変更できない設計)。この行が存在しキーを1個以上持つことは
  // トグルキーが実際に置ける前提であり、KBD_ROWSの構成が変わったときに無言で
  // トグルキーが消える回帰を防ぐ。
  it('KBD_TENKEY_ROW_START直前の行が存在し、テンキートグルキーの追加先として使える', () => {
    const row = KBD_ROWS[KBD_TENKEY_ROW_START - 1];
    expect(row).toBeDefined();
    expect(row.length).toBeGreaterThan(0);
  });
});

describe('isTenkeyCode(割り当て一覧のテキスト表示でテンキーと通常キーを区別するための判定)', () => {
  it('0x40〜0x50(テンキーブロックの全キー)はtrue', () => {
    for (let code = 0x40; code <= 0x50; code++) {
      expect(isTenkeyCode(code), `0x${code.toString(16)}`).toBe(true);
    }
  });

  it('テンキーブロック外(0x3f以下・0x51以上)はfalse', () => {
    expect(isTenkeyCode(0x3f)).toBe(false);
    expect(isTenkeyCode(0x51)).toBe(false);
    expect(isTenkeyCode(0x02)).toBe(false); // 通常キーの'2'
    expect(isTenkeyCode(0x00)).toBe(false);
  });

  it('labelForKeyCodeはテンキーと通常キーで同じlabelを返す(ボタン表記は変えない設計の確認)', () => {
    // テンキーの2(0x4b)と通常キーの2(0x02)は同じ'2'を返す。区別が必要なテキスト表示側は
    // isTenkeyCode()と組み合わせて表記を分ける(gamepad-ui.tsのtextLabelForKeyCode参照)。
    expect(labelForKeyCode(0x4b)).toBe('2');
    expect(labelForKeyCode(0x02)).toBe('2');
    expect(labelForKeyCode(0x4b)).toBe(labelForKeyCode(0x02));
  });
});
