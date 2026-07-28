import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand, UpdateItemCommand, ScanCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Agent as HttpsAgent } from 'https';
import { randomUUID } from 'crypto';
import type { Table } from '../shared/types';

// HTTP ソケット上限を拡大（デフォルト 50 → 500）
const dynamoClient = new DynamoDBClient({
  requestHandler: new NodeHttpHandler({
    httpsAgent: new HttpsAgent({ maxSockets: 500 }),
  }),
});
// 負荷生成専用クライアント: スロットルを正確に計測するため SDK の自動リトライを無効化する。
// 既定の standard リトライ（最大 3 回）が効くと、スロットルされたリクエストが裏で
// 再試行されて throttleCount が実際より少なく計上され、かつクローズドループ構造のため
// 再試行の待ち時間が実効 RPS を押し下げる。
const loadDynamoClient = new DynamoDBClient({
  maxAttempts: 1,
  requestHandler: new NodeHttpHandler({
    httpsAgent: new HttpsAgent({ maxSockets: 500 }),
  }),
});
const lambdaClient = new LambdaClient({});

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

function response(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}

/** Worker イベント型 */
interface WorkerEvent {
  isWorker: true;
  executionId: string;
  workerId: number;
  workerCount: number;
  table: Table;
  durationSeconds: number;
  requestsPerSecond: number;
  warehouseDistribution: Record<string, number>;
  /** start 側で 1 回だけ Scan した SKU リスト（全ワーカーで共通） */
  itemIds: string[];
}

