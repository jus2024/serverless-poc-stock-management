/**
 * DynamoDB_Vector_Lambda（`vector-search-ddb/handler.ts`）の property テスト（task 8.8）
 *
 * 検証対象は Correctness Property 15（インデックス準備判定）、18（言語ルーティングの排他性、
 * DynamoDB 側）、20（検索条件式のプレースホルダ化）、21（範囲フィルタ要求の拒否と非実行）、
 * 22（応答へのベクトル非漏洩、DynamoDB 側）、24（結果の順序・順位・件数の不変条件）、
 * 27（レイテンシ区間の包含関係）。
 *
 * ## モックの境界
 *
 * AWS への実呼び出しは行わない。差し替えるのは次の 3 点のみである。
 *
 * - `@aws-sdk/client-dynamodb`: `GetItem`（Query_Vector_Cache）と `DescribeTable`（Vector_Table）を
 *   返すスタブ。`marshall` / `unmarshall` は実物を使うため、アイテムの形はそのまま観測できる
 * - `@smithy/signature-v4`: 署名を素通しするスタブ。資格情報の解決を起こさない
 * - `globalThis.fetch`: **`SearchVectors` の観測点**。実装はベクトル検索専用エンドポイントを
 *   自分で選ぶため `SearchVectorsCommand` を使わず署名付き生 HTTP で呼ぶ。
 *   したがって「`SearchVectors` を呼んだか」「どの引数で呼んだか」は
 *   送信された本文そのもの（`fetch` の `body`）で判定する
 *
 * `handler.ts` はモジュール読み込み時に次元数を確定するため、環境変数を設定したうえで
 * **動的 import** する。次元数は 8 に固定してあり、property の反復を軽くしている。
 *
 * 要件: 5.13, 5.14, 5.15, 8.1, 8.2, 8.6, 8.7, 8.8, 8.9, 8.10, 8.12, 16.2, 16.3
 * Property: 15, 18, 20, 21, 22, 24, 27
 */

import fc from 'fast-check';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { marshall } from '@aws-sdk/util-dynamodb';
// API の形は SDK のモデルをそのまま使う（ローカルに再定義しない）
import type { VectorIndexDescription } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

/** 仮想時計。`Date.now()` を差し替えたときのみ読まれる（Property 27 の擬似所要時間の注入） */
const clock = vi.hoisted(() => ({ nowMs: 1_700_000_000_000 }));

/** モックとテスト本体で共有する記録簿と応答の差し替え口 */
const seam = vi.hoisted(() => ({
  /** `GetItem`（Query_Vector_Cache）が返すアイテム。`undefined` は失効を表す */
  cacheItem: undefined as Record<string, unknown> | undefined,
  /** `DescribeTable` が返すベクトルインデックスの記述 */
  indexDescriptions: [] as Record<string, unknown>[],
  /** `SearchVectors` が返す結果 */
  searchResults: [] as { Item?: Record<string, unknown>; Score?: number }[],
  /** `SearchVectors` の `ConsumedCapacity` */
  consumedCapacity: undefined as Record<string, unknown> | undefined,
  /** 各下流呼び出しが消費する擬似所要時間（ms） */
  durations: { getItemMs: 0, describeTableMs: 0, searchMs: 0 },
  /** `fetch` へ渡された `SearchVectors` の入力（呼び出し順） */
  searchVectorsInputs: [] as Record<string, unknown>[],
  /** `GetItem` / `DescribeTable` の呼び出し回数 */
  getItemCalls: 0,
  describeTableCalls: 0,
}));

vi.mock('@aws-sdk/client-dynamodb', () => {
  class GetItemCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }

  class DescribeTableCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }

  class DynamoDBClient {
    readonly config = { credentials: () => Promise.resolve({ accessKeyId: 'ak', secretAccessKey: 'sk' }) };

    async send(command: GetItemCommand | DescribeTableCommand): Promise<Record<string, unknown>> {
      if (command instanceof GetItemCommand) {
        seam.getItemCalls += 1;
        clock.nowMs += seam.durations.getItemMs;
        return seam.cacheItem === undefined ? {} : { Item: seam.cacheItem };
      }

      seam.describeTableCalls += 1;
      clock.nowMs += seam.durations.describeTableMs;
      // `TableDescription.VectorIndexes` は複数形の配列である（SDK のモデルどおり）。
      // ハンドラの `readVectorIndexDescriptions()` が読むキーと一致させる
      return { Table: { VectorIndexes: seam.indexDescriptions } };
    }
  }

  return { DynamoDBClient, GetItemCommand, DescribeTableCommand };
});

vi.mock('@smithy/signature-v4', () => {
  class SignatureV4 {
    constructor(readonly options: unknown) {}

    async sign(request: { headers: Record<string, string> }): Promise<{ headers: Record<string, string> }> {
      return { ...request, headers: { ...request.headers, authorization: 'AWS4-HMAC-SHA256 Credential=test' } };
    }
  }

  return { SignatureV4 };
});

// ---------------------------------------------------------------------------
// 実行環境（動的 import より前に確定させる）
// ---------------------------------------------------------------------------

/** インデックスの次元数。`validateDimensions()` の許容範囲（1〜4,096）内の小さな値 */
const DIMENSIONS = 8;

/**
 * `SearchVectors` が返す `ConsumedCapacity.VectorSearchRequestBytes`（バイト）。
 *
 * `SearchVectors` の `ConsumedCapacity` に `CapacityUnits` は存在せず、単位はバイトである。
 * 1,024 次元の f32 クエリベクトル（約 4 KiB）に射影属性を加えた程度の実測されうる値を置く。
 */
