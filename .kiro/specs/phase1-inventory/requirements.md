# Requirements Document

## Introduction

Kiro Roasters の在庫管理基盤アプリケーション（Phase 1）の要件定義。DynamoDB のパーティションキー設計がオンラインリクエストのレスポンスに与える影響を検証するため、同一データを「悪い設計」と「良い設計」の2テーブルに保持し、負荷テストを通じてホットスポット問題を実測データで可視化する。

技術スタック: Next.js + AWS Amplify Gen 2（TypeScript）、Lambda、DynamoDB、API Gateway、X-Ray。

## Glossary

- **Inventory_System**: Kiro Roasters の在庫管理 Web アプリケーション全体（フロントエンド + バックエンド）
- **Bad_Table**: パーティションキーに warehouseId を使用する DynamoDB テーブル（テーブル名: kiro-roasters-inventory-bad）。東京倉庫にアクセスが集中しホットスポットが発生する設計
- **Good_Table**: パーティションキーに itemId を使用する DynamoDB テーブル（テーブル名: kiro-roasters-inventory-good）。アクセスが分散される設計
- **Inventory_Query_API**: 指定した倉庫・商品の在庫情報を取得する Lambda 関数および API Gateway エンドポイント
- **Ship_API**: 出庫処理（在庫数の減算）を実行する Lambda 関数および API Gateway エンドポイント
- **Load_Test_API**: 朝の出荷ラッシュをシミュレーションする負荷生成 Lambda 関数および API Gateway エンドポイント
- **Load_Test_Status_API**: 負荷生成の実行状況を確認する Lambda 関数および API Gateway エンドポイント
- **Seed_Script**: 初期データ（5,000 SKU × 3 倉庫 = 15,000 レコード）を両テーブルに投入するスクリプト
- **Warehouse**: Kiro Roasters の物理倉庫拠点（WH-TOKYO, WH-OSAKA, WH-FUKUOKA）
- **SKU**: 在庫管理単位の商品。コーヒー関連の命名規則に従う商品ID で識別される
- **Hotspot**: DynamoDB の特定パーティションにアクセスが集中し、スロットリングが発生する現象
- **Web_UI**: Next.js で構築される在庫管理フロントエンド画面（在庫照会、負荷テスト制御、結果ダッシュボード）

## Requirements

### Requirement 1: DynamoDB テーブル定義（悪い設計）

**User Story:** As a 検証者, I want ホットスポットが発生するテーブル設計を用意する, so that キー設計の影響を実測データで確認できる

#### Acceptance Criteria

1. THE Inventory_System SHALL define Bad_Table with partition key "warehouseId" (String) and sort key "itemId" (String)
2. THE Inventory_System SHALL configure Bad_Table with provisioned capacity of 100 RCU and 100 WCU
3. THE Inventory_System SHALL store the following attributes in Bad_Table: quantity (Number), lotNumber (String), lastUpdated (String, ISO 8601), location (String), unitPrice (Number), itemName (String)
4. THE Inventory_System SHALL enable DynamoDB Contributor Insights on Bad_Table

### Requirement 2: DynamoDB テーブル定義（良い設計）

**User Story:** As a 検証者, I want アクセスが分散されるテーブル設計を用意する, so that ホットスポットのない状態と比較できる

#### Acceptance Criteria

1. THE Inventory_System SHALL define Good_Table with partition key "itemId" (String) and sort key "warehouseId" (String)
2. THE Inventory_System SHALL configure Good_Table with provisioned capacity of 100 RCU and 100 WCU
3. THE Inventory_System SHALL create a GSI named "byWarehouse" on Good_Table with partition key "warehouseId" and sort key "itemId", projecting ALL attributes
4. THE Inventory_System SHALL store the same attributes in Good_Table as in Bad_Table: quantity (Number), lotNumber (String), lastUpdated (String, ISO 8601), location (String), unitPrice (Number), itemName (String)
5. THE Inventory_System SHALL enable DynamoDB Contributor Insights on Good_Table

### Requirement 3: 在庫照会 API

