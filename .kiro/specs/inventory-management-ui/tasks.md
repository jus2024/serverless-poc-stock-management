# Implementation Plan: inventory-management-ui

## Overview

「在庫管理検証システム」を「在庫管理システム」にリブランドし、ヘッダーに TableToggle（Good/Bad 切替）を配置する。Tab 1 は InventoryListView（一覧表示・個別照会・出庫処理）で、全操作が TableToggle の値を使用する。Tab 2 は LoadTestPanel のみ（InventoryQueryPanel は含めない）。バックエンドでは inventory-query Lambda に一覧取得ロジックを追加し、API Gateway に `GET /inventory/{warehouseId}` エンドポイントを追加する。

## Tasks

- [x] 1. バックエンド: Lambda ハンドラーに在庫一覧取得ロジックを追加
  - [x] 1.1 inventory-query Lambda に handleListInventory 関数を実装する
    - `amplify/functions/inventory-query/handler.ts` を変更
    - `QueryCommand` を import に追加
    - handler 内で `itemId` パスパラメータが無い場合に `handleListInventory` を呼び出すルーティング分岐を追加
    - `handleListInventory(warehouseId, table, nextToken)` 関数を新規作成
    - table="good" → Good_Table の GSI `byWarehouse` に対して KeyConditionExpression `warehouseId = :wh` で Query 実行
    - table="bad" → Bad_Table に対して PK (warehouseId) で Query 実行
    - 全 Query で `Limit=50` を設定
    - `nextToken` クエリパラメータのデコード（base64url → JSON → ExclusiveStartKey）
    - `LastEvaluatedKey` のエンコード（JSON → base64url → nextToken）
    - 不正な nextToken に対して 400 / INVALID_TOKEN エラーを返す
    - ProvisionedThroughputExceededException を catch して 500 / THROTTLED を返す
    - レスポンス形式: `{ items, nextToken }`
    - _Requirements: 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 10.2_

  - [ ]* 1.2 handleListInventory のプロパティテストを作成する
    - **Property 6: Lambda table routing correctness** — table="good" で GSI byWarehouse、table="bad" で Bad_Table PK=warehouseId が使われることを検証
    - **Property 7: NextToken encoding round-trip** — base64url エンコード→デコードが一致することを検証
    - **Property 8: Query limit invariant** — Limit が常に 50 であることを検証
    - **Property 9: List response structure** — レスポンスが `{ items, nextToken }` 形式であることを検証
    - **Property 10: Invalid token rejection** — 不正文字列で 400 / INVALID_TOKEN が返ることを検証
    - **Property 12: Throttle error format** — ProvisionedThroughputExceededException で 500 / THROTTLED が返ることを検証
    - **Validates: Requirements 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 10.2**

- [x] 2. バックエンド: API Gateway に GET /inventory/{warehouseId} エンドポイントを追加
  - [x] 2.1 api-gateway.ts に warehouseId リソースへの GET メソッドを追加する
    - `amplify/custom/api-gateway.ts` を変更
    - 既存の `warehouseId` リソースに `GET` メソッドを追加
    - `warehouseId.addMethod('GET', queryIntegration)` を追加
    - 既存の `{warehouseId}/{itemId}` GET エンドポイントと共存することを確認
    - _Requirements: 8.1_

- [x] 3. フロントエンド: API クライアントと型定義を拡張
  - [x] 3.1 types.ts に ListInventoryResponse 型を追加する
    - `src/lib/inventory/types.ts` を変更
    - `ListInventoryResponse` インターフェースを追加（items: InventoryRecord[], nextToken: string | null）
    - _Requirements: 9.3_

  - [x] 3.2 api.ts に listInventory 関数を追加する
    - `src/lib/inventory/api.ts` を変更
    - `ListInventoryResponse` を types.ts から import
    - `listInventory(warehouseId: string, table: Table, nextToken?: string)` 関数を export
    - GET /inventory/{warehouseId} に対してリクエストを送信
    - `table` を必ずクエリパラメータとして付与
    - `nextToken` がある場合のみクエリパラメータとして付与
    - 非 2xx レスポンスで `handleErrorResponse` を呼び出す
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [ ]* 3.3 listInventory 関数のプロパティテストを作成する
    - **Property 11: API client URL construction** — warehouseId, table, nextToken に基づく URL 構築が正しいことを検証
    - table パラメータが常にクエリに含まれることを検証
    - nextToken 省略時にクエリに含まれないことを検証
    - エラーレスポンス時に ErrorResponse が throw されることを検証
    - **Validates: Requirements 9.2, 9.4**

