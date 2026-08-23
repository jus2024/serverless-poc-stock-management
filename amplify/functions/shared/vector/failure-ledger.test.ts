/**
 * `failure-ledger.ts` の単体テストと property テスト（task 17.2）
 *
 * 直そうとしている欠陥はタスク 13.11 の実測値である。失敗一覧に保持された 100 件が
 * すべて `VERIFICATION` / `ACCESS_DENIED_IAM` になり、同時に起きていた 3 件の
 * `GENERATION` 失敗の itemId が一覧から消えていた。したがってこのテストの中心は
 * **「大量に出る 1 種類が少数派の種類を押し出さない」**ことの固定である。
 *
 * AWS を呼ばない純粋なデータ構造であるため、モックは不要である。
 *
 * 要件: 3.8, 3.10, 4.3, 4.6, 4.7
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { DiverseFailureLedger, failureKindOf } from './failure-ledger';

// ============================================================
// テスト用の失敗レコード
// ============================================================

interface TestFailure {
  readonly stage: string;
  readonly errorCode: string;
  readonly itemId: string;
}

function failure(stage: string, errorCode: string, itemId: string): TestFailure {
  return { stage, errorCode, itemId };
}

/** 台帳へ n 件流し込む。itemId は連番で区別する */
function flood(
  ledger: DiverseFailureLedger<TestFailure>,
  stage: string,
  errorCode: string,
  count: number,
  prefix = ''
): void {
  for (let index = 0; index < count; index++) {
    ledger.add(failure(stage, errorCode, `${prefix}${stage}-${errorCode}-${index}`));
  }
}

