// WebNP2 の最小限のPWA用Service Worker。
//
// 目的はAndroidでの「ホーム画面に追加」インストールと、一度開いたページのオフライン再訪
// (ネットワーク不調時のアプリシェル表示)だけ。ディスクイメージのURL取得(?hdd=/?fd1=等、
// 任意のオリジンから取得する)や外部フォント/CDNのような他オリジンのリクエストには一切
// 介入しない(同一オリジンのGETリクエストのみ扱う)。Rangeリクエスト(音声/大きい資産の
// 部分取得)もキャッシュの部分一致で壊れる可能性があるためそのままネットワークへ通す。
//
// キャッシュ戦略はネットワーク優先(network-first): まずネットワークから取りに行き、
// 成功すればキャッシュを更新して返す。オフライン等で失敗した場合のみキャッシュから返す。
// ビルドごとにファイル名がハッシュ化される(vite build)ため、キャッシュの世代管理は
// CACHE_VERSION定数の更新(このファイル自体の変更)でブラウザの通常のSW更新機構に任せる。

const CACHE_VERSION = 'webnp2-shell-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  if (req.headers.has('range')) return;

  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        if (res.ok) {
          const cache = await caches.open(CACHE_VERSION);
          void cache.put(req, res.clone());
        }
        return res;
      } catch (err) {
        const cached = await caches.match(req);
        if (cached) return cached;
        throw err;
      }
    })(),
  );
});
