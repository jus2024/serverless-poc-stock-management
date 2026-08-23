/**
 * Measurement_Collector: ベクトル検索比較の測定値を収集する
 *
 * **本スクリプトは読み取り専用である。**呼ぶのは `DescribeTable` / `DescribeContinuousBackups` /
 * `ListTables` / `Scan` / `BatchGetItem` / `SearchVectors`（CloudWatch は
 * `GetMetricStatistics` / `GetMetricData`、AOSS は `ListCollections` / `ListCollectionGroups`、
 * OSIS は `ListPipelines` / `GetPipeline`）だけであり、リソースおよびデータの作成・変更・削除を
 * 一切行わない。`--teardown-check` も削除の**確認**のみを行い、削除は実行しない。
 *
 * 測定モード（1 回の実行でいずれか 1 つを指定する）:
 *
 * | モード | 内容 | 要件 |
 * |---|---|---|
 * | `--pre-check` | 段階 0 の事前確認。OSIS の状態確認と Good_Table スナップショットの保存 | 1.5, 6.9, 6.10 |
 * | `--wait-index` | 2 本のインデックスの ACTIVE 到達とバックフィル完了を**インデックスごとに**待つ | 5.14 |
 * | `--storage` | `TableSizeBytes` の S1 / S2 スナップショットと `IndexSizeBytes` / `ItemCount` の収集と収束判定 | 14.2〜14.6 |
 * | `--capacity` | 同一条件 100 回検索の消費キャパシティと `VectorSearchRequestBytes` | 14.7, 14.8 |
 * | `--ocu` | `SearchOCU` / `IndexingOCU` / `OCUUtilization` の 24 時間分の集計と区間分解 | 7.3, 7.4, 7.6, 7.8, 14.9 |
 * | `--watch-spend` | 累積 OCU-hour × 0.24 USD が 20 USD を初めて超えた時点で測定終了と削除要求 | 7.7 |
 * | `--teardown-check` | 撤収確認チェックリスト（task 15.1） | 1.5, 6.9, 7.4, 7.7, 18.14, 18.15 |
 *
 * 設計上の要点:
 *
 * - **純計算と I/O を分離する。** AWS 呼び出しは {@link DynamoDbMeasurementSource} /
 *   {@link MetricSource} / {@link SearchVectorsProbe} / {@link CollectionInventorySource} /
 *   {@link PipelineStateSource} / {@link MeasurementStore} の各インターフェース越しに行い、
 *   算出はすべて純関数に閉じる。`ground-truth.ts` と `validate-scale-to-zero.ts` と同じ方針であり、
 *   単体テスト（task 11.3）は AWS 認証情報なしで Property 47〜50 を検証できる
 * - **算出の 4 本柱を純関数として公開する。** {@link computeStorageContribution}（Property 47）、
 *   {@link evaluateSnapshotConvergence}（Property 48）、{@link analyzeOcuUsage}（Property 49）、
 *   {@link accumulateSpend}（Property 50）。いずれも AWS にも時刻にも依存しない
 * - **`TableSizeBytes` 差分からインデックスサイズを算出しない。** `IndexSizeBytes` と `ItemCount` は
 *   2 本それぞれから直接取得する（要件 14.3）。差分算出は禁止であり、
 *   {@link VectorIndexSizeTotals.derivedFromTableSizeDifference} に `false` を明示して出力へ残す
 * - **先行するスナップショットを破棄しない。** 収束判定は与えられたスナップショット列を
 *   すべて出力へ含めたまま、直近の連続 2 回を評価する（要件 14.5）
 * - **OCU メトリクスは `GetMetricData` + `SEARCH()` 式で照会する。** `SearchOCU` /
 *   `IndexingOCU` / `OCUUtilization` は Collection 単位では公開されず、実際の系列は
 *   `ClientId` / `CollectionGroupId` / `CollectionGroupName` の **3 次元**を持つ。
 *   `GetMetricStatistics` は次元集合の完全一致を要求するため、`CollectionGroupName` だけを
 *   指定すると**常に空の系列が返る**。次元値の自前解決を不要にするため `SEARCH()` を使い、
 *   Collection Group 名（`--collection-group`）を検索語として絞り込む。選定理由と却下した
 *   代替案は {@link aossOcuSearchExpression} に記録している。照会に用いた式・次元キー集合・
 *   返った系列数とデータ点数は出力へ残し、**データ点 0 件を「0 OCU を測定した」と
 *   読み違えられない文言**で報告する（task 13.4 の Q4 の証跡になる）
 * - **`SearchVectors` は署名付き HTTP で送る。** `probe-range-filter.ts` と同じ方針を採り、
 *   `SearchVectorsCommand` は**使わず**、AWS JSON 1.0 の署名付き HTTP 要求をデュアルスタック
 *   エンドポイント `search-dynamodb.<region>.api.aws` へ直接送る。もう 1 つの候補である
 *   `<account-id>.search-ddb.<region>.amazonaws.com` は AWS アカウント ID を実行環境へ持ち込む
 *   必要があるため採らない（要件 16.9 の趣旨に沿う）。この方針は SDK の版に依存しないため、
 *   `SearchVectorsCommand` が利用可能になっても置き換えない
 *
 * 実行時に遅延 import する SDK（いずれも `3.1112.0` で devDependencies に導入済み）:
 *
 * ```
 * @aws-sdk/client-cloudwatch @aws-sdk/client-opensearchserverless @aws-sdk/client-osis
 * ```
 *
 * 導入済みでも**遅延 import のまま**にする。モジュール指定子を `string` 型の変数越しに渡すため、
 * 当該 SDK を必要としないモード（`--wait-index` / `--storage` / `--capacity`）はこれらを一度も
 * 読み込まず、純関数と注入経路だけを使うテスト経路も AWS 抜きのまま保てる。解決に失敗した
 * 場合のみ導入手順を含むエラーを出して終了する。
 *
 * 使い方:
 *
 * ```
 * npm run vector:measure -- --pre-check
 * npm run vector:measure -- --wait-index
 * npm run vector:measure -- --wait-index --timeout-minutes 180
 * npm run vector:measure -- --storage --label S1
 * npm run vector:measure -- --storage --label S2
 * npm run vector:measure -- --storage            # 収束判定と寄与の算出のみ（新規取得なし）
 * npm run vector:measure -- --capacity --language ja --topk 30
 * npm run vector:measure -- --ocu --hours 24
 * npm run vector:measure -- --watch-spend
 * npm run vector:measure -- --teardown-check
 * ```
 *
 * 要件: 5.14, 7.3, 7.4, 7.6, 7.7, 7.8, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9
 * 設計: Measurement_Collector / 累積課金の監視 / 撤収手順 / Property 47〜50
 */

import { validateDimensions } from '../../amplify/functions/shared/vector/constraints';
import {
  isVectorLanguage,
  resolveIndexName,
  VECTOR_LANGUAGES,
  type VectorLanguage,
} from '../../amplify/functions/shared/vector/language';
import { isValidTopK } from '../../amplify/functions/shared/vector/topk';
// 型のみの取り込み。`VectorIndexDescription` と `VectorCapacity` は
// `@aws-sdk/client-dynamodb` のモデルにあるため、そこから取り込む（ローカルに再定義しない）。
// 型輸入なので実行時にこのパッケージを読み込まない（SDK は遅延 import する）。
import type { VectorCapacity, VectorIndexDescription } from '@aws-sdk/client-dynamodb';

// ============================================================
// 定数: リソース名
// ============================================================

/**
 * Vector_Table の既定名（要件 1.1）。
 *
 * 唯一の定義元は `amplify/custom/dynamodb-tables.ts` だが、あのモジュールは `aws-cdk-lib` を
 * 値として import するため、読み取り専用スクリプトからは参照せず再宣言する
 * （`validate-scale-to-zero.ts` と同じ理由）。
 */
export const DEFAULT_VECTOR_TABLE_NAME = 'kiro-roasters-inventory-vector';

/** Query_Vector_Cache の既定名。撤収確認で不存在を確かめる（task 15.1） */
export const DEFAULT_QUERY_CACHE_TABLE_NAME = 'kiro-vector-query-cache';

/** Good_Table の既定名。**読み取り専用**であり、不変性の確認にのみ使う（要件 1.5） */
export const DEFAULT_GOOD_TABLE_NAME = 'kiro-roasters-inventory-good';

/** Vector_Collection の既定名（要件 6.1） */
export const DEFAULT_VECTOR_COLLECTION_NAME = 'kiro-inventory-vector';

/** Vector_Collection_Group の既定名（要件 6.2） */
export const DEFAULT_VECTOR_COLLECTION_GROUP_NAME = 'kiro-inventory-vector-group';

/** Ingestion_Pipeline の名前。全期間 `STOPPED` を維持する（要件 6.9 / 6.10） */
export const DEFAULT_INGESTION_PIPELINE_NAME = 'kiro-inventory-pipeline';

/** OSIS パイプラインの期待状態。これ以外なら警告を出し、起動も設定変更も行わない（要件 6.10） */
export const EXPECTED_PIPELINE_STATUS = 'STOPPED';

// ============================================================
// 定数: 測定の前提値
// ============================================================

/** Vector_Table のレコード件数（5,000 SKU × 3 倉庫）。1 レコードあたり平均増分の除数（要件 14.2） */
export const VECTOR_RECORD_COUNT = 15_000;

/** Good_Table の期待アイテム件数（要件 1.5） */
export const EXPECTED_GOOD_TABLE_ITEM_COUNT = 15_000;

/** OCU の時間単価（USD）。us-west-2 の単価（要件 7.7） */
export const OCU_HOURLY_USD = 0.24;

/** 累積課金見積の上限（USD）。初めて超えた時点で測定を終了する（要件 7.7） */
export const SPEND_THRESHOLD_USD = 20;

/** OCU メトリクスの取得間隔（秒）。要件 7.3 の 5 分間隔 */
export const OCU_SAMPLE_PERIOD_SECONDS = 300;

/** アイドル OCU 観測の既定の対象時間（時間）。要件 7.3 の 24 時間 */
export const DEFAULT_OCU_WINDOW_HOURS = 24;

/** scale-to-zero 適用可と判定するために必要な連続 0 OCU 区間の長さ（分）（要件 7.4 / 7.6） */
export const SCALE_TO_ZERO_MIN_ZERO_MINUTES = 60;

/** 検索継続区間として出力する最小の長さ（分）（要件 14.9） */
export const SEARCH_ACTIVE_MIN_MINUTES = 30;

/** アイドル区間として出力する最小の長さ（分）。要件 14.9 の連続 6 時間 */
export const IDLE_MIN_MINUTES = 360;

/** スナップショットの採用条件となる相対差の上限。要件 14.4 の 1% */
export const SNAPSHOT_CONVERGENCE_TOLERANCE = 0.01;

/** スナップショット取得の最小間隔（時間）。`TableSizeBytes` の更新周期に合わせる（要件 14.4） */
export const SNAPSHOT_MIN_INTERVAL_HOURS = 6;

/** 収束しない場合の再取得回数の上限。要件 14.5 の最大 3 回 */
export const SNAPSHOT_MAX_REFETCH_ATTEMPTS = 3;

/** 消費キャパシティ測定の検索回数。要件 14.7 の 100 回 */
export const CONSUMED_CAPACITY_SEARCH_COUNT = 100;

/** インデックス待機のポーリング間隔（秒）。要件 5.14 の「60 秒以下」 */
export const INDEX_POLL_INTERVAL_SECONDS = 60;

/** インデックス待機の既定タイムアウト（分）。要件 5.14 の 180 分 */
export const DEFAULT_INDEX_WAIT_TIMEOUT_MINUTES = 180;

/** Good_Table スナップショットで比較するアイテム件数。要件 1.5 の「10 件以上」 */
export const GOOD_TABLE_SAMPLE_ITEM_COUNT = 10;

/** サンプル抽出時に `Scan` で読む件数。抽出後に `itemId#warehouseId` 昇順で先頭 10 件を採る */
export const GOOD_TABLE_SCAN_LIMIT = 40;

/** ベクトル次元数の既定値（要件 3.3 / 5.2） */
export const DEFAULT_EMBEDDING_DIMENSIONS = 1024;

/** 消費キャパシティ測定で使うクエリベクトルの既定シード。100 回すべて同一条件にする */
export const DEFAULT_VECTOR_SEED = 20260101;

/**
 * OCU-hour の保存則を突き合わせる際の許容誤差。
 *
 * 区間ごとの合計と全体の累積は同じ値の集合を異なる順序で足すため、
 * IEEE-754 の丸めにより完全一致しない場合がある。相対 1e-9 は 24 時間分（288 点）の
 * 加算で生じる丸め（相対 1e-15 程度）よりはるかに大きく、実際の欠落や重複計上は
 * この閾値では隠れない。
 */
export const OCU_HOUR_COMPARISON_EPSILON = 1e-9;

// ============================================================
// 定数: メトリクス
// ============================================================

/** OpenSearch Serverless のメトリクス名前空間（要件 7.3） */
export const AOSS_METRIC_NAMESPACE = 'AWS/AOSS';

/** DynamoDB のメトリクス名前空間（要件 14.8） */
export const DYNAMODB_METRIC_NAMESPACE = 'AWS/DynamoDB';

/** 検索 OCU のメトリクス名 */
export const SEARCH_OCU_METRIC = 'SearchOCU';

/** インデックス OCU のメトリクス名 */
export const INDEXING_OCU_METRIC = 'IndexingOCU';

/** 右サイジング判断に使う OCU 使用率のメトリクス名（要件 7.8） */
export const OCU_UTILIZATION_METRIC = 'OCUUtilization';

/** ベクトル検索の転送量メトリクス名（要件 14.8） */
export const VECTOR_SEARCH_REQUEST_BYTES_METRIC = 'VectorSearchRequestBytes';

/**
 * OCU メトリクスの絞り込みに使う次元名。**Collection ではなく Collection Group である。**
 *
 * これは系列を人が指定できる唯一の次元（値が既知の次元）であり、**次元集合の全体ではない**。
 * OCU 系列が実際に持つ次元キー集合は {@link AOSS_OCU_DIMENSION_KEYS} である。
 * 根拠と選定理由は {@link aossOcuSearchExpression} に記録している。
 */
export const AOSS_OCU_DIMENSION_NAME = 'CollectionGroupName';

/**
 * OCU メトリクス（`SearchOCU` / `IndexingOCU` / `OCUUtilization`）が実際に持つ次元キー集合。
 *
 * `GetMetricStatistics` は**次元集合の完全一致**を要求する。したがって
 * `CollectionGroupName` だけを渡す照会は、OCU を実際に消費していても常にデータ点 0 件を返す。
 * この定数は {@link aossOcuSearchExpression} が組み立てる `SEARCH()` のスキーマそのものであり、
 * 「何を訊いたのか」をレポートへ残すためにも使う。
 */
export const AOSS_OCU_DIMENSION_KEYS = [
  'ClientId',
  'CollectionGroupId',
  'CollectionGroupName',
] as const;

/**
 * `SEARCH()` が返す系列へ付ける動的ラベルのテンプレート。
 *
 * `GetMetricData` の `MetricDataResult` は `Dimensions` を返さず `Label` しか返さない。
 * 既定のラベルは系列が 1 本のときはメトリクス名だけになり、どの Collection Group の系列を
 * 測ったのかがレポートから消える。動的ラベルで次元値を焼き込み、
 * 「どの `CollectionGroupId` の系列に何点あったか」を出力から検証できるようにする。
 *
 * `ClientId`（= AWS アカウント ID）は含めない。レポートは `docs/measurements/` へ書き出す
 * 成果物であり、照会条件の再現に不要なアカウント識別子を残さない（要件 16.9 の趣旨）。
 */
export const AOSS_OCU_SERIES_LABEL_TEMPLATE =
  "${PROP('Dim.CollectionGroupName')} / ${PROP('Dim.CollectionGroupId')} / ${PROP('MetricName')}";

/**
 * per-Collection で公開される AOSS メトリクスの次元名。
 *
 * `SearchableDocuments` / `StorageUsedInHot` / `SearchRequest*` などが持つ次元であり、
 * **OCU 系メトリクスはこれを持たない**。本スクリプトは現時点でこれらを取得しないが、
 * 次元名の取り違えを再発させないために両者を並べて宣言している。
 */
export const AOSS_PER_COLLECTION_DIMENSION_NAME = 'CollectionName';

/**
 * `OCUUtilization` が NextGen の Collection Group に対して公開されるかは未確認である旨の注記
 * （要件 7.8）。
 */
export const OCU_UTILIZATION_AVAILABILITY_NOTE =
  `${OCU_UTILIZATION_METRIC} は ${AOSS_METRIC_NAMESPACE} の ListMetrics に現れていない。` +
  'ListMetrics は直近約 14 日にデータのあるメトリクスのみを列挙するため、これは' +
  '「最近この AWS アカウントで公開されていない」ことを意味するに留まり、' +
  '「NextGen の Collection Group では公開されない」ことの証明ではない。' +
  `本スクリプトは OCU 系メトリクスとして他の 2 つと同じ SEARCH() 式（次元キー集合 ` +
  `${AOSS_OCU_DIMENSION_KEYS.join(' / ')}）で照会するため、次元不足による空振りとは区別できる。` +
  `SEARCH() が系列を 1 本も返さない場合は当該メトリクスがそもそも公開されていないことを示し、` +
  '要件 7.8 の右サイジング指標が得られない。Verification_Report にはその旨を測定不能として' +
  '記載する必要がある。';

/**
 * OCU-hour 換算だけでは費用監視が閉じない旨の注記。
 *
 * Vector_Collection には `vectorOptions.ServerlessVectorAcceleration: ENABLED` が付いている。
 * 本スクリプトが積算するのは `SearchOCU` / `IndexingOCU` から導く OCU-hour だけであり、
 * OCU-hour に還元されない課金要素があれば取りこぼす。**単価は未調査であり、金額は推測しない。**
 * 要件 7.7 の 20 USD 閾値ガードは OCU 分の下限見積として扱う。
 */
export const NON_OCU_BILLING_NOTE =
  'Vector_Collection には vectorOptions.ServerlessVectorAcceleration: ENABLED が付いている。' +
  '本モードが積算するのは SearchOCU / IndexingOCU から導く OCU-hour のみであり、' +
  'OCU-hour に還元されない課金要素が存在しうる（単価は未調査。本スクリプトは金額を推測しない）。' +
  `したがって ${SPEND_THRESHOLD_USD} USD 閾値ガードの累積額は OCU 分の下限見積である。` +
  '実費の確定には請求データ（Cost Explorer / Billing の AOSS 利用種別）を用いること。';

// ============================================================
// 定数: SDK と出力
// ============================================================

/** 遅延 import する CloudWatch SDK のパッケージ名 */
export const CLOUDWATCH_SDK_PACKAGE = '@aws-sdk/client-cloudwatch';

/** 遅延 import する OpenSearch Serverless SDK のパッケージ名 */
export const OPENSEARCH_SERVERLESS_SDK_PACKAGE = '@aws-sdk/client-opensearchserverless';

/** 遅延 import する OSIS SDK のパッケージ名 */
export const OSIS_SDK_PACKAGE = '@aws-sdk/client-osis';

/** 未導入の SDK をまとめて導入するコマンド。エラーメッセージと `--help` に載せる */
export const OPTIONAL_SDK_INSTALL_COMMAND =
  `npm install --save-dev ${CLOUDWATCH_SDK_PACKAGE} ${OPENSEARCH_SERVERLESS_SDK_PACKAGE} ${OSIS_SDK_PACKAGE}`;

/** 測定結果の既定の格納先。実行時の CWD からの相対パス */
export const MEASUREMENT_DIR = 'docs/measurements';

/** Good_Table スナップショットの固定ファイル名。`--pre-check` が書き、`--teardown-check` が読む */
export const GOOD_TABLE_SNAPSHOT_FILE = 'good-table-snapshot-pre-check.json';

/** ストレージスナップショット台帳の固定ファイル名。S1 / S2 と再取得を追記していく */
export const STORAGE_SNAPSHOT_STORE_FILE = 'storage-snapshots.json';

/** 出力のスキーマ版。形が変わったら上げる */
export const MEASUREMENT_SCHEMA_VERSION = 1;

/**
 * Good_Table スナップショットのスキーマ版。
 *
 * 版 2 で `region` を追加した。スナップショットは task 13.20 / 15.1 の比較そのものに使う成果物であり、
 * どのリージョンのテーブルを写したものかを自身で示せる必要がある（要件 14.17）。
 *
 * 版 1（`region` なし）で取得済みの基準ファイルは読めなければならない。
 * {@link parseGoodTableSnapshot} は `region` の欠落を null として受け入れ、
 * {@link compareGoodTableSnapshots} は両側が判明している場合にのみリージョンを比較する。
 * 版の違いだけで撤収確認が落ちることはない。
 */
export const GOOD_TABLE_SNAPSHOT_SCHEMA_VERSION = 2;

/** AWS JSON 1.0 プロトコルのターゲットヘッダー値 */
const SEARCH_VECTORS_TARGET = 'DynamoDB_20120810.SearchVectors';

/** 終了コード。注意事項ありを 0 以外にして、見落としたまま次の段階へ進む自動化を防ぐ */
export const EXIT_CODES = {
  /** 測定が完了し、検証担当者の対応を要する事項がない */
  ok: 0,
  /** スクリプト自体の実行に失敗した（SDK 未導入、認証情報なし、API エラー、引数不正） */
  error: 1,
  /** 測定は完了したが対応を要する事項がある（タイムアウト / 未確定 / 20 USD 超過 / 撤収未完了） */
  attention: 2,
} as const;

/** GSI 複製分の差し引きが不要である旨の注記（要件 14.6） */
export const GSI_ADJUSTMENT_NOTE =
  'Vector_Table は GSI を 1 本も持たない（要件 1.1）。したがって TableSizeBytes の差分は ' +
  'ベクトル属性そのものの寄与であり、GSI への複製分を差し引く補正を必要としない。' +
  'GSI が ProjectionType: ALL で存在する場合はベクトル属性が GSI へ複製されて差分が ' +
  '（1 + GSI 本数）倍に膨らむが、本測定にはその項が存在しない。';

/** `IndexSizeBytes` を直接取得する旨の注記（要件 14.3） */
export const INDEX_SIZE_DIRECT_NOTE =
  'IndexSizeBytes と ItemCount は 2 本のインデックスそれぞれの VectorIndexDescription から ' +
  '直接取得した値である。TableSizeBytes スナップショットの差分からは算出していない（要件 14.3）。';

// ============================================================
// エラー
// ============================================================

/** 測定を続行できない状態。SDK 未導入、認証情報の不足、API エラー、引数不正 */
export class MeasurementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeasurementError';
  }
}

// ============================================================
// 型: ストレージ測定
// ============================================================

/** スナップショットの対象フィールド。どちらも約 6 時間周期で更新される（要件 14.4） */
export type StorageField = 'TableSizeBytes' | 'IndexSizeBytes';

/**
 * ストレージスナップショット 1 件。
 *
 * `label` は測定上の位置づけ（`S1` = 埋め込み属性の書き込み開始前、`S2` = 書き込み完了後かつ
 * Vector_Index 作成前、`INDEX` = インデックス作成とバックフィル完了後）を表す。同一 `label` で
 * 複数件あるのは 6 時間間隔での再取得（要件 14.5）に対応する。
 */
export interface StorageSnapshot {
  label: string;
  field: StorageField;
  /** 対象のテーブル名またはインデックス名 */
  target: string;
  value: number;
  /** 取得時刻（UTC の ISO 8601）（要件 14.2） */
  capturedAt: string;
  /** `IndexSizeBytes` の取得時に併せて読んだ `ItemCount`。テーブル側は null */
  itemCount: number | null;
}

/** スナップショット台帳。ファイルへ永続化して 6 時間おきの再取得を積み上げる */
export interface StorageSnapshotStore {
  schemaVersion: number;
  snapshots: readonly StorageSnapshot[];
}

/** 連続 2 回の取得値の比較（要件 14.4） */
export interface SnapshotComparison {
  earlierCapturedAt: string;
  laterCapturedAt: string;
  earlierValue: number;
  laterValue: number;
  /** 取得間隔（時間、小数）。6 時間以上あいている必要がある */
  hoursApart: number;
  intervalSatisfied: boolean;
  /** 相対差。|later - earlier| / max(|earlier|, |later|)。両方 0 のときは 0 */
  relativeDifference: number;
  withinTolerance: boolean;
  /** 採用条件（間隔 6 時間以上 かつ 相対差 1% 以内）を満たすか */
  qualifies: boolean;
}

/** 未確定時に出力する推定誤差幅（要件 14.5） */
export interface SnapshotErrorRange {
  absoluteBytes: number;
  relative: number;
  lowerBytes: number;
  upperBytes: number;
}

/** 収束判定の状態 */
export type SnapshotConvergenceStatus =
  /** 6 時間以上あけた連続 2 回の差が 1% 以内。採用値が確定した */
  | 'converged'
  /** 収束していないが再取得の余地がある。6 時間後に再取得する */
  | 'pending-retry'
  /** 再取得を 3 回行っても収束しなかった。最終取得値を「未確定」として出力する */
  | 'unconverged'
  /** 比較できる連続 2 回がまだない */
  | 'insufficient-samples';

/** 収束判定の結果（要件 14.4 / 14.5、Property 48） */
export interface SnapshotConvergence {
  field: StorageField;
  target: string;
  label: string;
  /** 与えられたスナップショットの全件。**先行するスナップショットを破棄しない**（要件 14.5） */
  snapshots: readonly StorageSnapshot[];
  /** 判定に用いた連続 2 回の比較（時刻昇順） */
  comparisons: readonly SnapshotComparison[];
  status: SnapshotConvergenceStatus;
  /** 採用値。収束していない場合は null */
  adopted: StorageSnapshot | null;
  /** 未確定時の最終取得値。収束時は null */
  finalValue: StorageSnapshot | null;
  /** 採用値が確定しているか。false なら出力に「未確定」を併記する */
  determinate: boolean;
  /** 再取得回数（先頭 2 件を超える件数）。上限 3 回を超えない（Property 48） */
  refetchAttempts: number;
  maxRefetchAttempts: number;
  remainingRefetchAttempts: number;
  tolerance: number;
  minimumIntervalHours: number;
  /** 未確定時の推定誤差幅（要件 14.5）。収束時は null */
  estimatedErrorRange: SnapshotErrorRange | null;
  notes: readonly string[];
}

/** ベクトル属性の寄与（要件 14.2 / 14.6、Property 47） */
export interface StorageContribution {
  s1: StorageSnapshot;
  s2: StorageSnapshot;
  recordCount: number;
  /** ベクトル属性の寄与（S2 − S1） */
  vectorAttributeContributionBytes: number;
  /** 1 レコードあたり平均増分（バイト） */
  averagePerRecordBytes: number;
  /** GSI 複製分の差し引きを行っていないこと。常に false（要件 14.6） */
  gsiAdjustmentApplied: false;
  gsiNote: string;
}

/** 1 本のインデックスのサイズ測定値（要件 14.3） */
export interface VectorIndexSizeMeasurement {
  indexName: string;
  indexSizeBytes: number;
  itemCount: number;
  capturedAt: string;
}

/** 2 本のインデックスのサイズ合計（要件 14.3、Property 47） */
export interface VectorIndexSizeTotals {
  indexes: readonly VectorIndexSizeMeasurement[];
  totalIndexSizeBytes: number;
  totalItemCount: number;
  /** `TableSizeBytes` 差分から算出していないこと。常に false（要件 14.3） */
  derivedFromTableSizeDifference: false;
  note: string;
}

// ============================================================
// 型: OCU 測定
// ============================================================

/** 5 分バケット 1 個の OCU 観測値（要件 7.3） */
export interface OcuSample {
  /** バケット開始時刻（UTC の ISO 8601） */
  timestamp: string;
  searchOcu: number;
  indexingOcu: number;
}

/** 区間の活動区分。検索 OCU が 0 より大きい区間を検索継続区間とする（要件 14.9） */
export type OcuActivityClass = 'search-active' | 'idle';

/** 連続区間 1 つ分（要件 7.4 / 14.9） */
export interface OcuInterval {
  startTime: string;
  /** 最終バケットの終了時刻（開始時刻 + 取得間隔） */
  endTime: string;
  sampleCount: number;
  lengthMinutes: number;
  searchOcuHours: number;
  indexingOcuHours: number;
  /** 区間の消費 OCU-hour（検索 + インデックス） */
  ocuHours: number;
}

/** 活動区分を持つ連続区間。全サンプルがいずれか 1 つの区間に属する（Property 50 の保存則） */
export interface ActivityInterval extends OcuInterval {
  activity: OcuActivityClass;
}

/** 時系列の要約（最小・平均・最大）（要件 7.3 / 7.8） */
export interface SeriesSummary {
  count: number;
  minimum: number | null;
  average: number | null;
  maximum: number | null;
  startTime: string | null;
  endTime: string | null;
}

/** OCU 使用量の分析結果（要件 7.3 / 7.4 / 7.6 / 14.9、Property 49） */
export interface OcuUsageAnalysis {
  periodSeconds: number;
  sampleCount: number;
  startTime: string | null;
  endTime: string | null;
  searchOcu: SeriesSummary;
  indexingOcu: SeriesSummary;
  /** 検索 + インデックスの合計 OCU の要約 */
  combinedOcu: SeriesSummary;
  /** 全サンプルの消費 OCU-hour */
  totalOcuHours: number;
  /** `searchOcu` と `indexingOcu` がともに 0 の連続区間（長さの下限なし） */
  zeroOcuIntervals: readonly OcuInterval[];
  /** 上記のうち 60 分以上のもの。scale-to-zero 判定の根拠（要件 7.4 / 7.6） */
  qualifyingZeroOcuIntervals: readonly OcuInterval[];
  longestZeroOcuMinutes: number;
  /** 0 OCU 区間の合計時間（分）。長さの下限で絞る前の合計（Property 49） */
  totalZeroOcuMinutes: number;
  /** 60 分以上の 0 OCU 区間の合計時間（分）（要件 7.6） */
  qualifyingZeroOcuMinutes: number;
  /** scale-to-zero 適用可否の二値判定（要件 7.4 / 7.6） */
  scaleToZeroApplicable: boolean;
  /** 全サンプルを覆う区間分解。区間の消費 OCU-hour の合計は `totalOcuHours` と一致する */
  activityPartition: readonly ActivityInterval[];
  /** 連続 30 分以上の検索継続区間（要件 14.9） */
  searchActiveIntervals: readonly ActivityInterval[];
  /** 連続 6 時間以上のアイドル区間（要件 14.9） */
  idleIntervals: readonly ActivityInterval[];
  /** 非適用時の常時課金の月額見積（測定平均 OCU × 0.24 USD × 730 h）（要件 7.4） */
  alwaysOnMonthlyUsd: number | null;
}

/** 累積課金の 1 点（Property 50） */
export interface SpendPoint {
  timestamp: string;
  intervalOcuHours: number;
  /** 単調非減少（Property 50） */
  cumulativeOcuHours: number;
  cumulativeUsd: number;
  /** この時点で閾値を初めて超えたか */
  thresholdCrossed: boolean;
}

/** 20 USD 超過時の警告（要件 7.7） */
export interface SpendWarning {
  timestamp: string;
  cumulativeOcuHours: number;
  cumulativeUsd: number;
  thresholdUsd: number;
  message: string;
  /** 削除実行を要求する項目（Collection と Collection Group） */
  requiredActions: readonly string[];
}

/** 累積課金の積算結果（要件 7.7、Property 50） */
export interface SpendAccumulation {
  hourlyUsd: number;
  thresholdUsd: number;
  periodSeconds: number;
  /** 閾値を初めて超えた時点までの積算列。以降は測定を終了して積算しない */
  points: readonly SpendPoint[];
  totalOcuHours: number;
  totalUsd: number;
  warning: SpendWarning | null;
  /** 閾値超過により測定を終了したか */
  terminated: boolean;
  /** 積算に採用したサンプル件数（= 保持した測定値の件数）（要件 7.7） */
  retainedSampleCount: number;
  /** 測定終了により積算しなかったサンプル件数 */
  skippedSampleCount: number;
}

// ============================================================
// 型: 消費キャパシティと転送量
// ============================================================

/** 1 回の検索の結果。消費キャパシティの読み取りに失敗した場合も記録する（要件 14.7） */
export interface SearchProbeSample {
  attempt: number;
  succeeded: boolean;
  /** `ConsumedCapacity.VectorSearchRequestBytes`（バイト）。読み取れない場合は null */
  vectorSearchRequestBytes: number | null;
  /**
   * `ConsumedCapacity.VectorSearchUnits`。SDK の `VectorCapacity` モデルに存在しないため
   * 生応答から読む（要件 8.11）。読み取れない場合は null
   */
  vectorSearchUnits: number | null;
  latencyMs: number;
  errorType: string | null;
  errorMessage: string | null;
}

/**
 * 消費量の集計（要件 14.7）。
 *
 * `SearchVectors` の `ConsumedCapacity` はキャパシティユニットではなく
 * `VectorSearchRequestBytes`（バイト）である。`averagePerSearch` /
 * `minimumPerSearch` / `maximumPerSearch` / `total` の単位は**すべてバイト**である。
 */
export interface ConsumedCapacitySummary {
  /** 使用したクエリ件数。同一条件の 100 回検索ではクエリ 1 件を繰り返す */
  queryCount: number;
  topK: number;
  language: VectorLanguage;
  indexName: string;
  searchCount: number;
  /** `VectorSearchRequestBytes` を読み取れた件数 */
  measuredCount: number;
  failureCount: number;
  /** `VectorSearchRequestBytes` を読み取れなかった成功応答の件数 */
  missingCapacityCount: number;
  /** 1 検索あたり平均（バイト） */
  averagePerSearch: number | null;
  /** 1 検索あたり最小（バイト） */
  minimumPerSearch: number | null;
  /** 1 検索あたり最大（バイト） */
  maximumPerSearch: number | null;
  /** 実行分の合計（バイト）（要件 14.7） */
  total: number;
  /** `VectorSearchUnits` を読み取れた件数（要件 8.11） */
  unitsMeasuredCount: number;
  /** `VectorSearchUnits` の 1 検索あたり平均 */
  unitsAveragePerSearch: number | null;
  unitsMinimumPerSearch: number | null;
  unitsMaximumPerSearch: number | null;
  unitsTotal: number;
  /** 両項目を読み取れた検索のうち、値が一致した件数 */
  unitsEqualRequestBytesCount: number;
  /** 両項目を読み取れた検索のうち、値が食い違った件数 */
  unitsDivergentCount: number;
  /**
   * `VectorSearchUnits` が常に `VectorSearchRequestBytes` と等しかったか（task 13.18 の観測項目）。
   *
   * 両項目を読み取れた検索が 1 件も無い場合は「観測できていない」ことを示す null。
   * 食い違いが無いことを 0 件比較から主張しないための明示的な区別である。
   */
  unitsAlwaysEqualRequestBytes: boolean | null;
  /** 食い違った検索の内訳。無ければ空配列 */
  unitsDivergences: readonly { attempt: number; requestBytes: number; units: number }[];
  measurementStartedAt: string;
  measurementEndedAt: string;
}

