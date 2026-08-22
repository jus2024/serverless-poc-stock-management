/**
 * ベクトル検索比較 UI（`VectorSearchComparisonView.tsx` とその子コンポーネント）の
 * property テストとユニットテスト（task 10.8）
 *
 * 検証対象は Correctness Property 30（無効入力時の結果状態の不変）、31（パネルの独立性）、
 * 32（競合検索の最終一貫性）、54（制約比較表と注意書きの常時表示）、57（結果表示の網羅性）。
 * Property 53（制約メタデータの描画追従性）は `VectorConstraintTable.test.tsx` に置く。
 *
 * ## モックの境界
 *
 * 差し替えるのは `src/lib/inventory/vector-api.ts` の 4 つのエンドポイント関数だけである。
 * `VectorApiError` / `isAbortError` / `isVectorApiError` は実物を使うため、
 * 画面がエラー応答をどう解釈するかは実装のままになる。ネットワーク呼び出しと AWS 呼び出しは
 * 一切発生しない。
 *
 * `VectorComparisonPanel` / `VectorOverlapSummary` / `VectorConstraintTable` /
 * `VectorSearchForm` / `LatencyBar` はいずれもモックしない。Property 57 の
 * 「パネルに描画される結果行数が配列長と等しい」は実際の DOM を数えないと空虚になるためである。
 *
 * ## 応答の解決順序の制御
 *
 * Property 32 は「応答到着順序が任意」であることを要求する。タイマーではなく、テスト側が
 * 保持する Deferred を明示的に resolve することで到着順序を作る。
 * `seam.handlers.*` は既定で `AbortSignal` を無視する。これにより古い応答を捨てる経路が
 * `requestSeq` の照合だけになり、その照合が実際に効いていることを観測できる。
 * 中断（`AbortController`）が働く経路は 35 秒タイムアウトの例示テストで別に観測する。
 *
 * ## 実行環境の制約に対する対応
 *
 * `vitest.config.ts` は `globals: false` のため `@testing-library/react` の自動 cleanup が
 * 登録されない。`afterEach(cleanup)` を明示し、property の各反復でも先頭で `cleanup()` する。
 * `@testing-library/user-event` は未導入のため入力操作は `fireEvent` で行う。
 *
 * 要件: 11.1, 11.3, 11.5, 11.6, 11.7, 11.12, 11.13, 11.15, 11.22, 11.23, 11.24,
 *       12.8, 15.1, 15.5
 * Property: 30, 31, 32, 54, 57
 */

import fc from "fast-check";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

