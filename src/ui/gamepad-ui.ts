// ゲームパッド設定ダイアログ(見える化 + 割当編集)。
//
// WebX68k の gamepad-ui.ts を移植したもの。WebX68k はジョイスティック端子(RetroPad ID)へ
// 「JoyTarget(UP/DOWN/…/TRG1..8)固定の6〜12行」を割り当てる設計だったが、WebNP2 の
// gamepad.ts(移植済み)はジョイスティック端子・ポート・パッド種別のいずれも持たず、
// 物理入力(Source)を直接 PC-98キー(Binding)へ割り当てるだけの単純な対応表になっている。
// そのため編集UIも「固定行+コンボボックス」から「割当済み一覧(上段)+PC-98キーボード
// ピッカー(下段)」の作りへ差し替えている。行を選んで下のキーボードでキーを押すと、
// その場でスキャンコードが確定し、次の行へ選択が自動的に進む。
//
// 押下状態のライブ表示・検出(押して割り当て)のステートマシンはWebX68k版の設計をそのまま
// 踏襲する(DetectState/DetectFlowState等の名前・役割は同じ)。ただし「行」の識別子が
// JoyTarget(固定の意味を持つラベル)ではなく Source+Binding(その行が今束ねている物理入力と
// キーの組)になっている点が異なる: kind:'row' の検出は「この行の物理入力を検出し直す
// (割り当てるキーは変えない)」、kind:'generic' の検出は「新しい行を追加するために、まず
// 物理入力を検出する」という役割に読み替えている。
//
// 重要: ライブ表示・検出モードの押下判定はコア駆動(np2側のポーリング)に相乗りしない。
// コアが動いていないと呼ばれないため、起動前の確認・設定ができなくなってしまう。ダイアログが
// 開いている間だけ独立した requestAnimationFrame ループで navigator.getGamepads() を読み、
// 閉じたら必ず止める(リーク防止)。このループはコアへ入力を送らない(表示・編集専用)。
// コアへ実際に送るのは main.ts 側の GamepadManager.keysForPad() ポーリング(別ループ)のみ。

import {
  type Binding,
  CURSOR_ZX_PRESET,
  detectNewlyActiveSource,
  type PadSnapshot,
  snapshotPad,
  type Source,
  TENKEY_SPACE_PRESET,
} from '../api/gamepad.ts';
import { buildKbdRows, labelForKeyCode } from './kbd-layout.ts';
import { t } from './strings.ts';

/**
 * Gamepad API の standard mapping における物理ボタンの「位置」表記。
 * RetroPad命名をそのまま出すと実機印刷と食い違って混乱するため、index主表記+位置名の
 * 併記にする(例:「#1 (下)」。表示は1始まり、配列自体は0始まりのGamepad API index順)。
 * 並びは standard mapping の button index 順(0..16)。
 */
const STANDARD_BUTTON_POSITIONS: ReadonlyArray<() => string> = [
  () => t('gamepadPosDown'), // 0
  () => t('gamepadPosRight'), // 1
  () => t('gamepadPosLeft'), // 2
  () => t('gamepadPosUp'), // 3
  () => t('gamepadPosL'), // 4
  () => t('gamepadPosR'), // 5
  () => t('gamepadPosL2'), // 6
  () => t('gamepadPosR2'), // 7
  () => t('gamepadPosSelect'), // 8
  () => t('gamepadPosStart'), // 9
  () => t('gamepadPosL3'), // 10
  () => t('gamepadPosR3'), // 11
  () => t('gamepadPosDpadUp'), // 12
  () => t('gamepadPosDpadDown'), // 13
  () => t('gamepadPosDpadLeft'), // 14
  () => t('gamepadPosDpadRight'), // 15
  () => t('gamepadPosHome'), // 16
];

/**
 * main.ts側(バインディングの実体・GamepadManager・永続化を持つ側)から渡してもらう情報。
 * gamepad-ui.ts はロジックの二重実装をしない(表示と編集操作の仲介に徹する)。
 */
