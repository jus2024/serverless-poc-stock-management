"use client";

import type { InventoryRecord } from "@/src/lib/inventory/types";
import styles from "./InventoryTable.module.css";

interface InventoryTableProps {
  items: InventoryRecord[];
  nextToken: string | null;
  onLoadMore: () => void;
  onPrevPage: () => void;
  hasPrevPage: boolean;
  loading: boolean;
}

function formatPrice(price: number): string {
  return `¥${price.toLocaleString("ja-JP")}`;
}

export default function InventoryTable({
  items,
  nextToken,
  onLoadMore,
  onPrevPage,
  hasPrevPage,
  loading,
}: InventoryTableProps) {
  return (
    <div className={styles.tableContainer}>
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.th}>商品ID</th>
              <th className={styles.th}>商品名</th>
              <th className={styles.th}>数量</th>
              <th className={styles.th}>ロット番号</th>
              <th className={styles.th}>ロケーション</th>
              <th className={styles.th}>単価</th>
              <th className={styles.th}>最終更新</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={`${item.warehouseId}-${item.itemId}`} className={styles.tr}>
                <td className={`${styles.td} ${styles.mono}`}>{item.itemId}</td>
                <td className={styles.td}>{item.itemName}</td>
                <td className={`${styles.td} ${styles.number}`}>{item.quantity}</td>
                <td className={`${styles.td} ${styles.mono}`}>{item.lotNumber}</td>
                <td className={`${styles.td} ${styles.mono}`}>{item.location}</td>
                <td className={`${styles.td} ${styles.number}`}>
                  {formatPrice(item.unitPrice)}
                </td>
                <td className={styles.td}>{item.lastUpdated}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {items.length === 0 && (
        <p className={styles.empty}>データがありません</p>
      )}

      {(hasPrevPage || nextToken !== null) && (
        <div className={styles.pagination}>
          <button
            className={styles.pageBtn}
            onClick={onPrevPage}
            disabled={!hasPrevPage || loading}
          >
            ← 前のページ
          </button>
          <button
            className={styles.pageBtn}
            onClick={onLoadMore}
            disabled={nextToken === null || loading}
          >
            次のページ →
          </button>
        </div>
      )}
    </div>
  );
}
