/**
 * Sku_Metadata 導出（純関数）
 *
 * itemId と既存の itemName から、日本語形・英語形それぞれ 9 項目の意味的メタデータを導出する。
 *
 * 設計上の要点:
 * - 実行時の乱数・時刻・ネットワークを使わない。入力が同じなら常に同じ結果を返す（要件 2.2）
 * - 風味・ボディ・酸味は**産地コードと焙煎度コード**から導出し、品種コードを入力にしない。
 *   既存マスターは産地と品種を独立に組み合わせるため（「ブラジル イルガチェフェ」等）、
 *   品種から風味を導出すると意味的に矛盾した埋め込みが大量に生まれる（要件 2.4 / A15）
 * - ブレンドは産地を持たないため、ブレンド名コードを追加入力にする（要件 2.5）
 * - 資材は風味・ボディ・酸味を空文字とし、`MATERIAL_PURPOSE` から説明文と用途説明を与える（要件 2.6）
 * - `ja.productName` は入力の itemName をそのまま採用し、`en.productName` は itemId の
 *   コード列を英語マスターで写して組み立てる（要件 2.3）
 * - 全域関数である。未知の itemId 形式・未知のコードでも例外を投げず、
 *   9 項目が揃ったメタデータを返す（`en.productName` は常に非空）
 *
 * 既存の itemId / itemName / quantity / lotNumber / location / unitPrice は本モジュールが
 * 一切変更しない。付与するのは追加のメタデータ属性のみである（要件 2.7）。
 *
 * 要件: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 * 設計: Sku_Metadata 導出（純関数）
 */

import type { VectorLanguage } from './language';
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
  type BlendCode,
  type I18nText,
  type MaterialMaterialCode,
  type MaterialSizeCode,
  type MaterialTypeCode,
  type OriginCode,
  type ProductSizeCode,
  type RoastCode,
  type SkuCategoryCode,
  type VarietyCode,
} from './master-data-i18n';

export type { VectorLanguage };

// ============================================================
// 公開型
// ============================================================

/** 1 言語分の意味的メタデータ。9 項目固定 */
export interface SkuMetadataFields {
  productName: string;
  category: string;
  origin: string;
  roastLevel: string;
  flavorNotes: string;
  body: string;
  acidity: string;
  description: string;
  brewingRecommendation: string;
}

/** 日本語形と英語形の 2 組 */
export interface SkuMetadata {
  ja: SkuMetadataFields;
  en: SkuMetadataFields;
}

/**
 * itemId の解析結果。
 * `category` が null のときは既知の 6 パターンのいずれにも一致しなかったことを示す。
 * 各コードは既存マスターに存在することを確認済みのものだけが入る（未知コードは undefined）。
 */
export interface ParsedSkuId {
  category: SkuCategoryCode | null;
  origin?: OriginCode;
  variety?: VarietyCode;
  /** 品種位置の生コード。マスター未登録の値（DRIP の `MIX` 等）の表示に使う */
  varietyRaw?: string;
  grade?: string;
  roast?: RoastCode;
  blend?: BlendCode;
  productSize?: ProductSizeCode;
  materialType?: MaterialTypeCode;
  materialSize?: MaterialSizeCode;
  materialMaterial?: MaterialMaterialCode;
  /** 派生バリアントの連番サフィックス（`V12` 等）。無い場合は undefined */
  variant?: string;
}

// ============================================================
// 本モジュール固有の固定辞書
// ============================================================

/**
 * ブレンド名コードの英語表示。
 *
 * `master-data-i18n.ts` の `BLEND_HINT` は風味・ボディの示唆のみを持ち（風味中立の 7 件は値を持たない）、
 * `en.productName` の組み立てには使えないため、表示専用の辞書を本モジュールに置く。
 * 既存マスター（`BLEND_NAMES`）と `master-data-i18n.ts` はいずれも変更しない。
 */
const BLEND_NAME_EN: Record<BlendCode, string> = {
  MORNING: 'Morning',
  CLASSIC: 'Classic',
  PREMIUM: 'Premium',
  ESPRESSO: 'Espresso',
  HOUSE: 'House',
  SEASONAL: 'Seasonal',
  ORIGINAL: 'Original',
  RICH: 'Rich',
  MILD: 'Mild',
  DEEP: 'Deep',
  SMOOTH: 'Smooth',
  BOLD: 'Bold',
  FLORAL: 'Floral',
  FRUITY: 'Fruity',
  NUTTY: 'Nutty',
  CHOCO: 'Chocolate',
  CARAMEL: 'Caramel',
  SPICY: 'Spicy',
  CITRUS: 'Citrus',
  BERRY: 'Berry',
};

