/**
 * Ground_Truth 構築（言語別）
 *
 * recall@k を測定するには、まず「正解」が必要である。本モジュールは Vector_Table の
 * 15,000 レコードを `itemId` 単位で重複排除して 5,000 件の一意ベクトル集合を作り、
 * 各クエリベクトルとの float32 コサイン距離を全件厳密計算して
 * Distinct_Sku_K = 1 / 10 / 33 の Ground_Truth を決める。
 *
 * 設計上の要点:
 *
 * - **言語の混用を構造的に防ぐ。** 一意ベクトル集合とそのキャッシュは言語ごとに完全に独立した
 *   経路で扱う。キャッシュのファイル名は言語と次元数の両方を含み
 *   （`ground-truth-ja-d1024.json` / `ground-truth-en-d1024.json`）、読み出したペイロード側にも
 *   `language` / `dimensions` を持たせて要求値との一致を検証する。ファイル名だけの区別では
 *   取り違えが実行時に発覚しないため、二重に固定する（要件 13.2）
 * - **倉庫フィルタ有効時は別集合として扱う。** ファイル名に `-wh-<warehouseId>` を付け、
 *   フィルタ無効時のキャッシュと同じファイルに書かない（要件 13.14）
 * - **純計算と I/O を分離する。** Vector_Table の Scan とキャッシュの読み書きは
 *   {@link VectorRecordSource} / {@link UniqueVectorSetCache} の 2 つのインターフェース越しに行う。
 *   距離計算・重複排除・順位付けはすべて純関数であり、AWS 認証情報もファイルシステムも要らない
 * - **同値は決定論的に確定する。** 距離差が 1e-6 以下の同値は `itemId` 昇順で順位を確定し、
 *   同値により順位が一意に定まらなかった件数を出力する（要件 13.12）
 *
 * float32 精度の扱い。ベクトルの各要素を `Math.fround` で float32 に丸めたうえで、
 * 内積とノルムの**加算は double で行い**、最後に距離を float32 に丸める。
 * 1,024 項の加算を float32 で累積すると相対誤差が 1e-5 程度まで膨らみ、
 * 同値判定の閾値 1e-6 より大きくなって閾値が意味を失うため、この配分にしている。
 * 結果の粒度（float32 の刻み ≈ 1.2e-7）は閾値 1e-6 より細かいので、閾値は有効に働く。
 *
 * 要件: 13.1, 13.2, 13.9, 13.12, 13.14
 * 設計: Recall_Evaluator / Ground_Truth の構築（言語別）
 */

import {
  validateDimensions,
  EFFECTIVE_MAX_VECTOR_DIMENSIONS,
  MIN_VECTOR_DIMENSIONS,
} from '../../amplify/functions/shared/vector/constraints';
import {
  resolveVectorField,
  type VectorLanguage,
} from '../../amplify/functions/shared/vector/language';
import {
  distinctSkuKToTopK,
  MAX_DISTINCT_SKU_K,
  WAREHOUSE_ROWS_PER_SKU,
} from '../../amplify/functions/shared/vector/topk';

export type { VectorLanguage };

// ============================================================
// 定数
// ============================================================

/** 同値と判定する距離差の閾値。これ以下の差は同値として itemId 昇順で確定する（要件 13.12） */
export const GROUND_TRUTH_TIE_EPSILON = 1e-6;

/** 測定する Distinct_Sku_K。上限 33 は TopK 上限 100 ÷ 倉庫行数 3 の商（要件 13.3） */
export const DISTINCT_SKU_K_VALUES = [1, 10, 33] as const satisfies readonly number[];

/** 重複排除の単位。出力に含める（要件 13.9） */
export const DEDUPE_UNIT = 'itemId' as const;

/** PoC 規模で期待する一意ベクトル件数。検証の警告判定にのみ使う（要件 13.1） */
export const EXPECTED_UNIQUE_VECTOR_COUNT = 5000;

/** PoC 規模で期待する Vector_Table のレコード件数（5,000 SKU × 3 倉庫） */
export const EXPECTED_SOURCE_RECORD_COUNT =
  EXPECTED_UNIQUE_VECTOR_COUNT * WAREHOUSE_ROWS_PER_SKU;

/** キャッシュの既定の格納先。実行時の CWD からの相対パス */
export const GROUND_TRUTH_CACHE_DIR = 'docs/measurements/ground-truth';

/** キャッシュのスキーマ版。形が変わったら上げてキャッシュを無効化する */
export const UNIQUE_VECTOR_CACHE_SCHEMA_VERSION = 1;

/** Vector_Table の既定のテーブル名 */
export const DEFAULT_VECTOR_TABLE_NAME = 'kiro-roasters-inventory-vector';

// ============================================================
// エラー
// ============================================================

/**
 * Ground_Truth の構築を続行できない状態。
 *
 * 言語や次元数の取り違え、同一 itemId の行間でのベクトル不一致など、
 * 気付かずに測定を続けると数値が意味を失う条件では例外にする。
 */
export class GroundTruthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GroundTruthError';
  }
}

// ============================================================
// 型
// ============================================================

/** Vector_Table の 1 レコードのうち、Ground_Truth 計算に使う部分（当該言語のベクトルのみ） */
export interface VectorRecordRow {
  itemId: string;
  warehouseId: string;
  /** 当該言語の埋め込みベクトル。他方の言語のベクトルはここに入らない */
  embedding: readonly number[];
}