/** モックとテスト本体で共有する差し替え口と記録簿 */
const seam = vi.hoisted(() => ({
  /** `GET /vector-search/capabilities` が返す値。`undefined` は未設定（呼ぶと失敗する） */
  capabilities: undefined as unknown,
  /** 各エンドポイントの応答を組み立てる関数。テストごとに差し替える */
  handlers: {
    embed: undefined as
      | ((request: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>)
      | undefined,
    dynamodb: undefined as
      | ((request: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>)
      | undefined,
    opensearch: undefined as
      | ((request: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>)
      | undefined,
  },
  /** 各エンドポイントへ渡されたリクエスト（呼び出し順） */
  requests: {
    embed: [] as unknown[],
    dynamodb: [] as unknown[],
    opensearch: [] as unknown[],
  },
}));

vi.mock("../../lib/inventory/vector-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/inventory/vector-api")>();
  return {
    ...actual,
    getVectorCapabilities: async (): Promise<unknown> => {
      if (seam.capabilities === undefined) {
        throw new Error("capabilities が未設定です");
      }
      return seam.capabilities;
    },
    embedVectorQuery: (request: unknown, options?: { signal?: AbortSignal }): Promise<unknown> => {
      seam.requests.embed.push(request);
      const handler = seam.handlers.embed;
      if (handler === undefined) return Promise.reject(new Error("embed handler が未設定です"));
      return handler(request, options);
    },
    searchVectorDynamoDB: (
      request: unknown,
      options?: { signal?: AbortSignal }
    ): Promise<unknown> => {
      seam.requests.dynamodb.push(request);
      const handler = seam.handlers.dynamodb;
      if (handler === undefined) return Promise.reject(new Error("dynamodb handler が未設定です"));
      return handler(request, options);
    },
    searchVectorOpenSearch: (
      request: unknown,
      options?: { signal?: AbortSignal }
    ): Promise<unknown> => {
      seam.requests.opensearch.push(request);
      const handler = seam.handlers.opensearch;
      if (handler === undefined) return Promise.reject(new Error("opensearch handler が未設定です"));
      return handler(request, options);
    },
  };
});

import { VectorApiError } from "../../lib/inventory/vector-api";
import type {
  DynamoDBVectorSearchResponse,
  OpenSearchVectorSearchResponse,
  VectorBackendCapabilities,
  VectorCapabilitiesResponse,
  VectorEmbedResponse,
  VectorLanguage,
  VectorSearchHit,
} from "../../lib/inventory/vector-types";
import VectorSearchComparisonView, { VECTOR_TIMEOUT_MS } from "./VectorSearchComparisonView";
import { validateTopKInput } from "./VectorSearchForm";

// ============================================================
// フィクスチャ
// ============================================================

const WAREHOUSES = ["WH-TOKYO", "WH-OSAKA", "WH-FUKUOKA"] as const;

const DYNAMODB_CAPABILITIES: VectorBackendCapabilities = {
  backend: "dynamodb",
  maxTopK: 100,
  supportedFilterKinds: ["equality"],
  distanceFunctionMutable: false,
  distanceFunction: "COSINE",
  maxDimensions: 4096,
  requiresOnDemandBilling: true,
  readableByQueryScanPartiQL: false,
  supportsFullTextCombination: false,
  supportsAggregation: false,
  supportsGeoQuery: false,
  supportsNestedQuery: false,
  filterKindsUnverified: "範囲条件の対応可否は公式ドキュメント間で矛盾しており実測で確定させる",
};

const OPENSEARCH_CAPABILITIES: VectorBackendCapabilities = {
  backend: "opensearch",
  maxTopK: null,
  supportedFilterKinds: ["equality", "range"],
  distanceFunctionMutable: false,
  distanceFunction: "cosinesimil",
  maxDimensions: 16000,
  requiresOnDemandBilling: false,
  readableByQueryScanPartiQL: true,
  supportsFullTextCombination: true,
  supportsAggregation: true,
  supportsGeoQuery: true,
  supportsNestedQuery: true,
};

/** 埋め込み言語サポートの注意書き（要件 15.5 の 4 項目） */
const EMBEDDING_NOTICE = {
  model: "amazon.titan-embed-text-v2:0",
  officiallySupportedLanguages: "英語",
  previewLanguagesNote: "日本語を含む 100 言語以上はプレビュー扱いである。",
  bilingualMeasurementNote: "日本語と英語の 2 本のベクトルを独立生成して言語別に recall を測定している。",
  fairnessNote: "両バックエンドが同一ベクトルを使用するため比較の公平性は保たれる。",
  reportPath: "docs/vector-search-comparison.md",
} as const;

const CAPABILITIES: VectorCapabilitiesResponse = {
  dynamodb: DYNAMODB_CAPABILITIES,
  opensearch: OPENSEARCH_CAPABILITIES,
  embeddingNotice: EMBEDDING_NOTICE,
};

/** 数値のばらつきだけを property から受け取り、識別子は接頭辞で作る */
interface HitSeed {
  readonly distance: number;
  readonly rawScore: number;
  readonly quantity: number;
  readonly unitPrice: number;
}

function buildHits(prefix: string, seeds: readonly HitSeed[]): VectorSearchHit[] {
  return seeds.map((seed, index) => ({
    itemId: `${prefix}-ITEM-${index}`,
    warehouseId: WAREHOUSES[index % WAREHOUSES.length],
    productName: `${prefix} 商品 ${index}`,
    category: "焙煎豆",
    origin: "ブラジル",
    roastLevel: "中煎り",
    flavorNotes: "ナッツ",
    quantity: seed.quantity,
    location: `A-${index}`,
    unitPrice: seed.unitPrice,
    rank: index + 1,
    distance: seed.distance,
    rawScore: seed.rawScore,
  }));
}

/** 件数だけを指定して決定論的な結果配列を作る */
function makeHits(prefix: string, count: number): VectorSearchHit[] {
  const seeds: HitSeed[] = [];
  for (let index = 0; index < count; index += 1) {
    seeds.push({
      distance: 0.1 + index * 0.01,
      rawScore: 0.95 - index * 0.01,
      quantity: 10 + index,
      unitPrice: 1000 + index,
    });
  }
  return buildHits(prefix, seeds);
}

function countDistinctSkus(hits: readonly VectorSearchHit[]): number {
  const seen: string[] = [];
  hits.forEach((hit) => {
    if (seen.indexOf(hit.itemId) === -1) seen.push(hit.itemId);
  });
  return seen.length;
}

function embedResponse(language: VectorLanguage, latencyMs = 42): VectorEmbedResponse {
  return {
    queryId: `query-${language}-${latencyMs}`,
    embeddingLatencyMs: latencyMs,
    dimensions: 1024,
    model: EMBEDDING_NOTICE.model,
    language,
    // us-west-2 の `amazon.titan-embed-text-v2:0` は常にフォールバックする（要件 10.1 / A21）
    inferencePath: "standard",
    cacheHit: false,
  };
}

function dynamodbResponse(
  hits: readonly VectorSearchHit[],
  searchLatencyMs: number,
  language: VectorLanguage = "ja"
): DynamoDBVectorSearchResponse {
  return {
    backend: "dynamodb",
    hits: hits.slice(),
    language,
    requestedTopK: 30,
    appliedTopK: 30,
    returnedCount: hits.length,
    distinctSkuCount: countDistinctSkus(hits),
    searchLatencyMs,
    handlerLatencyMs: searchLatencyMs + 3,
    coldStart: false,
    indexName: language === "ja" ? "byEmbeddingJa" : "byEmbeddingEn",
    distanceFunction: "COSINE",
    distanceSemantics: "lower_is_closer",
    filterApplied: [],
    // `SearchVectors` の消費量はバイトである（キャパシティユニットではない）。
    // 1,024 次元の f32 クエリベクトル（約 4 KiB）に射影属性を加えた程度の値を置く
    consumedCapacity: { vectorSearchRequestBytes: 4608 },
    // `backfillingPresent: false` は実測どおり（`Backfilling` キーが返らない。設計 V20）
    indexReadiness: {
      indexStatus: "ACTIVE",
      backfilling: false,
      backfillingPresent: false,
      describeTableCached: false,
    },
    constraints: DYNAMODB_CAPABILITIES,
  };
}

function opensearchResponse(
  hits: readonly VectorSearchHit[],
  searchLatencyMs: number,
  language: VectorLanguage = "ja"
): OpenSearchVectorSearchResponse {
  return {
    backend: "opensearch",
    hits: hits.slice(),
    language,
    requestedTopK: 30,
    appliedTopK: 30,
    returnedCount: hits.length,
    distinctSkuCount: countDistinctSkus(hits),
    took: searchLatencyMs,
    searchLatencyMs,
    handlerLatencyMs: searchLatencyMs + 3,
    coldStart: false,
    indexName: "inventory-vector",
    vectorField: language === "ja" ? "embeddingJa" : "embeddingEn",
    spaceType: "cosinesimil",
    distanceSemantics: "lower_is_closer",
    scoreNormalization: "two_minus_d_over_two",
    filterApplied: [],
    constraints: OPENSEARCH_CAPABILITIES,
  };
}

/** DynamoDB 側のエラー。OpenSearch 側と混同しないコードとメッセージにする */
const DYNAMODB_ERROR_CODE = "INDEX_BUILDING";
const DYNAMODB_ERROR_MESSAGE = "DDB 側のインデックスが構築中です";
/** OpenSearch 側のエラー */
const OPENSEARCH_ERROR_CODE = "OPENSEARCH_TIMEOUT";
const OPENSEARCH_ERROR_MESSAGE = "AOSS 側が応答しませんでした";

function dynamodbError(): VectorApiError {
  return new VectorApiError({
    stage: "SEARCH_DYNAMODB",
    errorCode: DYNAMODB_ERROR_CODE,
    message: DYNAMODB_ERROR_MESSAGE,
    retryable: true,
    retryAfterSeconds: 30,
  });
}

function opensearchError(): VectorApiError {
  return new VectorApiError({
    stage: "SEARCH_OPENSEARCH",
    errorCode: OPENSEARCH_ERROR_CODE,
    message: OPENSEARCH_ERROR_MESSAGE,
    retryable: true,
  });
}

// ============================================================
// 非同期の制御
// ============================================================

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveFn: ((value: T) => void) | undefined;
  let rejectFn: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    promise,
    resolve(value: T) {
      if (resolveFn !== undefined) resolveFn(value);
    },
    reject(error: unknown) {
      if (rejectFn !== undefined) rejectFn(error);
    },
  };
}

