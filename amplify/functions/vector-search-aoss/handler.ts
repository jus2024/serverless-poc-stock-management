/**
 * OpenSearch_Vector_Lambda（`kiro-vector-search-aoss`）
 *
 * `POST /vector-search/opensearch` の k-NN 検索エンドポイント。
 * 既存 `amplify/functions/opensearch-search/handler.ts` と同じ
 * `@opensearch-project/opensearch` + `AwsSigv4Signer`（`service: 'aoss'`）構成を踏襲する。
 *
 * DynamoDB_Vector_Lambda との比較の公平性は次の 3 点で担保する（要件 9.3）。
 * - クエリベクトルと言語は同一の `queryId`（Query_Vector_Cache）から解決する
 * - k は `topk.ts` の `normalizeTopK()` が返す適用後 TopK をそのまま使う
 * - 言語 → ベクトルフィールドの対応は `language.ts` の `resolveVectorField()` のみが決める
 *
 * 応答生成は成功・失敗ともに 1 経路に閉じる。エラー応答は `errors.ts` の
 * `toClientError()` / `classifyError()` / `queryExpiredError()` のみが生成し、
 * 例外オブジェクトを直接 API 応答へ変換しない（要件 16.9）。
 *
 * ## 環境変数（task 8.7 の配線対象）
 *
 * | 変数名 | 必須 | 内容 |
 * |---|---|---|
 * | `OPENSEARCH_VECTOR_ENDPOINT` | 必須 | Vector_Collection `kiro-inventory-vector` のエンドポイント URL |
 * | `VECTOR_INDEX_NAME` | 任意 | インデックス名。既定 `inventory-vector` |
 * | `QUERY_CACHE_TABLE_NAME` | 任意 | Query_Vector_Cache のテーブル名。既定 `kiro-vector-query-cache` |
 * | `OPENSEARCH_SCORE_FORMULA` | 任意 | スコア逆算式の上書き。`score-normalize.ts` が解釈する |
 * | `AWS_REGION` | 自動 | Lambda 実行環境が設定する |
 *
 * ## Query_Vector_Cache のアイテム契約（`kiro-vector-query-cache`、PK `queryId`）
 *
 * | 属性 | 型 | 内容 |
 * |---|---|---|
 * | `queryId` | S | ハンドル（UUID v4） |
 * | `vector` | L\<N\> | f32 に丸め済みのクエリベクトル。別名 `embedding` も受理する |
 * | `language` | S | `ja` / `en` |
 * | `expiresAt` | N | 失効時刻（epoch 秒）。TTL 属性 |
 *
 * TTL による削除は遅延するため、`expiresAt` を過ぎたアイテムを読み出した場合も
 * 失効として扱う（要件 16.6）。
 *
 * 要件: 9.1, 9.2, 9.3, 9.4, 9.5, 9.7, 9.8, 9.9, 9.10, 9.11, 9.12, 16.4, 16.6, 16.7, 16.9
 * 設計: OpenSearch_Vector_Lambda
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

import { isVectorLanguage, resolveVectorField, type VectorLanguage } from '../shared/vector/language';
import { normalizeTopK } from '../shared/vector/topk';
import {
  isDistanceBasisMismatch,
  normalizeOpenSearchScore,
  resolveScoreNormalizationFormula,
  type ScoreNormalizationFormula,
} from '../shared/vector/score-normalize';
import { getVectorCapabilities, supportsFilterKind } from '../shared/vector/constraints';
import {
  classifyError,
  httpStatusForErrorCode,
  queryExpiredError,
  toClientError,
  type VectorErrorResponse,
} from '../shared/vector/errors';
import { handleVerificationRequest, isVerificationRequest } from './verify';

// ---------------------------------------------------------------------------
// 定数と実行環境
// ---------------------------------------------------------------------------

/** 本ハンドラの処理段階。エラー応答の `stage` に載せる（要件 16.5） */
const STAGE = 'SEARCH_OPENSEARCH' as const;

/** 検索の打ち切り時間（要件 9.9）。超過時は部分結果を返さない */
const SEARCH_DEADLINE_MS = 30_000;

/** インデックス名。マッピングは `amplify/custom/vector-collection.ts` が定義する */
const INDEX_NAME = process.env.VECTOR_INDEX_NAME ?? 'inventory-vector';

