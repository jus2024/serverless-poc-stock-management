/**
 * TopK 正規化（純関数）
 *
 * DynamoDB Vector Search の TopK 上限 100（前提 A4）と、
 * 同一 SKU が 3 倉庫行に複製される構造（前提 A11）を扱う唯一の経路。
 *
 * このモジュールの関数はすべて全域関数であり、任意の入力に対して例外を投げない。
 * 呼び出し側は結果の `ok` を判定し、`false` の場合は検索 API を呼ばずに
 * 検証エラー応答を返す（要件 8.5）。
 *
 * 要件: 8.3, 8.4, 8.5, 13.3
 */

/** TopK の下限。これ未満は検証エラー（要件 8.3） */
export const MIN_TOP_K = 1;

/** TopK の上限。DynamoDB Vector Search の仕様（前提 A4、要件 8.3 / 8.4） */
export const MAX_TOP_K = 100;

/** 1 SKU が占める倉庫行数。同一 SKU の 3 倉庫行は同一ベクトルを持つ（前提 A11） */
export const WAREHOUSE_ROWS_PER_SKU = 3;

/** Distinct_Sku_K の上限。TopK 上限 100 ÷ 倉庫行数 3 の商（要件 13.3） */
export const MAX_DISTINCT_SKU_K = Math.floor(MAX_TOP_K / WAREHOUSE_ROWS_PER_SKU);

/** Distinct_Sku_K 上限の導出根拠。測定出力に含める（要件 13.3） */
export const DISTINCT_SKU_K_DERIVATION =
  `Distinct_Sku_K の上限 ${MAX_DISTINCT_SKU_K} は、TopK 上限 ${MAX_TOP_K} を ` +
  `1 SKU あたりの倉庫行数 ${WAREHOUSE_ROWS_PER_SKU} で割った商（floor(${MAX_TOP_K} / ${WAREHOUSE_ROWS_PER_SKU}) = ${MAX_DISTINCT_SKU_K}）である。` +
  `Distinct_Sku_K 件の一意 SKU を得るには TopK = ${WAREHOUSE_ROWS_PER_SKU} × Distinct_Sku_K を要求する。`;

/** TopK の許容範囲。検証エラー応答に含める（要件 8.5） */
export interface TopKAllowedRange {
  min: number;
  max: number;
  /** 整数のみ受理することを示す */
  integerOnly: true;
}

/** TopK の許容範囲（1 以上 100 以下の整数） */
export const TOP_K_ALLOWED_RANGE: TopKAllowedRange = Object.freeze({
  min: MIN_TOP_K,
  max: MAX_TOP_K,
  integerOnly: true,
});

/** TopK 正規化の成功結果。要求値と適用値の両方を保持する（要件 8.4） */
export interface TopKNormalizationSuccess {
  ok: true;
  /** 呼び出し側が要求した TopK */
  requestedTopK: number;
  /** 実際に検索 API へ渡す TopK。1 以上 MAX_TOP_K 以下の整数 */
  appliedTopK: number;
  /** 上限で丸めたか（requestedTopK > MAX_TOP_K のとき true） */
  clamped: boolean;
  maxTopK: number;
  allowedRange: TopKAllowedRange;
}

/** TopK 正規化の検証エラー。検索 API を呼ばずに返却する（要件 8.5） */
export interface TopKNormalizationFailure {
  ok: false;
  errorCode: 'INVALID_TOPK';
  /** 許容範囲を含む説明文 */
  message: string;
  allowedRange: TopKAllowedRange;
  /** 受信値の型（number / string / undefined など） */
  receivedType: string;
  /** 受信値の安全な文字列表現。ログと応答の両方で使える長さに抑える */
  received: string;
}

export type TopKNormalizationResult = TopKNormalizationSuccess | TopKNormalizationFailure;

/** Distinct_Sku_K から TopK を導出した成功結果（要件 13.3） */
export interface DistinctSkuKSuccess {
  ok: true;
  distinctSkuK: number;
  /** 要求すべき TopK。WAREHOUSE_ROWS_PER_SKU × distinctSkuK */
  topK: number;
  rowsPerSku: number;
  maxDistinctSkuK: number;
  maxTopK: number;
  derivation: string;
}

/** Distinct_Sku_K の検証エラー。測定不能な k を拒否する（要件 13.3） */
export interface DistinctSkuKFailure {
  ok: false;
  errorCode: 'INVALID_TOPK';
  /** `NOT_MEASURABLE` は上限超過、`INVALID_INPUT` は整数以外・0 以下 */
  reason: 'NOT_MEASURABLE' | 'INVALID_INPUT';
  message: string;
  maxDistinctSkuK: number;
  maxTopK: number;
  rowsPerSku: number;
  derivation: string;
  receivedType: string;
  received: string;
}

