import { Construct } from 'constructs';
import { BOOTSTRAP_QUALIFIER_CONTEXT, DefaultStackSynthesizer, Stack } from 'aws-cdk-lib';
import * as opensearchserverless from 'aws-cdk-lib/aws-opensearchserverless';

import {
  VECTOR_LANGUAGES,
  resolveVectorField,
  type VectorFieldName,
} from '../functions/shared/vector/language';
import {
  validateDimensions,
  type VectorDimensionsValidationSuccess,
} from '../functions/shared/vector/constraints';
import type { SkuMetadataFields } from '../functions/shared/vector/sku-metadata';

/**
 * OpenSearch Serverless VECTORSEARCH コレクション Construct の入力インターフェース。
 *
 * 既存の `opensearch-infra.ts`（`kiro-inventory-search` / `kiro-inventory-group`）とは
 * 完全に独立したリソース群を定義する。既存 Construct には追記も変更も行わない（要件 6.3 / 17.8）。
 */
export interface VectorCollectionProps {
  /**
   * `knn_vector` フィールド 2 つに適用する次元数（既定 1024）。
   * 両バックエンドへ同一ベクトルを格納するため、実効許容範囲は 1〜4,096（要件 6.4 / 6.11）。
   */
  dimensions?: number;
  /**
   * OpenSearch_Vector_Lambda の実行ロール ARN。
   * データアクセスポリシーで読み取り権限（ReadDocument / DescribeIndex）のみを与える（要件 17.4）。
   */
  searchLambdaRoleArn?: string;
  /**
   * Embedding_Batch_Job の実行ロール ARN。
   * データアクセスポリシーで書き込み権限（WriteDocument）のみを与える（要件 6.8 / 17.12）。
   */
  embeddingJobRoleArn?: string;
  /**
   * `AWS::OpenSearchServerless::Index` の `CreateIndex` を実行する CloudFormation 実行ロールの ARN。
   *
   * 省略時は `resolveDeploymentRoleArn()` がスタックのシンセサイザから導出する。既定の CDK
   * ブートストラップ以外（修飾子や実行ロール名を変えた環境）では、この prop または
   * 環境変数 `VECTOR_DEPLOY_ROLE_ARN` で明示指定する。コード側にアカウント ID や
   * リージョンを書き込む必要は無い（要件 17.7）。
   */
  deploymentRoleArn?: string;
}

/** リソース名。既存の `kiro-inventory-search` 系と重複しない（要件 6.6 / 17.8） */
export const VECTOR_COLLECTION_NAME = 'kiro-inventory-vector';
export const VECTOR_COLLECTION_GROUP_NAME = 'kiro-inventory-vector-group';
export const VECTOR_INDEX_NAME = 'inventory-vector';

/** ベクトル次元数の既定値（要件 3 / 6.4） */
export const DEFAULT_VECTOR_DIMENSIONS = 1024;

/**
 * デプロイ段階ゲートの CDK コンテキストフラグ名（要件 7.5）。
 *
 * 既定（false）では Collection Group のみを作る。Deployment_Validator が
 * min OCU 0 の受理を確認したあとに true にして再デプロイし、Collection / Index を作る。
 *
 * この経路に値を渡せるのは CDK App を直接組む場合（`new App({ context: { ... } })`）であり、
 * 実質的にはテストが使う。`ampx sandbox` からコンテキストを注入する手段は無いため、
 * 実デプロイでは `VECTOR_COLLECTION_ENABLED_ENV_KEY` の環境変数を使う。
 */
export const VECTOR_COLLECTION_ENABLED_CONTEXT_KEY = 'vectorCollectionEnabled';

/**
 * 同じデプロイ段階ゲートを与える環境変数名（要件 7.5）。
 *
 * `ampx sandbox` の実行時にゲートを切り替えられる唯一の経路である。観測した事実:
 *
 * - `npx ampx sandbox --help`（ampx 1.8.2）に `--context` は存在しない。指定できるのは
 *   `--debug` / `--dir-to-watch` / `--exclude` / `--identifier` / `--outputs-*` /
 *   `--profile` / `--once` とログストリーム系のみ。
 * - Amplify Gen 2 は合成を自前で駆動するため、リポジトリルートに `cdk.json` が無い。
 *   （`load-generator/cdk/cdk.json` は本機能と無関係の別プロジェクトのもの）
 * - `CDK_CONTEXT_JSON='{"vectorCollectionEnabled":true}' npx ampx sandbox` を実行しても
 *   合成にはコンテキストが届かず、CloudFormation の更新が 1 件も発生しなかった
 *   （フラグが既定の false に解決され、合成結果が Stage A と同一になる）。
 *
 * したがってコンテキストだけでは Stage B に到達できない。この環境変数はそのために追加した。
 */
export const VECTOR_COLLECTION_ENABLED_ENV_KEY = 'VECTOR_COLLECTION_ENABLED';

