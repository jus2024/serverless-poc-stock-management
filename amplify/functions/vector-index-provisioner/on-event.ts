/**
 * Index_Provisioner — onEvent ハンドラ（CDK カスタムリソース）
 *
 * `AWS::DynamoDB::Table` に `VectorIndexes` プロパティは存在しないため（V1）、
 * ベクトルインデックスは `UpdateTable` の `VectorIndexUpdates` で作成・削除する。
 * 1 回の `UpdateTable` で追加または削除できるのは 1 件のみであり（V1 / 要件 5.9）、
 * 本ハンドラは **常に要素数 1** の `VectorIndexUpdates` を送る。
 *
 * ライフサイクル
 * - Create: `VectorIndexUpdates: [{ Create: {...} }]`。既存インデックスがある場合は
 *   成功として扱い、`DescribeTable` で 4 項目（インデックス名・ベクトル属性名・
 *   次元数・距離関数）の一致を確認する（要件 5.10）
 * - Update: 次元数・距離関数・射影・検索スキーマの変更は既存インデックスの
 *   再作成を伴う破壊的変更であり、`UpdateTable` では表現できない。自動では行わず
 *   明示的に失敗させる（要件 5.8 の手動再作成手順へ誘導する）
 * - Delete: `VectorIndexUpdates: [{ Delete: { IndexName } }]`。インデックスまたは
 *   テーブルが存在しない場合は成功として扱う（要件 5.11）
 *
 * SDK について: `VectorIndexUpdates` / `VectorIndexDescription` は
 * `@aws-sdk/client-dynamodb@3.1112.0` のモデルに含まれている。API の形をそのまま表す型は
 * **SDK からのみ取り込む**（`CreateVectorIndexAction` / `SearchSchemaElement` /
 * `Projection` / `VectorIndexDescription` / `UpdateTableCommandInput`）。本ファイルで
 * 再定義すると実 API との乖離がコンパイラに検出されないまま残るため、ローカル型は
 * **CloudFormation のリソースプロパティ（本機能が決める形）**にのみ用いる。
 * Lambda 同梱 SDK に依存しないよう `NodejsFunction` の `bundling.externalModules: []` で
 * バンドルする（`amplify/custom/vector-index.ts` を参照）。
 *
 * 要件: 5.1, 5.2, 5.3, 5.4, 5.6, 5.9, 5.10, 5.11, 5.12, 17.2
 * 設計: Index_Provisioner（Custom Resource）
 */

import {
  DescribeTableCommand,
  DynamoDBClient,
  UpdateTableCommand,
  type AttributeDefinition,
  type CreateVectorIndexAction,
  type Projection,
  type ScalarAttributeType,
  type SearchSchemaElement,
  type UpdateTableCommandInput,
  type VectorDistanceFunction,
  type VectorIndexDescription,
} from '@aws-sdk/client-dynamodb';

import { validateDimensions } from '../shared/vector/constraints';
import { VECTOR_LANGUAGES, resolveIndexName, resolveVectorField } from '../shared/vector/language';

// ============================================================
// CloudFormation カスタムリソースのイベント型（必要な部分のみ）
// ============================================================

/** `custom_resources.Provider` の onEvent ハンドラが受け取るイベント */
export interface OnEventRequest {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly ResourceProperties: Record<string, unknown>;
  readonly OldResourceProperties?: Record<string, unknown>;
  /** Create では送られない。Update / Delete では必ず送られる */
  readonly PhysicalResourceId?: string;
}

/** onEvent ハンドラの戻り値。`Data` は is-complete と CFN の `Fn::GetAtt` へ渡る */
export interface OnEventResponse {
  readonly PhysicalResourceId: string;
  readonly Data?: Record<string, string | number | boolean>;
}

