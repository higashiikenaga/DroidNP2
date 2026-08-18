// src/api/disk-fetch.ts の単体テスト。
//
// 実測で判明した3つの事実の回帰テスト:
// 1. Google Driveの共有ページURL(https://drive.google.com/file/d/<ID>/view?usp=sharing)へ
//    ブラウザから直接fetchすると、GoogleはOriginをechoした access-control-allow-origin を
//    付けて200でHTML閲覧ページを返す(2026-08-13 curl実測、content-type: text/html)。
//    そのため中継が設定されている場合、Google Driveの共有ページホストは
//    直接fetchを試さず最初から中継を使う必要がある。
// 2. 直接fetch・中継経由のいずれでも、取得結果がHTML/XMLに見える場合は
//    ディスクイメージとして扱わずエラーにする必要がある(looksLikeHtml)。
// 3. Dropboxの共有リンクは www.dropbox.com のままだと dl=0/dl=1 いずれもCORSで失敗するが、
//    ホスト名を dl.dropboxusercontent.com に置換するとパス・クエリそのままで200・CORS通過で
//    取得できる(2026-08-18 FMSound側でブラウザのfetchにより実測。curl/Node fetchはCORSを
//    強制しないためこの判定はブラウザでしか測れず、ここでは実測結果を前提に
//    「どのURLへfetchしたか」という配線だけを検証する)。そのためDropboxは中継設定の
//    有無にかかわらず、まず置換後のURLへ直接fetchする。
//
// DISK_PROXY_BASE はモジュール読み込み時に import.meta.env から1度だけ評価される定数のため、
// 「中継が設定されている」ケースを検証するテストは vi.stubEnv + vi.resetModules() で
// フレッシュな状態のモジュールを都度 dynamic import する。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** テスト用にfetchのResponseもどきを作る。bodyは持たせずarrayBuffer()経由の読み出し経路を通す。 */
function mockResponse(
  bytes: Uint8Array,
  opts: { ok?: boolean; status?: number; contentType?: string | null } = {},
): Response {
  const { ok = true, status = 200, contentType = null } = opts;
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const res = {
    ok,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
    },
    body: undefined,
    arrayBuffer: async () => buf,
    clone(): Response {
      return res as unknown as Response;
    },
    json: async () => ({}),
  };
  return res as unknown as Response;
}

const HTML_BYTES = new TextEncoder().encode('<!DOCTYPE html><html><body>view</body></html>');
const BINARY_BYTES = new Uint8Array(64).fill(0xaa);

// Dropboxの「リンクをコピー」で得られる形式の共有リンクと、その置換後の姿。
// rlkeyは共有リンクのアクセス鍵なので落とすと権限エラーになる。dl=0のままでよい。
const DROPBOX_SHARE_URL =
  'https://www.dropbox.com/scl/fi/m7r349wurx7tb87ymwvd9/FD1.D88?rlkey=abcDEF123xyz&dl=0';
const DROPBOX_DIRECT_URL =
  'https://dl.dropboxusercontent.com/scl/fi/m7r349wurx7tb87ymwvd9/FD1.D88?rlkey=abcDEF123xyz&dl=0';

describe('rewriteDropboxUrl', () => {
  it('www.dropbox.com をdl.dropboxusercontent.comへ置換し、パスとクエリ(rlkey/dl)を保持する', async () => {
    const { rewriteDropboxUrl } = await import('../src/api/disk-fetch.ts');
    expect(rewriteDropboxUrl(DROPBOX_SHARE_URL)).toBe(DROPBOX_DIRECT_URL);
  });

  it('wwwなしのdropbox.comも置換する(dl=1もそのまま保持する)', async () => {
    const { rewriteDropboxUrl } = await import('../src/api/disk-fetch.ts');
    expect(rewriteDropboxUrl('https://dropbox.com/scl/fi/abc/FD.D88?rlkey=zzz&dl=1')).toBe(
      'https://dl.dropboxusercontent.com/scl/fi/abc/FD.D88?rlkey=zzz&dl=1',
    );
  });

  it('既に置換済みのURLは変化しない(冪等)', async () => {
    const { rewriteDropboxUrl } = await import('../src/api/disk-fetch.ts');
    expect(rewriteDropboxUrl(DROPBOX_DIRECT_URL)).toBe(DROPBOX_DIRECT_URL);
  });

  it('Dropbox以外のホストとパース不能な文字列には一切触らない', async () => {
    const { rewriteDropboxUrl } = await import('../src/api/disk-fetch.ts');
    for (const url of [
      'https://raw.githubusercontent.com/example/repo/main/FD1.D88',
      'https://drive.google.com/file/d/ABC123/view?usp=sharing',
      'https://notdropbox.com/x.d88',
      'https://example.com/dropbox.com/x.d88',
      'not a url',
    ]) {
      expect(rewriteDropboxUrl(url)).toBe(url);
    }
  });
});

