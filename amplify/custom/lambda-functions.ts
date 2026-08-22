import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Duration, Stack } from 'aws-cdk-lib';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { EMBEDDING_MODEL_ID } from '../functions/shared/vector/embedding-generator';

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
  /**
   * ベクトル検索比較（vector-search-comparison）の配線。
   * 省略した場合はベクトル検索関連の Lambda を 1 つも作らない（既存構成と同一の出力になる）。
   */
  vector?: VectorSearchWiringProps;
  // 負荷テスト用（再有効化時にコメント解除）
  // badTable?: dynamodb.Table;
  // goodGsiTable?: dynamodb.Table;
  // badOnDemandTable?: dynamodb.Table;
}

/**
 * ベクトル検索比較用 Lambda 群の配線情報。
 *
 * `searchEnabled` はデプロイ段階ゲート（CDK コンテキストフラグ `vectorCollectionEnabled`、
 * 設計「デプロイ順序とゲート条件」の Stage A / Stage B）をそのまま受け取る。
 *
 * - `searchEnabled === false`（Stage A）: `kiro-vector-embed-batch` のみを作る。
 *   Stage A では `phase = "copy"`（Good_Table から Vector_Table への複製）だけを実行するため、
 *   検索系 3 本と Capabilities、および Collection 依存の環境変数・IAM は作らない
 * - `searchEnabled === true`（Stage B）: 5 本すべてを作る
 */
export interface VectorSearchWiringProps {
  /** Vector_Table（`kiro-roasters-inventory-vector`） */
  vectorTable: dynamodb.Table;
  /** Query_Vector_Cache（`kiro-vector-query-cache`） */
  queryCacheTable: dynamodb.Table;
  /**
   * 埋め込みの次元数。
   *
   * クエリ埋め込み / DynamoDB 検索 / バッチ / Vector Index の 4 者へ**同一値**を配る。
   * 3 者で食い違うと検索が `DIMENSION_MISMATCH` になるため、解決は呼び出し側（`backend.ts`）の
   * 1 箇所に集約する。
   */
  dimensions: number;
  /**
   * 検索系 Lambda（`kiro-vector-query-embed` / `kiro-vector-search-ddb` /
   * `kiro-vector-search-aoss`）と `kiro-vector-capabilities` を作るか。
   * Vector Index / Vector Collection の作成段階と同じフラグで切り替える（要件 7.5）。
   */
  searchEnabled: boolean;
  /**
   * 2 本のベクトルインデックス（`byEmbeddingJa` / `byEmbeddingEn`）の ARN。
   * `dynamodb:SearchVectors` の Resource になる唯一の入力（要件 17.1）。
   */
  vectorIndexArns?: readonly string[];
  /** Vector_Collection のエンドポイント URL（`OPENSEARCH_VECTOR_ENDPOINT`） */
  vectorCollectionEndpoint?: string;
  /** Vector_Collection の ARN（`aoss:APIAccessAll` の Resource、要件 17.4 / 17.12） */
  vectorCollectionArn?: string;
  /** OpenSearch のインデックス名（`VECTOR_INDEX_NAME`） */
  vectorIndexName: string;
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
  /** `kiro-vector-embed-batch`（Stage A から作る） */
  vectorEmbedBatchFunction?: lambda.Function;
  /** `kiro-vector-query-embed`（Stage B のみ） */
  vectorQueryEmbedFunction?: lambda.Function;
  /** `kiro-vector-search-ddb`（Stage B のみ） */
  vectorSearchDdbFunction?: lambda.Function;
  /** `kiro-vector-search-aoss`（Stage B のみ） */
  vectorSearchAossFunction?: lambda.Function;
  /** `kiro-vector-capabilities`（Stage B のみ） */
  vectorCapabilitiesFunction?: lambda.Function;
}

/**
 * Query_Vector_Cache の TTL 秒数（`VECTOR_QUERY_CACHE_TTL_SECONDS`）。
 *
 * `dynamodb-tables.ts` の `queryCacheTable`（TTL 属性 `expiresAt`）と
 * `vector-query-embed/handler.ts` の既定値に合わせた明示設定。
 */
