/**
 * 日英マスターデータ（ベクトル検索比較の検証用シードデータ）
 *
 * `amplify/functions/seed/sku-generator.ts` の既存マスター（ORIGINS / VARIETIES /
 * ROAST_LEVELS / BLEND_NAMES / MATERIAL_TYPES / MATERIAL_SIZES / MATERIAL_MATERIALS /
 * ROASTED_SIZES / BLEND_SIZES / DRIP_PACK_SIZES）はコードと日本語表示名のみを持つ。
 * 意味的メタデータ（Sku_Metadata）の導出には英語名とフレーバー・ボディ・酸味のシグナルが
 * 必要になるため、コードをキーに参照する別モジュールとして本ファイルを新規に追加する。
 *
 * 制約:
 * - 既存の `sku-generator.ts` は変更しない（要件 2.7）。本ファイルは参照専用の追加辞書である
 * - 外部サービスに依存しない固定辞書とする。実行時の乱数・時刻・ネットワークを使わない（要件 2.2）
 * - 日本語名は既存マスターの表示名の再掲であり、英語名が本改訂で増える実体である（要件 2.1, 2.3）
 *
 * 要件: 2.1, 2.2, 2.3, 2.5, 2.6
 * 設計: 日英マスターデータ（新規シードデータ）
 */

// ============================================================
// 共通型
// ============================================================

/** 日英 1 対の表示文字列 */
export interface I18nText {
  ja: string;
  en: string;
}

/** 産地コード（既存 ORIGINS の code、8 件） */
export type OriginCode = 'ETH' | 'BRA' | 'COL' | 'GTM' | 'KEN' | 'IDN' | 'CRI' | 'TZA';

/** 品種コード（既存 VARIETIES の code、4 件） */
export type VarietyCode = 'YIRG' | 'SANT' | 'SUP' | 'SHB';

/** 焙煎度コード（既存 ROAST_LEVELS の code、5 件） */
export type RoastCode = 'LIGHT' | 'MEDIUM' | 'CITY' | 'FRENCH' | 'DARK';

/** ブレンド名コード（既存 BLEND_NAMES の code、20 件） */
export type BlendCode =
  | 'MORNING'
  | 'CLASSIC'
  | 'PREMIUM'
  | 'ESPRESSO'
  | 'HOUSE'
  | 'SEASONAL'
  | 'ORIGINAL'
  | 'RICH'
  | 'MILD'
  | 'DEEP'
  | 'SMOOTH'
  | 'BOLD'
  | 'FLORAL'
  | 'FRUITY'
  | 'NUTTY'
  | 'CHOCO'
  | 'CARAMEL'
  | 'SPICY'
  | 'CITRUS'
  | 'BERRY';

/** 資材タイプコード（既存 MATERIAL_TYPES の code、12 件） */
export type MaterialTypeCode =
  | 'BAG'
  | 'BOX'
  | 'LABEL'
  | 'SEAL'
  | 'TAPE'
  | 'WRAP'
  | 'CUP'
  | 'LID'
  | 'FILTER'
  | 'TAG'
  | 'RIBBON'
  | 'CARD';

/** 資材素材コード（既存 MATERIAL_MATERIALS の code、7 件） */
export type MaterialMaterialCode =
  | 'KRAFT'
  | 'VALVE'
  | 'CLEAR'
  | 'ALU'
  | 'PE'
  | 'PAPER'
  | 'COTTON';

/**
 * 商品側の容量・パック数コード。
 * 既存 ROASTED_SIZES（200G / 500G / 1KG）、BLEND_SIZES（100G / 200G / 500G）、
 * DRIP_PACK_SIZES（5P / 10P / 20P / 30P）の和集合。
 */
export type ProductSizeCode = '100G' | '200G' | '500G' | '1KG' | '5P' | '10P' | '20P' | '30P';

/** 資材サイズコード（既存 MATERIAL_SIZES の code、8 件） */
export type MaterialSizeCode = '100G' | '200G' | '500G' | '1KG' | 'S' | 'M' | 'L' | 'XL';

