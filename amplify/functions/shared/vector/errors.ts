/**
 * ベクトル検索のエラー分類と応答生成（純関数）
 *
 * 3 つの Lambda（埋め込み生成 / DynamoDB 検索 / OpenSearch 検索）が返す
 * エラー応答を組み立てる唯一の経路。呼び出し側は例外を直接 API 応答へ
 * 変換してはならず、必ず `classifyError()` または `toClientError()` を通す。
 *
 * 設計上の約束:
 * - `classifyError()` は全域関数。非 Error 値、getter が例外を投げるオブジェクト、
 *   循環参照を含む値に対しても例外を投げず、必ず定義済みコードのちょうど 1 つを返す
 * - **`INVALID_QUERY` と `QUERY_TOO_LONG` はハンドラ側の入力検証だけが付与する。**
 *   下位サービスのエラー分類経路（`classifyError()`）はこの 2 つを一切返さない（要件 16.10）
 * - 説明文は付与したエラーコードの発生条件と矛盾しない内容に限る。他コードの発生条件を
 *   述べる定型文は補足からも除去する（要件 16.11）
 * - 再試行可否はエラーコードに対して一意に定まる（段階や原文で変わらない）
 * - `toClientError()` は ARN、12 桁以上の数字列、スタックトレース、
 *   資格情報を示すキー名を除去し、説明文を 500 文字で打ち切る
 * - 内部の詳細（原文、スタックトレース）は CloudWatch Logs にのみ出力する。
 *   本モジュールは応答へサニタイズ済みの抜粋のみを載せる
 *
 * 要件: 4.7, 16.1, 16.5, 16.6, 16.7, 16.9, 16.10, 16.11
 * 設計: Error Handling / 分類の実装 / Property 51 / Property 52 / Property 60
 */

/** 機械可読エラーコード（要件 16）。この 15 種以外を応答に載せない */
export type VectorErrorCode =
  | 'DIMENSION_MISMATCH'
  | 'INDEX_NOT_FOUND'
  | 'INDEX_BUILDING'
  | 'RANGE_FILTER_UNSUPPORTED'
  | 'INVALID_TOPK'
  | 'INVALID_QUERY'
  | 'INVALID_LANGUAGE'
  | 'QUERY_TOO_LONG'
  | 'QUERY_EXPIRED'
  | 'OPENSEARCH_TIMEOUT'
  | 'ACCESS_DENIED_IAM'
  | 'ACCESS_DENIED_DATA_POLICY'
  | 'RESOURCE_NOT_FOUND'
  | 'THROTTLED'
  | 'INTERNAL_ERROR';

/** 失敗した処理段階（要件 16.5）。3 値のみ */
export type VectorErrorStage = 'EMBEDDING' | 'SEARCH_DYNAMODB' | 'SEARCH_OPENSEARCH';

/**
 * エラー応答。ARN、アカウント ID、認証情報、スタックトレースを含めない（要件 16.9）。
 * 本インターフェースのプロパティ以外を応答へ追加しない（漏洩経路を型で塞ぐ）。
 */
export interface VectorErrorResponse {
  stage: VectorErrorStage;
  errorCode: VectorErrorCode;
  /** 500 文字以内の説明文 */
  message: string;
  retryable: boolean;
  /** retryable が true のときのみ設定される推奨待機秒数 */
  retryAfterSeconds?: number;
}

/** 定義済みエラーコードの一覧。分類結果の値域の唯一の出典（Property 51） */
export const VECTOR_ERROR_CODES = [
  'DIMENSION_MISMATCH',
  'INDEX_NOT_FOUND',
  'INDEX_BUILDING',
  'RANGE_FILTER_UNSUPPORTED',
  'INVALID_TOPK',
  'INVALID_QUERY',
  'INVALID_LANGUAGE',
  'QUERY_TOO_LONG',
  'QUERY_EXPIRED',
  'OPENSEARCH_TIMEOUT',
  'ACCESS_DENIED_IAM',
  'ACCESS_DENIED_DATA_POLICY',
  'RESOURCE_NOT_FOUND',
  'THROTTLED',
  'INTERNAL_ERROR',
] as const satisfies readonly VectorErrorCode[];

/** 定義済み処理段階の一覧（要件 16.5） */
export const VECTOR_ERROR_STAGES = [
  'EMBEDDING',
  'SEARCH_DYNAMODB',
  'SEARCH_OPENSEARCH',
] as const satisfies readonly VectorErrorStage[];

