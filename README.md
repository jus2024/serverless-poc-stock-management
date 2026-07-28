# Kiro Roasters 在庫管理システム

DynamoDB のパーティションキー設計がオンラインリクエストのレスポンスに与える影響を実測検証するアプリケーションです。

架空のコーヒーロースター「Kiro Roasters」の在庫管理を題材に、同一データを「悪い設計」と「良い設計」の 2 テーブルに保持し、朝の出荷ラッシュ（書き込み集中）の状況下でレスポンスタイムとエラー率を比較します。

## 検証テーマ

| テーブル | PK | パーティション数 | 特徴 |
|---------|-----|----------------|------|
| Bad Table | `warehouseId` | 3（倉庫数） | ホットスポット発生 |
| Good Table | `itemId` | 5,000（SKU 数） | 均等分散 |

- **データ量**: 5,000 SKU × 3 倉庫 = 15,000 レコード/テーブル
- **負荷パターン**: 朝の出荷ラッシュ（東京倉庫 70% 集中）
- **比較項目**: レスポンスタイム（p50/p95/p99）、スロットリング率、エラー率

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| フロントエンド | Next.js + TypeScript |
| バックエンド | AWS Amplify Gen 2 + CDK |
| コンピュート | AWS Lambda (Node.js 20.x) |
| API | Amazon API Gateway REST API |
| データベース | Amazon DynamoDB (プロビジョンドキャパシティ) |
| 可観測性 | X-Ray, CloudWatch Metrics/Logs, Contributor Insights |
| ホスティング | Amplify Hosting |
| IDE 支援 | Kiro + Agent Toolkit for AWS |

## ディレクトリ構成

```
src/
  app/page.tsx                  # メインページ（タブ UI）
  components/inventory/         # 在庫管理 UI コンポーネント
    InventoryDashboard.tsx       #   タブコンテナ（ヘッダーに Good/Bad トグル）
    InventoryListView.tsx        #   倉庫別在庫一覧（ページネーション付き）
    InventoryTable.tsx           #   在庫テーブル表示
    TableToggle.tsx              #   Good/Bad テーブル切替トグル
    InventoryQueryPanel.tsx      #   在庫照会パネル（個別照会・出庫）
    LoadTestPanel.tsx            #   負荷テスト制御パネル
    ResultsDashboard.tsx         #   結果ダッシュボード
  lib/inventory/                # API クライアント
    api.ts                      #   REST API 呼び出し
    types.ts                    #   型定義
amplify/
  custom/                       # CDK Construct
    dynamodb-tables.ts          #   DynamoDB テーブル定義
    lambda-functions.ts         #   Lambda 関数定義
    api-gateway.ts              #   API Gateway 定義
  functions/                    # Lambda ハンドラー
    inventory-query/            #   在庫照会
    inventory-ship/             #   出庫処理
    load-test-start/            #   負荷生成開始
    load-test-status/           #   負荷テストステータス
    seed/                       #   初期データ投入
    shared/                     #   共有ユーティリティ
docs/
  observability.md              # 可観測性ドキュメント
.kiro/                          # Kiro ワークスペース設定
.github/                        # CI/CD
```

---

## クイックスタート

### 1. セットアップ

```bash
git clone <リポジトリURL>
cd serverless-poc-stock-management
npm ci
```

### 2. Amplify sandbox デプロイ

ターミナルを 2 つ開いて:

```bash
# ターミナル 1: Amplify sandbox 起動（初回は数分）
npx ampx sandbox

# ターミナル 2: 開発サーバー起動
npm run dev
```

sandbox デプロイが完了すると `amplify_outputs.json` が生成され、API Gateway URL が自動設定されます。

### 3. 初期データ投入（Seed）

API を直接呼び出してデータを投入します:

```bash
curl -X POST ${API_URL}/seed
```

5,000 SKU × 3 倉庫 = 15,000 レコードが Bad Table / Good Table の両方に投入されます。

> **注意**: Seed 実行時に `ProvisionedThroughputExceededException` が発生する場合があります。その場合はしばらく待ってリトライするか、DynamoDB コンソールで一時的に WCU を引き上げてください。

### 4. 在庫照会・負荷テスト

Web UI (`http://localhost:3000`) の 3 つのタブで操作します:

1. **在庫管理** — 倉庫別在庫一覧表示（ページネーション付き）、個別照会、出庫処理。ヘッダーの Good/Bad トグルでテーブルを切替
2. **負荷テスト** — 朝の出荷ラッシュをシミュレート（東京 70% 集中）
3. **結果ダッシュボード** — レスポンスタイム・エラー率の比較表示

---

## アーキテクチャ

### API エンドポイント

| Method | Path | Description |
|--------|------|-------------|
| GET | `/inventory/{warehouseId}?table=bad\|good&nextToken=...` | 倉庫別在庫一覧 |
| GET | `/inventory/{warehouseId}/{itemId}?table=bad\|good` | 在庫照会 |
| POST | `/inventory/ship` | 出庫処理 |
| POST | `/load-test/start` | 負荷生成開始 |
| GET | `/load-test/status/{executionId}` | 負荷テストステータス |
| POST | `/seed` | 初期データ投入 |

### DynamoDB テーブル設計

**Bad Table** (`kiro-roasters-inventory-bad`):
- PK: `warehouseId` / SK: `itemId`
- 3 パーティションに全リクエストが集中 → ホットスポット

**Good Table** (`kiro-roasters-inventory-good`):
- PK: `itemId` / SK: `warehouseId`
- GSI: `byWarehouse`（warehouseId → itemId）
- 5,000 パーティションに均等分散

### 可観測性

- **X-Ray**: Lambda → DynamoDB のトレース
- **CloudWatch Metrics**: カスタムメトリクス（レイテンシ、エラー率）
- **Contributor Insights**: パーティションキーレベルのアクセスパターン可視化

詳細は [docs/observability.md](docs/observability.md) を参照してください。

---

## 環境変数

| 変数名 | 説明 |
|--------|------|
| `NEXT_PUBLIC_INVENTORY_API_URL` | API Gateway URL。sandbox デプロイ後、`amplify_outputs.json` または CDK 出力から URL を手動で `.env.local` にコピーしてください（ステージ名: `api`） |

---

## ブランチ戦略

| ブランチ | 用途 |
|---------|------|
| `main` | 本番向け |
| `develop` | 統合ブランチ |
| `feature/*` | 実装作業用 |

## CI/CD

| 対象 | 担当 | 方法 |
|------|------|------|
| Web アプリ（品質ゲート） | GitHub Actions | lint、型チェック |
| Web アプリ（デプロイ） | Amplify Hosting | Git push で自動 |

## Kiro + Agent Toolkit for AWS

[Agent Toolkit for AWS](https://github.com/aws/agent-toolkit-for-aws) の MCP サーバーを設定済みです。Kiro から AWS ドキュメント検索、スキル検索、CLI 実行が利用できます。

---

## お片付け（リソース削除）

```bash
# sandbox の停止・削除
npx ampx sandbox delete
```

Amplify Hosting を使用している場合は、AWS コンソール → Amplify → アプリを削除してください。

---

## 詳細ドキュメント

| ドキュメント | 内容 |
|-------------|------|
| [docs/observability.md](docs/observability.md) | 可観測性の設定と確認方法 |
