/**
 * `vector-index-provisioner/is-complete.ts` の単体テスト
 *
 * 主眼は `aws-cdk-lib/custom-resources` の `Provider` が使う framework ハンドラとの
 * 契約を固定することである。
 *
 * 経緯: Stage B のデプロイで、ベクトルインデックスの作成自体は始まったのに
 * カスタムリソースが CREATE_FAILED になった。
 *
 *   Received response status [FAILED] from custom resource.
 *   Message returned: Error: "Data" is not allowed if "IsComplete" is "False"
 *
 * isComplete ハンドラが `IsComplete` の値にかかわらず常に `Data` を返していた。
 * framework ハンドラは未完了の応答に非空の `Data` があると例外にする。ローカルの型は
 * `Data` を optional にしただけで、この契約を表現していなかったため検出が
 * デプロイまで遅れた。本テストはその検出をデプロイ前へ引き戻す。
 *
 * 実 AWS は呼ばない。`on-event.test.ts` と同じ方針で `DynamoDBClient` だけを差し替え、
 * コマンドクラスは本物を使う。
 *
 * 要件: 5.11, 5.13, 5.14
 */

import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 差し替え先を保持する可変フック。`vi.mock()` のファクトリは巻き上げられるため、
 * テスト本体で作る代替実装を直接参照できない。
 */
const hooks = vi.hoisted(() => ({
  send: (_command: unknown): Promise<unknown> =>
    Promise.reject(new Error('the fake DynamoDB client is not installed')),
}));

vi.mock('@aws-sdk/client-dynamodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-dynamodb')>();
  return {
    ...actual,
    DynamoDBClient: class {
      send(command: unknown): Promise<unknown> {
        return hooks.send(command);
      }
    },
  };
});

const { handler } = await import('./is-complete');
type IsCompleteResponse = Awaited<ReturnType<typeof handler>>;

// ─── 固定のリソースプロパティ ─────────────────────────────────────────────
//
// `amplify/custom/vector-index.ts` が渡す形と同一。`Dimensions` は CloudFormation が
// 文字列で渡すため文字列にしてある。

const TABLE_NAME = 'kiro-roasters-inventory-vector';
const INDEX_NAME = 'byEmbeddingJa';

const RESOURCE_PROPERTIES = {
  TableName: TABLE_NAME,
  IndexName: INDEX_NAME,
  VectorAttribute: 'embeddingJa',
  Dimensions: '1024',
  DistanceFunction: 'COSINE',
  SearchSchema: [{ AttributeName: 'warehouseId', SearchSchemaElementType: 'INLINE_FILTER' }],
  SearchSchemaAttributeDefinitions: [{ AttributeName: 'warehouseId', AttributeType: 'S' }],
  Projection: {
    ProjectionType: 'INCLUDE',
    NonKeyAttributes: ['itemName', 'metaJa', 'metaEn', 'quantity', 'location', 'unitPrice'],
  },
} as const;

/** `DescribeTable` に指定のベクトルインデックス一覧を返させる */
function respondWithVectorIndexes(indexes: readonly Record<string, unknown>[]): void {
  hooks.send = (command: unknown): Promise<unknown> => {
    if (!(command instanceof DescribeTableCommand)) {
      return Promise.reject(new Error(`unexpected command: ${String(command)}`));
    }
    return Promise.resolve({ Table: { TableName: TABLE_NAME, VectorIndexes: indexes } });
  };
}

/** `DescribeTable` をテーブル不在で失敗させる */
function respondWithMissingTable(): void {
  hooks.send = (): Promise<unknown> => {
    const error = new Error(`Requested resource not found: Table: ${TABLE_NAME} not found`);
    error.name = 'ResourceNotFoundException';
    return Promise.reject(error);
  };
}

function activeIndex(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    IndexName: INDEX_NAME,
    IndexStatus: 'ACTIVE',
    VectorAttribute: { AttributeName: 'embeddingJa' },
    Dimensions: 1024,
    DistanceFunction: 'COSINE',
    ...extra,
  };
}

function creatingIndex(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...activeIndex(), IndexStatus: 'CREATING', ...extra };
}

function invoke(
  requestType: 'Create' | 'Update' | 'Delete'
): Promise<IsCompleteResponse> {
  return handler({
    RequestType: requestType,
    ResourceProperties: RESOURCE_PROPERTIES,
    ...(requestType === 'Create' ? {} : { PhysicalResourceId: 'byEmbeddingJa-d1024-COSINE' }),
  });
}

beforeEach(() => {
  hooks.send = (_command: unknown): Promise<unknown> =>
    Promise.reject(new Error('the fake DynamoDB client is not installed'));
});

