/**
 * ゲームパッド(Gamepad API)入力を PC-98キーボードのキー入力へ変換する。
 *
 * WebX68k(px68k-libretro向け)の gamepad.ts を移植したもの。WebX68k はジョイスティック端子
 * (RetroPad ID ビットマスク)へ変換していたが、WebNP2 はジョイスティック端子を実装しない方針の
 * ため、割当先はすべて PC-98 キーボードのキー(スキャンコード)にする。1P/2P のような「どのポート
 * へ送るか」の区別も無く、接続中の全パッドを同時に有効化してキー入力へ落とし込む(ポート概念・
 * assignPorts() は移植しない)。
 *
 * マッピングをデータ(Source -> Binding の対応表)として表現しておく設計はそのまま踏襲し、
 * 編集UI・永続化(localStorage 保存等)もそのまま使える形にしてある。
 */

/**
 * 1つの物理入力(Source)に対する割当先。WebX68k版は kind:'joy'(RetroPad側)/kind:'key'
 * (直接キー)の2種類があったが、WebNP2 はジョイスティック端子を持たないため kind:'key' 相当
 * 一本化する。`kind` フィールド自体は、Source 型との対称性(どちらも判別可能なタグ付き型)を
 * 保つため、また将来 kind:'key' 以外の割当先(例: マクロ)を足す余地を残すために残してある。
 */
export type Binding = { kind: 'key'; code: number };

/** 物理入力側。軸はデッドゾーンを超えた方向(dir)ごとに別の Source として扱う。 */
export type Source = { kind: 'button'; index: number } | { kind: 'axis'; index: number; dir: 1 | -1 };

function sourceKey(source: Source): string {
  return source.kind === 'button' ? `b${source.index}` : `a${source.index}${source.dir > 0 ? '+' : '-'}`;
}

/** 軸の既定デッドゾーン。この値を超えた(等しいだけでは超えない)ときにその方向を「入力あり」とみなす。 */
export const DEFAULT_DEADZONE = 0.5;

// --- 軸判定(静止値からの偏差・範囲外軸の除外・較正) ---
//
// 実機(8BitDo M30/Micro、D-inputモード)で判明した事実(WebX68k側で2026-08-08に確定、パッド自体の
// 挙動なので機種に依存しない):
// - 十字キーは axes[0]/axes[1] の軸で来る(ボタンではない)。
// - axes[3]/axes[4](アナログトリガ)は、そのパッドを観測開始してから一度もそのトリガを
//   動かしていない間は 0.0 を報告し続け、一度でも動かす(押す/離す)と、以後は真の静止値
//   -1.0 を報告するようになる。「軸の値には最初から意味がある」という前提そのものが誤りで、
//   「一度も動いていない軸の値は無意味(0.0 は偽の静止値)」というのが実機の挙動。
// - axes[9] は常に [-1,1] の範囲外の値(M30=3.29 / Micro=1.29)を返す。十字キーのハット軸が
//   数値化されたものと見られ、実質「無効な軸」として扱うしかない。
//
// --- これまでの4回の誤った修正(同じ失敗を繰り返さないための記録。WebX68k側での経緯) ---
// 1回目: 初回観測値をそのまま静止値として固定する設計。押す前は0を返すため rest=0 と
//   記録してしまい、一度押した後の真の値(-1.0)との偏差が常にデッドゾーンを超え、ON固着した。
// 2回目: 既知パッド(M30/Micro)の axes[3]/[4] は実機の値(-1.0)を静止値として固定する設計
//   (knownAxisRestFor、削除済み)。押す前から rest=-1.0 なのに実際の値は0のため、今度は
//   押す前から偏差が生じてON固着した(症状が前倒しになっただけで解決していなかった)。
// 3回目: 「一度変化してから数フレーム(AXIS_CALIBRATION_STABLE_FRAMES=2)同じ値が続いたら
//   静止値として確定する」安定検出方式(advanceAxisCalibration の旧実装、削除済み)。
//   これは「安定して見えるか」だけを見ており、実機で L を押せば2フレーム(約33ms)など
//   一瞬で超えてしまうため、押している間の値(+1.0)がそのまま静止値として誤確定し、
//   離した後の真の値(-1.0)との偏差でON固着した。「一定フレーム変化しない」を安定の
//   証拠にする限り、押しっぱなしと本当の静止は区別できない。
// 4回目: 「一度動かされてから固定長のウィンドウ(AXIS_CALIBRATION_WINDOW_FRAMES=240フレーム
//   ≒4秒)ぶん、量子化した値ごとの滞在フレーム数(dwell)を数え、期間終了時点で最も長く滞在
//   した値を採用する」dwellベースの多数決方式(advanceAxisCalibration の旧実装、削除済み)。
//   離した後の滞在時間が押している時間より長いことを期待する設計だが、ウィンドウは「軸が
//   最初に動いた瞬間」から機械的に締め切られるため、押している時間がウィンドウの半分
//   (120フレーム)を超えると多数決が押下値側に傾き、離した後もそのまま誤確定する。
//   押している時間の長さを問わず「今まだ動いている最中かもしれない値」を確定候補にしてしまう点は
//   3回目と同根で、単に閾値を伸ばしただけだった。
//
// 結論(今回の設計・「離れてから確定」方式): 較正ウィンドウという「締め切り」自体を廃止する。
// 軸ごとに「較正済みか」の状態を持ち、未較正の間は判定に使わない(入力を一切生成しない、
// ここは従来どおり)。観測開始時の値を baseline として記録し、それと異なる値(量子化ビン)を
// 一度でも観測したら(=一度動かされたら)、そこから「区間(segment)」の追跡を始める:
// 値が量子化ビンで変わるたびに新しい区間として数え直し、区間番号(segments、baseline を
// 離れて最初にいる区間が1)と、その区間に連続して滞在しているフレーム数(segmentFrames)を
// 持つ。
// 「baseline を離れて最初の区間(segments===1)」は、それが押している最中の値である可能性を
// 排除できないため、どれだけ長く滞在してもそれだけでは確定しない(=旧実装のように締め切りで
// 機械的に確定することがない。これが4回目の失敗の直接の解決)。
// 2番目以降の区間(segments>=2、= 一度違う値へ移ってから今の値に来た区間)に
// AXIS_CALIBRATION_SETTLE_FRAMES フレーム連続で滞在したら、そこで初めて静止値として確定する。
// 「最初の押下(区間1)を離れて、別の値(区間2以降)に落ち着いた」ことを条件にすることで、
// 「一度離れてから戻ってきて落ち着いた値」だけを確定候補にする(要求仕様の不変条件)。
// 押しっぱなしがどれだけ長時間(区間1のまま)続いても確定せず、離す(区間が切り替わる)まで
// 待つ。較正完了後は静止値を二度と更新しない(押しっぱなしの間に静止値が追いついてOFFに戻って
// しまう問題を避けるため。この方針自体は旧実装から踏襲)。
// baseline のまま一度も動いていない軸は hasMoved が立たず区間の追跡自体を始めないため、
// 較正されない(初期状態から動かない軸が勝手に較正されて誤ったrest(baselineそのもの)を
// 採用してしまう事故を防ぐ)。
//
// --- 副作用の手当て: 較正完了までUP/DOWN/LEFT/RIGHT等の入力が一切効かなくなる問題 ---
// 上記の設計は「較正が終わるまで入力を一切生成しない」ことを前提にしていたが、
// 8BitDo M30 のように十字キーそのものが軸(axes[0]/[1])で来るパッドでは、十字キーを初めて
// 倒した瞬間から較正が始まり、区間2以降が確定するまでの間、方向入力が一切効かなくなって
// しまう(ゲーム中は致命的)。
// これを避けるため、GamepadManager.forEachActiveSource() は「その軸に割当があるかどうか」で
// 較正中の扱いを分ける: 割当のある軸は較正中でも baseline(観測開始時点=まだ動いていない
// 時点の値)を暫定の静止値として使い、較正完了を待たずに入力を生成する。通常のスティック/
// 十字キーは静止値が最初から0付近で正しいため、これで即座に正しく動く。割当の無い軸
// (未割当のトリガ軸等)は従来どおり較正完了まで入力を生成しない。較正が完了したら(その軸の
// calibrated:trueへの遷移)暫定値(baseline)から確定値(rest)へ切り替わるが、通常は区間2
// (=一度動いてから戻った先)が baseline と同じ値になるケースが大半であるため rest は baseline
// と一致し、押しっぱなしの入力が切り替え境界で途切れたり固着したりしない。
//
// 以下は純粋関数として切り出し、GamepadManager(継続的なビット計算)・gamepad-ui.ts
// (ライブ表示・検出モード、後続タスクで移植)の両方から同じ判定ロジックを共有する。

