/**
 * Embedding_Batch_Job（`kiro-vector-embed-batch`）
 *
 * `POST /vector-search/embed-batch`。運用操作として起動する 2 フェーズのバッチ。
 *
 * | phase | 内容 | 実装状況 |
 * |---|---|---|
 * | `copy` | Good_Table から Vector_Table へ 15,000 レコードを複製し、日英メタデータを付与する | 本ファイル（タスク 8.5） |
 * | `embed` | 日英 2 本の埋め込みを生成して DynamoDB と OpenSearch へ書き込む | 本ファイル（タスク 8.6） |
 *
 * 2 つのフェーズは**別々の運用操作**として起動する。`copy` は `embed` を自動起動しない。
 * 実行順序（設計「実行順序」）では両者の間にベクトルインデックスの作成が入るためである。
 *
 * ## `phase = "copy"` の設計上の要点
 *
 * - **Good_Table は読み取り専用。** 使用するのは GSI `byWarehouse` に対する `Query` のみで、
 *   Good_Table を対象とする書き込みコマンド（`PutItem` / `UpdateItem` / `DeleteItem` /
 *   `BatchWriteItem`）を組み立てる経路がコード上に存在しない。書き込み先のテーブル名は
 *   `VECTOR_TABLE_NAME` から解決した 1 つの変数のみであり、`GOOD_TABLE_NAME` は
 *   `QueryCommand` にしか渡らない（要件 1.4 / 17.10、Property 7）
 * - **既存 6 属性は AttributeValue のまま転記する。** `itemName` / `quantity` / `lotNumber` /
 *   `location` / `unitPrice` は JS の値へ変換せず、読み取った `AttributeValue` を
 *   そのまま `PutRequest` へ載せる。数値の再文字列化による表現の揺れが構造的に起きない
 *   （要件 1.3 / 2.7、Property 5）
 * - **メタデータは入れ子で持たせる。** `deriveSkuMetadata()` の 9 項目は `metaJa` / `metaEn` の
 *   2 つの Map 属性の下に置き、既存属性と同じ階層へ展開しない。ベクトルインデックスの射影
 *   （`amplify/custom/vector-index.ts` の `VECTOR_INDEX_PROJECTED_ATTRIBUTES`）および
 *   DynamoDB 検索ハンドラの読み出しがこの 2 属性名を前提にしている
 * - **この時点ではベクトル属性を持たない。** `embeddingJa` / `embeddingEn` は `phase = "embed"`
 *   が `UpdateItem` で後から追加する
 * - **件数ゲートが最後の関門。** 複製後に Vector_Table の実件数を数え、15,000 件でなければ
 *   `RECORD_COUNT_MISMATCH` を返す。応答には期待件数と実件数の両方を含める（要件 1.7、Property 7）
 * - **自己再帰起動に対応する。** 残り実行時間が閾値を下回ったらカーソルを永続化して自身を
 *   非同期 invoke する（既存 `load-test-start` の自己非同期起動パターンを踏襲）。15,000 レコードの
 *   複製は通常 1 起動で完了するが、`embed` フェーズと同じ継続機構を共有しておく
 *
 * ## `phase = "embed"` の設計上の要点
 *
 * - **件数ゲートを先に通す。** 15,000 件でなければ Bedrock を 1 度も呼ばずに
 *   `RECORD_COUNT_MISMATCH` を返す（要件 1.7）。継続起動では判定結果をカーソルで引き継ぎ、
 *   全件 `Scan` を起動回数分繰り返さない
 * - **対象 SKU は 1 倉庫に絞った `Scan` で列挙する。** Vector_Table は GSI を持たないため、
 *   `warehouseId = WH-TOKYO` のフィルタが itemId の一意集合（5,000 件）を得る唯一の経路である。
 *   この行は同時にスキップ判定と表示用メタデータの**代表行**を兼ねる
 * - **スキップ判定は言語ごとに独立。** 当該言語のベクトルが存在し、`embeddingModel` と
 *   `embeddingDimensions` が**ともに**現行設定と一致する組だけをスキップする（要件 4.5）。
 *   判定材料は Vector_Table に格納された値のみであり、進捗レコードを入力にしない。
 *   したがって進捗レコードが失われても「成功済みの組へ Bedrock を呼ばない」（要件 4.9）が壊れない
 * - **両言語を 1 回の書き込みにまとめる。** 生成した言語のベクトルは 1 回の `UpdateItem` で書く。
 *   片方の言語だけが格納された中間状態が残らない（要件 3.5）。生成に失敗した言語がある SKU は
 *   書き込み自体を行わず、成功した側のベクトルも破棄する（次回実行が両言語をまとめて再生成する）
 * - **OpenSearch は `_bulk` の `index` のみを使う。** Ingestion_Pipeline を経由せず、
 *   インデックスとマッピングの作成・変更も行わない（要件 6.8）。`_id` は
 *   `${itemId}#${warehouseId}` なので再試行は冪等である
 * - **補償は両言語まとめて巻き戻す。** 片側成功・他方が 3 回再試行後も失敗した場合、
 *   DynamoDB 側は 5 属性を `REMOVE`、OpenSearch 側は当該 `_id` を delete し、
 *   当該 SKU を未格納として (itemId, language) とエラー内容付きで記録する（要件 3.10）
 * - **検証は Vector_Table のみを読み返す。** 書き込み後に Vector_Table から書き込んだ言語の
 *   ベクトルを読み返し、次元数一致と全要素の完全一致を要素単位で比較する（要件 3.6）。
 *   書き込む値は f32 に丸めているためビット等価として判定できる。
 *   **Vector_Collection への読み出しは 1 回も発行しない**（要件 3.12）。バッチロールの
 *   Vector_Collection 権限は `aoss:WriteDocument` のみであり（要件 17.7）、読み出すと
 *   全件 `ACCESS_DENIED_IAM` になる。両バックエンドの突き合わせは Verification_Run
 *   （`POST /vector-search/verify`、要件 3.13）が担う
 * - **検証の不一致と未格納は失敗件数に計上する。** 和が 1 以上なら実行状態を `COMPLETED` に
 *   しない（要件 3.18）。集計と終了判定は `verification-summary.ts` の
 *   `summarizeVerification()` / `resolveVerificationRunStatus()` に委ねる
 * - **失敗は例外にしない。** 生成・書き込み・検証のいずれの失敗も (itemId, language) 単位で
 *   記録して次の SKU へ進む（要件 3.11 / 4.3 / 4.7）
 * - **失敗一覧の保持枠は種類間で公平に配分する。** `failure-ledger.ts` が
 *   `(stage, errorCode)` ごとの件数を均すため、大量に出る 1 種類が少数派の種類を
 *   一覧から押し出さない（要件 3.10 の「対象 itemId を実行結果に含める」を守るため）
 *
 * ## Lambda 構成（タスク 8.7 の配線対象）
 *
 * **タイムアウト 15 分 / メモリ 1024 MB**（設計「Embedding_Batch_Job」）。
 * 自己再帰の判定は残り実行時間 120 秒であり、15 分のタイムアウトを前提にしている。
 * タイムアウトを短くすると 1 起動あたりの処理 SKU 数が減り、起動回数の上限
 * （`MAX_EMBED_INVOCATIONS`）に先に到達しうる。
 *
 * ## 環境変数（タスク 8.7 の配線対象）
 *
 * | 変数 | 必須 | 用途 |
 * |---|---|---|
 * | `GOOD_TABLE_NAME` | copy で必須 | 複製元。**読み取りのみ**に使う（`kiro-roasters-inventory-good`） |
 * | `VECTOR_TABLE_NAME` | copy / embed で必須 | 複製先（`kiro-roasters-inventory-vector`） |
 * | `EXECUTIONS_TABLE_NAME` | copy は任意 / embed は必須 | 進捗永続化先（`load-test-executions`） |
 * | `AWS_LAMBDA_FUNCTION_NAME` | 自動設定 | 自己再帰 invoke の宛先 |
 * | `AWS_REGION` | 自動設定 | SDK クライアントのリージョン |
 *
 * `phase = "embed"` が追加で必要とする変数。
 *
 * | 変数 | 必須 | 用途 |
 * |---|---|---|
 * | `OPENSEARCH_VECTOR_ENDPOINT` | embed で必須 | Vector_Collection `kiro-inventory-vector` のエンドポイント URL |
 * | `VECTOR_INDEX_NAME` | 任意 | インデックス名。既定 `inventory-vector` |
 * | `VECTOR_EMBEDDING_DIMENSIONS` | 任意 | 次元数。既定 1024（`embedding-generator.ts` が解決する） |
 * | `VECTOR_EMBEDDING_REQUESTS_PER_MINUTE` | 任意 | 呼び出しレート。既定 120（同上） |
 *
 * IAM（タスク 8.7）: Good_Table とその 3 GSI に対する `dynamodb:Query` のみ（書き込み Action を
 * 一切含めない、要件 17.10）、Vector_Table に対する `dynamodb:BatchWriteItem` / `dynamodb:Scan` /
 * `dynamodb:Query` / `dynamodb:GetItem` / `dynamodb:UpdateItem`（要件 17.11）、
 * `load-test-executions` に対する `dynamodb:PutItem` / `dynamodb:UpdateItem`、
 * 自身の関数 ARN に対する `lambda:InvokeFunction`、Bedrock モデル ARN 1 件に対する
 * `bedrock:InvokeModel`、Vector_Collection に対する `aoss:APIAccessAll`
 * （およびデータアクセスポリシーの `WriteDocument` **のみ**。`ReadDocument` と
 * `DescribeIndex` は要求しない、要件 3.12 / 17.7）。
 *
 * ## 関数ローカルの `package.json`
 *
 * OpenSearch への書き込みに `@opensearch-project/opensearch` と
 * `@aws-sdk/credential-provider-node` を使うため、本ディレクトリに `package.json` を置く
 * （`vector-search-aoss` と同じ方式・同じバージョン指定）。esbuild は entry の
 * ディレクトリから node_modules を解決するため、合成前に本ディレクトリで
 * `npm install` が実行されている必要がある。
 *
 * 要件: 1.3, 1.4, 1.7, 2.7, 3.2, 3.4, 3.5, 3.6, 3.8, 3.9, 3.10, 3.11, 3.12, 3.18,
 *       4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.8, 4.9, 6.8, 14.1, 17.7
 * 設計: Embedding_Batch_Job / phase = "copy": Good_Table から Vector_Table への複製 /
 *       phase = "embed": 日英 2 本の埋め込み生成と両バックエンド書き込み / 検証結果の計上 /
 *       倍増したワークロードへの対応
 */