**User Story:** As a 検証者, I want 指定したテーブルから在庫情報を取得する, so that 両テーブルのレスポンスを比較できる

#### Acceptance Criteria

1. WHEN a GET request is received at /inventory/{warehouseId}/{itemId} with query parameter "table" set to "bad" or "good", THE Inventory_Query_API SHALL return the inventory record from the specified table
2. THE Inventory_Query_API SHALL use ConsistentRead (strong consistency) for all DynamoDB GetItem operations
3. THE Inventory_Query_API SHALL return a JSON response containing warehouseId, itemId, itemName, quantity, lotNumber, location, unitPrice, and lastUpdated
4. IF the requested item does not exist in the specified table, THEN THE Inventory_Query_API SHALL return HTTP 404 with a descriptive error message
5. IF DynamoDB returns a throttling error, THEN THE Inventory_Query_API SHALL propagate the error to the client without custom retry logic
6. THE Inventory_Query_API SHALL have X-Ray tracing enabled

### Requirement 4: 出庫処理 API

**User Story:** As a 検証者, I want 出庫処理（在庫減算）を実行する, so that 書き込み負荷を発生させホットスポットの影響を検証できる

#### Acceptance Criteria

1. WHEN a POST request is received at /inventory/ship with warehouseId, itemId, quantity, and table ("bad" or "good"), THE Ship_API SHALL decrement the inventory quantity by the specified amount
2. THE Ship_API SHALL use a ConditionExpression to ensure current quantity is greater than or equal to the requested shipment quantity
3. THE Ship_API SHALL update the lastUpdated attribute to the current ISO 8601 timestamp upon successful processing
4. IF the current inventory quantity is less than the requested shipment quantity, THEN THE Ship_API SHALL return HTTP 400 with an insufficient stock error
5. IF DynamoDB returns a throttling error, THEN THE Ship_API SHALL propagate the error to the client without custom retry logic
6. THE Ship_API SHALL have X-Ray tracing enabled

### Requirement 5: 負荷生成 API

**User Story:** As a 検証者, I want 朝の出荷ラッシュをシミュレーションする負荷を生成する, so that ホットスポット状態を再現できる

#### Acceptance Criteria

1. WHEN a POST request is received at /load-test/start with table, durationSeconds, requestsPerSecond, and warehouseDistribution, THE Load_Test_API SHALL start generating shipment requests at the specified rate
2. THE Load_Test_API SHALL distribute requests across warehouses according to the specified warehouseDistribution ratios (WH-TOKYO: 0.7, WH-OSAKA: 0.2, WH-FUKUOKA: 0.1 by default)
3. THE Load_Test_API SHALL return a JSON response containing executionId and status "STARTED" immediately upon accepting the request
4. THE Load_Test_API SHALL select random SKUs from the target warehouse for each generated shipment request
5. THE Load_Test_API SHALL have X-Ray tracing enabled

### Requirement 6: 負荷生成ステータス API

**User Story:** As a 検証者, I want 負荷生成の進捗状況を確認する, so that テストの完了やエラーを把握できる

#### Acceptance Criteria

1. WHEN a GET request is received at /load-test/status/{executionId}, THE Load_Test_Status_API SHALL return the current execution status
2. THE Load_Test_Status_API SHALL return a JSON response containing executionId, status ("RUNNING", "COMPLETED", or "FAILED"), totalRequests, successCount, throttleCount, and elapsedSeconds
3. IF the specified executionId does not exist, THEN THE Load_Test_Status_API SHALL return HTTP 404 with a descriptive error message

### Requirement 7: 初期データ生成

**User Story:** As a 検証者, I want 両テーブルに同一の初期データを投入する, so that 同じ条件で両設計を比較できる

#### Acceptance Criteria

