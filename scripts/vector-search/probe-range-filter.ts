/**
 * 範囲フィルタ実測プローブ（Open Question Q1 の決着手段）
 *
 * DynamoDB Vector Search の `SearchVectors` が `SearchConditionExpression` で
 * **`INLINE_FILTER` 要素に対する範囲演算子**を受理するかどうかは、公式ドキュメント間で
 * 記述が矛盾している（前提 A3 / 設計 V3 / Q1）。
 *
 * - 開発者ガイド: `SearchConditionExpression` は等価（`=`）のみ。比較・範囲・`IN` は未提供
 * - SDK API リファレンス: `HASH` 要素は `=` のみだが、`INLINE_FILTER` 要素は比較・範囲演算子に対応
 *
 * どちらが正しいかは読んでも決まらないので、実 API へ投げて挙動を記録する。本スクリプトは
 * 演算子種別（`=` / `<` / `<=` / `>` / `>=` / `BETWEEN` / `IN`）ごとに 1 回ずつ `SearchVectors` を
 * 呼び、**送った要求そのもの**と**生の応答またはエラー（型 + メッセージ）**を記録し、
 * 種別ごとの機械可読な判定を出す。出力はそのまま `docs/vector-search-comparison.md` の
 * 要件 18.5 の記載（「対応する」/「対応しない」の二値）に転記できる形にしてある。
 *
 * 設計上の要点:
 *
 * - **読み取り専用である。** 呼ぶ API は `DescribeTable` と `SearchVectors` の 2 つだけで、
 *   インデックスの作成・削除・更新およびデータの書き込みを一切行わない。使い捨て検証用
 *   インデックスが必要な場合も、本スクリプトは作らない（下記「使い捨てインデックス」を参照）
 * - **対照実験を必ず含める。** 等価条件（`=`）を同一属性・同一インデックスへ投げる対照ケースを
 *   先頭に置く。対照が失敗した場合、範囲条件の拒否は「範囲演算子が非対応」ではなく
 *   「その属性が `INLINE_FILTER` 要素でない」「インデックスが検索可能状態でない」等の
 *   別要因である可能性が高い。したがって対照が通らない限り範囲側の判定は
 *   `inconclusive`（未確定）へ落とし、誤った二値確定を出さない
 * - **`ValidationException` と他のエラーを区別する。** 「非対応」と言えるのは
 *   `ValidationException` で拒否された場合のみである。`ResourceNotFoundException` /
 *   `AccessDeniedException` / スロットリング / 通信失敗は未確定として扱う
 * - **純計算と I/O を分離する。** `SearchVectors` の送信・`DescribeTable`・レポート書き出しは
 *   {@link SearchVectorsTransport} / {@link VectorIndexInspector} / {@link ProbeReportWriter} の
 *   3 つのインターフェース越しに行う。ケース生成・判定・集約・整形はすべて純関数であり、
 *   AWS 認証情報もファイルシステムも要らない
 * - **属性名と値を式文字列へ直接埋め込まない。** `ExpressionAttributeNames` /
 *   `ExpressionAttributeValues` でバインドする（要件 8.6 と同じ作法）
 *
 * 使い捨て検証用インデックスについて（task 11.5 の明示事項）:
 *
 *   既定の探索対象は**既存の本番インデックス**（`byEmbeddingJa`）の `INLINE_FILTER` 要素
 *   `warehouseId`（文字列）である。文字列にも範囲演算子は定義されるため、`unitPrice` を
 *   `INLINE_FILTER` に含めた使い捨てインデックスを作らずに Q1 は決着できる。追加コストが 0 の
 *   この経路を既定にしている。
 *
 *   数値属性でも確認したい場合は、`unitPrice` を `INLINE_FILTER` に含めた使い捨てインデックスを
 *   別途作成し、`--index` と `--attribute unitPrice --attribute-type N` を指定して本スクリプトを
 *   実行する。その際は次の 2 点を必ず守ること。
 *
 *   1. **ベクトルインデックスはテーブルあたり最大 5 本**（設計 V4）。本番の 2 本
 *      （`byEmbeddingJa` / `byEmbeddingEn`）に加えて作れるのは最大 3 本である。本スクリプトは
 *      `DescribeTable` で実際の本数を数え、上限に対する余裕をレポートへ記録する
 *   2. **測定後に削除すること。** インデックスは存在する限りストレージ課金の対象であり、
 *      バックフィルの完了待ちにも時間がかかる。削除は `UpdateTable` の
 *      `VectorIndexUpdates`（1 回 1 本）で行う。本スクリプトは削除を代行しないため、
 *      実行の最後に削除の要否を必ず出力する
 *
 * 結果の反映先（要件 15.6 / 18.5）:
 *
 *   範囲条件が受理された場合、`amplify/functions/shared/vector/constraints.ts` の
 *   `DYNAMODB_VECTOR_CAPABILITIES.supportedFilterKinds` に `'range'` を追加し、
 *   `filterKindsUnverified` を削除するだけでよい。UI の機能制約比較表（`VectorConstraintTable.tsx`）は
 *   固定値を持たず `GET /vector-search/capabilities` の応答だけを描画するため自動的に追従し、
 *   `vector-search-ddb` の範囲条件拒否（要件 8.7）も同じ定数を見ているため同時に解除される。
 *   本スクリプトはその定数を書き換えない（実測と実装変更を別の操作に保つ）。
 *
 * SDK について:
 *
 *   `SearchVectors` は**専用のベクトル検索エンドポイント**を使う。`amplify/functions/vector-search-ddb/handler.ts`
 *   と同じ方針を採り、`SearchVectorsCommand` は**使わず**、AWS JSON 1.0 の署名付き HTTP 要求を
 *   デュアルスタックエンドポイント `search-dynamodb.<region>.api.aws` へ直接送る。もう 1 つの候補である
 *   `<account-id>.search-ddb.<region>.amazonaws.com` は AWS アカウント ID を実行環境へ持ち込む必要が
 *   あるため採らない（要件 16.9 の趣旨に沿う）。この方針は SDK の版に依存しないため、
 *   `SearchVectorsCommand` が利用可能になっても置き換えない。
 *   一方で **`DescribeTable` から読む形（`VectorIndexDescription`）は SDK のモデルをそのまま使う。**
 *   API の形をローカルに再定義すると実 API との乖離がコンパイラに検出されなくなる。
 *
 * 使い方:
 *
 * ```
 * npm run vector:probe-range                       # 既定（warehouseId / byEmbeddingJa）
 * npm run vector:probe-range -- --dry-run          # AWS へ一切送らず送信予定の要求だけを出す
 * npm run vector:probe-range -- --language en
 * npm run vector:probe-range -- --index byUnitPriceProbe --attribute unitPrice --attribute-type N \
 *                                --lower 1000 --upper 5000
 * ```
 *
 * 要件: 8.7, 15.2, 18.5
 * 設計: Open Question Q1 / V3 / 範囲フィルタ実測プローブ
 */

import {
  getVectorCapabilities,
  validateDimensions,
  type VectorBackendCapabilities,
} from '../../amplify/functions/shared/vector/constraints';
import {
  isVectorLanguage,
  resolveIndexName,
  VECTOR_LANGUAGES,
  type VectorLanguage,
} from '../../amplify/functions/shared/vector/language';
import { isValidTopK } from '../../amplify/functions/shared/vector/topk';
// 型のみの取り込み。`VectorIndexDescription` と `SearchSchemaElement` は
// `@aws-sdk/client-dynamodb` のモデルにあるため、そこから取り込む（ローカルに再定義しない）。
// 型輸入なので実行時にこのパッケージを読み込まない（SDK は遅延 import する）。
import type { SearchSchemaElement, VectorIndexDescription } from '@aws-sdk/client-dynamodb';

// ============================================================
// 定数
// ============================================================

/** Vector_Table の既定のテーブル名（要件 1.1） */
export const DEFAULT_VECTOR_TABLE_NAME = 'kiro-roasters-inventory-vector';

