/**
 * フロントエンド用 ベクトル検索比較 API 型定義
 *
 * `/vector-search/*` の 4 エンドポイント（capabilities / embed / dynamodb / opensearch）が
 * 受け渡す JSON の形をフロントエンド側から見た型として定義する。
 *
 * バックエンド側の同一形状は `amplify/functions/shared/vector/` にあり、
 * フロントエンドは `amplify/` から import できないため、本ファイルは**意図的な二重定義**である。
 * 対応関係は以下のとおりで、構造的な互換性を保つ責務は本ファイル側にある。
 *
 * | 本ファイルの型 | バックエンドの出典 |
 * |---|---|
 * | `VectorBackend` / `VectorFilterKind` / `VectorBackendCapabilities` / `VectorEmbeddingNotice` / `VectorCapabilitiesResponse` | `shared/vector/constraints.ts` |
 * | `VectorErrorCode`（15 値）/ `VectorErrorStage`（3 値）/ `VectorErrorResponse` | `shared/vector/errors.ts` |
 * | `VectorLanguage` | `shared/vector/language.ts` |
 * | `VectorScoreNormalizationFormula` | `shared/vector/score-normalize.ts` |
 *
 * 設計上の約束:
 * - `VectorSearchHit` に**両言語のベクトル属性を持たせない**。ベクトル本体はブラウザへ渡らない
 *   経路しか存在しないことを型で表す（要件 8.8 / 9.1）。同様に `VectorEmbedResponse` も
 *   ハンドル（`queryId`）のみを持ち、ベクトル配列を持たない（要件 10.3）
 * - `VectorErrorResponse` は ARN、アカウント ID、認証情報、スタックトレースを載せる項目を持たない（要件 16.9）
 * - 機能制約（TopK 上限・対応フィルタ種別・次元数上限）は画面側に固定値を持たず、
 *   `VectorBackendCapabilities` として応答から受け取る（要件 15.6）
 *
 * 要件: 8.8, 9.1, 10.3, 11.15, 12.5, 12.6, 15.6, 16.9
 * 設計: API Contract
 */

// ============================================================
// 共通識別子
// ============================================================

/** ベクトル検索のバックエンド識別子 */
export type VectorBackend = "dynamodb" | "opensearch";

/** 検索言語。ja / en の 2 値のみ（それ以外は INVALID_LANGUAGE） */
export type VectorLanguage = "ja" | "en";

/** フィルタ演算子の種別。等価条件と範囲条件のみを区別する */
export type VectorFilterKind = "equality" | "range";

/**
 * OpenSearch の knn スコアからコサイン距離を逆算する式の識別子。
 * `two_minus_d_over_two` は `d = 2 − 2 × score`、`reciprocal_minus_one` は `d = 1 / score − 1`。
 */
export type VectorScoreNormalizationFormula =
  | "two_minus_d_over_two"
  | "reciprocal_minus_one";

// ============================================================
// エラー（要件 16）
// ============================================================

/** 機械可読エラーコード。この 15 種以外は応答に現れない */
export type VectorErrorCode =
  | "DIMENSION_MISMATCH" // 再試行不可
  | "INDEX_NOT_FOUND" // 再試行不可
  | "INDEX_BUILDING" // 再試行可
  | "RANGE_FILTER_UNSUPPORTED" // 再試行不可
  | "INVALID_TOPK" // 再試行不可
  | "INVALID_QUERY" // 再試行不可
  | "INVALID_LANGUAGE" // 再試行不可
  | "QUERY_TOO_LONG" // 再試行不可
  | "QUERY_EXPIRED" // 再試行可（埋め込み生成から再実行）
  | "OPENSEARCH_TIMEOUT" // 再試行可
  | "ACCESS_DENIED_IAM" // 再試行不可
  | "ACCESS_DENIED_DATA_POLICY" // 再試行不可
  | "RESOURCE_NOT_FOUND" // 再試行不可
  | "THROTTLED" // 再試行可
  | "INTERNAL_ERROR"; // 再試行不可

/** 失敗した処理段階（要件 16.5）。3 値のみ */
export type VectorErrorStage =
  | "EMBEDDING"
  | "SEARCH_DYNAMODB"
  | "SEARCH_OPENSEARCH";

