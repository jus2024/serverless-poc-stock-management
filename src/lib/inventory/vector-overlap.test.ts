import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  DISTANCE_MATCH_TOLERANCE,
  SCORE_DIFFERENCE_LABEL,
  WITHIN_TOLERANCE_LABEL,
  computeVectorOverlap,
  countDistinctSkus,
  isWithinDistanceTolerance,
  vectorItemKey,
  type VectorOverlapComputable,
  type VectorOverlapInput,
} from "./vector-overlap";
import type { VectorSearchHit } from "./vector-types";

/**
 * 重なり指標計算（純関数）の property テスト（task 4.3）。
 *
 * 実装は `(itemId, warehouseId)` の複合キーで集合を作るため、同一キーが複数行
 * 含まれる入力は**順位が最小の行に de-duplicate される**。したがって集合サイズは
 * `rowCount` ではなく `uniqueKeyCount` であり、Property 34 の保存則も
 * `uniqueKeyCount` に対して成立する（重複キーがない入力では両者は一致する）。
 *
 * 要件: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7
 */

// ============================================================
// 生成器
// ============================================================

/** 倉庫三つ組を再現するため、SKU 数より倉庫数を少なく取る */
const ITEM_IDS = ["SKU-001", "SKU-002", "SKU-003", "SKU-004"] as const;
const WAREHOUSE_IDS = ["WH-1", "WH-2", "WH-3"] as const;

interface HitSeed {
  readonly itemId: string;
  readonly warehouseId: string;
  readonly rank: number;
  readonly distance: number;
}

/** 検索結果 1 件を組み立てる。重なり判定に関係しない属性は固定値で埋める */
function makeHit(seed: HitSeed): VectorSearchHit {
  return {
    itemId: seed.itemId,
    warehouseId: seed.warehouseId,
    productName: `product-${seed.itemId}`,
    category: "beans",
    origin: "Ethiopia",
    roastLevel: "medium",
    flavorNotes: "floral",
    quantity: 10,
    location: `${seed.warehouseId}-A-01`,
    unitPrice: 1200,
    rank: seed.rank,
    distance: seed.distance,
    rawScore: seed.distance,
  };
}

const distanceArb = fc.double({ min: 0, max: 2, noNaN: true });
const rankArb = fc.integer({ min: 1, max: 50 });

/** 指定した itemId プールから検索結果 1 件を生成する */
const hitArbFrom = (itemIds: readonly string[]): fc.Arbitrary<VectorSearchHit> =>
  fc
    .record({
      itemId: fc.constantFrom(...itemIds),
      warehouseId: fc.constantFrom(...WAREHOUSE_IDS),
      rank: rankArb,
      distance: distanceArb,
    })
    .map(makeHit);

const hitArb = hitArbFrom(ITEM_IDS);

/** 重複キーを含みうる結果配列（1 件以上） */
const hitsArb = fc.array(hitArb, { minLength: 1, maxLength: 12 });

/** 複合キーが一意な結果配列（1 件以上） */
const uniqueHitsArb = fc.uniqueArray(hitArb, {
  minLength: 1,
  maxLength: 12,
  selector: (hit) => vectorItemKey(hit.itemId, hit.warehouseId),
});

/** キーが交わらない 2 つの結果配列（素集合） */
const disjointSidesArb = fc.tuple(
  fc.array(hitArbFrom(["A-001", "A-002", "A-003"]), {
    minLength: 1,
    maxLength: 8,
  }),
  fc.array(hitArbFrom(["B-001", "B-002", "B-003"]), {
    minLength: 1,
    maxLength: 8,
  })
);

// ============================================================
// 補助
// ============================================================

function successInput(
  dynamodb: readonly VectorSearchHit[],
  opensearch: readonly VectorSearchHit[]
): VectorOverlapInput {
  return {
    dynamodb: { outcome: "success", hits: dynamodb },
    opensearch: { outcome: "success", hits: opensearch },
  };
}

