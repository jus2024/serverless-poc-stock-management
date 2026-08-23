/**
 * Embedding_Generator（共有モジュール）
 *
 * Bedrock `amazon.titan-embed-text-v2:0` の呼び出しをカプセル化する唯一の経路。
 * Embedding_Batch_Job（バッチ）と Query_Embedding_Lambda（クエリ）の双方が本モジュールを
 * 共有するため、モデル ID・次元数・`normalize` 指定・f32 丸め・レート制御・バックオフの
 * 規則がバッチ側とクエリ側で食い違う経路が構造的に存在しない。
 *
 * 設計上の要点:
 * - **次元数はインスタンス生成時に 1 度だけ解決し、呼び出しごとの上書きを受け付けない。**
 *   1 回の実行内で全 SKU および両言語に同一の次元数が適用されることを型レベルで担保する（要件 3.3）
 * - **副作用（時計・乱数・Bedrock 呼び出し）はすべて注入可能**にしてある。仮想時計
 *   （`vi.useFakeTimers()`）と決定的な乱数源を差し込めば、待機時間とレート制御を
 *   ネットワークなしで検証できる（Property 11 / Property 12）
 * - レート制御は消費したトークンをちょうど 60,000 ms 後に返却するトークンバケットである。
 *   これにより **任意の連続 60 秒区間の呼び出し回数が設定値以下**という不変条件が
 *   バケット容量そのものから従う（Property 12）
 * - 再試行はスロットリングに限る。判定は `errors.ts` の `classifyError()` に委譲するため、
 *   `ValidationException` / `AccessDeniedException` 等が再試行される経路が存在しない（要件 4.7）
 * - 上限回数は呼び出し側が渡す（バッチ 5 回 / クエリ 3 回）。本モジュールは既定値を持たない
 * - **レイテンシ最適化推論のフォールバックはスロットリング再試行とは別系統である。**
 *   前者は「この経路自体が使えない」ことへの 1 回限りの切り替え、後者は「同じ経路をもう一度試す」
 *   ための反復であり、回数を共有しない（要件 10.13〜10.15）
 * - Bedrock が返した値は `Math.fround()` で f32 に丸める。丸め以外の桁数削減・切り捨ては
 *   行わない（要件 3.9 / 10.2）
 * - 失敗を例外で返さない。呼び出し側が「当該 SKU の当該言語を失敗として記録し、残りの処理を
 *   継続する」（要件 3.11 / 4.3 / 4.7）を素直に書けるよう、判別可能な結果オブジェクトを返す
 *
 * 要件: 3.1, 3.3, 3.7, 3.9, 3.11, 4.1, 4.2, 4.7, 10.1, 10.2, 10.13, 10.14, 10.15
 * 設計: Embedding_Generator（共有モジュール） / レイテンシ最適化推論のフォールバック（案 B）
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  type InvokeModelCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';

import { isBlankForEmbedding, truncateForEmbedding } from './embedding-text';
import { classifyError, toClientError, type VectorErrorResponse } from './errors';

// ============================================================
// モデルと次元数（要件 3.1 / 3.3）
// ============================================================

/** 埋め込みモデル ID（要件 3.1）。バッチ側とクエリ側で同一（要件 10.1） */
export const EMBEDDING_MODEL_ID = 'amazon.titan-embed-text-v2:0';

/** Titan Text Embeddings V2 が受け付ける次元数。値域の唯一の出典（要件 3.3） */
export const SUPPORTED_EMBEDDING_DIMENSIONS = [1024, 512, 256] as const;

/** 出力ベクトルの次元数。1024 / 512 / 256 の 3 値のみ */
export type EmbeddingDimensions = (typeof SUPPORTED_EMBEDDING_DIMENSIONS)[number];

/** 設定値が未指定の場合に使う次元数（要件 3.3） */
export const DEFAULT_EMBEDDING_DIMENSIONS: EmbeddingDimensions = 1024;

/** 次元数を上書きする環境変数名 */
export const EMBEDDING_DIMENSIONS_ENV = 'VECTOR_EMBEDDING_DIMENSIONS';

/** 呼び出しレートを上書きする環境変数名（要件 4.1） */
export const EMBEDDING_REQUESTS_PER_MINUTE_ENV = 'VECTOR_EMBEDDING_REQUESTS_PER_MINUTE';

// ============================================================
// レート制御（要件 4.1）
// ============================================================

/** 1 分あたりのリクエスト数の既定値（要件 4.1） */
export const DEFAULT_REQUESTS_PER_MINUTE = 120;

/** 1 分あたりのリクエスト数の下限（要件 4.1） */
export const MIN_REQUESTS_PER_MINUTE = 1;

/** 1 分あたりのリクエスト数の上限（要件 4.1） */
export const MAX_REQUESTS_PER_MINUTE = 600;

/** レート制御の窓幅（ms）。「1 分あたり」の 1 分にあたる */
export const RATE_LIMIT_WINDOW_MS = 60_000;