/** Query_Vector_Cache のテーブル名 */
const QUERY_CACHE_TABLE_NAME = process.env.QUERY_CACHE_TABLE_NAME ?? 'kiro-vector-query-cache';

/**
 * `_source` から除外するベクトルフィールド。**両言語を除外する**（要件 9.1）。
 * 検索対象が片方の言語であっても、他方のベクトルが応答へ乗る経路を残さない。
 */
const EXCLUDED_SOURCE_FIELDS = ['embeddingJa', 'embeddingEn'] as const;

/** 倉庫フィルタの対象フィールド名。マッピングで keyword 型のため `.keyword` を付けない（要件 9.4） */
const WAREHOUSE_FILTER_FIELD = 'warehouseId';

/** OpenSearch 側の機能制約。応答の `constraints` に載せる（要件 15.6） */
const CAPABILITIES = getVectorCapabilities('opensearch');

/** CORS ヘッダー共通定義（既存ハンドラと同一方式） */
const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/** OpenSearch クライアント（SigV4 署名、AOSS 接続） */
const client = new Client({
  ...AwsSigv4Signer({
    region: process.env.AWS_REGION!,
    service: 'aoss',
    getCredentials: () => defaultProvider()(),
  }),
  node: process.env.OPENSEARCH_VECTOR_ENDPOINT!,
});

/** Query_Vector_Cache 読み取り用クライアント */
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });

/**
 * コールドスタート判定用フラグ（要件 8.13 と同一方式）。
 * モジュールスコープで保持し、最初の呼び出しの応答生成後に false にする。
 */
let isColdStart = true;

// ---------------------------------------------------------------------------
// 入出力型
// ---------------------------------------------------------------------------

/** 検索リクエスト。言語は `queryId` に内包されるため受け取らない */
interface VectorSearchRequestBody {
  queryId?: unknown;
  topK?: unknown;
  warehouseId?: unknown;
  /** 範囲フィルタ実測プローブ専用。既定の検索では使用しない */
  rangeFilter?: { field?: unknown; min?: unknown; max?: unknown };
}

/** 検索結果 1 件。両言語のベクトルを含めない（要件 9.1） */
interface VectorSearchHit {
  itemId: string;
  warehouseId: string;
  productName: string;
  category: string;
  origin: string;
  roastLevel: string;
  flavorNotes: string;
  quantity: number;
  location: string;
  unitPrice: number;
  rank: number;
  distance: number;
  rawScore: number;
  distanceBasisMismatch?: boolean;
}

/** フィルタ 0 件かつ非フィルタ 1 件以上のときの診断（要件 9.10） */
interface VectorFilterDiagnostics {
  filterField: string;
  message: string;
}

/** `POST /vector-search/opensearch` の応答（`src/lib/inventory/vector-types.ts` と同形） */
interface OpenSearchVectorSearchResponse {
  backend: 'opensearch';
  hits: VectorSearchHit[];
  language: VectorLanguage;
  requestedTopK: number;
  appliedTopK: number;
  returnedCount: number;
  distinctSkuCount: number;
  took: number;
  searchLatencyMs: number;
  handlerLatencyMs: number;
  coldStart: boolean;
  indexName: string;
  vectorField: string;
  spaceType: 'cosinesimil';
  distanceSemantics: 'lower_is_closer';
  scoreNormalization: ScoreNormalizationFormula;
  filterApplied: string[];
  status?: 'NO_DOCUMENTS';
  documentCount?: number;
  filterDiagnostics?: VectorFilterDiagnostics;
  insufficientNeighborsNote?: string;
  constraints: typeof CAPABILITIES;
}

/** `_search` レスポンスから読み取る部分のみを型に持つ */
interface OpenSearchHit {
  _id?: string;
  _score?: number;
  _source?: Record<string, unknown>;
}

interface OpenSearchSearchBody {
  took?: number;
  hits?: { hits?: OpenSearchHit[] };
}

/** Query_Vector_Cache から解決したクエリの内容 */
interface ResolvedQuery {
  vector: number[];
  language: VectorLanguage;
}

// ---------------------------------------------------------------------------
// ハンドラ
// ---------------------------------------------------------------------------

