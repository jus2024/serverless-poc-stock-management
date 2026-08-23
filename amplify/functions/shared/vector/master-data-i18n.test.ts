import { describe, expect, it } from "vitest";

import { generateSkus } from "../../seed/sku-generator";
import {
  BLEND_HINT,
  CATEGORY_I18N,
  MATERIAL_MATERIAL_I18N,
  MATERIAL_PURPOSE,
  MATERIAL_TYPE_I18N,
  ORIGIN_FLAVOR,
  ORIGIN_I18N,
  ROAST_I18N,
  ROAST_PROFILE,
  SIZE_I18N,
  UNROASTED_PROFILE,
  VARIETY_I18N,
  type I18nText,
} from "./master-data-i18n";

/**
 * 日英マスターデータの整合性ユニットテスト。
 *
 * 検証する 3 点:
 * 1. 既存 `sku-generator.ts` の全コードに対応する日英エントリが欠けていない（過剰なキーもない）
 * 2. 日本語名が既存マスターの表示名と一致する
 * 3. 英語値が非空かつ ASCII 印字可能文字のみ
 *
 * 既存マスター（ORIGINS 等）は `sku-generator.ts` の内部 const であり export されていない。
 * そのため本ファイルに表示名の写しを持つが、写しが陳腐化しないよう
 * `generateSkus()` の出力（唯一の公開経路）から実際に使われているコード集合を再構成し、
 * 写しのコード集合と完全一致することを機械的に確認する。
 *
 * 要件: 2.1, 2.3
 */

// ============================================================
// 既存マスターの表示名の写し（`sku-generator.ts` と一致していること自体をテストする）
// ============================================================

/** 既存 ORIGINS（8 件） */
const ORIGINS_MIRROR: ReadonlyArray<{ code: string; ja: string }> = [
  { code: "ETH", ja: "エチオピア" },
  { code: "BRA", ja: "ブラジル" },
  { code: "COL", ja: "コロンビア" },
  { code: "GTM", ja: "グアテマラ" },
  { code: "KEN", ja: "ケニア" },
  { code: "IDN", ja: "インドネシア" },
  { code: "CRI", ja: "コスタリカ" },
  { code: "TZA", ja: "タンザニア" },
];

/** 既存 VARIETIES（4 件） */
const VARIETIES_MIRROR: ReadonlyArray<{ code: string; ja: string }> = [
  { code: "YIRG", ja: "イルガチェフェ" },
  { code: "SANT", ja: "サントス" },
  { code: "SUP", ja: "スプレモ" },
  { code: "SHB", ja: "SHB" },
];

/** 既存 ROAST_LEVELS（5 件） */
const ROAST_LEVELS_MIRROR: ReadonlyArray<{ code: string; ja: string }> = [
  { code: "LIGHT", ja: "ライト" },
  { code: "MEDIUM", ja: "ミディアム" },
  { code: "CITY", ja: "シティ" },
  { code: "FRENCH", ja: "フレンチ" },
  { code: "DARK", ja: "ダーク" },
];

/** 既存 BLEND_NAMES（20 件） */
const BLEND_NAMES_MIRROR: ReadonlyArray<{ code: string; ja: string }> = [
  { code: "MORNING", ja: "モーニング" },
  { code: "CLASSIC", ja: "クラシック" },
  { code: "PREMIUM", ja: "プレミアム" },
  { code: "ESPRESSO", ja: "エスプレッソ" },
  { code: "HOUSE", ja: "ハウス" },
  { code: "SEASONAL", ja: "シーズナル" },
  { code: "ORIGINAL", ja: "オリジナル" },
  { code: "RICH", ja: "リッチ" },
  { code: "MILD", ja: "マイルド" },
  { code: "DEEP", ja: "ディープ" },
  { code: "SMOOTH", ja: "スムース" },
  { code: "BOLD", ja: "ボールド" },
  { code: "FLORAL", ja: "フローラル" },
  { code: "FRUITY", ja: "フルーティー" },
  { code: "NUTTY", ja: "ナッティ" },
  { code: "CHOCO", ja: "チョコレート" },
  { code: "CARAMEL", ja: "キャラメル" },
  { code: "SPICY", ja: "スパイシー" },
  { code: "CITRUS", ja: "シトラス" },
  { code: "BERRY", ja: "ベリー" },
];

