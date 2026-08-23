"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
// `@/` エイリアスはテスト実行環境（vitest）では解決されないため、
// コンポーネントテストから読み込めるように相対パスで参照する。
import { formatDistance, VECTOR_BACKEND_LABELS } from "../../lib/inventory/vector-overlap";
import type {
  VectorBackend,
  VectorErrorResponse,
  VectorLanguage,
  VectorSearchHit,
} from "../../lib/inventory/vector-types";
import styles from "./VectorComparisonPanel.module.css";

/**
 * ベクトル検索比較パネル
 *
 * 左に DynamoDB Vector Search、右に OpenSearch k-NN の結果を並べる表示専用コンポーネント。
 * 状態は持たず（経過秒数のティックのみ内部で進める）、`VectorSearchComparisonView` が
 * 2 本の独立した非同期処理の結果をそれぞれ `dynamodbState` / `opensearchState` として渡す。
 *
 * 設計上の約束:
 * - **各パネルは自身の state のみから描画する**。片側のエラー・タイムアウトが他方の結果表示と
 *   レイテンシ表示を消さない（要件 11.22 / 11.23、Property 31）。そのため両パネルを 1 つの
 *   `props` オブジェクトに畳まず、独立した 2 つの state として受け取る
 * - 各パネルは `<section>` + `<h3>` の見出し付き領域とし、結果一覧はスクロール可能な
 *   `tabIndex={0}` の領域に置いてキーボード操作のみで到達できる（要件 11.18）
 * - 結果・エラー・レイテンシの更新は各パネルの `aria-live="polite"` 領域に**テキストとして**
 *   要約を出すことで通知する（要件 11.19）。数値チップだけでは読み上げ対象にならない
 * - 768px 以下は 1 カラムに切り替わる。DOM 順が DynamoDB → OpenSearch なので、縦並びでは
 *   DynamoDB が上、OpenSearch が下になる（要件 11.20）
 * - 「未実行」と「0 件」を区別する。`returnedCount === null` を未実行とみなす。埋め込み生成が
 *   失敗した場合に両パネルを未実行へ戻す経路（要件 16.8）を表現するため
 *
 * 要件: 11.14, 11.15, 11.18, 11.19, 11.20, 11.21, 11.22, 11.23
 * 設計: UI コンポーネント / Property 31, 57
 */

// ============================================================
// パネル 1 つ分の状態
// ============================================================

/**
 * パネル 1 つ分の表示状態。
 *
 * `VectorSearchComparisonView` が検索応答（`DynamoDBVectorSearchResponse` /
 * `OpenSearchVectorSearchResponse`）とエラー（`VectorApiError`）を、この 1 形式へ寄せて渡す。
 * 両バックエンドで同一の形にすることで、パネルの描画ロジックが片側だけ分岐しない。
 */
export interface VectorPanelState {
  backend: VectorBackend;
  /** 検索リクエストが実行中か */
  loading: boolean;
  /** 検索結果。未実行・エラー時は空配列 */
  hits: VectorSearchHit[];
  /**
   * 応答の `returnedCount`。**未実行のときは null**。
   * 0 件（検索は成功したが該当なし）と未実行を区別する
   */
  returnedCount: number | null;
  /** 応答の `distinctSkuCount`（倉庫三つ組の読み違い防止、要件 12.2 の併記に使う） */
  distinctSkuCount: number | null;
  /** 検索レイテンシ（ms）。表示は整数に丸める（要件 11.15） */
  searchLatencyMs: number | null;
  /** 検索に使用した言語。応答のエコー値（要件 11.15） */
  language: VectorLanguage | null;
  /** 当該パネルのエラー。他方のパネルには影響しない（要件 11.22） */
  error: VectorErrorResponse | null;
  /** リクエスト開始時刻（`Date.now()`）。ローディング中の経過秒数表示に使う（要件 11.21） */
  startedAt: number | null;
  /**
   * 補足注記（`NO_DOCUMENTS`、フィルタ 0 件の診断、近傍不足の注記など）。
   * エラーではないため結果表示を消さない
   */
  notes?: string[];
}

interface VectorComparisonPanelProps {
  /** 左パネル（縦並び時は上） */
  dynamodbState: VectorPanelState;
  /** 右パネル（縦並び時は下） */
  opensearchState: VectorPanelState;
  /**
   * DynamoDB パネル内に差し込む追加表示。
   * 機能制約メッセージ（範囲フィルタ非対応など）を DynamoDB パネル内に出す用途（要件 15.7）。
   * 読み上げ領域の中に配置されるため、追加時にスクリーンリーダーへ通知される
   */
  dynamodbNotice?: ReactNode;
}

/** 空の（未実行）パネル状態を作る */
export function createEmptyVectorPanelState(backend: VectorBackend): VectorPanelState {
  return {
    backend,
    loading: false,
    hits: [],
    returnedCount: null,
    distinctSkuCount: null,
    searchLatencyMs: null,
    language: null,
    error: null,
    startedAt: null,
  };
}

