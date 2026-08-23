"use client";

/**
 * ベクトル検索比較ビュー
 *
 * `VectorSearchForm` / `VectorComparisonPanel` / `VectorOverlapSummary` /
 * `VectorConstraintTable` / `LatencyBar` を束ね、検索の状態を保持する唯一の場所。
 * 子コンポーネントはいずれも表示専用（`VectorConstraintTable` の制約メタデータ自己取得のみ例外）で、
 * API 呼び出しの開始・中断・応答の採否はすべて本コンポーネントが決める。
 *
 * 状態の持ち方（Property 31 を構造で保証する）:
 * - **両パネルの state を 1 つのオブジェクトに畳まず、独立した 2 つの `useState` として持つ。**
 *   検索の 2 本は `Promise.allSettled` で束ねず独立した非同期処理として走り、各々の完了ハンドラは
 *   自分側の setter だけを呼ぶ。片側のエラー・タイムアウトが他方の結果・レイテンシ表示を消す経路が
 *   コード上に存在しない（要件 11.12 / 11.22 / 11.23）
 * - 両パネルを同時に書き換えるのは「検索開始時のリセット」と「埋め込み生成失敗時の未実行復帰」の
 *   2 箇所のみ。どちらも**片側の検索結果に由来しない**同期的な操作であり、Property 31 の
 *   「各パネルは自身のリクエスト結果のみで決まる」に反しない
 * - 埋め込み生成の状態は判別可能な合併型で持つ。レイテンシが存在しない状態でレイテンシを
 *   描画する分岐を型で作らせない（要件 11.16 / 16.8）
 *
 * 検索の流れ:
 * 1. `POST /vector-search/embed` を **1 回だけ** 呼ぶ（要件 11.11）。言語はこの 1 回にのみ渡る
 * 2. 得た `queryId` と TopK だけを 2 つの検索エンドポイントへ渡す。リクエストが言語やベクトルを
 *    持たないため、片側だけ言語が変わることが構造的に起こらない（要件 11.4）
 * 3. 2 本を同時に開始し、完了した側から個別に `setState` する（要件 11.12）
 * 4. 埋め込み生成が失敗した場合は検索エンドポイントを呼ばず、両パネルを未実行へ戻す（要件 16.8）
 *
 * 古い応答の破棄は `AbortController`（側ごとに 1 つ）と単調増加する `requestSeq` の二重化で行う。
 * 中断由来の失敗は「捨てた応答」であってエラーではないため、パネルのエラー表示に昇格させない（要件 11.13）。
 *
 * 要件: 11.4, 11.6, 11.11, 11.12, 11.13, 11.16, 11.17, 11.22, 11.23, 16.8
 * 設計: UI コンポーネント / Property 30, 31, 32
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

// `@/` エイリアスはテスト実行環境（vitest）では解決されないため、
// コンポーネントテストから読み込めるように実行時 import は相対パスで参照する。
import {
  embedVectorQuery,
  isAbortError,
  isVectorApiError,
  searchVectorDynamoDB,
  searchVectorOpenSearch,
  type VectorRequestOptions,
} from "../../lib/inventory/vector-api";
import {
  VECTOR_BACKEND_LABELS,
  type VectorOverlapInput,
  type VectorOverlapSideInput,
} from "../../lib/inventory/vector-overlap";
import type {
  DynamoDBVectorSearchResponse,
  OpenSearchVectorSearchResponse,
  VectorEmbedResponse,
  VectorErrorResponse,
  VectorErrorStage,
  VectorLanguage,
  VectorSearchRequest,
} from "../../lib/inventory/vector-types";
import LatencyBar from "./LatencyBar";
import VectorComparisonPanel, {
  createEmptyVectorPanelState,
  type VectorPanelState,
} from "./VectorComparisonPanel";
import VectorConstraintTable from "./VectorConstraintTable";
import VectorOverlapSummary from "./VectorOverlapSummary";
import VectorSearchForm, {
  isBlankQuery,
  validateTopKInput,
  type VectorSearchFormValues,
} from "./VectorSearchForm";
import styles from "./VectorSearchComparisonView.module.css";

// ============================================================
// 定数
// ============================================================

/**
 * クライアント側タイムアウト（ms）。既存 `SearchComparisonView` の `OS_TIMEOUT_MS` と同じ 35 秒を
 * DynamoDB 側・OpenSearch 側の両方に適用する（要件 11.23）。
 * 埋め込み生成にも同値を適用し、応答しないまま検索中表示が残り続ける状態を作らない。
 */
