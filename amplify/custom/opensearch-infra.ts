import { Construct } from 'constructs';
import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as opensearchserverless from 'aws-cdk-lib/aws-opensearchserverless';
import * as osis from 'aws-cdk-lib/aws-osis';
import * as logs from 'aws-cdk-lib/aws-logs';

/**
 * OpenSearch インフラ Construct の入力インターフェース
 */
export interface OpenSearchInfraProps {
  /** データ同期元の DynamoDB テーブル */
  sourceTable: dynamodb.Table;
  /** OpenSearch 検索 Lambda のロール ARN（Data Access Policy に追加する） */
  lambdaRoleArn?: string;
}

/**
 * OpenSearch Serverless NextGen のリソースを定義する Construct。
 *
 * - Collection Group: scale-to-zero 対応の NextGen グループ
 * - Encryption Policy: AWS 所有キーによる暗号化
 * - Network Policy: パブリックアクセス許可（検証用途）
 * - Collection: Search タイプ、Collection Group に所属
 * - S3 Bucket: PITR エクスポート用
 * - Pipeline IAM Role: DynamoDB Streams 読み取り + S3 読み書き + OpenSearch 書き込み
 * - Data Access Policy: Pipeline ロール + Lambda ロールへのアクセス許可
 */
export class OpenSearchInfraConstruct extends Construct {
  /** OpenSearch Collection のエンドポイント URL */
  public readonly collectionEndpoint: string;
  /** Collection の ARN */
  public readonly collectionArn: string;
  /** Ingestion Pipeline のパイプライン名（タスク 1.4 で設定） */
  public readonly pipelineName: string;
  /** Ingestion Pipeline 用の IAM ロール */
  public readonly pipelineRole: iam.Role;
  /** PITR エクスポート用の S3 バケット */
  public readonly exportBucket: s3.Bucket;
  /** Data Access Policy（事後的に Principal を追加するために公開） */
  public readonly dataAccessPolicy: opensearchserverless.CfnAccessPolicy;

