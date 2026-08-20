// PC-98ゲームに広く見られる「エプソン(EPSON98互換機)チェック」を無害化するパッチ機能。
//
// 多くのPC-98用ゲームは、起動時に BIOS の INT 1Dh(AH=00h, 「マシン種別取得」)を呼び、
// 返ってきた AL の特定ビット(NEC純正機かEPSON互換機かの判定に使われる)を見て、
// EPSON互換機だった場合に警告表示や起動拒否へ分岐する。この分岐の実体は
// 「INT 1Dh 呼び出し(バイト列 CD 1D)の直後、数バイト以内にある条件分岐命令
// (Jcc: 0x70-0x7F の近距離分岐、または 0F 80-0F8F の遠距離分岐)」という形で
// 現れることが多い(通称「エプソンチェック」「エプソン救済パッチ」)。
//
// この関数はディスクイメージのバイナリ全体からその形(CD 1D の直後の Jcc)を
// スキャンし、見つかった Jcc 命令だけを同じバイト数の NOP(0x90)列に書き換える。
// Jcc を無害化すると分岐そのものが起きなくなり、常にチェックに続く側の経路
// (=分岐しなかった場合の経路、多くのタイトルでNEC機と同じ起動継続側)を通る。
//
// 注意: バイト列の一致だけを根拠にした発見的パッチであり、誤検出(たまたま同じ
// バイト列が別の意味のコード/データ中に現れる)を完全には排除できない。
// 呼び出し側は元バイト列を保持し、パッチ済みコピーだけをコアへ渡すこと
// (本関数は常に新しい Uint8Array を返し、入力を書き換えない)。

export interface EpsonCheckPatch {
  /** パッチしたバイト列上でのオフセット(Jcc命令の先頭)。 */
  offset: number;
  /** 元の命令バイト列(1〜2バイトのopcode + オペランド)。 */
  originalBytes: number[];
}

export interface EpsonPatchResult {
  /** パッチ後のバイト列。1件も見つからなければ入力と同じ内容の新しいコピー。 */
  bytes: Uint8Array;
  /** 適用したパッチの一覧(見つからなければ空配列)。 */
  patches: EpsonCheckPatch[];
}

const INT_1DH = [0xcd, 0x1d];

/** offset が短距離Jcc(1バイトopcode + 1バイト相対オフセット)の先頭かどうか。 */
function isShortJcc(bytes: Uint8Array, offset: number): boolean {
  const op = bytes[offset];
  return op >= 0x70 && op <= 0x7f && offset + 1 < bytes.length;
}

/** offset が近距離Jcc(0F 80-0F8F + 2バイトまたは4バイトの相対オフセット)の先頭かどうか。 */
function isNearJcc(bytes: Uint8Array, offset: number): boolean {
  return (
    bytes[offset] === 0x0f &&
    offset + 1 < bytes.length &&
    bytes[offset + 1] >= 0x80 &&
    bytes[offset + 1] <= 0x8f
  );
}

/** INT 1Dh 呼び出しの直後、maxLookahead バイト以内にある最初のJcc命令を探す。 */
function findJccAfter(bytes: Uint8Array, from: number, maxLookahead: number): { offset: number; len: number } | null {
  const end = Math.min(bytes.length, from + maxLookahead);
  for (let i = from; i < end; i++) {
    if (isShortJcc(bytes, i)) return { offset: i, len: 2 };
    if (isNearJcc(bytes, i) && i + 3 < bytes.length) return { offset: i, len: 4 };
  }
  return null;
}

/**
 * INT 1Dh(AH=00h想定, マシン種別取得)呼び出し直後の条件分岐をNOP化する。
 * maxLookahead: INT 1Dh から何バイト以内のJccを対象にするか(既定8。AH設定/AL判定の
 * 数命令ぶんを見込んだ値で、離れた無関係のJccを誤って拾わないための上限)。
 */
export function patchEpsonCheck(input: Uint8Array, maxLookahead = 8): EpsonPatchResult {
  const bytes = new Uint8Array(input);
  const patches: EpsonCheckPatch[] = [];

  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] !== INT_1DH[0] || bytes[i + 1] !== INT_1DH[1]) continue;
    const jcc = findJccAfter(bytes, i + 2, maxLookahead);
    if (!jcc) continue;
    const originalBytes = Array.from(bytes.subarray(jcc.offset, jcc.offset + jcc.len));
    for (let k = 0; k < jcc.len; k++) bytes[jcc.offset + k] = 0x90;
    patches.push({ offset: jcc.offset, originalBytes });
    // 書き換えたJcc命令の続きから再開する(同じ箇所を二重に見ない)。
    i = jcc.offset + jcc.len - 1;
  }

  return { bytes, patches };
}

/** D88/FDI/HDIなどのディスクイメージ拡張子かどうか(このパッチを適用してよい対象の判定用)。 */
export function isPatchableDiskImage(fileName: string): boolean {
  return /\.(d88|d77|d98|fdi|hdi|thd|nhd|hdm|xdf|2hd)$/i.test(fileName);
}
