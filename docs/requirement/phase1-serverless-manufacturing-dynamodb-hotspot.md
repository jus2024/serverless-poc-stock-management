# 製造業の業務システム × サーバーレス × DynamoDB ホットスポット問題 リサーチ

## 記事コンセプト

- **テーマ**: 製造メーカーの業務システムをサーバーレスで構築する際、DynamoDB のキー設計が甘いとホットスポットが発生しパフォーマンスが劣化する問題を実検証する
- **3軸との関連**: AWS関連 ✓ / サーバーレス ✓ / 生成AI活用（Kiro）は補助的に活用可能
- **想定読者**: 製造業のシステム担当者、サーバーレスアーキテクチャに興味があるエンジニア、DynamoDB の設計に悩んでいる人

---

## 1. 背景: 製造業の業務システムとサーバーレス

### 製造業の業務システムの特徴

- **MES（製造実行システム）**: 生産指示、進捗管理、品質管理、在庫管理
- **典型的なデータ**: 製造オーダー、ロット番号、工程実績、検査結果、在庫移動
- **アクセスパターン**: 特定の製造ラインや日付に集中しやすい（＝ホットスポットの温床）

### サーバーレスで業務システムを構築する利点

- サーバー運用からの脱却（LIXIL の物流会計システム事例あり）
- 需要変動への自動スケーリング
- 開発生産性の向上
- コスト最適化（使った分だけ課金）

### サーバーレスの課題（DB接続がボトルネック）

| 課題 | RDS の場合 | DynamoDB の場合 |
|------|-----------|----------------|
| コネクション管理 | Lambda のコールドスタートごとに接続確立が必要。RDS Proxy で緩和可能だがコスト増 | コネクションレス。HTTP API なので問題なし |
| スケーリング | RDS のコネクション上限がボトルネック | パーティション設計が甘いとホットスポットに |
| コスト | 常時起動のDBインスタンス費用 | オンデマンドなら使った分だけ |
| 一貫性 | 強い一貫性（ACID） | 結果整合性（デフォルト）。強い一貫性も選択可 |

**結論**: 真にサーバーレスなら DynamoDB が最適だが、キー設計が命。

---

## 2. DynamoDB ホットスポット（ホットパーティション）問題

### ホットパーティションとは

- DynamoDB はパーティションキーのハッシュ値でデータを物理パーティションに分散
- 各パーティションの上限: **3,000 RCU/秒 + 1,000 WCU/秒**
- 特定のパーティションキーにアクセスが集中すると、テーブル全体のキャパシティに余裕があってもスロットリングが発生

### 症状

1. テーブルのプロビジョンドキャパシティの30%程度でスロットリングが発生
2. CloudWatch のメトリクスがスパイク状に
3. 特定のオペレーションだけ失敗する
4. `ProvisionedThroughputExceededException` エラー

### 製造業で起きやすいホットスポットのパターン

| パターン | 悪い例 | なぜ問題か |
|---------|--------|-----------|
| 日付ベースのPK | `PK = "2026-05-26"` | 当日のデータに全書き込みが集中 |
| ステータスベースのPK | `PK = "IN_PROGRESS"` | 進行中の製造オーダーが1パーティションに集中 |
| ラインIDのみのPK | `PK = "LINE-A"` | 稼働率の高いラインに集中 |
| 集計カウンター | `PK = "DAILY_COUNT"` | 全ラインからの書き込みが1キーに集中 |

### Adaptive Capacity（2018年〜）

- AWS が自動的にホットパーティションのスループットを引き上げる機能
- **ただし万能ではない**: 持続的な偏りには対応しきれない
- バースト的なアクセスには有効だが、設計の根本的な問題は解決しない

---

## 3. 解決策: キー設計のベストプラクティス

### 3.1 高カーディナリティのパーティションキー

```
# 良い例: 製造オーダーID（ユニーク）
PK = "ORDER#MO-2026-05-26-001"
SK = "PROCESS#010"

# 悪い例: 日付のみ
PK = "2026-05-26"
SK = "ORDER#001"
```

### 3.2 Write Sharding（書き込みシャーディング）

パーティションキーにランダムまたは計算されたサフィックスを付与して分散。

