# Kiro Roasters 在庫管理 — DynamoDB vs OpenSearch 検索比較 PoC

架空のコーヒーロースター「Kiro Roasters」の在庫管理を題材に、DynamoDB GSI と OpenSearch Serverless NextGen の検索パフォーマンスを同一データ・同一条件で比較検証するサーバーレスアプリケーションです。

## 何ができるか

- **検索比較タブ**: 同一検索条件で DynamoDB (GSI) と OpenSearch Serverless (NextGen) に並列クエリを発行し、レイテンシ・結果件数を左右比較で可視化
- **在庫管理タブ**: 倉庫別の在庫一覧・個別照会・出庫処理
- **（オプション）負荷テスト**: DynamoDB のホットパーティション vs 分散設計の比較検証

## アーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│  Next.js (Amplify Hosting / localhost)                       │
│  ├── 検索比較タブ → GET /search (OpenSearch Lambda)         │
│  │                → GET /inventory?mode=comparison (DynamoDB)│
│  └── 在庫管理タブ → GET /inventory/{warehouseId}            │
└──────────────────────────┬──────────────────────────────────┘
                           │ API Gateway
┌──────────────────────────┴──────────────────────────────────┐
│  Lambda Functions                                            │
│  ├── opensearch-search   → OpenSearch Serverless (SigV4)    │
│  ├── inventory-query     → DynamoDB Good Table (GSI)        │
│  ├── inventory-ship      → DynamoDB Good Table              │
│  └── seed                → DynamoDB Good Table              │
└─────────────────────────────────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│  DynamoDB Good Table                                         │
│  PK=itemId, SK=warehouseId                                   │
│  GSI: byWarehouse, byLocation, byUnitPrice                   │
│  DynamoDB Streams → OSIS Pipeline → OpenSearch Collection   │
└─────────────────────────────────────────────────────────────┘
```

## 検索パターン比較

| 検索パターン | DynamoDB GSI | OpenSearch NextGen |
|---|---|---|
| 倉庫指定（完全一致） | ✅ GSI PK | ✅ term |
| 商品 ID 前方一致 | ✅ begins_with | ✅ prefix |
| 商品名部分一致 | ⚠️ FilterExpression | ✅ match (全文検索) |
| 単価範囲 | ✅ GSI SK BETWEEN | ✅ range |
| 複合条件 AND | ⚠️ 1 GSI + Filter | ✅ bool.must |
| 総件数取得 | ❌ 不可 | ✅ total |

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| フロントエンド | Next.js 15 + TypeScript |
| バックエンド | AWS Amplify Gen 2 + CDK |
| コンピュート | AWS Lambda (Node.js 20) |
| API | Amazon API Gateway REST API |
| データベース | Amazon DynamoDB (オンデマンド) |
| 全文検索 | Amazon OpenSearch Serverless NextGen (scale-to-zero) |
| データ同期 | DynamoDB Streams → OSIS Ingestion Pipeline |
| IDE 支援 | Kiro + Agent Toolkit for AWS |

## コスト

OpenSearch Serverless NextGen は **scale-to-zero** 対応のため、アイドル時はストレージ料金のみ。15,000 件程度のデータでは月額数セントレベル。Ingestion Pipeline は稼働中 $0.24/OCU/時 ですが、データ投入後に停止可能。

---

## クイックスタート

### 前提条件

- Node.js 20+
- AWS CLI 設定済み（`aws configure`）
- CDK Bootstrap 済み（`npx cdk bootstrap aws://ACCOUNT/REGION`）

### 1. セットアップ

```bash
git clone <リポジトリURL>
cd serverless-poc-stock-management
npm ci
```

### 2. Amplify sandbox デプロイ

```bash
npx ampx sandbox
```

初回デプロイは 10〜15 分かかります（OpenSearch Collection + Pipeline 作成のため）。
`✔ Deployment completed` が表示されたら次へ。

### 3. 環境変数設定

`.env.local` を作成して API URL を設定:

```bash
# sandbox の出力から API URL をコピー
# (CloudFormation Output の ApiInventoryApiUrl)
NEXT_PUBLIC_INVENTORY_API_URL=https://xxxxxxxx.execute-api.us-west-2.amazonaws.com/api/
```

### 4. 初期データ投入

```bash
# API Gateway 経由で seed Lambda を呼び出す
curl -X POST ${NEXT_PUBLIC_INVENTORY_API_URL}seed
```

5,000 SKU × 3 倉庫 = 15,000 レコードが投入されます。
DynamoDB Streams 経由で OpenSearch にも自動同期されます（2〜5 分）。

### 5. 開発サーバー起動

```bash
npm run dev
```

http://localhost:3000 にアクセスし、「検索比較」タブで DynamoDB vs OpenSearch の比較を確認できます。

---

## ディレクトリ構成