  constructor(scope: Construct, id: string, props: OpenSearchInfraProps) {
    super(scope, id);

    const collectionName = 'kiro-inventory-search';
    const collectionGroupName = 'kiro-inventory-group';
    const region = Stack.of(this).region;
    const account = Stack.of(this).account;

    // ─── Collection Group: scale-to-zero 設定 ─────────────────────────
    const collectionGroup = new opensearchserverless.CfnCollectionGroup(this, 'CollectionGroup', {
      name: collectionGroupName,
      standbyReplicas: 'ENABLED',
      capacityLimits: {
        minIndexingCapacityInOcu: 0,
        minSearchCapacityInOcu: 0,
        maxIndexingCapacityInOcu: 16,
        maxSearchCapacityInOcu: 16,
      },
      description: 'Kiro Roasters inventory search comparison Collection Group (NextGen)',
    });
    // CDK の型定義に generation が未反映のため、L1 escape hatch で設定
    collectionGroup.addPropertyOverride('Generation', 'NEXTGEN');

    // ─── Encryption Policy: AWS 所有キーによる暗号化 ──────────────────
    const encryptionPolicy = new opensearchserverless.CfnSecurityPolicy(this, 'EncryptionPolicy', {
      name: `${collectionName}-enc`,
      type: 'encryption',
      policy: JSON.stringify({
        Rules: [
          {
            ResourceType: 'collection',
            Resource: [`collection/${collectionName}`],
          },
        ],
        AWSOwnedKey: true,
      }),
      description: 'Encryption policy for kiro-inventory-search collection (AWS owned key)',
    });

    // ─── Network Policy: パブリックアクセス許可（検証用途）────────────
    const networkPolicy = new opensearchserverless.CfnSecurityPolicy(this, 'NetworkPolicy', {
      name: `${collectionName}-net`,
      type: 'network',
      policy: JSON.stringify([
        {
          Rules: [
            {
              ResourceType: 'collection',
              Resource: [`collection/${collectionName}`],
            },
            {
              ResourceType: 'dashboard',
              Resource: [`collection/${collectionName}`],
            },
          ],
          AllowFromPublic: true,
        },
      ]),
      description: 'Network policy for kiro-inventory-search collection (public access for verification)',
    });

    // ─── Collection: Search タイプ、Collection Group 所属 ─────────────
    const collection = new opensearchserverless.CfnCollection(this, 'Collection', {
      name: collectionName,
      type: 'SEARCH',
      collectionGroupName: collectionGroupName,
      description: 'Kiro Roasters inventory search comparison OpenSearch Serverless Collection',
    });

    // ─── 依存関係の設定 ───────────────────────────────────────────────
    // Collection Group → Collection の依存関係を明示（単一デプロイで成功させるため）
    collection.addDependency(collectionGroup);
    // Encryption Policy が存在しないと Collection 作成が失敗するため依存を追加
    collection.addDependency(encryptionPolicy);
    // Network Policy も先に作成する必要がある
    collection.addDependency(networkPolicy);

    // ─── S3 Bucket: PITR エクスポート用 ──────────────────────────────
    this.exportBucket = new s3.Bucket(this, 'ExportBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ─── Ingestion Pipeline IAM Role ─────────────────────────────────
    this.pipelineRole = new iam.Role(this, 'PipelineRole', {
      assumedBy: new iam.ServicePrincipal('osis-pipelines.amazonaws.com'),
      description: 'IAM role for OpenSearch Ingestion Pipeline (DynamoDB -> OpenSearch)',
    });

    // DynamoDB テーブル操作権限
    this.pipelineRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'dynamodb:DescribeTable',
        'dynamodb:DescribeContinuousBackups',
      ],
      resources: [props.sourceTable.tableArn],
    }));

    // DynamoDB エクスポート権限（export サブリソース ARN が必要）
    this.pipelineRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'dynamodb:DescribeExport',
        'dynamodb:ExportTableToPointInTime',
      ],
      resources: [
        props.sourceTable.tableArn,
        `${props.sourceTable.tableArn}/export/*`,
      ],
    }));

    // DynamoDB Streams 読み取り権限
    this.pipelineRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'dynamodb:DescribeStream',
        'dynamodb:GetShardIterator',
        'dynamodb:GetRecords',
      ],
      resources: [`${props.sourceTable.tableArn}/stream/*`],
    }));

    // S3 エクスポートバケット読み書き権限
    this.pipelineRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:GetObject', 's3:ListBucket', 's3:GetBucketLocation'],
      resources: [this.exportBucket.bucketArn, `${this.exportBucket.bucketArn}/*`],
    }));

    // OpenSearch Serverless 権限（OSIS Pipeline が Collection アクセス検証 + Network Policy 更新に必要）
    this.pipelineRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'aoss:APIAccessAll',
        'aoss:BatchGetCollection',
        'aoss:CreateSecurityPolicy',
        'aoss:GetSecurityPolicy',
        'aoss:UpdateSecurityPolicy',
      ],
      resources: ['*'],
    }));

    // ─── Data Access Policy: Pipeline ロール + Lambda ロール ──────────
    const principals: string[] = [this.pipelineRole.roleArn];
    if (props.lambdaRoleArn) {
      principals.push(props.lambdaRoleArn);
    }

    this.dataAccessPolicy = new opensearchserverless.CfnAccessPolicy(this, 'DataAccessPolicy', {
      name: `${collectionName}-data`,
      type: 'data',
      policy: JSON.stringify([
        {
          Rules: [
            {
              ResourceType: 'index',
              Resource: [`index/${collectionName}/*`],
              Permission: [
                'aoss:CreateIndex',
                'aoss:UpdateIndex',
                'aoss:DescribeIndex',
                'aoss:ReadDocument',
                'aoss:WriteDocument',
              ],
            },
            {
              ResourceType: 'collection',
              Resource: [`collection/${collectionName}`],
              Permission: [
                'aoss:CreateCollectionItems',
                'aoss:UpdateCollectionItems',
                'aoss:DescribeCollectionItems',
              ],
            },
          ],
          Principal: principals,
        },
      ]),
      description: 'Data access policy for pipeline and Lambda roles to access inventory index',
    });

    // Data Access Policy は Collection が存在してから有効になる
    this.dataAccessPolicy.addDependency(collection);

    // ─── Ingestion Pipeline: DynamoDB → OpenSearch ─────────────────────
    const pipelineName = 'kiro-inventory-pipeline';

    // CloudWatch Logs グループ（パイプラインログ用）
    const pipelineLogGroup = new logs.LogGroup(this, 'PipelineLogGroup', {
      logGroupName: `/aws/vendedlogs/osis/${pipelineName}`,
      removalPolicy: RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_WEEK,
    });

    // Pipeline 設定 YAML
    const pipelineConfigYaml = `
version: "2"
dynamodb-pipeline:
  source:
    dynamodb:
      acknowledgments: true
      tables:
        - table_arn: "${props.sourceTable.tableArn}"
          stream:
            start_position: "LATEST"
          export:
            s3_bucket: "${this.exportBucket.bucketName}"
            s3_region: "${region}"
            s3_prefix: "ddb-export/"
      aws:
        sts_role_arn: "${this.pipelineRole.roleArn}"
        region: "${region}"
  sink:
    - opensearch:
        hosts:
          - "${collection.attrCollectionEndpoint}"
        index: "inventory"
        index_type: "custom"
        document_id: "\${getMetadata(\\"primary_key\\")}"
        action: "\${getMetadata(\\"opensearch_action\\")}"
        document_version: "\${getMetadata(\\"document_version\\")}"
        document_version_type: "external"
        aws:
          sts_role_arn: "${this.pipelineRole.roleArn}"
          region: "${region}"
          serverless: true
          serverless_options:
            network_policy_name: "${collectionName}-net"
            collection_name: "${collectionName}"
`;

    const pipeline = new osis.CfnPipeline(this, 'IngestionPipeline', {
      pipelineName: pipelineName,
      minUnits: 1,
      maxUnits: 4,
      pipelineConfigurationBody: pipelineConfigYaml,
      logPublishingOptions: {
        cloudWatchLogDestination: {
          logGroup: pipelineLogGroup.logGroupName,
        },
        isLoggingEnabled: true,
      },
    });

    // PipelineRoleArn: CloudFormation がパイプライン作成時にロールを正しく関連付けるために必要
    pipeline.addPropertyOverride('PipelineRoleArn', this.pipelineRole.roleArn);

    // Pipeline は Collection と Data Access Policy が作成された後に作成する
    pipeline.addDependency(collection);
    pipeline.addDependency(this.dataAccessPolicy);
    // IAM eventual consistency 対策: Pipeline Role のポリシーが反映されるのを待つ
    pipeline.node.addDependency(this.pipelineRole);

    // ─── 出力プロパティ ──────────────────────────────────────────────
    this.collectionEndpoint = collection.attrCollectionEndpoint;
    this.collectionArn = collection.attrArn;
    this.pipelineName = pipelineName;
  }
}
