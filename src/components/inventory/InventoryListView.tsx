"use client";

import { useState, useEffect, useCallback } from "react";
import type {
  Table,
  Warehouse,
  InventoryRecord,
} from "@/src/lib/inventory/types";
import { listInventory, queryInventory, shipInventory } from "@/src/lib/inventory/api";
import type { ErrorResponse } from "@/src/lib/inventory/types";
import InventoryTable from "./InventoryTable";
import styles from "./InventoryListView.module.css";

interface InventoryListViewProps {
  table: Table;
}

const WAREHOUSES: Warehouse[] = ["WH-TOKYO", "WH-OSAKA", "WH-FUKUOKA"];

/** 商品IDプレフィックスの選択肢（sku-generator.ts の産地・カテゴリ定義に対応） */
const ITEM_PREFIX_GROUPS: {
  group: string;
  options: { value: string; label: string }[];
}[] = [
  {
    group: '産地（生豆・焙煎豆）',
    options: [
      { value: 'ITEM#ETH-', label: 'エチオピア' },
      { value: 'ITEM#BRA-', label: 'ブラジル' },
      { value: 'ITEM#COL-', label: 'コロンビア' },
      { value: 'ITEM#GTM-', label: 'グアテマラ' },
      { value: 'ITEM#KEN-', label: 'ケニア' },
      { value: 'ITEM#IDN-', label: 'インドネシア' },
      { value: 'ITEM#CRI-', label: 'コスタリカ' },
      { value: 'ITEM#TZA-', label: 'タンザニア' },
    ],
  },
  {
    group: 'カテゴリ',
    options: [
      { value: 'ITEM#BLEND-', label: 'ブレンド' },
      { value: 'ITEM#DRIP-', label: 'ドリップバッグ' },
      { value: 'ITEM#MAT-', label: '資材' },
    ],
  },
];

/** 拡張検索（GSI 前提）に対応しているテーブルか */
function supportsIndexSearch(table: Table): boolean {
  return table === "good" || table === "goodGsi";
}

/** 一覧取得が Scan になるテーブルか（GSI なしで PK=itemId） */
function usesScanForList(table: Table): boolean {
  return false;
}