/**
 * CloudFormation 実行ロール ARN を明示指定する環境変数名（要件 17.7）。
 *
 * 既定の CDK ブートストラップ（`cdk-hnb659fds-cfn-exec-role-<account>-<region>`）以外を
 * 使う環境では、コードを編集せずにこの環境変数でロール ARN を差し替える。
 * `VectorCollectionProps.deploymentRoleArn` を渡した場合はそちらが優先される。
 */
export const VECTOR_DEPLOY_ROLE_ARN_ENV_KEY = 'VECTOR_DEPLOY_ROLE_ARN';

/**
 * CloudFormation 実行ロールへ与えるインデックスライフサイクル権限（要件 17.7）。
 *
 * `AWS::OpenSearchServerless::Index` は AOSS の `CreateIndex` API を**スタックの実行ロール**
 * として呼ぶ。AOSS は IAM に加えてデータアクセスポリシー側の許可も要求するため、この 4 件が
 * 無いとインデックスを作成できない。実際に Stage B のデプロイが次の理由で CREATE_FAILED に
 * なった（論理 ID `VectorCollectionVectorIndexCAF364BA`）:
 *
 *   Resource handler returned message: "Access denied for operation 'CreateIndex'."
 *   (HandlerErrorCode: AccessDenied)
 *
 * 実行ロールはインデックスを**管理**するだけであり、ドキュメントの読み書きは行わない。
 * したがって `aoss:ReadDocument` と `aoss:WriteDocument` は与えない。
 */
const INDEX_LIFECYCLE_PERMISSIONS = [
  'aoss:CreateIndex',
  'aoss:DescribeIndex',
  'aoss:UpdateIndex',
  'aoss:DeleteIndex',
] as const;

/**
 * `DEFAULT_CLOUDFORMATION_ROLE_ARN` に含まれる未解決プレースホルダ。
 *
 * CDK トークン（`${Token[AWS.Partition.6]}`）とは別物であり、そのまま JSON ポリシーへ
 * 埋め込むと AOSS へリテラル文字列として渡ってしまう。差し替え漏れを検出するために使う。
 */
const ROLE_ARN_PLACEHOLDER_PATTERN = /\$\{(?:AWS::[A-Za-z]+|Qualifier)\}/;

/** 空文字列と空白のみを「指定なし」として扱う */
function trimToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * 最も近い `DefaultStackSynthesizer` を探す。
 *
 * `backend.createStack()` が作るのは `NestedStack` であり、その `synthesizer` は
 * `NestedStackSynthesizer`（実行ロールを持たない）である。CloudFormation の `RoleARN` は
 * 親スタックから継承されるため、`nestedStackParent` を辿って親側のシンセサイザを見る。
 */
function findDefaultSynthesizer(stack: Stack): DefaultStackSynthesizer | undefined {
  let current: Stack | undefined = stack;
  while (current !== undefined) {
    const synthesizer = current.synthesizer;
    if (synthesizer instanceof DefaultStackSynthesizer) {
      return synthesizer;
    }
    current = current.nestedStackParent;
  }
  return undefined;
}

/**
 * CFN 擬似パラメータのプレースホルダをスタックの値へ差し替える。
 *
 * `stack.partition` / `stack.account` / `stack.region` は env 明示なら具体値、
 * env 非依存なら CDK トークン（合成時に `Ref: AWS::AccountId` などへ展開される）になる。
 * どちらでも `JSON.stringify` 後の文字列としてそのまま扱える。
 */
function substituteRoleArnPlaceholders(template: string, stack: Stack, qualifier: string): string {
  return template
    .split('${AWS::Partition}')
    .join(stack.partition)
    .split('${AWS::AccountId}')
    .join(stack.account)
    .split('${AWS::Region}')
    .join(stack.region)
    .split('${Qualifier}')
    .join(qualifier);
}

/** Principal に使える具体 ARN であることを確かめる（要件 17.7: ワイルドカード禁止） */
function assertConcreteRoleArn(roleArn: string, origin: string): string {
  if (roleArn.includes('*')) {
    throw new Error(
      `[${VECTOR_COLLECTION_NAME}] Data access policy principal must not contain a wildcard ` +
        `(${origin}): ${roleArn}`
    );
  }
  const placeholder = ROLE_ARN_PLACEHOLDER_PATTERN.exec(roleArn);
  if (placeholder !== null) {
    throw new Error(
      `[${VECTOR_COLLECTION_NAME}] Data access policy principal still contains the unresolved ` +
        `CloudFormation placeholder ${placeholder[0]} (${origin}): ${roleArn}`
    );
  }
  return roleArn;
}

/**
 * `CfnIndex` の `CreateIndex` を実行する CloudFormation 実行ロールの ARN を解決する（要件 17.7）。
 *
 * 解決順序:
 * 1. `VectorCollectionProps.deploymentRoleArn`
 * 2. 環境変数 `VECTOR_DEPLOY_ROLE_ARN`
 * 3. スタックのシンセサイザから導出
 *
 * 3 では `DefaultStackSynthesizer` の public getter `cloudFormationExecutionRoleArn` を使う。
 * この getter はブートストラップ修飾子（`@aws-cdk/core:bootstrapQualifier`）の解決を済ませた
 * ARN テンプレートを返すため、命名規則も修飾子の解決規則もこちらで再実装しない。ただし返り値には
 * `${AWS::Partition}` / `${AWS::AccountId}` / `${AWS::Region}` が残るので、スタックの値へ
 * 差し替える。アカウント ID とリージョンをコードへ書き込まないのはこのためである。
 *
 * `DefaultStackSynthesizer` が見つからない場合（独自シンセサイザ）は public static の
 * `DEFAULT_CLOUDFORMATION_ROLE_ARN` テンプレートへ落とし、修飾子はコンテキストから解決する。
 */
