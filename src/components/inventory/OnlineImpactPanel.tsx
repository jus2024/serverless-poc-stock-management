"use client";

import { useState } from "react";
import { runOnlineImpactTest } from "@/src/lib/inventory/api";
import type {
  Table,
  Warehouse,
  OnlineImpactTestParams,
  OnlineImpactTestResponse,
  OnlineImpactSummary,
  OnlineImpactRoundSummary,
} from "@/src/lib/inventory/types";
import styles from "./OnlineImpactPanel.module.css";

/**
 * 画面（API Gateway REST API 経由）から実行できる合計測定秒数の上限。
 * API Gateway REST API の統合タイムアウト上限 29 秒に対する安全マージンとして 25 秒とする。
 * これを超えると Lambda の処理完了前にクライアントへ 504 が返る。
 */
const MAX_TOTAL_SECONDS_VIA_API = 25;

interface OnlineImpactPanelProps {
  onResult?: (result: OnlineImpactTestResponse) => void;
}

/**
 * オンライン影響テストパネル
 *
 * 負荷がかかっている最中にオンライン操作（連続出庫）を実行し、
 * bad / good / goodGsi / badOnDemand の 4 パターンで
 * レイテンシ・スロットル率を比較する。
 *
 * 使い方:
 * 1. 「負荷テスト」タブで対象テーブルに負荷をかける
 * 2. 負荷実行中にこのパネルを 1 回起動する。ラウンド数を指定すれば
 *    1 クリックで連続測定できる（画面からは合計 25 秒以内）
 *    より長い測定が必要な場合は Lambda を直接 Invoke する（API Gateway を迂回）
 * 3. bad / good / goodGsi / badOnDemand の 4 パターンすべてで実行する
 * 4. 「結果ダッシュボード」タブで比較する
 *
 * 注意: split-for-heat により時間経過でスロットルが自然回復するため、
 * ラウンドごとのスロットル率でその推移を確認する。
 */
