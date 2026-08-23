/**
 * Vector_Verification_Path（案 D）
 *
 * `POST /vector-search/verify`。Vector_Collection に格納されたベクトルと Vector_Table に
 * 格納されたベクトルを突き合わせ、**件数と不一致の識別子のみ**を返す運用エンドポイント。
 *
 * ## なぜ検索 Lambda 上にあるのか
 *
 * 要件 3.6（書き込み後の読み出し検証）と要件 17.7（埋め込みバッチロールの Vector_Collection
 * 権限は `aoss:WriteDocument` のみ）は、同一の主体では両立しない。タスク 13.11 の実測では
 * 埋め込みバッチ側の検証が全件 `ACCESS_DENIED_IAM`（`security_exception: Bad Authorization`）
 * になった。検証専用の Lambda を新設する案は、その実行ロールがデータアクセスポリシーの
 * **4 件目の Principal** になるため却下されている（前提 A17）。
 *
 * したがって検証は、**既に `aoss:ReadDocument` / `aoss:DescribeIndex` を持つ
 * OpenSearch_Vector_Lambda に相乗りする**。データアクセスポリシーの Principal は 3 件のままで、
 * 追加する IAM は Vector_Table のテーブル ARN のみを Resource とする `dynamodb:GetItem` の
 * 1 ステートメントだけである（要件 17.15）。
 *
 * ## 設計上の約束
 *
 * - **ベクトル本体をリクエストにもレスポンスにも載せない**（要件 3.16 / Property 22）。
 *   リクエストは itemId の配列と任意の言語指定のみ、レスポンスは件数と
 *   (itemId, language, reason) のみである。突き合わせは本モジュール内で完結する
 * - **Bedrock を呼ばない**（要件 3.15）。埋め込みを生成せず、`@aws-sdk/client-bedrock-runtime`
 *   を import しない。既に生成済みの 10,000 組を再課金なしで検証するための必須条件である
 * - **AWS への呼び出しは 2 種類のみ。** Vector_Collection 側は `_mget` を 1 回、
 *   Vector_Table 側は itemId 1 件につき `GetItem` を 1 回。`SearchVectors` / `Query` / `Scan` /
 *   `_search` / `indices.*` を呼ぶ経路を持たない（要件 3.13 / 17.15）
 * - **集計と終了判定は `verification-summary.ts` に委譲する**（要件 3.17 / 3.18）。
 *   本モジュールは件数を数えるだけで、合否の式を持たない
 * - **検証対象の特定は `skip-decision.ts` の述語を使う**（要件 3.15）。埋め込みバッチの
 *   スキップ判定と同一の条件式であり、両者がずれない
 *
 * ## 環境変数
 *
 * | 変数名 | 必須 | 内容 |
 * |---|---|---|
 * | `VECTOR_TABLE_NAME` | 検証経路で必須 | Vector_Table のテーブル名 |
 * | `VECTOR_EMBEDDING_DIMENSIONS` | 任意 | 次元数。既定 1024 |
 * | `OPENSEARCH_VECTOR_ENDPOINT` / `VECTOR_INDEX_NAME` | 検索経路と共有 | `handler.ts` が解決する |
 *
 * 要件: 3.13, 3.14, 3.15, 3.16, 3.17, 3.18, 4.5, 17.4, 17.7, 17.15
 * 設計: Vector_Verification_Path（案 D）
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';

import {
  VECTOR_LANGUAGES,
  isVectorLanguage,
  resolveVectorField,
  type VectorLanguage,
} from '../shared/vector/language';
import {
  isVerificationTarget,
  type StoredEmbeddingState,
} from '../shared/vector/skip-decision';
import {
  addVerificationCounts,
  emptyVerificationCounts,
  resolveVerificationRunStatus,
  summarizeVerification,
  sumVerificationCounts,
  type VerificationCounts,
  type VerificationMismatchKey,
  type VerificationRunStatus,
  type VerificationSummary,
} from '../shared/vector/verification-summary';
import {
  classifyError,
  httpStatusForErrorCode,
  toClientError,
  type VectorErrorResponse,
} from '../shared/vector/errors';
import type { Warehouse } from '../shared/types';

// ============================================================
// 定数
// ============================================================

/** 検証経路のリソースパス。`api-gateway.ts` が定義するパスと同一 */
export const VERIFICATION_ROUTE_PATH = '/vector-search/verify';

