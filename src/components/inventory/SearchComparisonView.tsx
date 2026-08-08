"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ComparisonSearchParams,
  OpenSearchSearchResponse,
  DynamoDBComparisonResponse,
} from "@/src/lib/inventory/types";
import { searchOpenSearch, searchDynamoDBComparison } from "@/src/lib/inventory/api";
import SearchForm from "./SearchForm";
import type { SearchState } from "./SearchForm";
import ComparisonPanel, { type SearchResult } from "./ComparisonPanel";
import LatencyBar from "./LatencyBar";
import styles from "./SearchComparisonView.module.css";

/** OpenSearch タイムアウト (ms) */
const OS_TIMEOUT_MS = 35_000;
/** コールドスタートメッセージ表示遅延 (ms) */
const COLD_START_DELAY_MS = 5_000;
/** デフォルトページサイズ */
const PAGE_SIZE = 20;

/** SearchForm の Partial<SearchState> を ComparisonSearchParams に変換 */
function toSearchParams(input: Partial<SearchState>): ComparisonSearchParams {
  const params: ComparisonSearchParams = {};
  if (input.warehouseId) params.warehouseId = input.warehouseId;
  if (input.itemPrefix) params.itemPrefix = input.itemPrefix;
  if (input.locationPrefix) params.locationPrefix = input.locationPrefix;
  if (input.itemName) params.itemName = input.itemName;
  if (input.minPrice) params.minPrice = Number(input.minPrice);
  if (input.maxPrice) params.maxPrice = Number(input.maxPrice);
  if (input.minQuantity) params.minQuantity = Number(input.minQuantity);
  if (input.maxQuantity) params.maxQuantity = Number(input.maxQuantity);
  return params;
}

const EMPTY_DDB: SearchResult = {
  source: "dynamodb",
  items: [],
  total: 0,
  latencyMs: 0,
  loading: false,
  error: null,
};

const EMPTY_OS: SearchResult = {
  source: "opensearch",
  items: [],
  total: 0,
  latencyMs: 0,
  loading: false,
  error: null,
};

/**
 * 検索比較ビュー
 *
 * SearchForm + ComparisonPanel + LatencyBar を統合するメインコンテナ。
 * Promise.allSettled で DynamoDB と OpenSearch に並列リクエストを送信し、
 * 結果を左右パネルで表示する。
 */
