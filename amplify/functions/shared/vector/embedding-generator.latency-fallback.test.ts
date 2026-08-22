/**
 * `embedding-generator.ts` のレイテンシ最適化推論フォールバックのテスト（task 18.1）
 *
 * 検証対象は **Correctness Property 59（フォールバックの単発性と経路記録）** と、
 * task 18.1 が列挙する例示テストである。
 *
 * ## モックの境界
 *
 * AWS へは一切接続しない。差し替えるのは 2 箇所のみで、目的に応じて使い分ける。
 *
 * - **`EmbeddingTransport` の差し替え**（Property 59 と大半の単体テスト）:
 *   `EmbeddingInvocation`（モデル ID・次元数・入力本文・`latencyOptimized`）をそのまま
 *   観測できる。フォールバックの回数と「再呼び出しの入力が初回と一致するか」を
 *   直接数え上げられるため、単発性の検証はこの層で行う
 * - **`BedrockRuntimeLike` クライアントの差し替え**（要求本文の検証）:
 *   `createBedrockEmbeddingTransport()` を実物のまま通し、`InvokeModelCommand` の入力を観測する。
 *   `performanceConfigLatency` を送ったか / 送らなかったかは SDK コマンドの組み立てを
 *   通さないと確認できないため、この 1 点だけは実物の経路を使う
 *
 * 時計は決定的な仮想時計を注入する。スロットリング再試行のバックオフ待機を実時間で
 * 消費せずに検証できる（既定の `systemClock` 経路は task 3.12 のテストが押さえている）。
 *
 * 要件: 10.1, 10.13, 10.14, 10.15
 * Property: 59
 * 設計: Embedding_Generator / レイテンシ最適化推論のフォールバック（案 B）
 */

import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  BATCH_MAX_RETRIES,
  EMBEDDING_MODEL_ID,
  EmbeddingGenerator,
  QUERY_MAX_RETRIES,
  createBedrockEmbeddingTransport,
  isLatencyOptimizationUnsupportedError,
  type BedrockRuntimeLike,
  type EmbeddingClock,
  type EmbeddingInvocation,
  type EmbeddingTransport,
  type InferencePath,
} from './embedding-generator';

// ============================================================
// 期待値の定義（実装の定数を写さず、要件・設計から書き下す）
// ============================================================

/**
 * 要件 10.13 / A21 が記録する実測本文。**実装の定数を参照せずここへ literal で置く。**
 * 実環境が返す文字列そのものでフォールバックが起きることを固定するのが本テストの要点である。
 */
const MEASURED_UNSUPPORTED_MESSAGE =
  'Latency performance configuration is not supported for amazon.titan-embed-text-v2:0 in us-west-2';

/** 設計が定める推論経路識別子の値域（要件 10.1） */
const DESIGN_INFERENCE_PATHS: readonly InferencePath[] = ['latency_optimized', 'standard'];

/** テストで使う次元数。反復回数の多いテストを軽くするため最小値を使う */
const DIMENSIONS = 256;

/**
 * 空白を含まない文字。前処理・切り詰めのいずれでも変化しないため、
 * 「再呼び出しの入力本文が初回と一致する」を入力文字列そのものと突き合わせて検証できる。
 */
const NON_BLANK_CHARACTERS = ['a', 'Z', '9', 'コ', 'ー', '豆', 'é', '-', '_'] as const;

// ============================================================
// 仮想時計
// ============================================================

/** `sleep()` が待機量ぶん時刻を進めるだけの決定的な時計。実タイマーを使わない */
function createVirtualClock(): EmbeddingClock & { readonly sleeps: readonly number[] } {
  let current = 0;
  const sleeps: number[] = [];

  return {
    now: () => current,
    sleep: (ms: number) => {
      const applied = Number.isFinite(ms) && ms > 0 ? ms : 0;
      sleeps.push(applied);
      current += applied;
      return Promise.resolve();
    },
    get sleeps() {
      return sleeps;
    },
  };
}

// ============================================================
// エラーの作り方（実環境の形に合わせる）
// ============================================================

/**
 * 「レイテンシ最適化推論が未対応」を示す `ValidationException`（要件 10.13）。
 * モデル ID とリージョンを引数にしてあるのは、**判定がそれらの値に依存していないこと**を
 * 反例探索の対象に含めるためである。
 */