/** 失敗した処理段階。検証経路は OpenSearch_Vector_Lambda 上にあるため検索段階と同一（要件 16.5） */
const STAGE = 'SEARCH_OPENSEARCH' as const;

/**
 * 1 リクエストで受け付ける itemId の上限件数（設計「実行タイミングと対象特定」）。
 *
 * 1 チャンクあたり `GetItem` 100 回 + `_mget` 1 回になる。運用スクリプトは
 * 5,000 SKU を 50 チャンクへ分けて反復する。
 */
export const MAX_VERIFICATION_ITEM_IDS = 100;

/**
 * Vector_Table 側で読み出す代表行の倉庫（`vector-embed-batch/handler.ts` の
 * `SKU_LIST_WAREHOUSE` と同一の規約）。
 *
 * 同一 SKU の 3 レコード（3 倉庫）には同一のベクトルを 1 回の `UpdateItem` で書いており、
 * OpenSearch 側も 3 ドキュメントへ同一のベクトルを `_bulk` で投入している。したがって
 * 代表行 1 件の一致が当該 SKU の一致を代表する（要件 3.5 の「複製」による帰結）。
 */
export const VERIFICATION_WAREHOUSE_ID = 'WH-TOKYO' as const satisfies Warehouse;

/** Vector_Table のテーブル名を渡す環境変数名 */
export const VECTOR_TABLE_NAME_ENV = 'VECTOR_TABLE_NAME';

/**
 * 次元数を渡す環境変数名。
 *
 * `shared/vector/embedding-generator.ts` の `EMBEDDING_DIMENSIONS_ENV` と同一の名前・
 * 同一の既定値を意図的に再掲している。当該モジュールは
 * `@aws-sdk/client-bedrock-runtime` を取り込むため、**Bedrock を呼ばない経路
 * （要件 3.15）へ Bedrock SDK を持ち込まない**ために import しない。
 * `vector-search-ddb/handler.ts` と同じ判断である。
 */
export const EMBEDDING_DIMENSIONS_ENV = 'VECTOR_EMBEDDING_DIMENSIONS';

/** 次元数の既定値（要件 3.3 / 5.2）。`DEFAULT_EMBEDDING_DIMENSIONS` と同一値 */
export const DEFAULT_EMBEDDING_DIMENSIONS = 1024;

/**
 * 検証対象の特定に使う埋め込みモデル識別子。
 *
 * `shared/vector/embedding-generator.ts` の `EMBEDDING_MODEL_ID` と同一の値を、
 * 上記と同じ理由（Bedrock SDK を取り込まない）で再掲している。
 * **両者の一致は `verify.test.ts` が固定する**（テストは Node 実行のため双方を import できる）。
 */
export const VERIFICATION_EMBEDDING_MODEL_ID = 'amazon.titan-embed-text-v2:0';

/** 検証の打ち切り時間（ms）。Lambda のタイムアウト 60 秒に対して余裕を残す */
const VERIFICATION_DEADLINE_MS = 45_000;

/** Vector_Table への `GetItem` の同時実行数。100 件を逐次で読むと待ち時間が積み上がる */
const GET_ITEM_CONCURRENCY = 8;

/** 突き合わせるベクトル属性名。両言語ぶんを `_mget` の `_source` へ指定する */
const VECTOR_FIELDS = VECTOR_LANGUAGES.map((language) => resolveVectorField(language));

/** CORS ヘッダー共通定義（検索経路と同一） */
const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/** 不一致理由の分類コード。`reason` の先頭に置き、`mismatchedKeys` のフィールドを増やさない */
export const VERIFICATION_REASON_CODES = {
  missingCollection: 'MISSING_OPENSEARCH',
  missingTable: 'MISSING_DYNAMODB',
  dimensionMismatch: 'DIMENSION_MISMATCH',
  valueMismatch: 'VALUE_MISMATCH',
} as const;

// ============================================================
// 入出力型
// ============================================================

/** 検証リクエスト。**ベクトル本体を受け取らない**（要件 3.16 / Property 22） */
export interface VerificationRequestBody {
  itemIds?: unknown;
  languages?: unknown;
}

/** 解釈済みのリクエスト */
export interface VerificationRequest {
  itemIds: string[];
  languages: VectorLanguage[];
}

/** 言語別の集計。合計と同じ形に対象外件数を足したもの */
export interface VerificationLanguageResult extends VerificationSummary {
  /** 検証対象にならなかった組の件数（当該言語のベクトルが無い、またはモデル・次元数が現行設定と異なる） */
  skippedCount: number;
}

