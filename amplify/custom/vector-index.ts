import { CustomResource, Duration } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as custom_resources from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import type { AttributeDefinition, ScalarAttributeType } from '@aws-sdk/client-dynamodb';

import { validateDimensions } from '../functions/shared/vector/constraints.js';
import { resolveEmbeddingDimensions } from '../functions/shared/vector/embedding-generator.js';
import {
  VECTOR_LANGUAGES,
  resolveIndexName,
  resolveVectorField,
  type VectorIndexName,
} from '../functions/shared/vector/language.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * ベクトルインデックスの距離関数（要件 5.1）。
 *
 * インデックス作成時に固定され、あとから変更できない（V4 / 前提 A5）。
 * OpenSearch 側の `cosinesimil` と同一のコサイン距離基準に揃えるため COSINE を選ぶ。
 */
export const VECTOR_INDEX_DISTANCE_FUNCTION = 'COSINE';

/**
 * `SearchSchema` の `INLINE_FILTER` 要素に使う属性（要件 5.3 / 5.4）。
 *
 * Vector_Table のソートキー。`HASH` 要素は定義しない。定義すると全検索の
 * `SearchConditionExpression` で当該条件が必須になり、既定の「全倉庫」検索が成立しない（V2）。
 *
 * この属性は `UpdateTable` の `AttributeDefinitions` にも宣言しなければならない。
 * テーブル側に定義済みであっても、リクエストに含めなければ
 * `One element in SearchSchema is not defined in attribute definitions` で弾かれる。
 * 属性型はテーブル定義から導出して `SearchSchemaAttributeDefinitions` プロパティで
 * ハンドラへ明示的に渡す（`resolveSearchSchemaAttributeDefinitions`）。
 */
export const VECTOR_INDEX_INLINE_FILTER_ATTRIBUTE = 'warehouseId';

/**
 * CDK の `AttributeType` から `AttributeDefinition.AttributeType`（SDK の `ScalarAttributeType`）
 * への対応表。
 *
 * 値そのものは両者で同一（`'S' | 'N' | 'B'`）だが、TypeScript の string enum は文字列
 * リテラル型へ暗黙に代入できない。対応表を明示しておけば、CDK 側に型が増えたときに
 * コンパイルエラーとして現れる。
 */
const SCALAR_ATTRIBUTE_TYPES: Readonly<Record<dynamodb.AttributeType, ScalarAttributeType>> = {
  [dynamodb.AttributeType.STRING]: 'S',
  [dynamodb.AttributeType.NUMBER]: 'N',
  [dynamodb.AttributeType.BINARY]: 'B',
};

/**
 * `SearchSchema` の各要素に対応する `AttributeDefinitions` を Vector_Table の定義から導出する。
 *
 * 属性型を CDK のテーブル定義（`dynamodb-tables.ts` の `sortKey`）から引くことで、
 * テーブル側のキー型を変えたときに型がずれない。導出できない属性（テーブルのキーでない属性）は
 * 合成時に失敗させる。デプロイまで遅れる `UpdateTable` の検証エラーへ落とさないためである。
 *
 * 却下した代替: ハンドラ内で `DescribeTable` を呼び、既存の `AttributeDefinitions` から
 * 該当要素を拾う方式（テーブル定義から絶対に乖離しない利点はあるが、API 呼び出しが増え、
 * 属性が本当に無い場合の失敗が分かりにくくなる）。
 */
function resolveSearchSchemaAttributeDefinitions(
  vectorTable: dynamodb.Table,
  searchSchemaAttributeNames: readonly string[]
): AttributeDefinition[] {
  const schema = vectorTable.schemaV2();
  const keyAttributes = [...schema.partitionKeys, ...schema.sortKeys];

  return searchSchemaAttributeNames.map((attributeName) => {
    const key = keyAttributes.find((attribute) => attribute.name === attributeName);
    if (!key) {
      throw new Error(
        `VectorIndexConstruct: SearchSchema attribute "${attributeName}" is not a key attribute of ` +
          `${vectorTable.node.path}, so its attribute type cannot be derived from the table ` +
          `definition. UpdateTable requires every SearchSchema attribute to be declared in the ` +
          `AttributeDefinitions of the same request. Table key attributes: ` +
          `${keyAttributes.map((attribute) => attribute.name).join(', ') || '(none)'}.`
      );
    }
    return {
      AttributeName: key.name,
      AttributeType: SCALAR_ATTRIBUTE_TYPES[key.type],
    } satisfies AttributeDefinition;
  });
}

/**
 * 射影する非キー属性（要件 5.6）。
 *
 * `ProjectionType: ALL` は使わない。`SearchVectors` の応答は 16 MB 上限で
 * ページネーション非対応のため（V4）、表示に必要な属性のみを列挙する。
 * 表示用メタデータを `metaJa` / `metaEn` の 2 つの Map 属性にまとめることで、
 * 日英 9 項目 × 2 = 18 属性ではなく 2 属性で済ませている。
 * 属性数の上限はベクトル属性（1）と各 `INLINE_FILTER`（1）と共有される（V4）。
 * ここでは 6 + 1 + 1 = 8 属性。
 */