/**
 * 軸の値が有効(Gamepad API の仕様上ありうる [-1, 1] の範囲内の有限値)かどうか。
 * 範囲外はハット軸などが数値化されて紛れ込んだものとみなし、無効な軸として扱う
 * (bitsFor/ライブ表示/検出モード/割当選択肢のいずれからも除外する)。
 */
export function isAxisValueValid(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -1 && value <= 1;
}

/**
 * 軸の現在値(value)が静止値(rest)からデッドゾーンを超えて偏差しているか、その方向を返す純粋関数。
 * value/rest のいずれかが無効な軸の値(isAxisValueValid が false)なら常に null(無効な軸として扱う)。
 * 静止値そのものからの偏差で見るため、rest が 0 でない軸(例: 未押下トリガの -1.0)でも
 * 「動いていなければ null」になる。
 */
export function axisDeviationDir(value: number, rest: number, deadzone: number): 1 | -1 | null {
  if (!isAxisValueValid(value) || !isAxisValueValid(rest)) return null;
  const delta = value - rest;
  if (delta <= -deadzone) return -1;
  if (delta >= deadzone) return 1;
  return null;
}

/**
 * 区間(segment)を数える際の量子化幅。
 * 浮動小数点の微小なブレ(実測: 通常スティックの静止値は厳密な0ではなく -0.00392 等)を
 * そのままキーにすると、本来同じ「静止している」フレーム同士が別の区間として扱われてしまい、
 * 滞在が分散して正しい静止値を選べなくなる。0.05刻みに丸めてビン分けすることでこれを防ぐ
 * (実機の主要な静止値/フルスケール値である 0 / ±1.0 はこの粒度でも丸め誤差なく厳密に載る)。
 */
export const AXIS_CALIBRATION_QUANTUM = 0.05;

/**
 * 「離れてから確定」方式で、ある値(区間)に静止値として確定するために必要な連続滞在フレーム数。
 * ポーリングはエミュレートフレームごとに呼ばれる想定で、60fps換算で1.5秒ぶんの目安として
 * 60fps×1.5秒=90に設定(要求仕様の「目安1〜2秒」の中央値)。
 *
 * この定数が使われるのは baseline を離れて2番目以降の区間(segments>=2)だけである点が重要:
 * 最初の区間(baseline を離れて最初にいる値、segments===1)は、この定数の値に関わらず
 * どれだけ長く滞在しても確定しない(旧dwell実装が「押しっぱなしが長くても、離した後の滞在が
 * それを上回れば正しく較正できる」という前提のまま、長押し(数秒〜10秒)がウィンドウの過半を
 * 占めると誤確定していた反省から、「今まだ動いている最中かもしれない値」を確定候補にすること
 * 自体をやめた)。そのため、この値は「一度動いてから、別の値に落ち着くまで待つ時間」の
 * 短さ(体感の較正完了までの遅延)だけを左右し、長押しへの耐性には影響しない
 * (advanceAxisCalibration のコメント参照)。
 */
export const AXIS_CALIBRATION_SETTLE_FRAMES = 90;

/** value を AXIS_CALIBRATION_QUANTUM 刻みのビンへ丸める(区間判定のキー用)。-0 は 0 に正規化する。 */
function quantizeAxisValue(value: number): number {
  const q = Math.round(value / AXIS_CALIBRATION_QUANTUM) * AXIS_CALIBRATION_QUANTUM;
  return q === 0 ? 0 : q;
}

/**
 * 軸1本ぶんの較正状態。
 * - calibrated:false … まだ静止値が確定していない(入力判定には使わない)。baseline は
 *   観測開始時点(その軸を最初に見た瞬間)の値。hasMoved は baseline から一度でも変化した
 *   ことがあるか(false の間は区間の追跡を始めていない=較正未着手)。hasMoved:true の間は
 *   segmentValue(現在の区間の量子化値)・segmentFrames(その区間に連続して滞在している
 *   フレーム数)・segments(baseline を離れてから何番目の区間か、最初の区間が1)を持つ。
 * - calibrated:true … 静止値(rest)が確定済み。以後 advanceAxisCalibration() は状態を
 *   変えずにそのまま返す(二度と rest を更新しない)。
 */
