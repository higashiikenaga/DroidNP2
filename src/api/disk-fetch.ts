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
const PROXY_CAPABLE_HOSTS = ['drive.google.com', 'docs.google.com', 'www.dropbox.com', 'dropbox.com'];

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

/**
 * 進捗コールバック付きでURLからディスクイメージのバイト列を取得する。
 *
 * まず指定URLへ直接fetchする(GitHub raw のようにCORS対応済みのURLに無駄な中継を挟まない
 * ため)。直接取得に失敗した場合のみ、中継サービス(VITE_DISK_PROXY)経由での再取得を試みる。
 * ただしOneDriveの共有リンクは実測で中継しても取得できないため中継を試さず即座に専用の
 * 案内を出し、中継が未設定の場合はGoogle Drive/Dropboxのみ「直接取得できません」と案内する
 * (それ以外は従来どおりCORS未対応の可能性を伝える)。
 */
export async function fetchDiskBytes(
  url: string,
  onProgress?: (loaded: number, total: number | null) => void,
): Promise<Uint8Array> {
  const progress = onProgress ?? (() => {});
  let directError: Error;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(t('fetchFailedHttp', { url, status: response.status }));
    }
    return await readResponseWithProgress(response, progress);
  } catch (err) {
    directError = err instanceof Error && err.message ? err : new Error(t('fetchFailedNetwork', { url }));
  }

  const hostname = urlHostname(url);
  if (hostMatches(hostname, ONEDRIVE_HOSTS)) {
    throw new Error(t('fetchFailedOneDrive', { url }));
  }

  if (!DISK_PROXY_BASE) {
    if (hostMatches(hostname, PROXY_CAPABLE_HOSTS)) {
      throw new Error(t('fetchFailedNeedsProxy', { url }));
    }
    throw directError;
  }

  const proxyUrl = `${DISK_PROXY_BASE}/fetch?url=${encodeURIComponent(url)}`;
  let proxyResponse: Response;
  try {
    proxyResponse = await fetch(proxyUrl);
  } catch {
    throw directError;
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
  return await readResponseWithProgress(proxyResponse, progress);
}
