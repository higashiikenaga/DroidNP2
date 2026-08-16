// git情報からバージョン文字列を組み立てる(副作用あり: gitコマンドを実行する)。
// 純粋な整形ロジックは tools/version.mjs に分離してある。
//
// vite.config.ts (ビルド/開発サーバ起動時) と vitest.config.ts (テスト実行時) の
// 両方から同じ値を得るために共有する。gitが使えない/リポジトリでない環境でも
// ビルドを失敗させず、UNKNOWN_VERSION にフォールバックする。

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { formatVersion, UNKNOWN_VERSION } from './version.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');

function runGit(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

/** @returns {{ footer: string, buildId: string }} */
export function computeVersion() {
  try {
    // --date=format はgitのバージョン/ロケールに挙動差があるため使わない。
    // unix秒(%ct、コミッターdate)を取り、JS側でJST固定オフセット変換する
    // (tools/version.mjs の formatVersion 参照)方が環境非依存で確実。
    const commitTsStr = runGit(['log', '-1', '--format=%ct']).trim();
    const hash = runGit(['rev-parse', '--short=7', 'HEAD']).trim();
    const status = runGit(['status', '--porcelain']);
    if (!commitTsStr || !hash) {
      throw new Error('git出力が空でした');
    }
    const commitTs = Number(commitTsStr);
    if (!Number.isFinite(commitTs)) {
      throw new Error(`commit時刻の解析に失敗しました: ${commitTsStr}`);
    }
    return formatVersion(commitTs, hash, status.trim().length > 0);
  } catch (err) {
    // gitが無い/リポジトリでない等。もっともらしい値で埋めず'unknown'で明示し、
    // ビルド自体は失敗させない。
    console.warn(
      '[compute-version] git情報の取得に失敗したため版文字列を unknown にします:',
      err instanceof Error ? err.message : err,
    );
    return UNKNOWN_VERSION;
  }
}