export type AxisCalibration =
  | {
      calibrated: false;
      baseline: number;
      hasMoved: boolean;
      segmentValue: number;
      segmentFrames: number;
      segments: number;
    }
  | { calibrated: true; rest: number };

/** その軸を初めて観測した時点の較正状態を作る(baseline=今の値、まだ未較正・区間の追跡もまだ開始しない)。 */
export function initAxisCalibration(value: number): AxisCalibration {
  return { calibrated: false, baseline: value, hasMoved: false, segmentValue: quantizeAxisValue(value), segmentFrames: 0, segments: 0 };
}

/**
 * 軸較正状態を1フレームぶん進める純粋関数。GamepadManager(継続的な観測)と
 * gamepad-ui.ts(較正中の表示、後続タスクで移植)の両方から同じロジックを共有するために切り出す。
 * 較正済み(calibrated:true)であれば何も変えずそのまま返す(rest固定)。
 *
 * 未較正の場合:
 * - まだ一度も動いていない(hasMoved:false)間、value(を量子化した値)が baseline のままなら
 *   何もせず返す(baseline に居続ける時間は較正に使わない。実機トリガは押す前ずっと 0.0 を
 *   返すため、ここで区間として数え始めると 0.0 がそのまま静止値として確定してしまう)。
 * - baseline から初めて変化した瞬間(hasMoved が false→true になる瞬間)、その値を区間1として
 *   追跡を始める(segments=1, segmentFrames=1)。
 * - 既に動いたことがある間、値(の量子化ビン)が今の区間と同じなら segmentFrames を1増やす。
 *   違う値になったら区間が切り替わったとみなし、新しい区間として segmentFrames=1 から数え直し、
 *   segments を1増やす。
 * - 区間1(segments===1、baseline を離れて最初にいる値)は、それが「まだ押している最中の値」
 *   である可能性を否定できないため、segmentFrames がいくつであっても確定しない。これが今回の
 *   設計の要(4回目の失敗=固定ウィンドウの締め切りが押している最中に来ると誤確定する、への
 *   直接の解決)。
 * - 区間2以降(segments>=2、= 一度違う値に移ってから今の値に落ち着いた区間)は、
 *   AXIS_CALIBRATION_SETTLE_FRAMES フレーム連続で滞在した時点で、その値を静止値として採用し
 *   較正完了とする(「一度離れてから戻ってきて落ち着いた値」だけを確定候補にする、という
 *   要求仕様の不変条件そのもの)。
 */
export function advanceAxisCalibration(state: AxisCalibration, value: number): AxisCalibration {
  if (state.calibrated) return state;
  const bin = quantizeAxisValue(value);
  if (!state.hasMoved) {
    if (bin === quantizeAxisValue(state.baseline)) return state; // baselineのまま: まだ区間を始めない。
    return { calibrated: false, baseline: state.baseline, hasMoved: true, segmentValue: bin, segmentFrames: 1, segments: 1 };
  }
  if (bin === state.segmentValue) {
    const segmentFrames = state.segmentFrames + 1;
    if (state.segments >= 2 && segmentFrames >= AXIS_CALIBRATION_SETTLE_FRAMES) {
      return { calibrated: true, rest: state.segmentValue };
    }
    return { calibrated: false, baseline: state.baseline, hasMoved: true, segmentValue: state.segmentValue, segmentFrames, segments: state.segments };
  }
  // 値が変わった: 新しい区間の1フレーム目として数え直す(区間1自体はここでは確定しえない。
  // AXIS_CALIBRATION_SETTLE_FRAMES が2以上である限り、直後にこの分岐へ来ても即確定しない)。
  return { calibrated: false, baseline: state.baseline, hasMoved: true, segmentValue: bin, segmentFrames: 1, segments: state.segments + 1 };
}

// --- 永続化(パッドごとのプロファイル) ---

/** 1つの Gamepad.id ぶんの設定。deadzone とバインディングの実体(配列表現)。 */
export interface GamepadProfile {
  deadzone: number;
  bindings: ReadonlyArray<{ source: Source; binding: Binding }>;
}

/**
 * localStorage に保存する形。WebX68k版はポート固定(portPads)・パッド種別(joyType)を
 * 持っていたが、WebNP2 はポート概念自体が無い(接続中の全パッドを同時にキー入力へ変換する)ため
 * どちらも持たない。過去データ(WebX68k側のv1/v2形式)は互換の対象外(localStorageキー自体が
 * webnp2.gamepad で別物のため、既存ユーザーのデータは存在しない)。そのためマイグレーションは
 * 実装せず、素直に v1 として定義する。
 */
export interface GamepadStore {
  version: 1;
  /** Gamepad.id -> プロファイル。挿し替えても両方残るよう、キーはポート番号ではなくidにする。 */
  pads: Record<string, GamepadProfile>;
}

const GAMEPAD_STORAGE_KEY = 'webnp2.gamepad';

function emptyStore(): GamepadStore {
  return { version: 1, pads: {} };
}

function isSource(v: unknown): v is Source {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.kind === 'button') return typeof o.index === 'number';
  if (o.kind === 'axis') return typeof o.index === 'number' && (o.dir === 1 || o.dir === -1);
  return false;
}

function isBinding(v: unknown): v is Binding {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.kind === 'key') return typeof o.code === 'number';
  return false;
}

function isGamepadProfile(v: unknown): v is GamepadProfile {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.deadzone !== 'number' || !Number.isFinite(o.deadzone)) return false;
  if (!Array.isArray(o.bindings)) return false;
  return o.bindings.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      isSource((entry as Record<string, unknown>).source) &&
      isBinding((entry as Record<string, unknown>).binding),
  );
}

function isPadsRecord(v: unknown): v is Record<string, GamepadProfile> {
  if (typeof v !== 'object' || v === null) return false;
  return Object.values(v as Record<string, unknown>).every(isGamepadProfile);
}

/** 保存データの構造検証。1箇所でも型が崩れていれば false を返す。 */
function isGamepadStore(v: unknown): v is GamepadStore {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.version !== 1) return false;
  return isPadsRecord(o.pads);
}

/**
 * localStorage から読み込む。存在しない/JSON破損/構造不正のいずれでも例外を投げず既定値
 * (空ストア)へフォールバックする。
 */
