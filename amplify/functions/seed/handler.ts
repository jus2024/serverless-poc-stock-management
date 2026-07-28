import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  DynamoDBClient,
  BatchWriteItemCommand,
  type WriteRequest,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { generateSkus } from './sku-generator';
import type { Warehouse } from '../shared/types';

const client = new DynamoDBClient({});

const BAD_TABLE_NAME = process.env.BAD_TABLE_NAME!;
const GOOD_TABLE_NAME = process.env.GOOD_TABLE_NAME!;
const GOOD_GSI_TABLE_NAME = process.env.GOOD_GSI_TABLE_NAME!;
const BAD_ONDEMAND_TABLE_NAME = process.env.BAD_ONDEMAND_TABLE_NAME!;

const WAREHOUSES: Warehouse[] = ['WH-TOKYO', 'WH-OSAKA', 'WH-FUKUOKA'];
const BATCH_SIZE = 25;
const MAX_RETRIES = 8;
const BASE_DELAY_MS = 200;

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/**
 * 指数バックオフで待機する
 */
async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * BatchWriteItem を実行し、UnprocessedItems とスロットルエラーをリトライする
 */
async function batchWriteWithRetry(
  requestItems: Record<string, WriteRequest[]>
): Promise<number> {
  let unprocessed: Record<string, WriteRequest[]> | undefined = requestItems;
  let writtenCount = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (!unprocessed || Object.keys(unprocessed).length === 0) {
      break;
    }

    if (attempt > 0) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      await sleep(delay + Math.random() * 100);
    }

    try {
      const command = new BatchWriteItemCommand({
        RequestItems: unprocessed,
      });

      const result = await client.send(command);

      // 今回処理された件数を計算
      const totalRequested = Object.values(unprocessed).reduce(
        (sum, items) => sum + items.length,
        0
      );
      const unprocessedCount = result.UnprocessedItems
        ? Object.values(result.UnprocessedItems).reduce(
            (sum, items) => sum + items.length,
            0
          )
        : 0;
      writtenCount += totalRequested - unprocessedCount;

      unprocessed = result.UnprocessedItems as
        | Record<string, WriteRequest[]>
        | undefined;

      if (!unprocessed || Object.keys(unprocessed).length === 0) {
        break;
      }
    } catch (error: unknown) {
      const err = error as Error & { name?: string };
      if (
        err.name === 'ProvisionedThroughputExceededException' ||
        err.name === 'ThrottlingException'
      ) {
        // スロットル: そのまま次のリトライへ（unprocessed は変更しない）
        console.warn(
          `Seed: Throttled on attempt ${attempt + 1}/${MAX_RETRIES + 1}, retrying...`
        );
        continue;
      }
      throw error; // その他のエラーは再スロー
    }

    if (attempt === MAX_RETRIES && unprocessed && Object.keys(unprocessed).length > 0) {
      const remaining = Object.values(unprocessed).reduce(
        (sum, items) => sum + items.length,
        0
      );
      console.error(
        `Seed: Max retries (${MAX_RETRIES}) exhausted. ${remaining} items remain unprocessed.`
      );
    }
  }

  return writtenCount;
}

