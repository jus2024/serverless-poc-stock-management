"use client";

import { useEffect, useState } from "react";
// `@/` エイリアスはテスト実行環境（vitest）では解決されないため、
// コンポーネントテストから読み込めるように相対パスで参照する。
import { getVectorCapabilities, isAbortError } from "../../lib/inventory/vector-api";
import { VECTOR_BACKEND_LABELS } from "../../lib/inventory/vector-overlap";
import type {
  VectorBackendCapabilities,
  VectorCapabilitiesResponse,
  VectorFilterKind,
} from "../../lib/inventory/vector-types";
import styles from "./VectorConstraintTable.module.css";

/**
 * 機能制約比較表
 *
 * `GET /vector-search/capabilities` の応答（= `shared/vector/constraints.ts` の定義）だけを
 * 描画する。TopK 上限・対応フィルタ種別・次元数上限などの**制約値を画面側に一切持たない**
 * （要件 15.6）。本ファイルに置くのは行の見出し文字列と真偽値の言い換え規則のみで、
 * 制約値そのものは常に応答から取り出す。実測で制約が変わった場合はバックエンドの定義を
 * 変えるだけで表が追従する。
 *
 * 検索実行前・実行中・実行後のいずれの状態でも表と注意書きを描画する（要件 15.1 / 15.5）。
 * 制約メタデータの取得前・取得失敗時も行の骨格は保ち、値のセルを「取得中」「取得できません」
 * と表示することで、表が消える状態を作らない。
 *
 * 対応・非対応はすべてテキストで表現し、色・アイコン・記号のみに依存しない（要件 15.8）。
 * 見出しセルは列見出しに `scope="col"`、行見出しに `scope="row"` を与える。
 *
 * 要件: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8
 * 設計: UI コンポーネント / `VectorConstraintTable.tsx`
 */

/** 値を取得できていない状態のセル表示 */
const PLACEHOLDER_LOADING = "取得中";

/** 取得に失敗した状態のセル表示 */
const PLACEHOLDER_ERROR = "取得できません";

/** 範囲フィルタ要求が拒否された行に併記するテキストラベル（色のみに依存しない）（要件 15.7） */
export const RANGE_FILTER_ROW_LABEL = "要求が拒否された制約";

/** 拒否メッセージが応答に含まれない場合の既定文（要件 15.7） */
const RANGE_FILTER_FALLBACK_MESSAGE =
  "DynamoDB 側の実装既定は等価条件のみです。範囲条件を含むフィルタは検索を実行せずに拒否されました。";

/** 真偽値を対応・非対応のテキストに言い換える（要件 15.8） */
function describeSupport(supported: boolean): string {
  return supported ? "対応" : "非対応";
}

/** フィルタ演算子の種別を表示名に言い換える */
function describeFilterKind(kind: VectorFilterKind): string {
  switch (kind) {
    case "equality":
      return "等価条件（=）";
    case "range":
      return "範囲条件（大小比較・BETWEEN）";
    default:
      return String(kind);
  }
}

/** 対応フィルタ種別の一覧をテキストにする。空配列は「なし」と表示する */
function describeFilterKinds(capabilities: VectorBackendCapabilities): string {
  if (capabilities.supportedFilterKinds.length === 0) return "なし";
  return capabilities.supportedFilterKinds.map(describeFilterKind).join("、");
}

/** 範囲条件に対応しているか。応答の対応種別からのみ判定する */
function supportsRangeFilter(capabilities: VectorBackendCapabilities): boolean {
  return capabilities.supportedFilterKinds.indexOf("range") !== -1;
}

/**
 * 比較表の 1 行の定義。
 *
 * `label` は見出しセルの文字列（表示上の語）で、`describe` が応答から値を取り出す。
 * 制約値を定義側に持たないため、応答に無い値は描画されない（Property 53）。
 */
interface ConstraintRowDefinition {
  readonly key: string;
  readonly label: string;
  /** 範囲フィルタ拒否時に強調する行か（要件 15.7） */
  readonly filterRelated?: boolean;
  readonly describe: (capabilities: VectorBackendCapabilities) => string;
  /** セルに併記する補足。応答に該当項目が無ければ undefined を返す */
  readonly note?: (capabilities: VectorBackendCapabilities) => string | undefined;
}

/**
 * 表の行定義（要件 15.1〜15.4）。
 *
 * TopK 上限（15.1）、対応フィルタ種別と未確定の併記（15.2）、距離関数の可変性・
 * オンデマンド課金・次元数上限・`Query` / `Scan` / PartiQL 読み取り可否（15.3）、
 * 範囲フィルタ・全文検索併用・集約・地理空間・ネストクエリ（15.4）を 1 つの表に並べる。
 */