export function loadGamepadStore(storage: Pick<Storage, 'getItem'> = localStorage): GamepadStore {
  const raw = storage.getItem(GAMEPAD_STORAGE_KEY);
  if (!raw) return emptyStore();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isGamepadStore(parsed)) return parsed;
    return emptyStore();
  } catch {
    return emptyStore();
  }
}

export function saveGamepadStore(store: GamepadStore, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(GAMEPAD_STORAGE_KEY, JSON.stringify(store));
}

// --- 既定プリセット(PC-98キーボードへの割当) ---
//
// PC-98スキャンコードの値は keymap.ts の NAMED_KEYS を参照する(ESC=0x00, SPACE=0x34,
// UP=0x3a, LEFT=0x3b, RIGHT=0x3c, DOWN=0x3d, ENTER=0x1c 等)。z/x は NAMED_KEYS に無い
// (英字キーは ASCII 経由の PLAIN_MAP 側にあり、非公開)ため、player.ts の KBD_ROWS
// (Z=0x29, X=0x2a)と同じ値をここでも直接定数化する。
import { NAMED_KEYS } from './keymap.ts';

const KEY_Z = 0x29;
const KEY_X = 0x2a;

/** 十字キー/左スティックをカーソルキー(UP/DOWN/LEFT/RIGHT)へ割り当てる、両プリセット共通の部分。 */
const DPAD_CURSOR_BINDINGS: ReadonlyArray<{ source: Source; binding: Binding }> = [
  { source: { kind: 'axis', index: 0, dir: -1 }, binding: { kind: 'key', code: NAMED_KEYS.LEFT } },
  { source: { kind: 'axis', index: 0, dir: 1 }, binding: { kind: 'key', code: NAMED_KEYS.RIGHT } },
  { source: { kind: 'axis', index: 1, dir: -1 }, binding: { kind: 'key', code: NAMED_KEYS.UP } },
  { source: { kind: 'axis', index: 1, dir: 1 }, binding: { kind: 'key', code: NAMED_KEYS.DOWN } },
];

/**
 * Gamepad API の standard mapping を前提にした既定割当。標準的な XInput 配置を想定し、
 * 方向は D-Pad(buttons[12..15])と左スティック(axes[0]/[1])の両方をカーソルキーへ、
 * A相当(buttons[0])->z、B相当(buttons[1])->x、Start(buttons[9])->ENTER、
 * Select/Back(buttons[8])->ESC を割り当てる(w3c standard gamepad のボタン配置に準拠、
 * https://www.w3.org/TR/gamepad/#remapping)。
 */
export const CURSOR_ZX_PRESET: ReadonlyArray<{ source: Source; binding: Binding }> = [
  { source: { kind: 'button', index: 0 }, binding: { kind: 'key', code: KEY_Z } },
  { source: { kind: 'button', index: 1 }, binding: { kind: 'key', code: KEY_X } },
  { source: { kind: 'button', index: 8 }, binding: { kind: 'key', code: NAMED_KEYS.ESC } },
  { source: { kind: 'button', index: 9 }, binding: { kind: 'key', code: NAMED_KEYS.ENTER } },
  { source: { kind: 'button', index: 12 }, binding: { kind: 'key', code: NAMED_KEYS.UP } },
  { source: { kind: 'button', index: 13 }, binding: { kind: 'key', code: NAMED_KEYS.DOWN } },
  { source: { kind: 'button', index: 14 }, binding: { kind: 'key', code: NAMED_KEYS.LEFT } },
  { source: { kind: 'button', index: 15 }, binding: { kind: 'key', code: NAMED_KEYS.RIGHT } },
  ...DPAD_CURSOR_BINDINGS,
];

/** 十字キー/左スティックをテンキーの方向(KP8/KP2/KP4/KP6)へ割り当てる、CURSOR_ZX_PRESETの
 * DPAD_CURSOR_BINDINGSに相当するテンキー版。 */
const DPAD_TENKEY_BINDINGS: ReadonlyArray<{ source: Source; binding: Binding }> = [
  { source: { kind: 'axis', index: 0, dir: -1 }, binding: { kind: 'key', code: NAMED_KEYS.KP4 } },
  { source: { kind: 'axis', index: 0, dir: 1 }, binding: { kind: 'key', code: NAMED_KEYS.KP6 } },
  { source: { kind: 'axis', index: 1, dir: -1 }, binding: { kind: 'key', code: NAMED_KEYS.KP8 } },
  { source: { kind: 'axis', index: 1, dir: 1 }, binding: { kind: 'key', code: NAMED_KEYS.KP2 } },
];

/**
 * テンキー(数字パッド)版の既定割当。CURSOR_ZX_PRESETと同じ source 構成(D-Pad(buttons[12..15])
 * + 左スティック(axes[0]/[1])の両方を方向へ、A/B/Start/Select相当をアクションキーへ)だが、
 * 方向の割当先をテンキー(KP8/KP2/KP4/KP6)にし、A相当(buttons[0])->SPACE、B相当(buttons[1])
 * ->ENTER、Start(buttons[9])->ENTER、Select/Back(buttons[8])->ESCにする。
 */
export const TENKEY_SPACE_PRESET: ReadonlyArray<{ source: Source; binding: Binding }> = [
  { source: { kind: 'button', index: 0 }, binding: { kind: 'key', code: NAMED_KEYS.SPACE } },
  { source: { kind: 'button', index: 1 }, binding: { kind: 'key', code: NAMED_KEYS.ENTER } },
  { source: { kind: 'button', index: 8 }, binding: { kind: 'key', code: NAMED_KEYS.ESC } },
  { source: { kind: 'button', index: 9 }, binding: { kind: 'key', code: NAMED_KEYS.ENTER } },
  { source: { kind: 'button', index: 12 }, binding: { kind: 'key', code: NAMED_KEYS.KP8 } },
  { source: { kind: 'button', index: 13 }, binding: { kind: 'key', code: NAMED_KEYS.KP2 } },
  { source: { kind: 'button', index: 14 }, binding: { kind: 'key', code: NAMED_KEYS.KP4 } },
  { source: { kind: 'button', index: 15 }, binding: { kind: 'key', code: NAMED_KEYS.KP6 } },
  ...DPAD_TENKEY_BINDINGS,
];

