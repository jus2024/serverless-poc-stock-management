/**
 * `verification-summary.ts` の単体テストと property テスト（task 17.1）
 *
 * 検証対象は Correctness Property 58（検証結果の集計整合性と終了判定）と、
 * 旧実装の欠陥（`verifiedMismatchedCount 1712` でも `failedCount 0` / `COMPLETED`）が
 * 再発したら落ちる回帰テストである。
 *
 * AWS へは一切触れない（純関数のみ）。
 *
 * 要件: 3.6, 3.12, 3.17, 3.18
 * Property: 22, 58
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { VECTOR_LANGUAGES, type VectorLanguage } from './language';
import {
  MAX_VERIFICATION_REASON_LENGTH,
  addVerificationCounts,
  emptyVerificationCounts,
  resolveVerificationRunStatus,
  summarizeVerification,
  sumVerificationCounts,
  type VerificationCounts,
  type VerificationMismatchKey,
} from './verification-summary';

// ---------------------------------------------------------------------------
// 生成器
// ---------------------------------------------------------------------------

/** 任意の件数の組。整合しているものも矛盾しているものも生む */
const arbitraryCounts = (): fc.Arbitrary<VerificationCounts> =>
  fc.record({
    targetCount: fc.nat({ max: 20_000 }),
    matchedCount: fc.nat({ max: 20_000 }),
    mismatchedCount: fc.nat({ max: 20_000 }),
    missingCount: fc.nat({ max: 20_000 }),
  });

/**
 * 整合している件数の組。対象件数を 3 つの内訳の和として組み立てる。
 * 「一致 + 不一致 + 未格納 = 対象件数」が成り立つ入力に対する合否の判定を見る。
 */
const consistentCounts = (): fc.Arbitrary<VerificationCounts> =>
  fc
    .tuple(fc.nat({ max: 5_000 }), fc.nat({ max: 5_000 }), fc.nat({ max: 5_000 }))
    .map(([matchedCount, mismatchedCount, missingCount]) => ({
      targetCount: matchedCount + mismatchedCount + missingCount,
      matchedCount,
      mismatchedCount,
      missingCount,
    }));

const arbitraryLanguage = (): fc.Arbitrary<VectorLanguage> => fc.constantFrom(...VECTOR_LANGUAGES);

const arbitraryKeys = (): fc.Arbitrary<VerificationMismatchKey[]> =>
  fc.array(
    fc.record({
      itemId: fc.string({ minLength: 1, maxLength: 20 }),
      language: arbitraryLanguage(),
      reason: fc.string({ maxLength: 400 }),
    }),
    { maxLength: 30 }
  );

/** 値がベクトル本体（数値配列）でないこと */
function containsNumberArray(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((element) => typeof element === 'number');
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsNumberArray);
  }
  return false;
}

// ---------------------------------------------------------------------------
// 単体テスト
// ---------------------------------------------------------------------------

