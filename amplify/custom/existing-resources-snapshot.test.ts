import { describe, expect, it } from 'vitest';
import { App, Lazy, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';

import { InventoryTablesConstruct } from './dynamodb-tables';
import { LambdaFunctionsConstruct } from './lambda-functions';
import { OpenSearchInfraConstruct } from './opensearch-infra';
import { VectorCollectionConstruct } from './vector-collection';
import { VectorIndexConstruct } from './vector-index';

/**
 * 既存リソースの差分ゼロを機械的に固定するスナップショットテスト（task 7.4）。
 *
 * 本機能（vector-search-comparison）は既存の Good_Table と既存 OpenSearch 一式に
 * 一切手を入れないことを前提に設計されている（要件 1.4 / 1.5 / 6.3 / 17.8 / 17.10 / 17.13）。
 * その前提はレビューでは守れないため、合成テンプレートに対する 3 層の検証で固定する。
 *
 * 1. 凍結スナップショット: 既存リソースの合成結果を本機能の追加前の値としてリテラルで固定する。
 *    `vitest -u` で書き換わる `.snap` ファイルを使わず、コード上のリテラルとして置く。
 * 2. 差分ゼロ比較: 本機能の配線を「渡さない」ベースラインスタックと、Stage A / Stage B の
 *    スタックを合成し、既存リソースの合成結果が 3 者で完全一致することを確認する。
 *    1 だけでは「リテラルと実装を同時に書き換える」ことを検出できないため両方置く。
 * 3. IAM 走査: Good_Table のテーブル ARN または 3 GSI の ARN を Resource とする書き込み
 *    Action を持つステートメントの集合が、本機能の追加前と同一であることを確認する。
 *
 * 合成は in-memory のみ。AWS への呼び出しとデプロイは一切行わない。
 */

// ─── CloudFormation テンプレートの最小型 ─────────────────────────────
interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
  DependsOn?: string | string[];
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
}

interface CfnTemplate {
  Resources: Record<string, CfnResource>;
}

/**
 * `Fn::Join` / `Ref` / `Fn::GetAtt` を `${LogicalId}` / `${LogicalId.Attr}` 形式の
 * 文字列へ畳み込んで、合成結果を人が読める形に正規化する。
 *
 * 正規化しないと IAM の Resource や OSIS の設定 YAML が入れ子の `Fn::Join` になり、
 * 期待値をリテラルで書くことも失敗時の差分を読むこともできない。
 * 論理 ID をそのまま残すため、リソースの改名も差分として検出できる。
 */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length === 1) {
    const ref = object.Ref;
    if (keys[0] === 'Ref' && typeof ref === 'string') {
      return `\${${ref}}`;
    }
    const getAtt = object['Fn::GetAtt'];
    if (keys[0] === 'Fn::GetAtt' && Array.isArray(getAtt) && getAtt.length === 2) {
      return `\${${String(getAtt[0])}.${String(getAtt[1])}}`;
    }
    const join = object['Fn::Join'];
    if (keys[0] === 'Fn::Join' && Array.isArray(join) && typeof join[0] === 'string') {
      const parts: unknown[] = Array.isArray(join[1]) ? join[1] : [];
      const normalizedParts = parts.map(normalize);
      if (normalizedParts.every((part) => typeof part === 'string')) {
        return (normalizedParts as string[]).join(join[0]);
      }
    }
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    result[key] = normalize(object[key]);
  }
  return result;
}

// ─── 合成対象のスタック ───────────────────────────────────────────────

/**
 * 合成モード。
 *
 * - `baseline`: 本機能の配線を `LambdaFunctionsConstruct` に渡さない。Vector Collection と
 *   Vector Index も作らない。「本機能の追加前」に相当する合成結果を得るための基準。
 *   `InventoryTablesConstruct` は Vector_Table と Query_Vector_Cache を無条件に作るが、
 *   本テストが比較するのは既存リソースのみであり、この差は比較対象に入らない。
 * - `stageA`: `vectorCollectionEnabled` 未設定。Collection Group と埋め込みバッチのみ。
 * - `stageB`: `vectorCollectionEnabled=true`。Collection / Index / 検索 Lambda まで含む最大構成。
 */
type SynthMode = 'baseline' | 'stageA' | 'stageB';

/** 期待値のリテラルを固定するため、アカウントとリージョンを明示する */
const SYNTH_ENV = { account: '123456789012', region: 'us-west-2' } as const;

