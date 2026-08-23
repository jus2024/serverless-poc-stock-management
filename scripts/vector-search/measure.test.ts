import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  AOSS_METRIC_NAMESPACE,
  AOSS_OCU_DIMENSION_KEYS,
  AOSS_OCU_DIMENSION_NAME,
  AOSS_OCU_SERIES_LABEL_TEMPLATE,
  AOSS_PER_COLLECTION_DIMENSION_NAME,
  DEFAULT_VECTOR_COLLECTION_GROUP_NAME,
  EXIT_CODES,
  EXPECTED_GOOD_TABLE_GSI_NAMES,
  EXPECTED_GOOD_TABLE_ITEM_COUNT,
  EXPECTED_GOOD_TABLE_PITR_STATUS,
  EXPECTED_GOOD_TABLE_STREAM_VIEW_TYPE,
  EXPECTED_PIPELINE_STATUS,
  GOOD_TABLE_SAMPLE_ITEM_COUNT,
  GOOD_TABLE_SNAPSHOT_FILE,
  GOOD_TABLE_SNAPSHOT_SCHEMA_VERSION,
  GSI_ADJUSTMENT_NOTE,
  INDEX_SIZE_DIRECT_NOTE,
  INDEXING_OCU_METRIC,
  BACKFILL_UNMEASURABLE_REASON,
  MeasurementError,
  OCU_HOURLY_USD,
  OCU_SAMPLE_PERIOD_SECONDS,
  OCU_UTILIZATION_METRIC,
  SEARCH_OCU_METRIC,
  SCALE_TO_ZERO_MIN_ZERO_MINUTES,
  SNAPSHOT_CONVERGENCE_TOLERANCE,
  SNAPSHOT_MAX_REFETCH_ATTEMPTS,
  SNAPSHOT_MIN_INTERVAL_HOURS,
  SPEND_THRESHOLD_USD,
  STORAGE_SNAPSHOT_STORE_FILE,
  VECTOR_RECORD_COUNT,
  accumulateSpend,
  analyzeOcuUsage,
  aossOcuFilterDimension,
  aossOcuSearchExpression,
  appendReportWarning,
  buildDeterministicQueryVector,
  buildGoodTableSnapshot,
  buildSearchVectorsRequestBody,
  compareGoodTableSnapshots,
  compareSnapshots,
  computeIndexSizeTotals,
  computeStorageContribution,
  evaluateSnapshotConvergence,
  formatReportSummary,
  hoursBetween,
  parseGoodTableSnapshot,
  partitionByActivity,
  readMetricExpressionResult,
  readVectorIndexStates,
  readVectorSearchRequestBytes,
  readVectorSearchUnits,
  summarizeConsumedCapacity,
  relativeDifference,
  resolveEffectiveRegion,
  resolveExitCode,
  resolveOcuSeries,
  runOcu,
  runPreCheck,
  runStorage,
  runWaitIndex,
  runWatchSpend,
  sortOcuSamples,
  sumIntervalMinutes,
  sumIntervalOcuHours,
  sumOcuHours,
  waitForIndexReadiness,
  type DynamoDbMeasurementSource,
  type GoodTableSnapshot,
  type MeasurementClock,
  type MeasurementStore,
  type MetricDataPoint,
  type MetricExpressionQuery,
  type MetricExpressionResult,
  type MetricSeriesQuery,
  type MetricSource,
  type OcuSample,
  type PipelineStateSource,
  type StorageSnapshot,
  type TableDescriptionSnapshot,
  type VectorIndexSizeMeasurement,
  type VectorIndexState,
} from './measure';

/**
 * `measure.ts`（Measurement_Collector）の算出ロジックの property テスト（task 11.3）。
 *
 * 対象は AWS にも実時刻にも依存しない純関数（Property 47〜50）である。CloudWatch と DynamoDB を
 * 使う経路は、`measure.ts` が注入で受け取る {@link MetricSource} /
 * {@link TableDescriptionSnapshot} を返すだけの偽実装（本ファイル内の `fakeMetricSource` /
 * `fakeDynamo`）へ差し替えて検証する。実 AWS 呼び出しは一切行わず、
 * `@aws-sdk/client-cloudwatch` などの遅延 import 経路にも触れない。
 *
 * 要件: 7.4, 7.6, 7.7, 14.2, 14.3, 14.4, 14.5, 14.6, 14.9
 * Property: 47, 48, 49, 50
 */

// ============================================================
// 共通の生成器と補助
// ============================================================

const VECTOR_TABLE = 'kiro-roasters-inventory-vector';
const INDEX_JA = 'vector-index-ja';
const INDEX_EN = 'vector-index-en';

/** 時刻の基準点。5 分境界に載せてある */
const BASE_EPOCH_MS = Date.parse('2026-01-01T00:00:00.000Z');

/** 5 分バケットの 1 個分（ミリ秒） */
const STEP_MS = OCU_SAMPLE_PERIOD_SECONDS * 1000;

/** 5 分グリッド上の i 番目の時刻 */
function gridTimestamp(index: number): string {
  return new Date(BASE_EPOCH_MS + index * STEP_MS).toISOString();
}

/** `TableSizeBytes` のスナップショット 1 件 */
function tableSnapshot(args: {
  label: string;
  value: number;
  capturedAt: string;
  target?: string;
}): StorageSnapshot {
  return {
    label: args.label,
    field: 'TableSizeBytes',
    target: args.target ?? VECTOR_TABLE,
    value: args.value,
    capturedAt: args.capturedAt,
    itemCount: null,
  };
}

/** `IndexSizeBytes` のスナップショット 1 件 */
function indexSnapshot(args: {
  target: string;
  value: number;
  capturedAt: string;
  itemCount?: number;
}): StorageSnapshot {
  return {
    label: 'INDEX',
    field: 'IndexSizeBytes',
    target: args.target,
    value: args.value,
    capturedAt: args.capturedAt,
    itemCount: args.itemCount ?? 15_000,
  };
}

/** OCU が 0 か正の値かを混ぜる生成器。0 を確実に出すために `constant(0)` を混ぜる */
const ocuValueArb = fc.oneof(
  { weight: 3, arbitrary: fc.constant(0) },
  { weight: 2, arbitrary: fc.double({ min: 0.05, max: 16, noNaN: true }) }
);

// ============================================================
// Property 47: ストレージ寄与分解の保存則
// ============================================================

describe('computeStorageContribution / computeIndexSizeTotals', () => {
  const contributionArb = fc.record({
    s1Value: fc.integer({ min: 0, max: 5_000_000_000 }),
    delta: fc.integer({ min: -2_000_000, max: 5_000_000_000 }),
    recordCount: fc.integer({ min: 1, max: 500_000 }),
  });

  const indexesArb = fc.array(
    fc.record({
      indexName: fc.constantFrom(INDEX_JA, INDEX_EN, 'vector-index-extra'),
      indexSizeBytes: fc.integer({ min: 0, max: 4_000_000_000 }),
      itemCount: fc.integer({ min: 0, max: 200_000 }),
      capturedAt: fc.constantFrom(gridTimestamp(0), gridTimestamp(72), gridTimestamp(144)),
    }),
    { maxLength: 4 }
  );

  // Feature: vector-search-comparison, Property 47: ストレージ寄与分解の保存則
  // 任意の スナップショット値の組に対して、ベクトル属性の寄与は 2 時点の `TableSizeBytes` の差と
  // 等しく（GSI 複製分を差し引く項を含まない）、インデックスの寄与は 2 本の `IndexSizeBytes` の和と
  // 等しく、1 レコードあたり平均増分はベクトル属性の寄与をレコード件数で割った値と等しい。
  // **Validates: Requirements 14.2, 14.3, 14.6**
  it('寄与は TableSizeBytes の差そのもの・平均増分は寄与÷件数・GSI 差し引き項を含まない', () => {
    fc.assert(
      fc.property(contributionArb, ({ s1Value, delta, recordCount }) => {
        const s1 = tableSnapshot({ label: 'S1', value: s1Value, capturedAt: gridTimestamp(0) });
        const s2 = tableSnapshot({ label: 'S2', value: s1Value + delta, capturedAt: gridTimestamp(72) });

        const contribution = computeStorageContribution(s1, s2, recordCount);

        // 寄与は 2 時点の差そのもの（差し引き項を持たない）
        expect(contribution.vectorAttributeContributionBytes).toBe(s2.value - s1.value);
        expect(contribution.vectorAttributeContributionBytes).toBe(delta);

        // 1 レコードあたり平均増分は寄与をレコード件数で割った値（保存則）
        expect(contribution.averagePerRecordBytes).toBe(delta / recordCount);
        // 逆算しても寄与に戻る（相対誤差で見る。バイト数は 10^9 台になり得るため絶対誤差では測らない）
        const roundTrip = contribution.averagePerRecordBytes * recordCount;
        expect(Math.abs(roundTrip - delta)).toBeLessThanOrEqual(
          1e-9 * Math.max(1, Math.abs(delta))
        );
        expect(contribution.recordCount).toBe(recordCount);

        // GSI 複製分の差し引きを行っていないことを出力へ残す（要件 14.6）
        expect(contribution.gsiAdjustmentApplied).toBe(false);
        expect(contribution.gsiNote).toBe(GSI_ADJUSTMENT_NOTE);

        // 与えたスナップショットをそのまま保持する
        expect(contribution.s1).toEqual(s1);
        expect(contribution.s2).toEqual(s2);
      }),
      { numRuns: 300 }
    );
  });

  // Feature: vector-search-comparison, Property 47: ストレージ寄与分解の保存則
  // インデックスの寄与は 2 本の `IndexSizeBytes` の和と等しく、`TableSizeBytes` 差分からの
  // 算出を行わない（要件 14.3）。
  // **Validates: Requirements 14.3**
  it('インデックス合計は各 IndexSizeBytes / ItemCount の総和であり TableSizeBytes 差分に依存しない', () => {
    fc.assert(
      fc.property(indexesArb, contributionArb, (indexes, table) => {
        const totals = computeIndexSizeTotals(indexes);

        let expectedSize = 0;
        let expectedItems = 0;
        for (let i = 0; i < indexes.length; i += 1) {
          expectedSize += indexes[i].indexSizeBytes;
          expectedItems += indexes[i].itemCount;
        }

        expect(totals.totalIndexSizeBytes).toBe(expectedSize);
        expect(totals.totalItemCount).toBe(expectedItems);
        expect(totals.indexes).toEqual(indexes);
        expect(totals.derivedFromTableSizeDifference).toBe(false);
        expect(totals.note).toBe(INDEX_SIZE_DIRECT_NOTE);

        // 同時点の TableSizeBytes 差分がいくらであってもインデックス合計は変わらない
        const s1 = tableSnapshot({ label: 'S1', value: table.s1Value, capturedAt: gridTimestamp(0) });
        const s2 = tableSnapshot({
          label: 'S2',
          value: table.s1Value + table.delta,
          capturedAt: gridTimestamp(72),
        });
        const contribution = computeStorageContribution(s1, s2, table.recordCount);
        expect(computeIndexSizeTotals(indexes).totalIndexSizeBytes).toBe(expectedSize);
        expect(contribution.vectorAttributeContributionBytes).toBe(table.delta);
      }),
      { numRuns: 300 }
    );
  });

  it('既定のレコード件数は 15,000 であり、入力配列を後から変更しても合計は変わらない', () => {
    const s1 = tableSnapshot({ label: 'S1', value: 1_000_000, capturedAt: gridTimestamp(0) });
    const s2 = tableSnapshot({ label: 'S2', value: 1_150_000, capturedAt: gridTimestamp(72) });

    const contribution = computeStorageContribution(s1, s2);
    expect(contribution.recordCount).toBe(VECTOR_RECORD_COUNT);
    expect(contribution.vectorAttributeContributionBytes).toBe(150_000);
    expect(contribution.averagePerRecordBytes).toBe(150_000 / VECTOR_RECORD_COUNT);

    const indexes: VectorIndexSizeMeasurement[] = [
      { indexName: INDEX_JA, indexSizeBytes: 100, itemCount: 5, capturedAt: gridTimestamp(0) },
    ];
    const totals = computeIndexSizeTotals(indexes);
    indexes.push({ indexName: INDEX_EN, indexSizeBytes: 900, itemCount: 7, capturedAt: gridTimestamp(0) });
    expect(totals.totalIndexSizeBytes).toBe(100);
    expect(totals.indexes.length).toBe(1);
  });

  it('レコード件数が 0 以下または非有限なら MeasurementError にする', () => {
    const s1 = tableSnapshot({ label: 'S1', value: 10, capturedAt: gridTimestamp(0) });
    const s2 = tableSnapshot({ label: 'S2', value: 20, capturedAt: gridTimestamp(72) });

    expect(() => computeStorageContribution(s1, s2, 0)).toThrow(MeasurementError);
    expect(() => computeStorageContribution(s1, s2, -1)).toThrow(MeasurementError);
    expect(() => computeStorageContribution(s1, s2, Number.NaN)).toThrow(MeasurementError);
  });
});

// ============================================================
// Property 48: スナップショット収束判定
// ============================================================

