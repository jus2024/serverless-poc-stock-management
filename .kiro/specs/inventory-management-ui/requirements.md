# Requirements Document

## Introduction

「在庫管理システム」として Tab 1 に在庫管理機能（一覧表示・個別照会・出庫処理）を配置し、ヘッダー右端に Good/Bad テーブル切替トグルを設ける。Tab 2 は LoadTestPanel のみで構成し、Tab 3 は既存の結果ダッシュボードを維持する。テーブルトグルにより、在庫管理タブの全操作対象テーブルが切り替わり、負荷テスト中に Bad テーブルへ切り替えることでスロットリングエラーを体験できる。

バックエンドでは `GET /inventory/{warehouseId}` エンドポイントを追加し、`table` クエリパラメータに応じて Good_Table は GSI byWarehouse による Query、Bad_Table は PK=warehouseId による直接 Query で倉庫別在庫一覧を取得する。

## Glossary

- **System**: 在庫管理システムのフロントエンド・バックエンド全体
- **Dashboard**: InventoryDashboard コンポーネント（ヘッダーバー・テーブルトグル・タブナビゲーションを含むメイン画面）
- **TableToggle**: ヘッダーバー右端に配置される Good/Bad テーブル切替トグルコンポーネント
- **InventoryListView**: Tab 1 に表示される在庫一覧・個別照会・出庫処理を含む統合コンポーネント
- **InventoryTable**: 在庫一覧をテーブル形式で表示するサブコンポーネント
- **API_Client**: src/lib/inventory/api.ts のフロントエンド API クライアントモジュール
- **InventoryQueryLambda**: amplify/functions/inventory-query の Lambda 関数
- **API_Gateway**: amplify/custom/api-gateway.ts で定義される REST API
- **Good_Table**: GSI byWarehouse（PK=warehouseId, SK=itemId, ALL projection）を持つ DynamoDB テーブル（PK=itemId, SK=warehouseId）
- **Bad_Table**: PK=warehouseId, SK=itemId の DynamoDB テーブル（GSI なし）
- **Warehouse**: 倉庫拠点識別子（WH-TOKYO, WH-OSAKA, WH-FUKUOKA）
- **NextToken**: DynamoDB の LastEvaluatedKey をエンコードしたページネーショントークン
- **Table**: テーブル種別を表す文字列（"good" または "bad"）

## Requirements

### Requirement 1: ヘッダーリブランド

**User Story:** As a ユーザー, I want システム名が「在庫管理システム」と表示される, so that 本番運用を意識したシステムとして認識できる

#### Acceptance Criteria

1. THE Dashboard SHALL display the header title as "在庫管理システム" instead of "在庫管理検証システム"

### Requirement 2: タブ構成の変更

**User Story:** As a ユーザー, I want タブ構成が「在庫管理」「負荷テスト」「結果ダッシュボード」の3つである, so that 在庫管理機能と検証機能が明確に分離される

#### Acceptance Criteria

1. THE Dashboard SHALL display three tabs labeled "在庫管理", "負荷テスト", and "結果ダッシュボード"
2. WHEN the user selects the "在庫管理" tab, THE Dashboard SHALL render the InventoryListView component
3. WHEN the user selects the "負荷テスト" tab, THE Dashboard SHALL render only the existing LoadTestPanel component
4. WHEN the user selects the "結果ダッシュボード" tab, THE Dashboard SHALL render the existing results dashboard component
5. THE "負荷テスト" tab SHALL NOT include the InventoryQueryPanel component

### Requirement 3: テーブル切替トグル

**User Story:** As a 検証担当者, I want ヘッダーから Good/Bad テーブルを切り替えたい, so that 負荷テスト実行中に Bad テーブルに切り替えてスロットリングエラーを体験できる

#### Acceptance Criteria

1. THE Dashboard SHALL display a TableToggle in the header bar at the right end
2. THE TableToggle SHALL provide two options labeled "Good" and "Bad"
3. THE TableToggle SHALL default to "Good" on initial page load
4. WHEN the user selects "Bad" on the TableToggle, THE Dashboard SHALL display a red-tinted indicator on the TableToggle to visually distinguish the Bad state
5. THE TableToggle SHALL be implemented as a small toggle switch or segment control that is unobtrusive in the header
6. WHEN the TableToggle value changes, THE InventoryListView SHALL re-fetch the inventory list using the newly selected Table value
7. THE TableToggle selection SHALL apply to all operations in the InventoryListView including list, individual query, and shipment

### Requirement 4: 在庫一覧表示

**User Story:** As a 倉庫管理者, I want 倉庫を選択して在庫一覧をテーブル形式で確認したい, so that 特定倉庫の在庫状況を素早く把握できる

#### Acceptance Criteria

1. THE InventoryListView SHALL display a warehouse selector with options for WH-TOKYO, WH-OSAKA, and WH-FUKUOKA
2. WHEN the user selects a Warehouse and triggers a search, THE InventoryListView SHALL call the API_Client listInventory function with the selected warehouseId and the current TableToggle value
3. THE InventoryTable SHALL display inventory records in a table with columns for itemId, itemName, quantity, lotNumber, location, unitPrice, and lastUpdated
4. THE InventoryTable SHALL display a maximum of 50 records per page

### Requirement 5: 在庫一覧ページネーション

