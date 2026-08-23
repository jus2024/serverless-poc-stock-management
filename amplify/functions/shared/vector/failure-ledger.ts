/**
 * 失敗一覧の保持枠を種類間で公平に配分する台帳（純粋なデータ構造、共有モジュール）
 *
 * 失敗**件数**は上限なく数える。一覧の方は自己再帰 invoke のペイロード上限（256 KB）と
 * 進捗レコードのアイテム上限（400 KB）に収める必要があるため上限件数を持つ。
 * 本モジュールが解くのは「上限に達したときにどれを残すか」だけである。
 *
 * ## 直そうとしている欠陥
 *
 * タスク 13.11 の実測では、保持された 100 件が**すべて同一の種類**
 * （`stage: VERIFICATION` / `errorCode: ACCESS_DENIED_IAM`）だった。同時に発生していた
 * 3 件の日本語側 Bedrock 生成失敗は、その itemId とエラー内容ごと一覧から消えていた。
 * 到着順に詰めて満杯で打ち切る方式は、**大量に出る 1 種類が枠を食い潰し、
 * 少数しか出ない種類（＝たいてい対処が必要な方）を押し出す**。
 * 要件 3.10 は失敗した itemId の報告を求めているため、これは記録の欠落である。
 *
 * ## 採用した方式: 種類間の max-min 公平配分
 *
 * 失敗を `(stage, errorCode)` の組で**種類**に分け、種類ごとのバケットへ入れる。
 *
 * 1. 合計が上限未満なら、そのまま受け入れる
 * 2. 上限に達している場合、**最も件数の多い種類**を探す。その件数が
 *    「今から入れる種類の件数 + 1」より大きければ、その種類の**末尾 1 件を捨てて**
 *    新しい 1 件を受け入れる
 * 3. そうでなければ受け入れず、打ち切りが起きたことだけを記録する
 *
 * `+ 1` の余裕は振動（互いに奪い合って入れ替わり続ける状態）を防ぐためのものであり、
 * これにより件数の分布は「最大 - 最小 ≤ 1」へ向かって均される。
 *
 * ## なぜこれで多様性が保たれるか
 *
 * - **少数派は必ず残る。** ある種類の発生件数が `上限 ÷ 種類数` 以下であれば、その種類の
 *   全件が残る。奪う側の条件が「自分より 2 件以上多い種類から奪う」なので、件数の少ない
 *   種類は常に奪う側になれる。上の実測例（`VERIFICATION` 9,994 件 + `GENERATION` 3 件）では、
 *   到着順がどちらであっても `GENERATION` の 3 件が残る。9,994 件が先に枠を埋めていても、
 *   後から来た 3 件が最大バケットから 1 件ずつ奪って入る
 * - **多数派は枠を独占できない。** 上限に達した後、最大バケットは奪われる側にしかならない
 *   （自分自身は「自分より 2 件以上多い」を満たさないため、2 の条件が偽になり受け入れられない）
 * - **枠を余らせない。** 種類が 1 つしかない場合は 2 の条件が常に偽になり、上限まで詰めた
 *   状態が保たれる。種類ごとの固定上限を置く方式だと、1 種類しか出ないときに枠が余る
 * - **早い例を優先して残す。** 捨てるのは victim バケットの**末尾**である。ある種類の
 *   最初の数件は原因の切り分けに最も役立つため、同じ種類の中では古い方を残す
 *
 * ## 保証の範囲
 *
 * 種類数が上限件数を超えた場合（例: 上限 100 に対して 120 種類）は、全種類に 1 件ずつを
 * 割り当てられない。この場合でも到着順に依存した偏りは起きず、件数の多い種類から
 * 順に削られる。`stage` は 5 種、`errorCode` は `errors.ts` の分類コードであるため、
 * 実際の種類数は上限を大きく下回る。
 *
 * 要件: 3.8, 3.10, 4.3, 4.6, 4.7
 * 設計: Embedding_Batch_Job / 出力
 */

/** 種類を決める 2 フィールド。これ以外のフィールドは配分に関与しない */
export interface FailureKindFields {
  readonly stage: string;
  readonly errorCode: string;
}

