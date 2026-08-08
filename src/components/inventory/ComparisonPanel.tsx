"use client";

import type { InventoryRecord } from "@/src/lib/inventory/types";
import styles from "./ComparisonPanel.module.css";

/** 検索結果データ */
export interface SearchResult {
  source: "dynamodb" | "opensearch";
  items: InventoryRecord[];
  total: number;
  latencyMs: number;
  loading: boolean;
  error: string | null;
  metadata?: {
    usedIndex?: string;
    filterApplied?: string[];
    limitation?: string;
    took?: number;
  };
}

interface ComparisonPanelProps {
  dynamodbResult: SearchResult;
  opensearchResult: SearchResult;
}

function formatPrice(price: number): string {
  return `¥${price.toLocaleString("ja-JP")}`;
}

/** 個別パネルのヘッダー */
function PanelHeader({ result }: { result: SearchResult }) {
  const label = result.source === "dynamodb" ? "DynamoDB (GSI)" : "OpenSearch NextGen";

  return (
    <div className={styles.panelHeader}>
      <span className={styles.panelLabel}>{label}</span>
      <div className={styles.panelMeta}>
        {!result.loading && result.error === null && (
          <>
            <span className={styles.metaItem}>
              {result.latencyMs} ms
            </span>
            <span className={styles.metaItem}>
              {result.total} 件
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/** 結果テーブル */
function ResultTable({ items }: { items: InventoryRecord[] }) {
  if (items.length === 0) {
    return <p className={styles.empty}>データがありません</p>;
  }

  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th className={styles.th}>商品ID</th>
            <th className={styles.th}>倉庫ID</th>
            <th className={styles.th}>商品名</th>
            <th className={styles.th}>数量</th>
            <th className={styles.th}>ロケーション</th>
            <th className={styles.th}>単価</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={`${item.warehouseId}-${item.itemId}`} className={styles.tr}>
              <td className={`${styles.td} ${styles.mono}`}>{item.itemId}</td>
              <td className={`${styles.td} ${styles.mono}`}>{item.warehouseId}</td>
              <td className={styles.td}>{item.itemName}</td>
              <td className={`${styles.td} ${styles.number}`}>{item.quantity}</td>
              <td className={`${styles.td} ${styles.mono}`}>{item.location}</td>
              <td className={`${styles.td} ${styles.number}`}>{formatPrice(item.unitPrice)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 個別パネル（DynamoDB or OpenSearch） */
function SinglePanel({ result }: { result: SearchResult }) {
  return (
    <div className={styles.panel}>
      <PanelHeader result={result} />

      {/* DynamoDB 制約メッセージ */}
      {result.source === "dynamodb" && result.metadata?.limitation && (
        <div className={styles.limitation}>
          {result.metadata.limitation}
        </div>
      )}

      {/* OpenSearch コールドスタートローディング */}
      {result.source === "opensearch" && result.loading && (
        <div className={styles.coldStart}>
          <div className={styles.spinner} aria-hidden="true" />
          <span>コールドスタート中（10〜30 秒）</span>
        </div>
      )}

      {/* DynamoDB ローディング */}
      {result.source === "dynamodb" && result.loading && (
        <div className={styles.loading}>
          <div className={styles.spinner} aria-hidden="true" />
          <span>検索中...</span>
        </div>
      )}

      {/* エラー表示 */}
      {result.error && (
        <div className={styles.error}>{result.error}</div>
      )}

      {/* 結果テーブル */}
      {!result.loading && result.error === null && (
        <ResultTable items={result.items} />
      )}
    </div>
  );
}

/**
 * 検索比較パネル
 *
 * DynamoDB と OpenSearch の検索結果を左右に並べて比較表示する。
 * 768px 以下では縦並びに切り替わる。
 */
export default function ComparisonPanel({
  dynamodbResult,
  opensearchResult,
}: ComparisonPanelProps) {
  return (
    <div className={styles.container}>
      <SinglePanel result={dynamodbResult} />
      <SinglePanel result={opensearchResult} />
    </div>
  );
}