describe('evaluateSnapshotConvergence', () => {
  /** 取得間隔（時間）。6 時間の境界を跨ぐ値を混ぜる */
  const gapHoursArb = fc.oneof(
    { weight: 2, arbitrary: fc.constant(SNAPSHOT_MIN_INTERVAL_HOURS) },
    { weight: 3, arbitrary: fc.double({ min: 6.05, max: 14, noNaN: true }) },
    { weight: 2, arbitrary: fc.double({ min: 0.5, max: 5.9, noNaN: true }) }
  );

  /** 相対増分。1% の境界を跨ぐ値を混ぜる */
  const relDeltaArb = fc.oneof(
    { weight: 2, arbitrary: fc.constant(0) },
    { weight: 2, arbitrary: fc.constant(SNAPSHOT_CONVERGENCE_TOLERANCE) },
    { weight: 2, arbitrary: fc.double({ min: 0.0002, max: 0.0098, noNaN: true }) },
    { weight: 3, arbitrary: fc.double({ min: 0.0105, max: 0.6, noNaN: true }) }
  );

  const seriesArb = fc
    .record({
      baseValue: fc.integer({ min: 1_000, max: 4_000_000_000 }),
      steps: fc.array(fc.record({ gapHours: gapHoursArb, relDelta: relDeltaArb }), {
        minLength: 0,
        maxLength: 7,
      }),
    })
    .map(({ baseValue, steps }) => {
      const snapshots: StorageSnapshot[] = [
        tableSnapshot({ label: 'S2', value: baseValue, capturedAt: gridTimestamp(0) }),
      ];
      let epochMs = BASE_EPOCH_MS;
      let value = baseValue;
      for (let i = 0; i < steps.length; i += 1) {
        epochMs += Math.round(steps[i].gapHours * 3_600_000);
        value = Math.round(value * (1 + steps[i].relDelta));
        snapshots.push(
          tableSnapshot({ label: 'S2', value, capturedAt: new Date(epochMs).toISOString() })
        );
      }
      return snapshots;
    });

  /** 実装と同一の判定を、独立した経路で再現する */
  function expectedAdoptedIndex(snapshots: readonly StorageSnapshot[]): number {
    const usableCount = Math.min(snapshots.length, 2 + SNAPSHOT_MAX_REFETCH_ATTEMPTS);
    for (let i = 1; i < usableCount; i += 1) {
      const gap = hoursBetween(snapshots[i - 1].capturedAt, snapshots[i].capturedAt);
      const difference = relativeDifference(snapshots[i - 1].value, snapshots[i].value);
      if (gap >= SNAPSHOT_MIN_INTERVAL_HOURS && difference <= SNAPSHOT_CONVERGENCE_TOLERANCE) {
        return i;
      }
    }
    return -1;
  }

  // Feature: vector-search-comparison, Property 48: スナップショット収束判定
  // 任意の 連続 2 回の取得値（境界近傍を含む）に対して、採用と判定されるのは相対差が 1% 以下の
  // 場合のみであり、再取得回数は 3 回を超えず、先行するスナップショットは破棄されない。
  // **Validates: Requirements 14.4, 14.5**
  it('採用は間隔 6 時間以上かつ相対差 1% 以内のときのみ・再取得は 3 回まで・先行分を破棄しない', () => {
    fc.assert(
      fc.property(seriesArb, (snapshots) => {
        const result = evaluateSnapshotConvergence(snapshots);
        const adoptedIndex = expectedAdoptedIndex(snapshots);
        const usableCount = Math.min(snapshots.length, 2 + SNAPSHOT_MAX_REFETCH_ATTEMPTS);

        // 採用の有無は「間隔 6 時間以上 かつ 相対差 1% 以内」と厳密に一致する
        expect(result.determinate).toBe(adoptedIndex >= 0);
        if (adoptedIndex >= 0) {
          expect(result.status).toBe('converged');
          expect(result.adopted).toEqual(snapshots[adoptedIndex]);
          expect(result.finalValue).toBeNull();
          expect(result.estimatedErrorRange).toBeNull();
        } else {
          expect(result.adopted).toBeNull();
          // 未確定時の最終取得値は「判定に用いた範囲」の末尾
          expect(result.finalValue).toEqual(snapshots[usableCount - 1]);
          expect(
            result.status === 'insufficient-samples' ||
              result.status === 'pending-retry' ||
              result.status === 'unconverged'
          ).toBe(true);
        }

        // 採用と判定された比較は必ず両条件を満たす（1% を超える差では採用しない）
        for (let i = 0; i < result.comparisons.length; i += 1) {
          const comparison = result.comparisons[i];
          expect(comparison.qualifies).toBe(
            comparison.intervalSatisfied && comparison.withinTolerance
          );
          expect(comparison.withinTolerance).toBe(
            comparison.relativeDifference <= SNAPSHOT_CONVERGENCE_TOLERANCE
          );
          expect(comparison.intervalSatisfied).toBe(
            comparison.hoursApart >= SNAPSHOT_MIN_INTERVAL_HOURS
          );
        }

        // 再取得回数は上限 3 回を超えない
        expect(result.refetchAttempts).toBeLessThanOrEqual(SNAPSHOT_MAX_REFETCH_ATTEMPTS);
        expect(result.refetchAttempts).toBe(Math.max(0, usableCount - 2));
        expect(result.remainingRefetchAttempts).toBe(
          Math.max(0, SNAPSHOT_MAX_REFETCH_ATTEMPTS - result.refetchAttempts)
        );
        expect(result.comparisons.length).toBe(Math.max(0, usableCount - 1));

        // 先行するスナップショットを破棄しない（全件を保持する）
        expect(result.snapshots.length).toBe(snapshots.length);
        expect(
          result.snapshots.map((snapshot) => `${snapshot.capturedAt}:${snapshot.value}`).sort()
        ).toEqual(snapshots.map((snapshot) => `${snapshot.capturedAt}:${snapshot.value}`).sort());

        // 未確定のときだけ推定誤差幅を出し、最終取得値を挟む区間になる（要件 14.5）
        if (result.status === 'unconverged' || result.status === 'pending-retry') {
          const range = result.estimatedErrorRange;
          expect(range).not.toBeNull();
          if (range !== null) {
            const last = result.comparisons[result.comparisons.length - 1];
            expect(range.relative).toBe(last.relativeDifference);
            expect(range.lowerBytes).toBeLessThanOrEqual(result.finalValue?.value ?? 0);
            expect(range.upperBytes).toBeGreaterThanOrEqual(result.finalValue?.value ?? 0);
          }
          // 未確定は 3 回の再取得を使い切ったときだけ `unconverged` になる
          expect(result.status === 'unconverged').toBe(
            result.refetchAttempts >= SNAPSHOT_MAX_REFETCH_ATTEMPTS
          );
        }
      }),
      { numRuns: 400 }
    );
  });

  it('相対差 1% の境界を含み、6 時間未満の間隔は採用しない', () => {
    const earlier = tableSnapshot({ label: 'S2', value: 990, capturedAt: gridTimestamp(0) });
    const exactly = tableSnapshot({ label: 'S2', value: 1_000, capturedAt: gridTimestamp(72) });
    const justOver = tableSnapshot({ label: 'S2', value: 1_000, capturedAt: gridTimestamp(72) });

    // |1000 - 990| / 1000 = 0.01（境界）→ 採用
    const atBoundary = compareSnapshots(earlier, exactly);
    expect(atBoundary.relativeDifference).toBeCloseTo(0.01, 12);
    expect(atBoundary.withinTolerance).toBe(true);
    expect(atBoundary.hoursApart).toBe(6);
    expect(atBoundary.qualifies).toBe(true);

    // |1000 - 989| / 1000 = 0.011（境界超え）→ 不採用
    const overBoundary = compareSnapshots(
      tableSnapshot({ label: 'S2', value: 989, capturedAt: gridTimestamp(0) }),
      justOver
    );
    expect(overBoundary.withinTolerance).toBe(false);
    expect(overBoundary.qualifies).toBe(false);

    // 相対差 0% でも間隔が 6 時間未満なら不採用
    const tooClose = compareSnapshots(
      tableSnapshot({ label: 'S2', value: 1_000, capturedAt: gridTimestamp(0) }),
      tableSnapshot({ label: 'S2', value: 1_000, capturedAt: gridTimestamp(71) })
    );
    expect(tooClose.relativeDifference).toBe(0);
    expect(tooClose.intervalSatisfied).toBe(false);
    expect(tooClose.qualifies).toBe(false);
  });

  it('スナップショットが 1 件なら insufficient-samples、0 件なら MeasurementError にする', () => {
    const single = evaluateSnapshotConvergence([
      tableSnapshot({ label: 'S1', value: 100, capturedAt: gridTimestamp(0) }),
    ]);
    expect(single.status).toBe('insufficient-samples');
    expect(single.determinate).toBe(false);
    expect(single.comparisons.length).toBe(0);

    expect(() => evaluateSnapshotConvergence([])).toThrow(MeasurementError);
  });

  it('判定対象を超える件数（6 件以上）でも全件を保持し、判定は先頭 5 件で行う', () => {
    const snapshots: StorageSnapshot[] = [];
    for (let i = 0; i < 7; i += 1) {
      snapshots.push(
        tableSnapshot({
          label: 'S2',
          // 常に 1% を超えて増やし、収束させない
          value: Math.round(1_000_000 * Math.pow(1.2, i)),
          capturedAt: gridTimestamp(i * 72),
        })
      );
    }

    const result = evaluateSnapshotConvergence(snapshots);
    expect(result.snapshots.length).toBe(7);
    expect(result.comparisons.length).toBe(4);
    expect(result.refetchAttempts).toBe(SNAPSHOT_MAX_REFETCH_ATTEMPTS);
    expect(result.status).toBe('unconverged');
    expect(result.determinate).toBe(false);
    expect(result.estimatedErrorRange).not.toBeNull();
  });
});

// ============================================================
// Property 49: 連続ゼロ OCU 区間の検出
// ============================================================

/** 5 分グリッド上のブロック。`gap` はデータ点の欠測を表す */
type SeriesBlock = { kind: 'zero' | 'active' | 'gap'; length: number; searchOcu: number; indexingOcu: number };

/** ブロック列を 5 分グリッドへ展開する。欠測はサンプルを作らない */
function expandBlocks(blocks: readonly SeriesBlock[]): {
  samples: readonly OcuSample[];
  slots: readonly (OcuSample | null)[];
} {
  const slots: (OcuSample | null)[] = [];
  const samples: OcuSample[] = [];

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    for (let n = 0; n < block.length; n += 1) {
      const index = slots.length;
      if (block.kind === 'gap') {
        slots.push(null);
        continue;
      }
      const sample: OcuSample = {
        timestamp: gridTimestamp(index),
        searchOcu: block.kind === 'zero' ? 0 : block.searchOcu,
        indexingOcu: block.kind === 'zero' ? 0 : block.indexingOcu,
      };
      slots.push(sample);
      samples.push(sample);
    }
  }

  return { samples, slots };
}

/** 「両メトリクスが 0 かつデータ点が存在する」連続区間の長さ（サンプル数）を列挙する */
function zeroRunLengths(slots: readonly (OcuSample | null)[]): readonly number[] {
  const runs: number[] = [];
  let current = 0;
  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i];
    const isZero = slot !== null && slot.searchOcu === 0 && slot.indexingOcu === 0;
    if (isZero) {
      current += 1;
    } else if (current > 0) {
      runs.push(current);
      current = 0;
    }
  }
  if (current > 0) runs.push(current);
  return runs;
}

