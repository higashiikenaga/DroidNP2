// バージョン文字列を生成する純粋関数群。
// git実行(副作用)は tools/compute-version.mjs 側に分離し、ここは vitest で
// 単体テストしやすい純関数だけを置く(FMSound/tools/gen_version.py と同じ方針)。
//
// 方針:
// - ビルド時刻(壁時計)は使わない。git commit時刻(コミッターdate, unix秒)のみを情報源にする。
//   同じコミットから何度ビルドしても必ず同じ文字列になることが要件。
// - JSTはIntl/toLocaleString/localtime()等のホストTZ設定に依存する変換を使わず、
//   UTC基準のDateメソッド + 固定オフセット(+09:00)加算で求める。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * commit時刻・コミットハッシュ・作業ツリーのdirty有無から、フッター表示用文字列と
 * アセットのキャッシュバスティング用クエリ値(buildId)を生成する。
 *
 * @param {number} commitTsSec - git commit時刻(unix秒、コミッターdate)
 * @param {string} shortHash - git rev-parse --short=7 HEAD の結果(7桁想定)
 * @param {boolean} dirty - 作業ツリーが汚れているか(git status --porcelain が空でない)
 * @returns {{ footer: string, buildId: string }}
 */
export function formatVersion(commitTsSec, shortHash, dirty) {
  // fromtimestamp(ts, tz=JST)相当: unix秒(UTC単位時刻)に固定オフセットを足してから
  // UTC系メソッドで各フィールドを取り出す。Dateのローカルタイムゾーン系メソッド
  // (getFullYear等)やtoLocaleString系は一切使わない=ホストのTZ設定を参照しない。
  const jst = new Date(commitTsSec * 1000 + JST_OFFSET_MS);
  const y = jst.getUTCFullYear();
  const mo = pad2(jst.getUTCMonth() + 1);
  const d = pad2(jst.getUTCDate());
  const h = pad2(jst.getUTCHours());
  const mi = pad2(jst.getUTCMinutes());
  // 作業ツリーが汚れている場合の印。表示用(footer)は"+"付き、クエリ用(buildId)は
  // URLに安全な"-dirty"にする("+"はURLクエリ内で空白に解釈されうるため避ける)。
  const hashDisplay = dirty ? `${shortHash}+` : shortHash;
  const footer = `WebNP2 ${y}-${mo}-${d} ${h}:${mi} JST (${hashDisplay})`;
  const buildId = dirty ? `${shortHash}-dirty` : shortHash;
  return { footer, buildId };
}

/** git情報の取得に失敗した場合のフォールバック値。もっともらしい値で埋めず、明示的に「不明」とわかる形にする。 */
export const UNKNOWN_VERSION = {
  footer: 'WebNP2 (version unknown)',
  buildId: 'unknown',
};