import {
  BatchWriteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
  type WriteRequest,
} from '@aws-sdk/client-dynamodb';
import { InvocationType, InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

import {
  BATCH_MAX_RETRIES,
  createEmbeddingGenerator,
  resolveEmbeddingDimensions,
  resolveRequestsPerMinute,
  type EmbeddingGenerator,
} from '../shared/vector/embedding-generator';
import {
  EMBEDDING_FIELD_ORDER,
  buildEmbeddingText,
  truncateForEmbedding,
} from '../shared/vector/embedding-text';
import {
  classifyError,
  httpStatusForErrorCode,
  sanitizeMessage,
  type VectorErrorResponse,
} from '../shared/vector/errors';
import {
  VECTOR_LANGUAGES,
  resolveVectorField,
  type VectorLanguage,
} from '../shared/vector/language';
import { deriveSkuMetadata, type SkuMetadataFields } from '../shared/vector/sku-metadata';
import { DiverseFailureLedger } from '../shared/vector/failure-ledger';
import { shouldSkipEmbedding } from '../shared/vector/skip-decision';
import {
  resolveVerificationRunStatus,
  sumVerificationCounts,
  summarizeVerification,
  type VerificationCounts,
  type VerificationMismatchKey,
  type VerificationRunStatus,
  type VerificationSummary,
} from '../shared/vector/verification-summary';
import type { Warehouse } from '../shared/types';

// ============================================================
// 定数
// ============================================================

/** バッチのフェーズ。`copy` は本ファイル、`embed` はタスク 8.6 */
export type VectorBatchPhase = 'copy' | 'embed';

/** 許容するフェーズの一覧。入力エラーで許容値を提示する際の唯一の出典 */
export const VECTOR_BATCH_PHASES = ['copy', 'embed'] as const satisfies readonly VectorBatchPhase[];

/** 複製元の倉庫。Good_Table の GSI `byWarehouse` をこの順で Query する */
export const WAREHOUSES = ['WH-TOKYO', 'WH-OSAKA', 'WH-FUKUOKA'] as const satisfies readonly Warehouse[];

/** Good_Table の倉庫別 GSI 名。Vector_Table 側には GSI が存在しない（要件 1.2） */
const GOOD_TABLE_WAREHOUSE_INDEX = 'byWarehouse';

/** Vector_Table が保持すべきレコード件数（要件 1.3 / 1.7）。5,000 SKU × 3 倉庫 */
export const EXPECTED_VECTOR_RECORD_COUNT = 15_000;

/**
 * Good_Table から Vector_Table へ**値をそのまま転記する**非キー属性（要件 1.3 / 2.7）。
 *
 * `AttributeValue` を分解せずに転記するため、値が変換で揺れる余地がない。
 * `lastUpdated` は Vector_Table のアイテム定義（設計「DynamoDB アイテム」）に含まれないため転記しない。
 */
export const COPIED_ATTRIBUTES = [
  'itemName',
  'quantity',
  'lotNumber',
  'location',
  'unitPrice',
] as const;

/** `BatchWriteItem` の 1 リクエストあたりの上限件数 */
const WRITE_BATCH_SIZE = 25;

/** 同時に投入する `BatchWriteItem` の本数（既存 `seed` と同じ方式） */
const WRITE_CONCURRENCY = 4;

/** `UnprocessedItems` とスロットリングの再試行上限 */
const MAX_WRITE_RETRIES = 8;

/** 書き込み再試行の基準待機時間（ms）。試行ごとに 2 倍へ増やす */
const WRITE_BASE_DELAY_MS = 200;

/** 進捗を永続化する間隔（複製レコード件数） */
const PROGRESS_CHECKPOINT_RECORDS = 2_500;

/**
 * 自己再帰 invoke に切り替える残り実行時間（ms）。
 * 設計「倍増したワークロードへの対応」の 120 秒を `embed` と共有する。
 */
const SELF_RECURSION_REMAINING_MS = 120_000;

// ---- phase = "embed" の定数 ----------------------------------------------

/**
 * 対象 SKU 一覧を得るために絞り込む倉庫（設計「phase = "embed"」）。
 *
 * Vector_Table は (itemId, warehouseId) を主キーに持ち GSI を持たないため、
 * 1 倉庫に絞った `Scan` が itemId の一意集合を得る唯一の経路である。
 * この倉庫のレコードは同時に**スキップ判定と表示用メタデータの代表行**でもある。
 */
export const SKU_LIST_WAREHOUSE = 'WH-TOKYO' as const satisfies Warehouse;

/**
 * 処理対象の一意 itemId 件数（要件 3.4）。
 *
 * 件数ゲート（要件 1.7）が 15,000 件を保証した後であれば、1 SKU が 3 倉庫に
 * 存在するため一意 itemId は必ずこの件数になる。残件数（要件 4.4）の分母に使う。
 */
export const EXPECTED_SKU_COUNT = EXPECTED_VECTOR_RECORD_COUNT / WAREHOUSES.length;

/** 進捗を永続化する間隔（SKU 件数、要件 4.4） */
const EMBED_PROGRESS_CHECKPOINT_SKUS = 100;

/**
 * 1 回の `Scan` で読むレコード件数の上限。
 *
 * フィルタ適用前の読み取り件数を抑え、1 ページの処理時間を約 100 SKU 分
 * （= チェックポイント間隔）に揃える。3 倉庫のうち 1 倉庫だけが一致するため、
 * 1 ページあたりの対象 SKU はおよそ `SKU_LIST_SCAN_LIMIT / 3` 件になる。
 */
const SKU_LIST_SCAN_LIMIT = 300;

/** 両バックエンドへの書き込みの再試行上限（要件 3.10 の「3 回の再試行」） */
const BACKEND_WRITE_MAX_RETRIES = 3;

/**
 * 応答と進捗レコードに載せる失敗一覧の上限件数。
 *
 * 失敗**件数**は上限なく数える（要件 3.8 / 4.6）。一覧の方は自己再帰 invoke の
 * ペイロード上限（256 KB）と進捗レコードのアイテム上限（400 KB）に収める必要があるため
 * 上限を設け、超過分は `failuresTruncated` で明示する。1 件は説明文（500 文字以内）を
 * 含めて最大 1 KB 程度であり、100 件で約 100 KB。継続起動のカーソルが載る
 * ペイロードに対して十分な余裕を残す。
 *
 * **どの 100 件を残すかは `DiverseFailureLedger` が決める。**到着順に詰めて満杯で
 * 打ち切ると、大量に出る 1 種類が枠を食い潰して少数派の種類を押し出す。タスク 13.11 の
 * 実測では保持された 100 件がすべて `VERIFICATION` / `ACCESS_DENIED_IAM` になり、
 * 同時に起きていた 3 件の生成失敗の itemId が一覧から消えていた（要件 3.10 の
 * 「対象 itemId を実行結果に含める」が満たされない状態）。
 */
const MAX_REPORTED_FAILURES = 100;

/**
 * 自己再帰 invoke の回数上限（暴走防止）。
 *
 * 設計の見積は 7 回以上（5,000 ÷ 780）であり、既定レートでの完走に必要な回数は
 * 10 回程度に収まる。上限を超えた場合は再帰を止めて失敗として返す。
 * レートを下限（1 リクエスト/分）に設定すると完走できないが、
 * 自己 invoke が無限に続く事故の方が影響が大きいため上限を優先する。
 */
const MAX_EMBED_INVOCATIONS = 60;

/** OpenSearch のインデックス名。マッピングは `amplify/custom/vector-collection.ts` が定義する */
const DEFAULT_VECTOR_INDEX_NAME = 'inventory-vector';

/**
 * 補償（要件 3.10）で `REMOVE` する属性。
 *
 * 巻き戻しは**両言語のベクトル属性をまとめて**行う（設計「エラー処理と補償」）。
 * 片方の言語だけを残すと、モデル・次元数のメタデータと実際に格納されている
 * ベクトルの組み合わせが崩れ、スキップ判定（要件 4.5）が誤った判断をするためである。
 */
const EMBEDDING_ATTRIBUTES_TO_REMOVE = [
  'embeddingJa',
  'embeddingEn',
  'embeddingModel',
  'embeddingDimensions',
  'embeddingUpdatedAt',
] as const;

/**
 * OpenSearch ドキュメントのメタデータフィールド名の語幹。
 *
 * `amplify/custom/vector-collection.ts` の `METADATA_FIELD_STEMS` と同一の対応であり、
 * `brewingRecommendation` だけがドキュメント側で `brewing` になる。
 * あちらは CDK（`aws-cdk-lib` 依存）のモジュールであり Lambda バンドルへ持ち込めないため、
 * 対応表を再掲する。`keyof SkuMetadataFields` を鍵にしているので、
 * メタデータ側の 9 項目が増減すれば本定義がコンパイルエラーになる。
 */
const OPENSEARCH_METADATA_FIELD_STEMS: Record<keyof SkuMetadataFields, string> = {
  productName: 'productName',
  category: 'category',
  origin: 'origin',
  roastLevel: 'roastLevel',
  flavorNotes: 'flavorNotes',
  body: 'body',
  acidity: 'acidity',
  description: 'description',
  brewingRecommendation: 'brewing',
};

/** CORS ヘッダー共通定義（既存ハンドラと同一の方式・同一のヘッダー構成） */
const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/** 応答の説明文をサニタイズする際の上限文字数（`errors.ts` の応答と揃える） */
const MAX_MESSAGE_LENGTH = 500;

// ============================================================
// 応答型
// ============================================================

/** 倉庫ごとの複製結果。`readCount` は当該倉庫の一意 itemId 件数と等しい（GSI の SK が itemId のため） */
export interface CopyWarehouseSummary {
  readCount: number;
  writtenCount: number;
  /** `UnprocessedItems` が再試行上限まで残った件数。0 以外なら件数ゲートが落ちる */
  unprocessedCount: number;
  /** itemId を取り出せず複製をスキップしたレコード件数 */
  skippedCount: number;
}

/** `phase = "copy"` の集計。継続起動をまたいだ累計値を持つ */
export interface CopyPhaseSummary {
  phase: 'copy';
  executionId: string;
  /** この起動が継続起動（自己再帰 invoke 由来）であるか */
  continuation: boolean;
  /** この executionId で起動した回数（1 始まり） */
  invocationCount: number;
  readRecordCount: number;
  writtenRecordCount: number;
  unprocessedRecordCount: number;
  skippedRecordCount: number;
  perWarehouse: Record<string, CopyWarehouseSummary>;
  /** 経過時間（秒、小数第 1 位）。この起動のみの値 */
  elapsedSeconds: number;
}

/** 件数ゲートの結果（要件 1.7）。期待件数と実件数の両方を必ず持つ */
export interface RecordCountCheck {
  expectedRecordCount: number;
  actualRecordCount: number;
  matched: boolean;
}

/** 複製完了（件数ゲート通過）。`phase = "embed"` へ進んでよい状態 */
export interface CopyCompletedBody extends CopyPhaseSummary {
  status: 'COMPLETED';
  recordCountCheck: RecordCountCheck;
}

/** 残り実行時間の枯渇により自己再帰 invoke へ引き継いだ状態 */
export interface CopyContinuedBody extends CopyPhaseSummary {
  status: 'CONTINUED';
  /** 引き継いだ位置。倉庫の添字と再開キーの有無のみを載せる */
  resumeFrom: { warehouseIndex: number; hasExclusiveStartKey: boolean };
}

// ---- phase = "embed" の応答型 --------------------------------------------

/** 失敗した (itemId, language) 組の段階。要件 3.10 / 3.11 / 4.3 / 4.7 の記録に使う */
export type EmbedFailureStage =
  /** 埋め込み生成の失敗（要件 3.11 / 4.3 / 4.7） */
  | 'GENERATION'
  /** DynamoDB への書き込み失敗（要件 3.10） */
  | 'DYNAMODB_WRITE'
  /** OpenSearch への書き込み失敗（要件 3.10） */
  | 'OPENSEARCH_WRITE'
  /** 補償そのものの失敗。手動での後始末が必要な状態（要件 3.10） */
  | 'COMPENSATION'
  /** 書き込み後の読み出し検証の不一致（要件 3.6） */
  | 'VERIFICATION';

/** 失敗した (itemId, language) 組 1 件（要件 3.8 / 3.10 / 4.3 / 4.6） */
export interface EmbedFailure {
  itemId: string;
  language: VectorLanguage;
  stage: EmbedFailureStage;
  /** `errors.ts` の `VectorErrorCode`、または検証固有のコード */
  errorCode: string;
  /** サニタイズ済みの説明文（500 文字以内、ARN・資格情報・スタックトレースを含まない） */
  message: string;
  retryable: boolean;
}

/**
 * 言語ごとの集計（要件 3.8 / 14.1）。合計は同じ形の 1 件として別に持つ。
 *
 * 単位は「(itemId, language) の組」である（要件 4.4）。1 SKU が 2 組を生む。
 */
export interface EmbedLanguageSummary {
  /** 処理対象として評価した組の件数（スキップを含む） */
  processedPairs: number;
  /** 埋め込みを生成した組の件数 */
  generatedCount: number;
  /** スキップ判定で生成を省いた組の件数（要件 4.5） */
  skippedCount: number;
  /** 両バックエンドへの格納が完了した組の件数 */
  storedCount: number;
  /** 失敗した組の件数（要件 3.8 / 4.6） */
  failedCount: number;
  /** 50,000 文字超過による切り詰めが発生した組の件数（要件 3.7） */
  truncatedCount: number;
  /** Bedrock の呼び出し回数（再試行を含む、要件 3.8 / 14.1） */
  bedrockCalls: number;
  /** 再試行した回数（要件 4.2） */
  bedrockRetries: number;
  /** 失敗した Bedrock 呼び出し回数（再試行分を含む、要件 14.1） */
  bedrockFailedCalls: number;
  /** 入力トークン数の合計（要件 14.1） */
  inputTokenCount: number;
  /**
   * 読み出し検証の対象になった組の件数（要件 3.6）。
   *
   * **この起動で Vector_Table へ書き込んだ組だけを数える。**検証は「書き込んだ値」との
   * 突き合わせであり、スキップした組にはこの起動での書き込み値が存在しない。
   * スキップした組（および Vector_Collection 側）は Verification_Run が担う（要件 3.15）。
   */
  verifiedTargetCount: number;
  /** 読み出し検証で一致した組の件数（要件 3.6） */
  verifiedMatchedCount: number;
  /** 読み出し検証で不一致だった組の件数（要件 3.6） */
  verifiedMismatchedCount: number;
  /** 読み出し検証で Vector_Table 側にベクトルが存在しなかった組の件数（要件 3.17） */
  verifiedMissingCount: number;
  /** 残件数（要件 4.4）。`EXPECTED_SKU_COUNT` から処理済み件数を引いた値 */
  remainingCount: number;
}

/**
 * Vector_Collection 側の検証状態（要件 3.12 / 3.13）。
 *
 * **バッチは Vector_Collection を読まない。**バッチロールの権限は
 * `aoss:WriteDocument` のみであり（要件 17.7）、読み出すと全件 `ACCESS_DENIED_IAM` になる。
 * したがってバッチが返せる状態は常に `NOT_EXECUTED` であり、合格・不合格は
 * Verification_Run（`POST /vector-search/verify`）の実行結果として別に得る。
 * 3 値を型に持たせているのは、この応答を読む側が「未実施」と「合格」を
 * 区別できるようにするためである。
 */
export interface VectorCollectionVerificationState {
  /** 検証の担当。バッチではなく Verification_Run である */
  verifiedBy: 'VERIFICATION_RUN';
  /** 未実施 / 合格 / 不合格。バッチの応答では常に `NOT_EXECUTED` */
  status: 'NOT_EXECUTED' | 'PASSED' | 'FAILED';
  /** Verification_Run の経路 */
  endpoint: string;
  /** Verification_Run の実行コマンド */
  command: string;
  note: string;
}

/**
 * 検証結果の報告（要件 3.6 / 3.12 / 3.17 / 3.18）。
 *
 * 集計と合否は `verification-summary.ts` の `summarizeVerification()` に委譲する。
 * ハンドラは件数を数えるだけで、判定式を持たない。
 */
export interface EmbedVerificationReport {
  /** Vector_Table 側の読み返し検証。バッチが実施する唯一の検証（要件 3.6） */
  vectorTable: VerificationSummary & {
    /** 実行状態。不合格のとき `COMPLETED` にならない（要件 3.18） */
    status: VerificationRunStatus;
  };
  /** 言語別の集計（要件 3.6 の「言語別」） */
  byLanguage: Record<VectorLanguage, VerificationSummary>;
  /** Vector_Collection 側の検証状態（要件 3.12） */
  vectorCollection: VectorCollectionVerificationState;
}

/** `phase = "embed"` の集計。継続起動をまたいだ累計値を持つ */
export interface EmbedPhaseSummary {
  phase: 'embed';
  executionId: string;
  /** この起動が継続起動（自己再帰 invoke 由来）であるか */
  continuation: boolean;
  /** この executionId で起動した回数（1 始まり） */
  invocationCount: number;
  /** 適用したモデル ID（要件 3.1）。スキップ判定の比較値でもある（要件 4.5） */
  model: string;
  /** 適用した次元数（要件 3.3）。実行中は不変 */
  dimensions: number;
  /** 適用した呼び出しレート（リクエスト/分、要件 4.1） */
  requestsPerMinute: number;
  /** 強制再生成が有効か（要件 4.8） */
  forceRegenerate: boolean;
  /** 走査した SKU 件数（継続起動をまたいだ累計） */
  processedSkuCount: number;
  /** 処理対象の SKU 件数（要件 3.4 の 5,000） */
  expectedSkuCount: number;
  /** 言語別の集計（要件 3.8 / 14.1） */
  perLanguage: Record<VectorLanguage, EmbedLanguageSummary>;
  /** 両言語の合計（要件 3.8 / 14.1） */
  total: EmbedLanguageSummary;
  /**
   * 失敗した (itemId, language) 組の一覧（要件 4.6）。上限 `MAX_REPORTED_FAILURES` 件。
   *
   * 保持枠は `(stage, errorCode)` の種類間で公平に配分される（`failure-ledger.ts`）。
   * 単一の種類が枠を占有して他の種類を押し出さない。
   */
  failures: EmbedFailure[];
  /** 失敗一覧が上限で打ち切られたか。件数そのものは `failedCount` が保持する */
  failuresTruncated: boolean;
  /** 検証結果の報告（要件 3.6 / 3.12 / 3.18） */
  verification: EmbedVerificationReport;
  /** この起動の経過時間（秒、小数第 1 位） */
  elapsedSeconds: number;
  /** 継続起動をまたいだ累計の経過時間（秒、小数第 1 位、要件 3.8 / 14.1） */
  totalElapsedSeconds: number;
}

/** 埋め込み生成完了（全 SKU の走査が終わり、検証も合格した状態） */
export interface EmbedCompletedBody extends EmbedPhaseSummary {
  status: 'COMPLETED';
  /** `embed` の先頭で評価した件数ゲートの結果（初回起動時のみ、要件 1.7） */
  recordCountCheck?: RecordCountCheck;
}

/**
 * 走査は終わったが読み出し検証が合格しなかった状態（要件 3.18）。
 *
 * **`COMPLETED` にしない。**不一致件数と未格納件数の和が 1 以上の場合、書き込みが
 * 済んでいても投入内容の一致が確認できていない。旧実装は `verifiedMismatchedCount` が
 * 1,712 でも `failedCount 0` / `COMPLETED` を返しており、要件 3.6 の検証が
 * 実質的に無効化されていた。
 */
export interface EmbedVerificationFailedBody extends EmbedPhaseSummary {
  status: 'VERIFICATION_FAILED';
  errorCode: 'VERIFICATION_FAILED';
  message: string;
  retryable: true;
  recordCountCheck?: RecordCountCheck;
}

/** 残り実行時間の枯渇により自己再帰 invoke へ引き継いだ状態 */
export interface EmbedContinuedBody extends EmbedPhaseSummary {
  status: 'CONTINUED';
  /** 引き継いだ位置。`nextItemIndex` は次に処理する SKU の 0 起算の添字 */
  resumeFrom: { nextItemIndex: number; hasExclusiveStartKey: boolean };
}

/**
 * バッチのエラー応答。
 *
 * 説明文は `errors.ts` の `sanitizeMessage()` を通した 500 文字以内の文字列であり、
 * ARN・アカウント ID・資格情報・スタックトレースを含まない。下位サービスの失敗は
 * `classifyError()` の分類結果（`errorCode` / `retryable` / `retryAfterSeconds`）を
 * そのまま採用する。件数ゲートと入力検証は本エンドポイント固有のコードを使う。
 */
export interface VectorBatchErrorBody {
  phase: VectorBatchPhase | null;
  status: 'INVALID_REQUEST' | 'RECORD_COUNT_MISMATCH' | 'FAILED' | 'NOT_IMPLEMENTED';
  /** 機械可読コード。`errors.ts` の `VectorErrorCode` または本エンドポイント固有のコード */
  errorCode: string;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  /** 件数ゲートで落ちた場合のみ設定される（要件 1.7） */
  recordCountCheck?: RecordCountCheck;
  /** 途中で失敗した場合の部分集計 */
  summary?: VectorBatchPhaseSummary;
}

/** フェーズ共通の集計。進捗永続化とエラー応答が両フェーズを同じ経路で扱えるようにする */
export type VectorBatchPhaseSummary = CopyPhaseSummary | EmbedPhaseSummary;

export type VectorBatchResultBody =
  | CopyCompletedBody
  | CopyContinuedBody
  | EmbedCompletedBody
  | EmbedContinuedBody
  | EmbedVerificationFailedBody
  | VectorBatchErrorBody;

// ============================================================
// イベント型
// ============================================================

/** 複製の再開位置。自己再帰 invoke のペイロードに載せる */
export interface CopyCursor {
  /** `WAREHOUSES` の添字。この倉庫から再開する */
  warehouseIndex: number;
  /** 倉庫内の再開キー。倉庫の先頭から読む場合は undefined */
  exclusiveStartKey?: Record<string, AttributeValue>;
  /** 継続起動をまたいだ累計 */
  perWarehouse: Record<string, CopyWarehouseSummary>;
  invocationCount: number;
}

/**
 * 埋め込み生成の再開位置（設計「倍増したワークロードへの対応」）。
 *
 * SKU 一覧そのものは載せない。5,000 件の itemId は約 200 KB になり、
 * 非同期 invoke のペイロード上限（256 KB）に対して余裕がないためである。
 * 代わりに Vector_Table の `Scan` の再開キーを持ち、各起動が続きから列挙する。
 * レート制御のトークンバケット状態も持ち越さず、各起動の先頭で初期化する。
 */
export interface EmbedCursor {
  /** 次に処理する SKU の 0 起算の添字（= これまでに処理した SKU 件数） */
  nextItemIndex: number;
  /** SKU 一覧走査（`warehouseId = WH-TOKYO` の `Scan`）の再開キー */
  exclusiveStartKey?: Record<string, AttributeValue>;
  /** 継続起動をまたいだ言語別の累計 */
  perLanguage: Record<VectorLanguage, EmbedLanguageSummary>;
  /** 失敗した組の一覧（上限 `MAX_REPORTED_FAILURES` 件） */
  failures: EmbedFailure[];
  /** 失敗一覧が上限で打ち切られたか */
  failuresTruncated: boolean;
  invocationCount: number;
  /** 継続起動をまたいだ経過時間の累計（秒） */
  elapsedSecondsBefore: number;
  /** リクエストで指定された呼び出しレート。継続起動でも同じ値を使う（要件 4.1） */
  requestsPerMinute?: number;
  /** 強制再生成（要件 4.8）。継続起動でも同じ値を使う */
  forceRegenerate: boolean;
  /**
   * 件数ゲート（要件 1.7）の結果。初回起動で評価した値を引き継ぐ。
   * 継続起動で再評価しないのは、全件 `Scan` を毎回繰り返すと読み取り量が
   * 起動回数分に膨らむためである（ゲートの判定対象は起動間で変化しない）。
   */
  recordCountCheck?: RecordCountCheck;
}

/** 自己再帰 invoke のペイロード */
export interface VectorBatchContinuationEvent {
  isContinuation: true;
  phase: VectorBatchPhase;
  executionId: string;
  /** `phase = "copy"` の再開位置 */
  copyCursor?: CopyCursor;
  /** `phase = "embed"` の再開位置 */
  embedCursor?: EmbedCursor;
}

/** API Gateway 経由の起動と自己再帰 invoke の双方を受ける */
export type VectorBatchEvent = APIGatewayProxyEvent | VectorBatchContinuationEvent;

// ============================================================
// 実行環境で再利用する資源
// ============================================================

const dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION });
const lambda = new LambdaClient({ region: process.env.AWS_REGION });

