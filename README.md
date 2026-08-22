# Kiro Roasters 在庫管理 — DynamoDB 検索方式の比較 PoC

架空のコーヒーロースター「Kiro Roasters」の在庫管理（5,000 SKU × 3 倉庫 = 15,000 レコード）を題材に、**同一データ・同一条件で複数の検索方式を比較検証する**サーバーレスアプリケーションです。

測定値と考察は `docs/` に記録してあります。アプリを動かさずにドキュメントだけ読んでも結論を追えます。

## 何ができるか

**4 つの検証テーマ**を 1 つのアプリに載せています。同じ 15,000 レコードを共有するため、方式間の比較が同一条件で成立します。

| 検証テーマ | タブ | 既定デプロイで使えるか | 記録 |
|---|---|---|---|
| **全文検索の比較**<br>DynamoDB GSI vs OpenSearch Serverless NextGen | 検索比較 | ✅ そのまま使える | [docs/opensearch-comparison.md](docs/opensearch-comparison.md) |
| **ベクトル検索（意味検索）の比較**<br>DynamoDB Vector Search vs OpenSearch VECTORSEARCH (k-NN) | ベクトル検索比較 | ⚠️ **環境変数とデータ準備が必要**（後述） | [docs/vector-search-comparison.md](docs/vector-search-comparison.md) |
| **ホットパーティション検証**<br>PK 設計がオンラインリクエストに与える影響 | 負荷テスト | ❌ **コード変更とコストが必要**（後述） | — |
| 在庫管理（検証対象データの操作） | 在庫管理 | ✅ そのまま使える | — |

**`npx ampx sandbox` をそのまま実行すると、全文検索の比較と在庫管理が使えます。** 残る 2 つは意図的に既定で無効にしてあり、理由が異なります。

- **ベクトル検索**: 課金対象になりうる OpenSearch Collection / Index / 検索 Lambda 4 本を段階ゲートで止めています。**費用は小さい**（検証全体で OCU 実測 1.80 USD、アイドル時 0 USD）が、初回のデータ準備に**約 2 時間**かかります
- **ホットパーティション検証**: プロビジョンドキャパシティのテーブルを作るため、**アイドル時も課金が継続します**

> ⚠️ 既定デプロイでも「ベクトル検索比較」タブは画面に現れますが、API ルートと検索 Lambda が存在しないため機能しません。有効化手順を踏むまではエラー表示になります。

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

## ベクトル検索の比較軸

「ベクトル検索比較」タブで比較する項目です。実測値と採否判断は [docs/vector-search-comparison.md](docs/vector-search-comparison.md) にあります（第 1.1〜1.7 節が「実務で使えるか」の総合判断）。

| 比較軸 | DynamoDB Vector Search | OpenSearch VECTORSEARCH |
|---|---|---|
| TopK 上限 | 100 件（ページネーション不可） | 上限なし |
| フィルタ演算子 | **等価のみ**（範囲は実測で非対応） | 等価 + 範囲 |
| 次元数上限 | 4,096 | 16,000 |
| インデックスの直接読み取り | `SearchVectors` のみ（`Query` / `Scan` / PartiQL 不可） | 可 |
| アイドルコスト | ストレージのみ（月 0.07 USD 規模） | **0 USD**（scale-to-zero） |
| アイドル後の初回応答 | **約 400 ms** | **18〜19 秒** |
| 業務属性の同時取得 | 1 回の呼び出しで取得できる | 検索後に引き直しが必要 |

日英 2 本の埋め込みベクトルを SKU ごとに独立生成し、**言語別に recall を測定**します。Titan Text Embeddings V2 の日本語サポートがプレビュー扱いであることを、注意書きではなく実測差として提示するためです。

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| フロントエンド | Next.js 15 + TypeScript |
| バックエンド | AWS Amplify Gen 2 + CDK |
| コンピュート | AWS Lambda (Node.js 20) |
| API | Amazon API Gateway REST API |
| データベース | Amazon DynamoDB (オンデマンド) |
| 全文検索 | Amazon OpenSearch Serverless NextGen (scale-to-zero) |
| ベクトル検索 | DynamoDB Vector Search / OpenSearch Serverless VECTORSEARCH (k-NN, HNSW, cosine) |
| 埋め込み生成 | Amazon Bedrock — Titan Text Embeddings V2 (1,024 次元, 日英 2 本) |
| データ同期 | DynamoDB Streams → OSIS Ingestion Pipeline |
| テスト | Vitest + fast-check (property-based) + aws-cdk-lib/assertions |
| IDE 支援 | Kiro + Agent Toolkit for AWS |

## コスト

