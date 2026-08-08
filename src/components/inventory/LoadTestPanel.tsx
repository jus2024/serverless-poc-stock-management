"use client";

import { useState, useEffect, useCallback } from "react";
import { startLoadTest, getLoadTestStatus } from "@/src/lib/inventory/api";
import type {
  Table,
  Warehouse,
  LoadTestParams,
  ExecutionStatus,
} from "@/src/lib/inventory/types";
import styles from "./LoadTestPanel.module.css";

const WAREHOUSES: Warehouse[] = ["WH-TOKYO", "WH-OSAKA", "WH-FUKUOKA"];

// 東京集中率 0.8: パーティション単位上限 1,000 WCU/秒 を確実に超過させるため。
// 宣言 4,000 RPS に対し実効 2,400 RPS（60%）を想定すると、
// 2,400 × 0.8 = 1,920 WCU/秒 が WH-TOKYO の単一パーティションに集中する。
const DEFAULT_DISTRIBUTION: Record<Warehouse, number> = {
  "WH-TOKYO": 0.8,
  "WH-OSAKA": 0.1,
  "WH-FUKUOKA": 0.1,
};

const POLL_INTERVAL_MS = 3000;

export default function LoadTestPanel() {
  // Form state
  const table: Table = "good";
  const [durationSeconds, setDurationSeconds] = useState(120);
  // 初期値 4,000（上限値）: クローズドループ構造のため実効 RPS は宣言値の 50〜60% に留まる。
  // 実効 2,400 RPS × 東京集中率 0.8 = 1,920 WCU/秒 が WH-TOKYO に集中し、
  // パーティション単位上限 1,000 WCU/秒 を確実に超過させられる。
  // RPS を下げて測定し直すと split-for-heat の履歴差が生まれて比較できなくなるため、
  // 最初から余裕のある値で 1 周だけ測定する。
  const [requestsPerSecond, setRequestsPerSecond] = useState(4000);
  const [warehouseDistribution, setWarehouseDistribution] =
    useState<Record<Warehouse, number>>(DEFAULT_DISTRIBUTION);

  // Execution state
  const [running, setRunning] = useState(false);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [executionStatus, setExecutionStatus] =
    useState<ExecutionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 倉庫分布を変更する */
  const handleDistributionChange = (warehouse: Warehouse, value: number) => {
    setWarehouseDistribution((prev) => ({
      ...prev,
      [warehouse]: value,
    }));
  };

  /** 分布合計を計算 */
  const distributionSum = Object.values(warehouseDistribution).reduce(
    (sum, v) => sum + v,
    0
  );

  /** 負荷テスト開始 */
  const handleStart = async () => {
    setError(null);
    setExecutionStatus(null);

    const params: LoadTestParams = {
      table,
      durationSeconds,
      requestsPerSecond,
      warehouseDistribution,
    };

    try {
      setRunning(true);
      const result = await startLoadTest(params);
      setExecutionId(result.executionId);
    } catch (err: unknown) {
      setRunning(false);
      if (err && typeof err === "object" && "message" in err) {
        setError((err as { message: string }).message);
      } else {
        setError("負荷テストの開始に失敗しました");
      }
    }
  };

  /** ポーリングでステータスを取得 */
  const pollStatus = useCallback(async () => {
    if (!executionId) return;
    try {
      const status = await getLoadTestStatus(executionId);
      setExecutionStatus(status);
      if (status.status === "COMPLETED" || status.status === "FAILED") {
        setRunning(false);
      }
    } catch (err: unknown) {
      if (err && typeof err === "object" && "message" in err) {
        setError((err as { message: string }).message);
      }
      setRunning(false);
    }
  }, [executionId]);

  /** ポーリング用 useEffect */
  useEffect(() => {
    if (!running || !executionId) return;

    // 初回即時取得
    pollStatus();

    const interval = setInterval(pollStatus, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [running, executionId, pollStatus]);

  /** ステータスバッジの CSS クラス */
  const getStatusBadgeClass = (status: ExecutionStatus["status"]) => {
    switch (status) {
      case "RUNNING":
        return "badge badge-running";
      case "COMPLETED":
        return "badge badge-completed";
      case "FAILED":
        return "badge badge-failed";
    }
  };

  /** ステータスラベル */
  const getStatusLabel = (status: ExecutionStatus["status"]) => {
    switch (status) {
      case "RUNNING":
        return "実行中";
      case "COMPLETED":
        return "完了";
      case "FAILED":
        return "失敗";
    }
  };

  return (
    <div className={styles.panel}>
      {/* 設定フォーム */}
      <div className={`card ${styles.form}`}>
        {/* 継続秒数 */}
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel} htmlFor="duration">
            継続秒数
          </label>
          <input
            id="duration"
            type="number"
            className={`input ${styles.numberInput}`}
            value={durationSeconds}
            onChange={(e) =>
              setDurationSeconds(Math.min(300, Math.max(1, Number(e.target.value))))
            }
            min={1}
            max={300}
            disabled={running}
          />
          <span className={styles.hint}>最大 300 秒</span>
        </div>

        {/* リクエスト/秒 */}
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel} htmlFor="rps">
            リクエスト/秒
          </label>
          <input
            id="rps"
            type="number"
            className={`input ${styles.numberInput}`}
            value={requestsPerSecond}
            onChange={(e) =>
              setRequestsPerSecond(Math.min(4000, Math.max(1, Number(e.target.value))))
            }
            min={1}
            max={4000}
            disabled={running}
          />
          <span className={styles.hint}>最大 4,000 req/s（実効値は宣言値の 50〜60% 程度）</span>
        </div>

        {/* 倉庫分布比率 */}
        <div className={styles.fieldGroup}>
          <span className={styles.fieldLabel}>倉庫分布比率</span>
          <div className={styles.distributionGrid}>
            {WAREHOUSES.map((wh) => (
              <div key={wh} className={styles.distributionRow}>
                <span className={styles.distributionLabel}>{wh}</span>
                <input
                  type="number"
                  className={`input ${styles.distributionInput}`}
                  value={warehouseDistribution[wh]}
                  onChange={(e) =>
                    handleDistributionChange(
                      wh,
                      Math.min(1, Math.max(0, Number(e.target.value)))
                    )
                  }
                  min={0}
                  max={1}
                  step={0.1}
                  disabled={running}
                />
              </div>
            ))}
          </div>
          <span
            className={`${styles.distributionSum} ${
              Math.abs(distributionSum - 1.0) > 0.01
                ? styles.distributionSumWarn
                : ""
            }`}
          >
            合計: {distributionSum.toFixed(2)}
            {Math.abs(distributionSum - 1.0) > 0.01 && " （合計を 1.0 に近づけてください）"}
          </span>
        </div>

        {/* 開始ボタン */}
        <button
          className={`btn-primary ${styles.startButton}`}
          onClick={handleStart}
          disabled={running}
        >
          {running ? "実行中..." : "負荷テスト開始"}
        </button>
      </div>

      {/* エラー表示 */}
      {error && (
        <div className="alert-error">
          <span className={styles.errorMessage}>{error}</span>
        </div>
      )}

      {/* 進捗カード */}
      {executionStatus && (
        <div className={`card ${styles.progressCard}`}>
          <div className={styles.progressHeader}>
            <span className={styles.progressTitle}>実行状況</span>
            <span className={getStatusBadgeClass(executionStatus.status)}>
              {getStatusLabel(executionStatus.status)}
            </span>
          </div>
          <div className={styles.progressStats}>
            <div className={styles.statItem}>
              <span className={styles.statLabel}>経過時間</span>
              <span className={styles.statValue}>
                {executionStatus.elapsedSeconds}s / {durationSeconds}s
              </span>
            </div>
            <div className={styles.statItem}>
              <span className={styles.statLabel}>総リクエスト</span>
              <span className={styles.statValue}>
                {executionStatus.totalRequests.toLocaleString()}
              </span>
            </div>
            <div className={styles.statItem}>
              <span className={styles.statLabel}>成功</span>
              <span className={styles.statValue}>
                {executionStatus.successCount.toLocaleString()}
                {executionStatus.totalRequests > 0 && (
                  <> ({Math.round((executionStatus.successCount / executionStatus.totalRequests) * 100)}%)</>
                )}
              </span>
            </div>
            <div className={styles.statItem}>
              <span className={styles.statLabel}>スロットル</span>
              <span className={`${styles.statValue} ${styles.statDanger}`}>
                {executionStatus.throttleCount.toLocaleString()}
                {executionStatus.totalRequests > 0 && (
                  <> ({Math.round((executionStatus.throttleCount / executionStatus.totalRequests) * 100)}%)</>
                )}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
