/**
 * ベクトル検索結果の重なり・順位差計算（純関数）
 *
 * DynamoDB `SearchVectors` と OpenSearch k-NN の 2 つの結果集合を受け取り、
 * `VectorOverlapSummary.tsx` が表示する指標を算出する。
 * ネットワーク・DOM・環境変数に触れず、同一入力に対して常に同一出力を返す。
 *
 * 設計上の約束:
 * - アイテム同一性は `(itemId, warehouseId)` の**複合キーの完全一致**で判定する。
 *   `itemId` だけの一致は同一アイテムとみなさない（要件 12.1）
 * - 表示用の丸め値と、判定に使う生値を**別のプロパティとして両方返す**。
 *   許容誤差判定（要件 12.7）は丸め前の値で行うため、丸めによって判定が変わらない
 * - 片側がエラーまたは 0 件のときは算出不可を返し、正常側の結果一覧を破棄しない（要件 12.8）
 * - すべての関数は全域関数である。重複キー・非有限値・空配列でも例外を投げない
 *
 * 要件: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8
 * 設計: 重なり指標計算（純関数）/ Property 33, 34, 35, 36
 */

import type {
  VectorBackend,
  VectorErrorCode,
  VectorSearchHit,
} from "./vector-types";

// ============================================================
// 定数
// ============================================================

/** Jaccard 係数・overlap@k 比率の表示桁数（小数第 3 位）（要件 12.3） */
export const OVERLAP_RATIO_DECIMALS = 3;

/** 正規化距離とスコア差の表示桁数（小数第 4 位）（要件 12.6） */
export const DISTANCE_DECIMALS = 4;

/**
 * 正規化距離の差を「許容誤差内で一致」とみなす上限（要件 12.7）。
 * 差の絶対値がこの値**以下**のときのみ一致とみなす（境界値 0.0010 は一致側）。
 */
export const DISTANCE_MATCH_TOLERANCE = 0.001;

/** 許容誤差内で一致するアイテムの識別ラベル（色・記号に依存しない表現）（要件 12.7） */
export const WITHIN_TOLERANCE_LABEL = "許容誤差内で一致";

/** 許容誤差を超えるアイテムの識別ラベル（要件 12.7） */
export const SCORE_DIFFERENCE_LABEL = "スコア差あり";

/** バックエンドの表示名。エラー理由の文面と一覧表示で共有する */
export const VECTOR_BACKEND_LABELS: Readonly<Record<VectorBackend, string>> = {
  dynamodb: "DynamoDB",
  opensearch: "OpenSearch",
};

/**
 * 倉庫三つ組の注記（要件 12.2）。
 * 表示行数と一意 SKU 件数の両方に併記する。
 */
export const WAREHOUSE_TRIPLET_NOTE =
  "同一 SKU の 3 倉庫行は同一ベクトルを持つため、検索結果は倉庫三つ組として現れる。" +
  "そのため表示行数は一意 SKU 件数の最大 3 倍になる。";

// ============================================================
// 入力
// ============================================================

/**
 * 片側バックエンドの検索結果。
 *
 * `outcome: "success"` かつ `hits` が空配列のときが「結果件数 0 件」であり、
 * エラー終了（`outcome: "error"`）とは区別して理由を返す（要件 12.8）。
 */
export type VectorOverlapSideInput =
  | {
      readonly outcome: "success";
      readonly hits: readonly VectorSearchHit[];
    }
  | {
      readonly outcome: "error";
      /** 判明している場合のエラーコード。理由表示の補足に使う */
      readonly errorCode?: VectorErrorCode;
    };

/** 両バックエンドの検索結果 */
export interface VectorOverlapInput {
  readonly dynamodb: VectorOverlapSideInput;
  readonly opensearch: VectorOverlapSideInput;
}

// ============================================================
// 出力
// ============================================================

