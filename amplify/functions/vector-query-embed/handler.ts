/**
 * Query_Embedding_Lambda（`kiro-vector-query-embed`）
 *
 * `POST /vector-search/embed`。自然言語クエリ 1 件を指定言語の埋め込みベクトル 1 本へ変換し、
 * 生成したベクトルと言語の組を Query_Vector_Cache（`kiro-vector-query-cache`、TTL 300 秒）へ
 * `queryId` で保管して、**ハンドルと計測値のみ**を返す。
 *
 * 設計上の要点:
 * - **前処理はバッチ側と共有する。** `embedding-text.ts` の `normalizeText()` を使う唯一の経路であり、
 *   クエリ側だけ別の正規化が適用される余地がない（要件 10.1 / 10.12）
 * - **モデル・次元数・f32 丸め・再試行も共有する。** Bedrock 呼び出しは `embedding-generator.ts` に
 *   委譲し、本ファイルは `latencyOptimized: true` と `maxRetries: QUERY_MAX_RETRIES` を渡すだけである
 *   （要件 10.1 / 10.2 / 10.8）
 * - **推論経路の判定を持たない。** レイテンシ最適化推論が未対応の場合の標準推論へのフォールバックは
 *   `embedding-generator.ts` に閉じており、本ファイルは返ってきた `inferencePath` を応答へ写すだけである
 *   （要件 10.1 / 10.13〜10.15）
 * - **入力検証は Bedrock 呼び出しより前に完了させる。** 空文字・空白のみ、未対応言語、上限文字数超過は
 *   いずれも Bedrock を 1 度も呼ばずに返す（要件 10.6 / 10.7 / 10.9）。テーブル名の設定漏れも
 *   同様に呼び出し前に弾き、書き込めないベクトルの生成に課金しない
 * - **応答にベクトル本体を含めない。** ベクトルは Query_Vector_Cache にのみ置き、ブラウザへは
 *   `queryId` が渡る。両検索 Lambda が同一のベクトルと同一の言語を参照する経路がこれ 1 本になる
 *   （要件 10.3 / 10.4）
 * - **エラー応答は `errors.ts` を通した値のみを返す。** 説明文はサニタイズ済みで 500 文字以内であり、
 *   ARN・アカウント ID・資格情報・スタックトレースを含まない（要件 16.5 / 16.7 / 16.9）。
 *   経過 ms は独立した項目ではなく説明文へ載せる（応答に載せてよい項目を型で固定しているため）
 * - **既定でキャッシュしない。** `queryId` は毎リクエストで新規発行するため、同一クエリ・同一言語でも
 *   毎回 Bedrock を呼ぶ（要件 10.10）。`cacheHit` は常に `false` を返す。要件 10.11 の任意キャッシュは
 *   同テーブルに `(queryHash, language)` を検索キーとした項目を後付けする形で拡張できるよう、
 *   `queryHash` を保管しておく（既定では検索キーに使わない）
 *
 * 環境変数（タスク 8.7 の配線対象）:
 * - `QUERY_CACHE_TABLE_NAME`（必須）: Query_Vector_Cache のテーブル名。`kiro-vector-query-cache`
 * - `VECTOR_QUERY_CACHE_TTL_SECONDS`（任意）: TTL 秒数。既定 300。1〜3,600 へ丸める
 * - `VECTOR_EMBEDDING_DIMENSIONS`（任意）: 次元数。既定 1024（`embedding-generator.ts` が解決する）
 *
 * 要件: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 10.11, 10.12, 16.5, 16.8
 * 設計: Query_Embedding_Lambda / `POST /vector-search/embed` / クエリキャッシュテーブル
 */

import { createHash, randomUUID } from 'node:crypto';

import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
  QUERY_MAX_RETRIES,
  createEmbeddingGenerator,
  resolveEmbeddingDimensions,
  type EmbeddingGenerator,
  type InferencePath,
} from '../shared/vector/embedding-generator';
import { isBlankForEmbedding, normalizeText } from '../shared/vector/embedding-text';
import {
  classifyError,
  httpStatusForErrorCode,
  toClientError,
  type VectorErrorResponse,
} from '../shared/vector/errors';
import { VECTOR_LANGUAGES, isVectorLanguage, type VectorLanguage } from '../shared/vector/language';

// ============================================================
// 定数と環境変数
// ============================================================

/** 失敗した処理段階。本 Lambda は常に埋め込み生成段階である（要件 16.5） */
const STAGE = 'EMBEDDING' as const;