/** 焙煎度ごとの抽出推奨（焙煎豆・ブレンド共通） */
const BREWING_BY_ROAST: Record<RoastCode, I18nText> = {
  LIGHT: {
    ja: 'ペーパードリップで湯温 90 度前後、細めの挽きで抽出する',
    en: 'brew as pour over at about 90C with a fine grind',
  },
  MEDIUM: {
    ja: 'ペーパードリップで湯温 88 度前後、中細挽きで抽出する',
    en: 'brew as pour over at about 88C with a medium-fine grind',
  },
  CITY: {
    ja: 'ペーパードリップまたはフレンチプレスで湯温 86 度前後、中挽きで抽出する',
    en: 'brew as pour over or french press at about 86C with a medium grind',
  },
  FRENCH: {
    ja: 'エスプレッソまたはフレンチプレスで湯温 84 度前後、中粗挽きで抽出する',
    en: 'brew as espresso or french press at about 84C with a medium-coarse grind',
  },
  DARK: {
    ja: 'エスプレッソやアイスコーヒー、ミルクと合わせる用途で抽出する',
    en: 'brew for espresso, iced coffee, or milk based drinks',
  },
};

/** 生豆の抽出推奨（未焙煎のため焙煎工程を案内する） */
const BREWING_GREEN: I18nText = {
  ja: '焙煎してから抽出する。焙煎度は用途に合わせて選ぶ',
  en: 'roast before brewing and choose the roast level to suit the intended use',
};

/** ドリップバッグの抽出推奨 */
const BREWING_DRIP: I18nText = {
  ja: 'カップに載せて湯を 150 ml から 180 ml 注いで抽出する',
  en: 'set on a cup and pour 150 to 180 ml of hot water',
};

/** 焙煎度が特定できない場合の抽出推奨 */
const BREWING_DEFAULT: I18nText = {
  ja: '挽きたての粉をペーパードリップで抽出する',
  en: 'grind fresh and brew as pour over',
};

/** 資材タイプが特定できない場合の説明文と用途説明 */
const MATERIAL_PURPOSE_FALLBACK: { description: I18nText; usage: I18nText } = {
  description: {
    ja: 'コーヒーの包装と出荷に使う資材',
    en: 'packaging material used for coffee packing and shipping',
  },
  usage: {
    ja: '商品の包装や梱包の用途で使う',
    en: 'used for product packaging and packing',
  },
};

/** `en.productName` を組み立てられなかった場合の最終フォールバック */
const UNKNOWN_PRODUCT_NAME_EN = 'unknown product';

const ITEM_ID_PREFIX = 'ITEM#';
const VARIANT_PATTERN = /^V\d+$/;

// ============================================================
// 公開関数
// ============================================================

/**
 * itemId と既存 itemName から日英の意味的メタデータを導出する。
 * 同一入力に対して常に同一の結果を返す（固定辞書のみを使用し、実行時の乱数を使わない）。
 */
export function deriveSkuMetadata(itemId: string, itemName: string): SkuMetadata {
  const parsed = parseSkuItemId(itemId);
  return {
    ja: buildFields('ja', parsed, itemId, itemName),
    en: buildFields('en', parsed, itemId, itemName),
  };
}

/**
 * itemId を既知の 6 パターンに照合する。
 *
 * | パターン | category |
 * |---|---|
 * | `ITEM#{ORIGIN}-{VARIETY}-RAW` | GREEN_BEANS |
 * | `ITEM#{ORIGIN}-{VARIETY}-{GRADE}-{ROAST}-{SIZE}` | ROASTED_BEANS |
 * | `ITEM#BLEND-{BLEND}-{ROAST}-{SIZE}` | BLEND |
 * | `ITEM#DRIP-BLEND-{BLEND}-{PACK}` | DRIP_BAG |
 * | `ITEM#DRIP-{ORIGIN}-{VARIETY}-{PACK}` | DRIP_BAG |
 * | `ITEM#MAT-{TYPE}-{SIZE}-{MATERIAL}` | MATERIAL |
 *
 * 末尾の `-V{n}` はバリアント連番として切り離す（既存シードが派生 SKU に付与する）。
 * いずれにも一致しない場合は `category: null` を返し、例外は投げない。
 */
