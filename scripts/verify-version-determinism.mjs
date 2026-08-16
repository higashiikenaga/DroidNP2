#!/usr/bin/env node
// tools/compute-version.mjs が「壁時計を使わず、同じコミットからは常に同じ文字列を
// 生成する」ことを検証する(FMSound/tools/verify_version_determinism.mjs と同じ方針)。
//
// 手順: computeVersion() を子プロセスで1秒以上の間隔を挟んで2回実行し、
// 出力(JSON)が完全一致するか比較する。一致しなければ壁時計等の非決定要素を
// 使っている疑いがあるためFAIL。TZ環境変数を変えても同じ結果になることも確認する。
//
// 故障注入: 意図的に現在時刻を埋め込む「壊れた版」を用意し、この検査が実際に
// 差分を検出できることを先に確認してから、本物のcomputeVersion()を検証する
// (常にPASSする検査は無効、という方針。feedback_fault_injection_needs_positive_control参照)。

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const COMPUTE_VERSION_PATH = path.join(REPO_ROOT, 'tools', 'compute-version.mjs').replace(/\\/g, '/');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runNode(code, env) {
  return execFileSync('node', ['--input-type=module', '-e', code], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trim();
}

async function main() {
  // --- 故障注入: 壁時計を使う「壊れた版」を模擬し、検査がFAILを検出できるか確認 ---
  const faultCode = 'console.log(JSON.stringify({ now: Date.now() }));';
  const fault1 = runNode(faultCode, {});
  await sleep(1100);
  const fault2 = runNode(faultCode, {});
  if (fault1 === fault2) {
    console.error('FATAL: 故障注入(壁時計使用)のはずが2回とも一致した。検査ロジックが機能していない。');
    process.exit(1);
  }
  console.log('[故障注入] 壁時計版は1.1秒間隔で実行すると内容が変わることを確認(検査は機能している)。');

  // --- 本番: computeVersion() を子プロセスで2回実行し、出力を比較 ---
  const realCode = [
    `import { computeVersion } from ${JSON.stringify(COMPUTE_VERSION_PATH)};`,
    'console.log(JSON.stringify(computeVersion()));',
  ].join('\n');

  const run1 = runNode(realCode, {});
  await sleep(1100);
  const run2 = runNode(realCode, {});
  if (run1 !== run2) {
    console.error('FAIL: computeVersion() の出力が2回の実行(1.1秒間隔)で食い違った(壁時計等の非決定要素の疑い)。');
    console.error('--- run1 ---\n' + run1);
    console.error('--- run2 ---\n' + run2);
    process.exit(1);
  }
  console.log('[本番] computeVersion() を1.1秒間隔で2回実行し、出力が完全一致した:');
  console.log(run1);
  console.log('PASS: 同じコミットからの計算は常に同じバージョン文字列になる(壁時計不使用)。');

  // --- TZ環境変数を変えても同じ文字列になることを確認 ---
  const runTzUtc = runNode(realCode, { TZ: 'UTC' });
  if (runTzUtc !== run1) {
    console.error('FAIL: TZ=UTC で実行すると出力が変わった(localtime依存の疑い)。');
    console.error('--- run1(TZ未指定) ---\n' + run1);
    console.error('--- TZ=UTC ---\n' + runTzUtc);
    process.exit(1);
  }
  console.log('[TZ差し替え] TZ=UTC でも出力が一致した。');

  const runTzNy = runNode(realCode, { TZ: 'America/New_York' });
  if (runTzNy !== run1) {
    console.error('FAIL: TZ=America/New_York で実行すると出力が変わった(localtime依存の疑い)。');
    console.error('--- run1(TZ未指定) ---\n' + run1);
    console.error('--- TZ=America/New_York ---\n' + runTzNy);
    process.exit(1);
  }
  console.log('[TZ差し替え] TZ=America/New_York でも出力が一致した。');

  const parsed = JSON.parse(run1);
  if (!/JST \(/.test(parsed.footer)) {
    console.error('FAIL: フッターに"JST"の明記が無い(基準タイムゾーンが分からない表記になっている)。');
    console.error(run1);
    process.exit(1);
  }
  console.log('PASS: TZ環境変数を変えてもcomputeVersion()の出力は変わらない(JSTを固定オフセットで扱っている)。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