// ============================================================
// ベクトルインデックス API の型
// ============================================================
//
// `CreateVectorIndexAction` / `DeleteVectorIndexAction` / `VectorIndexUpdate` /
// `SearchSchemaElement` / `Projection` / `VectorIndexDescription` / `VectorAttributeDefinition`
// はすべて `@aws-sdk/client-dynamodb` のモデルから取り込む。ここで再定義しない。
// `UpdateTableCommandInput` は `VectorIndexUpdates` を含むため、拡張型も不要である。
//
// 実 API の要点（ローカル型で取り違えていた箇所）:
// - `VectorAttribute` は `{ AttributeName: string }` の**オブジェクト**であり、素の文字列ではない
// - `SearchSchema` は `SearchSchemaElement[]` の**平坦な配列**であり、`AttributeSchema` で包まない
// - 要素の種別フィールド名は `SearchSchemaElementType`（`"HASH" | "INLINE_FILTER"`）であり、
//   `KeyType` でも `AttributeType` でもない
// - `VectorIndexDescription` は `TableDescription.VectorIndexes`（**複数形の配列**）に入る
// - `SearchSchema` に載せた属性は `UpdateTable` の `AttributeDefinitions` にも宣言しなければ
//   ならない。GSI を `UpdateTable` で追加するときと同じ規則であり、検証対象は
//   **リクエストに含めた `AttributeDefinitions`** である（テーブル側の既存定義とのマージではない）。
//   宣言を省くと `One or more parameter values were invalid: One element in SearchSchema is not
//   defined in attribute definitions` で弾かれる

// ============================================================
// 定数
// ============================================================

/**
 * テーブルが `UPDATING` の間に届いた `ResourceInUseException` を再試行する回数。
 *
 * 2 本のインデックスは CFN の依存関係で逐次化しているが、is-complete の完了条件は
 * `IndexStatus === 'ACTIVE'` のみでバックフィル完了を含めないため（要件 5.13 / 5.14）、
 * 2 本目の `UpdateTable` がテーブル更新中にぶつかりうる。短時間の待機で解消する
 * 一過性の状態であるため、ハンドラ内で待ってから再試行する。
 */
const MAX_TABLE_BUSY_ATTEMPTS = 8;

/** テーブル更新中の再試行間隔（ms） */
const TABLE_BUSY_RETRY_DELAY_MS = 15_000;

/** 許容する `IndexName` と `VectorAttribute` の組。`language.ts` の対応表のみを出典とする */
const ALLOWED_INDEX_PAIRS: ReadonlyArray<{ readonly indexName: string; readonly vectorAttribute: string }> =
  VECTOR_LANGUAGES.map((language) => ({
    indexName: resolveIndexName(language),
    vectorAttribute: resolveVectorField(language),
  }));

const client = new DynamoDBClient({});

// ============================================================
// リソースプロパティの解釈
// ============================================================

/**
 * 検証済みのリソースプロパティ。
 *
 * CloudFormation から届く値（すべて文字列になりうる）を検証したうえで、
 * **`UpdateTable` へそのまま渡せる SDK の型**に正規化して保持する。この型が
 * 「CFN プロパティ → API 入力」の唯一の変換境界であり、以降の経路には
 * API 形を再定義したローカル型が現れない。
 */
export interface VectorIndexResourceProperties {
  readonly tableName: string;
  readonly indexName: string;
  /** ベクトル属性名。`CreateVectorIndexAction.VectorAttribute.AttributeName` へ入る */
  readonly vectorAttribute: string;
  readonly dimensions: number;
  readonly distanceFunction: VectorDistanceFunction;
  /** 平坦な `SearchSchemaElement[]`。`HASH` 要素は含まない（V2 / 要件 5.3） */
  readonly searchSchema: SearchSchemaElement[];
  /**
   * `SearchSchema` の各要素に対応する属性定義。`UpdateTable` の `AttributeDefinitions` へ入る。
   *
   * 属性型はリソースプロパティで**明示的に**受け取る。ハンドラ内で `DescribeTable` を呼んで
   * 既存の `AttributeDefinitions` から拾う方式は却下した（テーブル定義から乖離しない利点は
   * あるが、API 呼び出しが増え、属性が本当に無い場合の失敗が分かりにくくなる）。
   *
   * ベクトル属性（`embeddingJa` / `embeddingEn`）は含まない。ドキュメントの `CreateTable` 例でも
   * ベクトル属性は `AttributeDefinitions` に宣言されておらず、API のエラーメッセージも
   * `SearchSchema` の要素に限定して述べている。
   */
  readonly searchSchemaAttributeDefinitions: AttributeDefinition[];
  readonly projection: Projection;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireString(props: Record<string, unknown>, key: string): string {
  const value = props[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Resource property "${key}" must be a non-empty string. Received: ${describe(value)}`);
  }
  return value.trim();
}

function requireStringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Resource property "${key}" must be an array of strings. Received: ${describe(value)}`);
  }
  return value.map((element, i) => {
    if (typeof element !== 'string' || element.trim().length === 0) {
      throw new Error(
        `Resource property "${key}[${i}]" must be a non-empty string. Received: ${describe(element)}`
      );
    }
    return element.trim();
  });
}

