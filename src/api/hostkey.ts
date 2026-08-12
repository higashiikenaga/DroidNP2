/**
 * ホストキー再割り当て(「ホストの物理キー → 任意のPC-98キー」の対応表)。
 *
 * WebNP2 の実キーボード入力は emscripten SDL2 が document レベルで keydown/keyup を
 * 直接 preventDefault() してゲストへ渡すため、ホストPCに物理的に存在しないキー
 * (テンキーの無いノートPCの Numpad8 等)は一生ゲストへ届かない。これを解決するため、
 * window の capture 段で SDL2 より先にイベントを横取りし、割当のあるキーだけを
 * 任意の PC-98 キーへ差し替えて注入する(当時の JOY-98V と同じ発想をキーボードに対して行う)。
 *
 * このファイルは UI/DOM に依存しない(テストしやすくするため)。実際に window へ
 * addEventListener するのは main.ts の責務。ここが持つのは:
 * - プロファイルの型・永続化(localStorage)・CRUDの純粋関数
 * - 「このキーを横取りすべきか」の判定(resolveHostKeyBinding)
 * - キー入力イベント(相当のオブジェクト)からの press/release ロジック(createHostKeyHandlers)
 */

import { NAMED_KEYS } from './keymap.ts';
import type { SharedKeyInput } from './shared-key-input.ts';

/** e.code(DOM の KeyboardEvent.code 文字列) -> PC-98 スキャンコード。 */
export type HostKeyBindings = Record<string, number>;

export interface HostKeyProfile {
  id: string;
  label: string;
  /** true の場合は編集・削除不可(複製は可)。組み込みプロファイル用。 */
  builtin?: boolean;
  bindings: HostKeyBindings;
}

export interface HostKeyStore {
  version: 1;
  profiles: HostKeyProfile[];
  activeId: string | null;
  enabled: boolean;
}

const HOSTKEY_STORAGE_KEY = 'webnp2.hostkey';

/** 組み込みプロファイルのid。読み取り専用判定・削除後のフォールバック選択に使う唯一の情報源。 */
export const BUILTIN_TENKEY_ARROWS_ID = 'builtin:tenkey-arrows';

/**
 * 組み込みプロファイル「テンキー移動(矢印キー→テンキー)」の正規の内容。
 * スキャンコードは keymap.ts の NAMED_KEYS を出典とする(NP2kai sdl/kbtrans.c 由来、推測しない)。
 * label はここでは内部識別用の非表示文字列(UI層は builtin:true のプロファイルについて
 * strings.ts 経由の翻訳済みラベルへ差し替えて表示する。ここに翻訳を持ち込まないのは、
 * このファイルを UI/DOM 非依存に保つため)。
 */
export function builtinTenkeyArrowsProfile(): HostKeyProfile {
  return {
    id: BUILTIN_TENKEY_ARROWS_ID,
    label: 'Tenkey Arrows (built-in)',
    builtin: true,
    bindings: {
      ArrowUp: NAMED_KEYS.KP8,
      ArrowDown: NAMED_KEYS.KP2,
      ArrowLeft: NAMED_KEYS.KP4,
      ArrowRight: NAMED_KEYS.KP6,
    },
  };
}

/** 既定ストア: 組み込みプロファイルのみ・それをアクティブに・機能自体はOFF。 */
export function emptyStore(): HostKeyStore {
  const builtin = builtinTenkeyArrowsProfile();
  return { version: 1, profiles: [builtin], activeId: builtin.id, enabled: false };
}

function isHostKeyBindings(v: unknown): v is HostKeyBindings {
  if (typeof v !== 'object' || v === null) return false;
  return Object.values(v as Record<string, unknown>).every((code) => typeof code === 'number' && Number.isFinite(code));
}

function isHostKeyProfile(v: unknown): v is HostKeyProfile {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id === '') return false;
  if (typeof o.label !== 'string') return false;
  if (o.builtin !== undefined && typeof o.builtin !== 'boolean') return false;
  return isHostKeyBindings(o.bindings);
}

/** 保存データの構造検証。1箇所でも型が崩れていれば false を返す。 */
function isHostKeyStore(v: unknown): v is HostKeyStore {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.version !== 1) return false;
  if (!Array.isArray(o.profiles) || !o.profiles.every(isHostKeyProfile)) return false;
  if (o.activeId !== null && typeof o.activeId !== 'string') return false;
  if (typeof o.enabled !== 'boolean') return false;
  return true;
}

