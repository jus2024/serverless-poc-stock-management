/**
 * recall 測定 CLI（Recall_Evaluator のエントリポイント）
 *
 * Paired_Query_Set × Distinct_Sku_K（1 / 10 / 33）× 言語（ja / en）× バックエンド（2 種）を
 * 実際の検索エンドポイントへ投げ、SKU 粒度の Recall_At_K を測定して
 * `docs/measurements/recall-<date>.json` へ機械可読な形式で書き出す（要件 13.9 / 13.10）。
 *
 * **算出ロジックは本ファイルに持たない。** 重複排除・recall の算出・集計は
 * `recall.ts`、Ground_Truth の構築は `ground-truth.ts`、クエリ集合は `paired-queries.ts` にある。
 * 本ファイルの責務は「実行順序の組み立て」「HTTP と AWS の I/O」「出力の整形」の 3 つに限る。
 *
 * なぜ CLI を `recall.ts` に置かないのか:
 *
 *   `recall.ts` は**副作用を持たない純関数のみ**で構成されている（AWS SDK もファイルシステムも
 *   参照せず、モジュール読み込み時に何も実行しない）。単体テスト（`recall.test.ts` /
 *   `recall-regression.test.ts`）はその性質に依存して import しているため、あのファイルへ
 *   エントリポイント（`main()` の呼び出し）を足すと、テストが import した瞬間に CLI が動きうる
 *   構造になる。したがって CLI は本ファイルへ分離し、`package.json` の `vector:recall` も
 *   こちらを指す。
 *
 * 測定の流れ（1 クエリ × 1 言語あたり）:
 *
 *  1. `POST /vector-search/embed` を 1 回だけ呼び、`queryId`（ハンドル）を得る
 *  2. Query_Vector_Cache から当該 `queryId` のベクトルを読み、それを Ground_Truth の
 *     クエリベクトルとして使う
 *  3. `buildGroundTruths()` で Distinct_Sku_K = 1 / 10 / 33 の Ground_Truth を作る
 *  4. 同一の `queryId` を使って `POST /vector-search/dynamodb` と
 *     `POST /vector-search/opensearch` へ `TopK = 3 × Distinct_Sku_K` を要求する
 *  5. 返却行を `evaluateRecallObservation()` に渡す（両バックエンドで同一関数、要件 13.5）
 *
 * ステップ 1〜2 の順序が要点である。`/vector-search/embed` は**ベクトル本体を返さない**
 * （要件 10.3）。Ground_Truth の計算にはクエリベクトルが必要なので、埋め込みを別途
 * 作り直す（Bedrock を CLI から直接呼ぶ）か、両バックエンドが実際に使うベクトルを
 * Query_Vector_Cache から読むかの二択になる。後者を採る。前者は「Ground_Truth の
 * クエリベクトル」と「検索に使われたクエリベクトル」が別々の Bedrock 呼び出しの産物になり、
 * 両者が一致する保証を測定の外側の仮定に置くことになるためである。後者なら
 * **Ground_Truth と 2 つのバックエンドが同一のベクトルを参照する**ことが構造的に決まる
 * （要件 13.5）。
 *
 * 設計上の要点:
 *
 * - **I/O はすべて注入で受ける。** 検索エンドポイントへの HTTP は
 *   {@link VectorSearchClient}、Query_Vector_Cache の読み出しは {@link QueryVectorResolver}、
 *   Vector_Table の Scan は `ground-truth.ts` の `VectorRecordSource`、レポートの書き出しは
 *   {@link RecallReportWriter} 越しに行う。したがって {@link runRecallMeasurement} と
 *   {@link evaluateSamples} は AWS 認証情報なしでも動かせる
 * - **観測（AWS への問い合わせ）と評価（純計算）を分ける。** 収集した
 *   {@link QuerySample} から Ground_Truth と Recall_At_K を導く経路は
 *   {@link evaluateSamples} という 1 つの純関数に閉じている。同一の
 *   {@link QuerySample} 列に対して 2 回適用すれば必ず同一の結果になり、これが
 *   再現性確認モード（`--verify-reproducibility`）の土台になる
 * - **逐次実行する。** 並行送信すると Bedrock の RPM 制約（前提 A10）と
 *   OpenSearch のコールドスタートが混ざり、レイテンシではなく recall の測定であっても
 *   スロットリング由来の失敗が増える。1 件ずつ順に投げる
 * - **測定不能な応答を測定値として採用しない。** `INDEX_BUILDING`（インデックス未完成）は
 *   その時点で中断する（要件 5.15）。`THROTTLED` / `OPENSEARCH_TIMEOUT` は再試行し、
 *   それでも失敗した場合は失敗として記録して当該クエリを集計から外す
 *
 * 再現性の確認（要件 13.10）:
 *
 *   `--verify-reproducibility` は、収集済みの {@link QuerySample} に対して評価
 *   （Ground_Truth の構築と Recall_At_K の算出）を **2 回** 実行し、Ground_Truth の
 *   ダイジェストと Recall_At_K のダイジェストが一致することを確認する。
 *   `--compare-with <前回のレポート>` は、前回の実行が残したダイジェストと突き合わせる。
 *   同一シード・同一クエリ集合であれば、クエリ選定順序・Ground_Truth・Recall_At_K の
 *   3 つのダイジェストがすべて一致する。
 *
 *   ネットワーク越しの応答（近似検索の返却行）そのものは再取得しない。ANN の返却は
 *   バックエンド側の状態に依存するため、CLI が「再現した」と述べられる範囲は
 *   決定論的な部分（Ground_Truth と、与えられた返却行に対する Recall_At_K）に限られる。
 *   返却行が変わった場合はダイジェストの不一致として現れる。
 *
 * 使い方:
 *
 * ```
 * npm run vector:recall -- --base-url https://xxxx.execute-api.us-west-2.amazonaws.com/prod
 * npm run vector:recall -- --dry-run                      # 実行計画のみを出す（AWS へ触らない）
 * npm run vector:recall -- --language ja --limit 10        # 部分実行（要件 13.6 の 50 件は満たさない）
 * npm run vector:recall -- --warehouse-id WH-TOKYO         # 倉庫フィルタ有効（要件 13.14）
 * npm run vector:recall -- --verify-reproducibility
 * npm run vector:recall -- --compare-with docs/measurements/recall-2026-08-05.json
 * ```
 *
 * 要件: 13.6, 13.8, 13.9, 13.10, 13.11, 13.12, 13.13, 13.15
 * 設計: Recall_Evaluator / 出力
 */

import { validateDimensions } from '../../amplify/functions/shared/vector/constraints';
import {
  isVectorLanguage,
  VECTOR_LANGUAGES,
  type VectorLanguage,
} from '../../amplify/functions/shared/vector/language';
import {
  DISTINCT_SKU_K_DERIVATION,
  MAX_DISTINCT_SKU_K,
  MAX_TOP_K,
  WAREHOUSE_ROWS_PER_SKU,
} from '../../amplify/functions/shared/vector/topk';
import {
  createDynamoDbVectorRecordSource,
  createFileSystemCache,
  DEFAULT_VECTOR_TABLE_NAME,
  DEDUPE_UNIT,
  DISTINCT_SKU_K_VALUES,
  EXPECTED_UNIQUE_VECTOR_COUNT,
  GROUND_TRUTH_CACHE_DIR,
  GROUND_TRUTH_TIE_EPSILON,
  buildGroundTruths,
  describeGroundTruthMetadata,
  loadUniqueVectorSet,
  type GroundTruth,
  type GroundTruthMetadata,
  type UniqueVectorSet,
  type UniqueVectorSetCache,
  type VectorRecordSource,
} from './ground-truth';
import {
  MIN_PAIRED_QUERY_COUNT,
  PAIRED_QUERY_SET,
  DEFAULT_QUERY_SEED,
  selectQueryOrder,
  validatePairedQuerySet,
  type PairedQuery,
  type QueryIntent,
} from './paired-queries';
import {
  NEGATIVE_CLASS_QUERY_INTENT,
  RECALL_BACKENDS,
  RECALL_THRESHOLD,
  aggregateRecallObservations,
  evaluateRecallObservation,
  type RecallAggregate,
  type RecallBackend,
  type RecallHit,
  type RecallObservation,
} from './recall';

// ============================================================
// 定数
// ============================================================

/** レポートの既定の格納先。実行時の CWD からの相対パス */
export const RECALL_REPORT_DIR = 'docs/measurements';

/** レポートのスキーマ版。形が変わったら上げる */
export const RECALL_REPORT_SCHEMA_VERSION = 1;

/** Query_Vector_Cache の既定のテーブル名（`amplify/custom/dynamodb-tables.ts` と同一の値） */
export const DEFAULT_QUERY_CACHE_TABLE_NAME = 'kiro-vector-query-cache';

/** ベクトル次元数の既定値。埋め込みバッチと検索 Lambda の既定と揃える */
export const DEFAULT_EMBEDDING_DIMENSIONS = 1024;

/** HTTP 要求の既定のタイムアウト（ms）。OpenSearch のコールドスタートを見込む */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** 再試行可能なエラーに対する既定の再試行回数 */
export const DEFAULT_MAX_RETRIES = 2;

/** API ベース URL を解決する環境変数。先に見つかったものを採用する */
export const BASE_URL_ENV_KEYS = [
  'VECTOR_SEARCH_API_URL',
  'NEXT_PUBLIC_INVENTORY_API_URL',
] as const;

/** 各エンドポイントのパス。ベース URL の末尾へ連結する */
export const ENDPOINT_PATHS = {
  embed: '/vector-search/embed',
  dynamodb: '/vector-search/dynamodb',
  opensearch: '/vector-search/opensearch',
} as const;

/**
 * 再試行してよいエラーコード。
 *
 * `INDEX_BUILDING` は**含めない**。インデックス未完成の応答は測定値として採用してはならず
 * （要件 5.15）、待てば直る種類の失敗であっても測定の途中で状態が変わることを許すと
 * 「どの時点のインデックスに対する recall か」が 1 つの出力の中で揺れる。中断して
 * `npm run vector:measure -- --wait-index` の完了を待つのが正しい対処である。
 */
export const RETRYABLE_ERROR_CODES = ['THROTTLED', 'OPENSEARCH_TIMEOUT', 'QUERY_EXPIRED'] as const;

/** 中断すべきエラーコード。測定を続けても意味のある値にならない */
export const FATAL_ERROR_CODES = [
  'INDEX_BUILDING',
  'INDEX_NOT_FOUND',
  'DIMENSION_MISMATCH',
  'ACCESS_DENIED_IAM',
  'ACCESS_DENIED_DATA_POLICY',
  'RESOURCE_NOT_FOUND',
] as const;

/** 終了コード。合否と実行不能を区別する */
export const EXIT_CODES = {
  /** 全グループが閾値を満たし、失敗も再現性の不一致もない */
  pass: 0,
  /** 実行できなかった（引数不正、ベース URL 未設定、中断を要するエラー） */
  error: 1,
  /** 測定は完了したが判定が不合格、または再現性の不一致がある */
  fail: 2,
  /** 一部のクエリが失敗して集計が不完全である */
  incomplete: 3,
} as const;

// ============================================================
// エラー
// ============================================================

/** CLI を続行できない状態 */
export class RecallCliError extends Error {
  /** バックエンドが返した機械可読エラーコード。HTTP 以外の失敗では null */
  readonly errorCode: string | null;
  /** 再試行してよいか */
  readonly retryable: boolean;
  /** 再試行しても意味がなく、測定を中断すべきか */
  readonly fatal: boolean;
  /** バックエンドが示した推奨待機秒数。示されなかった場合は null */
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    options: {
      errorCode?: string | null;
      retryable?: boolean;
      fatal?: boolean;
      retryAfterSeconds?: number | null;
    } = {}
  ) {
    super(message);
    this.name = 'RecallCliError';
    this.errorCode = options.errorCode ?? null;
    this.retryable = options.retryable ?? false;
    this.fatal = options.fatal ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

/** 引数の解釈に失敗した状態。使用法を添えて終了する */
export class RecallArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecallArgumentError';
  }
}

