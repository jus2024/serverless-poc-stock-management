# Implementation Plan: vector-search-comparison

## Overview

DynamoDB Vector Search（`SearchVectors`）と OpenSearch Serverless VECTORSEARCH（k-NN）を、同一の埋め込みベクトル・同一のクエリベクトル・同一の TopK・同一の検索言語で比較する検証機能を実装する。実装言語は TypeScript（`src/` と `amplify/` と `scripts/`）。Python は使わない。

設計が課す順序をそのまま作業順序にする。

1. **テスト基盤の整備が最初。** リポジトリにテストランナーが存在しないため、`vitest` + `fast-check` + `@testing-library/react` + `aws-cdk-lib/assertions` を先に入れないと 1 本も property テストが書けない。
2. **純関数 → Lambda → インフラ配線 → UI。** 日英メタデータ導出・埋め込みテキスト組み立て・言語ルーティング・TopK 正規化・スコア正規化・エラー分類・制約メタデータ・重なり指標・recall 算出は AWS 非依存の純関数であり、これを消費するハンドラより先に作って property テストで固める。
3. **実 AWS は段階とゲートに従う。** design.md のデプロイ段階 0〜17 の順序を task 13 でそのまま踏む。課金対象リソースを作る前に scale-to-zero 判定を通す。
4. **Open Question はタスクで決着させる。** Q1（範囲フィルタ可否）・Q2（スコア逆算式）・Q5（距離フィールド名）・Q6（2 本のインデックスの並行作成可否）は推測せず、実測タスクの成果物として確定する。**現況：Q1（13.16）は「対応しない」、Q2（13.15）と Q5（13.13）は決着、Q6（13.9）は「判定不能」で確定、Q3（13.19）は「適用される」で決着（0 OCU 60 分以上の区間 4 件 / 最長 1,555.0 分。ただし 24 時間連続の専用観測は未実施）。**残るのは Q4（コレクションを含まない Collection Group の課金、段階 4）で、13.19 が約 24.3 時間の 0 OCU 実測という補強証拠を得たが、0 課金の確定には請求データが必要である。
5. **実測で要件が破綻したら、要件を直してから実装を直す。** task 17（読み出し検証と最小権限の衝突）と task 18（レイテンシ最適化推論の未対応）はいずれも実 AWS で要件どおりの実装が動かないと判明した事例である。requirements.md を先に改訂し、根拠として実測エラー本文を残してから実装タスクを起こす。
6. **コストゲートはブロッキング。** Deployment_Validator の判定前に Collection / Index / 検索 Lambda を作らない。長時間観測の前に累積 20 USD の監視手段を用意する。

### タスクの区分ラベル

各サブタスクの先頭に実行環境のラベルを付ける。

| ラベル | 意味 |
|---|---|
| 【ローカル】 | ローカルのコーディングとテストのみ。AWS 不要 |
| 【実 AWS】 | 実 AWS リソースが必要。デプロイは利用者が手動で実行する（`npx ampx sandbox`） |
| 【壁時計】 | 待ち時間が本質的に短縮できない。所要時間を明記する |

**デプロイは利用者が手動で実行する。** タスク内に「利用者が実行するコマンド」を明記し、エージェントはデプロイを実行しない。なお **未デプロイの既存 Lambda 変更がサンドボックスに残っている**ため、本シーケンス最初のデプロイ（13.2）はその変更も同時に取り込む。差分の確認は 13.2 のゲート条件に含める。

### property テストの共通ルール

- 1 つの Correctness Property を 1 本のテストで実装する
- `fc.assert(fc.property(...), { numRuns: 100 })` として **最小 100 回反復**する
- 各テストの先頭に設計書のプロパティを名指しするヘッダーコメントを置く

```ts
// Feature: vector-search-comparison, Property 18: 任意の言語指定に対して、
// DynamoDB_Vector_Lambda が指定するインデックス名は当該言語に対応する 1 本であり、
// いずれの呼び出し引数にも他方の言語のインデックス名が現れない。
```

- Bedrock / DynamoDB / OpenSearch はモックする。100 回反復で実 API を叩かない
- レート制御・バックオフ・タイムアウト・経過秒表示は `vi.useFakeTimers()` で検証する

---

## Tasks

- [x] 1. テスト基盤とプロジェクト設定の整備
  - [x] 1.1 【ローカル】テストランナーと property テスト基盤を導入する
    - `vitest`、`fast-check`、`@testing-library/react`、`@testing-library/jest-dom`、`jsdom` を devDependency に**バージョン固定**で追加する
    - `vitest.config.ts` を作成し、`environment: 'jsdom'`、`include` に `amplify/**/*.test.ts` / `src/**/*.test.ts(x)` / `scripts/**/*.test.ts` を設定する
    - CDK 検証用に既存の `aws-cdk-lib` の `assertions`（`Template.fromStack`）が使えることを空テストで確認する
    - ウォッチモードは使わない（`vitest --run` のみ）
    - _設計: Testing Strategy / テスト基盤の導入_

  - [x] 1.2 【ローカル】`package.json` にスクリプトを追加する
    - `"test": "vitest --run"`
    - `"vector:recall"` / `"vector:measure"` / `"vector:validate"` / `"vector:probe-range"` を `tsx` 実行として追加する（実体は task 11 で作る）
    - _設計: ファイル配置 / `scripts/` を新設する理由_

- [x] 2. 日英マスターデータの新規追加（新規シードデータ）
  - [x] 2.1 【ローカル】`amplify/functions/shared/vector/master-data-i18n.ts` に 10 種のマッピング表を定義する
    - `ORIGIN_I18N`（8 産地、日本語名は既存 `ORIGINS.name` の再掲、英語名を新規）
    - `ORIGIN_FLAVOR`（8 産地 → フレーバーノート 2〜3 語、日英）
    - `ROAST_PROFILE`（5 焙煎度 → ボディと酸味、日英）
    - `BLEND_HINT`（20 ブレンド名 → 風味またはボディの示唆、日英。FRUITY / NUTTY / CHOCO / CARAMEL / CITRUS / BERRY / FLORAL / SPICY は風味、RICH / MILD / DEEP / SMOOTH / BOLD はボディ、残りは風味中立）
    - `MATERIAL_PURPOSE`（12 資材タイプ → 包装用途の説明文と用途説明、日英）
    - `CATEGORY_I18N` / `ROAST_I18N` / `SIZE_I18N` / `MATERIAL_TYPE_I18N` / `MATERIAL_MATERIAL_I18N`（既存表示名の再掲 + 英語名を新規）
    - 既存の `amplify/functions/seed/sku-generator.ts` のマスターは**変更しない**。コードをキーに参照する別モジュールとして定義する
    - 外部サービスに依存しない固定辞書とする
    - _要件: 2.1, 2.2, 2.3, 2.5, 2.6_
    - _設計: 日英マスターデータ（新規シードデータ）_

  - [x] 2.2 【ローカル】マスターデータの整合性ユニットテストを書く
    - 既存 `sku-generator.ts` の全コード（産地 8 / 品種 4 / 焙煎度 5 / ブレンド 20 / 資材タイプ 12 / 資材サイズ 8 / 資材素材 7 / 各容量）に対して、対応する日英エントリが欠けていないことを確認する
    - 日本語名が既存マスターの表示名と一致すること、英語値が非空かつ ASCII のみであることを確認する
    - _要件: 2.1, 2.3_

- [x] 3. 共有純関数モジュール（`amplify/functions/shared/vector/`）
  - [x] 3.1 【ローカル】`sku-metadata.ts` に日英メタデータ導出を実装する
    - `VectorLanguage` / `SkuMetadataFields`（9 項目）/ `SkuMetadata`（ja + en）型と `deriveSkuMetadata(itemId, itemName)` を実装する
    - itemId パターン 6 種（生豆 / 焙煎豆 / ブレンド / ドリップ（ブレンド）/ ドリップ（産地）/ 資材）から category / origin / roastLevel を導出する
    - フレーバー・ボディ・酸味は**産地コードと焙煎度コードから導出し、品種コードを入力に使わない**（既存マスターが産地と品種を独立に組み合わせるため、品種を使うと意味的に矛盾した埋め込みが大量に生まれる）
    - ブレンドは `BLEND_HINT` を追加入力にする
    - 資材はフレーバー・ボディ・酸味を空文字とし、`MATERIAL_PURPOSE` から説明文と用途説明を与える
    - `ja.productName` は入力の `itemName` をそのまま採用し、`en.productName` は itemId のコード列を英語マスターで写して組み立てる
    - 実行時の乱数を使わず、固定シードのみを使う（同一入力に常に同一出力）
    - _要件: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_
    - _設計: Sku_Metadata 導出（純関数）_

  - [x] 3.2 【ローカル】`sku-metadata` の property テストを書く
    - **Property 3: Sku_Metadata 導出の決定論性と項目網羅性**
    - **Property 4: 意味的属性の導出入力の制約**（品種コードのみ変えたときの風味不変性は V14 に対する回帰防止として必須）
    - **Property 5: 既存シード出力の不変性**（6 属性の保存）
    - _要件: 1.3, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_
    - _Property: 3, 4, 5_

  - [x] 3.3 【ローカル】`embedding-text.ts` に埋め込みテキスト組み立てと正規化を実装する
    - `normalizeText(s)`（前後空白除去 + 連続空白を半角 1 文字へ圧縮。全角スペース・タブ・改行を含む）
    - `buildEmbeddingText(fields)`（9 項目を 商品名 → カテゴリ → 産地 → 焙煎度 → フレーバーノート → ボディ → 酸味 → 説明文 → 抽出推奨 の固定順、半角スペース 1 文字で連結）
    - `truncateForEmbedding(text)`（50,000 文字で切り詰め、切り詰めフラグを返す）
    - 日英で**同一関数を 2 回適用する**設計とし、言語別の分岐を関数内に作らない。Query_Embedding_Lambda も `normalizeText` を共有する
    - _要件: 2.8, 2.9, 2.10, 3.7, 10.1, 10.12_
    - _設計: 埋め込みテキスト組み立て（純関数）_

  - [x] 3.4 【ローカル】`embedding-text` の property テストを書く
    - **Property 1: 埋め込みテキスト組み立ての正規形と単一言語性**
    - **Property 2: 埋め込み前処理の経路間一致**（バッチ側とクエリ側で同一結果、言語で変わらない）
    - **Property 6: 埋め込みテキストの上限切り詰め**
    - _要件: 2.8, 2.9, 2.10, 3.7, 10.1, 10.12_
    - _Property: 1, 2, 6_

  - [x] 3.5 【ローカル】`language.ts` に言語ルーティングを実装する
    - `resolveIndexName(language)`（`ja` → `byEmbeddingJa` / `en` → `byEmbeddingEn`）
    - `resolveVectorField(language)`（`ja` → `embeddingJa` / `en` → `embeddingEn`）
    - `isVectorLanguage(v)`（`ja` / `en` のみ受理）
    - **インデックス名とフィールド名の決定経路をこのモジュールに一本化する。**呼び出し側で名前を組み立てられる余地を残さない
    - _要件: 8.2, 9.2, 10.7_
    - _設計: 言語ルーティング / Property 18_

  - [x] 3.6 【ローカル】`topk.ts` に TopK 正規化を実装する
    - 1〜100 の整数はそのまま、101 以上は 100 に丸め、要求値と適用値の両方を返す
    - 整数以外・0 以下は検証エラー（許容範囲の情報を含む）とし、検索 API を呼ばせない
    - `distinctSkuKToTopK(k)`（`3 × k`、k > 33 は測定不能として拒否し上限 33 とその導出を返す）
    - _要件: 8.3, 8.4, 8.5, 13.3_

  - [x] 3.7 【ローカル】`score-normalize.ts` にスコア正規化を実装する
    - `normalizeOpenSearchScore(score, formula)`。`formula` は `two_minus_d_over_two`（既定、`d = 2 − 2 × score`）と `reciprocal_minus_one`（`d = 1 / score − 1`）の 2 値
    - 範囲外の値をクランプせずそのまま返し、呼び出し側が `distanceBasisMismatch` を判定できるようにする
    - 環境変数 `OPENSEARCH_SCORE_FORMULA` による上書きを受け付ける
    - 既定式は task 13.15 の実測キャリブレーションで確定する
    - _要件: 9.5, 9.12_
    - _設計: スコア正規化 / Q2_

  - [x] 3.8 【ローカル】`constraints.ts` に機能制約メタデータを定義する
    - `VectorBackendCapabilities` を DynamoDB 側（`maxTopK: 100`、`supportedFilterKinds: ['equality']`、`distanceFunctionMutable: false`、`maxDimensions: 4096`、`requiresOnDemandBilling: true`、`readableByQueryScanPartiQL: false`、集約・地理空間・ネスト・全文併用はすべて false、`filterKindsUnverified` に実測で確定させる旨）と OpenSearch 側（`maxTopK: null`、`maxDimensions: 16000`、範囲フィルタ・全文併用・集約・地理空間・ネストは true）で定義する
    - `embeddingNotice`（モデル名、正式サポート言語、プレビュー扱いの記述、日英 2 本の独立生成による言語別測定の実施、両バックエンドが同一ベクトルを使うため比較の公平性が保たれる旨、`docs/vector-search-comparison.md` への参照）を定義する
    - **画面側に固定値を持たせない**ため、この定義が UI 表示の唯一の供給源になる
    - _要件: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6_

  - [x] 3.9 【ローカル】`errors.ts` にエラー分類と応答生成を実装する
    - `VectorErrorCode`（15 種）/ `VectorErrorStage`（3 値）/ `VectorErrorResponse` 型
    - `classifyError(error, stage)`：例外の `name` → `$metadata.httpStatusCode` → メッセージパターンの順に判定し、いずれにも当たらない場合は `INTERNAL_ERROR` にフォールバックする（全域性）
    - 再試行可否をコードに対して一意に定め、`THROTTLED` は 1〜60 秒、`INDEX_BUILDING` は 1〜300 秒の推奨待機秒数を設定する
    - `toClientError()`：ARN パターン（`arn:aws:`）、12 桁の数字列、`stack`、資格情報を示すキー名を除去し、説明文を 500 文字で打ち切る。**応答生成の唯一の経路**とする
    - **後続の修正あり（task 18.2）。**本タスクで実装した `classifyBadRequest` は HTTP 400 の既定分岐で `INVALID_QUERY` を付けるため、Bedrock の `ValidationException`（真因はレイテンシ最適化推論の未対応）に「クエリ文字列が空、または空白文字のみです。」という定型文が付いた。要件 16.10 / 16.11 の追加に伴い task 18.2 で修正する
    - _要件: 4.7, 16.1, 16.5, 16.6, 16.7, 16.9_
    - _設計: Error Handling_

  - [x] 3.10 【ローカル】言語ルーティング・TopK・スコア正規化・エラー分類の property テストを書く
    - **Property 19: TopK 正規化の全域性**
    - **Property 25: スコア正規化の順序保存と値域**
    - **Property 51: エラー分類の全域性と一意性**
    - **Property 52: エラー応答の情報漏洩防止**
    - **Property 17: 次元数バリデーションの境界と 2 本の一致**（DynamoDB 1〜4,096 / OpenSearch 1〜16,000 / 実効 1〜4,096）
    - _要件: 4.7, 5.2, 6.4, 6.11, 8.3, 8.4, 8.5, 9.5, 9.12, 16.1, 16.5, 16.6, 16.7, 16.9_
    - _Property: 17, 19, 25, 51, 52_

  - [x] 3.11 【ローカル】`embedding-generator.ts` に Bedrock 呼び出しをカプセル化する
    - `amazon.titan-embed-text-v2:0` を `dimensions`（1024 / 512 / 256、既定 1024）と `normalize: true` で呼ぶ
    - 出力の各要素に `Math.fround()` を適用して f32 に丸める（丸め以外の桁数削減は行わない）
    - トークンバケットによるレート制御（既定 120 req/min、範囲 1〜600、環境変数とパラメータで上書き）
    - スロットリング時は指数バックオフ（基準 1, 2, 4, 8, 16 秒、上限 32 秒、±20% ジッター）。上限回数は呼び出し側が渡す（バッチ 5 / クエリ 3）
    - スロットリング以外（`ValidationException` / `AccessDeniedException` 等）は再試行しない
    - 50,000 文字超過は `truncateForEmbedding` で切り詰め、切り詰め件数を集計できるように返す
    - **後続の修正あり（task 18.1）。**本タスクは `latencyOptimized: true` のとき `performanceConfigLatency: 'optimized'` を無条件に付ける実装であり、当時の要件 10.1 どおりである。`amazon.titan-embed-text-v2:0` が us-west-2 で未対応だと判明したため、要件 10.1 / 10.13〜10.15 の改訂に伴い task 18.1 でフォールバックを追加する
    - _要件: 3.1, 3.3, 3.7, 3.9, 3.11, 4.1, 4.2, 4.7, 10.2_
    - _設計: Embedding_Generator（共有モジュール）_

  - [x] 3.12 【ローカル】`embedding-generator` の property テストを書く
    - **Property 11: 指数バックオフの範囲と単調性**（仮想時計で検証）
    - **Property 12: 呼び出しレートの上限**（任意の連続 60 秒区間の呼び出し回数が設定値以下）
    - f32 丸めの冪等性（Property 8 の一部を単体で先に固める）
    - _要件: 3.9, 3.11, 4.1, 4.2, 10.8_
    - _Property: 8, 11, 12_

- [x] 4. フロントエンド共有純関数（`src/lib/inventory/`）
  - [x] 4.1 【ローカル】`vector-types.ts` に API 契約型を定義する
    - `VectorBackend` / `VectorLanguage` / `VectorErrorCode` / `VectorErrorStage` / `VectorErrorResponse` / `VectorSearchHit`
    - `VectorCapabilitiesResponse` / `VectorBackendCapabilities` / `VectorEmbedRequest` / `VectorEmbedResponse` / `VectorSearchRequest` / `DynamoDBVectorSearchResponse` / `OpenSearchVectorSearchResponse`
    - `VectorSearchHit` に両言語のベクトル属性を含めない（型レベルで漏洩経路を作らない）
    - _要件: 8.8, 9.1, 10.3, 11.15, 12.5, 12.6, 15.6, 16.9_
    - _設計: API Contract_

  - [x] 4.2 【ローカル】`vector-overlap.ts` に重なり指標の計算を実装する
    - アイテム同一性を `(itemId, warehouseId)` の複合キーの完全一致で判定する
    - 共通アイテム数、Jaccard 係数（小数第 3 位）、overlap@k 比率（小数第 3 位）
    - 3 分割（共通 / DynamoDB 側のみ / OpenSearch 側のみ）と各件数
    - 共通アイテムごとの両順位・順位差の絶対値、正規化距離（小数第 4 位）・スコア差の絶対値
    - 差の絶対値 0.0010 以下を「許容誤差内で一致」と判定する
    - 表示行数と `itemId` 一意件数の両方を返す（倉庫三つ組の注記表示に使う）
    - 片側がエラーまたは 0 件のときは「算出不可」とその理由を返し、正常側の一覧は破棄しない
    - _要件: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8_

  - [x] 4.3 【ローカル】`vector-overlap` の property テストを書く
    - **Property 33: 重なり指標の値域と対称性**
    - **Property 34: 結果集合の 3 分割の保存則**
    - **Property 35: 一致判定閾値の厳密性**
    - **Property 36: 表示行数と一意 SKU 件数の関係**
    - _要件: 12.1, 12.2, 12.3, 12.4, 12.5, 12.7_
    - _Property: 33, 34, 35, 36_

- [x] 5. Recall 評価コア（`scripts/vector-search/`）
  - [x] 5.1 【ローカル】`ground-truth.ts` に言語別 Ground_Truth 構築を実装する
    - `cosineDistance(a, b)`（float32 精度、0〜2）
    - Vector_Table の 15,000 件を `itemId` で重複排除して 5,000 件の一意ベクトル集合を作る
    - **言語ごとに別ファイル**（`ground-truth-ja-d1024.json` / `ground-truth-en-d1024.json`）でローカルキャッシュし、混用を構造的に防ぐ
    - Distinct_Sku_K = 1 / 10 / 33 の Ground_Truth を決める。距離差 1e-6 以下の同値は `itemId` 昇順で決定論的に順位付けし、同値件数を出力する
    - 倉庫フィルタ有効時は該当 warehouseId のレコードに限定して言語ごとに再計算し、フィルタ無効時のものと混用しない
    - _要件: 13.1, 13.2, 13.9, 13.12, 13.14_
    - _設計: Recall_Evaluator / Ground_Truth の構築（言語別）_

  - [x] 5.2 【ローカル】`recall.ts` に SKU 粒度の recall 算出と集計を実装する
    - `dedupeByItemId(hits)`：同一 `itemId` の初出行の順位を採用して一意 SKU 列にする
    - `recallAtK(returnedHits, groundTruthItemIds, distinctSkuK)`：重複排除後の上位 `distinctSkuK` 件の itemId 集合と Ground_Truth の積集合サイズを `distinctSkuK` で除す
    - **両バックエンドに同一関数を適用する**
    - 集計：バックエンド × 言語 × Distinct_Sku_K ごとの平均・最小・0.99 未満件数、閾値 0.99 に対する合否、言語間差分（小数第 3 位）
    - 各バックエンドの返却行のうち距離が完全一致した行の件数を計上する
    - 風味クエリ（`intent === "flavor"`）の上位に含まれた Material_Sku 件数と 0 件判定
    - _要件: 13.3, 13.4, 13.5, 13.6, 13.8, 13.11, 13.13, 13.15_
    - _設計: recall の算出（SKU 粒度）_

  - [x] 5.3 【ローカル】`paired-queries.ts` に Paired_Query_Set を定義する
    - 同一の意味的意図を持つ日本語クエリと英語クエリを **1 つのオブジェクトに ja / en を並べて持たせる**形で 50 件以上定義する（別配列を添字で対応づける方式は採らない）
    - `id` / `ja` / `en` / `intent`（`flavor` | `body` | `origin` | `usage` | `material`）
    - 起動時に `id` の一意性と ja / en がともに非空であることを検証し、違反があれば測定を開始しない
    - 乱数シード（既定 `20260805`）はクエリの**選定順序**にのみ使う
    - _要件: 13.6, 13.7, 13.10_

  - [x] 5.4 【ローカル】Recall 評価コアの property テストを書く
    - **Property 37: コサイン距離の基本性質**
    - **Property 38: itemId 重複排除の冪等性と非増加性**
    - **Property 39: Distinct_Sku_K と要求 TopK の関係**（`3 × k`、k ≤ 33）
    - **Property 40: recall@k の値域と単調性**
    - **Property 41: 統計集計の整合性と言語間差分**
    - **Property 42: 測定の決定性と同値順位の確定**
    - **Property 43: Ground_Truth の言語独立性**
    - **Property 44: Paired_Query_Set の 1 対 1 対応**
    - **Property 45: 等価フィルタ結果の部分集合性**
    - **Property 46: 負例クラスの計数**
    - _要件: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.10, 13.11, 13.12, 13.13, 13.14, 13.15_
    - _Property: 37, 38, 39, 40, 41, 42, 43, 44, 45, 46_

  - [x] 5.5 【ローカル】**3 行複製に対する recall 1.0 の回帰テストを書く（本機能で最も重要なテスト。省略しない）**
    - Ground_Truth の上位 10 SKU と完全一致する 30 行（10 SKU × 3 倉庫、各 SKU 内の 3 行は同一距離）を入力し、Distinct_Sku_K = 10 で `recallAtK` が **1.0** を返すことを例示テストとして固定する
    - 同一入力に対して旧算出式（返却行の itemId 集合を k で割る方式）が約 0.33 を返すことも併記し、修正が効いていることの直接的な証拠にする
    - Distinct_Sku_K = 1 / 33 についても同様に 1.0 を確認する
    - _要件: 13.3, 13.4, 13.5_
    - _設計: 知見 3 / Testing Strategy 本改訂で追加する重点テスト_

