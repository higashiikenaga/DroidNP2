import { describe, expect, it, vi } from 'vitest';
import {
  activeProfile,
  BUILTIN_TENKEY_ARROWS_ID,
  builtinTenkeyArrowsProfile,
  createHostKeyHandlers,
  createProfile,
  clearBinding,
  deleteProfile,
  duplicateProfile,
  emptyStore,
  findProfile,
  HOSTKEY_SOURCE,
  loadHostKeyStore,
  renameProfile,
  resolveHostKeyBinding,
  saveHostKeyStore,
  setActiveProfile,
  setBinding,
  setEnabled,
  type HostKeyStore,
} from '../src/api/hostkey.ts';
import { NAMED_KEYS } from '../src/api/keymap.ts';
import { SharedKeyInput } from '../src/api/shared-key-input.ts';

/** テスト用の最小 localStorage モック(gamepad.test.ts と同じ流儀)。 */
function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

describe('emptyStore/builtin', () => {
  it('既定ストアは組み込みプロファイルのみを持ち、それがアクティブで、機能はOFF', () => {
    const store = emptyStore();
    expect(store.profiles).toHaveLength(1);
    expect(store.profiles[0].id).toBe(BUILTIN_TENKEY_ARROWS_ID);
    expect(store.profiles[0].builtin).toBe(true);
    expect(store.activeId).toBe(BUILTIN_TENKEY_ARROWS_ID);
    expect(store.enabled).toBe(false);
  });

  it('組み込みプロファイルの中身はNAMED_KEYS由来のテンキー方向キー(推測でない値)', () => {
    const builtin = builtinTenkeyArrowsProfile();
    expect(builtin.bindings.ArrowUp).toBe(NAMED_KEYS.KP8);
    expect(builtin.bindings.ArrowDown).toBe(NAMED_KEYS.KP2);
    expect(builtin.bindings.ArrowLeft).toBe(NAMED_KEYS.KP4);
    expect(builtin.bindings.ArrowRight).toBe(NAMED_KEYS.KP6);
  });
});

describe('永続化: load/save', () => {
  it('データが無ければ既定値(空ストア)を返す', () => {
    const storage = makeStorage();
    expect(loadHostKeyStore(storage)).toEqual(emptyStore());
  });

  it('JSON破損データは既定値へフォールバックする', () => {
    const storage = makeStorage();
    storage.setItem('webnp2.hostkey', '{not valid json');
    expect(loadHostKeyStore(storage)).toEqual(emptyStore());
  });

  it('構造不正(version違い)は既定値へフォールバックする', () => {
    const storage = makeStorage();
    storage.setItem('webnp2.hostkey', JSON.stringify({ version: 2, profiles: [], activeId: null, enabled: false }));
    expect(loadHostKeyStore(storage)).toEqual(emptyStore());
  });

  it('構造不正(bindingsの値が数値でない)は既定値へフォールバックする', () => {
    const storage = makeStorage();
    storage.setItem(
      'webnp2.hostkey',
      JSON.stringify({
        version: 1,
        profiles: [{ id: 'p1', label: 'x', bindings: { ArrowUp: 'not-a-number' } }],
        activeId: null,
        enabled: false,
      }),
    );
    expect(loadHostKeyStore(storage)).toEqual(emptyStore());
  });

  it('保存して読み直すと同じ内容が復元できる', () => {
    const storage = makeStorage();
    const { store: created, id } = createProfile(emptyStore(), 'My Profile');
    const withBinding = setBinding(created, id, 'KeyZ', NAMED_KEYS.SPACE);
    const withActive = setActiveProfile(withBinding, id);
    saveHostKeyStore(withActive, storage);
    const loaded = loadHostKeyStore(storage);
    expect(loaded.activeId).toBe(id);
    expect(findProfile(loaded, id)?.bindings.KeyZ).toBe(NAMED_KEYS.SPACE);
  });

  it('activeIdが実在しないプロファイルを指す壊れたデータはnullへ落とす(normalizeStore)', () => {
    const storage = makeStorage();
    storage.setItem(
      'webnp2.hostkey',
      JSON.stringify({ version: 1, profiles: [builtinTenkeyArrowsProfile()], activeId: 'ghost', enabled: false }),
    );
    const loaded = loadHostKeyStore(storage);
    expect(loaded.activeId).toBeNull();
  });

  it('組み込みプロファイルが保存データから欠けていても読み込み時に補われる', () => {
    const storage = makeStorage();
    storage.setItem('webnp2.hostkey', JSON.stringify({ version: 1, profiles: [], activeId: null, enabled: false }));
    const loaded = loadHostKeyStore(storage);
    expect(loaded.profiles.some((p) => p.id === BUILTIN_TENKEY_ARROWS_ID)).toBe(true);
  });

  it('localStorage上で組み込みプロファイルの中身が改ざんされても正規の内容へ強制される(読み取り専用の不変条件)', () => {
    const storage = makeStorage();
    storage.setItem(
      'webnp2.hostkey',
      JSON.stringify({
        version: 1,
        profiles: [{ id: BUILTIN_TENKEY_ARROWS_ID, label: 'tampered', builtin: false, bindings: { KeyQ: 1 } }],
        activeId: null,
        enabled: false,
      }),
    );
    const loaded = loadHostKeyStore(storage);
    const builtin = findProfile(loaded, BUILTIN_TENKEY_ARROWS_ID);
    expect(builtin?.builtin).toBe(true);
    expect(builtin?.bindings).toEqual(builtinTenkeyArrowsProfile().bindings);
  });
});

