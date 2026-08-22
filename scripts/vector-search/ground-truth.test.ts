import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DISTINCT_SKU_K_VALUES,
  GROUND_TRUTH_TIE_EPSILON,
  GroundTruthError,
  buildGroundTruth,
  buildGroundTruths,
  buildUniqueVectorSet,
  cosineDistance,
  deserializeUniqueVectorSet,
  filterRowsByWarehouse,
  loadUniqueVectorSet,
  rankUniqueVectors,
  restrictUniqueVectorSetToWarehouse,
  serializeUniqueVectorSet,
  uniqueVectorCacheFileName,
  type UniqueVectorSetCache,
  type VectorLanguage,
  type VectorRecordRow,
  type VectorRecordSource,
} from './ground-truth';
import { selectQueryOrder } from './paired-queries';
import { countExactDistanceTies, recallAtK, type RecallHit } from './recall';

/**
 * Ground_Truth 構築の property テスト（task 5.4）。
 *
 * AWS へは一切接続しない。Vector_Table の読み出しとキャッシュはインターフェース
 * （{@link VectorRecordSource} / {@link UniqueVectorSetCache}）越しに行われるため、
 * ここではメモリ実装を注入する。距離計算・重複排除・順位付けは純関数なので
 * 追加の差し替えも要らない。
 *
 * 次元数は 4 に固定する。コサイン距離の値域・対称性・自己距離は次元数に依存せず、
 * 1,024 次元で 100 回反復する意味がないためである（Property 37 のみ 1〜8 次元を走らせる）。
 *
 * 要件: 13.1, 13.2, 13.10, 13.12, 13.13, 13.14
 */

// ============================================================
// 生成器と補助
// ============================================================

/** テストで使う次元数。値域・対称性・順位付けの性質は次元数に依存しない */
const DIMENSIONS = 4;

/** SKU の itemId プール。資材パターン（`ITEM#MAT-`）に一致しない形にしてある */
const ITEM_ID_POOL = [
  'ITEM#BR-SANTOS-A-MEDIUM-G200-V1',
  'ITEM#BR-SANTOS-A-MEDIUM-G200-V2',
  'ITEM#CO-SUPREMO-A-CITY-G500-V1',
  'ITEM#CO-SUPREMO-A-CITY-G500-V2',
  'ITEM#ET-YIRGA-A-LIGHT-G200-V1',
  'ITEM#ET-YIRGA-A-LIGHT-G200-V2',
  'ITEM#GT-SHB-A-FRENCH-G1000-V1',
  'ITEM#KE-AA-A-MEDIUM-G200-V1',
] as const;

/** 1 SKU が占める倉庫行（前提 A11） */
const WAREHOUSE_IDS = ['WH-001', 'WH-002', 'WH-003'] as const;

/** キャッシュのメタデータに載せる固定時刻。Ground_Truth の値には影響しない */
const FIXED_GENERATED_AT = '2026-08-05T00:00:00.000Z';

const componentArb = fc.double({ min: -4, max: 4, noNaN: true });

/** 指定次元数のベクトル */
function vectorArb(dimensions: number): fc.Arbitrary<number[]> {
  return fc.array(componentArb, { minLength: dimensions, maxLength: dimensions });
}

/**
 * 非ゼロベクトル。float32 に丸めた結果が全要素 0 になる場合（1e-300 等）は
 * 先頭要素を 1 に置き換えてノルムを非ゼロにする。
 */
function nonZeroVectorArb(dimensions: number): fc.Arbitrary<number[]> {
  return vectorArb(dimensions).map((values) =>
    values.some((value) => Math.fround(value) !== 0) ? values : [1, ...values.slice(1)]
  );
}

/** 1 SKU につき 3 倉庫行を作る。3 行は同一ベクトルを持つ（前提 A11） */
function buildWarehouseRows(
  itemId: string,
  embedding: readonly number[],
  warehouseIds: readonly string[] = WAREHOUSE_IDS
): VectorRecordRow[] {
  return warehouseIds.map((warehouseId) => ({ itemId, warehouseId, embedding }));
}