/** Vector_Table の Scan 結果。件数の内訳を出力に載せるため付随情報を持つ（要件 13.9） */
export interface VectorRecordScanResult {
  rows: readonly VectorRecordRow[];
  /** Scan が走査したレコード件数 */
  scannedRecordCount: number;
  /** 当該言語のベクトルを持たなかったレコード件数 */
  missingEmbeddingCount: number;
}

/** 重複排除後の一意 SKU ベクトル 1 件 */
export interface UniqueSkuVector {
  itemId: string;
  /** float32 に丸めた埋め込みベクトル */
  embedding: readonly number[];
  /** 当該 itemId が現れた倉庫行の warehouseId（昇順、重複なし） */
  warehouseIds: readonly string[];
}

/**
 * 一意ベクトル集合。**1 つの言語・1 つの次元数・1 つのフィルタ条件**にのみ対応する。
 * 自分がどの条件のものかを保持するため、他条件の Ground_Truth 計算に誤って渡しても検出できる。
 */
export interface UniqueVectorSet {
  language: VectorLanguage;
  dimensions: number;
  /** 倉庫フィルタ。無効時は null（要件 13.14） */
  warehouseId: string | null;
  dedupeUnit: typeof DEDUPE_UNIT;
  /** itemId 昇順。順序を固定して再実行時の同一性を担保する */
  vectors: readonly UniqueSkuVector[];
  /** 重複排除前のレコード件数（フィルタ適用後） */
  sourceRecordCount: number;
  uniqueVectorCount: number;
  /**
   * 同一 itemId の行間でベクトルが一致しなかった itemId（昇順）。
   * 前提「同一 SKU の 3 倉庫行は同一ベクトルを持つ」が破れていることを示す。
   */
  inconsistentItemIds: readonly string[];
}

/** 順位付け済みの 1 件 */
export interface RankedSkuVector {
  itemId: string;
  /** float32 コサイン距離（0 以上 2 以下、値が小さいほど類似） */
  distance: number;
  /** 1 始まりの順位 */
  rank: number;
}

/**
 * 1 クエリ分の全件順位付け。
 * Distinct_Sku_K = 1 / 10 / 33 の 3 つの Ground_Truth を、この 1 回の計算から導く。
 */
export interface RankedVectorSet {
  language: VectorLanguage;
  dimensions: number;
  warehouseId: string | null;
  dedupeUnit: typeof DEDUPE_UNIT;
  uniqueVectorCount: number;
  /** 距離昇順、同距離は itemId 昇順 */
  entries: readonly RankedSkuVector[];
}

/** 同値の報告（要件 13.12） */
export interface GroundTruthTieReport {
  /** 同値と判定した距離差の閾値 */
  epsilon: number;
  /** k 番目と k+1 番目の距離差が epsilon 以下か */
  boundaryTie: boolean;
  /** k 番目の距離と epsilon 以内で連鎖的に同値な件数。1 なら同値なし */
  boundaryEquivalentCount: number;
  /** 同値連鎖に属する itemId（順位順） */
  boundaryEquivalentItemIds: readonly string[];
  /**
   * 同値により順位が一意に定まらなかった件数。
   * 同値連鎖が k の境界をまたぐ（= 上位 k 件の選定が距離だけでは確定しない）場合に
   * 連鎖の件数を報告し、またがない場合は 0 とする。
   */
  ambiguousRankCount: number;
  /** 同値連鎖のうち k 番目と距離が完全一致した件数 */
  exactTieCount: number;
}

/** 1 クエリ・1 つの Distinct_Sku_K に対する Ground_Truth */
export interface GroundTruth {
  language: VectorLanguage;
  dimensions: number;
  warehouseId: string | null;
  dedupeUnit: typeof DEDUPE_UNIT;
  /** Ground_Truth 対象の一意ベクトル件数（要件 13.9） */
  uniqueVectorCount: number;
  distinctSkuK: number;
  /** 両バックエンドへ要求すべき TopK（= 3 × Distinct_Sku_K、要件 13.3） */
  topK: number;
  /** 正解の itemId 集合（順位順、最大 distinctSkuK 件） */
  itemIds: readonly string[];
  /** 正解の各件の距離と順位 */
  entries: readonly RankedSkuVector[];
  ties: GroundTruthTieReport;
}

// ============================================================
// 距離計算（純関数）
// ============================================================

/**
 * float32 精度のコサイン距離を返す（0 以上 2 以下、値が小さいほど類似）。
 *
 * 各要素を float32 に丸め、内積とノルムを double で累積し、最後に距離を float32 に丸める。
 * `1 - cos` の形なので値域は 0〜2 であり、DynamoDB の `COSINE` および
 * OpenSearch の `cosinesimil` と同一の基準になる。
 *
 * ゼロベクトルの扱い。コサインは定義されないため、両方がゼロなら 0（同一とみなす）、
 * 片方だけがゼロなら 1（直交相当）を返す。これにより `cosineDistance(a, a) === 0` と
 * 対称性 `cosineDistance(a, b) === cosineDistance(b, a)` がゼロベクトルを含めて成り立つ。
 *
 * @throws {GroundTruthError} 次元数が一致しない場合、または非有限値を含む場合
 */
