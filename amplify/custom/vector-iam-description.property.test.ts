import { beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { App, Lazy, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type * as lambda from 'aws-cdk-lib/aws-lambda';

import { InventoryTablesConstruct } from './dynamodb-tables';
import { LambdaFunctionsConstruct } from './lambda-functions';
import { OpenSearchInfraConstruct } from './opensearch-infra';
import {
  VECTOR_COLLECTION_ENABLED_CONTEXT_KEY,
  VECTOR_COLLECTION_NAME,
  VECTOR_INDEX_NAME,
  VectorCollectionConstruct,
} from './vector-collection';
import { VectorIndexConstruct } from './vector-index';
import { EMBEDDING_MODEL_ID } from '../functions/shared/vector/embedding-generator';

/**
 * IAM 最小権限と description の文字集合の property テスト（task 7.5）。
 *
 * 合成テンプレートに対する検査のみで完結する。AWS へのデプロイも API 呼び出しも行わない
 * （`Template.fromStack` はインメモリで合成する）。
 *
 * 検査対象は「本機能由来のリソース」に限る。判定は名前の見た目ではなく、
 * **ベクトル検索比較を配線しないベースライン合成との論理 ID 差分**で行う。
 * これにより「既存リソースを誤って対象に含める」ことも
 * 「本機能で増えたロールを検査から漏らす」ことも起きない。
 *
 * 同じベースラインを使って、既存 Lambda ロールの Good_Table 権限が
 * 削除・縮小されていないこと（要件 17.13）も検証する。
 */

// ─── テンプレート値のレンダリング ─────────────────────────────────────────
//
// IAM の Resource は `Fn::GetAtt` / `Fn::Join` を含む。文字列として比較できるよう、
// 参照を `${論理ID.属性}` のプレースホルダに畳んだ 1 本の文字列へ変換する。
// トークンを解決しないため、アカウント ID やリージョンの実値には依存しない。

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return JSON.stringify(value);

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1) {
    if (keys[0] === 'Ref') {
      return `\${${String(obj.Ref)}}`;
    }
    if (keys[0] === 'Fn::GetAtt') {
      const [logicalId, attribute] = obj['Fn::GetAtt'] as [string, string];
      return `\${${logicalId}.${attribute}}`;
    }
    if (keys[0] === 'Fn::Join') {
      const [delimiter, parts] = obj['Fn::Join'] as [string, unknown[]];
      return parts.map(renderValue).join(delimiter);
    }
  }
  return JSON.stringify(value);
}

/** `Action` / `Resource` は文字列単体でも配列でも書けるため、常に配列へ正規化する */
function renderList(value: unknown): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value.map(renderValue) : [renderValue(value)];
}

// ─── 合成テンプレートから IAM ステートメントを取り出す ──────────────────────

interface IamStatement {
  /** ステートメントを載せているリソースの論理 ID（`AWS::IAM::Policy` またはロール） */
  ownerLogicalId: string;
  /** ステートメントが効くロールの論理 ID */
  roleLogicalId: string;
  effect: string;
  actions: string[];
  resources: string[];
}

interface TemplateJson {
  Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }>;
}

function collectStatements(json: TemplateJson): IamStatement[] {
  const statements: IamStatement[] = [];

  for (const [logicalId, resource] of Object.entries(json.Resources)) {
    const props = resource.Properties ?? {};

    if (resource.Type === 'AWS::IAM::Policy' || resource.Type === 'AWS::IAM::ManagedPolicy') {
      const roles = renderList(props.Roles);
      // `${論理ID}` から論理 ID を取り出す。アタッチ先が無いポリシーは owner を役割名の代わりにする
      const roleLogicalId = roles.length > 0 ? placeholderTarget(roles[0]) : logicalId;
      pushDocument(statements, logicalId, roleLogicalId, props.PolicyDocument);
      continue;
    }

    if (resource.Type === 'AWS::IAM::Role') {
      for (const inline of (props.Policies as { PolicyDocument?: unknown }[] | undefined) ?? []) {
        pushDocument(statements, logicalId, logicalId, inline.PolicyDocument);
      }
    }
  }

  return statements;
}

function pushDocument(
  sink: IamStatement[],
  ownerLogicalId: string,
  roleLogicalId: string,
  document: unknown
): void {
  const statementList =
    ((document as { Statement?: unknown[] } | undefined)?.Statement as
      | Record<string, unknown>[]
      | undefined) ?? [];
  for (const statement of statementList) {
    sink.push({
      ownerLogicalId,
      roleLogicalId,
      effect: String(statement.Effect ?? 'Allow'),
      actions: renderList(statement.Action),
      resources: renderList(statement.Resource),
    });
  }
}

/** `${論理ID}` / `${論理ID.属性}` から論理 ID を取り出す */
function placeholderTarget(rendered: string): string {
  const matched = /^\$\{([A-Za-z0-9]+)(?:\.[A-Za-z0-9.]+)?\}$/.exec(rendered);
  return matched ? matched[1] : rendered;
}

/** レンダリング結果が指定リソースを参照しているか */
function referencesResource(rendered: string, logicalId: string): boolean {
  return rendered.includes(`\${${logicalId}`);
}