/** 両側 1 件以上・正常終了の入力は必ず算出可能になる */
function computeComputable(
  dynamodb: readonly VectorSearchHit[],
  opensearch: readonly VectorSearchHit[]
): VectorOverlapComputable {
  const result = computeVectorOverlap(successInput(dynamodb, opensearch));
  if (!result.computable) {
    throw new Error(`算出可能を期待したが算出不可: ${result.reason}`);
  }
  return result;
}

const keyOf = (entry: { readonly itemId: string; readonly warehouseId: string }): string =>
  vectorItemKey(entry.itemId, entry.warehouseId);

/** 複合キーの一意集合を昇順配列として取り出す（集合比較を決定論的に行うため） */
function sortedUniqueKeys(
  entries: readonly { readonly itemId: string; readonly warehouseId: string }[]
): string[] {
  const seen: Record<string, true> = {};
  const keys: string[] = [];
  entries.forEach((entry) => {
    const key = keyOf(entry);
    if (seen[key] !== true) {
      seen[key] = true;
      keys.push(key);
    }
  });
  return keys.sort();
}

const includesKey = (keys: readonly string[], key: string): boolean =>
  keys.indexOf(key) >= 0;

/** 2 つのキー配列の和集合（昇順・一意） */
const unionKeys = (a: readonly string[], b: readonly string[]): string[] => {
  const merged = a.concat(b);
  return merged.filter((key, index) => merged.indexOf(key) === index).sort();
};

