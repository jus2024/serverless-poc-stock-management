import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  DynamoDBClient,
  UpdateItemCommand,
  ScanCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import type { Table } from '../shared/types';

/**
 * オンライン影響テスト Lambda
 *
 * 「バースト枯渇後のオンライン操作」をシミュレートする。
 * SDK リトライを無効化（maxAttempts: 1）し、スロットリングが即エラーとして
 * 記録されるようにしている。これにより、ホットスポット状態で
 * オンラインユーザーが受ける影響を正確に計測できる。
 *
 * iterations を指定すると、1 回の起動で同じ測定を連続して複数ラウンド実行する。
 * 負荷テストのウィンドウ全体（例: 120 秒）を 1 クリックでカバーし、
 * ラウンドごとのスロットル率の振れを定量化するのが目的。
 *
 * リクエスト:
 *   POST /load-test/online-impact
 *   {
 *     "table": "bad" | "good" | "goodGsi" | "badOnDemand",
 *     "requestsPerSecond": 10,  // 1〜200
 *     "durationSeconds": 10,    // 1〜60
 *     "iterations": 10,         // オプション。1〜12（省略時 1）
 *     "warehouseId": "WH-TOKYO" // オプション。省略時は WH-TOKYO
 *   }
 *
 * レスポンス:
 *   {
 *     "summary": { totalRequests, successCount, throttleCount, errorCount, iterations, ... },
 *     "rounds":  [ { round, startedAt, throttleRate, p95LatencyMs, ... }, ... ],
 *     "requests": [ { index, round, second, latencyMs, status, error? }, ... ]
 *   }
 */

// SDK リトライ無効化 + ソケット上限拡大
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Agent as HttpsAgent } from 'https';

// keepAlive: true が必須。Node の https.Agent は既定 keepAlive=false のため、
// maxSockets だけ指定しても接続が再利用されず、毎リクエストで TCP + TLS
// ハンドシェイクが発生する。128MB Lambda ではこれが数百 ms のレイテンシとして
// 計測値に乗り、スロットリング由来の遅延が観測できなくなる。
const httpsAgent = new HttpsAgent({ maxSockets: 300, keepAlive: true });

// リトライ無効クライアント（デフォルト — スロットリングを即エラーとして記録）
const clientNoRetry = new DynamoDBClient({
  maxAttempts: 1,
  requestHandler: new NodeHttpHandler({ httpsAgent }),
});

// リトライ有効クライアント（SDK デフォルト 3 回リトライ）
const clientWithRetry = new DynamoDBClient({
  requestHandler: new NodeHttpHandler({ httpsAgent }),
});

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

function apiResponse(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}

/** 個別リクエスト結果 */
interface RequestResult {
  /** ラウンド番号（0 始まり） */
  round: number;
  index: number;
  /** ラウンド内の秒（0 始まり） */
  second: number;
  latencyMs: number;
  status: 'success' | 'throttled' | 'error';
  error?: string;
}

/** ラウンドごとの集計 */
interface RoundSummary {
  /** ラウンド番号（0 始まり） */
  round: number;
  /** ラウンド開始時刻（ISO8601） */
  startedAt: string;
  totalRequests: number;
  successCount: number;
  throttleCount: number;
  errorCount: number;
  /** スロットル率（パーセント、小数第 1 位まで） */
  throttleRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
}

/** サマリー */
interface Summary {
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
  retryMode: string;
}

