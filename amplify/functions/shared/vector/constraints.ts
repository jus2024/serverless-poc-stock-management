/**
 * 機能制約メタデータ（定数定義）
 *
 * DynamoDB Vector Search と OpenSearch Serverless k-NN の機能差を、
 * バックエンド側の唯一の出典として保持する。
 *
 * 画面（`VectorConstraintTable.tsx`）は TopK 上限・対応フィルタ種別・次元数上限などを
 * **一切ハードコードせず**、`GET /vector-search/capabilities` および各検索応答の
 * `constraints` から取得して描画する（要件 15.6）。したがって実測で制約が変わった場合
 * （例: 範囲フィルタが通った → `supportedFilterKinds` に `'range'` を追加）は、
 * このファイルの値を変えるだけで UI の比較表が追従する。
 *
 * 検索を実行していない状態でも比較表と注意書きを常時表示できるようにするため
 * （要件 15.1 / 15.5）、Capabilities Lambda がこの定義をそのまま返す。
 *
 * すべての値は凍結してある。呼び出し側で書き換えられると「画面の唯一の供給源」で
 * なくなるため、配列も含めて `Object.freeze` する。
 *
 * 要件: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6
 * 設計: API Contract / Capabilities Lambda
 */

import {
  VECTOR_LANGUAGES,
  resolveIndexName,
  resolveVectorField,
  type VectorFieldName,
  type VectorIndexName,
} from './language';
import { MAX_TOP_K } from './topk';

/** 比較対象のバックエンド */
export type VectorBackend = 'dynamodb' | 'opensearch';

/** フィルタ演算子の種別。等価条件と範囲条件のみを区別する */
export type VectorFilterKind = 'equality' | 'range';

/** DynamoDB Vector Index のベクトル次元数上限（前提 A6 / 要件 15.3） */
export const DYNAMODB_MAX_VECTOR_DIMENSIONS = 4096;

/** OpenSearch `knn_vector` のベクトル次元数上限（要件 15.4） */
export const OPENSEARCH_MAX_VECTOR_DIMENSIONS = 16000;

/**
 * バックエンド 1 つ分の機能制約。
 *
 * 各フィールドは読み取り専用として公開する。JSON へ直列化した形は
 * 設計の API Contract と同一であり、フロントエンド側の型定義と互換する。
 */
export interface VectorBackendCapabilities {
  readonly backend: VectorBackend;
  /** TopK の上限。DynamoDB は 100、OpenSearch は同等の上限がないため null（要件 15.1） */
  readonly maxTopK: number | null;
  /** 実装が対応するフィルタ演算子の種別（要件 15.2） */
  readonly supportedFilterKinds: readonly VectorFilterKind[];
  /** 距離関数をインデックス再作成なしに変更できるか（要件 15.3） */
  readonly distanceFunctionMutable: boolean;
  /** 使用する距離関数の識別子。`COSINE`（DynamoDB）/ `cosinesimil`（OpenSearch） */
  readonly distanceFunction: string;
  /** ベクトル次元数の上限（要件 15.3 / 15.4） */
  readonly maxDimensions: number;
  /** オンデマンド課金が前提条件か（要件 15.3） */
  readonly requiresOnDemandBilling: boolean;
  /** 通常のデータ読み取り API（DynamoDB は `Query` / `Scan` / PartiQL）でベクトルを読めるか（要件 15.3） */
  readonly readableByQueryScanPartiQL: boolean;
  /** 全文検索との併用に対応するか（要件 15.4） */
  readonly supportsFullTextCombination: boolean;
  /** 集約に対応するか（要件 15.4） */
  readonly supportsAggregation: boolean;
  /** 地理空間クエリに対応するか（要件 15.4） */
  readonly supportsGeoQuery: boolean;
  /** ネストクエリに対応するか（要件 15.4） */
  readonly supportsNestedQuery: boolean;
  /**
   * 対応フィルタ種別が公式ドキュメント間で未解決である旨（V3 / Q1、要件 15.2）。
   * 未解決の項目がないバックエンドでは省略する。
   */
  readonly filterKindsUnverified?: string;
}