// ─── IAM のマッチング（ワイルドカード展開を含む）──────────────────────────

function actionMatches(pattern: string, action: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith(':*')) {
    return action.toLowerCase().startsWith(pattern.slice(0, -1).toLowerCase());
  }
  return pattern.toLowerCase() === action.toLowerCase();
}

function resourceMatches(pattern: string, resource: string): boolean {
  if (pattern === '*') return true;
  const regex = new RegExp(
    `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')}$`
  );
  return regex.test(resource);
}

/**
 * 1 つの IAM ステートメントが最小権限であることを検査する。
 *
 * ステートメントが属するコンポーネントを実行ロールの論理 ID から引き、
 * Action がそのホワイトリストの部分集合であることと、ワイルドカードを含まないことを見る。
 */
function assertLeastPrivilege(statement: IamStatement): void {
  const component = COMPONENT_WHITELISTS.find((candidate) =>
    candidate.role.test(statement.roleLogicalId)
  );
  // 未知のロールにステートメントが載った時点で失敗させる（全域性）
  expect(
    component,
    `未知の本機能由来ロールにポリシーが付与されている: ${statement.roleLogicalId} ` +
      `(${statement.ownerLogicalId}) actions=${JSON.stringify(statement.actions)}`
  ).toBeDefined();
  expect(statement.effect).toBe('Allow');

  for (const action of statement.actions) {
    // ワイルドカードアクションを一切許さない
    expect(action).not.toBe('*');
    expect(action.endsWith(':*'), `ワイルドカードアクション: ${action}`).toBe(false);
    expect(
      component!.allowedActions,
      `${component!.name} のホワイトリスト外の Action: ${action}`
    ).toContain(action);
  }

  // データ面のサービスに `Resource: "*"` を与えない。
  // `xray:Put*` は CDK の `tracing: ACTIVE` に由来し、リソース単位の指定ができない
  const touchesDataPlane = statement.actions.some((action) =>
    /^(dynamodb|aoss|bedrock|lambda|states):/.test(action)
  );
  if (touchesDataPlane) {
    expect(statement.resources.length).toBeGreaterThan(0);
    for (const resource of statement.resources) {
      expect(resource, `${component!.name} が Resource "*" を持つ`).not.toBe('*');
    }
  }
}

/** 指定の (Action, Resource) を許可しているステートメントを探す */
function findGrant(
  statements: IamStatement[],
  action: string,
  resource: string
): IamStatement | undefined {
  return statements.find(
    (statement) =>
      statement.effect === 'Allow' &&
      statement.actions.some((pattern) => actionMatches(pattern, action)) &&
      statement.resources.some((pattern) => resourceMatches(pattern, resource))
  );
}

// ─── コンポーネント別の許可アクションホワイトリスト（要件 17.1〜17.12）────────
//
// `logs:*` は CDK が `AWSLambdaBasicExecutionRole` マネージドポリシーで付与するため、
// インラインステートメントには現れない（マネージドポリシーの限定は別途検証する）。
// `xray:Put*` は既存 Lambda と同じ `tracing: ACTIVE` に由来する。

const XRAY_ACTIONS = ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'];
const PROVIDER_FRAMEWORK_ACTIONS = [
  'lambda:InvokeFunction',
  'lambda:GetFunction',
  'states:StartExecution',
];

interface ComponentWhitelist {
  name: string;
  role: RegExp;
  allowedActions: string[];
}

const COMPONENT_WHITELISTS: ComponentWhitelist[] = [
  {
    name: 'kiro-vector-search-ddb (DynamoDB_Vector_Lambda)',
    role: /^FunctionsVectorSearchDdbFunctionServiceRole/,
    allowedActions: [
      ...XRAY_ACTIONS,
      'dynamodb:SearchVectors',
      'dynamodb:DescribeTable',
      'dynamodb:GetItem',
    ],
  },
  {
    name: 'kiro-vector-search-aoss (OpenSearch_Vector_Lambda)',
    role: /^FunctionsVectorSearchAossFunctionServiceRole/,
    allowedActions: [...XRAY_ACTIONS, 'aoss:APIAccessAll', 'dynamodb:GetItem'],
  },
  {
    name: 'kiro-vector-query-embed (Query_Embedding_Lambda)',
    role: /^FunctionsVectorQueryEmbedFunctionServiceRole/,
    allowedActions: [
      ...XRAY_ACTIONS,
      'bedrock:InvokeModel',
      'dynamodb:PutItem',
      'dynamodb:GetItem',
    ],
  },
  {
    name: 'kiro-vector-embed-batch (Embedding_Batch_Job)',
    role: /^FunctionsVectorEmbedBatchFunctionServiceRole/,
    allowedActions: [
      ...XRAY_ACTIONS,
      'dynamodb:Query',
      'dynamodb:Scan',
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:BatchWriteItem',
      'bedrock:InvokeModel',
      'aoss:APIAccessAll',
      'lambda:InvokeFunction',
    ],
  },
  {
    name: 'kiro-vector-capabilities',
    role: /^FunctionsVectorCapabilitiesFunctionServiceRole/,
    allowedActions: [...XRAY_ACTIONS],
  },
  {
    name: 'Index_Provisioner onEvent',
    role: /^VectorIndexOnEventFunctionServiceRole/,
    allowedActions: ['dynamodb:UpdateTable', 'dynamodb:DescribeTable'],
  },
  {
    name: 'Index_Provisioner isComplete',
    role: /^VectorIndexIsCompleteFunctionServiceRole/,
    allowedActions: ['dynamodb:DescribeTable'],
  },
  {
    name: 'Index_Provisioner provider framework',
    role: /^VectorIndexProvider(frameworkonEvent|frameworkisComplete|frameworkonTimeout|waiterstatemachine)/,
    allowedActions: [...PROVIDER_FRAMEWORK_ACTIONS],
  },
];