/** Sku_Metadata のカテゴリコード（itemId パターンから導出される 5 種） */
export type SkuCategoryCode =
  | 'GREEN_BEANS'
  | 'ROASTED_BEANS'
  | 'BLEND'
  | 'DRIP_BAG'
  | 'MATERIAL';

// ============================================================
// 1. ORIGIN_I18N — 産地名（日本語は既存 ORIGINS.name の再掲）
// ============================================================

export const ORIGIN_I18N: Record<OriginCode, I18nText> = {
  ETH: { ja: 'エチオピア', en: 'Ethiopia' },
  BRA: { ja: 'ブラジル', en: 'Brazil' },
  COL: { ja: 'コロンビア', en: 'Colombia' },
  GTM: { ja: 'グアテマラ', en: 'Guatemala' },
  KEN: { ja: 'ケニア', en: 'Kenya' },
  IDN: { ja: 'インドネシア', en: 'Indonesia' },
  CRI: { ja: 'コスタリカ', en: 'Costa Rica' },
  TZA: { ja: 'タンザニア', en: 'Tanzania' },
};

// ============================================================
// 2. ORIGIN_FLAVOR — 産地由来のフレーバーノート（2〜3 語）
// ============================================================

/**
 * 風味シグナルの主要な供給源。
 * 品種コードは意味的シグナルに使わない（既存マスターが産地と品種を独立に組み合わせるため、
 * 品種から風味を導出すると実在しない組み合わせの矛盾した埋め込みが大量に生まれる）。
 *
 * 要件: 2.4
 */
export const ORIGIN_FLAVOR: Record<OriginCode, I18nText> = {
  ETH: { ja: 'ジャスミン レモン ベリー', en: 'jasmine lemon berry' },
  BRA: { ja: 'ナッツ チョコレート', en: 'nutty chocolate' },
  COL: { ja: 'キャラメル りんご', en: 'caramel apple' },
  GTM: { ja: 'チョコレート オレンジ', en: 'chocolate orange' },
  KEN: { ja: 'カシス グレープフルーツ', en: 'blackcurrant grapefruit' },
  IDN: { ja: 'スパイス ハーブ 土の香り', en: 'spice herbal earthy' },
  CRI: { ja: 'ハニー シトラス', en: 'honey citrus' },
  TZA: { ja: 'ブラックティー レモン', en: 'black tea lemon' },
};

// ============================================================
// 3. ROAST_PROFILE — 焙煎度由来のボディと酸味
// ============================================================

export interface RoastProfile {
  body: I18nText;
  acidity: I18nText;
}

export const ROAST_PROFILE: Record<RoastCode, RoastProfile> = {
  LIGHT: {
    body: { ja: '軽い', en: 'light' },
    acidity: { ja: '強い', en: 'bright' },
  },
  MEDIUM: {
    body: { ja: '中程度', en: 'medium' },
    acidity: { ja: '穏やか', en: 'balanced' },
  },
  CITY: {
    body: { ja: 'しっかり', en: 'medium-full' },
    acidity: { ja: '控えめ', en: 'mild' },
  },
  FRENCH: {
    body: { ja: '重い', en: 'full' },
    acidity: { ja: 'ごく弱い', en: 'low' },
  },
  DARK: {
    body: { ja: '非常に重い', en: 'heavy' },
    acidity: { ja: 'ほとんどない', en: 'very low' },
  },
};

/**
 * 未焙煎（生豆）のボディ・酸味。
 * itemId パターン `ITEM#{ORIGIN}-{VARIETY}-RAW` は焙煎度コードを持たないため、
 * ROAST_PROFILE を引けない。設計の「酸味・ボディは『未焙煎』相当の固定値」に対応する辞書。
 */
export const UNROASTED_PROFILE: RoastProfile = {
  body: { ja: '未焙煎', en: 'unroasted' },
  acidity: { ja: '未焙煎', en: 'unroasted' },
};

// ============================================================
// 4. BLEND_HINT — ブレンド名由来の風味またはボディの示唆
// ============================================================

