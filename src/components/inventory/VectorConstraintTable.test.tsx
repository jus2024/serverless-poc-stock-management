/**
 * 機能制約比較表（`VectorConstraintTable.tsx`）の property テスト（task 10.8）
 *
 * 検証対象は Correctness Property 53（制約メタデータの描画追従性）。
 * Property 54（制約比較表と注意書きの常時表示）は UI 状態の全域が対象なので
 * `VectorSearchComparisonView.test.tsx` 側に置く。
 *
 * ## モックの境界
 *
 * `capabilities` を props で渡す制御モードで描画するため、`GET /vector-search/capabilities`
 * は呼ばれない（`VectorConstraintTable` は `capabilities === undefined` のときだけ自己取得する）。
 * ネットワーク呼び出しと AWS 呼び出しは発生しない。
 *
 * 期待値は本テスト内で property の文言から独立に組み立てる。コンポーネント側の
 * `CONSTRAINT_ROWS` を参照しないため、描画規則を取り違えた実装は検出される。
 *
 * `vitest.config.ts` は `globals: false` のため `afterEach(cleanup)` を明示する。
 *
 * 要件: 15.1, 15.2, 15.3, 15.4, 15.6, 15.8
 * Property: 53
 */

import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import type {
  VectorBackendCapabilities,
  VectorCapabilitiesResponse,
  VectorFilterKind,
} from "../../lib/inventory/vector-types";
import VectorConstraintTable from "./VectorConstraintTable";

afterEach(cleanup);

// ============================================================
// 任意の制約メタデータ
// ============================================================

const FILTER_KINDS: VectorFilterKind[] = ["equality", "range"];

function capabilitiesArb(
  backend: "dynamodb" | "opensearch"
): fc.Arbitrary<VectorBackendCapabilities> {
  return fc
    .record({
      maxTopK: fc.option(fc.integer({ min: 1, max: 10_000 }), { nil: null }),
      supportedFilterKinds: fc.subarray(FILTER_KINDS),
      distanceFunctionMutable: fc.boolean(),
      distanceFunction: fc.constantFrom("COSINE", "cosinesimil", "EUCLIDEAN", "l2"),
      maxDimensions: fc.integer({ min: 1, max: 16_000 }),
      requiresOnDemandBilling: fc.boolean(),
      readableByQueryScanPartiQL: fc.boolean(),
      supportsFullTextCombination: fc.boolean(),
      supportsAggregation: fc.boolean(),
      supportsGeoQuery: fc.boolean(),
      supportsNestedQuery: fc.boolean(),
      filterKindsUnverified: fc.option(fc.string({ minLength: 1, maxLength: 30 }), {
        nil: undefined,
      }),
    })
    .map((fields) => {
      const base: VectorBackendCapabilities = {
        backend,
        maxTopK: fields.maxTopK,
        supportedFilterKinds: fields.supportedFilterKinds,
        distanceFunctionMutable: fields.distanceFunctionMutable,
        distanceFunction: fields.distanceFunction,
        maxDimensions: fields.maxDimensions,
        requiresOnDemandBilling: fields.requiresOnDemandBilling,
        readableByQueryScanPartiQL: fields.readableByQueryScanPartiQL,
        supportsFullTextCombination: fields.supportsFullTextCombination,
        supportsAggregation: fields.supportsAggregation,
        supportsGeoQuery: fields.supportsGeoQuery,
        supportsNestedQuery: fields.supportsNestedQuery,
      };
      return fields.filterKindsUnverified === undefined
        ? base
        : { ...base, filterKindsUnverified: fields.filterKindsUnverified };
    });
}

const noticeArb = fc.record({
  model: fc.constantFrom("amazon.titan-embed-text-v2:0", "amazon.titan-embed-text-v1"),
  officiallySupportedLanguages: fc.constantFrom("英語", "English"),
  previewLanguagesNote: fc.string({ minLength: 1, maxLength: 40 }),
  bilingualMeasurementNote: fc.string({ minLength: 1, maxLength: 40 }),
  fairnessNote: fc.string({ minLength: 1, maxLength: 40 }),
  reportPath: fc.constant("docs/vector-search-comparison.md"),
});

