# Implementation Plan: Phase 1 — DynamoDB ホットスポット検証 在庫管理基盤

## Overview

DynamoDB のパーティションキー設計がレスポンスタイムに与える影響を実測検証するアプリケーションを Amplify Gen 2 + CDK で構築する。インフラ定義 → Lambda ハンドラー → フロントエンド UI の順に段階的に実装し、各ステップで動作確認可能な状態を維持する。

## Tasks

- [x] 1. インフラ基盤の構築（DynamoDB + Lambda + API Gateway）
  - [x] 1.1 DynamoDB テーブル CDK Construct を作成する
    - `amplify/custom/dynamodb-tables.ts` を作成
    - Bad_Table: PK=warehouseId, SK=itemId, プロビジョンド 100 RCU/100 WCU, Contributor Insights 有効
    - Good_Table: PK=itemId, SK=warehouseId, GSI `byWarehouse`(PK=warehouseId, SK=itemId, ALL射影), プロビジョンド 100 RCU/100 WCU, Contributor Insights 有効
    - Executions Table: PK=executionId, オンデマンドキャパシティ
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 1.2 Lambda 関数の CDK 定義と共通型を作成する
    - `amplify/functions/` 配下に 5 つの Lambda 関数ディレクトリを作成: `inventory-query`, `inventory-ship`, `load-test-start`, `load-test-status`, `seed`
    - 各関数の共通型定義ファイル `amplify/functions/shared/types.ts` を作成
    - Node.js 20.x ランタイム、X-Ray トレーシング有効、TypeScript バンドル設定
    - IAM ポリシーを最小権限で定義（各 Lambda が必要なテーブルのみアクセス可能）
    - _Requirements: 11.1, 11.2, 11.3, 11.5_

  - [x] 1.3 API Gateway REST API の CDK Construct を作成する
    - `amplify/custom/api-gateway.ts` を作成
    - エンドポイント定義: GET /inventory/{warehouseId}/{itemId}, POST /inventory/ship, POST /load-test/start, GET /load-test/status/{executionId}, POST /seed
    - Lambda プロキシ統合を設定
    - CORS 設定（フロントエンドからのアクセス許可）
    - API URL を Amplify outputs に登録
    - _Requirements: 11.1, 11.4_

  - [x] 1.4 `amplify/backend.ts` にカスタムリソースを統合する
    - DynamoDB テーブル Construct と API Gateway Construct を backend.ts に追加
    - Lambda 関数にテーブル名と API URL の環境変数を渡す
    - `npx ampx sandbox delete` で全リソースが削除可能であることを確認
    - _Requirements: 11.1, 11.4_

- [x] 2. Checkpoint - インフラ定義の確認
  - Ensure all tests pass, ask the user if questions arise.
  - `npx ampx sandbox` でリソースがデプロイ可能か確認する指示を含める

- [x] 3. Seed スクリプトの実装
  - [x] 3.1 SKU 生成ロジックを実装する
    - `amplify/functions/seed/sku-generator.ts` を作成
    - Kiro Roasters 命名規則に従う SKU 生成: green beans (~32), roasted beans (~960), blends (~1,500), drip bags (~500), materials (~2,008) = 合計 5,000 SKU
    - SKU フォーマット: `ITEM#{産地略称}-{品種略称}-{グレード}-{焙煎度}-{容量}`
    - 各 SKU にランダムな初期在庫数（10-1000）、ロット番号、棚番号、単価、商品名を付与
    - _Requirements: 7.1, 7.5_

  - [x] 3.2 Seed Lambda ハンドラーを実装する
    - `amplify/functions/seed/handler.ts` を作成
    - 5,000 SKU × 3 倉庫 = 15,000 レコードを両テーブルに BatchWriteItem で投入
    - 25 件ずつバッチ書き込み、UnprocessedItems のリトライ（最大 5 回、指数バックオフ）
    - Lambda タイムアウト 15 分に設定
    - 進捗ログと投入済み件数のレスポンスを返す
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x]* 3.3 Seed スクリプトのプロパティテストを作成する
    - **Property 7: Seed data generation satisfies all invariants**
    - SKU 生成ロジックの単体テスト: 5,000 SKU、カテゴリ分布、命名規則、在庫範囲の検証
    - fast-check を使用して SKU ジェネレーターの不変条件を検証
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.5**

- [x] 4. 在庫照会 API の実装
  - [x] 4.1 inventory-query Lambda ハンドラーを実装する
    - `amplify/functions/inventory-query/handler.ts` を作成
    - パスパラメータ（warehouseId, itemId）とクエリパラメータ（table: bad|good）のバリデーション
    - Bad_Table: GetItem(PK=warehouseId, SK=itemId), Good_Table: GetItem(PK=itemId, SK=warehouseId)
    - ConsistentRead: true を常に指定
    - 404 レスポンス（アイテム未存在時）、500 レスポンス（スロットリング含む）
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x]* 4.2 在庫照会のプロパティテストを作成する
    - **Property 1: Inventory query returns complete record from correct table**
    - **Property 2: Non-existent inventory returns 404**
    - DynamoDB クライアントをモックし、正常系/異常系を fast-check で検証
    - **Validates: Requirements 3.1, 3.3, 3.4**

