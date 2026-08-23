/**
 * Vector_Verification_Path（`vector-search-aoss/verify.ts`）の単体テスト（task 17.1）
 *
 * 検証するのは次の 4 点である。
 *
 * 1. **応答にベクトル本体が現れない**（要件 3.16 / Property 22）。突き合わせは Lambda 内で
 *    完結し、リクエストにもレスポンスにも 1,024 次元の数値配列が乗らない
 * 2. **AWS 呼び出しは `GetItem` と `_mget` の 2 種類のみ**（要件 3.13 / 17.15）。
 *    `SearchVectors` / `Query` / `Scan` / `_search` / `_count` を 1 度も呼ばない。
 *    Bedrock を呼ばない（要件 3.15）
 * 3. 要素単位の突き合わせ（要件 3.14）と検証対象の特定（要件 3.15）
 * 4. 集計と終了判定が `verification-summary.ts` の判定に従う（要件 3.17 / 3.18）
 *
 * ## モックの境界
 *
 * 実 AWS へは触れない。差し替えるのは `handler.test.ts` と同じ 4 モジュールである。
 * 検証経路は検索経路と**同一の Lambda**（`handler.ts`）が受けるため、テストも
 * `handler.ts` 越しに呼ぶ。これにより「API Gateway から届いたイベントが検証経路へ
 * 分岐すること」まで含めて固定できる。
 *
 * 要件: 3.13, 3.14, 3.15, 3.16, 3.17, 3.18, 4.5, 17.15
 * Property: 22, 58
 */

import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { vi } from 'vitest';

/** モックとテスト本体で共有する記録簿と応答の差し替え口 */
const seam = vi.hoisted(() => ({
  /** `GetItem` が返す Vector_Table のアイテム（itemId 単位）。未登録は「アイテム無し」 */
  tableItems: {} as Record<string, Record<string, unknown> | undefined>,
  /** `_mget` が返すドキュメント（`_id` 単位）。未登録は `found: false` */
  documents: {} as Record<string, { found: boolean; source?: Record<string, unknown> }>,
  /** DynamoDB へ送られたコマンド（種別と入力） */
  dynamoCommands: [] as { name: string; input: Record<string, unknown> }[],
  /** OpenSearch クライアントで呼ばれたメソッド名と引数 */
  openSearchCalls: [] as { method: string; params: unknown }[],
}));

