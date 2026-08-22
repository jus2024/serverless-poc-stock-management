/**
 * 3 行複製に対する recall 1.0 の回帰テスト（例示テスト / 削除しない）
 *
 * **このファイルの存在理由。**
 * 同一 SKU の 3 倉庫行は同一のベクトルを持つ（前提 A11 / V12）。したがって完全な検索でも
 * 返却行は「一意 SKU × 3 行」の形で返る。返却行の itemId 集合をそのまま k で割る**素朴な
 * 算出式は、完全な検索に対してすら約 1/3 しか返さない壊れた式**である（知見 3）。
 * 本機能はこの式を「itemId 単位で重複排除したうえで上位 Distinct_Sku_K 件を Ground_Truth と
 * 照合する」形に修正した（要件 13.4 / 13.5、`TopK = 3 × Distinct_Sku_K` は要件 13.3）。
 *
 * 修正が効いていることの**唯一の直接的な証拠**は「3 行複製された完全一致の返却行に対して
 * recall が 1.0 になる」ことである。`recall.test.ts` の property テスト（値域・単調性・
 * 冪等性など）は、壊れた式でも一部が成立してしまうため、この 1 点を代替できない。
 * そのため専用ファイルとして分離し、他のテストの整理に巻き込まれて消えないようにしている。
 *
 * 各テストは修正後の {@link recallAtK} と、比較対象として残してある旧算出式
 * {@link legacyRowLevelRecallAtK} を**同一の入力**に通し、値の差をそのまま固定する。
 * 旧算出式側の期待値が落ちたら、それは壊れた式が復活した合図である。
 *
 * 要件: 13.3, 13.4, 13.5
 * 設計: 知見 3 / Testing Strategy 本改訂で追加する重点テスト
 * 前提: A11 / V12
 */

import { describe, expect, it } from 'vitest';

import { WAREHOUSE_ROWS_PER_SKU } from '../../amplify/functions/shared/vector/topk';
import {
  dedupeHitsByItemId,
  evaluateRecallObservation,
  legacyRowLevelRecallAtK,
  recallAtK,
  type RecallGroundTruth,
  type RecallHit,
} from './recall';

// ============================================================
// フィクスチャ
// ============================================================

/** Vector_Table の 3 倉庫。1 SKU がこの 3 行を占める（前提 A11） */
const WAREHOUSE_IDS = ['WH-TOKYO', 'WH-OSAKA', 'WH-FUKUOKA'] as const;

/**
 * Ground_Truth の上位 `count` 件の itemId。順位順。
 * 既存シードの ROASTED_BEANS 形式（`ITEM#{ORIGIN}-{VARIETY}-{GRADE}-{ROAST}-{SIZE}-V{n}`）に
 * 合わせてあるため、Material_Sku（負例クラス）とは判定されない。
 */
function buildGroundTruthItemIds(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `ITEM#ETHIOPIA-BOURBON-G1-MEDIUM-200G-V${index + 1}`
  );
}

/**
 * 「完全な検索」の返却行を組み立てる。
 *
 * Ground_Truth の上位 SKU を順位順にたどり、各 SKU について 3 倉庫行を**同一距離**で並べる。
 * これが実バックエンドの挙動である。同一ベクトルなので 3 行の距離は完全に一致し、
 * 距離昇順に並べると同一 SKU の 3 行が隣接する。
 *
 * 結果の行数は `3 × itemIds.length`（= 要件 13.3 の `TopK = 3 × Distinct_Sku_K`）になる。
 */
function buildPerfectlyMatchingHits(itemIds: readonly string[]): RecallHit[] {
  const hits: RecallHit[] = [];

  itemIds.forEach((itemId, skuIndex) => {
    // SKU 間では距離が異なり、SKU 内の 3 行は完全同値
    const distance = 0.1 + skuIndex * 0.01;
    WAREHOUSE_IDS.forEach((warehouseId) => {
      hits.push({ itemId, warehouseId, distance, rank: hits.length + 1 });
    });
  });

  return hits;
}