/**
 * 既存 ROASTED_SIZES / BLEND_SIZES / DRIP_PACK_SIZES の和集合（商品側の容量・パック数、8 件）。
 * 同一コード（200G / 500G）が ROASTED と BLEND の双方に現れるが表示名は同一である。
 */
const PRODUCT_SIZES_MIRROR: ReadonlyArray<{ code: string; ja: string }> = [
  { code: "100G", ja: "100g" },
  { code: "200G", ja: "200g" },
  { code: "500G", ja: "500g" },
  { code: "1KG", ja: "1kg" },
  { code: "5P", ja: "5個入" },
  { code: "10P", ja: "10個入" },
  { code: "20P", ja: "20個入" },
  { code: "30P", ja: "30個入" },
];

/** 既存 MATERIAL_TYPES（12 件） */
const MATERIAL_TYPES_MIRROR: ReadonlyArray<{ code: string; ja: string }> = [
  { code: "BAG", ja: "袋" },
  { code: "BOX", ja: "箱" },
  { code: "LABEL", ja: "ラベル" },
  { code: "SEAL", ja: "シール" },
  { code: "TAPE", ja: "テープ" },
  { code: "WRAP", ja: "包装紙" },
  { code: "CUP", ja: "カップ" },
  { code: "LID", ja: "フタ" },
  { code: "FILTER", ja: "フィルター" },
  { code: "TAG", ja: "タグ" },
  { code: "RIBBON", ja: "リボン" },
  { code: "CARD", ja: "カード" },
];

/**
 * 既存 MATERIAL_SIZES（8 件）。
 * 容量系のコードは商品側と衝突するが表示名が異なる（`200G` は商品側「200g」/ 資材側「200g用」）。
 */
const MATERIAL_SIZES_MIRROR: ReadonlyArray<{ code: string; ja: string }> = [
  { code: "100G", ja: "100g用" },
  { code: "200G", ja: "200g用" },
  { code: "500G", ja: "500g用" },
  { code: "1KG", ja: "1kg用" },
  { code: "S", ja: "S" },
  { code: "M", ja: "M" },
  { code: "L", ja: "L" },
  { code: "XL", ja: "XL" },
];

/** 既存 MATERIAL_MATERIALS（7 件） */
const MATERIAL_MATERIALS_MIRROR: ReadonlyArray<{ code: string; ja: string }> = [
  { code: "KRAFT", ja: "クラフト" },
  { code: "VALVE", ja: "バルブ付" },
  { code: "CLEAR", ja: "クリア" },
  { code: "ALU", ja: "アルミ" },
  { code: "PE", ja: "ポリエチレン" },
  { code: "PAPER", ja: "紙" },
  { code: "COTTON", ja: "綿" },
];

// ============================================================
// `generateSkus()` の itemId からコード集合を再構成する
// ============================================================

/**
 * 通し番号バリアント接尾辞（`-V123`）を除去する。
 * 既存ジェネレータは目標件数に達するまで `-V{n}` 付きの itemId を追加する。
 */
function stripVariantSuffix(body: string): string {
  return body.replace(/-V\d+$/, "");
}

interface ObservedCodes {
  origins: Set<string>;
  varieties: Set<string>;
  roastLevels: Set<string>;
  blends: Set<string>;
  productSizes: Set<string>;
  materialTypes: Set<string>;
  materialSizes: Set<string>;
  materialMaterials: Set<string>;
  /** 品種位置に現れるがマスターに存在しないトークン（バリアントの `MIX`） */
  nonMasterVarietyTokens: Set<string>;
}

/**
 * 実際に生成された 5,000 件の itemId を命名規則に沿って分解し、
 * 各ディメンションで使用されているコード集合を求める。
 */
