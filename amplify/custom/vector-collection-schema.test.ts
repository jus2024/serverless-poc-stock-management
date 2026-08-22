import { describe, expect, it } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import {
  VECTOR_COLLECTION_ENABLED_CONTEXT_KEY,
  VECTOR_INDEX_NAME,
  VectorCollectionConstruct,
} from './vector-collection';

/**
 * `AWS::OpenSearchServerless::Index` のマッピングがリソーススキーマの enum に収まることを固定する。
 *
 * 経緯: Stage B の初回デプロイが CloudFormation のプロパティ検証で CREATE_FAILED になった。
 * 4 つの値がスキーマ外だった。
 *
 *   #/Mappings/Properties/unitPrice/Type:       failed validation constraint for keyword [enum]
 *   #/Mappings/Properties/quantity/Type:        failed validation constraint for keyword [enum]
 *   #/Mappings/Properties/embeddingEn/DataType: failed validation constraint for keyword [enum]
 *   #/Mappings/Properties/embeddingJa/DataType: failed validation constraint for keyword [enum]
 *
 * `unitPrice: double` / `quantity: long` / DataType `float32` は、いずれも TypeScript の型
 * （`CfnIndex.PropertyMappingProperty` の `type` は `string`）と CDK の合成のどちらも通る。
 * つまりローカルの検証では一切引っかからず、失敗はデプロイまで遅れた。本テストはその
 * 検出をデプロイ前へ引き戻す。
 *
 * 許容値はリテラルとしてこのファイルに書き写している（下記 `SCHEMA_*`）。出典は
 * `cloudformation:DescribeType AWS::OpenSearchServerless::Index` で取得した実リソーススキーマの
 * `PropertyMapping` 定義。テストの実行に AWS 認証情報もネットワークも必要としない
 * （合成は `Template.fromStack` によるインメモリのみ）。
 *
 * スキーマ側の enum が将来拡張された場合、このテストは「まだ許していない値を使った」ことを
 * 報告する。その時点で `DescribeType` を再取得してリテラルを更新する（出典を書き換える形で
 * 広げる）のが正しい対応であり、テストの側を緩めて通すのではない。
 *
 * ── このテストの守備範囲の限界 ────────────────────────────────────────────
 *
 * 検出できるのは「CloudFormation のスキーマ検証に弾かれる値」だけである。スキーマが許して
 * いるのに実サービスが拒否するものは、原理的にここでは捕まらない。実例として
 * `Method.Engine` はスキーマ上 enum `["nmslib","faiss","lucene"]` として宣言されており、
 * `faiss` はその一員でありながら、データプレーンは
 * `[illegal_argument_exception] Field parameter 'engine' is not supported` として拒否した。
 * この種の不整合はデプロイするまで分からない。
 */

// ─── リソーススキーマから写した許容値 ─────────────────────────────────────
//
// 出典: cloudformation:DescribeType AWS::OpenSearchServerless::Index
//       definitions.PropertyMapping（2026 年時点で取得したスキーマ）
//
// 注目すべき点として、`Type` に浮動小数の型が無い。数値として索引できるのは `integer` のみで、
// `double` / `long` / `float` は存在しない。`DataType` の側は `float`（32 bit）であり `float32` ではない。

/** PropertyMapping.Type の enum */
const SCHEMA_TYPES = ['text', 'knn_vector', 'keyword', 'integer'];
/** PropertyMapping.DataType の enum */
const SCHEMA_DATA_TYPES = ['float', 'byte'];
/** SpaceType の enum */
const SCHEMA_SPACE_TYPES = ['l2', 'l1', 'linf', 'cosinesimil', 'innerproduct', 'hamming'];
/** Method.Engine の enum */
const SCHEMA_METHOD_ENGINES = ['nmslib', 'faiss', 'lucene'];
/** Method.Name の enum */
const SCHEMA_METHOD_NAMES = ['hnsw', 'ivf'];
/** CompressionLevel の enum（本 Construct では未指定のままにする） */
const SCHEMA_COMPRESSION_LEVELS = ['16x', '32x', '8x', '4x', '2x', '1x'];
/** PropertyMapping が受け取るキー */
const SCHEMA_PROPERTY_MAPPING_KEYS = [
  'Analyzer',
  'CompressionLevel',
  'DataType',
  'Dimension',
  'Index',
  'Method',
  'Properties',
  'SpaceType',
  'Type',
  'Value',
];

/**
 * IndexSettings が受け取るキー。
 *
 * 出典: 同じ `DescribeType` の `definitions.IndexSettings`。
 * `Index` 側は `Knn`（boolean） / `KnnAlgoParamEfSearch`（integer） / `RefreshInterval`（string）の 3 つ。
 */
