import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CURSOR_ZX_ID, VPAD_STORAGE_KEY, activeProfile, clearBinding, deleteProfile,
  createProfile, duplicateProfile, emptyVpadStore, loadVpadStore, normalizeVpadStore, setActiveProfile,
  setBinding, setVpadEnabled,
} from '../src/api/input-profile.ts';

const storage = (value: string | null): Pick<Storage, 'getItem'> => ({ getItem: () => value });

describe('バーチャルパッド入力プロファイル', () => {
  it('既定値は組み込みカーソル+Z/Xが選択され、表示はOFF', () => {
    const store = emptyVpadStore();
    expect(store.version).toBe(1); expect(store.enabled).toBe(false);
    expect(store.activeId).toBe(BUILTIN_CURSOR_ZX_ID);
    expect(activeProfile(store)?.bindings['dpad-up']).toEqual({ kind: 'key', code: 0x3a });
  });
  it('不正JSON・異なるversion・範囲外コードはすべて既定値へ戻す', () => {
    expect(loadVpadStore(storage('{'))).toEqual(emptyVpadStore());
    expect(loadVpadStore(storage(JSON.stringify({ ...emptyVpadStore(), version: 2 })))).toEqual(emptyVpadStore());
    const invalid = emptyVpadStore(); invalid.profiles[0].bindings['btn-a'] = { kind: 'key', code: 999 };
    expect(loadVpadStore(storage(JSON.stringify(invalid)))).toEqual(emptyVpadStore());
  });
  it('localStorageキーはWebNP2名前空間を使う', () => expect(VPAD_STORAGE_KEY).toBe('webnp2.vpad'));
  it('組み込みプロファイルの改変を正規化で復元する', () => {
    const store = emptyVpadStore(); store.profiles[0].bindings['btn-a'] = { kind: 'key', code: 1 };
    expect(normalizeVpadStore(store).profiles[0].bindings['btn-a'].code).toBe(0x29);
  });
  it('複製したプロファイルは編集・解除・削除できる', () => {
    let store = duplicateProfile(emptyVpadStore(), BUILTIN_CURSOR_ZX_ID, '編集用');
    const id = store.activeId!; expect(store.profiles.find((p) => p.id === id)?.builtin).toBeUndefined();
    store = setBinding(store, id, 'btn-a', 0x34);
    expect(activeProfile(store)?.bindings['btn-a'].code).toBe(0x34);
    store = clearBinding(store, id, 'btn-a'); expect(activeProfile(store)?.bindings['btn-a']).toBeUndefined();
    store = deleteProfile(store, id); expect(store.profiles.some((p) => p.id === id)).toBe(false);
  });
  it('空の新規プロファイルを作成してアクティブにする', () => {
    const store = createProfile(emptyVpadStore(), '新規');
    expect(activeProfile(store)).toMatchObject({ label: '新規', bindings: {} });
  });
  it('組み込みプロファイルは編集・削除できない', () => {
    const base = emptyVpadStore();
    expect(setBinding(base, BUILTIN_CURSOR_ZX_ID, 'btn-a', 1)).toEqual(base);
    expect(deleteProfile(base, BUILTIN_CURSOR_ZX_ID)).toEqual(base);
  });
  it('存在しないプロファイルへの切替を無視し、ON/OFFだけ更新できる', () => {
    const base = emptyVpadStore(); expect(setActiveProfile(base, 'missing')).toEqual(base);
    expect(setVpadEnabled(base, true).enabled).toBe(true);
  });
});
