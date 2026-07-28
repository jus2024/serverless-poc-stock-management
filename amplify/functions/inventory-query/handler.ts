import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  ScanCommand,
  ProvisionedThroughputExceededException,
} from '@aws-sdk/client-dynamodb';
import type {
  AttributeValue,
  QueryCommandInput,
  ScanCommandInput,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { Table } from '../shared/types';

const client = new DynamoDBClient({});

const BAD_TABLE_NAME = process.env.BAD_TABLE_NAME!;
const GOOD_TABLE_NAME = process.env.GOOD_TABLE_NAME!;
const GOOD_GSI_TABLE_NAME = process.env.GOOD_GSI_TABLE_NAME!;
const BAD_ONDEMAND_TABLE_NAME = process.env.BAD_ONDEMAND_TABLE_NAME!;

/** CORS ヘッダー共通定義 */
const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
};

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

/** 論理テーブル名から実テーブル名を解決する */
function resolveTableName(table: Table): string {
  switch (table) {
    case 'bad':
      return BAD_TABLE_NAME;
    case 'good':
      return GOOD_TABLE_NAME;
    case 'goodGsi':
      return GOOD_GSI_TABLE_NAME;
    case 'badOnDemand':
      return BAD_ONDEMAND_TABLE_NAME;
  }
}

/** PK が warehouseId のテーブルか（true なら倉庫別 Query が可能） */
function isWarehousePartitioned(table: Table): boolean {
  return table === 'bad' || table === 'badOnDemand';
}

/** GSI による拡張検索に対応しているテーブルか */
function supportsIndexSearch(table: Table): boolean {
  return table === 'goodGsi';
}

/** エラーメッセージ表示用のテーブル表示名 */
function tableDisplayName(table: string | undefined): string {
  switch (table) {
    case 'bad':
      return 'Bad Table';
    case 'good':
      return 'Good Table';
    case 'goodGsi':
      return 'Good + GSI Table';
    case 'badOnDemand':
      return 'Bad + OnDemand Table';
    default:
      return 'Unknown Table';
  }
}

/**
 * 在庫一覧取得ハンドラー
 *
 * GET /inventory/{warehouseId}?table=bad|good|goodGsi|badOnDemand&nextToken=...&searchBy=...&prefix=...&minPrice=...&maxPrice=...
 *
 * テーブルごとの一覧取得手段:
 * - bad / badOnDemand: PK=warehouseId なのでテーブル直接 Query
 * - goodGsi:           PK=itemId だが GSI byWarehouse / byLocation / byUnitPrice で Query
 * - good:              PK=itemId かつ GSI なし → Scan + FilterExpression（非効率、設計上のトレードオフ）
 *
 * searchBy パラメータによる検索モード（GSI を持つ goodGsi のみ対応）:
 * - searchBy=itemPrefix + prefix → GSI byWarehouse, begins_with(itemId, :prefix)
 * - searchBy=location + prefix  → GSI byLocation, begins_with(location, :prefix)
 * - searchBy=unitPrice + minPrice + maxPrice → GSI byUnitPrice, unitPrice BETWEEN
 * - searchBy なし → 既存動作（全件取得）
 */