const SCHEMA_INDEX_SETTINGS_KEYS = ['Analysis', 'Index'];
/** IndexSettings.Index が受け取るキー */
const SCHEMA_INDEX_SETTINGS_INDEX_KEYS = ['Knn', 'KnnAlgoParamEfSearch', 'RefreshInterval'];

const TEST_DIMENSIONS = 1024;

// ─── 合成 ────────────────────────────────────────────────────────────────

interface IndexProperties {
  IndexName?: unknown;
  Settings?: Record<string, unknown>;
  Mappings?: { Properties?: Record<string, unknown> };
}

/** 合成した Index の、検査対象になる 2 つの部分 */
interface SynthesizedIndex {
  /** `Mappings.Properties` */
  mappingProperties: Record<string, unknown>;
  /** `Settings`（未指定なら undefined。`Knn` を落とした回帰をそのまま検出させる） */
  settings?: Record<string, unknown>;
}

/**
 * Stage B の Index を 1 つだけ合成し、その `Mappings.Properties` と `Settings` を返す。
 *
 * Lambda ロール ARN は渡さない（データアクセスポリシーの Principal はマッピングと無関係で、
 * 渡さなければ Lambda のバンドルが一切起きない）。ゲートはコンテキストで開ける。
 */
function synthesizeIndex(): SynthesizedIndex {
  const app = new App({ context: { [VECTOR_COLLECTION_ENABLED_CONTEXT_KEY]: true } });
  const stack = new Stack(app, 'VectorSchemaStack', {
    env: { account: '123456789012', region: 'us-west-2' },
  });
  new VectorCollectionConstruct(stack, 'VectorCollection', { dimensions: TEST_DIMENSIONS });

  const indexes = Template.fromStack(stack).findResources('AWS::OpenSearchServerless::Index');
  const logicalIds = Object.keys(indexes);
  expect(logicalIds).toHaveLength(1);

  const properties = (indexes[logicalIds[0]].Properties ?? {}) as IndexProperties;
  expect(properties.IndexName).toBe(VECTOR_INDEX_NAME);

  const mappingProperties = properties.Mappings?.Properties;
  expect(mappingProperties).toBeDefined();
  return {
    mappingProperties: mappingProperties as Record<string, unknown>,
    settings: properties.Settings,
  };
}

// ─── マッピングの平坦化 ───────────────────────────────────────────────────

/** 1 フィールドのマッピング。`path` は `#/Mappings/Properties/...` に対応する診断用の経路 */
interface FlatField {
  /** 例: `embeddingJa`、入れ子があれば `parent.child` */
  path: string;
  mapping: Record<string, unknown>;
}

/**
 * `Mappings.Properties` を再帰的に平坦化する。
 *
 * `PropertyMapping.Properties` による入れ子（object 型フィールド）も検査対象に含める。
 * 現状の `buildIndexProperties()` は入れ子を作らないが、後から追加されたときに
 * 検査を素通りしないようにしておく。
 */
function flattenFields(
  properties: Record<string, unknown>,
  prefix: string,
  sink: FlatField[]
): FlatField[] {
  for (const fieldName of Object.keys(properties)) {
    const mapping = properties[fieldName] as Record<string, unknown>;
    const path = prefix === '' ? fieldName : `${prefix}.${fieldName}`;
    sink.push({ path, mapping });

    const nested = mapping.Properties;
    if (nested !== undefined && nested !== null) {
      flattenFields(nested as Record<string, unknown>, path, sink);
    }
  }
  return sink;
}

/** 全フィールドから、指定キーが存在するものだけを `path -> 値` の一覧にする */
function collectValues(fields: FlatField[], key: string): { path: string; value: unknown }[] {
  const found: { path: string; value: unknown }[] = [];
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(field.mapping, key)) {
      found.push({ path: `${field.path}.${key}`, value: field.mapping[key] });
    }
  }
  return found;
}

/**
 * Method 直下のキーを集める（`Method.Engine` / `Method.Name` / `Method.SpaceType`）。
 *
 * `SpaceType` は PropertyMapping 直下にも Method 内にも書ける。どちらに現れても
 * 同じ enum で検査するため、両方を集めて突き合わせる。
 */
function collectMethodValues(fields: FlatField[], key: string): { path: string; value: unknown }[] {
  const found: { path: string; value: unknown }[] = [];
  for (const field of fields) {
    const method = field.mapping.Method as Record<string, unknown> | undefined;
    if (method !== undefined && Object.prototype.hasOwnProperty.call(method, key)) {
      found.push({ path: `${field.path}.Method.${key}`, value: method[key] });
    }
  }
  return found;
}