describe("computeVectorOverlap", () => {
  // Feature: vector-search-comparison, Property 33: 重なり指標の値域と対称性
  // 任意の 2 つの結果集合（同一性は (itemId, warehouseId) の複合キー）に対して、共通アイテム数は
  // 0 以上かつ両集合サイズの最小値以下であり、Jaccard 係数と overlap@k 比率はともに 0 以上 1 以下である。
  // 両指標は 2 集合の引数を入れ替えても値が変わらず、2 集合が等しいとき（空集合でない場合）1 になり、
  // 素集合のとき 0 になる。
  // **Validates: Requirements 12.1, 12.3**
  it("共通件数は最小集合サイズ以下、両比率は 0〜1 で対称、等集合で 1・素集合で 0 になる", () => {
    // 値域と対称性
    fc.assert(
      fc.property(hitsArb, hitsArb, (dynamodbHits, opensearchHits) => {
        const result = computeComputable(dynamodbHits, opensearchHits);
        const swapped = computeComputable(opensearchHits, dynamodbHits);

        const dynamodbSize = result.dynamodb.uniqueKeyCount;
        const opensearchSize = result.opensearch.uniqueKeyCount;
        const { commonCount, jaccard, overlapAtK } = result.metrics;

        // 共通アイテム数は 0 以上かつ両集合サイズの最小値以下
        expect(commonCount).toBeGreaterThanOrEqual(0);
        expect(commonCount).toBeLessThanOrEqual(Math.min(dynamodbSize, opensearchSize));

        // 両比率は 0 以上 1 以下（生値と表示値の双方）
        for (const ratio of [
          jaccard,
          overlapAtK,
          result.metrics.jaccardRounded,
          result.metrics.overlapAtKRounded,
        ]) {
          expect(ratio).toBeGreaterThanOrEqual(0);
          expect(ratio).toBeLessThanOrEqual(1);
        }

        // 引数を入れ替えても両指標は変わらない
        expect(swapped.metrics.jaccard).toBe(jaccard);
        expect(swapped.metrics.overlapAtK).toBe(overlapAtK);
        expect(swapped.metrics.jaccardRounded).toBe(result.metrics.jaccardRounded);
        expect(swapped.metrics.overlapAtKRounded).toBe(result.metrics.overlapAtKRounded);
        expect(swapped.metrics.commonCount).toBe(commonCount);
        expect(swapped.metrics.unionCount).toBe(result.metrics.unionCount);
        // 「片側のみ」は入れ替えに伴って役割が入れ替わる
        expect(swapped.metrics.dynamodbOnlyCount).toBe(result.metrics.opensearchOnlyCount);
        expect(swapped.metrics.opensearchOnlyCount).toBe(result.metrics.dynamodbOnlyCount);
      }),
      { numRuns: 100 }
    );

    // 2 集合が等しいとき（空集合でない場合）両指標は 1
    fc.assert(
      fc.property(hitsArb, (hits) => {
        const result = computeComputable(hits, hits);
        expect(result.metrics.jaccard).toBe(1);
        expect(result.metrics.overlapAtK).toBe(1);
        expect(result.metrics.commonCount).toBe(result.dynamodb.uniqueKeyCount);
      }),
      { numRuns: 100 }
    );

    // 素集合のとき両指標は 0
    fc.assert(
      fc.property(disjointSidesArb, ([dynamodbHits, opensearchHits]) => {
        const result = computeComputable(dynamodbHits, opensearchHits);
        expect(result.metrics.commonCount).toBe(0);
        expect(result.metrics.jaccard).toBe(0);
        expect(result.metrics.overlapAtK).toBe(0);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: vector-search-comparison, Property 34: 結果集合の 3 分割の保存則
  // 任意の 2 つの結果集合に対して、共通アイテム・DynamoDB 側のみ・OpenSearch 側のみの 3 分割は
  // 網羅的かつ排他的であり、（DynamoDB 側のみの件数 + 共通件数）が DynamoDB 側の件数と等しく、
  // （OpenSearch 側のみの件数 + 共通件数）が OpenSearch 側の件数と等しい。共通アイテムの順位差と
  // スコア差は非負であり、両バックエンドの値の差の絶対値と等しい。
  // **Validates: Requirements 12.4, 12.5**
  it("3 分割は網羅的かつ排他的で件数が保存され、順位差とスコア差は非負の絶対差になる", () => {
    fc.assert(
      fc.property(hitsArb, hitsArb, (dynamodbHits, opensearchHits) => {
        const result = computeComputable(dynamodbHits, opensearchHits);

        const dynamodbKeys = sortedUniqueKeys(dynamodbHits);
        const opensearchKeys = sortedUniqueKeys(opensearchHits);
        const commonKeys = sortedUniqueKeys(result.common);
        const dynamodbOnlyKeys = sortedUniqueKeys(result.dynamodbOnly);
        const opensearchOnlyKeys = sortedUniqueKeys(result.opensearchOnly);

        // 一覧はキー重複を含まない（de-duplicate 済み）
        expect(commonKeys).toHaveLength(result.common.length);
        expect(dynamodbOnlyKeys).toHaveLength(result.dynamodbOnly.length);
        expect(opensearchOnlyKeys).toHaveLength(result.opensearchOnly.length);

        // 排他性: 共通と「片側のみ」は交わらず、両「片側のみ」も交わらない
        commonKeys.forEach((key) => {
          expect(includesKey(dynamodbOnlyKeys, key)).toBe(false);
          expect(includesKey(opensearchOnlyKeys, key)).toBe(false);
          // 共通アイテムは両側に存在する
          expect(includesKey(dynamodbKeys, key)).toBe(true);
          expect(includesKey(opensearchKeys, key)).toBe(true);
        });
        dynamodbOnlyKeys.forEach((key) => {
          expect(includesKey(opensearchOnlyKeys, key)).toBe(false);
          expect(includesKey(dynamodbKeys, key)).toBe(true);
          expect(includesKey(opensearchKeys, key)).toBe(false);
        });
        opensearchOnlyKeys.forEach((key) => {
          expect(includesKey(dynamodbKeys, key)).toBe(false);
          expect(includesKey(opensearchKeys, key)).toBe(true);
        });

        // 網羅性: 共通 ∪ 片側のみ = その側のキー集合
        expect(unionKeys(commonKeys, dynamodbOnlyKeys)).toEqual(dynamodbKeys);
        expect(unionKeys(commonKeys, opensearchOnlyKeys)).toEqual(opensearchKeys);

        // 保存則（集合サイズ = uniqueKeyCount に対して成立）
        const { commonCount, dynamodbOnlyCount, opensearchOnlyCount, unionCount } = result.metrics;
        expect(commonCount).toBe(result.common.length);
        expect(dynamodbOnlyCount + commonCount).toBe(result.dynamodb.uniqueKeyCount);
        expect(opensearchOnlyCount + commonCount).toBe(result.opensearch.uniqueKeyCount);
        expect(unionCount).toBe(dynamodbOnlyCount + opensearchOnlyCount + commonCount);

        // 共通アイテムの順位差・スコア差は非負であり、両バックエンド値の絶対差と等しい
        result.common.forEach((entry) => {
          expect(entry.rankDifference).toBeGreaterThanOrEqual(0);
          expect(entry.rankDifference).toBe(
            Math.abs(entry.dynamodbRank - entry.opensearchRank)
          );
          expect(entry.distanceDifference).toBeGreaterThanOrEqual(0);
          expect(entry.distanceDifference).toBe(
            Math.abs(entry.dynamodbDistance - entry.opensearchDistance)
          );
        });
      }),
      { numRuns: 100 }
    );

    // 重複キーがない入力では、集合サイズは表示行数と一致するため保存則は rowCount にも成立する
    fc.assert(
      fc.property(uniqueHitsArb, uniqueHitsArb, (dynamodbHits, opensearchHits) => {
        const result = computeComputable(dynamodbHits, opensearchHits);
        const { commonCount, dynamodbOnlyCount, opensearchOnlyCount } = result.metrics;

        expect(result.dynamodb.uniqueKeyCount).toBe(result.dynamodb.rowCount);
        expect(result.opensearch.uniqueKeyCount).toBe(result.opensearch.rowCount);
        expect(dynamodbOnlyCount + commonCount).toBe(result.dynamodb.rowCount);
        expect(opensearchOnlyCount + commonCount).toBe(result.opensearch.rowCount);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: vector-search-comparison, Property 35: 一致判定閾値の厳密性
  // 任意の 2 つの正規化距離値（閾値 0.0010 の近傍を含む）に対して、許容誤差内で一致とみなす識別表示が
  // 付与されるのは差の絶対値が 0.0010 以下の場合のみであり、それ以外はスコア差ありの識別表示が付与される。
  // **Validates: Requirements 12.7**
  it("差の絶対値が 0.0010 以下のときのみ許容誤差内で一致の表示が付き、それ以外はスコア差ありになる", () => {
    /** 閾値 0.0010 の近傍を厚めに含む差分 */
    const deltaArb = fc.oneof(
      fc.double({ min: 0, max: 0.01, noNaN: true }),
      fc.double({ min: 0, max: 2, noNaN: true }),
      fc.constantFrom(
        0,
        0.0005,
        DISTANCE_MATCH_TOLERANCE,
        DISTANCE_MATCH_TOLERANCE / 2,
        0.0010000001,
        0.0011,
        0.002
      )
    );

    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1.9, noNaN: true }),
        deltaArb,
        fc.boolean(),
        (base, delta, negate) => {
          const dynamodbDistance = base;
          const opensearchDistance = negate ? base - delta : base + delta;
          const difference = Math.abs(dynamodbDistance - opensearchDistance);

          const result = computeComputable(
            [
              makeHit({
                itemId: "SKU-001",
                warehouseId: "WH-1",
                rank: 1,
                distance: dynamodbDistance,
              }),
            ],
            [
              makeHit({
                itemId: "SKU-001",
                warehouseId: "WH-1",
                rank: 1,
                distance: opensearchDistance,
              }),
            ]
          );

          expect(result.common).toHaveLength(1);
          const entry = result.common[0];

          // 閾値からの距離が浮動小数の誤差より十分大きいケースを厳密に判定する
          if (difference < DISTANCE_MATCH_TOLERANCE - 1e-12) {
            expect(entry.withinTolerance).toBe(true);
          } else if (difference > DISTANCE_MATCH_TOLERANCE + 1e-12) {
            expect(entry.withinTolerance).toBe(false);
          }

          // 判定は差の絶対値と閾値の比較のみで決まる
          expect(entry.withinTolerance).toBe(difference <= DISTANCE_MATCH_TOLERANCE);
          expect(entry.withinTolerance).toBe(
            isWithinDistanceTolerance(dynamodbDistance, opensearchDistance)
          );

          // 識別表示は判定に一対一で対応する
          expect(entry.toleranceLabel).toBe(
            entry.withinTolerance ? WITHIN_TOLERANCE_LABEL : SCORE_DIFFERENCE_LABEL
          );
          expect(entry.distanceDifference).toBe(difference);
        }
      ),
      { numRuns: 100 }
    );

    // 境界値 0.0010 そのものは一致側に含まれる
    expect(isWithinDistanceTolerance(0, DISTANCE_MATCH_TOLERANCE)).toBe(true);
    expect(isWithinDistanceTolerance(DISTANCE_MATCH_TOLERANCE, 0)).toBe(true);
    // 閾値を明確に超える差は一致側に含まれない
    expect(isWithinDistanceTolerance(0, 0.0011)).toBe(false);
  });

  // Feature: vector-search-comparison, Property 36: 表示行数と一意 SKU 件数の関係
  // 任意の検索結果配列に対して、表示される一意 SKU 件数は itemId の一意件数と等しく、表示行数以下である。
  // 同一 itemId の 3 倉庫行がすべて含まれる結果配列では、表示行数は一意 SKU 件数の 3 倍と等しい。
  // 両件数は常に整数として同時に表示される。
  // **Validates: Requirements 12.2**
  it("一意 SKU 件数は itemId の一意件数と等しく表示行数以下で、倉庫三つ組では行数が 3 倍になる", () => {
    /** 空配列も含む（片側 0 件は算出不可だが件数は常に返る） */
    const anyHitsArb = fc.array(hitArb, { minLength: 0, maxLength: 12 });
    const nonEmptyOtherSide = [
      makeHit({ itemId: "SKU-001", warehouseId: "WH-1", rank: 1, distance: 0.1 }),
    ];

    fc.assert(
      fc.property(anyHitsArb, (hits) => {
        const result = computeVectorOverlap(
          successInput(hits, nonEmptyOtherSide)
        );
        const counts = result.dynamodb;

        const expectedDistinctSkus = new Set(hits.map((hit) => hit.itemId)).size;

        // 一意 SKU 件数は itemId の一意件数と等しい
        expect(counts.distinctSkuCount).toBe(expectedDistinctSkus);
        expect(countDistinctSkus(hits)).toBe(expectedDistinctSkus);

        // 表示行数以下である
        expect(counts.rowCount).toBe(hits.length);
        expect(counts.distinctSkuCount).toBeLessThanOrEqual(counts.rowCount);

        // 両件数は整数として同時に得られる
        expect(Number.isInteger(counts.rowCount)).toBe(true);
        expect(Number.isInteger(counts.distinctSkuCount)).toBe(true);
      }),
      { numRuns: 100 }
    );

    // 同一 itemId の 3 倉庫行がすべて含まれる場合、表示行数は一意 SKU 件数の 3 倍
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...ITEM_IDS), { minLength: 1 }),
        (itemIds) => {
          const triplets = itemIds.flatMap((itemId, itemIndex) =>
            WAREHOUSE_IDS.map((warehouseId, warehouseIndex) =>
              makeHit({
                itemId,
                warehouseId,
                rank: itemIndex * WAREHOUSE_IDS.length + warehouseIndex + 1,
                distance: 0.1 * (itemIndex + 1),
              })
            )
          );

          const result = computeVectorOverlap(
            successInput(triplets, nonEmptyOtherSide)
          );
          const counts = result.dynamodb;

          expect(counts.distinctSkuCount).toBe(itemIds.length);
          expect(counts.rowCount).toBe(counts.distinctSkuCount * WAREHOUSE_IDS.length);
        }
      ),
      { numRuns: 100 }
    );
  });
});