const CONSTRAINT_ROWS: readonly ConstraintRowDefinition[] = [
  {
    key: "maxTopK",
    label: "TopK 上限",
    describe: (c) => (c.maxTopK === null ? "上限なし" : `${c.maxTopK} 件`),
  },
  {
    key: "supportedFilterKinds",
    label: "対応フィルタ種別",
    filterRelated: true,
    describe: describeFilterKinds,
    note: (c) => c.filterKindsUnverified,
  },
  {
    key: "rangeFilter",
    label: "範囲フィルタ（大小比較・BETWEEN）",
    filterRelated: true,
    describe: (c) => describeSupport(supportsRangeFilter(c)),
  },
  {
    key: "maxDimensions",
    label: "ベクトル次元数の上限",
    describe: (c) => `${c.maxDimensions.toLocaleString("ja-JP")} 次元`,
  },
  {
    key: "distanceFunction",
    label: "距離関数",
    describe: (c) => c.distanceFunction,
  },
  {
    key: "distanceFunctionMutable",
    label: "距離関数の変更",
    describe: (c) =>
      c.distanceFunctionMutable
        ? "インデックス再作成なしに変更できる"
        : "インデックス作成時に固定され、インデックス再作成なしには変更できない",
  },
  {
    key: "requiresOnDemandBilling",
    label: "オンデマンド課金",
    describe: (c) => (c.requiresOnDemandBilling ? "前提条件として必須" : "前提条件ではない"),
  },
  {
    key: "readableByQueryScanPartiQL",
    label: "Query / Scan / PartiQL による読み取り",
    describe: (c) => (c.readableByQueryScanPartiQL ? "読み取れる" : "読み取れない"),
  },
  {
    key: "supportsFullTextCombination",
    label: "全文検索との併用",
    describe: (c) => describeSupport(c.supportsFullTextCombination),
  },
  {
    key: "supportsAggregation",
    label: "集約",
    describe: (c) => describeSupport(c.supportsAggregation),
  },
  {
    key: "supportsGeoQuery",
    label: "地理空間クエリ",
    describe: (c) => describeSupport(c.supportsGeoQuery),
  },
  {
    key: "supportsNestedQuery",
    label: "ネストクエリ",
    describe: (c) => describeSupport(c.supportsNestedQuery),
  },
];

export interface VectorConstraintTableProps {
  /**
   * 制約メタデータ。
   *
   * - 省略（`undefined`）: 本コンポーネントがマウント時に `GET /vector-search/capabilities`
   *   を 1 回呼んで自前で保持する
   * - `null`: 呼び出し側が取得中・取得失敗のいずれかである状態。表の骨格のみ描画する
   */
  capabilities?: VectorCapabilitiesResponse | null;
  /** 呼び出し側が制約メタデータの取得に失敗したときの表示文 */
  capabilitiesError?: string | null;
  /** 範囲条件を含むフィルタが DynamoDB 側に対して拒否されたか（要件 15.7） */
  rangeFilterRejected?: boolean;
  /** 拒否時にバックエンドが返した制約メッセージ（要件 15.7） */
  rangeFilterMessage?: string;
}

/**
 * 機能制約比較表コンポーネント
 *
 * 制約値は応答からのみ描画する。`capabilities` を渡さない場合は自前で 1 回取得するため、
 * 検索を 1 度も実行していない状態でも表と注意書きが表示される（要件 15.1 / 15.5）。
 */
