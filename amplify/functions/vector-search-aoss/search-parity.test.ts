/**
 * 両バックエンド検索の同一性 property テスト（task 8.8）
 *
 * 検証対象は Correctness Property 23（クエリベクトル・k・言語の両バックエンド一致）と、
 * Property 28 のうち「埋め込み生成が失敗した場合に検索エンドポイントが呼ばれない」部分。
 *
 * 1 回の `POST /vector-search/embed` で得た `queryId` を、DynamoDB 検索と OpenSearch 検索の
 * **両ハンドラへ同じ形で渡し**、両者が使ったクエリベクトル・k・言語・倉庫フィルタを
 * 呼び出し引数から突き合わせる。3 つのハンドラを 1 つのモジュールグラフに載せる必要があるため、
 * 本ファイルは各ハンドラ個別のテスト（`../vector-query-embed/handler.test.ts` /
 * `../vector-search-ddb/handler.test.ts` / `./handler.test.ts`）とは別に置いてある。
 *
 * `@opensearch-project/opensearch` は `vector-search-aoss/node_modules` にのみ存在するため、
 * 本ファイルの置き場所は `vector-search-aoss/` である必要がある（`amplify/functions/` 直下では
 * モジュール解決できない）。
 *
 * ## モックの境界
 *
 * - `@aws-sdk/client-bedrock-runtime`: 埋め込み生成の呼び出し回数の観測点
 * - `@aws-sdk/client-dynamodb`: Query_Vector_Cache を**インメモリのテーブルとして実装**する。
 *   埋め込み側の `PutItem` と検索側 2 本の `GetItem` が同一のアイテムを通るため、
 *   「同じ 1 項目を参照しているか」を実装と同じ経路で確かめられる。`DescribeTable` も返す
 * - `@smithy/signature-v4` と `globalThis.fetch`: DynamoDB 側 `SearchVectors` の観測点
 * - `@opensearch-project/opensearch`: OpenSearch 側 `_search` の観測点
 *
 * 要件: 9.3, 10.4, 11.11, 16.8
 * Property: 23, 28
 */

import fc from 'fast-check';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

/** モックとテスト本体で共有する記録簿と応答の差し替え口 */
const seam = vi.hoisted(() => ({
  /** Query_Vector_Cache のインメモリ実装。キーは `queryId` */
  cacheTable: new Map<string, Record<string, unknown>>(),
  /** `DescribeTable` が返すベクトルインデックスの記述 */
  indexDescriptions: [] as Record<string, unknown>[],
  /** `InvokeModelCommand` の入力（= Bedrock 呼び出し 1 回に相当） */
  invokeModelInputs: [] as { body?: unknown }[],
  /** `fetch` へ渡された `SearchVectors` の入力 */
  searchVectorsInputs: [] as Record<string, unknown>[],
  /** `client.search()` へ渡された引数 */
  openSearchParams: [] as Record<string, unknown>[],
}));

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class InvokeModelCommand {
    constructor(readonly input: { body?: unknown }) {}
  }

  class BedrockRuntimeClient {
    async send(command: InvokeModelCommand): Promise<{ body: Uint8Array }> {
      seam.invokeModelInputs.push(command.input);

      const request = JSON.parse(new TextDecoder().decode(command.input.body as Uint8Array)) as {
        inputText: string;
        dimensions: number;
      };

      // 入力テキストに依存する決定的なベクトル。同一クエリなら同一ベクトルになる
      const seed = Array.from(request.inputText).reduce((total, character) => total + character.charCodeAt(0), 1);
      const embedding = Array.from(
        { length: request.dimensions },
        (_, index) => ((seed * (index + 1)) % 977) / 977
      );

      // `jsdom` 環境では `TextEncoder` が別レルムの `Uint8Array` を返すため現レルムへ写す
      return {
        body: Uint8Array.from(new TextEncoder().encode(JSON.stringify({ embedding, inputTextTokenCount: 5 }))),
      };
    }
  }

  return { BedrockRuntimeClient, InvokeModelCommand };
});