/**
 * OpenSearch k-NN 検索ハンドラー
 *
 * POST /vector-search/opensearch
 * body: `{ queryId, topK, warehouseId?, rangeFilter? }`
 */
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const handlerStart = Date.now();
  const coldStart = isColdStart;
  isColdStart = false;

  // ─── 0. 経路の分岐（Vector_Verification_Path、案 D）───────────────────
  // `POST /vector-search/verify` は同一の Lambda が受ける。検証専用 Lambda を
  // 作らないのは、その実行ロールがデータアクセスポリシーの 4 件目の Principal に
  // なり、要件 17.7 の「3 件のみ」という構成が崩れるためである（前提 A17）。
  // 既に `aoss:ReadDocument` / `aoss:DescribeIndex` を持つ本 Lambda に相乗りさせる
  if (isVerificationRequest(event)) {
    return handleVerificationRequest(event, {
      dynamodb: dynamoClient,
      collection: client,
      indexName: INDEX_NAME,
    });
  }

  try {
    // ─── 1. リクエストの解釈 ────────────────────────────────────────────
    const body = parseBody(event.body);
    if (body === undefined) {
      return errorResult(
        toClientError('INVALID_QUERY', STAGE, {
          detail: 'リクエストボディを JSON として解釈できませんでした。',
        })
      );
    }

    const queryId = typeof body.queryId === 'string' ? body.queryId.trim() : '';
    if (queryId.length === 0) {
      return errorResult(
        toClientError('INVALID_QUERY', STAGE, {
          detail: 'queryId は必須です。先に埋め込み生成を実行してください。',
        })
      );
    }

    // ─── 2. TopK 正規化（DynamoDB 側と同一関数、要件 9.3）──────────────
    // 失敗時は OpenSearch へリクエストを送らない（要件 16.9 の下流非実行）
    const topK = normalizeTopK(body.topK);
    if (!topK.ok) {
      return errorResult(toClientError('INVALID_TOPK', STAGE, { detail: topK.message }));
    }

    // ─── 3. クエリベクトルと言語の解決（要件 9.3 / 16.6）────────────────
    const resolved = await resolveQuery(queryId);
    if (resolved === undefined) {
      return errorResult(queryExpiredError(STAGE));
    }

    // ─── 4. 言語ルーティング（要件 9.2）────────────────────────────────
    // `resolveVectorField()` が唯一の決定経路。表示用メタデータの言語接尾辞も
    // ここから導出し、言語判定の分岐を 2 つ持たない
    const vectorField = resolveVectorField(resolved.language);
    const metadataSuffix = metadataSuffixOf(vectorField);

    // ─── 5. フィルタ構築（要件 9.4）────────────────────────────────────
    const warehouseId = typeof body.warehouseId === 'string' && body.warehouseId.length > 0
      ? body.warehouseId
      : undefined;
    const rangeFilter = resolveRangeFilter(body.rangeFilter);
    const filterClauses = buildFilterClauses(warehouseId, rangeFilter);
    const filterApplied = filterClauses.map((clause) => clause.field);

    // ─── 6. k-NN 検索の実行 ────────────────────────────────────────────
    const formula = resolveScoreNormalizationFormula();
    const deadlineAt = Date.now() + SEARCH_DEADLINE_MS;

    const searchStart = Date.now();
    const searchBody = await withDeadline(
      searchKnn(resolved.vector, topK.appliedTopK, vectorField, filterClauses, deadlineAt),
      deadlineAt
    );
    const searchLatencyMs = Date.now() - searchStart;

    const rawHits = searchBody.hits?.hits ?? [];
    const hits = rawHits.map((hit, index) =>
      toSearchHit(hit, index + 1, metadataSuffix, formula)
    );

    // ─── 7. 0 件時の診断（要件 9.10 / 16.4）───────────────────────────
    // フィルタ有無の確認クエリは 0 件時に 1 回だけ実行する。
    // 登録ドキュメント数の確認は、確認クエリでも 0 件だった場合にのみ行う
    // （フィルタ起因と未投入を区別するために必要な別種の問い合わせ）
    let filterDiagnostics: VectorFilterDiagnostics | undefined;
    let documentCount: number | undefined;

    if (hits.length === 0) {
      let unfilteredCount = 0;

      if (filterClauses.length > 0) {
        const probe = await withDeadline(
          searchKnn(resolved.vector, topK.appliedTopK, vectorField, [], deadlineAt),
          deadlineAt
        );
        unfilteredCount = probe.hits?.hits?.length ?? 0;

        if (unfilteredCount > 0) {
          filterDiagnostics = {
            filterField: filterApplied.join(', '),
            message:
              `フィルタ付きの検索が 0 件、フィルタ無しの同一クエリが ${unfilteredCount} 件を返しました。` +
              `フィルタ対象フィールド（${filterApplied.join(', ')}）のマッピング不一致の可能性があります。`,
          };
        }
      }

      if (unfilteredCount === 0) {
        documentCount = await withDeadline(countDocuments(deadlineAt), deadlineAt);
      }
    }

    // ─── 8. 応答の組み立て ─────────────────────────────────────────────
    const returnedCount = hits.length;

    // 登録ドキュメント数 0 はエラーではなく状態として返す（要件 16.4）
    const noDocuments = documentCount === 0;

    // フィルタ条件下で近傍候補が不足していることを示す注記（要件 9.11）
    const insufficientNeighborsNote =
      returnedCount < topK.appliedTopK && !noDocuments
        ? `返却件数 ${returnedCount} 件が k = ${topK.appliedTopK} を下回りました。` +
          (filterApplied.length > 0
            ? `フィルタ条件（${filterApplied.join(', ')}）下で近傍候補が不足しています。`
            : 'フィルタなしの条件で近傍候補が不足しています。')
        : undefined;

    const response: OpenSearchVectorSearchResponse = {
      backend: 'opensearch',
      hits,
      language: resolved.language,
      requestedTopK: topK.requestedTopK,
      appliedTopK: topK.appliedTopK,
      returnedCount,
      distinctSkuCount: new Set(hits.map((hit) => hit.itemId)).size,
      took: searchBody.took ?? 0,
      searchLatencyMs,
      // ハンドラ開始から応答生成完了まで（要件 9.8 の別区間）
      handlerLatencyMs: Date.now() - handlerStart,
      coldStart,
      indexName: INDEX_NAME,
      vectorField,
      spaceType: 'cosinesimil',
      distanceSemantics: 'lower_is_closer',
      scoreNormalization: formula,
      filterApplied,
      constraints: CAPABILITIES,
      ...(noDocuments ? { status: 'NO_DOCUMENTS' as const } : {}),
      ...(documentCount !== undefined ? { documentCount } : {}),
      ...(filterDiagnostics !== undefined ? { filterDiagnostics } : {}),
      ...(insufficientNeighborsNote !== undefined ? { insufficientNeighborsNote } : {}),
    };

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(response),
    };
  } catch (error: unknown) {
    const elapsedMs = Date.now() - handlerStart;
    // 内部の詳細は CloudWatch Logs にのみ残す（要件 16.9）
    console.error('vector-search-aoss error:', error);

    if (isDeadlineExceeded(error)) {
      // 打ち切り時は部分結果を返さない（要件 9.9）
      return errorResult(
        toClientError('OPENSEARCH_TIMEOUT', STAGE, {
          detail:
            `打ち切りまでの経過時間: ${elapsedMs}ms（上限 ${SEARCH_DEADLINE_MS}ms）。` +
            'Vector_Collection の Cold Start の可能性があります。',
        })
      );
    }

    return errorResult(classifyError(error, STAGE));
  }
};