/**
 * **ハンドラ側の入力検証だけが付与できるエラーコード（要件 16.10、Property 60）。**
 *
 * これらの発生条件はクエリ文字列そのものの妥当性（空文字 / 空白のみ / 上限文字数超過）であり、
 * 下位サービスのエラーからは判定できない。下位サービスの `ValidationException` を
 * 既定分岐でここへ落とすと、真因（V17 の実測では「レイテンシ最適化推論の未対応」）と
 * 無関係な定型文が応答へ付く。したがって**分類経路そのものから除外する**。
 *
 * 判定手段を持たない条件を推測するのではなく、経路で切ることで規則を実装可能にしている。
 */
export const INPUT_VALIDATION_ONLY_ERROR_CODES = [
  'INVALID_QUERY',
  'QUERY_TOO_LONG',
] as const satisfies readonly VectorErrorCode[];

/** 分類できない場合のフォールバックコード（全域性の担保） */
export const FALLBACK_ERROR_CODE: VectorErrorCode = 'INTERNAL_ERROR';

/** 型に反する段階が実行時に渡された場合の既定値。最初の段階を仮定する */
export const FALLBACK_ERROR_STAGE: VectorErrorStage = 'EMBEDDING';

/** 応答の説明文の上限文字数（要件 16.9） */
export const MAX_ERROR_MESSAGE_LENGTH = 500;

/** 応答へ載せる内部メッセージ抜粋の上限文字数。全体の 500 文字制限より内側に収める */
export const MAX_DETAIL_LENGTH = 200;

/** 除去対象を置き換える文字列 */
const REDACTED = '[redacted]';

/** 再試行方針。コードに対して一意（Property 51） */
export interface VectorErrorRetryPolicy {
  retryable: boolean;
  /** retryable が true のときの既定の推奨待機秒数 */
  defaultRetryAfterSeconds?: number;
  /** 推奨待機秒数の下限（要件 16.3 / 16.7） */
  minRetryAfterSeconds?: number;
  /** 推奨待機秒数の上限（要件 16.3 / 16.7） */
  maxRetryAfterSeconds?: number;
}

/**
 * エラーコードごとの再試行方針。
 *
 * 再試行可は 4 種のみ。`THROTTLED` は 1〜60 秒、`INDEX_BUILDING` は 1〜300 秒の
 * 範囲に推奨待機秒数を収める（要件 16.3 / 16.7）。`QUERY_EXPIRED` は待機なしで
 * 埋め込み生成からの再実行を求める（要件 16.6）。
 */
export const VECTOR_ERROR_RETRY_POLICY: Readonly<Record<VectorErrorCode, VectorErrorRetryPolicy>> =
  Object.freeze({
    DIMENSION_MISMATCH: { retryable: false },
    INDEX_NOT_FOUND: { retryable: false },
    INDEX_BUILDING: {
      retryable: true,
      defaultRetryAfterSeconds: 30,
      minRetryAfterSeconds: 1,
      maxRetryAfterSeconds: 300,
    },
    RANGE_FILTER_UNSUPPORTED: { retryable: false },
    INVALID_TOPK: { retryable: false },
    INVALID_QUERY: { retryable: false },
    INVALID_LANGUAGE: { retryable: false },
    QUERY_TOO_LONG: { retryable: false },
    QUERY_EXPIRED: {
      retryable: true,
      defaultRetryAfterSeconds: 0,
      minRetryAfterSeconds: 0,
      maxRetryAfterSeconds: 0,
    },
    OPENSEARCH_TIMEOUT: {
      retryable: true,
      defaultRetryAfterSeconds: 5,
      minRetryAfterSeconds: 1,
      maxRetryAfterSeconds: 60,
    },
    ACCESS_DENIED_IAM: { retryable: false },
    ACCESS_DENIED_DATA_POLICY: { retryable: false },
    RESOURCE_NOT_FOUND: { retryable: false },
    THROTTLED: {
      retryable: true,
      defaultRetryAfterSeconds: 5,
      minRetryAfterSeconds: 1,
      maxRetryAfterSeconds: 60,
    },
    INTERNAL_ERROR: { retryable: false },
  });