/**
 * 既定の探索対象属性。既存インデックスの `INLINE_FILTER` 要素（要件 5.3 / 5.4、設計 V2）。
 *
 * 値は `amplify/custom/vector-index.ts` の `VECTOR_INDEX_INLINE_FILTER_ATTRIBUTE` と同一である。
 * 当該モジュールは `aws-cdk-lib` を値として import するため、スクリプトからは import せず再掲する。
 */
export const DEFAULT_FILTER_ATTRIBUTE = 'warehouseId';

/**
 * `warehouseId` に投げる既定の境界値。`amplify/functions/shared/types.ts` の `Warehouse`
 * （`WH-TOKYO` / `WH-OSAKA` / `WH-FUKUOKA`）を挟む文字列を選ぶ。
 *
 * 境界値の選び方は判定に影響しない（0 件でもエラーにならない。要件 8.10）。式が受理されるか
 * 拒否されるかだけを見るため、実データを含む範囲を選んで「受理されたが 0 件だった」と
 * 「そもそも受理されなかった」を読み分けやすくしている。
 */
const DEFAULT_STRING_PROBE_VALUES = {
  equality: 'WH-TOKYO',
  lower: 'WH-A',
  upper: 'WH-Z',
  inList: ['WH-TOKYO', 'WH-OSAKA', 'WH-FUKUOKA'],
} as const;

/** `unitPrice` などの数値属性を探索する場合の既定の境界値 */
const DEFAULT_NUMBER_PROBE_VALUES = {
  equality: 1000,
  lower: 500,
  upper: 5000,
  inList: [500, 1000, 5000],
} as const;

/** ベクトル次元数の既定値（要件 3.3 / 5.2）。インデックス定義と一致していないと検証に入れない */
export const DEFAULT_EMBEDDING_DIMENSIONS = 1024;

/**
 * 探索に使う TopK。判定に必要なのは式が受理されるか否かだけなので最小の 1 を使う。
 * `SearchVectors` の消費キャパシティを最小化する意図もある。
 */
export const PROBE_TOP_K = 1;

/** クエリベクトルの既定シード。Bedrock を呼ばずに決定論的なベクトルを作るために使う */
export const DEFAULT_VECTOR_SEED = 20260101;

/** ベクトルインデックスの本数上限（設計 V4）。使い捨てインデックスの余裕を測る基準 */
export const MAX_VECTOR_INDEXES_PER_TABLE = 5;

/** AWS JSON 1.0 プロトコルのターゲットヘッダー値 */
const SEARCH_VECTORS_TARGET = 'DynamoDB_20120810.SearchVectors';

/** レポートの既定の格納先。実行時の CWD からの相対パス */
export const PROBE_REPORT_DIR = 'docs/measurements';

/** レポートのスキーマ版。形が変わったら上げる */
export const PROBE_REPORT_SCHEMA_VERSION = 1;

/** 生レスポンス本文をレポートへ載せる際の最大文字数。要点を保ちつつレポートを肥大させない */
const RAW_BODY_EXCERPT_LIMIT = 2000;

/** ドキュメント間の矛盾内容（要件 18.5 の記載項目）。レポートへそのまま載せる */
export const DOCS_CONFLICT_DESCRIPTION =
  'DynamoDB Vector Search の開発者ガイドは SearchConditionExpression が等価条件（=）のみに対応し ' +
  '比較・範囲・IN は未提供であると記述する。一方 SDK API リファレンスは SearchSchema の HASH 要素が ' +
  '= のみである一方 INLINE_FILTER 要素は比較演算子および範囲演算子に対応すると記述しており、' +
  '両者の記述は矛盾している（前提 A3 / 設計 V3 / Open Question Q1）。';

/** 探索する演算子種別（要件 18.5 の記録単位） */
export const PROBE_OPERATOR_KINDS = ['=', '<', '<=', '>', '>=', 'BETWEEN', 'IN'] as const;

/** 二値確定（要件 18.5）の対象となる範囲演算子。`=` は対照、`IN` は範囲演算子ではない */
export const RANGE_OPERATOR_KINDS = ['<', '<=', '>', '>=', 'BETWEEN'] as const;

// ============================================================
// 型
// ============================================================

/** 演算子種別 */
export type ProbeOperatorKind = (typeof PROBE_OPERATOR_KINDS)[number];

/** 境界の与え方。task 11.5 の「下限のみ / 上限のみ / 両方」に対応する */
export type ProbeBound = 'none' | 'lower' | 'upper' | 'both';

/** 探索対象属性の型。DynamoDB の AttributeValue の型記号に合わせる */
export type ProbeAttributeType = 'S' | 'N';

/** DynamoDB の AttributeValue（JSON 表現）。本スクリプトが組み立てるのは文字列と数値のみ */
type AttributeValueJson = { N: string } | { S: string };

/**
 * `SearchVectors` の入力。
 *
 * SDK の `SearchVectorsInput` を狭めた形（本プローブが必ず送る項目を必須にし、値の型を
 * 文字列・数値の 2 種に絞ったもの）である。レポート JSON へ `request` としてそのまま
 * 載せる形を固定するために局所定義している。**送る項目名は SDK のモデルと一致させること。**
 * ここに実 API に無い項目を足すと、コンパイラの照合を受けずにレポートだけが実態から離れる。
 */
export interface SearchVectorsInput {
  TableName: string;
  IndexName: string;
  SearchVector: AttributeValueJson[];
  TopK: number;
  ProjectionExpression?: string;
  SearchConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, AttributeValueJson>;
  ReturnConsumedCapacity?: 'INDEXES' | 'TOTAL' | 'NONE';
}

/** 1 ケースが送る条件式。属性名と値はバインドで渡す（要件 8.6） */
export interface ProbeCondition {
  expression: string;
  names: Record<string, string>;
  values: Record<string, AttributeValueJson>;
}

/** 探索ケース 1 件。ケースは条件式の形だけを持ち、AWS には依存しない */
export interface ProbeCase {
  /** ケース識別子。レポートと判定の対応付けに使う */
  caseId: string;
  /**
   * このケースが検証する演算子種別。複数を含むケース（`>= AND <=`）は
   * 該当するすべての種別へ結果を寄与する
   */
  kinds: readonly ProbeOperatorKind[];
  bound: ProbeBound;
  /** 対照ケース（等価条件）か。対照が失敗した場合は範囲側の判定を未確定へ落とす */
  control: boolean;
  description: string;
  condition: ProbeCondition;
}

/** 送信結果の生データ。判定はここから純関数で導く */
export interface ProbeTransportResult {
  /** HTTP 状態コード。通信自体が失敗した場合は 0 */
  httpStatus: number;
  /** 応答本文の抜粋。JSON でない場合もそのまま入れる */
  rawBodyExcerpt: string;
  /** サービスが返した例外型（`__type` の `#` 以降）。読めない場合は空文字 */
  errorType: string;
  /** サービスが返したエラーメッセージ。読めない場合は空文字 */
  errorMessage: string;
  /** 成功時の結果件数。失敗時は null */
  resultCount: number | null;
  /** 成功時の `ConsumedCapacity`。失敗時と欠落時は null */
  consumedCapacity: Record<string, unknown> | null;
  /** 通信自体が失敗した場合の説明（DNS / 資格情報 / タイムアウト）。成功・サービスエラー時は null */
  transportError: string | null;
}

/** 1 ケースの結末 */
export type ProbeOutcome =
  /** HTTP 200。式が受理された */
  | 'accepted'
  /** `ValidationException` で拒否された。「非対応」と言えるのはこれのみ */
  | 'rejected_validation'
  /** 別の例外で失敗した（権限・存在しないインデックス・スロットリング等）。未確定 */
  | 'rejected_other'
  /** 通信自体が失敗した。未確定 */
  | 'transport_error'
  /** `--dry-run` のため送信していない */
  | 'skipped';