/** Good_Table を対象に付与されてはならない書き込み系 Action（要件 17.10） */
const FORBIDDEN_WRITE_ACTIONS = [
  'dynamodb:PutItem',
  'dynamodb:UpdateItem',
  'dynamodb:DeleteItem',
  'dynamodb:BatchWriteItem',
  'dynamodb:DeleteTable',
];

/** 資格情報を示す環境変数キー名（要件 17.9） */
const CREDENTIAL_KEY_PATTERN =
  /(ACCESS[_-]?KEY|SECRET|SESSION[_-]?TOKEN|CREDENTIAL|PASSWORD|PASSWD|PRIVATE[_-]?KEY)/i;

/** description に許される文字（要件 6.12 / 17.14） */
const DESCRIPTION_CHARSET_PATTERN = /^[\u0009\u000A\u000D\u0020-\u007E\u00A1-\u00FF]*$/;

/** 日本語文字（ひらがな・カタカナ・漢字・全角記号）と矢印 */
const JAPANESE_OR_ARROW_PATTERN =
  /[\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uFF00-\uFFEF\u2190-\u21FF\u2794-\u27BF]/;

// ─── 合成 ────────────────────────────────────────────────────────────────

const TEST_REGION = 'us-west-2';
const TEST_ACCOUNT = '123456789012';
const TEST_DIMENSIONS = 1024;

/**
 * ベクトル検索比較を配線した合成テンプレート。
 *
 * `backend.ts` と同じ順序・同じ `Lazy.string()` による相互参照で組む。
 * `vectorCollectionEnabled=true`（Stage B）で合成し、Collection / Index /
 * 検索系 Lambda まで含めた最大構成を検査対象にする。
 */
function synthesizeVectorTemplate(): TemplateJson {
  const app = new App({ context: { [VECTOR_COLLECTION_ENABLED_CONTEXT_KEY]: true } });
  const stack = new Stack(app, 'VectorIamPropertyStack', {
    env: { account: TEST_ACCOUNT, region: TEST_REGION },
  });

  const tables = new InventoryTablesConstruct(stack, 'Tables');
  const opensearch = new OpenSearchInfraConstruct(stack, 'OpenSearch', {
    sourceTable: tables.goodTable,
  });

  let functions: LambdaFunctionsConstruct | undefined;
  const vectorCollection = new VectorCollectionConstruct(stack, 'VectorCollection', {
    dimensions: TEST_DIMENSIONS,
    searchLambdaRoleArn: Lazy.string({
      produce: (): string => requireRoleArn(functions?.vectorSearchAossFunction),
    }),
    embeddingJobRoleArn: Lazy.string({
      produce: (): string => requireRoleArn(functions?.vectorEmbedBatchFunction),
    }),
  });

  const vectorIndex = new VectorIndexConstruct(stack, 'VectorIndex', {
    vectorTable: tables.vectorTable,
    dimensions: TEST_DIMENSIONS,
  });

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
      vectorIndexArns: Object.values(vectorIndex.indexArns),
      vectorCollectionEndpoint: vectorCollection.collectionEndpoint,
      vectorCollectionArn: vectorCollection.collectionArn,
      vectorIndexName: vectorCollection.indexName,
    },
  });

  return Template.fromStack(stack).toJSON() as TemplateJson;
}

/**
 * ベクトル検索比較を配線しないベースライン合成。
 *
 * 本機能由来のリソースを論理 ID の差分で特定するための基準であり、
 * 既存 Lambda ロールの Good_Table 権限の比較元にもなる（要件 17.13）。
 */
function synthesizeBaselineTemplate(): TemplateJson {
  const app = new App();
  const stack = new Stack(app, 'VectorIamPropertyStack', {
    env: { account: TEST_ACCOUNT, region: TEST_REGION },
  });

  const tables = new InventoryTablesConstruct(stack, 'Tables');
  const opensearch = new OpenSearchInfraConstruct(stack, 'OpenSearch', {
    sourceTable: tables.goodTable,
  });

  new LambdaFunctionsConstruct(stack, 'Functions', {
    goodTable: tables.goodTable,
    executionsTable: tables.executionsTable,
    opensearchEndpoint: opensearch.collectionEndpoint,
    opensearchCollectionArn: opensearch.collectionArn,
  });

  return Template.fromStack(stack).toJSON() as TemplateJson;
}