/**
 * 組み込みプロファイルの内容を常に正規の値へ揃える(localStorageの手動編集等で内容が
 * ズレても、読み取り専用という不変条件を壊させない)。存在しなければ先頭へ補う。
 * activeId が実在しないプロファイルを指していたら null へ落とす(壊れた参照を残さない)。
 */
function normalizeStore(store: HostKeyStore): HostKeyStore {
  const builtin = builtinTenkeyArrowsProfile();
  const rest = store.profiles.filter((p) => p.id !== BUILTIN_TENKEY_ARROWS_ID);
  const profiles = [builtin, ...rest];
  const activeId = store.activeId !== null && profiles.some((p) => p.id === store.activeId) ? store.activeId : null;
  return { version: 1, profiles, activeId, enabled: store.enabled };
}

/**
 * localStorage から読み込む。存在しない/JSON破損/構造不正のいずれでも例外を投げず既定値
 * (空ストア)へフォールバックする(gamepad.ts の loadGamepadStore と同じ流儀)。
 */
export function loadHostKeyStore(storage: Pick<Storage, 'getItem'> = localStorage): HostKeyStore {
  const raw = storage.getItem(HOSTKEY_STORAGE_KEY);
  if (!raw) return emptyStore();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isHostKeyStore(parsed)) return normalizeStore(parsed);
    return emptyStore();
  } catch {
    return emptyStore();
  }
}

export function saveHostKeyStore(store: HostKeyStore, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(HOSTKEY_STORAGE_KEY, JSON.stringify(store));
}

// --- CRUD(すべて純粋関数。store を書き換えず新しい store を返す) ---

export function setEnabled(store: HostKeyStore, enabled: boolean): HostKeyStore {
  return { ...store, enabled };
}

/** id が存在しないプロファイルを指していれば無視する(不正な参照を作らせない)。null は「未選択」として許可。 */
export function setActiveProfile(store: HostKeyStore, id: string | null): HostKeyStore {
  if (id !== null && !store.profiles.some((p) => p.id === id)) return store;
  return { ...store, activeId: id };
}

function generateProfileId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `profile-${Date.now().toString(36)}-${rand}`;
}

/** 空の割当で新規プロファイルを作る。 */
export function createProfile(store: HostKeyStore, label: string): { store: HostKeyStore; id: string } {
  const id = generateProfileId();
  const profile: HostKeyProfile = { id, label, bindings: {} };
  return { store: { ...store, profiles: [...store.profiles, profile] }, id };
}

/**
 * 既存プロファイル(組み込みも可)の割当をコピーした新規プロファイルを作る。
 * 複製結果は builtin フラグを持たない(常に編集可能)。sourceId が存在しなければ null。
 */
export function duplicateProfile(
  store: HostKeyStore,
  sourceId: string,
  label: string,
): { store: HostKeyStore; id: string } | null {
  const source = store.profiles.find((p) => p.id === sourceId);
  if (!source) return null;
  const id = generateProfileId();
  const profile: HostKeyProfile = { id, label, bindings: { ...source.bindings } };
  return { store: { ...store, profiles: [...store.profiles, profile] }, id };
}

/** builtin プロファイルは読み取り専用のためリネームできない(無変更で返す)。 */
export function renameProfile(store: HostKeyStore, id: string, label: string): HostKeyStore {
  return {
    ...store,
    profiles: store.profiles.map((p) => (p.id === id && !p.builtin ? { ...p, label } : p)),
  };
}

/** builtin プロファイルは削除できない(無変更で返す)。削除対象がアクティブだった場合は activeId を null に落とす。 */
export function deleteProfile(store: HostKeyStore, id: string): HostKeyStore {
  const target = store.profiles.find((p) => p.id === id);
  if (!target || target.builtin) return store;
  const profiles = store.profiles.filter((p) => p.id !== id);
  const activeId = store.activeId === id ? null : store.activeId;
  return { ...store, profiles, activeId };
}

/** builtin プロファイルへの割当編集は無視する(無変更で返す)。 */
export function setBinding(store: HostKeyStore, profileId: string, code: string, pc98Code: number): HostKeyStore {
  return {
    ...store,
    profiles: store.profiles.map((p) =>
      p.id === profileId && !p.builtin ? { ...p, bindings: { ...p.bindings, [code]: pc98Code } } : p,
    ),
  };
}

