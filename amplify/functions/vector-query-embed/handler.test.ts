/**
 * Query_Embedding_Lambda（`vector-query-embed/handler.ts`）の property テスト（task 8.8）
 *
 * 検証対象は Correctness Property 22（応答へのベクトル非漏洩）のうち埋め込みエンドポイント分、
 * Property 28（入力検証失敗時の下流非実行）、Property 29（既定でのキャッシュ無効）。
 *
 * ## モックの境界
 *
 * AWS への実呼び出しは行わない。差し替えるのは **SDK クライアント 2 つだけ**である。
 *
 * - `@aws-sdk/client-bedrock-runtime`: `BedrockRuntimeClient.send()` を数え上げるスタブへ置く。
 *   `embedding-generator.ts` は素のまま動くため、「Bedrock 呼び出し回数」は
 *   実装が実際に発行した `InvokeModel` の回数そのものである（Property 28 / 29 の観測点）
 * - `@aws-sdk/client-dynamodb`: `PutItem` の入力を記録するスタブへ置く。
 *   `marshall()` は実物を使うため、保管されたベクトルの形もそのまま観測できる
 *
 * `handler.ts` はモジュール読み込み時に次元数と `EmbeddingGenerator` を確定するため、
 * 環境変数を設定したうえで **動的 import** する。呼び出しレートは上限の 600 リクエスト/分へ
 * 上げてある（実装のレート制御は実時間で待つため、テスト内で待たせない）。
 *
 * 要件: 10.3, 10.6, 10.7, 10.9, 10.10, 16.8
 * Property: 22, 28, 29
 */

import fc from 'fast-check';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

/** モックとテスト本体で共有する記録簿。`vi.mock` のファクトリより先に評価される */
const recorder = vi.hoisted(() => ({
  /** `InvokeModelCommand` の入力（= Bedrock 呼び出し 1 回に相当） */
  invokeModelInputs: [] as { modelId?: unknown; body?: unknown; performanceConfigLatency?: unknown }[],
  /** `PutItemCommand` の入力（= Query_Vector_Cache への保管 1 回に相当） */
  putItemInputs: [] as { TableName?: unknown; Item?: Record<string, unknown> }[],
}));

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class InvokeModelCommand {
    constructor(readonly input: { modelId?: unknown; body?: unknown; performanceConfigLatency?: unknown }) {}
  }

  class BedrockRuntimeClient {
    async send(command: InvokeModelCommand): Promise<{ body: Uint8Array }> {
      recorder.invokeModelInputs.push(command.input);

      // 要求本文の `dimensions` をそのまま返す。次元数の解決経路を実装に委ねる
      const request: unknown = JSON.parse(new TextDecoder().decode(command.input.body as Uint8Array));
      const dimensions =
        typeof request === 'object' && request !== null && typeof (request as { dimensions?: unknown }).dimensions === 'number'
          ? ((request as { dimensions: number }).dimensions)
          : 0;

      // 単位長に近い決定的なベクトル。値そのものは本テストの対象ではない
      const embedding = Array.from({ length: dimensions }, (_, index) => (index + 1) / dimensions);

      // `jsdom` 環境では `TextEncoder` が別レルムの `Uint8Array` を返し、
      // 実装側の `body instanceof Uint8Array` が偽になる。現レルムへ写して渡す
      return {
        body: Uint8Array.from(new TextEncoder().encode(JSON.stringify({ embedding, inputTextTokenCount: 7 }))),
      };
    }
  }

  return { BedrockRuntimeClient, InvokeModelCommand };
});

vi.mock('@aws-sdk/client-dynamodb', () => {
  class PutItemCommand {
    constructor(readonly input: { TableName?: unknown; Item?: Record<string, unknown> }) {}
  }

  class DynamoDBClient {
    readonly config = { credentials: () => Promise.resolve({ accessKeyId: 'ak', secretAccessKey: 'sk' }) };

    async send(command: PutItemCommand): Promise<Record<string, never>> {
      recorder.putItemInputs.push(command.input);
      return {};
    }
  }

  return { DynamoDBClient, PutItemCommand };
});