export function resolveDeploymentRoleArn(scope: Construct, explicit?: string): string {
  const override =
    trimToUndefined(explicit) ?? trimToUndefined(process.env[VECTOR_DEPLOY_ROLE_ARN_ENV_KEY]);
  if (override !== undefined) {
    return assertConcreteRoleArn(
      override,
      explicit === undefined
        ? `environment variable "${VECTOR_DEPLOY_ROLE_ARN_ENV_KEY}"`
        : 'deploymentRoleArn prop'
    );
  }

  const stack = Stack.of(scope);
  const synthesizer = findDefaultSynthesizer(stack);
  const template =
    synthesizer?.cloudFormationExecutionRoleArn ??
    DefaultStackSynthesizer.DEFAULT_CLOUDFORMATION_ROLE_ARN;
  const qualifier =
    synthesizer?.bootstrapQualifier ??
    (scope.node.tryGetContext(BOOTSTRAP_QUALIFIER_CONTEXT) as string | undefined) ??
    DefaultStackSynthesizer.DEFAULT_QUALIFIER;

  return assertConcreteRoleArn(
    substituteRoleArnPlaceholders(template, stack, qualifier),
    'derived from the stack synthesizer'
  );
}

/**
 * Collection Group の容量設定（要件 7.1）。
 *
 * NextGen の max OCU 許容値は 0 / 2 / 4 / 8 / 16 および 16 の倍数（V8）。
 * 最悪ケース月額は 2 OCU x 0.24 USD x 730 h = 350 USD。
 */
const CAPACITY_LIMITS: opensearchserverless.CfnCollectionGroup.CapacityLimitsProperty = {
  minIndexingCapacityInOcu: 0,
  minSearchCapacityInOcu: 0,
  maxIndexingCapacityInOcu: 2,
  maxSearchCapacityInOcu: 2,
};

/**
 * `knn_vector` の Method 設定（要件 6.5）。
 *
 * `SpaceType` は `cosinesimil`。`cosine` は AOSS では無効な値である（V10）。
 * DynamoDB 側の `DistanceFunction: COSINE` と同一のコサイン距離基準になる。
 * `CompressionLevel` は指定しない。
 *
 * ── `engine` を指定しない理由 ──────────────────────────────────────────────
 *
 * `engine: 'faiss'` を指定していたため Stage B のデプロイが CREATE_FAILED になった
 * （論理 ID `VectorCollectionVectorIndexCAF364BA`）:
 *
 *   Resource handler returned message: "Invalid request provided: Request failed:
 *   [illegal_argument_exception] OpenSearch exception [type=illegal_argument_exception,
 *   reason=Field parameter 'engine' is not supported]- server : [envoy]"
 *   (HandlerErrorCode: InvalidRequest)
 *
 * 拒否されたのは値ではなくパラメータそのものである（"is not supported"）。NextGen の
 * `VECTORSEARCH` コレクションでは `knn_vector` が Faiss HNSW を使うようコレクション種別側で
 * 固定されており、リクエストで選ぶ対象ではない。出典: AWS Migration Assistant ドキュメント
 * "Amazon OpenSearch Serverless NextGen considerations" — knn_vector フィールドは
 * NextGen ベクトル検索コレクションが対応する Faiss HNSW メソッドを使うよう構成される、との記述。
 * つまり `faiss` は失われておらず、指定できないだけである。
 *
 * ── スキーマからは検出できない ────────────────────────────────────────────
 *
 * `cloudformation:DescribeType AWS::OpenSearchServerless::Index` のリソーススキーマは
 * `Method.Engine` を enum `["nmslib", "faiss", "lucene"]` として**宣言している**。
 * CloudFormation のスキーマ検証（`Mappings` の enum 違反を弾く層）はこのプロパティを通し、
 * 拒否するのはデータプレーンへ到達したあとの OpenSearch 本体である。したがって
 * `vector-collection-schema.test.ts` のスキーマ固定テストはこの類の不整合を検出できない
 * ——「スキーマ上は妥当だが実サービスが拒否する」ものは、デプロイするまで分からない。
 *
 * ── 次に失敗した場合の後退案 ──────────────────────────────────────────────
 *
 * 今回は誤りが 1 つに特定されている（エラーが名指ししたのは `engine` のみ）ため、変更も
 * `engine` の除去 1 点に絞る。次のデプロイの結果がそのまま診断になる。
 * 次に `name` または `parameters` が "not supported" と報告された場合は、`Method` を
 * 丸ごと外し、`SpaceType` をフィールド直下（`PropertyMapping.SpaceType`）へ移す。
 * CFN リファレンスの `PropertyMapping.SpaceType` は "The distance function used for k-NN
 * search" を Method の外側のフィールドレベル項目として定めており、距離関数だけは
 * `Method` 無しでも指定できる。
 */