export type DistinctSkuKResult = DistinctSkuKSuccess | DistinctSkuKFailure;

/**
 * 任意の値を例外なく短い文字列へ変換する。
 * Symbol へのテンプレート適用や循環参照で失敗しないよう typeof で分岐する。
 */
function describeValue(value: unknown): string {
  switch (typeof value) {
    case 'number':
      return Number.isNaN(value) ? 'NaN' : String(value);
    case 'string':
      return `"${value.slice(0, 50)}"`;
    case 'bigint':
      return `${value.toString()}n`;
    case 'boolean':
      return String(value);
    case 'symbol':
      return value.toString();
    case 'function':
      return 'function';
    case 'undefined':
      return 'undefined';
    case 'object':
      if (value === null) return 'null';
      return Array.isArray(value) ? 'array' : 'object';
    default:
      return 'unknown';
  }
}

/** 1 以上 MAX_TOP_K 以下の整数（= そのまま検索 API へ渡せる値）か判定する */
export function isValidTopK(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_TOP_K && value <= MAX_TOP_K;
}

/**
 * TopK を正規化する（要件 8.3 / 8.4 / 8.5）。
 *
 * - 1 以上 100 以下の整数: そのまま適用値とする
 * - 101 以上の整数: 適用値を 100 に丸め、要求値も保持する
 * - 整数以外（小数・数値以外の型）または 0 以下: 検証エラー。呼び出し側は検索 API を呼ばない
 *
 * 数値型のみを受理する。文字列は API 境界で数値へ変換してから渡す。
 */
export function normalizeTopK(input: unknown): TopKNormalizationResult {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < MIN_TOP_K) {
    return {
      ok: false,
      errorCode: 'INVALID_TOPK',
      message:
        `TopK は ${MIN_TOP_K} 以上 ${MAX_TOP_K} 以下の整数のみを受け付けます` +
        `（受信値: ${describeValue(input)}）。`,
      allowedRange: TOP_K_ALLOWED_RANGE,
      receivedType: typeof input,
      received: describeValue(input),
    };
  }

  const appliedTopK = input > MAX_TOP_K ? MAX_TOP_K : input;

  return {
    ok: true,
    requestedTopK: input,
    appliedTopK,
    clamped: appliedTopK !== input,
    maxTopK: MAX_TOP_K,
    allowedRange: TOP_K_ALLOWED_RANGE,
  };
}

/**
 * Distinct_Sku_K から要求すべき TopK を導出する（要件 13.3）。
 *
 * 同一 SKU の 3 倉庫行が同一ベクトルを持つため、一意 SKU を k 件得るには
 * TopK = 3 × k を要求する。TopK 上限 100 により k の上限は 33。
 * 上限を超える k は測定不能として拒否し、上限とその導出を返す。
 */
export function distinctSkuKToTopK(k: unknown): DistinctSkuKResult {
  const common = {
    errorCode: 'INVALID_TOPK' as const,
    maxDistinctSkuK: MAX_DISTINCT_SKU_K,
    maxTopK: MAX_TOP_K,
    rowsPerSku: WAREHOUSE_ROWS_PER_SKU,
    derivation: DISTINCT_SKU_K_DERIVATION,
    receivedType: typeof k,
    received: describeValue(k),
  };

  if (typeof k !== 'number' || !Number.isInteger(k) || k < 1) {
    return {
      ok: false,
      reason: 'INVALID_INPUT',
      message:
        `Distinct_Sku_K は 1 以上 ${MAX_DISTINCT_SKU_K} 以下の整数のみを受け付けます` +
        `（受信値: ${describeValue(k)}）。${DISTINCT_SKU_K_DERIVATION}`,
      ...common,
    };
  }

  if (k > MAX_DISTINCT_SKU_K) {
    return {
      ok: false,
      reason: 'NOT_MEASURABLE',
      message:
        `Distinct_Sku_K = ${k} は測定できません。必要な TopK は ` +
        `${WAREHOUSE_ROWS_PER_SKU} × ${k} = ${WAREHOUSE_ROWS_PER_SKU * k} で、TopK 上限 ${MAX_TOP_K} を超えます。` +
        `${DISTINCT_SKU_K_DERIVATION}`,
      ...common,
    };
  }

  return {
    ok: true,
    distinctSkuK: k,
    topK: WAREHOUSE_ROWS_PER_SKU * k,
    rowsPerSku: WAREHOUSE_ROWS_PER_SKU,
    maxDistinctSkuK: MAX_DISTINCT_SKU_K,
    maxTopK: MAX_TOP_K,
    derivation: DISTINCT_SKU_K_DERIVATION,
  };
}