async function handleListInventory(
  warehouseId: string,
  table: Table,
  nextToken?: string,
  searchBy?: string,
  searchParams?: Record<string, string>
): Promise<APIGatewayProxyResult> {
  // 拡張検索は GSI を持つ goodGsi のみ対応
  if (searchBy && !supportsIndexSearch(table)) {
    return errorResponse(
      400,
      'UNSUPPORTED_SEARCH',
      '拡張検索は Good + GSI Table でのみサポートされています'
    );
  }

  // nextToken のデコード
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;
  if (nextToken) {
    try {
      const decoded = Buffer.from(nextToken, 'base64url').toString('utf-8');
      exclusiveStartKey = JSON.parse(decoded);
    } catch {
      return errorResponse(400, 'INVALID_TOKEN', 'nextToken が不正です');
    }
  }

  // テーブル/インデックス選択
  // good のみ Scan、それ以外は Query を使う
  let queryParams: QueryCommandInput | undefined;
  let scanParams: ScanCommandInput | undefined;

  if (isWarehousePartitioned(table)) {
    // bad / badOnDemand: PK=warehouseId なのでテーブル直接 Query
    queryParams = {
      TableName: resolveTableName(table),
      KeyConditionExpression: 'warehouseId = :wh',
      ExpressionAttributeValues: { ':wh': { S: warehouseId } },
      Limit: 20,
      ExclusiveStartKey: exclusiveStartKey,
    };
  } else if (table === 'goodGsi') {
    if (searchBy === 'itemPrefix' && searchParams?.prefix) {
      // Good + GSI Table: GSI byWarehouse + itemId 前方一致
      queryParams = {
        TableName: GOOD_GSI_TABLE_NAME,
        IndexName: 'byWarehouse',
        KeyConditionExpression: 'warehouseId = :wh AND begins_with(itemId, :prefix)',
        ExpressionAttributeValues: {
          ':wh': { S: warehouseId },
          ':prefix': { S: searchParams.prefix },
        },
        Limit: 20,
        ExclusiveStartKey: exclusiveStartKey,
      };
    } else if (searchBy === 'location' && searchParams?.prefix) {
      // Good + GSI Table: GSI byLocation + location 前方一致
      queryParams = {
        TableName: GOOD_GSI_TABLE_NAME,
        IndexName: 'byLocation',
        KeyConditionExpression: 'warehouseId = :wh AND begins_with(#loc, :prefix)',
        ExpressionAttributeNames: { '#loc': 'location' },
        ExpressionAttributeValues: {
          ':wh': { S: warehouseId },
          ':prefix': { S: searchParams.prefix },
        },
        Limit: 20,
        ExclusiveStartKey: exclusiveStartKey,
      };
    } else if (
      searchBy === 'unitPrice' &&
      searchParams?.minPrice &&
      searchParams?.maxPrice
    ) {
      // Good + GSI Table: GSI byUnitPrice + unitPrice 範囲検索
      queryParams = {
        TableName: GOOD_GSI_TABLE_NAME,
        IndexName: 'byUnitPrice',
        KeyConditionExpression:
          'warehouseId = :wh AND unitPrice BETWEEN :minPrice AND :maxPrice',
        ExpressionAttributeValues: {
          ':wh': { S: warehouseId },
          ':minPrice': { N: searchParams.minPrice },
          ':maxPrice': { N: searchParams.maxPrice },
        },
        Limit: 20,
        ExclusiveStartKey: exclusiveStartKey,
      };
    } else {
      // Good + GSI Table: デフォルト（GSI byWarehouse で全件取得）
      queryParams = {
        TableName: GOOD_GSI_TABLE_NAME,
        IndexName: 'byWarehouse',
        KeyConditionExpression: 'warehouseId = :wh',
        ExpressionAttributeValues: { ':wh': { S: warehouseId } },
        Limit: 20,
        ExclusiveStartKey: exclusiveStartKey,
      };
    }
  } else {
    // Good Table: PK=itemId かつ GSI がないため、倉庫別に引く手段が存在しない。
    // そのため Scan + FilterExpression で倉庫を絞り込む。
    // - Limit は「フィルタ適用前の読み取り件数」なので、20 件返すために 100 件読む必要がある
    // - テーブル全体が 15,000 件あるため、ページングを繰り返すと実質全件走査になり RCU を大量に消費する
    // - これは PK=itemId に GSI を付けなかった場合のトレードオフそのもの
    scanParams = {
      TableName: GOOD_TABLE_NAME,
      FilterExpression: 'warehouseId = :wh',
      ExpressionAttributeValues: { ':wh': { S: warehouseId } },
      Limit: 100,
      ExclusiveStartKey: exclusiveStartKey,
    };
  }

  try {
    // Query か Scan かでコマンドを切り替える（レスポンスの扱いは共通）
    const result = scanParams
      ? await client.send(new ScanCommand(scanParams))
      : await client.send(new QueryCommand(queryParams!));

    // レスポンス構築
    // 注意: good の Scan では LastEvaluatedKey が返っても、FilterExpression で
    // 除外された結果 Items が空になることがある。その場合も nextToken を返し、
    // クライアント側で「次へ」を押せば次ページを取得できるようにする。
    const items = (result.Items ?? []).map((item) => unmarshall(item));
    const responseNextToken = result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64url')
      : null;

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ items, nextToken: responseNextToken }),
    };
  } catch (error: unknown) {
    if (error instanceof ProvisionedThroughputExceededException) {
      return errorResponse(
        500,
        'THROTTLED',
        'DynamoDB のプロビジョンドスループットを超過しました。リトライ後も失敗しました。'
      );
    }
    throw error;
  }
}