export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new GroundTruthError(
      `コサイン距離は同一次元のベクトル間でのみ計算できます（左辺 ${a.length} 次元 / 右辺 ${b.length} 次元）。`
    );
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    const x = Math.fround(a[i]);
    const y = Math.fround(b[i]);
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (!Number.isFinite(dot) || !Number.isFinite(normA) || !Number.isFinite(normB)) {
    throw new GroundTruthError(
      'コサイン距離を計算できません。ベクトルに非有限値（NaN / Infinity）が含まれているか、' +
        '要素の大きさが float64 の範囲を超えています。'
    );
  }

  if (normA === 0 && normB === 0) {
    return 0;
  }
  if (normA === 0 || normB === 0) {
    return 1;
  }

  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // 丸め誤差で ±1 をわずかに超えることがあるため、値域 0〜2 を保つために切り詰める
  const clamped = similarity > 1 ? 1 : similarity < -1 ? -1 : similarity;
  return Math.fround(1 - clamped);
}

// ============================================================
// 重複排除（純関数）
// ============================================================

/** 一意ベクトル集合を組み立てる際の条件。集合に埋め込まれ、以後の混用検出に使われる */
export interface UniqueVectorSetContext {
  language: VectorLanguage;
  dimensions: number;
  /** 倉庫フィルタ。無効時は null */
  warehouseId?: string | null;
}

/**
 * 倉庫フィルタを適用してレコードを絞り込む（要件 13.14）。
 * `warehouseId` が null / undefined のときは入力をそのまま返す。
 */
export function filterRowsByWarehouse(
  rows: readonly VectorRecordRow[],
  warehouseId: string | null | undefined
): readonly VectorRecordRow[] {
  if (warehouseId === null || warehouseId === undefined) {
    return rows;
  }
  return rows.filter((row) => row.warehouseId === warehouseId);
}

/**
 * レコードを `itemId` 単位で重複排除して一意ベクトル集合を作る（要件 13.1）。
 *
 * 同一 itemId の 3 倉庫行は同一ベクトルを持つ前提のため 1 件として数える。
 * 初出行のベクトルを採用し、後続行のベクトルが一致しない場合は
 * `inconsistentItemIds` に記録する（測定値が信用できなくなる兆候として出力に載せる）。
 *
 * 結果は `itemId` 昇順で並ぶ。同値の順位付けを `itemId` 昇順で確定する（要件 13.12）ための
 * 前提であり、再実行時の同一性もこれで担保される。
 *
 * @throws {GroundTruthError} 次元数が不正な場合、またはベクトル長が `dimensions` と異なる場合
 */
export function buildUniqueVectorSet(
  rows: readonly VectorRecordRow[],
  context: UniqueVectorSetContext
): UniqueVectorSet {
  const dimensions = assertDimensions(context.dimensions);
  const warehouseId = context.warehouseId ?? null;
  const filtered = filterRowsByWarehouse(rows, warehouseId);

  const byItemId = new Map<string, { embedding: number[]; warehouseIds: Set<string> }>();
  const inconsistent = new Set<string>();

  for (let i = 0; i < filtered.length; i += 1) {
    const row = filtered[i];

    if (typeof row.itemId !== 'string' || row.itemId === '') {
      throw new GroundTruthError(`itemId が空のレコードがあります（index=${i}）。`);
    }
    if (row.embedding.length !== dimensions) {
      throw new GroundTruthError(
        `ベクトル次元数が想定と異なります（itemId=${row.itemId}, warehouseId=${row.warehouseId}, ` +
          `実際 ${row.embedding.length} 次元 / 想定 ${dimensions} 次元）。` +
          '次元数の異なるベクトルを 1 つの Ground_Truth に混ぜることはできません。'
      );
    }

    const existing = byItemId.get(row.itemId);
    if (existing === undefined) {
      byItemId.set(row.itemId, {
        embedding: toFloat32Array(row.embedding, row.itemId),
        warehouseIds: new Set<string>([row.warehouseId]),
      });
      continue;
    }

    existing.warehouseIds.add(row.warehouseId);
    if (!isSameVector(existing.embedding, row.embedding)) {
      inconsistent.add(row.itemId);
    }
  }

  const itemIds = Array.from(byItemId.keys()).sort(compareItemId);
  const vectors: UniqueSkuVector[] = itemIds.map((itemId) => {
    // itemIds は byItemId のキーから作っているので undefined にはならない
    const entry = byItemId.get(itemId) as { embedding: number[]; warehouseIds: Set<string> };
    return {
      itemId,
      embedding: entry.embedding,
      warehouseIds: Array.from(entry.warehouseIds).sort(compareItemId),
    };
  });

  return {
    language: context.language,
    dimensions,
    warehouseId,
    dedupeUnit: DEDUPE_UNIT,
    vectors,
    sourceRecordCount: filtered.length,
    uniqueVectorCount: vectors.length,
    inconsistentItemIds: Array.from(inconsistent).sort(compareItemId),
  };
}

/**
 * フィルタ無効時の一意ベクトル集合から、特定倉庫に限定した集合を導出する（要件 13.14）。
 *
 * 同一 itemId の 3 倉庫行は同一ベクトルなので、`warehouseIds` に対象倉庫を含む要素だけを
 * 残せば「当該倉庫のレコードに限定した一意ベクトル集合」と一致する。Vector_Table の
 * 再 Scan を避けるための経路であり、結果は独立した集合として返るため
 * フィルタ無効時の集合と混用されない。
 *
 * @throws {GroundTruthError} 入力がすでに倉庫フィルタ済みの集合である場合
 */