/**
 * 検証応答。**ベクトル本体を含むフィールドを持たない**（要件 3.16 / Property 22）。
 *
 * `mismatchedKeys` は `verification-summary.ts` が 3 フィールドへ正規化した値である。
 */
export interface VerificationResponseBody extends VerificationSummary {
  path: 'verify';
  backend: 'opensearch';
  /** 実行状態。不合格のとき `COMPLETED` にならない（要件 3.18） */
  status: VerificationRunStatus;
  indexName: string;
  /** 対象特定に使ったモデル識別子（要件 3.15） */
  model: string;
  /** 対象特定に使った次元数（要件 3.15） */
  dimensions: number;
  /** 受け取った itemId の件数 */
  requestedItemIdCount: number;
  /** 検証した言語 */
  requestedLanguages: VectorLanguage[];
  /** 検証対象にならなかった組の件数（合計） */
  skippedCount: number;
  /** 言語別の集計（要件 3.14） */
  byLanguage: Partial<Record<VectorLanguage, VerificationLanguageResult>>;
  /** 発行した AWS 呼び出しの回数。`bedrockCalls` は常に 0（要件 3.15） */
  calls: { getItem: number; mget: number; bedrock: 0 };
  handlerLatencyMs: number;
}

// ============================================================
// 読み出し経路（I/O 境界）
// ============================================================

/** Vector_Table から読み出した 1 SKU 分の格納状態。ベクトル本体は本モジュール内に留まる */
export interface StoredVectorEntry extends StoredEmbeddingState {
  itemId: string;
  warehouseId: string;
  /** 言語ごとの格納済みベクトル。存在しない言語は undefined */
  vectors: Partial<Record<VectorLanguage, number[]>>;
}

/** Vector_Collection から読み出した 1 ドキュメント分のベクトル */
export interface CollectionVectorEntry {
  found: boolean;
  vectors: Partial<Record<VectorLanguage, number[]>>;
}

/**
 * 読み出し経路。実装は {@link createVerificationReader} のみが持つ。
 *
 * この境界を挟むことで、突き合わせと集計を AWS 呼び出しなしで検証できる。
 */
export interface VerificationReader {
  /** Vector_Table の代表行を `GetItem` で読む（要件 3.13） */
  readVectorTableEntry(itemId: string): Promise<StoredVectorEntry | undefined>;
  /** Vector_Collection のドキュメントを `_mget` で 1 回にまとめて読む（要件 3.13） */
  readCollectionVectors(
    documentIds: readonly string[]
  ): Promise<Record<string, CollectionVectorEntry>>;
  /** 発行した呼び出し回数。応答の `calls` に載せる */
  readonly calls: { getItem: number; mget: number };
}

/** `GetItem` を送れる最小の口。`DynamoDBClient` がそのまま満たす */
export interface DynamoDbGetItemSender {
  send(command: GetItemCommand): Promise<{ Item?: Record<string, AttributeValue> }>;
}

/** `_mget` を送れる最小の口。`@opensearch-project/opensearch` の `Client` がそのまま満たす */
export interface CollectionMgetSender {
  mget(
    params: {
      index: string;
      body: { docs: { _id: string; _source: string[] }[] };
    },
    options?: { requestTimeout?: number }
  ): Promise<{ body?: unknown }>;
}

/** 読み出し経路の生成に必要な資源 */
export interface VerificationReaderOptions {
  dynamodb: DynamoDbGetItemSender;
  collection: CollectionMgetSender;
  tableName: string;
  indexName: string;
}

/**
 * 実際の AWS へ読み出す経路を作る。
 *
 * **発行する呼び出しは `GetItem` と `_mget` の 2 種類のみ**である。他の API を呼ぶ
 * 分岐を持たない（要件 3.13 / 17.15）。
 */
