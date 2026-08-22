/**
 * SKU 粒度の recall 算出と集計
 *
 * 本モジュールは検証の中核的な修正点を担う。同一 SKU の 3 倉庫行は**同一のベクトル**を持つため
 * （前提 A11 / V12）、TopK 10 の検索が返す一意 SKU は約 3 件にとどまる。返却行の itemId 集合を
 * そのまま k で割る素朴な算出式は、**完全な検索でも約 0.33** を返す壊れた式である（知見 3）。
 *
 * したがって recall は次の手順で測る。
 *
 * 1. Distinct_Sku_K を 1 / 10 / 33 から選ぶ
 * 2. 両バックエンドへ `TopK = 3 × Distinct_Sku_K`（= 3 / 30 / 99）を要求する（要件 13.3）
 * 3. 返却行を {@link dedupeByItemId} で itemId 単位に重複排除する。同一 itemId の**初出行**の順位を採用する
 * 4. 重複排除後の上位 Distinct_Sku_K 件の itemId 集合を求める
 * 5. その集合と Ground_Truth の itemId 集合の積集合サイズを Distinct_Sku_K で除す（要件 13.4）
 * 6. OpenSearch 側にも**同一関数**を適用する（要件 13.5）
 *
 * 設計上の要点:
 *
 * - **両バックエンドで同一の関数を通す。** バックエンド識別子は集計の切り口としてのみ使い、
 *   算出式の分岐には一切使わない。式が分岐すると「バックエンドの差」と「式の差」が
 *   測定値の中で混ざり、比較が成立しなくなる（要件 13.5）
 * - **純関数のみで構成する。** AWS SDK もファイルシステムも参照せず、モジュール読み込み時の
 *   副作用も持たない。測定 CLI（task 11.4）は本モジュールを import して組み立てる
 * - **入力を構造的な最小形で受ける。** 返却行は {@link RecallHit} として itemId / distance /
 *   rank のみを要求する。`src/lib/inventory/vector-types.ts` の `VectorSearchHit` は
 *   この形を満たすためそのまま渡せる。フロントエンドの型に依存しないので、
 *   スクリプト層と Web アプリ層の分離が保たれる
 * - **順位は配列順で解釈する。** 「初出行」は入力配列における出現順で決まる。`rank` は
 *   出力に載せる情報としてのみ使い、並べ替えには使わない。バックエンドが返した順序を
 *   測定側で組み替えると、近似検索の挙動そのものが観測できなくなる
 *
 * 要件: 13.3, 13.4, 13.5, 13.6, 13.8, 13.11, 13.13, 13.15
 * 設計: recall の算出（SKU 粒度） / 知見 3
 */

import { isMaterialSku } from '../../amplify/functions/shared/vector/sku-metadata';
import type { VectorLanguage } from '../../amplify/functions/shared/vector/language';
import { VECTOR_LANGUAGES } from '../../amplify/functions/shared/vector/language';
import {
  DISTINCT_SKU_K_DERIVATION,
  distinctSkuKToTopK,
  MAX_DISTINCT_SKU_K,
  MAX_TOP_K,
  WAREHOUSE_ROWS_PER_SKU,
} from '../../amplify/functions/shared/vector/topk';
import { DEDUPE_UNIT, DISTINCT_SKU_K_VALUES, type GroundTruth } from './ground-truth';
import type { QueryIntent } from './paired-queries';

export type { VectorLanguage, QueryIntent };

// ============================================================
// 定数
// ============================================================

/** 「recall 99% 以上」の主張を判定する閾値。出力に含める（要件 13.11 / 18.19） */
export const RECALL_THRESHOLD = 0.99;

/** 集計対象のバックエンド識別子。`src/lib/inventory/vector-types.ts` の `VectorBackend` と同値 */
export const RECALL_BACKENDS = ['dynamodb', 'opensearch'] as const;

/** 言語間差分を丸める小数桁数（要件 13.8） */
export const LANGUAGE_DIFFERENCE_PRECISION = 3;

/** 負例クラスの判定対象とするクエリ意図。風味クエリのみ（要件 13.15） */
export const NEGATIVE_CLASS_QUERY_INTENT: QueryIntent = 'flavor';

// ============================================================
// エラー
// ============================================================

/**
 * recall の算出・集計を続行できない状態。
 *
 * 測定不能な Distinct_Sku_K、言語やバックエンドの取り違え、Ground_Truth と観測の条件不一致など、
 * 気付かずに続けると数値が意味を失う条件では例外にする。
 */
export class RecallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecallError';
  }
}

// ============================================================
// 型
// ============================================================

/** バックエンド識別子 */
export type RecallBackend = (typeof RECALL_BACKENDS)[number];

/**
 * recall 算出に必要な返却行の最小形。
 *
 * `src/lib/inventory/vector-types.ts` の `VectorSearchHit` は本インターフェースを構造的に満たすため、
 * 両バックエンドのハンドラ応答をそのまま渡せる。ベクトル本体は算出に不要なので受け取らない。
 */
