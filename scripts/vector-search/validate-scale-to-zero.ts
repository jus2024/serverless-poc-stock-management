/**
 * Deployment_Validator: min OCU 0 の受理可否を判定する
 *
 * **本スクリプトは課金対象リソース（Collection / Index / 検索 Lambda）を作成する前に実行し、
 * 判定結果を検証担当者に提示する位置づけである**（要件 7.5、design.md のデプロイ段階 3）。
 *
 * デプロイは 2 段階に分かれる。Stage A（`vectorCollectionEnabled=false`）では Vector_Table と
 * Query_Vector_Cache、そして Collection Group `kiro-inventory-vector-group` のみを作る。
 * Collection を含まない Collection Group は OCU 課金の対象にならない前提のため、この時点では
 * 課金が発生しない（前提 Q4。段階 4 の 1 時間観測で裏を取る）。本スクリプトはその Stage A の
 * 直後に走り、VECTORSEARCH タイプで min OCU 0 が実際に受理されたかを確認する。受理を確認して
 * から `vectorCollectionEnabled=true` で再デプロイし、はじめて課金対象リソースを作る。
 *
 * この順序を守ることで、min OCU 0 が拒否される構成（= アイドル時も常時 OCU 課金が続く構成）に
 * 気付かないまま Collection を作ってしまう事故を防ぐ。拒否されていた場合、本スクリプトは
 * 採用値と月額見積を提示して**そこで止まり**、続行の是非を検証担当者に委ねる（要件 7.2）。
 *
 * 判定手順（design.md「Deployment_Validator（運用スクリプト）」）:
 *
 * 1. `ListCollectionGroups` で対象 Collection Group の存在を確認し、`BatchGetCollectionGroup` で
 *    `capacityLimits` を含む詳細を取得する
 * 2. `minIndexingCapacityInOcu` と `minSearchCapacityInOcu` が**ともに 0** で受理されているかを判定する
 * 3. 受理: 「受理」と `vectorCollectionEnabled=true` での再デプロイ手順を出力する
 * 4. 拒否（0 が受理されず 1 などに丸められている）: 拒否理由の内容・採用値・月額見積
 *    （1 OCU x 0.24 USD x 730 h = 175.20 USD/月）を出力し、続行の是非を検証担当者に委ねる
 *
 * 設計上の要点:
 *
 * - **読み取り専用である。** `ListCollectionGroups` と `BatchGetCollectionGroup` の 2 つの読み取り
 *   API しか呼ばない。リソースの作成・変更・削除は一切行わないため、本スクリプトの実行自体が
 *   課金対象リソースを生むことはない
 * - **I/O を注入可能にする。** AWS 呼び出しは {@link CollectionGroupSource} 越しに行い、判定と
 *   整形は純関数（{@link normalizeCapacityLimits} / {@link evaluateScaleToZero} /
 *   {@link formatVerdictReport}）に閉じる。`ground-truth.ts` と同じ方針であり、単体テストは
 *   AWS 認証情報なしで判定ロジックを検証できる
 * - **キー名の綴り差を吸収する。** AOSS の API リファレンスは `minIndexingCapacityInOCU`
 *   （末尾大文字）と記載し、CDK / Ruby SDK は `minIndexingCapacityInOcu` を用いる。SDK の版で
 *   どちらが来ても判定が壊れないよう両方を受け、**どちらも無い場合は 0 と決めつけず「判定不能」**
 *   として報告する。0 と誤認すると「受理」を誤って出力し、課金対象リソースの作成を許してしまう
 * - **終了コードでゲートを表現する。** 受理は 0、拒否は 2、Collection Group 未作成などの判定不能は
 *   3、実行時エラーは 1。拒否を 0 以外にすることで、この判定を素通りして次の段階へ進む自動化を防ぐ。
 *   ただし最終的な続行判断は人間が下す（要件 7.2 / 7.5）
 *
 * 依存関係の追加が必要:
 *
 * `@aws-sdk/client-opensearchserverless` は本リポジトリに**まだ入っていない**。本スクリプトは
 * この SDK を実行時に遅延 import するため、型検査とビルドは追加なしで通るが、実行には
 * インストールが必要である。未インストール時は導入手順を含むエラーを出して終了する。
 * 導入は依存関係の追加という別の判断であり、本スクリプトの実装では行わない。
 *
 * 使い方:
 *
 * ```
 * npm run vector:validate
 * npm run vector:validate -- --region us-west-2
 * npm run vector:validate -- --json
 * ```
 *
 * 要件: 7.1, 7.2, 7.5
 * 設計: Deployment_Validator（運用スクリプト）
 */

// ============================================================
// 定数
// ============================================================

/**
 * 判定対象の Collection Group 名。
 *
 * 唯一の定義元は `amplify/custom/vector-collection.ts` の `VECTOR_COLLECTION_GROUP_NAME` だが、
 * ここでは import せずに再宣言している。あのモジュールは `aws-cdk-lib` を import するため、
 * 参照すると**課金対象リソースを作る前の判定を行う読み取り専用スクリプトが CDK に依存する**
 * ことになる。文字列 2 つのために CDK ライブラリ全体をロードするのは重いだけでなく、CDK 側の
 * 型エラーやバージョン差でこのゲートが実行不能になる経路を作ってしまう。CDK を持たない共有
 * モジュール（`amplify/functions/shared/vector/`）にはこの名前が置かれていないため、本スクリプトの
 * スコープ（新規ファイル 1 本のみ）では再宣言を選んだ。名前の変更は Collection Group の置換を
 * 伴う破壊的変更であり頻繁には起こらない。
 */
export const VECTOR_COLLECTION_GROUP_NAME = 'kiro-inventory-vector-group';

/** CDK コンテキストフラグ名。`amplify/custom/vector-collection.ts` と同じ値（再宣言の理由は上記と同じ） */
export const VECTOR_COLLECTION_ENABLED_CONTEXT_KEY = 'vectorCollectionEnabled';