vi.mock('@aws-sdk/client-dynamodb', () => {
  class PutItemCommand {
    constructor(readonly input: { Item?: Record<string, unknown> }) {}
  }

  class GetItemCommand {
    constructor(readonly input: { Key?: Record<string, { S?: string }> }) {}
  }

  class DescribeTableCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }

  class DynamoDBClient {
    readonly config = { credentials: () => Promise.resolve({ accessKeyId: 'ak', secretAccessKey: 'sk' }) };

    async send(
      command: PutItemCommand | GetItemCommand | DescribeTableCommand
    ): Promise<Record<string, unknown>> {
      if (command instanceof PutItemCommand) {
        const item = command.input.Item ?? {};
        const queryId = (item.queryId as { S?: string } | undefined)?.S ?? '';
        seam.cacheTable.set(queryId, item);
        return {};
      }

      if (command instanceof GetItemCommand) {
        const queryId = command.input.Key?.queryId?.S ?? '';
        const item = seam.cacheTable.get(queryId);
        return item === undefined ? {} : { Item: item };
      }

      // `TableDescription.VectorIndexes` は複数形の配列である（SDK のモデルどおり）
      return { Table: { VectorIndexes: seam.indexDescriptions } };
    }
  }

  return { DynamoDBClient, PutItemCommand, GetItemCommand, DescribeTableCommand };
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

vi.mock('@opensearch-project/opensearch', () => {
  class Client {
    constructor(readonly options: unknown) {}

    async search(params: Record<string, unknown>): Promise<{ body: Record<string, unknown> }> {
      seam.openSearchParams.push(params);
      return {
        body: {
          took: 2,
          hits: {
            hits: [
              {
                _id: 'SKU-0#WH-TOKYO',
                _score: 0.9,
                _source: { itemId: 'SKU-0', warehouseId: 'WH-TOKYO', quantity: 1, location: 'A-01', unitPrice: 100 },
              },
            ],
          },
        },
      };
    }

    async count(): Promise<{ body: { count: number } }> {
      return { body: { count: 100 } };
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

// ---------------------------------------------------------------------------
// 実行環境（動的 import より前に確定させる）
// ---------------------------------------------------------------------------

/**
 * 次元数。Titan Text Embeddings V2 が受理する最小値（256）を使う。
 * 埋め込み Lambda と DynamoDB 検索 Lambda へ**同一の値**を渡す（食い違うと `DIMENSION_MISMATCH`）。
 */
const DIMENSIONS = 256;

process.env.AWS_REGION = 'ap-northeast-1';
process.env.VECTOR_TABLE_NAME = 'test-inventory-vector';
process.env.QUERY_CACHE_TABLE_NAME = 'test-vector-query-cache';
process.env.VECTOR_EMBEDDING_DIMENSIONS = String(DIMENSIONS);
process.env.VECTOR_EMBEDDING_REQUESTS_PER_MINUTE = '600';
process.env.DYNAMODB_SEARCH_ENDPOINT = 'https://search-dynamodb.test.invalid';
process.env.OPENSEARCH_VECTOR_ENDPOINT = 'https://vector.test.invalid';
process.env.VECTOR_INDEX_NAME = 'inventory-vector';

type Handler = (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;

let embedHandler: Handler;
let dynamodbHandler: Handler;
let openSearchHandler: Handler;
let resetDescribeTableCache: () => void;

const fetchMock = vi.fn(async (_url: string, init: { body?: unknown }) => {
  seam.searchVectorsInputs.push(JSON.parse(String(init.body)) as Record<string, unknown>);

  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        SearchResults: [
          {
            Item: {
              itemId: { S: 'SKU-0' },
              warehouseId: { S: 'WH-TOKYO' },
              itemName: { S: '商品 SKU-0' },
              quantity: { N: '1' },
              location: { S: 'A-01' },
              unitPrice: { N: '100' },
            },
            Score: 0.1,
          },
        ],
        // `SearchVectors` の `ConsumedCapacity` はバイト単位の `VectorSearchRequestBytes` である。
        // `CapacityUnits` は存在しない
        ConsumedCapacity: { VectorSearchRequestBytes: 4608 },
      }),
  };
});

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchMock);

  const embedModule = await import('../vector-query-embed/handler');
  const dynamodbModule = await import('../vector-search-ddb/handler');
  const openSearchModule = await import('./handler');

  embedHandler = embedModule.handler;
  dynamodbHandler = dynamodbModule.handler;
  openSearchHandler = openSearchModule.handler;
  resetDescribeTableCache = dynamodbModule.resetDescribeTableCache;
});