export interface RecallHit {
  itemId: string;
  /** 行を識別する倉庫 ID。重複排除の観測（3 行複製の確認）に使う */
  warehouseId?: string;
  /** 正規化コサイン距離（0〜2、小さいほど類似）。完全同値行の計上に使う（要件 13.13） */
  distance: number;
  /** バックエンドが付けた 1 始まりの行順位。非有限値のときは配列位置で代替する */
  rank?: number;
}

/** 重複排除後の一意 SKU 1 件 */
export interface DedupedSku {
  itemId: string;
  /** 重複排除後の 1 始まりの順位。上位 Distinct_Sku_K 件の切り出しはこの順位で行う */
  distinctRank: number;
  /** 初出行の行順位（`rank` が非有限なら配列位置 + 1） */
  firstRowRank: number;
  /** 初出行の距離 */
  distance: number;
  /** 当該 itemId が占めた返却行数。3 行複製が起きていれば 3 になる */
  rowCount: number;
  /** 初出行の warehouseId。入力に無ければ null */
  firstWarehouseId: string | null;
}

/** 距離の完全同値の計上（要件 13.13） */
export interface ExactDistanceTieReport {
  /** 計上対象の返却行数 */
  rowCount: number;
  /** 距離が他の行と完全一致した行の件数。同値の組に属する行をすべて数える */
  exactTieRowCount: number;
  /** 距離が完全一致した行のまとまりの数（各まとまりは 2 行以上） */
  exactTieGroupCount: number;
  /** 最大のまとまりの行数。3 行複製が効いていれば 3 以上になる */
  maxExactTieGroupSize: number;
  /** 距離が非有限（NaN / Infinity）で同値判定から除外した行数 */
  nonFiniteDistanceCount: number;
}

/**
 * Ground_Truth のうち recall 算出に必要な部分。
 * `ground-truth.ts` の {@link GroundTruth} をそのまま渡せる。
 */
export type RecallGroundTruth = Pick<
  GroundTruth,
  'language' | 'distinctSkuK' | 'topK' | 'itemIds' | 'warehouseId'
>;

/** 1 件の測定（1 クエリ × 1 バックエンド × 1 言語 × 1 Distinct_Sku_K）の入力 */
export interface RecallObservationInput {
  /** Paired_Query_Set の識別子。日英で同一の値を使う（要件 13.7） */
  queryId: string;
  /** クエリ意図。風味クエリの絞り込みに使う（要件 13.15） */
  intent: QueryIntent;
  backend: RecallBackend;
  /** 当該バックエンドの返却行（バックエンドが返した順序のまま） */
  hits: readonly RecallHit[];
  /** 当該言語・当該 Distinct_Sku_K の Ground_Truth */
  groundTruth: RecallGroundTruth;
  /** 実際に要求した TopK。省略時は Ground_Truth の `topK` を採用する */
  requestedTopK?: number;
}

/** 1 件の測定結果 */
export interface RecallObservation {
  queryId: string;
  intent: QueryIntent;
  backend: RecallBackend;
  language: VectorLanguage;
  distinctSkuK: number;
  /** 要求すべき TopK（= 3 × Distinct_Sku_K、要件 13.3） */
  topK: number;
  /** 実際に要求した TopK */
  requestedTopK: number;
  /** 倉庫フィルタ。無効時は null（要件 13.14） */
  warehouseId: string | null;
  dedupeUnit: typeof DEDUPE_UNIT;
  /** SKU 粒度の Recall_At_K（0 以上 1 以下、要件 13.4 / 13.5） */
  recallAtK: number;
  /** 積集合サイズ。`recallAtK × distinctSkuK` に一致する */
  matchedCount: number;
  /** 重複排除後の上位 Distinct_Sku_K 件の itemId（順位順） */
  topDistinctSkuItemIds: readonly string[];
  /** 返却行数 */
  returnedRowCount: number;
  /** 返却行に含まれた一意 SKU 件数 */
  distinctSkuCount: number;
  /** Ground_Truth の件数。一意ベクトル件数が k 未満なら k を下回る */
  groundTruthSize: number;
  /** 距離の完全同値の計上（要件 13.13） */
  exactTie: ExactDistanceTieReport;
  /** 上位 Distinct_Sku_K 件に含まれた Material_Sku 件数（要件 13.15） */
  materialSkuCount: number;
  /** 上位 Distinct_Sku_K 件に含まれた Material_Sku の itemId */
  materialSkuItemIds: readonly string[];
}