describe('summarizeVerification', () => {
  it('整合した全件一致を合格として集計する', () => {
    const summary = summarizeVerification({
      targetCount: 10_000,
      matchedCount: 10_000,
      mismatchedCount: 0,
      missingCount: 0,
    });

    expect(summary.consistent).toBe(true);
    expect(summary.passed).toBe(true);
    expect(summary.failedCount).toBe(0);
    expect(summary.mismatchedKeys).toEqual([]);
    expect(resolveVerificationRunStatus(summary)).toBe('COMPLETED');
  });

  it('不一致が 1 件でもあれば不合格とし、失敗件数へ計上する', () => {
    const summary = summarizeVerification(
      { targetCount: 10_000, matchedCount: 9_999, mismatchedCount: 1, missingCount: 0 },
      [{ itemId: 'ITEM-1', language: 'ja', reason: 'VALUE_MISMATCH: 第 0 次元が一致しません。' }]
    );

    expect(summary.passed).toBe(false);
    expect(summary.failedCount).toBe(1);
    expect(resolveVerificationRunStatus(summary)).toBe('VERIFICATION_FAILED');
  });

  it('未格納のみでも不合格とし、失敗件数へ計上する', () => {
    const summary = summarizeVerification({
      targetCount: 4,
      matchedCount: 3,
      mismatchedCount: 0,
      missingCount: 1,
    });

    expect(summary.passed).toBe(false);
    expect(summary.failedCount).toBe(1);
    expect(resolveVerificationRunStatus(summary)).toBe('VERIFICATION_FAILED');
  });

  /**
   * 旧実装の欠陥の回帰テスト。
   *
   * タスク 13.11 の実測値（`verifiedMatchedCount 0` / `verifiedMismatchedCount 1712`）を
   * そのまま入力し、`failedCount 0` / `COMPLETED` に戻ったら落ちるようにする。
   */
  it('実測値（一致 0 / 不一致 1712）を COMPLETED にしない', () => {
    const summary = summarizeVerification({
      targetCount: 1_712,
      matchedCount: 0,
      mismatchedCount: 1_712,
      missingCount: 0,
    });

    expect(summary.failedCount).toBe(1_712);
    expect(summary.passed).toBe(false);
    expect(resolveVerificationRunStatus(summary)).not.toBe('COMPLETED');
  });

  it('集計が整合しない場合は合格にしない', () => {
    // 数え落ち（一致 + 不一致 + 未格納 < 対象件数）。失敗 0 でも合格にしない
    const summary = summarizeVerification({
      targetCount: 10,
      matchedCount: 9,
      mismatchedCount: 0,
      missingCount: 0,
    });

    expect(summary.consistent).toBe(false);
    expect(summary.failedCount).toBe(0);
    expect(summary.passed).toBe(false);
    expect(resolveVerificationRunStatus(summary)).toBe('VERIFICATION_FAILED');
  });

  it('非整数・負値・非有限値を 0 として扱い例外を投げない', () => {
    const summary = summarizeVerification({
      targetCount: Number.NaN,
      matchedCount: -5,
      mismatchedCount: 1.9,
      missingCount: Number.POSITIVE_INFINITY,
    });

    expect(summary.targetCount).toBe(0);
    expect(summary.matchedCount).toBe(0);
    expect(summary.mismatchedCount).toBe(1);
    expect(summary.missingCount).toBe(0);
    expect(summary.failedCount).toBe(1);
    expect(summary.passed).toBe(false);
  });

  it('識別子を 3 フィールドへ正規化し、余分なフィールドを出力へ通さない', () => {
    // 型に反する入力（ベクトル本体が付いた識別子）を実行時に渡しても応答へ漏れない
    const polluted = [
      {
        itemId: 'ITEM-1',
        language: 'en',
        reason: 'MISSING_OPENSEARCH',
        embeddingJa: [0.1, 0.2, 0.3],
      },
    ] as unknown as VerificationMismatchKey[];

    const summary = summarizeVerification(
      { targetCount: 1, matchedCount: 0, mismatchedCount: 0, missingCount: 1 },
      polluted
    );

    expect(summary.mismatchedKeys).toHaveLength(1);
    expect(Object.keys(summary.mismatchedKeys[0]).sort()).toEqual([
      'itemId',
      'language',
      'reason',
    ]);
    expect(containsNumberArray(summary.mismatchedKeys)).toBe(false);
  });

  it('理由を上限文字数で打ち切る', () => {
    const summary = summarizeVerification(
      { targetCount: 1, matchedCount: 0, mismatchedCount: 1, missingCount: 0 },
      [{ itemId: 'ITEM-1', language: 'ja', reason: 'x'.repeat(1_000) }]
    );

    expect(summary.mismatchedKeys[0].reason).toHaveLength(MAX_VERIFICATION_REASON_LENGTH);
  });

  it('引数を変更しない', () => {
    const counts: VerificationCounts = {
      targetCount: 2,
      matchedCount: 1,
      mismatchedCount: 1,
      missingCount: 0,
    };
    const keys: VerificationMismatchKey[] = [
      { itemId: 'ITEM-1', language: 'ja', reason: 'VALUE_MISMATCH' },
    ];

    summarizeVerification(counts, keys);

    expect(counts).toEqual({
      targetCount: 2,
      matchedCount: 1,
      mismatchedCount: 1,
      missingCount: 0,
    });
    expect(keys).toEqual([{ itemId: 'ITEM-1', language: 'ja', reason: 'VALUE_MISMATCH' }]);
  });
});

