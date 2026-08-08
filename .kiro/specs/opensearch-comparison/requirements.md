# Requirements Document

## Introduction

DynamoDB の GSI 検索と OpenSearch NextGen の検索を横並びで比較する検証機能を構築する。同じ検索条件で DynamoDB と OpenSearch の両方にリクエストを送り、結果（レイテンシ、件数、データ）を左右に並べて比較表示することで、各検索エンジンの特性差を可視化する。

## Glossary

- **Search_UI**: 検索条件を入力するフロントエンドコンポーネント。全フィールドを常時表示し flex-wrap で 2 行に配置する
- **Comparison_View**: DynamoDB と OpenSearch の検索結果を左右パネルで並べて表示するフロントエンドコンポーネント
- **DynamoDB_Search_Lambda**: 既存の inventory-query Lambda を拡張し、GSI を使った検索を実行する関数
- **OpenSearch_Search_Lambda**: OpenSearch NextGen Collection に対して Query DSL を実行する新規 Lambda 関数
- **OpenSearch_Collection**: OpenSearch Serverless NextGen の Search タイプコレクション。scale-to-zero 対応
- **Ingestion_Pipeline**: DynamoDB Streams から OpenSearch Collection へデータを同期する OpenSearch Ingestion パイプライン
- **Good_Table**: 既存の DynamoDB テーブル（PK=itemId, SK=warehouseId, GSI: byWarehouse, byLocation, byUnitPrice）
- **API_Gateway**: 既存の REST API Gateway に追加するエンドポイント群
- **Cold_Start**: OpenSearch NextGen の scale-to-zero 状態からのウォームアップ（10〜30 秒）

## Requirements

### Requirement 1: 検索条件 UI の表示

**User Story:** As a 検証担当者, I want 全検索フィールドを一画面で見渡せる検索フォーム, so that 入力のための画面スクロールを最小化できる

#### Acceptance Criteria

1. THE Search_UI SHALL 倉庫セレクター、商品 ID 前方一致入力、ロケーション前方一致入力、商品名部分一致入力を 1 行目に flex-wrap で横並び配置する
2. THE Search_UI SHALL 単価範囲（min〜max）入力、数量範囲（min〜max）入力、検索ボタンを 2 行目に配置し、検索ボタンは右端に配置する
3. THE Search_UI SHALL 入力があるフィールドのみを検索条件として使用し、空欄のフィールドは無視する
4. WHEN 複数フィールドに値が入力された状態で検索ボタンが押された場合, THE Search_UI SHALL 全入力値を AND 条件として両検索エンジンに送信する

### Requirement 2: 検索結果の比較表示

**User Story:** As a 検証担当者, I want DynamoDB と OpenSearch の検索結果を左右に並べて比較する, so that レイテンシや結果件数の差異を即座に把握できる

#### Acceptance Criteria

1. THE Comparison_View SHALL 左パネルに DynamoDB (GSI) の検索結果を表示し、右パネルに OpenSearch NextGen の検索結果を表示する
2. THE Comparison_View SHALL 各パネルのヘッダーにレイテンシ（ms 単位）を表示する
3. THE Comparison_View SHALL 各パネルに結果件数を表示する
4. WHEN DynamoDB で対応できない検索条件が入力された場合, THE Comparison_View SHALL 左パネルに「未サポート: DynamoDB の GSI では部分一致/複合 AND は不可」等の具体的な理由メッセージを表示する
5. WHILE OpenSearch がコールドスタート中である場合, THE Comparison_View SHALL 右パネルにローディングインジケーターと「コールドスタート中（10〜30 秒）」メッセージを表示する
6. WHEN 画面幅が 768px 以下である場合, THE Comparison_View SHALL 左右パネルを縦並びレイアウトに切り替える
7. THE Comparison_View SHALL 両パネルのレイテンシを比較するバー表示を提供する

### Requirement 3: DynamoDB 検索の拡張

**User Story:** As a 検証担当者, I want 既存の GSI を活用した DynamoDB 検索を拡張する, so that OpenSearch との条件別比較が可能になる

#### Acceptance Criteria

1. THE DynamoDB_Search_Lambda SHALL 倉庫指定を PK 必須条件として受け付ける
2. WHEN 商品 ID 前方一致条件が指定された場合, THE DynamoDB_Search_Lambda SHALL GSI byWarehouse の SK に対して begins_with で検索を実行する
3. WHEN ロケーション前方一致条件が指定された場合, THE DynamoDB_Search_Lambda SHALL GSI byLocation の SK に対して begins_with で検索を実行する
4. WHEN 単価範囲条件が指定された場合, THE DynamoDB_Search_Lambda SHALL GSI byUnitPrice の SK に対して BETWEEN で検索を実行する
5. WHEN 複数条件が入力された場合, THE DynamoDB_Search_Lambda SHALL 1 つの GSI の KeyConditionExpression のみを使用し、残りの条件は FilterExpression として適用する
6. WHEN 商品名部分一致条件が入力された場合, THE DynamoDB_Search_Lambda SHALL FilterExpression の contains 演算子で検索を実行する
7. WHEN 対応不可の条件組み合わせが指定された場合, THE DynamoDB_Search_Lambda SHALL 制約メッセージを含めつつ、実行可能な範囲で結果を返却する
8. THE DynamoDB_Search_Lambda SHALL レスポンスにサーバー側レイテンシ（ms 単位）を含める