/** 片側バックエンドの件数（要件 12.2） */
export interface VectorOverlapSideCounts {
  readonly backend: VectorBackend;
  /** 検索が正常終了したか（0 件でも正常終了なら true） */
  readonly succeeded: boolean;
  /** 表示される行数。倉庫三つ組を含む行数（要件 12.2） */
  readonly rowCount: number;
  /** `itemId` の一意件数（要件 12.2） */
  readonly distinctSkuCount: number;
  /**
   * `(itemId, warehouseId)` の一意件数。重なり指標の集合サイズとして使う。
   * 入力に重複キーがなければ `rowCount` と一致する
   */
  readonly uniqueKeyCount: number;
}

/** 重なりの度合い（要件 12.1 / 12.3 / 12.4） */
export interface VectorOverlapMetrics {
  /** 両結果集合に共通して含まれるアイテム数（要件 12.1） */
  readonly commonCount: number;
  /** 和集合サイズ */
  readonly unionCount: number;
  /** DynamoDB 側のみに含まれる件数（要件 12.4） */
  readonly dynamodbOnlyCount: number;
  /** OpenSearch 側のみに含まれる件数（要件 12.4） */
  readonly opensearchOnlyCount: number;
  /** Jaccard 係数の生値（共通アイテム数 ÷ 和集合サイズ） */
  readonly jaccard: number;
  /** Jaccard 係数の表示値（小数第 3 位）（要件 12.3） */
  readonly jaccardRounded: number;
  /** overlap@k 比率の生値（共通アイテム数 ÷ 両結果件数の最小値） */
  readonly overlapAtK: number;
  /** overlap@k 比率の表示値（小数第 3 位）（要件 12.3） */
  readonly overlapAtKRounded: number;
}

/** 一方の結果集合にのみ含まれるアイテム 1 件（要件 12.4） */
export interface VectorOverlapOnlyEntry {
  readonly itemId: string;
  readonly warehouseId: string;
  /** 当該アイテムを含むバックエンド */
  readonly backend: VectorBackend;
  /** バックエンド表示名。色・記号に依存しないテキスト表現 */
  readonly backendLabel: string;
  /** 当該バックエンドでの順位 */
  readonly rank: number;
  /** 当該バックエンドでの正規化距離（生値） */
  readonly distance: number;
  /** 正規化距離の表示値（小数第 4 位） */
  readonly distanceRounded: number;
  /** 当該バックエンドが距離基準の不一致を報告したか（要件 9.12） */
  readonly distanceBasisMismatch: boolean;
}

/** 両結果集合に共通して含まれるアイテム 1 件（要件 12.5 / 12.6 / 12.7） */
export interface VectorOverlapCommonEntry {
  readonly itemId: string;
  readonly warehouseId: string;
  /** DynamoDB 側の順位（要件 12.5） */
  readonly dynamodbRank: number;
  /** OpenSearch 側の順位（要件 12.5） */
  readonly opensearchRank: number;
  /** 両順位の差の絶対値（要件 12.5） */
  readonly rankDifference: number;
  /** DynamoDB 側の正規化距離（生値） */
  readonly dynamodbDistance: number;
  /** OpenSearch 側の正規化距離（生値） */
  readonly opensearchDistance: number;
  /** DynamoDB 側の正規化距離の表示値（小数第 4 位）（要件 12.6） */
  readonly dynamodbDistanceRounded: number;
  /** OpenSearch 側の正規化距離の表示値（小数第 4 位）（要件 12.6） */
  readonly opensearchDistanceRounded: number;
  /** 両スコアの差の絶対値（生値） */
  readonly distanceDifference: number;
  /** 両スコアの差の絶対値の表示値（小数第 4 位）（要件 12.6） */
  readonly distanceDifferenceRounded: number;
  /** 差の絶対値が `DISTANCE_MATCH_TOLERANCE` 以下か（要件 12.7） */
  readonly withinTolerance: boolean;
  /** 要件 12.7 の識別表示に使うラベル */
  readonly toleranceLabel: string;
  /** いずれかのバックエンドが距離基準の不一致を報告したか（要件 9.12） */
  readonly distanceBasisMismatch: boolean;
}