/**
 * デプロイ段階ゲートの環境変数名。`amplify/custom/vector-collection.ts` と同じ値（再宣言の理由は上記と同じ）。
 *
 * `ampx sandbox` には `--context` が無く、`CDK_CONTEXT_JSON` も Amplify Gen 2 の合成に
 * 届かないため、Stage B へ進む手段はこの環境変数のみである。
 */
export const VECTOR_COLLECTION_ENABLED_ENV_KEY = 'VECTOR_COLLECTION_ENABLED';

/** scale-to-zero が成立するために必要な最小 OCU。indexing / search ともにこの値であること（要件 7.1） */
export const REQUIRED_MIN_OCU = 0;

/** 期待する最大 OCU。要件 7.1 の構成値。差異は警告として報告するのみで判定には使わない */
export const EXPECTED_MAX_OCU = 2;

/** scale-to-zero を提供する Collection Group の世代。これ以外では min OCU 0 を設定できない */
export const REQUIRED_GENERATION = 'NEXTGEN';

/** OCU の時間単価（USD）。us-west-2 の単価。出力に併記する（要件 7.2） */
export const OCU_HOURLY_USD = 0.24;

/** 月額換算に用いる時間数。要件 7.2 の 730 時間 */
export const HOURS_PER_MONTH = 730;

/** 終了コード。拒否と判定不能を 0 以外にして、判定を素通りする自動化を防ぐ */
export const EXIT_CODES = {
  /** min OCU 0 が受理されている。次の段階へ進める */
  accepted: 0,
  /** スクリプト自体の実行に失敗した（SDK 未導入、認証情報なし、API エラーなど） */
  error: 1,
  /** min OCU 0 が受理されていない。続行の是非は検証担当者が判断する */
  rejected: 2,
  /** 判定できない（Collection Group が未作成、`capacityLimits` が読めない） */
  indeterminate: 3,
} as const;

/** 対象の Collection Group が持つべき Collection 件数。判定時点では 0 のはず（段階 3 は Collection 作成前） */
const EXPECTED_COLLECTION_COUNT_AT_VALIDATION = 0;

/** 遅延 import する SDK のパッケージ名。未導入時のメッセージにも使う */
export const OPENSEARCH_SERVERLESS_SDK_PACKAGE = '@aws-sdk/client-opensearchserverless';

/** `ListCollectionGroups` の 1 ページあたり取得件数。API の上限値 */
const LIST_PAGE_SIZE = 100;

// ============================================================
// エラー
// ============================================================

/** 判定を続行できない状態。SDK 未導入、認証情報の不足、API エラーなど */
export class ScaleToZeroValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScaleToZeroValidationError';
  }
}

// ============================================================
// 型（AWS 応答の受け取り口）
// ============================================================

/**
 * `capacityLimits` の生の形。
 *
 * 末尾が `Ocu` の綴りと `OCU` の綴りの**両方**を受ける。AOSS の API リファレンスは
 * `minIndexingCapacityInOCU` と記載し、CDK の `CfnCollectionGroup.CapacityLimitsProperty` と
 * Ruby SDK は `minIndexingCapacityInOcu` を用いる。実測では、デプロイ済みの
 * `kiro-inventory-vector-group` に対する `ListCollectionGroups`（JavaScript SDK v3）は
 * `minIndexingCapacityInOCU` / `minSearchCapacityInOCU` / `maxIndexingCapacityInOCU` /
 * `maxSearchCapacityInOCU`（大文字 `OCU`）で返した（min 側 0.0 / max 側 2.0）。
 * それでも CDK 側は小文字 `Ocu` の綴りを使うため、両方を許容する形は防御として残す。
 */
export interface RawCapacityLimits {
  minIndexingCapacityInOcu?: number;
  minSearchCapacityInOcu?: number;
  maxIndexingCapacityInOcu?: number;
  maxSearchCapacityInOcu?: number;
  minIndexingCapacityInOCU?: number;
  minSearchCapacityInOCU?: number;
  maxIndexingCapacityInOCU?: number;
  maxSearchCapacityInOCU?: number;
}

/** `ListCollectionGroups` の 1 件（`collectionGroupSummaries[]`） */
export interface CollectionGroupSummaryLike {
  name?: string;
  id?: string;
  arn?: string;
  generation?: string;
  numberOfCollections?: number;
  capacityLimits?: RawCapacityLimits;
}

/** `currentCapacity` の片側（indexing / search） */
export interface CurrentCapacitySideLike {
  capacityInOcu?: number;
  autoscalingStatus?: string;
}

/** `BatchGetCollectionGroup` の 1 件（`collectionGroupDetails[]`） */
export interface CollectionGroupDetailLike extends CollectionGroupSummaryLike {
  standbyReplicas?: string;
  description?: string;
  currentCapacity?: {
    indexing?: CurrentCapacitySideLike;
    search?: CurrentCapacitySideLike;
  };
}

/**
 * `BatchGetCollectionGroup` の `collectionGroupErrorDetails[]` の 1 件。
 * 拒否理由の一次情報になり得るため、判定結果にそのまま載せる（要件 7.2）。
 */