/** エラーコードごとの HTTP ステータス（設計「エラーコードと再試行可否の対応」） */
export const VECTOR_ERROR_HTTP_STATUS: Readonly<Record<VectorErrorCode, number>> = Object.freeze({
  DIMENSION_MISMATCH: 400,
  INDEX_NOT_FOUND: 404,
  INDEX_BUILDING: 409,
  RANGE_FILTER_UNSUPPORTED: 400,
  INVALID_TOPK: 400,
  INVALID_QUERY: 400,
  INVALID_LANGUAGE: 400,
  QUERY_TOO_LONG: 400,
  QUERY_EXPIRED: 410,
  OPENSEARCH_TIMEOUT: 504,
  ACCESS_DENIED_IAM: 403,
  ACCESS_DENIED_DATA_POLICY: 403,
  RESOURCE_NOT_FOUND: 404,
  THROTTLED: 429,
  INTERNAL_ERROR: 500,
});

/**
 * コードごとの説明文の基底。内部情報を含まない固定文のみ。
 *
 * **各文はそのコードの発生条件だけを述べる**（要件 16.11、Property 60）。あるコードの
 * 発生条件を述べる定型文が別のコードの応答へ現れない構造にするため、この表が定型文の
 * 唯一の出典であり、`toClientError()` は付与するコードの 1 文のみを採る。
 */
export const VECTOR_ERROR_BASE_MESSAGES: Readonly<Record<VectorErrorCode, string>> = Object.freeze({
  DIMENSION_MISMATCH: 'クエリベクトルの次元数がインデックスの次元数と一致しないため、検索を実行しませんでした。',
  INDEX_NOT_FOUND: '指定された言語に対応するベクトルインデックスが存在しないため、検索を実行しませんでした。',
  INDEX_BUILDING:
    'ベクトルインデックスが構築中のため、検索を実行しませんでした。時間をおいて再試行してください。',
  RANGE_FILTER_UNSUPPORTED:
    '範囲条件を含むフィルタには対応していません。等価条件のみを指定してください。',
  INVALID_TOPK: 'TopK は 1 以上 100 以下の整数のみを受け付けます。',
  INVALID_QUERY: 'クエリ文字列が空、または空白文字のみです。',
  INVALID_LANGUAGE: '検索言語は ja または en のみを受け付けます。',
  QUERY_TOO_LONG: 'クエリ文字列が上限文字数を超えています。',
  QUERY_EXPIRED:
    'クエリベクトルのハンドルが失効しています。埋め込み生成からやり直してください。',
  OPENSEARCH_TIMEOUT:
    'OpenSearch の検索が制限時間内に完了しませんでした。コールドスタートの可能性があります。再試行してください。',
  ACCESS_DENIED_IAM: 'IAM 権限が不足しているため、処理を実行できませんでした。',
  ACCESS_DENIED_DATA_POLICY:
    'OpenSearch のデータアクセスポリシーの権限が不足しているため、処理を実行できませんでした。',
  RESOURCE_NOT_FOUND: '対象のリソースが見つかりませんでした。',
  THROTTLED: '下位サービスの流量制限に達しました。時間をおいて再試行してください。',
  INTERNAL_ERROR: '内部エラーが発生しました。詳細はサーバー側のログを確認してください。',
});

/** 値が定義済みエラーコードか判定する */
export function isVectorErrorCode(value: unknown): value is VectorErrorCode {
  return typeof value === 'string' && (VECTOR_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * ハンドラ側の入力検証だけが付与できるコードか判定する（要件 16.10）。
 * 分類経路がこのコードを返さないことを保証するための述語。
 */
export function isInputValidationOnlyErrorCode(code: VectorErrorCode): boolean {
  return (INPUT_VALIDATION_ONLY_ERROR_CODES as readonly VectorErrorCode[]).includes(code);
}

/** 値が定義済み処理段階か判定する */
export function isVectorErrorStage(value: unknown): value is VectorErrorStage {
  return typeof value === 'string' && (VECTOR_ERROR_STAGES as readonly string[]).includes(value);
}

/** エラーコードから再試行可否を返す（コードに対して一意） */
export function isRetryableErrorCode(code: VectorErrorCode): boolean {
  return VECTOR_ERROR_RETRY_POLICY[code]?.retryable === true;
}

/** エラーコードに対応する HTTP ステータスを返す */
export function httpStatusForErrorCode(code: VectorErrorCode): number {
  return VECTOR_ERROR_HTTP_STATUS[code] ?? VECTOR_ERROR_HTTP_STATUS.INTERNAL_ERROR;
}

// ---------------------------------------------------------------------------
// サニタイズ（要件 16.9）
// ---------------------------------------------------------------------------

/** ARN。`arn:aws` 以降の空白までを一括で落とす（部分文字列 `arn:aws` も残さない） */
const ARN_PATTERN = /arn:aws[^\s'"`,;)\]}]*/gi;

/** 12 桁以上の数字列。AWS アカウント ID を含む（部分一致で 12 桁が残らないよう 12 桁以上を対象にする） */
const LONG_DIGITS_PATTERN = /\d{12,}/g;

/** アクセスキー ID の形式 */
const ACCESS_KEY_ID_PATTERN = /\b(?:AKIA|ASIA|ABIA|ACCA|AIDA|AROA)[0-9A-Z]{8,}\b/g;

/** 資格情報・スタックを示すキーとその値の組 */
const SENSITIVE_ENTRY_PATTERN =
  /"?\b(?:aws[_-]?)?(?:access[_-]?key[_-]?id|access[_-]?key|secret[_-]?access[_-]?key|secret[_-]?key|secret|session[_-]?token|security[_-]?token|x-amz-security-token|credentials?|password|passwd|pwd|authorization|auth[_-]?token|bearer|api[_-]?key|signature|stack[_-]?trace|stack)\b"?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;)\]}]*)/gi;