export default function InventoryListView({ table }: InventoryListViewProps) {
  // 一覧セクション state
  const [warehouseId, setWarehouseId] = useState<Warehouse>("WH-TOKYO");
  const [items, setItems] = useState<InventoryRecord[]>([]);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentToken, setCurrentToken] = useState<string | undefined>(undefined);
  const [tokenHistory, setTokenHistory] = useState<(string | undefined)[]>([]);

  // 検索条件 state
  const [searchBy, setSearchBy] = useState<'' | 'itemPrefix' | 'location' | 'unitPrice'>('');
  const [searchPrefix, setSearchPrefix] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  // 個別照会セクション state
  const [queryItemId, setQueryItemId] = useState("");
  const [queryResult, setQueryResult] = useState<InventoryRecord | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);

  // 出庫処理セクション state
  const [shipWarehouseId, setShipWarehouseId] = useState<Warehouse>("WH-TOKYO");
  const [shipItemId, setShipItemId] = useState("");
  const [shipQuantity, setShipQuantity] = useState("");
  const [shipLoading, setShipLoading] = useState(false);
  const [shipError, setShipError] = useState<string | null>(null);
  const [shipSuccess, setShipSuccess] = useState<string | null>(null);
  const [shipNoRetry, setShipNoRetry] = useState(false);
  const [shipLatencyMs, setShipLatencyMs] = useState<number | null>(null);

  // 検索オプションの構築（通常関数 — useCallback 不要）
  const getSearchOptions = () => {
    const base: {
      searchBy?: 'itemPrefix' | 'location' | 'unitPrice';
      prefix?: string;
      minPrice?: number;
      maxPrice?: number;
      sortOrder?: 'asc' | 'desc';
    } = { sortOrder };

    if (searchBy === 'itemPrefix' && searchPrefix) {
      return { ...base, searchBy: 'itemPrefix' as const, prefix: searchPrefix };
    }
    if (searchBy === 'location' && searchPrefix) {
      return { ...base, searchBy: 'location' as const, prefix: searchPrefix };
    }
    if (searchBy === 'unitPrice' && minPrice && maxPrice) {
      return {
        ...base,
        searchBy: 'unitPrice' as const,
        minPrice: Number(minPrice),
        maxPrice: Number(maxPrice),
      };
    }
    return base;
  };

  // 一覧取得
  const fetchList = useCallback(
    async (token?: string, searchOptions?: {
      searchBy?: 'itemPrefix' | 'location' | 'unitPrice';
      prefix?: string;
      minPrice?: number;
      maxPrice?: number;
      sortOrder?: 'asc' | 'desc';
    }) => {
      setLoading(true);
      setError(null);
      try {
        const res = await listInventory(warehouseId, table, token ?? undefined, searchOptions);
        setItems(res.items);
        setNextToken(res.nextToken);
      } catch (err: unknown) {
        const e = err as ErrorResponse;
        if (e.error === "THROTTLED") {
          setError("DynamoDB スロットリング発生: " + (e.message || "リクエストが制限されています"));
        } else {
          setError(e.message || "データ取得に失敗しました");
        }
      } finally {
        setLoading(false);
      }
    },
    [warehouseId, table]
  );

  // table prop 変更時: items をクリアしリセットして再取得
  useEffect(() => {
    setItems([]);
    setNextToken(null);
    setCurrentToken(undefined);
    setTokenHistory([]);
    setSearchBy('');
    setSearchPrefix('');
    setMinPrice('');
    setMaxPrice('');
    setSortOrder('asc');
    fetchList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, warehouseId]);

  // 検索ボタン押下
  const handleSearch = () => {
    setItems([]);
    setNextToken(null);
    setCurrentToken(undefined);
    setTokenHistory([]);
    fetchList(undefined, getSearchOptions());
  };

  // 次のページ
  const handleNextPage = () => {
    if (nextToken) {
      setTokenHistory((prev) => [...prev, currentToken]);
      setCurrentToken(nextToken);
      fetchList(nextToken, getSearchOptions());
    }
  };

  // 前のページ
  const handlePrevPage = () => {
    if (tokenHistory.length > 0) {
      const prevToken = tokenHistory[tokenHistory.length - 1];
      setTokenHistory((prev) => prev.slice(0, -1));
      setCurrentToken(prevToken);
      fetchList(prevToken, getSearchOptions());
    }
  };

  // 個別照会
  const handleQuery = async () => {
    if (!queryItemId.trim()) return;
    setQueryLoading(true);
    setQueryError(null);
    setQueryResult(null);
    try {
      const res = await queryInventory(warehouseId, queryItemId.trim(), table);
      setQueryResult(res.data);
    } catch (err: unknown) {
      const e = err as ErrorResponse;
      if (e.error === "NOT_FOUND") {
        setQueryError("アイテムが見つかりません");
      } else if (e.error === "THROTTLED") {
        setQueryError("DynamoDB スロットリング発生: " + (e.message || "リクエストが制限されています"));
      } else {
        setQueryError(e.message || "照会に失敗しました");
      }
    } finally {
      setQueryLoading(false);
    }
  };

  // 出庫処理
  const handleShip = async () => {
    if (!shipItemId.trim() || !shipQuantity) return;
    const qty = parseInt(shipQuantity, 10);
    if (isNaN(qty) || qty <= 0) {
      setShipError("数量は正の整数を入力してください");
      return;
    }
    setShipLoading(true);
    setShipError(null);
    setShipSuccess(null);
    setShipLatencyMs(null);
    const startTime = performance.now();
    try {
      const res = await shipInventory(shipWarehouseId, shipItemId.trim(), qty, table, shipNoRetry);
      const clientLatency = Math.round(performance.now() - startTime);
      const serverLatency = res.latencyMs ?? null;
      setShipLatencyMs(serverLatency ?? clientLatency);
      setShipSuccess(
        `出庫完了 — 更新後数量: ${res.updatedQuantity}, 更新日時: ${res.lastUpdated}`
      );
    } catch (err: unknown) {
      const clientLatency = Math.round(performance.now() - startTime);
      setShipLatencyMs(clientLatency);
      const e = err as ErrorResponse;
      if (e.error === "NOT_FOUND") {
        setShipError("アイテムが見つかりません");
      } else if (e.error === "ProvisionedThroughputExceededException" || e.error === "ThrottlingException") {
        setShipError(`⚠️ スロットリング: サーバーが過負荷です (${clientLatency}ms)`);
      } else if (e.error === "THROTTLED") {
        setShipError("DynamoDB スロットリング発生: " + (e.message || "リクエストが制限されています"));
      } else {
        setShipError(e.message || "出庫処理に失敗しました");
      }
    } finally {
      setShipLoading(false);
    }
  };

  return (
    <div className={styles.container}>
      {/* 個別照会 + 出庫処理: 横並び */}
      <div className={styles.topRow}>
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>個別照会</h2>
          <div className={styles.formRow}>
            <div className={styles.fieldGroup}>
              <label className={styles.label} htmlFor="query-itemId">
                商品ID
              </label>
              <input
                id="query-itemId"
                className={styles.input}
                type="text"
                value={queryItemId}
                onChange={(e) => setQueryItemId(e.target.value)}
                placeholder="例: ITEM#ETH-YIRG-G1-MEDIUM-200G"
              />
            </div>
            <button
              className={styles.submitBtn}
              onClick={handleQuery}
              disabled={queryLoading || !queryItemId.trim()}
            >
              {queryLoading ? "照会中..." : "照会"}
            </button>
          </div>
          {queryError && (
            <div className={styles.errorCard}>
              <div className={styles.errorTitle}>エラー</div>
              <div className={styles.errorMessage}>{queryError}</div>
            </div>
          )}
          {queryResult && (
            <div className={styles.resultCard}>
              <div className={styles.resultFields}>
                <span className={styles.fieldLabel}>商品ID</span>
                <span className={styles.fieldValue}>{queryResult.itemId}</span>
                <span className={styles.fieldLabel}>商品名</span>
                <span className={styles.fieldValue}>{queryResult.itemName}</span>
                <span className={styles.fieldLabel}>数量</span>
                <span className={styles.fieldValue}>{queryResult.quantity}</span>
                <span className={styles.fieldLabel}>ロット番号</span>
                <span className={styles.fieldValue}>{queryResult.lotNumber}</span>
                <span className={styles.fieldLabel}>ロケーション</span>
                <span className={styles.fieldValue}>{queryResult.location}</span>
                <span className={styles.fieldLabel}>単価</span>
                <span className={styles.fieldValue}>
                  ¥{queryResult.unitPrice.toLocaleString("ja-JP")}
                </span>
                <span className={styles.fieldLabel}>最終更新</span>
                <span className={styles.fieldValue}>{queryResult.lastUpdated}</span>
              </div>
            </div>
          )}
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>出庫処理</h2>
          <div className={styles.formRow}>
            <div className={styles.fieldGroup}>
              <label className={styles.label} htmlFor="ship-warehouse">
                倉庫
              </label>
              <select
                id="ship-warehouse"
                className={styles.select}
                value={shipWarehouseId}
                onChange={(e) => setShipWarehouseId(e.target.value as Warehouse)}
              >
                {WAREHOUSES.map((wh) => (
                  <option key={wh} value={wh}>
                    {wh}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.fieldGroup}>
              <label className={styles.label} htmlFor="ship-itemId">
                商品ID
              </label>
              <input
                id="ship-itemId"
                className={styles.input}
                type="text"
                value={shipItemId}
                onChange={(e) => setShipItemId(e.target.value)}
                placeholder="例: ITEM#ETH-YIRG-G1-MEDIUM-200G"
              />
            </div>
            <div className={styles.fieldGroup}>
              <label className={styles.label} htmlFor="ship-quantity">
                数量
              </label>
              <input
                id="ship-quantity"
                className={styles.input}
                type="number"
                min="1"
                value={shipQuantity}
                onChange={(e) => setShipQuantity(e.target.value)}
                placeholder="数量"
              />
            </div>
            <button
              className={styles.submitBtn}
              onClick={handleShip}
              disabled={shipLoading || !shipItemId.trim() || !shipQuantity}
            >
              {shipLoading ? "処理中..." : "出庫"}
            </button>
          </div>
          {/* リトライモード切替 */}
          <div className={styles.retryToggle}>
            <label className={styles.retryLabel}>
              <input
                type="checkbox"
                checked={shipNoRetry}
                onChange={(e) => setShipNoRetry(e.target.checked)}
              />
              リトライ無効（スロットリングを即エラーで返す）
            </label>
          </div>
          {/* レイテンシ表示 */}
          {shipLatencyMs !== null && (
            <div className={styles.latencyBadge}>
              Latency: {shipLatencyMs}ms
            </div>
          )}
          {shipError && (
            <div className={styles.errorCard}>
              <div className={styles.errorTitle}>エラー</div>
              <div className={styles.errorMessage}>{shipError}</div>
            </div>
          )}
          {shipSuccess && (
            <div className={styles.successCard}>
              <div className={styles.successMessage}>{shipSuccess}</div>
            </div>
          )}
        </section>
      </div>

      {/* 在庫一覧: フル幅 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>在庫一覧</h2>
        <div className={styles.formRow}>
          <div className={styles.fieldGroup}>
            <label className={styles.label} htmlFor="list-warehouse">
              倉庫
            </label>
            <select
              id="list-warehouse"
              className={styles.select}
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value as Warehouse)}
            >
              {WAREHOUSES.map((wh) => (
                <option key={wh} value={wh}>
                  {wh}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.label} htmlFor="search-by">
              検索条件
            </label>
            <select
              id="search-by"
              className={styles.select}
              value={searchBy}
              onChange={(e) => {
                setSearchBy(e.target.value as '' | 'itemPrefix' | 'location' | 'unitPrice');
                setSearchPrefix('');
                setMinPrice('');
                setMaxPrice('');
              }}
              disabled={!supportsIndexSearch(table)}
            >
              <option value="">全件表示</option>
              <option value="itemPrefix">商品ID前方一致</option>
              <option value="location">ロケーション前方一致</option>
              <option value="unitPrice">単価範囲</option>
            </select>
          </div>
          {searchBy === 'itemPrefix' && (
            <div className={styles.fieldGroup}>
              <label className={styles.label} htmlFor="search-prefix">
                産地 / カテゴリ
              </label>
              <select
                id="search-prefix"
                className={styles.select}
                value={searchPrefix}
                onChange={(e) => setSearchPrefix(e.target.value)}
              >
                <option value="">選択してください</option>
                {ITEM_PREFIX_GROUPS.map((g) => (
                  <optgroup key={g.group} label={g.group}>
                    {g.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          )}
          {searchBy === 'location' && (
            <div className={styles.fieldGroup}>
              <label className={styles.label} htmlFor="search-location-prefix">
                ロケーションプレフィックス
              </label>
              <input
                id="search-location-prefix"
                className={styles.input}
                type="text"
                value={searchPrefix}
                onChange={(e) => setSearchPrefix(e.target.value)}
                placeholder="例: A-03"
              />
            </div>
          )}
          {searchBy === 'unitPrice' && (
            <>
              <div className={styles.fieldGroup}>
                <label className={styles.label} htmlFor="search-min-price">
                  最小単価
                </label>
                <input
                  id="search-min-price"
                  className={styles.input}
                  type="number"
                  min="0"
                  value={minPrice}
                  onChange={(e) => setMinPrice(e.target.value)}
                  placeholder="例: 1000"
                />
              </div>
              <div className={styles.fieldGroup}>
                <label className={styles.label} htmlFor="search-max-price">
                  最大単価
                </label>
                <input
                  id="search-max-price"
                  className={styles.input}
                  type="number"
                  min="0"
                  value={maxPrice}
                  onChange={(e) => setMaxPrice(e.target.value)}
                  placeholder="例: 3000"
                />
              </div>
            </>
          )}
          <div className={styles.fieldGroup}>
            <label className={styles.label} htmlFor="sort-order">
              並び順
            </label>
            <select
              id="sort-order"
              className={styles.select}
              value={sortOrder}
              onChange={(e) => {
                setSortOrder(e.target.value as 'asc' | 'desc');
                // 並び順が変わると既存のカーソルは意味を失うためページングをリセット
                setNextToken(null);
                setCurrentToken(undefined);
                setTokenHistory([]);
              }}
            >
              <option value="asc">昇順</option>
              <option value="desc">降順</option>
            </select>
          </div>
          <button
            className={styles.submitBtn}
            onClick={handleSearch}
            disabled={loading}
          >
            {loading ? "検索中..." : "検索"}
          </button>
        </div>
        {!supportsIndexSearch(table) && (
          <p className={styles.noteText}>
            ※ このテーブルには GSI がないため、拡張検索（商品ID前方一致・ロケーション・単価範囲）はサポートされていません
          </p>
        )}
        <p className={styles.noteText}>
          ※ 並び順は使用中の GSI のソートキー方向（ScanIndexForward）です。
          全件表示・商品ID前方一致は商品ID順、ロケーション前方一致は棚番号順、単価範囲は単価順に並びます
        </p>
        {usesScanForList(table) && (
          <p className={styles.noteText}>
            ※ PK=itemId で GSI がないため、倉庫別の一覧取得は Scan + フィルタになります。
            件数が多いと低速で RCU を大量に消費します（GSI を付けなかった場合のトレードオフ）
          </p>
        )}
        {error && (
          <div className={styles.errorCard}>
            <div className={styles.errorTitle}>エラー</div>
            <div className={styles.errorMessage}>{error}</div>
          </div>
        )}
        <InventoryTable
          items={items}
          nextToken={nextToken}
          onLoadMore={handleNextPage}
          onPrevPage={handlePrevPage}
          hasPrevPage={tokenHistory.length > 0}
          loading={loading}
        />
      </section>
    </div>
  );
}
