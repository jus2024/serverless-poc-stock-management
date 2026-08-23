/**
 * `sku-metadata.ts` の property テスト（task 3.2）
 *
 * 検証対象は Correctness Property 3 / 4 / 5 の 3 本。
 * `deriveSkuMetadata` は AWS に依存しない純関数のため、モックを一切使わない。
 *
 * 要件: 1.3, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7
 * Property: 3, 4, 5
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { generateSkus, type SkuItem } from '../../seed/sku-generator';
import {
  BLEND_HINT,
  MATERIAL_MATERIAL_I18N,
  MATERIAL_TYPE_I18N,
  ORIGIN_I18N,
  ROAST_I18N,
  SIZE_I18N,
  VARIETY_I18N,
  type BlendCode,
} from './master-data-i18n';
import {
  deriveSkuMetadata,
  isMaterialSku,
  type SkuMetadata,
  type SkuMetadataFields,
  type VectorLanguage,
} from './sku-metadata';

// ============================================================
// 期待値の定義
// ============================================================

/** 設計が定める 9 項目。日英いずれの形もこの集合とちょうど一致する */
const METADATA_FIELD_NAMES: readonly (keyof SkuMetadataFields)[] = [
  'productName',
  'category',
  'origin',
  'roastLevel',
  'flavorNotes',
  'body',
  'acidity',
  'description',
  'brewingRecommendation',
];

/** 既存シードが保存しなければならない 6 属性（要件 2.7 / Property 5） */
const PRESERVED_ATTRIBUTES: readonly (keyof SkuItem)[] = [
  'itemId',
  'itemName',
  'quantity',
  'lotNumber',
  'location',
  'unitPrice',
];

const LANGUAGES: readonly VectorLanguage[] = ['ja', 'en'];

// ============================================================
// arbitrary
// ============================================================

const originCodeArb = fc.constantFrom(...(Object.keys(ORIGIN_I18N) as (keyof typeof ORIGIN_I18N)[]));
const roastCodeArb = fc.constantFrom(...(Object.keys(ROAST_I18N) as (keyof typeof ROAST_I18N)[]));
const blendCodeArb = fc.constantFrom(...(Object.keys(BLEND_HINT) as BlendCode[]));
const productSizeArb = fc.constantFrom(
  ...(Object.keys(SIZE_I18N.product) as (keyof typeof SIZE_I18N.product)[])
);
const materialSizeArb = fc.constantFrom(
  ...(Object.keys(SIZE_I18N.material) as (keyof typeof SIZE_I18N.material)[])
);
const materialTypeArb = fc.constantFrom(
  ...(Object.keys(MATERIAL_TYPE_I18N) as (keyof typeof MATERIAL_TYPE_I18N)[])
);
const materialMaterialArb = fc.constantFrom(
  ...(Object.keys(MATERIAL_MATERIAL_I18N) as (keyof typeof MATERIAL_MATERIAL_I18N)[])
);
const gradeArb = fc.constantFrom('G1', 'G2', 'NY2', 'SHB');

/**
 * itemId の 1 セグメントとして現れうる文字列。
 * 既存マスターのコード、既存シードがマスター外の値を置く位置（DRIP の `MIX`）、
 * プロトタイプ由来のキー、そして任意文字列を混ぜる。
 * `-` を含む値はセグメント境界を壊すため除外する。
 */
const segmentArb = fc.oneof(
  fc.constantFrom(
    ...(Object.keys(VARIETY_I18N) as (keyof typeof VARIETY_I18N)[]),
    'MIX',
    'UNKNOWN',
    '__proto__',
    'constructor',
    'toString',
    ''
  ),
  fc.string({ minLength: 1, maxLength: 8 }).filter((s) => !s.includes('-'))
);