/**
 * エラー応答。ARN、アカウント ID、認証情報、スタックトレースを含めない（要件 16.9）。
 * バックエンドは本インターフェースのプロパティ以外を応答へ載せないため、
 * 画面側もこれ以外の項目を参照しない。
 */
export interface VectorErrorResponse {
  stage: VectorErrorStage;
  errorCode: VectorErrorCode;
  /** 500 文字以内の説明文 */
  message: string;
  retryable: boolean;
  /** retryable が true のときのみ設定される推奨待機秒数 */
  retryAfterSeconds?: number;
}

// ============================================================
// 検索結果 1 件
// ============================================================

/**
 * 検索結果 1 件。**両言語のベクトル本体を含めない**（要件 8.8 / 9.1）。
 *
 * `embeddingJa` / `embeddingEn` に相当する項目を持たないことで、
 * ベクトルがブラウザへ届く経路を型レベルで作らない。
 * 表示用の意味的メタデータは検索言語に対応する 1 言語分のみを受け取る。
 */
export interface VectorSearchHit {
  itemId: string;
  warehouseId: string;
  /** 表示名。検索言語に対応する productName */
  productName: string;
  category: string;
  origin: string;
  roastLevel: string;
  flavorNotes: string;
  quantity: number;
  location: string;
  unitPrice: number;
  /** 1 始まりの順位（距離昇順）。行単位の順位（要件 12.5） */
  rank: number;
  /** 正規化コサイン距離。0〜2、小さいほど類似（要件 12.6） */
  distance: number;
  /** バックエンドが返した生スコア。DynamoDB は距離そのもの、OpenSearch は knn score */
  rawScore: number;
  /** 正規化距離が 0〜2 を外れた場合 true（要件 9.12） */
  distanceBasisMismatch?: boolean;
}

// ============================================================
// GET /vector-search/capabilities
// ============================================================

/**
 * バックエンド 1 つ分の機能制約（要件 15.1〜15.4）。
 *
 * 比較表はここに含まれる値のみを描画し、TopK 上限・対応フィルタ種別・次元数上限を
 * 画面側に固定値として持たない（要件 15.6）。
 */
export interface VectorBackendCapabilities {
  readonly backend: VectorBackend;
  /** TopK の上限。DynamoDB は 100、OpenSearch は同等の上限がないため null */
  readonly maxTopK: number | null;
  /** 実装が対応するフィルタ演算子の種別 */
  readonly supportedFilterKinds: readonly VectorFilterKind[];
  /** 距離関数をインデックス再作成なしに変更できるか */
  readonly distanceFunctionMutable: boolean;
  /** 距離関数の識別子。`COSINE`（DynamoDB）/ `cosinesimil`（OpenSearch） */
  readonly distanceFunction: string;
  /** ベクトル次元数の上限。DynamoDB 4096 / OpenSearch 16000 */
  readonly maxDimensions: number;
  /** オンデマンド課金が前提条件か */
  readonly requiresOnDemandBilling: boolean;
  /** 通常のデータ読み取り API（Query / Scan / PartiQL）でベクトルを読めるか */
  readonly readableByQueryScanPartiQL: boolean;
  /** 全文検索との併用に対応するか */
  readonly supportsFullTextCombination: boolean;
  /** 集約に対応するか */
  readonly supportsAggregation: boolean;
  /** 地理空間クエリに対応するか */
  readonly supportsGeoQuery: boolean;
  /** ネストクエリに対応するか */
  readonly supportsNestedQuery: boolean;
  /**
   * 対応フィルタ種別が公式ドキュメント間で未解決である旨（要件 15.2）。
   * 未解決の項目がないバックエンドでは省略される。
   */
  readonly filterKindsUnverified?: string;
}

/** 埋め込みモデルと言語別測定に関する注意書き（要件 15.5）。常時表示する */
export interface VectorEmbeddingNotice {
  /** 埋め込みモデル ID。`amazon.titan-embed-text-v2:0` */
  readonly model: string;
  /** 正式サポート言語 */
  readonly officiallySupportedLanguages: string;
  /** プレビュー扱いの言語に関する記述 */
  readonly previewLanguagesNote: string;
  /** 日英 2 本のベクトルを独立生成して言語別に recall を測定している旨 */
  readonly bilingualMeasurementNote: string;
  /** 両バックエンドが同一ベクトルを使うため比較の公平性が保たれる旨 */
  readonly fairnessNote: string;
  /** 測定結果を記録した Verification_Report のパス */
  readonly reportPath: string;
}

