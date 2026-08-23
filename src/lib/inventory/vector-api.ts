/**
 * ベクトル検索比較 API クライアント
 *
 * `/vector-search/*` の 4 エンドポイント（capabilities / embed / dynamodb / opensearch）を呼ぶ。
 * 既存 `api.ts` と同じ環境変数（`NEXT_PUBLIC_INVENTORY_API_URL`）とエラーハンドリング方式
 * （非 2xx はレスポンスボディをパースして throw）を踏襲する。
 *
 * 既存 `api.ts` との相違点は 2 点のみで、どちらも要件由来である。
 *
 * 1. **エラーを `VectorApiError` として throw する**。バックエンドは非 2xx で
 *    `VectorErrorResponse`（`stage` / `errorCode` / `message` / `retryable` / `retryAfterSeconds?`）
 *    を返すため、パネルごとにエラーコードと再試行可否を出せる形で呼び出し側へ渡す（要件 16.5 / 16.8）。
 *    `Error` を継承しているので、既存 UI と同じ `error.message` 参照もそのまま使える。
 * 2. **`AbortSignal` を受け取る**。`VectorSearchComparisonView` が `AbortController` と
 *    `requestSeq` で古い応答を破棄するため（要件 11.13）。中断時は `VectorApiError` ではなく
 *    fetch 由来の `AbortError` がそのまま throw されるので、`isAbortError()` で判別して
 *    state 更新を見送る。
 *
 * 検索の 2 本（dynamodb / opensearch）は本モジュールでは束ねない。呼び出し側が
 * 同時に開始して完了した側から個別に描画する（要件 11.12）。
 *
 * 要件: 11.11, 11.12, 11.13
 * 設計: API Contract
 */

import type {
  VectorCapabilitiesResponse,
  VectorEmbedRequest,
  VectorEmbedResponse,
  VectorErrorCode,
  VectorErrorResponse,
  VectorErrorStage,
  VectorSearchRequest,
  DynamoDBVectorSearchResponse,
  OpenSearchVectorSearchResponse,
} from "./vector-types";

// ============================================================
// リクエストオプション
// ============================================================

/** 全エンドポイント共通の呼び出しオプション */
export interface VectorRequestOptions {
  /**
   * 中断用シグナル。中断された場合は `AbortError` が throw される（`VectorApiError` ではない）。
   * 古い応答の破棄に使う（要件 11.13）。
   */
  signal?: AbortSignal;
}

// ============================================================
// エラー
// ============================================================

/**
 * ベクトル検索 API のエラー。
 *
 * `VectorErrorResponse` の全項目を保持する。UI は `errorCode` と `retryable` を
 * パネル単位で表示できる（要件 16.8）。`Error` 継承のため `message` 参照は既存 UI と同じ。
 */
export class VectorApiError extends Error {
  readonly stage: VectorErrorStage;
  readonly errorCode: VectorErrorCode;
  readonly retryable: boolean;
  /** `retryable` が true のときのみ設定される推奨待機秒数 */
  readonly retryAfterSeconds?: number;
  /** 応答の HTTP ステータス。ネットワーク失敗など応答が無い場合は undefined */
  readonly status?: number;

  constructor(body: VectorErrorResponse, status?: number) {
    super(body.message);
    this.name = "VectorApiError";
    this.stage = body.stage;
    this.errorCode = body.errorCode;
    this.retryable = body.retryable;
    this.retryAfterSeconds = body.retryAfterSeconds;
    this.status = status;
  }

  /** `VectorErrorResponse` 形式に戻す（表示・ログ用） */
  toResponse(): VectorErrorResponse {
    const response: VectorErrorResponse = {
      stage: this.stage,
      errorCode: this.errorCode,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.retryAfterSeconds !== undefined) {
      response.retryAfterSeconds = this.retryAfterSeconds;
    }
    return response;
  }
}

/** エラーが `VectorApiError` かを判定する */
export function isVectorApiError(error: unknown): error is VectorApiError {
  return error instanceof VectorApiError;
}

/**
 * エラーが `AbortSignal` による中断かを判定する。
 *
 * 中断は「古い応答を捨てた」ことを意味し、失敗ではない。呼び出し側は本判定が true の間、
 * パネルのエラー表示・state 更新を行わない（要件 11.13）。
 */
export function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/** 値がバックエンドの `VectorErrorResponse` として扱える形かを判定する */
function isVectorErrorResponseBody(body: unknown): body is VectorErrorResponse {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as Partial<VectorErrorResponse>;
  return (
    typeof candidate.stage === "string" &&
    typeof candidate.errorCode === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.retryable === "boolean"
  );
}

/**
 * 非 2xx 応答を `VectorApiError` として throw する。
 *
 * バックエンドが `VectorErrorResponse` を返した場合はその内容をそのまま使う。
 * API Gateway 自身が返す応答（本文が JSON でない、項目が欠けている等）は
 * バックエンドのエラーコード体系に寄せて代替値を組み立てる。
 * 429 のみ `THROTTLED`（再試行可、`Retry-After` を秒数として採用）とし、
 * それ以外は `INTERNAL_ERROR`（再試行不可）に落とす。
 */
async function handleVectorErrorResponse(
  response: Response,
  stage: VectorErrorStage
): Promise<never> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (isVectorErrorResponseBody(body)) {
    throw new VectorApiError(body, response.status);
  }

  if (response.status === 429) {
    const retryAfterHeader = Number(response.headers.get("Retry-After"));
    const retryAfterSeconds = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
      ? Math.ceil(retryAfterHeader)
      : undefined;
    throw new VectorApiError(
      {
        stage,
        errorCode: "THROTTLED",
        message: `リクエストがスロットリングされました（HTTP ${response.status}）`,
        retryable: true,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      },
      response.status
    );
  }

  throw new VectorApiError(
    {
      stage,
      errorCode: "INTERNAL_ERROR",
      message: `HTTP ${response.status}: ${response.statusText || "Unknown error"}`,
      retryable: false,
    },
    response.status
  );
}

