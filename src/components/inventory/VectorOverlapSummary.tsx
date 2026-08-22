"use client";

/**
 * ベクトル検索結果の重なり・順位差サマリー
 *
 * DynamoDB `SearchVectors` と OpenSearch k-NN の 2 つの結果集合について、
 * 共通アイテム数・Jaccard 係数・overlap@k・片側のみの一覧・共通アイテムの順位差と
 * スコア差を表示する。
 *
 * 設計上の約束:
 * - **重なりの計算はこのコンポーネントで行わない。**`vector-overlap.ts` の
 *   `computeVectorOverlap()` の結果をそのまま描画する（純関数側が唯一の算出経路）
 * - 一致 / スコア差ありの識別は**テキストラベル**で行い、色のみに依存しない（要件 12.7）
 * - 倉庫三つ組の注記を、表示行数・一意 SKU 件数・共通アイテム数・各件数の
 *   いずれからも `aria-describedby` で参照できる位置に置く（要件 12.2）
 * - 片側がエラーまたは 0 件のときは「算出不可」と理由を示し、
 *   正常終了した側の結果一覧を破棄せず表示する（要件 12.8）
 *
 * 要件: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8
 * 設計: Frontend Components / VectorOverlapSummary.tsx
 */

import { useId, useMemo } from "react";

// `@/` エイリアスはテスト実行環境（vitest）では解決されないため、
// コンポーネントテストから読み込めるように相対パスで参照する。
import {
  computeVectorOverlap,
  formatDistance,
  formatRatio,
  VECTOR_BACKEND_LABELS,
  type VectorOverlapCommonEntry,
  type VectorOverlapInput,
  type VectorOverlapMetrics,
  type VectorOverlapOnlyEntry,
  type VectorOverlapResult,
  type VectorOverlapSideCounts,
} from "../../lib/inventory/vector-overlap";
import type {
  VectorBackend,
  VectorSearchHit,
} from "../../lib/inventory/vector-types";

import styles from "./VectorOverlapSummary.module.css";

/** 距離基準の不一致を示すテキストラベル（要件 9.12） */
const DISTANCE_BASIS_MISMATCH_LABEL = "距離基準不一致";

export interface VectorOverlapSummaryProps {
  /**
   * 両バックエンドの検索結果。`null` は検索未実行を表す。
   * 重なり指標はこのコンポーネント内で `computeVectorOverlap()` に委譲して算出する
   */
  input: VectorOverlapInput | null;
}

/** 整数を桁区切りで表示する */
function formatCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("ja-JP") : "-";
}

/** 片側の件数 1 行分（要件 12.2） */
function SideCountRow({ counts }: { counts: VectorOverlapSideCounts }) {
  return (
    <tr className={styles.tr}>
      <th scope="row" className={styles.rowHeader}>
        {VECTOR_BACKEND_LABELS[counts.backend]}
      </th>
      <td className={styles.status}>
        {counts.succeeded ? "正常終了" : "エラー終了"}
      </td>
      <td className={styles.number}>{formatCount(counts.rowCount)}</td>
      <td className={styles.number}>{formatCount(counts.distinctSkuCount)}</td>
      <td className={styles.number}>{formatCount(counts.uniqueKeyCount)}</td>
    </tr>
  );
}

/**
 * 表示行数と一意 SKU 件数の対比表（要件 12.2）。
 * 倉庫三つ組の注記を `aria-describedby` で結び付ける
 */
function SideCountsTable({
  dynamodb,
  opensearch,
  noteId,
}: {
  dynamodb: VectorOverlapSideCounts;
  opensearch: VectorOverlapSideCounts;
  noteId: string;
}) {
  return (
    <div
      className={styles.tableWrapper}
      role="region"
      aria-label="バックエンドごとの件数"
      aria-describedby={noteId}
      tabIndex={0}
    >
      <table className={styles.table}>
        <caption className={styles.caption}>
          バックエンドごとの表示行数と一意 SKU 件数
        </caption>
        <thead>
          <tr>
            <th scope="col" className={styles.th}>
              バックエンド
            </th>
            <th scope="col" className={styles.th}>
              検索結果
            </th>
            <th scope="col" className={styles.th}>
              表示行数
            </th>
            <th scope="col" className={styles.th}>
              一意 SKU 件数
            </th>
            <th scope="col" className={styles.th}>
              一意（商品ID, 倉庫ID）件数
            </th>
          </tr>
        </thead>
        <tbody>
          <SideCountRow counts={dynamodb} />
          <SideCountRow counts={opensearch} />
        </tbody>
      </table>
    </div>
  );
}