/**
 * 呼び出しごとに Deferred を作って `store` に積むハンドラ。
 * `AbortSignal` を無視するため、古い応答を捨てる判断は `requestSeq` の照合だけになる。
 */
function deferredHandler(
  store: Deferred<unknown>[]
): (request: unknown, options?: { signal?: AbortSignal }) => Promise<unknown> {
  return () => {
    const deferred = createDeferred<unknown>();
    store.push(deferred);
    return deferred.promise;
  };
}

/** 中断されるまで解決しないハンドラ。`fetch` の中断挙動（AbortError で reject）を模す */
function abortAwareNeverHandler(): (
  request: unknown,
  options?: { signal?: AbortSignal }
) => Promise<unknown> {
  return (_request, options) =>
    new Promise<unknown>((_resolve, reject) => {
      const signal = options?.signal;
      const fail = () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        reject(error);
      };
      if (signal === undefined) return;
      if (signal.aborted) {
        fail();
        return;
      }
      signal.addEventListener("abort", fail, { once: true });
    });
}

/** マイクロタスクを流し切る（React の state 更新を確定させる） */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ============================================================
// DOM の読み取り
// ============================================================

const PANEL_HEADINGS = {
  dynamodb: "DynamoDB Vector Search",
  opensearch: "OpenSearch k-NN",
} as const;

/** パネル 1 つ分の `<section>` を取り出す。パネル外の表示と混ざらないようにする */
function panelOf(backend: "dynamodb" | "opensearch"): HTMLElement {
  const heading = screen.getByRole("heading", { name: PANEL_HEADINGS[backend] });
  const section = heading.closest("section");
  if (section === null) {
    throw new Error(`${backend} パネルの section が見つかりません`);
  }
  return section;
}

/** パネル内の `<dl>` から指定項目の値を読む */
function metaValueOf(panel: HTMLElement, term: string): string {
  const dt = within(panel).getByText(term);
  const dd = dt.parentElement === null ? null : dt.parentElement.querySelector("dd");
  return dd === null ? "" : (dd.textContent ?? "");
}

/** パネル内の結果テーブルの本体行数 */
function hitRowCountOf(panel: HTMLElement): number {
  return panel.querySelectorAll("tbody tr").length;
}

function textOf(element: HTMLElement): string {
  return element.textContent ?? "";
}

function queryInput(): HTMLInputElement {
  return screen.getByLabelText(/検索クエリ/) as HTMLInputElement;
}

function topKInput(): HTMLInputElement {
  return screen.getByLabelText(/^TopK/) as HTMLInputElement;
}

function searchButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "検索" }) as HTMLButtonElement;
}

/** クエリを入れて検索ボタンを押す（マイクロタスクは流さない） */
function startSearch(query: string): void {
  fireEvent.change(queryInput(), { target: { value: query } });
  fireEvent.click(searchButton());
}

function resetSeam(): void {
  seam.capabilities = CAPABILITIES;
  seam.handlers.embed = undefined;
  seam.handlers.dynamodb = undefined;
  seam.handlers.opensearch = undefined;
  seam.requests.embed = [];
  seam.requests.dynamodb = [];
  seam.requests.opensearch = [];
}

