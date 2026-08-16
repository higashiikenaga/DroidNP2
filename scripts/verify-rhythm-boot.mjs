// YM2608リズム波形の同梱ファイルが「ブラウザ上で、コアが実際にそのパスを開けているか」を
// 検証するスクリプト。verify-rhythm-fmgen.mjs はネイティブC++ハーネスでfmgenの音声出力を
// 実測したが、WebNP2はwasm+MEMFS経由でファイルを渡しているため、そこにファイルが本当に
// 「同梱の内容で」置かれ、コアが「開けている」ことは未検証だった。
//
// 測る対象は最後まで一貫して2つだけ:
//   (a) emscripten FS.open が実際に呼ばれたパスと成否の記録(preRunの時点でFS.openを
//       ラップして仕込む。preRunはmain()より前に走るため、リズム波形を読む
//       opna_reset()のopenも取りこぼさず捕捉できる)
//   (b) MEMFS上に書き込まれたファイルの実バイト列(ローカルの元ファイル/登録内容と比較)
// rAFの回転数やcanvas描画は一切判定に使わない(このリポジトリでは自動ブラウザでの
// requestAnimationFrameの挙動が環境によって逆の結果になった実績があるため)。
//
// なぜ陽性対照(ケース2)が要るか:
//   ケース1で「/2608_BD.WAV のopenが成功として記録される」がPASSしても、
//   もしFS.openラップ自体が仕込めておらず記録が常に空/常に成功扱いになる壊れた検査なら、
//   その結果は無意味である。rhythm/*.wav のfetchを意図的に全滅させた状態で同じ経路を
//   通し、「同じ検査系で失敗が失敗として記録される」ことを示して初めて、ケース1の
//   PASSに意味が出る。ここが失敗として記録されない場合は検査系の故障とみなし、
//   他のケースの結果に関わらず全体をFAILにする。
//
// 3ケースは別々のページロード(タブ)で行う。WebNP2のコアは1つのJSモジュール
// インスタンスにつき1回しかbootできない(src/core/module.tsのbooted変数)ため。

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE_URL = process.env.WEBNP2_URL ?? 'http://127.0.0.1:5173';
const STATIC_URL = 'http://webnp2-smoke.local';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RHYTHM_NAMES = ['bd', 'sd', 'top', 'hh', 'tom', 'rim'];
const RHYTHM_DIR = join(ROOT, 'public', 'rhythm');

let server;
let serverOutput = '';
let profile;
let browser;
let staticFallback = false;
const results = [];

// --- サーバ起動(dbg-smoke.mjsと同じ作法) -----------------------------------

async function runCommand(command, args) {
  const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk.toString()));
  child.stderr.on('data', (chunk) => (output += chunk.toString()));
  const code = await new Promise((resolve) => child.on('close', resolve));
  if (code !== 0) throw new Error(output.trim());
}

async function urlReady() {
  try {
    const response = await fetch(BASE_URL);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await urlReady()) return;
  if (process.env.WEBNP2_URL) {
    throw new Error(`WEBNP2_URLへ接続できません: ${BASE_URL}`);
  }

  server = spawn(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  server.stdout.on('data', (chunk) => (serverOutput += chunk.toString()));
  server.stderr.on('data', (chunk) => (serverOutput += chunk.toString()));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await urlReady()) return;
    if (server.exitCode !== null) break;
    await sleep(200);
  }
  if (serverOutput.includes('listen EPERM')) {
    await runCommand(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']);
    staticFallback = true;
    return;
  }
  throw new Error(`Viteの起動に失敗しました: ${serverOutput.trim()}`);
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bmp': 'image/bmp',
  '.xdf': 'application/octet-stream',
  '.wav': 'audio/wav',
};

/**
 * リクエスト経路を仕込む。
 * - staticFallback時: distをPuppeteerのrequest interceptionで返す(dbg-smokeと同じ)。
 * - blockRhythm時: rhythm/*.wav へのfetchだけ意図的に失敗させる(ケース2の陽性対照用)。
 * どちらも不要なページでは何もしない(素通り)。
 */