// ============================================================
// 指数バックオフ（要件 4.2）
// ============================================================

/**
 * 再試行回数ごとの基準待機時間（ms）。1、2、4、8、16 秒（要件 4.2）。
 * 添字 0 が 1 回目の再試行に対応する。
 */
export const BACKOFF_BASE_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

/** 基準待機時間の上限（ms）。基準列を使い切った以降はこの値で飽和する（要件 4.2） */
export const MAX_BACKOFF_DELAY_MS = 32_000;

/** 基準待機時間へ加えるランダムジッターの比率（±20%、要件 4.2） */
export const BACKOFF_JITTER_RATIO = 0.2;

/** Embedding_Batch_Job が渡す再試行上限回数（要件 3.11 / 4.2 / 4.3） */
export const BATCH_MAX_RETRIES = 5;

/** Query_Embedding_Lambda が渡す再試行上限回数（要件 10.8） */
export const QUERY_MAX_RETRIES = 3;

// ============================================================
// レイテンシ最適化推論のフォールバック（要件 10.1 / 10.13 / 10.14 / 10.15）
// ============================================================

/**
 * 実際に使用した推論経路（要件 10.1）。
 *
 * `latency_optimized` は `performanceConfigLatency: 'optimized'` を付けた呼び出しで成功したこと、
 * `standard` は当該指定を付けずに成功したことを意味する。`latencyOptimized: false` で
 * 呼ばれた場合（バッチ側）は段 1 に入らないため常に `standard` になる。
 */
export type InferencePath = 'latency_optimized' | 'standard';

/**
 * 「モデルまたはリージョンがレイテンシ最適化推論に未対応」を示すメッセージの手掛かり（要件 10.13）。
 *
 * 実測本文は
 * `Latency performance configuration is not supported for amazon.titan-embed-text-v2:0 in us-west-2`
 * である（V17 / A21）。**モデル ID とリージョン名を判定条件に入れない。**
 * 未対応のモデルとリージョンの組は AWS 側の対応状況で変わるため、特定の値を条件に埋め込むと
 * 別モデル・別リージョンへ移した瞬間にフォールバックが働かず、再び全リクエストが 400 になる。
 * 判定に使うのは `performanceConfigLatency` に相当する語と「未対応」を示す語の同時出現のみである。
 */
export const LATENCY_UNSUPPORTED_MESSAGE_MARKERS = [
  'latency performance configuration',
  'not supported',
] as const;

/**
 * フォールバック対象とみなす例外名（小文字化・名前空間接頭辞除去後）。
 *
 * 要件 10.13 / 10.14 が `ValidationException` に限定しているため、入力検証系の例外名だけを
 * 対象にする。`errors.ts` の `NAME_RULES` で `classifyBadRequest` に落ちる名前の集合と揃えてある。
 */
const VALIDATION_ERROR_NAMES: readonly string[] = [
  'validationexception',
  'validationerror',
  'invalidrequestexception',
  'invalidparametervalueexception',
];

/** プロパティを安全に読む。getter が例外を投げる値、Proxy、null でも失敗しない */
function readErrorProp(target: unknown, key: string): unknown {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) {
    return undefined;
  }
  try {
    return (target as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** 例外名を小文字で取り出す。`__type` の名前空間接頭辞（`...#Name`）は落とす */
function readErrorName(error: unknown): string {
  const candidates = [
    readErrorProp(error, 'name'),
    readErrorProp(error, '__type'),
    readErrorProp(error, 'code'),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const bare = candidate.includes('#')
      ? candidate.slice(candidate.lastIndexOf('#') + 1)
      : candidate;
    const normalized = bare.trim().toLowerCase();
    if (normalized.length > 0 && normalized !== 'error') return normalized;
  }
  return '';
}

/** メッセージを取り出す。文字列そのものも受け付ける */
function readErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  const candidates = [
    readErrorProp(error, 'message'),
    readErrorProp(error, 'Message'),
    readErrorProp(error, 'errorMessage'),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
  }
  return '';
}

/** HTTP ステータスを取り出す。`$metadata.httpStatusCode` を優先する */
function readErrorStatus(error: unknown): number | undefined {
  const candidates = [
    readErrorProp(readErrorProp(error, '$metadata'), 'httpStatusCode'),
    readErrorProp(error, 'statusCode'),
    readErrorProp(error, 'httpStatusCode'),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate)) return candidate;
  }
  return undefined;
}

/**
 * `ValidationException` 相当の失敗か判定する。
 *
 * 例外名が読めればその集合で判定する。名前が読めない場合（`new Error(...)` のみ、
 * 直列化を経て名前が落ちた場合など）に限り HTTP 400 を代替の手掛かりとして許す。
 * 名前が読めて集合に含まれない場合は偽にする（スロットリングや権限エラーが
 * たまたま同じ語を含んでもフォールバックへ流れないようにするため）。
 */
