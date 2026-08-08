import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource.js';
import { data } from './data/resource.js';
import { InventoryTablesConstruct } from './custom/dynamodb-tables.js';
import { LambdaFunctionsConstruct } from './custom/lambda-functions.js';
import { InventoryApiConstruct } from './custom/api-gateway.js';
import { OpenSearchInfraConstruct } from './custom/opensearch-infra.js';

const backend = defineBackend({
  auth,
  data,
});

// カスタมリソース用の CDK スタックを作成
const customStack = backend.createStack('InventoryStack');

// DynamoDB テーブル
const tables = new InventoryTablesConstruct(customStack, 'Tables');

// OpenSearch Serverless NextGen インフラ（Good Table のデータを同期）
const opensearch = new OpenSearchInfraConstruct(customStack, 'OpenSearch', {
  sourceTable: tables.goodTable,
});

// Lambda 関数（テーブル参照を渡す）
const functions = new LambdaFunctionsConstruct(customStack, 'Functions', {
  goodTable: tables.goodTable,
  executionsTable: tables.executionsTable,
  opensearchEndpoint: opensearch.collectionEndpoint,
  opensearchCollectionArn: opensearch.collectionArn,
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