function unsupportedError(
  modelId = 'amazon.titan-embed-text-v2:0',
  region = 'us-west-2'
): Error {
  return Object.assign(
    new Error(`Latency performance configuration is not supported for ${modelId} in ${region}`),
    { name: 'ValidationException', $metadata: { httpStatusCode: 400 } }
  );
}

/**
 * 未対応を示さない `ValidationException`（要件 10.14）。
 * 入力本文の不正など、レイテンシ最適化推論とは無関係な検証エラーである。
 */
function plainValidationError(message: string): Error {
  return Object.assign(new Error(message), {
    name: 'ValidationException',
    $metadata: { httpStatusCode: 400 },
  });
}

/** スロットリング例外。`classifyError()` が `THROTTLED` と分類する形 */
function throttlingError(): Error {
  return Object.assign(new Error('Rate exceeded'), {
    name: 'ThrottlingException',
    $metadata: { httpStatusCode: 429 },
  });
}

// ============================================================
// 観測用の EmbeddingTransport
// ============================================================

/** Bedrock 呼び出し 1 回に対応する結果の指定 */
type Outcome = 'ok' | 'unsupported' | 'validation' | 'throttled';

interface RecordingTransport extends EmbeddingTransport {
  /** 発行された要求の列（呼び出し順）。フォールバックの再呼び出しも 1 要素として並ぶ */
  readonly invocations: readonly EmbeddingInvocation[];
}

/**
 * 指定した結果列を順に返すスタブ。列を使い切った後は成功を返す
 * （property テストの終了性を保つため。到達しなかった要素は単に使われない）。
 */
function createOutcomeTransport(outcomes: readonly Outcome[]): RecordingTransport {
  const invocations: EmbeddingInvocation[] = [];
  const embedding = Array.from({ length: DIMENSIONS }, (_, index) => index / DIMENSIONS);

  return {
    invocations,
    invoke: (invocation: EmbeddingInvocation) => {
      invocations.push(invocation);
      const outcome = outcomes[invocations.length - 1] ?? 'ok';

      switch (outcome) {
        case 'unsupported':
          return Promise.reject(unsupportedError());
        case 'validation':
          return Promise.reject(plainValidationError('Malformed input request: expected string.'));
        case 'throttled':
          return Promise.reject(throttlingError());
        default:
          return Promise.resolve({ embedding, inputTextTokenCount: 5 });
      }
    },
  };
}

/** 仮想時計と観測用スタブを備えた生成器を作る。レート制御の待機は起きない設定にする */
function createGenerator(options: {
  latencyOptimized: boolean;
  transport: EmbeddingTransport;
  clock: EmbeddingClock;
}): EmbeddingGenerator {
  return new EmbeddingGenerator({
    dimensions: DIMENSIONS,
    requestsPerMinute: 600,
    latencyOptimized: options.latencyOptimized,
    transport: options.transport,
    clock: options.clock,
    random: () => 0.5,
    env: {},
  });
}

// ============================================================
// 独立モデル（実装を写さず、要件から手続きを書き下す）
// ============================================================

interface ExpectedRun {
  /** 各 Bedrock 呼び出しで `performanceConfigLatency` を付けたか */
  readonly latencyFlags: readonly boolean[];
  readonly ok: boolean;
  /** スロットリング再試行の回数。**フォールバックはここに含めない**（要件 10.15） */
  readonly retries: number;
  readonly fallbackUsed: boolean;
}

/**
 * 要件 10.13〜10.15 を素直に手続きへ書き下した参照実装。
 *
 * - 未対応エラー: レイテンシ最適化を要求中で、まだフォールバックしていないときだけ経路を変える
 * - 未対応を示さない `ValidationException`: 即座に失敗（要件 10.14）
 * - スロットリング: 上限まで同じ経路で再試行（要件 10.15 の「別系統」）
 */
function simulate(
  outcomes: readonly Outcome[],
  latencyOptimized: boolean,
  maxRetries: number
): ExpectedRun {
  const latencyFlags: boolean[] = [];
  let current = latencyOptimized;
  let fallbackUsed = false;
  let retries = 0;

  for (;;) {
    const outcome = outcomes[latencyFlags.length] ?? 'ok';
    latencyFlags.push(current);

    if (outcome === 'ok') return { latencyFlags, ok: true, retries, fallbackUsed };

    if (outcome === 'unsupported' && current && !fallbackUsed) {
      fallbackUsed = true;
      current = false;
      continue;
    }

    if (outcome === 'throttled') {
      if (retries >= maxRetries) return { latencyFlags, ok: false, retries, fallbackUsed };
      retries += 1;
      continue;
    }

    return { latencyFlags, ok: false, retries, fallbackUsed };
  }
}

