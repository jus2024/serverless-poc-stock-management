/**
 * `vector-embed-batch/handler.ts` の property テスト（task 8.9）
 *
 * 検証対象は Correctness Property 7 / 8 / 9 / 10 / 13 / 14。
 *
 * ## 実 AWS を呼ばないための方針
 *
 * バッチは DynamoDB・Bedrock・OpenSearch の 3 つに依存する。3 つとも**インメモリの代替実装**へ
 * 差し替える。単に `send()` を `vi.fn()` にするだけでは Property 8（両バックエンドの格納値の一致）と
 * Property 10（片側失敗時の状態復元）が検証できない。「書き込んだ結果として何が残ったか」を
 * 読み出して比較する必要があるためである。したがって代替実装は**状態を持つ**。
 *
 * - `FakeDynamoDb`: `PutItem` / `UpdateItem`（`SET` / `REMOVE`）/ `BatchWriteItem` / `Query` /
 *   `Scan` / `GetItem` をアイテムの Map に対して適用する。全コマンドを記録するため、
 *   Property 7 の「Good_Table 宛の書き込みコマンドが 1 件も無い」を呼び出し列の走査で判定できる
 * - `FakeOpenSearch`: `_bulk` の `index` / `delete` と `get` をドキュメントの Map に適用する
 * - 埋め込み生成は `EmbeddingTransport` のみを差し替え、`EmbeddingGenerator` の**実装は本物を使う**。
 *   f32 丸め・切り詰め・レート制御・バックオフが実物でなければ Property 8 が意味を持たない
 *
 * 時計も注入する。スロットリング再試行のバックオフ（1〜16 秒）を実時間で待つと 100 回反復が
 * 完走しないため、`sleep()` が仮想時刻を進めるだけの時計を `EmbeddingGenerator` へ渡す。
 *
 * ## 件数ゲート（15,000 件）の扱い
 *
 * 要件 1.7 のゲートは Vector_Table が厳密に 15,000 件であることを要求する。1 反復ごとに
 * 15,000 レコードを構築すると property テストが成立しないため、`Select: 'COUNT'` の `Scan` が
 * 返す件数だけを `reportedRecordCount` として独立に設定できるようにした。ゲートの入力は
 * この 1 つの経路（COUNT の `Scan`）に閉じているため、少数の SKU で本体の挙動を検証しつつ、
 * ゲートの分岐は任意の件数に対して直接検証できる。
 *
 * 要件: 1.4, 1.7, 3.4, 3.5, 3.6, 3.9, 3.10, 4.3, 4.5, 4.8, 4.9, 10.2
 * Property: 7, 8, 9, 10, 13, 14
 */

import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { APIGatewayProxyResult, APIGatewayProxyEvent } from 'aws-lambda';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================
// モックの注入点
// ============================================================

/**
 * 差し替え先を保持する可変フック。
 *
 * `vi.mock()` のファクトリは巻き上げられるため、テスト本体で作る代替実装を直接参照できない。
 * フックだけを巻き上げておき、`beforeEach` で毎回新しい代替実装へ差し替える。
 */
const hooks = vi.hoisted(() => ({
  dynamoSend: (_command: unknown): Promise<unknown> =>
    Promise.reject(new Error('FakeDynamoDb is not installed')),
  lambdaSend: (_command: unknown): Promise<unknown> =>
    Promise.reject(new Error('self invoke must not happen in these tests')),
  openSearchBulk: (_params: unknown): Promise<unknown> =>
    Promise.reject(new Error('FakeOpenSearch is not installed')),
  /** Vector_Collection への読み出し。要件 3.12 によりバッチからは 1 回も呼ばれてはならない */
  openSearchRead: (_operation: string, _params: unknown): Promise<unknown> =>
    Promise.reject(new Error('FakeOpenSearch is not installed')),
  embeddingInvoke: (_invocation: unknown): Promise<unknown> =>
    Promise.reject(new Error('embedding transport is not installed')),
  clockNow: (): number => 0,
  clockSleep: (_ms: number): Promise<void> => Promise.resolve(),
}));

vi.mock('@aws-sdk/client-dynamodb', async (importOriginal) => {
  // コマンドクラスは本物を使う（`input` の組み立て規則まで含めて実装を検証したいため）
  const actual = await importOriginal<typeof import('@aws-sdk/client-dynamodb')>();
  return {
    ...actual,
    DynamoDBClient: class {
      send(command: unknown): Promise<unknown> {
        return hooks.dynamoSend(command);
      }
    },
  };
});

vi.mock('@aws-sdk/client-lambda', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-lambda')>();
  return {
    ...actual,
    LambdaClient: class {
      send(command: unknown): Promise<unknown> {
        return hooks.lambdaSend(command);
      }
    },
  };
});

/**
 * OpenSearch クライアントの代替。
 *
 * **読み出し系のメソッドも用意しておく。**取り除けばハンドラが呼んだ瞬間に
 * `TypeError` で落ちるが、それでは「呼ばれたことが記録されない」ため
 * 「読み出し呼び出し回数 0」（要件 3.12 / Property 8）を件数として検査できない。
 * 呼ばれたら記録した上で拒否する形にして、回数を数えられるようにする。
 */
vi.mock('@opensearch-project/opensearch', () => ({
  Client: class {
    bulk(params: unknown): Promise<unknown> {
      return hooks.openSearchBulk(params);
    }
    get(params: unknown): Promise<unknown> {
      return hooks.openSearchRead('get', params);
    }
    mget(params: unknown): Promise<unknown> {
      return hooks.openSearchRead('mget', params);
    }
    search(params: unknown): Promise<unknown> {
      return hooks.openSearchRead('search', params);
    }
  },
}));

vi.mock('@opensearch-project/opensearch/aws', () => ({
  AwsSigv4Signer: () => ({}),
}));

vi.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: () => () => Promise.resolve({ accessKeyId: 'test', secretAccessKey: 'test' }),
}));

vi.mock('../shared/vector/embedding-generator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/vector/embedding-generator')>();
  return {
    ...actual,
    // ハンドラは transport / clock を渡さないため、生成の入口だけを包んで注入する。
    // 丸め・切り詰め・レート制御・バックオフの実装は本物のまま通る
    createEmbeddingGenerator: (options: Record<string, unknown> = {}) =>
      new actual.EmbeddingGenerator({
        ...options,
        transport: { invoke: (invocation: unknown) => hooks.embeddingInvoke(invocation) },
        clock: { now: () => hooks.clockNow(), sleep: (ms: number) => hooks.clockSleep(ms) },
      } as ConstructorParameters<typeof actual.EmbeddingGenerator>[0]),
  };
});

import { BATCH_MAX_RETRIES } from '../shared/vector/embedding-generator';
import { buildEmbeddingText, truncateForEmbedding } from '../shared/vector/embedding-text';
import { VECTOR_LANGUAGES, resolveVectorField, type VectorLanguage } from '../shared/vector/language';
import { deriveSkuMetadata } from '../shared/vector/sku-metadata';
import {
  EXPECTED_VECTOR_RECORD_COUNT,
  SKU_LIST_WAREHOUSE,
  WAREHOUSES,
  buildVectorDocumentId,
  compareStoredVectors,
  handler,
  shouldSkipLanguage,
} from './handler';

// ============================================================
// 期待値の定義（実装の定数を写さず、設計書から書き下す）
// ============================================================

/** 設計が定める倉庫数。1 SKU は 3 レコードになる（要件 3.5 / Property 9） */
const WAREHOUSE_COUNT = 3;

/** 設計が定める言語数。1 SKU は 2 本のベクトルを持つ（要件 3.4 / Property 9） */
const LANGUAGE_COUNT = 2;

/** 要件 1.4 が禁じる Good_Table 宛の書き込みコマンド */
const WRITE_COMMAND_NAMES = [
  'PutItemCommand',
  'UpdateItemCommand',
  'DeleteItemCommand',
  'BatchWriteItemCommand',
] as const;

/** 補償で消える 5 属性（要件 3.10 / Property 10）。実装の定数は非公開なので設計書から書き下す */
const EMBEDDING_ATTRIBUTES = [
  'embeddingJa',
  'embeddingEn',
  'embeddingModel',
  'embeddingDimensions',
  'embeddingUpdatedAt',
] as const;

const GOOD_TABLE_NAME = 'kiro-roasters-inventory-good';
const VECTOR_TABLE_NAME = 'kiro-roasters-inventory-vector';
const EXECUTIONS_TABLE_NAME = 'load-test-executions';

/** テストで適用する次元数。256 は実装が受理する 3 値のうち最小（反復回数を稼ぐため） */
const TEST_DIMENSIONS = 256;

/**
 * 応答に載る失敗一覧の上限件数（設計「Embedding_Batch_Job / 出力」）。
 *
 * 実装の定数は非公開なので設計書から書き下す。件数そのものは上限なく数えるため、
 * この値は「一覧に残る件数」の上限であり「失敗件数」の上限ではない。
 */
const MAX_REPORTED_FAILURES = 100;

/** 主キーの構成。フェイクがキーを組むために使う */
const TABLE_KEY_ATTRIBUTES: Record<string, readonly string[]> = {
  [GOOD_TABLE_NAME]: ['itemId', 'warehouseId'],
  [VECTOR_TABLE_NAME]: ['itemId', 'warehouseId'],
  [EXECUTIONS_TABLE_NAME]: ['executionId'],
};

// ============================================================
// エラー生成（`errors.ts` の分類規則に載る形で作る）
// ============================================================