/** 1 ケースの記録。要求と応答の両方を保持する（要件 18.5） */
export interface ProbeCaseResult {
  caseId: string;
  kinds: readonly ProbeOperatorKind[];
  bound: ProbeBound;
  control: boolean;
  description: string;
  /** 送った `SearchConditionExpression` そのもの */
  searchConditionExpression: string;
  /** 送った要求。ベクトル本体のみ {@link SearchVectorRequestSummary} へ置き換えてある */
  request: RedactedSearchVectorsInput;
  /** 送信していない場合は null */
  response: ProbeTransportResult | null;
  outcome: ProbeOutcome;
}

/** ベクトル本体の代わりにレポートへ載せる要約。1,024 要素の数列でレポートを埋めない */
export interface SearchVectorRequestSummary {
  omitted: true;
  dimensions: number;
  seed: number;
  generator: string;
}

/** レポートへ載せる要求。`SearchVector` のみ要約に差し替える */
export type RedactedSearchVectorsInput = Omit<SearchVectorsInput, 'SearchVector'> & {
  SearchVector: SearchVectorRequestSummary;
};

/** 演算子種別ごとの判定 */
export type ProbeVerdict = 'supported' | 'unsupported' | 'inconclusive';

/** 演算子種別 1 つ分の判定と根拠 */
export interface ProbeKindVerdict {
  kind: ProbeOperatorKind;
  verdict: ProbeVerdict;
  /** 判定の根拠。未確定の場合は何が足りないかを述べる */
  reason: string;
  /** 判定に寄与したケース */
  caseIds: readonly string[];
}

/** 要件 18.5 の二値確定。決められない場合は `未確定` を返す */
export type BinaryRangeVerdict = '対応する' | '対応しない' | '未確定';

/** 探索対象インデックスの状態。`DescribeTable` の読み取り結果（読み取り専用） */
export interface ProbeIndexInspection {
  tableFound: boolean;
  indexFound: boolean;
  indexStatus: string;
  backfilling: boolean;
  /** `IndexStatus === 'ACTIVE'` かつ `Backfilling !== true`（設計 V5、要件 5.15） */
  searchable: boolean;
  /** インデックス定義の次元数。読めない場合は null */
  indexDimensions: number | null;
  /** テーブル上のベクトルインデックス本数 */
  vectorIndexCount: number;
  /** 上限（5 本、設計 V4）に対して残っている本数 */
  remainingIndexSlots: number;
  /** 上限内か */
  withinIndexLimit: boolean;
  /** 検出したインデックス名の一覧（昇順） */
  vectorIndexNames: readonly string[];
  /**
   * `DescribeTable` が返した `VectorIndexDescription.SearchSchema`。探索対象属性が本当に
   * `INLINE_FILTER` 要素かを後から検証できるようにするため、加工せず載せる。
   * 応答に含まれない場合は null
   */
  searchSchema: readonly SearchSchemaElement[] | null;
}

/** 探索条件。レポートの再現性のためすべて記録する */
export interface ProbeTarget {
  region: string;
  endpoint: string;
  tableName: string;
  indexName: string;
  language: VectorLanguage | null;
  filterAttribute: string;
  attributeType: ProbeAttributeType;
  topK: number;
  dimensions: number;
  vectorSeed: number;
  equalityValue: string;
  lowerValue: string;
  upperValue: string;
  inValues: readonly string[];
  dryRun: boolean;
}

/** 使い捨てインデックスの取り扱い（task 11.5 の明示事項） */
export interface DisposableIndexNotice {
  /** 既存の本番インデックスを探索したか（= 使い捨てインデックスが不要だったか） */
  probedExistingIndex: boolean;
  maxVectorIndexesPerTable: number;
  observedVectorIndexCount: number;
  withinIndexLimit: boolean;
  /** 削除の要否と手順 */
  teardownRequirement: string;
}

/** 機械可読なレポート。`docs/vector-search-comparison.md` へ転記する材料（要件 18.5） */
export interface RangeFilterProbeReport {
  schemaVersion: number;
  generatedAt: string;
  /** 実測対象の Open Question */
  openQuestion: 'Q1';
  docsConflict: string;
  target: ProbeTarget;
  index: ProbeIndexInspection | null;
  disposableIndex: DisposableIndexNotice;
  cases: readonly ProbeCaseResult[];
  /** 演算子種別ごとの判定。`PROBE_OPERATOR_KINDS` のすべてを含む */
  verdicts: readonly ProbeKindVerdict[];
  /** 範囲条件の対応可否（要件 18.5 の二値）。決められない場合は `未確定` */
  rangeFilterVerdict: BinaryRangeVerdict;
  /** 二値を真偽値でも出す。`未確定` の場合は null */
  rangeFilterSupported: boolean | null;
  /** 実装既定（等価のみ）を変更すべきか、およびその手順 */
  followUp: string;
  /** 実測時点の `constraints.ts` の値。判定前後の差分を後から突き合わせるために載せる */
  capabilitiesSnapshot: VectorBackendCapabilities;
}

// ============================================================
// クエリベクトル（純関数）
// ============================================================

/**
 * 決定論的な単位ベクトルを作る。
 *
 * 本プローブが見るのは「式が受理されるか」だけであり、検索結果の内容は判定に使わない。
 * したがって Bedrock を呼んで実際の埋め込みを作る必要がなく、埋め込み生成の課金と
 * Query_Vector_Cache への依存を避けられる。
 *
 * 各要素は `Math.fround` で float32 に丸める。インデックス内のベクトルが f32 精度で
 * 保持される（設計 V4）ため、書き込み側と同じ精度で渡す。
 */
export function buildDeterministicQueryVector(dimensions: number, seed: number): number[] {
  const next = createMulberry32(seed);
  const raw: number[] = [];
  let norm = 0;

  for (let i = 0; i < dimensions; i += 1) {
    // -1〜1 の一様乱数
    const value = next() * 2 - 1;
    raw.push(value);
    norm += value * value;
  }

  const scale = norm > 0 ? 1 / Math.sqrt(norm) : 0;
  return raw.map((value) => Math.fround(value * scale));
}

/** 32bit の決定論的擬似乱数（mulberry32）。同一シードで同一列を返す */
function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================
// 探索ケースの生成（純関数）
// ============================================================

/** ケース生成に必要な値。すべて文字列で受け、AttributeValue へは型記号に従って写す */
export interface ProbeCaseValues {
  attribute: string;
  attributeType: ProbeAttributeType;
  equality: string;
  lower: string;
  upper: string;
  inValues: readonly string[];
}

/**
 * 探索ケースを組み立てる（task 11.5 の「下限のみ / 上限のみ / 両方」）。
 *
 * 先頭は対照ケース（等価条件）である。以降は下限のみ（`>` / `>=`）、上限のみ（`<` / `<=`）、
 * 両方（`BETWEEN` と `>= AND <=` の 2 通り）、および `IN` を投げる。
 * 両方の 2 通りを分けているのは、`BETWEEN` が非対応でも比較演算子の連結で
 * 同じ意味を表せる場合があるため。両者は別の記録として残す価値がある。
 */
