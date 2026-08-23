import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App, DefaultStackSynthesizer, NestedStack, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import {
  VECTOR_COLLECTION_ENABLED_CONTEXT_KEY,
  VECTOR_COLLECTION_NAME,
  VECTOR_DEPLOY_ROLE_ARN_ENV_KEY,
  VECTOR_INDEX_NAME,
  VectorCollectionConstruct,
} from './vector-collection';

/**
 * データアクセスポリシーへ載せる CloudFormation 実行ロール ARN の導出のテスト。
 *
 * 経緯: Stage B の 2 回目のデプロイが、Index の作成でアクセス拒否になった。
 *
 *   Resource handler returned message: "Access denied for operation 'CreateIndex'."
 *   (HandlerErrorCode: AccessDenied)
 *
 * `AWS::OpenSearchServerless::Index` は AOSS の `CreateIndex` を**スタックの実行ロール**として
 * 呼ぶ。AOSS は IAM 権限に加えてデータアクセスポリシー側の許可も要求するため、当時の 2 件
 * （検索 Lambda ロール / 埋め込みバッチロール）だけではインデックスを作成できなかった。
 *
 * ここで固定するのは「実行ロール ARN をどう導出するか」であり、アカウント ID とリージョンを
 * コードへ書き込まないこと、既定以外のブートストラップへ差し替えられることを含む（要件 17.7）。
 *
 * 合成は `Template.fromStack` による in-memory のみ。AWS への呼び出しとデプロイは行わない。
 */

const TEST_ACCOUNT = '123456789012';
const TEST_REGION = 'us-west-2';
const TEST_DIMENSIONS = 1024;

/** 既定の CDK ブートストラップ修飾子（`DefaultStackSynthesizer.DEFAULT_QUALIFIER`） */
const DEFAULT_QUALIFIER = 'hnb659fds';

/** 環境変数はプロセス全体で共有されるため、各ケースの前後で保存・復元する */
let savedEnvValue: string | undefined;

beforeEach(() => {
  savedEnvValue = process.env[VECTOR_DEPLOY_ROLE_ARN_ENV_KEY];
  delete process.env[VECTOR_DEPLOY_ROLE_ARN_ENV_KEY];
});

afterEach(() => {
  if (savedEnvValue === undefined) {
    delete process.env[VECTOR_DEPLOY_ROLE_ARN_ENV_KEY];
  } else {
    process.env[VECTOR_DEPLOY_ROLE_ARN_ENV_KEY] = savedEnvValue;
  }
});

// ─── テンプレート値のレンダリング ─────────────────────────────────────────
//
// `stack.partition` は解決されないトークンのまま `Fn::Join` に畳まれるため、
// ポリシー文書は文字列ではなく組み込み関数のオブジェクトとして現れる。
// `${AWS::Partition}` のようなプレースホルダへ畳んだ 1 本の文字列に戻して比較する。

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

// ─── 合成 ────────────────────────────────────────────────────────────────

interface SynthOptions {
  /**
   * 実デプロイと同じ入れ子構成（`backend.createStack()` は `NestedStack` を作る）にするか。
   * 既定は true。`NestedStack` の `synthesizer` は実行ロールを持たないため、
   * 親スタックまで辿る経路をここで通す。
   */
  nested?: boolean;
  /** スタックの env。省略すると env 非依存スタックになる */
  env?: { account: string; region: string };
  /** CDK コンテキストへ追加する値（ブートストラップ修飾子の差し替えに使う） */
  context?: Record<string, unknown>;
  /** `VectorCollectionProps.deploymentRoleArn` へ渡す値 */
  deploymentRoleArn?: string;
  /** 環境変数 `VECTOR_DEPLOY_ROLE_ARN` へ設定する値 */
  environment?: string;
}

interface DataAccessStatement {
  Rules: { ResourceType: string; Resource: string[]; Permission: string[] }[];
  Principal: string[];
}