/** 末尾のバリアント連番（既存シードが派生 SKU に付与する `-V12` 等）。付与しない場合は空文字 */
const variantSuffixArb = fc.oneof(
  fc.constant(''),
  fc.integer({ min: 1, max: 2000 }).map((n) => `-V${n}`)
);

/** 既知の 6 パターンに一致する itemId */
const validItemIdArb = fc
  .tuple(
    fc.oneof(
      fc
        .tuple(originCodeArb, segmentArb)
        .map(([origin, variety]) => `ITEM#${origin}-${variety}-RAW`),
      fc
        .tuple(originCodeArb, segmentArb, gradeArb, roastCodeArb, productSizeArb)
        .map(([origin, variety, grade, roast, size]) =>
          `ITEM#${origin}-${variety}-${grade}-${roast}-${size}`
        ),
      fc
        .tuple(blendCodeArb, roastCodeArb, productSizeArb)
        .map(([blend, roast, size]) => `ITEM#BLEND-${blend}-${roast}-${size}`),
      fc
        .tuple(blendCodeArb, productSizeArb)
        .map(([blend, pack]) => `ITEM#DRIP-BLEND-${blend}-${pack}`),
      fc
        .tuple(originCodeArb, segmentArb, productSizeArb)
        .map(([origin, variety, pack]) => `ITEM#DRIP-${origin}-${variety}-${pack}`),
      fc
        .tuple(materialTypeArb, materialSizeArb, materialMaterialArb)
        .map(([type, size, material]) => `ITEM#MAT-${type}-${size}-${material}`)
    ),
    variantSuffixArb
  )
  .map(([base, variant]) => `${base}${variant}`);

/** 既存シードが実際に生成する 5,000 件の itemId（決定的なので 1 回だけ生成する） */
const SEED_SKUS: readonly SkuItem[] = generateSkus();

/**
 * Property 3 が要求する「*任意の* itemId 文字列」。
 * 既知パターン・既存シードの実値・接頭辞だけ一致する文字列・完全な任意文字列を混ぜる。
 */
const anyItemIdArb = fc.oneof(
  { weight: 4, arbitrary: validItemIdArb },
  { weight: 2, arbitrary: fc.constantFrom(...SEED_SKUS.map((sku) => sku.itemId)) },
  {
    weight: 2,
    arbitrary: fc.string({ maxLength: 24 }).map((s) => `ITEM#${s}`),
  },
  { weight: 1, arbitrary: fc.string({ maxLength: 32 }) },
  {
    weight: 1,
    arbitrary: fc.constantFrom('', 'ITEM#', 'ITEM#   ', 'ITEM', 'ITEM#-', 'ITEM#-V1', '#', '-'),
  }
);

/** 任意の itemName。既存シードの実値と任意文字列を混ぜる */
const anyItemNameArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...SEED_SKUS.map((sku) => sku.itemName)) },
  { weight: 2, arbitrary: fc.string({ maxLength: 40 }) },
  { weight: 1, arbitrary: fc.constantFrom('', ' ', '　', '\n', 'エチオピア イルガチェフェ G1 ミディアム 200g') }
);

// ============================================================
// 補助
// ============================================================

function assertNineFields(fields: SkuMetadataFields): void {
  expect(Object.keys(fields).sort()).toStrictEqual([...METADATA_FIELD_NAMES].sort());
  for (const name of METADATA_FIELD_NAMES) {
    expect(typeof fields[name]).toBe('string');
  }
}

/**
 * メタデータ付与のモデル。
 *
 * task 8.5（`phase = "copy"`）が Vector_Table へ書き込むレコード形状を模す。
 * 9 項目は `metaJa` / `metaEn` の下に**入れ子で**持たせ、既存 6 属性と同じ階層に展開しない。
 * この形状であることが Property 5 の保存則を構造的に保証する。
 */
function attachSkuMetadata(record: SkuItem): SkuItem & { metaJa: SkuMetadataFields; metaEn: SkuMetadataFields } {
  const metadata: SkuMetadata = deriveSkuMetadata(record.itemId, record.itemName);
  return { ...record, metaJa: metadata.ja, metaEn: metadata.en };
}

