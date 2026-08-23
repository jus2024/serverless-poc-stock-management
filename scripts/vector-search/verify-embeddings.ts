/**
 * Verification_Run 実行スクリプト（`npm run vector:verify`）
 *
 * 埋め込みバッチ（`phase = "embed"`）の完走後に 1 回実行し、Vector_Table と
 * Vector_Collection に格納されたベクトルが一致していることを確認する（要件 3.6 / 3.15）。
 *
 * ## 手順
 *
 * 1. **対象の特定**（要件 3.15）。Vector_Table を `warehouseId = WH-TOKYO` で絞って `Scan` し、
 *    当該言語のベクトルが存在し `embeddingModel` と `embeddingDimensions` がともに現行設定と
 *    一致する (itemId, 言語) の組を数える。判定は `skip-decision.ts` の述語であり、
 *    埋め込みバッチのスキップ判定と同一の条件式である
 * 2. **チャンク分割**。itemId を 100 件単位に分ける（1 チャンクあたり Lambda 側で
 *    `GetItem` 100 回 + `_mget` 1 回）
 * 3. **検証経路の反復呼び出し**。`POST /vector-search/verify` を各チャンクへ投げる。
 *    **ベクトル本体はリクエストにもレスポンスにも乗らない**（要件 3.16 / Property 22）
 * 4. **集計**。全チャンクの件数を `verification-summary.ts` の
 *    `summarizeVerification()` で合算し、`docs/measurements/verify-<date>.json` へ書き出す
 *
 * ## 設計上の要点
 *
 * - **Bedrock を呼ばない**（要件 3.15）。本スクリプトも検証経路も埋め込みを生成しない。
 *   各チャンクの応答が報告する Bedrock 呼び出し回数を合算し、0 であることをレポートへ残す。
 *   既に生成済みの 10,000 組を再課金なしで検証するための必須条件である（前提 A18）
 * - **AOSS へ直接触らない。** 開発者の IAM ユーザーはデータアクセスポリシーの Principal に
 *   含まれず、インデックスを直接読めない（前提 A19）。本スクリプトは API Gateway 経由で
 *   検証経路を呼ぶだけである
 * - **書き込みを一切行わない。** 使う AWS API は Vector_Table の `Scan` のみで、
 *   書き込みコマンドを組み立てる経路がコード上に存在しない
 * - **純計算と I/O を分離する。** 対象特定・チャンク分割・集計・整形はすべて純関数であり、
 *   AWS 認証情報もファイルシステムも要らない。AWS と HTTP とファイル書き出しは
 *   {@link VectorTableScanner} / {@link VerificationEndpoint} / {@link VerifyReportWriter} の
 *   3 つのインターフェース越しに行う
 * - **合否判定を自前で持たない。** `passed` / `failedCount` / `consistent` は
 *   `verification-summary.ts` の 1 箇所が決める（要件 3.17 / 3.18）
 *
 * ## 使い方
 *
 * ```
 * npm run vector:verify                       # 全件（最大 5,000 SKU x 2 言語 = 10,000 組）
 * npm run vector:verify -- --dry-run          # AWS へ一切触らず実行計画のみを出す
 * npm run vector:verify -- --language ja      # 日本語ベクトルのみ
 * npm run vector:verify -- --limit 200        # 先頭 200 SKU のみ（試走用）
 * npm run vector:verify -- --base-url https://xxx.execute-api.ap-northeast-1.amazonaws.com/api
 * ```
 *
 * 要件: 3.6, 3.13, 3.14, 3.15, 3.16, 3.17, 3.18, 18.20
 * 設計: Vector_Verification_Path（案 D）/ デプロイ順序とゲート条件 段階 9b
 */

import {
  isVerificationTarget,
  type StoredEmbeddingState,
} from '../../amplify/functions/shared/vector/skip-decision';
import {
  resolveVerificationRunStatus,
  summarizeVerification,
  sumVerificationCounts,
  type VerificationCounts,
  type VerificationMismatchKey,
  type VerificationRunStatus,
  type VerificationSummary,
} from '../../amplify/functions/shared/vector/verification-summary';
import {
  VECTOR_LANGUAGES,
  isVectorLanguage,
  type VectorLanguage,
} from '../../amplify/functions/shared/vector/language';
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  MAX_VERIFICATION_ITEM_IDS,
  VERIFICATION_EMBEDDING_MODEL_ID,
  VERIFICATION_ROUTE_PATH,
  VERIFICATION_WAREHOUSE_ID,
} from '../../amplify/functions/vector-search-aoss/verify';

// ============================================================
// 定数
// ============================================================

/** Vector_Table の既定のテーブル名（要件 1.1） */
export const DEFAULT_VECTOR_TABLE_NAME = 'kiro-roasters-inventory-vector';

/** レポートの既定の格納先。実行時の CWD からの相対パス */
export const VERIFY_REPORT_DIR = 'docs/measurements';

/** レポートのスキーマ版。形が変わったら上げる */
export const VERIFY_REPORT_SCHEMA_VERSION = 1;

/** 1 リクエストへ載せる itemId の件数。検証経路の上限と同一（設計「対象特定」） */
export const VERIFY_CHUNK_SIZE = MAX_VERIFICATION_ITEM_IDS;