/** 埋め込みモデルと言語別測定に関する注意書き（要件 15.5） */
export interface VectorEmbeddingNotice {
  /** 埋め込みモデル ID */
  readonly model: string;
  /** 正式サポート言語 */
  readonly officiallySupportedLanguages: string;
  /** プレビュー扱いの言語に関する記述 */
  readonly previewLanguagesNote: string;
  /** 日英 2 本のベクトルを独立生成して言語別に Recall_At_K を測定している旨 */
  readonly bilingualMeasurementNote: string;
  /** 両バックエンドが同一ベクトルを使うため比較の公平性が保たれる旨 */
  readonly fairnessNote: string;
  /** 測定結果を記録する Verification_Report のパス */
  readonly reportPath: string;
}

/** `GET /vector-search/capabilities` の応答（要件 15.1 / 15.5 / 15.6） */
export interface VectorCapabilitiesResponse {
  readonly dynamodb: VectorBackendCapabilities;
  readonly opensearch: VectorBackendCapabilities;
  readonly embeddingNotice: VectorEmbeddingNotice;
}

/**
 * DynamoDB 側の範囲フィルタ対応可否が未確定である旨（前提 A3 / V3 / Q1）。
 *
 * 開発者ガイドは `SearchConditionExpression` が等価条件のみと記述する一方、
 * SDK API リファレンスは `INLINE_FILTER` 要素が比較・範囲演算子に対応すると記述しており、
 * 公式ドキュメント間で矛盾している。実装既定は等価条件のみとし、実測プローブ
 * （`scripts/vector-search/probe-range-filter.ts`）で二値に確定させる（要件 18.5）。
 */
const DYNAMODB_FILTER_KINDS_UNVERIFIED =
  '範囲条件（大小比較・BETWEEN）の対応可否は公式ドキュメント間で矛盾しており（開発者ガイドは等価条件のみ、' +
  'SDK API リファレンスは INLINE_FILTER 要素が比較・範囲演算子に対応と記述）、実測で確定させる対象である。' +
  '確定までの実装既定は等価条件のみで、範囲条件を含むフィルタ要求は SearchVectors を呼ばずに拒否する。';

/**
 * DynamoDB Vector Search の機能制約（要件 15.1 / 15.2 / 15.3 / 15.4）。
 *
 * TopK 上限は `topk.ts` の `MAX_TOP_K` を参照し、上限値の出典を 1 箇所に保つ。
 */
export const DYNAMODB_VECTOR_CAPABILITIES: VectorBackendCapabilities = Object.freeze({
  backend: 'dynamodb',
  maxTopK: MAX_TOP_K,
  supportedFilterKinds: Object.freeze<VectorFilterKind[]>(['equality']),
  // インデックス作成時に COSINE で固定され、インデックス再作成なしには変更できない（前提 A5）
  distanceFunctionMutable: false,
  distanceFunction: 'COSINE',
  maxDimensions: DYNAMODB_MAX_VECTOR_DIMENSIONS,
  // Vector_Table のオンデマンド課金が前提条件（要件 15.3）
  requiresOnDemandBilling: true,
  // ベクトルインデックスは SearchVectors 専用で、Query / Scan / PartiQL では読み取れない（V4）
  readableByQueryScanPartiQL: false,
  supportsFullTextCombination: false,
  supportsAggregation: false,
  supportsGeoQuery: false,
  supportsNestedQuery: false,
  filterKindsUnverified: DYNAMODB_FILTER_KINDS_UNVERIFIED,
} satisfies VectorBackendCapabilities);

/**
 * OpenSearch Serverless VECTORSEARCH（k-NN）の機能制約（要件 15.1 / 15.4）。
 *
 * `maxTopK` は null。`k` に DynamoDB の 100 に相当する API 仕様上の上限がないため、
 * 「上限なし」を欠損値ではなく明示的な null で表す。
 */
