/**
 * Lambda 関数間で共有する型定義
 */

/**
 * DynamoDB テーブルの選択
 * - bad:          PK=warehouseId（ホットパーティション発生設計、プロビジョンド）
 * - good:         PK=itemId（分散設計、GSI なし、プロビジョンド）
 * - goodGsi:      PK=itemId（分散設計、GSI 3本あり、プロビジョンド）
 * - badOnDemand:  PK=warehouseId（bad と同一キー設計、オンデマンド課金）
 */
export type Table = 'bad' | 'good' | 'goodGsi' | 'badOnDemand';

/** 倉庫拠点 */
export type Warehouse = 'WH-TOKYO' | 'WH-OSAKA' | 'WH-FUKUOKA';

/** 在庫レコード */
export interface InventoryRecord {
  warehouseId: Warehouse;
  itemId: string;
  itemName: string;
  quantity: number;
  lotNumber: string;
  location: string;
  unitPrice: number;
  lastUpdated: string; // ISO 8601
}

/** 出庫リクエスト */
export interface ShipRequest {
  warehouseId: Warehouse;
  itemId: string;
  quantity: number;
  table: Table;
}

/** 出庫レスポンス */
export interface ShipResponse {
  success: true;
  updatedQuantity: number;
  lastUpdated: string; // ISO 8601
}

/** 負荷テスト開始リクエスト */
export interface LoadTestStartRequest {
  table: Table;
  durationSeconds: number;
  requestsPerSecond: number;
  warehouseDistribution: Record<Warehouse, number>;
}

/** 負荷テスト開始レスポンス */
export interface LoadTestStartResponse {
  executionId: string;
  status: 'STARTED';
}

/** 負荷テスト実行ステータス */
export interface ExecutionStatus {
  executionId: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  totalRequests: number;
  successCount: number;
  throttleCount: number;
  elapsedSeconds: number;
}

/** エラーレスポンス */
export interface ErrorResponse {
  error: string;
  message: string;
  details?: unknown;
}