/** 任意の値を短い文字列へ変換する。例外を投げない */
function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value.slice(0, 80));
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `array(length=${value.length})`;
  return typeof value;
}

/**
 * CloudFormation はカスタムリソースのプロパティの数値を文字列へ変換して渡す。
 * `Dimensions` は文字列でも数値でも受理し、共有の `validateDimensions` で
 * 実効範囲（1〜4,096）を確認する（要件 5.2 / 6.11）。
 */
function parseDimensions(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  const result = validateDimensions(parsed, 'effective');
  if (!result.ok) {
    throw new Error(`Invalid resource property "Dimensions". ${result.message}`);
  }
  return result.dimensions;
}

/** `DistanceFunction` の許容値。SDK の `VectorDistanceFunction` と同一の 3 値 */
const ALLOWED_DISTANCE_FUNCTIONS: readonly VectorDistanceFunction[] = [
  'COSINE',
  'DOT_PRODUCT',
  'EUCLIDEAN',
];

/**
 * `DistanceFunction` を検証する。
 *
 * `CreateVectorIndexAction.DistanceFunction` は 3 値の列挙であり、任意の文字列を
 * 送ると `UpdateTable` で失敗する。大文字化して照合し、列挙値として確定させる。
 */
function parseDistanceFunction(props: Record<string, unknown>): VectorDistanceFunction {
  const raw = requireString(props, 'DistanceFunction').toUpperCase();
  const match = ALLOWED_DISTANCE_FUNCTIONS.find((allowed) => allowed === raw);
  if (match === undefined) {
    throw new Error(
      `Resource property "DistanceFunction" must be one of ${ALLOWED_DISTANCE_FUNCTIONS.join(', ')}. ` +
        `Received: ${JSON.stringify(raw)}.`
    );
  }
  return match;
}

/**
 * `SearchSchema` を検証する。
 *
 * リソースプロパティは実 API と同じ**平坦な配列**で受け取る（`AttributeSchema` で
 * 包まない）。要素の種別フィールド名も API と同じ `SearchSchemaElementType` である。
 *
 * `HASH` 要素を受理しない。`HASH` を定義すると全検索の `SearchConditionExpression`
 * で当該条件が必須になり、倉庫フィルタなしの検索（既定の「全倉庫」）が成立しない
 * （V2 / 要件 5.3）。
 */
function parseSearchSchema(value: unknown): SearchSchemaElement[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `Resource property "SearchSchema" must be a non-empty array of search schema elements. ` +
        `Received: ${describe(value)}`
    );
  }

  return value.map((element, i) => {
    const elementRecord = asRecord(element);
    if (!elementRecord) {
      throw new Error(
        `Resource property "SearchSchema[${i}]" must be an object. Received: ${describe(element)}`
      );
    }
    const elementType = requireString(elementRecord, 'SearchSchemaElementType');
    if (elementType !== 'INLINE_FILTER') {
      throw new Error(
        `Resource property "SearchSchema[${i}].SearchSchemaElementType" must be "INLINE_FILTER". ` +
          `Received: ${JSON.stringify(elementType)}. A HASH element would make the condition mandatory ` +
          'for every search and break the default all-warehouse search.'
      );
    }
    return {
      AttributeName: requireString(elementRecord, 'AttributeName'),
      SearchSchemaElementType: elementType,
    } satisfies SearchSchemaElement;
  });
}