describe('analyzeOcuUsage', () => {
  const blocksArb = fc.array(
    fc.record({
      kind: fc.constantFrom('zero', 'active', 'gap'),
      length: fc.integer({ min: 1, max: 16 }),
      searchOcu: fc.double({ min: 0.05, max: 8, noNaN: true }),
      indexingOcu: fc.oneof(
        { weight: 2, arbitrary: fc.constant(0) },
        { weight: 1, arbitrary: fc.double({ min: 0.05, max: 4, noNaN: true }) }
      ),
    }),
    { minLength: 0, maxLength: 8 }
  );

  // Feature: vector-search-comparison, Property 49: 連続ゼロ OCU 区間の検出
  // 任意の OCU 時系列（5 分間隔）に対して、scale-to-zero 適用可と判定されるのは SearchOCU と
  // IndexingOCU がともに 0 である連続区間の最大長が 60 分以上である場合のみであり、判定に使われた
  // 0 OCU 区間の合計時間は実際の 0 区間の合計と等しい。
  // **Validates: Requirements 7.4, 7.6**
  it('適用可は 0 OCU 連続区間の最大長 60 分以上と厳密に一致し、0 区間の合計時間は実際の合計と等しい', () => {
    fc.assert(
      fc.property(blocksArb, (blocks) => {
        const { samples, slots } = expandBlocks(blocks);
        const analysis = analyzeOcuUsage(samples);

        const runs = zeroRunLengths(slots);
        const minutesPerSample = OCU_SAMPLE_PERIOD_SECONDS / 60;
        let longestRun = 0;
        let totalZeroSamples = 0;
        let qualifyingZeroSamples = 0;
        for (let i = 0; i < runs.length; i += 1) {
          if (runs[i] > longestRun) longestRun = runs[i];
          totalZeroSamples += runs[i];
          if (runs[i] * minutesPerSample >= SCALE_TO_ZERO_MIN_ZERO_MINUTES) {
            qualifyingZeroSamples += runs[i];
          }
        }

        // 0 OCU 区間の検出（区間数・最大長・合計時間）
        expect(analysis.zeroOcuIntervals.length).toBe(runs.length);
        expect(analysis.longestZeroOcuMinutes).toBe(longestRun * minutesPerSample);
        expect(analysis.totalZeroOcuMinutes).toBe(totalZeroSamples * minutesPerSample);
        expect(analysis.qualifyingZeroOcuMinutes).toBe(qualifyingZeroSamples * minutesPerSample);

        // 判定は「最大長 60 分以上」と厳密に一致する
        expect(analysis.scaleToZeroApplicable).toBe(
          longestRun * minutesPerSample >= SCALE_TO_ZERO_MIN_ZERO_MINUTES
        );

        // 60 分以上で絞った区間は元の区間の部分集合であり、すべて 60 分以上
        expect(analysis.qualifyingZeroOcuIntervals.length).toBeLessThanOrEqual(
          analysis.zeroOcuIntervals.length
        );
        for (let i = 0; i < analysis.qualifyingZeroOcuIntervals.length; i += 1) {
          const interval = analysis.qualifyingZeroOcuIntervals[i];
          expect(interval.lengthMinutes).toBeGreaterThanOrEqual(SCALE_TO_ZERO_MIN_ZERO_MINUTES);
          expect(interval.ocuHours).toBe(0);
          expect(analysis.zeroOcuIntervals).toContainEqual(interval);
        }

        // 0 OCU 区間の消費 OCU-hour は 0
        expect(sumIntervalOcuHours(analysis.zeroOcuIntervals)).toBe(0);

        // 区間分解は全サンプルを覆い、消費 OCU-hour の合計が全体と一致する
        expect(analysis.sampleCount).toBe(samples.length);
        expect(sumIntervalMinutes(analysis.activityPartition)).toBe(
          samples.length * minutesPerSample
        );
        expect(sumIntervalOcuHours(analysis.activityPartition)).toBeCloseTo(
          analysis.totalOcuHours,
          9
        );
        expect(analysis.totalOcuHours).toBe(sumOcuHours(samples));

        // 非適用のときだけ常時課金の月額見積を出す（要件 7.4）
        if (analysis.scaleToZeroApplicable || analysis.sampleCount === 0) {
          expect(analysis.alwaysOnMonthlyUsd).toBeNull();
        } else {
          expect(analysis.alwaysOnMonthlyUsd).toBeCloseTo(
            (analysis.combinedOcu.average ?? 0) * OCU_HOURLY_USD * 730,
            9
          );
        }
      }),
      { numRuns: 400 }
    );
  });

  it('欠測は 0 OCU 区間を繋がず、連続性を切る', () => {
    // 0 OCU が 6 個 → 欠測 1 個 → 0 OCU が 6 個。合計 60 分だが最大連続は 30 分
    const samples: OcuSample[] = [];
    for (let i = 0; i < 6; i += 1) {
      samples.push({ timestamp: gridTimestamp(i), searchOcu: 0, indexingOcu: 0 });
    }
    for (let i = 7; i < 13; i += 1) {
      samples.push({ timestamp: gridTimestamp(i), searchOcu: 0, indexingOcu: 0 });
    }

    const analysis = analyzeOcuUsage(samples);
    expect(analysis.zeroOcuIntervals.length).toBe(2);
    expect(analysis.longestZeroOcuMinutes).toBe(30);
    expect(analysis.totalZeroOcuMinutes).toBe(60);
    expect(analysis.qualifyingZeroOcuMinutes).toBe(0);
    expect(analysis.scaleToZeroApplicable).toBe(false);
  });

  it('IndexingOCU が 0 でなければ 0 OCU 区間に数えないが、アイドル区間には数える', () => {
    // 検索 0 / インデックス 0.5 が 6 時間（72 サンプル）続く
    const samples: OcuSample[] = [];
    for (let i = 0; i < 72; i += 1) {
      samples.push({ timestamp: gridTimestamp(i), searchOcu: 0, indexingOcu: 0.5 });
    }

    const analysis = analyzeOcuUsage(samples);
    expect(analysis.zeroOcuIntervals.length).toBe(0);
    expect(analysis.scaleToZeroApplicable).toBe(false);
    expect(analysis.idleIntervals.length).toBe(1);
    expect(analysis.idleIntervals[0].lengthMinutes).toBe(360);
    // アイドル区間の消費 OCU-hour は 0 とは限らない
    expect(analysis.idleIntervals[0].ocuHours).toBeCloseTo(72 * 0.5 * (300 / 3600), 9);
  });

  it('60 分ちょうどの 0 OCU 区間で適用可と判定する（境界）', () => {
    const samples: OcuSample[] = [];
    for (let i = 0; i < 12; i += 1) {
      samples.push({ timestamp: gridTimestamp(i), searchOcu: 0, indexingOcu: 0 });
    }
    const atBoundary = analyzeOcuUsage(samples);
    expect(atBoundary.longestZeroOcuMinutes).toBe(60);
    expect(atBoundary.scaleToZeroApplicable).toBe(true);
    expect(atBoundary.qualifyingZeroOcuMinutes).toBe(60);

    const justUnder = analyzeOcuUsage(samples.slice(0, 11));
    expect(justUnder.longestZeroOcuMinutes).toBe(55);
    expect(justUnder.scaleToZeroApplicable).toBe(false);
    expect(justUnder.qualifyingZeroOcuMinutes).toBe(0);
  });

  it('サンプルが 0 件なら要約は空で判定は非適用', () => {
    const analysis = analyzeOcuUsage([]);
    expect(analysis.sampleCount).toBe(0);
    expect(analysis.startTime).toBeNull();
    expect(analysis.scaleToZeroApplicable).toBe(false);
    expect(analysis.totalOcuHours).toBe(0);
    expect(analysis.alwaysOnMonthlyUsd).toBeNull();
  });
});

// ============================================================
// Property 50: 累積課金の単調性と警告時点
// ============================================================

describe('accumulateSpend', () => {
  const spendArb = fc.record({
    values: fc.array(fc.record({ searchOcu: ocuValueArb, indexingOcu: ocuValueArb }), {
      minLength: 0,
      maxLength: 90,
    }),
    thresholdUsd: fc.oneof(
      { weight: 1, arbitrary: fc.constant(SPEND_THRESHOLD_USD) },
      { weight: 2, arbitrary: fc.double({ min: 0.05, max: 30, noNaN: true }) }
    ),
  });

  // Feature: vector-search-comparison, Property 50: 累積課金の単調性と警告時点
  // 任意の OCU 時系列に対して、累積 OCU-hour は単調非減少であり、削除要求の警告が発生するのは
  // 累積 OCU-hour × 0.24 USD が 20 USD を初めて超えた時点であり、それ以前に警告は発生しない。
  // 区間ごとの区間長と消費 OCU-hour の合計は全体の累積と一致する。
  // **Validates: Requirements 7.7, 14.9**
  it('累積は単調非減少・警告は初めて閾値を超えた時点のみ・区間合計は全体の累積と一致する', () => {
    fc.assert(
      fc.property(spendArb, ({ values, thresholdUsd }) => {
        const samples: OcuSample[] = values.map((value, index) => ({
          timestamp: gridTimestamp(index),
          searchOcu: value.searchOcu,
          indexingOcu: value.indexingOcu,
        }));

        const spend = accumulateSpend(samples, { thresholdUsd });

        // 累積 OCU-hour の単調非減少
        for (let i = 1; i < spend.points.length; i += 1) {
          expect(spend.points[i].cumulativeOcuHours).toBeGreaterThanOrEqual(
            spend.points[i - 1].cumulativeOcuHours
          );
          expect(spend.points[i].cumulativeUsd).toBeGreaterThanOrEqual(
            spend.points[i - 1].cumulativeUsd
          );
        }

        // 累積 USD = 累積 OCU-hour × 単価
        for (let i = 0; i < spend.points.length; i += 1) {
          expect(spend.points[i].cumulativeUsd).toBeCloseTo(
            spend.points[i].cumulativeOcuHours * OCU_HOURLY_USD,
            9
          );
        }

        // 警告の有無は「全区間の累積が閾値を超えるか」と一致する（増分が非負のため）
        const totalUsdIfNotTerminated = sumOcuHours(samples) * OCU_HOURLY_USD;
        expect(spend.warning !== null).toBe(totalUsdIfNotTerminated > thresholdUsd);
        expect(spend.terminated).toBe(spend.warning !== null);

        // 閾値超過の点はあっても 1 つだけ、しかも積算列の末尾
        const crossedIndexes: number[] = [];
        for (let i = 0; i < spend.points.length; i += 1) {
          if (spend.points[i].thresholdCrossed) crossedIndexes.push(i);
        }
        expect(crossedIndexes.length).toBeLessThanOrEqual(1);

        if (spend.warning !== null) {
          expect(crossedIndexes).toEqual([spend.points.length - 1]);
          const last = spend.points[spend.points.length - 1];
          expect(last.cumulativeUsd).toBeGreaterThan(thresholdUsd);
          expect(spend.warning.timestamp).toBe(last.timestamp);
          expect(spend.warning.cumulativeOcuHours).toBe(last.cumulativeOcuHours);
          expect(spend.warning.cumulativeUsd).toBe(last.cumulativeUsd);
          expect(spend.warning.thresholdUsd).toBe(thresholdUsd);
          // 削除実行を要求する（Collection と Collection Group の 2 つ）
          expect(spend.warning.requiredActions.length).toBeGreaterThanOrEqual(2);
          // それ以前の点では警告が発生していない
          for (let i = 0; i < spend.points.length - 1; i += 1) {
            expect(spend.points[i].thresholdCrossed).toBe(false);
            expect(spend.points[i].cumulativeUsd).toBeLessThanOrEqual(thresholdUsd);
          }
        } else {
          expect(crossedIndexes.length).toBe(0);
          expect(spend.retainedSampleCount).toBe(samples.length);
          expect(spend.skippedSampleCount).toBe(0);
          expect(spend.totalUsd).toBeLessThanOrEqual(thresholdUsd);
        }

        // 測定値は保持され、打ち切り分と合わせて入力件数に一致する
        expect(spend.retainedSampleCount).toBe(spend.points.length);
        expect(spend.retainedSampleCount + spend.skippedSampleCount).toBe(samples.length);
        expect(spend.totalUsd).toBeCloseTo(spend.totalOcuHours * OCU_HOURLY_USD, 9);
        if (spend.points.length > 0) {
          expect(spend.totalOcuHours).toBe(
            spend.points[spend.points.length - 1].cumulativeOcuHours
          );
        }

        // 区間ごとの区間長と消費 OCU-hour の合計が全体の累積と一致する（要件 14.9）
        const retained = sortOcuSamples(samples).slice(0, spend.retainedSampleCount);
        const partition = partitionByActivity(retained);
        expect(sumIntervalMinutes(partition)).toBe(
          retained.length * (OCU_SAMPLE_PERIOD_SECONDS / 60)
        );
        expect(sumIntervalOcuHours(partition)).toBeCloseTo(spend.totalOcuHours, 9);
      }),
      { numRuns: 400 }
    );
  });

  it('閾値ちょうどでは警告せず、初めて超えた時点で打ち切る', () => {
    // 1 時間バケット・単価 1 USD・閾値 1 USD。0.5 OCU なら 1 個 = 0.5 OCU-hour
    const samples: OcuSample[] = [0, 1, 2, 3].map((index) => ({
      timestamp: gridTimestamp(index * 12),
      searchOcu: 0.5,
      indexingOcu: 0,
    }));
    const options = { periodSeconds: 3600, hourlyUsd: 1, thresholdUsd: 1 };

    // 2 個で累積 1.0 USD（= 閾値）。「超えた」ではないので警告しない
    const atBoundary = accumulateSpend(samples.slice(0, 2), options);
    expect(atBoundary.totalUsd).toBeCloseTo(1, 9);
    expect(atBoundary.warning).toBeNull();
    expect(atBoundary.terminated).toBe(false);
    expect(atBoundary.retainedSampleCount).toBe(2);

    // 3 個目で 1.5 USD となり初めて超える。4 個目は積算しない
    const crossed = accumulateSpend(samples, options);
    expect(crossed.warning).not.toBeNull();
    expect(crossed.terminated).toBe(true);
    expect(crossed.retainedSampleCount).toBe(3);
    expect(crossed.skippedSampleCount).toBe(1);
    expect(crossed.totalUsd).toBeCloseTo(1.5, 9);
    expect(crossed.points[2].thresholdCrossed).toBe(true);
    expect(crossed.warning?.timestamp).toBe(samples[2].timestamp);
  });

  it('サンプルが 0 件なら警告なしで累積 0', () => {
    const spend = accumulateSpend([]);
    expect(spend.points.length).toBe(0);
    expect(spend.totalOcuHours).toBe(0);
    expect(spend.totalUsd).toBe(0);
    expect(spend.warning).toBeNull();
    expect(spend.terminated).toBe(false);
    expect(spend.retainedSampleCount).toBe(0);
    expect(spend.skippedSampleCount).toBe(0);
  });
});