// ============================================================
// 前提の確認: フィクスチャが 3 行複製を再現していること
// ============================================================

describe('3 行複製の再現（前提 A11 / V12）', () => {
  it('完全一致の返却行は 10 SKU × 3 倉庫 = 30 行になり、各 SKU の 3 行は同一距離である', () => {
    const groundTruthItemIds = buildGroundTruthItemIds(10);
    const hits = buildPerfectlyMatchingHits(groundTruthItemIds);

    // 「10 SKU を得るために 30 行を要求する」という要件 13.3 の構造そのもの
    expect(hits).toHaveLength(30);
    expect(WAREHOUSE_ROWS_PER_SKU).toBe(3);

    const distinctSkus = dedupeHitsByItemId(hits);
    expect(distinctSkus).toHaveLength(10);
    expect(distinctSkus.map((sku) => sku.itemId)).toEqual(groundTruthItemIds);

    // 各 SKU がちょうど 3 行を占めている = 希釈が起きている状態を入力にしている
    expect(distinctSkus.map((sku) => sku.rowCount)).toEqual(Array(10).fill(3));

    // 同一 SKU の 3 行の距離が完全一致していること（同一ベクトルの帰結）
    hits.forEach((hit, index) => {
      const skuIndex = Math.floor(index / WAREHOUSE_ROWS_PER_SKU);
      expect(hit.distance).toBe(hits[skuIndex * WAREHOUSE_ROWS_PER_SKU].distance);
    });
  });
});

// ============================================================
// 本題: Distinct_Sku_K = 10 で recall 1.0（本機能で最も重要な確認）
// ============================================================

describe('Distinct_Sku_K = 10 の完全一致（要件 13.4 / 知見 3）', () => {
  const distinctSkuK = 10;
  const groundTruthItemIds = buildGroundTruthItemIds(distinctSkuK);
  const hits = buildPerfectlyMatchingHits(groundTruthItemIds);

  it('修正後の算出式は 1.0 を返す', () => {
    // 重複排除後の上位 10 件が Ground_Truth の上位 10 件と完全一致するため、積集合は 10 件。
    // 10 / 10 = 1.0。ここが 1.0 でなくなったら、SKU 粒度の重複排除が壊れている
    expect(recallAtK(hits, groundTruthItemIds, distinctSkuK)).toBe(1);
  });

  it('旧算出式は同一入力に対して 1/3 水準の値しか返さない（修正が効いている直接的な証拠）', () => {
    // 旧算出式は重複排除せずに先頭 10 行だけを見る。10 行に収まる一意 SKU は
    // ceil(10 / 3) = 4 件のみなので 4 / 10 = 0.4。完全な検索に対する値としては明らかに誤りで、
    // 知見 3 が言う「約 0.33」の水準に落ちる（k が 3 の倍数なら厳密に 1/3 になる。下の k = 33 参照）
    const legacy = legacyRowLevelRecallAtK(hits, groundTruthItemIds, distinctSkuK);

    expect(legacy).toBe(0.4);
    expect(legacy).toBeLessThan(0.5);

    // 同一入力に対する 2 つの式の差。これが 0 に近づいたら、どちらかの式が入れ替わっている
    expect(recallAtK(hits, groundTruthItemIds, distinctSkuK) - legacy).toBeCloseTo(0.6, 10);
  });

  it('測定 1 件分の組み立て（TopK = 30 要求）でも recall は 1.0 になる（要件 13.3 / 13.5）', () => {
    const groundTruth: RecallGroundTruth = {
      language: 'ja',
      distinctSkuK,
      topK: WAREHOUSE_ROWS_PER_SKU * distinctSkuK,
      itemIds: groundTruthItemIds,
      warehouseId: null,
    };

    const observation = evaluateRecallObservation({
      queryId: 'regression-perfect-match',
      intent: 'flavor',
      backend: 'dynamodb',
      hits,
      groundTruth,
    });

    expect(observation.topK).toBe(30);
    expect(observation.requestedTopK).toBe(30);
    expect(observation.recallAtK).toBe(1);
    expect(observation.matchedCount).toBe(10);
    expect(observation.returnedRowCount).toBe(30);
    expect(observation.distinctSkuCount).toBe(10);
    expect(observation.topDistinctSkuItemIds).toEqual(groundTruthItemIds);

    // 3 行複製の帰結として距離の完全同値が 10 組 × 3 行で現れる（要件 13.13）
    expect(observation.exactTie.exactTieGroupCount).toBe(10);
    expect(observation.exactTie.exactTieRowCount).toBe(30);
    expect(observation.exactTie.maxExactTieGroupSize).toBe(3);

    // 風味クエリの上位に資材 SKU は含まれない（フィクスチャは全件 ROASTED_BEANS）
    expect(observation.materialSkuCount).toBe(0);
  });

  it('同一の関数を OpenSearch 側の返却行にも適用して同じ 1.0 になる（要件 13.5）', () => {
    // OpenSearch が返す行順・rank の付き方が違っても、算出式は分岐しない。
    // ここでは 3 行の並びが倉庫単位で入れ替わった（同一距離なので順序は保証されない）状態を渡す
    const reorderedWithinSku = hits.map((hit, index) => {
      const skuIndex = Math.floor(index / WAREHOUSE_ROWS_PER_SKU);
      const withinSku = index % WAREHOUSE_ROWS_PER_SKU;
      const reversedWithinSku = WAREHOUSE_ROWS_PER_SKU - 1 - withinSku;
      return {
        ...hit,
        warehouseId: WAREHOUSE_IDS[reversedWithinSku],
        rank: skuIndex * WAREHOUSE_ROWS_PER_SKU + withinSku + 1,
      };
    });

    expect(recallAtK(reorderedWithinSku, groundTruthItemIds, distinctSkuK)).toBe(1);
  });
});