// ============================================================
// 入力の取り出し（全域関数）
// ============================================================

/** 値が自己再帰 invoke のペイロードか判定する */
export function isContinuationEvent(event: unknown): event is VectorBatchContinuationEvent {
  if (typeof event !== 'object' || event === null) return false;
  const record = event as Record<string, unknown>;
  return record.isContinuation === true && isVectorBatchPhase(record.phase);
}

/** 値が許容フェーズか判定する */
export function isVectorBatchPhase(value: unknown): value is VectorBatchPhase {
  return value === 'copy' || value === 'embed';
}

/**
 * API Gateway プロキシ統合の本文からフェーズを取り出す。
 *
 * Base64 エンコードされた本文にも対応する。本文が空、または JSON として解釈できない場合は
 * `undefined` を返し、呼び出し側が入力エラーにする。**既定値を持たない**のは、`embed`
 * フェーズが 10,000 回の Bedrock 呼び出しを伴う課金操作であり、暗黙の既定で起動させないためである。
 */
export function parseBatchRequestPhase(
  event: Pick<APIGatewayProxyEvent, 'body' | 'isBase64Encoded'>
): unknown {
  return parseBatchRequestPayload(event)?.phase;
}

/**
 * API Gateway プロキシ統合の本文をレコードとして取り出す。
 *
 * `phase` 以外の任意パラメータ（`forceRegenerate` / `requestsPerMinute` / `executionId`）も
 * ここから読む。本文の解釈経路をこの 1 か所に閉じることで、フェーズの判定と
 * オプションの判定が別の解釈規則を持つことがない。
 */
export function parseBatchRequestPayload(
  event: Pick<APIGatewayProxyEvent, 'body' | 'isBase64Encoded'>
): Record<string, unknown> | undefined {
  if (typeof event.body !== 'string' || event.body.length === 0) return undefined;

  let text = event.body;
  if (event.isBase64Encoded === true) {
    try {
      text = Buffer.from(event.body, 'base64').toString('utf8');
    } catch {
      return undefined;
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined;
  return parsed as Record<string, unknown>;
}

/** 必須の環境変数を取り出す。未設定・空白のみは `undefined` */
function resolveRequiredEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

// ============================================================
// 応答の組み立て
// ============================================================

function successResponse(body: VectorBatchResultBody, statusCode = 200): APIGatewayProxyResult {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

/**
 * 失敗応答。`VectorBatchErrorBody` に加えて、走査は終わったが検証が不合格だった
 * `EmbedVerificationFailedBody` も通す（要件 3.18）。後者は集計値を丸ごと返すため
 * エラー専用の型に収まらない。
 */
function errorResponse(body: VectorBatchResultBody, statusCode: number): APIGatewayProxyResult {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

/** 入力エラー（400）。許容値を説明文に含める */
function invalidRequest(phase: VectorBatchPhase | null, detail: string): VectorBatchErrorBody {
  return {
    phase,
    status: 'INVALID_REQUEST',
    errorCode: 'INVALID_REQUEST',
    message: sanitizeMessage(detail, MAX_MESSAGE_LENGTH),
    retryable: false,
  };
}

/**
 * 下位サービスの失敗（分類は `errors.ts` に委ねる）。
 * エラーコード・再試行可否・推奨待機秒数・サニタイズ済み説明文をそのまま採用する。
 */
function failed(
  phase: VectorBatchPhase,
  error: unknown,
  summary?: VectorBatchPhaseSummary
): { body: VectorBatchErrorBody; statusCode: number } {
  // 段階は `EMBEDDING`。本バッチの失敗は「埋め込み投入経路の失敗」として分類する
  const classified = classifyError(error, 'EMBEDDING');
  return {
    body: {
      phase,
      status: 'FAILED',
      errorCode: classified.errorCode,
      message: classified.message,
      retryable: classified.retryable,
      ...(classified.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: classified.retryAfterSeconds }),
      ...(summary === undefined ? {} : { summary }),
    },
    statusCode: httpStatusForErrorCode(classified.errorCode),
  };
}

// ============================================================
// 共有ユーティリティ
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 残り実行時間（ms）。`context` が無い場合は打ち切らない（十分な残時間として扱う） */
function remainingTimeMs(context: Context | undefined): number {
  if (context === undefined || typeof context.getRemainingTimeInMillis !== 'function') {
    return Number.POSITIVE_INFINITY;
  }
  try {
    return context.getRemainingTimeInMillis();
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function elapsedSecondsSince(startedAtMs: number): number {
  return Math.round(((Date.now() - startedAtMs) / 1000) * 10) / 10;
}

function emptyWarehouseSummary(): CopyWarehouseSummary {
  return { readCount: 0, writtenCount: 0, unprocessedCount: 0, skippedCount: 0 };
}

function initialPerWarehouse(): Record<string, CopyWarehouseSummary> {
  return Object.fromEntries(WAREHOUSES.map((warehouse) => [warehouse, emptyWarehouseSummary()]));
}

function totalOf(
  perWarehouse: Record<string, CopyWarehouseSummary>,
  key: keyof CopyWarehouseSummary
): number {
  return Object.values(perWarehouse).reduce((sum, entry) => sum + entry[key], 0);
}

// ============================================================
// 進捗永続化（`load-test-executions`）
// ============================================================

/**
 * 進捗は `EXECUTIONS_TABLE_NAME` が設定されている場合のみ記録する。
 *
 * `copy` フェーズは通常 1 起動で完了するため、記録は自己再帰 invoke の可観測性のためにある。
 * 記録の失敗で複製を止めない（複製そのものは冪等な `PutItem` の集合であり、
 * 進捗記録が欠けても件数ゲートが最終的な正しさを保証する）。
 * `phase = "embed"` は要件 4.4 / 4.9 により**記録が必須**であるため、
 * `runEmbedPhase()` は未設定を入力エラーとして扱う（Bedrock を 1 度も呼ばない）。
 */
async function persistProgress(
  executionId: string,
  phase: VectorBatchPhase,
  status: string,
  summary: VectorBatchPhaseSummary,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const tableName = resolveRequiredEnv('EXECUTIONS_TABLE_NAME');
  if (tableName === undefined) return;

  try {
    await dynamodb.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { executionId: { S: executionId } },
        UpdateExpression:
          'SET #phase = :phase, #status = :status, #progress = :progress, #updatedAt = :updatedAt',
        ExpressionAttributeNames: {
          '#phase': 'phase',
          '#status': 'status',
          '#progress': 'progress',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: marshall(
          {
            ':phase': phase,
            ':status': status,
            ':progress': { ...summary, ...extra },
            ':updatedAt': new Date().toISOString(),
          },
          { removeUndefinedValues: true }
        ),
      })
    );
  } catch (error: unknown) {
    console.warn('vector-embed-batch: progress persistence failed (continuing):', error);
  }
}

/** 初回起動時に実行レコードを作る。存在しても上書きせずに続行する */
async function initializeExecutionRecord(executionId: string, phase: VectorBatchPhase): Promise<void> {
  const tableName = resolveRequiredEnv('EXECUTIONS_TABLE_NAME');
  if (tableName === undefined) {
    console.warn(
      'vector-embed-batch: EXECUTIONS_TABLE_NAME is not configured. Progress will not be persisted.'
    );
    return;
  }

  try {
    await dynamodb.send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshall({
          executionId,
          phase,
          status: 'RUNNING',
          startedAt: new Date().toISOString(),
        }),
        ConditionExpression: 'attribute_not_exists(executionId)',
      })
    );
  } catch (error: unknown) {
    const name = (error as { name?: string }).name;
    if (name !== 'ConditionalCheckFailedException') {
      console.warn('vector-embed-batch: execution record initialization failed (continuing):', error);
    }
  }
}

// ============================================================
// Vector_Table への書き込み
// ============================================================

/**
 * `BatchWriteItem` を実行し、`UnprocessedItems` とスロットリングを再試行する（既存 `seed` と同方式）。
 *
 * 戻り値は書き込めた件数と、再試行上限まで残った未処理件数。例外は投げずに未処理件数として返すため、
 * 部分的な失敗は件数ゲート（要件 1.7）で確実に検出される。
 */
async function batchWriteWithRetry(
  tableName: string,
  requests: WriteRequest[]
): Promise<{ writtenCount: number; unprocessedCount: number }> {
  let pending: WriteRequest[] = requests;
  let writtenCount = 0;

  for (let attempt = 0; attempt <= MAX_WRITE_RETRIES && pending.length > 0; attempt++) {
    if (attempt > 0) {
      await sleep(WRITE_BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 100);
    }

    try {
      const result = await dynamodb.send(
        new BatchWriteItemCommand({ RequestItems: { [tableName]: pending } })
      );
      const unprocessed = (result.UnprocessedItems?.[tableName] ?? []) as WriteRequest[];
      writtenCount += pending.length - unprocessed.length;
      pending = unprocessed;
    } catch (error: unknown) {
      const name = (error as { name?: string }).name;
      if (
        name === 'ProvisionedThroughputExceededException' ||
        name === 'ThrottlingException' ||
        name === 'RequestLimitExceeded'
      ) {
        console.warn(
          `vector-embed-batch: throttled on batch write attempt ${attempt + 1}/${MAX_WRITE_RETRIES + 1}`
        );
        continue;
      }
      throw error;
    }
  }

  if (pending.length > 0) {
    console.error(
      `vector-embed-batch: ${pending.length} items remain unprocessed after ${MAX_WRITE_RETRIES} retries.`
    );
  }

  return { writtenCount, unprocessedCount: pending.length };
}