function collectObservedCodes(): ObservedCodes {
  const observed: ObservedCodes = {
    origins: new Set(),
    varieties: new Set(),
    roastLevels: new Set(),
    blends: new Set(),
    productSizes: new Set(),
    materialTypes: new Set(),
    materialSizes: new Set(),
    materialMaterials: new Set(),
    nonMasterVarietyTokens: new Set(),
  };

  const masterVarietyCodes = new Set(VARIETIES_MIRROR.map((v) => v.code));

  for (const { itemId } of generateSkus()) {
    expect(itemId.startsWith("ITEM#")).toBe(true);
    const body = stripVariantSuffix(itemId.slice("ITEM#".length));

    if (body.startsWith("MAT-")) {
      // ITEM#MAT-{TYPE}-{SIZE}-{MATERIAL}
      const parts = body.slice("MAT-".length).split("-");
      expect(parts).toHaveLength(3);
      observed.materialTypes.add(parts[0]);
      observed.materialSizes.add(parts[1]);
      observed.materialMaterials.add(parts[2]);
      continue;
    }

    if (body.startsWith("DRIP-BLEND-")) {
      // ITEM#DRIP-BLEND-{BLEND}-{PACK}
      const parts = body.slice("DRIP-BLEND-".length).split("-");
      expect(parts).toHaveLength(2);
      observed.blends.add(parts[0]);
      observed.productSizes.add(parts[1]);
      continue;
    }

    if (body.startsWith("DRIP-")) {
      // ITEM#DRIP-{ORIGIN}-{VARIETY}-{PACK}
      const parts = body.slice("DRIP-".length).split("-");
      expect(parts).toHaveLength(3);
      observed.origins.add(parts[0]);
      if (masterVarietyCodes.has(parts[1])) {
        observed.varieties.add(parts[1]);
      } else {
        observed.nonMasterVarietyTokens.add(parts[1]);
      }
      observed.productSizes.add(parts[2]);
      continue;
    }

    if (body.startsWith("BLEND-")) {
      // ITEM#BLEND-{BLEND}-{ROAST}-{SIZE}
      const parts = body.slice("BLEND-".length).split("-");
      expect(parts).toHaveLength(3);
      observed.blends.add(parts[0]);
      observed.roastLevels.add(parts[1]);
      observed.productSizes.add(parts[2]);
      continue;
    }

    const parts = body.split("-");
    if (parts.length === 3 && parts[2] === "RAW") {
      // ITEM#{ORIGIN}-{VARIETY}-RAW
      observed.origins.add(parts[0]);
      observed.varieties.add(parts[1]);
      continue;
    }

    // ITEM#{ORIGIN}-{VARIETY}-{GRADE}-{ROAST}-{SIZE}
    expect(parts).toHaveLength(5);
    observed.origins.add(parts[0]);
    observed.varieties.add(parts[1]);
    observed.roastLevels.add(parts[3]);
    observed.productSizes.add(parts[4]);
  }

  return observed;
}

const OBSERVED = collectObservedCodes();

// ============================================================
// 検証ヘルパー
// ============================================================

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

/** 英語値として受理する文字集合: ASCII 印字可能文字のみ */
const ASCII_PRINTABLE = /^[\x20-\x7E]+$/;

interface CollectedText {
  /** 失敗時に位置を特定できる参照パス */
  path: string;
  text: I18nText;
}

/** 本モジュールが公開する全 `I18nText` を参照パス付きで集める */
function collectAllI18nTexts(): CollectedText[] {
  const collected: CollectedText[] = [];

  const pushRecord = (label: string, record: Record<string, I18nText>): void => {
    for (const [code, text] of Object.entries(record)) {
      collected.push({ path: `${label}.${code}`, text });
    }
  };

  pushRecord("ORIGIN_I18N", ORIGIN_I18N);
  pushRecord("ORIGIN_FLAVOR", ORIGIN_FLAVOR);
  pushRecord("CATEGORY_I18N", CATEGORY_I18N);
  pushRecord("ROAST_I18N", ROAST_I18N);
  pushRecord("SIZE_I18N.product", SIZE_I18N.product);
  pushRecord("SIZE_I18N.material", SIZE_I18N.material);
  pushRecord("MATERIAL_TYPE_I18N", MATERIAL_TYPE_I18N);
  pushRecord("MATERIAL_MATERIAL_I18N", MATERIAL_MATERIAL_I18N);
  pushRecord("VARIETY_I18N", VARIETY_I18N);

  for (const [code, profile] of Object.entries(ROAST_PROFILE)) {
    collected.push({ path: `ROAST_PROFILE.${code}.body`, text: profile.body });
    collected.push({ path: `ROAST_PROFILE.${code}.acidity`, text: profile.acidity });
  }
  collected.push({ path: "UNROASTED_PROFILE.body", text: UNROASTED_PROFILE.body });
  collected.push({ path: "UNROASTED_PROFILE.acidity", text: UNROASTED_PROFILE.acidity });

  for (const [code, purpose] of Object.entries(MATERIAL_PURPOSE)) {
    collected.push({ path: `MATERIAL_PURPOSE.${code}.description`, text: purpose.description });
    collected.push({ path: `MATERIAL_PURPOSE.${code}.usage`, text: purpose.usage });
  }

  // `neutral` の 7 件は ja / en の値を持たないため対象外
  for (const [code, hint] of Object.entries(BLEND_HINT)) {
    if (hint.kind === "neutral") continue;
    collected.push({ path: `BLEND_HINT.${code}.hint`, text: hint.hint });
  }

  return collected;
}

