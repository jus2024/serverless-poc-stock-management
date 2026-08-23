/**
 * `embedding-text.ts` の property テスト（task 3.4）
 *
 * 検証対象は Correctness Property 1 / 2 / 6 の 3 本。
 * `normalizeText` / `buildEmbeddingText` / `truncateForEmbedding` は AWS に依存しない純関数のため、
 * モックを一切使わない（Bedrock も DynamoDB も呼ばない）。
 *
 * 正規化の期待値は実装を写さず、独立モデル（空白文字の連続でトークン分割して半角スペースで再結合）
 * として本ファイル内に別実装する。実装と同じ手続きを期待値側に書くと検証にならないため。
 *
 * 要件: 2.8, 2.9, 2.10, 3.7, 10.1, 10.12
 * Property: 1, 2, 6
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { generateSkus, type SkuItem } from '../../seed/sku-generator';
import {
  EMBEDDING_FIELD_ORDER,
  EMBEDDING_FIELD_SEPARATOR,
  MAX_EMBEDDING_TEXT_LENGTH,
  buildEmbeddingText,
  isBlankForEmbedding,
  normalizeText,
  truncateForEmbedding,
} from './embedding-text';
import { deriveSkuMetadata, type SkuMetadataFields, type VectorLanguage } from './sku-metadata';

// ============================================================
// 期待値の定義
// ============================================================

/**
 * 設計が定める固定順（要件 2.8 / 2.9）。
 * 商品名 → カテゴリ → 産地 → 焙煎度 → フレーバーノート → ボディ → 酸味 → 説明文 → 抽出推奨。
 * 実装の `EMBEDDING_FIELD_ORDER` とは独立にここへ書き下し、両者の一致自体を検証する。
 */