**ランダムサフィックス方式:**
```javascript
const SHARD_COUNT = 10;
function getShardedKey(baseKey) {
  const shard = Math.floor(Math.random() * SHARD_COUNT);
  return `${baseKey}#${shard}`;
}
// "DAILY_COUNT#3", "DAILY_COUNT#7" のように分散
```

- メリット: 書き込みが均等に分散
- デメリット: 読み取り時に全シャードを集約する必要あり

**計算サフィックス方式:**
```javascript
// ラインIDのハッシュでシャードを決定
function getCalculatedShard(lineId) {
  const hash = lineId.charCodeAt(0) % SHARD_COUNT;
  return `PRODUCTION#${hash}`;
}
```

- メリット: 読み取り時にシャードを特定可能
- デメリット: 偏りが完全には解消されない場合あり

### 3.3 時間バケッティング

```javascript
// 1時間ごとにバケットを分ける
function getTimeBucket() {
  const now = new Date();
  return now.toISOString().slice(0, 13); // "2026-05-26T14"
}

// PK = "LINE-A#2026-05-26T14"
```

### 3.4 GSI レプリカパターン

- 読み取り負荷を分散するために、同じキー構造の GSI を作成
- 読み取りの一部を GSI に振り分けることで、プライマリテーブルの負荷を軽減

### 3.5 DAX（DynamoDB Accelerator）によるキャッシュ

- 読み取りヘビーなワークロードに有効
- ただし、書き込みが集中するホットパーティションには効果が限定的
- DAX 自体がボトルネックになる可能性もある（キャッシュ無効化のオーバーヘッド）

---

## 4. 実検証の計画

> 架空企業の詳細設定は [kiro-roasters-background.md](./kiro-roasters-background.md) を参照

### メインシナリオ: Kiro Roasters の在庫管理システム

架空のコーヒー焙煎メーカー「Kiro Roasters（キロ ロースターズ）」の在庫管理を題材にする。

**会社概要:**
- スペシャルティコーヒーの焙煎メーカー（生豆仕入れ → 自社焙煎 → カフェ/EC販売）
- 倉庫3拠点（東京70% / 大阪20% / 福岡10%）
- 約5,000 SKU（生豆、焙煎済み豆、ブレンド、ドリップバッグ、資材）

**ストーリー:**
> 朝7時。カフェチェーン向けの出荷ラッシュが始まる。
> 東京本社倉庫（WH-TOKYO）から数十店舗分の焙煎豆が一斉に出庫される。
>
> 同じ頃、仕入れ担当が在庫照会画面を開く。
> 「エチオピア イルガチェフェ G1 の在庫あとどれくらい？」
>
> ...返ってこない。
>
> 出荷ラッシュの書き込みが WH-TOKYO のパーティションを詰まらせていて、
> 同じパーティションへの読み取り（在庫照会）が巻き添えを食っている。

**検証構成:**
```
┌─────────────────────────────────────────────────────────┐
│ バックグラウンド: 朝の出荷ラッシュ（書き込み負荷）        │
│                                                         │
│  Lambda (出庫処理)  ──┐                                  │
│  Lambda (出庫処理)  ──┼──→ DynamoDB (在庫テーブル)       │
│  Lambda (出庫処理)  ──┘         ↑                       │
│    ※ WH-TOKYO から数十店舗分     │                       │
│                                  │                       │
│ フォアグラウンド: 仕入れ担当の在庫照会 ★計測対象         │
│                                  │                       │
│  k6 → API GW → Lambda (在庫照会) ──┘                    │
│    「エチオピア G1 の在庫は？」                           │
└─────────────────────────────────────────────────────────┘
```

### テーブル設計: 悪い例 vs 良い例

#### 悪い設計（ホットスポットが発生する）

```
テーブル名: kiro-roasters-inventory-bad

PK: WAREHOUSE_ID    （例: "WH-TOKYO"）
SK: ITEM_ID         （例: "ITEM#ETH-YIRG-G1-MEDIUM-200G"）

属性:
- quantity: 在庫数
- lot_number: ロット番号（例: "LOT#2026-05-26-001"）
- last_updated: 最終更新日時
- location: 棚番号（例: "A-03-02"）
- unit_price: 単価
```

**問題点:**
- 倉庫が3拠点しかない → カーディナリティが極端に低い
- 東京倉庫が出荷の70%を担う → WH-TOKYO に書き込みが集中
- 朝の出荷ラッシュ時、WH-TOKYO パーティションが 1,000 WCU の壁に当たる
- 同じパーティションへの在庫照会（読み取り）も巻き添えでスロットリング

#### 良い設計（分散される）

```
テーブル名: kiro-roasters-inventory-good

