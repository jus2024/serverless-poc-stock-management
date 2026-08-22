import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  MAX_TOP_K,
  MIN_TOP_K,
  TOP_K_ALLOWED_RANGE,
  isValidTopK,
  normalizeTopK,
} from './topk';

/**
 * TopK 正規化の property テスト（task 3.10）。
 *
 * 検索 API はモックすら不要。`normalizeTopK()` が `ok: false` を返す入力に対して
 * 呼び出し側が検索 API を呼ばないこと（要件 8.5）を、正規化結果が検索を許可しない
 * 形（`appliedTopK` を持たない）であることとして検証する。
 */
describe('normalizeTopK', () => {
  /** 境界を含む数値と、数値以外の型を混ぜた入力 */
  const topKInputArb = fc.oneof(
    fc.integer({ min: -8, max: 250 }),
    fc.constantFrom(
      0,
      MIN_TOP_K,
      MIN_TOP_K - 1,
      MAX_TOP_K - 1,
      MAX_TOP_K,
      MAX_TOP_K + 1,
      1000,
      Number.MAX_SAFE_INTEGER,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -0
    ),
    fc.double(),
    fc.float(),
    fc.bigInt(),
    fc.string(),
    fc.anything()
  );

  // Feature: vector-search-comparison, Property 19: TopK 正規化の全域性
  // 任意の数値入力に対して、適用 TopK は 1 以上 100 以下の整数であるか、または検証エラーとなる。
  // 1 以上 100 以下の整数入力では適用値が入力と等しく、101 以上の整数入力では適用値が 100 になり
  // 要求値が保持される。整数以外または 0 以下の入力では検索 API が呼ばれず、
  // 許容範囲（1 以上 100 以下の整数）を示す情報を含む検証エラーになる。
  // **Validates: Requirements 8.3, 8.4, 8.5, 11.5**
  it('任意の入力に対して 1〜100 の整数の適用値か、許容範囲付きの検証エラーを返す', () => {
    fc.assert(
      fc.property(topKInputArb, (input) => {
        // 検索 API の呼び出しを模した記録。正規化が通った場合のみ呼ばれる
        const searchCalls: number[] = [];
        const result = normalizeTopK(input);
        if (result.ok) searchCalls.push(result.appliedTopK);

        const isAcceptable = typeof input === 'number' && Number.isInteger(input) && input >= MIN_TOP_K;
        expect(result.ok).toBe(isAcceptable);

        if (result.ok) {
          // 適用値は常に 1 以上 100 以下の整数
          expect(Number.isInteger(result.appliedTopK)).toBe(true);
          expect(result.appliedTopK).toBeGreaterThanOrEqual(MIN_TOP_K);
          expect(result.appliedTopK).toBeLessThanOrEqual(MAX_TOP_K);
          expect(isValidTopK(result.appliedTopK)).toBe(true);

          // 要求値は丸めても保持される
          expect(result.requestedTopK).toBe(input);
          expect(result.maxTopK).toBe(MAX_TOP_K);
          expect(result.allowedRange).toEqual(TOP_K_ALLOWED_RANGE);

          if ((input as number) <= MAX_TOP_K) {
            expect(result.appliedTopK).toBe(input);
            expect(result.clamped).toBe(false);
          } else {
            expect(result.appliedTopK).toBe(MAX_TOP_K);
            expect(result.clamped).toBe(true);
          }

          expect(searchCalls).toEqual([result.appliedTopK]);
        } else {
          // 検証エラーでは検索 API を呼ばない
          expect(searchCalls).toEqual([]);
          expect(result.errorCode).toBe('INVALID_TOPK');
          expect(result.allowedRange).toEqual({ min: MIN_TOP_K, max: MAX_TOP_K, integerOnly: true });
          expect(result.message).toContain(`${MIN_TOP_K} 以上 ${MAX_TOP_K} 以下の整数`);
          expect(result.receivedType).toBe(typeof input);
          expect(typeof result.received).toBe('string');
          expect('appliedTopK' in result).toBe(false);
        }
      }),
      { numRuns: 100 }
    );
  });
});