describe('looksLikeHtml', () => {
  it('content-typeがtext/htmlならHTMLと判定する(バイト列がバイナリでも)', async () => {
    const { looksLikeHtml } = await import('../src/api/disk-fetch.ts');
    expect(looksLikeHtml(BINARY_BYTES, 'text/html; charset=utf-8')).toBe(true);
  });

  it('先頭が<!DOCTYPE/<html/<?xmlならHTML/XMLと判定する(content-type無しでも)', async () => {
    const { looksLikeHtml } = await import('../src/api/disk-fetch.ts');
    expect(looksLikeHtml(new TextEncoder().encode('<!DOCTYPE html>'))).toBe(true);
    expect(looksLikeHtml(new TextEncoder().encode('<html><head>'))).toBe(true);
    expect(looksLikeHtml(new TextEncoder().encode('<HTML><HEAD>'))).toBe(true);
    expect(looksLikeHtml(new TextEncoder().encode('<?xml version="1.0"?>'))).toBe(true);
  });

  it('通常のディスクイメージのバイト列はHTMLと判定されない', async () => {
    const { looksLikeHtml } = await import('../src/api/disk-fetch.ts');
    expect(looksLikeHtml(BINARY_BYTES)).toBe(false);
    expect(looksLikeHtml(new Uint8Array(0))).toBe(false);
  });
});