/** 値を伴わない資格情報のキー名 */
const SENSITIVE_KEY_PATTERN =
  /\b(?:aws[_-]?)?(?:access[_-]?key[_-]?id|access[_-]?key|secret[_-]?access[_-]?key|secret[_-]?key|session[_-]?token|security[_-]?token|x-amz-security-token|credentials|password|passwd|auth[_-]?token|api[_-]?key|bearer)\b/gi;

/** スタックトレースのフレーム行（`    at Foo (file:1:2)`） */
const STACK_FRAME_PATTERN = /^\s*at\s+\S.*$/gm;

/**
 * 内部由来の文字列から漏洩要因を除去し、長さを抑える（要件 16.9）。
 *
 * 除去順は「スタックフレーム → 資格情報の組 → 資格情報のキー名 → ARN →
 * アクセスキー ID → 12 桁以上の数字列」。ARN をアカウント ID より先に落とすことで、
 * ARN 内のアカウント ID も同時に消える。置換後に空白を 1 文字へ圧縮するため、
 * 除去によって別の機微な並びが生まれることはない。
 *
 * 例外を投げない全域関数。
 */
export function sanitizeMessage(input: unknown, maxLength: number = MAX_ERROR_MESSAGE_LENGTH): string {
  let text = '';
  try {
    text = typeof input === 'string' ? input : '';
    text = text
      .replace(STACK_FRAME_PATTERN, ' ')
      .replace(SENSITIVE_ENTRY_PATTERN, REDACTED)
      .replace(SENSITIVE_KEY_PATTERN, REDACTED)
      .replace(ARN_PATTERN, REDACTED)
      .replace(ACCESS_KEY_ID_PATTERN, REDACTED)
      .replace(LONG_DIGITS_PATTERN, REDACTED)
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return '';
  }

  const limit = Number.isInteger(maxLength) && maxLength > 0 ? Math.min(maxLength, MAX_ERROR_MESSAGE_LENGTH) : MAX_ERROR_MESSAGE_LENGTH;
  return text.length > limit ? text.slice(0, limit) : text;
}

// ---------------------------------------------------------------------------
// 応答生成（唯一の経路）
// ---------------------------------------------------------------------------

/** `toClientError()` の任意指定 */
export interface ToClientErrorOptions {
  /**
   * 説明文へ追記する補足。次元数やインデックス名など、応答に載せてよい値を渡す。
   * 内部メッセージを渡してもサニタイズされるが、原文の転記は最小限に留める。
   */
  detail?: string;
  /**
   * 推奨待機秒数の上書き。コードごとの許容範囲へ丸める。
   * 再試行不可のコードでは無視される（再試行可否はコードに対して一意）。
   */
  retryAfterSeconds?: number;
}

/**
 * 外部へ返すエラー応答を生成する（要件 16.9）。**応答生成の唯一の経路**。
 *
 * - 説明文は固定文 + サニタイズ済み補足を 500 文字で打ち切る
 * - 再試行可否はエラーコードから一意に決まる
 * - `retryAfterSeconds` は再試行可のコードのときのみ設定し、許容範囲へ丸める
 * - 定義外のコード・段階が実行時に渡された場合はフォールバック値を使い、例外を投げない
 */