export function createVerificationReader(
  options: VerificationReaderOptions
): VerificationReader {
  const calls = { getItem: 0, mget: 0 };

  return {
    calls,

    async readVectorTableEntry(itemId: string): Promise<StoredVectorEntry | undefined> {
      calls.getItem += 1;

      // 射影はベクトル 2 本とモデル・次元数のみ。キー属性は呼び出し側が既に持っている。
      // 強整合読み取りにするのは、結果整合で書き込み前の値を読んで
      // 不一致と誤判定する経路を残さないため
      const result = await options.dynamodb.send(
        new GetItemCommand({
          TableName: options.tableName,
          Key: {
            itemId: { S: itemId },
            warehouseId: { S: VERIFICATION_WAREHOUSE_ID },
          },
          ProjectionExpression: [
            '#embeddingJa',
            '#embeddingEn',
            '#embeddingModel',
            '#embeddingDimensions',
          ].join(', '),
          ExpressionAttributeNames: {
            '#embeddingJa': 'embeddingJa',
            '#embeddingEn': 'embeddingEn',
            '#embeddingModel': 'embeddingModel',
            '#embeddingDimensions': 'embeddingDimensions',
          },
          ConsistentRead: true,
        })
      );

      const item = result?.Item;
      if (item === undefined) return undefined;
      return toStoredVectorEntry(itemId, item);
    },

    async readCollectionVectors(
      documentIds: readonly string[]
    ): Promise<Record<string, CollectionVectorEntry>> {
      if (documentIds.length === 0) return {};

      calls.mget += 1;

      // `_mget` を 1 回だけ発行する。`_search` を使わないため、ベクトルインデックスの
      // バックフィル状態に依存しない（タスク 13.12 と並行して実行できる）
      const response = await options.collection.mget({
        index: options.indexName,
        body: {
          docs: documentIds.map((id) => ({ _id: id, _source: [...VECTOR_FIELDS] })),
        },
      });

      return readMgetResponse(response?.body);
    },
  };
}

// ============================================================
// 応答の読み取り（純関数）
// ============================================================

/** `GetItem` のアイテムを {@link StoredVectorEntry} へ写す */
export function toStoredVectorEntry(
  itemId: string,
  item: Record<string, AttributeValue>
): StoredVectorEntry {
  const vectors: Partial<Record<VectorLanguage, number[]>> = {};
  const hasEmbedding: Partial<Record<VectorLanguage, boolean>> = {};

  for (const language of VECTOR_LANGUAGES) {
    const vector = toNumberVectorFromAttribute(item[resolveVectorField(language)]);
    hasEmbedding[language] = vector !== undefined && vector.length > 0;
    if (vector !== undefined) vectors[language] = vector;
  }

  const dimensions = item.embeddingDimensions?.N;

  return {
    itemId,
    warehouseId: VERIFICATION_WAREHOUSE_ID,
    embeddingModel: item.embeddingModel?.S,
    embeddingDimensions: dimensions === undefined ? undefined : Number(dimensions),
    hasEmbedding,
    vectors,
  };
}

/** `_mget` の応答本文を `_id` 単位のレコードへ写す */
export function readMgetResponse(body: unknown): Record<string, CollectionVectorEntry> {
  const entries: Record<string, CollectionVectorEntry> = {};
  const docs = (body as { docs?: unknown } | undefined)?.docs;
  if (!Array.isArray(docs)) return entries;

  for (const doc of docs) {
    const record = doc as {
      _id?: unknown;
      found?: unknown;
      _source?: Record<string, unknown>;
    };
    const id = record?._id;
    if (typeof id !== 'string' || id.length === 0) continue;

    const source = record._source;
    const vectors: Partial<Record<VectorLanguage, number[]>> = {};
    for (const language of VECTOR_LANGUAGES) {
      const vector = toNumberVectorFromSource(source?.[resolveVectorField(language)]);
      if (vector !== undefined) vectors[language] = vector;
    }

    entries[id] = { found: record.found === true, vectors };
  }

  return entries;
}

/**
 * DynamoDB の `L` of `N` を `number[]` へ変換する。
 *
 * 各要素へ `Math.fround()` を適用する。書き込み時点で f32 に丸めた値であり丸めは
 * 冪等なので値は変わらないが、10 進表記の往復で 32bit 表現から外れた値が混ざった
 * 場合に比較で検出できるようにするため、読み出し側でも同じ丸めを通す。
 */
function toNumberVectorFromAttribute(value: AttributeValue | undefined): number[] | undefined {
  if (!Array.isArray(value?.L)) return undefined;
  return value.L.map((element) => Math.fround(Number(element.N)));
}

/** `_source` の数値配列を `number[]` へ変換する。DynamoDB 側と同じ f32 丸めを通す */
function toNumberVectorFromSource(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((element) => Math.fround(Number(element)));
}

// ============================================================
// ドキュメント ID（純関数）
// ============================================================