/** 本テストで固定する次元数（既定値と同じ。環境変数の影響を受けないよう明示して渡す） */
const TEST_DIMENSIONS = 1024;

/**
 * `backend.ts` と同一の配線でスタックを合成する。
 *
 * `aws:cdk:bundling-stacks: []` で `NodejsFunction` のバンドルを抑止する。
 * 本テストが見るのはテンプレート上のリソース定義と IAM ステートメントであり、
 * Lambda のバンドル成果物は関与しない。抑止しないと合成 1 回ごとに
 * 全 Lambda を esbuild でバンドルすることになる。
 */
function synthesize(mode: SynthMode): CfnTemplate {
  const app = new App({
    context: {
      'aws:cdk:bundling-stacks': [],
      ...(mode === 'stageB' ? { vectorCollectionEnabled: true } : {}),
    },
  });
  // スタック ID は 3 モードで同一にする（論理 ID を突き合わせるため）
  const stack = new Stack(app, 'InventoryStack', { env: SYNTH_ENV });

  const tables = new InventoryTablesConstruct(stack, 'Tables');
  const opensearch = new OpenSearchInfraConstruct(stack, 'OpenSearch', {
    sourceTable: tables.goodTable,
  });

  let functions: LambdaFunctionsConstruct | undefined;
  const requireRoleArn = (
    resolve: () => { role?: { roleArn: string } } | undefined,
    functionName: string
  ): string => {
    const role = resolve()?.role;
    if (!role) {
      throw new Error(`expected the execution role of ${functionName} to exist`);
    }
    return role.roleArn;
  };

  if (mode === 'baseline') {
    functions = new LambdaFunctionsConstruct(stack, 'Functions', {
      goodTable: tables.goodTable,
      executionsTable: tables.executionsTable,
      opensearchEndpoint: opensearch.collectionEndpoint,
      opensearchCollectionArn: opensearch.collectionArn,
    });
  } else {
    const vectorCollection = new VectorCollectionConstruct(stack, 'VectorCollection', {
      dimensions: TEST_DIMENSIONS,
      searchLambdaRoleArn: Lazy.string({
        produce: (): string =>
          requireRoleArn(() => functions?.vectorSearchAossFunction, 'kiro-vector-search-aoss'),
      }),
      embeddingJobRoleArn: Lazy.string({
        produce: (): string =>
          requireRoleArn(() => functions?.vectorEmbedBatchFunction, 'kiro-vector-embed-batch'),
      }),
    });

    const vectorIndex = vectorCollection.collectionEnabled
      ? new VectorIndexConstruct(stack, 'VectorIndex', {
          vectorTable: tables.vectorTable,
          dimensions: TEST_DIMENSIONS,
        })
      : undefined;

    functions = new LambdaFunctionsConstruct(stack, 'Functions', {
      goodTable: tables.goodTable,
      executionsTable: tables.executionsTable,
      opensearchEndpoint: opensearch.collectionEndpoint,
      opensearchCollectionArn: opensearch.collectionArn,
      vector: {
        vectorTable: tables.vectorTable,
        queryCacheTable: tables.queryCacheTable,
        dimensions: TEST_DIMENSIONS,
        searchEnabled: vectorCollection.collectionEnabled,
        vectorIndexArns: vectorIndex ? Object.values(vectorIndex.indexArns) : undefined,
        vectorCollectionEndpoint: vectorCollection.collectionEndpoint,
        vectorCollectionArn: vectorCollection.collectionArn,
        vectorIndexName: vectorCollection.indexName,
      },
    });
  }

  // 既存 Data Access Policy への事後 Principal 追加（`backend.ts` と同じ処理）。
  // 実際にデプロイされる既存ポリシーは Principal 2 件の状態であり、
  // その状態を差分ゼロの比較対象にするために再現する。
  const existingCollectionName = 'kiro-inventory-search';
  opensearch.dataAccessPolicy.addPropertyOverride(
    'Policy',
    JSON.stringify([
      {
        Rules: [
          {
            ResourceType: 'index',
            Resource: [`index/${existingCollectionName}/*`],
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
            Resource: [`collection/${existingCollectionName}`],
            Permission: [
              'aoss:CreateCollectionItems',
              'aoss:UpdateCollectionItems',
              'aoss:DescribeCollectionItems',
            ],
          },
        ],
        Principal: [
          opensearch.pipelineRole.roleArn,
          requireRoleArn(() => functions?.opensearchSearchFunction, 'kiro-opensearch-search'),
        ],
      },
    ])
  );

  return Template.fromStack(stack).toJSON() as CfnTemplate;
}