/** 算出不可の原因種別（要件 12.8） */
export type VectorOverlapBlockerCause = "ERROR" | "EMPTY";

/** 算出不可の原因 1 件（要件 12.8） */
export interface VectorOverlapBlocker {
  readonly backend: VectorBackend;
  readonly cause: VectorOverlapBlockerCause;
  /** `cause` が `ERROR` かつ判明している場合のエラーコード */
  readonly errorCode?: VectorErrorCode;
  /** 画面表示用の理由文 */
  readonly message: string;
}

/**
 * 正常終了した側の結果一覧。算出不可でも破棄しない（要件 12.8）。
 * エラー終了した側は空配列になる
 */
export interface VectorOverlapRetainedHits {
  readonly dynamodb: readonly VectorSearchHit[];
  readonly opensearch: readonly VectorSearchHit[];
}

/** 両検索が正常終了し、重なり指標を算出できた場合の結果 */
export interface VectorOverlapComputable {
  readonly computable: true;
  readonly dynamodb: VectorOverlapSideCounts;
  readonly opensearch: VectorOverlapSideCounts;
  readonly metrics: VectorOverlapMetrics;
  /** 共通アイテム。DynamoDB 側順位の昇順（要件 12.5 / 12.6） */
  readonly common: readonly VectorOverlapCommonEntry[];
  /** DynamoDB 側のみに含まれるアイテム。順位の昇順（要件 12.4） */
  readonly dynamodbOnly: readonly VectorOverlapOnlyEntry[];
  /** OpenSearch 側のみに含まれるアイテム。順位の昇順（要件 12.4） */
  readonly opensearchOnly: readonly VectorOverlapOnlyEntry[];
  readonly retained: VectorOverlapRetainedHits;
  /** 倉庫三つ組の注記（要件 12.2） */
  readonly warehouseTripletNote: string;
}

/** 片側がエラーまたは 0 件で、重なり指標を算出できなかった場合の結果（要件 12.8） */
export interface VectorOverlapUncomputable {
  readonly computable: false;
  readonly dynamodb: VectorOverlapSideCounts;
  readonly opensearch: VectorOverlapSideCounts;
  /** 算出不可の原因。バックエンドごとに 1 件ずつ、DynamoDB → OpenSearch の順 */
  readonly blockers: readonly VectorOverlapBlocker[];
  /** 算出不可の理由をまとめた表示文（要件 12.8） */
  readonly reason: string;
  readonly retained: VectorOverlapRetainedHits;
  /** 倉庫三つ組の注記（要件 12.2） */
  readonly warehouseTripletNote: string;
}

/** 重なり指標の算出結果。`computable` で判別する */
export type VectorOverlapResult =
  | VectorOverlapComputable
  | VectorOverlapUncomputable;

// ============================================================
// 小さな純関数（単体で検証できる単位に分ける）
// ============================================================

/**
 * `(itemId, warehouseId)` の複合キーを 1 本の文字列に符号化する（要件 12.1）。
 *
 * `itemId` の文字数を接頭辞に置くことで、区切り文字を含む値でも
 * 単射（異なる組は必ず異なるキーになる）を保つ。
 */
export function vectorItemKey(itemId: string, warehouseId: string): string {
  return `${itemId.length}:${itemId}|${warehouseId}`;
}

/** 検索結果 1 件から複合キーを作る */
export function vectorItemKeyOf(hit: VectorSearchHit): string {
  return vectorItemKey(hit.itemId, hit.warehouseId);
}

/**
 * 指定桁数に丸める。非有限値はそのまま返し、`-0` は `0` に正規化する。
 *
 * 二重の乗除算による誤差を避けるため `toFixed` の十進丸めを使う。
 */
export function roundToDecimals(value: number, decimals: number): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  const rounded = Number.parseFloat(value.toFixed(decimals));
  return rounded === 0 ? 0 : rounded;
}

/** Jaccard 係数・overlap@k 比率を表示桁数（小数第 3 位）に丸める（要件 12.3） */
export function roundRatio(value: number): number {
  return roundToDecimals(value, OVERLAP_RATIO_DECIMALS);
}