- [x] 6. チェックポイント — 純関数層
  - すべてのテストが通ることを確認し、疑問があれば利用者に確認する。`npm run lint` と `tsc --noEmit` も通す

- [x] 7. CDK インフラ定義（`amplify/custom/`）
  - [x] 7.1 【ローカル】`dynamodb-tables.ts` に Vector_Table と Query_Vector_Cache を**追記のみ**で追加する
    - `kiro-roasters-inventory-vector`：PK `itemId`(S) / SK `warehouseId`(S) / `PAY_PER_REQUEST` / **GSI 0 本** / Streams 設定なし / PITR 無効 / `RemovalPolicy.DESTROY` / `contributorInsightsEnabled` なし
    - `kiro-vector-query-cache`：PK `queryId`(S) / `PAY_PER_REQUEST` / `timeToLiveAttribute: 'expiresAt'`（300 秒）/ `RemovalPolicy.DESTROY`
    - `InventoryTables` インターフェースに `vectorTable` / `queryCacheTable` を追加する
    - **既存の `goodTable` と `executionsTable` の定義には一切手を入れない**
    - _要件: 1.1, 1.2, 1.8_
    - _設計: Data Models / Vector_Table_

  - [x] 7.2 【ローカル】`vector-index.ts` と Index_Provisioner を実装する
    - `amplify/functions/vector-index-provisioner/on-event.ts`：Create は `UpdateTable` の `VectorIndexUpdates: [{ Create: {...} }]` を**要素数 1 で**呼び、同一リクエストに **`AttributeDefinitions: [{ AttributeName: 'warehouseId', AttributeType: 'S' }]` を必ず同梱する**（`SearchSchema` に載せた属性は同一リクエストの `AttributeDefinitions` に宣言されていなければならず、テーブル側の既存定義とはマージされない。省くと `One element in SearchSchema is not defined in attribute definitions` で拒否される。13.7 で実測）。既存インデックスの `ResourceInUseException` / already exists は成功として扱い、`DescribeTable` でインデックス名・ベクトル属性名・次元数・距離関数の 4 項目一致を確認する。Update は破壊的変更として明示的に失敗させる。Delete は `VectorIndexUpdates: [{ Delete: {...} }]`、不存在は成功
    - `is-complete.ts`：`DescribeTable` の `VectorIndexDescription` で `IndexStatus === 'ACTIVE'` を完了条件とする（`queryInterval` 60 秒、`totalTimeout` 2 時間）。**バックフィル完了は完了条件に含めない**
    - `amplify/custom/vector-index.ts`：`custom_resources.Provider` を組み、`byEmbeddingJa`（`embeddingJa`）と `byEmbeddingEn`（`embeddingEn`）を 2 つのカスタムリソースとして定義する。英語側に `node.addDependency(日本語側)` を設定して**逐次化**する
    - 定義内容：`Dimensions`（設定値、2 本同一）/ `DistanceFunction: 'COSINE'` / `SearchSchema` は `warehouseId` を `INLINE_FILTER` のみ（`HASH` を定義しない）/ `Projection` は `INCLUDE` で `['itemName','metaJa','metaEn','quantity','location','unitPrice']`
    - `physicalResourceId` に次元数と距離関数を含め（`byEmbedding{Ja|En}-d{dimensions}-{distanceFunction}`）、変更時に置換になるようにする
    - `@aws-sdk/client-dynamodb` を `NodejsFunction` でバンドルし（`bundling.externalModules: []`）、Lambda 同梱 SDK に依存しない
    - IAM は `dynamodb:UpdateTable` / `dynamodb:DescribeTable` を **Vector_Table のテーブル ARN のみ**に限定し、Good_Table の ARN を含めない
    - `description` は ASCII 印字可能文字のみ
    - _要件: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.9, 5.10, 5.11, 5.12, 5.13, 17.2_
    - _設計: Index_Provisioner（Custom Resource）_

  - [x] 7.3 【ローカル】`vector-collection.ts` に OpenSearch VECTORSEARCH 一式を実装する
    - Collection Group `kiro-inventory-vector-group`：`Generation` は `NEXTGEN`、`standbyReplicas: ENABLED`、min indexing / search OCU 0、max indexing / search OCU 2
    - Collection `kiro-inventory-vector`（type `VECTORSEARCH`）、Encryption Policy `kiro-inventory-vector-enc`（AWS 所有キー）、Network Policy `kiro-inventory-vector-net`（public）、Data Access Policy `kiro-inventory-vector-data`
    - `CfnIndex` で `inventory-vector` を作成する。**`Settings.Index.Knn` を `true` として明示する**（省略すると `index.knn = false` として扱われ `Method` の指定が `Cannot set modelId or method parameters when index.knn setting is false` で拒否される。13.7 で実測）
    - `embeddingJa` / `embeddingEn` の 2 つの `knn_vector`（同一 Dimension、`dataType: 'float'`（enum は `['float','byte']`。`float32` は存在しない）、`Method` は `hnsw` / `cosinesimil` / m 16 / ef_construction 128、**`Method.Engine` は指定しない**、`CompressionLevel` は指定しない）
    - **`Method.Engine` を送らない理由：**スキーマの enum は `["nmslib","faiss","lucene"]` で `faiss` は有効値だが、データプレーンが `[illegal_argument_exception] Field parameter 'engine' is not supported` としてパラメータ自体を拒否する。VECTORSEARCH では Faiss HNSW がコレクション種別側で固定されており、リクエストで選ぶ対象ではない（13.7 で実測）
    - `itemId` / `warehouseId` / `itemName` / `location` を keyword、日英 9 項目 × 2 = 18 個のテキスト項目を keyword、`unitPrice` と `quantity` を **`integer`**（`PropertyMapping.Type` の enum は `["text","knn_vector","keyword","integer"]` の 4 値のみで浮動小数型が存在しないため `double` / `long` は指定できない。スキーマ制約であって設計上の選択ではない）
    - `_id` は `${itemId}#${warehouseId}` を前提としたマッピングにする
    - 依存関係を Encryption / Network Policy → Collection → Data Access Policy → Index の順に `addDependency` で明示する
    - **CDK コンテキストフラグ `vectorCollectionEnabled`**（既定 false）で Collection / Index / 検索 Lambda の作成を切り替える。false では Collection Group のみを作る
    - 次元数が 1 未満または 4,096 超（OpenSearch 側は 16,000 超）なら**合成前に失敗**させ、指定値と両バックエンドの許容範囲を含むエラーにする
    - 既存の `opensearch-infra.ts` は**追記も変更もしない**（既存 Collection とポリシーへの非干渉を優先）
    - すべての `description` を ASCII 印字可能文字のみで書く（日本語と `→` を含めない）
    - _要件: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.11, 6.12, 6.13, 6.14, 7.1, 17.8, 17.14_
    - _設計: Vector Collection Construct / V15_

  - [x] 7.4 【ローカル】CDK スナップショットテストで**既存リソースの差分ゼロ**を機械的に固定する（省略しない）
    - `Template.fromStack` で合成し、`kiro-roasters-inventory-good` の PK / SK、3 本の GSI（`byWarehouse` / `byLocation` / `byUnitPrice`）の定義と `ProjectionType: ALL`、`StreamViewType: NEW_AND_OLD_IMAGES`、PITR 設定、`ContributorInsightsSpecification` が本機能の追加前と一致することを確認する
    - 既存の `kiro-inventory-search` Collection、`kiro-inventory-group` Collection Group、3 つの既存ポリシー、OSIS パイプライン定義のスナップショットが変化していないことを確認する
    - **合成テンプレート内に Good_Table のテーブル ARN または 3 GSI の ARN を Resource とする書き込み Action（`PutItem` / `UpdateItem` / `DeleteItem` / `BatchWriteItem` / `DeleteTable`）を持つ IAM ステートメントが 1 件も存在しないことを走査する**
    - Vector_Table の GSI が 0 本、Streams なし、PITR 無効であることを確認する
    - _要件: 1.1, 1.2, 1.4, 6.3, 17.8, 17.10, 17.13_
    - _設計: Testing Strategy / スナップショットテスト_

  - [x] 7.5 【ローカル】IAM と description の property テストを書く（省略しない）
    - **Property 55: IAM ポリシーの最小権限**（DynamoDB_Vector_Lambda は `dynamodb:SearchVectors` のみ + 2 本のインデックス ARN のみ、Index_Provisioner は Vector_Table ARN のみ、OpenSearch_Vector_Lambda は読み取りのみ、Bedrock はモデル ARN 1 件のみ、データアクセスポリシーの Principal にワイルドカードと pipelineRole を含まない、Vector_Collection へ書き込むロールは IAM とデータアクセスポリシーの両方を持つ、既存ロールの Good_Table 関連権限が縮小されていない、環境変数キー名に資格情報を示す名称がない）
    - **Property 56: description の文字集合**（`^[\u0009\u000A\u000D\u0020-\u007E\u00A1-\u00FF]*$` に一致し、日本語と `→` を含まない）
    - _要件: 5.12, 5.16, 6.12, 17.1, 17.2, 17.4, 17.5, 17.6, 17.7, 17.9, 17.10, 17.11, 17.12, 17.13, 17.14_
    - _Property: 55, 56_

- [x] 8. Lambda ハンドラの実装と配線（`amplify/functions/`）
  - [x] 8.1 【ローカル】`vector-query-embed/handler.ts` を実装する
    - 入力は `query` と `language`。`normalizeText` を共有して前処理する
    - 空文字・空白のみ（半角 / 全角スペース、タブ、改行）は Bedrock を呼ばず `INVALID_QUERY`
    - `language` が `ja` / `en` 以外は Bedrock を呼ばず `INVALID_LANGUAGE`（許容値の一覧を含む）
    - 前処理後 1,000 文字超過は切り詰めずに `QUERY_TOO_LONG`（境界の 1,000 文字は受理）
    - Bedrock はレイテンシ最適化推論（`performanceConfigLatency: 'optimized'`）で 1 回だけ呼ぶ。スロットリング時は最大 3 回再試行し、上限到達時は `retryable: true` と経過 ms を返して検索を実行させない
    - **後続の修正あり（task 18.1 / 18.3）。**上記はレイテンシ最適化推論を無条件に使う実装であり、当時の要件 10.1 どおりである。デプロイ済み環境では `amazon.titan-embed-text-v2:0` が us-west-2 で未対応のため**全リクエストが HTTP 400** になった。要件 10.1 / 10.13〜10.15 の改訂に伴い、task 18.1 で標準推論への 1 回限りのフォールバックと `inferencePath` の応答追加を行い、task 18.3 で実 AWS の成功を確認する
    - 生成ベクトルを f32 に丸め、`queryId`（UUID v4）で**ベクトルと言語の組**を Query_Vector_Cache に保管する
    - 応答は `queryId` / `embeddingLatencyMs` / `dimensions` / `model` / `language` / `cacheHit`。**ベクトル本体を返さない**
    - 既定でキャッシュせず、同一クエリ・同一言語でも毎回 Bedrock を呼ぶ
    - _要件: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 10.11, 10.12, 16.5, 16.8_

  - [x] 8.2 【ローカル】`vector-search-ddb/handler.ts` を実装する
    - `queryId` からベクトルと言語を解決する。不在なら `QUERY_EXPIRED`（再試行可、埋め込みからの再実行が必要である旨）
    - `resolveIndexName(language)` で対象インデックスを 1 本に決める
    - TopK 正規化 → 次元数チェック（`DIMENSION_MISMATCH`、両方の整数値）→ インデックス準備状態チェック（`INDEX_NOT_FOUND` / `INDEX_BUILDING`。判定は `IndexStatus === 'ACTIVE'` かつ `Backfilling !== true` の**組**）。`DescribeTable` は実行環境内で 60 秒キャッシュし、ヒット / ミスを応答に含める
    - 倉庫指定時のみ `SearchConditionExpression = '#wh = :wh'` を `ExpressionAttributeNames` / `ExpressionAttributeValues` でバインドする（式文字列に属性名・値を直接埋め込まない）
    - 範囲条件を含むフィルタ要求は `SearchVectors` を呼ばず `RANGE_FILTER_UNSUPPORTED`
    - `SearchVectors` を 1 回呼ぶ。`ProjectionExpression` は表示用の非ベクトル属性のみ（`embeddingJa` / `embeddingEn` をどちらも含めない）、`ReturnConsumedCapacity: 'INDEXES'`
    - 結果は距離昇順、`rank` は 1 起点の連番、`distanceSemantics: 'lower_is_closer'`。TopK 未満（0 件含む）でもエラーにせず要求 TopK と返却件数の両方を返す
    - `searchLatencyMs`（API 区間）と `handlerLatencyMs`（ハンドラ全体）を別々に計測し、コールドスタート判定をモジュールスコープのフラグで返す
    - `distinctSkuCount` と `constraints` を応答に含める
    - _要件: 5.15, 5.16, 8.1〜8.13, 16.1, 16.2, 16.3, 16.6, 16.7, 16.9_

  - [x] 8.3 【ローカル】`vector-search-aoss/handler.ts` を実装する
    - 既存 `opensearch-search/handler.ts` と同じ `@opensearch-project/opensearch` + `AwsSigv4Signer`（`service: 'aoss'`）構成を踏襲する
    - `resolveVectorField(language)` で対象フィールドを 1 つに決める。`_source` から `embeddingJa` と `embeddingEn` の**両方**を除外する
    - k は DynamoDB 側と同一の適用後 TopK、クエリベクトルと言語も同一の `queryId` から解決する
    - 倉庫フィルタは knn クエリの `filter` 句内に `term: { warehouseId: ... }` として置き、後段フィルタ（`post_filter`）を使わない。`.keyword` サブフィールドは付けない
    - `score-normalize.ts` で生スコアと正規化距離の両方を返す。0 未満または 2 超過なら `distanceBasisMismatch: true` を付け生スコアを保持する
    - `took` はそのまま ms として返し、送信開始〜受信完了のサーバー側レイテンシを別項目で返す
    - 30,000 ms 超過で打ち切り、`OPENSEARCH_TIMEOUT`（Cold_Start 可能性、経過 ms、再試行可）を返し部分結果を返さない
    - フィルタ付きが 0 件でフィルタ無しが 1 件以上なら、マッピング不一致の可能性と使用したフィルタフィールド名を返す（確認クエリは 0 件時のみ 1 回だけ追加実行）
    - フィルタ後件数が k 未満なら注記を付ける。登録ドキュメント数 0 はエラーではなく `NO_DOCUMENTS` 状態で 0 件を返す
    - _要件: 9.1〜9.12, 16.4, 16.6, 16.7, 16.9_

  - [x] 8.4 【ローカル】`vector-capabilities/handler.ts` を実装する
    - `constraints.ts` の定義をそのまま返す読み取り専用エンドポイント
    - 検索未実行でも機能制約比較表と注意書きを描画できるようにする
    - _要件: 15.1, 15.5, 15.6_

  - [x] 8.5 【ローカル】`vector-embed-batch/handler.ts` の `phase = "copy"` を実装する
    - Good_Table の GSI `byWarehouse` を warehouseId ごとに Query して 15,000 レコードを読む。**Good_Table への書き込み API を一切呼ばない**
    - 各レコードに `deriveSkuMetadata(itemId, itemName)` の結果を `metaJa` / `metaEn` として付与する
    - Vector_Table へ `BatchWriteItem`（25 件単位）で `PutItem` する。この時点ではベクトル属性を持たない
    - 複製後に Vector_Table の件数を確認し、15,000 件でなければ `phase = "embed"` へ進まず**期待件数と実件数の両方**を含むエラーを返す
    - 既存の `itemId` / `itemName` / `quantity` / `lotNumber` / `location` / `unitPrice` の 6 属性を変更しない
    - _要件: 1.3, 1.4, 1.7, 2.7_

  - [x] 8.6 【ローカル】`vector-embed-batch/handler.ts` の `phase = "embed"` を実装する
    - 対象 SKU は Vector_Table の `warehouseId = WH-TOKYO` から itemId 一覧（5,000 件）を得る
    - 1 SKU につき日英 2 本のベクトルを生成し（Bedrock 呼び出し回数 = 一意 itemId 件数 × 2）、DynamoDB へ 3 件（3 倉庫）を `UpdateItem` で更新して**両ベクトル属性を同時に書き**、OpenSearch へ 3 ドキュメントを `_bulk` で投入する（Ingestion_Pipeline を経由しない。インデックスとマッピングの作成・変更を行わない）
    - スキップ判定は**言語ごとに独立**に行い、当該言語のベクトルが存在し `embeddingModel` と `embeddingDimensions` がともに現行設定と一致する組のみスキップする。`forceRegenerate: true` ならスキップ判定を行わない
    - 補償：片側成功・他方が 3 回再試行後も失敗した場合、DynamoDB 側は `embeddingJa` / `embeddingEn` / `embeddingModel` / `embeddingDimensions` / `embeddingUpdatedAt` を `REMOVE`、OpenSearch 側は当該 `_id` を delete し、当該 SKU を未格納として (itemId, language) とエラー内容付きで記録する
    - 進捗は `load-test-executions` に `executionId = "vector-embed-<ISO8601>"` で **(itemId, language) 単位**に 100 SKU ごとと終了時に永続化し、再実行時は未処理・失敗の組のみを対象にする
    - `context.getRemainingTimeInMillis()` が 120 秒を下回ったら進捗を確定し `nextItemIndex` 付きで自身を非同期 invoke する（自己再帰、7 回以上）
    - 書き込み後に両バックエンドから両言語のベクトルを読み出し、次元数一致と全要素の完全一致を要素単位で検証する
    - 返却 JSON に言語別および合計で：所要時間（秒、小数第 1 位）、Bedrock 呼び出し回数（再試行含む）、入力トークン数合計、失敗件数と (itemId, language) 一覧、切り詰め件数、検証の一致 / 不一致件数
    - タイムアウト 15 分、メモリ 1024 MB
    - _要件: 3.2, 3.4, 3.5, 3.6, 3.8, 3.9, 3.10, 3.11, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.8, 4.9, 6.8, 14.1_

  - [x] 8.7 【ローカル】Lambda 定義・API Gateway ルート・IAM を配線する
    - `lambda-functions.ts` に 5 つの Lambda を**追記のみ**で追加する（`kiro-vector-query-embed` 30 秒 / 512 MB、`kiro-vector-search-ddb` 30 秒 / 512 MB、`kiro-vector-search-aoss` 60 秒 / 512 MB、`kiro-vector-capabilities` 10 秒、`kiro-vector-embed-batch` 15 分 / 1024 MB）
    - `api-gateway.ts` に 5 ルートを追加する（`GET /vector-search/capabilities`、`POST /vector-search/embed`、`POST /vector-search/dynamodb`、`POST /vector-search/opensearch`、`POST /vector-search/embed-batch`）。CORS ヘッダー定義は既存の共有モジュールを使う
    - `backend.ts` で Vector_Table / Query_Vector_Cache / Vector Collection Construct / Vector Index Construct を配線し、`vectorCollectionEnabled` が false のときは検索 Lambda と Collection 依存部分を作らない
    - IAM を最小権限で付与する：検索 DDB は `dynamodb:SearchVectors` + 2 本のインデックス ARN のみ、検索 AOSS は Collection ARN の `aoss:APIAccessAll` + データアクセスポリシーで読み取りのみ、クエリ埋め込みは Bedrock モデル ARN 1 件 + Query_Vector_Cache の `PutItem` / `GetItem` のみ、バッチは Good_Table と 3 GSI の読み取りのみ + Vector_Table の書き込み + Bedrock モデル ARN 1 件 + Vector_Collection の `aoss:APIAccessAll` とデータアクセスポリシーの WriteDocument
    - Data Access Policy の Principal を **3 件**のみにする：検索 AOSS ロール（ReadDocument / DescribeIndex）、バッチロール（WriteDocument）、**CloudFormation 実行ロール（CreateIndex / DescribeIndex / UpdateIndex / DeleteIndex のみ。ReadDocument / WriteDocument を含めない）**。ワイルドカードと pipelineRole を含めない
    - **CloudFormation 実行ロールが 3 件目として必要な理由：**`CfnIndex` は AOSS の `CreateIndex` をスタックの CloudFormation 実行ロールとして呼び、AOSS は IAM 権限に加えてデータアクセスポリシー側の許可も要求するため、付与が無いとインデックスライフサイクルを実行できない。**4 件目の Principal は追加しない**（要件 17.7）
    - 既存 Lambda ロールの Good_Table 関連権限を削除・縮小せず、追加権限を新規ステートメントとして定義する
    - すべての `description` を ASCII 印字可能文字のみで書く
    - _要件: 5.16, 17.1, 17.2, 17.4, 17.5, 17.6, 17.7, 17.9, 17.10, 17.11, 17.12, 17.13, 17.14_

  - [x] 8.8 【ローカル】検索系ハンドラの property テストを書く
    - **Property 15: インデックス準備判定**
    - **Property 18: 言語ルーティングの排他性**（ja クエリの呼び出し引数に `embeddingEn` / `byEmbeddingEn` が現れないこと、および逆方向）
    - **Property 20: 検索条件式のプレースホルダ化**
    - **Property 21: 範囲フィルタ要求の拒否と非実行**
    - **Property 22: 応答へのベクトル非漏洩**
    - **Property 23: クエリベクトル・k・言語の両バックエンド一致**
    - **Property 24: 結果の順序・順位・件数の不変条件**
    - **Property 26: knn クエリ DSL の構造**
    - **Property 27: レイテンシ区間の包含関係**
    - **Property 28: 入力検証失敗時の下流非実行**
    - **Property 29: 既定でのキャッシュ無効**
    - _要件: 5.13, 5.14, 5.15, 8.1, 8.2, 8.6, 8.7, 8.8, 8.9, 8.10, 8.12, 9.1, 9.2, 9.3, 9.4, 9.8, 9.11, 10.3, 10.6, 10.7, 10.9, 10.10, 16.2, 16.3, 16.8_
    - _Property: 15, 18, 20, 21, 22, 23, 24, 26, 27, 28, 29_

  - [x] 8.9 【ローカル】バッチ処理の property テストを書く
    - **Property 7: Good_Table への非書き込みと件数ゲート**（任意の失敗注入位置・任意のフェーズで書き込み呼び出し回数が 0）
    - **Property 8: 格納ベクトルの両バックエンド一致と f32 丸めの冪等性**
    - **Property 9: 埋め込み生成回数と書き込み件数の関係**（一意 itemId × 2 言語、レコードは × 3 倉庫）
    - **Property 10: 片側失敗時の状態復元**
    - **Property 13: 再生成スキップ判定の論理積**（言語ごとに独立、強制再生成では常にスキップしない）
    - **Property 14: 再実行対象集合の補集合性**
    - _要件: 1.4, 1.7, 3.4, 3.5, 3.6, 3.9, 3.10, 4.3, 4.5, 4.8, 4.9, 10.2_
    - _Property: 7, 8, 9, 10, 13, 14_

- [x] 9. チェックポイント — バックエンド層
  - すべてのテストが通ることを確認する。`npm run lint`、`tsc --noEmit`、7.4 のスナップショットで既存差分ゼロを確認したうえで、疑問があれば利用者に確認する

