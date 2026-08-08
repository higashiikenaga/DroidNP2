import { describe, expect, it } from 'vitest';
import { Bridge } from '../src/api/bridge.ts';
import { SharedKeyInput } from '../src/api/shared-key-input.ts';
import type { WebNP2 } from '../src/api/webnp2.ts';

// Bridge('key'コマンド)がSharedKeyInput経由になったことの回帰テスト。
// 実機のWebNP2/canvasは不要('key'コマンドはnp2.isBooted()とSharedKeyInputしか触らない)なので、
// isBooted()だけを持つ最小限のフェイクで代用する(gamepad-ui.test.tsのSharedKeyInput単体テストと同じ流儀)。
function makeFakeNp2(): WebNP2 {
  return { isBooted: () => true } as unknown as WebNP2;
}

describe('Bridge×SharedKeyInput統一: 自動化API(bridge:key)もソフトキーボード/ゲームパッドと同じ参照カウントに乗る', () => {
  it('bridgeが押している最中にsoftkeyboardが同じキーを押して離しても、コアへbreakは送られない', async () => {
    const calls: Array<{ code: number; down: boolean }> = [];
    const sharedKeyInput = new SharedKeyInput((code, down) => calls.push({ code, down }));
    const bridge = new Bridge(makeFakeNp2(), {} as unknown as HTMLCanvasElement, sharedKeyInput);

    await bridge.exec('key', { code: 0x29, down: true }); // bridgeがZを押しっぱなし
    expect(calls).toEqual([{ code: 0x29, down: true }]);

    sharedKeyInput.press('softkeyboard', 0x29); // 同じZをsoftkeyboardも押す
    expect(calls).toEqual([{ code: 0x29, down: true }]); // 参照カウントのみ増加、makeは再送されない

    sharedKeyInput.release('softkeyboard', 0x29); // softkeyboard側だけ離す
    // bridge側がまだ押しているため、breakは送られない(=ゲスト側でキーが上がらない)。
    expect(calls).toEqual([{ code: 0x29, down: true }]);
  });

  it('両方が離したときに初めてbreakが送られる', async () => {
    const calls: Array<{ code: number; down: boolean }> = [];
    const sharedKeyInput = new SharedKeyInput((code, down) => calls.push({ code, down }));
    const bridge = new Bridge(makeFakeNp2(), {} as unknown as HTMLCanvasElement, sharedKeyInput);

    await bridge.exec('key', { code: 0x29, down: true });
    sharedKeyInput.press('softkeyboard', 0x29);
    calls.length = 0;

    sharedKeyInput.release('softkeyboard', 0x29);
    expect(calls).toEqual([]); // bridge側がまだ押しているので送られない

    await bridge.exec('key', { code: 0x29, down: false }); // bridge側も離す
    expect(calls).toEqual([{ code: 0x29, down: false }]); // 最後の入力源が離れて初めてbreak
  });

  it('未起動(isBooted=false)でkeyコマンドを送るとエラーになる(np2.sendKey直呼び出し時代の挙動を踏襲)', async () => {
    const sharedKeyInput = new SharedKeyInput(() => {});
    const notBooted = { isBooted: () => false } as unknown as WebNP2;
    const bridge = new Bridge(notBooted, {} as unknown as HTMLCanvasElement, sharedKeyInput);

    await expect(bridge.exec('key', { code: 0x29, down: true })).rejects.toThrow('not booted');
  });
});