const KNN_METHOD: opensearchserverless.CfnIndex.MethodProperty = {
  name: 'hnsw',
  spaceType: 'cosinesimil',
  parameters: {
    m: 16,
    efConstruction: 128,
  },
};

/**
 * `knn_vector` フィールドの DataType（要件 6.5）。
 *
 * `CfnIndex.PropertyMappingProperty` に `dataType` が未反映のため、
 * L1 escape hatch（`addPropertyOverride`）で設定する。
 *
 * 値は `AWS::OpenSearchServerless::Index` のリソーススキーマに従う。`PropertyMapping.DataType`
 * の enum は `["float", "byte"]` のみで、`float32` は含まれない（出典:
 * `cloudformation:DescribeType AWS::OpenSearchServerless::Index`）。当初 `float32` を
 * 指定していたため Stage B のデプロイが CREATE_FAILED になった:
 * `#/Mappings/Properties/embeddingJa/DataType: failed validation constraint for keyword [enum]`。
 * 許容値は `vector-collection-schema.test.ts` が合成テンプレートに対して固定している。
 */
const KNN_DATA_TYPE = 'float';

/**
 * インデックス設定（要件 6.5）。
 *
 * `Knn: true` は `Mappings.Properties.embedding{Ja|En}.Method` を使うための前提条件である。
 * `index.knn` が false の状態で `Method`（や `modelId`）を渡すと、OpenSearch 本体が
 * リクエストを拒否する。`Settings` を一切渡していなかったため Stage B のデプロイが
 * CREATE_FAILED になった（論理 ID `VectorCollectionVectorIndexCAF364BA`）:
 *
 *   Resource handler returned message: "Invalid request provided: Request failed:
 *   [illegal_argument_exception] OpenSearch exception [type=illegal_argument_exception,
 *   reason=Cannot set modelId or method parameters when index.knn setting is false]"
 *   (HandlerErrorCode: InvalidRequest)
 *
 * つまり `Settings` の省略は「既定で k-NN 有効」ではなく `index.knn = false` として扱われる。
 * `Method` を送る側と `Knn` を立てる側は同時に成立していなければならない。
 *
 * ── 意図的に指定しない項目 ────────────────────────────────────────────────
 *
 * `Settings.Index` には他に `KnnAlgoParamEfSearch`（近傍探索の動的リストサイズ）と
 * `RefreshInterval` があるが、どちらも設定しない。どの要件も要求しておらず、次に別のエラーが
 * 出た場合に原因を 1 つに絞れるよう変更を `Knn` の追加だけに限定する。
 * 事実として、AWS ドキュメントの `AWS::OpenSearchServerless::Index` の例では
 * `KnnAlgoParamEfSearch: 512` が使われていた（必須ではない）。
 */
const INDEX_SETTINGS: opensearchserverless.CfnIndex.IndexSettingsProperty = {
  index: {
    knn: true,
  },
};

/**
 * Sku_Metadata の 9 項目に対応するインデックスフィールド名の語幹。
 *
 * `keyof SkuMetadataFields` を鍵にしているため、メタデータ側の項目が増減すると
 * この対応表がコンパイルエラーになる。日英 2 組（9 x 2 = 18 フィールド）は
 * この 1 つの対応表から導出する（要件 6.7）。
 */
const METADATA_FIELD_STEMS: Record<keyof SkuMetadataFields, string> = {
  productName: 'productName',
  category: 'category',
  origin: 'origin',
  roastLevel: 'roastLevel',
  flavorNotes: 'flavorNotes',
  body: 'body',
  acidity: 'acidity',
  description: 'description',
  // ドキュメント側の属性名は brewingRecommendation ではなく brewing{Ja|En} を使う
  brewingRecommendation: 'brewing',
};

/** 言語コードからフィールド名の接尾辞（`Ja` / `En`）を作る */
function languageSuffix(language: (typeof VECTOR_LANGUAGES)[number]): 'Ja' | 'En' {
  return language === 'ja' ? 'Ja' : 'En';
}

/**
 * ドキュメント ID を組み立てる。
 *
 * `_id` は `${itemId}#${warehouseId}`。`SearchVectors` 側の (itemId, warehouseId) と
 * 1:1 に対応させ、要件 12.1 の行レベル同一性判定を単純にする。
 * インデックスのマッピングはこの前提に立ち、`itemId` と `warehouseId` を
 * それぞれ独立した keyword フィールドとして保持する（複合キー用の属性は作らない）。
 */
export function buildVectorDocumentId(itemId: string, warehouseId: string): string {
  return `${itemId}#${warehouseId}`;
}

/** description に使える文字（タブ・改行・復帰と ASCII 印字可能文字のみ、要件 6.12 / 17.14） */
const ASCII_DESCRIPTION_PATTERN = /^[\t\n\r\x20-\x7E]*$/;

