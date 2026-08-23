/**
 * `verify-embeddings.ts`（Verification_Run 実行スクリプト）の単体テスト（task 17.1）
 *
 * 固定するのは次の 4 点である。
 *
 * 1. 対象特定が `skip-decision.ts` の述語に従う（要件 3.15）
 * 2. itemId を 100 件単位のチャンクへ分け、全チャンクを呼ぶ（設計「対象特定」の 3.）
 * 3. リクエストとレポートにベクトル本体が現れない（要件 3.16 / Property 22）
 * 4. 集計と合否が `verification-summary.ts` の判定に従い、不合格を COMPLETED にしない
 *    （要件 3.17 / 3.18）
 *
 * AWS へは一切触れない（走査経路と検証経路を注入する）。
 *
 * 要件: 3.13, 3.14, 3.15, 3.16, 3.17, 3.18
 * Property: 22, 58
 */

import { describe, expect, it } from 'vitest';

import type { VectorLanguage } from '../../amplify/functions/shared/vector/language';
import {
  DEFAULT_VECTOR_TABLE_NAME,
  EXIT_CODES,
  VERIFY_CHUNK_SIZE,
  VerifyArgumentError,
  aggregateChunkResults,
  buildVerificationPlan,
  chunkItemIds,
  decideExitCode,
  parseVerifyArgs,
  readChunkResult,
  readMismatchedKeys,
  readScannedSku,
  runVerification,
  verifyReportFileName,
  type ChunkResult,
  type ScannedSku,
  type VerificationEndpoint,
  type VectorTableScanner,
} from './verify-embeddings';
import {
  MAX_VERIFICATION_ITEM_IDS,
  VERIFICATION_EMBEDDING_MODEL_ID,
  VERIFICATION_ROUTE_PATH,
  VERIFICATION_WAREHOUSE_ID,
} from '../../amplify/functions/vector-search-aoss/verify';

const MODEL = VERIFICATION_EMBEDDING_MODEL_ID;
const DIMENSIONS = 1024;
const LANGUAGES: VectorLanguage[] = ['ja', 'en'];

function sku(itemId: string, options: Partial<ScannedSku> = {}): ScannedSku {
  return {
    itemId,
    embeddingModel: MODEL,
    embeddingDimensions: DIMENSIONS,
    hasEmbedding: { ja: true, en: true },
    ...options,
  };
}

/** 検証経路の応答（一致のみ）を組み立てる */
function matchedResponse(itemIds: readonly string[], languages: readonly VectorLanguage[]) {
  const perLanguage = itemIds.length;
  const byLanguage: Record<string, unknown> = {};
  for (const language of languages) {
    byLanguage[language] = {
      targetCount: perLanguage,
      matchedCount: perLanguage,
      mismatchedCount: 0,
      missingCount: 0,
      consistent: true,
      passed: true,
      failedCount: 0,
      mismatchedKeys: [],
      skippedCount: 0,
    };
  }
  const total = perLanguage * languages.length;
  return {
    path: 'verify',
    status: 'COMPLETED',
    targetCount: total,
    matchedCount: total,
    mismatchedCount: 0,
    missingCount: 0,
    consistent: true,
    passed: true,
    failedCount: 0,
    skippedCount: 0,
    byLanguage,
    mismatchedKeys: [],
    calls: { getItem: itemIds.length, mget: 1, bedrock: 0 },
  };
}

function chunkResult(overrides: Partial<ChunkResult> = {}): ChunkResult {
  return {
    chunkIndex: 0,
    itemIdCount: 1,
    counts: { targetCount: 2, matchedCount: 2, mismatchedCount: 0, missingCount: 0 },
    countsByLanguage: {
      ja: { targetCount: 1, matchedCount: 1, mismatchedCount: 0, missingCount: 0 },
      en: { targetCount: 1, matchedCount: 1, mismatchedCount: 0, missingCount: 0 },
    },
    mismatchedKeys: [],
    skippedCount: 0,
    calls: { getItem: 1, mget: 1, bedrock: 0 },
    status: 'COMPLETED',
    ...overrides,
  };
}

/** 数値配列（ベクトル本体）が含まれているか */
function containsNumberArray(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((element) => typeof element === 'number') || value.some(containsNumberArray);
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsNumberArray);
  }
  return false;
}

// ---------------------------------------------------------------------------
// 対象特定
// ---------------------------------------------------------------------------

