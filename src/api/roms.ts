// ローカルROM/素材ファイル登録API。
// デスクトップ版NP2kaiユーザーが手元に持つ BIOS.ROM 等を登録すると、
// IndexedDBにのみ保存され、次回以降の起動時にMEMFSへ自動注入される。

import { RHYTHM_WAV_NAMES } from '../core/module.ts';
import type { DiskFile } from '../core/module.ts';
import * as db from '../storage/db.ts';
import { t } from '../ui/strings.ts';

const ROM_KEY_PREFIX = 'rom:';
const RHYTHM_WAV_NAME_SET: ReadonlySet<string> = new Set(RHYTHM_WAV_NAMES);

// コアが開くファイル名 (すべて小文字)。
const SUPPORTED_ROM_NAMES = new Set([
  'bios.rom',
  'itf.rom',
  'sound.rom',
  'font.rom',
  'bios9821.rom',
  ...RHYTHM_WAV_NAMES,
]);

export interface RomEntry {
  name: string;
  size: number;
  savedAt: number;
}

/** 対応ファイル名かどうかを判定する（既知のファイル名一覧、または .rom 拡張子）。 */
export function isSupportedRomName(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED_ROM_NAMES.has(lower) || lower.endsWith('.rom');
}

// --- リズム波形(2608_*.wav)の登録時WAV検査 -------------------------------------
//
// fmgen (`/NP2kai/sound/fmgen/fmgen_opna.cpp` の `FM::OPNA::LoadRhythmSample()`)は、
// リズム波形6本のうち1本でも下記条件を満たさないと「6本まとめて全部破棄」して
// 無音になる。しかも代替波形へフォールバックさせるのは、利用者が本物を登録した
// つもりで気づけないため不適切。よって登録時にfmgenと同じ条件で検査し、NGなら
// そもそも登録しない(理由を表示する)。

/** fmgenが `fmt ` チャンクの先頭とみなす決め打ちオフセット (実装は0x0cにIDがある前提)。 */
const FMT_CHUNK_OFFSET = 0x0c;
/** fmgenがfmtチャンクの中身(chunksize以降)を読み始める決め打ちオフセット。 */
const FMT_HEADER_OFFSET = 0x10;
/** fmgenが読む構造体のサイズ: chunksize(4)+tag(2)+nch(2)+rate(4)+avgbytes(4)+align(2)+bps(2)+size(2)。 */
const FMT_HEADER_SIZE = 22;
/** fmgenの `fsize >= 0x100000` 判定と同じ上限(int16サンプル数)。 */
const MAX_RHYTHM_SAMPLES = 0x100000;
/**
 * dataチャンク探索の反復回数上限。
 * fmgen本体の探索ループ(`do { Seek(fsize); Read(id,4); Read(size,4); } while(id!="data")`)
 * にはEOFガードが無く、dataチャンクが存在しないファイルだと無限ループ(コアのハング)に
 * なりうる。ここでの検査は同じ走査をするが、上限を設けて自分自身がハングしないようにする。
 */
const MAX_CHUNK_SCAN_ITERATIONS = 10000;

/** リズム波形WAV検査でNGだった理由。区別可能な列挙値として返す。 */
export type RhythmWavRejectReason =
  | 'not-riff-wave'
  | 'no-fmt-chunk'
  | 'not-linear-pcm'
  | 'not-mono'
  | 'no-data-chunk'
  | 'too-many-samples'
  | 'not-16bit';

export type RhythmWavCheckResult = { ok: true } | { ok: false; reason: RhythmWavRejectReason };

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(bytes[offset + i] ?? 0);
  return s;
}