/** 25 件単位に切って最大 `WRITE_CONCURRENCY` 本を同時投入する */
async function writeToVectorTable(
  tableName: string,
  requests: WriteRequest[]
): Promise<{ writtenCount: number; unprocessedCount: number }> {
  let writtenCount = 0;
  let unprocessedCount = 0;

  for (let offset = 0; offset < requests.length; offset += WRITE_BATCH_SIZE * WRITE_CONCURRENCY) {
    const inFlight: Promise<{ writtenCount: number; unprocessedCount: number }>[] = [];
    for (let slot = 0; slot < WRITE_CONCURRENCY; slot++) {
      const start = offset + slot * WRITE_BATCH_SIZE;
      if (start >= requests.length) break;
      inFlight.push(batchWriteWithRetry(tableName, requests.slice(start, start + WRITE_BATCH_SIZE)));
    }

    for (const result of await Promise.all(inFlight)) {
      writtenCount += result.writtenCount;
      unprocessedCount += result.unprocessedCount;
    }
  }

  return { writtenCount, unprocessedCount };
}

/**
 * Good_Table のレコード 1 件から Vector_Table へ書き込む項目を組み立てる（純関数）。
 *
 * 既存 6 属性は読み取った `AttributeValue` をそのまま転記し、追加するのは
 * `metaJa` / `metaEn` の 2 つの Map 属性だけである（要件 1.3 / 2.7、Property 5）。
 * itemId を取り出せない場合はキーを組めないため `undefined` を返す（呼び出し側がスキップとして数える）。
 */
export function buildVectorTableItem(
  source: Record<string, AttributeValue>,
  warehouseId: string
): Record<string, AttributeValue> | undefined {
  const itemId = source.itemId?.S;
  if (typeof itemId !== 'string' || itemId.length === 0) return undefined;

  const item: Record<string, AttributeValue> = {
    itemId: { S: itemId },
    warehouseId: { S: warehouseId },
  };

  for (const name of COPIED_ATTRIBUTES) {
    const value = source[name];
    if (value !== undefined) item[name] = value;
  }

  // itemName は日本語商品名として `deriveSkuMetadata` の入力にもなる（要件 2.3）
  const metadata = deriveSkuMetadata(itemId, source.itemName?.S ?? '');
  item.metaJa = { M: marshall(metadata.ja) };
  item.metaEn = { M: marshall(metadata.en) };

  return item;
}

// ============================================================
// 件数ゲート（要件 1.7）
// ============================================================

/**
 * Vector_Table の実レコード件数を数える。
 *
 * `DescribeTable` の `ItemCount` は約 6 時間周期の更新であり複製直後の判定に使えないため、
 * `Select: 'COUNT'` の `Scan` を全ページ走査する。ベクトル属性が未書き込みの時点であり
 * 1 レコード約 1.2 KB なので、読み取り量は約 18 MB に収まる。
 */
async function countVectorTableRecords(tableName: string): Promise<number> {
  let count = 0;
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const page = await dynamodb.send(
      new ScanCommand({ TableName: tableName, Select: 'COUNT', ExclusiveStartKey: lastKey })
    );
    count += page.Count ?? 0;
    lastKey = page.LastEvaluatedKey;
  } while (lastKey !== undefined);

  return count;
}

/**
 * 件数ゲートの応答（要件 1.7）。
 *
 * **期待件数と実件数の両方**を構造化フィールドと説明文の双方に載せる。
 * このゲートを通らない限り `phase = "embed"` へ進まない。`embed` を直接起動した
 * 場合も先頭で同じゲートを評価し、不一致なら Bedrock を 1 度も呼ばずに返す。
 */
function recordCountMismatch(
  check: RecordCountCheck,
  summary: VectorBatchPhaseSummary,
  phase: VectorBatchPhase = 'copy'
): VectorBatchErrorBody {
  return {
    phase,
    status: 'RECORD_COUNT_MISMATCH',
    errorCode: 'RECORD_COUNT_MISMATCH',
    message: sanitizeMessage(
      `Vector_Table のレコード件数が期待値と一致しないため、埋め込み生成へ進みません。` +
        `期待件数: ${check.expectedRecordCount} 件、実際の件数: ${check.actualRecordCount} 件。`,
      MAX_MESSAGE_LENGTH
    ),
    retryable: false,
    recordCountCheck: check,
    summary,
  };
}

// ============================================================
// phase = "copy"
// ============================================================

/**
 * Good_Table から Vector_Table へ 15,000 レコードを複製する。
 *
 * 1. GSI `byWarehouse` を warehouseId ごとに `Query` して読む（Good_Table への書き込みは一切行わない）
 * 2. 各レコードに `deriveSkuMetadata()` の結果を `metaJa` / `metaEn` として付与する
 * 3. `BatchWriteItem`（25 件単位）で Vector_Table へ `PutItem` する（ベクトル属性は持たない）
 * 4. 複製後に件数を数え、15,000 件でなければ埋め込み生成へ進まずエラーを返す
 */
async function runCopyPhase(
  executionId: string,
  cursor: CopyCursor,
  context: Context | undefined,
  isContinuation: boolean
): Promise<{ body: VectorBatchResultBody; statusCode: number }> {
  const startedAtMs = Date.now();

  const goodTableName = resolveRequiredEnv('GOOD_TABLE_NAME');
  const vectorTableName = resolveRequiredEnv('VECTOR_TABLE_NAME');

  if (goodTableName === undefined || vectorTableName === undefined) {
    return {
      body: invalidRequest(
        'copy',
        '環境変数 GOOD_TABLE_NAME と VECTOR_TABLE_NAME の両方を設定してください。'
      ),
      statusCode: 400,
    };
  }

  const perWarehouse: Record<string, CopyWarehouseSummary> = {
    ...initialPerWarehouse(),
    ...cursor.perWarehouse,
  };

  const buildSummary = (): CopyPhaseSummary => ({
    phase: 'copy',
    executionId,
    continuation: isContinuation,
    invocationCount: cursor.invocationCount,
    readRecordCount: totalOf(perWarehouse, 'readCount'),
    writtenRecordCount: totalOf(perWarehouse, 'writtenCount'),
    unprocessedRecordCount: totalOf(perWarehouse, 'unprocessedCount'),
    skippedRecordCount: totalOf(perWarehouse, 'skippedCount'),
    perWarehouse,
    elapsedSeconds: elapsedSecondsSince(startedAtMs),
  });

  let recordsSinceCheckpoint = 0;

  try {
    for (
      let warehouseIndex = Math.max(0, cursor.warehouseIndex);
      warehouseIndex < WAREHOUSES.length;
      warehouseIndex++
    ) {
      const warehouseId = WAREHOUSES[warehouseIndex];
      const summary = perWarehouse[warehouseId] ?? emptyWarehouseSummary();
      perWarehouse[warehouseId] = summary;

      // 再開キーは再開対象の倉庫にのみ適用する
      let lastKey =
        warehouseIndex === cursor.warehouseIndex ? cursor.exclusiveStartKey : undefined;

      do {
        // Good_Table に対する唯一の操作。読み取り専用（要件 1.4 / 17.10）
        const page = await dynamodb.send(
          new QueryCommand({
            TableName: goodTableName,
            IndexName: GOOD_TABLE_WAREHOUSE_INDEX,
            KeyConditionExpression: '#pk = :warehouseId',
            ExpressionAttributeNames: {
              '#pk': 'warehouseId',
              '#itemId': 'itemId',
              '#itemName': 'itemName',
              '#quantity': 'quantity',
              '#lotNumber': 'lotNumber',
              '#location': 'location',
              '#unitPrice': 'unitPrice',
            },
            ExpressionAttributeValues: { ':warehouseId': { S: warehouseId } },
            ProjectionExpression:
              '#itemId, #itemName, #quantity, #lotNumber, #location, #unitPrice',
            ExclusiveStartKey: lastKey,
          })
        );

        const items = page.Items ?? [];
        summary.readCount += items.length;

        const requests: WriteRequest[] = [];
        for (const source of items) {
          const item = buildVectorTableItem(source, warehouseId);
          if (item === undefined) {
            summary.skippedCount++;
            continue;
          }
          requests.push({ PutRequest: { Item: item } });
        }

        const written = await writeToVectorTable(vectorTableName, requests);
        summary.writtenCount += written.writtenCount;
        summary.unprocessedCount += written.unprocessedCount;
        recordsSinceCheckpoint += items.length;

        lastKey = page.LastEvaluatedKey;

        if (recordsSinceCheckpoint >= PROGRESS_CHECKPOINT_RECORDS) {
          recordsSinceCheckpoint = 0;
          await persistProgress(executionId, 'copy', 'RUNNING', buildSummary());
        }

        // 残り実行時間が閾値を下回ったら進捗を確定して自身へ引き継ぐ
        if (lastKey !== undefined && remainingTimeMs(context) < SELF_RECURSION_REMAINING_MS) {
          const nextCursor: CopyCursor = {
            warehouseIndex,
            exclusiveStartKey: lastKey,
            perWarehouse,
            invocationCount: cursor.invocationCount + 1,
          };
          const body: CopyContinuedBody = {
            ...buildSummary(),
            status: 'CONTINUED',
            resumeFrom: { warehouseIndex, hasExclusiveStartKey: true },
          };
          await persistProgress(executionId, 'copy', 'CONTINUED', buildSummary(), {
            resumeWarehouseIndex: warehouseIndex,
          });
          await invokeSelf({
            isContinuation: true,
            phase: 'copy',
            executionId,
            copyCursor: nextCursor,
          });
          return { body, statusCode: 202 };
        }
      } while (lastKey !== undefined);

      console.log(
        `vector-embed-batch copy: ${warehouseId} read=${summary.readCount} written=${summary.writtenCount}`
      );
    }
  } catch (error: unknown) {
    console.error('vector-embed-batch copy failed:', error);
    const summary = buildSummary();
    await persistProgress(executionId, 'copy', 'FAILED', summary);
    return failed('copy', error, summary);
  }

  // 件数ゲート（要件 1.7）。ここを通らない限り `phase = "embed"` へ進まない
  let actualRecordCount: number;
  try {
    actualRecordCount = await countVectorTableRecords(vectorTableName);
  } catch (error: unknown) {
    console.error('vector-embed-batch copy record count failed:', error);
    const summary = buildSummary();
    await persistProgress(executionId, 'copy', 'FAILED', summary);
    return failed('copy', error, summary);
  }

  const check: RecordCountCheck = {
    expectedRecordCount: EXPECTED_VECTOR_RECORD_COUNT,
    actualRecordCount,
    matched: actualRecordCount === EXPECTED_VECTOR_RECORD_COUNT,
  };
  const summary = buildSummary();

  if (!check.matched) {
    console.error('vector-embed-batch copy record count mismatch:', check);
    await persistProgress(executionId, 'copy', 'RECORD_COUNT_MISMATCH', summary, {
      recordCountCheck: check,
    });
    return { body: recordCountMismatch(check, summary), statusCode: 409 };
  }

  await persistProgress(executionId, 'copy', 'COMPLETED', summary, { recordCountCheck: check });
  console.log('vector-embed-batch copy completed:', { ...summary, recordCountCheck: check });

  return { body: { ...summary, status: 'COMPLETED', recordCountCheck: check }, statusCode: 200 };
}

// ============================================================
// phase = "embed": OpenSearch クライアント
// ============================================================

/**
 * OpenSearch クライアント。**遅延生成**する。
 *
 * `phase = "copy"` は OpenSearch を使わず、`OPENSEARCH_VECTOR_ENDPOINT` が
 * 未設定のまま起動される。モジュール読み込み時に生成すると複製フェーズが
 * エンドポイント未設定で失敗するため、`embed` の入力検証を通った後に作る。
 *
 * 構成は `amplify/functions/vector-search-aoss/handler.ts` と同一である
 * （`@opensearch-project/opensearch` + `AwsSigv4Signer`、`service: 'aoss'`）。
 */
let openSearchClient: Client | undefined;

function getOpenSearchClient(endpoint: string, region: string): Client {
  openSearchClient ??= new Client({
    ...AwsSigv4Signer({
      region,
      service: 'aoss',
      getCredentials: () => defaultProvider()(),
    }),
    node: endpoint,
  });
  return openSearchClient;
}

/**
 * OpenSearch のドキュメント ID（`amplify/custom/vector-collection.ts` の
 * `buildVectorDocumentId` と同一の規約）。
 *
 * あちらは CDK モジュール（`aws-cdk-lib` 依存）であり Lambda バンドルへ持ち込めないため
 * 同じ 1 行を再掲する。`_id` を (itemId, warehouseId) と 1:1 に対応させることで、
 * 要件 12.1 の行レベル同一性判定と本フェーズの補償（delete）が同じ鍵で行える。
 */
export function buildVectorDocumentId(itemId: string, warehouseId: string): string {
  return `${itemId}#${warehouseId}`;
}

// ============================================================
// phase = "embed": Vector_Table のレコード読み取り
// ============================================================

/** 埋め込み生成と両バックエンド書き込みに必要な 1 レコード分の値 */
export interface VectorTableRecord {
  itemId: string;
  warehouseId: string;
  itemName: string;
  location: string;
  quantity: number;
  unitPrice: number;
  /** `metaJa`（入れ子の Map）。欠落時は undefined */
  metaJa?: SkuMetadataFields;
  /** `metaEn`（入れ子の Map）。欠落時は undefined */
  metaEn?: SkuMetadataFields;
  /** 格納済みのモデル ID。スキップ判定に使う（要件 4.5） */
  embeddingModel?: string;
  /** 格納済みの次元数。スキップ判定に使う（要件 4.5） */
  embeddingDimensions?: number;
  /** 言語ごとのベクトル属性の存在。スキップ判定に使う（要件 4.5） */
  hasEmbedding: Record<VectorLanguage, boolean>;
}

/**
 * SKU 詳細を読むときの属性名バインド。
 *
 * `location` は DynamoDB の予約語であるため、すべての属性を
 * `ExpressionAttributeNames` 経由で参照する（予約語の判定を呼び出し側に委ねない）。
 */