/** 倉庫を重み付きランダムで選択 */
function selectWarehouse(distribution: Record<string, number>): string {
  const rand = Math.random();
  let cumulative = 0;
  for (const [warehouse, ratio] of Object.entries(distribution)) {
    cumulative += ratio;
    if (rand <= cumulative) {
      return warehouse;
    }
  }
  const keys = Object.keys(distribution);
  return keys[keys.length - 1];
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

/**
 * ワーカーモード: 負荷生成ループ
 *
 * 各ワーカーは自分の担当 RPS を処理し、executions テーブルには
 * ADD（アトミック加算）で更新する。これにより複数ワーカーのカウンタが
 * 正確に合算される。
 *
 * 完了時は completedWorkers を +1 する。全ワーカーが完了したら
 * status を COMPLETED に更新する。
 */
async function handleWorker(event: WorkerEvent): Promise<void> {
  const {
    executionId,
    workerId,
    workerCount,
    table,
    durationSeconds,
    requestsPerSecond,
    warehouseDistribution,
    itemIds,
  } = event;
  const executionsTableName = process.env.EXECUTIONS_TABLE_NAME!;
  const tableName = resolveTableName(table);

  let totalRequests = 0;
  let successCount = 0;
  let throttleCount = 0;
  // 前回の進捗更新時点の値（差分計算用）
  let lastReportedTotal = 0;
  let lastReportedSuccess = 0;
  let lastReportedThrottle = 0;

  try {
    // SKU プールは start 側で取得済みのものをイベントから受け取る。
    // ワーカー側の並列 Scan（Segment=workerId / TotalSegments=workerCount）は
    // パーティションキーのハッシュ空間でセグメントを分割するため、
    // PK=warehouseId のようにカーディナリティが低いテーブル（bad / badOnDemand は
    // WH-TOKYO / WH-OSAKA / WH-FUKUOKA の 3 値のみ）では items が入るセグメントが
    // 3 つに偏る（実測: TotalSegments=27 で segment 7/11/13 に各 1,000 件、残り 24 は 0 件）。
    // 空セグメントを引いたワーカーは即 return するため、27 ワーカーのうち 3 つしか
    // 負荷ループを回さず、宣言 4,000 RPS に対して実効 451 RPS に留まっていた。
    const skuList = itemIds;

    if (skuList.length === 0) {
      await markWorkerCompleted(executionsTableName, executionId, workerCount, 0, 0, 0);
      return;
    }

    console.log(`Worker ${workerId}/${workerCount}: Starting ${requestsPerSecond} req/s x ${durationSeconds}s`);
    const startTime = Date.now();

    for (let second = 0; second < durationSeconds; second++) {
      const secondStart = Date.now();

      // 1秒あたり requestsPerSecond 件のリクエストを生成
      const promises: Promise<void>[] = [];
      for (let i = 0; i < requestsPerSecond; i++) {
        const warehouse = selectWarehouse(warehouseDistribution);
        const sku = skuList[Math.floor(Math.random() * skuList.length)];
        promises.push(
          executeShipRequest(tableName, table, warehouse, sku)
            .then(() => {
              successCount++;
            })
            .catch((err: Error & { name?: string }) => {
              // loadDynamoClient は maxAttempts=1 のため、これらのスロットル系エラーは
              // SDK 側でリトライされず直接ここに到達する。
              if (
                err.name === 'ProvisionedThroughputExceededException' ||
                err.name === 'ThrottlingException' ||
                err.name === 'RequestLimitExceeded'
              ) {
                throttleCount++;
              } else {
                // ConditionalCheckFailed 等は成功扱い（DynamoDB は処理した）
                successCount++;
              }
            })
        );
        totalRequests++;
      }

      await Promise.all(promises);

      // 5秒ごとに進捗を ADD で更新（差分のみ加算）
      if ((second + 1) % 5 === 0) {
        const deltaTotal = totalRequests - lastReportedTotal;
        const deltaSuccess = successCount - lastReportedSuccess;
        const deltaThrottle = throttleCount - lastReportedThrottle;
        const elapsed = Math.floor((Date.now() - startTime) / 1000);

        await addProgress(executionsTableName, executionId, deltaTotal, deltaSuccess, deltaThrottle, elapsed);

        lastReportedTotal = totalRequests;
        lastReportedSuccess = successCount;
        lastReportedThrottle = throttleCount;
      }

      // 1秒間隔を維持
      const elapsed = Date.now() - secondStart;
      if (elapsed < 1000) {
        await sleep(1000 - elapsed);
      }
    }

    // 残りの差分を加算して完了マーク
    const deltaTotal = totalRequests - lastReportedTotal;
    const deltaSuccess = successCount - lastReportedSuccess;
    const deltaThrottle = throttleCount - lastReportedThrottle;

    console.log(`Worker ${workerId}/${workerCount}: Completed. total=${totalRequests}, success=${successCount}, throttle=${throttleCount}`);
    await markWorkerCompleted(executionsTableName, executionId, workerCount, deltaTotal, deltaSuccess, deltaThrottle);
  } catch (error) {
    console.error(`Worker ${workerId}/${workerCount}: Error`, error);
    // 残りの差分を加算して完了マーク（エラーでも）
    const deltaTotal = totalRequests - lastReportedTotal;
    const deltaSuccess = successCount - lastReportedSuccess;
    const deltaThrottle = throttleCount - lastReportedThrottle;
    await markWorkerCompleted(executionsTableName, executionId, workerCount, deltaTotal, deltaSuccess, deltaThrottle).catch(() => {});
  }
}

/** ADD でカウンタを加算する（進捗更新用） */
async function addProgress(
  tableName: string,
  executionId: string,
  deltaTotal: number,
  deltaSuccess: number,
  deltaThrottle: number,
  elapsedSeconds: number
): Promise<void> {
  await dynamoClient.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { executionId: { S: executionId } },
      UpdateExpression:
        'ADD totalRequests :total, successCount :success, throttleCount :throttle SET elapsedSeconds = :elapsed',
      ExpressionAttributeValues: {
        ':total': { N: deltaTotal.toString() },
        ':success': { N: deltaSuccess.toString() },
        ':throttle': { N: deltaThrottle.toString() },
        ':elapsed': { N: elapsedSeconds.toString() },
      },
    })
  );
}

/**
 * ワーカー完了時: 残りの差分を加算 + completedWorkers を +1
 * 全ワーカーが完了したら status を COMPLETED に更新
 */
async function markWorkerCompleted(
  tableName: string,
  executionId: string,
  workerCount: number,
  deltaTotal: number,
  deltaSuccess: number,
  deltaThrottle: number
): Promise<void> {
  const result = await dynamoClient.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { executionId: { S: executionId } },
      UpdateExpression:
        'ADD totalRequests :total, successCount :success, throttleCount :throttle, completedWorkers :one',
      ExpressionAttributeValues: {
        ':total': { N: deltaTotal.toString() },
        ':success': { N: deltaSuccess.toString() },
        ':throttle': { N: deltaThrottle.toString() },
        ':one': { N: '1' },
      },
      ReturnValues: 'ALL_NEW',
    })
  );

  // 全ワーカーが完了したら status を COMPLETED に更新
  const completedWorkers = Number(result.Attributes?.completedWorkers?.N ?? 0);
  if (completedWorkers >= workerCount) {
    await dynamoClient.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { executionId: { S: executionId } },
        UpdateExpression: 'SET #status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': { S: 'COMPLETED' } },
      })
    );
  }
}