export interface GamepadDialogCallbacks {
  getDeadzone(pad: Gamepad): number;
  setDeadzone(pad: Gamepad, value: number): void;
  /** そのパッドの Source->Binding 対応を平らな配列で返す(一覧表示・編集対象の特定に使う)。 */
  getAllBindings(pad: Gamepad): Array<{ source: Source; binding: Binding }>;
  addBinding(pad: Gamepad, source: Source, binding: Binding): void;
  removeBinding(pad: Gamepad, source: Source, binding: Binding): void;
  /**
   * 指定軸が有効か、較正済みか、較正中か、静止値からの偏差でどちら向きに反応しているかを返す。
   * gamepad.ts の GamepadManager.axisState() をそのまま使ってもらう想定(判定ロジックの
   * 二重実装を避けるため。ライブ表示と実際の入力が同じ較正状態を共有する)。
   */
  getAxisState(pad: Gamepad, axisIndex: number): { valid: boolean; calibrated: boolean; calibrating: boolean; active: 1 | -1 | null };
  /** 現在コアへ送っている(=keysForPadが返す)PC-98キースキャンコードの集合。ライブ表示用。 */
  getActiveKeys(pad: Gamepad): Set<number>;
  /** 全バインディングを消してから指定プリセットを積み直す。 */
  resetToPreset(pad: Gamepad, preset: ReadonlyArray<{ source: Source; binding: Binding }>): void;
}