/**
 * OpenSearch のドキュメント ID（`amplify/custom/vector-collection.ts` の
 * `buildVectorDocumentId`、および `vector-embed-batch/handler.ts` と同一の規約）。
 *
 * あちらは CDK モジュール（`aws-cdk-lib` 依存）であり Lambda バンドルへ持ち込めないため
 * 同じ 1 行を再掲する。`_id` の組み立て違いは不一致の原因の第 1 候補であるため、
 * 規約を 1 行に閉じておく。
 */
export function buildVectorDocumentId(itemId: string, warehouseId: string): string {
  return `${itemId}#${warehouseId}`;
}

// ============================================================
// 突き合わせ（純関数、要件 3.14）
// ============================================================

/** 1 組の突き合わせ結果 */
export type VectorComparisonOutcome = 'MATCHED' | 'MISMATCHED' | 'MISSING';

export interface VectorComparison {
  outcome: VectorComparisonOutcome;
  /** 一致した場合は undefined */
  reason?: string;
}

/**
 * 2 つのベクトルを**要素単位**で突き合わせる（要件 3.14）。
 *
 * 判定は 3 段。(1) 双方に存在するか、(2) 次元数が設定値と一致するか、
 * (3) 全次元の値が厳密に一致するか。両側とも f32 に丸めた値を書いているため、
 * 一致は近似ではなくビット等価として判定できる。
 *
 * 理由の文言に**ベクトル本体を載せない**。不一致となった 1 次元の値のみを載せる
 * （1,024 要素の数列を応答へ流さないため）。
 *
 * 純関数であり、例外を投げない。
 */
export function compareStoredVectors(
  tableVector: readonly number[] | undefined,
  collectionVector: readonly number[] | undefined,
  dimensions: number
): VectorComparison {
  if (tableVector === undefined || collectionVector === undefined) {
    if (tableVector === undefined && collectionVector === undefined) {
      return {
        outcome: 'MISSING',
        reason: `${VERIFICATION_REASON_CODES.missingTable}: 両バックエンドにベクトルが存在しません。`,
      };
    }
    return tableVector === undefined
      ? {
          outcome: 'MISSING',
          reason: `${VERIFICATION_REASON_CODES.missingTable}: Vector_Table 側にベクトルが存在しません。`,
        }
      : {
          outcome: 'MISSING',
          reason: `${VERIFICATION_REASON_CODES.missingCollection}: Vector_Collection 側にベクトルが存在しません。`,
        };
  }

  if (tableVector.length !== dimensions || collectionVector.length !== dimensions) {
    return {
      outcome: 'MISMATCHED',
      reason:
        `${VERIFICATION_REASON_CODES.dimensionMismatch}: 設定値 ${dimensions}、` +
        `Vector_Table ${tableVector.length}、Vector_Collection ${collectionVector.length}。`,
    };
  }

  for (let index = 0; index < dimensions; index += 1) {
    if (tableVector[index] !== collectionVector[index]) {
      return {
        outcome: 'MISMATCHED',
        reason:
          `${VERIFICATION_REASON_CODES.valueMismatch}: 第 ${index} 次元が一致しません` +
          `（Vector_Table: ${tableVector[index]}、Vector_Collection: ${collectionVector[index]}）。`,
      };
    }
  }

  return { outcome: 'MATCHED' };
}

// ============================================================
// リクエストの解釈（純関数）
// ============================================================

/** 解釈結果。失敗時はそのまま応答へ載せられるエラーを持つ */
export type VerificationRequestParse =
  | { ok: true; request: VerificationRequest }
  | { ok: false; error: VectorErrorResponse };

/**
 * リクエストを解釈する（要件 3.13）。
 *
 * - `itemIds` は 1 件以上 {@link MAX_VERIFICATION_ITEM_IDS} 件以下の文字列配列。重複は除く
 * - `languages` は省略可。省略時は両言語。`ja` / `en` 以外は拒否する（要件 10.7 と同じ規則）
 * - **ベクトル本体を受け取るフィールドを持たない**（要件 3.16）
 */
