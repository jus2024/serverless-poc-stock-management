import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  DynamoDBClient,
  UpdateItemCommand,
  GetItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import type { Table } from '../shared/types';

// デフォルトクライアント（SDK リトライあり = maxAttempts 3）
const clientWithRetry = new DynamoDBClient({});
// リトライ無効クライアント（スロットリングを即エラーとして返す）
const clientNoRetry = new DynamoDBClient({ maxAttempts: 1 });

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
    return response(400, {
      error: 'INVALID_REQUEST',
      message: 'Invalid JSON in request body',
    });
  }

  // Validate request fields
  const { warehouseId, itemId, quantity, table, noRetry } = body as Record<string, unknown>;

  if (!warehouseId || typeof warehouseId !== 'string') {
    return response(400, {
      error: 'INVALID_REQUEST',
      message: 'warehouseId is required and must be a string',
    });
  }
  if (!itemId || typeof itemId !== 'string') {
    return response(400, {
      error: 'INVALID_REQUEST',
      message: 'itemId is required and must be a string',
    });
  }
  if (typeof quantity !== 'number' || quantity <= 0 || !Number.isFinite(quantity)) {
    return response(400, {
      error: 'INVALID_REQUEST',
      message: 'quantity is required and must be a positive number',
    });
  }
  if (
    table !== 'bad' &&
    table !== 'good' &&
    table !== 'goodGsi' &&
    table !== 'badOnDemand'
  ) {
    return response(400, {
      error: 'INVALID_REQUEST',
      message: 'table is required and must be "bad", "good", "goodGsi" or "badOnDemand"',
    });
  }

  // リトライモード選択: noRetry=true なら SDK リトライ無効
  const client = noRetry === true ? clientNoRetry : clientWithRetry;

  // Determine table name and key schema
  const tableName = resolveTableName(table);

  // bad / badOnDemand は PK=warehouseId / SK=itemId
  // good / goodGsi は PK=itemId / SK=warehouseId
  const key =
    table === 'bad' || table === 'badOnDemand'
      ? { warehouseId: { S: warehouseId }, itemId: { S: itemId } }
      : { itemId: { S: itemId }, warehouseId: { S: warehouseId } };

  const now = new Date().toISOString();
  const startTime = Date.now();

  try {
    const result = await client.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: key,
        UpdateExpression: 'SET quantity = quantity - :qty, lastUpdated = :now',
        ConditionExpression: 'quantity >= :qty',
        ExpressionAttributeValues: {
          ':qty': { N: quantity.toString() },
          ':now': { S: now },
        },
        ReturnValues: 'ALL_NEW',
      })
    );

    const latencyMs = Date.now() - startTime;
    const updatedQuantity = Number(result.Attributes?.quantity?.N ?? 0);
    const lastUpdated = result.Attributes?.lastUpdated?.S ?? now;

    return response(200, {
      success: true,
      updatedQuantity,
      lastUpdated,
      latencyMs,
      retryMode: noRetry ? 'noRetry' : 'default',
    });
  } catch (error: unknown) {
    const latencyMs = Date.now() - startTime;

    // Handle insufficient stock
    if (error instanceof ConditionalCheckFailedException) {
      let currentQuantity = 0;
      try {
        const getResult = await clientWithRetry.send(
          new GetItemCommand({
            TableName: tableName,
            Key: key,
            ConsistentRead: true,
          })
        );
        currentQuantity = Number(getResult.Item?.quantity?.N ?? 0);
      } catch {
        // If we can't get current quantity, return 0
      }

      return response(400, {
        error: 'INSUFFICIENT_STOCK',
        message: `Insufficient stock. Current: ${currentQuantity}, Requested: ${quantity}`,
        currentQuantity,
        requestedQuantity: quantity,
        latencyMs,
      });
    }

    // Propagate throttling and other errors as-is
    const err = error as Error & { name?: string; $metadata?: { httpStatusCode?: number } };
    const statusCode = err.$metadata?.httpStatusCode ?? 500;

    return response(statusCode, {
      error: err.name ?? 'INTERNAL_ERROR',
      message: err.message ?? 'An unexpected error occurred',
      latencyMs,
      retryMode: noRetry ? 'noRetry' : 'default',
    });
  }
};
