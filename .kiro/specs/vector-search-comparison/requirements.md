# Requirements Document

## Introduction

本検証シリーズの最終テーマとして、**DynamoDB Vector Search（2026-08-05 GA）** と **OpenSearch Serverless VECTORSEARCH（k-NN）** のベクトル検索性能を横並びで比較する機能を構築する。

既存の「検索比較」タブ（全文検索の比較）と同じ思想で、同一の埋め込みベクトルと同一のクエリベクトルを両バックエンドに投げ、レイテンシ・recall@k・コスト・機能制約の差分を可視化する。既存の在庫データ（5,000 SKU × 3 倉庫 = 15,000 レコード）と同一のキースキーマ・同一のデータ内容を**検証専用の新規テーブル（Vector_Table）に複製**して対象とし、新規タブ「ベクトル検索比較」として追加する。

さらに本検証では、**日本語と英語の 2 本の埋め込みベクトルを SKU ごとに独立して生成**し、言語別に recall を測定する。Titan Text Embeddings V2 の日本語サポートがプレビュー扱いであるという既知のリスクを、注意書きではなく**実測値の差分**として提示するためである。

この機能の成果物は「動く検索 UI」だけではなく、**測定結果とその考察を `docs/` に記録すること**までを含む。

### 検証の主要な問い

1. DynamoDB Vector Index は謳い文句どおり一桁ミリ秒・recall 99% 以上を実現するか
2. OpenSearch k-NN と比べてレイテンシ・精度・コストはどう違うか
3. DynamoDB Vector Search の制約（TopK 最大 100 / フィルタ演算子の対応範囲 / 距離関数変更不可 / オンデマンド必須 / 次元数上限 4,096）は業務要件にとって許容できるか
4. 同一の意味を持つクエリに対して、日本語と英語で Recall_At_K はどれだけ違うか（Titan Text Embeddings V2 の日本語プレビュー扱いが実用上どの程度の差として現れるか）
5. OpenSearch VECTORSEARCH コレクションでも NextGen の scale-to-zero が効くか（＝アイドルコストが $0 になるか）

---

## Glossary

- **Vector_Search_UI**: 自然言語クエリと検索言語を入力し、両バックエンドへのベクトル検索を実行するフロントエンドコンポーネント
- **Vector_Comparison_View**: DynamoDB と OpenSearch のベクトル検索結果を左右パネルで並べて表示するフロントエンドコンポーネント
- **Embedding_Generator**: Amazon Bedrock の Titan Text Embeddings V2（`amazon.titan-embed-text-v2:0`）を呼び出してテキストから埋め込みベクトルを生成するコンポーネント
- **Embedding_Batch_Job**: 既存 5,000 SKU 分の埋め込みを日本語・英語の 2 本ずつ一括生成し、両バックエンドに書き込むバッチ処理
- **Query_Embedding_Lambda**: 検索クエリ文字列を 1 本の埋め込みベクトルに変換する Lambda 関数
- **DynamoDB_Vector_Lambda**: DynamoDB の `SearchVectors` API を呼び出す Lambda 関数
- **OpenSearch_Vector_Lambda**: OpenSearch VECTORSEARCH コレクションに対して k-NN クエリを実行する Lambda 関数
- **Vector_Verification_Path**: OpenSearch_Vector_Lambda 上に置く検証専用の経路。Vector_Collection のドキュメントから格納済みベクトルを読み出し、同一 itemId・同一言語の Vector_Table のベクトルと突き合わせて一致件数と不一致件数のみを返す。読み出しには当該 Lambda が既に持つ `aoss:ReadDocument` / `aoss:DescribeIndex` と、Vector_Table のテーブル ARN に限定した `dynamodb:GetItem` を用いる（Embedding_Batch_Job のロールは `aoss:WriteDocument` のみを持ち Vector_Collection を読み出せないため、OpenSearch 側の読み出し検証をこの経路に分離する）
- **Verification_Run**: Vector_Verification_Path を Embedding_Batch_Job の完走後に一括実行する運用操作の 1 回分。埋め込みの再生成を伴わない
- **Recall_Evaluator**: 全件ブルートフォース計算による正解集合と、各バックエンドの検索結果を比較して recall@k を算出するコンポーネント
- **Measurement_Collector**: レイテンシ、消費キャパシティ、ストレージサイズ、OCU 使用量などの測定値を収集して機械可読形式で出力するコンポーネント
- **Verification_Report**: 測定結果と考察を記載する `docs/` 配下のドキュメント成果物
- **Good_Table**: 既存の DynamoDB テーブル（`kiro-roasters-inventory-good`、PK=itemId, SK=warehouseId, オンデマンド課金、GSI 3 本すべて `ProjectionType: ALL`）。**本機能では読み取り専用**であり、Vector_Table へ複製する 15,000 レコードのデータ供給元としてのみ使用する
- **Vector_Table**: 本機能で新規作成する検証専用の DynamoDB テーブル（`kiro-roasters-inventory-vector`、PK=itemId, SK=warehouseId, オンデマンド課金、**GSI なし**、DynamoDB Streams 無効、PITR 無効、削除ポリシー DESTROY）。ベクトル属性・Vector_Index・埋め込み書き込みはすべて本テーブルを対象とする
- **Vector_Index**: Vector_Table 上に作成する DynamoDB Vector Index。**言語ごとに 1 本ずつ、計 2 本**（日本語用・英語用）
- **Vector_Collection**: 新規に作成する OpenSearch Serverless の VECTORSEARCH タイプコレクション
- **Vector_Collection_Group**: Vector_Collection を格納する新規 Collection Group（既存グループは SEARCH タイプのため再利用不可）
- **Existing_Search_Collection**: 既存の `kiro-inventory-search` コレクション（SEARCH タイプ）
- **Ingestion_Pipeline**: 既存の OSIS パイプライン `kiro-inventory-pipeline`。コスト削減のため**停止中であり、本機能では起動しない**
- **Sku_Metadata**: SKU ごとに決定論的に導出する意味的メタデータの集合。商品名・カテゴリ・産地・焙煎度・フレーバーノート・ボディ・酸味・説明文・抽出推奨を、日本語形と英語形の 2 組で保持する
- **Embedding_Text_JA**: Sku_Metadata の日本語形から組み立てた埋め込み対象テキスト
- **Embedding_Text_EN**: Sku_Metadata の英語形から組み立てた埋め込み対象テキスト
- **Query_Language**: 検索クエリの言語指定。`ja` または `en` のいずれか 1 つ
- **Paired_Query_Set**: 同一の意味的意図を持つ日本語クエリと英語クエリを 1 対 1 で対応づけたクエリ集合。言語間の Recall_At_K 差分を比較するために使用する
- **Material_Sku**: 資材カテゴリの SKU（袋・箱・ラベル・シール・テープ・包装紙・カップ・フタ・フィルター・タグ・リボン・カード。5,000 SKU 中 2,008 件）。フレーバー・ボディ・酸味を持たないため、風味に関する意味検索に対する負例クラスとして扱う
- **Ground_Truth**: itemId 単位で重複排除した 5,000 件の一意な SKU ベクトルに対してコサイン距離を厳密計算して得た正解の上位 k 件。**言語ごとに独立して計算する**
- **Recall_At_K**: Ground_Truth の上位 k 件のうち、検索結果を itemId 単位で重複排除したうえで含まれた件数の割合
- **TopK**: ベクトル検索で取得する近傍件数。DynamoDB Vector Search では最大 100
- **Distinct_Sku_K**: Recall_At_K の測定単位となる一意 SKU 件数。同一 SKU の 3 倉庫行が同一ベクトルを持つため、Distinct_Sku_K 件の一意 SKU を得るには TopK = 3 × Distinct_Sku_K を要求する。TopK 上限 100 により Distinct_Sku_K の上限は 33（100 ÷ 3 倉庫）
- **Cold_Start**: OpenSearch NextGen の scale-to-zero 状態からのウォームアップ
- **Deployment_Validator**: 課金対象リソースの作成前に構成の受理可否を判定し、結果を検証担当者に提示するデプロイ時検証コンポーネント（Requirement 5 で使用）
- **Index_Provisioner**: `dynamodb:UpdateTable` の `VectorIndexUpdates` を呼び出して Vector_Index を作成・削除する CDK カスタムリソース
- **Query_Vector_Cache**: クエリベクトルをブラウザへ返さずに 2 つの検索 Lambda へ引き渡すための受け渡し用 DynamoDB テーブル

---

## 前提・リスク・制約（要件の背景として明示）

以下は AWS ドキュメントで確認済みの事実、および本検証で意図的に受け入れるリスクである。要件はこれらを前提として記述する。