/** `VectorSearchRequestBytes` の集計（要件 14.8） */
export interface RequestBytesSummary {
  tableName: string;
  indexName: string;
  windowStart: string;
  windowEnd: string;
  dataPointCount: number;
  totalBytes: number;
  /** 1 検索あたり平均。検索回数が 0 の場合は null */
  averagePerSearchBytes: number | null;
}

// ============================================================
// 型: インデックス待機
// ============================================================

/**
 * バックフィル完了までの経過時間が測定不能である理由（要件 5.17、設計 V20）。
 *
 * task 13.12 の実測で `DescribeTable` の `VectorIndexDescription` に `Backfilling` キーが
 * 一度も現れなかった。判定（`Backfilling !== true`）は「不在 = 偽」として成立するが、
 * **`true → false` の遷移を観測していない以上、完了までの経過時間は測定できない。**
 * 不在を偽と同一視したまま経過秒を記録すると、ACTIVE 到達時刻を
 * バックフィル完了時刻として写した無意味な数値が測定値として残る。
 */
export const BACKFILL_UNMEASURABLE_REASON =
  'DescribeTable の VectorIndexDescription に Backfilling フィールドが存在しなかったため、' +
  'バックフィル完了までの経過時間は測定不能である（要件 5.17、設計 V20）。' +
  '検索可否の判定は「不在 = 偽」として成立するが、0 秒や即時完了として記録しない。';

/** 1 本のインデックスの待機記録（要件 5.14 / 5.17） */
export interface IndexReadinessRecord {
  indexName: string;
  pollStartedAt: string;
  /** `IndexStatus` が ACTIVE に到達した時点（要件 5.14） */
  activeReachedAt: string | null;
  /** ポーリング開始から ACTIVE 到達までの経過秒 */
  activeElapsedSeconds: number | null;
  /** `Backfilling` が偽になった時点。フィールドが不在の場合は測定不能であり null のまま */
  backfillCompletedAt: string | null;
  /**
   * ポーリング開始からバックフィル完了までの経過秒（要件 5.14）。
   * `Backfilling` フィールドが不在の場合は測定不能であり null のままにする（要件 5.17）
   */
  backfillElapsedSeconds: number | null;
  /** ACTIVE 到達からバックフィル完了までの経過秒。測定不能の場合は null */
  activeToBackfillSeconds: number | null;
  finalIndexStatus: string;
  finalBackfilling: boolean;
  /**
   * `Backfilling` フィールドが 1 度でも `DescribeTable` の応答に存在したか（要件 5.17、V20）。
   * 実測では 2 本とも一度も存在しなかった
   */
  backfillingFieldPresent: boolean;
  /**
   * バックフィル完了までの経過時間が測定できたか（要件 5.17）。
   * `Backfilling` フィールドが一度も返らなかった場合は false = 測定不能
   */
  backfillMeasurable: boolean;
  /** 測定不能である理由。測定できた場合は null（{@link BACKFILL_UNMEASURABLE_REASON}） */
  backfillUnmeasurableReason: string | null;
  /** ACTIVE かつ Backfilling が偽（不在は偽として扱う）（V5、要件 5.15 / 5.17） */
  searchable: boolean;
  timedOut: boolean;
  pollCount: number;
  /** タイムアウト時のエラー文（要件 5.14）。それ以外は null */
  error: string | null;
}

/** `DescribeTable` から読んだインデックスの状態 */
export interface VectorIndexState {
  indexName: string;
  indexStatus: string;
  /** `Backfilling` が真か。フィールドが不在の場合は偽として扱う（要件 5.17、V20） */
  backfilling: boolean;
  /** `Backfilling` フィールドが応答に存在したか（要件 5.17、V20） */
  backfillingPresent: boolean;
  searchable: boolean;
  indexSizeBytes: number | null;
  itemCount: number | null;
}

/**
 * `Backfilling` の観測値を出力用の文字列にする（要件 5.15 / 5.17）。
 * フィールドが不在だった場合は偽と書かず、不在であったことを明示する。
 */
export function formatBackfillingObservation(observation: {
  finalBackfilling: boolean;
  backfillingFieldPresent: boolean;
}): string {
  return observation.backfillingFieldPresent
    ? String(observation.finalBackfilling)
    : '(フィールド不在)';
}

// ============================================================
// 型: Good_Table スナップショット
// ============================================================

/** GSI 1 本の定義（要件 1.5） */
export interface GsiSnapshot {
  indexName: string;
  keySchema: readonly string[];
  projectionType: string;
  nonKeyAttributes: readonly string[];
}

/** 抽出アイテム 1 件の要約（要件 1.5） */
export interface SampleItemSnapshot {
  /** `itemId#warehouseId`。比較のキー */
  key: string;
  itemId: string;
  warehouseId: string;
  /** 属性名の集合（昇順） */
  attributeNames: readonly string[];
  /** アイテムサイズ（バイト）。{@link estimateItemSizeBytes} による同一アルゴリズムの推定値 */
  itemSizeBytes: number;
}

/** Good_Table のスナップショット。段階 0 で保存し、段階 15 と撤収時に突き合わせる（要件 1.5） */
export interface GoodTableSnapshot {
  schemaVersion: number;
  tableName: string;
  /** 取得時の実効リージョン。版 1 のスナップショットには無いため null になり得る */
  region: string | null;
  capturedAt: string;
  /** `PK, SK` の順に `属性名:キー種別` を並べたもの */
  keySchema: readonly string[];
  globalSecondaryIndexes: readonly GsiSnapshot[];
  streamEnabled: boolean;
  streamViewType: string | null;
  pointInTimeRecoveryStatus: string;
  /** `DescribeTable` の `ItemCount`（約 6 時間周期で更新される概数） */
  itemCount: number;
  sampleItems: readonly SampleItemSnapshot[];
}

/** スナップショット比較の相違点 1 件 */
export interface SnapshotDifference {
  field: string;
  baseline: string;
  current: string;
}

/** スナップショット比較の結果（要件 1.5） */
export interface GoodTableComparison {
  identical: boolean;
  baselineCapturedAt: string;
  currentCapturedAt: string;
  /** 突き合わせできた抽出アイテムの件数 */
  comparedItemCount: number;
  /** 基準側にあり現在側で取得できなかったキー */
  missingItemKeys: readonly string[];
  differences: readonly SnapshotDifference[];
}

// ============================================================
// 純関数: 小さなユーティリティ
// ============================================================

/** ISO 8601 文字列をエポックミリ秒へ変換する。解釈できない場合は例外にする */
export function toEpochMs(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    throw new MeasurementError(`時刻として解釈できません: ${JSON.stringify(timestamp)}`);
  }
  return parsed;
}

/** エポックミリ秒を UTC の ISO 8601 文字列へ変換する */
export function toIsoString(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** 2 時点の間隔（時間、小数）。負にもなり得るため絶対値は取らない */
export function hoursBetween(earlier: string, later: string): number {
  return (toEpochMs(later) - toEpochMs(earlier)) / 3_600_000;
}

/**
 * 相対差を求める。分母は 2 値の絶対値の大きい方とする。
 *
 * 分母に先行値を使うと、先行値が 0 のとき（インデックス作成直後など）に定義できない。
 * 大きい方を分母にすると常に 0〜1 の範囲に収まり、両方 0 のときも 0 と定義できる。
 */
export function relativeDifference(earlier: number, later: number): number {
  const scale = Math.max(Math.abs(earlier), Math.abs(later));
  return scale === 0 ? 0 : Math.abs(later - earlier) / scale;
}

/** 時系列の要約（最小・平均・最大）を求める（要件 7.3 / 7.8） */
export function summarizeSeries(
  values: readonly number[],
  startTime: string | null = null,
  endTime: string | null = null
): SeriesSummary {
  if (values.length === 0) {
    return { count: 0, minimum: null, average: null, maximum: null, startTime, endTime };
  }

  let minimum = values[0];
  let maximum = values[0];
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
    sum += value;
  }

  return { count: values.length, minimum, average: sum / values.length, maximum, startTime, endTime };
}

// ============================================================
// 純関数: ストレージ寄与（Property 47）
// ============================================================

/**
 * ベクトル属性の寄与と 1 レコードあたり平均増分を求める（要件 14.2 / 14.6、Property 47）。
 *
 * 寄与は `TableSizeBytes` の 2 時点の差そのものであり、**GSI 複製分を差し引く項を含まない**。
 * Vector_Table は GSI を 1 本も持たないため（要件 1.1）、差分がそのままベクトル属性の寄与になる。
 * この事実を {@link StorageContribution.gsiNote} として出力へ載せる（要件 14.6）。
 *
 * 引数の順序を取り違えて負の寄与が出た場合は例外にしない。埋め込み属性の書き込み以外の
 * 要因（TTL による削除など）で縮むことは理屈上あり得るため、値をそのまま返して
 * 呼び出し側の出力で判断できるようにする。
 */
export function computeStorageContribution(
  s1: StorageSnapshot,
  s2: StorageSnapshot,
  recordCount: number = VECTOR_RECORD_COUNT
): StorageContribution {
  if (!Number.isFinite(recordCount) || recordCount <= 0) {
    throw new MeasurementError(
      `レコード件数は正の有限数である必要があります（指定値: ${String(recordCount)}）。`
    );
  }

  const vectorAttributeContributionBytes = s2.value - s1.value;

  return {
    s1,
    s2,
    recordCount,
    vectorAttributeContributionBytes,
    averagePerRecordBytes: vectorAttributeContributionBytes / recordCount,
    gsiAdjustmentApplied: false,
    gsiNote: GSI_ADJUSTMENT_NOTE,
  };
}

/**
 * 2 本のインデックスの `IndexSizeBytes` と `ItemCount` を合計する（要件 14.3、Property 47）。
 *
 * 各値は `VectorIndexDescription` から直接取得したものであり、`TableSizeBytes` の差分からは
 * 算出しない。その事実を {@link VectorIndexSizeTotals.derivedFromTableSizeDifference} に
 * `false` として明示し、出力に残す。
 */
export function computeIndexSizeTotals(
  indexes: readonly VectorIndexSizeMeasurement[]
): VectorIndexSizeTotals {
  let totalIndexSizeBytes = 0;
  let totalItemCount = 0;
  for (let i = 0; i < indexes.length; i += 1) {
    totalIndexSizeBytes += indexes[i].indexSizeBytes;
    totalItemCount += indexes[i].itemCount;
  }

  return {
    indexes: indexes.slice(),
    totalIndexSizeBytes,
    totalItemCount,
    derivedFromTableSizeDifference: false,
    note: INDEX_SIZE_DIRECT_NOTE,
  };
}

// ============================================================
// 純関数: 収束判定（Property 48）
// ============================================================

/** 連続 2 回の取得値を比較する（要件 14.4） */
export function compareSnapshots(
  earlier: StorageSnapshot,
  later: StorageSnapshot,
  tolerance: number = SNAPSHOT_CONVERGENCE_TOLERANCE,
  minimumIntervalHours: number = SNAPSHOT_MIN_INTERVAL_HOURS
): SnapshotComparison {
  const hoursApart = hoursBetween(earlier.capturedAt, later.capturedAt);
  const intervalSatisfied = hoursApart >= minimumIntervalHours;
  const difference = relativeDifference(earlier.value, later.value);
  const withinTolerance = difference <= tolerance;

  return {
    earlierCapturedAt: earlier.capturedAt,
    laterCapturedAt: later.capturedAt,
    earlierValue: earlier.value,
    laterValue: later.value,
    hoursApart,
    intervalSatisfied,
    relativeDifference: difference,
    withinTolerance,
    qualifies: intervalSatisfied && withinTolerance,
  };
}

/**
 * スナップショット列の収束を判定する（要件 14.4 / 14.5、Property 48）。
 *
 * 判定手順:
 *
 * 1. 取得時刻の昇順に並べる（**入力を破棄せず、全件を出力へ含める**）
 * 2. 隣接する 2 件を古い方から順に比較し、間隔が 6 時間以上かつ相対差が 1% 以内の組が
 *    現れた時点でその後者を採用値とする
 * 3. 現れない場合は未確定とする。再取得回数（先頭 2 件を超える件数）が 3 回未満なら
 *    `pending-retry`（6 時間後に再取得する）、3 回に達していれば `unconverged` とし、
 *    最終取得値と推定誤差幅を出力する
 *
 * 再取得回数が上限 3 回を超えて渡された場合、判定には先頭 5 件（初回 2 件 + 再取得 3 回）
 * までを使い、超過分は保持したうえで判定に用いない。これにより
 * 「再取得回数は 3 回を超えない」（Property 48）が入力によらず成り立つ。
 */
export function evaluateSnapshotConvergence(
  snapshots: readonly StorageSnapshot[],
  options: {
    tolerance?: number;
    minimumIntervalHours?: number;
    maxRefetchAttempts?: number;
  } = {}
): SnapshotConvergence {
  const tolerance = options.tolerance ?? SNAPSHOT_CONVERGENCE_TOLERANCE;
  const minimumIntervalHours = options.minimumIntervalHours ?? SNAPSHOT_MIN_INTERVAL_HOURS;
  const maxRefetchAttempts = options.maxRefetchAttempts ?? SNAPSHOT_MAX_REFETCH_ATTEMPTS;

  if (snapshots.length === 0) {
    throw new MeasurementError('収束判定には少なくとも 1 件のスナップショットが必要です。');
  }

  const ordered = snapshots
    .slice()
    .sort((left, right) => toEpochMs(left.capturedAt) - toEpochMs(right.capturedAt));
  const first = ordered[0];
  const notes: string[] = [];

  // 判定に使うのは初回 2 件 + 再取得 3 回まで。超過分は保持するが判定には用いない
  const usableCount = Math.min(ordered.length, 2 + maxRefetchAttempts);
  if (ordered.length > usableCount) {
    notes.push(
      `スナップショットが ${ordered.length} 件あり、再取得上限 ${maxRefetchAttempts} 回を超えています。` +
        `判定には取得時刻の古い順に ${usableCount} 件を用い、残り ${ordered.length - usableCount} 件は` +
        '記録として保持します（先行するスナップショットは破棄しません）。'
    );
  }

  const considered = ordered.slice(0, usableCount);
  const refetchAttempts = Math.max(0, considered.length - 2);
  const comparisons: SnapshotComparison[] = [];
  let adopted: StorageSnapshot | null = null;

  for (let i = 1; i < considered.length; i += 1) {
    const comparison = compareSnapshots(
      considered[i - 1],
      considered[i],
      tolerance,
      minimumIntervalHours
    );
    comparisons.push(comparison);
    if (adopted === null && comparison.qualifies) {
      adopted = considered[i];
    }
  }

  const base = {
    field: first.field,
    target: first.target,
    label: first.label,
    snapshots: ordered,
    comparisons,
    refetchAttempts,
    maxRefetchAttempts,
    remainingRefetchAttempts: Math.max(0, maxRefetchAttempts - refetchAttempts),
    tolerance,
    minimumIntervalHours,
  } as const;

  if (comparisons.length === 0) {
    notes.push(
      `スナップショットが ${ordered.length} 件しかありません。採用値の確定には ` +
        `${minimumIntervalHours} 時間以上あけた連続 2 回の取得が必要です（要件 14.4）。`
    );
    return {
      ...base,
      status: 'insufficient-samples',
      adopted: null,
      finalValue: ordered[ordered.length - 1],
      determinate: false,
      estimatedErrorRange: null,
      notes,
    };
  }

  if (adopted !== null) {
    return {
      ...base,
      status: 'converged',
      adopted,
      finalValue: null,
      determinate: true,
      estimatedErrorRange: null,
      notes,
    };
  }

  const last = comparisons[comparisons.length - 1];
  const finalValue = considered[considered.length - 1];
  const errorRange = buildErrorRange(finalValue.value, last.relativeDifference);

  if (!last.intervalSatisfied) {
    notes.push(
      `直近 2 回の取得間隔が ${formatNumber(last.hoursApart, 2)} 時間で、必要な ` +
        `${minimumIntervalHours} 時間に達していません。${SNAPSHOT_MIN_INTERVAL_HOURS} 時間以上あけて再取得してください。`
    );
  }

  if (refetchAttempts >= maxRefetchAttempts) {
    notes.push(
      `再取得を上限の ${maxRefetchAttempts} 回まで実施しましたが相対差が ` +
        `${formatPercent(last.relativeDifference)} で ${formatPercent(tolerance)} 以内に収束しません。` +
        '最終取得値を「未確定」として出力し、推定誤差幅を併記します（要件 14.5）。'
    );
    return {
      ...base,
      status: 'unconverged',
      adopted: null,
      finalValue,
      determinate: false,
      estimatedErrorRange: errorRange,
      notes,
    };
  }

  notes.push(
    `直近 2 回の相対差が ${formatPercent(last.relativeDifference)} で ` +
      `${formatPercent(tolerance)} を超えています。未確定として記録し、` +
      `${minimumIntervalHours} 時間後に再取得してください（残り ${maxRefetchAttempts - refetchAttempts} 回）。`
  );

  return {
    ...base,
    status: 'pending-retry',
    adopted: null,
    finalValue,
    determinate: false,
    estimatedErrorRange: errorRange,
    notes,
  };
}

/** 未確定時の推定誤差幅を組み立てる（要件 14.5） */
function buildErrorRange(value: number, relative: number): SnapshotErrorRange {
  const absoluteBytes = Math.abs(value) * relative;
  return {
    absoluteBytes,
    relative,
    lowerBytes: value - absoluteBytes,
    upperBytes: value + absoluteBytes,
  };
}

/** 台帳から対象のスナップショットを抜き出す（label / field / target の完全一致） */
export function selectSnapshots(
  store: StorageSnapshotStore,
  criteria: { label: string; field: StorageField; target: string }
): readonly StorageSnapshot[] {
  return store.snapshots
    .filter(
      (snapshot) =>
        snapshot.label === criteria.label &&
        snapshot.field === criteria.field &&
        snapshot.target === criteria.target
    )
    .sort((left, right) => toEpochMs(left.capturedAt) - toEpochMs(right.capturedAt));
}

/** 台帳へスナップショットを追記する（既存を書き換えない。要件 14.5） */
export function appendSnapshots(
  store: StorageSnapshotStore,
  snapshots: readonly StorageSnapshot[]
): StorageSnapshotStore {
  return {
    schemaVersion: MEASUREMENT_SCHEMA_VERSION,
    snapshots: store.snapshots.concat(snapshots),
  };
}

/** 空の台帳 */
export function emptySnapshotStore(): StorageSnapshotStore {
  return { schemaVersion: MEASUREMENT_SCHEMA_VERSION, snapshots: [] };
}

// ============================================================
// 純関数: OCU 区間の検出（Property 49）
// ============================================================

/** 1 サンプルの消費 OCU-hour */
export function sampleOcuHours(
  sample: OcuSample,
  periodSeconds: number = OCU_SAMPLE_PERIOD_SECONDS
): number {
  return ((sample.searchOcu + sample.indexingOcu) * periodSeconds) / 3600;
}

/** サンプル列の消費 OCU-hour。加算順序を時刻昇順に固定して結果を再現可能にする */
export function sumOcuHours(
  samples: readonly OcuSample[],
  periodSeconds: number = OCU_SAMPLE_PERIOD_SECONDS
): number {
  let total = 0;
  for (let i = 0; i < samples.length; i += 1) {
    total += sampleOcuHours(samples[i], periodSeconds);
  }
  return total;
}

/** 時刻昇順に並べ替える。同一時刻は入力順を保つ */
export function sortOcuSamples(samples: readonly OcuSample[]): readonly OcuSample[] {
  return samples
    .map((sample, index) => ({ sample, index }))
    .sort((left, right) => {
      const delta = toEpochMs(left.sample.timestamp) - toEpochMs(right.sample.timestamp);
      return delta !== 0 ? delta : left.index - right.index;
    })
    .map((entry) => entry.sample);
}

/**
 * 連続するサンプルを区分ごとにまとめる。
 *
 * 「連続」は区分が同一であることと、直前のサンプルとの時刻差が取得間隔と一致することの
 * 両方を要求する。CloudWatch がデータ点を返さなかった区間（欠測）は連続性を切る。
 * 欠測を 0 とみなして繋いでしまうと、実際には観測できていない時間帯を
 * 「0 OCU が続いた」と誤って主張することになるためである。
 */
function groupContiguous<K extends string>(
  samples: readonly OcuSample[],
  classify: (sample: OcuSample) => K,
  periodSeconds: number
): readonly { key: K; samples: readonly OcuSample[] }[] {
  const ordered = sortOcuSamples(samples);
  const groups: { key: K; samples: OcuSample[] }[] = [];
  const stepMs = periodSeconds * 1000;
  let previousStart = Number.NaN;

  for (let i = 0; i < ordered.length; i += 1) {
    const sample = ordered[i];
    const start = toEpochMs(sample.timestamp);
    const key = classify(sample);
    const current = groups.length === 0 ? null : groups[groups.length - 1];
    const contiguous =
      current !== null && current.key === key && start - previousStart === stepMs;

    if (contiguous && current !== null) {
      current.samples.push(sample);
    } else {
      groups.push({ key, samples: [sample] });
    }
    previousStart = start;
  }

  return groups;
}

/** サンプル列から区間 1 つ分を組み立てる */
function buildInterval(samples: readonly OcuSample[], periodSeconds: number): OcuInterval {
  const ordered = sortOcuSamples(samples);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  let searchOcuSum = 0;
  let indexingOcuSum = 0;
  for (let i = 0; i < ordered.length; i += 1) {
    searchOcuSum += ordered[i].searchOcu;
    indexingOcuSum += ordered[i].indexingOcu;
  }
  const hoursPerSample = periodSeconds / 3600;

  return {
    startTime: first.timestamp,
    endTime: toIsoString(toEpochMs(last.timestamp) + periodSeconds * 1000),
    sampleCount: ordered.length,
    lengthMinutes: (ordered.length * periodSeconds) / 60,
    searchOcuHours: searchOcuSum * hoursPerSample,
    indexingOcuHours: indexingOcuSum * hoursPerSample,
    ocuHours: sumOcuHours(ordered, periodSeconds),
  };
}

/**
 * 条件を満たす連続区間を求める（要件 7.4 / 14.9）。
 *
 * `minimumMinutes` は出力に載せる下限であり、0 を渡すとすべての連続区間を返す。
 * Property 49 が要求する「0 区間の合計時間が実際の合計と等しい」ことを検証するには
 * 下限 0 で全区間を取得して合計する。
 */
export function findContiguousIntervals(
  samples: readonly OcuSample[],
  predicate: (sample: OcuSample) => boolean,
  options: { minimumMinutes?: number; periodSeconds?: number } = {}
): readonly OcuInterval[] {
  const periodSeconds = options.periodSeconds ?? OCU_SAMPLE_PERIOD_SECONDS;
  const minimumMinutes = options.minimumMinutes ?? 0;

  return groupContiguous(samples, (sample) => (predicate(sample) ? 'match' : 'other'), periodSeconds)
    .filter((group) => group.key === 'match')
    .map((group) => buildInterval(group.samples, periodSeconds))
    .filter((interval) => interval.lengthMinutes >= minimumMinutes);
}

/**
 * 全サンプルを検索継続区間とアイドル区間へ分解する（要件 14.9、Property 50 の保存則）。
 *
 * 区分は `searchOcu > 0` を検索継続、`searchOcu === 0` をアイドルとする。要件 14.9 の
 * アイドル区間は「検索を一切実行しない」区間であり、インデックス OCU は問わない。
 * したがってアイドル区間の消費 OCU-hour は 0 とは限らず、その値自体が測定対象になる。
 *
 * すべてのサンプルがいずれか 1 つの区間に属するため、区間の消費 OCU-hour の合計は
 * 全体の消費 OCU-hour と一致する（浮動小数の丸め誤差の範囲で）。
 */
export function partitionByActivity(
  samples: readonly OcuSample[],
  periodSeconds: number = OCU_SAMPLE_PERIOD_SECONDS
): readonly ActivityInterval[] {
  return groupContiguous(
    samples,
    (sample): OcuActivityClass => (sample.searchOcu > 0 ? 'search-active' : 'idle'),
    periodSeconds
  ).map((group) => ({ ...buildInterval(group.samples, periodSeconds), activity: group.key }));
}

/** 区間列の消費 OCU-hour の合計。保存則の突き合わせに使う */
export function sumIntervalOcuHours(intervals: readonly OcuInterval[]): number {
  let total = 0;
  for (let i = 0; i < intervals.length; i += 1) {
    total += intervals[i].ocuHours;
  }
  return total;
}

/** 区間列の長さ（分）の合計 */
export function sumIntervalMinutes(intervals: readonly OcuInterval[]): number {
  let total = 0;
  for (let i = 0; i < intervals.length; i += 1) {
    total += intervals[i].lengthMinutes;
  }
  return total;
}

/**
 * OCU 時系列を分析する（要件 7.3 / 7.4 / 7.6 / 7.8 / 14.9、Property 49）。
 *
 * scale-to-zero 適用可と判定するのは、`searchOcu` と `indexingOcu` が**ともに 0** である
 * 連続区間の最大長が 60 分以上である場合に限る（要件 7.4 / 7.6）。判定に使った 0 OCU 区間の
 * 合計時間（`totalZeroOcuMinutes`）は長さで絞る前の全 0 区間の合計であり、
 * 実際の 0 サンプル数 × 取得間隔と一致する。
 */
export function analyzeOcuUsage(
  samples: readonly OcuSample[],
  options: { periodSeconds?: number; hourlyUsd?: number; hoursPerMonth?: number } = {}
): OcuUsageAnalysis {
  const periodSeconds = options.periodSeconds ?? OCU_SAMPLE_PERIOD_SECONDS;
  const hourlyUsd = options.hourlyUsd ?? OCU_HOURLY_USD;
  const hoursPerMonth = options.hoursPerMonth ?? 730;
  const ordered = sortOcuSamples(samples);

  const startTime = ordered.length === 0 ? null : ordered[0].timestamp;
  const endTime =
    ordered.length === 0
      ? null
      : toIsoString(toEpochMs(ordered[ordered.length - 1].timestamp) + periodSeconds * 1000);

  const searchValues = ordered.map((sample) => sample.searchOcu);
  const indexingValues = ordered.map((sample) => sample.indexingOcu);
  const combinedValues = ordered.map((sample) => sample.searchOcu + sample.indexingOcu);

  const zeroOcuIntervals = findContiguousIntervals(
    ordered,
    (sample) => sample.searchOcu === 0 && sample.indexingOcu === 0,
    { periodSeconds }
  );
  const qualifyingZeroOcuIntervals = zeroOcuIntervals.filter(
    (interval) => interval.lengthMinutes >= SCALE_TO_ZERO_MIN_ZERO_MINUTES
  );
  const longestZeroOcuMinutes = zeroOcuIntervals.reduce(
    (longest, interval) => (interval.lengthMinutes > longest ? interval.lengthMinutes : longest),
    0
  );

  const activityPartition = partitionByActivity(ordered, periodSeconds);
  const combinedSummary = summarizeSeries(combinedValues, startTime, endTime);
  const scaleToZeroApplicable = longestZeroOcuMinutes >= SCALE_TO_ZERO_MIN_ZERO_MINUTES;

  return {
    periodSeconds,
    sampleCount: ordered.length,
    startTime,
    endTime,
    searchOcu: summarizeSeries(searchValues, startTime, endTime),
    indexingOcu: summarizeSeries(indexingValues, startTime, endTime),
    combinedOcu: combinedSummary,
    totalOcuHours: sumOcuHours(ordered, periodSeconds),
    zeroOcuIntervals,
    qualifyingZeroOcuIntervals,
    longestZeroOcuMinutes,
    totalZeroOcuMinutes: sumIntervalMinutes(zeroOcuIntervals),
    qualifyingZeroOcuMinutes: sumIntervalMinutes(qualifyingZeroOcuIntervals),
    scaleToZeroApplicable,
    activityPartition,
    searchActiveIntervals: activityPartition.filter(
      (interval) =>
        interval.activity === 'search-active' && interval.lengthMinutes >= SEARCH_ACTIVE_MIN_MINUTES
    ),
    idleIntervals: activityPartition.filter(
      (interval) => interval.activity === 'idle' && interval.lengthMinutes >= IDLE_MIN_MINUTES
    ),
    // 要件 7.4: 非適用時は測定した平均 OCU による常時課金の月額見積を出す
    alwaysOnMonthlyUsd:
      scaleToZeroApplicable || combinedSummary.average === null
        ? null
        : combinedSummary.average * hourlyUsd * hoursPerMonth,
  };
}

// ============================================================
// 純関数: 累積課金（Property 50）
// ============================================================

/**
 * OCU-hour を積算し、閾値を初めて超えた時点で測定を終了する（要件 7.7、Property 50）。
 *
 * 累積 OCU-hour は各サンプルの消費量（非負）を時刻昇順に足すため単調非減少である。
 * 閾値超過の判定は `累積 OCU-hour × 単価 > 閾値` を初めて満たした点であり、
 * その点までの測定値を保持したまま以降のサンプルを積算しない。
 * 「測定を終了する」ことを、積算列をその点で打ち切ることとして表現している。
 *
 * 本スクリプトは削除を実行しない。警告は Vector_Collection と Vector_Collection_Group の
 * 削除**実行を要求する**ものであり、実行は検証担当者が行う。
 */
export function accumulateSpend(
  samples: readonly OcuSample[],
  options: {
    periodSeconds?: number;
    hourlyUsd?: number;
    thresholdUsd?: number;
    collectionName?: string;
    collectionGroupName?: string;
  } = {}
): SpendAccumulation {
  const periodSeconds = options.periodSeconds ?? OCU_SAMPLE_PERIOD_SECONDS;
  const hourlyUsd = options.hourlyUsd ?? OCU_HOURLY_USD;
  const thresholdUsd = options.thresholdUsd ?? SPEND_THRESHOLD_USD;
  const collectionName = options.collectionName ?? DEFAULT_VECTOR_COLLECTION_NAME;
  const collectionGroupName = options.collectionGroupName ?? DEFAULT_VECTOR_COLLECTION_GROUP_NAME;

  const ordered = sortOcuSamples(samples);
  const points: SpendPoint[] = [];
  let cumulativeOcuHours = 0;
  let warning: SpendWarning | null = null;

  for (let i = 0; i < ordered.length; i += 1) {
    const intervalOcuHours = sampleOcuHours(ordered[i], periodSeconds);
    cumulativeOcuHours += intervalOcuHours;
    const cumulativeUsd = cumulativeOcuHours * hourlyUsd;
    const crossed = warning === null && cumulativeUsd > thresholdUsd;

    points.push({
      timestamp: ordered[i].timestamp,
      intervalOcuHours,
      cumulativeOcuHours,
      cumulativeUsd,
      thresholdCrossed: crossed,
    });

    if (crossed) {
      warning = {
        timestamp: ordered[i].timestamp,
        cumulativeOcuHours,
        cumulativeUsd,
        thresholdUsd,
        message:
          `累積 OCU 課金見積が ${formatUsd(cumulativeUsd)} USD となり、上限 ${thresholdUsd} USD を超えました` +
          `（累積 ${formatNumber(cumulativeOcuHours, 4)} OCU-hour × ${hourlyUsd} USD）。` +
          'この時点で測定を終了します。ここまでの測定値は保持しています（要件 7.7）。',
        requiredActions: [
          `Vector_Collection「${collectionName}」を削除してください。`,
          `Vector_Collection_Group「${collectionGroupName}」を削除してください。`,
          '削除順序と削除完了の確認は npm run vector:measure -- --teardown-check で行います' +
            '（本スクリプトは削除を実行しません）。',
        ],
      };
      break;
    }
  }

  const retainedSampleCount = points.length;

  return {
    hourlyUsd,
    thresholdUsd,
    periodSeconds,
    points,
    totalOcuHours: cumulativeOcuHours,
    totalUsd: cumulativeOcuHours * hourlyUsd,
    warning,
    terminated: warning !== null,
    retainedSampleCount,
    skippedSampleCount: ordered.length - retainedSampleCount,
  };
}

/**
 * 2 本のメトリクス列を 5 分バケットで突き合わせる。
 *
 * 片方にしかデータ点がない時刻は他方を 0 として埋める。CloudWatch は OCU が 0 の間
 * データ点を返さないことがあるため、片側の欠測を欠測として扱うと 0 OCU 区間そのものが
 * 消えてしまう。ただし**両方に無い時刻は補わない**（区間の連続性は
 * {@link groupContiguous} が時刻差で判定するため、欠測は連続性を切る）。
 * 埋めた件数を返して、補完の量を出力へ載せられるようにする。
 */
export function alignOcuSamples(
  searchPoints: readonly MetricDataPoint[],
  indexingPoints: readonly MetricDataPoint[]
): { samples: readonly OcuSample[]; searchOnlyCount: number; indexingOnlyCount: number; pairedCount: number } {
  const merged: Record<string, { searchOcu: number | null; indexingOcu: number | null }> = {};

  for (let i = 0; i < searchPoints.length; i += 1) {
    const point = searchPoints[i];
    const key = normalizeTimestampKey(point.timestamp);
    const entry = merged[key] ?? { searchOcu: null, indexingOcu: null };
    entry.searchOcu = point.value;
    merged[key] = entry;
  }
  for (let i = 0; i < indexingPoints.length; i += 1) {
    const point = indexingPoints[i];
    const key = normalizeTimestampKey(point.timestamp);
    const entry = merged[key] ?? { searchOcu: null, indexingOcu: null };
    entry.indexingOcu = point.value;
    merged[key] = entry;
  }

  const timestamps = Object.keys(merged).sort((left, right) => toEpochMs(left) - toEpochMs(right));
  const samples: OcuSample[] = [];
  let searchOnlyCount = 0;
  let indexingOnlyCount = 0;
  let pairedCount = 0;

  for (let i = 0; i < timestamps.length; i += 1) {
    const timestamp = timestamps[i];
    const entry = merged[timestamp];
    if (entry.searchOcu !== null && entry.indexingOcu !== null) {
      pairedCount += 1;
    } else if (entry.searchOcu !== null) {
      searchOnlyCount += 1;
    } else {
      indexingOnlyCount += 1;
    }
    samples.push({
      timestamp,
      searchOcu: entry.searchOcu ?? 0,
      indexingOcu: entry.indexingOcu ?? 0,
    });
  }

  return { samples, searchOnlyCount, indexingOnlyCount, pairedCount };
}

/** 時刻キーを UTC の ISO 8601 に正規化して、表記差で別バケット扱いになるのを防ぐ */
function normalizeTimestampKey(timestamp: string): string {
  return toIsoString(toEpochMs(timestamp));
}