beforeEach(() => {
  resetParity();
});

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function resetParity(): void {
  fetchMock.mockClear();
  resetDescribeTableCache?.();
  seam.cacheTable.clear();
  seam.invokeModelInputs.length = 0;
  seam.searchVectorsInputs.length = 0;
  seam.openSearchParams.length = 0;
  seam.indexDescriptions = [
    { IndexName: 'byEmbeddingJa', IndexStatus: 'ACTIVE', Backfilling: false, Dimensions: DIMENSIONS },
    { IndexName: 'byEmbeddingEn', IndexStatus: 'ACTIVE', Backfilling: false, Dimensions: DIMENSIONS },
  ];
}

function event(payload: unknown): APIGatewayProxyEvent {
  return { body: JSON.stringify(payload), isBase64Encoded: false } as unknown as APIGatewayProxyEvent;
}

function parseBody(result: APIGatewayProxyResult): Record<string, unknown> {
  return JSON.parse(result.body) as Record<string, unknown>;
}

/** 1〜30 文字の有効なクエリ文字列（空白を含まない） */
const queryArb = fc
  .array(fc.constantFrom('a', 'Z', '9', 'コ', 'ー', 'ヒ', '豆', 'é', '-', '_'), { minLength: 1, maxLength: 30 })
  .map((characters) => characters.join(''));

const languageArb = fc.constantFrom<'ja' | 'en'>('ja', 'en');

const warehouseIdArb = fc.option(fc.constantFrom('WH-TOKYO', 'WH-OSAKA', 'WH-FUKUOKA'), { nil: undefined });

// ---------------------------------------------------------------------------
// Property 23: クエリベクトル・k・言語の両バックエンド一致
// ---------------------------------------------------------------------------