/**
 * description が ASCII 印字可能文字のみであることを合成時に強制する。
 * 日本語文字と矢印記号（`→`）が混入した時点で合成を失敗させる。
 */
function asciiDescription(description: string): string {
  if (!ASCII_DESCRIPTION_PATTERN.test(description)) {
    throw new Error(
      `Vector collection resource description must contain only tab, newline, carriage return, ` +
        `and ASCII printable characters (0x20-0x7E). Received: ${JSON.stringify(description)}`
    );
  }
  return description;
}

/**
 * OpenSearch Serverless VECTORSEARCH コレクション一式を定義する Construct。
 *
 * - Collection Group `kiro-inventory-vector-group`: Generation NEXTGEN、standbyReplicas ENABLED、
 *   min OCU 0 / max OCU 2（要件 6.2 / 7.1）
 * - Encryption Policy `kiro-inventory-vector-enc`: AWS 所有キー（要件 6.6）
 * - Network Policy `kiro-inventory-vector-net`: パブリックアクセス（検証用途、要件 6.6）
 * - Collection `kiro-inventory-vector`: type VECTORSEARCH、上記グループ所属（要件 6.1 / 6.2）
 * - Data Access Policy `kiro-inventory-vector-data`: Principal は検索 Lambda ロール（読み取りのみ）、
 *   埋め込みバッチロール（書き込みのみ）、CloudFormation 実行ロール（インデックスライフサイクルのみ）の
 *   3 件。ワイルドカードと OSIS の pipelineRole を含まない（要件 17.7）
 * - Index `inventory-vector`: `CfnIndex` で日英 2 本の `knn_vector` を定義（要件 6.4 / 6.5 / 6.7）
 *
 * 依存関係は Encryption / Network Policy -> Collection -> Data Access Policy -> Index の順に
 * `addDependency` で明示する（要件 6.6）。
 *
 * デプロイ段階ゲート（既定 false）で Collection 以降の作成を切り替える。false では課金対象に
 * なり得る Collection / Index を作らず、Collection Group のみを作る。解決順序は
 * 1. CDK コンテキスト `vectorCollectionEnabled`、2. 環境変数 `VECTOR_COLLECTION_ENABLED`、
 * 3. 既定 false（`resolveCollectionEnabled()`）。
 *
 * ── 運用上の注意: Stage B を適用したあとの再合成 ──────────────────────────
 * このフラグは「作るか作らないか」を毎回の合成で決める。Stage B のデプロイ後に
 * `VECTOR_COLLECTION_ENABLED=true` を与えずに `ampx sandbox` を実行すると、合成結果は
 * Stage A に戻り、Collection `kiro-inventory-vector` / Index `inventory-vector` /
 * 検索系 Lambda が **削除される**。`ampx sandbox` のウォッチモードでは任意のファイル変更が
 * 再合成の契機になるため、フラグを付け忘れた状態でファイルを 1 つ保存しただけでも削除が起きる。
 * Stage B の作業中はシェルセッション全体に `export VECTOR_COLLECTION_ENABLED=true` を
 * 効かせた状態を保つ（インデックスの再作成と再埋め込みが必要になるため、復旧は安くない）。
 */
export class VectorCollectionConstruct extends Construct {
  /** Collection Group（フラグに関わらず常に作る） */
  public readonly collectionGroup: opensearchserverless.CfnCollectionGroup;
  /** Collection Group の ARN */
  public readonly collectionGroupArn: string;
  /** Collection Group 名 */
  public readonly collectionGroupName: string = VECTOR_COLLECTION_GROUP_NAME;
  /** Collection 名（Collection 未作成でも名前は確定している） */
  public readonly collectionName: string = VECTOR_COLLECTION_NAME;
  /** インデックス名 */
  public readonly indexName: string = VECTOR_INDEX_NAME;
  /** `vectorCollectionEnabled` の解決結果。false のとき Collection / Index は存在しない */
  public readonly collectionEnabled: boolean;
  /** 検証済みの次元数（2 つの `knn_vector` フィールドで同一） */
  public readonly dimensions: number;
  /**
   * データアクセスポリシーでインデックスライフサイクル権限を与える CloudFormation 実行ロールの ARN。
   * `collectionEnabled` が false の段階でも解決済みである（解決の誤りを段階に依らず検出するため）。
   */
  public readonly deploymentRoleArn: string;
  /** Collection。`collectionEnabled` が false のとき undefined */
  public readonly collection?: opensearchserverless.CfnCollection;
  /** Collection のエンドポイント URL。`collectionEnabled` が false のとき undefined */
  public readonly collectionEndpoint?: string;
  /** Collection の ARN。`collectionEnabled` が false のとき undefined */
  public readonly collectionArn?: string;
  /** Data Access Policy。`collectionEnabled` が false のとき undefined */
  public readonly dataAccessPolicy?: opensearchserverless.CfnAccessPolicy;
  /** Index。`collectionEnabled` が false のとき undefined */
  public readonly index?: opensearchserverless.CfnIndex;

