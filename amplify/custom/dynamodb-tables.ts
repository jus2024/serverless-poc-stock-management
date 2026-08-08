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
 *
 * 負荷テスト用テーブル（Bad, Good(GSI無し), Bad_OnDemand）はコスト節約のため
 * コメントアウト中。再有効化手順は下部のブロックコメントを参照。
 */
export class InventoryTablesConstruct extends Construct implements InventoryTables {
  public readonly goodTable: dynamodb.Table;
  public readonly executionsTable: dynamodb.Table;

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