/** 出庫リクエストを直接 DynamoDB に実行 */
async function executeShipRequest(
  tableName: string,
  table: Table,
  warehouseId: string,
  itemId: string
): Promise<void> {
  // bad / badOnDemand は PK=warehouseId / SK=itemId
  // good / goodGsi は PK=itemId / SK=warehouseId
  const key =
    table === 'bad' || table === 'badOnDemand'
      ? { warehouseId: { S: warehouseId }, itemId: { S: itemId } }
      : { itemId: { S: itemId }, warehouseId: { S: warehouseId } };

  const now = new Date().toISOString();

  await loadDynamoClient.send(
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
}

/** スリープユーティリティ */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * SKU プールを取得する（start 側で 1 回だけ実行）
 *
 * 並列 Scan は使わず、ExclusiveStartKey による順次ページングで取得する。
 * PK のカーディナリティが低いテーブルでは並列 Scan のセグメントが偏り、
 * 空セグメントを引いたワーカーが負荷ループを回せなくなるため、
 * ここで取得した同じ SKU リストを全ワーカーに配る。
 * 2,000 件 × 十数バイトで約 30KB、非同期 Invoke のペイロード上限 256KB に収まる。
 */
async function fetchItemIds(tableName: string): Promise<string[]> {
  const MAX_SKUS = 2000;
  const skuSet = new Set<string>();
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const page = await dynamoClient.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: lastKey,
        ProjectionExpression: 'itemId',
      })
    );
    for (const item of page.Items ?? []) {
      const itemId = item.itemId?.S;
      if (itemId) skuSet.add(itemId);
    }
    lastKey = page.LastEvaluatedKey;
  } while (lastKey && skuSet.size < MAX_SKUS);

  return Array.from(skuSet);
}