export function parseVerificationRequest(body: unknown): VerificationRequestParse {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      error: toClientError('INVALID_QUERY', STAGE, {
        detail: 'リクエストボディを JSON オブジェクトとして解釈できませんでした。',
      }),
    };
  }

  const raw = (body as VerificationRequestBody).itemIds;
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: toClientError('INVALID_QUERY', STAGE, {
        detail: 'itemIds は 1 件以上の文字列配列で指定してください。',
      }),
    };
  }

  const itemIds: string[] = [];
  for (const element of raw) {
    if (typeof element !== 'string') {
      return {
        ok: false,
        error: toClientError('INVALID_QUERY', STAGE, {
          detail: 'itemIds の要素は文字列のみを受け付けます。',
        }),
      };
    }
    const itemId = element.trim();
    if (itemId.length === 0) continue;
    if (itemIds.indexOf(itemId) < 0) itemIds.push(itemId);
  }

  if (itemIds.length === 0) {
    return {
      ok: false,
      error: toClientError('INVALID_QUERY', STAGE, {
        detail: 'itemIds が空です。1 件以上の itemId を指定してください。',
      }),
    };
  }

  if (itemIds.length > MAX_VERIFICATION_ITEM_IDS) {
    return {
      ok: false,
      error: toClientError('INVALID_QUERY', STAGE, {
        detail:
          `itemIds は 1 回のリクエストで最大 ${MAX_VERIFICATION_ITEM_IDS} 件です` +
          `（指定件数: ${itemIds.length}）。チャンクに分けて呼び出してください。`,
      }),
    };
  }

  const languagesParse = parseLanguages((body as VerificationRequestBody).languages);
  if (!languagesParse.ok) return { ok: false, error: languagesParse.error };

  return { ok: true, request: { itemIds, languages: languagesParse.languages } };
}

/** 言語指定を解釈する。省略時は両言語 */
function parseLanguages(
  value: unknown
): { ok: true; languages: VectorLanguage[] } | { ok: false; error: VectorErrorResponse } {
  if (value === undefined || value === null) {
    return { ok: true, languages: [...VECTOR_LANGUAGES] };
  }

  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: toClientError('INVALID_LANGUAGE', STAGE, {
        detail: `languages は配列で指定してください。許容値: ${VECTOR_LANGUAGES.join(' / ')}。`,
      }),
    };
  }

  const languages: VectorLanguage[] = [];
  for (const element of value) {
    if (!isVectorLanguage(element)) {
      return {
        ok: false,
        error: toClientError('INVALID_LANGUAGE', STAGE, {
          detail: `languages に許容外の値が含まれています。許容値: ${VECTOR_LANGUAGES.join(' / ')}。`,
        }),
      };
    }
    if (languages.indexOf(element) < 0) languages.push(element);
  }

  return languages.length === 0
    ? { ok: true, languages: [...VECTOR_LANGUAGES] }
    : { ok: true, languages };
}

// ============================================================
// 検証本体
// ============================================================

/** 検証の実行設定 */
export interface VerificationConfig {
  indexName: string;
  model: string;
  dimensions: number;
}

/**
 * 検証を 1 チャンク分実行する（要件 3.14 / 3.15 / 3.17）。
 *
 * 1. Vector_Table の代表行を `GetItem` で読む（itemId 1 件につき 1 回）
 * 2. 検証対象の組を `skip-decision.ts` の述語で特定する（要件 3.15）
 * 3. Vector_Collection のドキュメントを `_mget` で 1 回にまとめて読む
 * 4. 突き合わせて言語別に一致 / 不一致 / 未格納を数える
 * 5. 集計と合否判定を `verification-summary.ts` へ委譲する
 *
 * **ベクトル本体は本関数の外へ出ない。** 戻り値は件数と識別子のみである。
 */
