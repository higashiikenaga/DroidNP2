// YM2608リズム波形の代替音同梱(src/api/roms.ts)と大文字名複製(src/core/module.ts)の単体テスト。
//
// 前提となる事実(再調査済み・実装コメント参照):
// - 実際にリズム波形を読むのはfmgen(FM::OPNA::LoadRhythmSample())で、大文字の
//   2608_BD.WAV等しか探さない。既存のROM登録経路は小文字保存のため、大文字名も
//   複製しないと利用者登録でも同梱代替でも鳴らない。
// - fmgenは6本のうち1本でも開けないと全部を破棄するため、優先順位のマージも
//   6本まとめて扱えることを確認する。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { rhythmUpperCaseAliasFor, RHYTHM_WAV_NAMES } from '../src/core/module.ts';
import { loadBundledRhythmWavs, mergeRhythmDefaults } from '../src/api/roms.ts';
import type { DiskFile } from '../src/core/module.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mergeRhythmDefaults', () => {
  it('登録が無ければ同梱をすべて採用する', () => {
    const bundled: DiskFile[] = RHYTHM_WAV_NAMES.map((name) => ({
      name,
      bytes: new Uint8Array([1]),
    }));
    const merged = mergeRhythmDefaults([], bundled);
    expect(merged).toEqual(bundled);
  });

  it('全名登録済みなら同梱は1つも採用しない', () => {
    const registered: DiskFile[] = RHYTHM_WAV_NAMES.map((name) => ({
      name,
      bytes: new Uint8Array([2]),
    }));
    const bundled: DiskFile[] = RHYTHM_WAV_NAMES.map((name) => ({
      name,
      bytes: new Uint8Array([1]),
    }));
    const merged = mergeRhythmDefaults(registered, bundled);
    expect(merged).toEqual(registered);
    expect(merged.every((f) => f.bytes[0] === 2)).toBe(true);
  });

  it('一部だけ登録済みなら未登録の名前だけ同梱で埋める(混在)', () => {
    const registered: DiskFile[] = [{ name: '2608_bd.wav', bytes: new Uint8Array([9]) }];
    const bundled: DiskFile[] = RHYTHM_WAV_NAMES.map((name) => ({
      name,
      bytes: new Uint8Array([1]),
    }));
    const merged = mergeRhythmDefaults(registered, bundled);
    expect(merged).toHaveLength(RHYTHM_WAV_NAMES.length);
    const bd = merged.find((f) => f.name === '2608_bd.wav');
    expect(bd?.bytes[0]).toBe(9); // 登録済み側が優先される
    const sd = merged.find((f) => f.name === '2608_sd.wav');
    expect(sd?.bytes[0]).toBe(1); // 未登録は同梱で埋まる
  });

  it('大文字小文字の違いは同一名として扱う(登録優先の判定)', () => {
    const registered: DiskFile[] = [{ name: '2608_BD.WAV', bytes: new Uint8Array([9]) }];
    const bundled: DiskFile[] = [{ name: '2608_bd.wav', bytes: new Uint8Array([1]) }];
    const merged = mergeRhythmDefaults(registered, bundled);
    expect(merged).toEqual(registered);
  });

  it('リズム波形以外(bios.rom等)はそのまま素通りする', () => {
    const registered: DiskFile[] = [{ name: 'bios.rom', bytes: new Uint8Array([3]) }];
    const merged = mergeRhythmDefaults(registered, []);
    expect(merged).toEqual(registered);
  });
});

describe('loadBundledRhythmWavs', () => {
  it('6本すべてを相対パス(./rhythm/名前)からfetchしてDiskFile[]で返す', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const name = url.replace('./rhythm/', '');
      return {
        ok: true,
        arrayBuffer: async () => new Uint8Array([name.length]).buffer,
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const files = await loadBundledRhythmWavs();

    expect(files).toHaveLength(RHYTHM_WAV_NAMES.length);
    expect(new Set(files.map((f) => f.name))).toEqual(new Set(RHYTHM_WAV_NAMES));
    expect(fetchMock).toHaveBeenCalledTimes(RHYTHM_WAV_NAMES.length);
    for (const name of RHYTHM_WAV_NAMES) {
      expect(fetchMock).toHaveBeenCalledWith(`./rhythm/${name}`);
    }
  });

  it('一部のfetchが失敗(404等)しても、他の分は結果に残る', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('2608_rim.wav')) {
        return { ok: false } as Response;
      }
      return {
        ok: true,
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const files = await loadBundledRhythmWavs();

    expect(files).toHaveLength(RHYTHM_WAV_NAMES.length - 1);
    expect(files.some((f) => f.name === '2608_rim.wav')).toBe(false);
  });

  it('fetch自体が例外を投げても他の分は結果に残る', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('2608_hh.wav')) {
        throw new Error('network error');
      }
      return {
        ok: true,
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const files = await loadBundledRhythmWavs();

    expect(files).toHaveLength(RHYTHM_WAV_NAMES.length - 1);
    expect(files.some((f) => f.name === '2608_hh.wav')).toBe(false);
  });
});

describe('rhythmUpperCaseAliasFor', () => {
  it('リズム波形6本は大文字名を返す', () => {
    for (const name of RHYTHM_WAV_NAMES) {
      expect(rhythmUpperCaseAliasFor(name)).toBe(name.toUpperCase());
    }
    expect(rhythmUpperCaseAliasFor('2608_bd.wav')).toBe('2608_BD.WAV');
    expect(rhythmUpperCaseAliasFor('2608_rim.wav')).toBe('2608_RIM.WAV');
  });

  it('リズム波形以外はundefinedを返す(bios.rom等は複製しない)', () => {
    expect(rhythmUpperCaseAliasFor('bios.rom')).toBeUndefined();
    expect(rhythmUpperCaseAliasFor('font.rom')).toBeUndefined();
    expect(rhythmUpperCaseAliasFor('2608_bd.mp3')).toBeUndefined();
  });
});