// ============================================================
// CloudWatch / DynamoDB を差し替えた経路（task 11.3「モックする」）
// ============================================================

/** 固定時計。実時刻に依存させない */
function fixedClock(iso: string): MeasurementClock {
  return {
    now: () => new Date(iso),
    sleep: () => Promise.resolve(),
  };
}

/**
 * CloudWatch の偽実装。
 *
 * `getSeries`（`GetMetricStatistics` 相当）と `getExpressionSeries`（`GetMetricData` +
 * `SEARCH()` 相当）の両方を受け、それぞれの問い合わせを記録する。OCU 系メトリクスは
 * 式の経路でしか引かれないため、`series` に与えたデータ点は式に含まれるメトリクス名で
 * 引き当てる。系列 1 本ぶんとして返す。
 *
 * 複数系列や系列 0 本を返したい場合は {@link fakeExpressionMetricSource} を使う。
 */
function fakeMetricSource(series: Record<string, readonly MetricDataPoint[]>): MetricSource & {
  queries: MetricSeriesQuery[];
  expressions: MetricExpressionQuery[];
} {
  const queries: MetricSeriesQuery[] = [];
  const expressions: MetricExpressionQuery[] = [];
  return {
    queries,
    expressions,
    getSeries: (query: MetricSeriesQuery) => {
      queries.push(query);
      return Promise.resolve(series[query.metricName] ?? []);
    },
    getExpressionSeries: (query: MetricExpressionQuery) => {
      expressions.push(query);
      const metricName = metricNameInExpression(query.expression);
      const points = metricName === null ? [] : (series[metricName] ?? []);
      return Promise.resolve({
        // データ点がないメトリクスは「該当系列なし」として返す（実測の OCUUtilization と同じ形）
        series: points.length === 0 ? [] : [{ label: `${metricName}-series`, statusCode: 'Complete', points }],
        messages: [],
      });
    },
  };
}

/**
 * 式の経路だけを差し替える偽実装。系列本数や `StatusCode` を任意に固定できる。
 *
 * `SEARCH()` が 0 本 / 2 本以上の系列を返す場合の扱いを検証するために使う。
 */
function fakeExpressionMetricSource(
  resultFor: (metricName: string | null, query: MetricExpressionQuery) => MetricExpressionResult
): MetricSource & { expressions: MetricExpressionQuery[] } {
  const expressions: MetricExpressionQuery[] = [];
  return {
    expressions,
    getSeries: () => Promise.resolve([]),
    getExpressionSeries: (query: MetricExpressionQuery) => {
      expressions.push(query);
      return Promise.resolve(resultFor(metricNameInExpression(query.expression), query));
    },
  };
}

/** `SEARCH()` 式に含まれる `MetricName="..."` を読む */
function metricNameInExpression(expression: string): string | null {
  const matched = /MetricName="([^"]+)"/.exec(expression);
  return matched === null ? null : matched[1];
}

/** DynamoDB `DescribeTable` の偽実装 */
function fakeDynamo(table: TableDescriptionSnapshot | null): {
  describeTable: (tableName: string) => Promise<TableDescriptionSnapshot | null>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    describeTable: (tableName: string) => {
      calls.push(tableName);
      return Promise.resolve(table);
    },
  };
}

/** メモリ上の測定結果ストア。ファイルシステムへ触らない */
function memoryStore(initial: Record<string, string> = {}): MeasurementStore & {
  files: Record<string, string>;
  writes: string[];
} {
  const files: Record<string, string> = { ...initial };
  const writes: string[] = [];
  return {
    files,
    writes,
    read: (fileName: string) => Promise.resolve(files[fileName] ?? null),
    write: (fileName: string, contents: string) => {
      files[fileName] = contents;
      writes.push(fileName);
      return Promise.resolve();
    },
    writeNew: (fileName: string, contents: string) => {
      files[fileName] = contents;
      writes.push(fileName);
      return Promise.resolve(`docs/measurements/${fileName}`);
    },
  };
}

describe('runOcu（CloudWatch を差し替え）', () => {
  it('0 OCU が 60 分続く系列で適用可と判定し、区間分解の保存則を自己点検する', async () => {
    const searchPoints: MetricDataPoint[] = [];
    const indexingPoints: MetricDataPoint[] = [];
    for (let i = 0; i < 12; i += 1) {
      searchPoints.push({ timestamp: gridTimestamp(i), value: 0 });
      indexingPoints.push({ timestamp: gridTimestamp(i), value: 0 });
    }
    for (let i = 12; i < 20; i += 1) {
      searchPoints.push({ timestamp: gridTimestamp(i), value: 1 });
      indexingPoints.push({ timestamp: gridTimestamp(i), value: 0 });
    }

    const metrics = fakeMetricSource({
      SearchOCU: searchPoints,
      IndexingOCU: indexingPoints,
      OCUUtilization: [{ timestamp: gridTimestamp(0), value: 12.5 }],
    });

    const report = await runOcu({
      metrics,
      clock: fixedClock('2026-01-02T00:00:00.000Z'),
      collectionGroupName: 'kiro-inventory-vector-group',
      hours: 24,
    });

    expect(report.mode).toBe('ocu');
    expect(report.readOnly).toBe(true);
    expect(report.analysis.sampleCount).toBe(20);
    expect(report.analysis.longestZeroOcuMinutes).toBe(60);
    expect(report.analysis.scaleToZeroApplicable).toBe(true);
    expect(report.analysis.qualifyingZeroOcuMinutes).toBe(60);
    expect(report.partitionConserved).toBe(true);
    expect(report.alignment.pairedCount).toBe(20);
    expect(report.utilization.average.count).toBe(1);
    expect(report.utilization.dataPointsPresent).toBe(true);
    expect(report.utilization.unavailableReason).toBeNull();

    // 照会した次元をレポート自身が示す（0 OCU の報告を検証可能にするため）
    expect(report.collectionGroupName).toBe('kiro-inventory-vector-group');
    expect(report.ocuDimension).toEqual({
      name: 'CollectionGroupName',
      value: 'kiro-inventory-vector-group',
    });
    expect(report.utilization.dimension).toEqual(report.ocuDimension);

    // 参照したのは AWS/AOSS の 3 メトリクスのみ（Collection Group 名で絞っている）
    const metricNames = metrics.expressions
      .map((query) => metricNameInExpression(query.expression))
      .sort();
    expect(metricNames).toEqual([
      'IndexingOCU',
      'OCUUtilization',
      'OCUUtilization',
      'OCUUtilization',
      'SearchOCU',
    ]);
    // 次元集合の完全一致を要求される GetMetricStatistics の経路は OCU では使わない
    expect(metrics.queries.length).toBe(0);
    for (let i = 0; i < metrics.expressions.length; i += 1) {
      expect(metrics.expressions[i].expression).toContain(
        `{AWS/AOSS,${AOSS_OCU_DIMENSION_KEYS.join(',')}}`
      );
      expect(metrics.expressions[i].expression).toContain('"kiro-inventory-vector-group"');
    }

    // 照会した式と系列数・データ点数をレポートへ残す（測定できたことの証跡）
    expect(report.ocuQuery.dimensionKeys).toEqual([
      'ClientId',
      'CollectionGroupId',
      'CollectionGroupName',
    ]);
    expect(report.ocuQuery.filterDimension).toEqual(report.ocuDimension);
    expect(report.ocuQuery.resolutions.length).toBe(5);
    expect(report.ocuQuery.allMeasured).toBe(true);
    const searchResolution = report.ocuQuery.resolutions.find(
      (resolution) => resolution.metricName === SEARCH_OCU_METRIC
    );
    expect(searchResolution?.dataPointCount).toBe(20);
    expect(searchResolution?.seriesCount).toBe(1);
    expect(searchResolution?.seriesWithDataCount).toBe(1);
    expect(searchResolution?.measured).toBe(true);
    expect(searchResolution?.anomaly).toBeNull();
  });

  it('データ点が 0 件なら非適用と警告し、常時課金の見積は出さない', async () => {
    const report = await runOcu({
      metrics: fakeMetricSource({}),
      clock: fixedClock('2026-01-02T00:00:00.000Z'),
    });

    expect(report.analysis.sampleCount).toBe(0);
    expect(report.analysis.scaleToZeroApplicable).toBe(false);
    expect(report.analysis.alwaysOnMonthlyUsd).toBeNull();
    expect(report.warnings.length).toBeGreaterThan(0);
  });

  it('データ点 0 件を「0 OCU を測定した」と読める文言にしない（照会した次元を示し、請求データを要求する）', async () => {
    const report = await runOcu({
      metrics: fakeMetricSource({}),
      clock: fixedClock('2026-01-02T00:00:00.000Z'),
      collectionGroupName: 'kiro-inventory-group',
      hours: 1,
    });

    const warningText = report.warnings.join('\n');

    // 照会した次元を自己記述する（何を訊いて 0 件だったのかが分かる）
    expect(report.ocuDimension).toEqual({
      name: 'CollectionGroupName',
      value: 'kiro-inventory-group',
    });
    expect(warningText).toContain('CollectionGroupName=kiro-inventory-group');

    // 「データ点なし」と「0 OCU」を明示的に区別し、請求データでの確認を求める
    expect(warningText).toContain('データ点が存在しないことは OCU 消費が 0 であったことの証拠になりません');
    expect(warningText).toContain('請求データ');

    // 名前が正しくても出る警告なので「Collection 名を確認してください」とは言わない
    expect(warningText).not.toContain('Collection 名とリージョンを確認してください');

    // OCUUtilization のデータ点なしは、測定値 0 ではなく「測定値が存在しない」として記録する
    expect(report.utilization.dataPointsPresent).toBe(false);
    expect(report.utilization.unavailableReason).not.toBeNull();
    expect(report.utilization.minimum.count).toBe(0);
    expect(warningText).toContain(OCU_UTILIZATION_METRIC);
  });
});

/**
 * OCU メトリクスの照会経路の回帰防止（本 describe を消してはならない）。
 *
 * `SearchOCU` / `IndexingOCU` / `OCUUtilization` は Collection ではなく Collection Group で
 * 公開され、系列は `ClientId` / `CollectionGroupId` / `CollectionGroupName` の **3 次元**を持つ。
 * `CollectionName` で照会すればデータ点は常に 0 件になり、`GetMetricStatistics` へ
 * `CollectionGroupName` の **1 次元だけ**を渡した照会も次元集合の完全一致要求により
 * 常に 0 件になる。どちらも「0 OCU を測定した」と「測定値が存在しない」の区別を静かに壊し、
 * 要件 7.7 の 20 USD 閾値ガードを無効化する（task 13.4 の Q4 も回答不能になる）。
 *
 * ここでは照会経路そのものを固定する。1 次元だけを指定する実装へ戻すと落ちる。
 */