// ============================================================
// 純関数: 消費キャパシティと転送量
// ============================================================

/**
 * `SearchVectors` の `ConsumedCapacity` から消費量（バイト）を読む。
 *
 * 通常の読み取り API の `CapacityUnits` / `ReadCapacityUnits` / `Table` / `Indexes` は
 * **存在しない**ため、それらを探しても常に読み取れない。検索の消費量は
 * `VectorSearchRequestBytes` である（要件 14.7 が測る CloudWatch メトリクスと同名）。
 *
 * **実 API の応答で観測した形（task 13.13 / Q5、2026-08-21、us-west-2）:**
 * `{ "VectorSearchRequestBytes": 61318, "VectorSearchUnits": 61318 }`。
 * `VectorSearchUnits` は SDK の `VectorCapacity` モデルには無いが実 API が返す。
 * 要件 14.7 の測定対象は `VectorSearchRequestBytes` であるため本関数は当該項目のみを読む。
 *
 * 読めない場合は 0 と決めつけずに null を返し、集計から除外して件数を出力へ載せる。
 * 0 とみなすと平均が実際より小さく出て、コスト見積を過小に見せてしまう。
 */
/**
 * `SearchVectors` の要求本文を組み立てる（純関数）。
 *
 * **`SearchVector` は SDK のモデルどおり `AttributeValue[]`（`[{ "N": "..." }, ...]`）で
 * 送らなければならない。**素の数値配列（`[-0.0266, ...]`）で送ると実 API は HTTP 400
 * `SerializationException` を返す（task 13.13 で実測。`{"__type":
 * "com.amazon.coral.service#SerializationException"}`）。当初の実装は素の数値配列を送っており、
 * `--capacity` の 100 回測定が全件失敗する状態だった。
 *
 * 送信を伴わずに形を検証できるよう、要求の組み立てを I/O から切り離してある
 * （本ファイルの「純計算と I/O を分離する」方針）。
 */
export function buildSearchVectorsRequestBody(input: {
  tableName: string;
  indexName: string;
  searchVector: readonly number[];
  topK: number;
}): Record<string, unknown> {
  return {
    TableName: input.tableName,
    IndexName: input.indexName,
    SearchVector: input.searchVector.map((element) => ({ N: String(element) })),
    TopK: input.topK,
    ReturnConsumedCapacity: 'TOTAL',
  };
}

export function readVectorSearchRequestBytes(raw: unknown): number | null {
  const capacity = asRecord(raw) as VectorCapacity | undefined;
  if (capacity === undefined) return null;

  return firstFiniteNumber([capacity.VectorSearchRequestBytes]);
}

/**
 * `SearchVectors` の `ConsumedCapacity` から `VectorSearchUnits` を読む（要件 8.11）。
 *
 * **この項目は SDK の `VectorCapacity` モデルに存在しない。**実 API のみが返すため、
 * SDK の型を経由せず生応答のレコードから読む。task 13.13 では
 * `VectorSearchRequestBytes` と同値（各 61,318）だったが、**同値であることが常に
 * 成り立つかは task 13.18 の観測項目**であり、本関数は一致を前提にしない。
 *
 * 読めない場合は 0 と決めつけずに null を返す。
 */
export function readVectorSearchUnits(raw: unknown): number | null {
  const capacity = asRecord(raw);
  if (capacity === undefined) return null;

  return firstFiniteNumber([capacity.VectorSearchUnits]);
}

/** 消費キャパシティを集計する（要件 14.7） */
export function summarizeConsumedCapacity(input: {
  samples: readonly SearchProbeSample[];
  language: VectorLanguage;
  indexName: string;
  topK: number;
  queryCount: number;
  measurementStartedAt: string;
  measurementEndedAt: string;
}): ConsumedCapacitySummary {
  const units: number[] = [];
  const searchUnits: number[] = [];
  const divergences: { attempt: number; requestBytes: number; units: number }[] = [];
  let failureCount = 0;
  let missingCapacityCount = 0;
  let comparableCount = 0;
  let equalCount = 0;

  for (let i = 0; i < input.samples.length; i += 1) {
    const sample = input.samples[i];
    if (!sample.succeeded) {
      failureCount += 1;
      continue;
    }
    if (sample.vectorSearchUnits !== null) {
      searchUnits.push(sample.vectorSearchUnits);
    }
    if (sample.vectorSearchRequestBytes !== null && sample.vectorSearchUnits !== null) {
      comparableCount += 1;
      if (sample.vectorSearchRequestBytes === sample.vectorSearchUnits) {
        equalCount += 1;
      } else {
        divergences.push({
          attempt: sample.attempt,
          requestBytes: sample.vectorSearchRequestBytes,
          units: sample.vectorSearchUnits,
        });
      }
    }
    if (sample.vectorSearchRequestBytes === null) {
      missingCapacityCount += 1;
      continue;
    }
    units.push(sample.vectorSearchRequestBytes);
  }

  const summary = summarizeSeries(units);
  let total = 0;
  for (let i = 0; i < units.length; i += 1) {
    total += units[i];
  }

  const unitsSummary = summarizeSeries(searchUnits);
  let unitsTotal = 0;
  for (let i = 0; i < searchUnits.length; i += 1) {
    unitsTotal += searchUnits[i];
  }

  return {
    queryCount: input.queryCount,
    topK: input.topK,
    language: input.language,
    indexName: input.indexName,
    searchCount: input.samples.length,
    measuredCount: units.length,
    failureCount,
    missingCapacityCount,
    averagePerSearch: summary.average,
    minimumPerSearch: summary.minimum,
    maximumPerSearch: summary.maximum,
    total,
    unitsMeasuredCount: searchUnits.length,
    unitsAveragePerSearch: unitsSummary.average,
    unitsMinimumPerSearch: unitsSummary.minimum,
    unitsMaximumPerSearch: unitsSummary.maximum,
    unitsTotal,
    unitsEqualRequestBytesCount: equalCount,
    unitsDivergentCount: divergences.length,
    unitsAlwaysEqualRequestBytes: comparableCount === 0 ? null : divergences.length === 0,
    unitsDivergences: divergences,
    measurementStartedAt: input.measurementStartedAt,
    measurementEndedAt: input.measurementEndedAt,
  };
}

/** `VectorSearchRequestBytes` を集計する（要件 14.8） */
export function summarizeRequestBytes(input: {
  tableName: string;
  indexName: string;
  points: readonly MetricDataPoint[];
  windowStart: string;
  windowEnd: string;
  searchCount: number;
}): RequestBytesSummary {
  let totalBytes = 0;
  for (let i = 0; i < input.points.length; i += 1) {
    totalBytes += input.points[i].value;
  }

  return {
    tableName: input.tableName,
    indexName: input.indexName,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    dataPointCount: input.points.length,
    totalBytes,
    averagePerSearchBytes: input.searchCount > 0 ? totalBytes / input.searchCount : null,
  };
}

// ============================================================
// 純関数: アイテムサイズと Good_Table スナップショット
// ============================================================

/** 文字列の UTF-8 バイト長。Buffer に依存せず算出する */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // サロゲートペアは 4 バイト。下位サロゲートを読み飛ばす
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * アイテムサイズ（バイト）を推定する（要件 1.5 の比較項目）。
 *
 * DynamoDB が公開しているサイズ計算規則に沿った**推定値**である。属性名の UTF-8 バイト長と
 * 値のバイト長を足し、数値は「有効桁数 ÷ 2 + 1」、真偽値と NULL は 1 バイト、
 * リストとマップは 3 バイト + 要素サイズ + 要素あたり 1 バイトとして数える。
 *
 * 厳密なサイズは API から取得できないが、**段階 0 と段階 15 で同一のアルゴリズムを使う**ため
 * 「変化していないこと」の判定には十分である。判定に使うのは絶対値ではなく一致である。
 */
export function estimateItemSizeBytes(item: Record<string, unknown>): number {
  const names = Object.keys(item);
  let total = 0;
  for (let i = 0; i < names.length; i += 1) {
    total += utf8ByteLength(names[i]) + estimateAttributeValueSize(item[names[i]]);
  }
  return total;
}

/** AttributeValue 1 個のサイズを推定する */
function estimateAttributeValueSize(value: unknown): number {
  const record = asRecord(value);
  if (record === undefined) return 0;

  if (typeof record.S === 'string') return utf8ByteLength(record.S);
  if (typeof record.N === 'string') return estimateNumberSize(record.N);
  if (typeof record.B === 'string') return Math.ceil((record.B.length * 3) / 4);
  if (typeof record.BOOL === 'boolean') return 1;
  if (record.NULL === true) return 1;

  if (Array.isArray(record.SS)) {
    return sumBy(record.SS, (entry) => (typeof entry === 'string' ? utf8ByteLength(entry) : 0));
  }
  if (Array.isArray(record.NS)) {
    return sumBy(record.NS, (entry) => (typeof entry === 'string' ? estimateNumberSize(entry) : 0));
  }
  if (Array.isArray(record.BS)) {
    return sumBy(record.BS, (entry) =>
      typeof entry === 'string' ? Math.ceil((entry.length * 3) / 4) : 0
    );
  }
  if (Array.isArray(record.L)) {
    return 3 + sumBy(record.L, (entry) => estimateAttributeValueSize(entry) + 1);
  }

  const map = asRecord(record.M);
  if (map !== undefined) {
    const names = Object.keys(map);
    let total = 3;
    for (let i = 0; i < names.length; i += 1) {
      total += utf8ByteLength(names[i]) + estimateAttributeValueSize(map[names[i]]) + 1;
    }
    return total;
  }

  return 0;
}

/** 数値属性のサイズ推定。有効桁数 ÷ 2 + 1 バイト（切り上げ、下限 1、上限 21） */
function estimateNumberSize(raw: string): number {
  const digits = raw.replace(/[^0-9]/g, '').replace(/^0+/, '');
  const significant = digits.length === 0 ? 1 : digits.length;
  return Math.min(21, Math.max(1, Math.ceil(significant / 2) + 1));
}

/** 抽出アイテム 1 件の要約を作る（要件 1.5） */
export function buildSampleItemSnapshot(item: Record<string, unknown>): SampleItemSnapshot {
  const itemId = readStringAttribute(item, 'itemId');
  const warehouseId = readStringAttribute(item, 'warehouseId');

  return {
    key: `${itemId}#${warehouseId}`,
    itemId,
    warehouseId,
    attributeNames: Object.keys(item).sort(compareText),
    itemSizeBytes: estimateItemSizeBytes(item),
  };
}

/**
 * 抽出アイテムを決定論的に選ぶ。
 *
 * `Scan` の返却順は保証されないため、`itemId#warehouseId` の昇順に並べて先頭から採る。
 * これにより同一データに対して同一の抽出集合になり、段階 0 と段階 15 の比較が成立する。
 */
export function selectSampleItems(
  items: readonly Record<string, unknown>[],
  count: number = GOOD_TABLE_SAMPLE_ITEM_COUNT
): readonly SampleItemSnapshot[] {
  return items
    .map((item) => buildSampleItemSnapshot(item))
    .sort((left, right) => compareText(left.key, right.key))
    .slice(0, count);
}

/**
 * 2 つの Good_Table スナップショットを比較する（要件 1.5）。
 *
 * 比較対象は PK / SK、3 本の GSI 定義、Streams の設定、PITR、アイテム件数、
 * 抽出アイテムの属性集合とアイテムサイズ。取得時刻は比較しない。
 *
 * リージョンは両側が判明している場合にのみ比較する。版 1 のスナップショットは `region` を
 * 持たないため（{@link GOOD_TABLE_SNAPSHOT_SCHEMA_VERSION}）、基準側が null のときは
 * 「未記録」であって「不一致」ではない。
 *
 * `ItemCount` は約 6 時間周期で更新される概数であるため、一致しない場合も
 * 相違として記録はするが、それだけで「破壊された」と断定できるものではない。
 * 判断材料として差分を提示するのが本関数の役割である。
 */
export function compareGoodTableSnapshots(
  baseline: GoodTableSnapshot,
  current: GoodTableSnapshot
): GoodTableComparison {
  const differences: SnapshotDifference[] = [];

  pushDifference(differences, 'tableName', baseline.tableName, current.tableName);

  // リージョンは両側が判明しているときだけ比較する。版 1 の基準ファイルは `region` を持たず、
  // 「記録されていない」ことを「異なる」と扱うと task 13.20 が基準の古さだけで落ちてしまう
  if (baseline.region !== null && current.region !== null) {
    pushDifference(differences, 'region', baseline.region, current.region);
  }

  pushDifference(
    differences,
    'keySchema',
    baseline.keySchema.join(', '),
    current.keySchema.join(', ')
  );
  pushDifference(
    differences,
    'globalSecondaryIndexes.count',
    String(baseline.globalSecondaryIndexes.length),
    String(current.globalSecondaryIndexes.length)
  );

  for (let i = 0; i < baseline.globalSecondaryIndexes.length; i += 1) {
    const expected = baseline.globalSecondaryIndexes[i];
    const actual = current.globalSecondaryIndexes.filter(
      (entry) => entry.indexName === expected.indexName
    )[0];
    if (actual === undefined) {
      differences.push({
        field: `globalSecondaryIndexes.${expected.indexName}`,
        baseline: describeGsi(expected),
        current: '(存在しない)',
      });
      continue;
    }
    pushDifference(
      differences,
      `globalSecondaryIndexes.${expected.indexName}`,
      describeGsi(expected),
      describeGsi(actual)
    );
  }

  pushDifference(
    differences,
    'streamEnabled',
    String(baseline.streamEnabled),
    String(current.streamEnabled)
  );
  pushDifference(
    differences,
    'streamViewType',
    baseline.streamViewType ?? '(なし)',
    current.streamViewType ?? '(なし)'
  );
  pushDifference(
    differences,
    'pointInTimeRecoveryStatus',
    baseline.pointInTimeRecoveryStatus,
    current.pointInTimeRecoveryStatus
  );
  pushDifference(differences, 'itemCount', String(baseline.itemCount), String(current.itemCount));

  const missingItemKeys: string[] = [];
  let comparedItemCount = 0;

  for (let i = 0; i < baseline.sampleItems.length; i += 1) {
    const expected = baseline.sampleItems[i];
    const actual = current.sampleItems.filter((entry) => entry.key === expected.key)[0];
    if (actual === undefined) {
      missingItemKeys.push(expected.key);
      continue;
    }
    comparedItemCount += 1;
    pushDifference(
      differences,
      `sampleItems.${expected.key}.attributeNames`,
      expected.attributeNames.join(', '),
      actual.attributeNames.join(', ')
    );
    pushDifference(
      differences,
      `sampleItems.${expected.key}.itemSizeBytes`,
      String(expected.itemSizeBytes),
      String(actual.itemSizeBytes)
    );
  }

  return {
    identical: differences.length === 0 && missingItemKeys.length === 0,
    baselineCapturedAt: baseline.capturedAt,
    currentCapturedAt: current.capturedAt,
    comparedItemCount,
    missingItemKeys,
    differences,
  };
}

/** 差があれば記録する */
function pushDifference(
  target: SnapshotDifference[],
  field: string,
  baseline: string,
  current: string
): void {
  if (baseline !== current) {
    target.push({ field, baseline, current });
  }
}

/** GSI 定義を 1 行へ整形する */
function describeGsi(gsi: GsiSnapshot): string {
  const nonKey = gsi.nonKeyAttributes.length === 0 ? '' : ` [${gsi.nonKeyAttributes.join(', ')}]`;
  return `${gsi.keySchema.join(', ')} / ${gsi.projectionType}${nonKey}`;
}

// ============================================================
// I/O 境界（AWS へ触るのはこれらの実装のみ。すべて読み取り専用）
// ============================================================

/** CloudWatch のメトリクス次元 */
export interface MetricDimension {
  name: string;
  value: string;
}

/** メトリクス取得の要求 */
export interface MetricSeriesQuery {
  namespace: string;
  metricName: string;
  dimensions: readonly MetricDimension[];
  /** 取得区間の開始（UTC の ISO 8601） */
  startTime: string;
  endTime: string;
  periodSeconds: number;
  statistic: 'Average' | 'Maximum' | 'Minimum' | 'Sum';
}

/** メトリクスのデータ点 */
export interface MetricDataPoint {
  timestamp: string;
  value: number;
}

/**
 * メトリクス数式（`SEARCH()`）による取得の要求。
 *
 * 次元値を自前で解決しなくても系列を引けるため、OCU 系メトリクスはこちらを使う
 * （{@link aossOcuSearchExpression}）。式は取得間隔と統計種別を自身に含む。
 */
export interface MetricExpressionQuery {
  /** `SEARCH(...)` などのメトリクス数式 */
  expression: string;
  /** 返る系列へ付ける動的ラベル。次元値を焼き込んで系列を識別可能にする */
  label: string;
  startTime: string;
  endTime: string;
}

/** `SEARCH()` が返した系列 1 本 */
export interface MetricExpressionSeries {
  /** CloudWatch が解決したラベル。動的ラベルを指定した場合は次元値を含む */
  label: string;
  /** `Complete` / `PartialData` / `InternalError` など。取得できない場合は null */
  statusCode: string | null;
  points: readonly MetricDataPoint[];
}

/** `GetMetricData` の応答 */
export interface MetricExpressionResult {
  series: readonly MetricExpressionSeries[];
  /** CloudWatch が返した注意メッセージ（式の警告など） */
  messages: readonly string[];
}

/** CloudWatch の読み取り経路（`GetMetricStatistics` / `GetMetricData`） */
export interface MetricSource {
  /** 次元集合が既知のメトリクス（`VectorSearchRequestBytes` など）用 */
  getSeries(query: MetricSeriesQuery): Promise<readonly MetricDataPoint[]>;
  /** 次元値を自前で解決できないメトリクス（OCU 系）用 */
  getExpressionSeries(query: MetricExpressionQuery): Promise<MetricExpressionResult>;
}

/** テーブルの記述。`VectorIndexDescription` を含む生の形も保持する */
export interface TableDescriptionSnapshot {
  tableName: string;
  tableStatus: string;
  itemCount: number;
  tableSizeBytes: number;
  keySchema: readonly string[];
  globalSecondaryIndexes: readonly GsiSnapshot[];
  streamEnabled: boolean;
  streamViewType: string | null;
  vectorIndexes: readonly VectorIndexState[];
}

/** DynamoDB の読み取り経路（`DescribeTable` / `DescribeContinuousBackups` / `ListTables` / `Scan` / `BatchGetItem`） */
export interface DynamoDbMeasurementSource {
  describeTable(tableName: string): Promise<TableDescriptionSnapshot | null>;
  /** PITR の状態（`ENABLED` / `DISABLED` など）。読み取れない場合は `UNKNOWN` */
  describeContinuousBackups(tableName: string): Promise<string>;
  listTableNames(): Promise<readonly string[]>;
  /** `Scan` で先頭 `limit` 件を読む。全件走査は行わない */
  sampleItems(tableName: string, limit: number): Promise<readonly Record<string, unknown>[]>;
  /** `BatchGetItem` でキー指定の取得を行う。段階 15 で同一アイテムを突き合わせるために使う */
  getItemsByKeys(
    tableName: string,
    keys: readonly { itemId: string; warehouseId: string }[]
  ): Promise<readonly Record<string, unknown>[]>;
}

/** `SearchVectors` の送信経路（消費キャパシティ測定用） */
export interface SearchVectorsProbe {
  search(input: {
    tableName: string;
    indexName: string;
    searchVector: readonly number[];
    topK: number;
  }): Promise<{
    succeeded: boolean;
    vectorSearchRequestBytes: number | null;
    /** `VectorSearchUnits`（SDK モデルに無いため生応答から読む。要件 8.11） */
    vectorSearchUnits: number | null;
    latencyMs: number;
    errorType: string | null;
    errorMessage: string | null;
  }>;
}

/** AOSS の読み取り経路（`ListCollections` / `ListCollectionGroups`） */
export interface CollectionInventorySource {
  listCollectionNames(): Promise<readonly string[]>;
  listCollectionGroupNames(): Promise<readonly string[]>;
}

/** OSIS の読み取り経路。**起動も設定変更も行わない**（要件 6.10） */
export interface PipelineStateSource {
  /** パイプラインの状態。存在しない場合は null */
  getPipelineStatus(pipelineName: string): Promise<string | null>;
}

/**
 * 測定結果の永続化経路。
 *
 * {@link write} は台帳（`storage-snapshots.json`）の追記のためにのみ使う。台帳の更新は
 * {@link appendSnapshots} が生成した「既存の全件 + 新規」の内容で書き戻すため、
 * 上書きであっても先行するスナップショットは失われない（要件 14.5）。
 *
 * {@link writeNew} は**既存ファイルを上書きしない**。同名が既にある場合は連番を付けた
 * 別名へ書き出し、実際のパスを返す。測定 1 回の結果はやり直しのできない実測値であり、
 * 2 回目の実行で前回の出力を消してしまうと復元できない（`recall-cli.ts` と同じ方針）。
 */
export interface MeasurementStore {
  read(fileName: string): Promise<string | null>;
  write(fileName: string, contents: string): Promise<void>;
  writeNew(fileName: string, contents: string): Promise<string>;
}

/** 時計。テストで仮想時計に差し替えるために注入する */
export interface MeasurementClock {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
}

/** 実時間で動く時計 */
export function createSystemClock(): MeasurementClock {
  return {
    now: () => new Date(),
    sleep: (milliseconds: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
      }),
  };
}

// ============================================================
// インデックス待機（要件 5.14）
// ============================================================

/**
 * `TableDescription.VectorIndexes` から状態を読む（設計 V5 / V6）。
 *
 * `BACKFILLING` というステータス値は存在しない。ACTIVE と `Backfilling` の組で判定する。
 * キー名は SDK のモデルどおり `VectorIndexes`（複数形の配列）である。
 * `table` は遅延 import した SDK の応答を `unknown` として受けるため、
 * 配列であることの確認だけは実行時にも行う。
 */
export function readVectorIndexStates(table: unknown): readonly VectorIndexState[] {
  const record = asRecord(table);
  if (record === undefined) return [];

  const raw = record.VectorIndexes;
  const descriptions: VectorIndexDescription[] = Array.isArray(raw)
    ? (raw as VectorIndexDescription[])
    : [];

  return descriptions
    .filter((description) => typeof description.IndexName === 'string')
    .map((description) => {
      const indexStatus = typeof description.IndexStatus === 'string' ? description.IndexStatus : '';
      const backfilling = description.Backfilling === true;
      return {
        indexName: description.IndexName as string,
        indexStatus,
        backfilling,
        // 実測（V20）ではキー自体が返らない。判定は「不在 = 偽」で成立するが、
        // 不在であったことは測定可否の判断材料として別に保持する（要件 5.17）
        backfillingPresent: typeof description.Backfilling === 'boolean',
        searchable: indexStatus === 'ACTIVE' && !backfilling,
        indexSizeBytes:
          typeof description.IndexSizeBytes === 'number' ? description.IndexSizeBytes : null,
        itemCount: typeof description.ItemCount === 'number' ? description.ItemCount : null,
      };
    })
    .sort((left, right) => compareText(left.indexName, right.indexName));
}

/** 待機結果の全体 */
export interface IndexWaitResult {
  tableName: string;
  pollIntervalSeconds: number;
  timeoutMinutes: number;
  startedAt: string;
  endedAt: string;
  elapsedSeconds: number;
  pollCount: number;
  records: readonly IndexReadinessRecord[];
  /** 2 本すべてが ACTIVE かつ Backfilling 偽になったか */
  allSearchable: boolean;
  timedOut: boolean;
}

/**
 * 2 本のインデックスが検索可能になるまで待つ（要件 5.14）。
 *
 * 1 回のポーリングで `DescribeTable` を 1 度だけ呼び、**インデックスごとに** ACTIVE 到達時刻と
 * バックフィル完了までの経過秒を記録する。2 本を個別に呼ばないのは、同一時点の
 * スナップショットから両方の状態を読むことで、片方の待機中に他方の遷移時刻がずれて
 * 記録されるのを避けるためである。
 *
 * タイムアウト（既定 180 分）に達した時点で、未完了のインデックスにエラー文と経過時間を
 * 記録して返す。例外は投げない。片方だけが完了している状態も測定値として意味があるため、
 * 呼び出し側が記録を出力できるようにする。
 */
export async function waitForIndexReadiness(options: {
  source: Pick<DynamoDbMeasurementSource, 'describeTable'>;
  tableName: string;
  indexNames: readonly string[];
  timeoutMinutes?: number;
  pollIntervalSeconds?: number;
  clock?: MeasurementClock;
}): Promise<IndexWaitResult> {
  const timeoutMinutes = options.timeoutMinutes ?? DEFAULT_INDEX_WAIT_TIMEOUT_MINUTES;
  const pollIntervalSeconds = options.pollIntervalSeconds ?? INDEX_POLL_INTERVAL_SECONDS;
  const clock = options.clock ?? createSystemClock();

  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new MeasurementError(
      `--timeout-minutes は正の数である必要があります（指定値: ${String(timeoutMinutes)}）。`
    );
  }
  if (!Number.isFinite(pollIntervalSeconds) || pollIntervalSeconds <= 0) {
    throw new MeasurementError('ポーリング間隔は正の数である必要があります。');
  }
  if (pollIntervalSeconds > INDEX_POLL_INTERVAL_SECONDS) {
    throw new MeasurementError(
      `ポーリング間隔は ${INDEX_POLL_INTERVAL_SECONDS} 秒以下である必要があります（要件 5.14）。`
    );
  }

  const startedAtMs = clock.now().getTime();
  const startedAt = toIsoString(startedAtMs);
  const deadlineMs = startedAtMs + timeoutMinutes * 60_000;

  const states: Record<string, IndexReadinessRecord> = {};
  for (let i = 0; i < options.indexNames.length; i += 1) {
    states[options.indexNames[i]] = {
      indexName: options.indexNames[i],
      pollStartedAt: startedAt,
      activeReachedAt: null,
      activeElapsedSeconds: null,
      backfillCompletedAt: null,
      backfillElapsedSeconds: null,
      activeToBackfillSeconds: null,
      finalIndexStatus: '',
      finalBackfilling: false,
      backfillingFieldPresent: false,
      // 観測前は測定不能側に倒す。フィールドを 1 度でも観測できた時点で true へ上げる
      backfillMeasurable: false,
      backfillUnmeasurableReason: BACKFILL_UNMEASURABLE_REASON,
      searchable: false,
      timedOut: false,
      pollCount: 0,
      error: null,
    };
  }

  let pollCount = 0;
  let timedOut = false;

  for (;;) {
    const table = await options.source.describeTable(options.tableName);
    const observedAtMs = clock.now().getTime();
    pollCount += 1;

    if (table === null) {
      throw new MeasurementError(
        `テーブル ${options.tableName} が見つかりません。Stage A のデプロイが完了しているか確認してください。`
      );
    }

    for (let i = 0; i < options.indexNames.length; i += 1) {
      const indexName = options.indexNames[i];
      const record = states[indexName];
      const observed = table.vectorIndexes.filter((entry) => entry.indexName === indexName)[0];

      record.pollCount = pollCount;
      if (observed === undefined) {
        record.finalIndexStatus = '(未作成)';
        continue;
      }

      record.finalIndexStatus = observed.indexStatus;
      record.finalBackfilling = observed.backfilling;
      if (observed.backfillingPresent) {
        // 1 度でも観測できれば経過時間の測定は成立する。以降の不在で false へ戻さない
        record.backfillingFieldPresent = true;
        record.backfillMeasurable = true;
        record.backfillUnmeasurableReason = null;
      }

      if (record.activeReachedAt === null && observed.indexStatus === 'ACTIVE') {
        record.activeReachedAt = toIsoString(observedAtMs);
        record.activeElapsedSeconds = (observedAtMs - startedAtMs) / 1000;
      }

      if (!record.searchable && observed.searchable) {
        // 検索可否は「不在 = 偽」で確定させる（要件 5.15）
        record.searchable = true;

        // **経過時間は `Backfilling` を実際に観測できた場合のみ記録する（要件 5.17）。**
        // フィールドが不在のままここへ来た場合、完了時刻は ACTIVE 到達時刻と同一になり
        // 「バックフィルが 0 秒で完了した」という観測していない事実を捏造してしまう
        if (record.backfillingFieldPresent) {
          record.backfillCompletedAt = toIsoString(observedAtMs);
          record.backfillElapsedSeconds = (observedAtMs - startedAtMs) / 1000;
          record.activeToBackfillSeconds =
            record.activeElapsedSeconds === null
              ? null
              : record.backfillElapsedSeconds - record.activeElapsedSeconds;
        }
      }
    }

    const pending = options.indexNames.filter((indexName) => !states[indexName].searchable);
    if (pending.length === 0) {
      break;
    }

    if (clock.now().getTime() >= deadlineMs) {
      timedOut = true;
      for (let i = 0; i < pending.length; i += 1) {
        const record = states[pending[i]];
        record.timedOut = true;
        record.error =
          `タイムアウト: ${timeoutMinutes} 分以内に ${record.indexName} の Backfilling が偽になりませんでした` +
          `（経過 ${formatNumber((clock.now().getTime() - startedAtMs) / 1000, 1)} 秒、` +
          `IndexStatus=${record.finalIndexStatus || '不明'} / ` +
          `Backfilling=${formatBackfillingObservation(record)}）。` +
          'インデックスが未完成の間の検索結果はレイテンシおよび Recall_At_K の測定値として採用できません（要件 5.15）。';
      }
      break;
    }

    await clock.sleep(pollIntervalSeconds * 1000);
  }

  const endedAtMs = clock.now().getTime();
  const records = options.indexNames.map((indexName) => states[indexName]);

  return {
    tableName: options.tableName,
    pollIntervalSeconds,
    timeoutMinutes,
    startedAt,
    endedAt: toIsoString(endedAtMs),
    elapsedSeconds: (endedAtMs - startedAtMs) / 1000,
    pollCount,
    records,
    allSearchable: records.every((record) => record.searchable),
    timedOut,
  };
}

// ============================================================
// クエリベクトル（純関数）
// ============================================================

/**
 * 決定論的な単位ベクトルを作る。
 *
 * 消費キャパシティ測定に必要なのは「同一条件で 100 回」であり、検索結果の内容は使わない。
 * Bedrock を呼ばずに固定シードから作ることで、埋め込み生成の課金と Query_Vector_Cache への
 * 依存を避ける。実装は `probe-range-filter.ts` と同一（mulberry32 → 正規化 → float32 丸め）。
 */
export function buildDeterministicQueryVector(dimensions: number, seed: number): readonly number[] {
  const next = createMulberry32(seed);
  const raw: number[] = [];
  let norm = 0;

  for (let i = 0; i < dimensions; i += 1) {
    const value = next() * 2 - 1;
    raw.push(value);
    norm += value * value;
  }

  const scale = norm > 0 ? 1 / Math.sqrt(norm) : 0;
  return raw.map((value) => Math.fround(value * scale));
}

/** 32bit の決定論的擬似乱数（mulberry32）。同一シードで同一列を返す */
function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// ============================================================
// 純関数: DescribeTable の読み取り
// ============================================================

/**
 * `DescribeTable` の `Table` を {@link TableDescriptionSnapshot} へ写す（純関数）。
 *
 * 読めなかった項目は 0 / null / 空配列にせず、読めた分だけを載せる。`ItemCount` と
 * `TableSizeBytes` は約 6 時間周期で更新される概数であり（要件 14.4）、欠落と 0 を
 * 区別する必要があるが、`DescribeTable` は常にこの 2 項目を返すため 0 を欠落として扱わない。
 */
export function readTableDescription(raw: unknown): TableDescriptionSnapshot | null {
  const record = asRecord(raw);
  if (record === undefined) return null;

  const stream = asRecord(record.StreamSpecification);

  return {
    tableName: typeof record.TableName === 'string' ? record.TableName : '',
    tableStatus: typeof record.TableStatus === 'string' ? record.TableStatus : '',
    itemCount: typeof record.ItemCount === 'number' ? record.ItemCount : 0,
    tableSizeBytes: typeof record.TableSizeBytes === 'number' ? record.TableSizeBytes : 0,
    keySchema: readKeySchema(record.KeySchema),
    globalSecondaryIndexes: readGsiSnapshots(record.GlobalSecondaryIndexes),
    streamEnabled: stream?.StreamEnabled === true,
    streamViewType:
      stream !== undefined && typeof stream.StreamViewType === 'string'
        ? stream.StreamViewType
        : null,
    vectorIndexes: readVectorIndexStates(record),
  };
}

/** `KeySchema` を `属性名:キー種別` の列へ写す。`HASH` を先、`RANGE` を後に並べる */
function readKeySchema(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];

  const entries: { text: string; order: number }[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const element = asRecord(raw[i]);
    if (element === undefined) continue;
    const attributeName = typeof element.AttributeName === 'string' ? element.AttributeName : '';
    const keyType = typeof element.KeyType === 'string' ? element.KeyType : '';
    if (attributeName === '') continue;
    entries.push({ text: `${attributeName}:${keyType}`, order: keyType === 'HASH' ? 0 : 1 });
  }

  return entries
    .sort((left, right) => (left.order !== right.order ? left.order - right.order : 0))
    .map((entry) => entry.text);
}

/** `GlobalSecondaryIndexes` を比較可能な形へ写す。インデックス名の昇順に並べる（要件 1.5） */
function readGsiSnapshots(raw: unknown): readonly GsiSnapshot[] {
  if (!Array.isArray(raw)) return [];

  const snapshots: GsiSnapshot[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const element = asRecord(raw[i]);
    if (element === undefined) continue;
    const projection = asRecord(element.Projection);
    const nonKeyAttributes = Array.isArray(projection?.NonKeyAttributes)
      ? projection.NonKeyAttributes.filter((entry: unknown): entry is string => typeof entry === 'string')
      : [];

    snapshots.push({
      indexName: typeof element.IndexName === 'string' ? element.IndexName : '',
      keySchema: readKeySchema(element.KeySchema),
      projectionType:
        projection !== undefined && typeof projection.ProjectionType === 'string'
          ? projection.ProjectionType
          : '',
      nonKeyAttributes: nonKeyAttributes.slice().sort(compareText),
    });
  }

  return snapshots.sort((left, right) => compareText(left.indexName, right.indexName));
}

// ============================================================
// 純関数: Good_Table スナップショットの組み立て（要件 1.5）
// ============================================================

/** Good_Table に期待する GSI 名（要件 1.5） */
export const EXPECTED_GOOD_TABLE_GSI_NAMES = ['byLocation', 'byUnitPrice', 'byWarehouse'] as const;

/** Good_Table に期待する Streams のビュー種別（要件 1.5） */
export const EXPECTED_GOOD_TABLE_STREAM_VIEW_TYPE = 'NEW_AND_OLD_IMAGES';