export function buildProbeCases(values: ProbeCaseValues): readonly ProbeCase[] {
  const name = '#f';
  const names: Record<string, string> = { [name]: values.attribute };
  const toValue = (raw: string): AttributeValueJson => toAttributeValue(raw, values.attributeType);

  const eq = toValue(values.equality);
  const lo = toValue(values.lower);
  const hi = toValue(values.upper);

  const inNames = values.inValues.map((_, index) => `:in${index}`);
  const inValues: Record<string, AttributeValueJson> = {};
  values.inValues.forEach((raw, index) => {
    inValues[inNames[index]] = toValue(raw);
  });

  return [
    {
      caseId: 'control-equality',
      kinds: ['='],
      bound: 'none',
      control: true,
      description:
        '対照ケース。等価条件は開発者ガイドと SDK API リファレンスの双方が対応と記述しており、' +
        'これが失敗する場合は探索対象属性が INLINE_FILTER 要素でないか、インデックスが検索可能状態でない。',
      condition: { expression: `${name} = :eq`, names, values: { ':eq': eq } },
    },
    {
      caseId: 'lower-only-greater-than',
      kinds: ['>'],
      bound: 'lower',
      control: false,
      description: '下限のみ（境界を含まない比較演算子）。',
      condition: { expression: `${name} > :lo`, names, values: { ':lo': lo } },
    },
    {
      caseId: 'lower-only-greater-than-or-equal',
      kinds: ['>='],
      bound: 'lower',
      control: false,
      description: '下限のみ（境界を含む比較演算子）。',
      condition: { expression: `${name} >= :lo`, names, values: { ':lo': lo } },
    },
    {
      caseId: 'upper-only-less-than',
      kinds: ['<'],
      bound: 'upper',
      control: false,
      description: '上限のみ（境界を含まない比較演算子）。',
      condition: { expression: `${name} < :hi`, names, values: { ':hi': hi } },
    },
    {
      caseId: 'upper-only-less-than-or-equal',
      kinds: ['<='],
      bound: 'upper',
      control: false,
      description: '上限のみ（境界を含む比較演算子）。',
      condition: { expression: `${name} <= :hi`, names, values: { ':hi': hi } },
    },
    {
      caseId: 'both-bounds-between',
      kinds: ['BETWEEN'],
      bound: 'both',
      control: false,
      description: '両方（BETWEEN 演算子）。',
      condition: {
        expression: `${name} BETWEEN :lo AND :hi`,
        names,
        values: { ':lo': lo, ':hi': hi },
      },
    },
    {
      caseId: 'both-bounds-compound',
      kinds: ['>=', '<='],
      bound: 'both',
      control: false,
      description:
        '両方（比較演算子 2 つの AND 連結）。BETWEEN が非対応でもこの形が通る可能性があるため別ケースとして投げる。',
      condition: {
        expression: `${name} >= :lo AND ${name} <= :hi`,
        names,
        values: { ':lo': lo, ':hi': hi },
      },
    },
    {
      caseId: 'membership-in',
      kinds: ['IN'],
      bound: 'none',
      control: false,
      description:
        'IN 演算子。範囲演算子ではないが、開発者ガイドが「未提供」と名指ししている演算子であるため併せて記録する。',
      condition: {
        expression: `${name} IN (${inNames.join(', ')})`,
        names,
        values: inValues,
      },
    },
  ];
}

/** 文字列表現の値を AttributeValue へ写す。数値型は表現をそのまま渡す（DynamoDB は数値も文字列で受ける） */
function toAttributeValue(raw: string, type: ProbeAttributeType): AttributeValueJson {
  return type === 'N' ? { N: raw } : { S: raw };
}

// ============================================================
// 要求の組み立て（純関数）
// ============================================================

/** 要求を組み立てるための文脈 */
export interface SearchInputContext {
  tableName: string;
  indexName: string;
  searchVector: readonly AttributeValueJson[];
  topK: number;
}

/**
 * 1 ケース分の `SearchVectors` 入力を組み立てる。
 *
 * `ProjectionExpression` は付けない。判定に結果の中身を使わないため、射影を省いて
 * 応答サイズと消費キャパシティを最小に保つ。ベクトル属性は射影対象ではないので、
 * 射影を省いてもベクトルが返ることはない。
 */
export function buildSearchInput(probe: ProbeCase, context: SearchInputContext): SearchVectorsInput {
  return {
    TableName: context.tableName,
    IndexName: context.indexName,
    SearchVector: context.searchVector.slice(),
    TopK: context.topK,
    SearchConditionExpression: probe.condition.expression,
    ExpressionAttributeNames: { ...probe.condition.names },
    ExpressionAttributeValues: { ...probe.condition.values },
    ReturnConsumedCapacity: 'INDEXES',
  };
}

/** レポート用にベクトル本体を要約へ差し替える。要求のそれ以外の項目は改変しない */
export function redactSearchInput(
  input: SearchVectorsInput,
  summary: SearchVectorRequestSummary
): RedactedSearchVectorsInput {
  const { SearchVector: _omitted, ...rest } = input;
  return { ...rest, SearchVector: summary };
}

// ============================================================
// 判定（純関数）
// ============================================================

/** 送信結果を結末へ分類する。「非対応」と言えるのは `ValidationException` のみ */
export function classifyProbeOutcome(result: ProbeTransportResult | null): ProbeOutcome {
  if (result === null) return 'skipped';
  if (result.transportError !== null) return 'transport_error';
  if (result.httpStatus >= 200 && result.httpStatus < 300) return 'accepted';
  return result.errorType === 'ValidationException' ? 'rejected_validation' : 'rejected_other';
}

/**
 * 演算子種別ごとの判定を集約する。
 *
 * 当該種別に寄与するケースがすべて受理されたなら `supported`、すべて `ValidationException` で
 * 拒否されたなら `unsupported`、それ以外（混在・別エラー・未送信）は `inconclusive` とする。
 * 混在を `inconclusive` にするのは、同一種別で結果が割れる場合に「対応する / しない」の
 * どちらを書いても実測と食い違うためである。
 */
export function aggregateKindVerdict(
  kind: ProbeOperatorKind,
  results: readonly ProbeCaseResult[]
): ProbeKindVerdict {
  const related = results.filter((result) => result.kinds.indexOf(kind) >= 0);
  const caseIds = related.map((result) => result.caseId);

  if (related.length === 0) {
    return { kind, verdict: 'inconclusive', reason: '当該種別を検証したケースがない。', caseIds };
  }

  if (related.every((result) => result.outcome === 'skipped')) {
    return {
      kind,
      verdict: 'inconclusive',
      reason: '要求を送信していない（--dry-run）ため判定していない。',
      caseIds,
    };
  }

  const accepted = related.filter((result) => result.outcome === 'accepted');
  const rejected = related.filter((result) => result.outcome === 'rejected_validation');

  if (accepted.length === related.length) {
    return {
      kind,
      verdict: 'supported',
      reason: `${related.length} 件のケースすべてが HTTP 200 で受理された。`,
      caseIds,
    };
  }

  if (rejected.length === related.length) {
    return {
      kind,
      verdict: 'unsupported',
      reason: `${related.length} 件のケースすべてが ValidationException で拒否された（${describeErrorMessages(related)}）。`,
      caseIds,
    };
  }

  return {
    kind,
    verdict: 'inconclusive',
    reason:
      `結末が一様でない（受理 ${accepted.length} 件 / ValidationException ${rejected.length} 件 / ` +
      `その他 ${related.length - accepted.length - rejected.length} 件）。` +
      'ValidationException 以外の失敗は演算子の対応可否を示さないため未確定とする。',
    caseIds,
  };
}

/**
 * 対照ケースの結果で範囲側の判定を検閲する。
 *
 * 等価条件が通らない環境では、範囲条件の拒否は演算子の非対応を意味しない
 * （属性が `INLINE_FILTER` 要素でない / インデックスが検索不可 / 権限不足 等）。
 * その場合は範囲側をすべて `inconclusive` へ落とし、理由に対照の失敗を明記する。
 */