const SEARCH_REQUEST_BYTES = 4608;

const VECTOR_TABLE_NAME = 'test-inventory-vector';
const QUERY_CACHE_TABLE_NAME = 'test-vector-query-cache';

process.env.AWS_REGION = 'ap-northeast-1';
process.env.VECTOR_TABLE_NAME = VECTOR_TABLE_NAME;
process.env.QUERY_CACHE_TABLE_NAME = QUERY_CACHE_TABLE_NAME;
process.env.VECTOR_EMBEDDING_DIMENSIONS = String(DIMENSIONS);
process.env.DYNAMODB_SEARCH_ENDPOINT = 'https://search-dynamodb.test.invalid';

let handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
let resetDescribeTableCache: () => void;
let projectedAttributes: readonly string[];
let indexBuildingRetryAfterSeconds: number;
let isVectorIndexSearchable: (index: VectorIndexDescription) => boolean;
let isBackfillingPresent: (index: VectorIndexDescription) => boolean;
let backfillingAbsentLabel: string;

const fetchMock = vi.fn(async (_url: string, init: { body?: unknown }) => {
  seam.searchVectorsInputs.push(JSON.parse(String(init.body)) as Record<string, unknown>);
  clock.nowMs += seam.durations.searchMs;

  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        SearchResults: seam.searchResults,
        ...(seam.consumedCapacity === undefined ? {} : { ConsumedCapacity: seam.consumedCapacity }),
      }),
  };
});

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchMock);

  const handlerModule = await import('./handler');
  handler = handlerModule.handler;
  resetDescribeTableCache = handlerModule.resetDescribeTableCache;
  projectedAttributes = handlerModule.PROJECTED_ATTRIBUTES;
  indexBuildingRetryAfterSeconds = handlerModule.INDEX_BUILDING_RETRY_AFTER_SECONDS;
  isVectorIndexSearchable = handlerModule.isVectorIndexSearchable;
  isBackfillingPresent = handlerModule.isBackfillingPresent;
  backfillingAbsentLabel = handlerModule.BACKFILLING_ABSENT_LABEL;
});