function isValidationLikeError(error: unknown): boolean {
  const name = readErrorName(error);
  if (name.length > 0) return VALIDATION_ERROR_NAMES.includes(name);
  return readErrorStatus(error) === 400;
}

/**
 * 「モデルまたはリージョンがレイテンシ最適化推論に未対応」を示すエラーか判定する（要件 10.13）。
 *
 * 条件は **`ValidationException` 相当であること** と **メッセージが
 * `latency performance configuration` と `not supported` を同時に含むこと**の連言である。
 * 入力本文の不正など、未対応を示さない `ValidationException` は偽になるため
 * フォールバックせず失敗として返る（要件 10.14）。
 *
 * 例外を投げない全域関数である。
 */
export function isLatencyOptimizationUnsupportedError(error: unknown): boolean {
  const message = readErrorMessage(error).toLowerCase();
  for (const marker of LATENCY_UNSUPPORTED_MESSAGE_MARKERS) {
    if (!message.includes(marker)) return false;
  }
  return isValidationLikeError(error);
}

// ============================================================
// 注入可能な副作用
// ============================================================

/**
 * 環境変数の読み取り元。テスト時は任意のレコードを渡せる。
 * `score-normalize.ts` の `EnvLike` と同じ規約に揃えてある。
 */
export type EnvLike = Record<string, string | undefined>;

/**
 * 時計。待機はすべてこの経路を通るため、仮想時計を差し込めば
 * 実時間を消費せずにレート制御とバックオフを検証できる。
 */
export interface EmbeddingClock {
  /** 現在時刻（ms）。単調増加であればエポック基準でなくてもよい */
  now(): number;
  /** 指定した ms だけ待つ。負値・非有限値は 0 として扱う */
  sleep(ms: number): Promise<void>;
}

/** 乱数源。ジッターの決定化のために注入する。値域は `Math.random()` と同じ `[0, 1)` */
export type RandomSource = () => number;

/** 実時間の時計。`vi.useFakeTimers()` 下では `Date.now` と `setTimeout` の両方が置き換わる */
export const systemClock: EmbeddingClock = {
  now: () => Date.now(),
  sleep: (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, Number.isFinite(ms) && ms > 0 ? ms : 0);
    }),
};

// ============================================================
// 設定値の解決（全域関数）
// ============================================================

/** 値が受理可能な次元数か判定する */
export function isEmbeddingDimensions(value: unknown): value is EmbeddingDimensions {
  return (
    typeof value === 'number' &&
    (SUPPORTED_EMBEDDING_DIMENSIONS as readonly number[]).includes(value)
  );
}

/** 数値または数値文字列を有限数へ変換する。変換できない場合は undefined */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 使用する次元数を解決する（要件 3.3）。
 *
 * 優先順は「明示指定 → 環境変数 `VECTOR_EMBEDDING_DIMENSIONS` → 既定値 1024」。
 * 1024 / 512 / 256 以外の値は採用せず、次の候補へ落ちる。全域関数であり例外を投げない
 * （Lambda の起動を設定ミスで止めないため）。
 */
export function resolveEmbeddingDimensions(
  value?: unknown,
  env: EnvLike = process.env
): EmbeddingDimensions {
  const explicit = toFiniteNumber(value);
  if (isEmbeddingDimensions(explicit)) return explicit;

  const configured = toFiniteNumber(env[EMBEDDING_DIMENSIONS_ENV]);
  if (isEmbeddingDimensions(configured)) return configured;

  return DEFAULT_EMBEDDING_DIMENSIONS;
}

/**
 * 使用する呼び出しレート（リクエスト/分）を解決する（要件 4.1）。
 *
 * 優先順は「明示指定（リクエストパラメータ） → 環境変数
 * `VECTOR_EMBEDDING_REQUESTS_PER_MINUTE` → 既定値 120」。
 * 採用した値は 1〜600 の整数へ丸める（範囲外は端へクランプする）。
 * クランプすることで、設定ミスによって 600 リクエスト/分を超える経路が存在しない。
 */
export function resolveRequestsPerMinute(value?: unknown, env: EnvLike = process.env): number {
  const explicit = toFiniteNumber(value);
  if (explicit !== undefined) return clampRequestsPerMinute(explicit);

  const configured = toFiniteNumber(env[EMBEDDING_REQUESTS_PER_MINUTE_ENV]);
  if (configured !== undefined) return clampRequestsPerMinute(configured);

  return DEFAULT_REQUESTS_PER_MINUTE;
}

/** 1〜600 の整数へ丸める。切り上げると上限超過が起きうるため切り捨て方向へ倒す */
function clampRequestsPerMinute(value: number): number {
  const truncated = Math.trunc(value);
  if (truncated < MIN_REQUESTS_PER_MINUTE) return MIN_REQUESTS_PER_MINUTE;
  if (truncated > MAX_REQUESTS_PER_MINUTE) return MAX_REQUESTS_PER_MINUTE;
  return truncated;
}

