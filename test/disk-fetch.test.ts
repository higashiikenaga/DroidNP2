// src/api/disk-fetch.ts の単体テスト。
//
// 実測で判明した2つの事実の回帰テスト:
// 1. Google Driveの共有ページURL(https://drive.google.com/file/d/<ID>/view?usp=sharing)へ
//    ブラウザから直接fetchすると、GoogleはOriginをechoした access-control-allow-origin を
//    付けて200でHTML閲覧ページを返す(2026-08-13 curl実測、content-type: text/html)。
//    そのため中継が設定されている場合、Google Drive/Dropbox等の共有ページホストは
//    直接fetchを試さず最初から中継を使う必要がある。
// 2. 直接fetch・中継経由のいずれでも、取得結果がHTML/XMLに見える場合は
//    ディスクイメージとして扱わずエラーにする必要がある(looksLikeHtml)。
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

  it('中継設定時、Google Drive/Dropbox共有ホストは直接fetchをスキップし最初から中継を使う', async () => {
    vi.stubEnv('VITE_DISK_PROXY', 'https://proxy.example.test');
    const fetchMock = vi.fn(async (url: string) => mockResponse(BINARY_BYTES));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchDiskBytes } = await import('../src/api/disk-fetch.ts');

    const bytes = await fetchDiskBytes('https://drive.google.com/file/d/ABC123/view?usp=sharing');

    expect(bytes).toEqual(BINARY_BYTES);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('https://proxy.example.test/fetch?url=');
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