export const VECTOR_INDEX_PROJECTED_ATTRIBUTES = [
  'itemName',
  'metaJa',
  'metaEn',
  'quantity',
  'location',
  'unitPrice',
] as const;

/** カスタムリソースのリソースタイプ名 */
const CUSTOM_RESOURCE_TYPE = 'Custom::DynamoDBVectorIndex';

/** `IndexStatus` が ACTIVE になるまでのポーリング間隔（要件 5.13） */
const INDEX_POLL_INTERVAL = Duration.seconds(60);

/** `IndexStatus` が ACTIVE になるまでの待機上限（要件 5.13。`Provider` の上限も 2 時間） */
const INDEX_TOTAL_TIMEOUT = Duration.hours(2);

/**
 * Vector Index Construct の入力
 */
export interface VectorIndexProps {
  /** ベクトルインデックスを作成する対象テーブル（Vector_Table）。Good_Table は対象にしない（要件 5.6 / 17.2） */
  vectorTable: dynamodb.Table;
  /**
   * ベクトルの次元数（要件 5.2）。
   *
   * 省略時は Requirement 3 の設定値解決（`VECTOR_EMBEDDING_DIMENSIONS` 環境変数 →
   * 既定値 1024）に従う。2 本のインデックスへ同一値を適用する。
   */
  dimensions?: number;
}

/**
 * DynamoDB Vector Index を作成する Construct（Index_Provisioner）。
 *
 * `AWS::DynamoDB::Table` に `VectorIndexes` プロパティは存在しないため（V1）、
 * L1 / L2 の Table Construct では表現できない。`custom_resources.Provider` と
 * `UpdateTable` の `VectorIndexUpdates` で作成する。
 *
 * 2 本のインデックス（`byEmbeddingJa` / `byEmbeddingEn`）を 2 つのカスタムリソースとして
 * 定義し、後続側に `node.addDependency()` を設定して**逐次化**する。1 回の `UpdateTable`
 * で追加できるのは 1 件のみであり（V1 / 要件 5.9）、テーブルが `UPDATING` の間に
 * 追加の `UpdateTable` が受理されるかも未確認であるため、並行化しない。
 *
 * IAM は `dynamodb:UpdateTable` / `dynamodb:DescribeTable` を Vector_Table の
 * テーブル ARN のみに限定する。Good_Table の ARN は含めない（要件 17.2）。
 * ベクトルインデックスの作成・削除に追加の権限は不要（V7）。
 *
 * 暗号化設定は Vector_Table から継承され、インデックス個別の設定は行わない（要件 5.7 / V7）。
 * 課金モードにも触れないため、Vector_Table はオンデマンドのまま変わらない（要件 5.5）。
 */
