// ビルド版文字列。実体は vite.config.ts の define で埋め込まれるグローバル定数
// (__WEBNP2_VERSION_FOOTER__ / __WEBNP2_BUILD_ID__、型宣言は src/vite-env.d.ts)。
// 生成ロジックは tools/compute-version.ts ではなく tools/compute-version.mjs
// (+ tools/version.mjs の純関数) 側にある。ここは他モジュールから型付きで
// 参照するための薄い再エクスポート層。
//
// - WEBNP2_VERSION_FOOTER: フッター表示用の完全な識別子
//   例: "WebNP2 2026-08-16 05:03 JST (ab6a806)"(汚れたツリーからのビルドは末尾に"+")
// - WEBNP2_BUILD_ID: public/配下の固定名アセットのキャッシュバスティング用クエリ値。
//   URLに載るため空白等を含まない短い識別子(例: "ab6a806" / "ab6a806-dirty")。

export const WEBNP2_VERSION_FOOTER: string = __WEBNP2_VERSION_FOOTER__;
export const WEBNP2_BUILD_ID: string = __WEBNP2_BUILD_ID__;