/** Good_Table に期待する PITR の状態（要件 1.5） */
export const EXPECTED_GOOD_TABLE_PITR_STATUS = 'ENABLED';

/** `DescribeTable` の読み取り結果から比較用スナップショットを組み立てる（要件 1.5） */
export function buildGoodTableSnapshot(input: {
  table: TableDescriptionSnapshot;
  pointInTimeRecoveryStatus: string;
  items: readonly Record<string, unknown>[];
  capturedAt: string;
  /** 取得時の実効リージョン。解決できなかった場合は null を渡す（値を捏造しない） */
  region?: string | null;
  sampleItemCount?: number;
}): GoodTableSnapshot {
  return {
    schemaVersion: GOOD_TABLE_SNAPSHOT_SCHEMA_VERSION,
    tableName: input.table.tableName,
    region: input.region ?? null,
    capturedAt: input.capturedAt,
    keySchema: input.table.keySchema,
    globalSecondaryIndexes: input.table.globalSecondaryIndexes,
    streamEnabled: input.table.streamEnabled,
    streamViewType: input.table.streamViewType,
    pointInTimeRecoveryStatus: input.pointInTimeRecoveryStatus,
    itemCount: input.table.itemCount,
    sampleItems: selectSampleItems(input.items, input.sampleItemCount ?? GOOD_TABLE_SAMPLE_ITEM_COUNT),
  };
}

/**
 * スナップショットが要件 1.5 の期待どおりかを点検する（純関数）。
 *
 * 期待から外れていても例外にはしない。段階 0 の時点で既存テーブルが期待と異なるなら、
 * それは本検証が壊したものではなく**元からの差**であり、比較基準として記録しておく方が
 * 有用である。ここで返すのは検証担当者へ提示する注意文であり、判定ではない。
 */
export function evaluateGoodTableExpectations(snapshot: GoodTableSnapshot): readonly string[] {
  const warnings: string[] = [];

  if (snapshot.itemCount !== EXPECTED_GOOD_TABLE_ITEM_COUNT) {
    warnings.push(
      `Good_Table のアイテム件数が ${snapshot.itemCount} 件です（期待 ${EXPECTED_GOOD_TABLE_ITEM_COUNT} 件、要件 1.5）。` +
        'DescribeTable の ItemCount は約 6 時間周期で更新される概数であるため、直近の書き込みが反映されていない可能性があります。'
    );
  }

  const actualGsiNames = snapshot.globalSecondaryIndexes.map((gsi) => gsi.indexName).sort(compareText);
  const expectedGsiNames = EXPECTED_GOOD_TABLE_GSI_NAMES.slice().sort(compareText);
  if (actualGsiNames.join(', ') !== expectedGsiNames.join(', ')) {
    warnings.push(
      `Good_Table の GSI が ${actualGsiNames.length} 本（${actualGsiNames.join(', ') || 'なし'}）です。` +
        `期待は 3 本（${expectedGsiNames.join(', ')}）です（要件 1.5）。`
    );
  }

  if (!snapshot.streamEnabled || snapshot.streamViewType !== EXPECTED_GOOD_TABLE_STREAM_VIEW_TYPE) {
    warnings.push(
      `Good_Table の Streams が ${snapshot.streamEnabled ? snapshot.streamViewType ?? '(種別不明)' : '無効'} です。` +
        `期待は ${EXPECTED_GOOD_TABLE_STREAM_VIEW_TYPE} です（要件 1.5）。`
    );
  }

  if (snapshot.pointInTimeRecoveryStatus !== EXPECTED_GOOD_TABLE_PITR_STATUS) {
    warnings.push(
      `Good_Table の PITR が ${snapshot.pointInTimeRecoveryStatus} です（期待 ${EXPECTED_GOOD_TABLE_PITR_STATUS}、要件 1.5）。`
    );
  }

  if (snapshot.sampleItems.length < GOOD_TABLE_SAMPLE_ITEM_COUNT) {
    warnings.push(
      `抽出アイテムが ${snapshot.sampleItems.length} 件しかありません（要件 1.5 は 10 件以上）。` +
        `--scan-limit を ${GOOD_TABLE_SCAN_LIMIT} より大きくして再取得してください。`
    );
  }

  return warnings;
}

// ============================================================
// 純関数: ストレージスナップショットの組み立て
// ============================================================

/** スナップショットの位置づけ。`--label` に渡せる値（要件 14.2 / 14.3） */
export const STORAGE_LABELS = ['S1', 'S2', 'INDEX'] as const;

/** {@link STORAGE_LABELS} の要素 */
export type StorageLabel = (typeof STORAGE_LABELS)[number];

/** 値が {@link StorageLabel} か判定する */
export function isStorageLabel(value: unknown): value is StorageLabel {
  return value === 'S1' || value === 'S2' || value === 'INDEX';
}

/**
 * 1 回の `DescribeTable` からスナップショットを組み立てる（要件 14.2 / 14.3）。
 *
 * `TableSizeBytes` を 1 件、`IndexSizeBytes` をインデックス 1 本につき 1 件作る。
 * インデックスが未作成の段階（S1 / S2）では `IndexSizeBytes` の件数は 0 になる。
 * `IndexSizeBytes` が応答に含まれないインデックスは飛ばす。0 で埋めると
 * 「まだ集計されていない」ことと「本当に 0」の区別がつかなくなるためである。
 */
export function buildStorageSnapshots(input: {
  label: string;
  table: TableDescriptionSnapshot;
  capturedAt: string;
}): readonly StorageSnapshot[] {
  const snapshots: StorageSnapshot[] = [
    {
      label: input.label,
      field: 'TableSizeBytes',
      target: input.table.tableName,
      value: input.table.tableSizeBytes,
      capturedAt: input.capturedAt,
      itemCount: null,
    },
  ];

  for (let i = 0; i < input.table.vectorIndexes.length; i += 1) {
    const index = input.table.vectorIndexes[i];
    if (index.indexSizeBytes === null) continue;
    snapshots.push({
      label: input.label,
      field: 'IndexSizeBytes',
      target: index.indexName,
      value: index.indexSizeBytes,
      capturedAt: input.capturedAt,
      itemCount: index.itemCount,
    });
  }

  return snapshots;
}

/** 台帳に含まれる `label` / `field` / `target` の組を列挙する（時刻昇順の代表順） */
export function listSnapshotGroups(
  store: StorageSnapshotStore,
  field: StorageField
): readonly { label: string; field: StorageField; target: string }[] {
  const seen: Record<string, true> = {};
  const groups: { label: string; field: StorageField; target: string }[] = [];

  for (let i = 0; i < store.snapshots.length; i += 1) {
    const snapshot = store.snapshots[i];
    if (snapshot.field !== field) continue;
    const key = `${snapshot.label}\u0000${snapshot.target}`;
    if (seen[key] === true) continue;
    seen[key] = true;
    groups.push({ label: snapshot.label, field, target: snapshot.target });
  }

  return groups.sort((left, right) => {
    const byLabel = compareText(left.label, right.label);
    return byLabel !== 0 ? byLabel : compareText(left.target, right.target);
  });
}

/**
 * 収束判定から出力に使う値を取り出す。
 *
 * 収束済みなら採用値、未確定なら最終取得値を返す。未確定の値を返すのは、
 * 「未確定である」と併記したうえで最終値を出力する要件 14.5 に沿うためである。
 * 呼び出し側は {@link SnapshotConvergence.determinate} を見て「未確定」を併記する。
 */
export function resolveSnapshotValue(convergence: SnapshotConvergence): StorageSnapshot | null {
  return convergence.adopted ?? convergence.finalValue;
}

// ============================================================
// 小さなヘルパー（純関数）
// ============================================================

/** プレーンなオブジェクトとして読む。配列と null は対象外 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 候補のうち最初の有限数を返す。1 つも無ければ null */
function firstFiniteNumber(candidates: readonly unknown[]): number | null {
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/** 射影した値の総和 */
function sumBy(values: readonly unknown[], project: (entry: unknown) => number): number {
  let total = 0;
  for (let i = 0; i < values.length; i += 1) {
    total += project(values[i]);
  }
  return total;
}

/** AttributeValue の文字列属性を読む。読めない場合は空文字 */
function readStringAttribute(item: Record<string, unknown>, name: string): string {
  const attribute = asRecord(item[name]);
  if (attribute === undefined) return '';
  if (typeof attribute.S === 'string') return attribute.S;
  if (typeof attribute.N === 'string') return attribute.N;
  return '';
}

/** 文字列の比較。ロケールに依存しないコードポイント順 */
function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** 数値を固定小数で整形する。非有限値は記号で示して NaN を出力へ混ぜない */
function formatNumber(value: number, digits: number = 2): string {
  if (!Number.isFinite(value)) return '(算出不能)';
  return value.toFixed(digits);
}

/** 整数を桁区切りで整形する */
function formatInteger(value: number): string {
  if (!Number.isFinite(value)) return '(算出不能)';
  return Math.round(value).toLocaleString('en-US');
}

/** 比率を百分率で整形する（小数第 2 位） */
function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return '(算出不能)';
  return `${(ratio * 100).toFixed(2)}%`;
}

/** USD を小数第 2 位で整形する */
function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '(算出不能)';
  return value.toFixed(2);
}

/** バイト数を桁区切りと MiB 併記で整形する */
function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return '(算出不能)';
  return `${formatInteger(value)} B (${formatNumber(value / 1024 / 1024, 2)} MiB)`;
}

/** 要約を 1 行へ整形する */
function formatSummary(summary: SeriesSummary, digits: number = 4): string {
  if (summary.count === 0) return 'データ点なし';
  return (
    `件数 ${summary.count} / 最小 ${formatNumber(summary.minimum ?? Number.NaN, digits)}` +
    ` / 平均 ${formatNumber(summary.average ?? Number.NaN, digits)}` +
    ` / 最大 ${formatNumber(summary.maximum ?? Number.NaN, digits)}`
  );
}

/** 例外を短い文字列へ変換する */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}

/** `ResourceNotFoundException` か判定する */
function isResourceNotFound(error: unknown): boolean {
  return asRecord(error)?.name === 'ResourceNotFoundException';
}

/** ファイル名に使える形へ時刻を整形する */
function toFileNameTimestamp(isoString: string): string {
  return isoString.replace(/[:.]/g, '-');
}

// ============================================================
// AWS 実装（遅延 import。すべて読み取り専用）
// ============================================================

/** 遅延 import する SDK のうち、本スクリプトが使う部分だけの形 */
interface DynamoDbModuleLike {
  DynamoDBClient: new (config: Record<string, unknown>) => {
    send(command: unknown): Promise<Record<string, unknown>>;
    destroy(): void;
    config: { credentials: unknown; region: () => Promise<string> };
  };
  DescribeTableCommand: new (input: Record<string, unknown>) => unknown;
  DescribeContinuousBackupsCommand: new (input: Record<string, unknown>) => unknown;
  ListTablesCommand: new (input: Record<string, unknown>) => unknown;
  ScanCommand: new (input: Record<string, unknown>) => unknown;
  BatchGetItemCommand: new (input: Record<string, unknown>) => unknown;
}

interface CloudWatchModuleLike {
  CloudWatchClient: new (config: Record<string, unknown>) => {
    send(command: unknown): Promise<Record<string, unknown>>;
    destroy(): void;
  };
  GetMetricStatisticsCommand: new (input: Record<string, unknown>) => unknown;
  GetMetricDataCommand: new (input: Record<string, unknown>) => unknown;
}

interface OpenSearchServerlessModuleLike {
  OpenSearchServerlessClient: new (config: Record<string, unknown>) => {
    send(command: unknown): Promise<Record<string, unknown>>;
    destroy(): void;
  };
  ListCollectionsCommand: new (input: Record<string, unknown>) => unknown;
  ListCollectionGroupsCommand: new (input: Record<string, unknown>) => unknown;
}

interface OsisModuleLike {
  OSISClient: new (config: Record<string, unknown>) => {
    send(command: unknown): Promise<Record<string, unknown>>;
    destroy(): void;
  };
  ListPipelinesCommand: new (input: Record<string, unknown>) => unknown;
  GetPipelineCommand: new (input: Record<string, unknown>) => unknown;
}

/** AWS 呼び出し経路の束。モードごとに必要なものだけを使う */
export interface MeasurementContext {
  region: string;
  endpoint: string;
  dynamo: DynamoDbMeasurementSource;
  metrics: MetricSource;
  probe: SearchVectorsProbe;
  collections: CollectionInventorySource;
  pipelines: PipelineStateSource;
  /** SDK クライアントのソケットを閉じる */
  close(): void;
}

/** `ListTables` / `ListCollections` の 1 ページあたり取得件数 */
const LIST_PAGE_SIZE = 100;

/** `BatchGetItem` の 1 回あたりキー件数上限 */
const BATCH_GET_KEY_LIMIT = 100;

/**
 * DynamoDB の読み取り経路を作る。
 *
 * 呼ぶのは `DescribeTable` / `DescribeContinuousBackups` / `ListTables` / `Scan` /
 * `BatchGetItem` の 5 つだけであり、いずれも読み取り専用である。`Scan` は `Limit` 付きで
 * 先頭ページのみを読む（全件走査による RRU 消費を避ける）。
 */
export function createDynamoDbMeasurementSource(options: {
  region?: string;
} = {}): { source: DynamoDbMeasurementSource; close(): void } {
  let cached: { sdk: DynamoDbModuleLike; client: InstanceType<DynamoDbModuleLike['DynamoDBClient']> } | null =
    null;

  const connect = async (): Promise<{
    sdk: DynamoDbModuleLike;
    client: InstanceType<DynamoDbModuleLike['DynamoDBClient']>;
  }> => {
    if (cached !== null) return cached;
    const sdk = await loadDynamoDbSdk();
    const client = new sdk.DynamoDBClient(options.region === undefined ? {} : { region: options.region });
    cached = { sdk, client };
    return cached;
  };

  const source: DynamoDbMeasurementSource = {
    async describeTable(tableName: string): Promise<TableDescriptionSnapshot | null> {
      const { sdk, client } = await connect();
      try {
        const response = await client.send(new sdk.DescribeTableCommand({ TableName: tableName }));
        return readTableDescription(response.Table);
      } catch (error) {
        if (isResourceNotFound(error)) return null;
        throw new MeasurementError(`DescribeTable(${tableName}) に失敗しました: ${describeError(error)}`);
      }
    },

    async describeContinuousBackups(tableName: string): Promise<string> {
      const { sdk, client } = await connect();
      try {
        const response = await client.send(
          new sdk.DescribeContinuousBackupsCommand({ TableName: tableName })
        );
        const description = asRecord(response.ContinuousBackupsDescription);
        const pitr = asRecord(description?.PointInTimeRecoveryDescription);
        const status = pitr?.PointInTimeRecoveryStatus;
        return typeof status === 'string' ? status : 'UNKNOWN';
      } catch (error) {
        if (isResourceNotFound(error)) return 'UNKNOWN';
        throw new MeasurementError(
          `DescribeContinuousBackups(${tableName}) に失敗しました: ${describeError(error)}`
        );
      }
    },

    async listTableNames(): Promise<readonly string[]> {
      const { sdk, client } = await connect();
      const names: string[] = [];
      let exclusiveStartTableName: string | undefined;

      try {
        do {
          const input: Record<string, unknown> = { Limit: LIST_PAGE_SIZE };
          if (exclusiveStartTableName !== undefined) {
            input.ExclusiveStartTableName = exclusiveStartTableName;
          }
          const response = await client.send(new sdk.ListTablesCommand(input));
          if (Array.isArray(response.TableNames)) {
            for (let i = 0; i < response.TableNames.length; i += 1) {
              const name = response.TableNames[i];
              if (typeof name === 'string') names.push(name);
            }
          }
          exclusiveStartTableName =
            typeof response.LastEvaluatedTableName === 'string'
              ? response.LastEvaluatedTableName
              : undefined;
        } while (exclusiveStartTableName !== undefined);
      } catch (error) {
        throw new MeasurementError(`ListTables に失敗しました: ${describeError(error)}`);
      }

      return names.sort(compareText);
    },

    async sampleItems(
      tableName: string,
      limit: number
    ): Promise<readonly Record<string, unknown>[]> {
      const { sdk, client } = await connect();
      try {
        const response = await client.send(
          new sdk.ScanCommand({ TableName: tableName, Limit: limit, ConsistentRead: false })
        );
        return collectItems(response.Items);
      } catch (error) {
        if (isResourceNotFound(error)) return [];
        throw new MeasurementError(`Scan(${tableName}) に失敗しました: ${describeError(error)}`);
      }
    },

    async getItemsByKeys(
      tableName: string,
      keys: readonly { itemId: string; warehouseId: string }[]
    ): Promise<readonly Record<string, unknown>[]> {
      if (keys.length === 0) return [];
      const { sdk, client } = await connect();
      const items: Record<string, unknown>[] = [];

      try {
        for (let offset = 0; offset < keys.length; offset += BATCH_GET_KEY_LIMIT) {
          const chunk = keys.slice(offset, offset + BATCH_GET_KEY_LIMIT).map((key) => ({
            itemId: { S: key.itemId },
            warehouseId: { S: key.warehouseId },
          }));
          const response = await client.send(
            new sdk.BatchGetItemCommand({ RequestItems: { [tableName]: { Keys: chunk } } })
          );
          const responses = asRecord(response.Responses);
          const page = responses === undefined ? undefined : responses[tableName];
          const collected = collectItems(page);
          for (let i = 0; i < collected.length; i += 1) {
            items.push(collected[i]);
          }
        }
      } catch (error) {
        if (isResourceNotFound(error)) return [];
        throw new MeasurementError(`BatchGetItem(${tableName}) に失敗しました: ${describeError(error)}`);
      }

      return items;
    },
  };

  return {
    source,
    close: () => {
      if (cached !== null) {
        cached.client.destroy();
        cached = null;
      }
    },
  };
}

/** 応答の `Items` をレコードの配列へ写す */
function collectItems(raw: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  const items: Record<string, unknown>[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = asRecord(raw[i]);
    if (item !== undefined) items.push(item);
  }
  return items;
}

/**
 * CloudWatch の読み取り経路を作る（`GetMetricStatistics` / `GetMetricData`）。
 *
 * 次元キー集合が既知のメトリクスは `GetMetricStatistics`、次元値を自前で解決できない
 * OCU 系メトリクスは `GetMetricData` + `SEARCH()` を使う（{@link aossOcuSearchExpression}）。
 * どちらも読み取り専用である。
 *
 * SDK が未導入の場合は導入手順を含むエラーにする。依存関係の追加は本スクリプトの
 * 実装範囲外であり、勝手に `package.json` を書き換えない。
 */
export function createCloudWatchMetricSource(options: { region?: string } = {}): {
  source: MetricSource;
  close(): void;
} {
  let cached: { sdk: CloudWatchModuleLike; client: InstanceType<CloudWatchModuleLike['CloudWatchClient']> } | null =
    null;

  const connect = async (): Promise<{
    sdk: CloudWatchModuleLike;
    client: InstanceType<CloudWatchModuleLike['CloudWatchClient']>;
  }> => {
    if (cached !== null) return cached;
    const sdk = await loadOptionalSdk<CloudWatchModuleLike>(CLOUDWATCH_SDK_PACKAGE, [
      'CloudWatchClient',
      'GetMetricStatisticsCommand',
      'GetMetricDataCommand',
    ]);
    const client = new sdk.CloudWatchClient(
      options.region === undefined ? {} : { region: options.region }
    );
    cached = { sdk, client };
    return cached;
  };

  const source: MetricSource = {
    async getSeries(query: MetricSeriesQuery): Promise<readonly MetricDataPoint[]> {
      const { sdk, client } = await connect();
      try {
        const response = await client.send(
          new sdk.GetMetricStatisticsCommand({
            Namespace: query.namespace,
            MetricName: query.metricName,
            Dimensions: query.dimensions.map((dimension) => ({
              Name: dimension.name,
              Value: dimension.value,
            })),
            StartTime: new Date(toEpochMs(query.startTime)),
            EndTime: new Date(toEpochMs(query.endTime)),
            Period: query.periodSeconds,
            Statistics: [query.statistic],
          })
        );
        return readMetricDataPoints(response.Datapoints, query.statistic);
      } catch (error) {
        throw new MeasurementError(
          `GetMetricStatistics(${query.namespace}/${query.metricName}, ${query.statistic}) に失敗しました: ` +
            describeError(error)
        );
      }
    },

    async getExpressionSeries(query: MetricExpressionQuery): Promise<MetricExpressionResult> {
      const { sdk, client } = await connect();
      const pages: Record<string, unknown>[] = [];
      let nextToken: string | undefined;

      try {
        do {
          const input: Record<string, unknown> = {
            MetricDataQueries: [
              {
                Id: EXPRESSION_QUERY_ID,
                Expression: query.expression,
                Label: query.label,
                ReturnData: true,
              },
            ],
            StartTime: new Date(toEpochMs(query.startTime)),
            EndTime: new Date(toEpochMs(query.endTime)),
          };
          if (nextToken !== undefined) input.NextToken = nextToken;
          const response = await client.send(new sdk.GetMetricDataCommand(input));
          pages.push(response);
          nextToken = typeof response.NextToken === 'string' ? response.NextToken : undefined;
        } while (nextToken !== undefined);
      } catch (error) {
        throw new MeasurementError(
          `GetMetricData(${query.expression}) に失敗しました: ${describeError(error)}`
        );
      }

      return readMetricExpressionResult(pages);
    },
  };

  return {
    source,
    close: () => {
      if (cached !== null) {
        cached.client.destroy();
        cached = null;
      }
    },
  };
}

/** `GetMetricData` の `MetricDataQueries[].Id`。式は 1 回の呼び出しで 1 本だけ投げる */
const EXPRESSION_QUERY_ID = 'ocu';

/**
 * `GetMetricData` の応答（複数ページ）を系列の列へ写す。
 *
 * `SEARCH()` は複数系列を返し、系列は `Label` で識別される。ページをまたいだ同一系列は
 * `Label` で束ねる（`Id` は式ごとに 1 つなので識別子にならない）。時刻は昇順へ整える。
 */
export function readMetricExpressionResult(
  pages: readonly Record<string, unknown>[]
): MetricExpressionResult {
  const order: string[] = [];
  const collected: Record<string, { statusCode: string | null; points: MetricDataPoint[] }> = {};
  const messages: string[] = [];

  for (let p = 0; p < pages.length; p += 1) {
    const page = pages[p];
    const results = page.MetricDataResults;
    if (Array.isArray(results)) {
      for (let i = 0; i < results.length; i += 1) {
        const entry = asRecord(results[i]);
        if (entry === undefined) continue;
        const label = typeof entry.Label === 'string' ? entry.Label : `(ラベルなし #${i})`;
        if (collected[label] === undefined) {
          collected[label] = {
            statusCode: typeof entry.StatusCode === 'string' ? entry.StatusCode : null,
            points: [],
          };
          order.push(label);
        } else if (typeof entry.StatusCode === 'string') {
          collected[label].statusCode = entry.StatusCode;
        }

        const timestamps = Array.isArray(entry.Timestamps) ? entry.Timestamps : [];
        const values = Array.isArray(entry.Values) ? entry.Values : [];
        const length = Math.min(timestamps.length, values.length);
        for (let j = 0; j < length; j += 1) {
          const timestamp = timestamps[j];
          const iso =
            timestamp instanceof Date
              ? timestamp.toISOString()
              : typeof timestamp === 'string'
                ? toIsoString(toEpochMs(timestamp))
                : null;
          const value = firstFiniteNumber([values[j]]);
          if (iso === null || value === null) continue;
          collected[label].points.push({ timestamp: iso, value });
        }

        // 系列ごとの注意メッセージ（例: 部分データ）も取りこぼさない
        const entryMessages = entry.Messages;
        if (Array.isArray(entryMessages)) {
          for (let j = 0; j < entryMessages.length; j += 1) {
            const message = asRecord(entryMessages[j]);
            if (message !== undefined && typeof message.Value === 'string') {
              messages.push(`${label}: ${message.Value}`);
            }
          }
        }
      }
    }

    const pageMessages = page.Messages;
    if (Array.isArray(pageMessages)) {
      for (let i = 0; i < pageMessages.length; i += 1) {
        const message = asRecord(pageMessages[i]);
        if (message !== undefined && typeof message.Value === 'string') {
          messages.push(message.Value);
        }
      }
    }
  }

  const series: MetricExpressionSeries[] = order.map((label) => ({
    label,
    statusCode: collected[label].statusCode,
    points: collected[label].points.sort(
      (left, right) => toEpochMs(left.timestamp) - toEpochMs(right.timestamp)
    ),
  }));

  return { series, messages };
}

/** `Datapoints` をデータ点の列へ写す（時刻昇順） */
export function readMetricDataPoints(
  raw: unknown,
  statistic: MetricSeriesQuery['statistic']
): readonly MetricDataPoint[] {
  if (!Array.isArray(raw)) return [];

  const points: MetricDataPoint[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const point = asRecord(raw[i]);
    if (point === undefined) continue;

    const timestamp = point.Timestamp;
    const iso =
      timestamp instanceof Date
        ? timestamp.toISOString()
        : typeof timestamp === 'string'
          ? toIsoString(toEpochMs(timestamp))
          : null;
    if (iso === null) continue;

    const value = firstFiniteNumber([point[statistic]]);
    if (value === null) continue;

    points.push({ timestamp: iso, value });
  }

  return points.sort((left, right) => toEpochMs(left.timestamp) - toEpochMs(right.timestamp));
}

/** AOSS の読み取り経路を作る（`ListCollections` / `ListCollectionGroups`） */
export function createCollectionInventorySource(options: { region?: string } = {}): {
  source: CollectionInventorySource;
  close(): void;
} {
  let cached: {
    sdk: OpenSearchServerlessModuleLike;
    client: InstanceType<OpenSearchServerlessModuleLike['OpenSearchServerlessClient']>;
  } | null = null;

  const connect = async (): Promise<{
    sdk: OpenSearchServerlessModuleLike;
    client: InstanceType<OpenSearchServerlessModuleLike['OpenSearchServerlessClient']>;
  }> => {
    if (cached !== null) return cached;
    const sdk = await loadOptionalSdk<OpenSearchServerlessModuleLike>(
      OPENSEARCH_SERVERLESS_SDK_PACKAGE,
      ['OpenSearchServerlessClient', 'ListCollectionsCommand', 'ListCollectionGroupsCommand']
    );
    const client = new sdk.OpenSearchServerlessClient(
      options.region === undefined ? {} : { region: options.region }
    );
    cached = { sdk, client };
    return cached;
  };

  const listNames = async (
    operationName: 'ListCollections' | 'ListCollectionGroups'
  ): Promise<readonly string[]> => {
    const { sdk, client } = await connect();
    const names: string[] = [];
    let nextToken: string | undefined;

    try {
      do {
        const input: Record<string, unknown> = { maxResults: LIST_PAGE_SIZE };
        if (nextToken !== undefined) input.nextToken = nextToken;
        const command =
          operationName === 'ListCollections'
            ? new sdk.ListCollectionsCommand(input)
            : new sdk.ListCollectionGroupsCommand(input);
        const response = await client.send(command);
        const summaries =
          operationName === 'ListCollections'
            ? response.collectionSummaries
            : response.collectionGroupSummaries;
        if (Array.isArray(summaries)) {
          for (let i = 0; i < summaries.length; i += 1) {
            const summary = asRecord(summaries[i]);
            if (summary !== undefined && typeof summary.name === 'string') {
              names.push(summary.name);
            }
          }
        }
        nextToken = typeof response.nextToken === 'string' ? response.nextToken : undefined;
      } while (nextToken !== undefined);
    } catch (error) {
      throw new MeasurementError(`${operationName} に失敗しました: ${describeError(error)}`);
    }

    return names.sort(compareText);
  };

  return {
    source: {
      listCollectionNames: () => listNames('ListCollections'),
      listCollectionGroupNames: () => listNames('ListCollectionGroups'),
    },
    close: () => {
      if (cached !== null) {
        cached.client.destroy();
        cached = null;
      }
    },
  };
}

/**
 * OSIS の読み取り経路を作る（`ListPipelines` / `GetPipeline`）。
 *
 * **起動も設定変更も行わない**（要件 6.10）。`StartPipeline` / `UpdatePipeline` /
 * `StopPipeline` は呼ばず、SDK の型にも載せない。
 */
export function createPipelineStateSource(options: { region?: string } = {}): {
  source: PipelineStateSource;
  close(): void;
} {
  let cached: { sdk: OsisModuleLike; client: InstanceType<OsisModuleLike['OSISClient']> } | null = null;

  const connect = async (): Promise<{
    sdk: OsisModuleLike;
    client: InstanceType<OsisModuleLike['OSISClient']>;
  }> => {
    if (cached !== null) return cached;
    const sdk = await loadOptionalSdk<OsisModuleLike>(OSIS_SDK_PACKAGE, [
      'OSISClient',
      'ListPipelinesCommand',
      'GetPipelineCommand',
    ]);
    const client = new sdk.OSISClient(options.region === undefined ? {} : { region: options.region });
    cached = { sdk, client };
    return cached;
  };

  return {
    source: {
      async getPipelineStatus(pipelineName: string): Promise<string | null> {
        const { sdk, client } = await connect();
        try {
          const response = await client.send(
            new sdk.GetPipelineCommand({ PipelineName: pipelineName })
          );
          const pipeline = asRecord(response.Pipeline);
          const status = pipeline?.Status;
          return typeof status === 'string' ? status : null;
        } catch (error) {
          const name = asRecord(error)?.name;
          if (name === 'ResourceNotFoundException') return null;
          throw new MeasurementError(
            `GetPipeline(${pipelineName}) に失敗しました: ${describeError(error)}`
          );
        }
      },
    },
    close: () => {
      if (cached !== null) {
        cached.client.destroy();
        cached = null;
      }
    },
  };
}

/**
 * 署名付き HTTP で `SearchVectors` を送る経路を作る。
 *
 * `probe-range-filter.ts` と同じ方針を採り、`SearchVectorsCommand` は**使わず**、AWS JSON 1.0 の
 * 署名付き HTTP 要求をデュアルスタックエンドポイント `search-dynamodb.<region>.api.aws` へ直接送る。
 * もう 1 つの候補である `<account-id>.search-ddb.<region>.amazonaws.com` は AWS アカウント ID を
 * 実行環境へ持ち込む必要があるため採らない（要件 16.9 の趣旨に沿う）。この方針は SDK の版に依存
 * しないため、`SearchVectorsCommand` が利用可能になっても置き換えない。
 * `ReturnConsumedCapacity` を付けて消費キャパシティを読む（要件 14.7）。
 */
export async function createSearchVectorsProbe(options: {
  region?: string;
  endpoint?: string;
}): Promise<{ probe: SearchVectorsProbe; region: string; endpoint: string; close(): void }> {
  const [dynamo, signatureV4, protocolHttp, sha256] = await Promise.all([
    loadDynamoDbSdk(),
    import('@smithy/signature-v4'),
    import('@smithy/protocol-http'),
    import('@aws-crypto/sha256-js'),
  ]);

  const client = new dynamo.DynamoDBClient(
    options.region === undefined ? {} : { region: options.region }
  );
  const region = options.region ?? (await client.config.region());
  const endpoint = options.endpoint ?? `https://search-dynamodb.${region}.api.aws`;

  const signer = new signatureV4.SignatureV4({
    service: 'dynamodb',
    region,
    credentials: client.config.credentials as never,
    sha256: sha256.Sha256,
  });

  const probe: SearchVectorsProbe = {
    async search(input) {
      const url = new URL(endpoint);
      const body = JSON.stringify(buildSearchVectorsRequestBody(input));

      const request = new protocolHttp.HttpRequest({
        method: 'POST',
        protocol: url.protocol.replace(':', ''),
        hostname: url.hostname,
        port: url.port.length > 0 ? Number(url.port) : undefined,
        path: '/',
        headers: {
          host: url.host,
          'content-type': 'application/x-amz-json-1.0',
          'x-amz-target': SEARCH_VECTORS_TARGET,
        },
        body,
      });

      const startedAt = Date.now();
      try {
        const signed = await signer.sign(request);
        const response = await fetch(`${url.origin}/`, {
          method: 'POST',
          headers: signed.headers,
          body,
        });
        const text = await response.text();
        const latencyMs = Date.now() - startedAt;
        const parsed = tryParseJsonObject(text);

        if (response.status >= 200 && response.status < 300) {
          return {
            succeeded: true,
            vectorSearchRequestBytes: readVectorSearchRequestBytes(parsed?.ConsumedCapacity),
            vectorSearchUnits: readVectorSearchUnits(parsed?.ConsumedCapacity),
            latencyMs,
            errorType: null,
            errorMessage: null,
          };
        }

        return {
          succeeded: false,
          vectorSearchRequestBytes: null,
          vectorSearchUnits: null,
          latencyMs,
          errorType: readErrorType(parsed, response.status),
          errorMessage: readErrorMessage(parsed, text),
        };
      } catch (error) {
        return {
          succeeded: false,
          vectorSearchRequestBytes: null,
          vectorSearchUnits: null,
          latencyMs: Date.now() - startedAt,
          errorType: 'TransportError',
          errorMessage: describeError(error),
        };
      }
    },
  };

  return { probe, region, endpoint, close: () => client.destroy() };
}

/** エラー応答から `__type` を読む */
function readErrorType(parsed: Record<string, unknown> | undefined, httpStatus: number): string {
  const raw = parsed?.__type ?? parsed?.code ?? parsed?.Code;
  if (typeof raw === 'string' && raw !== '') {
    const parts = raw.split('#');
    return parts[parts.length - 1];
  }
  return `HTTP ${httpStatus}`;
}

/** エラー応答からメッセージを読む */
function readErrorMessage(parsed: Record<string, unknown> | undefined, rawBody: string): string {
  const raw = parsed?.message ?? parsed?.Message;
  return typeof raw === 'string' && raw !== '' ? raw : rawBody.slice(0, 500);
}