/** 再試行不可として分類される失敗。反復のたびにバックオフを待たせないために使う */
function validationError(detail = 'injected validation failure'): Error {
  return Object.assign(new Error(detail), { name: 'ValidationException' });
}

/** 再試行可（`THROTTLED`）として分類される失敗 */
function throttlingError(): Error {
  return Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
}

/** 条件付き書き込みの失敗 */
function conditionalCheckFailed(): Error {
  return Object.assign(new Error('The conditional request failed'), {
    name: 'ConditionalCheckFailedException',
  });
}

// ============================================================
// FakeDynamoDb
// ============================================================

type Item = Record<string, AttributeValue>;

/** 記録した 1 コマンド。Property 7 の走査対象 */
interface RecordedCall {
  readonly name: string;
  readonly tableNames: readonly string[];
  readonly input: Record<string, unknown>;
}

/** 属性名プレースホルダ（`#name`）を解決する */
function resolveAttributeName(token: string, names: Record<string, string> | undefined): string {
  const trimmed = token.trim();
  if (!trimmed.startsWith('#')) return trimmed;
  return names?.[trimmed] ?? trimmed.slice(1);
}

/** `SET` / `REMOVE` のみを解釈する最小の更新式アプライヤ */
function applyUpdateExpression(
  item: Item,
  expression: string,
  names: Record<string, string> | undefined,
  values: Record<string, AttributeValue> | undefined
): void {
  const trimmed = expression.trim();

  if (trimmed.startsWith('SET ')) {
    for (const assignment of trimmed.slice(4).split(',')) {
      const [lhs, rhs] = assignment.split('=');
      if (lhs === undefined || rhs === undefined) throw new Error(`bad assignment: ${assignment}`);
      const value = values?.[rhs.trim()];
      if (value === undefined) throw new Error(`unbound value: ${rhs.trim()}`);
      item[resolveAttributeName(lhs, names)] = value;
    }
    return;
  }

  if (trimmed.startsWith('REMOVE ')) {
    for (const token of trimmed.slice(7).split(',')) {
      delete item[resolveAttributeName(token, names)];
    }
    return;
  }

  throw new Error(`unsupported update expression: ${expression}`);
}

/** `attribute_exists` / `attribute_not_exists` のみを解釈する */
function assertCondition(
  condition: string | undefined,
  names: Record<string, string> | undefined,
  existing: Item | undefined
): void {
  if (condition === undefined) return;

  const exists = /^attribute_exists\((.+)\)$/.exec(condition.trim());
  if (exists !== null) {
    resolveAttributeName(exists[1], names);
    if (existing === undefined) throw conditionalCheckFailed();
    return;
  }

  const notExists = /^attribute_not_exists\((.+)\)$/.exec(condition.trim());
  if (notExists !== null) {
    resolveAttributeName(notExists[1], names);
    if (existing !== undefined) throw conditionalCheckFailed();
    return;
  }

  throw new Error(`unsupported condition expression: ${condition}`);
}

/** 単一値の等価条件（`#a = :b`）から値のプレースホルダ名を取り出す */
function equalityValuePlaceholder(expression: string): string {
  const match = /=\s*(:[A-Za-z0-9_]+)\s*$/.exec(expression.trim());
  if (match === null) throw new Error(`unsupported key/filter expression: ${expression}`);
  return match[1];
}

/**
 * インメモリの DynamoDB。ハンドラが実際に発行するコマンドだけを実装する。
 *
 * 射影（`ProjectionExpression`）は無視してアイテム全体を返す。射影の内容そのものは
 * Property 22（応答へのベクトル非漏洩、task 8.8）の担当であり、本タスクの
 * 6 プロパティはいずれも「格納された値」を問うためである。
 */
class FakeDynamoDb {
  readonly tables = new Map<string, Map<string, Item>>();
  readonly calls: RecordedCall[] = [];

  /** `Select: 'COUNT'` の `Scan` が返す件数（要件 1.7 のゲート入力） */
  reportedRecordCount = EXPECTED_VECTOR_RECORD_COUNT;

  /** 失敗注入。`undefined` を返せば通常処理へ進む */
  failure: ((call: RecordedCall, index: number) => Error | undefined) | undefined;

  /**
   * `GetItem` の応答を書き換えるフック（要件 3.6 / 3.18 の検証経路を落とすために使う）。
   *
   * 書き込み後の読み返しで「書き込んだ値と違う値が返る」状況は、正常系の代替実装からは
   * 作れない（同じ Map に書いて同じ Map から読むため必ず一致する）。検証の不一致を
   * 意図的に起こす唯一の入口としてここに置く。
   */
  tamperGetItem: ((item: Item) => Item | undefined) | undefined;

  constructor() {
    for (const name of Object.keys(TABLE_KEY_ATTRIBUTES)) this.tables.set(name, new Map());
  }

  table(name: string): Map<string, Item> {
    const table = this.tables.get(name);
    if (table === undefined) throw new Error(`unknown table: ${name}`);
    return table;
  }

  keyOf(tableName: string, item: Item): string {
    const attributes = TABLE_KEY_ATTRIBUTES[tableName];
    if (attributes === undefined) throw new Error(`unknown table: ${tableName}`);
    return attributes.map((attribute) => item[attribute]?.S ?? '').join('\u0000');
  }

  put(tableName: string, item: Item): void {
    this.table(tableName).set(this.keyOf(tableName, item), item);
  }

  send(command: unknown): Promise<unknown> {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;

    const tableNames =
      typeof input.TableName === 'string'
        ? [input.TableName]
        : Object.keys((input.RequestItems as Record<string, unknown> | undefined) ?? {});

    const call: RecordedCall = { name, tableNames, input };
    this.calls.push(call);

    const injected = this.failure?.(call, this.calls.length - 1);
    if (injected !== undefined) return Promise.reject(injected);

    try {
      return Promise.resolve(this.execute(name, input));
    } catch (error: unknown) {
      return Promise.reject(error);
    }
  }

  private execute(name: string, input: Record<string, unknown>): unknown {
    switch (name) {
      case 'PutItemCommand':
        return this.executePut(input);
      case 'UpdateItemCommand':
        return this.executeUpdate(input);
      case 'BatchWriteItemCommand':
        return this.executeBatchWrite(input);
      case 'GetItemCommand':
        return this.executeGet(input);
      case 'QueryCommand':
        return this.executeQuery(input);
      case 'ScanCommand':
        return this.executeScan(input);
      default:
        throw new Error(`unsupported DynamoDB command: ${name}`);
    }
  }

  private executePut(input: Record<string, unknown>): unknown {
    const tableName = input.TableName as string;
    const item = input.Item as Item;
    const key = this.keyOf(tableName, item);
    assertCondition(
      input.ConditionExpression as string | undefined,
      input.ExpressionAttributeNames as Record<string, string> | undefined,
      this.table(tableName).get(key)
    );
    this.table(tableName).set(key, { ...item });
    return {};
  }

  private executeUpdate(input: Record<string, unknown>): unknown {
    const tableName = input.TableName as string;
    const keyAttributes = input.Key as Item;
    const key = this.keyOf(tableName, keyAttributes);
    const names = input.ExpressionAttributeNames as Record<string, string> | undefined;
    const existing = this.table(tableName).get(key);

    assertCondition(input.ConditionExpression as string | undefined, names, existing);

    const next: Item = existing === undefined ? { ...keyAttributes } : { ...existing };
    applyUpdateExpression(
      next,
      input.UpdateExpression as string,
      names,
      input.ExpressionAttributeValues as Record<string, AttributeValue> | undefined
    );
    this.table(tableName).set(key, next);
    return {};
  }

  private executeBatchWrite(input: Record<string, unknown>): unknown {
    const requestItems = input.RequestItems as Record<
      string,
      { PutRequest?: { Item: Item }; DeleteRequest?: { Key: Item } }[]
    >;

    for (const [tableName, requests] of Object.entries(requestItems)) {
      for (const request of requests) {
        if (request.PutRequest !== undefined) {
          this.put(tableName, { ...request.PutRequest.Item });
          continue;
        }
        if (request.DeleteRequest !== undefined) {
          this.table(tableName).delete(this.keyOf(tableName, request.DeleteRequest.Key));
        }
      }
    }

    return { UnprocessedItems: {} };
  }

  private executeGet(input: Record<string, unknown>): unknown {
    const tableName = input.TableName as string;
    const item = this.table(tableName).get(this.keyOf(tableName, input.Key as Item));
    if (item === undefined) return {};

    const tampered = this.tamperGetItem?.({ ...item });
    return { Item: tampered ?? { ...item } };
  }

  private executeQuery(input: Record<string, unknown>): unknown {
    const tableName = input.TableName as string;
    const values = input.ExpressionAttributeValues as Record<string, AttributeValue>;
    const placeholder = equalityValuePlaceholder(input.KeyConditionExpression as string);
    const expected = values[placeholder]?.S;

    // GSI 指定は倉庫別インデックス、指定なしは PK（itemId）での取得
    const attribute = input.IndexName === undefined ? 'itemId' : 'warehouseId';
    const items = Array.from(this.table(tableName).values()).filter(
      (item) => item[attribute]?.S === expected
    );

    return { Items: items.map((item) => ({ ...item })) };
  }