export class VectorIndexConstruct extends Construct {
  /** 2 本のインデックスへ適用した次元数（要件 5.2。2 本ともに同一） */
  public readonly dimensions: number;
  /** 距離関数。2 本ともに COSINE（要件 5.1） */
  public readonly distanceFunction: string = VECTOR_INDEX_DISTANCE_FUNCTION;
  /** 作成するインデックス名（`byEmbeddingJa` / `byEmbeddingEn`） */
  public readonly indexNames: readonly VectorIndexName[];
  /**
   * インデックス ARN。DynamoDB_Vector_Lambda の `dynamodb:SearchVectors` の
   * Resource に使う（要件 17.1）。GSI と同じ `table/<name>/index/<index>` 形式。
   */
  public readonly indexArns: Readonly<Record<VectorIndexName, string>>;
  /** onEvent ハンドラ（`UpdateTable` を呼ぶ） */
  public readonly onEventFunction: lambda.Function;
  /** isComplete ハンドラ（`DescribeTable` で `IndexStatus` を見る） */
  public readonly isCompleteFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: VectorIndexProps) {
    super(scope, id);

    const { vectorTable } = props;

    // ─── 次元数の検証（要件 5.2 / 6.11）──────────────────────────────
    // 検証を通らない値からリソース定義を組み立てられないよう、合成時に失敗させる。
    // 指定値と両バックエンドの許容範囲を含むメッセージは共有モジュールが持つ。
    const requestedDimensions = props.dimensions ?? resolveEmbeddingDimensions();
    const validation = validateDimensions(requestedDimensions, 'effective');
    if (!validation.ok) {
      throw new Error(`VectorIndexConstruct: ${validation.message}`);
    }
    this.dimensions = validation.dimensions;

    const handlersDir = join(__dirname, '..', 'functions', 'vector-index-provisioner');

    // `VectorIndexUpdates` は比較的新しい API パラメータのため、Lambda 同梱の SDK に
    // 依存させない。`externalModules: []` で `@aws-sdk/client-dynamodb` を同梱する。
    const bundling: nodejs.BundlingOptions = {
      minify: true,
      sourceMap: true,
      target: 'node20',
      externalModules: [],
    };

    // ─── onEvent ハンドラ ────────────────────────────────────────────
    // タイムアウトは、テーブルが UPDATING の間の ResourceInUseException を
    // ハンドラ内で待って再試行する余裕を含めて 5 分にしてある。
    this.onEventFunction = new nodejs.NodejsFunction(this, 'OnEventFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: join(handlersDir, 'on-event.ts'),
      handler: 'handler',
      timeout: Duration.minutes(5),
      memorySize: 256,
      bundling,
      description: 'Creates or deletes a DynamoDB vector index via UpdateTable VectorIndexUpdates',
    });

    // ─── isComplete ハンドラ ─────────────────────────────────────────
    this.isCompleteFunction = new nodejs.NodejsFunction(this, 'IsCompleteFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: join(handlersDir, 'is-complete.ts'),
      handler: 'handler',
      timeout: Duration.seconds(30),
      memorySize: 256,
      bundling,
      description: 'Checks whether a DynamoDB vector index has reached IndexStatus ACTIVE',
    });

    // ─── IAM: Vector_Table のテーブル ARN のみ（要件 17.2）──────────────
    // Good_Table の ARN は含めない。テーブル以外のサブリソース ARN も付与しない。
    this.onEventFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:UpdateTable', 'dynamodb:DescribeTable'],
        resources: [vectorTable.tableArn],
      })
    );

    // isComplete は状態確認のみ。UpdateTable は与えない
    this.isCompleteFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:DescribeTable'],
        resources: [vectorTable.tableArn],
      })
    );

    // ─── Provider: 60 秒間隔 / 上限 2 時間（要件 5.13）─────────────────
    // 完了条件は IndexStatus === 'ACTIVE' のみ。バックフィル完了は含めない
    // （Provider.totalTimeout の上限が 2 時間で要件 5.14 の 180 分を表現できず、
    //   CFN をバックフィルに待たせるのも望ましくないため）。
    const provider = new custom_resources.Provider(this, 'Provider', {
      onEventHandler: this.onEventFunction,
      isCompleteHandler: this.isCompleteFunction,
      queryInterval: INDEX_POLL_INTERVAL,
      totalTimeout: INDEX_TOTAL_TIMEOUT,
    });

    // ─── SearchSchema の属性定義（要件 5.3 / 5.4）───────────────────────
    // 2 本のインデックスで同一の `SearchSchema` を使うため、導出は 1 回で足りる
    const searchSchemaAttributeDefinitions = resolveSearchSchemaAttributeDefinitions(vectorTable, [
      VECTOR_INDEX_INLINE_FILTER_ATTRIBUTE,
    ]);

    // ─── 2 本のインデックスを逐次作成する ─────────────────────────────
    const indexNames: VectorIndexName[] = [];
    const indexArns: Partial<Record<VectorIndexName, string>> = {};
    let previous: CustomResource | undefined;

    for (const language of VECTOR_LANGUAGES) {
      const indexName = resolveIndexName(language);
      const vectorAttribute = resolveVectorField(language);
      const constructId = `VectorIndex${language.charAt(0).toUpperCase()}${language.slice(1)}`;

      const resource = new CustomResource(this, constructId, {
        serviceToken: provider.serviceToken,
        resourceType: CUSTOM_RESOURCE_TYPE,
        properties: {
          TableName: vectorTable.tableName,
          IndexName: indexName,
          VectorAttribute: vectorAttribute,
          // CloudFormation はカスタムリソースのプロパティを文字列で渡すため、
          // 数値であることを明示して渡す（ハンドラ側で整数として検証する）
          Dimensions: String(this.dimensions),
          DistanceFunction: VECTOR_INDEX_DISTANCE_FUNCTION,
          // `SearchVectors` / `UpdateTable` の `SearchSchema` と同一の平坦な配列で渡す。
          // 要素の種別フィールド名も API と同じ `SearchSchemaElementType` である。
          // HASH 要素は定義しない（V2 / 要件 5.3）。
          // Vector_Table の全 15,000 件が検索対象範囲になる
          SearchSchema: [
            {
              AttributeName: VECTOR_INDEX_INLINE_FILTER_ATTRIBUTE,
              SearchSchemaElementType: 'INLINE_FILTER',
            },
          ],
          // `SearchSchema` の各要素に対応する `AttributeDefinitions`。ハンドラはこれを
          // `UpdateTable` の `AttributeDefinitions` へそのまま渡す。属性型は
          // Vector_Table のキー定義から導出しているため、テーブル側と乖離しない
          SearchSchemaAttributeDefinitions: searchSchemaAttributeDefinitions,
          Projection: {
            ProjectionType: 'INCLUDE',
            NonKeyAttributes: [...VECTOR_INDEX_PROJECTED_ATTRIBUTES],
          },
        },
      });

      // テーブルが存在してからインデックスを作る
      resource.node.addDependency(vectorTable);

      // 1 回の UpdateTable で追加できるのは 1 件のみ（V1）。
      // 2 本目は 1 本目の完了後に開始させる
      if (previous) {
        resource.node.addDependency(previous);
      }
      previous = resource;

      indexNames.push(indexName);
      indexArns[indexName] = `${vectorTable.tableArn}/index/${indexName}`;
    }

    this.indexNames = indexNames;
    this.indexArns = indexArns as Record<VectorIndexName, string>;
  }
}
