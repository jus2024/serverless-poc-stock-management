/**
 * 埋め込みテキスト組み立て（純関数）
 *
 * Sku_Metadata の 1 言語分（9 項目）から埋め込み対象テキストを組み立てる唯一の経路。
 *
 * 設計上の要点:
 * - **言語別の分岐を関数内に一切持たない。** Embedding_Text_JA は `buildEmbeddingText(metadata.ja)`、
 *   Embedding_Text_EN は `buildEmbeddingText(metadata.en)` で、同一関数を 2 回適用するだけである。
 *   両言語で前処理規則が食い違う経路が構造的に存在しない（要件 2.9）
 * - 日英を 1 つの文字列に混ぜる経路をコード上に作らない。入力は常に 1 言語分の
 *   `SkuMetadataFields` 1 つのみで、2 言語を受け取る関数を公開しない（要件 2.10）
 * - Query_Embedding_Lambda も本モジュールの `normalizeText()` を共有する。バッチ側とクエリ側で
 *   前処理が食い違うと、クエリベクトルと SKU ベクトルが別の正規化空間に置かれて recall が
 *   理由なく劣化するため、この共有は必須である（要件 10.1 / 10.12）
 * - すべて全域関数である。実行時に想定外の値（undefined、非文字列）が渡されても例外を投げず、
 *   空文字として扱う。埋め込み対象テキストの組み立てで実行が止まると
 *   バッチ全体（5,000 SKU × 2 言語）が 1 件の異常データで停止するため
 *
 * 要件: 2.8, 2.9, 2.10, 3.7, 10.1, 10.12
 * 設計: 埋め込みテキスト組み立て（純関数）
 */

import type { SkuMetadataFields } from './sku-metadata';

// ============================================================
// 定数
// ============================================================

/**
 * 埋め込みテキストにおける項目の固定順（要件 2.8 / 2.9）。
 *
 * 商品名 → カテゴリ → 産地 → 焙煎度 → フレーバーノート → ボディ → 酸味 → 説明文 → 抽出推奨。
 * 日本語形・英語形の双方がこの同一順序を使う。順序の出典を本定数に一本化することで、
 * 言語ごとに別の順序が定義される余地を残さない。
 */
export const EMBEDDING_FIELD_ORDER = [
  'productName',
  'category',
  'origin',
  'roastLevel',
  'flavorNotes',
  'body',
  'acidity',
  'description',
  'brewingRecommendation',
] as const satisfies readonly (keyof SkuMetadataFields)[];

/** 埋め込みテキストの項目区切り文字。半角スペース 1 文字（要件 2.8） */
export const EMBEDDING_FIELD_SEPARATOR = ' ';

/**
 * 埋め込み対象テキストの上限文字数（要件 3.7）。
 * 超過分は先頭からこの長さで切り詰め、切り詰めフラグを返す。
 */
export const MAX_EMBEDDING_TEXT_LENGTH = 50_000;

/**
 * 空白文字として扱う文字の集合。
 *
 * JavaScript の `\s` は既に全角スペース（U+3000）、タブ、改行、NBSP を含むが、
 * 前処理の対象範囲が要件（半角スペース・全角スペース・タブ・改行）を満たすことを
 * コード上で読み取れるようにするため、該当する文字を明示的に併記する。
 *
 * ゼロ幅文字（U+200B 等）は空白として扱わない。空白へ置き換えると
 * 語の境界が変わり、埋め込み対象テキストの意味が変化するため。
 */
const WHITESPACE_RUN = /[\s\u0020\u3000\u0009\u000A\u000D]+/gu;

// ============================================================
// 公開型
// ============================================================

/** 切り詰め結果。切り詰めが発生した件数の集計に使う（要件 3.7） */
export interface EmbeddingTextTruncation {
  /** 切り詰め後のテキスト。長さは常に MAX_EMBEDDING_TEXT_LENGTH 以下 */
  text: string;
  /** 切り詰めが発生したか。呼び出し側は言語別の件数集計にこの値を使う */
  truncated: boolean;
  /** 入力の長さ（UTF-16 コード単位） */
  originalLength: number;
  /** 出力の長さ（UTF-16 コード単位） */
  appliedLength: number;
  /** 適用した上限値。実行結果に上限そのものを含められるようにする */
  limit: number;
}

// ============================================================
// 前処理
// ============================================================

