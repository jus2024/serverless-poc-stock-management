# EC2 ベース負荷生成ツール — 要件

## 背景

Lambda ベースの負荷テストでは Node.js のシングルスレッド制約により実効 ~480 req/s が上限となり、DynamoDB のパーティション単位上限（1,000 WCU/秒）に到達できなかった。ホットスポットによるスロットリングを再現するには、EC2 からマルチスレッド/非同期で 3,000+ req/s を 1 パーティションキーに集中投入する必要がある。

### テーブルスキーマ前提

| テーブル | PK | SK | 備考 |
|---------|----|----|------|
| kiro-roasters-inventory-bad | `warehouseId` (String) | `skuId` (String) | PK がホットスポットになる設計 |
| kiro-roasters-inventory-good | `skuId` (String) | `warehouseId` (String) | アクセスが分散する設計 |

Bad Table では `warehouseId = "WH-TOKYO"` に書き込みを集中させることで、単一パーティションの WCU 上限（1,000 WCU/秒）に到達させる。

## 目的

Amplify sandbox で動作中の DynamoDB テーブルに対して、EC2 インスタンスから高 RPS の書き込み負荷を生成し、ホットスポット（Bad Table の WH-TOKYO パーティション）でスロットリングを発生させる。その最中に、Amplify UI から在庫操作を行い「オンライン操作が影響を受ける」ことを体感する。

## 要件

### FR-1: 負荷生成スクリプト

- Python (asyncio + aioboto3 or boto3 + ThreadPoolExecutor) で DynamoDB に直接書き込む
- 対象テーブル名を環境変数で指定可能
- パラメータ: RPS、継続秒数、倉庫分布（東京集中率）
- 1 パーティションキーへの集中率を制御可能
- リアルタイムで毎秒の成功/スロットル数をターミナルに出力
- 完了時にサマリー（総リクエスト、成功率、スロットル率、レイテンシ p50/p95/p99）を出力
- 目標 RPS とスロットリング条件の関係: 1 アイテム更新 (≤1KB) = 1 WCU。パーティション上限 1,000 WCU/秒に対し、tokyo-ratio 0.8 × RPS 3,000 = 2,400 req/s が WH-TOKYO に集中するため、確実にスロットリングが発生する

### FR-2: CDK によるインフラ定義

- EC2 インスタンス (c5.xlarge or t3.xlarge) を 1〜3 台起動
- DynamoDB テーブルへの書き込み権限を持つ IAM ロール
- SSM Session Manager でアクセス（SSH キー不要）
- User Data でスクリプトの依存関係を自動インストール
- 同一リージョン (us-west-2) のデフォルト VPC に配置

### FR-3: デプロイと実行のライフサイクル

- `cdk deploy` で EC2 を起動
- SSM Session Manager で EC2 に接続し、スクリプトを実行
- 実験完了後 `cdk destroy` で全リソース削除
- Amplify sandbox とは独立にデプロイ/削除可能

### FR-4: Amplify 側との連携

- 負荷生成対象のテーブル名は Amplify sandbox のテーブル名（`kiro-roasters-inventory-bad` / `kiro-roasters-inventory-good`）を使用
- オンライン操作の体感は既存の Amplify UI（在庫管理タブの出庫操作）を使用
- 負荷生成中に Amplify UI からリトライ有効/無効で出庫操作を行い、影響を確認

### NFR-1: コスト管理

- EC2 は実験時間のみ起動し、`cdk destroy` で確実に削除
- 想定コスト: EC2 $1〜2/時間 + DynamoDB $13/時間（WCU 10,000 × 2 テーブル）
- 1 回の実験: 30 分〜1 時間で完了見込み

### NFR-2: シンプルさ

- `load-generator/` ディレクトリに完結
- 依存は Python + CDK のみ（Amplify CLI 不要）
- README に手順を明記

## スコープ外

- 負荷スクリプトの Web UI 化
- 結果の自動可視化ダッシュボード
- Amplify CDK スタックとの統合（別 CDK プロジェクトとして独立）
