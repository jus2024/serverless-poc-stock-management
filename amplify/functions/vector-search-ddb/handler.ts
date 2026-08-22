/**
 * DynamoDB_Vector_Lambda（`kiro-vector-search-ddb`）
 *
 * `POST /vector-search/dynamodb`。`queryId` で受け取ったクエリベクトルを使って
 * Vector_Table の**言語に対応する 1 本**のベクトルインデックスに対し `SearchVectors` を
 * 1 回だけ実行し、距離昇順の結果と 2 区間のレイテンシを返す。
 *
 * 処理順（設計「DynamoDB_Vector_Lambda」の 11 ステップ）:
 *  1. `queryId` からベクトルと言語を解決する。不在なら `QUERY_EXPIRED`（要件 16.6）
 *  2. `resolveIndexName(language)` で対象インデックスを 1 本に決める（要件 8.2）
 *  3. TopK を `normalizeTopK` で正規化する（要件 8.3 / 8.4 / 8.5）
 *  4. 次元数を照合する。不一致なら `DIMENSION_MISMATCH`（要件 16.1）
 *  5. インデックス準備状態を確認する。`INDEX_NOT_FOUND` / `INDEX_BUILDING`（要件 5.15 / 16.2 / 16.3）
 *  6. フィルタを組み立てる。範囲条件要求は `RANGE_FILTER_UNSUPPORTED`（要件 8.6 / 8.7）
 *  7. `SearchVectors` を 1 回呼ぶ（要件 8.1 / 8.8 / 8.11）
 *  8. 距離昇順で返す（要件 8.9）
 *  9. TopK 未満・0 件でもエラーにしない（要件 8.10）
 * 10. 2 区間のレイテンシを別々に計測する（要件 8.12）
 * 11. コールドスタート判定はモジュールスコープのフラグで行う（要件 8.13）
 *
 * 設計上の要点:
 * - **言語ルーティングは `language.ts` の 1 経路のみ。** インデックス名を本ファイルで組み立てず、
 *   `resolveIndexName()` の戻り値だけを使う。したがって他方の言語のインデックス名・ベクトル属性名が
 *   呼び出し引数に現れる経路が存在しない（要件 8.2、Property 18）
 * - **ベクトルは応答へ出さない。** `ProjectionExpression` に `embeddingJa` / `embeddingEn` を
 *   どちらも含めず、応答型にもベクトルを持つ項目がない（要件 8.8）
 * - **エラー応答は `errors.ts` を通した値のみ。** `toClientError()` / `classifyError()` /
 *   `dimensionMismatchError()` / `queryExpiredError()` が唯一の応答生成経路であり、
 *   ARN・アカウント ID・資格情報・スタックトレースを含まない（要件 16.7 / 16.9）
 * - **`DescribeTable` は実行環境内で 60 秒キャッシュする。** 毎検索に `DescribeTable` の往復を
 *   足すと `handlerLatencyMs` が実態より膨らむため。ヒット / ミスは `indexReadiness` に載せる
 * - **`SearchVectors` 呼び出しは `searchLatencyMs` の区間に他の I/O を含めない。**
 *   `queryId` 解決と `DescribeTable` は区間外であり、`handlerLatencyMs` との差として観測できる
 *
 * SDK について:
 *   `SearchVectors` は **専用のベクトル検索エンドポイント**を使う（通常の DynamoDB
 *   エンドポイントとは別。SDK / CLI は自動で振り分ける）。本実装はエンドポイントを自分で
 *   選ぶため `SearchVectorsCommand` を使わず、AWS JSON 1.0 の署名付き HTTP 要求を
 *   デュアルスタックエンドポイント `search-dynamodb.<region>.api.aws` へ送る。
 *   もう 1 つの候補である `<account-id>.search-ddb.<region>.amazonaws.com` は AWS アカウント ID を
 *   実行環境へ持ち込む必要があるため採らない（要件 16.9 の趣旨に沿う）。
 *   **入出力の型は `@aws-sdk/client-dynamodb` のモデル（`SearchVectorsInput` /
 *   `SearchVectorsOutput` / `SearchResultItem` / `VectorCapacity` /
 *   `VectorIndexDescription`）をそのまま使う。** 呼び出し経路が生 HTTP でも、
 *   組み立てた本文と読み取る応答の形はコンパイラが実 API のモデルと突き合わせる。
 *   API の形をローカルに再定義してはならない（乖離が検出されなくなる）。
 *
 * 環境変数（タスク 8.7 の配線対象）:
 * - `VECTOR_TABLE_NAME`（必須）: Vector_Table のテーブル名。`kiro-roasters-inventory-vector`
 * - `QUERY_CACHE_TABLE_NAME`（必須）: Query_Vector_Cache のテーブル名。`kiro-vector-query-cache`。
 *   `vector-query-embed` と**同一の値**を渡す
 * - `VECTOR_EMBEDDING_DIMENSIONS`（任意）: 次元数。既定 1024。`vector-query-embed` および
 *   Vector Index Construct と**同一の値**を渡す（3 者で食い違うと `DIMENSION_MISMATCH` になる）
 * - `DYNAMODB_SEARCH_ENDPOINT`（任意）: ベクトル検索エンドポイントの上書き。未設定時は
 *   `https://search-dynamodb.<AWS_REGION>.api.aws`
 *
 * IAM（タスク 8.7 の配線対象）:
 * - `dynamodb:SearchVectors` を **2 本のベクトルインデックス ARN のみ**に付与する（要件 17.4、V7）
 * - `dynamodb:DescribeTable` を Vector_Table のテーブル ARN に付与する（準備状態の確認に使う）
 * - `dynamodb:GetItem` を Query_Vector_Cache のテーブル ARN に付与する
 * - `Query` / `Scan` / PartiQL は付与しない（要件 5.16）
 *
 * 要件: 5.15, 5.16, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 8.10, 8.11, 8.12, 8.13,
 *       16.1, 16.2, 16.3, 16.6, 16.7, 16.9
 * 設計: DynamoDB_Vector_Lambda / `POST /vector-search/dynamodb` / スコア正規化（DynamoDB 側）
 */