describe('buildVerificationPlan', () => {
  it('現行設定と一致する組のみを対象にする', () => {
    const plan = buildVerificationPlan(
      [
        sku('ITEM-1'),
        // モデルが異なる（再生成待ち）
        sku('ITEM-2', { embeddingModel: 'other-model' }),
        // 次元数が異なる
        sku('ITEM-3', { embeddingDimensions: 512 }),
        // ja のみ格納済み
        sku('ITEM-4', { hasEmbedding: { ja: true, en: false } }),
      ],
      MODEL,
      DIMENSIONS,
      LANGUAGES
    );

    expect(plan.scannedSkuCount).toBe(4);
    expect(plan.itemIds).toEqual(['ITEM-1', 'ITEM-4']);
    expect(plan.targetPairCount).toBe(3);
    expect(plan.targetPairsByLanguage).toEqual({ ja: 2, en: 1 });
    // 8 組のうち 3 組が対象、残る 5 組は対象外
    expect(plan.skippedPairCount).toBe(5);
  });

  it('言語を絞ると当該言語のみを数える', () => {
    const plan = buildVerificationPlan([sku('ITEM-1')], MODEL, DIMENSIONS, ['ja']);

    expect(plan.targetPairCount).toBe(1);
    expect(plan.targetPairsByLanguage).toEqual({ ja: 1 });
    expect(plan.skippedPairCount).toBe(0);
  });
});