vi.mock('@opensearch-project/opensearch', () => {
  class Client {
    constructor(readonly options: unknown) {}

    async mget(params: unknown): Promise<{ body: unknown }> {
      seam.openSearchCalls.push({ method: 'mget', params });
      const docs = ((params as { body?: { docs?: { _id: string }[] } }).body?.docs ?? []).map(
        (doc) => {
          const stored = seam.documents[doc._id];
          return stored === undefined
            ? { _id: doc._id, found: false }
            : { _id: doc._id, found: stored.found, _source: stored.source };
        }
      );
      return { body: { docs } };
    }

    async search(params: unknown): Promise<{ body: unknown }> {
      seam.openSearchCalls.push({ method: 'search', params });
      return { body: { took: 1, hits: { hits: [] } } };
    }

    async count(params: unknown): Promise<{ body: { count: number } }> {
      seam.openSearchCalls.push({ method: 'count', params });
      return { body: { count: 0 } };
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
    readonly commandName = 'GetItem';
    constructor(readonly input: Record<string, unknown>) {}
  }

  class DynamoDBClient {
    readonly config = {
      credentials: () => Promise.resolve({ accessKeyId: 'ak', secretAccessKey: 'sk' }),
    };

    async send(command: {
      commandName?: string;
      input: Record<string, unknown>;
    }): Promise<Record<string, unknown>> {
      seam.dynamoCommands.push({
        name: command.commandName ?? command.constructor.name,
        input: command.input,
      });

      const key = command.input.Key as { itemId?: { S?: string } } | undefined;
      const itemId = key?.itemId?.S ?? '';
      const item = seam.tableItems[itemId];
      return item === undefined ? {} : { Item: item };
    }
  }

  return { DynamoDBClient, GetItemCommand };
});

// ---------------------------------------------------------------------------
// 実行環境（動的 import より前に確定させる）
// ---------------------------------------------------------------------------

/** 次元数。要素単位の比較を見るだけなので小さい値でよい */
const DIMENSIONS = 4;

const INDEX_NAME = 'inventory-vector';
const VECTOR_TABLE_NAME = 'test-roasters-inventory-vector';

process.env.AWS_REGION = 'ap-northeast-1';
process.env.OPENSEARCH_VECTOR_ENDPOINT = 'https://vector.test.invalid';
process.env.VECTOR_INDEX_NAME = INDEX_NAME;
process.env.QUERY_CACHE_TABLE_NAME = 'test-vector-query-cache';
process.env.VECTOR_TABLE_NAME = VECTOR_TABLE_NAME;
process.env.VECTOR_EMBEDDING_DIMENSIONS = String(DIMENSIONS);

let handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;

beforeAll(async () => {
  ({ handler } = await import('./handler'));
});

beforeEach(() => {
  seam.tableItems = {};
  seam.documents = {};
  seam.dynamoCommands.length = 0;
  seam.openSearchCalls.length = 0;
});

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

import {
  MAX_VERIFICATION_ITEM_IDS,
  VERIFICATION_EMBEDDING_MODEL_ID,
  VERIFICATION_WAREHOUSE_ID,
  buildVectorDocumentId,
  compareStoredVectors,
  isVerificationRequest,
  parseVerificationRequest,
} from './verify';
import { EMBEDDING_MODEL_ID } from '../shared/vector/embedding-generator';
import type { VectorLanguage } from '../shared/vector/language';

function vector(seed: number): number[] {
  return Array.from({ length: DIMENSIONS }, (_, index) => Math.fround((seed + index) / 10));
}

/** Vector_Table のアイテム（`AttributeValue` 形式）を組み立てる */
function tableItem(options: {
  ja?: number[];
  en?: number[];
  model?: string;
  dimensions?: number;
}): Record<string, unknown> {
  const item: Record<string, unknown> = {
    embeddingModel: { S: options.model ?? VERIFICATION_EMBEDDING_MODEL_ID },
    embeddingDimensions: { N: String(options.dimensions ?? DIMENSIONS) },
  };
  if (options.ja !== undefined) {
    item.embeddingJa = { L: options.ja.map((value) => ({ N: String(value) })) };
  }
  if (options.en !== undefined) {
    item.embeddingEn = { L: options.en.map((value) => ({ N: String(value) })) };
  }
  return item;
}

/** OpenSearch のドキュメント `_source` を組み立てる */
function document(options: { ja?: number[]; en?: number[] }): {
  found: boolean;
  source: Record<string, unknown>;
} {
  const source: Record<string, unknown> = {};
  if (options.ja !== undefined) source.embeddingJa = options.ja;
  if (options.en !== undefined) source.embeddingEn = options.en;
  return { found: true, source };
}

/** 同一のベクトルを両バックエンドへ登録する（一致する状態を作る） */
function seedMatchingPair(itemId: string, ja: number[], en: number[]): void {
  seam.tableItems[itemId] = tableItem({ ja, en });
  seam.documents[buildVectorDocumentId(itemId, VERIFICATION_WAREHOUSE_ID)] = document({ ja, en });
}

function verifyEvent(payload: unknown): APIGatewayProxyEvent {
  return {
    resource: '/vector-search/verify',
    path: '/vector-search/verify',
    httpMethod: 'POST',
    body: JSON.stringify(payload),
  } as unknown as APIGatewayProxyEvent;
}

function parseBody(result: APIGatewayProxyResult): Record<string, unknown> {
  return JSON.parse(result.body) as Record<string, unknown>;
}

/** 数値配列（ベクトル本体）が含まれているか */
function containsNumberArray(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((element) => typeof element === 'number') || value.some(containsNumberArray);
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsNumberArray);
  }
  return false;
}