/** 再試行上限回数を 0 以上の整数へ正規化する。呼び出し側が渡す値の防御 */
export function normalizeMaxRetries(value: unknown): number {
  const parsed = toFiniteNumber(value);
  if (parsed === undefined) return 0;
  const truncated = Math.trunc(parsed);
  return truncated > 0 ? truncated : 0;
}

// ============================================================
// 指数バックオフ（純関数、Property 11）
// ============================================================

/**
 * 再試行回数に対応する基準待機時間（ms）を返す（要件 4.2）。
 *
 * `retryAttempt` は 1 起算。1 → 1,000 / 2 → 2,000 / 3 → 4,000 / 4 → 8,000 / 5 → 16,000、
 * 6 回目以降は上限 32,000 で飽和する。したがって基準値は `retryAttempt` について
 * 単調非減少であり、32,000 を超えない（Property 11）。
 *
 * 全域関数である。非整数・0 以下・非有限値は 1 回目として扱う。
 */
export function backoffBaseDelayMs(retryAttempt: unknown): number {
  const parsed = toFiniteNumber(retryAttempt);
  const attempt = parsed === undefined ? 1 : Math.max(1, Math.trunc(parsed));
  const base = BACKOFF_BASE_DELAYS_MS[attempt - 1] ?? MAX_BACKOFF_DELAY_MS;
  return Math.min(base, MAX_BACKOFF_DELAY_MS);
}

/**
 * ジッターを加えた実待機時間（ms）を返す（要件 4.2）。
 *
 * 基準値の 0.8 倍以上 1.2 倍以下に必ず収まる（Property 11）。乱数源が `[0, 1)` を
 * 外れた場合、および非数を返した場合も範囲内へ収める（ジッター実装の不備が
 * 待機時間の異常値として下位サービスへ波及しないようにする）。
 */
export function backoffDelayMs(retryAttempt: unknown, random: RandomSource = Math.random): number {
  const base = backoffBaseDelayMs(retryAttempt);

  let sample: number;
  try {
    sample = random();
  } catch {
    sample = 0.5;
  }
  if (!Number.isFinite(sample)) sample = 0.5;
  const bounded = Math.min(Math.max(sample, 0), 1);

  const factor = 1 + (bounded * 2 - 1) * BACKOFF_JITTER_RATIO;
  const lower = Math.ceil(base * (1 - BACKOFF_JITTER_RATIO));
  const upper = Math.floor(base * (1 + BACKOFF_JITTER_RATIO));

  return Math.min(Math.max(Math.round(base * factor), lower), upper);
}

// ============================================================
// f32 丸め（要件 3.9 / 10.2）
// ============================================================

/**
 * 各要素を 32bit 浮動小数へ丸める（要件 3.9 / 10.2）。
 *
 * `Math.fround()` のみを適用し、桁数の切り捨て・丸め込みは一切行わない。
 * `Math.fround()` は f32 で表現可能な値に対して恒等であるため、
 * 2 回適用しても値は変わらない（冪等。Property 8）。
 *
 * 全域関数である。配列以外は空配列を返し、数値以外の要素は `NaN` として保持する
 * （検証段階で次元数・要素値の不一致として検出できるようにするため、ここで捨てない）。
 */
export function roundToFloat32(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return values.map((value) => Math.fround(typeof value === 'number' ? value : Number.NaN));
}

// ============================================================
// トークンバケット（要件 4.1、Property 12）
// ============================================================

/**
 * Bedrock 呼び出しのレート制御。
 *
 * 容量 `requestsPerMinute` のトークンバケットで、消費したトークンは
 * **消費時刻から厳密に 60,000 ms 後**に返却される。ある呼び出しの時刻を t とすると、
 * その時点で `(t - 60,000, t]` に存在する消費済みトークンは容量未満であるから、
 * 任意の連続 60 秒区間に含まれる呼び出し回数は常に設定値以下になる（Property 12）。
 *
 * 待機は注入された時計経由でのみ行う。保持する状態は返却予定時刻の配列（最大 600 要素）で、
 * 消費時刻が単調非減少であるため常に昇順に並ぶ。
 */
export class EmbeddingRateLimiter {
  /** 適用中のレート（リクエスト/分）。1〜600 に収まる */
  readonly requestsPerMinute: number;

  private readonly clock: EmbeddingClock;

  /** 消費済みトークンの返却予定時刻（昇順） */
  private readonly refillAt: number[] = [];

  constructor(options: { requestsPerMinute?: number; clock?: EmbeddingClock } = {}) {
    this.requestsPerMinute = clampRequestsPerMinute(
      toFiniteNumber(options.requestsPerMinute) ?? DEFAULT_REQUESTS_PER_MINUTE
    );
    this.clock = options.clock ?? systemClock;
  }

  /** 現在保持している消費済みトークン数。テストと診断のために公開する */
  get inFlight(): number {
    return this.refillAt.length;
  }