1. THE Seed_Script SHALL generate 5,000 unique SKUs following the Kiro Roasters naming convention (e.g., ITEM#ETH-YIRG-G1-MEDIUM-200G)
2. THE Seed_Script SHALL create inventory records for each SKU across all 3 warehouses (WH-TOKYO, WH-OSAKA, WH-FUKUOKA), totaling 15,000 records per table
3. THE Seed_Script SHALL assign random initial quantities between 10 and 1000 for each inventory record
4. THE Seed_Script SHALL insert the same data into both Bad_Table and Good_Table
5. THE Seed_Script SHALL generate SKUs from the following categories: green beans (approximately 32 SKUs), roasted beans (approximately 960 SKUs), blends (approximately 1,500 SKUs), drip bags and gift sets (approximately 500 SKUs), and materials (approximately 2,008 SKUs)

### Requirement 8: Web UI — 在庫照会画面

**User Story:** As a 検証者, I want Web UI から在庫照会を実行する, so that ブラウザ上で両テーブルのレスポンスを確認できる

#### Acceptance Criteria

1. THE Web_UI SHALL provide a form to select the target table ("bad" or "good"), warehouse (WH-TOKYO, WH-OSAKA, WH-FUKUOKA), and item ID
2. WHEN the user submits an inventory query, THE Web_UI SHALL call the Inventory_Query_API and display the returned inventory record
3. IF the Inventory_Query_API returns an error, THEN THE Web_UI SHALL display the error message including throttling information
4. THE Web_UI SHALL display the response latency for each query request

### Requirement 9: Web UI — 負荷テスト制御画面

**User Story:** As a 検証者, I want Web UI から負荷テストを開始・監視する, so that ブラウザから検証作業を実行できる

#### Acceptance Criteria

1. THE Web_UI SHALL provide controls to configure load test parameters: target table, duration (seconds), requests per second, and warehouse distribution ratios
2. WHEN the user starts a load test, THE Web_UI SHALL call the Load_Test_API and display the returned executionId
3. WHILE a load test is running, THE Web_UI SHALL poll the Load_Test_Status_API and display current progress (totalRequests, successCount, throttleCount, elapsedSeconds)
4. THE Web_UI SHALL display throttle counts prominently to highlight hotspot effects

### Requirement 10: Web UI — 結果ダッシュボード

**User Story:** As a 検証者, I want 負荷テスト結果を比較表示する, so that 両設計の差異を視覚的に確認できる

#### Acceptance Criteria

1. THE Web_UI SHALL display a comparison of latency metrics (response time) between Bad_Table and Good_Table queries
2. THE Web_UI SHALL display throttle event counts for each table during load test execution
3. THE Web_UI SHALL display error rates for each table during load test execution

### Requirement 11: Amplify Gen 2 インフラ定義

**User Story:** As a 開発者, I want すべてのリソースを Amplify Gen 2 で定義する, so that sandbox 環境で反復開発およびリソース削除が容易にできる

#### Acceptance Criteria

1. THE Inventory_System SHALL define all DynamoDB tables, Lambda functions, and API Gateway endpoints using Amplify Gen 2 (CDK-based) infrastructure definitions in the amplify/ directory
2. THE Inventory_System SHALL enable X-Ray tracing on all Lambda functions
3. THE Inventory_System SHALL grant each Lambda function IAM permissions scoped to only the DynamoDB tables it accesses
4. THE Inventory_System SHALL allow complete resource cleanup via `npx ampx sandbox delete`
5. THE Inventory_System SHALL use Node.js 20.x runtime and TypeScript for all Lambda functions

### Requirement 12: 可観測性とモニタリング

**User Story:** As a 検証者, I want CloudWatch メトリクスと X-Ray トレースでホットスポットの影響を可視化する, so that 検証記事に実測データを掲載できる

#### Acceptance Criteria

1. THE Inventory_System SHALL emit DynamoDB metrics (WriteThrottleEvents, ReadThrottleEvents, ConsumedWriteCapacityUnits, SuccessfulRequestLatency) to CloudWatch
2. THE Inventory_System SHALL record X-Ray traces showing DynamoDB request retries under throttling conditions
3. THE Inventory_System SHALL enable DynamoDB Contributor Insights on both tables to detect hot partition keys
4. THE Inventory_System SHALL log DynamoDB throttling errors in CloudWatch Logs from all Lambda functions
