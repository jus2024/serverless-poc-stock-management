/**
 * 格納済み埋め込みの判定（純関数、共有モジュール）
 *
 * 「当該言語のベクトルが存在し、格納済みの埋め込みモデル識別子とベクトル次元数が
 * **ともに**現行設定と一致する」という条件式を保持する唯一の場所。
 *
 * この条件は 2 つの用途で使われる。
 *
 * | 用途 | 呼び出す関数 | 要件 |
 * |---|---|---|
 * | 埋め込みバッチのスキップ判定（再生成しない組の特定） | {@link shouldSkipEmbedding} | 4.5 / 4.8 |
 * | Verification_Run の検証対象の特定 | {@link isVerificationTarget} | 3.15 |
 *
 * 同一の述語を共有させる理由は、両者がずれると「バッチがスキップしたのに検証対象にも
 * ならない組」または「検証対象なのに Vector_Table 側の値が現行設定と異なる組」が生まれ、
 * 検証の一致件数が何を意味するのか読めなくなるためである。
 *
 * 判定材料は **Vector_Table に格納された値のみ**である。進捗レコードを入力にしないため、
 * 進捗レコードが失われても「成功済みの組へ Bedrock を呼ばない」（要件 4.9）が壊れない。
 *
 * 要件: 3.15, 4.5, 4.8
 * 設計: Vector_Verification_Path（案 D）/ 実行タイミングと対象特定 / Property 9 / Property 10
 */

import { VECTOR_LANGUAGES, type VectorLanguage } from './language';

/**
 * 判定に使う Vector_Table 側の格納状態。
 *
 * `hasEmbedding` は言語ごとのベクトル属性の有無である。ベクトル本体を渡さないのは、
 * 判定に必要なのは存在の有無だけであり、1,024 次元 2 本を持ち回る理由がないためである
 * （呼び出し側は `embeddingJa[0]` のみを射影して存在を判定できる）。
 */
export interface StoredEmbeddingState {
  /** 格納済みの埋め込みモデル識別子。未格納の場合は undefined */
  readonly embeddingModel?: string;
  /** 格納済みのベクトル次元数。未格納の場合は undefined */
  readonly embeddingDimensions?: number;
  /** 言語ごとのベクトル属性の存在 */
  readonly hasEmbedding: Readonly<Partial<Record<VectorLanguage, boolean>>>;
}

/**
 * 当該言語のベクトルが現行設定で格納済みかを判定する（要件 4.5 / 3.15）。
 *
 * 3 条件の論理積である。
 *
 * 1. 当該言語のベクトル属性が存在する
 * 2. 格納済みのモデル識別子が現行設定と一致する
 * 3. 格納済みの次元数が現行設定と一致する
 *
 * 判定は**言語ごとに独立**である。モデル識別子と次元数は SKU 単位の属性であるため、
 * 片方の言語だけがモデル変更前の値である状態は生じない（両言語を 1 回の書き込みで
 * まとめて更新するため。要件 3.5）。
 *
 * 例外を投げない全域関数。現行設定が不正（空のモデル名・非有限の次元数）な場合は
 * 「一致しない」と判定する。設定が読めない状態でスキップや検証対象化を起こさない。
 */
export function hasCurrentEmbedding(
  state: StoredEmbeddingState,
  language: VectorLanguage,
  model: string,
  dimensions: number
): boolean {
  if (typeof model !== 'string' || model.length === 0) return false;
  if (typeof dimensions !== 'number' || !Number.isInteger(dimensions) || dimensions <= 0) {
    return false;
  }
  if (state?.hasEmbedding?.[language] !== true) return false;
  return state.embeddingModel === model && state.embeddingDimensions === dimensions;
}

/**
 * 当該言語の埋め込み生成を省略できるかを判定する（要件 4.5 / 4.8）。
 *
 * `forceRegenerate` が真なら判定そのものを行わずに再生成する（要件 4.8）。
 * それ以外は {@link hasCurrentEmbedding} と一致する。
 */
export function shouldSkipEmbedding(
  state: StoredEmbeddingState,
  language: VectorLanguage,
  model: string,
  dimensions: number,
  forceRegenerate: boolean
): boolean {
  if (forceRegenerate === true) return false;
  return hasCurrentEmbedding(state, language, model, dimensions);
}

/**
 * 当該 (itemId, 言語) の組が検証対象かを判定する（要件 3.15）。
 *
 * {@link hasCurrentEmbedding} と同一の条件式である。別名を与えているのは呼び出し側の
 * 意図（スキップ判定ではなく対象特定）を読み取れるようにするためであり、
 * 判定規則を 2 つ持つためではない。**`forceRegenerate` の影響を受けない。**
 * 検証は生成を伴わないため、強制再生成の指定は対象特定に関与しない。
 */
export function isVerificationTarget(
  state: StoredEmbeddingState,
  language: VectorLanguage,
  model: string,
  dimensions: number
): boolean {
  return hasCurrentEmbedding(state, language, model, dimensions);
}

/**
 * 検証対象となる言語を絞り込む（要件 3.15）。
 *
 * 与えた言語の順序を保ち、対象でない言語を落とす。既定は両言語である。
 */
export function selectVerificationLanguages(
  state: StoredEmbeddingState,
  model: string,
  dimensions: number,
  languages: readonly VectorLanguage[] = VECTOR_LANGUAGES
): VectorLanguage[] {
  const selected: VectorLanguage[] = [];
  for (const language of languages) {
    if (isVerificationTarget(state, language, model, dimensions)) selected.push(language);
  }
  return selected;
}