export async function runVerification(
  request: VerificationRequest,
  reader: VerificationReader,
  config: VerificationConfig
): Promise<Omit<VerificationResponseBody, 'handlerLatencyMs' | 'calls'>> {
  const entries = await readVectorTableEntries(reader, request.itemIds);

  // 検証対象になった組だけがドキュメント読み出しの対象になる。
  // 対象が 0 件なら `_mget` を発行しない（無意味な読み出しを 1 回も起こさない）
  const targets: { itemId: string; language: VectorLanguage; entry: StoredVectorEntry }[] = [];
  const skippedByLanguage: Partial<Record<VectorLanguage, number>> = {};
  for (const language of request.languages) skippedByLanguage[language] = 0;

  for (const itemId of request.itemIds) {
    const entry = entries[itemId];
    for (const language of request.languages) {
      if (
        entry !== undefined &&
        isVerificationTarget(entry, language, config.model, config.dimensions)
      ) {
        targets.push({ itemId, language, entry });
        continue;
      }
      skippedByLanguage[language] = (skippedByLanguage[language] ?? 0) + 1;
    }
  }

  const documentIds: string[] = [];
  for (const target of targets) {
    const documentId = buildVectorDocumentId(target.itemId, target.entry.warehouseId);
    if (documentIds.indexOf(documentId) < 0) documentIds.push(documentId);
  }

  const documents = await reader.readCollectionVectors(documentIds);

  // ─── 突き合わせ ──────────────────────────────────────────────────
  const countsByLanguage: Partial<Record<VectorLanguage, VerificationCounts>> = {};
  const keysByLanguage: Partial<Record<VectorLanguage, VerificationMismatchKey[]>> = {};
  for (const language of request.languages) {
    countsByLanguage[language] = emptyVerificationCounts();
    keysByLanguage[language] = [];
  }

  for (const target of targets) {
    const counts = countsByLanguage[target.language] ?? emptyVerificationCounts();
    const keys = keysByLanguage[target.language] ?? [];

    const document = documents[buildVectorDocumentId(target.itemId, target.entry.warehouseId)];
    const comparison = compareStoredVectors(
      target.entry.vectors[target.language],
      document?.vectors[target.language],
      config.dimensions
    );

    countsByLanguage[target.language] = addVerificationCounts(counts, {
      targetCount: 1,
      matchedCount: comparison.outcome === 'MATCHED' ? 1 : 0,
      mismatchedCount: comparison.outcome === 'MISMATCHED' ? 1 : 0,
      missingCount: comparison.outcome === 'MISSING' ? 1 : 0,
    });

    if (comparison.outcome !== 'MATCHED') {
      keys.push({
        itemId: target.itemId,
        language: target.language,
        reason: comparison.reason ?? '',
      });
      keysByLanguage[target.language] = keys;
    }
  }

  // ─── 集計（唯一の経路）──────────────────────────────────────────
  const byLanguage: Partial<Record<VectorLanguage, VerificationLanguageResult>> = {};
  const allCounts: VerificationCounts[] = [];
  const allKeys: VerificationMismatchKey[] = [];

  for (const language of request.languages) {
    const counts = countsByLanguage[language] ?? emptyVerificationCounts();
    const keys = keysByLanguage[language] ?? [];
    allCounts.push(counts);
    for (const key of keys) allKeys.push(key);

    byLanguage[language] = {
      ...summarizeVerification(counts, keys),
      skippedCount: skippedByLanguage[language] ?? 0,
    };
  }

  const total = summarizeVerification(sumVerificationCounts(allCounts), allKeys);
  let skippedCount = 0;
  for (const language of request.languages) skippedCount += skippedByLanguage[language] ?? 0;

  return {
    path: 'verify',
    backend: 'opensearch',
    ...total,
    status: resolveVerificationRunStatus(total),
    indexName: config.indexName,
    model: config.model,
    dimensions: config.dimensions,
    requestedItemIdCount: request.itemIds.length,
    requestedLanguages: [...request.languages],
    skippedCount,
    byLanguage,
  };
}

/** Vector_Table の代表行を並行して読む。同時実行数を抑えてスロットリングを避ける */
async function readVectorTableEntries(
  reader: VerificationReader,
  itemIds: readonly string[]
): Promise<Record<string, StoredVectorEntry>> {
  const entries: Record<string, StoredVectorEntry> = {};
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= itemIds.length) return;
      const itemId = itemIds[index];
      const entry = await reader.readVectorTableEntry(itemId);
      if (entry !== undefined) entries[itemId] = entry;
    }
  };

  const workers: Promise<void>[] = [];
  const parallelism = Math.min(GET_ITEM_CONCURRENCY, itemIds.length);
  for (let slot = 0; slot < parallelism; slot += 1) workers.push(worker());
  await Promise.all(workers);

  return entries;
}

// ============================================================
// ハンドラ（`handler.ts` から呼ばれる）
// ============================================================

/**
 * 検証経路のリクエストか判定する。
 *
 * API Gateway プロキシ統合の `resource`（リソースパス）と `path`（実パス）の双方を見る。
 * 検索経路（`/vector-search/opensearch`）と同一の Lambda が受けるため、この判定が
 * 経路の唯一の分岐点である。
 */
export function isVerificationRequest(
  event: Pick<APIGatewayProxyEvent, 'resource' | 'path'> | undefined
): boolean {
  const candidates = [event?.resource, event?.path];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const normalized = candidate.replace(/\/+$/, '');
    if (normalized.endsWith(VERIFICATION_ROUTE_PATH)) return true;
  }
  return false;
}