const SKU_DETAIL_ATTRIBUTE_NAMES: Record<string, string> = {
  '#itemId': 'itemId',
  '#warehouseId': 'warehouseId',
  '#itemName': 'itemName',
  '#quantity': 'quantity',
  '#location': 'location',
  '#unitPrice': 'unitPrice',
  '#metaJa': 'metaJa',
  '#metaEn': 'metaEn',
  '#embeddingModel': 'embeddingModel',
  '#embeddingDimensions': 'embeddingDimensions',
  '#embeddingJa': 'embeddingJa',
  '#embeddingEn': 'embeddingEn',
};

/**
 * SKU 詳細の射影。
 *
 * ベクトル属性は**先頭要素だけ**（`embeddingJa[0]`）を射影する。スキップ判定に必要なのは
 * 「当該言語のベクトルが存在するか」だけであり、1,024 次元 2 本（約 15.6 KB）を
 * 5,000 SKU 分転送する理由がない。読み取りキャパシティはアイテム全体のサイズで
 * 決まるため RRU は変わらないが、転送量と JSON パースの時間が桁で変わる。
 */
const SKU_DETAIL_PROJECTION = [
  '#itemId',
  '#warehouseId',
  '#itemName',
  '#quantity',
  '#location',
  '#unitPrice',
  '#metaJa',
  '#metaEn',
  '#embeddingModel',
  '#embeddingDimensions',
  '#embeddingJa[0]',
  '#embeddingEn[0]',
].join(', ');

/** 両言語のベクトル属性名。検証時の射影と補償時の `REMOVE` に使う */
const VECTOR_FIELDS = VECTOR_LANGUAGES.map((language) => resolveVectorField(language));

/** `AttributeValue` から文字列を取り出す。欠損は空文字 */
function readString(value: AttributeValue | undefined): string {
  return typeof value?.S === 'string' ? value.S : '';
}

/** `AttributeValue` から数値を取り出す。欠損・非数値は 0 */
function readNumber(value: AttributeValue | undefined): number {
  const parsed = value?.N === undefined ? Number.NaN : Number(value.N);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 入れ子の `metaJa` / `metaEn`（Map 属性）から 9 項目を取り出す。
 *
 * 項目の一覧は `embedding-text.ts` の `EMBEDDING_FIELD_ORDER` を唯一の出典にする。
 * 項目が増減した場合に読み取り側が取りこぼす経路を作らない。
 */
export function readMetadataFields(
  value: AttributeValue | undefined
): SkuMetadataFields | undefined {
  if (value?.M === undefined) return undefined;

  let raw: Record<string, unknown>;
  try {
    raw = unmarshall(value.M) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const fields: Partial<SkuMetadataFields> = {};
  for (const key of EMBEDDING_FIELD_ORDER) {
    const field = raw[key];
    fields[key] = typeof field === 'string' ? field : '';
  }
  return fields as SkuMetadataFields;
}

/** `Query` / `GetItem` の結果 1 件を `VectorTableRecord` へ変換する。キーが無い行は undefined */
export function parseVectorTableRecord(
  item: Record<string, AttributeValue>
): VectorTableRecord | undefined {
  const itemId = item.itemId?.S;
  const warehouseId = item.warehouseId?.S;
  if (typeof itemId !== 'string' || itemId.length === 0) return undefined;
  if (typeof warehouseId !== 'string' || warehouseId.length === 0) return undefined;

  const dimensions = item.embeddingDimensions?.N;

  return {
    itemId,
    warehouseId,
    itemName: readString(item.itemName),
    location: readString(item.location),
    quantity: readNumber(item.quantity),
    unitPrice: readNumber(item.unitPrice),
    metaJa: readMetadataFields(item.metaJa),
    metaEn: readMetadataFields(item.metaEn),
    embeddingModel: item.embeddingModel?.S,
    embeddingDimensions: dimensions === undefined ? undefined : Number(dimensions),
    hasEmbedding: {
      ja: Array.isArray(item.embeddingJa?.L) && item.embeddingJa.L.length > 0,
      en: Array.isArray(item.embeddingEn?.L) && item.embeddingEn.L.length > 0,
    },
  };
}

/**
 * 1 SKU の 3 レコード（3 倉庫）を 1 回の `Query` で読む。
 *
 * 設計は代表 1 行の `GetItem` を挙げているが、OpenSearch のドキュメントは
 * 倉庫ごとに `quantity` / `location` / `unitPrice` が異なるため 3 行すべての値が必要である。
 * `Query`（PK 指定）は 1 回でその 3 行を返し、代表行はその中から選べるので、
 * `GetItem` を別に発行せずに済む（読み取り回数が 1 回で済み、判定材料は同一）。
 */
async function querySkuRecords(
  tableName: string,
  itemId: string
): Promise<VectorTableRecord[]> {
  const records: VectorTableRecord[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const page = await dynamodb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: '#itemId = :itemId',
        ExpressionAttributeNames: SKU_DETAIL_ATTRIBUTE_NAMES,
        ExpressionAttributeValues: { ':itemId': { S: itemId } },
        ProjectionExpression: SKU_DETAIL_PROJECTION,
        ExclusiveStartKey: lastKey,
      })
    );

    for (const item of page.Items ?? []) {
      const record = parseVectorTableRecord(item);
      if (record !== undefined) records.push(record);
    }
    lastKey = page.LastEvaluatedKey;
  } while (lastKey !== undefined);

  return records;
}

/**
 * 代表行から両言語のベクトルを読み出す（要件 3.6 の検証、およびスキップした言語の同梱用）。
 *
 * `ConsistentRead: true` を使う。直前の `UpdateItem` の結果を読むため、
 * 結果整合の読み取りでは書き込み前の値を読んで不一致と誤判定しうる。
 */
async function readDynamoDbVectors(
  tableName: string,
  itemId: string
): Promise<Record<VectorLanguage, number[] | undefined>> {
  const result = await dynamodb.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { itemId: { S: itemId }, warehouseId: { S: SKU_LIST_WAREHOUSE } },
      ProjectionExpression: VECTOR_FIELDS.map((field) => `#${field}`).join(', '),
      ExpressionAttributeNames: Object.fromEntries(
        VECTOR_FIELDS.map((field) => [`#${field}`, field])
      ),
      ConsistentRead: true,
    })
  );

  const item = result.Item ?? {};
  return {
    ja: toNumberVector(item[resolveVectorField('ja')]),
    en: toNumberVector(item[resolveVectorField('en')]),
  };
}

/**
 * DynamoDB の `L` of `N` を `number[]` へ変換する。
 *
 * 各要素へ `Math.fround()` を適用する。書き込み時点で f32 に丸めた値であり
 * 丸めは冪等なので値は変わらないが、10 進表記の往復で 32bit 表現から外れた値が
 * 混ざった場合に比較で検出できるようにするため、読み出し側でも同じ丸めを通す。
 */
function toNumberVector(value: AttributeValue | undefined): number[] | undefined {
  if (!Array.isArray(value?.L)) return undefined;
  return value.L.map((element) => Math.fround(Number(element.N)));
}

// ============================================================
// phase = "embed": スキップ判定（要件 4.5 / 4.8）
// ============================================================

/**
 * 当該言語の埋め込み生成を省略できるか判定する（要件 4.5 / 4.8）。
 *
 * **判定式は持たない。**`shared/vector/skip-decision.ts` の `shouldSkipEmbedding()` へ
 * そのまま委譲する薄い適合層である。`VectorTableRecord` は `StoredEmbeddingState` を
 * 構造的に満たすため変換も不要である。
 *
 * 委譲する理由は、同じ条件式（当該言語のベクトルが存在し、`embeddingModel` と
 * `embeddingDimensions` がともに現行設定と一致する）をバッチのスキップ判定と
 * Verification_Run の対象特定（要件 3.15）が共有する必要があるためである。
 * 二重定義があると、片方だけを変えた時点で「バッチがスキップしたのに検証対象にも
 * ならない組」が生まれ、検証の一致件数が何を意味するのか読めなくなる。
 *
 * 純関数である（Property 13 / Property 14 の検証対象）。
 */
export function shouldSkipLanguage(
  record: Pick<VectorTableRecord, 'embeddingModel' | 'embeddingDimensions' | 'hasEmbedding'>,
  language: VectorLanguage,
  model: string,
  dimensions: number,
  forceRegenerate: boolean
): boolean {
  return shouldSkipEmbedding(record, language, model, dimensions, forceRegenerate);
}

// ============================================================
// phase = "embed": 書き込み内容の組み立て
// ============================================================

/** 言語 → メタデータフィールドの接尾辞。`resolveVectorField()` からのみ導出する */
function metadataSuffixOf(language: VectorLanguage): 'Ja' | 'En' {
  return resolveVectorField(language) === 'embeddingJa' ? 'Ja' : 'En';
}

/** 代表行のメタデータを解決する。`metaJa` / `metaEn` が欠けている場合のみ導出し直す */
function resolveRecordMetadata(record: VectorTableRecord): {
  ja: SkuMetadataFields;
  en: SkuMetadataFields;
} {
  if (record.metaJa !== undefined && record.metaEn !== undefined) {
    return { ja: record.metaJa, en: record.metaEn };
  }
  // `phase = "copy"` が付与済みのはずだが、欠落していても埋め込み生成を止めない
  return deriveSkuMetadata(record.itemId, record.itemName);
}

/**
 * OpenSearch へ投入するドキュメントを組み立てる（要件 6.7 / 6.8）。
 *
 * フィールド構成は `amplify/custom/vector-collection.ts` の
 * `buildIndexProperties()` が定義したマッピングに対応する。**インデックスと
 * マッピングの作成・変更は行わない**（要件 6.8）。ここが書くのはドキュメントだけである。
 */
export function buildVectorDocument(
  record: VectorTableRecord,
  metadata: { ja: SkuMetadataFields; en: SkuMetadataFields },
  vectors: Partial<Record<VectorLanguage, number[]>>
): Record<string, unknown> {
  const document: Record<string, unknown> = {
    itemId: record.itemId,
    warehouseId: record.warehouseId,
    itemName: record.itemName,
    location: record.location,
    quantity: record.quantity,
    unitPrice: record.unitPrice,
  };

  for (const language of VECTOR_LANGUAGES) {
    const suffix = metadataSuffixOf(language);
    const fields = language === 'ja' ? metadata.ja : metadata.en;
    for (const key of EMBEDDING_FIELD_ORDER) {
      document[`${OPENSEARCH_METADATA_FIELD_STEMS[key]}${suffix}`] = fields[key];
    }

    const vector = vectors[language];
    if (vector !== undefined) document[resolveVectorField(language)] = vector;
  }

  return document;
}

/** ベクトルを DynamoDB の `L` of `N` へ変換する。f32 丸めは生成側で済んでいる（要件 3.9） */
function toVectorAttributeValue(vector: readonly number[]): AttributeValue {
  return { L: vector.map((element) => ({ N: String(element) })) };
}

/**
 * 生成したベクトルを `UpdateItem` で書き込む式を組み立てる（要件 3.5）。
 *
 * **生成した言語のベクトルを 1 回の `UpdateItem` にまとめる**。両言語を生成した場合は
 * 1 回で両方を書くため、片方の言語だけが格納された中間状態が残らない。
 * `SET` のみを使い既存 6 属性とメタデータには触れない（要件 1.3 / 2.7）。
 * `ConditionExpression` により、複製されていない itemId に対して新規アイテムを作らない。
 */
function buildVectorUpdate(
  vectors: Partial<Record<VectorLanguage, number[]>>,
  model: string,
  dimensions: number
): {
  UpdateExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, AttributeValue>;
  ConditionExpression: string;
} {
  const names: Record<string, string> = {
    '#itemId': 'itemId',
    '#embeddingModel': 'embeddingModel',
    '#embeddingDimensions': 'embeddingDimensions',
    '#embeddingUpdatedAt': 'embeddingUpdatedAt',
  };
  const values: Record<string, AttributeValue> = {
    ':embeddingModel': { S: model },
    ':embeddingDimensions': { N: String(dimensions) },
    ':embeddingUpdatedAt': { S: new Date().toISOString() },
  };
  const assignments = [
    '#embeddingModel = :embeddingModel',
    '#embeddingDimensions = :embeddingDimensions',
    '#embeddingUpdatedAt = :embeddingUpdatedAt',
  ];

  for (const language of VECTOR_LANGUAGES) {
    const vector = vectors[language];
    if (vector === undefined) continue;
    const field = resolveVectorField(language);
    names[`#${field}`] = field;
    values[`:${field}`] = toVectorAttributeValue(vector);
    assignments.push(`#${field} = :${field}`);
  }

  return {
    UpdateExpression: `SET ${assignments.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ConditionExpression: 'attribute_exists(#itemId)',
  };
}

// ============================================================
// phase = "embed": 両バックエンドへの書き込みと補償
// ============================================================

/** 書き込み再試行の結果。失敗時は `errors.ts` が分類したエラーを持つ */
type WriteAttempt<T> = { ok: true; value: T } | { ok: false; error: VectorErrorResponse };

/**
 * 書き込みを最大 `BACKEND_WRITE_MAX_RETRIES` 回まで再試行する（要件 3.10）。
 *
 * 再試行するのは `errors.ts` が再試行可と分類したエラー（スロットリング・タイムアウト等）に限る。
 * 検証エラーや条件付き書き込みの失敗は 1 回で確定させ、無駄な待機を作らない。
 */
async function withWriteRetries<T>(operation: () => Promise<T>): Promise<WriteAttempt<T>> {
  let lastError: VectorErrorResponse | undefined;

  for (let attempt = 0; attempt <= BACKEND_WRITE_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(WRITE_BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 100);
    }

    try {
      return { ok: true, value: await operation() };
    } catch (error: unknown) {
      lastError = classifyError(error, 'EMBEDDING');
      if (!lastError.retryable) break;
    }
  }

  return {
    ok: false,
    error: lastError ?? classifyError(new Error('write failed without an error object'), 'EMBEDDING'),
  };
}

/**
 * 同一 SKU の 3 レコードへベクトルを書き込む（要件 3.5）。
 *
 * 成功時は undefined、失敗時は分類済みエラーを返す。1 件でも失敗した場合は
 * 呼び出し側が補償（要件 3.10）を行うため、途中で打ち切って返す。
 */
async function writeVectorsToDynamoDb(
  tableName: string,
  records: readonly VectorTableRecord[],
  vectors: Partial<Record<VectorLanguage, number[]>>,
  model: string,
  dimensions: number
): Promise<VectorErrorResponse | undefined> {
  const update = buildVectorUpdate(vectors, model, dimensions);

  for (const record of records) {
    const attempt = await withWriteRetries(() =>
      dynamodb.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: { itemId: { S: record.itemId }, warehouseId: { S: record.warehouseId } },
          ...update,
        })
      )
    );
    if (!attempt.ok) return attempt.error;
  }

  return undefined;
}

/** 補償で 5 属性を `REMOVE` する（要件 3.10）。両言語のベクトルをまとめて落とす */
async function removeEmbeddingAttributes(
  tableName: string,
  records: readonly VectorTableRecord[]
): Promise<VectorErrorResponse | undefined> {
  const names = Object.fromEntries(
    EMBEDDING_ATTRIBUTES_TO_REMOVE.map((attribute) => [`#${attribute}`, attribute])
  );
  const expression = `REMOVE ${EMBEDDING_ATTRIBUTES_TO_REMOVE.map((attribute) => `#${attribute}`).join(', ')}`;

  let firstError: VectorErrorResponse | undefined;
  for (const record of records) {
    const attempt = await withWriteRetries(() =>
      dynamodb.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: { itemId: { S: record.itemId }, warehouseId: { S: record.warehouseId } },
          UpdateExpression: expression,
          ExpressionAttributeNames: names,
        })
      )
    );
    // 1 件失敗しても残りの巻き戻しは続ける（部分的に残ったベクトルを減らす）
    if (!attempt.ok) firstError ??= attempt.error;
  }

  return firstError;
}