### Requirement 4: OpenSearch NextGen 検索

**User Story:** As a 検証担当者, I want OpenSearch の全文検索と複合条件検索を実行する, so that DynamoDB では困難な検索パターンの結果を確認できる

#### Acceptance Criteria

1. THE OpenSearch_Search_Lambda SHALL 倉庫条件を term フィルタとして適用する
2. THE OpenSearch_Search_Lambda SHALL 商品 ID 前方一致条件を prefix クエリとして適用する
3. THE OpenSearch_Search_Lambda SHALL ロケーション前方一致条件を prefix クエリとして適用する
4. THE OpenSearch_Search_Lambda SHALL 商品名部分一致条件を match クエリ（全文検索）として適用する
5. THE OpenSearch_Search_Lambda SHALL 単価範囲条件を range クエリとして適用する
6. THE OpenSearch_Search_Lambda SHALL 数量範囲条件を range クエリとして適用する
7. WHEN 複数条件が指定された場合, THE OpenSearch_Search_Lambda SHALL bool クエリの must 句で全条件を AND 結合する
8. THE OpenSearch_Search_Lambda SHALL from + size パラメータによるページネーション（OFFSET/LIMIT 相当）を提供する
9. THE OpenSearch_Search_Lambda SHALL レスポンスに OpenSearch の took 値（ms 単位）を含める

### Requirement 5: API Gateway エンドポイント

**User Story:** As a フロントエンド開発者, I want OpenSearch 検索用の REST エンドポイントを利用する, so that フロントエンドから OpenSearch 検索を呼び出せる

#### Acceptance Criteria

1. THE API_Gateway SHALL `GET /search` エンドポイントを提供し、warehouseId、itemPrefix、locationPrefix、itemName、minPrice、maxPrice、minQuantity、maxQuantity、from、size をクエリパラメータとして受け付ける
2. WHEN `GET /search` リクエストを受信した場合, THE API_Gateway SHALL OpenSearch_Search_Lambda にリクエストを転送する
3. THE API_Gateway SHALL CORS ヘッダーを設定し、フロントエンドからのクロスオリジンリクエストを許可する

### Requirement 6: OpenSearch インフラストラクチャ

**User Story:** As a インフラ担当者, I want OpenSearch Serverless NextGen のリソースを CDK で定義する, so that 再現可能なインフラ構築が可能になる

#### Acceptance Criteria

1. THE OpenSearch_Collection SHALL Search タイプの OpenSearch Serverless NextGen Collection として作成される
2. THE OpenSearch_Collection SHALL Collection Group による scale-to-zero 設定を有効にする
3. THE Ingestion_Pipeline SHALL DynamoDB Streams から OpenSearch Collection へのデータ同期を行う
4. WHEN Good_Table にレコードが追加・更新・削除された場合, THE Ingestion_Pipeline SHALL 変更を OpenSearch_Collection に反映する
5. THE Good_Table SHALL DynamoDB Streams を NEW_AND_OLD_IMAGES モードで有効化する
6. THE Good_Table SHALL PITR（Point-in-Time Recovery）を有効化し、初回フルロード同期に対応する
7. THE OpenSearch_Search_Lambda SHALL IAM 認証で OpenSearch_Collection にアクセスし、aoss:APIAccessAll 権限を持つ

### Requirement 7: ページネーション

**User Story:** As a 検証担当者, I want 両検索エンジンの結果をページ送りで確認する, so that 大量の検索結果を段階的に確認できる

#### Acceptance Criteria

1. THE DynamoDB_Search_Lambda SHALL 既存の 20 件/ページのカーソルベースページネーション（LastEvaluatedKey）を維持する
2. THE OpenSearch_Search_Lambda SHALL from/size ベースのページネーション（デフォルト size=20）を提供する
3. THE Comparison_View SHALL DynamoDB 側に「次へ」「前へ」ボタンを表示する
4. THE Comparison_View SHALL OpenSearch 側にページ番号ジャンプ機能を提供する

### Requirement 8: フロントエンド統合

**User Story:** As a 検証担当者, I want 検索比較機能を既存アプリのタブとしてアクセスする, so that 在庫管理機能とシームレスに切り替えられる

#### Acceptance Criteria

1. THE Search_UI SHALL 既存アプリ内の新しいタブまたは既存の在庫管理タブの一部として配置される
2. THE Search_UI SHALL src/components/inventory/ 配下に新規コンポーネントとして作成される
3. THE Comparison_View SHALL 検索条件フォームを共通で 1 つ持ち、結果のみを左右パネルに分割する

### Requirement 9: 運用上の制約と文書化

**User Story:** As a 開発者, I want OpenSearch NextGen 利用時の制約事項を把握する, so that 開発・テスト時に想定外の問題を回避できる

#### Acceptance Criteria

1. IF OpenSearch Collection が sandbox delete で削除されない場合, THEN THE README SHALL 手動削除が必要である旨と削除手順を記載する
2. THE Comparison_View SHALL OpenSearch のコールドスタート（10〜30 秒）を考慮し、タイムアウトまでローディング表示を継続する
3. THE OpenSearch_Search_Lambda SHALL Lambda のタイムアウトを OpenSearch コールドスタートに十分対応できる値（30 秒以上）に設定する