/** 発行された DynamoDB コマンド種別の一覧（重複を除く） */
function dynamoCommandNames(): string[] {
  const names: string[] = [];
  for (const command of seam.dynamoCommands) {
    if (names.indexOf(command.name) < 0) names.push(command.name);
  }
  return names;
}

/** 呼ばれた OpenSearch のメソッド名の一覧（重複を除く） */
function openSearchMethods(): string[] {
  const methods: string[] = [];
  for (const call of seam.openSearchCalls) {
    if (methods.indexOf(call.method) < 0) methods.push(call.method);
  }
  return methods;
}

// ---------------------------------------------------------------------------
// 定数の一致
// ---------------------------------------------------------------------------

describe('再掲した定数', () => {
  /**
   * `verify.ts` はモデル識別子を再掲している（`embedding-generator.ts` は
   * `@aws-sdk/client-bedrock-runtime` を取り込むため、Bedrock を呼ばない経路へ
   * import しない。要件 3.15）。両者の一致をここで固定する。
   */
  it('モデル識別子が embedding-generator.ts と一致する', () => {
    expect(VERIFICATION_EMBEDDING_MODEL_ID).toBe(EMBEDDING_MODEL_ID);
  });

  it('代表行の倉庫とドキュメント ID の規約が固定されている', () => {
    expect(VERIFICATION_WAREHOUSE_ID).toBe('WH-TOKYO');
    expect(buildVectorDocumentId('ITEM-1', 'WH-TOKYO')).toBe('ITEM-1#WH-TOKYO');
  });
});

// ---------------------------------------------------------------------------
// 経路の分岐
// ---------------------------------------------------------------------------