describe('OCU メトリクスは 3 次元の系列を SEARCH() で引く', () => {
  it('次元キー集合は ClientId / CollectionGroupId / CollectionGroupName の 3 件である', () => {
    expect(AOSS_OCU_DIMENSION_KEYS).toEqual([
      'ClientId',
      'CollectionGroupId',
      'CollectionGroupName',
    ]);
    // 絞り込みに使えるのは CollectionGroupName だけ。これは次元集合の全体ではない
    expect(AOSS_OCU_DIMENSION_NAME).toBe('CollectionGroupName');
    expect(AOSS_OCU_DIMENSION_KEYS.length).toBeGreaterThan(1);
    expect(AOSS_OCU_DIMENSION_KEYS).toContain(AOSS_OCU_DIMENSION_NAME);
    // per-Collection メトリクス用の次元名と混同していないこと
    expect(AOSS_PER_COLLECTION_DIMENSION_NAME).toBe('CollectionName');
    expect(AOSS_OCU_DIMENSION_NAME).not.toBe(AOSS_PER_COLLECTION_DIMENSION_NAME);
    expect(AOSS_OCU_DIMENSION_KEYS).not.toContain(AOSS_PER_COLLECTION_DIMENSION_NAME);
  });

  it('aossOcuFilterDimension は絞り込み用の 1 件だけを返し、それが次元集合の全体ではないと分かる', () => {
    expect(aossOcuFilterDimension('kiro-inventory-group')).toEqual({
      name: 'CollectionGroupName',
      value: 'kiro-inventory-group',
    });
    // 絞り込み用の次元 1 件だけでは CloudWatch の完全一致要求を満たさない
    expect(AOSS_OCU_DIMENSION_KEYS.length).toBe(3);
  });

  it('aossOcuSearchExpression は 3 次元のスキーマと Collection Group 名を含む式を組む', () => {
    const expression = aossOcuSearchExpression({
      collectionGroupName: 'kiro-inventory-vector-group',
      metricName: SEARCH_OCU_METRIC,
      statistic: 'Average',
      periodSeconds: OCU_SAMPLE_PERIOD_SECONDS,
    });

    // 実測（us-west-2）で 300 点が返った形と同じ。次元キー集合を式で宣言する
    expect(expression).toBe(
      "SEARCH('{AWS/AOSS,ClientId,CollectionGroupId,CollectionGroupName} " +
        'MetricName="SearchOCU" "kiro-inventory-vector-group"\', \'Average\', 300)'
    );
    expect(expression).toContain(AOSS_METRIC_NAMESPACE);
    for (let i = 0; i < AOSS_OCU_DIMENSION_KEYS.length; i += 1) {
      expect(expression).toContain(AOSS_OCU_DIMENSION_KEYS[i]);
    }
  });

  it('引用符や改行を含む Collection Group 名は式へ埋め込まず例外にする', () => {
    expect(() =>
      aossOcuSearchExpression({
        collectionGroupName: 'group" OR "x',
        metricName: SEARCH_OCU_METRIC,
        statistic: 'Average',
        periodSeconds: OCU_SAMPLE_PERIOD_SECONDS,
      })
    ).toThrow(MeasurementError);
    expect(() =>
      aossOcuSearchExpression({
        collectionGroupName: '',
        metricName: SEARCH_OCU_METRIC,
        statistic: 'Average',
        periodSeconds: OCU_SAMPLE_PERIOD_SECONDS,
      })
    ).toThrow(MeasurementError);
  });

  it('runOcu は 3 つの OCU メトリクスすべてを 3 次元スキーマの SEARCH() で照会する', async () => {
    const metrics = fakeMetricSource({});
    const report = await runOcu({
      metrics,
      clock: fixedClock('2026-01-02T00:00:00.000Z'),
      collectionGroupName: 'group-under-test',
      hours: 1,
    });

    const queried: Record<string, true> = {};
    for (let i = 0; i < metrics.expressions.length; i += 1) {
      const query = metrics.expressions[i];
      const metricName = metricNameInExpression(query.expression);
      if (metricName !== null) queried[metricName] = true;

      // 次元キー集合を式で宣言していること（1 次元だけの照会へ戻ったら落ちる）
      expect(query.expression).toContain(
        `{${AOSS_METRIC_NAMESPACE},${AOSS_OCU_DIMENSION_KEYS.join(',')}}`
      );
      expect(query.expression).toContain('"group-under-test"');
      // 系列の Label に次元値を焼き込む（どの CollectionGroupId を測ったか出力から辿れる）
      expect(query.label).toBe(AOSS_OCU_SERIES_LABEL_TEMPLATE);
      expect(query.label).toContain('CollectionGroupId');
    }

    // 3 メトリクスすべてが上のループを通っていること（照会漏れを見逃さない）
    expect(queried[SEARCH_OCU_METRIC]).toBe(true);
    expect(queried[INDEXING_OCU_METRIC]).toBe(true);
    expect(queried[OCU_UTILIZATION_METRIC]).toBe(true);

    // 次元集合の完全一致を要求される GetMetricStatistics は OCU では一度も使わない
    expect(metrics.queries.length).toBe(0);
    expect(report.ocuQuery.dimensionKeys).toEqual(AOSS_OCU_DIMENSION_KEYS);
  });

  it('runWatchSpend は Collection 名ではなく Collection Group 名で照会する', async () => {
    const metrics = fakeMetricSource({});
    const report = await runWatchSpend({
      metrics,
      clock: fixedClock('2026-01-02T00:00:00.000Z'),
      collectionName: 'collection-under-test',
      collectionGroupName: 'group-under-test',
      hours: 1,
    });

    expect(metrics.expressions.length).toBeGreaterThan(0);
    for (let i = 0; i < metrics.expressions.length; i += 1) {
      expect(metrics.expressions[i].expression).toContain(
        `{${AOSS_METRIC_NAMESPACE},${AOSS_OCU_DIMENSION_KEYS.join(',')}}`
      );
      expect(metrics.expressions[i].expression).toContain('"group-under-test"');
      expect(metrics.expressions[i].expression).not.toContain('collection-under-test');
    }
    expect(metrics.queries.length).toBe(0);

    // --collection は削除要求の対象を示すためだけに使う（照会には使わない）
    expect(report.collectionName).toBe('collection-under-test');
    expect(report.collectionGroupName).toBe('group-under-test');
    expect(report.ocuDimension).toEqual({
      name: 'CollectionGroupName',
      value: 'group-under-test',
    });
    expect(report.ocuQuery.dimensionKeys).toEqual(AOSS_OCU_DIMENSION_KEYS);

    // データ点 0 件を「累積 0 USD」と読める文言にしない
    const warningText = report.warnings.join('\n');
    expect(warningText).toContain('CollectionGroupName=group-under-test');
    expect(warningText).toContain('累積 0 USD と測定できたわけではありません');
    expect(warningText).not.toContain('Collection 名とリージョンを確認してください');
  });

  it('既定値は Vector_Collection_Group 名であり、Collection 名ではない', async () => {
    const metrics = fakeMetricSource({});
    const report = await runOcu({
      metrics,
      clock: fixedClock('2026-01-02T00:00:00.000Z'),
      hours: 1,
    });

    expect(report.ocuDimension.value).toBe(DEFAULT_VECTOR_COLLECTION_GROUP_NAME);
    expect(report.collectionGroupName).toBe(DEFAULT_VECTOR_COLLECTION_GROUP_NAME);
    expect(report.ocuQuery.filterDimension.value).toBe(DEFAULT_VECTOR_COLLECTION_GROUP_NAME);
  });
});

/**
 * 「0 OCU を測定できた」と「測定できていない」の区別（要件 7.7 の閾値ガードの安全側）。
 *
 * 値 0 のデータ点が返るのは測定成功であり、データ点が 0 件返るのは測定不能である。
 * 後者を 0 とみなすと、OCU を消費していても累積 0 USD と報告して閾値ガードが働かなくなる。
 */
describe('値 0 のデータ点と データ点 0 件 を区別する', () => {
  it('値 0 のデータ点が返れば「0 OCU を測定できた」と判定する', async () => {
    const zeroPoints: MetricDataPoint[] = [];
    for (let i = 0; i < 24; i += 1) {
      zeroPoints.push({ timestamp: gridTimestamp(i), value: 0 });
    }

    const report = await runOcu({
      metrics: fakeMetricSource({ SearchOCU: zeroPoints, IndexingOCU: zeroPoints }),
      clock: fixedClock('2026-01-02T00:00:00.000Z'),
      hours: 2,
    });

    // 測定できている（データ点あり）。0 OCU 区間として評価される
    expect(report.analysis.sampleCount).toBe(24);
    expect(report.analysis.combinedOcu.maximum).toBe(0);
    expect(report.analysis.longestZeroOcuMinutes).toBe(120);
    expect(report.analysis.scaleToZeroApplicable).toBe(true);

    const searchResolution = report.ocuQuery.resolutions.find(
      (resolution) => resolution.metricName === SEARCH_OCU_METRIC
    );
    expect(searchResolution?.measured).toBe(true);
    expect(searchResolution?.dataPointCount).toBe(24);
    expect(searchResolution?.anomaly).toBeNull();

    // 「データ点が 0 件です」の警告は出ない
    expect(report.warnings.join('\n')).not.toContain('データ点が 0 件です');
  });

  it('値 0 のデータ点が返れば累積課金も 0 USD と測定できたと判定する', async () => {
    const zeroPoints: MetricDataPoint[] = [];
    for (let i = 0; i < 12; i += 1) {
      zeroPoints.push({ timestamp: gridTimestamp(i), value: 0 });
    }

    const report = await runWatchSpend({
      metrics: fakeMetricSource({ SearchOCU: zeroPoints, IndexingOCU: zeroPoints }),
      clock: fixedClock('2026-01-02T00:00:00.000Z'),
      hours: 1,
    });

    expect(report.spend.retainedSampleCount).toBe(12);
    expect(report.spend.totalUsd).toBe(0);
    expect(report.spend.terminated).toBe(false);
    expect(report.ocuQuery.allMeasured).toBe(true);
    // 測定できているので「評価できていません」とは言わない
    expect(report.warnings.join('\n')).not.toContain('累積課金を評価できていません');
  });

  it('データ点 0 件は測定不能として扱い、閾値ガードを安全側へ倒す', async () => {
    const report = await runWatchSpend({
      metrics: fakeMetricSource({}),
      clock: fixedClock('2026-01-02T00:00:00.000Z'),
      hours: 1,
    });

    expect(report.spend.retainedSampleCount).toBe(0);
    expect(report.ocuQuery.allMeasured).toBe(false);
    for (let i = 0; i < report.ocuQuery.resolutions.length; i += 1) {
      expect(report.ocuQuery.resolutions[i].measured).toBe(false);
      expect(report.ocuQuery.resolutions[i].dataPointCount).toBe(0);
    }

    // 累積 0 USD として通さず、警告として上げる（終了コードは attention）
    const warningText = report.warnings.join('\n');
    expect(warningText).toContain('累積課金を評価できていません');
    expect(warningText).toContain('累積 0 USD と測定できたわけではありません');
    expect(resolveExitCode(report)).toBe(EXIT_CODES.attention);
  });
});

/**
 * `SEARCH()` の系列本数の検証。
 *
 * 次元値を自前で解決しない代償として `SEARCH()` は複数系列を返しうる。実測でも既存の
 * Collection Group `kiro-inventory-group` には 8 本の `CollectionGroupId` 系列が該当し、
 * うち 1 本だけがデータを持っていた。系列数を検証せずに畳み込むと、取りこぼしや
 * 二重計上に気付けない。
 */
describe('SEARCH() の系列本数を検証する', () => {
  const window = { windowStart: '2026-01-01T00:00:00.000Z', windowEnd: '2026-01-02T00:00:00.000Z' };
  const resolve = (result: MetricExpressionResult) =>
    resolveOcuSeries({
      metricName: SEARCH_OCU_METRIC,
      statistic: 'Average',
      expression: 'SEARCH(...)',
      collectionGroupName: 'group-under-test',
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      result,
    });

  it('データを持つ系列が 1 本なら正常に畳み込む', () => {
    const { resolution, points } = resolve({
      series: [
        {
          label: 'group-under-test / abc123 / SearchOCU',
          statusCode: 'Complete',
          points: [
            { timestamp: gridTimestamp(0), value: 0 },
            { timestamp: gridTimestamp(1), value: 2 },
          ],
        },
      ],
      messages: [],
    });

    expect(resolution.seriesCount).toBe(1);
    expect(resolution.seriesWithDataCount).toBe(1);
    expect(resolution.dataPointCount).toBe(2);
    expect(resolution.measured).toBe(true);
    expect(resolution.anomaly).toBeNull();
    expect(points.map((point) => point.value)).toEqual([0, 2]);
    // 系列の Label を記録する（どの CollectionGroupId の系列か辿れる）
    expect(resolution.series[0].label).toBe('group-under-test / abc123 / SearchOCU');
  });

  it('系列が 0 本なら測定不能とし、0 OCU とみなさない', () => {
    const { resolution, points } = resolve({ series: [], messages: [] });

    expect(resolution.seriesCount).toBe(0);
    expect(resolution.seriesWithDataCount).toBe(0);
    expect(resolution.measured).toBe(false);
    expect(points.length).toBe(0);
    expect(resolution.anomaly).not.toBeNull();
    expect(resolution.anomaly).toContain('測定できていない');
  });

  it('データを持たない系列だけが並ぶ場合も測定不能とする（実測の作り直し履歴と同じ形）', () => {
    const { resolution } = resolve({
      series: [
        { label: 'group-under-test / old1 / SearchOCU', statusCode: 'Complete', points: [] },
        { label: 'group-under-test / old2 / SearchOCU', statusCode: 'Complete', points: [] },
      ],
      messages: [],
    });

    expect(resolution.seriesCount).toBe(2);
    expect(resolution.seriesWithDataCount).toBe(0);
    expect(resolution.measured).toBe(false);
    expect(resolution.anomaly).toContain('測定できていない');
  });

  it('データを持つ系列が 2 本以上なら警告し、同一時刻は最大値を採る（過小評価しない）', () => {
    const { resolution, points } = resolve({
      series: [
        {
          label: 'group-under-test / idA / SearchOCU',
          statusCode: 'Complete',
          points: [
            { timestamp: gridTimestamp(0), value: 1 },
            { timestamp: gridTimestamp(1), value: 4 },
          ],
        },
        {
          label: 'group-under-test / idB / SearchOCU',
          statusCode: 'Complete',
          points: [
            { timestamp: gridTimestamp(0), value: 3 },
            { timestamp: gridTimestamp(2), value: 5 },
          ],
        },
      ],
      messages: [],
    });

    expect(resolution.seriesWithDataCount).toBe(2);
    expect(resolution.anomaly).not.toBeNull();
    expect(resolution.anomaly).toContain('2 本');
    expect(resolution.measured).toBe(true);
    // 同一時刻は最大値、片方だけにある時刻はその値
    expect(points).toEqual([
      { timestamp: gridTimestamp(0), value: 3 },
      { timestamp: gridTimestamp(1), value: 4 },
      { timestamp: gridTimestamp(2), value: 5 },
    ]);
  });

  it('runOcu はデータを持つ系列が 2 本以上のとき警告する', async () => {
    const points = [
      { timestamp: gridTimestamp(0), value: 1 },
      { timestamp: gridTimestamp(1), value: 1 },
    ];
    const metrics = fakeExpressionMetricSource((metricName) =>
      metricName === SEARCH_OCU_METRIC
        ? {
            series: [
              { label: 'group / idA / SearchOCU', statusCode: 'Complete', points },
              { label: 'group / idB / SearchOCU', statusCode: 'Complete', points },
            ],
            messages: [],
          }
        : { series: [], messages: [] }
    );

    const report = await runOcu({
      metrics,
      clock: fixedClock('2026-01-02T00:00:00.000Z'),
      collectionGroupName: 'group-under-test',
      hours: 1,
    });

    const warningText = report.warnings.join('\n');
    expect(warningText).toContain('SEARCH() がデータ点を持つ系列を 2 本返しました');
    expect(warningText).toContain('idA');
    expect(warningText).toContain('idB');
    expect(resolveExitCode(report)).toBe(EXIT_CODES.attention);
  });
});