export function restrictUniqueVectorSetToWarehouse(
  set: UniqueVectorSet,
  warehouseId: string
): UniqueVectorSet {
  if (set.warehouseId !== null) {
    throw new GroundTruthError(
      `倉庫フィルタ済みの集合（warehouseId=${set.warehouseId}）をさらに ` +
        `warehouseId=${warehouseId} で絞り込むことはできません。フィルタ無効時の集合を渡してください。`
    );
  }

  const vectors = set.vectors.filter((vector) => vector.warehouseIds.indexOf(warehouseId) >= 0);

  return {
    language: set.language,
    dimensions: set.dimensions,
    warehouseId,
    dedupeUnit: DEDUPE_UNIT,
    vectors: vectors.map((vector) => ({
      itemId: vector.itemId,
      embedding: vector.embedding,
      warehouseIds: [warehouseId],
    })),
    sourceRecordCount: vectors.length,
    uniqueVectorCount: vectors.length,
    inconsistentItemIds: set.inconsistentItemIds.filter(
      (itemId) => vectors.some((vector) => vector.itemId === itemId)
    ),
  };
}

// ============================================================
// 順位付けと Ground_Truth（純関数）
// ============================================================

/**
 * クエリベクトルと一意ベクトル集合の全件距離を計算し、決定論的に順位付けする。
 *
 * 並び順は距離昇順、距離が等しい場合は `itemId` 昇順。距離と itemId による全順序なので、
 * 同一入力に対して常に同一の並びを返す（要件 13.10 / 13.12）。
 *
 * 距離差が 1e-6 以下の「同値」は比較関数では扱わない。閾値による比較は推移律を満たさず
 * 並び替えの結果が実装依存になるためである。同値は
 * {@link buildGroundTruth} が境界の同値連鎖として別途集計する。
 *
 * @throws {GroundTruthError} クエリベクトルの次元数が集合と一致しない場合
 */
export function rankUniqueVectors(
  queryVector: readonly number[],
  set: UniqueVectorSet
): RankedVectorSet {
  if (queryVector.length !== set.dimensions) {
    throw new GroundTruthError(
      `クエリベクトルの次元数（${queryVector.length}）が一意ベクトル集合の次元数（${set.dimensions}）と一致しません。` +
        `language=${set.language} の集合に対しては ${set.dimensions} 次元のクエリベクトルのみ使用できます。`
    );
  }

  const scored = set.vectors.map((vector) => ({
    itemId: vector.itemId,
    distance: cosineDistance(queryVector, vector.embedding),
  }));

  scored.sort((left, right) => {
    if (left.distance !== right.distance) {
      return left.distance < right.distance ? -1 : 1;
    }
    return compareItemId(left.itemId, right.itemId);
  });

  return {
    language: set.language,
    dimensions: set.dimensions,
    warehouseId: set.warehouseId,
    dedupeUnit: DEDUPE_UNIT,
    uniqueVectorCount: set.uniqueVectorCount,
    entries: scored.map((entry, index) => ({
      itemId: entry.itemId,
      distance: entry.distance,
      rank: index + 1,
    })),
  };
}

/**
 * 順位付け結果から 1 つの Distinct_Sku_K の Ground_Truth を切り出す（要件 13.1 / 13.12）。
 *
 * 一意ベクトル件数が Distinct_Sku_K 未満の場合は取得できる件数だけを返す（例外にしない）。
 *
 * @throws {GroundTruthError} Distinct_Sku_K が 1〜33 の整数でない場合
 */
export function buildGroundTruth(ranking: RankedVectorSet, distinctSkuK: number): GroundTruth {
  const derived = distinctSkuKToTopK(distinctSkuK);
  if (!derived.ok) {
    throw new GroundTruthError(derived.message);
  }

  const entries = ranking.entries.slice(0, derived.distinctSkuK);

  return {
    language: ranking.language,
    dimensions: ranking.dimensions,
    warehouseId: ranking.warehouseId,
    dedupeUnit: DEDUPE_UNIT,
    uniqueVectorCount: ranking.uniqueVectorCount,
    distinctSkuK: derived.distinctSkuK,
    topK: derived.topK,
    itemIds: entries.map((entry) => entry.itemId),
    entries,
    ties: buildTieReport(ranking.entries, derived.distinctSkuK),
  };
}

/**
 * 1 クエリについて Distinct_Sku_K = 1 / 10 / 33 の Ground_Truth をまとめて作る。
 * 距離計算は 1 回だけ行い、3 つの k で共有する。
 */
export function buildGroundTruths(
  queryVector: readonly number[],
  set: UniqueVectorSet,
  distinctSkuKs: readonly number[] = DISTINCT_SKU_K_VALUES
): readonly GroundTruth[] {
  const ranking = rankUniqueVectors(queryVector, set);
  return distinctSkuKs.map((k) => buildGroundTruth(ranking, k));
}

/**
 * 境界の同値を集計する（要件 13.12）。
 *
 * k 番目を含む「隣接する距離差が epsilon 以下」の連鎖を求め、その件数を報告する。
 * 連鎖が k の境界をまたぐ場合、上位 k 件の選定は距離だけでは確定せず
 * `itemId` 昇順で確定したことになるため、連鎖の件数を
 * `ambiguousRankCount` として出力する。
 */