import { Sha256 } from '@aws-crypto/sha256-js';
import {
  DescribeTableCommand,
  DynamoDBClient,
  GetItemCommand,
  type AttributeValue,
  type SearchResultItem,
  type SearchVectorsInput,
  type SearchVectorsOutput,
  type TableDescription,
  type VectorCapacity,
  type VectorIndexDescription,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
  getVectorCapabilities,
  supportsFilterKind,
  validateDimensions,
  type VectorBackendCapabilities,
} from '../shared/vector/constraints';
import {
  classifyError,
  dimensionMismatchError,
  httpStatusForErrorCode,
  queryExpiredError,
  toClientError,
  type VectorErrorResponse,
} from '../shared/vector/errors';
import {
  VECTOR_LANGUAGES,
  isVectorLanguage,
  resolveIndexName,
  type VectorLanguage,
} from '../shared/vector/language';
import type { SkuMetadataFields } from '../shared/vector/sku-metadata';
import { normalizeTopK } from '../shared/vector/topk';

// ============================================================
// 定数と環境変数
// ============================================================

/** 失敗した処理段階。本 Lambda は常に DynamoDB 検索段階である（要件 16.5） */
const STAGE = 'SEARCH_DYNAMODB' as const;

/** Vector_Table のテーブル名を渡す環境変数名 */
export const VECTOR_TABLE_NAME_ENV = 'VECTOR_TABLE_NAME';

/** Query_Vector_Cache のテーブル名を渡す環境変数名（`vector-query-embed` と同一の名前） */
export const QUERY_CACHE_TABLE_NAME_ENV = 'QUERY_CACHE_TABLE_NAME';

/**
 * 次元数を渡す環境変数名。
 *
 * `shared/vector/embedding-generator.ts` の `EMBEDDING_DIMENSIONS_ENV` と同一の名前・同一の既定値を
 * 意図的に再掲している。当該モジュールは `@aws-sdk/client-bedrock-runtime` を取り込むため、
 * 検索 Lambda のバンドルとコールドスタートを重くしないために import しない。
 * タスク 8.7 は 3 者（埋め込み Lambda / 検索 Lambda / Vector Index Construct）へ同一の値を配線する。
 */
export const EMBEDDING_DIMENSIONS_ENV = 'VECTOR_EMBEDDING_DIMENSIONS';

/** 次元数の既定値（要件 3.3 / 5.2）。`DEFAULT_EMBEDDING_DIMENSIONS` と同一値 */
export const DEFAULT_EMBEDDING_DIMENSIONS = 1024;

/** ベクトル検索エンドポイントを上書きする環境変数名 */
export const SEARCH_ENDPOINT_ENV = 'DYNAMODB_SEARCH_ENDPOINT';

/** `DescribeTable` の結果を実行環境内で保持する時間（設計ステップ 5） */
export const DESCRIBE_TABLE_CACHE_TTL_MS = 60_000;

/** `INDEX_BUILDING` の再試行推奨待機秒数。1〜300 秒の範囲内（要件 16.3） */
export const INDEX_BUILDING_RETRY_AFTER_SECONDS = 30;

/** 距離関数。インデックス作成時に COSINE で固定される（要件 5.1、`VECTOR_INDEX_DISTANCE_FUNCTION` と同値） */
const DISTANCE_FUNCTION = 'COSINE' as const;

/** 距離の向き。COSINE 距離は 0〜2 で、値が小さいほど類似（要件 8.9） */
const DISTANCE_SEMANTICS = 'lower_is_closer' as const;

/** `Score` が欠落した結果に割り当てる距離。COSINE 距離の最大値であり末尾へ並ぶ */
const MAX_COSINE_DISTANCE = 2;

/** AWS JSON 1.0 プロトコルのターゲットヘッダー値 */
const SEARCH_VECTORS_TARGET = 'DynamoDB_20120810.SearchVectors';

/** 倉庫フィルタに使う属性。`SearchSchema` の `INLINE_FILTER` 要素（要件 5.3 / 8.6） */
const WAREHOUSE_FILTER_ATTRIBUTE = 'warehouseId';

/** 倉庫 ID として受理する最大文字数。値は式へ直接埋め込まないが、応答へ載せるため長さを抑える */
const MAX_WAREHOUSE_ID_LENGTH = 128;

/**
 * `ProjectionExpression` で取得する属性（要件 8.8）。
 *
 * キー 2 属性 + `amplify/custom/vector-index.ts` の `VECTOR_INDEX_PROJECTED_ATTRIBUTES` 6 属性。
 * **`embeddingJa` / `embeddingEn` をどちらも含めない。** ベクトルは射影対象でもないため
 * 指定しても取得できないが、ここに現れないことを一覧として明示しておく。
 *
 * 当該 Construct は `aws-cdk-lib` を取り込むため Lambda から import せず、値を再掲している。
 * 両者の一致はタスク 8.8 のテスト（Node 実行のためどちらも import できる）で担保する。
 */
export const PROJECTED_ATTRIBUTES = [
  'itemId',
  'warehouseId',
  'itemName',
  'metaJa',
  'metaEn',
  'quantity',
  'location',
  'unitPrice',
] as const;

/** CORS ヘッダー共通定義（既存ハンドラと同一の方式・同一のヘッダー構成） */
const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ============================================================
// 応答型（`src/lib/inventory/vector-types.ts` の `DynamoDBVectorSearchResponse` と同一形）
// ============================================================

