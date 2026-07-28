# オブザーバビリティ（Observability）

本プロジェクトの AWS リソースにおけるトレーシング・メトリクス・ログの構成をまとめます。

---

## 1. AWS X-Ray トレーシング

### Lambda 関数

全 Lambda 関数で X-Ray アクティブトレーシングが有効です。

- `amplify/custom/lambda-functions.ts` の `commonProps` に `tracing: lambda.Tracing.ACTIVE` を設定
- 対象関数: inventory-query, inventory-ship, load-test-start, load-test-status, seed

### API Gateway

REST API で X-Ray トレーシングが有効です。

- `amplify/custom/api-gateway.ts` の `deployOptions` に `tracingEnabled: true` を設定
- リクエストの全経路（API Gateway → Lambda → DynamoDB）をサービスマップで可視化可能

### 確認方法

1. AWS コンソール → **X-Ray** → **サービスマップ** でリクエストフローを確認
2. **トレース** タブで個別リクエストのレイテンシ内訳を確認
3. Lambda 関数から DynamoDB への呼び出しがサブセグメントとして表示される

---

## 2. DynamoDB CloudWatch メトリクス

### 自動発行メトリクス

DynamoDB テーブルは作成時に以下のメトリクスを CloudWatch へ自動発行します（追加設定不要）:

| メトリクス | 説明 | ホットスポット検証での用途 |
|---|---|---|
| `WriteThrottleEvents` | 書き込みスロットリング発生回数 | Bad_Table vs Good_Table の比較 |
| `ReadThrottleEvents` | 読み込みスロットリング発生回数 | 読み込み負荷の影響確認 |
| `ConsumedWriteCapacityUnits` | 消費された書き込みキャパシティ | パーティション偏りの確認 |
| `SuccessfulRequestLatency` | 成功リクエストのレイテンシ | スロットリング時のレイテンシ増加確認 |

### Contributor Insights

両比較テーブルで Contributor Insights が有効です:

- `amplify/custom/dynamodb-tables.ts` の `badTable` と `goodTable` に `contributorInsightsEnabled: true` を設定
- パーティションキーごとのアクセス頻度を Top-N で可視化
- Bad_Table で東京倉庫（`WH-TOKYO`）への集中が確認可能

### 確認方法

1. AWS コンソール → **CloudWatch** → **メトリクス** → **DynamoDB** → テーブル名でフィルタ
2. `WriteThrottleEvents` を Bad_Table / Good_Table で並べてグラフ化
3. AWS コンソール → **DynamoDB** → テーブル選択 → **モニター** タブ → **Contributor Insights** で Top パーティションキーを確認

---

## 3. CloudWatch Logs

### Lambda エラーログ

全 Lambda 関数は自動的に CloudWatch Logs にログを出力します:

- ロググループ: `/aws/lambda/{関数名}` （例: `/aws/lambda/kiro-inventory-query`）
- スロットリングエラー発生時:
  - `inventory-query`: `ProvisionedThroughputExceededException` を検出し、テーブル名を含む構造化エラーレスポンスを返却
  - `inventory-ship`: DynamoDB エラーの `name`、`message`、HTTP ステータスコードをレスポンスに含めて返却
  - 一般エラー: `console.error()` でスタックトレースを CloudWatch Logs に記録

### 確認方法

1. AWS コンソール → **CloudWatch** → **ロググループ** → `/aws/lambda/kiro-inventory-query` を選択
2. **ログのインサイト** で以下のクエリを実行:
   ```
   fields @timestamp, @message
   | filter @message like /THROTTLED|ProvisionedThroughputExceeded/
   | sort @timestamp desc
   | limit 50
   ```
3. スロットリング発生タイミングと頻度を確認

---

## 4. 負荷テスト時の監視手順

1. **テスト前**: CloudWatch ダッシュボードで基準値を確認
2. **テスト中**: X-Ray サービスマップでリアルタイムのエラー率を監視
3. **テスト後**: 以下を比較
   - Bad_Table の `WriteThrottleEvents` カウント
   - Good_Table の `WriteThrottleEvents` カウント（≈ 0 を期待）
   - Contributor Insights で Top パーティションキーの偏り確認