/** CURSOR_ZX_PRESET を GamepadProfile の形に変換する(standard mapping の既定値用)。 */
export function presetProfile(deadzone: number = DEFAULT_DEADZONE): GamepadProfile {
  return { deadzone, bindings: CURSOR_ZX_PRESET.map((e) => ({ source: e.source, binding: e.binding })) };
}

/** バインディングの無いプロファイル(non-standard パッドの初回既定=全未割当)。 */
export function blankProfile(deadzone: number = DEFAULT_DEADZONE): GamepadProfile {
  return { deadzone, bindings: [] };
}

// --- 8BitDo M30 / Micro 用の既知プリセット ---
//
// 実機(D-inputモード)で判明したボタン/軸の対応(内部index、0始まり)。表示は1始まりだが、
// ここでの値は内部indexそのもの。gamepad.id に 'M30'/'Micro' を含むかどうか(大文字小文字無視)で
// 判定する。standard 申告でない可能性が高いパッドのため、mapping==='standard' かどうかに関わらず
// このプリセットを優先して適用する(knownPadPresetFor が null を返す場合だけ、従来の
// mapping==='standard' ? CURSOR_ZX_PRESET : 全未割当、へフォールバックする)。
//
// WebX68k版はパッド種別(px68k_joytype、PadType)によって8ボタン(CPSF-MD/CPSF-SFC)用の
// TRG3..TRG8プリセットも持っていたが、WebNP2はジョイスティック端子を持たずキー入力一本のため、
// その区別は無くしてある(A/Bボタン + 十字キー相当の1種類のみ)。

/** 8BitDo M30 のボタン index(内部0始まり)。index 2/5 は空き。 */
const M30_BTN = { A: 0, B: 1, MINUS: 10, PLUS: 11 } as const;
/** 8BitDo Micro のボタン index(内部0始まり)。 */
const MICRO_BTN = { A: 0, B: 1, MINUS: 10, PLUS: 11 } as const;

/** M30用プリセット: A→z, B→x, MINUS(Select相当)→ESC, PLUS(Start相当)→ENTER。 */
export const M30_PRESET: ReadonlyArray<{ source: Source; binding: Binding }> = [
  ...DPAD_CURSOR_BINDINGS,
  { source: { kind: 'button', index: M30_BTN.A }, binding: { kind: 'key', code: KEY_Z } },
  { source: { kind: 'button', index: M30_BTN.B }, binding: { kind: 'key', code: KEY_X } },
  { source: { kind: 'button', index: M30_BTN.MINUS }, binding: { kind: 'key', code: NAMED_KEYS.ESC } },
  { source: { kind: 'button', index: M30_BTN.PLUS }, binding: { kind: 'key', code: NAMED_KEYS.ENTER } },
];

/** Micro用プリセット: A→z, B→x, MINUS(Select相当)→ESC, PLUS(Start相当)→ENTER。 */
export const MICRO_PRESET: ReadonlyArray<{ source: Source; binding: Binding }> = [
  ...DPAD_CURSOR_BINDINGS,
  { source: { kind: 'button', index: MICRO_BTN.A }, binding: { kind: 'key', code: KEY_Z } },
  { source: { kind: 'button', index: MICRO_BTN.B }, binding: { kind: 'key', code: KEY_X } },
  { source: { kind: 'button', index: MICRO_BTN.MINUS }, binding: { kind: 'key', code: NAMED_KEYS.ESC } },
  { source: { kind: 'button', index: MICRO_BTN.PLUS }, binding: { kind: 'key', code: NAMED_KEYS.ENTER } },
];

/**
 * gamepad.id から USB Vendor/Product ID を抽出する純粋関数。
 *
 * ブラウザによって gamepad.id の書式が異なるため、両方を試す:
 * - Chrome/Edge 等: `(Vendor: 2dc8 Product: 0651)` の形でベンダー/プロダクトIDを埋め込む
 *   (表記の大文字小文字・桁数はブラウザ実装依存)。
 * - Firefox: `2dc8-0651-8BitDo M30 gamepad` のように、id の先頭が
 *   `vendorID-productID-name`(4桁16進のハイフン区切り)になる。
 * ここから `vendor:product`(共に小文字16進、桁は詰めない)の文字列を取り出す。
 * どちらにも一致しない/取り出せない場合は null(呼び出し側は id 文字列によるフォールバックに委ねること)。
 */
export function extractVendorProduct(padId: string): string | null {
  const named = /vendor:\s*([0-9a-f]+)\s+product:\s*([0-9a-f]+)/i.exec(padId);
  if (named) return `${named[1].toLowerCase()}:${named[2].toLowerCase()}`;
  const firefoxStyle = /^([0-9a-f]{4})-([0-9a-f]{4})-/i.exec(padId);
  if (firefoxStyle) return `${firefoxStyle[1].toLowerCase()}:${firefoxStyle[2].toLowerCase()}`;
  return null;
}

/**
 * Vendor:Product(小文字16進) -> 既知パッド種別。
 * 実機(ゲームパッドチェックサイトで実測)で確定させた値:
 * - 8BitDo M30 gamepad: Vendor 2dc8 / Product 0651
 * - 8BitDo Micro gamepad: Vendor 2dc8 / Product 9020
 */
const VENDOR_PRODUCT_TO_KNOWN_PAD: Record<string, 'm30' | 'micro'> = {
  '2dc8:0651': 'm30',
  '2dc8:9020': 'micro',
};

/**
 * gamepad.id から既知パッド種別('m30'/'micro')を判定する、唯一の情報源。
 * knownPadPresetFor()(プリセット選択)がこれを使う(判定ロジックの二重実装を避けるため)。
 * 一致しなければ null。
 *
 * 判定は Vendor/Product ID(extractVendorProduct())を最優先する。'Micro' の部分一致で
 * 判定すると 'Microsoft X-Box ...' のような無関係な id まで誤爆する
 * ('Micro' は 'Microsoft' の部分文字列)ため、文字列パターンマッチは誤爆しない 'm30' のみを
 * フォールバックとして残し、'micro' 系は vendor/product が取れた場合に限定する。
 */
function knownPadKindFor(padId: string): 'm30' | 'micro' | null {
  const vendorProduct = extractVendorProduct(padId);
  const known = vendorProduct ? VENDOR_PRODUCT_TO_KNOWN_PAD[vendorProduct] : undefined;
  if (known !== undefined) return known ?? null; // vendor/productは取れたが未知のペア: 誤爆を避けるため文字列フォールバックに落とさない。

  // vendor/product が取れない(ブラウザ実装差で id に埋め込まれていない)場合のみ、id文字列で
  // フォールバックする。'm30' は他の実在パッド名との衝突が知られていないため許容するが、
  // 'micro' は 'Microsoft' 等を誤爆するため vendor/product 経由でしか判定しない。
  const id = padId.toLowerCase();
  if (id.includes('m30')) return 'm30';
  return null;
}

