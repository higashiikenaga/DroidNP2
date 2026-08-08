import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_DEADZONE, detectNewlyActiveSource, snapshotPad, type Binding, type PadSnapshot, type Source } from '../src/api/gamepad.ts';
import { SharedKeyInput } from '../src/api/shared-key-input.ts';

// strings.ts はモジュール初期化時に resolveLang() → location.search を参照するため、
// Node環境(vitest environment: 'node')には無い location をここで用意してから
// dynamic import する(WebX68k側 test/gamepad-ui.test.ts と同じ流儀)。gamepad-ui.ts は
// strings.ts を静的importしているため、gamepad-ui.ts 自体も dynamic import にする必要がある。
let toDisplayIndex: (typeof import('../src/ui/gamepad-ui.ts'))['toDisplayIndex'];
let formatAxisValue: (typeof import('../src/ui/gamepad-ui.ts'))['formatAxisValue'];
let sourceLabel: (typeof import('../src/ui/gamepad-ui.ts'))['sourceLabel'];
let IDLE_DETECT_FLOW_STATE: (typeof import('../src/ui/gamepad-ui.ts'))['IDLE_DETECT_FLOW_STATE'];
let startRowDetectFlow: (typeof import('../src/ui/gamepad-ui.ts'))['startRowDetectFlow'];
let startGenericDetectFlow: (typeof import('../src/ui/gamepad-ui.ts'))['startGenericDetectFlow'];
let resolveDetectFound: (typeof import('../src/ui/gamepad-ui.ts'))['resolveDetectFound'];
let cancelDetectFlow: (typeof import('../src/ui/gamepad-ui.ts'))['cancelDetectFlow'];
let cancelPendingGenericFlow: (typeof import('../src/ui/gamepad-ui.ts'))['cancelPendingGenericFlow'];
let resolvePendingGenericPicked: (typeof import('../src/ui/gamepad-ui.ts'))['resolvePendingGenericPicked'];
let freshPadFor: (typeof import('../src/ui/gamepad-ui.ts'))['freshPadFor'];

beforeAll(async () => {
  if (typeof (globalThis as { location?: unknown }).location === 'undefined') {
    (globalThis as { location?: { search: string } }).location = { search: '' };
  }
  ({
    toDisplayIndex,
    formatAxisValue,
    sourceLabel,
    IDLE_DETECT_FLOW_STATE,
    startRowDetectFlow,
    startGenericDetectFlow,
    resolveDetectFound,
    cancelDetectFlow,
    cancelPendingGenericFlow,
    resolvePendingGenericPicked,
    freshPadFor,
  } = await import('../src/ui/gamepad-ui.ts'));
  // 実行環境のnavigator.languageに依存せず文言を固定するため、明示的に日本語へ設定する。
  const { setLang } = await import('../src/ui/strings.ts');
  setLang('ja');
});

const BASELINE: PadSnapshot = { buttons: [false, false], axes: [0, 0] };
const BUTTON0_SOURCE: Source = { kind: 'button', index: 0 };
const BUTTON6_SOURCE: Source = { kind: 'button', index: 6 };
const KEY_Z_BINDING: Binding = { kind: 'key', code: 0x29 };

// テスト用の最小 Gamepad モック(sourceLabel はボタン/軸の押下状態を見ないため中身は空でよい)。
// id/pressed は freshPadFor の回帰テスト(古いpad参照 vs 最新pads配列)のために追加。
function makeGamepad(
  opts: { id?: string; mapping?: '' | 'standard'; buttonCount?: number; pressed?: readonly number[] } = {},
): Gamepad {
  const buttonCount = opts.buttonCount ?? 17;
  const pressedSet = new Set(opts.pressed ?? []);
  const buttons = Array.from({ length: buttonCount }, (_, i) => ({
    pressed: pressedSet.has(i),
    touched: pressedSet.has(i),
    value: pressedSet.has(i) ? 1 : 0,
  }));
  return {
    id: opts.id ?? 'mock',
    index: 0,
    connected: true,
    timestamp: 0,
    mapping: opts.mapping ?? 'standard',
    buttons: buttons as unknown as readonly GamepadButton[],
    axes: [0, 0, 0, 0],
    hapticActuators: [],
    vibrationActuator: null as unknown as GamepadHapticActuator,
  } as Gamepad;
}