export interface GamepadDialog {
  open(): void;
  /** 言語切替時、ダイアログ内の静的文言を現在の言語で貼り直す。開いていればライブ表示・編集エリアも再描画する。 */
  applyStrings(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
}

/**
 * ボタン/軸番号の表示専用変換(内部は0始まりのGamepad API index、UI表示のみ1始まり)。
 * Windowsの「ゲームコントローラーの設定」の表記に合わせるための変換で、ここでしか+1しない
 * (localStorageの保存値は0始まりのまま扱うこと)。
 */
export function toDisplayIndex(index: number): number {
  return index + 1;
}

/**
 * 軸の生値を表示用に小数2桁へ丸める。判定(有効/較正/ON)には使わず表示のみに使う。
 * -0.00392 のような「丸めると0になる負値」を toFixed(2) だけで整形すると "-0.00" という
 * 見た目上マイナスに見えてしまうため、丸めた結果が0になる場合は符号を落として "0.00" にする。
 */
export function formatAxisValue(value: number): string {
  const rounded = value.toFixed(2);
  return rounded === '-0.00' ? '0.00' : rounded;
}

/**
 * 検出開始(行の[再検出]・[新規検出])で baseline を作る直前に、渡された pad を
 * 「今の pads 配列にある同じ id の pad」へ差し替える。
 *
 * renderBindingRow 等のクリックハンドラが閉じ込めている pad は「最後に renderEditor() が
 * 走った時点」の Gamepad オブジェクトで、その後 navigator.getGamepads() を呼び直すまで値が
 * 更新される保証が無い(MDNも同種の注意書きあり)。呼び出し側は必ず connectedPads() のような
 * 最新の pads 配列をここへ渡すこと。該当パッドが見つからない場合は渡された pad をそのまま返す。
 */
export function freshPadFor(pads: readonly Gamepad[], pad: Gamepad): Gamepad {
  return pads.find((p) => p.id === pad.id) ?? pad;
}

/** ボタン/軸の物理入力を人間可読なラベルへ。standard mapping なら位置ベースの名前、それ以外はindex表記。 */
export function sourceLabel(source: Source, pad: Gamepad): string {
  if (source.kind === 'button') {
    const positionFn = pad.mapping === 'standard' ? STANDARD_BUTTON_POSITIONS[source.index] : undefined;
    if (positionFn) return t('gamepadPositionalButtonLabel', { index: toDisplayIndex(source.index), position: positionFn() });
    return t('gamepadButtonLabel', { index: toDisplayIndex(source.index) });
  }
  return t('gamepadAxisLabel', { index: toDisplayIndex(source.index), dir: source.dir > 0 ? '+' : '-' });
}

/** Source を安定な文字列キーへ(表示順の比較・行の同一性判定に使う。gamepad.ts内部のsourceKeyとは別実装)。 */
function rowKey(source: Source): string {
  return source.kind === 'button' ? `b${source.index}` : `a${source.index}${source.dir > 0 ? '+' : '-'}`;
}

/** 一覧の表示順(ボタン→軸、それぞれindex/dir順)。Mapの挿入順に依存しない決定的な並びにすることで、
 * キー再割当のたびに削除→追加してもその行が一覧内で移動しない(「次の行へ自動で進む」を成立させるため)。 */
function compareRows(a: { source: Source }, b: { source: Source }): number {
  if (a.source.kind !== b.source.kind) return a.source.kind === 'button' ? -1 : 1;
  if (a.source.kind === 'button' && b.source.kind === 'button') return a.source.index - b.source.index;
  if (a.source.kind === 'axis' && b.source.kind === 'axis') {
    if (a.source.index !== b.source.index) return a.source.index - b.source.index;
    return a.source.dir - b.source.dir;
  }
  return 0;
}

function sortedBindings(pad: Gamepad, callbacks: GamepadDialogCallbacks): Array<{ source: Source; binding: Binding }> {
  return callbacks.getAllBindings(pad).slice().sort(compareRows);
}

/**
 * 検出待ち状態(行の[再検出]・[新規検出]共通)の純粋な状態遷移。DOM操作やGamepad APIの読み取りを
 * 一切持たない、テストしやすい形にするために buildGamepadDialog() 本体から切り出した。
 *
 * kind:'row' は「この行(source+binding)の物理入力を検出し直す」用途(割り当てるキーは変えない)。
 * kind:'generic' は「新しい行を追加するため、まず物理入力を検出する」用途で、検出成功後は
 * 即座には終わらず pendingGeneric(下のキーボードでキーを選ぶ番)へ進む。
 */
export type DetectState =
  | { kind: 'row'; padId: string; source: Source; binding: Binding; baseline: PadSnapshot }
  | { kind: 'generic'; padId: string; baseline: PadSnapshot }
  | null;

export interface DetectFlowState {
  /** 検出(押して割り当て)待ち中の状態。行/新規どちらか一方のみ、同時に両方は待てない。 */
  detect: DetectState;
  /** 新規検出が成功し、割り当てるキー(下のキーボードでの選択)待ちになっている状態。 */
  pendingGeneric: { padId: string; source: Source } | null;
}

export const IDLE_DETECT_FLOW_STATE: DetectFlowState = { detect: null, pendingGeneric: null };

/** 行の[再検出]を開始する。既存のキー選択待ち(新規検出側)は両立させず破棄する。 */
export function startRowDetectFlow(padId: string, source: Source, binding: Binding, baseline: PadSnapshot): DetectFlowState {
  return { detect: { kind: 'row', padId, source, binding, baseline }, pendingGeneric: null };
}

/** [新規検出]を開始する。以前のキー選択待ちは破棄する(新しい検出が優先)。 */
export function startGenericDetectFlow(padId: string, baseline: PadSnapshot): DetectFlowState {
  return { detect: { kind: 'generic', padId, baseline }, pendingGeneric: null };
}

/**
 * 検出待ち中に新規入力(Source)を検出した時の遷移。
 * kind:'row' は呼び出し側が別途 removeBinding+addBinding で物理入力を差し替え、ここでは
 * detect を空に戻すだけ。kind:'generic' は即座に確定させず、キー選択待ち(pendingGeneric)へ
 * 進める。detect が null(検出待ちでない)ときに呼んでも何もしない(型ガード漏れに対する保険)。
 */
export function resolveDetectFound(state: DetectFlowState, source: Source): DetectFlowState {
  if (state.detect === null) return state;
  if (state.detect.kind === 'row') return { detect: null, pendingGeneric: state.pendingGeneric };
  return { detect: null, pendingGeneric: { padId: state.detect.padId, source } };
}

/** 検出待ちを中断して何もせず元に戻す(行/新規共通。[キャンセル]ボタン・Escから呼ぶ)。 */
export function cancelDetectFlow(state: DetectFlowState): DetectFlowState {
  if (state.detect === null) return state;
  return { ...state, detect: null };
}

/** 新規検出成功後のキー選択待ちを中断して破棄する([キャンセル]ボタン・Escから呼ぶ)。 */
export function cancelPendingGenericFlow(state: DetectFlowState): DetectFlowState {
  if (state.pendingGeneric === null) return state;
  return { ...state, pendingGeneric: null };
}

/** キーボードピッカーでキーが選ばれた時の遷移。呼び出し側が別途 addBinding を実行してから呼ぶ。 */
export function resolvePendingGenericPicked(state: DetectFlowState): DetectFlowState {
  return { ...state, pendingGeneric: null };
}

/**
 * ゲームパッド設定ダイアログを構築して container へ追加する。
 * main.ts からはボタン1つ分の配線(open()呼び出しとapplyStrings()連携)だけ行えばよい
 * (filemanager.ts の buildFileManagerDialog と同じ流儀)。
 */
export function buildGamepadDialog(container: HTMLElement, callbacks: GamepadDialogCallbacks): GamepadDialog {
  const titleEl = el('h2', { class: 'gp-title' }, [t('gamepadDialogTitle')]);
  const descEl = el('p', { class: 'gp-desc' }, [t('gamepadDialogDescription')]);
  const listTitleEl = el('h3', { class: 'rom-modal-section-title' }, [t('gamepadConnectedTitle')]);
  const liveContainerEl = el('div', { class: 'gp-live-container' });
  const editorTitleEl = el('h3', { class: 'rom-modal-section-title' }, [t('gamepadBindingsTitle')]);
  const editorPadSelectEl = el('div', { class: 'gp-edit-pad-select' });
  const editorEl = el('div', { class: 'gp-editor' });
  const pickerTitleEl = el('h3', { class: 'rom-modal-section-title gp-picker-title' }, [t('gamepadKeyPickerTitle')]);
  const pickerPanelEl = el('div', { class: 'gp-picker kbd-panel' });
  const closeBtn = el('button', { type: 'button', class: 'rom-close-btn' }, [t('gamepadDialogClose')]);
  const modal = el('div', { class: 'rom-modal gp-modal', role: 'dialog', 'aria-modal': 'true' }, [
    titleEl,
    descEl,
    listTitleEl,
    liveContainerEl,
    editorTitleEl,
    editorPadSelectEl,
    editorEl,
    pickerTitleEl,
    pickerPanelEl,
    el('div', { class: 'rom-modal-footer' }, [closeBtn]),
  ]);
  const backdrop = el('div', { class: 'rom-modal-backdrop gp-modal-backdrop hidden' }, [modal]);
  container.append(backdrop);

  // PC-98キーボードピッカー(player.tsのソフトキーボードと同じ見た目をkbd-layout.tsの
  // buildKbdRows()で共有する。ただしここではキー送信はせず「選択」するだけ)。
  const { rows: pickerRows, buttons: pickerButtons } = buildKbdRows();
  pickerRows.forEach((row) => pickerPanelEl.append(row));

  let rafId: number | null = null;
  // 編集対象パッド(ダイアログ内で選んだ Gamepad.id)。接続が切れたら次のtickで再選出する。
  let editingPadId: string | null = null;
  // 直前に編集エリアを構築したときの接続パッド構成(id列)。変化した時だけ編集エリアを再構築する
  // (ユーザーがselect操作中にDOMを丸ごと差し替えて操作を中断させないため)。
  let lastEditorKey = '';

  // 検出待ちの状態遷移そのものは純粋関数(ファイル冒頭で定義・export済み)に委譲する。
  let detect: DetectState = IDLE_DETECT_FLOW_STATE.detect;
  let pendingGeneric: DetectFlowState['pendingGeneric'] = IDLE_DETECT_FLOW_STATE.pendingGeneric;
  // 上段の一覧で選択中の行(下のキーボードでキーを押すとこの行に割り当たる)。rowKey(source)。
  let selectedRowKey: string | null = null;

  // renderEditor()で作った行ごとのDOM参照。detect中の案内文をフレームごとに書き換えるためだけに使う。
  const rowStatusEls = new Map<string, HTMLElement>();
  let genericStatusEl: HTMLElement | null = null;
  let genericAddBtn: HTMLButtonElement | null = null;
  let pendingPickHintEl: HTMLElement | null = null;

  /** navigator.getGamepads() は疎な配列(切断済みindexがnullのまま残る)なので、非nullだけ拾う。 */
  function connectedPads(): Gamepad[] {
    const all = navigator.getGamepads();
    const out: Gamepad[] = [];
    for (const pad of all) {
      if (pad) out.push(pad);
    }
    return out;
  }

  /** buttons配列の長さ・要素は環境やモックによってまちまちなので、欠けや長さ違いを前提に組み立てる。 */
  function renderButtons(pad: Gamepad): HTMLElement {
    const wrap = el('div', { class: 'gp-btns' });
    const buttons = pad.buttons ?? [];
    for (let i = 0; i < buttons.length; i++) {
      const pressed = buttons[i]?.pressed === true;
      wrap.append(el('span', { class: pressed ? 'gp-btn active' : 'gp-btn' }, [String(toDisplayIndex(i))]));
    }
    return wrap;
  }

  /** axes配列も同様に長さ・値が不定な前提。静止値からの偏差(callbacks.getAxisState)でハイライトする。 */
  function renderAxes(pad: Gamepad): HTMLElement {
    const wrap = el('div', { class: 'gp-axes' });
    const axes = pad.axes ?? [];
    for (let i = 0; i < axes.length; i++) {
      const raw = axes[i];
      const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
      const state = callbacks.getAxisState(pad, i);
      const classes = ['gp-axis'];
      let suffix = '';
      if (!state.valid) {
        classes.push('invalid');
        suffix = ` ${t('gamepadAxisInvalidSuffix')}`;
      } else if (state.calibrating) {
        classes.push('calibrating');
        suffix = ` ${t('gamepadAxisCalibratingSuffix')}`;
      } else if (!state.calibrated) {
        classes.push('uncalibrated');
        suffix = ` ${t('gamepadAxisUncalibratedSuffix')}`;
      } else if (state.active !== null) {
        classes.push('active');
      }
      wrap.append(el('span', { class: classes.join(' ') }, [`A${toDisplayIndex(i)}: ${formatAxisValue(value)}${suffix}`]));
    }
    return wrap;
  }

  /** 現在コアへ送っているPC-98キー(getActiveKeys)をラベル付きで表示する。 */
  function renderActiveKeys(pad: Gamepad): HTMLElement {
    const wrap = el('div', { class: 'gp-keys' });
    let keys: Set<number>;
    try {
      keys = callbacks.getActiveKeys(pad);
    } catch {
      keys = new Set();
    }
    if (keys.size === 0) {
      wrap.append(el('span', { class: 'gp-key-empty' }, ['—']));
      return wrap;
    }
    for (const code of keys) {
      wrap.append(el('span', { class: 'gp-key active' }, [labelForKeyCode(code)]));
    }
    return wrap;
  }

  function renderLive(pads: Gamepad[]): void {
    liveContainerEl.textContent = '';
    if (pads.length === 0) {
      liveContainerEl.append(el('div', { class: 'gp-hint' }, [t('gamepadNoPads')]));
      return;
    }
    for (const pad of pads) {
      const header = el('h4', { class: 'gp-live-title' }, [t('gamepadLiveTitle', { name: pad.id })]);
      const physical = el('div', { class: 'gp-live-col' }, [
        el('div', { class: 'gp-live-col-title' }, [t('gamepadPhysicalTitle')]),
        renderButtons(pad),
        renderAxes(pad),
      ]);
      const keysCol = el('div', { class: 'gp-live-col' }, [
        el('div', { class: 'gp-live-col-title' }, [t('gamepadKeysTitle')]),
        renderActiveKeys(pad),
      ]);
      liveContainerEl.append(
        el('div', { class: 'gp-live-block' }, [header, el('div', { class: 'gp-live-row' }, [physical, keysCol])]),
      );
    }
  }

  /** 編集対象パッドが未接続/未選択なら、接続中パッドの先頭を自動選出する。 */
  function ensureEditingPad(pads: Gamepad[]): Gamepad | null {
    let pad = pads.find((p) => p.id === editingPadId) ?? null;
    if (!pad) {
      pad = pads[0] ?? null;
      editingPadId = pad?.id ?? null;
    }
    return pad;
  }

  function applyFlow(next: DetectFlowState): void {
    detect = next.detect;
    pendingGeneric = next.pendingGeneric;
  }

  function startRowDetect(pad: Gamepad, source: Source, binding: Binding): void {
    const fresh = freshPadFor(connectedPads(), pad);
    applyFlow(startRowDetectFlow(fresh.id, source, binding, snapshotPad(fresh)));
    renderEditor(connectedPads());
  }

  function startGenericDetect(pad: Gamepad): void {
    const fresh = freshPadFor(connectedPads(), pad);
    applyFlow(startGenericDetectFlow(fresh.id, snapshotPad(fresh)));
    renderEditor(connectedPads());
  }

  function cancelDetect(): void {
    if (detect === null) return;
    applyFlow(cancelDetectFlow({ detect, pendingGeneric }));
    renderEditor(connectedPads());
  }

  function cancelPendingGeneric(): void {
    if (pendingGeneric === null) return;
    applyFlow(cancelPendingGenericFlow({ detect, pendingGeneric }));
    renderEditor(connectedPads());
  }

  /** キーボードピッカーの1キー分がクリックされた時。選択中の行があれば再割当、新規検出待ちがあれば追加する。 */
  function onPickerKey(pad: Gamepad, code: number): void {
    if (pendingGeneric && pendingGeneric.padId === pad.id) {
      callbacks.addBinding(pad, pendingGeneric.source, { kind: 'key', code });
      applyFlow(resolvePendingGenericPicked({ detect, pendingGeneric }));
      selectedRowKey = rowKey(pendingGeneric.source);
      renderEditor(connectedPads());
      return;
    }
    if (selectedRowKey === null) return;
    const sorted = sortedBindings(pad, callbacks);
    const idx = sorted.findIndex((e) => rowKey(e.source) === selectedRowKey);
    if (idx < 0) return;
    const entry = sorted[idx];
    callbacks.removeBinding(pad, entry.source, entry.binding);
    callbacks.addBinding(pad, entry.source, { kind: 'key', code });
    const next = sorted[idx + 1];
    selectedRowKey = next ? rowKey(next.source) : null;
    renderEditor(connectedPads());
  }

  /** 割当編集エリア(パッド選択・一覧・デッドゾーン・プリセット)を丸ごと再構築する。 */
  function renderEditor(pads: Gamepad[]): void {
    rowStatusEls.clear();
    genericStatusEl = null;
    genericAddBtn = null;
    pendingPickHintEl = null;

    editorPadSelectEl.textContent = '';
    editorEl.textContent = '';

    if (pads.length === 0) {
      editorEl.append(el('div', { class: 'gp-hint' }, [t('gamepadNoPads')]));
      pickerPanelEl.classList.add('gp-picker-inactive');
      return;
    }
    const pad = ensureEditingPad(pads);
    if (!pad) return;

    // 編集対象パッド選択。
    const padSelectLabel = el('label', { class: 'gp-edit-pad-row' }, [t('gamepadEditingPadLabel')]);
    const padSelect = el('select', { class: 'gp-edit-pad-input' });
    for (const p of pads) padSelect.append(new Option(`${p.id} (#${toDisplayIndex(p.index)})`, p.id));
    padSelect.value = pad.id;
    padSelect.addEventListener('change', () => {
      editingPadId = padSelect.value;
      selectedRowKey = null;
      applyFlow(IDLE_DETECT_FLOW_STATE);
      renderEditor(connectedPads());
    });
    padSelectLabel.append(padSelect);
    editorPadSelectEl.append(padSelectLabel);

    // デッドゾーン。
    const deadzone = callbacks.getDeadzone(pad);
    const deadzoneRow = el('div', { class: 'gp-deadzone-row' });
    const deadzoneLabel = el('span', { class: 'gp-deadzone-label' }, [t('gamepadDeadzoneLabel')]);
    const deadzoneInput = el('input', {
      type: 'range',
      min: '0.1',
      max: '0.9',
      step: '0.05',
      value: String(deadzone),
      class: 'gp-deadzone-input',
    }) as HTMLInputElement;
    const deadzoneValue = el('span', { class: 'gp-deadzone-value' }, [deadzone.toFixed(2)]);
    deadzoneInput.addEventListener('input', () => {
      const value = Number(deadzoneInput.value);
      callbacks.setDeadzone(pad, value);
      deadzoneValue.textContent = value.toFixed(2);
    });
    deadzoneRow.append(deadzoneLabel, deadzoneInput, deadzoneValue);

    // プリセット適用(カーソルキー+Z/X / テンキー+SPACE)。
    const presetCursorBtn = el('button', { type: 'button', class: 'gp-preset-btn', title: t('gamepadPresetCursorZxBtnTitle') }, [
      t('gamepadPresetCursorZxBtn'),
    ]);
    presetCursorBtn.addEventListener('click', () => {
      callbacks.resetToPreset(pad, CURSOR_ZX_PRESET);
      selectedRowKey = null;
      applyFlow(cancelDetectFlow({ detect, pendingGeneric }));
      renderEditor(connectedPads());
    });
    const presetTenkeyBtn = el(
      'button',
      { type: 'button', class: 'gp-preset-btn', title: t('gamepadPresetTenkeySpaceBtnTitle') },
      [t('gamepadPresetTenkeySpaceBtn')],
    );
    presetTenkeyBtn.addEventListener('click', () => {
      callbacks.resetToPreset(pad, TENKEY_SPACE_PRESET);
      selectedRowKey = null;
      applyFlow(cancelDetectFlow({ detect, pendingGeneric }));
      renderEditor(connectedPads());
    });
    editorEl.append(deadzoneRow, el('div', { class: 'gp-preset-row' }, [presetCursorBtn, presetTenkeyBtn]));

    // 割当済み一覧(上段)。
    const table = el('div', { class: 'gp-bind-table' });
    const sorted = sortedBindings(pad, callbacks);
    if (sorted.length === 0) {
      table.append(el('div', { class: 'gp-hint' }, [t('gamepadBindingsEmpty')]));
    }
    for (const entry of sorted) table.append(renderBindingRow(pad, entry.source, entry.binding));
    editorEl.append(table);

    // 新規検出(新しい物理入力を検出して行を追加)。
    const addStatusEl = el('span', { class: 'gp-detect-status' });
    genericStatusEl = addStatusEl;
    const isGenericActive = detect !== null && detect.kind === 'generic';
    const addBtn = el(
      'button',
      { type: 'button', class: 'gp-detect-btn', title: isGenericActive ? t('gamepadCancelBtnTitle') : t('gamepadAddBtnTitle') },
      [isGenericActive ? t('gamepadCancelBtn') : t('gamepadAddBtn')],
    );
    const isPending = pendingGeneric !== null && pendingGeneric.padId === pad.id;
    addBtn.disabled = isPending;
    addBtn.addEventListener('click', () => {
      if (detect !== null && detect.kind === 'generic') cancelDetect();
      else startGenericDetect(pad);
    });
    genericAddBtn = addBtn;
    editorEl.append(el('div', { class: 'gp-generic-row' }, [addBtn, addStatusEl]));

    if (isPending) {
      pendingPickHintEl = el('div', { class: 'gp-pending-hint' }, [t('gamepadPendingPickKey')]);
      const cancelPendingBtn = el('button', { type: 'button', class: 'gp-detect-btn', title: t('gamepadCancelBtnTitle') }, [
        t('gamepadCancelBtn'),
      ]);
      cancelPendingBtn.addEventListener('click', () => cancelPendingGeneric());
      editorEl.append(pendingPickHintEl, cancelPendingBtn);
    } else if (selectedRowKey !== null) {
      editorEl.append(el('div', { class: 'gp-pending-hint' }, [t('gamepadRowSelectedHint')]));
    }

    // キーボードピッカーは「行選択中」または「新規検出のキー選択待ち」の間だけ活性化する。
    const pickerActive = selectedRowKey !== null || isPending;
    pickerPanelEl.classList.toggle('gp-picker-inactive', !pickerActive);
  }

  function renderBindingRow(pad: Gamepad, source: Source, binding: Binding): HTMLElement {
    const key = rowKey(source);
    const isSelected = selectedRowKey === key;
    const row = el('div', { class: isSelected ? 'gp-bind-row selected' : 'gp-bind-row' });

    const mainArea = el('div', { class: 'gp-bind-row-main' }, [
      el('span', { class: 'gp-bind-source' }, [sourceLabel(source, pad)]),
      el('span', { class: 'gp-bind-arrow' }, ['→']),
      el('span', { class: 'gp-bind-key' }, [labelForKeyCode(binding.code)]),
    ]);
    mainArea.addEventListener('click', () => {
      selectedRowKey = selectedRowKey === key ? null : key;
      applyFlow(cancelPendingGenericFlow({ detect, pendingGeneric }));
      renderEditor(connectedPads());
    });
    row.append(mainArea);

    const statusEl = el('span', { class: 'gp-detect-status' });
    rowStatusEls.set(key, statusEl);

    const isActive = detect !== null && detect.kind === 'row' && rowKey(detect.source) === key;
    const redetectBtn = el(
      'button',
      { type: 'button', class: 'gp-detect-btn', title: isActive ? t('gamepadCancelBtnTitle') : t('gamepadRedetectBtnTitle') },
      [isActive ? t('gamepadCancelBtn') : t('gamepadRedetectBtn')],
    );
    redetectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (detect !== null && detect.kind === 'row' && rowKey(detect.source) === key) cancelDetect();
      else startRowDetect(pad, source, binding);
    });

