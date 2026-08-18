// URLからディスクイメージを取得する共通ロジック。
// main.ts の resolveImage / FreeDOS同梱イメージ取得と、webnp2.ts の insertFdFromUrl の
// 両方から使うためモジュール化している(WebX68k の fetchBytesWithProgress に準拠)。

import { t } from '../ui/strings.ts';

// 中継サービスのベースURL(空文字なら中継しない=直接fetchのみ)。ビルド時に環境変数
// VITE_DISK_PROXY から注入される(リポジトリ内の既定は空。詳細は .github/workflows/deploy.yml 参照)。
const DISK_PROXY_BASE = (import.meta.env.VITE_DISK_PROXY ?? '').trim().replace(/\/+$/, '');

// OneDriveの共有リンクは実測で中継しても取得できないことが判明しているため、中継を試さず
// 即座に案内を出すためのホスト一覧。
const ONEDRIVE_HOSTS = ['1drv.ms', 'onedrive.live.com', 'sharepoint.com'];
// 中継を使えば取得できる(=中継未設定時のみ「直接取得できません」と案内する)配信元のホスト一覧。
// dropbox.com を足すと hostMatches の「.<entry> で終わる」判定で www.dropbox.com も
// 拾えるようになるが、www.dropbox.com は実際に貼られる頻度が高いため、完全一致で
// 早期に判定できるよう明示的にも残す。
// Dropboxは rewriteDropboxUrl でホスト名を置換すれば直接取得できるようになったが、置換が
// 効かない旧形式の共有リンク(下記コメント参照)向けの案内としてここには残す。
const PROXY_CAPABLE_HOSTS = ['drive.google.com', 'docs.google.com', 'www.dropbox.com', 'dropbox.com'];
// 直接fetchしてもHTML閲覧ページしか返らず、ホスト置換でも救えないため中継が必須の配信元。
// Dropboxは rewriteDropboxUrl の置換で直接取得できるためここには含めない
// (skipDirectの判定にのみ使う。案内文言の判定はPROXY_CAPABLE_HOSTSを使い続ける)。
const PROXY_ONLY_HOSTS = ['drive.google.com', 'docs.google.com'];

// Dropbox共有リンクのホスト名一覧(置換対象)と、置換先の直接ダウンロード用ホスト。
const DROPBOX_HOSTS = ['www.dropbox.com', 'dropbox.com'];
const DROPBOX_DIRECT_HOST = 'dl.dropboxusercontent.com';

/**
 * Dropbox共有リンクのホスト名を dl.dropboxusercontent.com に置換し、中継を挟まず
 * ブラウザから直接取得できるようにする。パスとクエリ(共有リンクのアクセス鍵 rlkey を
 * 含む)はそのまま保持し、ホスト名だけを差し替える(rlkeyを落とすと権限エラーになるため)。
 *
 * 実測(2026-08-18、FMSound側でブラウザのfetchにより確認。curl/Node fetchはCORSを
 * 強制しないためこの判定には使えない): `www.dropbox.com` のままだと `dl=0`/`dl=1`
 * いずれもACAOが無くCORSで失敗する(`TypeError: Failed to fetch`)。ホストを
 * `dl.dropboxusercontent.com` に置換すると、パス・クエリそのままで200・
 * content-type: application/zip・CORS通過で取得できる(`dl=1`への書き換えは不要、
 * 付けても結果は同じ)。実測したのは `/scl/fi/...` 形式のファイル共有リンク1本のみで、
 * 旧`/s/...`形式・フォルダ単位の共有・パスワード付き共有は未検証。それらは
 * この置換では救えない可能性があるが、fetchDiskBytes側で直接取得の失敗を検知して
 * 中継(DISK_PROXY_BASE)へ自動フォールバックするため、中継が設定されていれば
 * 従来どおり取得できる想定(中継が未設定でもDropboxが直接取得で通るようになる点は
 * この関数のみで完結し、中継設定の有無に依存しない)。
 *
 * `dl.dropboxusercontent.com` が既に指定されている場合はDROPBOX_HOSTSに一致しないため
 * 何もせず返す(冪等)。Dropbox以外のホストには一切触らない。
 */