| 検証テーマ | アイドル時のコスト | 備考 |
|---|---|---|
| 全文検索の比較（既定） | ストレージのみ（月数セント） | OpenSearch NextGen は scale-to-zero 対応。OSIS Pipeline はデータ投入後に停止可能（稼働中 $0.24/OCU/時） |
| ベクトル検索の比較 | **0 USD**（実測） | scale-to-zero が VECTORSEARCH でも効くことを実測で確認済み |
| ホットパーティション検証 | **課金が継続** | プロビジョンドキャパシティのテーブルを作るため。テスト後は削除推奨 |

**放置してコストが増えるのはホットパーティション検証だけです。** 他は使っていなければほぼ無料です。

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
    VectorSearchComparisonView.tsx #  ベクトル検索比較ビュー
    VectorSearchForm.tsx          #   検索フォーム（言語セレクター付き）
    VectorComparisonPanel.tsx     #   左右比較パネル
    VectorOverlapSummary.tsx      #   結果の重なり・順位差
    VectorConstraintTable.tsx     #   機能制約比較表
  lib/inventory/
    api.ts                        #   API クライアント
    types.ts                      #   型定義
    vector-api.ts                 #   ベクトル検索 API クライアント
    vector-types.ts               #   ベクトル検索の型定義
    vector-overlap.ts             #   重なり指標の算出（純関数）

amplify/
  backend.ts                      # CDK エントリポイント
  custom/
    dynamodb-tables.ts            #   DynamoDB テーブル (Good Table + GSI)
    opensearch-infra.ts           #   OpenSearch Serverless + Pipeline
    vector-collection.ts          #   OpenSearch VECTORSEARCH Collection + Index
    vector-index.ts               #   DynamoDB ベクトルインデックス（カスタムリソース）
    lambda-functions.ts           #   Lambda 関数定義
    api-gateway.ts                #   API Gateway 定義
  functions/
    opensearch-search/            #   OpenSearch 検索 Lambda
    inventory-query/              #   DynamoDB 検索 Lambda (GSI + FilterExpression)
    inventory-ship/               #   出庫処理
    seed/                         #   データ投入
    vector-query-embed/           #   クエリ埋め込み生成 Lambda
    vector-search-ddb/            #   DynamoDB SearchVectors Lambda
    vector-search-aoss/           #   OpenSearch k-NN + 格納値検証 Lambda
    vector-capabilities/          #   機能制約メタデータ Lambda
    vector-embed-batch/           #   埋め込みバッチ（複製 + 生成）
    vector-index-provisioner/     #   ベクトルインデックス作成カスタムリソース
    shared/                       #   共有型定義（vector/ にベクトル系の純関数）

scripts/vector-search/            # 測定・検証スクリプト（ローカル実行）
  recall-cli.ts                   #   recall 測定
  measure.ts                      #   ストレージ・キャパシティ・OCU 測定
  validate-scale-to-zero.ts       #   scale-to-zero 受理可否の判定
  verify-embeddings.ts            #   格納値の一致検証
  probe-range-filter.ts           #   範囲フィルタのプローブ

docs/
  opensearch-comparison.md        # 全文検索比較の詳細知見
  vector-search-comparison.md     # ベクトル検索比較の詳細知見
  dynamodb-vs-rds-search.md       # DynamoDB vs RDS 比較考察
  observability.md                # 可観測性設定
  measurements/                   # 測定結果の生データ（JSON。再現と改訂の基準）
```

## テスト

```bash
npm run test          # Vitest（property-based テストを含む）
npm run lint
npx tsc --noEmit
```

純関数の性質は property-based テスト（`fast-check`）で各 100 回以上反復して検証しています。CDK 合成のスナップショットテストは**既存リソースの差分が 0 であること**を機械的に固定しており、検証用リソースの追加が既存の測定値を壊していないことを保証します。

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
| GET | `/vector-search/capabilities` | 機能制約メタデータ（オプション） |
| POST | `/vector-search/embed` | クエリ埋め込み生成（オプション） |
| POST | `/vector-search/dynamodb` | DynamoDB `SearchVectors`（オプション） |
| POST | `/vector-search/opensearch` | OpenSearch k-NN（オプション） |
| POST | `/vector-search/embed-batch` | 埋め込みバッチ（複製 + 生成。オプション） |
| POST | `/vector-search/verify` | 両バックエンドの格納値一致検証（オプション） |

---

## オプション: ベクトル検索比較（意味検索）

自然言語クエリを Bedrock で 1,024 次元のベクトルに変換し、**同一のクエリベクトル・同一の TopK・同一の検索言語**で DynamoDB Vector Search と OpenSearch VECTORSEARCH に投げて比較します。

**既定デプロイでは有効になりません。** 課金対象になりうる Collection / Index / 検索 Lambda 4 本を段階ゲート（既定 false）で止めているためです。

### 1. 有効化してデプロイ

```bash
export VECTOR_COLLECTION_ENABLED=true
npx ampx sandbox
```

デプロイ時に DynamoDB のベクトルインデックス 2 本（日本語用・英語用）が作られます。**1 本あたり ACTIVE 到達まで約 9 分、2 本を逐次で約 18 分**かかります。

> ⚠️ **一度有効化したあと、この環境変数を付けずに `npx ampx sandbox` を実行すると Collection / Index / 検索 Lambda 4 本が削除されます。** ウォッチモードでは任意のファイル保存が再合成の契機になるため、フラグを忘れた状態でファイルを 1 つ保存しただけでも削除が起きます。作業中はシェルセッション全体で `export` を効かせてください。復旧にはインデックス再作成 18 分 + 全件再埋め込み 95 分が必要です。

### 2. データ準備（初回のみ、約 2 時間）

```bash
API=${NEXT_PUBLIC_INVENTORY_API_URL}