describe('toDisplayIndex', () => {
  it('0始まりのGamepad API indexを1始まりの表示用番号へ変換する', () => {
    expect(toDisplayIndex(0)).toBe(1);
    expect(toDisplayIndex(1)).toBe(2);
    expect(toDisplayIndex(15)).toBe(16);
  });
});

describe('formatAxisValue(丸めて0になる負値は"-0.00"ではなく"0.00"にする)', () => {
  it('丸めるとゼロになる微小な負値は符号を落とす', () => {
    expect(formatAxisValue(-0.00392)).toBe('0.00');
    expect(formatAxisValue(-0.004)).toBe('0.00');
  });
  it('丸めても非ゼロが残る負値は符号を保つ', () => {
    expect(formatAxisValue(-0.02)).toBe('-0.02');
    expect(formatAxisValue(-1)).toBe('-1.00');
  });
  it('ちょうど0とプラス値はそのまま', () => {
    expect(formatAxisValue(0)).toBe('0.00');
    expect(formatAxisValue(3.28571)).toBe('3.29');
  });
});

describe('sourceLabel (表示は1始まり)', () => {
  it('standard mappingのボタンindex0は#1として位置名付きで表示される(下ボタン)', () => {
    const pad = makeGamepad({ mapping: 'standard' });
    const label = sourceLabel({ kind: 'button', index: 0 }, pad);
    expect(label).toContain('#1');
    expect(label).not.toContain('#0');
  });

  it('standard mappingのボタンindex15は#16と表示される', () => {
    const pad = makeGamepad({ mapping: 'standard' });
    const label = sourceLabel({ kind: 'button', index: 15 }, pad);
    expect(label).toContain('#16');
  });

  it('非standard mappingのボタンは1始まり番号のみで表示される', () => {
    const pad = makeGamepad({ mapping: '' });
    expect(sourceLabel({ kind: 'button', index: 0 }, pad)).toBe('ボタン1');
    expect(sourceLabel({ kind: 'button', index: 15 }, pad)).toBe('ボタン16');
  });

  it('軸は1始まりのindexで表示される', () => {
    const pad = makeGamepad();
    expect(sourceLabel({ kind: 'axis', index: 0, dir: 1 }, pad)).toBe('軸1 +');
    expect(sourceLabel({ kind: 'axis', index: 3, dir: -1 }, pad)).toBe('軸4 -');
  });
});