export function rewriteDropboxUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!hostMatches(parsed.hostname, DROPBOX_HOSTS)) return url;
  parsed.hostname = DROPBOX_DIRECT_HOST;
  return parsed.toString();
}

/** URLのホスト名を取り出す。パース不可なら空文字を返す(呼び出し側は「一致なし」として扱う)。 */
function urlHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function hostMatches(hostname: string, list: string[]): boolean {
  return list.some((h) => hostname === h || hostname.endsWith(`.${h}`));
}

const HTML_TEXT_PATTERNS = ['<!do', '<htm', '<?xm'];

/**
 * バイト列がディスクイメージではなくHTML/XMLページに見えるかどうかを判定する。
 *
 * Google Driveの共有ページURL(`https://drive.google.com/file/d/<ID>/view?usp=sharing`)へ
 * ブラウザから直接fetchすると、GoogleはOriginをechoした `access-control-allow-origin` を
 * 付けて200でHTML閲覧ページを返す(2026-08-13 curl実測、content-type: text/html)。
 * fetch自体は成功(response.ok)してしまうため、Content-TypeとバイトのHTML/XML先頭シグネチャの
 * 両方で保険をかける。
 */
export function looksLikeHtml(bytes: Uint8Array, contentType?: string | null): boolean {
  if (contentType && contentType.toLowerCase().startsWith('text/html')) return true;
  if (bytes.length < 4) return false;
  const head = new TextDecoder('ascii', { fatal: false })
    .decode(bytes.subarray(0, 5))
    .toLowerCase();
  return HTML_TEXT_PATTERNS.some((pattern) => head.startsWith(pattern));
}

/** 中継サーバのエラーJSON(`{"error":"host_not_allowed"}` 等)をHTTPステータスとあわせて利用者向け理由文言に変換する。 */
function describeProxyError(status: number, code: string | undefined): string {
  switch (code) {
    case 'bad_url':
      return t('proxyReasonBadUrl');
    case 'origin_not_allowed':
      return t('proxyReasonOriginNotAllowed');
    case 'host_not_allowed':
      return t('proxyReasonHostNotAllowed');
    case 'too_large':
      return t('proxyReasonTooLarge');
    case 'rate_limited':
      return t('proxyReasonRateLimited');
    case 'upstream_failed':
      return t('proxyReasonUpstreamFailed');
    case 'redirect_not_allowed':
      return t('proxyReasonRedirectNotAllowed');
    default:
      return t('proxyReasonUnknown', { status });
  }
}

/** fetch結果(成功時のResponse)をストリームで読み進め、進捗コールバックを呼びながらバイト列に組み立てる。 */
async function readResponseWithProgress(
  response: Response,
  onProgress: (loaded: number, total: number | null) => void,
): Promise<Uint8Array> {
  const totalHeader = response.headers.get('content-length');
  const total = totalHeader ? Number(totalHeader) : null;

  if (!response.body) {
    const buf = await response.arrayBuffer();
    onProgress(buf.byteLength, total);
    return new Uint8Array(buf);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded, total);
    }
  }
  const result = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** 中継サービス経由でURLを取得し、成功したバイト列を返す。取得できない場合はエラーをthrowする。 */
async function fetchViaProxy(
  url: string,
  progress: (loaded: number, total: number | null) => void,
  fallbackError: Error,
): Promise<Uint8Array> {
  const proxyUrl = `${DISK_PROXY_BASE}/fetch?url=${encodeURIComponent(url)}`;
  let proxyResponse: Response;
  try {
    proxyResponse = await fetch(proxyUrl);
  } catch {
    throw fallbackError;
  }
  if (!proxyResponse.ok) {
    let code: string | undefined;
    try {
      const body = (await proxyResponse.clone().json()) as { error?: string };
      code = body.error;
    } catch {
      // 中継側がJSONを返さなかった場合はステータスのみで案内する。
    }
    throw new Error(t('fetchFailedProxy', { url, reason: describeProxyError(proxyResponse.status, code) }));
  }
  const bytes = await readResponseWithProgress(proxyResponse, progress);
  if (looksLikeHtml(bytes, proxyResponse.headers.get('content-type'))) {
    throw new Error(t('fetchFailedHtmlPage', { url }));
  }
  return bytes;
}

