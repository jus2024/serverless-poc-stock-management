import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_QUERY_SEED,
  MIN_PAIRED_QUERY_COUNT,
  PAIRED_QUERY_SET,
  selectQueryOrder,
  validatePairedQuerySet,
  type PairedQuery,
  type QueryIntent,
} from './paired-queries';

/**
 * Paired_Query_Set の property テスト（task 5.4）。
 *
 * 「任意の Paired_Query_Set」の供給源は 2 つ。固定集合を任意のシードで並べ替えたものと、
 * 合成した任意の集合である。前者は実際に測定で使う集合そのものを対象にでき、
 * 後者は件数・識別子・文字列の組み合わせを広く動かせる。
 *
 * 合成集合の識別子は `syn-` 接頭辞を付ける。固定集合の識別子（`q01`〜`q60`）と衝突すると
 * 「同一識別子なら同一のペアである」という検証が誤って失敗するためである。
 *
 * 要件: 13.6, 13.7
 */

const intentArb = fc.constantFrom<QueryIntent>('flavor', 'body', 'origin', 'usage', 'material');

/** 固定集合を任意のシードで並べ替えたもの。選定順序のみが変わる */
const orderedFixedSetArb: fc.Arbitrary<readonly PairedQuery[]> = fc
  .oneof(fc.integer(), fc.constant(DEFAULT_QUERY_SEED))
  .map((seed) => selectQueryOrder(seed));

/** 下限件数以上の合成集合。識別子・日本語・英語はいずれも一意で非空 */
const syntheticSetArb: fc.Arbitrary<readonly PairedQuery[]> = fc
  .uniqueArray(fc.integer({ min: 0, max: 999 }), {
    minLength: MIN_PAIRED_QUERY_COUNT,
    maxLength: 80,
  })
  .chain((numbers) =>
    fc.tuple(
      fc.constant(numbers),
      fc.array(intentArb, { minLength: numbers.length, maxLength: numbers.length })
    )
  )
  .map(([numbers, intents]) =>
    numbers.map((value, index) => ({
      id: `syn-${value}`,
      ja: `日本語クエリ ${value}`,
      en: `english query ${value}`,
      intent: intents[index],
    }))
  );

const pairedQuerySetArb = fc.oneof(orderedFixedSetArb, syntheticSetArb);

describe('Paired_Query_Set', () => {
  // Feature: vector-search-comparison, Property 44: Paired_Query_Set の 1 対 1 対応
  // 任意の Paired_Query_Set に対して、日本語クエリ列と英語クエリ列の要素数は等しく、
  // 識別子は一意であり、日本語要素と英語要素の対応は全単射である。
  // 両言語のクエリ文字列はいずれも非空である。
  // **Validates: Requirements 13.7**
  it('日英の要素数が等しく、識別子は一意で、日英の対応は全単射である', () => {
    fc.assert(
      fc.property(pairedQuerySetArb, (queries) => {
        // 検証を通る集合のみが測定に進む（要件 13.6 の下限件数を含む）
        expect(() => validatePairedQuerySet(queries)).not.toThrow();
        expect(queries.length).toBeGreaterThanOrEqual(MIN_PAIRED_QUERY_COUNT);

        const ids = queries.map((query) => query.id);
        const jaQueries = queries.map((query) => query.ja);
        const enQueries = queries.map((query) => query.en);

        // 日本語クエリ列と英語クエリ列の要素数は等しい
        expect(jaQueries).toHaveLength(queries.length);
        expect(enQueries).toHaveLength(queries.length);
        expect(jaQueries.length).toBe(enQueries.length);

        // 識別子は一意
        expect(new Set(ids).size).toBe(queries.length);

        // 日英の対応は全単射（各日本語に対応する英語が 1 つ、逆も 1 つ）
        expect(new Set(jaQueries).size).toBe(queries.length);
        expect(new Set(enQueries).size).toBe(queries.length);

        const jaToEn = new Map<string, string>();
        const enToJa = new Map<string, string>();
        queries.forEach((query) => {
          jaToEn.set(query.ja, query.en);
          enToJa.set(query.en, query.ja);
        });
        expect(jaToEn.size).toBe(queries.length);
        expect(enToJa.size).toBe(queries.length);
        queries.forEach((query) => {
          expect(jaToEn.get(query.ja)).toBe(query.en);
          expect(enToJa.get(query.en)).toBe(query.ja);
          expect(enToJa.get(jaToEn.get(query.ja) as string)).toBe(query.ja);
        });

        // 両言語のクエリ文字列はいずれも非空
        queries.forEach((query) => {
          expect(query.ja.trim().length).toBeGreaterThan(0);
          expect(query.en.trim().length).toBeGreaterThan(0);
          expect(query.id.trim().length).toBeGreaterThan(0);
        });

        // 選定順序が変わっても組そのものは不変（固定集合由来の要素は元の組と一致する）
        const fixedById = new Map(PAIRED_QUERY_SET.map((query) => [query.id, query]));
        queries.forEach((query) => {
          const original = fixedById.get(query.id);
          if (original !== undefined) {
            expect(query).toEqual(original);
          }
        });
      }),
      { numRuns: 100 }
    );
  });
});