export interface CollectionGroupErrorLike {
  name?: string;
  id?: string;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * AOSS の読み取り経路。AWS へ触るのはこのインターフェースの実装のみ。
 * 判定と整形はこれに依存しないため、単体テストは AWS 認証情報なしで実行できる。
 */
export interface CollectionGroupSource {
  /** 全 Collection Group の要約を返す（ページングは実装側で解決する） */
  listCollectionGroups(): Promise<readonly CollectionGroupSummaryLike[]>;
  /** 名前を指定して詳細を返す */
  batchGetCollectionGroup(names: readonly string[]): Promise<{
    details: readonly CollectionGroupDetailLike[];
    errors: readonly CollectionGroupErrorLike[];
  }>;
}

// ============================================================
// 型（判定結果）
// ============================================================

/** 綴り差を吸収したあとの容量設定 */
export interface NormalizedCapacityLimits {
  minIndexingCapacityInOcu: number;
  minSearchCapacityInOcu: number;
  /** 応答に含まれない場合は null。判定には使わず報告のみ */
  maxIndexingCapacityInOcu: number | null;
  maxSearchCapacityInOcu: number | null;
}

/** `capacityLimits` の解釈結果 */
export type CapacityLimitsResolution =
  | {
      ok: true;
      limits: NormalizedCapacityLimits;
      /** 実際に使われていたキーの綴り。SDK 側の実挙動を記録に残す */
      keyStyle: 'Ocu' | 'OCU' | 'mixed';
    }
  | {
      ok: false;
      message: string;
      /** 応答に存在したキー名（診断用） */
      presentKeys: readonly string[];
    };

/** 月額見積（要件 7.2） */
export interface MonthlyOcuEstimate {
  ocuHourlyUsd: number;
  hoursPerMonth: number;
  /** 要件 7.2 が指定する基準値。1 OCU x 0.24 USD x 730 h */
  referenceOneOcuMonthlyUsd: number;
  /** 採用された最小 OCU の合計（indexing + search） */
  minTotalOcu: number;
  /** 採用値に基づく月額見積。standby replicas により実際の起動 OCU は増える可能性があるため下限 */
  estimatedMonthlyUsd: number;
}

/** 判定の区分 */
export type ScaleToZeroDecision = 'accepted' | 'rejected' | 'not-found' | 'indeterminate';

/** 判定結果。CLI の出力と JSON 出力の両方の供給源になる */
export interface ScaleToZeroVerdict {
  decision: ScaleToZeroDecision;
  groupName: string;
  /** 参照したリージョン。解決できない場合は null */
  region: string | null;
  /** 判定の主文 */
  headline: string;
  limits: NormalizedCapacityLimits | null;
  /** 拒否時に実際に採用されていた最小 OCU（要件 7.2） */
  adoptedMinOcu: { indexing: number; search: number } | null;
  /** 拒否・判定不能の理由。受理時は空 */
  reasons: readonly string[];
  /** 拒否時のみ算出する月額見積（要件 7.2） */
  monthlyEstimate: MonthlyOcuEstimate | null;
  /** 判定は変えないが検証担当者が知るべき事項 */
  warnings: readonly string[];
  /** 参考情報（世代、standby replicas、現在の OCU など） */
  notes: readonly string[];
  /** 受理時の次の手順。それ以外では空 */
  nextSteps: readonly string[];
  exitCode: number;
}

/** 判定に必要な観測結果。AWS 呼び出しの成果をこの形にまとめてから純関数へ渡す */
export interface CollectionGroupObservation {
  groupName: string;
  region: string | null;
  /** 対象の Collection Group の詳細。見つからなければ null */
  detail: CollectionGroupDetailLike | null;
  /** `BatchGetCollectionGroup` が対象名について返したエラー */
  errors: readonly CollectionGroupErrorLike[];
  /** 対象が見つからなかった場合に列挙した既存の Collection Group 名（昇順） */
  availableGroupNames: readonly string[];
}

// ============================================================
// 純関数: capacityLimits の解釈
// ============================================================

/**
 * `capacityLimits` の綴り差を吸収して数値を取り出す。
 *
 * min 側の 2 項目が数値として取れない場合は `ok: false` を返す。**取れないことを 0 と
 * 解釈しない**のが要点である。0 と誤認すると「受理」を誤って出力し、min OCU が 1 に
 * 丸められた構成のまま課金対象リソースの作成を許してしまう。
 */
export function normalizeCapacityLimits(
  raw: RawCapacityLimits | undefined
): CapacityLimitsResolution {
  if (raw === undefined || raw === null || typeof raw !== 'object') {
    return {
      ok: false,
      message:
        '応答に capacityLimits が含まれていません。Collection Group の容量設定を読み取れないため、' +
        'min OCU 0 の受理可否を判定できません。',
      presentKeys: [],
    };
  }

  const presentKeys = Object.keys(raw);
  const minIndexing = pickCapacityValue(raw, 'minIndexingCapacityInOcu', 'minIndexingCapacityInOCU');
  const minSearch = pickCapacityValue(raw, 'minSearchCapacityInOcu', 'minSearchCapacityInOCU');
  const maxIndexing = pickCapacityValue(raw, 'maxIndexingCapacityInOcu', 'maxIndexingCapacityInOCU');
  const maxSearch = pickCapacityValue(raw, 'maxSearchCapacityInOcu', 'maxSearchCapacityInOCU');

  const missing: string[] = [];
  if (minIndexing === null) {
    missing.push('minIndexingCapacityInOcu (または minIndexingCapacityInOCU)');
  }
  if (minSearch === null) {
    missing.push('minSearchCapacityInOcu (または minSearchCapacityInOCU)');
  }

  if (minIndexing === null || minSearch === null) {
    return {
      ok: false,
      message:
        `capacityLimits から最小 OCU を読み取れません（不足: ${missing.join(' / ')}）。` +
        `応答に含まれていたキー: ${presentKeys.length === 0 ? '(なし)' : presentKeys.join(', ')}。` +
        '読み取れない値を 0 とみなすと受理を誤判定するため、判定不能として扱います。',
      presentKeys,
    };
  }

  return {
    ok: true,
    limits: {
      minIndexingCapacityInOcu: minIndexing.value,
      minSearchCapacityInOcu: minSearch.value,
      maxIndexingCapacityInOcu: maxIndexing === null ? null : maxIndexing.value,
      maxSearchCapacityInOcu: maxSearch === null ? null : maxSearch.value,
    },
    keyStyle: resolveKeyStyle([minIndexing, minSearch, maxIndexing, maxSearch]),
  };
}

/** 月額見積を算出する（要件 7.2） */
export function estimateMonthlyOcuCost(
  minIndexingOcu: number,
  minSearchOcu: number
): MonthlyOcuEstimate {
  const minTotalOcu = minIndexingOcu + minSearchOcu;
  return {
    ocuHourlyUsd: OCU_HOURLY_USD,
    hoursPerMonth: HOURS_PER_MONTH,
    referenceOneOcuMonthlyUsd: roundUsd(OCU_HOURLY_USD * HOURS_PER_MONTH),
    minTotalOcu,
    estimatedMonthlyUsd: roundUsd(minTotalOcu * OCU_HOURLY_USD * HOURS_PER_MONTH),
  };
}

// ============================================================
// 純関数: 判定
// ============================================================

/**
 * 観測結果から min OCU 0 の受理可否を判定する（要件 7.1 / 7.2 / 7.5）。
 *
 * 判定は `minIndexingCapacityInOcu` と `minSearchCapacityInOcu` が**ともに 0** であることの
 * 一点のみで決まる。世代や standby replicas、最大 OCU の差異は警告・参考情報として載せるが、
 * 受理・拒否の分岐には使わない。判定基準を 1 つに保つことで、出力の意味が曖昧にならない。
 */
export function evaluateScaleToZero(observation: CollectionGroupObservation): ScaleToZeroVerdict {
  const { groupName, region, detail, errors, availableGroupNames } = observation;
  const base = { groupName, region } as const;

  if (detail === null) {
    const reasons: string[] = [
      `Collection Group "${groupName}" が見つかりません。` +
        'Stage A（vectorCollectionEnabled=false）のデプロイが完了していない可能性があります。',
    ];
    for (const error of errors) {
      reasons.push(describeCollectionGroupError(error));
    }
    if (availableGroupNames.length > 0) {
      reasons.push(`同一リージョンに存在する Collection Group: ${availableGroupNames.join(', ')}`);
    } else {
      reasons.push('同一リージョンに Collection Group は 1 件も存在しません。');
    }

    return {
      ...base,
      decision: 'not-found',
      headline: `判定不能: Collection Group "${groupName}" が存在しません。`,
      limits: null,
      adoptedMinOcu: null,
      reasons,
      monthlyEstimate: null,
      warnings: [],
      notes: [
        'Stage A のデプロイ後に再実行してください。' +
          'このスクリプトは課金対象リソース（Collection / Index / 検索 Lambda）の作成前に走るゲートです。',
      ],
      nextSteps: [],
      exitCode: EXIT_CODES.indeterminate,
    };
  }

  const resolution = normalizeCapacityLimits(detail.capacityLimits);
  const warnings = collectWarnings(detail);
  const notes = collectNotes(detail, resolution);

  if (!resolution.ok) {
    const reasons: string[] = [resolution.message];
    for (const error of errors) {
      reasons.push(describeCollectionGroupError(error));
    }

    return {
      ...base,
      decision: 'indeterminate',
      headline: `判定不能: "${groupName}" の capacityLimits から最小 OCU を読み取れません。`,
      limits: null,
      adoptedMinOcu: null,
      reasons,
      monthlyEstimate: null,
      warnings,
      notes,
      nextSteps: [],
      exitCode: EXIT_CODES.indeterminate,
    };
  }

  const { limits } = resolution;
  const accepted =
    limits.minIndexingCapacityInOcu === REQUIRED_MIN_OCU &&
    limits.minSearchCapacityInOcu === REQUIRED_MIN_OCU;

  if (accepted) {
    return {
      ...base,
      decision: 'accepted',
      headline:
        `受理: "${groupName}" は最小 OCU が indexing / search ともに ${REQUIRED_MIN_OCU} で作成されています。` +
        'scale-to-zero の前提条件を満たします。',
      limits,
      adoptedMinOcu: null,
      reasons: [],
      monthlyEstimate: null,
      warnings,
      notes,
      nextSteps: describeRedeploySteps(),
      exitCode: EXIT_CODES.accepted,
    };
  }

  const reasons: string[] = [
    `要求した最小 OCU ${REQUIRED_MIN_OCU} が受理されていません。` +
      `実際の採用値は indexing ${limits.minIndexingCapacityInOcu} OCU / ` +
      `search ${limits.minSearchCapacityInOcu} OCU です。`,
    'AOSS は最小 OCU 0 を受け付けない構成では要求値を許容値へ丸めます。' +
      'この採用値そのものが拒否の内容です。デプロイログ（CloudFormation イベント）に ' +
      'ValidationException などのメッセージが残っている場合は、その本文も Verification_Report に記録してください。',
  ];
  for (const error of errors) {
    reasons.push(describeCollectionGroupError(error));
  }

  return {
    ...base,
    decision: 'rejected',
    headline:
      `拒否: "${groupName}" の最小 OCU が ${REQUIRED_MIN_OCU} になっていません` +
      `（indexing ${limits.minIndexingCapacityInOcu} OCU / search ${limits.minSearchCapacityInOcu} OCU）。` +
      'アイドル時も OCU 課金が継続します。',
    limits,
    adoptedMinOcu: {
      indexing: limits.minIndexingCapacityInOcu,
      search: limits.minSearchCapacityInOcu,
    },
    reasons,
    monthlyEstimate: estimateMonthlyOcuCost(
      limits.minIndexingCapacityInOcu,
      limits.minSearchCapacityInOcu
    ),
    warnings,
    notes,
    nextSteps: [],
    exitCode: EXIT_CODES.rejected,
  };
}

/** 受理時に提示する再デプロイ手順（要件 7.5、design.md デプロイ段階 6） */
export function describeRedeploySteps(): readonly string[] {
  return [
    `環境変数 ${VECTOR_COLLECTION_ENABLED_ENV_KEY}=true を与えて再デプロイします。` +
      '既定（false）では Collection / Index / 検索 Lambda を作りません。',
    `  ${VECTOR_COLLECTION_ENABLED_ENV_KEY}=true npx ampx sandbox`,
    `  （ampx sandbox に --context は無く、CDK_CONTEXT_JSON も合成に届かないため、` +
      'この環境変数が唯一の経路です）',
    `  デプロイ後にフラグ無しで ampx sandbox を実行すると Stage A に戻り、Collection と` +
      'Index と検索 Lambda が削除されます。ウォッチモードのファイル変更でも起こるため、' +
      `作業中は export ${VECTOR_COLLECTION_ENABLED_ENV_KEY}=true を効かせたままにしてください。`,
    '再デプロイで作られるもの: Collection kiro-inventory-vector、Index inventory-vector' +
      '（knn_vector 2 フィールド）、検索 Lambda 3 本、Capabilities Lambda、Index_Provisioner。',
    'ここから課金が始まります。累積 20 USD の監視（npm run vector:measure -- --watch-spend）を' +
      '並走させてください（要件 7.7）。',
    '再デプロイ前に、既存の Collection kiro-inventory-search と Collection Group ' +
      'kiro-inventory-group に差分が出ないことを確認してください（要件 6.3 / 17.8）。',
  ];
}

// ============================================================
// 純関数: 出力の整形
// ============================================================

/** 判定結果を人間向けの行の列へ整形する。CLI と JSON 出力の両方でこの結果を使う */
export function formatVerdictReport(verdict: ScaleToZeroVerdict): readonly string[] {
  const lines: string[] = [];

  lines.push('=== Deployment_Validator: scale-to-zero 受理可否の判定 ===');
  lines.push('（課金対象リソース Collection / Index / 検索 Lambda の作成前に実行するゲート）');
  lines.push('');
  lines.push(`対象 Collection Group : ${verdict.groupName}`);
  lines.push(`リージョン            : ${verdict.region ?? '(SDK の既定解決に従う)'}`);
  lines.push(`判定                  : ${describeDecision(verdict.decision)}`);
  lines.push('');
  lines.push(verdict.headline);

  if (verdict.limits !== null) {
    lines.push('');
    lines.push('容量設定 (capacityLimits):');
    lines.push(`  最小 indexing : ${verdict.limits.minIndexingCapacityInOcu} OCU`);
    lines.push(`  最小 search   : ${verdict.limits.minSearchCapacityInOcu} OCU`);
    lines.push(`  最大 indexing : ${formatOptionalOcu(verdict.limits.maxIndexingCapacityInOcu)}`);
    lines.push(`  最大 search   : ${formatOptionalOcu(verdict.limits.maxSearchCapacityInOcu)}`);
  }

  if (verdict.reasons.length > 0) {
    lines.push('');
    lines.push(verdict.decision === 'rejected' ? '拒否理由:' : '判定不能の理由:');
    for (const reason of verdict.reasons) {
      lines.push(`  - ${reason}`);
    }
  }

  if (verdict.adoptedMinOcu !== null) {
    lines.push('');
    lines.push('採用値:');
    lines.push(`  最小 indexing : ${verdict.adoptedMinOcu.indexing} OCU`);
    lines.push(`  最小 search   : ${verdict.adoptedMinOcu.search} OCU`);
  }

  if (verdict.monthlyEstimate !== null) {
    const estimate = verdict.monthlyEstimate;
    lines.push('');
    lines.push('月額見積:');
    lines.push(
      `  基準値       : 1 OCU x ${estimate.ocuHourlyUsd} USD x ${estimate.hoursPerMonth} h = ` +
        `${estimate.referenceOneOcuMonthlyUsd.toFixed(2)} USD/月`
    );
    lines.push(
      `  採用値による : ${estimate.minTotalOcu} OCU x ${estimate.ocuHourlyUsd} USD x ` +
        `${estimate.hoursPerMonth} h = ${estimate.estimatedMonthlyUsd.toFixed(2)} USD/月`
    );
    lines.push(
      '  ※ standby replicas が ENABLED の場合、実際に起動する OCU は設定値より多くなり得ます。' +
        'この見積は下限として扱ってください。'
    );
  }

  if (verdict.warnings.length > 0) {
    lines.push('');
    lines.push('警告:');
    for (const warning of verdict.warnings) {
      lines.push(`  - ${warning}`);
    }
  }

  if (verdict.notes.length > 0) {
    lines.push('');
    lines.push('参考情報:');
    for (const note of verdict.notes) {
      lines.push(`  - ${note}`);
    }
  }

  if (verdict.nextSteps.length > 0) {
    lines.push('');
    lines.push('次の手順:');
    for (const step of verdict.nextSteps) {
      lines.push(`  ${step.startsWith(' ') ? step : `- ${step}`}`);
    }
  }

  if (verdict.decision === 'rejected') {
    lines.push('');
    lines.push('続行の判断は検証担当者に委ねます（要件 7.2 / 7.5）。');
    lines.push(
      `続行する場合、アイドル時も上記の月額が発生します。中止する場合は ` +
        `${VECTOR_COLLECTION_ENABLED_CONTEXT_KEY} を false のまま維持し、Collection Group を削除してください。`
    );
  }

  lines.push('');
  lines.push(`終了コード: ${verdict.exitCode}`);

  return lines;
}

// ============================================================
// AWS 実装（遅延 import）
// ============================================================

/** 遅延 import する SDK のうち、本スクリプトが使う部分だけの形 */
interface OpenSearchServerlessModuleLike {
  OpenSearchServerlessClient: new (config: Record<string, unknown>) => {
    send(command: unknown): Promise<Record<string, unknown>>;
    destroy(): void;
  };
  ListCollectionGroupsCommand: new (input: Record<string, unknown>) => unknown;
  BatchGetCollectionGroupCommand: new (input: Record<string, unknown>) => unknown;
}

export interface AossCollectionGroupSourceOptions {
  region?: string;
}

/**
 * AOSS の読み取り API を呼ぶ実装。
 *
 * SDK は遅延 import する。モジュール指定子を `string` 型の変数越しに渡すことで、
 * 型検査の時点で未導入パッケージの解決を要求しない。実行時に見つからない場合は
 * 導入手順を含むエラーへ変換する（依存関係の追加は別の判断であり、ここでは行わない）。
 *
 * 呼ぶのは `ListCollectionGroups` と `BatchGetCollectionGroup` の 2 つの読み取り API のみ。
 * 作成・変更・削除は行わないため、この実装が課金対象リソースを生むことはない。
 */
export function createAossCollectionGroupSource(
  options: AossCollectionGroupSourceOptions = {}
): CollectionGroupSource {
  const clientConfig: Record<string, unknown> =
    options.region === undefined ? {} : { region: options.region };

  return {
    async listCollectionGroups(): Promise<readonly CollectionGroupSummaryLike[]> {
      const sdk = await loadOpenSearchServerlessSdk();
      const client = new sdk.OpenSearchServerlessClient(clientConfig);
      const summaries: CollectionGroupSummaryLike[] = [];

      try {
        let nextToken: string | undefined;
        do {
          const input: Record<string, unknown> = { maxResults: LIST_PAGE_SIZE };
          if (nextToken !== undefined) {
            input.nextToken = nextToken;
          }
          const response = await sendCommand(
            client,
            new sdk.ListCollectionGroupsCommand(input),
            'ListCollectionGroups'
          );

          const page = response.collectionGroupSummaries;
          if (Array.isArray(page)) {
            for (const entry of page) {
              if (isRecord(entry)) {
                summaries.push(entry as CollectionGroupSummaryLike);
              }
            }
          }

          nextToken = typeof response.nextToken === 'string' ? response.nextToken : undefined;
        } while (nextToken !== undefined);
      } finally {
        client.destroy();
      }

      return summaries;
    },

    async batchGetCollectionGroup(names: readonly string[]): Promise<{
      details: readonly CollectionGroupDetailLike[];
      errors: readonly CollectionGroupErrorLike[];
    }> {
      const sdk = await loadOpenSearchServerlessSdk();
      const client = new sdk.OpenSearchServerlessClient(clientConfig);

      try {
        const response = await sendCommand(
          client,
          new sdk.BatchGetCollectionGroupCommand({ names: names.slice() }),
          'BatchGetCollectionGroup'
        );

        const details: CollectionGroupDetailLike[] = [];
        const rawDetails = response.collectionGroupDetails;
        if (Array.isArray(rawDetails)) {
          for (const entry of rawDetails) {
            if (isRecord(entry)) {
              details.push(entry as CollectionGroupDetailLike);
            }
          }
        }

        const errors: CollectionGroupErrorLike[] = [];
        const rawErrors = response.collectionGroupErrorDetails;
        if (Array.isArray(rawErrors)) {
          for (const entry of rawErrors) {
            if (isRecord(entry)) {
              errors.push(entry as CollectionGroupErrorLike);
            }
          }
        }

        return { details, errors };
      } finally {
        client.destroy();
      }
    },
  };
}

// ============================================================
// 実行の入口
// ============================================================

export interface RunValidationOptions {
  source: CollectionGroupSource;
  groupName?: string;
  region?: string | null;
}

/**
 * Collection Group を読み取って判定結果を返す。
 *
 * `ListCollectionGroups` を先に呼ぶのは、対象が見つからない場合に「Stage A が未デプロイ」と
 * 「名前の取り違え」を区別できるようにするためである。存在する名前を列挙して提示する。
 */
export async function runValidation(
  options: RunValidationOptions
): Promise<ScaleToZeroVerdict> {
  const groupName = options.groupName ?? VECTOR_COLLECTION_GROUP_NAME;
  const region = options.region ?? null;

  const summaries = await options.source.listCollectionGroups();
  const availableGroupNames = summaries
    .map((summary) => summary.name)
    .filter((name): name is string => typeof name === 'string' && name !== '')
    .sort(compareName);

  if (!availableGroupNames.includes(groupName)) {
    return evaluateScaleToZero({
      groupName,
      region,
      detail: null,
      errors: [],
      availableGroupNames,
    });
  }

  const { details, errors } = await options.source.batchGetCollectionGroup([groupName]);
  const matchedErrors = errors.filter((error) => error.name === groupName || error.name === undefined);
  const detail = details.find((entry) => entry.name === groupName) ?? null;

  // BatchGet が詳細を返さなかった場合は ListCollectionGroups の要約で代替する。
  // 要約にも capacityLimits が含まれるため、判定自体は成立する。
  const fallback = summaries.find((summary) => summary.name === groupName) ?? null;

  return evaluateScaleToZero({
    groupName,
    region,
    detail: detail ?? fallback,
    errors: matchedErrors,
    availableGroupNames,
  });
}

// ============================================================
// CLI
// ============================================================

/** コマンドライン引数 */
export interface CliOptions {
  groupName: string;
  region: string | null;
  json: boolean;
  help: boolean;
}

/** 引数を解釈する。未知のオプションは例外にして、綴り間違いを黙って無視しない */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    groupName: VECTOR_COLLECTION_GROUP_NAME,
    region: null,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--region' || arg === '--group-name') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new ScaleToZeroValidationError(`${arg} には値が必要です。`);
      }
      if (arg === '--region') {
        options.region = value;
      } else {
        options.groupName = value;
      }
      i += 1;
      continue;
    }

    const inlineMatch = /^--(region|group-name)=(.+)$/.exec(arg);
    if (inlineMatch !== null) {
      if (inlineMatch[1] === 'region') {
        options.region = inlineMatch[2];
      } else {
        options.groupName = inlineMatch[2];
      }
      continue;
    }

    throw new ScaleToZeroValidationError(
      `不明なオプション: ${arg}。--help で使い方を確認してください。`
    );
  }

  return options;
}