  private executeScan(input: Record<string, unknown>): unknown {
    const tableName = input.TableName as string;

    if (input.Select === 'COUNT') return { Count: this.reportedRecordCount };

    const all = Array.from(this.table(tableName).entries());
    const startKey = input.ExclusiveStartKey as Item | undefined;
    const startIndex =
      startKey === undefined
        ? 0
        : all.findIndex(([key]) => key === this.keyOf(tableName, startKey)) + 1;
    const limit = typeof input.Limit === 'number' ? input.Limit : all.length;
    const page = all.slice(startIndex, startIndex + limit);

    // DynamoDB と同じく Limit は絞り込み前に適用され、その後にフィルタが掛かる
    const filter = input.FilterExpression as string | undefined;
    let items = page.map(([, item]) => item);
    if (filter !== undefined) {
      const values = input.ExpressionAttributeValues as Record<string, AttributeValue>;
      const expected = values[equalityValuePlaceholder(filter)]?.S;
      items = items.filter((item) => item.warehouseId?.S === expected);
    }

    const consumed = startIndex + page.length;
    const lastEntry = page[page.length - 1];
    return {
      Items: items.map((item) => ({ ...item })),
      LastEvaluatedKey:
        consumed < all.length && lastEntry !== undefined
          ? pickKeyAttributes(tableName, lastEntry[1])
          : undefined,
    };
  }
}

function pickKeyAttributes(tableName: string, item: Item): Item {
  const key: Item = {};
  for (const attribute of TABLE_KEY_ATTRIBUTES[tableName] ?? []) {
    const value = item[attribute];
    if (value !== undefined) key[attribute] = value;
  }
  return key;
}

// ============================================================
// FakeOpenSearch
// ============================================================

/** `_bulk` の 1 操作 */
type BulkOperation = 'index' | 'delete';

class FakeOpenSearch {
  readonly docs = new Map<string, Record<string, unknown>>();
  readonly bulkOperations: BulkOperation[] = [];

  /**
   * Vector_Collection に対して発行された**読み出し**操作の記録（要件 3.12 / Property 8）。
   *
   * バッチロールの Vector_Collection 権限は `aoss:WriteDocument` のみであり、
   * 読み出しは実 AWS では全件 `ACCESS_DENIED_IAM` になる。したがってこの配列は
   * 常に空でなければならない。
   */
  readonly readOperations: string[] = [];

  /** 失敗注入。操作種別と当該種別の呼び出し回数（0 起算）を受ける */
  failure: ((operation: BulkOperation, callIndex: number) => Error | undefined) | undefined;

  bulk(params: unknown): Promise<unknown> {
    const body = (params as { body: Record<string, unknown>[] }).body;
    const first = body[0] ?? {};
    const operation: BulkOperation = 'delete' in first ? 'delete' : 'index';

    const callIndex = this.bulkOperations.filter((entry) => entry === operation).length;
    this.bulkOperations.push(operation);

    const injected = this.failure?.(operation, callIndex);
    if (injected !== undefined) return Promise.reject(injected);

    for (let index = 0; index < body.length; index++) {
      const action = body[index];
      if ('index' in action) {
        const id = (action.index as { _id: string })._id;
        this.docs.set(id, body[index + 1] as Record<string, unknown>);
        index++;
        continue;
      }
      if ('delete' in action) this.docs.delete((action.delete as { _id: string })._id);
    }

    return Promise.resolve({ body: { errors: false, items: [] } });
  }

  /**
   * 読み出しは記録した上で必ず失敗させる。
   *
   * 成功を返すと「読み出しても動く」実装を通してしまう。実 AWS のバッチロールでは
   * 読み出しが `security_exception`（403）になるため、代替実装も同じ形で拒否する。
   */
  read(operation: string): Promise<unknown> {
    this.readOperations.push(operation);
    return Promise.reject(
      Object.assign(new Error('[security_exception] Reason: Bad Authorization'), {
        name: 'security_exception',
        statusCode: 403,
      })
    );
  }
}

// ============================================================
// 埋め込み生成のスタブ
// ============================================================

/** SKU 1 件分の入力。itemId と itemName の両方が埋め込みテキストの決定要因になる */
interface SkuFixture {
  readonly itemId: string;
  readonly itemName: string;
}

const ORIGIN_CODES = ['ETH', 'BRA', 'COL', 'GTM', 'KEN', 'IDN', 'CRI', 'TZA'] as const;

/** 連番から SKU を作る。itemId と itemName の双方に連番を残し、埋め込みテキストを一意にする */
function skuOf(serial: number): SkuFixture {
  const origin = ORIGIN_CODES[serial % ORIGIN_CODES.length];
  return { itemId: `ITEM#${origin}-SKU${serial}-RAW`, itemName: `テスト生豆 ${serial}` };
}

/** ハンドラが当該 (SKU, 言語) に対して Bedrock へ渡すはずのテキスト */
function embeddingTextOf(sku: SkuFixture, language: VectorLanguage): string {
  const metadata = deriveSkuMetadata(sku.itemId, sku.itemName);
  return truncateForEmbedding(buildEmbeddingText(language === 'ja' ? metadata.ja : metadata.en)).text;
}

/** (itemId, language) の組 */
interface Pair {
  readonly itemId: string;
  readonly language: VectorLanguage;
}

function pairKey(itemId: string, language: VectorLanguage): string {
  return `${itemId}\u0000${language}`;
}

/**
 * 決定論的な疑似ベクトル。**f32 で表現できない倍精度値**を返す。
 *
 * ここを f32 ちょうどの値にすると、丸めが行われていなくても Property 8 が通ってしまう。
 */
function pseudoVector(text: string, dimensions: number): number[] {
  let seed = 0;
  for (let index = 0; index < text.length; index++) {
    seed = (seed * 31 + text.charCodeAt(index)) % 1_000_003;
  }
  return Array.from({ length: dimensions }, (_, index) => Math.sin(seed + index) / 3);
}

/** 埋め込み生成の記録と失敗注入をまとめた代替 transport */
class FakeEmbeddingTransport {
  /** 渡されたテキストの列（呼び出し順、再試行を含む） */
  readonly texts: string[] = [];

  /** テキスト → (itemId, language) の対応。テストが「どの組を生成したか」を判定する唯一の経路 */
  readonly textToPair = new Map<string, Pair>();

  /** 失敗注入。対象の組に対して投げる例外を返す */
  failure: ((pair: Pair) => Error | undefined) | undefined;

  register(sku: SkuFixture): void {
    for (const language of VECTOR_LANGUAGES) {
      const text = embeddingTextOf(sku, language);
      if (this.textToPair.has(text)) {
        // 衝突すると「どの組を生成したか」が判定できない。黙って通さず落とす
        throw new Error(`embedding text collision for ${sku.itemId} (${language})`);
      }
      this.textToPair.set(text, { itemId: sku.itemId, language });
    }
  }

  /** 生成した（再試行を除く）組の集合 */
  generatedPairs(): Pair[] {
    const seen = new Map<string, Pair>();
    for (const text of this.texts) {
      const pair = this.textToPair.get(text);
      if (pair !== undefined) seen.set(pairKey(pair.itemId, pair.language), pair);
    }
    return Array.from(seen.values());
  }

  invoke(invocation: unknown): Promise<unknown> {
    const { text, dimensions } = invocation as { text: string; dimensions: number };
    this.texts.push(text);

    const pair = this.textToPair.get(text);
    if (pair === undefined) return Promise.reject(new Error(`unregistered embedding text`));

    const injected = this.failure?.(pair);
    if (injected !== undefined) return Promise.reject(injected);

    return Promise.resolve({
      embedding: pseudoVector(text, dimensions),
      inputTextTokenCount: text.length,
    });
  }
}

// ============================================================
// テスト環境
// ============================================================

let dynamo: FakeDynamoDb;
let openSearch: FakeOpenSearch;
let transport: FakeEmbeddingTransport;
let virtualNowMs: number;