beforeEach(() => {
  resetSeam();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ============================================================
// ユニットテスト: 初期値（要件 11.3, 11.5, 11.7）
// ============================================================

describe("VectorSearchComparisonView の初期表示", () => {
  it("言語セレクターの初期選択が「日本語」、TopK の初期値が 30、倉庫の初期選択が「全倉庫」である", async () => {
    render(<VectorSearchComparisonView />);
    await flush();

    const language = screen.getByLabelText("検索言語") as HTMLSelectElement;
    expect(language.value).toBe("ja");
    expect(language.selectedOptions[0].textContent).toBe("日本語");
    // 選択肢は「日本語」「English」の 2 つのみ（要件 11.3）
    expect(Array.from(language.options).map((option) => option.textContent)).toEqual([
      "日本語",
      "English",
    ]);

    expect(topKInput().value).toBe("30");

    const warehouse = screen.getByLabelText("倉庫") as HTMLSelectElement;
    expect(warehouse.value).toBe("");
    expect(warehouse.selectedOptions[0].textContent).toBe("全倉庫");
    // 「全倉庫」に加えて WH-TOKYO を含む個別倉庫が選べる（要件 11.7）
    expect(Array.from(warehouse.options).map((option) => option.value)).toContain("WH-TOKYO");
  });

  it("クエリが空のあいだ検索ボタンは操作不可で、埋め込みも検索も呼ばれない", async () => {
    render(<VectorSearchComparisonView />);
    await flush();

    expect(searchButton()).toBeDisabled();

    fireEvent.change(queryInput(), { target: { value: "   " } });
    expect(searchButton()).toBeDisabled();

    fireEvent.change(queryInput(), { target: { value: "浅煎り" } });
    expect(searchButton()).not.toBeDisabled();

    expect(seam.requests.embed).toHaveLength(0);
    expect(seam.requests.dynamodb).toHaveLength(0);
    expect(seam.requests.opensearch).toHaveLength(0);
  });
});

// ============================================================
// ユニットテスト: 既存タブの不変性（要件 11.1, 11.24）
// ============================================================

describe("InventoryDashboard のタブ構成", () => {
  /**
   * `InventoryDashboard.tsx` はランタイム import に `@/` エイリアスを使っており
   * （`@/src/components/common/BrandIcon`）、`vitest.config.ts` に `@` の
   * `resolve.alias` が無いため、このコンポーネントはテスト環境で読み込めない。
   * `vi.mock` でも回避できない（エイリアス解決は vite の import 解析段階で失敗し、
   * モック登録より前に例外になる）。
   *
   * 既存 4 タブのラベルと順序が変わっていないことは本機能の要件（11.1 / 11.24）で
   * あり、検証を落とさないため、ここではタブ定義の**ソースを直接読んで**
   * 配列リテラルの順序とラベルを固定する。エイリアスを共有設定へ追加するか、
   * `InventoryDashboard.tsx` の import を相対パスへ直せば描画テストへ差し替えられる。
   */
  it("既存 4 タブのラベルと順序が変わっておらず、ベクトル検索比較タブが末尾に 1 件だけ追加されている", () => {
    const source = readFileSync(
      path.join(__dirname, "InventoryDashboard.tsx"),
      "utf8"
    );
    const arrayMatch = /const tabs: \{ key: Tab; label: string \}\[\] = \[([\s\S]*?)\];/.exec(source);
    expect(arrayMatch).not.toBeNull();

    const entries: { key: string; label: string }[] = [];
    const entryPattern = /\{\s*key:\s*"([^"]+)",\s*label:\s*"([^"]+)"\s*\}/g;
    let entry = entryPattern.exec(arrayMatch === null ? "" : arrayMatch[1]);
    while (entry !== null) {
      entries.push({ key: entry[1], label: entry[2] });
      entry = entryPattern.exec(arrayMatch === null ? "" : arrayMatch[1]);
    }

    expect(entries).toEqual([
      { key: "inventory", label: "在庫管理" },
      { key: "loadtest", label: "負荷テスト" },
      { key: "results", label: "結果ダッシュボード" },
      { key: "search", label: "検索比較" },
      { key: "vectorSearch", label: "ベクトル検索比較" },
    ]);
  });
});

// ============================================================
// Property 30
// ============================================================

// Feature: vector-search-comparison, Property 30: 無効入力時の結果状態の不変
// 任意の 無効な TopK 入力に対して、検索は開始されず、直前の検索結果状態
// （両パネルの結果・レイテンシ・エラー・使用言語）は変化しない。
describe("Property 30: 無効入力時の結果状態の不変", () => {
  const invalidTopKInput = fc.oneof(
    fc.integer({ min: -100, max: 0 }).map(String),
    fc.integer({ min: 101, max: 100_000 }).map(String),
    fc
      .double({ min: 0.01, max: 99.99, noNaN: true })
      .filter((value) => !Number.isInteger(value))
      .map((value) => value.toFixed(2)),
    fc.constantFrom("", " ", "abc", "1e2", "+5", "-0", "３０", "0x1F", "NaN", "Infinity", "10.0")
  );

  it("無効な TopK では検索が開始されず、直前の両パネルの表示が 1 文字も変わらない", async () => {
    await fc.assert(
      fc.asyncProperty(invalidTopKInput, async (raw) => {
        cleanup();
        resetSeam();

        const ddbHits = makeHits("DDB", 1);
        const aossHits = makeHits("AOSS", 1);
        seam.handlers.embed = () => Promise.resolve(embedResponse("ja", 11));
        seam.handlers.dynamodb = () => Promise.resolve(dynamodbResponse(ddbHits, 7));
        seam.handlers.opensearch = () => Promise.resolve(opensearchResponse(aossHits, 19));

        render(<VectorSearchComparisonView />);
        await flush();

        // 直前の検索結果を作る（有効な TopK 30 のまま）
        startSearch("フルーティーな浅煎り");
        await flush();

        const before = {
          dynamodb: textOf(panelOf("dynamodb")),
          opensearch: textOf(panelOf("opensearch")),
          embedCalls: seam.requests.embed.length,
          dynamodbCalls: seam.requests.dynamodb.length,
          opensearchCalls: seam.requests.opensearch.length,
        };
        // 前提: 直前の状態は「結果あり」である（不変性の観測対象が空でない）
        expect(before.dynamodb).toContain("DDB-ITEM-0");
        expect(before.opensearch).toContain("AOSS-ITEM-0");

        // 無効な TopK を入れて検索を試みる
        fireEvent.change(topKInput(), { target: { value: raw } });
        // `<input type="number">` は値を正規化するため、DOM に残った値で無効性を確認する
        fc.pre(!validateTopKInput(topKInput().value).ok);

        fireEvent.click(searchButton());
        await flush();

        // 検索は開始されない
        expect(seam.requests.embed).toHaveLength(before.embedCalls);
        expect(seam.requests.dynamodb).toHaveLength(before.dynamodbCalls);
        expect(seam.requests.opensearch).toHaveLength(before.opensearchCalls);

        // 両パネルの結果・レイテンシ・エラー・使用言語の表示は変化しない
        expect(textOf(panelOf("dynamodb"))).toBe(before.dynamodb);
        expect(textOf(panelOf("opensearch"))).toBe(before.opensearch);

        // 許容範囲を示すエラーが入力欄に出る（要件 11.6）
        expect(screen.getByRole("alert").textContent).toContain("1〜100 の整数");
      }),
      { numRuns: 100 }
    );
  });
});

// ============================================================
// Property 31
// ============================================================

type SideOutcome = { kind: "success"; hitCount: number } | { kind: "empty" } | { kind: "error" };

const sideOutcomeArb: fc.Arbitrary<SideOutcome> = fc.oneof(
  fc.integer({ min: 1, max: 4 }).map((hitCount) => ({ kind: "success" as const, hitCount })),
  fc.constant({ kind: "empty" as const }),
  fc.constant({ kind: "error" as const })
);

// Feature: vector-search-comparison, Property 31: パネルの独立性
// 任意の 両バックエンドの完了順序・遅延・成功/失敗/タイムアウトの組み合わせに対して、
// 各パネルの表示状態は自身のリクエスト結果のみで決まり、他方のパネルの結果・レイテンシ表示に
// 影響しない。片側が成功していれば、他方の失敗・タイムアウト・0 件にかかわらずその結果一覧と
// レイテンシが保持され、重なり指標のみが算出不可としてその理由とともに表示される。
describe("Property 31: パネルの独立性", () => {
  const DDB_LATENCY = 7;
  const AOSS_LATENCY = 823;

  it("完了順序と成功/失敗/0 件の任意の組み合わせで、各パネルは自身の結果のみを表示する", async () => {
    await fc.assert(
      fc.asyncProperty(
        sideOutcomeArb,
        sideOutcomeArb,
        fc.constantFrom<"dynamodb" | "opensearch">("dynamodb", "opensearch"),
        async (ddbOutcome, aossOutcome, firstResolved) => {
          cleanup();
          resetSeam();

          const ddbHits = ddbOutcome.kind === "success" ? makeHits("DDB", ddbOutcome.hitCount) : [];
          const aossHits =
            aossOutcome.kind === "success" ? makeHits("AOSS", aossOutcome.hitCount) : [];

          const ddbDeferreds: Deferred<unknown>[] = [];
          const aossDeferreds: Deferred<unknown>[] = [];
          seam.handlers.embed = () => Promise.resolve(embedResponse("en", 13));
          seam.handlers.dynamodb = deferredHandler(ddbDeferreds);
          seam.handlers.opensearch = deferredHandler(aossDeferreds);

          render(<VectorSearchComparisonView />);
          await flush();

          startSearch("nutty medium roast");
          await flush();

          expect(ddbDeferreds).toHaveLength(1);
          expect(aossDeferreds).toHaveLength(1);

          const settleDynamodb = async () => {
            await act(async () => {
              if (ddbOutcome.kind === "error") {
                ddbDeferreds[0].reject(dynamodbError());
              } else {
                ddbDeferreds[0].resolve(dynamodbResponse(ddbHits, DDB_LATENCY, "en"));
              }
              await Promise.resolve();
            });
          };
          const settleOpensearch = async () => {
            await act(async () => {
              if (aossOutcome.kind === "error") {
                aossDeferreds[0].reject(opensearchError());
              } else {
                aossDeferreds[0].resolve(opensearchResponse(aossHits, AOSS_LATENCY, "en"));
              }
              await Promise.resolve();
            });
          };

          // 片側だけが確定した中間状態でも、他方は自身の状態（検索中）のままである
          if (firstResolved === "dynamodb") {
            await settleDynamodb();
            expect(textOf(panelOf("opensearch"))).toContain("検索中");
            await settleOpensearch();
          } else {
            await settleOpensearch();
            expect(textOf(panelOf("dynamodb"))).toContain("検索中");
            await settleDynamodb();
          }
          await flush();

          const ddbPanel = panelOf("dynamodb");
          const aossPanel = panelOf("opensearch");
          const ddbText = textOf(ddbPanel);
          const aossText = textOf(aossPanel);

          // --- DynamoDB パネルは自身の結果のみで決まる ---
          if (ddbOutcome.kind === "error") {
            expect(ddbText).toContain(DYNAMODB_ERROR_CODE);
            expect(ddbText).toContain(DYNAMODB_ERROR_MESSAGE);
          } else {
            expect(metaValueOf(ddbPanel, "結果件数")).toBe(`${ddbHits.length} 件`);
            expect(metaValueOf(ddbPanel, "検索レイテンシ")).toBe(`${DDB_LATENCY} ms`);
            expect(metaValueOf(ddbPanel, "検索言語")).toBe("English");
            expect(hitRowCountOf(ddbPanel)).toBe(ddbHits.length);
            ddbHits.forEach((hit) => {
              expect(ddbText).toContain(hit.itemId);
            });
          }
          // 他方の結果・レイテンシ・エラーが混入しない
          expect(ddbText).not.toContain("AOSS-ITEM-");
          expect(ddbText).not.toContain(OPENSEARCH_ERROR_CODE);
          expect(ddbText).not.toContain(`${AOSS_LATENCY} ms`);

          // --- OpenSearch パネルは自身の結果のみで決まる ---
          if (aossOutcome.kind === "error") {
            expect(aossText).toContain(OPENSEARCH_ERROR_CODE);
            expect(aossText).toContain(OPENSEARCH_ERROR_MESSAGE);
          } else {
            expect(metaValueOf(aossPanel, "結果件数")).toBe(`${aossHits.length} 件`);
            expect(metaValueOf(aossPanel, "検索レイテンシ")).toBe(`${AOSS_LATENCY} ms`);
            expect(metaValueOf(aossPanel, "検索言語")).toBe("English");
            expect(hitRowCountOf(aossPanel)).toBe(aossHits.length);
            aossHits.forEach((hit) => {
              expect(aossText).toContain(hit.itemId);
            });
          }
          expect(aossText).not.toContain("DDB-ITEM-");
          expect(aossText).not.toContain(DYNAMODB_ERROR_CODE);
          expect(aossText).not.toContain(`${DDB_LATENCY} ms`);

          // --- 重なり指標のみが算出不可になる（要件 12.8） ---
          const overlapHeading = screen.getByRole("heading", { name: "結果の重なりと順位差" });
          const overlapSection = overlapHeading.closest("section");
          expect(overlapSection).not.toBeNull();
          const overlapText = overlapSection === null ? "" : (overlapSection.textContent ?? "");

          const ddbBlocked = ddbOutcome.kind !== "success";
          const aossBlocked = aossOutcome.kind !== "success";

          if (ddbBlocked || aossBlocked) {
            expect(overlapText).toContain("算出不可");
            if (ddbOutcome.kind === "error") {
              expect(overlapText).toContain("DynamoDB 側の検索がエラー終了");
            }
            if (ddbOutcome.kind === "empty") {
              expect(overlapText).toContain("DynamoDB 側の結果件数が 0 件");
            }
            if (aossOutcome.kind === "error") {
              expect(overlapText).toContain("OpenSearch 側の検索がエラー終了");
            }
            if (aossOutcome.kind === "empty") {
              expect(overlapText).toContain("OpenSearch 側の結果件数が 0 件");
            }
            // 正常終了した側の結果一覧は破棄されない
            if (ddbOutcome.kind === "success") {
              expect(overlapText).toContain("DynamoDB 側の結果一覧（保持）");
              expect(overlapText).toContain(ddbHits[0].itemId);
            }
            if (aossOutcome.kind === "success") {
              expect(overlapText).toContain("OpenSearch 側の結果一覧（保持）");
              expect(overlapText).toContain(aossHits[0].itemId);
            }
          } else {
            expect(overlapText).not.toContain("算出不可");
            expect(overlapText).toContain("共通アイテム数");
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("35 秒応答しない側だけがタイムアウト表示になり、他方の結果とレイテンシは保持される", async () => {
    vi.useFakeTimers();

    const ddbHits = makeHits("DDB", 2);
    seam.handlers.embed = () => Promise.resolve(embedResponse("ja", 21));
    seam.handlers.dynamodb = () => Promise.resolve(dynamodbResponse(ddbHits, 9));
    seam.handlers.opensearch = abortAwareNeverHandler();

    render(<VectorSearchComparisonView />);
    await flush();

    startSearch("チョコレートのような甘み");
    await flush();

    expect(textOf(panelOf("dynamodb"))).toContain("DDB-ITEM-0");
    expect(textOf(panelOf("opensearch"))).toContain("検索中");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(VECTOR_TIMEOUT_MS);
    });
    await flush();

    const aossPanel = panelOf("opensearch");
    expect(textOf(aossPanel)).toContain(OPENSEARCH_ERROR_CODE);
    expect(textOf(aossPanel)).toContain("35 秒以内に応答がありませんでした");

    // 他方のパネルの結果表示とレイテンシ表示は保持される（要件 11.23）
    const ddbPanel = panelOf("dynamodb");
    expect(hitRowCountOf(ddbPanel)).toBe(2);
    expect(metaValueOf(ddbPanel, "検索レイテンシ")).toBe("9 ms");
    expect(metaValueOf(ddbPanel, "結果件数")).toBe("2 件");
    expect(textOf(ddbPanel)).not.toContain(OPENSEARCH_ERROR_CODE);
  });
});

// ============================================================
// Property 32
// ============================================================

// Feature: vector-search-comparison, Property 32: 競合検索の最終一貫性
// 任意の 検索開始の列（1 回以上）と任意の 応答到着順序（順不同・遅延あり）に対して、
// 最終的な表示状態は最後に開始した検索の結果と等しく、それ以前に開始した検索の応答は
// 表示に反映されない。
describe("Property 32: 競合検索の最終一貫性", () => {
  /**
   * 検索開始の列と、各検索における 2 本の応答の到着順序（true なら DynamoDB 側が先着）。
   *
   * 到達可能な操作列に限定している点を明示しておく。検索ボタンは実行中に操作不可になる
   * ため（要件 11.10）、画面操作からは「前の検索の応答が未着のまま次の検索を開始する」
   * 状態を作れない。実装は `AbortController` と `requestSeq` の二重化で古い応答を捨てるが、
   * 前者が先に効くため後者の分岐は画面操作から到達しない。したがって本 property は
   * 「到達可能な検索開始の列と任意の応答到着順序において、最終表示が最後に開始した検索の
   * 結果と等しく、それ以前の検索の応答が表示に残らない」ことを検証する。
   * 中断（`AbortController`）が働く経路は Property 31 のタイムアウト例で観測している。
   */
  const arrivalOrdersArb = fc.array(fc.boolean(), { minLength: 1, maxLength: 3 });

  it("応答が順不同に届く検索を繰り返しても、最後に開始した検索の結果だけが表示される", async () => {
    await fc.assert(
      fc.asyncProperty(arrivalOrdersArb, async (arrivalOrders) => {
        cleanup();
        resetSeam();

        const searchCount = arrivalOrders.length;
        const embedDeferreds: Deferred<unknown>[] = [];
        const ddbDeferreds: Deferred<unknown>[] = [];
        const aossDeferreds: Deferred<unknown>[] = [];
        seam.handlers.embed = deferredHandler(embedDeferreds);
        seam.handlers.dynamodb = deferredHandler(ddbDeferreds);
        seam.handlers.opensearch = deferredHandler(aossDeferreds);

        render(<VectorSearchComparisonView />);
        await flush();

        for (let index = 0; index < searchCount; index += 1) {
          startSearch(`query-${index}`);
          await flush();

          // 新しい検索を開始した時点で、直前の検索の結果は表示から消えている
          if (index > 0) {
            const previous = `S${index - 1}-ITEM-`;
            const previousOpensearch = `S${index - 1}O-ITEM-`;
            expect(textOf(panelOf("dynamodb"))).not.toContain(previous);
            expect(textOf(panelOf("opensearch"))).not.toContain(previousOpensearch);
            expect(textOf(panelOf("dynamodb"))).toContain("検索中");
            expect(textOf(panelOf("opensearch"))).toContain("検索中");
          }

          await act(async () => {
            embedDeferreds[index].resolve(embedResponse(index % 2 === 0 ? "ja" : "en", 30 + index));
            await Promise.resolve();
          });
          await flush();
          expect(ddbDeferreds).toHaveLength(index + 1);
          expect(aossDeferreds).toHaveLength(index + 1);

          const language: VectorLanguage = index % 2 === 0 ? "ja" : "en";
          const settleDynamodb = async () => {
            await act(async () => {
              ddbDeferreds[index].resolve(
                dynamodbResponse(makeHits(`S${index}`, 3), 10 + index, language)
              );
              await Promise.resolve();
            });
          };
          const settleOpensearch = async () => {
            await act(async () => {
              aossDeferreds[index].resolve(
                opensearchResponse(makeHits(`S${index}O`, 2), 200 + index, language)
              );
              await Promise.resolve();
            });
          };

          // 応答到着順序は任意
          if (arrivalOrders[index]) {
            await settleDynamodb();
            await settleOpensearch();
          } else {
            await settleOpensearch();
            await settleDynamodb();
          }
          await flush();
        }

        const lastIndex = searchCount - 1;
        const expectedLanguageLabel = lastIndex % 2 === 0 ? "日本語" : "English";
        const ddbPanel = panelOf("dynamodb");
        const aossPanel = panelOf("opensearch");
        const ddbText = textOf(ddbPanel);
        const aossText = textOf(aossPanel);

        // 最終的な表示状態は最後に開始した検索の結果と等しい
        expect(ddbText).toContain(`S${lastIndex}-ITEM-0`);
        expect(metaValueOf(ddbPanel, "検索レイテンシ")).toBe(`${10 + lastIndex} ms`);
        expect(metaValueOf(ddbPanel, "結果件数")).toBe("3 件");
        expect(hitRowCountOf(ddbPanel)).toBe(3);
        expect(metaValueOf(ddbPanel, "検索言語")).toBe(expectedLanguageLabel);

        expect(aossText).toContain(`S${lastIndex}O-ITEM-0`);
        expect(metaValueOf(aossPanel, "検索レイテンシ")).toBe(`${200 + lastIndex} ms`);
        expect(metaValueOf(aossPanel, "結果件数")).toBe("2 件");
        expect(hitRowCountOf(aossPanel)).toBe(2);
        expect(metaValueOf(aossPanel, "検索言語")).toBe(expectedLanguageLabel);

        // それ以前に開始した検索の応答は表示に反映されない
        for (let index = 0; index < lastIndex; index += 1) {
          expect(ddbText).not.toContain(`S${index}-ITEM-`);
          expect(ddbText).not.toContain(`${10 + index} ms`);
          expect(aossText).not.toContain(`S${index}O-ITEM-`);
          expect(aossText).not.toContain(`${200 + index} ms`);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("打ち切り後に再開した検索では、打ち切られた側のエラー表示が新しい結果に置き換わる", async () => {
    vi.useFakeTimers();

    const aossDeferreds: Deferred<unknown>[] = [];
    seam.handlers.embed = () => Promise.resolve(embedResponse("ja", 21));
    seam.handlers.dynamodb = () => Promise.resolve(dynamodbResponse(makeHits("FIRST", 1), 9));
    seam.handlers.opensearch = abortAwareNeverHandler();

    render(<VectorSearchComparisonView />);
    await flush();

    startSearch("最初のクエリ");
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VECTOR_TIMEOUT_MS);
    });
    await flush();
    expect(textOf(panelOf("opensearch"))).toContain(OPENSEARCH_ERROR_CODE);
    expect(searchButton()).not.toBeDisabled();

    // 2 回目の検索。OpenSearch 側は解決可能なハンドラに差し替える
    seam.handlers.dynamodb = () => Promise.resolve(dynamodbResponse(makeHits("SECOND", 2), 11));
    seam.handlers.opensearch = deferredHandler(aossDeferreds);
    startSearch("2 回目のクエリ");
    await flush();
    await act(async () => {
      aossDeferreds[0].resolve(opensearchResponse(makeHits("SECONDO", 1), 33));
      await Promise.resolve();
    });
    await flush();

    const ddbPanel = panelOf("dynamodb");
    const aossPanel = panelOf("opensearch");
    expect(textOf(ddbPanel)).toContain("SECOND-ITEM-0");
    expect(textOf(ddbPanel)).not.toContain("FIRST-ITEM-0");
    expect(textOf(aossPanel)).toContain("SECONDO-ITEM-0");
    expect(textOf(aossPanel)).not.toContain(OPENSEARCH_ERROR_CODE);
    expect(textOf(aossPanel)).not.toContain("35 秒以内に応答がありませんでした");
  });
});

// ============================================================
// Property 54
// ============================================================

type UiState =
  | "idle"
  | "searching"
  | "bothSucceeded"
  | "dynamodbErrorOnly"
  | "bothErrored"
  | "bothEmpty";

// Feature: vector-search-comparison, Property 54: 制約比較表と注意書きの常時表示
// 任意の UI 状態（未実行・実行中・成功・片側エラー・両側エラー・結果 0 件）に対して、
// 機能制約比較表と埋め込み言語サポートの注意書き（正式サポート言語、プレビュー扱いの記述、
// 日英 2 本の独立生成による言語別測定の実施、両バックエンドが同一ベクトルを使うため比較の
// 公平性が保たれる旨）は常に描画される。
describe("Property 54: 制約比較表と注意書きの常時表示", () => {
  const CONSTRAINT_ROW_LABELS = [
    "TopK 上限",
    "対応フィルタ種別",
    "範囲フィルタ（大小比較・BETWEEN）",
    "ベクトル次元数の上限",
    "距離関数",
    "距離関数の変更",
    "オンデマンド課金",
    "Query / Scan / PartiQL による読み取り",
    "全文検索との併用",
    "集約",
    "地理空間クエリ",
    "ネストクエリ",
  ];

  it("未実行・実行中・成功・片側エラー・両側エラー・0 件のいずれでも表と注意書きが描画される", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<UiState>(
          "idle",
          "searching",
          "bothSucceeded",
          "dynamodbErrorOnly",
          "bothErrored",
          "bothEmpty"
        ),
        async (uiState) => {
          cleanup();
          resetSeam();

          const ddbDeferreds: Deferred<unknown>[] = [];
          const aossDeferreds: Deferred<unknown>[] = [];
          seam.handlers.embed = () => Promise.resolve(embedResponse("ja", 17));
          seam.handlers.dynamodb = deferredHandler(ddbDeferreds);
          seam.handlers.opensearch = deferredHandler(aossDeferreds);

          render(<VectorSearchComparisonView />);
          await flush();

          if (uiState !== "idle") {
            startSearch("酸味のあるエチオピア");
            await flush();

            if (uiState !== "searching") {
              await act(async () => {
                if (uiState === "bothSucceeded") {
                  ddbDeferreds[0].resolve(dynamodbResponse(makeHits("DDB", 2), 8));
                  aossDeferreds[0].resolve(opensearchResponse(makeHits("AOSS", 2), 90));
                } else if (uiState === "dynamodbErrorOnly") {
                  ddbDeferreds[0].reject(dynamodbError());
                  aossDeferreds[0].resolve(opensearchResponse(makeHits("AOSS", 2), 90));
                } else if (uiState === "bothErrored") {
                  ddbDeferreds[0].reject(dynamodbError());
                  aossDeferreds[0].reject(opensearchError());
                } else {
                  ddbDeferreds[0].resolve(dynamodbResponse([], 8));
                  aossDeferreds[0].resolve(opensearchResponse([], 90));
                }
                await Promise.resolve();
              });
              await flush();
            }
          }

          // 機能制約比較表が描画されている（要件 15.1）
          const tableHeading = screen.getByRole("heading", { name: "機能制約の比較" });
          const constraintSection = tableHeading.closest("section");
          expect(constraintSection).not.toBeNull();
          const constraintScope = within(constraintSection as HTMLElement);

          CONSTRAINT_ROW_LABELS.forEach((label) => {
            expect(constraintScope.getByRole("rowheader", { name: label })).toBeTruthy();
          });
          // 見出しセルを持つ表構造（要件 15.8）
          expect(constraintScope.getAllByRole("columnheader")).toHaveLength(3);

          // 埋め込み言語サポートの注意書きが描画されている（要件 15.5）
          expect(
            constraintScope.getByRole("heading", { name: "埋め込み言語サポートに関する注意" })
          ).toBeTruthy();
          const constraintText = (constraintSection as HTMLElement).textContent ?? "";
          expect(constraintText).toContain(EMBEDDING_NOTICE.officiallySupportedLanguages);
          expect(constraintText).toContain(EMBEDDING_NOTICE.previewLanguagesNote);
          expect(constraintText).toContain(EMBEDDING_NOTICE.bilingualMeasurementNote);
          expect(constraintText).toContain(EMBEDDING_NOTICE.fairnessNote);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ============================================================
// Property 57
// ============================================================

const hitSeedsArb = fc.array(
  fc.record({
    distance: fc.double({ min: 0, max: 2, noNaN: true }),
    rawScore: fc.double({ min: -1, max: 1, noNaN: true }),
    quantity: fc.integer({ min: 0, max: 9_999 }),
    unitPrice: fc.integer({ min: 0, max: 99_999 }),
  }),
  { maxLength: 6 }
);

// Feature: vector-search-comparison, Property 57: 結果表示の網羅性
// 任意の 検索結果配列に対して、パネルに描画される結果行数は配列長と等しく、表示される件数の
// 数値も配列長と等しく、全件のスコアが描画され、検索に使用した言語が各パネルに表示される。
describe("Property 57: 結果表示の網羅性", () => {
  it("両パネルの結果行数・件数表示・全件のスコア・使用言語が応答と一致する", async () => {
    await fc.assert(
      fc.asyncProperty(
        hitSeedsArb,
        hitSeedsArb,
        fc.constantFrom<VectorLanguage>("ja", "en"),
        async (ddbSeeds, aossSeeds, language) => {
          cleanup();
          resetSeam();

          const ddbHits = buildHits("DDB", ddbSeeds);
          const aossHits = buildHits("AOSS", aossSeeds);

          seam.handlers.embed = () => Promise.resolve(embedResponse(language, 15));
          seam.handlers.dynamodb = () => Promise.resolve(dynamodbResponse(ddbHits, 4, language));
          seam.handlers.opensearch = () =>
            Promise.resolve(opensearchResponse(aossHits, 77, language));

          render(<VectorSearchComparisonView />);
          await flush();

          startSearch("任意のクエリ");
          await flush();

          const expectedLanguageLabel = language === "ja" ? "日本語" : "English";
          const cases: { backend: "dynamodb" | "opensearch"; hits: VectorSearchHit[] }[] = [
            { backend: "dynamodb", hits: ddbHits },
            { backend: "opensearch", hits: aossHits },
          ];

          cases.forEach(({ backend, hits }) => {
            const panel = panelOf(backend);
            const panelText = textOf(panel);

            // 描画される結果行数は配列長と等しい
            expect(hitRowCountOf(panel)).toBe(hits.length);
            // 表示される件数の数値も配列長と等しい
            expect(metaValueOf(panel, "結果件数")).toBe(`${hits.length} 件`);
            // 検索に使用した言語が各パネルに表示される
            expect(metaValueOf(panel, "検索言語")).toBe(expectedLanguageLabel);
            // 全件のスコア（生スコアと正規化距離）が描画される
            hits.forEach((hit) => {
              expect(panelText).toContain(hit.rawScore.toFixed(6));
              expect(panelText).toContain(hit.distance.toFixed(4));
              expect(panelText).toContain(hit.itemId);
            });
          });
        }
      ),
      { numRuns: 100 }
    );
  });
});