/** スリープユーティリティ */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** パーセンタイル計算 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/** 論理テーブル名から実テーブル名を解決する */
function resolveTableName(table: Table): string {
  switch (table) {
    case 'bad':
      return process.env.BAD_TABLE_NAME!;
    case 'good':
      return process.env.GOOD_TABLE_NAME!;
    case 'goodGsi':
      return process.env.GOOD_GSI_TABLE_NAME!;
    case 'badOnDemand':
      return process.env.BAD_ONDEMAND_TABLE_NAME!;
  }
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  // Parse request body
  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '');
  } catch {
    return apiResponse(400, {
      error: 'INVALID_REQUEST',
      message: 'Invalid JSON in request body',
    });
  }

  const {
    table,
    requestsPerSecond,
    durationSeconds,
    iterations,
    warehouseId: requestedWarehouse,
    noRetry,
  } = body as Record<string, unknown>;

  // Validation
  if (table !== 'bad' && table !== 'good' && table !== 'goodGsi' && table !== 'badOnDemand') {
    return apiResponse(400, {
      error: 'INVALID_REQUEST',
      message: 'table is required and must be "bad", "good", "goodGsi" or "badOnDemand"',
    });
  }

  if (
    typeof requestsPerSecond !== 'number' ||
    !Number.isFinite(requestsPerSecond) ||
    requestsPerSecond < 1 ||
    requestsPerSecond > 200
  ) {
    return apiResponse(400, {
      error: 'INVALID_REQUEST',
      message: 'requestsPerSecond is required and must be between 1 and 200',
    });
  }

  if (
    typeof durationSeconds !== 'number' ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds < 1 ||
    durationSeconds > 60
  ) {
    return apiResponse(400, {
      error: 'INVALID_REQUEST',
      message: 'durationSeconds is required and must be between 1 and 60',
    });
  }

  // ラウンド数（省略時 1）。1 回の起動で連続測定する回数。
  const roundCount = iterations === undefined ? 1 : iterations;

  if (
    typeof roundCount !== 'number' ||
    !Number.isInteger(roundCount) ||
    roundCount < 1 ||
    roundCount > 12
  ) {
    return apiResponse(400, {
      error: 'INVALID_REQUEST',
      message: 'iterations must be an integer between 1 and 12',
    });
  }

  // Lambda タイムアウト 5 分に対する安全マージン
  if (roundCount * durationSeconds > 240) {
    return apiResponse(400, {
      error: 'INVALID_REQUEST',
      message: 'iterations * durationSeconds must not exceed 240 seconds',
    });
  }

  const warehouseId =
    typeof requestedWarehouse === 'string' && requestedWarehouse
      ? requestedWarehouse
      : 'WH-TOKYO';

  // リトライモード選択: noRetry=true(デフォルト) なら即エラー、false ならリトライあり
  const useNoRetry = noRetry !== false; // 省略時はリトライ無効
  const client = useNoRetry ? clientNoRetry : clientWithRetry;

  const tableName = resolveTableName(table);

  // SKU リストを取得
  let skuList: string[] = [];
  try {
    if (table === 'bad' || table === 'badOnDemand') {
      // Bad / BadOnDemand Table: PK=warehouseId なので Query で直接取得
      const queryResult = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'warehouseId = :wh',
          ExpressionAttributeValues: { ':wh': { S: warehouseId } },
          ProjectionExpression: 'itemId',
          Limit: 100,
        })
      );
      const items = queryResult.Items ?? [];
      for (const item of items) {
        const itemId = item.itemId?.S;
        if (itemId) skuList.push(itemId);
      }
    } else {
      // Good / GoodGsi Table: PK=itemId なので Scan で SKU を取得
      const scanResult = await client.send(
        new ScanCommand({
          TableName: tableName,
          Limit: 100,
          ProjectionExpression: 'itemId',
        })
      );
      const items = scanResult.Items ?? [];
      const skuSet = new Set<string>();
      for (const item of items) {
        const itemId = item.itemId?.S;
        if (itemId) skuSet.add(itemId);
      }
      skuList = Array.from(skuSet);
    }
  } catch (err) {
    return apiResponse(500, {
      error: 'SCAN_FAILED',
      message: `Failed to fetch SKUs: ${(err as Error).message}`,
    });
  }

  if (skuList.length === 0) {
    return apiResponse(400, {
      error: 'NO_DATA',
      message: 'No inventory records found. Run seed first.',
    });
  }

  // 連続リクエスト実行（ラウンドループ → 秒ループ）
  // ラウンド間に待機は挟まない。負荷ウィンドウを隙間なくカバーするため。
  const results: RequestResult[] = [];
  const rounds: RoundSummary[] = [];
  let requestIndex = 0;

  for (let round = 0; round < roundCount; round++) {
    const roundStartedAt = new Date().toISOString();
    const roundResults: RequestResult[] = [];

    for (let second = 0; second < durationSeconds; second++) {
      const secondStart = Date.now();
      const promises: Promise<RequestResult>[] = [];

      for (let i = 0; i < requestsPerSecond; i++) {
        const idx = requestIndex++;
        const itemId = skuList[Math.floor(Math.random() * skuList.length)];

        promises.push(
          executeSingleRequest(
            client,
            tableName,
            table as string,
            warehouseId,
            itemId,
            idx,
            round,
            second
          )
        );
      }

      const batchResults = await Promise.all(promises);
      roundResults.push(...batchResults);

      // 1 秒間隔を維持
      const elapsed = Date.now() - secondStart;
      if (elapsed < 1000 && second < durationSeconds - 1) {
        await sleep(1000 - elapsed);
      }
    }

    rounds.push(computeRoundSummary(roundResults, round, roundStartedAt));
    results.push(...roundResults);
  }

  // サマリー計算（全ラウンド合算）
  const summary = computeSummary(
    results,
    table as string,
    warehouseId,
    requestsPerSecond as number,
    durationSeconds as number,
    roundCount,
    useNoRetry ? 'noRetry' : 'withRetry'
  );

  return apiResponse(200, { summary, rounds, requests: results });
};

