import { describe, expect, it, vi } from 'vitest';
import { bindStartupOverlayButtons } from '../src/ui/startup-overlay.ts';

function setup(includeFreeDos = true) {
  const overlay = new EventTarget();
  const plain = new EventTarget();
  const freeDos = includeFreeDos ? new EventTarget() : undefined;
  const library = new EventTarget();
  const actions = {
    startPlain: vi.fn(),
    startFreeDos: vi.fn(),
    openLibrary: vi.fn(),
  };
  bindStartupOverlayButtons({ plain, freeDos, library }, actions);
  return { overlay, plain, freeDos, library, actions };
}

describe('起動オーバーレイ', () => {
  it('余白クリックではどの起動処理も実行しない', () => {
    const { overlay, actions } = setup();
    overlay.dispatchEvent(new Event('click'));
    expect(actions.startPlain).not.toHaveBeenCalled();
    expect(actions.startFreeDos).not.toHaveBeenCalled();
    expect(actions.openLibrary).not.toHaveBeenCalled();
  });

  it('3つのボタンはそれぞれ従来の処理だけを実行する', () => {
    const { plain, freeDos, library, actions } = setup();
    plain.dispatchEvent(new Event('click'));
    freeDos?.dispatchEvent(new Event('click'));
    library.dispatchEvent(new Event('click'));
    expect(actions.startPlain).toHaveBeenCalledTimes(1);
    expect(actions.startFreeDos).toHaveBeenCalledTimes(1);
    expect(actions.openLibrary).toHaveBeenCalledTimes(1);
  });

  it('FreeDOSボタンを表示しない構成でも他の2ボタンを配線できる', () => {
    const { plain, library, actions } = setup(false);
    plain.dispatchEvent(new Event('click'));
    library.dispatchEvent(new Event('click'));
    expect(actions.startPlain).toHaveBeenCalledTimes(1);
    expect(actions.openLibrary).toHaveBeenCalledTimes(1);
  });
});