- [x] 5. 出庫処理 API の実装
  - [x] 5.1 inventory-ship Lambda ハンドラーを実装する
    - `amplify/functions/inventory-ship/handler.ts` を作成
    - リクエストボディ（warehouseId, itemId, quantity, table）のバリデーション
    - UpdateItem: `SET quantity = quantity - :qty, lastUpdated = :now`
    - ConditionExpression: `quantity >= :qty`
    - ConditionalCheckFailedException → 400 (INSUFFICIENT_STOCK, currentQuantity 付き)
    - スロットリングエラーはそのまま返す
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x]* 5.2 出庫処理のプロパティテストを作成する
    - **Property 3: Shipment correctly decrements quantity and updates timestamp**
    - **Property 4: Insufficient stock guard prevents over-shipment**
    - DynamoDB クライアントをモックし、在庫減算と在庫不足ガードを fast-check で検証
    - **Validates: Requirements 4.1, 4.3, 4.4**

- [x] 6. 負荷生成 API の実装
  - [x] 6.1 load-test-start Lambda ハンドラーを実装する
    - `amplify/functions/load-test-start/handler.ts` を作成
    - リクエストボディ（table, durationSeconds, requestsPerSecond, warehouseDistribution）のバリデーション
    - durationSeconds 最大 300、requestsPerSecond 最大 200
    - UUID で executionId 生成、executions テーブルに初期レコード書き込み
    - 負荷生成ワーカー Lambda を非同期 Invoke（Event 型）
    - 即座に 202 レスポンス（executionId, status: STARTED）を返す
    - _Requirements: 5.1, 5.2, 5.3_

  - [x] 6.2 負荷生成ワーカーを実装する
    - `amplify/functions/load-test-start/worker.ts` を作成（同一 Lambda の別ハンドラー、またはインライン）
    - setInterval ベースで指定レートのリクエスト生成
    - warehouseDistribution に基づく倉庫選択ロジック
    - ランダム SKU 選択（DynamoDB Scan で取得したアイテムリストから）
    - 実行結果を executions テーブルに定期更新（totalRequests, successCount, throttleCount, elapsedSeconds）
    - 完了時に status を COMPLETED に更新、エラー時は FAILED
    - _Requirements: 5.2, 5.4_

  - [x] 6.3 load-test-status Lambda ハンドラーを実装する
    - `amplify/functions/load-test-status/handler.ts` を作成
    - パスパラメータ executionId のバリデーション
    - executions テーブルから GetItem で取得
    - 存在しない場合は 404
    - レスポンス: executionId, status, totalRequests, successCount, throttleCount, elapsedSeconds
    - _Requirements: 6.1, 6.2, 6.3_

  - [x]* 6.4 負荷生成のプロパティテストを作成する
    - **Property 5: Load generation distributes requests per warehouse ratios using valid SKUs**
    - **Property 6: Load test status response contains all required fields**
    - 倉庫分布比率のロジックと status レスポンスのスキーマを fast-check で検証
    - **Validates: Requirements 5.2, 5.4, 6.2**

- [x] 7. Checkpoint - バックエンド API の確認
  - Ensure all tests pass, ask the user if questions arise.
  - sandbox デプロイ後に Seed → Query → Ship のフローが動作するか確認を推奨

- [x] 8. フロントエンド API クライアントの実装
  - [x] 8.1 API クライアントと共通型を作成する
    - `src/lib/inventory/api.ts` を作成
    - `src/lib/inventory/types.ts` を作成（InventoryRecord, ShipResponse, LoadTestParams, ExecutionStatus 等）
    - 環境変数 `NEXT_PUBLIC_INVENTORY_API_URL` から API ベース URL を取得
    - queryInventory, shipInventory, startLoadTest, getLoadTestStatus, seedData の各関数を実装
    - レスポンスタイム計測ロジックを queryInventory に組み込む
    - _Requirements: 8.2, 8.4, 9.2, 9.3_