| # | 項目 | 内容 | 影響 |
|---|------|------|------|
| A1 | 日本語の埋め込み品質は測定対象 | Titan Text Embeddings V2 の対応言語は英語が正式サポート、100 言語以上はプレビュー扱い。商品名は日本語 | 注意書きに留めず、**日本語・英語の 2 本のベクトルを独立生成して言語別に Recall_At_K を測定**し、差分を実測値として提示する。両バックエンドが同一ベクトルを使うため DynamoDB 対 OpenSearch の比較の公平性は言語にかかわらず保たれる |
| A2 | OSIS パイプラインは停止維持 | 起動すると約 $175/月が発生する | ベクトルは Embedding_Batch_Job から**両バックエンドへ直接書き込む**。Streams 経由の同期は使わない。Vector_Table は Streams を有効化しない |
| A3 | DynamoDB のフィルタ演算子の対応範囲は**未確定** | 開発者ガイドは `SearchConditionExpression` が等価（`=`）のみで比較・範囲・`IN` は未提供と記述する一方、SDK API リファレンスは `HASH` 要素が `=` のみである一方 `INLINE_FILTER` 要素は比較・範囲演算子をサポートすると記述しており、ドキュメント間で矛盾している | 実装既定は等価条件のみとし、**実測プローブで確定**させて結果を Verification_Report に記録する。UI の機能制約比較表はバックエンドのレスポンスから対応種別を取得するため、いずれの結果でも追従できる |
| A4 | TopK 上限 100 | DynamoDB Vector Search の仕様 | recall 測定の TopK は 100 以下とする。A11 の希釈と組み合わせて Distinct_Sku_K は 33 以下となる |
| A5 | 距離関数は変更不可 | インデックス作成時に固定される | COSINE を選定し、両バックエンドで揃える。変更が必要ならインデックス再作成 |
| A6 | オンデマンド課金必須 | DynamoDB Vector Search の前提条件 | Vector_Table をオンデマンドで新規作成する |
| A7 | VECTORSEARCH の scale-to-zero は未検証 | NextGen の scale-to-zero が VECTORSEARCH タイプに適用されるかは未確認。ベクトルコレクションの OCU 使用量はインメモリベクトルが主因とされるため、SEARCH タイプと同等のアイドルコストになるとは限らない | **コストリスク**。デプロイ前に検証し、適用されない場合は常時 OCU 課金の可能性を明示して判断を仰ぐ。右サイジングには CloudWatch `OCUUtilization` を用いる |
| A8 | Collection Group はタイプ混在不可 | 1 グループに 1 コレクションタイプのみ | 新規 Collection Group を作成する。既存の Existing_Search_Collection には影響を与えない |
| A9 | ベクトル属性は GSI に複製される | Good_Table の GSI 3 本はすべて `ProjectionType: ALL`。ベクトル属性を Good_Table に追加すると 3 本の GSI すべてにベクトルが複製され、ストレージが約 4 倍に膨張し、既存の在庫一覧の GSI Query の読み取り量が 1 ページあたり約 5 KB から約 150 KB（RCU 約 1 → 約 19）に増加し、書き込み増幅も 4 倍になる。結果として `docs/opensearch-comparison.md` に記録済みの検索パターン #1〜#12 の測定値が無効化される | **GSI を持たない Vector_Table を新規作成**し、Good_Table には一切変更を加えない。専用テーブルにすることでベクトルのストレージ寄与を GSI 複製分の差し引きなしに測定できる。この落とし穴は Verification_Report の知見として記録する |
| A10 | Bedrock は RPM でスロットリング | TPM ではなく Requests Per Minute | 5,000 SKU × 2 言語 = 10,000 件の一括埋め込みでレート制御とリトライが必要 |
| A11 | 同一ベクトルの 3 行複製が TopK を希釈する | 同一 SKU の 3 倉庫行は同一ベクトルを持つため、TopK 10 の検索は約 3 件の一意 SKU を倉庫三つ組として返す。返却行の itemId 集合を k で割ると、正しい実装でも Recall_At_K が約 0.33 になる | Recall_At_K は **itemId 単位で重複排除した SKU 粒度**で測定し、Distinct_Sku_K 件を得るために TopK = 3 × Distinct_Sku_K を要求する。TopK 上限 100 により Distinct_Sku_K の上限は 33。測定する k を 1 / 10 / 33 とする。この構造的制約と本番設計への示唆は Verification_Report に記録する |
| A12 | DynamoDB ベクトルインデックスの次元数上限は 4,096 | 16,000 は OpenSearch 側の上限。DynamoDB Vector Index は 1〜4,096。インデックス内のベクトルは f32 精度で保持される | 両バックエンドで同一次元数を使う本機能の実効上限は 4,096。Bedrock が返した値は f32 に丸めて両バックエンドへ書き込み、実効精度を揃える |
| A13 | Vector_Index は CFN の Table リソースで表現できない | `AWS::DynamoDB::Table` に `VectorIndexes` プロパティは存在しない。ベクトルインデックスは `CreateTable`（新規）または `UpdateTable` の `VectorIndexUpdates`（既存テーブル）で作成し、1 回の `UpdateTable` で追加または削除は 1 件のみ | Index_Provisioner（CDK カスタムリソース）で作成する。言語ごとに 1 本ずつ計 2 本を、2 回の `UpdateTable` 呼び出しで作成する。ベクトルインデックスの上限はテーブルあたり 5 本のため 2 本は範囲内 |
| A14 | `SearchVectors` の応答はページネーション非対応 | 応答は 16 MB 上限。ベクトルインデックスは `Query` / `Scan` / PartiQL では読み取れない | 射影は `ProjectionType: INCLUDE` とし `ALL` は使用しない。射影の非キー属性数の上限はベクトル属性と各 `INLINE_FILTER` 要素と共有される |
| A15 | 既存 SKU の品種は産地と独立に組み合わされている | 既存マスターは産地と品種を独立に組み合わせるため「ブラジル イルガチェフェ」のような実在しない組み合わせが生成されている | 意味的メタデータは**産地と焙煎度から導出し、品種を意味的シグナルとして使用しない**。既存の itemId / itemName は既存の比較検証が依存しているため変更しない |
| A16 | **旧要件 3.6 と要件 17.7 は同時に成立しない（実測で判明）** | 旧要件 3.6 は Embedding_Batch_Job 自身が両バックエンドから読み出して突き合わせることを求めていたが、要件 17.7 は埋め込みバッチロールの Vector_Collection 権限を `aoss:WriteDocument` のみに限定している。読み出しには `aoss:ReadDocument` が必要であり、両者は両立しない。タスク 13.11 の実行で確認した値は `storedCount 1712 / bedrockCalls 1712 / failedCount 0 / truncatedCount 0 / verifiedMatchedCount 0 / verifiedMismatchedCount 1712`、失敗一覧 100 件はすべて同一内容で `stage: VERIFICATION` / `errorCode: ACCESS_DENIED_IAM` / `security_exception: [security_exception] Reason: Bad Authorization` | **OpenSearch 側の読み出し検証を Embedding_Batch_Job から分離し、Vector_Verification_Path（OpenSearch_Vector_Lambda 上の経路）で行う。**埋め込みバッチ本体に残す検証は Vector_Table 側のみとする（要件 3.6 / 3.12〜3.18）。要件 17.7 の禁止事項は変更しない |
| A17 | **却下案: 検証専用の新規 Lambda を追加する** | 新しい Lambda に `aoss:ReadDocument` を与えるには、その実行ロールをデータアクセスポリシーの Principal に追加する必要がある。Principal が 4 件になり、要件 17.7 が定める「3 件のみ」という構成そのものが崩れる | **却下する。**データアクセスポリシーの Principal は 3 件（OpenSearch_Vector_Lambda / Embedding_Batch_Job / CloudFormation 実行ロール）を維持し、4 件目を追加しない。既に ReadDocument を持つ OpenSearch_Vector_Lambda に検証経路を相乗りさせる（要件 3.13 / 17.7 / 17.15）。この却下理由を Verification_Report にも記録する（要件 18.20） |
| A18 | 埋め込みバッチは `forceRegenerate: false` で動くため再実行で既存の埋め込みを skip する | 再実行しても既に生成済みの (itemId, 言語) の組は Bedrock を呼ばずスキップされる（要件 4.5）。タスク 13.11 の実行では最初の 856 SKU 分（= 1,712 組）が「生成済みかつ OpenSearch 側未検証」の状態になる | **検証は再生成を伴わずに実行できなければならない。**Vector_Verification_Path は埋め込みを生成せず、Bedrock を一切呼ばない（要件 3.15）。Bedrock の再課金を避けるための必須条件である |
| A19 | 開発者の IAM ユーザーはデータアクセスポリシーの Principal に含まれない | インデックスを直接読めない（`GetIndex` / cloudcontrol / エンドポイント直叩きのいずれも 403）。これは要件 17.7 の意図どおりの結果である | 同時に「投入できている証拠を人が直接確認できない」ことを意味する。**Vector_Verification_Path が投入の証拠を得る唯一の経路になる**（要件 3.13 / 18.20） |
| A20 | CloudFormation のリソーススキーマが許容しても実サービスが拒否する項目がある | `AWS::OpenSearchServerless::Index` のスキーマは `Method.Engine` の enum に `faiss` を含むが、データプレーンは `[illegal_argument_exception] Field parameter 'engine' is not supported` としてパラメータ自体を拒否する（タスク 13.7 で実測）。ローカルの合成テストでは原理的に検出できず、デプロイまで失敗が遅れる | スキーマ上許容される値であっても、実サービスが受理するとは限らない前提で構成を決める。`Method.Engine` は**送らない**（要件 6.5）。この横断的制約は design.md の制約セクションにも 1 項目として立てる |
| A21 | **`amazon.titan-embed-text-v2:0` は us-west-2 でレイテンシ最適化推論に未対応（実測で判明）** | 旧要件 10.1 は「レイテンシ最適化された推論呼び出しを使用して」と明記しており、実装（`vector-query-embed/handler.ts` の `createEmbeddingGenerator({ latencyOptimized: true })` → `embedding-generator.ts` が `performanceConfigLatency: optimized` を付けて `InvokeModel` を呼ぶ）は要件どおりであった。デプロイ済み環境の `POST /vector-search/embed` は**全リクエストに HTTP 400** を返し、本文は `{"stage":"EMBEDDING","errorCode":"INVALID_QUERY","message":"クエリ文字列が空、または空白文字のみです。 Latency performance configuration is not supported for amazon.titan-embed-text-v2:0 in us-west-2"}` であった。原因は Bedrock を直接呼ぶ A/B（同一モデル・同一リージョン・同一本文 `inputText` / `dimensions 1024` / `normalize true`・同一資格情報で `performanceConfigLatency` の有無だけを変えた 2 回）で確定した。指定なしは成功（dimensions 1024 / inputTextTokenCount 29）、`performanceConfigLatency: optimized` は `ValidationException` / HTTP 400 | **影響範囲はクエリ埋め込み経路のみ。**埋め込みバッチ側は `latencyOptimized: false` のためタスク 13.11 は完走した。ただし両検索エンドポイントは `queryId` しか受け付けず、`queryId` を発行できるのはこのエンドポイントだけであるため、タスク 13.17（recall）と 13.18（レイテンシ・キャパシティ・UI 検証）が完全に止まる。**採用した対処は案 B（フォールバック）：**レイテンシ最適化推論を試し、モデルまたはリージョンが未対応であることを示すエラーなら標準推論で 1 回だけ再試行し、どちらを使ったかを応答と測定レポートに記録する（要件 10.1 / 10.13〜10.15 / 18.22）。us-west-2 ではフォールバックが常に発生するため、タスク 13.18 が測るレイテンシは**標準推論の値**である。副次的な欠陥として、Bedrock の `ValidationException` が `errors.ts` の `classifyBadRequest` の既定分岐で `INVALID_QUERY` に分類され、実態と無関係な定型文が付いた（真因は `detail` に残るため切り分けは可能だが誤誘導する）。これは要件 16.10 / 16.11 で塞ぐ |
| A22 | **`DescribeTable` の `VectorIndexes[].Backfilling` は `true → false` の遷移を観測できない（実測で判明）** | `CREATING` かつバックフィル中は `true` が返るが、ACTIVE 到達後は不在になり、`true → false` の遷移を一度も観測できない。インデックス作成中の観測では、Index_Provisioner の `is-complete.ts` によるポーリングが 2 本のインデックスそれぞれについて `IndexStatus: CREATING` のまま `Backfilling: true` を 8 回返した（各 9 回のポーリングのうち 2 回目以降。`docs/measurements/vector-index-provisioning-logs-2026-08-20T22-22-48-974Z.json` の `pollObservations`）。`is-complete.ts` の出力は `lookup.index?.Backfilling === true` であるため、`true` の出力は生フィールドが真であったことを意味する。ACTIVE 到達後の観測（タスク 13.12 / 18.4 / 19.2）では当該キーが不在であった | 要件 5.15 の判定（`Backfilling !== true`）は ACTIVE 到達後の「不在 = 偽」として成立する。一方で**要件 5.14 の「バックフィル完了までの経過時間」は実測できない**（`true → false` の遷移時刻を要するため）。値が取得できない場合の扱いを要件 5.17 で定め、要件 16.3 の `INDEX_BUILDING` 応答および要件 5.15 の返却値についてもフィールド不在時の表現を定める |

---

## Requirements

### Requirement 1: 検証専用テーブルの構築と既存テーブルの不変性

**User Story:** As a 検証担当者, I want ベクトル検証を専用テーブルで行う, so that 既存テーブルの測定値と性能特性を損なわずに検証できる

#### Acceptance Criteria

1. THE Vector_Table SHALL テーブル名 `kiro-roasters-inventory-vector`、パーティションキー itemId（文字列型）、ソートキー warehouseId（文字列型）、オンデマンド課金で作成される
2. THE Vector_Table SHALL グローバルセカンダリインデックスを 0 本、DynamoDB Streams を無効、ポイントインタイムリカバリを無効、削除ポリシーを DESTROY として構成される
3. THE Vector_Table SHALL Good_Table から複製した 5,000 SKU × 3 倉庫 = 15,000 件のレコードを保持し、各レコードの itemId、warehouseId、itemName、quantity、lotNumber、location、unitPrice の値を Good_Table の対応レコードと同一の値とする
4. THE Embedding_Batch_Job SHALL Good_Table に対して読み取り操作のみを実行し、Good_Table への書き込み操作（PutItem / UpdateItem / DeleteItem / BatchWriteItem）を実行しない
5. WHEN 本機能のデプロイおよび全測定が完了したとき, THE Verification_Report SHALL Good_Table のパーティションキー、ソートキー、3 本の GSI（byWarehouse / byLocation / byUnitPrice）の定義、DynamoDB Streams の NEW_AND_OLD_IMAGES 設定、PITR 設定、アイテム件数 15,000、および任意に抽出した 10 件以上のアイテムの属性集合とアイテムサイズが、本機能のデプロイ前と同一であることを確認した結果を記載する
6. THE Vector_Index SHALL Vector_Table 上にのみ作成され、Good_Table 上には作成されない
7. IF Vector_Table のレコード件数が 15,000 件に一致しない場合, THEN THE Embedding_Batch_Job SHALL 埋め込み生成を開始せず、期待件数 15,000 と実際の件数の両方を含むエラーを返却する
8. THE Query_Vector_Cache SHALL テーブル名 `kiro-vector-query-cache`、パーティションキー queryId（文字列型）、オンデマンド課金、TTL 属性による 300 秒での自動失効、削除ポリシー DESTROY として作成される

### Requirement 2: 意味的メタデータの決定論的導出

**User Story:** As a 検証担当者, I want 意味的に十分な情報量を持つ日英のメタデータを SKU ごとに生成する, so that ベクトル検索と全文検索の差が観測できる

#### Acceptance Criteria

1. THE Sku_Metadata SHALL 各 SKU について、商品名、カテゴリ、産地、焙煎度、フレーバーノート、ボディ、酸味、説明文、抽出推奨を、日本語形と英語形の 2 組として保持する
2. THE Sku_Metadata SHALL itemId と既存のマスターデータ（産地マスター、焙煎度マスター、ブレンド名マスター、資材マスター）および固定した乱数シードのみから導出され、同一の itemId に対して常に同一の値を返す
3. THE Sku_Metadata SHALL 日本語の商品名として既存の `itemName` の値をそのまま使用し、英語の商品名を itemId から導出した別の値として保持する
4. THE Sku_Metadata SHALL フレーバーノート、ボディ、酸味を産地コードと焙煎度コードから導出し、品種コードを導出の入力に使用しない
5. WHERE SKU がブレンドカテゴリである場合, THE Sku_Metadata SHALL フレーバーノートの導出にブレンド名コード（FRUITY / NUTTY / CHOCO / CARAMEL / CITRUS / BERRY / FLORAL / SPICY 等の風味を示すコード、および RICH / MILD / DEEP / SMOOTH / BOLD 等のボディを示すコード）を追加の入力として使用する
6. WHERE SKU が Material_Sku である場合, THE Sku_Metadata SHALL 包装資材に適した説明文と抽出推奨に代わる用途説明を保持し、フレーバーノート、ボディ、酸味を空値として扱う
7. THE Sku_Metadata SHALL 既存の Good_Table のシード出力に含まれる itemId、itemName、quantity、lotNumber、location、unitPrice の値を変更せず、Vector_Table のシード経路においてのみ追加のメタデータ属性を付与する
8. THE Embedding_Text_JA SHALL Sku_Metadata の日本語形の各値を、商品名 → カテゴリ → 産地 → 焙煎度 → フレーバーノート → ボディ → 酸味 → 説明文 → 抽出推奨の固定順で、区切り文字に半角スペース 1 文字を用いて連結した 1 つの文字列とし、連結前に各値の前後の空白文字を除去し、空値は空文字として扱い、連結後に連続する空白文字を 1 文字に圧縮する
9. THE Embedding_Text_EN SHALL Sku_Metadata の英語形の各値を、Embedding_Text_JA と同一の項目順・同一の区切り文字・同一の前処理規則で連結した 1 つの文字列とする
10. THE Embedding_Text_JA および Embedding_Text_EN SHALL 日本語形と英語形を 1 つの文字列に混在させずに、それぞれ単一言語の文字列として構成される

### Requirement 3: 埋め込みベクトルの一元生成

**User Story:** As a 検証担当者, I want 言語ごとに埋め込みベクトルを 1 回だけ生成して両バックエンドに格納する, so that 同一ベクトルによる公平な比較ができる

#### Acceptance Criteria

