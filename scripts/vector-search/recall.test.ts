import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DISTINCT_SKU_K_DERIVATION,
  MAX_DISTINCT_SKU_K,
  MAX_TOP_K,
  WAREHOUSE_ROWS_PER_SKU,
  distinctSkuKToTopK,
} from '../../amplify/functions/shared/vector/topk';
import { DISTINCT_SKU_K_VALUES } from './ground-truth';
import {
  RECALL_THRESHOLD,
  RecallError,
  aggregateRecallObservations,
  countMaterialSkus,
  dedupeByItemId,
  dedupeHitsByItemId,
  evaluateRecallObservation,
  languageRecallDifference,
  recallAtK,
  resolveDistinctSkuK,
  roundToPrecision,
  selectMaterialSkuItemIds,
  topDistinctSkuItemIds,
  type RecallBackend,
  type RecallHit,
  type RecallObservation,
  type VectorLanguage,
} from './recall';

/**
 * SKU 粒度 recall 算出の property テスト（task 5.4）。
 *
 * 対象はすべて純関数であり、AWS SDK もファイルシステムも参照しない。
 * 返却行は「1 SKU につき 3 倉庫行、行内は同一距離」という前提 A11 の形で作る。
 * この形が recall 算出の分母・分子の扱いを決めるため、生成器の既定にしている。
 *
 * 要件: 13.3, 13.4, 13.5, 13.6, 13.8, 13.11, 13.15
 */

// ============================================================
// 生成器と補助
// ============================================================

/** 1 SKU が占める倉庫行（前提 A11） */
const WAREHOUSE_IDS = ['WH-001', 'WH-002', 'WH-003'] as const;

/** Ground_Truth 側に使う itemId プール。資材パターンに一致しない形にしてある */
const TRUTH_ITEM_IDS: readonly string[] = Array.from(
  { length: 40 },
  (_, index) => `ITEM#BR-SANTOS-A-MEDIUM-G200-V${index + 1}`
);

/** Ground_Truth に含まれない itemId プール（外れ値） */
const DECOY_ITEM_IDS: readonly string[] = Array.from(
  { length: 40 },
  (_, index) => `ITEM#CO-SUPREMO-A-CITY-G500-V${index + 1}`
);

/** 資材カテゴリの itemId（負例クラス）。`ITEM#MAT-` で始まる */
const MATERIAL_ITEM_IDS: readonly string[] = [
  'BAG',
  'BOX',
  'LABEL',
  'SEAL',
  'TAPE',
  'FILTER',
  'CUP',
  'LID',
  'TAG',
  'RIBBON',
].flatMap((type) => [`ITEM#MAT-${type}-M-KRAFT`, `ITEM#MAT-${type}-L-PAPER`]);

/** 資材ではない itemId（豆・ブレンド） */
const NON_MATERIAL_ITEM_IDS: readonly string[] = ['BR', 'ET', 'CO', 'GT', 'KE', 'ID', 'CR', 'TZ']
  .flatMap((origin) => [
    `ITEM#${origin}-SANTOS-RAW`,
    `ITEM#${origin}-SANTOS-A-MEDIUM-G200`,
    `ITEM#BLEND-MORNING-MEDIUM-G200-V${origin.charCodeAt(0)}`,
  ])
  .slice(0, 20);

/** 資材と非資材を混ぜた itemId プール */
const MIXED_ITEM_IDS: readonly string[] = [...MATERIAL_ITEM_IDS, ...NON_MATERIAL_ITEM_IDS];

/** 1 SKU につき 3 倉庫行（行内は同一距離）を作る。距離は SKU の並び順に単調増加する */
function buildTripletHits(itemIds: readonly string[]): RecallHit[] {
  return itemIds.flatMap((itemId, index) =>
    WAREHOUSE_IDS.map((warehouseId, offset) => ({
      itemId,
      warehouseId,
      distance: 0.001 * (index + 1),
      rank: index * WAREHOUSE_ROWS_PER_SKU + offset + 1,
    }))
  );
}