export function toClientError(
  errorCode: VectorErrorCode,
  stage: VectorErrorStage,
  options: ToClientErrorOptions = {}
): VectorErrorResponse {
  const code: VectorErrorCode = isVectorErrorCode(errorCode) ? errorCode : FALLBACK_ERROR_CODE;
  const resolvedStage: VectorErrorStage = isVectorErrorStage(stage) ? stage : FALLBACK_ERROR_STAGE;
  const policy = VECTOR_ERROR_RETRY_POLICY[code];

  const base = VECTOR_ERROR_BASE_MESSAGES[code];
  const detail = stripForeignConditionStatements(
    sanitizeMessage(options.detail, MAX_DETAIL_LENGTH),
    code
  );
  const message = sanitizeMessage(
    detail.length > 0 ? `${base} ${detail}` : base,
    MAX_ERROR_MESSAGE_LENGTH
  );

  if (!policy.retryable) {
    return { stage: resolvedStage, errorCode: code, message, retryable: false };
  }

  return {
    stage: resolvedStage,
    errorCode: code,
    message,
    retryable: true,
    retryAfterSeconds: clampRetryAfterSeconds(policy, options.retryAfterSeconds),
  };
}

/**
 * 補足から**他コードの発生条件を述べる定型文**を除去する（要件 16.11、Property 60）。
 *
 * 定型文の出典は `VECTOR_ERROR_BASE_MESSAGES` だけなので、付与するコード以外の 1 文が
 * 補足へ混入していれば、それは条件を満たさない失敗に条件を述べる文が付く経路である。
 * 下位サービスの原文が偶然この文を含む場合（原文の再転記など）にも効く。
 * 付与するコード自身の文は残す（同一条件の重複は矛盾しない）。
 */
function stripForeignConditionStatements(detail: string, code: VectorErrorCode): string {
  if (detail.length === 0) return detail;

  let text = detail;
  for (const other of VECTOR_ERROR_CODES) {
    if (other === code) continue;
    const statement = VECTOR_ERROR_BASE_MESSAGES[other];
    if (text.includes(statement)) text = text.split(statement).join(' ');
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** 推奨待機秒数をコードごとの許容範囲へ丸める。不正値は既定値へ落とす */
function clampRetryAfterSeconds(policy: VectorErrorRetryPolicy, requested?: number): number {
  const min = policy.minRetryAfterSeconds ?? 0;
  const max = policy.maxRetryAfterSeconds ?? min;
  const fallback = policy.defaultRetryAfterSeconds ?? min;

  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    return Math.min(Math.max(fallback, min), max);
  }

  return Math.min(Math.max(Math.round(requested), min), max);
}

/**
 * 次元数不一致のエラー応答を生成する（要件 16.1）。
 * 検索 API を呼ぶ前に使い、クエリとインデックスの両方の次元数を説明文へ含める。
 */
export function dimensionMismatchError(
  stage: VectorErrorStage,
  queryDimensions: number,
  indexDimensions: number
): VectorErrorResponse {
  return toClientError('DIMENSION_MISMATCH', stage, {
    detail: `クエリベクトルの次元数: ${describeInteger(queryDimensions)}、インデックスの次元数: ${describeInteger(indexDimensions)}。`,
  });
}

/**
 * クエリハンドル失効のエラー応答を生成する（要件 16.6）。
 * 再試行可であり、埋め込み生成からの再実行が必要である旨を説明文に含める。
 */
export function queryExpiredError(stage: VectorErrorStage): VectorErrorResponse {
  return toClientError('QUERY_EXPIRED', stage, {
    detail: '検索の再実行には埋め込み生成からのやり直しが必要です。',
  });
}

/** 整数値を応答へ載せる形へ整える。非整数は `不明` とし、桁数の大きい値も安全に扱う */
function describeInteger(value: unknown): string {
  return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) < 1e12
    ? String(value)
    : '不明';
}

// ---------------------------------------------------------------------------
// 分類（要件 16.5 / 16.7、Property 51）
// ---------------------------------------------------------------------------

/** 分類に使う手掛かり。すべて安全に抽出済み */
interface ErrorFacts {
  /** 小文字化した例外名（`name` / `__type` / `code` 由来） */
  name: string;
  /** HTTP ステータス（`$metadata.httpStatusCode` / `statusCode` 由来） */
  status?: number;
  /** 小文字化したメッセージ */
  lowerMessage: string;
  /** サニタイズ済みメッセージ抜粋。応答の説明文へ載せる */
  detail: string;
}

/** 例外名 → エラーコードの対応表。曖昧な名前はメッセージで細分する */
const NAME_RULES: Readonly<
  Record<string, (facts: ErrorFacts, stage: VectorErrorStage) => VectorErrorCode>