/** `_bulk` の応答から読み取る部分のみを型に持つ */
interface BulkResponseBody {
  errors?: boolean;
  items?: {
    index?: { status?: number; error?: { type?: string; reason?: string } };
    delete?: { status?: number; error?: { type?: string; reason?: string } };
  }[];
}

/**
 * `_bulk` の項目エラーを例外へ変換する内部エラー。
 *
 * `name` に OpenSearch の `error.type`、`statusCode` に項目のステータスを載せることで、
 * `errors.ts` の `classifyError()` がスロットリング（429）と恒久的な失敗を
 * 通常の SDK エラーと同じ規則で分類できる（再試行可否の決定経路を 1 本に保つ）。
 */
class OpenSearchBulkError extends Error {
  readonly statusCode?: number;

  constructor(reason: string, type: string | undefined, statusCode: number | undefined) {
    super(reason);
    this.name = type !== undefined && type.length > 0 ? type : 'OpenSearchBulkError';
    this.statusCode = statusCode;
  }
}

/** `_bulk` の応答を検査し、項目エラーがあれば例外にする */
function assertBulkSucceeded(body: BulkResponseBody | undefined, operation: 'index' | 'delete'): void {
  if (body?.errors !== true) return;

  for (const item of body.items ?? []) {
    const result = operation === 'index' ? item.index : item.delete;
    const error = result?.error;
    if (error === undefined) continue;
    throw new OpenSearchBulkError(error.reason ?? 'bulk operation failed', error.type, result?.status);
  }
}

/**
 * 3 ドキュメントを `_bulk` で投入する（要件 3.5 / 6.8）。
 *
 * Ingestion_Pipeline を経由しない。インデックスとマッピングの作成・変更も行わない
 * （`index` アクションのみを使い、`indices.*` API を一切呼ばない）。
 * `_id` が既存であれば置き換えになるため、再試行は冪等である。
 */
async function bulkIndexDocuments(
  client: Client,
  indexName: string,
  documents: readonly { id: string; source: Record<string, unknown> }[]
): Promise<VectorErrorResponse | undefined> {
  if (documents.length === 0) return undefined;

  const body: Record<string, unknown>[] = [];
  for (const document of documents) {
    body.push({ index: { _index: indexName, _id: document.id } });
    body.push(document.source);
  }

  const attempt = await withWriteRetries(async () => {
    const response = await client.bulk({ body });
    assertBulkSucceeded(response.body as BulkResponseBody | undefined, 'index');
  });

  return attempt.ok ? undefined : attempt.error;
}

/** 補償で 3 ドキュメントを削除する（要件 3.10）。存在しない `_id` はエラーにならない */
async function bulkDeleteDocuments(
  client: Client,
  indexName: string,
  documentIds: readonly string[]
): Promise<VectorErrorResponse | undefined> {
  if (documentIds.length === 0) return undefined;

  const body: Record<string, unknown>[] = documentIds.map((id) => ({
    delete: { _index: indexName, _id: id },
  }));

  const attempt = await withWriteRetries(async () => {
    const response = await client.bulk({ body });
    assertBulkSucceeded(response.body as BulkResponseBody | undefined, 'delete');
  });

  return attempt.ok ? undefined : attempt.error;
}

// ============================================================
// phase = "embed": 読み出し検証（要件 3.6 / 3.12）
// ============================================================

/**
 * 検証結果。不一致の場合のみ理由を持つ。
 *
 * `missing` は「Vector_Table 側にベクトルが存在しない」場合にのみ立つ。
 * 未格納（`missingCount`）と値の不一致（`mismatchedCount`）は要件 3.17 が
 * 別々に数えることを求めているため、比較の側で区別する。
 */
export interface VectorVerificationOutcome {
  matched: boolean;
  /** Vector_Table 側にベクトルが存在しなかった場合のみ true */
  missing?: true;
  reason?: string;
}

/**
 * 書き込んだ値と Vector_Table から読み返した値を**要素単位**で比較する（要件 3.6、Property 8）。
 *
 * 判定は 3 段。(1) 読み返した値が存在するか、(2) 次元数が設定値と一致するか、
 * (3) 全要素が厳密に一致するか。書き込む値は `Math.fround()` で f32 に丸めており
 * （要件 3.9）、読み返し側も同じ丸めを通すため、一致は近似ではなくビット等価として判定できる。
 *
 * **比較相手は Vector_Collection ではない。**バッチは Vector_Collection を読まない
 * （要件 3.12）。両バックエンドの格納値の突き合わせは Verification_Run が担う（要件 3.13）。
 *
 * 純関数であり、例外を投げない。
 */
export function compareStoredVectors(
  writtenVector: readonly number[] | undefined,
  storedVector: readonly number[] | undefined,
  dimensions: number
): VectorVerificationOutcome {
  if (storedVector === undefined) {
    return {
      matched: false,
      missing: true,
      reason: 'MISSING_DYNAMODB: Vector_Table にベクトルが存在しません。',
    };
  }

  if (writtenVector === undefined) {
    return {
      matched: false,
      missing: true,
      reason: 'MISSING_WRITTEN: 書き込んだ値が失われているため突き合わせできません。',
    };
  }

  if (writtenVector.length !== dimensions || storedVector.length !== dimensions) {
    return {
      matched: false,
      reason:
        `DIMENSION_MISMATCH: 次元数が一致しません。設定値: ${dimensions}、` +
        `書き込み値: ${writtenVector.length}、Vector_Table: ${storedVector.length}。`,
    };
  }

  for (let index = 0; index < dimensions; index++) {
    if (writtenVector[index] !== storedVector[index]) {
      return {
        matched: false,
        reason:
          `VALUE_MISMATCH: 第 ${index} 次元の値が一致しません` +
          `（書き込み値: ${writtenVector[index]}、Vector_Table: ${storedVector[index]}）。`,
      };
    }
  }

  return { matched: true };
}

// ============================================================
// phase = "embed": 集計
// ============================================================

function emptyLanguageSummary(): EmbedLanguageSummary {
  return {
    processedPairs: 0,
    generatedCount: 0,
    skippedCount: 0,
    storedCount: 0,
    failedCount: 0,
    truncatedCount: 0,
    bedrockCalls: 0,
    bedrockRetries: 0,
    bedrockFailedCalls: 0,
    inputTokenCount: 0,
    verifiedTargetCount: 0,
    verifiedMatchedCount: 0,
    verifiedMismatchedCount: 0,
    verifiedMissingCount: 0,
    remainingCount: EXPECTED_SKU_COUNT,
  };
}

/** 言語別集計から検証件数の組を切り出す。`summarizeVerification()` への唯一の入力経路 */
function verificationCountsOf(summary: EmbedLanguageSummary): VerificationCounts {
  return {
    targetCount: summary.verifiedTargetCount,
    matchedCount: summary.verifiedMatchedCount,
    mismatchedCount: summary.verifiedMismatchedCount,
    missingCount: summary.verifiedMissingCount,
  };
}

function initialPerLanguage(): Record<VectorLanguage, EmbedLanguageSummary> {
  return { ja: emptyLanguageSummary(), en: emptyLanguageSummary() };
}

/** 言語別の集計を合算する（要件 3.8 / 14.1 の「合計」） */
export function sumLanguageSummaries(
  perLanguage: Record<VectorLanguage, EmbedLanguageSummary>
): EmbedLanguageSummary {
  const total = emptyLanguageSummary();
  total.remainingCount = 0;

  for (const language of VECTOR_LANGUAGES) {
    const summary = perLanguage[language];
    for (const key of Object.keys(total) as (keyof EmbedLanguageSummary)[]) {
      total[key] += summary[key];
    }
  }

  return total;
}

// ============================================================
// phase = "embed": 1 SKU の処理
// ============================================================

/** 1 起動のあいだ持ち回す資源と累計。`failuresTruncated` のみ可変 */
interface EmbedRunState {
  readonly vectorTableName: string;
  readonly indexName: string;
  readonly client: Client;
  readonly generator: EmbeddingGenerator;
  readonly model: string;
  readonly dimensions: number;
  readonly forceRegenerate: boolean;
  readonly perLanguage: Record<VectorLanguage, EmbedLanguageSummary>;
  /**
   * 失敗一覧の台帳。保持枠を `(stage, errorCode)` の種類間で公平に配分する。
   *
   * 生の配列を持たないのは、「満杯なら捨てる」という判定がハンドラの各所に散ると
   * 種類の偏りが再発するためである。どれを残すかの規則は台帳 1 箇所に閉じる。
   */
  readonly ledger: DiverseFailureLedger<EmbedFailure>;
}

/** 失敗した組を記録する（件数を数え、一覧へ追加する。要件 3.8 / 4.3 / 4.6） */
function recordPairFailure(state: EmbedRunState, failure: EmbedFailure): void {
  state.perLanguage[failure.language].failedCount++;
  addFailureDetail(state, failure);
}

/** 一覧にのみ追加する（件数を二重に数えないための補助。補償そのものの失敗で使う） */
function addFailureDetail(state: EmbedRunState, failure: EmbedFailure): void {
  state.ledger.add(failure);
}

/**
 * 1 SKU（itemId）を処理する。
 *
 * 手順は「3 レコード読み取り → 言語ごとのスキップ判定と生成 → DynamoDB 3 件の `UpdateItem`
 * → OpenSearch 3 ドキュメントの `_bulk` → 読み出し検証」。いずれの失敗も例外として
 * 呼び出し側へ伝播させず、(itemId, language) 単位の失敗として記録して次の SKU へ進む
 * （要件 3.11 / 4.3 / 4.7）。
 */
async function processSku(state: EmbedRunState, itemId: string): Promise<void> {
  // レコード読み取りの失敗で起動全体を落とさない。当該 SKU を失敗として記録し次へ進む
  const read = await withWriteRetries(() => querySkuRecords(state.vectorTableName, itemId));
  if (!read.ok) {
    for (const language of VECTOR_LANGUAGES) {
      state.perLanguage[language].processedPairs++;
      recordPairFailure(state, {
        itemId,
        language,
        stage: 'DYNAMODB_WRITE',
        errorCode: read.error.errorCode,
        message: sanitizeMessage(
          `Vector_Table のレコード読み取りに失敗しました。${read.error.message}`,
          MAX_MESSAGE_LENGTH
        ),
        retryable: read.error.retryable,
      });
    }
    return;
  }

  const records = read.value;

  if (records.length === 0) {
    for (const language of VECTOR_LANGUAGES) {
      state.perLanguage[language].processedPairs++;
      recordPairFailure(state, {
        itemId,
        language,
        stage: 'DYNAMODB_WRITE',
        errorCode: 'RESOURCE_NOT_FOUND',
        message: sanitizeMessage(
          'Vector_Table に当該 itemId のレコードが存在しません。phase = "copy" の完了を確認してください。',
          MAX_MESSAGE_LENGTH
        ),
        retryable: false,
      });
    }
    return;
  }

  if (records.length !== WAREHOUSES.length) {
    console.warn(
      `vector-embed-batch embed: ${itemId} has ${records.length} records (expected ${WAREHOUSES.length}).`
    );
  }

  const representative =
    records.find((record) => record.warehouseId === SKU_LIST_WAREHOUSE) ?? records[0];
  const metadata = resolveRecordMetadata(representative);

  // ─── 言語ごとの生成（要件 3.2 / 3.4 / 4.5 / 4.8）────────────────────
  const generated: Partial<Record<VectorLanguage, number[]>> = {};
  const skipped: VectorLanguage[] = [];
  const failedLanguages: EmbedFailure[] = [];

  for (const language of VECTOR_LANGUAGES) {
    const counters = state.perLanguage[language];
    counters.processedPairs++;

    if (
      shouldSkipLanguage(
        representative,
        language,
        state.model,
        state.dimensions,
        state.forceRegenerate
      )
    ) {
      counters.skippedCount++;
      skipped.push(language);
      continue;
    }

    // 埋め込み対象テキストは言語ごとに 1 本。日英を 1 つの文字列に混ぜる経路はない（要件 2.10）
    const truncation = truncateForEmbedding(
      buildEmbeddingText(language === 'ja' ? metadata.ja : metadata.en)
    );
    if (truncation.truncated) counters.truncatedCount++;

    const result = await state.generator.generate({
      text: truncation.text,
      maxRetries: BATCH_MAX_RETRIES,
    });

    counters.bedrockCalls += result.calls;
    counters.bedrockRetries += result.retries;

    if (!result.ok) {
      // 失敗した呼び出し回数（再試行分を含む）は当該言語の全呼び出し（要件 14.1）
      counters.bedrockFailedCalls += result.calls;
      const failure: EmbedFailure = {
        itemId,
        language,
        stage: 'GENERATION',
        errorCode: result.error.errorCode,
        message: result.error.message,
        retryable: result.retryable,
      };
      failedLanguages.push(failure);
      recordPairFailure(state, failure);
      continue;
    }

    // 成功した呼び出しの直前に起きた再試行は、いずれも失敗した呼び出しである
    counters.bedrockFailedCalls += result.retries;
    counters.inputTokenCount += result.inputTextTokenCount ?? 0;
    counters.generatedCount++;
    generated[language] = result.embedding;
  }

  // ─── 生成失敗がある SKU は書き込まない ──────────────────────────────
  // 片方の言語だけが格納された中間状態を作らないため、生成できた側も破棄する。
  // 状態を変更しないので、次回実行は両言語をまとめて再生成する（要件 4.9）
  if (failedLanguages.length > 0) {
    const cause = failedLanguages[0];
    for (const language of VECTOR_LANGUAGES) {
      if (generated[language] === undefined) continue;
      recordPairFailure(state, {
        itemId,
        language,
        stage: 'GENERATION',
        errorCode: cause.errorCode,
        message: sanitizeMessage(
          `同一 SKU の ${cause.language} の埋め込み生成が失敗したため、本言語も未格納として扱います。` +
            `原因: ${cause.message}`,
          MAX_MESSAGE_LENGTH
        ),
        retryable: cause.retryable,
      });
    }
    return;
  }

  const languagesToWrite = VECTOR_LANGUAGES.filter((language) => generated[language] !== undefined);

  if (languagesToWrite.length > 0) {
    // OpenSearch の `index` はドキュメント全体を置き換えるため、スキップした言語の
    // ベクトルは格納済みの値を読み出して同梱する（片言語だけのドキュメントを作らない）
    const documentVectors: Partial<Record<VectorLanguage, number[]>> = { ...generated };
    if (skipped.length > 0) {
      try {
        const stored = await readDynamoDbVectors(state.vectorTableName, itemId);
        for (const language of skipped) {
          const vector = stored[language];
          if (vector !== undefined) documentVectors[language] = vector;
        }
      } catch (error: unknown) {
        console.warn(
          `vector-embed-batch embed: failed to read stored vectors for ${itemId} (continuing):`,
          error
        );
      }
    }

    const documents = records.map((record) => ({
      id: buildVectorDocumentId(record.itemId, record.warehouseId),
      source: buildVectorDocument(record, metadata, documentVectors),
    }));

    // ─── DynamoDB（要件 3.5）──────────────────────────────────────────
    const dynamodbError = await writeVectorsToDynamoDb(
      state.vectorTableName,
      records,
      generated,
      state.model,
      state.dimensions
    );
    if (dynamodbError !== undefined) {
      await compensate(state, records, itemId, 'DYNAMODB_WRITE', dynamodbError);
      return;
    }

    // ─── OpenSearch（要件 3.5 / 6.8）───────────────────────────────────
    const openSearchError = await bulkIndexDocuments(state.client, state.indexName, documents);
    if (openSearchError !== undefined) {
      await compensate(state, records, itemId, 'OPENSEARCH_WRITE', openSearchError);
      return;
    }

    for (const language of languagesToWrite) state.perLanguage[language].storedCount++;
  }

  // ─── 読み出し検証（要件 3.6 / 3.12）─────────────────────────────────
  // 検証対象は**この起動で書き込んだ組だけ**である。検証は「書き込んだ値」との
  // 突き合わせであり、スキップした組にはこの起動での書き込み値が存在しないため
  // 突き合わせる相手がない（格納済みの値を自分自身と比べても何も確認できない）。
  // スキップした組と Vector_Collection 側は Verification_Run が担う（要件 3.15）
  await verifyStoredVectors(state, representative, generated);
}