/**
 * リズム波形WAV(2608_*.wav)がfmgenの `LoadRhythmSample()` に受け入れられる形式かを検査する。
 * 単体テストしやすいよう副作用を持たない純関数。判定条件とfmgen側の根拠:
 *
 * 1. `RIFF`(0x00)/`WAVE`(0x08)マジックがある。
 *    fmgen自体はマジックを見ないが、無いと以降の決め打ちオフセット読み取りが無意味になる。
 * 2. 0x0cに`fmt `チャンクがある。
 *    fmgenは0x10を「fmtチャンクのサイズ」位置として決め打ちで読む
 *    (`file.Seek(0x10, ...); file.Read(&whdr, ...)`)。標準的なRIFF/WAVEでは
 *    fmtチャンクIDが0x0cに来る前提でしか成立しない。
 * 3. `tag == 1` (リニアPCM)。fmgen: `whdr.tag != 1` なら6本まとめてbreak。
 * 4. `nch == 1` (モノラル)。fmgen: `whdr.nch != 1` なら6本まとめてbreak。
 * 5. `data`チャンクが存在する。fmgenの探索ループにはEOFガードが無く無限ループしうるため、
 *    ここでは上限付きで走査する(fmgenと同じ判定を安全に行う)。
 * 6. `dataサイズ/2 < 0x100000` (サンプル数上限)。fmgen: `fsize >= 0x100000` ならbreak。
 * 7. `bps == 16`。**これだけfmgen本体は明示チェックしていない独自条件。**
 *    fmgenはdataチャンクの中身を無条件にint16サンプル列として読むため、8bit等の
 *    WAVを登録してもここが無いと「エラーにはならないがノイズが鳴る」状態になる。
 *    利用者が気づきにくい壊れ方を避けるため、fmgenより1条件だけ厳しくしている。
 */
export function checkRhythmWav(bytes: Uint8Array): RhythmWavCheckResult {
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    return { ok: false, reason: 'not-riff-wave' };
  }
  if (
    bytes.length < FMT_HEADER_OFFSET + FMT_HEADER_SIZE ||
    ascii(bytes, FMT_CHUNK_OFFSET, 4) !== 'fmt '
  ) {
    return { ok: false, reason: 'no-fmt-chunk' };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunksize = view.getUint32(FMT_HEADER_OFFSET, true);
  const tag = view.getUint16(FMT_HEADER_OFFSET + 4, true);
  const nch = view.getUint16(FMT_HEADER_OFFSET + 6, true);
  const bps = view.getUint16(FMT_HEADER_OFFSET + 18, true);

  if (tag !== 1) {
    return { ok: false, reason: 'not-linear-pcm' };
  }
  if (nch !== 1) {
    return { ok: false, reason: 'not-mono' };
  }
  if (bps !== 16) {
    return { ok: false, reason: 'not-16bit' };
  }

  // fmtチャンクデータの終端(=次チャンクの開始位置)から、上限付きで data チャンクを探す。
  // fmtチャンクのデータ本体は「id(4バイト)+サイズ(4バイト)」の直後、つまり
  // FMT_CHUNK_OFFSET+8 から始まり、chunksizeバイト続く。
  let pos = FMT_CHUNK_OFFSET + 8 + chunksize;
  let dataSize: number | undefined;
  for (let i = 0; i < MAX_CHUNK_SCAN_ITERATIONS; i++) {
    if (pos + 8 > bytes.length) break;
    const id = ascii(bytes, pos, 4);
    const size = view.getUint32(pos + 4, true);
    if (id === 'data') {
      dataSize = size;
      break;
    }
    pos += 8 + size;
  }
  if (dataSize === undefined) {
    return { ok: false, reason: 'no-data-chunk' };
  }
  if (dataSize / 2 >= MAX_RHYTHM_SAMPLES) {
    return { ok: false, reason: 'too-many-samples' };
  }

  return { ok: true };
}

/** RhythmWavRejectReason を利用者向け文言(現在の言語)に変換する。 */
export function rhythmRejectReasonText(reason: RhythmWavRejectReason): string {
  switch (reason) {
    case 'not-riff-wave':
      return t('rhythmRejectReasonNotRiffWave');
    case 'no-fmt-chunk':
      return t('rhythmRejectReasonNoFmtChunk');
    case 'not-linear-pcm':
      return t('rhythmRejectReasonNotPcm');
    case 'not-mono':
      return t('rhythmRejectReasonNotMono');
    case 'no-data-chunk':
      return t('rhythmRejectReasonNoDataChunk');
    case 'too-many-samples':
      return t('rhythmRejectReasonTooManySamples');
    case 'not-16bit':
      return t('rhythmRejectReasonNot16Bit');
  }
}

/** リズム波形の登録がNGだったファイル。skippedとは別枠で理由を保持する。 */
export interface RejectedRomFile {
  name: string;
  reason: RhythmWavRejectReason;
}