/** builtin プロファイルへの割当編集は無視する(無変更で返す)。 */
export function clearBinding(store: HostKeyStore, profileId: string, code: string): HostKeyStore {
  return {
    ...store,
    profiles: store.profiles.map((p) => {
      if (p.id !== profileId || p.builtin) return p;
      const bindings = { ...p.bindings };
      delete bindings[code];
      return { ...p, bindings };
    }),
  };
}

export function findProfile(store: HostKeyStore, id: string | null): HostKeyProfile | null {
  if (id === null) return null;
  return store.profiles.find((p) => p.id === id) ?? null;
}

export function activeProfile(store: HostKeyStore): HostKeyProfile | null {
  return findProfile(store, store.activeId);
}

// --- 横取り判定・press/release ロジック ---

/**
 * enabled かつアクティブプロファイルに code の割当があれば、割り当て先のPC-98スキャンコードを
 * 返す。それ以外(無効化中・アクティブプロファイル無し・その物理キーに割当が無い)は null
 * (=横取りせず素通しする、という呼び出し側への唯一のシグナル)。
 */
export function resolveHostKeyBinding(store: HostKeyStore, code: string): number | null {
  if (!store.enabled) return null;
  const profile = activeProfile(store);
  if (!profile) return null;
  const bound = profile.bindings[code];
  return typeof bound === 'number' ? bound : null;
}

/** SharedKeyInput へ登録する際のソース名。main.ts のゲームパッド/ソフトキーボードと共通の仕組み。 */
export const HOSTKEY_SOURCE = 'hostkey';

/**
 * keydown/keyup(相当のオブジェクト)を最小限だけ要求するインターフェース。
 * 実際の KeyboardEvent をそのまま渡せるが、テストでは同じ形の素のオブジェクトを渡せばよい
 * (DOM への依存を持ち込まないため、型として KeyboardEvent は使わない)。
 */
export interface HostKeyEventLike {
  code: string;
  repeat: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface HostKeyHandlers {
  /** window の keydown(capture段)へ渡す想定。割当があれば preventDefault+stopPropagation してSDLへ渡さない。 */
  onKeyDown(e: HostKeyEventLike): void;
  /** window の keyup(capture段)へ渡す想定。 */
  onKeyUp(e: HostKeyEventLike): void;
  /** 'hostkey' ソースの押しっぱなしをすべて離す(enabled OFF・プロファイル切替・編集・blur・非表示化時に呼ぶ)。 */
  releaseAll(): void;
}

/**
 * keydown/keyup ハンドラを作る。DOMへの登録(addEventListener)自体は呼び出し側(main.ts)の責務。
 * - 割当の無いキーは preventDefault/stopPropagation のどちらも呼ばない(素通し)。
 * - 割当のあるキーの keydown で e.repeat === true の場合は press を重ねない(既に押している扱い)。
 * - press/release は sharedKeyInput 経由(source: 'hostkey')。ソフトキーボード・ゲームパッドと
 *   同じ SharedKeyInput を共有すれば、同じPC-98キーを複数ソースが押していても片方のreleaseで
 *   break が飛ばない(参照カウント、shared-key-input.ts 参照)。
 */
export function createHostKeyHandlers(getStore: () => HostKeyStore, sharedKeyInput: Pick<SharedKeyInput, 'press' | 'release' | 'releaseSource'>): HostKeyHandlers {
  return {
    onKeyDown(e: HostKeyEventLike): void {
      const pc98Code = resolveHostKeyBinding(getStore(), e.code);
      if (pc98Code === null) return; // 割当なし: 一切触らず素通し。
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return; // 既に押している扱い: pressを重ねない。
      sharedKeyInput.press(HOSTKEY_SOURCE, pc98Code);
    },
    onKeyUp(e: HostKeyEventLike): void {
      const pc98Code = resolveHostKeyBinding(getStore(), e.code);
      if (pc98Code === null) return;
      e.preventDefault();
      e.stopPropagation();
      sharedKeyInput.release(HOSTKEY_SOURCE, pc98Code);
    },
    releaseAll(): void {
      sharedKeyInput.releaseSource(HOSTKEY_SOURCE);
    },
  };
}