export function parseSkuItemId(itemId: string): ParsedSkuId {
  if (typeof itemId !== 'string' || !itemId.startsWith(ITEM_ID_PREFIX)) {
    return { category: null };
  }

  const segments = itemId.slice(ITEM_ID_PREFIX.length).split('-');
  let variant: string | undefined;
  const last = segments[segments.length - 1];
  if (segments.length > 1 && last !== undefined && VARIANT_PATTERN.test(last)) {
    segments.pop();
    variant = last;
  }

  const head = segments[0];
  if (head === undefined || head === '') {
    return { category: null };
  }

  if (head === 'MAT') {
    return {
      category: 'MATERIAL',
      materialType: lookupKey(MATERIAL_TYPE_I18N, segments[1]),
      materialSize: lookupKey(SIZE_I18N.material, segments[2]),
      materialMaterial: lookupKey(MATERIAL_MATERIAL_I18N, segments[3]),
      variant,
    };
  }

  if (head === 'DRIP') {
    if (segments[1] === 'BLEND') {
      return {
        category: 'DRIP_BAG',
        blend: lookupKey(BLEND_HINT, segments[2]),
        productSize: lookupKey(SIZE_I18N.product, segments[3]),
        variant,
      };
    }
    return {
      category: 'DRIP_BAG',
      origin: lookupKey(ORIGIN_I18N, segments[1]),
      variety: lookupKey(VARIETY_I18N, segments[2]),
      varietyRaw: segments[2],
      productSize: lookupKey(SIZE_I18N.product, segments[3]),
      variant,
    };
  }

  if (head === 'BLEND') {
    return {
      category: 'BLEND',
      blend: lookupKey(BLEND_HINT, segments[1]),
      roast: lookupKey(ROAST_I18N, segments[2]),
      productSize: lookupKey(SIZE_I18N.product, segments[3]),
      variant,
    };
  }

  if (segments.length === 3 && segments[2] === 'RAW') {
    return {
      category: 'GREEN_BEANS',
      origin: lookupKey(ORIGIN_I18N, segments[0]),
      variety: lookupKey(VARIETY_I18N, segments[1]),
      varietyRaw: segments[1],
      variant,
    };
  }

  if (segments.length === 5) {
    return {
      category: 'ROASTED_BEANS',
      origin: lookupKey(ORIGIN_I18N, segments[0]),
      variety: lookupKey(VARIETY_I18N, segments[1]),
      varietyRaw: segments[1],
      grade: segments[2],
      roast: lookupKey(ROAST_I18N, segments[3]),
      productSize: lookupKey(SIZE_I18N.product, segments[4]),
      variant,
    };
  }

  return { category: null, variant };
}

/** Material_Sku（資材カテゴリ）であるかを判定する。負例クラスの計数に使う */
export function isMaterialSku(itemId: string): boolean {
  return parseSkuItemId(itemId).category === 'MATERIAL';
}

// ============================================================
// 内部実装
// ============================================================

/** 1 言語分の 9 項目を組み立てる */
function buildFields(
  language: VectorLanguage,
  parsed: ParsedSkuId,
  itemId: string,
  itemName: string
): SkuMetadataFields {
  const semantic = deriveSemantics(language, parsed);

  return {
    // ja は既存 itemName をそのまま採用する（要件 2.3）
    productName: language === 'ja' ? itemName : buildProductNameEn(parsed, itemId),
    category: parsed.category ? pick(CATEGORY_I18N[parsed.category], language) : '',
    origin: parsed.origin ? pick(ORIGIN_I18N[parsed.origin], language) : '',
    roastLevel: parsed.roast ? pick(ROAST_I18N[parsed.roast], language) : '',
    flavorNotes: semantic.flavorNotes,
    body: semantic.body,
    acidity: semantic.acidity,
    description: buildDescription(language, parsed, semantic),
    brewingRecommendation: buildBrewingRecommendation(language, parsed),
  };
}

interface Semantics {
  flavorNotes: string;
  body: string;
  acidity: string;
}

/**
 * 風味・ボディ・酸味を導出する。
 *
 * 入力は**産地コードと焙煎度コード**（ブレンドはブレンド名コードを追加）のみで、
 * 品種コードは一切参照しない（要件 2.4）。資材は 3 項目すべて空文字（要件 2.6）。
 */