async function attachRequestHandling(targetPage, { blockRhythm }) {
  if (!staticFallback && !blockRhythm) return;
  await targetPage.setRequestInterception(true);
  targetPage.on('request', async (request) => {
    try {
      const url = new URL(request.url());
      if (blockRhythm && /\/rhythm\/2608_[a-z]+\.wav$/i.test(url.pathname)) {
        await request.abort('failed');
        return;
      }
      if (!staticFallback) {
        await request.continue();
        return;
      }
      if (url.origin !== STATIC_URL) {
        await request.abort();
        return;
      }
      const relative = decodeURIComponent(
        url.pathname === '/' ? 'index.html' : url.pathname.slice(1),
      );
      if (relative.split('/').includes('..')) {
        await request.respond({ status: 403, body: 'forbidden' });
        return;
      }
      const body = await readFile(join(ROOT, 'dist', relative));
      const extension = relative.slice(relative.lastIndexOf('.'));
      await request.respond({
        status: 200,
        contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream',
        body,
      });
    } catch {
      try {
        await request.respond({ status: 404, body: 'not found' });
      } catch {
        /* すでに処理済みなら無視 */
      }
    }
  });
}

function pageUrl(query) {
  const base = staticFallback ? STATIC_URL : BASE_URL;
  return `${base}/?${query}`;
}

