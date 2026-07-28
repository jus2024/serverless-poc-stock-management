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
 */
export interface LambdaFunctionsProps {
  badTable: dynamodb.Table;
  goodTable: dynamodb.Table;
  goodGsiTable: dynamodb.Table;
  badOnDemandTable: dynamodb.Table;
  executionsTable: dynamodb.Table;
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
}

/**
 * Kiro Roasters 在庫管理検証用 Lambda 関数を定義する Construct。
 *
 * - inventory-query: Bad_Table / Good_Table からの在庫照会
 * - inventory-ship: 出庫処理（在庫減算）
 * - load-test-start: 負荷生成開始 + ワーカー非同期起動
 * - load-test-status: 負荷テスト実行ステータス取得
 * - seed: 初期データ投入（15,000 レコード × 4 テーブル）
 */
export class LambdaFunctionsConstruct extends Construct implements LambdaFunctions {
  public readonly queryFunction: lambda.Function;
  public readonly shipFunction: lambda.Function;
  public readonly loadTestStartFunction: lambda.Function;
  public readonly loadTestStatusFunction: lambda.Function;
  public readonly seedFunction: lambda.Function;
  public readonly onlineImpactTestFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: LambdaFunctionsProps) {
    super(scope, id);

    const { badTable, goodTable, goodGsiTable, badOnDemandTable, executionsTable } = props;

    // 共通環境変数
    const commonEnv: Record<string, string> = {
      BAD_TABLE_NAME: badTable.tableName,
      GOOD_TABLE_NAME: goodTable.tableName,
      GOOD_GSI_TABLE_NAME: goodGsiTable.tableName,
      BAD_ONDEMAND_TABLE_NAME: badOnDemandTable.tableName,
      EXECUTIONS_TABLE_NAME: executionsTable.tableName,
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

    // Read access to Bad_Table, Good_Table, Good_GSI_Table and Bad_OnDemand_Table
    badTable.grantReadData(this.queryFunction);
    goodTable.grantReadData(this.queryFunction);
    goodGsiTable.grantReadData(this.queryFunction);
    badOnDemandTable.grantReadData(this.queryFunction);

    // ─── inventory-ship ────────────────────────────────────────────
    this.shipFunction = new nodejs.NodejsFunction(this, 'ShipFunction', {
      ...commonProps,
      functionName: 'kiro-inventory-ship',
      entry: join(functionsDir, 'inventory-ship', 'handler.ts'),
      handler: 'handler',
      timeout: Duration.seconds(30),
      environment: commonEnv,
    });

    // Write access to Bad_Table, Good_Table, Good_GSI_Table and Bad_OnDemand_Table
    badTable.grantWriteData(this.shipFunction);
    goodTable.grantWriteData(this.shipFunction);
    goodGsiTable.grantWriteData(this.shipFunction);
    badOnDemandTable.grantWriteData(this.shipFunction);

    // ─── load-test-start ───────────────────────────────────────────
    // メモリ 2048MB: Lambda の CPU はメモリ比例配分（1024MB=0.6vCPU, 2048MB=1.2vCPU）。
    //   1024MB / 500 req/s では並列 HTTPS を捌ききれず、1 秒分の Promise.all に
    //   約 3.1 秒かかり実効 RPS が目標の約 1/3 に低下した（2000 目標 → 実測 635）。
    //   ワーカーあたり 150 req/s（handler 側の WORKER_RPS_CAPACITY）と併せて、
    //   宣言した RPS が実際に出るようにする。
    // タイムアウト 10 分: 最大テスト時間 300 秒 + スロットル時の Promise.all 遅延
    //   （1秒ループが 1.5〜2 秒に伸びうる）+ SKU Scan 等の初期化 + 安全マージン。
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

    // Write access to Bad_Table, Good_Table, Good_GSI_Table and Bad_OnDemand_Table (for worker operations)
    badTable.grantWriteData(this.loadTestStartFunction);
    goodTable.grantWriteData(this.loadTestStartFunction);
    goodGsiTable.grantWriteData(this.loadTestStartFunction);
    badOnDemandTable.grantWriteData(this.loadTestStartFunction);

    // Read access to Bad_Table, Good_Table, Good_GSI_Table and Bad_OnDemand_Table (for SKU scanning)
    badTable.grantReadData(this.loadTestStartFunction);
    goodTable.grantReadData(this.loadTestStartFunction);
    goodGsiTable.grantReadData(this.loadTestStartFunction);
    badOnDemandTable.grantReadData(this.loadTestStartFunction);

    // Self-invoke permission for async worker invocation
    // Inline policy avoids circular dependency with API Gateway
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

    // Write access to Bad_Table, Good_Table, Good_GSI_Table and Bad_OnDemand_Table
    badTable.grantWriteData(this.seedFunction);
    goodTable.grantWriteData(this.seedFunction);
    goodGsiTable.grantWriteData(this.seedFunction);
    badOnDemandTable.grantWriteData(this.seedFunction);

    // ─── online-impact-test ────────────────────────────────────────
    // メモリ 1024MB: 既定の 128MB（0.08 vCPU）では SigV4 署名と TLS ハンドシェイクが
    //   CPU 待ちになり、負荷ゼロでも UpdateItem の計測値が avg 599ms / p95 802ms に
    //   膨れた（正常値は 5〜15ms）。この底上げがあるとスロットリング由来の遅延が
    //   観測できないため、計測用途として十分な CPU を確保する。
    // タイムアウト 5 分: iterations で最大 12 ラウンド × 20 秒 = 240 秒の連続測定を
    //   許容するため。負荷ウィンドウ全体を 1 回の起動でカバーできるようにする。
    this.onlineImpactTestFunction = new nodejs.NodejsFunction(this, 'OnlineImpactTestFunction', {
      ...commonProps,
      functionName: 'kiro-online-impact-test',
      entry: join(functionsDir, 'online-impact-test', 'handler.ts'),
      handler: 'handler',
      timeout: Duration.minutes(5),
      memorySize: 1024,
      environment: commonEnv,
    });

    // Read + Write access to Bad_Table, Good_Table, Good_GSI_Table and Bad_OnDemand_Table
    badTable.grantReadWriteData(this.onlineImpactTestFunction);
    goodTable.grantReadWriteData(this.onlineImpactTestFunction);
    goodGsiTable.grantReadWriteData(this.onlineImpactTestFunction);
    badOnDemandTable.grantReadWriteData(this.onlineImpactTestFunction);
  }
}