const VECTOR_QUERY_CACHE_TTL_SECONDS = 300;

/**
 * 埋め込みバッチの Bedrock 呼び出しレート（`VECTOR_EMBEDDING_REQUESTS_PER_MINUTE`、要件 4.1）。
 * 既定値と同じ値を明示的に渡す。実行時はリクエストパラメータで上書きできる。
 */
const VECTOR_EMBEDDING_REQUESTS_PER_MINUTE = 120;

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
 *
 * ベクトル検索比較（`props.vector` 指定時のみ）:
 * - vector-embed-batch: Good_Table から Vector_Table への複製 + 日英埋め込み生成（Stage A から）
 * - vector-query-embed: クエリ埋め込み生成（Stage B のみ）
 * - vector-search-ddb: DynamoDB `SearchVectors`（Stage B のみ）
 * - vector-search-aoss: OpenSearch Serverless k-NN（Stage B のみ）
 * - vector-capabilities: 機能制約メタデータ（Stage B のみ）
 */
export class LambdaFunctionsConstruct extends Construct implements LambdaFunctions {
  public readonly queryFunction: lambda.Function;
  public readonly shipFunction: lambda.Function;
  public readonly loadTestStartFunction: lambda.Function;
  public readonly loadTestStatusFunction: lambda.Function;
  public readonly seedFunction: lambda.Function;
  public readonly onlineImpactTestFunction: lambda.Function;
  public readonly opensearchSearchFunction?: lambda.Function;
  public readonly vectorEmbedBatchFunction?: lambda.Function;
  public readonly vectorQueryEmbedFunction?: lambda.Function;
  public readonly vectorSearchDdbFunction?: lambda.Function;
  public readonly vectorSearchAossFunction?: lambda.Function;
  public readonly vectorCapabilitiesFunction?: lambda.Function;

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