describe('Create / Update の待機', () => {
  it('IndexStatus が CREATING なら未完了で、Data を含めない', async () => {
    respondWithVectorIndexes([creatingIndex()]);

    const response = await invoke('Create');

    expect(response.IsComplete).toBe(false);
    // framework ハンドラは `IsComplete: false` の応答に `Data` があると例外にする。
    // 値が空オブジェクトであることではなく、**キー自体が無い**ことを固定する
    expect('Data' in response).toBe(false);
  });

  it('待機中の観測値を構造化ログへ出す', async () => {
    respondWithVectorIndexes([creatingIndex({ Backfilling: true })]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await invoke('Create');

      expect(log).toHaveBeenCalledTimes(1);
      const logged: unknown = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(logged).toMatchObject({
        TableName: TABLE_NAME,
        IndexName: INDEX_NAME,
        IndexStatus: 'CREATING',
        Backfilling: true,
      });
    } finally {
      log.mockRestore();
    }
  });

  it('IndexStatus が ACTIVE でバックフィル中なら完了とし、Backfilling を Data に載せる', async () => {
    // バックフィル完了は完了条件に含めない（要件 5.13 / 5.14）
    respondWithVectorIndexes([activeIndex({ Backfilling: true })]);

    const response = await invoke('Create');

    expect(response.IsComplete).toBe(true);
    expect(response).toHaveProperty('Data');
    if (response.IsComplete) {
      expect(response.Data.Backfilling).toBe(true);
      expect(response.Data.IndexStatus).toBe('ACTIVE');
    }
  });

  it('IndexStatus が ACTIVE で Backfilling が無ければ完了とする', async () => {
    respondWithVectorIndexes([activeIndex()]);

    const response = await invoke('Create');

    expect(response.IsComplete).toBe(true);
    if (response.IsComplete) {
      expect(response.Data.Backfilling).toBe(false);
      expect(response.Data.IndexStatus).toBe('ACTIVE');
    }
  });

  it('インデックスが一覧に無ければ未完了で、Data を含めない', async () => {
    respondWithVectorIndexes([]);

    const response = await invoke('Create');

    expect(response.IsComplete).toBe(false);
    expect('Data' in response).toBe(false);
  });

  it('待機中にテーブルが無ければ例外にする', async () => {
    respondWithMissingTable();

    await expect(invoke('Create')).rejects.toThrow(
      /Table .* was not found while waiting for vector index/
    );
  });
});

describe('Delete の待機', () => {
  it('対象が残っていれば未完了で、Data を含めない', async () => {
    respondWithVectorIndexes([{ ...activeIndex(), IndexStatus: 'DELETING' }]);

    const response = await invoke('Delete');

    expect(response.IsComplete).toBe(false);
    expect('Data' in response).toBe(false);
  });

  it('インデックスが消えていれば完了とする', async () => {
    respondWithVectorIndexes([]);

    const response = await invoke('Delete');

    expect(response.IsComplete).toBe(true);
    if (response.IsComplete) {
      expect(response.Data).toEqual({
        TableName: TABLE_NAME,
        IndexName: INDEX_NAME,
        IndexStatus: 'DELETED',
      });
    }
  });

  it('テーブルごと消えていれば完了とする（要件 5.11）', async () => {
    respondWithMissingTable();

    const response = await invoke('Delete');

    expect(response.IsComplete).toBe(true);
    if (response.IsComplete) {
      expect(response.Data.IndexStatus).toBe('DELETED');
    }
  });
});

describe('framework ハンドラとの契約（不変条件）', () => {
  /**
   * 「`IsComplete` が false のどの応答も `Data` を持たない」を全ケース横断で確認する。
   *
   * 個別のケースが増えても、未完了の枝に `Data` を足した瞬間にここで落ちる。
   * デプロイ時の `"Data" is not allowed if "IsComplete" is "False"` を前倒しで捕まえる
   * ための検査であり、値の中身は問わない。
   */
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly requestType: 'Create' | 'Update' | 'Delete';
    readonly arrange: () => void;
  }> = [
    { name: 'Create / CREATING', requestType: 'Create', arrange: () => respondWithVectorIndexes([creatingIndex()]) },
    {
      name: 'Create / CREATING かつバックフィル中',
      requestType: 'Create',
      arrange: () => respondWithVectorIndexes([creatingIndex({ Backfilling: true })]),
    },
    { name: 'Create / インデックス不在', requestType: 'Create', arrange: () => respondWithVectorIndexes([]) },
    { name: 'Create / ACTIVE', requestType: 'Create', arrange: () => respondWithVectorIndexes([activeIndex()]) },
    {
      name: 'Update / CREATING',
      requestType: 'Update',
      arrange: () => respondWithVectorIndexes([creatingIndex()]),
    },
    {
      name: 'Delete / DELETING',
      requestType: 'Delete',
      arrange: () => respondWithVectorIndexes([{ ...activeIndex(), IndexStatus: 'DELETING' }]),
    },
    { name: 'Delete / インデックス不在', requestType: 'Delete', arrange: () => respondWithVectorIndexes([]) },
    { name: 'Delete / テーブル不在', requestType: 'Delete', arrange: () => respondWithMissingTable() },
  ];

  it.each(cases)('$name の応答は IsComplete が false なら Data を持たない', async ({ requestType, arrange }) => {
    arrange();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const response = await invoke(requestType);

      if (!response.IsComplete) {
        expect('Data' in response).toBe(false);
      } else {
        // 完了時は `Data` を必ず載せる（CFN の `Fn::GetAtt` から参照する）
        expect('Data' in response).toBe(true);
      }
    } finally {
      log.mockRestore();
    }
  });
});