# 2-1. Good Table から Vector Table へ 15,000 レコードを複製（数分）
curl -X POST ${API}vector-search/embed-batch \
  -H 'Content-Type: application/json' -d '{"phase":"copy"}'

# 2-2. 5,000 SKU × 2 言語 = 10,000 回の埋め込み生成（約 95 分）
curl -X POST ${API}vector-search/embed-batch \
  -H 'Content-Type: application/json' -d '{"phase":"embed"}'
```

- **`copy` は Good Table を読み取るだけで書き込みません。** 既存データは一切変更されません
- **`embed` が HTTP 504 を返しても処理は継続します。** API Gateway の統合タイムアウトは 29 秒ですが、Lambda は自己再帰で 7 回以上起動して完走します。進捗は `load-test-executions` テーブルに記録されます
- 所要時間は Bedrock のレート上限（既定 120 リクエスト/分）で決まり、本質的に短縮できません

### 3. 動作確認

```bash
npm run dev
```

「ベクトル検索比較」タブで検索します。試すクエリは [docs/vector-search-comparison.md](docs/vector-search-comparison.md) 第 2.4 節に 60 件（日英対）あります。

### コスト

| 項目 | 値 |
|---|---|
| OpenSearch OCU（検証全体・複数日） | **1.80 USD**（実測。7.4833 OCU-hour × 0.24） |
| アイドル時 OCU | **0 USD**（実測。scale-to-zero が効く） |
| Bedrock 埋め込み（初回のみ 10,000 回） | 約 0.01 USD（推定） |
| DynamoDB ストレージ | 月約 0.07 USD（推定。テーブル 138 MB + インデックス 149 MB） |
| DynamoDB 検索 | **単価未確認**（1 検索あたり 61〜117 KB は実測） |

**ホットパーティション検証と違い、放置してもコストが増えません。** 制約は費用ではなくデータ準備の時間です。

### 運用スクリプト

測定と検証は常駐リソースを増やさないため、ローカル実行の TypeScript スクリプトにしてあります。

| コマンド | 用途 |
|---|---|
| `npm run vector:validate` | scale-to-zero（最小 OCU 0）の受理可否を判定。**課金リソース作成前のゲート** |
| `npm run vector:measure` | ストレージ・消費キャパシティ・OCU・累積課金の測定。`-- --watch-spend --hours 48` で課金監視 |
| `npm run vector:recall` | 言語別 recall の測定（60 クエリ × 2 言語 × 2 バックエンド × k 3 種 = 720 観測） |
| `npm run vector:verify` | 両バックエンドの格納値が全次元一致するかの検証（Bedrock を呼ばない） |
| `npm run vector:probe-range` | 範囲フィルタの対応可否プローブ（読み取りのみ） |

`vector:recall` はメモリを要するため `NODE_OPTIONS=--max-old-space-size=8192` を付けてください。

### 撤収

```bash
# 環境変数を外して再デプロイすると Collection / Index / 検索 Lambda が削除される
unset VECTOR_COLLECTION_ENABLED
npx ampx sandbox

# 削除完了の確認
npm run vector:measure -- --teardown-check
```

`--teardown-check` は課金対象リソースが 0 件であること、および **Good Table がデプロイ前と同一であること**（PK / SK、3 GSI、Streams、PITR、15,000 件、抽出 10 件の属性集合とサイズ）を確認します。

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
| [docs/vector-search-comparison.md](docs/vector-search-comparison.md) | DynamoDB Vector Search vs OpenSearch VECTORSEARCH のベクトル検索比較検証（上記の続き） |
| [docs/dynamodb-vs-rds-search.md](docs/dynamodb-vs-rds-search.md) | DynamoDB vs RDS の検索パターン比較考察 |
| [docs/observability.md](docs/observability.md) | X-Ray / CloudWatch の設定と確認方法 |

---

## ライセンス

MIT