/** JSON オブジェクトとして読めれば返す */
function tryParseJsonObject(text: string): Record<string, unknown> | undefined {
  if (text.length === 0) return undefined;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * ファイルシステムへ読み書きする実装。
 *
 * `writeNew` は既存ファイルを上書きしない（`'wx'` フラグ）。同名があれば `-002` から
 * 順に連番を付けた別名で書き出し、実際のパスを返す。
 */
export function createFileSystemMeasurementStore(baseDir: string = MEASUREMENT_DIR): MeasurementStore {
  return {
    async read(fileName: string): Promise<string | null> {
      const [fs, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
      try {
        return await fs.readFile(path.join(baseDir, fileName), 'utf8');
      } catch (error) {
        if (asRecord(error)?.code === 'ENOENT') return null;
        throw error;
      }
    },

    async write(fileName: string, contents: string): Promise<void> {
      const [fs, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
      await fs.mkdir(baseDir, { recursive: true });
      await fs.writeFile(path.join(baseDir, fileName), contents, 'utf8');
    },

    async writeNew(fileName: string, contents: string): Promise<string> {
      const [fs, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
      await fs.mkdir(baseDir, { recursive: true });

      const extension = path.extname(fileName);
      const stem = extension.length > 0 ? fileName.slice(0, -extension.length) : fileName;

      for (let attempt = 1; attempt <= 999; attempt += 1) {
        const candidate =
          attempt === 1 ? fileName : `${stem}-${String(attempt).padStart(3, '0')}${extension}`;
        const target = path.join(baseDir, candidate);
        try {
          await fs.writeFile(target, contents, { encoding: 'utf8', flag: 'wx' });
          return target;
        } catch (error) {
          if (asRecord(error)?.code !== 'EEXIST') throw error;
        }
      }

      throw new MeasurementError(
        `${baseDir} に ${fileName} の書き出し先を確保できませんでした（連番が上限に達しました）。`
      );
    },
  };
}

/** 書き出しを行わない実装（`--no-write`）。読み取りは実ファイルから行う */
export function createReadOnlyMeasurementStore(
  baseDir: string = MEASUREMENT_DIR
): MeasurementStore {
  const backing = createFileSystemMeasurementStore(baseDir);
  return {
    read: (fileName: string) => backing.read(fileName),
    write: async () => undefined,
    writeNew: async (fileName: string) => `(未書き出し) ${fileName}`,
  };
}

/** 導入済みの DynamoDB SDK を遅延 import する */
async function loadDynamoDbSdk(): Promise<DynamoDbModuleLike> {
  const loaded = await import('@aws-sdk/client-dynamodb');
  return loaded as unknown as DynamoDbModuleLike;
}

// ============================================================
// 実効リージョンの解決（CLI 配線層でのみ使う）
// ============================================================

/** 実効リージョンの解決結果 */
export interface RegionResolution {
  /** レポートへ載せる実効リージョン。解決できなかった場合は null（値を捏造しない） */
  region: string | null;
  /** 解決できなかった理由を説明する注意文。解決できた場合は null */
  warning: string | null;
}

/** リージョンを解決できなかったときにレポートへ載せる注意文（純関数） */
export function describeUnresolvedRegion(cause: string): string {
  return (
    'AWS リージョンを解決できませんでした。レポートの region は null のままです。' +
    '測定条件にはリージョンの記載が必要であるため（要件 14.17）、' +
    '--region <region> を明示して再実行するか、AWS_REGION の設定を確認してください。' +
    `原因: ${cause}`
  );
}

/**
 * レポートへ載せる実効リージョンを決める。
 *
 * `--region` が与えられていればそれを使い、無ければ SDK の既定解決（環境変数 →
 * 共有設定ファイル → インスタンスメタデータ）で実際に使われるリージョンを読む。
 * 読み取り経路は `--capacity` が既に用いている `client.config.region()` と同一である。
 *
 * 解決できなかった場合でも例外にはしない。本スクリプトは読み取り専用であり、
 * `--pre-check` のように AWS 呼び出しの前に落とす理由のないモードを、リージョン記載の
 * ためだけに実行不能にはしない。解決できなかったことは `warning` として記録する。
 *
 * `resolve` を差し替えられるようにしてあるのは、テストから SDK へ触れずに検証するためである。
 */
export async function resolveEffectiveRegion(
  explicitRegion?: string | null,
  resolve: () => Promise<string> = resolveRegionFromSdkDefaults
): Promise<RegionResolution> {
  if (typeof explicitRegion === 'string' && explicitRegion !== '') {
    return { region: explicitRegion, warning: null };
  }

  try {
    const resolved = await resolve();
    if (typeof resolved !== 'string' || resolved === '') {
      return {
        region: null,
        warning: describeUnresolvedRegion('SDK の既定解決が空のリージョンを返しました。'),
      };
    }
    return { region: resolved, warning: null };
  } catch (error) {
    return { region: null, warning: describeUnresolvedRegion(describeError(error)) };
  }
}

/**
 * SDK の既定解決で実効リージョンを読む。
 *
 * クライアントを 1 つ作って設定を読むだけであり、AWS への API 呼び出しは行わない
 * （認証情報の解決も伴わない）。読み終えたらソケットを閉じる。
 */
async function resolveRegionFromSdkDefaults(): Promise<string> {
  const sdk = await loadDynamoDbSdk();
  const client = new sdk.DynamoDBClient({});
  try {
    return await client.config.region();
  } finally {
    client.destroy();
  }
}

/**
 * 未導入の可能性がある SDK を遅延 import する。
 *
 * モジュール指定子を `string` 型の変数越しに渡すことで、型検査の時点で未導入
 * パッケージの解決を要求しない。実行時に見つからない場合は導入手順を含むエラーへ変換する
 * （`validate-scale-to-zero.ts` と同じ方針。依存関係の追加はここでは行わない）。
 */
async function loadOptionalSdk<T>(packageName: string, requiredExports: readonly string[]): Promise<T> {
  const specifier: string = packageName;

  let loaded: unknown;
  try {
    loaded = await import(specifier);
  } catch (error) {
    throw new MeasurementError(
      [
        `${packageName} を読み込めませんでした。`,
        'この SDK は本リポジトリにまだ導入されていません。次のコマンドで追加してください。',
        `  npm install --save-dev ${packageName}`,
        `（本スクリプトが使う 3 つをまとめて追加する場合: ${OPTIONAL_SDK_INSTALL_COMMAND}）`,
        `原因: ${describeError(error)}`,
      ].join('\n')
    );
  }

  const loadedModule = asRecord(loaded);
  if (loadedModule === undefined) {
    throw new MeasurementError(`${packageName} の読み込み結果がモジュールオブジェクトではありません。`);
  }

  const defaultExport = asRecord(loadedModule.default);
  const candidate =
    defaultExport !== undefined && requiredExports[0] in defaultExport ? defaultExport : loadedModule;

  for (let i = 0; i < requiredExports.length; i += 1) {
    const name = requiredExports[i];
    if (typeof candidate[name] !== 'function') {
      throw new MeasurementError(
        `${packageName} に ${name} が見つかりません。対応した版へ更新してください。`
      );
    }
  }

  return candidate as unknown as T;
}

// ============================================================
// 型: レポート
// ============================================================

/** 測定モード。1 回の実行でいずれか 1 つを指定する */
export const MEASUREMENT_MODES = [
  'pre-check',
  'wait-index',
  'storage',
  'capacity',
  'ocu',
  'watch-spend',
  'teardown-check',
] as const;

/** {@link MEASUREMENT_MODES} の要素 */
export type MeasurementMode = (typeof MEASUREMENT_MODES)[number];

/** チェック項目の判定。確認できなかったものを `pass` に混ぜない */
export type ChecklistStatus = 'pass' | 'fail' | 'unknown';

/** チェックリストの 1 項目（task 15.1 / 段階 0） */
export interface ChecklistItem {
  id: string;
  description: string;
  status: ChecklistStatus;
  detail: string;
}

/** 全モードで共通のレポート項目 */
export interface MeasurementReportBase {
  schemaVersion: number;
  mode: MeasurementMode;
  generatedAt: string;
  region: string | null;
  /** 本スクリプトが読み取り専用であること。常に true */
  readOnly: true;
  /** 検証担当者の対応を要する事項。1 件以上あれば終了コード 2 */
  warnings: readonly string[];
  notes: readonly string[];
}

/** `--pre-check` の出力（要件 1.5 / 6.9 / 6.10） */
export interface PreCheckReport extends MeasurementReportBase {
  mode: 'pre-check';
  pipelineName: string;
  pipelineStatus: string | null;
  pipelineStopped: boolean;
  goodTableName: string;
  goodTableSnapshot: GoodTableSnapshot | null;
  /** スナップショットの保存先。`--no-write` なら未書き出しを示す文字列 */
  snapshotPath: string | null;
  /** 既存の基準スナップショットを上書きしなかったこと */
  baselinePreserved: boolean;
  checklist: readonly ChecklistItem[];
}

/** `--wait-index` の出力（要件 5.14） */
export interface WaitIndexReport extends MeasurementReportBase {
  mode: 'wait-index';
  wait: IndexWaitResult;
}

/** `--storage` の出力（要件 14.2〜14.6） */
export interface StorageReport extends MeasurementReportBase {
  mode: 'storage';
  tableName: string;
  recordCount: number;
  /** この実行で新たに取得したスナップショット。取得なしの実行では空 */
  capturedSnapshots: readonly StorageSnapshot[];
  /** 台帳に保持している全件（先行スナップショットを破棄しない証跡。要件 14.5） */
  ledgerSnapshotCount: number;
  ledgerPath: string | null;
  /** `TableSizeBytes` の収束判定（S1 / S2 / INDEX ごと） */
  tableSizeConvergence: readonly SnapshotConvergence[];
  /** `IndexSizeBytes` の収束判定（インデックスごと） */
  indexSizeConvergence: readonly SnapshotConvergence[];
  contribution: StorageContribution | null;
  /** 寄与の算出に用いた S1 / S2 がともに収束済みか（要件 14.4） */
  contributionDeterminate: boolean;
  indexTotals: VectorIndexSizeTotals | null;
  /** インデックス合計の算出に用いた値がすべて収束済みか */
  indexTotalsDeterminate: boolean;
  gsiNote: string;
  indexSizeNote: string;
}

/** `--capacity` の出力（要件 14.7 / 14.8） */
export interface CapacityReport extends MeasurementReportBase {
  mode: 'capacity';
  tableName: string;
  dimensions: number;
  vectorSeed: number;
  consumedCapacity: ConsumedCapacitySummary;
  samples: readonly SearchProbeSample[];
  latency: SeriesSummary;
  requestBytes: readonly RequestBytesSummary[];
  requestBytesAvailable: boolean;
}

/** OCU 使用率の集計（要件 7.8） */
export interface UtilizationSummary {
  minimum: SeriesSummary;
  average: SeriesSummary;
  maximum: SeriesSummary;
  /** 絞り込みに用いた次元（`CollectionGroupName`）。0 件だった場合に何を訊いたのかを示す */
  dimension: MetricDimension;
  /** 統計種別ごとの `SEARCH()` 式・系列数・データ点数（Minimum / Average / Maximum の順） */
  resolutions: readonly OcuSeriesResolution[];
  /**
   * 3 系列のいずれかにデータ点があったか。
   *
   * `false` は「使用率 0 を測定した」ではなく「測定値が存在しない」ことを意味する。
   * 空の要約を測定済みの 0 と読み違えないための明示的な区別である（要件 7.8）。
   */
  dataPointsPresent: boolean;
  /** データ点が 0 件だった理由と含意。データ点があれば null */
  unavailableReason: string | null;
}

/** `--ocu` の出力（要件 7.3 / 7.4 / 7.6 / 7.8 / 14.9） */
export interface OcuReport extends MeasurementReportBase {
  mode: 'ocu';
  /**
   * OCU メトリクスの絞り込みに用いた Collection Group 名。
   *
   * OCU は Collection ではなく Collection Group で公開されるため、本モードは Collection 名を
   * 一切参照しない（{@link aossOcuDimensions}）。
   */
  collectionGroupName: string;
  /** 絞り込みに用いた次元（名前と値）。0 OCU の報告を自己記述的にするために出力へ残す */
  ocuDimension: MetricDimension;
  /**
   * 実際に投げた `SEARCH()` 式・次元キー集合・返った系列数とデータ点数。
   *
   * データ点 0 件を「0 OCU」と読み違えないための証跡であり、次元不足の再発を検出する手掛かりでもある。
   */
  ocuQuery: OcuQueryDescriptor;
  windowStart: string;
  windowEnd: string;
  windowHours: number;
  periodSeconds: number;
  /** 片側のみデータ点があった時刻の件数（もう片方は 0 として埋めた） */
  alignment: { pairedCount: number; searchOnlyCount: number; indexingOnlyCount: number };
  analysis: OcuUsageAnalysis;
  utilization: UtilizationSummary;
  /** 区間分解の合計と全体の累積が一致するか（Property 50 の保存則の自己点検） */
  partitionConserved: boolean;
}

/** `--watch-spend` の出力（要件 7.7） */
export interface WatchSpendReport extends MeasurementReportBase {
  mode: 'watch-spend';
  /** 削除要求文に載せる Collection 名。OCU の照会には使わない */
  collectionName: string;
  /** OCU メトリクスの絞り込みに用いた Collection Group 名 */
  collectionGroupName: string;
  /** 絞り込みに用いた次元（名前と値） */
  ocuDimension: MetricDimension;
  /** 実際に投げた `SEARCH()` 式・次元キー集合・返った系列数とデータ点数 */
  ocuQuery: OcuQueryDescriptor;
  windowStart: string;
  windowEnd: string;
  periodSeconds: number;
  spend: SpendAccumulation;
  /** 区間分解（要件 14.9）。積算に採用した範囲について出す */
  analysis: OcuUsageAnalysis;
}

/** `--teardown-check` の出力（task 15.1、要件 1.5 / 6.9 / 7.4 / 7.7 / 18.14 / 18.15） */
export interface TeardownCheckReport extends MeasurementReportBase {
  mode: 'teardown-check';
  checklist: readonly ChecklistItem[];
  /** すべての項目が `pass` か。1 件でも `fail` / `unknown` があれば false */
  teardownComplete: boolean;
  remainingTableNames: readonly string[];
  remainingCollectionNames: readonly string[];
  remainingCollectionGroupNames: readonly string[];
  /**
   * OCU メトリクスの絞り込みに用いた次元（名前と値）。
   *
   * OCU が 0 だったのか、そもそもデータ点が無かったのかを読み手が検証できるようにするため、
   * 何を訊いたのかを出力へ残す。CloudWatch を参照しなかった場合は null。
   */
  ocuDimension: MetricDimension | null;
  /** 実際に投げた `SEARCH()` 式・次元キー集合・返った系列数とデータ点数。未参照なら null */
  ocuQuery: OcuQueryDescriptor | null;
  ocuAnalysis: OcuUsageAnalysis | null;
  goodTableComparison: GoodTableComparison | null;
  pipelineStatus: string | null;
  /** 削除は一切行っていないこと。常に true */
  deletionPerformed: false;
}

/** 測定レポートの総体 */
export type MeasurementReport =
  | PreCheckReport
  | WaitIndexReport
  | StorageReport
  | CapacityReport
  | OcuReport
  | WatchSpendReport
  | TeardownCheckReport;

// ============================================================
// 純関数: 台帳の読み書き
// ============================================================

/** 台帳の JSON を解釈する。壊れている場合は例外にして、既存の記録を上書きしない */
export function parseSnapshotStore(text: string): StorageSnapshotStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new MeasurementError(
      `${STORAGE_SNAPSHOT_STORE_FILE} を JSON として解釈できません（${describeError(error)}）。` +
        '既存の記録を失わないため、内容を確認するまで書き込みを行いません。'
    );
  }

  const record = asRecord(parsed);
  if (record === undefined || !Array.isArray(record.snapshots)) {
    throw new MeasurementError(
      `${STORAGE_SNAPSHOT_STORE_FILE} の形が想定と異なります（snapshots 配列が必要です）。`
    );
  }

  const snapshots: StorageSnapshot[] = [];
  for (let i = 0; i < record.snapshots.length; i += 1) {
    const entry = asRecord(record.snapshots[i]);
    if (entry === undefined) continue;
    const value = firstFiniteNumber([entry.value]);
    if (
      typeof entry.label !== 'string' ||
      (entry.field !== 'TableSizeBytes' && entry.field !== 'IndexSizeBytes') ||
      typeof entry.target !== 'string' ||
      typeof entry.capturedAt !== 'string' ||
      value === null
    ) {
      throw new MeasurementError(
        `${STORAGE_SNAPSHOT_STORE_FILE} の ${i} 番目のスナップショットに欠けている項目があります。`
      );
    }
    snapshots.push({
      label: entry.label,
      field: entry.field,
      target: entry.target,
      value,
      capturedAt: entry.capturedAt,
      itemCount: firstFiniteNumber([entry.itemCount]),
    });
  }

  return { schemaVersion: MEASUREMENT_SCHEMA_VERSION, snapshots };
}

/** 台帳に含まれる対象名を列挙する（ラベルを問わない） */
export function listSnapshotTargets(
  store: StorageSnapshotStore,
  field: StorageField
): readonly string[] {
  const seen: Record<string, true> = {};
  const targets: string[] = [];
  for (let i = 0; i < store.snapshots.length; i += 1) {
    const snapshot = store.snapshots[i];
    if (snapshot.field !== field) continue;
    if (seen[snapshot.target] === true) continue;
    seen[snapshot.target] = true;
    targets.push(snapshot.target);
  }
  return targets.sort(compareText);
}

/** 対象名で絞ってスナップショットを取り出す（時刻昇順） */
export function selectSnapshotsByTarget(
  store: StorageSnapshotStore,
  field: StorageField,
  target: string
): readonly StorageSnapshot[] {
  return store.snapshots
    .filter((snapshot) => snapshot.field === field && snapshot.target === target)
    .sort((left, right) => toEpochMs(left.capturedAt) - toEpochMs(right.capturedAt));
}

// ============================================================
// 純関数: メトリクス問い合わせの組み立て
// ============================================================

/**
 * OCU メトリクスの絞り込みに使う次元（値が既知の唯一の次元）。
 *
 * **これは次元集合の全体ではない。**`GetMetricStatistics` へこの 1 件だけを渡してはならない
 * （理由は {@link aossOcuSearchExpression}）。レポートに「どの Collection Group を対象に
 * 絞り込んだか」を残すためだけに使う。
 */
export function aossOcuFilterDimension(collectionGroupName: string): MetricDimension {
  return { name: AOSS_OCU_DIMENSION_NAME, value: collectionGroupName };
}

/**
 * OCU メトリクス（`SearchOCU` / `IndexingOCU` / `OCUUtilization`）を引く `SEARCH()` 式を組む。
 *
 * **OCU は Collection ではなく Collection Group で公開される。**`CollectionName` で絞ると
 * データ点が常に 0 件になり、「0 OCU を測定した」と区別できなくなる。
 *
 * us-west-2 の実アカウントに対する `cloudwatch:ListMetrics`（Namespace: `AWS/AOSS`）で
 * 観測した次元キー集合:
 *
 * | メトリクス | 次元キー集合 |
 * |---|---|
 * | `SearchOCU` / `IndexingOCU` | `ClientId`, `CollectionGroupId`, `CollectionGroupName` |
 * | `2xx` / `4xx` / `ActiveCollection` / `IngestionRequest*` / `SearchRequest*` / `SearchableDocuments` / `DeletedDocuments` / `StorageUsedInHot` / `StorageUsedInS3` | `ClientId`, `CollectionId`, `CollectionName` |
 *
 * すなわち per-Collection の次元を持つのはドキュメント数・ストレージ・リクエスト系だけであり、
 * OCU 系は per-Collection の次元を持たない。これは NextGen のモデルで容量上限
 * （`capacityLimits` の min / max OCU）が Collection Group の属性であることと整合する。
 *
 * ## なぜ `GetMetricStatistics` を使わないのか（この関数が存在する理由）
 *
 * `GetMetricStatistics` は**次元集合の完全一致**を要求する。OCU 系列は上記の 3 次元を持つため、
 * `CollectionGroupName` の 1 次元だけを渡した照会は、OCU を実際に消費していても常に
 * データ点 0 件を返す。実測（us-west-2 / `kiro-inventory-vector-group`）でも
 * 1 次元指定では 0 件、3 次元完全指定では 5 分間隔 24 時間分の 288 点が返った。
 * これは「0 OCU を測定した」と「測定できていない」の区別を静かに壊す欠陥であり、
 * 要件 7.7 の 20 USD 閾値ガードを無効化する。
 *
 * ## 採用した案と却下した案
 *
 * - **採用（案 B）: `GetMetricData` + `SEARCH()`。** 次元スキーマを式で宣言し、Collection Group 名を
 *   検索語として絞る。`ClientId`（アカウント ID）と `CollectionGroupId` を**自前で解決しなくてよい**
 *   ため、`sts:GetCallerIdentity` と `opensearchserverless:ListCollectionGroups` への依存が増えない。
 *   また Collection Group を作り直すと `CollectionGroupId` が変わるが、名前で絞る本方式は
 *   履歴値をまとめて拾えるため取りこぼさない（実測: 既存 Collection Group
 *   `kiro-inventory-group` は 8 本の `CollectionGroupId` 系列が該当し、うち 1 本にデータがあった）。
 * - **却下（案 A）: `GetMetricStatistics` の次元を 3 件に増やす。** `ClientId` は
 *   `sts:GetCallerIdentity`、`CollectionGroupId` は `ListCollectionGroups` で解決できるため実現は可能。
 *   却下した理由は 2 つ。(1) 将来 AWS が次元構成を変えた場合、完全一致要求のため**再び黙って
 *   空を返す**。同じ欠陥を作り直せる形を残さない。(2) 作り直しで `CollectionGroupId` が変わると
 *   過去区間の系列を取りこぼし、24 時間観測（要件 7.3）が欠測する。
 *
 * ただし `SEARCH()` は**複数系列を返しうる**。系列数とデータ点を持つ系列数は
 * {@link resolveOcuSeries} が検証し、想定外なら警告として出力へ残す。系列を 1 本も返さない
 * ことは「0 OCU」ではなく「測定できていない」として扱う。
 *
 * `OCUUtilization` は当該アカウントの `ListMetrics` に現れなかった。`ListMetrics` は直近
 * 約 14 日にデータのあるメトリクスのみを列挙するため、これは「最近この account で公開されて
 * いない」ことを意味するに留まり、「存在しない」ことの証明ではない。
 *
 * per-Collection メトリクス（`SearchableDocuments` 等）を追加する場合はこの関数を使わず、
 * `CollectionName` 次元を完全指定した {@link MetricSeriesQuery} を用いること
 * （per-Collection 系は次元キー集合が既知なので `GetMetricStatistics` で足りる）。
 */
export function aossOcuSearchExpression(options: {
  collectionGroupName: string;
  metricName: string;
  statistic: MetricSeriesQuery['statistic'];
  periodSeconds: number;
}): string {
  // 検索語とメトリクス名は二重引用符で囲むため、引用符・改行を含む値は式を壊しうる。
  // 黙って壊れた式を投げると CloudWatch 側の解釈次第で空の結果になり、
  // 「次元不足で空が返る」のと同じ見分けの付かない失敗に戻ってしまう
  assertSearchTermSafe(options.collectionGroupName, '--collection-group');
  assertSearchTermSafe(options.metricName, 'メトリクス名');

  const schema = `{${AOSS_METRIC_NAMESPACE},${AOSS_OCU_DIMENSION_KEYS.join(',')}}`;
  const filter = `${schema} MetricName="${options.metricName}" "${options.collectionGroupName}"`;
  return `SEARCH('${filter}', '${options.statistic}', ${options.periodSeconds})`;
}

/** `SEARCH()` の文字列リテラルへ埋め込めない文字を弾く */
function assertSearchTermSafe(value: string, label: string): void {
  if (value === '') {
    throw new MeasurementError(`${label} が空です。SEARCH() 式を組み立てられません。`);
  }
  if (/["'\\\n\r]/.test(value)) {
    throw new MeasurementError(
      `${label}（${value}）に引用符・バックスラッシュ・改行が含まれています。` +
        'SEARCH() 式へ安全に埋め込めないため中断します。'
    );
  }
}

/** OCU メトリクス 1 本ぶんの照会結果。式・系列数・データ点数をレポートへ残すための形 */
export interface OcuSeriesResolution {
  metricName: string;
  statistic: MetricSeriesQuery['statistic'];
  /** 実際に投げた `SEARCH()` 式 */
  expression: string;
  /** 式が宣言した次元キー集合（CloudWatch が完全一致を要求する集合） */
  dimensionKeys: readonly string[];
  /** 返った系列の本数 */
  seriesCount: number;
  /** そのうちデータ点を 1 件以上持つ系列の本数 */
  seriesWithDataCount: number;
  /** 各系列の Label（動的ラベルにより次元値を含む）とデータ点数 */
  series: readonly { label: string; statusCode: string | null; dataPointCount: number }[];
  /** 統合後のデータ点数 */
  dataPointCount: number;
  /** CloudWatch が返した注意メッセージ */
  messages: readonly string[];
  /**
   * データ点を 1 件以上取得できたか。
   *
   * `false` は「0 OCU を測定した」ではなく「測定できていない」を意味する。
   * 要件 7.7 の閾値ガードはこの場合に 0 とみなさず、安全側（未知）に倒す。
   */
  measured: boolean;
  /** 系列数が想定外だった場合の説明。想定内（データを持つ系列がちょうど 1 本）なら null */
  anomaly: string | null;
}

/**
 * `SEARCH()` の結果を 1 本の系列へ畳み込み、系列数を検証する（純関数）。
 *
 * `SEARCH()` は次元値を自前で解決しない代償として複数系列を返しうる。Collection Group を
 * 作り直すと同名で `CollectionGroupId` の異なる系列が並ぶためである（実測で 8 本）。
 * 通常はそのうち 1 本だけがデータを持つ。
 *
 * - データを持つ系列が 0 本 → **測定できていない**（`measured: false`）。0 とはみなさない
 * - データを持つ系列が 1 本 → 正常。その系列の点をそのまま使う
 * - データを持つ系列が 2 本以上 → 想定外。`anomaly` に記録し、**同一時刻は最大値を採る**。
 *   ある瞬間の OCU は 1 つの値であり履歴 ID が同時に動くことはないため、合算は二重計上に
 *   なりうる。最大値は費用ガードとして過小評価にならない側であり、安全側に倒れる
 */
export function resolveOcuSeries(input: {
  metricName: string;
  statistic: MetricSeriesQuery['statistic'];
  expression: string;
  collectionGroupName: string;
  windowStart: string;
  windowEnd: string;
  result: MetricExpressionResult;
}): { resolution: OcuSeriesResolution; points: readonly MetricDataPoint[] } {
  const series = input.result.series.map((entry) => ({
    label: entry.label,
    statusCode: entry.statusCode,
    dataPointCount: entry.points.length,
  }));
  const withData = input.result.series.filter((entry) => entry.points.length > 0);

  // 同一時刻に複数系列が値を持つ場合は最大値を採る（過小評価しない側）
  const byTimestamp: Record<string, number> = {};
  for (let i = 0; i < withData.length; i += 1) {
    const points = withData[i].points;
    for (let j = 0; j < points.length; j += 1) {
      const key = toIsoString(toEpochMs(points[j].timestamp));
      const existing = byTimestamp[key];
      byTimestamp[key] = existing === undefined ? points[j].value : Math.max(existing, points[j].value);
    }
  }
  const points = Object.keys(byTimestamp)
    .sort((left, right) => toEpochMs(left) - toEpochMs(right))
    .map((timestamp) => ({ timestamp, value: byTimestamp[timestamp] }));

  const where =
    `メトリクス ${input.metricName} / 式 ${input.expression} / ` +
    `区間 ${input.windowStart} 〜 ${input.windowEnd}`;
  let anomaly: string | null = null;
  if (withData.length === 0) {
    anomaly =
      `SEARCH() がデータ点を持つ系列を 1 本も返しませんでした（該当系列 ${series.length} 本 / ${where}）。` +
      'これは「0 OCU を測定した」ことではなく「測定できていない」ことを意味します。' +
      `次元キー集合（${AOSS_OCU_DIMENSION_KEYS.join(' / ')}）と ` +
      `${AOSS_OCU_DIMENSION_NAME}=${input.collectionGroupName} が実在の系列と一致しているかを ` +
      'ListMetrics で確認してください。';
  } else if (withData.length > 1) {
    anomaly =
      `SEARCH() がデータ点を持つ系列を ${withData.length} 本返しました（該当系列 ${series.length} 本 / ${where}）。` +
      `Collection Group の作り直しにより ${AOSS_OCU_DIMENSION_KEYS[1]} が複数存在する場合に起こります。` +
      '同一時刻は最大値を採って 1 本へ畳み込みました（費用ガードとして過小評価しない側）。' +
      `系列の内訳: ${series.map((entry) => `${entry.label}（${entry.dataPointCount} 点）`).join(' / ')}`;
  }

  return {
    resolution: {
      metricName: input.metricName,
      statistic: input.statistic,
      expression: input.expression,
      dimensionKeys: AOSS_OCU_DIMENSION_KEYS,
      seriesCount: series.length,
      seriesWithDataCount: withData.length,
      series,
      dataPointCount: points.length,
      messages: input.result.messages,
      measured: points.length > 0,
      anomaly,
    },
    points,
  };
}

/**
 * OCU メトリクス 1 本を `SEARCH()` で取得して畳み込む。
 *
 * 式の組み立て（{@link aossOcuSearchExpression}）と系列の検証（{@link resolveOcuSeries}）を
 * 一箇所に束ねる。OCU メトリクスの取得経路をここだけにすることで、
 * 「次元不足で黙って空を返す」状態へ戻る余地を残さない。
 */
async function fetchOcuSeries(
  metrics: MetricSource,
  input: {
    collectionGroupName: string;
    metricName: string;
    statistic: MetricSeriesQuery['statistic'];
    window: { startTime: string; endTime: string };
    periodSeconds: number;
  }
): Promise<{ resolution: OcuSeriesResolution; points: readonly MetricDataPoint[] }> {
  const expression = aossOcuSearchExpression({
    collectionGroupName: input.collectionGroupName,
    metricName: input.metricName,
    statistic: input.statistic,
    periodSeconds: input.periodSeconds,
  });
  const result = await metrics.getExpressionSeries({
    expression,
    label: AOSS_OCU_SERIES_LABEL_TEMPLATE,
    startTime: input.window.startTime,
    endTime: input.window.endTime,
  });
  return resolveOcuSeries({
    metricName: input.metricName,
    statistic: input.statistic,
    expression,
    collectionGroupName: input.collectionGroupName,
    windowStart: input.window.startTime,
    windowEnd: input.window.endTime,
    result,
  });
}

/** OCU メトリクスの照会条件と結果。0 OCU と測定不能を読み手が区別できるようにレポートへ残す */
export interface OcuQueryDescriptor {
  /**
   * CloudWatch が完全一致を要求する次元キー集合。
   *
   * `GetMetricStatistics` へ `CollectionGroupName` の 1 件だけを渡すと常に空が返る
   * （{@link aossOcuSearchExpression}）。本スクリプトは `SEARCH()` でこの集合を宣言する。
   */
  dimensionKeys: readonly string[];
  /** 絞り込みに用いた次元（名前と値）。値は `--collection-group` */
  filterDimension: MetricDimension;
  /** メトリクスごとの式・系列数・データ点数 */
  resolutions: readonly OcuSeriesResolution[];
  /** すべてのメトリクスでデータ点を取得できたか */
  allMeasured: boolean;
}

/** 照会結果から記述子を組む（純関数） */
export function buildOcuQueryDescriptor(
  collectionGroupName: string,
  resolutions: readonly OcuSeriesResolution[]
): OcuQueryDescriptor {
  return {
    dimensionKeys: AOSS_OCU_DIMENSION_KEYS,
    filterDimension: aossOcuFilterDimension(collectionGroupName),
    resolutions,
    allMeasured:
      resolutions.length > 0 && resolutions.every((resolution) => resolution.measured),
  };
}

/** `VectorSearchRequestBytes` の次元（要件 14.8） */
export function requestBytesDimensions(
  tableName: string,
  indexName: string
): readonly MetricDimension[] {
  return [
    { name: 'TableName', value: tableName },
    { name: 'VectorIndexName', value: indexName },
  ];
}

/** 取得区間を 5 分境界へ丸める。CloudWatch のバケット境界と揃えて端の欠落を防ぐ */
export function alignWindowToPeriod(
  startTime: string,
  endTime: string,
  periodSeconds: number = OCU_SAMPLE_PERIOD_SECONDS
): { startTime: string; endTime: string } {
  const stepMs = periodSeconds * 1000;
  return {
    startTime: toIsoString(Math.floor(toEpochMs(startTime) / stepMs) * stepMs),
    endTime: toIsoString(Math.ceil(toEpochMs(endTime) / stepMs) * stepMs),
  };
}

// ============================================================
// モード: --pre-check（段階 0。要件 1.5 / 6.9 / 6.10）
// ============================================================

/**
 * 段階 0 の事前確認を行う（要件 1.5 / 6.9 / 6.10）。
 *
 * OSIS パイプラインの状態を確認し、`STOPPED` 以外なら警告を出す。**起動も設定変更も行わない。**
 * Good_Table のスナップショットを task 13.20 と撤収確認（task 15.1）の比較基準として保存する。
 *
 * スナップショットの書き出しには {@link MeasurementStore.writeNew} を使う。既に基準ファイルが
 * ある場合は連番付きの別名へ書き、基準を上書きしない。基準は「本機能のデプロイ前」の状態で
 * なければならず、2 回目の実行で置き換わると比較の意味が失われる。
 */
export async function runPreCheck(options: {
  dynamo: DynamoDbMeasurementSource;
  pipelines: PipelineStateSource;
  store: MeasurementStore;
  clock?: MeasurementClock;
  region?: string | null;
  goodTableName?: string;
  pipelineName?: string;
  scanLimit?: number;
  write?: boolean;
}): Promise<PreCheckReport> {
  const clock = options.clock ?? createSystemClock();
  const goodTableName = options.goodTableName ?? DEFAULT_GOOD_TABLE_NAME;
  const pipelineName = options.pipelineName ?? DEFAULT_INGESTION_PIPELINE_NAME;
  const generatedAt = clock.now().toISOString();
  const warnings: string[] = [];
  const notes: string[] = [];
  const checklist: ChecklistItem[] = [];

  let pipelineStatus: string | null = null;
  let pipelineStatusKnown = true;
  try {
    pipelineStatus = await options.pipelines.getPipelineStatus(pipelineName);
  } catch (error) {
    pipelineStatusKnown = false;
    warnings.push(
      `OSIS パイプライン ${pipelineName} の状態を取得できませんでした: ${describeError(error)}`
    );
  }

  const pipelineStopped = pipelineStatus === EXPECTED_PIPELINE_STATUS;
  checklist.push({
    id: 'pipeline-stopped',
    description: `OSIS ${pipelineName} が ${EXPECTED_PIPELINE_STATUS} である（要件 6.9 / 6.10）`,
    status: !pipelineStatusKnown ? 'unknown' : pipelineStopped ? 'pass' : 'fail',
    detail: pipelineStatusKnown
      ? `取得した状態: ${pipelineStatus ?? '(パイプラインが存在しない)'}`
      : '状態を取得できませんでした',
  });

  if (pipelineStatusKnown && !pipelineStopped) {
    warnings.push(
      `OSIS パイプライン ${pipelineName} の状態が ${pipelineStatus ?? '(存在しない)'} です。` +
        `${EXPECTED_PIPELINE_STATUS} であることが段階 0 のゲート条件です（要件 6.9）。` +
        '本スクリプトはパイプラインの起動も設定変更も行いません（要件 6.10）。' +
        '検証担当者が状態を確認し、必要なら手動で停止してください。'
    );
  }

  const table = await options.dynamo.describeTable(goodTableName);
  let snapshot: GoodTableSnapshot | null = null;
  let snapshotPath: string | null = null;
  let baselinePreserved = true;

  if (table === null) {
    warnings.push(
      `Good_Table ${goodTableName} が見つかりません。テーブル名を確認してください（--good-table で変更できます）。`
    );
    checklist.push({
      id: 'good-table-snapshot',
      description: 'Good_Table のスナップショットを取得した（要件 1.5）',
      status: 'fail',
      detail: `${goodTableName} が存在しません`,
    });
  } else {
    const pitr = await options.dynamo.describeContinuousBackups(goodTableName);
    const items = await options.dynamo.sampleItems(
      goodTableName,
      options.scanLimit ?? GOOD_TABLE_SCAN_LIMIT
    );
    snapshot = buildGoodTableSnapshot({
      table,
      pointInTimeRecoveryStatus: pitr,
      items,
      capturedAt: generatedAt,
      region: options.region ?? null,
    });

    const expectationWarnings = evaluateGoodTableExpectations(snapshot);
    for (let i = 0; i < expectationWarnings.length; i += 1) {
      warnings.push(expectationWarnings[i]);
    }

    checklist.push({
      id: 'good-table-snapshot',
      description: 'Good_Table のスナップショットを取得した（要件 1.5）',
      status: 'pass',
      detail:
        `PK/SK: ${snapshot.keySchema.join(', ')} / GSI ${snapshot.globalSecondaryIndexes.length} 本 / ` +
        `Streams: ${snapshot.streamEnabled ? snapshot.streamViewType ?? '(種別不明)' : '無効'} / ` +
        `PITR: ${snapshot.pointInTimeRecoveryStatus} / ItemCount: ${formatInteger(snapshot.itemCount)} / ` +
        `抽出 ${snapshot.sampleItems.length} 件`,
    });

    if (options.write !== false) {
      const existing = await options.store.read(GOOD_TABLE_SNAPSHOT_FILE);
      snapshotPath = await options.store.writeNew(
        GOOD_TABLE_SNAPSHOT_FILE,
        `${JSON.stringify(snapshot, null, 2)}\n`
      );
      if (existing !== null) {
        baselinePreserved = true;
        warnings.push(
          `${GOOD_TABLE_SNAPSHOT_FILE} は既に存在します。基準を上書きせず ${snapshotPath} へ書き出しました。` +
            '撤収確認（--teardown-check）が読むのは最初に取得した基準ファイルです。' +
            '基準を差し替える場合は、既存ファイルを退避したうえで再実行してください。'
        );
      }
    } else {
      notes.push('--no-write が指定されたため、スナップショットをファイルへ書き出していません。');
    }
  }

  notes.push(
    'このスナップショットは task 13.20（デプロイ後の再確認）と task 15.1（撤収確認）の比較基準です。' +
      'Good_Table に対しては DescribeTable / DescribeContinuousBackups / Scan（Limit 付き）のみを実行しています（要件 1.4）。'
  );

  return {
    schemaVersion: MEASUREMENT_SCHEMA_VERSION,
    mode: 'pre-check',
    generatedAt,
    region: options.region ?? null,
    readOnly: true,
    warnings,
    notes,
    pipelineName,
    pipelineStatus,
    pipelineStopped,
    goodTableName,
    goodTableSnapshot: snapshot,
    snapshotPath,
    baselinePreserved,
    checklist,
  };
}

// ============================================================
// モード: --wait-index（要件 5.14）
// ============================================================

/** 2 本のインデックスの ACTIVE 到達とバックフィル完了を待つ（要件 5.14） */
export async function runWaitIndex(options: {
  dynamo: Pick<DynamoDbMeasurementSource, 'describeTable'>;
  clock?: MeasurementClock;
  region?: string | null;
  tableName?: string;
  indexNames?: readonly string[];
  timeoutMinutes?: number;
  pollIntervalSeconds?: number;
}): Promise<WaitIndexReport> {
  const clock = options.clock ?? createSystemClock();
  const tableName = options.tableName ?? DEFAULT_VECTOR_TABLE_NAME;
  const indexNames =
    options.indexNames ?? VECTOR_LANGUAGES.map((language) => resolveIndexName(language));

  const wait = await waitForIndexReadiness({
    source: options.dynamo,
    tableName,
    indexNames,
    timeoutMinutes: options.timeoutMinutes,
    pollIntervalSeconds: options.pollIntervalSeconds,
    clock,
  });

  const warnings: string[] = [];
  const unmeasurable: string[] = [];
  for (let i = 0; i < wait.records.length; i += 1) {
    const record = wait.records[i];
    if (record.error !== null) warnings.push(record.error);
    if (!record.backfillMeasurable) unmeasurable.push(record.indexName);
  }

  const notes = [
    `ポーリングは ${wait.pollIntervalSeconds} 秒間隔、上限 ${wait.timeoutMinutes} 分です（要件 5.14）。`,
    '1 回のポーリングで DescribeTable を 1 度だけ呼び、2 本の状態を同一スナップショットから読んでいます。',
    'ACTIVE 到達時刻とバックフィル完了までの経過秒はインデックスごとに記録しています。',
  ];

  if (unmeasurable.length > 0) {
    // フィールド不在は測定の失敗ではなく「測定できない事実」である。警告としても出して見落としを防ぐ
    const detail = `${unmeasurable.join(' / ')}: ${BACKFILL_UNMEASURABLE_REASON}`;
    notes.push(detail);
    warnings.push(detail);
  }

  return {
    schemaVersion: MEASUREMENT_SCHEMA_VERSION,
    mode: 'wait-index',
    generatedAt: clock.now().toISOString(),
    region: options.region ?? null,
    readOnly: true,
    warnings,
    notes,
    wait,
  };
}

// ============================================================
// モード: --storage（要件 14.2〜14.6）
// ============================================================

/**
 * ストレージ測定を行う（要件 14.2〜14.6）。
 *
 * `label` を指定した実行では `DescribeTable` を 1 回呼んでスナップショットを台帳へ**追記**する。
 * 指定しない実行では新規取得を行わず、台帳の内容だけで収束判定と寄与の算出を行う
 * （6 時間おきの再取得の合間に、現在の判定状態だけを確認したい場合のため）。
 */
export async function runStorage(options: {
  dynamo: Pick<DynamoDbMeasurementSource, 'describeTable'>;
  store: MeasurementStore;
  clock?: MeasurementClock;
  region?: string | null;
  tableName?: string;
  label?: StorageLabel | null;
  recordCount?: number;
  write?: boolean;
}): Promise<StorageReport> {
  const clock = options.clock ?? createSystemClock();
  const tableName = options.tableName ?? DEFAULT_VECTOR_TABLE_NAME;
  const recordCount = options.recordCount ?? VECTOR_RECORD_COUNT;
  const generatedAt = clock.now().toISOString();
  const warnings: string[] = [];
  const notes: string[] = [];

  const existingText = await options.store.read(STORAGE_SNAPSHOT_STORE_FILE);
  let ledger = existingText === null ? emptySnapshotStore() : parseSnapshotStore(existingText);

  let capturedSnapshots: readonly StorageSnapshot[] = [];
  let ledgerPath: string | null = null;

  if (options.label !== null && options.label !== undefined) {
    const table = await options.dynamo.describeTable(tableName);
    if (table === null) {
      throw new MeasurementError(
        `テーブル ${tableName} が見つかりません。Stage A のデプロイが完了しているか確認してください。`
      );
    }

    capturedSnapshots = buildStorageSnapshots({
      label: options.label,
      table,
      capturedAt: generatedAt,
    });
    ledger = appendSnapshots(ledger, capturedSnapshots);

    if (options.write !== false) {
      await options.store.write(STORAGE_SNAPSHOT_STORE_FILE, `${JSON.stringify(ledger, null, 2)}\n`);
      ledgerPath = `${MEASUREMENT_DIR}/${STORAGE_SNAPSHOT_STORE_FILE}`;
    } else {
      notes.push('--no-write が指定されたため、台帳へ追記していません（判定は今回の取得値を含めて行いました）。');
    }

    if (options.label === 'INDEX' && table.vectorIndexes.length === 0) {
      warnings.push(
        `--label INDEX で取得しましたが ${tableName} に VectorIndexDescription がありません。` +
          'インデックス作成前か、応答にフィールドが含まれていない可能性があります。'
      );
    }
  } else {
    notes.push('--label の指定がないため新規取得を行わず、台帳の記録のみで判定しました。');
  }

  const tableSizeConvergence = listSnapshotGroups(ledger, 'TableSizeBytes').map((group) =>
    evaluateSnapshotConvergence(selectSnapshots(ledger, group))
  );
  const indexSizeConvergence = listSnapshotTargets(ledger, 'IndexSizeBytes').map((target) =>
    evaluateSnapshotConvergence(selectSnapshotsByTarget(ledger, 'IndexSizeBytes', target))
  );

  for (let i = 0; i < tableSizeConvergence.length; i += 1) {
    const convergence = tableSizeConvergence[i];
    if (!convergence.determinate) {
      warnings.push(
        `TableSizeBytes / ${convergence.label} / ${convergence.target} は未確定です（${convergence.status}）。` +
          convergence.notes.join(' ')
      );
    }
  }
  for (let i = 0; i < indexSizeConvergence.length; i += 1) {
    const convergence = indexSizeConvergence[i];
    if (!convergence.determinate) {
      warnings.push(
        `IndexSizeBytes / ${convergence.target} は未確定です（${convergence.status}）。` +
          convergence.notes.join(' ')
      );
    }
  }

  const s1 = tableSizeConvergence.filter(
    (convergence) => convergence.label === 'S1' && convergence.target === tableName
  )[0];
  const s2 = tableSizeConvergence.filter(
    (convergence) => convergence.label === 'S2' && convergence.target === tableName
  )[0];
  const s1Value = s1 === undefined ? null : resolveSnapshotValue(s1);
  const s2Value = s2 === undefined ? null : resolveSnapshotValue(s2);

  let contribution: StorageContribution | null = null;
  let contributionDeterminate = false;
  if (s1Value !== null && s2Value !== null) {
    contribution = computeStorageContribution(s1Value, s2Value, recordCount);
    contributionDeterminate = (s1?.determinate ?? false) && (s2?.determinate ?? false);
    if (contribution.vectorAttributeContributionBytes < 0) {
      warnings.push(
        `ベクトル属性の寄与が負の値（${formatInteger(contribution.vectorAttributeContributionBytes)} B）です。` +
          'S1 / S2 のラベルが取り違えられていないか、S1 の取得が埋め込み属性の書き込み開始前であったかを確認してください。'
      );
    }
  } else {
    warnings.push(
      `ベクトル属性の寄与を算出できません（S1: ${s1Value === null ? '未取得' : '取得済'} / ` +
        `S2: ${s2Value === null ? '未取得' : '取得済'}）。` +
        'npm run vector:measure -- --storage --label S1 / --label S2 の順に取得してください（要件 14.2）。'
    );
  }

  const indexMeasurements: VectorIndexSizeMeasurement[] = [];
  let indexTotalsDeterminate = indexSizeConvergence.length > 0;
  for (let i = 0; i < indexSizeConvergence.length; i += 1) {
    const convergence = indexSizeConvergence[i];
    const resolved = resolveSnapshotValue(convergence);
    if (resolved === null) continue;
    if (!convergence.determinate) indexTotalsDeterminate = false;
    if (resolved.itemCount === null) {
      warnings.push(
        `インデックス ${convergence.target} の ItemCount が応答に含まれていません。合計件数から除外しています。`
      );
    }
    indexMeasurements.push({
      indexName: convergence.target,
      indexSizeBytes: resolved.value,
      itemCount: resolved.itemCount ?? 0,
      capturedAt: resolved.capturedAt,
    });
  }

  const indexTotals = indexMeasurements.length === 0 ? null : computeIndexSizeTotals(indexMeasurements);
  if (indexTotals === null) {
    indexTotalsDeterminate = false;
    notes.push(
      'IndexSizeBytes の記録がありません。2 本のインデックスがバックフィル完了した後に ' +
        '--storage --label INDEX を実行してください（要件 14.3）。'
    );
  } else if (indexTotals.indexes.length !== VECTOR_LANGUAGES.length) {
    warnings.push(
      `IndexSizeBytes を取得できたインデックスが ${indexTotals.indexes.length} 本です（期待 ${VECTOR_LANGUAGES.length} 本）。`
    );
  }

  notes.push(GSI_ADJUSTMENT_NOTE);
  notes.push(INDEX_SIZE_DIRECT_NOTE);
  notes.push(
    `TableSizeBytes と IndexSizeBytes は約 ${SNAPSHOT_MIN_INTERVAL_HOURS} 時間周期で更新されます。` +
      `採用値は ${SNAPSHOT_MIN_INTERVAL_HOURS} 時間以上あけた連続 2 回の取得値の差が ` +
      `${formatPercent(SNAPSHOT_CONVERGENCE_TOLERANCE)} 以内であることを確認したものだけです（要件 14.4）。`
  );

  return {
    schemaVersion: MEASUREMENT_SCHEMA_VERSION,
    mode: 'storage',
    generatedAt,
    region: options.region ?? null,
    readOnly: true,
    warnings,
    notes,
    tableName,
    recordCount,
    capturedSnapshots,
    ledgerSnapshotCount: ledger.snapshots.length,
    ledgerPath,
    tableSizeConvergence,
    indexSizeConvergence,
    contribution,
    contributionDeterminate,
    indexTotals,
    indexTotalsDeterminate,
    gsiNote: GSI_ADJUSTMENT_NOTE,
    indexSizeNote: INDEX_SIZE_DIRECT_NOTE,
  };
}

// ============================================================
// モード: --capacity（要件 14.7 / 14.8）
// ============================================================

/**
 * 同一条件で 100 回検索し、消費キャパシティと転送量を測定する（要件 14.7 / 14.8）。
 *
 * 検索は逐次実行する。並列化するとスロットリングで失敗が混ざり、1 検索あたりの
 * 消費キャパシティの分布が測定条件と対応しなくなる。100 回は同一のクエリベクトル・
 * 同一 TopK・同一言語であり、クエリ件数は 1 件である（要件 14.7 の「同一条件」）。
 */
export async function runCapacity(options: {
  probe: SearchVectorsProbe;
  metrics?: MetricSource;
  clock?: MeasurementClock;
  region?: string | null;
  tableName?: string;
  language?: VectorLanguage;
  topK?: number;
  searchCount?: number;
  dimensions?: number;
  vectorSeed?: number;
}): Promise<CapacityReport> {
  const clock = options.clock ?? createSystemClock();
  const tableName = options.tableName ?? DEFAULT_VECTOR_TABLE_NAME;
  const language = options.language ?? 'ja';
  const topK = options.topK ?? 30;
  const searchCount = options.searchCount ?? CONSUMED_CAPACITY_SEARCH_COUNT;
  const dimensions = options.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
  const vectorSeed = options.vectorSeed ?? DEFAULT_VECTOR_SEED;
  const indexName = resolveIndexName(language);
  const warnings: string[] = [];
  const notes: string[] = [];

  if (!isValidTopK(topK)) {
    throw new MeasurementError(`--topk は 1 以上 100 以下の整数です（指定値: ${String(topK)}）。`);
  }
  const validatedDimensions = validateDimensions(dimensions, 'dynamodb');
  if (!validatedDimensions.ok) {
    throw new MeasurementError(validatedDimensions.message);
  }

  const searchVector = buildDeterministicQueryVector(validatedDimensions.dimensions, vectorSeed);
  const measurementStartedAt = clock.now().toISOString();
  const samples: SearchProbeSample[] = [];

  for (let attempt = 1; attempt <= searchCount; attempt += 1) {
    const result = await options.probe.search({ tableName, indexName, searchVector, topK });
    samples.push({
      attempt,
      succeeded: result.succeeded,
      vectorSearchRequestBytes: result.vectorSearchRequestBytes,
      vectorSearchUnits: result.vectorSearchUnits,
      latencyMs: result.latencyMs,
      errorType: result.errorType,
      errorMessage: result.errorMessage,
    });
  }

  const measurementEndedAt = clock.now().toISOString();
  const consumedCapacity = summarizeConsumedCapacity({
    samples,
    language,
    indexName,
    topK,
    queryCount: 1,
    measurementStartedAt,
    measurementEndedAt,
  });

  if (consumedCapacity.failureCount > 0) {
    const firstFailure = samples.filter((sample) => !sample.succeeded)[0];
    warnings.push(
      `${consumedCapacity.failureCount} / ${searchCount} 回の検索が失敗しました` +
        `（最初の失敗: ${firstFailure?.errorType ?? '不明'} / ${firstFailure?.errorMessage ?? ''}）。` +
        '平均・最小・最大・合計は成功した検索のみから算出しています。'
    );
  }
  if (consumedCapacity.missingCapacityCount > 0) {
    warnings.push(
      `${consumedCapacity.missingCapacityCount} 件の応答から ConsumedCapacity を読み取れませんでした。` +
        '0 とみなさず集計から除外しています（0 とみなすと平均が過小になります）。'
    );
  }
  if (consumedCapacity.measuredCount === 0) {
    warnings.push('消費キャパシティを 1 件も読み取れませんでした。要件 14.7 の測定は未達です。');
  }
  if (consumedCapacity.unitsAlwaysEqualRequestBytes === null) {
    notes.push(
      'VectorSearchUnits と VectorSearchRequestBytes の両方を読み取れた検索が 0 件でした。' +
        '両者が一致するか否かは本実行では観測できていません（0 件比較から一致を主張しません）。'
    );
  } else if (consumedCapacity.unitsAlwaysEqualRequestBytes) {
    notes.push(
      `VectorSearchUnits は ${consumedCapacity.unitsEqualRequestBytesCount} 件すべてで ` +
        'VectorSearchRequestBytes と同値でした（要件 8.11 の観測）。'
    );
  } else {
    warnings.push(
      `VectorSearchUnits が VectorSearchRequestBytes と食い違った検索が ` +
        `${consumedCapacity.unitsDivergentCount} 件ありました（一致 ${consumedCapacity.unitsEqualRequestBytesCount} 件）。` +
        '2 項目を同一の量とみなせません（要件 8.11）。'
    );
  }

  const window = alignWindowToPeriod(measurementStartedAt, measurementEndedAt);
  const requestBytes: RequestBytesSummary[] = [];
  let requestBytesAvailable = false;

  if (options.metrics === undefined) {
    notes.push(
      `VectorSearchRequestBytes の取得を省きました（CloudWatch の経路が渡されていません）。` +
        `取得には ${CLOUDWATCH_SDK_PACKAGE} が必要です。`
    );
  } else {
    const indexNames = VECTOR_LANGUAGES.map((entry) => resolveIndexName(entry));
    for (let i = 0; i < indexNames.length; i += 1) {
      try {
        const points = await options.metrics.getSeries({
          namespace: DYNAMODB_METRIC_NAMESPACE,
          metricName: VECTOR_SEARCH_REQUEST_BYTES_METRIC,
          dimensions: requestBytesDimensions(tableName, indexNames[i]),
          startTime: window.startTime,
          endTime: window.endTime,
          periodSeconds: OCU_SAMPLE_PERIOD_SECONDS,
          statistic: 'Sum',
        });
        requestBytes.push(
          summarizeRequestBytes({
            tableName,
            indexName: indexNames[i],
            points,
            windowStart: window.startTime,
            windowEnd: window.endTime,
            searchCount: indexNames[i] === indexName ? samples.length : 0,
          })
        );
        requestBytesAvailable = true;
      } catch (error) {
        warnings.push(
          `${VECTOR_SEARCH_REQUEST_BYTES_METRIC}（${indexNames[i]}）の取得に失敗しました: ${describeError(error)}`
        );
      }
    }

    const empty = requestBytes.filter((summary) => summary.dataPointCount === 0);
    if (empty.length > 0) {
      notes.push(
        `${empty.map((summary) => summary.indexName).join(' / ')} はデータ点が 0 件でした。` +
          'CloudWatch へのメトリクス公開には数分の遅延があるため、しばらく待って再取得してください。' +
          `検索を実行しなかったインデックス（今回は ${indexName} 以外）は 0 件が正しい結果です。`
      );
    }
  }

  notes.push(
    `${searchCount} 回の検索はすべて同一条件（クエリ件数 1 / TopK ${topK} / 言語 ${language} / ` +
      `インデックス ${indexName} / シード ${vectorSeed}）です。` +
      `要件 14.7 が求める回数は ${CONSUMED_CAPACITY_SEARCH_COUNT} 回です` +
      `（${searchCount === CONSUMED_CAPACITY_SEARCH_COUNT ? '一致' : '--count で変更されているため測定値として採用できません'}）。`
  );
  notes.push(
    'クエリベクトルは固定シードから決定論的に生成しています（Bedrock を呼ばないため埋め込み生成の課金が発生しません）。'
  );

  return {
    schemaVersion: MEASUREMENT_SCHEMA_VERSION,
    mode: 'capacity',
    generatedAt: measurementEndedAt,
    region: options.region ?? null,
    readOnly: true,
    warnings,
    notes,
    tableName,
    dimensions: validatedDimensions.dimensions,
    vectorSeed,
    consumedCapacity,
    samples,
    latency: summarizeSeries(
      samples.filter((sample) => sample.succeeded).map((sample) => sample.latencyMs),
      measurementStartedAt,
      measurementEndedAt
    ),
    requestBytes,
    requestBytesAvailable,
  };
}

// ============================================================
// モード: --ocu / --watch-spend（要件 7.3 / 7.4 / 7.6 / 7.7 / 7.8 / 14.9）
// ============================================================

/**
 * OCU の 5 分系列を取得して突き合わせる。
 *
 * 絞り込みは **Collection Group 名**を検索語とする `SEARCH()` 式で行う
 * （{@link aossOcuSearchExpression}）。Collection 名では OCU メトリクスが公開されないため
 * データ点が常に 0 件になる。また `GetMetricStatistics` で `CollectionGroupName` の 1 次元だけを
 * 指定する照会も、次元集合の完全一致要求により常に 0 件になる。
 *
 * 返す {@link OcuSeriesResolution} には式・系列数・データ点数が入る。呼び出し側はこれを
 * レポートへ載せ、`measured: false` を「0 OCU」と読み違えない文言で報告する責任がある。
 */
async function fetchOcuSamples(
  metrics: MetricSource,
  collectionGroupName: string,
  window: { startTime: string; endTime: string },
  periodSeconds: number
): Promise<{
  samples: readonly OcuSample[];
  alignment: { pairedCount: number; searchOnlyCount: number; indexingOnlyCount: number };
  resolutions: readonly OcuSeriesResolution[];
}> {
  const [search, indexing] = await Promise.all([
    fetchOcuSeries(metrics, {
      collectionGroupName,
      metricName: SEARCH_OCU_METRIC,
      statistic: 'Average',
      window,
      periodSeconds,
    }),
    fetchOcuSeries(metrics, {
      collectionGroupName,
      metricName: INDEXING_OCU_METRIC,
      statistic: 'Average',
      window,
      periodSeconds,
    }),
  ]);

  const aligned = alignOcuSamples(search.points, indexing.points);
  return {
    samples: aligned.samples,
    alignment: {
      pairedCount: aligned.pairedCount,
      searchOnlyCount: aligned.searchOnlyCount,
      indexingOnlyCount: aligned.indexingOnlyCount,
    },
    resolutions: [search.resolution, indexing.resolution],
  };
}

/**
 * `OCUUtilization` の最小・平均・最大を取得する（要件 7.8）。
 *
 * 他の OCU メトリクスと同じ `SEARCH()` 式で照会する（{@link aossOcuSearchExpression}）。
 * データ点が 1 件も返らなかった場合は {@link UtilizationSummary.dataPointsPresent} を `false` に
 * して「測定値が存在しない」ことを「0 と測定した」から区別できる形で残す。次元不足による
 * 空振りとは式そのものが区別できるため、0 件は「このメトリクスが公開されていない」を意味する。
 */
async function fetchUtilization(
  metrics: MetricSource,
  collectionGroupName: string,
  window: { startTime: string; endTime: string },
  periodSeconds: number
): Promise<UtilizationSummary> {
  const statistics: readonly MetricSeriesQuery['statistic'][] = ['Minimum', 'Average', 'Maximum'];
  const fetched = await Promise.all(
    statistics.map((statistic) =>
      fetchOcuSeries(metrics, {
        collectionGroupName,
        metricName: OCU_UTILIZATION_METRIC,
        statistic,
        window,
        periodSeconds,
      })
    )
  );

  const summarize = (points: readonly MetricDataPoint[]): SeriesSummary =>
    summarizeSeries(
      points.map((point) => point.value),
      window.startTime,
      window.endTime
    );

  const minimum = summarize(fetched[0].points);
  const average = summarize(fetched[1].points);
  const maximum = summarize(fetched[2].points);
  const dataPointsPresent = minimum.count > 0 || average.count > 0 || maximum.count > 0;
  const filterDimension = aossOcuFilterDimension(collectionGroupName);

  return {
    minimum,
    average,
    maximum,
    dimension: filterDimension,
    resolutions: fetched.map((entry) => entry.resolution),
    dataPointsPresent,
    unavailableReason: dataPointsPresent
      ? null
      : `${filterDimension.name}=${filterDimension.value} で ${OCU_UTILIZATION_METRIC} の` +
        `データ点が 1 件も返りませんでした（${window.startTime} 〜 ${window.endTime} / ` +
        `式 ${fetched[1].resolution.expression} / 該当系列 ${fetched[1].resolution.seriesCount} 本）。` +
        'これは「使用率 0 を測定した」ことではなく「測定値が存在しない」ことを意味します。' +
        OCU_UTILIZATION_AVAILABILITY_NOTE,
  };
}

/**
 * OCU 使用量を測定する（要件 7.3 / 7.4 / 7.6 / 7.8 / 14.9）。
 *
 * `SearchOCU` / `IndexingOCU` は `Average` 統計の 5 分系列を 1 本ずつ取得し、その系列から
 * 最小・平均・最大と OCU-hour の積算の両方を導く。統計種別ごとに別系列を取ると
 * 「最小値」と「積算」が別のデータに基づく値になり、区間分解との整合が取れなくなる。
 * `OCUUtilization` は積算を伴わないため、`Minimum` / `Average` / `Maximum` の 3 系列を取る。
 *
 * 3 メトリクスとも `GetMetricData` + `SEARCH()` で引き、絞り込みは **Collection Group 名**
 * （`--collection-group`）を検索語として行う。本モードは Collection 名を一切参照しない。
 * `GetMetricStatistics` を使わない理由は {@link aossOcuSearchExpression} に記録している。
 */
export async function runOcu(options: {
  metrics: MetricSource;
  clock?: MeasurementClock;
  region?: string | null;
  collectionGroupName?: string;
  hours?: number;
  periodSeconds?: number;
  endTime?: string;
}): Promise<OcuReport> {
  const clock = options.clock ?? createSystemClock();
  const collectionGroupName =
    options.collectionGroupName ?? DEFAULT_VECTOR_COLLECTION_GROUP_NAME;
  const ocuDimension = aossOcuFilterDimension(collectionGroupName);
  const hours = options.hours ?? DEFAULT_OCU_WINDOW_HOURS;
  const periodSeconds = options.periodSeconds ?? OCU_SAMPLE_PERIOD_SECONDS;
  const generatedAt = clock.now().toISOString();
  const endTime = options.endTime ?? generatedAt;
  const window = alignWindowToPeriod(
    toIsoString(toEpochMs(endTime) - hours * 3_600_000),
    endTime,
    periodSeconds
  );

  const warnings: string[] = [];
  const notes: string[] = [];

  const { samples, alignment, resolutions } = await fetchOcuSamples(
    options.metrics,
    collectionGroupName,
    window,
    periodSeconds
  );
  const utilization = await fetchUtilization(
    options.metrics,
    collectionGroupName,
    window,
    periodSeconds
  );
  const analysis = analyzeOcuUsage(samples, { periodSeconds });
  const ocuQuery = buildOcuQueryDescriptor(
    collectionGroupName,
    resolutions.concat(utilization.resolutions)
  );

  notes.push(
    `照会した次元キー集合: ${ocuQuery.dimensionKeys.join(' / ')}` +
      `（${AOSS_METRIC_NAMESPACE} / ${SEARCH_OCU_METRIC} / ${INDEXING_OCU_METRIC} / ${OCU_UTILIZATION_METRIC}）。` +
      `絞り込みは ${ocuDimension.name}=${ocuDimension.value} を検索語とする SEARCH() 式で行いました。` +
      'OCU は Collection ではなく Collection Group で公開されるため、本モードは Collection 名を参照しません。' +
      '検索語の値は --collection-group で指定します。' +
      `GetMetricStatistics へ ${AOSS_OCU_DIMENSION_NAME} の 1 次元だけを渡すと、次元集合の完全一致要求により` +
      '常にデータ点 0 件が返ります（本スクリプトはこの経路を使いません）。'
  );
  for (let i = 0; i < ocuQuery.resolutions.length; i += 1) {
    const resolution = ocuQuery.resolutions[i];
    notes.push(
      `${resolution.metricName}（${resolution.statistic}）: 式 ${resolution.expression} / ` +
        `該当系列 ${resolution.seriesCount} 本（データを持つ系列 ${resolution.seriesWithDataCount} 本）/ ` +
        `データ点 ${resolution.dataPointCount} 件` +
        (resolution.series.length === 0
          ? ''
          : ` / 系列: ${resolution.series
              .map((entry) => `${entry.label}（${entry.dataPointCount} 点 / ${entry.statusCode ?? '(状態不明)'}）`)
              .join(' , ')}`)
    );
    if (resolution.anomaly !== null && resolution.seriesWithDataCount > 1) {
      warnings.push(resolution.anomaly);
    }
  }

  const expectedSampleCount = Math.round((hours * 3600) / periodSeconds);
  if (analysis.sampleCount === 0) {
    warnings.push(
      `${AOSS_METRIC_NAMESPACE} の ${SEARCH_OCU_METRIC} / ${INDEXING_OCU_METRIC} のデータ点が 0 件です` +
        `（絞り込み: ${ocuDimension.name}=${ocuDimension.value} / ` +
        `次元キー集合: ${ocuQuery.dimensionKeys.join(' / ')} / ` +
        `該当系列: ${resolutions.map((entry) => `${entry.metricName} ${entry.seriesCount} 本`).join(' / ')} / ` +
        `リージョン: ${options.region ?? '(未解決)'} / 区間: ${window.startTime} 〜 ${window.endTime}）。` +
        '**データ点が存在しないことは OCU 消費が 0 であったことの証拠になりません。** ' +
        'CloudWatch は Collection Group が存在しない期間も、メトリクスが未公開の期間も値を返さないため、' +
        '「0 OCU を測定した」と「測定値が存在しない」を本モードでは区別できません。' +
        '0 課金を確定させるには請求データ（Cost Explorer / Billing の AOSS 利用種別）を用いてください' +
        '（task 13.4 の Q4）。上記の次元名と値が実在の Collection Group と一致しているかは ' +
        'npm run vector:measure -- --teardown-check の ListCollectionGroups で確認できます。'
    );
  } else if (analysis.sampleCount < expectedSampleCount) {
    notes.push(
      `データ点が ${analysis.sampleCount} 件で、${hours} 時間分の期待件数 ${expectedSampleCount} 件に満たしません。` +
        '欠測は区間の連続性を切る扱いにしています（欠測を 0 とみなして 0 OCU 区間を伸ばしません）。'
    );
  }

  if (!analysis.scaleToZeroApplicable) {
    warnings.push(
      `SearchOCU と IndexingOCU がともに 0 の連続区間の最大長が ` +
        `${formatNumber(analysis.longestZeroOcuMinutes, 1)} 分で、` +
        `${SCALE_TO_ZERO_MIN_ZERO_MINUTES} 分に達しません。scale-to-zero 非適用と判定します（要件 7.4）。` +
        (analysis.alwaysOnMonthlyUsd === null
          ? ''
          : `常時課金の月額見積は ${formatUsd(analysis.alwaysOnMonthlyUsd)} USD ` +
            `（平均 ${formatNumber(analysis.combinedOcu.average ?? Number.NaN, 4)} OCU × ` +
            `${OCU_HOURLY_USD} USD × 730 h）です。Vector_Collection と Vector_Collection_Group の ` +
            '削除手順と削除完了の確認方法を Verification_Report に記載してください。')
    );
  } else {
    notes.push(
      `scale-to-zero 適用可（0 OCU 区間の最大長 ${formatNumber(analysis.longestZeroOcuMinutes, 1)} 分、` +
        `${SCALE_TO_ZERO_MIN_ZERO_MINUTES} 分以上）。0 OCU 区間の合計は ` +
        `${formatNumber(analysis.totalZeroOcuMinutes, 1)} 分、アイドル時月額見積は 0 USD です（要件 7.6）。`
    );
  }

  const partitionTotal = sumIntervalOcuHours(analysis.activityPartition);
  const partitionConserved =
    Math.abs(partitionTotal - analysis.totalOcuHours) <=
    OCU_HOUR_COMPARISON_EPSILON * Math.max(1, Math.abs(analysis.totalOcuHours));
  if (!partitionConserved) {
    warnings.push(
      `区間分解の消費 OCU-hour 合計（${formatNumber(partitionTotal, 6)}）が全体の累積` +
        `（${formatNumber(analysis.totalOcuHours, 6)}）と一致しません。区間の検出に欠落または重複があります。`
    );
  }

  notes.push(
    `検索継続区間は連続 ${SEARCH_ACTIVE_MIN_MINUTES} 分以上、アイドル区間は連続 ` +
      `${IDLE_MIN_MINUTES / 60} 時間以上のものを出力しています（要件 14.9）。` +
      'アイドル区間は「検索を一切実行しない区間」であり、IndexingOCU は問いません。' +
      'したがってアイドル区間の消費 OCU-hour は 0 とは限らず、その値自体が測定対象です。'
  );
  notes.push(
    'ベクトルコレクションの OCU 使用量は主にインメモリベクトルに起因するため、' +
      'SEARCH タイプコレクションと同等のアイドルコストになるとは限りません（要件 7.9 のリスク）。'
  );
  notes.push(NON_OCU_BILLING_NOTE);

  if (utilization.unavailableReason === null) {
    notes.push(
      `${OCU_UTILIZATION_METRIC} のデータ点を取得できました` +
        `（Minimum ${utilization.minimum.count} 件 / Average ${utilization.average.count} 件 / ` +
        `Maximum ${utilization.maximum.count} 件）。要件 7.8 の右サイジング指標として使えます。`
    );
  } else {
    warnings.push(utilization.unavailableReason);
  }

  return {
    schemaVersion: MEASUREMENT_SCHEMA_VERSION,
    mode: 'ocu',
    generatedAt,
    region: options.region ?? null,
    readOnly: true,
    warnings,
    notes,
    collectionGroupName,
    ocuDimension,
    ocuQuery,
    windowStart: window.startTime,
    windowEnd: window.endTime,
    windowHours: hours,
    periodSeconds,
    alignment,
    analysis,
    utilization,
    partitionConserved,
  };
}

/**
 * 累積 OCU 課金を監視する（要件 7.7）。
 *
 * 20 USD を初めて超えた時点で積算を打ち切り、そこまでの測定値を保持したうえで
 * Vector_Collection と Vector_Collection_Group の削除実行を要求する警告を出す。
 * **削除は行わない。** 実行するのは検証担当者である。
 *
 * OCU 系列の絞り込みは **Collection Group 名**（`--collection-group`）を検索語とする
 * `SEARCH()` 式で行う。Collection 名（`--collection`）は削除要求文の対象を示すためにのみ使い、
 * メトリクスの照会には使わない。
 *
 * **データ点が 0 件の場合は「累積 0 USD」とみなさない。**閾値ガードとしては安全側
 * （未知）に倒し、警告として出力する。次元不足で黙って空を返す経路は使わない
 * （{@link aossOcuSearchExpression}）。
 */
export async function runWatchSpend(options: {
  metrics: MetricSource;
  clock?: MeasurementClock;
  region?: string | null;
  collectionName?: string;
  collectionGroupName?: string;
  hours?: number;
  periodSeconds?: number;
  thresholdUsd?: number;
  hourlyUsd?: number;
  endTime?: string;
}): Promise<WatchSpendReport> {
  const clock = options.clock ?? createSystemClock();
  const collectionName = options.collectionName ?? DEFAULT_VECTOR_COLLECTION_NAME;
  const collectionGroupName = options.collectionGroupName ?? DEFAULT_VECTOR_COLLECTION_GROUP_NAME;
  const ocuDimension = aossOcuFilterDimension(collectionGroupName);
  const hours = options.hours ?? DEFAULT_OCU_WINDOW_HOURS;
  const periodSeconds = options.periodSeconds ?? OCU_SAMPLE_PERIOD_SECONDS;
  const thresholdUsd = options.thresholdUsd ?? SPEND_THRESHOLD_USD;
  const hourlyUsd = options.hourlyUsd ?? OCU_HOURLY_USD;
  const generatedAt = clock.now().toISOString();
  const endTime = options.endTime ?? generatedAt;
  const window = alignWindowToPeriod(
    toIsoString(toEpochMs(endTime) - hours * 3_600_000),
    endTime,
    periodSeconds
  );

  const warnings: string[] = [];
  const notes: string[] = [];

  const { samples, resolutions } = await fetchOcuSamples(
    options.metrics,
    collectionGroupName,
    window,
    periodSeconds
  );
  const ocuQuery = buildOcuQueryDescriptor(collectionGroupName, resolutions);
  const spend = accumulateSpend(samples, {
    periodSeconds,
    hourlyUsd,
    thresholdUsd,
    collectionName,
    collectionGroupName,
  });

  // 区間分解は積算に採用した範囲（= 保持した測定値）に対して行う。
  // 打ち切り後のサンプルを混ぜると、区間長と消費 OCU-hour が「測定を終了した」範囲と食い違う
  const retained = sortOcuSamples(samples).slice(0, spend.retainedSampleCount);
  const analysis = analyzeOcuUsage(retained, { periodSeconds });

  if (spend.warning !== null) {
    warnings.push(spend.warning.message);
    for (let i = 0; i < spend.warning.requiredActions.length; i += 1) {
      warnings.push(spend.warning.requiredActions[i]);
    }
  } else {
    notes.push(
      `累積 ${formatNumber(spend.totalOcuHours, 4)} OCU-hour × ${hourlyUsd} USD = ` +
        `${formatUsd(spend.totalUsd)} USD で、上限 ${thresholdUsd} USD を超えていません。` +
        `残り ${formatUsd(Math.max(0, thresholdUsd - spend.totalUsd))} USD です。`
    );
  }

  notes.push(
    `照会した次元キー集合: ${ocuQuery.dimensionKeys.join(' / ')}` +
      `（${AOSS_METRIC_NAMESPACE} / ${SEARCH_OCU_METRIC} / ${INDEXING_OCU_METRIC}）。` +
      `絞り込みは ${ocuDimension.name}=${ocuDimension.value} を検索語とする SEARCH() 式で行いました。` +
      `--collection（${collectionName}）は削除要求文の対象を示すためにのみ使い、` +
      'メトリクスの照会には使いません。'
  );
  for (let i = 0; i < ocuQuery.resolutions.length; i += 1) {
    const resolution = ocuQuery.resolutions[i];
    notes.push(
      `${resolution.metricName}（${resolution.statistic}）: 式 ${resolution.expression} / ` +
        `該当系列 ${resolution.seriesCount} 本（データを持つ系列 ${resolution.seriesWithDataCount} 本）/ ` +
        `データ点 ${resolution.dataPointCount} 件`
    );
    if (resolution.anomaly !== null && resolution.seriesWithDataCount > 1) {
      warnings.push(resolution.anomaly);
    }
  }
  notes.push(NON_OCU_BILLING_NOTE);

  if (spend.retainedSampleCount === 0) {
    warnings.push(
      `${SEARCH_OCU_METRIC} / ${INDEXING_OCU_METRIC} のデータ点が 0 件のため、累積課金を評価できていません` +
        `（絞り込み: ${ocuDimension.name}=${ocuDimension.value} / ` +
        `次元キー集合: ${ocuQuery.dimensionKeys.join(' / ')} / ` +
        `該当系列: ${resolutions.map((entry) => `${entry.metricName} ${entry.seriesCount} 本`).join(' / ')} / ` +
        `リージョン: ${options.region ?? '(未解決)'} / 区間: ${window.startTime} 〜 ${window.endTime}）。` +
        '**累積 0 USD と測定できたわけではありません。** データ点の不在は課金が 0 であることの' +
        '証拠にならず、上限 ' +
        `${thresholdUsd} USD に対する残余も未知です。0 課金の確認には請求データ` +
        '（Cost Explorer / Billing）を用いてください。'
    );
  }

  notes.push(
    '本モードは常駐しません。検証期間中に定期実行して累積を確認する運用です（設計「累積課金の監視」）。' +
      `取得区間は直近 ${hours} 時間です。検証開始からの累積を見るには --hours で区間を広げてください。`
  );
  notes.push('本スクリプトは削除を実行しません。削除は検証担当者が行い、--teardown-check で確認します。');

  return {
    schemaVersion: MEASUREMENT_SCHEMA_VERSION,
    mode: 'watch-spend',
    generatedAt,
    region: options.region ?? null,
    readOnly: true,
    warnings,
    notes,
    collectionName,
    collectionGroupName,
    ocuDimension,
    ocuQuery,
    windowStart: window.startTime,
    windowEnd: window.endTime,
    periodSeconds,
    spend,
    analysis,
  };
}

// ============================================================
// モード: --teardown-check（task 15.1）
// ============================================================

/**
 * 撤収確認チェックリストを実行する（task 15.1、要件 1.5 / 6.9 / 7.4 / 7.7 / 18.14 / 18.15）。
 *
 * **確認のみを行い、削除は一切実行しない。** 各項目は `pass` / `fail` / `unknown` の 3 値で
 * 判定する。取得できなかった項目を `pass` に混ぜないのは、確認できていないものを
 * 「削除済み」と記録すると課金対象リソースを残したまま撤収を宣言してしまうためである。
 */
export async function runTeardownCheck(options: {
  dynamo: DynamoDbMeasurementSource;
  store: MeasurementStore;
  collections?: CollectionInventorySource;
  pipelines?: PipelineStateSource;
  metrics?: MetricSource;
  clock?: MeasurementClock;
  region?: string | null;
  tableName?: string;
  queryCacheTableName?: string;
  goodTableName?: string;
  collectionName?: string;
  collectionGroupName?: string;
  pipelineName?: string;
  hours?: number;
  scanLimit?: number;
}): Promise<TeardownCheckReport> {
  const clock = options.clock ?? createSystemClock();
  const tableName = options.tableName ?? DEFAULT_VECTOR_TABLE_NAME;
  const queryCacheTableName = options.queryCacheTableName ?? DEFAULT_QUERY_CACHE_TABLE_NAME;
  const goodTableName = options.goodTableName ?? DEFAULT_GOOD_TABLE_NAME;
  const collectionName = options.collectionName ?? DEFAULT_VECTOR_COLLECTION_NAME;
  const collectionGroupName = options.collectionGroupName ?? DEFAULT_VECTOR_COLLECTION_GROUP_NAME;
  const pipelineName = options.pipelineName ?? DEFAULT_INGESTION_PIPELINE_NAME;
  const hours = options.hours ?? DEFAULT_OCU_WINDOW_HOURS;
  const generatedAt = clock.now().toISOString();

  const warnings: string[] = [];
  const notes: string[] = [];
  const checklist: ChecklistItem[] = [];

  // 1. ListTables に Vector_Table と Query_Vector_Cache が無い
  let remainingTableNames: readonly string[] = [];
  try {
    const names = await options.dynamo.listTableNames();
    remainingTableNames = names.filter(
      (name) => name === tableName || name === queryCacheTableName
    );
    checklist.push({
      id: 'tables-deleted',
      description: `ListTables に ${tableName} と ${queryCacheTableName} が無い`,
      status: remainingTableNames.length === 0 ? 'pass' : 'fail',
      detail:
        remainingTableNames.length === 0
          ? '両テーブルとも存在しません'
          : `残存: ${remainingTableNames.join(', ')}`,
    });
  } catch (error) {
    checklist.push({
      id: 'tables-deleted',
      description: `ListTables に ${tableName} と ${queryCacheTableName} が無い`,
      status: 'unknown',
      detail: describeError(error),
    });
  }

  // 2 / 3. ListCollections と ListCollectionGroups
  let remainingCollectionNames: readonly string[] = [];
  let remainingCollectionGroupNames: readonly string[] = [];
  if (options.collections === undefined) {
    checklist.push({
      id: 'collection-deleted',
      description: `ListCollections に ${collectionName} が無い`,
      status: 'unknown',
      detail: `${OPENSEARCH_SERVERLESS_SDK_PACKAGE} が未導入のため確認できません`,
    });
    checklist.push({
      id: 'collection-group-deleted',
      description: `ListCollectionGroups に ${collectionGroupName} が無い`,
      status: 'unknown',
      detail: `${OPENSEARCH_SERVERLESS_SDK_PACKAGE} が未導入のため確認できません`,
    });
  } else {
    try {
      const names = await options.collections.listCollectionNames();
      remainingCollectionNames = names.filter((name) => name === collectionName);
      checklist.push({
        id: 'collection-deleted',
        description: `ListCollections に ${collectionName} が無い`,
        status: remainingCollectionNames.length === 0 ? 'pass' : 'fail',
        detail:
          remainingCollectionNames.length === 0
            ? '存在しません'
            : `残存: ${remainingCollectionNames.join(', ')}`,
      });
    } catch (error) {
      checklist.push({
        id: 'collection-deleted',
        description: `ListCollections に ${collectionName} が無い`,
        status: 'unknown',
        detail: describeError(error),
      });
    }

    try {
      const names = await options.collections.listCollectionGroupNames();
      remainingCollectionGroupNames = names.filter((name) => name === collectionGroupName);
      checklist.push({
        id: 'collection-group-deleted',
        description: `ListCollectionGroups に ${collectionGroupName} が無い`,
        status: remainingCollectionGroupNames.length === 0 ? 'pass' : 'fail',
        detail:
          remainingCollectionGroupNames.length === 0
            ? '存在しません'
            : `残存: ${remainingCollectionGroupNames.join(', ')}`,
      });
    } catch (error) {
      checklist.push({
        id: 'collection-group-deleted',
        description: `ListCollectionGroups に ${collectionGroupName} が無い`,
        status: 'unknown',
        detail: describeError(error),
      });
    }
  }

  // 4. SearchOCU / IndexingOCU が 0
  //
  // 照会は Collection 名ではなく **Collection Group 名**を検索語とする SEARCH() 式で行う
  // （{@link aossOcuSearchExpression}）。GetMetricStatistics に CollectionGroupName の 1 次元だけを
  // 渡す経路は、次元集合の完全一致要求により常に空を返すため使わない。
  // データ点が 0 件の場合を `pass` にはしない。値が返らないことは「OCU が 0 であった」ことの
  // 証拠にならず、それを削除済みの根拠として記録すると課金対象を残したまま撤収を宣言し得る
  let ocuAnalysis: OcuUsageAnalysis | null = null;
  let ocuDimension: MetricDimension | null = null;
  let ocuQuery: OcuQueryDescriptor | null = null;
  const ocuDescription =
    `${SEARCH_OCU_METRIC} / ${INDEXING_OCU_METRIC} が 0（課金対象リソースが 0 件）` +
    `（次元キー集合 ${AOSS_OCU_DIMENSION_KEYS.join(' / ')} / ` +
    `絞り込み ${AOSS_OCU_DIMENSION_NAME}=${collectionGroupName}）`;
  if (options.metrics === undefined) {
    checklist.push({
      id: 'ocu-zero',
      description: ocuDescription,
      status: 'unknown',
      detail: `${CLOUDWATCH_SDK_PACKAGE} が未導入のため確認できません`,
    });
  } else {
    try {
      const window = alignWindowToPeriod(
        toIsoString(toEpochMs(generatedAt) - hours * 3_600_000),
        generatedAt
      );
      ocuDimension = aossOcuFilterDimension(collectionGroupName);
      const { samples, resolutions } = await fetchOcuSamples(
        options.metrics,
        collectionGroupName,
        window,
        OCU_SAMPLE_PERIOD_SECONDS
      );
      ocuQuery = buildOcuQueryDescriptor(collectionGroupName, resolutions);
      ocuAnalysis = analyzeOcuUsage(samples, { periodSeconds: OCU_SAMPLE_PERIOD_SECONDS });
      const maxCombined = ocuAnalysis.combinedOcu.maximum;
      const seriesDetail = resolutions
        .map(
          (entry) =>
            `${entry.metricName} 系列 ${entry.seriesCount} 本（データあり ${entry.seriesWithDataCount} 本 / ` +
            `${entry.dataPointCount} 点）`
        )
        .join(' / ');
      checklist.push({
        id: 'ocu-zero',
        description: ocuDescription,
        // データ点なし = 未確認。0 と測定できた場合のみ pass にする
        status: maxCombined === null ? 'unknown' : maxCombined === 0 ? 'pass' : 'fail',
        detail:
          maxCombined === null
            ? `直近 ${hours} 時間のデータ点が 0 件です（絞り込み: ` +
              `${ocuDimension.name}=${ocuDimension.value} / ${seriesDetail} / ` +
              `区間: ${window.startTime} 〜 ${window.endTime}）。` +
              'データ点の不在は 0 OCU の証拠ではないため「確認できず」として扱います。' +
              '0 課金の確定には請求データ（Cost Explorer / Billing）を用いてください。'
            : `直近 ${hours} 時間の最大 ${formatNumber(maxCombined, 4)} OCU` +
              `（データ点 ${ocuAnalysis.sampleCount} 件 / 絞り込み: ` +
              `${ocuDimension.name}=${ocuDimension.value} / ${seriesDetail}）`,
      });
      for (let i = 0; i < resolutions.length; i += 1) {
        if (resolutions[i].anomaly !== null && resolutions[i].seriesWithDataCount > 1) {
          warnings.push(resolutions[i].anomaly as string);
        }
      }
    } catch (error) {
      checklist.push({
        id: 'ocu-zero',
        description: ocuDescription,
        status: 'unknown',
        detail: describeError(error),
      });
    }
  }

  // 5. Good_Table が 13.1 のスナップショットと同一
  let goodTableComparison: GoodTableComparison | null = null;
  const baselineText = await options.store.read(GOOD_TABLE_SNAPSHOT_FILE);
  if (baselineText === null) {
    checklist.push({
      id: 'good-table-intact',
      description: 'Good_Table が段階 0 のスナップショットと同一（要件 1.5）',
      status: 'unknown',
      detail:
        `${MEASUREMENT_DIR}/${GOOD_TABLE_SNAPSHOT_FILE} がありません。` +
        'npm run vector:measure -- --pre-check で取得した基準が必要です',
    });
  } else {
    const baseline = parseGoodTableSnapshot(baselineText);
    const table = await options.dynamo.describeTable(goodTableName);
    if (table === null) {
      checklist.push({
        id: 'good-table-intact',
        description: 'Good_Table が段階 0 のスナップショットと同一（要件 1.5）',
        status: 'fail',
        detail: `${goodTableName} が存在しません`,
      });
      warnings.push(
        `Good_Table ${goodTableName} が見つかりません。既存テーブルの不変性（要件 1.5）が損なわれています。`
      );
    } else {
      const pitr = await options.dynamo.describeContinuousBackups(goodTableName);
      // 基準と同一のアイテムを突き合わせるため、キー指定で取得する。Scan の返却順に依存しない
      const keys = baseline.sampleItems.map((item) => ({
        itemId: item.itemId,
        warehouseId: item.warehouseId,
      }));
      const items = await options.dynamo.getItemsByKeys(goodTableName, keys);
      const current = buildGoodTableSnapshot({
        table,
        pointInTimeRecoveryStatus: pitr,
        items,
        capturedAt: generatedAt,
        region: options.region ?? null,
        sampleItemCount: Math.max(baseline.sampleItems.length, GOOD_TABLE_SAMPLE_ITEM_COUNT),
      });
      goodTableComparison = compareGoodTableSnapshots(baseline, current);
      checklist.push({
        id: 'good-table-intact',
        description: 'Good_Table が段階 0 のスナップショットと同一（要件 1.5）',
        status: goodTableComparison.identical ? 'pass' : 'fail',
        detail: goodTableComparison.identical
          ? `${goodTableComparison.comparedItemCount} 件の抽出アイテムを含め、相違はありません`
          : `相違 ${goodTableComparison.differences.length} 件 / 取得できなかった抽出アイテム ` +
            `${goodTableComparison.missingItemKeys.length} 件`,
      });

      if (!goodTableComparison.identical) {
        warnings.push(
          `Good_Table が段階 0 のスナップショットと一致しません（相違 ${goodTableComparison.differences.length} 件）。` +
            'DescribeTable の ItemCount は約 6 時間周期で更新される概数であるため、' +
            'itemCount のみの相違であれば直ちに破壊を意味しません。相違の内容を確認してください。'
        );
      }
    }
  }

  // 6. OSIS が STOPPED のまま
  let pipelineStatus: string | null = null;
  if (options.pipelines === undefined) {
    checklist.push({
      id: 'pipeline-still-stopped',
      description: `OSIS ${pipelineName} が ${EXPECTED_PIPELINE_STATUS} のまま（要件 6.9 / 6.10）`,
      status: 'unknown',
      detail: `${OSIS_SDK_PACKAGE} が未導入のため確認できません`,
    });
  } else {
    try {
      pipelineStatus = await options.pipelines.getPipelineStatus(pipelineName);
      checklist.push({
        id: 'pipeline-still-stopped',
        description: `OSIS ${pipelineName} が ${EXPECTED_PIPELINE_STATUS} のまま（要件 6.9 / 6.10）`,
        status: pipelineStatus === EXPECTED_PIPELINE_STATUS ? 'pass' : 'fail',
        detail: `取得した状態: ${pipelineStatus ?? '(パイプラインが存在しない)'}`,
      });
    } catch (error) {
      checklist.push({
        id: 'pipeline-still-stopped',
        description: `OSIS ${pipelineName} が ${EXPECTED_PIPELINE_STATUS} のまま（要件 6.9 / 6.10）`,
        status: 'unknown',
        detail: describeError(error),
      });
    }
  }

  const failed = checklist.filter((item) => item.status === 'fail');
  const unknown = checklist.filter((item) => item.status === 'unknown');
  const teardownComplete = failed.length === 0 && unknown.length === 0;

  if (failed.length > 0) {
    warnings.push(
      `撤収未完了の項目が ${failed.length} 件あります: ` +
        `${failed.map((item) => item.id).join(', ')}。削除順序（設計「撤収手順」）に従って削除してください。`
    );
  }
  if (unknown.length > 0) {
    warnings.push(
      `確認できなかった項目が ${unknown.length} 件あります: ` +
        `${unknown.map((item) => item.id).join(', ')}。撤収完了とは記録できません。`
    );
  }

  notes.push(
    `--collection（${collectionName}）は ListCollections の存在確認に、` +
      `--collection-group（${collectionGroupName}）は ListCollectionGroups の存在確認と ` +
      `OCU メトリクスの ${AOSS_OCU_DIMENSION_NAME} 検索語に使っています。` +
      'OCU は Collection ではなく Collection Group で公開されるためです。' +
      `OCU 系列の次元キー集合は ${AOSS_OCU_DIMENSION_KEYS.join(' / ')} であり、` +
      'SEARCH() 式でこの集合を宣言して照会しています。'
  );
  notes.push('本モードは確認のみを行い、削除を一切実行していません（task 15.1）。');
  notes.push(
    '確認結果は docs/vector-search-comparison.md の撤収手順節へ追記してください（task 15.1）。'
  );

  return {
    schemaVersion: MEASUREMENT_SCHEMA_VERSION,
    mode: 'teardown-check',
    generatedAt,
    region: options.region ?? null,
    readOnly: true,
    warnings,
    notes,
    checklist,
    teardownComplete,
    remainingTableNames,
    remainingCollectionNames,
    remainingCollectionGroupNames,
    ocuDimension,
    ocuQuery,
    ocuAnalysis,
    goodTableComparison,
    pipelineStatus,
    deletionPerformed: false,
  };
}

/**
 * 保存済みの Good_Table スナップショットを読む。壊れている場合は例外にする。
 *
 * 版 1（`region` を持たない）の基準ファイルも読める。`region` の欠落は null として扱い、
 * 版の違いだけで task 13.20 / 15.1 の比較が失敗しないようにしている。
 */
export function parseGoodTableSnapshot(text: string): GoodTableSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new MeasurementError(
      `${GOOD_TABLE_SNAPSHOT_FILE} を JSON として解釈できません（${describeError(error)}）。`
    );
  }

  const record = asRecord(parsed);
  if (record === undefined || !Array.isArray(record.sampleItems)) {
    throw new MeasurementError(
      `${GOOD_TABLE_SNAPSHOT_FILE} の形が想定と異なります（sampleItems 配列が必要です）。`
    );
  }

  const sampleItems: SampleItemSnapshot[] = [];
  for (let i = 0; i < record.sampleItems.length; i += 1) {
    const entry = asRecord(record.sampleItems[i]);
    if (entry === undefined) continue;
    const attributeNames = Array.isArray(entry.attributeNames)
      ? entry.attributeNames.filter((name: unknown): name is string => typeof name === 'string')
      : [];
    sampleItems.push({
      key: typeof entry.key === 'string' ? entry.key : '',
      itemId: typeof entry.itemId === 'string' ? entry.itemId : '',
      warehouseId: typeof entry.warehouseId === 'string' ? entry.warehouseId : '',
      attributeNames,
      itemSizeBytes: firstFiniteNumber([entry.itemSizeBytes]) ?? 0,
    });
  }

  const gsis: GsiSnapshot[] = [];
  if (Array.isArray(record.globalSecondaryIndexes)) {
    for (let i = 0; i < record.globalSecondaryIndexes.length; i += 1) {
      const entry = asRecord(record.globalSecondaryIndexes[i]);
      if (entry === undefined) continue;
      gsis.push({
        indexName: typeof entry.indexName === 'string' ? entry.indexName : '',
        keySchema: Array.isArray(entry.keySchema)
          ? entry.keySchema.filter((name: unknown): name is string => typeof name === 'string')
          : [],
        projectionType: typeof entry.projectionType === 'string' ? entry.projectionType : '',
        nonKeyAttributes: Array.isArray(entry.nonKeyAttributes)
          ? entry.nonKeyAttributes.filter((name: unknown): name is string => typeof name === 'string')
          : [],
      });
    }
  }

  return {
    schemaVersion: firstFiniteNumber([record.schemaVersion]) ?? GOOD_TABLE_SNAPSHOT_SCHEMA_VERSION,
    tableName: typeof record.tableName === 'string' ? record.tableName : '',
    // 版 1 の基準ファイルは `region` を持たない。欠落は null として受け入れる（後方互換）
    region: typeof record.region === 'string' && record.region !== '' ? record.region : null,
    capturedAt: typeof record.capturedAt === 'string' ? record.capturedAt : '',
    keySchema: Array.isArray(record.keySchema)
      ? record.keySchema.filter((name: unknown): name is string => typeof name === 'string')
      : [],
    globalSecondaryIndexes: gsis,
    streamEnabled: record.streamEnabled === true,
    streamViewType: typeof record.streamViewType === 'string' ? record.streamViewType : null,
    pointInTimeRecoveryStatus:
      typeof record.pointInTimeRecoveryStatus === 'string' ? record.pointInTimeRecoveryStatus : 'UNKNOWN',
    itemCount: firstFiniteNumber([record.itemCount]) ?? 0,
    sampleItems,
  };
}

// ============================================================
// 出力の整形（純関数）
// ============================================================

/** レポートファイル名。実行時刻を含めて上書きを避ける */
export function measurementReportFileName(mode: MeasurementMode, generatedAt: string): string {
  return `measure-${mode}-${toFileNameTimestamp(generatedAt)}.json`;
}

/**
 * レポートへ注意文を 1 件足す（純関数）。
 *
 * `run*()` は注入された経路の中で完結しており、配線層でしか分からない事情
 * （実効リージョンを解決できなかった等）を自分では書けない。それを後から足すための口である。
 * 終了コードは警告の件数から決まるため、{@link resolveExitCode} より前に適用する。
 */
export function appendReportWarning(
  report: MeasurementReport,
  warning: string | null
): MeasurementReport {
  if (warning === null || warning === '') return report;
  const warnings = report.warnings.concat([warning]);

  // モードごとに絞ってから複製する。判別子（mode）を保ったまま組み立てるため
  switch (report.mode) {
    case 'pre-check':
      return { ...report, warnings };
    case 'wait-index':
      return { ...report, warnings };
    case 'storage':
      return { ...report, warnings };
    case 'capacity':
      return { ...report, warnings };
    case 'ocu':
      return { ...report, warnings };
    case 'watch-spend':
      return { ...report, warnings };
    case 'teardown-check':
      return { ...report, warnings };
  }
}

/** 警告があれば注意、無ければ正常。実行時エラーは呼び出し側で `error` にする */
export function resolveExitCode(report: MeasurementReport): number {
  return report.warnings.length > 0 ? EXIT_CODES.attention : EXIT_CODES.ok;
}

/** チェックリストを行の列へ整形する */
function formatChecklist(items: readonly ChecklistItem[]): readonly string[] {
  const symbols: Record<ChecklistStatus, string> = { pass: '[OK]', fail: '[NG]', unknown: '[??]' };
  const lines: string[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    lines.push(`  ${symbols[item.status]} ${item.description}`);
    lines.push(`        ${item.detail}`);
  }
  return lines;
}

/** 収束判定を行の列へ整形する */
function formatConvergence(convergence: SnapshotConvergence): readonly string[] {
  const resolved = resolveSnapshotValue(convergence);
  const lines: string[] = [
    `  ${convergence.field} / ${convergence.label} / ${convergence.target}`,
    `    状態: ${convergence.status}（${convergence.determinate ? '確定' : '未確定'}）` +
      ` / スナップショット ${convergence.snapshots.length} 件` +
      ` / 再取得 ${convergence.refetchAttempts} 回（上限 ${convergence.maxRefetchAttempts} 回）`,
    `    値: ${resolved === null ? '(なし)' : formatBytes(resolved.value)}` +
      `${resolved === null ? '' : ` @ ${resolved.capturedAt}`}` +
      `${convergence.determinate ? '' : '（未確定）'}`,
  ];

  for (let i = 0; i < convergence.comparisons.length; i += 1) {
    const comparison = convergence.comparisons[i];
    lines.push(
      `    比較 ${i + 1}: 間隔 ${formatNumber(comparison.hoursApart, 2)} h` +
        `（${comparison.intervalSatisfied ? '条件充足' : '不足'}）` +
        ` / 相対差 ${formatPercent(comparison.relativeDifference)}` +
        `（${comparison.withinTolerance ? '許容内' : '超過'}）` +
        ` / 採用 ${comparison.qualifies ? '可' : '不可'}`
    );
  }

  if (convergence.estimatedErrorRange !== null) {
    const range = convergence.estimatedErrorRange;
    lines.push(
      `    推定誤差幅: ±${formatInteger(range.absoluteBytes)} B` +
        `（${formatPercent(range.relative)}） / 範囲 ${formatInteger(range.lowerBytes)}〜${formatInteger(range.upperBytes)} B`
    );
  }

  for (let i = 0; i < convergence.notes.length; i += 1) {
    lines.push(`    注: ${convergence.notes[i]}`);
  }

  return lines;
}

/** 区間を 1 行へ整形する */
function formatInterval(interval: OcuInterval): string {
  return (
    `    ${interval.startTime} 〜 ${interval.endTime}` +
    ` / ${formatNumber(interval.lengthMinutes, 1)} 分` +
    ` / 消費 ${formatNumber(interval.ocuHours, 4)} OCU-hour` +
    `（検索 ${formatNumber(interval.searchOcuHours, 4)} / インデックス ${formatNumber(interval.indexingOcuHours, 4)}）`
  );
}

/**
 * OCU の照会条件と結果を行の列へ整形する。
 *
 * データ点 0 件を「0 OCU」と読み違えないため、**式・次元キー集合・系列数・データ点数を
 * 必ず出す**。系列の Label には次元値（`CollectionGroupName` / `CollectionGroupId`）が入る。
 */
function formatOcuQuery(query: OcuQueryDescriptor): readonly string[] {
  const lines: string[] = [
    `照会した次元キー集合: ${query.dimensionKeys.join(' / ')}` +
      '（CloudWatch は次元集合の完全一致を要求するため、CollectionGroupName 単独では常に空が返る）',
    `全メトリクスでデータ点を取得: ${query.allMeasured ? 'はい' : 'いいえ'}`,
    'メトリクスごとの照会:',
  ];

  for (let i = 0; i < query.resolutions.length; i += 1) {
    const resolution = query.resolutions[i];
    lines.push(`  ${resolution.metricName}（${resolution.statistic}）`);
    lines.push(`    式: ${resolution.expression}`);
    lines.push(
      `    該当系列 ${resolution.seriesCount} 本 / データを持つ系列 ${resolution.seriesWithDataCount} 本` +
        ` / データ点 ${resolution.dataPointCount} 件` +
        `（${resolution.measured ? '測定できた' : '測定できていない（0 OCU ではない）'}）`
    );
    for (let j = 0; j < resolution.series.length; j += 1) {
      const series = resolution.series[j];
      lines.push(
        `    系列: ${series.label} / ${series.dataPointCount} 点 / ${series.statusCode ?? '(状態不明)'}`
      );
    }
    for (let j = 0; j < resolution.messages.length; j += 1) {
      lines.push(`    CloudWatch メッセージ: ${resolution.messages[j]}`);
    }
    if (resolution.anomaly !== null) {
      lines.push(`    注意: ${resolution.anomaly}`);
    }
  }

  return lines;
}

/** OCU 分析を行の列へ整形する（要件 7.3 / 7.4 / 7.6 / 14.9） */
function formatOcuAnalysis(analysis: OcuUsageAnalysis): readonly string[] {
  const lines: string[] = [
    `  サンプル件数: ${analysis.sampleCount}（${analysis.periodSeconds} 秒間隔）`,
    `  区間: ${analysis.startTime ?? '(なし)'} 〜 ${analysis.endTime ?? '(なし)'}`,
    `  ${SEARCH_OCU_METRIC}: ${formatSummary(analysis.searchOcu)}`,
    `  ${INDEXING_OCU_METRIC}: ${formatSummary(analysis.indexingOcu)}`,
    `  合計 OCU: ${formatSummary(analysis.combinedOcu)}`,
    `  消費 OCU-hour: ${formatNumber(analysis.totalOcuHours, 4)}`,
    `  0 OCU 区間: ${analysis.zeroOcuIntervals.length} 件 / 合計 ${formatNumber(analysis.totalZeroOcuMinutes, 1)} 分` +
      ` / 最長 ${formatNumber(analysis.longestZeroOcuMinutes, 1)} 分`,
    `  ${SCALE_TO_ZERO_MIN_ZERO_MINUTES} 分以上の 0 OCU 区間: ${analysis.qualifyingZeroOcuIntervals.length} 件` +
      ` / 合計 ${formatNumber(analysis.qualifyingZeroOcuMinutes, 1)} 分`,
    `  scale-to-zero: ${analysis.scaleToZeroApplicable ? '適用可' : '非適用'}` +
      (analysis.alwaysOnMonthlyUsd === null
        ? ''
        : ` / 常時課金の月額見積 ${formatUsd(analysis.alwaysOnMonthlyUsd)} USD`),
    `  検索継続区間（${SEARCH_ACTIVE_MIN_MINUTES} 分以上）: ${analysis.searchActiveIntervals.length} 件`,
  ];

  for (let i = 0; i < analysis.searchActiveIntervals.length; i += 1) {
    lines.push(formatInterval(analysis.searchActiveIntervals[i]));
  }

  lines.push(`  アイドル区間（${IDLE_MIN_MINUTES / 60} 時間以上）: ${analysis.idleIntervals.length} 件`);
  for (let i = 0; i < analysis.idleIntervals.length; i += 1) {
    lines.push(formatInterval(analysis.idleIntervals[i]));
  }

  return lines;
}

/** 人が読む要約を組み立てる */
export function formatReportSummary(report: MeasurementReport): readonly string[] {
  const lines: string[] = [
    `Measurement_Collector（--${report.mode}）`,
    `生成時刻: ${report.generatedAt}`,
    `リージョン: ${report.region ?? '(解決できず。--region の明示が必要)'}`,
    '本スクリプトは読み取り専用である（作成・変更・削除を行わない）。',
    '',
  ];

  switch (report.mode) {
    case 'pre-check': {
      lines.push(`OSIS ${report.pipelineName}: ${report.pipelineStatus ?? '(取得できない)'}`);
      lines.push(`Good_Table: ${report.goodTableName}`);
      lines.push(`スナップショット: ${report.snapshotPath ?? '(未書き出し)'}`);
      lines.push('');
      lines.push('確認項目:');
      const checklist = formatChecklist(report.checklist);
      for (let i = 0; i < checklist.length; i += 1) lines.push(checklist[i]);
      break;
    }

    case 'wait-index': {
      const wait = report.wait;
      lines.push(`テーブル: ${wait.tableName}`);
      lines.push(
        `ポーリング: ${wait.pollIntervalSeconds} 秒間隔 / 上限 ${wait.timeoutMinutes} 分 / ` +
          `実施 ${wait.pollCount} 回 / 経過 ${formatNumber(wait.elapsedSeconds, 1)} 秒`
      );
      lines.push(`全 ${wait.records.length} 本が検索可能: ${wait.allSearchable ? 'はい' : 'いいえ'}`);
      lines.push('');
      for (let i = 0; i < wait.records.length; i += 1) {
        const record = wait.records[i];
        lines.push(`  ${record.indexName}`);
        lines.push(
          `    IndexStatus: ${record.finalIndexStatus || '(不明)'} / ` +
            `Backfilling: ${formatBackfillingObservation(record)}` +
            ` / 検索可能: ${record.searchable ? 'はい' : 'いいえ'}`
        );
        lines.push(
          `    ACTIVE 到達: ${record.activeReachedAt ?? '(未到達)'}` +
            `（開始から ${record.activeElapsedSeconds === null ? '-' : formatNumber(record.activeElapsedSeconds, 1)} 秒）`
        );
        if (record.backfillMeasurable) {
          lines.push(
            `    バックフィル完了: ${record.backfillCompletedAt ?? '(未完了)'}` +
              `（開始から ${record.backfillElapsedSeconds === null ? '-' : formatNumber(record.backfillElapsedSeconds, 1)} 秒` +
              ` / ACTIVE から ${record.activeToBackfillSeconds === null ? '-' : formatNumber(record.activeToBackfillSeconds, 1)} 秒）`
          );
        } else {
          // 0 秒や即時完了として書かない。測定不能であることと理由を出す（要件 5.17）
          lines.push('    バックフィル完了までの経過時間: 測定不能');
          lines.push(`    測定不能の理由: ${record.backfillUnmeasurableReason ?? BACKFILL_UNMEASURABLE_REASON}`);
        }
        if (record.error !== null) lines.push(`    エラー: ${record.error}`);
      }
      break;
    }

    case 'storage': {
      lines.push(`テーブル: ${report.tableName} / レコード件数: ${formatInteger(report.recordCount)}`);
      lines.push(
        `今回の取得: ${report.capturedSnapshots.length} 件 / 台帳の保持件数: ${report.ledgerSnapshotCount} 件` +
          `（台帳: ${report.ledgerPath ?? '(未書き出し)'}）`
      );
      lines.push('');
      lines.push('TableSizeBytes の収束判定:');
      for (let i = 0; i < report.tableSizeConvergence.length; i += 1) {
        const block = formatConvergence(report.tableSizeConvergence[i]);
        for (let j = 0; j < block.length; j += 1) lines.push(block[j]);
      }
      if (report.tableSizeConvergence.length === 0) lines.push('  (記録なし)');

      lines.push('');
      lines.push('IndexSizeBytes の収束判定:');
      for (let i = 0; i < report.indexSizeConvergence.length; i += 1) {
        const block = formatConvergence(report.indexSizeConvergence[i]);
        for (let j = 0; j < block.length; j += 1) lines.push(block[j]);
      }
      if (report.indexSizeConvergence.length === 0) lines.push('  (記録なし)');

      lines.push('');
      lines.push('ベクトル属性の寄与（要件 14.2）:');
      if (report.contribution === null) {
        lines.push('  (S1 / S2 が揃っていないため算出していない)');
      } else {
        const contribution = report.contribution;
        lines.push(`  S1: ${formatBytes(contribution.s1.value)} @ ${contribution.s1.capturedAt}`);
        lines.push(`  S2: ${formatBytes(contribution.s2.value)} @ ${contribution.s2.capturedAt}`);
        lines.push(
          `  寄与（S2 − S1）: ${formatBytes(contribution.vectorAttributeContributionBytes)}` +
            `${report.contributionDeterminate ? '' : '（未確定）'}`
        );
        lines.push(
          `  1 レコードあたり平均増分: ${formatNumber(contribution.averagePerRecordBytes, 2)} B` +
            `（÷ ${formatInteger(contribution.recordCount)} レコード）`
        );
        lines.push(`  GSI 複製分の差し引き: 適用なし（${contribution.gsiAdjustmentApplied}）`);
      }

      lines.push('');
      lines.push('インデックスサイズ（要件 14.3）:');
      if (report.indexTotals === null) {
        lines.push('  (記録なし)');
      } else {
        const totals = report.indexTotals;
        for (let i = 0; i < totals.indexes.length; i += 1) {
          const index = totals.indexes[i];
          lines.push(
            `  ${index.indexName}: ${formatBytes(index.indexSizeBytes)}` +
              ` / ItemCount ${formatInteger(index.itemCount)} @ ${index.capturedAt}`
          );
        }
        lines.push(
          `  合計: ${formatBytes(totals.totalIndexSizeBytes)} / ItemCount ${formatInteger(totals.totalItemCount)}` +
            `${report.indexTotalsDeterminate ? '' : '（未確定）'}`
        );
        lines.push(`  TableSizeBytes 差分からの算出: ${totals.derivedFromTableSizeDifference}`);
      }
      break;
    }

    case 'capacity': {
      const summary = report.consumedCapacity;
      lines.push(
        `テーブル: ${report.tableName} / インデックス: ${summary.indexName} / 言語: ${summary.language}`
      );
      lines.push(
        `検索: ${summary.searchCount} 回 / クエリ件数 ${summary.queryCount} / TopK ${summary.topK}` +
          ` / 次元数 ${report.dimensions} / シード ${report.vectorSeed}`
      );
      lines.push(`測定区間: ${summary.measurementStartedAt} 〜 ${summary.measurementEndedAt}`);
      lines.push('');
      lines.push('消費量 ConsumedCapacity.VectorSearchRequestBytes（要件 14.7）:');
      lines.push(
        `  読み取れた件数: ${summary.measuredCount} / 失敗 ${summary.failureCount}` +
          ` / ConsumedCapacity 欠落 ${summary.missingCapacityCount}`
      );
      lines.push(
        `  1 検索あたり 平均 ${formatNumber(summary.averagePerSearch ?? Number.NaN, 1)}` +
          ` / 最小 ${formatNumber(summary.minimumPerSearch ?? Number.NaN, 1)}` +
          ` / 最大 ${formatNumber(summary.maximumPerSearch ?? Number.NaN, 1)} B`
      );
      lines.push(`  合計: ${formatBytes(summary.total)}`);
      lines.push(`  レイテンシ（ミリ秒）: ${formatSummary(report.latency, 1)}`);
      lines.push('');
      lines.push('ConsumedCapacity.VectorSearchUnits（SDK モデルに無い項目。要件 8.11）:');
      lines.push(
        `  読み取れた件数: ${summary.unitsMeasuredCount}` +
          ` / 1 検索あたり 平均 ${formatNumber(summary.unitsAveragePerSearch ?? Number.NaN, 1)}` +
          ` / 最小 ${formatNumber(summary.unitsMinimumPerSearch ?? Number.NaN, 1)}` +
          ` / 最大 ${formatNumber(summary.unitsMaximumPerSearch ?? Number.NaN, 1)}`
      );
      lines.push(`  合計: ${formatInteger(summary.unitsTotal)}`);
      lines.push(
        `  VectorSearchRequestBytes との一致: ${
          summary.unitsAlwaysEqualRequestBytes === null
            ? '観測できていない（両項目を読めた検索が 0 件）'
            : summary.unitsAlwaysEqualRequestBytes
              ? `全 ${summary.unitsEqualRequestBytesCount} 件で同値`
              : `食い違い ${summary.unitsDivergentCount} 件 / 同値 ${summary.unitsEqualRequestBytesCount} 件`
        }`
      );
      lines.push('');
      lines.push(`${VECTOR_SEARCH_REQUEST_BYTES_METRIC}（要件 14.8）:`);
      if (report.requestBytes.length === 0) {
        lines.push('  (取得していない)');
      } else {
        for (let i = 0; i < report.requestBytes.length; i += 1) {
          const bytes = report.requestBytes[i];
          lines.push(
            `  ${bytes.indexName}: 合計 ${formatBytes(bytes.totalBytes)}` +
              ` / データ点 ${bytes.dataPointCount} 件` +
              ` / 1 検索あたり ${bytes.averagePerSearchBytes === null ? '-' : formatNumber(bytes.averagePerSearchBytes, 1) + ' B'}`
          );
          lines.push(`        区間: ${bytes.windowStart} 〜 ${bytes.windowEnd}`);
        }
      }
      break;
    }

    case 'ocu': {
      lines.push(`Collection Group: ${report.collectionGroupName}`);
      lines.push(
        `絞り込みに用いた次元: ${report.ocuDimension.name}=${report.ocuDimension.value}` +
          `（OCU は Collection ではなく Collection Group で公開される）`
      );
      const ocuQueryLines = formatOcuQuery(report.ocuQuery);
      for (let i = 0; i < ocuQueryLines.length; i += 1) lines.push(ocuQueryLines[i]);
      lines.push(
        `取得区間: ${report.windowStart} 〜 ${report.windowEnd}（${report.windowHours} 時間 / ` +
          `${report.periodSeconds} 秒間隔）`
      );
      lines.push(
        `突き合わせ: 両方あり ${report.alignment.pairedCount} 件 / 検索のみ ${report.alignment.searchOnlyCount} 件` +
          ` / インデックスのみ ${report.alignment.indexingOnlyCount} 件`
      );
      lines.push('');
      const analysis = formatOcuAnalysis(report.analysis);
      for (let i = 0; i < analysis.length; i += 1) lines.push(analysis[i]);
      lines.push('');
      lines.push(`${OCU_UTILIZATION_METRIC}（要件 7.8）:`);
      lines.push(
        `  絞り込みに用いた次元: ${report.utilization.dimension.name}=${report.utilization.dimension.value}`
      );
      if (report.utilization.dataPointsPresent) {
        lines.push(`  Minimum 系列: ${formatSummary(report.utilization.minimum)}`);
        lines.push(`  Average 系列: ${formatSummary(report.utilization.average)}`);
        lines.push(`  Maximum 系列: ${formatSummary(report.utilization.maximum)}`);
      } else {
        lines.push('  データ点なし（測定値が存在しない。使用率 0 を測定したのではない）');
        lines.push(`  ${report.utilization.unavailableReason ?? ''}`);
      }
      lines.push('');
      lines.push(`区間分解の保存則: ${report.partitionConserved ? '一致' : '不一致'}`);
      break;
    }

    case 'watch-spend': {
      const spend = report.spend;
      lines.push(`Collection Group: ${report.collectionGroupName}`);
      lines.push(`Collection（削除要求の対象。照会には使わない）: ${report.collectionName}`);
      lines.push(
        `絞り込みに用いた次元: ${report.ocuDimension.name}=${report.ocuDimension.value}`
      );
      const spendQueryLines = formatOcuQuery(report.ocuQuery);
      for (let i = 0; i < spendQueryLines.length; i += 1) lines.push(spendQueryLines[i]);
      lines.push(`取得区間: ${report.windowStart} 〜 ${report.windowEnd}`);
      lines.push('');
      lines.push('累積課金（要件 7.7）:');
      lines.push(
        `  累積 ${formatNumber(spend.totalOcuHours, 4)} OCU-hour × ${spend.hourlyUsd} USD = ` +
          `${formatUsd(spend.totalUsd)} USD（上限 ${spend.thresholdUsd} USD）`
      );
      lines.push(
        `  積算に採用したサンプル: ${spend.retainedSampleCount} 件 / 打ち切りにより除外: ${spend.skippedSampleCount} 件`
      );
      lines.push(`  測定終了: ${spend.terminated ? 'はい（閾値超過）' : 'いいえ'}`);
      if (spend.warning !== null) {
        lines.push(`  超過時点: ${spend.warning.timestamp}`);
        lines.push('  要求される対応:');
        for (let i = 0; i < spend.warning.requiredActions.length; i += 1) {
          lines.push(`    - ${spend.warning.requiredActions[i]}`);
        }
      }
      lines.push('');
      lines.push('区間分解（要件 14.9）:');
      const analysis = formatOcuAnalysis(report.analysis);
      for (let i = 0; i < analysis.length; i += 1) lines.push(analysis[i]);
      break;
    }

    case 'teardown-check': {
      lines.push(`撤収完了: ${report.teardownComplete ? 'はい' : 'いいえ'}`);
      lines.push(`削除の実行: ${report.deletionPerformed}（確認のみを行う）`);
      lines.push(
        `OCU 照会の絞り込みに用いた次元: ${
          report.ocuDimension === null
            ? '(CloudWatch を参照していない)'
            : `${report.ocuDimension.name}=${report.ocuDimension.value}`
        }`
      );
      if (report.ocuQuery !== null) {
        const teardownQueryLines = formatOcuQuery(report.ocuQuery);
        for (let i = 0; i < teardownQueryLines.length; i += 1) lines.push(teardownQueryLines[i]);
      }
      lines.push('');
      lines.push('確認項目（task 15.1）:');
      const checklist = formatChecklist(report.checklist);
      for (let i = 0; i < checklist.length; i += 1) lines.push(checklist[i]);

      if (report.goodTableComparison !== null && !report.goodTableComparison.identical) {
        lines.push('');
        lines.push('Good_Table の相違:');
        const differences = report.goodTableComparison.differences;
        for (let i = 0; i < differences.length; i += 1) {
          lines.push(
            `    ${differences[i].field}: 基準 ${differences[i].baseline} → 現在 ${differences[i].current}`
          );
        }
        const missing = report.goodTableComparison.missingItemKeys;
        for (let i = 0; i < missing.length; i += 1) {
          lines.push(`    取得できなかった抽出アイテム: ${missing[i]}`);
        }
      }
      break;
    }
  }

  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('対応を要する事項:');
    for (let i = 0; i < report.warnings.length; i += 1) {
      lines.push(`  - ${report.warnings[i]}`);
    }
  }

  if (report.notes.length > 0) {
    lines.push('');
    lines.push('注記:');
    for (let i = 0; i < report.notes.length; i += 1) {
      lines.push(`  - ${report.notes[i]}`);
    }
  }

  lines.push('');
  lines.push(`終了コード: ${resolveExitCode(report)}`);

  return lines;
}