/**
 * 在庫照会 Lambda ハンドラー
 *
 * GET /inventory/{warehouseId}/{itemId}?table=bad|good|goodGsi|badOnDemand  → 個別取得
 * GET /inventory/{warehouseId}?table=bad|good|goodGsi|badOnDemand&nextToken=... → 一覧取得
 *
 * 個別取得のキー構造:
 * - bad / badOnDemand: GetItem(PK=warehouseId, SK=itemId)
 * - good / goodGsi:    GetItem(PK=itemId, SK=warehouseId)
 * - ConsistentRead: true を常に指定
 *
 * 一覧取得の手段:
 * - bad / badOnDemand: テーブル直接 Query（PK=warehouseId）
 * - goodGsi:           GSI Query（byWarehouse / byLocation / byUnitPrice）
 * - good:              Scan + FilterExpression（GSI なしのため）
 */
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    // パスパラメータのバリデーション
    const warehouseId = event.pathParameters?.warehouseId;
    const itemId = event.pathParameters?.itemId || event.queryStringParameters?.itemId;

    if (!warehouseId) {
      return errorResponse(400, 'INVALID_PARAMETERS', 'warehouseId パスパラメータが必要です');
    }

    // クエリパラメータのバリデーション
    const table = event.queryStringParameters?.table;

    const validTables: Table[] = ['bad', 'good', 'goodGsi', 'badOnDemand'];
    if (!table || !validTables.includes(table as Table)) {
      return errorResponse(
        400,
        'INVALID_TABLE',
        'table クエリパラメータは "bad" / "good" / "goodGsi" / "badOnDemand" のいずれかを指定してください'
      );
    }

    // ルーティング: itemId が無い場合は一覧取得
    if (!itemId) {
      const nextToken = event.queryStringParameters?.nextToken;
      const searchBy = event.queryStringParameters?.searchBy;
      const searchParams: Record<string, string> = {};
      if (event.queryStringParameters?.prefix) {
        searchParams.prefix = event.queryStringParameters.prefix;
      }
      if (event.queryStringParameters?.minPrice) {
        searchParams.minPrice = event.queryStringParameters.minPrice;
      }
      if (event.queryStringParameters?.maxPrice) {
        searchParams.maxPrice = event.queryStringParameters.maxPrice;
      }
      return handleListInventory(
        warehouseId,
        table as Table,
        nextToken ?? undefined,
        searchBy ?? undefined,
        Object.keys(searchParams).length > 0 ? searchParams : undefined
      );
    }

    // 個別取得: テーブル名とキー構成の決定
    const tableName = resolveTableName(table as Table);
    // bad / badOnDemand は PK=warehouseId / SK=itemId
    // good / goodGsi は PK=itemId / SK=warehouseId
    const key = isWarehousePartitioned(table as Table)
      ? { warehouseId: { S: warehouseId }, itemId: { S: itemId } }
      : { itemId: { S: itemId }, warehouseId: { S: warehouseId } };

    // DynamoDB GetItem
    const command = new GetItemCommand({
      TableName: tableName,
      Key: key,
      ConsistentRead: true,
    });

    const result = await client.send(command);

    // アイテム未存在 → 404
    if (!result.Item) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({
          error: 'NOT_FOUND',
          message: `アイテムが見つかりません: warehouseId=${warehouseId}, itemId=${itemId}, table=${table}`,
        }),
      };
    }

    // アイテムをプレーンオブジェクトに変換して返却
    const record = unmarshall(result.Item);

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(record),
    };
  } catch (error: unknown) {
    // スロットリングエラーの処理
    if (error instanceof ProvisionedThroughputExceededException) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({
          error: 'THROTTLED',
          message: 'DynamoDB のプロビジョンドスループットを超過しました。リトライ後も失敗しました。',
          details: {
            tableName: tableDisplayName(event.queryStringParameters?.table),
          },
        }),
      };
    }

    // その他のエラー
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('inventory-query error:', error);

    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: 'INTERNAL_ERROR',
        message: `内部エラーが発生しました: ${errorMessage}`,
      }),
    };
  }
};