/** 1 チャンクの HTTP 要求のタイムアウト（ms）。`GetItem` 100 回 + `_mget` 1 回を見込む */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** 再試行してよい回数（スロットリングと一時的な失敗のみ） */
export const DEFAULT_MAX_RETRIES = 2;

/**
 * API ベース URL を解決する環境変数。先に見つかったものを採用する。
 *
 * `recall-cli.ts` の `BASE_URL_ENV_KEYS` と同一の順序・同一のキー名である。
 * あちらは 2,000 行超の CLI であり、定数 1 つのために本スクリプトへ取り込まない。
 */
export const BASE_URL_ENV_KEYS = ['VECTOR_SEARCH_API_URL', 'NEXT_PUBLIC_INVENTORY_API_URL'] as const;

/** 終了コード。合否と実行不能を区別する */
export const EXIT_CODES = {
  /** 全組が一致（`passed === true`） */
  pass: 0,
  /** 実行できなかった（引数不正、ベース URL 未設定、チャンクの恒久的失敗） */
  error: 1,
  /** 実行できたが不合格（不一致または未格納が 1 件以上） */
  fail: 2,
} as const;

// ============================================================
// 型
// ============================================================

/** `Scan` で読み取った 1 SKU 分の格納状態。ベクトル本体を持たない（存在の有無のみ） */
export interface ScannedSku extends StoredEmbeddingState {
  itemId: string;
}

/** 対象特定の結果（要件 3.15） */
export interface VerificationPlan {
  /** 走査した SKU 件数 */
  scannedSkuCount: number;
  /** 検証対象の組を 1 つ以上持つ itemId（`Scan` の出現順） */
  itemIds: string[];
  /** 検証対象の組の件数（言語別） */
  targetPairsByLanguage: Partial<Record<VectorLanguage, number>>;
  /** 検証対象の組の件数（合計） */
  targetPairCount: number;
  /** 対象外の組の件数（合計）。ベクトル無し、またはモデル・次元数が現行設定と異なる */
  skippedPairCount: number;
}

/** 検証経路 1 チャンク分の応答から取り出す値 */
export interface ChunkResult {
  chunkIndex: number;
  itemIdCount: number;
  counts: VerificationCounts;
  countsByLanguage: Partial<Record<VectorLanguage, VerificationCounts>>;
  mismatchedKeys: VerificationMismatchKey[];
  skippedCount: number;
  calls: { getItem: number; mget: number; bedrock: number };
  status: string;
}

/** レポート。`docs/vector-search-comparison.md`（要件 14.1）へ転記する材料 */
export interface VerificationRunReport {
  schemaVersion: number;
  generatedAt: string;
  target: {
    tableName: string;
    warehouseId: string;
    baseUrl: string;
    routePath: string;
    model: string;
    dimensions: number;
    languages: VectorLanguage[];
    chunkSize: number;
    limit: number | null;
    dryRun: boolean;
  };
  plan: VerificationPlan;
  /** 呼び出したチャンク数 */
  chunkCount: number;
  /** 全チャンクの集計（要件 3.17） */
  total: VerificationSummary;
  /** 言語別の集計（要件 3.14） */
  byLanguage: Partial<Record<VectorLanguage, VerificationSummary>>;
  /** 実行状態。不合格のとき COMPLETED にならない（要件 3.18） */
  status: VerificationRunStatus;
  /** 対象件数が対象特定の結果と一致しているか。ずれていれば数え落ちを疑う */
  targetCountMatchesPlan: boolean;
  /** 発行された AWS 呼び出しの合計。`bedrock` は 0 でなければならない（要件 3.15） */
  calls: { getItem: number; mget: number; bedrock: number };
  /** 再生成を伴っていないか（`calls.bedrock === 0`） */
  regenerationFree: boolean;
  /** 不一致・未格納の (itemId, 言語) 一覧（要件 3.16） */
  mismatchedKeys: VerificationMismatchKey[];
  /** チャンク単位の内訳 */
  chunks: ChunkResult[];
  /** 恒久的に失敗したチャンクの説明。空なら全チャンクが応答した */
  failedChunks: { chunkIndex: number; message: string }[];
  /** 次の対応 */
  followUp: string;
}

// ============================================================
// 対象特定（純関数、要件 3.15）
// ============================================================

/**
 * 検証対象の (itemId, 言語) の組を特定する。
 *
 * 判定は `skip-decision.ts` の {@link isVerificationTarget} のみが行う。埋め込みバッチの
 * スキップ判定と同一の条件式であるため、「バッチがスキップした組が検証対象にならない」
 * ずれが起きない。
 */
export function buildVerificationPlan(
  skus: readonly ScannedSku[],
  model: string,
  dimensions: number,
  languages: readonly VectorLanguage[]
): VerificationPlan {
  const itemIds: string[] = [];
  const targetPairsByLanguage: Partial<Record<VectorLanguage, number>> = {};
  for (const language of languages) targetPairsByLanguage[language] = 0;

  let targetPairCount = 0;
  let skippedPairCount = 0;

  for (const sku of skus) {
    let hasTarget = false;
    for (const language of languages) {
      if (isVerificationTarget(sku, language, model, dimensions)) {
        targetPairsByLanguage[language] = (targetPairsByLanguage[language] ?? 0) + 1;
        targetPairCount += 1;
        hasTarget = true;
      } else {
        skippedPairCount += 1;
      }
    }
    if (hasTarget && itemIds.indexOf(sku.itemId) < 0) itemIds.push(sku.itemId);
  }

  return {
    scannedSkuCount: skus.length,
    itemIds,
    targetPairsByLanguage,
    targetPairCount,
    skippedPairCount,
  };
}