/** 重なりの度合い（要件 12.1 / 12.3 / 12.4） */
function OverlapMetricsList({
  metrics,
  noteId,
}: {
  metrics: VectorOverlapMetrics;
  noteId: string;
}) {
  const items: readonly { label: string; value: string }[] = [
    { label: "共通アイテム数", value: formatCount(metrics.commonCount) },
    { label: "和集合サイズ", value: formatCount(metrics.unionCount) },
    { label: "Jaccard 係数", value: formatRatio(metrics.jaccard) },
    { label: "overlap@k 比率", value: formatRatio(metrics.overlapAtK) },
    {
      label: `${VECTOR_BACKEND_LABELS.dynamodb} 側のみ`,
      value: formatCount(metrics.dynamodbOnlyCount),
    },
    {
      label: `${VECTOR_BACKEND_LABELS.opensearch} 側のみ`,
      value: formatCount(metrics.opensearchOnlyCount),
    },
  ];

  return (
    <dl className={styles.metrics} aria-describedby={noteId}>
      {items.map((item) => (
        <div className={styles.metric} key={item.label}>
          <dt className={styles.metricLabel}>{item.label}</dt>
          <dd className={styles.metricValue}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 共通アイテムの順位差・スコア差一覧（要件 12.5 / 12.6 / 12.7） */
function CommonEntriesTable({
  entries,
}: {
  entries: readonly VectorOverlapCommonEntry[];
}) {
  if (entries.length === 0) {
    return <p className={styles.empty}>共通アイテムはありません</p>;
  }

  return (
    <div
      className={styles.tableWrapper}
      role="region"
      aria-label="共通アイテムの順位差とスコア差"
      tabIndex={0}
    >
      <table className={styles.table}>
        <caption className={styles.caption}>
          共通アイテム（{VECTOR_BACKEND_LABELS.dynamodb} 側順位の昇順、
          {formatCount(entries.length)} 件）
        </caption>
        <thead>
          <tr>
            <th scope="col" className={styles.th}>
              商品ID
            </th>
            <th scope="col" className={styles.th}>
              倉庫ID
            </th>
            <th scope="col" className={styles.th}>
              {VECTOR_BACKEND_LABELS.dynamodb} 順位
            </th>
            <th scope="col" className={styles.th}>
              {VECTOR_BACKEND_LABELS.opensearch} 順位
            </th>
            <th scope="col" className={styles.th}>
              順位差
            </th>
            <th scope="col" className={styles.th}>
              {VECTOR_BACKEND_LABELS.dynamodb} 距離
            </th>
            <th scope="col" className={styles.th}>
              {VECTOR_BACKEND_LABELS.opensearch} 距離
            </th>
            <th scope="col" className={styles.th}>
              距離差
            </th>
            <th scope="col" className={styles.th}>
              判定
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr
              className={styles.tr}
              key={`${entry.itemId}#${entry.warehouseId}`}
            >
              <td className={`${styles.td} ${styles.mono}`}>{entry.itemId}</td>
              <td className={`${styles.td} ${styles.mono}`}>
                {entry.warehouseId}
              </td>
              <td className={`${styles.td} ${styles.number}`}>
                {formatCount(entry.dynamodbRank)}
              </td>
              <td className={`${styles.td} ${styles.number}`}>
                {formatCount(entry.opensearchRank)}
              </td>
              <td className={`${styles.td} ${styles.number}`}>
                {formatCount(entry.rankDifference)}
              </td>
              <td className={`${styles.td} ${styles.number}`}>
                {formatDistance(entry.dynamodbDistance)}
              </td>
              <td className={`${styles.td} ${styles.number}`}>
                {formatDistance(entry.opensearchDistance)}
              </td>
              <td className={`${styles.td} ${styles.number}`}>
                {formatDistance(entry.distanceDifference)}
              </td>
              <td className={styles.td}>
                {/* 色ではなくテキストで一致 / スコア差ありを区別する（要件 12.7） */}
                <span
                  className={
                    entry.withinTolerance
                      ? `${styles.badge} ${styles.badgeMatch}`
                      : `${styles.badge} ${styles.badgeDiff}`
                  }
                >
                  {entry.toleranceLabel}
                </span>
                {entry.distanceBasisMismatch && (
                  <span className={`${styles.badge} ${styles.badgeWarn}`}>
                    {DISTANCE_BASIS_MISMATCH_LABEL}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 片側のみに含まれるアイテムの一覧（要件 12.4） */
function OnlyEntriesTable({
  backend,
  entries,
}: {
  backend: VectorBackend;
  entries: readonly VectorOverlapOnlyEntry[];
}) {
  const label = VECTOR_BACKEND_LABELS[backend];

  return (
    <div className={styles.onlyBlock}>
      <h4 className={styles.subTitle}>
        {label} 側のみ: {formatCount(entries.length)} 件
      </h4>
      {entries.length === 0 ? (
        <p className={styles.empty}>該当なし</p>
      ) : (
        <div
          className={styles.tableWrapper}
          role="region"
          aria-label={`${label} 側のみに含まれるアイテム`}
          tabIndex={0}
        >
          <table className={styles.table}>
            <caption className={styles.caption}>
              {label} 側のみに含まれるアイテム（順位の昇順）
            </caption>
            <thead>
              <tr>
                <th scope="col" className={styles.th}>
                  商品ID
                </th>
                <th scope="col" className={styles.th}>
                  倉庫ID
                </th>
                <th scope="col" className={styles.th}>
                  バックエンド
                </th>
                <th scope="col" className={styles.th}>
                  順位
                </th>
                <th scope="col" className={styles.th}>
                  距離
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  className={styles.tr}
                  key={`${entry.itemId}#${entry.warehouseId}`}
                >
                  <td className={`${styles.td} ${styles.mono}`}>
                    {entry.itemId}
                  </td>
                  <td className={`${styles.td} ${styles.mono}`}>
                    {entry.warehouseId}
                  </td>
                  <td className={styles.td}>{entry.backendLabel}</td>
                  <td className={`${styles.td} ${styles.number}`}>
                    {formatCount(entry.rank)}
                  </td>
                  <td className={`${styles.td} ${styles.number}`}>
                    {formatDistance(entry.distance)}
                    {entry.distanceBasisMismatch && (
                      <span className={`${styles.badge} ${styles.badgeWarn}`}>
                        {DISTANCE_BASIS_MISMATCH_LABEL}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * 算出不可のときに保持する片側の結果一覧（要件 12.8）。
 * 正常終了した側の一覧を破棄しないことを画面上で保証する
 */
function RetainedHitsTable({
  backend,
  hits,
}: {
  backend: VectorBackend;
  hits: readonly VectorSearchHit[];
}) {
  const label = VECTOR_BACKEND_LABELS[backend];

  if (hits.length === 0) {
    return null;
  }

  return (
    <div className={styles.onlyBlock}>
      <h4 className={styles.subTitle}>
        {label} 側の結果一覧（保持）: {formatCount(hits.length)} 件
      </h4>
      <div
        className={styles.tableWrapper}
        role="region"
        aria-label={`${label} 側の保持された結果一覧`}
        tabIndex={0}
      >
        <table className={styles.table}>
          <caption className={styles.caption}>
            {label} 側の結果一覧（順位の昇順）
          </caption>
          <thead>
            <tr>
              <th scope="col" className={styles.th}>
                順位
              </th>
              <th scope="col" className={styles.th}>
                商品ID
              </th>
              <th scope="col" className={styles.th}>
                倉庫ID
              </th>
              <th scope="col" className={styles.th}>
                商品名
              </th>
              <th scope="col" className={styles.th}>
                距離
              </th>
            </tr>
          </thead>
          <tbody>
            {hits.map((hit) => (
              <tr className={styles.tr} key={`${hit.itemId}#${hit.warehouseId}`}>
                <td className={`${styles.td} ${styles.number}`}>
                  {formatCount(hit.rank)}
                </td>
                <td className={`${styles.td} ${styles.mono}`}>{hit.itemId}</td>
                <td className={`${styles.td} ${styles.mono}`}>
                  {hit.warehouseId}
                </td>
                <td className={styles.td}>{hit.productName}</td>
                <td className={`${styles.td} ${styles.number}`}>
                  {formatDistance(hit.distance)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 算出不可の理由表示（要件 12.8） */
function UncomputableNotice({
  result,
}: {
  result: Extract<VectorOverlapResult, { computable: false }>;
}) {
  return (
    <div className={styles.uncomputable}>
      {/* 算出不可の理由文は純関数が組み立てたものをそのまま表示する（要件 12.8） */}
      <p className={styles.uncomputableTitle}>{result.reason}</p>
      {/* 原因の内訳。理由文と重複しないよう種別とエラーコードのみを構造化して示す */}
      <ul className={styles.blockerList}>
        {result.blockers.map((blocker) => (
          <li className={styles.blockerItem} key={blocker.backend}>
            {VECTOR_BACKEND_LABELS[blocker.backend]}:{" "}
            {blocker.cause === "ERROR" ? "エラー発生" : "結果 0 件"}
            {blocker.errorCode === undefined
              ? ""
              : `（エラーコード ${blocker.errorCode}）`}
          </li>
        ))}
      </ul>
      <p className={styles.uncomputableDetail}>
        共通アイテム数・Jaccard 係数・overlap@k・順位差はいずれも算出不可。
        正常終了した側の結果一覧は保持している。
      </p>
    </div>
  );
}

/**
 * 重なり・順位差サマリー
 *
 * `input` が `null` のあいだは未実行の案内のみを表示する。
 * 両検索が正常終了して結果が 1 件以上ある場合のみ重なり指標を表示し、
 * それ以外は算出不可とその理由を表示する（要件 12.8）。
 */
export default function VectorOverlapSummary({
  input,
}: VectorOverlapSummaryProps) {
  const noteId = useId();

  const result = useMemo<VectorOverlapResult | null>(
    () => (input === null ? null : computeVectorOverlap(input)),
    [input]
  );

  return (
    <section className={styles.container} aria-labelledby={`${noteId}-title`}>
      <h3 className={styles.title} id={`${noteId}-title`}>
        結果の重なりと順位差
      </h3>

      <div className={styles.body} aria-live="polite">
        {result === null ? (
          <p className={styles.empty}>
            検索を実行すると、両バックエンドの結果の重なりと順位差を表示します
          </p>
        ) : (
          <>
            <SideCountsTable
              dynamodb={result.dynamodb}
              opensearch={result.opensearch}
              noteId={noteId}
            />

            {/* 倉庫三つ組の注記（要件 12.2）。件数表と指標の両方から参照される */}
            <p className={styles.note} id={noteId}>
              {result.warehouseTripletNote}
            </p>

            {result.computable ? (
              <>
                <OverlapMetricsList
                  metrics={result.metrics}
                  noteId={noteId}
                />
                <CommonEntriesTable entries={result.common} />
                <OnlyEntriesTable
                  backend="dynamodb"
                  entries={result.dynamodbOnly}
                />
                <OnlyEntriesTable
                  backend="opensearch"
                  entries={result.opensearchOnly}
                />
              </>
            ) : (
              <>
                <UncomputableNotice result={result} />
                <RetainedHitsTable
                  backend="dynamodb"
                  hits={result.retained.dynamodb}
                />
                <RetainedHitsTable
                  backend="opensearch"
                  hits={result.retained.opensearch}
                />
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
