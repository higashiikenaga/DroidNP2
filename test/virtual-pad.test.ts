import { describe, expect, it } from 'vitest';
import {
  hitTestVpad, layoutVpad, layoutVpadSides, placementForViewport, stickDirsFromPoint, stickKnobOffset,
  STICK_DEADZONE_RATIO, STICK_MAX_RADIUS_RATIO, vpadWidgetsFor, type VpadWidget,
} from '../src/ui/virtual-pad.ts';

const ids = new Set(['dpad-up', 'dpad-down', 'dpad-left', 'dpad-right', 'btn-a', 'btn-b']);
const widgets = vpadWidgetsFor('panel', ids);
const dpad = widgets.find((w): w is Extract<VpadWidget, { kind: 'dpad' }> => w.kind === 'dpad')!;

describe('バーチャルパッドのレイアウト', () => {
  it('短辺に比例して部品サイズを計算する', () => {
    const result = layoutVpad(1000, 500, [{ kind: 'button', id: 'x', label: 'X', xPct: 50, yPct: 50, sizePct: 20 }]);
    expect(result[0].rect).toEqual({ x: 450, y: 200, w: 100, h: 100 });
  });
  it.each([[375, 234], [640, 400], [800, 600]])('%ix%iですべての部品が範囲内に収まる', (width, height) => {
    for (const { rect } of layoutVpad(width, height, widgets)) {
      expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w).toBeLessThanOrEqual(width); expect(rect.y + rect.h).toBeLessThanOrEqual(height);
    }
  });
  it('割当の無いボタンを描画しない', () => {
    expect(vpadWidgetsFor('panel', new Set(['btn-a'])).map((w) => w.kind === 'button' ? w.id : 'dpad')).toEqual(['btn-a']);
  });
});

describe('縦横の自動配置', () => {
  it('375x812はpanel、812x375はsides、正方形はpanel', () => {
    expect(placementForViewport(375, 812)).toBe('panel');
    expect(placementForViewport(812, 375)).toBe('sides');
    expect(placementForViewport(500, 500)).toBe('panel');
  });
  it('実機縦持ち相当367x260のpanel内へ全要素が収まる', () => {
    for (const { rect } of layoutVpad(367, 260, vpadWidgetsFor('panel', ids))) {
      expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w).toBeLessThanOrEqual(367); expect(rect.y + rect.h).toBeLessThanOrEqual(260);
    }
  });
});

describe('layoutVpadSides', () => {
  const boxes = {
    left: { x: 0, y: 46, w: 194, h: 283 },
    right: { x: 618, y: 46, w: 194, h: 283 },
  };
  const sixIds = new Set([...ids, 'btn-c', 'btn-d', 'btn-e', 'btn-f', 'btn-opt1', 'btn-opt2']);
  const result = layoutVpadSides(boxes, sixIds);

  it('全要素が左右いずれかの余白ボックス内に収まり、中央画面へ侵入しない', () => {
    for (const { rect } of result) {
      const box = rect.x < 194 ? boxes.left : boxes.right;
      expect(rect.x).toBeGreaterThanOrEqual(box.x); expect(rect.y).toBeGreaterThanOrEqual(box.y);
      expect(rect.x + rect.w).toBeLessThanOrEqual(box.x + box.w); expect(rect.y + rect.h).toBeLessThanOrEqual(box.y + box.h);
      expect(rect.x + rect.w <= 194 || rect.x >= 618).toBe(true);
    }
  });
  it('同じ側の円形部品同士が重ならない', () => {
    for (let i = 0; i < result.length; i++) for (let j = i + 1; j < result.length; j++) {
      const a = result[i].rect; const b = result[j].rect;
      const distance = Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2);
      const radiusSum = Math.min(a.w, a.h) / 2 + Math.min(b.w, b.h) / 2;
      if ((a.x < 194) === (b.x < 194)) expect(distance).toBeGreaterThanOrEqual(radiusSum - 1e-9);
    }
  });
  it('幅140pxの狭い余白でも全要素を縮小して内側へ収める', () => {
    const narrow = { left: { x: 0, y: 0, w: 140, h: 283 }, right: { x: 672, y: 0, w: 140, h: 283 } };
    for (const { rect } of layoutVpadSides(narrow, sixIds)) expect(rect.x + rect.w <= 140 || rect.x >= 672).toBe(true);
  });
});

describe('スティックの8方向判定', () => {
  const rect = { x: 0, y: 0, w: 200, h: 200 };
  const point = (degrees: number, distance = 60) => ({ x: 100 + Math.cos(degrees * Math.PI / 180) * distance, y: 100 + Math.sin(degrees * Math.PI / 180) * distance });
  it.each([
    [0, ['dpad-right']], [45, ['dpad-right', 'dpad-down']], [90, ['dpad-down']],
    [135, ['dpad-down', 'dpad-left']], [180, ['dpad-left']], [225, ['dpad-left', 'dpad-up']],
    [270, ['dpad-up']], [315, ['dpad-up', 'dpad-right']],
  ] as const)('%i度を対応方向へスナップする', (degrees, expected) => {
    const p = point(degrees); expect(stickDirsFromPoint(dpad, rect, p.x, p.y)).toEqual(expected);
  });
  it('不感帯内は無入力、円外へ移動しても方向を維持する', () => {
    const near = point(0, rect.w * STICK_DEADZONE_RATIO / 2);
    expect(stickDirsFromPoint(dpad, rect, near.x, near.y)).toEqual([]);
    expect(stickDirsFromPoint(dpad, rect, 500, 100)).toEqual(['dpad-right']);
  });
  it('ノブの移動量を最大半径に制限する', () => {
    const offset = stickKnobOffset(rect, 500, 100);
    expect(Math.hypot(offset.x, offset.y)).toBeCloseTo(rect.w * STICK_MAX_RADIUS_RATIO);
  });
});

describe('円形ヒットテスト', () => {
  const button: VpadWidget = { kind: 'button', id: 'btn-a', label: 'A', xPct: 50, yPct: 50, sizePct: 20 };
  const laidOut = layoutVpad(100, 100, [button]);
  it('中心は反応し、矩形角は円外なので反応しない', () => {
    expect(hitTestVpad(laidOut, 50, 50)).toEqual(['btn-a']);
    expect(hitTestVpad(laidOut, 40, 40)).toEqual([]);
  });
});
