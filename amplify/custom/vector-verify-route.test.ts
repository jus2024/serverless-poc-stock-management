/**
 * `POST /vector-search/verify` の配線テスト（task 17.1）
 *
 * Vector_Verification_Path は**検索と同一の Lambda**（`kiro-vector-search-aoss`）が受ける。
 * 検証専用の Lambda を新設すると、その実行ロールが Vector_Collection のデータアクセス
 * ポリシーの 4 件目の Principal になり、要件 17.7 の「3 件のみ」という構成が崩れる
 * （前提 A17）。ここで固定するのは次の 3 点である。
 *
 * 1. `POST /vector-search/verify` が存在する
 * 2. その統合先が `/vector-search/opensearch` と**同一の Lambda** である
 * 3. 検証経路のために Lambda 関数が増えていない
 *
 * 合成テンプレートに対する検査のみで完結する（`Template.fromStack` はインメモリで合成する）。
 * AWS へのデプロイも API 呼び出しも行わない。
 *
 * 要件: 17.7, 17.15
 * 設計: Vector_Verification_Path（案 D）/ API エンドポイント
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';

import { InventoryApiConstruct } from './api-gateway';

/** ベクトル検索比較の Lambda 名。統合先の同一性を論理 ID 経由で確かめるために使う */
const AOSS_FUNCTION_NAME = 'kiro-vector-search-aoss';

interface TemplateJson {
  Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }>;
}

function dummyFunction(stack: Stack, id: string, functionName?: string): lambda.Function {
  return new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_20_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({});'),
    ...(functionName === undefined ? {} : { functionName }),
  });
}

function synthesize(): { json: TemplateJson; aossLogicalId: string } {
  const app = new App();
  const stack = new Stack(app, 'VerifyRouteStack', {
    env: { account: '123456789012', region: 'us-west-2' },
  });

  const vectorSearchAossFunction = dummyFunction(stack, 'Aoss', AOSS_FUNCTION_NAME);

  new InventoryApiConstruct(stack, 'Api', {
    queryFunction: dummyFunction(stack, 'Query'),
    shipFunction: dummyFunction(stack, 'Ship'),
    loadTestStartFunction: dummyFunction(stack, 'LoadTestStart'),
    loadTestStatusFunction: dummyFunction(stack, 'LoadTestStatus'),
    seedFunction: dummyFunction(stack, 'Seed'),
    onlineImpactTestFunction: dummyFunction(stack, 'OnlineImpact'),
    vectorSearchAossFunction,
  });

  return {
    json: Template.fromStack(stack).toJSON() as TemplateJson,
    aossLogicalId: stack.getLogicalId(
      vectorSearchAossFunction.node.defaultChild as lambda.CfnFunction
    ),
  };
}

/** 指定した `PathPart` の API Gateway リソースの論理 ID を引く */
function findResourceId(json: TemplateJson, pathPart: string): string {
  const found = Object.entries(json.Resources).find(
    ([, resource]) =>
      resource.Type === 'AWS::ApiGateway::Resource' &&
      (resource.Properties ?? {}).PathPart === pathPart
  );
  if (!found) throw new Error(`API Gateway resource not found: ${pathPart}`);
  return found[0];
}

/** 指定リソース配下の指定メソッドを引く */
function findMethod(
  json: TemplateJson,
  resourceLogicalId: string,
  httpMethod: string
): Record<string, unknown> {
  const found = Object.entries(json.Resources).find(([, resource]) => {
    if (resource.Type !== 'AWS::ApiGateway::Method') return false;
    const props = resource.Properties ?? {};
    const ref = (props.ResourceId as { Ref?: string } | undefined)?.Ref;
    return ref === resourceLogicalId && props.HttpMethod === httpMethod;
  });
  if (!found) throw new Error(`API Gateway method not found: ${httpMethod} ${resourceLogicalId}`);
  return found[1].Properties ?? {};
}

describe('POST /vector-search/verify の配線', () => {
  let json: TemplateJson;
  let aossLogicalId: string;

  beforeAll(() => {
    ({ json, aossLogicalId } = synthesize());
  }, 120_000);

  it('/vector-search 配下に verify リソースと POST メソッドが存在する', () => {
    const vectorSearchId = findResourceId(json, 'vector-search');
    const verifyId = findResourceId(json, 'verify');

    // verify は /vector-search の直下にある
    expect((json.Resources[verifyId].Properties ?? {}).ParentId).toEqual({ Ref: vectorSearchId });
    expect(findMethod(json, verifyId, 'POST').HttpMethod).toBe('POST');
  });

  it('統合先が /vector-search/opensearch と同一の Lambda である', () => {
    const verifyMethod = findMethod(json, findResourceId(json, 'verify'), 'POST');
    const searchMethod = findMethod(json, findResourceId(json, 'opensearch'), 'POST');

    const verifyUri = (verifyMethod.Integration as { Uri?: unknown }).Uri;
    const searchUri = (searchMethod.Integration as { Uri?: unknown }).Uri;

    expect(verifyUri).toEqual(searchUri);
    // 統合先が検索 AOSS Lambda の ARN 参照であること（別の関数へ向いていない）
    expect(JSON.stringify(verifyUri)).toContain(aossLogicalId);
  });

  it('検証経路のために Lambda 関数を増やしていない（Principal を 4 件にしない）', () => {
    const functionNames = Object.values(json.Resources)
      .filter((resource) => resource.Type === 'AWS::Lambda::Function')
      .map((resource) => (resource.Properties ?? {}).FunctionName)
      .filter((name): name is string => typeof name === 'string');

    // 名前を与えたのは検索 AOSS Lambda の 1 本のみ。検証専用 Lambda は存在しない
    expect(functionNames).toEqual([AOSS_FUNCTION_NAME]);
    expect(functionNames.some((name) => name.includes('verify'))).toBe(false);
  });
});
