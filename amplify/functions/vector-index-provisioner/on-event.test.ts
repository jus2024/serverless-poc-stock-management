/**
 * `vector-index-provisioner/on-event.ts` の単体テスト
 *
 * 主眼は `UpdateTable` へ渡す入力の形を固定することである。
 *
 * 経緯: Stage B のデプロイで `vector-index-provisioner` のカスタムリソースが
 * CREATE_FAILED になった。
 *
 *   One or more parameter values were invalid:
 *   One element in SearchSchema is not defined in attribute definitions
 *
 * Create パスが `TableName` と `VectorIndexUpdates` だけを送り、`AttributeDefinitions` を
 * 送っていなかった。`UpdateTable` は GSI 追加と同じ規則で「**リクエストに含めた**
 * `AttributeDefinitions`」を検証対象にするため、`warehouseId` がテーブル側に定義済みでも弾かれる。
 * TypeScript の型（`AttributeDefinitions` は optional）でも CDK の合成でも引っかからず、
 * 失敗はデプロイまで遅れた。本テストはその検出をデプロイ前へ引き戻す。
 *
 * 実 AWS は呼ばない。`DynamoDBClient` だけを差し替え、コマンドクラスは本物を使う
 * （`input` の組み立て規則まで含めて実装を検証したいため）。
 *
 * 要件: 5.3, 5.4, 5.9, 5.12
 */

import { UpdateTableCommand } from '@aws-sdk/client-dynamodb';
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

const { buildPhysicalResourceId, handler, parseResourceProperties } = await import('./on-event');

// ─── 固定のリソースプロパティ ─────────────────────────────────────────────
//
// `amplify/custom/vector-index.ts` が渡す形と同一。`Dimensions` は CloudFormation が
// 文字列で渡すため文字列にしてある。

const TABLE_NAME = 'kiro-roasters-inventory-vector';