/**
 * 複数ファイルを登録する。
 * - 対応外の拡張子/ファイル名は skipped に振り分ける(従来通り)。
 * - リズム波形6本(2608_*.wav)は checkRhythmWav() を通し、NGなら保存せず rejected に
 *   理由付きで振り分ける(skippedとは区別できる別枠。理由が消えないようにするため)。
 * - リズム波形以外(bios.rom等)の挙動は変えない。
 */
export async function saveRomFiles(
  files: Array<{ name: string; bytes: Uint8Array }>,
): Promise<{ saved: string[]; skipped: string[]; rejected: RejectedRomFile[] }> {
  const saved: string[] = [];
  const skipped: string[] = [];
  const rejected: RejectedRomFile[] = [];
  for (const file of files) {
    const lowerName = file.name.toLowerCase();
    if (!isSupportedRomName(lowerName)) {
      skipped.push(file.name);
      continue;
    }
    if (RHYTHM_WAV_NAME_SET.has(lowerName)) {
      const check = checkRhythmWav(file.bytes);
      if (!check.ok) {
        rejected.push({ name: file.name, reason: check.reason });
        continue;
      }
    }
    await db.put({
      sourceKey: `${ROM_KEY_PREFIX}${lowerName}`,
      name: lowerName,
      bytes: file.bytes.buffer.slice(
        file.bytes.byteOffset,
        file.bytes.byteOffset + file.bytes.byteLength,
      ) as ArrayBuffer,
      savedAt: Date.now(),
    });
    saved.push(lowerName);
  }
  return { saved, skipped, rejected };
}

/** 登録済みROM一覧を返す。 */
export async function listRoms(): Promise<RomEntry[]> {
  const stored = await db.getAllByPrefix(ROM_KEY_PREFIX);
  return stored
    .map((s) => ({ name: s.name, size: s.bytes.byteLength, savedAt: s.savedAt }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 登録済みROMを削除する。 */
export async function deleteRom(name: string): Promise<void> {
  await db.delete(`${ROM_KEY_PREFIX}${name.toLowerCase()}`);
}

/** 起動時にMEMFSへ注入するための全登録済みROMを読み出す。 */
export async function loadRomsForBoot(): Promise<DiskFile[]> {
  const stored = await db.getAllByPrefix(ROM_KEY_PREFIX);
  return stored.map((s) => ({ name: s.name, bytes: new Uint8Array(s.bytes) }));
}

// public/rhythm/ に同梱しているリズム波形のfetch元。CORE_BASE (src/core/module.ts) と
// 同様に、GitHub Pagesのサブパス配下でも壊れないよう vite.config.ts の base:'./' に
// 合わせた相対パスにする。
const RHYTHM_BASE = './rhythm/';

/**
 * 同梱のリズム波形6本 (public/rhythm/*.wav) をfetchしてDiskFile[]として返す。
 * 実チップROMからの吸い出しではなく作者が制作した代替音(README参照)。
 * 個別のfetchが失敗したファイルは結果から除外する(同梱アセットが欠けても起動自体は継続する)。
 */
export async function loadBundledRhythmWavs(): Promise<DiskFile[]> {
  const results = await Promise.all(
    RHYTHM_WAV_NAMES.map(async (name): Promise<DiskFile | undefined> => {
      try {
        const res = await fetch(`${RHYTHM_BASE}${name}`);
        if (!res.ok) return undefined;
        return { name, bytes: new Uint8Array(await res.arrayBuffer()) };
      } catch {
        return undefined;
      }
    }),
  );
  return results.filter((r): r is DiskFile => r !== undefined);
}

/**
 * 利用者登録済みROMと同梱のリズム波形をマージする純関数(単体テスト用に副作用を持たない)。
 * 利用者登録が優先: registered に同名(小文字比較)があれば bundled 側は採用しない。
 * registered に無い名前だけ bundled で埋める。registered/bundled 以外のROM(bios.rom等)も
 * そのまま素通りする。
 */
export function mergeRhythmDefaults(registered: DiskFile[], bundled: DiskFile[]): DiskFile[] {
  const registeredNames = new Set(registered.map((r) => r.name.toLowerCase()));
  const additions = bundled.filter((b) => !registeredNames.has(b.name.toLowerCase()));
  return [...registered, ...additions];
}