/**
 * ブレンド名コード 20 件の意味的分類。
 * - `flavor`: 風味を示唆する 8 件（FRUITY / NUTTY / CHOCO / CARAMEL / CITRUS / BERRY / FLORAL / SPICY）
 * - `body`: ボディを示唆する 5 件（RICH / MILD / DEEP / SMOOTH / BOLD）
 * - `neutral`: 風味中立の 7 件（MORNING / CLASSIC / PREMIUM / ESPRESSO / HOUSE / SEASONAL / ORIGINAL）
 *
 * `neutral` は日英の値を持たない。判別可能なユニオンにすることで、
 * 呼び出し側が kind を確認せずに風味語を取り出す経路をコンパイル時に塞ぐ。
 * 風味中立のブレンドは焙煎度由来のボディ・酸味のみを持つ。
 *
 * 要件: 2.5
 */
export type BlendHint =
  | { kind: 'flavor'; hint: I18nText }
  | { kind: 'body'; hint: I18nText }
  | { kind: 'neutral' };

export const BLEND_HINT: Record<BlendCode, BlendHint> = {
  // 風味中立（7 件）
  MORNING: { kind: 'neutral' },
  CLASSIC: { kind: 'neutral' },
  PREMIUM: { kind: 'neutral' },
  ESPRESSO: { kind: 'neutral' },
  HOUSE: { kind: 'neutral' },
  SEASONAL: { kind: 'neutral' },
  ORIGINAL: { kind: 'neutral' },

  // ボディを示唆（5 件）
  RICH: { kind: 'body', hint: { ja: '重い', en: 'full-bodied' } },
  MILD: { kind: 'body', hint: { ja: '軽やか', en: 'light-bodied' } },
  DEEP: { kind: 'body', hint: { ja: '深く重い', en: 'deep and full-bodied' } },
  SMOOTH: { kind: 'body', hint: { ja: 'なめらか', en: 'smooth-bodied' } },
  BOLD: { kind: 'body', hint: { ja: '力強い', en: 'bold-bodied' } },

  // 風味を示唆（8 件）
  FLORAL: { kind: 'flavor', hint: { ja: 'フローラル', en: 'floral' } },
  FRUITY: { kind: 'flavor', hint: { ja: 'フルーティー', en: 'fruity' } },
  NUTTY: { kind: 'flavor', hint: { ja: 'ナッティ', en: 'nutty' } },
  CHOCO: { kind: 'flavor', hint: { ja: 'チョコレート', en: 'chocolate' } },
  CARAMEL: { kind: 'flavor', hint: { ja: 'キャラメル', en: 'caramel' } },
  SPICY: { kind: 'flavor', hint: { ja: 'スパイシー', en: 'spicy' } },
  CITRUS: { kind: 'flavor', hint: { ja: 'シトラス', en: 'citrus' } },
  BERRY: { kind: 'flavor', hint: { ja: 'ベリー', en: 'berry' } },
};

// ============================================================
// 5. MATERIAL_PURPOSE — 資材タイプ別の説明文と用途説明
// ============================================================

/**
 * Material_Sku（2,008 件）は風味・ボディ・酸味を空値として扱う負例クラスであり、
 * 代わりに包装用途の説明文と、抽出推奨に代わる用途説明を持つ。
 *
 * 要件: 2.6
 */
export interface MaterialPurpose {
  /** 説明文（description 項目に入る） */
  description: I18nText;
  /** 用途説明（抽出推奨 brewingRecommendation の位置に入る） */
  usage: I18nText;
}