/** itemId をチャンクへ分ける。空配列は空のチャンク列を返す */
export function chunkItemIds(itemIds: readonly string[], size: number): string[][] {
  const chunkSize = Number.isInteger(size) && size > 0 ? size : VERIFY_CHUNK_SIZE;
  const chunks: string[][] = [];
  for (let offset = 0; offset < itemIds.length; offset += chunkSize) {
    chunks.push(itemIds.slice(offset, offset + chunkSize));
  }
  return chunks;
}

// ============================================================
// 応答の読み取り（純関数）
// ============================================================

/** 検証経路の応答（JSON）から件数と識別子を取り出す。想定外の形は例外にする */
export function readChunkResult(
  chunkIndex: number,
  itemIdCount: number,
  body: Record<string, unknown>,
  languages: readonly VectorLanguage[]
): ChunkResult {
  const counts = readCounts(body, `チャンク ${chunkIndex} の応答`);

  const rawByLanguage = asRecord(body.byLanguage) ?? {};
  const countsByLanguage: Partial<Record<VectorLanguage, VerificationCounts>> = {};
  for (const language of languages) {
    const entry = asRecord(rawByLanguage[language]);
    if (entry === undefined) continue;
    countsByLanguage[language] = readCounts(entry, `チャンク ${chunkIndex} の ${language} 集計`);
  }

  const calls = asRecord(body.calls) ?? {};

  return {
    chunkIndex,
    itemIdCount,
    counts,
    countsByLanguage,
    mismatchedKeys: readMismatchedKeys(body.mismatchedKeys),
    skippedCount: readNumber(body.skippedCount) ?? 0,
    calls: {
      getItem: readNumber(calls.getItem) ?? 0,
      mget: readNumber(calls.mget) ?? 0,
      bedrock: readNumber(calls.bedrock) ?? 0,
    },
    status: typeof body.status === 'string' ? body.status : '',
  };
}

function readCounts(source: Record<string, unknown>, label: string): VerificationCounts {
  const targetCount = readNumber(source.targetCount);
  const matchedCount = readNumber(source.matchedCount);
  const mismatchedCount = readNumber(source.mismatchedCount);
  const missingCount = readNumber(source.missingCount);

  if (
    targetCount === undefined ||
    matchedCount === undefined ||
    mismatchedCount === undefined ||
    missingCount === undefined
  ) {
    throw new VerifyRunError(
      `${label} に件数フィールド（targetCount / matchedCount / mismatchedCount / missingCount）が揃っていません。`
    );
  }

  return { targetCount, matchedCount, mismatchedCount, missingCount };
}

/**
 * 不一致の識別子を読む。
 *
 * **`itemId` / `language` / `reason` の 3 フィールドのみを取り出す。** 応答に想定外の
 * フィールド（ベクトル本体など）が現れてもレポートへ通さない（要件 3.16 / Property 22）。
 */
export function readMismatchedKeys(value: unknown): VerificationMismatchKey[] {
  if (!Array.isArray(value)) return [];

  const keys: VerificationMismatchKey[] = [];
  for (const element of value) {
    const record = asRecord(element);
    if (record === undefined) continue;
    const language = record.language;
    keys.push({
      itemId: typeof record.itemId === 'string' ? record.itemId : '',
      language: isVectorLanguage(language) ? language : 'ja',
      reason: typeof record.reason === 'string' ? record.reason : '',
    });
  }
  return keys;
}

// ============================================================
// 集計（純関数、要件 3.17 / 3.18）
// ============================================================

/**
 * 全チャンクの結果を合算する。
 *
 * 合否・整合・失敗件数の式を本スクリプトが持たないことが要点である。
 * `summarizeVerification()` の戻り値をそのまま採用する。
 */
export function aggregateChunkResults(
  chunks: readonly ChunkResult[],
  languages: readonly VectorLanguage[]
): {
  total: VerificationSummary;
  byLanguage: Partial<Record<VectorLanguage, VerificationSummary>>;
  calls: { getItem: number; mget: number; bedrock: number };
} {
  const allKeys: VerificationMismatchKey[] = [];
  for (const chunk of chunks) {
    for (const key of chunk.mismatchedKeys) allKeys.push(key);
  }

  const byLanguage: Partial<Record<VectorLanguage, VerificationSummary>> = {};
  for (const language of languages) {
    const counts = sumVerificationCounts(
      chunks
        .map((chunk) => chunk.countsByLanguage[language])
        .filter((entry): entry is VerificationCounts => entry !== undefined)
    );
    byLanguage[language] = summarizeVerification(
      counts,
      allKeys.filter((key) => key.language === language)
    );
  }

  const total = summarizeVerification(
    sumVerificationCounts(chunks.map((chunk) => chunk.counts)),
    allKeys
  );

  const calls = { getItem: 0, mget: 0, bedrock: 0 };
  for (const chunk of chunks) {
    calls.getItem += chunk.calls.getItem;
    calls.mget += chunk.calls.mget;
    calls.bedrock += chunk.calls.bedrock;
  }

  return { total, byLanguage, calls };
}