- [x] 10. ベクトル検索比較 UI（`src/components/inventory/`）
  - [x] 10.1 【ローカル】`src/lib/inventory/vector-api.ts` に API クライアントを実装する
    - `getVectorCapabilities()` / `embedVectorQuery()` / `searchVectorDynamoDB()` / `searchVectorOpenSearch()`
    - 既存 `api.ts` の `getBaseUrl()` と同じ環境変数（`NEXT_PUBLIC_INVENTORY_API_URL`）とエラーハンドリング方式を踏襲する
    - `AbortSignal` を受け取れるようにする（古い応答の破棄に使う）
    - _要件: 11.11, 11.12, 11.13_

  - [x] 10.2 【ローカル】`VectorSearchForm.tsx` を実装する
    - 自然言語クエリ入力欄（最大 200 文字）、**検索言語セレクター（「日本語」/「English」、初期選択「日本語」）**、倉庫セレクター（初期「全倉庫」、WH-TOKYO を含む個別倉庫）、TopK 指定欄（1〜100 の整数、**初期値 30**）、検索ボタン
    - 各入力要素に可視ラベルを関連付ける
    - TopK が範囲外・整数以外なら検索を実行せず許容範囲を示すエラーを入力欄に表示する
    - クエリが空文字または空白のみなら検索ボタンを操作不可にする。検索実行中も操作不可にし実行中表示を出す
    - _要件: 11.2, 11.3, 11.5, 11.6, 11.7, 11.9, 11.10_

  - [x] 10.3 【ローカル】`VectorComparisonPanel.tsx` を実装する
    - 左に DynamoDB、右に OpenSearch。各パネルを `<section>` + `<h3>` の見出し付き領域とし、キーボード操作で結果一覧まで到達できるようにする
    - 各パネルに検索レイテンシ（ms 整数）、結果件数、各アイテムの類似度スコア、**検索に使用した言語**を表示する
    - 結果・エラー・レイテンシの更新を `aria-live="polite"` 領域でスクリーンリーダーに通知する
    - 768px 以下で縦並び（DynamoDB を上、OpenSearch を下）に切り替える
    - OpenSearch 未完了時は右パネルにローディングと開始からの経過秒数を表示する
    - 片側のエラー・タイムアウトが他方の結果表示とレイテンシ表示を消さない
    - _要件: 11.14, 11.15, 11.18, 11.19, 11.20, 11.21, 11.22, 11.23_

  - [x] 10.4 【ローカル】`VectorOverlapSummary.tsx` を実装する
    - `vector-overlap.ts` の結果を表示する（共通アイテム数、Jaccard 係数、overlap@k、片側のみの一覧と件数、共通アイテムの両順位と順位差、正規化距離とスコア差、一致 / スコア差ありの識別表示）
    - **倉庫三つ組の注記**（同一 SKU の 3 倉庫行が同一ベクトルを持つため結果が三つ組で現れる旨）を、表示行数と一意 SKU 件数の両方に併記する
    - 片側がエラーまたは 0 件なら「算出不可」とその理由を表示し、正常側の一覧は保持する
    - _要件: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8_

  - [x] 10.5 【ローカル】`VectorConstraintTable.tsx` を実装する
    - `GET /vector-search/capabilities` の応答から表を組む。**画面側に固定値を保持しない**
    - 見出しセルを持つ表構造とし、対応・非対応をテキストで表現する（色・アイコン・記号のみに依存しない）
    - 検索実行前・実行中・実行後のいずれでも常時表示する。埋め込み言語サポートの注意書きも常時表示する
    - 範囲条件が DynamoDB 側に要求された場合、レスポンス受信から 1 秒以内に制約メッセージを DynamoDB パネル内に表示し、該当行をテキストラベル併記で強調し、読み上げ領域として通知し、入力済み条件を保持する
    - _要件: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8_

  - [x] 10.6 【ローカル】`VectorSearchComparisonView.tsx` で状態を統合する
    - 検索ボタン押下で `POST /vector-search/embed` を 1 回だけ呼び、得た `queryId` で 2 つの検索エンドポイントを**同時に**呼ぶ（`Promise.allSettled` ではなく独立した 2 本の非同期処理として、完了した側から個別に `setState` する）
    - 言語セレクターの値は単一の state として埋め込み呼び出しにのみ渡す（両検索は `queryId` しか持たないため片側だけ言語が変わらない）
    - `AbortController` と単調増加する `requestSeq` で、最後に開始した検索以外の応答を破棄する
    - 両側に 35 秒のクライアント側タイムアウトを適用する（既存 `SearchComparisonView` の `OS_TIMEOUT_MS` と同じ方式）
    - 埋め込み生成レイテンシを検索レイテンシとは別項目として ms 整数で表示する
    - 埋め込み生成が失敗した場合は両検索を呼ばず、両パネルを未実行状態にしてエラーコードと再試行可否のみを表示する
    - **`LatencyBar.tsx` は改変せずそのまま再利用する**（`dynamoDbLatency` / `opensearchLatency` の 2 プロパティ）。各バーにバックエンド名とレイテンシ値をテキストで併記する
    - 無効な TopK 入力では検索を開始せず、直前の結果状態を変化させない
    - _要件: 11.4, 11.6, 11.11, 11.12, 11.13, 11.16, 11.17, 11.22, 11.23, 16.8_

  - [x] 10.7 【ローカル】`InventoryDashboard.tsx` にタブを 1 件だけ追加する
    - `Tab` 型に `"vectorSearch"` を追加、`tabs` 配列に `{ key: "vectorSearch", label: "ベクトル検索比較" }` を追加、対応する `tabpanel` を 1 つ追加する
    - **既存の「在庫管理」「負荷テスト」「結果ダッシュボード」「検索比較」パネルのコードとロジックは一切変更しない**
    - _要件: 11.1, 11.24_

  - [x] 10.8 【ローカル】UI の property テストとユニットテストを書く
    - **Property 30: 無効入力時の結果状態の不変**
    - **Property 31: パネルの独立性**
    - **Property 32: 競合検索の最終一貫性**
    - **Property 53: 制約メタデータの描画追従性**
    - **Property 54: 制約比較表と注意書きの常時表示**
    - **Property 57: 結果表示の網羅性**
    - ユニットテスト：初期値（言語セレクター「日本語」、TopK 30、倉庫「全倉庫」）、既存 4 タブのラベルと順序が変わっていないこと
    - _要件: 11.1, 11.3, 11.5, 11.6, 11.7, 11.12, 11.13, 11.15, 11.22, 11.23, 11.24, 12.8, 15.1〜15.6, 15.8_
    - _Property: 30, 31, 32, 53, 54, 57_

- [x] 11. 運用スクリプト（`scripts/vector-search/`）
  - [x] 11.1 【ローカル】`validate-scale-to-zero.ts`（Deployment_Validator）を実装する
    - `kiro-inventory-vector-group` の `capacityLimits` を取得し、`minIndexingCapacityInOcu` と `minSearchCapacityInOcu` がともに 0 で受理されているかを判定する
    - 受理なら「受理」と `vectorCollectionEnabled=true` での再デプロイ手順を出力する
    - 拒否なら拒否理由の内容・採用値・月額見積（1 OCU × 0.24 USD × 730 h ≈ 175 USD/月）を出力し、続行の是非を検証担当者に委ねる
    - **課金対象リソース（Collection / Index / 検索 Lambda）の作成前に判定結果を提示する**位置づけであることをヘッダーコメントに明記する
    - _要件: 7.1, 7.2, 7.5_

  - [x] 11.2 【ローカル】`measure.ts`（Measurement_Collector）を実装する
    - `--wait-index`：`VectorIndexDescription` を 60 秒間隔でポーリングし、**インデックスごとに** ACTIVE 到達時刻と `Backfilling` 完了までの経過秒を記録する。`--timeout-minutes 180`（既定）でタイムアウト時はエラーと経過時間を返す
    - ストレージ：`TableSizeBytes` の S1 / S2 スナップショット（取得時刻 UTC 付き）、差分をベクトル属性の寄与とし 15,000 で割った 1 レコードあたり平均増分を出力する。**Vector_Table に GSI がないため GSI 複製分の差し引きが不要**である旨を出力に注記する
    - `IndexSizeBytes` と `ItemCount` を 2 本それぞれ直接取得して合計を出力する（`TableSizeBytes` 差分からの算出は行わない）
    - 収束判定：6 時間以上あけた連続 2 回の取得値の差が 1% 以内の値のみ採用。超過時は未確定として最大 3 回まで再取得し、収束しない場合は最終値と「未確定」および推定誤差幅を出力する（先行スナップショットは破棄しない）
    - 消費キャパシティ：同一条件で 100 回検索し、1 検索あたりの平均・最小・最大と合計を、クエリ件数・TopK・対象言語とともに出力する
    - CloudWatch：`VectorSearchRequestBytes`（`TableName`, `VectorIndexName` ディメンション、2 本それぞれ）、`AWS/AOSS` の `SearchOCU` / `IndexingOCU`（5 分間隔、24 時間分の最小・平均・最大）、`OCUUtilization`（最小・平均・最大）
    - `--watch-spend`：`SearchOCU` + `IndexingOCU` の 5 分値を積算して OCU-hour を求め、`× 0.24 USD` が **20 USD** を初めて超えた時点で測定を終了し、測定値を保持したうえで Collection と Collection Group の削除実行を要求する警告を出す
    - 検索継続区間（連続 30 分以上）とアイドル区間（連続 6 時間以上）それぞれの区間長と消費 OCU-hour を出力する
    - `--teardown-check`：撤収確認チェックリスト（task 15.1 参照）を実行する
    - _要件: 5.14, 7.3, 7.4, 7.6, 7.7, 7.8, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9_

  - [x] 11.3 【ローカル】`measure.ts` の算出ロジックの property テストを書く
    - **Property 47: ストレージ寄与分解の保存則**
    - **Property 48: スナップショット収束判定**
    - **Property 49: 連続ゼロ OCU 区間の検出**
    - **Property 50: 累積課金の単調性と警告時点**
    - CloudWatch と DynamoDB はモックする
    - _要件: 7.4, 7.6, 7.7, 14.2, 14.3, 14.4, 14.5, 14.6, 14.9_
    - _Property: 47, 48, 49, 50_

  - [x] 11.4 【ローカル】recall 測定 CLI と機械可読出力を実装する
    - `recall.ts` にエントリポイントを作り、Paired_Query_Set × Distinct_Sku_K（1 / 10 / 33）× 言語（ja / en）× バックエンド（2 種）を回す
    - 出力を `docs/measurements/recall-<date>.json` に書く。含める項目：クエリ件数、乱数シード値、Distinct_Sku_K 一覧、要求 TopK 一覧（3 / 30 / 99）、Ground_Truth 対象の一意ベクトル件数（5,000）、重複排除の単位（`itemId`）、対象言語、フィルタ条件、平均・最小・0.99 未満件数、言語間差分、合否判定と閾値 0.99、同値件数、完全同値行の件数、風味クエリの Material_Sku 件数と 0 件判定
    - 同一シード・同一クエリ集合での再実行が同一の Ground_Truth と同一の Recall_At_K を再現することを確認するモードを設ける
    - _要件: 13.6, 13.8, 13.9, 13.10, 13.11, 13.12, 13.13, 13.15_

  - [x] 11.5 【ローカル】`probe-range-filter.ts`（Q1 の実測プローブ）を実装する
    - `unitPrice` を `INLINE_FILTER` に含めた**使い捨て検証用インデックス**に対して範囲条件（下限のみ / 上限のみ / 両方）を投げ、成功か `ValidationException` かを記録する
    - 使い捨てインデックスを作る場合は、テーブルあたり上限 5 本の範囲内であること、および測定後に削除することをスクリプト内で明示する
    - 結果に応じて `constraints.supportedFilterKinds` に `"range"` を加えるだけで UI の比較表が追従する構造であることをコメントに記す
    - **使い捨てインデックスの追加コストと所要時間が許容できない場合はこのタスクを省略し、Verification_Report に「未実測」として記録する**
    - _要件: 8.7, 15.2, 18.5_

- [x] 12. CI の更新
  - [x] 12.1 【ローカル】`.github/workflows/ci.yml` の Web App ジョブを更新する
    - lint と型チェックの後段に `npm run test`（`vitest --run`）を追加する（ウォッチモードは使わない）
    - `docs/opensearch-comparison.md` の差分が 0 行であることを `git diff --exit-code -- docs/opensearch-comparison.md` で確認するステップを追加する
    - 明らかな問題で早期に失敗させる順序（lint → 型 → テスト → docs 差分）にする
    - _要件: 18.16_