1. THE Embedding_Generator SHALL Amazon Bedrock のモデル `amazon.titan-embed-text-v2:0` を使用して埋め込みベクトルを生成する
2. THE Embedding_Generator SHALL 埋め込み対象テキストとして、日本語ベクトルの生成には Embedding_Text_JA、英語ベクトルの生成には Embedding_Text_EN を使用する
3. THE Embedding_Generator SHALL 出力ベクトルの次元数を設定値（1024 / 512 / 256 のいずれか）から取得し、設定値が未指定の場合は 1024 を使用し、1 回の実行内では全 SKU および両言語に同一の次元数を適用する
4. THE Embedding_Batch_Job SHALL 埋め込みベクトルを SKU 単位（itemId 単位）かつ言語単位で 1 本ずつ生成し、Bedrock の埋め込み生成呼び出し回数を SKU 数 × 言語数（5,000 × 2 = 10,000 回、再試行を除く）と一致させる
5. THE Embedding_Batch_Job SHALL 生成した言語ごとの 1 本のベクトルを同一 SKU に属する 3 件（倉庫別レコード）すべてに複製して Vector_Table と Vector_Collection の両方に書き込み、各バックエンドに 15,000 件の 2 言語分のベクトルを保持するレコードを格納する
6. WHEN Vector_Table への書き込みが完了したとき, THE Embedding_Batch_Job SHALL 全 5,000 SKU × 2 言語について **Vector_Table から**当該ベクトルを読み出し、書き込んだ値との次元数の一致と全次元の数値の完全一致を要素単位で比較検証し、一致した件数と不一致の件数を言語別に実行結果に含める（Embedding_Batch_Job は Vector_Table のテーブル ARN に対する `dynamodb:GetItem` を持つため成立する。Vector_Collection 側の読み出し検証は要件 3.12〜3.18 の Vector_Verification_Path が担う。旧版の本項は両バックエンドからの読み出しを求めていたが、要件 17.7 が埋め込みバッチロールの Vector_Collection 権限を `aoss:WriteDocument` のみに限定するため実行時に全件 `ACCESS_DENIED_IAM` となり成立しなかった。A16 参照）
7. IF 埋め込み対象テキストが 50,000 文字を超える場合, THEN THE Embedding_Generator SHALL 先頭 50,000 文字に切り詰めて処理を継続し、切り詰めが発生した SKU の件数を言語別に実行結果に含める
8. THE Embedding_Batch_Job SHALL 埋め込み生成に要した合計時間（秒、小数第 1 位まで）、Bedrock の呼び出し回数（再試行回数を含む）、および失敗した SKU 件数を言語別および合計で実行結果に含める
9. THE Embedding_Batch_Job SHALL Bedrock が返した各次元の数値を 32bit 浮動小数（f32）に丸めた値を Vector_Table と Vector_Collection に同一の値として書き込み、f32 への丸め以外の桁数削減および切り捨てを行わない（f32 は DynamoDB ベクトルインデックスの保持精度および OpenSearch の `PropertyMapping.DataType: float`（32bit 浮動小数）と一致するため、両バックエンドの実効精度が揃う。`float32` という値は当該 enum に存在しない。要件 6.5 参照）
10. IF 一方のバックエンドへの書き込みが成功し他方への書き込みが 3 回の再試行後も失敗した場合, THEN THE Embedding_Batch_Job SHALL 当該 SKU の 3 件のレコードを両バックエンドで書き込み前の状態に戻し、当該 SKU を未格納として扱い、対象 itemId、対象言語、および書き込み失敗を示すエラー内容を実行結果に含める
11. IF Bedrock の呼び出しがスロットリングにより失敗した場合, THEN THE Embedding_Generator SHALL 指数バックオフで最大 5 回まで再試行し、5 回すべて失敗した時点で当該 SKU の当該言語を失敗として記録し、残りの処理を継続する
12. THE Embedding_Batch_Job SHALL Vector_Collection に対する読み出し操作を実行せず、`aoss:ReadDocument` および `aoss:DescribeIndex` を要求しない
13. THE Vector_Verification_Path SHALL OpenSearch_Vector_Lambda 上の経路として実装され、Vector_Collection のドキュメントからの読み出しに当該 Lambda の実行ロールが既に持つ `aoss:APIAccessAll`（IAM）およびデータアクセスポリシーの ReadDocument と DescribeIndex のみを用い、Vector_Table からの読み出しに Vector_Table のテーブル ARN のみを Resource とする `dynamodb:GetItem` を用いる
14. THE Vector_Verification_Path SHALL 指定された itemId の各言語について、Vector_Collection から読み出したベクトルと Vector_Table から読み出したベクトルを、次元数の一致と全次元の数値の完全一致で要素単位に比較し、一致件数、不一致件数、いずれかのバックエンドで未格納であった件数を言語別および合計で出力する
15. THE Vector_Verification_Path SHALL Embedding_Batch_Job の完走後に Verification_Run として実行され、Vector_Table において当該言語のベクトルが存在し、かつ格納済みの埋め込みモデル識別子とベクトル次元数がいずれも現行設定と一致する (itemId, 言語) の組の全件を検証対象として特定し、埋め込みの再生成を行わず Bedrock を一度も呼び出さない
16. THE Vector_Verification_Path SHALL 不一致であった (itemId, 言語) の組の識別子の一覧を出力に含め、日本語ベクトルおよび英語ベクトルの本体（次元数と同じ長さの数値配列）を応答に含めない
17. WHEN Verification_Run が終了したとき, THE Vector_Verification_Path SHALL 検証対象件数、一致件数、不一致件数、未格納件数の合計が検証対象件数と等しいことを満たす集計値を出力し、不一致件数と未格納件数の和が 1 以上である場合は判定結果を不合格として出力する
18. IF 検証において不一致または未格納が 1 件以上検出された場合, THEN THE Embedding_Batch_Job および THE Vector_Verification_Path SHALL 当該件数を失敗件数に計上し、実行状態を COMPLETED として終了せず、不合格であることと不一致件数・未格納件数の両方を含む結果を返却する（旧実装は `verifiedMismatchedCount` が 1,712 でも `failedCount` を 0 のままとし、検証が 1 件も成立していない状態で COMPLETED として終了していた。これは要件 3.6 が意味をなさなくなる欠陥であるため、集計と終了判定の規則を本項で定める。A16 参照）

### Requirement 4: 埋め込みバッチのレート制御と再実行

**User Story:** As a 検証担当者, I want 5,000 SKU × 2 言語の埋め込み生成をスロットリングなく完走させる, so that 検証データを確実に準備できる

#### Acceptance Criteria

1. THE Embedding_Batch_Job SHALL Bedrock `amazon.titan-embed-text-v2:0` への呼び出しレートを、実行時に外部設定値として指定できる 1 分あたりのリクエスト数（既定値 120 リクエスト/分、指定可能範囲 1〜600 リクエスト/分）以下に制限する
2. IF Bedrock がスロットリングを示すエラーを返した場合, THEN THE Embedding_Batch_Job SHALL 待機時間を初回 1 秒とし以降 2 倍（1、2、4、8、16 秒、上限 32 秒）に増加させ、各待機時間に ±20% のランダムジッターを加えた間隔で、同一 SKU の同一言語に対して最大 5 回まで再試行する
3. IF 同一 SKU の同一言語の再試行回数が 5 回に達した場合, THEN THE Embedding_Batch_Job SHALL 当該 SKU の識別子、言語、および失敗種別を実行結果に記録し、残りの処理を継続する
4. THE Embedding_Batch_Job SHALL 処理済み件数、成功件数、失敗件数、残件数を言語別に、100 SKU 処理ごとおよび実行終了時に、中断後の再実行から参照可能な形で記録する
5. WHEN 既に埋め込みが格納済みの SKU を処理対象に含めて再実行した場合, THE Embedding_Batch_Job SHALL 当該言語の埋め込みベクトルが存在し、かつ格納済みの埋め込みモデル識別子とベクトル次元数がいずれも現行設定と一致する SKU と言語の組についてのみ再生成をスキップし、いずれかが一致しない組は埋め込みを再生成して上書きする
6. THE Embedding_Batch_Job SHALL 既定の 120 リクエスト/分の設定において 5,000 SKU × 2 言語の処理を 120 分以内に終了し、終了時に成功件数、失敗件数、失敗 SKU 識別子と言語の一覧を返却する
7. IF Bedrock がスロットリング以外のエラー（入力検証エラー、認可エラーなど）を返した場合, THEN THE Embedding_Batch_Job SHALL 再試行を行わず、当該 SKU と言語の組を再試行不可の失敗として識別子とともに記録し、次の処理を継続する
8. WHERE 強制再生成オプションが有効な場合, THE Embedding_Batch_Job SHALL スキップ判定を行わず、処理対象 SKU 全件の両言語の埋め込みを再生成して上書きする
9. IF 前回実行が 5,000 SKU × 2 言語の全件終了前に中断されていた場合, THEN THE Embedding_Batch_Job SHALL 再実行時に未処理および失敗した SKU と言語の組のみを処理対象とし、成功済みの組に対する Bedrock 呼び出しを行わない

### Requirement 5: DynamoDB Vector Index の構築

**User Story:** As a 検証担当者, I want Vector_Table に言語別の Vector Index を作成する, so that SearchVectors API で近傍検索を実行できる

#### Acceptance Criteria

1. THE Vector_Index SHALL Vector_Table 上に、日本語ベクトル用のインデックスと英語ベクトル用のインデックスの計 2 本として作成され、各インデックスは対応する言語のベクトル属性を参照し、距離関数を COSINE として定義される
2. THE Vector_Index SHALL Requirement 3 の次元数設定値（1024 / 512 / 256 のいずれか、既定値 1024）と同一の次元数で、2 本ともに同一の次元数で構成される
3. THE Vector_Index SHALL warehouseId を `SearchSchema` の `INLINE_FILTER` 要素として定義し、`HASH` 要素を定義せず、Vector_Table の全 15,000 件を検索対象範囲とする（`HASH` 要素を定義すると全検索の `SearchConditionExpression` において当該条件が必須となり、倉庫フィルタなしの検索が成立しないため）
4. THE Vector_Index SHALL `SearchSchema` に載せる warehouseId を、当該インデックスを作成する**同一の `UpdateTable` リクエストの `AttributeDefinitions`** に宣言された属性として参照する（検証対象はリクエストに含めた `AttributeDefinitions` であり、テーブル側の既存定義とのマージではない。GSI を `UpdateTable` で追加するときと同じ規則である。省略すると `One element in SearchSchema is not defined in attribute definitions` で拒否される。タスク 13.7 で実測）
5. THE Vector_Index SHALL Vector_Table の課金モードをオンデマンドのまま変更せずに構成される
6. THE Vector_Index SHALL 射影を `ProjectionType: INCLUDE` として構成し、`ProjectionType: ALL` を使用せず（`SearchVectors` の応答が 16 MB 上限に達した場合ページネーションで回避できないため）、射影する非キー属性数がベクトル属性および各 `INLINE_FILTER` 要素と共有される上限内であることを構成時に確認できる
7. THE Vector_Index SHALL 暗号化設定を Vector_Table から継承し、インデックス個別の暗号化設定を行わない
8. IF 距離関数を COSINE 以外へ変更する必要が生じた場合, THEN THE Verification_Report SHALL 既存 Vector_Index の削除、新しい距離関数での再作成、全 SKU の両言語ベクトル再投入という順序の再作成手順と、再投入対象件数および想定所要時間を記載する
9. THE Vector_Index SHALL Index_Provisioner が `dynamodb:UpdateTable` の `VectorIndexUpdates` を呼び出すことによって作成され、1 回の呼び出しで 1 本のインデックスのみを追加し、2 本を 2 回の呼び出しで作成する
10. THE Index_Provisioner SHALL 作成要求時に対象インデックスが既に存在する場合を成功として扱い、`DescribeTable` により当該インデックスのインデックス名・ベクトル属性名・次元数・距離関数の 4 項目が要求値と一致することを確認する
11. THE Index_Provisioner SHALL 削除時に `VectorIndexUpdates` の削除指定により対象インデックスを削除し、対象インデックスが存在しない場合を成功として扱う
12. THE Index_Provisioner SHALL 渡されるプロパティにインデックス名・ベクトル属性名・次元数・距離関数の 4 項目を含み、本機能で追加する IAM リソースの description が `[\u0009\u000A\u000D\u0020-\u007E\u00A1-\u00FF]*` に一致する文字のみであることをデプロイ前に確認できる
13. WHEN Vector_Index の作成を開始した場合, THE Index_Provisioner SHALL 60 秒以下の間隔で `DescribeTable` の `VectorIndexDescription` から状態を取得し、`IndexStatus` が ACTIVE に到達するまで待機し、待機上限を 2 時間として上限到達時はタイムアウトを示すエラーと経過時間（秒）を返却する
14. WHEN `IndexStatus` が ACTIVE に到達した場合, THE Measurement_Collector SHALL 60 秒以下の間隔で `VectorIndexDescription` の `Backfilling` を取得し、`Backfilling` が偽になるまでポーリングし、`IndexStatus` が ACTIVE に到達した時点とバックフィル完了までの経過時間（秒）を記録し、ポーリング開始から 180 分以内に `Backfilling` が偽にならない場合はタイムアウトを示すエラーと経過時間を返却する（`Backfilling` フィールドが応答に存在しない場合の扱いは criterion 17 で定める。実測では `CREATING` かつバックフィル中に `true` が返る一方、ACTIVE 到達後は当該フィールドが不在になるため `true → false` の遷移を観測できず、経過時間を取得できていない。A22 参照）
15. WHILE `DescribeTable` の `VectorIndexDescription` において `IndexStatus` が ACTIVE 以外である、または `Backfilling` が真である間, THE DynamoDB_Vector_Lambda SHALL `SearchVectors` を実行せず、インデックスが未完成であることを示すメッセージと `IndexStatus` の値および `Backfilling` の値（フィールドが応答に存在しない場合は不在であることを示す値）を返却し、当該応答をレイテンシおよび Recall_At_K の測定値として採用しない
16. THE Vector_Index SHALL `Query`、`Scan`、および PartiQL による読み取りの対象とせず、`SearchVectors` のみによって読み取られる
17. IF `DescribeTable` の `VectorIndexDescription` に `Backfilling` フィールドが存在しない場合, THEN THE Measurement_Collector および THE DynamoDB_Vector_Lambda SHALL 当該インデックスをバックフィル中でないものとして扱い、バックフィル完了までの経過時間を測定不能として記録し、当該フィールドが不在であったことを出力および応答に含める