/** Vector_Table の Scan を模した実装。AWS 認証情報もネットワークも使わない */
function createFakeVectorRecordSource(
  rowsByLanguage: Record<VectorLanguage, readonly VectorRecordRow[]>
): VectorRecordSource & { readonly calls: VectorLanguage[] } {
  const calls: VectorLanguage[] = [];
  return {
    calls,
    async scanVectorRecords(request) {
      calls.push(request.language);
      const rows = rowsByLanguage[request.language];
      return { rows, scannedRecordCount: rows.length, missingEmbeddingCount: 0 };
    },
  };
}

/** メモリ上のキャッシュ実装。ファイルシステムに触れない */
function createMemoryCache(): UniqueVectorSetCache & { readonly files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async read(fileName) {
      return files.get(fileName) ?? null;
    },
    async write(fileName, contents) {
      files.set(fileName, contents);
    },
  };
}

/** 距離が完全一致する行の件数を、実装とは別の手順（昇順に並べて連続区間を数える）で求める */
function countExactTieRowsIndependently(distances: readonly number[]): {
  rowCount: number;
  groupCount: number;
  maxGroupSize: number;
} {
  const sorted = distances.filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b);
  let rowCount = 0;
  let groupCount = 0;
  let maxGroupSize = 0;
  let index = 0;

  while (index < sorted.length) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[index]) {
      end += 1;
    }
    const size = end - index + 1;
    if (size >= 2) {
      rowCount += size;
      groupCount += 1;
      maxGroupSize = Math.max(maxGroupSize, size);
    }
    index = end + 1;
  }

  return { rowCount, groupCount, maxGroupSize };
}

// ============================================================
// Property 37
// ============================================================