- [x] 13. 実 AWS デプロイと測定（利用者が手動でデプロイ / 段階ゲートに従う）
  - [x] 13.1 【実 AWS】段階 0：事前確認スナップショットを取得する
    - OSIS `kiro-inventory-pipeline` の状態を取得し、`STOPPED` であることを確認する。`STOPPED` 以外なら状態値を含む警告を出し、**起動も設定変更も行わない**
    - Good_Table の `DescribeTable`（PK / SK、3 GSI 定義、Streams の `NEW_AND_OLD_IMAGES`、PITR、アイテム件数 15,000）と任意抽出 10 件以上のアイテムの属性集合とアイテムサイズを、task 13.20 の比較基準としてファイルに保存する
    - 利用者が実行するコマンド：`npm run vector:measure -- --pre-check`
    - _要件: 1.5, 6.9, 6.10_

  - [x] 13.2 【実 AWS】段階 1〜2：Stage A をデプロイする（`vectorCollectionEnabled=false`）
    - 次元数バリデーション（DynamoDB 1〜4,096 / OpenSearch 1〜16,000）を合成前に通す
    - 作られるもの：Vector_Table、Query_Vector_Cache、Collection Group `kiro-inventory-vector-group` のみ。**Collection / Index / 検索 Lambda は作らない**
    - 利用者が実行するコマンド：`npx ampx sandbox`（コンテキスト `vectorCollectionEnabled=false`）
    - **注意：未デプロイの既存 Lambda 変更がサンドボックスに残っているため、このデプロイはその変更も同時に取り込む。**デプロイ前に `git status` と差分を確認し、取り込まれる既存変更の内容を記録する
    - ゲート：Vector_Table が GSI 0 本 / Streams なし / PITR 無効で作られていること
    - _要件: 1.1, 1.2, 1.8, 6.11_

  - [x] 13.3 【実 AWS】段階 3：Deployment_Validator を実行して min OCU 0 の受理可否を判定する
    - 利用者が実行するコマンド：`npm run vector:validate`
    - **これは課金対象リソース作成のブロッキングゲートである。**受理なら次段へ進む。拒否なら採用値と月額見積（≈ 175 USD/月）を提示し、続行の判断を得るまで先に進まない
    - _要件: 7.1, 7.2, 7.5_

  - [x] 13.4 【実 AWS】【壁時計 1 時間】段階 4：Collection 未作成の Collection Group が課金されないことを裏取りする
    - `SearchOCU` / `IndexingOCU` を 1 時間観測し、0 のままであることを確認する（Q4）
    - 0 でない場合は Stage A を即削除し、以降の判断を仰ぐ
    - 利用者が実行するコマンド：`npm run vector:measure -- --watch-spend`
    - _要件: 7.3, 7.7_

  - [x] 13.5 【実 AWS】段階 5：Good_Table → Vector_Table の複製を実行する
    - `POST /vector-search/embed-batch` に `phase = "copy"` で起動する
    - 完了後に Vector_Table が 15,000 件であることを確認する。一致しない場合は次段へ進まない
    - Good_Table への書き込みが 0 件であることを CloudWatch の書き込みメトリクスでも確認する
    - _要件: 1.3, 1.4, 1.7_

  - [x] 13.6 【実 AWS】S1 スナップショットを取得する（埋め込み書き込み開始前）
    - `TableSizeBytes` を取得時刻（UTC）とともに記録する
    - **前提の記録：**`TableSizeBytes` は約 6 時間周期で更新されるため、複製完了から 6 時間以上経過後に取得する。またベクトルインデックスの寄与は `IndexSizeBytes` で別途取得するため `TableSizeBytes` には含まれない前提を出力に明記する（デプロイ順序上、インデックス作成が埋め込み書き込みより前に来るため）
    - _要件: 14.2, 14.4_

  - [x] 13.7 【実 　AWS】段階 6：Stage B をデプロイする（`vectorCollectionEnabled=true`）
    - 作られるもの：Collection `kiro-inventory-vector`、Index `inventory-vector`（`knn_vector` 2 フィールド）、検索 Lambda 3 本、Capabilities Lambda、Index_Provisioner
    - 利用者が実行するコマンド：`npx ampx sandbox`（コンテキスト `vectorCollectionEnabled=true`）
    - ゲート：段階 3 で受理、または拒否内容と月額見積を提示して続行の判断を得ていること。既存 Collection と既存 Collection Group が変更されていないこと
    - _要件: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 7.5_

  - [x] 13.8 【実 AWS】段階 7：`byEmbeddingJa` を作成し ACTIVE 到達を待つ
    - Index_Provisioner の 1 回目の `UpdateTable`（要素数 1、`AttributeDefinitions` 同梱）で作成する
    - `IndexStatus` が ACTIVE に到達するまでカスタムリソースが待つ（上限 2 時間）。到達までの経過秒を記録する
    - **実測（記録済み）：ACTIVE 到達まで 546 秒。**CloudWatch Logs からの事後回収値であり、リアルタイム観測ではない
    - `SearchVectors` を TopK 1 で 1 回呼び、**生レスポンスを記録して距離スコアのフィールド名を確定する**（Q5）。この時点ではベクトル未投入のため 0 件になる場合はフィールド名確定を 13.13 に持ち越す
    - _要件: 5.1, 5.9, 5.10, 5.13_

  - [x] 13.9 【実 AWS】**Q6：2 本目の `UpdateTable` が受理されるかを観測する**
    - 13.8 の直後に `TableStatus` と `VectorIndexDescription[0].IndexStatus` を記録したうえで 2 回目の `UpdateTable` を発行し、`ResourceInUseException` / `LimitExceededException` が返るかを観測する
    - **この結果でデプロイ所要時間が約 180 分（並行可）と約 360 分（逐次のみ）に分かれる。**観測結果を Verification_Report に記録し、並行可なら段階 7 と 8 を 1 段にまとめられる旨も記録する
    - 設計の既定は逐次（英語側カスタムリソースが日本語側に依存）であり、この観測が失敗しても実装は変更しない
    - **判定結果（記録済み）：判定不能。**理由は `VectorIndexConstruct` が `resource.node.addDependency(previous)` で 2 本を逐次化しているため、「1 本目が非 ACTIVE のまま 2 本目の `UpdateTable` を発行する」条件が構造上成立しないこと
    - **実測の内容：**ja の CREATE_COMPLETE から 0.5 秒後に en が開始し、2 本目の `UpdateTable` は 1 本目が ACTIVE になった 7.55 秒後に発行された。`ResourceInUseException` / `LimitExceededException` は返らず、再試行の痕跡もなかった。ただしこれは**並行状態が作られていないため**であり、「並行受理可能」の証拠にはならない
    - **結論：スケジュール見積りは設計の既定（逐次・約 360 分側）を維持する。実装は変更しない。**Verification_Report には「判定不能」とその理由（構造上そもそも並行状態にならない）を記録する
    - _要件: 5.9, 5.13_
    - _設計: Open Questions Q6_

  - [x] 13.10 【実 AWS】段階 8：`byEmbeddingEn` を作成し ACTIVE 到達を待つ
    - Index_Provisioner の 2 回目の `UpdateTable`（要素数 1、逐次、`AttributeDefinitions` 同梱）で作成する
    - 2 本ともに同一次元数・同一距離関数（COSINE）で作られていることを `DescribeTable` で確認する
    - **実測（記録済み）：ACTIVE 到達まで 542 秒。**CloudWatch Logs からの事後回収値であり、リアルタイム観測ではない
    - _要件: 5.1, 5.2, 5.9, 5.10, 5.13_

  - [x] 13.11 【実 AWS】【壁時計 約 100〜115 分】段階 9：日英 2 本の埋め込みバッチを実行する
    - `POST /vector-search/embed-batch` に `phase = "embed"` で起動する。既定 120 req/min で 10,000 回の Bedrock 呼び出し、自己再帰 7 回以上
    - **所要時間は本質的に短縮できない**（10,000 ÷ 120 req/min ≈ 83 分 + 書き込みオーバーヘッド）。要件の 120 分以内に収まることを実測で確認する
    - 完了後に返却 JSON（言語別の呼び出し回数・入力トークン数・所要秒・失敗件数・切り詰め件数・検証の一致件数）を保存する
    - Ingestion_Pipeline が `STOPPED` のままであることを再確認する
    - **本タスクの実行中に判明した事実（記録）：**旧実装の OpenSearch 側の読み出し検証は成立しない。実測値は `storedCount 1712 / bedrockCalls 1712 / failedCount 0 / truncatedCount 0 / verifiedMatchedCount 0 / verifiedMismatchedCount 1712`、失敗一覧 100 件はすべて `stage: VERIFICATION` / `errorCode: ACCESS_DENIED_IAM` / `security_exception: [security_exception] Reason: Bad Authorization`。原因は要件 17.7 が埋め込みバッチロールの Vector_Collection 権限を `aoss:WriteDocument` のみに限定しており、読み出しに必要な `aoss:ReadDocument` を持たないこと
    - **OpenSearch 側の検証は本タスクの責務から外れた。**案 D に従い task 17.1〜17.3 が担う。本タスクに残る検証は Vector_Table 側のみ（要件 3.6 / 3.12）
    - _要件: 3.4, 3.5, 3.6, 3.8, 3.12, 4.6, 6.8, 6.9, 14.1_

  - [x] 13.12 【実 AWS】段階 10：2 本それぞれのバックフィル完了を確認する
    - `npm run vector:measure -- --wait-index` で 60 秒間隔にポーリングし、各インデックスの ACTIVE 到達時点とバックフィル完了までの経過秒を記録する（上限 180 分、逐次なら最悪 360 分）
    - `Backfilling !== true` になるまで検索結果をレイテンシおよび Recall_At_K の測定値として採用しない
    - **段階 8 で ACTIVE 済みでも、段階 9 の書き込みでバックフィルが再度走るため必ず再確認する**
    - **観測結果（記録）：`VectorIndexes[].Backfilling` はキー自体が返らない。**13.7 のデプロイ直後（ベクトル未投入）でも本タスクの時点（15,000 レコード投入後）でも不在であり、`true → false` の遷移を一度も観測していない
    - **含意：**要件 5.15 の判定（`Backfilling !== true`）は「不在 = 偽」として成立し検索可否は判定できるが、**要件 5.14 の「バックフィル完了までの経過時間」は測定不能である。**要件 5.17 を新設して不在時の扱いを定めた。フィールド不在を出力および応答に含める実装は task 18.4 で行う
    - _要件: 5.14, 5.15, 5.17_

  - [x] 13.13 【実 AWS】Q5：`SearchVectors` の生レスポンスを記録して `rawScore` マッピングを確定する
    - TopK 1 で 1 回呼び、生レスポンスの距離スコアのフィールド名を記録して `VectorSearchHit.rawScore` の対応を確定する
    - 必要ならハンドラのマッピングを修正し、単体テストを追加する
    - **実測結果（記録済み。Q5 決着）：**
      - **`SearchResults[].Score` はコサイン距離（1 − cos）そのものであり変換不要。**返却行の格納ベクトルからローカル算出した厳密距離との残差は **3.36e-8**。候補式 `1 − Score` / `2 − 2 × Score` / `1/Score − 1` はいずれも残差 0.8 以上で棄却した。したがって `VectorSearchHit.distance = rawScore = Score` とする
      - **`ConsumedCapacity` は `{ VectorSearchRequestBytes, VectorSearchUnits }` の 2 項目のみ。**`VectorWriteRequestBytes` / `CapacityUnits` / `ReadCapacityUnits` / `Table` / `Indexes` はいずれも返らず、`ReturnConsumedCapacity: INDEXES` を指定しても内訳は返らない。`VectorSearchUnits` は **SDK の `VectorCapacity` モデルに存在しない**ため、生応答から読んで応答へ載せる（要件 8.11）
      - 観測値は `VectorSearchRequestBytes: 61318` / `VectorSearchUnits: 61318`。**61,318 バイトは 1,024 次元 f32 のクエリ（4 KiB）より一桁大きい。**フィールド名に反してリクエストサイズではなく走査量に応じた単位である可能性が高いが**断定しない。**TopK 依存かを task 13.18 で確認する
      - **`SearchVector` は `AttributeValue[]`（`[{"N":"..."}]`）でのみ受理される。**素の数値配列は HTTP 400 `SerializationException` で拒否される（要件 8.14）
      - 生レスポンスにベクトル本体は含まれない（射影に埋め込み属性を含めていないため。要件 8.15）。生応答のトップレベルは `ConsumedCapacity` と `SearchResults` の 2 キーのみ
      - 記録先：`docs/measurements/measure-search-response-shape-2026-08-21T13-09-22-492Z.json`
    - _要件: 8.9, 8.11, 8.14, 8.15, 18.23_
    - _設計: Open Questions Q5 / スコア正規化 / 知見 8_

  - [x] 13.14 【実 AWS】【壁時計 6 時間 × 最大 3 回】S2 と `IndexSizeBytes` を取得して収束判定する
    - S2（埋め込み完了後の `TableSizeBytes`）を取得し、S1 との差分をベクトル属性の寄与として算出する
    - 2 本の `IndexSizeBytes` と `ItemCount` を直接取得して合計する
    - 6 時間以上あけた連続 2 回の差が 1% 以内であることを確認して採用値を確定する。超過なら最大 3 回まで再取得し、収束しなければ最終値・未確定・推定誤差幅を出力する
    - **1 本目のスナップショットの実測値（記録。収束判定の 2 本目を待っており採用値ではない）：**`TableSizeBytes 138,127,144` / `IndexSizeBytes 74,557,051 × 2 本` / インデックスの `ItemCount 14,991 × 2 本`（テーブルの 15,000 件との 9 件差は約 6 時間周期の概数更新の遅れ）。ベクトル属性の寄与は `124,725,120 B`、1 レコードあたり平均増分は `8,315 B`。**いずれも未確定である**
    - **2 本目のスナップショット（2026-08-21T23:22:27.972Z / 23:22:51.651Z）で全対象が収束し、採用値が確定した（`status: converged` / `determinate: true`）。**1 本目との間隔は 9.98 h（`TableSizeBytes`）および 9.97 h（`IndexSizeBytes`）で 6 時間の条件を満たし、相対差は 0.05%（`TableSizeBytes`）/ 0.06%（`IndexSizeBytes`）で許容 1% 以内。再取得回数は `TableSizeBytes` 0 回 / `IndexSizeBytes` 2 回（いずれも上限 3 回未満）であり、推定誤差幅の出力は不要（`estimatedErrorRange: null`）
      - **採用値：**S1 `TableSizeBytes 13,402,024 B` / S2 `TableSizeBytes 138,202,024 B`。**ベクトル属性の寄与は `124,800,000 B`（119.02 MiB）、1 レコードあたり平均増分は `8,320.00 B`**（÷ 15,000 レコード）。1 言語あたり `4,160 B` = 1,024 次元 × 4 B（f32）+ 64 B のオーバーヘッドであり、2 言語分で 1 次元あたり実効 4.0625 B に相当する
      - **採用値：**`IndexSizeBytes` は `byEmbeddingJa 74,602,024 B` / `byEmbeddingEn 74,602,024 B`、**合計 `149,204,048 B`（142.29 MiB）**。インデックスの `ItemCount` は 2 本ともに `15,000` で、1 本目に見られたテーブル件数との 9 件差は 2 本目で解消した（約 6 時間周期の概数更新の遅れであったことが裏付けられた）
      - **`IndexSizeBytes` と `ItemCount` は 2 本のインデックスそれぞれの `VectorIndexDescription` から直接取得した値である。`TableSizeBytes` スナップショットの差分からは算出していない**（要件 14.3、出力の `derivedFromTableSizeDifference: false`）
      - **Vector_Table は GSI を 1 本も持たないため、GSI 複製分を差し引く補正は適用しない**（要件 14.6、出力の `gsiAdjustmentApplied: false`）。`TableSizeBytes` の差分がそのままベクトル属性の寄与になる
      - 台帳 `docs/measurements/storage-snapshots.json` は追記のみで、先行する 8 件を破棄せず 14 件へ増えた（要件 14.5）。成果物は `docs/measurements/measure-storage-2026-08-21T23-22-27-972Z.json` と `docs/measurements/measure-storage-2026-08-21T23-22-51-651Z.json`
    - **運用上の注意（記録）：`--watch-spend` の既定の集計区間は直近 24 時間のローリングウィンドウであり、検証開始からの通算ではない。**要件 7.7 の「累積 20 USD」を評価するには `--hours` を検証開始時点まで遡る値に明示的に広げる必要がある。既定値のまま読むと複数日にわたる検証で累積額を過小評価する
    - _要件: 7.7, 14.2, 14.3, 14.4, 14.5, 14.6_

  - [x] 13.15 【実 AWS】段階 11：Q2 スコア正規化キャリブレーションを実行して式を確定する
    - 5 本のクエリ（日本語 3 / 英語 2）で k-NN を実行し、上位 10 件の `_id` と生スコアを取得する
    - 各 `_id` に対応する SKU ベクトル（クエリと同じ言語のフィールド）とクエリベクトルからローカルで厳密なコサイン距離 `d_local` を計算する
    - 式 A（`2 − 2 × score`）と式 B（`1 / score − 1`）の残差 `|d_calc − d_local|` の最大値を比較し、1e-3 未満に収まる式を採用する
    - **採用式を `score-normalize.ts` の既定値として確定する。**どちらも収まらない場合は faiss の取り込み時正規化と Titan の `normalize` 設定を含めて再検証する
    - 採用式と最大残差を記録する
    - **実測結果（記録済み。Q2 決着）：**
      - **式 A（`d = 2 − 2 × score`）を採用。最大残差 1.23e-7** で閾値 1e-3 を 4 桁下回った。式 B（`1 / score − 1`）は 1.72e-1 で棄却。参考として `d = score` は 4.81e-1、`d = 1 − score` は 2.95e-1 でいずれも棄却
      - すなわち**現行の k-NN spaces ドキュメントの `score = (2 − d) / 2` が AOSS の VECTORSEARCH コレクションに成立し、旧版の nmslib / faiss 記述（`score = 1 / (1 + d)`）は成立しない**
      - 実測条件：2026-08-21 / us-west-2 / `SpaceType: cosinesimil` / 1,024 次元 / Paired_Query_Set から 5 本（ja 3 / en 2）× 上位 10 件 = 50 件
      - **キャリブレーション手順の手順 5（faiss の取り込み時正規化と Titan の `normalize` 設定の再検証）は不要だった。**格納ベクトル 50 件とクエリベクトル 5 本のノルムがいずれも 1 ± 1e-7 であり、正規化状態の食い違いが存在しなかった
      - **DynamoDB 側（task 13.13：`Score` が距離そのもの）と OpenSearch 側（式 A）でスコアと距離の対応が異なる。**両者を混同しないこと
      - 観測：5 本すべてで `returnedCount 10 / distinctSkuCount 4`（同一ベクトルの 3 行複製による希釈と整合）。1 本目は Cold_Start に当たり `took 19,349 ms` / `searchLatencyMs 19,879 ms` で、要件 9.9 の打ち切り 30,000 ms 以内に収まった
    - _要件: 9.5, 9.6, 9.9, 18.6_
    - _設計: Open Questions Q2 / キャリブレーション手順 / 知見 8_

  - [x] 13.16 【実 AWS】段階 12：Q1 範囲フィルタの実測プローブを実行して対応可否を確定する
    - `npm run vector:probe-range` を実行し、`INLINE_FILTER` 属性への範囲条件の実挙動（成功 / 拒否とエラー内容）を記録する
    - 結果が「対応する」なら `constraints.supportedFilterKinds` に `"range"` を追加する（UI の比較表は自動的に追従する）
    - **使い捨てインデックスの追加コストと所要時間が許容できない場合は省略し、Verification_Report に「未実測」とドキュメント間の矛盾内容のみを記録する**
    - _要件: 8.7, 15.2, 18.5_

  - [x] 13.17 【実 AWS】段階 13：言語別 recall を測定する
    - `npm run vector:recall` で Paired_Query_Set 50 件以上 × Distinct_Sku_K（1 / 10 / 33）× 言語（ja / en）× バックエンド（2 種）を実行する
    - 要求 TopK は `3 × Distinct_Sku_K`（3 / 30 / 99）とする
    - 出力 JSON（平均・最小・0.99 未満件数・合否・言語間差分・同値件数・完全同値行件数・風味クエリの Material_Sku 件数）を `docs/measurements/` に保存する
    - 日本語クエリ 3 件以上と対応する英語クエリの上位結果（クエリ文字列と返却商品名）を観察例として記録する
    - _要件: 13.3, 13.4, 13.5, 13.6, 13.8, 13.9, 13.11, 13.13, 13.14, 13.15, 18.9, 18.10_

  - [x] 13.18 【実 AWS】段階 13：消費キャパシティと転送量、レイテンシを測定する
    - `SearchVectors` を同一条件で 100 回 × 2 言語実行し、1 検索あたり消費キャパシティの平均・最小・最大と合計を出力する
      - **実測（TopK 30 / 決定論シード 20260101 / 逐次 / 失敗 0 件 / 欠落 0 件）：**`byEmbeddingJa` は 1 検索あたり**平均 77,551.97 B / 最小 76,871 B / 最大 77,874 B / 合計 7,755,197 B**、`byEmbeddingEn` は**平均 86,417.40 B / 最小 85,359 B / 最大 87,347 B / 合計 8,641,740 B**。200 回の合計は **16,396,937 B**、通算平均は **81,984.685 B**
      - **同一条件でも 1 検索あたりの値は一定でない**（ja の幅 1,003 B = 平均比 1.3% / en の幅 1,988 B = 2.3%）。**同一 TopK でもインデックスによって水準が違う**（差 8,865 B = 11.4%）。クエリベクトルは 2 本とも同一であるため差はインデックス側に由来する
    - **Q（13.15 からの持ち越し 1）：`VectorSearchUnits` は常に `VectorSearchRequestBytes` と等しいか。**→ **本タスクで比較可能だった 270 件すべてで同値。食い違いは 1 件も観測しなかった**（同一条件 200 件 + TopK 掃引 70 件）。`VectorSearchUnits` は SDK の `VectorCapacity` モデルに無いため生応答から読んだ（`readVectorSearchUnits` を追加）。**ただし観測範囲は 1 テーブル / 2 インデックス / 1,024 次元 / COSINE / TopK 1〜100 に限る。反例が無いことを示したのであり、API 仕様として常に同値であることを示したのではない**
    - **Q（13.15 からの持ち越し 2）：61,318 B は TopK 依存か。**→ **依存する。単調増加し、実測範囲では線形にきわめて近い**（`byEmbeddingJa` / TopK ごとに 10 回）
      - **実測：**TopK 1 → 平均 **61,307.3 B**（13.13 の 61,318 B と 0.02% 差で一致）/ TopK 3 → **62,257.5 B** / TopK 10 → **66,194.3 B** / TopK 30 → **77,278.0 B** / TopK 50 → **88,856.8 B** / TopK 99 → **116,474.8 B** / TopK 100 → **117,243.8 B**（TopK 1 の 1.91 倍）
      - **最小二乗フィット：`bytes ≈ 60,559.8 + 565.51 × TopK`（R² = 0.999967 / 最大残差 247 B）。**TopK 非依存の大きな固定成分（約 60.6 KB）と TopK 比例成分（約 566 B/件）に分解できる
      - **フィールド名に反して要求サイズではない。**1,024 次元 f32 のクエリは 4,096 B で TopK を変えても要求本文は変わらないのに、実測値は 61 KB → 117 KB まで動く
      - **走査量に対応するという断定はしない。**固定成分と比例成分が何を数えているかは黒箱観測から確定できない。比例成分 565.5 B/件は 1 件の応答本文 1,125 B（13.13 実測）の半分程度であり、応答バイト数とも一致しない。同一条件での揺れ（1〜2%）とインデックス間の水準差（11.4%）は「要求内容だけで決まらない」ことを示すが、原因は特定していない
    - `VectorSearchRequestBytes` を測定区間（開始・終了時刻 UTC 付き）について 2 本のインデックスそれぞれで取得し、合計と 1 検索あたり平均を出力する
      - **測定区間（UTC）：2026-08-22T03:50:00Z 〜 03:51:00Z**（同一条件 200 回が収まる 1 分バケット。TopK 掃引 03:52 / レイテンシ 03:52〜03:53 / UI 検証 03:56 は別バケットで混入しない）。次元は `TableName` + `VectorIndexName`
      - **実測：`byEmbeddingJa` 合計 7,755,197 B / データ点 100 件 / 1 検索あたり 77,551.97 B、`byEmbeddingEn` 合計 8,641,740 B / データ点 100 件 / 1 検索あたり 86,417.40 B。2 本の合計 16,396,937 B / 200 件 / 1 検索あたり 81,984.685 B**
      - **CloudWatch の `Sum` は同区間の `ConsumedCapacity.VectorSearchRequestBytes` の総和と完全一致した（差 0 B、`SampleCount` も検索回数と一致）。**2 つの経路は同一の量を数えている
      - 本タスク全体（03:45Z〜04:10Z）では `byEmbeddingJa` 186 件 / 15,009,944 B、`byEmbeddingEn` 116 件 / 9,976,242 B、計 302 件 / 24,986,186 B であり、DynamoDB 検索の実施回数（同一条件 200 / 掃引 70 / レイテンシ 30 / UI 2）と一致した
    - 両バックエンドのレイテンシ（最小・中央値・最大・試行回数）を、DynamoDB は `searchLatencyMs` / `handlerLatencyMs`、OpenSearch は `took` / `searchLatencyMs` の区別を保って記録する
      - 条件：Paired_Query_Set 5 件（q01 / q03 / q22 / q31 / q53）× 2 言語 × 3 回 = **各バックエンド 30 試行**。要求 TopK 30、両バックエンドは同一 `queryId`（同一クエリベクトル）を共有
      - **実測（4 区間を混ぜず個別に記録。単位ミリ秒）：**
        - **DynamoDB `searchLatencyMs`：試行 30 / 最小 9 / 中央値 19.5 / 最大 398**（Cold_Start を除く 29 試行では 最小 9 / 中央値 19 / 最大 240）
        - **DynamoDB `handlerLatencyMs`：試行 30 / 最小 15 / 中央値 27.5 / 最大 687**（同 29 試行では 最小 15 / 中央値 27 / 最大 440）
        - **OpenSearch `took`：試行 30 / 最小 92 / 中央値 177 / 最大 18,356**（同 29 試行では 最小 92 / 中央値 166 / 最大 947）
        - **OpenSearch `searchLatencyMs`：試行 30 / 最小 116 / 中央値 213 / 最大 18,962**（同 29 試行では 最小 116 / 中央値 213 / 最大 978）
      - 中央値の比は **OpenSearch 213 ms ÷ DynamoDB 19.5 ms = 10.9 倍**（いずれも埋め込み生成を含まない 1 往復の区間）
      - **Cold_Start は両バックエンドの 1 回目に発生し、各区間の最大値はこの 1 件が作っている。**OpenSearch は `took 18,356` / `searchLatencyMs 18,962` / `handlerLatencyMs 19,202`（直前アイドル約 16 分、13.15 の 19,349 / 19,879 と同水準、要件 9.9 の 30,000 ms 以内）。**遅延の 18,356 ms が `took` であるため AOSS 側の起動であり Lambda 初期化ではない。**DynamoDB は `searchLatencyMs 398` / `handlerLatencyMs 687` で桁が 2 つ小さい
      - **記載した埋め込みレイテンシは標準推論の値である（`inferencePath: "standard"` 全 10 件）。**実測 163〜187 ms（1 回目のみ 391 ms）。**us-west-2 の Titan v2 はレイテンシ最適化推論に非対応のため最適化の試行が必ず `ValidationException` で失敗してから標準へフォールバックし、`embeddingLatencyMs` には失敗した最適化往復が含まれる**（要件 18.22）
    - UI からの比較検証（重なり指標・機能制約比較表・言語切り替え）を実施して観察結果を記録する
      - **重なり指標：**UI と同一の共有関数 `computeVectorOverlap` に実 API の `hits` を渡した（q22 / TopK 30 / 日英）。**ja / en ともに `commonCount 30` / `unionCount 30` / 片側のみ 0 件 / Jaccard 1.000 / overlap@k 1.000 / 一意 SKU 10 件。**`(itemId, warehouseId)` 集合が両バックエンドで完全一致し、13.17 の recall 720/720 と整合した。表示順は同一ベクトル 3 行の同値で入れ替わるが集合は一致する
      - **機能制約比較表：**`GET /vector-search/capabilities` の実応答を取得した。DynamoDB は `maxTopK 100` / `supportedFilterKinds ['equality']` / `distanceFunctionMutable false` / `maxDimensions 4096` / `requiresOnDemandBilling true` / `readableByQueryScanPartiQL false`、OpenSearch は `maxTopK null` / `['equality','range']` / `false` / `16000` / `false` / `true`
      - **矛盾の指摘（13.16 の残作業）：`filterKindsUnverified` の文面が「実測で確定させる対象である」のまま公開されている。**13.16 で範囲フィルタは「対応しない」と確定済みであり、`range-filter-probe` の `followUp` も「実測で非対応を確認済み」への更新を指示している。`supportedFilterKinds: ['equality']` 自体は正しいため判定内容の矛盾ではないが、**文面の更新は `constraints.ts` の変更とデプロイを要するため本タスクでは実施していない**
      - **言語切り替え：**言語指定に応じて DynamoDB はインデックス（`byEmbeddingJa` / `byEmbeddingEn`）を、OpenSearch はベクトルフィールド（`embeddingJa` / `embeddingEn`）を切り替え、応答の `language` は両バックエンドで要求と一致した
      - **ブラウザでの DOM 操作は実施していない。**実行環境に手段が無いため、既存のコンポーネントテスト（`VectorSearchComparisonView` / `VectorConstraintTable` / `vector-overlap` の 17 テスト成功）と、UI が読む値の出所（共有関数と `capabilities` 応答）の実測で代替した
    - **本タスクの検索実施区間（UTC）：2026-08-22T03:50:01Z 〜 03:56:32Z（検索 334 件）。**以降は検索していないため **task 13.19 のアイドル 24 時間窓はこの時刻を起点にできる**
    - **台帳の更新：**Bedrock の成功埋め込みは **12 件追加**（レイテンシ測定 10 / UI 検証 2）で **通算 10,153 件**。`InvokeModel` API 呼び出しは 24 回・クライアントエラー 12 回（1 埋め込みにつき最適化失敗 1 + 標準成功 1）。**同一条件 200 回と TopK 掃引 70 回は決定論シードのクエリベクトルであり Bedrock を呼んでいない**
    - **累積課金：7.2167 OCU-hour × 0.24 USD = 1.73 USD（前回 1.64 USD / 増分 0.09 USD / 上限 20 USD / 残り 18.27 USD）。**`--hours 120` でも同値であり、Collection 作成が 2026-08-20 のため 48 時間窓が通算を覆っている
    - 記録先：`docs/measurements/capacity-latency-2026-08-22.json`（統合）/ `measure-capacity-2026-08-22T03-50-16-540Z.json` / `measure-capacity-2026-08-22T03-50-41-589Z.json` / `capacity-latency-2026-08-22T03-53-37-635Z.json` / `ui-comparison-2026-08-22T03-56-32-025Z.json`
    - _要件: 8.11, 8.12, 9.7, 9.8, 12.1〜12.7, 14.7, 14.8, 18.2, 18.3_

  - [x] 13.19 【実 AWS】【壁時計 24 時間】段階 14：scale-to-zero 判定のためアイドル OCU を観測する
    - **スコープ変更（利用者判断）：24 時間の新規連続観測は実施していない。**壁時計 24 時間は短縮できないため、利用者は既存の観測データ（CloudWatch に残る OCU 系列の全長）による確定を選択した。**本タスクは検索を 1 件も実行していない**（実行したのは CloudWatch と AOSS の読み取りのみ）。確定できた出力と未実測の出力を以下で分けて記録する
    - 検索 0 件かつインデックス 0 件を 24 時間連続で維持し、`SearchOCU` / `IndexingOCU` を 5 分間隔で取得して最小・平均・最大を出力する
      - **24 時間連続の専用観測は未実施。**理由は上記のスコープ変更。**5 分間隔の系列取得と最小・平均・最大は遡及で確定した**が、統計は窓ごとに意味が変わるため窓を明示せずに引用しないこと
      - **窓 A（遡及可能な全長）：2026-08-19T20:50:00Z 〜 2026-08-22T04:25:00Z（3,335 分 = 55.58 時間 / 667 サンプル / period 300 秒 / 欠測 0 件 / 対応付け 667 対・片側のみ 0 件）。**`SearchOCU` **最小 0 / 平均 0.103748 / 最大 2**、`IndexingOCU` **最小 0 / 平均 0.030885 / 最大 1**、合計 OCU **最小 0 / 平均 0.134633 / 最大 3**、累積 **7.4833 OCU-hour**。`--hours 72` と `--hours 120` で同一結果であり、これがメトリクス系列の全長である
      - **窓 B（直近 24 時間）：2026-08-21T04:25:00Z 〜 2026-08-22T04:30:00Z（289 サンプル）。**`SearchOCU` **最小 0 / 平均 0.109343 / 最大 2**、`IndexingOCU` **最小 0 / 平均 0.006920 / 最大 1**、累積 2.8000 OCU-hour。**これは要件 7.3 が求める窓ではない**（検索を実行した区間を 4 つ含む混合値であり、アイドル時の値として引用してはならない）
      - **窓 C（要件 7.3 の趣旨に最も近い実測窓）：2026-08-21T13:50:00Z 〜 2026-08-22T00:45:00Z（655.0 分 = 10.92 時間 / 131 サンプル）。**`SearchOCU` / `IndexingOCU` ともに **最小 0 / 平均 0 / 最大 0**、消費 **0 OCU-hour**。**4 条件がすべて揃う唯一の区間である**（131 サンプル全件で 0 / `SearchRequestRate` のデータ点 0 件 / `IngestionRequestRate` のデータ点 0 件 / `SearchableDocuments` = 15,000 で一定）。**24 時間に達しないのは、13.17 の事前確認検索が 00:45Z に区間を終了させたためである**
      - **最長の 0 OCU 区間は 1,555.0 分 = 25.92 時間で 24 時間を超えるが、要件 7.3 の代替として採用しない。**この区間（2026-08-19T20:50Z〜2026-08-20T22:45Z）の先頭 24.33 時間は **Collection がまだ存在せず**（作成は 2026-08-20T21:10:42Z）、`SearchableDocuments` は末尾 5 分バケット（22:40Z）まで 0 件である。**要件 7.9 は OCU 消費が主にインメモリベクトルに起因するとしており、空の Collection の 0 OCU は 15,000 × 2 本を保持した Collection の 0 OCU の証拠にならない。**加えてリクエスト 0 件でもない（22:40Z バケットに `SearchRequestRate` / `IngestionRequestRate`、21:10Z バケットに Collection 作成時の `CreateIndex`）
    - `SearchOCU` と `IndexingOCU` がともに 0 の連続 1 時間以上の区間が存在するかで適用可否を二値判定する
      - **判定：適用可（scale-to-zero は適用される）。**窓 A において **0 OCU 区間 7 件 / 合計 3,135.0 分（窓の 94.0%）/ 最長 1,555.0 分**、うち **60 分以上が 4 件 / 合計 3,090.0 分**。基準（連続 1 時間）に対して 25 倍以上の余裕で成立する。アイドル時月額見積 **0 USD**（要件 7.6）。要件 7.4 の常時課金見積は適用可のため算出対象外
      - **13.18 の暫定値を独立に再現した。**48 時間窓での再取得は **7 件 / 合計 2,685.0 分 / 最長 1,100.0 分 / 60 分以上 4 件 2,635.0 分**で、13.18 の 6 件 / 2,695.0 分 / 1,130.0 分 / 4 件 2,665.0 分との差は窓の境界だけで説明できる（起点が約 26 分後ろへ動いて最長区間が 30 分切られ、代わりに進行中アイドル 20.0 分が 1 件として現れた）。**同一系列を別の窓で切った像であり、値を写したのではなく再計算した**
      - **CloudWatch とは別経路でも裏を取った。**`BatchGetCollectionGroup` の `currentCapacity` が 2026-08-22T04:28Z 時点で indexing / search ともに **0.0 OCU / `autoscalingStatus: NO_ACTION`**（最終検索 03:56:32Z から約 32 分後）。`capacityLimits` は min 0.0/0.0・max 2.0/2.0 で要件 7.1 どおり受理されている
    - `OCUUtilization` の最小・平均・最大を取得する
      - **測定不能（要件 7.8 は本検証では満たせない）。0 と記録してはならない。**「使用率 0 を測定した」ではなく「メトリクスが公開されていない」である
      - **証拠 1：**`ListMetrics --namespace AWS/AOSS`（us-west-2 / 992382598974）は **100 系列 / 15 メトリクス名**を返し、`NextToken` は無い。返却名は `2xx` / `4xx` / `ActiveCollection` / `DeletedDocuments` / `IndexingOCU` / `IngestionRequestErrors` / `IngestionRequestLatency` / `IngestionRequestRate` / `IngestionRequestSuccess` / `SearchOCU` / `SearchRequestErrors` / `SearchRequestLatency` / `SearchRequestRate` / `SearchableDocuments` / `StorageUsedInHot` の 15 件で、**`OCUUtilization` は含まれない**
      - **証拠 2：**`ListMetrics --metric-name OCUUtilization` を名前指定で引くと `{ "Metrics": [] }`
      - **証拠 3：**`SearchOCU` / `IndexingOCU` と同一の次元キー集合・同一の式形の `SEARCH()` で `Minimum` / `Average` / `Maximum` の 3 統計を引いて **系列 0 本 / データ点 0 件**（2026-08-17T04:20Z〜2026-08-22T04:25Z）。同じ式形で他の 2 つは系列 1 本 / データ点 667 件を返すため、**次元指定の誤りによる空振りではなくメトリクスの不存在である**
      - **主張の範囲：**「us-west-2 のこのアカウントの NextGen VECTORSEARCH Collection Group で公開されていない」ことを示した。AOSS の仕様として存在しないことを示したのではない（`ListMetrics` は直近約 14 日にデータのあるメトリクスのみを列挙する）
    - scale-to-zero 状態からの Cold_Start 所要時間（秒、小数第 1 位）を計測する
      - **未実測。**本仕様の基準である 60 分以上の連続 0 OCU 状態からの検索を 1 度も実行していない。**本タスクで検索すればアイドル記録を汚し、承認されたスコープ外になるため実行しなかった**
      - **最も近い実測 2 例（いずれも要件 9.9 の打ち切り 30,000 ms 以内）：**13.15 は `took` **19.3 秒** / `searchLatencyMs` **19.9 秒** / `handlerLatencyMs` **20.1 秒**（19,349 / 19,879 / 20,109 ms、直前の確定 0 OCU **25.0 分**＝2026-08-21T13:10Z〜13:35Z）、13.18 は `took` **18.4 秒** / `searchLatencyMs` **19.0 秒** / `handlerLatencyMs` **19.2 秒**（18,356 / 18,962 / 19,202 ms、直前の確定 0 OCU **5.0 分**＝2026-08-22T03:50Z〜03:55Z）
      - **13.18 の「直前アイドル約 16 分」は 0 OCU 状態の長さではない。**それは AOSS への検索が無かった時間であり、**`SearchOCU` が実際に 0 になっていたのは直前の 1 バケット（5.0 分）のみ**である。本タスクの 5 分系列で確認した
      - **この 2 点から継続時間と Cold_Start の関係は判定できない**（0 OCU 継続 5.0 分で 18.4 秒、25.0 分で 19.3 秒、差 0.9 秒、n = 2）。**60 分以上の 0 OCU からの値が同水準になるかは推定にとどまる**
      - **副産物の観測：検索終了から `SearchOCU` が 0 に落ちるまで約 14 分の遅れがある。**13.17 の最終検索（03:36Z 頃）→ 0 は 03:50 バケット、13.18 の最終検索（03:56:32Z）→ 0 は 04:10 バケット。**課金は最終検索の時点では止まらない**
    - `--watch-spend` を併走させ、累積 20 USD 超過時点で測定を終了して削除要求の警告を出す
      - **累積課金：7.4833 OCU-hour × 0.24 USD = 1.80 USD（前回 1.73 USD / 増分 0.07 USD / 上限 20 USD / 残り 18.20 USD）。**増分 0.2667 OCU-hour は 13.18 自身の検索の余韻（04:00Z / 04:05Z の 2 バケット）が当時の窓の外にあったものであり、**本タスク由来の増分は 0 である**
      - **`--hours 48` と `--hours 120` が同値**であるため 48 時間窓が通算を覆っている（既定の 24 時間はローリングウィンドウで通算ではないため使用しない）
      - **20 USD には遠く、警告は発火していない**（`測定終了: いいえ` / `thresholdCrossed: false`）。**発火したとは主張せず、経路の存在をコードとテストで確認した。**`accumulateSpend` が「累積 OCU-hour × 単価 > 閾値」を初めて満たした点で積算を打ち切り、削除対象（Collection / Collection Group）を含む警告を生成する。`measure.test.ts` の Property 50 と「20 USD を初めて超えた時点で打ち切り、削除実行を要求する警告を出す」（63 サンプルで 20.16 USD に到達）で担保されており、70 テスト成功
      - **積算は下限見積である。**対象は `SearchOCU` / `IndexingOCU` から導く OCU-hour のみで、`vectorOptions.ServerlessVectorAcceleration: ENABLED` に伴う OCU-hour に還元されない課金要素を含まない
    - **観測期間は短縮できない。**この間は検索を一切実行しない
      - **本タスクの検索実行回数は 0 件。**アイドル区間は 2026-08-22T04:10:00Z から継続しており、本タスクはこれを中断していない
    - **要件 14.9 の区間分解（窓 A）：**検索継続区間（30 分以上）は 2 件 — **2026-08-20T22:45Z〜2026-08-21T00:20Z / 95.0 分 / 4.6833 OCU-hour（検索 3.1333 / インデックス 1.5500）**は 13.11 の投入であり純粋な検索区間ではない、**2026-08-22T03:15Z〜03:50Z / 35.0 分 / 0.9667 OCU-hour（すべて検索）**が 13.17 の recall で**要件 14.9 が意図する検索継続区間**。アイドル区間（6 時間以上）は 3 件 — **1,555.0 分 / 0 OCU-hour**、**745.0 分 / 0 OCU-hour**、**655.0 分 / 0 OCU-hour**。**アイドル時の OCU 使用量は 3 区間すべて 0.00 OCU-hour**（要件 18.3 の記載値）。区間分解の総和は窓全体の 7.4833 OCU-hour と一致した（欠落も重複もない）
    - **測定不能を 0 と混同しない箇所がもう 1 つある。**Collection Group の作成は 2026-08-18T16:28:38Z だが OCU 系列の最初のデータ点は 2026-08-19T20:50:00Z であり、**その間の約 28.4 時間はデータ点が存在しない**。この区間を 0 として扱っていない
    - **副産物：Q4（コレクションを含まない Collection Group が課金対象か）の補強証拠が得られた。**2026-08-19T20:50:00Z 〜 2026-08-20T21:10:42Z（**約 24.3 時間**）は Collection が存在せず、`SearchOCU` / `IndexingOCU` が**明示的に 0 の値で publish されていた**（データ点の不存在ではなく 0 の実測）。段階 4（13.4）の 1 時間観測より 24 倍長い区間で同じ結論を支持する。**ただし OCU-hour が 0 であることは課金 0 の必要条件であって十分条件ではない**ため、0 課金の確定には請求データ（Cost Explorer / Billing の AOSS 利用種別）が必要である
    - **要件の文面判断は利用者に委ねる（適用していない）。**要件 7.3 には「24 時間連続の専用観測が不可能な場合の代替（遡及窓での確定と未実施の明記）」、要件 7.8 には「`OCUUtilization` は当該環境で公開されず測定不能」の追記案がある。**既に保留中の要件 15.2 / `filterKindsUnverified` の文面判断があるため、その待ち行列に追加する**（文案は成果物 JSON の `openItemsForUser`）
    - 記録先：`docs/measurements/scale-to-zero-2026-08-22.json`（統合）/ `measure-ocu-2026-08-22T04-24-12-566Z.json`（`--ocu --hours 120` の生成物）
    - _要件: 7.3, 7.4, 7.6, 7.7, 7.8, 14.9, 18.3, 18.7_

  - [x] 13.20 【実 AWS】段階 15：Good_Table の不変性を確認する
    - 13.1 のスナップショットと比較し、PK / SK、3 GSI 定義、Streams の `NEW_AND_OLD_IMAGES`、PITR、アイテム件数 15,000、抽出 10 件以上の属性集合とアイテムサイズが同一であることを確認する
      - **結果：比較した 27 項目すべて一致（相違 0 件）。**基準は `docs/measurements/good-table-snapshot-pre-check.json`（13.1 / 2026-08-18T16:56:03.151Z / 版 2）で、**基準ファイルは読み取りのみ（`--no-write` 指定で上書きしていない）**
      - **2 つの独立した取得経路で同じ結論を出した。**経路 A は 13.1 と完全に同一手順（`--pre-check --no-write` = `DescribeTable` + `DescribeContinuousBackups` + `Scan(Limit 40)` → `itemId#warehouseId` 昇順で先頭 10 件）で、**選ばれた 10 キーが基準と同一であることを実際に確認した**。経路 B は基準の 10 キーを明示指定した `BatchGetItem`（Scan の返却順に依存しない照合。15.1 の `--teardown-check` と同じ経路）。**どちらも `identical: true` / 相違 0 件 / 突き合わせ 10 件 / 取得できなかったキー 0 件**
      - **PK / SK：**`itemId:HASH, warehouseId:RANGE` — 一致
      - **3 GSI：**`byLocation`（`warehouseId:HASH, location:RANGE`）/ `byUnitPrice`（`warehouseId:HASH, unitPrice:RANGE`）/ `byWarehouse`（`warehouseId:HASH, itemId:RANGE`）の**インデックス名・キースキーマ・`ProjectionType: ALL` がすべて一致**。**射影属性リストは基準・現在ともに「列挙なし」**（`ProjectionType: ALL` の GSI は `NonKeyAttributes` を返さないため、明示列挙は原理的に存在しない。両側とも空で一致）
      - **知見 1（`ProjectionType: ALL` へのベクトル複製）への直接確認：複製は起きていない。**GSI 定義が不変であることだけでは不十分なので、**基底テーブルの属性集合が不変（抽出 10 件すべて既存 8 属性のみ）**であることと、**`TableSizeBytes` 3,074,326 B に対し 3 本の GSI の `IndexSizeBytes` がいずれも 3,074,326 B で完全一致**していることを併せて根拠にした（1 件あたり約 8 KB のベクトルが入っていれば一致しない）。参考：Vector_Table は 138,202,024 B（約 45 倍）
      - **Streams：**`StreamEnabled: true` / `NEW_AND_OLD_IMAGES` — 一致。`LatestStreamLabel` が `2026-08-07T22:42:43.420`（テーブル作成時刻）のままで、無効化と再有効化を経ていない
      - **PITR：**`ENABLED` — 一致（`DescribeContinuousBackups`。`DescribeTable` には現れない項目）。`RecoveryPeriodInDays` 35 / `EarliestRestorableDateTime` 2026-08-08T07:43:14+09:00（作成直後のまま）/ `LatestRestorableDateTime` 2026-08-22T13:38:25.290+09:00
      - **アイテム件数：**基準 15,000 / 現在 15,000 — 一致。**`ItemCount` は約 6 時間周期の概数**（13.14 で 9 件の遅れを実測した経緯がある）だが、**概数どうしが完全一致したため全件 `Scan` は実行していない（RRU 消費 0）**。傍証として 3 GSI の `ItemCount` がいずれも 15,000、Vector_Table が 15,000、AOSS の `SearchableDocuments` が 15,000（13.19）。**「15,000 件を数えた」とは主張しない。「基準と同じ値を返している」ことを主張する**
      - **抽出 10 件（要件 1.5 は 10 件以上）：属性集合とアイテムサイズが全件一致。**属性は 10 件すべて `itemId` / `itemName` / `lastUpdated` / `location` / `lotNumber` / `quantity` / `unitPrice` / `warehouseId` の 8 個。サイズは 214 / 212 / 212 / 225 / 223 / 223 / 216 / 216 / 214 / 214 B で基準と 1 バイトも違わない（サイズは `estimateItemSizeBytes` の推定値だが基準も同一関数のため一致判定に使える）
      - **知見 2（専用テーブル分離）の中心的主張を明示確認：Good_Table 側に埋め込み属性は 1 つも存在しない。**`embeddingJa` / `embeddingEn` / `embeddingModel` / `embeddingDimensions` / `embeddingUpdatedAt` / `metaJa` / `metaEn` はいずれも不在。同一キー（`ITEM#BLEND-CLASSIC-MEDIUM-200G` / `WH-FUKUOKA`）の Vector_Table 側レコードは 14 属性でこれらを持つ
      - **Good_Table の `VectorIndexes` は 0 本（要件 1.6）。これは SDK 未対応による不表示ではない。**同一プロセス・同一 SDK（同梱 `@aws-sdk/client-dynamodb` 3.1112.0）で Vector_Table を引くと `byEmbeddingJa` / `byEmbeddingEn` の 2 本（ともに `ACTIVE` / `searchable: true` / 各 74,602,024 B / 15,000 件）が返る。**参考：ローカルの `aws` CLI は Vector_Table に対しても `VectorIndexes` を null で返すため、この判定に CLI は使っていない**
      - **比較できなかった項目（基準に記録が無いため。省略せず明示する）：**`TableSizeBytes`、GSI の `IndexSizeBytes` / `ItemCount`、`AttributeDefinitions`、`BillingModeSummary`、`DeletionProtectionEnabled`、`WarmThroughput`、`LatestStreamArn`、PITR の期間系、`TableId` / `CreationDateTime`、および**抽出 10 件の属性「値」**。いずれも要件 1.5 の列挙項目には含まれない。**とくに属性値は基準が属性名とサイズ推定しか持たないため、「同じ属性名・同じサイズで値だけが書き換わった」変更は本比較では検出できない**（要件 1.4 は IAM とコードで担保し、本比較はその補強）。現在値は成果物 JSON の `notComparableBecauseBaselineDidNotRecord` に全件記録した。`TableId` と `CreationDateTime`（2026-08-08T07:42:43.420+09:00）が作成時のままであることは、テーブルが削除・再作成されていないことを示す
    - OSIS `kiro-inventory-pipeline` が `STOPPED` のままであることを確認する
      - **実測：`STOPPED`（`StatusReason: The pipeline is stopped`）。**`aws osis get-pipeline` / 2026-08-22T04:43Z 時点。基準（13.1）も `STOPPED` で相違なし。**起動も設定変更も行っていない（要件 6.10）**
      - **`LastUpdatedAt` は 2026-08-11T22:47:56+09:00** で、13.1 の基準取得（2026-08-18）より前である。**本機能の期間中にパイプライン設定が変更されていない**ことを示す。`MinUnits` 1 / `MaxUnits` 4、ソースは Good_Table、シンクは既存の SEARCH コレクション `kiro-inventory-search`（本機能の `kiro-inventory-vector` ではない）
    - **本タスクは読み取り専用。変更系の呼び出しは 0 件**（作成・変更・削除なし / デプロイなし / パイプライン状態の変更なし / ベクトル検索 0 件）。消費キャパシティは**推定**で約 7〜8 RRU（`Scan(Limit 40)` 約 0.5〜1 + Good_Table の `BatchGetItem` 10 件 約 5 + Vector_Table の `BatchGetItem` 1 件 約 1.5。`ReturnConsumedCapacity` は指定していない）
    - **累積課金と台帳は変化なし。**`--watch-spend --no-write --hours 48` で **7.4833 OCU-hour × 0.24 = 1.80 USD（前回 1.80 USD / 増分 0.00 / 残り 18.20 USD / `thresholdCrossed: false`）**。Bedrock の成功埋め込みは **10,153 件のまま**（`AWS/Bedrock` の `Invocations` を 2026-08-22T03:57Z〜04:55Z で照会しデータ点 0 件）。**13.19 が確定させたアイドル区間（04:10:00Z から継続）を汚していない**
    - **判定：要件 1.5 と 6.9 はいずれも満たす。ドリフトは 1 件も検出されなかった**
    - 記録先：`docs/measurements/good-table-immutability-2026-08-22.json`
    - _要件: 1.5, 6.9_

  - [x] 13.21 【実 AWS】【壁時計】512 / 256 次元のトレードオフを測定する（任意）
    - 次元数を 512 と 256 に変更してインデックス再作成と再投入を行い、ベクトル属性の寄与、`IndexSizeBytes` 合計、1 レコードあたり平均増分、同一 Paired_Query_Set に対する言語別 Recall_At_K の平均、本番想定規模の月額見積を 1,024 次元と同一表形式で対比する
    - ストレージとインデックスの増分が 2 言語分として計上されることを明記する
    - **核心の検証（1,024 次元での DynamoDB 対 OpenSearch 比較）には不要なため、コストとスケジュールが許す場合のみ実施する**
    - **実施しない（利用者判断）。本タスクは 未実測 として確定して閉じる。**本タスクは表題が**（任意）**であり、直上の行が定めるとおり**核心の検証（1,024 次元での DynamoDB 対 OpenSearch 比較）には不要**である。利用者に 3 案（全実施 / 一部実施 / 未実測として記録して閉じる）を提示し、**未実測として記録して閉じる**が選択された
      - **これは「測定不能」ではなく「実施可能だが実施しないと決めた」である。**13.12 の `Backfilling` 経過時間、13.19 の `OCUUtilization` はいずれもサービス側が値を返さない**測定不能**であり、種類が違う。混同して引用しないこと。13.19 の Cold_Start（60 分以上の 0 OCU 状態からの計測を承認スコープ外として実行しなかった）が最も近い先例である
      - **本タスクでは AWS 呼び出しを 1 件も行っていない。**変更系 0 件 / 読み取り系 0 件 / デプロイ 0 件 / 次元数変更 0 件 / インデックス再作成 0 件 / 再埋め込み 0 件（Bedrock 0 回）/ ベクトル検索 0 件。**13.19 が確定させたアイドル区間（2026-08-22T04:10:00Z から継続）を汚していない。**Bedrock の成功埋め込みは 10,153 件のまま、累積課金は 7.4833 OCU-hour × 0.24 = **1.80 USD のまま**（増分 0.00 / 残り 18.20 USD）
    - **回避した所要時間（各数値に 実測由来 / 推定 のラベルを付す。要件 18.18）。**1 次元設定を 1 サイクルとし、512 と 256 で 2 サイクルを要する
      - **再埋め込みの呼び出し回数は 20,000 回（実測由来）。**「15,000 レコード × 2 言語 × 2 設定 = 60,000 回」は **3 倍の過大**である。埋め込みは SKU 単位で生成し同一 SKU の 3 倉庫行へ複製する構造（要件 3.4 / 3.5、A11）のため、1 サイクルは **5,000 SKU × 2 言語 = 10,000 回**であり、13.19 の台帳（通算 10,153 件のうちバッチ由来 10,000 件 / クエリ由来 153 件）と一致する
      - **再埋め込みの所要時間は 1 サイクル 95.0 分（実測由来）/ 2 サイクル 190.0 分 = 3.17 h（推定）。**実測の出所は 13.19 の区間分解が 13.11 の投入区間として確定した **2026-08-20T22:45Z〜2026-08-21T00:20Z / 95.0 分 / 4.6833 OCU-hour**。13.11 が「所要時間は本質的に短縮できない」（10,000 ÷ 120 req/min ≈ 83 分 + 書き込みオーバーヘッド）と記録した見積 83 分に対し、実測 95.0 分はその 1.14 倍で整合する。**短縮手段は無い**（レート上限は Bedrock 側の RPM。A10）
      - **インデックス再作成の ACTIVE 到達は 1 サイクル 1,088 秒 = 18.1 分（実測由来）/ 2 サイクル 36.3 分（推定）。**内訳は `byEmbeddingJa` **546 秒**（13.8）+ `byEmbeddingEn` **542 秒**（13.10）で、いずれも逐次（要件 5.9 / 13.9 の判定は「判定不能」であり並行化の根拠は無い）。**削除側 2 本 × 2 サイクルの所要時間は本仕様が実測していないため見積を持たない（推定不能）**
      - **recall 再測定は 1 サイクル 35.0 分（実測由来）/ 2 サイクル 70.0 分（推定）。**実測の出所は 13.19 の区間分解が 13.17 の recall 区間として確定した **2026-08-22T03:15Z〜03:50Z / 35.0 分 / 0.9667 OCU-hour**
      - **実作業の小計：1 サイクル 148.1 分（= 18.1 + 95.0 + 35.0）/ 2 サイクル 296.2 分 = 4.94 h（推定。実測由来の 3 区間を 2 回繰り返す前提）**
      - **ストレージ収束待ちが支配的：1 サイクル 12〜20 h / 2 サイクル 24〜40 h（推定）。**要件 14.4 の採用条件は**「6 時間以上あけた連続 2 回の取得値の差が 1% 以内」**であり、1 次元設定あたり**収束サイクル 2 回（6 時間以上の間隔 1 本以上）が最小**で 12 h。13.14 の実績間隔は **9.98 h（`TableSizeBytes`）/ 9.97 h（`IndexSizeBytes`）**であったため実績ベースでは 1 設定あたり約 20 h を見る。**S1 の再取得は不要**（全レコードの両言語ベクトルが新次元で上書きされる前提のもとで既実測の `13,402,024 B` を再利用できる）。要件 14.5 の再取得（最大 3 回）が発生すると 1 設定あたり**さらに最大 +12 h**
      - **壁時計の合計は約 30〜45 h（推定）。**内訳は実作業 4.94 h + 収束待ち 24〜40 h。**短縮不能なのは収束待ちと再埋め込みの 2 つ**であり、両者で合計の 9 割以上を占める
    - **回避した費用（同じく実測由来 / 推定 を明示する）。結論として 20 USD の上限は制約になっていない。実施しなかった理由を「上限に触れるから」と説明してはならない**
      - **OpenSearch OCU：約 11.30 OCU-hour ≈ 2.71 USD（推定）。**内訳は再投入区間 **4.6833 OCU-hour × 2 サイクル = 9.3666**（実測由来の区間値 / 13.19）+ recall 区間 **0.9667 × 2 = 1.9334**（同）。単価 0.24 USD/OCU-hour（要件 14.10 の採用単価）。**収束待ちの区間は課金増分を生まない**（13.19 がアイドル 3 区間すべて 0.00 OCU-hour を実測しており scale-to-zero が適用される）。**この 2.71 USD は上振れ側の見積である**（512 / 256 次元ではインメモリのベクトル量が 1,024 次元の 1/2・1/4 になるため OCU は下がる方向に寄るが、その低減量は実測が無いため織り込んでいない）
      - **上限に対する位置：現在 7.4833 OCU-hour / 1.80 USD（実測由来 / 13.19・13.20）→ 実施後は約 18.78 OCU-hour / 約 4.51 USD / 残り約 15.49 USD（推定）。**上限 20 USD の 23% にとどまり、`thresholdCrossed` は発火しない見込みである
      - **Bedrock：約 0.02 USD（推定）。**20,000 回 × 約 50 入力トークン ≈ 1,000,000 入力トークン（トークン数は design のコストガードレールの想定値で ja 約 60 / en 約 40 の平均 50。**本仕様は実測トークン数を記録していない**）× Titan Text Embeddings V2 の入力単価 0.02 USD / 100 万トークン（**単価は本仕様が実測していない前提値**）。**金額としては無視できる**
      - **DynamoDB 書き込み：約 0.19 USD（推定）。**512 次元は 1 レコード約 5.4 KB（ベクトル 2 本 4,224 B + 非ベクトル約 1.2 KB）→ 6 WRU × 15,000 = 90,000 WRU、256 次元は約 3.4 KB → 4 WRU × 15,000 = 60,000 WRU、計 150,000 WRU × 1.25 USD/100 万 WRU
      - **費用の合計は約 2.92 USD（推定）。**すなわち**回避した主たるコストは金額ではなく壁時計 30〜45 h と、次項の非可逆性である**
    - **実施しなかった最も重い理由は非可逆性である（費用でも上限でもない）**
      - 次元数はインデックス作成時に固定され変更できない（要件 5.8 / A5）。512 次元へ移るには `byEmbeddingEn` → `byEmbeddingJa` を削除して新次元で作り直す必要があり、埋め込み側も `embeddingDimensions` が変わることで要件 4.5 のスキップ判定が全件不一致になり 5,000 SKU × 2 言語が全件再生成される。OpenSearch 側の `knn_vector` の Dimension も固定であるため `inventory-vector` の作り直しを要する（要件 6.4 / 6.5）
      - **その結果、13.14 が収束確定させた採用値（S2 `138,202,024 B` / ベクトル属性の寄与 `124,800,000 B` / `IndexSizeBytes` 合計 `149,204,048 B`）および 13.17 / 13.18 が測定した状態は現物として失われる。**14.1 はこの状態を根拠に書くため、1,024 次元へ戻す**3 サイクル目**（削除 → 再作成 → 全件再埋め込み → 収束待ち）を実施しない限り再現できない
      - Good_Table には一切触れないため 13.20 が確認した不変性（27 項目一致）には影響しない。ただし 15.1 の撤収チェックが前提とする「Vector_Table が 1,024 次元 2 本のインデックスを持つ状態」は変わる
    - **要件 14.12 の充足状況（14.1 に明記すること）**
      - **文面上は違反にならない。**要件 14.12 は `WHERE 次元数を 512 または 256 に変更して測定を実施した場合` という条件節を持つため、未実施であれば条件が発火しない
      - **しかし要件が得ようとしていた対比表は得られていない。したがって「未充足（未実測）」として扱う。**14.1 では**表を黙って省略してはならない**。記載すべきは (a) 1,024 / 512 / 256 の対比表が未実測であること、(b) それが利用者判断であること、(c) 本タスクが任意であり核心の比較に不要であること、(d) 回避した所要時間 30〜45 h と費用約 2.92 USD、(e) 次項の「解析的に導ける範囲と導けない範囲」
      - **本記録の待ち行列への追加はしない。**13.19 が挙げた保留中の文面判断（要件 7.3 / 7.8 / 15.2 の `filterKindsUnverified`）は要件本文の追記案であるが、**本件は要件本文の変更を要しない**（条件節が発火しないため）。14.1 の記述だけで閉じる
    - **失われていないもの / 失われたもの（率直に記す）**
      - **失われていない：本仕様の目的は影響を受けない。**1,024 次元での DynamoDB 対 OpenSearch 比較に必要な数値は全項目そろっている（レイテンシ 13.18 / recall 13.17 / ストレージ 13.14 / キャパシティ 13.18 / OCU 13.19 / 機能制約 13.16・13.18）。両バックエンドは**同一のベクトル**を使うため、次元数を変えても比較の公平性に関する議論は変わらない
      - **失われた：次元数対 recall / ストレージのトレードオフ曲線。**とくに**次元削減による recall 劣化は測定なしには得られない。**Titan v2 の次元縮約は行列学習に基づく切り詰めであり劣化量はモデル固有で、本仕様は 1,024 次元の 1 点しか測っていないため外挿の根拠が無い。**「512 次元でも recall は同水準」と書いてはならない**
      - **ストレージ側は部分的に解析導出できる。**13.14 の実測 **8,320.00 B / レコード（1 言語あたり 4,160 B）**から次の 2 つのモデルが立つ
        - モデル (a) `4 × d + 64`（f32 4 B/次元 + 固定 64 B）：512 → 2,112 B / 言語、256 → 1,088 B / 言語
        - モデル (b) 実効 4.0625 B/次元（13.14 が併記した表現）：512 → 2,080 B / 言語、256 → 1,040 B / 言語
        - **1 点の実測に 2 つのモデルが同一の精度で適合し、512 次元の予測が 32 B / 1.5% 分かれる。**どちらが正しいかは 2 点目の実測なしには決まらない。13.18 が TopK を 7 点測って固定成分（約 60.6 KB）と比例成分（約 566 B/件）を分離したのと同じ構図であり、**次元数についてはその 7 点に相当する実測が無い**
        - 参考値（モデル (a) / 15,000 レコード / **2 言語分として計上**）：512 → ベクトル属性の寄与 **63,360,000 B（60.42 MiB）**、256 → **32,640,000 B（31.13 MiB）**（いずれも推定）
      - **`IndexSizeBytes` の外挿はさらに弱い。**実測 74,602,024 B ÷ 15,000 = **4,973.47 B / レコード**で、f32 の 4,096 B を引いた残り **877.47 B** を次元に依らない成分（HNSW グラフ（m 16 / ef_construction 128）+ キー + `Projection INCLUDE` の 6 属性）と**仮定すれば** 512 → 43,882,050 B / 本、256 → 28,522,050 B / 本（推定）。**この固定成分と比例成分の分解も 1 点からの仮定であり検証されていない**（グラフ次数は次元に依らないが、グラフ以外の内部構造が次元に比例するかは黒箱観測から確定できない）
      - **月額（0.25 USD/GB / 本番想定 150,000 レコード = PoC の 10 倍 / モデル (a)）：1,024 → 約 0.69 USD、512 → 約 0.38 USD、256 → 約 0.22 USD（いずれも推定）。差は月あたり 0.5 USD 未満**であり、**次元削減の動機がストレージ費用にないことは 1,024 次元の実測だけで既に言える。**14.1 にはこの結論を書ける（design の同旨の結論は 1,024 次元の実測で裏づけられた）
    - **再実施する場合の手順の要点（本判断を後から覆せるようにするための記録）**
      1. 利用者判断のやり直し。本記録時点の残余（残り 18.20 USD）に対し追加見込み約 2.71 USD、壁時計 30〜45 h、および 1,024 次元の測定状態が失われることを提示して合意を取る
      2. 次元数設定を 512 に変更する（要件 3.3。1〜4,096 のバリデーションを通す。要件 6.11）
      3. **`VECTOR_COLLECTION_ENABLED=true` を保ったままデプロイする。false でデプロイすると Collection / Index / 検索 Lambda 4 本が消え、15.1 の撤収手順そのものになる**
      4. `byEmbeddingEn` → `byEmbeddingJa` の順に削除し、新次元で `byEmbeddingJa` → `byEmbeddingEn` の順に再作成して ACTIVE 到達を待つ（1 回の `UpdateTable` で 1 本、`AttributeDefinitions` 同梱。要件 5.9 / 5.10）
      5. OpenSearch 側の `inventory-vector` を新次元で作り直す（要件 6.4 / 6.5）。**Collection ごと作り直すのか Index リソースの置換で足りるのかは未確認であり、ここが手順上の最大の未知である**
      6. `phase = "embed"` で埋め込みバッチを起動する（`embeddingDimensions` 不一致により要件 4.5 のスキップは自動的に外れるため `forceRegenerate` は不要）
      7. Vector_Verification_Path（17.1〜17.3）で両バックエンドの格納一致を再確認する
      8. S2 を取得し、6 時間以上あけた 2 本目で収束判定する（S1 は既実測の `13,402,024 B` を再利用。全レコードの両言語ベクトルが上書きされたことの確認が前提）
      9. Ground_Truth を新次元で言語別に再計算する（`ground-truth-ja-d512.json` / `ground-truth-en-d512.json` に分離。要件 13.2）
      10. 同一 Paired_Query_Set・同一 Distinct_Sku_K（1 / 10 / 33）で recall を再測定する（13.17 と同一条件）
      11. 256 次元について手順 2〜10 を繰り返す
      12. 1,024 次元の状態へ戻す必要があれば同じ手順を 3 サイクル目として実施する
      13. **14.1 の「未実測」記述を差し替え、要件 14.12 の対比表（3 次元 × 5 項目、2 言語分として計上する旨を併記）を追加する。14.1 を先に書き終えていた場合は再編集が必要になる**
    - **記録先：作成しない。**未実測のタスクに対して `docs/measurements/` の測定 JSON を作らない（**測定していない数値を成果物として残さない**）。本判断の記録は本タスクの記述と 14.1 の該当節が担う
    - _要件: 14.12（未充足 / 未実測。14.1 に明記する）_