const templates: Record<SynthMode, CfnTemplate> = {
  baseline: synthesize('baseline'),
  stageA: synthesize('stageA'),
  stageB: synthesize('stageB'),
};

/** テーブル名から論理 ID を引く（凍結した論理 ID の妥当性確認にも使う） */
function findTableLogicalId(template: CfnTemplate, tableName: string): string {
  const entry = Object.entries(template.Resources).find(
    ([, resource]) =>
      resource.Type === 'AWS::DynamoDB::Table' && resource.Properties?.TableName === tableName
  );
  if (!entry) {
    throw new Error(`DynamoDB table ${tableName} was not found in the synthesized template`);
  }
  return entry[0];
}

function resourceOf(template: CfnTemplate, logicalId: string): CfnResource {
  const resource = template.Resources[logicalId];
  if (!resource) {
    throw new Error(`resource ${logicalId} was not found in the synthesized template`);
  }
  return resource;
}

function normalizedResource(template: CfnTemplate, logicalId: string): unknown {
  return normalize(resourceOf(template, logicalId));
}

// ─── 既存リソースの論理 ID（本機能の追加前から存在する）──────────────
const GOOD_TABLE_LOGICAL_ID = 'TablesGoodTable4972AD42';
const EXISTING_OPENSEARCH_LOGICAL_IDS = {
  collectionGroup: 'OpenSearchCollectionGroup198FC0EA',
  encryptionPolicy: 'OpenSearchEncryptionPolicy3CC392DE',
  networkPolicy: 'OpenSearchNetworkPolicy13B5F05C',
  collection: 'OpenSearchCollection2D1A1F7B',
  dataAccessPolicy: 'OpenSearchDataAccessPolicy6150F99E',
  ingestionPipeline: 'OpenSearchIngestionPipeline30750FDB',
} as const;

/** 差分ゼロを確認する既存リソースの全体 */
const EXISTING_LOGICAL_IDS: readonly string[] = [
  GOOD_TABLE_LOGICAL_ID,
  ...Object.values(EXISTING_OPENSEARCH_LOGICAL_IDS),
];