/**
 * 片側成功・他方失敗の巻き戻し（要件 3.10）。
 *
 * DynamoDB 側は 5 属性を `REMOVE`、OpenSearch 側は当該 `_id` を delete する。
 * **両言語のベクトル属性をまとめて**落とすため、巻き戻し後の状態は
 * 「当該 SKU に埋め込みが存在しない」に揃う。当該 SKU は未格納として
 * (itemId, language) とエラー内容付きで記録する。
 *
 * 巻き戻しは失敗した側にも実行する（DynamoDB が 3 件のうち一部だけ成功した場合、
 * OpenSearch が一部のドキュメントだけ成功した場合を回収するため）。
 */
async function compensate(
  state: EmbedRunState,
  records: readonly VectorTableRecord[],
  itemId: string,
  stage: 'DYNAMODB_WRITE' | 'OPENSEARCH_WRITE',
  cause: VectorErrorResponse
): Promise<void> {
  const removeError = await removeEmbeddingAttributes(state.vectorTableName, records);
  const deleteError = await bulkDeleteDocuments(
    state.client,
    state.indexName,
    records.map((record) => buildVectorDocumentId(record.itemId, record.warehouseId))
  );
  const compensationError = removeError ?? deleteError;

  const note =
    compensationError === undefined
      ? '両バックエンドのベクトル属性を書き込み前の状態へ巻き戻しました。'
      : '巻き戻し自体も失敗しました。当該 SKU の状態を手動で確認してください。';

  for (const language of VECTOR_LANGUAGES) {
    recordPairFailure(state, {
      itemId,
      language,
      stage,
      errorCode: cause.errorCode,
      message: sanitizeMessage(`${cause.message} ${note}`, MAX_MESSAGE_LENGTH),
      retryable: cause.retryable,
    });
  }

  if (compensationError !== undefined) {
    console.error(`vector-embed-batch embed: compensation failed for ${itemId}`);
    for (const language of VECTOR_LANGUAGES) {
      addFailureDetail(state, {
        itemId,
        language,
        stage: 'COMPENSATION',
        errorCode: compensationError.errorCode,
        message: compensationError.message,
        retryable: compensationError.retryable,
      });
    }
  }
}

/**
 * 書き込み後に **Vector_Table からのみ**ベクトルを読み返して検証する（要件 3.6 / 3.12）。
 *
 * **Vector_Collection への読み出しを発行しない。**バッチロールの Vector_Collection 権限は
 * `aoss:WriteDocument` のみであり（要件 17.7）、読み出すと全件 `ACCESS_DENIED_IAM` になる。
 * 旧実装は `client.get()` を呼んでおり、タスク 13.11 の実測で 9,994 組すべてが
 * この理由で不一致になった。両バックエンドの突き合わせは Verification_Run が担う（要件 3.13）。
 *
 * 検証は SKU 単位（代表行 = `WH-TOKYO` の 1 件）で行う。同一 SKU の 3 件には同一の
 * ベクトルを 1 回の `UpdateItem` で書いているため、代表行の一致が SKU の一致を代表する。
 *
 * **不一致と未格納は失敗件数に計上する**（要件 3.18）。`recordPairFailure()` を通すため、
 * 言語別の `failedCount` が増え、`summarizeVerification()` の判定で実行状態が
 * `COMPLETED` にならない。旧実装は一覧へ追加するだけで件数を数えていなかった。
 */
async function verifyStoredVectors(
  state: EmbedRunState,
  representative: VectorTableRecord,
  writtenVectors: Partial<Record<VectorLanguage, number[]>>
): Promise<void> {
  const languages = VECTOR_LANGUAGES.filter(
    (language) => writtenVectors[language] !== undefined
  );
  if (languages.length === 0) return;

  for (const language of languages) state.perLanguage[language].verifiedTargetCount++;

  // 読み返しの一時的な失敗（スロットリング等）で不一致と誤判定しないよう再試行を通す
  const read = await withWriteRetries(() =>
    readDynamoDbVectors(state.vectorTableName, representative.itemId)
  );

  if (!read.ok) {
    for (const language of languages) {
      // 読み返せなかった組は未格納として扱う（一致を確認できていない状態を合格にしない）
      state.perLanguage[language].verifiedMissingCount++;
      recordPairFailure(state, {
        itemId: representative.itemId,
        language,
        stage: 'VERIFICATION',
        errorCode: read.error.errorCode,
        message: sanitizeMessage(
          `Vector_Table からの読み返しに失敗しました。${read.error.message}`,
          MAX_MESSAGE_LENGTH
        ),
        retryable: read.error.retryable,
      });
    }
    return;
  }

  for (const language of languages) {
    const outcome = compareStoredVectors(
      writtenVectors[language],
      read.value[language],
      state.dimensions
    );

    if (outcome.matched) {
      state.perLanguage[language].verifiedMatchedCount++;
      continue;
    }

    // 要件 3.17: 未格納と値の不一致を別々に数える
    if (outcome.missing === true) state.perLanguage[language].verifiedMissingCount++;
    else state.perLanguage[language].verifiedMismatchedCount++;

    recordPairFailure(state, {
      itemId: representative.itemId,
      language,
      stage: 'VERIFICATION',
      errorCode: outcome.missing === true ? 'VECTOR_MISSING' : 'VECTOR_MISMATCH',
      message: sanitizeMessage(outcome.reason ?? '読み返したベクトルが一致しません。', MAX_MESSAGE_LENGTH),
      retryable: true,
    });
  }
}

// ============================================================
// phase = "embed": 検証結果の計上（要件 3.18）
// ============================================================

/** Verification_Run の経路とコマンド。返却 JSON から次の手順が辿れるようにする */
const VERIFICATION_RUN_ENDPOINT = 'POST /vector-search/verify';
const VERIFICATION_RUN_COMMAND = 'npm run vector:verify';

/**
 * 検証件数を集計して報告を組み立てる（要件 3.6 / 3.12 / 3.17 / 3.18）。
 *
 * **判定式を持たない。**集計と合否は `summarizeVerification()`、実行状態は
 * `resolveVerificationRunStatus()` に委ねる。ハンドラ側に「不一致が 0 なら合格」という
 * 式を書き足せる余地を残さないことが、旧実装の欠陥（集計と終了判定が別の変数を見ていた）
 * の再発を構造的に防ぐ唯一の手段である。
 */
function buildVerificationReport(
  perLanguage: Record<VectorLanguage, EmbedLanguageSummary>,
  failures: readonly EmbedFailure[]
): EmbedVerificationReport {
  const byLanguage = {} as Record<VectorLanguage, VerificationSummary>;
  const perLanguageCounts: VerificationCounts[] = [];

  for (const language of VECTOR_LANGUAGES) {
    const counts = verificationCountsOf(perLanguage[language]);
    perLanguageCounts.push(counts);
    byLanguage[language] = summarizeVerification(counts, mismatchedKeysOf(failures, language));
  }

  // 合計は `sumVerificationCounts()` を通す。言語別の和と合計を別の式で数え直さないため、
  // 両者が食い違う経路が存在しない
  const total = summarizeVerification(
    sumVerificationCounts(perLanguageCounts),
    mismatchedKeysOf(failures)
  );

  return {
    vectorTable: { ...total, status: resolveVerificationRunStatus(total) },
    byLanguage,
    vectorCollection: {
      verifiedBy: 'VERIFICATION_RUN',
      // バッチは Vector_Collection を読まないため、合格・不合格を主張できない（要件 3.12）
      status: 'NOT_EXECUTED',
      endpoint: VERIFICATION_RUN_ENDPOINT,
      command: VERIFICATION_RUN_COMMAND,
      note:
        'Vector_Collection 側の格納値検証は Verification_Run が担う。' +
        'バッチロールの Vector_Collection 権限は WriteDocument のみであり読み出せない。',
    },
  };
}

/**
 * 検証段階の失敗から不一致の識別子一覧を作る（要件 3.16 の形式に合わせる）。
 *
 * 出典は保持されている失敗一覧であるため件数は台帳の上限に従う。件数そのものは
 * `verifiedMismatchedCount` / `verifiedMissingCount` が上限なく保持する。
 */
function mismatchedKeysOf(
  failures: readonly EmbedFailure[],
  language?: VectorLanguage
): VerificationMismatchKey[] {
  const keys: VerificationMismatchKey[] = [];
  for (const failure of failures) {
    if (failure.stage !== 'VERIFICATION') continue;
    if (language !== undefined && failure.language !== language) continue;
    keys.push({ itemId: failure.itemId, language: failure.language, reason: failure.message });
  }
  return keys;
}

// ============================================================
// phase = "embed"
// ============================================================

/**
 * 日英 2 本の埋め込みを生成し、両バックエンドへ書き込む（設計「phase = "embed"」）。
 *
 * 1. 件数ゲート（要件 1.7）を初回起動で評価する。15,000 件でなければ Bedrock を 1 度も呼ばない
 * 2. Vector_Table を `warehouseId = WH-TOKYO` で絞って `Scan` し、itemId 一覧（5,000 件）を得る
 * 3. 1 SKU につき日英 2 本を生成する（Bedrock 呼び出し回数 = 一意 itemId 件数 × 2、要件 3.4）
 * 4. DynamoDB へ 3 件を `UpdateItem`、OpenSearch へ 3 ドキュメントを `_bulk` で書く（要件 3.5 / 6.8）
 * 5. 片側成功・他方失敗は両言語をまとめて巻き戻す（要件 3.10）
 * 6. 進捗は (itemId, language) 単位で 100 SKU ごとと終了時に永続化する（要件 4.4）
 * 7. 残り実行時間が 120 秒を下回ったら `nextItemIndex` 付きで自身を非同期 invoke する
 *
 * 再実行時に成功済みの組へ Bedrock 呼び出しを行わないこと（要件 4.9）は、Vector_Table に
 * 格納された `embeddingModel` / `embeddingDimensions` / ベクトルの存在を**唯一の判定材料**に
 * することで担保する。進捗レコードは可観測性と再開位置のために持つが、スキップ判定の
 * 入力にはしない（進捗レコードが失われても正しさが変わらない）。
 */