/** `GET /vector-search/capabilities` の応答（要件 15.1 / 15.5 / 15.6） */
export interface VectorCapabilitiesResponse {
  readonly dynamodb: VectorBackendCapabilities;
  readonly opensearch: VectorBackendCapabilities;
  readonly embeddingNotice: VectorEmbeddingNotice;
}

// ============================================================
// POST /vector-search/embed
// ============================================================

/**
 * クエリ埋め込みに使用した推論経路（要件 10.1 / 10.13）。
 * `amplify/functions/shared/vector/embedding-generator.ts` の `InferencePath` と同一の値域。
 */
export type VectorInferencePath = "latency_optimized" | "standard";

/** `POST /vector-search/embed` のリクエスト */
export interface VectorEmbedRequest {
  /** 前処理前の生のクエリ文字列。空文字・空白のみは INVALID_QUERY */
  query: string;
  /** 検索言語。ja / en 以外は INVALID_LANGUAGE */
  language: VectorLanguage;
}

/**
 * `POST /vector-search/embed` の応答。
 * **ベクトル本体を含めない**。両バックエンドは `queryId` を通じて同一のベクトルを参照する（要件 10.3）。
 */
export interface VectorEmbedResponse {
  /** 検索エンドポイントに渡すハンドル。TTL 300 秒。ベクトルと言語を内包する */
  queryId: string;
  /** 埋め込み生成のサーバー側レイテンシ（ms、整数）（要件 10.5 / 11.16） */
  embeddingLatencyMs: number;
  dimensions: number;
  model: string;
  language: VectorLanguage;
  /**
   * 実際に使用した推論経路（要件 10.1 / 10.13）。
   * `latency_optimized` はレイテンシ最適化推論で成功したこと、`standard` は当該モデル・
   * 当該リージョンが未対応のため標準推論へフォールバックしたことを意味する。
   * us-west-2 の `amazon.titan-embed-text-v2:0` では常に `standard` になる（A21）。
   */
  inferencePath: VectorInferencePath;
  /** キャッシュ有効時のみ意味を持つ。既定は常に false（要件 10.10 / 10.11） */
  cacheHit: boolean;
}

// ============================================================
// POST /vector-search/dynamodb, POST /vector-search/opensearch
// ============================================================

/** 範囲フィルタ実測プローブ専用の指定。既定の検索では使用しない */
export interface VectorRangeFilter {
  field: string;
  min?: number;
  max?: number;
}

/** 両検索エンドポイント共通のリクエスト。言語はハンドルに内包されるため含めない */
export interface VectorSearchRequest {
  /** ベクトルと言語を内包するハンドル */
  queryId: string;
  /** 1〜100 の整数。101 以上は 100 に丸められる */
  topK: number;
  /** 未指定なら全倉庫（フィルタなし） */
  warehouseId?: string;
  /** 範囲フィルタ実測プローブ専用。既定では使用しない */
  rangeFilter?: VectorRangeFilter;
}

/**
 * DynamoDB `SearchVectors` が返した消費量（要件 8.11）。
 *
 * `amplify/functions/vector-search-ddb/handler.ts` の `VectorConsumedCapacityBody` と同一形である。
 * 通常の読み取り API の `CapacityUnits` / `ReadCapacityUnits` は**存在しない**。
 * したがって単位はキャパシティユニットではなく**バイト**であり、項目名もそれに合わせる。
 * 要件 14.7 が測定対象とする CloudWatch メトリクスは `VectorSearchRequestBytes` である。
 *
 * **実 API の応答で観測した形（task 13.13 / Q5、2026-08-21、us-west-2）:**
 * `{ "VectorSearchRequestBytes": 61318, "VectorSearchUnits": 61318 }`。
 * `VectorSearchUnits` は SDK の `VectorCapacity` モデルには無いが実 API が返すため、
 * 要件 8.11 に従ってバックエンドが `vectorSearchUnits` として載せる。
 *
 * 3 項目とも省略可能である。バックエンドはいずれも読み取れなかった場合に 0 を捏造せず
 * `consumedCapacity: null` を返すため、本型の値が存在する場合は少なくとも 1 つが入っている。
 */
