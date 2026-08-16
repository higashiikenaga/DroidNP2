// ビルド版文字列生成(tools/version.mjs, tools/compute-version.mjs)の単体テスト。
//
// 目的(コーディネータ指示):
// - フォーマットの確認
// - JSTが固定オフセット(+09:00)で計算されており、ホストのTZ設定に依存しないこと
// - 作業ツリーが汚れている場合に印が付くこと
//
// tools/*.mjs はビルド設定(vite.config.ts/vitest.config.ts)から素のJSとして
// importされるため、テストも同じ .mjs を直接importする(src/配下のTS変換は経由しない)。

import { describe, expect, it } from 'vitest';
import { formatVersion, UNKNOWN_VERSION } from '../tools/version.mjs';
import { computeVersion } from '../tools/compute-version.mjs';

describe('formatVersion', () => {
  // 2026-08-16T05:03:00+09:00 = 2026-08-15T20:03:00Z のunix秒
  const COMMIT_TS = Date.UTC(2026, 7, 15, 20, 3, 0) / 1000;

  it('基本フォーマット: "WebNP2 YYYY-MM-DD HH:MM JST (ハッシュ7桁)"', () => {
    const { footer, buildId } = formatVersion(COMMIT_TS, 'ab6a806', false);
    expect(footer).toBe('WebNP2 2026-08-16 05:03 JST (ab6a806)');
    expect(buildId).toBe('ab6a806');
  });

  it('作業ツリーが汚れている場合、footerは"+"、buildIdは"-dirty"で印が付く', () => {
    const { footer, buildId } = formatVersion(COMMIT_TS, 'ab6a806', true);
    expect(footer).toBe('WebNP2 2026-08-16 05:03 JST (ab6a806+)');
    expect(buildId).toBe('ab6a806-dirty');
  });

  it('buildIdは空白・括弧・"+"を含まない(URLクエリにそのまま使える)', () => {
    const clean = formatVersion(COMMIT_TS, 'ab6a806', false).buildId;
    const dirty = formatVersion(COMMIT_TS, 'ab6a806', true).buildId;
    for (const id of [clean, dirty]) {
      expect(id).not.toMatch(/[\s()+]/);
    }
  });

  it('日付境界: UTC日またぎでもJST(UTC+9)側の日付になる', () => {
    // 2026-01-01T00:30:00Z は JSTで 2026-01-01T09:30:00+09:00
    const ts = Date.UTC(2026, 0, 1, 0, 30, 0) / 1000;
    const { footer } = formatVersion(ts, '0000000', false);
    expect(footer).toBe('WebNP2 2026-01-01 09:30 JST (0000000)');
  });

  it('TZ環境変数を変えても結果が変わらない(固定オフセット計算のためTZを参照しない)', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const a = formatVersion(COMMIT_TS, 'ab6a806', false);
      process.env.TZ = 'America/New_York';
      const b = formatVersion(COMMIT_TS, 'ab6a806', false);
      process.env.TZ = 'Asia/Tokyo';
      const c = formatVersion(COMMIT_TS, 'ab6a806', false);
      expect(b).toEqual(a);
      expect(c).toEqual(a);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe('UNKNOWN_VERSION', () => {
  it('git取得失敗時のフォールバックは、もっともらしい値ではなく明示的に"unknown"とわかる', () => {
    expect(UNKNOWN_VERSION.footer).toContain('unknown');
    expect(UNKNOWN_VERSION.buildId).toBe('unknown');
  });
});

describe('computeVersion (実際のgitリポジトリに対する統合テスト)', () => {
  // このテスト自体がWebNP2のgitリポジトリ内で動く前提(vitestはリポジトリルートから実行される)。
  it('現在のHEADから取得に成功し、フォーマットに合致する', () => {
    const { footer, buildId } = computeVersion();
    expect(footer).toMatch(/^WebNP2 \d{4}-\d{2}-\d{2} \d{2}:\d{2} JST \([0-9a-f]{7}\+?\)$/);
    expect(buildId).toMatch(/^[0-9a-f]{7}(-dirty)?$/);
  });

  it('TZ環境変数を変えても同じ結果になる', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const a = computeVersion();
      process.env.TZ = 'America/New_York';
      const b = computeVersion();
      expect(b).toEqual(a);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});