/**
 * 検索結果 1 件。**両言語のベクトル属性に相当する項目を持たない**（要件 8.8）。
 * 表示用メタデータは検索言語に対応する 1 言語分のみを載せる。
 */
export interface VectorSearchHitBody {
  itemId: string;
  warehouseId: string;
  /** 検索言語に対応する `productName` */
  productName: string;
  category: string;
  origin: string;
  roastLevel: string;
  flavorNotes: string;
  quantity: number;
  location: string;
  unitPrice: number;
  /** 1 起点の連番（距離昇順） */
  rank: number;
  /** COSINE 距離。0〜2、小さいほど類似（要件 8.9） */
  distance: number;
  /** バックエンドが返した生スコア。DynamoDB では距離そのもの（設計「スコア正規化」） */
  rawScore: number;
}

/**
 * `SearchVectors` が返した消費量（要件 8.11）。
 *
 * 通常の読み取り API の `CapacityUnits` / `ReadCapacityUnits` は**存在しない**。
 * 要件 14.7 が測定対象とする CloudWatch メトリクスは `VectorSearchRequestBytes` である。
 *
 * **実 API の応答で観測した形（task 13.13 / Q5、2026-08-21、us-west-2）:**
 *
 * ```json
 * "ConsumedCapacity": { "VectorSearchRequestBytes": 61318, "VectorSearchUnits": 61318 }
 * ```
 *
 * `VectorSearchUnits` は **SDK の `VectorCapacity` モデルに存在しない**が実 API は返す。
 * 要件 8.11 は「`SearchVectors` が返した消費キャパシティ値」を応答へ載せることを求めるため、
 * モデルに無い当該項目も生応答から読んで載せる。TopK 1 の 1 回の観測では
 * `VectorSearchRequestBytes` と同値だったが、両者が常に一致するとは仮定せず別項目として保持する
 * （一致するなら 13.18 の 100 回測定で示せる）。
 *
 * 単位はキャパシティユニットではなく**バイト**であるため、項目名もそれに合わせる。
 * `VectorSearchUnits` の単位は不明であり、API の項目名をそのまま写す。
 */
export interface VectorConsumedCapacityBody {
  /** ベクトル検索で消費した要求バイト数 */
  vectorSearchRequestBytes?: number;
  /** ベクトルインデックスへの書き込みで消費した要求バイト数。検索応答では通常現れない */
  vectorWriteRequestBytes?: number;
  /** 実 API が返す `VectorSearchUnits`。SDK のモデルには無い（task 13.13 で観測） */
  vectorSearchUnits?: number;
}

/** Vector_Index の準備状況（要件 5.15 / 16.2 / 16.3 の判定材料） */
export interface VectorIndexReadinessBody {
  indexStatus: string;
  /** `Backfilling` フィールドが不在の場合は false として扱う（要件 5.15 / 5.17、V20） */
  backfilling: boolean;
  /**
   * `Backfilling` フィールドが `DescribeTable` の応答に存在したか（要件 5.17、V20）。
   *
   * task 13.12 の実測ではキー自体が返らず、**常に false** である。`backfilling` の false は
   * 「バックフィル中でない」と「値が観測できていない」の 2 通りを含むため、
   * どちらであったかを本項目で区別できるようにする。
   */
  backfillingPresent: boolean;
  /** `DescribeTable` をキャッシュから読んだか（設計ステップ 5） */
  describeTableCached: boolean;
}

/** `POST /vector-search/dynamodb` の成功応答 */
export interface DynamoDBVectorSearchResponseBody {
  backend: 'dynamodb';
  hits: VectorSearchHitBody[];
  /** 使用した検索言語。`queryId` から解決した値のエコー（要件 11.15） */
  language: VectorLanguage;
  requestedTopK: number;
  appliedTopK: number;
  returnedCount: number;
  /** 返却行の itemId 一意件数（要件 12.2） */
  distinctSkuCount: number;
  /** `SearchVectors` 呼び出し直前〜レスポンス受信完了（要件 8.12） */
  searchLatencyMs: number;
  /** ハンドラ開始〜レスポンス生成完了（要件 8.12） */
  handlerLatencyMs: number;
  coldStart: boolean;
  /** 言語に対応して選択されたインデックス名 */
  indexName: string;
  distanceFunction: 'COSINE';
  distanceSemantics: 'lower_is_closer';
  filterApplied: string[];
  consumedCapacity: VectorConsumedCapacityBody | null;
  indexReadiness: VectorIndexReadinessBody;
  constraints: VectorBackendCapabilities;
}

// ============================================================
// 実行環境で再利用する資源
// ============================================================

/**
 * コールドスタート判定（要件 8.13）。
 * モジュールスコープで保持し、最初の呼び出しのみ true を返す。
 */
let coldStart = true;

/** 次元数はコンテナ生存中に変わらない。読み込み時に 1 度だけ確定する */
const INDEX_DIMENSIONS = resolveIndexDimensions();

/** `GetItem`（Query_Vector_Cache）と `DescribeTable`（Vector_Table）に使う */
const dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION });

/** 署名器。`DynamoDBClient` の資格情報チェーンを共有し、解決結果のキャッシュも共有する */
let searchSigner: SignatureV4 | undefined;

function getSearchSigner(): SignatureV4 {
  searchSigner ??= new SignatureV4({
    service: 'dynamodb',
    region: process.env.AWS_REGION ?? '',
    credentials: dynamodb.config.credentials,
    sha256: Sha256,
  });
  return searchSigner;
}

/**
 * 次元数を解決する。
 * 設定ミスで Lambda の読み込みを止めないため例外を投げず、範囲外・整数以外は既定値へ落とす。
 * 許容範囲の判定は `constraints.ts` の `validateDimensions()` に委ねる（DynamoDB は 1〜4,096）。
 */