/** `--help` の出力 */
export function formatUsage(): readonly string[] {
  return [
    'Deployment_Validator: OpenSearch Serverless Collection Group の min OCU 0 受理可否を判定します。',
    '課金対象リソース（Collection / Index / 検索 Lambda）の作成前に実行するゲートです。',
    '',
    '使い方:',
    '  npm run vector:validate',
    '  npm run vector:validate -- --region us-west-2',
    '  npm run vector:validate -- --json',
    '',
    'オプション:',
    `  --group-name <name>  判定対象の Collection Group 名（既定: ${VECTOR_COLLECTION_GROUP_NAME}）`,
    '  --region <region>    参照するリージョン（既定: AWS SDK の既定解決）',
    '  --json               判定結果を JSON で出力する',
    '  -h, --help           この使い方を表示する',
    '',
    '終了コード:',
    `  ${EXIT_CODES.accepted} 受理（次の段階へ進める）`,
    `  ${EXIT_CODES.error} 実行時エラー`,
    `  ${EXIT_CODES.rejected} 拒否（続行の是非は検証担当者が判断する）`,
    `  ${EXIT_CODES.indeterminate} 判定不能（Collection Group 未作成など）`,
    '',
    `実行には ${OPENSEARCH_SERVERLESS_SDK_PACKAGE} が必要です（導入済み。実行時に遅延 import します）。`,
    '解決に失敗する場合のみ、次のコマンドで復旧してください:',
    `  npm install --save-dev ${OPENSEARCH_SERVERLESS_SDK_PACKAGE}`,
  ];
}