// ============================================================
// CLI
// ============================================================

/** コマンドライン引数の解釈結果 */
export interface MeasureCliOptions {
  mode: MeasurementMode;
  help: boolean;
  json: boolean;
  write: boolean;
  outputDir: string;
  region: string | null;
  endpoint: string | null;
  tableName: string;
  goodTableName: string;
  queryCacheTableName: string;
  collectionName: string;
  collectionGroupName: string;
  pipelineName: string;
  label: StorageLabel | null;
  language: VectorLanguage;
  topK: number;
  searchCount: number;
  dimensions: number;
  vectorSeed: number;
  hours: number;
  timeoutMinutes: number;
  pollSeconds: number;
  scanLimit: number;
  recordCount: number;
  thresholdUsd: number;
}

/** モードフラグと {@link MeasurementMode} の対応 */
const MODE_FLAGS: Readonly<Record<string, MeasurementMode>> = {
  '--pre-check': 'pre-check',
  '--wait-index': 'wait-index',
  '--storage': 'storage',
  '--capacity': 'capacity',
  '--ocu': 'ocu',
  '--watch-spend': 'watch-spend',
  '--teardown-check': 'teardown-check',
};

/** 値を伴わないオプション */
const BOOLEAN_FLAGS = ['--help', '-h', '--json', '--no-write'] as const;