// ---------------------------------------------------------------------------
// OpenSearch 呼び出し
// ---------------------------------------------------------------------------

/** knn クエリの `filter` 句に入れる 1 条件 */
interface FilterClause {
  field: string;
  clause: Record<string, unknown>;
}

/**
 * k-NN 検索を 1 回実行する（要件 9.1 / 9.4）。
 *
 * - 検索対象は `vectorField` の 1 フィールドのみ
 * - `_source` から両言語のベクトルを除外する
 * - 倉庫フィルタは knn クエリの `filter` 句内に置き、後段フィルタ（`post_filter`）を使わない
 */
async function searchKnn(
  vector: number[],
  k: number,
  vectorField: string,
  filterClauses: FilterClause[],
  deadlineAt: number
): Promise<OpenSearchSearchBody> {
  const knnField: Record<string, unknown> = { vector, k };
  if (filterClauses.length > 0) {
    knnField.filter = { bool: { filter: filterClauses.map((entry) => entry.clause) } };
  }

  const response = await client.search(
    {
      index: INDEX_NAME,
      body: {
        size: k,
        _source: { excludes: [...EXCLUDED_SOURCE_FIELDS] },
        query: { knn: { [vectorField]: knnField } },
      },
    },
    { requestTimeout: remainingBudgetMs(deadlineAt) }
  );

  return (response.body ?? {}) as OpenSearchSearchBody;
}