export interface VectorConsumedCapacity {
  /** ベクトル検索で消費した要求バイト数 */
  vectorSearchRequestBytes?: number;
  /** ベクトルインデックスへの書き込みで消費した要求バイト数。検索応答では通常現れない */
  vectorWriteRequestBytes?: number;
  /** 実 API が返す `VectorSearchUnits`。SDK のモデルには無い（task 13.13 で観測） */
  vectorSearchUnits?: number;
}

/** Vector_Index の準備状況（要件 16.2 の判定に使う） */
export interface VectorIndexReadiness {
  indexStatus: string;
  /** `Backfilling` フィールドが不在の場合は false（要件 5.15 / 5.17、設計 V20） */
  backfilling: boolean;
  /**
   * `Backfilling` フィールドが `DescribeTable` の応答に存在したか（要件 5.17、設計 V20）。
   *
   * task 13.12 の実測ではキー自体が返らず**常に false** である。したがって
   * `backfilling === false` を「バックフィルが完了した」証拠として読んではならない。
   * バックフィル完了までの経過時間（要件 5.14）は測定不能である。
   */
  backfillingPresent: boolean;
  describeTableCached: boolean;
}

/** `POST /vector-search/dynamodb` の応答 */
export interface DynamoDBVectorSearchResponse {
  backend: "dynamodb";
  hits: VectorSearchHit[];
  /** 使用した検索言語。queryId から解決した値のエコー（要件 11.15） */
  language: VectorLanguage;
  requestedTopK: number;
  appliedTopK: number;
  returnedCount: number;
  /** 返却行の itemId 一意件数（要件 12.2） */
  distinctSkuCount: number;
  /** SearchVectors 呼び出し区間（要件 8.12） */
  searchLatencyMs: number;
  /** ハンドラ全体区間（要件 8.12） */
  handlerLatencyMs: number;
  coldStart: boolean;
  /** 言語に対応して選択されたインデックス名 */
  indexName: string;
  distanceFunction: "COSINE";
  /** 値が小さいほど類似であることを示すラベル（要件 8.9） */
  distanceSemantics: "lower_is_closer";
  filterApplied: string[];
  consumedCapacity: VectorConsumedCapacity | null;
  indexReadiness: VectorIndexReadiness;
  constraints: VectorBackendCapabilities;
}

/** フィルタ 0 件かつ非フィルタ 1 件以上のときの診断（要件 9.10） */
export interface VectorFilterDiagnostics {
  filterField: string;
  message: string;
}

/** `POST /vector-search/opensearch` の応答 */
export interface OpenSearchVectorSearchResponse {
  backend: "opensearch";
  hits: VectorSearchHit[];
  /** 使用した検索言語。DynamoDB 側と同一の値（要件 11.15） */
  language: VectorLanguage;
  requestedTopK: number;
  appliedTopK: number;
  returnedCount: number;
  /** 返却行の itemId 一意件数（要件 12.2） */
  distinctSkuCount: number;
  /** `_search` レスポンスの took（ms、単位変換しない）（要件 9.7） */
  took: number;
  /** 送信開始〜受信完了のサーバー側レイテンシ（要件 9.8） */
  searchLatencyMs: number;
  handlerLatencyMs: number;
  coldStart: boolean;
  indexName: string;
  /** 言語に対応して選択された knn_vector フィールド名 */
  vectorField: string;
  spaceType: "cosinesimil";
  distanceSemantics: "lower_is_closer";
  /** 適用した正規化式（要件 9.5 / 9.6） */
  scoreNormalization: VectorScoreNormalizationFormula;
  filterApplied: string[];
  /** 登録ドキュメント数 0 のとき `NO_DOCUMENTS`（要件 16.4） */
  status?: "NO_DOCUMENTS";
  documentCount?: number;
  /** フィルタ 0 件かつ非フィルタ 1 件以上のときの診断（要件 9.10） */
  filterDiagnostics?: VectorFilterDiagnostics;
  /** フィルタ後件数が k 未満のときの注記（要件 9.11） */
  insufficientNeighborsNote?: string;
  constraints: VectorBackendCapabilities;
}

/** 両バックエンドの検索応答の合併。バックエンド判別は `backend` で行う */
export type VectorSearchResponse =
  | DynamoDBVectorSearchResponse
  | OpenSearchVectorSearchResponse;
