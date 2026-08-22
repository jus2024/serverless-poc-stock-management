/**
 * スコア正規化（純関数）
 *
 * DynamoDB Vector Index と OpenSearch k-NN を同一の距離基準
 * （コサイン距離 0〜2、小さいほど類似）で比較するための変換を提供する。
 *
 * - DynamoDB 側: `SearchVectors` が COSINE 距離を返すため変換不要（そのまま `distance` に使う）
 * - OpenSearch 側: knn の生スコアから距離を逆算する必要がある（要件 9.5）
 *
 * `cosinesimil` のスコア定義はドキュメント間で矛盾しているため（V11）、
 * 逆算式を切り替え可能にしてある。既定式は task 13.15 の実測キャリブレーション
 * （設計「キャリブレーション手順」）で **`two_minus_d_over_two` に確定した**
 * （下記 {@link DEFAULT_SCORE_NORMALIZATION_FORMULA} の実測値を参照）。
 *
 * 範囲外の値はクランプしない。呼び出し側が `distanceBasisMismatch`
 * （要件 9.12）を判定できるよう、算出値をそのまま返す。
 */

/**
 * OpenSearch の knn スコアからコサイン距離を逆算する式。
 * - `two_minus_d_over_two`: `d = 2 − 2 × score`（現行の k-NN spaces ドキュメント、`score = (2 − d) / 2`）
 * - `reciprocal_minus_one`: `d = 1 / score − 1`（旧版ドキュメントの nmslib / faiss 記述、`score = 1 / (1 + d)`）
 */
export type ScoreNormalizationFormula = 'two_minus_d_over_two' | 'reciprocal_minus_one';

/** 選択可能な逆算式の一覧 */
export const SCORE_NORMALIZATION_FORMULAS: readonly ScoreNormalizationFormula[] = [
  'two_minus_d_over_two',
  'reciprocal_minus_one',
];

/**
 * 既定の逆算式（要件 9.5）。**task 13.15（段階 11 / Q2）の実測で確定した値である。**
 *
 * 実測条件: 2026-08-21 / us-west-2 / コレクション `kiro-inventory-vector` /
 * インデックス `inventory-vector` / `SpaceType: cosinesimil` / 1,024 次元 /
 * Paired_Query_Set から採った 5 本（ja 3 / en 2）× 上位 10 件 = 50 件。
 * 各件について、返却行の格納ベクトル（クエリと同じ言語のフィールド）とクエリベクトルから
 * 厳密なコサイン距離 `d_local = 1 − cosθ` をローカル算出して突き合わせた。
 *
 * | 候補 | 逆算 | 最大残差 `\|d_calc − d_local\|` | 判定 |
 * |---|---|---|---|
 * | 式 A | `d = 2 − 2 × score` | **1.23e-7** | **採用**（閾値 1e-3 を満たす） |
 * | 式 B | `d = 1 / score − 1` | 1.72e-1 | 棄却 |
 * | 参考 | `d = score` | 4.81e-1 | 棄却 |
 * | 参考 | `d = 1 − score` | 2.95e-1 | 棄却 |
 *
 * 式 A の残差 1.23e-7 は f32 精度（Bedrock 応答の f32 丸めとインデックス内の f32 保持）の
 * 範囲内である。したがって現行の k-NN spaces ドキュメントの `score = (2 − d) / 2` が
 * AOSS の VECTORSEARCH コレクションにも当てはまる。旧版の nmslib / faiss 記述
 * （`score = 1 / (1 + d)`）は当てはまらない。
 *
 * 設計「キャリブレーション手順」の手順 5（faiss の取り込み時正規化と Titan の `normalize`
 * 設定の再検証）は不要だった。式 A が閾値を満たしたうえ、格納ベクトルとクエリベクトルの
 * ノルムがいずれも 1 ± 1e-7 であり、正規化状態の食い違いが存在しなかった。
 *
 * 実測の全件は
 * `docs/measurements/measure-score-calibration-2026-08-21T13-36-09-269Z.json` に記録してある。
 */