function buildTieReport(
  entries: readonly RankedSkuVector[],
  distinctSkuK: number
): GroundTruthTieReport {
  if (entries.length === 0) {
    return {
      epsilon: GROUND_TRUTH_TIE_EPSILON,
      boundaryTie: false,
      boundaryEquivalentCount: 0,
      boundaryEquivalentItemIds: [],
      ambiguousRankCount: 0,
      exactTieCount: 0,
    };
  }

  // 一意ベクトル件数が k 未満なら、最後の要素を境界とみなす
  const boundaryIndex = Math.min(distinctSkuK, entries.length) - 1;
  const boundaryDistance = entries[boundaryIndex].distance;

  let start = boundaryIndex;
  while (
    start > 0 &&
    Math.abs(entries[start].distance - entries[start - 1].distance) <= GROUND_TRUTH_TIE_EPSILON
  ) {
    start -= 1;
  }

  let end = boundaryIndex;
  while (
    end + 1 < entries.length &&
    Math.abs(entries[end + 1].distance - entries[end].distance) <= GROUND_TRUTH_TIE_EPSILON
  ) {
    end += 1;
  }

  const chain = entries.slice(start, end + 1);
  // 連鎖が境界より後ろの要素を含む = 上位 k 件の選定が距離だけでは確定しない
  const straddlesBoundary = end > boundaryIndex;
  const boundaryTie =
    boundaryIndex + 1 < entries.length &&
    Math.abs(entries[boundaryIndex + 1].distance - boundaryDistance) <= GROUND_TRUTH_TIE_EPSILON;

  return {
    epsilon: GROUND_TRUTH_TIE_EPSILON,
    boundaryTie,
    boundaryEquivalentCount: chain.length,
    boundaryEquivalentItemIds: chain.map((entry) => entry.itemId),
    ambiguousRankCount: straddlesBoundary ? chain.length : 0,
    exactTieCount: chain.filter((entry) => entry.distance === boundaryDistance).length,
  };
}

// ============================================================
// キャッシュ（言語別ファイル）
// ============================================================

/**
 * 一意ベクトル集合のキャッシュファイル名を返す。
 *
 * 言語と次元数の**両方**を名前に含めることで、`ja` / `en` の取り違えと
 * 次元数の異なる測定回（1024 / 512 / 256）の混用を、ファイル名の段階で防ぐ（要件 13.2）。
 * 倉庫フィルタ有効時は `-wh-<warehouseId>` を付け、フィルタ無効時のファイルへ書き込まない（要件 13.14）。
 *
 * 例: `ground-truth-ja-d1024.json` / `ground-truth-en-d1024.json` /
 * `ground-truth-ja-d1024-wh-WH-001.json`
 */
export function uniqueVectorCacheFileName(
  language: VectorLanguage,
  dimensions: number,
  warehouseId: string | null = null
): string {
  const dims = assertDimensions(dimensions);
  const suffix =
    warehouseId === null || warehouseId === '' ? '' : `-wh-${sanitizeForFileName(warehouseId)}`;
  return `ground-truth-${language}-d${dims}${suffix}.json`;
}

/** キャッシュへ書き出す JSON の形。自分が何の集合かを保持し、読み出し時に要求値と照合する */
export interface UniqueVectorCachePayload {
  schemaVersion: number;
  language: VectorLanguage;
  dimensions: number;
  warehouseId: string | null;
  dedupeUnit: typeof DEDUPE_UNIT;
  /** 生成時刻（ISO 8601）。追跡用のメタデータであり、Ground_Truth の値には影響しない */
  generatedAt: string;
  sourceRecordCount: number;
  uniqueVectorCount: number;
  inconsistentItemIds: readonly string[];
  vectors: readonly UniqueSkuVector[];
}

/**
 * キャッシュの読み書き。ファイルシステムを直接触らせないための境界。
 * 単体テストではメモリ実装を渡せる。
 */
export interface UniqueVectorSetCache {
  /** 見つからない場合は null を返す */
  read(fileName: string): Promise<string | null>;
  write(fileName: string, contents: string): Promise<void>;
}

/** 一意ベクトル集合をキャッシュ用の JSON 文字列へ直列化する */
export function serializeUniqueVectorSet(set: UniqueVectorSet, generatedAt: string): string {
  const payload: UniqueVectorCachePayload = {
    schemaVersion: UNIQUE_VECTOR_CACHE_SCHEMA_VERSION,
    language: set.language,
    dimensions: set.dimensions,
    warehouseId: set.warehouseId,
    dedupeUnit: DEDUPE_UNIT,
    generatedAt,
    sourceRecordCount: set.sourceRecordCount,
    uniqueVectorCount: set.uniqueVectorCount,
    inconsistentItemIds: set.inconsistentItemIds,
    vectors: set.vectors,
  };
  return JSON.stringify(payload);
}

/**
 * キャッシュの JSON 文字列を一意ベクトル集合へ復元する。
 *
 * 期待する言語・次元数・倉庫フィルタと**一致しない場合は例外**にする。
 * ファイル名の取り違えやファイルの手編集で他方の言語の集合を読み込んでしまう経路を、
 * ここで遮断する（要件 13.2 / 13.14）。
 *
 * @throws {GroundTruthError} スキーマ版・言語・次元数・フィルタ条件が期待と異なる場合
 */
