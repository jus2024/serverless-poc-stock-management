"use client";

import styles from "./LatencyBar.module.css";

interface LatencyBarProps {
  /** DynamoDB のレイテンシ (ms)。null の場合はローディング表示 */
  dynamoDbLatency: number | null;
  /** OpenSearch のレイテンシ (ms)。null の場合はローディング表示 */
  opensearchLatency: number | null;
}

/**
 * DynamoDB と OpenSearch のレイテンシを比較するバー表示コンポーネント。
 * 最大値を 100% 幅として、相対的な長さでバーを描画する。
 */
export default function LatencyBar({ dynamoDbLatency, opensearchLatency }: LatencyBarProps) {
  const maxLatency = Math.max(dynamoDbLatency ?? 0, opensearchLatency ?? 0);

  const getWidthPercent = (latency: number | null): number => {
    if (latency === null || maxLatency === 0) return 0;
    return (latency / maxLatency) * 100;
  };

  return (
    <div className={styles.container}>
      <h4 className={styles.title}>レイテンシ比較</h4>

      {/* DynamoDB bar */}
      <div className={styles.barRow}>
        <span className={styles.label}>DynamoDB</span>
        {dynamoDbLatency !== null ? (
          <>
            <div className={styles.barTrack}>
              <div
                className={`${styles.barFill} ${styles.barFillDynamoDB}`}
                style={{ width: `${getWidthPercent(dynamoDbLatency)}%` }}
              />
            </div>
            <span className={styles.value}>{dynamoDbLatency} ms</span>
          </>
        ) : (
          <>
            <div className={styles.skeleton} />
            <span className={styles.valuePlaceholder} />
          </>
        )}
      </div>

      {/* OpenSearch bar */}
      <div className={styles.barRow}>
        <span className={styles.label}>OpenSearch</span>
        {opensearchLatency !== null ? (
          <>
            <div className={styles.barTrack}>
              <div
                className={`${styles.barFill} ${styles.barFillOpenSearch}`}
                style={{ width: `${getWidthPercent(opensearchLatency)}%` }}
              />
            </div>
            <span className={styles.value}>{opensearchLatency} ms</span>
          </>
        ) : (
          <>
            <div className={styles.skeleton} />
            <span className={styles.valuePlaceholder} />
          </>
        )}
      </div>
    </div>
  );
}