/**
 * 進捗コールバック付きでURLからディスクイメージのバイト列を取得する。
 *
 * 通常はまず指定URLへ直接fetchする(GitHub raw のようにCORS対応済みのURLに無駄な中継を挟まない
 * ため)。直接取得に失敗した場合のみ、中継サービス(VITE_DISK_PROXY)経由での再取得を試みる。
 * ただしOneDriveの共有リンクは実測で中継しても取得できないため中継を試さず即座に専用の
 * 案内を出し、中継が未設定の場合はGoogle Drive/Dropboxのみ「直接取得できません」と案内する
 * (それ以外は従来どおりCORS未対応の可能性を伝える)。
 *
 * Google Drive(PROXY_ONLY_HOSTS)の共有ページURLは、直接fetchしても中身ではなく
 * HTML閲覧ページが200で返ってくることが実測で判明している(GoogleがOriginをechoした
 * CORSヘッダ付きでHTMLを返すため、fetch自体は失敗しない)。そのため中継が設定されている
 * 場合、このホストは直接fetchを試さず最初から中継を使う(skipDirect)。
 * Dropboxはホスト名を rewriteDropboxUrl で dl.dropboxusercontent.com に置換すれば
 * 直接取得できることが実測できたため、skipDirectの対象からは外し、置換後のURLへ
 * 直接fetchを試みる(中継に渡すURLは利用者が入力した元のURL。中継はサーバ側から
 * 取得するため置換不要で、元の共有URLで実績がある)。
 * それでも(直接fetch成功時・中継利用時のいずれでも)取得結果がHTML/XMLに見える場合は
 * looksLikeHtml で検出し、ディスクイメージではないと案内する。
 */
export async function fetchDiskBytes(
  url: string,
  onProgress?: (loaded: number, total: number | null) => void,
): Promise<Uint8Array> {
  const progress = onProgress ?? (() => {});
  const hostname = urlHostname(url);
  if (hostMatches(hostname, ONEDRIVE_HOSTS)) {
    throw new Error(t('fetchFailedOneDrive', { url }));
  }

  const skipDirect = Boolean(DISK_PROXY_BASE) && hostMatches(hostname, PROXY_ONLY_HOSTS);

  let directError: Error | undefined;
  let directWasHtml = false;
  if (!skipDirect) {
    const directUrl = rewriteDropboxUrl(url);
    try {
      const response = await fetch(directUrl);
      if (!response.ok) {
        throw new Error(t('fetchFailedHttp', { url: directUrl, status: response.status }));
      }
      const bytes = await readResponseWithProgress(response, progress);
      if (!looksLikeHtml(bytes, response.headers.get('content-type'))) {
        return bytes;
      }
      directWasHtml = true;
    } catch (err) {
      directError = err instanceof Error && err.message ? err : new Error(t('fetchFailedNetwork', { url: directUrl }));
    }
  }

  if (!DISK_PROXY_BASE) {
    if (directWasHtml) throw new Error(t('fetchFailedHtmlPage', { url }));
    if (directError) {
      if (hostMatches(hostname, PROXY_CAPABLE_HOSTS)) {
        throw new Error(t('fetchFailedNeedsProxy', { url }));
      }
      throw directError;
    }
    // skipDirect かつ中継未設定はここには来ない(skipDirectの判定にDISK_PROXY_BASEを含むため)。
    throw new Error(t('fetchFailedNeedsProxy', { url }));
  }

  const fallbackError = directError ?? new Error(t('fetchFailedNetwork', { url }));
  return await fetchViaProxy(url, progress, fallbackError);
}