  constructor(scope: Construct, id: string, props: VectorCollectionProps = {}) {
    super(scope, id);

    // ─── 次元数の検証: 範囲外なら合成前に失敗させる（要件 6.11）──────────
    // 実効範囲は DynamoDB 4,096 と OpenSearch 16,000 の小さい方（1〜4,096）。
    // 失敗時の message には指定値と両バックエンドの許容範囲が含まれる。
    const dimensionsInput = props.dimensions ?? DEFAULT_VECTOR_DIMENSIONS;
    const validated = validateDimensions(dimensionsInput, 'effective');
    if (!validated.ok) {
      throw new Error(`[${VECTOR_COLLECTION_NAME}] ${validated.message}`);
    }
    this.dimensions = validated.dimensions;

    // ─── CloudFormation 実行ロールの解決（要件 17.7）──────────────────────
    // `CfnIndex` の `CreateIndex` はこのロールとして実行される。段階に依らず解決しておき、
    // 誤設定（ワイルドカード、プレースホルダ残り）を Stage A の合成時点でも失敗させる。
    this.deploymentRoleArn = resolveDeploymentRoleArn(this, props.deploymentRoleArn);

    // ─── Collection Group: scale-to-zero 設定（要件 6.2 / 7.1）────────────
    // Collection を作らない段階（vectorCollectionEnabled=false）でも作成する。
    // Collection 未所属の Collection Group が課金対象かは Stage A の 1 時間観測で確認する。
    this.collectionGroup = new opensearchserverless.CfnCollectionGroup(this, 'VectorCollectionGroup', {
      name: VECTOR_COLLECTION_GROUP_NAME,
      standbyReplicas: 'ENABLED',
      capacityLimits: CAPACITY_LIMITS,
      description: asciiDescription(
        'Collection Group for the vector search comparison (NextGen, VECTORSEARCH only)'
      ),
    });
    // CDK の型定義に generation が未反映のため、L1 escape hatch で設定
    this.collectionGroup.addPropertyOverride('Generation', 'NEXTGEN');
    this.collectionGroupArn = this.collectionGroup.attrArn;

    this.collectionEnabled = resolveCollectionEnabled(this);
    if (!this.collectionEnabled) {
      // Stage A: Collection / Index / 検索 Lambda を作らない（要件 7.5）
      return;
    }

    // ─── Encryption Policy: AWS 所有キー（要件 6.6）───────────────────────
    const encryptionPolicy = new opensearchserverless.CfnSecurityPolicy(this, 'VectorEncryptionPolicy', {
      name: `${VECTOR_COLLECTION_NAME}-enc`,
      type: 'encryption',
      policy: JSON.stringify({
        Rules: [
          {
            ResourceType: 'collection',
            Resource: [`collection/${VECTOR_COLLECTION_NAME}`],
          },
        ],
        AWSOwnedKey: true,
      }),
      description: asciiDescription(
        'Encryption policy for kiro-inventory-vector collection (AWS owned key)'
      ),
    });

    // ─── Network Policy: パブリックアクセス（検証用途、要件 6.6）───────────
    const networkPolicy = new opensearchserverless.CfnSecurityPolicy(this, 'VectorNetworkPolicy', {
      name: `${VECTOR_COLLECTION_NAME}-net`,
      type: 'network',
      policy: JSON.stringify([
        {
          Rules: [
            {
              ResourceType: 'collection',
              Resource: [`collection/${VECTOR_COLLECTION_NAME}`],
            },
            {
              ResourceType: 'dashboard',
              Resource: [`collection/${VECTOR_COLLECTION_NAME}`],
            },
          ],
          AllowFromPublic: true,
        },
      ]),
      description: asciiDescription(
        'Network policy for kiro-inventory-vector collection (public access for verification)'
      ),
    });

    // ─── Collection: VECTORSEARCH タイプ（要件 6.1 / 6.2）─────────────────
    const collection = new opensearchserverless.CfnCollection(this, 'VectorCollection', {
      name: VECTOR_COLLECTION_NAME,
      type: 'VECTORSEARCH',
      collectionGroupName: VECTOR_COLLECTION_GROUP_NAME,
      description: asciiDescription(
        'Vector search comparison OpenSearch Serverless Collection (VECTORSEARCH)'
      ),
    });
    // 依存関係: Encryption / Network Policy -> Collection（要件 6.6）
    collection.addDependency(this.collectionGroup);
    collection.addDependency(encryptionPolicy);
    collection.addDependency(networkPolicy);

    this.collection = collection;
    this.collectionEndpoint = collection.attrCollectionEndpoint;
    this.collectionArn = collection.attrArn;

    // ─── Data Access Policy: 読み取り / 書き込み / インデックス管理を principal ごとに分ける ──
    // Principal は 3 件のロール ARN のみ。ワイルドカードと OSIS の pipelineRole を含まない（要件 17.7）
    const dataAccessPolicy = new opensearchserverless.CfnAccessPolicy(this, 'VectorDataAccessPolicy', {
      name: `${VECTOR_COLLECTION_NAME}-data`,
      type: 'data',
      policy: JSON.stringify(
        buildDataAccessStatements({
          searchLambdaRoleArn: props.searchLambdaRoleArn,
          embeddingJobRoleArn: props.embeddingJobRoleArn,
          deploymentRoleArn: this.deploymentRoleArn,
        })
      ),
      description: asciiDescription(
        'Data access policy for the vector search Lambda (read only), the embedding batch job ' +
          '(write only), and the CloudFormation execution role (index lifecycle only)'
      ),
    });
    // 依存関係: Collection -> Data Access Policy（要件 6.6）
    dataAccessPolicy.addDependency(collection);
    this.dataAccessPolicy = dataAccessPolicy;

    // ─── Index `inventory-vector`（要件 6.4 / 6.5 / 6.7）──────────────────
    const index = new opensearchserverless.CfnIndex(this, 'VectorIndex', {
      collectionEndpoint: collection.attrCollectionEndpoint,
      indexName: VECTOR_INDEX_NAME,
      // `Method` を受理させるための前提条件（INDEX_SETTINGS のコメントを参照）
      settings: INDEX_SETTINGS,
      mappings: {
        properties: buildIndexProperties(validated),
      },
    });
    // 依存関係: Data Access Policy -> Index（要件 6.6）
    index.addDependency(collection);
    index.addDependency(dataAccessPolicy);

    // `knn_vector` の DataType は L1 に未反映のため escape hatch で設定する（要件 6.5）。
    // CompressionLevel は指定しない。
    for (const language of VECTOR_LANGUAGES) {
      const fieldName = resolveVectorField(language);
      index.addPropertyOverride(`Mappings.Properties.${fieldName}.DataType`, KNN_DATA_TYPE);
    }

    this.index = index;
  }
}

