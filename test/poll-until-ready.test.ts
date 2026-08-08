import { describe, expect, it, vi } from 'vitest';
import { pollUntilReady } from '../src/api/webnp2.ts';

/**
 * waitForFddReady()の中身を単体テストするための切り出し(pollUntilReady)。
 *
 * 実物のバグ: 従来実装は「壁時計10秒」だけを打ち切り条件にしていた。コード自身の
 * コメントには「挿入遅延はエミュレート1フレームごとに減るので実時間の待ちでは
 * 足りる保証がない(スロットル中は特に)」と書いてあったのに、打ち切りだけ壁時計基準
 * のままだった。CPU 4倍スロットリング下の実測(PC98Dev側)では、この不一致のせいで
 * 「エミュレータがまだ準備できていないのに壁時計だけは進んでしまう」状況を生み、
 * 呼び出し側(insertFd)がfalseを黙って無視して先へ進んでいた。
 */
describe('pollUntilReady', () => {
  it('isReadyが最初から true なら即座に true を返す', async () => {
    const raf = vi.fn();
    const result = await pollUntilReady({ isReady: () => true, raf });
    expect(result).toBe(true);
    expect(raf).not.toHaveBeenCalled();
  });

  it('rafがN回進んだあとにisReadyがtrueになれば true を返す', async () => {
    let ticks = 0;
    const raf = (cb: () => void) => { queueMicrotask(cb); };
    const result = await pollUntilReady({
      isReady: () => { ticks += 1; return ticks >= 5; },
      raf,
      timeoutMs: 999_999_999, // 壁時計はここでは効かせない
      maxIdleFrames: 999_999_999,
    });
    expect(result).toBe(true);
    // pollUntilReady()は最初に一度isReady()を素通しで見てから raf ループへ入るため、
    // isReady呼び出し回数は「trueになるまでの試行5回目」+「事前の1回」で6になる。
    expect(ticks).toBe(6);
  });

  /**
   * 「エミュレータが進まない」状況を、rafは呼ばれ続けるが isReady が絶対に true に
   * ならない(=フレームを何回消費しても準備完了フラグが立たない)形で再現する。
   * 新実装はmaxIdleFramesを主たる基準にしているので、壁時計を天文学的に長くしても
   * フレーム予算を使い切った時点で速やかに諦める。
   *
   * 旧実装(壁時計 Date.now() だけを見るループ)をこのテストにそのまま置き換えると、
   * timeoutMsが尽きるまで(ここでは意図的に巨大な値)実際に待ち続けてしまい、
   * テストがタイムアウトするか非常に長く掛かる。つまり「壁時計だけでは
   * エミュレータが進んでいないことを検出できない」を実測で示せる。
   */
  it('rafは進むがisReadyが立たないまま(エミュレータが進まない)なら、' +
    'フレーム予算(maxIdleFrames)だけで壁時計を待たずに false へ諦める', async () => {
    let rafCalls = 0;
    const raf = (cb: () => void) => { rafCalls += 1; queueMicrotask(cb); };
    const start = Date.now();
    const result = await pollUntilReady({
      isReady: () => false, // 何回フレームが進んでも絶対に準備完了しない
      raf,
      timeoutMs: 999_999_999, // 壁時計は実質無限大 - もし壁時計基準だったらテストが終わらない
      maxIdleFrames: 8,
    });
    const elapsedMs = Date.now() - start;
    expect(result).toBe(false);
    expect(rafCalls).toBe(8);
    // 壁時計は使っていないので、実時間はテスト実行のオーバーヘッド程度で収まるはず。
    expect(elapsedMs).toBeLessThan(2_000);
  });

  /**
   * rafそのものが一度も呼ばれない(タブが完全に凍結した等)場合の保険。
   * フレーム基準では検出しようがないので、壁時計がここで唯一の救済策になる。
   */
  it('rafが一度も呼ばれなくても、壁時計のtimeoutMsで諦める(保険)', async () => {
    const raf = vi.fn(); // 一度も呼び出されない = フレームが一切進まない
    const result = await pollUntilReady({
      isReady: () => false,
      raf,
      timeoutMs: 20,
      maxIdleFrames: 999_999_999, // フレーム基準は実質無効化
    });
    expect(result).toBe(false);
    expect(raf).toHaveBeenCalledTimes(1); // 最初の1回だけは呼ばれる(以降進まない)
  });

  it('打ち切り直前にisReadyがtrueになれば、打ち切りではなくtrueを返す', async () => {
    let rafCalls = 0;
    const raf = (cb: () => void) => { rafCalls += 1; queueMicrotask(cb); };
    const result = await pollUntilReady({
      isReady: () => rafCalls >= 3,
      raf,
      timeoutMs: 999_999_999,
      maxIdleFrames: 3,
    });
    expect(result).toBe(true);
  });
});