describe('CRUD', () => {
  it('createProfile: 空の割当で新規プロファイルを追加する', () => {
    const { store, id } = createProfile(emptyStore(), 'New');
    const profile = findProfile(store, id);
    expect(profile?.label).toBe('New');
    expect(profile?.bindings).toEqual({});
    expect(profile?.builtin).toBeUndefined();
  });

  it('duplicateProfile: 組み込みプロファイルも複製でき、複製結果はbuiltinでない(編集可能)', () => {
    const result = duplicateProfile(emptyStore(), BUILTIN_TENKEY_ARROWS_ID, 'Copy of builtin');
    expect(result).not.toBeNull();
    const profile = findProfile(result!.store, result!.id);
    expect(profile?.builtin).toBeUndefined();
    expect(profile?.bindings).toEqual(builtinTenkeyArrowsProfile().bindings);
  });

  it('duplicateProfile: 存在しないsourceIdはnullを返す', () => {
    expect(duplicateProfile(emptyStore(), 'ghost', 'x')).toBeNull();
  });

  it('renameProfile: 通常プロファイルはリネームできる', () => {
    const { store, id } = createProfile(emptyStore(), 'Old');
    const renamed = renameProfile(store, id, 'Renamed');
    expect(findProfile(renamed, id)?.label).toBe('Renamed');
  });

  it('renameProfile: 組み込みプロファイルはリネームできない(無変更で返る)', () => {
    const store = emptyStore();
    const attempted = renameProfile(store, BUILTIN_TENKEY_ARROWS_ID, 'Hacked');
    expect(findProfile(attempted, BUILTIN_TENKEY_ARROWS_ID)?.label).toBe(builtinTenkeyArrowsProfile().label);
  });

  it('deleteProfile: 通常プロファイルは削除でき、それがアクティブだった場合activeIdはnullになる', () => {
    const { store, id } = createProfile(emptyStore(), 'ToDelete');
    const activated = setActiveProfile(store, id);
    const deleted = deleteProfile(activated, id);
    expect(findProfile(deleted, id)).toBeNull();
    expect(deleted.activeId).toBeNull();
  });

  it('deleteProfile: 組み込みプロファイルは削除できない(無変更で返る)', () => {
    const store = emptyStore();
    const attempted = deleteProfile(store, BUILTIN_TENKEY_ARROWS_ID);
    expect(findProfile(attempted, BUILTIN_TENKEY_ARROWS_ID)).not.toBeNull();
    expect(attempted.profiles).toHaveLength(1);
  });

  it('setBinding/clearBinding: 通常プロファイルは編集できる', () => {
    const { store, id } = createProfile(emptyStore(), 'P');
    const withBinding = setBinding(store, id, 'KeyA', NAMED_KEYS.CTRL);
    expect(findProfile(withBinding, id)?.bindings.KeyA).toBe(NAMED_KEYS.CTRL);
    const cleared = clearBinding(withBinding, id, 'KeyA');
    expect(findProfile(cleared, id)?.bindings.KeyA).toBeUndefined();
  });

  it('setBinding/clearBinding: 組み込みプロファイルへの編集は無視される(読み取り専用)', () => {
    const store = emptyStore();
    const attempted = setBinding(store, BUILTIN_TENKEY_ARROWS_ID, 'KeyQ', NAMED_KEYS.CTRL);
    expect(findProfile(attempted, BUILTIN_TENKEY_ARROWS_ID)?.bindings.KeyQ).toBeUndefined();
    const attemptedClear = clearBinding(store, BUILTIN_TENKEY_ARROWS_ID, 'ArrowUp');
    expect(findProfile(attemptedClear, BUILTIN_TENKEY_ARROWS_ID)?.bindings.ArrowUp).toBe(NAMED_KEYS.KP8);
  });

  it('setActiveProfile: 存在しないidは無視される(無変更で返る)', () => {
    const store = emptyStore();
    const attempted = setActiveProfile(store, 'ghost');
    expect(attempted.activeId).toBe(store.activeId);
  });

  it('setActiveProfile: nullは常に許可される(未選択状態)', () => {
    const store = emptyStore();
    expect(setActiveProfile(store, null).activeId).toBeNull();
  });

  it('setEnabled: enabledフラグを切り替える', () => {
    const store = emptyStore();
    expect(setEnabled(store, true).enabled).toBe(true);
    expect(setEnabled(store, true).enabled).not.toBe(store.enabled);
  });
});