/** バックエンド × 言語 × Distinct_Sku_K の集計（要件 13.6 / 13.11 / 13.13） */
export interface RecallGroupSummary {
  backend: RecallBackend;
  language: VectorLanguage;
  distinctSkuK: number;
  topK: number;
  /** 集計に含めたクエリ件数（要件 13.9） */
  queryCount: number;
  meanRecallAtK: number;
  minRecallAtK: number;
  maxRecallAtK: number;
  /** 判定に用いた閾値（要件 13.11） */
  threshold: number;
  /** 閾値を下回ったクエリ件数（要件 13.6） */
  belowThresholdCount: number;
  /** 閾値を下回ったクエリの識別子（順序は入力順） */
  belowThresholdQueryIds: readonly string[];
  /** 平均が閾値以上か（要件 13.11） */
  passed: boolean;
  /** 集計対象の返却行数の合計 */
  returnedRowCount: number;
  /** 距離が完全一致した行の合計件数（要件 13.13） */
  exactTieRowCount: number;
  /** 距離が完全一致した行のまとまりの合計数 */
  exactTieGroupCount: number;
  /** 距離が非有限で同値判定から除外した行の合計件数 */
  nonFiniteDistanceCount: number;
}

/** バックエンド × Distinct_Sku_K の言語間差分（要件 13.8） */
export interface LanguageRecallDifference {
  backend: RecallBackend;
  distinctSkuK: number;
  jaMeanRecallAtK: number;
  enMeanRecallAtK: number;
  /** 日本語平均 − 英語平均（小数第 3 位まで、要件 13.8） */
  difference: number;
  /** 丸め前の差。丸めによる情報損失を追跡できるように残す */
  differenceRaw: number;
  jaQueryCount: number;
  enQueryCount: number;
  /**
   * 日英で集計対象のクエリ識別子**集合**が一致しなかった場合 true。
   * 要件 13.8 は「同一の Paired_Query_Set について」の差分を求めるため、
   * true のときは差分を言語差として解釈できない。件数の一致だけでは
   * 別のクエリ同士を比べている状態を検出できないので、識別子集合で判定する。
   */
  queryIdMismatch: boolean;
  /** 日英の双方に測定があったクエリ件数 */
  sharedQueryCount: number;
  /** 片方の言語にのみ測定があったクエリ識別子（昇順）。一致していれば空 */
  unpairedQueryIds: readonly string[];
}

/** 風味クエリに対する Material_Sku の計上（要件 13.15） */
export interface FlavorMaterialSkuSummary {
  backend: RecallBackend;
  language: VectorLanguage;
  distinctSkuK: number;
  /** 対象としたクエリ意図。`flavor` 固定 */
  intent: QueryIntent;
  /** 集計に含めた風味クエリ件数 */
  flavorQueryCount: number;
  /** 上位 Distinct_Sku_K 件に含まれた Material_Sku の合計件数 */
  materialSkuCount: number;
  /** 合計件数が 0 件か（要件 13.15 の判定結果） */
  materialSkuFree: boolean;
  /** Material_Sku が現れたクエリの内訳 */
  occurrences: readonly FlavorMaterialSkuOccurrence[];
}

/** Material_Sku が上位に現れた 1 クエリ分の内訳 */
export interface FlavorMaterialSkuOccurrence {
  queryId: string;
  itemIds: readonly string[];
}

/** 測定条件の要約。機械可読出力に載せる（要件 13.3 / 13.9） */
export interface RecallMeasurementScope {
  dedupeUnit: typeof DEDUPE_UNIT;
  rowsPerSku: number;
  distinctSkuKValues: readonly number[];
  topKValues: readonly number[];
  maxDistinctSkuK: number;
  maxTopK: number;
  /** Distinct_Sku_K 上限の導出根拠（要件 13.3） */
  derivation: string;
  threshold: number;
  backends: readonly RecallBackend[];
  languages: readonly VectorLanguage[];
}

/** 集計結果の全体 */
export interface RecallAggregate {
  scope: RecallMeasurementScope;
  /** 集計に含めた測定件数 */
  observationCount: number;
  /** 集計に現れたクエリ識別子の一意件数 */
  queryCount: number;
  /** 集計に現れた倉庫フィルタ条件（重複なし、null はフィルタ無効） */
  warehouseIds: readonly (string | null)[];
  groups: readonly RecallGroupSummary[];
  languageDifferences: readonly LanguageRecallDifference[];
  flavorMaterialSku: readonly FlavorMaterialSkuSummary[];
  /** すべてのグループが閾値を満たしたか */
  allGroupsPassed: boolean;
  /** すべての風味クエリ集計で Material_Sku が 0 件だったか（要件 13.15） */
  allFlavorGroupsMaterialSkuFree: boolean;
}

/** 集計のオプション */
export interface AggregateRecallOptions {
  /** 判定閾値。既定は {@link RECALL_THRESHOLD}（0.99） */
  threshold?: number;
  /** 出力に載せる Distinct_Sku_K の一覧。既定は 1 / 10 / 33 */
  distinctSkuKValues?: readonly number[];
}

// ============================================================
// 重複排除（純関数）
// ============================================================

/**
 * 返却行を itemId 単位で重複排除し、行の順位を保って一意 SKU 列にする（要件 13.4）。
 *
 * 同一 itemId の**初出行**の位置を採用する。並べ替えは行わないため、
 * 出力順は入力配列における各 itemId の初出順と一致する。2 回適用しても結果は変わらない
 * （1 回目の出力は itemId が一意なので恒等になる）。
 *
 * @throws {RecallError} itemId が文字列でない、または空文字の行がある場合
 */