function deriveSemantics(language: VectorLanguage, parsed: ParsedSkuId): Semantics {
  const empty: Semantics = { flavorNotes: '', body: '', acidity: '' };

  switch (parsed.category) {
    case 'GREEN_BEANS':
      // 未焙煎のため焙煎度を持たない。ボディ・酸味は未焙煎相当の固定値
      return {
        flavorNotes: parsed.origin ? pick(ORIGIN_FLAVOR[parsed.origin], language) : '',
        body: pick(UNROASTED_PROFILE.body, language),
        acidity: pick(UNROASTED_PROFILE.acidity, language),
      };

    case 'ROASTED_BEANS': {
      const profile = parsed.roast ? ROAST_PROFILE[parsed.roast] : undefined;
      return {
        flavorNotes: parsed.origin ? pick(ORIGIN_FLAVOR[parsed.origin], language) : '',
        body: profile ? pick(profile.body, language) : '',
        acidity: profile ? pick(profile.acidity, language) : '',
      };
    }

    case 'BLEND': {
      // 産地を持たないため ORIGIN_FLAVOR が使えない。ブレンド名コードが風味・ボディの供給源
      const hint = parsed.blend ? BLEND_HINT[parsed.blend] : undefined;
      const profile = parsed.roast ? ROAST_PROFILE[parsed.roast] : undefined;
      return {
        flavorNotes: hint?.kind === 'flavor' ? pick(hint.hint, language) : '',
        body:
          hint?.kind === 'body'
            ? pick(hint.hint, language)
            : profile
              ? pick(profile.body, language)
              : '',
        acidity: profile ? pick(profile.acidity, language) : '',
      };
    }

    case 'DRIP_BAG': {
      // 焙煎度をコードに持たないため、酸味は導出しない
      if (parsed.blend) {
        const hint = BLEND_HINT[parsed.blend];
        return {
          flavorNotes: hint.kind === 'flavor' ? pick(hint.hint, language) : '',
          body: hint.kind === 'body' ? pick(hint.hint, language) : '',
          acidity: '',
        };
      }
      return {
        flavorNotes: parsed.origin ? pick(ORIGIN_FLAVOR[parsed.origin], language) : '',
        body: '',
        acidity: '',
      };
    }

    case 'MATERIAL':
      // 負例クラス。風味に関する意味的クエリに対して上位に現れないよう 3 項目を空にする
      return empty;

    default:
      return empty;
  }
}

/** 資材の説明文と用途説明を取り出す（タイプ未特定時は汎用文にフォールバック） */
function materialPurpose(parsed: ParsedSkuId): { description: I18nText; usage: I18nText } {
  return parsed.materialType
    ? MATERIAL_PURPOSE[parsed.materialType]
    : MATERIAL_PURPOSE_FALLBACK;
}

