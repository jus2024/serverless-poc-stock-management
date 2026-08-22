/**
 * 言語ルーティング（純関数）
 *
 * 検索言語（ja / en）から、DynamoDB のベクトルインデックス名と
 * OpenSearch の knn_vector フィールド名を解決する唯一の経路。
 *
 * このモジュールを経由しない名前の組み立てを禁止するため、
 * インデックス名・フィールド名は本モジュール内の対応表のみが保持し、
 * 戻り値はリテラル型に絞る。呼び出し側は文字列結合で名前を作れない。
 *
 * 要件: 8.2（DynamoDB 側のインデックス排他）, 9.2（OpenSearch 側のフィールド排他）,
 *       10.7（ja / en 以外の言語指定の拒否）
 * 設計: 言語ルーティング / Property 18（言語ルーティングの排他性）
 */

/** 検索言語。ja / en の 2 値のみ */
export type VectorLanguage = 'ja' | 'en';

/** DynamoDB Vector Index 名。言語ごとに 1 本ずつ、計 2 本 */
export type VectorIndexName = 'byEmbeddingJa' | 'byEmbeddingEn';

/** OpenSearch の knn_vector フィールド名。言語ごとに 1 つずつ、計 2 つ */
export type VectorFieldName = 'embeddingJa' | 'embeddingEn';

/**
 * 許容する言語の一覧。
 * 入力エラー（要件 10.7）で許容値を提示する際の唯一の出典。
 */
export const VECTOR_LANGUAGES = ['ja', 'en'] as const satisfies readonly VectorLanguage[];

/**
 * 言語ごとのルーティング対応表。
 * 本モジュール外に公開しないことで、名前の決定経路をここに一本化する。
 */
const ROUTING: Readonly<
  Record<VectorLanguage, { readonly indexName: VectorIndexName; readonly fieldName: VectorFieldName }>
> = {
  ja: { indexName: 'byEmbeddingJa', fieldName: 'embeddingJa' },
  en: { indexName: 'byEmbeddingEn', fieldName: 'embeddingEn' },
};

/**
 * 値が検索言語（ja / en）であるかを判定する型ガード。
 * ja / en のみを受理し、大文字・前後空白付き・その他のロケール表記は受理しない。
 */
export function isVectorLanguage(value: unknown): value is VectorLanguage {
  return value === 'ja' || value === 'en';
}

/**
 * 言語に対応する DynamoDB Vector Index 名を返す（ja → byEmbeddingJa / en → byEmbeddingEn）。
 * 型に反する値が実行時に渡された場合は、他方の言語のインデックスを検索させないために例外にする。
 */
export function resolveIndexName(language: VectorLanguage): VectorIndexName {
  assertVectorLanguage(language);
  return ROUTING[language].indexName;
}

/**
 * 言語に対応する OpenSearch の knn_vector フィールド名を返す（ja → embeddingJa / en → embeddingEn）。
 * DynamoDB 側と同一の対応表を使うため、片側だけが言語を取り違える経路が存在しない。
 */
export function resolveVectorField(language: VectorLanguage): VectorFieldName {
  assertVectorLanguage(language);
  return ROUTING[language].fieldName;
}

/** 型に反する実行時の値を弾く。許容値の一覧をメッセージに含める */
function assertVectorLanguage(value: unknown): asserts value is VectorLanguage {
  if (!isVectorLanguage(value)) {
    throw new Error(
      `Unsupported vector language: ${JSON.stringify(value)}. Allowed values: ${VECTOR_LANGUAGES.join(', ')}`
    );
  }
}