const capabilitiesResponseArb: fc.Arbitrary<VectorCapabilitiesResponse> = fc.record({
  dynamodb: capabilitiesArb("dynamodb"),
  opensearch: capabilitiesArb("opensearch"),
  embeddingNotice: noticeArb,
});

// ============================================================
// 期待値（property の文言から独立に組み立てる）
// ============================================================

function expectedFilterKindText(kind: VectorFilterKind): string {
  return kind === "equality" ? "等価条件（=）" : "範囲条件（大小比較・BETWEEN）";
}

function expectedSupport(supported: boolean): string {
  return supported ? "対応" : "非対応";
}

/** 制約項目 1 行分の期待値。`note` は「メタデータに存在しない値は描画されない」の検証用 */
interface ExpectedRow {
  readonly label: string;
  readonly value: (capabilities: VectorBackendCapabilities) => string;
  readonly note?: (capabilities: VectorBackendCapabilities) => string | undefined;
}

const EXPECTED_ROWS: readonly ExpectedRow[] = [
  {
    label: "TopK 上限",
    value: (c) => (c.maxTopK === null ? "上限なし" : `${c.maxTopK} 件`),
  },
  {
    label: "対応フィルタ種別",
    value: (c) =>
      c.supportedFilterKinds.length === 0
        ? "なし"
        : c.supportedFilterKinds.map(expectedFilterKindText).join("、"),
    note: (c) => c.filterKindsUnverified,
  },
  {
    label: "範囲フィルタ（大小比較・BETWEEN）",
    value: (c) => expectedSupport(c.supportedFilterKinds.indexOf("range") !== -1),
  },
  {
    label: "ベクトル次元数の上限",
    value: (c) => `${c.maxDimensions.toLocaleString("ja-JP")} 次元`,
  },
  {
    label: "距離関数",
    value: (c) => c.distanceFunction,
  },
  {
    label: "距離関数の変更",
    value: (c) =>
      c.distanceFunctionMutable
        ? "インデックス再作成なしに変更できる"
        : "インデックス作成時に固定され、インデックス再作成なしには変更できない",
  },
  {
    label: "オンデマンド課金",
    value: (c) => (c.requiresOnDemandBilling ? "前提条件として必須" : "前提条件ではない"),
  },
  {
    label: "Query / Scan / PartiQL による読み取り",
    value: (c) => (c.readableByQueryScanPartiQL ? "読み取れる" : "読み取れない"),
  },
  {
    label: "全文検索との併用",
    value: (c) => expectedSupport(c.supportsFullTextCombination),
  },
  {
    label: "集約",
    value: (c) => expectedSupport(c.supportsAggregation),
  },
  {
    label: "地理空間クエリ",
    value: (c) => expectedSupport(c.supportsGeoQuery),
  },
  {
    label: "ネストクエリ",
    value: (c) => expectedSupport(c.supportsNestedQuery),
  },
];

// ============================================================
// DOM の読み取り
// ============================================================

function constraintSection(): HTMLElement {
  const heading = screen.getByRole("heading", { name: "機能制約の比較" });
  const section = heading.closest("section");
  if (section === null) throw new Error("機能制約比較表の section が見つかりません");
  return section;
}

/** 行見出しのテキストで行を引き、DynamoDB 列と OpenSearch 列のセル文字列を返す */
function cellsOf(label: string): { dynamodb: string; opensearch: string } {
  const rows = Array.from(constraintSection().querySelectorAll("tbody tr"));
  const row = rows.filter((candidate) => {
    const rowHeader = candidate.querySelector('th[scope="row"]');
    return rowHeader !== null && (rowHeader.textContent ?? "") === label;
  })[0];
  if (row === undefined) throw new Error(`行 "${label}" が見つかりません`);
  const cells = Array.from(row.querySelectorAll("td"));
  if (cells.length !== 2) throw new Error(`行 "${label}" のデータセルが 2 つではありません`);
  return {
    dynamodb: cells[0].textContent ?? "",
    opensearch: cells[1].textContent ?? "",
  };
}