function requireRoleArn(fn: lambda.Function | undefined): string {
  const role = fn?.role;
  if (!role) {
    throw new Error('Vector data access policy requires a Lambda execution role');
  }
  return role.roleArn;
}

/** 種別と `Name` プロパティからリソースの論理 ID を引く */
function findLogicalId(
  json: TemplateJson,
  type: string,
  predicate: (props: Record<string, unknown>) => boolean
): string {
  const found = Object.entries(json.Resources).find(
    ([, resource]) => resource.Type === type && predicate(resource.Properties ?? {})
  );
  if (!found) throw new Error(`Resource not found in template: ${type}`);
  return found[0];
}

describe('ベクトル検索比較の IAM 権限と description', () => {
  let vectorTemplate: TemplateJson;
  let baselineTemplate: TemplateJson;
  /** 本機能由来のリソース論理 ID（ベースラインとの差分） */
  let featureLogicalIds: string[];
  let featureStatements: IamStatement[];
  let allStatements: IamStatement[];
  let goodTableId: string;
  let vectorTableId: string;
  let queryCacheTableId: string;
  let vectorCollectionId: string;
  let pipelineRoleId: string;

  beforeAll(() => {
    vectorTemplate = synthesizeVectorTemplate();
    baselineTemplate = synthesizeBaselineTemplate();

    const baselineIds = new Set(Object.keys(baselineTemplate.Resources));
    featureLogicalIds = Object.keys(vectorTemplate.Resources).filter((id) => !baselineIds.has(id));

    allStatements = collectStatements(vectorTemplate);
    const featureIdSet = new Set(featureLogicalIds);
    featureStatements = allStatements.filter((statement) =>
      featureIdSet.has(statement.ownerLogicalId)
    );


    goodTableId = findLogicalId(
      vectorTemplate,
      'AWS::DynamoDB::Table',
      (props) => props.TableName === 'kiro-roasters-inventory-good'
    );
    vectorTableId = findLogicalId(
      vectorTemplate,
      'AWS::DynamoDB::Table',
      (props) => props.TableName === 'kiro-roasters-inventory-vector'
    );
    queryCacheTableId = findLogicalId(
      vectorTemplate,
      'AWS::DynamoDB::Table',
      (props) => props.TableName === 'kiro-vector-query-cache'
    );
    vectorCollectionId = findLogicalId(
      vectorTemplate,
      'AWS::OpenSearchServerless::Collection',
      (props) => props.Name === VECTOR_COLLECTION_NAME
    );
    // 既存 Ingestion_Pipeline のロール。ベクトル側データアクセスポリシーの
    // Principal に含まれてはならない対象として実在を確かめておく（要件 17.7）
    pipelineRoleId = findLogicalId(
      vectorTemplate,
      'AWS::IAM::Role',
      (props) =>
        typeof props.Description === 'string' &&
        props.Description.includes('OpenSearch Ingestion Pipeline')
    );
  }, 300_000);

  // Feature: vector-search-comparison, Property 55: IAM ポリシーの最小権限
  // 任意の 本機能由来の合成テンプレート内 IAM ポリシーステートメントに対して、Action は
  // 各コンポーネントの許可アクションホワイトリストの部分集合であり、`dynamodb:*` / `aoss:*` /
  // `bedrock:*` などのワイルドカードアクション、および `Resource: "*"`（`aoss` の API 実行に
  // 不可欠なものを除く）を含まない。Good_Table のテーブル ARN および 3 つの GSI の ARN を
  // Resource とする書き込み Action（`PutItem` / `UpdateItem` / `DeleteItem` / `BatchWriteItem` /
  // `DeleteTable`）を持つステートメントは 1 件も存在しない。DynamoDB_Vector_Lambda の Action は
  // `dynamodb:SearchVectors` のみであり Resource は 2 本のベクトルインデックス ARN のみで、
  // Vector_Table のテーブル ARN、`Query`、`Scan` を含まない。Index_Provisioner の Resource は
  // Vector_Table のテーブル ARN のみで Good_Table の ARN を含まない。OpenSearch_Vector_Lambda は
  // データアクセスポリシーで読み取り権限のみを持ち書き込み系権限を含まない。Bedrock の Resource は
  // モデル ARN 1 件のみでワイルドカードを含まない。データアクセスポリシーの Principal は
  // 検索 Lambda ロール（読み取りのみ）、Embedding_Batch_Job ロール（書き込みのみ）、
  // CloudFormation 実行ロール（インデックスライフサイクルのみで ReadDocument / WriteDocument を
  // 含まない）の 3 件であり、ワイルドカードと Ingestion_Pipeline のロールを含まない。
  // Vector_Collection へ書き込むロールに
  // ついては IAM 側の許可とデータアクセスポリシー側の許可が同時に存在する。既存 Lambda ロールに
  // 付与済みの Good_Table 関連 Action と Resource は削除・縮小されない。関数の環境変数キー名に
  // アクセスキー・シークレット・セッショントークンを示す名称が現れない。
  // **Validates: Requirements 5.16, 17.1, 17.2, 17.4, 17.5, 17.6, 17.7, 17.9, 17.10, 17.11, 17.12, 17.13**
  it('本機能由来の IAM 権限が最小権限であり、既存ロールの Good_Table 権限を縮小しない', () => {
    // 検査対象が空だと以降の property が空虚に成立するため、まず母集団を確かめる
    expect(featureStatements.length).toBeGreaterThan(0);

    // ── 1. 任意のステートメントがコンポーネント別ホワイトリストの部分集合である ──
    // `fc.constantFrom` は 100 回反復しても全要素を引くとは限らないため、
    // 同じ検査を全要素に対して 1 度ずつ実行して取りこぼしを消す
    for (const statement of featureStatements) assertLeastPrivilege(statement);
    fc.assert(fc.property(fc.constantFrom(...featureStatements), assertLeastPrivilege), {
      numRuns: 100,
    });

    // ── 2. Good_Table と 3 GSI への書き込み Action が 1 件も存在しない（要件 17.10）──
    const goodTableArn = `\${${goodTableId}.Arn}`;
    const goodTableResourceForms = [
      goodTableArn,
      `${goodTableArn}/index/byWarehouse`,
      `${goodTableArn}/index/byLocation`,
      `${goodTableArn}/index/byUnitPrice`,
    ];
    // ワイルドカード展開を含む IAM の評価規則で照合する
    const assertNoGoodTableWrite = (action: string, resource: string): void => {
      const grant = findGrant(featureStatements, action, resource);
      expect(
        grant,
        `本機能由来のステートメントが Good_Table への ${action} を許可している: ` +
          `${grant?.ownerLogicalId} ${JSON.stringify(grant?.resources)}`
      ).toBeUndefined();
    };
    for (const action of FORBIDDEN_WRITE_ACTIONS) {
      for (const resource of goodTableResourceForms) assertNoGoodTableWrite(action, resource);
    }
    fc.assert(
      fc.property(
        fc.constantFrom(...FORBIDDEN_WRITE_ACTIONS),
        fc.constantFrom(...goodTableResourceForms),
        assertNoGoodTableWrite
      ),
      { numRuns: 100 }
    );

    // ── 3. 既存 Lambda ロールの Good_Table 権限が削除・縮小されていない（要件 17.13）──
    const baselineGoodTableGrants = collectStatements(baselineTemplate)
      .filter((statement) => statement.resources.some((r) => referencesResource(r, goodTableId)))
      .flatMap((statement) =>
        statement.actions.flatMap((action) =>
          statement.resources.map(
            (resource) => `${statement.roleLogicalId}|${action}|${resource}`
          )
        )
      );
    const vectorGrants = new Set(
      allStatements.flatMap((statement) =>
        statement.actions.flatMap((action) =>
          statement.resources.map(
            (resource) => `${statement.roleLogicalId}|${action}|${resource}`
          )
        )
      )
    );
    expect(baselineGoodTableGrants.length).toBeGreaterThan(0);
    const assertGrantPreserved = (grant: string): void => {
      expect(vectorGrants.has(grant), `既存ロールの Good_Table 権限が失われている: ${grant}`).toBe(
        true
      );
    };
    for (const grant of baselineGoodTableGrants) assertGrantPreserved(grant);
    fc.assert(fc.property(fc.constantFrom(...baselineGoodTableGrants), assertGrantPreserved), {
      numRuns: 100,
    });

    // ── 4. DynamoDB_Vector_Lambda は SearchVectors のみ / 2 本のインデックス ARN のみ（要件 17.1）──
    const searchVectorsStatements = featureStatements.filter((statement) =>
      statement.actions.includes('dynamodb:SearchVectors')
    );
    expect(searchVectorsStatements).toHaveLength(1);
    const searchVectors = searchVectorsStatements[0];
    expect(searchVectors.actions).toEqual(['dynamodb:SearchVectors']);
    expect(searchVectors.resources.slice().sort()).toEqual(
      [
        `\${${vectorTableId}.Arn}/index/byEmbeddingEn`,
        `\${${vectorTableId}.Arn}/index/byEmbeddingJa`,
      ].sort()
    );
    // テーブル ARN そのものは Resource にしない
    expect(searchVectors.resources).not.toContain(`\${${vectorTableId}.Arn}`);

    const ddbSearchActions = featureStatements
      .filter((statement) => /^FunctionsVectorSearchDdbFunctionServiceRole/.test(statement.roleLogicalId))
      .flatMap((statement) => statement.actions);
    for (const forbidden of ['dynamodb:Query', 'dynamodb:Scan', 'dynamodb:PartiQLSelect']) {
      expect(ddbSearchActions).not.toContain(forbidden);
    }
    for (const forbidden of FORBIDDEN_WRITE_ACTIONS) {
      expect(ddbSearchActions).not.toContain(forbidden);
    }

    // ── 4b. OpenSearch_Vector_Lambda の DynamoDB 権限（要件 17.15、案 D）──
    // Vector_Verification_Path のために追加する権限は `dynamodb:GetItem` のみであり、
    // Resource は Query_Vector_Cache と Vector_Table の**テーブル ARN**に限る。
    // `SearchVectors` / `Query` / `Scan` / 書き込み Action / Good_Table の ARN /
    // ベクトルインデックスの ARN / `Resource: "*"` を含めない
    const aossRoleStatements = featureStatements.filter((statement) =>
      /^FunctionsVectorSearchAossFunctionServiceRole/.test(statement.roleLogicalId)
    );
    expect(aossRoleStatements.length).toBeGreaterThan(0);

    const vectorTableArn = `\${${vectorTableId}.Arn}`;
    const queryCacheArn = `\${${queryCacheTableId}.Arn}`;
    const aossDynamoStatements = aossRoleStatements.filter((statement) =>
      statement.actions.some((action) => action.startsWith('dynamodb:'))
    );
    // Query_Vector_Cache 用と Vector_Table 用の 2 件（後者が本タスクで追加した新規ステートメント）
    expect(aossDynamoStatements).toHaveLength(2);
    for (const statement of aossDynamoStatements) {
      expect(statement.actions).toEqual(['dynamodb:GetItem']);
      expect(statement.resources).toHaveLength(1);
      const resource = statement.resources[0];
      expect([vectorTableArn, queryCacheArn]).toContain(resource);
      expect(resource).not.toBe('*');
      expect(resource).not.toContain('/index/');
      expect(referencesResource(resource, goodTableId)).toBe(false);
    }
    // Vector_Table のテーブル ARN を Resource とする GetItem がちょうど 1 件存在する
    expect(
      aossDynamoStatements.filter((statement) => statement.resources[0] === vectorTableArn)
    ).toHaveLength(1);

    const aossActions = aossRoleStatements.flatMap((statement) => statement.actions);
    for (const forbidden of [
      'dynamodb:SearchVectors',
      'dynamodb:Query',
      'dynamodb:Scan',
      'dynamodb:PartiQLSelect',
      'dynamodb:DescribeTable',
      ...FORBIDDEN_WRITE_ACTIONS,
    ]) {
      expect(aossActions).not.toContain(forbidden);
    }

    // ── 5. Index_Provisioner の Resource は Vector_Table のみ（要件 17.2）──
    const provisionerStatements = featureStatements.filter((statement) =>
      /^VectorIndex(OnEvent|IsComplete)FunctionServiceRole/.test(statement.roleLogicalId)
    );
    expect(provisionerStatements.length).toBeGreaterThan(0);
    for (const statement of provisionerStatements) {
      for (const resource of statement.resources) {
        expect(resource).toBe(`\${${vectorTableId}.Arn}`);
        expect(referencesResource(resource, goodTableId)).toBe(false);
      }
    }

    // ── 6. Bedrock はモデル ARN 1 件のみ（要件 17.5 / 17.6）──
    const expectedModelArn = `arn:aws:bedrock:${TEST_REGION}::foundation-model/${EMBEDDING_MODEL_ID}`;
    const bedrockStatements = featureStatements.filter((statement) =>
      statement.actions.some((action) => action.startsWith('bedrock:'))
    );
    // 埋め込みバッチとクエリ埋め込みの 2 件
    expect(bedrockStatements).toHaveLength(2);
    for (const statement of bedrockStatements) {
      expect(statement.actions).toEqual(['bedrock:InvokeModel']);
      expect(statement.resources).toEqual([expectedModelArn]);
      expect(statement.resources[0]).not.toContain('*');
    }

    // ── 7. Query_Embedding_Lambda は Query_Vector_Cache 以外を触らない（要件 17.6）──
    const queryEmbedStatements = featureStatements.filter((statement) =>
      /^FunctionsVectorQueryEmbedFunctionServiceRole/.test(statement.roleLogicalId)
    );
    expect(queryEmbedStatements.length).toBeGreaterThan(0);
    for (const statement of queryEmbedStatements) {
      for (const resource of statement.resources) {
        expect(referencesResource(resource, goodTableId)).toBe(false);
        expect(referencesResource(resource, vectorTableId)).toBe(false);
        expect(referencesResource(resource, vectorCollectionId)).toBe(false);
      }
      expect(statement.actions.some((action) => action.startsWith('aoss:'))).toBe(false);
      // DynamoDB を触るステートメントの Resource は Query_Vector_Cache のみ
      if (statement.actions.some((action) => action.startsWith('dynamodb:'))) {
        expect(statement.resources).toEqual([`\${${queryCacheTableId}.Arn}`]);
      }
    }

    // ── 8. データアクセスポリシー: Principal 3 件・読み取り / 書き込み / インデックス管理の分離
    //       （要件 17.4 / 17.7 / 17.12）──
    const dataPolicyId = findLogicalId(
      vectorTemplate,
      'AWS::OpenSearchServerless::AccessPolicy',
      (props) => props.Name === `${VECTOR_COLLECTION_NAME}-data`
    );
    // ベクトル側のポリシーは本機能由来である（既存ポリシーを流用していない、要件 17.8）
    expect(featureLogicalIds).toContain(dataPolicyId);
    const dataPolicyProps = vectorTemplate.Resources[dataPolicyId].Properties ?? {};
    const dataPolicyStatements = JSON.parse(renderValue(dataPolicyProps.Policy)) as {
      Rules: { ResourceType: string; Resource: string[]; Permission: string[] }[];
      Principal: string[];
    }[];
    // 検索 Lambda（読み取り）、埋め込みバッチ（書き込み）、CloudFormation 実行ロール
    // （インデックスライフサイクル）の 3 件。
    //
    // **4 件目を追加しない。** Vector_Verification_Path（案 D）は検証専用 Lambda を作らず、
    // 既に ReadDocument / DescribeIndex を持つ検索 Lambda に相乗りする。検証専用 Lambda を
    // 追加すると、その実行ロールが 4 件目の Principal になり本項の構成そのものが崩れる
    // （前提 A17 / 要件 17.7）。この件数が 3 を超えたらこのテストが落ちる
    expect(dataPolicyStatements).toHaveLength(3);

    /** 検索 Lambda のステートメントに現れてはならない権限（要件 17.4） */
    const forbiddenSearchPermissions = [
      'aoss:WriteDocument',
      'aoss:CreateIndex',
      'aoss:UpdateIndex',
      'aoss:DeleteIndex',
      'aoss:DeleteCollectionItems',
    ];
    /**
     * CloudFormation 実行ロールのステートメントに現れてはならない権限。
     *
     * 実行ロールはインデックスを管理するだけで、ドキュメントの読み書きは行わない。
     */
    const forbiddenDeployPermissions = [
      'aoss:ReadDocument',
      'aoss:WriteDocument',
      'aoss:DeleteCollectionItems',
    ];
    let searchPrincipal: string | undefined;
    let writePrincipal: string | undefined;
    let deployPrincipal: string | undefined;
    for (const statement of dataPolicyStatements) {
      expect(statement.Principal).toHaveLength(1);
      const principal = statement.Principal[0];
      // ワイルドカードと Ingestion_Pipeline のロールを含まない
      expect(principal).not.toContain('*');
      expect(referencesResource(principal, pipelineRoleId)).toBe(false);

      const permissions = statement.Rules.flatMap((rule) => rule.Permission);
      for (const rule of statement.Rules) {
        expect(rule.ResourceType).toBe('index');
        expect(rule.Resource).toEqual([`index/${VECTOR_COLLECTION_NAME}/${VECTOR_INDEX_NAME}`]);
      }
      if (permissions.includes('aoss:WriteDocument')) {
        writePrincipal = principal;
        // 書き込み専用: WriteDocument のみで、インデックスライフサイクル権限を含まない（要件 6.8）
        expect(permissions.slice().sort()).toEqual(['aoss:WriteDocument']);
      } else if (permissions.includes('aoss:CreateIndex')) {
        deployPrincipal = principal;
        // インデックスライフサイクル 4 件のみ（要件 17.7）
        expect(permissions.slice().sort()).toEqual([
          'aoss:CreateIndex',
          'aoss:DeleteIndex',
          'aoss:DescribeIndex',
          'aoss:UpdateIndex',
        ]);
        for (const forbidden of forbiddenDeployPermissions) {
          expect(permissions).not.toContain(forbidden);
        }
      } else {
        searchPrincipal = principal;
        // 読み取り専用: 書き込み系権限を 1 つも含まない
        expect(permissions.slice().sort()).toEqual(['aoss:DescribeIndex', 'aoss:ReadDocument']);
        for (const forbidden of forbiddenSearchPermissions) {
          expect(permissions).not.toContain(forbidden);
        }
      }
    }
    // 3 つの役割がすべて 1 件ずつ現れている（どれかが欠けたまま通らない）
    expect(searchPrincipal, '検索 Lambda のステートメントが無い').toBeDefined();
    expect(writePrincipal, '埋め込みバッチのステートメントが無い').toBeDefined();
    expect(deployPrincipal, 'CloudFormation 実行ロールのステートメントが無い').toBeDefined();

    // Principal は実行ロールの ARN 参照そのものであり、文字列連結で組んだ値ではない
    expect(searchPrincipal).toMatch(/^\$\{[A-Za-z0-9]+\.Arn\}$/);
    expect(writePrincipal).toMatch(/^\$\{[A-Za-z0-9]+\.Arn\}$/);
    // 実行ロールはこのスタックが作るリソースではないため `${論理ID.Arn}` にはならず、
    // ブートストラップの命名から導出したアカウント / リージョン込みの ARN になる（要件 17.7）
    expect(deployPrincipal).not.toMatch(/^\$\{[A-Za-z0-9]+\.Arn\}$/);
    expect(deployPrincipal).toContain('cfn-exec-role');
    expect(deployPrincipal).toContain(TEST_ACCOUNT);
    expect(deployPrincipal).toContain(TEST_REGION);
    const searchRoleId = placeholderTarget(searchPrincipal!);
    const writeRoleId = placeholderTarget(writePrincipal!);
    expect(searchRoleId).toMatch(/^FunctionsVectorSearchAossFunctionServiceRole/);
    expect(writeRoleId).toMatch(/^FunctionsVectorEmbedBatchFunctionServiceRole/);

    // Vector_Collection へ書き込むロールは IAM 側の `aoss:APIAccessAll` も同時に持つ（要件 17.12）
    const collectionArn = `\${${vectorCollectionId}.Arn}`;
    const writeRoleIamGrant = featureStatements.find(
      (statement) =>
        statement.roleLogicalId === writeRoleId &&
        statement.actions.includes('aoss:APIAccessAll') &&
        statement.resources.includes(collectionArn)
    );
    expect(writeRoleIamGrant).toBeDefined();
    // 検索側も Collection ARN のみを Resource とする（要件 17.4）
    const searchRoleAossStatements = featureStatements.filter(
      (statement) =>
        statement.roleLogicalId === searchRoleId &&
        statement.actions.some((action) => action.startsWith('aoss:'))
    );
    expect(searchRoleAossStatements).toHaveLength(1);
    expect(searchRoleAossStatements[0].actions).toEqual(['aoss:APIAccessAll']);
    expect(searchRoleAossStatements[0].resources).toEqual([collectionArn]);

    // ── 9. 本機能由来ロールのマネージドポリシーは Lambda 基本実行ロールのみ ──
    for (const logicalId of featureLogicalIds) {
      const resource = vectorTemplate.Resources[logicalId];
      if (resource.Type !== 'AWS::IAM::Role') continue;
      for (const arn of renderList((resource.Properties ?? {}).ManagedPolicyArns)) {
        expect(arn).toContain('service-role/AWSLambdaBasicExecutionRole');
      }
    }

    // ── 10. 環境変数キー名に資格情報を示す名称が現れない（要件 17.9）──
    const environmentKeys: string[] = [];
    for (const logicalId of featureLogicalIds) {
      const resource = vectorTemplate.Resources[logicalId];
      if (resource.Type !== 'AWS::Lambda::Function') continue;
      const variables =
        ((resource.Properties ?? {}).Environment as { Variables?: Record<string, unknown> })
          ?.Variables ?? {};
      environmentKeys.push(...Object.keys(variables));
    }
    expect(environmentKeys.length).toBeGreaterThan(0);
    const assertNotCredentialKey = (key: string): void => {
      expect(CREDENTIAL_KEY_PATTERN.test(key), `資格情報を示す環境変数キー: ${key}`).toBe(false);
    };
    for (const key of environmentKeys) assertNotCredentialKey(key);
    fc.assert(fc.property(fc.constantFrom(...environmentKeys), assertNotCredentialKey), {
      numRuns: 100,
    });
  });

  // Feature: vector-search-comparison, Property 56: description の文字集合
  // 任意の 本機能由来の合成テンプレート内リソース（IAM ロール・ポリシー、OpenSearch Serverless の
  // 各ポリシー、Collection、Collection Group、Lambda、Vector_Table、Query_Vector_Cache、
  // Index_Provisioner）の description に対して、含まれる文字は正規表現
  // `^[\u0009\u000A\u000D\u0020-\u007E\u00A1-\u00FF]*$` に一致し、日本語文字および `→` を含まない。
  // **Validates: Requirements 5.12, 6.12, 17.14**
  it('本機能由来リソースの description が ASCII 印字可能文字のみで、日本語と矢印を含まない', () => {
    const descriptions: { logicalId: string; type: string; description: string }[] = [];
    for (const logicalId of featureLogicalIds) {
      const resource = vectorTemplate.Resources[logicalId];
      const description = (resource.Properties ?? {}).Description;
      if (typeof description === 'string') {
        descriptions.push({ logicalId, type: resource.Type, description });
      }
    }

    // Lambda 5 本 + Index_Provisioner 2 本 + Provider framework 3 本 +
    // Collection Group / Collection / 暗号化 / ネットワーク / データアクセスの 5 本
    expect(descriptions.length).toBeGreaterThanOrEqual(15);

    const assertDescriptionCharset = (entry: {
      logicalId: string;
      type: string;
      description: string;
    }): void => {
      expect(
        DESCRIPTION_CHARSET_PATTERN.test(entry.description),
        `${entry.type} ${entry.logicalId} の description に許容外の文字がある: ${entry.description}`
      ).toBe(true);
      expect(
        JAPANESE_OR_ARROW_PATTERN.test(entry.description),
        `${entry.type} ${entry.logicalId} の description に日本語または矢印が含まれる: ${entry.description}`
      ).toBe(false);
    };
    for (const entry of descriptions) assertDescriptionCharset(entry);
    fc.assert(fc.property(fc.constantFrom(...descriptions), assertDescriptionCharset), {
      numRuns: 100,
    });

    // 判定が空虚に成立していないことの確認:
    // 日本語文字または矢印を含む任意の文字列は、上記 2 つの判定のいずれかで弾かれる
    fc.assert(
      fc.property(
        fc.string(),
        fc.constantFrom('→', '⇒', 'ベクトル', '検索', '（', '。'),
        fc.string(),
        (prefix, injected, suffix) => {
          const candidate = `${prefix}${injected}${suffix}`;
          const accepted =
            DESCRIPTION_CHARSET_PATTERN.test(candidate) &&
            !JAPANESE_OR_ARROW_PATTERN.test(candidate);
          expect(accepted, `日本語または矢印を含む文字列が受理された: ${candidate}`).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});