```
src/
  app/page.tsx                    # メインページ
  components/inventory/           # UI コンポーネント
    InventoryDashboard.tsx        #   タブコンテナ
    SearchComparisonView.tsx      #   検索比較ビュー（メイン機能）
    SearchForm.tsx                #   検索フォーム
    ComparisonPanel.tsx           #   DynamoDB/OpenSearch 左右比較パネル
    LatencyBar.tsx                #   レイテンシ比較バー
    InventoryListView.tsx         #   在庫一覧
  lib/inventory/
    api.ts                        #   API クライアント
    types.ts                      #   型定義

amplify/
  backend.ts                      # CDK エントリポイント
  custom/
    dynamodb-tables.ts            #   DynamoDB テーブル (Good Table + GSI)
    opensearch-infra.ts           #   OpenSearch Serverless + Pipeline
    lambda-functions.ts           #   Lambda 関数定義
    api-gateway.ts                #   API Gateway 定義
  functions/
    opensearch-search/            #   OpenSearch 検索 Lambda
    inventory-query/              #   DynamoDB 検索 Lambda (GSI + FilterExpression)
    inventory-ship/               #   出庫処理
    seed/                         #   データ投入
    shared/                       #   共有型定義

docs/
  opensearch-comparison.md        # 検索比較の詳細知見
  dynamodb-vs-rds-search.md       # DynamoDB vs RDS 比較考察
  observability.md                # 可観測性設定
```

---

## API エンドポイント

| Method | Path | Description |
|--------|------|-------------|
| GET | `/search?warehouseId=...&itemPrefix=...&itemName=...` | OpenSearch 検索 |
| GET | `/inventory/{warehouseId}?mode=comparison&...` | DynamoDB GSI 検索（比較用） |
| GET | `/inventory/{warehouseId}` | 在庫一覧 |
| POST | `/inventory/ship` | 出庫処理 |
| POST | `/seed` | 初期データ投入 |
| POST | `/load-test/start` | 負荷テスト開始（オプション） |

---

## オプション: ホットパーティション検証

DynamoDB のパーティションキー設計がオンラインリクエストに与える影響を実測したい場合、追加テーブル（Bad Table 等）を有効化して負荷テストを実施できます。

### 検証テーマ

| テーブル | PK | パーティション数 | 特徴 |
|---------|-----|----------------|------|
| Bad Table | `warehouseId` | 3（倉庫数） | ホットスポット発生 |
| Good Table | `itemId` | 5,000（SKU 数） | 均等分散 |

### 有効化手順

#### 1. テーブル定義のコメント解除

`amplify/custom/dynamodb-tables.ts`:
- `badTable`, `goodGsiTable`, `badOnDemandTable` のブロックコメントを解除
- `InventoryTables` インターフェースのオプショナルプロパティを有効化

#### 2. Lambda 環境変数の追加

`amplify/custom/lambda-functions.ts`:
- `commonEnv` 内の `BAD_TABLE_NAME`, `GOOD_GSI_TABLE_NAME`, `BAD_ONDEMAND_TABLE_NAME` のコメントを解除
- 権限付与のコメントアウトされたブロックを有効化

#### 3. フロントエンド切替 UI の有効化

`src/components/inventory/InventoryDashboard.tsx`:
- テーブル切替トグル（Good/Bad）を表示に戻す

#### 4. 再デプロイ & データ投入

```bash
# テーブル作成を含む再デプロイ
npx ampx sandbox

# Bad Table はプロビジョンドキャパシティのため、コスト発生に注意
# Seed で全テーブルにデータ投入
curl -X POST ${NEXT_PUBLIC_INVENTORY_API_URL}seed
```

#### 5. 負荷テスト実行

Web UI の「負荷テスト」タブから:
- 東京倉庫 70% 集中の朝の出荷ラッシュをシミュレート
- Bad Table vs Good Table のレスポンスタイム・スロットリング率を比較

> ⚠️ プロビジョンドキャパシティのテーブルはアイドル時もコストが発生します。テスト後は `npx ampx sandbox delete` で削除してください。

---

## お片付け

```bash
# sandbox 全リソース削除（DynamoDB, OpenSearch, Lambda, API Gateway 全て）
npx ampx sandbox delete --yes
```

---

## 詳細ドキュメント

| ドキュメント | 内容 |
|-------------|------|
| [docs/opensearch-comparison.md](docs/opensearch-comparison.md) | OpenSearch vs DynamoDB 検索比較の詳細知見・デプロイ Tips |
| [docs/dynamodb-vs-rds-search.md](docs/dynamodb-vs-rds-search.md) | DynamoDB vs RDS の検索パターン比較考察 |
| [docs/observability.md](docs/observability.md) | X-Ray / CloudWatch の設定と確認方法 |

---

## ライセンス

MIT