/** レポートを組み立てる */
export function buildVerificationRunReport(input: {
  generatedAt: string;
  target: VerificationRunReport['target'];
  plan: VerificationPlan;
  chunks: readonly ChunkResult[];
  failedChunks: readonly { chunkIndex: number; message: string }[];
}): VerificationRunReport {
  const languages = input.target.languages;
  const aggregated = aggregateChunkResults(input.chunks, languages);
  const status = resolveVerificationRunStatus(aggregated.total);

  return {
    schemaVersion: VERIFY_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    target: input.target,
    plan: input.plan,
    chunkCount: input.chunks.length,
    total: aggregated.total,
    byLanguage: aggregated.byLanguage,
    status,
    targetCountMatchesPlan: aggregated.total.targetCount === input.plan.targetPairCount,
    calls: aggregated.calls,
    regenerationFree: aggregated.calls.bedrock === 0,
    mismatchedKeys: aggregated.total.mismatchedKeys,
    chunks: [...input.chunks],
    failedChunks: [...input.failedChunks],
    followUp: buildFollowUp(aggregated.total, input.failedChunks.length),
  };
}

/** 実測結果を受けて次に何をするかの指示文。レポートへ載せる */
export function buildFollowUp(total: VerificationSummary, failedChunkCount: number): string {
  if (failedChunkCount > 0) {
    return (
      `${failedChunkCount} 件のチャンクが応答しなかったため、検証は未完了である。` +
      'エラー内容（errorCode / stage）を確認し、ACCESS_DENIED_* であれば検索 Lambda の ' +
      'dynamodb:GetItem（Vector_Table のテーブル ARN）とデータアクセスポリシーの ReadDocument を確認する。'
    );
  }
  if (total.targetCount === 0) {
    return (
      '検証対象が 0 件だった。Vector_Table に現行設定と一致するベクトルが存在しないため、' +
      '埋め込みバッチ（phase = "embed"）の完走状況と、モデル識別子・次元数の設定を確認する。'
    );
  }
  if (total.passed) {
    return (
      '全対象が一致した。要件 3.6 の一致件数として docs/vector-search-comparison.md（task 14.1）へ ' +
      '転記する。Bedrock 呼び出し回数が 0 であることも併せて記載する。'
    );
  }
  return (
    `不一致 ${total.mismatchedCount} 件 / 未格納 ${total.missingCount} 件を検出した。` +
    '原因を _id の組み立て違い、f32 丸めの経路差、書き込み時の補償漏れの順に確認してから task 14.1 へ進む。'
  );
}

/** レポートファイル名（task 17.1 の `verify-<date>.json`） */
export function verifyReportFileName(generatedAt: string): string {
  return `verify-${generatedAt.replace(/[:.]/g, '-')}.json`;
}

/** 終了コードを決める。合否と実行不能を区別する */
export function decideExitCode(report: VerificationRunReport): number {
  if (report.failedChunks.length > 0) return EXIT_CODES.error;
  return report.total.passed && report.regenerationFree ? EXIT_CODES.pass : EXIT_CODES.fail;
}

/** 人が読む要約 */
export function formatVerificationSummary(report: VerificationRunReport): string {
  const lines: string[] = [];

  lines.push('=== Verification_Run（要件 3.6 / 3.13〜3.18） ===');
  lines.push(`実行時刻: ${report.generatedAt}`);
  lines.push(
    `対象: table=${report.target.tableName} 代表倉庫=${report.target.warehouseId} ` +
      `model=${report.target.model} dimensions=${report.target.dimensions} ` +
      `languages=${report.target.languages.join(',')}`
  );
  lines.push(`エンドポイント: ${report.target.baseUrl}${report.target.routePath}`);
  lines.push(
    `対象特定: SKU ${report.plan.scannedSkuCount} 件 / 検証対象 ${report.plan.targetPairCount} 組 / ` +
      `対象外 ${report.plan.skippedPairCount} 組 / チャンク ${report.chunkCount} 本`
  );

  if (report.target.dryRun) {
    lines.push('');
    lines.push('--dry-run のため AWS へ 1 度も送信していない（実行計画のみ）。');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('--- 言語別 ---');
  for (const language of report.target.languages) {
    const summary = report.byLanguage[language];
    if (summary === undefined) continue;
    lines.push(
      `${language}  対象 ${summary.targetCount} / 一致 ${summary.matchedCount} / ` +
        `不一致 ${summary.mismatchedCount} / 未格納 ${summary.missingCount} / ` +
        `整合 ${summary.consistent} / 合格 ${summary.passed}`
    );
  }

  lines.push('');
  lines.push(
    `合計  対象 ${report.total.targetCount} / 一致 ${report.total.matchedCount} / ` +
      `不一致 ${report.total.mismatchedCount} / 未格納 ${report.total.missingCount}`
  );
  lines.push(
    `整合: ${report.total.consistent} / 合格: ${report.total.passed} / ` +
      `失敗件数: ${report.total.failedCount} / 実行状態: ${report.status}`
  );
  lines.push(`対象件数が対象特定と一致: ${report.targetCountMatchesPlan}`);
  lines.push(
    `AWS 呼び出し: GetItem ${report.calls.getItem} 回 / _mget ${report.calls.mget} 回 / ` +
      `Bedrock ${report.calls.bedrock} 回（再生成なし: ${report.regenerationFree}）`
  );

  if (report.failedChunks.length > 0) {
    lines.push('');
    lines.push('--- 応答しなかったチャンク ---');
    for (const failure of report.failedChunks) {
      lines.push(`チャンク ${failure.chunkIndex}: ${failure.message}`);
    }
  }

  if (report.mismatchedKeys.length > 0) {
    lines.push('');
    lines.push(`--- 不一致・未格納の組（先頭 20 件 / 全 ${report.mismatchedKeys.length} 件）---`);
    for (const key of report.mismatchedKeys.slice(0, 20)) {
      lines.push(`${key.itemId} ${key.language}: ${key.reason}`);
    }
  }

  lines.push('');
  lines.push(`次の対応: ${report.followUp}`);

  return lines.join('\n');
}

// ============================================================
// I/O 境界
// ============================================================

/** Vector_Table の走査経路（`Scan` のみ、読み取り専用） */
export interface VectorTableScanner {
  scan(options: { limit: number | null }): Promise<ScannedSku[]>;
}

/** 検証経路の呼び出し口（`POST /vector-search/verify`） */
export interface VerificationEndpoint {
  verify(request: {
    itemIds: readonly string[];
    languages: readonly VectorLanguage[];
  }): Promise<Record<string, unknown>>;
}

/** レポートの書き出し経路 */
export interface VerifyReportWriter {
  write(fileName: string, contents: string): Promise<void>;
}

/** 実行時のエラー。使用法を添えて終了する種類と区別する */
export class VerifyRunError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = 'VerifyRunError';
    this.retryable = options.retryable === true;
  }
}