/** `AttributeDefinition.AttributeType` の許容値。SDK の `ScalarAttributeType` と同一の 3 値 */
const ALLOWED_SCALAR_ATTRIBUTE_TYPES: readonly ScalarAttributeType[] = ['S', 'N', 'B'];

/**
 * `SearchSchemaAttributeDefinitions` を検証する。
 *
 * `UpdateTable` は `SearchSchema` に載せた属性が同一リクエストの `AttributeDefinitions` にも
 * 宣言されていることを要求する。宣言漏れと余剰宣言のどちらも実 API では
 * `One or more parameter values were invalid` に潰れて原因が読めないため、
 * `SearchSchema` の属性名集合との**完全一致**をここで確かめて、不一致は明示的に失敗させる。
 */
function parseSearchSchemaAttributeDefinitions(
  value: unknown,
  searchSchema: readonly SearchSchemaElement[]
): AttributeDefinition[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `Resource property "SearchSchemaAttributeDefinitions" must be a non-empty array of attribute ` +
        `definitions. Received: ${describe(value)}`
    );
  }

  const definitions = value.map((element, i) => {
    const elementRecord = asRecord(element);
    if (!elementRecord) {
      throw new Error(
        `Resource property "SearchSchemaAttributeDefinitions[${i}]" must be an object. ` +
          `Received: ${describe(element)}`
      );
    }
    const attributeName = requireString(elementRecord, 'AttributeName');
    const rawType = requireString(elementRecord, 'AttributeType');
    const attributeType = ALLOWED_SCALAR_ATTRIBUTE_TYPES.find((allowed) => allowed === rawType);
    if (attributeType === undefined) {
      throw new Error(
        `Resource property "SearchSchemaAttributeDefinitions[${i}].AttributeType" must be one of ` +
          `${ALLOWED_SCALAR_ATTRIBUTE_TYPES.join(', ')}. Received: ${JSON.stringify(rawType)}.`
      );
    }
    return { AttributeName: attributeName, AttributeType: attributeType } satisfies AttributeDefinition;
  });

  // `AttributeName` は上の `requireString` を通っているため、ここでは常に文字列である。
  // SDK の型は `string | undefined` であるため、集合比較の前に文字列だけへ絞る
  const declared: string[] = definitions.flatMap((definition) =>
    typeof definition.AttributeName === 'string' ? [definition.AttributeName] : []
  );
  const required: string[] = searchSchema.flatMap((element) =>
    typeof element.AttributeName === 'string' ? [element.AttributeName] : []
  );

  const duplicates = declared.filter((name, i) => declared.indexOf(name) !== i);
  if (duplicates.length > 0) {
    throw new Error(
      `Resource property "SearchSchemaAttributeDefinitions" declares the same attribute more than ` +
        `once: ${[...new Set(duplicates)].join(', ')}.`
    );
  }

  const missing = required.filter((name) => !declared.includes(name));
  const extra = declared.filter((name) => !required.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Resource property "SearchSchemaAttributeDefinitions" must declare exactly the attributes ` +
        `referenced by "SearchSchema". Every SearchSchema attribute has to be declared in the ` +
        `AttributeDefinitions of the same UpdateTable request, the same way key attributes are ` +
        `declared when adding a global secondary index. ` +
        `SearchSchema attributes: ${required.join(', ') || '(none)'}. ` +
        `Declared: ${declared.join(', ') || '(none)'}. ` +
        `Missing: ${missing.join(', ') || '(none)'}. Unexpected: ${extra.join(', ') || '(none)'}.`
    );
  }

  return definitions;
}

/**
 * `Projection` を検証する。
 *
 * `ProjectionType: ALL` を受理しない。`SearchVectors` の応答は 16 MB 上限で
 * ページネーション非対応のため、必要属性のみを明示する（V4 / 要件 5.6）。
 */
function parseProjection(value: unknown): Projection {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`Resource property "Projection" must be an object. Received: ${describe(value)}`);
  }

  const projectionType = requireString(record, 'ProjectionType');
  if (projectionType !== 'INCLUDE') {
    throw new Error(
      `Resource property "Projection.ProjectionType" must be "INCLUDE". ` +
        `Received: ${JSON.stringify(projectionType)}. ProjectionType ALL is rejected because the ` +
        'SearchVectors response has a 16 MB limit and does not support pagination.'
    );
  }

  return {
    ProjectionType: projectionType,
    NonKeyAttributes: requireStringArray(record.NonKeyAttributes, 'Projection.NonKeyAttributes'),
  };
}

/**
 * リソースプロパティを検証して読み取る（要件 5.12）。
 *
 * `IndexName` と `VectorAttribute` の組は `language.ts` の対応表に載っている
 * 2 組のみを受理する。文字列結合で名前を作る経路を実行時にも塞ぐ。
 */
export function parseResourceProperties(raw: unknown): VectorIndexResourceProperties {
  const props = asRecord(raw);
  if (!props) {
    throw new Error(`ResourceProperties must be an object. Received: ${describe(raw)}`);
  }

  const indexName = requireString(props, 'IndexName');
  const vectorAttribute = requireString(props, 'VectorAttribute');

  const pairIsAllowed = ALLOWED_INDEX_PAIRS.some(
    (pair) => pair.indexName === indexName && pair.vectorAttribute === vectorAttribute
  );
  if (!pairIsAllowed) {
    const allowed = ALLOWED_INDEX_PAIRS.map((pair) => `${pair.indexName}/${pair.vectorAttribute}`).join(', ');
    throw new Error(
      `Unsupported IndexName/VectorAttribute pair: ${indexName}/${vectorAttribute}. Allowed pairs: ${allowed}.`
    );
  }

  const searchSchema = parseSearchSchema(props.SearchSchema);

  return {
    tableName: requireString(props, 'TableName'),
    indexName,
    vectorAttribute,
    dimensions: parseDimensions(props.Dimensions),
    distanceFunction: parseDistanceFunction(props),
    searchSchema,
    searchSchemaAttributeDefinitions: parseSearchSchemaAttributeDefinitions(
      props.SearchSchemaAttributeDefinitions,
      searchSchema
    ),
    projection: parseProjection(props.Projection),
  };
}

/**
 * 物理 ID。次元数と距離関数を含める（`byEmbedding{Ja|En}-d{dimensions}-{distanceFunction}`）。
 *
 * 4 項目のうち可変な 2 項目を ID に載せることで、デプロイ済みのインデックス構成が
 * CFN 上で識別できる。Update イベントでは受信した物理 ID と本関数の戻り値を
 * 比較して、破壊的変更（次元数・距離関数の変更）を検出する。
 */
export function buildPhysicalResourceId(props: {
  readonly indexName: string;
  readonly dimensions: number;
  readonly distanceFunction: string;
}): string {
  return `${props.indexName}-d${props.dimensions}-${props.distanceFunction}`;
}

/**
 * 不変プロパティの同一性を比較するための正規形。
 *
 * `searchSchemaAttributeDefinitions` の**属性型は含めない**。`DescribeTable` の
 * `VectorIndexDescription` は属性型を返さないため、含めると照合できない項目で
 * リソース置換が起きうる。属性名は `searchSchema` 側の集合と完全一致することを
 * `parseSearchSchemaAttributeDefinitions` が保証しているため、比較としても重複になる。
 */
function toComparableDefinition(props: VectorIndexResourceProperties): string {
  return JSON.stringify({
    tableName: props.tableName,
    indexName: props.indexName,
    vectorAttribute: props.vectorAttribute,
    dimensions: props.dimensions,
    distanceFunction: props.distanceFunction,
    searchSchema: props.searchSchema.map((element) => [
      element.AttributeName,
      element.SearchSchemaElementType,
    ]),
    projection: [props.projection.ProjectionType, [...(props.projection.NonKeyAttributes ?? [])].sort()],
  });
}

// ============================================================
// エラー分類
// ============================================================

function errorName(error: unknown): string {
  const record = asRecord(error);
  const name = record?.name;
  return typeof name === 'string' ? name : '';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const record = asRecord(error);
  const message = record?.message;
  return typeof message === 'string' ? message : String(error);
}

/** 既存インデックスまたはテーブル更新中を示すエラー（要件 5.10 の冪等性判定の入口） */
function isResourceInUse(error: unknown): boolean {
  if (errorName(error) === 'ResourceInUseException') return true;
  return errorName(error) === 'ValidationException' && /already exist/i.test(errorMessage(error));
}

/** 対象が存在しないことを示すエラー（要件 5.11 の削除の冪等性判定） */
function isNotFound(error: unknown): boolean {
  if (errorName(error) === 'ResourceNotFoundException') return true;
  return (
    errorName(error) === 'ValidationException' &&
    /(does not exist|not found|no such index)/i.test(errorMessage(error))
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ============================================================
// DescribeTable によるインデックス参照
// ============================================================

/** ベクトルインデックスの参照結果。テーブル不存在とインデックス不存在を区別する */
export interface VectorIndexLookup {
  readonly tableFound: boolean;
  readonly index?: VectorIndexDescription;
}

/**
 * `DescribeTable` の `TableDescription.VectorIndexes` から対象インデックスを 1 件引く。
 *
 * SDK のモデルにある形（`VectorIndexes?: VectorIndexDescription[]`）をそのまま読む。
 * テーブルが存在しない場合は例外にせず `tableFound: false` を返す
 * （削除の冪等性判定に使う。要件 5.11）。
 *
 * is-complete ハンドラからも同じ経路で参照するため、本モジュールから公開する。
 */
export async function lookupVectorIndex(
  tableName: string,
  indexName: string
): Promise<VectorIndexLookup> {
  let response;
  try {
    response = await client.send(new DescribeTableCommand({ TableName: tableName }));
  } catch (error) {
    if (isNotFound(error)) {
      return { tableFound: false };
    }
    throw error;
  }

  const descriptions = response.Table?.VectorIndexes ?? [];

  return {
    tableFound: true,
    index: descriptions.find((description) => description.IndexName === indexName),
  };
}

/**
 * 既存インデックスが要求値と一致するかを確認する（要件 5.10）。
 *
 * インデックス名・ベクトル属性名・次元数・距離関数の 4 項目を突き合わせ、
 * 1 つでも異なれば要求値と実際の値の両方を含むエラーにする。
 *
 * ベクトル属性名は `VectorAttribute.AttributeName` から読む。`VectorAttribute` は
 * オブジェクトであり、素の文字列として比較すると 4 項目一致の確認が常に
 * 不一致を報告してしまう。
 */
function assertExistingIndexMatches(
  existing: VectorIndexDescription,
  props: VectorIndexResourceProperties
): void {
  const actualVectorAttribute = existing.VectorAttribute?.AttributeName;
  const actualDimensions = existing.Dimensions;

  const mismatches: string[] = [];

  if (existing.IndexName !== props.indexName) {
    mismatches.push(`IndexName: expected ${props.indexName}, actual ${describe(existing.IndexName)}`);
  }
  if (actualVectorAttribute !== props.vectorAttribute) {
    mismatches.push(
      `VectorAttribute: expected ${props.vectorAttribute}, actual ${describe(actualVectorAttribute)}`
    );
  }
  if (actualDimensions !== props.dimensions) {
    mismatches.push(`Dimensions: expected ${props.dimensions}, actual ${describe(actualDimensions)}`);
  }
  if (existing.DistanceFunction !== props.distanceFunction) {
    mismatches.push(
      `DistanceFunction: expected ${props.distanceFunction}, actual ${describe(existing.DistanceFunction)}`
    );
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Vector index ${props.indexName} already exists on table ${props.tableName} with a different ` +
        `definition. The distance function and the dimensions of a vector index cannot be changed in ` +
        `place; delete the index, recreate it and re-ingest every embedding. Mismatches: ` +
        mismatches.join('; ')
    );
  }
}