/** ハンドラが必要とする資源 */
export interface VerificationHandlerDeps {
  dynamodb: DynamoDbGetItemSender;
  collection: CollectionMgetSender;
  indexName: string;
  /** 省略時は環境変数 `VECTOR_TABLE_NAME` から解決する */
  tableName?: string;
  /** 省略時は環境変数 `VECTOR_EMBEDDING_DIMENSIONS` から解決する */
  dimensions?: number;
  /** 省略時は {@link VERIFICATION_EMBEDDING_MODEL_ID} */
  model?: string;
  /** 試験用の読み出し経路の差し替え口。省略時は {@link createVerificationReader} を使う */
  reader?: VerificationReader;
}

/**
 * `POST /vector-search/verify` を処理する。
 *
 * 応答生成は成功・失敗ともに 1 経路に閉じる。エラー応答は `errors.ts` の
 * `toClientError()` / `classifyError()` のみが生成する（要件 16.9）。
 */
export async function handleVerificationRequest(
  event: Pick<APIGatewayProxyEvent, 'body' | 'isBase64Encoded'>,
  deps: VerificationHandlerDeps
): Promise<APIGatewayProxyResult> {
  const startedAtMs = Date.now();

  try {
    const tableName = deps.tableName ?? resolveEnv(VECTOR_TABLE_NAME_ENV);
    if (tableName === undefined) {
      return errorResult(
        toClientError('INTERNAL_ERROR', STAGE, {
          detail: `環境変数 ${VECTOR_TABLE_NAME_ENV} が設定されていないため検証を実行できません。`,
        })
      );
    }

    const parsed = parseVerificationRequest(parseBody(event));
    if (!parsed.ok) return errorResult(parsed.error);

    const reader =
      deps.reader ??
      createVerificationReader({
        dynamodb: deps.dynamodb,
        collection: deps.collection,
        tableName,
        indexName: deps.indexName,
      });

    const result = await withDeadline(
      runVerification(parsed.request, reader, {
        indexName: deps.indexName,
        model: deps.model ?? VERIFICATION_EMBEDDING_MODEL_ID,
        dimensions: deps.dimensions ?? resolveDimensions(),
      }),
      VERIFICATION_DEADLINE_MS
    );

    const body: VerificationResponseBody = {
      ...result,
      // Bedrock は 1 度も呼ばない（要件 3.15）。0 を固定値として応答へ載せ、
      // 運用スクリプトが再生成の不在を機械的に確認できるようにする
      calls: { getItem: reader.calls.getItem, mget: reader.calls.mget, bedrock: 0 },
      handlerLatencyMs: Date.now() - startedAtMs,
    };

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(body) };
  } catch (error: unknown) {
    // 内部の詳細は CloudWatch Logs にのみ残す（要件 16.9）
    console.error('vector-search-aoss verify error:', error);
    return errorResult(classifyError(error, STAGE));
  }
}

// ============================================================
// ヘルパー
// ============================================================

/** 環境変数を取り出す。未設定・空白のみは undefined */
function resolveEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** 次元数を解決する。不正値は既定値へ落とす（Lambda の起動を設定ミスで止めない） */
function resolveDimensions(): number {
  const raw = resolveEnv(EMBEDDING_DIMENSIONS_ENV);
  if (raw === undefined) return DEFAULT_EMBEDDING_DIMENSIONS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_EMBEDDING_DIMENSIONS;
}

/** リクエストボディを JSON として解釈する。Base64 エンコードにも対応する */
function parseBody(event: Pick<APIGatewayProxyEvent, 'body' | 'isBase64Encoded'>): unknown {
  if (typeof event?.body !== 'string' || event.body.trim().length === 0) return {};

  let text = event.body;
  if (event.isBase64Encoded === true) {
    try {
      text = Buffer.from(event.body, 'base64').toString('utf8');
    } catch {
      return undefined;
    }
  }

  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 打ち切りを表す内部エラー */
class VerificationDeadlineExceededError extends Error {
  constructor(deadlineMs: number) {
    super(`verification exceeded the ${deadlineMs}ms deadline`);
    this.name = 'TimeoutError';
  }
}

/** 期限までに完了しなければ打ち切る。打ち切り時は部分結果を返さない */
async function withDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new VerificationDeadlineExceededError(deadlineMs)), deadlineMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** エラー応答を API Gateway 応答へ変換する。`errors.ts` が生成した内容のみを載せる */
function errorResult(error: VectorErrorResponse): APIGatewayProxyResult {
  return {
    statusCode: httpStatusForErrorCode(error.errorCode),
    headers: CORS_HEADERS,
    body: JSON.stringify(error),
  };
}