> = {
  throttlingexception: () => 'THROTTLED',
  throttlingerror: () => 'THROTTLED',
  throttling: () => 'THROTTLED',
  throttledexception: () => 'THROTTLED',
  requestthrottledexception: () => 'THROTTLED',
  toomanyrequestsexception: () => 'THROTTLED',
  provisionedthroughputexceededexception: () => 'THROTTLED',
  requestlimitexceeded: () => 'THROTTLED',
  limitexceededexception: () => 'THROTTLED',
  slowdown: () => 'THROTTLED',

  accessdeniedexception: classifyAccessDenied,
  accessdenied: classifyAccessDenied,
  unauthorizedexception: classifyAccessDenied,
  unrecognizedclientexception: classifyAccessDenied,
  invalidsignatureexception: classifyAccessDenied,
  expiredtokenexception: classifyAccessDenied,
  expiredtoken: classifyAccessDenied,
  missingauthenticationtokenexception: classifyAccessDenied,
  credentialserror: classifyAccessDenied,

  resourcenotfoundexception: () => 'RESOURCE_NOT_FOUND',
  resourcenotfound: () => 'RESOURCE_NOT_FOUND',
  nosuchresourceexception: () => 'RESOURCE_NOT_FOUND',
  indexnotfoundexception: () => 'INDEX_NOT_FOUND',
  index_not_found_exception: () => 'INDEX_NOT_FOUND',

  validationexception: classifyBadRequest,
  validationerror: classifyBadRequest,
  invalidrequestexception: classifyBadRequest,
  invalidparametervalueexception: classifyBadRequest,
  serializationexception: classifyBadRequest,

  timeouterror: classifyTimeout,
  timeoutexception: classifyTimeout,
  requesttimeout: classifyTimeout,
  requesttimeoutexception: classifyTimeout,
  connectiontimeouterror: classifyTimeout,
  requestabortederror: classifyTimeout,
  aborterror: classifyTimeout,
  etimedout: classifyTimeout,
  esockettimedout: classifyTimeout,
  modeltimeoutexception: classifyTimeout,

  resourceinusexception: (_facts: ErrorFacts, stage: VectorErrorStage) =>
    stage === 'SEARCH_DYNAMODB' ? 'INDEX_BUILDING' : 'INTERNAL_ERROR',

  internalservererror: () => 'INTERNAL_ERROR',
  internalfailure: () => 'INTERNAL_ERROR',
  serviceunavailableexception: () => 'INTERNAL_ERROR',
  modelerrorexception: () => 'INTERNAL_ERROR',
  modelstreamerrorexception: () => 'INTERNAL_ERROR',
};

/** メッセージパターン → エラーコード。上から順に評価し、最初に一致したものを採る */
const MESSAGE_RULES: readonly {
  readonly pattern: RegExp;
  readonly resolve: (facts: ErrorFacts, stage: VectorErrorStage) => VectorErrorCode | undefined;
}[] = [
  // 資格情報の失効はクエリハンドルの失効より先に判定する
  { pattern: /expired token|token has expired|security token.*expired|credential.*expired/, resolve: classifyAccessDenied },
  { pattern: /queryid|query vector cache|query cache|handle.*expired|expired.*handle|ttl/, resolve: () => 'QUERY_EXPIRED' },
  { pattern: /throttl|too many requests|rate exceeded|slow down|request limit exceeded/, resolve: () => 'THROTTLED' },
  { pattern: /index_not_found_exception|index not found|no such index/, resolve: () => 'INDEX_NOT_FOUND' },
  {
    pattern: /backfilling|indexstatus|index status|creating index|being (?:created|built)/,
    resolve: (_facts, stage) => (stage === 'SEARCH_DYNAMODB' ? 'INDEX_BUILDING' : undefined),
  },
  { pattern: /data access policy|no permissions for/, resolve: () => 'ACCESS_DENIED_DATA_POLICY' },
  { pattern: /access denied|not authorized|forbidden|permission/, resolve: classifyAccessDenied },
  { pattern: /timed out|timeout|etimedout|socket hang up/, resolve: classifyTimeout },
  { pattern: /not found|does not exist/, resolve: () => 'RESOURCE_NOT_FOUND' },
  { pattern: /dimension|次元/, resolve: () => 'DIMENSION_MISMATCH' },
  { pattern: /top[\s_-]?k/, resolve: () => 'INVALID_TOPK' },
  { pattern: /range (?:filter|condition|key)|範囲条件/, resolve: () => 'RANGE_FILTER_UNSUPPORTED' },
  { pattern: /language|言語/, resolve: () => 'INVALID_LANGUAGE' },
  // `too long` / `empty` / `blank` に相当する規則は置かない。クエリ文字列の妥当性は
  // ハンドラ側の入力検証だけが判定するため、下位サービスの原文から `QUERY_TOO_LONG` /
  // `INVALID_QUERY` を推測しない（要件 16.10、Property 60）。該当しない 400 系は
  // 既定の `INTERNAL_ERROR` へ落ちる
];