/** 種類の識別子。`stage` と `errorCode` の組（表示・テスト用に公開する） */
export function failureKindOf(failure: FailureKindFields): string {
  return `${failure?.stage ?? ''}/${failure?.errorCode ?? ''}`;
}

/**
 * 種類間で保持枠を公平に配分する失敗台帳。
 *
 * 件数の集計は行わない（呼び出し側が言語別の `failedCount` として数える）。
 * 本クラスの責務は「どの失敗を一覧に残すか」だけである。
 */
export class DiverseFailureLedger<T extends FailureKindFields> {
  /** 種類 → 保持している失敗。挿入順を保つ（出力順の決定にも使う） */
  private readonly buckets = new Map<string, T[]>();

  /** 保持件数の合計。`buckets` の各配列長の和と常に等しい */
  private retained = 0;

  /** 一覧から漏れた失敗が 1 件以上あるか（受け入れ拒否と追い出しの両方を含む） */
  private truncated = false;

  /** 一覧に保持する上限件数。1 未満を渡した場合は 0 件として扱う */
  readonly capacity: number;

  /**
   * @param capacity 一覧に保持する上限件数
   * @param initial 復元する既存の一覧（自己再帰 invoke のカーソル経由で届いた値）
   * @param initialTruncated 復元元がすでに打ち切られていたか
   */
  constructor(capacity: number, initial: readonly T[] = [], initialTruncated = false) {
    this.capacity = Number.isFinite(capacity) && capacity > 0 ? Math.trunc(capacity) : 0;
    this.truncated = initialTruncated === true;
    // 復元は「種類でまとめ直す」だけである。`toArray()` の出力は種類ごとに連続しているため、
    // 出力 → 復元 → 出力 でバケットの構成と順序が変わらない（往復で安定する）
    for (const failure of initial ?? []) this.add(failure);
  }

  /** 保持件数 */
  get size(): number {
    return this.retained;
  }

  /** 一覧が上限で打ち切られたか。件数そのものは呼び出し側の `failedCount` が保持する */
  get isTruncated(): boolean {
    return this.truncated;
  }

  /** 保持している種類の識別子（挿入順） */
  kinds(): string[] {
    return Array.from(this.buckets.keys());
  }

  /**
   * 失敗を 1 件記録する。
   *
   * 上限に達している場合は「最も件数の多い種類から 1 件奪う」判定を行う（上の 2）。
   * 奪えない場合は保持せず、{@link isTruncated} を立てる。
   */
  add(failure: T): void {
    if (this.capacity === 0) {
      this.truncated = true;
      return;
    }

    const kind = failureKindOf(failure);
    const bucket = this.buckets.get(kind) ?? [];
    if (!this.buckets.has(kind)) this.buckets.set(kind, bucket);

    if (this.retained < this.capacity) {
      bucket.push(failure);
      this.retained++;
      return;
    }

    // 上限に達している。自分より 2 件以上多い種類があれば、その末尾 1 件と入れ替える
    const victim = this.findVictim(bucket.length);
    if (victim === undefined) {
      this.truncated = true;
      return;
    }

    victim.pop();
    bucket.push(failure);
    // 追い出した 1 件は一覧から失われるため、打ち切りが起きたことを明示する
    this.truncated = true;
  }

  /**
   * 保持している失敗を返す。**種類ごとに連続した**並びであり、種類の順序は初出順、
   * 種類内の順序は到着順である。
   */
  toArray(): T[] {
    const flattened: T[] = [];
    this.buckets.forEach((bucket) => {
      for (const failure of bucket) flattened.push(failure);
    });
    return flattened;
  }

  /**
   * 追い出し元のバケットを探す。
   *
   * 条件は「件数が `own + 1` より多い」。等号を許すと 1 件差の 2 種類が互いに奪い合って
   * 際限なく入れ替わるため、2 件以上の差を要求する。最大件数の種類が複数ある場合は
   * 初出順で最初のものを選ぶ（結果が到着順以外の要因で揺れないようにする）。
   */
  private findVictim(ownCount: number): T[] | undefined {
    let victim: T[] | undefined;
    let victimCount = ownCount + 1;

    this.buckets.forEach((bucket) => {
      if (bucket.length > victimCount) {
        victim = bucket;
        victimCount = bucket.length;
      }
    });

    return victim;
  }
}