- [x] 14. 検証結果の文書化
  - [x] 14.1 【ローカル】`docs/vector-search-comparison.md` を執筆する
    - 測定条件：実施日（YYYY-MM-DD）、リージョン（us-west-2）、対象レコード件数、埋め込みモデル名、次元数、距離関数、Distinct_Sku_K と要求 TopK、対象言語、クエリ文字列の全件と件数、倉庫フィルタの適用有無、埋め込み生成の所要時間（分）と Bedrock 呼び出し回数と概算費用
    - DynamoDB 側：レイテンシ（最小・中央値・最大・試行回数）、言語別 Recall_At_K（平均・最小、小数第 3 位）、ベクトル属性の寄与と 2 本の `IndexSizeBytes` 合計（MB、小数第 2 位）、1 検索の消費キャパシティ（RCU、小数第 1 位）、`VectorSearchRequestBytes`
    - OpenSearch 側：レイテンシ、言語別 Recall_At_K、Cold_Start 所要時間（秒、小数第 1 位）、検索時とアイドル時の OCU 使用量（OCU-hour、小数第 2 位）、`OCUUtilization`
    - 機能制約 6 項目（TopK 上限 100 / フィルタ演算子の対応範囲 / 距離関数変更不可 / オンデマンド必須 / 次元数上限 4,096 / `Query`・`Scan`・PartiQL 読み取り不可）について両バックエンドの差と「許容可 / 許容不可」の二値判定
    - Q1 の結論（ドキュメント間の矛盾内容、実測条件、結果、「対応する / 対応しない」の二値）、Q2 の結論（採用式・候補式・最大残差）、Q6 の観測結果（**判定不能**。構造上そもそも並行状態にならないため証拠が得られない）と所要時間への含意（逐次・約 360 分側を維持。ACTIVE 到達は ja 546 秒 / en 542 秒）
    - 知見 5（書き込み後の読み出し検証と最小権限の衝突）：実測エラー内容と実測値、採用した解決（Vector_Verification_Path への分離）、却下した案とその理由（検証専用 Lambda は Principal を 4 件に増やす）、開発者 IAM がインデックスを直接読めないため検証経路が唯一の証拠であること、および 17.3 で得た一致件数
    - 知見 6（リソーススキーマの受理は実サービスの受理を意味しない）：`Method.Engine` / `Settings` 省略 / `AttributeDefinitions` 省略の 3 件の実測エラーメッセージと、ローカルの合成テストでは検出できない種類の制約であること
    - 知見 7（要件が指定した最適化の未対応）：クエリ埋め込みでレイテンシ最適化推論が使われたか標準推論へフォールバックしたか（`inferencePath`）、フォールバックの根拠となったエラー本文（`Latency performance configuration is not supported for amazon.titan-embed-text-v2:0 in us-west-2`）、A/B プローブの実施内容と両結果（指定なしは成功 / `optimized` は `ValidationException`）、および**記載するクエリ埋め込みレイテンシが標準推論の値である**旨（要件 18.22）
    - 知見 8（スコアと距離の対応はバックエンドごとに異なる）：DynamoDB の `SearchResults[].Score` がコサイン距離そのものであること（残差 3.36e-8、棄却した候補式とその残差 0.8 以上）、OpenSearch は式 A（残差 1.23e-7）であること、返却された消費キャパシティ項目が `VectorSearchRequestBytes` と `VectorSearchUnits` の 2 項目のみでその観測値（各 61,318）、`VectorSearchUnits` が SDK の `VectorCapacity` モデルに存在しないこと、61,318 バイトがクエリサイズ（4 KiB）より一桁大きく走査量依存の可能性が高いが断定していないこと（要件 18.23）
    - 知見 9（応答に現れないフィールドは偽ではなく測定不能）：`DescribeTable` の `VectorIndexDescription` に `Backfilling` が返らなかったこと、要件 5.15 の検索可否判定は「不在 = 偽」で成立する一方でバックフィル完了までの経過時間が測定不能であったこと、`--watch-spend` の既定集計区間が直近 24 時間のローリングウィンドウであるため累積課金の評価には集計区間を明示的に広げる必要があること（要件 18.24）
    - scale-to-zero の「適用される / 適用されない」の二値、設定した最小 OCU、60 分以上アイドル後の実測 OCU、非適用時の常時課金月額
    - 日英比較：モデル名、公式の言語サポート状況、Paired_Query_Set の全件と件数、バックエンド × Distinct_Sku_K ごとの日英平均 Recall_At_K と差（小数第 3 位）、「実用可 / 実用不可」の二値判定と根拠。日本語 3 件以上の観察例を英語と対比
    - 風味クエリに対する Material_Sku の非出現（対象クエリと件数）
    - 知見 1（GSI `ProjectionType: ALL` へのベクトル複製と対策）、知見 2（専用テーブル分離のトレードオフ）、知見 3（同一ベクトル N 行複製による TopK の N 分の 1 希釈、本検証は N = 3 で上限 33、本番設計への示唆）、FGAC 条件キーが `SearchVectors` に効かないためパーティションキーがセキュリティ境界にならないこと
    - コスト：PoC 規模の月額内訳（埋め込み初回 / DynamoDB ストレージ / DynamoDB 検索 / OpenSearch 検索時 OCU / アイドル時 OCU）と採用単価・リージョン・想定クエリ量、本番想定規模（50,000 SKU × 3 倉庫、月 300,000 クエリ）への線形換算と線形換算が成立しない項目の区別
    - 距離関数変更が必要になった場合の再作成手順（削除 → 新距離関数で再作成 → 全 SKU の両言語ベクトル再投入）と対象件数・想定所要時間
    - 撤収手順（削除対象の全件列挙、実行順序、確認方法）と、Vector_Table 削除で 2 本のインデックスが同時に消えるため Good_Table のアイテムから属性を除去する操作が不要である旨
    - 各数値に「実測 / 推定」のラベルを付け、「推定」には単価と前提条件を併記する
    - 「一桁ミリ秒」（平均 10 ms 未満）と「recall 99% 以上」（平均 0.99 以上）について「達成 / 未達」の判定と言語別の実測値
    - **成果物：`docs/vector-search-comparison.md`（全 17 節）。**上記チェックリストの全項目を満たした。判定の要点は次のとおり
      - **「一桁ミリ秒」は未達**（`searchLatencyMs` 平均は ja 63.1 ms / en 24.9 ms、Cold_Start 除外で ja 39.1 ms / en 24.9 ms）。ただし中央値 ja 19 ms / en 20 ms、最小 9 ms。言語別の値は 60 件の呼び出し記録（`capacity-latency-2026-08-22T03-53-37-635Z.json` の `latency.calls`）から本タスクで算出した
      - **「recall 99% 以上」は DynamoDB が 6 群すべて達成、OpenSearch は ja / K=33 の 1 群が未達**（0.987374）。緩和せず不合格として記載し、機構（HNSW が同一ベクトル 3 兄弟を回収しきれず 99 行に 42 SKU を詰める。DynamoDB は同一 TopK で 1.000）を併記した
      - **機能制約 6 項目のうち 5 項目が許容可、フィルタ演算子のみ許容不可**（範囲条件が実測で非対応のため、価格帯や在庫数で絞ってから意味検索する要件を単独で満たせない）
      - **要件 14.12 は「未充足（未実測）」として明記した**（表を省略していない）。回避した壁時計 30〜45 h・費用約 2.92 USD・非可逆性・解析導出できる範囲と導けない範囲を記載
    - **要件 18.2 の「1 検索の消費キャパシティ（RCU、小数第 1 位）」は測定不能として記載した。**`ConsumedCapacity` に `CapacityUnits` / `ReadCapacityUnits` が含まれず（13.13 で実測）、RCU 換算値が存在しない。代わりに実際に返る `VectorSearchRequestBytes` / `VectorSearchUnits` を記載した
    - **コストの一部は「単価未確定」として金額を出していない。**`VectorSearchUnits` の単価を本仕様が実測・確認していないため、DynamoDB 検索の月額は数量（1 検索 81,984.685 B / 月 300,000 クエリで約 24.6 GB）のみを記載した。推測した単価で金額を作っていない
    - **OpenSearch 検索時 OCU は「線形換算が成立しない項目」として区別した**（要件 14.11）。実測密度の延長で約 193 USD/月、上限は max 2 OCU 常時の 350 USD/月。アイドル時 OCU（0 USD）も規模非依存の固定項として区別した
    - **知見 9 に 1 点の精密化を加えた。**A22 / V20 は `Backfilling` が「キー自体返らない」としているが、Index_Provisioner の `isComplete` ログには**インデックス作成中（`IndexStatus: CREATING`）に `Backfilling: true` が各インデックス 8 回ずつ記録されている**（`vector-index-provisioning-logs-2026-08-20T22-22-48-974Z.json` の `pollObservations`。`is-complete.ts` は `Backfilling === true` を出力するため、`true` の出力は生フィールドが真であったことを意味する）。正確には「**`CREATING` かつバックフィル中は `true` が返るが、ACTIVE 到達後は不在になり `true → false` の遷移を一度も観測できない**」である。要件 5.14 が求めるのは後者の遷移時刻であるため**経過時間が測定不能であるという結論は変わらず、「不在 = 偽」で検索可否が判定できることも変わらない**
    - **知見 1 の倍率を実測値で書き直した。**design.md は「約 112 MB → 約 450 MB（4 倍）」としているが、Good_Table の実測は `TableSizeBytes` 3,074,326 B（基底 + GSI 3 本で 12,297,304 B）であり、ベクトル 2 本を追加した場合は約 512 MB（**約 42 倍**）になる。GSI 複製による係数は 4 倍で、この 2 つの倍率を混同しないよう本文で明示した
    - **本番想定のストレージ月額を実測基準で再計算した。**13.21 の記録は 1,024 / 512 / 256 で 0.69 / 0.38 / 0.22 USD だが、非ベクトル 893.5 B とインデックス 2 本を含めた実測基準では **0.72 / 0.41 / 0.26 USD** になる。「差は月あたり 0.5 USD 未満」という結論は変わらない
    - **`filterKindsUnverified` の文面不整合を本文に明記した**（13.16 / 13.18 の残作業）。`constraints.ts` の変更とデプロイを要するため本タスクでは修正していない
    - **撤収手順の「確認結果」は空節として置き、task 15.1 実行後に追記する**旨を記載した（要件 18.14）
    - 検証：`npx tsc --noEmit` / `npx tsc --noEmit -p amplify/tsconfig.json` / `npm run lint` がいずれも成功（コード変更なし）。`git diff --exit-code -- docs/opensearch-comparison.md` の差分 0 行を確認（要件 18.16）
    - _要件: 1.5, 5.8, 7.9, 9.6, 13.9, 14.10, 14.11, 17.3, 18.1〜18.15, 18.17〜18.24_

  - [x] 14.2 【ローカル】README にリンクを追加し、既存ドキュメントの差分ゼロを確認する
    - README に `docs/vector-search-comparison.md` への参照リンクを 1 箇所以上設ける
    - `git diff --exit-code -- docs/opensearch-comparison.md` で既存ドキュメントの差分が 0 行であることを確認する（CI でも同じチェックが走る）
    - **成果物：README.md への 2 行追加のみ（`git diff --stat -- README.md` = `1 file changed, 2 insertions(+)`）。**既存の記述構造に合わせ、いずれも `docs/opensearch-comparison.md` の直後に並べた
      - ディレクトリツリー節（`docs/` ブロック）：`vector-search-comparison.md     # ベクトル検索比較の詳細知見`（既存 3 行と同じコメント開始列に揃えた）
      - 「詳細ドキュメント」表：`| [docs/vector-search-comparison.md](docs/vector-search-comparison.md) | DynamoDB Vector Search vs OpenSearch VECTORSEARCH のベクトル検索比較検証（上記の続き） |`。新ドキュメント冒頭が「既存の `docs/opensearch-comparison.md`（全文検索の比較）の続きにあたる」と述べているため、表でも「上記の続き」と明示して読者の遷移順を示した
      - **クリック可能なリンクは表の 1 箇所。**ツリー節は既存 3 件ともプレーンテキスト（コードブロック内）であり、リンク化すると既存形式を崩すため踏襲した。要件 18.1 の「1 箇所以上」は表で充足する
    - **要件 18.16 の再確認（実測）：`git diff --exit-code -- docs/opensearch-comparison.md` は出力 0 行 / 終了コード 0。**本タスクの編集後に再実行した結果である（14.1 の確認とは別に取得）
    - **CI の同一チェックは実在する（確認済み・未変更）：`.github/workflows/ci.yml` の最終ステップ「docs/opensearch-comparison.md の無変更確認」が `git diff --exit-code -- docs/opensearch-comparison.md` を実行する。**task 12.1 が追加したもので、順序は lint → 型チェック → テスト → docs 差分。ローカルで実行したコマンドと文字列一致する
    - **判明した限界（記録。CI は変更していない）：`ci.yml` の `paths-ignore` に `docs/**` と `*.md` が含まれるため、`docs/opensearch-comparison.md` のみを変更した PR ではワークフロー自体が起動せず、この無変更確認は発火しない。**本タスクの README 変更（`*.md` に該当）も同様に CI を起動しない。要件 18.16 の機械的な担保としては、コード変更を伴う PR でしか働かない点が穴である。CI の変更は高感度（IAM / CI/CD 方針）であり利用者の明示的な合意を要するため、本タスクでは修正せず記録のみとした
    - 検証：`npx tsc --noEmit` / `npx tsc --noEmit -p amplify/tsconfig.json` / `npm run lint` がいずれも成功（コード変更なし）。`git diff --exit-code -- docs/opensearch-comparison.md` の差分 0 行を確認（要件 18.16）
    - _要件: 18.1, 18.16_

