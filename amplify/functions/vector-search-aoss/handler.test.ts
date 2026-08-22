/**
 * OpenSearch_Vector_Lambda（`vector-search-aoss/handler.ts`）の property テスト（task 8.8）
 *
 * 検証対象は Correctness Property 18（言語ルーティングの排他性、OpenSearch 側）、
 * 22（応答へのベクトル非漏洩、OpenSearch 側）、24（結果の順序・順位・件数の不変条件）、
 * 26（knn クエリ DSL の構造）、27（レイテンシ区間の包含関係）。
 *
 * ## モックの境界
 *
 * AWS への実呼び出しは行わない。差し替えるのは次の 4 点のみである。
 *
 * - `@opensearch-project/opensearch`: `Client.search()` / `Client.count()` を記録するスタブ。
 *   **構築されたクエリ DSL の観測点**であり、Property 18 / 26 はここで判定する
 * - `@opensearch-project/opensearch/aws`: `AwsSigv4Signer` を無効化する（署名器を作らない）
 * - `@aws-sdk/credential-provider-node`: 資格情報チェーンの解決を起こさない
 * - `@aws-sdk/client-dynamodb`: Query_Vector_Cache の `GetItem` を返すスタブ。
 *   `unmarshall` は実物を使うため、アイテムの形はそのまま観測できる
 *
 * `handler.ts` はモジュール読み込み時にエンドポイントとインデックス名を確定するため、
 * 環境変数を設定したうえで **動的 import** する。
 *
 * 要件: 9.1, 9.2, 9.3, 9.4, 9.8, 9.11, 16.2
 * Property: 18, 22, 24, 26, 27
 */

import fc from 'fast-check';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

/**
 * 仮想時計。`Date.now()` を差し替えたときのみ読まれる（Property 27 の擬似所要時間の注入）。
 * 実時刻から始めることで、キャッシュアイテムの `expiresAt` 判定が
 * 仮想時計側・実時計側のどちらから読まれても失効扱いにならない。
 */
const clock = vi.hoisted(() => ({ nowMs: Date.now() }));

/** モックとテスト本体で共有する記録簿と応答の差し替え口 */
const seam = vi.hoisted(() => ({
  /** `GetItem`（Query_Vector_Cache）が返すアイテム。`undefined` は失効を表す */
  cacheItem: undefined as Record<string, unknown> | undefined,
  /** `_search` が返すヒット（呼び出し順に払い出す） */
  searchHits: [] as { _id?: string; _score?: number; _source?: Record<string, unknown> }[],
  /** `took`（OpenSearch のサーバー側所要 ms） */
  took: 3,
  /** `_count` が返す登録ドキュメント数 */
  documentCount: 100,
  /** 各下流呼び出しが消費する擬似所要時間（ms） */
  durations: { getItemMs: 0, searchMs: 0 },
  /** `client.search()` へ渡された引数（呼び出し順） */
  searchParams: [] as Record<string, unknown>[],
  /** `client.count()` の呼び出し回数 */
  countCalls: 0,
}));

vi.mock('@opensearch-project/opensearch', () => {
  class Client {
    constructor(readonly options: unknown) {}

    async search(params: Record<string, unknown>): Promise<{ body: Record<string, unknown> }> {
      seam.searchParams.push(params);
      clock.nowMs += seam.durations.searchMs;
      return { body: { took: seam.took, hits: { hits: seam.searchHits } } };
    }

    async count(): Promise<{ body: { count: number } }> {
      seam.countCalls += 1;
      return { body: { count: seam.documentCount } };
    }
  }

  return { Client };
});

vi.mock('@opensearch-project/opensearch/aws', () => ({
  AwsSigv4Signer: () => ({}),
}));

vi.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: () => () => Promise.resolve({ accessKeyId: 'ak', secretAccessKey: 'sk' }),
}));