describe('resolveHostKeyBinding(横取り判定)', () => {
  it('enabled=falseなら常にnull(素通し)', () => {
    const store = setActiveProfile(emptyStore(), BUILTIN_TENKEY_ARROWS_ID);
    expect(resolveHostKeyBinding(store, 'ArrowUp')).toBeNull();
  });

  it('enabled=true・アクティブプロファインに割当があればPC-98スキャンコードを返す', () => {
    const store = setEnabled(emptyStore(), true);
    expect(resolveHostKeyBinding(store, 'ArrowUp')).toBe(NAMED_KEYS.KP8);
    expect(resolveHostKeyBinding(store, 'ArrowDown')).toBe(NAMED_KEYS.KP2);
    expect(resolveHostKeyBinding(store, 'ArrowLeft')).toBe(NAMED_KEYS.KP4);
    expect(resolveHostKeyBinding(store, 'ArrowRight')).toBe(NAMED_KEYS.KP6);
  });

  it('割当の無いキーはnull(素通し)', () => {
    const store = setEnabled(emptyStore(), true);
    expect(resolveHostKeyBinding(store, 'KeyA')).toBeNull();
  });

  it('activeIdがnull(未選択)ならenabledでも常にnull', () => {
    const store = setEnabled(setActiveProfile(emptyStore(), null), true);
    expect(resolveHostKeyBinding(store, 'ArrowUp')).toBeNull();
  });
});

// --- インターセプト(keydown/keyup ハンドラ)のテスト ---

function makeEvent(code: string, repeat = false): { code: string; repeat: boolean; preventDefault: () => void; stopPropagation: () => void; preventedDefault: boolean; stoppedPropagation: boolean } {
  const e = {
    code,
    repeat,
    preventedDefault: false,
    stoppedPropagation: false,
    preventDefault() {
      e.preventedDefault = true;
    },
    stopPropagation() {
      e.stoppedPropagation = true;
    },
  };
  return e;
}