### Requirement 6: OpenSearch VECTORSEARCH コレクションの構築

**User Story:** As a 検証担当者, I want VECTORSEARCH タイプのコレクションを新規作成する, so that k-NN 検索を実行できる

#### Acceptance Criteria

1. THE Vector_Collection SHALL コレクション名 `kiro-inventory-vector`、コレクションタイプ `VECTORSEARCH` で作成される
2. THE Vector_Collection SHALL 新規に作成する Collection Group `kiro-inventory-vector-group`（Generation は `NEXTGEN`）に所属し、当該グループには `VECTORSEARCH` タイプのコレクションのみを含める
3. WHEN Vector_Collection のデプロイが完了した場合, THE Vector_Collection SHALL Existing_Search_Collection（`kiro-inventory-search`）と既存 Collection Group（`kiro-inventory-group`）の名前、タイプ、Generation、容量設定、および各ポリシー文書を一切変更していない状態で追加される
4. THE Vector_Collection SHALL インデックス `inventory-vector` を CDK の `CfnIndex` によってデプロイ時に作成し、日本語ベクトル用と英語ベクトル用の 2 つの `knn_vector` フィールドを、いずれも Requirement 3 で決定した次元数（既定値 1024）と同一の Dimension で定義する
5. THE Vector_Collection SHALL 2 つの `knn_vector` フィールドの PropertyMapping において、`Method` 配下に Name を `hnsw`、SpaceType を `cosinesimil`（Vector_Index の COSINE と同一のコサイン距離基準）、m を 16、ef_construction を 128 として設定し、**`Method.Engine` を指定せず**、DataType を `float`（32bit 浮動小数）に設定し、CompressionLevel を指定しない（`PropertyMapping.DataType` の許容値は `float` と `byte` の 2 値のみであり `float32` は存在しない。また `Method.Engine` のリソーススキーマ上の enum は `["nmslib","faiss","lucene"]` で `faiss` はその一員だが、データプレーンは `[illegal_argument_exception] Field parameter 'engine' is not supported` としてパラメータ自体を拒否する。NextGen の VECTORSEARCH コレクションでは Faiss HNSW がコレクション種別側で固定されており、リクエストで選ぶ対象ではない。出典: `cloudformation:DescribeType AWS::OpenSearchServerless::Index` およびタスク 13.7 の実測。A20 参照）
6. THE Vector_Collection SHALL 暗号化ポリシー `kiro-inventory-vector-enc`（AWS 所有キー）、ネットワークポリシー `kiro-inventory-vector-net`（`public` アクセス）、データアクセスポリシー `kiro-inventory-vector-data` を、既存の `kiro-inventory-search-enc` / `-net` / `-data` と重複しない名前でそれぞれ個別に定義し、暗号化ポリシーとネットワークポリシーが Vector_Collection より先に作成される依存関係を明示する
7. THE Vector_Collection SHALL `inventory-vector` のマッピングにおいて、フィルタ用に `itemId` と `warehouseId` を keyword 型、表示用に `itemName` および Sku_Metadata の日本語形・英語形の各テキスト項目を keyword 型、`unitPrice` および `quantity` を **`integer` 型**として定義する（`PropertyMapping.Type` の許容値は `["text","knn_vector","keyword","integer"]` の 4 値のみで浮動小数型が存在しないため、`double` および `long` は指定できない。これはリソーススキーマの制約であって設計上の選択ではない。出典: `cloudformation:DescribeType AWS::OpenSearchServerless::Index`）
8. THE Embedding_Batch_Job SHALL Ingestion_Pipeline を経由せず Vector_Collection のインデックス `inventory-vector` へドキュメントを直接書き込み、インデックスおよびマッピングの作成・変更を行わない
9. WHEN Vector_Collection のデプロイが完了した場合, THE Vector_Collection SHALL Ingestion_Pipeline（`kiro-inventory-pipeline`）の状態が `STOPPED` であることを確認できるよう、パイプライン名と取得した状態値をデプロイ後の確認結果として出力する
10. IF Ingestion_Pipeline の状態が `STOPPED` 以外として取得された場合, THEN THE Vector_Collection SHALL 当該状態値を含む警告を出力し、パイプラインの起動および設定変更を行わない
11. IF Requirement 3 で決定した次元数が 1 未満または 4,096 を超える場合, THEN THE Vector_Index および THE Vector_Collection SHALL いずれもデプロイを実行せず、指定値と、DynamoDB 側の許容範囲（1〜4,096）および OpenSearch 側の許容範囲（1〜16,000）の両方を含むエラーを返却する（両バックエンドで同一次元数を使う本機能の実効許容範囲は 1〜4,096）
12. THE Vector_Collection SHALL 自身および関連ポリシー、IAM リソースの description を ASCII 印字可能文字のみで記述し、日本語文字および矢印記号を含めない
13. THE Vector_Collection SHALL `inventory-vector` の作成要求に `Settings.Index.Knn` を `true` として明示的に含める（`Settings` を省略した場合は「既定で k-NN 有効」ではなく `index.knn = false` として扱われ、`Mappings.Properties.*.Method` の指定が `Cannot set modelId or method parameters when index.knn setting is false` で拒否される。すなわち `Settings.Index.Knn: true` は `Method` を指定するための前提条件である。タスク 13.7 で実測）
14. THE Vector_Collection SHALL リソーススキーマが許容する値であっても実サービスが拒否しうることを前提として構成され、スキーマ上の enum に存在するがデータプレーンが拒否する項目（`Method.Engine`）を要求に含めない

### Requirement 7: scale-to-zero 適用可否の確認

**User Story:** As a 検証担当者, I want VECTORSEARCH コレクションのアイドル課金の実態を把握する, so that 想定外のランニングコストを避けられる

#### Acceptance Criteria

1. THE Vector_Collection_Group SHALL 最小 OCU を 0、最大 OCU を 2 に設定した構成で定義される（NextGen Collection Group の最大 OCU 許容値は 0、2、4、8、16 および 16 の倍数であり 2 は有効値である。us-west-2 の 0.24 USD/OCU-hour 換算で最悪ケース月額 350 USD = 2 OCU × 0.24 USD × 730 時間 を上限とする）
2. IF VECTORSEARCH タイプで最小 OCU 0 の設定が拒否される場合, THEN THE Vector_Collection_Group SHALL 拒否時に提示された許容値のうち最小の値を採用し、採用値・拒否理由の内容・月額見積（1 OCU × 0.24 USD × 730 時間 ≈ 175 USD/月）を記録する
3. WHEN Vector_Collection が検索リクエスト 0 件かつインデックスリクエスト 0 件の状態を 24 時間連続で維持したとき, THE Measurement_Collector SHALL CloudWatch の AWS/AOSS 名前空間における SearchOCU および IndexingOCU を 5 分間隔で取得した 24 時間分の系列から、各メトリクスの最小値・平均値・最大値を測定値として出力する（**運用上の注意：**24 時間連続の専用観測を実施できない場合は、遡及可能な最長窓での 0 OCU 区間の列挙で要件 7.4 / 7.6 の二値判定を確定させ、本項の 24 時間分の系列は未実施として理由と、代替した窓（区間長・ドキュメント件数・リクエスト有無）を明記する。本項の規範的要求そのものは変更しない。タスク 13.19 で確認）
4. IF 測定結果において SearchOCU と IndexingOCU がともに 0 となる連続 1 時間以上の区間が 24 時間中に存在しない場合, THEN THE Verification_Report SHALL scale-to-zero 非適用と判定し、常時課金の月額見積（測定した平均 OCU × 0.24 USD × 730 時間）と、Vector_Collection および Vector_Collection_Group の削除手順および削除完了の確認方法を記載する
5. WHEN Vector_Collection_Group のデプロイ要求が発行されたとき, THE Deployment_Validator SHALL 課金対象リソースを作成する前に最小 OCU 0 設定の受理可否を判定し、判定結果（受理、または拒否と拒否理由の内容）を検証担当者に提示する
6. IF 最小 OCU 0 設定が受理され、かつ測定結果において SearchOCU と IndexingOCU がともに 0 となる連続 1 時間以上の区間が存在する場合, THEN THE Verification_Report SHALL scale-to-zero 適用可と判定し、0 OCU 区間の合計時間とアイドル時月額見積 0 USD を記載する
7. IF 検証開始からの累積 OCU 課金見積（累積 OCU-hour × 0.24 USD）が 20 USD を超えた場合, THEN THE Measurement_Collector SHALL 測定を終了し、時点までの測定値を保持したうえで Vector_Collection および Vector_Collection_Group の削除実行を要求する警告を出力する（**運用上の注意：**`--watch-spend` の既定の集計区間は直近 24 時間のローリングウィンドウであり、検証開始からの通算ではない。本項の「累積」を評価するには `--hours` を検証開始時点まで遡る値に明示的に広げる必要がある。タスク 13.14 で確認）
8. THE Measurement_Collector SHALL Vector_Collection の右サイジング判断のため CloudWatch の AWS/AOSS 名前空間における `OCUUtilization` を測定区間について取得し、最小値・平均値・最大値を出力する（**実測で判明：**`OCUUtilization` は AWS/AOSS の ListMetrics に現れず（us-west-2 / NextGen VECTORSEARCH Collection Group）、SEARCH() でも系列 0 本である。本項は測定不能として扱い、Verification_Report には測定不能である旨と証拠（ListMetrics の返却メトリクス名一覧）を記載する。**不在が確認されたのは本アカウントの当該 Collection Group（us-west-2）についてであり、`ListMetrics` は直近約 14 日間にデータ点を持つメトリクスのみを列挙するため、AOSS 一般に当該メトリクスが存在しないことを示すものではない。**タスク 13.19 で確認）
9. THE Verification_Report SHALL ベクトルコレクションの OCU 使用量がインメモリベクトルに主に起因するため、SEARCH タイプコレクションと同等のアイドルコストになるとは限らないというリスクを、測定値とあわせて記載する

### Requirement 8: DynamoDB ベクトル検索の実行

**User Story:** As a 検証担当者, I want SearchVectors API による近傍検索を実行する, so that DynamoDB 側のレイテンシと精度を計測できる

#### Acceptance Criteria

1. WHEN クエリベクトル、TopK、および Query_Language を含む検索リクエストを受信したとき, THE DynamoDB_Vector_Lambda SHALL Vector_Table のテーブル名と Query_Language に対応する Vector_Index のインデックス名、クエリベクトル（各要素が 32bit IEEE-754 浮動小数、要素数はベクトルインデックス定義の次元数と一致）、TopK を指定して `SearchVectors` API を 1 回呼び出す
2. THE DynamoDB_Vector_Lambda SHALL Query_Language が `ja` の場合は日本語ベクトル用の Vector_Index のみ、`en` の場合は英語ベクトル用の Vector_Index のみを検索対象とし、Query_Language と異なる言語のインデックスを検索対象としない
3. THE DynamoDB_Vector_Lambda SHALL TopK として 1 以上 100 以下の整数のみを受け付ける
4. IF TopK が 101 以上の整数で指定された場合, THEN THE DynamoDB_Vector_Lambda SHALL TopK を 100 に丸めて `SearchVectors` を呼び出し、要求値と適用値の両方をレスポンスに含める
5. IF TopK が整数以外（小数・数値以外の文字列）または 0 以下で指定された場合, THEN THE DynamoDB_Vector_Lambda SHALL `SearchVectors` を呼び出さずに検証エラーを示すレスポンスを返却し、許容範囲が 1 以上 100 以下の整数であることを示す情報を含める
6. WHERE 倉庫が指定された場合, THE DynamoDB_Vector_Lambda SHALL warehouseId の等価条件のみを `SearchConditionExpression` に設定し、`ExpressionAttributeNames` および `ExpressionAttributeValues` で当該属性と値をバインドし、属性名と値を式文字列に直接埋め込まない
7. IF 範囲条件（大小比較・BETWEEN 等）を含むフィルタが要求された場合, THEN THE DynamoDB_Vector_Lambda SHALL `SearchVectors` を呼び出さず、範囲条件の対応可否が未確定であり実装既定が等価条件のみであることを示す制約メッセージを返却する
8. THE DynamoDB_Vector_Lambda SHALL `ProjectionExpression` により itemId、warehouseId、および結果表示に用いる非ベクトルのメタデータ属性のみを取得し、両言語の埋め込みベクトル属性をベクトルインデックスへの射影対象からもレスポンスからも除外する
9. THE DynamoDB_Vector_Lambda SHALL 各検索結果に COSINE 距離スコア（0 = 同一、2 = 正反対の範囲の数値）を含め、値が小さいほど類似度が高いことを示すラベルを付与し、結果をスコア昇順で返却する（**実測で確定：**`SearchResults[].Score` はコサイン距離（1 − cos）そのものであり変換を要しない。返却行の格納ベクトルからローカル算出した厳密距離との残差は 3.36e-8 であった。候補式 `1 − Score` / `2 − 2 × Score` / `1/Score − 1` はいずれも残差 0.8 以上で棄却した。したがって `VectorSearchHit.distance = rawScore = Score` とする。タスク 13.13 で実測。OpenSearch 側の対応は要件 9.5 と異なる）
10. WHEN 条件に合致する近傍が TopK 未満しか存在するとき, THE DynamoDB_Vector_Lambda SHALL 存在する件数のみを返却し、エラーとせず、要求 TopK と実際の返却件数（0 件を含む）の両方をレスポンスに含める
11. THE DynamoDB_Vector_Lambda SHALL `ReturnConsumedCapacity` を有効にし、`SearchVectors` が返した消費キャパシティ値として `VectorSearchRequestBytes` と `VectorSearchUnits` の 2 項目をレスポンスに含める（**実測で確定：**返るのはこの 2 項目のみであり、`VectorWriteRequestBytes` / `CapacityUnits` / `ReadCapacityUnits` / `Table` / `Indexes` はいずれも返らない。`ReturnConsumedCapacity: INDEXES` を指定しても内訳は返らない。`VectorSearchUnits` は SDK の `VectorCapacity` モデルに存在しない項目であるため、SDK の型に依存せず応答から取得する。観測値は `VectorSearchRequestBytes: 61318` / `VectorSearchUnits: 61318` であり、61,318 バイトは 1,024 次元 f32 のクエリ（4 KiB）より一桁大きい。フィールド名に反してリクエストサイズではなく走査量に応じた単位である可能性が高いが断定はせず、TopK 依存かをタスク 13.18 で確認する。タスク 13.13 で実測）
12. THE DynamoDB_Vector_Lambda SHALL サーバー側で計測した 2 つのレイテンシ値をミリ秒単位の数値としてレスポンスに含める。1 つは `SearchVectors` 呼び出し直前から呼び出し完了（レスポンス受信完了）までの区間、もう 1 つはハンドラ開始からレスポンス生成完了までの区間とする
13. WHEN Lambda 実行環境が初期化された直後の呼び出し（コールドスタート）であるとき, THE DynamoDB_Vector_Lambda SHALL 当該呼び出しがコールドスタートであることを示す真偽値をレスポンスに含める
14. THE DynamoDB_Vector_Lambda SHALL `SearchVectors` の `SearchVector` パラメータを `AttributeValue` の配列（各要素が `{"N": "<数値>"}` 形式）として渡す（**実測で確定：**素の数値配列は HTTP 400 `SerializationException` で拒否される。タスク 13.13 で実測）
15. THE DynamoDB_Vector_Lambda SHALL `SearchVectors` の生レスポンスにベクトル本体が含まれないことを前提として結果を組み立てる（射影に埋め込み属性を含めていないため。要件 5.6 / 8.8。タスク 13.13 で実測）