describe('件数の合成', () => {
  it('空の組は全項目 0 である', () => {
    expect(emptyVerificationCounts()).toEqual({
      targetCount: 0,
      matchedCount: 0,
      mismatchedCount: 0,
      missingCount: 0,
    });
  });

  it('言語別の和と合計が一致する', () => {
    const ja: VerificationCounts = {
      targetCount: 5_000,
      matchedCount: 4_999,
      mismatchedCount: 1,
      missingCount: 0,
    };
    const en: VerificationCounts = {
      targetCount: 5_000,
      matchedCount: 4_998,
      mismatchedCount: 0,
      missingCount: 2,
    };

    expect(sumVerificationCounts([ja, en])).toEqual(addVerificationCounts(ja, en));
    expect(sumVerificationCounts([ja, en])).toEqual({
      targetCount: 10_000,
      matchedCount: 9_997,
      mismatchedCount: 1,
      missingCount: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// property テスト
// ---------------------------------------------------------------------------

// Feature: vector-search-comparison, Property 58: 検証結果の集計整合性と終了判定
// 任意の 検証件数の組（対象件数・一致・不一致・未格納）に対して、一致件数と不一致件数と
// 未格納件数の和が対象件数と等しいときのみ整合と判定され、合格と判定されるのは不一致件数と
// 未格納件数がともに 0 の場合のみである。失敗件数として計上される値は不一致件数と未格納件数の
// 和と等しい。合格でない任意の組に対して、実行状態が COMPLETED として終了することはない。
// 任意の 不一致の識別子集合に対して、出力される識別子の件数は与えた識別子の件数と等しく、
// 出力にベクトル本体（次元数と同じ長さの数値配列）が現れない。
// **Validates: Requirements 3.6, 3.12, 3.17, 3.18**
describe('Property 58: 検証結果の集計整合性と終了判定', () => {
  it('失敗件数は不一致件数と未格納件数の和と等しい', () => {
    fc.assert(
      fc.property(arbitraryCounts(), (counts) => {
        const summary = summarizeVerification(counts);
        expect(summary.failedCount).toBe(summary.mismatchedCount + summary.missingCount);
      }),
      { numRuns: 100 }
    );
  });

  it('整合と判定されるのは 3 つの内訳の和が対象件数と等しいときのみである', () => {
    fc.assert(
      fc.property(arbitraryCounts(), (counts) => {
        const summary = summarizeVerification(counts);
        const sum = summary.matchedCount + summary.mismatchedCount + summary.missingCount;
        expect(summary.consistent).toBe(sum === summary.targetCount);
      }),
      { numRuns: 100 }
    );
  });

  it('合格になるのは失敗件数 0 かつ整合しているときのみである', () => {
    fc.assert(
      fc.property(arbitraryCounts(), (counts) => {
        const summary = summarizeVerification(counts);
        expect(summary.passed).toBe(summary.failedCount === 0 && summary.consistent);
        // 「合格 → 失敗件数 0」の含意（要件 3.18 の必要条件）
        if (summary.passed) {
          expect(summary.mismatchedCount).toBe(0);
          expect(summary.missingCount).toBe(0);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('整合した組では、不一致と未格納がともに 0 のときに限り合格になる', () => {
    fc.assert(
      fc.property(consistentCounts(), (counts) => {
        const summary = summarizeVerification(counts);
        expect(summary.consistent).toBe(true);
        expect(summary.passed).toBe(counts.mismatchedCount + counts.missingCount === 0);
      }),
      { numRuns: 100 }
    );
  });

  it('合格でない組の実行状態は COMPLETED にならない', () => {
    fc.assert(
      fc.property(arbitraryCounts(), arbitraryKeys(), (counts, keys) => {
        const summary = summarizeVerification(counts, keys);
        const status = resolveVerificationRunStatus(summary);
        expect(status === 'COMPLETED').toBe(summary.passed);
        if (!summary.passed) expect(status).toBe('VERIFICATION_FAILED');
      }),
      { numRuns: 100 }
    );
  });

  it('識別子の件数を変えず、3 フィールドのみでベクトル本体を含めない', () => {
    fc.assert(
      fc.property(arbitraryCounts(), arbitraryKeys(), (counts, keys) => {
        const summary = summarizeVerification(counts, keys);

        expect(summary.mismatchedKeys).toHaveLength(keys.length);
        for (const key of summary.mismatchedKeys) {
          expect(Object.keys(key).sort()).toEqual(['itemId', 'language', 'reason']);
          expect(key.reason.length).toBeLessThanOrEqual(MAX_VERIFICATION_REASON_LENGTH);
        }
        expect(containsNumberArray(summary.mismatchedKeys)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('同一入力に対して同一の出力を返す（純関数）', () => {
    fc.assert(
      fc.property(arbitraryCounts(), arbitraryKeys(), (counts, keys) => {
        expect(summarizeVerification(counts, keys)).toEqual(summarizeVerification(counts, keys));
      }),
      { numRuns: 100 }
    );
  });
});