/**
 * デプロイ段階ゲートのフラグ値を 1 つの出典から解釈する（要件 7.5）。
 *
 * 受理するのは真偽値の `true` / `false` と、その文字列表現（前後の空白を無視し、
 * 大小文字を区別しない）のみ。未設定と空文字列は「指定なし」を意味する `undefined` を返し、
 * 呼び出し側が次の候補へ進む。それ以外の値は誤設定として失敗させる。
 *
 * 「フラグを付けたつもりが false のまま」よりも「値の綴りを間違えたら止まる」を選ぶ。
 * この判断はコンテキストにも環境変数にも同じく当てはまる。`VECTOR_COLLECTION_ENABLED=1` や
 * `=yes` のような綴り違いは、黙って false に落ちるのではなく合成を止める。
 */
function parseEnabledFlag(raw: unknown, source: string): boolean | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  if (typeof raw === 'boolean') {
    return raw;
  }
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  throw new Error(`${source} must be true or false. Received: ${JSON.stringify(raw)}`);
}

/**
 * デプロイ段階ゲートを解決する（既定 false、要件 7.5）。
 *
 * 解決順序:
 * 1. CDK コンテキスト `vectorCollectionEnabled`（`new App({ context })` 経由。主にテスト）
 * 2. 環境変数 `VECTOR_COLLECTION_ENABLED`（`ampx sandbox` から届く唯一の経路）
 * 3. 既定 false
 *
 * コンテキストが指定されていればそれが勝つ。環境変数はプロセス全体に効くため、
 * 明示的に組んだ App の意図を環境が上書きしない側の優先順にしている。
 * 既定を false のまま据え置くことで、フラグを与えない `npx ampx sandbox`（Stage A、
 * tasks.md 13.2 の手順）はこれまでと同じ結果になる。
 */
function resolveCollectionEnabled(scope: Construct): boolean {
  const fromContext = parseEnabledFlag(
    scope.node.tryGetContext(VECTOR_COLLECTION_ENABLED_CONTEXT_KEY) as unknown,
    `Context value "${VECTOR_COLLECTION_ENABLED_CONTEXT_KEY}"`
  );
  if (fromContext !== undefined) {
    return fromContext;
  }

  const fromEnvironment = parseEnabledFlag(
    process.env[VECTOR_COLLECTION_ENABLED_ENV_KEY],
    `Environment variable "${VECTOR_COLLECTION_ENABLED_ENV_KEY}"`
  );
  if (fromEnvironment !== undefined) {
    return fromEnvironment;
  }

  return false;
}

/**
 * データアクセスポリシーの文書を組み立てる（要件 17.4 / 17.7 / 17.12）。
 *
 * 3 つの principal を役割で分ける。同じ principal に 2 つの役割を兼ねさせない。
 *
 * - 検索 Lambda: `aoss:ReadDocument` と `aoss:DescribeIndex` のみ
 * - 埋め込みバッチ: `aoss:WriteDocument` のみ（インデックスとマッピングの作成・変更は行わない、要件 6.8）
 * - CloudFormation 実行ロール: `CreateIndex` / `DescribeIndex` / `UpdateIndex` / `DeleteIndex` のみ。
 *   `ReadDocument` と `WriteDocument` は含めない（インデックスを管理するだけで読み書きしない）
 *
 * 検索ロールと埋め込みロールの ARN は `Lazy.string()` 経由で渡るため未指定になり得る。
 * 未指定のステートメントは出力しない（Principal を空配列にするとポリシー全体が無効になる）。
 * 実行ロールは常に解決できるため、そのステートメントは必ず出力する。
 */