### Requirement 9: OpenSearch k-NN 検索の実行

**User Story:** As a 検証担当者, I want k-NN クエリによる近傍検索を実行する, so that OpenSearch 側のレイテンシと精度を計測できる

#### Acceptance Criteria

1. WHEN クエリベクトル、k、および Query_Language を受け取った場合, THE OpenSearch_Vector_Lambda SHALL Requirement 3 と同一次元数のベクトルと 1 以上 100 以下の k で、Query_Language に対応する `knn_vector` フィールドに対する knn クエリを実行し、レスポンス取得時に `_source` から両言語の `knn_vector` フィールドを除外する
2. THE OpenSearch_Vector_Lambda SHALL Query_Language が `ja` の場合は日本語ベクトルフィールドのみ、`en` の場合は英語ベクトルフィールドのみを検索対象とし、Query_Language と異なる言語のフィールドを検索対象としない
3. THE OpenSearch_Vector_Lambda SHALL DynamoDB_Vector_Lambda に渡されたものと全要素値が一致するクエリベクトル、同一の k、および同一の Query_Language を使用して検索する
4. WHERE 倉庫が指定された場合, THE OpenSearch_Vector_Lambda SHALL keyword 型として定義された `warehouseId` に対する term フィルタを knn クエリの `filter` 句内（k-NN 探索と同時に評価されるフィルタ）に指定し、検索後に結果集合を絞り込む後段フィルタを使用しない
5. THE OpenSearch_Vector_Lambda SHALL 各検索結果に OpenSearch の生スコアと、使用エンジンおよびバージョンにおける `cosinesimil` のスコア定義から逆算した 0 以上 2 以下のコサイン距離値の両方を含め、逆算式を `正規化距離 = 2 − 2 × 生スコア`（式 A）とし、正規化距離は値が小さいほど類似度が高いことを示すラベルを付与する（**実測で確定：**式 A の最大残差は 1.23e-7 であり閾値 1e-3 を 4 桁下回った。式 B（`1 / 生スコア − 1`）は 1.72e-1、参考の `距離 = 生スコア` は 4.81e-1、`距離 = 1 − 生スコア` は 2.95e-1 でいずれも棄却した。すなわち現行の k-NN spaces ドキュメントの `score = (2 − d) / 2` が AOSS の VECTORSEARCH コレクションに成立し、旧版の nmslib / faiss 記述（`score = 1 / (1 + d)`）は成立しない。タスク 13.15 で実測。**DynamoDB 側は要件 8.9 のとおり `Score` が距離そのものであり、両バックエンドでスコアと距離の対応が異なる**）
6. WHEN Vector_Collection のデプロイおよびデータ投入が完了したとき, THE Measurement_Collector SHALL 既知のベクトル対に対する局所計算による厳密なコサイン距離と各候補式による算出値を比較し、採用する逆算式と最大残差を確定して Verification_Report に記録する（**実測条件：**2026-08-21 / us-west-2 / `SpaceType: cosinesimil` / 1,024 次元 / Paired_Query_Set から 5 本（ja 3 / en 2）× 上位 10 件 = 50 件。格納ベクトル 50 件とクエリベクトル 5 本のノルムはいずれも 1 ± 1e-7 であり、正規化状態の食い違いは存在しなかったため、faiss の取り込み時正規化と Titan の `normalize` 設定を再検証する手順は不要であった）
7. THE OpenSearch_Vector_Lambda SHALL `_search` レスポンスの `took` 値を単位変換せず ms 単位の測定値としてレスポンスに含める
8. THE OpenSearch_Vector_Lambda SHALL 検索リクエスト送信開始からレスポンス受信完了までのサーバー側レイテンシを ms 単位で計測し、`took` とは別の測定値としてレスポンスに含める
9. IF Vector_Collection への検索リクエストが 30,000 ms 以内に完了しない場合, THEN THE OpenSearch_Vector_Lambda SHALL リクエストを打ち切り、Cold_Start の可能性を示すエラーメッセージ、打ち切りまでの経過時間（ms 単位）、および再試行可能であることを示す情報を返却し、部分的な検索結果を返却しない
10. IF フィルタを付与した検索の結果が 0 件であり、かつ同一クエリベクトルでフィルタを外した検索が 1 件以上返す場合, THEN THE OpenSearch_Vector_Lambda SHALL フィルタ対象フィールドのマッピング不一致の可能性を示すメッセージと、実際に使用したフィルタフィールド名を返却する
11. IF フィルタ適用後の結果件数が k 未満である場合, THEN THE OpenSearch_Vector_Lambda SHALL 返却件数、k、およびフィルタ条件下で近傍候補が不足していることを示す注記をレスポンスに含める
12. IF 算出した正規化距離が 0 未満または 2 超過となる場合, THEN THE OpenSearch_Vector_Lambda SHALL 該当結果に距離基準の不一致を示すフラグを付与し、生スコアを保持したまま結果を返却する

### Requirement 10: クエリ埋め込みの生成

**User Story:** As a 検証担当者, I want 自然言語のクエリ文字列を指定言語の埋め込みベクトルに変換する, so that 検索フォームから意味検索を実行できる

#### Acceptance Criteria

1. WHEN クエリ文字列と Query_Language を受け取った場合, THE Query_Embedding_Lambda SHALL Requirement 3 と同一のモデル（`amazon.titan-embed-text-v2:0`）および同一の次元数（既定 1024）で、Requirement 2 の埋め込み対象テキストと同一の前処理（前後空白の除去、連続する空白文字の 1 文字への圧縮）を適用したうえで、レイテンシ最適化された推論呼び出しが利用可能な場合はそれを使用し、モデルまたはリージョンが未対応の場合は標準推論へフォールバックして 1 本の埋め込みベクトルを生成し、使用した推論経路を示す識別子（`latency_optimized` または `standard`）をレスポンスに含める（旧版の本項は「レイテンシ最適化された推論呼び出しを使用して」と無条件に指定していたが、`amazon.titan-embed-text-v2:0` は us-west-2 でレイテンシ最適化推論に未対応であり、全リクエストが HTTP 400 になって両検索エンドポイントが `queryId` を得られなくなった。A21 参照）
2. THE Query_Embedding_Lambda SHALL 生成したベクトルを Requirement 3 と同一の規則で f32 に丸めた値として保持する
3. THE Query_Embedding_Lambda SHALL 生成した 1 本のベクトルをサーバー側の Query_Vector_Cache に保持し、DynamoDB_Vector_Lambda と OpenSearch_Vector_Lambda の双方が同一の値（全要素が一致する配列）を参照できるハンドルを返却し、ブラウザへ返却するレスポンスにはベクトル本体を含めない
4. THE Query_Embedding_Lambda SHALL 受け取った Query_Language を検索リクエストに引き継ぎ、両バックエンドが同一の Query_Language で検索するようにする
5. THE Query_Embedding_Lambda SHALL 埋め込み生成の開始から完了までにサーバー側で計測したレイテンシを ms 単位の整数として、検索レイテンシとは別の項目でレスポンスに含める
6. IF クエリ文字列が空文字列である場合、または空白文字（半角スペース、全角スペース、タブ、改行）のみで構成される場合, THEN THE Query_Embedding_Lambda SHALL Bedrock を呼び出さずに入力エラーを示すメッセージを返却し、両バックエンドの検索を実行しない
7. IF Query_Language が `ja` および `en` のいずれでもない場合, THEN THE Query_Embedding_Lambda SHALL Bedrock を呼び出さずに入力エラーと許容値の一覧を返却し、両バックエンドの検索を実行しない
8. IF Bedrock がスロットリングエラーを返した場合, THEN THE Query_Embedding_Lambda SHALL 指数バックオフで最大 3 回まで再試行し、再試行が上限に達した場合は再試行可能であることを示すエラーメッセージと経過時間（ms 単位）を返却し、両バックエンドの検索を実行しない
9. IF 前処理後のクエリ文字列が 1,000 文字を超える場合, THEN THE Query_Embedding_Lambda SHALL 切り詰めを行わず、上限文字数を超えたことを示す入力エラーメッセージを返却し、Bedrock を呼び出さない
10. THE Query_Embedding_Lambda SHALL 既定で埋め込み結果をキャッシュせず、同一のクエリ文字列と同一の Query_Language が連続して要求された場合も毎回 Bedrock を呼び出す
11. WHERE キャッシュが有効化された場合, THE Query_Embedding_Lambda SHALL レスポンスにキャッシュヒットであることを示す真偽値を含め、キャッシュヒット時のレイテンシを Bedrock 呼び出し時のレイテンシと区別できる項目として返却する
12. THE Query_Embedding_Lambda SHALL 日本語を含むクエリ文字列に対して、翻訳および言語ごとの追加処理を行わず、Requirement 3 と同一のモデルおよび同一の前処理のみを適用する
13. IF レイテンシ最適化推論による呼び出しが、モデルまたはリージョンがレイテンシ最適化推論に未対応であることを示すエラーで失敗した場合, THEN THE Query_Embedding_Lambda SHALL 同一のモデル・同一の次元数・同一の入力本文でレイテンシ最適化の指定を外した標準推論を実行し、使用した推論経路を `standard` としてレスポンスに含める（未対応を示すエラーの実測本文は `Latency performance configuration is not supported for amazon.titan-embed-text-v2:0 in us-west-2` である。A21 参照）
14. IF レイテンシ最適化推論による呼び出しが、モデルまたはリージョンの未対応を示さない `ValidationException`（入力本文の不正など）で失敗した場合, THEN THE Query_Embedding_Lambda SHALL 標準推論へのフォールバックを行わず、当該失敗を再試行不可のエラーとして返却する
15. THE Query_Embedding_Lambda SHALL レイテンシ最適化推論から標準推論へのフォールバックを 1 回の埋め込み生成要求につき 1 回のみ実行し、フォールバック後の標準推論の失敗に対して更なるフォールバックを行わない（本フォールバックは要件 3.11 / 4.7 / 10.8 のスロットリング再試行とは別系統の機構であり、フォールバック回数をスロットリング再試行の回数に加算しない）

### Requirement 11: ベクトル検索比較 UI

**User Story:** As a 検証担当者, I want 1 回の検索操作で両バックエンドの結果を並べて見る, so that 差分を即座に把握できる

#### Acceptance Criteria

