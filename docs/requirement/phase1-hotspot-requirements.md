# Phase 1: DynamoDB ホットスポット検証 — プロジェクト要件書

## 概要

架空のコーヒー焙煎メーカー「Kiro Roasters」の在庫管理システムを題材に、
DynamoDB のキー設計の良し悪しがオンラインリクエストのレスポンスにどう影響するかを検証する。

**目的**: 朝の出荷ラッシュ（書き込み集中）が在庫照会（読み取り）に与える影響を、
悪いキー設計と良いキー設計で比較し、ホットスポット問題を実測データで可視化する。

**技術スタック**: Kiro + AWS Amplify Gen2 構成

---

## ビジネスコンテキスト

### Kiro Roasters（架空企業）

- スペシャルティコーヒーの焙煎メーカー
- 倉庫3拠点: 東京（WH-TOKYO, 出荷70%）、大阪（WH-OSAKA, 20%）、福岡（WH-FUKUOKA, 10%）
- 約5,000 SKU（生豆、焙煎済み豆、ブレンド、ドリップバッグ、資材）
- 朝6:00〜9:00にカフェチェーン向け出荷ラッシュが発生

### 検証で再現するシナリオ

> 朝7時。カフェチェーン向けの出荷ラッシュが始まる。
> 東京本社倉庫から数十店舗分の焙煎豆が一斉に出庫される（書き込み集中）。
> 同じ頃、仕入れ担当が「エチオピア イルガチェフェ G1 の在庫は？」と在庫照会する。
> → 悪い設計だと返ってこない。良い設計だと即座に返る。

---

## 機能要件

### 1. DynamoDB テーブル（2パターン）

同じデータを2つの異なるキー設計で保持する。

#### テーブルA: 悪い設計（ホットスポットが発生する）

```
テーブル名: kiro-roasters-inventory-bad
キャパシティ: プロビジョンド 100 RCU / 100 WCU

PK: warehouseId (String)   例: "WH-TOKYO"
SK: itemId (String)         例: "ITEM#ETH-YIRG-G1-MEDIUM-200G"

属性:
- quantity (Number): 在庫数
- lotNumber (String): ロット番号
- lastUpdated (String): ISO 8601 日時
- location (String): 棚番号
- unitPrice (Number): 単価（円）
- itemName (String): 商品名（表示用）
```

#### テーブルB: 良い設計（分散される）

```
テーブル名: kiro-roasters-inventory-good
キャパシティ: プロビジョンド 100 RCU / 100 WCU

PK: itemId (String)         例: "ITEM#ETH-YIRG-G1-MEDIUM-200G"
SK: warehouseId (String)    例: "WH-TOKYO"

属性: テーブルAと同じ

GSI:
  名前: byWarehouse
  GSI-PK: warehouseId (String)
  GSI-SK: itemId (String)
  射影: ALL
```

#### 初期データ

- 5,000 SKU × 3倉庫 = 15,000 レコード
- 初期データ生成スクリプトを用意する（シードデータ）
- 商品名はコーヒー関連の命名規則に従う

### 2. API（Lambda 関数）

#### 2.1 在庫照会 API（GET）

```
エンドポイント: GET /inventory/{warehouseId}/{itemId}
パラメータ:
  - warehouseId: 倉庫ID（パスパラメータ）
  - itemId: 商品ID（パスパラメータ）
  - table: "bad" | "good"（クエリパラメータ。どちらのテーブルに問い合わせるか）

レスポンス:
{
  "warehouseId": "WH-TOKYO",
  "itemId": "ITEM#ETH-YIRG-G1-MEDIUM-200G",
  "itemName": "エチオピア イルガチェフェ G1 ミディアム 200g",
  "quantity": 340,
  "lotNumber": "LOT#2026-05-20-003",
  "location": "A-03-02",
  "unitPrice": 1800,
  "lastUpdated": "2026-05-26T06:45:00Z"
}

要件:
- ConsistentRead: true（強い一貫性読み取り）
- X-Ray トレーシング有効
- エラー時は DynamoDB のスロットリングエラーをそのまま返す（リトライはSDKデフォルトに任せる）
```