/** `GetMetricData` の応答を系列へ写す（ページをまたいだ同一系列の結合を含む） */
describe('readMetricExpressionResult', () => {
  it('Timestamps と Values を突き合わせ、時刻昇順へ整える', () => {
    const result = readMetricExpressionResult([
      {
        MetricDataResults: [
          {
            Id: 'ocu',
            Label: 'group / id1 / SearchOCU',
            StatusCode: 'Complete',
            Timestamps: [new Date('2026-01-01T00:10:00.000Z'), new Date('2026-01-01T00:00:00.000Z')],
            Values: [2, 1],
          },
        ],
        Messages: [],
      },
    ]);

    expect(result.series.length).toBe(1);
    expect(result.series[0].label).toBe('group / id1 / SearchOCU');
    expect(result.series[0].statusCode).toBe('Complete');
    expect(result.series[0].points).toEqual([
      { timestamp: '2026-01-01T00:00:00.000Z', value: 1 },
      { timestamp: '2026-01-01T00:10:00.000Z', value: 2 },
    ]);
  });

  it('ページをまたいだ同一 Label の系列を 1 本へ束ね、メッセージを保持する', () => {
    const result = readMetricExpressionResult([
      {
        MetricDataResults: [
          {
            Label: 'group / id1 / SearchOCU',
            StatusCode: 'PartialData',
            Timestamps: [new Date('2026-01-01T00:00:00.000Z')],
            Values: [1],
          },
        ],
        Messages: [{ Code: 'Throttling', Value: '一部のデータが欠けています' }],
      },
      {
        MetricDataResults: [
          {
            Label: 'group / id1 / SearchOCU',
            StatusCode: 'Complete',
            Timestamps: [new Date('2026-01-01T00:05:00.000Z')],
            Values: [2],
          },
        ],
      },
    ]);

    expect(result.series.length).toBe(1);
    expect(result.series[0].points.length).toBe(2);
    expect(result.series[0].statusCode).toBe('Complete');
    expect(result.messages).toEqual(['一部のデータが欠けています']);
  });

  it('系列が 0 本の応答は空の系列列として返す（0 とみなさない責任は呼び出し側）', () => {
    expect(readMetricExpressionResult([{ MetricDataResults: [], Messages: [] }])).toEqual({
      series: [],
      messages: [],
    });
  });
});

describe('runWatchSpend（CloudWatch を差し替え）', () => {
  it('20 USD を初めて超えた時点で打ち切り、削除実行を要求する警告を出す', async () => {
    // 1 サンプル = 5 分 = 1/12 h。16 OCU × 1/12 h × 0.24 USD = 0.32 USD/サンプル
    // 63 サンプルで 20.16 USD となり、63 件目で初めて 20 USD を超える
    const searchPoints: MetricDataPoint[] = [];
    for (let i = 0; i < 80; i += 1) {
      searchPoints.push({ timestamp: gridTimestamp(i), value: 16 });
    }

    const report = await runWatchSpend({
      metrics: fakeMetricSource({ SearchOCU: searchPoints, IndexingOCU: [] }),
      clock: fixedClock('2026-01-02T00:00:00.000Z'),
    });

    expect(report.mode).toBe('watch-spend');
    expect(report.spend.thresholdUsd).toBe(SPEND_THRESHOLD_USD);
    expect(report.spend.terminated).toBe(true);
    expect(report.spend.warning).not.toBeNull();
    expect(report.spend.retainedSampleCount).toBe(63);
    expect(report.spend.skippedSampleCount).toBe(80 - 63);
    expect(report.spend.totalUsd).toBeGreaterThan(SPEND_THRESHOLD_USD);
    expect(report.spend.points[62].thresholdCrossed).toBe(true);

    // 区間分解は「保持した測定値」の範囲に対して行う（要件 14.9）
    expect(report.analysis.sampleCount).toBe(63);
    expect(sumIntervalOcuHours(report.analysis.activityPartition)).toBeCloseTo(
      report.spend.totalOcuHours,
      9
    );

    // 削除実行の要求が警告に出ている（削除は実行しない）
    const warningText = report.warnings.join('\n');
    expect(warningText).toContain('kiro-inventory-vector');
    expect(warningText).toContain('削除');
    expect(report.readOnly).toBe(true);
  });

  it('閾値を超えなければ警告せず全件を積算する', async () => {
    const searchPoints: MetricDataPoint[] = [];
    for (let i = 0; i < 10; i += 1) {
      searchPoints.push({ timestamp: gridTimestamp(i), value: 0.5 });
    }

    const report = await runWatchSpend({
      metrics: fakeMetricSource({ SearchOCU: searchPoints, IndexingOCU: [] }),
      clock: fixedClock('2026-01-02T00:00:00.000Z'),
    });

    expect(report.spend.warning).toBeNull();
    expect(report.spend.terminated).toBe(false);
    expect(report.spend.retainedSampleCount).toBe(10);
    expect(report.spend.skippedSampleCount).toBe(0);
    expect(report.spend.totalUsd).toBeLessThanOrEqual(SPEND_THRESHOLD_USD);
  });
});

describe('runStorage（DynamoDB を差し替え）', () => {
  /** 6 時間おき・相対差 1% 以内で収束する台帳 */
  function convergedLedgerJson(): string {
    const snapshots: StorageSnapshot[] = [
      tableSnapshot({ label: 'S1', value: 1_000_000, capturedAt: gridTimestamp(0) }),
      tableSnapshot({ label: 'S1', value: 1_005_000, capturedAt: gridTimestamp(72) }),
      tableSnapshot({ label: 'S2', value: 4_000_000, capturedAt: gridTimestamp(144) }),
      tableSnapshot({ label: 'S2', value: 4_010_000, capturedAt: gridTimestamp(216) }),
      indexSnapshot({ target: INDEX_JA, value: 900_000, capturedAt: gridTimestamp(288) }),
      indexSnapshot({ target: INDEX_JA, value: 903_000, capturedAt: gridTimestamp(360) }),
      indexSnapshot({ target: INDEX_EN, value: 800_000, capturedAt: gridTimestamp(288) }),
      indexSnapshot({ target: INDEX_EN, value: 802_000, capturedAt: gridTimestamp(360) }),
    ];
    return `${JSON.stringify({ schemaVersion: 1, snapshots }, null, 2)}\n`;
  }

  it('収束済みの台帳から寄与・平均増分・インデックス合計を算出する', async () => {
    const store = memoryStore({ [STORAGE_SNAPSHOT_STORE_FILE]: convergedLedgerJson() });
    const dynamo = fakeDynamo(null);

    const report = await runStorage({
      dynamo,
      store,
      clock: fixedClock('2026-01-05T00:00:00.000Z'),
      label: null,
      recordCount: VECTOR_RECORD_COUNT,
    });

    // 新規取得なし（DescribeTable を呼んでいない）
    expect(dynamo.calls.length).toBe(0);
    expect(report.capturedSnapshots.length).toBe(0);
    expect(report.ledgerSnapshotCount).toBe(8);

    // 採用値は 2 回目の取得値（S1 = 1,005,000 / S2 = 4,010,000）
    expect(report.contribution).not.toBeNull();
    expect(report.contribution?.vectorAttributeContributionBytes).toBe(4_010_000 - 1_005_000);
    expect(report.contribution?.averagePerRecordBytes).toBe(
      (4_010_000 - 1_005_000) / VECTOR_RECORD_COUNT
    );
    expect(report.contributionDeterminate).toBe(true);
    expect(report.contribution?.gsiAdjustmentApplied).toBe(false);

    // インデックス合計は 2 本の直接取得値の和
    expect(report.indexTotals?.totalIndexSizeBytes).toBe(903_000 + 802_000);
    expect(report.indexTotals?.derivedFromTableSizeDifference).toBe(false);
    expect(report.indexTotalsDeterminate).toBe(true);
    expect(report.gsiNote).toBe(GSI_ADJUSTMENT_NOTE);
    expect(report.indexSizeNote).toBe(INDEX_SIZE_DIRECT_NOTE);
    expect(report.readOnly).toBe(true);
  });

  it('新規取得は台帳へ追記し、先行するスナップショットを破棄しない', async () => {
    const store = memoryStore({ [STORAGE_SNAPSHOT_STORE_FILE]: convergedLedgerJson() });
    const table: TableDescriptionSnapshot = {
      tableName: VECTOR_TABLE,
      tableStatus: 'ACTIVE',
      itemCount: 15_000,
      tableSizeBytes: 4_015_000,
      keySchema: ['itemId:HASH', 'warehouseId:RANGE'],
      globalSecondaryIndexes: [],
      streamEnabled: false,
      streamViewType: null,
      vectorIndexes: [
        {
          indexName: INDEX_JA,
          indexStatus: 'ACTIVE',
          backfilling: false,
          backfillingPresent: false,
          searchable: true,
          indexSizeBytes: 905_000,
          itemCount: 15_000,
        },
      ],
    };

    const report = await runStorage({
      dynamo: fakeDynamo(table),
      store,
      clock: fixedClock('2026-01-06T00:00:00.000Z'),
      tableName: VECTOR_TABLE,
      label: 'S2',
    });

    // 既存 8 件 + 新規 2 件（TableSizeBytes 1 件 + IndexSizeBytes 1 件）
    expect(report.capturedSnapshots.length).toBe(2);
    expect(report.ledgerSnapshotCount).toBe(10);
    expect(report.ledgerPath).toContain(STORAGE_SNAPSHOT_STORE_FILE);
    expect(store.writes).toEqual([STORAGE_SNAPSHOT_STORE_FILE]);

    // 書き戻した台帳に先行分がすべて残っている
    const written = JSON.parse(store.files[STORAGE_SNAPSHOT_STORE_FILE]) as {
      snapshots: StorageSnapshot[];
    };
    expect(written.snapshots.length).toBe(10);
    expect(written.snapshots[0].capturedAt).toBe(gridTimestamp(0));
    expect(written.snapshots[0].value).toBe(1_000_000);
  });

  it('S1 / S2 が揃っていなければ寄与を算出せず警告する', async () => {
    const snapshots: StorageSnapshot[] = [
      tableSnapshot({ label: 'S1', value: 1_000_000, capturedAt: gridTimestamp(0) }),
      tableSnapshot({ label: 'S1', value: 1_002_000, capturedAt: gridTimestamp(72) }),
    ];
    const store = memoryStore({
      [STORAGE_SNAPSHOT_STORE_FILE]: `${JSON.stringify({ schemaVersion: 1, snapshots })}\n`,
    });

    const report = await runStorage({
      dynamo: fakeDynamo(null),
      store,
      clock: fixedClock('2026-01-05T00:00:00.000Z'),
      label: null,
    });

    expect(report.contribution).toBeNull();
    expect(report.contributionDeterminate).toBe(false);
    expect(report.indexTotals).toBeNull();
    expect(report.warnings.length).toBeGreaterThan(0);
  });
});

// ============================================================
// 実効リージョンの記録（要件 14.17 / task 13.20 の比較基準）
// ============================================================

const GOOD_TABLE = 'kiro-roasters-inventory-good';
const RESOLVED_REGION = 'us-west-2';

/** 要件 1.5 の期待どおりの Good_Table。期待外れによる警告を混ぜずにリージョンだけを見る */
function goodTableDescription(): TableDescriptionSnapshot {
  return {
    tableName: GOOD_TABLE,
    tableStatus: 'ACTIVE',
    itemCount: EXPECTED_GOOD_TABLE_ITEM_COUNT,
    tableSizeBytes: 12_345_678,
    keySchema: ['itemId:HASH', 'warehouseId:RANGE'],
    globalSecondaryIndexes: EXPECTED_GOOD_TABLE_GSI_NAMES.map((indexName) => ({
      indexName,
      keySchema: ['warehouseId:HASH', 'itemId:RANGE'],
      projectionType: 'ALL',
      nonKeyAttributes: [],
    })),
    streamEnabled: true,
    streamViewType: EXPECTED_GOOD_TABLE_STREAM_VIEW_TYPE,
    vectorIndexes: [],
  };
}

/** `Scan` が返す形の抽出アイテム（AttributeValue 形式）を 10 件作る */
function goodTableItems(): readonly Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (let i = 0; i < GOOD_TABLE_SAMPLE_ITEM_COUNT; i += 1) {
    items.push({
      itemId: { S: `ITEM-${String(i).padStart(4, '0')}` },
      warehouseId: { S: 'WH-1' },
      quantity: { N: String(i * 3) },
    });
  }
  return items;
}