const ALL_TEXTS = collectAllI18nTexts();

// ============================================================
// 1. 写しが `sku-generator.ts` の実出力と一致していること
// ============================================================

describe("既存マスターの写しが sku-generator.ts の実出力と一致する", () => {
  it("生成された itemId のコード集合が写しのコード集合と完全一致する", () => {
    expect(sorted(OBSERVED.origins)).toEqual(sorted(ORIGINS_MIRROR.map((m) => m.code)));
    expect(sorted(OBSERVED.varieties)).toEqual(sorted(VARIETIES_MIRROR.map((m) => m.code)));
    expect(sorted(OBSERVED.roastLevels)).toEqual(sorted(ROAST_LEVELS_MIRROR.map((m) => m.code)));
    expect(sorted(OBSERVED.blends)).toEqual(sorted(BLEND_NAMES_MIRROR.map((m) => m.code)));
    expect(sorted(OBSERVED.productSizes)).toEqual(sorted(PRODUCT_SIZES_MIRROR.map((m) => m.code)));
    expect(sorted(OBSERVED.materialTypes)).toEqual(sorted(MATERIAL_TYPES_MIRROR.map((m) => m.code)));
    expect(sorted(OBSERVED.materialSizes)).toEqual(sorted(MATERIAL_SIZES_MIRROR.map((m) => m.code)));
    expect(sorted(OBSERVED.materialMaterials)).toEqual(
      sorted(MATERIAL_MATERIALS_MIRROR.map((m) => m.code))
    );
  });

  it("写しの表示名が生成された itemName に実際に現れる", () => {
    const itemNames = generateSkus().map((s) => s.itemName);
    const allMirrors = [
      ...ORIGINS_MIRROR,
      ...VARIETIES_MIRROR,
      ...ROAST_LEVELS_MIRROR,
      ...BLEND_NAMES_MIRROR,
      ...PRODUCT_SIZES_MIRROR,
      ...MATERIAL_TYPES_MIRROR,
      ...MATERIAL_SIZES_MIRROR,
      ...MATERIAL_MATERIALS_MIRROR,
    ];

    const missing = allMirrors
      .filter(({ ja }) => !itemNames.some((itemName) => itemName.includes(ja)))
      .map(({ code, ja }) => `${code}=${ja}`);

    expect(missing).toEqual([]);
  });

  it("品種位置のマスター外トークンはバリアント用の MIX のみである", () => {
    // MIX は既存 VARIETIES に存在しない補充バリアント専用トークンであり、
    // VARIETY_I18N の対象外であることを明示的に固定する
    expect(sorted(OBSERVED.nonMasterVarietyTokens)).toEqual(["MIX"]);
  });
});

// ============================================================
// 2. 全コードに対応する日英エントリが欠けていない
// ============================================================