export function applyControlGate(
  verdicts: readonly ProbeKindVerdict[],
  results: readonly ProbeCaseResult[]
): readonly ProbeKindVerdict[] {
  const control = results.filter((result) => result.control);
  const controlPassed = control.length > 0 && control.every((result) => result.outcome === 'accepted');
  // 1 件も送っていない場合（`--dry-run`）は各種別が既に「未送信」と述べているため検閲しない
  const allSkipped = results.length > 0 && results.every((result) => result.outcome === 'skipped');
  if (controlPassed || allSkipped) return verdicts;

  const controlSummary =
    control.length === 0
      ? '対照ケースが実行されていない。'
      : `対照ケース（等価条件）が受理されなかった（${control
          .map((result) => `${result.caseId}: ${result.outcome}`)
          .join(' / ')}）。`;

  return verdicts.map((entry) =>
    entry.kind === '='
      ? entry
      : {
          kind: entry.kind,
          verdict: 'inconclusive' as ProbeVerdict,
          reason:
            `${controlSummary}探索対象属性が INLINE_FILTER 要素でない、インデックスが検索可能状態でない、` +
            'または権限不足の可能性があり、この状態の拒否は演算子の非対応を意味しない。' +
            `（本ケースの単独結果: ${entry.verdict} / ${entry.reason}）`,
          caseIds: entry.caseIds,
        }
  );
}

/** 演算子種別ごとの判定をすべて求める（対照ケースの検閲込み） */
export function buildVerdicts(results: readonly ProbeCaseResult[]): readonly ProbeKindVerdict[] {
  const raw = PROBE_OPERATOR_KINDS.map((kind) => aggregateKindVerdict(kind, results));
  return applyControlGate(raw, results);
}

/**
 * 範囲条件の対応可否を二値で確定する（要件 18.5）。
 *
 * 範囲演算子（`<` / `<=` / `>` / `>=` / `BETWEEN`）のすべてが `supported` なら「対応する」、
 * すべてが `unsupported` なら「対応しない」、それ以外は「未確定」とする。
 * 二値に丸められない結果を無理に丸めると Verification_Report が実測と食い違うため、
 * 第 3 の値を持たせている（未確定の場合は矛盾内容のみを記録する。task 13.16 の指示に沿う）。
 */
export function decideRangeFilterVerdict(
  verdicts: readonly ProbeKindVerdict[]
): { verdict: BinaryRangeVerdict; supported: boolean | null } {
  const rangeVerdicts = RANGE_OPERATOR_KINDS.map(
    (kind) => verdicts.find((entry) => entry.kind === kind)?.verdict ?? 'inconclusive'
  );

  if (rangeVerdicts.every((verdict) => verdict === 'supported')) {
    return { verdict: '対応する', supported: true };
  }
  if (rangeVerdicts.every((verdict) => verdict === 'unsupported')) {
    return { verdict: '対応しない', supported: false };
  }
  return { verdict: '未確定', supported: null };
}

/** 実測結果を受けて実装をどう扱うかの指示文。レポートへ載せる */
export function buildFollowUp(verdict: BinaryRangeVerdict): string {
  switch (verdict) {
    case '対応する':
      return (
        'amplify/functions/shared/vector/constraints.ts の DYNAMODB_VECTOR_CAPABILITIES.supportedFilterKinds へ ' +
        "'range' を追加し、filterKindsUnverified を削除する。UI の機能制約比較表は固定値を持たず " +
        'GET /vector-search/capabilities の応答のみを描画するため自動的に追従し、vector-search-ddb の ' +
        '範囲条件拒否（要件 8.7）も同一定数を参照しているため同時に解除される。'
      );
    case '対応しない':
      return (
        'constraints.ts は現状のまま（supportedFilterKinds は equality のみ）で正しい。filterKindsUnverified の ' +
        '文面を「実測で非対応を確認済み」へ更新し、本レポートの ValidationException のメッセージを ' +
        'docs/vector-search-comparison.md へ転記する。'
      );
    default:
      return (
        'constraints.ts は変更しない。docs/vector-search-comparison.md には「未実測 / 未確定」と ' +
        'ドキュメント間の矛盾内容、および本レポートの各ケースの結末を記録する（task 13.16 の指示）。' +
        '未確定の主因が対照ケースの失敗である場合は、探索対象インデックスの SearchSchema と ' +
        'IndexStatus / Backfilling を確認してから再実行する。'
      );
  }
}

/** 使い捨てインデックスの取り扱いを組み立てる（task 11.5 の明示事項） */
export function buildDisposableIndexNotice(
  target: ProbeTarget,
  inspection: ProbeIndexInspection | null
): DisposableIndexNotice {
  const probedExistingIndex = target.language !== null;
  const observedVectorIndexCount = inspection?.vectorIndexCount ?? 0;

  return {
    probedExistingIndex,
    maxVectorIndexesPerTable: MAX_VECTOR_INDEXES_PER_TABLE,
    observedVectorIndexCount,
    withinIndexLimit: inspection?.withinIndexLimit ?? true,
    teardownRequirement: probedExistingIndex
      ? `探索対象は既存の本番インデックス（${target.indexName}）であり、使い捨てインデックスを作成していない。` +
        '削除作業は不要である。'
      : `探索対象 ${target.indexName} が使い捨て検証用インデックスである場合、測定後に削除すること。` +
        `削除は UpdateTable の VectorIndexUpdates（1 回 1 本）で行う。ベクトルインデックスは ` +
        `テーブルあたり最大 ${MAX_VECTOR_INDEXES_PER_TABLE} 本（設計 V4）であり、` +
        `現在 ${observedVectorIndexCount} 本を検出している。残置するとストレージ課金が継続する。`,
  };
}

// ============================================================
// レポート（純関数）
// ============================================================

/** レポートファイル名。実行時刻を含めて上書きを避ける */
export function probeReportFileName(generatedAt: string): string {
  return `range-filter-probe-${generatedAt.replace(/[:.]/g, '-')}.json`;
}

/** レポートを組み立てる */
export function buildProbeReport(input: {
  generatedAt: string;
  target: ProbeTarget;
  index: ProbeIndexInspection | null;
  cases: readonly ProbeCaseResult[];
}): RangeFilterProbeReport {
  const verdicts = buildVerdicts(input.cases);
  const decision = decideRangeFilterVerdict(verdicts);

  return {
    schemaVersion: PROBE_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    openQuestion: 'Q1',
    docsConflict: DOCS_CONFLICT_DESCRIPTION,
    target: input.target,
    index: input.index,
    disposableIndex: buildDisposableIndexNotice(input.target, input.index),
    cases: input.cases,
    verdicts,
    rangeFilterVerdict: decision.verdict,
    rangeFilterSupported: decision.supported,
    followUp: buildFollowUp(decision.verdict),
    capabilitiesSnapshot: getVectorCapabilities('dynamodb'),
  };
}

/** 人が読む要約。判定表と各ケースの結末を 1 画面に収める */
export function formatProbeSummary(report: RangeFilterProbeReport): string {
  const lines: string[] = [];

  lines.push('=== 範囲フィルタ実測プローブ（Open Question Q1 / 要件 18.5） ===');
  lines.push(`実行時刻: ${report.generatedAt}`);
  lines.push(
    `対象: table=${report.target.tableName} index=${report.target.indexName} ` +
      `attribute=${report.target.filterAttribute}(${report.target.attributeType}) ` +
      `topK=${report.target.topK} region=${report.target.region}`
  );
  lines.push(`エンドポイント: ${report.target.endpoint}${report.target.dryRun ? '（未送信 / --dry-run）' : ''}`);

  if (report.index !== null) {
    lines.push(
      `インデックス状態: found=${report.index.indexFound} status=${report.index.indexStatus || '不明'} ` +
        `backfilling=${report.index.backfilling} searchable=${report.index.searchable} ` +
        `ベクトルインデックス ${report.index.vectorIndexCount}/${MAX_VECTOR_INDEXES_PER_TABLE} 本`
    );
  }

  lines.push('');
  lines.push('--- ケースごとの結末 ---');
  report.cases.forEach((result) => {
    const detail =
      result.response === null
        ? '（未送信）'
        : result.response.transportError !== null
          ? `通信失敗: ${result.response.transportError}`
          : result.outcome === 'accepted'
            ? `HTTP ${result.response.httpStatus} / 結果 ${result.response.resultCount ?? 0} 件`
            : `HTTP ${result.response.httpStatus} / ${result.response.errorType || '型不明'}: ${result.response.errorMessage}`;
    lines.push(
      `[${result.outcome}] ${result.caseId} (${result.bound}) ${result.searchConditionExpression} -> ${detail}`
    );
  });

  lines.push('');
  lines.push('--- 演算子種別ごとの判定 ---');
  report.verdicts.forEach((entry) => {
    lines.push(`${entry.kind.padEnd(8)} ${entry.verdict}  ${entry.reason}`);
  });

  lines.push('');
  lines.push(`範囲条件の対応可否（二値確定）: ${report.rangeFilterVerdict}`);
  lines.push(`次の対応: ${report.followUp}`);
  lines.push(`使い捨てインデックス: ${report.disposableIndex.teardownRequirement}`);

  return lines.join('\n');
}