export default function OnlineImpactPanel({ onResult }: OnlineImpactPanelProps) {
  // Form state
  const [table, setTable] = useState<Table>("bad");
  const [requestsPerSecond, setRequestsPerSecond] = useState(10);
  const [durationSeconds, setDurationSeconds] = useState(10);
  // 継続 10 秒 × 2 ラウンド = 20 秒。API Gateway の 29 秒上限に収まる範囲で初期値 2 ラウンド
  const [iterations, setIterations] = useState(2);
  const [warehouseId, setWarehouseId] = useState<Warehouse>("WH-TOKYO");
  const [noRetry, setNoRetry] = useState(true);

  // Execution state
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<OnlineImpactTestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 合計測定秒数。API Gateway の統合タイムアウトを超える組み合わせは実行不可
  const totalSeconds = iterations * durationSeconds;
  const exceedsLimit = totalSeconds > MAX_TOTAL_SECONDS_VIA_API;

  const handleStart = async () => {
    setError(null);
    setResult(null);
    setRunning(true);

    const params: OnlineImpactTestParams = {
      table,
      requestsPerSecond,
      durationSeconds,
      iterations,
      warehouseId,
      noRetry,
    };

    try {
      const res = await runOnlineImpactTest(params);
      setResult(res);
      onResult?.(res);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "message" in err) {
        setError((err as { message: string }).message);
      } else {
        setError("オンライン影響テストの実行に失敗しました");
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <h3 className={styles.panelTitle}>🔍 オンライン影響テスト</h3>
        <p className={styles.panelDescription}>
          バースト枯渇後に連続出庫リクエストを実行し、ホットスポットがオンライン操作に与える影響を測定します。
          SDKリトライ無効のため、スロットリングが即エラーとして記録されます。
        </p>
      </div>

      {/* 設定フォーム */}
      <div className={`card ${styles.form}`}>
        {/* テーブル選択 */}
        <div className={styles.fieldGroup}>
          <span className={styles.fieldLabel}>テーブル選択</span>
          <div className={styles.radioGroup}>
            <label className={styles.radioLabel}>
              <input
                type="radio"
                name="impact-table"
                value="bad"
                checked={table === "bad"}
                onChange={() => setTable("bad")}
                disabled={running}
              />
              Bad Table（PK=warehouseId / プロビジョンド）
            </label>
            <label className={styles.radioLabel}>
              <input
                type="radio"
                name="impact-table"
                value="good"
                checked={table === "good"}
                onChange={() => setTable("good")}
                disabled={running}
              />
              Good Table（PK=itemId / GSI なし）
            </label>
            <label className={styles.radioLabel}>
              <input
                type="radio"
                name="impact-table"
                value="goodGsi"
                checked={table === "goodGsi"}
                onChange={() => setTable("goodGsi")}
                disabled={running}
              />
              Good + GSI Table（PK=itemId / GSI 3本）
            </label>
            <label className={styles.radioLabel}>
              <input
                type="radio"
                name="impact-table"
                value="badOnDemand"
                checked={table === "badOnDemand"}
                onChange={() => setTable("badOnDemand")}
                disabled={running}
              />
              Bad + OnDemand Table（PK=warehouseId / オンデマンド）
            </label>
          </div>
        </div>

        {/* 倉庫選択 */}
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel} htmlFor="impact-warehouse">
            倉庫（ホットパーティション対象）
          </label>
          <select
            id="impact-warehouse"
            className="input"
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value as Warehouse)}
            disabled={running}
          >
            <option value="WH-TOKYO">WH-TOKYO（ホットスポット）</option>
            <option value="WH-OSAKA">WH-OSAKA</option>
            <option value="WH-FUKUOKA">WH-FUKUOKA</option>
          </select>
        </div>

        {/* リクエスト/秒 */}
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel} htmlFor="impact-rps">
            リクエスト/秒
          </label>
          <input
            id="impact-rps"
            type="number"
            className={`input ${styles.numberInput}`}
            value={requestsPerSecond}
            onChange={(e) =>
              setRequestsPerSecond(Math.min(200, Math.max(1, Number(e.target.value))))
            }
            min={1}
            max={200}
            disabled={running}
          />
          <span className={styles.hint}>1〜200 req/s（オンライン操作想定）</span>
        </div>

        {/* 継続秒数 */}
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel} htmlFor="impact-duration">
            継続秒数
          </label>
          <input
            id="impact-duration"
            type="number"
            className={`input ${styles.numberInput}`}
            value={durationSeconds}
            onChange={(e) =>
              setDurationSeconds(Math.min(60, Math.max(1, Number(e.target.value))))
            }
            min={1}
            max={60}
            disabled={running}
          />
          <span className={styles.hint}>1〜60 秒</span>
        </div>

        {/* ラウンド数 */}
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel} htmlFor="impact-iterations">
            ラウンド数
          </label>
          <input
            id="impact-iterations"
            type="number"
            className={`input ${styles.numberInput}`}
            value={iterations}
            onChange={(e) =>
              setIterations(Math.min(12, Math.max(1, Number(e.target.value))))
            }
            min={1}
            max={12}
            disabled={running}
          />
          <span className={styles.hint}>
            1〜12 ラウンド。1 回の起動で連続測定します。画面からは合計{" "}
            {MAX_TOTAL_SECONDS_VIA_API} 秒以内（API Gateway の 29 秒制限）
          </span>
          {exceedsLimit && (
            <span className={`${styles.hint} ${styles.danger}`}>
              ⚠️ 合計 {totalSeconds} 秒は API Gateway の上限（29
              秒）を超えるため 504 になります。ラウンド数か継続秒数を減らしてください
            </span>
          )}
        </div>

        {/* リトライモード */}
        <div className={styles.fieldGroup}>
          <span className={styles.fieldLabel}>SDKリトライ</span>
          <div className={styles.radioGroup}>
            <label className={styles.radioLabel}>
              <input
                type="radio"
                name="impact-retry"
                value="noRetry"
                checked={noRetry === true}
                onChange={() => setNoRetry(true)}
                disabled={running}
              />
              無効（スロットリング即エラー）
            </label>
            <label className={styles.radioLabel}>
              <input
                type="radio"
                name="impact-retry"
                value="withRetry"
                checked={noRetry === false}
                onChange={() => setNoRetry(false)}
                disabled={running}
              />
              有効（SDK デフォルト 3 回リトライ）
            </label>
          </div>
        </div>

        {/* 実行ボタン */}
        <button
          className={`btn-primary ${styles.startButton}`}
          onClick={handleStart}
          disabled={running || exceedsLimit}
        >
          {running ? "測定中..." : "オンライン影響テスト実行"}
        </button>

        {running && (
          <p className={styles.runningHint}>
            ⏳ 同期実行中... 約 {totalSeconds} 秒かかります（{durationSeconds} 秒 ×{" "}
            {iterations} ラウンド）
          </p>
        )}
      </div>

      {/* エラー表示 */}
      {error && (
        <div className="alert-error">
          <span className={styles.errorMessage}>{error}</span>
        </div>
      )}

      {/* 結果表示 */}
      {result && (
        <OnlineImpactResult
          summary={result.summary}
          rounds={result.rounds}
          requests={result.requests}
        />
      )}
    </div>
  );
}

