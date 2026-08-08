/**
 * OpenSearch Query DSL ビルダー
 *
 * 検索パラメータから OpenSearch の Query DSL を構築する純粋関数。
 * Task 3.2 で完全な実装を行う。
 */

export interface SearchRequest {
  warehouseId?: string;
  itemPrefix?: string;
  locationPrefix?: string;
  itemName?: string;
  minPrice?: number;
  maxPrice?: number;
  minQuantity?: number;
  maxQuantity?: number;
  from?: number;
  size?: number;
}

/**
 * 検索パラメータから OpenSearch Query DSL を構築する。
 * 入力された条件を bool.must で AND 結合し、空フィールドは除外する。
 */
export function buildQuery(params: SearchRequest): object {
  const must: object[] = [];

  if (params.warehouseId) {
    must.push({ term: { 'warehouseId.keyword': params.warehouseId } });
  }
  if (params.itemPrefix) {
    must.push({ prefix: { 'itemId.keyword': params.itemPrefix } });
  }
  if (params.locationPrefix) {
    must.push({ prefix: { 'location.keyword': params.locationPrefix } });
  }
  if (params.itemName) {
    must.push({ match: { itemName: params.itemName } });
  }
  if (params.minPrice !== undefined || params.maxPrice !== undefined) {
    must.push({
      range: {
        unitPrice: {
          ...(params.minPrice !== undefined && { gte: params.minPrice }),
          ...(params.maxPrice !== undefined && { lte: params.maxPrice }),
        },
      },
    });
  }
  if (params.minQuantity !== undefined || params.maxQuantity !== undefined) {
    must.push({
      range: {
        quantity: {
          ...(params.minQuantity !== undefined && { gte: params.minQuantity }),
          ...(params.maxQuantity !== undefined && { lte: params.maxQuantity }),
        },
      },
    });
  }

  return {
    query: must.length > 0 ? { bool: { must } } : { match_all: {} },
    from: params.from ?? 0,
    size: params.size ?? 20,
  };
}