- [x] 15. 撤収
  - [x] 15.1 【実 AWS】検証リソースを削除し、削除完了を検証する
    - 削除順序：`vectorCollectionEnabled=false` で再デプロイ（Collection / Index / 検索 Lambda）→ Collection Group → `byEmbeddingEn` → `byEmbeddingJa`（作成の逆順、1 回 1 本）→ Vector_Table（2 本のインデックスが同時に消える）→ Query_Vector_Cache → 本検証で追加した IAM ポリシー・ロールと Lambda
    - `npm run vector:measure -- --teardown-check` で確認する：
      - `ListTables` に `kiro-roasters-inventory-vector` と `kiro-vector-query-cache` が無い
      - `ListCollections` に `kiro-inventory-vector` が無い
      - `ListCollectionGroups` に `kiro-inventory-vector-group` が無い
      - `SearchOCU` / `IndexingOCU` が 0（課金対象リソースが 0 件）
      - **Good_Table が 13.1 のスナップショットと同一**（PK / SK、3 GSI、Streams、PITR、15,000 件、抽出 10 件以上の属性集合とアイテムサイズ）
      - OSIS `kiro-inventory-pipeline` が `STOPPED` のまま
    - 確認結果を `docs/vector-search-comparison.md` の撤収手順節に追記する
    - **スコープ変更（利用者判断）：部分撤収（案 A）を実施した。**上記の削除順序のうち**手順 1（`vectorCollectionEnabled=false` での再デプロイ）のみ**を実行し、**Vector_Table / Query_Vector_Cache / Collection Group / 埋め込みバッチ Lambda は意図的に残置した。**課金しうるリソースはすべて削除済みである
      - **案 A を選んだ理由：**本リポジトリは複数の検証テーマを載せた再利用可能なテストベッドであり、README がベクトル検索の有効化手順を前提に書かれている。Vector_Table を残すと**再検証時の DynamoDB 側の復旧が 18 分（インデックスのバックフィル）で済み、Bedrock 呼び出しが 0 回**になる。完全撤収した場合は複製 → 埋め込み 95 分 → インデックス 18 分の約 2 時間が毎回必要になる
      - **残置分の費用は Vector_Table のストレージ約 0.07 USD/月のみ**（推定）。Collection を含まない Collection Group が 0 課金であることは 13.4 の 1 時間観測と 13.19 の約 24.3 時間の実測で確認済み
      - **却下した案 B（tasks.md の全 6 手順による完全撤収）：**`backend.ts` と `dynamodb-tables.ts` から Vector_Table / Query_Vector_Cache / Collection Group の定義を外すコード変更を要する。`--teardown-check` は完全に通るが、再検証コストが上がり README の記述と実際の状態が食い違う
      - **`npx ampx sandbox delete` は使っていない。**Good_Table と 15,000 レコード、`docs/opensearch-comparison.md` の測定基盤ごと消えるため
    - **実行したコマンド（利用者が手動実行）：**`unset VECTOR_COLLECTION_ENABLED` → `npx ampx sandbox`
    - **削除されたもの（実測で確認）：**Collection `kiro-inventory-vector` / Index `inventory-vector` / DynamoDB ベクトルインデックス 2 本 / 検索 Lambda 4 本（`query-embed` / `search-ddb` / `search-aoss` / `capabilities`）/ Index_Provisioner / API ルート 4 本 / データアクセスポリシー
    - **残置したもの（実測で確認）：**Vector_Table（`ACTIVE` / `ItemCount 15,000` / `TableSizeBytes 138,202,024`。**日英ベクトルは保持**）/ Query_Vector_Cache / Collection Group `kiro-inventory-vector-group` / Lambda `kiro-vector-embed-batch` / API ルート `/vector-search/embed-batch`
    - **`--teardown-check` の結果（2026-08-22T14:09:58Z / 終了コード 2）：**
      - **[OK] `ListCollections` に `kiro-inventory-vector` が無い**（残るのは既存の `kiro-inventory-search` のみ）
      - **[OK] Good_Table が段階 0 のスナップショットと同一（要件 1.5）。10 件の抽出アイテムを含め相違なし**
      - **[OK] OSIS `kiro-inventory-pipeline` が `STOPPED` のまま**（要件 6.9 / 6.10。`LastUpdatedAt` 2026-08-11T22:47:56+09:00 で本検証の開始前）
      - [NG]（**意図的**）`ListTables` に Vector_Table と Query_Vector_Cache が無い — 案 A のため残置
      - [NG]（**意図的**）`ListCollectionGroups` に `kiro-inventory-vector-group` が無い — 同上
      - [NG]（**集計窓の性質による見かけの NG**）`SearchOCU` / `IndexingOCU` が 0 — 直近 24 時間の最大 2.0000 OCU だが、これは同日 11:10〜11:50Z の UI 実測を含む窓であり撤収後の現在値ではない。**直近 3 時間で切り直すと `IndexingOCU` は最小・平均・最大すべて 0、0 OCU 区間 2 件 / 合計 110.0 分 / 最長 65.0 分**で 60 分以上の連続 0 OCU が成立している。`--teardown-check` の既定窓がローリングウィンドウであることは 13.14 で記録した性質と同じ
    - **DynamoDB ベクトルインデックスの削除確認に AWS CLI は使えない。**`aws dynamodb describe-table` は `VectorIndexes` を `null` で返すが、CLI 2.35.9 は当該フィールドを解釈できず **Stage B で 2 本存在した時点でも `null` を返していた**（13.20 / 19.2 で実測）。そのため**リポジトリ同梱の `@aws-sdk/client-dynamodb` 3.1112.0**（境界 3.1103.0 以降）で `DescribeTable` を呼び、Vector_Table の `VectorIndexes` キーが**不在（0 本）**であることを確認した。Good_Table も 0 本（要件 1.6、全期間を通じて）
    - **累積課金：10.4167 OCU-hour × 0.24 USD = 2.50 USD**（上限 20 USD / 残り 17.50 USD）。13.19 時点の 1.80 USD から **0.70 USD 増加**しており、UI からの追加観測（約 25 回の検索）に由来する
      - **この増分が OpenSearch のコスト特性を定量化した。**13.19 が観測した「検索終了から `SearchOCU` が 0 に落ちるまで約 14 分の遅れ」の帰結である。recall 測定は 35.0 分に集中した 360 検索で 0.9667 OCU-hour（1 検索あたり約 0.00064 USD）だったのに対し、数時間に散発した UI 実測は約 25 検索で約 2.93 OCU-hour（約 0.028 USD）を消費した。**同じ 1 検索が散発すると約 44 倍高くつく**（推定。検索回数は概算）。**OpenSearch のコストは検索回数ではなく検索の時間的な密度で決まる**
    - **撤収直前に 2 件の測定を追加した（撤収後は測定不能になるため）：**
      - **倉庫フィルタ（要件 8.6 / 13.14 / Property 45）：**日本語 / TopK 30 / `WH-TOKYO` で **一意 SKU が 10 件から 30 件へ増え、`返却行数 ÷ 一意 SKU` が 3.00 から 1.00 になった。**知見 3 の希釈が倉庫行数ちょうどであることの直接の証拠である。距離の完全同値が消えて**両バックエンドの並びが完全に一致**した（全倉庫では順位差 0〜2）。Property 45 の「十分大きな TopK において部分集合」という条件付けが必要であることも確認した（同一 TopK では部分集合にならない）
      - **入力検証（要件 11.6 / Property 30）：**TopK に `1.5` を入力して検索ボタンを押すと、**検索は実行されず直前の結果が保持された**（Property 30 が実機で成立）。ただし表示されたのは**ブラウザ標準のバリデーションメッセージ**であり、要件 11.6 が求める「許容範囲 1〜100 の整数を示すエラー」の文面ではない。振る舞いは要件を満たすため欠陥ではないが差異として記録した。`0` / `101` / 空クエリ / 全角スペースのみは**未実測**
    - 記録先：`docs/vector-search-comparison.md` 第 16.4 節（撤収の確認結果）/ 第 9.6 節（倉庫フィルタ）/ 第 9.7 節（入力検証）/ 第 10.4 節（散発と集中のコスト差）/ 第 13 節（未実測一覧の更新）
    - _要件: 1.5, 6.9, 7.4, 7.7, 18.14, 18.15_