describe('createHostKeyHandlers', () => {
  function setup(store: HostKeyStore) {
    const pressed: number[] = [];
    const released: number[] = [];
    const releasedSources: string[] = [];
    const fakeShared = {
      press: vi.fn((source: string, code: number) => void (source === HOSTKEY_SOURCE && pressed.push(code))),
      release: vi.fn((source: string, code: number) => void (source === HOSTKEY_SOURCE && released.push(code))),
      releaseSource: vi.fn((source: string) => void releasedSources.push(source)),
    };
    const handlers = createHostKeyHandlers(() => store, fakeShared);
    return { handlers, fakeShared, pressed, released, releasedSources };
  }

  it('割当済みキー(ArrowUp)のkeydownはpreventDefault+stopPropagationし、SharedKeyInputへpressする', () => {
    const store = setEnabled(emptyStore(), true);
    const { handlers, pressed } = setup(store);
    const e = makeEvent('ArrowUp');
    handlers.onKeyDown(e);
    expect(e.preventedDefault).toBe(true);
    expect(e.stoppedPropagation).toBe(true);
    expect(pressed).toEqual([NAMED_KEYS.KP8]);
  });

  it('割当の無いキー(KeyA)は一切preventDefault/stopPropagationせず、pressも呼ばない(素通し)', () => {
    const store = setEnabled(emptyStore(), true);
    const { handlers, pressed, fakeShared } = setup(store);
    const e = makeEvent('KeyA');
    handlers.onKeyDown(e);
    expect(e.preventedDefault).toBe(false);
    expect(e.stoppedPropagation).toBe(false);
    expect(pressed).toEqual([]);
    expect(fakeShared.press).not.toHaveBeenCalled();
  });

  it('enabled=falseなら割当があっても一切触らない(横取りしない)', () => {
    const store = setEnabled(emptyStore(), false);
    const { handlers, fakeShared } = setup(store);
    const e = makeEvent('ArrowUp');
    handlers.onKeyDown(e);
    expect(e.preventedDefault).toBe(false);
    expect(e.stoppedPropagation).toBe(false);
    expect(fakeShared.press).not.toHaveBeenCalled();
  });

  it('e.repeat===trueのkeydownはpressを重ねない(既に押している扱い)がpreventDefaultはする', () => {
    const store = setEnabled(emptyStore(), true);
    const { handlers, pressed } = setup(store);
    handlers.onKeyDown(makeEvent('ArrowUp', false));
    const repeatEvent = makeEvent('ArrowUp', true);
    handlers.onKeyDown(repeatEvent);
    expect(repeatEvent.preventedDefault).toBe(true);
    expect(pressed).toEqual([NAMED_KEYS.KP8]); // 2回目は積まれない。
  });

  it('keyupはreleaseする', () => {
    const store = setEnabled(emptyStore(), true);
    const { handlers, released } = setup(store);
    handlers.onKeyDown(makeEvent('ArrowUp'));
    handlers.onKeyUp(makeEvent('ArrowUp'));
    expect(released).toEqual([NAMED_KEYS.KP8]);
  });

  it('releaseAllはHOSTKEY_SOURCEに対してreleaseSourceを呼ぶ', () => {
    const store = setEnabled(emptyStore(), true);
    const { handlers, releasedSources } = setup(store);
    handlers.releaseAll();
    expect(releasedSources).toEqual([HOSTKEY_SOURCE]);
  });
});

// --- SharedKeyInputとの統合: 'hostkey'と'softkeyboard'が同じPC-98キーを押しているとき、
// 片方のreleaseだけではbreakが飛ばないこと。 ---
describe('SharedKeyInput統合', () => {
  it('hostkeyとsoftkeyboardが同じキーを押している間、片方が離してもbreakが飛ばない', () => {
    const outputs: Array<{ code: number; down: boolean }> = [];
    const sharedKeyInput = new SharedKeyInput((code, down) => outputs.push({ code, down }));
    const store = setEnabled(emptyStore(), true);
    const handlers = createHostKeyHandlers(() => store, sharedKeyInput);

    handlers.onKeyDown(makeEvent('ArrowUp')); // hostkey: KP8 down
    sharedKeyInput.press('softkeyboard', NAMED_KEYS.KP8); // softkeyboard: KP8 down(2人目、makeなので追加pressは無い)

    expect(outputs).toEqual([{ code: NAMED_KEYS.KP8, down: true }]); // 最初の1回だけdownが飛ぶ。

    handlers.onKeyUp(makeEvent('ArrowUp')); // hostkeyだけ離す
    expect(outputs).toEqual([{ code: NAMED_KEYS.KP8, down: true }]); // breakはまだ飛ばない(softkeyboardがまだ押している)。

    sharedKeyInput.release('softkeyboard', NAMED_KEYS.KP8); // 最後の1人が離す
    expect(outputs).toEqual([
      { code: NAMED_KEYS.KP8, down: true },
      { code: NAMED_KEYS.KP8, down: false },
    ]);
  });
});