  /**
   * トークンを 1 つ消費する。空きがなければ最も早い返却時刻まで待つ。
   * 戻り値は待機した合計 ms（待たなかった場合は 0）。
   */
  async acquire(): Promise<number> {
    let waitedMs = 0;

    for (;;) {
      const now = this.clock.now();

      // 返却時刻を過ぎたトークンを戻す（= 60 秒の窓から外れた呼び出しを忘れる）
      while (this.refillAt.length > 0 && this.refillAt[0] <= now) {
        this.refillAt.shift();
      }

      if (this.refillAt.length < this.requestsPerMinute) {
        this.refillAt.push(now + RATE_LIMIT_WINDOW_MS);
        return waitedMs;
      }

      const waitMs = Math.max(this.refillAt[0] - now, 0);
      await this.clock.sleep(waitMs);
      waitedMs += waitMs;

      // 時計が進まない実装を渡された場合に無限ループしないよう、1 つ強制的に返却する
      if (this.clock.now() <= now) {
        this.refillAt.shift();
      }
    }
  }
}

// ============================================================
// Bedrock 呼び出しの抽象（注入可能）
// ============================================================

/** 1 回の埋め込み生成要求。`normalize` は常に true のため引数に持たない */
export interface EmbeddingInvocation {
  readonly modelId: string;
  readonly dimensions: EmbeddingDimensions;
  /** 切り詰め済みの埋め込み対象テキスト */
  readonly text: string;
  /** レイテンシ最適化推論を使うか（要件 10.1。バッチ側は false） */
  readonly latencyOptimized: boolean;
}

/** Bedrock 応答から取り出した値 */
export interface EmbeddingInvocationResult {
  /** 丸め前の生ベクトル。f32 丸めは呼び出し側（本モジュール）が行う */
  readonly embedding: readonly unknown[];
  /** 入力トークン数（要件 3.8 のトークン数合計に使う）。応答に無ければ undefined */
  readonly inputTextTokenCount?: number;
}

/**
 * Bedrock 呼び出しの経路。AWS SDK への依存をこの 1 点に閉じる。
 * テストは実装を差し替えるだけでネットワークなしに検証できる。
 */
export interface EmbeddingTransport {
  invoke(invocation: EmbeddingInvocation): Promise<EmbeddingInvocationResult>;
}

/** `BedrockRuntimeClient` のうち本モジュールが使う部分だけを表す型 */
export interface BedrockRuntimeLike {
  send(command: InvokeModelCommand): Promise<InvokeModelCommandOutput>;
}

/**
 * Bedrock `InvokeModel` を使う既定の経路を作る（要件 3.1 / 3.3）。
 *
 * 要求本文は `inputText` / `dimensions` / `normalize: true` の 3 項目のみ。
 * `normalize` は Titan の既定値と同じだが、cosinesimil + faiss 側が取り込み時に
 * 単位長へ正規化することと基準を揃えるため明示指定する。
 *
 * クライアントは注入でき、未指定の場合のみ初回呼び出し時に生成する
 * （モジュール読み込み時に資格情報の解決を走らせないため）。
 */
export function createBedrockEmbeddingTransport(
  options: { client?: BedrockRuntimeLike; region?: string } = {}
): EmbeddingTransport {
  let client = options.client;

  return {
    async invoke(invocation: EmbeddingInvocation): Promise<EmbeddingInvocationResult> {
      client ??= new BedrockRuntimeClient({
        region: options.region ?? process.env.AWS_REGION,
      });

      const command = new InvokeModelCommand({
        modelId: invocation.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: new TextEncoder().encode(
          JSON.stringify({
            inputText: invocation.text,
            dimensions: invocation.dimensions,
            normalize: true,
          })
        ),
        ...(invocation.latencyOptimized ? { performanceConfigLatency: 'optimized' as const } : {}),
      });

      const output = await client.send(command);
      return parseEmbeddingResponseBody(output.body);
    },
  };
}

/** `InvokeModel` の応答本文から埋め込みを取り出す。形式不正は例外にする（分類は呼び出し側） */
function parseEmbeddingResponseBody(body: unknown): EmbeddingInvocationResult {
  if (!(body instanceof Uint8Array)) {
    throw new Error('Bedrock InvokeModel response body is missing.');
  }

  const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Bedrock InvokeModel response body is not a JSON object.');
  }

  const record = parsed as Record<string, unknown>;
  const embedding = record.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error('Bedrock InvokeModel response has no embedding array.');
  }

  const tokenCount = record.inputTextTokenCount;
  return {
    embedding,
    inputTextTokenCount: typeof tokenCount === 'number' ? tokenCount : undefined,
  };
}

// ============================================================
// 生成結果（例外を投げずに返す）
// ============================================================