export const DEFAULT_SCORE_NORMALIZATION_FORMULA: ScoreNormalizationFormula =
  'two_minus_d_over_two';

/**
 * 式 A の採用判定に使った残差の閾値（設計「キャリブレーション手順」手順 4）。
 *
 * 実測の最大残差（1.23e-7）はこの閾値を 4 桁下回る。
 */
export const SCORE_CALIBRATION_RESIDUAL_THRESHOLD = 1e-3;

/** 既定式を上書きする環境変数名 */
export const SCORE_NORMALIZATION_FORMULA_ENV = 'OPENSEARCH_SCORE_FORMULA';

/** 正規化距離として妥当な範囲の下限（コサイン距離 `1 − cosθ` の下限） */
export const MIN_NORMALIZED_DISTANCE = 0;

/** 正規化距離として妥当な範囲の上限（コサイン距離 `1 − cosθ` の上限） */
export const MAX_NORMALIZED_DISTANCE = 2;

/** 環境変数の読み取り元。テスト時は任意のレコードを渡せる */
export type EnvLike = Record<string, string | undefined>;

/** 値が既知の逆算式かどうかを判定する */
export function isScoreNormalizationFormula(
  value: unknown
): value is ScoreNormalizationFormula {
  return (
    typeof value === 'string' &&
    (SCORE_NORMALIZATION_FORMULAS as readonly string[]).includes(value)
  );
}

/**
 * 使用する逆算式を解決する。
 *
 * 環境変数 `OPENSEARCH_SCORE_FORMULA` に既知の式名が設定されていればそれを使い、
 * 未設定または未知の値であれば既定式を使う。Lambda の起動を止めないため、
 * 未知の値でも例外は投げない（キャリブレーション不一致は要件 9.12 の
 * 範囲外フラグ側で検出できる）。
 */
export function resolveScoreNormalizationFormula(
  env: EnvLike = process.env
): ScoreNormalizationFormula {
  const configured = env[SCORE_NORMALIZATION_FORMULA_ENV]?.trim();
  return isScoreNormalizationFormula(configured)
    ? configured
    : DEFAULT_SCORE_NORMALIZATION_FORMULA;
}

/**
 * OpenSearch の knn スコアをコサイン距離（0〜2、小さいほど類似）に変換する。
 *
 * 範囲外の値はクランプせずそのまま返し、呼び出し側が
 * `distanceBasisMismatch`（要件 9.12）を判定する。式の選択を誤った場合、
 * 範囲外の距離が現れることで検出できる（式 B を誤って選ぶと
 * `score > 1` の領域で負の距離が出る）。
 *
 * スコアが大きいほど距離が小さくなる関係は、どの式でも保たれる
 * （順序保存。Property 25）。式 B は `score <= 0` で定義できないため、
 * その領域は `+Infinity`（最も非類似、かつ範囲外）として扱う。
 *
 * @param score OpenSearch が返した knn の生スコア
 * @param formula 使用する逆算式。未指定なら環境変数または既定式を使う
 */
export function normalizeOpenSearchScore(
  score: number,
  formula: ScoreNormalizationFormula = resolveScoreNormalizationFormula()
): number {
  switch (formula) {
    case 'reciprocal_minus_one':
      // score <= 0 は式の定義域外。単調非増加を崩さないよう +Infinity を返す
      return score > 0 ? 1 / score - 1 : Number.POSITIVE_INFINITY;
    case 'two_minus_d_over_two':
    default:
      return 2 - 2 * score;
  }
}

/**
 * 正規化距離が同一の距離基準（0〜2）から外れているかを判定する（要件 9.12）。
 *
 * 有限でない値（`Infinity` / `NaN`）も基準不一致として扱う。
 */
export function isDistanceBasisMismatch(distance: number): boolean {
  return (
    !Number.isFinite(distance) ||
    distance < MIN_NORMALIZED_DISTANCE ||
    distance > MAX_NORMALIZED_DISTANCE
  );
}