PK: ITEM_ID         （例: "ITEM#ETH-YIRG-G1-MEDIUM-200G"）
SK: WAREHOUSE_ID    （例: "WH-TOKYO"）

属性:
- quantity: 在庫数
- lot_number: ロット番号
- last_updated: 最終更新日時
- location: 棚番号
- unit_price: 単価

GSI (倉庫別照会用):
  GSI-PK: WAREHOUSE_ID
  GSI-SK: ITEM_ID
```

**改善点:**
- アイテムIDは約5,000種類 → 高カーディナリティ
- 出荷ラッシュの書き込みが多数のパーティションに自然に分散
- 「エチオピア G1 の在庫は？」→ GetItem で即座に取得
- 「東京倉庫の在庫一覧」→ GSI で Query（読み取り負荷はGSI側に分離）

### 検証の流れ

#### Step 1: テーブル作成 & 初期データ投入

- 悪い設計テーブル / 良い設計テーブルを作成
- 初期在庫データ: 5,000 SKU × 3倉庫 = 15,000レコード
- プロビジョンドモード: 100 RCU / 100 WCU（意図的に低めに設定してホットスポットを顕在化）

**サンプルデータ:**
```json
{
  "PK": "WH-TOKYO",
  "SK": "ITEM#ETH-YIRG-G1-MEDIUM-200G",
  "quantity": 340,
  "lot_number": "LOT#2026-05-20-003",
  "last_updated": "2026-05-26T06:45:00Z",
  "location": "A-03-02",
  "unit_price": 1800
}
```

#### Step 2: バックグラウンド負荷（朝の出荷ラッシュ）を開始

出庫処理 Lambda を Step Functions の Map ステートで並列実行。

```javascript
// 出庫処理のイメージ
async function processShipment(warehouseId, itemId, quantity) {
  const params = {
    TableName: TABLE_NAME,
    Key: { PK: warehouseId, SK: itemId },  // 悪い設計の場合
    UpdateExpression: 'SET quantity = quantity - :qty, last_updated = :now',
    ConditionExpression: 'quantity >= :qty',
    ExpressionAttributeValues: {
      ':qty': quantity,
      ':now': new Date().toISOString()
    }
  };
  await dynamodb.update(params).promise();
}
```

**負荷パターン（出荷ラッシュ再現）:**
- 東京倉庫: 毎秒100件の出庫処理（カフェ30店舗 × 3〜4アイテム）
- 大阪倉庫: 毎秒30件
- 福岡倉庫: 毎秒10件
- → 悪い設計: WH-TOKYO に 100 writes/s が集中（1パーティションの上限に迫る）
- → 良い設計: 5,000アイテムに分散（各パーティション 0.数 writes/s）

#### Step 3: フォアグラウンド（在庫照会API）に負荷テスト実行

出荷ラッシュが走っている状態で、在庫照会 API に k6 でリクエストを投げる。

```javascript
// 在庫照会 Lambda のイメージ
async function getInventory(warehouseId, itemId) {
  const params = {
    TableName: TABLE_NAME,
    Key: { PK: warehouseId, SK: itemId },  // 悪い設計の場合
    ConsistentRead: true  // 在庫数は正確な値が必要
  };
  return await dynamodb.get(params).promise();
}
```

**負荷パターン（在庫照会）:**
```
Phase 1: ウォームアップ     10 req/s × 30秒（担当者1〜2人が照会）
Phase 2: 通常負荷          30 req/s × 60秒（複数担当者が朝の欠品チェック）
Phase 3: ピーク負荷        100 req/s × 60秒（棚卸し想定の一斉照会）
Phase 4: バースト          200 req/s × 30秒（EC在庫連携バッチ）
```

#### Step 4: 結果収集 & 比較

### 比較ポイント

| 観点 | 悪い設計（WH-TOKYO に集中） | 良い設計（ITEM_ID で分散） |
|------|---------------------------|--------------------------|
| 在庫照会 レスポンスタイム P50 | 数百ms（リトライ込み） | 5〜10ms |
| 在庫照会 レスポンスタイム P99 | 数秒〜タイムアウト | 20〜50ms |
| 在庫照会 エラー率 | 5〜20%（スロットリング） | 0% |
| X-Ray トレース | DynamoDB GetItem に3回リトライ | 1回で成功 |
| ユーザー体験 | 「エチオピアの在庫確認したいのに画面が固まる」 | 即座に表示 |
| 出庫処理の成功率 | スロットリングで一部出荷失敗 | 全件成功 |

### X-Ray で見せたいこと

1. **正常時のトレース（良い設計）**: API GW → Lambda → DynamoDB GetItem（1回、5ms）
   - 「ITEM#ETH-YIRG-G1-MEDIUM-200G」を即座に取得
2. **ホットスポット時のトレース（悪い設計）**: API GW → Lambda → DynamoDB GetItem（リトライ3回、合計800ms）
   - 「WH-TOKYO」パーティションが詰まっていてリトライが走る
3. **タイムアウト時のトレース（悪い設計・高負荷時）**: API GW → Lambda → DynamoDB GetItem（リトライ上限到達、Lambda タイムアウト）
   - 仕入れ担当が「システム落ちた？」と思う瞬間

これにより「なぜ在庫照会が遅いのか」「なぜ読み取りなのにエラーになるのか」の原因が一目瞭然になる。

### 検証環境

- **テーブル設定**: プロビジョンドモード 100 RCU / 100 WCU（ホットスポット再現用）+ オンデマンドモード（Adaptive Capacity 挙動確認用）
- **API**: API Gateway REST API + Lambda (Node.js)
- **負荷生成**:
  - バックグラウンド（入出庫）: Lambda + Step Functions で並列書き込み
  - フォアグラウンド（在庫照会）: k6 で HTTP 負荷テスト
- **モニタリング**: CloudWatch メトリクス + Contributor Insights + X-Ray
- **データ量**: 15,000レコード（5,000アイテム × 3倉庫）

### 検証で確認するメトリクス

**DynamoDB レベル:**
- WriteThrottleEvents / ReadThrottleEvents
- ConsumedWriteCapacityUnits / ConsumedReadCapacityUnits の分布
- SuccessfulRequestLatency（P50/P99）
- ThrottledRequests
- Contributor Insights のホットキー検出

**API レベル（在庫照会API）:**
- API Gateway: Latency, IntegrationLatency, 4XXError, 5XXError
- Lambda: Duration, Errors, Throttles, ConcurrentExecutions
- X-Ray: エンドツーエンドのレイテンシ分布、DynamoDB 呼び出しのリトライ回数

**k6 側:**
- http_req_duration（P50/P95/P99）
- http_req_failed（エラー率）
- http_reqs（スループット）
- iterations（成功リクエスト数）

### 使用ツール

- AWS SDK v3 (JavaScript/TypeScript)
- API Gateway + Lambda (Node.js 20.x)
- AWS SAM or CDK（インフラ構築）
- CloudWatch + X-Ray
- DynamoDB Contributor Insights
- k6（HTTP 負荷テスト）
- Step Functions（バックグラウンド負荷生成）

---

## 5. 記事構成案

### タイトル案

- 「【DynamoDB × サーバーレス】在庫照会が返ってこない！コーヒー焙煎メーカーで起きたホットスポット問題を実検証」
- 「DynamoDB のキー設計ミスで在庫システムが止まる — Kiro Roasters の在庫管理で検証してみた」
- 「朝の出荷ラッシュで在庫照会が固まる？DynamoDB ホットスポットをサーバーレス在庫管理で実検証」

### 構成（パターンB: ストレート型）

```
# はじめに
- 製造業 × サーバーレスの可能性
- DB接続がボトルネック → DynamoDB なら解決？
- でもキー設計を間違えると「在庫照会が返ってこない」が起きる
- 今回は架空のコーヒー焙煎メーカー「Kiro Roasters」の在庫管理で実検証