/** 成功・失敗のいずれでも返る計測値。要件 3.7 / 3.8 の集計に使う */
export interface EmbeddingGenerationMetrics {
  /** Bedrock を呼んだ回数（再試行を含む）。呼ばずに終わった場合は 0（要件 3.8） */
  readonly calls: number;
  /** 再試行した回数。上限に達した失敗では上限値と等しい */
  readonly retries: number;
  /** 50,000 文字超過による切り詰めが発生したか（要件 3.7） */
  readonly truncated: boolean;
  /** 切り詰め前のテキスト長（UTF-16 コード単位） */
  readonly originalTextLength: number;
  /** Bedrock へ渡したテキスト長（UTF-16 コード単位） */
  readonly appliedTextLength: number;
  /** 本関数の開始から終了までの経過 ms（待機時間を含む。要件 10.8 の経過時間） */
  readonly elapsedMs: number;
  /** Bedrock 呼び出しそのものに費やした ms の合計（要件 10.5 の参考値） */
  readonly invocationMs: number;
  /** レート制御による待機 ms の合計 */
  readonly rateLimitWaitMs: number;
  /** 指数バックオフによる待機 ms の合計 */
  readonly backoffWaitMs: number;
  /**
   * 実際に使用した推論経路（要件 10.1）。呼び出し側はこの値をそのまま応答へ載せる。
   * `latencyOptimized: false` の呼び出しでは常に `standard`。
   */
  readonly inferencePath: InferencePath;
  /**
   * レイテンシ最適化推論から標準推論へのフォールバックが発生したか（要件 10.15）。
   * **1 回の `generate()` につき最大 1 回**であり、`retries`（スロットリング再試行の回数）とは
   * 独立に数える。`inferencePath === 'standard'` かつ `latencyOptimized: true` と同値になる。
   */
  readonly latencyFallbackUsed: boolean;
}

/** 生成成功。ベクトルは f32 丸め済み */
export interface EmbeddingGenerationSuccess extends EmbeddingGenerationMetrics {
  readonly ok: true;
  /** f32 に丸めた埋め込みベクトル（要件 3.9 / 10.2） */
  readonly embedding: number[];
  /** 生成に使った次元数。`embedding.length` と一致する */
  readonly dimensions: EmbeddingDimensions;
  /** 生成に使ったモデル ID。スキップ判定（要件 4.5）の比較対象 */
  readonly model: string;
  /** 入力トークン数（要件 3.8）。応答に無ければ undefined */
  readonly inputTextTokenCount?: number;
}

/** 生成失敗。呼び出し側は記録して次の (itemId, language) へ進む（要件 3.11 / 4.3 / 4.7） */
export interface EmbeddingGenerationFailure extends EmbeddingGenerationMetrics {
  readonly ok: false;
  /** サニタイズ済みのエラー応答（`errors.ts` の唯一の経路を通した値） */
  readonly error: VectorErrorResponse;
  /** スロットリングの再試行上限に達したことによる失敗か（要件 3.11 / 10.8） */
  readonly throttlingExhausted: boolean;
  /** 再試行の余地があるか。`error.retryable` と同値で、呼び出し側の分岐用に複製する */
  readonly retryable: boolean;
}

export type EmbeddingGenerationResult = EmbeddingGenerationSuccess | EmbeddingGenerationFailure;

/** `EmbeddingGenerator.generate()` の引数 */
export interface GenerateEmbeddingParams {
  /** 埋め込み対象テキスト。50,000 文字超過は本関数内で切り詰める（要件 3.7） */
  readonly text: unknown;
  /**
   * スロットリング時の再試行上限回数（要件 3.11 / 4.2 / 10.8）。
   * バッチは `BATCH_MAX_RETRIES`（5）、クエリは `QUERY_MAX_RETRIES`（3）を渡す。
   * 本モジュールは既定値を持たない（上限を暗黙に決めないため）。
   */
  readonly maxRetries: number;
}

// ============================================================
// Embedding_Generator
// ============================================================

/** `EmbeddingGenerator` の生成オプション。すべて省略可 */
export interface EmbeddingGeneratorOptions {
  /** 次元数（要件 3.3）。省略時は環境変数 → 既定 1024 の順に解決する */
  readonly dimensions?: unknown;
  /** 呼び出しレート（要件 4.1）。省略時は環境変数 → 既定 120 の順に解決する */
  readonly requestsPerMinute?: unknown;
  /**
   * レイテンシ最適化推論を試すか（要件 10.1）。クエリ側のみ true。
   * true の場合、未対応を示すエラーに限り標準推論へ 1 回だけフォールバックする（要件 10.13）。
   * false の場合は `performanceConfigLatency` を送らず、`inferencePath` は常に `standard`。
   */
  readonly latencyOptimized?: boolean;
  /** Bedrock 呼び出しの経路。省略時は `createBedrockEmbeddingTransport()` */
  readonly transport?: EmbeddingTransport;
  /** レート制御。省略時は解決したレートで新規生成する */
  readonly rateLimiter?: EmbeddingRateLimiter;
  /** 時計。省略時は実時間 */
  readonly clock?: EmbeddingClock;
  /** ジッターの乱数源。省略時は `Math.random` */
  readonly random?: RandomSource;
  /** 環境変数の読み取り元 */
  readonly env?: EnvLike;
}

