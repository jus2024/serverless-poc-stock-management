/**
 * GSI 選択ロジック
 *
 * 検索条件から最適な GSI を選択し、KeyConditionExpression と
 * FilterExpression に分割する残り条件を返す純粋関数。
 *
 * 優先順位:
 * 1. 単価範囲 (minPrice/maxPrice) → byUnitPrice
 * 2. ロケーション前方一致 (locationPrefix) → byLocation
 * 3. 商品 ID 前方一致 (itemPrefix) → byWarehouse
 * 4. デフォルト → byWarehouse（全件）
 */

/** 検索パラメータ入力 */
export interface GsiSearchParams {
  warehouseId: string;
  itemPrefix?: string;
  locationPrefix?: string;
  itemName?: string;
  minPrice?: number;
  maxPrice?: number;
  minQuantity?: number;
  maxQuantity?: number;
}

/** FilterExpression に回す残り条件 */
export interface RemainingCondition {
  field: string;
  type: 'prefix' | 'range' | 'contains';
  value: string | { min?: number; max?: number };
}

/** DynamoDB AttributeValue 型（SDK 依存を避けるための簡易定義） */
export type AttributeValueLike = { S: string } | { N: string };

/** GSI 選択結果 */
export interface GsiSelection {
  indexName: string;
  keyConditionExpression: string;
  expressionAttributeNames: Record<string, string>;
  expressionAttributeValues: Record<string, AttributeValueLike>;
  remainingConditions: RemainingCondition[];
}

/**
 * 検索条件から最適な GSI を選択し、KeyConditionExpression と
 * FilterExpression に回す残り条件を返す。
 *
 * 全 GSI の PK は warehouseId なので、warehouseId は常に
 * KeyConditionExpression に含まれる。
 */
export function selectGsi(params: GsiSearchParams): GsiSelection {
  const { warehouseId } = params;
  const remaining: RemainingCondition[] = [];

  // 優先順位 1: 単価範囲 → byUnitPrice
  if (params.minPrice !== undefined || params.maxPrice !== undefined) {
    const selection = buildUnitPriceGsi(warehouseId, params.minPrice, params.maxPrice);

    // 残り条件を収集
    if (params.itemPrefix) {
      remaining.push({ field: 'itemId', type: 'prefix', value: params.itemPrefix });
    }
    if (params.locationPrefix) {
      remaining.push({ field: 'location', type: 'prefix', value: params.locationPrefix });
    }
    if (params.itemName) {
      remaining.push({ field: 'itemName', type: 'contains', value: params.itemName });
    }
    if (params.minQuantity !== undefined || params.maxQuantity !== undefined) {
      remaining.push({
        field: 'quantity',
        type: 'range',
        value: { min: params.minQuantity, max: params.maxQuantity },
      });
    }

    return { ...selection, remainingConditions: remaining };
  }

  // 優先順位 2: ロケーション前方一致 → byLocation
  if (params.locationPrefix) {
    const selection = buildLocationGsi(warehouseId, params.locationPrefix);

    // 残り条件を収集
    if (params.itemPrefix) {
      remaining.push({ field: 'itemId', type: 'prefix', value: params.itemPrefix });
    }
    if (params.itemName) {
      remaining.push({ field: 'itemName', type: 'contains', value: params.itemName });
    }
    if (params.minQuantity !== undefined || params.maxQuantity !== undefined) {
      remaining.push({
        field: 'quantity',
        type: 'range',
        value: { min: params.minQuantity, max: params.maxQuantity },
      });
    }

    return { ...selection, remainingConditions: remaining };
  }

  // 優先順位 3: 商品 ID 前方一致 → byWarehouse (begins_with on SK=itemId)
  if (params.itemPrefix) {
    const selection = buildWarehouseGsiWithPrefix(warehouseId, params.itemPrefix);

    // 残り条件を収集
    if (params.itemName) {
      remaining.push({ field: 'itemName', type: 'contains', value: params.itemName });
    }
    if (params.minQuantity !== undefined || params.maxQuantity !== undefined) {
      remaining.push({
        field: 'quantity',
        type: 'range',
        value: { min: params.minQuantity, max: params.maxQuantity },
      });
    }

    return { ...selection, remainingConditions: remaining };
  }

  // 優先順位 4: デフォルト → byWarehouse（全件）
  const selection = buildWarehouseGsiDefault(warehouseId);

  // 残り条件を収集
  if (params.itemName) {
    remaining.push({ field: 'itemName', type: 'contains', value: params.itemName });
  }
  if (params.minQuantity !== undefined || params.maxQuantity !== undefined) {
    remaining.push({
      field: 'quantity',
      type: 'range',
      value: { min: params.minQuantity, max: params.maxQuantity },
    });
  }

  return { ...selection, remainingConditions: remaining };
}