export function resolveIndexDimensions(env: Record<string, string | undefined> = process.env): number {
  const raw = env[EMBEDDING_DIMENSIONS_ENV];
  const parsed = typeof raw === 'string' && raw.trim().length > 0 ? Number(raw.trim()) : Number.NaN;
  const validated = validateDimensions(parsed, 'dynamodb');
  return validated.ok ? validated.dimensions : DEFAULT_EMBEDDING_DIMENSIONS;
}

/** ベクトル検索エンドポイント（デュアルスタック）。通常の DynamoDB エンドポイントとは別 */
export function resolveSearchEndpoint(env: Record<string, string | undefined> = process.env): string {
  const override = env[SEARCH_ENDPOINT_ENV];
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  return `https://search-dynamodb.${env.AWS_REGION ?? ''}.api.aws`;
}

// ============================================================
// 小さな読み取りヘルパー（いずれも例外を投げない）
// ============================================================

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 有限数のみを通す。欠落と非有限値をまとめて `undefined` にする */
function readFiniteNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** メタデータ 1 項目を読む。キーを `SkuMetadataFields` に固定して綴り違いをコンパイル時に弾く */
function readMetaField(
  meta: Record<string, unknown> | undefined,
  key: keyof SkuMetadataFields
): string {
  return readString(meta?.[key]);
}

// ============================================================
// リクエストの解釈（全域関数）
// ============================================================

/** リクエスト本文から取り出した生の値。検証前なので型を絞らない */
interface RawSearchRequest {
  queryId: unknown;
  topK: unknown;
  warehouseId: unknown;
  rangeFilter: unknown;
}

/**
 * API Gateway プロキシ統合の本文を解釈する。
 * Base64 エンコードされた本文にも対応する。JSON として解釈できない場合は空の要求として扱い、
 * 後続の検証で `QUERY_EXPIRED`（ハンドルを読み取れない）になる。
 */
export function parseSearchRequest(
  event: Pick<APIGatewayProxyEvent, 'body' | 'isBase64Encoded'>
): RawSearchRequest {
  const empty: RawSearchRequest = {
    queryId: undefined,
    topK: undefined,
    warehouseId: undefined,
    rangeFilter: undefined,
  };

  if (typeof event.body !== 'string' || event.body.length === 0) return empty;

  let text = event.body;
  if (event.isBase64Encoded === true) {
    try {
      text = Buffer.from(event.body, 'base64').toString('utf8');
    } catch {
      return empty;
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return empty;
  }

  const record = asRecord(parsed);
  if (!record) return empty;

  return {
    queryId: record.queryId,
    topK: record.topK,
    warehouseId: record.warehouseId,
    rangeFilter: record.rangeFilter,
  };
}

/**
 * TopK を数値へ寄せる。
 * `normalizeTopK()` は数値型のみを受理する純関数であり、文字列から数値への変換は
 * API 境界（本ファイル）の責務である。数値以外の文字列は `NaN` になり検証エラーへ落ちる。
 */
function coerceTopK(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? Number.NaN : Number(trimmed);
}

/** 倉庫指定を解釈する。非文字列・空文字・長すぎる値はフィルタなしとして扱う */
function resolveWarehouseId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_WAREHOUSE_ID_LENGTH) return undefined;
  return trimmed;
}

/**
 * 範囲条件を含むフィルタが要求されたか判定する（要件 8.7）。
 * 空のオブジェクトは要求と見なさない。`field` / `min` / `max` のいずれかが与えられた場合のみ真。
 */
export function requestsRangeFilter(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  return typeof record.field === 'string' || record.min !== undefined || record.max !== undefined;
}

// ============================================================
// 応答の組み立て
// ============================================================