1. THE Vector_Search_UI SHALL 既存の在庫管理ダッシュボードのタブ一覧に「ベクトル検索比較」タブを追加し、タブ切り替えのみで表示できるようにする
2. THE Vector_Search_UI SHALL 自然言語クエリ入力欄（最大 200 文字）、検索言語セレクター、倉庫セレクター、TopK 指定欄、検索ボタンを提供し、各入力要素に対応する可視ラベルを関連付ける
3. THE Vector_Search_UI SHALL 検索言語セレクターに「日本語」と「English」の 2 つの選択肢を提供し、初期選択を「日本語」とする
4. WHEN 検索言語セレクターの値が変更された場合, THE Vector_Search_UI SHALL 選択された言語を両パネルの検索に同時に適用し、DynamoDB 側と OpenSearch 側で異なる言語を使用しない
5. THE Vector_Search_UI SHALL TopK 指定欄の入力可能範囲を 1 以上 100 以下の整数に制限し、初期値を 30 とする
6. IF TopK 指定欄に 1 未満、100 超、または整数以外の値が入力された場合, THEN THE Vector_Search_UI SHALL 検索を実行せず、入力欄に許容範囲（1〜100 の整数）を示すエラーを表示し、直前の検索結果を保持する
7. THE Vector_Search_UI SHALL 倉庫セレクターの初期選択を「全倉庫」（倉庫フィルタなし）とし、「全倉庫」に加えて WH-TOKYO を含む個別倉庫を選択肢として提供する
8. WHEN 個別倉庫が選択された状態で検索が実行された場合, THE Vector_Search_UI SHALL 倉庫フィルタを選択値との完全一致条件として両バックエンドに送信する
9. IF 自然言語クエリ入力欄が空文字または空白のみである場合, THEN THE Vector_Search_UI SHALL 検索ボタンを操作不可状態にする
10. WHILE 検索リクエストが実行中である場合, THE Vector_Search_UI SHALL 検索ボタンを操作不可状態にし、実行中であることを示す表示を行う
11. WHEN 検索ボタンが押された場合, THE Vector_Search_UI SHALL クエリ埋め込みをサーバー側で 1 回だけ生成し、同一のベクトルを両バックエンドへのリクエストに使用する
12. WHEN 両バックエンドへのリクエストを送信する場合, THE Vector_Search_UI SHALL 2 つのリクエストを同時に開始し、一方の完了を他方の完了まで待たずに、完了した側のパネルから順に結果を表示する
13. WHEN 前回の検索が完了する前に新しい検索が開始された場合, THE Vector_Search_UI SHALL 最後に開始した検索の結果のみを表示し、それ以前の検索の応答を結果表示に反映しない
14. THE Vector_Comparison_View SHALL 左パネルに DynamoDB Vector Search の結果、右パネルに OpenSearch k-NN の結果を表示する
15. THE Vector_Comparison_View SHALL 各パネルに検索レイテンシ（ms 単位の整数）、結果件数、各アイテムの類似度スコア、および検索に使用した言語を表示する
16. THE Vector_Comparison_View SHALL 埋め込み生成レイテンシを検索レイテンシとは別項目として、ms 単位の整数で表示する
17. THE Vector_Comparison_View SHALL 両バックエンドの検索レイテンシを比較するバー表示を提供し、各バーに対応するバックエンド名とレイテンシ値をテキストとして併記する
18. THE Vector_Comparison_View SHALL 左右各パネルを見出し付きの領域として提供し、キーボード操作のみでパネル内の結果一覧まで到達できるようにする
19. WHEN パネルの結果、エラー、またはレイテンシ表示が更新された場合, THE Vector_Comparison_View SHALL 更新内容をスクリーンリーダーに通知する
20. WHEN 画面幅が 768px 以下である場合, THE Vector_Comparison_View SHALL 左右パネルを縦並びレイアウトに切り替え、DynamoDB パネルを上、OpenSearch パネルを下に配置する
21. WHILE OpenSearch への検索リクエストが未完了である場合, THE Vector_Comparison_View SHALL 右パネルにローディング表示とリクエスト開始からの経過秒数を表示する
22. IF 一方のバックエンドがエラーを返した場合, THEN THE Vector_Comparison_View SHALL 該当パネルにのみ失敗した旨を示すエラーを表示し、他方のパネルの結果表示とレイテンシ表示を継続する
23. IF いずれかのバックエンドが 35 秒以内に応答しなかった場合, THEN THE Vector_Comparison_View SHALL 該当パネルにタイムアウトを示すエラーを表示し、他方のパネルの表示を保持する
24. THE Vector_Search_UI SHALL 既存の「在庫管理」タブおよび「検索比較」タブの表示内容と動作を変更しない

### Requirement 12: 結果の重なりと順位差の可視化

**User Story:** As a 検証担当者, I want 両バックエンドの結果集合の一致度を確認する, so that 近似検索の挙動差を判断できる

#### Acceptance Criteria

1. WHEN 同一クエリベクトルに対する DynamoDB SearchVectors と OpenSearch k-NN の両検索が正常終了したとき, THE Vector_Comparison_View SHALL アイテム同一性を (itemId, warehouseId) の複合キーの完全一致で判定し、両結果集合に共通して含まれるアイテム数を 0 以上 100 以下の整数で表示する
2. THE Vector_Comparison_View SHALL 同一 SKU の 3 倉庫行が同一ベクトルを持つため検索結果が倉庫三つ組として現れることを示す注記を、共通アイテム数および各件数の表示に併記し、表示される行数と一意 SKU 件数の両方を整数で表示する
3. WHEN 両検索が正常終了したとき, THE Vector_Comparison_View SHALL 重なりの度合いを、共通アイテム数を両結果集合の和集合サイズで割った Jaccard 係数（0.000 以上 1.000 以下、小数第 3 位まで）と、共通アイテム数を両結果件数の最小値で割った overlap@k 比率（0.000 以上 1.000 以下、小数第 3 位まで）の 2 指標として表示する
4. WHEN 両検索が正常終了したとき, THE Vector_Comparison_View SHALL 一方の結果集合にのみ含まれる各アイテムについて、(itemId, warehouseId)、含まれるバックエンド名、および当該バックエンドでの順位を一覧表示し、DynamoDB 側のみ・OpenSearch 側のみの件数をそれぞれ整数で表示する
5. WHEN 両検索が正常終了したとき, THE Vector_Comparison_View SHALL 共通アイテムごとに DynamoDB 側順位と OpenSearch 側順位（いずれも 1 以上 100 以下の整数）を併記し、両順位の差の絶対値を整数で表示する
6. WHEN 両検索が正常終了したとき, THE Vector_Comparison_View SHALL 共通アイテムごとに、Requirement 9 で正規化された同一の距離基準（0.0000 以上 2.0000 以下、値が小さいほど類似）で両バックエンドのスコアを小数第 4 位まで表示し、両スコアの差の絶対値を小数第 4 位まで表示する
7. IF 共通アイテムの正規化距離の差の絶対値が 0.0010 以下である, THEN THE Vector_Comparison_View SHALL 当該アイテムを許容誤差内で一致とみなす識別表示を付与し、0.0010 を超える場合はスコア差ありとして区別可能な識別表示を付与する
8. IF いずれかのバックエンドの検索がエラー終了した、または結果件数が 0 件である, THEN THE Vector_Comparison_View SHALL 共通アイテム数・Jaccard 係数・overlap@k・順位差を算出不可として表示し、算出不可の理由（対象バックエンドのエラー発生または 0 件）を示し、正常終了した側の結果一覧は破棄せず表示を維持する

### Requirement 13: recall@k の測定

**User Story:** As a 検証担当者, I want SKU 粒度で正解集合に対する recall を言語別に測定する, so that 「recall 99% 以上」の主張と日本語埋め込みの実用性を実データで検証できる

#### Acceptance Criteria

1. THE Recall_Evaluator SHALL itemId 単位で重複排除した 5,000 件の一意な SKU ベクトル（同一 itemId の 3 倉庫行は同一ベクトルとして 1 件に数える）を対象に、float32 精度でクエリベクトルとのコサイン距離を全件厳密計算し、Distinct_Sku_K = 1 / 10 / 33 の各値について Ground_Truth の上位 Distinct_Sku_K 件を決定する
2. THE Recall_Evaluator SHALL Ground_Truth を Query_Language ごとに独立して計算し、日本語ベクトル集合から算出した Ground_Truth と英語ベクトル集合から算出した Ground_Truth を混用しない
3. THE Recall_Evaluator SHALL Distinct_Sku_K 件の一意 SKU を得るために両バックエンドへ TopK = 3 × Distinct_Sku_K を要求し、TopK 上限 100 により Distinct_Sku_K の上限が 33（100 ÷ 3 倉庫）であることを出力に含める
4. THE Recall_Evaluator SHALL 各バックエンドの返却行を itemId 単位で重複排除したうえで上位 Distinct_Sku_K 件の itemId 集合を求め、当該集合と Ground_Truth の itemId 集合の積集合の要素数を Distinct_Sku_K で除した値を Recall_At_K として算出する
5. THE Recall_Evaluator SHALL OpenSearch k-NN に対して同一のクエリベクトル、同一の TopK、同一の Distinct_Sku_K、同一の Ground_Truth を用い、Recall_At_K を criterion 4 と同一の算出式で算出する
6. THE Recall_Evaluator SHALL 固定した乱数シードから選定した 50 件以上の Paired_Query_Set を用いて測定を実行し、各バックエンド、各言語、および各 Distinct_Sku_K について Recall_At_K の平均値、最小値、および 0.99 を下回ったクエリ件数を出力する
7. THE Paired_Query_Set SHALL 各要素を、同一の意味的意図を表す日本語クエリ文字列と英語クエリ文字列の 1 対 1 の組として構成し、言語間比較が意味的に対応しないクエリ同士の比較にならないようにする
8. WHEN 全クエリの測定が完了した場合, THE Recall_Evaluator SHALL 同一の Paired_Query_Set および同一の Distinct_Sku_K について、日本語の平均 Recall_At_K と英語の平均 Recall_At_K の差（小数第 3 位まで）を各バックエンドについて出力する
9. THE Recall_Evaluator SHALL 出力に、クエリ件数、乱数シード値、測定した Distinct_Sku_K の値、要求した TopK の値、Ground_Truth 対象の一意ベクトル件数、重複排除の単位（itemId）、対象言語、適用したフィルタ条件を含める
10. THE Recall_Evaluator SHALL 測定結果を機械可読な形式で出力し、同一の Paired_Query_Set と同一の乱数シードで再実行した場合に同一の Ground_Truth と同一の Recall_At_K を再現する
11. WHEN 全クエリの測定が完了した場合, THE Recall_Evaluator SHALL 各バックエンド、各言語、および各 Distinct_Sku_K について平均 Recall_At_K が 0.99 以上であるかを判定し、判定結果（合格 / 不合格）と判定に用いた閾値 0.99 を出力に含める
12. IF Ground_Truth の Distinct_Sku_K 番目と Distinct_Sku_K + 1 番目のコサイン距離の差が 1e-6 以下である場合, THEN THE Recall_Evaluator SHALL itemId の昇順で順位を決定論的に確定し、同値により順位が一意に定まらなかった件数を出力に含める
13. THE Recall_Evaluator SHALL 各バックエンドの返却行において距離が完全一致した行の件数を出力に含める（同一ベクトルの 3 行複製により境界での完全同値が頻出するため、測定上の危険要因として定量化する）
14. WHERE warehouseId の等価フィルタを有効にして測定する場合, THE Recall_Evaluator SHALL 該当 warehouseId のレコードに限定した一意ベクトル集合から Ground_Truth を再計算し、フィルタ無効時の Ground_Truth と混用せずに Recall_At_K を算出する
15. WHEN 風味に関する意味的クエリ（フレーバー・ボディ・酸味を表現するクエリ）で検索したとき, THE Recall_Evaluator SHALL 上位 Distinct_Sku_K 件に含まれる Material_Sku の件数を出力し、当該件数が 0 件であるかを判定結果として含める

### Requirement 14: コストとリソース消費の測定

**User Story:** As a 検証担当者, I want 追加コストを定量的に把握する, so that 業務導入時の見積根拠を得られる

#### Acceptance Criteria

1. WHEN Embedding_Batch_Job が 5,000 SKU × 2 言語の埋め込み生成を完了したとき, THE Embedding_Batch_Job SHALL Bedrock 呼び出し回数、入力トークン数の合計、リトライを含む失敗呼び出し回数、および所要時間（秒、小数第 1 位まで）を、言語別および合計で機械可読形式で出力する
2. WHEN Measurement_Collector が Vector_Table のストレージ増分を測定するとき, THE Measurement_Collector SHALL `DescribeTable` の `TableSizeBytes` を (S1) 埋め込み属性の書き込み開始前、(S2) 埋め込み属性の書き込み完了後かつ Vector_Index 作成前の 2 時点で取得し、各値と取得時刻（UTC）に加えて、ベクトル属性の寄与（S2 − S1）、15,000 レコードで除した 1 レコードあたり平均増分（バイト）を出力する
3. WHEN Vector_Index が ACTIVE かつバックフィル完了となった後, THE Measurement_Collector SHALL 各 Vector_Index について `DescribeTable` の `VectorIndexDescription` に含まれる `IndexSizeBytes` と `ItemCount` を直接取得し、2 本のインデックスそれぞれの値と合計値を出力し、`TableSizeBytes` スナップショットの差分による算出を行わない
4. WHEN Measurement_Collector が `TableSizeBytes` および `IndexSizeBytes` の各値を採用するとき, THE Measurement_Collector SHALL 両フィールドが約 6 時間周期で更新されることを前提として、対象操作の完了から 6 時間以上経過した後に取得し、かつ 6 時間以上の間隔をあけた連続 2 回の取得値の差が 1% 以内であることを確認した値のみを採用値として出力する
5. IF 連続 2 回の取得値の差が 1% を超える場合, THEN THE Measurement_Collector SHALL 当該スナップショットを未確定として記録し、6 時間間隔での再取得を最大 3 回まで実施し、3 回目でも 1% 以内に収束しない場合は最終取得値と「未確定」である旨および差分の推定誤差幅を出力する（先行するスナップショットは破棄しない）
6. THE Measurement_Collector SHALL ストレージ測定が GSI を持たない Vector_Table を対象とするため、ベクトル属性の寄与が GSI への複製分を差し引かずに直接得られることを出力に注記する
7. WHEN Measurement_Collector が DynamoDB の消費キャパシティを測定するとき, THE Measurement_Collector SHALL `SearchVectors` に `ReturnConsumedCapacity` を指定した検索を同一条件で 100 回実行し、1 検索あたり消費キャパシティの平均値・最小値・最大値および 100 回の合計値を、使用したクエリ件数、TopK の値、および対象言語とともに出力する
8. WHEN 100 回の検索実行が完了したとき, THE Measurement_Collector SHALL CloudWatch メトリクス `VectorSearchRequestBytes`（ディメンション TableName, VectorIndexName）について、測定区間の合計値と 1 検索あたり平均値を、測定区間の開始時刻・終了時刻（UTC）とともに出力する
9. WHEN Measurement_Collector が Vector_Collection の OCU 使用量を測定するとき, THE Measurement_Collector SHALL 検索を継続実行する区間（連続 30 分以上）とアイドル区間（検索を一切実行しない連続 6 時間以上）のそれぞれについて、区間長（分）と消費 OCU-時間を出力する
10. THE Verification_Report SHALL PoC 規模（5,000 SKU / 15,000 レコード / 2 言語）の測定値から算出した月額 USD 見積を、埋め込み生成（初回のみ、2 言語分）、DynamoDB ストレージ、DynamoDB 検索、OpenSearch 検索時 OCU、OpenSearch アイドル時 OCU の内訳で記載し、採用した単価（Bedrock Titan v2 の 1,000 入力トークンあたり単価、DynamoDB オンデマンドの読み書き単価およびストレージ単価、OpenSearch の 1 OCU-時間あたり単価 0.24 USD）、対象リージョン（us-west-2）、および想定クエリ量（1 日 10,000 クエリ = 月 300,000 クエリ）を前提条件として明記する
11. THE Verification_Report SHALL 本番想定規模（50,000 SKU × 3 倉庫 = 150,000 レコード、月 300,000 クエリ）に線形換算した月額 USD 見積を、Acceptance Criteria 10 と同一の内訳項目・同一単価で記載し、線形換算が成立しない項目（アイドル時 OCU など規模に依存しない固定費）を区別して示す
12. WHERE 次元数を 512 または 256 に変更して測定を実施した場合, THE Verification_Report SHALL 1,024 / 512 / 256 の各次元数について、ベクトル属性の寄与、`IndexSizeBytes` の合計、1 レコードあたり平均増分、同一 Paired_Query_Set に対する言語別の Recall_At_K の平均値、および Acceptance Criteria 11 の本番想定規模での月額 USD 見積を同一の表形式で対比して記載し、ストレージおよびインデックスの増分が 2 言語分として計上されることを明記する