/**
 * Bedrock 埋め込み生成のカプセル化（要件 3.1 / 3.3 / 3.7 / 3.9 / 3.11 / 4.1 / 4.2 / 4.7 / 10.2）。
 *
 * 1 インスタンスが 1 回の実行に対応する。次元数・モデル ID・レートはインスタンス生成時に
 * 確定し、以後変更できない。したがって同一インスタンスで生成したベクトルは、全 SKU および
 * 両言語で同一の次元数を持つ（要件 3.3）。
 *
 * 言語別の分岐を一切持たない。日本語ベクトルは Embedding_Text_JA、英語ベクトルは
 * Embedding_Text_EN を `generate()` へ渡すだけであり、片方の言語だけ別の設定で
 * 生成される経路が存在しない（要件 3.2）。
 */
export class EmbeddingGenerator {
  /** 使用するモデル ID（要件 3.1） */
  readonly model: string = EMBEDDING_MODEL_ID;

  /** 使用する次元数。実行中は不変（要件 3.3） */
  readonly dimensions: EmbeddingDimensions;

  /** 適用中の呼び出しレート（リクエスト/分、要件 4.1） */
  readonly requestsPerMinute: number;

  /** レイテンシ最適化推論を使うか（要件 10.1） */
  readonly latencyOptimized: boolean;

  private readonly transport: EmbeddingTransport;
  private readonly rateLimiter: EmbeddingRateLimiter;
  private readonly clock: EmbeddingClock;
  private readonly random: RandomSource;

  constructor(options: EmbeddingGeneratorOptions = {}) {
    const env = options.env ?? process.env;

    this.dimensions = resolveEmbeddingDimensions(options.dimensions, env);
    this.latencyOptimized = options.latencyOptimized === true;
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? Math.random;
    this.transport = options.transport ?? createBedrockEmbeddingTransport();

    this.rateLimiter =
      options.rateLimiter ??
      new EmbeddingRateLimiter({
        requestsPerMinute: resolveRequestsPerMinute(options.requestsPerMinute, env),
        clock: this.clock,
      });
    this.requestsPerMinute = this.rateLimiter.requestsPerMinute;
  }