/** CLI の本体。終了コードを返す */
export async function main(argv: readonly string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`);
    return EXIT_CODES.error;
  }

  if (options.help) {
    process.stdout.write(`${formatUsage().join('\n')}\n`);
    return EXIT_CODES.accepted;
  }

  const region = options.region ?? resolveRegionFromEnvironment();

  try {
    const verdict = await runValidation({
      source: createAossCollectionGroupSource(
        options.region === null ? {} : { region: options.region }
      ),
      groupName: options.groupName,
      region,
    });

    if (options.json) {
      process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatVerdictReport(verdict).join('\n')}\n`);
    }

    return verdict.exitCode;
  } catch (error) {
    process.stderr.write(
      [
        '判定を実行できませんでした。',
        describeError(error),
        '',
        'このスクリプトは読み取り専用です。失敗しても AWS リソースは変更されていません。',
      ].join('\n') + '\n'
    );
    return EXIT_CODES.error;
  }
}

/**
 * このファイルが直接実行されたかを判定する。
 *
 * `import.meta.url` を使わないのは、本リポジトリの package.json に `"type": "module"` が
 * 無く、tsx が `.ts` を CJS として扱う場合に `import.meta` が使えないためである。
 * `process.argv[1]` の比較は CJS / ESM のどちらでも動く。
 */