/**
 * 引数を解釈する（純関数）。
 *
 * モードは 1 回の実行でちょうど 1 つでなければならない。0 個や 2 個以上を黙って
 * 既定へ丸めると、意図しない測定が走って課金や壁時計時間を消費する。
 * 未知のオプションも例外にして、綴り間違いを黙って無視しない。
 */
export function parseMeasureArgs(argv: readonly string[]): MeasureCliOptions {
  const options: MeasureCliOptions = {
    mode: 'pre-check',
    help: false,
    json: false,
    write: true,
    outputDir: MEASUREMENT_DIR,
    region: null,
    endpoint: null,
    tableName: DEFAULT_VECTOR_TABLE_NAME,
    goodTableName: DEFAULT_GOOD_TABLE_NAME,
    queryCacheTableName: DEFAULT_QUERY_CACHE_TABLE_NAME,
    collectionName: DEFAULT_VECTOR_COLLECTION_NAME,
    collectionGroupName: DEFAULT_VECTOR_COLLECTION_GROUP_NAME,
    pipelineName: DEFAULT_INGESTION_PIPELINE_NAME,
    label: null,
    language: 'ja',
    topK: 30,
    searchCount: CONSUMED_CAPACITY_SEARCH_COUNT,
    dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
    vectorSeed: DEFAULT_VECTOR_SEED,
    hours: DEFAULT_OCU_WINDOW_HOURS,
    timeoutMinutes: DEFAULT_INDEX_WAIT_TIMEOUT_MINUTES,
    pollSeconds: INDEX_POLL_INTERVAL_SECONDS,
    scanLimit: GOOD_TABLE_SCAN_LIMIT,
    recordCount: VECTOR_RECORD_COUNT,
    thresholdUsd: SPEND_THRESHOLD_USD,
  };

  const selectedModes: MeasurementMode[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    const mode = MODE_FLAGS[token];
    if (mode !== undefined) {
      selectedModes.push(mode);
      continue;
    }

    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      continue;
    }
    if (token === '--no-write') {
      options.write = false;
      continue;
    }

    const inline = /^(--[a-z-]+)=(.*)$/.exec(token);
    const key = inline === null ? token : inline[1];
    if (!key.startsWith('--')) {
      throw new MeasurementError(`解釈できない引数: ${token}。--help で使い方を確認してください。`);
    }
    if (BOOLEAN_FLAGS.indexOf(key as (typeof BOOLEAN_FLAGS)[number]) >= 0) {
      throw new MeasurementError(`${key} は値を取りません。`);
    }

    let value: string;
    if (inline !== null) {
      value = inline[2];
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new MeasurementError(`${key} には値が必要です。`);
      }
      value = next;
      i += 1;
    }

    switch (key) {
      case '--region':
        options.region = value;
        break;
      case '--endpoint':
        options.endpoint = value;
        break;
      case '--table':
        options.tableName = value;
        break;
      case '--good-table':
        options.goodTableName = value;
        break;
      case '--query-cache-table':
        options.queryCacheTableName = value;
        break;
      case '--collection':
        options.collectionName = value;
        break;
      case '--collection-group':
        options.collectionGroupName = value;
        break;
      case '--pipeline':
        options.pipelineName = value;
        break;
      case '--out':
        options.outputDir = value;
        break;
      case '--label':
        if (!isStorageLabel(value)) {
          throw new MeasurementError(
            `--label は ${STORAGE_LABELS.join(' / ')} のいずれかです（指定値: ${value}）。`
          );
        }
        options.label = value;
        break;
      case '--language':
        if (!isVectorLanguage(value)) {
          throw new MeasurementError(
            `--language は ${VECTOR_LANGUAGES.join(' / ')} のいずれかです（指定値: ${value}）。`
          );
        }
        options.language = value;
        break;
      case '--topk':
        options.topK = parsePositiveInteger(value, '--topk');
        break;
      case '--count':
        options.searchCount = parsePositiveInteger(value, '--count');
        break;
      case '--dimensions':
        options.dimensions = parsePositiveInteger(value, '--dimensions');
        break;
      case '--seed':
        options.vectorSeed = parsePositiveInteger(value, '--seed');
        break;
      case '--hours':
        options.hours = parsePositiveNumber(value, '--hours');
        break;
      case '--timeout-minutes':
        options.timeoutMinutes = parsePositiveNumber(value, '--timeout-minutes');
        break;
      case '--poll-seconds':
        options.pollSeconds = parsePositiveNumber(value, '--poll-seconds');
        break;
      case '--scan-limit':
        options.scanLimit = parsePositiveInteger(value, '--scan-limit');
        break;
      case '--record-count':
        options.recordCount = parsePositiveInteger(value, '--record-count');
        break;
      case '--threshold-usd':
        options.thresholdUsd = parsePositiveNumber(value, '--threshold-usd');
        break;
      default:
        throw new MeasurementError(`不明なオプション: ${key}。--help で使い方を確認してください。`);
    }
  }

  if (options.help) {
    return options;
  }

  if (selectedModes.length === 0) {
    throw new MeasurementError(
      `測定モードを 1 つ指定してください（${Object.keys(MODE_FLAGS).join(' / ')}）。`
    );
  }
  if (selectedModes.length > 1) {
    throw new MeasurementError(
      `測定モードは 1 回の実行で 1 つだけ指定してください（指定: ${selectedModes.join(', ')}）。`
    );
  }

  options.mode = selectedModes[0];
  return options;
}

