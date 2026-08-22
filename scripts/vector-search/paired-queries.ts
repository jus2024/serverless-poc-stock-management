/**
 * Paired_Query_Set — 日英で意味的に対応するクエリ集合（recall@k 測定用）
 *
 * 言語間の recall を比較するには、日本語クエリと英語クエリが同一の意味的意図を
 * 表していなければならない。対応が崩れると、測定値は「言語差」ではなく
 * 「別の質問同士を比べた結果」になる。
 *
 * 対応を維持する仕組み:
 * - 1 つのオブジェクトに `ja` と `en` を並べて持たせる。別配列にして添字で対応づける方式は
 *   片方に要素を挿入した瞬間に全体の対応が崩れるため採らない（要件 13.7）
 * - `id` の一意性と `ja` / `en` がともに非空であることを起動時に検証し、
 *   違反があれば測定を開始しない（要件 13.7）
 * - 乱数シード（既定 `20260805`）はクエリの**選定順序**にのみ使う。クエリ集合そのものは
 *   固定配列なので、シードが変わっても ja / en の対応関係は不変である（要件 13.10）
 * - `intent` により、風味クエリのみを対象とした Material_Sku 非出現の判定（要件 13.15）を
 *   `intent === 'flavor'` の絞り込みで実行できる
 *
 * 語彙は `amplify/functions/shared/vector/master-data-i18n.ts` の辞書
 * （ORIGIN_I18N / ORIGIN_FLAVOR / ROAST_PROFILE / BLEND_HINT / MATERIAL_PURPOSE 等）に
 * 意味的に対応させている。埋め込みテキストに現れない語彙（品種由来の風味など）は使わない。
 *
 * 要件: 13.6, 13.7, 13.10
 * 設計: Recall_Evaluator / Paired_Query_Set
 */

/** 意味的意図のカテゴリ。集計の切り口に使う */
export type QueryIntent = 'flavor' | 'body' | 'origin' | 'usage' | 'material';

export interface PairedQuery {
  /** 組の識別子。ja / en の対応を保つキー */
  id: string;
  ja: string;
  en: string;
  /** 意味的意図のカテゴリ。集計の切り口に使う */
  intent: QueryIntent;
}

/**
 * 要件 13.6 が求めるクエリ件数の下限。
 * 検証で満たされない場合は測定を開始しない。
 */
export const MIN_PAIRED_QUERY_COUNT = 50;

/**
 * 既定の乱数シード。
 * クエリの**選定順序**にのみ使い、クエリ集合の内容やペアリングには影響しない（要件 13.10）。
 */
export const DEFAULT_QUERY_SEED = 20260805;

/**
 * 日英ペアのクエリ集合（固定配列、60 件）。
 *
 * 内訳: flavor 20 / body 10 / origin 12 / usage 10 / material 8。
 * flavor が最多なのは、風味クエリ上位に Material_Sku が現れないことの判定（要件 13.15）に
 * 十分な件数が必要なため。
 */