/**
 * 下位サービスのエラーを機械可読コードへ分類する（要件 16.5 / 16.7）。
 *
 * 判定順は **例外の `name` → `$metadata.httpStatusCode` → メッセージパターン**。
 * いずれにも当たらない場合は `INTERNAL_ERROR` にフォールバックするため、
 * 任意の入力（非 Error 値、getter が例外を投げるオブジェクトを含む）に対して
 * 定義済みコードのちょうど 1 つを返し、例外を投げない（全域性）。
 *
 * 再試行可否と推奨待機秒数はコードから一意に決まるため、
 * スロットリング以外のエラーで再試行が発生することはない（要件 4.7）。
 */
export function classifyError(error: unknown, stage: VectorErrorStage): VectorErrorResponse {
  const resolvedStage: VectorErrorStage = isVectorErrorStage(stage) ? stage : FALLBACK_ERROR_STAGE;

  let code: VectorErrorCode = FALLBACK_ERROR_CODE;
  let detail = '';

  try {
    const facts = extractFacts(error);
    detail = facts.detail;
    // 入力検証専用コードは分類経路の出力から一律で外す（要件 16.10）。
    // 個々の分岐に依存せず、経路の出口 1 箇所で保証する
    code = withoutInputValidationOnlyCode(classifyFacts(facts, resolvedStage));
  } catch {
    // 手掛かりの抽出・判定で何が起きても応答は返す（全域性）
    code = FALLBACK_ERROR_CODE;
    detail = '';
  }

  return toClientError(code, resolvedStage, { detail });
}

/**
 * 分類結果から入力検証専用コードを外す（要件 16.10、Property 60）。
 *
 * 個々の分岐が `INVALID_QUERY` / `QUERY_TOO_LONG` を返さないことは各分岐で担保しているが、
 * 分岐の追加でこの性質が崩れないよう**経路の出口でも切る**。全域性は `INTERNAL_ERROR`
 * （要件 16.7 の既定）へ落とすことで保たれる。
 */
function withoutInputValidationOnlyCode(code: VectorErrorCode): VectorErrorCode {
  return isInputValidationOnlyErrorCode(code) ? FALLBACK_ERROR_CODE : code;
}

/** 手掛かりからコードを決める。name → status → message の順 */
function classifyFacts(facts: ErrorFacts, stage: VectorErrorStage): VectorErrorCode {
  const byName = facts.name.length > 0 ? NAME_RULES[facts.name] : undefined;
  if (byName) return byName(facts, stage);

  const byStatus = facts.status !== undefined ? classifyStatus(facts, stage) : undefined;
  if (byStatus) return byStatus;

  for (const rule of MESSAGE_RULES) {
    if (!rule.pattern.test(facts.lowerMessage)) continue;
    const code = rule.resolve(facts, stage);
    if (code) return code;
  }

  return FALLBACK_ERROR_CODE;
}

/** HTTP ステータスからコードを決める。未対応のステータスはメッセージ判定へ委ねる */
function classifyStatus(facts: ErrorFacts, stage: VectorErrorStage): VectorErrorCode | undefined {
  switch (facts.status) {
    case 400:
    case 422:
      return classifyBadRequest(facts, stage);
    case 401:
      return 'ACCESS_DENIED_IAM';
    case 403:
      return classifyAccessDenied(facts, stage);
    case 404:
      return stage === 'SEARCH_DYNAMODB' && /index/.test(facts.lowerMessage)
        ? 'INDEX_NOT_FOUND'
        : 'RESOURCE_NOT_FOUND';
    case 409:
      return stage === 'SEARCH_DYNAMODB' ? 'INDEX_BUILDING' : 'INTERNAL_ERROR';
    case 410:
      return 'QUERY_EXPIRED';
    case 408:
    case 504:
    case 524:
      return classifyTimeout(facts, stage);
    case 429:
      return 'THROTTLED';
    default:
      return undefined;
  }
}

