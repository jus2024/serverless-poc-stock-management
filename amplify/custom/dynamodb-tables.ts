import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { RemovalPolicy } from 'aws-cdk-lib';

/**
 * DynamoDB テーブル Construct の出力インターフェース
 *
 * 現在は Good Table（オンデマンド + GSI 3本）のみ有効。
 * 負荷テスト用テーブル（Bad, Good(GSI無し), BadOnDemand）は
 * コスト節約のためコメントアウト中。再有効化は下記のコメント解除で可能。
 */
export interface InventoryTables {
  /** kiro-roasters-inventory-good — PK: itemId, SK: warehouseId + GSI 3本, オンデマンド */
  goodTable: dynamodb.Table;
  /** load-test-executions — PK: executionId, オンデマンド */
  executionsTable: dynamodb.Table;
  /** kiro-roasters-inventory-vector — PK: itemId, SK: warehouseId, GSI なし, オンデマンド */
  vectorTable: dynamodb.Table;
  /** kiro-vector-query-cache — PK: queryId, TTL 300s, オンデマンド */
  queryCacheTable: dynamodb.Table;
  // 以下は負荷テスト時に再有効化
  // badTable?: dynamodb.Table;
  // goodGsiTable?: dynamodb.Table;
  // badOnDemandTable?: dynamodb.Table;
}

/**
 * Kiro Roasters 在庫管理検証用 DynamoDB テーブルを定義する Construct。
 *
 * - Good_Table: itemId を PK にしてアクセスを分散させる設計 + GSI 3本（オンデマンド課金）
 * - Executions Table: 負荷テスト実行状態を記録するテーブル
 * - Vector_Table: ベクトル検索比較の検証専用テーブル（GSI なし、Streams なし、PITR 無効）
 * - Query_Vector_Cache: クエリベクトルの短期受け渡し用テーブル（TTL 300 秒）
 *
 * 負荷テスト用テーブル（Bad, Good(GSI無し), Bad_OnDemand）はコスト節約のため
 * コメントアウト中。再有効化手順は下部のブロックコメントを参照。
 */