/** ISO8601 文字列を HH:MM:SS（ローカル時刻）に整形 */
function formatClockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 結果表示コンポーネント */
function OnlineImpactResult({
  summary,
  rounds,
  requests,
}: {
  summary: OnlineImpactSummary;
  rounds: OnlineImpactRoundSummary[];
  requests: OnlineImpactTestResponse["requests"];
}) {
  const throttleRate =
    summary.totalRequests > 0
      ? ((summary.throttleCount / summary.totalRequests) * 100).toFixed(1)
      : "0.0";

  const successRate =
    summary.totalRequests > 0
      ? ((summary.successCount / summary.totalRequests) * 100).toFixed(1)
      : "0.0";

  // 秒ごとのスロットル数を集計
  const secondBuckets: Record<number, { success: number; throttled: number; error: number }> = {};
  for (const req of requests) {
    if (!secondBuckets[req.second]) {
      secondBuckets[req.second] = { success: 0, throttled: 0, error: 0 };
    }
    secondBuckets[req.second][req.status === "error" ? "error" : req.status]++;
  }

  return (
    <div className={styles.resultCard}>
      {/* サマリー */}
      <div className={styles.resultHeader}>
        <span className={styles.resultTitle}>測定結果</span>
        <span
          className={`badge ${
            summary.throttleCount > 0 ? "badge-failed" : "badge-completed"
          }`}
        >
          {summary.throttleCount > 0 ? "⚠️ スロットリング検出" : "✅ 正常"}
        </span>
      </div>

      <div className={styles.summaryGrid}>
        <div className={styles.summaryItem}>
          <span className={styles.summaryLabel}>総リクエスト</span>
          <span className={styles.summaryValue}>{summary.totalRequests}</span>
        </div>
        <div className={styles.summaryItem}>
          <span className={styles.summaryLabel}>成功</span>
          <span className={styles.summaryValue}>
            {summary.successCount} ({successRate}%)
          </span>
        </div>
        <div className={styles.summaryItem}>
          <span className={styles.summaryLabel}>スロットル</span>
          <span className={`${styles.summaryValue} ${summary.throttleCount > 0 ? styles.danger : ""}`}>
            {summary.throttleCount} ({throttleRate}%)
          </span>
        </div>
        <div className={styles.summaryItem}>
          <span className={styles.summaryLabel}>エラー</span>
          <span className={styles.summaryValue}>{summary.errorCount}</span>
        </div>
      </div>

      {/* レイテンシ */}
      <div className={styles.latencySection}>
        <h4 className={styles.latencyTitle}>レイテンシ分布</h4>
        <div className={styles.latencyGrid}>
          <div className={styles.latencyItem}>
            <span className={styles.latencyLabel}>Avg</span>
            <span className={styles.latencyValue}>{summary.avgLatencyMs} ms</span>
          </div>
          <div className={styles.latencyItem}>
            <span className={styles.latencyLabel}>p50</span>
            <span className={styles.latencyValue}>{summary.p50LatencyMs} ms</span>
          </div>
          <div className={styles.latencyItem}>
            <span className={styles.latencyLabel}>p95</span>
            <span className={styles.latencyValue}>{summary.p95LatencyMs} ms</span>
          </div>
          <div className={styles.latencyItem}>
            <span className={styles.latencyLabel}>p99</span>
            <span className={styles.latencyValue}>{summary.p99LatencyMs} ms</span>
          </div>
          <div className={styles.latencyItem}>
            <span className={styles.latencyLabel}>成功 Avg</span>
            <span className={styles.latencyValue}>{summary.successAvgLatencyMs} ms</span>
          </div>
          <div className={styles.latencyItem}>
            <span className={styles.latencyLabel}>Throttle Avg</span>
            <span className={`${styles.latencyValue} ${summary.throttledAvgLatencyMs > 0 ? styles.danger : ""}`}>
              {summary.throttledAvgLatencyMs} ms
            </span>
          </div>
        </div>
      </div>

      {/* ラウンド別スロットル率（複数ラウンド時のみ） */}
      {rounds.length > 1 && (
        <div className={styles.breakdownSection}>
          <h4 className={styles.breakdownTitle}>ラウンド別スロットル率</h4>
          <div className={styles.tableWrapper}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>ラウンド</th>
                  <th>開始時刻</th>
                  <th>成功</th>
                  <th>スロットル</th>
                  <th>スロットル率</th>
                  <th>p95</th>
                </tr>
              </thead>
              <tbody>
                {rounds.map((r) => (
                  <tr key={r.round} className={r.throttleRate > 0 ? styles.danger : ""}>
                    <td>{r.round + 1}</td>
                    <td>{formatClockTime(r.startedAt)}</td>
                    <td>{r.successCount}</td>
                    <td>{r.throttleCount}</td>
                    <td>{r.throttleRate.toFixed(1)}%</td>
                    <td>{r.p95LatencyMs} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 秒別ブレークダウン（単一ラウンド時のみ） */}
      {rounds.length === 1 && (
        <div className={styles.breakdownSection}>
          <h4 className={styles.breakdownTitle}>秒別ブレークダウン</h4>
          <div className={styles.tableWrapper}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>秒</th>
                  <th>成功</th>
                  <th>スロットル</th>
                  <th>エラー</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(secondBuckets)
                  .sort(([a], [b]) => Number(a) - Number(b))
                  .map(([sec, counts]) => (
                    <tr key={sec}>
                      <td>{Number(sec) + 1}s</td>
                      <td>{counts.success}</td>
                      <td className={counts.throttled > 0 ? styles.danger : ""}>
                        {counts.throttled}
                      </td>
                      <td>{counts.error}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