    // ─── ベクトル検索比較（vector-search-comparison）──────────────────
    // 既存 Lambda の定義・環境変数・権限には一切手を入れず、追加分のみを定義する（要件 17.13）。
    if (props.vector) {
      const vector = props.vector;
      const region = Stack.of(this).region;

      // Bedrock のモデル ARN 1 件のみ。`Resource: "*"` とモデル ID のワイルドカードは使わない
      // （要件 17.5 / 17.6）。モデル ID は Embedding_Generator と同一の出典から取る
      const embeddingModelArn = `arn:aws:bedrock:${region}::foundation-model/${EMBEDDING_MODEL_ID}`;

      // ── kiro-vector-embed-batch（Stage A から作る）───────────────────
      // 15 分 / 1024 MB。ハンドラの自己再帰判定（残り 120 秒）が 15 分を前提にしている
      const embedBatchEnv: Record<string, string> = {
        GOOD_TABLE_NAME: goodTable.tableName,
        VECTOR_TABLE_NAME: vector.vectorTable.tableName,
        EXECUTIONS_TABLE_NAME: executionsTable.tableName,
        VECTOR_INDEX_NAME: vector.vectorIndexName,
        VECTOR_EMBEDDING_DIMENSIONS: String(vector.dimensions),
        VECTOR_EMBEDDING_REQUESTS_PER_MINUTE: String(VECTOR_EMBEDDING_REQUESTS_PER_MINUTE),
      };
      // Stage A（Collection 未作成）では設定しない。`phase = "embed"` は必須変数の欠落として
      // 実行を拒否し、`phase = "copy"` は OpenSearch を使わないため影響を受けない
      if (vector.vectorCollectionEndpoint) {
        embedBatchEnv.OPENSEARCH_VECTOR_ENDPOINT = vector.vectorCollectionEndpoint;
      }

      // `@opensearch-project/opensearch` は関数ローカルの package.json から解決される
      // （esbuild は entry のディレクトリから node_modules を辿る。既存 opensearch-search と同方式）
      this.vectorEmbedBatchFunction = new nodejs.NodejsFunction(this, 'VectorEmbedBatchFunction', {
        ...commonProps,
        functionName: 'kiro-vector-embed-batch',
        entry: join(functionsDir, 'vector-embed-batch', 'handler.ts'),
        handler: 'handler',
        timeout: Duration.minutes(15),
        memorySize: 1024,
        environment: embedBatchEnv,
        description: 'Copies Good_Table into Vector_Table and generates ja/en embeddings',
      });

      // Good_Table は読み取りのみ。テーブル ARN と 3 GSI の ARN に `dynamodb:Query` だけを与える
      // （書き込み Action を一切含めない、要件 17.10）。ハンドラは GSI byWarehouse への
      // Query しか発行しないため、Scan / GetItem も付与しない
      this.vectorEmbedBatchFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['dynamodb:Query'],
          resources: [
            goodTable.tableArn,
            `${goodTable.tableArn}/index/byWarehouse`,
            `${goodTable.tableArn}/index/byLocation`,
            `${goodTable.tableArn}/index/byUnitPrice`,
          ],
        })
      );

      // Vector_Table への読み書き。テーブル ARN のみを Resource にし、
      // `dynamodb:DeleteTable` と `Resource: "*"` を含めない（要件 17.11）
      this.vectorEmbedBatchFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [
            'dynamodb:PutItem',
            'dynamodb:UpdateItem',
            'dynamodb:BatchWriteItem',
            'dynamodb:GetItem',
            'dynamodb:Query',
            'dynamodb:Scan',
          ],
          resources: [vector.vectorTable.tableArn],
        })
      );

      // 進捗レコード（load-test-executions）。既存 Lambda の権限とは独立した新規ステートメント
      this.vectorEmbedBatchFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
          resources: [executionsTable.tableArn],
        })
      );

      // Bedrock はモデル ARN 1 件のみ（要件 17.5）
      this.vectorEmbedBatchFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel'],
          resources: [embeddingModelArn],
        })
      );

      // 自己再帰起動。自身の functionArn を参照すると Policy -> Function -> Role の循環に
      // なるため、既存 load-test-start と同じく関数名リテラルで表す
      this.vectorEmbedBatchFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: ['arn:aws:lambda:*:*:function:kiro-vector-embed-batch'],
        })
      );

      // Vector_Collection への書き込みは IAM（`aoss:APIAccessAll`）とデータアクセスポリシー
      // （`WriteDocument`）の両方が必要。後者は vector-collection.ts が
      // `embeddingJobRoleArn` から定義する（要件 17.12）
      if (vector.vectorCollectionArn) {
        this.vectorEmbedBatchFunction.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['aoss:APIAccessAll'],
            resources: [vector.vectorCollectionArn],
          })
        );
      }

      if (vector.searchEnabled) {
        // ── kiro-vector-query-embed（30 秒 / 512 MB）──────────────────
        this.vectorQueryEmbedFunction = new nodejs.NodejsFunction(this, 'VectorQueryEmbedFunction', {
          ...commonProps,
          functionName: 'kiro-vector-query-embed',
          entry: join(functionsDir, 'vector-query-embed', 'handler.ts'),
          handler: 'handler',
          timeout: Duration.seconds(30),
          memorySize: 512,
          environment: {
            QUERY_CACHE_TABLE_NAME: vector.queryCacheTable.tableName,
            VECTOR_QUERY_CACHE_TTL_SECONDS: String(VECTOR_QUERY_CACHE_TTL_SECONDS),
            VECTOR_EMBEDDING_DIMENSIONS: String(vector.dimensions),
          },
          description: 'Generates one query embedding and stores it in the query vector cache',
        });

        // Bedrock モデル ARN 1 件のみ（要件 17.6）
        this.vectorQueryEmbedFunction.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['bedrock:InvokeModel'],
            resources: [embeddingModelArn],
          })
        );

        // Query_Vector_Cache の PutItem / GetItem のみ。Vector_Table、Good_Table、
        // OpenSearch Serverless に対する Action を一切持たない（要件 17.6）
        this.vectorQueryEmbedFunction.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['dynamodb:PutItem', 'dynamodb:GetItem'],
            resources: [vector.queryCacheTable.tableArn],
          })
        );

        // ── kiro-vector-search-ddb（30 秒 / 512 MB）───────────────────
        // `DYNAMODB_SEARCH_ENDPOINT` は設定しない。ハンドラが AWS_REGION から
        // `https://search-dynamodb.<region>.api.aws` を導出する（上書き用の任意変数）
        this.vectorSearchDdbFunction = new nodejs.NodejsFunction(this, 'VectorSearchDdbFunction', {
          ...commonProps,
          // このバンドル設定は**この 1 本にのみ**適用する（`commonProps` を変えない）。
          // `vector-index.ts` の Index_Provisioner と同じ措置で、理由も同じ系統だが、
          // 防いでいる失敗の種類が異なるため区別して残す。
          //
          // `NodejsFunction` は Node 18+ で `externalModules: ['@aws-sdk/*']` を既定とし、
          // `@aws-sdk/client-dynamodb` を Lambda 同梱の SDK へ解決する。同梱 SDK のモデルには
          // `TableDescription.VectorIndexes` が無く（境界は 3.1103.0。それ未満では欠落する）、
          // AWS SDK v3 の逆シリアライズはモデル駆動であるため、**モデルに無いフィールドは
          // エラーも警告もなく捨てられる**。`DescribeTable` の応答に情報が入っていても
          // `handler.ts` の `readVectorIndexDescriptions()` は空配列を受け取り、ACTIVE な
          // インデックスを「存在しない」と判定して `INDEX_NOT_FOUND` を返す。
          //
          // Index_Provisioner 側は「新しい API パラメータ（`VectorIndexUpdates`）が
          // 同梱 SDK に無いとリクエストが**拒否される**」ケースだが、こちらは
          // リクエストは通り、サービスが返した情報だけが黙って消える。
          // ローカルの単体テストは `DescribeTable` を差し替えるため原理的に検出できない
          // （回帰ガードは `vector-search-ddb-bundling.test.ts` が合成側で持つ）。
          // `SearchVectors` は生 HTTP を自前署名しておりモデルに依存しないため、
          // 壊れるのは `DescribeTable` の解析経路だけである。
          bundling: {
            ...commonProps.bundling,
            externalModules: [],
          },
          functionName: 'kiro-vector-search-ddb',
          entry: join(functionsDir, 'vector-search-ddb', 'handler.ts'),
          handler: 'handler',
          timeout: Duration.seconds(30),
          memorySize: 512,
          environment: {
            VECTOR_TABLE_NAME: vector.vectorTable.tableName,
            QUERY_CACHE_TABLE_NAME: vector.queryCacheTable.tableName,
            VECTOR_EMBEDDING_DIMENSIONS: String(vector.dimensions),
          },
          description: 'Runs DynamoDB SearchVectors against one vector index per language',
        });

        // `dynamodb:SearchVectors` のみを列挙し、Resource を 2 本のインデックス ARN のみに
        // 限定する。Vector_Table のテーブル ARN、書き込み Action、`dynamodb:*` を含めない。
        // `Query` / `Scan` / PartiQL も付与しない（要件 5.16 / 17.1）
        const vectorIndexArns = vector.vectorIndexArns ?? [];
        if (vectorIndexArns.length === 0) {
          throw new Error(
            'LambdaFunctionsConstruct: vector.vectorIndexArns is required when vector.searchEnabled is true. ' +
              'kiro-vector-search-ddb cannot be granted dynamodb:SearchVectors without the vector index ARNs.'
          );
        }
        this.vectorSearchDdbFunction.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['dynamodb:SearchVectors'],
            resources: [...vectorIndexArns],
          })
        );

        // インデックス準備状態の確認（要件 5.15 / 16.2 / 16.3）に必要な `DescribeTable` を
        // 別ステートメントとして定義する。要件 17.1 が禁じているのは `SearchVectors` の
        // Resource にテーブル ARN を含めることであり、状態確認のための読み取りは別権限である
        this.vectorSearchDdbFunction.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['dynamodb:DescribeTable'],
            resources: [vector.vectorTable.tableArn],
          })
        );

        // queryId からクエリベクトルと言語を解決する
        this.vectorSearchDdbFunction.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['dynamodb:GetItem'],
            resources: [vector.queryCacheTable.tableArn],
          })
        );

        // ── kiro-vector-search-aoss（60 秒 / 512 MB）──────────────────
        if (!vector.vectorCollectionEndpoint || !vector.vectorCollectionArn) {
          throw new Error(
            'LambdaFunctionsConstruct: vector.vectorCollectionEndpoint and vector.vectorCollectionArn are ' +
              'required when vector.searchEnabled is true (kiro-vector-search-aoss needs the collection).'
          );
        }

        // `OPENSEARCH_SCORE_FORMULA` は設定しない。既定式の出典を
        // `shared/vector/score-normalize.ts` の 1 箇所に保ち、キャリブレーション（要件 9.6）で
        // 式を差し替える場合もコード側の既定値を変えるだけで済ませる
        this.vectorSearchAossFunction = new nodejs.NodejsFunction(this, 'VectorSearchAossFunction', {
          ...commonProps,
          functionName: 'kiro-vector-search-aoss',
          entry: join(functionsDir, 'vector-search-aoss', 'handler.ts'),
          handler: 'handler',
          timeout: Duration.seconds(60),
          memorySize: 512,
          environment: {
            OPENSEARCH_VECTOR_ENDPOINT: vector.vectorCollectionEndpoint,
            VECTOR_INDEX_NAME: vector.vectorIndexName,
            QUERY_CACHE_TABLE_NAME: vector.queryCacheTable.tableName,
            // Vector_Verification_Path（`POST /vector-search/verify`）が読む対象。
            // 検索経路では使わない
            VECTOR_TABLE_NAME: vector.vectorTable.tableName,
            VECTOR_EMBEDDING_DIMENSIONS: String(vector.dimensions),
          },
          description:
            'Runs OpenSearch Serverless k-NN search per language and verifies stored vectors',
        });

        // Collection ARN のみを Resource とした `aoss:APIAccessAll`。読み取りに絞るのは
        // データアクセスポリシー側（ReadDocument / DescribeIndex のみ）で行う（要件 17.4）。
        // 検証経路（`_mget`）も同一の読み取り権限だけを使い、追加の `aoss` 権限を要求しない
        this.vectorSearchAossFunction.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['aoss:APIAccessAll'],
            resources: [vector.vectorCollectionArn],
          })
        );

        // queryId からクエリベクトルと言語を解決する
        this.vectorSearchAossFunction.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['dynamodb:GetItem'],
            resources: [vector.queryCacheTable.tableArn],
          })
        );

        // Vector_Verification_Path 用（要件 17.15、案 D）。
        // **新規ステートメントとして追加する**（既存の権限を書き換えない）。
        // Action は `dynamodb:GetItem` のみ、Resource は Vector_Table のテーブル ARN のみ。
        // `dynamodb:SearchVectors` / `Query` / `Scan` / 書き込み Action / Good_Table の ARN /
        // `Resource: "*"` を含めない。ベクトルインデックスの ARN も含めない
        // （検証は `GetItem` と `_mget` のみで行い `SearchVectors` を使わない）
        this.vectorSearchAossFunction.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['dynamodb:GetItem'],
            resources: [vector.vectorTable.tableArn],
          })
        );

        // ── kiro-vector-capabilities（10 秒）──────────────────────────
        // 環境変数を参照せず AWS API も呼ばないため、環境変数と IAM 権限を与えない
        this.vectorCapabilitiesFunction = new nodejs.NodejsFunction(this, 'VectorCapabilitiesFunction', {
          ...commonProps,
          functionName: 'kiro-vector-capabilities',
          entry: join(functionsDir, 'vector-capabilities', 'handler.ts'),
          handler: 'handler',
          timeout: Duration.seconds(10),
          description: 'Returns the vector search capability metadata as a read only endpoint',
        });
      }
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
