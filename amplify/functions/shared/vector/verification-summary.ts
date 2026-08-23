/**
 * 検証結果の集計と終了判定（純関数、共有モジュール）
 *
 * 格納値検証の**集計と終了判定をこの 1 箇所に閉じ込める**（要件 3.17 / 3.18）。
 * 呼び出し側（Vector_Verification_Path / Embedding_Batch_Job）は件数を数えて
 * {@link summarizeVerification} へ渡し、返ってきた `passed` と
 * {@link resolveVerificationRunStatus} の判定に従うだけにする。
 *
 * この構造にする理由は実測された欠陥にある。旧実装は検証の不一致件数を
 * `verifiedMismatchedCount` として数えながら、終了判定は別の変数（`failedCount`）を
 * 見ていたため、`verifiedMismatchedCount 1712`（= 検証が 1 件も成立していない）でも
 * `failedCount 0` / `COMPLETED` で終了した。集計と判定が別の場所にあると、
 * 一方だけを更新した時点で「検証しているのに落ちない」状態が再発する。
 *
 * 設計上の約束:
 * - **全域関数である。** 非整数・負値・非有限値を受けても例外を投げず、0 として扱う
 * - **`passed` は 2 つの条件の論理積である。** 失敗件数が 0 であることと、集計が整合して
 *   いること（一致 + 不一致 + 未格納 = 対象件数）。整合していない集計に対して
 *   合格を返すと、数え落ちが合格として通ってしまう
 * - **ベクトル本体を出力に載せない。** 不一致の識別子は `itemId` / `language` / `reason` の
 *   3 フィールドのみへ正規化する。入力に余分なフィールド（ベクトル本体など）が
 *   付いていても出力へは通さない（Property 22 を検証経路にも適用する）
 * - **識別子の件数を変えない。** 入力の識別子集合の件数と出力の件数は常に等しい
 *   （Property 58）。取りこぼしと重複追加のどちらも起こさない
 *
 * 要件: 3.6, 3.12, 3.17, 3.18
 * 設計: Vector_Verification_Path（案 D）/ 集計と終了判定 / Property 58
 */

import { isVectorLanguage, type VectorLanguage } from './language';

// ============================================================
// 定数
// ============================================================

/** 不一致理由の上限文字数。応答を肥大させず、原因の切り分けに足る長さに収める */
export const MAX_VERIFICATION_REASON_LENGTH = 200;

/**
 * 実行状態。**合格しなかった検証を `COMPLETED` として終了させない**（要件 3.18）。
 *
 * `VERIFICATION_FAILED` は「書き込みは終わっているが投入内容の一致が確認できていない」
 * 状態であり、再実行の対象でもある。
 */
export type VerificationRunStatus = 'COMPLETED' | 'VERIFICATION_FAILED';

// ============================================================
// 型
// ============================================================

/** 検証件数の組。単位は (itemId, 言語) の組（要件 3.14） */
export interface VerificationCounts {
  /** 検証対象として特定した組の件数（要件 3.15） */
  targetCount: number;
  /** 次元数と全次元の値が一致した組の件数 */
  matchedCount: number;
  /** 双方に存在するが次元数または値が一致しなかった組の件数 */
  mismatchedCount: number;
  /** いずれかのバックエンドで未格納であった組の件数 */
  missingCount: number;
}

/**
 * 不一致・未格納であった組の識別子（要件 3.16）。
 *
 * **このインターフェースのフィールド以外を出力へ載せない。** ベクトル本体
 * （次元数と同じ長さの数値配列）が応答へ乗る経路を型で塞ぐ。
 */
export interface VerificationMismatchKey {
  itemId: string;
  language: VectorLanguage;
  /** 不一致の理由。先頭に分類コード（`MISSING_*` / `DIMENSION_MISMATCH` / `VALUE_MISMATCH`）を置く */
  reason: string;
}

/** 集計結果。件数の組に整合判定・合否・失敗件数・識別子一覧を加えたもの */
export interface VerificationSummary extends VerificationCounts {
  /** `matchedCount + mismatchedCount + missingCount === targetCount` を満たすか */
  consistent: boolean;
  /** 合格。`failedCount === 0` かつ `consistent` のときのみ true */
  passed: boolean;
  /** 失敗件数に計上する値。`mismatchedCount + missingCount`（要件 3.18） */
  failedCount: number;
  /** 失敗した組の識別子一覧。件数は入力と等しい */
  mismatchedKeys: VerificationMismatchKey[];
}

// ============================================================
// 集計（唯一の経路）
// ============================================================