/**
 * 前処理後のクエリ文字列の上限文字数（要件 10.9）。
 * ちょうど 1,000 文字は受理し、1,001 文字以上を `QUERY_TOO_LONG` にする。切り詰めは行わない。
 */
export const MAX_QUERY_LENGTH = 1_000;

/** Query_Vector_Cache のテーブル名を渡す環境変数名（タスク 8.7 で配線する） */
export const QUERY_CACHE_TABLE_NAME_ENV = 'QUERY_CACHE_TABLE_NAME';

/** TTL 秒数を上書きする環境変数名 */
export const QUERY_CACHE_TTL_SECONDS_ENV = 'VECTOR_QUERY_CACHE_TTL_SECONDS';

/** キャッシュ項目の TTL 秒数（設計「クエリキャッシュテーブル」） */
export const DEFAULT_QUERY_CACHE_TTL_SECONDS = 300;

/** TTL 秒数の下限。0 以下だと書き込んだ直後に失効しうる */
const MIN_QUERY_CACHE_TTL_SECONDS = 1;

/** TTL 秒数の上限。検索の 2 フェーズをまたぐだけの用途であり、長期保持を許さない */
const MAX_QUERY_CACHE_TTL_SECONDS = 3_600;

/** CORS ヘッダー共通定義（既存ハンドラと同一の方式・同一のヘッダー構成） */
const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ============================================================
// 応答型（`src/lib/inventory/vector-types.ts` の `VectorEmbedResponse` と同一形）
// ============================================================

/**
 * `POST /vector-search/embed` の成功応答。
 * **ベクトル本体を持たない**（要件 10.3）。ベクトルは Query_Vector_Cache にのみ存在する。
 */
export interface VectorEmbedResponseBody {
  /** 検索エンドポイントへ渡すハンドル（UUID v4）。ベクトルと言語を内包する */
  queryId: string;
  /** 埋め込み生成の開始から完了までのサーバー側レイテンシ（ms、整数）（要件 10.5） */
  embeddingLatencyMs: number;
  dimensions: number;
  model: string;
  language: VectorLanguage;
  /**
   * 実際に使用した推論経路（要件 10.1 / 10.13）。
   * `latency_optimized` はレイテンシ最適化推論で成功したこと、`standard` は未対応のため
   * 標準推論へフォールバックしたことを意味する。us-west-2 の `amazon.titan-embed-text-v2:0`
   * では常に `standard` になる（A21 / V17）。測定条件の記録に使う（要件 18.22）。
   */
  inferencePath: InferencePath;
  /** 既定では常に false。キャッシュ有効時のみ意味を持つ（要件 10.10 / 10.11） */
  cacheHit: boolean;
}

// ============================================================
// 実行環境で再利用する資源（コールドスタート時のみ生成）
// ============================================================

/**
 * 次元数はコンテナ生存中に変わらない。実行ごとに解決し直すと同一コンテナ内で
 * 次元数が揺れる余地が生まれるため、モジュール読み込み時に 1 度だけ確定する（要件 10.1）。
 */
const DIMENSIONS = resolveEmbeddingDimensions();

/**
 * Bedrock 呼び出しの共有経路。
 *
 * `latencyOptimized: true` によりレイテンシ最適化推論を試す（要件 10.1）。当該モデル・当該リージョンが
 * 未対応の場合は生成器側で標準推論へ 1 回だけフォールバックし、使用した経路が `inferencePath`
 * として返る（要件 10.13〜10.15）。本ファイルは経路の判定を持たず、返った値を応答へ写すだけである。
 *
 * レート制御（既定 120 リクエスト/分）はコンテナ単位で共有される。単一の検証 UI から
 * 手動で実行する用途では上限に達しないが、達した場合は Bedrock 側のスロットリングを
 * 待つのではなく本モジュール内で待つ（`THROTTLED` を先に作らないため）。
 *
 * `BedrockRuntimeClient` は初回呼び出し時に遅延生成されるため、
 * モジュール読み込み時点では資格情報の解決が走らない。
 */
const generator: EmbeddingGenerator = createEmbeddingGenerator({
  dimensions: DIMENSIONS,
  latencyOptimized: true,
});

/** Query_Vector_Cache への書き込みに使う。実行環境で再利用して接続確立の往復を省く */
const dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION });

// ============================================================
// 入力の取り出し（全域関数）
// ============================================================

/** リクエスト本文から取り出した生の値。検証前なので型を絞らない */
interface RawEmbedRequest {
  query: unknown;
  language: unknown;
}

