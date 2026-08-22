import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  DEFAULT_SCORE_NORMALIZATION_FORMULA,
  MAX_NORMALIZED_DISTANCE,
  MIN_NORMALIZED_DISTANCE,
  SCORE_CALIBRATION_RESIDUAL_THRESHOLD,
  SCORE_NORMALIZATION_FORMULAS,
  isDistanceBasisMismatch,
  normalizeOpenSearchScore,
  resolveScoreNormalizationFormula,
  type ScoreNormalizationFormula,
} from './score-normalize';

/**
 * スコア正規化の property テスト（task 3.10）。
 *
 * 距離基準不一致（要件 9.12）の期待値は、正規化後の距離ではなく **生スコアの定義域**
 * から独立に導出して比較する。
 * - `two_minus_d_over_two`（`d = 2 − 2s`）: `d ∈ [0, 2]` ⟺ `s ∈ [0, 1]`
 * - `reciprocal_minus_one`（`d = 1 / s − 1`）: `d ∈ [0, 2]` ⟺ `s ∈ [1/3, 1]`
 */
describe('normalizeOpenSearchScore', () => {
  /** 妥当な範囲・範囲外・境界値を混ぜた生スコア */
  const scoreArb = fc.oneof(
    fc.double({ min: -2, max: 3, noNaN: true }),
    fc.constantFrom(0, 1 / 3, 0.5, 0.75, 1, 1.5, 2, -0.5, -1, 3)
  );

  /** 距離基準の期待値を生スコアの定義域から導出する */
  const expectedInBasis = (score: number, formula: ScoreNormalizationFormula): boolean =>
    formula === 'two_minus_d_over_two'
      ? score >= 0 && score <= 1
      : score >= 1 / 3 && score <= 1;

  // Feature: vector-search-comparison, Property 25: スコア正規化の順序保存と値域
  // 任意の OpenSearch 生スコア列に対して、正規化距離の順序は生スコアの降順と一致し
  // （スコアが大きいほど距離が小さい）、生スコアは応答内で入力と等しい値のまま保持される。
  // 正規化距離が 0 未満または 2 超過となる場合に限り距離基準不一致フラグが付与される。
  // **Validates: Requirements 9.5, 9.12**
  it('生スコアの降順と正規化距離の昇順が一致し、値域外のときに限り基準不一致になる', () => {
    // 順序保存と生スコアの保持
    fc.assert(
      fc.property(
        fc.array(scoreArb, { minLength: 0, maxLength: 20 }),
        fc.constantFrom(...SCORE_NORMALIZATION_FORMULAS),
        (scores, formula) => {
          const snapshot = [...scores];
          const rows = scores.map((score) => ({
            score,
            distance: normalizeOpenSearchScore(score, formula),
          }));

          // 生スコアは入力と等しい値のまま保持される（入力配列も変更しない）
          expect(scores).toEqual(snapshot);
          expect(rows.map((row) => row.score)).toEqual(snapshot);

          // 生スコアの降順に並べると、正規化距離は非減少になる（スコアが大きいほど距離が小さい）
          const byScoreDesc = [...rows].sort((a, b) => b.score - a.score);
          for (let i = 1; i < byScoreDesc.length; i += 1) {
            expect(byScoreDesc[i - 1].distance).toBeLessThanOrEqual(byScoreDesc[i].distance);
          }
        }
      ),
      { numRuns: 100 }
    );

    // 距離基準不一致フラグの付与条件
    fc.assert(
      fc.property(
        fc.oneof(
          scoreArb,
          fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY)
        ),
        fc.constantFrom(...SCORE_NORMALIZATION_FORMULAS),
        (score, formula) => {
          const distance = normalizeOpenSearchScore(score, formula);

          // 境界そのものは浮動小数の丸めで両側に振れるため判定対象から除く
          fc.pre(
            !Number.isFinite(distance) ||
              (Math.abs(distance - MIN_NORMALIZED_DISTANCE) > 1e-9 &&
                Math.abs(distance - MAX_NORMALIZED_DISTANCE) > 1e-9)
          );

          expect(isDistanceBasisMismatch(distance)).toBe(!expectedInBasis(score, formula));
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * task 13.15（段階 11 / Q2）のキャリブレーション結果を固定する単体テスト。
 *
 * 実測（2026-08-21 / us-west-2 / `inventory-vector` / `cosinesimil` / 1,024 次元 /
 * クエリ 5 本 × 上位 10 件 = 50 件）から、残差が最大だった件と各クエリの最上位の件を採った。
 * `score` は `POST /vector-search/opensearch` が返した生スコア、`dLocal` は返却行の
 * 格納ベクトルとクエリベクトルから算出した厳密なコサイン距離 `1 − cosθ` である。
 *
 * このテストが落ちるのは、既定式を実測の裏付けなく差し替えた場合である。
 * 全件は `docs/measurements/measure-score-calibration-2026-08-21T13-36-09-269Z.json` にある。
 */
describe('OpenSearch スコア逆算式の実測キャリブレーション（task 13.15 / Q2）', () => {
  /** 実測値の抜粋。`[queryId, documentId, score, dLocal]` */
  const OBSERVED: readonly [string, string, number, number][] = [
    // 全 50 件のうち式 A の残差が最大だった件（1.2309e-7）
    ['q44', 'ITEM#BLEND-ESPRESSO-DARK-100G#WH-TOKYO', 0.8091618, 0.3816765230916196],
    // 各クエリの最上位
    ['q01', 'ITEM#GTM-SANT-G2-LIGHT-1KG#WH-OSAKA', 0.71469384, 0.5706123429142174],
    ['q22', 'ITEM#BLEND-RICH-FRENCH-200G#WH-OSAKA', 0.7322182, 0.5355636327300333],
    ['q31', 'ITEM#ETH-YIRG-G1-CITY-500G-V472#WH-TOKYO', 0.72453105, 0.5509379032679286],
    ['q53', 'ITEM#MAT-BAG-L-VALVE#WH-OSAKA', 0.8271231, 0.34575373276528143],
  ];

  it('既定式は two_minus_d_over_two であり、環境変数が未設定なら解決結果も同一になる', () => {
    expect(DEFAULT_SCORE_NORMALIZATION_FORMULA).toBe('two_minus_d_over_two');
    expect(resolveScoreNormalizationFormula({})).toBe('two_minus_d_over_two');
  });

  it('式 A の残差が閾値 1e-3 未満に収まる（採用根拠）', () => {
    for (const [queryId, documentId, score, dLocal] of OBSERVED) {
      const residual = Math.abs(
        normalizeOpenSearchScore(score, 'two_minus_d_over_two') - dLocal
      );
      expect(
        residual,
        `${queryId} / ${documentId} の式 A 残差 ${residual}`
      ).toBeLessThan(SCORE_CALIBRATION_RESIDUAL_THRESHOLD);
    }
  });

  it('式 B の残差は閾値 1e-3 を大きく超える（棄却根拠）', () => {
    for (const [queryId, documentId, score, dLocal] of OBSERVED) {
      const residual = Math.abs(
        normalizeOpenSearchScore(score, 'reciprocal_minus_one') - dLocal
      );
      expect(
        residual,
        `${queryId} / ${documentId} の式 B 残差 ${residual}`
      ).toBeGreaterThan(SCORE_CALIBRATION_RESIDUAL_THRESHOLD);
    }
  });

  it('実測スコアに既定式を当てると 0〜2 に収まり、基準不一致にならない（要件 9.12）', () => {
    for (const [queryId, documentId, score] of OBSERVED) {
      const distance = normalizeOpenSearchScore(score, DEFAULT_SCORE_NORMALIZATION_FORMULA);
      expect(distance).toBeGreaterThanOrEqual(MIN_NORMALIZED_DISTANCE);
      expect(distance).toBeLessThanOrEqual(MAX_NORMALIZED_DISTANCE);
      expect(
        isDistanceBasisMismatch(distance),
        `${queryId} / ${documentId} が基準不一致になった`
      ).toBe(false);
    }
  });
});