const DESIGN_FIELD_ORDER = [
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

const LANGUAGES: readonly VectorLanguage[] = ['ja', 'en'];

/** 既存シードが実際に生成する 5,000 件（決定的なので 1 回だけ生成する） */
const SEED_SKUS: readonly SkuItem[] = generateSkus();

// ============================================================
// 独立モデル
// ============================================================

/**
 * 前処理の独立モデル。
 * 空白文字の連続でトークンに分割し、空トークンを落とす。実装の `replace` + `trim` とは別経路。
 * 文字列以外は空列を返す（全域性）。
 */
function modelTokens(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value.split(/\s+/u).filter((token) => token !== '');
}

/** 出力テキストを区切り文字でトークン列に戻す */
function tokenize(text: string): string[] {
  return text.split(EMBEDDING_FIELD_SEPARATOR).filter((token) => token !== '');
}

/** 1 項目だけを持つメタデータを作る。全域性の検証のため非文字列も許す */
function singleField(key: keyof SkuMetadataFields, value: unknown): SkuMetadataFields {
  return { [key]: value } as unknown as SkuMetadataFields;
}

/** `unit` を繰り返して長さちょうど `length`（UTF-16 コード単位）の文字列を作る */
function repeatToLength(unit: string, length: number): string {
  if (length <= 0) return '';
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

// ============================================================
// arbitrary
// ============================================================

/**
 * 項目値に現れうる文字。
 * 半角スペース・全角スペース・タブ・改行（要件 2.8 の前処理対象）、日本語、英数字、
 * NBSP、サロゲートペア、ゼロ幅スペース（空白として扱ってはならない文字）を混ぜる。
 */
const fieldCharArb = fc.constantFrom(
  ' ',
  '　',
  '\t',
  '\n',
  '\r',
  '\u00a0',
  'a',
  'Z',
  '7',
  'あ',
  '漢',
  'ー',
  'é',
  '😀',
  '\u200b'
);

/** Property 1 が要求する「任意の 9 つの文字列」の 1 つ分 */
const fieldValueArb = fc.oneof(
  { weight: 5, arbitrary: fc.string({ unit: fieldCharArb, maxLength: 24 }) },
  {
    weight: 3,
    arbitrary: fc.constantFrom(
      '',
      ' ',
      '   ',
      '　',
      '　　',
      '\t',
      '\n',
      '\r\n',
      ' \t\n　 ',
      '\u00a0',
      '\u200b',
      'エチオピア　イルガチェフェ',
      '  medium   roast  ',
      'ミディアム',
      'light body',
      '柑橘\tベリー\n花のような'
    ),
  },
  { weight: 2, arbitrary: fc.string({ maxLength: 20 }) }
);

const fieldsArb: fc.Arbitrary<SkuMetadataFields> = fc.record({
  productName: fieldValueArb,
  category: fieldValueArb,
  origin: fieldValueArb,
  roastLevel: fieldValueArb,
  flavorNotes: fieldValueArb,
  body: fieldValueArb,
  acidity: fieldValueArb,
  description: fieldValueArb,
  brewingRecommendation: fieldValueArb,
});

/**
 * Property 2 が要求する「任意の文字列」。
 * 全域性の検証のため、API 境界の JSON から届きうる非文字列も混ぜる。
 */
const anyValueArb = fc.oneof(
  { weight: 5, arbitrary: fieldValueArb },
  { weight: 2, arbitrary: fc.string({ unit: fieldCharArb, maxLength: 120 }) },
  {
    weight: 1,
    arbitrary: fc.constantFrom<unknown>(undefined, null, 0, 42, Number.NaN, true, {}, [], ['a']),
  }
);

/** Property 6 用。上限の前後をまたぐ長さを狙って生成する */
const truncationInputArb = fc
  .tuple(
    // 先頭のオフセット。サロゲートペアの境界を上限位置に当てるためにずらす
    fc.nat({ max: 3 }),
    fc.constantFrom('a', 'あ', '😀', ' ', 'ab'),
    fc.oneof(
      fc.constantFrom(
        0,
        1,
        2,
        MAX_EMBEDDING_TEXT_LENGTH - 2,
        MAX_EMBEDDING_TEXT_LENGTH - 1,
        MAX_EMBEDDING_TEXT_LENGTH,
        MAX_EMBEDDING_TEXT_LENGTH + 1,
        MAX_EMBEDDING_TEXT_LENGTH + 2,
        MAX_EMBEDDING_TEXT_LENGTH + 1234,
        MAX_EMBEDDING_TEXT_LENGTH * 2
      ),
      fc.integer({ min: 0, max: MAX_EMBEDDING_TEXT_LENGTH + 64 })
    )
  )
  .map(([offset, unit, length]) => `${'x'.repeat(offset)}${repeatToLength(unit, length)}`);

// ============================================================
// Property 1
// ============================================================

describe('embedding-text の property テスト', () => {
  // Feature: vector-search-comparison, Property 1: 任意の 9 つの文字列（空文字、前後空白のみ、
  // 全角空白、日本語、英語を含む）に対して、組み立てられた埋め込みテキストは前後に空白を持たず、
  // 連続する空白文字を含まず、空でない値が固定順（商品名 → カテゴリ → 産地 → 焙煎度 →
  // フレーバーノート → ボディ → 酸味 → 説明文 → 抽出推奨）に出現する。同一の入力は常に同一の
  // 出力を返す。任意の日英メタデータ対に対して、日本語テキストには英語形の非空値が現れず、
  // 英語テキストには日本語形の非空値が現れない。
  // **Validates: Requirements 2.8, 2.9, 2.10**
  it('Property 1: 埋め込みテキスト組み立ての正規形と単一言語性', () => {
    // 1-a: 固定順と区切り文字の出典が設計と一致する（順序が実装側で入れ替わらないことの固定）
    expect([...EMBEDDING_FIELD_ORDER]).toStrictEqual([...DESIGN_FIELD_ORDER]);
    expect(EMBEDDING_FIELD_SEPARATOR).toBe(' ');

    // 1-b: 正規形・固定順・決定論
    fc.assert(
      fc.property(fieldsArb, fieldsArb, (fields, other) => {
        const text = buildEmbeddingText(fields);

        // 前後に空白を持たない
        expect(text).toBe(text.trim());
        expect(/^\s|\s$/u.test(text)).toBe(false);

        // 連続する空白文字を含まず、テキスト中の空白は半角スペース 1 文字のみ
        expect(/\s\s/u.test(text)).toBe(false);
        expect(/[^\S ]/u.test(text)).toBe(false);

        // 空でない値が固定順に出現する（期待値は独立モデルで組み立てる）
        expect(tokenize(text)).toStrictEqual(
          DESIGN_FIELD_ORDER.flatMap((key) => modelTokens(fields[key]))
        );

        // 出現順はオブジェクトのキー順ではなく EMBEDDING_FIELD_ORDER が決める
        const reordered = Object.fromEntries(
          [...Object.entries(fields)].reverse()
        ) as SkuMetadataFields;
        expect(buildEmbeddingText(reordered)).toBe(text);

        // 空白のみの値は空文字と同じ扱いになる（要件 2.8 の空値扱い）
        const blanksDropped = { ...fields };
        for (const key of DESIGN_FIELD_ORDER) {
          if (isBlankForEmbedding(blanksDropped[key])) blanksDropped[key] = '';
        }
        expect(buildEmbeddingText(blanksDropped)).toBe(text);

        // 別入力を挟んでも同一入力は同一出力（モジュールスコープの可変状態を持たない）
        buildEmbeddingText(other);
        expect(buildEmbeddingText(fields)).toBe(text);
      }),
      { numRuns: 300 }
    );

    // 1-c: 単一言語性（要件 2.10）。既存シードの実 SKU から導出した日英メタデータ対で確認する
    fc.assert(
      fc.property(fc.nat({ max: SEED_SKUS.length - 1 }), (index) => {
        const sku = SEED_SKUS[index]!;
        const metadata = deriveSkuMetadata(sku.itemId, sku.itemName);

        const jaText = buildEmbeddingText(metadata.ja);
        const enText = buildEmbeddingText(metadata.en);

        // 実 SKU では両言語ともテキストが得られる（空文字なら混在検査が空振りする）
        expect(jaText).not.toBe('');
        expect(enText).not.toBe('');

        for (const key of DESIGN_FIELD_ORDER) {
          const enValue = normalizeText(metadata.en[key]);
          if (enValue !== '') expect(jaText.includes(enValue)).toBe(false);

          const jaValue = normalizeText(metadata.ja[key]);
          if (jaValue !== '') expect(enText.includes(jaValue)).toBe(false);
        }
      }),
      { numRuns: 300 }
    );
  });

  // ============================================================
  // Property 2
  // ============================================================

  // Feature: vector-search-comparison, Property 2: 任意の文字列に対して、Embedding_Batch_Job が
  // 使用する前処理関数と Query_Embedding_Lambda が使用する前処理関数は同一の結果を返し、
  // 言語指定によって前処理結果が変わらない。
  // **Validates: Requirements 2.8, 10.1, 10.12**
  it('Property 2: 埋め込み前処理の経路間一致', () => {
    // 2-a: 前処理関数は言語を引数に取らない。言語別の前処理経路が構造的に存在しない（要件 10.12）
    expect(normalizeText.length).toBe(1);
    expect(buildEmbeddingText.length).toBe(1);
    expect(isBlankForEmbedding.length).toBe(1);

    fc.assert(
      fc.property(
        anyValueArb,
        fc.constantFrom(...DESIGN_FIELD_ORDER),
        fc.constantFrom(...LANGUAGES),
        (value, key, language) => {
          // Query_Embedding_Lambda 側の前処理（要件 10.1）
          const queryText = normalizeText(value);

          // Embedding_Batch_Job 側の前処理（各項目に適用される前処理を 1 項目で取り出す）
          const batchText = buildEmbeddingText(singleField(key, value));

          expect(batchText).toBe(queryText);

          // 独立モデルとの一致
          expect(queryText).toBe(modelTokens(value).join(' '));

          // 言語で結果が変わらない: 同一の値を日本語形・英語形の同一項目に置いても同一の結果
          const pair = { ja: singleField(key, value), en: singleField(key, value) };
          expect(buildEmbeddingText(pair.ja)).toBe(buildEmbeddingText(pair.en));
          expect(buildEmbeddingText(pair[language])).toBe(queryText);

          // 冪等。クエリ側で正規化済みの文字列がバッチ側を通っても変化しない
          expect(normalizeText(queryText)).toBe(queryText);
          expect(buildEmbeddingText(singleField(key, queryText))).toBe(queryText);

          // 空値判定が同一の空白定義を共有する（要件 10.6 の入力検証と前処理の一致）
          expect(isBlankForEmbedding(value)).toBe(queryText.length === 0);
        }
      ),
      { numRuns: 300 }
    );

    // 2-b: 実 SKU の日英メタデータでも、両言語に同一値を与えれば同一テキストになる
    fc.assert(
      fc.property(fc.nat({ max: SEED_SKUS.length - 1 }), fieldsArb, (index, fields) => {
        const sku = SEED_SKUS[index]!;
        const metadata = deriveSkuMetadata(sku.itemId, sku.itemName);

        // 言語ごとに前処理が分岐していれば、同一の入力から異なる出力が出る
        expect(buildEmbeddingText({ ...metadata.ja, ...fields })).toBe(
          buildEmbeddingText({ ...metadata.en, ...fields })
        );
      }),
      { numRuns: 100 }
    );
  });

  // ============================================================
  // Property 6
  // ============================================================

  // Feature: vector-search-comparison, Property 6: 任意の長さの入力テキストに対して、
  // 切り詰め後の長さは 50,000 以下であり、入力長が 50,000 以下の場合は出力が入力と等しい。
  // **Validates: Requirements 3.7**
  it('Property 6: 埋め込みテキストの上限切り詰め', () => {
    expect(MAX_EMBEDDING_TEXT_LENGTH).toBe(50_000);

    fc.assert(
      fc.property(truncationInputArb, (text) => {
        const result = truncateForEmbedding(text);

        expect(result.limit).toBe(MAX_EMBEDDING_TEXT_LENGTH);
        expect(result.originalLength).toBe(text.length);
        expect(result.appliedLength).toBe(result.text.length);

        // 切り詰め後の長さは常に上限以下
        expect(result.text.length).toBeLessThanOrEqual(MAX_EMBEDDING_TEXT_LENGTH);

        if (text.length <= MAX_EMBEDDING_TEXT_LENGTH) {
          // 上限以下では出力が入力と等しい
          expect(result.text).toBe(text);
          expect(result.truncated).toBe(false);
        } else {
          expect(result.truncated).toBe(true);
          // 先頭からの切り詰めであり、内容を書き換えない
          expect(text.startsWith(result.text)).toBe(true);
          expect(result.appliedLength).toBeGreaterThanOrEqual(MAX_EMBEDDING_TEXT_LENGTH - 1);
          // 末尾に単独のハイサロゲートを残さない
          const lastCode = result.text.charCodeAt(result.text.length - 1);
          expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
        }

        // 切り詰め結果を再度通しても変化しない（冪等）
        const again = truncateForEmbedding(result.text);
        expect(again.text).toBe(result.text);
        expect(again.truncated).toBe(false);
      }),
      { numRuns: 100 }
    );

    // 文字列以外は空文字として扱い、例外を投げない（全域性）
    fc.assert(
      fc.property(fc.constantFrom<unknown>(undefined, null, 0, 42, true, {}, [], ['a']), (value) => {
        const result = truncateForEmbedding(value);
        expect(result.text).toBe('');
        expect(result.truncated).toBe(false);
        expect(result.originalLength).toBe(0);
        expect(result.appliedLength).toBe(0);
        expect(result.limit).toBe(MAX_EMBEDDING_TEXT_LENGTH);
      }),
      { numRuns: 100 }
    );

    // 組み立て → 切り詰めの合成でも上限以下に収まる
    fc.assert(
      fc.property(fieldsArb, (fields) => {
        const result = truncateForEmbedding(buildEmbeddingText(fields));
        expect(result.text.length).toBeLessThanOrEqual(MAX_EMBEDDING_TEXT_LENGTH);
        expect(result.truncated).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});