# Kiro Roasters の在庫管理
- 会社概要（スペシャルティコーヒー焙煎メーカー）
- 倉庫3拠点、約5,000 SKU
- 朝の出荷ラッシュ（カフェチェーン向け）が書き込みのピーク
- 同時に仕入れ担当が在庫照会 → ここが問題になる

# DynamoDB ホットスポットとは
- パーティションの仕組み（図解）
- 各パーティションの上限（3,000 RCU / 1,000 WCU）
- 書き込みのホットスポットが読み取りにも波及する理由

# 検証環境
- アーキテクチャ図
  - バックグラウンド: 出荷ラッシュ Lambda（WH-TOKYO への書き込み集中）
  - フォアグラウンド: 在庫照会 API（API GW → Lambda → DynamoDB）
- テーブル設計
  - 悪い例: PK = WAREHOUSE_ID（"WH-TOKYO" に全部集中）
  - 良い例: PK = ITEM_ID（"ITEM#ETH-YIRG-G1-MEDIUM-200G" で分散）
- 負荷テストツール: k6

# 検証実行 & 結果
## 悪い設計: 倉庫IDをPKにした場合
- 出荷ラッシュで WH-TOKYO パーティションがパンク
- 「エチオピア G1 の在庫は？」が返ってこない
- X-Ray: GetItem に3回リトライしている様子
- Contributor Insights: WH-TOKYO がホットキーとして検出