// ---------------------------------------------------------------------------
// 実行環境（動的 import より前に確定させる）
// ---------------------------------------------------------------------------

/** Titan Text Embeddings V2 が受理する最小の次元数。反復回数が多いテストを軽くする */
const DIMENSIONS = 256;

/** 前処理後のクエリ文字列の上限（実装の `MAX_QUERY_LENGTH` と同値を設計から書き下す） */
const MAX_QUERY_LENGTH = 1_000;

const QUERY_CACHE_TABLE_NAME = 'test-vector-query-cache';

process.env.AWS_REGION = 'ap-northeast-1';
process.env.QUERY_CACHE_TABLE_NAME = QUERY_CACHE_TABLE_NAME;
process.env.VECTOR_EMBEDDING_DIMENSIONS = String(DIMENSIONS);
process.env.VECTOR_EMBEDDING_REQUESTS_PER_MINUTE = '600';

let handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;

beforeAll(async () => {
  ({ handler } = await import('./handler'));
});

beforeEach(() => {
  recorder.invokeModelInputs.length = 0;
  recorder.putItemInputs.length = 0;
});

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

/** ハンドラが読むのは `body` と `isBase64Encoded` のみ。他の項目は使われない */
function embedEvent(payload: unknown): APIGatewayProxyEvent {
  return { body: JSON.stringify(payload), isBase64Encoded: false } as unknown as APIGatewayProxyEvent;
}

function parseBody(result: APIGatewayProxyResult): Record<string, unknown> {
  return JSON.parse(result.body) as Record<string, unknown>;
}

/** 空白文字のみで構成される文字列（半角・全角スペース、タブ、改行、CR の任意の組み合わせ） */
const blankQueryArb = fc
  .array(fc.constantFrom(' ', '\u3000', '\t', '\n', '\r'), { minLength: 1, maxLength: 24 })
  .map((characters) => characters.join(''));

/** 空白を含まない文字。前処理で長さが縮まないため文字数の境界を厳密に作れる */
const NON_BLANK_CHARACTERS = ['a', 'Z', '9', 'コ', 'ー', 'ヒ', '豆', 'é', '-', '_'] as const;

/** 1〜30 文字の有効なクエリ文字列 */
const queryArb = fc
  .array(fc.constantFrom(...NON_BLANK_CHARACTERS), { minLength: 1, maxLength: 30 })
  .map((characters) => characters.join(''));

/** 前処理後に上限を超える文字列（空白を含まないので長さがそのまま残る） */
const tooLongQueryArb = fc
  .tuple(fc.integer({ min: MAX_QUERY_LENGTH + 1, max: MAX_QUERY_LENGTH + 120 }), fc.constantFrom(...NON_BLANK_CHARACTERS))
  .map(([length, character]) => character.repeat(length));

/** `ja` / `en` 以外の言語指定。文字列以外の型も混ぜる */
const invalidLanguageArb = fc
  .oneof(
    fc.constantFrom('JA', 'EN', 'ja-JP', 'en-US', 'jp', 'eng', 'fr', '', ' ja', 'ja '),
    fc.string({ maxLength: 8 }),
    fc.constantFrom(null, undefined, 0, 1, true, false),
    fc.constant(['ja']),
    fc.constant({ language: 'ja' })
  )
  .filter((value) => value !== 'ja' && value !== 'en');

const languageArb = fc.constantFrom('ja', 'en');

// ---------------------------------------------------------------------------
// Property 28: 入力検証失敗時の下流非実行
// ---------------------------------------------------------------------------

