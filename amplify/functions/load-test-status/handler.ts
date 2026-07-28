import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { ExecutionStatus } from '../shared/types';

const client = new DynamoDBClient({});
const EXECUTIONS_TABLE_NAME = process.env.EXECUTIONS_TABLE_NAME!;

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const executionId = event.pathParameters?.executionId;

  if (!executionId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: 'VALIDATION_ERROR',
        message: 'executionId path parameter is required',
      }),
    };
  }

  try {
    const result = await client.send(
      new GetItemCommand({
        TableName: EXECUTIONS_TABLE_NAME,
        Key: {
          executionId: { S: executionId },
        },
      })
    );

    if (!result.Item) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'NOT_FOUND',
          message: `Execution ${executionId} not found`,
        }),
      };
    }

    const item = unmarshall(result.Item);

    // 全ワーカーが完了していれば COMPLETED にフォールバック
    // （万が一 markWorkerCompleted の status 更新が遅れた場合の安全策）
    let status = item.status;
    const workerCount = item.workerCount ?? 1;
    const completedWorkers = item.completedWorkers ?? 0;
    if (status === 'RUNNING' && completedWorkers >= workerCount) {
      status = 'COMPLETED';
    }

    const response: ExecutionStatus = {
      executionId: item.executionId,
      status,
      totalRequests: item.totalRequests ?? 0,
      successCount: item.successCount ?? 0,
      throttleCount: item.throttleCount ?? 0,
      elapsedSeconds: item.elapsedSeconds ?? 0,
    };

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(response),
    };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Internal server error';

    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: 'INTERNAL_ERROR',
        message,
      }),
    };
  }
};
