# EC2 ベース負荷生成ツール — 設計

## ディレクトリ構成

```
load-generator/
  cdk/
    app.py                  # CDK アプリケーションエントリポイント
    stack.py                # EC2 + IAM + Security Group 定義
    cdk.json                # CDK 設定
    requirements.txt        # CDK 依存
  scripts/
    load_test.py            # メイン負荷生成スクリプト
    requirements.txt        # スクリプト依存 (boto3)
  README.md                 # セットアップ・実行手順
```

## CDK スタック設計

### リソース

| リソース | 設定 | 備考 |
|---------|------|------|
| EC2 インスタンス | t3.xlarge (4 vCPU, 16GB) | コスト重視で t3、必要なら c5 に変更 |
| IAM ロール | DynamoDB PutItem/UpdateItem + SSM | テーブル名は `kiro-roasters-inventory-*` にワイルドカード |
| Security Group | アウトバウンドのみ許可 | SSM 経由接続のためインバウンド不要 |
| User Data | Python 3.12 + boto3 インストール + スクリプト配置 | User Data に heredoc で埋め込み（git clone 不要、認証不要） |

### テーブル名の受け渡し

CDK の context パラメータで指定:
```bash
npx cdk deploy -c badTable=kiro-roasters-inventory-bad -c goodTable=kiro-roasters-inventory-good
```

EC2 の環境変数として `/etc/environment` に書き込み。

## 負荷生成スクリプト設計

### 方式: boto3 + ThreadPoolExecutor

`aioboto3` は追加依存が複雑なため、標準の `boto3` + `concurrent.futures.ThreadPoolExecutor` を使用。マルチスレッドにより 1 インスタンスで 3,000〜5,000 req/s を目指す。

### アーキテクチャ

```
メインスレッド
  ├─ ThreadPoolExecutor(max_workers=100)
  │    ├─ Worker 1: UpdateItem → カウンター++
  │    ├─ Worker 2: UpdateItem → カウンター++
  │    └─ ...
  └─ 毎秒レポートスレッド: 成功/スロットル/レイテンシを stdout に出力
```

### パラメータ（コマンドライン引数）

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

### 出力フォーマット

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

### SKU リスト取得

起動時に対象テーブルを Scan して SKU リストを取得（最大 1,000 件）。
以降はこのリストからランダムに選択して UpdateItem を発行。

### エラーハンドリング

- テーブルが空（SKU リスト 0 件）の場合: エラーメッセージを出力して即座に終了
- `--no-retry` 実装: `botocore.config.Config(retries={'max_attempts': 0})` で DynamoDB クライアントを生成
- ProvisionedThroughputExceededException をキャッチしてスロットルカウンターをインクリメント（例外を握りつぶさず集計に使用）

## 実験フロー

```
1. Amplify sandbox 起動中（WCU=10,000 のテーブルが稼働中）
2. load-generator/ で `npx cdk deploy`
3. SSM Session Manager で EC2 に接続:
     aws ssm start-session --target <instance-id> --region us-west-2
4. Bad Table への負荷投入:
     python3 /opt/load-test/load_test.py \
       --table kiro-roasters-inventory-bad \
       --table-type bad \
       --rps 3000 \
       --duration 120 \
       --tokyo-ratio 0.8
5. 負荷投入中にブラウザで在庫管理画面から出庫操作 → エラー/遅延を体感
6. Good Table でも同じ負荷を投入 → オンライン操作は正常であることを確認
7. `npx cdk destroy` で EC2 を削除
```

## コスト詳細

| 項目 | 単価 | 数量 | コスト |
|------|------|------|--------|
| t3.xlarge | $0.1664/時間 | 1 台 × 1 時間 | $0.17 |
| DynamoDB WCU 10,000 × 2 テーブル | $6.5/テーブル/時間 | 2 時間 | $26 |
| DynamoDB GSI WCU 10,000 × 3 | $6.5/GSI/時間 | 2 時間 | $39 |
| **合計** | | | **~$65** |

※ GSI の WCU を 100 に下げれば $26 + $0.17 = **~$27** で済む

## リスクと対策

| リスク | 対策 |
|--------|------|
| t3.xlarge でも RPS 不足 | `--threads` を増やすか、インスタンスを 2 台に |
| DynamoDB が split-for-heat で自動回復 | 開始直後（30秒以内）にオンライン操作を試す |
| EC2 削除忘れ | README に注意書き + CDK destroy コマンドを明記 |
| バーストキャパシティで最初が吸収される | 120秒の持続負荷で枯渇させる |