#### 2.2 出庫処理 API（POST）

```
エンドポイント: POST /inventory/ship
ボディ:
{
  "warehouseId": "WH-TOKYO",
  "itemId": "ITEM#ETH-YIRG-G1-MEDIUM-200G",
  "quantity": 5,
  "table": "bad" | "good"
}

処理:
- 在庫数を減算（UpdateItem, quantity = quantity - :qty）
- ConditionExpression で在庫数 >= 出庫数を保証
- lastUpdated を更新

要件:
- X-Ray トレーシング有効
- エラー時はスロットリングエラーを返す
```

#### 2.3 負荷生成 API（POST）— 出荷ラッシュのシミュレーション

```
エンドポイント: POST /load-test/start
ボディ:
{
  "table": "bad" | "good",
  "durationSeconds": 180,
  "requestsPerSecond": 100,
  "warehouseDistribution": {
    "WH-TOKYO": 0.7,
    "WH-OSAKA": 0.2,
    "WH-FUKUOKA": 0.1
  }
}

処理:
- 指定された秒数・レートで出庫処理を連続実行
- Step Functions の Map ステート or Lambda の再帰呼び出しで実現
- 倉庫の比率に従ってリクエストを分配

レスポンス:
{
  "executionId": "xxx",
  "status": "STARTED"
}
```

#### 2.4 負荷生成ステータス確認 API（GET）

```
エンドポイント: GET /load-test/status/{executionId}

レスポンス:
{
  "executionId": "xxx",
  "status": "RUNNING" | "COMPLETED" | "FAILED",
  "totalRequests": 18000,
  "successCount": 17500,
  "throttleCount": 500,
  "elapsedSeconds": 120
}
```

### 3. 初期データ生成（シードスクリプト）

```
コマンド: npx ampx sandbox seed（またはカスタムスクリプト）

生成するデータ:
- 5,000 SKU の商品データ
  - 生豆: 8産地 × 2品種 × 2グレード = 32
  - 焙煎済み: 32 × 6焙煎度 × 5容量 = 960
  - ブレンド: 50 × 6焙煎度 × 5容量 = 1,500
  - ドリップバッグ等: 500
  - 資材: 2,008（合計5,000になるよう調整）
- 各SKU × 3倉庫 = 15,000 在庫レコード
- 在庫数はランダム（10〜1000）
- 両テーブル（bad / good）に同じデータを投入
```

---

## 非機能要件

### モニタリング・可観測性

- **X-Ray**: 全 Lambda 関数でトレーシング有効。DynamoDB 呼び出しのリトライが可視化されること
- **CloudWatch メトリクス**: DynamoDB の WriteThrottleEvents, ReadThrottleEvents, ConsumedWriteCapacityUnits, SuccessfulRequestLatency を確認可能にする
- **DynamoDB Contributor Insights**: 両テーブルで有効化。ホットキーの検出を確認する
- **CloudWatch Logs**: Lambda のログに DynamoDB のスロットリングエラーが記録されること

### パフォーマンス要件（検証の期待値）

| 指標 | 悪い設計（期待） | 良い設計（期待） |
|------|----------------|----------------|
| 在庫照会 P50 レイテンシ | 200ms〜 | 5〜10ms |
| 在庫照会 P99 レイテンシ | 数秒〜タイムアウト | 20〜50ms |
| 在庫照会 エラー率 | 5〜20% | 0% |
| 出庫処理 スロットリング率 | 高い | ほぼ0% |

### セキュリティ

- API は認証なし（検証用途のため）。ただし IAM 認証 or API キーで最低限の保護
- テーブルへのアクセスは Lambda の実行ロール経由のみ

### コスト管理

- 検証が終わったらリソースを削除できること（`npx ampx sandbox delete`）
- プロビジョンドモード 100 RCU/WCU は検証中のみ。放置しても月額数ドル程度
- 負荷テストの実行時間は合計30分以内を想定