// 検出待ち状態の純粋な状態遷移。WebX68k版はJoyTarget(UP/DOWN/…)固定の行を対象にしていたが、
// WebNP2版は「行=既存のSource+Binding」を対象にする(kind:'row'は物理入力の再検出、
// kind:'generic'は新規行追加のための物理入力検出)。DOM/Gamepad APIを介さず状態遷移だけを検証する。
describe('検出待ち状態の遷移(DOM非依存の純粋ロジック)', () => {
  it('行の再検出: 開始→入力で確定→呼び出し側が別途Sourceを差し替え、detectはidleに戻る', () => {
    const started = startRowDetectFlow('pad-1', BUTTON0_SOURCE, KEY_Z_BINDING, BASELINE);
    expect(started.detect).toEqual({ kind: 'row', padId: 'pad-1', source: BUTTON0_SOURCE, binding: KEY_Z_BINDING, baseline: BASELINE });
    expect(started.pendingGeneric).toBeNull();

    const found = resolveDetectFound(started, BUTTON6_SOURCE);
    expect(found.detect).toBeNull();
    expect(found.pendingGeneric).toBeNull(); // 行の再検出は即確定。キー選択待ちにはならない。
  });

  it('行の再検出: キャンセルで開始前の状態(idle)に戻る', () => {
    const started = startRowDetectFlow('pad-1', BUTTON0_SOURCE, KEY_Z_BINDING, BASELINE);
    const cancelled = cancelDetectFlow(started);
    expect(cancelled).toEqual(IDLE_DETECT_FLOW_STATE);
  });

  it('新規検出: 開始→入力で確定すると、即座には終わらずキー選択待ち(pendingGeneric)へ進む', () => {
    const started = startGenericDetectFlow('pad-1', BASELINE);
    expect(started.detect).toEqual({ kind: 'generic', padId: 'pad-1', baseline: BASELINE });

    const found = resolveDetectFound(started, BUTTON0_SOURCE);
    expect(found.detect).toBeNull();
    expect(found.pendingGeneric).toEqual({ padId: 'pad-1', source: BUTTON0_SOURCE });
  });

  it('新規検出: キー選択でidleに戻る(呼び出し側が別途addBindingを実行する)', () => {
    const pending = resolveDetectFound(startGenericDetectFlow('pad-1', BASELINE), BUTTON0_SOURCE);
    const picked = resolvePendingGenericPicked(pending);
    expect(picked).toEqual(IDLE_DETECT_FLOW_STATE);
  });

  it('新規検出: キー選択待ち中のキャンセルでidleに戻る(専用の[キャンセル]ボタン用)', () => {
    const pending = resolveDetectFound(startGenericDetectFlow('pad-1', BASELINE), BUTTON0_SOURCE);
    const cancelled = cancelPendingGenericFlow(pending);
    expect(cancelled).toEqual(IDLE_DETECT_FLOW_STATE);
  });

  it('根本原因の再発防止(WebX68k側の実機報告): キー選択待ち中に検出をもう一度開始しても、' +
    '以前検出できていた入力が黙って上書きされることはない(呼び出し側はpendingGeneric中は' +
    '[新規検出]ボタンをdisabledにする対策と対で、ここでは少なくとも状態自体は素直に開始状態へ戻ることを確認する回帰テスト)', () => {
    const pending = resolveDetectFound(startGenericDetectFlow('pad-1', BASELINE), BUTTON0_SOURCE);
    expect(pending.pendingGeneric).not.toBeNull();
    const restarted = startGenericDetectFlow('pad-1', BASELINE);
    expect(restarted.pendingGeneric).toBeNull();
    expect(restarted.detect).toEqual({ kind: 'generic', padId: 'pad-1', baseline: BASELINE });
  });

  it('別の行の再検出を開始すると、新規検出側のキー選択待ちは破棄される(両立させない)', () => {
    const pending = resolveDetectFound(startGenericDetectFlow('pad-1', BASELINE), BUTTON0_SOURCE);
    const switched = startRowDetectFlow('pad-1', BUTTON6_SOURCE, KEY_Z_BINDING, BASELINE);
    void pending;
    expect(switched.pendingGeneric).toBeNull();
    expect(switched.detect).toEqual({ kind: 'row', padId: 'pad-1', source: BUTTON6_SOURCE, binding: KEY_Z_BINDING, baseline: BASELINE });
  });

  it('detectがnullの時にresolveDetectFoundを呼んでも何もしない(型ガード漏れの保険)', () => {
    expect(resolveDetectFound(IDLE_DETECT_FLOW_STATE, BUTTON0_SOURCE)).toEqual(IDLE_DETECT_FLOW_STATE);
  });
});