- [x] 9. フロントエンド UI コンポーネントの実装
  - [x] 9.1 InventoryDashboard（メインコンテナ）を実装する
    - `src/components/inventory/InventoryDashboard.tsx` を作成
    - タブ切り替え UI: 「在庫照会」「負荷テスト」「結果ダッシュボード」
    - ヘッダーバー: Kiro Roasters ロゴ/ワードマーク + アプリタイトル「在庫管理検証システム」
    - CSS Module `src/components/inventory/InventoryDashboard.module.css` を作成
    - _Requirements: 8.1, 9.1, 10.1_

  - [x] 9.2 InventoryQueryPanel（在庫照会パネル）を実装する
    - `src/components/inventory/InventoryQueryPanel.tsx` を作成
    - フォーム: テーブル選択（bad/good ラジオボタン）、倉庫選択ドロップダウン、商品 ID 入力
    - 照会実行ボタン → API 呼び出し → 結果カード表示（全フィールド + レイテンシ）
    - エラー表示: スロットリング情報を含むアラートカード
    - レイテンシ色分け表示（< 100ms 緑、100-500ms 黄、> 500ms 赤）
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [x] 9.3 LoadTestPanel（負荷テスト制御パネル）を実装する
    - `src/components/inventory/LoadTestPanel.tsx` を作成
    - 設定フォーム: テーブル選択、継続秒数（最大 300）、リクエスト/秒（最大 200）、倉庫分布比率スライダー
    - 開始ボタン → Load_Test_API 呼び出し
    - 進捗表示: ポーリング（3 秒間隔）で Load_Test_Status_API を呼び出し
    - 進捗カード: status バッジ、経過時間、総リクエスト数、成功数、スロットル数（danger color で強調）
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x] 9.4 ResultsDashboard（結果ダッシュボードパネル）を実装する
    - `src/components/inventory/ResultsDashboard.tsx` を作成
    - Bad Table vs Good Table の比較ヘッダー（コーラル / ティール配色）
    - メトリクス比較: Avg Latency, P95 Latency, Throttle 数, Error Rate, Success Rate
    - 実行履歴テーブル（ID, Table, Duration, Requests, Throttle, Status）
    - テーブルインジケーター: 🔥 Bad Table / 🛡 Good Table のアイコン + テキスト
    - _Requirements: 10.1, 10.2, 10.3_

- [x] 10. グローバルスタイルとトップページの統合
  - [x] 10.1 globals.css にカラーパレットを追加する
    - design.md の Color Palette セクションに従い CSS カスタムプロパティを拡張
    - ブランドアクセント、セマンティックカラー、テーブル比較カラー、ダークモード対応
    - コンポーネントデザイントークン（card, btn-primary, btn-secondary, input, badge, alert 等）
    - _Requirements: 8.1, 10.1_

  - [x] 10.2 トップページ（page.tsx）を在庫管理 UI に差し替える
    - `src/app/page.tsx` を InventoryDashboard コンポーネントに置き換え
    - Seed ボタンの配置（初回データ投入用）
    - 環境変数未設定時のガイダンス表示
    - _Requirements: 8.1, 9.1, 10.1_

- [x] 11. Checkpoint - 全体統合確認
  - Ensure all tests pass, ask the user if questions arise.
  - sandbox 環境で Seed → Query（両テーブル）→ 負荷テスト → 結果確認のフロー動作を確認

- [x] 12. 可観測性の設定確認とテスト
  - [x] 12.1 X-Ray トレーシングと CloudWatch メトリクスの動作確認タスク
    - 全 Lambda 関数で X-Ray トレーシングが有効であることを CDK 定義で確認
    - DynamoDB メトリクス（WriteThrottleEvents, ReadThrottleEvents, ConsumedWriteCapacityUnits, SuccessfulRequestLatency）が CloudWatch に自動発行されることを確認
    - Lambda 関数からのスロットリングエラーが CloudWatch Logs に記録されることを確認
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

  - [x]* 12.2 CDK インフラテストを作成する
    - Jest + CDK Assertions で DynamoDB テーブルのキースキーマ、キャパシティ設定を検証
    - Lambda 関数の runtime, tracing 設定を検証
    - IAM ポリシーの最小権限を検証
    - API Gateway のリソース定義を検証
    - _Requirements: 11.1, 11.2, 11.3_

- [x] 13. Final Checkpoint - 全テスト通過確認
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties defined in the design document
- Unit tests validate specific examples and edge cases
- インフラ（CDK）→ Lambda → フロントエンドの順に構築し、各段階で sandbox デプロイ可能
- TypeScript を全レイヤーで一貫して使用（Lambda, CDK, Frontend）
- fast-check ライブラリを property-based testing に使用

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["1.4"] },
    { "id": 3, "tasks": ["3.1", "8.1"] },
    { "id": 4, "tasks": ["3.2", "4.1", "5.1", "6.3"] },
    { "id": 5, "tasks": ["3.3", "4.2", "5.2", "6.1"] },
    { "id": 6, "tasks": ["6.2", "6.4"] },
    { "id": 7, "tasks": ["9.1", "10.1"] },
    { "id": 8, "tasks": ["9.2", "9.3", "9.4", "10.2"] },
    { "id": 9, "tasks": ["12.1", "12.2"] }
  ]
}
```