/** Good_Table 読み取り経路の偽実装。実 AWS へは触れない */
function fakeGoodTableDynamo(
  table: TableDescriptionSnapshot | null = goodTableDescription()
): DynamoDbMeasurementSource {
  const items = goodTableItems();
  return {
    describeTable: () => Promise.resolve(table),
    describeContinuousBackups: () => Promise.resolve(EXPECTED_GOOD_TABLE_PITR_STATUS),
    listTableNames: () => Promise.resolve([GOOD_TABLE]),
    sampleItems: () => Promise.resolve(items),
    getItemsByKeys: () => Promise.resolve(items),
  };
}

/** OSIS 読み取り経路の偽実装 */
function fakePipelines(status: string | null = EXPECTED_PIPELINE_STATUS): PipelineStateSource {
  return { getPipelineStatus: () => Promise.resolve(status) };
}

describe('resolveEffectiveRegion（SDK の解決経路を差し替え）', () => {
  it('--region が明示されていれば解決経路を呼ばずにその値を採る', async () => {
    let called = 0;
    const resolution = await resolveEffectiveRegion('ap-northeast-1', () => {
      called += 1;
      return Promise.resolve(RESOLVED_REGION);
    });

    expect(resolution.region).toBe('ap-northeast-1');
    expect(resolution.warning).toBeNull();
    expect(called).toBe(0);
  });

  it('--region が無ければ SDK の既定解決で得た実効リージョンを採る', async () => {
    const fromNull = await resolveEffectiveRegion(null, () => Promise.resolve(RESOLVED_REGION));
    const fromUndefined = await resolveEffectiveRegion(undefined, () =>
      Promise.resolve(RESOLVED_REGION)
    );

    expect(fromNull.region).toBe(RESOLVED_REGION);
    expect(fromNull.warning).toBeNull();
    expect(fromUndefined.region).toBe(RESOLVED_REGION);
    expect(fromUndefined.warning).toBeNull();
  });

  it('解決に失敗しても例外にせず、null と注意文を返す', async () => {
    const resolution = await resolveEffectiveRegion(null, () =>
      Promise.reject(new Error('Region is missing'))
    );

    expect(resolution.region).toBeNull();
    expect(resolution.warning).not.toBeNull();
    expect(resolution.warning).toContain('--region');
    expect(resolution.warning).toContain('Region is missing');
  });

  it('空文字を返す解決経路も未解決として扱い、値を捏造しない', async () => {
    const resolution = await resolveEffectiveRegion('', () => Promise.resolve(''));

    expect(resolution.region).toBeNull();
    expect(resolution.warning).not.toBeNull();
  });
});

describe('runPreCheck（DynamoDB / OSIS を差し替え）', () => {
  it('解決済みのリージョンをレポートとスナップショットの両方へ記録する', async () => {
    const store = memoryStore();
    const resolution = await resolveEffectiveRegion(null, () => Promise.resolve(RESOLVED_REGION));

    const report = await runPreCheck({
      dynamo: fakeGoodTableDynamo(),
      pipelines: fakePipelines(),
      store,
      clock: fixedClock('2026-01-02T00:00:00.000Z'),
      region: resolution.region,
      goodTableName: GOOD_TABLE,
    });

    // --region を渡していないが、SDK の既定解決で決まった実効リージョンが載る
    expect(report.region).toBe(RESOLVED_REGION);
    expect(report.goodTableSnapshot?.region).toBe(RESOLVED_REGION);
    expect(report.goodTableSnapshot?.schemaVersion).toBe(GOOD_TABLE_SNAPSHOT_SCHEMA_VERSION);
    expect(report.readOnly).toBe(true);

    // 比較の成果物であるスナップショットファイル自身がリージョンを持つ
    const written = JSON.parse(store.files[GOOD_TABLE_SNAPSHOT_FILE]) as GoodTableSnapshot;
    expect(written.region).toBe(RESOLVED_REGION);
    expect(written.schemaVersion).toBe(GOOD_TABLE_SNAPSHOT_SCHEMA_VERSION);

    // 要約にも実効リージョンが出る（「(既定の解決)」で誤魔化さない）
    expect(formatReportSummary(report)).toContain(`リージョン: ${RESOLVED_REGION}`);
  });

  it('リージョンが未解決なら null のまま記録し、読み取り専用の実行は継続する', async () => {
    const resolution = await resolveEffectiveRegion(null, () =>
      Promise.reject(new Error('Region is missing'))
    );

    const report = await runPreCheck({
      dynamo: fakeGoodTableDynamo(),
      pipelines: fakePipelines(),
      store: memoryStore(),
      clock: fixedClock('2026-01-02T00:00:00.000Z'),
      region: resolution.region,
      goodTableName: GOOD_TABLE,
    });

    // 例外にはならず、スナップショットは取得できている
    expect(report.region).toBeNull();
    expect(report.goodTableSnapshot).not.toBeNull();
    expect(report.goodTableSnapshot?.region).toBeNull();

    // 未解決は注意事項として残り、終了コードで見落とされないようにする
    const withWarning = appendReportWarning(report, resolution.warning);
    expect(withWarning.mode).toBe('pre-check');
    expect(withWarning.warnings.length).toBe(report.warnings.length + 1);
    expect(withWarning.warnings.join('\n')).toContain('--region');
    expect(resolveExitCode(withWarning)).toBe(EXIT_CODES.attention);
    expect(formatReportSummary(withWarning)).toContain('リージョン: (解決できず。--region の明示が必要)');
  });

  it('解決できたときは注意文を足さず、レポートをそのまま返す', async () => {
    const report = await runPreCheck({
      dynamo: fakeGoodTableDynamo(),
      pipelines: fakePipelines(),
      store: memoryStore(),
      clock: fixedClock('2026-01-02T00:00:00.000Z'),
      region: RESOLVED_REGION,
      goodTableName: GOOD_TABLE,
    });

    expect(appendReportWarning(report, null)).toBe(report);
    expect(report.warnings).toEqual([]);
    expect(resolveExitCode(report)).toBe(EXIT_CODES.ok);
  });
});