export const VECTOR_TIMEOUT_MS = 35_000;

const LANGUAGE_LABELS: Record<VectorLanguage, string> = {
  ja: "日本語",
  en: "English",
};

// ============================================================
// 埋め込み生成の状態
// ============================================================

/**
 * 埋め込み生成の状態。
 *
 * レイテンシ・次元数・モデルは成功時にしか存在しないため、判別可能な合併型で表す。
 * 失敗時にレイテンシを描画する分岐を型が許さない（要件 11.16 / 16.8）。
 */
export type VectorEmbedState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | {
      readonly status: "succeeded";
      /** サーバー側で計測した埋め込み生成レイテンシ（ms、整数）（要件 10.5 / 11.16） */
      readonly latencyMs: number;
      readonly dimensions: number;
      readonly model: string;
      readonly language: VectorLanguage;
      readonly cacheHit: boolean;
    }
  | { readonly status: "failed"; readonly error: VectorErrorResponse };

const IDLE_EMBED_STATE: VectorEmbedState = { status: "idle" };

// ============================================================
// 非同期呼び出しの結果
// ============================================================

/**
 * 1 本の API 呼び出しの帰結。
 *
 * `superseded` は「後続の検索に置き換えられたので応答を捨てた」ことを表し、
 * 失敗ではないためパネルのエラー表示に昇格させない（要件 11.13）。
 */
type VectorCallOutcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "error"; readonly error: VectorErrorResponse }
  | { readonly kind: "superseded" };

/**
 * 任意の例外を `VectorErrorResponse` に寄せる。
 *
 * `vector-api.ts` は中断以外の失敗を `VectorApiError` に揃えて throw するため、
 * 通常は 1 つ目の分岐で解決する。2 つ目は想定外の例外に対する全域性の担保。
 */