/** `path -> value` の一覧を許容集合と突き合わせる。違反があれば経路と値を出して落とす */
function expectAllIn(
  entries: { path: string; value: unknown }[],
  allowed: string[],
  label: string
): void {
  const violations = entries.filter((entry) => !allowed.includes(entry.value as string));
  expect(
    violations.map((entry) => `${entry.path} = ${JSON.stringify(entry.value)}`),
    `${label} はスキーマの enum [${allowed.join(', ')}] のいずれかでなければならない`
  ).toEqual([]);
}

// ─── テスト ──────────────────────────────────────────────────────────────

describe('AWS::OpenSearchServerless::Index のマッピングがリソーススキーマの enum に収まる', () => {
  const { mappingProperties, settings } = synthesizeIndex();
  const fields = flattenFields(mappingProperties, '', []);

  it('検査対象のフィールドが存在する（テストが空集合を検査して通っていない）', () => {
    // knn_vector 2 + フィルタ/表示用 keyword 4 + メタデータ 18 + 数値 2 = 26
    expect(fields).toHaveLength(26);
  });

  it('すべての Type が enum に収まる（unitPrice / quantity の double / long 回帰）', () => {
    const types = collectValues(fields, 'Type');
    // 全フィールドが Type を持つ
    expect(types).toHaveLength(fields.length);
    expectAllIn(types, SCHEMA_TYPES, 'PropertyMapping.Type');
  });

  it('すべての DataType が enum に収まる（embeddingJa / embeddingEn の float32 回帰）', () => {
    const dataTypes = collectValues(fields, 'DataType');
    // knn_vector 2 フィールドにのみ付く
    expect(dataTypes).toHaveLength(2);
    expectAllIn(dataTypes, SCHEMA_DATA_TYPES, 'PropertyMapping.DataType');
  });

  it('すべての SpaceType が enum に収まる（PropertyMapping 直下と Method 内の両方）', () => {
    const spaceTypes = collectValues(fields, 'SpaceType').concat(
      collectMethodValues(fields, 'SpaceType')
    );
    expect(spaceTypes.length).toBeGreaterThan(0);
    expectAllIn(spaceTypes, SCHEMA_SPACE_TYPES, 'SpaceType');
  });

  it('Method.Engine を指定していない（実サービスが engine パラメータ自体を拒否する）', () => {
    // 以前はここで `Engine` が 2 件あり `SCHEMA_METHOD_ENGINES` に収まることを固定していた。
    // その固定は「デプロイできない値」を固定していたため、誤りの側だった。Stage B のデプロイが
    // `engine: 'faiss'` で CREATE_FAILED になった:
    //
    //   Resource handler returned message: "Invalid request provided: Request failed:
    //   [illegal_argument_exception] OpenSearch exception [type=illegal_argument_exception,
    //   reason=Field parameter 'engine' is not supported]- server : [envoy]"
    //
    // 拒否されたのは値ではなくパラメータそのもの。NextGen の VECTORSEARCH コレクションでは
    // Faiss HNSW がコレクション種別側で固定されており、リクエストで選ぶ対象ではない。
    //
    // 重要な限界: `SCHEMA_METHOD_ENGINES` はリソーススキーマから正しく写した値であり、
    // スキーマ側は今も `Method.Engine` を許している。この不整合はスキーマ検査では検出できず、
    // データプレーンに到達してから拒否される。スキーマ固定テストの守備範囲の外側にある。
    const engines = collectMethodValues(fields, 'Engine');
    expect(engines).toEqual([]);
    // スキーマ側の enum は依然として存在する（写し取った出典を残しておく）。
    // 指定してしまった場合に enum 外の値まで混ざらないよう、突き合わせ自体は残す。
    expectAllIn(engines, SCHEMA_METHOD_ENGINES, 'Method.Engine');
  });

  it('すべての Method.Name が enum に収まる', () => {
    const names = collectMethodValues(fields, 'Name');
    expect(names).toHaveLength(2);
    expectAllIn(names, SCHEMA_METHOD_NAMES, 'Method.Name');
  });

  it('CompressionLevel は未指定である（指定する場合は enum に収まる）', () => {
    const compressionLevels = collectValues(fields, 'CompressionLevel');
    expect(compressionLevels).toEqual([]);
    // 将来指定した場合の許容値も同じ出典から固定しておく
    expectAllIn(compressionLevels, SCHEMA_COMPRESSION_LEVELS, 'CompressionLevel');
  });

  it('PropertyMapping にスキーマ外のキーを載せていない', () => {
    const unknownKeys: string[] = [];
    for (const field of fields) {
      for (const key of Object.keys(field.mapping)) {
        if (!SCHEMA_PROPERTY_MAPPING_KEYS.includes(key)) {
          unknownKeys.push(`${field.path}.${key}`);
        }
      }
    }
    expect(unknownKeys).toEqual([]);
  });

  it('数値フィールドは integer である（AOSS に double / long / float の Type が無いため）', () => {
    // 値の由来はスキーマ制約であって設計上の選択ではない。`vector-collection.ts` の
    // `buildIndexProperties()` 内のコメントに、小数価格を扱う場合の代替表現も含めて記録している。
    expect((mappingProperties.unitPrice as Record<string, unknown>).Type).toBe('integer');
    expect((mappingProperties.quantity as Record<string, unknown>).Type).toBe('integer');
  });

  it('knn_vector の指定が変わっていない（次元数 / 距離基準、Engine は未指定）', () => {
    for (const fieldName of ['embeddingJa', 'embeddingEn']) {
      const mapping = mappingProperties[fieldName] as Record<string, unknown>;
      expect(mapping.Type).toBe('knn_vector');
      expect(mapping.Dimension).toBe(TEST_DIMENSIONS);
      expect(mapping.DataType).toBe('float');

      const method = mapping.Method as Record<string, unknown>;
      expect(method.Name).toBe('hnsw');
      expect(method.SpaceType).toBe('cosinesimil');
      // Engine は送らない。実サービスが `engine` パラメータ自体を
      // `[illegal_argument_exception] Field parameter 'engine' is not supported` として拒否する。
      // NextGen の VECTORSEARCH コレクションでは Faiss HNSW が種別側で固定されている。
      expect(Object.prototype.hasOwnProperty.call(method, 'Engine')).toBe(false);
    }
  });
});

