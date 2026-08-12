import { describe, expect, it } from 'vitest';
import { SharedKeyInput } from '../src/api/shared-key-input.ts';

// main.ts では SharedKeyInput の出力コールバック1箇所だけが「実際にゲストへ届くキー」の
// 窓口であり、ソフトキーボードの押下表示更新(ui.setKeyIndicator)もこの同じコールバックに
// フックしている。ここでは DOM を持ち出さず、表示更新用のフェイク関数を渡して
// 呼ばれた回数と引数だけを純粋ロジックとして検証する。
describe('SharedKeyInput の出力(単一窓口)による押下表示の更新', () => {
  it('1入力源のpress/releaseで、通知が(code, true)→(code, false)の順に1回ずつ呼ばれる', () => {
    const calls: Array<[number, boolean]> = [];
    const shared = new SharedKeyInput((code, down) => calls.push([code, down]));

    shared.press('softkeyboard', 0x4b); // テンキー2相当
    expect(calls).toEqual([[0x4b, true]]);

    shared.release('softkeyboard', 0x4b);
    expect(calls).toEqual([
      [0x4b, true],
      [0x4b, false],
    ]);
  });

  it('複数入力源が同じキーを押している間、片方が離しても通知(off)は呼ばれない(表示は点いたまま)', () => {
    const calls: Array<[number, boolean]> = [];
    const shared = new SharedKeyInput((code, down) => calls.push([code, down]));

    // ホストキー再割り当て経由の押下(1個目)
    shared.press('hostkey', 0x4b);
    expect(calls).toEqual([[0x4b, true]]);

    // ソフトキーボードのクリック経由の押下(2個目、同じキー)。
    // 参照カウントが1→2になるだけで、既に0→1で通知済みのため追加の通知は無い。
    shared.press('softkeyboard', 0x4b);
    expect(calls).toEqual([[0x4b, true]]);

    // 片方(hostkey)が離しても、もう片方(softkeyboard)がまだ押しているのでoffは呼ばれない。
    shared.release('hostkey', 0x4b);
    expect(calls).toEqual([[0x4b, true]]);

    // 最後の入力源が離して初めてoffが通知される。
    shared.release('softkeyboard', 0x4b);
    expect(calls).toEqual([
      [0x4b, true],
      [0x4b, false],
    ]);
  });

  it('releaseSource/releaseAllでも、他の入力源が保持していれば通知(off)は呼ばれない', () => {
    const calls: Array<[number, boolean]> = [];
    const shared = new SharedKeyInput((code, down) => calls.push([code, down]));

    shared.press('gamepad:pad1', 0x74); // CTRL相当
    shared.press('hostkey', 0x74);
    calls.length = 0; // 以降の呼び出しだけを見る

    shared.releaseSource('gamepad:pad1');
    expect(calls).toEqual([]); // hostkeyがまだ押しているのでoffは呼ばれない

    shared.releaseAll();
    expect(calls).toEqual([[0x74, false]]); // 最後のhostkeyが離れて初めてoff
  });
});