export const PAIRED_QUERY_SET: readonly PairedQuery[] = [
  // ---- flavor（20 件）: フレーバー・酸味の表現 ----
  {
    id: 'q01',
    ja: '花のような香りで酸味の強い浅煎りの豆',
    en: 'light roast beans with floral aroma and bright acidity',
    intent: 'flavor',
  },
  {
    id: 'q02',
    ja: 'チョコレートのような甘さの深煎りブレンド',
    en: 'dark roast blend with chocolate sweetness',
    intent: 'flavor',
  },
  {
    id: 'q03',
    ja: 'ジャスミンとレモンを思わせる華やかな風味',
    en: 'vibrant flavor reminiscent of jasmine and lemon',
    intent: 'flavor',
  },
  {
    id: 'q04',
    ja: 'ナッツとチョコレートの香ばしい風味',
    en: 'toasty nutty and chocolate flavor',
    intent: 'flavor',
  },
  {
    id: 'q05',
    ja: 'キャラメルとりんごのような甘い風味',
    en: 'sweet flavor of caramel and apple',
    intent: 'flavor',
  },
  {
    id: 'q06',
    ja: 'チョコレートとオレンジが重なる風味',
    en: 'layered flavor of chocolate and orange',
    intent: 'flavor',
  },
  {
    id: 'q07',
    ja: 'カシスとグレープフルーツのような果実感',
    en: 'fruity notes of blackcurrant and grapefruit',
    intent: 'flavor',
  },
  {
    id: 'q08',
    ja: 'スパイスとハーブと土の香りがある豆',
    en: 'beans with spice, herbal and earthy aroma',
    intent: 'flavor',
  },
  {
    id: 'q09',
    ja: 'ハニーとシトラスの明るい甘さ',
    en: 'bright sweetness of honey and citrus',
    intent: 'flavor',
  },
  {
    id: 'q10',
    ja: 'ブラックティーとレモンを思わせる繊細な風味',
    en: 'delicate flavor like black tea and lemon',
    intent: 'flavor',
  },
  {
    id: 'q11',
    ja: 'ベリーのような酸味が際立つコーヒー',
    en: 'coffee with prominent berry acidity',
    intent: 'flavor',
  },
  {
    id: 'q12',
    ja: 'フルーティーで華やかなブレンド',
    en: 'fruity and vibrant blend',
    intent: 'flavor',
  },
  {
    id: 'q13',
    ja: 'ナッティで香ばしいブレンド',
    en: 'nutty and toasty blend',
    intent: 'flavor',
  },
  {
    id: 'q14',
    ja: 'キャラメルのような甘みのあるブレンド',
    en: 'blend with caramel-like sweetness',
    intent: 'flavor',
  },
  {
    id: 'q15',
    ja: 'スパイシーで個性的なブレンド',
    en: 'spicy and distinctive blend',
    intent: 'flavor',
  },
  {
    id: 'q16',
    ja: 'シトラス系の爽やかな酸味のコーヒー',
    en: 'coffee with refreshing citrus acidity',
    intent: 'flavor',
  },
  {
    id: 'q17',
    ja: '酸味がほとんどない苦味主体のダークロースト',
    en: 'dark roast with very low acidity and bitter forward taste',
    intent: 'flavor',
  },
  {
    id: 'q18',
    ja: '酸味が穏やかでバランスの取れたミディアムロースト',
    en: 'medium roast with balanced and mild acidity',
    intent: 'flavor',
  },
  {
    id: 'q19',
    ja: 'ビターチョコのような余韻が続くフレンチロースト',
    en: 'french roast with a lingering bitter chocolate finish',
    intent: 'flavor',
  },
  {
    id: 'q20',
    ja: 'フローラルな香りが立つブレンド',
    en: 'blend with a pronounced floral aroma',
    intent: 'flavor',
  },

  // ---- body（10 件）: ボディ・口当たりの表現 ----
  {
    id: 'q21',
    ja: '軽いボディで飲みやすいライトロースト',
    en: 'light roast with light body that is easy to drink',
    intent: 'body',
  },
  {
    id: 'q22',
    ja: '重いボディでコクのあるフレンチロースト',
    en: 'french roast with full body and rich depth',
    intent: 'body',
  },
  {
    id: 'q23',
    ja: 'しっかりしたボディのシティロースト',
    en: 'city roast with medium-full body',
    intent: 'body',
  },
  {
    id: 'q24',
    ja: '非常に重いボディのダークロースト',
    en: 'dark roast with heavy body',
    intent: 'body',
  },
  {
    id: 'q25',
    ja: 'なめらかな口当たりのブレンド',
    en: 'smooth-bodied blend',
    intent: 'body',
  },
  {
    id: 'q26',
    ja: '力強いボディのエスプレッソ向けブレンド',
    en: 'bold-bodied blend for espresso',
    intent: 'body',
  },
  {
    id: 'q27',
    ja: '軽やかで後味の軽いブレンド',
    en: 'light-bodied blend with a clean finish',
    intent: 'body',
  },
  {
    id: 'q28',
    ja: '深く重いボディの深煎りブレンド',
    en: 'deep and full-bodied dark roast blend',
    intent: 'body',
  },
  {
    id: 'q29',
    ja: 'ボディが中程度で毎日飲めるコーヒー',
    en: 'coffee with medium body for everyday drinking',
    intent: 'body',
  },
  {
    id: 'q30',
    ja: 'コクが強くミルクに負けない豆',
    en: 'beans with strong body that stand up to milk',
    intent: 'body',
  },

  // ---- origin（12 件）: 産地・カテゴリの表現 ----
  {
    id: 'q31',
    ja: 'エチオピア産のベリー系の風味の豆',
    en: 'beans from Ethiopia with berry flavor',
    intent: 'origin',
  },
  {
    id: 'q32',
    ja: 'ブラジル産のナッツ感のある焙煎豆',
    en: 'roasted beans from Brazil with nutty character',
    intent: 'origin',
  },
  {
    id: 'q33',
    ja: 'コロンビア産のキャラメルのような甘さの豆',
    en: 'beans from Colombia with caramel-like sweetness',
    intent: 'origin',
  },
  {
    id: 'q34',
    ja: 'グアテマラ産のチョコレート感のある豆',
    en: 'beans from Guatemala with chocolate character',
    intent: 'origin',
  },
  {
    id: 'q35',
    ja: 'ケニア産の酸味が強い豆',
    en: 'beans from Kenya with bright acidity',
    intent: 'origin',
  },
  {
    id: 'q36',
    ja: 'インドネシア産の土の香りがする豆',
    en: 'beans from Indonesia with earthy aroma',
    intent: 'origin',
  },
  {
    id: 'q37',
    ja: 'コスタリカ産のハニーのような甘さの豆',
    en: 'beans from Costa Rica with honey-like sweetness',
    intent: 'origin',
  },
  {
    id: 'q38',
    ja: 'タンザニア産の紅茶のような風味の豆',
    en: 'beans from Tanzania with black tea like flavor',
    intent: 'origin',
  },
  {
    id: 'q39',
    ja: 'エチオピアのイルガチェフェの生豆',
    en: 'green beans of Ethiopian Yirgacheffe',
    intent: 'origin',
  },
  {
    id: 'q40',
    ja: 'ブラジルのサントスの生豆',
    en: 'green beans of Brazilian Santos',
    intent: 'origin',
  },
  {
    id: 'q41',
    ja: 'コロンビアのスプレモの焙煎豆',
    en: 'roasted beans of Colombian Supremo',
    intent: 'origin',
  },
  {
    id: 'q42',
    ja: 'グアテマラの SHB の未焙煎の豆',
    en: 'unroasted beans of Guatemalan SHB',
    intent: 'origin',
  },

  // ---- usage（10 件）: 抽出・容量・用途の表現 ----
  {
    id: 'q43',
    ja: 'ハンドドリップに向いた焙煎豆',
    en: 'roasted beans suited for pour over brewing',
    intent: 'usage',
  },
  {
    id: 'q44',
    ja: 'エスプレッソ抽出に向いた深煎り豆',
    en: 'dark roast beans suited for espresso extraction',
    intent: 'usage',
  },
  {
    id: 'q45',
    ja: '手軽に一杯だけ抽出できるドリップバッグ',
    en: 'drip bag for easily brewing a single cup',
    intent: 'usage',
  },
  {
    id: 'q46',
    ja: '来客用に配りやすい個包装のドリップバッグ',
    en: 'individually packed drip bags that are easy to hand out to guests',
    intent: 'usage',
  },
  {
    id: 'q47',
    ja: '1kg の業務用の大容量焙煎豆',
    en: '1kg bulk roasted beans for commercial use',
    intent: 'usage',
  },
  {
    id: 'q48',
    ja: '200g の小容量パックの焙煎豆',
    en: '200g small pack roasted beans',
    intent: 'usage',
  },
  {
    id: 'q49',
    ja: 'ギフトに向いたブレンドの詰め合わせ',
    en: 'blend assortment suited for gifts',
    intent: 'usage',
  },
  {
    id: 'q50',
    ja: 'アイスコーヒー向けの深煎り豆',
    en: 'dark roast beans for iced coffee',
    intent: 'usage',
  },
  {
    id: 'q51',
    ja: '自家焙煎用に仕入れる未焙煎の生豆',
    en: 'unroasted green beans purchased for in-house roasting',
    intent: 'usage',
  },
  {
    id: 'q52',
    ja: '20個入のドリップバッグをまとめて買いたい',
    en: 'want to buy 20 pack drip bags in bulk',
    intent: 'usage',
  },

  // ---- material（8 件）: 資材の表現。負例クラスの正面から当てる問い ----
  {
    id: 'q53',
    ja: 'コーヒー豆を保存するためのバルブ付の袋',
    en: 'bag with valve for storing coffee beans',
    intent: 'material',
  },
  {
    id: 'q54',
    ja: 'ギフトセットの外装に使う箱',
    en: 'box used as outer packaging for gift sets',
    intent: 'material',
  },
  {
    id: 'q55',
    ja: '銘柄や焙煎日を表示するためのラベル',
    en: 'label for showing the blend name and roast date',
    intent: 'material',
  },
  {
    id: 'q56',
    ja: '袋の封緘に使うシール',
    en: 'seal used to close bags',
    intent: 'material',
  },
  {
    id: 'q57',
    ja: '梱包箱を封じるための粘着テープ',
    en: 'adhesive tape for sealing shipping boxes',
    intent: 'material',
  },
  {
    id: 'q58',
    ja: 'ハンドドリップに使う紙のフィルター',
    en: 'paper filter used for pour over brewing',
    intent: 'material',
  },
  {
    id: 'q59',
    ja: 'テイクアウト用のカップとフタ',
    en: 'cup and lid for takeout',
    intent: 'material',
  },
  {
    id: 'q60',
    ja: 'ギフトラッピングを仕上げる綿のリボン',
    en: 'cotton ribbon to finish gift wrapping',
    intent: 'material',
  },
];