// ============================================================
// 未対応判定の単体テスト（要件 10.13 / 10.14）
// ============================================================

describe('isLatencyOptimizationUnsupportedError', () => {
  it('実測本文の ValidationException を未対応と判定する', () => {
    expect(
      isLatencyOptimizationUnsupportedError(plainValidationError(MEASURED_UNSUPPORTED_MESSAGE))
    ).toBe(true);
  });

  it('モデル ID とリージョンが実測値と異なっても未対応と判定する（値を判定に埋め込んでいない）', () => {
    const others = [
      unsupportedError('cohere.embed-multilingual-v3', 'eu-central-1'),
      unsupportedError('amazon.titan-embed-text-v2:0', 'ap-northeast-1'),
      unsupportedError('some.future-model-v9:3', 'ap-southeast-7'),
    ];

    others.forEach((error) => {
      // 実測値のモデル ID / リージョンを含まない本文でも成立する
      expect(error.message).not.toBe(MEASURED_UNSUPPORTED_MESSAGE);
      expect(isLatencyOptimizationUnsupportedError(error)).toBe(true);
    });

    // モデル ID とリージョンを完全に省いた本文でも成立する
    expect(
      isLatencyOptimizationUnsupportedError(
        plainValidationError('Latency performance configuration is not supported.')
      )
    ).toBe(true);
  });

  it('大文字小文字の違いを無視する', () => {
    expect(
      isLatencyOptimizationUnsupportedError(
        plainValidationError('LATENCY PERFORMANCE CONFIGURATION IS NOT SUPPORTED for X in Y')
      )
    ).toBe(true);
  });

  it('未対応を示さない ValidationException は偽と判定する（要件 10.14）', () => {
    const messages = [
      'Malformed input request: expected string, please reformat your input and try again.',
      'The provided dimensions value is not valid.',
      // 片方の語しか含まない本文はいずれも対象外
      'Latency performance configuration must be one of: standard, optimized.',
      'The requested operation is not supported for this resource.',
      '',
    ];

    messages.forEach((message) => {
      expect(isLatencyOptimizationUnsupportedError(plainValidationError(message))).toBe(false);
    });
  });

  it('ValidationException 以外の例外は偽と判定する（同じ本文でも経路を変えない）', () => {
    const throttled = Object.assign(new Error(MEASURED_UNSUPPORTED_MESSAGE), {
      name: 'ThrottlingException',
      $metadata: { httpStatusCode: 429 },
    });
    const denied = Object.assign(new Error(MEASURED_UNSUPPORTED_MESSAGE), {
      name: 'AccessDeniedException',
      $metadata: { httpStatusCode: 403 },
    });

    expect(isLatencyOptimizationUnsupportedError(throttled)).toBe(false);
    expect(isLatencyOptimizationUnsupportedError(denied)).toBe(false);
  });

  it('任意の値に対して例外を投げない（全域性）', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
      }
    );

    [undefined, null, 0, true, [], {}, hostile, MEASURED_UNSUPPORTED_MESSAGE].forEach((value) => {
      expect(typeof isLatencyOptimizationUnsupportedError(value)).toBe('boolean');
    });

    // 名前が読めない素の文字列は 400 の手掛かりも無いため対象外（誤爆させない）
    expect(isLatencyOptimizationUnsupportedError(MEASURED_UNSUPPORTED_MESSAGE)).toBe(false);
  });
});

// ============================================================
// 例示テスト（task 18.1 が列挙するもの。省略しない）
// ============================================================