function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') {
    return false;
  }
  return /(^|\/)validate-scale-to-zero\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.replace(/\\/g, '/'));
}

if (isDirectInvocation()) {
  void main(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}

// ============================================================
// 内部実装
// ============================================================

/** `capacityLimits` から片方の綴りで値を取り出す。両方あれば `Ocu` 側を優先する */
function pickCapacityValue(
  raw: RawCapacityLimits,
  ocuKey: keyof RawCapacityLimits,
  upperKey: keyof RawCapacityLimits
): { value: number; style: 'Ocu' | 'OCU' } | null {
  const lower = raw[ocuKey];
  if (typeof lower === 'number' && Number.isFinite(lower)) {
    return { value: lower, style: 'Ocu' };
  }
  const upper = raw[upperKey];
  if (typeof upper === 'number' && Number.isFinite(upper)) {
    return { value: upper, style: 'OCU' };
  }
  return null;
}

/** 実際に使われていたキーの綴りをまとめる */
function resolveKeyStyle(
  picked: readonly ({ style: 'Ocu' | 'OCU' } | null)[]
): 'Ocu' | 'OCU' | 'mixed' {
  const styles = new Set(
    picked.filter((entry): entry is { style: 'Ocu' | 'OCU' } => entry !== null).map((e) => e.style)
  );
  if (styles.size === 1) {
    return styles.has('Ocu') ? 'Ocu' : 'OCU';
  }
  return 'mixed';
}

/** 判定を変えない警告を集める */
function collectWarnings(detail: CollectionGroupDetailLike): readonly string[] {
  const warnings: string[] = [];

  if (typeof detail.generation === 'string' && detail.generation !== REQUIRED_GENERATION) {
    warnings.push(
      `Collection Group の世代が ${detail.generation} です。scale-to-zero は ` +
        `${REQUIRED_GENERATION} の Collection Group でのみ利用できます。`
    );
  }

  if (
    typeof detail.numberOfCollections === 'number' &&
    detail.numberOfCollections > EXPECTED_COLLECTION_COUNT_AT_VALIDATION
  ) {
    warnings.push(
      `この Collection Group には既に Collection が ${detail.numberOfCollections} 件所属しています。` +
        'この判定は課金対象リソースの作成前に行うものであり、既に課金が始まっている可能性があります。' +
        'CloudWatch の SearchOCU / IndexingOCU を確認してください。'
    );
  }

  const currentIndexing = detail.currentCapacity?.indexing?.capacityInOcu;
  const currentSearch = detail.currentCapacity?.search?.capacityInOcu;
  if (
    (typeof currentIndexing === 'number' && currentIndexing > 0) ||
    (typeof currentSearch === 'number' && currentSearch > 0)
  ) {
    warnings.push(
      `現在の起動 OCU が 0 ではありません（indexing ${formatOptionalOcu(currentIndexing ?? null)} / ` +
        `search ${formatOptionalOcu(currentSearch ?? null)}）。この時点で OCU 課金が発生しています。`
    );
  }

  return warnings;
}

/** 参考情報を集める */
function collectNotes(
  detail: CollectionGroupDetailLike,
  resolution: CapacityLimitsResolution
): readonly string[] {
  const notes: string[] = [];

  if (typeof detail.generation === 'string') {
    notes.push(`世代: ${detail.generation}`);
  }
  if (typeof detail.standbyReplicas === 'string') {
    notes.push(`standby replicas: ${detail.standbyReplicas}`);
  }
  if (typeof detail.numberOfCollections === 'number') {
    notes.push(`所属 Collection 件数: ${detail.numberOfCollections}`);
  }
  if (typeof detail.arn === 'string') {
    notes.push(`ARN: ${detail.arn}`);
  }

  if (resolution.ok) {
    notes.push(`capacityLimits のキー綴り: ${resolution.keyStyle}`);

    const maxes = [resolution.limits.maxIndexingCapacityInOcu, resolution.limits.maxSearchCapacityInOcu];
    if (maxes.some((value) => value !== null && value !== EXPECTED_MAX_OCU)) {
      notes.push(
        `最大 OCU が要件 7.1 の想定値 ${EXPECTED_MAX_OCU} と異なります` +
          `（indexing ${formatOptionalOcu(resolution.limits.maxIndexingCapacityInOcu)} / ` +
          `search ${formatOptionalOcu(resolution.limits.maxSearchCapacityInOcu)}）。` +
          '最悪ケース月額の見積が変わります。'
      );
    }
  }

  notes.push(
    'Collection を含まない Collection Group が課金対象かは未確認の前提です（Q4）。' +
      'Stage A の 1 時間観測（npm run vector:measure -- --watch-spend）で裏を取ってください。'
  );

  return notes;
}

/** `BatchGetCollectionGroup` のエラー詳細を 1 行に整形する */
function describeCollectionGroupError(error: CollectionGroupErrorLike): string {
  const parts: string[] = [];
  if (typeof error.errorCode === 'string' && error.errorCode !== '') {
    parts.push(error.errorCode);
  }
  if (typeof error.errorMessage === 'string' && error.errorMessage !== '') {
    parts.push(error.errorMessage);
  }
  const body = parts.length === 0 ? '(詳細不明)' : parts.join(': ');
  return `BatchGetCollectionGroup が返したエラー詳細: ${body}`;
}

/** 判定区分の表示名 */
function describeDecision(decision: ScaleToZeroDecision): string {
  switch (decision) {
    case 'accepted':
      return '受理';
    case 'rejected':
      return '拒否';
    case 'not-found':
      return '判定不能（Collection Group が存在しない）';
    case 'indeterminate':
      return '判定不能（容量設定を読み取れない）';
  }
}

/** OCU 値の表示。未取得は明示する */
function formatOptionalOcu(value: number | null): string {
  return value === null ? '(応答に含まれない)' : `${value} OCU`;
}

/** USD を小数第 2 位に丸める */
function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 表示用にリージョンを環境変数から解決する。判定には使わない */
function resolveRegionFromEnvironment(): string | null {
  const candidates = [process.env.AWS_REGION, process.env.AWS_DEFAULT_REGION];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') {
      return candidate;
    }
  }
  return null;
}