// ============================================================
// Property 3
// ============================================================

describe('sku-metadata の property テスト', () => {
  // Feature: vector-search-comparison, Property 3: 任意の itemId 文字列と任意の itemName に対して、
  // 日英のメタデータ導出は同一入力に対して常に同一の結果を返し、日本語形と英語形の双方に
  // 9 項目のキーが揃う。日本語の商品名は入力の itemName と等しく、英語の商品名は非空である。
  it('Property 3: Sku_Metadata 導出の決定論性と項目網羅性', () => {
    fc.assert(
      fc.property(anyItemIdArb, anyItemNameArb, anyItemIdArb, (itemId, itemName, otherItemId) => {
        const first = deriveSkuMetadata(itemId, itemName);

        // 別の入力を挟んでも結果が変わらない（モジュールスコープの可変状態を持たない）
        deriveSkuMetadata(otherItemId, 'interleaved');
        const second = deriveSkuMetadata(itemId, itemName);

        expect(second).toStrictEqual(first);

        assertNineFields(first.ja);
        assertNineFields(first.en);

        expect(first.ja.productName).toBe(itemName);
        expect(first.en.productName).not.toBe('');
      }),
      { numRuns: 300 }
    );
  });

  // ============================================================
  // Property 4
  // ============================================================

  // Feature: vector-search-comparison, Property 4: 任意の産地コードと焙煎度コードの組に対して、
  // 品種コードのみを変化させた 2 つの itemId は同一のフレーバーノート・ボディ・酸味を返す。
  // 任意の風味示唆ブレンド名コードの対に対して、ブレンド SKU のフレーバーノートは互いに異なる。
  // 任意の資材 itemId に対して、フレーバーノート・ボディ・酸味はいずれも空文字であり、
  // 説明文と用途説明は非空である。
  it('Property 4: 意味的属性の導出入力の制約', () => {
    // 4-a: 品種コードのみを変えても意味的属性が変わらない（V14 に対する回帰防止）
    fc.assert(
      fc.property(
        originCodeArb,
        roastCodeArb,
        gradeArb,
        productSizeArb,
        segmentArb,
        segmentArb,
        (origin, roast, grade, size, variety1, variety2) => {
          const roasted1 = deriveSkuMetadata(
            `ITEM#${origin}-${variety1}-${grade}-${roast}-${size}`,
            'A'
          );
          const roasted2 = deriveSkuMetadata(
            `ITEM#${origin}-${variety2}-${grade}-${roast}-${size}`,
            'B'
          );
          // 焙煎度を持たない生豆パターンでも同様に品種非依存であること
          const green1 = deriveSkuMetadata(`ITEM#${origin}-${variety1}-RAW`, 'A');
          const green2 = deriveSkuMetadata(`ITEM#${origin}-${variety2}-RAW`, 'B');

          for (const language of LANGUAGES) {
            for (const [x, y] of [
              [roasted1, roasted2],
              [green1, green2],
            ] as const) {
              expect(x[language].flavorNotes).toBe(y[language].flavorNotes);
              expect(x[language].body).toBe(y[language].body);
              expect(x[language].acidity).toBe(y[language].acidity);
            }
          }
        }
      ),
      { numRuns: 300 }
    );

    // 4-b: 風味を示唆するブレンド名コードの相異なる対は、相異なるフレーバーノートを返す
    const flavorBlendCodes = (Object.entries(BLEND_HINT) as [BlendCode, { kind: string }][])
      .filter(([, hint]) => hint.kind === 'flavor')
      .map(([code]) => code);
    expect(flavorBlendCodes.length).toBeGreaterThanOrEqual(8);

    const distinctFlavorPairs: [BlendCode, BlendCode][] = flavorBlendCodes.flatMap((left) =>
      flavorBlendCodes.filter((right) => right !== left).map((right) => [left, right] as [BlendCode, BlendCode])
    );

    fc.assert(
      fc.property(
        fc.constantFrom(...distinctFlavorPairs),
        roastCodeArb,
        productSizeArb,
        ([blend1, blend2], roast, size) => {
          const first = deriveSkuMetadata(`ITEM#BLEND-${blend1}-${roast}-${size}`, 'A');
          const second = deriveSkuMetadata(`ITEM#BLEND-${blend2}-${roast}-${size}`, 'B');

          for (const language of LANGUAGES) {
            expect(first[language].flavorNotes).not.toBe('');
            expect(second[language].flavorNotes).not.toBe('');
            expect(first[language].flavorNotes).not.toBe(second[language].flavorNotes);
          }
        }
      ),
      { numRuns: 300 }
    );

    // 4-c: 資材は風味・ボディ・酸味を持たず、説明文と用途説明を持つ（負例クラス）
    fc.assert(
      fc.property(
        fc.oneof(
          fc
            .tuple(materialTypeArb, materialSizeArb, materialMaterialArb, variantSuffixArb)
            .map(([type, size, material, variant]) => `ITEM#MAT-${type}-${size}-${material}${variant}`),
          // マスター未登録のコードでも同じ保証が成り立つこと
          fc
            .tuple(segmentArb, segmentArb, segmentArb)
            .map(([type, size, material]) => `ITEM#MAT-${type}-${size}-${material}`),
          fc.constantFrom(...SEED_SKUS.filter((sku) => isMaterialSku(sku.itemId)).map((sku) => sku.itemId))
        ),
        anyItemNameArb,
        (itemId, itemName) => {
          expect(isMaterialSku(itemId)).toBe(true);
          const metadata = deriveSkuMetadata(itemId, itemName);

          for (const language of LANGUAGES) {
            expect(metadata[language].flavorNotes).toBe('');
            expect(metadata[language].body).toBe('');
            expect(metadata[language].acidity).toBe('');
            expect(metadata[language].description).not.toBe('');
            expect(metadata[language].brewingRecommendation).not.toBe('');
          }
        }
      ),
      { numRuns: 300 }
    );
  });

  // ============================================================
  // Property 5
  // ============================================================

  // Feature: vector-search-comparison, Property 5: 任意の既存 SKU レコードに対して、
  // メタデータ付与および Vector_Table への複製の後も、itemId・itemName・quantity・
  // lotNumber・location・unitPrice の 6 属性は入力と等しい。
  it('Property 5: 既存シード出力の不変性', () => {
    // 9 項目のキー名が保存対象 6 属性と衝突しないこと。
    // 衝突があると付与形状を平坦化した時点で保存則が破れるため、構造として先に固定する
    for (const field of METADATA_FIELD_NAMES) {
      expect(PRESERVED_ATTRIBUTES as readonly string[]).not.toContain(field as string);
    }

    fc.assert(
      fc.property(fc.nat({ max: SEED_SKUS.length - 1 }), (index) => {
        const seed = SEED_SKUS[index]!;
        // 入力レコードの複製を渡し、導出が入力を書き換えないことも同時に確認する
        const input: SkuItem = { ...seed };
        const snapshot: SkuItem = { ...seed };

        const stored = attachSkuMetadata(input);

        expect(input).toStrictEqual(snapshot);

        for (const attribute of PRESERVED_ATTRIBUTES) {
          expect(stored[attribute]).toStrictEqual(snapshot[attribute]);
        }
        expect(Object.keys(stored).sort()).toStrictEqual(
          [...PRESERVED_ATTRIBUTES, 'metaJa', 'metaEn'].sort()
        );
        assertNineFields(stored.metaJa);
        assertNineFields(stored.metaEn);
      }),
      { numRuns: 300 }
    );
  });
});