/** 引数の解釈に失敗した状態 */
export class VerifyArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifyArgumentError';
  }
}

// ============================================================
// 実行（I/O は注入で受ける）
// ============================================================

export interface RunVerificationOptions {
  target: VerificationRunReport['target'];
  scanner?: VectorTableScanner;
  endpoint?: VerificationEndpoint;
  maxRetries?: number;
  generatedAt?: string;
  /** 再試行の待機。既定は指数バックオフ */
  sleep?: (ms: number) => Promise<void>;
  /** 進捗の出力先。既定は無出力 */
  onProgress?: (message: string) => void;
}

/**
 * Verification_Run を 1 回実行する。
 *
 * チャンクは逐次で投げる。並行させると 1 チャンクあたり `GetItem` 100 回が重なり、
 * Vector_Table 側で不要なスロットリングを招く（検証は待てる処理である）。
 */
export async function runVerification(
  options: RunVerificationOptions
): Promise<VerificationRunReport> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const target = options.target;
  const progress = options.onProgress ?? ((): void => undefined);

  if (target.dryRun) {
    return buildVerificationRunReport({
      generatedAt,
      target,
      plan: {
        scannedSkuCount: 0,
        itemIds: [],
        targetPairsByLanguage: {},
        targetPairCount: 0,
        skippedPairCount: 0,
      },
      chunks: [],
      failedChunks: [],
    });
  }

  if (options.scanner === undefined || options.endpoint === undefined) {
    throw new VerifyRunError(
      '走査経路（scanner）と検証経路（endpoint）が必要です。接続先を確認するだけなら --dry-run を使ってください。'
    );
  }

  const skus = await options.scanner.scan({ limit: target.limit });
  const plan = buildVerificationPlan(skus, target.model, target.dimensions, target.languages);
  progress(
    `対象特定: SKU ${plan.scannedSkuCount} 件 / 検証対象 ${plan.targetPairCount} 組 / ` +
      `対象外 ${plan.skippedPairCount} 組`
  );

  const chunks = chunkItemIds(plan.itemIds, target.chunkSize);
  const results: ChunkResult[] = [];
  const failedChunks: { chunkIndex: number; message: string }[] = [];
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = options.sleep ?? defaultSleep;

  for (let index = 0; index < chunks.length; index += 1) {
    const itemIds = chunks[index];
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) await sleep(1_000 * attempt);

      try {
        const body = await options.endpoint.verify({ itemIds, languages: target.languages });
        const result = readChunkResult(index, itemIds.length, body, target.languages);
        results.push(result);
        progress(
          `チャンク ${index + 1}/${chunks.length}: 対象 ${result.counts.targetCount} 組 / ` +
            `一致 ${result.counts.matchedCount} / 不一致 ${result.counts.mismatchedCount} / ` +
            `未格納 ${result.counts.missingCount}`
        );
        lastError = undefined;
        break;
      } catch (error: unknown) {
        lastError = error;
        if (!(error instanceof VerifyRunError && error.retryable)) break;
      }
    }

    if (lastError !== undefined) {
      failedChunks.push({ chunkIndex: index, message: describeError(lastError) });
      progress(`チャンク ${index + 1}/${chunks.length}: 失敗 ${describeError(lastError)}`);
    }
  }

  return buildVerificationRunReport({ generatedAt, target, plan, chunks: results, failedChunks });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// AWS / HTTP 実装