/** インデックスの登録ドキュメント数を取得する（要件 16.4） */
async function countDocuments(deadlineAt: number): Promise<number> {
  const response = await client.count(
    { index: INDEX_NAME },
    { requestTimeout: remainingBudgetMs(deadlineAt) }
  );
  const count = (response.body as { count?: unknown } | undefined)?.count;
  return typeof count === 'number' && Number.isFinite(count) ? count : 0;
}

// ---------------------------------------------------------------------------
// フィルタ構築
// ---------------------------------------------------------------------------

/** 範囲フィルタの指定。実測プローブ専用（既定の検索では使わない） */
interface ResolvedRangeFilter {
  field: string;
  min?: number;
  max?: number;
}

/** 範囲フィルタ指定を解釈する。不完全な指定は無視して未指定として扱う */
function resolveRangeFilter(input: VectorSearchRequestBody['rangeFilter']): ResolvedRangeFilter | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  if (!supportsFilterKind(CAPABILITIES, 'range')) return undefined;

  const field = typeof input.field === 'string' ? input.field.trim() : '';
  const min = typeof input.min === 'number' && Number.isFinite(input.min) ? input.min : undefined;
  const max = typeof input.max === 'number' && Number.isFinite(input.max) ? input.max : undefined;

  if (field.length === 0 || (min === undefined && max === undefined)) return undefined;
  return { field, min, max };
}

/**
 * knn クエリの `filter` 句に入れる条件を組み立てる（要件 9.4）。
 *
 * 倉庫フィルタは `term: { warehouseId: ... }`。マッピングで keyword 型として
 * 定義しているため `.keyword` サブフィールドは付けない。
 */
function buildFilterClauses(
  warehouseId: string | undefined,
  rangeFilter: ResolvedRangeFilter | undefined
): FilterClause[] {
  const clauses: FilterClause[] = [];

  if (warehouseId !== undefined) {
    clauses.push({
      field: WAREHOUSE_FILTER_FIELD,
      clause: { term: { [WAREHOUSE_FILTER_FIELD]: warehouseId } },
    });
  }

  if (rangeFilter !== undefined) {
    const bounds: Record<string, number> = {};
    if (rangeFilter.min !== undefined) bounds.gte = rangeFilter.min;
    if (rangeFilter.max !== undefined) bounds.lte = rangeFilter.max;
    clauses.push({
      field: rangeFilter.field,
      clause: { range: { [rangeFilter.field]: bounds } },
    });
  }

  return clauses;
}

// ---------------------------------------------------------------------------
// 結果の変換
// ---------------------------------------------------------------------------

/**
 * `_search` のヒット 1 件を応答形へ変換する（要件 9.5 / 9.12）。
 *
 * 生スコアと正規化距離の両方を載せ、正規化距離が 0〜2 を外れた場合は
 * `distanceBasisMismatch: true` を付けたうえで**生スコアを保持する**。
 */
function toSearchHit(
  hit: OpenSearchHit,
  rank: number,
  metadataSuffix: 'Ja' | 'En',
  formula: ScoreNormalizationFormula
): VectorSearchHit {
  const source = hit._source ?? {};
  const rawScore = typeof hit._score === 'number' ? hit._score : 0;
  const distance = normalizeOpenSearchScore(rawScore, formula);

  const searchHit: VectorSearchHit = {
    itemId: readString(source, 'itemId'),
    warehouseId: readString(source, WAREHOUSE_FILTER_FIELD),
    productName: readString(source, `productName${metadataSuffix}`),
    category: readString(source, `category${metadataSuffix}`),
    origin: readString(source, `origin${metadataSuffix}`),
    roastLevel: readString(source, `roastLevel${metadataSuffix}`),
    flavorNotes: readString(source, `flavorNotes${metadataSuffix}`),
    quantity: readNumber(source, 'quantity'),
    location: readString(source, 'location'),
    unitPrice: readNumber(source, 'unitPrice'),
    rank,
    distance,
    rawScore,
  };

  if (isDistanceBasisMismatch(distance)) {
    searchHit.distanceBasisMismatch = true;
  }

  return searchHit;
}

/**
 * ベクトルフィールド名から表示用メタデータの言語接尾辞を導出する。
 *
 * `resolveVectorField()` の戻り値からのみ導出することで、言語判定の分岐を
 * 本ハンドラ内に 2 つ持たない（Property 18 の排他性）。
 */