export const OPENSEARCH_VECTOR_CAPABILITIES: VectorBackendCapabilities = Object.freeze({
  backend: 'opensearch',
  maxTopK: null,
  supportedFilterKinds: Object.freeze<VectorFilterKind[]>(['equality', 'range']),
  // space_type はマッピングで固定され、変更には再インデックスを要する（DynamoDB と同様に不可）
  distanceFunctionMutable: false,
  distanceFunction: 'cosinesimil',
  maxDimensions: OPENSEARCH_MAX_VECTOR_DIMENSIONS,
  // 課金は OCU 時間ベース。DynamoDB のような課金モードの前提条件を持たない
  requiresOnDemandBilling: false,
  // 格納したベクトルは通常の検索 API（_search の _source）から読み取れる
  readableByQueryScanPartiQL: true,
  supportsFullTextCombination: true,
  supportsAggregation: true,
  supportsGeoQuery: true,
  supportsNestedQuery: true,
} satisfies VectorBackendCapabilities);

/**
 * 埋め込み言語サポートの注意書き（要件 15.5）。
 *
 * 検索結果の有無に関わらず常時表示する。日本語のプレビュー扱いを注意書きだけで終わらせず、
 * 日英 2 本の独立したベクトルによる言語別 Recall_At_K の実測へつなげる旨をここで示す（前提 A1）。
 */
export const VECTOR_EMBEDDING_NOTICE: VectorEmbeddingNotice = Object.freeze({
  model: 'amazon.titan-embed-text-v2:0',
  officiallySupportedLanguages: '英語',
  previewLanguagesNote:
    'Titan Text Embeddings V2 が正式にサポートする言語は英語であり、日本語を含む 100 言語以上はプレビュー扱いである。',
  bilingualMeasurementNote:
    '本機能では SKU ごとに日本語ベクトルと英語ベクトルを独立生成し、同一の意味を持つクエリ対を用いて言語別に Recall_At_K を測定している。測定した言語間差分は Verification_Report に記載する。',
  fairnessNote:
    'DynamoDB 側と OpenSearch 側は同一のベクトル（同一のインデックス対象ベクトルと同一のクエリベクトル）を使用するため、言語にかかわらず両バックエンド比較の公平性は保たれる。',
  reportPath: 'docs/vector-search-comparison.md',
} satisfies VectorEmbeddingNotice);

/**
 * `GET /vector-search/capabilities` が返す応答そのもの（要件 15.1 / 15.5 / 15.6）。
 * Capabilities Lambda はこの定数を加工せずに返す。
 */
export const VECTOR_CAPABILITIES: VectorCapabilitiesResponse = Object.freeze({
  dynamodb: DYNAMODB_VECTOR_CAPABILITIES,
  opensearch: OPENSEARCH_VECTOR_CAPABILITIES,
  embeddingNotice: VECTOR_EMBEDDING_NOTICE,
} satisfies VectorCapabilitiesResponse);

/**
 * バックエンドに対応する制約を返す。
 * 各検索応答の `constraints` に同じ値を載せるための唯一の経路。
 */
export function getVectorCapabilities(backend: VectorBackend): VectorBackendCapabilities {
  return backend === 'dynamodb' ? DYNAMODB_VECTOR_CAPABILITIES : OPENSEARCH_VECTOR_CAPABILITIES;
}

/** 指定した種別のフィルタに対応しているか判定する（要件 15.2 / 8.7 の判定に使う） */
export function supportsFilterKind(
  capabilities: VectorBackendCapabilities,
  kind: VectorFilterKind
): boolean {
  return capabilities.supportedFilterKinds.includes(kind);
}
// ---------------------------------------------------------------------------
// 次元数バリデーション（要件 5.2 / 6.4 / 6.11、Property 17）
// ---------------------------------------------------------------------------

