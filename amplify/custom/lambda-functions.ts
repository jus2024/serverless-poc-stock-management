import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Duration } from 'aws-cdk-lib';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Lambda Functions Construct の入力インターフェース
 *
 * 負荷テスト用テーブル（badTable, goodGsiTable, badOnDemandTable）を再有効化する場合は
 * ここにプロパティを追加し、下部のコメントアウトされた権限付与も解除する。
 */
export interface LambdaFunctionsProps {
  goodTable: dynamodb.Table;
  executionsTable: dynamodb.Table;
  /** OpenSearch Collection のエンドポイント URL（opensearch-search Lambda 用） */
  opensearchEndpoint?: string;
  /** OpenSearch Collection の ARN（IAM 権限付与用） */
  opensearchCollectionArn?: string;
  // 負荷テスト用（再有効化時にコメント解除）
  // badTable?: dynamodb.Table;
  // goodGsiTable?: dynamodb.Table;
  // badOnDemandTable?: dynamodb.Table;
}

/**
 * Lambda Functions Construct の出力インターフェース
 */
export interface LambdaFunctions {
  queryFunction: lambda.Function;
  shipFunction: lambda.Function;
  loadTestStartFunction: lambda.Function;
  loadTestStatusFunction: lambda.Function;
  seedFunction: lambda.Function;
  onlineImpactTestFunction: lambda.Function;
  opensearchSearchFunction?: lambda.Function;
}

/**
 * Kiro Roasters 在庫管理検証用 Lambda 関数を定義する Construct。
 *
 * - inventory-query: Good_Table からの在庫照会
 * - inventory-ship: 出庫処理（在庫減算）
 * - load-test-start: 負荷生成開始 + ワーカー非同期起動
 * - load-test-status: 負荷テスト実行ステータス取得
 * - seed: 初期データ投入
 * - online-impact-test: オンライン影響度テスト
 * - opensearch-search: OpenSearch Serverless 検索（比較検証用）
 */
export class LambdaFunctionsConstruct extends Construct implements LambdaFunctions {
  public readonly queryFunction: lambda.Function;
  public readonly shipFunction: lambda.Function;
  public readonly loadTestStartFunction: lambda.Function;
  public readonly loadTestStatusFunction: lambda.Function;
  public readonly seedFunction: lambda.Function;
  public readonly onlineImpactTestFunction: lambda.Function;
  public readonly opensearchSearchFunction?: lambda.Function;