// ============================================================
// I/O 境界: 検索エンドポイント
// ============================================================

/** `POST /vector-search/embed` の要求 */
export interface EmbedRequest {
  query: string;
  language: VectorLanguage;
}

/** `POST /vector-search/embed` の応答のうち CLI が使う部分。ベクトル本体は含まれない */
export interface EmbedResult {
  /** 検索エンドポイントへ渡すハンドル */
  queryId: string;
  embeddingLatencyMs: number;
  dimensions: number;
  model: string;
  language: VectorLanguage;
}

/** 検索エンドポイントへの要求 */
export interface SearchRequest {
  backend: RecallBackend;
  /** `/vector-search/embed` が返したハンドル */
  queryId: string;
  /** 要求 TopK（= 3 × Distinct_Sku_K） */
  topK: number;
  /** 倉庫フィルタ。無効時は undefined */
  warehouseId?: string;
}

/** 検索応答のうち recall 算出に使う部分 */
export interface SearchResult {
  backend: RecallBackend;
  /** バックエンドが返した行（返した順序のまま） */
  hits: readonly RecallHit[];
  /** 応答がエコーした要求 TopK */
  requestedTopK: number;
  /** 実際に適用された TopK。要求値と異なる場合は丸めが起きている */
  appliedTopK: number;
  returnedCount: number;
  /** バックエンドが数えた一意 SKU 件数。CLI 側の重複排除と突き合わせる */
  distinctSkuCount: number;
  /** 応答がエコーした検索言語 */
  language: VectorLanguage;
  /** 検索区間のサーバー側レイテンシ（ms） */
  searchLatencyMs: number;
  /** 使用したインデックス名 */
  indexName: string;
}

/**
 * 2 つの検索エンドポイントと埋め込みエンドポイントへの経路。
 * HTTP を触るのはこのインターフェースの実装のみ。
 */
export interface VectorSearchClient {
  embed(request: EmbedRequest): Promise<EmbedResult>;
  search(request: SearchRequest): Promise<SearchResult>;
}

/**
 * Query_Vector_Cache からクエリベクトルを読む経路。
 *
 * 両バックエンドが `queryId` を通じて参照するのと**同一の項目**を読む。
 * これにより Ground_Truth のクエリベクトルと検索に使われたクエリベクトルが一致する。
 */
export interface QueryVectorResolver {
  resolve(queryId: string): Promise<ResolvedQueryVector>;
}

/** Query_Vector_Cache の 1 項目 */
export interface ResolvedQueryVector {
  vector: readonly number[];
  language: VectorLanguage;
  dimensions: number;
  model: string | null;
}

/** レポートの書き出し経路 */
export interface RecallReportWriter {
  /** 実際に書き出したパスを返す */
  write(fileName: string, contents: string): Promise<string>;
}

/** 進捗の通知先。既定では標準エラーへ 1 行ずつ出す */
export type ProgressReporter = (message: string) => void;

// ============================================================
// 型: 観測（AWS への問い合わせ結果）
// ============================================================

/** 1 バックエンド × 1 Distinct_Sku_K の返却行 */
export interface SampleSearchResult {
  backend: RecallBackend;
  distinctSkuK: number;
  /** 実際に要求した TopK */
  requestedTopK: number;
  /** 応答がエコーした適用 TopK */
  appliedTopK: number;
  returnedCount: number;
  distinctSkuCount: number;
  searchLatencyMs: number;
  indexName: string;
  hits: readonly RecallHit[];
}

/**
 * 1 クエリ × 1 言語の観測結果。
 *
 * ここまでが AWS への問い合わせの成果であり、以降の評価は
 * {@link evaluateSamples} の純計算に閉じる。
 */
export interface QuerySample {
  /** Paired_Query_Set の識別子（`q01` など）。日英で同一の値 */
  queryId: string;
  intent: QueryIntent;
  language: VectorLanguage;
  /** 実際に投げたクエリ文字列 */
  queryText: string;
  /** `/vector-search/embed` が発行したハンドル。実行ごとに変わるため同一性の判定には使わない */
  handle: string;
  embeddingLatencyMs: number;
  model: string;
  dimensions: number;
  /** Query_Vector_Cache から読んだクエリベクトル */
  vector: readonly number[];
  results: readonly SampleSearchResult[];
}

/** 失敗した 1 件の記録。集計から外れたことを出力に残す */
export interface SampleFailure {
  queryId: string;
  language: VectorLanguage;
  /** 失敗した処理段落 */
  stage: 'embed' | 'resolve-query-vector' | 'search' | 'ground-truth';
  backend: RecallBackend | null;
  distinctSkuK: number | null;
  errorCode: string | null;
  message: string;
}

// ============================================================
// 型: レポート
// ============================================================

/** 測定対象と接続条件。再実行の再現に必要な情報をすべて残す */
export interface RecallReportTarget {
  /** 検索エンドポイントのベース URL。`--dry-run` では未解決を示す文字列 */
  baseUrl: string;
  endpoints: { embed: string; dynamodb: string; opensearch: string };
  vectorTableName: string;
  queryCacheTableName: string;
  region: string | null;
  dimensions: number;
  /** 倉庫フィルタ。無効時は null（要件 13.9 の「適用したフィルタ条件」） */
  warehouseId: string | null;
  filterDescription: string;
  requestTimeoutMs: number;
  maxRetries: number;
  groundTruthCacheDir: string;
  dryRun: boolean;
}

/** クエリ意図ごとの件数 */
export interface QueryIntentCount {
  intent: QueryIntent;
  count: number;
}

/** クエリ集合の要約（要件 13.9 のクエリ件数と乱数シード値） */
export interface QuerySetSummary {
  /** Paired_Query_Set 全体の件数 */
  pairedQuerySetSize: number;
  /** 実際に測定に使ったクエリ件数 */
  queryCount: number;
  /** クエリの選定順序に使った乱数シード値 */
  seed: number;
  /** 要件 13.6 が求める下限 */
  minQueryCount: number;
  /** 下限を満たしているか。`--limit` で削った場合は false になる */
  meetsMinimumQueryCount: boolean;
  /** 選定順序どおりのクエリ識別子。日英で同一の並び */
  queryIds: readonly string[];
  /** 選定順序のダイジェスト。同一シードなら一致する */
  orderDigest: string;
  intentCounts: readonly QueryIntentCount[];
  /** 風味クエリ件数（要件 13.15 の判定対象） */
  flavorQueryCount: number;
}

/** 測定条件の要約（要件 13.3 / 13.9） */
export interface RecallReportScope {
  dedupeUnit: typeof DEDUPE_UNIT;
  rowsPerSku: number;
  /** 測定した Distinct_Sku_K（既定 1 / 10 / 33） */
  distinctSkuKValues: readonly number[];
  /** 要求した TopK（既定 3 / 30 / 99） */
  topKValues: readonly number[];
  maxDistinctSkuK: number;
  maxTopK: number;
  derivation: string;
  /** 合否判定に用いた閾値（要件 13.11） */
  threshold: number;
  /** 測定した言語 */
  languages: readonly VectorLanguage[];
  /** 測定したバックエンド */
  backends: readonly RecallBackend[];
  /** Ground_Truth 対象として期待する一意ベクトル件数（5,000） */
  expectedUniqueVectorCount: number;
}

/** 言語 1 つ分の Ground_Truth の条件（要件 13.2 / 13.9 / 13.14） */
export interface LanguageGroundTruthSummary {
  language: VectorLanguage;
  metadata: GroundTruthMetadata;
  /** キャッシュから読んだか。false なら Vector_Table を Scan した */
  fromCache: boolean;
  /** Scan した場合の走査件数。キャッシュヒット時は null */
  scannedRecordCount: number | null;
  /** 当該言語のベクトルを持たなかったレコード件数。キャッシュヒット時は null */
  missingEmbeddingCount: number | null;
  /** 一意ベクトル件数が期待値（5,000）と一致するか */
  matchesExpectedUniqueVectorCount: boolean;
  /** 件数やベクトル不一致に関する警告。問題なければ null */
  countWarning: string | null;
}

/** 同値による順位の不確定の集計（要件 13.12） */
export interface TieSummary {
  language: VectorLanguage;
  distinctSkuK: number;
  /** 同値と判定した距離差の閾値（1e-6） */
  epsilon: number;
  /** 集計対象のクエリ件数 */
  queryCount: number;
  /** k 番目と k+1 番目の距離差が閾値以下だったクエリ件数 */
  boundaryTieQueryCount: number;
  /** 同値により順位が一意に定まらなかったクエリ件数 */
  ambiguousRankQueryCount: number;
  /** 上記クエリの同値連鎖に属した件数の合計 */
  ambiguousRankEntryCount: number;
  /** k 番目と距離が完全一致した件数の合計 */
  exactTieEntryCount: number;
}

/** 再現性の判定に使うダイジェスト（要件 13.10） */
export interface ReproducibilityDigests {
  seed: number;
  /** クエリ選定順序のダイジェスト */
  queryOrderDigest: string;
  /** 全 Ground_Truth（言語 × クエリ × k の itemId 列）のダイジェスト */
  groundTruthDigest: string;
  /** 全 Recall_At_K のダイジェスト */
  recallDigest: string;
}

/** 前回のレポートとの突き合わせ結果 */
export interface ReproducibilityComparison {
  file: string;
  /** 前回のダイジェスト。読めなかった項目は null */
  previous: Partial<ReproducibilityDigests> | null;
  matched: boolean;
  mismatches: readonly string[];
}

/** 再現性の確認結果（要件 13.10） */
export interface ReproducibilityReport {
  digests: ReproducibilityDigests;
  /** 2 回評価して一致したか。`--verify-reproducibility` 未指定なら null */
  verified: boolean | null;
  /** 一致しなかった項目の説明 */
  mismatches: readonly string[];
  comparison: ReproducibilityComparison | null;
  /** 再現性の確認範囲の説明。何を再現したと述べているかを出力に残す */
  note: string;
}

/** 合否の要約 */
export interface RecallReportVerdict {
  threshold: number;
  /** 全グループの平均 Recall_At_K が閾値以上か（要件 13.11） */
  allGroupsPassed: boolean;
  /** 全風味クエリ集計で Material_Sku が 0 件か（要件 13.15） */
  allFlavorGroupsMaterialSkuFree: boolean;
  /** 失敗が 1 件もなく、計画した測定がすべて揃っているか */
  complete: boolean;
  /** 計画した測定件数（クエリ × 言語 × バックエンド × k） */
  plannedObservationCount: number;
  /** 実際に得られた測定件数 */
  observationCount: number;
  exitCode: number;
}

/** 機械可読なレポート（要件 13.9 / 13.10） */
export interface RecallMeasurementReport {
  schemaVersion: number;
  generatedAt: string;
  target: RecallReportTarget;
  querySet: QuerySetSummary;
  scope: RecallReportScope;
  groundTruth: readonly LanguageGroundTruthSummary[];
  /** バックエンド × 言語 × k の統計、言語間差分、風味クエリの Material_Sku 集計 */
  aggregate: RecallAggregate;
  ties: readonly TieSummary[];
  reproducibility: ReproducibilityReport;
  failures: readonly SampleFailure[];
  warnings: readonly string[];
  /** 1 件ごとの測定。`--omit-observations` 指定時は null */
  observations: readonly RecallObservation[] | null;
  verdict: RecallReportVerdict;
}

// ============================================================
// ダイジェスト（純関数）
// ============================================================

/**
 * 文字列列から決定論的なダイジェストを作る（FNV-1a 32bit を 16 進 8 桁 + 件数）。
 *
 * `node:crypto` を使わないのは、本関数を純関数のまま保ちたいためである。用途は
 * 「同一シード・同一クエリ集合の再実行で値が一致するか」の照合であり、衝突耐性が
 * 求められる用途ではない。件数を併記することで、行が増減した場合は
 * ハッシュ値が偶然一致しても不一致として現れる。
 *
 * 入力の順序に依存する。呼び出し側は照合したい単位で並びを固定してから渡す。
 */