describe('readScannedSku', () => {
  it('射影した先頭要素からベクトルの存在を判定する', () => {
    const parsed = readScannedSku({
      itemId: { S: 'ITEM-1' },
      embeddingModel: { S: MODEL },
      embeddingDimensions: { N: '1024' },
      embeddingJa: { L: [{ N: '0.1' }] },
    });

    expect(parsed).toEqual({
      itemId: 'ITEM-1',
      embeddingModel: MODEL,
      embeddingDimensions: 1024,
      hasEmbedding: { ja: true, en: false },
    });
  });

  it('itemId を取り出せない行は落とす', () => {
    expect(readScannedSku({})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// チャンク分割
// ---------------------------------------------------------------------------

describe('chunkItemIds', () => {
  it('検証経路の上限件数でチャンクへ分ける', () => {
    const itemIds = Array.from({ length: 5_000 }, (_, index) => `ITEM-${index}`);
    const chunks = chunkItemIds(itemIds, VERIFY_CHUNK_SIZE);

    expect(VERIFY_CHUNK_SIZE).toBe(MAX_VERIFICATION_ITEM_IDS);
    expect(chunks).toHaveLength(50);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_VERIFICATION_ITEM_IDS);
    // 全 itemId がちょうど 1 回ずつ現れる（取りこぼしと重複がない）
    expect(chunks.flat()).toEqual(itemIds);
  });

  it('端数のチャンクを落とさない', () => {
    const itemIds = Array.from({ length: 101 }, (_, index) => `ITEM-${index}`);
    const chunks = chunkItemIds(itemIds, 100);

    expect(chunks.map((chunk) => chunk.length)).toEqual([100, 1]);
  });

  it('空の入力は空のチャンク列になる', () => {
    expect(chunkItemIds([], 100)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 応答の読み取り
// ---------------------------------------------------------------------------

describe('readChunkResult', () => {
  it('件数・言語別集計・呼び出し回数を取り出す', () => {
    const result = readChunkResult(0, 2, matchedResponse(['A', 'B'], LANGUAGES), LANGUAGES);

    expect(result.counts).toEqual({
      targetCount: 4,
      matchedCount: 4,
      mismatchedCount: 0,
      missingCount: 0,
    });
    expect(result.countsByLanguage.ja?.targetCount).toBe(2);
    expect(result.calls).toEqual({ getItem: 2, mget: 1, bedrock: 0 });
  });

  it('件数フィールドが欠けた応答を例外にする', () => {
    expect(() => readChunkResult(0, 1, { targetCount: 1 }, LANGUAGES)).toThrow(
      /件数フィールド/
    );
  });
});

describe('readMismatchedKeys', () => {
  it('3 フィールドのみを取り出し、ベクトル本体をレポートへ通さない', () => {
    const keys = readMismatchedKeys([
      {
        itemId: 'ITEM-1',
        language: 'en',
        reason: 'MISSING_OPENSEARCH',
        embeddingEn: [0.1, 0.2, 0.3],
      },
    ]);

    expect(keys).toEqual([
      { itemId: 'ITEM-1', language: 'en', reason: 'MISSING_OPENSEARCH' },
    ]);
    expect(containsNumberArray(keys)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 集計
// ---------------------------------------------------------------------------

describe('aggregateChunkResults', () => {
  it('チャンクを合算し、言語別の和が合計と一致する', () => {
    const aggregated = aggregateChunkResults(
      [chunkResult({ chunkIndex: 0 }), chunkResult({ chunkIndex: 1 })],
      LANGUAGES
    );

    expect(aggregated.total.targetCount).toBe(4);
    expect(aggregated.total.matchedCount).toBe(4);
    expect(aggregated.total.consistent).toBe(true);
    expect(aggregated.total.passed).toBe(true);
    expect(
      (aggregated.byLanguage.ja?.targetCount ?? 0) + (aggregated.byLanguage.en?.targetCount ?? 0)
    ).toBe(aggregated.total.targetCount);
    expect(aggregated.calls).toEqual({ getItem: 2, mget: 2, bedrock: 0 });
  });

  it('不一致を含むチャンクがあれば不合格になり、識別子を言語別に振り分ける', () => {
    const aggregated = aggregateChunkResults(
      [
        chunkResult(),
        chunkResult({
          chunkIndex: 1,
          counts: { targetCount: 2, matchedCount: 1, mismatchedCount: 1, missingCount: 0 },
          countsByLanguage: {
            ja: { targetCount: 1, matchedCount: 0, mismatchedCount: 1, missingCount: 0 },
            en: { targetCount: 1, matchedCount: 1, mismatchedCount: 0, missingCount: 0 },
          },
          mismatchedKeys: [{ itemId: 'ITEM-9', language: 'ja', reason: 'VALUE_MISMATCH' }],
        }),
      ],
      LANGUAGES
    );

    expect(aggregated.total.failedCount).toBe(1);
    expect(aggregated.total.passed).toBe(false);
    expect(aggregated.byLanguage.ja?.mismatchedKeys).toHaveLength(1);
    expect(aggregated.byLanguage.en?.mismatchedKeys).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

describe('runVerification', () => {
  const target = {
    tableName: DEFAULT_VECTOR_TABLE_NAME,
    warehouseId: VERIFICATION_WAREHOUSE_ID,
    baseUrl: 'https://api.test.invalid/api',
    routePath: VERIFICATION_ROUTE_PATH,
    model: MODEL,
    dimensions: DIMENSIONS,
    languages: LANGUAGES,
    chunkSize: VERIFY_CHUNK_SIZE,
    limit: null,
    dryRun: false,
  };

  function fakeScanner(count: number): VectorTableScanner {
    return {
      async scan(): Promise<ScannedSku[]> {
        return Array.from({ length: count }, (_, index) => sku(`ITEM-${index}`));
      },
    };
  }

  it('全チャンクを呼び、合計が対象特定の件数と一致する', async () => {
    const requests: { itemIds: readonly string[]; languages: readonly VectorLanguage[] }[] = [];
    const endpoint: VerificationEndpoint = {
      async verify(request) {
        requests.push(request);
        return matchedResponse(request.itemIds, request.languages);
      },
    };

    const report = await runVerification({
      target,
      scanner: fakeScanner(250),
      endpoint,
      generatedAt: '2026-01-02T03:04:05.678Z',
    });

    // 250 SKU → 100 / 100 / 50 の 3 チャンク
    expect(requests.map((request) => request.itemIds.length)).toEqual([100, 100, 50]);
    expect(report.chunkCount).toBe(3);
    expect(report.plan.targetPairCount).toBe(500);
    expect(report.total.targetCount).toBe(500);
    expect(report.total.matchedCount).toBe(500);
    expect(report.targetCountMatchesPlan).toBe(true);
    expect(report.total.passed).toBe(true);
    expect(report.status).toBe('COMPLETED');
    expect(report.calls).toEqual({ getItem: 250, mget: 3, bedrock: 0 });
    expect(report.regenerationFree).toBe(true);
    expect(decideExitCode(report)).toBe(EXIT_CODES.pass);
  });

  it('リクエストに itemIds と languages 以外を載せない', async () => {
    const requests: Record<string, unknown>[] = [];
    const endpoint: VerificationEndpoint = {
      async verify(request) {
        requests.push(request as unknown as Record<string, unknown>);
        return matchedResponse(request.itemIds, request.languages);
      },
    };

    await runVerification({ target, scanner: fakeScanner(2), endpoint });

    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]).sort()).toEqual(['itemIds', 'languages']);
    expect(containsNumberArray(requests[0])).toBe(false);
  });

  it('不一致を含む結果を COMPLETED にせず、終了コードを不合格にする', async () => {
    const endpoint: VerificationEndpoint = {
      async verify(request) {
        const body = matchedResponse(request.itemIds, request.languages) as Record<string, unknown>;
        return {
          ...body,
          matchedCount: (body.matchedCount as number) - 1,
          mismatchedCount: 1,
          passed: false,
          failedCount: 1,
          status: 'VERIFICATION_FAILED',
          byLanguage: {
            ja: {
              targetCount: 1,
              matchedCount: 0,
              mismatchedCount: 1,
              missingCount: 0,
            },
            en: { targetCount: 1, matchedCount: 1, mismatchedCount: 0, missingCount: 0 },
          },
          mismatchedKeys: [
            { itemId: 'ITEM-0', language: 'ja', reason: 'VALUE_MISMATCH: 第 3 次元が一致しません。' },
          ],
        };
      },
    };

    const report = await runVerification({ target, scanner: fakeScanner(1), endpoint });

    expect(report.total.mismatchedCount).toBe(1);
    expect(report.total.failedCount).toBe(1);
    expect(report.total.passed).toBe(false);
    expect(report.status).toBe('VERIFICATION_FAILED');
    expect(report.mismatchedKeys).toEqual([
      { itemId: 'ITEM-0', language: 'ja', reason: 'VALUE_MISMATCH: 第 3 次元が一致しません。' },
    ]);
    expect(decideExitCode(report)).toBe(EXIT_CODES.fail);
    expect(containsNumberArray(report)).toBe(false);
  });

  it('Bedrock 呼び出しが報告された場合は合格にしない', async () => {
    const endpoint: VerificationEndpoint = {
      async verify(request) {
        return {
          ...matchedResponse(request.itemIds, request.languages),
          calls: { getItem: 1, mget: 1, bedrock: 1 },
        };
      },
    };

    const report = await runVerification({ target, scanner: fakeScanner(1), endpoint });

    expect(report.calls.bedrock).toBe(1);
    expect(report.regenerationFree).toBe(false);
    expect(decideExitCode(report)).toBe(EXIT_CODES.fail);
  });

  it('チャンクが恒久的に失敗したら実行不能として扱う', async () => {
    const endpoint: VerificationEndpoint = {
      async verify() {
        throw new Error('AccessDeniedException: not authorized');
      },
    };

    const report = await runVerification({
      target,
      scanner: fakeScanner(1),
      endpoint,
      maxRetries: 0,
    });

    expect(report.failedChunks).toHaveLength(1);
    expect(report.failedChunks[0].message).toContain('AccessDenied');
    expect(decideExitCode(report)).toBe(EXIT_CODES.error);
  });

  it('--dry-run では走査も呼び出しも行わない', async () => {
    const report = await runVerification({ target: { ...target, dryRun: true } });

    expect(report.chunkCount).toBe(0);
    expect(report.plan.targetPairCount).toBe(0);
    expect(report.calls).toEqual({ getItem: 0, mget: 0, bedrock: 0 });
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

describe('parseVerifyArgs', () => {
  it('既定値を返し、環境変数からベース URL を解決する', () => {
    const options = parseVerifyArgs([], { VECTOR_SEARCH_API_URL: 'https://api.test.invalid/api' });

    expect(options.tableName).toBe(DEFAULT_VECTOR_TABLE_NAME);
    expect(options.baseUrl).toBe('https://api.test.invalid/api');
    expect(options.baseUrlSource).toBe('VECTOR_SEARCH_API_URL');
    expect(options.languages).toEqual(['ja', 'en']);
    expect(options.chunkSize).toBe(VERIFY_CHUNK_SIZE);
    expect(options.dryRun).toBe(false);
  });

  it('--language を絞り込める', () => {
    expect(parseVerifyArgs(['--language', 'ja'], {}).languages).toEqual(['ja']);
    expect(parseVerifyArgs(['--language', 'en,ja'], {}).languages).toEqual(['en', 'ja']);
    expect(() => parseVerifyArgs(['--language', 'fr'], {})).toThrow(VerifyArgumentError);
  });

  it('--chunk-size は検証経路の上限を超えられない', () => {
    expect(parseVerifyArgs(['--chunk-size', '50'], {}).chunkSize).toBe(50);
    expect(() =>
      parseVerifyArgs(['--chunk-size', String(MAX_VERIFICATION_ITEM_IDS + 1)], {})
    ).toThrow(VerifyArgumentError);
  });
});

describe('verifyReportFileName', () => {
  it('docs/measurements/verify-<date>.json の形になる', () => {
    expect(verifyReportFileName('2026-01-02T03:04:05.678Z')).toBe(
      'verify-2026-01-02T03-04-05-678Z.json'
    );
  });
});