---

## 技術構成

### Amplify Gen2 構成

```
amplify/
├── backend.ts
├── data/
│   └── resource.ts          # DynamoDB テーブル定義（CDK で直接定義）
├── functions/
│   ├── inventory-query/     # 在庫照会 Lambda
│   │   └── handler.ts
│   ├── inventory-ship/      # 出庫処理 Lambda
│   │   └── handler.ts
│   ├── load-test-start/     # 負荷生成開始 Lambda
│   │   └── handler.ts
│   ├── load-test-status/    # 負荷生成ステータス Lambda
│   │   └── handler.ts
│   └── seed/                # 初期データ投入 Lambda
│       └── handler.ts
└── custom/
    └── step-functions.ts    # 負荷生成用 Step Functions（オプション）
```

### 使用する AWS サービス

| サービス | 用途 |
|---------|------|
| DynamoDB | 在庫テーブル（bad / good の2テーブル） |
| Lambda (Node.js 20.x) | API ハンドラー、負荷生成、シード |
| API Gateway (REST) | HTTP エンドポイント |
| X-Ray | トレーシング |
| CloudWatch | メトリクス、ログ |
| Step Functions（オプション） | 負荷生成のオーケストレーション |
| Amplify Gen2 | インフラ定義、デプロイ |

### ランタイム・言語

- Lambda: TypeScript (Node.js 20.x)
- AWS SDK: @aws-sdk/client-dynamodb, @aws-sdk/lib-dynamodb (v3)
- IaC: Amplify Gen2 (CDK ベース)

---

## 負荷テスト（k6）

プロジェクト外から実行する。API エンドポイントに対して HTTP リクエストを投げる。

### テストシナリオ

```
1. 負荷生成APIを呼び出して出荷ラッシュを開始（バックグラウンド書き込み）
2. 30秒待機（ホットスポットが形成されるのを待つ）
3. 在庫照会APIに段階的に負荷をかける:
   - Phase 1: 10 req/s × 30秒
   - Phase 2: 30 req/s × 60秒
   - Phase 3: 100 req/s × 60秒
   - Phase 4: 200 req/s × 30秒
4. 悪い設計テーブル / 良い設計テーブルで同じテストを実行し比較
```

### k6 スクリプト（プロジェクト内に配置）

```
load-test/
├── scenarios/
│   ├── inventory-query-bad.js    # 悪い設計テーブルへの在庫照会
│   └── inventory-query-good.js   # 良い設計テーブルへの在庫照会
├── helpers/
│   └── data.js                   # テスト用の warehouseId / itemId リスト
└── README.md                     # 実行手順
```

---

## 成果物（検証後に得たいもの）

1. **CloudWatch メトリクスのスクリーンショット**: WriteThrottleEvents, ReadThrottleEvents の比較
2. **X-Ray トレースのスクリーンショット**: 正常時 vs リトライ地獄の比較
3. **Contributor Insights のスクリーンショット**: WH-TOKYO がホットキーとして検出される画面
4. **k6 の結果サマリー**: P50/P95/P99 レイテンシ、エラー率の比較表
5. **考察**: なぜこの差が出るのか、どう設計すべきかの結論

---

## 制約・前提

- Amplify Gen2 の sandbox 環境で検証する（本番デプロイは不要）
- DynamoDB のプロビジョンドキャパシティは意図的に低く設定する（ホットスポットを顕在化させるため）
- 検証完了後はリソースを削除する

---

## 参考資料

- [Kiro Roasters 架空企業設定](./kiro-roasters-background.md)
- [ホットスポット検証リサーチ](./serverless-manufacturing-dynamodb-hotspot.md)
- [AWS公式: パーティションキーの設計ベストプラクティス](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html)
- [AWS Database Blog: Scaling DynamoDB](https://aws.amazon.com/blogs/database/part-1-scaling-dynamodb-how-partitions-hot-keys-and-split-for-heat-impact-performance)