/** `ValidationException` のメッセージを判定理由へ載せる形へ整える */
function describeErrorMessages(results: readonly ProbeCaseResult[]): string {
  const messages: string[] = [];
  results.forEach((result) => {
    const message = result.response?.errorMessage ?? '';
    if (message.length > 0 && messages.indexOf(message) < 0) {
      messages.push(message);
    }
  });
  return messages.length === 0 ? 'メッセージなし' : messages.join(' | ');
}

// ============================================================
// I/O 境界
// ============================================================

/** `SearchVectors` の送信経路。AWS へ触るのはこの実装のみ */
export interface SearchVectorsTransport {
  send(input: SearchVectorsInput): Promise<ProbeTransportResult>;
}

/** 探索対象インデックスの状態を読む経路（`DescribeTable`、読み取り専用） */
export interface VectorIndexInspector {
  inspect(tableName: string, indexName: string): Promise<ProbeIndexInspection>;
}

/** レポートの書き出し経路 */
export interface ProbeReportWriter {
  write(fileName: string, contents: string): Promise<void>;
}

/** 資格情報とリージョンの解決結果 */
interface AwsContext {
  region: string;
  endpoint: string;
  transport: SearchVectorsTransport;
  inspector: VectorIndexInspector;
  /** 解放。SDK クライアントのソケットを閉じる */
  close(): void;
}

/**
 * 署名付き HTTP で `SearchVectors` を送る実装と `DescribeTable` の読み取り実装を作る。
 *
 * SDK は遅延 import する。純計算だけを使う呼び出し側（単体テストを含む）に
 * AWS SDK の読み込みと資格情報の解決を強いない。
 */
export async function createAwsContext(options: {
  region?: string;
  endpoint?: string;
}): Promise<AwsContext> {
  const [{ DynamoDBClient, DescribeTableCommand }, { SignatureV4 }, { HttpRequest }, { Sha256 }] =
    await Promise.all([
      import('@aws-sdk/client-dynamodb'),
      import('@smithy/signature-v4'),
      import('@smithy/protocol-http'),
      import('@aws-crypto/sha256-js'),
    ]);

  const client = new DynamoDBClient(options.region === undefined ? {} : { region: options.region });
  const region = options.region ?? (await client.config.region());
  // ベクトル検索は専用エンドポイントを使う（通常の DynamoDB エンドポイントとは別）。
  // アカウント ID を含む形式（`<account-id>.search-ddb.<region>.amazonaws.com`）は採らない
  const endpoint = options.endpoint ?? `https://search-dynamodb.${region}.api.aws`;

  const signer = new SignatureV4({
    service: 'dynamodb',
    region,
    credentials: client.config.credentials,
    sha256: Sha256,
  });

  const transport: SearchVectorsTransport = {
    async send(input: SearchVectorsInput): Promise<ProbeTransportResult> {
      const url = new URL(endpoint);
      const body = JSON.stringify(input);

      const request = new HttpRequest({
        method: 'POST',
        protocol: url.protocol.replace(':', ''),
        hostname: url.hostname,
        port: url.port.length > 0 ? Number(url.port) : undefined,
        path: '/',
        headers: {
          host: url.host,
          'content-type': 'application/x-amz-json-1.0',
          'x-amz-target': SEARCH_VECTORS_TARGET,
        },
        body,
      });

      let httpStatus = 0;
      let text = '';
      try {
        const signed = await signer.sign(request);
        const response = await fetch(`${url.origin}/`, {
          method: 'POST',
          headers: signed.headers,
          body,
        });
        httpStatus = response.status;
        text = await response.text();
      } catch (error) {
        // 署名・DNS・接続・資格情報解決の失敗。演算子の対応可否は判定できない
        return {
          httpStatus: 0,
          rawBodyExcerpt: '',
          errorType: '',
          errorMessage: '',
          resultCount: null,
          consumedCapacity: null,
          transportError: describeError(error),
        };
      }

      return readTransportResult(httpStatus, text);
    },
  };

  const inspector: VectorIndexInspector = {
    async inspect(tableName: string, indexName: string): Promise<ProbeIndexInspection> {
      try {
        const response = await client.send(new DescribeTableCommand({ TableName: tableName }));
        return readIndexInspection(response.Table, indexName);
      } catch (error) {
        if (isResourceNotFound(error)) {
          return emptyIndexInspection(false);
        }
        throw error;
      }
    },
  };

  return { region, endpoint, transport, inspector, close: () => client.destroy() };
}

