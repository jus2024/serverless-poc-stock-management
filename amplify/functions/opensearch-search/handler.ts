import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import type { InventoryRecord } from '../shared/types';
import { buildQuery } from './query-builder';
import type { SearchRequest } from './query-builder';

/** OpenSearch クライアント（SigV4 署名、AOSS 接続） */
const client = new Client({
  ...AwsSigv4Signer({
    region: process.env.AWS_REGION!,
    service: 'aoss',
    getCredentials: () => defaultProvider()(),
  }),
  node: process.env.OPENSEARCH_ENDPOINT!,
});

/** インデックス名 */
const INDEX_NAME = 'inventory';

/** CORS ヘッダー共通定義 */
const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
};

/** 検索レスポンス型 */
interface SearchResponse {
  items: InventoryRecord[];
  total: number;
  took: number;
  latencyMs: number;
  from: number;
  size: number;
}

/** エラーレスポンス生成ヘルパー */
function errorResponse(
  statusCode: number,
  error: string,
  message: string
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify({ error, message }),
  };
}

/** クエリパラメータから数値を安全にパースする */
function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const num = Number(value);
  return isNaN(num) ? undefined : num;
}

/**
 * OpenSearch 検索 Lambda ハンドラー
 *
 * GET /search?warehouseId=...&itemPrefix=...&locationPrefix=...&itemName=...
 *            &minPrice=...&maxPrice=...&minQuantity=...&maxQuantity=...&from=...&size=...
 */
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const startTime = Date.now();

  try {
    const params = event.queryStringParameters ?? {};

    // 検索パラメータの構築
    const searchRequest: SearchRequest = {
      warehouseId: params.warehouseId || undefined,
      itemPrefix: params.itemPrefix || undefined,
      locationPrefix: params.locationPrefix || undefined,
      itemName: params.itemName || undefined,
      minPrice: parseNumber(params.minPrice),
      maxPrice: parseNumber(params.maxPrice),
      minQuantity: parseNumber(params.minQuantity),
      maxQuantity: parseNumber(params.maxQuantity),
      from: parseNumber(params.from),
      size: parseNumber(params.size),
    };

    // Query DSL を構築
    const queryBody = buildQuery(searchRequest);

    // OpenSearch にクエリ実行
    const response = await client.search({
      index: INDEX_NAME,
      body: queryBody,
    });

    const body = response.body;
    const hits = body.hits?.hits ?? [];
    const total =
      typeof body.hits?.total === 'number'
        ? body.hits.total
        : body.hits?.total?.value ?? 0;
    const took = body.took ?? 0;

    // ヒットから InventoryRecord を抽出
    const items: InventoryRecord[] = hits.map(
      (hit: { _source: InventoryRecord }) => hit._source
    );

    const latencyMs = Date.now() - startTime;

    const searchResponse: SearchResponse = {
      items,
      total,
      took,
      latencyMs,
      from: (searchRequest.from ?? 0),
      size: (searchRequest.size ?? 20),
    };

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(searchResponse),
    };
  } catch (error: unknown) {
    const latencyMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('opensearch-search error:', error);

    // OpenSearch 接続エラー（コールドスタート等）
    if (
      errorMessage.includes('ECONNREFUSED') ||
      errorMessage.includes('ETIMEDOUT') ||
      errorMessage.includes('ConnectionError')
    ) {
      return errorResponse(
        503,
        'OPENSEARCH_UNAVAILABLE',
        `OpenSearch に接続できません（コールドスタート中の可能性あり）。経過時間: ${latencyMs}ms`
      );
    }

    return errorResponse(
      500,
      'INTERNAL_ERROR',
      `OpenSearch 検索でエラーが発生しました: ${errorMessage}`
    );
  }
};
