import { defineConfig } from 'vite';
import { computeVersion } from './tools/compute-version.mjs';

// ビルド版文字列(フッター表示)とキャッシュバスティング用のbuildId(アセットURLのクエリ)を
// 設定読み込み時に一度だけ確定させ、define でソースへ埋め込む。
// gen_version.py方式(別ファイル生成)ではなく define を使うのは、WebNP2は
// vite+TSプロジェクトで`.env`同様の定数埋め込み経路が既にvite標準で用意されているため
// (詳細: tools/compute-version.mjs, tools/version.mjs)。
const { footer, buildId } = computeVersion();

export default defineConfig({
  base: './',
  define: {
    __WEBNP2_VERSION_FOOTER__: JSON.stringify(footer),
    __WEBNP2_BUILD_ID__: JSON.stringify(buildId),
  },
});