describe('両バックエンド検索の同一性', () => {
  // Feature: vector-search-comparison, Property 23: 任意のクエリ文字列・任意の言語・
  // 任意の TopK・任意の倉庫指定に対して、DynamoDB_Vector_Lambda と OpenSearch_Vector_Lambda が
  // 使用するクエリベクトルは全要素が等しく、適用 k・言語・倉庫フィルタ条件も等しい。
  // 埋め込み生成の呼び出し回数は 1 回である。
  // **Validates: Requirements 9.3, 10.4, 11.11**
  it('同一 queryId から解決したベクトル・k・言語・倉庫条件が両バックエンドで一致する', async () => {
    await fc.assert(
      fc.asyncProperty(
        queryArb,
        languageArb,
        fc.integer({ min: 1, max: 20 }),
        warehouseIdArb,
        async (query, language, topK, warehouseId) => {
          resetParity();

          // ---- 埋め込み生成は 1 回だけ ----
          const embedResult = await embedHandler(event({ query, language }));
          const embedBody = parseBody(embedResult);

          expect(embedResult.statusCode).toBe(200);
          expect(seam.invokeModelInputs).toHaveLength(1);

          const queryId = embedBody.queryId as string;
          const searchRequest = { queryId, topK, ...(warehouseId === undefined ? {} : { warehouseId }) };

          // ---- 同一のハンドルを両バックエンドへ渡す ----
          const dynamodbResult = await dynamodbHandler(event(searchRequest));
          const openSearchResult = await openSearchHandler(event(searchRequest));

          expect(dynamodbResult.statusCode).toBe(200);
          expect(openSearchResult.statusCode).toBe(200);

          // 2 回検索しても埋め込み生成は増えない（ベクトルはキャッシュ経由で共有される）
          expect(seam.invokeModelInputs).toHaveLength(1);
          expect(seam.searchVectorsInputs).toHaveLength(1);
          expect(seam.openSearchParams).toHaveLength(1);

          const dynamodbInput = seam.searchVectorsInputs[0] as {
            SearchVector: { N: string }[];
            TopK: number;
            ExpressionAttributeValues?: Record<string, { S?: string }>;
          };

          const openSearchRequestBody = (seam.openSearchParams[0]?.body ?? {}) as {
            size?: number;
            query?: { knn?: Record<string, { vector?: number[]; k?: number; filter?: unknown }> };
          };
          const knn = openSearchRequestBody.query?.knn ?? {};
          const vectorField = Object.keys(knn)[0];
          const knnNode = knn[vectorField];

          // ---- クエリベクトルは全要素が等しい ----
          const dynamodbVector = dynamodbInput.SearchVector.map((element) => Number(element.N));
          const openSearchVector = knnNode?.vector ?? [];

          expect(dynamodbVector).toHaveLength(DIMENSIONS);
          expect(openSearchVector).toHaveLength(DIMENSIONS);
          expect(openSearchVector).toEqual(dynamodbVector);

          // ---- 適用 k が等しい ----
          const dynamodbBody = parseBody(dynamodbResult);
          const openSearchBody = parseBody(openSearchResult);

          expect(dynamodbInput.TopK).toBe(topK);
          expect(knnNode?.k).toBe(topK);
          expect(openSearchRequestBody.size).toBe(topK);
          expect(openSearchBody.appliedTopK).toBe(dynamodbBody.appliedTopK);
          expect(openSearchBody.requestedTopK).toBe(dynamodbBody.requestedTopK);

          // ---- 言語が等しく、埋め込み要求の言語と一致する ----
          expect(dynamodbBody.language).toBe(language);
          expect(openSearchBody.language).toBe(language);
          expect(embedBody.language).toBe(language);
          expect(vectorField).toBe(language === 'ja' ? 'embeddingJa' : 'embeddingEn');
          expect(dynamodbBody.indexName).toBe(language === 'ja' ? 'byEmbeddingJa' : 'byEmbeddingEn');

          // ---- 倉庫フィルタ条件が等しい ----
          if (warehouseId === undefined) {
            expect(dynamodbInput.ExpressionAttributeValues).toBeUndefined();
            expect(knnNode?.filter).toBeUndefined();
            expect(dynamodbBody.filterApplied).toEqual([]);
            expect(openSearchBody.filterApplied).toEqual([]);
            return;
          }

          expect(dynamodbInput.ExpressionAttributeValues?.[':wh']).toEqual({ S: warehouseId });
          expect(knnNode?.filter).toEqual({ bool: { filter: [{ term: { warehouseId } }] } });
          expect(dynamodbBody.filterApplied).toEqual([`warehouseId = "${warehouseId}"`]);
          expect(openSearchBody.filterApplied).toEqual(['warehouseId']);
        }
      ),
      { numRuns: 25 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 28: 入力検証失敗時の下流非実行（検索エンドポイント側）
// ---------------------------------------------------------------------------

describe('埋め込み生成が成立しない場合の下流非実行', () => {
  /** ハンドルを得られなかった場合に UI が持ちうる値 */
  const missingHandleArb = fc.oneof(
    fc.constant(undefined),
    fc.constant(''),
    fc.constant('   '),
    fc.uuid(),
    fc.string({ maxLength: 12 })
  );

  // Feature: vector-search-comparison, Property 28: 埋め込み生成が失敗した場合、
  // いずれの検索エンドポイントも呼ばれない（呼び出し回数は 0）。
  // 空白のみのクエリで埋め込みが失敗して `queryId` が発行されないことを確かめたうえで、
  // 発行されていないハンドル（未定義・空文字・未登録の UUID）で両検索を叩いても
  // `SearchVectors` と `_search` の呼び出し回数が 0 であることを検証する。
  // **Validates: Requirements 10.6, 16.8**
  it('発行されていないハンドルでは SearchVectors も _search も呼ばれない', async () => {
    await fc.assert(
      fc.asyncProperty(missingHandleArb, fc.integer({ min: 1, max: 20 }), async (queryId, topK) => {
        resetParity();

        // 空白のみのクエリでは埋め込みが失敗し、ハンドルが発行されない
        const embedResult = await embedHandler(event({ query: '　 \t\n', language: 'ja' }));
        expect(embedResult.statusCode).toBe(400);
        expect('queryId' in parseBody(embedResult)).toBe(false);
        expect(seam.invokeModelInputs).toHaveLength(0);
        expect(seam.cacheTable.size).toBe(0);

        const request = { topK, ...(queryId === undefined ? {} : { queryId }) };

        const dynamodbResult = await dynamodbHandler(event(request));
        const openSearchResult = await openSearchHandler(event(request));

        // どちらのバックエンドも下流を呼ばない
        expect(seam.searchVectorsInputs).toHaveLength(0);
        expect(seam.openSearchParams).toHaveLength(0);

        expect(dynamodbResult.statusCode).toBeGreaterThanOrEqual(400);
        expect(openSearchResult.statusCode).toBeGreaterThanOrEqual(400);
        expect('hits' in parseBody(dynamodbResult)).toBe(false);
        expect('hits' in parseBody(openSearchResult)).toBe(false);
      }),
      { numRuns: 25 }
    );
  });
});
