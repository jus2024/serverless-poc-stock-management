"use client";

import type { OnlineImpactTestResponse, OnlineImpactSummary } from "@/src/lib/inventory/types";
import styles from "./OnlineImpactComparison.module.css";

interface OnlineImpactComparisonProps {
  results: OnlineImpactTestResponse[];
  onClear?: () => void;
}

/**
 * オンライン影響テスト結果比較ダッシュボード
 *
 * bad / good / goodGsi / badOnDemand の 4 パターンの結果を並列比較し、
 * キー設計とキャパシティモードがオンライン操作に与える影響を可視化する。
 */
export default function OnlineImpactComparison({ results, onClear }: OnlineImpactComparisonProps) {
  const handleExport = () => {
    const json = JSON.stringify(results, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = `online-impact-results-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (results.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.emptyState}>
          <h3 className={styles.emptyTitle}>オンライン影響テスト結果</h3>
          <p className={styles.emptyDescription}>
            「負荷テスト」タブでオンライン影響テストを実行すると、ここに結果が表示されます。
          </p>
          <div className={styles.emptySteps}>
            <p><strong>推奨手順:</strong></p>
            <ol>
              <li>「負荷テスト」タブで対象テーブルに負荷をかける（4,000 RPS × 120 秒）</li>
              <li>負荷実行中（開始 30 秒以内）にオンライン影響テストを実行する</li>
              <li>bad → good → goodGsi → badOnDemand の 4 パターンを 1 回ずつ測定する</li>
              <li>このタブで結果を比較する</li>
            </ol>
            <p>
              注意: split-for-heat により時間経過でスロットルが回復するため、負荷開始直後に測ることが重要です。
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Bad / Good / GoodGsi / BadOnDemand に分離
  const badResults = results.filter((r) => r.summary.table === "bad");
  const goodResults = results.filter((r) => r.summary.table === "good");
  const goodGsiResults = results.filter((r) => r.summary.table === "goodGsi");
  const badOnDemandResults = results.filter((r) => r.summary.table === "badOnDemand");

  // 最新の結果を取得
  const latestBad = badResults.length > 0 ? badResults[badResults.length - 1].summary : null;
  const latestGood = goodResults.length > 0 ? goodResults[goodResults.length - 1].summary : null;
  const latestGoodGsi = goodGsiResults.length > 0 ? goodGsiResults[goodGsiResults.length - 1].summary : null;
  const latestBadOnDemand = badOnDemandResults.length > 0 ? badOnDemandResults[badOnDemandResults.length - 1].summary : null;

  return (
    <div className={styles.panel}>
      <div className={styles.titleRow}>
        <h2 className={styles.title}>オンライン影響テスト — 4 パターン比較</h2>
        <div className={styles.titleActions}>
          <button type="button" className={styles.actionButton} onClick={handleExport}>
            JSON エクスポート
          </button>
          {onClear && (
            <button type="button" className={styles.actionButton} onClick={onClear}>
              結果をクリア
            </button>
          )}
        </div>
      </div>

      {/* 比較ヘッダーカード */}
      <div className={styles.comparisonCards}>
        <SummaryCard
          label="🔥 Bad Table"
          sublabel="warehouseId PK / GSI なし"
          summary={latestBad}
          variant="bad"
        />
        <SummaryCard
          label="🛡 Good Table"
          sublabel="itemId PK / GSI なし"
          summary={latestGood}
          variant="good"
        />
        <SummaryCard
          label="🛡 Good + GSI Table"
          sublabel="itemId PK + GSI 3本"
          summary={latestGoodGsi}
          variant="goodGsi"
        />
        <SummaryCard
          label="🔥 Bad + OnDemand"
          sublabel="warehouseId PK / オンデマンド"
          summary={latestBadOnDemand}
          variant="badOnDemand"
        />
      </div>

      {/* 全実行履歴テーブル */}
      <div className={styles.historySection}>
        <h3 className={styles.sectionTitle}>実行履歴</h3>
        <div className={styles.tableWrapper}>
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Table</th>
                <th>Warehouse</th>
                <th>RPS × Duration</th>
                <th>Total</th>
                <th>Success</th>
                <th>Throttle</th>
                <th>Throttle %</th>
                <th>Avg ms</th>
                <th>p95 ms</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>
                    <span className={`${styles.tableBadge} ${tableBadgeClass(r.summary.table)}`}>
                      {tableBadgeLabel(r.summary.table)}
                    </span>
                  </td>
                  <td>{r.summary.warehouseId}</td>
                  <td>{r.summary.requestsPerSecond} × {r.summary.durationSeconds}s</td>
                  <td>{r.summary.totalRequests}</td>
                  <td>{r.summary.successCount}</td>
                  <td className={r.summary.throttleCount > 0 ? styles.danger : ""}>
                    {r.summary.throttleCount}
                  </td>
                  <td className={r.summary.throttleCount > 0 ? styles.danger : ""}>
                    {rate(r.summary.throttleCount, r.summary.totalRequests)}%
                  </td>
                  <td>{r.summary.avgLatencyMs}</td>
                  <td>{r.summary.p95LatencyMs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/** サマリーカード */
function SummaryCard({
  label,
  sublabel,
  summary,
  variant,
}: {
  label: string;
  sublabel: string;
  summary: OnlineImpactSummary | null;
  variant: "bad" | "good" | "goodGsi" | "badOnDemand";
}) {
  return (
    <div className={`${styles.summaryCard} ${variant === "bad" || variant === "badOnDemand" ? styles.summaryCardBad : styles.summaryCardGood}`}>
      <div className={styles.cardHeader}>
        <span className={styles.cardLabel}>{label}</span>
        <span className={styles.cardSublabel}>{sublabel}</span>
      </div>
      {summary ? (
        <div className={styles.cardStats}>
          <div className={styles.cardStat}>
            <span className={styles.cardStatLabel}>Total</span>
            <span className={styles.cardStatValue}>{summary.totalRequests}</span>
          </div>
          <div className={styles.cardStat}>
            <span className={styles.cardStatLabel}>Throttle</span>
            <span className={`${styles.cardStatValue} ${summary.throttleCount > 0 ? styles.danger : ""}`}>
              {summary.throttleCount} ({rate(summary.throttleCount, summary.totalRequests)}%)
            </span>
          </div>
          <div className={styles.cardStat}>
            <span className={styles.cardStatLabel}>Avg</span>
            <span className={styles.cardStatValue}>{summary.avgLatencyMs} ms</span>
          </div>
          <div className={styles.cardStat}>
            <span className={styles.cardStatLabel}>p50</span>
            <span className={styles.cardStatValue}>{summary.p50LatencyMs} ms</span>
          </div>
          <div className={styles.cardStat}>
            <span className={styles.cardStatLabel}>p95</span>
            <span className={styles.cardStatValue}>{summary.p95LatencyMs} ms</span>
          </div>
          <div className={styles.cardStat}>
            <span className={styles.cardStatLabel}>p99</span>
            <span className={styles.cardStatValue}>{summary.p99LatencyMs} ms</span>
          </div>
        </div>
      ) : (
        <div className={styles.cardEmpty}>未実行</div>
      )}
    </div>
  );
}

/** テーブル種別バッジのラベル */
function tableBadgeLabel(table: string): string {
  switch (table) {
    case "bad":
      return "🔥 Bad";
    case "badOnDemand":
      return "🔥 Bad+OnDemand";
    case "goodGsi":
      return "🛡 Good+GSI";
    default:
      return "🛡 Good";
  }
}

/** テーブル種別バッジの CSS クラス（badOnDemand は bad、goodGsi は good と同じスタイル） */
function tableBadgeClass(table: string): string {
  return table === "bad" || table === "badOnDemand"
    ? styles.tableBadgeBad
    : styles.tableBadgeGood;
}

/** パーセント計算（文字列） */
function rate(count: number, total: number): string {
  if (total === 0) return "0.0";
  return ((count / total) * 100).toFixed(1);
}