describe('cosineDistance', () => {
  // Feature: vector-search-comparison, Property 37: コサイン距離の基本性質
  // 任意の 同一次元の非ゼロベクトル対に対して、コサイン距離は 0 以上 2 以下であり、
  // 引数を入れ替えても値が変わらず、同一ベクトル同士の距離は 0（浮動小数誤差の範囲内）である。
  // **Validates: Requirements 13.1**
  it('値域 0〜2・引数の対称性・自己距離 0 を満たす', () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 1, max: 8 })
          .chain((dimensions) =>
            fc.tuple(nonZeroVectorArb(dimensions), nonZeroVectorArb(dimensions))
          ),
        ([left, right]) => {
          const distance = cosineDistance(left, right);

          // 値域は 1 - cos の形から 0〜2
          expect(Number.isFinite(distance)).toBe(true);
          expect(distance).toBeGreaterThanOrEqual(0);
          expect(distance).toBeLessThanOrEqual(2);

          // 対称性は完全一致で成立する（内積とノルムの累積順序が入れ替わらない）
          expect(cosineDistance(right, left)).toBe(distance);

          // 自己距離は sqrt(n) * sqrt(n) の丸め誤差分だけ 0 からずれる。
          // 同値判定の閾値 1e-6 より十分小さいことを確認する
          expect(Math.abs(cosineDistance(left, left))).toBeLessThanOrEqual(
            GROUND_TRUTH_TIE_EPSILON
          );
          expect(Math.abs(cosineDistance(right, right))).toBeLessThanOrEqual(
            GROUND_TRUTH_TIE_EPSILON
          );
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ============================================================
// Property 42
// ============================================================

describe('rankUniqueVectors / buildGroundTruth', () => {
  /**
   * 同値を含むベクトル集合の種。
   *
   * - `baseIndex` が同じで `delta` が 0 の SKU 同士は**完全同値**になる
   * - `delta` が ±1e-7 の SKU は基準ベクトルとの距離差が 1e-6 以下に収まりやすく、
   *   閾値による**近似同値**を作る
   */
  const tieSeedsArb = fc.uniqueArray(
    fc.record({
      itemId: fc.constantFrom(...ITEM_ID_POOL),
      baseIndex: fc.nat({ max: 2 }),
      delta: fc.constantFrom(0, 1e-7, -1e-7),
    }),
    { minLength: 2, maxLength: ITEM_ID_POOL.length, selector: (seed) => seed.itemId }
  );

  // Feature: vector-search-comparison, Property 42: 測定の決定性と同値順位の確定
  // 任意の 乱数シードと任意の ベクトル集合（距離が 1e-6 以内で同値になる要素を含む）に対して、
  // 同一シード・同一 Paired_Query_Set での 2 回の実行は、同一の Ground_Truth 順位付けと
  // 同一の Recall_At_K を返す。同値による順位は itemId 昇順で確定し、
  // 同値により順位が一意に定まらなかった件数が出力される。
  // 任意の 返却行配列に対して、計上される完全同値行の件数は距離が完全一致する行の実際の件数と等しい。
  // **Validates: Requirements 13.10, 13.12, 13.13**
  it('2 回の実行が同一の順位付けと Recall_At_K を返し、同値は itemId 昇順で確定する', () => {
    fc.assert(
      fc.property(
        nonZeroVectorArb(DIMENSIONS),
        fc.array(nonZeroVectorArb(DIMENSIONS), { minLength: 3, maxLength: 3 }),
        tieSeedsArb,
        fc.integer(),
        fc.array(fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY), {
          maxLength: 3,
        }),
        (queryVector, bases, seeds, seed, nonFiniteDistances) => {
          const rows = seeds.flatMap((tieSeed) =>
            buildWarehouseRows(
              tieSeed.itemId,
              bases[tieSeed.baseIndex].map((value) => value + tieSeed.delta)
            )
          );
          const context = { language: 'ja' as const, dimensions: DIMENSIONS };

          // 入力行の順序を変えても同一の集合・同一の順位付けになる（再実行時の同一性）
          const first = buildUniqueVectorSet(rows, context);
          const second = buildUniqueVectorSet(rows.slice().reverse(), context);
          expect(second).toEqual(first);

          const ranking = rankUniqueVectors(queryVector, first);
          expect(rankUniqueVectors(queryVector, second)).toEqual(ranking);

          // 距離昇順、同距離は itemId 昇順で全順序が決まる
          for (let i = 1; i < ranking.entries.length; i += 1) {
            const previous = ranking.entries[i - 1];
            const current = ranking.entries[i];
            expect(previous.distance <= current.distance).toBe(true);
            if (previous.distance === current.distance) {
              expect(previous.itemId < current.itemId).toBe(true);
            }
            expect(current.rank).toBe(i + 1);
          }

          // Ground_Truth も 2 回の実行で一致する
          const truths = buildGroundTruths(queryVector, first);
          expect(buildGroundTruths(queryVector, second)).toEqual(truths);

          truths.forEach((truth) => {
            const boundaryIndex = Math.min(truth.distinctSkuK, ranking.entries.length) - 1;
            const boundaryDistance = ranking.entries[boundaryIndex].distance;

            // 同値連鎖が k の境界をまたぐときだけ「順位が一意に定まらなかった件数」を報告する
            expect(truth.ties.epsilon).toBe(GROUND_TRUTH_TIE_EPSILON);
            expect(truth.ties.ambiguousRankCount).toBe(
              truth.ties.boundaryTie ? truth.ties.boundaryEquivalentCount : 0
            );

            // k 番目と距離が完全一致した件数は、順位付け全体での完全一致件数と等しい
            expect(truth.ties.exactTieCount).toBe(
              ranking.entries.filter((entry) => entry.distance === boundaryDistance).length
            );
            expect(truth.itemIds).toEqual(
              ranking.entries.slice(0, truth.distinctSkuK).map((entry) => entry.itemId)
            );
          });

          // 同一シード・同一クエリ集合の選定順序も再現する
          expect(selectQueryOrder(seed)).toEqual(selectQueryOrder(seed));

          // 返却行（1 SKU あたり 3 行、行内は同一距離）に対する Recall_At_K の再現性
          const hits: RecallHit[] = ranking.entries.flatMap((entry, index) =>
            WAREHOUSE_IDS.map((warehouseId, offset) => ({
              itemId: entry.itemId,
              warehouseId,
              distance: entry.distance,
              rank: index * WAREHOUSE_IDS.length + offset + 1,
            }))
          );
          truths.forEach((truth) => {
            const value = recallAtK(hits, truth.itemIds, truth.distinctSkuK);
            expect(recallAtK(hits, truth.itemIds, truth.distinctSkuK)).toBe(value);
          });

          // 完全同値行の計上は実際の件数と一致し、非有限距離の行は同値判定から除かれる
          const expected = countExactTieRowsIndependently(hits.map((hit) => hit.distance));
          const report = countExactDistanceTies(hits);
          expect(report.rowCount).toBe(hits.length);
          expect(report.exactTieRowCount).toBe(expected.rowCount);
          expect(report.exactTieGroupCount).toBe(expected.groupCount);
          expect(report.maxExactTieGroupSize).toBe(expected.maxGroupSize);
          expect(report.nonFiniteDistanceCount).toBe(0);

          const withNonFinite = countExactDistanceTies([
            ...hits,
            ...nonFiniteDistances.map((distance, index) => ({
              itemId: `ITEM#NON-FINITE-${index}`,
              distance,
            })),
          ]);
          expect(withNonFinite.nonFiniteDistanceCount).toBe(nonFiniteDistances.length);
          expect(withNonFinite.exactTieRowCount).toBe(expected.rowCount);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ============================================================
// Property 43
// ============================================================

describe('loadUniqueVectorSet', () => {
  const itemIdsArb = fc.uniqueArray(fc.constantFrom(...ITEM_ID_POOL), {
    minLength: 2,
    maxLength: ITEM_ID_POOL.length,
  });

  /** itemId 列と同数のベクトル列 */
  const vectorsForArb = (itemIds: readonly string[]): fc.Arbitrary<number[][]> =>
    fc.array(nonZeroVectorArb(DIMENSIONS), {
      minLength: itemIds.length,
      maxLength: itemIds.length,
    });

  // Feature: vector-search-comparison, Property 43: Ground_Truth の言語独立性
  // 任意の 日本語ベクトル集合と英語ベクトル集合の組に対して、一方の言語のベクトルのみを
  // 変化させても他方の言語の Ground_Truth 順位付けは変化しない。
  // 言語ごとの Ground_Truth は当該言語のベクトル集合のみから決まる。
  // **Validates: Requirements 13.2**
  it('英語ベクトルを差し替えても日本語の Ground_Truth 順位付けは変化しない', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonZeroVectorArb(DIMENSIONS),
        itemIdsArb.chain((itemIds) =>
          fc.tuple(
            fc.constant(itemIds),
            vectorsForArb(itemIds),
            vectorsForArb(itemIds),
            vectorsForArb(itemIds)
          )
        ),
        async (queryVector, [itemIds, jaVectors, enVectors, enAltVectors]) => {
          const rowsFor = (vectors: readonly number[][]): VectorRecordRow[] =>
            itemIds.flatMap((itemId, index) => buildWarehouseRows(itemId, vectors[index]));

          const jaRows = rowsFor(jaVectors);
          const enRows = rowsFor(enVectors);
          const enAltRows = rowsFor(enAltVectors);

          const cache = createMemoryCache();
          const source = createFakeVectorRecordSource({ ja: jaRows, en: enRows });
          const loadOptions = {
            dimensions: DIMENSIONS,
            source,
            cache,
            generatedAt: FIXED_GENERATED_AT,
          };

          const ja = await loadUniqueVectorSet({ ...loadOptions, language: 'ja' });
          const en = await loadUniqueVectorSet({ ...loadOptions, language: 'en' });

          // 言語ごとに独立した集合とキャッシュファイルになる
          expect(ja.set.language).toBe('ja');
          expect(en.set.language).toBe('en');
          expect(ja.cacheFileName).toBe(uniqueVectorCacheFileName('ja', DIMENSIONS));
          expect(en.cacheFileName).toBe(uniqueVectorCacheFileName('en', DIMENSIONS));
          expect(ja.cacheFileName).not.toBe(en.cacheFileName);

          const jaRanking = rankUniqueVectors(queryVector, ja.set);
          const jaTruths = buildGroundTruths(queryVector, ja.set);

          // 当該言語のベクトル集合のみから決まる（純関数経路と一致する）
          expect(jaRanking).toEqual(
            rankUniqueVectors(
              queryVector,
              buildUniqueVectorSet(jaRows, { language: 'ja', dimensions: DIMENSIONS })
            )
          );
          expect(rankUniqueVectors(queryVector, en.set)).toEqual(
            rankUniqueVectors(
              queryVector,
              buildUniqueVectorSet(enRows, { language: 'en', dimensions: DIMENSIONS })
            )
          );

          // 英語側のベクトルのみを差し替えても日本語側は不変
          const otherCache = createMemoryCache();
          const otherSource = createFakeVectorRecordSource({ ja: jaRows, en: enAltRows });
          const jaAgain = await loadUniqueVectorSet({
            ...loadOptions,
            language: 'ja',
            source: otherSource,
            cache: otherCache,
          });
          expect(jaAgain.set).toEqual(ja.set);
          expect(rankUniqueVectors(queryVector, jaAgain.set)).toEqual(jaRanking);
          expect(buildGroundTruths(queryVector, jaAgain.set)).toEqual(jaTruths);

          // キャッシュ経由でも同一の順位付けを再現する
          const jaCached = await loadUniqueVectorSet({ ...loadOptions, language: 'ja' });
          expect(jaCached.fromCache).toBe(true);
          expect(rankUniqueVectors(queryVector, jaCached.set)).toEqual(jaRanking);

          // 言語をまたいだ読み出しは遮断される
          expect(() =>
            deserializeUniqueVectorSet(serializeUniqueVectorSet(ja.set, FIXED_GENERATED_AT), {
              language: 'en',
              dimensions: DIMENSIONS,
            })
          ).toThrow(GroundTruthError);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ============================================================
// Property 45
// ============================================================

describe('倉庫フィルタ', () => {
  const filterSeedsArb = fc.uniqueArray(
    fc.record({
      itemId: fc.constantFrom(...ITEM_ID_POOL),
      embedding: nonZeroVectorArb(DIMENSIONS),
      warehouseIds: fc.subarray([...WAREHOUSE_IDS], { minLength: 1 }),
    }),
    { minLength: 2, maxLength: ITEM_ID_POOL.length, selector: (seed) => seed.itemId }
  );

  // Feature: vector-search-comparison, Property 45: 等価フィルタ結果の部分集合性
  // 任意の クエリベクトル・任意の 言語・任意の 倉庫指定に対して、両バックエンドのフィルタ付き結果は
  // 全件が指定倉庫のレコードであり、かつ十分大きな TopK においてフィルタなし結果の部分集合である。
  // フィルタ有効時の Ground_Truth は当該倉庫のレコードのみから計算され、
  // フィルタ無効時の Ground_Truth とは異なる集合として保持される。
  // **Validates: Requirements 13.14**
  it('フィルタ付き結果は指定倉庫のみで構成され、フィルタなし結果の部分集合になる', () => {
    fc.assert(
      fc.property(
        nonZeroVectorArb(DIMENSIONS),
        fc.constantFrom<VectorLanguage>('ja', 'en'),
        filterSeedsArb,
        fc.constantFrom(...WAREHOUSE_IDS),
        fc.constantFrom(...DISTINCT_SKU_K_VALUES),
        (queryVector, language, seeds, warehouseId, distinctSkuK) => {
          const rows = seeds.flatMap((seed) =>
            buildWarehouseRows(seed.itemId, seed.embedding, seed.warehouseIds)
          );

          // フィルタ無効時は入力をそのまま返す
          expect(filterRowsByWarehouse(rows, null)).toEqual(rows);

          const filteredRows = filterRowsByWarehouse(rows, warehouseId);
          expect(filteredRows.every((row) => row.warehouseId === warehouseId)).toBe(true);
          expect(filteredRows.length).toBe(
            rows.filter((row) => row.warehouseId === warehouseId).length
          );

          const unfiltered = buildUniqueVectorSet(rows, { language, dimensions: DIMENSIONS });
          const filtered = buildUniqueVectorSet(rows, {
            language,
            dimensions: DIMENSIONS,
            warehouseId,
          });

          // 条件は集合自身に埋め込まれ、別の集合として保持される
          expect(unfiltered.warehouseId).toBeNull();
          expect(filtered.warehouseId).toBe(warehouseId);
          expect(uniqueVectorCacheFileName(language, DIMENSIONS, warehouseId)).not.toBe(
            uniqueVectorCacheFileName(language, DIMENSIONS, null)
          );

          // 全件が指定倉庫のレコード
          expect(
            filtered.vectors.every(
              (vector) =>
                vector.warehouseIds.length === 1 && vector.warehouseIds[0] === warehouseId
            )
          ).toBe(true);

          // フィルタなし集合の部分集合
          const unfilteredItemIds = new Set(unfiltered.vectors.map((vector) => vector.itemId));
          expect(filtered.vectors.every((vector) => unfilteredItemIds.has(vector.itemId))).toBe(
            true
          );
          expect(filtered.uniqueVectorCount).toBeLessThanOrEqual(unfiltered.uniqueVectorCount);

          // 再 Scan なしの導出経路も同一の集合を返す
          expect(restrictUniqueVectorSetToWarehouse(unfiltered, warehouseId)).toEqual(filtered);
          expect(() => restrictUniqueVectorSetToWarehouse(filtered, warehouseId)).toThrow(
            GroundTruthError
          );

          // 十分大きな TopK（= 全件順位付け）でも部分集合性が成り立つ
          const unfilteredRanking = rankUniqueVectors(queryVector, unfiltered);
          const filteredRanking = rankUniqueVectors(queryVector, filtered);
          const unfilteredRankedItemIds = new Set(
            unfilteredRanking.entries.map((entry) => entry.itemId)
          );
          expect(
            filteredRanking.entries.every((entry) => unfilteredRankedItemIds.has(entry.itemId))
          ).toBe(true);

          // フィルタ有効時の Ground_Truth は当該倉庫のレコードのみから計算される
          const warehouseItemIds = new Set(filteredRows.map((row) => row.itemId));
          const filteredTruth = buildGroundTruth(filteredRanking, distinctSkuK);
          expect(filteredTruth.warehouseId).toBe(warehouseId);
          expect(filteredTruth.itemIds.every((itemId) => warehouseItemIds.has(itemId))).toBe(true);
          expect(buildGroundTruth(unfilteredRanking, distinctSkuK).warehouseId).toBeNull();

          filteredRanking.entries.forEach((entry) => {
            const seed = seeds.find((candidate) => candidate.itemId === entry.itemId);
            expect(seed).toBeDefined();
            expect(entry.distance).toBe(
              cosineDistance(queryVector, (seed as { embedding: number[] }).embedding)
            );
          });
        }
      ),
      { numRuns: 100 }
    );
  });
});