export function dedupeByItemId(hits: readonly RecallHit[]): string[] {
  return dedupeHitsByItemId(hits).map((sku) => sku.itemId);
}

/**
 * {@link dedupeByItemId} の詳細版。順位・距離・占有行数を保った一意 SKU 列を返す。
 *
 * 3 行複製が実際に起きているか（`rowCount === 3`）を観測できるようにするため、
 * itemId だけでなく行の内訳も返す。
 *
 * @throws {RecallError} itemId が文字列でない、または空文字の行がある場合
 */
export function dedupeHitsByItemId(hits: readonly RecallHit[]): DedupedSku[] {
  const order: string[] = [];
  const byItemId = new Map<
    string,
    { firstRowRank: number; distance: number; rowCount: number; firstWarehouseId: string | null }
  >();

  for (let i = 0; i < hits.length; i += 1) {
    const hit = hits[i];

    if (typeof hit?.itemId !== 'string' || hit.itemId === '') {
      throw new RecallError(
        `返却行の itemId が空です（index=${i}）。itemId 単位の重複排除ができません。`
      );
    }

    const existing = byItemId.get(hit.itemId);
    if (existing !== undefined) {
      existing.rowCount += 1;
      continue;
    }

    order.push(hit.itemId);
    byItemId.set(hit.itemId, {
      // バックエンドが rank を返さない・非有限値を返す場合は配列位置で代替する
      firstRowRank: typeof hit.rank === 'number' && Number.isFinite(hit.rank) ? hit.rank : i + 1,
      distance: hit.distance,
      rowCount: 1,
      firstWarehouseId: typeof hit.warehouseId === 'string' ? hit.warehouseId : null,
    });
  }

  return order.map((itemId, index) => {
    // order は byItemId のキーから作っているので undefined にはならない
    const entry = byItemId.get(itemId) as {
      firstRowRank: number;
      distance: number;
      rowCount: number;
      firstWarehouseId: string | null;
    };
    return {
      itemId,
      distinctRank: index + 1,
      firstRowRank: entry.firstRowRank,
      distance: entry.distance,
      rowCount: entry.rowCount,
      firstWarehouseId: entry.firstWarehouseId,
    };
  });
}

/**
 * 重複排除後の上位 Distinct_Sku_K 件の itemId を返す（要件 13.4）。
 *
 * 一意 SKU 件数が Distinct_Sku_K に届かない場合は得られた件数だけを返す。
 * 不足は recall の分母（Distinct_Sku_K）を変えないため、値として下がる形で現れる。
 *
 * @throws {RecallError} Distinct_Sku_K が 1〜33 の整数でない場合
 */
export function topDistinctSkuItemIds(
  hits: readonly RecallHit[],
  distinctSkuK: number
): string[] {
  const derived = resolveDistinctSkuK(distinctSkuK);
  return dedupeByItemId(hits).slice(0, derived.distinctSkuK);
}

// ============================================================
// recall の算出（純関数）
// ============================================================

/**
 * SKU 粒度の Recall_At_K を算出する（要件 13.4 / 13.5）。
 *
 * `TopK = 3 × distinctSkuK` を要求済みであることを前提とする。手順は次のとおり。
 *
 * 1. 返却行を itemId 単位で重複排除する（同一 itemId の初出行の順位を採用）
 * 2. 重複排除後の上位 `distinctSkuK` 件の itemId 集合を求める
 * 3. Ground_Truth の itemId 集合との積集合サイズを `distinctSkuK` で除す
 *
 * **両バックエンドに同一の関数を適用する。** バックエンドによる分岐は存在しない（要件 13.5）。
 *
 * `groundTruthItemIds` は上位 `distinctSkuK` 件の正解列である。呼び出し側が誤って全順位を
 * 渡した場合に recall が過大に出ることを防ぐため、先頭 `distinctSkuK` 件のみを正解集合として扱う。
 *
 * 分母は常に `distinctSkuK` である（要件 13.4）。一意ベクトル件数が `distinctSkuK` 未満で
 * Ground_Truth が短い場合、上限は `groundTruthItemIds.length / distinctSkuK` になる。
 *
 * @returns 0 以上 1 以下の値
 * @throws {RecallError} Distinct_Sku_K が 1〜33 の整数でない場合
 */
export function recallAtK(
  returnedHits: readonly RecallHit[],
  groundTruthItemIds: readonly string[],
  distinctSkuK: number
): number {
  return recallFromDistinctSkus(dedupeByItemId(returnedHits), groundTruthItemIds, distinctSkuK)
    .recallAtK;
}

/**
 * 算出式の単一の実装。重複排除済みの一意 SKU 列を受け取り、上位 k 件と Ground_Truth の
 * 積集合サイズを k で割る。{@link recallAtK} と {@link evaluateRecallObservation} は
 * ともにこの関数を通るため、両者の値が食い違うことはない。
 */
