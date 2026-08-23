import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import {
  VECTOR_COLLECTION_ENABLED_CONTEXT_KEY,
  VECTOR_COLLECTION_ENABLED_ENV_KEY,
  VECTOR_COLLECTION_GROUP_NAME,
  VECTOR_COLLECTION_NAME,
  VECTOR_INDEX_NAME,
  VectorCollectionConstruct,
} from './vector-collection';

/**
 * デプロイ段階ゲート（Stage A / Stage B）の解決経路のテスト。
 *
 * 経緯: このゲートは当初 CDK コンテキスト `vectorCollectionEnabled` だけで切り替える設計だったが、
 * `ampx sandbox`（1.8.2）には `--context` が無く、Amplify Gen 2 はリポジトリルートに `cdk.json` を
 * 持たず、`CDK_CONTEXT_JSON` も合成に届かない。実測では `CDK_CONTEXT_JSON` 付きの
 * `ampx sandbox` が CloudFormation の更新を 1 件も発生させず（フラグが既定の false に解決され、
 * Stage A と同一の合成結果になった）、Stage B へ到達する手段が存在しなかった。
 * そのため環境変数 `VECTOR_COLLECTION_ENABLED` を第 2 の経路として追加した。
 *
 * ここで固定するのは解決順序と受理・拒否する値の集合のみ。Stage B が作るリソースの内容は
 * `vector-iam-description.property.test.ts` と `existing-resources-snapshot.test.ts` が見る。
 *
 * 合成は in-memory のみ。AWS への呼び出しとデプロイは一切行わない。
 *
 * 環境変数はプロセス全体で共有されるため、各ケースの前後で保存・復元し、
 * どの順序で実行しても結果が変わらないようにする。
 */

const TEST_DIMENSIONS = 1024;

/** テスト開始前の値。`undefined` は「未設定」を表す */
let savedEnvValue: string | undefined;

beforeEach(() => {
  savedEnvValue = process.env[VECTOR_COLLECTION_ENABLED_ENV_KEY];
  delete process.env[VECTOR_COLLECTION_ENABLED_ENV_KEY];
});

afterEach(() => {
  if (savedEnvValue === undefined) {
    delete process.env[VECTOR_COLLECTION_ENABLED_ENV_KEY];
  } else {
    process.env[VECTOR_COLLECTION_ENABLED_ENV_KEY] = savedEnvValue;
  }
});

interface SynthOptions {
  /** CDK コンテキストへ与える値。省略時はコンテキストを設定しない */
  context?: unknown;
  /** 環境変数へ与える値。省略時は未設定のまま（`beforeEach` で削除済み） */
  environment?: string;
}

interface SynthResult {
  template: Template;
  collectionEnabled: boolean;
}

/**
 * Vector Collection Construct のみを合成する。
 *
 * 検索 Lambda のロール ARN は渡さない。データアクセスポリシーの Principal はゲートの
 * 解決結果と無関係であり、渡さないことで Lambda のバンドルを一切起こさずに合成できる。
 */
function synthesize(options: SynthOptions = {}): SynthResult {
  if (options.environment !== undefined) {
    process.env[VECTOR_COLLECTION_ENABLED_ENV_KEY] = options.environment;
  }

  const app = new App({
    context:
      options.context === undefined
        ? {}
        : { [VECTOR_COLLECTION_ENABLED_CONTEXT_KEY]: options.context },
  });
  const stack = new Stack(app, 'VectorFlagStack', {
    env: { account: '123456789012', region: 'us-west-2' },
  });
  const construct = new VectorCollectionConstruct(stack, 'VectorCollection', {
    dimensions: TEST_DIMENSIONS,
  });

  return { template: Template.fromStack(stack), collectionEnabled: construct.collectionEnabled };
}

/** Stage B: Collection `kiro-inventory-vector` と Index `inventory-vector` が存在する */
function expectStageB(result: SynthResult): void {
  expect(result.collectionEnabled).toBe(true);
  result.template.resourceCountIs('AWS::OpenSearchServerless::Collection', 1);
  result.template.hasResourceProperties('AWS::OpenSearchServerless::Collection', {
    Name: VECTOR_COLLECTION_NAME,
    Type: 'VECTORSEARCH',
    CollectionGroupName: VECTOR_COLLECTION_GROUP_NAME,
  });
  result.template.resourceCountIs('AWS::OpenSearchServerless::Index', 1);
  result.template.hasResourceProperties('AWS::OpenSearchServerless::Index', {
    IndexName: VECTOR_INDEX_NAME,
  });
  // 暗号化 / ネットワーク / データアクセスの 3 ポリシーも Stage B でのみ作られる
  result.template.resourceCountIs('AWS::OpenSearchServerless::SecurityPolicy', 2);
  result.template.resourceCountIs('AWS::OpenSearchServerless::AccessPolicy', 1);
}

