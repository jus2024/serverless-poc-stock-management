import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { RemovalPolicy } from 'aws-cdk-lib';

/**
 * DynamoDB テーブル Construct の出力インターフェース
 */
export interface InventoryTables {
  /** kiro-roasters-inventory-bad — PK: warehouseId, SK: itemId */
  badTable: dynamodb.Table;
  /** kiro-roasters-inventory-good — PK: itemId, SK: warehouseId（GSI なし） */
  goodTable: dynamodb.Table;
  /** kiro-roasters-inventory-good-gsi — PK: itemId, SK: warehouseId + GSI 3本 */
  goodGsiTable: dynamodb.Table;
  /** kiro-roasters-inventory-bad-ondemand — PK: warehouseId, SK: itemId（オンデマンド課金） */
  badOnDemandTable: dynamodb.Table;
  /** load-test-executions — PK: executionId, オンデマンド */
  executionsTable: dynamodb.Table;
}

/**
 * Kiro Roasters 在庫管理検証用 DynamoDB テーブルを定義する Construct。
 *
 * - Bad_Table: warehouseId を PK にしてホットスポットを意図的に発生させる設計
 * - Good_Table: itemId を PK にしてアクセスを分散させる設計（GSI なし）
 * - Good_GSI_Table: Good_Table と同一のキースキーマに GSI 3本を追加し、GSI バックプレッシャーの影響を測る設計
 * - Bad_OnDemand_Table: Bad_Table と同一のキースキーマでビリングモードのみオンデマンドにし、オンデマンドでもパーティション上限によるスロットルが起きることを測る設計
 * - Executions Table: 負荷テスト実行状態を記録するテーブル
 */
export class InventoryTablesConstruct extends Construct implements InventoryTables {
  public readonly badTable: dynamodb.Table;
  public readonly goodTable: dynamodb.Table;
  public readonly goodGsiTable: dynamodb.Table;
  public readonly badOnDemandTable: dynamodb.Table;
  public readonly executionsTable: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // ─── Bad_Table: ホットスポット発生設計 ───────────────────────────
    // PK = warehouseId (カーディナリティ 3) → 東京倉庫に書き込み集中
    // WCU=10,000 → 物理パーティション約 10 個。ホットキーが 1 パーティション上限
    // (1,000 WCU) を超過する状況を作るのに必要。
    this.badTable = new dynamodb.Table(this, 'BadTable', {
      tableName: 'kiro-roasters-inventory-bad',
      partitionKey: { name: 'warehouseId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'itemId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 1000,
      writeCapacity: 10000,
      contributorInsightsEnabled: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ─── Good_Table: 分散設計 ────────────────────────────────────────
    // PK = itemId (カーディナリティ 5,000) → 書き込みが自然に分散
    this.goodTable = new dynamodb.Table(this, 'GoodTable', {
      tableName: 'kiro-roasters-inventory-good',
      partitionKey: { name: 'itemId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'warehouseId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 1000,
      writeCapacity: 10000,
      contributorInsightsEnabled: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Good_Table には GSI を付けない。
    // GSI の有無による影響を分離するため、GSI 付きは goodGsiTable として別テーブルにする。

    // ─── Good_GSI_Table: 分散設計 + GSI 3本 ─────────────────────────
    // 本体のキースキーマは goodTable と完全に同一。違いは GSI の有無のみ。
    // 3 つの GSI はすべて PK=warehouseId のため、東京集中の書き込みでは
    // GSI 側でホットパーティションが発生し、GSI バックプレッシャーによって
    // ベーステーブルの書き込みまでスロットルする。この影響を単独で測るための
    // 比較対象テーブル。
    this.goodGsiTable = new dynamodb.Table(this, 'GoodGsiTable', {
      tableName: 'kiro-roasters-inventory-good-gsi',
      partitionKey: { name: 'itemId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'warehouseId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 1000,
      writeCapacity: 10000,
      contributorInsightsEnabled: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // GSI: byWarehouse — 倉庫別の在庫一覧取得用
    this.goodGsiTable.addGlobalSecondaryIndex({
      indexName: 'byWarehouse',
      partitionKey: { name: 'warehouseId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'itemId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
      readCapacity: 1000,
      writeCapacity: 3000,
    });

    // GSI: byLocation — 倉庫×ロケーション前方一致検索用
    this.goodGsiTable.addGlobalSecondaryIndex({
      indexName: 'byLocation',
      partitionKey: { name: 'warehouseId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'location', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
      readCapacity: 1000,
      writeCapacity: 3000,
    });

    // GSI: byUnitPrice — 倉庫×単価範囲検索用
    this.goodGsiTable.addGlobalSecondaryIndex({
      indexName: 'byUnitPrice',
      partitionKey: { name: 'warehouseId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'unitPrice', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
      readCapacity: 1000,
      writeCapacity: 3000,
    });

    // ─── Bad_OnDemand_Table: ホットスポット発生設計 + オンデマンド課金 ──
    // キースキーマは badTable と完全に同一。違いはビリングモードのみ。
    // 「オンデマンドにすればスロットルしない」という誤解の検証用。
    // パーティション単位の 1,000 WCU/秒 上限はプロビジョンド / オンデマンドの
    // 区別なく適用されるため、東京集中の書き込みでは badTable と同様に
    // キーレンジ超過によるスロットルが発生する想定。
    // オンデマンドではスロットル例外名が ThrottlingException になる
    // （プロビジョンドは ProvisionedThroughputExceededException）。
    this.badOnDemandTable = new dynamodb.Table(this, 'BadOnDemandTable', {
      tableName: 'kiro-roasters-inventory-bad-ondemand',
      partitionKey: { name: 'warehouseId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'itemId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      contributorInsightsEnabled: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ─── Executions Table: 負荷テスト実行管理 ────────────────────────
    // オンデマンドキャパシティ（低トラフィック管理用）
    this.executionsTable = new dynamodb.Table(this, 'ExecutionsTable', {
      tableName: 'load-test-executions',
      partitionKey: { name: 'executionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}
