/**
 * `vector-index.ts` の合成テスト
 *
 * 主眼は、カスタムリソースが `SearchSchema` の各要素に対応する属性定義を持つことを固定する
 * ことである。
 *
 * 経緯: Stage B のデプロイで `vector-index-provisioner` が CREATE_FAILED になった。
 *
 *   One or more parameter values were invalid:
 *   One element in SearchSchema is not defined in attribute definitions
 *
 * `UpdateTable` は GSI 追加と同じ規則で、`SearchSchema` に載せた属性が **同一リクエストの**
 * `AttributeDefinitions` に宣言されていることを要求する。テーブル側の既存定義とのマージでは
 * ないため、`warehouseId` が Vector_Table のソートキーとして定義済みでも通らない。
 * 属性型はテーブル定義（`dynamodb-tables.ts` の `sortKey`）から導出して
 * `SearchSchemaAttributeDefinitions` プロパティでハンドラへ渡す。本テストはその配線を固定する。
 *
 * 合成は in-memory のみ。AWS への呼び出しとデプロイは一切行わない。
 * `aws:cdk:bundling-stacks: []` で `NodejsFunction` のバンドルを抑止する。
 *
 * 要件: 5.2, 5.3, 5.4
 */

import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { describe, expect, it } from 'vitest';

import { InventoryTablesConstruct } from './dynamodb-tables';
import { VECTOR_INDEX_INLINE_FILTER_ATTRIBUTE, VectorIndexConstruct } from './vector-index';

/** `vector-index.ts` の `CUSTOM_RESOURCE_TYPE`（非公開のためリテラルで写す） */
const CUSTOM_RESOURCE_TYPE = 'Custom::DynamoDBVectorIndex';

/** 本テストで固定する次元数（環境変数の影響を受けないよう明示して渡す） */
const TEST_DIMENSIONS = 1024;

/** CloudFormation テンプレート上のカスタムリソースのプロパティ（必要な部分のみ） */
interface VectorIndexResourceProperties {
  IndexName?: unknown;
  SearchSchema?: readonly { AttributeName?: unknown }[];
  SearchSchemaAttributeDefinitions?: readonly { AttributeName?: unknown; AttributeType?: unknown }[];
}

/** Vector_Table 込みでスタックを合成し、ベクトルインデックスのカスタムリソースを取り出す */
function synthesizeVectorIndexResources(): VectorIndexResourceProperties[] {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new Stack(app, 'InventoryStack', {
    env: { account: '123456789012', region: 'us-west-2' },
  });

  const tables = new InventoryTablesConstruct(stack, 'Tables');
  new VectorIndexConstruct(stack, 'VectorIndex', {
    vectorTable: tables.vectorTable,
    dimensions: TEST_DIMENSIONS,
  });

  const found = Template.fromStack(stack).findResources(CUSTOM_RESOURCE_TYPE);
  return Object.values(found).map((resource) => resource.Properties as VectorIndexResourceProperties);
}

describe('ベクトルインデックスのカスタムリソース', () => {
  it('2 本のインデックスすべてが SearchSchema の属性定義を持つ', () => {
    const resources = synthesizeVectorIndexResources();

    expect(resources).toHaveLength(2);
    expect(resources.map((properties) => properties.IndexName)).toEqual([
      'byEmbeddingJa',
      'byEmbeddingEn',
    ]);

    for (const properties of resources) {
      expect(properties.SearchSchemaAttributeDefinitions).toEqual([
        { AttributeName: VECTOR_INDEX_INLINE_FILTER_ATTRIBUTE, AttributeType: 'S' },
      ]);
    }
  });

  it('属性定義の属性名集合が SearchSchema の属性名集合と一致する', () => {
    for (const properties of synthesizeVectorIndexResources()) {
      const referenced = (properties.SearchSchema ?? []).map((element) => element.AttributeName);
      const declared = (properties.SearchSchemaAttributeDefinitions ?? []).map(
        (definition) => definition.AttributeName
      );

      expect(declared.length).toBeGreaterThan(0);
      expect([...declared].sort()).toEqual([...referenced].sort());
    }
  });

  it('ベクトル属性とテーブルの PK を属性定義に載せない', () => {
    // ドキュメントの `CreateTable` 例でもベクトル属性は `AttributeDefinitions` に宣言されない。
    // PK も `SearchSchema` に HASH 要素が無いため不要である
    for (const properties of synthesizeVectorIndexResources()) {
      const declared = (properties.SearchSchemaAttributeDefinitions ?? []).map(
        (definition) => definition.AttributeName
      );

      expect(declared).not.toContain('embeddingJa');
      expect(declared).not.toContain('embeddingEn');
      expect(declared).not.toContain('itemId');
    }
  });

  it('SearchSchema の属性がテーブルのキーでなければ合成時に失敗する', () => {
    // 属性型をテーブル定義から導出できない配線は、デプロイまで遅らせず合成で止める
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const stack = new Stack(app, 'InventoryStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });
    const tableWithoutSortKey = new dynamodb.Table(stack, 'TableWithoutSortKey', {
      partitionKey: { name: 'itemId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    expect(
      () =>
        new VectorIndexConstruct(stack, 'VectorIndex', {
          vectorTable: tableWithoutSortKey,
          dimensions: TEST_DIMENSIONS,
        })
    ).toThrow(/SearchSchema attribute "warehouseId" is not a key attribute/);
  });
});