function successResponse(body: DynamoDBVectorSearchResponseBody): APIGatewayProxyResult {
  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

/**
 * エラー応答。**`errors.ts` が組み立てた値をそのまま直列化する唯一の経路**。
 * 項目の追加を行わないため、応答に内部情報が混入しない（要件 16.9）。
 */
function errorResponse(error: VectorErrorResponse): APIGatewayProxyResult {
  return {
    statusCode: httpStatusForErrorCode(error.errorCode),
    headers: CORS_HEADERS,
    body: JSON.stringify(error),
  };
}

// ============================================================
// ステップ 1: `queryId` の解決
// ============================================================

/** Query_Vector_Cache から解決したクエリ。ベクトルと言語は必ず組で得られる */
interface ResolvedQuery {
  vector: number[];
  language: VectorLanguage;
}

/** `queryId` の解決結果。失敗時は返すべきエラー応答を保持する */
type ResolveQueryResult = { ok: true; query: ResolvedQuery } | { ok: false; error: VectorErrorResponse };

/**
 * `queryId` からベクトルと言語を取得する（要件 16.6）。
 *
 * TTL 300 秒の項目を書き込み直後に読むため **強い整合性のある読み取り**を使う。
 * 結果整合性の読み取りでは、埋め込み生成の直後に届いた検索要求が項目を見つけられず、
 * 失効していないハンドルを `QUERY_EXPIRED` として扱う可能性がある。
 */
async function resolveQuery(tableName: string, queryId: string): Promise<ResolveQueryResult> {
  const response = await dynamodb.send(
    new GetItemCommand({
      TableName: tableName,
      Key: marshall({ queryId }),
      ConsistentRead: true,
    })
  );

  if (!response.Item) {
    // TTL 失効、または未発行のハンドル。再試行可であり埋め込み生成からのやり直しを求める
    return { ok: false, error: queryExpiredError(STAGE) };
  }

  const item = unmarshall(response.Item);

  // 言語はキャッシュ項目にのみ存在する。リクエストからは受け取らないため、
  // 2 つの検索が別の言語で走る経路が構造的に存在しない（要件 10.4）
  if (!isVectorLanguage(item.language)) {
    return {
      ok: false,
      error: toClientError('INVALID_LANGUAGE', STAGE, {
        detail: `キャッシュ項目の言語を解釈できません。許容値: ${VECTOR_LANGUAGES.join(' / ')}。`,
      }),
    };
  }

  const rawVector: unknown = item.vector;
  if (
    !Array.isArray(rawVector) ||
    rawVector.length === 0 ||
    !rawVector.every((element) => typeof element === 'number' && Number.isFinite(element))
  ) {
    return {
      ok: false,
      error: toClientError('QUERY_EXPIRED', STAGE, {
        detail: 'クエリベクトルを読み取れませんでした。埋め込み生成からやり直してください。',
      }),
    };
  }

  return { ok: true, query: { vector: rawVector as number[], language: item.language } };
}

// ============================================================
// ステップ 5: インデックス準備状態の確認
// ============================================================

/** `DescribeTable` の結果を実行環境内で保持する。TTL は 60 秒（設計ステップ 5） */
interface DescribeTableCacheEntry {
  tableName: string;
  indexes: VectorIndexDescription[];
  fetchedAtMs: number;
}

let describeTableCache: DescribeTableCacheEntry | undefined;

/** テストと運用スクリプトからキャッシュを初期化できるようにする */
export function resetDescribeTableCache(): void {
  describeTableCache = undefined;
}

/**
 * `DescribeTable` の応答からベクトルインデックスの記述を取り出す（V5 / V6）。
 *
 * SDK のモデルでは `TableDescription.VectorIndexes` が
 * `VectorIndexDescription[]` である。Index_Provisioner（`on-event.ts`）と同一の読み取り方。
 */
export function readVectorIndexDescriptions(
  table: TableDescription | undefined
): VectorIndexDescription[] {
  return table?.VectorIndexes ?? [];
}

/** インデックス参照の結果。キャッシュヒットの有無を応答へ載せる */
interface VectorIndexLookup {
  index?: VectorIndexDescription;
  cached: boolean;
}

async function lookupVectorIndex(
  tableName: string,
  indexName: string,
  nowMs: number
): Promise<VectorIndexLookup> {
  const cache = describeTableCache;
  if (
    cache !== undefined &&
    cache.tableName === tableName &&
    nowMs - cache.fetchedAtMs < DESCRIBE_TABLE_CACHE_TTL_MS
  ) {
    return {
      index: cache.indexes.find((description) => description.IndexName === indexName),
      cached: true,
    };
  }

  const response = await dynamodb.send(new DescribeTableCommand({ TableName: tableName }));
  const indexes = readVectorIndexDescriptions(response.Table);
  describeTableCache = { tableName, indexes, fetchedAtMs: nowMs };

  return {
    index: indexes.find((description) => description.IndexName === indexName),
    cached: false,
  };
}

/**
 * インデックスが検索可能かを判定する（要件 5.15 / 16.3、V5）。
 *
 * `BACKFILLING` というステータス値は存在せず、バックフィル進捗は `IndexStatus` とは
 * 別フィールドの `Backfilling` で表現される。したがって判定は
 * **`IndexStatus === 'ACTIVE'` かつ `Backfilling !== true` の組**で行う。
 */
export function isVectorIndexSearchable(index: VectorIndexDescription): boolean {
  return index.IndexStatus === 'ACTIVE' && index.Backfilling !== true;
}

/**
 * `Backfilling` フィールドが応答に存在したか（要件 5.17、V20）。
 *
 * task 13.12 の実測ではキー自体が返らなかった（13.7 のデプロイ直後でも 13.12 の時点でも不在）。
 * {@link isVectorIndexSearchable} の判定は「不在 = 偽」として意図どおり成立するが、
 * `backfilling: false` だけを応答へ載せると「バックフィル中でない」と
 * 「値が観測できていない」が区別できない。判定は変えず、観測できたかどうかを別に載せる。
 */
export function isBackfillingPresent(index: VectorIndexDescription): boolean {
  return typeof index.Backfilling === 'boolean';
}

/** 応答に載せる `Backfilling` の値。フィールドが不在の場合は偽と書かず不在を示す（要件 5.15 / 5.17） */
export const BACKFILLING_ABSENT_LABEL = '不在（DescribeTable の応答にフィールドが存在しない）';

// ============================================================
// ステップ 7: `SearchVectors` の呼び出し
// ============================================================

/**
 * 実 API が返す `ConsumedCapacity`。
 *
 * SDK の `VectorCapacity` に、**モデルに無いが実 API が返す** `VectorSearchUnits` を足した形。
 * task 13.13（Q5）で TopK 1 の生応答を記録して確認した（`VectorConsumedCapacityBody` 参照）。
 * SDK のモデルを土台にしているため、モデル側に項目が増えれば自動的に追随する。
 */
type ObservedVectorCapacity = VectorCapacity & {
  /** SDK の `VectorCapacity` に無い。実 API の生応答から読む */
  VectorSearchUnits?: number;
};

/** `SearchVectors` の出力。`ConsumedCapacity` のみ {@link ObservedVectorCapacity} に差し替える */
type ObservedSearchVectorsOutput = Omit<SearchVectorsOutput, 'ConsumedCapacity'> & {
  ConsumedCapacity?: ObservedVectorCapacity;
};

/**
 * `SearchVectors` を 1 回呼ぶ（要件 8.1）。
 *
 * ベクトル検索専用エンドポイントを自分で指定するため、`SearchVectorsCommand` ではなく
 * AWS JSON 1.0 の署名付き HTTP 要求を直接送る。**入力と出力の型は SDK のモデルであり、
 * 送信する本文が実 API の形と一致することはコンパイラが確認する。**
 *
 * **送信形の実測（task 13.13）:** `SearchVector` は SDK のモデルどおり
 * `AttributeValue[]`（`[{ "N": "..." }, ...]`）でなければならない。素の数値配列
 * （`[-0.0266, ...]`）で送ると HTTP 400 `SerializationException` になる。
 */
async function callSearchVectors(input: SearchVectorsInput): Promise<ObservedSearchVectorsOutput> {
  const endpoint = new URL(resolveSearchEndpoint());
  const body = JSON.stringify(input);

  const request = new HttpRequest({
    method: 'POST',
    protocol: endpoint.protocol.replace(':', ''),
    hostname: endpoint.hostname,
    port: endpoint.port.length > 0 ? Number(endpoint.port) : undefined,
    path: '/',
    headers: {
      host: endpoint.host,
      'content-type': 'application/x-amz-json-1.0',
      'x-amz-target': SEARCH_VECTORS_TARGET,
    },
    body,
  });

  const signed = await getSearchSigner().sign(request);

  const response = await fetch(`${endpoint.origin}/`, {
    method: 'POST',
    headers: signed.headers,
    body,
  });

  const text = await response.text();

  if (!response.ok) {
    throw toServiceError(response.status, text);
  }

  const parsed = text.length > 0 ? (JSON.parse(text) as unknown) : {};
  const record = asRecord(parsed);
  if (!record) {
    throw new Error('SearchVectors returned a body that is not a JSON object.');
  }

  return {
    SearchResults: Array.isArray(record.SearchResults)
      ? (record.SearchResults as SearchResultItem[])
      : [],
    ConsumedCapacity: asRecord(record.ConsumedCapacity) as ObservedVectorCapacity | undefined,
  };
}

/**
 * サービスのエラー応答を `classifyError()` が読める形の例外へ変換する（要件 16.7）。
 *
 * `classifyError()` は例外名（`name` / `__type` / `code`）と `$metadata.httpStatusCode` と
 * メッセージから 1 つのコードへ分類する。`SearchVectors` は
 * `ResourceNotFoundException` / `ThrottlingException` / `RequestLimitExceeded` を
 * HTTP 400 で返すため、状態コードよりも例外名の方が判定に効く。
 */
function toServiceError(status: number, rawBody: string): Error {
  let type = '';
  let message = '';

  try {
    const record = asRecord(JSON.parse(rawBody));
    const rawType = record?.__type ?? record?.code;
    if (typeof rawType === 'string') {
      type = rawType.includes('#') ? rawType.slice(rawType.lastIndexOf('#') + 1) : rawType;
    }
    const rawMessage = record?.message ?? record?.Message;
    if (typeof rawMessage === 'string') message = rawMessage;
  } catch {
    // 本文が JSON でない場合は状態コードのみで分類する
  }

  const error = new Error(
    message.length > 0 ? message : `SearchVectors failed with HTTP status ${status}.`
  );
  if (type.length > 0) error.name = type;
  Object.assign(error, { $metadata: { httpStatusCode: status } });
  return error;
}

// ============================================================
// ステップ 8・9: 結果の整形
// ============================================================

/**
 * `SearchVectors` の結果を距離昇順の `hits` へ整形する（要件 8.9 / 8.10）。
 *
 * COSINE の `Score` は距離そのもの（0 = 同一、2 = 正反対）であり、`distance` と `rawScore` に
 * 同じ値を入れる。`rank` は整列後の 1 起点の連番である。件数が TopK 未満（0 件を含む）でも
 * エラーにしない。
 *
 * **実測による確定（task 13.13 / Q5、2026-08-21、us-west-2、`byEmbeddingJa`、TopK 1）:**
 * 距離スコアのレスポンスフィールド名は `SearchResults[].Score` であり（SDK の
 * `SearchResultItem.Score` と一致）、その値は**コサイン距離 `1 − cos` そのもの**である。
 * 返却行の格納ベクトルを `GetItem` で読んでローカルに算出した厳密値
 * `d_local = 0.9396041371918892` に対し、観測値 `Score = 0.9396041035652161` の残差は
 * 3.36e-8（f32 精度の範囲内）だった。類似度（`1 − Score`）・式 A（`2 − 2 × Score`）・
 * 式 B（`1 / Score − 1`）はいずれも残差 0.8 以上で棄却された。
 * したがって `distance = rawScore = Score` の対応で確定であり、変換は挟まない。
 */
export function toHits(
  results: readonly SearchResultItem[],
  language: VectorLanguage
): VectorSearchHitBody[] {
  const metaKey = language === 'ja' ? 'metaJa' : 'metaEn';

  return results
    .map((result) => {
      // 射影された属性は AttributeValue の JSON 表現で返る。`unmarshall` で素の値へ戻す。
      // ベクトル属性は射影対象ではないため、ここに現れる余地がない（要件 8.8）
      const attributes = result.Item ? unmarshall(result.Item) : {};
      const meta = asRecord(attributes[metaKey]);
      const score =
        typeof result.Score === 'number' && Number.isFinite(result.Score)
          ? result.Score
          : MAX_COSINE_DISTANCE;

      return {
        itemId: readString(attributes.itemId),
        warehouseId: readString(attributes.warehouseId),
        // `metaJa.productName` は既存の itemName と同一値。メタデータが欠けた行でも
        // 表示名が空にならないよう itemName を控えとして使う
        productName: readMetaField(meta, 'productName') || readString(attributes.itemName),
        category: readMetaField(meta, 'category'),
        origin: readMetaField(meta, 'origin'),
        roastLevel: readMetaField(meta, 'roastLevel'),
        flavorNotes: readMetaField(meta, 'flavorNotes'),
        quantity: readNumber(attributes.quantity),
        location: readString(attributes.location),
        unitPrice: readNumber(attributes.unitPrice),
        // 整列後に上書きする
        rank: 0,
        distance: score,
        rawScore: score,
      } satisfies VectorSearchHitBody;
    })
    .sort((a, b) => a.distance - b.distance)
    .map((hit, index) => ({ ...hit, rank: index + 1 }));
}

/** 返却行の itemId 一意件数（要件 12.2） */
export function countDistinctSkus(hits: readonly VectorSearchHitBody[]): number {
  return new Set(hits.map((hit) => hit.itemId)).size;
}

/**
 * `ConsumedCapacity` を応答の形へ写す（要件 8.11）。
 *
 * 読むのは `VectorSearchRequestBytes` / `VectorWriteRequestBytes` /
 * **`VectorSearchUnits`** の 3 項目である。最後の 1 つは SDK の `VectorCapacity` モデルに
 * 無いが実 API が返す（task 13.13 で TopK 1 の生応答を記録して確認）。
 * `SearchVectors` の `ConsumedCapacity` に `CapacityUnits` は存在しない。
 * 数値が 1 つも読めなかった場合は `null` を返し、0 を捏造しない。
 */
export function toConsumedCapacity(
  raw: ObservedVectorCapacity | undefined
): VectorConsumedCapacityBody | null {
  if (raw === undefined) return null;

  const searchBytes = readFiniteNumber(raw.VectorSearchRequestBytes);
  const writeBytes = readFiniteNumber(raw.VectorWriteRequestBytes);
  const searchUnits = readFiniteNumber(raw.VectorSearchUnits);
  if (searchBytes === undefined && writeBytes === undefined && searchUnits === undefined) return null;

  return {
    ...(searchBytes === undefined ? {} : { vectorSearchRequestBytes: searchBytes }),
    ...(writeBytes === undefined ? {} : { vectorWriteRequestBytes: writeBytes }),
    ...(searchUnits === undefined ? {} : { vectorSearchUnits: searchUnits }),
  };
}

// ============================================================
// ハンドラ
// ============================================================

/**
 * DynamoDB ベクトル検索ハンドラー
 *
 * POST /vector-search/dynamodb
 *
 * `SearchVectors` を呼ぶのは、TopK 検証・次元数照合・インデックス準備状態・フィルタ種別の
 * 4 つの門をすべて通過した場合のみである（要件 8.5 / 8.7 / 16.1 / 16.2 / 16.3）。
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // 要件 8.12: ハンドラ開始〜レスポンス生成完了の区間。`SearchVectors` 区間とは別に計測する
  const handlerStartedAtMs = Date.now();

  // 要件 8.13: コールドスタート判定。実行環境の初期化直後の 1 回のみ true
  const isColdStart = coldStart;
  coldStart = false;

  try {
    const raw = parseSearchRequest(event);

    const vectorTableName = process.env[VECTOR_TABLE_NAME_ENV];
    const queryCacheTableName = process.env[QUERY_CACHE_TABLE_NAME_ENV];
    if (
      typeof vectorTableName !== 'string' ||
      vectorTableName.trim().length === 0 ||
      typeof queryCacheTableName !== 'string' ||
      queryCacheTableName.trim().length === 0
    ) {
      console.error(
        `vector-search-ddb: environment variables ${VECTOR_TABLE_NAME_ENV} and ` +
          `${QUERY_CACHE_TABLE_NAME_ENV} must both be configured.`
      );
      return errorResponse(
        toClientError('INTERNAL_ERROR', STAGE, { detail: '検索対象の設定が不足しています。' })
      );
    }

    // ---- ステップ 1: `queryId` からベクトルと言語を解決する（要件 16.6） ----
    if (typeof raw.queryId !== 'string' || raw.queryId.trim().length === 0) {
      return errorResponse(
        toClientError('QUERY_EXPIRED', STAGE, {
          detail: 'リクエストから queryId を読み取れませんでした。埋め込み生成からやり直してください。',
        })
      );
    }

    const resolved = await resolveQuery(queryCacheTableName.trim(), raw.queryId.trim());
    if (!resolved.ok) return errorResponse(resolved.error);

    const { vector, language } = resolved.query;

    // ---- ステップ 2: 言語ルーティング（要件 8.2） ----
    // インデックス名の決定経路はこの 1 行のみ。本ファイルは名前を組み立てない
    const indexName = resolveIndexName(language);

    // ---- ステップ 3: TopK 正規化（要件 8.3 / 8.4 / 8.5） ----
    const topK = normalizeTopK(coerceTopK(raw.topK));
    if (!topK.ok) {
      // `SearchVectors` を呼ばずに検証エラー。許容範囲を説明文へ載せる
      return errorResponse(toClientError('INVALID_TOPK', STAGE, { detail: topK.message }));
    }

    // ---- ステップ 4: 次元数チェック（要件 16.1） ----
    // 許容範囲（DynamoDB は 1〜4,096）の判定は `validateDimensions()` に委ね、
    // インデックス定義次元数との一致は個別に確認する。どちらも `SearchVectors` の前に行う
    const queryDimensions = vector.length;
    const dimensions = validateDimensions(queryDimensions, 'dynamodb');
    if (!dimensions.ok || dimensions.dimensions !== INDEX_DIMENSIONS) {
      return errorResponse(dimensionMismatchError(STAGE, queryDimensions, INDEX_DIMENSIONS));
    }

    // ---- ステップ 5: インデックス準備状態チェック（要件 5.15 / 16.2 / 16.3） ----
    const lookup = await lookupVectorIndex(vectorTableName.trim(), indexName, Date.now());

    if (!lookup.index) {
      // 当該言語のインデックスが存在しない。再試行不可
      return errorResponse(
        toClientError('INDEX_NOT_FOUND', STAGE, { detail: `対象インデックス名: ${indexName}。` })
      );
    }

    const indexStatus = readString(lookup.index.IndexStatus);
    const backfilling = lookup.index.Backfilling === true;
    const backfillingPresent = isBackfillingPresent(lookup.index);

    if (!isVectorIndexSearchable(lookup.index)) {
      // `IndexStatus` と `Backfilling` の**両方**の値を返す（要件 5.15 / 16.3、V5）。
      // `Backfilling` が不在の場合は偽と書かず不在であることを示す（要件 5.17、V20）。
      // 本応答はレイテンシおよび Recall_At_K の測定値として採用しない
      return errorResponse(
        toClientError('INDEX_BUILDING', STAGE, {
          detail:
            `対象インデックス名: ${indexName}、IndexStatus: ${indexStatus || '不明'}、` +
            `Backfilling: ${backfillingPresent ? String(backfilling) : BACKFILLING_ABSENT_LABEL}。`,
          retryAfterSeconds: INDEX_BUILDING_RETRY_AFTER_SECONDS,
        })
      );
    }

    // インデックスの実際の次元数が読めた場合は、設定値ではなく実物と照合する（要件 16.1）。
    // 環境変数がインデックス定義から乖離していても誤った検索を実行しない
    // `VectorIndexDescription.Dimensions` は数値である（文字列で返る経路はない）
    const actualDimensions = lookup.index.Dimensions;
    if (
      typeof actualDimensions === 'number' &&
      Number.isInteger(actualDimensions) &&
      actualDimensions !== queryDimensions
    ) {
      return errorResponse(dimensionMismatchError(STAGE, queryDimensions, actualDimensions));
    }

    // ---- ステップ 6: フィルタ構築（要件 8.6 / 8.7） ----
    const capabilities = getVectorCapabilities('dynamodb');

    // 範囲条件の対応可否は未確定であり、実装既定は等価条件のみ（前提 A3 / V3 / Q1）。
    // 対応種別の出典は `constraints.ts` のみであり、実測で `range` が追加されれば本判定も追従する
    if (requestsRangeFilter(raw.rangeFilter) && !supportsFilterKind(capabilities, 'range')) {
      return errorResponse(
        toClientError('RANGE_FILTER_UNSUPPORTED', STAGE, {
          detail:
            '範囲条件の対応可否は未確定であり、実装既定は等価条件のみです。' +
            '倉庫の等価条件のみを指定してください。',
        })
      );
    }

    const warehouseId = resolveWarehouseId(raw.warehouseId);
    const filterApplied: string[] = [];

    const searchInput: SearchVectorsInput = {
      TableName: vectorTableName.trim(),
      IndexName: indexName,
      // 各要素は 32bit IEEE-754 浮動小数。書き込み時と同じ f32 丸め済みの値を渡す
      SearchVector: vector.map((element) => ({ N: String(element) })),
      TopK: topK.appliedTopK,
      // 表示用の非ベクトル属性のみ。`embeddingJa` / `embeddingEn` を含めない（要件 8.8）
      ProjectionExpression: PROJECTED_ATTRIBUTES.map((_, index) => `#p${index}`).join(', '),
      ExpressionAttributeNames: Object.fromEntries(
        PROJECTED_ATTRIBUTES.map((attribute, index) => [`#p${index}`, attribute])
      ),
      // 要件 8.11: 消費キャパシティを応答へ載せるために有効にする
      ReturnConsumedCapacity: 'INDEXES',
    };

    if (warehouseId !== undefined) {
      // 要件 8.6: 属性名と値を式文字列へ直接埋め込まず、名前と値のバインドで渡す
      searchInput.SearchConditionExpression = '#wh = :wh';
      searchInput.ExpressionAttributeNames = {
        ...searchInput.ExpressionAttributeNames,
        '#wh': WAREHOUSE_FILTER_ATTRIBUTE,
      };
      searchInput.ExpressionAttributeValues = { ':wh': { S: warehouseId } };
      filterApplied.push(`${WAREHOUSE_FILTER_ATTRIBUTE} = "${warehouseId}"`);
    }

    // ---- ステップ 7・10: `SearchVectors` を 1 回呼び、その区間のみを計測する（要件 8.1 / 8.12） ----
    const searchStartedAtMs = Date.now();
    const output = await callSearchVectors(searchInput);
    const searchLatencyMs = Date.now() - searchStartedAtMs;

    // ---- ステップ 8・9: 距離昇順・1 起点の連番。TopK 未満（0 件含む）でもエラーにしない ----
    const hits = toHits(output.SearchResults ?? [], language);

    const body: DynamoDBVectorSearchResponseBody = {
      backend: 'dynamodb',
      hits,
      language,
      requestedTopK: topK.requestedTopK,
      appliedTopK: topK.appliedTopK,
      returnedCount: hits.length,
      distinctSkuCount: countDistinctSkus(hits),
      searchLatencyMs,
      handlerLatencyMs: Date.now() - handlerStartedAtMs,
      coldStart: isColdStart,
      indexName,
      distanceFunction: DISTANCE_FUNCTION,
      distanceSemantics: DISTANCE_SEMANTICS,
      filterApplied,
      consumedCapacity: toConsumedCapacity(output.ConsumedCapacity),
      indexReadiness: {
        indexStatus,
        backfilling,
        backfillingPresent,
        describeTableCached: lookup.cached,
      },
      constraints: capabilities,
    };

    return successResponse(body);
  } catch (error: unknown) {
    // 下位サービスの失敗と予期しない例外の両方をここで 1 つのコードへ分類する（要件 16.7）。
    // 原文とスタックトレースは CloudWatch Logs にのみ出し、応答へはサニタイズ済みの抜粋のみを載せる
    console.error('vector-search-ddb error:', error);
    return errorResponse(classifyError(error, STAGE));
  }
};
