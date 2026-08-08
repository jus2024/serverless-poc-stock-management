# Implementation Plan: OpenSearch Comparison

## Overview

DynamoDB GSI 検索と OpenSearch Serverless NextGen 検索の横並び比較機能を段階的に実装する。インフラ（CDK）→ バックエンド（Lambda）→ API Gateway → フロントエンドの順で構築し、各ステップでテストを通して正しさを確認する。

## Tasks

- [x] 1. OpenSearch インフラ CDK Construct の作成
  - [x] 1.1 Good Table に DynamoDB Streams と PITR を有効化する
    - `amplify/custom/dynamodb-tables.ts` の `goodTable` 定義に `stream: StreamViewType.NEW_AND_OLD_IMAGES` と `pointInTimeRecovery: true` を追加する
    - _Requirements: 6.5, 6.6_

  - [x] 1.2 OpenSearch インフラ Construct を作成する (`amplify/custom/opensearch-infra.ts`)
    - `OpenSearchInfraConstruct` を新規作成
    - CfnCollectionGroup（scale-to-zero 設定）を定義
    - Encryption Policy（AWS 所有キー）を定義
    - Network Policy（パブリックアクセス）を定義
    - CfnCollection（Search タイプ、Collection Group 所属）を定義
    - Collection Group → Collection の依存関係を `addDependency` で設定
    - _Requirements: 6.1, 6.2_

  - [x] 1.3 Ingestion Pipeline 用の S3 バケットと IAM ロールを作成する
    - PITR エクスポート用の S3 バケットを定義（RemovalPolicy.DESTROY）
    - Ingestion Pipeline 用 IAM ロール（DynamoDB Streams 読み取り + S3 読み書き + OpenSearch 書き込み）を定義
    - Data Access Policy に Pipeline ロールと Lambda ロールを追加
    - _Requirements: 6.3, 6.7_

  - [x] 1.4 OpenSearch Ingestion Pipeline を作成する
    - `osis.CfnPipeline` で DynamoDB → OpenSearch のデータ同期パイプラインを定義
    - Pipeline 設定 YAML（source: dynamodb, sink: opensearch）を構築
    - Pipeline に Collection への依存関係を設定
    - _Requirements: 6.3, 6.4_

  - [x] 1.5 OpenSearch インフラを backend.ts に統合する
    - `amplify/backend.ts` に `OpenSearchInfraConstruct` をインスタンス化
    - `goodTable` を props として渡す
    - Collection エンドポイントを環境変数として出力
    - _Requirements: 6.1_

- [x] 2. Checkpoint - CDK 定義の確認
  - Ensure all tests pass, ask the user if questions arise.
  - `npx tsc --noEmit` で TypeScript 型チェックを実施

- [x] 3. OpenSearch 検索 Lambda の実装
  - [x] 3.1 opensearch-search Lambda プロジェクトを作成する
    - `amplify/functions/opensearch-search/` ディレクトリを作成
    - `package.json` に `@opensearch-project/opensearch`, `@aws-sdk/credential-provider-node` を追加
    - `handler.ts` に Lambda エントリポイントを実装
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.9_

  - [x] 3.2 Query DSL ビルダー関数を実装する (`amplify/functions/opensearch-search/query-builder.ts`)
    - `buildQuery(params: SearchRequest)` を純粋関数として実装
    - term（warehouseId）、prefix（itemId, location）、match（itemName）、range（unitPrice, quantity）クエリを構築
    - bool.must で全条件を AND 結合
    - from/size パラメータによるページネーションを設定
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_

  - [ ]* 3.3 Query DSL ビルダーのプロパティテストを作成する
    - **Property 1: OpenSearch Query DSL は全入力条件を AND 結合する**
    - **Validates: Requirements 4.7, 1.3, 1.4**
    - fast-check で任意の検索パラメータ組み合わせを生成し、生成された Query DSL の `bool.must` 配列が入力フィールドと 1:1 対応することを検証

  - [ ]* 3.4 Query DSL ビルダーのプロパティテスト（空フィールド除外）を作成する
    - **Property 4: 空フィールドは検索条件から除外される**
    - **Validates: Requirements 1.3**
    - fast-check で空文字列や undefined を含むパラメータを生成し、生成された Query DSL にそれらに対応するクエリ句が含まれないことを検証

  - [ ]* 3.5 Query DSL ビルダーのプロパティテスト（ページネーション）を作成する
    - **Property 5: OpenSearch ページネーションの from/size は非負整数を維持する**
    - **Validates: Requirements 7.2, 4.8**
    - fast-check で任意の from/size を生成し、出力の from ≥ 0、size ≥ 1 を検証

  - [x] 3.6 OpenSearch 検索 Lambda を CDK に登録する
    - `amplify/custom/lambda-functions.ts` に opensearch-search Lambda を追加
    - タイムアウト 60 秒、環境変数に OPENSEARCH_ENDPOINT を設定
    - OpenSearch Collection への `aoss:APIAccessAll` 権限を付与
    - _Requirements: 6.7, 9.3_

