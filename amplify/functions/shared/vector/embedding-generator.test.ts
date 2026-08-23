/**
 * `embedding-generator.ts` の property テスト（task 3.12）
 *
 * 検証対象は Correctness Property 11 / 12 と、Property 8 のうち f32 丸めの冪等性の部分。
 *
 * Bedrock は一切呼ばない。`EmbeddingTransport` を差し替えるだけで全経路が閉じるため、
 * `@aws-sdk/client-bedrock-runtime` のモックも不要（`createBedrockEmbeddingTransport()` を
 * 呼ばない限り SDK クライアントは生成されない）。
 *
 * 時計の扱いは 2 通りを意図的に使い分ける。
 * - **決定的な仮想時計（`createVirtualClock`）**: バックオフ量とレート制御の代数的な不変条件を
 *   検証する主経路。`sleep()` が同期的に時刻を進めるだけなので、100 回反復 × 数十回の待機を
 *   マイクロタスクの解決順に依存せず検証できる。待機列をそのまま観測できる点も
 *   `vi.useFakeTimers()` より扱いやすい。
 * - **`vi.useFakeTimers()`**: 既定の `systemClock` 経路そのもの（`Date.now()` と `setTimeout()`）を
 *   検証する単体テスト側で使う。仮想時計を注入したテストだけでは「本番で使う既定の時計が
 *   本当にタイマー経由で待つか」が未検証のまま残るため、両方を置く。
 *
 * 要件: 3.9, 3.11, 4.1, 4.2, 10.8
 * Property: 8, 11, 12
 */

import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BACKOFF_JITTER_RATIO,
  BATCH_MAX_RETRIES,
  EmbeddingGenerator,
  EmbeddingRateLimiter,
  MAX_BACKOFF_DELAY_MS,
  QUERY_MAX_RETRIES,
  RATE_LIMIT_WINDOW_MS,
  SUPPORTED_EMBEDDING_DIMENSIONS,
  backoffBaseDelayMs,
  backoffDelayMs,
  roundToFloat32,
  systemClock,
  type EmbeddingClock,
  type EmbeddingDimensions,
  type EmbeddingTransport,
} from './embedding-generator';

// ============================================================
// 期待値の定義（実装の定数を写さず、設計書から書き下す）
// ============================================================

/**
 * 設計書が定める基準待機時間（要件 4.2 の「1、2、4、8、16 秒」）。
 * 実装の `BACKOFF_BASE_DELAYS_MS` とは独立にここへ置き、両者の一致自体を検証する。
 */
const DESIGN_BASE_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

/** 設計書が定める基準待機時間の上限（要件 4.2 の「32 秒を超えない」） */
const DESIGN_MAX_BASE_DELAY_MS = 32_000;

/** 設計書が定めるジッター幅（要件 4.2 の「±20%」） */
const DESIGN_JITTER_RATIO = 0.2;

/** 設計書が定めるレート制御の窓幅（要件 4.1 の「1 分あたり」） */
const DESIGN_WINDOW_MS = 60_000;

// ============================================================
// 仮想時計
// ============================================================

interface VirtualClock extends EmbeddingClock {
  /** 現在の仮想時刻（ms） */
  readonly nowMs: number;
  /** `sleep()` に渡された待機量の列（呼び出し順） */
  readonly sleeps: readonly number[];
  /** 仮想時刻を任意に進める（Bedrock 呼び出しの所要時間を模す） */
  advance(ms: number): void;
}

/**
 * 決定的な仮想時計。`sleep()` は待機量ぶん時刻を進めるだけで、実タイマーを使わない。
 * 開始時刻を 0 以外にできるようにしてあるのは、レート制御が経過時間の差分のみに依存し、
 * エポック基準の絶対時刻に依存しないことを反例探索に含めるため。
 */
function createVirtualClock(startMs = 0): VirtualClock {
  let current = startMs;
  const sleeps: number[] = [];

  return {
    now: () => current,
    sleep: (ms: number) => {
      const applied = Number.isFinite(ms) && ms > 0 ? ms : 0;
      sleeps.push(applied);
      current += applied;
      return Promise.resolve();
    },
    advance(ms: number) {
      current += ms;
    },
    get nowMs() {
      return current;
    },
    get sleeps() {
      return sleeps;
    },
  };
}

