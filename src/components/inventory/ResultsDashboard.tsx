"use client";

import type { ExecutionStatus } from "@/src/lib/inventory/types";
import styles from "./ResultsDashboard.module.css";

/** 実行結果にテーブル種別を付加した型 */
export interface ExecutionResult extends ExecutionStatus {
  table: string;
}

interface ResultsDashboardProps {
  results: ExecutionResult[];
}

/**
 * 結果ダッシュボードパネル
 *
 * Bad Table と Good Table の負荷テスト結果を比較表示する。
 * - Comparison Header: テーブル別の集計カード
 * - Metrics Comparison: 各指標の並列比較
 * - Execution History: 実行履歴テーブル
 */
export default function ResultsDashboard({ results }: ResultsDashboardProps) {
  if (results.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.emptyState}>
          負荷テストを実行すると、ここに結果が表示されます
        </div>
      </div>
    );
  }

  // テーブル別に集計
  const badResults = results.filter((r) => r.table === "bad");
  const goodResults = results.filter((r) => r.table === "good");

  const badSummary = computeSummary(badResults);
  const goodSummary = computeSummary(goodResults);

  // 実行履歴を新しい順にソート
  const sortedResults = [...results].sort((a, b) => {
    // executionId にタイムスタンプが含まれない場合は配列順を逆転
    return results.indexOf(b) - results.indexOf(a);
  });

  return (
    <div className={styles.panel}>
      {/* Comparison Header */}
      <div className={styles.comparisonHeader}>
        {/* Bad Table Card */}
        <div className={styles.tableIndicatorBad}>
          <div className={styles.indicatorTitle}>
            <span className={styles.indicatorIcon}>🔥</span>
            <span className={styles.indicatorLabelBad}>
              Bad Table（warehouseId PK）
            </span>
          </div>
          <div className={styles.indicatorStats}>
            <div className={styles.statItem}>
              <span className={styles.statLabel}>総リクエスト</span>
              <span className={styles.statValue}>
                {badSummary.totalRequests.toLocaleString()}
              </span>
            </div>
            <div className={styles.statItem}>
              <span className={styles.statLabel}>成功数</span>
              <span className={styles.statValue}>
                {badSummary.successCount.toLocaleString()}
              </span>
            </div>
            <div className={styles.statItem}>
              <span className={styles.statLabel}>スロットル数</span>
              <span className={styles.statValueDanger}>
                {badSummary.throttleCount.toLocaleString()}
              </span>
            </div>
            <div className={styles.statItem}>
              <span className={styles.statLabel}>成功率</span>
              <span className={styles.statValue}>
                {badSummary.successRate}%
              </span>
            </div>
          </div>
        </div>

        {/* Good Table Card */}
        <div className={styles.tableIndicatorGood}>
          <div className={styles.indicatorTitle}>
            <span className={styles.indicatorIcon}>🛡</span>
            <span className={styles.indicatorLabelGood}>
              Good Table（itemId PK）
            </span>
          </div>
          <div className={styles.indicatorStats}>
            <div className={styles.statItem}>
              <span className={styles.statLabel}>総リクエスト</span>
              <span className={styles.statValue}>
                {goodSummary.totalRequests.toLocaleString()}
              </span>
            </div>
            <div className={styles.statItem}>
              <span className={styles.statLabel}>成功数</span>
              <span className={styles.statValue}>
                {goodSummary.successCount.toLocaleString()}
              </span>
            </div>
            <div className={styles.statItem}>
              <span className={styles.statLabel}>スロットル数</span>
              <span className={styles.statValueSuccess}>
                {goodSummary.throttleCount.toLocaleString()}
              </span>
            </div>
            <div className={styles.statItem}>
              <span className={styles.statLabel}>成功率</span>
              <span className={styles.statValueSuccess}>
                {goodSummary.successRate}%
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Metrics Comparison Grid */}
      <div className={styles.metricsSection}>
        <h3 className={styles.metricsSectionTitle}>メトリクス比較</h3>
        <div className={styles.metricsGrid}>
          {/* Header row */}
          <div className={styles.metricsGridHeader}>🔥 Bad Table</div>
          <div className={styles.metricsGridHeader}>指標</div>
          <div className={styles.metricsGridHeader}>🛡 Good Table</div>

          {/* Throttle Count */}
          <div className={styles.metricRow}>
            <div className={styles.metricValueBad}>
              {badSummary.throttleCount.toLocaleString()}
            </div>
            <div className={styles.metricLabel}>Throttle 数</div>
            <div className={styles.metricValueGood}>
              {goodSummary.throttleCount.toLocaleString()}
            </div>
          </div>

          {/* Error Rate */}
          <div className={styles.metricRow}>
            <div className={styles.metricValueBad}>
              {badSummary.errorRate}%
            </div>
            <div className={styles.metricLabel}>Error Rate</div>
            <div className={styles.metricValueGood}>
              {goodSummary.errorRate}%
            </div>
          </div>

          {/* Success Rate */}
          <div className={styles.metricRow}>
            <div className={styles.metricValueBad}>
              {badSummary.successRate}%
            </div>
            <div className={styles.metricLabel}>Success Rate</div>
            <div className={styles.metricValueGood}>
              {goodSummary.successRate}%
            </div>
          </div>

          {/* Total Requests */}
          <div className={styles.metricRow}>
            <div className={styles.metricValueBad}>
              {badSummary.totalRequests.toLocaleString()}
            </div>
            <div className={styles.metricLabel}>Total Requests</div>
            <div className={styles.metricValueGood}>
              {goodSummary.totalRequests.toLocaleString()}
            </div>
          </div>

          {/* Avg Duration */}
          <div className={styles.metricRow}>
            <div className={styles.metricValueBad}>
              {badSummary.avgDuration}s
            </div>
            <div className={styles.metricLabel}>Avg Duration</div>
            <div className={styles.metricValueGood}>
              {goodSummary.avgDuration}s
            </div>
          </div>
        </div>
      </div>

      {/* Execution History Table */}
      <div className={styles.historySection}>
        <h3 className={styles.historySectionTitle}>実行履歴</h3>
        <div className={styles.tableWrapper}>
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Table</th>
                <th>Duration</th>
                <th>Requests</th>
                <th>Throttle</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sortedResults.map((result) => (
                <tr key={result.executionId}>
                  <td>
                    <span
                      className={styles.executionId}
                      title={result.executionId}
                    >
                      {result.executionId.slice(0, 8)}…
                    </span>
                  </td>
                  <td>
                    <span
                      className={`${styles.tableBadge} ${
                        result.table === "bad"
                          ? styles.tableBadgeBad
                          : styles.tableBadgeGood
                      }`}
                    >
                      {result.table === "bad" ? "🔥 Bad" : "🛡 Good"}
                    </span>
                  </td>
                  <td>{result.elapsedSeconds}s</td>
                  <td>{result.totalRequests.toLocaleString()}</td>
                  <td>{result.throttleCount.toLocaleString()}</td>
                  <td>
                    <span
                      className={`badge ${statusBadgeClass(result.status)}`}
                    >
                      {result.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/** テーブル別の集計結果 */
interface Summary {
  totalRequests: number;
  successCount: number;
  throttleCount: number;
  successRate: string;
  errorRate: string;
  avgDuration: string;
}

/** テーブル別の実行結果を集計する */
function computeSummary(results: ExecutionResult[]): Summary {
  if (results.length === 0) {
    return {
      totalRequests: 0,
      successCount: 0,
      throttleCount: 0,
      successRate: "0.0",
      errorRate: "0.0",
      avgDuration: "0",
    };
  }

  const totalRequests = results.reduce((sum, r) => sum + r.totalRequests, 0);
  const successCount = results.reduce((sum, r) => sum + r.successCount, 0);
  const throttleCount = results.reduce((sum, r) => sum + r.throttleCount, 0);
  const totalDuration = results.reduce((sum, r) => sum + r.elapsedSeconds, 0);

  const successRate =
    totalRequests > 0
      ? ((successCount / totalRequests) * 100).toFixed(1)
      : "0.0";
  const errorRate =
    totalRequests > 0
      ? ((throttleCount / totalRequests) * 100).toFixed(1)
      : "0.0";
  const avgDuration = (totalDuration / results.length).toFixed(0);

  return {
    totalRequests,
    successCount,
    throttleCount,
    successRate,
    errorRate,
    avgDuration,
  };
}

/** ステータスに応じたバッジ CSS クラスを返す */
function statusBadgeClass(
  status: "RUNNING" | "COMPLETED" | "FAILED"
): string {
  switch (status) {
    case "RUNNING":
      return "badge-running";
    case "COMPLETED":
      return "badge-completed";
    case "FAILED":
      return "badge-failed";
    default:
      return "";
  }
}
