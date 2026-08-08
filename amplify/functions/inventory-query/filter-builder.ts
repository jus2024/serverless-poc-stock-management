/**
 * FilterExpression ビルダー
 *
 * GSI の KeyConditionExpression で使用されなかった検索条件を
 * DynamoDB の FilterExpression に変換する純粋関数。
 */

/**
 * GSI セレクターから渡される残余条件
 */
export interface RemainingCondition {
  /** DynamoDB の属性名 */
  field: string;
  /** 条件タイプ */
  type: 'prefix' | 'range' | 'contains';
  /** 条件値（range の場合は { min?: number; max?: number }） */
  value: string | { min?: number; max?: number };
}

/**
 * FilterExpression ビルド結果
 */
export interface FilterExpressionResult {
  /** FilterExpression 文字列（フィルタ不要の場合は undefined） */
  filterExpression: string | undefined;
  /** ExpressionAttributeNames（#field → 属性名のマッピング） */
  expressionAttributeNames: Record<string, string>;
  /** ExpressionAttributeValues（:value → 値のマッピング） */
  expressionAttributeValues: Record<string, { S: string } | { N: string }>;
}

/**
 * 残余条件から DynamoDB FilterExpression を構築する。
 *
 * マッピングルール:
 * - prefix  → begins_with(#field, :value)
 * - contains → contains(#field, :value)
 * - range   → #field BETWEEN :min AND :max / #field >= :min / #field <= :max
 *
 * 複数条件は AND で結合する。
 *
 * @param conditions - GSI セレクターが返す未使用条件の配列
 * @returns FilterExpression とその属性マッピング
 */
export function buildFilterExpression(
  conditions: RemainingCondition[]
): FilterExpressionResult {
  if (conditions.length === 0) {
    return {
      filterExpression: undefined,
      expressionAttributeNames: {},
      expressionAttributeValues: {} as Record<string, { S: string } | { N: string }>,
    };
  }

  const expressions: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, { S: string } | { N: string }> = {};

  for (let i = 0; i < conditions.length; i++) {
    const condition = conditions[i];
    const nameKey = `#f${i}`;
    const valueKey = `:v${i}`;

    expressionAttributeNames[nameKey] = condition.field;

    switch (condition.type) {
      case 'prefix': {
        expressionAttributeValues[valueKey] = { S: condition.value as string };
        expressions.push(`begins_with(${nameKey}, ${valueKey})`);
        break;
      }

      case 'contains': {
        expressionAttributeValues[valueKey] = { S: condition.value as string };
        expressions.push(`contains(${nameKey}, ${valueKey})`);
        break;
      }

      case 'range': {
        const rangeValue = condition.value as { min?: number; max?: number };
        const minKey = `:v${i}min`;
        const maxKey = `:v${i}max`;

        if (rangeValue.min !== undefined && rangeValue.max !== undefined) {
          expressionAttributeValues[minKey] = { N: String(rangeValue.min) };
          expressionAttributeValues[maxKey] = { N: String(rangeValue.max) };
          expressions.push(`${nameKey} BETWEEN ${minKey} AND ${maxKey}`);
        } else if (rangeValue.min !== undefined) {
          expressionAttributeValues[minKey] = { N: String(rangeValue.min) };
          expressions.push(`${nameKey} >= ${minKey}`);
        } else if (rangeValue.max !== undefined) {
          expressionAttributeValues[maxKey] = { N: String(rangeValue.max) };
          expressions.push(`${nameKey} <= ${maxKey}`);
        }
        break;
      }
    }
  }

  return {
    filterExpression: expressions.length > 0 ? expressions.join(' AND ') : undefined,
    expressionAttributeNames,
    expressionAttributeValues,
  };
}