// ============================================================
// Bedrock 呼び出しのスタブ
// ============================================================

/** スロットリング例外。`classifyError()` が `THROTTLED` と分類する形（要件 4.7） */
function throttlingError(): Error {
  return Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
}

/** 指定次元数の有効なベクトルを返すスタブ。呼び出し時刻を記録する */
function createRecordingTransport(options: {
  clock: VirtualClock;
  dimensions: number;
  /** 1 回の呼び出しで仮想時刻を進める量（Bedrock のレイテンシ相当） */
  latencyMs?: number;
  /** 呼び出し時刻の記録先 */
  invokedAtMs: number[];
}): EmbeddingTransport {
  const embedding = Array.from({ length: options.dimensions }, (_, index) =>
    Math.fround(index / options.dimensions)
  );

  return {
    invoke: () => {
      options.invokedAtMs.push(options.clock.nowMs);
      if (options.latencyMs !== undefined && options.latencyMs > 0) {
        options.clock.advance(options.latencyMs);
      }
      return Promise.resolve({ embedding, inputTextTokenCount: 8 });
    },
  };
}

/** 常にスロットリングで失敗するスタブ */
function createAlwaysThrottledTransport(): EmbeddingTransport {
  return {
    invoke: () => Promise.reject(throttlingError()),
  };
}

/**
 * 任意の連続 `windowMs` 区間に含まれる呼び出し回数の最大値を返す。
 *
 * 区間は半開 `[s, s + windowMs)` として数える。トークンは消費時刻からちょうど
 * `windowMs` 後に返却されるため、`t` の呼び出しと `t + windowMs` の呼び出しは
 * 同一の 60 秒区間に属さない（閉区間で数えると設定値 + 1 になり、設計の意図と食い違う）。
 *
 * 最大値をとる区間は必ずいずれかの呼び出し時刻から始まるので、各呼び出し時刻を
 * 始点とする区間だけを調べれば十分である。
 */
function maxCallsInAnyWindow(timestamps: readonly number[], windowMs: number): number {
  let max = 0;
  for (const start of timestamps) {
    const count = timestamps.filter((t) => t >= start && t < start + windowMs).length;
    if (count > max) max = count;
  }
  return max;
}

/** レート値の生成器。待機が発生する小さい値を重めに引く */
const requestsPerMinuteArb = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 8 }) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 600 }) }
);

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================
// Property 11
// ============================================================