/**
 * gamepad.id から既知パッド用の既定プリセットを1つ選ぶ、唯一の情報源。一致するパッドが
 * 無ければ null(呼び出し側は従来どおり mapping==='standard' か否かでフォールバックすること)。
 */
export function knownPadPresetFor(padId: string): ReadonlyArray<{ source: Source; binding: Binding }> | null {
  const kind = knownPadKindFor(padId);
  if (kind === 'm30') return M30_PRESET;
  if (kind === 'micro') return MICRO_PRESET;
  return null;
}

/**
 * 保存済みプロファイルが無いパッドに対する既定値を決める、唯一の情報源。
 * 1. gamepad.id が既知パッド(M30/Micro)にマッチすれば、mapping の申告に関わらずそのプリセットを使う
 *    (これらは standard 申告でない可能性が高く、mapping 頼みだと全未割当のまま始まってしまうため)。
 * 2. マッチしなければ従来どおり: mapping === 'standard' のときだけ CURSOR_ZX_PRESET、
 *    そうでなければ全未割当で始める(index の意味がパッドごとに違うため、推測で埋めない)。
 */
export function defaultProfileFor(pad: Pick<Gamepad, 'mapping'> & { id?: string }): GamepadProfile {
  const known = pad.id ? knownPadPresetFor(pad.id) : null;
  if (known) return { deadzone: DEFAULT_DEADZONE, bindings: known.map((e) => ({ source: e.source, binding: e.binding })) };
  return pad.mapping === 'standard' ? presetProfile() : blankProfile();
}

// --- 検出(押して割り当て)用の純粋関数 ---

/** ある瞬間の物理入力のスナップショット(検出モードの「押されていない状態」の基準に使う)。 */
export interface PadSnapshot {
  buttons: readonly boolean[];
  axes: readonly number[];
}

export function snapshotPad(pad: Gamepad): PadSnapshot {
  return {
    buttons: Array.from(pad.buttons ?? [], (b) => b?.pressed === true),
    axes: Array.from(pad.axes ?? [], (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)),
  };
}

/**
 * prev(検出開始時のスナップショット)から curr(現在)への遷移を見て、
 * 「押されていなかったものが押された」Source を1つ返す(無ければ null)。
 * 押しっぱなしのボタン/既に閾値を超えていた軸は無視する(prevで既に真だったものは対象外)。
 * ボタンを軸より先に見る(同一フレームで両方遷移した場合はボタン優先、決定的な順序にするため)。
 *
 * isAxisEligible は「その軸を検出対象にしてよいか」を軸indexごとに判定する関数(省略時は
 * 全軸を対象にする、既存呼び出し・テストとの後方互換のため)。呼び出し側(gamepad-ui.ts、
 * 後続タスクで移植)は GamepadManager の較正状態(axisState().calibrated)を渡すこと。
 * 未較正の軸は「一度も動かされておらず、報告値に意味がない」状態のため、検出(押して割り当て)の
 * 対象から除外する必要がある(較正が終わるまで割当そのものができないようにする設計)。
 */
export function detectNewlyActiveSource(
  prev: PadSnapshot,
  curr: PadSnapshot,
  deadzone: number,
  isAxisEligible: (index: number) => boolean = () => true,
): Source | null {
  for (let i = 0; i < curr.buttons.length; i++) {
    const wasPressed = prev.buttons[i] === true;
    if (!wasPressed && curr.buttons[i]) return { kind: 'button', index: i };
  }
  // 軸は「静止 → 動いた」の変化を要求する: prev(検出開始時点、または直前フレーム)を
  // その軸の静止値(rest)とみなし、そこからの偏差がデッドゾーンを超えたときだけ拾う。
  // 0を静止値とみなす旧実装だと、未押下で-1.0を返すトリガ軸(8BitDo M30/Micro実機で確認)が
  // 検出開始時点で既に「デッドゾーンを超えている」ため誤検出しかねない。
  // isAxisValueValid で範囲外の軸([-1,1]の外。ハット軸が紛れ込んだもの)も除外する。
  for (let i = 0; i < curr.axes.length; i++) {
    if (!isAxisEligible(i)) continue;
    const prevValue = prev.axes[i] ?? 0;
    const currValue = curr.axes[i] ?? 0;
    const dir = axisDeviationDir(currValue, prevValue, deadzone);
    if (dir !== null) return { kind: 'axis', index: i, dir };
  }
  return null;
}

function bindingsEqual(a: Binding, b: Binding): boolean {
  return a.kind === b.kind && a.code === b.code;
}

/** 2つの Source が同じ物理入力を指すか(編集UIでコンボ選択の現在値をハイライトする等に使う)。 */
export function sourcesEqual(a: Source, b: Source): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'button' && b.kind === 'button') return a.index === b.index;
  if (a.kind === 'axis' && b.kind === 'axis') return a.index === b.index && a.dir === b.dir;
  return false;
}

/**
 * Gamepad -> PC-98キースキャンコード集合への変換器。
 *
 * ブラウザ無しでユニットテストできるよう、`navigator.getGamepads()` への依存は持たない。
 * 呼び出し側(main.ts、後続タスクで移植)が毎フレーム取得したパッドをそのまま `keysForPad()`
 * へ渡す形にしてある。WebX68k版はポート(1P/2P)ごとに RetroPad ID ビットマスクを計算する
 * `poll()`/`bitsForPad()` を持っていたが、WebNP2 はポート概念が無く、接続中の全パッドを
 * 同時に(パッドごとに1つの GamepadManager を割り当てて)キー入力へ変換する設計のため、
 * ビットマスク計算は無くし keysForPad() 一本にしてある。
 */