- [x] 4. DynamoDB 検索拡張の実装
  - [x] 4.1 GSI 選択ロジックを実装する (`amplify/functions/inventory-query/gsi-selector.ts`)
    - `selectGsi(params)` を純粋関数として実装
    - 優先順位: 単価範囲 → ロケーション前方一致 → 商品 ID 前方一致 → デフォルト(byWarehouse)
    - 戻り値: 選択した GSI 名 + KeyConditionExpression + FilterExpression に回す残り条件
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 4.2 FilterExpression ビルダーを実装する (`amplify/functions/inventory-query/filter-builder.ts`)
    - `buildFilterExpression(params, usedGsi)` を純粋関数として実装
    - 未使用条件を FilterExpression 文字列と ExpressionAttributeValues に変換
    - itemName → `contains(itemName, :name)`、その他 range/prefix 条件を対応する演算子で処理
    - _Requirements: 3.5, 3.6_

  - [ ]* 4.3 GSI 選択ロジックのプロパティテストを作成する
    - **Property 2: GSI 選択ロジックは常に 1 つの GSI のみを使用する**
    - **Validates: Requirements 3.5**
    - fast-check で任意の検索条件を生成し、selectGsi の戻り値が常に 1 つの GSI のみを指定することを検証

  - [ ]* 4.4 FilterExpression ビルダーのプロパティテストを作成する
    - **Property 3: DynamoDB 未使用条件は全て FilterExpression に含まれる**
    - **Validates: Requirements 3.5, 3.6**
    - fast-check で任意の検索条件を生成し、GSI の KeyCondition で使用されなかった条件が全て FilterExpression に含まれることを検証

  - [x] 4.5 inventory-query Lambda に検索比較用パスを追加する
    - `amplify/functions/inventory-query/handler.ts` に検索比較用のリクエストハンドリングを追加
    - クエリパラメータから検索条件を取得し、gsi-selector と filter-builder を使って DynamoDB Query を実行
    - レスポンスに `latencyMs`, `usedIndex`, `filterApplied`, `limitation` を含める
    - 倉庫未指定時の制約メッセージを返却
    - _Requirements: 3.1, 3.7, 3.8_

- [x] 5. Checkpoint - バックエンド実装の確認
  - Ensure all tests pass, ask the user if questions arise.
  - `npx tsc --noEmit` で型チェック、プロパティテストの実行確認

- [x] 6. API Gateway エンドポイント追加
  - [x] 6.1 API Gateway に /search エンドポイントを追加する
    - `amplify/custom/api-gateway.ts` の `InventoryApiProps` に `opensearchSearchFunction` を追加
    - `GET /search` エンドポイントを定義し、OpenSearch 検索 Lambda に統合
    - CORS 設定は既存の `defaultCorsPreflightOptions` を継承
    - `amplify/backend.ts` で opensearchSearchFunction を API Construct に渡す
    - _Requirements: 5.1, 5.2, 5.3_