/** ベクトル次元数の下限。0 以下と非整数は受理しない（要件 6.11） */
export const MIN_VECTOR_DIMENSIONS = 1;

/**
 * 本機能の実効上限（要件 6.11 / V4）。
 *
 * 同一のベクトルを両バックエンドへ格納するため、2 つの上限の小さい方
 * （= DynamoDB の 4,096）が実効上限になる。上限値そのものは
 * `DYNAMODB_MAX_VECTOR_DIMENSIONS` / `OPENSEARCH_MAX_VECTOR_DIMENSIONS` を出典とし、
 * ここでは導出だけを行う。
 */
export const EFFECTIVE_MAX_VECTOR_DIMENSIONS = Math.min(
  DYNAMODB_MAX_VECTOR_DIMENSIONS,
  OPENSEARCH_MAX_VECTOR_DIMENSIONS
);

/** 次元数の検証対象。バックエンド個別の範囲と、本機能の実効範囲を区別する */
export type VectorDimensionScope = VectorBackend | 'effective';

/** 次元数の許容範囲。検証エラー応答に含める（要件 6.11） */
export interface VectorDimensionsRange {
  readonly scope: VectorDimensionScope;
  readonly min: number;
  readonly max: number;
  /** 整数のみ受理することを示す */
  readonly integerOnly: true;
}

/** 検証対象ごとの許容範囲。範囲の唯一の出典 */
export const VECTOR_DIMENSIONS_RANGES: Readonly<
  Record<VectorDimensionScope, VectorDimensionsRange>
> = Object.freeze({
  dynamodb: Object.freeze({
    scope: 'dynamodb',
    min: MIN_VECTOR_DIMENSIONS,
    max: DYNAMODB_MAX_VECTOR_DIMENSIONS,
    integerOnly: true,
  } satisfies VectorDimensionsRange),
  opensearch: Object.freeze({
    scope: 'opensearch',
    min: MIN_VECTOR_DIMENSIONS,
    max: OPENSEARCH_MAX_VECTOR_DIMENSIONS,
    integerOnly: true,
  } satisfies VectorDimensionsRange),
  effective: Object.freeze({
    scope: 'effective',
    min: MIN_VECTOR_DIMENSIONS,
    max: EFFECTIVE_MAX_VECTOR_DIMENSIONS,
    integerOnly: true,
  } satisfies VectorDimensionsRange),
});

/**
 * 次元数の検証成功。
 *
 * 2 本のベクトルインデックスと 2 つの `knn_vector` フィールドへ適用する次元数を
 * **検証済みの 1 つの値から導出して**返す。呼び出し側が言語ごとに別の値を
 * 組み立てる経路を持たないため、4 箇所の次元数は常に等しい（Property 17）。
 */
export interface VectorDimensionsValidationSuccess {
  readonly ok: true;
  readonly scope: VectorDimensionScope;
  readonly dimensions: number;
  /** DynamoDB のベクトルインデックス 2 本の次元数。両者は同一値 */
  readonly indexDimensions: Readonly<Record<VectorIndexName, number>>;
  /** OpenSearch の `knn_vector` フィールド 2 つの次元数。両者は同一値 */
  readonly fieldDimensions: Readonly<Record<VectorFieldName, number>>;
  readonly allowedRange: VectorDimensionsRange;
}

/**
 * 次元数の検証失敗（要件 6.11）。
 *
 * 指定値とバックエンド別の許容範囲を保持する。成功時にのみ存在する
 * `indexDimensions` / `fieldDimensions` を持たないため、検証を通らない値から
 * リソース定義を組み立てられない。
 */
export interface VectorDimensionsValidationFailure {
  readonly ok: false;
  readonly errorCode: 'INVALID_DIMENSIONS';
  readonly scope: VectorDimensionScope;
  /** 指定値とバックエンド別の許容範囲を含む説明文 */
  readonly message: string;
  /** 受信値の安全な文字列表現 */
  readonly received: string;
  /** 受信値の型（number / string / undefined など） */
  readonly receivedType: string;
  readonly allowedRange: VectorDimensionsRange;
  /** バックエンド別および実効の許容範囲 */
  readonly backendRanges: Readonly<Record<VectorDimensionScope, VectorDimensionsRange>>;
}