/** スタートモード: バリデーション → 初期レコード → 非同期Invoke → 202レスポンス */
async function handleStart(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '');
  } catch {
    return response(400, {
      error: 'INVALID_REQUEST',
      message: 'Invalid JSON in request body',
    });
  }

  const { table, durationSeconds, requestsPerSecond, warehouseDistribution } = body as Record<
    string,
    unknown
  >;

  // バリデーション
  if (table !== 'bad' && table !== 'good' && table !== 'goodGsi' && table !== 'badOnDemand') {
    return response(400, {
      error: 'INVALID_REQUEST',
      message: 'table is required and must be "bad", "good", "goodGsi" or "badOnDemand"',
    });
  }

  if (
    typeof durationSeconds !== 'number' ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > 300
  ) {
    return response(400, {
      error: 'INVALID_REQUEST',
      message: 'durationSeconds is required and must be a number between 1 and 300',
    });
  }

  // 上限 4,000: 実測では宣言 4,000 に対して実効 4,034 RPS（101%）が出ており、
  // 宣言値はほぼそのまま実効値になる。以前「クローズドループ構造の限界」として
  // 実効 RPS が宣言値の 50〜60% に留まると考えていた頭打ちは、実際には SKU プール
  // 取得の並列 Scan がセグメントの偏りでワーカーを空転させていたことが原因だった。
  // パーティション単位上限 1,000 WCU/秒 を超過させるには、東京集中率 0.8 の場合
  // 実効 1,250 RPS 以上が必要。4,000 なら東京へ 3,200 WCU/秒 が集中し確実に超過する。
  if (
    typeof requestsPerSecond !== 'number' ||
    !Number.isFinite(requestsPerSecond) ||
    requestsPerSecond <= 0 ||
    requestsPerSecond > 4000
  ) {
    return response(400, {
      error: 'INVALID_REQUEST',
      message: 'requestsPerSecond is required and must be a number between 1 and 4000',
    });
  }

  if (
    !warehouseDistribution ||
    typeof warehouseDistribution !== 'object' ||
    Array.isArray(warehouseDistribution)
  ) {
    return response(400, {
      error: 'INVALID_REQUEST',
      message: 'warehouseDistribution is required and must be an object',
    });
  }

  const dist = warehouseDistribution as Record<string, unknown>;
  const requiredWarehouses = ['WH-TOKYO', 'WH-OSAKA', 'WH-FUKUOKA'];
  for (const wh of requiredWarehouses) {
    const val = dist[wh];
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 1) {
      return response(400, {
        error: 'INVALID_REQUEST',
        message: `warehouseDistribution.${wh} must be a number between 0.0 and 1.0`,
      });
    }
  }

  const sum = requiredWarehouses.reduce((acc, wh) => acc + (dist[wh] as number), 0);
  if (Math.abs(sum - 1.0) > 0.01) {
    return response(400, {
      error: 'INVALID_REQUEST',
      message: 'warehouseDistribution values must sum to approximately 1.0',
    });
  }

  // ワーカー数を決定（各ワーカー最大 150 req/s）
  // 1ワーカーに 500 req/s を割り当てると Promise.all の完了待ちが 1 秒を超え、
  // クローズドループ構造のため実効 RPS が目標の約 1/3 に低下する。
  // 150 req/s なら 1 秒以内に収まり、宣言した RPS がそのまま出る。
  // 実測: 27 ワーカー × 149 req/s（宣言 4,000）で実効 4,034 RPS を確認済み。
  const rps = requestsPerSecond as number;
  const WORKER_RPS_CAPACITY = 150;
  const workerCount = Math.ceil(rps / WORKER_RPS_CAPACITY);

  // executionId 生成
  const executionId = randomUUID();
  const now = new Date().toISOString();
  const executionsTableName = process.env.EXECUTIONS_TABLE_NAME!;

  // SKU プールを start 側で 1 回だけ取得し、全ワーカーに同じリストを配る
  const tableName = resolveTableName(table as Table);
  const itemIds = await fetchItemIds(tableName);
  if (itemIds.length === 0) {
    return response(500, {
      error: 'NO_ITEMS',
      message: `No items found in table ${tableName}. Run seed first.`,
    });
  }

  // executions テーブルに初期レコード書き込み
  await dynamoClient.send(
    new PutItemCommand({
      TableName: executionsTableName,
      Item: {
        executionId: { S: executionId },
        status: { S: 'RUNNING' },
        table: { S: table },
        totalRequests: { N: '0' },
        successCount: { N: '0' },
        throttleCount: { N: '0' },
        completedWorkers: { N: '0' },
        workerCount: { N: workerCount.toString() },
        startedAt: { S: now },
        elapsedSeconds: { N: '0' },
        config: {
          M: {
            durationSeconds: { N: durationSeconds.toString() },
            requestsPerSecond: { N: requestsPerSecond.toString() },
            workerCount: { N: workerCount.toString() },
            warehouseDistribution: {
              M: Object.fromEntries(
                requiredWarehouses.map((wh) => [wh, { N: (dist[wh] as number).toString() }])
              ),
            },
          },
        },
      },
    })
  );

  // ワーカーを並列 Invoke
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME!;
  const rpsPerWorker = Math.ceil(rps / workerCount);

  const invokePromises: Promise<unknown>[] = [];
  for (let w = 0; w < workerCount; w++) {
    const workerRps = w === workerCount - 1
      ? rps - rpsPerWorker * (workerCount - 1)
      : rpsPerWorker;

    const workerPayload: WorkerEvent = {
      isWorker: true,
      executionId,
      workerId: w,
      workerCount,
      table: table as Table,
      durationSeconds: durationSeconds as number,
      requestsPerSecond: workerRps,
      warehouseDistribution: Object.fromEntries(
        requiredWarehouses.map((wh) => [wh, dist[wh] as number])
      ),
      itemIds,
    };

    invokePromises.push(
      lambdaClient.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: InvocationType.Event,
          Payload: Buffer.from(JSON.stringify(workerPayload)),
        })
      )
    );
  }

  await Promise.all(invokePromises);

  return response(202, {
    executionId,
    status: 'STARTED',
    workerCount,
  });
}

/**
 * Lambda ハンドラー: Start モード / Worker モードを自動判別
 */
export const handler = async (
  event: APIGatewayProxyEvent | WorkerEvent
): Promise<APIGatewayProxyResult | void> => {
  if ('isWorker' in event && event.isWorker === true) {
    await handleWorker(event as WorkerEvent);
    return;
  }
  return handleStart(event as APIGatewayProxyEvent);
};
