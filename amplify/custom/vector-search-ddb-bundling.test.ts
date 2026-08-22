/**
 * `kiro-vector-search-ddb` のバンドル設定の回帰ガード。
 *
 * **何を防ぐテストか。**`NodejsFunction` は Node 18+ で `externalModules: ['@aws-sdk/*']` を
 * 既定とするため、既定のままだと `@aws-sdk/client-dynamodb` が Lambda 同梱の SDK へ解決される。
 * 同梱 SDK のモデルには `TableDescription.VectorIndexes` が無く（欠落・存在の境界は 3.1103.0）、
 * AWS SDK v3 の逆シリアライズはモデル駆動であるため、**モデルに無いフィールドはエラーも警告も
 * なく捨てられる**。結果として `DescribeTable` の応答に情報が入っていても
 * `vector-search-ddb/handler.ts` の `readVectorIndexDescriptions()` は空配列を受け取り、
 * ACTIVE なベクトルインデックスを「存在しない」と判定して `INDEX_NOT_FOUND` を返す。
 *
 * **なぜハンドラの単体テストでは検出できないか。**`handler.test.ts` と `search-parity.test.ts` は
 * `@aws-sdk/client-dynamodb` を差し替え、`DescribeTable` に `VectorIndexes` を含む応答を返させる。
 * 実行時にどのバージョンの SDK へ解決されるかはテストの関心の外にあり、既定のバンドル設定に
 * 戻してもこれらのテストは通り続ける。検出できる層は合成（CDK）側だけである。
 *
 * **なぜテンプレート検査ではなく構築引数を見るのか。**バンドル設定は合成テンプレートに現れない
 * （現れるのはアセットのハッシュのみ）。`Template.fromStack` からは判定できないため、
 * `NodejsFunction` の構築引数を記録して突き合わせる。関数がテンプレート上に実在することの
 * 確認だけは `Template.fromStack` で併せて行う。
 *
 * 合成はインメモリのみ（`aws:cdk:bundling-stacks: []` で esbuild も走らせない）。
 * AWS へのデプロイも API 呼び出しも行わない。
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';

/** `NodejsFunction` の構築引数の記録簿。`vi.mock` の巻き上げより先に初期化する */
const recorder = vi.hoisted(() => ({
  entries: [] as { constructId: string; functionName?: string; externalModules?: string[] }[],
}));

vi.mock('aws-cdk-lib/aws-lambda-nodejs', async (importOriginal) => {
  const original = await importOriginal<typeof nodejs>();

  /**
   * 実物を継承し、構築引数だけを記録して `super` に素通しする。
   * 合成結果は差し替え前と同一になる（`Template` 側の確認が成り立つ根拠）。
   */
  class RecordingNodejsFunction extends original.NodejsFunction {
    constructor(scope: never, id: string, props: nodejs.NodejsFunctionProps) {
      recorder.entries.push({
        constructId: id,
        functionName: props.functionName,
        externalModules: props.bundling?.externalModules
          ? [...props.bundling.externalModules]
          : undefined,
      });
      super(scope, id, props);
    }
  }

  return { ...original, NodejsFunction: RecordingNodejsFunction };
});

const SYNTH_ENV = { account: '123456789012', region: 'us-west-2' } as const;
const TEST_DIMENSIONS = 1024;

/** 判定対象。`kiro-vector-search-ddb` だけがこの関数名を持つ */
const TARGET_FUNCTION_NAME = 'kiro-vector-search-ddb';

/**
 * `externalModules` が `@aws-sdk/*` を外部化していないか。
 *
 * 判定は「`[]` という値の一致」ではなく「`@aws-sdk` を指す要素が 1 つも無いこと」で行う。
 * `externalModules: ['some-other-package']` のように書き換えられても、
 * SDK が同梱されている限り通す。逆に `undefined`（既定 = `['@aws-sdk/*']`）は落とす。
 */
function bundlesAwsSdk(externalModules: string[] | undefined): boolean {
  if (externalModules === undefined) return false;
  return !externalModules.some((entry) => entry.includes('@aws-sdk'));
}

let template: Template;

