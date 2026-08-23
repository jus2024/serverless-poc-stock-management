import { describe, expect, it } from "vitest";
import { App, Stack, RemovalPolicy } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";

/**
 * テスト基盤の疎通確認。
 *
 * 既存の `aws-cdk-lib` に同梱された `assertions`（`Template.fromStack`）が
 * vitest 上で動作することだけを確認する。本機能のリソース定義に対する
 * スナップショットと最小権限の検証は task 7.4 / 7.5 で行う。
 */
describe("aws-cdk-lib/assertions の疎通確認", () => {
  it("Template.fromStack で合成テンプレートを取得できる", () => {
    const stack = new Stack(new App(), "SmokeStack");

    new Table(stack, "SmokeTable", {
      partitionKey: { name: "pk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const template = Template.fromStack(stack);

    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
    });
    expect(Object.keys(template.toJSON().Resources)).toHaveLength(1);
  });
});