- [x] 4. Checkpoint - バックエンドと API クライアントの検証
  - Ensure all tests pass, ask the user if questions arise.
  - lint (`next lint`) と型チェック (`tsc --noEmit`) が通ることを確認

- [x] 5. フロントエンド: TableToggle コンポーネントを新規作成
  - [x] 5.1 TableToggle コンポーネントを実装する
    - `src/components/inventory/TableToggle.tsx` を新規作成
    - Props: `{ value: Table; onChange: (table: Table) => void }`
    - セグメントコントロール形式で "Good" | "Bad" を表示
    - デフォルト選択: "Good"
    - "Bad" 選択時: 赤系背景色（`#dc2626` 系）でインジケータ表示
    - コンパクトでヘッダーに収まるサイズ
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 5.2 TableToggle.module.css を作成する
    - `src/components/inventory/TableToggle.module.css` を新規作成
    - セグメントコントロールのスタイル、Bad 選択時の赤インジケータを定義
    - 既存の InventoryDashboard.module.css のデザインパターンに合わせる
    - _Requirements: 3.4, 3.5_

- [x] 6. フロントエンド: InventoryTable コンポーネントを新規作成
  - [x] 6.1 InventoryTable コンポーネントを実装する
    - `src/components/inventory/InventoryTable.tsx` を新規作成
    - Props: `{ items: InventoryRecord[]; nextToken: string | null; onLoadMore: () => void; loading: boolean }`
    - テーブルに 7 カラムを表示（itemId, itemName, quantity, lotNumber, location, unitPrice, lastUpdated）
    - unitPrice は ¥ フォーマットで表示
    - nextToken が存在する場合のみ「次のページ」ボタンを表示
    - nextToken が null の場合「次のページ」ボタンを非表示
    - loading 中はボタンを disabled に
    - _Requirements: 4.3, 4.4, 5.1, 5.3_

  - [x] 6.2 InventoryTable.module.css を作成する
    - `src/components/inventory/InventoryTable.module.css` を新規作成
    - テーブルスタイル、ページネーションボタンのスタイルを定義
    - 既存の InventoryDashboard.module.css のデザインパターンに合わせる
    - _Requirements: 4.3_

  - [ ]* 6.3 InventoryTable の表示プロパティテストを作成する
    - **Property 2: Inventory record display completeness** — 7 カラムが全て表示されることを検証
    - **Property 3: Page size invariant** — 表示件数が最大 50 であることを検証
    - **Property 4: NextToken and pagination button biconditional** — nextToken の有無とボタン表示の一致を検証
    - **Validates: Requirements 4.3, 4.4, 5.1, 5.3**