export default function SearchComparisonView() {
  const [dynamoResult, setDynamoResult] = useState<SearchResult>(EMPTY_DDB);
  const [osResult, setOsResult] = useState<SearchResult>(EMPTY_OS);

  // DynamoDB カーソルベースページネーション
  const [ddbNextToken, setDdbNextToken] = useState<string | null>(null);
  const [ddbPrevTokens, setDdbPrevTokens] = useState<string[]>([]);
  const lastParamsRef = useRef<ComparisonSearchParams>({});

  // OpenSearch ページ番号ページネーション
  const [osFrom, setOsFrom] = useState(0);

  // コールドスタート表示制御（5 秒後に loading: true を有効化）
  const [osColdStartVisible, setOsColdStartVisible] = useState(false);
  const coldStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const osLoadingRef = useRef(false);

  useEffect(() => {
    return () => {
      if (coldStartTimerRef.current) clearTimeout(coldStartTimerRef.current);
    };
  }, []);

  /** コールドスタートタイマー開始 */
  const startColdStartTimer = useCallback(() => {
    setOsColdStartVisible(false);
    if (coldStartTimerRef.current) clearTimeout(coldStartTimerRef.current);
    coldStartTimerRef.current = setTimeout(() => {
      // 5 秒経過時点でまだ loading 中ならコールドスタートメッセージ表示
      if (osLoadingRef.current) {
        setOsColdStartVisible(true);
      }
    }, COLD_START_DELAY_MS);
  }, []);

  /** コールドスタートタイマー停止 */
  const stopColdStartTimer = useCallback(() => {
    if (coldStartTimerRef.current) {
      clearTimeout(coldStartTimerRef.current);
      coldStartTimerRef.current = null;
    }
    setOsColdStartVisible(false);
    osLoadingRef.current = false;
  }, []);

  const executeSearch = useCallback(
    async (params: ComparisonSearchParams, options?: { osFrom?: number; ddbToken?: string | null }) => {
      lastParamsRef.current = params;
      const currentOsFrom = options?.osFrom ?? 0;
      const currentDdbToken = options?.ddbToken !== undefined ? (options.ddbToken || undefined) : undefined;

      // ローディング開始
      setDynamoResult((prev) => ({ ...prev, loading: true, error: null }));
      setOsResult((prev) => ({ ...prev, loading: true, error: null }));
      osLoadingRef.current = true;
      startColdStartTimer();

      // OpenSearch 35 秒タイムアウト
      const osTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("タイムアウト: OpenSearch が応答しませんでした（35秒超過）")), OS_TIMEOUT_MS)
      );

      // 並列リクエスト
      const [ddbSettled, osSettled] = await Promise.allSettled([
        searchDynamoDBComparison(params, currentDdbToken),
        Promise.race([
          searchOpenSearch({ ...params, from: currentOsFrom, size: PAGE_SIZE }),
          osTimeout,
        ]),
      ]);

      // DynamoDB 結果処理
      if (ddbSettled.status === "fulfilled") {
        const data = ddbSettled.value as DynamoDBComparisonResponse;
        setDdbNextToken(data.nextToken);
        setDynamoResult({
          source: "dynamodb",
          items: data.items,
          total: data.items.length,
          latencyMs: data.latencyMs,
          loading: false,
          error: null,
          metadata: {
            usedIndex: data.usedIndex,
            filterApplied: data.filterApplied,
            limitation: data.limitation,
          },
        });
      } else {
        setDynamoResult({
          ...EMPTY_DDB,
          error: ddbSettled.reason?.message ?? "DynamoDB 検索エラー",
        });
      }

      // OpenSearch 結果処理
      stopColdStartTimer();
      if (osSettled.status === "fulfilled") {
        const data = osSettled.value as OpenSearchSearchResponse;
        setOsFrom(currentOsFrom);
        setOsResult({
          source: "opensearch",
          items: data.items,
          total: data.total,
          latencyMs: data.latencyMs,
          loading: false,
          error: null,
          metadata: { took: data.took },
        });
      } else {
        setOsResult({
          ...EMPTY_OS,
          error: osSettled.reason?.message ?? "OpenSearch 検索エラー",
        });
      }
    },
    [startColdStartTimer, stopColdStartTimer]
  );

  /** 検索フォーム送信 */
  const handleSearch = useCallback(
    (params: Partial<SearchState>) => {
      const searchParams = toSearchParams(params);
      setDdbPrevTokens([]);
      setDdbNextToken(null);
      setOsFrom(0);
      executeSearch(searchParams, { osFrom: 0, ddbToken: null });
    },
    [executeSearch]
  );

  /** DynamoDB: 次へ */
  const handleDdbNext = useCallback(() => {
    if (!ddbNextToken) return;
    setDdbPrevTokens((prev) => [...prev, ddbNextToken]);
    executeSearch(lastParamsRef.current, { osFrom, ddbToken: ddbNextToken });
  }, [ddbNextToken, executeSearch, osFrom]);

  /** DynamoDB: 前へ */
  const handleDdbPrev = useCallback(() => {
    const newPrev = ddbPrevTokens.slice(0, -1);
    setDdbPrevTokens(newPrev);
    const token = newPrev.length > 0 ? newPrev[newPrev.length - 1] : null;
    executeSearch(lastParamsRef.current, { osFrom, ddbToken: token });
  }, [ddbPrevTokens, executeSearch, osFrom]);

  /** OpenSearch: ページ番号ジャンプ */
  const handleOsPageJump = useCallback(
    (page: number) => {
      const newFrom = (page - 1) * PAGE_SIZE;
      setOsFrom(newFrom);
      executeSearch(lastParamsRef.current, { osFrom: newFrom });
    },
    [executeSearch]
  );

  // OpenSearch パネルに渡す結果: 5 秒未満はローディングを隠す（コールドスタート表示制御）
  const displayedOsResult: SearchResult = osResult.loading
    ? { ...osResult, loading: osColdStartVisible }
    : osResult;

  const osCurrentPage = Math.floor(osFrom / PAGE_SIZE) + 1;
  const osTotalPages = Math.max(1, Math.ceil((osResult.total || 0) / PAGE_SIZE));

  return (
    <div className={styles.container}>
      <SearchForm onSearch={handleSearch} />

      <LatencyBar
        dynamoDbLatency={dynamoResult.loading ? null : dynamoResult.latencyMs || null}
        opensearchLatency={osResult.loading ? null : osResult.latencyMs || null}
      />

      <ComparisonPanel dynamodbResult={dynamoResult} opensearchResult={displayedOsResult} />

      {/* ページネーション */}
      <div className={styles.pagination}>
        {/* DynamoDB: カーソルベース 次へ/前へ */}
        <div className={styles.paginationPanel}>
          <button
            onClick={handleDdbPrev}
            disabled={ddbPrevTokens.length === 0 || dynamoResult.loading}
            className={styles.pageBtn}
          >
            前へ
          </button>
          <button
            onClick={handleDdbNext}
            disabled={!ddbNextToken || dynamoResult.loading}
            className={styles.pageBtn}
          >
            次へ
          </button>
        </div>

        {/* OpenSearch: ページ番号ジャンプ */}
        <div className={styles.paginationPanel}>
          <button
            onClick={() => handleOsPageJump(osCurrentPage - 1)}
            disabled={osCurrentPage <= 1 || osResult.loading}
            className={styles.pageBtn}
          >
            前へ
          </button>
          <span className={styles.pageInfo}>
            {osCurrentPage} / {osTotalPages}
          </span>
          <button
            onClick={() => handleOsPageJump(osCurrentPage + 1)}
            disabled={osCurrentPage >= osTotalPages || osResult.loading}
            className={styles.pageBtn}
          >
            次へ
          </button>
          {osTotalPages > 2 && (
            <input
              type="number"
              className={styles.pageInput}
              min={1}
              max={osTotalPages}
              value={osCurrentPage}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val) && val >= 1 && val <= osTotalPages) {
                  handleOsPageJump(val);
                }
              }}
              aria-label="ページ番号入力"
            />
          )}
        </div>
      </div>
    </div>
  );
}
