// YM2608リズム波形ファイルが「本当に音を出すか」を、ファイルの存在確認ではなく
// fmgen(NP2kaiが実際に使っている音源コア)が生成するPCMの実測で検証するスクリプト。
//
// 検査対象の実装は NP2kai/sound/fmgen/fmgen_opna.cpp の
// FM::OPNA::LoadRhythmSample() (path付き。探すファイル名は大文字 "2608_BD.WAV" 等固定)。
// このスクリプトはその関数を単体ビルドしたC++ハーネス(verify-rhythm-fmgen.cpp)を経由して
// 「レジスタでリズムを鳴らす → Mix()の出力PCMの絶対値和(absSum)」を実測する。
//
// なぜ陽性対照(ケースA)が要るか:
//   もしこのスクリプト自体が実装のバグや誤ったレジスタ設定により「常にabsSum>0を返す壊れた
//   検査」になっていたら、他の全ケースが「意図通りPASS」に見えても無意味である。
//   波形を一切置かないディレクトリを渡した場合は、fmgenの実装上ファイルが開けず
//   LoadRhythmSampleがfalseを返し、Mixの出力も理論上ゼロになるはずなので、
//   これが実測でも0にならない場合は検査系そのものが壊れているとみなし、
//   他のケースの結果に関わらず全体をFAILにする。
//
// ケースC(小文字名のみ配置)についての注意:
//   fmgenはfopen()をそのまま使っており、大文字/小文字の区別はOS(ファイルシステム)依存。
//   macOSの既定ボリューム(APFS, case-insensitive)では小文字名のファイルでも
//   fopen("...BD.WAV")が拾ってしまい、検査が無意味になる。
//   そのためこのスクリプトは hdiutil で一時的に case-sensitive な APFS ディスクイメージを
//   作成し、その上で4ケース全てを検査する。マウント直後に大文字/小文字が実際に
//   区別されることを自己チェックしてから本題の検査に進む(観測系自体の健全性を先に測る)。

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NP2KAI_ROOT_DIR =
  process.env.NP2KAI_ROOT_DIR ?? '/Users/haruurara/MyProject/_emulator/PC98/NP2kai';
const HARNESS_SRC = join(ROOT, 'scripts', 'verify-rhythm-fmgen.cpp');
const RHYTHM_SRC_DIR = join(ROOT, 'public', 'rhythm');
const RHYTHM_NAMES = ['bd', 'sd', 'top', 'hh', 'tom', 'rim'];

const FMGEN_DIR = join(NP2KAI_ROOT_DIR, 'sound', 'fmgen');
const FMGEN_SOURCES = [
  'fmgen_opna.cpp',
  'fmgen_fmgen.cpp',
  'fmgen_psg.cpp',
  'fmgen_file.cpp',
  'fmgen_fmtimer.cpp',
].map((f) => join(FMGEN_DIR, f));

function skip(message) {
  console.log(`[SKIP] ${message}`);
  process.exit(0);
}

function fail(message) {
  console.error(`[ERROR] ${message}`);
  process.exit(1);
}

// --- 0. 前提の確認 ---------------------------------------------------------

if (!existsSync(NP2KAI_ROOT_DIR)) {
  skip(
    `NP2kaiが見つかりません(${NP2KAI_ROOT_DIR})。NP2KAI_ROOT_DIR環境変数で場所を指定してください。`,
  );
}
for (const src of FMGEN_SOURCES) {
  if (!existsSync(src)) skip(`fmgenのソースが見つかりません: ${src}`);
}
for (const name of RHYTHM_NAMES) {
  const p = join(RHYTHM_SRC_DIR, `2608_${name}.wav`);
  if (!existsSync(p)) fail(`同梱リズム波形が見つかりません: ${p}`);
}

let sdlCflags;
try {
  sdlCflags = execFileSync('sdl2-config', ['--cflags'], { encoding: 'utf8' }).trim().split(/\s+/);
} catch {
  skip('sdl2-configが見つかりません(SDL2未インストール)。fmgenハーネスをビルドできません。');
}

// --- 1. C++ハーネスのビルド --------------------------------------------------

const buildDir = mkdtempSync(join(tmpdir(), 'webnp2-rhythm-build-'));
const harnessBin = join(buildDir, 'harness');

console.log('==> fmgenハーネスをビルド中...');
const buildArgs = [
  '-std=c++11',
  '-DSUPPORT_FMGEN',
  '-DOSLANG_UTF8',
  '-DSUPPORT_UTF8',
  '-DUSE_SDL=2',
  '-DCPUCORE_IA32',
  ...sdlCflags,
  '-Isdl/em',
  '-Isdl',
  '-I.',
  '-Isound/fmgen',
  HARNESS_SRC,
  ...FMGEN_SOURCES,
  '-o',
  harnessBin,
];
const build = spawnSync('c++', buildArgs, { cwd: NP2KAI_ROOT_DIR, encoding: 'utf8' });
if (build.status !== 0) {
  rmSync(buildDir, { recursive: true, force: true });
  fail(`ハーネスのビルドに失敗しました:\n${build.stderr}`);
}

// --- 2. case-sensitiveな一時ボリュームを用意 ---------------------------------