export function deserializeUniqueVectorSet(
  contents: string,
  expected: UniqueVectorSetContext
): UniqueVectorSet {
  const expectedDimensions = assertDimensions(expected.dimensions);
  const expectedWarehouseId = expected.warehouseId ?? null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new GroundTruthError(
      `一意ベクトル集合のキャッシュを JSON として解釈できません: ${describeError(error)}`
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new GroundTruthError('一意ベクトル集合のキャッシュがオブジェクトではありません。');
  }

  const payload = parsed as Partial<UniqueVectorCachePayload>;

  if (payload.schemaVersion !== UNIQUE_VECTOR_CACHE_SCHEMA_VERSION) {
    throw new GroundTruthError(
      `キャッシュのスキーマ版が一致しません（キャッシュ ${String(payload.schemaVersion)} / ` +
        `期待 ${UNIQUE_VECTOR_CACHE_SCHEMA_VERSION}）。キャッシュを削除して再取得してください。`
    );
  }
  if (payload.language !== expected.language) {
    throw new GroundTruthError(
      `キャッシュの言語が一致しません（キャッシュ ${String(payload.language)} / 期待 ${expected.language}）。` +
        '言語をまたいだ Ground_Truth の混用は許容しません。'
    );
  }
  if (payload.dimensions !== expectedDimensions) {
    throw new GroundTruthError(
      `キャッシュの次元数が一致しません（キャッシュ ${String(payload.dimensions)} / 期待 ${expectedDimensions}）。`
    );
  }
  if ((payload.warehouseId ?? null) !== expectedWarehouseId) {
    throw new GroundTruthError(
      `キャッシュの倉庫フィルタが一致しません（キャッシュ ${String(payload.warehouseId ?? null)} / ` +
        `期待 ${String(expectedWarehouseId)}）。フィルタ有効時と無効時の Ground_Truth は混用しません。`
    );
  }
  if (payload.dedupeUnit !== DEDUPE_UNIT) {
    throw new GroundTruthError(
      `キャッシュの重複排除単位が一致しません（キャッシュ ${String(payload.dedupeUnit)} / 期待 ${DEDUPE_UNIT}）。`
    );
  }
  if (!Array.isArray(payload.vectors)) {
    throw new GroundTruthError('キャッシュに vectors 配列がありません。');
  }

  const vectors: UniqueSkuVector[] = payload.vectors.map((vector, index) => {
    if (
      typeof vector !== 'object' ||
      vector === null ||
      typeof vector.itemId !== 'string' ||
      !Array.isArray(vector.embedding)
    ) {
      throw new GroundTruthError(`キャッシュの vectors[${index}] の形が不正です。`);
    }
    if (vector.embedding.length !== expectedDimensions) {
      throw new GroundTruthError(
        `キャッシュの vectors[${index}]（itemId=${vector.itemId}）の次元数が ` +
          `${vector.embedding.length} で、期待値 ${expectedDimensions} と一致しません。`
      );
    }
    return {
      itemId: vector.itemId,
      embedding: toFloat32Array(vector.embedding, vector.itemId),
      warehouseIds: Array.isArray(vector.warehouseIds) ? vector.warehouseIds.slice() : [],
    };
  });

  vectors.sort((left, right) => compareItemId(left.itemId, right.itemId));

  return {
    language: expected.language,
    dimensions: expectedDimensions,
    warehouseId: expectedWarehouseId,
    dedupeUnit: DEDUPE_UNIT,
    vectors,
    sourceRecordCount:
      typeof payload.sourceRecordCount === 'number' ? payload.sourceRecordCount : vectors.length,
    uniqueVectorCount: vectors.length,
    inconsistentItemIds: Array.isArray(payload.inconsistentItemIds)
      ? payload.inconsistentItemIds.slice()
      : [],
  };
}

/**
 * ファイルシステム上のキャッシュ実装。
 * `node:fs/promises` は遅延 import するため、本モジュールを型計算のためだけに読み込む
 * 単体テストがファイルシステムに触れることはない。
 */