const RESOURCE_PROPERTIES = {
  TableName: TABLE_NAME,
  IndexName: 'byEmbeddingJa',
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

/** `SearchSchemaAttributeDefinitions` だけを差し替えたプロパティを作る */
function withAttributeDefinitions(value: unknown): Record<string, unknown> {
  return { ...RESOURCE_PROPERTIES, SearchSchemaAttributeDefinitions: value };
}

/** 送られたコマンドを記録する。成功応答を返す */
function recordSentCommands(): unknown[] {
  const sent: unknown[] = [];
  hooks.send = (command: unknown): Promise<unknown> => {
    sent.push(command);
    return Promise.resolve({});
  };
  return sent;
}

beforeEach(() => {
  hooks.send = (_command: unknown): Promise<unknown> =>
    Promise.reject(new Error('the fake DynamoDB client is not installed'));
});

describe('handleCreate の UpdateTable 入力', () => {
  it('AttributeDefinitions を含む完全な入力を送る', async () => {
    const sent = recordSentCommands();

    await handler({ RequestType: 'Create', ResourceProperties: RESOURCE_PROPERTIES });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(UpdateTableCommand);
    expect((sent[0] as UpdateTableCommand).input).toEqual({
      TableName: TABLE_NAME,
      AttributeDefinitions: [{ AttributeName: 'warehouseId', AttributeType: 'S' }],
      VectorIndexUpdates: [
        {
          Create: {
            IndexName: 'byEmbeddingJa',
            VectorAttribute: { AttributeName: 'embeddingJa' },
            Dimensions: 1024,
            DistanceFunction: 'COSINE',
            SearchSchema: [{ AttributeName: 'warehouseId', SearchSchemaElementType: 'INLINE_FILTER' }],
            Projection: {
              ProjectionType: 'INCLUDE',
              NonKeyAttributes: ['itemName', 'metaJa', 'metaEn', 'quantity', 'location', 'unitPrice'],
            },
          },
        },
      ],
    });
  });

  it('AttributeDefinitions の属性名集合が SearchSchema の属性名集合と一致する', async () => {
    const sent = recordSentCommands();

    await handler({ RequestType: 'Create', ResourceProperties: RESOURCE_PROPERTIES });

    const input = (sent[0] as UpdateTableCommand).input;
    const declared = (input.AttributeDefinitions ?? []).map((definition) => definition.AttributeName);
    const referenced = (input.VectorIndexUpdates?.[0]?.Create?.SearchSchema ?? []).map(
      (element) => element.AttributeName
    );

    expect([...declared].sort()).toEqual([...referenced].sort());
  });

  it('ベクトル属性とテーブルの PK を AttributeDefinitions に載せない', async () => {
    const sent = recordSentCommands();

    await handler({ RequestType: 'Create', ResourceProperties: RESOURCE_PROPERTIES });

    const declared = ((sent[0] as UpdateTableCommand).input.AttributeDefinitions ?? []).map(
      (definition) => definition.AttributeName
    );

    expect(declared).not.toContain('embeddingJa');
    expect(declared).not.toContain('itemId');
  });
});

describe('handleDelete の UpdateTable 入力', () => {
  it('AttributeDefinitions を送らない', async () => {
    const sent = recordSentCommands();

    await handler({
      RequestType: 'Delete',
      ResourceProperties: RESOURCE_PROPERTIES,
      PhysicalResourceId: 'byEmbeddingJa-d1024-COSINE',
    });

    expect(sent).toHaveLength(1);
    expect((sent[0] as UpdateTableCommand).input).toEqual({
      TableName: TABLE_NAME,
      VectorIndexUpdates: [{ Delete: { IndexName: 'byEmbeddingJa' } }],
    });
  });
});

describe('SearchSchemaAttributeDefinitions の検証', () => {
  it('正常なプロパティを SDK の AttributeDefinition へ正規化する', () => {
    const props = parseResourceProperties(RESOURCE_PROPERTIES);

    expect(props.searchSchemaAttributeDefinitions).toEqual([
      { AttributeName: 'warehouseId', AttributeType: 'S' },
    ]);
  });

  it('プロパティが欠落していれば失敗する', () => {
    const { SearchSchemaAttributeDefinitions: _omitted, ...withoutDefinitions } = RESOURCE_PROPERTIES;

    expect(() => parseResourceProperties(withoutDefinitions)).toThrow(
      /"SearchSchemaAttributeDefinitions" must be a non-empty array/
    );
  });

  it('空配列であれば失敗する', () => {
    expect(() => parseResourceProperties(withAttributeDefinitions([]))).toThrow(
      /"SearchSchemaAttributeDefinitions" must be a non-empty array/
    );
  });

  it('要素がオブジェクトでなければ失敗する', () => {
    expect(() => parseResourceProperties(withAttributeDefinitions(['warehouseId']))).toThrow(
      /"SearchSchemaAttributeDefinitions\[0\]" must be an object/
    );
  });

  it('AttributeName が文字列でなければ失敗する', () => {
    expect(() =>
      parseResourceProperties(withAttributeDefinitions([{ AttributeName: 7, AttributeType: 'S' }]))
    ).toThrow(/"AttributeName" must be a non-empty string/);
  });

  it('AttributeType が S / N / B のいずれでもなければ失敗する', () => {
    expect(() =>
      parseResourceProperties(
        withAttributeDefinitions([{ AttributeName: 'warehouseId', AttributeType: 'STRING' }])
      )
    ).toThrow(/"SearchSchemaAttributeDefinitions\[0\]\.AttributeType" must be one of S, N, B/);
  });

  it('SearchSchema の属性が宣言されていなければ失敗する', () => {
    expect(() =>
      parseResourceProperties(
        withAttributeDefinitions([{ AttributeName: 'itemId', AttributeType: 'S' }])
      )
    ).toThrow(/Missing: warehouseId\. Unexpected: itemId\./);
  });

  it('SearchSchema に無い属性を宣言していれば失敗する', () => {
    expect(() =>
      parseResourceProperties(
        withAttributeDefinitions([
          { AttributeName: 'warehouseId', AttributeType: 'S' },
          { AttributeName: 'itemId', AttributeType: 'S' },
        ])
      )
    ).toThrow(/Missing: \(none\)\. Unexpected: itemId\./);
  });

  it('同一属性を重複して宣言していれば失敗する', () => {
    expect(() =>
      parseResourceProperties(
        withAttributeDefinitions([
          { AttributeName: 'warehouseId', AttributeType: 'S' },
          { AttributeName: 'warehouseId', AttributeType: 'S' },
        ])
      )
    ).toThrow(/declares the same attribute more than once: warehouseId/);
  });
});

describe('物理リソース ID と変更検出', () => {
  it('物理リソース ID は 4 項目のうち可変な 2 項目のみで、属性型を含めない', () => {
    // `DescribeTable` の `VectorIndexDescription` は属性型を返さない。ID に含めると
    // 照合できない項目でリソース置換が起きうる
    const props = parseResourceProperties(RESOURCE_PROPERTIES);

    expect(buildPhysicalResourceId(props)).toBe('byEmbeddingJa-d1024-COSINE');
    // 属性型 S を混ぜた形（例: `-S`）にはならない
    expect(buildPhysicalResourceId(props)).not.toMatch(/-[SNB]$/);
  });

  it('属性型だけが異なる Update を差分なしとして扱う', async () => {
    const sent = recordSentCommands();

    // 型が変わっても `UpdateTable` の再作成は要らない。破壊的変更として失敗させない
    const response = await handler({
      RequestType: 'Update',
      ResourceProperties: RESOURCE_PROPERTIES,
      OldResourceProperties: withAttributeDefinitions([
        { AttributeName: 'warehouseId', AttributeType: 'N' },
      ]),
      PhysicalResourceId: 'byEmbeddingJa-d1024-COSINE',
    });

    expect(response.PhysicalResourceId).toBe('byEmbeddingJa-d1024-COSINE');
    expect(sent).toHaveLength(0);
  });
});