- [x] 7. フロントエンドコンポーネントの実装
  - [x] 7.1 検索フォームコンポーネントを作成する (`src/components/inventory/SearchForm.tsx`)
    - 倉庫セレクター、商品 ID 前方一致、ロケーション前方一致、商品名部分一致を 1 行目に flex-wrap で配置
    - 単価範囲（min〜max）、数量範囲（min〜max）、検索ボタンを 2 行目に配置（ボタン右端）
    - CSS Module (`SearchForm.module.css`) でレイアウト定義
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 7.2 比較パネルコンポーネントを作成する (`src/components/inventory/ComparisonPanel.tsx`)
    - 左パネル（DynamoDB）と右パネル（OpenSearch）を横並びで表示
    - ヘッダーにレイテンシ(ms)と結果件数を表示
    - DynamoDB 制約メッセージ表示、OpenSearch コールドスタートローディング表示
    - 768px 以下で縦並びレスポンシブ対応
    - CSS Module (`ComparisonPanel.module.css`) でレイアウト定義
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x] 7.3 レイテンシバーコンポーネントを作成する (`src/components/inventory/LatencyBar.tsx`)
    - DynamoDB と OpenSearch のレイテンシを比較するバー表示
    - 最大値を基準に相対的な長さで表示
    - CSS Module (`LatencyBar.module.css`) でスタイル定義
    - _Requirements: 2.7_

  - [x] 7.4 検索比較ビューコンポーネントを作成する (`src/components/inventory/SearchComparisonView.tsx`)
    - SearchForm + ComparisonPanel + LatencyBar を統合するメインコンテナ
    - `Promise.allSettled` で DynamoDB と OpenSearch に並列リクエスト送信
    - OpenSearch 側に 35 秒タイムアウト、5 秒経過で「コールドスタート中」メッセージ
    - DynamoDB 側にカーソルベースページネーション（次へ/前へ）
    - OpenSearch 側にページ番号ジャンプ
    - CSS Module (`SearchComparisonView.module.css`) でレイアウト定義
    - _Requirements: 2.1, 2.5, 7.1, 7.2, 7.3, 7.4, 9.2_

  - [x] 7.5 API クライアント関数を追加する (`src/lib/inventory/api.ts`)
    - `searchOpenSearch(params)` 関数を追加
    - `searchDynamoDBComparison(params)` 関数を追加
    - クエリパラメータのビルドとレスポンス型定義
    - _Requirements: 5.1_

  - [x] 7.6 InventoryDashboard に「検索比較」タブを追加する
    - `src/components/inventory/InventoryDashboard.tsx` の Tab 型に `"search"` を追加
    - tabs 配列に `{ key: "search", label: "検索比較" }` を追加
    - タブパネルに `SearchComparisonView` を表示
    - _Requirements: 8.1, 8.2, 8.3_

- [x] 8. Checkpoint - フロントエンド実装の確認
  - Ensure all tests pass, ask the user if questions arise.
  - `npx tsc --noEmit` で型チェック、lint 確認

- [x] 9. 型定義とインターフェース整備
  - [x] 9.1 共通型定義を追加する (`src/lib/inventory/types.ts`)
    - `ComparisonSearchParams` インターフェースを追加
    - `OpenSearchSearchResponse` インターフェースを追加
    - `DynamoDBComparisonResponse` インターフェースを追加（usedIndex, filterApplied, limitation フィールド含む）
    - _Requirements: 3.8, 4.9_

- [x] 10. Final checkpoint - 全体統合の確認
  - Ensure all tests pass, ask the user if questions arise.
  - `npx tsc --noEmit` で全体型チェック確認
  - lint エラーがないことを確認

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties (Query DSL builder, GSI selector, FilterExpression builder)
- Unit tests validate specific examples and edge cases
- OpenSearch Serverless NextGen の Collection Group → Collection の依存関係は `addDependency` で明示的に設定する（単一デプロイで成功させるため）
- Ingestion Pipeline は Collection 作成後に初回 PITR エクスポートでフルロードを行う
- OpenSearch 検索 Lambda のタイムアウトは 60 秒（コールドスタート 30s + 検索処理 + マージン）
- CDK で DynamoDB Streams を有効化すると既存テーブルの置換は発生しない（in-place 更新）

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "9.1"] },
    { "id": 1, "tasks": ["1.2", "3.1"] },
    { "id": 2, "tasks": ["1.3", "3.2", "4.1", "4.2"] },
    { "id": 3, "tasks": ["1.4", "3.3", "3.4", "3.5", "4.3", "4.4"] },
    { "id": 4, "tasks": ["1.5", "3.6", "4.5"] },
    { "id": 5, "tasks": ["6.1"] },
    { "id": 6, "tasks": ["7.1", "7.2", "7.3", "7.5"] },
    { "id": 7, "tasks": ["7.4", "7.6"] }
  ]
}
```
