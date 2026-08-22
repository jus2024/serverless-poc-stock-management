import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  DYNAMODB_MAX_VECTOR_DIMENSIONS,
  EFFECTIVE_MAX_VECTOR_DIMENSIONS,
  MIN_VECTOR_DIMENSIONS,
  OPENSEARCH_MAX_VECTOR_DIMENSIONS,
  VECTOR_DIMENSIONS_RANGES,
  validateDimensions,
  type VectorDimensionScope,
} from './constraints';

/**
 * 次元数バリデーションの property テスト（task 3.10）。
 *
 * 「いずれのリソースも作成されない」ことは、検証失敗の結果がリソース定義に使う
 * 次元数（`indexDimensions` / `fieldDimensions`）を持たないこととして検証する。
 * 呼び出し側は検証を通らない値からインデックス定義・マッピングを組み立てられない。
 */
describe('validateDimensions', () => {
  const scopeArb = fc.constantFrom<VectorDimensionScope>('dynamodb', 'opensearch', 'effective');

  /** 境界を含む整数と、範囲外・整数以外の値 */
  const dimensionsArb = fc.oneof(
    fc.integer({ min: -8, max: 20000 }),
    fc.constantFrom(
      0,
      MIN_VECTOR_DIMENSIONS,
      MIN_VECTOR_DIMENSIONS - 1,
      256,
      512,
      1024,
      DYNAMODB_MAX_VECTOR_DIMENSIONS - 1,
      DYNAMODB_MAX_VECTOR_DIMENSIONS,
      DYNAMODB_MAX_VECTOR_DIMENSIONS + 1,
      OPENSEARCH_MAX_VECTOR_DIMENSIONS - 1,
      OPENSEARCH_MAX_VECTOR_DIMENSIONS,
      OPENSEARCH_MAX_VECTOR_DIMENSIONS + 1,
      1024.5,
      Number.NaN,
      Number.POSITIVE_INFINITY
    ),
    fc.double(),
    fc.string(),
    fc.anything()
  );

  // Feature: vector-search-comparison, Property 17: 次元数バリデーションの境界と 2 本の一致
  // 任意の整数に対して、DynamoDB 側の次元数は 1 以上 4,096 以下のときのみ受理され、
  // OpenSearch 側の次元数は 1 以上 16,000 以下のときのみ受理され、本機能の実効許容範囲は
  // 1 以上 4,096 以下である。範囲外の場合は指定値とバックエンド別の許容範囲を含むエラーが返り、
  // いずれのリソースも作成されない。受理される任意の次元数に対して、2 本のベクトルインデックスの
  // 次元数および 2 つの knn_vector フィールドの次元数はすべて等しい。
  // **Validates: Requirements 5.2, 6.4, 6.11**
  it('バックエンド別の境界どおりに受理し、受理時は 2 本のインデックスと 2 つのフィールドの次元数が等しい', () => {
    // 実効範囲は 2 つの上限の小さい方（= DynamoDB の 4,096）
    expect(MIN_VECTOR_DIMENSIONS).toBe(1);
    expect(DYNAMODB_MAX_VECTOR_DIMENSIONS).toBe(4096);
    expect(OPENSEARCH_MAX_VECTOR_DIMENSIONS).toBe(16000);
    expect(EFFECTIVE_MAX_VECTOR_DIMENSIONS).toBe(
      Math.min(DYNAMODB_MAX_VECTOR_DIMENSIONS, OPENSEARCH_MAX_VECTOR_DIMENSIONS)
    );
    expect(VECTOR_DIMENSIONS_RANGES.effective.max).toBe(DYNAMODB_MAX_VECTOR_DIMENSIONS);

    fc.assert(
      fc.property(scopeArb, dimensionsArb, (scope, dimensions) => {
        const range = VECTOR_DIMENSIONS_RANGES[scope];
        const result = validateDimensions(dimensions, scope);

        const isAcceptable =
          typeof dimensions === 'number' &&
          Number.isInteger(dimensions) &&
          dimensions >= MIN_VECTOR_DIMENSIONS &&
          dimensions <= range.max;
        expect(result.ok).toBe(isAcceptable);

        if (result.ok) {
          expect(result.dimensions).toBe(dimensions);
          expect(result.scope).toBe(scope);
          expect(result.allowedRange).toEqual(range);

          // 2 本のベクトルインデックスと 2 つの knn_vector フィールドの次元数はすべて等しい
          expect(Object.keys(result.indexDimensions).sort()).toEqual([
            'byEmbeddingEn',
            'byEmbeddingJa',
          ]);
          expect(Object.keys(result.fieldDimensions).sort()).toEqual([
            'embeddingEn',
            'embeddingJa',
          ]);
          const applied = [
            ...Object.values(result.indexDimensions),
            ...Object.values(result.fieldDimensions),
          ];
          expect(applied).toHaveLength(4);
          expect(new Set(applied).size).toBe(1);
          expect(applied.every((value) => value === dimensions)).toBe(true);
        } else {
          expect(result.errorCode).toBe('INVALID_DIMENSIONS');
          expect(result.scope).toBe(scope);
          expect(result.receivedType).toBe(typeof dimensions);

          // 指定値とバックエンド別の許容範囲がエラーに含まれる
          expect(result.message).toContain(result.received);
          expect(result.message).toContain(`${MIN_VECTOR_DIMENSIONS}〜${DYNAMODB_MAX_VECTOR_DIMENSIONS}`);
          expect(result.message).toContain(
            `${MIN_VECTOR_DIMENSIONS}〜${OPENSEARCH_MAX_VECTOR_DIMENSIONS}`
          );
          expect(result.allowedRange).toEqual(range);
          expect(result.backendRanges.dynamodb.max).toBe(DYNAMODB_MAX_VECTOR_DIMENSIONS);
          expect(result.backendRanges.opensearch.max).toBe(OPENSEARCH_MAX_VECTOR_DIMENSIONS);
          expect(result.backendRanges.effective.max).toBe(EFFECTIVE_MAX_VECTOR_DIMENSIONS);

          // 検証を通らない値からはリソース定義に使う次元数が得られない
          expect('indexDimensions' in result).toBe(false);
          expect('fieldDimensions' in result).toBe(false);
        }
      }),
      { numRuns: 100 }
    );

    // 実効範囲は DynamoDB 側の上限で決まる。OpenSearch 単体では受理される値も実効では拒否する
    fc.assert(
      fc.property(
        fc.integer({
          min: DYNAMODB_MAX_VECTOR_DIMENSIONS + 1,
          max: OPENSEARCH_MAX_VECTOR_DIMENSIONS,
        }),
        (dimensions) => {
          expect(validateDimensions(dimensions, 'opensearch').ok).toBe(true);
          expect(validateDimensions(dimensions, 'dynamodb').ok).toBe(false);
          expect(validateDimensions(dimensions, 'effective').ok).toBe(false);
          // 既定は実効範囲
          expect(validateDimensions(dimensions).ok).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});