/** SDK を遅延 import する。未導入なら導入手順を含むエラーにする */
async function loadOpenSearchServerlessSdk(): Promise<OpenSearchServerlessModuleLike> {
  // 型検査の時点で未導入パッケージの解決を要求しないよう、指定子を string 型の変数越しに渡す
  const specifier: string = OPENSEARCH_SERVERLESS_SDK_PACKAGE;

  let loaded: unknown;
  try {
    loaded = await import(specifier);
  } catch (error) {
    throw new ScaleToZeroValidationError(
      [
        `${OPENSEARCH_SERVERLESS_SDK_PACKAGE} を読み込めませんでした。`,
        'この SDK は本リポジトリにまだ導入されていません。次のコマンドで追加してください。',
        `  npm install --save-dev ${OPENSEARCH_SERVERLESS_SDK_PACKAGE}`,
        `原因: ${describeError(error)}`,
      ].join('\n')
    );
  }

  if (!isRecord(loaded)) {
    throw new ScaleToZeroValidationError(
      `${OPENSEARCH_SERVERLESS_SDK_PACKAGE} の読み込み結果がモジュールオブジェクトではありません。`
    );
  }

  const candidate = (
    isRecord(loaded.default) && 'OpenSearchServerlessClient' in loaded.default
      ? loaded.default
      : loaded
  ) as Record<string, unknown>;

  for (const name of [
    'OpenSearchServerlessClient',
    'ListCollectionGroupsCommand',
    'BatchGetCollectionGroupCommand',
  ]) {
    if (typeof candidate[name] !== 'function') {
      throw new ScaleToZeroValidationError(
        `${OPENSEARCH_SERVERLESS_SDK_PACKAGE} に ${name} が見つかりません。` +
          'Collection Group API に対応した版へ更新してください。'
      );
    }
  }

  return candidate as unknown as OpenSearchServerlessModuleLike;
}

/** コマンドを送り、応答をレコードとして返す */
async function sendCommand(
  client: { send(command: unknown): Promise<Record<string, unknown>> },
  command: unknown,
  operationName: string
): Promise<Record<string, unknown>> {
  try {
    const response = await client.send(command);
    return isRecord(response) ? response : {};
  } catch (error) {
    throw new ScaleToZeroValidationError(
      `${operationName} の呼び出しに失敗しました: ${describeError(error)}`
    );
  }
}

/** プレーンなオブジェクトか判定する */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 名前の比較。ロケールに依存しないコードポイント順 */
function compareName(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** 例外を短い文字列へ変換する */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