describe('指数バックオフ（Property 11）', () => {
  // Feature: vector-search-comparison, Property 11: 任意の試行回数（1 以上、上限回数以下）と
  // 任意の乱数に対して、算出される待機時間は基準値（1, 2, 4, 8, 16 秒）の 0.8 倍以上
  // 1.2 倍以下であり、基準値は試行回数について単調非減少で 32 秒を超えず、再試行回数は
  // 指定された上限（バッチは 5、クエリは 3）を超えない。
  it('待機時間が基準値の ±20% に収まり、基準値は単調非減少で 32 秒以下、再試行回数は上限を超えない', async () => {
    // 前提: 実装の定数が設計書の値と一致する
    expect(BACKOFF_JITTER_RATIO).toBe(DESIGN_JITTER_RATIO);
    expect(MAX_BACKOFF_DELAY_MS).toBe(DESIGN_MAX_BASE_DELAY_MS);
    expect(BATCH_MAX_RETRIES).toBe(5);
    expect(QUERY_MAX_RETRIES).toBe(3);
    DESIGN_BASE_DELAYS_MS.forEach((expected, index) => {
      expect(backoffBaseDelayMs(index + 1)).toBe(expected);
    });

    // (a) 範囲: 任意の試行回数・任意の乱数（範囲外や NaN を含む）に対して基準値の 0.8〜1.2 倍
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }),
        fc.double({ min: -2, max: 3 }),
        (attempt, sample) => {
          const base = backoffBaseDelayMs(attempt);
          const delay = backoffDelayMs(attempt, () => sample);

          expect(delay).toBeGreaterThanOrEqual(base * (1 - DESIGN_JITTER_RATIO));
          expect(delay).toBeLessThanOrEqual(base * (1 + DESIGN_JITTER_RATIO));
          expect(delay).toBeLessThanOrEqual(
            DESIGN_MAX_BASE_DELAY_MS * (1 + DESIGN_JITTER_RATIO)
          );
        }
      ),
      { numRuns: 100 }
    );

    // (b) 単調非減少と 32 秒の上限
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 64 }), (attempt) => {
        const base = backoffBaseDelayMs(attempt);
        const next = backoffBaseDelayMs(attempt + 1);

        expect(base).toBeLessThanOrEqual(next);
        expect(base).toBeLessThanOrEqual(DESIGN_MAX_BASE_DELAY_MS);
        expect(next).toBeLessThanOrEqual(DESIGN_MAX_BASE_DELAY_MS);
      }),
      { numRuns: 100 }
    );

    // (c) 再試行回数の上限: 常にスロットリングされても再試行は maxRetries 回で止まり、
    //     実際に待った量は各回のジッター範囲に収まる（仮想時計で観測する）
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constantFrom(QUERY_MAX_RETRIES, BATCH_MAX_RETRIES),
          fc.integer({ min: 0, max: 8 })
        ),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 1_000_000 }),
        async (maxRetries, sample, startMs) => {
          const clock = createVirtualClock(startMs);
          const generator = new EmbeddingGenerator({
            dimensions: 1024,
            // レート制御の待機を混ぜないよう、上限レートで待機ゼロにする
            requestsPerMinute: 600,
            transport: createAlwaysThrottledTransport(),
            clock,
            random: () => sample,
            env: {},
          });

          const result = await generator.generate({ text: 'コーヒー豆', maxRetries });

          expect(result.ok).toBe(false);
          if (result.ok) return;

          expect(result.error.errorCode).toBe('THROTTLED');
          expect(result.throttlingExhausted).toBe(true);
          // 再試行回数は指定上限を超えず、ちょうど上限で打ち切られる
          expect(result.retries).toBe(maxRetries);
          expect(result.retries).toBeLessThanOrEqual(maxRetries);
          // 呼び出し回数 = 初回 1 回 + 再試行回数
          expect(result.calls).toBe(maxRetries + 1);

          // 待機は再試行 1 回につき 1 回だけ、各回が当該試行の基準値の ±20% に収まる
          expect(clock.sleeps).toHaveLength(maxRetries);
          clock.sleeps.forEach((slept, index) => {
            const base = backoffBaseDelayMs(index + 1);
            expect(slept).toBeGreaterThanOrEqual(base * (1 - DESIGN_JITTER_RATIO));
            expect(slept).toBeLessThanOrEqual(base * (1 + DESIGN_JITTER_RATIO));
          });

          const totalSlept = clock.sleeps.reduce((sum, slept) => sum + slept, 0);
          expect(result.backoffWaitMs).toBe(totalSlept);
          expect(result.rateLimitWaitMs).toBe(0);
          expect(result.elapsedMs).toBe(totalSlept);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ============================================================
// Property 12
// ============================================================

describe('呼び出しレートの上限（Property 12）', () => {
  // Feature: vector-search-comparison, Property 12: 任意のレート設定値（1〜600 リクエスト/分）と
  // 任意の処理件数に対して、1 回の起動内の任意の連続 60 秒区間に発生した Bedrock 呼び出し回数は
  // 設定値以下である。
  it('任意の連続 60 秒区間の Bedrock 呼び出し回数が設定値以下になる', async () => {
    // 前提: 実装の窓幅が設計書の 1 分と一致する
    expect(RATE_LIMIT_WINDOW_MS).toBe(DESIGN_WINDOW_MS);

    await fc.assert(
      fc.asyncProperty(
        requestsPerMinuteArb,
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 0, max: 5_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        async (requestsPerMinute, callCount, latencyMs, startMs) => {
          const clock = createVirtualClock(startMs);
          const invokedAtMs: number[] = [];
          const generator = new EmbeddingGenerator({
            dimensions: 256,
            requestsPerMinute,
            transport: createRecordingTransport({
              clock,
              dimensions: 256,
              latencyMs,
              invokedAtMs,
            }),
            clock,
            random: () => 0.5,
            env: {},
          });

          expect(generator.requestsPerMinute).toBe(requestsPerMinute);

          for (let i = 0; i < callCount; i += 1) {
            const result = await generator.generate({
              text: `コーヒー豆 ${i}`,
              maxRetries: BATCH_MAX_RETRIES,
            });
            expect(result.ok).toBe(true);
          }

          // 非自明性: 要求した件数はすべて実際に呼ばれている（呼ばないことで上限を守っていない）
          expect(invokedAtMs).toHaveLength(callCount);

          // 本題: 任意の連続 60 秒区間の呼び出し回数が設定値以下
          expect(maxCallsInAnyWindow(invokedAtMs, DESIGN_WINDOW_MS)).toBeLessThanOrEqual(
            requestsPerMinute
          );

          // 呼び出し時刻は単調非減少（窓の走査が始点のみで十分であることの前提）
          for (let i = 1; i < invokedAtMs.length; i += 1) {
            expect(invokedAtMs[i]).toBeGreaterThanOrEqual(invokedAtMs[i - 1]);
          }

          // 設定値以下の件数しか処理しない場合は待機が発生しない（過剰な待機をしていない）
          if (callCount <= requestsPerMinute) {
            expect(clock.sleeps).toHaveLength(0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ============================================================
// Property 8（f32 丸めの部分）
// ============================================================

describe('f32 丸めの冪等性（Property 8 の一部）', () => {
  // Feature: vector-search-comparison, Property 8: 任意の浮動小数配列と任意の言語に対して、
  // Embedding_Batch_Job を通した後の Vector_Table 側の保存値と Vector_Collection 側の保存値は、
  // 次元数が一致し全要素が要素単位で等しい。f32 への丸めは冪等である
  // （2 回適用しても値が変わらない）。
  //
  // 本テストは後段（両バックエンド一致）の前提となる「f32 丸めの冪等性」を単体で固める。
  it('f32 丸めが冪等で、次元数を保ち、Float32Array と同じ値になる', async () => {
    // (a) 任意の浮動小数配列（NaN・±Infinity・±0 を含む）に対する冪等性と次元数の保存
    fc.assert(
      fc.property(fc.array(fc.double(), { maxLength: 64 }), (values) => {
        const once = roundToFloat32(values);
        const twice = roundToFloat32(once);

        // 次元数が保たれる
        expect(once).toHaveLength(values.length);
        expect(twice).toHaveLength(values.length);

        // 独立モデル: Float32Array へ格納して読み戻した値と要素単位で一致する
        const viaTypedArray = new Float32Array(values.length);
        values.forEach((value, index) => {
          viaTypedArray[index] = value;
        });

        for (let i = 0; i < once.length; i += 1) {
          // 冪等（NaN と -0 を区別するため Object.is で比較する）
          expect(Object.is(twice[i], once[i])).toBe(true);
          // f32 で表現可能な値になっている
          expect(Object.is(Math.fround(once[i]), once[i])).toBe(true);
          expect(Object.is(once[i], viaTypedArray[i])).toBe(true);
        }
      }),
      { numRuns: 100 }
    );

    // (b) 生成経路: Bedrock 応答の生ベクトルを通した保存値も丸めの結果と一致し、再丸めで変わらない
    await fc.assert(
      fc.asyncProperty(
        fc
          .constantFrom<EmbeddingDimensions>(...SUPPORTED_EMBEDDING_DIMENSIONS)
          .chain((dimensions) =>
            fc.tuple(
              fc.constant(dimensions),
              fc.array(fc.double({ min: -1, max: 1, noNaN: true }), {
                minLength: dimensions,
                maxLength: dimensions,
              })
            )
          ),
        async ([dimensions, raw]) => {
          const clock = createVirtualClock();
          const generator = new EmbeddingGenerator({
            dimensions,
            requestsPerMinute: 600,
            transport: { invoke: () => Promise.resolve({ embedding: raw }) },
            clock,
            random: () => 0.5,
            env: {},
          });

          const result = await generator.generate({
            text: 'コーヒー豆',
            maxRetries: BATCH_MAX_RETRIES,
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          expect(result.dimensions).toBe(dimensions);
          expect(result.embedding).toHaveLength(dimensions);

          const expected = roundToFloat32(raw);
          for (let i = 0; i < dimensions; i += 1) {
            expect(Object.is(result.embedding[i], expected[i])).toBe(true);
            expect(Object.is(Math.fround(result.embedding[i]), result.embedding[i])).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('配列以外と数値以外の要素でも例外を投げない（全域性）', () => {
    expect(roundToFloat32(undefined)).toEqual([]);
    expect(roundToFloat32(null)).toEqual([]);
    expect(roundToFloat32('0.5')).toEqual([]);
    expect(roundToFloat32({ 0: 0.5, length: 1 })).toEqual([]);

    const rounded = roundToFloat32([0.5, 'x', null, undefined, {}]);
    expect(rounded).toHaveLength(5);
    expect(rounded[0]).toBe(0.5);
    rounded.slice(1).forEach((value) => {
      expect(Number.isNaN(value)).toBe(true);
    });
  });
});

// ============================================================
// 既定の時計（`systemClock`）の経路 — `vi.useFakeTimers()` で検証する
// ============================================================

describe('systemClock（vi.useFakeTimers）', () => {
  it('sleep がタイマー経由で待つ（指定時間より前には解決しない）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    let resolved = false;
    const pending = systemClock.sleep(1_000).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(resolved).toBe(true);
    expect(systemClock.now()).toBe(1_000);
  });

  it('負値・非有限値の待機は 0 ms として扱う', async () => {
    vi.useFakeTimers();

    for (const ms of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      let resolved = false;
      const pending = systemClock.sleep(ms).then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      await pending;
      expect(resolved).toBe(true);
    }
  });

  it('レート制御が既定の時計でちょうど 60 秒待つ', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const limiter = new EmbeddingRateLimiter({ requestsPerMinute: 2 });
    expect(await limiter.acquire()).toBe(0);
    expect(await limiter.acquire()).toBe(0);
    expect(limiter.inFlight).toBe(2);

    let settled = false;
    const third = limiter.acquire().then((waited) => {
      settled = true;
      return waited;
    });

    await vi.advanceTimersByTimeAsync(RATE_LIMIT_WINDOW_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await third).toBe(RATE_LIMIT_WINDOW_MS);
    expect(Date.now()).toBe(RATE_LIMIT_WINDOW_MS);
  });

  it('バックオフの待機が既定の時計のタイマー経由で行われる', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    let attempts = 0;
    const transport: EmbeddingTransport = {
      invoke: () => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(throttlingError());
        return Promise.resolve({
          embedding: Array.from({ length: 256 }, () => 0.25),
          inputTextTokenCount: 4,
        });
      },
    };

    const generator = new EmbeddingGenerator({
      dimensions: 256,
      requestsPerMinute: 600,
      transport,
      // clock を渡さない = 既定の systemClock（Date.now + setTimeout）を使う経路
      random: () => 0.5,
      env: {},
    });

    let settled = false;
    const pending = generator
      .generate({ text: 'コーヒー豆', maxRetries: BATCH_MAX_RETRIES })
      .then((result) => {
        settled = true;
        return result;
      });

    // 1 回目の再試行の基準値は 1,000 ms。ジッター 0.5 → ちょうど 1,000 ms
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(result.retries).toBe(1);
    expect(result.calls).toBe(2);
    expect(result.backoffWaitMs).toBe(1_000);
    expect(result.elapsedMs).toBe(1_000);
  });
});