// ─── 凍結スナップショット: Good_Table（要件 1.5 / 17.13）──────────────
const GOOD_TABLE_SNAPSHOT = {
  Type: 'AWS::DynamoDB::Table',
  Properties: {
    AttributeDefinitions: [
      { AttributeName: 'itemId', AttributeType: 'S' },
      { AttributeName: 'warehouseId', AttributeType: 'S' },
      { AttributeName: 'location', AttributeType: 'S' },
      { AttributeName: 'unitPrice', AttributeType: 'N' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
    ContributorInsightsSpecification: { Enabled: true },
    GlobalSecondaryIndexes: [
      {
        IndexName: 'byWarehouse',
        KeySchema: [
          { AttributeName: 'warehouseId', KeyType: 'HASH' },
          { AttributeName: 'itemId', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'byLocation',
        KeySchema: [
          { AttributeName: 'warehouseId', KeyType: 'HASH' },
          { AttributeName: 'location', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'byUnitPrice',
        KeySchema: [
          { AttributeName: 'warehouseId', KeyType: 'HASH' },
          { AttributeName: 'unitPrice', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    KeySchema: [
      { AttributeName: 'itemId', KeyType: 'HASH' },
      { AttributeName: 'warehouseId', KeyType: 'RANGE' },
    ],
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
    TableName: 'kiro-roasters-inventory-good',
  },
  UpdateReplacePolicy: 'Delete',
  DeletionPolicy: 'Delete',
};

// ─── 凍結スナップショット: 既存 OpenSearch 一式（要件 6.3 / 17.8）─────
const EXISTING_COLLECTION_GROUP_SNAPSHOT = {
  Type: 'AWS::OpenSearchServerless::CollectionGroup',
  Properties: {
    CapacityLimits: {
      MaxIndexingCapacityInOcu: 16,
      MaxSearchCapacityInOcu: 16,
      MinIndexingCapacityInOcu: 0,
      MinSearchCapacityInOcu: 0,
    },
    Description: 'Kiro Roasters inventory search comparison Collection Group (NextGen)',
    Name: 'kiro-inventory-group',
    StandbyReplicas: 'ENABLED',
    Generation: 'NEXTGEN',
  },
};

const EXISTING_ENCRYPTION_POLICY_SNAPSHOT = {
  Type: 'AWS::OpenSearchServerless::SecurityPolicy',
  Properties: {
    Description: 'Encryption policy for kiro-inventory-search collection (AWS owned key)',
    Name: 'kiro-inventory-search-enc',
    Policy:
      '{"Rules":[{"ResourceType":"collection","Resource":["collection/kiro-inventory-search"]}],"AWSOwnedKey":true}',
    Type: 'encryption',
  },
};

const EXISTING_NETWORK_POLICY_SNAPSHOT = {
  Type: 'AWS::OpenSearchServerless::SecurityPolicy',
  Properties: {
    Description:
      'Network policy for kiro-inventory-search collection (public access for verification)',
    Name: 'kiro-inventory-search-net',
    Policy:
      '[{"Rules":[{"ResourceType":"collection","Resource":["collection/kiro-inventory-search"]},' +
      '{"ResourceType":"dashboard","Resource":["collection/kiro-inventory-search"]}],' +
      '"AllowFromPublic":true}]',
    Type: 'network',
  },
};

const EXISTING_COLLECTION_SNAPSHOT = {
  Type: 'AWS::OpenSearchServerless::Collection',
  Properties: {
    CollectionGroupName: 'kiro-inventory-group',
    Description: 'Kiro Roasters inventory search comparison OpenSearch Serverless Collection',
    Name: 'kiro-inventory-search',
    Type: 'SEARCH',
  },
  DependsOn: [
    EXISTING_OPENSEARCH_LOGICAL_IDS.collectionGroup,
    EXISTING_OPENSEARCH_LOGICAL_IDS.encryptionPolicy,
    EXISTING_OPENSEARCH_LOGICAL_IDS.networkPolicy,
  ],
};

const EXISTING_DATA_ACCESS_POLICY_SNAPSHOT = {
  Type: 'AWS::OpenSearchServerless::AccessPolicy',
  Properties: {
    Description: 'Data access policy for pipeline and Lambda roles to access inventory index',
    Name: 'kiro-inventory-search-data',
    Policy:
      '[{"Rules":[{"ResourceType":"index","Resource":["index/kiro-inventory-search/*"],' +
      '"Permission":["aoss:CreateIndex","aoss:UpdateIndex","aoss:DescribeIndex",' +
      '"aoss:ReadDocument","aoss:WriteDocument"]},{"ResourceType":"collection",' +
      '"Resource":["collection/kiro-inventory-search"],"Permission":' +
      '["aoss:CreateCollectionItems","aoss:UpdateCollectionItems",' +
      '"aoss:DescribeCollectionItems"]}],"Principal":["${OpenSearchPipelineRole027CD6F9.Arn}",' +
      '"${FunctionsOpenSearchSearchFunctionServiceRoleAE982A79.Arn}"]}]',
    Type: 'data',
  },
  DependsOn: [EXISTING_OPENSEARCH_LOGICAL_IDS.collection],
};

/**
 * 既存 OSIS パイプラインの設定 YAML。
 *
 * `${...}` は `normalize()` が畳み込んだ論理 ID 参照であり、YAML 上の値ではない。
 * `${getMetadata(...)}` は OSIS 側の式であり、そのまま YAML に含まれる。
 */
const EXISTING_PIPELINE_CONFIGURATION_BODY = [
  '',
  'version: "2"',
  'dynamodb-pipeline:',
  '  source:',
  '    dynamodb:',
  '      acknowledgments: true',
  '      tables:',
  `        - table_arn: "\${${GOOD_TABLE_LOGICAL_ID}.Arn}"`,
  '          stream:',
  '            start_position: "LATEST"',
  '          export:',
  '            s3_bucket: "${OpenSearchExportBucketE0009D10}"',
  '            s3_region: "us-west-2"',
  '            s3_prefix: "ddb-export/"',
  '      aws:',
  '        sts_role_arn: "${OpenSearchPipelineRole027CD6F9.Arn}"',
  '        region: "us-west-2"',
  '  sink:',
  '    - opensearch:',
  '        hosts:',
  `          - "\${${EXISTING_OPENSEARCH_LOGICAL_IDS.collection}.CollectionEndpoint}"`,
  '        index: "inventory"',
  '        index_type: "custom"',
  '        document_id: "${getMetadata(\\"primary_key\\")}"',
  '        action: "${getMetadata(\\"opensearch_action\\")}"',
  '        document_version: "${getMetadata(\\"document_version\\")}"',
  '        document_version_type: "external"',
  '        aws:',
  '          sts_role_arn: "${OpenSearchPipelineRole027CD6F9.Arn}"',
  '          region: "us-west-2"',
  '          serverless: true',
  '          serverless_options:',
  '            network_policy_name: "kiro-inventory-search-net"',
  '            collection_name: "kiro-inventory-search"',
  '',
].join('\n');

const EXISTING_PIPELINE_SNAPSHOT = {
  Type: 'AWS::OSIS::Pipeline',
  Properties: {
    LogPublishingOptions: {
      CloudWatchLogDestination: { LogGroup: '${OpenSearchPipelineLogGroup94A8084B}' },
      IsLoggingEnabled: true,
    },
    MaxUnits: 4,
    MinUnits: 1,
    PipelineConfigurationBody: EXISTING_PIPELINE_CONFIGURATION_BODY,
    PipelineName: 'kiro-inventory-pipeline',
    PipelineRoleArn: '${OpenSearchPipelineRole027CD6F9.Arn}',
  },
  DependsOn: [
    EXISTING_OPENSEARCH_LOGICAL_IDS.collection,
    EXISTING_OPENSEARCH_LOGICAL_IDS.dataAccessPolicy,
    'OpenSearchPipelineRoleDefaultPolicyF1C15A0C',
    'OpenSearchPipelineRole027CD6F9',
  ],
};

// ─── IAM 走査 ────────────────────────────────────────────────────────

/**
 * Good_Table に対して禁止する書き込み Action（要件 1.4 / 17.10）。
 *
 * `dynamodb:*` は列挙した 5 つを包含するため同列に扱う。
 */
const FORBIDDEN_WRITE_ACTIONS = [
  'dynamodb:PutItem',
  'dynamodb:UpdateItem',
  'dynamodb:DeleteItem',
  'dynamodb:BatchWriteItem',
  'dynamodb:DeleteTable',
  'dynamodb:*',
] as const;

interface PolicyStatement {
  Action?: string | string[];
  Effect?: string;
  Resource?: unknown;
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** テンプレート内のすべての IAM ポリシー文書を (論理 ID, ステートメント) の列に開く */
function iamStatements(template: CfnTemplate): { logicalId: string; statement: PolicyStatement }[] {
  const entries: { logicalId: string; statement: PolicyStatement }[] = [];
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    const documents: unknown[] = [];
    if (resource.Type === 'AWS::IAM::Policy' || resource.Type === 'AWS::IAM::ManagedPolicy') {
      documents.push(resource.Properties?.PolicyDocument);
    }
    if (resource.Type === 'AWS::IAM::Role') {
      for (const inline of toArray(resource.Properties?.Policies as unknown[] | undefined)) {
        documents.push((inline as { PolicyDocument?: unknown }).PolicyDocument);
      }
    }
    for (const document of documents) {
      const statements = (document as { Statement?: PolicyStatement[] } | undefined)?.Statement;
      for (const statement of toArray(statements)) {
        entries.push({ logicalId, statement });
      }
    }
  }
  return entries;
}

/**
 * Good_Table のテーブル ARN または 3 GSI の ARN を Resource とする書き込み
 * ステートメントを持つポリシーの論理 ID を列挙する。
 *
 * L2 の `grant*` は `Fn::GetAtt [<GoodTable>, Arn]`、本機能側の明示ステートメントは
 * その ARN に `/index/<name>` を連結した `Fn::Join` になる。`normalize()` が
 * どちらも `${<GoodTable>.Arn}` を含む 1 本の文字列にするため、論理 ID の
 * 出現で両方を同時に検出できる。`Resource: "*"` も Good_Table を含むため対象にする。
 */
function goodTableWriterPolicyIds(template: CfnTemplate): string[] {
  const goodTableLogicalId = findTableLogicalId(template, 'kiro-roasters-inventory-good');
  const hits = new Set<string>();

  for (const { logicalId, statement } of iamStatements(template)) {
    if (statement.Effect !== undefined && statement.Effect !== 'Allow') continue;
    const actions = toArray(statement.Action);
    const hasWriteAction = actions.some((action) =>
      (FORBIDDEN_WRITE_ACTIONS as readonly string[]).includes(action)
    );
    if (!hasWriteAction) continue;

    const resources = toArray(statement.Resource).map(normalize);
    const touchesGoodTable = resources.some(
      (resource) =>
        typeof resource === 'string' &&
        (resource === '*' || resource.includes(`\${${goodTableLogicalId}.Arn}`))
    );
    if (touchesGoodTable) {
      hits.add(logicalId);
    }
  }

  return Array.from(hits).sort();
}

/**
 * 本機能の追加前から Good_Table へ書き込む既存ポリシー（要件 17.13）。
 *
 * 在庫アプリ本体の出庫・投入・負荷テストは Good_Table への書き込みを必要とする。
 * これらの権限を縮小してはならないため、走査は「0 件」ではなく
 * 「この 4 件と完全一致」を固定する。1 件でも増えれば本機能が Good_Table への
 * 書き込み経路を作ったことになり、1 件でも減れば既存権限を縮小したことになる。
 */
const EXISTING_GOOD_TABLE_WRITER_POLICY_IDS = [
  'FunctionsLoadTestStartFunctionServiceRoleDefaultPolicy17747403',
  'FunctionsOnlineImpactTestFunctionServiceRoleDefaultPolicy1039B400',
  'FunctionsSeedFunctionServiceRoleDefaultPolicy5BA923FC',
  'FunctionsShipFunctionServiceRoleDefaultPolicyD918F6DC',
];

/** 本機能で追加されたリソースの論理 ID 接頭辞 */
const VECTOR_FEATURE_PREFIXES = ['VectorCollection', 'VectorIndex', 'FunctionsVector'];

function isVectorFeatureResource(logicalId: string): boolean {
  return VECTOR_FEATURE_PREFIXES.some((prefix) => logicalId.startsWith(prefix));
}

// ─── テスト ──────────────────────────────────────────────────────────

describe('既存リソースの差分ゼロ（CDK スナップショット）', () => {
  const stageModes: SynthMode[] = ['stageA', 'stageB'];

  describe('Good_Table の定義が本機能の追加前と一致する', () => {
    it('凍結スナップショットと完全一致する（PK / SK / GSI 3 本 / Streams / PITR / ContributorInsights）', () => {
      expect(normalizedResource(templates.stageB, GOOD_TABLE_LOGICAL_ID)).toEqual(
        GOOD_TABLE_SNAPSHOT
      );
    });

    it('凍結した論理 ID がテーブル名 kiro-roasters-inventory-good を指している', () => {
      expect(findTableLogicalId(templates.stageB, 'kiro-roasters-inventory-good')).toBe(
        GOOD_TABLE_LOGICAL_ID
      );
    });

    it.each(stageModes)('ベースラインとの差分がゼロである（%s）', (mode) => {
      expect(normalizedResource(templates[mode], GOOD_TABLE_LOGICAL_ID)).toEqual(
        normalizedResource(templates.baseline, GOOD_TABLE_LOGICAL_ID)
      );
    });

    it('3 本の GSI がすべて ProjectionType ALL である', () => {
      const properties = resourceOf(templates.stageB, GOOD_TABLE_LOGICAL_ID).Properties ?? {};
      const indexes = properties.GlobalSecondaryIndexes as
        | { IndexName: string; Projection: { ProjectionType: string } }[]
        | undefined;
      expect(indexes?.map((index) => index.IndexName)).toEqual([
        'byWarehouse',
        'byLocation',
        'byUnitPrice',
      ]);
      expect(indexes?.map((index) => index.Projection.ProjectionType)).toEqual([
        'ALL',
        'ALL',
        'ALL',
      ]);
    });

    it('Streams が NEW_AND_OLD_IMAGES、PITR と ContributorInsights が有効のままである', () => {
      const properties = resourceOf(templates.stageB, GOOD_TABLE_LOGICAL_ID).Properties ?? {};
      expect(properties.StreamSpecification).toEqual({ StreamViewType: 'NEW_AND_OLD_IMAGES' });
      expect(properties.PointInTimeRecoverySpecification).toEqual({
        PointInTimeRecoveryEnabled: true,
      });
      expect(properties.ContributorInsightsSpecification).toEqual({ Enabled: true });
    });

    it('Good_Table 上にベクトルインデックスを作るリソースが存在しない', () => {
      // 本機能のカスタムリソースは Vector_Table のみを対象にする（要件 1.6 / 5.6）
      const vectorTableLogicalId = findTableLogicalId(
        templates.stageB,
        'kiro-roasters-inventory-vector'
      );
      const customResources = Object.entries(templates.stageB.Resources).filter(
        ([, resource]) => resource.Type === 'Custom::DynamoDBVectorIndex'
      );
      expect(customResources).toHaveLength(2);
      for (const [, resource] of customResources) {
        const rendered = JSON.stringify(normalize(resource));
        expect(rendered).toContain(vectorTableLogicalId);
        expect(rendered).not.toContain(GOOD_TABLE_LOGICAL_ID);
      }
    });
  });

  describe('既存 OpenSearch 一式のスナップショットが変化していない', () => {
    const cases: { label: string; logicalId: string; snapshot: unknown }[] = [
      {
        label: 'Collection Group kiro-inventory-group',
        logicalId: EXISTING_OPENSEARCH_LOGICAL_IDS.collectionGroup,
        snapshot: EXISTING_COLLECTION_GROUP_SNAPSHOT,
      },
      {
        label: 'Encryption Policy kiro-inventory-search-enc',
        logicalId: EXISTING_OPENSEARCH_LOGICAL_IDS.encryptionPolicy,
        snapshot: EXISTING_ENCRYPTION_POLICY_SNAPSHOT,
      },
      {
        label: 'Network Policy kiro-inventory-search-net',
        logicalId: EXISTING_OPENSEARCH_LOGICAL_IDS.networkPolicy,
        snapshot: EXISTING_NETWORK_POLICY_SNAPSHOT,
      },
      {
        label: 'Collection kiro-inventory-search',
        logicalId: EXISTING_OPENSEARCH_LOGICAL_IDS.collection,
        snapshot: EXISTING_COLLECTION_SNAPSHOT,
      },
      {
        label: 'Data Access Policy kiro-inventory-search-data',
        logicalId: EXISTING_OPENSEARCH_LOGICAL_IDS.dataAccessPolicy,
        snapshot: EXISTING_DATA_ACCESS_POLICY_SNAPSHOT,
      },
      {
        label: 'OSIS Pipeline kiro-inventory-pipeline',
        logicalId: EXISTING_OPENSEARCH_LOGICAL_IDS.ingestionPipeline,
        snapshot: EXISTING_PIPELINE_SNAPSHOT,
      },
    ];

    it.each(cases.map((entry) => [entry.label, entry] as const))(
      '%s が凍結スナップショットと一致する',
      (_label, entry) => {
        expect(normalizedResource(templates.stageB, entry.logicalId)).toEqual(entry.snapshot);
      }
    );

    it.each(stageModes)('既存リソース全件がベースラインと完全一致する（%s）', (mode) => {
      for (const logicalId of EXISTING_LOGICAL_IDS) {
        expect(normalizedResource(templates[mode], logicalId)).toEqual(
          normalizedResource(templates.baseline, logicalId)
        );
      }
    });

    it('既存 Collection / Collection Group が本機能で新規作成される分と別リソースである', () => {
      const collectionNames = Object.values(templates.stageB.Resources)
        .filter((resource) => resource.Type === 'AWS::OpenSearchServerless::Collection')
        .map((resource) => resource.Properties?.Name);
      expect(collectionNames.sort()).toEqual(['kiro-inventory-search', 'kiro-inventory-vector']);

      const groupNames = Object.values(templates.stageB.Resources)
        .filter((resource) => resource.Type === 'AWS::OpenSearchServerless::CollectionGroup')
        .map((resource) => resource.Properties?.Name);
      expect(groupNames.sort()).toEqual(['kiro-inventory-group', 'kiro-inventory-vector-group']);
    });

    it('既存 OSIS パイプラインが 1 本のままで、ベクトル側の参照を含まない', () => {
      const pipelines = Object.values(templates.stageB.Resources).filter(
        (resource) => resource.Type === 'AWS::OSIS::Pipeline'
      );
      expect(pipelines).toHaveLength(1);
      const body = EXISTING_PIPELINE_CONFIGURATION_BODY;
      expect(body).not.toContain('kiro-inventory-vector');
      expect(body).not.toContain('kiro-roasters-inventory-vector');
      expect(body).not.toContain('embedding');
    });
  });

  describe('Good_Table を Resource とする書き込み IAM ステートメントの走査', () => {
    it.each(stageModes)('本機能のロールが書き込み権限を 1 件も持たない（%s）', (mode) => {
      const writers = goodTableWriterPolicyIds(templates[mode]);
      expect(writers.filter(isVectorFeatureResource)).toEqual([]);
    });

    it.each(stageModes)(
      '書き込みを持つポリシーの集合が本機能の追加前と完全一致する（%s）',
      (mode) => {
        expect(goodTableWriterPolicyIds(templates[mode])).toEqual(
          EXISTING_GOOD_TABLE_WRITER_POLICY_IDS
        );
      }
    );

    it('ベースラインの書き込みポリシー集合が凍結した既存 4 件と一致する', () => {
      expect(goodTableWriterPolicyIds(templates.baseline)).toEqual(
        EXISTING_GOOD_TABLE_WRITER_POLICY_IDS
      );
    });

    it('本機能のロールが持つ Good_Table 向け Action は読み取りのみである', () => {
      const goodTableLogicalId = findTableLogicalId(
        templates.stageB,
        'kiro-roasters-inventory-good'
      );
      const readOnly = ['dynamodb:Query', 'dynamodb:Scan', 'dynamodb:GetItem'];
      const observed = new Set<string>();

      for (const { logicalId, statement } of iamStatements(templates.stageB)) {
        if (!isVectorFeatureResource(logicalId)) continue;
        const resources = toArray(statement.Resource).map(normalize);
        const touchesGoodTable = resources.some(
          (resource) =>
            typeof resource === 'string' &&
            resource.includes(`\${${goodTableLogicalId}.Arn}`)
        );
        if (!touchesGoodTable) continue;
        for (const action of toArray(statement.Action)) {
          observed.add(action);
        }
      }

      expect(Array.from(observed).sort()).toEqual(['dynamodb:Query']);
      for (const action of Array.from(observed)) {
        expect(readOnly).toContain(action);
      }
    });
  });

  describe('走査ロジックの負のコントロール', () => {
    /**
     * 走査が空振りしていないことを確認する。
     *
     * 上の走査テストは「違反 0 件」を主張するため、走査が何も検出できない実装に
     * 退化しても通ってしまう。Good_Table への書き込みを持つロールを本機能の
     * 接頭辞で意図的に 1 つ作り、検出されることを確かめる。
     * このスタックは検証専用であり、`backend.ts` の構成には含まれない。
     */
    function synthesizeViolatingStack(grant: 'table' | 'gsi'): CfnTemplate {
      const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
      const stack = new Stack(app, 'InventoryStack', { env: SYNTH_ENV });
      const tables = new InventoryTablesConstruct(stack, 'Tables');
      const role = new iam.Role(stack, 'VectorIndexProbeRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      });
      if (grant === 'table') {
        tables.goodTable.grantWriteData(role);
      } else {
        role.addToPolicy(
          new iam.PolicyStatement({
            actions: ['dynamodb:PutItem'],
            resources: [`${tables.goodTable.tableArn}/index/byWarehouse`],
          })
        );
      }
      return Template.fromStack(stack).toJSON() as CfnTemplate;
    }

    it('テーブル ARN への書き込み付与を検出する', () => {
      const writers = goodTableWriterPolicyIds(synthesizeViolatingStack('table'));
      expect(writers.filter(isVectorFeatureResource)).not.toEqual([]);
    });

    it('GSI ARN への書き込み付与を検出する', () => {
      const writers = goodTableWriterPolicyIds(synthesizeViolatingStack('gsi'));
      expect(writers.filter(isVectorFeatureResource)).not.toEqual([]);
    });
  });

  describe('Vector_Table の構成（要件 1.1 / 1.2）', () => {
    it('GSI 0 本 / Streams なし / PITR 無効 / ContributorInsights なし', () => {
      const logicalId = findTableLogicalId(templates.stageB, 'kiro-roasters-inventory-vector');
      const resource = resourceOf(templates.stageB, logicalId);
      const properties = resource.Properties ?? {};

      expect(properties.GlobalSecondaryIndexes).toBeUndefined();
      expect(properties.LocalSecondaryIndexes).toBeUndefined();
      expect(properties.StreamSpecification).toBeUndefined();
      expect(properties.ContributorInsightsSpecification).toBeUndefined();
      expect(properties.PointInTimeRecoverySpecification).toEqual({
        PointInTimeRecoveryEnabled: false,
      });
      expect(resource.DeletionPolicy).toBe('Delete');
    });

    it('PK itemId / SK warehouseId / オンデマンド課金である', () => {
      const logicalId = findTableLogicalId(templates.stageB, 'kiro-roasters-inventory-vector');
      const properties = resourceOf(templates.stageB, logicalId).Properties ?? {};

      expect(properties.KeySchema).toEqual([
        { AttributeName: 'itemId', KeyType: 'HASH' },
        { AttributeName: 'warehouseId', KeyType: 'RANGE' },
      ]);
      expect(properties.AttributeDefinitions).toEqual([
        { AttributeName: 'itemId', AttributeType: 'S' },
        { AttributeName: 'warehouseId', AttributeType: 'S' },
      ]);
      expect(properties.BillingMode).toBe('PAY_PER_REQUEST');
    });
  });
});