function buildDataAccessStatements(principals: {
  searchLambdaRoleArn?: string;
  embeddingJobRoleArn?: string;
  deploymentRoleArn: string;
}): unknown[] {
  const indexResource = [`index/${VECTOR_COLLECTION_NAME}/${VECTOR_INDEX_NAME}`];
  const statements: unknown[] = [];

  const pushStatement = (roleArn: string, permissions: readonly string[]): void => {
    statements.push({
      Rules: [
        {
          ResourceType: 'index',
          Resource: indexResource,
          Permission: [...permissions],
        },
      ],
      Principal: [roleArn],
    });
  };

  if (principals.searchLambdaRoleArn) {
    pushStatement(principals.searchLambdaRoleArn, ['aoss:ReadDocument', 'aoss:DescribeIndex']);
  }

  if (principals.embeddingJobRoleArn) {
    pushStatement(principals.embeddingJobRoleArn, ['aoss:WriteDocument']);
  }

  pushStatement(principals.deploymentRoleArn, INDEX_LIFECYCLE_PERMISSIONS);

  return statements;
}

/**
 * `inventory-vector` のマッピングを組み立てる（要件 6.4 / 6.5 / 6.7）。
 *
 * - `embeddingJa` / `embeddingEn`: `knn_vector`。次元数は検証済みの 1 つの値から導出するため常に同一
 * - `itemId` / `warehouseId`: フィルタ用の keyword。`warehouseId` は `.keyword` サブフィールドを持たない
 * - `itemName` / `location`: 表示用の keyword
 * - Sku_Metadata の 9 項目 x 日英 2 組 = 18 フィールド: 表示用の keyword
 * - `unitPrice` / `quantity`: integer（下記の型注記を参照）
 *
 * `_id` は `${itemId}#${warehouseId}`（`buildVectorDocumentId`）を前提とし、
 * 複合キーを保持する専用フィールドは定義しない。
 */
function buildIndexProperties(
  validated: VectorDimensionsValidationSuccess
): Record<string, opensearchserverless.CfnIndex.PropertyMappingProperty> {
  const properties: Record<string, opensearchserverless.CfnIndex.PropertyMappingProperty> = {};

  // knn_vector 2 フィールド。次元数は fieldDimensions から取り、言語ごとに別値になる経路を作らない
  for (const language of VECTOR_LANGUAGES) {
    const fieldName: VectorFieldName = resolveVectorField(language);
    properties[fieldName] = {
      type: 'knn_vector',
      dimension: validated.fieldDimensions[fieldName],
      method: KNN_METHOD,
    };
  }

  // フィルタ用 / 表示用の keyword
  for (const fieldName of ['itemId', 'warehouseId', 'itemName', 'location']) {
    properties[fieldName] = { type: 'keyword' };
  }

  // Sku_Metadata 9 項目 x 日英 2 組 = 18 フィールド
  for (const language of VECTOR_LANGUAGES) {
    const suffix = languageSuffix(language);
    for (const stem of Object.values(METADATA_FIELD_STEMS)) {
      properties[`${stem}${suffix}`] = { type: 'keyword' };
    }
  }

  // ─── 数値項目: integer は AOSS リソーススキーマの制約であって設計上の選択ではない ───
  //
  // `AWS::OpenSearchServerless::Index` の `PropertyMapping.Type` の enum は
  // `["text", "knn_vector", "keyword", "integer"]` のみである（出典:
  // `cloudformation:DescribeType AWS::OpenSearchServerless::Index`）。`double` / `long` /
  // `float` は Type に存在しない。当初 `unitPrice: double` / `quantity: long` を指定していたため
  // Stage B のデプロイが CREATE_FAILED になった:
  // `#/Mappings/Properties/unitPrice/Type: failed validation constraint for keyword [enum]`。
  // つまり整数以外の数値型を選ぶ余地が無く、数値として索引するなら integer 一択である。
  //
  // このデータセットでは無害である。`unitPrice` は円単位の整数で、生成器
  // （`amplify/functions/seed/sku-generator.ts` の `generateUnitPrice`）が
  // `Math.round(randomInt(min, max) / 10) * 10` として 10 円単位に丸めており、値域は 50〜5,000。
  // `quantity` も `randomInt(10, 1000)` の整数（在庫数）。フロントエンドは
  // `¥${unitPrice.toLocaleString('ja-JP')}` として整数前提で表示し、書き込み経路は seed のみである。
  //
  // 注意: 小数を含む価格を扱うデータセットへ移す場合、この integer では表現できない
  // （DynamoDB 側は `N` なので制約が無く、両バックエンドの表現能力がずれる）。その場合は
  // 別の表現が必要になる — 例えば `keyword` として格納する（範囲検索は失う）か、
  // 最小通貨単位（銭）へスケールした整数にする。integer のまま流し込むと桁が落ちる。
  properties.unitPrice = { type: 'integer' };
  properties.quantity = { type: 'integer' };

  return properties;
}