/** 正規化距離・スコア差を表示桁数（小数第 4 位）に丸める（要件 12.6） */
export function roundDistance(value: number): number {
  return roundToDecimals(value, DISTANCE_DECIMALS);
}

/** Jaccard 係数・overlap@k 比率を小数第 3 位までの文字列にする（要件 12.3） */
export function formatRatio(value: number): string {
  return Number.isFinite(value)
    ? value.toFixed(OVERLAP_RATIO_DECIMALS)
    : "算出不可";
}

/** 正規化距離・スコア差を小数第 4 位までの文字列にする（要件 12.6） */
export function formatDistance(value: number): string {
  return Number.isFinite(value) ? value.toFixed(DISTANCE_DECIMALS) : "算出不可";
}

/**
 * 2 つの正規化距離が許容誤差内で一致するかを判定する（要件 12.7）。
 *
 * 差の絶対値が `DISTANCE_MATCH_TOLERANCE`（0.0010）**以下**のときのみ true。
 * いずれかが非有限値の場合は判定できないため false を返す。
 */
export function isWithinDistanceTolerance(
  dynamodbDistance: number,
  opensearchDistance: number
): boolean {
  const difference = Math.abs(dynamodbDistance - opensearchDistance);
  return Number.isFinite(difference) && difference <= DISTANCE_MATCH_TOLERANCE;
}

/** 検索結果配列の `itemId` 一意件数を数える（要件 12.2） */
export function countDistinctSkus(hits: readonly VectorSearchHit[]): number {
  const seen = new Set<string>();
  hits.forEach((hit) => {
    seen.add(hit.itemId);
  });
  return seen.size;
}

/** 検索結果配列の `(itemId, warehouseId)` 一意件数を数える */
export function countUniqueItemKeys(hits: readonly VectorSearchHit[]): number {
  const seen = new Set<string>();
  hits.forEach((hit) => {
    seen.add(vectorItemKeyOf(hit));
  });
  return seen.size;
}

// ============================================================
// 内部処理
// ============================================================

/** 複合キーで索引付けした検索結果 1 件 */
interface IndexedHit {
  readonly key: string;
  readonly hit: VectorSearchHit;
  /** 1 始まりの順位。`hit.rank` が非有限値のときは配列位置で代替する */
  readonly rank: number;
}

/** 索引付けした片側の結果集合 */
interface IndexedSide {
  readonly byKey: Map<string, IndexedHit>;
  /** 入力順のキー一覧（重複除去済み） */
  readonly keys: readonly string[];
}

/**
 * 検索結果配列を複合キーで索引付けする。
 *
 * 同一キーが複数含まれる場合は順位が小さい（より上位の）行を採用する。
 * 順位も同値なら先に現れた行を採用し、結果を入力順に依存させない。
 */
function indexSide(hits: readonly VectorSearchHit[]): IndexedSide {
  const byKey = new Map<string, IndexedHit>();
  const keys: string[] = [];

  hits.forEach((hit, index) => {
    const key = vectorItemKeyOf(hit);
    const rank = Number.isFinite(hit.rank) ? hit.rank : index + 1;
    const existing = byKey.get(key);

    if (existing === undefined) {
      byKey.set(key, { key, hit, rank });
      keys.push(key);
      return;
    }
    if (rank < existing.rank) {
      byKey.set(key, { key, hit, rank });
    }
  });

  return { byKey, keys };
}