interface SynthResult {
  /** Construct が公開する導出結果（レンダリング済み） */
  deploymentRoleArn: string;
  /** 合成テンプレート上のデータアクセスポリシー文書 */
  statements: DataAccessStatement[];
}

function synthesize(options: SynthOptions = {}): SynthResult {
  if (options.environment !== undefined) {
    process.env[VECTOR_DEPLOY_ROLE_ARN_ENV_KEY] = options.environment;
  }

  const app = new App({
    context: {
      [VECTOR_COLLECTION_ENABLED_CONTEXT_KEY]: true,
      ...(options.context ?? {}),
    },
  });
  const env = 'env' in options ? options.env : { account: TEST_ACCOUNT, region: TEST_REGION };
  const root = new Stack(app, 'VectorDeployRoleStack', env === undefined ? {} : { env });
  const scope: Stack = options.nested === false ? root : new NestedStack(root, 'InventoryStack');

  const construct = new VectorCollectionConstruct(scope, 'VectorCollection', {
    dimensions: TEST_DIMENSIONS,
    searchLambdaRoleArn: `arn:aws:iam::${TEST_ACCOUNT}:role/search-lambda-role`,
    embeddingJobRoleArn: `arn:aws:iam::${TEST_ACCOUNT}:role/embed-batch-role`,
    deploymentRoleArn: options.deploymentRoleArn,
  });

  const policies = Template.fromStack(scope).findResources(
    'AWS::OpenSearchServerless::AccessPolicy'
  );
  const logicalIds = Object.keys(policies);
  expect(logicalIds).toHaveLength(1);
  const properties = policies[logicalIds[0]].Properties ?? {};
  expect(properties.Name).toBe(`${VECTOR_COLLECTION_NAME}-data`);

  return {
    deploymentRoleArn: resolveArn(scope, construct.deploymentRoleArn),
    statements: JSON.parse(renderValue(properties.Policy)) as DataAccessStatement[],
  };
}

/**
 * Construct が公開する ARN をテンプレート上の表現へ揃える。
 *
 * `stack.partition` などは未解決の CDK トークン（`${Token[AWS.Partition.3]}`）として
 * 文字列に埋まっているため、`stack.resolve()` で組み込み関数へ展開してから畳む。
 */
function resolveArn(scope: Stack, roleArn: string): string {
  return renderValue(scope.resolve(roleArn));
}

/** インデックスライフサイクル権限を持つステートメントを 1 件だけ取り出す */
function indexLifecycleStatement(statements: DataAccessStatement[]): DataAccessStatement {
  const found = statements.filter((statement) =>
    statement.Rules.some((rule) => rule.Permission.includes('aoss:CreateIndex'))
  );
  expect(found).toHaveLength(1);
  return found[0];
}

/** 既定ブートストラップでの期待 ARN（`${AWS::Partition}` は Ref のレンダリング結果） */
function expectedDefaultBootstrapArn(
  account: string,
  region: string,
  qualifier: string = DEFAULT_QUALIFIER
): string {
  return (
    `arn:\${AWS::Partition}:iam::${account}:role/` +
    `cdk-${qualifier}-cfn-exec-role-${account}-${region}`
  );
}