function recallFromDistinctSkus(
  distinctSkuItemIds: readonly string[],
  groundTruthItemIds: readonly string[],
  distinctSkuK: number
): { recallAtK: number; matchedCount: number; topItemIds: string[]; groundTruthSize: number } {
  const derived = resolveDistinctSkuK(distinctSkuK);
  const k = derived.distinctSkuK;

  const truth = new Set<string>(groundTruthItemIds.slice(0, k));
  const topItemIds = distinctSkuItemIds.slice(0, k);

  let matchedCount = 0;
  for (let i = 0; i < topItemIds.length; i += 1) {
    if (truth.has(topItemIds[i])) {
      matchedCount += 1;
    }
  }

  return { recallAtK: matchedCount / k, matchedCount, topItemIds, groundTruthSize: truth.size };
}

/**
 * **旧算出式**。返却行の先頭 `distinctSkuK` 行の itemId 集合を `distinctSkuK` で割る。
 *
 * この式は 3 行複製の下で**完全な検索でも約 0.33 しか返さない**（知見 3 / V12）。
 * 修正が効いていることを回帰テストで直接示すための比較対象としてのみ公開しており、
 * 測定値の算出には使わない。新しい呼び出し側は {@link recallAtK} を使う。
 *
 * @deprecated 壊れた算出式。{@link recallAtK} との対比にのみ使う
 * @throws {RecallError} Distinct_Sku_K が 1〜33 の整数でない場合
 */
export function legacyRowLevelRecallAtK(
  returnedHits: readonly RecallHit[],
  groundTruthItemIds: readonly string[],
  distinctSkuK: number
): number {
  const derived = resolveDistinctSkuK(distinctSkuK);
  const k = derived.distinctSkuK;
  const truth = new Set<string>(groundTruthItemIds.slice(0, k));

  // 重複排除せずに先頭 k 行だけを見る。3 行複製により一意 SKU は約 k / 3 件しか含まれない
  const seen = new Set<string>();
  const rows = returnedHits.slice(0, k);
  for (let i = 0; i < rows.length; i += 1) {
    const itemId = rows[i]?.itemId;
    if (typeof itemId === 'string' && itemId !== '' && truth.has(itemId)) {
      seen.add(itemId);
    }
  }

  return seen.size / k;
}

/**
 * Distinct_Sku_K を検証して要求すべき TopK を導出する（要件 13.3）。
 * 上限 33 の導出根拠（TopK 上限 100 ÷ 倉庫行数 3）を含む結果を返す。
 *
 * @throws {RecallError} 1〜33 の整数でない場合
 */
export function resolveDistinctSkuK(distinctSkuK: number): {
  distinctSkuK: number;
  topK: number;
  maxDistinctSkuK: number;
  maxTopK: number;
  rowsPerSku: number;
  derivation: string;
} {
  const derived = distinctSkuKToTopK(distinctSkuK);
  if (!derived.ok) {
    throw new RecallError(derived.message);
  }
  return {
    distinctSkuK: derived.distinctSkuK,
    topK: derived.topK,
    maxDistinctSkuK: derived.maxDistinctSkuK,
    maxTopK: derived.maxTopK,
    rowsPerSku: derived.rowsPerSku,
    derivation: derived.derivation,
  };
}

// ============================================================
// 完全同値行の計上（純関数）
// ============================================================

/**
 * 返却行のうち距離が完全一致した行の件数を計上する（要件 13.13）。
 *
 * 3 行複製の帰結として k 境界での距離完全同値が頻出する。Distinct_Sku_K = 10 なら要求 TopK は 30 で、
 * 10 番目の SKU の 3 行のうち一部だけが 30 件に入る境界ケースが起こりうる。
 * この危険要因を定量化するため、同値の組に属する行をすべて数える。
 *
 * 距離が非有限（NaN / Infinity）の行は同値判定から除外し、件数のみ別に報告する。
 * NaN は自身とも等しくないため、同値として扱うと計上値が意味を失う。
 */
export function countExactDistanceTies(hits: readonly RecallHit[]): ExactDistanceTieReport {
  const byDistance = new Map<number, number>();
  let nonFiniteDistanceCount = 0;

  for (let i = 0; i < hits.length; i += 1) {
    const distance = hits[i]?.distance;
    if (typeof distance !== 'number' || !Number.isFinite(distance)) {
      nonFiniteDistanceCount += 1;
      continue;
    }
    byDistance.set(distance, (byDistance.get(distance) ?? 0) + 1);
  }

  let exactTieRowCount = 0;
  let exactTieGroupCount = 0;
  let maxExactTieGroupSize = 0;

  byDistance.forEach((count) => {
    if (count >= 2) {
      exactTieRowCount += count;
      exactTieGroupCount += 1;
      if (count > maxExactTieGroupSize) {
        maxExactTieGroupSize = count;
      }
    }
  });

  return {
    rowCount: hits.length,
    exactTieRowCount,
    exactTieGroupCount,
    maxExactTieGroupSize,
    nonFiniteDistanceCount,
  };
}

// ============================================================
// 負例クラスの計上（純関数）
// ============================================================