// ============================================================
// 表示用の整形
// ============================================================

/**
 * パネル見出しの文言（要件 11.14）。
 *
 * バックエンド名は `vector-overlap.ts` の `VECTOR_BACKEND_LABELS` を単一の出典とし、
 * 要件 11.14 が指定する検索方式の接尾辞（`Vector Search` / `k-NN`）だけをここで足す。
 * 表示名を各コンポーネントで別々に定義すると重なり表示との文言差が生まれるため。
 */
const PANEL_HEADING: Record<VectorBackend, string> = {
  dynamodb: `${VECTOR_BACKEND_LABELS.dynamodb} Vector Search`,
  opensearch: `${VECTOR_BACKEND_LABELS.opensearch} k-NN`,
};

const LANGUAGE_LABEL: Record<VectorLanguage, string> = {
  ja: "日本語",
  en: "English",
};

/** ms 単位の整数として表示する（要件 11.15） */
function formatLatency(latencyMs: number): string {
  return `${Math.round(latencyMs)} ms`;
}

/** 生スコアは桁数がバックエンドで異なるため小数第 6 位まで */
function formatRawScore(rawScore: number): string {
  return rawScore.toFixed(6);
}

function formatPrice(unitPrice: number): string {
  return `¥${unitPrice.toLocaleString("ja-JP")}`;
}