/**
 * API Gateway プロキシ統合の本文を解釈する。
 *
 * Base64 エンコードされた本文にも対応する。JSON として解釈できない場合、
 * オブジェクトでない場合は空の要求として扱い、後続の検証で `INVALID_QUERY` になる
 * （本文の壊れ方をエラーコードに反映しない。応答に原文を載せないため）。
 */
export function parseEmbedRequest(event: Pick<APIGatewayProxyEvent, 'body' | 'isBase64Encoded'>): RawEmbedRequest {
  const empty: RawEmbedRequest = { query: undefined, language: undefined };

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

  if (typeof parsed !== 'object' || parsed === null) return empty;

  const record = parsed as Record<string, unknown>;
  return { query: record.query, language: record.language };
}

/** TTL 秒数を解決する。設定ミスで Lambda を止めないよう例外を投げず、範囲外は端へ丸める */
export function resolveCacheTtlSeconds(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env[QUERY_CACHE_TTL_SECONDS_ENV];
  if (typeof raw !== 'string' || raw.trim().length === 0) return DEFAULT_QUERY_CACHE_TTL_SECONDS;

  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) return DEFAULT_QUERY_CACHE_TTL_SECONDS;

  const truncated = Math.trunc(parsed);
  if (truncated < MIN_QUERY_CACHE_TTL_SECONDS) return MIN_QUERY_CACHE_TTL_SECONDS;
  if (truncated > MAX_QUERY_CACHE_TTL_SECONDS) return MAX_QUERY_CACHE_TTL_SECONDS;
  return truncated;
}

/**
 * 前処理後テキストと言語からキャッシュキー候補のハッシュを作る。
 *
 * 要件 10.11 の任意キャッシュを後付けするための項目であり、**既定では検索キーに使わない**。
 * 平文のクエリをテーブルへ置かないために生文字列ではなくハッシュを保管する。
 */
export function buildQueryHash(normalizedQuery: string, language: VectorLanguage): string {
  return createHash('sha256').update(`${language}\u0000${normalizedQuery}`, 'utf8').digest('hex');
}

// ============================================================
// 応答の組み立て
// ============================================================