/**
 * itemId 列に含まれる Material_Sku（資材カテゴリ）の itemId を返す（要件 13.15）。
 * 判定は `amplify/functions/shared/vector/sku-metadata.ts` の `isMaterialSku` に委ねる。
 */
export function selectMaterialSkuItemIds(itemIds: readonly string[]): string[] {
  return itemIds.filter((itemId) => isMaterialSku(itemId));
}

/** itemId 列に含まれる Material_Sku の件数を返す（要件 13.15） */
export function countMaterialSkus(itemIds: readonly string[]): number {
  return selectMaterialSkuItemIds(itemIds).length;
}

// ============================================================
// 1 件の測定（純関数）
// ============================================================

/**
 * 1 クエリ × 1 バックエンド × 1 言語 × 1 Distinct_Sku_K の測定結果を組み立てる。
 *
 * バックエンドによる分岐を持たない。DynamoDB 側も OpenSearch 側も同一の経路を通る（要件 13.5）。
 *
 * @throws {RecallError} Distinct_Sku_K が測定不能な場合、要求 TopK が Ground_Truth の
 *   前提（3 × k）と異なる場合、または返却行の itemId が空の場合
 */
export function evaluateRecallObservation(input: RecallObservationInput): RecallObservation {
  const derived = resolveDistinctSkuK(input.groundTruth.distinctSkuK);
  const requestedTopK = input.requestedTopK ?? input.groundTruth.topK ?? derived.topK;

  if (requestedTopK !== derived.topK) {
    throw new RecallError(
      `要求 TopK が Distinct_Sku_K = ${derived.distinctSkuK} の前提と一致しません` +
        `（要求 ${requestedTopK} / 必要 ${derived.topK}）。${DISTINCT_SKU_K_DERIVATION}`
    );
  }

  const distinctSkus = dedupeHitsByItemId(input.hits);
  const { recallAtK: value, matchedCount, topItemIds, groundTruthSize } = recallFromDistinctSkus(
    distinctSkus.map((sku) => sku.itemId),
    input.groundTruth.itemIds,
    derived.distinctSkuK
  );
  const materialSkuItemIds = selectMaterialSkuItemIds(topItemIds);

  return {
    queryId: input.queryId,
    intent: input.intent,
    backend: input.backend,
    language: input.groundTruth.language,
    distinctSkuK: derived.distinctSkuK,
    topK: derived.topK,
    requestedTopK,
    warehouseId: input.groundTruth.warehouseId,
    dedupeUnit: DEDUPE_UNIT,
    recallAtK: value,
    matchedCount,
    topDistinctSkuItemIds: topItemIds,
    returnedRowCount: input.hits.length,
    distinctSkuCount: distinctSkus.length,
    groundTruthSize,
    exactTie: countExactDistanceTies(input.hits),
    materialSkuCount: materialSkuItemIds.length,
    materialSkuItemIds,
  };
}

// ============================================================
// 集計（純関数）
// ============================================================

/**
 * 測定結果を集計する（要件 13.6 / 13.8 / 13.11 / 13.13 / 13.15）。
 *
 * 集計の切り口は 3 つ。
 *
 * - バックエンド × 言語 × Distinct_Sku_K の統計（平均・最小・最大・閾値未満件数・合否・完全同値行）
 * - バックエンド × Distinct_Sku_K の言語間差分（小数第 3 位）
 * - バックエンド × 言語 × Distinct_Sku_K の風味クエリに対する Material_Sku 件数と 0 件判定
 *
 * グループの並び順はバックエンド（dynamodb → opensearch）→ 言語（ja → en）→ Distinct_Sku_K 昇順で
 * 固定する。入力の並びに依存しないため、同一入力に対して常に同一の出力になる（要件 13.10）。
 *
 * @throws {RecallError} 閾値が 0〜1 の有限数でない場合
 */
export function aggregateRecallObservations(
  observations: readonly RecallObservation[],
  options: AggregateRecallOptions = {}
): RecallAggregate {
  const threshold = options.threshold ?? RECALL_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RecallError(
      `判定閾値は 0 以上 1 以下の有限数のみを受け付けます（受信値: ${String(threshold)}）。`
    );
  }

  const distinctSkuKValues = uniqueSortedNumbers(
    options.distinctSkuKValues ?? DISTINCT_SKU_K_VALUES
  );
  const groups = buildGroupSummaries(observations, threshold);
  const flavorMaterialSku = buildFlavorMaterialSkuSummaries(observations);
  const languageDifferences = buildLanguageDifferences(observations);

  return {
    scope: {
      dedupeUnit: DEDUPE_UNIT,
      rowsPerSku: WAREHOUSE_ROWS_PER_SKU,
      distinctSkuKValues,
      topKValues: distinctSkuKValues.map((k) => WAREHOUSE_ROWS_PER_SKU * k),
      maxDistinctSkuK: MAX_DISTINCT_SKU_K,
      maxTopK: MAX_TOP_K,
      derivation: DISTINCT_SKU_K_DERIVATION,
      threshold,
      backends: RECALL_BACKENDS.slice(),
      languages: VECTOR_LANGUAGES.slice(),
    },
    observationCount: observations.length,
    queryCount: countDistinctValues(observations.map((observation) => observation.queryId)),
    warehouseIds: uniqueWarehouseIds(observations),
    groups,
    languageDifferences,
    flavorMaterialSku,
    allGroupsPassed: groups.every((group) => group.passed),
    allFlavorGroupsMaterialSkuFree: flavorMaterialSku.every(
      (summary) => summary.materialSkuFree
    ),
  };
}