  /**
   * 埋め込みベクトルを 1 本生成する。
   *
   * 手順は「切り詰め（要件 3.7）→ レート制御（要件 4.1）→ Bedrock 呼び出し（要件 3.1）→
   * f32 丸め（要件 3.9）」。スロットリングのみ指数バックオフで再試行し（要件 4.2）、
   * それ以外のエラーは再試行しない（要件 4.7）。いずれの失敗でも例外を投げず、
   * 判別可能な結果を返す。
   *
   * `latencyOptimized: true` の場合に限り、モデルまたはリージョンの未対応を示すエラーに対して
   * 標準推論へ **1 回だけ** フォールバックする（要件 10.13〜10.15）。フォールバックは
   * スロットリング再試行とは別系統であり、`retries` を消費しない。使用した経路は
   * `inferencePath` として返る（要件 10.1）。
   */
  async generate(params: GenerateEmbeddingParams): Promise<EmbeddingGenerationResult> {
    const startedAt = this.clock.now();
    const maxRetries = normalizeMaxRetries(params.maxRetries);

    // 要件 3.7: 50,000 文字超過は切り詰めて処理を継続する
    const truncation = truncateForEmbedding(params.text);

    const state = {
      calls: 0,
      retries: 0,
      invocationMs: 0,
      rateLimitWaitMs: 0,
      backoffWaitMs: 0,
      /**
       * レイテンシ最適化推論から標準推論へ切り替えたか（要件 10.15）。
       * 一度 true になったら二度と段 2 へ入らないため、フォールバックは最大 1 回である。
       * `retries` とは独立した変数であり、どちらの増加も他方に影響しない（別系統）。
       */
      latencyFallbackUsed: false,
    };

    const metrics = (): EmbeddingGenerationMetrics => ({
      calls: state.calls,
      retries: state.retries,
      truncated: truncation.truncated,
      originalTextLength: truncation.originalLength,
      appliedTextLength: truncation.appliedLength,
      elapsedMs: Math.max(this.clock.now() - startedAt, 0),
      invocationMs: state.invocationMs,
      rateLimitWaitMs: state.rateLimitWaitMs,
      backoffWaitMs: state.backoffWaitMs,
      inferencePath:
        this.latencyOptimized && !state.latencyFallbackUsed ? 'latency_optimized' : 'standard',
      latencyFallbackUsed: state.latencyFallbackUsed,
    });

    // 空文字・空白のみは Bedrock を呼ばずに入力エラーにする（無駄な ValidationException を作らない）
    if (isBlankForEmbedding(truncation.text)) {
      return this.failure(
        toClientError('INVALID_QUERY', 'EMBEDDING', {
          detail: '埋め込み対象テキストが空、または空白文字のみです。',
        }),
        false,
        metrics()
      );
    }

    /**
     * 段 1 の要求。フォールバック時は `latencyOptimized` のみを false へ差し替える
     * （要件 10.13 が求める「同一のモデル・同一の次元数・同一の入力本文」を、
     * 他の項目を触らないことで構造的に保証する）。
     */
    let invocation: EmbeddingInvocation = {
      modelId: this.model,
      dimensions: this.dimensions,
      text: truncation.text,
      latencyOptimized: this.latencyOptimized,
    };

    for (;;) {
      state.rateLimitWaitMs += await this.rateLimiter.acquire();

      const invokedAt = this.clock.now();
      try {
        const raw = await this.transport.invoke(invocation);
        state.calls += 1;
        state.invocationMs += Math.max(this.clock.now() - invokedAt, 0);

        const embedding = roundToFloat32(raw.embedding);

        if (embedding.length !== this.dimensions) {
          return this.failure(
            toClientError('DIMENSION_MISMATCH', 'EMBEDDING', {
              detail: `要求した次元数: ${this.dimensions}、応答の次元数: ${embedding.length}。`,
            }),
            false,
            metrics()
          );
        }

        if (embedding.some((value) => !Number.isFinite(value))) {
          return this.failure(
            toClientError('INTERNAL_ERROR', 'EMBEDDING', {
              detail: '埋め込みベクトルに数値でない要素が含まれています。',
            }),
            false,
            metrics()
          );
        }

        return {
          ok: true,
          embedding,
          dimensions: this.dimensions,
          model: this.model,
          inputTextTokenCount: raw.inputTextTokenCount,
          ...metrics(),
        };
      } catch (error: unknown) {
        state.calls += 1;
        state.invocationMs += Math.max(this.clock.now() - invokedAt, 0);

        // ------------------------------------------------------------
        // 別系統 (1): レイテンシ最適化推論の未対応によるフォールバック（要件 10.13〜10.15）
        //
        // **スロットリング再試行ではない。**「同じ経路をもう一度試す」再試行と異なり、
        // これは「この経路自体が当該モデル / 当該リージョンで使えない」ことへの経路変更である。
        // したがって `state.retries` を増やさず、バックオフ待機も行わない。結果として
        // フォールバックの 1 回は再試行上限（バッチ 5 / クエリ 3）を 1 つも消費しない（要件 10.15）。
        //
        // 条件に `!state.latencyFallbackUsed` を含めるため、段 2 の標準推論が同じエラーを
        // 返しても二度目のフォールバックは起きない（フォールバックは 1 要求につき最大 1 回）。
        // ------------------------------------------------------------
        if (
          invocation.latencyOptimized &&
          !state.latencyFallbackUsed &&
          isLatencyOptimizationUnsupportedError(error)
        ) {
          state.latencyFallbackUsed = true;
          // 差し替えるのは `latencyOptimized` のみ。モデル・次元数・入力本文は初回と同一
          invocation = { ...invocation, latencyOptimized: false };
          continue;
        }

        const classified = classifyError(error, 'EMBEDDING');

        // ------------------------------------------------------------
        // 別系統 (2): スロットリング再試行（要件 3.11 / 4.7 / 10.8）
        // ------------------------------------------------------------

        // 要件 4.7 / 10.14: スロットリング以外は再試行しない。
        // 未対応を示さない `ValidationException`（入力本文の不正など）は上の分岐に入らないため、
        // フォールバックも再試行もせずここで失敗として返る。
        if (classified.errorCode !== 'THROTTLED') {
          return this.failure(classified, false, metrics());
        }

        // 要件 3.11 / 4.3 / 10.8: 上限到達で失敗として記録し、呼び出し側が処理を継続する
        if (state.retries >= maxRetries) {
          return this.failure(classified, true, metrics());
        }

        state.retries += 1;
        const delayMs = backoffDelayMs(state.retries, this.random);
        await this.clock.sleep(delayMs);
        state.backoffWaitMs += delayMs;
      }
    }
  }

  private failure(
    error: VectorErrorResponse,
    throttlingExhausted: boolean,
    metrics: EmbeddingGenerationMetrics
  ): EmbeddingGenerationFailure {
    return {
      ok: false,
      error,
      throttlingExhausted,
      retryable: error.retryable,
      ...metrics,
    };
  }
}

/**
 * `EmbeddingGenerator` を生成する（コンストラクタの薄い別名）。
 * Lambda ハンドラ側で `new` を書かずに済むようにするためだけの入口。
 */
export function createEmbeddingGenerator(
  options: EmbeddingGeneratorOptions = {}
): EmbeddingGenerator {
  return new EmbeddingGenerator(options);
}