/** 種類ごとの保持件数 */
function countsByKind(ledger: DiverseFailureLedger<TestFailure>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of ledger.toArray()) {
    const kind = failureKindOf(entry);
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

// ============================================================
// 上限と打ち切りの基本
// ============================================================

describe('保持件数の上限と打ち切りフラグ', () => {
  it('上限未満なら全件を到着順に保持し、打ち切りは立たない', () => {
    const ledger = new DiverseFailureLedger<TestFailure>(10);
    flood(ledger, 'GENERATION', 'THROTTLED', 4);

    expect(ledger.size).toBe(4);
    expect(ledger.isTruncated).toBe(false);
    expect(ledger.toArray().map((entry) => entry.itemId)).toEqual([
      'GENERATION-THROTTLED-0',
      'GENERATION-THROTTLED-1',
      'GENERATION-THROTTLED-2',
      'GENERATION-THROTTLED-3',
    ]);
  });

  it('種類が 1 つしかない場合でも枠を余らせず、上限まで詰めて打ち切る', () => {
    const ledger = new DiverseFailureLedger<TestFailure>(10);
    flood(ledger, 'VERIFICATION', 'ACCESS_DENIED_IAM', 50);

    // 種類ごとの固定上限を置く方式だと枠が余る。max-min 配分は 1 種類のとき上限まで使う
    expect(ledger.size).toBe(10);
    expect(ledger.isTruncated).toBe(true);
    // 同じ種類の中では古い方を残す（最初の数件が原因の切り分けに最も役立つ）
    expect(ledger.toArray()[0].itemId).toBe('VERIFICATION-ACCESS_DENIED_IAM-0');
    expect(ledger.toArray()[9].itemId).toBe('VERIFICATION-ACCESS_DENIED_IAM-9');
  });

  it('上限 0 は 1 件も保持せず打ち切りを立てる', () => {
    const ledger = new DiverseFailureLedger<TestFailure>(0);
    ledger.add(failure('GENERATION', 'THROTTLED', 'x'));

    expect(ledger.size).toBe(0);
    expect(ledger.toArray()).toEqual([]);
    expect(ledger.isTruncated).toBe(true);
  });
});

// ============================================================
// 実測された欠陥の回帰テスト
// ============================================================

describe('単一種類による枠の占有を防ぐ（タスク 13.11 の回帰）', () => {
  // 実測値の再現。VERIFICATION/ACCESS_DENIED_IAM が 9,994 件、GENERATION の失敗が 3 件。
  // 旧方式（到着順に詰めて満杯で打ち切る）では GENERATION の 3 件が一覧から消えていた
  const FLOOD_COUNT = 9_994;
  const CAPACITY = 100;

  it('大量の失敗が先に枠を埋めても、後から来た少数派の全件が一覧に残る', () => {
    const ledger = new DiverseFailureLedger<TestFailure>(CAPACITY);

    flood(ledger, 'VERIFICATION', 'ACCESS_DENIED_IAM', FLOOD_COUNT);
    ledger.add(failure('GENERATION', 'VALIDATION_ERROR', 'ITEM#ETH-SKU0001-RAW'));
    ledger.add(failure('GENERATION', 'VALIDATION_ERROR', 'ITEM#BRA-SKU0002-RAW'));
    ledger.add(failure('GENERATION', 'VALIDATION_ERROR', 'ITEM#COL-SKU0003-RAW'));

    const retained = ledger.toArray();
    const generationItemIds = retained
      .filter((entry) => entry.stage === 'GENERATION')
      .map((entry) => entry.itemId);

    // 対処が必要な 3 件の itemId が失われない（要件 3.10）
    expect(generationItemIds).toEqual([
      'ITEM#ETH-SKU0001-RAW',
      'ITEM#BRA-SKU0002-RAW',
      'ITEM#COL-SKU0003-RAW',
    ]);
    expect(retained).toHaveLength(CAPACITY);
    expect(ledger.isTruncated).toBe(true);
  });

  it('少数派が先に来て大量の失敗が後から来ても、少数派の全件が一覧に残る', () => {
    const ledger = new DiverseFailureLedger<TestFailure>(CAPACITY);

    ledger.add(failure('GENERATION', 'VALIDATION_ERROR', 'ITEM#ETH-SKU0001-RAW'));
    ledger.add(failure('GENERATION', 'VALIDATION_ERROR', 'ITEM#BRA-SKU0002-RAW'));
    ledger.add(failure('GENERATION', 'VALIDATION_ERROR', 'ITEM#COL-SKU0003-RAW'));
    flood(ledger, 'VERIFICATION', 'ACCESS_DENIED_IAM', FLOOD_COUNT);

    expect(
      ledger.toArray().filter((entry) => entry.stage === 'GENERATION').map((entry) => entry.itemId)
    ).toEqual(['ITEM#ETH-SKU0001-RAW', 'ITEM#BRA-SKU0002-RAW', 'ITEM#COL-SKU0003-RAW']);
    expect(ledger.size).toBe(CAPACITY);
  });

  it('同じ stage でも errorCode が違えば別の種類として枠が確保される', () => {
    const ledger = new DiverseFailureLedger<TestFailure>(CAPACITY);

    // 再試行対象外のエラー（要件 4.7）が再試行対象のエラーに押し出されないこと
    flood(ledger, 'GENERATION', 'THROTTLED', FLOOD_COUNT);
    ledger.add(failure('GENERATION', 'VALIDATION_ERROR', 'ITEM#ETH-SKU0001-RAW'));
    ledger.add(failure('GENERATION', 'ACCESS_DENIED_IAM', 'ITEM#BRA-SKU0002-RAW'));

    const counts = countsByKind(ledger);
    expect(counts['GENERATION/VALIDATION_ERROR']).toBe(1);
    expect(counts['GENERATION/ACCESS_DENIED_IAM']).toBe(1);
    expect(ledger.size).toBe(CAPACITY);
  });

  it('多数派は上限に達した後に枠を増やせない', () => {
    const ledger = new DiverseFailureLedger<TestFailure>(CAPACITY);

    flood(ledger, 'GENERATION', 'VALIDATION_ERROR', 10);
    flood(ledger, 'VERIFICATION', 'ACCESS_DENIED_IAM', FLOOD_COUNT);

    const counts = countsByKind(ledger);
    // 多数派は上限までは詰めるが、その後は自分より 2 件以上多い種類が存在しないため増えない
    expect(counts['GENERATION/VALIDATION_ERROR']).toBe(10);
    expect(counts['VERIFICATION/ACCESS_DENIED_IAM']).toBe(CAPACITY - 10);
  });
});

// ============================================================
// カーソル往復での安定性
// ============================================================

describe('自己再帰 invoke のカーソル往復', () => {
  it('出力を復元しても構成と順序が変わらない', () => {
    const original = new DiverseFailureLedger<TestFailure>(20);
    flood(original, 'VERIFICATION', 'ACCESS_DENIED_IAM', 30);
    flood(original, 'GENERATION', 'THROTTLED', 5);
    flood(original, 'DYNAMODB_WRITE', 'THROTTLED', 2);

    const restored = new DiverseFailureLedger<TestFailure>(
      20,
      original.toArray(),
      original.isTruncated
    );

    expect(restored.toArray()).toEqual(original.toArray());
    expect(restored.kinds()).toEqual(original.kinds());
    expect(restored.size).toBe(original.size);
  });

  it('復元元が打ち切られていれば打ち切りフラグを引き継ぐ', () => {
    const restored = new DiverseFailureLedger<TestFailure>(
      100,
      [failure('GENERATION', 'THROTTLED', 'a')],
      true
    );

    expect(restored.isTruncated).toBe(true);
  });
});

// ============================================================
// property テスト
// ============================================================

describe('保持枠の配分不変条件（property）', () => {
  /** 種類の候補。`EmbedFailureStage` と `errors.ts` の分類コードを模す */
  const stageArb = fc.constantFrom(
    'GENERATION',
    'DYNAMODB_WRITE',
    'OPENSEARCH_WRITE',
    'COMPENSATION',
    'VERIFICATION'
  );
  const errorCodeArb = fc.constantFrom(
    'THROTTLED',
    'VALIDATION_ERROR',
    'ACCESS_DENIED_IAM',
    'VECTOR_MISMATCH',
    'RESOURCE_NOT_FOUND'
  );

  /** 到着列。1 種類が支配的になる列を作れるよう、種類の重複を許して長い列を引く */
  const arrivalsArb = fc.array(
    fc.tuple(stageArb, errorCodeArb).map(([stage, errorCode]) => ({ stage, errorCode })),
    { minLength: 0, maxLength: 400 }
  );

  const capacityArb = fc.integer({ min: 1, max: 60 });

  it('保持件数は上限を超えず、到着件数と上限の小さい方に等しい', () => {
    fc.assert(
      fc.property(arrivalsArb, capacityArb, (arrivals, capacity) => {
        const ledger = new DiverseFailureLedger<TestFailure>(capacity);
        arrivals.forEach((kind, index) =>
          ledger.add(failure(kind.stage, kind.errorCode, `item-${index}`))
        );

        expect(ledger.size).toBe(Math.min(arrivals.length, capacity));
        expect(ledger.toArray()).toHaveLength(ledger.size);
        expect(ledger.isTruncated).toBe(arrivals.length > capacity);
      }),
      { numRuns: 100 }
    );
  });

  it('発生件数が「上限 ÷ 種類数」以下の種類は全件が残る', () => {
    fc.assert(
      fc.property(arrivalsArb, capacityArb, (arrivals, capacity) => {
        const ledger = new DiverseFailureLedger<TestFailure>(capacity);
        const added: Record<string, number> = {};

        arrivals.forEach((kind, index) => {
          const key = failureKindOf(kind);
          added[key] = (added[key] ?? 0) + 1;
          ledger.add(failure(kind.stage, kind.errorCode, `item-${index}`));
        });

        const retained = countsByKind(ledger);
        const kindCount = Object.keys(added).length;
        if (kindCount === 0) return;

        const fairShare = Math.floor(capacity / kindCount);
        for (const [kind, addedCount] of Object.entries(added)) {
          // 公平配分の取り分に収まる種類は 1 件も落とされない
          if (addedCount <= fairShare) expect(retained[kind] ?? 0).toBe(addedCount);
          // どの種類も公平配分の取り分は最低限保持される
          expect(retained[kind] ?? 0).toBeGreaterThanOrEqual(Math.min(addedCount, fairShare));
        }
      }),
      { numRuns: 100 }
    );
  });

  it('種類数が上限以下なら、発生した全種類が一覧に 1 件以上残る', () => {
    fc.assert(
      fc.property(arrivalsArb, capacityArb, (arrivals, capacity) => {
        const ledger = new DiverseFailureLedger<TestFailure>(capacity);
        const kinds = new Set<string>();

        arrivals.forEach((kind, index) => {
          kinds.add(failureKindOf(kind));
          ledger.add(failure(kind.stage, kind.errorCode, `item-${index}`));
        });

        if (kinds.size === 0 || kinds.size > capacity) return;

        const retained = countsByKind(ledger);
        kinds.forEach((kind) => expect(retained[kind] ?? 0).toBeGreaterThanOrEqual(1));
      }),
      { numRuns: 100 }
    );
  });

  it('保持件数の偏りは種類間で 1 件以内に収まる（発生件数で足りている種類の間）', () => {
    fc.assert(
      fc.property(arrivalsArb, capacityArb, (arrivals, capacity) => {
        const ledger = new DiverseFailureLedger<TestFailure>(capacity);
        const added: Record<string, number> = {};

        arrivals.forEach((kind, index) => {
          const key = failureKindOf(kind);
          added[key] = (added[key] ?? 0) + 1;
          ledger.add(failure(kind.stage, kind.errorCode, `item-${index}`));
        });

        if (arrivals.length <= capacity) return;

        const retained = countsByKind(ledger);
        // 「発生件数が保持件数より多い」種類だけを比べる。発生件数が尽きた種類は
        // 保持件数が少なくても偏りではない
        const competing = Object.entries(retained).filter(
          ([kind, count]) => (added[kind] ?? 0) > count
        );
        if (competing.length < 2) return;

        const counts = competing.map(([, count]) => count);
        expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
      }),
      { numRuns: 100 }
    );
  });
});