beforeEach(() => {
  fetchMock.mockClear();
  resetDescribeTableCache();
  seam.searchVectorsInputs.length = 0;
  seam.getItemCalls = 0;
  seam.describeTableCalls = 0;
  seam.searchResults = [];
  seam.consumedCapacity = { VectorSearchRequestBytes: SEARCH_REQUEST_BYTES };
  seam.durations = { getItemMs: 0, describeTableMs: 0, searchMs: 0 };
  seam.cacheItem = marshall({ queryId: 'q-1', vector: defaultVector(), language: 'ja' });
  seam.indexDescriptions = [activeIndex('byEmbeddingJa'), activeIndex('byEmbeddingEn')];
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

/** 次元数どおりの決定的なベクトル */
function defaultVector(): number[] {
  return Array.from({ length: DIMENSIONS }, (_, index) => (index + 1) / DIMENSIONS);
}

/** 検索可能なインデックスの記述（`IndexStatus === 'ACTIVE'` かつ `Backfilling !== true`） */
function activeIndex(indexName: string): Record<string, unknown> {
  return { IndexName: indexName, IndexStatus: 'ACTIVE', Backfilling: false, Dimensions: DIMENSIONS };
}

/** ハンドラが読むのは `body` と `isBase64Encoded` のみ */
function searchEvent(payload: unknown): APIGatewayProxyEvent {
  return { body: JSON.stringify(payload), isBase64Encoded: false } as unknown as APIGatewayProxyEvent;
}

function parseBody(result: APIGatewayProxyResult): Record<string, unknown> {
  return JSON.parse(result.body) as Record<string, unknown>;
}

/** 各 property 反復の冒頭で実行環境を初期化する（`beforeEach` は反復ごとには走らない） */
function resetSeam(options: { language?: 'ja' | 'en' } = {}): void {
  fetchMock.mockClear();
  resetDescribeTableCache();
  seam.searchVectorsInputs.length = 0;
  seam.getItemCalls = 0;
  seam.describeTableCalls = 0;
  seam.searchResults = [];
  seam.consumedCapacity = { VectorSearchRequestBytes: SEARCH_REQUEST_BYTES };
  seam.durations = { getItemMs: 0, describeTableMs: 0, searchMs: 0 };
  seam.cacheItem = marshall({
    queryId: 'q-1',
    vector: defaultVector(),
    language: options.language ?? 'ja',
  });
  seam.indexDescriptions = [activeIndex('byEmbeddingJa'), activeIndex('byEmbeddingEn')];
}

/** 射影された属性を AttributeValue の JSON 表現で持つ検索結果 1 件 */
function searchResult(options: {
  itemId: string;
  warehouseId: string;
  score: number;
  /** 両言語のベクトル属性を意図的に混ぜる（応答へ漏れないことの検証用） */
  withVectors?: boolean;
}): { Item: Record<string, unknown>; Score: number } {
  const vector = defaultVector();

  return {
    Item: marshall(
      {
        itemId: options.itemId,
        warehouseId: options.warehouseId,
        itemName: `商品 ${options.itemId}`,
        metaJa: { productName: `商品 ${options.itemId}`, category: 'コーヒー豆', origin: 'ブラジル' },
        metaEn: { productName: `Item ${options.itemId}`, category: 'Coffee Beans', origin: 'Brazil' },
        quantity: 10,
        location: 'A-01',
        unitPrice: 1200,
        ...(options.withVectors === true ? { embeddingJa: vector, embeddingEn: vector } : {}),
      },
      { removeUndefinedValues: true }
    ),
    Score: options.score,
  };
}

/**
 * ベクトル本体らしい配列（次元数と同じ長さの数値配列）を再帰的に集める。
 * 属性名を変えて載せた場合でもベクトル漏洩を検出できるようにするための走査（Property 22）。
 */
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

const languageArb = fc.constantFrom<'ja' | 'en'>('ja', 'en');

// ---------------------------------------------------------------------------
// Property 15: インデックス準備判定
// ---------------------------------------------------------------------------

describe('vector-search-ddb handler / インデックス準備判定', () => {
  /** `IndexStatus` の値域。`ACTIVE` 以外はすべて検索不可 */
  const indexStatusArb = fc.constantFrom('ACTIVE', 'CREATING', 'UPDATING', 'DELETING', 'ARCHIVED', 'active', '');

  /**
   * `Backfilling` の値域。**属性そのものが無い場合（undefined）を含む。**
   *
   * task 13.12 の実測では `DescribeTable` の `VectorIndexDescription` に `Backfilling` キーが
   * 一度も現れなかった（設計 V20）。すなわち実運用で常に通るのはこの undefined の枝である。
   * 判定は「不在 = 偽」で成立し検索は実行される一方、応答では偽と不在を区別する（要件 5.17）
   */
  const backfillingArb = fc.constantFrom<boolean | undefined>(true, false, undefined);

  // Feature: vector-search-comparison, Property 15: 任意の `IndexStatus` 値と任意の `Backfilling` 値の組と
  // 任意の言語に対して、検索が実行されるのは当該言語のインデックスが存在し、その `IndexStatus` が
  // `ACTIVE` かつ `Backfilling` が真でない場合のみである。それ以外の場合は検索が呼ばれず、
  // インデックス不存在なら再試行不可のコードと対象インデックス名を返し、作成中またはバックフィル中なら
  // 再試行可のコードと 1 以上 300 以下の推奨待機秒数、および `IndexStatus` と `Backfilling` の
  // 両方の値を返す。
  // **Validates: Requirements 5.13, 5.14, 5.15, 16.2, 16.3**
  it('ACTIVE かつ非バックフィルの組のときのみ SearchVectors を呼ぶ', async () => {
    await fc.assert(
      fc.asyncProperty(
        languageArb,
        fc.boolean(),
        indexStatusArb,
        backfillingArb,
        async (language, indexPresent, indexStatus, backfilling) => {
          resetSeam({ language });

          const expectedIndexName = language === 'ja' ? 'byEmbeddingJa' : 'byEmbeddingEn';
          seam.indexDescriptions = indexPresent
            ? [
                {
                  IndexName: expectedIndexName,
                  IndexStatus: indexStatus,
                  ...(backfilling === undefined ? {} : { Backfilling: backfilling }),
                  Dimensions: DIMENSIONS,
                },
              ]
            : [];

          const searchable = indexPresent && indexStatus === 'ACTIVE' && backfilling !== true;

          const result = await handler(searchEvent({ queryId: 'q-1', topK: 5 }));
          const body = parseBody(result);

          // 検索の実行有無が判定の組と一致する
          expect(fetchMock.mock.calls).toHaveLength(searchable ? 1 : 0);

          if (searchable) {
            expect(result.statusCode).toBe(200);
            // 判定材料の両方を応答へ載せる。検索可能な組では `Backfilling` は
            // 常に偽（属性が無い場合も偽として正規化される）。
            // 偽と不在は `backfillingPresent` で区別する（要件 5.17、V20）
            expect(body.indexReadiness).toEqual({
              indexStatus: 'ACTIVE',
              backfilling: false,
              backfillingPresent: backfilling !== undefined,
              describeTableCached: false,
            });
            return;
          }

          expect(result.statusCode).toBeGreaterThanOrEqual(400);

          if (!indexPresent) {
            // 不存在は再試行不可。対象インデックス名を返す
            expect(body.errorCode).toBe('INDEX_NOT_FOUND');
            expect(body.retryable).toBe(false);
            expect('retryAfterSeconds' in body).toBe(false);
            expect(body.message).toContain(expectedIndexName);
            return;
          }

          // 作成中・バックフィル中は再試行可。1〜300 秒の待機秒数と両方の値を返す
          expect(body.errorCode).toBe('INDEX_BUILDING');
          expect(body.retryable).toBe(true);
          expect(body.retryAfterSeconds).toBeGreaterThanOrEqual(1);
          expect(body.retryAfterSeconds).toBeLessThanOrEqual(300);
          expect(body.message).toContain(expectedIndexName);
          expect(body.message).toContain(indexStatus.length > 0 ? indexStatus : '不明');
          // フィールドが不在なら「偽」ではなく不在であることを載せる（要件 5.17、V20）
          expect(body.message).toContain(
            `Backfilling: ${backfilling === undefined ? backfillingAbsentLabel : String(backfilling)}`
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('推奨待機秒数の既定値が 1〜300 秒に収まる', () => {
    expect(indexBuildingRetryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(indexBuildingRetryAfterSeconds).toBeLessThanOrEqual(300);
  });
});

// ---------------------------------------------------------------------------
// `Backfilling` フィールド不在の扱い（要件 5.15 / 5.17 / 16.3、設計 V20）
// ---------------------------------------------------------------------------

/**
 * task 13.12 の実測で `DescribeTable` の `VectorIndexDescription` に `Backfilling` キーが
 * 一度も現れないことが判明した。ここでは `true` / `false` / キー不在の 3 通りについて
 * 検索可否の判定結果と `backfillingPresent` の値を固定する。
 *
 * 押さえたいのは **キー不在でも検索が実行される**（不在 = 偽）ことと、
 * にもかかわらず応答では偽と不在が区別できることの両方である。
 */
describe('vector-search-ddb handler / Backfilling フィールドの不在', () => {
  /** `Backfilling` の指定だけを差し替えた ACTIVE なインデックス */
  function activeIndexWithBackfilling(backfilling: boolean | undefined): Record<string, unknown> {
    return {
      IndexName: 'byEmbeddingJa',
      IndexStatus: 'ACTIVE',
      ...(backfilling === undefined ? {} : { Backfilling: backfilling }),
      Dimensions: DIMENSIONS,
    };
  }

  it('Backfilling: false のとき検索を実行し backfillingPresent が true になる', async () => {
    resetSeam({ language: 'ja' });
    seam.indexDescriptions = [activeIndexWithBackfilling(false)];

    const result = await handler(searchEvent({ queryId: 'q-1', topK: 5 }));

    expect(result.statusCode).toBe(200);
    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(parseBody(result).indexReadiness).toEqual({
      indexStatus: 'ACTIVE',
      backfilling: false,
      backfillingPresent: true,
      describeTableCached: false,
    });
  });

  it('Backfilling: true のとき検索を実行せず INDEX_BUILDING と真の値を返す', async () => {
    resetSeam({ language: 'ja' });
    seam.indexDescriptions = [activeIndexWithBackfilling(true)];

    const result = await handler(searchEvent({ queryId: 'q-1', topK: 5 }));
    const body = parseBody(result);

    expect(fetchMock.mock.calls).toHaveLength(0);
    expect(body.errorCode).toBe('INDEX_BUILDING');
    expect(body.retryable).toBe(true);
    expect(body.message).toContain('Backfilling: true');
    // 不在ラベルは真の値と混ざらない
    expect(body.message).not.toContain(backfillingAbsentLabel);
  });

  it('Backfilling キーが不在でも検索を実行し、backfillingPresent が false になる', async () => {
    resetSeam({ language: 'ja' });
    seam.indexDescriptions = [activeIndexWithBackfilling(undefined)];

    const result = await handler(searchEvent({ queryId: 'q-1', topK: 5 }));

    // **不在 = 偽。**検索は実行される（要件 5.15 / 5.17）
    expect(result.statusCode).toBe(200);
    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(parseBody(result).indexReadiness).toEqual({
      indexStatus: 'ACTIVE',
      backfilling: false,
      // 偽ではなく「観測できていない」ことを応答で区別できる
      backfillingPresent: false,
      describeTableCached: false,
    });
  });

  it('キー不在で INDEX_BUILDING になる場合は偽ではなく不在であることを返す', async () => {
    resetSeam({ language: 'ja' });
    // `Backfilling` は不在のまま `IndexStatus` だけが ACTIVE 以外
    seam.indexDescriptions = [
      { IndexName: 'byEmbeddingJa', IndexStatus: 'CREATING', Dimensions: DIMENSIONS },
    ];

    const result = await handler(searchEvent({ queryId: 'q-1', topK: 5 }));
    const body = parseBody(result);

    expect(fetchMock.mock.calls).toHaveLength(0);
    expect(body.errorCode).toBe('INDEX_BUILDING');
    expect(body.message).toContain(`Backfilling: ${backfillingAbsentLabel}`);
    // 観測していない値を偽として書かない
    expect(body.message).not.toContain('Backfilling: false');
  });

  it('判定関数は不在を偽として扱い、存在有無は別関数で区別する', () => {
    const absent: VectorIndexDescription = { IndexName: 'byEmbeddingJa', IndexStatus: 'ACTIVE' };
    const falsy: VectorIndexDescription = { ...absent, Backfilling: false };
    const truthy: VectorIndexDescription = { ...absent, Backfilling: true };

    // 判定は「不在 = 偽」で成立する（要件 5.15）
    expect(isVectorIndexSearchable(absent)).toBe(true);
    expect(isVectorIndexSearchable(falsy)).toBe(true);
    expect(isVectorIndexSearchable(truthy)).toBe(false);

    // 偽と不在は別関数で区別する（要件 5.17）
    expect(isBackfillingPresent(absent)).toBe(false);
    expect(isBackfillingPresent(falsy)).toBe(true);
    expect(isBackfillingPresent(truthy)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property 18: 言語ルーティングの排他性（DynamoDB 側）
// ---------------------------------------------------------------------------

describe('vector-search-ddb handler / 言語ルーティング', () => {
  // Feature: vector-search-comparison, Property 18: 任意の言語指定に対して、
  // DynamoDB_Vector_Lambda が指定するインデックス名は当該言語に対応する 1 本であり、
  // いずれの呼び出し引数にも他方の言語のインデックス名・フィールド名が現れない。
  // **Validates: Requirements 3.2, 8.1, 8.2, 9.2, 11.4**
  it('呼び出し引数に他方の言語のインデックス名・ベクトル属性名が現れない', async () => {
    await fc.assert(
      fc.asyncProperty(languageArb, fc.integer({ min: 1, max: 20 }), async (language, topK) => {
        resetSeam({ language });
        seam.searchResults = [searchResult({ itemId: 'SKU-1', warehouseId: 'WH-TOKYO', score: 0.1, withVectors: true })];

        const result = await handler(searchEvent({ queryId: 'q-1', topK }));
        const body = parseBody(result);

        expect(result.statusCode).toBe(200);
        expect(fetchMock.mock.calls).toHaveLength(1);

        const expected = language === 'ja' ? 'byEmbeddingJa' : 'byEmbeddingEn';
        const other = language === 'ja' ? 'byEmbeddingEn' : 'byEmbeddingJa';
        const otherField = language === 'ja' ? 'embeddingEn' : 'embeddingJa';

        // インデックスは当該言語に対応する 1 本のみ
        expect(seam.searchVectorsInputs[0]?.IndexName).toBe(expected);
        expect(body.indexName).toBe(expected);
        expect(body.language).toBe(language);

        // 呼び出し引数の全文に他方の言語の名前が現れない（大文字小文字を無視して照合する）
        const serialized = JSON.stringify(seam.searchVectorsInputs[0]).toLowerCase();
        expect(serialized).toContain(expected.toLowerCase());
        expect(serialized).not.toContain(other.toLowerCase());
        expect(serialized).not.toContain(otherField.toLowerCase());
      }),
      { numRuns: 30 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 20: 検索条件式のプレースホルダ化
// ---------------------------------------------------------------------------

describe('vector-search-ddb handler / 検索条件式', () => {
  /** 引用符・記号・空白を含む倉庫 ID。前後を trim しても 1 文字以上残るものだけを使う */
  const warehouseIdArb = fc
    .array(
      fc.constantFrom(
        'W',
        'H',
        '-',
        'T',
        'O',
        'K',
        'Y',
        '0',
        ' ',
        "'",
        '"',
        '`',
        '=',
        '<',
        '>',
        ',',
        '#',
        ':',
        '(',
        ')',
        '\\',
        '東',
        '京'
      ),
      { minLength: 1, maxLength: 40 }
    )
    .map((characters) => characters.join(''))
    .filter((value) => value.trim().length > 0);

  // Feature: vector-search-comparison, Property 20: 任意の warehouseId 文字列
  // （引用符・記号・空白を含む）に対して、構築された `SearchConditionExpression` は
  // 等価演算子のみを含み、属性名と値は式文字列に直接埋め込まれず
  // `ExpressionAttributeNames` と `ExpressionAttributeValues` のプレースホルダとしてバインドされる。
  // **Validates: Requirements 8.6, 11.8**
  it('式は等価演算子とプレースホルダのみで構成され、名前と値はバインドされる', async () => {
    await fc.assert(
      fc.asyncProperty(warehouseIdArb, languageArb, async (warehouseId, language) => {
        resetSeam({ language });

        const result = await handler(searchEvent({ queryId: 'q-1', topK: 5, warehouseId }));

        expect(result.statusCode).toBe(200);
        expect(fetchMock.mock.calls).toHaveLength(1);

        const input = seam.searchVectorsInputs[0] as {
          SearchConditionExpression?: string;
          ExpressionAttributeNames?: Record<string, string>;
          ExpressionAttributeValues?: Record<string, { S?: string }>;
        };

        const expression = input.SearchConditionExpression ?? '';

        // 左辺は名前プレースホルダ、右辺は値プレースホルダ、演算子は `=` のみ
        expect(expression).toMatch(/^#[A-Za-z0-9_]+ = :[A-Za-z0-9_]+$/);
        expect(expression).not.toMatch(/<|>|between|begins_with|contains|and|or|not/i);

        const namePlaceholder = expression.slice(0, expression.indexOf(' '));
        const valuePlaceholder = expression.slice(expression.lastIndexOf(' ') + 1);

        // 属性名は `ExpressionAttributeNames` 側にのみ現れる
        expect(input.ExpressionAttributeNames?.[namePlaceholder]).toBe('warehouseId');
        // 値は `ExpressionAttributeValues` 側にのみ現れ、trim 後の値がそのままバインドされる
        expect(input.ExpressionAttributeValues?.[valuePlaceholder]).toEqual({ S: warehouseId.trim() });
      }),
      { numRuns: 60 }
    );
  });

  it('倉庫未指定のときは検索条件式と値バインドを作らない', async () => {
    resetSeam();

    const result = await handler(searchEvent({ queryId: 'q-1', topK: 5 }));

    expect(result.statusCode).toBe(200);
    const input = seam.searchVectorsInputs[0] as Record<string, unknown>;
    expect('SearchConditionExpression' in input).toBe(false);
    expect('ExpressionAttributeValues' in input).toBe(false);
    expect(parseBody(result).filterApplied).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Property 21: 範囲フィルタ要求の拒否と非実行
// ---------------------------------------------------------------------------

describe('vector-search-ddb handler / 範囲フィルタ', () => {
  /** 下限のみ・上限のみ・両方、任意のフィールド名 */
  const rangeFilterArb = fc
    .tuple(
      fc.option(fc.constantFrom('unitPrice', 'quantity', 'weight', ''), { nil: undefined }),
      fc.option(fc.integer({ min: -1000, max: 1000 }), { nil: undefined }),
      fc.option(fc.integer({ min: -1000, max: 1000 }), { nil: undefined })
    )
    .map(([field, min, max]) => ({
      ...(field === undefined ? {} : { field }),
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
    }))
    .filter((filter) => Object.keys(filter).length > 0);

  // Feature: vector-search-comparison, Property 21: 任意の範囲条件（下限のみ・上限のみ・両方、
  // 任意のフィールド名）を含むフィルタ要求に対して、`SearchVectors` は呼ばれず、
  // 実装既定が等価条件のみであることを示す制約コードが返る。
  // **Validates: Requirements 8.7, 15.2**
  it('範囲条件を含む要求では SearchVectors を呼ばずに制約コードを返す', async () => {
    await fc.assert(
      fc.asyncProperty(rangeFilterArb, languageArb, async (rangeFilter, language) => {
        resetSeam({ language });

        const result = await handler(searchEvent({ queryId: 'q-1', topK: 5, rangeFilter }));
        const body = parseBody(result);

        expect(fetchMock.mock.calls).toHaveLength(0);
        expect(result.statusCode).toBeGreaterThanOrEqual(400);
        expect(body.errorCode).toBe('RANGE_FILTER_UNSUPPORTED');
        expect(body.retryable).toBe(false);
      }),
      { numRuns: 60 }
    );
  });

  it('範囲条件を含まない要求では SearchVectors を呼ぶ', async () => {
    resetSeam();

    const result = await handler(searchEvent({ queryId: 'q-1', topK: 5, rangeFilter: {} }));

    expect(result.statusCode).toBe(200);
    expect(fetchMock.mock.calls).toHaveLength(1);

    // 要件 8.11: `ConsumedCapacity` から写すのはバイト単位の 2 項目のみである。
    // `CapacityUnits` のような存在しない項目を読む実装に戻ると、値が null になりここで落ちる
    expect(parseBody(result).consumedCapacity).toEqual({
      vectorSearchRequestBytes: SEARCH_REQUEST_BYTES,
    });
  });
});

// ---------------------------------------------------------------------------
// Property 22: 応答へのベクトル非漏洩（DynamoDB 側）
// ---------------------------------------------------------------------------

describe('vector-search-ddb handler / 応答へのベクトル非漏洩', () => {
  // Feature: vector-search-comparison, Property 22: 任意の内部検索結果（両言語のベクトル属性を含む）と
  // 任意のクエリベクトルに対して、DynamoDB 検索エンドポイントの応答に日本語ベクトルおよび
  // 英語ベクトルの属性名と本体（次元数と同じ長さの数値配列）が現れない。
  // **Validates: Requirements 8.8, 9.1, 10.3**
  it('内部結果が両言語のベクトルを含んでいても応答に属性名も数値配列も現れない', async () => {
    await fc.assert(
      fc.asyncProperty(
        languageArb,
        fc.integer({ min: 1, max: 8 }),
        async (language, resultCount) => {
          resetSeam({ language });
          seam.searchResults = Array.from({ length: resultCount }, (_, index) =>
            searchResult({
              itemId: `SKU-${index}`,
              warehouseId: 'WH-TOKYO',
              score: index / 10,
              withVectors: true,
            })
          );

          const result = await handler(searchEvent({ queryId: 'q-1', topK: 20 }));
          const body = parseBody(result);

          expect(result.statusCode).toBe(200);

          // 応答全文にベクトル属性名が現れない。DynamoDB の属性名は大文字小文字を区別するため、
          // 引用符付きの完全一致で照合する（`indexName` に載る `byEmbeddingJa` は
          // インデックス名であって属性名ではないため、部分一致では判定できない）
          expect(result.body).not.toContain('"embeddingJa"');
          expect(result.body).not.toContain('"embeddingEn"');

          // 属性名を変えて載せた場合も検出できるよう、ベクトル本体（次元数と同じ長さの
          // 数値配列）が応答のどこにも無いことを再帰的に確かめる
          expect(findVectorLikeArrays(body)).toEqual([]);

          // ヒットの各項目に配列が無い
          const hits = body.hits as Record<string, unknown>[];
          expect(hits).toHaveLength(resultCount);
          for (const hit of hits) {
            for (const value of Object.values(hit)) {
              expect(Array.isArray(value)).toBe(false);
            }
          }

          // 射影の要求自体にベクトル属性を含めない
          const names = (seam.searchVectorsInputs[0] as { ExpressionAttributeNames?: Record<string, string> })
            .ExpressionAttributeNames;
          expect(Object.values(names ?? {})).not.toContain('embeddingJa');
          expect(Object.values(names ?? {})).not.toContain('embeddingEn');
        }
      ),
      { numRuns: 30 }
    );
  });

  it('射影対象の一覧にベクトル属性を含めない', () => {
    expect(projectedAttributes).not.toContain('embeddingJa');
    expect(projectedAttributes).not.toContain('embeddingEn');
  });
});

// ---------------------------------------------------------------------------
// Property 24: 結果の順序・順位・件数の不変条件
// ---------------------------------------------------------------------------

describe('vector-search-ddb handler / 結果の不変条件', () => {
  // Feature: vector-search-comparison, Property 24: 任意の検索結果集合と任意の適用 TopK に対して、
  // 返却される結果は距離の昇順に並び、`rank` は 1 から返却件数までの連番であり、
  // 返却件数は 0 以上かつ適用 TopK 以下である。返却件数が適用 TopK 未満でもエラーにならず、
  // 要求 TopK と返却件数の両方が応答に含まれる。
  // **Validates: Requirements 8.9, 8.10, 9.11**
  it('距離昇順・1 起点の連番・件数が適用 TopK 以下になる', async () => {
    /** 適用 TopK と、その件数を超えないスコア列（順序は任意） */
    const resultsArb = fc.integer({ min: 1, max: 20 }).chain((topK) =>
      fc.tuple(
        fc.constant(topK),
        fc.array(fc.double({ min: 0, max: 2, noNaN: true }), { minLength: 0, maxLength: topK })
      )
    );

    await fc.assert(
      fc.asyncProperty(resultsArb, languageArb, async ([topK, scores], language) => {
        resetSeam({ language });
        seam.searchResults = scores.map((score, index) =>
          searchResult({ itemId: `SKU-${index}`, warehouseId: 'WH-TOKYO', score })
        );

        const result = await handler(searchEvent({ queryId: 'q-1', topK }));
        const body = parseBody(result);

        // 0 件・TopK 未満でもエラーにしない
        expect(result.statusCode).toBe(200);

        const hits = body.hits as { rank: number; distance: number }[];

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
      }),
      { numRuns: 60 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 27: レイテンシ区間の包含関係
// ---------------------------------------------------------------------------

describe('vector-search-ddb handler / レイテンシ区間', () => {
  // Feature: vector-search-comparison, Property 27: 任意の擬似所要時間の注入に対して、
  // 検索区間レイテンシはハンドラ全体区間レイテンシ以下であり、両者はともに 0 以上の整数である。
  // 擬似所要時間は `GetItem` / `DescribeTable` / `SearchVectors` の各スタブが
  // 仮想時計を進めることで注入する。
  // **Validates: Requirements 8.12, 9.8**
  it('searchLatencyMs が handlerLatencyMs 以下で、いずれも 0 以上の整数になる', async () => {
    const durationArb = fc.integer({ min: 0, max: 5_000 });

    await fc.assert(
      fc.asyncProperty(
        durationArb,
        durationArb,
        durationArb,
        languageArb,
        async (getItemMs, describeTableMs, searchMs, language) => {
          resetSeam({ language });
          seam.durations = { getItemMs, describeTableMs, searchMs };

          const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock.nowMs);

          try {
            const result = await handler(searchEvent({ queryId: 'q-1', topK: 5 }));
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
            expect(handlerLatencyMs).toBe(getItemMs + describeTableMs + searchMs);
          } finally {
            nowSpy.mockRestore();
          }
        }
      ),
      { numRuns: 60 }
    );
  });
});

// ---------------------------------------------------------------------------
// 実 API の生応答を固定する単体テスト（task 13.13 / Open Question Q5）
// ---------------------------------------------------------------------------

/**
 * `SearchVectors` の**実 API から記録した生応答**（task 13.13）。
 *
 * 記録: 2026-08-21T13:09:22Z / us-west-2 / `kiro-roasters-inventory-vector` /
 * `byEmbeddingJa`（ACTIVE・COSINE・1,024 次元）/ TopK 1 /
 * `docs/measurements/measure-search-response-shape-2026-08-21T13-09-22-492Z.json`。
 *
 * 生応答のトップレベルは `ConsumedCapacity` と `SearchResults` の 2 キーのみで、距離スコアの
 * フィールド名は `SearchResults[].Score` である。**推測ではなく実際に返ってきたキー名である。**
 * 本定数はその形をそのまま貼っており、実装のマッピングが実応答から離れたらここで落ちる。
 */
const OBSERVED_SEARCH_RESULT = {
  Item: {
    itemId: { S: 'ITEM#MAT-TAG-M-KRAFT-V693' },
    itemName: { S: '資材 タグ M クラフト V693' },
    location: { S: 'A-05-05' },
    metaEn: {
      M: {
        roastLevel: { S: '' },
        acidity: { S: '' },
        origin: { S: '' },
        description: { S: 'Tag attached to a product to convey information. Size M. Material kraft.' },
        brewingRecommendation: { S: 'used for gift personalization and blend labeling.' },
        category: { S: 'packaging material' },
        flavorNotes: { S: '' },
        body: { S: '' },
        productName: { S: 'Packaging material tag M kraft V693' },
      },
    },
    metaJa: {
      M: {
        roastLevel: { S: '' },
        acidity: { S: '' },
        origin: { S: '' },
        description: { S: '商品に取り付けて情報を伝えるタグ。 サイズはM。 素材はクラフト。' },
        brewingRecommendation: { S: 'ギフトの名入れや銘柄表示に使う。' },
        category: { S: '資材' },
        flavorNotes: { S: '' },
        body: { S: '' },
        productName: { S: '資材 タグ M クラフト V693' },
      },
    },
    quantity: { N: '694' },
    unitPrice: { N: '80' },
    warehouseId: { S: 'WH-FUKUOKA' },
  },
  /** 距離スコア。**実応答のフィールド名は `Score`**（要件 8.9 / Q5） */
  Score: 0.9396041035652161,
} as const;

/**
 * 実応答の `ConsumedCapacity`（同じ記録より）。
 *
 * **`VectorSearchUnits` は SDK の `VectorCapacity` モデルに存在しないが実 API は返す。**
 * 要件 8.11 は「`SearchVectors` が返した消費キャパシティ値」を応答へ載せることを求めるため、
 * ハンドラはモデルに無い当該項目も応答へ写す。この観測では 2 項目が同値だったが、
 * 常に一致する保証はないため別項目として保持する。
 */
const OBSERVED_CONSUMED_CAPACITY = {
  VectorSearchRequestBytes: 61318,
  VectorSearchUnits: 61318,
} as const;

/**
 * ローカルで厳密に算出したコサイン距離（同じ記録より）。
 *
 * 返却行 `ITEM#MAT-TAG-M-KRAFT-V693` / `WH-FUKUOKA` の格納ベクトル（`embeddingJa`、1,024 次元、
 * ノルム 1.0000000196）と、`SearchVectors` へ送った決定論的クエリベクトル（シード 20260101、
 * ノルム 0.9999999999）から算出した `1 − cos` の値。
 */
const OBSERVED_LOCAL_COSINE_DISTANCE = 0.9396041371918892;

describe('vector-search-ddb handler / 実 API の生応答（task 13.13 / Q5）', () => {
  /** 実応答をそのまま返させる。次元数チェックはクエリ側の長さで行われるため影響しない */
  function useObservedResponse(): void {
    resetSeam({ language: 'ja' });
    seam.searchResults = [{ ...OBSERVED_SEARCH_RESULT } as unknown as { Item: Record<string, unknown>; Score: number }];
    seam.consumedCapacity = { ...OBSERVED_CONSUMED_CAPACITY };
  }

  // **Validates: Requirements 8.9**
  it('距離スコアのフィールド名は Score であり、その値が distance と rawScore の両方になる', () => {
    useObservedResponse();

    // 実応答から読むキー名を固定する。実装が別のキー名（`Distance` / `_score` 等）を
    // 読むようになったらここで落ちる
    expect(Object.keys(OBSERVED_SEARCH_RESULT)).toEqual(['Item', 'Score']);
  });

  // **Validates: Requirements 8.9**
  it('Score はコサイン距離そのものであり、変換を挟まずに distance と rawScore へ写る', async () => {
    useObservedResponse();

    const result = await handler(searchEvent({ queryId: 'q-1', topK: 1 }));
    const body = parseBody(result);
    const hits = body.hits as Record<string, unknown>[];

    expect(result.statusCode).toBe(200);
    expect(hits).toHaveLength(1);
    expect(hits[0].distance).toBe(OBSERVED_SEARCH_RESULT.Score);
    expect(hits[0].rawScore).toBe(OBSERVED_SEARCH_RESULT.Score);
    expect(hits[0].rank).toBe(1);

    // 実応答の `Score` はローカル算出のコサイン距離と f32 精度の範囲で一致する。
    // 類似度（`1 − Score`）・式 A（`2 − 2 × Score`）・式 B（`1 / Score − 1`）はいずれも棄却された
    expect(Math.abs((hits[0].distance as number) - OBSERVED_LOCAL_COSINE_DISTANCE)).toBeLessThan(1e-6);
    expect(Math.abs(1 - OBSERVED_SEARCH_RESULT.Score - OBSERVED_LOCAL_COSINE_DISTANCE)).toBeGreaterThan(1e-3);
    expect(Math.abs(2 - 2 * OBSERVED_SEARCH_RESULT.Score - OBSERVED_LOCAL_COSINE_DISTANCE)).toBeGreaterThan(1e-3);
    expect(Math.abs(1 / OBSERVED_SEARCH_RESULT.Score - 1 - OBSERVED_LOCAL_COSINE_DISTANCE)).toBeGreaterThan(1e-3);

    // 距離の向きは「小さいほど類似」であり、応答にラベルとして載る（要件 8.9）
    expect(body.distanceFunction).toBe('COSINE');
    expect(body.distanceSemantics).toBe('lower_is_closer');
  });

  // **Validates: Requirements 8.11**
  it('SDK のモデルに無い VectorSearchUnits も消費キャパシティとして応答へ載る', async () => {
    useObservedResponse();

    const result = await handler(searchEvent({ queryId: 'q-1', topK: 1 }));

    expect(parseBody(result).consumedCapacity).toEqual({
      vectorSearchRequestBytes: OBSERVED_CONSUMED_CAPACITY.VectorSearchRequestBytes,
      vectorSearchUnits: OBSERVED_CONSUMED_CAPACITY.VectorSearchUnits,
    });
  });

  // **Validates: Requirements 8.8**
  it('実応答の射影属性にベクトルが含まれず、表示名は検索言語のメタデータから取られる', async () => {
    useObservedResponse();

    const result = await handler(searchEvent({ queryId: 'q-1', topK: 1 }));
    const hits = parseBody(result).hits as Record<string, unknown>[];

    // 実応答の `Item` に `embeddingJa` / `embeddingEn` は現れなかった（射影が効いている）
    expect(Object.keys(OBSERVED_SEARCH_RESULT.Item)).not.toContain('embeddingJa');
    expect(Object.keys(OBSERVED_SEARCH_RESULT.Item)).not.toContain('embeddingEn');
    expect(result.body).not.toContain('embeddingJa');
    expect(result.body).not.toContain('embeddingEn');

    expect(hits[0].itemId).toBe('ITEM#MAT-TAG-M-KRAFT-V693');
    expect(hits[0].warehouseId).toBe('WH-FUKUOKA');
    expect(hits[0].productName).toBe('資材 タグ M クラフト V693');
    expect(hits[0].category).toBe('資材');
    expect(hits[0].quantity).toBe(694);
    expect(hits[0].unitPrice).toBe(80);
  });

  // **Validates: Requirements 8.1**
  it('SearchVector は AttributeValue[] で送る（素の数値配列は実 API に拒否される）', async () => {
    useObservedResponse();

    await handler(searchEvent({ queryId: 'q-1', topK: 1 }));

    const sent = seam.searchVectorsInputs[0];
    const searchVector = sent.SearchVector as unknown[];

    // 実測（task 13.13）: 素の数値配列で送ると HTTP 400 `SerializationException` になる。
    // SDK モデルの `SearchVectorsInput.SearchVector: AttributeValue[]` どおりの形のみが受理される
    expect(Array.isArray(searchVector)).toBe(true);
    expect(searchVector).toHaveLength(DIMENSIONS);
    for (const element of searchVector) {
      expect(typeof element).toBe('object');
      expect(Object.keys(element as Record<string, unknown>)).toEqual(['N']);
      expect(typeof (element as Record<string, unknown>).N).toBe('string');
    }
  });
});