### Requirement 15: 機能制約の比較整理

**User Story:** As a 検証担当者, I want 両バックエンドの機能差を明示的に並べる, so that 選定判断の材料にできる

#### Acceptance Criteria

1. THE Vector_Comparison_View SHALL 検索実行前・実行中・実行後のいずれの状態でも、DynamoDB 側と OpenSearch 側を対比する 1 つの機能制約比較表を常時表示し、その表内に DynamoDB 側の TopK 上限が 100 件であること、および OpenSearch 側に同等の TopK 上限がないことを対比して表示する
2. THE Vector_Comparison_View SHALL 機能制約比較表のフィルタ条件行に、実測で確認したフィルタ対応種別をバックエンドのレスポンスから取得して DynamoDB 側と OpenSearch 側で対比表示し、DynamoDB 側の範囲条件の対応可否が公式ドキュメント間で矛盾していたものの**実測で非対応を確認済み**であることを併記する（**実測で確定：**等価条件 `#f = :eq` は HTTP 200、`>` / `>=` / `<` / `<=` および `>= AND <=` の複合は HTTP 400 `Invalid comparator used in SearchConditionExpression`、`BETWEEN` と `IN` は HTTP 400 `Invalid operator used in SearchConditionExpression` であった。開発者ガイドの記述が正しく、SDK API リファレンスの記述が誤りである。逐語のエラー本文は `docs/measurements/range-filter-probe-2026-08-21T23-43-31-870Z.json` に記録済み。`supportedFilterKinds: ['equality']` は当初から正しく、変更しない。旧版の本項は「実測で確定させる対象である」ことの併記を求めていたが、確定済みの事実の併記に改める。タスク 13.16 で実測）
3. THE Vector_Comparison_View SHALL 機能制約比較表の DynamoDB 側に、距離関数が Vector_Index 作成時に COSINE で固定されインデックス再作成なしには変更できないこと、Vector_Table のオンデマンド課金が前提条件であること、ベクトル次元数の上限が 4,096 であること、およびベクトルインデックスが `Query` / `Scan` / PartiQL では読み取れないことを表示する
4. THE Vector_Comparison_View SHALL 機能制約比較表の OpenSearch 側に、範囲フィルタ、全文検索との併用、集約、地理空間クエリ、ネストクエリへの対応と、ベクトル次元数の上限 16,000 を表示し、同じ行の DynamoDB 側には非対応または該当する上限値を併記する
5. THE Vector_Comparison_View SHALL 検索結果の有無に関わらず、Titan Text Embeddings V2 の正式サポート言語が英語であり日本語を含む 100 言語以上はプレビュー扱いであること、本機能では日本語と英語の 2 本のベクトルを独立生成して言語別に Recall_At_K を測定しており測定した言語間差分が Verification_Report に記載されていること、両バックエンドが同一ベクトルを使用するため DynamoDB 対 OpenSearch の比較の公平性は保たれることを注意書きとして常時表示する
6. THE Vector_Comparison_View SHALL 機能制約比較表に表示する TopK 上限値、対応フィルタ種別、および次元数上限を、バックエンドのレスポンスに含まれる制約情報から取得して表示し、画面側に固定値を保持しない
7. IF 範囲条件を含むフィルタが DynamoDB 側に対して要求された場合, THEN THE Vector_Comparison_View SHALL レスポンス受信から 1 秒以内に DynamoDB パネル内へ実装既定が等価条件のみであることを示す制約メッセージを表示し、機能制約比較表の該当行をテキストラベル併記（色のみに依存しない）で強調し、スクリーンリーダーに読み上げられる領域として通知し、入力済みの検索条件を保持する
8. THE Vector_Comparison_View SHALL 機能制約比較表を見出しセルを持つ表構造として提供し、各制約項目の対応・非対応をテキストで表現する（色、アイコン、記号のみに依存しない）

### Requirement 16: エラー処理

**User Story:** As a 検証担当者, I want 失敗理由が判別できるエラー表示を得る, so that 原因の切り分けができる

#### Acceptance Criteria

1. IF 検索要求のクエリベクトルの次元数が対象インデックスの次元数と一致しない場合, THEN THE DynamoDB_Vector_Lambda SHALL 検索を実行せず、エラーコード `DIMENSION_MISMATCH`、クエリベクトルの次元数とインデックスの次元数の両方の整数値、および再試行不可であることを示す再試行可否情報を含むエラー応答を返却する
2. IF 検索要求時に Query_Language に対応する Vector_Index が存在しない場合, THEN THE DynamoDB_Vector_Lambda SHALL 検索を実行せず、エラーコード `INDEX_NOT_FOUND`、対象インデックス名、および再試行不可であることを示す再試行可否情報を含むエラー応答を返却する
3. IF 対象の Vector_Index が存在し、かつ `IndexStatus` が ACTIVE 以外である、または `Backfilling` が真である場合, THEN THE DynamoDB_Vector_Lambda SHALL 検索を実行せず、エラーコード `INDEX_BUILDING`、`IndexStatus` と `Backfilling` の両方の値（`Backfilling` フィールドが `DescribeTable` の応答に存在しない場合は不在であることを示す値）、再試行可能であることを示す再試行可否情報、および再試行推奨待機秒数（1 秒以上 300 秒以下）を含むエラー応答を返却する（実測では `CREATING` かつバックフィル中に `true` が返る一方、ACTIVE 到達後は当該フィールドが不在であった。要件 5.17 参照。A22 参照）
4. IF Vector_Collection の対象インデックスが存在し、かつ登録ドキュメント数が 0 件の場合, THEN THE OpenSearch_Vector_Lambda SHALL エラーではなく正常応答として、結果 0 件、登録ドキュメント数 0、およびデータ未投入を示す状態コード `NO_DOCUMENTS` を返却する
5. IF Query_Embedding_Lambda からの Bedrock 呼び出しが失敗した場合, THEN THE Query_Embedding_Lambda SHALL 失敗した処理段階が埋め込み生成であることを示す段階識別子 `EMBEDDING`、失敗原因に対応するエラーコード 1 件、および再試行可否情報を含むエラー応答を返却する
6. IF 検索要求時に指定された Query_Vector_Cache のハンドルが失効している場合, THEN THE DynamoDB_Vector_Lambda および THE OpenSearch_Vector_Lambda SHALL 検索を実行せず、エラーコード `QUERY_EXPIRED`、再試行可能であることを示す再試行可否情報、および埋め込み生成からの再実行が必要であることを示す情報を返却する
7. IF Query_Embedding_Lambda、DynamoDB_Vector_Lambda、または OpenSearch_Vector_Lambda における下位サービス呼び出しが失敗した場合, THEN THE 該当 Lambda SHALL 失敗原因を、IAM 権限不足を示す `ACCESS_DENIED_IAM`（再試行不可）、データアクセスポリシー不足を示す `ACCESS_DENIED_DATA_POLICY`（再試行不可）、リソース未検出を示す `RESOURCE_NOT_FOUND`（再試行不可）、流量制限を示す `THROTTLED`（再試行可能、再試行推奨待機秒数 1 秒以上 60 秒以下）、上記以外を示す `INTERNAL_ERROR`（再試行不可）のいずれか 1 つのエラーコードに分類して返却する
8. WHEN 埋め込み生成が失敗した場合, THE Vector_Search_UI SHALL DynamoDB_Vector_Lambda と OpenSearch_Vector_Lambda のいずれも呼び出さず、両パネルを未実行状態として表示し、埋め込み生成エラーのエラーコードと再試行可否のみを表示する
9. WHEN いずれかの Lambda がエラー応答を Vector_Search_UI へ返却する場合, THE 該当 Lambda SHALL 応答に ARN、AWS アカウント ID、認証情報、およびスタックトレースを含めず、エラーコード、500 文字以内の説明文、再試行可否情報のみを含める
10. IF 下位サービスが `ValidationException` を返し、かつその原因がクエリ文字列の妥当性（空文字、空白文字のみ、上限文字数超過）に起因しない場合, THEN THE 該当 Lambda SHALL 当該エラーを `INVALID_QUERY` として分類せず、要件 16.7 の分類規則に従うエラーコードで返却する（旧実装は Bedrock の `ValidationException` を既定分岐で `INVALID_QUERY` に分類し、真因が「レイテンシ最適化推論の未対応」であるにもかかわらず「クエリ文字列が空、または空白文字のみです。」という定型文を付与していた。真因は詳細欄に残るため切り分けは可能であったが、利用者を誤誘導する。A21 参照）
11. THE 該当 Lambda SHALL エラー応答の説明文を、付与するエラーコードの発生条件と矛盾しない内容に限定し、当該エラーコードの発生条件を満たさない失敗に対して当該条件を述べる定型文を付与しない

### Requirement 17: IAM 権限とセキュリティ

**User Story:** As a 運用担当者, I want 追加権限を最小限に保つ, so that 権限拡大のリスクを抑えられる

#### Acceptance Criteria

1. THE DynamoDB_Vector_Lambda SHALL `dynamodb:SearchVectors` のみを Action に列挙し、Resource を 2 本の Vector_Index の ARN のみに限定し、Vector_Table のテーブル ARN、`dynamodb:PutItem` / `dynamodb:UpdateItem` / `dynamodb:DeleteItem` / `dynamodb:BatchWriteItem`、および `dynamodb:*` を含まないポリシーを付与される
2. THE Index_Provisioner SHALL Vector_Table のテーブル ARN のみを Resource とした `dynamodb:UpdateTable` と `dynamodb:DescribeTable` を付与され、Vector_Index の作成および削除に追加の権限を必要とせず、Good_Table の ARN を Resource に含めない
3. THE Verification_Report SHALL `SearchVectors` に対してファイングレインアクセスコントロールの条件キー（`dynamodb:LeadingKeys` / `dynamodb:Attributes` / `dynamodb:Select`）が適用されないため、パーティションキーによる分離がセキュリティ境界として機能せず、アクセス制御がインデックス単位でのみ機能することを記載する
4. THE OpenSearch_Vector_Lambda SHALL IAM ポリシーで Vector_Collection のコレクション ARN のみを Resource とした `aoss:APIAccessAll` を付与され、かつデータアクセスポリシーで Vector_Collection のインデックスに対する読み取り権限（ReadDocument、DescribeIndex）のみを付与され、WriteDocument / CreateIndex / UpdateIndex / DeleteIndex / DeleteCollectionItems を含まない。Vector_Verification_Path も同一の読み取り権限のみを使用し、追加の `aoss` 権限を要求しない
5. THE Embedding_Batch_Job SHALL `bedrock:InvokeModel` のみを Bedrock の Action に列挙し、Resource を Titan Text Embeddings V2（`amazon.titan-embed-text-v2:0`）のモデル ARN 1 件のみに限定し、`Resource: "*"` およびモデル ID のワイルドカードを含まないポリシーを付与される
6. THE Query_Embedding_Lambda SHALL `bedrock:InvokeModel`（Resource を Titan Text Embeddings V2 のモデル ARN 1 件に限定）と、Query_Vector_Cache のテーブル ARN のみを Resource とした `dynamodb:PutItem` および `dynamodb:GetItem` のみを付与され、Vector_Table、Good_Table、および OpenSearch Serverless に対するいかなる Action も含まないポリシーを付与される
7. THE Vector_Collection SHALL データアクセスポリシーの Principal を次の 3 件の実行ロール ARN のみに限定し、4 件目の Principal を追加せず、各 Principal の権限を役割ごとに分離する。すなわち OpenSearch_Vector_Lambda の実行ロール ARN には読み取り権限（ReadDocument、DescribeIndex）のみ、Embedding_Batch_Job の実行ロール ARN には書き込み権限（WriteDocument）のみ、CloudFormation 実行ロールの ARN にはインデックスライフサイクル権限（CreateIndex、DescribeIndex、UpdateIndex、DeleteIndex）のみを与え、CloudFormation 実行ロールには ReadDocument および WriteDocument を与えない。加えて `Principal` のワイルドカード指定および Ingestion_Pipeline の pipelineRole を含まない（`CfnIndex` は AOSS の `CreateIndex` API をスタックの CloudFormation 実行ロールとして呼び、AOSS は IAM 権限に加えてデータアクセスポリシー側の許可も要求するため、この付与が無いとインデックスを作成できない）。**Vector_Collection の読み出し検証のために検証専用の新規 Lambda を追加する案は、その実行ロールが 4 件目の Principal となり本項の構成そのものを崩すため却下する。**検証は既に ReadDocument を持つ OpenSearch_Vector_Lambda 上の Vector_Verification_Path が担う（A17 参照）
8. THE Vector_Collection SHALL Existing_Search_Collection に紐づく既存のデータアクセスポリシー、暗号化ポリシー、ネットワークポリシーの内容を変更せず、Vector_Collection 専用の新規ポリシーとして定義される
9. THE Embedding_Batch_Job SHALL アクセスキー、シークレットキー、セッショントークンを環境変数、コード、設定ファイルのいずれにも含めず、実行ロールから取得した一時認証情報のみを使用する
10. THE Embedding_Batch_Job SHALL Good_Table および 3 つの GSI に対して読み取り Action（`dynamodb:Query` / `dynamodb:Scan` / `dynamodb:GetItem`）のみを付与され、Good_Table を Resource とする書き込み Action を一切含まない
11. THE Embedding_Batch_Job SHALL Vector_Table のテーブル ARN のみを Resource とした `dynamodb:UpdateItem`、`dynamodb:PutItem`、`dynamodb:BatchWriteItem`、`dynamodb:GetItem` を付与され、`dynamodb:DeleteTable` および `Resource: "*"` を含まない
12. THE Embedding_Batch_Job SHALL Vector_Collection への書き込みについて、IAM ポリシー（Vector_Collection の ARN のみを Resource とした `aoss:APIAccessAll`）とデータアクセスポリシー（Vector_Collection のインデックスに対する WriteDocument）の両方を定義され、いずれか一方のみの付与を許容しない
13. THE Vector_Index および THE Vector_Table SHALL 既存 Lambda ロールに付与済みの Good_Table および 3 つの GSI に対する DynamoDB 権限の Action と Resource を削除・縮小せず、追加権限を新規ステートメントとして定義する
14. THE Vector_Collection SHALL 本機能で新規作成する OpenSearch Serverless ポリシーおよび IAM ロール・ポリシーの description を、タブ、改行、復帰、および 0x20–0x7E / 0xA1–0xFF の文字のみで記述し、日本語文字と `→` を含まない
15. THE OpenSearch_Vector_Lambda SHALL Vector_Verification_Path のために Vector_Table のテーブル ARN のみを Resource とした `dynamodb:GetItem` を付与され、`dynamodb:SearchVectors`、`dynamodb:Query`、`dynamodb:Scan`、Vector_Table を Resource とする書き込み Action（`PutItem` / `UpdateItem` / `DeleteItem` / `BatchWriteItem` / `DeleteTable`）、Good_Table の ARN、および `Resource: "*"` を含まない
16. THE Embedding_Batch_Job SHALL Vector_Collection に対して `aoss` の読み取り権限（ReadDocument、DescribeIndex）を IAM ポリシーおよびデータアクセスポリシーのいずれにおいても付与されない

