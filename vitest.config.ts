import { defineConfig } from 'vitest/config';
import { computeVersion } from './tools/compute-version.mjs';

// src/version.ts が参照する __WEBNP2_VERSION_FOOTER__ / __WEBNP2_BUILD_ID__ は
// vite.config.ts の define で埋め込まれる定数。vitestはvite.config.tsを継承しないため、
// module.ts / roms.ts を経由してこれらを参照するテストが動くよう、ここでも同じ値を定義する
// (情報源はtools/compute-version.mjsで一本化してあり、二重管理ではない)。
const { footer, buildId } = computeVersion();

export default defineConfig({
  define: {
    __WEBNP2_VERSION_FOOTER__: JSON.stringify(footer),
    __WEBNP2_BUILD_ID__: JSON.stringify(buildId),
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