// ============================================================
// ライフサイクル
// ============================================================

/**
 * Create。`VectorIndexUpdates` を **要素数 1** で `UpdateTable` に渡す（V1 / 要件 5.9）。
 *
 * 既存インデックスがある場合（`ResourceInUseException` / already exists）は成功として
 * 扱い、`DescribeTable` で 4 項目の一致を確認する（要件 5.10）。テーブル自体が
 * `UPDATING` の場合も同じ例外が返るため、対象インデックスが見つからない間は
 * 短時間待って再試行する。
 */
async function handleCreate(props: VectorIndexResourceProperties): Promise<OnEventResponse> {
  const createSpec: CreateVectorIndexAction = {
    IndexName: props.indexName,
    // `VectorAttribute` はオブジェクト。素の文字列を送ると `UpdateTable` が受理しない
    VectorAttribute: { AttributeName: props.vectorAttribute },
    Dimensions: props.dimensions,
    DistanceFunction: props.distanceFunction,
    // `SearchSchema` は平坦な配列。`AttributeSchema` で包まない
    SearchSchema: props.searchSchema,
    Projection: props.projection,
  };

  const input: UpdateTableCommandInput = {
    TableName: props.tableName,
    // `SearchSchema` に載せた属性は同一リクエストの `AttributeDefinitions` にも宣言する。
    // テーブル側に定義済みでも、リクエストに含めなければ `UpdateTable` は
    // `One element in SearchSchema is not defined in attribute definitions` で弾く。
    // テーブルの PK（`itemId`）は含めない。`SearchSchema` に `HASH` 要素を定義していないため
    // 不要であり、使われない定義を足すと別のエラーを招きうる。ベクトル属性も含めない
    AttributeDefinitions: props.searchSchemaAttributeDefinitions,
    // 1 回の UpdateTable で追加できるのは 1 件のみ（V1 / 要件 5.9）
    VectorIndexUpdates: [{ Create: createSpec }],
  };

  let alreadyExisted = false;

  for (let attempt = 1; attempt <= MAX_TABLE_BUSY_ATTEMPTS; attempt += 1) {
    try {
      await client.send(new UpdateTableCommand(input));
      break;
    } catch (error) {
      if (!isResourceInUse(error)) {
        throw error;
      }

      const lookup = await lookupVectorIndex(props.tableName, props.indexName);
      if (lookup.index) {
        // 既存インデックスがある。4 項目一致を確認して成功として扱う（要件 5.10）
        assertExistingIndexMatches(lookup.index, props);
        alreadyExisted = true;
        break;
      }

      // インデックスは無い。テーブルが更新中の一過性の状態と判断して待って再試行する
      if (attempt === MAX_TABLE_BUSY_ATTEMPTS) {
        throw new Error(
          `Table ${props.tableName} is still busy after ${attempt} attempts, so vector index ` +
            `${props.indexName} could not be created. The table is likely still backfilling another ` +
            `vector index. Retry the deployment once DescribeTable reports the table as ACTIVE. ` +
            `Last error: ${errorMessage(error)}`
        );
      }
      await sleep(TABLE_BUSY_RETRY_DELAY_MS);
    }
  }

  return {
    PhysicalResourceId: buildPhysicalResourceId(props),
    Data: {
      TableName: props.tableName,
      IndexName: props.indexName,
      VectorAttribute: props.vectorAttribute,
      Dimensions: props.dimensions,
      DistanceFunction: props.distanceFunction,
      AlreadyExisted: alreadyExisted,
    },
  };
}