export class GamepadManager {
  private deadzone: number;
  // Source -> Binding[] の逆引き。1つの物理入力に複数割当が乗るケース(編集UIで
  // 同じボタンに複数機能を足す等)を素直に扱うため、値は配列で持つ。
  // source自体もキーとは別に保持しておく(逆引きテーブルからUI表示用に「行から見た一覧」を
  // 引き直すため。sourceKey()は不可逆な文字列化なので、元のSourceを別途持つ必要がある)。
  private readonly bindings = new Map<string, Binding[]>();
  private readonly sourcesByKey = new Map<string, Source>();
  // 軸ごとの較正状態(AxisCalibration、gamepad.ts冒頭「軸判定」セクション参照)。
  // 較正が完了するまで(calibrated:false)は入力判定に使わない(未較正の軸は常に非アクティブ)。
  // 較正完了後(calibrated:true)は rest を固定し、二度と更新しない(継続的なポーリングのたびに
  // 更新すると、方向を入力し続けている最中に静止値が追いついてしまい、押しっぱなしのつもりが
  // 1フレームでOFFに戻ってしまう)。
  private readonly axisCalib = new Map<number, AxisCalibration>();

  constructor(
    preset: ReadonlyArray<{ source: Source; binding: Binding }> = CURSOR_ZX_PRESET,
    deadzone: number = DEFAULT_DEADZONE,
  ) {
    this.deadzone = deadzone;
    for (const { source, binding } of preset) this.addBinding(source, binding);
  }

  /** 保存済み/既定のプロファイルから GamepadManager を作る。 */
  static fromProfile(profile: GamepadProfile): GamepadManager {
    return new GamepadManager(profile.bindings, profile.deadzone);
  }

  /** 現在の状態をそのまま永続化できる GamepadProfile へ書き出す。 */
  toProfile(): GamepadProfile {
    return { deadzone: this.deadzone, bindings: this.getAllBindings() };
  }

  getDeadzone(): number {
    return this.deadzone;
  }

  setDeadzone(deadzone: number): void {
    this.deadzone = deadzone;
  }

  /** Source に Binding を追加する(編集UIの[検出]/コンボ選択から呼ぶ)。 */
  addBinding(source: Source, binding: Binding): void {
    const key = sourceKey(source);
    this.sourcesByKey.set(key, source);
    const list = this.bindings.get(key);
    if (list) list.push(binding);
    else this.bindings.set(key, [binding]);
  }

  /** 特定の Source から特定の Binding を1つ取り除く(チップの[削除])。一致が無ければ何もしない。 */
  removeBinding(source: Source, binding: Binding): void {
    const key = sourceKey(source);
    const list = this.bindings.get(key);
    if (!list) return;
    const next = list.filter((b) => !bindingsEqual(b, binding));
    if (next.length > 0) this.bindings.set(key, next);
    else {
      this.bindings.delete(key);
      this.sourcesByKey.delete(key);
    }
  }

  /** 保持している全 Source->Binding の対を平らな配列で返す(永続化・編集UIの一覧表示用)。 */
  getAllBindings(): Array<{ source: Source; binding: Binding }> {
    const out: Array<{ source: Source; binding: Binding }> = [];
    for (const [key, list] of this.bindings) {
      const source = this.sourcesByKey.get(key);
      if (!source) continue;
      for (const binding of list) out.push({ source, binding });
    }
    return out;
  }

  /**
   * 全バインディングを消してから指定プリセットを積み直す([既定に戻す]ボタン用)。
   * 引数省略時は従来どおり CURSOR_ZX_PRESET(standard mapping 向け)。呼び出し側(main.ts)は
   * 接続中パッドの id から knownPadPresetFor() で選んだプリセットを渡すこと
   * (8BitDo M30/Micro 等、パッドごとに既定が異なるため)。
   */
  resetToPreset(preset: ReadonlyArray<{ source: Source; binding: Binding }> = CURSOR_ZX_PRESET): void {
    this.bindings.clear();
    this.sourcesByKey.clear();
    for (const { source, binding } of preset) this.addBinding(source, binding);
  }

  /**
   * 現在押されている物理Sourceのうち kind:'key' で割り当てられている PC-98スキャンコードの
   * 集合を返す(WebX68k版の keysForPad() 相当。WebNP2 はキー入力のみのため、これが
   * GamepadManager の入力読み取りの唯一の窓口になる)。
   * オートリピートはしない(呼び出し側が前フレームとの差分を見て press/release するだけの
   * 「今フレーム押されている集合」を返すのがこのメソッドの責務。押しっぱなしはpressを
   * 連打しない=呼び出し側で同じ code が続けて入っていれば無視される前提)。
   */
  keysForPad(pad: Gamepad): Set<number> {
    const keys = new Set<number>();
    this.forEachActiveSource(pad, (source) => {
      const list = this.bindings.get(sourceKey(source));
      if (!list) return;
      for (const binding of list) keys.add(binding.code);
    });
    return keys;
  }

  /**
   * 現在押されている物理Sourceを列挙する(keysForPadの共通イテレータ)。
   *
   * 軸は較正状態(AxisCalibration)によって扱いが分かれる(gamepad.ts 冒頭「軸判定」セクション参照):
   * - 較正済み(calibrated:true): 確定した静止値(rest)からの偏差で判定する(従来どおり)。
   * - 未較正かつその軸に割当がある: 較正完了(区間2以降が AXIS_CALIBRATION_SETTLE_FRAMES
   *   フレーム分確定するまで、長押しの間は無期限)を待たずに、暫定の静止値として
   *   baseline(観測開始時点=まだ一度も動いていない時点の値)からの偏差で入力を生成する。
   *   8BitDo M30 等、十字キーが軸(axes[0]/[1])で来るパッドは静止値が最初から0付近で
   *   正しいため、これで較正完了前でも即座に方向入力が効くようになる(このガードが無いと、
   *   較正が終わるまで方向入力が一切効かなくなってしまう=今回手当てした副作用)。
   * - 未較正かつその軸に割当が無い: 従来どおり入力を一切生成しない。未割当のトリガ軸
   *   (axes[3]/[4]等)が較正前に誤ってONになる不具合はここで起きていたため、塞いだままにする。
   *
   * 較正が完了する瞬間(calibrated が false→true に変わるフレーム)も、暫定判定(baseline
   * 基準)と確定判定(rest基準)は同じ observeAxis() 呼び出しが返す1つの calib から計算する
   * ため、同一フレーム内で基準がずれることはない。またそのフレームで rest が baseline と
   * 一致していれば(区間2が静止=baselineのままだった、という通常のケース)、
   * 判定結果は暫定/確定のどちらでも同じになるため、押しっぱなしの入力が境界フレームで
   * 途切れたり固着したりしない。
   */
  private forEachActiveSource(pad: Gamepad, fn: (source: Source) => void): void {
    for (let index = 0; index < pad.buttons.length; index++) {
      if (!pad.buttons[index].pressed) continue;
      fn({ kind: 'button', index });
    }
    for (let index = 0; index < pad.axes.length; index++) {
      const value = pad.axes[index];
      if (!isAxisValueValid(value)) continue; // 範囲外(ハット軸等)は無効な軸として無視。
      const calib = this.observeAxis(index, value);
      if (calib.calibrated) {
        const dir = axisDeviationDir(value, calib.rest, this.deadzone);
        if (dir !== null) fn({ kind: 'axis', index, dir });
        continue;
      }
      if (!this.axisHasBinding(index)) continue; // 未較正・未割当: 較正完了まで入力を生成しない。
      // 未較正・割当あり: 暫定の静止値(baseline)からの偏差で判定する。
      const dir = axisDeviationDir(value, calib.baseline, this.deadzone);
      if (dir !== null) fn({ kind: 'axis', index, dir });
    }
  }

