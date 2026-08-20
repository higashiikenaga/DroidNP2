// 画面スリープ対策(Screen Wake Lock API)。
//
// スマホでは画面がOFFになると(多くの端末で)ブラウザタブがバックグラウンド化し、
// requestAnimationFrame駆動のコアのメインループやAudioContextが実質停止する。
// エミュレータが起動している間だけ画面を消灯させないようにすることで、この根本原因を
// 未然に防ぐ(「バックグラウンドでも完全に動作を継続する」ことはブラウザの仕様上不可能なため、
// 代わりに「そもそもバックグラウンド化させない」方向で対策する)。
//
// Wake Lock は仕様上、ドキュメントが非表示(document.hidden)になると自動的に解放され、
// 再表示しても自動では再取得されない。そのため「今欲しいかどうか」(desired)と
// 「実際に持っているか」(sentinel)を分けて管理し、可視化のたびに再取得を試みる形にする。

interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

function getWakeLockApi(): WakeLockLike | undefined {
  return (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
}

export function isWakeLockSupported(): boolean {
  return getWakeLockApi() !== undefined;
}

let sentinel: WakeLockSentinelLike | null = null;
/** 呼び出し側が最後に望んだ状態。visibilitychangeでの再取得判定に使う。 */
let desired = false;

/**
 * 画面を消灯させないよう要求する。非対応ブラウザでは何もしない(例外を投げない)。
 * ドキュメントが非表示の間はブラウザがrequestを拒否するため、その場合は静かに諦め、
 * 再表示時にreacquireIfDesired()で再試行する想定。
 */
export async function acquireWakeLock(): Promise<void> {
  desired = true;
  const api = getWakeLockApi();
  if (!api || sentinel || document.hidden) return;
  try {
    sentinel = await api.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
  } catch {
    // 端末のバッテリーセーバー等で拒否されることがある。次の再表示時に再試行する。
    sentinel = null;
  }
}

/** 画面消灯抑止をやめる(エミュレータ未起動時/タブ非表示時等)。 */
export function releaseWakeLock(): void {
  desired = false;
  const s = sentinel;
  sentinel = null;
  void s?.release();
}

/** ドキュメントが再表示されたときに呼ぶ。直前まで欲しがっていた場合だけ再取得する。 */
export function reacquireWakeLockIfDesired(): void {
  if (desired) void acquireWakeLock();
}