export type VectorDimensionsValidationResult =
  | VectorDimensionsValidationSuccess
  | VectorDimensionsValidationFailure;

/** 値が検証対象の識別子か判定する */
export function isVectorDimensionScope(value: unknown): value is VectorDimensionScope {
  return value === 'dynamodb' || value === 'opensearch' || value === 'effective';
}

/** 任意の値を例外なく短い文字列へ変換する。Symbol・循環参照でも失敗しない */
function describeDimensions(value: unknown): string {
  switch (typeof value) {
    case 'number':
      return Number.isNaN(value) ? 'NaN' : String(value);
    case 'string':
      return `"${value.slice(0, 50)}"`;
    case 'bigint':
      return `${value.toString()}n`;
    case 'boolean':
      return String(value);
    case 'symbol':
      return value.toString();
    case 'function':
      return 'function';
    case 'undefined':
      return 'undefined';
    case 'object':
      if (value === null) return 'null';
      return Array.isArray(value) ? 'array' : 'object';
    default:
      return 'unknown';
  }
}

/** 許容範囲を説明文へ載せる形へ整える */
function describeRange(range: VectorDimensionsRange): string {
  return `${range.min}〜${range.max}`;
}

/**
 * ベクトル次元数を検証する（要件 5.2 / 6.4 / 6.11、Property 17）。
 *
 * - `dynamodb`: 1 以上 4,096 以下の整数のみ受理する
 * - `opensearch`: 1 以上 16,000 以下の整数のみ受理する
 * - `effective`（既定）: 両バックエンドへ同一ベクトルを格納する本機能の実効範囲。
 *   2 つの上限の小さい方（1 以上 4,096 以下）のみ受理する
 *
 * 全域関数であり、任意の入力に対して例外を投げない。範囲外・整数以外の場合は
 * 指定値とバックエンド別の許容範囲を含む失敗を返し、リソース定義に使う
 * 次元数（`indexDimensions` / `fieldDimensions`）を返さない。
 */
export function validateDimensions(
  value: unknown,
  scope: VectorDimensionScope = 'effective'
): VectorDimensionsValidationResult {
  const resolvedScope: VectorDimensionScope = isVectorDimensionScope(scope) ? scope : 'effective';
  const allowedRange = VECTOR_DIMENSIONS_RANGES[resolvedScope];

  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < allowedRange.min ||
    value > allowedRange.max
  ) {
    const received = describeDimensions(value);
    return {
      ok: false,
      errorCode: 'INVALID_DIMENSIONS',
      scope: resolvedScope,
      message:
        `次元数 ${received} は ${resolvedScope} の許容範囲外です。` +
        `許容範囲（整数のみ）: DynamoDB ${describeRange(VECTOR_DIMENSIONS_RANGES.dynamodb)} / ` +
        `OpenSearch ${describeRange(VECTOR_DIMENSIONS_RANGES.opensearch)} / ` +
        `実効 ${describeRange(VECTOR_DIMENSIONS_RANGES.effective)}。`,
      received,
      receivedType: typeof value,
      allowedRange,
      backendRanges: VECTOR_DIMENSIONS_RANGES,
    };
  }

  const dimensions = value;

  return {
    ok: true,
    scope: resolvedScope,
    dimensions,
    indexDimensions: Object.freeze(
      Object.fromEntries(
        VECTOR_LANGUAGES.map((language) => [resolveIndexName(language), dimensions])
      ) as Record<VectorIndexName, number>
    ),
    fieldDimensions: Object.freeze(
      Object.fromEntries(
        VECTOR_LANGUAGES.map((language) => [resolveVectorField(language), dimensions])
      ) as Record<VectorFieldName, number>
    ),
    allowedRange,
  };
}