/** 経過秒数（1 秒未満は 0 秒） */
function elapsedSeconds(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/**
 * 読み上げ用の 1 行要約を組み立てる（要件 11.19）。
 *
 * 結果件数・レイテンシ・使用言語・エラーをテキストに含めることで、
 * 更新時に `aria-live` 領域の内容が変化し通知される。
 */
function buildLiveSummary(state: VectorPanelState, elapsed: number | null): string {
  const label = PANEL_HEADING[state.backend];

  if (state.loading) {
    return elapsed === null
      ? `${label}: 検索中です`
      : `${label}: 検索中です（経過 ${elapsed} 秒）`;
  }

  if (state.error) {
    const retry = state.error.retryable ? "再試行可" : "再試行不可";
    return `${label}: エラー ${state.error.errorCode}（${retry}）。${state.error.message}`;
  }

  if (state.returnedCount === null) {
    return `${label}: 未実行です`;
  }

  const parts = [`${state.returnedCount} 件`];
  if (state.distinctSkuCount !== null) {
    parts.push(`一意 SKU ${state.distinctSkuCount} 件`);
  }
  if (state.searchLatencyMs !== null) {
    parts.push(`検索レイテンシ ${formatLatency(state.searchLatencyMs)}`);
  }
  if (state.language !== null) {
    parts.push(`検索言語 ${LANGUAGE_LABEL[state.language]}`);
  }
  return `${label}: ${parts.join("、")}`;
}

// ============================================================
// 経過秒数
// ============================================================

/**
 * ローディング中の経過秒数を 1 秒間隔で進める（要件 11.21）。
 *
 * 非ローディング時と `startedAt` 未設定時はタイマーを張らず null を返す。
 */
function useElapsedSeconds(loading: boolean, startedAt: number | null): number | null {
  const [elapsed, setElapsed] = useState<number | null>(null);

  useEffect(() => {
    if (!loading || startedAt === null) {
      setElapsed(null);
      return;
    }

    setElapsed(elapsedSeconds(startedAt, Date.now()));
    const timerId = setInterval(() => {
      setElapsed(elapsedSeconds(startedAt, Date.now()));
    }, 1000);

    return () => clearInterval(timerId);
  }, [loading, startedAt]);

  return elapsed;
}

// ============================================================
// 内部コンポーネント
// ============================================================

/** メタ情報チップ列（レイテンシ・件数・使用言語）。要約は読み上げ領域が担う */
function PanelMeta({ state }: { state: VectorPanelState }) {
  if (state.returnedCount === null) {
    return null;
  }

  return (
    <dl className={styles.metaList}>
      <div className={styles.metaEntry}>
        <dt className={styles.metaTerm}>検索レイテンシ</dt>
        <dd className={styles.metaValue}>
          {state.searchLatencyMs === null ? "—" : formatLatency(state.searchLatencyMs)}
        </dd>
      </div>
      <div className={styles.metaEntry}>
        <dt className={styles.metaTerm}>結果件数</dt>
        <dd className={styles.metaValue}>{state.returnedCount} 件</dd>
      </div>
      {state.distinctSkuCount !== null && (
        <div className={styles.metaEntry}>
          <dt className={styles.metaTerm}>一意 SKU 件数</dt>
          <dd className={styles.metaValue}>{state.distinctSkuCount} 件</dd>
        </div>
      )}
      <div className={styles.metaEntry}>
        <dt className={styles.metaTerm}>検索言語</dt>
        <dd className={styles.metaValue}>
          {state.language === null ? "—" : LANGUAGE_LABEL[state.language]}
        </dd>
      </div>
    </dl>
  );
}

/** 結果テーブル。全件・全スコアを描画する（Property 57） */
function HitTable({ hits, captionId }: { hits: VectorSearchHit[]; captionId: string }) {
  return (
    <div
      className={styles.tableWrapper}
      tabIndex={0}
      role="group"
      aria-labelledby={captionId}
    >
      <table className={styles.table}>
        <caption id={captionId} className={styles.caption}>
          検索結果 {hits.length} 件（正規化距離の昇順。値が小さいほど類似）
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
              正規化距離
            </th>
            <th scope="col" className={styles.th}>
              生スコア
            </th>
            <th scope="col" className={styles.th}>
              数量
            </th>
            <th scope="col" className={styles.th}>
              ロケーション
            </th>
            <th scope="col" className={styles.th}>
              単価
            </th>
          </tr>
        </thead>
        <tbody>
          {hits.map((hit) => (
            <tr key={`${hit.itemId}-${hit.warehouseId}-${hit.rank}`} className={styles.tr}>
              <th scope="row" className={`${styles.td} ${styles.rank}`}>
                {hit.rank}
              </th>
              <td className={`${styles.td} ${styles.mono}`}>{hit.itemId}</td>
              <td className={`${styles.td} ${styles.mono}`}>{hit.warehouseId}</td>
              <td className={styles.td}>{hit.productName}</td>
              <td className={`${styles.td} ${styles.number}`}>
                {formatDistance(hit.distance)}
                {hit.distanceBasisMismatch === true && (
                  <span className={styles.mismatch}>（距離基準の不一致）</span>
                )}
              </td>
              <td className={`${styles.td} ${styles.number}`}>{formatRawScore(hit.rawScore)}</td>
              <td className={`${styles.td} ${styles.number}`}>{hit.quantity}</td>
              <td className={`${styles.td} ${styles.mono}`}>{hit.location}</td>
              <td className={`${styles.td} ${styles.number}`}>{formatPrice(hit.unitPrice)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * パネル 1 つ分。
 *
 * 描画は引数の `state` のみに依存し、他方のパネルの状態を参照しない（Property 31）。
 */
function SinglePanel({
  state,
  notice,
}: {
  state: VectorPanelState;
  notice?: ReactNode;
}) {
  const headingId = useId();
  const captionId = useId();
  const elapsed = useElapsedSeconds(state.loading, state.startedAt);

  const hasResult = state.returnedCount !== null;

  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.panelHeading}>
        {PANEL_HEADING[state.backend]}
      </h3>

      <PanelMeta state={state} />

      {/* 結果・エラー・レイテンシの更新通知（要件 11.19 / 15.7） */}
      <div className={styles.live} aria-live="polite">
        <p className={styles.liveText}>{buildLiveSummary(state, elapsed)}</p>
        {notice}
      </div>

      {state.loading && (
        <div className={styles.loading}>
          <span className={styles.spinner} aria-hidden="true" />
          <span>
            検索中
            {elapsed !== null && `（経過 ${elapsed} 秒）`}
          </span>
        </div>
      )}

      {state.error && (
        <div className={styles.error}>
          <p className={styles.errorHead}>
            検索に失敗しました（{state.error.errorCode} /{" "}
            {state.error.retryable ? "再試行可" : "再試行不可"}）
          </p>
          <p className={styles.errorBody}>{state.error.message}</p>
          {state.error.retryable && state.error.retryAfterSeconds !== undefined && (
            <p className={styles.errorBody}>
              推奨待機時間: {state.error.retryAfterSeconds} 秒
            </p>
          )}
        </div>
      )}

      {state.notes !== undefined &&
        state.notes.length > 0 && (
          <ul className={styles.notes}>
            {state.notes.map((note) => (
              <li key={note} className={styles.note}>
                {note}
              </li>
            ))}
          </ul>
        )}

      {/* エラーは結果表示を消さない。片側のエラーが他方に及ばないのと同じ理由で、
          当該パネル内でも取得済みの結果は保持する */}
      {state.hits.length > 0 && <HitTable hits={state.hits} captionId={captionId} />}

      {!state.loading && state.hits.length === 0 && (
        <p className={styles.empty}>
          {state.error !== null
            ? "結果はありません"
            : hasResult
              ? "一致するアイテムがありませんでした（0 件）"
              : "未実行です。検索を実行してください"}
        </p>
      )}
    </section>
  );
}

// ============================================================
// 公開コンポーネント
// ============================================================

/**
 * DynamoDB Vector Search と OpenSearch k-NN の結果を左右に並べて比較表示する。
 * 768px 以下では縦並び（DynamoDB を上、OpenSearch を下）に切り替わる。
 */
export default function VectorComparisonPanel({
  dynamodbState,
  opensearchState,
  dynamodbNotice,
}: VectorComparisonPanelProps) {
  return (
    <div className={styles.container}>
      <SinglePanel state={dynamodbState} notice={dynamodbNotice} />
      <SinglePanel state={opensearchState} />
    </div>
  );
}