beforeEach(() => {
  dynamo = new FakeDynamoDb();
  openSearch = new FakeOpenSearch();
  transport = new FakeEmbeddingTransport();
  virtualNowMs = 0;

  hooks.dynamoSend = (command) => dynamo.send(command);
  hooks.lambdaSend = () => Promise.reject(new Error('self invoke must not happen in these tests'));
  hooks.openSearchBulk = (params) => openSearch.bulk(params);
  hooks.openSearchRead = (operation) => openSearch.read(operation);
  hooks.embeddingInvoke = (invocation) => transport.invoke(invocation);
  hooks.clockNow = () => virtualNowMs;
  hooks.clockSleep = (ms) => {
    virtualNowMs += Number.isFinite(ms) && ms > 0 ? ms : 0;
    return Promise.resolve();
  };

  process.env.GOOD_TABLE_NAME = GOOD_TABLE_NAME;
  process.env.VECTOR_TABLE_NAME = VECTOR_TABLE_NAME;
  process.env.EXECUTIONS_TABLE_NAME = EXECUTIONS_TABLE_NAME;
  process.env.OPENSEARCH_VECTOR_ENDPOINT = 'https://vector.example.invalid';
  process.env.AWS_REGION = 'ap-northeast-1';
  process.env.VECTOR_EMBEDDING_DIMENSIONS = String(TEST_DIMENSIONS);

  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// シードとハンドラ起動
// ============================================================

/** Good_Table に 1 SKU × 3 倉庫を置く（複製元。読み取り専用であることを検証する対象） */
function seedGoodTable(skus: readonly SkuFixture[]): void {
  for (const sku of skus) {
    for (let index = 0; index < WAREHOUSES.length; index++) {
      dynamo.put(GOOD_TABLE_NAME, {
        itemId: { S: sku.itemId },
        warehouseId: { S: WAREHOUSES[index] },
        itemName: { S: sku.itemName },
        quantity: { N: String(100 + index) },
        lotNumber: { S: `LOT-${index}` },
        location: { S: `A-${index}` },
        unitPrice: { N: String(1200 + index) },
      });
    }
  }
}

/** 既存のベクトル（`phase = "embed"` が書いたはずの値）を表す属性 */
interface SeededEmbedding {
  readonly model: string;
  readonly dimensions: number;
  readonly languages: readonly VectorLanguage[];
}

/**
 * Vector_Table に複製済みレコードを置く（`phase = "copy"` の完了状態）。
 *
 * `seeded` を渡すと、指定言語のベクトルとモデル・次元数を併せて格納する。
 * これが Property 14 の「成功済みの組」に相当する状態である。
 */
function seedVectorTable(
  skus: readonly SkuFixture[],
  seeded?: (sku: SkuFixture) => SeededEmbedding | undefined
): void {
  for (const sku of skus) {
    const metadata = deriveSkuMetadata(sku.itemId, sku.itemName);
    const embedding = seeded?.(sku);

    for (let index = 0; index < WAREHOUSES.length; index++) {
      const item: Item = {
        itemId: { S: sku.itemId },
        warehouseId: { S: WAREHOUSES[index] },
        itemName: { S: sku.itemName },
        quantity: { N: String(100 + index) },
        lotNumber: { S: `LOT-${index}` },
        location: { S: `A-${index}` },
        unitPrice: { N: String(1200 + index) },
        metaJa: { M: marshall(metadata.ja) },
        metaEn: { M: marshall(metadata.en) },
      };

      if (embedding !== undefined && embedding.languages.length > 0) {
        item.embeddingModel = { S: embedding.model };
        item.embeddingDimensions = { N: String(embedding.dimensions) };
        item.embeddingUpdatedAt = { S: '2026-08-05T00:00:00.000Z' };
        for (const language of embedding.languages) {
          item[resolveVectorField(language)] = toAttributeVector(
            storedVectorOf(sku, language, embedding.dimensions)
          );
        }
      }

      dynamo.put(VECTOR_TABLE_NAME, item);
    }
  }

  // 既存ドキュメント側も揃える（成功済みの組は両バックエンドに存在する）
  for (const sku of skus) {
    const embedding = seeded?.(sku);
    if (embedding === undefined || embedding.languages.length === 0) continue;

    for (const warehouseId of WAREHOUSES) {
      const document: Record<string, unknown> = {
        itemId: sku.itemId,
        warehouseId,
      };
      for (const language of embedding.languages) {
        document[resolveVectorField(language)] = storedVectorOf(sku, language, embedding.dimensions);
      }
      openSearch.docs.set(buildVectorDocumentId(sku.itemId, warehouseId), document);
    }
  }
}

/** 既存ベクトルとして置く値。ハンドラが生成する値と同じ規則（f32 丸め済み）で作る */
function storedVectorOf(sku: SkuFixture, language: VectorLanguage, dimensions: number): number[] {
  return pseudoVector(embeddingTextOf(sku, language), dimensions).map((value) => Math.fround(value));
}

function toAttributeVector(vector: readonly number[]): AttributeValue {
  return { L: vector.map((value) => ({ N: String(value) })) };
}

/** API Gateway 経由の起動イベント */
function apiEvent(payload: Record<string, unknown>): APIGatewayProxyEvent {
  return { body: JSON.stringify(payload), isBase64Encoded: false } as unknown as APIGatewayProxyEvent;
}

/** ハンドラを起動して応答本文を返す。`context` は渡さない（自己再帰 invoke を起こさない） */
async function invokeBatch(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = (await handler(apiEvent(payload))) as APIGatewayProxyResult;
  return JSON.parse(result.body) as Record<string, unknown>;
}

// ============================================================
// 格納結果の読み出し
// ============================================================

/** Vector_Table に格納されたベクトル。読み出し規則はハンドラ側と同一（f32 丸め） */
function dynamoStoredVector(
  itemId: string,
  warehouseId: string,
  language: VectorLanguage
): number[] | undefined {
  const item = dynamo.table(VECTOR_TABLE_NAME).get(`${itemId}\u0000${warehouseId}`);
  const value = item?.[resolveVectorField(language)];
  if (value?.L === undefined) return undefined;
  return value.L.map((element) => Math.fround(Number(element.N)));
}

/** Vector_Collection に格納されたベクトル */
function openSearchStoredVector(
  itemId: string,
  warehouseId: string,
  language: VectorLanguage
): number[] | undefined {
  const source = openSearch.docs.get(buildVectorDocumentId(itemId, warehouseId));
  const value = source?.[resolveVectorField(language)];
  if (!Array.isArray(value)) return undefined;
  return value.map((element) => Math.fround(Number(element)));
}

function vectorTableItemsOf(itemId: string): Item[] {
  return Array.from(dynamo.table(VECTOR_TABLE_NAME).values()).filter(
    (item) => item.itemId?.S === itemId
  );
}

// ============================================================
// arbitrary
// ============================================================

/** 一意な SKU の並び。件数を絞るのは 1 反復に 256 次元 × 2 言語の生成が乗るため */
const skuListArb = fc
  .uniqueArray(fc.integer({ min: 1, max: 400 }), { minLength: 1, maxLength: 3 })
  .map((serials) => serials.map(skuOf));

/** 重複を含む SKU の並び（Property 9 が要求する「重複を含む SKU リスト」） */
const skuListWithDuplicatesArb = fc
  .array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 6 })
  .map((serials) => serials.map(skuOf));

/** 一意な itemId の件数 */
function uniqueItemIds(skus: readonly SkuFixture[]): string[] {
  const seen: string[] = [];
  for (const sku of skus) if (!seen.includes(sku.itemId)) seen.push(sku.itemId);
  return seen;
}

/** 15,000 件以外の件数 */
const mismatchedRecordCountArb = fc
  .integer({ min: 0, max: 30_000 })
  .filter((count) => count !== EXPECTED_VECTOR_RECORD_COUNT);

// ============================================================
// Property 7
// ============================================================

