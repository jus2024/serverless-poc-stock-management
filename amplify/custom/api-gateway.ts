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
  /** 機能制約メタデータ Lambda（ベクトル検索比較用、Stage B のみ） */
  vectorCapabilitiesFunction?: lambda.Function;
  /** クエリ埋め込み生成 Lambda（ベクトル検索比較用、Stage B のみ） */
  vectorQueryEmbedFunction?: lambda.Function;
  /** DynamoDB ベクトル検索 Lambda（Stage B のみ） */
  vectorSearchDdbFunction?: lambda.Function;
  /** OpenSearch ベクトル検索 Lambda（Stage B のみ） */
  vectorSearchAossFunction?: lambda.Function;
  /** 複製 + 埋め込みバッチ Lambda（運用操作、Stage A から） */
  vectorEmbedBatchFunction?: lambda.Function;
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
 * ベクトル検索比較（該当 Lambda が渡された場合のみ）:
 * - GET  /vector-search/capabilities      → vector-capabilities Lambda
 * - POST /vector-search/embed             → vector-query-embed Lambda
 * - POST /vector-search/dynamodb          → vector-search-ddb Lambda
 * - POST /vector-search/opensearch        → vector-search-aoss Lambda
 * - POST /vector-search/verify            → vector-search-aoss Lambda（格納値検証、運用操作）
 * - POST /vector-search/embed-batch       → vector-embed-batch Lambda（運用操作）
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

    // ─── /vector-search リソース（ベクトル検索比較用）──────────────────
    // CORS プリフライトは RestApi の `defaultCorsPreflightOptions` が
    // 配下のリソースへ引き継がれるため、ここで個別に定義しない。
    // 各 Lambda の応答ヘッダーは既存ハンドラと同一の共有定義を使う。
    const hasVectorRoute =
      props.vectorCapabilitiesFunction !== undefined ||
      props.vectorQueryEmbedFunction !== undefined ||
      props.vectorSearchDdbFunction !== undefined ||
      props.vectorSearchAossFunction !== undefined ||
      props.vectorEmbedBatchFunction !== undefined;

    if (hasVectorRoute) {
      const vectorSearch = this.restApi.root.addResource('vector-search');

      // GET /vector-search/capabilities
      if (props.vectorCapabilitiesFunction) {
        vectorSearch
          .addResource('capabilities')
          .addMethod('GET', new apigateway.LambdaIntegration(props.vectorCapabilitiesFunction));
      }

      // POST /vector-search/embed
      if (props.vectorQueryEmbedFunction) {
        vectorSearch
          .addResource('embed')
          .addMethod('POST', new apigateway.LambdaIntegration(props.vectorQueryEmbedFunction));
      }

      // POST /vector-search/dynamodb
      if (props.vectorSearchDdbFunction) {
        vectorSearch
          .addResource('dynamodb')
          .addMethod('POST', new apigateway.LambdaIntegration(props.vectorSearchDdbFunction));
      }

      // POST /vector-search/opensearch
      // POST /vector-search/verify（Vector_Verification_Path、運用操作）
      //
      // 検証経路は**検索と同一の Lambda** が受ける。検証専用の Lambda を作らないのは、
      // その実行ロールが Vector_Collection のデータアクセスポリシーの 4 件目の Principal に
      // なり、要件 17.7 の「3 件のみ」という構成が崩れるためである（前提 A17）。
      // 既に ReadDocument / DescribeIndex を持つ検索 Lambda へ相乗りさせる。
      if (props.vectorSearchAossFunction) {
        const aossIntegration = new apigateway.LambdaIntegration(props.vectorSearchAossFunction);
        vectorSearch.addResource('opensearch').addMethod('POST', aossIntegration);
        vectorSearch.addResource('verify').addMethod('POST', aossIntegration);
      }

      // POST /vector-search/embed-batch（運用操作）
      // Lambda 側は最大 15 分動くが API Gateway の統合タイムアウト上限は 29 秒である。
      // 呼び出し側は 29 秒で応答を失うことがあり、その場合も Lambda の処理は継続する。
      // 進捗は `load-test-executions` の実行レコードで確認する。
      if (props.vectorEmbedBatchFunction) {
        vectorSearch
          .addResource('embed-batch')
          .addMethod(
            'POST',
            new apigateway.LambdaIntegration(props.vectorEmbedBatchFunction, {
              timeout: Duration.seconds(29),
            })
          );
      }
    }

    // ─── API URL を出力 ──────────────────────────────────────────────
    this.apiUrl = this.restApi.url;

    new CfnOutput(this, 'InventoryApiUrl', {
      value: this.restApi.url,
      description: 'Kiro Roasters Inventory API URL',
    });
  }
}