/** 単一の出庫リクエストを実行し、レイテンシとステータスを記録 */
async function executeSingleRequest(
  client: DynamoDBClient,
  tableName: string,
  table: string,
  warehouseId: string,
  itemId: string,
  index: number,
  round: number,
  second: number
): Promise<RequestResult> {
  // bad / badOnDemand は PK=warehouseId / SK=itemId
  // good / goodGsi は PK=itemId / SK=warehouseId
  const key =
    table === 'bad' || table === 'badOnDemand'
      ? { warehouseId: { S: warehouseId }, itemId: { S: itemId } }
      : { itemId: { S: itemId }, warehouseId: { S: warehouseId } };

  const now = new Date().toISOString();
  const start = Date.now();

  try {
    await client.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: key,
        UpdateExpression: 'SET quantity = quantity - :qty, lastUpdated = :now',
        ConditionExpression: 'quantity >= :qty',
        ExpressionAttributeValues: {
          ':qty': { N: '1' },
          ':now': { S: now },
        },
      })
    );

    const latencyMs = Date.now() - start;
    return { round, index, second, latencyMs, status: 'success' };
  } catch (error: unknown) {
    const latencyMs = Date.now() - start;
    const err = error as Error & { name?: string };

    if (
      err.name === 'ProvisionedThroughputExceededException' ||
      err.name === 'ThrottlingException'
    ) {
      return { round, index, second, latencyMs, status: 'throttled', error: err.name };
    }

    // ConditionalCheckFailedException は在庫切れ — success 扱い（DynamoDB は処理した）
    if (err.name === 'ConditionalCheckFailedException') {
      return { round, index, second, latencyMs, status: 'success' };
    }

    return { round, index, second, latencyMs, status: 'error', error: err.name ?? err.message };
  }
}

/** 結果からサマリーを計算 */
function computeSummary(
  results: RequestResult[],
  table: string,
  warehouseId: string,
  requestsPerSecond: number,
  durationSeconds: number,
  iterations: number,
  retryMode: string
): Summary {
  const totalRequests = results.length;
  const successCount = results.filter((r) => r.status === 'success').length;
  const throttleCount = results.filter((r) => r.status === 'throttled').length;
  const errorCount = results.filter((r) => r.status === 'error').length;

  const allLatencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const successLatencies = results
    .filter((r) => r.status === 'success')
    .map((r) => r.latencyMs);
  const throttledLatencies = results
    .filter((r) => r.status === 'throttled')
    .map((r) => r.latencyMs);

  const avg = (arr: number[]) => (arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);

  return {
    table,
    warehouseId,
    requestsPerSecond,
    durationSeconds,
    iterations,
    totalRequests,
    successCount,
    throttleCount,
    errorCount,
    avgLatencyMs: avg(allLatencies),
    p50LatencyMs: percentile(allLatencies, 50),
    p95LatencyMs: percentile(allLatencies, 95),
    p99LatencyMs: percentile(allLatencies, 99),
    successAvgLatencyMs: avg(successLatencies),
    throttledAvgLatencyMs: avg(throttledLatencies),
    retryMode,
  };
}
/** 1 ラウンド分の結果から集計を計算 */
function computeRoundSummary(
  results: RequestResult[],
  round: number,
  startedAt: string
): RoundSummary {
  const totalRequests = results.length;
  const successCount = results.filter((r) => r.status === 'success').length;
  const throttleCount = results.filter((r) => r.status === 'throttled').length;
  const errorCount = results.filter((r) => r.status === 'error').length;

  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const avgLatencyMs =
    latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0;

  // スロットル率はパーセント、小数第 1 位まで（例 54.8）
  const throttleRate =
    totalRequests > 0
      ? Math.round((throttleCount / totalRequests) * 1000) / 10
      : 0;

  return {
    round,
    startedAt,
    totalRequests,
    successCount,
    throttleCount,
    errorCount,
    throttleRate,
    avgLatencyMs,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    p99LatencyMs: percentile(latencies, 99),
  };
}