/**
 * 埋め込み前処理（要件 2.8 / 10.1 / 10.12）。
 *
 * 前後の空白文字を除去し、連続する空白文字を半角スペース 1 文字へ圧縮する。
 * 対象は半角スペース・全角スペース・タブ・改行を含む空白文字であり、
 * 全角スペース 1 文字のみの区切りも半角スペース 1 文字へ置き換える。
 *
 * 言語を引数に取らない。したがって前処理結果が言語で変わることはない（要件 10.12）。
 *
 * 全域関数である。文字列以外（undefined / null / 数値 / オブジェクト）は空文字を返す。
 * API 境界の JSON から届く値をそのまま渡せるように `unknown` を受け取る。
 */
export function normalizeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (value.length === 0) return '';

  return value.replace(WHITESPACE_RUN, EMBEDDING_FIELD_SEPARATOR).trim();
}

/**
 * 前処理後に空になる文字列か判定する。
 *
 * 空文字、および空白文字（半角スペース・全角スペース・タブ・改行）のみで構成される文字列で真になる。
 * Query_Embedding_Lambda の入力検証（要件 10.6）と本モジュールの空値判定が
 * 同一の空白定義を使うようにするため、判定を `normalizeText` に委譲する。
 */
export function isBlankForEmbedding(value: unknown): boolean {
  return normalizeText(value).length === 0;
}

// ============================================================
// 組み立て
// ============================================================

/**
 * 1 言語分のメタデータから埋め込み対象テキストを組み立てる（要件 2.8 / 2.9 / 2.10）。
 *
 * 項目順は `EMBEDDING_FIELD_ORDER` で固定する。各値に `normalizeText` を適用し、
 * 空値（空文字・空白のみ・未定義）を除いたうえで半角スペース 1 文字で連結する。
 * 結果は前後に空白を持たず、連続する空白文字を含まない。
 *
 * 同一の入力に対して常に同一の出力を返す（乱数・時刻・ネットワークを使わない）。
 * 言語別の分岐を持たないため、`fields` に日本語形を渡せば Embedding_Text_JA、
 * 英語形を渡せば Embedding_Text_EN になる。2 言語を同時に受け取る経路は存在しない。
 *
 * 全域関数である。`fields` が未定義・非オブジェクトの場合、および一部の項目が
 * 欠落・非文字列の場合も例外を投げず、得られた項目のみを連結する。
 */
export function buildEmbeddingText(fields: SkuMetadataFields): string {
  const source: Partial<Record<keyof SkuMetadataFields, unknown>> =
    typeof fields === 'object' && fields !== null ? fields : {};

  const parts: string[] = [];

  for (const key of EMBEDDING_FIELD_ORDER) {
    const normalized = normalizeText(source[key]);
    if (normalized.length > 0) parts.push(normalized);
  }

  return parts.join(EMBEDDING_FIELD_SEPARATOR);
}

/**
 * 埋め込み対象テキストを上限文字数で切り詰める（要件 3.7）。
 *
 * 入力長が上限以下なら入力をそのまま返し、`truncated` は偽になる。
 * 超過時は先頭 `MAX_EMBEDDING_TEXT_LENGTH` 文字を採用し、`truncated` を真にする。
 * 切り詰めはエラーではなく、呼び出し側は処理を継続して切り詰め件数を集計する。
 *
 * 切り詰め位置がサロゲートペアの途中に当たる場合は、単独サロゲートを Bedrock へ
 * 送らないために末尾の 1 コード単位を落とす（結果の長さは上限より 1 短くなる）。
 *
 * 全域関数である。文字列以外は空文字として扱う。
 */
export function truncateForEmbedding(text: unknown): EmbeddingTextTruncation {
  const source = typeof text === 'string' ? text : '';
  const originalLength = source.length;

  if (originalLength <= MAX_EMBEDDING_TEXT_LENGTH) {
    return {
      text: source,
      truncated: false,
      originalLength,
      appliedLength: originalLength,
      limit: MAX_EMBEDDING_TEXT_LENGTH,
    };
  }

  let sliced = source.slice(0, MAX_EMBEDDING_TEXT_LENGTH);

  const lastCode = sliced.charCodeAt(sliced.length - 1);
  const isHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
  if (isHighSurrogate) sliced = sliced.slice(0, -1);

  return {
    text: sliced,
    truncated: true,
    originalLength,
    appliedLength: sliced.length,
    limit: MAX_EMBEDDING_TEXT_LENGTH,
  };
}
