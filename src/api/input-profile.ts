import type { Binding } from './gamepad.ts';

export type InputBindings = Record<string, Binding>;

export interface InputProfile {
  id: string;
  label: string;
  builtin?: boolean;
  bindings: InputBindings;
}

export interface InputProfileStore {
  version: 1;
  profiles: InputProfile[];
  activeId: string | null;
  enabled: boolean;
}

export const VPAD_STORAGE_KEY = 'webnp2.vpad';
export const VPAD_DPAD_UP = 'dpad-up';
export const VPAD_DPAD_DOWN = 'dpad-down';
export const VPAD_DPAD_LEFT = 'dpad-left';
export const VPAD_DPAD_RIGHT = 'dpad-right';
export const VPAD_BTN_A = 'btn-a';
export const VPAD_BTN_B = 'btn-b';
export const VPAD_BTN_C = 'btn-c';
export const VPAD_BTN_D = 'btn-d';
export const VPAD_BTN_E = 'btn-e';
export const VPAD_BTN_F = 'btn-f';
export const VPAD_BTN_OPT1 = 'btn-opt1';
export const VPAD_BTN_OPT2 = 'btn-opt2';

export const BUILTIN_CURSOR_ZX_ID = 'builtin:cursor-zx';
export const BUILTIN_TENKEY_ID = 'builtin:tenkey';

const key = (code: number): Binding => ({ kind: 'key', code });

export function builtinCursorZxProfile(): InputProfile {
  return {
    id: BUILTIN_CURSOR_ZX_ID,
    label: 'Cursor + Z/X (built-in)',
    builtin: true,
    bindings: {
      [VPAD_DPAD_UP]: key(0x3a), [VPAD_DPAD_DOWN]: key(0x3d),
      [VPAD_DPAD_LEFT]: key(0x3b), [VPAD_DPAD_RIGHT]: key(0x3c),
      [VPAD_BTN_A]: key(0x29), [VPAD_BTN_B]: key(0x2a),
      [VPAD_BTN_OPT1]: key(0x1c), [VPAD_BTN_OPT2]: key(0x34),
    },
  };
}

export function builtinTenkeyProfile(): InputProfile {
  return {
    id: BUILTIN_TENKEY_ID,
    label: 'Tenkey + Z/X (built-in)',
    builtin: true,
    bindings: {
      [VPAD_DPAD_UP]: key(0x43), [VPAD_DPAD_DOWN]: key(0x4b),
      [VPAD_DPAD_LEFT]: key(0x46), [VPAD_DPAD_RIGHT]: key(0x48),
      [VPAD_BTN_A]: key(0x29), [VPAD_BTN_B]: key(0x2a),
      [VPAD_BTN_OPT1]: key(0x1c), [VPAD_BTN_OPT2]: key(0x34),
    },
  };
}

function builtins(): InputProfile[] {
  return [builtinCursorZxProfile(), builtinTenkeyProfile()];
}

export function emptyVpadStore(): InputProfileStore {
  return { version: 1, profiles: builtins(), activeId: BUILTIN_CURSOR_ZX_ID, enabled: false };
}

function isBinding(value: unknown): value is Binding {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return item.kind === 'key' && Number.isInteger(item.code) && Number(item.code) >= 0 && Number(item.code) <= 0xff;
}

function isStore(value: unknown): value is InputProfileStore {
  if (typeof value !== 'object' || value === null) return false;
  const store = value as Record<string, unknown>;
  return store.version === 1 && typeof store.enabled === 'boolean' &&
    (store.activeId === null || typeof store.activeId === 'string') && Array.isArray(store.profiles) &&
    store.profiles.every((profile) => {
      if (typeof profile !== 'object' || profile === null) return false;
      const p = profile as Record<string, unknown>;
      return typeof p.id === 'string' && p.id !== '' && typeof p.label === 'string' &&
        (p.builtin === undefined || typeof p.builtin === 'boolean') &&
        typeof p.bindings === 'object' && p.bindings !== null && Object.values(p.bindings).every(isBinding);
    });
}

export function normalizeVpadStore(store: InputProfileStore): InputProfileStore {
  const canonical = builtins();
  const builtinIds = new Set(canonical.map((profile) => profile.id));
  const profiles = [...canonical, ...store.profiles.filter((profile) => !builtinIds.has(profile.id))];
  const activeId = store.activeId !== null && profiles.some((profile) => profile.id === store.activeId)
    ? store.activeId : BUILTIN_CURSOR_ZX_ID;
  return { version: 1, profiles, activeId, enabled: store.enabled };
}

export function loadVpadStore(storage: Pick<Storage, 'getItem'> = localStorage): InputProfileStore {
  const raw = storage.getItem(VPAD_STORAGE_KEY);
  if (!raw) return emptyVpadStore();
  try {
    const parsed: unknown = JSON.parse(raw);
    return isStore(parsed) ? normalizeVpadStore(parsed) : emptyVpadStore();
  } catch {
    return emptyVpadStore();
  }
}

export function saveVpadStore(store: InputProfileStore, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(VPAD_STORAGE_KEY, JSON.stringify(store));
}

export function activeProfile(store: InputProfileStore): InputProfile | null {
  return store.profiles.find((profile) => profile.id === store.activeId) ?? null;
}

export function setVpadEnabled(store: InputProfileStore, enabled: boolean): InputProfileStore {
  return { ...store, enabled };
}

export function setActiveProfile(store: InputProfileStore, id: string): InputProfileStore {
  return store.profiles.some((profile) => profile.id === id) ? { ...store, activeId: id } : store;
}

export function createProfile(store: InputProfileStore, label: string): InputProfileStore {
  const id = `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return { ...store, activeId: id, profiles: [...store.profiles, { id, label, bindings: {} }] };
}

export function duplicateProfile(store: InputProfileStore, sourceId: string, label: string): InputProfileStore {
  const source = store.profiles.find((profile) => profile.id === sourceId);
  if (!source) return store;
  const id = `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return { ...store, activeId: id, profiles: [...store.profiles, { id, label, bindings: { ...source.bindings } }] };
}

export function renameProfile(store: InputProfileStore, id: string, label: string): InputProfileStore {
  return { ...store, profiles: store.profiles.map((p) => p.id === id && !p.builtin ? { ...p, label } : p) };
}

export function deleteProfile(store: InputProfileStore, id: string): InputProfileStore {
  const target = store.profiles.find((p) => p.id === id);
  if (!target || target.builtin) return store;
  const profiles = store.profiles.filter((p) => p.id !== id);
  return { ...store, profiles, activeId: store.activeId === id ? profiles[0]?.id ?? null : store.activeId };
}

export function setBinding(store: InputProfileStore, profileId: string, sourceId: string, code: number): InputProfileStore {
  return { ...store, profiles: store.profiles.map((p) => p.id === profileId && !p.builtin
    ? { ...p, bindings: { ...p.bindings, [sourceId]: key(code) } } : p) };
}

export function clearBinding(store: InputProfileStore, profileId: string, sourceId: string): InputProfileStore {
  return { ...store, profiles: store.profiles.map((p) => {
    if (p.id !== profileId || p.builtin) return p;
    const bindings = { ...p.bindings };
    delete bindings[sourceId];
    return { ...p, bindings };
  }) };
}