export class InventoryTablesConstruct extends Construct implements InventoryTables {
  public readonly goodTable: dynamodb.Table;
  public readonly executionsTable: dynamodb.Table;
  public readonly vectorTable: dynamodb.Table;
  public readonly queryCacheTable: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // ─── Good_Table: 分散設計 + GSI 3本（オンデマンド）─────────────────
    // PK = itemId (カーディナリティ 5,000) → 書き込みが自然に分散
    // オンデマンド課金: 使った分だけ課金、プロビジョンドの常時課金を回避
    this.goodTable = new dynamodb.Table(this, 'GoodTable', {
      tableName: 'kiro-roasters-inventory-good',
      partitionKey: { name: 'itemId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'warehouseId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      contributorInsightsEnabled: true,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      pointInTimeRecovery: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // GSI: byWarehouse — 倉庫別の在庫一覧取得用
    this.goodTable.addGlobalSecondaryIndex({
      indexName: 'byWarehouse',
      partitionKey: { name: 'warehouseId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'itemId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: byLocation — 倉庫×ロケーション前方一致検索用
    this.goodTable.addGlobalSecondaryIndex({
      indexName: 'byLocation',
      partitionKey: { name: 'warehouseId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'location', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: byUnitPrice — 倉庫×単価範囲検索用
    this.goodTable.addGlobalSecondaryIndex({
      indexName: 'byUnitPrice',
      partitionKey: { name: 'warehouseId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'unitPrice', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ─── Executions Table: 負荷テスト実行管理 ────────────────────────
    // オンデマンドキャパシティ（低トラフィック管理用）
    this.executionsTable = new dynamodb.Table(this, 'ExecutionsTable', {
      tableName: 'load-test-executions',
      partitionKey: { name: 'executionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ─── Vector_Table: ベクトル検索比較の検証専用テーブル ──────────────
    // Good_Table と同一キースキーマ・同一データ（15,000 レコード）を複製する。
    // GSI を 1 本も持たないのは意図的な設計:
    //   1. Good_Table の GSI 3 本はすべて ProjectionType: ALL のため、
    //      ベクトル属性を Good_Table に追加すると GSI へ 3 重複製されてしまう
    //   2. GSI が無いことで TableSizeBytes の差分がそのまま
    //      ベクトル属性の寄与になり、ストレージ測定が単純になる
    // Streams は設定しない（OSIS パイプラインを停止維持するため）。
    // ベクトルインデックス（byEmbeddingJa / byEmbeddingEn）は
    // amplify/custom/vector-index.ts のカスタムリソースで本テーブルに作成する。
    this.vectorTable = new dynamodb.Table(this, 'VectorTable', {
      tableName: 'kiro-roasters-inventory-vector',
      partitionKey: { name: 'itemId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'warehouseId', type: dynamodb.AttributeType.STRING },
      // DynamoDB Vector Search はオンデマンド課金が前提条件
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // 検証用途のため PITR は無効（追加課金を避ける）
      pointInTimeRecovery: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ─── Query_Vector_Cache: クエリベクトルの短期受け渡し用 ────────────
    // POST /vector-search/embed が生成したクエリベクトルと言語を queryId で保管し、
    // 2 つの検索 Lambda が同一ベクトル・同一言語で検索できるようにする。
    // TTL 属性 expiresAt（生成時刻 + 300 秒）で自動失効させる。
    this.queryCacheTable = new dynamodb.Table(this, 'QueryVectorCacheTable', {
      tableName: 'kiro-vector-query-cache',
      partitionKey: { name: 'queryId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    /* ── 負荷テスト用テーブル（コスト節約のためコメントアウト中）──────────
     * 再有効化する場合:
     * 1. 下記のコメントを解除
     * 2. interface と class に対応するプロパティを追加
     * 3. amplify/backend.ts と Lambda の環境変数を更新
     * 4. amplify/custom/lambda-functions.ts の LambdaFunctionsProps を更新
     *
     * // ─── Bad_Table: ホットスポット発生設計（プロビジョンド）───────────
     * // PK = warehouseId (カーディナリティ 3) → 東京倉庫に書き込み集中
     * this.badTable = new dynamodb.Table(this, 'BadTable', {
     *   tableName: 'kiro-roasters-inventory-bad',
     *   partitionKey: { name: 'warehouseId', type: dynamodb.AttributeType.STRING },
     *   sortKey: { name: 'itemId', type: dynamodb.AttributeType.STRING },
     *   billingMode: dynamodb.BillingMode.PROVISIONED,
     *   readCapacity: 1000,
     *   writeCapacity: 10000,
     *   contributorInsightsEnabled: true,
     *   removalPolicy: RemovalPolicy.DESTROY,
     * });
     *
     * // ─── Good_GSI_Table: 分散設計 + GSI 3本（プロビジョンド）─────────
     * this.goodGsiTable = new dynamodb.Table(this, 'GoodGsiTable', {
     *   tableName: 'kiro-roasters-inventory-good-gsi',
     *   partitionKey: { name: 'itemId', type: dynamodb.AttributeType.STRING },
     *   sortKey: { name: 'warehouseId', type: dynamodb.AttributeType.STRING },
     *   billingMode: dynamodb.BillingMode.PROVISIONED,
     *   readCapacity: 1000,
     *   writeCapacity: 10000,
     *   contributorInsightsEnabled: true,
     *   removalPolicy: RemovalPolicy.DESTROY,
     * });
     *
     * // ─── Bad_OnDemand_Table: ホットスポット + オンデマンド ──────────
     * this.badOnDemandTable = new dynamodb.Table(this, 'BadOnDemandTable', {
     *   tableName: 'kiro-roasters-inventory-bad-ondemand',
     *   partitionKey: { name: 'warehouseId', type: dynamodb.AttributeType.STRING },
     *   sortKey: { name: 'itemId', type: dynamodb.AttributeType.STRING },
     *   billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
     *   contributorInsightsEnabled: true,
     *   removalPolicy: RemovalPolicy.DESTROY,
     * });
     * ───────────────────────────────────────────────────────────────── */
  }
}
