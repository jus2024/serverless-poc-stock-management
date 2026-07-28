/**
 * 在庫管理 API クライアント
 *
 * 環境変数 NEXT_PUBLIC_INVENTORY_API_URL から API ベース URL を取得し、
 * ネイティブ fetch を使ってブラウザから直接 API Gateway を呼び出す。
 */

import type {
  InventoryRecord,
  ListInventoryResponse,
  ShipResponse,
  LoadTestParams,
  ExecutionStatus,
  ErrorResponse,
  Table,
  OnlineImpactTestParams,
  OnlineImpactTestResponse,
} from "./types";

/** API ベース URL（末尾スラッシュを正規化） */
function getBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_INVENTORY_API_URL;
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_INVENTORY_API_URL が設定されていません。.env.local を確認してください。"
    );
  }
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * API エラーをパースして ErrorResponse 形式で throw する
 */
async function handleErrorResponse(response: Response): Promise<never> {
  let errorBody: ErrorResponse;
  try {
    errorBody = await response.json();
  } catch {
    errorBody = {
      error: `HTTP_${response.status}`,
      message: response.statusText || "Unknown error",
    };
  }
  throw errorBody;
}

/**
 * 倉庫別在庫一覧取得
 *
 * 指定テーブル・倉庫の在庫一覧をページネーション付きで取得する。
 * Good Table の場合、拡張検索オプションを指定できる。
 */
export async function listInventory(
  warehouseId: string,
  table: Table,
  nextToken?: string,
  searchOptions?: {
    searchBy?: 'itemPrefix' | 'location' | 'unitPrice';
    prefix?: string;
    minPrice?: number;
    maxPrice?: number;
  }
): Promise<ListInventoryResponse> {
  const baseUrl = getBaseUrl();
  const params = new URLSearchParams({ table });
  if (nextToken) params.set("nextToken", nextToken);
  if (searchOptions?.searchBy) {
    params.set("searchBy", searchOptions.searchBy);
    if (searchOptions.prefix) {
      params.set("prefix", searchOptions.prefix);
    }
    if (searchOptions.minPrice !== undefined) {
      params.set("minPrice", String(searchOptions.minPrice));
    }
    if (searchOptions.maxPrice !== undefined) {
      params.set("maxPrice", String(searchOptions.maxPrice));
    }
  }
  const url = `${baseUrl}/inventory/${encodeURIComponent(warehouseId)}?${params.toString()}`;

  const response = await fetch(url);
  if (!response.ok) {
    await handleErrorResponse(response);
  }
  return response.json();
}

/**
 * 在庫照会
 *
 * 指定テーブルから在庫レコードを取得し、レスポンスタイムを計測して返す。
 */
export async function queryInventory(
  warehouseId: string,
  itemId: string,
  table: Table
): Promise<{ data: InventoryRecord; latencyMs: number }> {
  const baseUrl = getBaseUrl();
  const params = new URLSearchParams({ table, itemId });
  const url = `${baseUrl}/inventory/${encodeURIComponent(warehouseId)}?${params.toString()}`;

  const start = performance.now();
  const response = await fetch(url);
  const latencyMs = Math.round(performance.now() - start);

  if (!response.ok) {
    await handleErrorResponse(response);
  }

  const data: InventoryRecord = await response.json();
  return { data, latencyMs };
}

/**
 * 出庫処理
 *
 * 指定テーブルの在庫を減算する。
 * noRetry=true の場合、Lambda 側で SDK リトライを無効化し、
 * スロットリングを即エラーとして返す。
 */
export async function shipInventory(
  warehouseId: string,
  itemId: string,
  quantity: number,
  table: Table,
  noRetry?: boolean
): Promise<ShipResponse> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/inventory/ship`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ warehouseId, itemId, quantity, table, noRetry: noRetry ?? false }),
  });

  if (!response.ok) {
    await handleErrorResponse(response);
  }

  return response.json();
}

/**
 * 負荷テスト開始
 *
 * 非同期で負荷生成を開始し、実行 ID を返す。
 */
export async function startLoadTest(
  params: LoadTestParams
): Promise<{ executionId: string }> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/load-test/start`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    await handleErrorResponse(response);
  }

  return response.json();
}

/**
 * 負荷テスト実行ステータス取得
 *
 * executionId を指定して現在の実行状態を取得する。
 */
export async function getLoadTestStatus(
  executionId: string
): Promise<ExecutionStatus> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/load-test/status/${encodeURIComponent(executionId)}`;

  const response = await fetch(url);

  if (!response.ok) {
    await handleErrorResponse(response);
  }

  return response.json();
}

/**
 * 初期データ投入（Seed）
 *
 * 両テーブルに 5,000 SKU × 3 倉庫 = 15,000 レコードを投入する。
 */
export async function seedData(): Promise<{ recordCount: number }> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/seed`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    await handleErrorResponse(response);
  }

  return response.json();
}

/**
 * オンライン影響テスト
 *
 * 連続出庫リクエストを実行し、レイテンシ・スロットル率を計測する。
 * バースト枯渇後に実行することで、ホットスポットがオンライン操作に
 * 与える影響を可視化する。
 *
 * 注意: 同期実行のため、durationSeconds 分のレスポンス待ちが発生する。
 */
export async function runOnlineImpactTest(
  params: OnlineImpactTestParams
): Promise<OnlineImpactTestResponse> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/load-test/online-impact`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    await handleErrorResponse(response);
  }

  return response.json();
}