// 実機報告(WebX68k側、2026-08-08): ページを開いた直後(パッド構成が一度も変わっていない状態)での
// み、検出が押下を一切拾わなくなる不具合。根本原因はrenderXxxのクリックハンドラに閉じ込められた
// padが「ダイアログを開いた瞬間」のGamepadオブジェクトのまま更新されないこと。WebNP2版でも
// startRowDetect/startGenericDetectの直前でfreshPadForを通す設計をそのまま踏襲しているため、
// 同じ回帰が起きないことを保証する。
describe('freshPadFor(検出開始時に古いpad参照ではなく最新スナップショットを使う, 実機報告の根本原因への対策)', () => {
  it('pads配列に同じidのpadがあれば、そちらを返す(渡されたpadが古くても最新を優先する)', () => {
    const stale = makeGamepad({ id: 'pad-1', pressed: [] });
    const fresh = makeGamepad({ id: 'pad-1', pressed: [6] });
    expect(freshPadFor([fresh], stale)).toBe(fresh);
  });

  it('該当パッドが見つからない(切断済み等)場合は、渡されたpadをそのまま返す', () => {
    const stale = makeGamepad({ id: 'pad-1' });
    expect(freshPadFor([], stale)).toBe(stale);
  });

  it('【回帰】検出開始直後の1フレーム目: 開始時点で既に押されている入力はbaselineに正しく反映され、' +
    '押しっぱなし扱いになる(=誤って「新規押下」として検出されない)', () => {
    const atOpenTime = makeGamepad({ id: 'pad-1', pressed: [] });
    const atClickTime = makeGamepad({ id: 'pad-1', pressed: [6] });
    const pads = [atClickTime];

    const baseline = snapshotPad(freshPadFor(pads, atOpenTime));
    const curr = snapshotPad(atClickTime);
    expect(detectNewlyActiveSource(baseline, curr, DEFAULT_DEADZONE)).toBeNull();
  });

  it('【回帰・修正前の再現】古いpad参照をそのままbaselineに使うと、検出開始前から押されていた' +
    'ボタンが「新規押下」に誤検出されてしまう(freshPadForを外すと再発することを保証する)', () => {
    const atOpenTime = makeGamepad({ id: 'pad-1', pressed: [] });
    const atClickTime = makeGamepad({ id: 'pad-1', pressed: [6] });

    const staleBaseline = snapshotPad(atOpenTime);
    const curr = snapshotPad(atClickTime);
    expect(detectNewlyActiveSource(staleBaseline, curr, DEFAULT_DEADZONE)).toEqual({ kind: 'button', index: 6 });
  });

  it('検出開始直後の1フレーム目でも、そのフレームで新たに押されたボタンは取りこぼさず検出する', () => {
    const atStart = makeGamepad({ id: 'pad-1', pressed: [] });
    const pads = [atStart];
    const baseline = snapshotPad(freshPadFor(pads, atStart));
    const curr = snapshotPad(makeGamepad({ id: 'pad-1', pressed: [6] }));
    expect(detectNewlyActiveSource(baseline, curr, DEFAULT_DEADZONE)).toEqual({ kind: 'button', index: 6 });
  });
});

// SharedKeyInput統一の回帰テスト: ソフトキーボード/ゲームパッドの2入力源が同じPC-98キーを
// 押している状況で、片方だけが離しても、もう一方がまだ押している間はコアへbreakが送られない
// (=キーが上がらない)ことを保証する。main.ts側の実配線(onVirtualKey/gamepadTickの両方が
// 同一のSharedKeyInputインスタンスへpress/releaseする構成)を、そのままここで再現する。
describe('SharedKeyInput統一: ソフトキーボードとゲームパッドが同じキーを共有しても片方を離しただけでは上がらない', () => {
  it('softkeyboardとgamepadが同じキーを押し、softkeyboardだけ離してもコアへbreakは送られない', () => {
    const calls: Array<{ code: number; down: boolean }> = [];
    const input = new SharedKeyInput((code, down) => calls.push({ code, down }));

    input.press('softkeyboard', 0x29); // Z
    input.press('gamepad:pad-1', 0x29);
    expect(calls).toEqual([{ code: 0x29, down: true }]); // 最初のpressだけmakeを送る(2件目は参照カウントのみ増加)。

    input.release('softkeyboard', 0x29);
    // gamepad側がまだ押しているため、breakは送られない(=キーが上がらない)。
    expect(calls).toEqual([{ code: 0x29, down: true }]);

    input.release('gamepad:pad-1', 0x29);
    // 最後の入力源が離れて初めてbreakが送られる。
    expect(calls).toEqual([
      { code: 0x29, down: true },
      { code: 0x29, down: false },
    ]);
  });

  it('パッド切断時のreleaseSource: そのパッドが押していた分だけ解除し、他の入力源が押している分は残す', () => {
    const calls: Array<{ code: number; down: boolean }> = [];
    const input = new SharedKeyInput((code, down) => calls.push({ code, down }));

    input.press('softkeyboard', 0x3a); // UP
    input.press('gamepad:pad-1', 0x3a);
    input.press('gamepad:pad-1', 0x3c); // RIGHT(softkeyboardは押していない)
    calls.length = 0;

    input.releaseSource('gamepad:pad-1'); // gamepadconnected/disconnectedハンドラ相当。

    // UPはsoftkeyboardがまだ押しているためbreakは送られない。RIGHTはgamepadだけが押していたためbreakが送られる。
    expect(calls).toEqual([{ code: 0x3c, down: false }]);
  });
});