// ============================================================

/**
 * Vector_Table を走査する実装（`Scan` のみ）。
 *
 * 射影はベクトルの**先頭要素だけ**（`embeddingJa[0]`）にする。判定に必要なのは
 * 「当該言語のベクトルが存在するか」だけであり、1,024 次元 2 本を 5,000 SKU 分
 * 転送する理由がない（`vector-embed-batch/handler.ts` と同じ判断）。
 *
 * SDK は遅延 import する。純計算だけを使う呼び出し側（単体テストを含む）に
 * AWS SDK の読み込みと資格情報の解決を強いない。
 */
export async function createVectorTableScanner(options: {
  tableName: string;
  region?: string;
}): Promise<{ scanner: VectorTableScanner; close: () => void }> {
  const { DynamoDBClient, ScanCommand } = await import('@aws-sdk/client-dynamodb');
  const client = new DynamoDBClient(options.region === undefined ? {} : { region: options.region });

  const scanner: VectorTableScanner = {
    async scan({ limit }): Promise<ScannedSku[]> {
      const skus: ScannedSku[] = [];
      let lastKey: Record<string, unknown> | undefined;

      do {
        const page = await client.send(
          new ScanCommand({
            TableName: options.tableName,
            FilterExpression: '#warehouseId = :warehouseId',
            ExpressionAttributeNames: {
              '#itemId': 'itemId',
              '#warehouseId': 'warehouseId',
              '#embeddingModel': 'embeddingModel',
              '#embeddingDimensions': 'embeddingDimensions',
              '#embeddingJa': 'embeddingJa',
              '#embeddingEn': 'embeddingEn',
            },
            ExpressionAttributeValues: { ':warehouseId': { S: VERIFICATION_WAREHOUSE_ID } },
            ProjectionExpression: [
              '#itemId',
              '#embeddingModel',
              '#embeddingDimensions',
              '#embeddingJa[0]',
              '#embeddingEn[0]',
            ].join(', '),
            ExclusiveStartKey: lastKey as never,
          })
        );

        for (const item of page.Items ?? []) {
          const sku = readScannedSku(item);
          if (sku !== undefined) skus.push(sku);
          if (limit !== null && skus.length >= limit) return skus;
        }
        lastKey = page.LastEvaluatedKey;
      } while (lastKey !== undefined);

      return skus;
    },
  };

  return { scanner, close: () => client.destroy() };
}

/** `Scan` のアイテム 1 件を {@link ScannedSku} へ写す（純関数） */
export function readScannedSku(item: Record<string, unknown>): ScannedSku | undefined {
  const itemId = (item.itemId as { S?: unknown } | undefined)?.S;
  if (typeof itemId !== 'string' || itemId.length === 0) return undefined;

  const dimensions = (item.embeddingDimensions as { N?: unknown } | undefined)?.N;
  const model = (item.embeddingModel as { S?: unknown } | undefined)?.S;

  return {
    itemId,
    embeddingModel: typeof model === 'string' ? model : undefined,
    embeddingDimensions: typeof dimensions === 'string' ? Number(dimensions) : undefined,
    hasEmbedding: {
      ja: hasVectorElement(item.embeddingJa),
      en: hasVectorElement(item.embeddingEn),
    },
  };
}

/** 射影した先頭要素からベクトル属性の存在を判定する */
function hasVectorElement(value: unknown): boolean {
  const list = (value as { L?: unknown } | undefined)?.L;
  return Array.isArray(list) && list.length > 0;
}

/**
 * 検証経路を呼ぶ実装。
 *
 * 送るのは itemId の配列と言語のみである（ベクトル本体を送らない。要件 3.16）。
 */
