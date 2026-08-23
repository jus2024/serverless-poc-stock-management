/**
 * Index_Provisioner — isComplete ハンドラ（CDK カスタムリソース）
 *
 * `DescribeTable` の `VectorIndexDescription` を読み、対象インデックスの
 * `IndexStatus === 'ACTIVE'` を完了条件とする（要件 5.13）。
 * ポーリング間隔 60 秒 / 待機上限 2 時間は `amplify/custom/vector-index.ts` の
 * `Provider`（`queryInterval` / `totalTimeout`）で設定する。
 *
 * **バックフィル完了（`Backfilling === false`）は完了条件に含めない。**
 * 理由は 2 つある。
 * 1. `Provider.totalTimeout` の上限は 2 時間であり、要件 5.14 の 180 分を表現できない
 * 2. CloudFormation をベクトルのバックフィルに待たせるのは運用上望ましくない
 *
 * バックフィル完了は運用スクリプト（`scripts/vector-search/measure.ts --wait-index`）と
 * DynamoDB_Vector_Lambda の実行時ガードの 2 経路で扱う（要件 5.14 / 5.15）。
 *
 * ## フレームワークの契約: 未完了の応答に `Data` を載せられない
 *
 * `aws-cdk-lib/custom-resources` の `Provider` が内部で使う framework ハンドラは、
 * `IsComplete` が false の応答に非空の `Data` が含まれていると（`Object.keys(Data).length > 0`
 * を見ている）その場で例外にする。Stage B のデプロイはこれで CREATE_FAILED になった。
 *
 *   Received response status [FAILED] from custom resource.
 *   Message returned: Error: "Data" is not allowed if "IsComplete" is "False"
 *
 * この制約はローカルの型では表現されていなかった（`Data` を optional にしただけの
 * `interface` は、未完了時に `Data` を載せる誤りを許してしまう）。そのため検出が
 * デプロイまで遅れた。現在は `IsCompleteResponse` を判別可能なユニオンにして、
 * 「未完了時は `Data` を持たない」をコンパイラが確かめる形にしてある。
 *
 * したがって観測値（`IndexStatus` / `Backfilling` など）は、**待機中は `Data` ではなく
 * `console.log` の構造化ログにのみ出す**。CloudWatch Logs でポーリングの経過を追える
 * ようにするのが元の意図であり、その意図はログ経路で保つ。完了時は従来どおり
 * `Data` に載せて CFN の `Fn::GetAtt` から参照できるようにする。
 *
 * 要件: 5.13
 * 設計: Index_Provisioner（Custom Resource）
 */

import {
  lookupVectorIndex,
  parseResourceProperties,
  type OnEventRequest,
} from './on-event';

/** isComplete ハンドラが受け取るイベント。onEvent の戻り値がマージされて届く */
export interface IsCompleteRequest extends OnEventRequest {
  readonly Data?: Record<string, unknown>;
}

/**
 * isComplete ハンドラの戻り値。
 *
 * 判別可能なユニオンで「`IsComplete: false` の応答は `Data` を持てない」という
 * フレームワークの契約を型として表す（上の docstring を参照）。未完了の枝で
 * `Data` を付けるとコンパイルエラーになる。
 */
export type IsCompleteResponse =
  | { readonly IsComplete: false }
  | { readonly IsComplete: true; readonly Data: Record<string, string | number | boolean> };

/** インデックスが利用可能とみなす状態（V5: `BACKFILLING` というステータス値は存在しない） */
const ACTIVE_INDEX_STATUS = 'ACTIVE';

export const handler = async (event: IsCompleteRequest): Promise<IsCompleteResponse> => {
  const props = parseResourceProperties(event.ResourceProperties);
  const lookup = await lookupVectorIndex(props.tableName, props.indexName);

  if (event.RequestType === 'Delete') {
    // テーブルごと消えている場合も削除完了として扱う（要件 5.11）
    const removed = !lookup.tableFound || lookup.index === undefined;
    const indexStatus = lookup.index?.IndexStatus ?? 'DELETED';

    if (!removed) {
      // 未完了。観測値はログにのみ出す
      console.log(
        JSON.stringify({
          event: 'vector-index-delete-pending',
          TableName: props.tableName,
          IndexName: props.indexName,
          IndexStatus: indexStatus,
        })
      );
      return { IsComplete: false };
    }

    return {
      IsComplete: true,
      Data: {
        TableName: props.tableName,
        IndexName: props.indexName,
        IndexStatus: indexStatus,
      },
    };
  }

  if (!lookup.tableFound) {
    // Create / Update の待機中にテーブルが無いのは復帰不能。待たずに失敗させる
    throw new Error(
      `Table ${props.tableName} was not found while waiting for vector index ${props.indexName} ` +
        'to become ACTIVE.'
    );
  }

  const indexStatus = lookup.index?.IndexStatus ?? 'UNKNOWN';
  // バックフィル中でも IndexStatus が ACTIVE なら完了とする（要件 5.13）。
  // Backfilling は完了条件ではなく観測値である（V5 / 要件 5.14）
  const backfilling = lookup.index?.Backfilling === true;

  if (indexStatus !== ACTIVE_INDEX_STATUS) {
    // 未完了。観測値はログにのみ出す（`Data` を載せると framework ハンドラが失敗する）
    console.log(
      JSON.stringify({
        event: 'vector-index-create-pending',
        TableName: props.tableName,
        IndexName: props.indexName,
        IndexStatus: indexStatus,
        Backfilling: backfilling,
      })
    );
    return { IsComplete: false };
  }

  return {
    IsComplete: true,
    Data: {
      TableName: props.tableName,
      IndexName: props.indexName,
      IndexStatus: indexStatus,
      Backfilling: backfilling,
    },
  };
};