  constructor(scope: Construct, id: string, props: LambdaFunctionsProps) {
    super(scope, id);

    const { goodTable, executionsTable } = props;

    // 共通環境変数
    // Good Table のみ有効。Lambda ハンドラ側で BAD_TABLE_NAME 等が未設定の場合は
    // そのテーブルへのアクセスをスキップする設計になっている。
    const commonEnv: Record<string, string> = {
      GOOD_TABLE_NAME: goodTable.tableName,
      EXECUTIONS_TABLE_NAME: executionsTable.tableName,
      // 負荷テスト用テーブル再有効化時にコメント解除
      // BAD_TABLE_NAME: badTable.tableName,
      // GOOD_GSI_TABLE_NAME: goodGsiTable.tableName,
      // BAD_ONDEMAND_TABLE_NAME: badOnDemandTable.tableName,
    };

    // 共通 NodejsFunction オプション
    const commonProps: Partial<nodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      tracing: lambda.Tracing.ACTIVE,
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
      },
    };

    // Lambda 関数のエントリポイントへのパスを解決するベースディレクトリ
    const functionsDir = join(__dirname, '..', 'functions');

    // ─── inventory-query ───────────────────────────────────────────
    this.queryFunction = new nodejs.NodejsFunction(this, 'QueryFunction', {
      ...commonProps,
      functionName: 'kiro-inventory-query',
      entry: join(functionsDir, 'inventory-query', 'handler.ts'),
      handler: 'handler',
      timeout: Duration.seconds(30),
      environment: commonEnv,
    });

    // Read access to Good_Table
    goodTable.grantReadData(this.queryFunction);

    // ─── inventory-ship ────────────────────────────────────────────
    this.shipFunction = new nodejs.NodejsFunction(this, 'ShipFunction', {
      ...commonProps,
      functionName: 'kiro-inventory-ship',
      entry: join(functionsDir, 'inventory-ship', 'handler.ts'),
      handler: 'handler',
      timeout: Duration.seconds(30),
      environment: commonEnv,
    });

    // Write access to Good_Table
    goodTable.grantWriteData(this.shipFunction);

    // ─── load-test-start ───────────────────────────────────────────
    this.loadTestStartFunction = new nodejs.NodejsFunction(this, 'LoadTestStartFunction', {
      ...commonProps,
      functionName: 'kiro-load-test-start',
      entry: join(functionsDir, 'load-test-start', 'handler.ts'),
      handler: 'handler',
      timeout: Duration.minutes(10),
      memorySize: 2048,
      environment: commonEnv,
    });

    // Write access to Executions table
    executionsTable.grantWriteData(this.loadTestStartFunction);

    // Read + Write access to Good_Table (for worker operations + SKU scanning)
    goodTable.grantReadWriteData(this.loadTestStartFunction);

    // Self-invoke permission for async worker invocation
    this.loadTestStartFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [`arn:aws:lambda:*:*:function:kiro-load-test-start`],
      })
    );

    // ─── load-test-status ──────────────────────────────────────────
    this.loadTestStatusFunction = new nodejs.NodejsFunction(this, 'LoadTestStatusFunction', {
      ...commonProps,
      functionName: 'kiro-load-test-status',
      entry: join(functionsDir, 'load-test-status', 'handler.ts'),
      handler: 'handler',
      timeout: Duration.seconds(30),
      environment: commonEnv,
    });

    // Read access to Executions table
    executionsTable.grantReadData(this.loadTestStatusFunction);

    // ─── seed ──────────────────────────────────────────────────────
    this.seedFunction = new nodejs.NodejsFunction(this, 'SeedFunction', {
      ...commonProps,
      functionName: 'kiro-seed',
      entry: join(functionsDir, 'seed', 'handler.ts'),
      handler: 'handler',
      timeout: Duration.minutes(15),
      memorySize: 512,
      environment: commonEnv,
    });

    // Write access to Good_Table
    goodTable.grantWriteData(this.seedFunction);

    // ─── online-impact-test ────────────────────────────────────────
    this.onlineImpactTestFunction = new nodejs.NodejsFunction(this, 'OnlineImpactTestFunction', {
      ...commonProps,
      functionName: 'kiro-online-impact-test',
      entry: join(functionsDir, 'online-impact-test', 'handler.ts'),
      handler: 'handler',
      timeout: Duration.minutes(5),
      memorySize: 1024,
      environment: commonEnv,
    });

    // Read + Write access to Good_Table
    goodTable.grantReadWriteData(this.onlineImpactTestFunction);

    // ─── opensearch-search ─────────────────────────────────────────
    if (props.opensearchEndpoint && props.opensearchCollectionArn) {
      this.opensearchSearchFunction = new nodejs.NodejsFunction(this, 'OpenSearchSearchFunction', {
        ...commonProps,
        functionName: 'kiro-opensearch-search',
        entry: join(functionsDir, 'opensearch-search', 'handler.ts'),
        handler: 'handler',
        timeout: Duration.seconds(60),
        environment: {
          OPENSEARCH_ENDPOINT: props.opensearchEndpoint,
        },
      });

      // OpenSearch Collection への aoss:APIAccessAll 権限を付与
      this.opensearchSearchFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['aoss:APIAccessAll'],
          resources: [props.opensearchCollectionArn],
        })
      );
    }

    /* ── 負荷テスト用テーブル権限付与（再有効化時にコメント解除）──────────
     * badTable.grantReadData(this.queryFunction);
     * goodGsiTable.grantReadData(this.queryFunction);
     * badOnDemandTable.grantReadData(this.queryFunction);
     *
     * badTable.grantWriteData(this.shipFunction);
     * goodGsiTable.grantWriteData(this.shipFunction);
     * badOnDemandTable.grantWriteData(this.shipFunction);
     *
     * badTable.grantReadWriteData(this.loadTestStartFunction);
     * goodGsiTable.grantReadWriteData(this.loadTestStartFunction);
     * badOnDemandTable.grantReadWriteData(this.loadTestStartFunction);
     *
     * badTable.grantWriteData(this.seedFunction);
     * goodGsiTable.grantWriteData(this.seedFunction);
     * badOnDemandTable.grantWriteData(this.seedFunction);
     *
     * badTable.grantReadWriteData(this.onlineImpactTestFunction);
     * goodGsiTable.grantReadWriteData(this.onlineImpactTestFunction);
     * badOnDemandTable.grantReadWriteData(this.onlineImpactTestFunction);
     * ───────────────────────────────────────────────────────────────── */
  }
}