/** Stage A: Collection Group のみが存在し、課金対象になり得るリソースを作らない */
function expectStageA(result: SynthResult): void {
  expect(result.collectionEnabled).toBe(false);
  result.template.resourceCountIs('AWS::OpenSearchServerless::CollectionGroup', 1);
  result.template.hasResourceProperties('AWS::OpenSearchServerless::CollectionGroup', {
    Name: VECTOR_COLLECTION_GROUP_NAME,
  });
  result.template.resourceCountIs('AWS::OpenSearchServerless::Collection', 0);
  result.template.resourceCountIs('AWS::OpenSearchServerless::Index', 0);
  result.template.resourceCountIs('AWS::OpenSearchServerless::SecurityPolicy', 0);
  result.template.resourceCountIs('AWS::OpenSearchServerless::AccessPolicy', 0);
}

describe('デプロイ段階ゲートの解決（コンテキスト → 環境変数 → 既定 false）', () => {
  describe('環境変数だけで Stage B に到達できる', () => {
    it('VECTOR_COLLECTION_ENABLED=true で Collection と Index が作られる', () => {
      expectStageB(synthesize({ environment: 'true' }));
    });

    it('VECTOR_COLLECTION_ENABLED=false は Stage A である', () => {
      expectStageA(synthesize({ environment: 'false' }));
    });

    it.each(['TRUE', 'True', ' true ', '\ttrue\n'])(
      '前後の空白と大小文字を無視して true と解釈する（%j）',
      (value) => {
        expectStageB(synthesize({ environment: value }));
      }
    );

    it.each(['FALSE', 'False', ' false '])(
      '前後の空白と大小文字を無視して false と解釈する（%j）',
      (value) => {
        expectStageA(synthesize({ environment: value }));
      }
    );
  });

  describe('未設定時は既定の false を保つ（tasks.md 13.2 の Stage A 手順）', () => {
    it('コンテキストも環境変数も無い場合は Stage A である', () => {
      expect(process.env[VECTOR_COLLECTION_ENABLED_ENV_KEY]).toBeUndefined();
      expectStageA(synthesize());
    });

    it('環境変数が空文字列の場合は未設定と同じく Stage A である', () => {
      expectStageA(synthesize({ environment: '' }));
    });

    it('コンテキストが空文字列で環境変数が未設定なら Stage A である', () => {
      expectStageA(synthesize({ context: '' }));
    });
  });

  describe('コンテキストが環境変数より優先される', () => {
    it('コンテキスト true は環境変数 false に勝つ', () => {
      expectStageB(synthesize({ context: true, environment: 'false' }));
    });

    it('コンテキスト false は環境変数 true に勝つ', () => {
      expectStageA(synthesize({ context: false, environment: 'true' }));
    });

    it('文字列のコンテキスト "false" も環境変数 true に勝つ', () => {
      expectStageA(synthesize({ context: 'false', environment: 'true' }));
    });

    it('コンテキストが空文字列なら環境変数へ委ねる', () => {
      expectStageB(synthesize({ context: '', environment: 'true' }));
    });
  });

  describe('綴り違いは黙って false に落ちず合成を止める', () => {
    // 「フラグを付けたつもりが false のまま」よりも「値の綴りを間違えたら止まる」を選ぶ。
    // 判断はコンテキストと環境変数で同一であり、環境変数側にも例外なく適用する。
    it.each(['1', '0', 'yes', 'no', 'on', 'off', 'enabled', 'ture', 'true false', ' ', 'null'])(
      '環境変数 %j は例外になる',
      (value) => {
        expect(() => synthesize({ environment: value })).toThrowError(
          new RegExp(
            `Environment variable "${VECTOR_COLLECTION_ENABLED_ENV_KEY}" must be true or false`
          )
        );
      }
    );

    it('例外メッセージに受け取った値が含まれる', () => {
      expect(() => synthesize({ environment: 'yes' })).toThrowError(/Received: "yes"/);
    });

    it.each([1, 0, 'yes', 'ture', {}])(
      'コンテキスト %j も従来どおり例外になる（環境変数の追加で緩んでいない）',
      (value) => {
        expect(() => synthesize({ context: value })).toThrowError(
          new RegExp(
            `Context value "${VECTOR_COLLECTION_ENABLED_CONTEXT_KEY}" must be true or false`
          )
        );
      }
    );

    it('コンテキストが不正なら、環境変数が有効な値でも例外になる', () => {
      // 誤設定の検出をフォールバックで覆い隠さない
      expect(() => synthesize({ context: 'yes', environment: 'true' })).toThrowError(
        new RegExp(`Context value "${VECTOR_COLLECTION_ENABLED_CONTEXT_KEY}"`)
      );
    });
  });

  describe('解決結果がプロセスに残らない', () => {
    it('同一プロセス内で環境変数を付け外しすると段階が追従する', () => {
      // Stage B のデプロイ後にフラグ無しで合成すると Stage A に戻る（削除が起きる経路）ことを
      // 1 つのテスト内で示す。テストの実行順に依存しないことの確認も兼ねる。
      expectStageB(synthesize({ environment: 'true' }));

      delete process.env[VECTOR_COLLECTION_ENABLED_ENV_KEY];
      expectStageA(synthesize());

      expectStageB(synthesize({ environment: 'true' }));
    });
  });
});