describe('レイテンシ最適化推論のフォールバック（例示）', () => {
  it('未対応エラー本文で再呼び出しが 1 回だけ発生し inferencePath が standard になる（要件 10.13）', async () => {
    const clock = createVirtualClock();
    const invocations: EmbeddingInvocation[] = [];
    const embedding = Array.from({ length: DIMENSIONS }, () => 0.5);

    const transport: EmbeddingTransport = {
      invoke: (invocation) => {
        invocations.push(invocation);
        // 実測本文そのものを返す。1 回目だけ失敗し、2 回目は成功する
        if (invocations.length === 1) {
          return Promise.reject(plainValidationError(MEASURED_UNSUPPORTED_MESSAGE));
        }
        return Promise.resolve({ embedding, inputTextTokenCount: 29 });
      },
    };

    const generator = createGenerator({ latencyOptimized: true, transport, clock });
    const result = await generator.generate({
      text: 'エチオピア産の華やかな酸味のコーヒー',
      maxRetries: QUERY_MAX_RETRIES,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 再呼び出しはちょうど 1 回（合計 2 回）
    expect(invocations).toHaveLength(2);
    expect(result.calls).toBe(2);
    expect(invocations[0].latencyOptimized).toBe(true);
    expect(invocations[1].latencyOptimized).toBe(false);

    // 再呼び出しの入力はモデル・次元数・入力本文がいずれも初回と一致する
    expect(invocations[1].modelId).toBe(invocations[0].modelId);
    expect(invocations[1].dimensions).toBe(invocations[0].dimensions);
    expect(invocations[1].text).toBe(invocations[0].text);
    expect(invocations[1].modelId).toBe(EMBEDDING_MODEL_ID);

    // 経路の記録（要件 10.1）
    expect(result.inferencePath).toBe('standard');
    expect(result.latencyFallbackUsed).toBe(true);

    // 別系統であること: 再試行回数は 0、バックオフ待機も発生していない（要件 10.15）
    expect(result.retries).toBe(0);
    expect(result.backoffWaitMs).toBe(0);
    expect(clock.sleeps).toHaveLength(0);

    // 生成結果そのものは通常の成功と変わらない
    expect(result.embedding).toHaveLength(DIMENSIONS);
    expect(result.dimensions).toBe(DIMENSIONS);
  });

  it('未対応を示さない ValidationException では再呼び出しが 0 回で失敗として返る（要件 10.14）', async () => {
    const clock = createVirtualClock();
    const invocations: EmbeddingInvocation[] = [];

    const transport: EmbeddingTransport = {
      invoke: (invocation) => {
        invocations.push(invocation);
        return Promise.reject(
          plainValidationError('Malformed input request: expected string, please reformat.')
        );
      },
    };

    const generator = createGenerator({ latencyOptimized: true, transport, clock });
    const result = await generator.generate({
      text: 'コーヒー豆',
      maxRetries: QUERY_MAX_RETRIES,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // 再呼び出しは 1 回も発生しない（初回の 1 回のみ）
    expect(invocations).toHaveLength(1);
    expect(result.calls).toBe(1);
    expect(invocations[0].latencyOptimized).toBe(true);

    // フォールバックしていないため経路は latency_optimized のまま
    expect(result.latencyFallbackUsed).toBe(false);
    expect(result.inferencePath).toBe('latency_optimized');

    // 再試行不可の失敗として返る（スロットリング再試行にも入らない）
    expect(result.retries).toBe(0);
    expect(result.throttlingExhausted).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error.retryable).toBe(false);
    expect(result.error.stage).toBe('EMBEDDING');
    expect(result.error.errorCode).not.toBe('THROTTLED');
  });

  it('成功時は inferencePath が latency_optimized になる（要件 10.1）', async () => {
    const clock = createVirtualClock();
    const transport = createOutcomeTransport(['ok']);

    const generator = createGenerator({ latencyOptimized: true, transport, clock });
    const result = await generator.generate({ text: 'コーヒー豆', maxRetries: QUERY_MAX_RETRIES });

    expect(result.ok).toBe(true);
    expect(result.inferencePath).toBe('latency_optimized');
    expect(result.latencyFallbackUsed).toBe(false);
    expect(transport.invocations).toHaveLength(1);
    expect(transport.invocations[0].latencyOptimized).toBe(true);
  });

  it('フォールバック後の標準推論が失敗しても更なるフォールバックを行わない（要件 10.15）', async () => {
    const clock = createVirtualClock();
    // 1 回目: 未対応 → フォールバック。2 回目も同じ未対応本文を返す
    const transport = createOutcomeTransport(['unsupported', 'unsupported', 'ok']);

    const generator = createGenerator({ latencyOptimized: true, transport, clock });
    const result = await generator.generate({ text: 'コーヒー豆', maxRetries: QUERY_MAX_RETRIES });

    expect(result.ok).toBe(false);
    // 2 回目の失敗でそのまま返る（3 回目の 'ok' には到達しない）
    expect(transport.invocations).toHaveLength(2);
    expect(result.calls).toBe(2);
    expect(result.latencyFallbackUsed).toBe(true);
    expect(result.inferencePath).toBe('standard');
    expect(result.retries).toBe(0);
  });

  it('フォールバックの 1 回はスロットリング再試行の上限を消費しない（要件 10.15）', async () => {
    const clock = createVirtualClock();
    // 未対応 → フォールバック後にスロットリングが続き、上限（3 回）まで再試行してから成功する
    const transport = createOutcomeTransport([
      'unsupported',
      'throttled',
      'throttled',
      'throttled',
      'ok',
    ]);

    const generator = createGenerator({ latencyOptimized: true, transport, clock });
    const result = await generator.generate({ text: 'コーヒー豆', maxRetries: QUERY_MAX_RETRIES });

    expect(result.ok).toBe(true);
    // 呼び出し 5 回 = 初回 1 + フォールバック 1 + 再試行 3
    expect(transport.invocations).toHaveLength(5);
    expect(result.calls).toBe(5);
    // 再試行回数はスロットリング分のみ。フォールバックは加算されない
    expect(result.retries).toBe(QUERY_MAX_RETRIES);
    expect(result.latencyFallbackUsed).toBe(true);
    expect(result.inferencePath).toBe('standard');
    // フォールバックの切り替えでは待機せず、スロットリング再試行の 3 回だけ待つ
    expect(clock.sleeps).toHaveLength(QUERY_MAX_RETRIES);
    // フォールバック後の呼び出しはすべて標準推論
    expect(transport.invocations.slice(1).every((call) => !call.latencyOptimized)).toBe(true);
  });

  it('スロットリングでフォールバックしない（別系統であること）', async () => {
    const clock = createVirtualClock();
    const transport = createOutcomeTransport(['throttled', 'ok']);

    const generator = createGenerator({ latencyOptimized: true, transport, clock });
    const result = await generator.generate({ text: 'コーヒー豆', maxRetries: QUERY_MAX_RETRIES });

    expect(result.ok).toBe(true);
    expect(transport.invocations).toHaveLength(2);
    // 再試行は同じ経路（レイテンシ最適化）で行われる。経路を変えるのは未対応エラーのみ
    expect(transport.invocations[1].latencyOptimized).toBe(true);
    expect(result.retries).toBe(1);
    expect(result.latencyFallbackUsed).toBe(false);
    expect(result.inferencePath).toBe('latency_optimized');
  });

  it('バッチ側（latencyOptimized: false）は未対応エラーでもフォールバックせず、経路は常に standard', async () => {
    const clock = createVirtualClock();
    const transport = createOutcomeTransport(['unsupported', 'ok']);

    const generator = createGenerator({ latencyOptimized: false, transport, clock });
    const result = await generator.generate({ text: 'コーヒー豆', maxRetries: BATCH_MAX_RETRIES });

    // 段 1 に入らないため未対応エラーは通常の失敗として扱われる（2 回目には進まない）
    expect(result.ok).toBe(false);
    expect(transport.invocations).toHaveLength(1);
    expect(transport.invocations[0].latencyOptimized).toBe(false);
    expect(result.latencyFallbackUsed).toBe(false);
    expect(result.inferencePath).toBe('standard');
  });

  it('バッチ側の成功時も経路は standard（挙動が変わっていないことの確認）', async () => {
    const clock = createVirtualClock();
    const transport = createOutcomeTransport(['ok']);

    const generator = createGenerator({ latencyOptimized: false, transport, clock });
    const result = await generator.generate({ text: 'コーヒー豆', maxRetries: BATCH_MAX_RETRIES });

    expect(result.ok).toBe(true);
    expect(transport.invocations).toHaveLength(1);
    expect(transport.invocations[0].latencyOptimized).toBe(false);
    expect(result.inferencePath).toBe('standard');
    expect(result.latencyFallbackUsed).toBe(false);
  });
});

// ============================================================
// 要求本文の検証（`InvokeModelCommand` の組み立てを実物で通す）
// ============================================================

describe('InvokeModel 要求本文（performanceConfigLatency の有無）', () => {
  interface SentCommand {
    readonly modelId?: unknown;
    readonly performanceConfigLatency?: unknown;
    readonly body?: unknown;
  }

  const sent: SentCommand[] = [];

  /**
   * `BedrockRuntimeClient` の代わりに使うスタブ。1 回目だけ未対応エラーを投げる。
   * `InvokeModelCommandOutput` は `$metadata` を必須にするため、応答の形だけを合わせて
   * 1 箇所で `BedrockRuntimeLike` へ写す（テスト側で SDK の型を再現しない）。
   */
  function createStubClient(options: { failFirstAsUnsupported: boolean }): BedrockRuntimeLike {
    const stub = {
      send: (command: { input: SentCommand }): Promise<{ body: Uint8Array }> => {
        sent.push(command.input);

        if (options.failFirstAsUnsupported && sent.length === 1) {
          return Promise.reject(plainValidationError(MEASURED_UNSUPPORTED_MESSAGE));
        }

        const embedding = Array.from({ length: DIMENSIONS }, () => 0.25);
        // jsdom 環境の `TextEncoder` は別レルムの `Uint8Array` を返すため現レルムへ写す
        return Promise.resolve({
          body: Uint8Array.from(
            new TextEncoder().encode(JSON.stringify({ embedding, inputTextTokenCount: 29 }))
          ),
        });
      },
    };

    return stub as unknown as BedrockRuntimeLike;
  }

  /** 送信された要求本文を JSON として読む */
  function decodeBody(command: SentCommand): Record<string, unknown> {
    return JSON.parse(new TextDecoder().decode(command.body as Uint8Array)) as Record<
      string,
      unknown
    >;
  }

  beforeEach(() => {
    sent.length = 0;
  });

  it('バッチ側（latencyOptimized: false）は performanceConfigLatency を送らない', async () => {
    const clock = createVirtualClock();
    const generator = createGenerator({
      latencyOptimized: false,
      transport: createBedrockEmbeddingTransport({
        client: createStubClient({ failFirstAsUnsupported: false }),
      }),
      clock,
    });

    const result = await generator.generate({
      text: 'コーヒー豆',
      maxRetries: BATCH_MAX_RETRIES,
    });

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect('performanceConfigLatency' in sent[0]).toBe(false);
    expect(sent[0].performanceConfigLatency).toBeUndefined();
    expect(sent[0].modelId).toBe(EMBEDDING_MODEL_ID);
    expect(decodeBody(sent[0])).toEqual({
      inputText: 'コーヒー豆',
      dimensions: DIMENSIONS,
      normalize: true,
    });
    expect(result.inferencePath).toBe('standard');
  });

  it('クエリ側は 1 回目に optimized を付け、フォールバック時は同一本文で当該指定を外す', async () => {
    const clock = createVirtualClock();
    const generator = createGenerator({
      latencyOptimized: true,
      transport: createBedrockEmbeddingTransport({
        client: createStubClient({ failFirstAsUnsupported: true }),
      }),
      clock,
    });

    const result = await generator.generate({
      text: 'エチオピア産の華やかな酸味のコーヒー',
      maxRetries: QUERY_MAX_RETRIES,
    });

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(2);

    // 段 1: レイテンシ最適化の指定あり
    expect(sent[0].performanceConfigLatency).toBe('optimized');
    // 段 2: 当該指定を外す（キー自体を送らない）
    expect('performanceConfigLatency' in sent[1]).toBe(false);
    expect(sent[1].performanceConfigLatency).toBeUndefined();

    // モデル ID と要求本文は完全に同一
    expect(sent[1].modelId).toBe(sent[0].modelId);
    expect(decodeBody(sent[1])).toEqual(decodeBody(sent[0]));
    expect(decodeBody(sent[1])).toEqual({
      inputText: 'エチオピア産の華やかな酸味のコーヒー',
      dimensions: DIMENSIONS,
      normalize: true,
    });

    expect(result.inferencePath).toBe('standard');
  });
});

// ============================================================
// Property 59
// ============================================================

describe('レイテンシ最適化推論のフォールバックの単発性と経路記録（Property 59）', () => {
  // Feature: vector-search-comparison, Property 59: 任意の Bedrock 呼び出しの成否列に対して、
  // レイテンシ最適化推論を要求した 1 回の埋め込み生成において、モデルまたはリージョンの
  // 未対応を示すエラーが返った場合にのみレイテンシ最適化の指定を外した再呼び出しが
  // ちょうど 1 回発生し、その再呼び出しの入力はモデル・次元数・入力本文がいずれも初回と一致する。
  // 未対応を示さない `ValidationException` に対しては再呼び出しが 1 回も発生しない。
  // フォールバック後の失敗に対して更なるフォールバックは発生しない。フォールバックの回数は
  // スロットリング再試行の回数に加算されない。返却される推論経路識別子は、フォールバックが
  // 発生した場合に限り `standard` であり、発生しなかった場合は `latency_optimized` である。
  // **Validates: Requirements 10.1, 10.13, 10.14, 10.15**
  it('未対応エラーのときだけ経路をちょうど 1 回切り替え、入力を保ち、再試行回数と混ざらない', async () => {
    const outcomeArb = fc.constantFrom<Outcome>('ok', 'unsupported', 'validation', 'throttled');

    await fc.assert(
      fc.asyncProperty(
        fc.array(outcomeArb, { minLength: 1, maxLength: 8 }),
        fc.boolean(),
        fc.oneof(
          fc.constantFrom(QUERY_MAX_RETRIES, BATCH_MAX_RETRIES),
          fc.integer({ min: 0, max: 4 })
        ),
        fc
          .array(fc.constantFrom(...NON_BLANK_CHARACTERS), { minLength: 1, maxLength: 30 })
          .map((characters) => characters.join('')),
        async (outcomes, latencyOptimized, maxRetries, text) => {
          const clock = createVirtualClock();
          const transport = createOutcomeTransport(outcomes);
          const generator = createGenerator({ latencyOptimized, transport, clock });

          const result = await generator.generate({ text, maxRetries });

          const expected = simulate(outcomes, latencyOptimized, maxRetries);
          const calls = transport.invocations;

          // (a) 呼び出し列が参照実装と一致する（回数と各回の経路指定）
          expect(calls).toHaveLength(expected.latencyFlags.length);
          expect(calls.map((call) => call.latencyOptimized)).toEqual(expected.latencyFlags);
          expect(result.calls).toBe(expected.latencyFlags.length);
          expect(result.ok).toBe(expected.ok);

          // (b) 経路の切り替えはちょうど 0 回または 1 回。true → false の一方向のみで、
          //     false → true へ戻ることはない（= 更なるフォールバックも復帰も起きない）
          const switches = calls.filter(
            (call, index) => index > 0 && call.latencyOptimized !== calls[index - 1].latencyOptimized
          );
          expect(switches.length).toBe(expected.fallbackUsed ? 1 : 0);
          expect(switches.every((call) => call.latencyOptimized === false)).toBe(true);
          expect(result.latencyFallbackUsed).toBe(expected.fallbackUsed);

          // (c) フォールバックはレイテンシ最適化を要求した場合にのみ起こりうる
          if (!latencyOptimized) {
            expect(result.latencyFallbackUsed).toBe(false);
            expect(calls.every((call) => call.latencyOptimized === false)).toBe(true);
          }

          // (d) 未対応を示さない `ValidationException` では再呼び出しが 1 回も起きない
          if (outcomes[0] === 'validation') {
            expect(calls).toHaveLength(1);
            expect(result.latencyFallbackUsed).toBe(false);
          }

          // (e) すべての呼び出しでモデル・次元数・入力本文が初回と一致する。
          //     入力文字列は空白を含まないため前処理・切り詰めで変化せず、原文と直接比較できる
          calls.forEach((call) => {
            expect(call.modelId).toBe(calls[0].modelId);
            expect(call.dimensions).toBe(calls[0].dimensions);
            expect(call.text).toBe(calls[0].text);
            expect(call.modelId).toBe(EMBEDDING_MODEL_ID);
            expect(call.dimensions).toBe(DIMENSIONS);
            expect(call.text).toBe(text);
          });

          // (f) フォールバックの回数はスロットリング再試行の回数に加算されない。
          //     呼び出し回数 = 初回 1 + 再試行回数 + フォールバック回数 で分解できる
          expect(result.retries).toBe(expected.retries);
          expect(result.retries).toBeLessThanOrEqual(maxRetries);
          expect(result.calls).toBe(1 + result.retries + (result.latencyFallbackUsed ? 1 : 0));
          // 待機はスロットリング再試行のときだけ発生する（経路切り替えでは待たない）
          expect(clock.sleeps).toHaveLength(result.retries);

          // (g) 推論経路識別子はフォールバックの発生と一致する
          expect(DESIGN_INFERENCE_PATHS).toContain(result.inferencePath);
          if (latencyOptimized) {
            expect(result.inferencePath).toBe(
              result.latencyFallbackUsed ? 'standard' : 'latency_optimized'
            );
          } else {
            expect(result.inferencePath).toBe('standard');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