describe('Good_Table スナップショットのリージョン記録と後方互換', () => {
  /** 版 1（`region` を持たない）の基準ファイル。実際に取得済みのものと同じ形 */
  function legacySnapshotJson(): string {
    const current = buildGoodTableSnapshot({
      table: goodTableDescription(),
      pointInTimeRecoveryStatus: EXPECTED_GOOD_TABLE_PITR_STATUS,
      items: goodTableItems(),
      capturedAt: '2026-01-01T00:00:00.000Z',
      region: RESOLVED_REGION,
    });
    const legacy: Record<string, unknown> = { ...current, schemaVersion: 1 };
    delete legacy.region;
    return `${JSON.stringify(legacy, null, 2)}\n`;
  }

  it('region を持たない版 1 の基準を読めて、region は null になる', () => {
    const baseline = parseGoodTableSnapshot(legacySnapshotJson());

    expect(baseline.schemaVersion).toBe(1);
    expect(baseline.region).toBeNull();
    expect(baseline.sampleItems.length).toBe(GOOD_TABLE_SAMPLE_ITEM_COUNT);
  });

  it('基準に region が無くても、リージョンの不一致として撤収確認を落とさない', () => {
    const baseline = parseGoodTableSnapshot(legacySnapshotJson());
    const current = buildGoodTableSnapshot({
      table: goodTableDescription(),
      pointInTimeRecoveryStatus: EXPECTED_GOOD_TABLE_PITR_STATUS,
      items: goodTableItems(),
      capturedAt: '2026-01-02T00:00:00.000Z',
      region: RESOLVED_REGION,
    });

    const comparison = compareGoodTableSnapshots(baseline, current);

    expect(comparison.identical).toBe(true);
    expect(comparison.differences).toEqual([]);
    expect(comparison.comparedItemCount).toBe(GOOD_TABLE_SAMPLE_ITEM_COUNT);
  });

  it('両側のリージョンが判明していて異なる場合は相違として記録する', () => {
    const baseline = buildGoodTableSnapshot({
      table: goodTableDescription(),
      pointInTimeRecoveryStatus: EXPECTED_GOOD_TABLE_PITR_STATUS,
      items: goodTableItems(),
      capturedAt: '2026-01-01T00:00:00.000Z',
      region: RESOLVED_REGION,
    });
    const current = buildGoodTableSnapshot({
      table: goodTableDescription(),
      pointInTimeRecoveryStatus: EXPECTED_GOOD_TABLE_PITR_STATUS,
      items: goodTableItems(),
      capturedAt: '2026-01-02T00:00:00.000Z',
      region: 'ap-northeast-1',
    });

    const comparison = compareGoodTableSnapshots(baseline, current);

    expect(comparison.identical).toBe(false);
    expect(comparison.differences).toContainEqual({
      field: 'region',
      baseline: RESOLVED_REGION,
      current: 'ap-northeast-1',
    });
  });

  it('現在側のリージョンだけが未解決でも相違にはしない', () => {
    const baseline = buildGoodTableSnapshot({
      table: goodTableDescription(),
      pointInTimeRecoveryStatus: EXPECTED_GOOD_TABLE_PITR_STATUS,
      items: goodTableItems(),
      capturedAt: '2026-01-01T00:00:00.000Z',
      region: RESOLVED_REGION,
    });
    const current = buildGoodTableSnapshot({
      table: goodTableDescription(),
      pointInTimeRecoveryStatus: EXPECTED_GOOD_TABLE_PITR_STATUS,
      items: goodTableItems(),
      capturedAt: '2026-01-02T00:00:00.000Z',
      region: null,
    });

    expect(compareGoodTableSnapshots(baseline, current).identical).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `SearchVectors` の要求本文と `ConsumedCapacity`（task 13.13 の実測を固定する）
// ---------------------------------------------------------------------------

describe('buildSearchVectorsRequestBody（task 13.13 の実測を固定する）', () => {
  it('SearchVector を AttributeValue[] で組み立てる（素の数値配列は実 API に拒否される）', () => {
    const body = buildSearchVectorsRequestBody({
      tableName: 'kiro-roasters-inventory-vector',
      indexName: 'byEmbeddingJa',
      searchVector: [-0.5, 0, 0.25],
      topK: 1,
    });

    // 実測（task 13.13）: 素の数値配列で送ると HTTP 400
    // `{"__type":"com.amazon.coral.service#SerializationException"}` になる。
    // SDK モデルの `SearchVectorsInput.SearchVector: AttributeValue[]` の形のみが受理される
    expect(body.SearchVector).toEqual([{ N: '-0.5' }, { N: '0' }, { N: '0.25' }]);
    expect(body.TableName).toBe('kiro-roasters-inventory-vector');
    expect(body.IndexName).toBe('byEmbeddingJa');
    expect(body.TopK).toBe(1);
    expect(body.ReturnConsumedCapacity).toBe('TOTAL');
  });

  it('1,024 次元の決定論的クエリベクトルも全要素が AttributeValue になる', () => {
    const searchVector = buildDeterministicQueryVector(1024, 20260101);
    const body = buildSearchVectorsRequestBody({
      tableName: 't',
      indexName: 'byEmbeddingJa',
      searchVector,
      topK: 30,
    });
    const elements = body.SearchVector as unknown[];

    expect(elements).toHaveLength(1024);
    for (const element of elements) {
      expect(Object.keys(element as Record<string, unknown>)).toEqual(['N']);
    }
  });
});

describe('readVectorSearchRequestBytes（task 13.13 の実測を固定する）', () => {
  it('実応答の ConsumedCapacity から VectorSearchRequestBytes を読む', () => {
    // 実 API の生応答（2026-08-21T13:09:22Z / us-west-2 / byEmbeddingJa / TopK 1）。
    // `VectorSearchUnits` は SDK の `VectorCapacity` モデルに無いが実 API が返す。
    // 要件 14.7 の測定対象は `VectorSearchRequestBytes` であり、そちらを読む
    expect(
      readVectorSearchRequestBytes({ VectorSearchRequestBytes: 61318, VectorSearchUnits: 61318 })
    ).toBe(61318);
  });

  it('読めない場合は 0 と決めつけずに null を返す', () => {
    expect(readVectorSearchRequestBytes({ VectorSearchUnits: 61318 })).toBeNull();
    expect(readVectorSearchRequestBytes({ CapacityUnits: 1 })).toBeNull();
    expect(readVectorSearchRequestBytes(undefined)).toBeNull();
  });
});

describe('readVectorSearchUnits（SDK モデルに無い項目を生応答から読む。要件 8.11）', () => {
  it('実応答の ConsumedCapacity から VectorSearchUnits を読む', () => {
    expect(
      readVectorSearchUnits({ VectorSearchRequestBytes: 61318, VectorSearchUnits: 61318 })
    ).toBe(61318);
  });

  it('VectorSearchRequestBytes と食い違う値でもそのまま読む（一致を前提にしない）', () => {
    expect(
      readVectorSearchUnits({ VectorSearchRequestBytes: 61318, VectorSearchUnits: 4096 })
    ).toBe(4096);
  });

  it('読めない場合は 0 と決めつけずに null を返す', () => {
    expect(readVectorSearchUnits({ VectorSearchRequestBytes: 61318 })).toBeNull();
    expect(readVectorSearchUnits(undefined)).toBeNull();
  });
});

describe('summarizeConsumedCapacity（VectorSearchUnits の一致判定。task 13.18）', () => {
  const baseInput = {
    language: 'ja' as const,
    indexName: 'byEmbeddingJa',
    topK: 30,
    queryCount: 1,
    measurementStartedAt: '2026-08-22T05:00:00.000Z',
    measurementEndedAt: '2026-08-22T05:01:00.000Z',
  };

  it('2 項目が全件同値なら unitsAlwaysEqualRequestBytes が true になる', () => {
    const summary = summarizeConsumedCapacity({
      ...baseInput,
      samples: [
        {
          attempt: 1,
          succeeded: true,
          vectorSearchRequestBytes: 61318,
          vectorSearchUnits: 61318,
          latencyMs: 40,
          errorType: null,
          errorMessage: null,
        },
        {
          attempt: 2,
          succeeded: true,
          vectorSearchRequestBytes: 63390,
          vectorSearchUnits: 63390,
          latencyMs: 38,
          errorType: null,
          errorMessage: null,
        },
      ],
    });

    expect(summary.unitsAlwaysEqualRequestBytes).toBe(true);
    expect(summary.unitsEqualRequestBytesCount).toBe(2);
    expect(summary.unitsDivergentCount).toBe(0);
    expect(summary.unitsTotal).toBe(124708);
    expect(summary.unitsMeasuredCount).toBe(2);
  });

  it('食い違いがあれば内訳を残して false にする', () => {
    const summary = summarizeConsumedCapacity({
      ...baseInput,
      samples: [
        {
          attempt: 1,
          succeeded: true,
          vectorSearchRequestBytes: 61318,
          vectorSearchUnits: 61318,
          latencyMs: 40,
          errorType: null,
          errorMessage: null,
        },
        {
          attempt: 2,
          succeeded: true,
          vectorSearchRequestBytes: 61318,
          vectorSearchUnits: 4096,
          latencyMs: 41,
          errorType: null,
          errorMessage: null,
        },
      ],
    });

    expect(summary.unitsAlwaysEqualRequestBytes).toBe(false);
    expect(summary.unitsDivergentCount).toBe(1);
    expect(summary.unitsDivergences).toEqual([{ attempt: 2, requestBytes: 61318, units: 4096 }]);
  });

  it('両項目を読めた検索が 0 件なら一致を主張せず null にする', () => {
    const summary = summarizeConsumedCapacity({
      ...baseInput,
      samples: [
        {
          attempt: 1,
          succeeded: true,
          vectorSearchRequestBytes: 61318,
          vectorSearchUnits: null,
          latencyMs: 40,
          errorType: null,
          errorMessage: null,
        },
        {
          attempt: 2,
          succeeded: false,
          vectorSearchRequestBytes: null,
          vectorSearchUnits: null,
          latencyMs: 12,
          errorType: 'SerializationException',
          errorMessage: 'bad request',
        },
      ],
    });

    expect(summary.unitsAlwaysEqualRequestBytes).toBeNull();
    expect(summary.unitsMeasuredCount).toBe(0);
    expect(summary.failureCount).toBe(1);
  });
});

// ============================================================
// `Backfilling` フィールド不在の扱い（要件 5.14 / 5.15 / 5.17、設計 V20、task 18.4）
// ============================================================

/**
 * task 13.12 の実測で `DescribeTable` の `VectorIndexDescription` に `Backfilling` キーが
 * 一度も現れないことが判明した（13.7 のデプロイ直後でも 13.12 の時点でも不在）。
 *
 * 検索可否の判定（`Backfilling !== true`）は「不在 = 偽」で成立する一方、
 * **バックフィル完了までの経過時間（要件 5.14）は測定できない。** ここで固定するのは
 * 「不在のときに経過秒を 0 秒や即時完了として記録しない」ことと、
 * 「不在であったことが出力に現れる」ことである。
 */

/** `--wait-index` が読む状態 1 本。`Backfilling` の観測有無だけを変えられるようにする */
function indexState(options: {
  indexName: string;
  indexStatus: string;
  /** `undefined` は `DescribeTable` にキーが無かったことを表す */
  backfilling?: boolean;
}): VectorIndexState {
  const backfilling = options.backfilling === true;
  return {
    indexName: options.indexName,
    indexStatus: options.indexStatus,
    backfilling,
    backfillingPresent: typeof options.backfilling === 'boolean',
    searchable: options.indexStatus === 'ACTIVE' && !backfilling,
    indexSizeBytes: null,
    itemCount: null,
  };
}

/** ベクトルインデックスの状態だけを差し替えた `DescribeTable` の応答 */
function vectorTableWith(states: readonly VectorIndexState[]): TableDescriptionSnapshot {
  return {
    tableName: VECTOR_TABLE,
    tableStatus: 'ACTIVE',
    itemCount: VECTOR_RECORD_COUNT,
    tableSizeBytes: 138_127_144,
    keySchema: ['itemId:HASH', 'warehouseId:RANGE'],
    globalSecondaryIndexes: [],
    streamEnabled: false,
    streamViewType: null,
    vectorIndexes: states,
  };
}

/**
 * ポーリングごとに応答を切り替え、`sleep` で仮想時刻を進める時計付きの偽実装。
 * 実時間を待たずに複数ポーリングにわたる遷移を観測できる。
 */
function pollingSource(pages: readonly (readonly VectorIndexState[])[]): {
  dynamo: Pick<DynamoDbMeasurementSource, 'describeTable'>;
  clock: MeasurementClock;
  calls: () => number;
} {
  let index = 0;
  let nowMs = BASE_EPOCH_MS;

  return {
    dynamo: {
      describeTable: () => {
        const page = pages[Math.min(index, pages.length - 1)];
        index += 1;
        return Promise.resolve(vectorTableWith(page));
      },
    },
    clock: {
      now: () => new Date(nowMs),
      sleep: (milliseconds: number) => {
        nowMs += milliseconds;
        return Promise.resolve();
      },
    },
    calls: () => index,
  };
}

describe('readVectorIndexStates（Backfilling キーの有無を区別する）', () => {
  it('キーが不在なら偽として扱いつつ backfillingPresent は false になる', () => {
    const states = readVectorIndexStates({
      VectorIndexes: [{ IndexName: INDEX_JA, IndexStatus: 'ACTIVE' }],
    });

    expect(states).toHaveLength(1);
    expect(states[0].backfilling).toBe(false);
    expect(states[0].backfillingPresent).toBe(false);
    // 不在 = 偽。検索可否は判定できる（要件 5.15）
    expect(states[0].searchable).toBe(true);
  });

  it('キーが存在すれば backfillingPresent が true になり真偽をそのまま反映する', () => {
    const states = readVectorIndexStates({
      VectorIndexes: [
        { IndexName: INDEX_EN, IndexStatus: 'ACTIVE', Backfilling: true },
        { IndexName: INDEX_JA, IndexStatus: 'ACTIVE', Backfilling: false },
      ],
    });

    // 出力はインデックス名の昇順
    expect(states.map((state) => state.indexName)).toEqual([INDEX_EN, INDEX_JA]);
    expect(states[0]).toMatchObject({ backfilling: true, backfillingPresent: true, searchable: false });
    expect(states[1]).toMatchObject({ backfilling: false, backfillingPresent: true, searchable: true });
  });
});

describe('waitForIndexReadiness（バックフィル経過時間の測定可否）', () => {
  it('Backfilling が不在なら検索可能と判定しつつ経過時間を測定不能として残す', async () => {
    const source = pollingSource([[indexState({ indexName: INDEX_JA, indexStatus: 'ACTIVE' })]]);

    const result = await waitForIndexReadiness({
      source: source.dynamo,
      tableName: VECTOR_TABLE,
      indexNames: [INDEX_JA],
      clock: source.clock,
    });

    const record = result.records[0];
    expect(result.allSearchable).toBe(true);
    expect(result.timedOut).toBe(false);

    // 検索可否は確定する（不在 = 偽）
    expect(record.searchable).toBe(true);
    expect(record.activeReachedAt).not.toBeNull();

    // **経過時間は 0 秒でも即時完了でもなく「測定不能」として残る（要件 5.17）**
    expect(record.backfillingFieldPresent).toBe(false);
    expect(record.backfillMeasurable).toBe(false);
    expect(record.backfillUnmeasurableReason).toBe(BACKFILL_UNMEASURABLE_REASON);
    expect(record.backfillCompletedAt).toBeNull();
    expect(record.backfillElapsedSeconds).toBeNull();
    expect(record.activeToBackfillSeconds).toBeNull();
    expect(record.backfillElapsedSeconds).not.toBe(0);
  });

  it('Backfilling を観測できた場合は true → false の経過秒を記録する', async () => {
    const source = pollingSource([
      [indexState({ indexName: INDEX_JA, indexStatus: 'CREATING', backfilling: true })],
      [indexState({ indexName: INDEX_JA, indexStatus: 'ACTIVE', backfilling: true })],
      [indexState({ indexName: INDEX_JA, indexStatus: 'ACTIVE', backfilling: false })],
    ]);

    const result = await waitForIndexReadiness({
      source: source.dynamo,
      tableName: VECTOR_TABLE,
      indexNames: [INDEX_JA],
      pollIntervalSeconds: 60,
      clock: source.clock,
    });

    const record = result.records[0];
    expect(source.calls()).toBe(3);
    expect(record.backfillingFieldPresent).toBe(true);
    expect(record.backfillMeasurable).toBe(true);
    expect(record.backfillUnmeasurableReason).toBeNull();
    // 1 回目 0 秒 / 2 回目 60 秒（ACTIVE 到達）/ 3 回目 120 秒（バックフィル完了）
    expect(record.activeElapsedSeconds).toBe(60);
    expect(record.backfillElapsedSeconds).toBe(120);
    expect(record.activeToBackfillSeconds).toBe(60);
    expect(record.searchable).toBe(true);
  });

  it('2 本のうち一方だけキーが不在なら測定可否がインデックスごとに分かれる', async () => {
    const source = pollingSource([
      [
        indexState({ indexName: INDEX_JA, indexStatus: 'ACTIVE' }),
        indexState({ indexName: INDEX_EN, indexStatus: 'ACTIVE', backfilling: false }),
      ],
    ]);

    const result = await waitForIndexReadiness({
      source: source.dynamo,
      tableName: VECTOR_TABLE,
      indexNames: [INDEX_JA, INDEX_EN],
      clock: source.clock,
    });

    expect(result.records[0]).toMatchObject({
      indexName: INDEX_JA,
      searchable: true,
      backfillMeasurable: false,
      backfillElapsedSeconds: null,
    });
    expect(result.records[1]).toMatchObject({
      indexName: INDEX_EN,
      searchable: true,
      backfillMeasurable: true,
      backfillElapsedSeconds: 0,
    });
  });
});

describe('runWaitIndex / formatReportSummary（不在を出力に含める）', () => {
  it('キー不在のインデックスは注記と警告に理由を出し、要約に測定不能と書く', async () => {
    const source = pollingSource([
      [
        indexState({ indexName: INDEX_JA, indexStatus: 'ACTIVE' }),
        indexState({ indexName: INDEX_EN, indexStatus: 'ACTIVE' }),
      ],
    ]);

    const report = await runWaitIndex({
      dynamo: source.dynamo,
      clock: source.clock,
      region: RESOLVED_REGION,
      tableName: VECTOR_TABLE,
      indexNames: [INDEX_JA, INDEX_EN],
    });

    // 実測どおり 2 本とも測定不能である
    expect(report.wait.allSearchable).toBe(true);
    expect(report.notes.some((note) => note.includes(BACKFILL_UNMEASURABLE_REASON))).toBe(true);
    expect(report.warnings.some((warning) => warning.includes(BACKFILL_UNMEASURABLE_REASON))).toBe(true);
    expect(report.warnings.some((warning) => warning.includes(INDEX_JA))).toBe(true);

    const summary = formatReportSummary(report).join('\n');
    expect(summary).toContain('Backfilling: (フィールド不在)');
    expect(summary).toContain('バックフィル完了までの経過時間: 測定不能');
    expect(summary).toContain(BACKFILL_UNMEASURABLE_REASON);
    // 観測していない完了時刻や 0 秒を書かない
    expect(summary).not.toContain('バックフィル完了: ');
    // 「不在 = 偽」を偽として書き出さない
    expect(summary).not.toContain('Backfilling: false');
  });

  it('キーを観測できた場合は従来どおり完了時刻を出し、測定不能の注記を出さない', async () => {
    const source = pollingSource([
      [indexState({ indexName: INDEX_JA, indexStatus: 'ACTIVE', backfilling: false })],
    ]);

    const report = await runWaitIndex({
      dynamo: source.dynamo,
      clock: source.clock,
      region: RESOLVED_REGION,
      tableName: VECTOR_TABLE,
      indexNames: [INDEX_JA],
    });

    expect(report.warnings).toEqual([]);
    expect(report.notes.some((note) => note.includes(BACKFILL_UNMEASURABLE_REASON))).toBe(false);

    const summary = formatReportSummary(report).join('\n');
    expect(summary).toContain('Backfilling: false');
    expect(summary).toContain('バックフィル完了: ');
    expect(summary).not.toContain('測定不能');
  });
});