describe('AWS::OpenSearchServerless::Index の Settings が k-NN を有効にしている', () => {
  const { settings } = synthesizeIndex();

  /**
   * 経緯: `Settings` を一切渡していなかったため Stage B のデプロイが CREATE_FAILED になった。
   *
   *   Resource handler returned message: "Invalid request provided: Request failed:
   *   [illegal_argument_exception] OpenSearch exception [type=illegal_argument_exception,
   *   reason=Cannot set modelId or method parameters when index.knn setting is false]"
   *
   * `Settings` の省略は「既定で k-NN 有効」ではなく `index.knn = false` として扱われる。
   * `Mappings.Properties.embedding{Ja|En}.Method` を送る側と `Knn` を立てる側は同時に
   * 成立していなければならない。ここでその対応関係を固定する。
   *
   * 上の describe が `Method.Name = hnsw` を固定しているため、この 2 つのテストが揃っている
   * 限り「Method はあるが Knn が無い」組み合わせは合成時点で落ちる。
   */
  it('Settings.Index.Knn が true である（Method を受理させる前提条件）', () => {
    expect(settings).toBeDefined();
    const index = settings?.Index as Record<string, unknown> | undefined;
    expect(index).toBeDefined();
    expect(index?.Knn).toBe(true);
  });

  it('KnnAlgoParamEfSearch と RefreshInterval は未指定である', () => {
    // どの要件も要求していない。次に別のエラーが出た場合に原因を 1 つに絞れるよう、
    // Stage B の修正を `Knn` の追加だけに限定した意図をここで固定する。
    // 事実として、AWS ドキュメントの例では `KnnAlgoParamEfSearch: 512` が使われていた（必須ではない）。
    const index = settings?.Index as Record<string, unknown> | undefined;
    expect(Object.prototype.hasOwnProperty.call(index ?? {}, 'KnnAlgoParamEfSearch')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(index ?? {}, 'RefreshInterval')).toBe(false);
  });

  it('Settings にスキーマ外のキーを載せていない', () => {
    const unknownKeys: string[] = [];
    for (const key of Object.keys(settings ?? {})) {
      if (!SCHEMA_INDEX_SETTINGS_KEYS.includes(key)) {
        unknownKeys.push(`Settings.${key}`);
      }
    }
    const index = (settings?.Index ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(index)) {
      if (!SCHEMA_INDEX_SETTINGS_INDEX_KEYS.includes(key)) {
        unknownKeys.push(`Settings.Index.${key}`);
      }
    }
    expect(unknownKeys).toEqual([]);
  });
});