export function createFileSystemCache(baseDir: string = GROUND_TRUTH_CACHE_DIR): UniqueVectorSetCache {
  return {
    async read(fileName: string): Promise<string | null> {
      const [fs, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
      try {
        return await fs.readFile(path.join(baseDir, fileName), 'utf8');
      } catch (error) {
        if (isNotFoundError(error)) {
          return null;
        }
        throw error;
      }
    },
    async write(fileName: string, contents: string): Promise<void> {
      const [fs, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
      await fs.mkdir(baseDir, { recursive: true });
      await fs.writeFile(path.join(baseDir, fileName), contents, 'utf8');
    },
  };
}

/** キャッシュを使わない実装。強制再取得や一時的な検証に使う */
export function createNoopCache(): UniqueVectorSetCache {
  return {
    read: async () => null,
    write: async () => undefined,
  };
}

// ============================================================
// Vector_Table の読み出し（I/O 境界）
// ============================================================

/**
 * Vector_Table から当該言語のベクトルを読み出す経路。
 *
 * AWS へ触るのはこのインターフェースの実装のみ。純計算側
 * （{@link buildUniqueVectorSet} / {@link rankUniqueVectors} など）はこれに依存しないため、
 * 単体テストは AWS 認証情報なしで実行できる。
 */
export interface VectorRecordSource {
  scanVectorRecords(request: {
    language: VectorLanguage;
    dimensions: number;
  }): Promise<VectorRecordScanResult>;
}

/** DynamoDB 実装の設定 */
export interface DynamoDbVectorRecordSourceOptions {
  tableName?: string;
  region?: string;
  /** 1 回の Scan 呼び出しで読む件数。ベクトル 2 本で 1 件約 15.6 KB のため既定は控えめ */
  pageSize?: number;
  /** 進捗の通知先。既定では何もしない */
  onProgress?: (scannedRecordCount: number) => void;
}

/**
 * Vector_Table を 1 回 Scan して当該言語のベクトルを読み出す実装（要件 13.1）。
 *
 * ベクトルインデックスは `SearchVectors` 専用で `Scan` から読めないが、
 * ベクトル**属性**そのものは通常の `Scan` で読める。射影は
 * `itemId` / `warehouseId` / 当該言語のベクトル属性に限定し、他方の言語のベクトルを
 * 取得しない。読み取り量を半減させるだけでなく、他方の言語のベクトルが
 * 手元に来ない構造にすることで取り違えの余地をなくす（要件 13.2）。
 *
 * SDK は遅延 import する。純計算だけを使う呼び出し側に AWS SDK の読み込みを強いない。
 */
export function createDynamoDbVectorRecordSource(
  options: DynamoDbVectorRecordSourceOptions = {}
): VectorRecordSource {
  const tableName = options.tableName ?? DEFAULT_VECTOR_TABLE_NAME;
  const pageSize = options.pageSize ?? 200;

  return {
    async scanVectorRecords(request): Promise<VectorRecordScanResult> {
      const dimensions = assertDimensions(request.dimensions);
      const vectorField = resolveVectorField(request.language);

      const [{ DynamoDBClient, ScanCommand }, { unmarshall }] = await Promise.all([
        import('@aws-sdk/client-dynamodb'),
        import('@aws-sdk/util-dynamodb'),
      ]);

      const client = new DynamoDBClient(
        options.region === undefined ? {} : { region: options.region }
      );

      const rows: VectorRecordRow[] = [];
      let scannedRecordCount = 0;
      let missingEmbeddingCount = 0;
      let exclusiveStartKey: Record<string, unknown> | undefined;

      try {
        do {
          const response = await client.send(
            new ScanCommand({
              TableName: tableName,
              Limit: pageSize,
              ProjectionExpression: '#itemId, #warehouseId, #embedding',
              ExpressionAttributeNames: {
                '#itemId': 'itemId',
                '#warehouseId': 'warehouseId',
                '#embedding': vectorField,
              },
              ExclusiveStartKey: exclusiveStartKey as never,
            })
          );

          const items = response.Items ?? [];
          for (let i = 0; i < items.length; i += 1) {
            scannedRecordCount += 1;
            const item = unmarshall(items[i]) as {
              itemId?: unknown;
              warehouseId?: unknown;
              [key: string]: unknown;
            };
            const embedding = item[vectorField];

            if (typeof item.itemId !== 'string' || typeof item.warehouseId !== 'string') {
              throw new GroundTruthError(
                `${tableName} のレコードに itemId / warehouseId が揃っていません。`
              );
            }
            if (!Array.isArray(embedding)) {
              missingEmbeddingCount += 1;
              continue;
            }

            rows.push({
              itemId: item.itemId,
              warehouseId: item.warehouseId,
              embedding: embedding.map((value) => Number(value)),
            });
          }

          options.onProgress?.(scannedRecordCount);
          exclusiveStartKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
        } while (exclusiveStartKey !== undefined);
      } finally {
        client.destroy();
      }

      if (rows.length > 0 && rows[0].embedding.length !== dimensions) {
        throw new GroundTruthError(
          `${tableName} の ${vectorField} は ${rows[0].embedding.length} 次元で、` +
            `指定した ${dimensions} 次元と一致しません。次元数の指定を確認してください。`
        );
      }

      return { rows, scannedRecordCount, missingEmbeddingCount };
    },
  };
}

// ============================================================
// 読み込みの入口
// ============================================================

export interface LoadUniqueVectorSetOptions {
  language: VectorLanguage;
  dimensions: number;
  /** 倉庫フィルタ。有効時は当該倉庫のレコードのみから集合を作る（要件 13.14） */
  warehouseId?: string | null;
  source: VectorRecordSource;
  /** キャッシュ。省略時は {@link GROUND_TRUTH_CACHE_DIR} 配下のファイルを使う */
  cache?: UniqueVectorSetCache;
  /** true ならキャッシュを読まずに Scan し、結果でキャッシュを上書きする */
  forceRefresh?: boolean;
  /** 生成時刻。キャッシュのメタデータに載せる。既定は現在時刻 */
  generatedAt?: string;
}

export interface LoadUniqueVectorSetResult {
  set: UniqueVectorSet;
  /** 使用したキャッシュファイル名。言語・次元数・倉庫フィルタを含む */
  cacheFileName: string;
  fromCache: boolean;
  /** Scan した場合のみ件数の内訳を持つ。キャッシュヒット時は null */
  scan: VectorRecordScanResult | null;
  /** 一意ベクトル件数が想定（5,000）と異なる場合の警告文。想定どおりなら null */
  countWarning: string | null;
}

/**
 * 一意ベクトル集合を取得する（キャッシュ優先、要件 13.1 / 13.2 / 13.14）。
 *
 * Ground_Truth の計算には 15,000 件の Scan（約 28,500 RRU）が必要で、
 * 言語別 × 次元数別に繰り返すためローカル JSON にキャッシュして再実行時の読み出しを避ける。
 * キャッシュは言語・次元数・倉庫フィルタごとに別ファイルであり、読み出し時に
 * ペイロード側の条件も照合するため、条件をまたいだ混用は起こらない。
 */
export async function loadUniqueVectorSet(
  options: LoadUniqueVectorSetOptions
): Promise<LoadUniqueVectorSetResult> {
  const dimensions = assertDimensions(options.dimensions);
  const warehouseId = options.warehouseId ?? null;
  const cache = options.cache ?? createFileSystemCache();
  const cacheFileName = uniqueVectorCacheFileName(options.language, dimensions, warehouseId);
  const context: UniqueVectorSetContext = { language: options.language, dimensions, warehouseId };

  if (options.forceRefresh !== true) {
    const cached = await cache.read(cacheFileName);
    if (cached !== null) {
      const set = deserializeUniqueVectorSet(cached, context);
      return {
        set,
        cacheFileName,
        fromCache: true,
        scan: null,
        countWarning: describeCountWarning(set),
      };
    }
  }

  const scan = await options.source.scanVectorRecords({ language: options.language, dimensions });
  const set = buildUniqueVectorSet(scan.rows, context);

  await cache.write(
    cacheFileName,
    serializeUniqueVectorSet(set, options.generatedAt ?? new Date().toISOString())
  );

  return {
    set,
    cacheFileName,
    fromCache: false,
    scan,
    countWarning: describeCountWarning(set),
  };
}

/**
 * Ground_Truth の出力に載せるメタデータ（要件 13.9）。
 * 「どの言語・どの次元数・どのフィルタ条件で測ったか」を測定結果と同じ JSON に残す。
 */
export interface GroundTruthMetadata {
  language: VectorLanguage;
  dimensions: number;
  warehouseId: string | null;
  filterDescription: string;
  dedupeUnit: typeof DEDUPE_UNIT;
  uniqueVectorCount: number;
  sourceRecordCount: number;
  rowsPerSku: number;
  distinctSkuKValues: readonly number[];
  topKValues: readonly number[];
  maxDistinctSkuK: number;
  tieEpsilon: number;
  cacheFileName: string;
  inconsistentItemIds: readonly string[];
}

/** 一意ベクトル集合から出力用メタデータを組み立てる（要件 13.9） */
export function describeGroundTruthMetadata(
  set: UniqueVectorSet,
  distinctSkuKs: readonly number[] = DISTINCT_SKU_K_VALUES
): GroundTruthMetadata {
  return {
    language: set.language,
    dimensions: set.dimensions,
    warehouseId: set.warehouseId,
    filterDescription:
      set.warehouseId === null
        ? 'フィルタなし（全倉庫）'
        : `warehouseId = ${set.warehouseId} の等価フィルタ`,
    dedupeUnit: DEDUPE_UNIT,
    uniqueVectorCount: set.uniqueVectorCount,
    sourceRecordCount: set.sourceRecordCount,
    rowsPerSku: WAREHOUSE_ROWS_PER_SKU,
    distinctSkuKValues: distinctSkuKs.slice(),
    topKValues: distinctSkuKs.map((k) => WAREHOUSE_ROWS_PER_SKU * k),
    maxDistinctSkuK: MAX_DISTINCT_SKU_K,
    tieEpsilon: GROUND_TRUTH_TIE_EPSILON,
    cacheFileName: uniqueVectorCacheFileName(set.language, set.dimensions, set.warehouseId),
    inconsistentItemIds: set.inconsistentItemIds,
  };
}

// ============================================================
// 内部実装
// ============================================================

/** 次元数を検証して返す。不正なら例外にする */
function assertDimensions(value: number): number {
  const result = validateDimensions(value);
  if (!result.ok) {
    throw new GroundTruthError(
      `次元数の指定が不正です: ${result.received}。` +
        `${MIN_VECTOR_DIMENSIONS} 以上 ${EFFECTIVE_MAX_VECTOR_DIMENSIONS} 以下の整数を指定してください。`
    );
  }
  return result.dimensions;
}

/** ベクトルを float32 に丸めた配列へ変換する。非有限値は受け付けない */
function toFloat32Array(embedding: readonly number[], itemId: string): number[] {
  const rounded = new Array<number>(embedding.length);
  for (let i = 0; i < embedding.length; i += 1) {
    const value = embedding[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new GroundTruthError(
        `itemId=${itemId} のベクトルの第 ${i} 要素が有限の数値ではありません（${String(value)}）。`
      );
    }
    rounded[i] = Math.fround(value);
  }
  return rounded;
}

/** float32 に丸めた値として一致するか判定する */
function isSameVector(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== Math.fround(right[i])) {
      return false;
    }
  }
  return true;
}