/** 検証違反。測定を開始してはならない状態を表す */
export class PairedQuerySetValidationError extends Error {
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(`Paired_Query_Set の検証に失敗しました:\n- ${violations.join('\n- ')}`);
    this.name = 'PairedQuerySetValidationError';
    this.violations = violations;
  }
}

/**
 * Paired_Query_Set を検証する。
 *
 * 検証項目:
 * - 件数が {@link MIN_PAIRED_QUERY_COUNT} 件以上であること（要件 13.6）
 * - `id` が一意であること（要件 13.7）
 * - `ja` / `en` がともに非空（空白のみでない）であること（要件 13.7）
 *
 * 違反があれば {@link PairedQuerySetValidationError} を投げる。
 * 測定の起動時に必ず呼び出し、違反時は測定を開始しない。
 */
export function validatePairedQuerySet(
  queries: readonly PairedQuery[] = PAIRED_QUERY_SET,
): void {
  const violations: string[] = [];

  if (queries.length < MIN_PAIRED_QUERY_COUNT) {
    violations.push(
      `クエリ件数が不足しています: ${queries.length} 件（下限 ${MIN_PAIRED_QUERY_COUNT} 件）`,
    );
  }

  const seenIds = new Set<string>();
  for (let i = 0; i < queries.length; i += 1) {
    const query = queries[i];
    const label = query.id.trim().length > 0 ? `id="${query.id}"` : `index=${i}`;

    if (query.id.trim().length === 0) {
      violations.push(`${label}: id が空です`);
    } else if (seenIds.has(query.id)) {
      violations.push(`${label}: id が重複しています`);
    } else {
      seenIds.add(query.id);
    }

    if (query.ja.trim().length === 0) {
      violations.push(`${label}: ja が空です`);
    }
    if (query.en.trim().length === 0) {
      violations.push(`${label}: en が空です`);
    }
  }

  if (violations.length > 0) {
    throw new PairedQuerySetValidationError(violations);
  }
}

/**
 * シード値から決定論的な疑似乱数列（0 以上 1 未満）を生成する（mulberry32）。
 * 同一シードで常に同一の列を返すため、選定順序が再現する（要件 13.10）。
 */
function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * クエリの**選定順序**を決定論的に並べ替えた新しい配列を返す。
 *
 * シードが影響するのは順序だけであり、各要素の `ja` / `en` の組は一切変わらない。
 * したがってシードを変えても言語間比較の対応関係は不変である（要件 13.10）。
 * 入力配列は変更しない。
 *
 * @param seed 乱数シード。既定は {@link DEFAULT_QUERY_SEED}
 * @param queries 対象のクエリ集合。既定は {@link PAIRED_QUERY_SET}
 */
export function selectQueryOrder(
  seed: number = DEFAULT_QUERY_SEED,
  queries: readonly PairedQuery[] = PAIRED_QUERY_SET,
): readonly PairedQuery[] {
  const ordered = queries.slice();
  const random = createSeededRandom(seed);

  // Fisher-Yates。末尾から交換位置を選ぶ
  for (let i = ordered.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = ordered[i];
    ordered[i] = ordered[j];
    ordered[j] = tmp;
  }

  return ordered;
}
