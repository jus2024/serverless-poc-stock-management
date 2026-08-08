/**
 * フロントエンド用 在庫管理 API 型定義
 */

/**
 * DynamoDB テーブルの選択
 * - bad:          PK=warehouseId（ホットパーティション発生設計、プロビジョンド）
 * - good:         PK=itemId（分散設計、GSI なし、プロビジョンド）
 * - goodGsi:      PK=itemId（分散設計、GSI 3本あり、プロビジョンド）
 * - badOnDemand:  PK=warehouseId（bad と同一キー設計、オンデマンド課金）
 */
export type Table = "bad" | "good" | "goodGsi" | "badOnDemand";

/** 倉庫拠点 */
export type Warehouse = "WH-TOKYO" | "WH-OSAKA" | "WH-FUKUOKA";

/** 在庫レコード */
export interface InventoryRecord {
  warehouseId: string;
  itemId: string;
  itemName: string;
  quantity: number;
  lotNumber: string;
  location: string;
  unitPrice: number;
  lastUpdated: string; // ISO 8601
}

/** 出庫レスポンス */
export interface ShipResponse {
  success: true;
  updatedQuantity: number;
  lastUpdated: string; // ISO 8601
  latencyMs?: number;
  retryMode?: string;
}

/** 在庫一覧レスポンス */
export interface ListInventoryResponse {
  items: InventoryRecord[];
  nextToken: string | null;
}

/** 負荷テスト開始パラメータ */
export interface LoadTestParams {
  table: Table;
  durationSeconds: number;
  requestsPerSecond: number;
  warehouseDistribution: Record<Warehouse, number>;
}

/** 負荷テスト実行ステータス */
export interface ExecutionStatus {
  executionId: string;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  totalRequests: number;
  successCount: number;
  throttleCount: number;
  elapsedSeconds: number;
}

/** オンライン影響テストパラメータ */
export interface OnlineImpactTestParams {
  table: Table;
  requestsPerSecond: number;
  durationSeconds: number;
  /** ラウンド数（1〜12、省略時 1）。1 回の起動で連続測定する回数 */
  iterations?: number;
  warehouseId?: Warehouse;
  noRetry?: boolean;
}

/** オンライン影響テスト — 個別リクエスト結果 */
export interface OnlineImpactRequestResult {
  /** ラウンド番号（0 始まり） */
  round: number;
  index: number;
  /** ラウンド内の秒（0 始まり） */
  second: number;
  latencyMs: number;
  status: "success" | "throttled" | "error";
  error?: string;
}

/** オンライン影響テスト — ラウンドごとの集計 */
export interface OnlineImpactRoundSummary {
  /** ラウンド番号（0 始まり） */
  round: number;
  /** ラウンド開始時刻（ISO 8601） */
  startedAt: string;
  totalRequests: number;
  successCount: number;
  throttleCount: number;
  errorCount: number;
  /** スロットル率（パーセント、小数第 1 位まで。例 54.8） */
  throttleRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
}

/** オンライン影響テスト — サマリー（全ラウンド合算） */
export interface OnlineImpactSummary {
  table: string;
  warehouseId: string;
  requestsPerSecond: number;
  /** 1 ラウンドあたりの秒数 */
  durationSeconds: number;
  /** 実行したラウンド数 */
  iterations: number;
  totalRequests: number;
  successCount: number;
  throttleCount: number;
  errorCount: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  successAvgLatencyMs: number;
  throttledAvgLatencyMs: number;
  retryMode?: string;
}

/** オンライン影響テスト — レスポンス */
export interface OnlineImpactTestResponse {
  summary: OnlineImpactSummary;
  /** ラウンドごとの集計（実行順） */
  rounds: OnlineImpactRoundSummary[];
  requests: OnlineImpactRequestResult[];
}

/** エラーレスポンス */
export interface ErrorResponse {
  error: string;
  message: string;
  details?: unknown;
}

/** 検索比較共通パラメータ */
export interface ComparisonSearchParams {
  warehouseId?: string;
  itemPrefix?: string;
  locationPrefix?: string;
  itemName?: string;
  minPrice?: number;
  maxPrice?: number;
  minQuantity?: number;
  maxQuantity?: number;
  from?: number;
  size?: number;
}

/** OpenSearch 検索レスポンス */
export interface OpenSearchSearchResponse {
  items: InventoryRecord[];
  total: number;
  took: number;         // OpenSearch took (ms)
  latencyMs: number;    // サーバー側トータルレイテンシ (ms)
  from: number;
  size: number;
}

/** DynamoDB 検索比較レスポンス */
export interface DynamoDBComparisonResponse {
  items: InventoryRecord[];
  nextToken: string | null;
  latencyMs: number;           // サーバー側レイテンシ
  usedIndex: string;           // 使用した GSI 名
  filterApplied: string[];     // FilterExpression で適用した条件
  limitation?: string;         // DynamoDB の制約メッセージ
}
