import { defineConfig } from "vitest/config";

/**
 * テスト基盤の設定。
 *
 * - ウォッチモードは使わない（実行は `vitest --run` のみ）
 * - `environment: 'jsdom'` により React コンポーネントテストと純関数テストを同一設定で扱う
 * - `include` は amplify（Lambda / CDK）・src（フロントエンド）・scripts（運用スクリプト）の 3 箇所
 *
 * ## `testTimeout` を既定の 5,000 ms から引き上げている理由
 *
 * property テストは設計の規約により **1 本あたり最小 100 回反復**する（tasks.md「property テストの
 * 共通ルール」）。UI 側の property テスト（Property 30 / 31 / 32 / 53 / 54 / 57）は各反復で
 * React ツリーを丸ごと `render()` するため、1 本で 100 回の描画とクエリを行う。単独実行では
 * 1 本あたり 1〜3 秒に収まるが、**フルスイートの並列実行では負荷で 5 秒を超えて既定の
 * `testTimeout` に達する**。実測では `npm run test` で Property 30 / 31 / 53 の 3 本が
 * `Test timed out in 5000ms` で落ち、いずれも単独実行では通っていた。
 *
 * これは論理の欠陥ではなく既定値が実態に合っていないだけであり、反復回数は規約上減らせない。
 * したがって時間で切るのをやめる代わりに上限を引き上げる。**個別のテストに timeout 引数を
 * 付ける方式は採らない**（Property 32 / 54 / 57 も同じ構造で潜在的に同じリスクを持つため、
 * 設定で一括して扱う）。無限ループやデッドロックは 30 秒で依然として検出できる。
 */
export default defineConfig({
  oxc: {
    // tsconfig.json の `jsx: "preserve"`（Next.js のビルド前提）に引きずられず、
    // テスト実行時は React の automatic runtime に変換する
    jsx: { runtime: "automatic" },
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./vitest.setup.ts"],
    // property テストの 100 回反復 × React の全ツリー描画が並列実行の負荷で
    // 既定 5,000 ms を超えるため引き上げる（上のコメント参照）
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: [
      "amplify/**/*.test.ts",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "scripts/**/*.test.ts",
    ],
    exclude: ["node_modules/**", ".next/**", ".amplify/**", "agents/**", "load-generator/**"],
  },
});