export function digestLines(lines: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (let j = 0; j < line.length; j += 1) {
      hash ^= line.charCodeAt(j);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    // 行の区切りを混ぜる。連結の仕方が違うだけの入力を同一視しない
    hash ^= 0x0a;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, '0')}:${lines.length}`;
}

/** クエリ選定順序のダイジェスト。ja / en の両文字列を含めて組の同一性まで見る */
export function digestQueryOrder(queries: readonly PairedQuery[]): string {
  return digestLines(
    queries.map(
      (query, index) => `${index}|${query.id}|${query.intent}|${query.ja}|${query.en}`
    )
  );
}

/**
 * Recall_At_K のダイジェスト。
 * 小数の表現揺れを避けるため小数第 6 位で固定表記する（recall は k で割った有理数であり、
 * k の上限 33 に対して 6 桁あれば異なる値が同じ表記にならない）。
 */
export function digestRecall(observations: readonly RecallObservation[]): string {
  const lines = observations.map(
    (observation) =>
      `${observation.backend}|${observation.language}|${observation.distinctSkuK}|` +
      `${observation.queryId}|${observation.recallAtK.toFixed(6)}|${observation.matchedCount}`
  );
  return digestLines(lines.slice().sort(compareText));
}

/** Ground_Truth のダイジェスト。上位 k 件の itemId 列そのものを対象にする */
export function digestGroundTruths(
  entries: readonly { language: VectorLanguage; queryId: string; groundTruth: GroundTruth }[]
): string {
  const lines = entries.map(
    (entry) =>
      `${entry.language}|${entry.queryId}|${entry.groundTruth.distinctSkuK}|` +
      `${entry.groundTruth.itemIds.join(',')}`
  );
  return digestLines(lines.slice().sort(compareText));
}

// ============================================================
// 評価（純関数）
// ============================================================

/** 評価の入力。すべて観測済みの値であり、AWS へは触らない */
export interface EvaluationInput {
  samples: readonly QuerySample[];
  /** 言語ごとの一意ベクトル集合。Ground_Truth はここから再計算する */
  sets: ReadonlyMap<VectorLanguage, UniqueVectorSet>;
  distinctSkuKValues: readonly number[];
  threshold: number;
}

/** 評価の結果 */
export interface EvaluationResult {
  observations: readonly RecallObservation[];
  aggregate: RecallAggregate;
  ties: readonly TieSummary[];
  groundTruthDigest: string;
  recallDigest: string;
}

/**
 * 観測結果から Ground_Truth と Recall_At_K を導く（純関数、要件 13.4 / 13.5 / 13.10 / 13.12）。
 *
 * 同一の {@link QuerySample} 列・同一の一意ベクトル集合に対して常に同一の結果を返す。
 * Ground_Truth は毎回 {@link buildGroundTruths} で作り直すため、
 * 2 回適用して比べることが「同一シード・同一クエリ集合での再現」の確認になる。
 *
 * バックエンドによる分岐を持たない。両バックエンドの返却行は
 * `evaluateRecallObservation()` という同一の経路を通る（要件 13.5）。
 *
 * @throws {RecallCliError} 観測に対応する一意ベクトル集合が渡されていない場合
 */
export function evaluateSamples(input: EvaluationInput): EvaluationResult {
  const observations: RecallObservation[] = [];
  const groundTruthEntries: {
    language: VectorLanguage;
    queryId: string;
    groundTruth: GroundTruth;
  }[] = [];
  const tieBuckets = new Map<string, TieSummary>();

  for (let i = 0; i < input.samples.length; i += 1) {
    const sample = input.samples[i];
    const set = input.sets.get(sample.language);
    if (set === undefined) {
      throw new RecallCliError(
        `language=${sample.language} の一意ベクトル集合が渡されていません（queryId=${sample.queryId}）。` +
          '言語ごとの Ground_Truth を混用しないため、集合が無い言語の測定は評価できません。'
      );
    }

    const groundTruths = buildGroundTruths(sample.vector, set, input.distinctSkuKValues);
    const byDistinctSkuK = new Map<number, GroundTruth>();
    groundTruths.forEach((groundTruth) => {
      byDistinctSkuK.set(groundTruth.distinctSkuK, groundTruth);
      groundTruthEntries.push({
        language: sample.language,
        queryId: sample.queryId,
        groundTruth,
      });
      accumulateTie(tieBuckets, sample.language, groundTruth);
    });

    for (let j = 0; j < sample.results.length; j += 1) {
      const result = sample.results[j];
      const groundTruth = byDistinctSkuK.get(result.distinctSkuK);
      if (groundTruth === undefined) {
        throw new RecallCliError(
          `Distinct_Sku_K = ${result.distinctSkuK} の Ground_Truth がありません` +
            `（queryId=${sample.queryId} / language=${sample.language}）。${DISTINCT_SKU_K_DERIVATION}`
        );
      }

      observations.push(
        evaluateRecallObservation({
          queryId: sample.queryId,
          intent: sample.intent,
          backend: result.backend,
          hits: result.hits,
          groundTruth,
          requestedTopK: result.requestedTopK,
        })
      );
    }
  }

  return {
    observations,
    aggregate: aggregateRecallObservations(observations, {
      threshold: input.threshold,
      distinctSkuKValues: input.distinctSkuKValues,
    }),
    ties: sortTies(tieBuckets),
    groundTruthDigest: digestGroundTruths(groundTruthEntries),
    recallDigest: digestRecall(observations),
  };
}

/** 同値の集計を 1 件分積む（要件 13.12） */
function accumulateTie(
  buckets: Map<string, TieSummary>,
  language: VectorLanguage,
  groundTruth: GroundTruth
): void {
  const key = `${language}|${groundTruth.distinctSkuK}`;
  const current: TieSummary = buckets.get(key) ?? {
    language,
    distinctSkuK: groundTruth.distinctSkuK,
    epsilon: GROUND_TRUTH_TIE_EPSILON,
    queryCount: 0,
    boundaryTieQueryCount: 0,
    ambiguousRankQueryCount: 0,
    ambiguousRankEntryCount: 0,
    exactTieEntryCount: 0,
  };

  buckets.set(key, {
    language: current.language,
    distinctSkuK: current.distinctSkuK,
    epsilon: groundTruth.ties.epsilon,
    queryCount: current.queryCount + 1,
    boundaryTieQueryCount: current.boundaryTieQueryCount + (groundTruth.ties.boundaryTie ? 1 : 0),
    ambiguousRankQueryCount:
      current.ambiguousRankQueryCount + (groundTruth.ties.ambiguousRankCount > 0 ? 1 : 0),
    ambiguousRankEntryCount: current.ambiguousRankEntryCount + groundTruth.ties.ambiguousRankCount,
    exactTieEntryCount: current.exactTieEntryCount + groundTruth.ties.exactTieCount,
  });
}

/** 言語（ja → en）→ Distinct_Sku_K 昇順に並べる。入力順に依存しない出力にする */
function sortTies(buckets: Map<string, TieSummary>): readonly TieSummary[] {
  const summaries: TieSummary[] = [];
  buckets.forEach((summary) => summaries.push(summary));
  return summaries.sort((left, right) => {
    const byLanguage =
      VECTOR_LANGUAGES.indexOf(left.language) - VECTOR_LANGUAGES.indexOf(right.language);
    return byLanguage !== 0 ? byLanguage : left.distinctSkuK - right.distinctSkuK;
  });
}

// ============================================================
// 観測（I/O は注入で受ける）
// ============================================================

/** 測定実行の入力。AWS へ触る経路はすべて注入される */
export interface RunRecallMeasurementOptions {
  /** 検索エンドポイントへの経路 */
  client: VectorSearchClient;
  /** Query_Vector_Cache の読み出し経路 */
  queryVectorResolver: QueryVectorResolver;
  /** Vector_Table の Scan 経路（`ground-truth.ts` の I/O 境界） */
  vectorRecordSource: VectorRecordSource;
  /** 一意ベクトル集合のキャッシュ。省略時はファイルシステム */
  cache?: UniqueVectorSetCache;
  /** 選定順序どおりに並んだ測定対象のクエリ */
  queries: readonly PairedQuery[];
  languages: readonly VectorLanguage[];
  backends: readonly RecallBackend[];
  distinctSkuKValues: readonly number[];
  dimensions: number;
  /** 倉庫フィルタ。無効時は null（要件 13.14） */
  warehouseId: string | null;
  /** true ならキャッシュを読まずに Vector_Table を Scan する */
  forceRefreshGroundTruth?: boolean;
  /** 1 件でも失敗したら中断するか。既定は継続して失敗を記録する */
  failFast?: boolean;
  maxRetries?: number;
  onProgress?: ProgressReporter;
}

/** 測定実行の結果。評価前の観測のみを持つ */
export interface RecallMeasurementRun {
  samples: readonly QuerySample[];
  failures: readonly SampleFailure[];
  groundTruth: readonly LanguageGroundTruthSummary[];
  /** 言語ごとの一意ベクトル集合。評価に渡す */
  sets: ReadonlyMap<VectorLanguage, UniqueVectorSet>;
  warnings: readonly string[];
}

/**
 * Paired_Query_Set × 言語 × バックエンド × Distinct_Sku_K を逐次実行して観測を集める。
 *
 * 言語ごとに一意ベクトル集合を 1 回だけ読み（キャッシュがあれば Scan しない）、
 * クエリ 1 件につき埋め込みを 1 回だけ生成して、その `queryId` を
 * バックエンド 2 種 × Distinct_Sku_K 3 種の 6 回の検索で共有する。同一のクエリベクトルを
 * 両バックエンドへ渡すことが要件 13.5 の前提であり、埋め込みを検索ごとに作り直すと
 * この前提が崩れる。
 *
 * 失敗の扱い。`INDEX_BUILDING` などの致命的なコードは即座に中断する（測定値として
 * 採用してはならないため）。それ以外の失敗は {@link SampleFailure} として記録し、
 * 当該クエリ・当該言語の観測を捨てて次へ進む。捨てた測定は集計に現れないため、
 * レポートの `verdict.complete` が false になる。
 */
export async function runRecallMeasurement(
  options: RunRecallMeasurementOptions
): Promise<RecallMeasurementRun> {
  const progress = options.onProgress ?? (() => undefined);
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const cache = options.cache ?? createFileSystemCache();

  const samples: QuerySample[] = [];
  const failures: SampleFailure[] = [];
  const warnings: string[] = [];
  const groundTruth: LanguageGroundTruthSummary[] = [];
  const sets = new Map<VectorLanguage, UniqueVectorSet>();

  for (let l = 0; l < options.languages.length; l += 1) {
    const language = options.languages[l];

    progress(`[${language}] 一意ベクトル集合を読み込みます（次元数 ${options.dimensions}）…`);
    const loaded = await loadUniqueVectorSet({
      language,
      dimensions: options.dimensions,
      warehouseId: options.warehouseId,
      source: options.vectorRecordSource,
      cache,
      forceRefresh: options.forceRefreshGroundTruth,
    });

    sets.set(language, loaded.set);
    groundTruth.push({
      language,
      metadata: describeGroundTruthMetadata(loaded.set, options.distinctSkuKValues),
      fromCache: loaded.fromCache,
      scannedRecordCount: loaded.scan?.scannedRecordCount ?? null,
      missingEmbeddingCount: loaded.scan?.missingEmbeddingCount ?? null,
      matchesExpectedUniqueVectorCount:
        options.warehouseId === null
          ? loaded.set.uniqueVectorCount === EXPECTED_UNIQUE_VECTOR_COUNT
          : true,
      countWarning: loaded.countWarning,
    });

    if (loaded.countWarning !== null) {
      warnings.push(`[${language}] ${loaded.countWarning}`);
    }

    progress(
      `[${language}] 一意ベクトル ${loaded.set.uniqueVectorCount} 件` +
        `（${loaded.fromCache ? 'キャッシュ' : 'Scan'} / ${loaded.cacheFileName}）`
    );

    for (let q = 0; q < options.queries.length; q += 1) {
      const query = options.queries[q];
      const queryText = language === 'ja' ? query.ja : query.en;
      const label = `[${language}][${q + 1}/${options.queries.length}] ${query.id}`;

      let embed: EmbedResult;
      try {
        embed = await withRetries(
          () => options.client.embed({ query: queryText, language }),
          maxRetries,
          `${label} embed`,
          progress
        );
      } catch (error) {
        const failure = describeFailure(query.id, language, 'embed', null, null, error);
        failures.push(failure);
        if (options.failFast || isFatal(error)) {
          throw error;
        }
        progress(`${label} 埋め込み生成に失敗しました: ${failure.message}`);
        continue;
      }

      if (embed.language !== language) {
        // 応答の言語エコーが要求と異なる場合、以降の Ground_Truth は別言語のものになる
        const failure: SampleFailure = {
          queryId: query.id,
          language,
          stage: 'embed',
          backend: null,
          distinctSkuK: null,
          errorCode: null,
          message:
            `埋め込み応答の language が ${embed.language} で、要求した ${language} と一致しません。` +
            '言語をまたいだ Ground_Truth の混用を避けるため、この測定を破棄します。',
        };
        failures.push(failure);
        if (options.failFast) throw new RecallCliError(failure.message);
        continue;
      }

      let resolved: ResolvedQueryVector;
      try {
        resolved = await withRetries(
          () => options.queryVectorResolver.resolve(embed.queryId),
          maxRetries,
          `${label} query-vector`,
          progress
        );
      } catch (error) {
        const failure = describeFailure(
          query.id,
          language,
          'resolve-query-vector',
          null,
          null,
          error
        );
        failures.push(failure);
        if (options.failFast || isFatal(error)) throw error;
        progress(`${label} クエリベクトルの取得に失敗しました: ${failure.message}`);
        continue;
      }

      if (resolved.language !== language || resolved.dimensions !== options.dimensions) {
        const failure: SampleFailure = {
          queryId: query.id,
          language,
          stage: 'resolve-query-vector',
          backend: null,
          distinctSkuK: null,
          errorCode: null,
          message:
            `Query_Vector_Cache の項目が language=${resolved.language} / ` +
            `dimensions=${resolved.dimensions} で、要求（language=${language} / ` +
            `dimensions=${options.dimensions}）と一致しません。`,
        };
        failures.push(failure);
        if (options.failFast) throw new RecallCliError(failure.message);
        continue;
      }

      const results: SampleSearchResult[] = [];
      let aborted = false;

      for (let b = 0; b < options.backends.length && !aborted; b += 1) {
        const backend = options.backends[b];

        for (let k = 0; k < options.distinctSkuKValues.length && !aborted; k += 1) {
          const distinctSkuK = options.distinctSkuKValues[k];
          const topK = WAREHOUSE_ROWS_PER_SKU * distinctSkuK;

          try {
            const search = await withRetries(
              () =>
                options.client.search({
                  backend,
                  queryId: embed.queryId,
                  topK,
                  warehouseId: options.warehouseId ?? undefined,
                }),
              maxRetries,
              `${label} ${backend} k=${distinctSkuK}`,
              progress
            );

            if (search.appliedTopK !== topK) {
              warnings.push(
                `${label} ${backend}: 要求 TopK ${topK} に対して適用 TopK が ` +
                  `${search.appliedTopK} でした。Distinct_Sku_K = ${distinctSkuK} の測定として ` +
                  '成立しない可能性があります。'
              );
            }
            if (search.language !== language) {
              warnings.push(
                `${label} ${backend}: 応答の language が ${search.language} で要求と異なります。`
              );
            }

            results.push({
              backend,
              distinctSkuK,
              requestedTopK: topK,
              appliedTopK: search.appliedTopK,
              returnedCount: search.returnedCount,
              distinctSkuCount: search.distinctSkuCount,
              searchLatencyMs: search.searchLatencyMs,
              indexName: search.indexName,
              hits: search.hits,
            });
          } catch (error) {
            const failure = describeFailure(
              query.id,
              language,
              'search',
              backend,
              distinctSkuK,
              error
            );
            failures.push(failure);
            if (options.failFast || isFatal(error)) throw error;
            progress(`${label} ${backend} k=${distinctSkuK} 検索に失敗しました: ${failure.message}`);
            // 同一クエリの他の組み合わせだけを残すと、言語間差分の対応が崩れた状態で
            // 集計に混ざる。当該クエリ・当該言語の観測はまとめて捨てる
            aborted = true;
          }
        }
      }

      if (aborted) {
        continue;
      }

      samples.push({
        queryId: query.id,
        intent: query.intent,
        language,
        queryText,
        handle: embed.queryId,
        embeddingLatencyMs: embed.embeddingLatencyMs,
        model: embed.model,
        dimensions: resolved.dimensions,
        vector: resolved.vector,
        results,
      });
    }
  }

  return { samples, failures, groundTruth, sets, warnings };
}

/**
 * 再試行つきで 1 回の I/O を実行する。
 *
 * 再試行するのは {@link RETRYABLE_ERROR_CODES} のみ。`INDEX_BUILDING` のような
 * 致命的なコードは即座に投げ直す（インデックスが完成するまで測定自体が成立しない）。
 * 待機は 1 秒 × 試行回数の線形バックオフで、応答が `retryAfterSeconds` を示した場合は
 * そちらを優先する。
 */
export async function withRetries<T>(
  operation: () => Promise<T>,
  maxRetries: number,
  label: string,
  progress: ProgressReporter
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (isFatal(error) || !isRetryable(error) || attempt === maxRetries) {
        throw error;
      }
      const waitMs = retryDelayMs(error, attempt);
      progress(
        `${label} 再試行 ${attempt + 1}/${maxRetries}（${describeError(error)}）— ${waitMs} ms 待機`
      );
      await sleep(waitMs);
    }
  }

  throw lastError;
}

/** 失敗を記録用の形へ整える */
function describeFailure(
  queryId: string,
  language: VectorLanguage,
  stage: SampleFailure['stage'],
  backend: RecallBackend | null,
  distinctSkuK: number | null,
  error: unknown
): SampleFailure {
  return {
    queryId,
    language,
    stage,
    backend,
    distinctSkuK,
    errorCode: error instanceof RecallCliError ? error.errorCode : null,
    message: describeError(error),
  };
}

function isRetryable(error: unknown): boolean {
  return error instanceof RecallCliError && error.retryable;
}

function isFatal(error: unknown): boolean {
  return error instanceof RecallCliError && error.fatal;
}

function retryDelayMs(error: unknown, attempt: number): number {
  const retryAfter = error instanceof RecallCliError ? error.retryAfterSeconds : null;
  if (retryAfter !== null && Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(30_000, Math.round(retryAfter * 1000));
  }
  return 1000 * (attempt + 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// HTTP 実装（検索エンドポイント）
// ============================================================

export interface HttpVectorSearchClientOptions {
  /** API のベース URL。末尾のスラッシュは正規化する */
  baseUrl: string;
  timeoutMs?: number;
  /** 追加ヘッダー。API キーや認可ヘッダーが必要な場合に渡す */
  headers?: Record<string, string>;
}

/**
 * 実際の検索エンドポイントを呼ぶ実装。
 *
 * ベース URL は環境変数または `--base-url` から受け取り、パスは
 * {@link ENDPOINT_PATHS} のみを使う。エンドポイントのパスを呼び出し側が組み立てられない形にして、
 * 片方のバックエンドだけ別のパスへ投げる事故を防ぐ。
 *
 * 認証情報を本ファイルに埋め込む経路は持たない。認可が必要な API では
 * `--header` で渡す（値はレポートへ載せない）。
 */
export function createHttpVectorSearchClient(
  options: HttpVectorSearchClientOptions
): VectorSearchClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let status = 0;
    let text = '';
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      throw new RecallCliError(
        `${path} の呼び出しに失敗しました（通信または中断）: ${describeError(error)}`,
        { retryable: true }
      );
    } finally {
      clearTimeout(timer);
    }

    const parsed = tryParseJsonObject(text);

    if (status < 200 || status >= 300) {
      throw buildHttpError(path, status, parsed, text);
    }
    if (parsed === undefined) {
      throw new RecallCliError(
        `${path} の応答を JSON オブジェクトとして解釈できません（HTTP ${status}）。`
      );
    }
    return parsed;
  };

  return {
    async embed(request: EmbedRequest): Promise<EmbedResult> {
      const body = await post(ENDPOINT_PATHS.embed, {
        query: request.query,
        language: request.language,
      });
      return readEmbedResult(body);
    },

    async search(request: SearchRequest): Promise<SearchResult> {
      const path =
        request.backend === 'dynamodb' ? ENDPOINT_PATHS.dynamodb : ENDPOINT_PATHS.opensearch;
      const payload: Record<string, unknown> = { queryId: request.queryId, topK: request.topK };
      if (request.warehouseId !== undefined) {
        payload.warehouseId = request.warehouseId;
      }
      const body = await post(path, payload);
      return readSearchResult(request, body);
    },
  };
}

/** ベース URL の末尾スラッシュを落とす。`src/lib/inventory/api.ts` と同じ正規化 */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) {
    throw new RecallCliError('API のベース URL が空です。');
  }
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

/**
 * エラー応答を {@link RecallCliError} へ写す。
 *
 * `errors.ts` の機械可読コード（`stage` / `errorCode` / `message` / `retryable`）をそのまま使い、
 * 再試行の可否と中断の要否を {@link RETRYABLE_ERROR_CODES} / {@link FATAL_ERROR_CODES} で決める。
 * 応答が想定の形でない場合は HTTP 状態のみで判断する（5xx は再試行可）。
 */
export function buildHttpError(
  path: string,
  status: number,
  parsed: Record<string, unknown> | undefined,
  rawBody: string
): RecallCliError {
  const errorCode = typeof parsed?.errorCode === 'string' ? parsed.errorCode : null;
  const message = typeof parsed?.message === 'string' ? parsed.message : rawBody.slice(0, 500);
  const stage = typeof parsed?.stage === 'string' ? parsed.stage : '';
  const retryAfter =
    typeof parsed?.retryAfterSeconds === 'number' ? parsed.retryAfterSeconds : null;

  const fatal = errorCode !== null && FATAL_ERROR_CODES.indexOf(errorCode as never) >= 0;
  const retryable =
    !fatal &&
    ((errorCode !== null && RETRYABLE_ERROR_CODES.indexOf(errorCode as never) >= 0) ||
      (errorCode === null && status >= 500));

  const hint =
    errorCode === 'INDEX_BUILDING'
      ? ' ベクトルインデックスが未完成です。この応答は測定値として採用できません（要件 5.15）。' +
        '`npm run vector:measure -- --wait-index` の完了後に再実行してください。'
      : '';

  return new RecallCliError(
    `${path} が HTTP ${status} を返しました` +
      `（stage=${stage || '不明'} / errorCode=${errorCode ?? '不明'}）: ${message}${hint}`,
    { errorCode, retryable, fatal, retryAfterSeconds: retryAfter }
  );
}

/** 埋め込み応答を読む。ベクトル本体は含まれないため受け取らない（要件 10.3） */
export function readEmbedResult(body: Record<string, unknown>): EmbedResult {
  const queryId = body.queryId;
  const language = body.language;

  if (typeof queryId !== 'string' || queryId.length === 0) {
    throw new RecallCliError('埋め込み応答に queryId がありません。');
  }
  if (!isVectorLanguage(language)) {
    throw new RecallCliError(
      `埋め込み応答の language が ${JSON.stringify(language)} で、ja / en のいずれでもありません。`
    );
  }

  return {
    queryId,
    embeddingLatencyMs: readFiniteNumber(body.embeddingLatencyMs, 0),
    dimensions: readFiniteNumber(body.dimensions, 0),
    model: typeof body.model === 'string' ? body.model : '',
    language,
  };
}

/**
 * 検索応答を読む。
 *
 * 返却行から recall 算出に必要な 4 項目（`itemId` / `warehouseId` / `distance` / `rank`）だけを
 * 取り出す。**行の並びは応答のまま保つ。** 測定側で並べ替えると近似検索の挙動そのものが
 * 観測できなくなる。
 */
export function readSearchResult(
  request: SearchRequest,
  body: Record<string, unknown>
): SearchResult {
  const rawHits = body.hits;
  if (!Array.isArray(rawHits)) {
    throw new RecallCliError(`${request.backend} の応答に hits 配列がありません。`);
  }

  const hits: RecallHit[] = rawHits.map((rawHit, index) => {
    const hit = asRecord(rawHit);
    const itemId = hit?.itemId;
    if (typeof itemId !== 'string' || itemId.length === 0) {
      throw new RecallCliError(
        `${request.backend} の応答の hits[${index}] に itemId がありません。` +
          'itemId 単位の重複排除ができないため測定できません。'
      );
    }
    return {
      itemId,
      warehouseId: typeof hit?.warehouseId === 'string' ? hit.warehouseId : undefined,
      distance: readFiniteNumber(hit?.distance, Number.NaN),
      rank: typeof hit?.rank === 'number' ? hit.rank : undefined,
    };
  });

  const language = body.language;

  return {
    backend: request.backend,
    hits,
    requestedTopK: readFiniteNumber(body.requestedTopK, request.topK),
    appliedTopK: readFiniteNumber(body.appliedTopK, request.topK),
    returnedCount: readFiniteNumber(body.returnedCount, hits.length),
    distinctSkuCount: readFiniteNumber(body.distinctSkuCount, 0),
    language: isVectorLanguage(language) ? language : 'ja',
    searchLatencyMs: readFiniteNumber(body.searchLatencyMs, 0),
    indexName: typeof body.indexName === 'string' ? body.indexName : '',
  };
}

// ============================================================
// Query_Vector_Cache の読み出し
// ============================================================

export interface DynamoDbQueryVectorResolverOptions {
  tableName?: string;
  region?: string;
}

/**
 * Query_Vector_Cache から `queryId` のベクトルを読む実装。
 *
 * 両検索 Lambda が `GetItem` で読むのと**同一の項目**を読む。したがって
 * Ground_Truth のクエリベクトルと検索に使われたクエリベクトルは同一である（要件 13.5）。
 *
 * 項目は TTL 300 秒で失効する。埋め込み生成から 6 回の検索までを 1 クエリ分として
 * 直列に処理するため通常は失効しないが、失効していた場合は再試行可能なエラーにする
 * （呼び出し側が埋め込みから作り直せば回復する）。
 *
 * SDK は遅延 import する。純計算だけを使う呼び出し側に AWS SDK の読み込みを強いない。
 */
export function createDynamoDbQueryVectorResolver(
  options: DynamoDbQueryVectorResolverOptions = {}
): QueryVectorResolver {
  const tableName = options.tableName ?? DEFAULT_QUERY_CACHE_TABLE_NAME;

  return {
    async resolve(queryId: string): Promise<ResolvedQueryVector> {
      const [{ DynamoDBClient, GetItemCommand }, { marshall, unmarshall }] = await Promise.all([
        import('@aws-sdk/client-dynamodb'),
        import('@aws-sdk/util-dynamodb'),
      ]);

      const client = new DynamoDBClient(
        options.region === undefined ? {} : { region: options.region }
      );

      try {
        const response = await client.send(
          new GetItemCommand({ TableName: tableName, Key: marshall({ queryId }) })
        );

        if (response.Item === undefined) {
          throw new RecallCliError(
            `${tableName} に queryId=${queryId} の項目がありません（TTL 300 秒で失効した可能性があります）。`,
            { errorCode: 'QUERY_EXPIRED', retryable: true }
          );
        }

        const item = unmarshall(response.Item) as Record<string, unknown>;
        const language = item.language;
        const rawVector = item.vector;

        if (!isVectorLanguage(language)) {
          throw new RecallCliError(
            `${tableName} の queryId=${queryId} の language が ` +
              `${JSON.stringify(language)} で、ja / en のいずれでもありません。`
          );
        }
        if (!Array.isArray(rawVector) || rawVector.length === 0) {
          throw new RecallCliError(
            `${tableName} の queryId=${queryId} に vector がありません。`
          );
        }

        const vector = rawVector.map((value) => Number(value));
        return {
          vector,
          language,
          dimensions:
            typeof item.dimensions === 'number' && Number.isFinite(item.dimensions)
              ? item.dimensions
              : vector.length,
          model: typeof item.model === 'string' ? item.model : null,
        };
      } finally {
        client.destroy();
      }
    },
  };
}

// ============================================================
// レポートの書き出し
// ============================================================

/**
 * ファイルシステムへレポートを書く実装。
 *
 * **既存ファイルを上書きしない。** 同名が既にある場合は `-002` から順に連番を付けた別名で
 * 書き出し、実際のパスを返す。測定 1 回の結果はやり直しのできない実測値であり、
 * 同日 2 回目の実行で前回の出力を消してしまうと復元できない。
 */
export function createFileSystemReportWriter(
  baseDir: string = RECALL_REPORT_DIR
): RecallReportWriter {
  return {
    async write(fileName: string, contents: string): Promise<string> {
      const [fs, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
      await fs.mkdir(baseDir, { recursive: true });

      const extension = path.extname(fileName);
      const stem = extension.length > 0 ? fileName.slice(0, -extension.length) : fileName;

      for (let attempt = 1; attempt <= 999; attempt += 1) {
        const candidate =
          attempt === 1 ? fileName : `${stem}-${String(attempt).padStart(3, '0')}${extension}`;
        const target = path.join(baseDir, candidate);
        try {
          // 'wx' は既存ファイルがあると EEXIST で失敗する。上書きの経路を作らない
          await fs.writeFile(target, contents, { encoding: 'utf8', flag: 'wx' });
          return target;
        } catch (error) {
          if (!isFileExistsError(error)) {
            throw error;
          }
        }
      }

      throw new RecallCliError(
        `${baseDir} に ${fileName} の書き出し先を確保できませんでした（連番が上限に達しました）。`
      );
    },
  };
}

/** 書き出しを行わない実装（`--no-write`） */
export function createNoopReportWriter(): RecallReportWriter {
  return { write: async (fileName: string) => `(未書き出し) ${fileName}` };
}

/** レポートファイル名。設計の `recall-<date>.json` に従う（要件 13.9） */
export function recallReportFileName(generatedAt: string): string {
  return `recall-${generatedAt.slice(0, 10)}.json`;
}

// ============================================================
// レポートの組み立て（純関数）
// ============================================================

/** クエリ集合の要約を組み立てる（要件 13.9） */
export function summarizeQuerySet(
  queries: readonly PairedQuery[],
  seed: number,
  pairedQuerySetSize: number = PAIRED_QUERY_SET.length
): QuerySetSummary {
  const counts = new Map<QueryIntent, number>();
  queries.forEach((query) => {
    counts.set(query.intent, (counts.get(query.intent) ?? 0) + 1);
  });

  const intentCounts: QueryIntentCount[] = [];
  counts.forEach((count, intent) => intentCounts.push({ intent, count }));
  intentCounts.sort((left, right) => compareText(left.intent, right.intent));

  return {
    pairedQuerySetSize,
    queryCount: queries.length,
    seed,
    minQueryCount: MIN_PAIRED_QUERY_COUNT,
    meetsMinimumQueryCount: queries.length >= MIN_PAIRED_QUERY_COUNT,
    queryIds: queries.map((query) => query.id),
    orderDigest: digestQueryOrder(queries),
    intentCounts,
    flavorQueryCount: counts.get(NEGATIVE_CLASS_QUERY_INTENT) ?? 0,
  };
}

/** レポートの組み立てに必要な値 */
export interface BuildRecallReportInput {
  generatedAt: string;
  target: RecallReportTarget;
  seed: number;
  /** 選定順序どおりの測定対象クエリ */
  queries: readonly PairedQuery[];
  languages: readonly VectorLanguage[];
  backends: readonly RecallBackend[];
  distinctSkuKValues: readonly number[];
  threshold: number;
  run: RecallMeasurementRun;
  evaluation: EvaluationResult;
  /** 2 回評価して一致したか。確認していない場合は null */
  verified: boolean | null;
  /** 再現性の不一致の説明 */
  reproducibilityMismatches: readonly string[];
  comparison: ReproducibilityComparison | null;
  includeObservations: boolean;
}

/**
 * 機械可読なレポートを組み立てる（要件 13.6 / 13.8 / 13.9 / 13.10 / 13.11 / 13.12 / 13.13 / 13.15）。
 *
 * 要件 13.9 が列挙する項目の所在:
 *
 * | 項目 | 所在 |
 * |---|---|
 * | クエリ件数 | `querySet.queryCount` |
 * | 乱数シード値 | `querySet.seed` |
 * | Distinct_Sku_K の一覧 | `scope.distinctSkuKValues` |
 * | 要求した TopK の一覧 | `scope.topKValues` |
 * | Ground_Truth 対象の一意ベクトル件数 | `groundTruth[].metadata.uniqueVectorCount` |
 * | 重複排除の単位 | `scope.dedupeUnit`（`itemId`） |
 * | 対象言語 | `scope.languages` |
 * | 適用したフィルタ条件 | `target.filterDescription` / `groundTruth[].metadata.filterDescription` |
 */
export function buildRecallReport(input: BuildRecallReportInput): RecallMeasurementReport {
  const plannedObservationCount =
    input.queries.length *
    input.languages.length *
    input.backends.length *
    input.distinctSkuKValues.length;
  const observationCount = input.evaluation.observations.length;
  const complete = input.run.failures.length === 0 && observationCount === plannedObservationCount;

  const warnings = input.run.warnings.slice();
  if (!complete) {
    warnings.push(
      `計画した測定 ${plannedObservationCount} 件に対して ${observationCount} 件しか得られませんでした。` +
        '欠けた測定は集計に含まれていません。'
    );
  }
  if (input.queries.length < MIN_PAIRED_QUERY_COUNT) {
    warnings.push(
      `クエリ件数が ${input.queries.length} 件で、要件 13.6 の下限 ${MIN_PAIRED_QUERY_COUNT} 件を下回ります。` +
        'この出力は Verification_Report の測定値として採用できません。'
    );
  }
  input.evaluation.aggregate.languageDifferences.forEach((difference) => {
    if (difference.queryIdMismatch) {
      warnings.push(
        `${difference.backend} / Distinct_Sku_K=${difference.distinctSkuK}: ` +
          `日英で集計対象のクエリが一致しません（片側のみ ${difference.unpairedQueryIds.length} 件）。` +
          '言語間差分を言語差として解釈できません。'
      );
    }
  });

  const verdict: RecallReportVerdict = {
    threshold: input.threshold,
    allGroupsPassed: input.evaluation.aggregate.allGroupsPassed,
    allFlavorGroupsMaterialSkuFree:
      input.evaluation.aggregate.allFlavorGroupsMaterialSkuFree,
    complete,
    plannedObservationCount,
    observationCount,
    exitCode: resolveExitCode({
      allGroupsPassed: input.evaluation.aggregate.allGroupsPassed,
      allFlavorGroupsMaterialSkuFree: input.evaluation.aggregate.allFlavorGroupsMaterialSkuFree,
      complete,
      reproducibilityFailed:
        input.verified === false || input.comparison?.matched === false,
    }),
  };

  return {
    schemaVersion: RECALL_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    target: input.target,
    querySet: summarizeQuerySet(input.queries, input.seed),
    scope: {
      dedupeUnit: DEDUPE_UNIT,
      rowsPerSku: WAREHOUSE_ROWS_PER_SKU,
      distinctSkuKValues: input.distinctSkuKValues.slice(),
      topKValues: input.distinctSkuKValues.map((k) => WAREHOUSE_ROWS_PER_SKU * k),
      maxDistinctSkuK: MAX_DISTINCT_SKU_K,
      maxTopK: MAX_TOP_K,
      derivation: DISTINCT_SKU_K_DERIVATION,
      threshold: input.threshold,
      languages: input.languages.slice(),
      backends: input.backends.slice(),
      expectedUniqueVectorCount: EXPECTED_UNIQUE_VECTOR_COUNT,
    },
    groundTruth: input.run.groundTruth,
    aggregate: input.evaluation.aggregate,
    ties: input.evaluation.ties,
    reproducibility: {
      digests: {
        seed: input.seed,
        queryOrderDigest: digestQueryOrder(input.queries),
        groundTruthDigest: input.evaluation.groundTruthDigest,
        recallDigest: input.evaluation.recallDigest,
      },
      verified: input.verified,
      mismatches: input.reproducibilityMismatches,
      comparison: input.comparison,
      note:
        '再現の対象は決定論的な部分である。すなわち同一シードによるクエリ選定順序、' +
        '同一の一意ベクトル集合とクエリベクトルから作られる Ground_Truth、' +
        'および与えられた返却行に対する Recall_At_K の 3 つを再現する。' +
        '近似検索の返却行そのものはバックエンド側の状態に依存するため CLI では再生成せず、' +
        '返却行が変わった場合は recallDigest の不一致として現れる。',
    },
    failures: input.run.failures,
    warnings,
    observations: input.includeObservations ? input.evaluation.observations : null,
    verdict,
  };
}

/** 終了コードを決める。判定不合格と不完全を区別する */
export function resolveExitCode(input: {
  allGroupsPassed: boolean;
  allFlavorGroupsMaterialSkuFree: boolean;
  complete: boolean;
  reproducibilityFailed: boolean;
}): number {
  if (
    input.reproducibilityFailed ||
    !input.allGroupsPassed ||
    !input.allFlavorGroupsMaterialSkuFree
  ) {
    return EXIT_CODES.fail;
  }
  return input.complete ? EXIT_CODES.pass : EXIT_CODES.incomplete;
}

/** 2 回の評価結果を突き合わせる（要件 13.10） */
export function compareEvaluations(
  first: EvaluationResult,
  second: EvaluationResult
): readonly string[] {
  const mismatches: string[] = [];
  if (first.groundTruthDigest !== second.groundTruthDigest) {
    mismatches.push(
      `Ground_Truth のダイジェストが一致しません（1 回目 ${first.groundTruthDigest} / 2 回目 ${second.groundTruthDigest}）。`
    );
  }
  if (first.recallDigest !== second.recallDigest) {
    mismatches.push(
      `Recall_At_K のダイジェストが一致しません（1 回目 ${first.recallDigest} / 2 回目 ${second.recallDigest}）。`
    );
  }
  return mismatches;
}

/**
 * 前回のレポートのダイジェストと突き合わせる（要件 13.10）。
 *
 * 同一シード・同一クエリ集合で再実行した場合、`queryOrderDigest` と
 * `groundTruthDigest` は一致する。`recallDigest` は返却行が同じであれば一致し、
 * 近似検索の返却が変わった場合のみ不一致になる。したがって
 * 「Ground_Truth は一致したが Recall_At_K が一致しない」という結果は、
 * 測定側の非決定性ではなくバックエンド側の返却の変化を示す。
 */
export function compareWithPreviousDigests(
  file: string,
  current: ReproducibilityDigests,
  previousReport: unknown
): ReproducibilityComparison {
  const digests = asRecord(asRecord(asRecord(previousReport)?.reproducibility)?.digests);

  if (digests === undefined) {
    return {
      file,
      previous: null,
      matched: false,
      mismatches: [
        '前回のレポートに reproducibility.digests がありません。' +
          `スキーマ版 ${RECALL_REPORT_SCHEMA_VERSION} 以降の出力と突き合わせてください。`,
      ],
    };
  }

  const previous: Partial<ReproducibilityDigests> = {
    seed: typeof digests.seed === 'number' ? digests.seed : undefined,
    queryOrderDigest:
      typeof digests.queryOrderDigest === 'string' ? digests.queryOrderDigest : undefined,
    groundTruthDigest:
      typeof digests.groundTruthDigest === 'string' ? digests.groundTruthDigest : undefined,
    recallDigest: typeof digests.recallDigest === 'string' ? digests.recallDigest : undefined,
  };

  const mismatches: string[] = [];
  if (previous.seed !== current.seed) {
    mismatches.push(
      `乱数シードが異なります（前回 ${String(previous.seed)} / 今回 ${current.seed}）。` +
        '同一シードでの再実行ではないため、以降の比較は再現性の判定になりません。'
    );
  }
  if (previous.queryOrderDigest !== current.queryOrderDigest) {
    mismatches.push(
      `クエリ選定順序が一致しません（前回 ${String(previous.queryOrderDigest)} / 今回 ${current.queryOrderDigest}）。`
    );
  }
  if (previous.groundTruthDigest !== current.groundTruthDigest) {
    mismatches.push(
      `Ground_Truth が一致しません（前回 ${String(previous.groundTruthDigest)} / 今回 ${current.groundTruthDigest}）。`
    );
  }
  if (previous.recallDigest !== current.recallDigest) {
    mismatches.push(
      `Recall_At_K が一致しません（前回 ${String(previous.recallDigest)} / 今回 ${current.recallDigest}）。` +
        'Ground_Truth が一致している場合、差は両バックエンドの返却行の変化に由来する。'
    );
  }

  return { file, previous, matched: mismatches.length === 0, mismatches };
}

// ============================================================
// 出力の整形
// ============================================================

/** 人が読む要約。判定と主要な数値を 1 画面に収める */
export function formatRecallSummary(report: RecallMeasurementReport): string {
  const lines: string[] = [];

  lines.push('=== recall 測定（Recall_Evaluator / 要件 13） ===');
  lines.push(`実行時刻: ${report.generatedAt}`);
  lines.push(
    `対象: baseUrl=${report.target.baseUrl} 次元数=${report.target.dimensions} ` +
      `フィルタ=${report.target.filterDescription}`
  );
  lines.push(
    `クエリ: ${report.querySet.queryCount} 件（下限 ${report.querySet.minQueryCount} 件 / ` +
      `${report.querySet.meetsMinimumQueryCount ? '充足' : '不足'}） シード=${report.querySet.seed} ` +
      `風味クエリ=${report.querySet.flavorQueryCount} 件`
  );
  lines.push(
    `測定単位: Distinct_Sku_K=${report.scope.distinctSkuKValues.join(' / ')} → ` +
      `要求 TopK=${report.scope.topKValues.join(' / ')} 重複排除=${report.scope.dedupeUnit} ` +
      `言語=${report.scope.languages.join(' / ')} バックエンド=${report.scope.backends.join(' / ')}`
  );

  lines.push('');
  lines.push('--- Ground_Truth（言語別） ---');
  report.groundTruth.forEach((entry) => {
    lines.push(
      `${entry.language}: 一意ベクトル ${entry.metadata.uniqueVectorCount} 件` +
        `（期待 ${report.scope.expectedUniqueVectorCount} 件 / ${entry.matchesExpectedUniqueVectorCount ? '一致' : '不一致'}）` +
        ` 元レコード ${entry.metadata.sourceRecordCount} 件` +
        ` ${entry.fromCache ? 'キャッシュ' : 'Scan'}=${entry.metadata.cacheFileName}`
    );
    if (entry.countWarning !== null) {
      lines.push(`  警告: ${entry.countWarning}`);
    }
  });

  lines.push('');
  lines.push(`--- バックエンド × 言語 × Distinct_Sku_K（閾値 ${report.scope.threshold}） ---`);
  lines.push(
    'backend    lang k    topK  n    mean     min      <閾値 判定 完全同値行'
  );
  report.aggregate.groups.forEach((group) => {
    lines.push(
      `${group.backend.padEnd(10)} ${group.language.padEnd(4)} ${String(group.distinctSkuK).padEnd(4)} ` +
        `${String(group.topK).padEnd(5)} ${String(group.queryCount).padEnd(4)} ` +
        `${group.meanRecallAtK.toFixed(4)}   ${group.minRecallAtK.toFixed(4)}   ` +
        `${String(group.belowThresholdCount).padEnd(5)} ${group.passed ? '合格' : '不合格'} ` +
        `${group.exactTieRowCount}/${group.returnedRowCount} 行`
    );
  });

  lines.push('');
  lines.push('--- 言語間差分（日本語平均 − 英語平均、小数第 3 位） ---');
  report.aggregate.languageDifferences.forEach((difference) => {
    lines.push(
      `${difference.backend.padEnd(10)} k=${String(difference.distinctSkuK).padEnd(3)} ` +
        `ja=${difference.jaMeanRecallAtK.toFixed(4)} en=${difference.enMeanRecallAtK.toFixed(4)} ` +
        `差=${difference.difference.toFixed(3)}` +
        `${difference.queryIdMismatch ? '（対象クエリが日英で不一致）' : ''}`
    );
  });

  lines.push('');
  lines.push('--- 風味クエリ上位の Material_Sku（要件 13.15） ---');
  report.aggregate.flavorMaterialSku.forEach((summary) => {
    lines.push(
      `${summary.backend.padEnd(10)} ${summary.language.padEnd(4)} k=${String(summary.distinctSkuK).padEnd(3)} ` +
        `風味クエリ ${summary.flavorQueryCount} 件 Material_Sku ${summary.materialSkuCount} 件 ` +
        `${summary.materialSkuFree ? '0 件（判定: 合格）' : '（判定: 不合格）'}`
    );
  });

  lines.push('');
  lines.push(`--- 同値による順位の不確定（閾値 ${GROUND_TRUTH_TIE_EPSILON}、要件 13.12） ---`);
  report.ties.forEach((tie) => {
    lines.push(
      `${tie.language.padEnd(4)} k=${String(tie.distinctSkuK).padEnd(3)} ` +
        `境界同値 ${tie.boundaryTieQueryCount}/${tie.queryCount} クエリ ` +
        `順位不確定 ${tie.ambiguousRankQueryCount} クエリ（連鎖 ${tie.ambiguousRankEntryCount} 件） ` +
        `完全同値 ${tie.exactTieEntryCount} 件`
    );
  });

  lines.push('');
  lines.push('--- 再現性（要件 13.10） ---');
  lines.push(`クエリ選定順序: ${report.reproducibility.digests.queryOrderDigest}`);
  lines.push(`Ground_Truth  : ${report.reproducibility.digests.groundTruthDigest}`);
  lines.push(`Recall_At_K   : ${report.reproducibility.digests.recallDigest}`);
  lines.push(
    `2 回評価の一致: ${
      report.reproducibility.verified === null
        ? '未確認（--verify-reproducibility で確認する）'
        : report.reproducibility.verified
          ? '一致'
          : '不一致'
    }`
  );
  report.reproducibility.mismatches.forEach((mismatch) => lines.push(`  - ${mismatch}`));
  if (report.reproducibility.comparison !== null) {
    const comparison = report.reproducibility.comparison;
    lines.push(
      `前回レポートとの比較（${comparison.file}）: ${comparison.matched ? '一致' : '不一致'}`
    );
    comparison.mismatches.forEach((mismatch) => lines.push(`  - ${mismatch}`));
  }

  if (report.failures.length > 0) {
    lines.push('');
    lines.push(`--- 失敗（${report.failures.length} 件） ---`);
    report.failures.forEach((failure) => {
      lines.push(
        `${failure.language} ${failure.queryId} ${failure.stage}` +
          `${failure.backend === null ? '' : `/${failure.backend}`}` +
          `${failure.distinctSkuK === null ? '' : ` k=${failure.distinctSkuK}`}: ${failure.message}`
      );
    });
  }

  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('--- 警告 ---');
    report.warnings.forEach((warning) => lines.push(`  - ${warning}`));
  }

  lines.push('');
  lines.push(
    `判定: 全グループ ${report.verdict.allGroupsPassed ? '合格' : '不合格'}` +
      `（閾値 ${report.verdict.threshold}） / ` +
      `風味クエリの Material_Sku ${report.verdict.allFlavorGroupsMaterialSkuFree ? '0 件' : '検出'} / ` +
      `測定 ${report.verdict.observationCount}/${report.verdict.plannedObservationCount} 件` +
      `（${report.verdict.complete ? '完全' : '不完全'}）`
  );
  lines.push(`終了コード: ${report.verdict.exitCode}`);

  return lines.join('\n');
}

/** `--dry-run` で出す実行計画。AWS へ 1 度も触らずに組み合わせ数と接続先を確認する */
export function formatExecutionPlan(input: {
  target: RecallReportTarget;
  queries: readonly PairedQuery[];
  languages: readonly VectorLanguage[];
  backends: readonly RecallBackend[];
  distinctSkuKValues: readonly number[];
  seed: number;
  outputPath: string;
}): string {
  const searchCallCount =
    input.queries.length *
    input.languages.length *
    input.backends.length *
    input.distinctSkuKValues.length;
  const embedCallCount = input.queries.length * input.languages.length;
  const summary = summarizeQuerySet(input.queries, input.seed);

  return [
    '=== recall 測定の実行計画（--dry-run / AWS へは接続していない） ===',
    `ベース URL          : ${input.target.baseUrl}`,
    `エンドポイント      : ${ENDPOINT_PATHS.embed} / ${ENDPOINT_PATHS.dynamodb} / ${ENDPOINT_PATHS.opensearch}`,
    `Vector_Table        : ${input.target.vectorTableName}`,
    `Query_Vector_Cache  : ${input.target.queryCacheTableName}`,
    `次元数              : ${input.target.dimensions}`,
    `フィルタ条件        : ${input.target.filterDescription}`,
    `Ground_Truth キャッシュ: ${input.target.groundTruthCacheDir}`,
    '',
    `クエリ              : ${summary.queryCount} 件（シード ${summary.seed} / 順序ダイジェスト ${summary.orderDigest}）`,
    `  意図の内訳        : ${summary.intentCounts
      .map((entry) => `${entry.intent}=${entry.count}`)
      .join(' ')}`,
    `  下限 ${summary.minQueryCount} 件      : ${summary.meetsMinimumQueryCount ? '充足' : '不足（要件 13.6 を満たさない）'}`,
    `言語                : ${input.languages.join(' / ')}`,
    `バックエンド        : ${input.backends.join(' / ')}`,
    `Distinct_Sku_K      : ${input.distinctSkuKValues.join(' / ')}`,
    `要求 TopK           : ${input.distinctSkuKValues
      .map((k) => WAREHOUSE_ROWS_PER_SKU * k)
      .join(' / ')}`,
    '',
    `呼び出し回数        : 埋め込み ${embedCallCount} 回 + 検索 ${searchCallCount} 回` +
      `（Query_Vector_Cache の GetItem ${embedCallCount} 回）`,
    `一意ベクトル集合    : 言語ごとに 1 回読み込み（キャッシュが無ければ Vector_Table を Scan）`,
    `出力先              : ${input.outputPath}`,
    '',
    DISTINCT_SKU_K_DERIVATION,
  ].join('\n');
}

// ============================================================
// CLI
// ============================================================

/** コマンドライン引数の解釈結果 */
export interface RecallCliOptions {
  /** API のベース URL。未解決なら null（`--dry-run` 以外では実行できない） */
  baseUrl: string | null;
  /** ベース URL の出所。レポートには載せず、エラーメッセージにのみ使う */
  baseUrlSource: string;
  languages: readonly VectorLanguage[];
  backends: readonly RecallBackend[];
  distinctSkuKValues: readonly number[];
  seed: number;
  /** 測定するクエリ件数の上限。null なら全件 */
  limit: number | null;
  warehouseId: string | null;
  dimensions: number;
  vectorTableName: string;
  queryCacheTableName: string;
  region?: string;
  groundTruthCacheDir: string;
  outputDir: string;
  /** 出力ファイル名の上書き。null なら `recall-<date>.json` */
  outputFileName: string | null;
  timeoutMs: number;
  maxRetries: number;
  threshold: number;
  headers: Record<string, string>;
  refreshGroundTruth: boolean;
  verifyReproducibility: boolean;
  compareWith: string | null;
  omitObservations: boolean;
  failFast: boolean;
  write: boolean;
  printJson: boolean;
  dryRun: boolean;
  help: boolean;
}

/**
 * `--key value` 形式の引数を解釈する（純関数）。
 *
 * ベース URL は `--base-url` が最優先で、無い場合は {@link BASE_URL_ENV_KEYS} の順に
 * 環境変数を見る。ここで解決できなくても例外にはしない。`--dry-run` は接続先が
 * 未解決でも実行計画を出せるため、実際に必要になる時点で判定する。
 */
export function parseRecallArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env
): RecallCliOptions {
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  const headers: Record<string, string> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      throw new RecallArgumentError(`解釈できない引数: ${token}`);
    }
    const key = token.slice(2);

    if (
      key === 'dry-run' ||
      key === 'no-write' ||
      key === 'json' ||
      key === 'refresh-ground-truth' ||
      key === 'verify-reproducibility' ||
      key === 'omit-observations' ||
      key === 'fail-fast' ||
      key === 'help'
    ) {
      booleans.add(key);
      continue;
    }

    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new RecallArgumentError(`--${key} には値が必要です。`);
    }
    i += 1;

    if (key === 'header') {
      const separator = value.indexOf(':');
      if (separator <= 0) {
        throw new RecallArgumentError(`--header は "名前: 値" の形式で指定してください（指定値: ${value}）。`);
      }
      headers[value.slice(0, separator).trim()] = value.slice(separator + 1).trim();
      continue;
    }

    flags.set(key, value);
  }

  const explicitBaseUrl = flags.get('base-url');
  const envBaseUrl = resolveBaseUrlFromEnv(env);

  return {
    baseUrl: explicitBaseUrl ?? envBaseUrl.url,
    baseUrlSource: explicitBaseUrl === undefined ? envBaseUrl.source : '--base-url',
    languages: parseLanguages(flags.get('language')),
    backends: parseBackends(flags.get('backend')),
    distinctSkuKValues: parseDistinctSkuKValues(flags.get('distinct-sku-k')),
    seed: parseIntegerFlag(flags.get('seed'), DEFAULT_QUERY_SEED, 'seed', { min: 0 }),
    limit:
      flags.get('limit') === undefined
        ? null
        : parseIntegerFlag(flags.get('limit'), 0, 'limit', { min: 1 }),
    warehouseId: flags.get('warehouse-id') ?? null,
    dimensions: parseDimensions(flags.get('dimensions')),
    vectorTableName: flags.get('table') ?? DEFAULT_VECTOR_TABLE_NAME,
    queryCacheTableName: flags.get('query-cache-table') ?? DEFAULT_QUERY_CACHE_TABLE_NAME,
    region: flags.get('region'),
    groundTruthCacheDir: flags.get('cache-dir') ?? GROUND_TRUTH_CACHE_DIR,
    outputDir: flags.get('out') ?? RECALL_REPORT_DIR,
    outputFileName: flags.get('out-file') ?? null,
    timeoutMs: parseIntegerFlag(flags.get('timeout-ms'), DEFAULT_REQUEST_TIMEOUT_MS, 'timeout-ms', {
      min: 1,
    }),
    maxRetries: parseIntegerFlag(flags.get('max-retries'), DEFAULT_MAX_RETRIES, 'max-retries', {
      min: 0,
    }),
    threshold: parseThreshold(flags.get('threshold')),
    headers,
    refreshGroundTruth: booleans.has('refresh-ground-truth'),
    verifyReproducibility: booleans.has('verify-reproducibility'),
    compareWith: flags.get('compare-with') ?? null,
    omitObservations: booleans.has('omit-observations'),
    failFast: booleans.has('fail-fast'),
    write: !booleans.has('no-write'),
    printJson: booleans.has('json'),
    dryRun: booleans.has('dry-run'),
    help: booleans.has('help'),
  };
}

/** 環境変数からベース URL を解決する。見つかった変数名も返す */
function resolveBaseUrlFromEnv(env: Record<string, string | undefined>): {
  url: string | null;
  source: string;
} {
  for (let i = 0; i < BASE_URL_ENV_KEYS.length; i += 1) {
    const key = BASE_URL_ENV_KEYS[i];
    const value = env[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return { url: value.trim(), source: `環境変数 ${key}` };
    }
  }
  return { url: null, source: '未解決' };
}

/** `--language` を解釈する。`both` と省略は ja / en の両方 */
function parseLanguages(raw: string | undefined): readonly VectorLanguage[] {
  if (raw === undefined || raw === 'both' || raw === 'all') {
    return VECTOR_LANGUAGES.slice();
  }
  const values = splitList(raw);
  const languages: VectorLanguage[] = [];
  values.forEach((value) => {
    if (!isVectorLanguage(value)) {
      throw new RecallArgumentError(
        `--language は ${VECTOR_LANGUAGES.join(' / ')} / both のいずれかです（指定値: ${value}）。`
      );
    }
    if (languages.indexOf(value) < 0) {
      languages.push(value);
    }
  });
  if (languages.length === 0) {
    throw new RecallArgumentError('--language に 1 つ以上の言語を指定してください。');
  }
  // 出力の並びを入力順から切り離す（ja → en 固定）
  return VECTOR_LANGUAGES.filter((language) => languages.indexOf(language) >= 0);
}

/** `--backend` を解釈する。`both` と省略は 2 種とも */
function parseBackends(raw: string | undefined): readonly RecallBackend[] {
  if (raw === undefined || raw === 'both' || raw === 'all') {
    return RECALL_BACKENDS.slice();
  }
  const values = splitList(raw);
  const backends: RecallBackend[] = [];
  values.forEach((value) => {
    if (value !== 'dynamodb' && value !== 'opensearch') {
      throw new RecallArgumentError(
        `--backend は ${RECALL_BACKENDS.join(' / ')} / both のいずれかです（指定値: ${value}）。`
      );
    }
    if (backends.indexOf(value) < 0) {
      backends.push(value);
    }
  });
  if (backends.length === 0) {
    throw new RecallArgumentError('--backend に 1 つ以上のバックエンドを指定してください。');
  }
  return RECALL_BACKENDS.filter((backend) => backends.indexOf(backend) >= 0);
}

/** `--distinct-sku-k` を解釈する。省略時は 1 / 10 / 33（要件 13.3） */
function parseDistinctSkuKValues(raw: string | undefined): readonly number[] {
  if (raw === undefined) {
    return DISTINCT_SKU_K_VALUES.slice();
  }
  const values: number[] = [];
  splitList(raw).forEach((token) => {
    const parsed = Number(token);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_DISTINCT_SKU_K) {
      throw new RecallArgumentError(
        `--distinct-sku-k は 1 以上 ${MAX_DISTINCT_SKU_K} 以下の整数です（指定値: ${token}）。` +
          DISTINCT_SKU_K_DERIVATION
      );
    }
    if (values.indexOf(parsed) < 0) {
      values.push(parsed);
    }
  });
  if (values.length === 0) {
    throw new RecallArgumentError('--distinct-sku-k に 1 つ以上の値を指定してください。');
  }
  return values.sort((left, right) => left - right);
}

/** `--dimensions` を解釈する。両バックエンドで使える範囲に収まっているかを検査する */
function parseDimensions(raw: string | undefined): number {
  const value = parseIntegerFlag(raw, DEFAULT_EMBEDDING_DIMENSIONS, 'dimensions', { min: 1 });
  const validated = validateDimensions(value, 'dynamodb');
  if (!validated.ok) {
    throw new RecallArgumentError(validated.message);
  }
  return validated.dimensions;
}

/** `--threshold` を解釈する。既定は 0.99（要件 13.11） */
function parseThreshold(raw: string | undefined): number {
  if (raw === undefined) {
    return RECALL_THRESHOLD;
  }
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new RecallArgumentError(`--threshold は 0 以上 1 以下の数値です（指定値: ${raw}）。`);
  }
  return parsed;
}

function parseIntegerFlag(
  raw: string | undefined,
  fallback: number,
  label: string,
  bounds: { min: number }
): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < bounds.min) {
    throw new RecallArgumentError(
      `--${label} は ${bounds.min} 以上の整数です（指定値: ${raw}）。`
    );
  }
  return parsed;
}

/** カンマ区切りの一覧を分解する。空要素は落とす */
function splitList(raw: string): readonly string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/** 使用法。引数エラー時と `--help` で出す */
export const RECALL_USAGE = [
  'recall 測定 CLI（Recall_Evaluator / 要件 13）',
  '',
  '使用法: npm run vector:recall -- [オプション]',
  '',
  '接続:',
  `  --base-url <url>          検索 API のベース URL（既定: ${BASE_URL_ENV_KEYS.join(' → ')} の順に環境変数を見る）`,
  '  --header "名前: 値"       追加 HTTP ヘッダー（複数指定可。値はレポートへ載せない）',
  `  --timeout-ms <n>          1 要求のタイムアウト（既定: ${DEFAULT_REQUEST_TIMEOUT_MS}）`,
  `  --max-retries <n>         再試行可能なエラーの再試行回数（既定: ${DEFAULT_MAX_RETRIES}）`,
  `  --region <region>         DynamoDB のリージョン（既定: 既定の資格情報チェーンから解決）`,
  `  --table <name>            Vector_Table 名（既定: ${DEFAULT_VECTOR_TABLE_NAME}）`,
  `  --query-cache-table <n>   Query_Vector_Cache 名（既定: ${DEFAULT_QUERY_CACHE_TABLE_NAME}）`,
  '',
  '測定条件:',
  '  --language <ja|en|both>   測定する言語（既定: both）',
  '  --backend <dynamodb|opensearch|both>  測定するバックエンド（既定: both）',
  `  --distinct-sku-k <1,10,33>  Distinct_Sku_K（既定: ${DISTINCT_SKU_K_VALUES.join(',')}。要求 TopK は 3 倍）`,
  `  --seed <n>                クエリ選定順序の乱数シード（既定: ${DEFAULT_QUERY_SEED}）`,
  `  --limit <n>               測定するクエリ件数の上限（既定: 全 ${PAIRED_QUERY_SET.length} 件）`,
  '  --warehouse-id <id>       倉庫フィルタを有効にする（Ground_Truth も当該倉庫で再計算する）',
  `  --dimensions <n>          ベクトル次元数（既定: ${DEFAULT_EMBEDDING_DIMENSIONS}）`,
  `  --threshold <n>           合否判定の閾値（既定: ${RECALL_THRESHOLD}）`,
  `  --cache-dir <dir>         一意ベクトル集合のキャッシュ先（既定: ${GROUND_TRUTH_CACHE_DIR}）`,
  '  --refresh-ground-truth    キャッシュを使わず Vector_Table を Scan し直す',
  '',
  '再現性の確認（要件 13.10）:',
  '  --verify-reproducibility  収集した観測に対する評価を 2 回行い、Ground_Truth と Recall_At_K の一致を確認する',
  '  --compare-with <file>     前回のレポートのダイジェストと突き合わせる',
  '',
  '出力:',
  `  --out <dir>               レポートの出力先（既定: ${RECALL_REPORT_DIR}）`,
  '  --out-file <name>         出力ファイル名（既定: recall-<date>.json。既存ファイルは上書きしない）',
  '  --omit-observations       1 件ごとの測定をレポートから省く',
  '  --no-write                レポートファイルを書き出さない',
  '  --json                    レポート JSON を標準出力へ出す',
  '  --dry-run                 AWS へ接続せず実行計画のみを出す',
  '  --fail-fast               1 件でも失敗したら中断する',
  '  --help                    この使用法を表示する',
  '',
  '終了コード:',
  `  ${EXIT_CODES.pass} 全グループが閾値を満たし、測定も完全`,
  `  ${EXIT_CODES.error} 実行できなかった（引数不正 / ベース URL 未解決 / 中断を要するエラー）`,
  `  ${EXIT_CODES.fail} 判定が不合格、または再現性の不一致`,
  `  ${EXIT_CODES.incomplete} 一部のクエリが失敗して集計が不完全`,
].join('\n');

/**
 * CLI の本体。終了コードを返す。
 *
 * 標準出力には要約とレポート JSON のみを出し、進捗は標準エラーへ出す。
 * `npm run vector:recall -- --json > report.json` でレポートだけを取り出せる。
 */
export async function main(argv: readonly string[]): Promise<number> {
  let options: RecallCliOptions;
  try {
    options = parseRecallArgs(argv);
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n\n${RECALL_USAGE}\n`);
    return EXIT_CODES.error;
  }

  if (options.help) {
    process.stdout.write(`${RECALL_USAGE}\n`);
    return EXIT_CODES.pass;
  }

  // 要件 13.7: id の一意性と ja / en の非空を確認し、違反があれば測定を開始しない
  try {
    validatePairedQuerySet();
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`);
    return EXIT_CODES.error;
  }

  const ordered = selectQueryOrder(options.seed);
  const queries = options.limit === null ? ordered : ordered.slice(0, options.limit);
  const generatedAt = new Date().toISOString();
  const fileName = options.outputFileName ?? recallReportFileName(generatedAt);

  const target: RecallReportTarget = {
    // 末尾スラッシュを落として記録する。実際の要求も同じ正規化を通る
    baseUrl: options.baseUrl === null ? '(未解決)' : options.baseUrl.replace(/\/+$/, ''),
    endpoints: {
      embed: ENDPOINT_PATHS.embed,
      dynamodb: ENDPOINT_PATHS.dynamodb,
      opensearch: ENDPOINT_PATHS.opensearch,
    },
    vectorTableName: options.vectorTableName,
    queryCacheTableName: options.queryCacheTableName,
    region: options.region ?? null,
    dimensions: options.dimensions,
    warehouseId: options.warehouseId,
    filterDescription:
      options.warehouseId === null
        ? 'フィルタなし（全倉庫）'
        : `warehouseId = ${options.warehouseId} の等価フィルタ`,
    requestTimeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    groundTruthCacheDir: options.groundTruthCacheDir,
    dryRun: options.dryRun,
  };

  if (options.dryRun) {
    process.stdout.write(
      `${formatExecutionPlan({
        target,
        queries,
        languages: options.languages,
        backends: options.backends,
        distinctSkuKValues: options.distinctSkuKValues,
        seed: options.seed,
        outputPath: options.write ? `${options.outputDir}/${fileName}` : '(未書き出し)',
      })}\n`
    );
    return EXIT_CODES.pass;
  }

  if (options.baseUrl === null) {
    process.stderr.write(
      [
        '検索 API のベース URL が解決できません。',
        `--base-url を指定するか、${BASE_URL_ENV_KEYS.join(' または ')} を設定してください。`,
        '接続先を確認するだけなら --dry-run が使えます。',
      ].join('\n') + '\n'
    );
    return EXIT_CODES.error;
  }

  const progress: ProgressReporter = (message) => process.stderr.write(`${message}\n`);

  try {
    const run = await runRecallMeasurement({
      client: createHttpVectorSearchClient({
        baseUrl: options.baseUrl,
        timeoutMs: options.timeoutMs,
        headers: options.headers,
      }),
      queryVectorResolver: createDynamoDbQueryVectorResolver({
        tableName: options.queryCacheTableName,
        region: options.region,
      }),
      vectorRecordSource: createDynamoDbVectorRecordSource({
        tableName: options.vectorTableName,
        region: options.region,
        onProgress: (scanned) => progress(`  Vector_Table を Scan 中… ${scanned} 件`),
      }),
      // `--refresh-ground-truth` でもキャッシュ実装は差し替えない。`forceRefresh` は
      // 「読まずに Scan し、結果でキャッシュを更新する」意味であり、更新まで捨てると
      // 次回の実行が再び 15,000 件の Scan（約 28,500 RRU）を要する
      cache: createFileSystemCache(options.groundTruthCacheDir),
      queries,
      languages: options.languages,
      backends: options.backends,
      distinctSkuKValues: options.distinctSkuKValues,
      dimensions: options.dimensions,
      warehouseId: options.warehouseId,
      forceRefreshGroundTruth: options.refreshGroundTruth,
      failFast: options.failFast,
      maxRetries: options.maxRetries,
      onProgress: progress,
    });

    const evaluationInput: EvaluationInput = {
      samples: run.samples,
      sets: run.sets,
      distinctSkuKValues: options.distinctSkuKValues,
      threshold: options.threshold,
    };
    const evaluation = evaluateSamples(evaluationInput);

    let verified: boolean | null = null;
    let mismatches: readonly string[] = [];
    if (options.verifyReproducibility) {
      progress('再現性の確認: 同一の観測に対して評価を 2 回目実行します…');
      mismatches = compareEvaluations(evaluation, evaluateSamples(evaluationInput));
      verified = mismatches.length === 0;
    }

    let comparison: ReproducibilityComparison | null = null;
    if (options.compareWith !== null) {
      comparison = await compareWithPreviousReportFile(options.compareWith, {
        seed: options.seed,
        queryOrderDigest: digestQueryOrder(queries),
        groundTruthDigest: evaluation.groundTruthDigest,
        recallDigest: evaluation.recallDigest,
      });
    }

    const report = buildRecallReport({
      generatedAt,
      target,
      seed: options.seed,
      queries,
      languages: options.languages,
      backends: options.backends,
      distinctSkuKValues: options.distinctSkuKValues,
      threshold: options.threshold,
      run,
      evaluation,
      verified,
      reproducibilityMismatches: mismatches,
      comparison,
      includeObservations: !options.omitObservations,
    });

    process.stdout.write(`${formatRecallSummary(report)}\n`);

    const json = JSON.stringify(report, null, 2);
    if (options.printJson) {
      process.stdout.write(`\n${json}\n`);
    }
    if (options.write) {
      const writer = createFileSystemReportWriter(options.outputDir);
      const path = await writer.write(fileName, `${json}\n`);
      process.stdout.write(`\nレポートを書き出しました: ${path}\n`);
    }

    return report.verdict.exitCode;
  } catch (error) {
    process.stderr.write(
      [
        '測定を完了できませんでした。',
        describeError(error),
        error instanceof RecallCliError && error.fatal
          ? '中断を要するエラーです。原因を解消してから再実行してください。'
          : '',
      ]
        .filter((line) => line.length > 0)
        .join('\n') + '\n'
    );
    return EXIT_CODES.error;
  }
}

/** 前回のレポートを読み込んでダイジェストを突き合わせる（I/O を伴う薄い層） */
async function compareWithPreviousReportFile(
  file: string,
  current: ReproducibilityDigests
): Promise<ReproducibilityComparison> {
  const fs = await import('node:fs/promises');
  let contents: string;
  try {
    contents = await fs.readFile(file, 'utf8');
  } catch (error) {
    return {
      file,
      previous: null,
      matched: false,
      mismatches: [`前回のレポートを読み込めません: ${describeError(error)}`],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    return {
      file,
      previous: null,
      matched: false,
      mismatches: [`前回のレポートを JSON として解釈できません: ${describeError(error)}`],
    };
  }

  return compareWithPreviousDigests(file, current, parsed);
}

// ============================================================
// 小さなヘルパー
// ============================================================

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function tryParseJsonObject(text: string): Record<string, unknown> | undefined {
  if (text.length === 0) return undefined;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** 有限数のみを受け、それ以外は既定値へ落とす */
function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** ロケール非依存のコードポイント順比較。実行環境で並びが変わらないようにする */
function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** 例外を短い文字列へ変換する */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 既存ファイルによる書き込み失敗か判定する */
function isFileExistsError(error: unknown): boolean {
  return asRecord(error)?.code === 'EEXIST';
}

/**
 * このファイルが直接実行されたかを判定する。
 *
 * `import.meta` は本リポジトリの CJS 実行（tsx）では使えないため、起動引数のパスで判定する。
 * テストから import した場合に `main()` が走らないようにするための門である。
 */
function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') {
    return false;
  }
  return /(^|\/)recall-cli\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.replace(/\\/g, '/'));
}

if (isDirectExecution()) {
  void main(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