vi.mock('@aws-sdk/client-dynamodb', () => {
  class GetItemCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }

  class DynamoDBClient {
    readonly config = { credentials: () => Promise.resolve({ accessKeyId: 'ak', secretAccessKey: 'sk' }) };

    async send(): Promise<Record<string, unknown>> {
      clock.nowMs += seam.durations.getItemMs;
      return seam.cacheItem === undefined ? {} : { Item: seam.cacheItem };
    }
  }

  return { DynamoDBClient, GetItemCommand };
});

// ---------------------------------------------------------------------------
// 実行環境（動的 import より前に確定させる）
// ---------------------------------------------------------------------------

/** クエリベクトルの次元数。OpenSearch 側のハンドラは次元数を検査しないため小さい値でよい */
const DIMENSIONS = 4;

const INDEX_NAME = 'inventory-vector';

process.env.AWS_REGION = 'ap-northeast-1';
process.env.OPENSEARCH_VECTOR_ENDPOINT = 'https://vector.test.invalid';
process.env.VECTOR_INDEX_NAME = INDEX_NAME;
process.env.QUERY_CACHE_TABLE_NAME = 'test-vector-query-cache';

let handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;

beforeAll(async () => {
  ({ handler } = await import('./handler'));
});

beforeEach(() => {
  resetSeam();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function defaultVector(): number[] {
  return Array.from({ length: DIMENSIONS }, (_, index) => (index + 1) / DIMENSIONS);
}

/** 各 property 反復の冒頭で実行環境を初期化する */
function resetSeam(options: { language?: 'ja' | 'en' } = {}): void {
  seam.searchParams.length = 0;
  seam.countCalls = 0;
  seam.searchHits = [];
  seam.took = 3;
  seam.documentCount = 100;
  seam.durations = { getItemMs: 0, searchMs: 0 };
  seam.cacheItem = marshall({
    queryId: 'q-1',
    vector: defaultVector(),
    language: options.language ?? 'ja',
    expiresAt: Math.floor(clock.nowMs / 1000) + 3_600,
  });
}

/** ハンドラが読むのは `body` のみ */
function searchEvent(payload: unknown): APIGatewayProxyEvent {
  return { body: JSON.stringify(payload) } as unknown as APIGatewayProxyEvent;
}

function parseBody(result: APIGatewayProxyResult): Record<string, unknown> {
  return JSON.parse(result.body) as Record<string, unknown>;
}

/** `_source` に両言語のベクトルを混ぜたヒット 1 件 */
function openSearchHit(options: { itemId: string; score: number; withVectors?: boolean }): {
  _id: string;
  _score: number;
  _source: Record<string, unknown>;
} {
  const vector = defaultVector();

  return {
    _id: `${options.itemId}#WH-TOKYO`,
    _score: options.score,
    _source: {
      itemId: options.itemId,
      warehouseId: 'WH-TOKYO',
      productNameJa: `商品 ${options.itemId}`,
      productNameEn: `Item ${options.itemId}`,
      categoryJa: 'コーヒー豆',
      categoryEn: 'Coffee Beans',
      quantity: 10,
      location: 'A-01',
      unitPrice: 1200,
      ...(options.withVectors === true ? { embeddingJa: vector, embeddingEn: vector } : {}),
    },
  };
}

/** ベクトル本体らしい配列（次元数と同じ長さの数値配列）を再帰的に集める（Property 22） */
function findVectorLikeArrays(value: unknown): unknown[][] {
  if (Array.isArray(value)) {
    const isVectorLike = value.length === DIMENSIONS && value.every((element) => typeof element === 'number');
    return isVectorLike ? [value] : value.flatMap((element) => findVectorLikeArrays(element));
  }

  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap((element) => findVectorLikeArrays(element));
  }

  return [];
}

/** 記録された `client.search()` 引数から knn ノードを取り出す */
function knnNode(params: Record<string, unknown> | undefined): {
  field: string;
  node: Record<string, unknown>;
  requestBody: Record<string, unknown>;
} {
  const requestBody = (params?.body ?? {}) as Record<string, unknown>;
  const query = (requestBody.query ?? {}) as Record<string, unknown>;
  const knn = (query.knn ?? {}) as Record<string, unknown>;
  const fields = Object.keys(knn);

  expect(fields).toHaveLength(1);

  return { field: fields[0], node: knn[fields[0]] as Record<string, unknown>, requestBody };
}

const languageArb = fc.constantFrom<'ja' | 'en'>('ja', 'en');

// ---------------------------------------------------------------------------
// Property 18: 言語ルーティングの排他性（OpenSearch 側）
// ---------------------------------------------------------------------------

describe('vector-search-aoss handler / 言語ルーティング', () => {
  // Feature: vector-search-comparison, Property 18: 任意の言語指定に対して、
  // OpenSearch_Vector_Lambda が指定する `knn_vector` フィールドは当該言語に対応する 1 つであり、
  // いずれの呼び出し引数にも他方の言語のフィールド名が現れない。
  //
  // 例外は `_source.excludes` である。要件 9.1 は**両言語のベクトルを応答から除外する**ことを
  // 求めるため、除外指定には意図的に両方の名前が現れる。したがって排他性はクエリ DSL
  // （`body.query`）に対して判定する。
  // **Validates: Requirements 3.2, 8.1, 8.2, 9.2, 11.4**
  it('検索対象フィールドが当該言語の 1 つだけで、クエリ DSL に他方の言語が現れない', async () => {
    await fc.assert(
      fc.asyncProperty(languageArb, fc.integer({ min: 1, max: 20 }), async (language, topK) => {
        resetSeam({ language });
        seam.searchHits = [openSearchHit({ itemId: 'SKU-1', score: 0.9, withVectors: true })];

        const result = await handler(searchEvent({ queryId: 'q-1', topK }));
        const body = parseBody(result);

        expect(result.statusCode).toBe(200);
        expect(seam.searchParams).toHaveLength(1);

        const expected = language === 'ja' ? 'embeddingJa' : 'embeddingEn';
        const other = language === 'ja' ? 'embeddingEn' : 'embeddingJa';

        const { field, requestBody } = knnNode(seam.searchParams[0]);
        expect(field).toBe(expected);
        expect(body.vectorField).toBe(expected);
        expect(body.language).toBe(language);

        // クエリ DSL に他方の言語のフィールド名が現れない
        const serializedQuery = JSON.stringify(requestBody.query);
        expect(serializedQuery).toContain(expected);
        expect(serializedQuery).not.toContain(other);
      }),
      { numRuns: 30 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 26: knn クエリ DSL の構造
// ---------------------------------------------------------------------------

describe('vector-search-aoss handler / クエリ DSL の構造', () => {
  // Feature: vector-search-comparison, Property 26: 任意の倉庫指定の有無に対して、
  // 構築されたクエリ DSL では倉庫フィルタが knn ノードの `filter` 句配下に配置され、
  // 後段フィルタ（`post_filter`）は存在しない。倉庫未指定の場合はフィルタ句自体が存在しない。
  // **Validates: Requirements 9.4**
  it('倉庫フィルタは knn ノードの filter 句配下にのみ置かれ、post_filter を使わない', async () => {
    const warehouseIdArb = fc.option(fc.constantFrom('WH-TOKYO', 'WH-OSAKA', 'WH-FUKUOKA'), {
      nil: undefined,
    });

    await fc.assert(
      fc.asyncProperty(warehouseIdArb, languageArb, fc.integer({ min: 1, max: 20 }), async (warehouseId, language, topK) => {
        resetSeam({ language });
        seam.searchHits = [openSearchHit({ itemId: 'SKU-1', score: 0.9 })];

        const result = await handler(
          searchEvent({ queryId: 'q-1', topK, ...(warehouseId === undefined ? {} : { warehouseId }) })
        );

        expect(result.statusCode).toBe(200);
        expect(seam.searchParams).toHaveLength(1);

        const params = seam.searchParams[0];
        const { node } = knnNode(params);

        // 後段フィルタは引数のどこにも現れない
        expect(JSON.stringify(params)).not.toContain('post_filter');

        if (warehouseId === undefined) {
          // 倉庫未指定ならフィルタ句自体が存在しない
          expect('filter' in node).toBe(false);
          expect(parseBody(result).filterApplied).toEqual([]);
          return;
        }

        // 倉庫指定時は knn ノードの `filter` 句配下に `term` として置かれる。
        // マッピングが keyword 型のため `.keyword` サブフィールドは付けない
        expect(node.filter).toEqual({ bool: { filter: [{ term: { warehouseId } }] } });
        expect(JSON.stringify(node.filter)).not.toContain('.keyword');
        expect(parseBody(result).filterApplied).toEqual(['warehouseId']);
      }),
      { numRuns: 40 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 22: 応答へのベクトル非漏洩（OpenSearch 側）
// ---------------------------------------------------------------------------

describe('vector-search-aoss handler / 応答へのベクトル非漏洩', () => {
  // Feature: vector-search-comparison, Property 22: 任意の内部検索結果（両言語のベクトル属性を含む）と
  // 任意のクエリベクトルに対して、OpenSearch 検索エンドポイントの応答に日本語ベクトルおよび
  // 英語ベクトルの属性名と本体（次元数と同じ長さの数値配列）が現れない。
  // **Validates: Requirements 8.8, 9.1, 10.3**
  it('_source から両言語を除外し、応答に属性名も数値配列も現れない', async () => {
    await fc.assert(
      fc.asyncProperty(languageArb, fc.integer({ min: 1, max: 8 }), async (language, hitCount) => {
        resetSeam({ language });
        seam.searchHits = Array.from({ length: hitCount }, (_, index) =>
          openSearchHit({ itemId: `SKU-${index}`, score: 1 - index / 100, withVectors: true })
        );

        const result = await handler(searchEvent({ queryId: 'q-1', topK: 20 }));
        const body = parseBody(result);

        expect(result.statusCode).toBe(200);

        // 検索要求の時点で両言語のベクトルを `_source` から除外している（要件 9.1）
        const { requestBody } = knnNode(seam.searchParams[0]);
        const excludes = (requestBody._source as { excludes?: string[] } | undefined)?.excludes ?? [];
        expect(excludes).toContain('embeddingJa');
        expect(excludes).toContain('embeddingEn');

        // どのヒットもベクトル属性を持たない。
        // なお応答の `vectorField` は検索対象フィールド名のメタデータ（1 個の文字列）であり、
        // ベクトル本体ではないため、判定はヒットのキーと配列の有無に対して行う
        const hits = body.hits as Record<string, unknown>[];
        expect(hits).toHaveLength(hitCount);
        for (const hit of hits) {
          expect('embeddingJa' in hit).toBe(false);
          expect('embeddingEn' in hit).toBe(false);
          for (const value of Object.values(hit)) {
            expect(Array.isArray(value)).toBe(false);
          }
        }

        // 属性名を変えて載せた場合も検出できるよう、ベクトル本体が無いことを再帰的に確かめる
        expect(findVectorLikeArrays(body)).toEqual([]);
      }),
      { numRuns: 30 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 24: 結果の順序・順位・件数の不変条件
// ---------------------------------------------------------------------------

describe('vector-search-aoss handler / 結果の不変条件', () => {
  // Feature: vector-search-comparison, Property 24: 任意の検索結果集合と任意の適用 TopK に対して、
  // 返却される結果は距離の昇順に並び、`rank` は 1 から返却件数までの連番であり、
  // 返却件数は 0 以上かつ適用 TopK 以下である。返却件数が適用 TopK 未満でもエラーにならず、
  // 要求 TopK と返却件数の両方が応答に含まれる。
  //
  // OpenSearch は `_score` の降順でヒットを返す。正規化距離はスコアの単調減少関数なので、
  // 降順スコア列を与えると距離は昇順になる（Property 25 の順序保存を前提とする）。
  // **Validates: Requirements 8.9, 8.10, 9.11**
  it('距離昇順・1 起点の連番・件数が適用 TopK 以下になる', async () => {
    /** 適用 TopK と、その件数を超えない降順スコア列 */
    const resultsArb = fc.integer({ min: 1, max: 20 }).chain((topK) =>
      fc.tuple(
        fc.constant(topK),
        fc
          .array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 0, maxLength: topK })
          .map((scores) => [...scores].sort((a, b) => b - a))
      )
    );

    await fc.assert(
      fc.asyncProperty(resultsArb, languageArb, async ([topK, scores], language) => {
        resetSeam({ language });
        seam.searchHits = scores.map((score, index) => openSearchHit({ itemId: `SKU-${index}`, score }));

        const result = await handler(searchEvent({ queryId: 'q-1', topK }));
        const body = parseBody(result);

        // 0 件・TopK 未満でもエラーにしない
        expect(result.statusCode).toBe(200);

        const hits = body.hits as { rank: number; distance: number; rawScore: number }[];

        // 距離の昇順
        for (let index = 1; index < hits.length; index += 1) {
          expect(hits[index].distance).toBeGreaterThanOrEqual(hits[index - 1].distance);
        }

        // rank は 1 から返却件数までの連番
        expect(hits.map((hit) => hit.rank)).toEqual(Array.from({ length: hits.length }, (_, index) => index + 1));

        // 件数は 0 以上かつ適用 TopK 以下
        expect(body.returnedCount).toBe(hits.length);
        expect(body.returnedCount as number).toBeGreaterThanOrEqual(0);
        expect(body.returnedCount as number).toBeLessThanOrEqual(body.appliedTopK as number);

        // 要求 TopK と返却件数の両方が応答に含まれる
        expect(body.requestedTopK).toBe(topK);
        expect(body.appliedTopK).toBe(topK);
        expect(body.distanceSemantics).toBe('lower_is_closer');

        // 生スコアは入力と等しい値のまま保持される
        expect(hits.map((hit) => hit.rawScore)).toEqual(scores);

        // TopK 未満のときは注記が付く（要件 9.11）
        if (hits.length > 0 && hits.length < topK) {
          expect(typeof body.insufficientNeighborsNote).toBe('string');
        }
      }),
      { numRuns: 60 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 27: レイテンシ区間の包含関係
// ---------------------------------------------------------------------------

describe('vector-search-aoss handler / レイテンシ区間', () => {
  // Feature: vector-search-comparison, Property 27: 任意の擬似所要時間の注入に対して、
  // 検索区間レイテンシはハンドラ全体区間レイテンシ以下であり、両者はともに 0 以上の整数である。
  // 擬似所要時間は `GetItem` / `_search` の各スタブが仮想時計を進めることで注入する。
  // **Validates: Requirements 8.12, 9.8**
  it('searchLatencyMs が handlerLatencyMs 以下で、いずれも 0 以上の整数になる', async () => {
    const durationArb = fc.integer({ min: 0, max: 5_000 });

    await fc.assert(
      fc.asyncProperty(durationArb, durationArb, languageArb, async (getItemMs, searchMs, language) => {
        resetSeam({ language });
        seam.durations = { getItemMs, searchMs };
        // 0 件だと診断用の追加問い合わせが走り区間が増えるため、1 件は返す
        seam.searchHits = [openSearchHit({ itemId: 'SKU-1', score: 0.9 })];

        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock.nowMs);

        try {
          const result = await handler(searchEvent({ queryId: 'q-1', topK: 1 }));
          const body = parseBody(result);

          expect(result.statusCode).toBe(200);

          const searchLatencyMs = body.searchLatencyMs as number;
          const handlerLatencyMs = body.handlerLatencyMs as number;

          expect(Number.isInteger(searchLatencyMs)).toBe(true);
          expect(Number.isInteger(handlerLatencyMs)).toBe(true);
          expect(searchLatencyMs).toBeGreaterThanOrEqual(0);
          expect(handlerLatencyMs).toBeGreaterThanOrEqual(0);

          // 検索区間はハンドラ全体区間に含まれる
          expect(searchLatencyMs).toBeLessThanOrEqual(handlerLatencyMs);

          // 注入した所要時間がそのまま区間として観測される
          expect(searchLatencyMs).toBe(searchMs);
          expect(handlerLatencyMs).toBe(getItemMs + searchMs);
        } finally {
          nowSpy.mockRestore();
        }
      }),
      { numRuns: 60 }
    );
  });
});