/**
 * 2 つの Recall_At_K 列の言語間差分を算出する（要件 13.8）。
 *
 * 差分は日本語平均 − 英語平均を小数第 3 位で丸めた値である。丸めは 0 から遠い側へ行うため、
 * 引数を入れ替えると符号のみが反転する（`difference(a, b) === -difference(b, a)`）。
 * 空配列の平均は 0 として扱う。
 */
export function languageRecallDifference(
  jaValues: readonly number[],
  enValues: readonly number[]
): { jaMean: number; enMean: number; difference: number; differenceRaw: number } {
  const jaMean = mean(jaValues);
  const enMean = mean(enValues);
  const differenceRaw = jaMean - enMean;
  return {
    jaMean,
    enMean,
    difference: roundToPrecision(differenceRaw, LANGUAGE_DIFFERENCE_PRECISION),
    differenceRaw,
  };
}

/**
 * 0 から遠い側へ丸める（round-half-away-from-zero）。
 *
 * `Math.round` は負値で 0 側へ丸めるため（`Math.round(-0.5) === -0`）、
 * 符号を入れ替えたときに絶対値が変わる。言語間差分は符号の反転のみで対応させたいので、
 * 絶対値に対して丸めてから符号を戻す。
 */
export function roundToPrecision(value: number, precision: number): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  const factor = Math.pow(10, precision);
  const rounded = Math.round(Math.abs(value) * factor) / factor;
  return value < 0 ? -rounded : rounded;
}

// ============================================================
// 内部実装
// ============================================================

/** バックエンド × 言語 × Distinct_Sku_K のグループ集計を組み立てる */
function buildGroupSummaries(
  observations: readonly RecallObservation[],
  threshold: number
): RecallGroupSummary[] {
  const buckets = new Map<string, RecallObservation[]>();

  observations.forEach((observation) => {
    const key = groupKey(observation.backend, observation.language, observation.distinctSkuK);
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [observation]);
    } else {
      bucket.push(observation);
    }
  });

  const summaries: RecallGroupSummary[] = [];

  buckets.forEach((bucket) => {
    const head = bucket[0];
    const values = bucket.map((observation) => observation.recallAtK);
    const below = bucket.filter((observation) => observation.recallAtK < threshold);
    const meanValue = mean(values);

    summaries.push({
      backend: head.backend,
      language: head.language,
      distinctSkuK: head.distinctSkuK,
      topK: head.topK,
      queryCount: bucket.length,
      meanRecallAtK: meanValue,
      minRecallAtK: Math.min(...values),
      maxRecallAtK: Math.max(...values),
      threshold,
      belowThresholdCount: below.length,
      belowThresholdQueryIds: below.map((observation) => observation.queryId),
      passed: meanValue >= threshold,
      returnedRowCount: sum(bucket.map((observation) => observation.returnedRowCount)),
      exactTieRowCount: sum(bucket.map((observation) => observation.exactTie.exactTieRowCount)),
      exactTieGroupCount: sum(bucket.map((observation) => observation.exactTie.exactTieGroupCount)),
      nonFiniteDistanceCount: sum(
        bucket.map((observation) => observation.exactTie.nonFiniteDistanceCount)
      ),
    });
  });

  return summaries.sort(compareGroupSummary);
}

/**
 * バックエンド × Distinct_Sku_K の言語間差分を組み立てる（要件 13.8）。
 *
 * 差分は日本語平均 − 英語平均であり、{@link languageRecallDifference} と同一の算出を通る。
 * 「同一の Paired_Query_Set について」の差分であることを確認するため、
 * 日英で集計対象のクエリ識別子集合が一致しているかも併せて判定する。
 */