describe('vector-query-embed handler / 入力検証', () => {
  // Feature: vector-search-comparison, Property 28: 任意の空白文字のみで構成される文字列、
  // 任意の前処理後 1,000 文字超過の文字列、および任意の `ja` / `en` 以外の言語指定文字列に対して、
  // Bedrock 呼び出し回数は 0 であり、いずれの検索エンドポイントも呼ばれない。
  // 検索エンドポイントが呼ばれないことは、応答に `queryId` が存在せず
  // Query_Vector_Cache への保管も発生しないこと（= 検索へ渡すハンドルが生成されないこと）として検証する。
  // **Validates: Requirements 10.6, 10.7, 10.9, 11.9, 16.8**
  it('空白のみ・上限超過・未対応言語のいずれでも Bedrock を呼ばず queryId を発行しない', async () => {
    const invalidRequestArb = fc.oneof(
      // 空白のみ（言語は有効）。空値判定が言語判定より先に働く
      fc.record({ query: blankQueryArb, language: languageArb }).map((request) => ({
        ...request,
        expectedErrorCode: 'INVALID_QUERY',
      })),
      // 前処理後 1,000 文字超過（言語は有効）
      fc.record({ query: tooLongQueryArb, language: languageArb }).map((request) => ({
        ...request,
        expectedErrorCode: 'QUERY_TOO_LONG',
      })),
      // ja / en 以外の言語指定（クエリは有効）
      fc.record({ query: queryArb, language: invalidLanguageArb }).map((request) => ({
        ...request,
        expectedErrorCode: 'INVALID_LANGUAGE',
      }))
    );

    await fc.assert(
      fc.asyncProperty(invalidRequestArb, async ({ query, language, expectedErrorCode }) => {
        recorder.invokeModelInputs.length = 0;
        recorder.putItemInputs.length = 0;

        const result = await handler(embedEvent({ query, language }));
        const body = parseBody(result);

        // Bedrock 呼び出し回数は 0
        expect(recorder.invokeModelInputs).toHaveLength(0);
        // クエリベクトルの保管も発生しない（= 検索へ渡せるハンドルが存在しない）
        expect(recorder.putItemInputs).toHaveLength(0);

        expect(result.statusCode).toBe(400);
        expect(body.errorCode).toBe(expectedErrorCode);
        expect(body.stage).toBe('EMBEDDING');
        expect('queryId' in body).toBe(false);
      }),
      { numRuns: 60 }
    );
  });

  // Feature: vector-search-comparison, Property 28（境界）: 境界の 1,000 文字は受理される。
  // **Validates: Requirements 10.9**
  it('前処理後ちょうど 1,000 文字は受理して Bedrock を 1 回呼ぶ', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...NON_BLANK_CHARACTERS), languageArb, async (character, language) => {
        recorder.invokeModelInputs.length = 0;
        recorder.putItemInputs.length = 0;

        const result = await handler(embedEvent({ query: character.repeat(MAX_QUERY_LENGTH), language }));
        const body = parseBody(result);

        expect(result.statusCode).toBe(200);
        expect(typeof body.queryId).toBe('string');
        expect(recorder.invokeModelInputs).toHaveLength(1);
        expect(recorder.putItemInputs).toHaveLength(1);
      }),
      { numRuns: 10 }
    );
  });

  // Feature: vector-search-comparison, Property 28（生成失敗時）: 埋め込み生成が失敗した場合も
  // 検索エンドポイントの呼び出し回数は 0 である。ここでは「保管が失敗して queryId を返せない」
  // 経路を、`PutItem` の失敗として観測する。
  // **Validates: Requirements 16.8**
  it('クエリベクトルを保管できなかった場合は queryId を返さない', async () => {
    const { DynamoDBClient } = (await import('@aws-sdk/client-dynamodb')) as unknown as {
      DynamoDBClient: { prototype: { send: (command: unknown) => Promise<unknown> } };
    };
    const send = vi
      .spyOn(DynamoDBClient.prototype, 'send')
      .mockRejectedValue(Object.assign(new Error('put failed'), { name: 'InternalServerError' }));

    try {
      const result = await handler(embedEvent({ query: 'コーヒー豆', language: 'ja' }));
      const body = parseBody(result);

      expect(send).toHaveBeenCalledTimes(1);
      expect(result.statusCode).toBeGreaterThanOrEqual(400);
      expect('queryId' in body).toBe(false);
      expect(body.stage).toBe('EMBEDDING');
    } finally {
      send.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Property 29: 既定でのキャッシュ無効
// ---------------------------------------------------------------------------

describe('vector-query-embed handler / キャッシュ既定', () => {
  // Feature: vector-search-comparison, Property 29: 任意のクエリ文字列・任意の言語・
  // 任意の反復回数 n に対して、キャッシュ無効の既定設定では Bedrock の埋め込み生成
  // 呼び出し回数が n と等しい。
  // **Validates: Requirements 10.10**
  it('同一クエリ・同一言語を n 回繰り返しても Bedrock 呼び出し回数が n になる', async () => {
    await fc.assert(
      fc.asyncProperty(queryArb, languageArb, fc.integer({ min: 1, max: 4 }), async (query, language, n) => {
        recorder.invokeModelInputs.length = 0;
        recorder.putItemInputs.length = 0;

        const queryIds: string[] = [];

        for (let attempt = 0; attempt < n; attempt += 1) {
          const result = await handler(embedEvent({ query, language }));
          const body = parseBody(result);

          expect(result.statusCode).toBe(200);
          expect(body.cacheHit).toBe(false);
          expect(body.language).toBe(language);
          expect(body.dimensions).toBe(DIMENSIONS);
          queryIds.push(body.queryId as string);
        }

        // 呼び出し回数が反復回数と一致する（キャッシュによる省略が起きない）
        expect(recorder.invokeModelInputs).toHaveLength(n);
        expect(recorder.putItemInputs).toHaveLength(n);

        // ハンドルは毎回新規発行される（同一クエリでも共有されない）
        expect(Array.from(new Set(queryIds))).toHaveLength(n);

        // レイテンシ最適化推論を使う（要件 10.1）。呼び出しごとに同一の設定である
        for (const input of recorder.invokeModelInputs) {
          expect(input.performanceConfigLatency).toBe('optimized');
        }
      }),
      { numRuns: 20 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 22: 応答へのベクトル非漏洩（埋め込みエンドポイント）
// ---------------------------------------------------------------------------

describe('vector-query-embed handler / 応答内容', () => {
  // Feature: vector-search-comparison, Property 22: 任意のクエリベクトルに対して、
  // 埋め込みエンドポイントの応答に日本語ベクトルおよび英語ベクトルの属性名と本体
  // （次元数と同じ長さの数値配列）が現れない。
  // **Validates: Requirements 8.8, 9.1, 10.3**
  it('応答にベクトル属性名も数値配列も現れない（ベクトルはキャッシュ側にのみ存在する）', async () => {
    await fc.assert(
      fc.asyncProperty(queryArb, languageArb, async (query, language) => {
        recorder.invokeModelInputs.length = 0;
        recorder.putItemInputs.length = 0;

        const result = await handler(embedEvent({ query, language }));
        const body = parseBody(result);

        expect(result.statusCode).toBe(200);

        // 応答の項目は設計が定める 7 項目のみ（`inferencePath` は task 18.1 で追加）
        expect(Object.keys(body).sort()).toEqual(
          [
            'cacheHit',
            'dimensions',
            'embeddingLatencyMs',
            'inferencePath',
            'language',
            'model',
            'queryId',
          ].sort()
        );

        // 属性名が文字列としても現れない
        expect(result.body).not.toContain('embeddingJa');
        expect(result.body).not.toContain('embeddingEn');

        // 数値配列（= ベクトル本体）を持つ項目が 1 つも無い
        for (const value of Object.values(body)) {
          expect(Array.isArray(value)).toBe(false);
        }

        // 一方でベクトルは生成され、Query_Vector_Cache へ次元数どおりの長さで保管されている。
        // 「応答に載っていない」ことが「生成していない」ことに退化していないのを確かめる
        const stored = recorder.putItemInputs[0]?.Item as { vector?: { L?: unknown[] } } | undefined;
        expect(stored?.vector?.L).toHaveLength(DIMENSIONS);
      }),
      { numRuns: 20 }
    );
  });
});