- [x] 16. 最終チェックポイント
  - すべてのテストが通ることを確認する。`npm run lint`、`tsc --noEmit`、`npm run test`、既存リソースのスナップショット差分ゼロ、`docs/opensearch-comparison.md` の差分 0 行を確認し、疑問があれば利用者に確認する
  - **実施結果（すべて通過）：**`npm run lint` / `npx tsc --noEmit` / `npx tsc --noEmit -p amplify/tsconfig.json` / `npm run test`（**498 テスト / 38 ファイル 全通過**）/ `existing-resources-snapshot.test.ts`（27 テスト通過 = 既存リソースの差分ゼロ）/ `git diff --exit-code -- docs/opensearch-comparison.md`（差分 0 行、要件 18.16）
  - **`npm run test` の 3 件失敗を修正した（本チェックポイントで判明）。**`VectorConstraintTable` Property 53 と `VectorSearchComparisonView` Property 30 / 31 が**フルスイートの並列実行時のみ** `Test timed out in 5000ms` で落ちていた。3 件とも単独実行では通っていた（10 テスト / 3 テスト通過を確認）。**`.github/workflows/ci.yml` は `npm run test` を実行するため、この状態では CI が失敗する**
    - **原因：**property テストは規約により最小 100 回反復し、UI 側は各反復で React ツリーを丸ごと `render()` する。単独実行では 1 本 1〜3 秒に収まるが、8 並列の負荷下で既定の `testTimeout` 5,000 ms を超える。**論理の欠陥ではなく既定値が実態に合っていないだけ**であり、反復回数は規約上減らせない
    - **対処：**`vitest.config.ts` に `testTimeout: 30_000` / `hookTimeout: 30_000` を設定し、理由をヘッダーコメントに記録した。**個別テストへの timeout 引数は採らない**（Property 32 / 54 / 57 も同一構造で潜在的に同じリスクを持つため設定で一括して扱う）。無限ループやデッドロックは 30 秒で依然として検出できる
    - **検証：**修正後に `npm run test` を **4 回連続で実行し、いずれも 498/498 / 終了コード 0**（所要 12〜14 秒）
  - **未解決として残したもの（利用者に確認済み）：**`amplify/functions/shared/vector/constraints.ts` の `filterKindsUnverified` が要件 15.2 の改訂前の文面のままである（修正にはデプロイが必要で、撤収済みのため本仕様では実施しない）。第 6 節と第 9.6 節に記録済み

- [x] 17. OpenSearch 側の格納値検証の分離（案 D）

  タスク 13.11 の実行で、旧要件 3.6（埋め込みバッチが両バックエンドから読み出して突き合わせる）と要件 17.7（埋め込みバッチロールは `aoss:WriteDocument` のみ）が同時に成立しないことが判明した。実測値は `storedCount 1712 / bedrockCalls 1712 / failedCount 0 / verifiedMatchedCount 0 / verifiedMismatchedCount 1712`、失敗一覧 100 件はすべて `stage: VERIFICATION` / `errorCode: ACCESS_DENIED_IAM` / `security_exception: [security_exception] Reason: Bad Authorization` である。

  **番号は末尾に追加しているが、実行順序は 13.11 の完走後・14.1（文書化）より前である。**14.1 は要件 3.6 の一致件数を記載するため、17.3 の結果を待つ必要がある。

  - [x] 17.1 【ローカル】検索 Lambda に OpenSearch の読み出し検証経路を追加する
    - `amplify/functions/shared/vector/verification-summary.ts` に `summarizeVerification(counts, mismatchedKeys)` を実装する。`consistent`（一致 + 不一致 + 未格納 = 対象件数）、`passed`（不一致 + 未格納 = 0 のときのみ true）、`failedCount`（不一致 + 未格納）を返す純関数とし、**集計と終了判定をこの 1 箇所に閉じ込める**
    - `amplify/functions/shared/vector/skip-decision.ts` に、当該言語のベクトルが存在し `embeddingModel` と `embeddingDimensions` がともに現行設定と一致することを判定する述語を切り出す（埋め込みバッチのスキップ判定と検証対象の特定が同一条件式を共有するようにする）
    - `amplify/functions/vector-search-aoss/verify.ts` に Vector_Verification_Path を実装する。入力は `itemIds`（最大 100 件）と任意の `languages`。**ベクトル本体をリクエストにもレスポンスにも載せない**
    - 読み出しは Vector_Collection 側が `_mget`（既存の `aoss:APIAccessAll` + データアクセスポリシーの ReadDocument / DescribeIndex のみ）、Vector_Table 側が `GetItem`（Vector_Table のテーブル ARN のみを Resource とする `dynamodb:GetItem`）。突き合わせは Lambda 内で行い、次元数の一致と全次元の完全一致を要素単位で比較する
    - 応答は `targetCount` / `matchedCount` / `mismatchedCount` / `missingCount` / `consistent` / `passed` / `failedCount` / `byLanguage` / `mismatchedKeys`（`itemId` と `language` と `reason` のみ）
    - `api-gateway.ts` に `POST /vector-search/verify` を追加し、`lambda-functions.ts` の検索 AOSS Lambda に `dynamodb:GetItem`（Vector_Table のテーブル ARN のみ）を**新規ステートメントとして追加**する。`SearchVectors` / `Query` / `Scan` / 書き込み Action / Good_Table の ARN / `Resource: "*"` を含めない
    - **データアクセスポリシーの Principal は 3 件のまま。4 件目を追加しない**（検証専用 Lambda を作る案は却下済み）
    - `scripts/vector-search/verify-embeddings.ts` に Verification_Run の実行スクリプトを実装し、`package.json` に `vector:verify` を追加する。Vector_Table 側の対象特定 → 100 件チャンクに分割 → `POST /vector-search/verify` を反復 → 全チャンクの集計を `docs/measurements/verify-<date>.json` に出力する。Bedrock を呼ばない
    - 単体テスト：`summarizeVerification` の保存則と判定、応答にベクトル本体が現れないこと、`_mget` と `GetItem` 以外の AWS 呼び出しが発生しないこと（AWS はモックする。テストファイルは `verify.test.ts` として 8.8 のテストファイルと分ける）
    - property テスト：**Property 58: 検証結果の集計整合性と終了判定**（`fc.assert(..., { numRuns: 100 })`）
    - IAM の property テスト（**Property 55**）に、検索 AOSS ロールの DynamoDB 側 Action が `GetItem` のみで Resource が Vector_Table のテーブル ARN のみであることの走査を追加する
    - _要件: 3.13, 3.14, 3.16, 3.17, 3.18, 4.5, 17.4, 17.7, 17.15_
    - _Property: 22, 55, 58_
    - _設計: Vector_Verification_Path（案 D）_

  - [x] 17.2 【ローカル】埋め込みバッチから OpenSearch 検証を外し、検証不一致を失敗として計上する
    - `amplify/functions/vector-embed-batch/handler.ts` の検証処理から Vector_Collection への読み出しを**削除する**。バッチが Vector_Collection に対して発行する操作を書き込み系のみにする（読み出し呼び出し回数 0）
    - バッチに残す検証は **Vector_Table 側のみ**にする。書き込んだ値を `GetItem` で読み返し、次元数の一致と全次元の完全一致を要素単位で比較して言語別に一致・不一致件数を出す
    - 検証結果の計上を `summarizeVerification()` に委譲し、**不一致件数と未格納件数の和が 1 以上なら `failedCount` に計上して実行状態を COMPLETED にしない**。旧実装は `verifiedMismatchedCount 1712` でも `failedCount 0` / COMPLETED だった
    - 返却 JSON に、OpenSearch 側の検証は Verification_Run（task 17.3）が担う旨と、その未実施・不合格・合格の状態を明示するフィールドを持たせる
    - 回帰テスト（例示、省略しない）：`mismatchedCount > 0` の入力に対して実行状態が COMPLETED にならないことを固定する。旧挙動（`failedCount 0` で COMPLETED）が再発したら落ちるテストにする
    - property テストの更新：**Property 8** に「バッチが Vector_Collection に対して発行する読み出し操作の呼び出し回数が 0」を追加する
    - _要件: 3.6, 3.12, 3.18_
    - _Property: 8, 58_
    - _設計: Embedding_Batch_Job / 検証結果の計上_

  - [x] 17.3 【実 AWS】Verification_Run を実行して要件 3.6 の一致件数を得る
    - 前提：13.11（埋め込みバッチ）の完走、および 17.1 / 17.2 の変更を反映した再デプロイ（利用者が実行するコマンド：`npx ampx sandbox`、コンテキスト `vectorCollectionEnabled=true`）
    - 利用者が実行するコマンド：`npm run vector:verify`
    - 対象は Vector_Table において当該言語のベクトルが存在し `embeddingModel` と `embeddingDimensions` が現行設定と一致する (itemId, 言語) の組の全件（最大 5,000 SKU × 2 言語 = 10,000 組）
    - **再生成を伴わないこと。**Bedrock の呼び出し回数が 0 であることを実行結果で確認する（13.11 は `forceRegenerate: false` で動いたため既存分をスキップしており、再生成すると Bedrock が再課金される）
    - 出力を `docs/measurements/verify-<date>.json` に保存する。含める項目：対象件数、言語別の一致 / 不一致 / 未格納件数、`consistent`、`passed`、`failedCount`、不一致の (itemId, 言語) 一覧
    - 不一致または未格納が 1 件以上の場合は原因を切り分けてから 14.1 に進む（`_id` の組み立て違い、f32 丸めの経路差、書き込み時の補償漏れの順に確認する）
    - ベクトルインデックスのバックフィル状態に依存しない（`GetItem` と `_mget` のみを使い `SearchVectors` を使わない）ため、13.12 と並行して実行できる
    - _要件: 3.6, 3.13, 3.14, 3.15, 3.17, 3.18, 18.20_
    - _設計: デプロイ順序とゲート条件 / 段階 9b_

- [x] 18. クエリ埋め込みの推論経路フォールバック（案 B）とエラー分類の是正

  デプロイ済み環境の `POST /vector-search/embed` が**全リクエストに HTTP 400** を返している。本文は次のとおりである。

  ```json
  {"stage":"EMBEDDING","errorCode":"INVALID_QUERY",
   "message":"クエリ文字列が空、または空白文字のみです。 Latency performance configuration is not supported for amazon.titan-embed-text-v2:0 in us-west-2"}
  ```

  原因は `vector-query-embed/handler.ts` の `createEmbeddingGenerator({ latencyOptimized: true })` により `embedding-generator.ts` が `performanceConfigLatency: 'optimized'` を付けて `InvokeModel` を呼ぶことである。これは**旧要件 10.1 が「レイテンシ最適化された推論呼び出しを使用して」と明記していたとおりの実装であり、実装ミスではない。**Bedrock を直接呼ぶ A/B（同一モデル・同一リージョン・同一本文 `inputText` / `dimensions 1024` / `normalize true`・同一資格情報で `performanceConfigLatency` の有無だけを変えた 2 回）で確定した。指定なしは成功（dimensions 1024 / inputTextTokenCount 29）、`performanceConfigLatency: optimized` は `ValidationException` / HTTP 400 である。

  **ブロッキングの範囲。**埋め込みバッチ側は `latencyOptimized: false` のため task 13.11 は完走した。影響を受けるのはクエリ埋め込み経路のみだが、**両検索エンドポイントは `queryId` しか受け付けず、`queryId` を発行できるのはこのエンドポイントだけ**であるため、task 13.17（recall）と task 13.18（レイテンシ・キャパシティ・UI 検証）が完全に止まっている。

  **番号は末尾に追加しているが、実行順序は 13.15 の後・13.17 より前である。**既存タスクの番号を振り直さない方針のため末尾に置いている。

  - [x] 18.1 【ローカル】`embedding-generator.ts` にレイテンシ最適化推論のフォールバックを実装する
    - `latencyOptimized: true` の呼び出しで `performanceConfigLatency: 'optimized'` を付けて 1 回試し、**モデルまたはリージョンの未対応を示すエラー**なら当該指定を外した標準推論で **1 回だけ**再呼び出しする。再呼び出しの入力はモデル・次元数・入力本文をいずれも初回と同一にする
    - 未対応の判定：`ValidationException` のうちメッセージが `latency performance configuration` と `not supported` を同時に含むものだけを対象とする。**モデル ID とリージョン名を判定条件に埋め込まない**（他モデル・他リージョンでも成立させるため）。実測本文は `Latency performance configuration is not supported for amazon.titan-embed-text-v2:0 in us-west-2`
    - 未対応を示さない `ValidationException`（入力本文の不正など）は**フォールバックせず**、再試行不可の失敗として上位へ返す
    - フォールバック後の標準推論が失敗しても更なるフォールバックを行わない。フォールバックの 1 回は**スロットリング再試行の回数（バッチ 5 / クエリ 3）に加算しない**
    - 戻り値に `inferencePath`（`'latency_optimized' | 'standard'`）を追加する。`latencyOptimized: false` の呼び出し（バッチ側）は常に `'standard'` とする
    - `vector-query-embed/handler.ts` で `inferencePath` を応答に載せる。`api-types.ts`（`VectorEmbedResponse`）と `src/lib/inventory/vector-types.ts` に同項目を追加する
    - 単体テスト（例示、省略しない）：未対応エラー本文で再呼び出しが 1 回だけ発生し `inferencePath: 'standard'` になること。未対応を示さない `ValidationException` で再呼び出しが 0 回で失敗として返ること。成功時は `inferencePath: 'latency_optimized'` になること。バッチ側の呼び出し（`latencyOptimized: false`）が `performanceConfigLatency` を送らないこと。Bedrock はモックする
    - property テスト：**Property 59: レイテンシ最適化推論のフォールバックの単発性と経路記録**（`fc.assert(..., { numRuns: 100 })`）
    - _要件: 10.1, 10.13, 10.14, 10.15_
    - _Property: 59_
    - _設計: Embedding_Generator / レイテンシ最適化推論のフォールバック（案 B）_

  - [x] 18.2 【ローカル】`errors.ts` のエラー分類を是正し、真因と矛盾する定型文を止める
    - `classifyBadRequest` の既定分岐を `INVALID_QUERY` から外す。**`INVALID_QUERY` と `QUERY_TOO_LONG` はハンドラ側の入力検証（空文字 / 空白のみ / 上限文字数超過）が失敗したときにのみ付与し、下位サービスのエラー分類経路からは付与しない**
    - HTTP 400 系で入力検証に該当しないものは要件 16.7 の分類規則（`ACCESS_DENIED_IAM` / `ACCESS_DENIED_DATA_POLICY` / `RESOURCE_NOT_FOUND` / `THROTTLED` / `INTERNAL_ERROR`）に落とす。既定は `INTERNAL_ERROR`（再試行不可）とする
    - 説明文を、付与したエラーコードの発生条件と矛盾しない内容に限定する。当該条件を満たさない失敗に条件を述べる定型文を付けない
    - **回帰テスト（例示、省略しない）：**実測本文の Bedrock `ValidationException`（`Latency performance configuration is not supported for amazon.titan-embed-text-v2:0 in us-west-2`）を入力し、`errorCode` が `INVALID_QUERY` に**ならない**ことと、説明文に「クエリ文字列が空、または空白文字のみです。」が**含まれない**ことを固定する。旧挙動が再発したら落ちるテストにする
    - 既存の **Property 51: エラー分類の全域性と一意性**が引き続き成立することを確認する（分類先の変更で全域性が崩れないこと）
    - property テスト：**Property 60: エラー説明文とエラーコードの発生条件の整合性**（`fc.assert(..., { numRuns: 100 })`）
    - _要件: 16.5, 16.7, 16.10, 16.11_
    - _Property: 51, 60_
    - _設計: Error Handling / 分類の実装_

  - [x] 18.3 【実 AWS】`POST /vector-search/embed` の成功とフォールバックの記録を確認する
    - 前提：18.1 / 18.2 の変更を反映した再デプロイ（利用者が実行するコマンド：`npx ampx sandbox`、コンテキスト `vectorCollectionEnabled=true`）
    - `ja` と `en` の各 1 件で `POST /vector-search/embed` を呼び、HTTP 200 と `queryId` / `embeddingLatencyMs` / `dimensions` / `model` / `language` / `inferencePath` が返ることを確認する。**ベクトル本体が返らないこと**も確認する
    - **`inferencePath` が `standard` であることを確認する。**us-west-2 の `amazon.titan-embed-text-v2:0` は未対応なので必ずフォールバックが発生する。`latency_optimized` が返った場合はモデルまたはリージョンの対応状況が変わったことを意味するため、その旨を記録する
    - 発行した `queryId` で `POST /vector-search/dynamodb` と `POST /vector-search/opensearch` が実行できることを確認する（task 13.17 / 13.18 の前提が回復したことの確認）
    - 空文字クエリで `INVALID_QUERY` が、正常クエリで `INVALID_QUERY` が**返らない**ことを確認する（18.2 の是正が実環境で効いていること）
    - 出力を `docs/measurements/embed-inference-path-<date>.json` に保存する。含める項目：実施日時（UTC）、リージョン、モデル ID、`language` ごとの `inferencePath` と `embeddingLatencyMs`、フォールバックの根拠となったエラー本文
    - **記録するクエリ埋め込みレイテンシは標準推論の値である**旨を出力に注記する（要件 18.22）
    - _要件: 10.1, 10.5, 10.13, 16.10, 18.22_
    - _設計: デプロイ順序とゲート条件 / 段階 11b_

  - [x] 18.4 【ローカル】`Backfilling` フィールド不在を測定不能として明示する
    - task 13.12 で `VectorIndexes[].Backfilling` がキー自体返らないことが判明した（13.7 のデプロイ直後でも 13.12 の時点でも不在、`true → false` の遷移を一度も観測していない）。判定は「不在 = 偽」で成立するが、バックフィル完了までの経過時間は測定できない
    - `scripts/vector-search/measure.ts` の `--wait-index`：`Backfilling` フィールドの有無を区別し、不在の場合はバックフィル完了までの経過時間を**測定不能**として出力する（0 秒や即時完了として記録しない）。当該フィールドが不在であったことを出力に含める
    - `vector-search-ddb/handler.ts`：`indexReadiness` に `backfillingPresent`（フィールドが応答に存在したか）を追加する。判定ロジック（`IndexStatus === 'ACTIVE'` かつ `Backfilling !== true`）は変更しない
    - `INDEX_BUILDING` 応答（要件 16.3）と要件 5.15 の返却値に、`Backfilling` が不在であったことを示す値を含める。`api-types.ts` と `src/lib/inventory/vector-types.ts` の対応する型を更新する
    - 単体テスト：`Backfilling` キーがある応答（`true` / `false`）と無い応答の 3 通りについて、検索可否の判定結果と `backfillingPresent` の値を固定する。**キー不在で検索が実行されること**（不在 = 偽）を明示的に押さえる
    - 既存の **Property 15: インデックス準備判定**の入力にフィールド不在のケースを加える
    - _要件: 5.14, 5.15, 5.17, 16.3_
    - _Property: 15_
    - _設計: 検証済み AWS 事実 V20 / 知見 9_