// --- ページ内計装(evaluateOnNewDocument) ------------------------------------
//
// window.Module へのsetterを仕込み、preRunInjectDisks(module.tsの既存preRun)より前に
// 「FS.openをラップするpreRun関数」を追加する。preRun配列はmain()実行前に順に呼ばれる
// ので、opna_reset()が呼ぶFS.open(ひいてはfopen)を漏らさず記録できる。
// 元のFS.openには必ず委譲し、例外は記録した上でそのまま再throwする(挙動を変えない)。
function installInstrumentation() {
  let realModule;
  Object.defineProperty(window, 'Module', {
    configurable: true,
    enumerable: true,
    get() {
      return realModule;
    },
    set(mod) {
      realModule = mod;
      if (mod && typeof mod === 'object') {
        if (!Array.isArray(mod.preRun)) mod.preRun = [];
        mod.preRun.unshift(function installFsOpenLogger() {
          try {
            const FS = mod.FS || window.FS;
            if (!FS || typeof FS.open !== 'function' || FS.__rhythmWrapped) return;
            FS.__rhythmWrapped = true;
            window.__rhythmOpenLog = [];
            const origOpen = FS.open.bind(FS);
            FS.open = function wrappedOpen(path, flags, mode) {
              const p = typeof path === 'string' ? path : '<non-string-path>';
              try {
                const stream = origOpen(path, flags, mode);
                window.__rhythmOpenLog.push({ path: p, ok: true });
                return stream;
              } catch (err) {
                window.__rhythmOpenLog.push({
                  path: p,
                  ok: false,
                  error: String((err && err.message) || err),
                });
                throw err;
              }
            };
          } catch (err) {
            window.__rhythmOpenLogError = String((err && err.message) || err);
          }
        });
      }
    },
  });

  // rAFが回っているかどうかは判定に使わないが、環境依存の実績があるため参考値として数える。
  window.__rafCount = 0;
  function tick() {
    window.__rafCount++;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

async function newInstrumentedPage({ blockRhythm = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(installInstrumentation);
  await attachRequestHandling(page, { blockRhythm });
  return page;
}

async function readOpenLog(page) {
  return page.evaluate(() => window.__rhythmOpenLog ?? null);
}

async function readRafCount(page) {
  return page.evaluate(() => window.__rafCount ?? 0);
}

/** ログにpathへのopen記録(成功/失敗いずれか)が現れるまで待つ。現れなければnullを返す。 */
async function waitForOpenRecord(page, path, timeoutMs) {
  try {
    await page.waitForFunction(
      (p) => (window.__rhythmOpenLog ?? []).some((e) => e.path === p),
      { timeout: timeoutMs },
      path,
    );
  } catch {
    return null;
  }
  const log = await readOpenLog(page);
  return log.find((e) => e.path === path) ?? null;
}

/** MEMFS上のファイルをbase64で読み出す(存在しなければnull)。 */
async function readMemfsBase64(page, path) {
  return page.evaluate((p) => {
    // module.tsのresolveFS()と同じフォールバック: 非MODULARIZEビルドはFSを
    // グローバル変数としても定義するため、Module.FSが無ければwindow.FSを見る。
    const FS = (window.Module && window.Module.FS) || window.FS;
    if (!FS) return null;
    try {
      const bytes = FS.readFile(p, { encoding: 'binary' });
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    } catch {
      return null;
    }
  }, path);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function bootAndWait(page, query) {
  await page.goto(pageUrl(query), { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.np2debug?.np2?.isBooted?.() === true, {
    timeout: 120_000,
  });
  // isBootedはJS側(onRuntimeInitialized)のフラグで、C側main()のOPNAリセット(リズム波形読込)
  // より早く立ちうる。読込完了を先取りせず、後段でFS.openログを個別にポーリングして待つ。
  await sleep(3_000);
}

async function check(number, name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`[PASS] ${number}. ${name}`);
  } catch (error) {
    results.push(false);
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[FAIL] ${number}. ${name}: ${message}`);
  }
}

async function run() {
  await ensureServer();
  profile = await mkdtemp(join(tmpdir(), 'webnp2-rhythm-'));
  browser = await puppeteer.launch({
    executablePath: CHROME,
    userDataDir: profile,
    headless: 'new',
    args: ['--hide-scrollbars'],
  });

  const localBytes = {};
  const localSha = {};
  for (const name of RHYTHM_NAMES) {
    const buf = await readFile(join(RHYTHM_DIR, `2608_${name}.wav`));
    localBytes[name] = buf;
    localSha[name] = sha256(buf);
  }

  // ==== ケース1: 同梱あり(通常起動) =======================================
  let case1Log = null;
  let case1Raf = 0;
  await check(1, 'ケース1: 同梱6本すべてが大文字名でopen成功として記録される', async () => {
    const page = await newInstrumentedPage();
    await bootAndWait(page, 'freedos=1&run=1&worklet=0&lang=ja');
    for (const name of RHYTHM_NAMES) {
      const rec = await waitForOpenRecord(page, `/2608_${name.toUpperCase()}.WAV`, 20_000);
      assert.ok(rec, `/2608_${name.toUpperCase()}.WAV のopen記録が見つかりません`);
      assert.equal(rec.ok, true, `/2608_${name.toUpperCase()}.WAV のopenが失敗しています: ${rec.error}`);
    }
    case1Log = await readOpenLog(page);
    case1Raf = await readRafCount(page);
    await page.close();
  });

  await check(2, 'ケース1: MEMFS上の2608_BD.WAV/2608_bd.wavが同梱ファイルと一致', async () => {
    const page = await newInstrumentedPage();
    await bootAndWait(page, 'freedos=1&run=1&worklet=0&lang=ja');
    for (const name of RHYTHM_NAMES) {
      const rec = await waitForOpenRecord(page, `/2608_${name.toUpperCase()}.WAV`, 20_000);
      assert.ok(rec && rec.ok, `/2608_${name.toUpperCase()}.WAV の読込確認に失敗`);
    }
    const upperB64 = await readMemfsBase64(page, '/2608_BD.WAV');
    const lowerB64 = await readMemfsBase64(page, '/2608_bd.wav');
    assert.ok(upperB64, '/2608_BD.WAV をMEMFSから読み出せません');
    assert.ok(lowerB64, '/2608_bd.wav をMEMFSから読み出せません');
    const upperBuf = Buffer.from(upperB64, 'base64');
    const lowerBuf = Buffer.from(lowerB64, 'base64');
    assert.equal(upperBuf.length, localBytes.bd.length, '/2608_BD.WAV の長さが同梱ファイルと不一致');
    assert.equal(sha256(upperBuf), localSha.bd, '/2608_BD.WAV のSHA-256が同梱ファイルと不一致');
    assert.equal(lowerBuf.length, localBytes.bd.length, '/2608_bd.wav の長さが同梱ファイルと不一致');
    assert.equal(sha256(lowerBuf), localSha.bd, '/2608_bd.wav のSHA-256が同梱ファイルと不一致');
    await page.close();
  });

  // ==== ケース2: 陽性対照(rhythm/*.wav のfetchを全滅させる) =================
  let case2Record = null;
  await check(3, 'ケース2(陽性対照): rhythm/*.wavのfetchを遮断すると/2608_BD.WAVのopenが失敗として記録される', async () => {
    const page = await newInstrumentedPage({ blockRhythm: true });
    await bootAndWait(page, 'freedos=1&run=1&worklet=0&lang=ja');
    case2Record = await waitForOpenRecord(page, '/2608_BD.WAV', 20_000);
    await page.close();
    assert.ok(case2Record, '/2608_BD.WAV のopen記録自体が見つかりません(検査系が壊れています)');
    assert.equal(
      case2Record.ok,
      false,
      `陽性対照でopenが成功として記録されました(検査系が常にPASSする壊れた検査になっています): ${JSON.stringify(case2Record)}`,
    );
  });

  // ==== ケース3: 利用者登録がIndexedDBにあれば同梱より優先される ============
  const modifiedBd = Buffer.from(localBytes.bd);
  // WAVヘッダ(RIFF/fmt/dataチャンク境界)は保ったまま末尾4バイトだけ反転し、
  // 「フォーマットは有効だが中身は同梱と異なる」ダミーを作る。
  for (let i = modifiedBd.length - 4; i < modifiedBd.length; i++) {
    modifiedBd[i] = modifiedBd[i] ^ 0xff;
  }
  assert.notEqual(sha256(modifiedBd), localSha.bd, 'ダミー生成に失敗(同梱と同一になった)');

  await check(
    4,
    'ケース3: IndexedDB登録(2608_bd.wav)が同梱より優先され、他5本は同梱のまま',
    async () => {
      const page = await newInstrumentedPage();
      // まず素の状態でナビゲートしてoriginを確立し(run無しなので自動起動しない)、
      // db.ts/roms.tsが使うのと同じスキーマ(webnp2 DB, imagesストア, sourceKey='rom:2608_bd.wav')
      // でIndexedDBに登録する。
      await page.goto(pageUrl('lang=ja'), { waitUntil: 'networkidle2' });
      const base64Payload = modifiedBd.toString('base64');
      await page.evaluate((base64) => {
        return new Promise((resolve, reject) => {
          const req = indexedDB.open('webnp2', 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('images')) {
              db.createObjectStore('images', { keyPath: 'sourceKey' });
            }
          };
          req.onsuccess = () => {
            const db = req.result;
            const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
            const tx = db.transaction('images', 'readwrite');
            tx.objectStore('images').put({
              sourceKey: 'rom:2608_bd.wav',
              name: '2608_bd.wav',
              bytes: bytes.buffer,
              savedAt: Date.now(),
            });
            tx.oncomplete = () => {
              db.close();
              resolve(undefined);
            };
            tx.onerror = () => reject(tx.error);
          };
          req.onerror = () => reject(req.error);
        });
      }, base64Payload);

      // 登録後に改めて起動URLへ遷移してブート(同一ページ内でのnavigate、originは維持されIndexedDBは引き継がれる)。
      await bootAndWait(page, 'freedos=1&run=1&worklet=0&lang=ja');
      for (const name of RHYTHM_NAMES) {
        const rec = await waitForOpenRecord(page, `/2608_${name.toUpperCase()}.WAV`, 20_000);
        assert.ok(rec && rec.ok, `/2608_${name.toUpperCase()}.WAV の読込確認に失敗`);
      }

      const upperB64 = await readMemfsBase64(page, '/2608_BD.WAV');
      const lowerB64 = await readMemfsBase64(page, '/2608_bd.wav');
      const upperBuf = Buffer.from(upperB64, 'base64');
      const lowerBuf = Buffer.from(lowerB64, 'base64');
      assert.equal(sha256(upperBuf), sha256(modifiedBd), '/2608_BD.WAV が登録内容(改変版)になっていません');
      assert.equal(sha256(lowerBuf), sha256(modifiedBd), '/2608_bd.wav が登録内容(改変版)になっていません');

      for (const name of RHYTHM_NAMES) {
        if (name === 'bd') continue;
        const upperOther = await readMemfsBase64(page, `/2608_${name.toUpperCase()}.WAV`);
        const lowerOther = await readMemfsBase64(page, `/2608_${name}.wav`);
        assert.equal(
          sha256(Buffer.from(upperOther, 'base64')),
          localSha[name],
          `/2608_${name.toUpperCase()}.WAV が同梱内容から変わっています`,
        );
        assert.equal(
          sha256(Buffer.from(lowerOther, 'base64')),
          localSha[name],
          `/2608_${name}.wav が同梱内容から変わっています`,
        );
      }
      await page.close();
    },
  );

  await check(5, '全ケース総合判定', async () => {
    assert.equal(results.slice(0, 4).every(Boolean), true);
  });

  console.log(`[INFO] ケース1 rAFカウント(参考値): ${case1Raf}`);
  if (case1Log) {
    const rhythmLines = case1Log.filter((e) => /2608_/i.test(e.path));
    console.log(`[INFO] ケース1 FS.openログ(リズム関連のみ): ${JSON.stringify(rhythmLines)}`);
  }
  if (case2Record) {
    console.log(`[INFO] ケース2 /2608_BD.WAV open記録: ${JSON.stringify(case2Record)}`);
  }
}

try {
  await run();
} finally {
  if (browser) await browser.close();
  if (profile) await rm(profile, { recursive: true, force: true });
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
  }
}

if (!results.every(Boolean)) process.exitCode = 1;