export const handler = async (
  _event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    console.log('Seed: Starting data generation...');
    const skus = generateSkus();
    console.log(`Seed: Generated ${skus.length} SKUs`);

    const lastUpdated = new Date().toISOString();
    let totalWritten = 0;

    // 各 SKU × 各倉庫のレコードを生成し、バッチ書き込み
    const allWriteRequests: {
      bad: WriteRequest[];
      good: WriteRequest[];
      goodGsi: WriteRequest[];
      badOnDemand: WriteRequest[];
    }[] = [];

    for (const sku of skus) {
      for (const warehouse of WAREHOUSES) {
        const record = {
          warehouseId: warehouse,
          itemId: sku.itemId,
          itemName: sku.itemName,
          quantity: sku.quantity,
          lotNumber: sku.lotNumber,
          location: sku.location,
          unitPrice: sku.unitPrice,
          lastUpdated,
        };

        // Bad_Table: PK=warehouseId, SK=itemId
        const badRequest: WriteRequest = {
          PutRequest: {
            Item: marshall(record),
          },
        };

        // Good_Table: PK=itemId, SK=warehouseId (same data, different key layout)
        const goodRequest: WriteRequest = {
          PutRequest: {
            Item: marshall(record),
          },
        };

        // Good_GSI_Table: Good_Table と同一のキーレイアウト（GSI の有無のみが違う）
        const goodGsiRequest: WriteRequest = {
          PutRequest: {
            Item: marshall(record),
          },
        };

        // Bad_OnDemand_Table: Bad_Table と同一のキーレイアウト（ビリングモードのみが違う）
        const badOnDemandRequest: WriteRequest = {
          PutRequest: {
            Item: marshall(record),
          },
        };

        allWriteRequests.push({
          bad: [badRequest],
          good: [goodRequest],
          goodGsi: [goodGsiRequest],
          badOnDemand: [badOnDemandRequest],
        });
      }
    }

    // バッチ処理: 25 件ずつ書き込み
    // Bad_Table / Good_Table / Good_GSI_Table / Bad_OnDemand_Table を並列で処理し、さらにバッチを並列投入する
    const badRequests: WriteRequest[] = allWriteRequests.map((r) => r.bad[0]);
    const goodRequests: WriteRequest[] = allWriteRequests.map((r) => r.good[0]);
    const goodGsiRequests: WriteRequest[] = allWriteRequests.map((r) => r.goodGsi[0]);
    const badOnDemandRequests: WriteRequest[] = allWriteRequests.map((r) => r.badOnDemand[0]);

    // 並列バッチ書き込み（同時 4 バッチまで）
    const CONCURRENCY = 4;

    async function writeBatches(
      tableName: string,
      requests: WriteRequest[],
      label: string
    ): Promise<number> {
      let written = 0;
      for (let i = 0; i < requests.length; i += BATCH_SIZE * CONCURRENCY) {
        const promises: Promise<number>[] = [];
        for (let j = 0; j < CONCURRENCY; j++) {
          const start = i + j * BATCH_SIZE;
          if (start >= requests.length) break;
          const batch = requests.slice(start, start + BATCH_SIZE);
          promises.push(batchWriteWithRetry({ [tableName]: batch }));
        }
        const results = await Promise.all(promises);
        written += results.reduce((sum, n) => sum + n, 0);

        const progress = Math.min(i + BATCH_SIZE * CONCURRENCY, requests.length);
        if (progress % 3000 < BATCH_SIZE * CONCURRENCY) {
          console.log(`Seed: ${label} progress - ${progress}/${requests.length} records`);
        }
      }
      return written;
    }

    // Bad / Good / Good_GSI / Bad_OnDemand を並列で書き込み
    const [badWritten, goodWritten, goodGsiWritten, badOnDemandWritten] = await Promise.all([
      writeBatches(BAD_TABLE_NAME, badRequests, 'Bad_Table'),
      writeBatches(GOOD_TABLE_NAME, goodRequests, 'Good_Table'),
      writeBatches(GOOD_GSI_TABLE_NAME, goodGsiRequests, 'Good_GSI_Table'),
      writeBatches(BAD_ONDEMAND_TABLE_NAME, badOnDemandRequests, 'Bad_OnDemand_Table'),
    ]);

    totalWritten = badWritten + goodWritten + goodGsiWritten + badOnDemandWritten;
    console.log(
      `Seed: Bad_Table - ${badWritten}, Good_Table - ${goodWritten}, Good_GSI_Table - ${goodGsiWritten}, Bad_OnDemand_Table - ${badOnDemandWritten}`
    );
    console.log(`Seed: Total records written across all four tables: ${totalWritten}`);

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        message: 'Seed completed',
        recordCount: totalWritten,
      }),
    };
  } catch (error) {
    console.error('Seed: Fatal error', error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: 'SEED_FAILED',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