beforeAll(async () => {
  // 静的 import にすると `vi.mock` の差し替え前に評価されるため、合成後に読む
  const { LambdaFunctionsConstruct } = await import('./lambda-functions.js');

  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new Stack(app, 'VectorSearchDdbBundlingStack', { env: SYNTH_ENV });

  const goodTable = new dynamodb.Table(stack, 'GoodTable', {
    partitionKey: { name: 'itemId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'warehouseId', type: dynamodb.AttributeType.STRING },
  });
  const executionsTable = new dynamodb.Table(stack, 'ExecutionsTable', {
    partitionKey: { name: 'executionId', type: dynamodb.AttributeType.STRING },
  });
  const vectorTable = new dynamodb.Table(stack, 'VectorTable', {
    partitionKey: { name: 'itemId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'warehouseId', type: dynamodb.AttributeType.STRING },
  });
  const queryCacheTable = new dynamodb.Table(stack, 'QueryCacheTable', {
    partitionKey: { name: 'queryId', type: dynamodb.AttributeType.STRING },
  });

  // Stage B（検索系 5 本まで作る最大構成）で合成する。
  // ベクトルインデックス ARN は `VectorIndexConstruct` を経由せずリテラルで渡す
  // （本テストの関心は IAM ではなくバンドル設定であるため）
  new LambdaFunctionsConstruct(stack, 'Functions', {
    goodTable,
    executionsTable,
    vector: {
      vectorTable,
      queryCacheTable,
      dimensions: TEST_DIMENSIONS,
      searchEnabled: true,
      vectorIndexArns: [
        `${vectorTable.tableArn}/index/byEmbeddingJa`,
        `${vectorTable.tableArn}/index/byEmbeddingEn`,
      ],
      vectorCollectionEndpoint: 'https://example.us-west-2.aoss.amazonaws.com',
      vectorCollectionArn: `arn:aws:aoss:${SYNTH_ENV.region}:${SYNTH_ENV.account}:collection/abcdefghij`,
      vectorIndexName: 'inventory-vector',
    },
  });

  template = Template.fromStack(stack);
});

describe('kiro-vector-search-ddb のバンドル設定', () => {
  it('合成対象に含まれている（記録簿とテンプレートの両方で確認できる）', () => {
    const recorded = recorder.entries.filter((entry) => entry.functionName === TARGET_FUNCTION_NAME);
    expect(recorded).toHaveLength(1);

    const functions = template.findResources('AWS::Lambda::Function');
    const names = Object.values(functions).map(
      (resource) => (resource.Properties as { FunctionName?: string }).FunctionName
    );
    expect(names).toContain(TARGET_FUNCTION_NAME);
  });

  it('`@aws-sdk/*` を外部化せず SDK を同梱する', () => {
    // 既定（`externalModules` 未指定 = `['@aws-sdk/*']`）に戻すとここで落ちる。
    // 同梱 SDK のモデルに `TableDescription.VectorIndexes` が無い環境では、
    // `DescribeTable` の応答から当該フィールドが黙って消え、ACTIVE な
    // インデックスに対して `INDEX_NOT_FOUND` を返すようになる
    const [recorded] = recorder.entries.filter(
      (entry) => entry.functionName === TARGET_FUNCTION_NAME
    );

    expect(recorded.externalModules).toBeDefined();
    expect(bundlesAwsSdk(recorded.externalModules)).toBe(true);
  });
});

describe('他の Lambda のバンドル設定', () => {
  it('`kiro-vector-search-ddb` 以外は既定のバンドル設定を保つ', () => {
    // 影響範囲を 1 本に閉じ込めるためのガード。`commonProps` 側へ移すとここで落ちる。
    // 既存 8 本（inventory 系）と検索系の残り 4 本のコールドスタートとバンドルサイズを
    // 変えないことを固定する
    const others = recorder.entries.filter(
      (entry) => entry.functionName !== TARGET_FUNCTION_NAME
    );

    expect(others.length).toBeGreaterThan(0);
    for (const entry of others) {
      expect(
        entry.externalModules,
        `${entry.functionName ?? entry.constructId} のバンドル設定が変更されている`
      ).toBeUndefined();
    }
  });
});