- [x] 19. `kiro-vector-search-ddb` の SDK 同梱（`DescribeTable` の応答欠落の是正）

  デプロイ済み環境の `POST /vector-search/dynamodb` が、2 本のベクトルインデックスがともに存在し ACTIVE であるにもかかわらず `byEmbeddingJa` に対して `INDEX_NOT_FOUND` を返している。

  原因は `kiro-vector-search-ddb` が `@aws-sdk/client-dynamodb` を**外部モジュール（Lambda 同梱の SDK）として解決していること**である。同梱 SDK のモデルには `TableDescription.VectorIndexes` が無く、AWS SDK v3 の逆シリアライズはモデル駆動であるため、**モデルに無いフィールドはエラーも警告もなく捨てられる**。`handler.ts` の `readVectorIndexDescriptions()` は `table?.VectorIndexes ?? []` を空配列として受け取り、インデックスが存在しないと判定する。**ハンドラのロジック自体は要件 16.2 のとおりで正しい。**

  実測による確定（`docs/measurements/recall-blocked-index-not-found-2026-08-21T23-56-27-429Z.json`）：

  - 同一資格情報・同一テーブルに対する SDK バージョンの A/B で、`VectorIndexes` は 3.1050.0 / 3.1081.0 / 3.1096.0 / 3.1100.0 / 3.1102.0 で**不在**、**3.1103.0** / 3.1104.0 / 3.1112.0 で**存在**。境界は **3.1103.0**。AWS CLI 2.35.9 も当該フィールドを返さない
  - デプロイ済みバンドル：CodeSize 261,967 B / `index.js` 161 KB / `require("@aws-sdk/client-dynamodb")` が残存。SDK が同梱されていれば数 MB 規模になり当該 require は消える
  - `aws-cdk-lib` 2.244.0 の `NodejsFunction` は Node 18+ で `externalModules: ['@aws-sdk/*']` を既定とする（`aws-lambda-nodejs/lib/bundling.js` の `sdkV3Externals` / `defaultExternals`）。`lambda-functions.ts` の `commonProps.bundling` はこれを上書きしていなかった
  - `SearchVectors` は生 HTTP を自前署名しておりモデルに依存しないため、**壊れているのは `DescribeTable` の解析経路だけ**である

  **これは要件 18.21 の「スキーマ / モデルが実サービスに遅れる」パターンの 4 例目だが、種類が異なる。**既知の 3 例（`Method.Engine`、`Settings` 省略、`AttributeDefinitions` 省略）はいずれも**リクエストが拒否される**。本件はリクエストが受理され、**サービスが返した情報がクライアント側で黙って消える**。エラーも警告も出ないため、失敗が `INDEX_NOT_FOUND` という別の症状に化ける。要件 18.23 の `VectorSearchUnits`（SDK の `VectorCapacity` モデルに存在しない項目）と同系で、**実呼び出しでしか観測できない**。

  **番号は末尾に追加しているが、実行順序は 18.3 の前後・13.17 より前である。**13.17（recall）と 13.18 は `POST /vector-search/dynamodb` の成功を前提とするため、19.2 を通さないと入れない。

  - [x] 19.1 【ローカル】`kiro-vector-search-ddb` に SDK を同梱し、合成側に回帰ガードを置く
    - `amplify/custom/lambda-functions.ts` の `VectorSearchDdbFunction` にのみ `bundling: { ...commonProps.bundling, externalModules: [] }` を渡す。**`commonProps` は変更しない**（`vector-search-aoss` / `vector-capabilities` / `vector-embed-batch` / `vector-query-embed` と既存 inventory 系 8 本のバンドルを一切変えない）
    - 同措置の先例は `amplify/custom/vector-index.ts` の Index_Provisioner（「`VectorIndexUpdates` は比較的新しい API パラメータのため、Lambda 同梱の SDK に依存させない」）。**防いでいる失敗の種類が異なる**（先例はリクエストが拒否される、本件は応答が黙って欠落する）ため、将来「同じことを 2 箇所に書いている」と見て片方を削られないよう、コードコメントに先例と具体的な失敗様態の両方を残す
    - `DescribeTable.VectorIndexes` を読むデプロイ対象を確認した結果は `vector-search-ddb/handler.ts` と `vector-index-provisioner`（`on-event.ts` / `is-complete.ts`、既に `externalModules: []`）の 2 系統のみ。`vector-search-aoss`（`handler.ts` / `verify.ts`）は `GetItemCommand` しか使わず当該フィールドを読まない。`scripts/vector-search/measure.ts` と `probe-range-filter.ts` も読むが、Lambda ではなくリポジトリ側の SDK で動くため対象外。**したがって変更対象は 1 本で足りる**
    - **ハンドラの `INDEX_NOT_FOUND` 判定には手を入れない**（要件 16.2 のとおり正しい）
    - 回帰ガード：`amplify/custom/vector-search-ddb-bundling.test.ts` を追加する。`handler.test.ts` と `search-parity.test.ts` は `DescribeTable` を差し替えて `VectorIndexes` を返させるため**原理的に本件を検出できない**。バンドル設定は合成テンプレートにも現れない（現れるのはアセットのハッシュのみ）ため、`NodejsFunction` の構築引数を記録して突き合わせる。判定は値の一致ではなく「`@aws-sdk` を指す要素が 1 つも無いこと」で行い、関数がテンプレート上に実在することは `Template.fromStack` で併せて確認する
    - ガードが実際に落ちることを両方向で確認済み：`externalModules: []` を外すと `@aws-sdk/*` を外部化せず SDK を同梱する が落ち、`commonProps` 側へ移すと `kiro-vector-search-ddb` 以外は既定のバンドル設定を保つ が落ちる
    - バンドルサイズの実測（esbuild 直実行、minify + sourcemap）：`index.js` 161,128 B → 547,825 B、zip 219,584 B → 632,428 B（約 2.9 倍）。外部化時の 161,128 B はデプロイ済みバンドルの `index.js` 161 KB と一致するため、計測が実物と対応していることの確認になる
    - 検証：`npx tsc --noEmit -p amplify/tsconfig.json` / `npx tsc --noEmit` / `npx vitest --run`（新規ガード + `existing-resources-snapshot` + `vector-iam-description.property` + `vector-verify-route` + `vector-search-ddb/handler` の 5 ファイル 56 件）/ `npm run lint` がいずれも成功
    - _要件: 5.15, 16.2, 16.3, 18.21, 18.23_
    - _設計: DynamoDB_Vector_Lambda / インデックス準備状態の確認（ステップ 5）_

  - [x] 19.2 【実 AWS】`POST /vector-search/dynamodb` が `INDEX_NOT_FOUND` を返さないことを確認する
    - 前提：19.1 の変更を反映した再デプロイ（利用者が実行するコマンド：`npx ampx sandbox`、コンテキスト `vectorCollectionEnabled=true`）。**利用者が 2026-08-22T00:21:42Z に実施済み**
    - `POST /vector-search/embed` を 1 回呼んで `queryId` を発行する（両検索エンドポイントは `queryId` しか受け付けない）。実測（2026-08-22T00:37Z、`query: 花のような香りで酸味の強い浅煎りの豆` / `language: ja`）：HTTP 200 / `queryId: a4bca209-25c2-4092-a1a9-c6b0d6459cdd` / `embeddingLatencyMs: 403` / `dimensions: 1024` / `inferencePath: standard`（18.3 のフォールバックが継続して機能）
    - 発行した `queryId` で `POST /vector-search/dynamodb` を **TopK 3 で 1 回だけ**呼び、HTTP 200 と `indexReadiness`（`indexStatus: ACTIVE` / `backfillingPresent: false`）が返ることを確認する。`INDEX_NOT_FOUND` が返らないことをもって是正の確認とする。**実測：HTTP 200 / `indexReadiness = { indexStatus: "ACTIVE", backfilling: false, backfillingPresent: false, describeTableCached: false }` / `indexName: byEmbeddingJa` / `INDEX_NOT_FOUND` は返らず、是正を確認した。**併せて `returnedCount: 3` / `distinctSkuCount: 1` / `searchLatencyMs: 395` / `handlerLatencyMs: 646` / `coldStart: true`（再デプロイ直後の初回呼び出し）/ `consumedCapacity = { vectorSearchRequestBytes: 63390, vectorSearchUnits: 63390 }`（要件 18.23 のモデル外項目が再現）
    - `backfillingPresent: false` が期待値である根拠は task 13.12 / 18.4（`Backfilling` フィールドはキー自体返らない）。`true` が返った場合はフィールドの返却状況が変わったことを意味するため記録する。**実測は `false`** であり、`Backfilling` キーは依然として返らない（A22 / V20 は変わらず）
    - 再デプロイ後の `index.js` サイズが 500 KB 前後に増え、`require("@aws-sdk/client-dynamodb")` が消えていることを併せて確認する（同梱が実際に効いていることの直接確認）。**実測（デプロイ済みパッケージを `GetFunction` の署名付き URL から取得して展開）：`index.js` 161,128 B → 547,825 B、CodeSize 261,967 B → 760,111 B、`LastModified` 2026-08-21T23:27:22Z → 2026-08-22T00:21:42Z、`CodeSha256` = `lVMR71ojCZbTE1XK0UEUAs6Ahvabsmxfj6iTe2pCePk=`（修正前の値は未記録）。`require("@aws-sdk/client-dynamodb")` は 0 件、`require("@aws-sdk/...")` は実コード上 0 件（`@aws-sdk/signature-v4-crt` は 2 件現れるがいずれもエラーメッセージ文字列の一部）。バンドル内に `VectorIndexes` が 3 件・`VectorIndexDescription` が 5 件現れ、モデルが同梱されたことを直接確認した（同梱元はリポジトリの `@aws-sdk/client-dynamodb` 3.1112.0 で境界 3.1103.0 以降）。`index.js` の 547,825 B は 19.1 のローカル esbuild 実測値と完全一致する**
    - AOSS への影響なし：`POST /vector-search/opensearch` は呼ばず、`SearchVectors` は AOSS の OCU を消費しないため 0 OCU 区間は継続している（`--watch-spend --no-write --hours 48` の実測：2026-08-21T13:50:00Z 〜 2026-08-22T00:40:00Z の 650.0 分が連続、累積 5.7833 OCU-hour × 0.24 = 1.39 USD で 19.1 時点から変化なし）。13.19 の 24 時間アイドル窓は維持されている
    - **これが通ると 13.17 / 13.18 のブロックが解除される**（本タスクで解除条件を満たした）
    - _要件: 5.15, 16.2, 16.3, 18.21, 18.23_
    - _設計: デプロイ順序とゲート条件 / 段階 11b_

## Notes

- `*` 付きのサブタスクは任意であり、MVP を早く回す場合は省略できる。ただし **5.5（3 行複製での recall 1.0 回帰テスト）、7.4（既存リソース差分ゼロのスナップショット）、7.5（IAM 最小権限と description の property テスト）は `*` を付けていない。**recall 算出の修正が効いていることの唯一の直接的な証拠と、既存の測定値およびセキュリティ境界を守るガードレールであるため省略しない
- 【実 AWS】のタスクはデプロイを利用者が手動で実行する。エージェントはコードとスクリプトを用意し、実行コマンドと確認項目を提示する
- 【壁時計】のタスクは待ち時間が本質的に短縮できない。特に 13.11（埋め込みバッチ 約 100〜115 分）と 13.19（アイドル OCU 24 時間）、13.14（6 時間 × 最大 3 回）はスケジュールに直接影響する
- Q6（13.9）は**判定不能で確定**した。`VectorIndexConstruct` が 2 本を `addDependency` で逐次化しているため並行状態が構造上作られず、「並行受理可能」の証拠が得られない。スケジュール見積りは設計の既定（逐次・約 360 分側）を維持する。ACTIVE 到達の実測は ja 546 秒 / en 542 秒（CloudWatch Logs からの事後回収値）
- **task 17 は番号が末尾だが実行順序は 13.11 の後・14.1 の前である。**既存タスクの番号を振り直さない方針のため末尾に追加している。14.1 は要件 3.6 の一致件数を記載するため 17.3 の結果を待つ
- **task 18 も番号が末尾だが実行順序は 13.15 の後・13.17 より前である。**`POST /vector-search/embed` が全リクエストに HTTP 400 を返しており（`amazon.titan-embed-text-v2:0` は us-west-2 でレイテンシ最適化推論に未対応）、`queryId` を発行できるのはこのエンドポイントだけであるため、**18.3 を通さないと 13.17 / 13.18 に入れない。**18.4 は task 13.12 で判明した `Backfilling` 不在の扱いを実装に反映するもので、13.17 / 13.18 をブロックしない
- **task 19 も番号が末尾だが実行順序は 13.17 より前である。**`kiro-vector-search-ddb` が `@aws-sdk/client-dynamodb` を Lambda 同梱の SDK へ外部解決しており、そのモデルに `TableDescription.VectorIndexes`（境界は 3.1103.0）が無いため、`DescribeTable` の応答から当該フィールドが**エラーも警告もなく消える**。ACTIVE なインデックスに対して `INDEX_NOT_FOUND` を返しており、**19.2 を通さないと 13.17 / 13.18 に入れない。**要件 18.21 の 4 例目だが、既知 3 例が「リクエストが拒否される」のに対し本件は「受理されたうえで情報が黙って消える」という別種である。ローカルの単体テストは `DescribeTable` を差し替えるため検出できず、回帰ガードは合成側（`vector-search-ddb-bundling.test.ts`）に置いた
- **Q2（13.15）と Q5（13.13）は実測で決着した。**Q5：`SearchResults[].Score` はコサイン距離そのもの（残差 3.36e-8）。Q2：OpenSearch は式 A `d = 2 − 2 × score`（最大残差 1.23e-7）。**両バックエンドでスコアと距離の対応が異なる**ため混同しないこと
- property テストは各 100 回以上反復し、ヘッダーコメントで設計書のプロパティを名指しする。AWS 呼び出しはモックし、時間依存は仮想時計で検証する
- 既存資産への非干渉：`amplify/custom/dynamodb-tables.ts` は追記のみ、`amplify/custom/opensearch-infra.ts` は無変更、`LatencyBar.tsx` は無変更で再利用、`InventoryDashboard.tsx` はタブ 1 件の追加のみ、OSIS `kiro-inventory-pipeline` は全期間 `STOPPED` 維持
- IAM とポリシーの `description` は `[\u0009\u000A\u000D\u0020-\u007E\u00A1-\u00FF]*` に一致する文字のみ（日本語と矢印記号を含めない）

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "3.1", "3.5", "3.6", "3.7", "3.8", "3.9", "4.1", "5.3"] },
    { "id": 2, "tasks": ["2.2", "3.2", "3.3", "3.10", "3.11", "4.2", "7.1", "7.2", "7.3"] },
    { "id": 3, "tasks": ["3.4", "3.12", "4.3", "5.1", "5.2", "8.1", "8.2", "8.3", "8.4", "8.5"] },
    { "id": 4, "tasks": ["5.4", "5.5", "8.6", "11.1", "11.5"] },
    { "id": 5, "tasks": ["8.7", "10.1", "11.2", "11.4"] },
    { "id": 6, "tasks": ["7.4", "7.5", "8.8", "8.9", "10.2", "10.3", "10.4", "10.5", "11.3", "12.1", "17.1", "17.2"] },
    { "id": 7, "tasks": ["10.6"] },
    { "id": 8, "tasks": ["10.7", "10.8"] },
    { "id": 9, "tasks": ["13.1"] },
    { "id": 10, "tasks": ["13.2"] },
    { "id": 11, "tasks": ["13.3"] },
    { "id": 12, "tasks": ["13.4"] },
    { "id": 13, "tasks": ["13.5"] },
    { "id": 14, "tasks": ["13.6"] },
    { "id": 15, "tasks": ["13.7"] },
    { "id": 16, "tasks": ["13.8"] },
    { "id": 17, "tasks": ["13.9"] },
    { "id": 18, "tasks": ["13.10"] },
    { "id": 19, "tasks": ["13.11"] },
    { "id": 20, "tasks": ["13.12", "17.3"] },
    { "id": 21, "tasks": ["13.13"] },
    { "id": 22, "tasks": ["13.14", "13.15", "13.16", "18.1", "18.2", "18.4", "19.1"] },
    { "id": 23, "tasks": ["18.3", "19.2"] },
    { "id": 24, "tasks": ["13.17", "13.18"] },
    { "id": 25, "tasks": ["13.19"] },
    { "id": 26, "tasks": ["13.20", "13.21"] },
    { "id": 27, "tasks": ["14.1"] },
    { "id": 28, "tasks": ["14.2"] },
    { "id": 29, "tasks": ["15.1"] }
  ]
}
```

### クリティカルパスの読み方

- **Wave 0〜8 はローカル完結。**AWS を待たずに並列化できる。純関数（wave 1〜3）→ ハンドラ（wave 3〜4）→ 配線（wave 5）→ テストと UI 部品（wave 6）→ UI 統合（wave 7〜8）
- **Wave 9 以降が AWS ゲート付きの直列区間。**段階ゲートが直列性を強制するため、wave 22 の 3 タスク、wave 23 の 2 タスク、wave 25 の 2 タスクを除いて並列化できない
- **直列区間の壁時計コスト：**13.4（1 時間）→ 13.6（6 時間待ち）→ 13.8〜13.10（インデックス作成、Q6 次第で 2 倍）→ 13.11（約 100〜115 分）→ 13.12（最悪 360 分）→ 13.14（6 時間 × 最大 3 回）→ 13.19（24 時間）。合計で数日規模になる
- **wave 22 の並列化の根拠：**13.14（スナップショット取得）、13.15（キャリブレーション）、13.16（範囲プローブ）はいずれも Vector_Table への書き込みを行わないため同時に進められる。13.15 は `score-normalize.ts`、13.16 は `constraints.ts` を更新するので書き込み先が競合しない。**18.1 / 18.2 / 18.4 をここに置ける根拠：**いずれもローカルのコード変更で、書き込み先ファイルが互いにも 13.15 / 13.16 とも異なる（18.1 は `embedding-generator.ts` と `vector-query-embed/handler.ts`、18.2 は `errors.ts`、18.4 は `measure.ts` と `vector-search-ddb/handler.ts`）。ただし **18.4 が `measure.ts` を変更する間は 13.14 の `--wait-index` を走らせない**（13.14 が使うのはストレージ取得経路であり `--wait-index` は 13.12 で完了済みのため、実務上の衝突は生じない）
- **wave 22 に 19.1 を置ける根拠：**ローカルのコード変更で、書き込み先が `lambda-functions.ts` と新規テスト 1 件のみ。18.1 / 18.2 / 18.4 および 13.15 / 13.16 の書き込み先といずれも重ならない（18.4 も `vector-search-ddb/handler.ts` を触るが、19.1 はハンドラを変更しない）
- **wave 23 に 18.3 と 19.2 を置く根拠：**どちらも直前のローカル変更を反映した再デプロイが前提で、同一の再デプロイに相乗りできる。13.17 / 13.18 は 18.3 が発行する `queryId` と 19.2 が確認する `POST /vector-search/dynamodb` の成功の**両方**に依存する。19.2 は 18.3 が発行した `queryId` をそのまま使えるため 18.3 の後に続けて実行する。**両方を通さないと wave 24 に入れない**
- **wave 25 は排他。**13.19 のアイドル観測中に検索を実行すると測定が無効になるため、13.17 / 13.18 の後に単独で置く
- **wave 6 に 17.1 / 17.2 を置く根拠：**どちらもローカルのコード変更で、書き込み先ファイルが互いに異なる（17.1 は `vector-search-aoss/verify.ts` と共有モジュール、17.2 は `vector-embed-batch/handler.ts`）。8.8 / 8.9 のテストファイルとも分ける
- **wave 20 に 17.3 を置く根拠：**13.11（埋め込みバッチ完走）の後であり、`GetItem` と `_mget` のみを使うためバックフィル状態に依存しない。13.12 のポーリング待ちと並行して実行できる