const dmgPath = join(buildDir, 'rhythm-case.dmg');
const volName = `webnp2rhythm${process.pid}`;
let mountPoint;

console.log('==> case-sensitiveな検証用ボリュームを作成中...');
const create = spawnSync('hdiutil', [
  'create',
  '-size',
  '16m',
  '-fs',
  'Case-sensitive APFS',
  '-volname',
  volName,
  dmgPath,
  '-attach',
  '-quiet',
]);
if (create.status !== 0) {
  rmSync(buildDir, { recursive: true, force: true });
  fail(`hdiutilでの検証用ボリューム作成に失敗しました:\n${create.stderr}`);
}
mountPoint = `/Volumes/${volName}`;
if (!existsSync(mountPoint)) {
  fail(`検証用ボリュームがマウントされていません: ${mountPoint}`);
}

function cleanup() {
  spawnSync('hdiutil', ['detach', mountPoint, '-quiet']);
  rmSync(buildDir, { recursive: true, force: true });
}

try {
  // 自己チェック: このボリュームが本当に大文字小文字を区別するか実測する。
  // (区別しないボリュームの上でケースCを実行しても無意味な結果しか出ないため)
  const selfCheckDir = join(mountPoint, 'case-selftest');
  mkdirSync(selfCheckDir);
  writeFileSync(join(selfCheckDir, 'AbC.txt'), 'x');
  if (existsSync(join(selfCheckDir, 'abc.txt'))) {
    fail(
      '検証用ボリュームが大文字小文字を区別していません(観測系が壊れています)。ケースCの検査を実行できません。',
    );
  }
  console.log('    自己チェックOK: 大文字小文字は区別されています。');

  // --- 3. 4ケース分のディレクトリを用意 -------------------------------------

  function makeCaseDir(dirName, files) {
    const dir = join(mountPoint, dirName);
    mkdirSync(dir);
    for (const [srcName, destName] of files) {
      copyFileSync(join(RHYTHM_SRC_DIR, srcName), join(dir, destName));
    }
    return `${dir}/`;
  }

  const upperName = (n) => `2608_${n.toUpperCase()}.WAV`;

  const dirA = makeCaseDir('case-a-empty', []);
  const dirB = makeCaseDir(
    'case-b-upper',
    RHYTHM_NAMES.map((n) => [`2608_${n}.wav`, upperName(n)]),
  );
  const dirC = makeCaseDir(
    'case-c-lower',
    RHYTHM_NAMES.map((n) => [`2608_${n}.wav`, `2608_${n}.wav`]), // 小文字名のまま
  );
  const dirD = makeCaseDir(
    'case-d-missing-one',
    RHYTHM_NAMES.filter((n) => n !== 'rim').map((n) => [`2608_${n}.wav`, upperName(n)]), // RIMだけ欠落
  );

  // --- 4. ハーネス実行 & 判定 -------------------------------------------------

  function runHarness(dir) {
    const result = spawnSync(harnessBin, [dir], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`ハーネス実行が異常終了しました(dir=${dir}):\n${result.stderr}`);
    }
    return JSON.parse(result.stdout.trim());
  }

  const results = [];
  let allZero = (r) => !r.loaded && r.instruments.every((i) => i.absSum === 0);
  let allNonZero = (r) => r.loaded && r.instruments.every((i) => i.absSum > 0);

  function report(name, r, expectFn, expectDesc) {
    const pass = expectFn(r);
    const detail = r.instruments.map((i) => `${i.name}=${i.absSum}`).join(', ');
    const line = `[${pass ? 'PASS' : 'FAIL'}] ${name} - loaded=${r.loaded}, ${detail} (期待: ${expectDesc})`;
    console.log(line);
    results.push({ name, pass });
    return pass;
  }

  console.log('==> 4ケースを実測中...');
  const rA = runHarness(dirA);
  const rB = runHarness(dirB);
  const rC = runHarness(dirC);
  const rD = runHarness(dirD);

  const passA = report(
    'A. 陽性対照(波形なし)',
    rA,
    allZero,
    'loaded=false かつ 全楽器absSum=0',
  );
  const passB = report(
    'B. 大文字名で6本配置',
    rB,
    allNonZero,
    'loaded=true かつ 全楽器absSum>0',
  );
  const passC = report(
    'C. 小文字名のみ配置',
    rC,
    allZero,
    'loaded=false かつ 全楽器absSum=0(fmgenは大文字固定)',
  );
  const passD = report(
    'D. 6本中5本のみ(RIM欠落)',
    rD,
    allZero,
    'loaded=false かつ 全楽器absSum=0(1本でも欠けると全破棄)',
  );

  console.log('---');
  const passCount = results.filter((r) => r.pass).length;
  console.log(`サマリ: ${passCount}/${results.length} PASS`);

  if (!passA) {
    console.error(
      '[ERROR] 陽性対照(ケースA)がFAILしました。この検査スクリプト自体が信用できないため、' +
        '他のケースの結果に関わらず全体をFAILとします。',
    );
    process.exitCode = 1;
  } else if (passCount !== results.length) {
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
} catch (err) {
  console.error(`[ERROR] ${err.message ?? err}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