describe('isVerificationRequest', () => {
  it('検証経路のみを検証として扱う', () => {
    expect(isVerificationRequest({ resource: '/vector-search/verify', path: '' })).toBe(true);
    expect(isVerificationRequest({ resource: '', path: '/api/vector-search/verify' })).toBe(true);
    expect(isVerificationRequest({ resource: '/vector-search/verify/', path: '' })).toBe(true);
    expect(isVerificationRequest({ resource: '/vector-search/opensearch', path: '' })).toBe(false);
    expect(isVerificationRequest({ resource: '', path: '' })).toBe(false);
    expect(isVerificationRequest(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 突き合わせ（純関数）
// ---------------------------------------------------------------------------

describe('compareStoredVectors', () => {
  it('全次元が一致すれば MATCHED', () => {
    expect(compareStoredVectors(vector(1), vector(1), DIMENSIONS).outcome).toBe('MATCHED');
  });

  it('1 次元でも異なれば MISMATCHED（理由に不一致の次元のみを載せる）', () => {
    const table = vector(1);
    const collection = vector(1);
    collection[2] = Math.fround(collection[2] + 0.5);

    const comparison = compareStoredVectors(table, collection, DIMENSIONS);
    expect(comparison.outcome).toBe('MISMATCHED');
    expect(comparison.reason).toContain('VALUE_MISMATCH');
    expect(comparison.reason).toContain('第 2 次元');
  });

  it('次元数が設定値と異なれば MISMATCHED', () => {
    const comparison = compareStoredVectors([0.1, 0.2], [0.1, 0.2], DIMENSIONS);
    expect(comparison.outcome).toBe('MISMATCHED');
    expect(comparison.reason).toContain('DIMENSION_MISMATCH');
  });

  it('片側または両側が未格納なら MISSING', () => {
    expect(compareStoredVectors(vector(1), undefined, DIMENSIONS).reason).toContain(
      'MISSING_OPENSEARCH'
    );
    expect(compareStoredVectors(undefined, vector(1), DIMENSIONS).reason).toContain(
      'MISSING_DYNAMODB'
    );
    expect(compareStoredVectors(undefined, undefined, DIMENSIONS).outcome).toBe('MISSING');
  });
});

// ---------------------------------------------------------------------------
// リクエストの解釈
// ---------------------------------------------------------------------------

describe('parseVerificationRequest', () => {
  it('itemIds の重複と空白を落とし、既定で両言語を対象にする', () => {
    const parsed = parseVerificationRequest({ itemIds: ['A', ' A ', 'B', ''] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.itemIds).toEqual(['A', 'B']);
    expect(parsed.request.languages).toEqual(['ja', 'en']);
  });

  it('上限件数を超える itemIds を拒否する', () => {
    const itemIds = Array.from(
      { length: MAX_VERIFICATION_ITEM_IDS + 1 },
      (_, index) => `ITEM-${index}`
    );
    const parsed = parseVerificationRequest({ itemIds });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.errorCode).toBe('INVALID_QUERY');
  });

  it('ja / en 以外の言語を拒否する', () => {
    const parsed = parseVerificationRequest({ itemIds: ['A'], languages: ['fr'] });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.errorCode).toBe('INVALID_LANGUAGE');
  });
});

// ---------------------------------------------------------------------------
// エンドポイント（handler.ts 越し）
// ---------------------------------------------------------------------------

describe('POST /vector-search/verify', () => {
  it('全件一致のとき合格として COMPLETED を返し、GetItem と _mget のみを発行する', async () => {
    seedMatchingPair('ITEM-1', vector(1), vector(2));
    seedMatchingPair('ITEM-2', vector(3), vector(4));

    const result = await handler(verifyEvent({ itemIds: ['ITEM-1', 'ITEM-2'] }));
    const body = parseBody(result);

    expect(result.statusCode).toBe(200);
    expect(body.targetCount).toBe(4);
    expect(body.matchedCount).toBe(4);
    expect(body.mismatchedCount).toBe(0);
    expect(body.missingCount).toBe(0);
    expect(body.skippedCount).toBe(0);
    expect(body.consistent).toBe(true);
    expect(body.passed).toBe(true);
    expect(body.failedCount).toBe(0);
    expect(body.status).toBe('COMPLETED');
    expect(body.mismatchedKeys).toEqual([]);

    // 呼び出しは GetItem 2 回（itemId 単位）と `_mget` 1 回のみ。Bedrock は 0（要件 3.15）
    expect(body.calls).toEqual({ getItem: 2, mget: 1, bedrock: 0 });
    expect(dynamoCommandNames()).toEqual(['GetItem']);
    expect(openSearchMethods()).toEqual(['mget']);
  });

  it('言語別の集計を返し、言語別の和が合計と一致する', async () => {
    seedMatchingPair('ITEM-1', vector(1), vector(2));

    const body = parseBody(await handler(verifyEvent({ itemIds: ['ITEM-1'] })));
    const byLanguage = body.byLanguage as Record<VectorLanguage, Record<string, unknown>>;

    expect(byLanguage.ja.targetCount).toBe(1);
    expect(byLanguage.en.targetCount).toBe(1);
    expect(byLanguage.ja.passed).toBe(true);
    expect(byLanguage.en.passed).toBe(true);
    expect(
      (byLanguage.ja.matchedCount as number) + (byLanguage.en.matchedCount as number)
    ).toBe(body.matchedCount);
  });

  it('languages を指定すると当該言語のみを検証する', async () => {
    seedMatchingPair('ITEM-1', vector(1), vector(2));

    const body = parseBody(await handler(verifyEvent({ itemIds: ['ITEM-1'], languages: ['ja'] })));

    expect(body.requestedLanguages).toEqual(['ja']);
    expect(body.targetCount).toBe(1);
    expect(Object.keys(body.byLanguage as Record<string, unknown>)).toEqual(['ja']);
  });

  it('値が 1 次元でも異なる組を不一致として計上し、COMPLETED にしない', async () => {
    const ja = vector(1);
    const drifted = vector(1);
    drifted[1] = Math.fround(drifted[1] + 0.25);

    seam.tableItems['ITEM-1'] = tableItem({ ja, en: vector(2) });
    seam.documents[buildVectorDocumentId('ITEM-1', VERIFICATION_WAREHOUSE_ID)] = document({
      ja: drifted,
      en: vector(2),
    });

    const body = parseBody(await handler(verifyEvent({ itemIds: ['ITEM-1'] })));

    expect(body.targetCount).toBe(2);
    expect(body.matchedCount).toBe(1);
    expect(body.mismatchedCount).toBe(1);
    expect(body.failedCount).toBe(1);
    expect(body.passed).toBe(false);
    expect(body.status).toBe('VERIFICATION_FAILED');

    const keys = body.mismatchedKeys as { itemId: string; language: string; reason: string }[];
    expect(keys).toHaveLength(1);
    expect(keys[0].itemId).toBe('ITEM-1');
    expect(keys[0].language).toBe('ja');
    expect(keys[0].reason).toContain('VALUE_MISMATCH');
    // 識別子は 3 フィールドのみ（要件 3.16）
    expect(Object.keys(keys[0]).sort()).toEqual(['itemId', 'language', 'reason']);
  });

  it('OpenSearch 側にドキュメントが無い組を未格納として計上する', async () => {
    seam.tableItems['ITEM-1'] = tableItem({ ja: vector(1), en: vector(2) });

    const body = parseBody(await handler(verifyEvent({ itemIds: ['ITEM-1'] })));

    expect(body.targetCount).toBe(2);
    expect(body.missingCount).toBe(2);
    expect(body.mismatchedCount).toBe(0);
    expect(body.failedCount).toBe(2);
    expect(body.passed).toBe(false);
    const keys = body.mismatchedKeys as { reason: string }[];
    expect(keys).toHaveLength(2);
    expect(keys[0].reason).toContain('MISSING_OPENSEARCH');
  });

  it('OpenSearch 側の次元数が設定値と異なる組を不一致として計上する', async () => {
    seam.tableItems['ITEM-1'] = tableItem({ ja: vector(1) });
    seam.documents[buildVectorDocumentId('ITEM-1', VERIFICATION_WAREHOUSE_ID)] = document({
      ja: [0.1, 0.2],
    });

    const body = parseBody(await handler(verifyEvent({ itemIds: ['ITEM-1'], languages: ['ja'] })));

    expect(body.mismatchedCount).toBe(1);
    expect((body.mismatchedKeys as { reason: string }[])[0].reason).toContain('DIMENSION_MISMATCH');
  });

  it('モデル・次元数が現行設定と異なる組、およびベクトルが無い組を検証対象にしない', async () => {
    // モデルが異なる（再生成待ち）
    seam.tableItems['ITEM-1'] = tableItem({ ja: vector(1), en: vector(2), model: 'other-model' });
    // 次元数が異なる
    seam.tableItems['ITEM-2'] = tableItem({ ja: vector(1), en: vector(2), dimensions: 512 });
    // 当該言語のベクトルが無い
    seam.tableItems['ITEM-3'] = tableItem({ ja: vector(1) });
    // Vector_Table にアイテムが無い（ITEM-4 は未登録）

    const body = parseBody(
      await handler(verifyEvent({ itemIds: ['ITEM-1', 'ITEM-2', 'ITEM-3', 'ITEM-4'] }))
    );

    // 対象は ITEM-3 の ja だけ。残る 7 組は対象外
    expect(body.targetCount).toBe(1);
    expect(body.skippedCount).toBe(7);
    const byLanguage = body.byLanguage as Record<VectorLanguage, Record<string, unknown>>;
    expect(byLanguage.ja.skippedCount).toBe(3);
    expect(byLanguage.en.skippedCount).toBe(4);
  });

  it('検証対象が 0 件のときは _mget を発行しない', async () => {
    seam.tableItems['ITEM-1'] = tableItem({ model: 'other-model' });

    const body = parseBody(await handler(verifyEvent({ itemIds: ['ITEM-1'] })));

    expect(body.targetCount).toBe(0);
    expect(body.skippedCount).toBe(2);
    expect(body.calls).toEqual({ getItem: 1, mget: 0, bedrock: 0 });
    expect(openSearchMethods()).toEqual([]);
  });

  it('応答にベクトル本体（数値配列）が現れない', async () => {
    seedMatchingPair('ITEM-1', vector(1), vector(2));
    const mismatched = vector(3);
    mismatched[0] = Math.fround(mismatched[0] + 1);
    seam.tableItems['ITEM-2'] = tableItem({ ja: vector(3), en: vector(4) });
    seam.documents[buildVectorDocumentId('ITEM-2', VERIFICATION_WAREHOUSE_ID)] = document({
      ja: mismatched,
      en: vector(4),
    });

    const result = await handler(verifyEvent({ itemIds: ['ITEM-1', 'ITEM-2'] }));
    const body = parseBody(result);

    expect(body.mismatchedCount).toBe(1);
    // ベクトル属性名も数値配列も応答に現れない（Property 22）
    expect(result.body).not.toContain('embeddingJa');
    expect(result.body).not.toContain('embeddingEn');
    expect(containsNumberArray(body)).toBe(false);
  });

  it('リクエストに載せた余分なフィールドを解釈にも応答にも使わない', async () => {
    seedMatchingPair('ITEM-1', vector(1), vector(2));

    const result = await handler(
      verifyEvent({
        itemIds: ['ITEM-1'],
        // 検証経路はベクトル本体を受け取らない（要件 3.16）
        expectedVectors: { ja: vector(1), en: vector(2) },
      })
    );

    expect(result.statusCode).toBe(200);
    expect(result.body).not.toContain('expectedVectors');
    expect(containsNumberArray(parseBody(result))).toBe(false);
  });

  it('GetItem は Vector_Table の代表行のみを強整合で読む', async () => {
    seedMatchingPair('ITEM-1', vector(1), vector(2));
    await handler(verifyEvent({ itemIds: ['ITEM-1'] }));

    expect(seam.dynamoCommands).toHaveLength(1);
    const input = seam.dynamoCommands[0].input;
    expect(input.TableName).toBe(VECTOR_TABLE_NAME);
    expect(input.Key).toEqual({
      itemId: { S: 'ITEM-1' },
      warehouseId: { S: VERIFICATION_WAREHOUSE_ID },
    });
    expect(input.ConsistentRead).toBe(true);
    expect(String(input.ProjectionExpression)).toBe(
      '#embeddingJa, #embeddingEn, #embeddingModel, #embeddingDimensions'
    );
  });

  it('_mget は 1 回だけ発行し、対象ドキュメントの _id と両言語の _source を指定する', async () => {
    seedMatchingPair('ITEM-1', vector(1), vector(2));
    seedMatchingPair('ITEM-2', vector(3), vector(4));

    await handler(verifyEvent({ itemIds: ['ITEM-1', 'ITEM-2'] }));

    expect(seam.openSearchCalls).toHaveLength(1);
    const params = seam.openSearchCalls[0].params as {
      index: string;
      body: { docs: { _id: string; _source: string[] }[] };
    };
    expect(params.index).toBe(INDEX_NAME);
    expect(params.body.docs.map((doc) => doc._id)).toEqual([
      'ITEM-1#WH-TOKYO',
      'ITEM-2#WH-TOKYO',
    ]);
    for (const doc of params.body.docs) {
      expect(doc._source).toEqual(['embeddingJa', 'embeddingEn']);
    }
  });

  it('itemIds が無いリクエストを 400 で拒否し、AWS を 1 度も呼ばない', async () => {
    const result = await handler(verifyEvent({}));

    expect(result.statusCode).toBe(400);
    expect(parseBody(result).errorCode).toBe('INVALID_QUERY');
    expect(seam.dynamoCommands).toHaveLength(0);
    expect(seam.openSearchCalls).toHaveLength(0);
  });

  it('上限件数を超える itemIds を 400 で拒否する', async () => {
    const itemIds = Array.from(
      { length: MAX_VERIFICATION_ITEM_IDS + 1 },
      (_, index) => `ITEM-${index}`
    );

    const result = await handler(verifyEvent({ itemIds }));

    expect(result.statusCode).toBe(400);
    expect(seam.dynamoCommands).toHaveLength(0);
  });
});