- [x] 7. フロントエンド: InventoryListView コンポーネントを新規作成
  - [x] 7.1 InventoryListView コンポーネントを実装する
    - `src/components/inventory/InventoryListView.tsx` を新規作成
    - Props: `{ table: Table }` — Dashboard から渡される現在のテーブル種別
    - 倉庫セレクター（WH-TOKYO, WH-OSAKA, WH-FUKUOKA）+ 検索ボタン
    - InventoryTable を使った一覧表示: `listInventory(warehouseId, table, nextToken)` を呼び出し
    - 「次のページ」ボタンクリックで前回レスポンスの nextToken を渡してページネーション
    - 個別照会セクション: itemId 入力 + 照会ボタン → `queryInventory(warehouseId, itemId, table)` を呼び出し
    - 出庫処理セクション: warehouseId セレクター + itemId 入力 + quantity 入力 + 送信ボタン → `shipInventory(warehouseId, itemId, quantity, table)` を呼び出し
    - `table` prop が変更されたら items をクリアし nextToken をリセットして再取得
    - 各セクションのエラー表示（THROTTLED, NOT_FOUND, その他エラー）
    - 全ての API 呼び出しで `table` prop の現在値を使用する
    - _Requirements: 3.6, 3.7, 4.1, 4.2, 5.2, 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.3, 7.4, 10.1, 10.3_

  - [x] 7.2 InventoryListView.module.css を作成する
    - `src/components/inventory/InventoryListView.module.css` を新規作成
    - セクション区切り、フォームレイアウト、エラー表示のスタイルを定義
    - 既存の InventoryQueryPanel.module.css のデザインパターンを参考にする
    - _Requirements: 4.1, 6.1, 7.1_

  - [ ]* 7.3 InventoryListView のプロパティテストを作成する
    - **Property 1: Toggle state propagation to all API operations** — listInventory, queryInventory, shipInventory 全てが `table` prop の値を使用することを検証
    - **Property 5: Pagination token passthrough** — 「次のページ」クリック時に直前レスポンスの nextToken が送信されることを検証
    - **Property 13: Error message display** — API エラーメッセージがユーザーに表示されることを検証
    - **Property 14: Toggle reset behavior** — table prop 変更時に items と nextToken がクリアされることを検証
    - **Validates: Requirements 3.6, 3.7, 4.2, 5.2, 7.2, 7.4, 10.3**

- [x] 8. フロントエンド: InventoryDashboard を変更（ヘッダー・タブ・トグル統合）
  - [x] 8.1 InventoryDashboard.tsx のヘッダー・タブ・状態管理を更新する
    - `src/components/inventory/InventoryDashboard.tsx` を変更
    - ヘッダータイトルを `"在庫管理検証システム"` → `"在庫管理システム"` に変更
    - `table` state を追加: `const [table, setTable] = useState<Table>("good")`
    - ヘッダー右端に `<TableToggle value={table} onChange={setTable} />` を配置
    - ヘッダーの CSS flexbox を調整（タイトル左寄せ、トグル右寄せ）
    - タブラベルを変更: `"在庫照会"` → `"在庫管理"` / `"負荷テスト"` / `"結果ダッシュボード"`
    - Tab 型を `"inventory" | "loadtest" | "results"` に変更
    - Tab 1 のレンダリング: `<InventoryListView table={table} />`
    - Tab 2 のレンダリング: `<LoadTestPanel />` のみ（InventoryQueryPanel を含めない）
    - Tab 3 のレンダリング: 既存の結果ダッシュボード
    - TableToggle と InventoryListView を import
    - _Requirements: 1.1, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3_

  - [x] 8.2 InventoryDashboard.module.css のヘッダーレイアウトを調整する
    - `src/components/inventory/InventoryDashboard.module.css` を変更
    - ヘッダーを `display: flex; align-items: center; justify-content: space-between` に調整
    - TableToggle がヘッダー右端に配置されるようスタイルを追加
    - _Requirements: 3.1, 3.5_

- [x] 9. Final checkpoint - 全体検証
  - Ensure all tests pass, ask the user if questions arise.
  - `next lint` と `tsc --noEmit` が通ることを確認
  - Amplify sandbox への影響: API Gateway に GET メソッド追加、Lambda ハンドラーに新ルーティング追加

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties defined in the design document
- 既存コードの変更箇所（Lambda handler, API Gateway, InventoryDashboard）は差分を最小化する方針
- Tab 2 は LoadTestPanel のみ。InventoryQueryPanel は Tab 2 に含めない
- TableToggle は Dashboard が所有する state であり、InventoryListView に prop として渡す
- listInventory API クライアント関数は `table` パラメータを必ず受け取る
- Amplify sandbox デプロイ後に API Gateway と Lambda の変更が反映されることを検証する

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1"] },
    { "id": 1, "tasks": ["1.2", "3.2"] },
    { "id": 2, "tasks": ["3.3", "5.1", "5.2"] },
    { "id": 3, "tasks": ["6.1", "6.2"] },
    { "id": 4, "tasks": ["6.3", "7.1", "7.2"] },
    { "id": 5, "tasks": ["7.3", "8.1", "8.2"] }
  ]
}
```