/** 成功応答。ベクトル本体を載せる経路が存在しない */
function successResponse(body: VectorEmbedResponseBody): APIGatewayProxyResult {
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
// ハンドラ
// ============================================================

/**
 * クエリ埋め込み生成ハンドラー
 *
 * POST /vector-search/embed
 *
 * 処理順は「入力検証 → Bedrock 呼び出し（1 回、再試行はスロットリング時のみ）→
 * Query_Vector_Cache へ保管 → ハンドルと計測値を返却」。
 * 入力検証で失敗した場合、および設定不備の場合は Bedrock を 1 度も呼ばない
 * （要件 10.6 / 10.7 / 10.9）。いずれの失敗でも検索は実行されない（呼び出し側が
 * `queryId` を得られないため、構造的に両バックエンドへ進めない。要件 16.8）。
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const { query, language } = parseEmbedRequest(event);

  // 要件 10.6: 空文字・空白のみ（半角/全角スペース、タブ、改行）は Bedrock を呼ばない。
  // 判定を `isBlankForEmbedding` に委ねることで、空白の定義がバッチ側の前処理と一致する。
  if (isBlankForEmbedding(query)) {
    return errorResponse(
      toClientError('INVALID_QUERY', STAGE, {
        detail: 'クエリ文字列を 1 文字以上（空白文字以外を含む形で）指定してください。',
      })
    );
  }

  // 要件 10.7: ja / en 以外は Bedrock を呼ばず、許容値の一覧を返す。
  // 一覧の出典は `language.ts` の `VECTOR_LANGUAGES` のみ（本ファイルに値を持たない）。
  if (!isVectorLanguage(language)) {
    return errorResponse(
      toClientError('INVALID_LANGUAGE', STAGE, {
        detail: `許容値: ${VECTOR_LANGUAGES.join(' / ')}。`,
      })
    );
  }

  // 要件 10.1 / 10.12: 前処理はバッチ側と同一の `normalizeText()` のみを適用する。
  // 言語による分岐を持たないため、日本語クエリに追加処理が入る経路が存在しない。
  const normalizedQuery = normalizeText(query);

  // 要件 10.9: 上限超過は切り詰めずに入力エラー。境界のちょうど 1,000 文字は受理する。
  if (normalizedQuery.length > MAX_QUERY_LENGTH) {
    return errorResponse(
      toClientError('QUERY_TOO_LONG', STAGE, {
        detail: `上限 ${MAX_QUERY_LENGTH} 文字に対して前処理後 ${normalizedQuery.length} 文字です。切り詰めは行いません。`,
      })
    );
  }

  // 保管先が未設定のまま Bedrock を呼ぶと、課金だけ発生してハンドルを返せない。
  // 設定不備は入力検証と同じ段階で弾く。
  const tableName = process.env[QUERY_CACHE_TABLE_NAME_ENV];
  if (typeof tableName !== 'string' || tableName.trim().length === 0) {
    console.error(
      `vector-query-embed: environment variable ${QUERY_CACHE_TABLE_NAME_ENV} is not configured.`
    );
    return errorResponse(
      toClientError('INTERNAL_ERROR', STAGE, {
        detail: 'クエリベクトルの保管先が設定されていません。',
      })
    );
  }

  // 要件 10.1 / 10.2 / 10.8: レイテンシ最適化推論で 1 回呼び、スロットリング時のみ
  // 指数バックオフで最大 3 回再試行し、f32 に丸めたベクトルを得る。
  const generated = await generator.generate({
    text: normalizedQuery,
    maxRetries: QUERY_MAX_RETRIES,
  });

  // 要件 10.5: 埋め込み生成の開始から完了までの経過 ms（整数）。検索レイテンシとは別項目。
  const embeddingLatencyMs = Math.max(0, Math.round(generated.elapsedMs));

  // 要件 18.22: 測定条件としてフォールバックの発生を記録する。応答には経路のみを載せ、
  // 根拠となったエラー本文は CloudWatch Logs 側にのみ残す（要件 16.9 が応答の項目を限定するため）。
  if (generated.latencyFallbackUsed) {
    console.warn('vector-query-embed: fell back to standard inference.', {
      inferencePath: generated.inferencePath,
      calls: generated.calls,
      embeddingLatencyMs,
    });
  }

  if (!generated.ok) {
    console.error('vector-query-embed embedding failed:', {
      errorCode: generated.error.errorCode,
      throttlingExhausted: generated.throttlingExhausted,
      calls: generated.calls,
      retries: generated.retries,
      embeddingLatencyMs,
    });

    // 要件 10.8 / 16.8: 再試行上限に達した場合は再試行可能である旨と経過 ms を返す。
    // 経過 ms は独立した項目ではなく説明文へ載せる（要件 16.9 が応答の項目を限定するため）。
    if (generated.throttlingExhausted) {
      return errorResponse(
        toClientError('THROTTLED', STAGE, {
          detail: `再試行 ${generated.retries} 回（上限 ${QUERY_MAX_RETRIES} 回）で完了しませんでした。経過時間: ${embeddingLatencyMs} ms。`,
        })
      );
    }

    // 要件 16.5 / 16.7: 段階識別子 EMBEDDING と分類済みコード 1 件をそのまま返す
    return errorResponse(generated.error);
  }

  const queryId = randomUUID();
  const ttlSeconds = resolveCacheTtlSeconds();
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;

  try {
    // 要件 10.3 / 10.4: ベクトルと言語を 1 項目として保管する。両検索 Lambda はこの 1 項目のみを
    // 参照するため、片側だけが別のベクトル・別の言語で検索する経路が存在しない。
    await dynamodb.send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshall(
          {
            queryId,
            vector: generated.embedding,
            language,
            dimensions: generated.dimensions,
            model: generated.model,
            queryHash: buildQueryHash(normalizedQuery, language),
            expiresAt,
          },
          { removeUndefinedValues: true }
        ),
      })
    );
  } catch (error: unknown) {
    // 保管に失敗した場合は検索へ進ませない。分類は `errors.ts` に委ねる（要件 16.7）
    console.error('vector-query-embed query cache put failed:', error);
    return errorResponse(classifyError(error, STAGE));
  }

  // 要件 10.10: `queryId` は毎リクエストで新規発行する。テキストをキーにした参照を行わないため、
  // 同一クエリ・同一言語でも毎回 Bedrock を呼ぶ。したがって `cacheHit` は常に false。
  return successResponse({
    queryId,
    embeddingLatencyMs,
    dimensions: generated.dimensions,
    model: generated.model,
    language,
    // 要件 10.1 / 10.13: 使用した推論経路をそのまま載せる。値を作らず生成器の結果を写すだけ
    inferencePath: generated.inferencePath,
    cacheHit: false,
  });
};
