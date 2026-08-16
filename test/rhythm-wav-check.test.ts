// リズム波形WAV登録時検査(src/api/roms.ts の checkRhythmWav)の単体テスト。
//
// 前提となる事実(NP2kai/sound/fmgen/fmgen_opna.cpp の LoadRhythmSample() を精読済み):
// - fmgenは0x10を「fmtチャンクのサイズ」位置として決め打ちで読む
//   (標準的なRIFF/WAVEでは0x0cに"fmt "チャンクIDが来る前提)。
// - tag!=1 または nch!=1 または (dataサイズ/2)>=0x100000 なら、6本のうち1本でも
//   該当すると全リズム波形が破棄され無音になる。
// - dataチャンクを探す走査ループにはEOFガードが無く、dataチャンクが無いファイルだと
//   無限ループ(コアのハング)になりうる。checkRhythmWav はここに上限を設けて防いでいる。
// - bps==16 はfmgen本体が明示チェックしていない独自条件(fmgenはint16として無条件に読むため、
//   これが無いとノイズとして再生される壊れ方をする)。fmgenより1条件だけ厳しい。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkRhythmWav } from '../src/api/roms.ts';

/** テスト用WAVバイト列を組み立てる。fmt/dataとも標準的な16バイトfmtチャンクの配置。 */
function buildWav(opts: {
  tag?: number;
  nch?: number;
  bps?: number;
  sampleCount?: number; // dataチャンクに書き込むint16サンプル数
  omitDataChunk?: boolean;
  riff?: string;
  wave?: string;
  fmtId?: string;
}): Uint8Array {
  const tag = opts.tag ?? 1;
  const nch = opts.nch ?? 1;
  const bps = opts.bps ?? 16;
  const sampleCount = opts.sampleCount ?? 4;
  const dataBytes = sampleCount * 2;
  // omitDataChunk時も、fmtヘッダ本体(FMT_HEADER_SIZE=22バイト)は読める長さを確保しつつ、
  // "data"チャンクが存在しないファイル(パディングのみ)を作る。
  const bodyLen = opts.omitDataChunk ? 16 : 8 + dataBytes;
  const totalSize = 12 + 24 + bodyLen; // RIFF header以降
  const buf = new ArrayBuffer(12 + 24 + bodyLen);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const writeAscii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[offset + i] = s.charCodeAt(i);
  };
  writeAscii(0, (opts.riff ?? 'RIFF').padEnd(4, '\0').slice(0, 4));
  view.setUint32(4, totalSize, true);
  writeAscii(8, (opts.wave ?? 'WAVE').padEnd(4, '\0').slice(0, 4));
  writeAscii(12, (opts.fmtId ?? 'fmt ').padEnd(4, '\0').slice(0, 4));
  view.setUint32(16, 16, true); // fmtチャンクサイズ(標準PCMの16バイト)
  view.setUint16(20, tag, true);
  view.setUint16(22, nch, true);
  view.setUint32(24, 44100, true); // rate
  view.setUint32(28, 44100 * 2, true); // avgbytes
  view.setUint16(32, 2, true); // align
  view.setUint16(34, bps, true);
  // 0x24(36) には whdr.size (拡張フィールド)が来るが、16バイトfmtチャンクには実体が無く、
  // 標準的な次チャンク("data"のID)がここに来る。fmgenはここも構造体の一部として読むが、
  // 値自体は判定に使わないため未初期化(0)のままでよい。
  if (!opts.omitDataChunk) {
    writeAscii(36, 'data');
    view.setUint32(40, dataBytes, true);
  }
  return bytes;
}

describe('checkRhythmWav', () => {
  it('同梱の実ファイル(2608_bd.wav)はOK判定になる(検査が厳しすぎないことの確認)', () => {
    const path = resolve(__dirname, '../public/rhythm/2608_bd.wav');
    const bytes = new Uint8Array(readFileSync(path));
    const result = checkRhythmWav(bytes);
    expect(result).toEqual({ ok: true });
  });

  it('正しいWAV(モノラル16bitリニアPCM)はOK判定になる', () => {
    const bytes = buildWav({});
    expect(checkRhythmWav(bytes)).toEqual({ ok: true });
  });

  it('RIFF/WAVEマジックが無ければ not-riff-wave', () => {
    const bytes = buildWav({ riff: 'XXXX' });
    expect(checkRhythmWav(bytes)).toEqual({ ok: false, reason: 'not-riff-wave' });
  });

  it('0x0cにfmtチャンクが無ければ no-fmt-chunk', () => {
    const bytes = buildWav({ fmtId: 'xxxx' });
    expect(checkRhythmWav(bytes)).toEqual({ ok: false, reason: 'no-fmt-chunk' });
  });

  it('tag!=1(非リニアPCM)なら not-linear-pcm', () => {
    const bytes = buildWav({ tag: 2 });
    expect(checkRhythmWav(bytes)).toEqual({ ok: false, reason: 'not-linear-pcm' });
  });

  it('ステレオ(nch!=1)なら not-mono', () => {
    const bytes = buildWav({ nch: 2 });
    expect(checkRhythmWav(bytes)).toEqual({ ok: false, reason: 'not-mono' });
  });

  it('8bit(bps!=16)なら not-16bit(fmgen本体には無い独自条件)', () => {
    const bytes = buildWav({ bps: 8 });
    expect(checkRhythmWav(bytes)).toEqual({ ok: false, reason: 'not-16bit' });
  });

  it('dataチャンクが無ければ no-data-chunk(かつ無限ループしない)', () => {
    const bytes = buildWav({ omitDataChunk: true });
    const start = Date.now();
    const result = checkRhythmWav(bytes);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result).toEqual({ ok: false, reason: 'no-data-chunk' });
  });

  it('サンプル数上限(0x100000)以上なら too-many-samples(境界値ちょうど)', () => {
    const bytes = buildWav({ sampleCount: 0x100000 });
    expect(checkRhythmWav(bytes)).toEqual({ ok: false, reason: 'too-many-samples' });
  });

  it('サンプル数が上限未満ならOK(境界値: 0x100000-1)', () => {
    const bytes = buildWav({ sampleCount: 0x100000 - 1 });
    expect(checkRhythmWav(bytes)).toEqual({ ok: true });
  });
});