// ============================================================
// 境界: Distinct_Sku_K = 1 / 33（測定する k の下限と上限）
// ============================================================

describe('Distinct_Sku_K = 1 の完全一致（要件 13.3 の下限）', () => {
  const distinctSkuK = 1;
  const groundTruthItemIds = buildGroundTruthItemIds(distinctSkuK);
  const hits = buildPerfectlyMatchingHits(groundTruthItemIds);

  it('修正後の算出式は 1.0 を返す', () => {
    expect(hits).toHaveLength(3);
    expect(recallAtK(hits, groundTruthItemIds, distinctSkuK)).toBe(1);
  });

  it('k = 1 では旧算出式も 1.0 になる（小さい k の確認だけでは本バグを検出できない）', () => {
    // 先頭 1 行だけを見れば 1 件の一意 SKU が得られるため、壊れた式でも 1 / 1 = 1.0 になる。
    // この一致こそが本バグを見逃した原因なので、k = 1 の確認を根拠にしないための記録として残す
    expect(legacyRowLevelRecallAtK(hits, groundTruthItemIds, distinctSkuK)).toBe(1);
  });
});

describe('Distinct_Sku_K = 33 の完全一致（要件 13.3 の上限）', () => {
  const distinctSkuK = 33;
  const groundTruthItemIds = buildGroundTruthItemIds(distinctSkuK);
  const hits = buildPerfectlyMatchingHits(groundTruthItemIds);

  it('修正後の算出式は 1.0 を返す（TopK 99 は上限 100 に収まる）', () => {
    expect(hits).toHaveLength(99);
    expect(recallAtK(hits, groundTruthItemIds, distinctSkuK)).toBe(1);
  });

  it('旧算出式は厳密に 1/3（約 0.33）を返す（知見 3 の数値そのもの）', () => {
    // 先頭 33 行に収まる一意 SKU は 33 / 3 = 11 件。11 / 33 = 0.333…。
    // 完全な検索に対して約 0.33 を返すという知見 3 の記述が、そのまま再現される
    const legacy = legacyRowLevelRecallAtK(hits, groundTruthItemIds, distinctSkuK);

    expect(legacy).toBe(11 / 33);
    expect(legacy).toBeCloseTo(0.333, 3);
  });
});
