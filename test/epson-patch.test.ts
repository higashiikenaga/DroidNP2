import { describe, expect, it } from 'vitest';
import { isPatchableDiskImage, patchEpsonCheck } from '../src/api/epson-patch.ts';

describe('patchEpsonCheck', () => {
  it('NOPs a short Jcc found right after INT 1Dh', () => {
    // MOV AH,0 ; INT 1Dh ; TEST AL,80h ; JZ +5
    const bytes = new Uint8Array([0xb4, 0x00, 0xcd, 0x1d, 0xa8, 0x80, 0x74, 0x05]);
    const { bytes: patched, patches } = patchEpsonCheck(bytes);
    expect(patches).toHaveLength(1);
    expect(patches[0].offset).toBe(6);
    expect(patches[0].originalBytes).toEqual([0x74, 0x05]);
    expect(Array.from(patched.subarray(6, 8))).toEqual([0x90, 0x90]);
    // 元の入力は変更されない
    expect(Array.from(bytes.subarray(6, 8))).toEqual([0x74, 0x05]);
  });

  it('NOPs a near Jcc (0F 8x) found after INT 1Dh', () => {
    const bytes = new Uint8Array([0xcd, 0x1d, 0x90, 0x0f, 0x84, 0x10, 0x00]);
    const { bytes: patched, patches } = patchEpsonCheck(bytes);
    expect(patches).toHaveLength(1);
    expect(patches[0].offset).toBe(3);
    expect(Array.from(patched.subarray(3, 7))).toEqual([0x90, 0x90, 0x90, 0x90]);
  });

  it('leaves bytes untouched when there is no Jcc within lookahead', () => {
    const bytes = new Uint8Array([0xcd, 0x1d, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90, 0x74, 0x02]);
    const { bytes: patched, patches } = patchEpsonCheck(bytes);
    expect(patches).toHaveLength(0);
    expect(Array.from(patched)).toEqual(Array.from(bytes));
  });

  it('leaves bytes untouched when INT 1Dh never appears', () => {
    const bytes = new Uint8Array([0x74, 0x02, 0xb4, 0x00, 0xcd, 0x21]);
    const { patches } = patchEpsonCheck(bytes);
    expect(patches).toHaveLength(0);
  });

  it('does not double-patch overlapping matches', () => {
    const bytes = new Uint8Array([0xcd, 0x1d, 0x74, 0x02, 0xcd, 0x1d, 0x75, 0x03]);
    const { patches } = patchEpsonCheck(bytes);
    expect(patches).toHaveLength(2);
    expect(patches.map((p) => p.offset)).toEqual([2, 6]);
  });
});

describe('isPatchableDiskImage', () => {
  it('matches common PC-98 disk image extensions', () => {
    expect(isPatchableDiskImage('GAME.D88')).toBe(true);
    expect(isPatchableDiskImage('hdd.thd')).toBe(true);
    expect(isPatchableDiskImage('boot.hdi')).toBe(true);
  });

  it('rejects non-disk-image names', () => {
    expect(isPatchableDiskImage('readme.txt')).toBe(false);
    expect(isPatchableDiskImage('archive.zip')).toBe(false);
  });
});
