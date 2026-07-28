"use client";

import { useState } from "react";
import { queryInventory } from "@/src/lib/inventory/api";
import type { InventoryRecord, Table, Warehouse } from "@/src/lib/inventory/types";
import styles from "./InventoryQueryPanel.module.css";

interface QueryResult {
  data: InventoryRecord;
  latencyMs: number;
}

interface QueryError {
  error: string;
  message: string;
  details?: unknown;
}

const WAREHOUSES: { value: Warehouse; label: string }[] = [
  { value: "WH-TOKYO", label: "WH-TOKYO（東京）" },
  { value: "WH-OSAKA", label: "WH-OSAKA（大阪）" },
  { value: "WH-FUKUOKA", label: "WH-FUKUOKA（福岡）" },
];

function getLatencyClass(ms: number): string {
  if (ms < 100) return styles.latencyFast;
  if (ms <= 500) return styles.latencyModerate;
  return styles.latencySlow;
}

function formatPrice(price: number): string {
  return `¥${price.toLocaleString("ja-JP")}`;
}

export default function InventoryQueryPanel() {
  const [table, setTable] = useState<Table>("bad");
  const [warehouseId, setWarehouseId] = useState<Warehouse>("WH-TOKYO");
  const [itemId, setItemId] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<QueryError | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!itemId.trim()) return;

    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const res = await queryInventory(warehouseId, itemId.trim(), table);
      setResult(res);
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "error" in err &&
        "message" in err
      ) {
        setError(err as QueryError);
      } else {
        setError({
          error: "UNKNOWN_ERROR",
          message: "予期しないエラーが発生しました",
        });
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.panel}>
      {/* Query Form */}
      <form className={styles.formCard} onSubmit={handleSubmit}>
        {/* Table Selection */}
        <div className={styles.fieldGroup}>
          <span className={styles.label}>テーブル</span>
          <div className={styles.radioGroup}>
            <label className={styles.radioLabel}>
              <input
                type="radio"
                name="table"
                value="bad"
                checked={table === "bad"}
                onChange={() => setTable("bad")}
              />
              Bad Table
            </label>
            <label className={styles.radioLabel}>
              <input
                type="radio"
                name="table"
                value="good"
                checked={table === "good"}
                onChange={() => setTable("good")}
              />
              Good Table
            </label>
          </div>
        </div>

        {/* Warehouse Selection */}
        <div className={styles.fieldGroup}>
          <label className={styles.label} htmlFor="warehouse-select">
            倉庫
          </label>
          <select
            id="warehouse-select"
            className={styles.select}
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value as Warehouse)}
          >
            {WAREHOUSES.map((wh) => (
              <option key={wh.value} value={wh.value}>
                {wh.label}
              </option>
            ))}
          </select>
        </div>

        {/* Item ID Input */}
        <div className={styles.fieldGroup}>
          <label className={styles.label} htmlFor="item-id-input">
            商品 ID
          </label>
          <input
            id="item-id-input"
            type="text"
            className={styles.input}
            value={itemId}
            onChange={(e) => setItemId(e.target.value)}
            placeholder="ITEM#ETH-YIRG-G1-MEDIUM-200G"
          />
        </div>

        {/* Submit Button */}
        <button
          type="submit"
          className={styles.submitBtn}
          disabled={loading || !itemId.trim()}
        >
          {loading ? "照会中…" : "照会実行"}
        </button>
      </form>

      {/* Result Card */}
      {result && (
        <div className={styles.resultCard}>
          <div className={styles.resultHeader}>
            <span className={styles.resultStatus}>Response: 200 OK</span>
            <span className={`${styles.latency} ${getLatencyClass(result.latencyMs)}`}>
              Latency: {result.latencyMs}ms
            </span>
          </div>
          <div className={styles.resultFields}>
            <span className={styles.fieldLabel}>商品名</span>
            <span className={styles.fieldValue}>{result.data.itemName}</span>

            <span className={styles.fieldLabel}>在庫数</span>
            <span className={styles.fieldValue}>{result.data.quantity}</span>

            <span className={styles.fieldLabel}>ロット</span>
            <span className={`${styles.fieldValue} ${styles.mono}`}>
              {result.data.lotNumber}
            </span>

            <span className={styles.fieldLabel}>棚番号</span>
            <span className={styles.fieldValue}>{result.data.location}</span>

            <span className={styles.fieldLabel}>単価</span>
            <span className={`${styles.fieldValue} ${styles.price}`}>
              {formatPrice(result.data.unitPrice)}
            </span>

            <span className={styles.fieldLabel}>更新日時</span>
            <span className={`${styles.fieldValue} ${styles.mono}`}>
              {result.data.lastUpdated}
            </span>
          </div>
        </div>
      )}

      {/* Error Card */}
      {error && (
        <div className={styles.errorCard}>
          <div className={styles.errorTitle}>{error.error}</div>
          <div className={styles.errorMessage}>{error.message}</div>
        </div>
      )}
    </div>
  );
}