**User Story:** As a 倉庫管理者, I want 50件を超える在庫がある場合に次のページを表示できる, so that 全在庫を段階的に確認できる

#### Acceptance Criteria

1. WHEN the API response contains a NextToken, THE InventoryTable SHALL display a "次のページ" button
2. WHEN the user clicks the "次のページ" button, THE InventoryListView SHALL call the API_Client listInventory function with the NextToken from the previous response and the current TableToggle value
3. WHEN the API response does not contain a NextToken, THE InventoryTable SHALL hide the "次のページ" button

### Requirement 6: 個別在庫照会

**User Story:** As a 倉庫管理者, I want 商品IDを入力して特定商品の在庫詳細を確認したい, so that 個別商品の正確な在庫情報を取得できる

#### Acceptance Criteria

1. THE InventoryListView SHALL provide an item ID input field for individual inventory lookup
2. WHEN the user enters an item ID and submits the query, THE InventoryListView SHALL call the existing queryInventory API function with the selected warehouseId, the entered itemId, and the current TableToggle value as the table parameter
3. WHEN the query returns a result, THE InventoryListView SHALL display the inventory record details including itemName, quantity, lotNumber, location, unitPrice, and lastUpdated
4. IF the query returns a NOT_FOUND error, THEN THE InventoryListView SHALL display a message indicating the item was not found

### Requirement 7: 出庫処理

**User Story:** As a 倉庫管理者, I want 出庫フォームから在庫の出庫処理を行いたい, so that 在庫数量を減算して出荷業務を記録できる

#### Acceptance Criteria

1. THE InventoryListView SHALL provide a shipment form with fields for warehouseId selector, itemId input, and quantity input
2. WHEN the user submits the shipment form, THE InventoryListView SHALL call the existing shipInventory API function with the entered warehouseId, itemId, quantity, and the current TableToggle value as the table parameter
3. WHEN the shipment succeeds, THE InventoryListView SHALL display a success message with the updated quantity
4. IF the shipment fails with an error, THEN THE InventoryListView SHALL display the error message returned by the API

### Requirement 8: バックエンド在庫一覧 API

**User Story:** As a フロントエンド, I want warehouseId とテーブル種別を指定して在庫一覧を取得する API が存在する, so that 倉庫別在庫一覧表示が実現できる

#### Acceptance Criteria

1. THE API_Gateway SHALL expose a GET endpoint at /inventory/{warehouseId} that accepts optional query parameters "table" (default "good") and "nextToken"
2. WHEN the InventoryQueryLambda receives a request with table="good" and no itemId, THE InventoryQueryLambda SHALL execute a DynamoDB Query on Good_Table GSI byWarehouse with KeyConditionExpression warehouseId equal to the path parameter
3. WHEN the InventoryQueryLambda receives a request with table="bad" and no itemId, THE InventoryQueryLambda SHALL execute a DynamoDB Query on Bad_Table with PK (warehouseId) equal to the path parameter
4. THE InventoryQueryLambda SHALL limit the Query result to 50 items per request using the Limit parameter
5. WHEN the DynamoDB Query returns a LastEvaluatedKey, THE InventoryQueryLambda SHALL encode the LastEvaluatedKey as a base64url string and include it as a "nextToken" field in the response body
6. WHEN the request includes a "nextToken" query parameter, THE InventoryQueryLambda SHALL decode the base64url token and use it as ExclusiveStartKey in the DynamoDB Query
7. THE InventoryQueryLambda SHALL return a JSON response with fields "items" (array of inventory records) and "nextToken" (string or null)
8. IF the "nextToken" query parameter is malformed, THEN THE InventoryQueryLambda SHALL return a 400 status with error code "INVALID_TOKEN"

### Requirement 9: フロントエンド API クライアント拡張

**User Story:** As a フロントエンドコンポーネント, I want listInventory 関数を使って在庫一覧を取得したい, so that バックエンド API との通信を統一的なインターフェースで行える

#### Acceptance Criteria

1. THE API_Client SHALL export a listInventory function that accepts warehouseId (string), table (Table), and an optional nextToken (string) parameter
2. WHEN listInventory is called, THE API_Client SHALL send a GET request to /inventory/{warehouseId} with "table" and optionally "nextToken" as query parameters
3. THE API_Client listInventory function SHALL return an object containing "items" (array of InventoryRecord) and "nextToken" (string or null)
4. IF the API returns an error response, THEN THE API_Client SHALL throw an ErrorResponse object consistent with the existing error handling pattern

### Requirement 10: 検証シナリオ対応

**User Story:** As a 検証担当者, I want 負荷テスト実行中に Bad テーブルに切り替えてスロットリングを体験したい, so that DynamoDB ホットスポットの影響を実感できる

#### Acceptance Criteria

1. WHILE a load test is running against the Bad_Table, WHEN the user switches the TableToggle to "Bad" and performs inventory operations, THE System SHALL propagate DynamoDB throttling errors to the InventoryListView
2. IF the InventoryQueryLambda receives a ProvisionedThroughputExceededException, THEN THE InventoryQueryLambda SHALL return a 500 status with error code "THROTTLED" and a descriptive message
3. IF the API_Client receives a THROTTLED error, THEN THE InventoryListView SHALL display the throttling error message to the user