async function runEmbedPhase(
  executionId: string,
  cursor: EmbedCursor,
  context: Context | undefined,
  isContinuation: boolean
): Promise<{ body: VectorBatchResultBody; statusCode: number }> {
  const startedAtMs = Date.now();

  // ─── 環境変数の検証（Bedrock を 1 度も呼ぶ前に完了させる）────────────
  const vectorTableName = resolveRequiredEnv('VECTOR_TABLE_NAME');
  const endpoint = resolveRequiredEnv('OPENSEARCH_VECTOR_ENDPOINT');
  const region = resolveRequiredEnv('AWS_REGION');
  const indexName = resolveRequiredEnv('VECTOR_INDEX_NAME') ?? DEFAULT_VECTOR_INDEX_NAME;

  if (vectorTableName === undefined || endpoint === undefined || region === undefined) {
    return {
      body: invalidRequest(
        'embed',
        '環境変数 VECTOR_TABLE_NAME、OPENSEARCH_VECTOR_ENDPOINT、AWS_REGION をすべて設定してください。'
      ),
      statusCode: 400,
    };
  }

  // 要件 4.4 / 4.9: 進捗の記録が必須のフェーズであるため、未設定は入力エラーにする
  if (resolveRequiredEnv('EXECUTIONS_TABLE_NAME') === undefined) {
    return {
      body: invalidRequest(
        'embed',
        '環境変数 EXECUTIONS_TABLE_NAME を設定してください。進捗を永続化できない状態では埋め込み生成を開始しません。'
      ),
      statusCode: 400,
    };
  }

  if (cursor.invocationCount > MAX_EMBED_INVOCATIONS) {
    return {
      body: {
        phase: 'embed',
        status: 'FAILED',
        errorCode: 'SELF_RECURSION_LIMIT_EXCEEDED',
        message: sanitizeMessage(
          `自己再帰 invoke の回数が上限 ${MAX_EMBED_INVOCATIONS} 回を超えたため中断しました。` +
            `呼び出しレートの設定値と失敗件数を確認してください。`,
          MAX_MESSAGE_LENGTH
        ),
        retryable: false,
      },
      statusCode: 500,
    };
  }

  const dimensions = resolveEmbeddingDimensions();
  const requestsPerMinute = resolveRequestsPerMinute(cursor.requestsPerMinute);
  const generator = createEmbeddingGenerator({
    dimensions,
    requestsPerMinute,
    // バッチ側はレイテンシ最適化推論を使わない（設計「Embedding_Generator」）
    latencyOptimized: false,
  });

  const state: EmbedRunState = {
    vectorTableName,
    indexName,
    client: getOpenSearchClient(endpoint, region),
    generator,
    model: generator.model,
    dimensions: generator.dimensions,
    forceRegenerate: cursor.forceRegenerate === true,
    // カーソルは JSON 経由で届くため、欠けた項目を既定値で補ってから累計に使う
    perLanguage: {
      ja: { ...emptyLanguageSummary(), ...cursor.perLanguage?.ja },
      en: { ...emptyLanguageSummary(), ...cursor.perLanguage?.en },
    },
    // 継続起動では前回までの一覧を復元する。台帳は種類ごとにまとめ直すだけなので、
    // 出力 → カーソル → 復元 → 出力 で構成と順序が変わらない
    ledger: new DiverseFailureLedger<EmbedFailure>(
      MAX_REPORTED_FAILURES,
      cursor.failures ?? [],
      cursor.failuresTruncated === true
    ),
  };

  let processedSkuCount = Number.isFinite(cursor.nextItemIndex)
    ? Math.max(0, Math.trunc(cursor.nextItemIndex))
    : 0;
  let recordCountCheck = cursor.recordCountCheck;

  const elapsedSecondsBefore = Number.isFinite(cursor.elapsedSecondsBefore)
    ? Math.max(0, cursor.elapsedSecondsBefore)
    : 0;

  const buildSummary = (): EmbedPhaseSummary => {
    const perLanguage: Record<VectorLanguage, EmbedLanguageSummary> = {
      ja: {
        ...state.perLanguage.ja,
        remainingCount: Math.max(0, EXPECTED_SKU_COUNT - state.perLanguage.ja.processedPairs),
      },
      en: {
        ...state.perLanguage.en,
        remainingCount: Math.max(0, EXPECTED_SKU_COUNT - state.perLanguage.en.processedPairs),
      },
    };
    const elapsedSeconds = elapsedSecondsSince(startedAtMs);
    const failures = state.ledger.toArray();

    return {
      phase: 'embed',
      executionId,
      continuation: isContinuation,
      invocationCount: cursor.invocationCount,
      model: state.model,
      dimensions: state.dimensions,
      requestsPerMinute: generator.requestsPerMinute,
      forceRegenerate: state.forceRegenerate,
      processedSkuCount,
      expectedSkuCount: EXPECTED_SKU_COUNT,
      perLanguage,
      total: sumLanguageSummaries(perLanguage),
      failures,
      failuresTruncated: state.ledger.isTruncated,
      verification: buildVerificationReport(perLanguage, failures),
      elapsedSeconds,
      totalElapsedSeconds: Math.round((elapsedSecondsBefore + elapsedSeconds) * 10) / 10,
    };
  };

  // ─── 件数ゲート（要件 1.7）──────────────────────────────────────────
  // 初回起動でのみ評価する。判定対象は起動間で変化せず、毎起動の全件 Scan は
  // 読み取り量を起動回数分に増やすだけであるため、結果をカーソルで引き継ぐ
  if (recordCountCheck === undefined) {
    let actualRecordCount: number;
    try {
      actualRecordCount = await countVectorTableRecords(vectorTableName);
    } catch (error: unknown) {
      console.error('vector-embed-batch embed record count failed:', error);
      return failed('embed', error, buildSummary());
    }

    recordCountCheck = {
      expectedRecordCount: EXPECTED_VECTOR_RECORD_COUNT,
      actualRecordCount,
      matched: actualRecordCount === EXPECTED_VECTOR_RECORD_COUNT,
    };

    if (!recordCountCheck.matched) {
      console.error('vector-embed-batch embed record count mismatch:', recordCountCheck);
      const summary = buildSummary();
      await persistProgress(executionId, 'embed', 'RECORD_COUNT_MISMATCH', summary, {
        recordCountCheck,
      });
      return {
        body: recordCountMismatch(recordCountCheck, summary, 'embed'),
        statusCode: 409,
      };
    }
  }

  /** 残り実行時間が尽きたときに進捗を確定して自身へ引き継ぐ */
  const continueWith = async (
    resumeKey: Record<string, AttributeValue> | undefined
  ): Promise<{ body: EmbedContinuedBody; statusCode: number }> => {
    const summary = buildSummary();
    const body: EmbedContinuedBody = {
      ...summary,
      status: 'CONTINUED',
      resumeFrom: { nextItemIndex: processedSkuCount, hasExclusiveStartKey: resumeKey !== undefined },
    };

    await persistProgress(executionId, 'embed', 'CONTINUED', summary, {
      nextItemIndex: processedSkuCount,
    });
    await invokeSelf({
      isContinuation: true,
      phase: 'embed',
      executionId,
      embedCursor: {
        nextItemIndex: processedSkuCount,
        exclusiveStartKey: resumeKey,
        perLanguage: state.perLanguage,
        failures: summary.failures,
        failuresTruncated: summary.failuresTruncated,
        invocationCount: cursor.invocationCount + 1,
        elapsedSecondsBefore: summary.totalElapsedSeconds,
        requestsPerMinute,
        forceRegenerate: state.forceRegenerate,
        recordCountCheck,
      },
    });

    return { body, statusCode: 202 };
  };

  // ─── SKU 一覧の走査と処理 ───────────────────────────────────────────
  let scanKey = cursor.exclusiveStartKey;
  let skusSinceCheckpoint = 0;

  try {
    for (;;) {
      // 1 倉庫に絞った Scan が itemId の一意集合を与える（Vector_Table は GSI を持たない）
      const page = await dynamodb.send(
        new ScanCommand({
          TableName: vectorTableName,
          FilterExpression: '#warehouseId = :warehouseId',
          ExpressionAttributeNames: { '#itemId': 'itemId', '#warehouseId': 'warehouseId' },
          ExpressionAttributeValues: { ':warehouseId': { S: SKU_LIST_WAREHOUSE } },
          ProjectionExpression: '#itemId, #warehouseId',
          ExclusiveStartKey: scanKey,
          Limit: SKU_LIST_SCAN_LIMIT,
        })
      );

      const items = page.Items ?? [];
      scanKey = page.LastEvaluatedKey;

      for (let index = 0; index < items.length; index++) {
        const itemId = items[index].itemId?.S;
        if (typeof itemId !== 'string' || itemId.length === 0) continue;

        await processSku(state, itemId);
        processedSkuCount++;
        skusSinceCheckpoint++;

        if (skusSinceCheckpoint >= EMBED_PROGRESS_CHECKPOINT_SKUS) {
          skusSinceCheckpoint = 0;
          await persistProgress(executionId, 'embed', 'RUNNING', buildSummary(), {
            nextItemIndex: processedSkuCount,
          });
        }

        // 未処理が残っている場合のみ引き継ぐ。再開キーは**処理済みの最後の SKU の主キー**
        // であり、Scan はこのキーの次から再開する（同じ SKU を二重に処理しない）
        const hasMoreWork = index + 1 < items.length || scanKey !== undefined;
        if (hasMoreWork && remainingTimeMs(context) < SELF_RECURSION_REMAINING_MS) {
          return await continueWith({
            itemId: { S: itemId },
            warehouseId: { S: SKU_LIST_WAREHOUSE },
          });
        }
      }

      if (scanKey === undefined) break;

      // ページ境界では Scan の再開キーをそのまま使う（フィルタに一致しない末尾を読み直さない）
      if (remainingTimeMs(context) < SELF_RECURSION_REMAINING_MS) {
        return await continueWith(scanKey);
      }
    }
  } catch (error: unknown) {
    console.error('vector-embed-batch embed failed:', error);
    const summary = buildSummary();
    await persistProgress(executionId, 'embed', 'FAILED', summary);
    return failed('embed', error, summary);
  }

  const summary = buildSummary();

  // ─── 検証結果の計上（要件 3.18）──────────────────────────────────────
  // 実行状態は `resolveVerificationRunStatus()` の判定結果をそのまま使う。
  // 不一致件数と未格納件数の和が 1 以上なら `COMPLETED` にならない。
  // 不一致・未格納は `verifyStoredVectors()` が `recordPairFailure()` を通して
  // `failedCount` に計上済みである（旧実装は一覧へ追加するだけで数えていなかった）
  const runStatus = summary.verification.vectorTable.status;

  if (runStatus !== 'COMPLETED') {
    const { mismatchedCount, missingCount, targetCount } = summary.verification.vectorTable;
    console.error('vector-embed-batch embed verification failed:', summary.verification.vectorTable);
    await persistProgress(executionId, 'embed', runStatus, summary, { recordCountCheck });

    return {
      body: {
        ...summary,
        status: 'VERIFICATION_FAILED',
        errorCode: 'VERIFICATION_FAILED',
        message: sanitizeMessage(
          `Vector_Table の読み返し検証が不合格です。対象 ${targetCount} 組のうち` +
            `不一致 ${mismatchedCount} 組、未格納 ${missingCount} 組を検出しました。` +
            `Vector_Collection 側の検証は ${VERIFICATION_RUN_COMMAND} で別に実行します。`,
          MAX_MESSAGE_LENGTH
        ),
        retryable: true,
        recordCountCheck,
      },
      statusCode: 500,
    };
  }

  await persistProgress(executionId, 'embed', 'COMPLETED', summary, { recordCountCheck });
  console.log('vector-embed-batch embed completed:', {
    executionId,
    processedSkuCount: summary.processedSkuCount,
    total: summary.total,
    verification: summary.verification.vectorTable,
  });

  return {
    body: { ...summary, status: 'COMPLETED', recordCountCheck },
    statusCode: 200,
  };
}

/** 初回起動用の空カーソル。リクエストのオプションだけを載せる */
function initialEmbedCursor(options: {
  forceRegenerate: boolean;
  requestsPerMinute?: number;
}): EmbedCursor {
  return {
    nextItemIndex: 0,
    perLanguage: initialPerLanguage(),
    failures: [],
    failuresTruncated: false,
    invocationCount: 1,
    elapsedSecondsBefore: 0,
    forceRegenerate: options.forceRegenerate,
    requestsPerMinute: options.requestsPerMinute,
  };
}

// ============================================================
// 自己再帰 invoke
// ============================================================

/** 自身を非同期 invoke して処理を引き継ぐ（既存 `load-test-start` と同方式） */
async function invokeSelf(payload: VectorBatchContinuationEvent): Promise<void> {
  const functionName = resolveRequiredEnv('AWS_LAMBDA_FUNCTION_NAME');
  if (functionName === undefined) {
    throw new Error('AWS_LAMBDA_FUNCTION_NAME is not available for self recursion.');
  }

  await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: InvocationType.Event,
      Payload: Buffer.from(JSON.stringify(payload)),
    })
  );
}

// ============================================================
// ハンドラ
// ============================================================

/** 実行 ID を作る。設計「phase = "embed"」の命名（`vector-<phase>-<ISO8601>`）に揃える */
function newExecutionId(phase: VectorBatchPhase): string {
  return `vector-${phase}-${new Date().toISOString()}`;
}

/**
 * 埋め込みバッチハンドラー
 *
 * POST /vector-search/embed-batch（運用操作）および自己再帰 invoke。
 *
 * `phase` でフェーズを分岐する。`copy` は `embed` を自動起動しない。
 * 自己再帰 invoke の場合は API 応答を返す相手が居ないため、集計をログに出して終了する。
 */
export const handler = async (
  event: VectorBatchEvent,
  context?: Context
): Promise<APIGatewayProxyResult | void> => {
  // ---- 自己再帰 invoke -------------------------------------------------
  if (isContinuationEvent(event)) {
    if (event.phase === 'embed') {
      const embedCursor: EmbedCursor = {
        ...initialEmbedCursor({ forceRegenerate: event.embedCursor?.forceRegenerate === true }),
        ...event.embedCursor,
        invocationCount: event.embedCursor?.invocationCount ?? 2,
      };
      const embedResult = await runEmbedPhase(event.executionId, embedCursor, context, true);
      console.log('vector-embed-batch continuation finished:', embedResult.body);
      return;
    }

    const cursor: CopyCursor = {
      warehouseIndex: event.copyCursor?.warehouseIndex ?? 0,
      exclusiveStartKey: event.copyCursor?.exclusiveStartKey,
      perWarehouse: event.copyCursor?.perWarehouse ?? initialPerWarehouse(),
      invocationCount: event.copyCursor?.invocationCount ?? 2,
    };

    const result = await runCopyPhase(event.executionId, cursor, context, true);

    console.log('vector-embed-batch continuation finished:', result.body);
    return;
  }

  // ---- API Gateway 経由 ------------------------------------------------
  const payload = parseBatchRequestPayload(event) ?? {};
  const requestedPhase = payload.phase;
  if (!isVectorBatchPhase(requestedPhase)) {
    return errorResponse(
      invalidRequest(
        null,
        `phase は必須です。許容値: ${VECTOR_BATCH_PHASES.join(' / ')}。`
      ),
      400
    );
  }

  if (requestedPhase === 'embed') {
    // 再実行時に前回の進捗レコードへ追記したい場合は executionId を指定できる。
    // 指定しない場合は新しい ID を作る（設計「phase = "embed"」の命名に従う）
    const requestedExecutionId =
      typeof payload.executionId === 'string' && payload.executionId.trim().length > 0
        ? payload.executionId.trim()
        : newExecutionId('embed');

    await initializeExecutionRecord(requestedExecutionId, 'embed');

    const embedResult = await runEmbedPhase(
      requestedExecutionId,
      initialEmbedCursor({
        // 要件 4.8: 強制再生成が有効なときはスキップ判定を行わない
        forceRegenerate: payload.forceRegenerate === true,
        // 要件 4.1: 呼び出しレートはリクエストパラメータで上書きできる
        requestsPerMinute:
          typeof payload.requestsPerMinute === 'number' ? payload.requestsPerMinute : undefined,
      }),
      context,
      false
    );

    // 検証不合格（`VERIFICATION_FAILED`、500）もこちらへ流れる。集計を丸ごと載せるため
    // エラー専用の型ではなく `VectorBatchResultBody` として返す（要件 3.18）
    return embedResult.statusCode >= 400
      ? errorResponse(embedResult.body, embedResult.statusCode)
      : successResponse(embedResult.body, embedResult.statusCode);
  }

  const executionId = newExecutionId('copy');
  await initializeExecutionRecord(executionId, 'copy');

  const result = await runCopyPhase(
    executionId,
    { warehouseIndex: 0, perWarehouse: initialPerWarehouse(), invocationCount: 1 },
    context,
    false
  );

  return result.statusCode >= 400
    ? errorResponse(result.body as VectorBatchErrorBody, result.statusCode)
    : successResponse(result.body, result.statusCode);
};