/**
 * 400 系を細分する（要件 16.7 / 16.10）。
 *
 * **既定は `INTERNAL_ERROR`（再試行不可）であり、`INVALID_QUERY` へは落とさない。**
 * V17 の実測では Bedrock の `ValidationException`（真因は「レイテンシ最適化推論の未対応」）が
 * `stage === 'EMBEDDING'` の既定分岐で `INVALID_QUERY` になり、「クエリ文字列が空、または
 * 空白文字のみです。」という真因と無関係な定型文が応答へ付いた。クエリ文字列の妥当性は
 * 下位サービスのエラーから判定できないため、この経路では判定を試みない。
 * `QUERY_TOO_LONG` も同様に扱わない（ハンドラ側の入力検証由来のみ）。
 */
function classifyBadRequest(facts: ErrorFacts, _stage: VectorErrorStage): VectorErrorCode {
  const message = facts.lowerMessage;
  if (/dimension|次元/.test(message)) return 'DIMENSION_MISMATCH';
  if (/top[\s_-]?k/.test(message)) return 'INVALID_TOPK';
  if (/range (?:filter|condition|key)|範囲条件/.test(message)) return 'RANGE_FILTER_UNSUPPORTED';
  if (/language|言語/.test(message)) return 'INVALID_LANGUAGE';
  return FALLBACK_ERROR_CODE;
}

/** 403 系を細分する。データアクセスポリシー起因と IAM 起因を分ける（要件 16.7） */
function classifyAccessDenied(facts: ErrorFacts, _stage: VectorErrorStage): VectorErrorCode {
  return /data access policy|no permissions for|aoss:|opensearch.*policy/.test(facts.lowerMessage)
    ? 'ACCESS_DENIED_DATA_POLICY'
    : 'ACCESS_DENIED_IAM';
}

/** タイムアウトを細分する。OpenSearch 検索以外の段階には専用コードを割り当てない */
function classifyTimeout(_facts: ErrorFacts, stage: VectorErrorStage): VectorErrorCode {
  return stage === 'SEARCH_OPENSEARCH' ? 'OPENSEARCH_TIMEOUT' : 'INTERNAL_ERROR';
}

// ---------------------------------------------------------------------------
// 手掛かりの抽出（例外を投げない）
// ---------------------------------------------------------------------------

/** 任意の値から分類の手掛かりを取り出す。`stack` は一切参照しない（要件 16.9） */
function extractFacts(error: unknown): ErrorFacts {
  const rawMessage = extractMessage(error);
  return {
    name: extractName(error),
    status: extractStatus(error),
    lowerMessage: rawMessage.toLowerCase(),
    detail: sanitizeMessage(rawMessage, MAX_DETAIL_LENGTH),
  };
}

/** 例外名を小文字で取り出す。`__type` の名前空間接頭辞は落とす */
function extractName(error: unknown): string {
  const candidates = [readProp(error, 'name'), readProp(error, '__type'), readProp(error, 'code')];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const bare = candidate.includes('#') ? candidate.slice(candidate.lastIndexOf('#') + 1) : candidate;
    const normalized = bare.trim().toLowerCase();
    if (normalized.length > 0 && normalized !== 'error') return normalized;
  }
  return '';
}

/** HTTP ステータスを取り出す。`$metadata.httpStatusCode` を優先する */
function extractStatus(error: unknown): number | undefined {
  const metadata = readProp(error, '$metadata');
  const meta = readProp(error, 'meta');
  const candidates = [
    readProp(metadata, 'httpStatusCode'),
    readProp(error, 'statusCode'),
    readProp(error, 'httpStatusCode'),
    readProp(error, 'status'),
    readProp(meta, 'statusCode'),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599) {
      return candidate;
    }
  }
  return undefined;
}

/** メッセージを取り出す。文字列そのものも受け付ける。`cause` は 1 段だけ辿る */
function extractMessage(error: unknown): string {
  if (typeof error === 'string') return error;

  const candidates = [
    readProp(error, 'message'),
    readProp(error, 'Message'),
    readProp(error, 'errorMessage'),
    readProp(error, 'reason'),
    readProp(readProp(error, 'cause'), 'message'),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
  }
  return '';
}

/** プロパティを安全に読む。getter が例外を投げる値、Proxy、null でも失敗しない */
function readProp(target: unknown, key: string): unknown {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) return undefined;
  try {
    return (target as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}