export default function VectorConstraintTable({
  capabilities,
  capabilitiesError = null,
  rangeFilterRejected = false,
  rangeFilterMessage,
}: VectorConstraintTableProps) {
  /** 呼び出し側が制約メタデータを管理しているか */
  const isControlled = capabilities !== undefined;

  const [fetched, setFetched] = useState<VectorCapabilitiesResponse | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (isControlled) return;

    const controller = new AbortController();
    let active = true;

    getVectorCapabilities({ signal: controller.signal })
      .then((response) => {
        if (!active) return;
        setFetched(response);
        setFetchError(null);
      })
      .catch((error: unknown) => {
        if (!active || isAbortError(error)) return;
        setFetchError(
          error instanceof Error ? error.message : "機能制約メタデータを取得できませんでした"
        );
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [isControlled]);

  const resolved: VectorCapabilitiesResponse | null = isControlled
    ? (capabilities ?? null)
    : fetched;
  const errorMessage = isControlled ? capabilitiesError : fetchError;
  const placeholder = errorMessage === null ? PLACEHOLDER_LOADING : PLACEHOLDER_ERROR;

  const notice = resolved?.embeddingNotice ?? null;
  const rejectionMessage =
    rangeFilterMessage ?? resolved?.dynamodb.filterKindsUnverified ?? RANGE_FILTER_FALLBACK_MESSAGE;

  return (
    <section className={styles.section} aria-labelledby="vector-constraint-table-heading">
      <h2 id="vector-constraint-table-heading" className={styles.sectionTitle}>
        機能制約の比較
      </h2>

      {/* 取得状態の通知。表の骨格は状態にかかわらず描画し続ける（要件 15.1） */}
      {errorMessage !== null && (
        <p className={styles.status} role="status">
          機能制約メタデータを取得できませんでした: {errorMessage}
        </p>
      )}

      {/* 範囲フィルタ拒否の読み上げ領域（要件 15.7） */}
      <p className={styles.liveRegion} role="status" aria-live="polite">
        {rangeFilterRejected ? `${RANGE_FILTER_ROW_LABEL}: ${rejectionMessage}` : ""}
      </p>

      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <caption className={styles.caption}>
            {VECTOR_BACKEND_LABELS.dynamodb} 側と {VECTOR_BACKEND_LABELS.opensearch}{" "}
            側のベクトル検索の機能制約比較。各項目の対応・非対応はテキストで表しています。
          </caption>
          <thead>
            <tr>
              <th scope="col" className={styles.th}>
                制約項目
              </th>
              <th scope="col" className={styles.th}>
                {VECTOR_BACKEND_LABELS.dynamodb}
              </th>
              <th scope="col" className={styles.th}>
                {VECTOR_BACKEND_LABELS.opensearch}
              </th>
            </tr>
          </thead>
          <tbody>
            {CONSTRAINT_ROWS.map((row) => {
              const highlighted = rangeFilterRejected && row.filterRelated === true;
              const dynamodbNote =
                resolved === null || row.note === undefined
                  ? undefined
                  : row.note(resolved.dynamodb);
              const opensearchNote =
                resolved === null || row.note === undefined
                  ? undefined
                  : row.note(resolved.opensearch);

              return (
                <tr
                  key={row.key}
                  className={highlighted ? `${styles.tr} ${styles.highlightedRow}` : styles.tr}
                >
                  <th scope="row" className={styles.rowHeader}>
                    {row.label}
                    {highlighted && (
                      <span className={styles.rowFlag}>【{RANGE_FILTER_ROW_LABEL}】</span>
                    )}
                  </th>
                  <td className={styles.td}>
                    <span className={styles.value}>
                      {resolved === null ? placeholder : row.describe(resolved.dynamodb)}
                    </span>
                    {dynamodbNote !== undefined && (
                      <span className={styles.note}>{dynamodbNote}</span>
                    )}
                  </td>
                  <td className={styles.td}>
                    <span className={styles.value}>
                      {resolved === null ? placeholder : row.describe(resolved.opensearch)}
                    </span>
                    {opensearchNote !== undefined && (
                      <span className={styles.note}>{opensearchNote}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 範囲フィルタ拒否時の制約メッセージ（表の該当行の強調と対になる説明）（要件 15.7） */}
      {rangeFilterRejected && (
        <p className={styles.rejection}>
          {RANGE_FILTER_ROW_LABEL}: {rejectionMessage}
        </p>
      )}

      {/* 埋め込み言語サポートの注意書き。検索結果の有無に関わらず常時表示する（要件 15.5） */}
      <div className={styles.notice}>
        <h3 className={styles.noticeTitle}>埋め込み言語サポートに関する注意</h3>
        {notice === null ? (
          <p className={styles.noticeItem}>{placeholder}</p>
        ) : (
          <>
            <p className={styles.noticeItem}>
              埋め込みモデル: {notice.model}（正式サポート言語: {notice.officiallySupportedLanguages}）
            </p>
            <p className={styles.noticeItem}>{notice.previewLanguagesNote}</p>
            <p className={styles.noticeItem}>{notice.bilingualMeasurementNote}</p>
            <p className={styles.noticeItem}>{notice.fairnessNote}</p>
            <p className={styles.noticeItem}>測定結果の記録先: {notice.reportPath}</p>
          </>
        )}
      </div>
    </section>
  );
}