function toVectorErrorResponse(error: unknown, stage: VectorErrorStage): VectorErrorResponse {
  if (isVectorApiError(error)) {
    return error.toResponse();
  }
  return {
    stage,
    errorCode: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

/**
 * クライアント側タイムアウトのエラー応答を組み立てる（要件 11.23）。
 *
 * エラーコードはバックエンド `shared/vector/errors.ts` の `classifyTimeout()` と同じ割り当てに
 * 揃える（OpenSearch 検索段階のみ専用コード `OPENSEARCH_TIMEOUT`、他は `INTERNAL_ERROR`）。
 * 再試行可否も同モジュールの方針に合わせ、画面が独自の組み合わせを作らないようにする。
 * 「もう一度検索できる」ことは説明文で伝える。
 */
function buildTimeoutError(stage: VectorErrorStage): VectorErrorResponse {
  const seconds = Math.round(VECTOR_TIMEOUT_MS / 1000);
  if (stage === "SEARCH_OPENSEARCH") {
    return {
      stage,
      errorCode: "OPENSEARCH_TIMEOUT",
      message: `${seconds} 秒以内に応答がありませんでした。検索を中断しました。もう一度検索を実行できます。`,
      retryable: true,
    };
  }
  return {
    stage,
    errorCode: "INTERNAL_ERROR",
    message: `${seconds} 秒以内に応答がありませんでした。検索を中断しました。もう一度検索を実行できます。`,
    retryable: false,
  };
}

// ============================================================
// 応答 → パネル状態
// ============================================================

/** 要求 TopK が上限により丸められた場合の注記 */
function topKNote(requestedTopK: number, appliedTopK: number): string[] {
  if (requestedTopK === appliedTopK) return [];
  return [`要求 TopK ${requestedTopK} は上限により ${appliedTopK} が適用されました。`];
}

/** DynamoDB `SearchVectors` の応答をパネル状態へ写す */
function toDynamodbPanelState(response: DynamoDBVectorSearchResponse): VectorPanelState {
  const notes = topKNote(response.requestedTopK, response.appliedTopK);
  return {
    backend: "dynamodb",
    loading: false,
    hits: response.hits,
    returnedCount: response.returnedCount,
    distinctSkuCount: response.distinctSkuCount,
    searchLatencyMs: response.searchLatencyMs,
    language: response.language,
    error: null,
    startedAt: null,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/**
 * OpenSearch k-NN の応答をパネル状態へ写す。
 *
 * `NO_DOCUMENTS`・フィルタ 0 件の診断・近傍不足の注記はいずれもエラーではないため（要件 16.4 /
 * 9.10 / 9.11）、`error` ではなく `notes` に載せて結果表示を消さない。
 */
function toOpensearchPanelState(response: OpenSearchVectorSearchResponse): VectorPanelState {
  const notes = topKNote(response.requestedTopK, response.appliedTopK);

  if (response.status === "NO_DOCUMENTS") {
    const documentCount = response.documentCount ?? 0;
    notes.push(
      `登録ドキュメント数 ${documentCount} 件のためデータ未投入です（NO_DOCUMENTS）。エラーではありません。`
    );
  }
  if (response.filterDiagnostics !== undefined) {
    notes.push(response.filterDiagnostics.message);
  }
  if (response.insufficientNeighborsNote !== undefined) {
    notes.push(response.insufficientNeighborsNote);
  }

  return {
    backend: "opensearch",
    loading: false,
    hits: response.hits,
    returnedCount: response.returnedCount,
    distinctSkuCount: response.distinctSkuCount,
    searchLatencyMs: response.searchLatencyMs,
    language: response.language,
    error: null,
    startedAt: null,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/** エラー終了したパネル状態。取得済みの結果は無いため空で作る（要件 11.22） */
function toErrorPanelState(
  backend: VectorPanelState["backend"],
  error: VectorErrorResponse
): VectorPanelState {
  return { ...createEmptyVectorPanelState(backend), error };
}

/** 検索開始直後のパネル状態。経過秒数の起点を持つ（要件 11.21） */
function toLoadingPanelState(
  backend: VectorPanelState["backend"],
  startedAt: number
): VectorPanelState {
  return { ...createEmptyVectorPanelState(backend), loading: true, startedAt };
}

// ============================================================
// 重なり指標の入力
// ============================================================

/**
 * パネル状態を重なり計算の入力へ写す。まだ確定していない側は `null` を返す。
 *
 * 重なり指標の算出そのものは `vector-overlap.ts` の `computeVectorOverlap()` が唯一の経路で、
 * `VectorOverlapSummary` が内部で呼ぶ。ここでは成功 / エラー / 未実行の区別のみを行う。
 */
function toOverlapSide(state: VectorPanelState): VectorOverlapSideInput | null {
  if (state.loading) return null;
  if (state.error !== null) {
    return { outcome: "error", errorCode: state.error.errorCode };
  }
  // 未実行（0 件と区別する）
  if (state.returnedCount === null) return null;
  return { outcome: "success", hits: state.hits };
}

// ============================================================
// 埋め込み生成の表示
// ============================================================

/**
 * 埋め込み生成レイテンシを検索レイテンシとは別項目として表示する（要件 11.16）。
 *
 * 失敗時はエラーコードと再試行可否を構造化して示す（要件 16.8）。検索レイテンシと結果件数は
 * 両パネルが未実行へ戻っているため、この時点でどこにも表示されない。
 */
function EmbeddingSummary({ state }: { state: VectorEmbedState }) {
  return (
    <section className={styles.embedSection} aria-labelledby="vector-embed-heading">
      <h3 id="vector-embed-heading" className={styles.sectionTitle}>
        クエリ埋め込み生成
      </h3>

      <div className={styles.live} aria-live="polite">
        {state.status === "idle" && (
          <p className={styles.hint}>
            検索を実行すると、埋め込み生成レイテンシを検索レイテンシとは別に表示します
          </p>
        )}

        {state.status === "loading" && <p className={styles.hint}>埋め込み生成中…</p>}

        {state.status === "succeeded" && (
          <dl className={styles.metaList}>
            <div className={styles.metaEntry}>
              <dt className={styles.metaTerm}>埋め込み生成レイテンシ</dt>
              <dd className={styles.metaValue}>{Math.round(state.latencyMs)} ms</dd>
            </div>
            <div className={styles.metaEntry}>
              <dt className={styles.metaTerm}>次元数</dt>
              <dd className={styles.metaValue}>{state.dimensions}</dd>
            </div>
            <div className={styles.metaEntry}>
              <dt className={styles.metaTerm}>モデル</dt>
              <dd className={styles.metaValue}>{state.model}</dd>
            </div>
            <div className={styles.metaEntry}>
              <dt className={styles.metaTerm}>検索言語</dt>
              <dd className={styles.metaValue}>{LANGUAGE_LABELS[state.language]}</dd>
            </div>
            <div className={styles.metaEntry}>
              <dt className={styles.metaTerm}>キャッシュ</dt>
              <dd className={styles.metaValue}>{state.cacheHit ? "ヒット" : "未ヒット"}</dd>
            </div>
          </dl>
        )}

        {state.status === "failed" && (
          <div className={styles.embedError}>
            <p className={styles.embedErrorHead}>
              埋め込み生成に失敗しました（エラーコード {state.error.errorCode} /{" "}
              {state.error.retryable ? "再試行可" : "再試行不可"}）
            </p>
            <p className={styles.embedErrorBody}>{state.error.message}</p>
            {state.error.retryable && state.error.retryAfterSeconds !== undefined && (
              <p className={styles.embedErrorBody}>
                推奨待機時間: {state.error.retryAfterSeconds} 秒
              </p>
            )}
            <p className={styles.embedErrorBody}>
              両バックエンドの検索は実行していません。両パネルは未実行状態です。
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * レイテンシ比較。
 *
 * バー表示は既存 `LatencyBar` を**改変せずそのまま再利用**する（`dynamoDbLatency` /
 * `opensearchLatency` の 2 プロパティ）。バー自身がバックエンド名とレイテンシ値をテキストで
 * 併記するが、未計測時はプレースホルダになるため、状態にかかわらず読めるテキスト要約を
 * 併置して要件 11.17 を状態非依存に満たす。
 */
function LatencyComparison({
  dynamodbLatencyMs,
  opensearchLatencyMs,
}: {
  dynamodbLatencyMs: number | null;
  opensearchLatencyMs: number | null;
}) {
  const describe = (latencyMs: number | null): string =>
    latencyMs === null ? "未計測" : `${latencyMs} ms`;

  return (
    <section className={styles.latencySection} aria-labelledby="vector-latency-heading">
      <h3 id="vector-latency-heading" className={styles.sectionTitle}>
        検索レイテンシの比較
      </h3>
      <LatencyBar
        dynamoDbLatency={dynamodbLatencyMs}
        opensearchLatency={opensearchLatencyMs}
      />
      <p className={styles.latencyText} aria-live="polite">
        {VECTOR_BACKEND_LABELS.dynamodb}: {describe(dynamodbLatencyMs)} /{" "}
        {VECTOR_BACKEND_LABELS.opensearch}: {describe(opensearchLatencyMs)}
        （いずれも検索レイテンシ。埋め込み生成レイテンシは別項目）
      </p>
    </section>
  );
}

// ============================================================
// 公開コンポーネント
// ============================================================

/**
 * ベクトル検索比較ビュー。
 *
 * 検索言語は本コンポーネントが `VectorSearchForm` から受け取る単一の値として扱い、
 * `POST /vector-search/embed` の 1 回の呼び出しにのみ渡す。2 つの検索リクエストは
 * `queryId` と TopK しか持たない（要件 11.4 / 11.11）。
 */
export default function VectorSearchComparisonView() {
  // 両パネルを独立した state として持つ。片側の setter が他方に触れる経路を作らない（Property 31）
  const [dynamodbState, setDynamodbState] = useState<VectorPanelState>(() =>
    createEmptyVectorPanelState("dynamodb")
  );
  const [opensearchState, setOpensearchState] = useState<VectorPanelState>(() =>
    createEmptyVectorPanelState("opensearch")
  );
  const [embedState, setEmbedState] = useState<VectorEmbedState>(IDLE_EMBED_STATE);

  /** 単調増加する検索連番。最後に開始した検索以外の応答を破棄する（要件 11.13） */
  const requestSeqRef = useRef(0);
  /** 進行中の呼び出しの中断ハンドル。新しい検索の開始時とアンマウント時に中断する */
  const controllersRef = useRef<AbortController[]>([]);

  /** 進行中の全呼び出しを中断する */
  const abortInFlight = useCallback(() => {
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current = [];
  }, []);

  useEffect(() => abortInFlight, [abortInFlight]);

  /**
   * 1 本の API 呼び出しをタイムアウト付きで実行する。
   *
   * 呼び出しごとに `AbortController` を作るため、片側のタイムアウトが他方の進行中リクエストを
   * 中断しない（要件 11.22 / 11.23）。中断がタイムアウト由来かどうかをローカルフラグで判別し、
   * 後続検索による中断（`superseded`）と区別する。
   */
  const callWithTimeout = useCallback(
    async <T,>(
      stage: VectorErrorStage,
      run: (options: VectorRequestOptions) => Promise<T>
    ): Promise<VectorCallOutcome<T>> => {
      const controller = new AbortController();
      controllersRef.current.push(controller);

      let timedOut = false;
      const timerId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, VECTOR_TIMEOUT_MS);

      try {
        const value = await run({ signal: controller.signal });
        return { kind: "ok", value };
      } catch (error) {
        if (timedOut) {
          return { kind: "error", error: buildTimeoutError(stage) };
        }
        if (isAbortError(error)) {
          return { kind: "superseded" };
        }
        return { kind: "error", error: toVectorErrorResponse(error, stage) };
      } finally {
        clearTimeout(timerId);
      }
    },
    []
  );

  /** DynamoDB 側の 1 本。完了時に DynamoDB パネルの state のみを更新する */
  const runDynamodbSearch = useCallback(
    async (seq: number, request: VectorSearchRequest) => {
      const outcome = await callWithTimeout<DynamoDBVectorSearchResponse>(
        "SEARCH_DYNAMODB",
        (options) => searchVectorDynamoDB(request, options)
      );

      if (outcome.kind === "superseded" || requestSeqRef.current !== seq) return;
      setDynamodbState(
        outcome.kind === "ok"
          ? toDynamodbPanelState(outcome.value)
          : toErrorPanelState("dynamodb", outcome.error)
      );
    },
    [callWithTimeout]
  );

  /** OpenSearch 側の 1 本。完了時に OpenSearch パネルの state のみを更新する */
  const runOpensearchSearch = useCallback(
    async (seq: number, request: VectorSearchRequest) => {
      const outcome = await callWithTimeout<OpenSearchVectorSearchResponse>(
        "SEARCH_OPENSEARCH",
        (options) => searchVectorOpenSearch(request, options)
      );

      if (outcome.kind === "superseded" || requestSeqRef.current !== seq) return;
      setOpensearchState(
        outcome.kind === "ok"
          ? toOpensearchPanelState(outcome.value)
          : toErrorPanelState("opensearch", outcome.error)
      );
    },
    [callWithTimeout]
  );

  const handleSearch = useCallback(
    async (values: VectorSearchFormValues) => {
      // フォーム側でも検証しているが、無効入力で state を触らないことを本体でも保証する
      // （要件 11.6 / Property 30）。判定は `VectorSearchForm` の検証関数を再利用し、
      // 許容範囲の定義をここに複製しない。
      if (isBlankQuery(values.query)) return;
      if (!validateTopKInput(String(values.topK)).ok) return;

      const seq = requestSeqRef.current + 1;
      requestSeqRef.current = seq;
      abortInFlight();

      const startedAt = Date.now();
      setEmbedState({ status: "loading" });
      // 検索開始時のリセットは片側の結果に由来しない同期操作。以降、各パネルの state を
      // 書き換えるのは自分側の完了ハンドラだけになる（Property 31）
      setDynamodbState(toLoadingPanelState("dynamodb", startedAt));
      setOpensearchState(toLoadingPanelState("opensearch", startedAt));

      // 埋め込み生成は 1 回だけ。言語はこの呼び出しにのみ渡る（要件 11.4 / 11.11）
      const embedOutcome = await callWithTimeout<VectorEmbedResponse>("EMBEDDING", (options) =>
        embedVectorQuery({ query: values.query, language: values.language }, options)
      );

      if (embedOutcome.kind === "superseded" || requestSeqRef.current !== seq) return;

      if (embedOutcome.kind === "error") {
        // 検索エンドポイントを呼ばず、両パネルを未実行状態へ戻す（要件 16.8）
        setEmbedState({ status: "failed", error: embedOutcome.error });
        setDynamodbState(createEmptyVectorPanelState("dynamodb"));
        setOpensearchState(createEmptyVectorPanelState("opensearch"));
        return;
      }

      const embedResponse = embedOutcome.value;
      setEmbedState({
        status: "succeeded",
        latencyMs: embedResponse.embeddingLatencyMs,
        dimensions: embedResponse.dimensions,
        model: embedResponse.model,
        language: embedResponse.language,
        cacheHit: embedResponse.cacheHit,
      });

      // 両検索へ渡すのは `queryId` と TopK（+ 倉庫フィルタ）のみ。言語もベクトルも含まないため、
      // 片側だけ言語やベクトルが変わることが起こらない（要件 11.4 / 11.11）
      const request: VectorSearchRequest = {
        queryId: embedResponse.queryId,
        topK: values.topK,
        ...(values.warehouseId !== undefined ? { warehouseId: values.warehouseId } : {}),
      };

      // `Promise.allSettled` で束ねず、独立した 2 本として開始する。完了した側から個別に
      // `setState` されるため、一方の完了を他方が待たない（要件 11.12）
      void runDynamodbSearch(seq, request);
      void runOpensearchSearch(seq, request);
    },
    [abortInFlight, callWithTimeout, runDynamodbSearch, runOpensearchSearch]
  );

  const isSearching =
    embedState.status === "loading" || dynamodbState.loading || opensearchState.loading;

  /**
   * 範囲条件が DynamoDB 側に対して拒否されたか（要件 15.7）。
   *
   * 応答から同期的に導出するため、レスポンス受信と同じ描画で制約メッセージが出る。
   */
  const dynamodbError = dynamodbState.error;
  const rangeFilterRejected =
    dynamodbError !== null && dynamodbError.errorCode === "RANGE_FILTER_UNSUPPORTED";
  const rangeFilterMessage =
    rangeFilterRejected && dynamodbError !== null ? dynamodbError.message : undefined;

  /** DynamoDB パネル内に出す制約メッセージ。パネルの読み上げ領域に入る（要件 15.7） */
  const dynamodbNotice: ReactNode = rangeFilterRejected ? (
    <p className={styles.panelNotice}>
      範囲条件を含むフィルタは実行されませんでした。DynamoDB 側の実装既定は等価条件のみです。
      入力済みの検索条件は保持しています。
    </p>
  ) : undefined;

  /**
   * 重なり計算の入力。両側が確定するまでは `null`（未実行扱い）。
   * 算出は `VectorOverlapSummary` が `computeVectorOverlap()` に委譲する
   */
  const overlapInput = useMemo<VectorOverlapInput | null>(() => {
    const dynamodb = toOverlapSide(dynamodbState);
    const opensearch = toOverlapSide(opensearchState);
    if (dynamodb === null || opensearch === null) return null;
    return { dynamodb, opensearch };
  }, [dynamodbState, opensearchState]);

  return (
    <div className={styles.container}>
      <VectorSearchForm onSearch={handleSearch} isSearching={isSearching} />

      <EmbeddingSummary state={embedState} />

      <LatencyComparison
        dynamodbLatencyMs={
          dynamodbState.searchLatencyMs === null ? null : Math.round(dynamodbState.searchLatencyMs)
        }
        opensearchLatencyMs={
          opensearchState.searchLatencyMs === null
            ? null
            : Math.round(opensearchState.searchLatencyMs)
        }
      />

      <VectorComparisonPanel
        dynamodbState={dynamodbState}
        opensearchState={opensearchState}
        dynamodbNotice={dynamodbNotice}
      />

      <VectorOverlapSummary input={overlapInput} />

      {/* 制約メタデータは本コンポーネントの検索状態に依存させない。検索を 1 度も実行していない
          状態でも表と注意書きを常時表示する（要件 15.1 / 15.5） */}
      <VectorConstraintTable
        rangeFilterRejected={rangeFilterRejected}
        rangeFilterMessage={rangeFilterMessage}
      />
    </div>
  );
}
