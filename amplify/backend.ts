import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource.js';
import { data } from './data/resource.js';
import { InventoryTablesConstruct } from './custom/dynamodb-tables.js';
import { LambdaFunctionsConstruct } from './custom/lambda-functions.js';
import { InventoryApiConstruct } from './custom/api-gateway.js';

const backend = defineBackend({
  auth,
  data,
});

// カスタムリソース用の CDK スタックを作成
const customStack = backend.createStack('InventoryStack');

// DynamoDB テーブル
const tables = new InventoryTablesConstruct(customStack, 'Tables');

// Lambda 関数（テーブル参照を渡す）
const functions = new LambdaFunctionsConstruct(customStack, 'Functions', {
  badTable: tables.badTable,
  goodTable: tables.goodTable,
  goodGsiTable: tables.goodGsiTable,
  badOnDemandTable: tables.badOnDemandTable,
  executionsTable: tables.executionsTable,
});

// API Gateway（Lambda 関数参照を渡す）
const api = new InventoryApiConstruct(customStack, 'Api', {
  queryFunction: functions.queryFunction,
  shipFunction: functions.shipFunction,
  loadTestStartFunction: functions.loadTestStartFunction,
  loadTestStatusFunction: functions.loadTestStatusFunction,
  seedFunction: functions.seedFunction,
  onlineImpactTestFunction: functions.onlineImpactTestFunction,
});

// API URL をフロントエンドから参照可能にする
backend.addOutput({
  custom: {
    inventoryApiUrl: api.apiUrl,
  },
});