describe('CloudFormation 実行ロール ARN の導出（データアクセスポリシーの第 3 principal）', () => {
  describe('スタックから導出する（アカウント ID とリージョンをコードに持たない）', () => {
    it('入れ子スタックでも親の実行ロールを解決し、既定ブートストラップの命名になる', () => {
      const { deploymentRoleArn } = synthesize();
      expect(deploymentRoleArn).toBe(expectedDefaultBootstrapArn(TEST_ACCOUNT, TEST_REGION));
      expect(deploymentRoleArn).toContain('cfn-exec-role');
    });

    it('トップレベルスタックでも同じ ARN になる', () => {
      const { deploymentRoleArn } = synthesize({ nested: false });
      expect(deploymentRoleArn).toBe(expectedDefaultBootstrapArn(TEST_ACCOUNT, TEST_REGION));
    });

    it('アカウント ID とリージョンはスタックの env から取る（別の値でも追従する）', () => {
      const otherAccount = '210987654321';
      const otherRegion = 'ap-northeast-1';
      const { deploymentRoleArn } = synthesize({
        env: { account: otherAccount, region: otherRegion },
      });
      expect(deploymentRoleArn).toBe(expectedDefaultBootstrapArn(otherAccount, otherRegion));
      // 別環境の値がソースに焼き込まれていないことの裏取り
      expect(deploymentRoleArn).not.toContain(TEST_ACCOUNT);
      expect(deploymentRoleArn).not.toContain(TEST_REGION);
    });

    it('env 非依存スタックでは擬似パラメータ参照になる（具体値を捏造しない）', () => {
      const { deploymentRoleArn } = synthesize({ env: undefined });
      expect(deploymentRoleArn).toBe(
        expectedDefaultBootstrapArn('${AWS::AccountId}', '${AWS::Region}')
      );
    });

    it('導出に使う命名テンプレートは CDK の public な定数と一致している', () => {
      // 命名規則をこのリポジトリで再発明していないことの確認。
      // `${Qualifier}` のみ解決したうえで残りのプレースホルダの形を突き合わせる。
      expect(
        DefaultStackSynthesizer.DEFAULT_CLOUDFORMATION_ROLE_ARN.split('${Qualifier}').join(
          DEFAULT_QUALIFIER
        )
      ).toBe(expectedDefaultBootstrapArn('${AWS::AccountId}', '${AWS::Region}'));
      expect(DefaultStackSynthesizer.DEFAULT_QUALIFIER).toBe(DEFAULT_QUALIFIER);
    });

    it('ブートストラップ修飾子のコンテキストを尊重する', () => {
      const { deploymentRoleArn } = synthesize({
        context: { '@aws-cdk/core:bootstrapQualifier': 'abc12345' },
      });
      expect(deploymentRoleArn).toBe(
        expectedDefaultBootstrapArn(TEST_ACCOUNT, TEST_REGION, 'abc12345')
      );
      expect(deploymentRoleArn).not.toContain(DEFAULT_QUALIFIER);
    });
  });

  describe('明示指定で上書きできる（既定以外のブートストラップに対応する）', () => {
    const customArn = `arn:aws:iam::${TEST_ACCOUNT}:role/my-own-deploy-role`;

    it('prop deploymentRoleArn が導出に勝つ', () => {
      const { deploymentRoleArn, statements } = synthesize({ deploymentRoleArn: customArn });
      expect(deploymentRoleArn).toBe(customArn);
      expect(indexLifecycleStatement(statements).Principal).toEqual([customArn]);
    });

    it('環境変数 VECTOR_DEPLOY_ROLE_ARN が導出に勝つ', () => {
      const { deploymentRoleArn } = synthesize({ environment: customArn });
      expect(deploymentRoleArn).toBe(customArn);
    });

    it('prop は環境変数に勝つ', () => {
      const { deploymentRoleArn } = synthesize({
        deploymentRoleArn: customArn,
        environment: `arn:aws:iam::${TEST_ACCOUNT}:role/from-environment`,
      });
      expect(deploymentRoleArn).toBe(customArn);
    });

    it.each(['', '   '])('空文字列と空白のみは指定なしとして扱う（%j）', (value) => {
      const { deploymentRoleArn } = synthesize({ deploymentRoleArn: value });
      expect(deploymentRoleArn).toBe(expectedDefaultBootstrapArn(TEST_ACCOUNT, TEST_REGION));
    });

    it('前後の空白を取り除く', () => {
      const { deploymentRoleArn } = synthesize({ environment: `  ${customArn}\n` });
      expect(deploymentRoleArn).toBe(customArn);
    });
  });

  describe('ワイルドカードとプレースホルダ残りを合成時に拒否する（要件 17.7）', () => {
    it.each([
      'arn:aws:iam::123456789012:role/*',
      '*',
      'arn:aws:iam::*:role/cdk-hnb659fds-cfn-exec-role',
    ])('ワイルドカードを含む指定は例外になる（%j）', (value) => {
      expect(() => synthesize({ deploymentRoleArn: value })).toThrowError(
        /must not contain a wildcard/
      );
    });

    it('環境変数側のワイルドカードも同じく例外になる', () => {
      expect(() => synthesize({ environment: 'arn:aws:iam::123456789012:role/cdk-*' })).toThrowError(
        /must not contain a wildcard/
      );
    });

    it('未解決の CloudFormation プレースホルダを含む指定は例外になる', () => {
      // 導出結果の差し替え漏れを検出する経路。`${AWS::AccountId}` をリテラルとして
      // ポリシーへ載せると AOSS はその文字列をそのまま principal として扱う
      expect(() =>
        synthesize({
          deploymentRoleArn:
            'arn:aws:iam::${AWS::AccountId}:role/cdk-hnb659fds-cfn-exec-role-x-us-west-2',
        })
      ).toThrowError(/unresolved CloudFormation placeholder/);
    });
  });

  describe('ポリシー文書に第 3 のステートメントとして載る', () => {
    it('インデックスライフサイクル 4 件のみを持ち、ドキュメントの読み書きを含まない', () => {
      const { statements, deploymentRoleArn } = synthesize();
      expect(statements).toHaveLength(3);

      const statement = indexLifecycleStatement(statements);
      expect(statement.Principal).toEqual([deploymentRoleArn]);
      expect(statement.Rules).toHaveLength(1);
      expect(statement.Rules[0].ResourceType).toBe('index');
      expect(statement.Rules[0].Resource).toEqual([
        `index/${VECTOR_COLLECTION_NAME}/${VECTOR_INDEX_NAME}`,
      ]);
      expect(statement.Rules[0].Permission.slice().sort()).toEqual([
        'aoss:CreateIndex',
        'aoss:DeleteIndex',
        'aoss:DescribeIndex',
        'aoss:UpdateIndex',
      ]);
      for (const forbidden of ['aoss:ReadDocument', 'aoss:WriteDocument']) {
        expect(statement.Rules[0].Permission).not.toContain(forbidden);
      }
    });

    it('検索ロールと埋め込みロールの権限は実行ロールの追加で変わらない', () => {
      const { statements } = synthesize();
      const permissionsFor = (roleName: string): string[] => {
        const found = statements.filter((statement) =>
          statement.Principal.some((principal) => principal.endsWith(`/${roleName}`))
        );
        expect(found).toHaveLength(1);
        return found[0].Rules.flatMap((rule) => rule.Permission).sort();
      };
      expect(permissionsFor('search-lambda-role')).toEqual([
        'aoss:DescribeIndex',
        'aoss:ReadDocument',
      ]);
      expect(permissionsFor('embed-batch-role')).toEqual(['aoss:WriteDocument']);
    });

    it('Stage A（Collection 未作成）でも実行ロールの解決は行われる', () => {
      // 誤設定を段階に依らず合成時点で失敗させるため、フラグが false でも解決する
      const app = new App({ context: { [VECTOR_COLLECTION_ENABLED_CONTEXT_KEY]: false } });
      const stack = new Stack(app, 'VectorDeployRoleStageAStack', {
        env: { account: TEST_ACCOUNT, region: TEST_REGION },
      });
      const construct = new VectorCollectionConstruct(stack, 'VectorCollection', {
        dimensions: TEST_DIMENSIONS,
      });
      expect(construct.collectionEnabled).toBe(false);
      expect(construct.dataAccessPolicy).toBeUndefined();
      expect(resolveArn(stack, construct.deploymentRoleArn)).toBe(
        expectedDefaultBootstrapArn(TEST_ACCOUNT, TEST_REGION)
      );
    });
  });
});