/**
 * fetch 自体の失敗（ネットワーク断・CORS 等）を `VectorApiError` に揃える。
 *
 * 中断（`AbortError`）は失敗ではないためそのまま再 throw する。
 * ネットワーク失敗は応答が無いため段階を機械的に判別できず、`INTERNAL_ERROR`（再試行不可）
 * として扱う。クライアント側 35 秒タイムアウトは呼び出し側の責務（要件 11.23）。
 */
function toVectorApiError(error: unknown, stage: VectorErrorStage): never {
  if (isAbortError(error) || isVectorApiError(error)) {
    throw error;
  }
  const detail = error instanceof Error ? error.message : String(error);
  throw new VectorApiError({
    stage,
    errorCode: "INTERNAL_ERROR",
    message: `API への接続に失敗しました: ${detail}`,
    retryable: false,
  });
}

// ============================================================
// 共通処理
// ============================================================

/**
 * API ベース URL（末尾スラッシュを正規化）
 *
 * 既存 `api.ts` の `getBaseUrl()` と同一の環境変数・同一のメッセージ。
 * `api.ts` は本関数を export していないため、既存ファイルを変更せずに同じ規約を踏襲する。
 */
function getBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_INVENTORY_API_URL;
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_INVENTORY_API_URL が設定されていません。.env.local を確認してください。"
    );
  }
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** GET リクエストを送り、JSON をパースして返す */
async function getJson<T>(
  path: string,
  stage: VectorErrorStage,
  options?: VectorRequestOptions
): Promise<T> {
  const url = `${getBaseUrl()}${path}`;

  let response: Response;
  try {
    response = await fetch(url, { signal: options?.signal });
  } catch (error) {
    toVectorApiError(error, stage);
  }

  if (!response.ok) {
    await handleVectorErrorResponse(response, stage);
  }
  return response.json() as Promise<T>;
}

/** POST リクエストを送り、JSON をパースして返す */
async function postJson<TRequest, TResponse>(
  path: string,
  body: TRequest,
  stage: VectorErrorStage,
  options?: VectorRequestOptions
): Promise<TResponse> {
  const url = `${getBaseUrl()}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
  } catch (error) {
    toVectorApiError(error, stage);
  }

  if (!response.ok) {
    await handleVectorErrorResponse(response, stage);
  }
  return response.json() as Promise<TResponse>;
}

// ============================================================
// エンドポイント
// ============================================================

/**
 * 機能制約メタデータ取得（`GET /vector-search/capabilities`）
 *
 * 比較表（`VectorConstraintTable`）が描画する値の唯一の出所。
 * TopK 上限・対応フィルタ種別・次元数上限を画面側に固定値として持たせないため、
 * 検索実行前に呼んで常時表示する（要件 15.6）。
 *
 * 失敗時の `stage` は検索前段の扱いとして `EMBEDDING` を用いる。
 */
export async function getVectorCapabilities(
  options?: VectorRequestOptions
): Promise<VectorCapabilitiesResponse> {
  return getJson<VectorCapabilitiesResponse>(
    "/vector-search/capabilities",
    "EMBEDDING",
    options
  );
}

/**
 * クエリ埋め込み生成（`POST /vector-search/embed`）
 *
 * 1 回の検索操作につき 1 回だけ呼ぶ。応答の `queryId` を両検索エンドポイントへ渡すことで、
 * 両バックエンドが同一のベクトルを参照する（要件 11.11）。ベクトル本体はブラウザに渡らない。
 * `queryId` の TTL は 300 秒で、超過後の検索は `QUERY_EXPIRED`（再試行可）になる。
 */
export async function embedVectorQuery(
  request: VectorEmbedRequest,
  options?: VectorRequestOptions
): Promise<VectorEmbedResponse> {
  return postJson<VectorEmbedRequest, VectorEmbedResponse>(
    "/vector-search/embed",
    request,
    "EMBEDDING",
    options
  );
}

/**
 * DynamoDB ベクトル検索（`POST /vector-search/dynamodb`）
 *
 * `searchVectorOpenSearch()` と同時に開始し、完了した側から個別に描画する（要件 11.12）。
 * 本関数は他方の完了を待たない。
 */
export async function searchVectorDynamoDB(
  request: VectorSearchRequest,
  options?: VectorRequestOptions
): Promise<DynamoDBVectorSearchResponse> {
  return postJson<VectorSearchRequest, DynamoDBVectorSearchResponse>(
    "/vector-search/dynamodb",
    request,
    "SEARCH_DYNAMODB",
    options
  );
}

/**
 * OpenSearch k-NN 検索（`POST /vector-search/opensearch`）
 *
 * `searchVectorDynamoDB()` と同一の `queryId` / `topK` を渡す。
 * scale-to-zero からの復帰時はコールドスタートで応答が遅くなるため、
 * 呼び出し側でローディング表示と 35 秒タイムアウトを設ける（要件 11.21 / 11.23）。
 */
export async function searchVectorOpenSearch(
  request: VectorSearchRequest,
  options?: VectorRequestOptions
): Promise<OpenSearchVectorSearchResponse> {
  return postJson<VectorSearchRequest, OpenSearchVectorSearchResponse>(
    "/vector-search/opensearch",
    request,
    "SEARCH_OPENSEARCH",
    options
  );
}