/**
 * Update。既存インデックスの定義変更は `UpdateTable` では表現できないため、
 * 破壊的変更として明示的に失敗させる（設計 / 要件 5.8）。
 *
 * 実質的な差分が無い Update（プロバイダ側の都合で届いたもの）は no-op として成功させ、
 * 無関係なデプロイを止めない。
 */
async function handleUpdate(
  event: OnEventRequest,
  props: VectorIndexResourceProperties
): Promise<OnEventResponse> {
  const desiredPhysicalResourceId = buildPhysicalResourceId(props);

  let oldProps: VectorIndexResourceProperties | undefined;
  try {
    oldProps = parseResourceProperties(event.OldResourceProperties);
  } catch {
    oldProps = undefined;
  }

  const unchanged =
    oldProps !== undefined &&
    toComparableDefinition(oldProps) === toComparableDefinition(props) &&
    event.PhysicalResourceId === desiredPhysicalResourceId;

  if (unchanged) {
    return {
      PhysicalResourceId: desiredPhysicalResourceId,
      Data: {
        TableName: props.tableName,
        IndexName: props.indexName,
        VectorAttribute: props.vectorAttribute,
        Dimensions: props.dimensions,
        DistanceFunction: props.distanceFunction,
        AlreadyExisted: true,
      },
    };
  }

  const previous = oldProps
    ? `dimensions ${oldProps.dimensions}, distance function ${oldProps.distanceFunction}, ` +
      `vector attribute ${oldProps.vectorAttribute}`
    : 'unknown (previous resource properties could not be read)';

  throw new Error(
    `Updating vector index ${props.indexName} on table ${props.tableName} in place is not supported. ` +
      `A change to the dimensions, the distance function, the search schema or the projection requires ` +
      `deleting the index, recreating it and re-ingesting every embedding for all 15,000 records. ` +
      `Previous definition: ${previous}. Requested definition: dimensions ${props.dimensions}, ` +
      `distance function ${props.distanceFunction}, vector attribute ${props.vectorAttribute}. ` +
      `Physical resource id: current ${describe(event.PhysicalResourceId)}, ` +
      `requested ${desiredPhysicalResourceId}. Run the documented manual recreation procedure instead.`
  );
}