export const MATERIAL_PURPOSE: Record<MaterialTypeCode, MaterialPurpose> = {
  BAG: {
    description: {
      ja: 'コーヒー豆の保存と持ち運びに使う包装袋',
      en: 'packaging bag for storing and carrying coffee beans',
    },
    usage: {
      ja: '焙煎豆や粉の小分け包装に使う',
      en: 'used to portion roasted beans or ground coffee',
    },
  },
  BOX: {
    description: {
      ja: '商品をまとめて梱包し輸送するための箱',
      en: 'box for packing and shipping products together',
    },
    usage: {
      ja: 'ギフトセットや発送時の外装に使う',
      en: 'used as outer packaging for gift sets and shipments',
    },
  },
  LABEL: {
    description: {
      ja: '商品情報を表示するために貼付するラベル',
      en: 'label applied to display product information',
    },
    usage: {
      ja: '銘柄や焙煎日の表示に使う',
      en: 'used to show the blend name and roast date',
    },
  },
  SEAL: {
    description: {
      ja: '開封防止と装飾のために貼るシール',
      en: 'seal applied for tamper evidence and decoration',
    },
    usage: {
      ja: '袋の封緘やギフト包装の仕上げに使う',
      en: 'used to close bags and finish gift wrapping',
    },
  },
  TAPE: {
    description: {
      ja: '箱の封緘や補強に使う粘着テープ',
      en: 'adhesive tape for sealing and reinforcing boxes',
    },
    usage: {
      ja: '梱包箱の封じ止めに使う',
      en: 'used to seal shipping boxes',
    },
  },
  WRAP: {
    description: {
      ja: '商品を包んで保護する包装紙',
      en: 'wrapping paper that covers and protects products',
    },
    usage: {
      ja: 'ギフト包装や緩衝の目的で使う',
      en: 'used for gift wrapping and cushioning',
    },
  },
  CUP: {
    description: {
      ja: '抽出したコーヒーを提供するためのカップ',
      en: 'cup for serving brewed coffee',
    },
    usage: {
      ja: '店内提供やテイクアウトに使う',
      en: 'used for in-store service and takeout',
    },
  },
  LID: {
    description: {
      ja: 'カップに被せて中身をこぼれにくくするフタ',
      en: 'lid that covers a cup to prevent spills',
    },
    usage: {
      ja: 'テイクアウト用カップと組み合わせて使う',
      en: 'used together with takeout cups',
    },
  },
  FILTER: {
    description: {
      ja: 'コーヒーを抽出する際に微粉を濾すフィルター',
      en: 'filter that strains fines while brewing coffee',
    },
    usage: {
      ja: 'ハンドドリップやドリップバッグの抽出に使う',
      en: 'used for pour over and drip bag brewing',
    },
  },
  TAG: {
    description: {
      ja: '商品に取り付けて情報を伝えるタグ',
      en: 'tag attached to a product to convey information',
    },
    usage: {
      ja: 'ギフトの名入れや銘柄表示に使う',
      en: 'used for gift personalization and blend labeling',
    },
  },
  RIBBON: {
    description: {
      ja: '包装を結んで装飾するリボン',
      en: 'ribbon that ties and decorates packaging',
    },
    usage: {
      ja: 'ギフトラッピングの仕上げに使う',
      en: 'used to finish gift wrapping',
    },
  },
  CARD: {
    description: {
      ja: 'メッセージや商品説明を伝えるカード',
      en: 'card that carries a message or product description',
    },
    usage: {
      ja: 'ギフト同梱やテイスティングノートの案内に使う',
      en: 'used as a gift insert or tasting note handout',
    },
  },
};

// ============================================================
// 6. CATEGORY_I18N — カテゴリ表示（日本語は既存の表示名）
// ============================================================

export const CATEGORY_I18N: Record<SkuCategoryCode, I18nText> = {
  GREEN_BEANS: { ja: '生豆', en: 'green beans' },
  ROASTED_BEANS: { ja: '焙煎豆', en: 'roasted beans' },
  BLEND: { ja: 'ブレンド', en: 'blend' },
  DRIP_BAG: { ja: 'ドリップバッグ', en: 'drip bag' },
  MATERIAL: { ja: '資材', en: 'packaging material' },
};

// ============================================================
// 7. ROAST_I18N — 焙煎度表示（日本語は既存 ROAST_LEVELS.name の再掲）
// ============================================================

export const ROAST_I18N: Record<RoastCode, I18nText> = {
  LIGHT: { ja: 'ライト', en: 'light' },
  MEDIUM: { ja: 'ミディアム', en: 'medium' },
  CITY: { ja: 'シティ', en: 'city' },
  FRENCH: { ja: 'フレンチ', en: 'french' },
  DARK: { ja: 'ダーク', en: 'dark' },
};

// ============================================================
// 8. SIZE_I18N — 容量・パック数・資材サイズ（日本語は既存の表示名）
// ============================================================

