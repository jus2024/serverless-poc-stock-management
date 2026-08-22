import { Lazy } from 'aws-cdk-lib';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource.js';
import { data } from './data/resource.js';
import { InventoryTablesConstruct } from './custom/dynamodb-tables.js';
import { LambdaFunctionsConstruct } from './custom/lambda-functions.js';
import { InventoryApiConstruct } from './custom/api-gateway.js';
import { OpenSearchInfraConstruct } from './custom/opensearch-infra.js';
import { VectorCollectionConstruct } from './custom/vector-collection.js';
import { VectorIndexConstruct } from './custom/vector-index.js';
import { resolveEmbeddingDimensions } from './functions/shared/vector/embedding-generator.js';

const backend = defineBackend({
  auth,
  data,
});

// カスタムリソース用の CDK スタックを作成
const customStack = backend.createStack('InventoryStack');

// DynamoDB テーブル（Good_Table / Executions / Vector_Table / Query_Vector_Cache）
const tables = new InventoryTablesConstruct(customStack, 'Tables');

// OpenSearch Serverless NextGen インフラ（Good Table のデータを同期）
const opensearch = new OpenSearchInfraConstruct(customStack, 'OpenSearch', {
  sourceTable: tables.goodTable,
});

// ─── ベクトル検索比較の配線 ──────────────────────────────────────────
// 次元数はここで 1 度だけ解決し、Vector Collection / Vector Index / 各 Lambda の
// 環境変数へ同一値を配る（3 者で食い違うと検索が DIMENSION_MISMATCH になる）。
const vectorDimensions = resolveEmbeddingDimensions();

/**
 * Vector Collection。
 *
 * データアクセスポリシーの Principal は検索 AOSS ロール（読み取りのみ）、バッチロール（書き込みのみ）、
 * CloudFormation 実行ロール（インデックスライフサイクルのみ）の 3 件である（要件 17.7）。実行ロール
 * ARN は Construct 側がスタックのシンセサイザから導出するため、ここでは渡さない。一方で
 * 検索 AOSS Lambda は Collection のエンドポイントを環境変数に必要とする。
 * この見かけ上の循環は `Lazy.string()` で解く。
 *
 * - Collection を先に作ることで、エンドポイントと ARN を Lambda 定義へ直接渡せる
 * - ロール ARN は合成時に解決される遅延値として渡すため、Lambda を後から定義できる
 * - CloudFormation 上の依存は「データアクセスポリシー → IAM ロール」と
 *   「Lambda / ロールのポリシー → Collection」であり、リソース単位では循環しない
 *   （既存 `opensearch-infra.ts` の事後 `addPropertyOverride` と同じ依存の向き。
 *    ポリシー文書と Principal の定義を Construct 内の 1 箇所に保てる点で本方式を採る）
 *
 * デプロイ段階ゲート（既定 false）が false の段階では Collection Group のみが作られ、
 * `collectionEnabled` が false になる。フラグの解釈はこの Construct が唯一の出典であり、
 * 以降の段階判定はその結果を参照する。値は CDK コンテキスト `vectorCollectionEnabled`、
 * 次に環境変数 `VECTOR_COLLECTION_ENABLED` の順で解決する（`ampx sandbox` に `--context` は
 * 無く、`CDK_CONTEXT_JSON` も合成に届かないため、実デプロイでは環境変数が唯一の経路）。
 * Stage B 適用後にフラグ無しで再合成すると Collection / Index / 検索 Lambda が削除される点は
 * `vector-collection.ts` のヘッダーに記載した。
 */
const vectorCollection = new VectorCollectionConstruct(customStack, 'VectorCollection', {
  dimensions: vectorDimensions,
  searchLambdaRoleArn: Lazy.string({
    // 戻り値の型を明示する（`functions` を閉じ込めるため型推論が循環する）
    produce: (): string =>
      requireRoleArn(functions.vectorSearchAossFunction, 'kiro-vector-search-aoss'),
  }),
  embeddingJobRoleArn: Lazy.string({
    produce: (): string =>
      requireRoleArn(functions.vectorEmbedBatchFunction, 'kiro-vector-embed-batch'),
  }),
});

