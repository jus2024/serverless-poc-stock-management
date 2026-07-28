# EC2 負荷生成ツール (Load Generator)

EC2 インスタンスから DynamoDB テーブルへ高 RPS の書き込み負荷を生成し、ホットパーティションによるスロットリングを再現するツールです。

Bad Table（`warehouseId` が PK）では `WH-TOKYO` パーティションに書き込みを集中させ、単一パーティションの WCU 上限（1,000 WCU/秒）を超過させます。負荷投入中にブラウザから在庫操作を行い、オンライン操作への影響を体感できます。

## 前提条件

- **Amplify sandbox が稼働中**であること（DynamoDB テーブル `kiro-roasters-inventory-bad` / `kiro-roasters-inventory-good` が存在すること）
- **Python 3.12+**
- **AWS CDK CLI** (`npm install -g aws-cdk`)
- **AWS CLI**（SSM Session Manager plugin インストール済み）
- **適切な AWS 認証情報**（EC2 作成権限、DynamoDB アクセス権限）

## デプロイ手順

```bash
cd load-generator/cdk

# Python 仮想環境のセットアップ
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# CDK デプロイ
npx cdk deploy
```

カスタムテーブル名を指定する場合:

```bash
npx cdk@latest deploy -c badTable=kiro-roasters-inventory-bad -c goodTable=kiro-roasters-inventory-good
```

デプロイ完了後、CDK Output にインスタンス ID が表示されます。

## SSM 接続 → スクリプト実行手順

```bash
# CDK Output に表示されたインスタンス ID を使用
aws ssm start-session --target <instance-id> --region us-west-2

# EC2 インスタンス上で実行:
cd /opt/load-test
python3.12 load_test.py \
  --table kiro-roasters-inventory-bad \
  --table-type bad \
  --rps 3000 \
  --duration 120 \
  --tokyo-ratio 0.8
```

## スクリプトパラメータ

| 引数 | デフォルト | 説明 |
|------|-----------|------|
| `--table` | (必須) | テーブル名 |
| `--table-type` | `bad` | `bad` or `good`（キースキーマ選択） |
| `--rps` | 1500 | 目標リクエスト/秒 |
| `--duration` | 120 | 継続秒数 |
| `--tokyo-ratio` | 0.7 | WH-TOKYO への集中率 |
| `--threads` | 100 | スレッド数 |
| `--region` | us-west-2 | AWS リージョン |
| `--no-retry` | false | SDK リトライ無効化 |

## 実験シナリオ（3 ラウンド）

### Round 1: Bad Table + No Retry

スロットリングエラーが直接呼び出し元に返される状態を確認します。リトライなしのため、エラーが即座に可視化されます。

```bash
python3.12 /opt/load-test/load_test.py \
  --table kiro-roasters-inventory-bad \
  --table-type bad \
  --rps 3000 \
  --duration 120 \
  --tokyo-ratio 0.8 \
  --no-retry
```

**期待される結果**: 高いスロットル率（8〜15%）、低レイテンシ（リトライ待ちがないため）

### Round 2: Bad Table + Retry（デフォルト）

SDK リトライがスロットリングを隠蔽するが、レイテンシが増大する状態を確認します。

```bash
python3.12 /opt/load-test/load_test.py \
  --table kiro-roasters-inventory-bad \
  --table-type bad \
  --rps 3000 \
  --duration 120 \
  --tokyo-ratio 0.8
```

**期待される結果**: 低いスロットル率（リトライで吸収）、高レイテンシ（p95/p99 が大幅に増加）

### Round 3: Good Table + Retry

分散キー設計によりホットパーティションが発生しない状態を確認します。

```bash
python3.12 /opt/load-test/load_test.py \
  --table kiro-roasters-inventory-good \
  --table-type good \
  --rps 3000 \
  --duration 120 \
  --tokyo-ratio 0.8
```

**期待される結果**: スロットルほぼゼロ、安定した低レイテンシ

### ブラウザでの体感確認

負荷投入中にブラウザの在庫管理画面から出庫操作を行い、影響を体感します:

- **Bad Table**: 操作がタイムアウト/エラーになる、またはレスポンスが著しく遅延する
- **Good Table**: 操作が正常に完了する（負荷の影響を受けない）

> **ポイント**: DynamoDB の split-for-heat による自動回復が始まる前（開始直後 30 秒以内）にオンライン操作を試すと、影響がより顕著に確認できます。

## 出力フォーマット

スクリプトは毎秒のメトリクスをリアルタイムで出力します:

```
[  1s] rps=1523  success=1480  throttle=43   p50=12ms  p95=45ms
[  2s] rps=1508  success=1421  throttle=87   p50=14ms  p95=89ms
...
=== SUMMARY ===
Duration: 120s
Total: 180,000
Success: 165,000 (91.7%)
Throttle: 15,000 (8.3%)
Latency: p50=15ms  p95=78ms  p99=234ms
```

## 片付け

```bash
cd load-generator/cdk
npx cdk destroy
```

> **重要**: 実験後は必ず `cdk destroy` を実行してください。EC2 インスタンスが残ると課金が継続します。

## コスト見積もり

| 項目 | 単価 | コスト |
|------|------|--------|
| t3.xlarge (4 vCPU, 16GB) | $0.1664/時間 | ~$0.17/時間 |
| DynamoDB WCU 10,000 × 2 テーブル | $6.5/テーブル/時間 | $13/時間 |
| DynamoDB GSI WCU（100 に削減後） | 微小 | ~$0.10/時間 |
| **合計（1 時間の実験）** | | **~$14** |

> **コスト削減のヒント**: GSI の WCU を 100 に下げることで、GSI 分のコスト（最大 $19.5/時間）を大幅に削減できます。負荷テストは GSI に直接書き込まないため、実験に影響はありません。

### 想定実験時間

1 回の実験は準備含め 30 分〜1 時間で完了します。3 ラウンド全て実行しても 1 時間以内に収まります。

## トラブルシューティング

| 問題 | 対処 |
|------|------|
| RPS が目標に届かない | `--threads` を増やす（例: 150〜200） |
| スロットリングが発生しない | `--tokyo-ratio` を上げる、または DynamoDB のバーストキャパシティ枯渇を待つ（120 秒持続） |
| SSM 接続できない | EC2 の IAM ロールに `AmazonSSMManagedInstanceCore` ポリシーが付与されているか確認 |
| テーブルが見つからない | Amplify sandbox が稼働中か確認。テーブル名が正しいか `aws dynamodb list-tables` で確認 |
| SKU リストが空 | テーブルにデータが入っているか確認。Amplify UI からテストデータを投入してから再実行 |