// ============================================================
// Property 53
// ============================================================

// Feature: vector-search-comparison, Property 53: 制約メタデータの描画追従性
// 任意の 制約メタデータに対して、機能制約比較表に描画される TopK 上限値・対応フィルタ種別・
// 次元数上限・距離関数の可変性・オンデマンド課金の要否・`Query` / `Scan` / PartiQL による
// 読み取り可否・各機能の対応状況は、メタデータの値と一致する。メタデータに存在しない値は
// 描画されない。各制約項目について両バックエンドの対応・非対応が見出しセルを持つ表構造の中で
// テキストとして表現される。
describe("Property 53: 制約メタデータの描画追従性", () => {
  it("表に描画される全制約項目の値がメタデータと一致し、存在しない値は描画されない", () => {
    fc.assert(
      fc.property(capabilitiesResponseArb, (capabilities) => {
        cleanup();
        render(<VectorConstraintTable capabilities={capabilities} />);

        EXPECTED_ROWS.forEach((row) => {
          const cells = cellsOf(row.label);
          const dynamodbNote = row.note === undefined ? undefined : row.note(capabilities.dynamodb);
          const opensearchNote =
            row.note === undefined ? undefined : row.note(capabilities.opensearch);
          const dynamodbExpected =
            row.value(capabilities.dynamodb) + (dynamodbNote === undefined ? "" : dynamodbNote);
          const opensearchExpected =
            row.value(capabilities.opensearch) + (opensearchNote === undefined ? "" : opensearchNote);

          // 描画される値はメタデータの値と一致する
          expect(cells.dynamodb).toBe(dynamodbExpected);
          expect(cells.opensearch).toBe(opensearchExpected);

          // メタデータに存在しない値は描画されない。セルは自身のバックエンドのメタデータから
          // 導かれる文字列そのものであり、値が異なる項目では相手側の描画文字列にならない
          if (dynamodbExpected !== opensearchExpected) {
            expect(cells.dynamodb).not.toBe(opensearchExpected);
            expect(cells.opensearch).not.toBe(dynamodbExpected);
          }
          // 一方にしかない補足（filterKindsUnverified）は他方のセルに現れない
          if (dynamodbNote === undefined && opensearchNote !== undefined) {
            expect(cells.dynamodb).toBe(row.value(capabilities.dynamodb));
          }
          if (opensearchNote === undefined && dynamodbNote !== undefined) {
            expect(cells.opensearch).toBe(row.value(capabilities.opensearch));
          }
        });

        // 見出しセルを持つ表構造の中でテキストとして表現される（要件 15.8）
        const scope = within(constraintSection());
        expect(scope.getAllByRole("columnheader")).toHaveLength(3);
        expect(scope.getAllByRole("rowheader")).toHaveLength(EXPECTED_ROWS.length);
        EXPECTED_ROWS.forEach((row) => {
          expect(scope.getByRole("rowheader", { name: row.label })).toBeTruthy();
        });
      }),
      { numRuns: 100 }
    );
  });

  it("制約メタデータが未取得のあいだも表の骨格と全行の見出しは残る", () => {
    render(<VectorConstraintTable capabilities={null} />);

    const scope = within(constraintSection());
    expect(scope.getAllByRole("rowheader")).toHaveLength(EXPECTED_ROWS.length);
    EXPECTED_ROWS.forEach((row) => {
      const cells = cellsOf(row.label);
      expect(cells.dynamodb).toBe("取得中");
      expect(cells.opensearch).toBe("取得中");
    });
    expect(scope.getByRole("heading", { name: "埋め込み言語サポートに関する注意" })).toBeTruthy();
  });

  it("制約メタデータの取得に失敗しても表の骨格と全行の見出しは残る", () => {
    render(<VectorConstraintTable capabilities={null} capabilitiesError="接続に失敗しました" />);

    EXPECTED_ROWS.forEach((row) => {
      const cells = cellsOf(row.label);
      expect(cells.dynamodb).toBe("取得できません");
      expect(cells.opensearch).toBe("取得できません");
    });
    expect(constraintSection().textContent).toContain("接続に失敗しました");
  });
});