// ベクトルインデックス 2 本（Stage B のみ）。Vector_Table のみに依存する
const vectorIndex = vectorCollection.collectionEnabled
  ? new VectorIndexConstruct(customStack, 'VectorIndex', {
      vectorTable: tables.vectorTable,
      dimensions: vectorDimensions,
    })
  : undefined;

// Lambda 関数（テーブル参照を渡す）
const functions = new LambdaFunctionsConstruct(customStack, 'Functions', {
  goodTable: tables.goodTable,
  executionsTable: tables.executionsTable,
  opensearchEndpoint: opensearch.collectionEndpoint,
  opensearchCollectionArn: opensearch.collectionArn,
  vector: {
    vectorTable: tables.vectorTable,
    queryCacheTable: tables.queryCacheTable,
    dimensions: vectorDimensions,
    searchEnabled: vectorCollection.collectionEnabled,
    vectorIndexArns: vectorIndex ? Object.values(vectorIndex.indexArns) : undefined,
    vectorCollectionEndpoint: vectorCollection.collectionEndpoint,
    vectorCollectionArn: vectorCollection.collectionArn,
    vectorIndexName: vectorCollection.indexName,
  },
});

// API Gateway（Lambda 関数参照を渡す）
const api = new InventoryApiConstruct(customStack, 'Api', {
  queryFunction: functions.queryFunction,
  shipFunction: functions.shipFunction,
  loadTestStartFunction: functions.loadTestStartFunction,
  loadTestStatusFunction: functions.loadTestStatusFunction,
  seedFunction: functions.seedFunction,
  onlineImpactTestFunction: functions.onlineImpactTestFunction,
  opensearchSearchFunction: functions.opensearchSearchFunction,
  vectorCapabilitiesFunction: functions.vectorCapabilitiesFunction,
  vectorQueryEmbedFunction: functions.vectorQueryEmbedFunction,
  vectorSearchDdbFunction: functions.vectorSearchDdbFunction,
  vectorSearchAossFunction: functions.vectorSearchAossFunction,
  vectorEmbedBatchFunction: functions.vectorEmbedBatchFunction,
});

// OpenSearch Data Access Policy に検索 Lambda のロールを追加（循環依存回避のため事後追加）
if (functions.opensearchSearchFunction) {
  const lambdaRoleArn = functions.opensearchSearchFunction.role!.roleArn;
  const collectionName = 'kiro-inventory-search';
  opensearch.dataAccessPolicy.addPropertyOverride('Policy', JSON.stringify([
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
      Principal: [opensearch.pipelineRole.roleArn, lambdaRoleArn],
    },
  ]));
}

// API URL と OpenSearch エンドポイントをフロントエンドから参照可能にする
backend.addOutput({
  custom: {
    inventoryApiUrl: api.apiUrl,
    opensearchEndpoint: opensearch.collectionEndpoint,
  },
});

/**
 * Lambda 実行ロールの ARN を取り出す（`Lazy.string()` の produce から呼ぶ）。
 *
 * 対象 Lambda が作られていない段階（`vectorCollectionEnabled=false`）では
 * データアクセスポリシー自体が作られないため、この関数は呼ばれない。
 * それでも呼ばれた場合は Principal を欠いたポリシーを合成せず、明示的に失敗させる。
 */
function requireRoleArn(fn: lambda.Function | undefined, functionName: string): string {
  const role = fn?.role;
  if (!role) {
    throw new Error(
      `Vector data access policy requires the execution role of ${functionName}, ` +
        'but the function was not created. Check the vectorCollectionEnabled context flag wiring.'
    );
  }
  return role.roleArn;
}