/** 実装（`recall.ts` の `mean`）と同一の順序・同一の算術で平均を求める */
function meanOf(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  let total = 0;
  for (let i = 0; i < values.length; i += 1) {
    total += values[i];
  }
  return total / values.length;
}

/**
 * 上位 k 件のうち `matched` 件が Ground_Truth に一致する測定を、実際の算出経路で作る。
 * 返却行は 1 SKU につき 3 行なので、要求 TopK は 3 × k になる。
 */
function makeObservation(args: {
  queryId: string;
  backend: RecallBackend;
  language: VectorLanguage;
  distinctSkuK: number;
  matched: number;
}): RecallObservation {
  const truthItemIds = TRUTH_ITEM_IDS.slice(0, args.distinctSkuK);
  const returnedItemIds = [
    ...truthItemIds.slice(0, args.matched),
    ...DECOY_ITEM_IDS.slice(0, args.distinctSkuK - args.matched),
  ];

  return evaluateRecallObservation({
    queryId: args.queryId,
    intent: 'flavor',
    backend: args.backend,
    hits: buildTripletHits(returnedItemIds),
    groundTruth: {
      language: args.language,
      distinctSkuK: args.distinctSkuK,
      topK: WAREHOUSE_ROWS_PER_SKU * args.distinctSkuK,
      itemIds: truthItemIds,
      warehouseId: null,
    },
  });
}

// ============================================================
// Property 38
// ============================================================

describe('dedupeByItemId', () => {
  const hitsArb = fc.array(
    fc.record({
      itemId: fc.constantFrom(
        ...TRUTH_ITEM_IDS.slice(0, 6),
        ...DECOY_ITEM_IDS.slice(0, 6)
      ),
      warehouseId: fc.constantFrom(...WAREHOUSE_IDS),
      distance: fc.double({ min: 0, max: 2, noNaN: true }),
      rank: fc.integer({ min: 1, max: 120 }),
    }),
    { maxLength: 36 }
  );

  // Feature: vector-search-comparison, Property 38: itemId 重複排除の冪等性と非増加性
  // 任意の 検索結果配列（同一 itemId の行を任意個含む）に対して、itemId 単位の重複排除は
  // 結果の要素数を増加させず、重複排除後の要素数は入力の itemId 一意件数と等しく、
  // 2 回適用しても結果が変わらない。重複排除後の順序は入力における各 itemId の初出順と一致する。
  // **Validates: Requirements 13.4**
  it('要素数は非増加・一意件数と一致し、2 回適用しても初出順のまま変わらない', () => {
    fc.assert(
      fc.property(hitsArb, (hits) => {
        const deduped = dedupeByItemId(hits);

        // 非増加性と一意件数の一致
        expect(deduped.length).toBeLessThanOrEqual(hits.length);
        expect(deduped.length).toBe(new Set(hits.map((hit) => hit.itemId)).size);

        // 初出順（入力配列の出現順）に一致する
        const expectedOrder: string[] = [];
        const seen = new Set<string>();
        hits.forEach((hit) => {
          if (!seen.has(hit.itemId)) {
            seen.add(hit.itemId);
            expectedOrder.push(hit.itemId);
          }
        });
        expect(deduped).toEqual(expectedOrder);

        // 冪等性: 重複排除後の列に再適用しても変わらない
        const reapplied = dedupeByItemId(
          deduped.map((itemId, index) => ({ itemId, distance: 0, rank: index + 1 }))
        );
        expect(reapplied).toEqual(deduped);

        // 詳細版も同一の順序であり、占有行数の合計は入力行数と等しい
        const detailed = dedupeHitsByItemId(hits);
        expect(detailed.map((sku) => sku.itemId)).toEqual(deduped);
        expect(detailed.reduce((total, sku) => total + sku.rowCount, 0)).toBe(hits.length);
        detailed.forEach((sku, index) => {
          expect(sku.distinctRank).toBe(index + 1);
          const firstIndex = hits.findIndex((hit) => hit.itemId === sku.itemId);
          expect(sku.firstRowRank).toBe(hits[firstIndex].rank);
          expect(sku.distance).toBe(hits[firstIndex].distance);
          expect(sku.rowCount).toBe(hits.filter((hit) => hit.itemId === sku.itemId).length);
        });
      }),
      { numRuns: 100 }
    );
  });
});