function buildLanguageDifferences(
  observations: readonly RecallObservation[]
): LanguageRecallDifference[] {
  const pairs = new Map<
    string,
    {
      backend: RecallBackend;
      distinctSkuK: number;
      ja: RecallObservation[];
      en: RecallObservation[];
    }
  >();

  observations.forEach((observation) => {
    const key = `${observation.backend}|${observation.distinctSkuK}`;
    const entry = pairs.get(key) ?? {
      backend: observation.backend,
      distinctSkuK: observation.distinctSkuK,
      ja: [],
      en: [],
    };
    if (observation.language === 'ja') {
      entry.ja.push(observation);
    } else {
      entry.en.push(observation);
    }
    pairs.set(key, entry);
  });

  const differences: LanguageRecallDifference[] = [];

  pairs.forEach((entry) => {
    const computed = languageRecallDifference(
      entry.ja.map((observation) => observation.recallAtK),
      entry.en.map((observation) => observation.recallAtK)
    );
    const jaQueryIds = new Set<string>(entry.ja.map((observation) => observation.queryId));
    const enQueryIds = new Set<string>(entry.en.map((observation) => observation.queryId));
    const unpairedQueryIds = symmetricDifference(jaQueryIds, enQueryIds);

    differences.push({
      backend: entry.backend,
      distinctSkuK: entry.distinctSkuK,
      jaMeanRecallAtK: computed.jaMean,
      enMeanRecallAtK: computed.enMean,
      difference: computed.difference,
      differenceRaw: computed.differenceRaw,
      jaQueryCount: entry.ja.length,
      enQueryCount: entry.en.length,
      queryIdMismatch: unpairedQueryIds.length > 0,
      sharedQueryCount: Array.from(jaQueryIds).filter((queryId) => enQueryIds.has(queryId)).length,
      unpairedQueryIds,
    });
  });

  return differences.sort((left, right) => {
    const byBackend = compareBackend(left.backend, right.backend);
    return byBackend !== 0 ? byBackend : left.distinctSkuK - right.distinctSkuK;
  });
}

/**
 * 風味クエリに対する Material_Sku の集計を組み立てる（要件 13.15）。
 * 対象は `intent === 'flavor'` の測定のみ。
 */
function buildFlavorMaterialSkuSummaries(
  observations: readonly RecallObservation[]
): FlavorMaterialSkuSummary[] {
  const buckets = new Map<string, RecallObservation[]>();

  observations
    .filter((observation) => observation.intent === NEGATIVE_CLASS_QUERY_INTENT)
    .forEach((observation) => {
      const key = groupKey(observation.backend, observation.language, observation.distinctSkuK);
      const bucket = buckets.get(key);
      if (bucket === undefined) {
        buckets.set(key, [observation]);
      } else {
        bucket.push(observation);
      }
    });

  const summaries: FlavorMaterialSkuSummary[] = [];

  buckets.forEach((bucket) => {
    const head = bucket[0];
    const materialSkuCount = sum(bucket.map((observation) => observation.materialSkuCount));

    summaries.push({
      backend: head.backend,
      language: head.language,
      distinctSkuK: head.distinctSkuK,
      intent: NEGATIVE_CLASS_QUERY_INTENT,
      flavorQueryCount: bucket.length,
      materialSkuCount,
      materialSkuFree: materialSkuCount === 0,
      occurrences: bucket
        .filter((observation) => observation.materialSkuCount > 0)
        .map((observation) => ({
          queryId: observation.queryId,
          itemIds: observation.materialSkuItemIds,
        })),
    });
  });

  return summaries.sort(compareGroupSummary);
}

function groupKey(
  backend: RecallBackend,
  language: VectorLanguage,
  distinctSkuK: number
): string {
  return `${backend}|${language}|${distinctSkuK}`;
}

/** バックエンド → 言語 → Distinct_Sku_K の順に並べる。出力順を入力順から切り離す */
function compareGroupSummary(
  left: { backend: RecallBackend; language: VectorLanguage; distinctSkuK: number },
  right: { backend: RecallBackend; language: VectorLanguage; distinctSkuK: number }
): number {
  const byBackend = compareBackend(left.backend, right.backend);
  if (byBackend !== 0) {
    return byBackend;
  }
  const byLanguage = VECTOR_LANGUAGES.indexOf(left.language) - VECTOR_LANGUAGES.indexOf(right.language);
  return byLanguage !== 0 ? byLanguage : left.distinctSkuK - right.distinctSkuK;
}

function compareBackend(left: RecallBackend, right: RecallBackend): number {
  return RECALL_BACKENDS.indexOf(left) - RECALL_BACKENDS.indexOf(right);
}

/** 空配列は 0 を返す。要素数で割った算術平均 */
function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < values.length; i += 1) {
    total += values[i];
  }
  return total;
}

function countDistinctValues(values: readonly string[]): number {
  return new Set<string>(values).size;
}

/** 倉庫フィルタ条件の一覧。null（フィルタ無効）を先頭に置き、以降は昇順 */
function uniqueWarehouseIds(
  observations: readonly RecallObservation[]
): readonly (string | null)[] {
  const hasNull = observations.some((observation) => observation.warehouseId === null);
  const named = Array.from(
    new Set<string>(
      observations
        .map((observation) => observation.warehouseId)
        .filter((warehouseId): warehouseId is string => warehouseId !== null)
    )
  ).sort();

  return hasNull ? [null, ...named] : named;
}

function uniqueSortedNumbers(values: readonly number[]): number[] {
  return Array.from(new Set<number>(values)).sort((left, right) => left - right);
}

/** 片方にのみ含まれる要素を昇順で返す。ロケール非依存のコードポイント順 */
function symmetricDifference(left: Set<string>, right: Set<string>): string[] {
  const only: string[] = [];
  left.forEach((value) => {
    if (!right.has(value)) {
      only.push(value);
    }
  });
  right.forEach((value) => {
    if (!left.has(value)) {
      only.push(value);
    }
  });
  return only.sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
}