/** ファイルシステムへレポートを書く実装。`node:fs/promises` は遅延 import する */
export function createFileSystemReportWriter(baseDir: string = PROBE_REPORT_DIR): ProbeReportWriter {
  return {
    async write(fileName: string, contents: string): Promise<void> {
      const [fs, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
      await fs.mkdir(baseDir, { recursive: true });
      await fs.writeFile(path.join(baseDir, fileName), contents, 'utf8');
    },
  };
}

/** 書き出しを行わない実装（`--no-write`） */
export function createNoopReportWriter(): ProbeReportWriter {
  return { write: async () => undefined };
}

/** HTTP 応答を {@link ProbeTransportResult} へ写す（純関数） */
export function readTransportResult(httpStatus: number, rawBody: string): ProbeTransportResult {
  const excerpt = rawBody.slice(0, RAW_BODY_EXCERPT_LIMIT);
  const parsed = tryParseJsonObject(rawBody);

  if (httpStatus >= 200 && httpStatus < 300) {
    const results = parsed?.SearchResults;
    return {
      httpStatus,
      rawBodyExcerpt: excerpt,
      errorType: '',
      errorMessage: '',
      resultCount: Array.isArray(results) ? results.length : 0,
      consumedCapacity: asRecord(parsed?.ConsumedCapacity) ?? null,
      transportError: null,
    };
  }

  const rawType = parsed?.__type ?? parsed?.code;
  const errorType =
    typeof rawType === 'string'
      ? rawType.includes('#')
        ? rawType.slice(rawType.lastIndexOf('#') + 1)
        : rawType
      : '';
  const rawMessage = parsed?.message ?? parsed?.Message;

  return {
    httpStatus,
    rawBodyExcerpt: excerpt,
    errorType,
    errorMessage: typeof rawMessage === 'string' ? rawMessage : '',
    resultCount: null,
    consumedCapacity: null,
    transportError: null,
  };
}

/**
 * `DescribeTable` の応答から探索対象インデックスの状態を読む（純関数）。
 *
 * 読むキーは `TableDescription.VectorIndexes` の 1 つのみである。SDK のモデルでは
 * `VectorIndexes?: VectorIndexDescription[]` という**複数形の配列**であり、単数形のキーや
 * 単一オブジェクトで返る経路は存在しない。以前あった揺れの許容は SDK にモデルが無く
 * 応答の形を推測していた時期の産物であり、実 API の形と一致しないため取り除いた（設計 V5 / V6）。
 *
 * `vector-search-ddb/handler.ts` の `readVectorIndexDescriptions()` と同一の読み取りだが、
 * 当該モジュールを import しない。あちらはモジュール読み込み時に `DynamoDBClient` を生成し
 * 環境変数から次元数を確定する（副作用がある）ため、SDK を遅延 import して純計算のみを
 * テストできる本スクリプトの構造が崩れる。`measure.ts` の `readVectorIndexStates()` も
 * 同じ理由で同じ読み取りを持つ。
 *
 * `table` は遅延 import した SDK の応答を `unknown` として受けるため、
 * 配列であることの確認だけは実行時にも行う。
 */
export function readIndexInspection(table: unknown, indexName: string): ProbeIndexInspection {
  const record = asRecord(table);
  if (record === undefined) return emptyIndexInspection(false);

  const raw = record.VectorIndexes;
  const descriptions: VectorIndexDescription[] = Array.isArray(raw)
    ? (raw as VectorIndexDescription[])
    : [];

  const names = descriptions
    .map((description) => (typeof description.IndexName === 'string' ? description.IndexName : ''))
    .filter((name) => name.length > 0)
    .sort();

  const target = descriptions.find((description) => description.IndexName === indexName);
  const indexStatus = typeof target?.IndexStatus === 'string' ? target.IndexStatus : '';
  const backfilling = target?.Backfilling === true;
  // `VectorIndexDescription.Dimensions` は数値である（文字列で返る経路はない）
  const dimensions = target?.Dimensions;

  return {
    tableFound: true,
    indexFound: target !== undefined,
    indexStatus,
    backfilling,
    // 設計 V5: `BACKFILLING` というステータス値は存在しない。ACTIVE と Backfilling の組で判定する
    searchable: indexStatus === 'ACTIVE' && !backfilling,
    indexDimensions: typeof dimensions === 'number' && Number.isFinite(dimensions) ? dimensions : null,
    vectorIndexCount: descriptions.length,
    remainingIndexSlots: Math.max(0, MAX_VECTOR_INDEXES_PER_TABLE - descriptions.length),
    withinIndexLimit: descriptions.length <= MAX_VECTOR_INDEXES_PER_TABLE,
    vectorIndexNames: names,
    searchSchema: target?.SearchSchema ?? null,
  };
}

function emptyIndexInspection(tableFound: boolean): ProbeIndexInspection {
  return {
    tableFound,
    indexFound: false,
    indexStatus: '',
    backfilling: false,
    searchable: false,
    indexDimensions: null,
    vectorIndexCount: 0,
    remainingIndexSlots: MAX_VECTOR_INDEXES_PER_TABLE,
    withinIndexLimit: true,
    vectorIndexNames: [],
    searchSchema: null,
  };
}

// ============================================================
// 実行（I/O は注入で受ける）
// ============================================================

/** プローブ実行の入力。AWS へ触る経路はすべて注入される */
export interface RunProbeOptions {
  target: ProbeTarget;
  /**
   * `SearchVectors` の送信経路。`target.dryRun` が真のときは 1 度も呼ばれないため省略できる。
   * 偽のときに省略した場合は例外にする（黙って何も送らずに「未確定」を出さない）
   */
  transport?: SearchVectorsTransport;
  /** 省略時はインデックス状態を読まない（`--dry-run` など） */
  inspector?: VectorIndexInspector;
  generatedAt?: string;
}

/**
 * 探索ケースを 1 件ずつ順に投げてレポートを返す。
 *
 * 並行送信しない。スロットリングで `ThrottlingException` が返ると
 * `ValidationException` との区別はつくものの当該ケースが未確定になり、
 * 判定全体が `inconclusive` へ落ちるため、8 回の逐次呼び出しに留める。
 */
export async function runRangeFilterProbe(
  options: RunProbeOptions
): Promise<RangeFilterProbeReport> {
  const { target, transport } = options;
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  if (!target.dryRun && transport === undefined) {
    throw new Error(
      '送信経路（transport）が指定されていません。実測する場合は createAwsContext() の transport を渡すか、' +
        'target.dryRun を真にしてください。'
    );
  }

  const inspection =
    options.inspector === undefined
      ? null
      : await options.inspector.inspect(target.tableName, target.indexName);

  const searchVector = buildDeterministicQueryVector(target.dimensions, target.vectorSeed).map(
    (element) => ({ N: String(element) }) as AttributeValueJson
  );
  const vectorSummary: SearchVectorRequestSummary = {
    omitted: true,
    dimensions: target.dimensions,
    seed: target.vectorSeed,
    generator: 'mulberry32 / 単位ベクトルへ正規化後に float32 へ丸め',
  };

  const cases = buildProbeCases({
    attribute: target.filterAttribute,
    attributeType: target.attributeType,
    equality: target.equalityValue,
    lower: target.lowerValue,
    upper: target.upperValue,
    inValues: target.inValues,
  });

  const results: ProbeCaseResult[] = [];

  for (let i = 0; i < cases.length; i += 1) {
    const probe = cases[i];
    const input = buildSearchInput(probe, {
      tableName: target.tableName,
      indexName: target.indexName,
      searchVector,
      topK: target.topK,
    });

    // `--dry-run` では 1 件も送らない。要求の形だけをレポートへ残す
    const response = target.dryRun || transport === undefined ? null : await transport.send(input);

    results.push({
      caseId: probe.caseId,
      kinds: probe.kinds,
      bound: probe.bound,
      control: probe.control,
      description: probe.description,
      searchConditionExpression: probe.condition.expression,
      request: redactSearchInput(input, vectorSummary),
      response,
      outcome: classifyProbeOutcome(response),
    });
  }

  return buildProbeReport({ generatedAt, target, index: inspection, cases: results });
}

// ============================================================
// CLI
// ============================================================

/** コマンドライン引数の解釈結果 */
export interface ProbeCliOptions {
  tableName: string;
  /** `--index` 指定時は null（使い捨てインデックスを直接指定した場合） */
  language: VectorLanguage | null;
  indexName: string;
  filterAttribute: string;
  attributeType: ProbeAttributeType;
  equalityValue: string;
  lowerValue: string;
  upperValue: string;
  inValues: readonly string[];
  dimensions: number;
  topK: number;
  vectorSeed: number;
  region?: string;
  endpoint?: string;
  dryRun: boolean;
  write: boolean;
  outputDir: string;
  /** レポート JSON を標準出力へ出すか */
  printJson: boolean;
}

/** 引数の解釈に失敗した状態。使用法を添えて終了する */
export class ProbeArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeArgumentError';
  }
}

/**
 * `--key value` 形式の引数を解釈する（純関数）。
 *
 * 属性の型（`S` / `N`）に応じて境界値の既定を切り替える。`--attribute` を既定以外へ
 * 変更した場合は `--index` の指定を必須にする。既定のインデックスは `warehouseId` しか
 * `INLINE_FILTER` に持たないため、別属性を既定インデックスへ投げると対照ケースが失敗し、
 * 判定が未確定になるだけで何も分からないからである。
 */