describe("全コードに対応する日英エントリが存在する", () => {
  it("マスターごとの件数が既存の定義と一致する", () => {
    expect(ORIGINS_MIRROR).toHaveLength(8);
    expect(VARIETIES_MIRROR).toHaveLength(4);
    expect(ROAST_LEVELS_MIRROR).toHaveLength(5);
    expect(BLEND_NAMES_MIRROR).toHaveLength(20);
    expect(MATERIAL_TYPES_MIRROR).toHaveLength(12);
    expect(MATERIAL_SIZES_MIRROR).toHaveLength(8);
    expect(MATERIAL_MATERIALS_MIRROR).toHaveLength(7);
    expect(PRODUCT_SIZES_MIRROR).toHaveLength(8);
  });

  it("ORIGIN_I18N が 8 産地を過不足なく覆う", () => {
    expect(sorted(Object.keys(ORIGIN_I18N))).toEqual(sorted(ORIGINS_MIRROR.map((m) => m.code)));
  });

  it("ORIGIN_FLAVOR が 8 産地を過不足なく覆う", () => {
    expect(sorted(Object.keys(ORIGIN_FLAVOR))).toEqual(sorted(ORIGINS_MIRROR.map((m) => m.code)));
  });

  it("VARIETY_I18N が 4 品種を過不足なく覆う", () => {
    expect(sorted(Object.keys(VARIETY_I18N))).toEqual(sorted(VARIETIES_MIRROR.map((m) => m.code)));
  });

  it("ROAST_I18N が 5 焙煎度を過不足なく覆う", () => {
    expect(sorted(Object.keys(ROAST_I18N))).toEqual(sorted(ROAST_LEVELS_MIRROR.map((m) => m.code)));
  });

  it("ROAST_PROFILE が 5 焙煎度を過不足なく覆い、ボディと酸味の両方を持つ", () => {
    expect(sorted(Object.keys(ROAST_PROFILE))).toEqual(
      sorted(ROAST_LEVELS_MIRROR.map((m) => m.code))
    );
    for (const [code, profile] of Object.entries(ROAST_PROFILE)) {
      expect(profile.body, `ROAST_PROFILE.${code}.body`).toBeDefined();
      expect(profile.acidity, `ROAST_PROFILE.${code}.acidity`).toBeDefined();
    }
  });

  it("BLEND_HINT が 20 ブレンドを過不足なく覆う", () => {
    expect(sorted(Object.keys(BLEND_HINT))).toEqual(sorted(BLEND_NAMES_MIRROR.map((m) => m.code)));
  });

  it("BLEND_HINT の分類が風味 8 / ボディ 5 / 中立 7 である", () => {
    const byKind = { flavor: [] as string[], body: [] as string[], neutral: [] as string[] };
    for (const [code, hint] of Object.entries(BLEND_HINT)) {
      byKind[hint.kind].push(code);
    }

    expect(sorted(byKind.flavor)).toEqual(
      sorted(["FRUITY", "NUTTY", "CHOCO", "CARAMEL", "CITRUS", "BERRY", "FLORAL", "SPICY"])
    );
    expect(sorted(byKind.body)).toEqual(sorted(["RICH", "MILD", "DEEP", "SMOOTH", "BOLD"]));
    expect(sorted(byKind.neutral)).toEqual(
      sorted(["MORNING", "CLASSIC", "PREMIUM", "ESPRESSO", "HOUSE", "SEASONAL", "ORIGINAL"])
    );
  });

  it("MATERIAL_TYPE_I18N が 12 資材タイプを過不足なく覆う", () => {
    expect(sorted(Object.keys(MATERIAL_TYPE_I18N))).toEqual(
      sorted(MATERIAL_TYPES_MIRROR.map((m) => m.code))
    );
  });

  it("MATERIAL_PURPOSE が 12 資材タイプを過不足なく覆い、説明文と用途説明の両方を持つ", () => {
    expect(sorted(Object.keys(MATERIAL_PURPOSE))).toEqual(
      sorted(MATERIAL_TYPES_MIRROR.map((m) => m.code))
    );
    for (const [code, purpose] of Object.entries(MATERIAL_PURPOSE)) {
      expect(purpose.description, `MATERIAL_PURPOSE.${code}.description`).toBeDefined();
      expect(purpose.usage, `MATERIAL_PURPOSE.${code}.usage`).toBeDefined();
    }
  });

  it("MATERIAL_MATERIAL_I18N が 7 資材素材を過不足なく覆う", () => {
    expect(sorted(Object.keys(MATERIAL_MATERIAL_I18N))).toEqual(
      sorted(MATERIAL_MATERIALS_MIRROR.map((m) => m.code))
    );
  });

  it("SIZE_I18N.material が 8 資材サイズを過不足なく覆う", () => {
    expect(sorted(Object.keys(SIZE_I18N.material))).toEqual(
      sorted(MATERIAL_SIZES_MIRROR.map((m) => m.code))
    );
  });

  it("SIZE_I18N.product が商品側の 8 容量・パック数を過不足なく覆う", () => {
    expect(sorted(Object.keys(SIZE_I18N.product))).toEqual(
      sorted(PRODUCT_SIZES_MIRROR.map((m) => m.code))
    );
  });

  it("CATEGORY_I18N が itemId パターンから導出される 5 カテゴリを覆う", () => {
    expect(sorted(Object.keys(CATEGORY_I18N))).toEqual(
      sorted(["GREEN_BEANS", "ROASTED_BEANS", "BLEND", "DRIP_BAG", "MATERIAL"])
    );
  });
});

// ============================================================
// 3. 日本語名が既存マスターの表示名と一致する
// ============================================================