export function createHttpVerificationEndpoint(options: {
  baseUrl: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}): VerificationEndpoint {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return {
    async verify({ itemIds, languages }): Promise<Record<string, unknown>> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let status = 0;
      let text = '';
      try {
        const response = await fetch(`${baseUrl}${VERIFICATION_ROUTE_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
          body: JSON.stringify({ itemIds: [...itemIds], languages: [...languages] }),
          signal: controller.signal,
        });
        status = response.status;
        text = await response.text();
      } catch (error: unknown) {
        throw new VerifyRunError(
          `${VERIFICATION_ROUTE_PATH} の呼び出しに失敗しました（通信または中断）: ${describeError(error)}`,
          { retryable: true }
        );
      } finally {
        clearTimeout(timer);
      }

      const parsed = tryParseJsonObject(text);

      if (status < 200 || status >= 300) {
        const errorCode = typeof parsed?.errorCode === 'string' ? parsed.errorCode : '不明';
        const message = typeof parsed?.message === 'string' ? parsed.message : text.slice(0, 500);
        throw new VerifyRunError(
          `${VERIFICATION_ROUTE_PATH} が HTTP ${status} を返しました（errorCode=${errorCode}）: ${message}`,
          { retryable: status >= 500 || errorCode === 'THROTTLED' }
        );
      }

      if (parsed === undefined) {
        throw new VerifyRunError(
          `${VERIFICATION_ROUTE_PATH} の応答を JSON オブジェクトとして解釈できません（HTTP ${status}）。`
        );
      }
      return parsed;
    },
  };
}

/** ベース URL の末尾スラッシュを落とす */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) throw new VerifyRunError('API のベース URL が空です。');
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

/** ファイルシステムへレポートを書く実装 */
export function createFileSystemReportWriter(
  baseDir: string = VERIFY_REPORT_DIR
): VerifyReportWriter {
  return {
    async write(fileName: string, contents: string): Promise<void> {
      const [fs, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
      await fs.mkdir(baseDir, { recursive: true });
      await fs.writeFile(path.join(baseDir, fileName), contents, 'utf8');
    },
  };
}

// ============================================================
// CLI
// ============================================================

export interface VerifyCliOptions {
  tableName: string;
  baseUrl?: string;
  baseUrlSource: string;
  languages: VectorLanguage[];
  model: string;
  dimensions: number;
  chunkSize: number;
  limit: number | null;
  region?: string;
  headers: Record<string, string>;
  timeoutMs: number;
  maxRetries: number;
  dryRun: boolean;
  write: boolean;
  outputDir: string;
  printJson: boolean;
}

/** `--key value` 形式の引数を解釈する（純関数） */
export function parseVerifyArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env
): VerifyCliOptions {
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  const headers: Record<string, string> = {};
  const languages: VectorLanguage[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new VerifyArgumentError(`解釈できない引数: ${token}`);

    const key = token.slice(2);
    if (key === 'dry-run' || key === 'no-write' || key === 'json' || key === 'help') {
      booleans.add(key);
      continue;
    }

    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new VerifyArgumentError(`--${key} には値が必要です。`);
    }
    i += 1;

    if (key === 'header') {
      const separator = value.indexOf(':');
      if (separator <= 0) {
        throw new VerifyArgumentError('--header は "名前: 値" の形式で指定してください。');
      }
      headers[value.slice(0, separator).trim()] = value.slice(separator + 1).trim();
      continue;
    }

    if (key === 'language') {
      for (const raw of value.split(',')) {
        const language = raw.trim();
        if (!isVectorLanguage(language)) {
          throw new VerifyArgumentError(
            `--language は ${VECTOR_LANGUAGES.join(' / ')} のいずれかです（指定値: ${language}）。`
          );
        }
        if (languages.indexOf(language) < 0) languages.push(language);
      }
      continue;
    }

    flags.set(key, value);
  }

  if (booleans.has('help')) throw new VerifyArgumentError('使用法を表示します。');

  const resolvedBaseUrl = resolveBaseUrl(flags.get('base-url'), env);

  return {
    tableName: flags.get('table') ?? DEFAULT_VECTOR_TABLE_NAME,
    baseUrl: resolvedBaseUrl.baseUrl,
    baseUrlSource: resolvedBaseUrl.source,
    languages: languages.length > 0 ? languages : [...VECTOR_LANGUAGES],
    model: flags.get('model') ?? VERIFICATION_EMBEDDING_MODEL_ID,
    dimensions: parsePositiveInteger(
      flags.get('dimensions'),
      DEFAULT_EMBEDDING_DIMENSIONS,
      'dimensions'
    ),
    chunkSize: parseChunkSize(flags.get('chunk-size')),
    limit: flags.get('limit') === undefined ? null : parsePositiveInteger(flags.get('limit'), 1, 'limit'),
    region: flags.get('region'),
    headers,
    timeoutMs: parsePositiveInteger(flags.get('timeout-ms'), DEFAULT_REQUEST_TIMEOUT_MS, 'timeout-ms'),
    maxRetries: parseNonNegativeInteger(flags.get('max-retries'), DEFAULT_MAX_RETRIES, 'max-retries'),
    dryRun: booleans.has('dry-run'),
    write: !booleans.has('no-write'),
    outputDir: flags.get('out') ?? VERIFY_REPORT_DIR,
    printJson: booleans.has('json'),
  };
}

/** ベース URL を `--base-url` → 環境変数の順に解決する */
export function resolveBaseUrl(
  explicit: string | undefined,
  env: Record<string, string | undefined>
): { baseUrl?: string; source: string } {
  if (explicit !== undefined && explicit.trim().length > 0) {
    return { baseUrl: explicit.trim(), source: '--base-url' };
  }
  for (let i = 0; i < BASE_URL_ENV_KEYS.length; i += 1) {
    const key = BASE_URL_ENV_KEYS[i];
    const value = env[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return { baseUrl: value.trim(), source: key };
    }
  }
  return { source: '(未解決)' };
}

function parseChunkSize(raw: string | undefined): number {
  const size = parsePositiveInteger(raw, VERIFY_CHUNK_SIZE, 'chunk-size');
  if (size > MAX_VERIFICATION_ITEM_IDS) {
    throw new VerifyArgumentError(
      `--chunk-size は検証経路の上限 ${MAX_VERIFICATION_ITEM_IDS} 以下です（指定値: ${size}）。`
    );
  }
  return size;
}

function parsePositiveInteger(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new VerifyArgumentError(`--${label} は正の整数です（指定値: ${raw}）。`);
  }
  return parsed;
}

function parseNonNegativeInteger(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new VerifyArgumentError(`--${label} は 0 以上の整数です（指定値: ${raw}）。`);
  }
  return parsed;
}

/** 使用法。引数エラー時と `--help` で出す */
export const VERIFY_USAGE = [
  'Verification_Run（要件 3.6 / 3.13〜3.18）',
  '',
  '使用法: npm run vector:verify -- [オプション]',
  '',
  `  --base-url <url>          API のベース URL（既定: ${BASE_URL_ENV_KEYS.join(' → ')} の順に環境変数を見る）`,
  '  --header "名前: 値"       追加 HTTP ヘッダー（複数指定可。値はレポートへ載せない）',
  `  --table <name>            Vector_Table のテーブル名（既定: ${DEFAULT_VECTOR_TABLE_NAME}）`,
  `  --language <ja|en|ja,en>  検証する言語（既定: ${VECTOR_LANGUAGES.join(',')}）`,
  `  --dimensions <n>          次元数（既定: ${DEFAULT_EMBEDDING_DIMENSIONS}）`,
  '  --model <id>              モデル識別子（既定: 現行設定）',
  `  --chunk-size <n>          1 リクエストの itemId 件数（既定: ${VERIFY_CHUNK_SIZE}、上限 ${MAX_VERIFICATION_ITEM_IDS}）`,
  '  --limit <n>               走査する SKU の上限（試走用）',
  '  --region <region>         リージョン（既定: 既定の資格情報チェーンから解決）',
  `  --timeout-ms <n>          1 チャンクのタイムアウト（既定: ${DEFAULT_REQUEST_TIMEOUT_MS}）`,
  `  --max-retries <n>         再試行回数（既定: ${DEFAULT_MAX_RETRIES}）`,
  '  --dry-run                 AWS へ一切触らず実行計画のみを出す',
  '  --no-write                レポートファイルを書き出さない',
  '  --json                    レポート JSON を標準出力へ出す',
  '  --help                    この使用法を表示する',
  '',
  '本スクリプトは読み取り専用である（Vector_Table の Scan と検証経路の POST のみ）。',
  '埋め込みを生成せず Bedrock を 1 度も呼ばない（要件 3.15）。',
].join('\n');

/**
 * エントリポイント。
 *
 * `tsx` はスクリプトを CJS として実行するためトップレベル `await` が使えない。
 * したがって非同期処理は `main()` に閉じ、末尾で呼び出す。
 */
async function main(): Promise<void> {
  let options: VerifyCliOptions;
  try {
    options = parseVerifyArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof VerifyArgumentError ? error.message : describeError(error));
    console.error('');
    console.error(VERIFY_USAGE);
    process.exitCode = EXIT_CODES.error;
    return;
  }

  if (!options.dryRun && options.baseUrl === undefined) {
    console.error(
      [
        '検証 API のベース URL が解決できません。',
        `--base-url を指定するか、${BASE_URL_ENV_KEYS.join(' または ')} を設定してください。`,
        '接続先を確認するだけなら --dry-run が使えます。',
      ].join('\n')
    );
    process.exitCode = EXIT_CODES.error;
    return;
  }

  const aws = options.dryRun
    ? null
    : await createVectorTableScanner({ tableName: options.tableName, region: options.region });

  try {
    const report = await runVerification({
      target: {
        tableName: options.tableName,
        warehouseId: VERIFICATION_WAREHOUSE_ID,
        baseUrl: options.baseUrl ?? '(未解決 / --dry-run)',
        routePath: VERIFICATION_ROUTE_PATH,
        model: options.model,
        dimensions: options.dimensions,
        languages: options.languages,
        chunkSize: options.chunkSize,
        limit: options.limit,
        dryRun: options.dryRun,
      },
      scanner: aws?.scanner,
      endpoint:
        options.baseUrl === undefined
          ? undefined
          : createHttpVerificationEndpoint({
              baseUrl: options.baseUrl,
              timeoutMs: options.timeoutMs,
              headers: options.headers,
            }),
      maxRetries: options.maxRetries,
      onProgress: (message) => console.log(message),
    });

    console.log('');
    console.log(formatVerificationSummary(report));

    const json = JSON.stringify(report, null, 2);
    if (options.printJson) {
      console.log('');
      console.log(json);
    }

    if (options.write && !options.dryRun) {
      const writer = createFileSystemReportWriter(options.outputDir);
      const fileName = verifyReportFileName(report.generatedAt);
      await writer.write(fileName, `${json}\n`);
      console.log('');
      console.log(`レポートを書き出しました: ${options.outputDir}/${fileName}`);
    }

    process.exitCode = options.dryRun ? EXIT_CODES.pass : decideExitCode(report);
  } catch (error) {
    console.error(describeError(error));
    process.exitCode = EXIT_CODES.error;
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

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function tryParseJsonObject(text: string): Record<string, unknown> | undefined {
  if (text.length === 0) return undefined;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return typeof error === 'string' ? error : JSON.stringify(error);
}

/**
 * このファイルが直接実行されたかを判定する。
 *
 * `import.meta` は CJS 実行では使えないため起動引数のパスで判定する。
 * テストから import した場合に `main()` が走らないようにするための門である。
 */
function isDirectExecution(): boolean {
  const entry = process.argv[1] ?? '';
  return entry.endsWith('verify-embeddings.ts') || entry.endsWith('verify-embeddings.js');
}

if (isDirectExecution()) {
  void main();
}
