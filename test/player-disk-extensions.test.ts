// player.ts のディスク種別判定(classifyDroppedFile)の拡張子カバレッジテスト。
// NP2kai本体(NP2kai/sdl/np2.c の np2_isfdimage())が受け付けるFD拡張子に追従しているか、
// および .bin を意図的に除外していることを確認する。
// 実測(2026-08-13): .TFD 2枚入りZIPが「圧縮ファイル内にディスクイメージが見つかりません
// でした」になった不具合の再発防止。

import { describe, expect, it } from 'vitest';
import { classifyDroppedFile } from '../src/ui/player.ts';

// NP2kai/sdl/np2.c の np2_isfdimage() が受け付けるFD拡張子一覧(.bin除く)。
const CORE_FD_EXTENSIONS = [
  '.d88',
  '.d98',
  '.fdi',
  '.hdm',
  '.xdf',
  '.dup',
  '.2hd',
  '.nfd',
  '.fdd',
  '.hd4',
  '.hd5',
  '.hd9',
  '.h01',
  '.hdb',
  '.ddb',
  '.dd6',
  '.dd9',
  '.dcp',
  '.dcu',
  '.flp',
  '.tfd',
  '.fim',
  '.img',
  '.ima',
];

const HDD_EXTENSIONS = ['.thd', '.hdi', '.nhd', '.hdd'];

describe('classifyDroppedFile', () => {
  it('NP2kai本体が受け付けるFD拡張子(.bin除く)を全てFDとして判定する', () => {
    for (const ext of CORE_FD_EXTENSIONS) {
      expect(classifyDroppedFile(`DISK_A${ext}`), `${ext} should classify as fd`).toBe('fd');
      // 大文字拡張子(実測のTFDファイルは大文字だった)も判定できること。
      expect(classifyDroppedFile(`DISK_A${ext.toUpperCase()}`), `${ext.toUpperCase()} should classify as fd`).toBe(
        'fd',
      );
    }
  });

  it('.bin は誤検出防止のため意図的にFD対象外(null)とする', () => {
    expect(classifyDroppedFile('SOMETHING.bin')).toBeNull();
    expect(classifyDroppedFile('SOMETHING.BIN')).toBeNull();
  });

  it('HDD拡張子はFD側と衝突せずHDDとして判定される', () => {
    for (const ext of HDD_EXTENSIONS) {
      expect(classifyDroppedFile(`DISK${ext}`), `${ext} should classify as hdd`).toBe('hdd');
    }
  });

  it('未知の拡張子はnullを返す', () => {
    expect(classifyDroppedFile('readme.txt')).toBeNull();
    expect(classifyDroppedFile('noext')).toBeNull();
  });
});