/** 説明文を組み立てる */
function buildDescription(
  language: VectorLanguage,
  parsed: ParsedSkuId,
  semantic: Semantics
): string {
  const origin = parsed.origin ? pick(ORIGIN_I18N[parsed.origin], language) : '';
  const roast = parsed.roast ? pick(ROAST_I18N[parsed.roast], language) : '';
  const ja = language === 'ja';

  switch (parsed.category) {
    case 'GREEN_BEANS': {
      const parts = ja
        ? [
            origin ? `${origin}産の生豆。` : '生豆。',
            '未焙煎の状態で保管し、焙煎してから抽出する。',
            semantic.flavorNotes ? `焙煎すると${semantic.flavorNotes}の風味が出る。` : '',
          ]
        : [
            origin ? `Green coffee beans from ${origin}.` : 'Green coffee beans.',
            'Stored unroasted and roasted before brewing.',
            semantic.flavorNotes ? `Once roasted they show ${semantic.flavorNotes} notes.` : '',
          ];
      return joinSentences(parts);
    }

    case 'ROASTED_BEANS': {
      const parts = ja
        ? [
            `${origin ? `${origin}産の豆を` : ''}${roast ? `${roast}で焙煎した` : ''}焙煎豆。`,
            semantic.flavorNotes ? `${semantic.flavorNotes}の風味。` : '',
            describeBodyAcidityJa(semantic),
          ]
        : [
            `Roasted coffee beans${origin ? ` from ${origin}` : ''}${roast ? ` at a ${roast} roast` : ''}.`,
            semantic.flavorNotes ? `Flavor notes of ${semantic.flavorNotes}.` : '',
            describeBodyAcidityEn(semantic),
          ];
      return joinSentences(parts);
    }

    case 'BLEND': {
      const blend = parsed.blend ? blendDisplayName(parsed.blend, language) : '';
      const parts = ja
        ? [
            `複数の産地の豆を組み合わせた${blend ? `${blend}系の` : ''}ブレンド。`,
            roast ? `${roast}で焙煎している。` : '',
            semantic.flavorNotes ? `${semantic.flavorNotes}の風味。` : '',
            describeBodyAcidityJa(semantic),
          ]
        : [
            `A ${blend ? `${blend} ` : ''}blend of beans from multiple origins.`,
            roast ? `Roasted to a ${roast} roast.` : '',
            semantic.flavorNotes ? `Flavor notes of ${semantic.flavorNotes}.` : '',
            describeBodyAcidityEn(semantic),
          ];
      return joinSentences(parts);
    }

    case 'DRIP_BAG': {
      const blend = parsed.blend ? blendDisplayName(parsed.blend, language) : '';
      const source = ja
        ? parsed.blend
          ? `${blend ? `${blend}系の` : ''}ブレンドを使用している。`
          : origin
            ? `${origin}産の豆を使用している。`
            : ''
        : blend
          ? `Made with the ${blend} blend.`
          : origin
            ? `Made with beans from ${origin}.`
            : '';
      const parts = ja
        ? [
            '湯を注ぐだけで抽出できるドリップバッグ。',
            source,
            semantic.flavorNotes ? `${semantic.flavorNotes}の風味を手軽に楽しめる。` : '',
          ]
        : [
            'A drip bag brewed simply by pouring hot water.',
            source,
            semantic.flavorNotes ? `It offers ${semantic.flavorNotes} notes with little effort.` : '',
          ];
      return joinSentences(parts);
    }

    case 'MATERIAL': {
      const purpose = materialPurpose(parsed);
      const size = parsed.materialSize ? pick(SIZE_I18N.material[parsed.materialSize], language) : '';
      const material = parsed.materialMaterial
        ? pick(MATERIAL_MATERIAL_I18N[parsed.materialMaterial], language)
        : '';
      const detail = ja
        ? [size ? `サイズは${size}。` : '', material ? `素材は${material}。` : '']
        : [size ? `Size ${size}.` : '', material ? `Material ${material}.` : ''];
      return joinSentences([
        ja
          ? `${pick(purpose.description, 'ja')}。`
          : `${capitalizeFirst(pick(purpose.description, 'en'))}.`,
        ...detail,
      ]);
    }

    default:
      return '';
  }
}

/** 抽出推奨（資材は用途説明）を組み立てる */
function buildBrewingRecommendation(language: VectorLanguage, parsed: ParsedSkuId): string {
  switch (parsed.category) {
    case 'GREEN_BEANS':
      return `${pick(BREWING_GREEN, language)}${terminator(language)}`;
    case 'ROASTED_BEANS':
    case 'BLEND': {
      const brewing = parsed.roast ? BREWING_BY_ROAST[parsed.roast] : BREWING_DEFAULT;
      return `${pick(brewing, language)}${terminator(language)}`;
    }
    case 'DRIP_BAG':
      return `${pick(BREWING_DRIP, language)}${terminator(language)}`;
    case 'MATERIAL':
      return `${pick(materialPurpose(parsed).usage, language)}${terminator(language)}`;
    default:
      return '';
  }
}

/**
 * `en.productName` を itemId のコード列から組み立てる。
 * 英語マスターに無いコードはコードの生値を小文字化して残す（DRIP の `MIX` 等）。
 * 組み立て結果が空になる場合は itemId 由来のフォールバックを返し、常に非空にする。
 */
function buildProductNameEn(parsed: ParsedSkuId, itemId: string): string {
  const parts: string[] = [];

  switch (parsed.category) {
    case 'GREEN_BEANS':
      parts.push(
        originEn(parsed),
        varietyEn(parsed),
        CATEGORY_I18N.GREEN_BEANS.en
      );
      break;

    case 'ROASTED_BEANS':
      parts.push(
        originEn(parsed),
        varietyEn(parsed),
        parsed.grade ?? '',
        parsed.roast ? `${ROAST_I18N[parsed.roast].en} roast` : '',
        productSizeEn(parsed)
      );
      break;

    case 'BLEND':
      parts.push(
        CATEGORY_I18N.BLEND.en,
        parsed.blend ? BLEND_NAME_EN[parsed.blend] : '',
        parsed.roast ? `${ROAST_I18N[parsed.roast].en} roast` : '',
        productSizeEn(parsed)
      );
      break;

    case 'DRIP_BAG':
      parts.push(CATEGORY_I18N.DRIP_BAG.en);
      if (parsed.blend) {
        parts.push(CATEGORY_I18N.BLEND.en, BLEND_NAME_EN[parsed.blend]);
      } else {
        parts.push(originEn(parsed), varietyEn(parsed));
      }
      parts.push(productSizeEn(parsed));
      break;

    case 'MATERIAL':
      parts.push(
        CATEGORY_I18N.MATERIAL.en,
        parsed.materialType ? MATERIAL_TYPE_I18N[parsed.materialType].en : '',
        parsed.materialSize ? SIZE_I18N.material[parsed.materialSize].en : '',
        parsed.materialMaterial ? MATERIAL_MATERIAL_I18N[parsed.materialMaterial].en : ''
      );
      break;

    default:
      break;
  }

  if (parsed.variant) {
    parts.push(parsed.variant);
  }

  const assembled = capitalizeFirst(parts.filter((part) => part !== '').join(' ').trim());
  return assembled !== '' ? assembled : fallbackProductNameEn(itemId);
}