export function parseProbeArgs(argv: readonly string[]): ProbeCliOptions {
  const flags = new Map<string, string>();
  const booleans = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      throw new ProbeArgumentError(`解釈できない引数: ${token}`);
    }
    const key = token.slice(2);
    if (key === 'dry-run' || key === 'no-write' || key === 'json' || key === 'help') {
      booleans.add(key);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ProbeArgumentError(`--${key} には値が必要です。`);
    }
    flags.set(key, value);
    i += 1;
  }

  if (booleans.has('help')) {
    throw new ProbeArgumentError('使用法を表示します。');
  }

  const rawLanguage = flags.get('language') ?? 'ja';
  if (!isVectorLanguage(rawLanguage)) {
    throw new ProbeArgumentError(
      `--language は ${VECTOR_LANGUAGES.join(' / ')} のいずれかです（指定値: ${rawLanguage}）。`
    );
  }

  const explicitIndex = flags.get('index');
  const attributeType = parseAttributeType(flags.get('attribute-type'));
  const filterAttribute = flags.get('attribute') ?? DEFAULT_FILTER_ATTRIBUTE;

  if (filterAttribute !== DEFAULT_FILTER_ATTRIBUTE && explicitIndex === undefined) {
    throw new ProbeArgumentError(
      `--attribute ${filterAttribute} を探索するには --index で当該属性を INLINE_FILTER に含む ` +
        `インデックスを指定してください。既定のインデックスは ${DEFAULT_FILTER_ATTRIBUTE} のみを ` +
        'INLINE_FILTER に持つため、別属性では対照ケース（等価条件）が失敗し判定が未確定になります。'
    );
  }

  const defaults = attributeType === 'N' ? DEFAULT_NUMBER_PROBE_VALUES : DEFAULT_STRING_PROBE_VALUES;
  const dimensions = parsePositiveInteger(flags.get('dimensions'), DEFAULT_EMBEDDING_DIMENSIONS, 'dimensions');
  const validated = validateDimensions(dimensions, 'dynamodb');
  if (!validated.ok) {
    throw new ProbeArgumentError(validated.message);
  }

  const topK = parsePositiveInteger(flags.get('topk'), PROBE_TOP_K, 'topk');
  if (!isValidTopK(topK)) {
    throw new ProbeArgumentError(`--topk は 1 以上 100 以下の整数です（指定値: ${topK}）。`);
  }

  const inValues = (flags.get('in') ?? defaults.inList.map(String).join(','))
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (inValues.length === 0) {
    throw new ProbeArgumentError('--in には 1 件以上の値をカンマ区切りで指定してください。');
  }

  return {
    tableName: flags.get('table') ?? DEFAULT_VECTOR_TABLE_NAME,
    language: explicitIndex === undefined ? rawLanguage : null,
    indexName: explicitIndex ?? resolveIndexName(rawLanguage),
    filterAttribute,
    attributeType,
    equalityValue: flags.get('equals') ?? String(defaults.equality),
    lowerValue: flags.get('lower') ?? String(defaults.lower),
    upperValue: flags.get('upper') ?? String(defaults.upper),
    inValues,
    dimensions: validated.dimensions,
    topK,
    vectorSeed: parsePositiveInteger(flags.get('seed'), DEFAULT_VECTOR_SEED, 'seed'),
    region: flags.get('region'),
    endpoint: flags.get('endpoint'),
    dryRun: booleans.has('dry-run'),
    write: !booleans.has('no-write'),
    outputDir: flags.get('out') ?? PROBE_REPORT_DIR,
    printJson: booleans.has('json'),
  };
}

function parseAttributeType(raw: string | undefined): ProbeAttributeType {
  if (raw === undefined) return 'S';
  if (raw === 'S' || raw === 'N') return raw;
  throw new ProbeArgumentError(`--attribute-type は S または N です（指定値: ${raw}）。`);
}

function parsePositiveInteger(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ProbeArgumentError(`--${label} は正の整数です（指定値: ${raw}）。`);
  }
  return parsed;
}

/** 使用法。引数エラー時と `--help` で出す */
export const PROBE_USAGE = [
  '範囲フィルタ実測プローブ（Open Question Q1 / 要件 18.5）',
  '',
  '使用法: npm run vector:probe-range -- [オプション]',
  '',
  '  --language <ja|en>        探索する既存インデックスの言語（既定: ja）',
  '  --index <name>            探索するインデックス名を直接指定する（使い捨て検証用インデックス）',
  '  --table <name>            テーブル名（既定: ' + DEFAULT_VECTOR_TABLE_NAME + '）',
  '  --attribute <name>        探索する INLINE_FILTER 属性（既定: ' + DEFAULT_FILTER_ATTRIBUTE + '）',
  '  --attribute-type <S|N>    属性の型（既定: S）',
  '  --equals <value>          対照ケース（等価条件）の値',
  '  --lower <value>           下限値',
  '  --upper <value>           上限値',
  '  --in <v1,v2,...>          IN 演算子に渡す値',
  '  --dimensions <n>          クエリベクトルの次元数（既定: ' + DEFAULT_EMBEDDING_DIMENSIONS + '）',
  '  --topk <n>                TopK（既定: ' + PROBE_TOP_K + '）',
  '  --seed <n>                クエリベクトルのシード（既定: ' + DEFAULT_VECTOR_SEED + '）',
  '  --region <region>         リージョン（既定: 既定の資格情報チェーンから解決）',
  '  --endpoint <url>          ベクトル検索エンドポイントの上書き',
  '  --dry-run                 AWS へ送らず、送信予定の要求のみを記録する',
  '  --no-write                レポートファイルを書き出さない',
  '  --json                    レポート JSON を標準出力へ出す',
  '  --help                    この使用法を表示する',
  '',
  '本スクリプトは読み取り専用である（DescribeTable と SearchVectors のみ）。',
  'インデックスの作成・削除・データ書き込みは行わない。使い捨て検証用インデックスを',
  '使う場合は、テーブルあたり上限 ' + MAX_VECTOR_INDEXES_PER_TABLE + ' 本の範囲内であることを確認し、測定後に削除すること。',
].join('\n');

/**
 * エントリポイント。
 *
 * `tsx` はスクリプトを CJS として実行するためトップレベル `await` が使えない。
 * したがって非同期処理は `main()` に閉じ、末尾で呼び出す。
 */
async function main(): Promise<void> {
  let options: ProbeCliOptions;
  try {
    options = parseProbeArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof ProbeArgumentError ? error.message : describeError(error));
    console.error('');
    console.error(PROBE_USAGE);
    process.exitCode = 1;
    return;
  }

  const aws = options.dryRun ? null : await createAwsContext(options);

  try {
    const target: ProbeTarget = {
      region: aws?.region ?? options.region ?? '(未解決 / --dry-run)',
      endpoint: aws?.endpoint ?? options.endpoint ?? '(未解決 / --dry-run)',
      tableName: options.tableName,
      indexName: options.indexName,
      language: options.language,
      filterAttribute: options.filterAttribute,
      attributeType: options.attributeType,
      topK: options.topK,
      dimensions: options.dimensions,
      vectorSeed: options.vectorSeed,
      equalityValue: options.equalityValue,
      lowerValue: options.lowerValue,
      upperValue: options.upperValue,
      inValues: options.inValues,
      dryRun: options.dryRun,
    };

    const report = await runRangeFilterProbe({
      target,
      transport: aws?.transport,
      inspector: aws?.inspector,
    });

    console.log(formatProbeSummary(report));

    const json = JSON.stringify(report, null, 2);
    if (options.printJson) {
      console.log('');
      console.log(json);
    }

    if (options.write) {
      const writer = createFileSystemReportWriter(options.outputDir);
      const fileName = probeReportFileName(report.generatedAt);
      await writer.write(fileName, `${json}\n`);
      console.log('');
      console.log(`レポートを書き出しました: ${options.outputDir}/${fileName}`);
    }

    // 未確定のまま終わった場合は終了コードで知らせる。CI では実行しないが、
    // 手動実行時に「実測したのに決まらなかった」ことを見落とさないため
    if (!options.dryRun && report.rangeFilterVerdict === '未確定') {
      process.exitCode = 2;
    }
  } finally {
    aws?.close();
  }
}

// ============================================================
// 小さなヘルパー
// ============================================================

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function tryParseJsonObject(text: string): Record<string, unknown> | undefined {
  if (text.length === 0) return undefined;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function isResourceNotFound(error: unknown): boolean {
  const name = asRecord(error)?.name;
  return name === 'ResourceNotFoundException';
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}

/**
 * このファイルが直接実行されたかを判定する。
 *
 * `import.meta` は CJS 実行では使えず、`require.main` は型定義に依存するため、
 * 起動引数のパスで判定する。テストから import した場合に `main()` が走らないようにするための門である。
 */
function isDirectExecution(): boolean {
  const entry = process.argv[1] ?? '';
  return entry.endsWith('probe-range-filter.ts') || entry.endsWith('probe-range-filter.js');
}

if (isDirectExecution()) {
  void main();
}
