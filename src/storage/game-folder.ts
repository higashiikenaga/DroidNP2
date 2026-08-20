// 「ゲーム専用フォルダ」機能。
//
// Android(Chrome)は API level 30以降 Scoped Storage が既定となり、アプリは共有ストレージの
// 任意の場所へ自由に書き込めず、SAF(Storage Access Framework)でユーザーが選んだフォルダにだけ
// アクセスできる。File System Access API(showDirectoryPicker)はWeb版のSAF相当で、ユーザーが
// 明示的に選んだ1フォルダへの永続アクセス権を得られる。本モジュールはこのAPIを使い、
// 「WebNP2用のフォルダ」をユーザーに一度選んでもらい、そのハンドルをIndexedDBへ保存して
// 次回以降は権限確認だけで再利用する。ディスクイメージのエクスポート/インポート双方から
// 同じフォルダを使えるようにする(main.ts側の配線)。
//
// File System Access API 非対応ブラウザ(iOS Safari等)では isGameFolderSupported() が false を
// 返す。呼び出し側は従来の <a download> によるダウンロードへフォールバックすること。

const DB_NAME = 'webnp2-game-folder';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const HANDLE_KEY = 'gameFolder';

interface FsDirectoryHandleLike {
  readonly kind: 'directory';
  readonly name: string;
  queryPermission?(opts: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(opts: { mode: 'readwrite' }): Promise<PermissionState>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsFileHandleLike>;
}

interface FsFileHandleLike {
  getFile(): Promise<File>;
  createWritable(): Promise<{
    write(data: BufferSource | Blob): Promise<void>;
    close(): Promise<void>;
  }>;
}

declare global {
  interface Window {
    showDirectoryPicker?(opts?: { id?: string; mode?: 'read' | 'readwrite' }): Promise<FsDirectoryHandleLike>;
  }
}

export function isGameFolderSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('failed to open IndexedDB'));
  });
  return dbPromise;
}

async function storeHandle(handle: FsDirectoryHandleLike): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('failed to store folder handle'));
  });
}

async function loadHandle(): Promise<FsDirectoryHandleLike | undefined> {
  const db = await openDb();
  return new Promise<FsDirectoryHandleLike | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
    req.onsuccess = () => resolve((req.result as FsDirectoryHandleLike | undefined) ?? undefined);
    req.onerror = () => reject(req.error ?? new Error('failed to load folder handle'));
  });
}

/** すでに選択済みのフォルダへの書き込み権限が有効か確認し、必要なら再許可を求める。 */
async function ensureReadWrite(handle: FsDirectoryHandleLike): Promise<boolean> {
  if (!handle.queryPermission || !handle.requestPermission) return true;
  const state = await handle.queryPermission({ mode: 'readwrite' });
  if (state === 'granted') return true;
  const requested = await handle.requestPermission({ mode: 'readwrite' });
  return requested === 'granted';
}

/**
 * ユーザーにフォルダ選択ダイアログを出し、選ばれたフォルダをゲーム用フォルダとして保存する。
 * 既に選択済みの場合も呼べば選び直しになる(上書き)。
 */
export async function pickGameFolder(): Promise<FsDirectoryHandleLike | undefined> {
  if (!isGameFolderSupported()) return undefined;
  const handle = await window.showDirectoryPicker!({ id: 'webnp2-games', mode: 'readwrite' });
  await storeHandle(handle);
  return handle;
}

/**
 * 前回選択済みのゲーム用フォルダを返す(権限が失効していれば再許可を求める)。
 * 一度も選んでいない、または非対応ブラウザなら undefined。
 */
export async function getGameFolder(): Promise<FsDirectoryHandleLike | undefined> {
  if (!isGameFolderSupported()) return undefined;
  const handle = await loadHandle();
  if (!handle) return undefined;
  const ok = await ensureReadWrite(handle);
  return ok ? handle : undefined;
}

/** ゲーム用フォルダ直下へファイルを書き込む(既存同名ファイルは上書き)。 */
export async function writeFileToGameFolder(
  handle: FsDirectoryHandleLike,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const fileHandle = await handle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  await writable.close();
}

/** ゲーム用フォルダ直下のファイルを読み込む。存在しなければ undefined。 */
export async function readFileFromGameFolder(
  handle: FsDirectoryHandleLike,
  name: string,
): Promise<Uint8Array | undefined> {
  try {
    const fileHandle = await handle.getFileHandle(name);
    const file = await fileHandle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return undefined;
  }
}
