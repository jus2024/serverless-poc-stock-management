import { defineConfig } from "vitest/config";

/**
 * テスト基盤の設定。
 *
 * - ウォッチモードは使わない（実行は `vitest --run` のみ）
 * - `environment: 'jsdom'` により React コンポーネントテストと純関数テストを同一設定で扱う
 * - `include` は amplify（Lambda / CDK）・src（フロントエンド）・scripts（運用スクリプト）の 3 箇所
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
    include: [
      "amplify/**/*.test.ts",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "scripts/**/*.test.ts",
    ],
    exclude: ["node_modules/**", ".next/**", ".amplify/**", "agents/**", "load-generator/**"],
  },
});
