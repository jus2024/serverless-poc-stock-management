import { Construct } from 'constructs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { CfnOutput, Duration } from 'aws-cdk-lib';

/**
 * API Gateway REST API Construct の入力プロパティ
 */
export interface InventoryApiProps {
  /** 在庫照会 Lambda 関数 */
  queryFunction: lambda.Function;
  /** 出庫処理 Lambda 関数 */
  shipFunction: lambda.Function;
  /** 負荷テスト開始 Lambda 関数 */
  loadTestStartFunction: lambda.Function;
  /** 負荷テストステータス Lambda 関数 */
  loadTestStatusFunction: lambda.Function;
  /** 初期データ投入 Lambda 関数 */
  seedFunction: lambda.Function;
  /** オンライン影響テスト Lambda 関数 */
  onlineImpactTestFunction: lambda.Function;
  /** OpenSearch 検索 Lambda 関数（検索比較用） */
  opensearchSearchFunction?: lambda.Function;
}

/**
 * Kiro Roasters 在庫管理検証用 REST API を定義する Construct。
 *
 * エンドポイント:
 * - GET  /inventory/{warehouseId}         → inventory-query Lambda (一覧取得)
 * - GET  /inventory/{warehouseId}/{itemId} → inventory-query Lambda (個別取得)
 * - POST /inventory/ship                  → inventory-ship Lambda
 * - POST /load-test/start                 → load-test-start Lambda
 * - GET  /load-test/status/{executionId}  → load-test-status Lambda
 * - POST /seed                            → seed Lambda
 *
 * CORS: 開発環境向けに全オリジン許可
 */
export class InventoryApiConstruct extends Construct {
  /** デプロイされた REST API の URL */
  public readonly apiUrl: string;
  /** REST API リソース（外部参照用） */
  public readonly restApi: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: InventoryApiProps) {
    super(scope, id);

    // ─── REST API 定義 ──────────────────────────────────────────────
    this.restApi = new apigateway.RestApi(this, 'InventoryApi', {
      restApiName: 'kiro-roasters-inventory-api',
      description: 'Kiro Roasters 在庫管理検証 API — DynamoDB ホットスポット検証用',
      deployOptions: {
        stageName: 'api',
        tracingEnabled: true, // X-Ray トレーシング
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
          'X-Amz-Security-Token',
        ],
      },
    });

    // ─── Lambda プロキシ統合 ─────────────────────────────────────────
    const queryIntegration = new apigateway.LambdaIntegration(props.queryFunction);
    const shipIntegration = new apigateway.LambdaIntegration(props.shipFunction);
    const loadTestStartIntegration = new apigateway.LambdaIntegration(props.loadTestStartFunction);
    const loadTestStatusIntegration = new apigateway.LambdaIntegration(props.loadTestStatusFunction);
    const seedIntegration = new apigateway.LambdaIntegration(props.seedFunction, {
      timeout: Duration.seconds(29),
    });
    const onlineImpactTestIntegration = new apigateway.LambdaIntegration(props.onlineImpactTestFunction, {
      timeout: Duration.seconds(29),
    });

    // ─── /inventory リソース ─────────────────────────────────────────
    const inventory = this.restApi.root.addResource('inventory');

    // GET /inventory/{warehouseId} (一覧取得)
    // GET /inventory/{warehouseId}/{itemId} (個別取得)
    const warehouseId = inventory.addResource('{warehouseId}');
    warehouseId.addMethod('GET', queryIntegration);
    const itemId = warehouseId.addResource('{itemId}');
    itemId.addMethod('GET', queryIntegration);

    // POST /inventory/ship
    const ship = inventory.addResource('ship');
    ship.addMethod('POST', shipIntegration);

    // ─── /load-test リソース ─────────────────────────────────────────
    const loadTest = this.restApi.root.addResource('load-test');

    // POST /load-test/start
    const start = loadTest.addResource('start');
    start.addMethod('POST', loadTestStartIntegration);

    // GET /load-test/status/{executionId}
    const status = loadTest.addResource('status');
    const executionId = status.addResource('{executionId}');
    executionId.addMethod('GET', loadTestStatusIntegration);

    // POST /load-test/online-impact
    const onlineImpact = loadTest.addResource('online-impact');
    onlineImpact.addMethod('POST', onlineImpactTestIntegration);

    // ─── /seed リソース ──────────────────────────────────────────────
    const seed = this.restApi.root.addResource('seed');
    seed.addMethod('POST', seedIntegration);

    // ─── /search リソース（OpenSearch 検索比較用）─────────────────────
    if (props.opensearchSearchFunction) {
      const opensearchSearchIntegration = new apigateway.LambdaIntegration(props.opensearchSearchFunction);
      const search = this.restApi.root.addResource('search');
      search.addMethod('GET', opensearchSearchIntegration);
    }

    // ─── API URL を出力 ──────────────────────────────────────────────
    this.apiUrl = this.restApi.url;

    new CfnOutput(this, 'InventoryApiUrl', {
      value: this.restApi.url,
      description: 'Kiro Roasters Inventory API URL',
    });
  }
}