function metadataSuffixOf(vectorField: 'embeddingJa' | 'embeddingEn'): 'Ja' | 'En' {
  return vectorField === 'embeddingJa' ? 'Ja' : 'En';
}

/** `_source` から文字列を安全に取り出す。欠損は空文字にする */
function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

/** `_source` から数値を安全に取り出す。欠損・非数値は 0 にする */
function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// ---------------------------------------------------------------------------
// Query_Vector_Cache
// ---------------------------------------------------------------------------

/**
 * `queryId` からクエリベクトルと言語を解決する（要件 9.3 / 16.6）。
 *
 * DynamoDB_Vector_Lambda と同じ 1 件のアイテムを読むため、両バックエンドは
 * 全要素が一致するベクトルと同一の言語で検索する。
 *
 * 失効・不在・内容不正はいずれも `undefined` を返し、呼び出し側が
 * `QUERY_EXPIRED`（再試行可、埋め込み生成からやり直し）を返す。
 */
async function resolveQuery(queryId: string): Promise<ResolvedQuery | undefined> {
  // 埋め込み生成の直後に検索が走るため、結果整合の読み取りでは書き込み直後の
  // ハンドルを取り逃して QUERY_EXPIRED になり得る。強整合読み取りで回避する
  const result = await dynamoClient.send(
    new GetItemCommand({
      TableName: QUERY_CACHE_TABLE_NAME,
      Key: { queryId: { S: queryId } },
      ConsistentRead: true,
    })
  );

  if (!result.Item) return undefined;

  const item = unmarshall(result.Item);

  // TTL 削除は遅延するため、失効時刻を過ぎたアイテムは失効として扱う
  const expiresAt = item.expiresAt;
  if (typeof expiresAt === 'number' && expiresAt * 1000 <= Date.now()) return undefined;

  const language = item.language;
  if (!isVectorLanguage(language)) return undefined;

  const vector = toNumberVector(item.vector ?? item.embedding);
  if (vector === undefined) return undefined;

  return { vector, language };
}

/**
 * キャッシュのベクトル属性を `number[]` へ変換する。
 * DynamoDB の数値は `unmarshall` で `Number` になるが、桁数の大きい値は
 * `BigInt` になり得るため数値化してから検証する。
 */
function toNumberVector(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;

  const vector: number[] = [];
  for (const element of value) {
    const numeric = typeof element === 'bigint' ? Number(element) : element;
    if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return undefined;
    vector.push(numeric);
  }
  return vector;
}

// ---------------------------------------------------------------------------
// 打ち切り制御（要件 9.9）
// ---------------------------------------------------------------------------

/** 打ち切りを表す内部エラー。応答生成前に `isDeadlineExceeded()` で判別する */
class SearchDeadlineExceededError extends Error {
  constructor(deadlineMs: number) {
    super(`OpenSearch request exceeded the ${deadlineMs}ms deadline`);
    this.name = 'SearchDeadlineExceededError';
  }
}

/** 残り時間を返す。既に超過している場合も 1ms を下回らせない */
function remainingBudgetMs(deadlineAt: number): number {
  return Math.max(1, deadlineAt - Date.now());
}

/**
 * 期限までに完了しなければ打ち切る。
 *
 * クライアント側の `requestTimeout` と二重にすることで、トランスポートが
 * タイムアウトを返さない場合でもハンドラが 30,000 ms を超えて待たない。
 * 打ち切り時は解決済みの値を使わないため、部分結果は返らない。
 */
async function withDeadline<T>(promise: Promise<T>, deadlineAt: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new SearchDeadlineExceededError(SEARCH_DEADLINE_MS)),
          remainingBudgetMs(deadlineAt)
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 打ち切り由来の例外か判定する。クライアント側のタイムアウトも含める */
function isDeadlineExceeded(error: unknown): boolean {
  if (error instanceof SearchDeadlineExceededError) return true;

  const name = error instanceof Error ? error.name : '';
  return name === 'TimeoutError' || name === 'RequestAbortedError' || name === 'ConnectionError';
}

// ---------------------------------------------------------------------------
// 応答ヘルパー
// ---------------------------------------------------------------------------

/** リクエストボディを JSON として解釈する。解釈できない場合は undefined */
function parseBody(raw: string | null): VectorSearchRequestBody | undefined {
  if (raw === null || raw.trim().length === 0) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as VectorSearchRequestBody;
  } catch {
    return undefined;
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