/**
 * 検証件数を集計し、整合判定と合否を決める（要件 3.17 / 3.18、Property 58）。
 *
 * - `failedCount` = 不一致 + 未格納
 * - `consistent` = 一致 + 不一致 + 未格納 が対象件数と等しい
 * - `passed` = `failedCount === 0` かつ `consistent`
 *
 * 例外を投げない全域関数であり、引数を変更しない。
 */
export function summarizeVerification(
  counts: VerificationCounts,
  mismatchedKeys: readonly VerificationMismatchKey[] = []
): VerificationSummary {
  const normalized: VerificationCounts = {
    targetCount: toCount(counts?.targetCount),
    matchedCount: toCount(counts?.matchedCount),
    mismatchedCount: toCount(counts?.mismatchedCount),
    missingCount: toCount(counts?.missingCount),
  };

  const failedCount = normalized.mismatchedCount + normalized.missingCount;
  const consistent =
    normalized.matchedCount + normalized.mismatchedCount + normalized.missingCount ===
    normalized.targetCount;

  return {
    ...normalized,
    consistent,
    // 失敗が 1 件でもあれば不合格。集計が整合しない場合も合格にしない
    passed: consistent && failedCount === 0,
    failedCount,
    mismatchedKeys: normalizeMismatchKeys(mismatchedKeys),
  };
}

/**
 * 集計結果から実行状態を決める（要件 3.18）。
 *
 * **合格していない検証を `COMPLETED` にしない。** 呼び出し側は状態文字列を
 * 自前で組み立てず、この関数の戻り値をそのまま使う。
 */
export function resolveVerificationRunStatus(
  summary: Pick<VerificationSummary, 'passed'>
): VerificationRunStatus {
  return summary?.passed === true ? 'COMPLETED' : 'VERIFICATION_FAILED';
}

// ============================================================
// 件数の合成
// ============================================================

/** 件数 0 の組。言語別集計の初期値 */
export function emptyVerificationCounts(): VerificationCounts {
  return { targetCount: 0, matchedCount: 0, mismatchedCount: 0, missingCount: 0 };
}

/** 2 つの件数の組を項ごとに足す */
export function addVerificationCounts(
  left: VerificationCounts,
  right: VerificationCounts
): VerificationCounts {
  return {
    targetCount: toCount(left?.targetCount) + toCount(right?.targetCount),
    matchedCount: toCount(left?.matchedCount) + toCount(right?.matchedCount),
    mismatchedCount: toCount(left?.mismatchedCount) + toCount(right?.mismatchedCount),
    missingCount: toCount(left?.missingCount) + toCount(right?.missingCount),
  };
}

/**
 * 件数の組の列を合算する（言語別 → 合計、チャンク別 → 全体）。
 *
 * 合計を別の式で数え直さず必ずこの関数を通すため、言語別の和と合計が
 * 食い違う経路が存在しない。
 */
export function sumVerificationCounts(
  list: readonly VerificationCounts[]
): VerificationCounts {
  let total = emptyVerificationCounts();
  for (const counts of list ?? []) {
    total = addVerificationCounts(total, counts);
  }
  return total;
}

// ============================================================
// 正規化
// ============================================================

/** 件数を非負整数へ丸める。非有限値・負値・非整数は 0 として扱う（全域性） */
function toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const truncated = Math.trunc(value);
  return truncated > 0 ? truncated : 0;
}

/**
 * 識別子一覧を 3 フィールドのみへ正規化する。
 *
 * 件数は変えない（要件 3.16 / Property 58）。入力に付随した余分なフィールドは
 * 落とし、理由は {@link MAX_VERIFICATION_REASON_LENGTH} で打ち切る。
 */
function normalizeMismatchKeys(
  keys: readonly VerificationMismatchKey[]
): VerificationMismatchKey[] {
  const normalized: VerificationMismatchKey[] = [];
  for (const key of keys ?? []) {
    normalized.push({
      itemId: typeof key?.itemId === 'string' ? key.itemId : '',
      // 型に反する値が実行時に届いた場合の既定値。到達しない経路だが合計件数は保つ
      language: isVectorLanguage(key?.language) ? key.language : 'ja',
      reason: truncateReason(typeof key?.reason === 'string' ? key.reason : ''),
    });
  }
  return normalized;
}

/** 理由を上限文字数へ収める */
function truncateReason(reason: string): string {
  return reason.length > MAX_VERIFICATION_REASON_LENGTH
    ? reason.slice(0, MAX_VERIFICATION_REASON_LENGTH)
    : reason;
}