/** byUnitPrice GSI: PK=warehouseId, SK=unitPrice (BETWEEN) */
function buildUnitPriceGsi(
  warehouseId: string,
  minPrice?: number,
  maxPrice?: number
): Omit<GsiSelection, 'remainingConditions'> {
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, AttributeValueLike> = {
    ':wh': { S: warehouseId },
  };

  let keyConditionExpression = '#pk = :wh';
  expressionAttributeNames['#pk'] = 'warehouseId';

  if (minPrice !== undefined && maxPrice !== undefined) {
    keyConditionExpression += ' AND #sk BETWEEN :minPrice AND :maxPrice';
    expressionAttributeNames['#sk'] = 'unitPrice';
    expressionAttributeValues[':minPrice'] = { N: String(minPrice) };
    expressionAttributeValues[':maxPrice'] = { N: String(maxPrice) };
  } else if (minPrice !== undefined) {
    keyConditionExpression += ' AND #sk >= :minPrice';
    expressionAttributeNames['#sk'] = 'unitPrice';
    expressionAttributeValues[':minPrice'] = { N: String(minPrice) };
  } else if (maxPrice !== undefined) {
    keyConditionExpression += ' AND #sk <= :maxPrice';
    expressionAttributeNames['#sk'] = 'unitPrice';
    expressionAttributeValues[':maxPrice'] = { N: String(maxPrice) };
  }

  return {
    indexName: 'byUnitPrice',
    keyConditionExpression,
    expressionAttributeNames,
    expressionAttributeValues,
  };
}

/** byLocation GSI: PK=warehouseId, SK=location (begins_with) */
function buildLocationGsi(
  warehouseId: string,
  locationPrefix: string
): Omit<GsiSelection, 'remainingConditions'> {
  return {
    indexName: 'byLocation',
    keyConditionExpression: '#pk = :wh AND begins_with(#sk, :locPrefix)',
    expressionAttributeNames: {
      '#pk': 'warehouseId',
      '#sk': 'location',
    },
    expressionAttributeValues: {
      ':wh': { S: warehouseId },
      ':locPrefix': { S: locationPrefix },
    },
  };
}

/** byWarehouse GSI: PK=warehouseId, SK=itemId (begins_with) */
function buildWarehouseGsiWithPrefix(
  warehouseId: string,
  itemPrefix: string
): Omit<GsiSelection, 'remainingConditions'> {
  return {
    indexName: 'byWarehouse',
    keyConditionExpression: '#pk = :wh AND begins_with(#sk, :itemPrefix)',
    expressionAttributeNames: {
      '#pk': 'warehouseId',
      '#sk': 'itemId',
    },
    expressionAttributeValues: {
      ':wh': { S: warehouseId },
      ':itemPrefix': { S: itemPrefix },
    },
  };
}

/** byWarehouse GSI: PK=warehouseId（全件） */
function buildWarehouseGsiDefault(
  warehouseId: string
): Omit<GsiSelection, 'remainingConditions'> {
  return {
    indexName: 'byWarehouse',
    keyConditionExpression: '#pk = :wh',
    expressionAttributeNames: {
      '#pk': 'warehouseId',
    },
    expressionAttributeValues: {
      ':wh': { S: warehouseId },
    },
  };
}