/**
 * itemId の比較。ロケールに依存しないコードポイント順で比較する。
 * `localeCompare` は実行環境のロケールで結果が変わり、再実行時の同一性を壊す。
 */
function compareItemId(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** ファイル名に使えない文字を落とす。倉庫 ID をそのまま名前に埋め込むため */
function sanitizeForFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** 一意ベクトル件数が想定と異なる場合の警告文を返す */
function describeCountWarning(set: UniqueVectorSet): string | null {
  const messages: string[] = [];

  if (set.warehouseId === null && set.uniqueVectorCount !== EXPECTED_UNIQUE_VECTOR_COUNT) {
    messages.push(
      `一意ベクトル件数が ${set.uniqueVectorCount} 件で、想定の ${EXPECTED_UNIQUE_VECTOR_COUNT} 件と異なります` +
        `（重複排除前 ${set.sourceRecordCount} 件、想定 ${EXPECTED_SOURCE_RECORD_COUNT} 件）。`
    );
  }
  if (set.inconsistentItemIds.length > 0) {
    messages.push(
      `同一 itemId の倉庫行間でベクトルが一致しない SKU が ${set.inconsistentItemIds.length} 件あります` +
        `（例: ${set.inconsistentItemIds.slice(0, 3).join(', ')}）。` +
        '同一 SKU の 3 倉庫行は同一ベクトルを持つ前提が崩れています。'
    );
  }

  return messages.length === 0 ? null : messages.join(' ');
}

/** ファイルが存在しないエラーか判定する */
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/** 例外を短い文字列へ変換する */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