describe('Good_Table への非書き込みと件数ゲート（Property 7）', () => {
  // Feature: vector-search-comparison, Property 7: 任意の SKU リスト・任意の失敗注入位置・
  // 任意の実行フェーズに対して、Good_Table を対象とする書き込み API（PutItem / UpdateItem /
  // DeleteItem / BatchWriteItem）の呼び出し回数は 0 である。
  it('任意の失敗注入位置・任意のフェーズで Good_Table 宛の書き込みコマンドが 1 件も発行されない', async () => {
    await fc.assert(
      fc.asyncProperty(
        skuListArb,
        fc.constantFrom<'copy' | 'embed'>('copy', 'embed'),
        fc.integer({ min: 0, max: 60 }),
        async (skus, phase, failAt) => {
          dynamo = new FakeDynamoDb();
          openSearch = new FakeOpenSearch();
          transport = new FakeEmbeddingTransport();
          for (const sku of skus) transport.register(sku);

          seedGoodTable(skus);
          if (phase === 'embed') seedVectorTable(skus);

          // 任意の位置で 1 度だけ失敗させる（複製途中・書き込み途中・補償途中を含む）
          dynamo.failure = (_call, index) => (index === failAt ? validationError() : undefined);

          await invokeBatch({ phase });

          const goodTableCalls = dynamo.calls.filter((call) =>
            call.tableNames.includes(GOOD_TABLE_NAME)
          );
          const writes = goodTableCalls.filter((call) =>
            WRITE_COMMAND_NAMES.some((name) => name === call.name)
          );

          expect(writes).toHaveLength(0);
          // Good_Table に触る経路は読み取り（Query）のみである
          expect(goodTableCalls.every((call) => call.name === 'QueryCommand')).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: vector-search-comparison, Property 7: 任意の整数のレコード件数に対して、
  // Vector_Table の件数が 15,000 以外であれば埋め込み生成の呼び出し回数は 0 であり、
  // 期待件数と実件数の両方を含むエラーが返る。
  it('件数が 15,000 以外なら埋め込み生成を 1 度も呼ばず、期待件数と実件数の両方を返す', async () => {
    await fc.assert(
      fc.asyncProperty(
        mismatchedRecordCountArb,
        skuListArb,
        fc.constantFrom<'copy' | 'embed'>('copy', 'embed'),
        async (recordCount, skus, phase) => {
          dynamo = new FakeDynamoDb();
          openSearch = new FakeOpenSearch();
          transport = new FakeEmbeddingTransport();
          for (const sku of skus) transport.register(sku);

          seedGoodTable(skus);
          seedVectorTable(skus);
          dynamo.reportedRecordCount = recordCount;

          const body = await invokeBatch({ phase });

          expect(transport.texts).toHaveLength(0);
          expect(body.status).toBe('RECORD_COUNT_MISMATCH');
          expect(body.recordCountCheck).toEqual({
            expectedRecordCount: EXPECTED_VECTOR_RECORD_COUNT,
            actualRecordCount: recordCount,
            matched: false,
          });
          // 説明文にも両方の件数が現れる（要件 1.7）
          expect(String(body.message)).toContain(String(EXPECTED_VECTOR_RECORD_COUNT));
          expect(String(body.message)).toContain(String(recordCount));
          // ベクトルはどちらのバックエンドにも入らない
          expect(openSearch.bulkOperations).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ============================================================
// Property 8
// ============================================================

describe('格納ベクトルの両バックエンド一致と f32 丸めの冪等性（Property 8）', () => {
  // Feature: vector-search-comparison, Property 8: 任意の浮動小数配列と任意の言語に対して、
  // Embedding_Batch_Job を通した後の Vector_Table 側の保存値と Vector_Collection 側の保存値は、
  // 次元数が一致し全要素が要素単位で等しい。f32 への丸めは冪等である。
  // さらに、バッチが Vector_Collection に対して発行する読み出し操作の呼び出し回数は 0 である
  // （task 17.2 で追加。要件 3.12 / 17.7）。
  it('両バックエンドの保存値は次元数が一致し全要素が等しく、丸めは冪等である', async () => {
    await fc.assert(
      fc.asyncProperty(skuListArb, async (skus) => {
        dynamo = new FakeDynamoDb();
        openSearch = new FakeOpenSearch();
        transport = new FakeEmbeddingTransport();
        for (const sku of skus) transport.register(sku);

        seedGoodTable(skus);
        seedVectorTable(skus);

        const body = await invokeBatch({ phase: 'embed' });
        expect(body.status).toBe('COMPLETED');

        for (const sku of skus) {
          for (const warehouseId of WAREHOUSES) {
            for (const language of VECTOR_LANGUAGES) {
              const stored = dynamoStoredVector(sku.itemId, warehouseId, language);
              const indexed = openSearchStoredVector(sku.itemId, warehouseId, language);

              expect(stored).toBeDefined();
              expect(indexed).toBeDefined();
              expect(stored).toHaveLength(TEST_DIMENSIONS);
              expect(indexed).toHaveLength(TEST_DIMENSIONS);
              // 要素単位の厳密一致（近似ではない）
              expect(stored).toEqual(indexed);

              // 丸めの冪等性：保存値へ再度 f32 丸めを適用しても値が変わらない
              expect((stored ?? []).map((value) => Math.fround(value))).toEqual(stored);

              // 実装自身の比較関数も一致と判定する
              expect(compareStoredVectors(stored, indexed, TEST_DIMENSIONS)).toEqual({
                matched: true,
              });
            }
          }
        }

        // ハンドラの検証集計も全組一致（要件 3.6）
        const total = body.total as Record<string, number>;
        expect(total.verifiedTargetCount).toBe(skus.length * LANGUAGE_COUNT);
        expect(total.verifiedMatchedCount).toBe(skus.length * LANGUAGE_COUNT);
        expect(total.verifiedMismatchedCount).toBe(0);
        expect(total.verifiedMissingCount).toBe(0);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: vector-search-comparison, Property 8（task 17.2 の追加）: 任意の SKU リスト・
  // 任意のスキップ状態・任意の失敗注入位置に対して、バッチが Vector_Collection に対して
  // 発行する読み出し操作（`get` / `mget` / `search`）の呼び出し回数は 0 であり、
  // 発行する `_bulk` の操作は書き込み系（`index` / `delete`）のみである。
  it('Vector_Collection への読み出し呼び出し回数は 0 で、_bulk は書き込み系のみである', async () => {
    await fc.assert(
      fc.asyncProperty(
        skuListArb,
        // 既存ベクトルの有無を振る（スキップ経路でも読み出しが起きないことを確認する）
        fc.constantFrom<readonly VectorLanguage[]>([], ['ja'], ['en'], ['ja', 'en']),
        // 任意の位置で 1 度だけ DynamoDB を失敗させ、補償経路も通す
        fc.oneof(fc.constant(undefined), fc.integer({ min: 0, max: 40 })),
        async (skus, seededLanguages, failAt) => {
          dynamo = new FakeDynamoDb();
          openSearch = new FakeOpenSearch();
          transport = new FakeEmbeddingTransport();
          for (const sku of skus) transport.register(sku);

          seedGoodTable(skus);
          seedVectorTable(skus, () => ({
            model: 'amazon.titan-embed-text-v2:0',
            dimensions: TEST_DIMENSIONS,
            languages: seededLanguages,
          }));

          if (failAt !== undefined) {
            dynamo.failure = (_call, index) => (index === failAt ? validationError() : undefined);
          }

          await invokeBatch({ phase: 'embed' });

          // 要件 3.12: Vector_Collection に対する読み出し操作を 1 回も実行しない。
          // 旧実装は検証で `client.get()` を呼んでおり、バッチロールが `aoss:ReadDocument` を
          // 持たないため実 AWS では全件 ACCESS_DENIED_IAM になっていた
          expect(openSearch.readOperations).toEqual([]);
          // `_bulk` に載るのは書き込み系の操作のみ
          expect(
            openSearch.bulkOperations.every(
              (operation) => operation === 'index' || operation === 'delete'
            )
          ).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ============================================================
// Property 9
// ============================================================

describe('埋め込み生成回数と書き込み件数の関係（Property 9）', () => {
  // Feature: vector-search-comparison, Property 9: 任意の SKU リスト（重複を含む）に対して、
  // 埋め込み生成の呼び出し回数（再試行を除く）は一意な itemId の件数の 2 倍（言語数）と等しく、
  // 各バックエンドへの書き込みレコード件数は一意な itemId 件数の 3 倍（倉庫数）と等しく、
  // 1 レコードは両言語のベクトルを同時に保持する。
  it('生成回数は一意 itemId × 2、書き込み件数は一意 itemId × 3 で、1 レコードが両言語を保持する', async () => {
    await fc.assert(
      fc.asyncProperty(skuListWithDuplicatesArb, async (skus) => {
        dynamo = new FakeDynamoDb();
        openSearch = new FakeOpenSearch();
        transport = new FakeEmbeddingTransport();
        for (const itemId of uniqueItemIds(skus)) {
          transport.register(skus.filter((sku) => sku.itemId === itemId)[0]);
        }

        seedGoodTable(skus);

        // 複製フェーズを通してから埋め込みフェーズへ進む（重複は主キーで畳まれる）
        const copyBody = await invokeBatch({ phase: 'copy' });
        expect(copyBody.status).toBe('COMPLETED');

        const embedBody = await invokeBatch({ phase: 'embed' });
        expect(embedBody.status).toBe('COMPLETED');

        const itemIds = uniqueItemIds(skus);

        // 再試行は起きていない（スロットリングを注入していない）ため、呼び出し回数 = 組の件数
        expect(transport.texts).toHaveLength(itemIds.length * LANGUAGE_COUNT);
        expect(transport.generatedPairs()).toHaveLength(itemIds.length * LANGUAGE_COUNT);

        // 各バックエンドのレコード件数
        expect(dynamo.table(VECTOR_TABLE_NAME).size).toBe(itemIds.length * WAREHOUSE_COUNT);
        expect(openSearch.docs.size).toBe(itemIds.length * WAREHOUSE_COUNT);

        // 1 レコードが両言語のベクトルを同時に保持する
        for (const itemId of itemIds) {
          for (const warehouseId of WAREHOUSES) {
            for (const language of VECTOR_LANGUAGES) {
              expect(dynamoStoredVector(itemId, warehouseId, language)).toHaveLength(
                TEST_DIMENSIONS
              );
              expect(openSearchStoredVector(itemId, warehouseId, language)).toHaveLength(
                TEST_DIMENSIONS
              );
            }
          }
        }

        const total = embedBody.total as Record<string, number>;
        expect(total.generatedCount).toBe(itemIds.length * LANGUAGE_COUNT);
        expect(total.storedCount).toBe(itemIds.length * LANGUAGE_COUNT);
        expect(total.failedCount).toBe(0);
      }),
      { numRuns: 100 }
    );
  });
});

// ============================================================
// Property 10
// ============================================================

describe('片側失敗時の状態復元（Property 10）', () => {
  // Feature: vector-search-comparison, Property 10: 任意の SKU と任意の失敗注入位置に対して、
  // 片側成功・他方が再試行上限まで失敗した場合、両バックエンドの当該 SKU の 3 レコードは
  // 書き込み前の状態と等しく（両言語のベクトル属性がいずれも残らない）、当該 SKU は未格納として
  // 対象 itemId と対象言語とともに記録される。
  it('片側が失敗すると 3 レコードは書き込み前の状態へ戻り、両言語が未格納として記録される', async () => {
    await fc.assert(
      fc.asyncProperty(
        skuListArb,
        fc.constantFrom<'dynamodb' | 'opensearch'>('dynamodb', 'opensearch'),
        fc.integer({ min: 0, max: WAREHOUSE_COUNT - 1 }),
        async (skus, failingSide, failingRecordIndex) => {
          dynamo = new FakeDynamoDb();
          openSearch = new FakeOpenSearch();
          transport = new FakeEmbeddingTransport();
          for (const sku of skus) transport.register(sku);

          seedGoodTable(skus);
          seedVectorTable(skus);

          if (failingSide === 'dynamodb') {
            // ベクトルを書く `SET` のみを失敗させる。補償の `REMOVE` は成功させる。
            // 何件目のレコードで失敗させるかは SKU ごとに数える（失敗後は次の SKU へ進むため、
            // 通算の呼び出し回数で数えると SKU をまたいで位置がずれる）
            const setUpdatesPerItem = new Map<string, number>();
            dynamo.failure = (call) => {
              const expression = call.input.UpdateExpression;
              if (
                call.name !== 'UpdateItemCommand' ||
                !call.tableNames.includes(VECTOR_TABLE_NAME) ||
                typeof expression !== 'string' ||
                !expression.startsWith('SET ') ||
                !expression.includes('embedding')
              ) {
                return undefined;
              }
              const itemId = (call.input.Key as Item | undefined)?.itemId?.S ?? '';
              const seen = setUpdatesPerItem.get(itemId) ?? 0;
              setUpdatesPerItem.set(itemId, seen + 1);
              return seen === failingRecordIndex
                ? validationError('injected dynamodb write failure')
                : undefined;
            };
          } else {
            // `index` は失敗、補償の `delete` は成功させる
            openSearch.failure = (operation) =>
              operation === 'index' ? validationError('injected opensearch write failure') : undefined;
          }

          const body = await invokeBatch({ phase: 'embed' });

          for (const sku of skus) {
            // DynamoDB 側：3 レコードに 5 属性のいずれも残らない
            const items = vectorTableItemsOf(sku.itemId);
            expect(items).toHaveLength(WAREHOUSE_COUNT);
            for (const item of items) {
              for (const attribute of EMBEDDING_ATTRIBUTES) {
                expect(item[attribute]).toBeUndefined();
              }
              // 既存 6 属性は失われない
              expect(item.itemName?.S).toBe(sku.itemName);
            }

            // OpenSearch 側：当該 SKU の 3 ドキュメントが残らない
            for (const warehouseId of WAREHOUSES) {
              expect(openSearch.docs.has(buildVectorDocumentId(sku.itemId, warehouseId))).toBe(
                false
              );
            }

            // 未格納として itemId と言語の両方が記録される
            const failures = body.failures as { itemId: string; language: string; stage: string }[];
            for (const language of VECTOR_LANGUAGES) {
              expect(
                failures.some(
                  (failure) => failure.itemId === sku.itemId && failure.language === language
                )
              ).toBe(true);
            }
          }

          const total = body.total as Record<string, number>;
          expect(total.storedCount).toBe(0);
          expect(total.failedCount).toBe(skus.length * LANGUAGE_COUNT);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ============================================================
// Property 13
// ============================================================

describe('再生成スキップ判定の論理積（Property 13）', () => {
  const CURRENT_MODEL = 'amazon.titan-embed-text-v2:0';
  const CURRENT_DIMENSIONS = 1024;

  const existingStateArb = fc.record({
    hasJa: fc.boolean(),
    hasEn: fc.boolean(),
    modelMatches: fc.boolean(),
    dimensionsMatch: fc.boolean(),
  });

  function recordOf(state: {
    hasJa: boolean;
    hasEn: boolean;
    modelMatches: boolean;
    dimensionsMatch: boolean;
  }) {
    return {
      embeddingModel: state.modelMatches ? CURRENT_MODEL : 'amazon.titan-embed-text-v1',
      embeddingDimensions: state.dimensionsMatch ? CURRENT_DIMENSIONS : 512,
      hasEmbedding: { ja: state.hasJa, en: state.hasEn },
    };
  }

  // Feature: vector-search-comparison, Property 13: 任意の既存状態（当該言語の埋め込みの有無 ×
  // 格納済みモデル識別子の一致・不一致 × 格納済み次元数の一致・不一致）と任意の言語に対して、
  // スキップと判定されるのは 3 条件すべてが満たされる場合のみである。
  it('スキップは 3 条件すべての論理積のときに限る', () => {
    fc.assert(
      fc.property(existingStateArb, fc.constantFrom(...VECTOR_LANGUAGES), (state, language) => {
        const record = recordOf(state);
        const expected =
          record.hasEmbedding[language] && state.modelMatches && state.dimensionsMatch;

        expect(
          shouldSkipLanguage(record, language, CURRENT_MODEL, CURRENT_DIMENSIONS, false)
        ).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: vector-search-comparison, Property 13: 判定は言語ごとに独立している。
  it('他方の言語のベクトルの有無は当該言語の判定を変えない', () => {
    fc.assert(
      fc.property(existingStateArb, fc.constantFrom(...VECTOR_LANGUAGES), (state, language) => {
        const withOther = recordOf(state);
        // 他方の言語のベクトルの有無だけを反転させた状態
        const withoutOther = recordOf({
          ...state,
          hasJa: language === 'ja' ? state.hasJa : !state.hasJa,
          hasEn: language === 'en' ? state.hasEn : !state.hasEn,
        });

        expect(
          shouldSkipLanguage(withOther, language, CURRENT_MODEL, CURRENT_DIMENSIONS, false)
        ).toBe(shouldSkipLanguage(withoutOther, language, CURRENT_MODEL, CURRENT_DIMENSIONS, false));
      }),
      { numRuns: 100 }
    );
  });

  // Feature: vector-search-comparison, Property 13: 強制再生成フラグが有効な場合は、
  // 任意の既存状態に対してスキップと判定されない。
  it('強制再生成が有効なら任意の既存状態でスキップしない', () => {
    fc.assert(
      fc.property(existingStateArb, fc.constantFrom(...VECTOR_LANGUAGES), (state, language) => {
        expect(
          shouldSkipLanguage(recordOf(state), language, CURRENT_MODEL, CURRENT_DIMENSIONS, true)
        ).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});

// ============================================================
// Property 14
// ============================================================

describe('再実行対象集合の補集合性（Property 14）', () => {
  /** SKU ごとに「成功済み」とする言語の集合。空集合と全集合を含む */
  const seededLanguagesArb = fc.constantFrom<readonly VectorLanguage[]>(
    [],
    ['ja'],
    ['en'],
    ['ja', 'en']
  );

  /**
   * SKU の並びと、SKU ごとの「成功済み」言語集合の組。
   *
   * `skuListArb` の最大長と同じ長さの集合列を独立に引き、添字で対応づける
   * （`chain` で長さを合わせると縮小（shrink）時に対応が崩れやすい）。
   */
  const seededPlanArb = fc
    .tuple(skuListArb, fc.array(seededLanguagesArb, { minLength: 3, maxLength: 3 }))
    .map(([skus, seeded]) => skus.map((sku, index) => ({ sku, seeded: seeded[index] })));

  // Feature: vector-search-comparison, Property 14: 任意の進捗状態（成功済みの (itemId, 言語) の
  // 組の集合）に対して、再実行時の処理対象集合は全体集合（一意 itemId × 2 言語）から
  // 成功済み集合を除いた集合と等しく、成功済みの組に対する埋め込み生成呼び出しは発生しない。
  it('処理対象は全体集合から成功済み集合を除いた集合と等しい', async () => {
    await fc.assert(
      fc.asyncProperty(
        seededPlanArb,
        async (entries) => {
          dynamo = new FakeDynamoDb();
          openSearch = new FakeOpenSearch();
          transport = new FakeEmbeddingTransport();
          for (const entry of entries) transport.register(entry.sku);

          const seededByItemId = new Map<string, readonly VectorLanguage[]>();
          for (const entry of entries) seededByItemId.set(entry.sku.itemId, entry.seeded);

          seedGoodTable(entries.map((entry) => entry.sku));
          seedVectorTable(
            entries.map((entry) => entry.sku),
            (sku) => ({
              model: 'amazon.titan-embed-text-v2:0',
              dimensions: TEST_DIMENSIONS,
              languages: seededByItemId.get(sku.itemId) ?? [],
            })
          );

          const body = await invokeBatch({ phase: 'embed' });
          expect(body.status).toBe('COMPLETED');

          // 期待する処理対象集合（補集合）
          const expected: string[] = [];
          const succeeded: string[] = [];
          for (const entry of entries) {
            for (const language of VECTOR_LANGUAGES) {
              const key = pairKey(entry.sku.itemId, language);
              if (entry.seeded.includes(language)) succeeded.push(key);
              else expected.push(key);
            }
          }

          const generated = transport
            .generatedPairs()
            .map((pair) => pairKey(pair.itemId, pair.language));

          expect(generated.slice().sort()).toEqual(expected.slice().sort());
          // 成功済みの組に対する呼び出しは 1 件も無い（要件 4.9）
          for (const key of succeeded) expect(generated).not.toContain(key);
          // 再試行を含めても呼び出し回数は補集合の件数に一致する
          expect(transport.texts).toHaveLength(expected.length);

          const perLanguage = body.perLanguage as Record<string, Record<string, number>>;
          for (const language of VECTOR_LANGUAGES) {
            const seededCount = entries.filter((entry) => entry.seeded.includes(language)).length;
            expect(perLanguage[language].skippedCount).toBe(seededCount);
            expect(perLanguage[language].generatedCount).toBe(entries.length - seededCount);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: vector-search-comparison, Property 14: 失敗として記録される組の件数は、
  // 実際に上限まで失敗した組の件数と等しい。
  it('失敗として記録される組の件数は上限まで失敗した組の件数に等しい', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .tuple(skuListArb, fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }))
          .map(([skus, flags]) => skus.map((sku, index) => ({ sku, fails: flags[index] }))),
        async (entries) => {
          dynamo = new FakeDynamoDb();
          openSearch = new FakeOpenSearch();
          transport = new FakeEmbeddingTransport();
          for (const entry of entries) transport.register(entry.sku);

          const failingItemIds = entries
            .filter((entry) => entry.fails)
            .map((entry) => entry.sku.itemId);

          seedGoodTable(entries.map((entry) => entry.sku));
          seedVectorTable(entries.map((entry) => entry.sku));

          // 当該 SKU の両言語をスロットリングで上限まで失敗させる（仮想時計なので待機は 0 実時間）
          transport.failure = (pair) =>
            failingItemIds.includes(pair.itemId) ? throttlingError() : undefined;

          const body = await invokeBatch({ phase: 'embed' });
          expect(body.status).toBe('COMPLETED');

          const failingPairs = failingItemIds.length * LANGUAGE_COUNT;
          const total = body.total as Record<string, number>;

          expect(total.failedCount).toBe(failingPairs);
          // 上限まで再試行したことの確認（1 組あたり BATCH_MAX_RETRIES 回）
          expect(total.bedrockRetries).toBe(failingPairs * BATCH_MAX_RETRIES);

          const failures = body.failures as { itemId: string; language: string }[];
          for (const itemId of failingItemIds) {
            for (const language of VECTOR_LANGUAGES) {
              expect(
                failures.some(
                  (failure) => failure.itemId === itemId && failure.language === language
                )
              ).toBe(true);
            }
            // 失敗した SKU にはベクトルが格納されない
            for (const warehouseId of WAREHOUSES) {
              for (const language of VECTOR_LANGUAGES) {
                expect(dynamoStoredVector(itemId, warehouseId, language)).toBeUndefined();
              }
            }
          }

          // 失敗しなかった SKU は格納される（失敗が他 SKU へ波及しない、要件 4.3）
          for (const entry of entries) {
            if (entry.fails) continue;
            for (const language of VECTOR_LANGUAGES) {
              expect(dynamoStoredVector(entry.sku.itemId, SKU_LIST_WAREHOUSE, language)).toHaveLength(
                TEST_DIMENSIONS
              );
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ============================================================
// 検証結果の計上（要件 3.18 / task 17.2 の回帰テスト）
// ============================================================

describe('検証結果の計上と終了判定（要件 3.18）', () => {
  /** 検証の読み返しだけを狂わせる。書き込み自体は成功させる */
  function tamperVerificationRead(mode: 'mismatch' | 'missing'): void {
    dynamo.tamperGetItem = (item) => {
      // 検証の読み返しは Vector_Table のベクトル属性のみを射影した `GetItem` である
      const next: Item = { ...item };
      for (const language of VECTOR_LANGUAGES) {
        const field = resolveVectorField(language);
        if (next[field]?.L === undefined) continue;
        if (mode === 'missing') delete next[field];
        // 第 0 次元だけを別の値に置き換える（次元数は保ったまま値だけを不一致にする）
        else next[field] = { L: [{ N: '0.5' }, ...next[field].L!.slice(1)] };
      }
      return next;
    };
  }

  /**
   * 旧挙動（`verifiedMismatchedCount` が正でも `failedCount 0` / `COMPLETED`）が
   * 再発したら落ちるテスト。実測値は 9,994 組の不一致に対して `failedCount 6` /
   * `status COMPLETED` だった。
   */
  it('不一致が 1 件以上あれば failedCount に計上し、COMPLETED にしない', async () => {
    const skus = [skuOf(11), skuOf(22)];
    for (const sku of skus) transport.register(sku);
    seedGoodTable(skus);
    seedVectorTable(skus);
    tamperVerificationRead('mismatch');

    const body = await invokeBatch({ phase: 'embed' });
    const total = body.total as Record<string, number>;
    const verification = body.verification as {
      vectorTable: Record<string, unknown>;
      byLanguage: Record<string, Record<string, unknown>>;
      vectorCollection: Record<string, unknown>;
    };
    const pairs = skus.length * LANGUAGE_COUNT;

    // ── 旧挙動の否定 ────────────────────────────────────────────────
    expect(body.status).not.toBe('COMPLETED');
    expect(body.status).toBe('VERIFICATION_FAILED');
    expect(total.failedCount).not.toBe(0);

    // ── 計上規則（要件 3.18）────────────────────────────────────────
    expect(total.verifiedTargetCount).toBe(pairs);
    expect(total.verifiedMismatchedCount).toBe(pairs);
    expect(total.verifiedMissingCount).toBe(0);
    // 不一致件数と未格納件数の和が失敗件数に計上される
    expect(total.failedCount).toBe(pairs);

    // ── 集計と判定は summarizeVerification() の結果に従う ───────────
    expect(verification.vectorTable.status).toBe('VERIFICATION_FAILED');
    expect(verification.vectorTable.passed).toBe(false);
    expect(verification.vectorTable.consistent).toBe(true);
    expect(verification.vectorTable.failedCount).toBe(pairs);
    expect(verification.vectorTable.mismatchedCount).toBe(pairs);
    expect(verification.vectorTable.missingCount).toBe(0);
    for (const language of VECTOR_LANGUAGES) {
      expect(verification.byLanguage[language].passed).toBe(false);
      expect(verification.byLanguage[language].mismatchedCount).toBe(skus.length);
    }

    // 不一致の (itemId, 言語) が識別子として残る（要件 3.10 / 3.16）
    const failures = body.failures as { itemId: string; language: string; stage: string }[];
    for (const sku of skus) {
      for (const language of VECTOR_LANGUAGES) {
        expect(
          failures.some(
            (failure) =>
              failure.itemId === sku.itemId &&
              failure.language === language &&
              failure.stage === 'VERIFICATION'
          )
        ).toBe(true);
      }
    }

    // OpenSearch 側の検証は Verification_Run が担う旨が応答に明示される（task 17.3）
    expect(verification.vectorCollection.verifiedBy).toBe('VERIFICATION_RUN');
    expect(verification.vectorCollection.status).toBe('NOT_EXECUTED');
    expect(String(verification.vectorCollection.command)).toContain('vector:verify');
    // Vector_Collection への読み出しは 1 回も発行されない（要件 3.12）
    expect(openSearch.readOperations).toEqual([]);
  });

  it('読み返しでベクトルが存在しなければ未格納として計上し、COMPLETED にしない', async () => {
    const skus = [skuOf(31)];
    for (const sku of skus) transport.register(sku);
    seedGoodTable(skus);
    seedVectorTable(skus);
    tamperVerificationRead('missing');

    const body = await invokeBatch({ phase: 'embed' });
    const total = body.total as Record<string, number>;
    const verification = body.verification as { vectorTable: Record<string, unknown> };

    expect(body.status).toBe('VERIFICATION_FAILED');
    // 要件 3.17: 未格納と値の不一致を別々に数える
    expect(total.verifiedMissingCount).toBe(LANGUAGE_COUNT);
    expect(total.verifiedMismatchedCount).toBe(0);
    expect(total.failedCount).toBe(LANGUAGE_COUNT);
    expect(verification.vectorTable.passed).toBe(false);
    expect(verification.vectorTable.missingCount).toBe(LANGUAGE_COUNT);
  });

  it('検証が全件一致なら COMPLETED を返し、Verification_Run は未実施として明示される', async () => {
    const skus = [skuOf(41), skuOf(42)];
    for (const sku of skus) transport.register(sku);
    seedGoodTable(skus);
    seedVectorTable(skus);

    const body = await invokeBatch({ phase: 'embed' });
    const total = body.total as Record<string, number>;
    const verification = body.verification as {
      vectorTable: Record<string, unknown>;
      vectorCollection: Record<string, unknown>;
    };

    expect(body.status).toBe('COMPLETED');
    expect(total.failedCount).toBe(0);
    expect(total.verifiedMatchedCount).toBe(skus.length * LANGUAGE_COUNT);
    expect(verification.vectorTable.status).toBe('COMPLETED');
    expect(verification.vectorTable.passed).toBe(true);
    // Vector_Table 側が合格でも Vector_Collection 側は未実施のままである（要件 3.12）
    expect(verification.vectorCollection.status).toBe('NOT_EXECUTED');
  });

  it('検証の集計は「対象 = 一致 + 不一致 + 未格納」を満たす', async () => {
    await fc.assert(
      fc.asyncProperty(
        skuListArb,
        fc.constantFrom<'clean' | 'mismatch' | 'missing'>('clean', 'mismatch', 'missing'),
        async (skus, mode) => {
          dynamo = new FakeDynamoDb();
          openSearch = new FakeOpenSearch();
          transport = new FakeEmbeddingTransport();
          for (const sku of skus) transport.register(sku);

          seedGoodTable(skus);
          seedVectorTable(skus);
          if (mode !== 'clean') tamperVerificationRead(mode);

          const body = await invokeBatch({ phase: 'embed' });
          const total = body.total as Record<string, number>;
          const vectorTable = (body.verification as { vectorTable: Record<string, number> })
            .vectorTable;

          // 保存則（要件 3.17）
          expect(
            total.verifiedMatchedCount + total.verifiedMismatchedCount + total.verifiedMissingCount
          ).toBe(total.verifiedTargetCount);
          expect(vectorTable.consistent).toBe(true);

          // 合否と実行状態が食い違わない（要件 3.18）
          const expectedPassed = mode === 'clean';
          expect(vectorTable.passed).toBe(expectedPassed);
          expect(body.status).toBe(expectedPassed ? 'COMPLETED' : 'VERIFICATION_FAILED');
          // 失敗件数 0 で不合格、または失敗件数が正で COMPLETED という組み合わせを作らない
          expect(total.failedCount === 0).toBe(expectedPassed);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ============================================================
// スキップ挙動の保持（`shouldSkipEmbedding()` への委譲後）
// ============================================================

describe('現行モデル・現行次元のベクトルを持つ組のスキップ（要件 4.5 / 4.9）', () => {
  const CURRENT_MODEL = 'amazon.titan-embed-text-v2:0';

  /**
   * 後続の再実行（`forceRegenerate: false` のまま未格納分だけを埋める）の前提を固定する。
   *
   * 判定を `shared/vector/skip-decision.ts` の `shouldSkipEmbedding()` へ委譲したことで
   * この挙動が変わっていないことを、ハンドラを通した経路で確認する。
   */
  it('現行設定で格納済みの組はスキップされ Bedrock を呼ばず、未格納の組だけが処理される', async () => {
    const storedSkus = [skuOf(101), skuOf(102), skuOf(103)];
    const pendingSkus = [skuOf(201), skuOf(202)];
    const allSkus = [...storedSkus, ...pendingSkus];
    for (const sku of allSkus) transport.register(sku);

    const storedItemIds = storedSkus.map((sku) => sku.itemId);
    seedGoodTable(allSkus);
    seedVectorTable(allSkus, (sku) =>
      storedItemIds.includes(sku.itemId)
        ? { model: CURRENT_MODEL, dimensions: TEST_DIMENSIONS, languages: ['ja', 'en'] }
        : undefined
    );

    const body = await invokeBatch({ phase: 'embed', forceRegenerate: false });

    expect(body.status).toBe('COMPLETED');

    // 格納済みの組へは Bedrock を呼ばない（要件 4.9）
    const generatedItemIds = transport.generatedPairs().map((pair) => pair.itemId);
    for (const itemId of storedItemIds) expect(generatedItemIds).not.toContain(itemId);
    // 未格納の組はすべて処理される
    for (const sku of pendingSkus) expect(generatedItemIds).toContain(sku.itemId);
    // 呼び出し回数は未格納の組の件数に一致する（再試行なし）
    expect(transport.texts).toHaveLength(pendingSkus.length * LANGUAGE_COUNT);

    const total = body.total as Record<string, number>;
    expect(total.skippedCount).toBe(storedSkus.length * LANGUAGE_COUNT);
    expect(total.generatedCount).toBe(pendingSkus.length * LANGUAGE_COUNT);
    expect(total.storedCount).toBe(pendingSkus.length * LANGUAGE_COUNT);
    expect(total.failedCount).toBe(0);

    // 検証対象はこの起動で書き込んだ組のみ。スキップした組は Verification_Run が担う
    expect(total.verifiedTargetCount).toBe(pendingSkus.length * LANGUAGE_COUNT);
    expect(total.verifiedMatchedCount).toBe(pendingSkus.length * LANGUAGE_COUNT);
    expect(total.verifiedMismatchedCount).toBe(0);
    expect(total.verifiedMissingCount).toBe(0);

    // スキップした SKU の既存ベクトルは上書きされない
    for (const sku of storedSkus) {
      for (const language of VECTOR_LANGUAGES) {
        expect(dynamoStoredVector(sku.itemId, SKU_LIST_WAREHOUSE, language)).toEqual(
          storedVectorOf(sku, language, TEST_DIMENSIONS)
        );
      }
    }
  });

  it('全組がスキップされる再実行では Bedrock を 1 度も呼ばず COMPLETED になる', async () => {
    const skus = [skuOf(111), skuOf(112)];
    for (const sku of skus) transport.register(sku);
    seedGoodTable(skus);
    seedVectorTable(skus, () => ({
      model: CURRENT_MODEL,
      dimensions: TEST_DIMENSIONS,
      languages: ['ja', 'en'],
    }));

    const body = await invokeBatch({ phase: 'embed', forceRegenerate: false });
    const total = body.total as Record<string, number>;

    expect(body.status).toBe('COMPLETED');
    expect(transport.texts).toHaveLength(0);
    expect(total.bedrockCalls).toBe(0);
    expect(total.skippedCount).toBe(skus.length * LANGUAGE_COUNT);
    // 書き込みが無いので検証対象も 0。検証対象 0 は不合格にしない（要件 3.17 の保存則を満たす）
    expect(total.verifiedTargetCount).toBe(0);
    expect(total.failedCount).toBe(0);
    // Vector_Collection への書き込みも読み出しも発行しない
    expect(openSearch.bulkOperations).toEqual([]);
    expect(openSearch.readOperations).toEqual([]);
  });

  it('格納済みでもモデルまたは次元数が現行設定と異なる組は再生成される（要件 4.5）', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<'model' | 'dimensions'>('model', 'dimensions'),
        async (differing) => {
          dynamo = new FakeDynamoDb();
          openSearch = new FakeOpenSearch();
          transport = new FakeEmbeddingTransport();
          const skus = [skuOf(121)];
          for (const sku of skus) transport.register(sku);

          seedGoodTable(skus);
          seedVectorTable(skus, () => ({
            model: differing === 'model' ? 'amazon.titan-embed-text-v1' : CURRENT_MODEL,
            dimensions: differing === 'dimensions' ? 512 : TEST_DIMENSIONS,
            languages: ['ja', 'en'],
          }));

          const body = await invokeBatch({ phase: 'embed', forceRegenerate: false });
          const total = body.total as Record<string, number>;

          expect(total.skippedCount).toBe(0);
          expect(total.generatedCount).toBe(skus.length * LANGUAGE_COUNT);
          expect(body.status).toBe('COMPLETED');
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ============================================================
// 失敗一覧の多様性（task 17.2 / 欠陥 2 の回帰テスト）
// ============================================================

describe('失敗一覧が単一種類に占有されない（要件 3.10）', () => {
  /**
   * タスク 13.11 の実測では、保持された 100 件がすべて `VERIFICATION` /
   * `ACCESS_DENIED_IAM` になり、同時に起きていた 3 件の生成失敗の itemId が
   * 一覧から消えていた。ハンドラを通した経路でも種類が保たれることを固定する。
   *
   * 上限（100 件）を超える失敗を作るため、多数の SKU で書き込み失敗を起こしつつ、
   * 一部の SKU では**再試行対象外**の生成失敗を起こす。
   */
  it('大量の書き込み失敗があっても、再試行対象外の生成失敗の itemId と種別が残る', async () => {
    // 100 件（上限）を大きく超える失敗を作る。1 SKU で 2 組（両言語）が失敗する
    const writeFailureSkus = Array.from({ length: 120 }, (_, index) => skuOf(300 + index));
    const generationFailureSkus = [skuOf(901), skuOf(902), skuOf(903)];
    const allSkus = [...writeFailureSkus, ...generationFailureSkus];
    for (const sku of allSkus) transport.register(sku);

    seedGoodTable(allSkus);
    seedVectorTable(allSkus);

    const generationFailureItemIds = generationFailureSkus.map((sku) => sku.itemId);

    // 再試行対象外のエラー（要件 4.7）を日本語側だけに注入する。
    // 実測の `bedrockFailedCalls 3 / bedrockRetries 0` と同じ形である
    transport.failure = (pair) =>
      pair.language === 'ja' && generationFailureItemIds.includes(pair.itemId)
        ? validationError('injected non-retryable generation failure')
        : undefined;

    // 書き込み失敗の方は上限を食い潰す側。ベクトルを書く `SET` のみを失敗させる
    dynamo.failure = (call) => {
      const expression = call.input.UpdateExpression;
      if (
        call.name !== 'UpdateItemCommand' ||
        !call.tableNames.includes(VECTOR_TABLE_NAME) ||
        typeof expression !== 'string' ||
        !expression.startsWith('SET ') ||
        !expression.includes('embedding')
      ) {
        return undefined;
      }
      const itemId = (call.input.Key as Item | undefined)?.itemId?.S ?? '';
      return generationFailureItemIds.includes(itemId)
        ? undefined
        : conditionalCheckFailed();
    };

    const body = await invokeBatch({ phase: 'embed' });
    const failures = body.failures as {
      itemId: string;
      language: string;
      stage: string;
      errorCode: string;
      retryable: boolean;
    }[];
    const total = body.total as Record<string, number>;

    // 件数そのものは上限なく数える（要件 3.8 / 4.6）
    expect(total.failedCount).toBeGreaterThan(MAX_REPORTED_FAILURES);
    // 一覧は上限で打ち切られている
    expect(failures).toHaveLength(MAX_REPORTED_FAILURES);
    expect(body.failuresTruncated).toBe(true);

    // ── 欠陥 2 の否定：単一種類が枠を占有していない ───────────────
    const kinds = new Set(failures.map((failure) => `${failure.stage}/${failure.errorCode}`));
    expect(kinds.size).toBeGreaterThan(1);

    // 再試行対象外の生成失敗が、その itemId とエラー種別ごと一覧に残る（要件 3.10 / 4.7）。
    // ハンドラは失敗した言語（ja）に加えて、同一 SKU の他方の言語（en）も
    // 「未格納として扱う」記録を残すため、1 SKU につき 2 組が現れる
    const generationFailures = failures.filter(
      (failure) => failure.stage === 'GENERATION' && failure.retryable === false
    );
    const failingLanguageEntries = generationFailures.filter(
      (failure) => failure.language === 'ja'
    );

    // 失敗が起きた言語（ja）の itemId が 3 件そろって残る
    expect(failingLanguageEntries.map((failure) => failure.itemId).sort()).toEqual(
      generationFailureItemIds.slice().sort()
    );
    // 巻き込まれた側（en）も itemId とともに残る
    expect(
      generationFailures
        .filter((failure) => failure.language === 'en')
        .map((failure) => failure.itemId)
        .sort()
    ).toEqual(generationFailureItemIds.slice().sort());

    // 再試行対象外であったことが種別から読み取れる（再試行 0 回の原因の切り分けに使う）
    for (const failure of generationFailures) expect(failure.errorCode).not.toBe('THROTTLED');
    // 再試行対象外なので Bedrock の再試行は 1 回も起きていない（要件 4.7）
    expect(total.bedrockRetries).toBe(0);
    expect(total.bedrockFailedCalls).toBe(generationFailureItemIds.length);
  });
});