### Requirement 18: 検証結果の文書化

**User Story:** As a 検証担当者, I want 測定結果と考察を既存ドキュメント群に追加する, so that 検証シリーズの成果として参照できる

#### Acceptance Criteria

1. THE Verification_Report SHALL 既存の `docs/opensearch-comparison.md` と同じ `docs/` ディレクトリに `docs/vector-search-comparison.md` として配置され、リポジトリの README から本ファイルへの参照リンクを 1 箇所以上設ける
2. THE Verification_Report SHALL DynamoDB 側について、レイテンシ（ミリ秒、最小・中央値・最大および試行回数）、言語別の Recall_At_K（小数第 3 位までの平均値と最小値、および使用した Distinct_Sku_K の値）、Vector_Table のベクトル属性の寄与と 2 本の Vector_Index の `IndexSizeBytes` 合計（MB、小数第 2 位まで）、1 回の検索で消費したキャパシティ（RCU、小数第 1 位まで）、`VectorSearchRequestBytes`（バイト）を記載する
3. THE Verification_Report SHALL OpenSearch 側について、レイテンシ（ミリ秒、最小・中央値・最大および試行回数）、言語別の Recall_At_K（小数第 3 位までの平均値と最小値）、Cold_Start 所要時間（秒、小数第 1 位まで）、検索実行時とアイドル時の OCU 使用量（OCU-hour、小数第 2 位まで）、および `OCUUtilization` を記載する
4. THE Verification_Report SHALL 機能制約として「TopK 上限 100」「フィルタ演算子の対応範囲」「距離関数はインデックス作成後変更不可」「オンデマンド課金必須」「次元数上限 4,096」「`Query` / `Scan` / PartiQL による読み取り不可」の 6 項目を列挙し、各項目について DynamoDB と OpenSearch の対応状況の差と、業務要件に対する許容可否を「許容可」または「許容不可」の二値で記載する
5. THE Verification_Report SHALL `SearchConditionExpression` における範囲条件の対応可否について、公式ドキュメント間の記述の矛盾内容、実測プローブで実行した条件、および実測結果（成功または拒否とエラー内容）を記載し、対応可否を「対応する」または「対応しない」の二値で確定して記載する
6. THE Verification_Report SHALL OpenSearch の `cosinesimil` スコアからコサイン距離への逆算について、採用した式、比較した候補式、および局所計算による厳密距離に対する最大残差を記載する
7. THE Verification_Report SHALL VECTORSEARCH タイプにおける scale-to-zero 適用可否を「適用される」または「適用されない」の二値で記載し、設定した最小 OCU 値、アイドル状態を 60 分以上継続させた後の OCU 実測値、および適用されない場合の常時課金の月額推定額を併記する
8. THE Verification_Report SHALL 日本語と英語の埋め込み品質の比較について、使用した埋め込みモデル名、公式の言語サポート状況（英語が正式サポート・100 言語以上はプレビュー扱い）、Paired_Query_Set の全件（日本語クエリと対応する英語クエリの組）とその件数、各バックエンドおよび各 Distinct_Sku_K における日本語の平均 Recall_At_K と英語の平均 Recall_At_K およびその差（小数第 3 位まで）を記載し、日本語の埋め込み品質が本ワークロードにおいて実用水準であるかを「実用可」または「実用不可」の二値で判定して判定根拠を記載する
9. THE Verification_Report SHALL 日本語クエリ 3 件以上に対する上位結果の観察例（クエリ文字列と返却された商品名）を、対応する英語クエリの観察例と対比して記載する
10. THE Verification_Report SHALL 風味に関する意味的クエリに対して Material_Sku が上位に現れなかったことを、負例クラスによる意味検索の妥当性確認結果として、対象クエリ文字列と上位結果に含まれた Material_Sku の件数とともに記載する
11. THE Verification_Report SHALL ベクトル属性を GSI が `ProjectionType: ALL` であるテーブルに追加すると、当該ベクトルが全 GSI に複製されてストレージと読み書きコストが GSI 本数に比例して増加するという知見を記載し、ベクトルを導入する前に GSI の射影を `KEYS_ONLY` または `INCLUDE` に設定すべきであるという対策を併記する
12. THE Verification_Report SHALL 本検証が専用の Vector_Table を使用したことによるトレードオフを記載し、DynamoDB ベクトル検索の主要な価値がベクトルと業務データの同一テーブル配置にある一方、本 PoC では測定の分離を優先して当該価値を意図的に手放したこと、およびキースキーマとデータセットが Good_Table と同一であるため比較結論は成立することを明記する
13. THE Verification_Report SHALL 同一のベクトルを N 行に複製すると TopK が実効的に N 分の 1 に希釈され、測定可能な一意エンティティ単位の k の上限が TopK ÷ N になるという知見を記載し、本検証では N = 3 により Distinct_Sku_K の上限が 33 であったこと、および本番設計ではベクトルを SKU 単位のレコードに配置し倉庫別在庫を別レコードとして保持する構成が有力であることを併記する
14. THE Verification_Report SHALL 検証後のリソース削除手順として、削除対象リソース（Vector_Table、2 本の Vector_Index、Query_Vector_Cache、Vector_Collection、Vector_Collection_Group、本検証で追加した IAM ポリシーおよび Lambda）を全件列挙し、実行順序、各リソースの削除確認方法、および削除完了後に課金対象リソースが 0 件であることの確認結果を記載する
15. THE Verification_Report SHALL Vector_Table の削除によって 2 本の Vector_Index が同時に削除されるため、Good_Table の 15,000 件のアイテムから属性を除去する操作が不要であることを削除手順に明記する
16. THE Verification_Report SHALL 既存の `docs/opensearch-comparison.md` に対する差分が 0 行となる形で追加される
17. THE Verification_Report SHALL 測定条件として、実施日（YYYY-MM-DD 形式）、リージョン、対象レコード件数、埋め込みモデル名、次元数、距離関数、Distinct_Sku_K と要求 TopK の値（TopK は 100 以下）、対象言語、使用したクエリ文字列の全件とその件数、倉庫フィルタの適用有無と適用時の倉庫 ID、埋め込み生成の所要時間（分）と Bedrock 呼び出し回数および概算費用を記載する
18. THE Verification_Report SHALL 記載する各数値に「実測」または「推定」のラベルを付与し、「推定」の数値には算出根拠となる単価と前提条件を併記する
19. THE Verification_Report SHALL 「一桁ミリ秒」の主張を平均レイテンシ 10 ミリ秒未満、「recall 99% 以上」の主張を Recall_At_K の平均値 0.99 以上と定義し、それぞれについて「達成」または「未達」の判定と、判定根拠となる実測値を言語別に記載する
20. THE Verification_Report SHALL 書き込み後の読み出し検証と最小権限の衝突について、実測したエラー内容（`stage: VERIFICATION` / `errorCode: ACCESS_DENIED_IAM` / `security_exception: [security_exception] Reason: Bad Authorization`）と実測値（`storedCount 1712` / `verifiedMatchedCount 0` / `verifiedMismatchedCount 1712` / `failedCount 0`）、採用した解決（Vector_Verification_Path への分離）、却下した案とその理由（検証専用 Lambda の追加はデータアクセスポリシーの Principal を 4 件に増やすため）、および開発者の IAM ユーザーが Principal に含まれずインデックスを直接読めない（`GetIndex` / cloudcontrol / エンドポイント直叩きがいずれも 403）ため Vector_Verification_Path が投入の証拠を得る唯一の経路であることを記載する
21. THE Verification_Report SHALL CloudFormation のリソーススキーマが許容していても実サービスが拒否する項目が存在することを知見として記載し、実例として `Method.Engine` に `faiss` を指定した際の `[illegal_argument_exception] Field parameter 'engine' is not supported`、`Settings` 省略時の `Cannot set modelId or method parameters when index.knn setting is false`、`AttributeDefinitions` 省略時の `One element in SearchSchema is not defined in attribute definitions` の 3 件を挙げ、これらがローカルの合成テストでは検出できずデプロイまで失敗が遅れる種類の制約であることを明記する
22. THE Verification_Report SHALL 測定条件として、クエリ埋め込みにおいてレイテンシ最適化推論が使用されたか標準推論へフォールバックしたかを記載し、フォールバックした場合はその根拠となるエラー本文（`Latency performance configuration is not supported for amazon.titan-embed-text-v2:0 in us-west-2`）、A/B プローブの実施内容と両結果、および記載するクエリ埋め込みレイテンシが標準推論の値であることを併記する
23. THE Verification_Report SHALL DynamoDB の `SearchVectors` が返す `SearchResults[].Score` がコサイン距離そのものであること、局所計算による厳密距離との残差、棄却した候補式とその残差、および返却された消費キャパシティ項目（`VectorSearchRequestBytes` と `VectorSearchUnits` の 2 項目のみ）とその観測値を記載し、`VectorSearchUnits` が SDK の `VectorCapacity` モデルに存在しない項目であることを併記する
24. THE Verification_Report SHALL `DescribeTable` の `VectorIndexDescription` の `Backfilling` フィールドが `CREATING` かつバックフィル中は `true` を返す一方 ACTIVE 到達後は不在になり `true → false` の遷移を一度も観測できなかったことを、インデックス作成中の観測（`is-complete.ts` のポーリングで 2 本のインデックスそれぞれ 8 回の `true`）と ACTIVE 到達後の観測の両方の文脈とともに記載し、要件 5.15 の検索可否判定が「不在 = 偽」として成立する一方でバックフィル完了までの経過時間が測定不能であったこと、および `--watch-spend` の既定集計区間が直近 24 時間のローリングウィンドウであるため累積課金の評価には集計区間を明示的に広げる必要があることを併記する

---

## 検証で得たい成果（要件外の補足）

| 測定軸 | 対象 |
|--------|------|
| クエリレイテンシ | DynamoDB SearchVectors / OpenSearch k-NN、コールドスタート含む |
| recall@k（言語別） | SKU 粒度のブルートフォース正解集合との比較。Distinct_Sku_K = 1 / 10 / 33 |
| 言語間の recall 差 | Paired_Query_Set による日本語対英語の平均 Recall_At_K の差分 |
| 埋め込み生成コスト・時間 | 5,000 SKU × 2 言語の初回バッチ |
| ストレージ増分 | Vector_Table のベクトル属性寄与と `IndexSizeBytes`、次元数ごとの比較 |
| OpenSearch 側コスト | OCU 使用量、`OCUUtilization`、scale-to-zero 適用可否 |
| 消費キャパシティ | `ReturnConsumedCapacity` / `VectorSearchRequestBytes` |
| 機能差分 | TopK 上限、フィルタ演算子の対応範囲（実測）、距離関数不変、次元数上限 4,096 |
| 設計上の落とし穴 | GSI `ProjectionType: ALL` へのベクトル複製、同一ベクトルの N 行複製による TopK 希釈 |
| 負例クラスの挙動 | 風味クエリに対する Material_Sku の非出現 |