describe("日本語名が既存マスターの表示名と一致する", () => {
  it.each(ORIGINS_MIRROR)("ORIGIN_I18N[$code].ja === $ja", ({ code, ja }) => {
    expect(ORIGIN_I18N[code as keyof typeof ORIGIN_I18N].ja).toBe(ja);
  });

  it.each(VARIETIES_MIRROR)("VARIETY_I18N[$code].ja === $ja", ({ code, ja }) => {
    expect(VARIETY_I18N[code as keyof typeof VARIETY_I18N].ja).toBe(ja);
  });

  it.each(ROAST_LEVELS_MIRROR)("ROAST_I18N[$code].ja === $ja", ({ code, ja }) => {
    expect(ROAST_I18N[code as keyof typeof ROAST_I18N].ja).toBe(ja);
  });

  it.each(PRODUCT_SIZES_MIRROR)("SIZE_I18N.product[$code].ja === $ja", ({ code, ja }) => {
    expect(SIZE_I18N.product[code as keyof typeof SIZE_I18N.product].ja).toBe(ja);
  });

  it.each(MATERIAL_SIZES_MIRROR)("SIZE_I18N.material[$code].ja === $ja", ({ code, ja }) => {
    expect(SIZE_I18N.material[code as keyof typeof SIZE_I18N.material].ja).toBe(ja);
  });

  it.each(MATERIAL_TYPES_MIRROR)("MATERIAL_TYPE_I18N[$code].ja === $ja", ({ code, ja }) => {
    expect(MATERIAL_TYPE_I18N[code as keyof typeof MATERIAL_TYPE_I18N].ja).toBe(ja);
  });

  it.each(MATERIAL_MATERIALS_MIRROR)(
    "MATERIAL_MATERIAL_I18N[$code].ja === $ja",
    ({ code, ja }) => {
      expect(MATERIAL_MATERIAL_I18N[code as keyof typeof MATERIAL_MATERIAL_I18N].ja).toBe(ja);
    }
  );

  it("商品側と資材側で容量コードの日本語名が独立している", () => {
    // 同一コードでも表示名は別物であり、片方の写し間違いを取り違えないことを固定する
    for (const code of ["100G", "200G", "500G", "1KG"] as const) {
      expect(SIZE_I18N.material[code].ja).not.toBe(SIZE_I18N.product[code].ja);
      expect(SIZE_I18N.material[code].ja).toBe(`${SIZE_I18N.product[code].ja}用`);
    }
  });
});

// ============================================================
// 4. 英語値が非空かつ ASCII 印字可能文字のみ
// ============================================================

describe("英語値が非空かつ ASCII 印字可能文字のみである", () => {
  it("収集対象が本モジュールの全マッピング表を網羅している", () => {
    const topLevels = new Set(ALL_TEXTS.map(({ path }) => path.split(".")[0]));
    expect(sorted(topLevels)).toEqual(
      sorted([
        "ORIGIN_I18N",
        "ORIGIN_FLAVOR",
        "ROAST_PROFILE",
        "UNROASTED_PROFILE",
        "BLEND_HINT",
        "MATERIAL_PURPOSE",
        "CATEGORY_I18N",
        "ROAST_I18N",
        "SIZE_I18N",
        "MATERIAL_TYPE_I18N",
        "MATERIAL_MATERIAL_I18N",
        "VARIETY_I18N",
      ])
    );
    expect(ALL_TEXTS.length).toBeGreaterThan(0);
  });

  it("すべての英語値が非空である（前後空白のみの値も許容しない）", () => {
    const offenders = ALL_TEXTS.filter(({ text }) => text.en.trim().length === 0).map(
      ({ path }) => path
    );
    expect(offenders).toEqual([]);
  });

  it("すべての英語値が ASCII 印字可能文字のみで構成される", () => {
    const offenders = ALL_TEXTS.filter(({ text }) => !ASCII_PRINTABLE.test(text.en)).map(
      ({ path, text }) => `${path}: ${text.en}`
    );
    expect(offenders).toEqual([]);
  });

  it("すべての英語値に前後の余分な空白がない", () => {
    const offenders = ALL_TEXTS.filter(({ text }) => text.en !== text.en.trim()).map(
      ({ path }) => path
    );
    expect(offenders).toEqual([]);
  });

  it("すべての日本語値が非空である", () => {
    const offenders = ALL_TEXTS.filter(({ text }) => text.ja.trim().length === 0).map(
      ({ path }) => path
    );
    expect(offenders).toEqual([]);
  });
});