describe('fetchDiskBytes', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    // 「中継未設定」を既定にする。開発者の手元には .env.local(gitignore対象)が置かれて
    // いてVITE_DISK_PROXYが実際の中継URLに解決されるため、明示的に空へ倒しておかないと
    // 「中継未設定」を名乗るテストが手元だけ中継ありの経路を通ってしまう(2026-08-18に
    // 故障注入で発覚)。中継ありを検証するテストは各自 stubEnv で上書きする。
    vi.stubEnv('VITE_DISK_PROXY', '');
    // src/ui/strings.ts の getLang() は location.search / navigator.language を参照する。
    // vitestのnode環境にはどちらも存在しないため、エラーメッセージ生成(t())が
    // ReferenceErrorで落ちないようスタブしておく。
    vi.stubGlobal('location', { search: '' });
    vi.stubGlobal('navigator', { language: 'ja' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('中継未設定時、Google DriveのURLでも直接fetchを試み、結果がHTMLならエラーにする', async () => {
    const fetchMock = vi.fn(async () => mockResponse(HTML_BYTES, { contentType: 'text/html' }));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchDiskBytes } = await import('../src/api/disk-fetch.ts');

    await expect(
      fetchDiskBytes('https://drive.google.com/file/d/ABC123/view?usp=sharing'),
    ).rejects.toThrow(/Webページ/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('中継設定時、Google Drive共有ホストは直接fetchをスキップし最初から中継を使う', async () => {
    vi.stubEnv('VITE_DISK_PROXY', 'https://proxy.example.test');
    const fetchMock = vi.fn(async (url: string) => mockResponse(BINARY_BYTES));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchDiskBytes } = await import('../src/api/disk-fetch.ts');

    const bytes = await fetchDiskBytes('https://drive.google.com/file/d/ABC123/view?usp=sharing');

    expect(bytes).toEqual(BINARY_BYTES);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('https://proxy.example.test/fetch?url=');
  });

  it('中継設定時でもDropboxは中継をスキップし、置換後のURLへ直接fetchする', async () => {
    vi.stubEnv('VITE_DISK_PROXY', 'https://proxy.example.test');
    const fetchMock = vi.fn(async () => mockResponse(BINARY_BYTES));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchDiskBytes } = await import('../src/api/disk-fetch.ts');

    const bytes = await fetchDiskBytes(DROPBOX_SHARE_URL);

    expect(bytes).toEqual(BINARY_BYTES);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 中継URLではなく、ホスト置換した直接URL(rlkey・dl=0はそのまま)へ1回だけ行っていること。
    expect(fetchMock.mock.calls[0][0]).toBe(DROPBOX_DIRECT_URL);
  });

  it('中継未設定でもDropboxは置換後のURLへ直接fetchして取得できる', async () => {
    const fetchMock = vi.fn(async () => mockResponse(BINARY_BYTES));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchDiskBytes } = await import('../src/api/disk-fetch.ts');

    const bytes = await fetchDiskBytes(DROPBOX_SHARE_URL);

    expect(bytes).toEqual(BINARY_BYTES);
    expect(fetchMock.mock.calls[0][0]).toBe(DROPBOX_DIRECT_URL);
  });

  it('Dropboxの直接取得が失敗した場合、中継へは利用者が入力した元のURLを渡す', async () => {
    // 置換で救えない共有リンク(旧/s/形式・フォルダ共有・パスワード付き)を想定した経路。
    // 中継はサーバ側から取得するため置換不要で、元の共有URLで実績がある。
    vi.stubEnv('VITE_DISK_PROXY', 'https://proxy.example.test');
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new TypeError('Failed to fetch');
      })
      .mockImplementationOnce(async () => mockResponse(BINARY_BYTES));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchDiskBytes } = await import('../src/api/disk-fetch.ts');

    const bytes = await fetchDiskBytes(DROPBOX_SHARE_URL);

    expect(bytes).toEqual(BINARY_BYTES);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(DROPBOX_DIRECT_URL);
    expect(fetchMock.mock.calls[1][0]).toBe(
      `https://proxy.example.test/fetch?url=${encodeURIComponent(DROPBOX_SHARE_URL)}`,
    );
  });

  it('中継設定時でも共有ホスト以外(例: GitHub raw)は直接fetchを先に試みる', async () => {
    vi.stubEnv('VITE_DISK_PROXY', 'https://proxy.example.test');
    const fetchMock = vi.fn(async () => mockResponse(BINARY_BYTES));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchDiskBytes } = await import('../src/api/disk-fetch.ts');

    const bytes = await fetchDiskBytes('https://raw.githubusercontent.com/example/repo/main/FD1.XDF');

    expect(bytes).toEqual(BINARY_BYTES);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://raw.githubusercontent.com/example/repo/main/FD1.XDF');
  });

  it('直接fetchでHTMLを掴んだ場合、中継が設定されていれば中継で再取得する', async () => {
    vi.stubEnv('VITE_DISK_PROXY', 'https://proxy.example.test');
    const fetchMock = vi
      .fn()
      // 1回目(直接fetch、共有ホスト以外なので試みる): HTMLを返す
      .mockImplementationOnce(async () => mockResponse(HTML_BYTES, { contentType: 'text/html' }))
      // 2回目(中継経由): 正しいバイナリを返す
      .mockImplementationOnce(async () => mockResponse(BINARY_BYTES));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchDiskBytes } = await import('../src/api/disk-fetch.ts');

    const bytes = await fetchDiskBytes('https://example.com/shared/FD1.XDF');

    expect(bytes).toEqual(BINARY_BYTES);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain('https://proxy.example.test/fetch?url=');
  });

  it('中継経由でもHTMLだった場合は案内エラーを投げる', async () => {
    vi.stubEnv('VITE_DISK_PROXY', 'https://proxy.example.test');
    const fetchMock = vi.fn(async () => mockResponse(HTML_BYTES, { contentType: 'text/html' }));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchDiskBytes } = await import('../src/api/disk-fetch.ts');

    await expect(
      fetchDiskBytes('https://drive.google.com/file/d/ABC123/view?usp=sharing'),
    ).rejects.toThrow(/Webページ/);
  });

  it('中継未設定・共有ホスト以外でHTMLを掴んだ場合もHTML案内エラーになる', async () => {
    const fetchMock = vi.fn(async () => mockResponse(HTML_BYTES, { contentType: 'text/html' }));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchDiskBytes } = await import('../src/api/disk-fetch.ts');

    await expect(fetchDiskBytes('https://example.com/shared/FD1.XDF')).rejects.toThrow(/Webページ/);
  });
});