## 良い設計: アイテムIDをPKにした場合
- 出荷ラッシュでも5,000パーティションに分散
- 在庫照会は安定（P99: 20〜50ms）
- X-Ray: 1回で成功、クリーンなトレース

# 数字で見る体感差
- レスポンスタイム比較表（P50/P95/P99）
- エラー率の時系列グラフ
- X-Ray トレース比較（正常 vs リトライ地獄）
- 「仕入れ担当がシステム落ちたと思う瞬間」を数値で示す

# なぜこうなるのか（解説）
- パーティション内の RCU/WCU は共有リソース
- 出荷ラッシュの書き込みが詰まると在庫照会も巻き添え
- Adaptive Capacity の限界

# 対策: キー設計のベストプラクティス
- 高カーディナリティのPKを選ぶ（アイテムID）
- 倉庫別照会は GSI で対応
- 超人気商品（定番ブレンド等）には Write Sharding
- チェックリスト

# まとめ
- キー設計ミスは「在庫が見れない」= 出荷判断ができない = 業務停止
- DynamoDB は正しく設計すれば製造業でも十分使える
- 次回予告（シングルテーブルデザイン編 or イベント駆動在庫集計編）
```

### 記事の差別化ポイント

既存の DynamoDB ホットスポット記事との差別化:

1. **製造業の在庫管理に特化**: 「倉庫で入出庫が動いている最中に在庫照会が返ってこない」という具体的で共感しやすいストーリー
2. **書き込みが読み取りを巻き込む**: 単なる書き込みスロットリングではなく、読み取り側への波及を実証
3. **X-Ray によるリトライ可視化**: 「なぜ遅いのか」が一目瞭然。SDK 内部の挙動が見える
4. **エンドツーエンド検証**: DynamoDB 単体ではなく API Gateway → Lambda → DynamoDB で実際のユーザー体験を再現
5. **対策が明確**: 悪い設計 → 良い設計の Before/After が具体的

---

## 6. 参考リソース

- [AWS公式: パーティションキーの設計ベストプラクティス](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html)
- [AWS公式: Write Sharding](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-sharding.html)
- [AWS Database Blog: Scaling DynamoDB - How partitions, hot keys, and split for heat impact performance](https://aws.amazon.com/blogs/database/part-1-scaling-dynamodb-how-partitions-hot-keys-and-split-for-heat-impact-performance)
- [Serverless Life: DynamoDB Design Patterns for Single Table Design](https://www.serverlesslife.com/DynamoDB_Design_Patterns_for_Single_Table_Design.html)
- [Alex DeBrie: Everything you need to know about DynamoDB Partitions](https://www.alexdebrie.com/posts/dynamodb-partitions)
- [AWS資料: サーバーレスアプリケーション向きのDB設計ベストプラクティス（PDF）](https://pages.awscloud.com/rs/112-TZM-766/images/20190905_イチから理解するサーバーレスアプリ開発-サーバーレスアプリケーション向きのDB設計ベストプラクティス.pdf)
- [Qiita: DynamoDBの設計でベストプラクティスを実践してみた](https://qiita.com/codemountains/items/a2c9654fd6eccede36ba)
- [LIXIL × Serverless Operations: フルサーバーレスで物流会計システムを構築](https://serverless.co.jp/works/024)
- [GitHub: amazon-dynamodb-tools](https://github.com/awslabs/amazon-dynamodb-tools)
- [OneUptime: How to Handle DynamoDB Hot Partitions](https://oneuptime.com/blog/post/2026-02-12-dynamodb-hot-partitions/view)

---

## 7. 次のステップ

1. [ ] 検証用の DynamoDB テーブル設計（良い例・悪い例）
2. [ ] 負荷生成スクリプトの作成（Lambda or ローカル Python）
3. [ ] 検証実行 & CloudWatch メトリクス収集
4. [ ] 結果のスクリーンショット取得
5. [ ] 記事本体の執筆