  /** 指定軸(index)の+方向/-方向のどちらかに1つでも kind:'key' の割当があるか。 */
  private axisHasBinding(index: number): boolean {
    return (
      this.bindings.has(sourceKey({ kind: 'axis', index, dir: 1 })) ||
      this.bindings.has(sourceKey({ kind: 'axis', index, dir: -1 }))
    );
  }

  /**
   * 指定軸の較正状態を1フレームぶん進めて記録する(副作用あり)。
   * advanceAxisCalibration()(純粋関数、gamepad.ts冒頭参照)へ委譲するだけで、判定ロジック
   * そのものはそちらの1箇所にしか存在しない。未観測の軸は初回呼び出し時に
   * initAxisCalibration() で baseline を記録する(この時点ではまだ未較正)。
   */
  private observeAxis(index: number, value: number): AxisCalibration {
    const existing = this.axisCalib.get(index);
    const next = existing ? advanceAxisCalibration(existing, value) : initAxisCalibration(value);
    this.axisCalib.set(index, next);
    return next;
  }

  /**
   * 指定軸の有効性・較正済みか・(較正中かどうか)・現在の偏差方向を返す
   * (gamepad-ui.ts のライブ表示・割当選択肢の判定用)。
   * keysForPad 計算と同じ較正状態(axisCalib)を共有するため、ライブ表示とコアへの実際の入力は常に一致する。
   * 範囲外の軸(無効)は valid:false, calibrated:false, calibrating:false, active:null を返す。
   * 未較正の軸は valid:true, calibrated:false, active:null を返す(未較正の間は常に非アクティブ。
   * 呼び出し側はこの calibrated で「較正待ち」の見た目を出し分けること)。
   * calibrating は「一度動かされて、区間の追跡(離れてから確定するまでの観測)が進行中」を表す
   * (calibrated:false かつ calibrating:false は「まだ一度も動かされていない」を意味し、
   * gamepad-ui.ts はこの2状態を別の見た目にできる)。
   */
  axisState(pad: Gamepad, index: number): { valid: boolean; calibrated: boolean; calibrating: boolean; active: 1 | -1 | null } {
    const value = pad.axes?.[index];
    if (!isAxisValueValid(value)) return { valid: false, calibrated: false, calibrating: false, active: null };
    const calib = this.observeAxis(index, value);
    if (!calib.calibrated) return { valid: true, calibrated: false, calibrating: calib.hasMoved, active: null };
    return { valid: true, calibrated: true, calibrating: false, active: axisDeviationDir(value, calib.rest, this.deadzone) };
  }

  /**
   * 指定軸の較正状態を、axisCalib への記録を発生させずに読む(observeAxis の観測なし版)。
   * デバッグフック専用。デバッグ用の覗き見自体が観測対象(較正の進行)を書き換えてしまうと、
   * 「まだ較正されていない軸がどう見えるか」を後から確認できなくなるため、副作用を持たせない。
   */
  private peekAxisCalibration(index: number): AxisCalibration | null {
    return this.axisCalib.get(index) ?? null;
  }

  /**
   * デバッグ用: そのパッドの全軸について、現在値・(記録を発生させずに読んだ)較正状態・
   * 有効性・現在のアクティブ判定をまとめて返す。実機の軸挙動を観測するためのデバッグフックから
   * 呼ばれる想定(このメソッドの呼び出し自体が axisCalib への記録を引き起こしてはいけない。
   * peekAxisCalibration 参照)。
   */
  describeAxes(pad: Gamepad): Array<{
    index: number;
    value: number;
    valid: boolean;
    calibrated: boolean;
    calibrating: boolean;
    rest: number | null;
    baseline: number | null;
    hasMoved: boolean;
    segments: number | null;
    segmentFrames: number | null;
    active: 1 | -1 | null;
  }> {
    const axes = pad.axes ?? [];
    const out: Array<{
      index: number;
      value: number;
      valid: boolean;
      calibrated: boolean;
      calibrating: boolean;
      rest: number | null;
      baseline: number | null;
      hasMoved: boolean;
      segments: number | null;
      segmentFrames: number | null;
      active: 1 | -1 | null;
    }> = [];
    for (let index = 0; index < axes.length; index++) {
      const rawValue = axes[index];
      const value = typeof rawValue === 'number' ? rawValue : NaN;
      const valid = isAxisValueValid(rawValue);
      const calib = this.peekAxisCalibration(index);
      if (calib === null) {
        out.push({
          index,
          value,
          valid,
          calibrated: false,
          calibrating: false,
          rest: null,
          baseline: null,
          hasMoved: false,
          segments: null,
          segmentFrames: null,
          active: null,
        });
        continue;
      }
      if (!calib.calibrated) {
        out.push({
          index,
          value,
          valid,
          calibrated: false,
          calibrating: calib.hasMoved,
          rest: null,
          baseline: calib.baseline,
          hasMoved: calib.hasMoved,
          segments: calib.segments,
          segmentFrames: calib.segmentFrames,
          active: null,
        });
        continue;
      }
      const active = valid ? axisDeviationDir(value, calib.rest, this.deadzone) : null;
      out.push({
        index,
        value,
        valid,
        calibrated: true,
        calibrating: false,
        rest: calib.rest,
        baseline: null,
        hasMoved: true,
        segments: null,
        segmentFrames: null,
        active,
      });
    }
    return out;
  }
}