/** 正の整数として解釈する */
function parsePositiveInteger(raw: string, label: string): number {
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new MeasurementError(`${label} は正の整数です（指定値: ${raw}）。`);
  }
  return parsed;
}

/** 正の数として解釈する */
function parsePositiveNumber(raw: string, label: string): number {
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new MeasurementError(`${label} は正の数です（指定値: ${raw}）。`);
  }
  return parsed;
}

/** `--help` の出力 */
export function formatUsage(): readonly string[] {
  return [
    'Measurement_Collector: ベクトル検索比較の測定値を収集します（読み取り専用）。',
    '',
    '測定モード（1 回の実行で 1 つだけ指定する）:',
    '  --pre-check       段階 0 の事前確認。OSIS の状態確認と Good_Table スナップショットの保存（要件 1.5 / 6.9 / 6.10）',
    '  --wait-index      2 本のインデックスの ACTIVE 到達とバックフィル完了を待つ（要件 5.14）',
    '  --storage         TableSizeBytes / IndexSizeBytes の取得と収束判定と寄与の算出（要件 14.2〜14.6）',
    '  --capacity        同一条件 100 回検索の消費キャパシティと転送量（要件 14.7 / 14.8）',
    '  --ocu             SearchOCU / IndexingOCU / OCUUtilization の集計と区間分解（要件 7.3 / 7.4 / 7.6 / 7.8 / 14.9）',
    '  --watch-spend     累積 OCU 課金が 20 USD を初めて超えた時点で測定終了と削除要求（要件 7.7）',
    '  --teardown-check  撤収確認チェックリスト（task 15.1）。確認のみで削除は行わない',
    '',
    '共通オプション:',
    `  --region <region>          参照するリージョン（既定: AWS SDK の既定解決。解決した実効値をレポートへ記録する）`,
    `  --out <dir>                出力先ディレクトリ（既定: ${MEASUREMENT_DIR}）`,
    '  --json                     レポート JSON を標準出力へ出す',
    '  --no-write                 レポートファイルを書き出さない',
    '  -h, --help                 この使い方を表示する',
    '',
    'リソース名の上書き:',
    `  --table <name>             Vector_Table 名（既定: ${DEFAULT_VECTOR_TABLE_NAME}）`,
    `  --good-table <name>        Good_Table 名（既定: ${DEFAULT_GOOD_TABLE_NAME}）`,
    `  --query-cache-table <name> Query_Vector_Cache 名（既定: ${DEFAULT_QUERY_CACHE_TABLE_NAME}）`,
    `  --collection <name>        Vector_Collection 名（既定: ${DEFAULT_VECTOR_COLLECTION_NAME}）`,
    '                             用途: --teardown-check の ListCollections 存在確認 / --watch-spend の削除要求文',
    '                             OCU メトリクスの照会には使わない（OCU は Collection 単位で公開されない）',
    `  --collection-group <name>  Vector_Collection_Group 名（既定: ${DEFAULT_VECTOR_COLLECTION_GROUP_NAME}）`,
    '                             用途: --teardown-check の ListCollectionGroups 存在確認 /',
    `                             --ocu / --watch-spend / --teardown-check の OCU メトリクス（${SEARCH_OCU_METRIC} /`,
    `                             ${INDEXING_OCU_METRIC} / ${OCU_UTILIZATION_METRIC}）を引く SEARCH() 式の検索語`,
    `                             （次元 ${AOSS_OCU_DIMENSION_NAME} の値）`,
    `  --pipeline <name>          OSIS パイプライン名（既定: ${DEFAULT_INGESTION_PIPELINE_NAME}）`,
    '',
    'モード別オプション:',
    `  --timeout-minutes <n>      --wait-index のタイムアウト（既定: ${DEFAULT_INDEX_WAIT_TIMEOUT_MINUTES}）`,
    `  --poll-seconds <n>         --wait-index のポーリング間隔（既定 / 上限: ${INDEX_POLL_INTERVAL_SECONDS}）`,
    `  --label <${STORAGE_LABELS.join('|')}>   --storage で取得するスナップショットの位置づけ（省略時は取得せず判定のみ）`,
    `  --record-count <n>         1 レコードあたり平均増分の除数（既定: ${VECTOR_RECORD_COUNT}）`,
    `  --language <ja|en>         --capacity の対象言語（既定: ja）`,
    '  --topk <n>                 --capacity の TopK（既定: 30、1〜100 の整数）',
    `  --count <n>                --capacity の検索回数（既定: ${CONSUMED_CAPACITY_SEARCH_COUNT}）`,
    `  --dimensions <n>           クエリベクトルの次元数（既定: ${DEFAULT_EMBEDDING_DIMENSIONS}）`,
    `  --seed <n>                 クエリベクトルのシード（既定: ${DEFAULT_VECTOR_SEED}）`,
    '  --endpoint <url>           ベクトル検索エンドポイントの上書き',
    `  --hours <n>                --ocu / --watch-spend / --teardown-check の取得区間（既定: ${DEFAULT_OCU_WINDOW_HOURS}）`,
    `  --threshold-usd <n>        --watch-spend の上限（既定: ${SPEND_THRESHOLD_USD}）`,
    `  --scan-limit <n>           --pre-check の Scan 件数（既定: ${GOOD_TABLE_SCAN_LIMIT}）`,
    '',
    '終了コード:',
    `  ${EXIT_CODES.ok} 測定完了（対応を要する事項なし）`,
    `  ${EXIT_CODES.error} 実行時エラー（SDK 未導入、認証情報なし、API エラー、引数不正）`,
    `  ${EXIT_CODES.attention} 測定完了だが対応を要する事項あり（タイムアウト / 未確定 / 20 USD 超過 / 撤収未完了）`,
    '',
    'OCU メトリクスの次元について:',
    `  ${SEARCH_OCU_METRIC} / ${INDEXING_OCU_METRIC} / ${OCU_UTILIZATION_METRIC} は Collection ではなく`,
    '  Collection Group 単位で公開され、系列は次元キー集合',
    `  {${AOSS_OCU_DIMENSION_KEYS.join(', ')}} を持ちます。`,
    `  GetMetricStatistics は次元集合の完全一致を要求するため、${AOSS_OCU_DIMENSION_NAME} だけを`,
    '  指定した照会は OCU を消費していても常にデータ点 0 件を返します。本スクリプトは',
    `  GetMetricData + SEARCH() で照会し、${AOSS_OCU_DIMENSION_NAME} の値を検索語として絞り込みます。`,
    `  per-Collection の次元（${AOSS_PER_COLLECTION_DIMENSION_NAME}）を持つのは SearchableDocuments /`,
    '  StorageUsedInHot / SearchRequest* などのドキュメント・ストレージ・リクエスト系だけです。',
    '  データ点が 0 件だった場合、それは「0 OCU を測定した」ことではなく「測定値が存在しない」ことです。',
    '  0 課金の確定には請求データ（Cost Explorer / Billing）を用いてください。',
    '  SEARCH() は複数系列を返しうるため、系列数とデータ点数をレポートへ記録し、',
    '  データを持つ系列が 0 本 / 2 本以上の場合は警告します。',
    '',
    '--ocu / --watch-spend / --teardown-check の一部は以下の SDK を必要とします（いずれも導入済み。',
    '実行時に遅延 import するため、必要としないモードでは読み込みません）:',
    `  ${CLOUDWATCH_SDK_PACKAGE} / ${OPENSEARCH_SERVERLESS_SDK_PACKAGE} / ${OSIS_SDK_PACKAGE}`,
    '解決に失敗する場合のみ、次のコマンドで復旧してください:',
    `  ${OPTIONAL_SDK_INSTALL_COMMAND}`,
    '',
    '使用例:',
    '  npm run vector:measure -- --pre-check',
    '  npm run vector:measure -- --wait-index --timeout-minutes 180',
    '  npm run vector:measure -- --storage --label S1',
    '  npm run vector:measure -- --capacity --language ja --topk 30',
    '  npm run vector:measure -- --ocu --hours 24',
    '  npm run vector:measure -- --watch-spend',
    '  npm run vector:measure -- --teardown-check',
  ];
}

/**
 * モードに応じて必要な経路だけを組み立てて測定を実行する。
 *
 * 全経路を先に作らないのは、未導入 SDK を必要としないモード（`--wait-index` /
 * `--storage` / `--capacity`）を SDK 追加なしで実行できるようにするためである。
 *
 * 実効リージョンの解決はこの配線層だけで行う。`run*()` は注入された経路しか使わない純粋な
 * 関数であり、SDK へ自分から触らせない（テストから AWS 抜きで検証できる形を保つ）。
 * 解決した値は既存の `region` オプションとして各モードへ渡す。
 */
export async function runMeasurement(options: MeasureCliOptions): Promise<{
  report: MeasurementReport;
  closers: readonly (() => void)[];
}> {
  const closers: (() => void)[] = [];
  const store = options.write
    ? createFileSystemMeasurementStore(options.outputDir)
    : createReadOnlyMeasurementStore(options.outputDir);

  const resolution = await resolveEffectiveRegion(options.region);
  // SDK クライアントへも解決済みの値を渡す。レポートに載せたリージョンと、実際に参照した
  // リージョンが食い違わないようにするため（解決できなかった場合のみ SDK の既定解決に委ねる）
  const region = resolution.region ?? undefined;
  const effectiveRegion = resolution.region;
  const finish = (report: MeasurementReport): { report: MeasurementReport; closers: readonly (() => void)[] } => ({
    report: appendReportWarning(report, resolution.warning),
    closers,
  });

  const openDynamo = (): DynamoDbMeasurementSource => {
    const created = createDynamoDbMeasurementSource({ region });
    closers.push(created.close);
    return created.source;
  };
  const openMetrics = (): MetricSource => {
    const created = createCloudWatchMetricSource({ region });
    closers.push(created.close);
    return created.source;
  };

  switch (options.mode) {
    case 'pre-check': {
      const pipelines = createPipelineStateSource({ region });
      closers.push(pipelines.close);
      return finish(
        await runPreCheck({
          dynamo: openDynamo(),
          pipelines: pipelines.source,
          store,
          region: effectiveRegion,
          goodTableName: options.goodTableName,
          pipelineName: options.pipelineName,
          scanLimit: options.scanLimit,
          write: options.write,
        })
      );
    }

    case 'wait-index':
      return finish(
        await runWaitIndex({
          dynamo: openDynamo(),
          region: effectiveRegion,
          tableName: options.tableName,
          timeoutMinutes: options.timeoutMinutes,
          pollIntervalSeconds: options.pollSeconds,
        })
      );

    case 'storage':
      return finish(
        await runStorage({
          dynamo: openDynamo(),
          store,
          region: effectiveRegion,
          tableName: options.tableName,
          label: options.label,
          recordCount: options.recordCount,
          write: options.write,
        })
      );

    case 'capacity': {
      const created = await createSearchVectorsProbe({
        region,
        endpoint: options.endpoint ?? undefined,
      });
      closers.push(created.close);
      return finish(
        await runCapacity({
          probe: created.probe,
          metrics: openMetrics(),
          region: effectiveRegion ?? created.region,
          tableName: options.tableName,
          language: options.language,
          topK: options.topK,
          searchCount: options.searchCount,
          dimensions: options.dimensions,
          vectorSeed: options.vectorSeed,
        })
      );
    }

    case 'ocu':
      // OCU は Collection Group で公開されるため、渡すのは --collection-group である
      return finish(
        await runOcu({
          metrics: openMetrics(),
          region: effectiveRegion,
          collectionGroupName: options.collectionGroupName,
          hours: options.hours,
        })
      );

    case 'watch-spend':
      return finish(
        await runWatchSpend({
          metrics: openMetrics(),
          region: effectiveRegion,
          collectionName: options.collectionName,
          collectionGroupName: options.collectionGroupName,
          hours: options.hours,
          thresholdUsd: options.thresholdUsd,
        })
      );

    case 'teardown-check': {
      const collections = createCollectionInventorySource({ region });
      const pipelines = createPipelineStateSource({ region });
      closers.push(collections.close, pipelines.close);
      return finish(
        await runTeardownCheck({
          dynamo: openDynamo(),
          store,
          collections: collections.source,
          pipelines: pipelines.source,
          metrics: openMetrics(),
          region: effectiveRegion,
          tableName: options.tableName,
          queryCacheTableName: options.queryCacheTableName,
          goodTableName: options.goodTableName,
          collectionName: options.collectionName,
          collectionGroupName: options.collectionGroupName,
          pipelineName: options.pipelineName,
          hours: options.hours,
          scanLimit: options.scanLimit,
        })
      );
    }
  }
}

/** CLI の本体。終了コードを返す */
export async function main(argv: readonly string[]): Promise<number> {
  let options: MeasureCliOptions;
  try {
    options = parseMeasureArgs(argv);
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n\n${formatUsage().join('\n')}\n`);
    return EXIT_CODES.error;
  }

  if (options.help) {
    process.stdout.write(`${formatUsage().join('\n')}\n`);
    return EXIT_CODES.ok;
  }

  let closers: readonly (() => void)[] = [];
  try {
    const executed = await runMeasurement(options);
    closers = executed.closers;
    const report = executed.report;

    process.stdout.write(`${formatReportSummary(report).join('\n')}\n`);

    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (options.json) {
      process.stdout.write(`\n${json}`);
    }

    if (options.write) {
      const store = createFileSystemMeasurementStore(options.outputDir);
      const path = await store.writeNew(
        measurementReportFileName(report.mode, report.generatedAt),
        json
      );
      process.stdout.write(`\nレポートを書き出しました: ${path}\n`);
    }

    return resolveExitCode(report);
  } catch (error) {
    process.stderr.write(
      [
        '測定を実行できませんでした。',
        describeError(error),
        '',
        'このスクリプトは読み取り専用です。失敗しても AWS リソースは変更されていません。',
      ].join('\n') + '\n'
    );
    return EXIT_CODES.error;
  } finally {
    for (let i = 0; i < closers.length; i += 1) {
      closers[i]();
    }
  }
}

/**
 * このファイルが直接実行されたかを判定する。
 *
 * `import.meta` は CJS 実行では使えず、`require.main` は型定義に依存するため、
 * 起動引数のパスで判定する。テストから import した場合に `main()` が走らないための門である。
 */
function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') {
    return false;
  }
  return /(^|\/)measure\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.replace(/\\/g, '/'));
}

if (isDirectInvocation()) {
  void main(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