// ============================================================
// Property 39
// ============================================================

describe('resolveDistinctSkuK', () => {
  const distinctSkuKArb = fc.oneof(
    fc.integer({ min: -5, max: 60 }),
    fc.constantFrom(
      0,
      1,
      10,
      MAX_DISTINCT_SKU_K,
      MAX_DISTINCT_SKU_K + 1,
      MAX_TOP_K,
      2.5,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY
    )
  );

  // Feature: vector-search-comparison, Property 39: Distinct_Sku_K と要求 TopK の関係
  // 任意の Distinct_Sku_K に対して、バックエンドへ要求される TopK は Distinct_Sku_K の 3 倍と等しく、
  // Distinct_Sku_K が 33 以下のときのみ要求 TopK が 100 以下に収まる。
  // Distinct_Sku_K が 34 以上の場合は測定不能として拒否され、
  // 上限 33 とその導出（100 ÷ 3 倉庫）が出力に含まれる。
  // **Validates: Requirements 13.3**
  it('要求 TopK は 3 × k であり、k ≤ 33 のときのみ 100 以下に収まる', () => {
    fc.assert(
      fc.property(distinctSkuKArb, (distinctSkuK) => {
        const measurable =
          Number.isInteger(distinctSkuK) && distinctSkuK >= 1 && distinctSkuK <= MAX_DISTINCT_SKU_K;

        // 上限の導出は 100 ÷ 3 倉庫の商
        expect(MAX_DISTINCT_SKU_K).toBe(Math.floor(MAX_TOP_K / WAREHOUSE_ROWS_PER_SKU));

        if (measurable) {
          const resolved = resolveDistinctSkuK(distinctSkuK);
          expect(resolved.distinctSkuK).toBe(distinctSkuK);
          expect(resolved.topK).toBe(WAREHOUSE_ROWS_PER_SKU * distinctSkuK);
          expect(resolved.topK).toBeLessThanOrEqual(MAX_TOP_K);
          expect(resolved.rowsPerSku).toBe(WAREHOUSE_ROWS_PER_SKU);
          expect(resolved.maxDistinctSkuK).toBe(MAX_DISTINCT_SKU_K);
          expect(resolved.maxTopK).toBe(MAX_TOP_K);
          expect(resolved.derivation).toBe(DISTINCT_SKU_K_DERIVATION);
          return;
        }

        // 測定不能な k は拒否され、算出経路には進まない
        expect(() => resolveDistinctSkuK(distinctSkuK)).toThrow(RecallError);
        expect(() => topDistinctSkuItemIds([], distinctSkuK)).toThrow(RecallError);
        expect(() => recallAtK([], [], distinctSkuK)).toThrow(RecallError);

        const rejected = distinctSkuKToTopK(distinctSkuK);
        expect(rejected.ok).toBe(false);
        if (rejected.ok) {
          return;
        }

        // 上限 33 とその導出（TopK 上限 100 ÷ 倉庫行数 3）を出力に含む
        expect(rejected.maxDistinctSkuK).toBe(MAX_DISTINCT_SKU_K);
        expect(rejected.maxTopK).toBe(MAX_TOP_K);
        expect(rejected.rowsPerSku).toBe(WAREHOUSE_ROWS_PER_SKU);
        expect(rejected.derivation).toContain(String(MAX_DISTINCT_SKU_K));
        expect(rejected.derivation).toContain(String(MAX_TOP_K));
        expect(rejected.message).toContain(String(MAX_DISTINCT_SKU_K));

        if (Number.isInteger(distinctSkuK) && distinctSkuK > MAX_DISTINCT_SKU_K) {
          expect(rejected.reason).toBe('NOT_MEASURABLE');
          // 34 以上では要求 TopK が上限を超える
          expect(WAREHOUSE_ROWS_PER_SKU * distinctSkuK).toBeGreaterThan(MAX_TOP_K);
        } else {
          expect(rejected.reason).toBe('INVALID_INPUT');
        }
      }),
      { numRuns: 100 }
    );
  });
});