    const clearBtn = el('button', { type: 'button', class: 'gp-clear-btn', title: t('gamepadClearBtnTitle') }, [
      t('gamepadClearBtn'),
    ]);
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.removeBinding(pad, source, binding);
      if (selectedRowKey === key) selectedRowKey = null;
      renderEditor(connectedPads());
    });

    row.append(redetectBtn, clearBtn, statusEl);
    return row;
  }

  /** 検出モードの押下判定(毎フレーム)。DOM再構築はせず、案内テキストと他ボタンのdisabledだけその場で更新する。 */
  function tickDetect(pads: Gamepad[]): void {
    for (const [key, statusEl] of rowStatusEls) {
      const active = detect !== null && detect.kind === 'row' && rowKey(detect.source) === key;
      statusEl.textContent = active ? t('gamepadDetectWaiting') : '';
    }
    if (genericStatusEl) {
      const active = detect !== null && detect.kind === 'generic';
      genericStatusEl.textContent = active ? t('gamepadDetectWaiting') : '';
    }
    if (genericAddBtn) {
      genericAddBtn.disabled = (detect !== null && detect.kind !== 'generic') || pendingGeneric !== null;
    }

    if (detect === null) return;
    const pad = pads.find((p) => p.id === detect!.padId);
    if (!pad) return; // 検出中に抜かれた場合はそのまま待機(戻ってくれば再開できる)。
    const curr = snapshotPad(pad);
    const deadzone = callbacks.getDeadzone(pad);
    const found = detectNewlyActiveSource(detect.baseline, curr, deadzone, (axisIndex) => callbacks.getAxisState(pad, axisIndex).calibrated);
    if (found) {
      if (detect.kind === 'row') {
        callbacks.removeBinding(pad, detect.source, detect.binding);
        callbacks.addBinding(pad, found, detect.binding);
        selectedRowKey = rowKey(found);
      }
      applyFlow(resolveDetectFound({ detect, pendingGeneric }, found));
      renderEditor(pads);
      return;
    }
    // ローリング基準: 押しっぱなしのボタンを誤検出しないため、
    // 「直前フレームで既に押されていたか」を毎フレーム更新しながら「新規の押下」だけを拾う。
    detect = { ...detect, baseline: curr };
  }

  function render(): void {
    const pads = connectedPads();
    renderLive(pads);
    tickDetect(pads);
    const key = pads.map((p) => p.id).join(',');
    if (key !== lastEditorKey) {
      lastEditorKey = key;
      renderEditor(pads);
    }
  }

  function tick(): void {
    render();
    rafId = requestAnimationFrame(tick);
  }

  function close(): void {
    backdrop.classList.add('hidden');
    applyFlow(IDLE_DETECT_FLOW_STATE);
    selectedRowKey = null;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  // キーボードピッカー配線: 送信はせず、選択中の行/新規検出待ちのSourceへコードを割り当てるだけ。
  for (const { def, button } of pickerButtons) {
    button.addEventListener('click', () => {
      const pad = connectedPads().find((p) => p.id === editingPadId);
      if (!pad) return;
      onPickerKey(pad, def.code);
    });
  }

  closeBtn.addEventListener('click', () => close());
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || backdrop.classList.contains('hidden')) return;
    if (detect !== null) {
      cancelDetect();
      return;
    }
    if (pendingGeneric !== null) {
      cancelPendingGeneric();
      return;
    }
    close();
  });

  function open(): void {
    backdrop.classList.remove('hidden');
    lastEditorKey = '__force__'; // 開くたびにパッド選択・編集表を作り直す。
    render();
    if (rafId === null) rafId = requestAnimationFrame(tick);
  }

  return {
    open,
    applyStrings(): void {
      titleEl.textContent = t('gamepadDialogTitle');
      descEl.textContent = t('gamepadDialogDescription');
      listTitleEl.textContent = t('gamepadConnectedTitle');
      editorTitleEl.textContent = t('gamepadBindingsTitle');
      pickerTitleEl.textContent = t('gamepadKeyPickerTitle');
      closeBtn.textContent = t('gamepadDialogClose');
      if (!backdrop.classList.contains('hidden')) {
        lastEditorKey = '__force__';
        render();
      }
    },
  };
}