/** itemId 由来のフォールバック名。itemId が空でも非空を返す */
function fallbackProductNameEn(itemId: string): string {
  const body = typeof itemId === 'string' ? itemId.replace(ITEM_ID_PREFIX, '').trim() : '';
  return body !== '' ? body : UNKNOWN_PRODUCT_NAME_EN;
}

function originEn(parsed: ParsedSkuId): string {
  return parsed.origin ? ORIGIN_I18N[parsed.origin].en : '';
}

/** 品種は表示専用。風味・ボディ・酸味の導出には使わない（要件 2.4） */
function varietyEn(parsed: ParsedSkuId): string {
  if (parsed.variety) {
    return VARIETY_I18N[parsed.variety].en;
  }
  return parsed.varietyRaw ? parsed.varietyRaw.toLowerCase() : '';
}

function productSizeEn(parsed: ParsedSkuId): string {
  return parsed.productSize ? SIZE_I18N.product[parsed.productSize].en : '';
}

/**
 * 説明文に載せるブレンド名の表示。
 * 英語は `BLEND_NAME_EN` の固有名を使う。日本語は風味を示唆するコードのみを採用する
 * （ボディ示唆のコードは「重い系のブレンド」のような不自然な文になるため、ボディは別の文で述べる）。
 */
function blendDisplayName(blend: BlendCode, language: VectorLanguage): string {
  if (language === 'en') {
    return BLEND_NAME_EN[blend];
  }
  const hint = BLEND_HINT[blend];
  return hint.kind === 'flavor' ? hint.hint.ja : '';
}

function describeBodyAcidityJa(semantic: Semantics): string {
  if (semantic.body !== '' && semantic.acidity !== '') {
    return `ボディは${semantic.body}、酸味は${semantic.acidity}。`;
  }
  if (semantic.body !== '') {
    return `ボディは${semantic.body}。`;
  }
  if (semantic.acidity !== '') {
    return `酸味は${semantic.acidity}。`;
  }
  return '';
}

function describeBodyAcidityEn(semantic: Semantics): string {
  // BLEND_HINT のボディ語（`full-bodied` 等）は既に body を含むため、語の重複を避ける
  const body =
    semantic.body === ''
      ? ''
      : semantic.body.includes('bodied')
        ? capitalizeFirst(semantic.body)
        : `${capitalizeFirst(semantic.body)} body`;

  if (body !== '' && semantic.acidity !== '') {
    return `${body} with ${semantic.acidity} acidity.`;
  }
  if (body !== '') {
    return `${body}.`;
  }
  if (semantic.acidity !== '') {
    return `${capitalizeFirst(semantic.acidity)} acidity.`;
  }
  return '';
}

function terminator(language: VectorLanguage): string {
  return language === 'ja' ? '。' : '.';
}

/** 空の文を落として半角スペース 1 文字で連結する */
function joinSentences(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' ');
}

function pick(text: I18nText, language: VectorLanguage): string {
  return language === 'ja' ? text.ja : text.en;
}

function capitalizeFirst(value: string): string {
  return value === '' ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/**
 * 固定辞書に存在するキーだけを返す。
 * プロトタイプ由来のキー（`__proto__` / `constructor` 等）を弾くため
 * `Object.prototype.hasOwnProperty` で判定する。
 */
function lookupKey<K extends string>(
  table: Record<K, unknown>,
  code: string | undefined
): K | undefined {
  if (code === undefined) {
    return undefined;
  }
  return Object.prototype.hasOwnProperty.call(table, code) ? (code as K) : undefined;
}