// ============================================================
// Property 40
// ============================================================

describe('recallAtK', () => {
  // Feature: vector-search-comparison, Property 40: recall@k の値域と単調性
  // 任意の 検索結果配列と SKU 粒度の正解 itemId 集合に対して、Recall_At_K は 0 以上 1 以下であり、
  // 重複排除後の上位 Distinct_Sku_K 件が正解集合を包含するとき 1 になる。
  // 同一クエリ・同一バックエンドについて Distinct_Sku_K を増やしたとき（正解集合が包含関係を保つ場合）、
  // 積集合サイズは単調非減少である。同一の算出式が両バックエンドの結果に適用される。
  // **Validates: Requirements 13.4, 13.5**
  it('値域 0〜1・包含時は 1・k 増加で積集合サイズ非減少・両バックエンドで同一式', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray([...TRUTH_ITEM_IDS], {
          minLength: MAX_DISTINCT_SKU_K,
          maxLength: MAX_DISTINCT_SKU_K,
        }),
        fc.shuffledSubarray([...TRUTH_ITEM_IDS, ...DECOY_ITEM_IDS], {
          minLength: 1,
          maxLength: 40,
        }),
        fc.integer({ min: 1, max: MAX_DISTINCT_SKU_K }),
        fc.integer({ min: 1, max: MAX_DISTINCT_SKU_K }),
        fc.boolean(),
        (truthOrder, shuffledOrder, ka, kb, truthFirst) => {
          const smallK = Math.min(ka, kb);
          const largeK = Math.max(ka, kb);

          // truthFirst のとき、返却順の先頭を正解の上位 k 件にして「包含 → 1.0」の枝に到達させる。
          // ランダムな並びだけでは包含が起きる確率がほぼ 0 になる
          const returnedOrder = truthFirst
            ? Array.from(new Set([...truthOrder.slice(0, largeK), ...shuffledOrder]))
            : shuffledOrder;
          const hits = buildTripletHits(returnedOrder);

          // 値域と積集合サイズの整合
          const matchedCountOf = (distinctSkuK: number): number => {
            const value = recallAtK(hits, truthOrder, distinctSkuK);
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(1);
            const matched = Math.round(value * distinctSkuK);
            expect(matched / distinctSkuK).toBe(value);
            return matched;
          };

          // 正解集合が包含関係を保つ（先頭 k 件を採る）ので積集合サイズは単調非減少
          expect(matchedCountOf(smallK)).toBeLessThanOrEqual(matchedCountOf(largeK));

          // 上位 Distinct_Sku_K 件が正解集合を包含するとき 1 になる
          const topItemIds = topDistinctSkuItemIds(hits, largeK);
          const truthAtLargeK = truthOrder.slice(0, largeK);
          if (truthAtLargeK.every((itemId) => topItemIds.includes(itemId))) {
            expect(recallAtK(hits, truthOrder, largeK)).toBe(1);
          }
          expect(recallAtK(buildTripletHits(truthAtLargeK), truthOrder, largeK)).toBe(1);

          // 同一の算出式が両バックエンドに適用される（分岐が存在しない）
          const groundTruth = {
            language: 'ja' as const,
            distinctSkuK: largeK,
            topK: WAREHOUSE_ROWS_PER_SKU * largeK,
            itemIds: truthOrder,
            warehouseId: null,
          };
          const dynamodb = evaluateRecallObservation({
            queryId: 'q01',
            intent: 'flavor',
            backend: 'dynamodb',
            hits,
            groundTruth,
          });
          const opensearch = evaluateRecallObservation({
            queryId: 'q01',
            intent: 'flavor',
            backend: 'opensearch',
            hits,
            groundTruth,
          });

          expect(opensearch.recallAtK).toBe(dynamodb.recallAtK);
          expect(dynamodb.recallAtK).toBe(recallAtK(hits, truthOrder, largeK));
          expect(dynamodb.matchedCount).toBe(Math.round(dynamodb.recallAtK * largeK));
          expect(dynamodb.matchedCount / dynamodb.distinctSkuK).toBe(dynamodb.recallAtK);
          expect(dynamodb.topK).toBe(WAREHOUSE_ROWS_PER_SKU * largeK);
          expect(dynamodb.topDistinctSkuItemIds).toEqual(opensearch.topDistinctSkuItemIds);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ============================================================
// Property 41
// ============================================================

describe('aggregateRecallObservations', () => {
  // Feature: vector-search-comparison, Property 41: 統計集計の整合性と言語間差分
  // 任意の Recall_At_K の列に対して、最小値 ≤ 平均値 ≤ 最大値が成立し、0.99 を下回った件数は
  // 実際に 0.99 未満である要素数と等しく、合格判定は平均値が 0.99 以上であることと厳密に一致する。
  // 任意の 日英 2 つの Recall_At_K 列に対して、出力される言語間差分は日本語平均と英語平均の差と等しく、
  // 引数を入れ替えると符号のみが反転する。
  // **Validates: Requirements 13.6, 13.8, 13.11**
  it('最小 ≤ 平均 ≤ 最大・閾値未満件数・合否判定・言語間差分の符号反転が成立する', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DISTINCT_SKU_K_VALUES),
        fc.array(fc.nat({ max: MAX_DISTINCT_SKU_K }), { minLength: 1, maxLength: 6 }),
        fc.array(fc.nat({ max: MAX_DISTINCT_SKU_K }), { minLength: 1, maxLength: 6 }),
        (distinctSkuK, jaMatched, enMatched) => {
          const build = (matched: readonly number[], language: VectorLanguage) =>
            matched.map((count, index) =>
              makeObservation({
                queryId: `q${index + 1}`,
                backend: 'dynamodb',
                language,
                distinctSkuK,
                matched: Math.min(count, distinctSkuK),
              })
            );

          const jaObservations = build(jaMatched, 'ja');
          const enObservations = build(enMatched, 'en');
          const jaValues = jaObservations.map((observation) => observation.recallAtK);
          const enValues = enObservations.map((observation) => observation.recallAtK);

          const aggregate = aggregateRecallObservations([...jaObservations, ...enObservations]);
          expect(aggregate.scope.threshold).toBe(RECALL_THRESHOLD);
          expect(aggregate.groups).toHaveLength(2);

          aggregate.groups.forEach((group) => {
            const values = group.language === 'ja' ? jaValues : enValues;

            expect(group.queryCount).toBe(values.length);
            expect(group.minRecallAtK).toBe(Math.min(...values));
            expect(group.maxRecallAtK).toBe(Math.max(...values));
            expect(group.meanRecallAtK).toBe(meanOf(values));

            // 最小値 ≤ 平均値 ≤ 最大値
            expect(group.minRecallAtK).toBeLessThanOrEqual(group.meanRecallAtK);
            expect(group.meanRecallAtK).toBeLessThanOrEqual(group.maxRecallAtK);

            // 閾値未満件数は実際に 0.99 未満である要素数と等しい
            const below = values.filter((value) => value < RECALL_THRESHOLD);
            expect(group.threshold).toBe(RECALL_THRESHOLD);
            expect(group.belowThresholdCount).toBe(below.length);
            expect(group.belowThresholdQueryIds).toHaveLength(below.length);

            // 合否は平均が閾値以上であることと厳密に一致する
            expect(group.passed).toBe(group.meanRecallAtK >= RECALL_THRESHOLD);
          });

          // 言語間差分は日本語平均 − 英語平均の丸め値
          const difference = languageRecallDifference(jaValues, enValues);
          expect(difference.jaMean).toBe(meanOf(jaValues));
          expect(difference.enMean).toBe(meanOf(enValues));
          expect(difference.differenceRaw).toBe(difference.jaMean - difference.enMean);
          expect(difference.difference).toBe(roundToPrecision(difference.differenceRaw, 3));

          // 引数を入れ替えると符号のみが反転する（絶対値は変わらない）
          const swapped = languageRecallDifference(enValues, jaValues);
          expect(swapped.difference === -difference.difference).toBe(true);
          expect(Math.abs(swapped.difference)).toBe(Math.abs(difference.difference));

          expect(aggregate.languageDifferences).toHaveLength(1);
          const reported = aggregate.languageDifferences[0];
          expect(reported.backend).toBe<RecallBackend>('dynamodb');
          expect(reported.distinctSkuK).toBe(distinctSkuK);
          expect(reported.jaMeanRecallAtK).toBe(difference.jaMean);
          expect(reported.enMeanRecallAtK).toBe(difference.enMean);
          expect(reported.difference).toBe(difference.difference);
          expect(reported.jaQueryCount).toBe(jaValues.length);
          expect(reported.enQueryCount).toBe(enValues.length);

          // 日英で対象クエリ集合が一致しているかは件数ではなく識別子集合で判定される
          const jaQueryIds = new Set(jaObservations.map((observation) => observation.queryId));
          const enQueryIds = new Set(enObservations.map((observation) => observation.queryId));
          const paired =
            jaQueryIds.size === enQueryIds.size &&
            Array.from(jaQueryIds).every((queryId) => enQueryIds.has(queryId));
          expect(reported.queryIdMismatch).toBe(!paired);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ============================================================
// Property 46
// ============================================================

describe('countMaterialSkus', () => {
  // Feature: vector-search-comparison, Property 46: 負例クラスの計数
  // 任意の 上位結果の itemId 列に対して、計上される Material_Sku の件数は
  // 資材を示す識別子パターンに一致する要素の実際の件数と等しく、
  // 0 件判定は当該件数が 0 であることと厳密に一致する。
  // **Validates: Requirements 13.15**
  it('資材パターンに一致する実際の件数と一致し、0 件判定が厳密に対応する', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray([...MIXED_ITEM_IDS], {
          minLength: 1,
          maxLength: MIXED_ITEM_IDS.length,
        }),
        fc.constantFrom(...DISTINCT_SKU_K_VALUES),
        (itemIds, distinctSkuK) => {
          const isMaterialPattern = (itemId: string): boolean => itemId.startsWith('ITEM#MAT-');
          const expectedAll = itemIds.filter(isMaterialPattern);

          expect(selectMaterialSkuItemIds(itemIds)).toEqual(expectedAll);
          expect(countMaterialSkus(itemIds)).toBe(expectedAll.length);
          expect(countMaterialSkus(itemIds) === 0).toBe(expectedAll.length === 0);

          // 上位 Distinct_Sku_K 件に対する計上（風味クエリの負例判定）
          const expectedTop = itemIds.slice(0, distinctSkuK).filter(isMaterialPattern);
          const observation = evaluateRecallObservation({
            queryId: 'q01',
            intent: 'flavor',
            backend: 'dynamodb',
            hits: buildTripletHits(itemIds),
            groundTruth: {
              language: 'ja',
              distinctSkuK,
              topK: WAREHOUSE_ROWS_PER_SKU * distinctSkuK,
              itemIds: TRUTH_ITEM_IDS.slice(0, distinctSkuK),
              warehouseId: null,
            },
          });

          expect(observation.materialSkuItemIds).toEqual(expectedTop);
          expect(observation.materialSkuCount).toBe(expectedTop.length);

          const aggregate = aggregateRecallObservations([observation]);
          expect(aggregate.flavorMaterialSku).toHaveLength(1);
          const summary = aggregate.flavorMaterialSku[0];
          expect(summary.intent).toBe('flavor');
          expect(summary.flavorQueryCount).toBe(1);
          expect(summary.materialSkuCount).toBe(expectedTop.length);

          // 0 件判定は件数が 0 であることと厳密に一致する
          expect(summary.materialSkuFree).toBe(expectedTop.length === 0);
          expect(aggregate.allFlavorGroupsMaterialSkuFree).toBe(expectedTop.length === 0);
          expect(summary.occurrences).toHaveLength(expectedTop.length === 0 ? 0 : 1);
        }
      ),
      { numRuns: 100 }
    );
  });
});