/** 順位昇順、同値はキー昇順で並べる比較関数（決定論的な並び） */
function compareByRankThenKey(
  a: { readonly rank: number; readonly key: string },
  b: { readonly rank: number; readonly key: string }
): number {
  if (a.rank !== b.rank) {
    return a.rank - b.rank;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** 片側の件数を数える（要件 12.2） */
function summarizeSide(
  backend: VectorBackend,
  side: VectorOverlapSideInput
): VectorOverlapSideCounts {
  if (side.outcome === "error") {
    return {
      backend,
      succeeded: false,
      rowCount: 0,
      distinctSkuCount: 0,
      uniqueKeyCount: 0,
    };
  }
  return {
    backend,
    succeeded: true,
    rowCount: side.hits.length,
    distinctSkuCount: countDistinctSkus(side.hits),
    uniqueKeyCount: countUniqueItemKeys(side.hits),
  };
}

/** 片側のみに含まれるアイテムの一覧を作る（要件 12.4） */
function buildOnlyEntries(
  backend: VectorBackend,
  ownSide: IndexedSide,
  otherSide: IndexedSide
): VectorOverlapOnlyEntry[] {
  const entries: (VectorOverlapOnlyEntry & { readonly key: string })[] = [];

  ownSide.keys.forEach((key) => {
    if (otherSide.byKey.has(key)) {
      return;
    }
    const indexed = ownSide.byKey.get(key);
    if (indexed === undefined) {
      return;
    }
    entries.push({
      key,
      itemId: indexed.hit.itemId,
      warehouseId: indexed.hit.warehouseId,
      backend,
      backendLabel: VECTOR_BACKEND_LABELS[backend],
      rank: indexed.rank,
      distance: indexed.hit.distance,
      distanceRounded: roundDistance(indexed.hit.distance),
      distanceBasisMismatch: indexed.hit.distanceBasisMismatch === true,
    });
  });

  return entries
    .sort(compareByRankThenKey)
    .map(({ key: _key, ...entry }) => entry);
}

/** 共通アイテムの一覧を作る（要件 12.5 / 12.6 / 12.7） */
function buildCommonEntries(
  dynamodbSide: IndexedSide,
  opensearchSide: IndexedSide
): VectorOverlapCommonEntry[] {
  const entries: (VectorOverlapCommonEntry & {
    readonly key: string;
    readonly rank: number;
  })[] = [];

  dynamodbSide.keys.forEach((key) => {
    const dynamodbHit = dynamodbSide.byKey.get(key);
    const opensearchHit = opensearchSide.byKey.get(key);
    if (dynamodbHit === undefined || opensearchHit === undefined) {
      return;
    }

    const dynamodbDistance = dynamodbHit.hit.distance;
    const opensearchDistance = opensearchHit.hit.distance;
    const distanceDifference = Math.abs(dynamodbDistance - opensearchDistance);
    const withinTolerance = isWithinDistanceTolerance(
      dynamodbDistance,
      opensearchDistance
    );

    entries.push({
      key,
      rank: dynamodbHit.rank,
      itemId: dynamodbHit.hit.itemId,
      warehouseId: dynamodbHit.hit.warehouseId,
      dynamodbRank: dynamodbHit.rank,
      opensearchRank: opensearchHit.rank,
      rankDifference: Math.abs(dynamodbHit.rank - opensearchHit.rank),
      dynamodbDistance,
      opensearchDistance,
      dynamodbDistanceRounded: roundDistance(dynamodbDistance),
      opensearchDistanceRounded: roundDistance(opensearchDistance),
      distanceDifference,
      distanceDifferenceRounded: roundDistance(distanceDifference),
      withinTolerance,
      toleranceLabel: withinTolerance
        ? WITHIN_TOLERANCE_LABEL
        : SCORE_DIFFERENCE_LABEL,
      distanceBasisMismatch:
        dynamodbHit.hit.distanceBasisMismatch === true ||
        opensearchHit.hit.distanceBasisMismatch === true,
    });
  });

  return entries
    .sort((a, b) => {
      if (a.dynamodbRank !== b.dynamodbRank) {
        return a.dynamodbRank - b.dynamodbRank;
      }
      if (a.opensearchRank !== b.opensearchRank) {
        return a.opensearchRank - b.opensearchRank;
      }
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    })
    .map(({ key: _key, rank: _rank, ...entry }) => entry);
}

/** 算出不可の原因を判定する（要件 12.8） */
function findBlocker(
  backend: VectorBackend,
  side: VectorOverlapSideInput
): VectorOverlapBlocker | null {
  const label = VECTOR_BACKEND_LABELS[backend];

  if (side.outcome === "error") {
    const codeSuffix =
      side.errorCode === undefined ? "" : `（${side.errorCode}）`;
    return {
      backend,
      cause: "ERROR",
      ...(side.errorCode === undefined ? {} : { errorCode: side.errorCode }),
      message: `${label} 側の検索がエラー終了${codeSuffix}`,
    };
  }
  if (side.hits.length === 0) {
    return {
      backend,
      cause: "EMPTY",
      message: `${label} 側の結果件数が 0 件`,
    };
  }
  return null;
}

/** 正常終了した側の結果一覧を保持する（要件 12.8） */
function retainHits(
  side: VectorOverlapSideInput
): readonly VectorSearchHit[] {
  return side.outcome === "success" ? side.hits : [];
}

// ============================================================
// 公開エントリポイント
// ============================================================

/**
 * 両バックエンドの検索結果から重なり指標を算出する。
 *
 * 両検索が正常終了し、かつ両方の結果件数が 1 件以上のときのみ
 * `computable: true` を返す。それ以外は算出不可（`computable: false`）として
 * 原因と理由文を返し、正常終了した側の結果一覧を `retained` に保持する（要件 12.8）。
 *
 * @param input 両バックエンドの検索結果（成功なら結果一覧、失敗ならエラーコード）
 */
export function computeVectorOverlap(
  input: VectorOverlapInput
): VectorOverlapResult {
  const dynamodbCounts = summarizeSide("dynamodb", input.dynamodb);
  const opensearchCounts = summarizeSide("opensearch", input.opensearch);
  const retained: VectorOverlapRetainedHits = {
    dynamodb: retainHits(input.dynamodb),
    opensearch: retainHits(input.opensearch),
  };

  const blockers = [
    findBlocker("dynamodb", input.dynamodb),
    findBlocker("opensearch", input.opensearch),
  ].filter((blocker): blocker is VectorOverlapBlocker => blocker !== null);

  if (blockers.length > 0) {
    return {
      computable: false,
      dynamodb: dynamodbCounts,
      opensearch: opensearchCounts,
      blockers,
      reason: `算出不可: ${blockers
        .map((blocker) => blocker.message)
        .join("、")}`,
      retained,
      warehouseTripletNote: WAREHOUSE_TRIPLET_NOTE,
    };
  }

  // blockers が空である時点で両側は outcome === "success" かつ 1 件以上
  const dynamodbSide = indexSide(retained.dynamodb);
  const opensearchSide = indexSide(retained.opensearch);

  const common = buildCommonEntries(dynamodbSide, opensearchSide);
  const dynamodbOnly = buildOnlyEntries(
    "dynamodb",
    dynamodbSide,
    opensearchSide
  );
  const opensearchOnly = buildOnlyEntries(
    "opensearch",
    opensearchSide,
    dynamodbSide
  );

  const commonCount = common.length;
  const dynamodbSetSize = dynamodbSide.byKey.size;
  const opensearchSetSize = opensearchSide.byKey.size;
  const unionCount = dynamodbSetSize + opensearchSetSize - commonCount;
  const minSetSize = Math.min(dynamodbSetSize, opensearchSetSize);

  // 集合サイズは 1 以上だが、全域性のため 0 除算を明示的に避ける
  const jaccard = unionCount > 0 ? commonCount / unionCount : 0;
  const overlapAtK = minSetSize > 0 ? commonCount / minSetSize : 0;

  return {
    computable: true,
    dynamodb: dynamodbCounts,
    opensearch: opensearchCounts,
    metrics: {
      commonCount,
      unionCount,
      dynamodbOnlyCount: dynamodbOnly.length,
      opensearchOnlyCount: opensearchOnly.length,
      jaccard,
      jaccardRounded: roundRatio(jaccard),
      overlapAtK,
      overlapAtKRounded: roundRatio(overlapAtK),
    },
    common,
    dynamodbOnly,
    opensearchOnly,
    retained,
    warehouseTripletNote: WAREHOUSE_TRIPLET_NOTE,
  };
}