/**
 * Delete。`VectorIndexUpdates: [{ Delete: { IndexName } }]` を送る。
 * インデックスまたはテーブルが存在しない場合は成功として扱う（要件 5.11）。
 */
async function handleDelete(
  event: OnEventRequest,
  props: VectorIndexResourceProperties
): Promise<OnEventResponse> {
  const physicalResourceId = event.PhysicalResourceId ?? buildPhysicalResourceId(props);

  const input: UpdateTableCommandInput = {
    TableName: props.tableName,
    // 削除では `AttributeDefinitions` を送らない。宣言が要求されるのは
    // `SearchSchema` を伴う作成のときだけである
    // 1 回の UpdateTable で削除できるのは 1 件のみ（V1）
    VectorIndexUpdates: [{ Delete: { IndexName: props.indexName } }],
  };

  try {
    await client.send(new UpdateTableCommand(input));
  } catch (error) {
    if (isNotFound(error)) {
      // インデックスまたはテーブルが既に無い。削除済みとして成功にする（要件 5.11）
      return {
        PhysicalResourceId: physicalResourceId,
        Data: { TableName: props.tableName, IndexName: props.indexName, AlreadyDeleted: true },
      };
    }
    throw error;
  }

  return {
    PhysicalResourceId: physicalResourceId,
    Data: { TableName: props.tableName, IndexName: props.indexName, AlreadyDeleted: false },
  };
}

export const handler = async (event: OnEventRequest): Promise<OnEventResponse> => {
  const props = parseResourceProperties(event.ResourceProperties);

  switch (event.RequestType) {
    case 'Create':
      return handleCreate(props);
    case 'Update':
      return handleUpdate(event, props);
    case 'Delete':
      return handleDelete(event, props);
    default:
      throw new Error(`Unsupported RequestType: ${describe(event.RequestType)}`);
  }
};