/**
 * 商品側と資材側でコードが衝突する（例 `200G` は商品側が「200g」、資材側が「200g用」）ため、
 * 単一の平坦な辞書には収められない。参照経路を `product` / `material` に分けて明示する。
 *
 * - `product`: 既存 ROASTED_SIZES / BLEND_SIZES / DRIP_PACK_SIZES の和集合
 * - `material`: 既存 MATERIAL_SIZES
 */
export const SIZE_I18N: {
  product: Record<ProductSizeCode, I18nText>;
  material: Record<MaterialSizeCode, I18nText>;
} = {
  product: {
    '100G': { ja: '100g', en: '100g' },
    '200G': { ja: '200g', en: '200g' },
    '500G': { ja: '500g', en: '500g' },
    '1KG': { ja: '1kg', en: '1kg' },
    '5P': { ja: '5個入', en: '5 pack' },
    '10P': { ja: '10個入', en: '10 pack' },
    '20P': { ja: '20個入', en: '20 pack' },
    '30P': { ja: '30個入', en: '30 pack' },
  },
  material: {
    '100G': { ja: '100g用', en: 'for 100g' },
    '200G': { ja: '200g用', en: 'for 200g' },
    '500G': { ja: '500g用', en: 'for 500g' },
    '1KG': { ja: '1kg用', en: 'for 1kg' },
    S: { ja: 'S', en: 'S' },
    M: { ja: 'M', en: 'M' },
    L: { ja: 'L', en: 'L' },
    XL: { ja: 'XL', en: 'XL' },
  },
};

// ============================================================
// 9. MATERIAL_TYPE_I18N — 資材タイプ表示（日本語は既存 MATERIAL_TYPES.name の再掲）
// ============================================================

export const MATERIAL_TYPE_I18N: Record<MaterialTypeCode, I18nText> = {
  BAG: { ja: '袋', en: 'bag' },
  BOX: { ja: '箱', en: 'box' },
  LABEL: { ja: 'ラベル', en: 'label' },
  SEAL: { ja: 'シール', en: 'seal' },
  TAPE: { ja: 'テープ', en: 'tape' },
  WRAP: { ja: '包装紙', en: 'wrapping paper' },
  CUP: { ja: 'カップ', en: 'cup' },
  LID: { ja: 'フタ', en: 'lid' },
  FILTER: { ja: 'フィルター', en: 'filter' },
  TAG: { ja: 'タグ', en: 'tag' },
  RIBBON: { ja: 'リボン', en: 'ribbon' },
  CARD: { ja: 'カード', en: 'card' },
};

// ============================================================
// 10. MATERIAL_MATERIAL_I18N — 資材素材表示（日本語は既存 MATERIAL_MATERIALS.name の再掲）
// ============================================================

export const MATERIAL_MATERIAL_I18N: Record<MaterialMaterialCode, I18nText> = {
  KRAFT: { ja: 'クラフト', en: 'kraft' },
  VALVE: { ja: 'バルブ付', en: 'with valve' },
  CLEAR: { ja: 'クリア', en: 'clear' },
  ALU: { ja: 'アルミ', en: 'aluminum' },
  PE: { ja: 'ポリエチレン', en: 'polyethylene' },
  PAPER: { ja: '紙', en: 'paper' },
  COTTON: { ja: '綿', en: 'cotton' },
};

// ============================================================
// 品種表示（en.productName の組み立てに必要）
// ============================================================

/**
 * 品種名（日本語は既存 VARIETIES.name の再掲）。
 *
 * 設計の一覧表には現れないが、`en.productName` を itemId のコード列から組み立てるには
 * 品種の英語名が必要になる（既存 itemName は品種名を含む）。
 * 風味・ボディ・酸味の導出には一切使わない（要件 2.4）。表示専用の辞書である。
 */
export const VARIETY_I18N: Record<VarietyCode, I18nText> = {
  YIRG: { ja: 'イルガチェフェ', en: 'Yirgacheffe' },
  SANT: { ja: 'サントス', en: 'Santos' },
  SUP: { ja: 'スプレモ', en: 'Supremo' },
  SHB: { ja: 'SHB', en: 'SHB' },
};
