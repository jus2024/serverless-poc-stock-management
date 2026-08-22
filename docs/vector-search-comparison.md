# DynamoDB Vector Search vs OpenSearch Serverless VECTORSEARCH — ベクトル検索比較検証

同一の埋め込みベクトル・同一のクエリベクトル・同一の TopK・同一の検索言語で、**DynamoDB Vector Search（`SearchVectors`）** と **OpenSearch Serverless VECTORSEARCH（k-NN）** を比較した検証の記録である。

既存の `docs/opensearch-comparison.md`（全文検索の比較）の続きにあたる。既存の Good_Table（`kiro-roasters-inventory-good`）には一切変更を加えず、同一キースキーマ・同一データの検証専用テーブル（Vector_Table）を新規に作って測定した。

## 数値ラベルの規約

本ドキュメントの数値にはすべて次のいずれかのラベルを付ける（要件 18.18）。

| ラベル | 意味 |
|---|---|
| **実測** | 実 AWS から取得した観測値、またはその観測値だけから機械的に導いた値 |
| **推定** | 実測値と単価・前提条件から算出した値。単価と前提を必ず併記する |
| **測定不能** | サービス側が値を返さないため取得できない。**0 ではない** |
| **未実測** | 測定は可能だが、利用者判断で実施していない。**測定不能とは別物である** |

「測定不能」と「未実測」を混同しないこと。前者は `OCUUtilization` とバックフィル完了までの経過時間、後者は 60 分以上アイドル後の Cold_Start と 512 / 256 次元のトレードオフ測定である。

---

## 1. 結論

| 問い | 結論 |
|---|---|
| DynamoDB Vector Index は「一桁ミリ秒」か | **未達**。`searchLatencyMs` の平均は ja 63.1 ms / en 24.9 ms（Cold_Start を除くと ja 39.1 ms / en 24.9 ms）で、10 ms 未満の基準を満たさない。**ただし中央値は ja 19 ms / en 20 ms、最小 9 ms**（実測） |
| DynamoDB Vector Index は「recall 99% 以上」か | **DynamoDB は 6 群すべて達成**（0.993〜1.000）。**OpenSearch は 6 群のうち 1 群が未達**（ja / Distinct_Sku_K 33 が平均 0.987）（実測） |
| レイテンシはどう違うか | 中央値で **OpenSearch 213 ms ÷ DynamoDB 19.5 ms = 10.9 倍**。Cold_Start は DynamoDB 398 ms 対 OpenSearch 18,356 ms（`took`）で 2 桁違う（実測） |
| コストはどう違うか | DynamoDB 側はストレージ 0.07 USD/月（推定）で無視できる。**支配的なのは OpenSearch の OCU** で、検証全体で 7.4833 OCU-hour = 1.80 USD（実測）。アイドル時は 0.00 OCU-hour = 0 USD（実測） |
| 機能制約は許容できるか | 6 項目のうち **5 項目は許容可、1 項目（フィルタ演算子）が許容不可**。範囲フィルタが実測で非対応と確定したため、価格帯や在庫数で絞ってから意味検索する要件を DynamoDB 単独で満たせない |
| 日本語埋め込みは実用水準か | **実用可**。日英差は最大 0.007（小数第 3 位）にとどまる。ただし**日本語が一貫して悪く、k を上げると差が広がる**（実測） |
| VECTORSEARCH で scale-to-zero は効くか | **適用される**。60 分以上の 0 OCU 区間が 4 件・合計 3,090.0 分、最長 1,555.0 分（実測）。アイドル時月額 0 USD |

---

## 2. 測定条件（要件 18.17）

### 2.1 共通条件

| 項目 | 値 |
|---|---|
| 実施日 | 2026-08-18 〜 2026-08-22（段階 0 の事前確認から Good_Table 不変性確認まで） |
| リージョン | us-west-2 |
| AWS アカウント | 992382598974 |
| 対象レコード件数 | 15,000 件（5,000 SKU × 3 倉庫）**実測**（`ItemCount` 15,000 / AOSS `SearchableDocuments` 15,000） |
| Ground_Truth 対象 | itemId 単位で重複排除した 5,000 件の一意ベクトル **実測** |
| 埋め込みモデル | `amazon.titan-embed-text-v2:0`（Amazon Bedrock、`normalize: true`） |
| 次元数 | 1,024（両バックエンド同一。f32 に丸めて両方へ同一値を書き込み） |
| 距離関数 | DynamoDB `COSINE` / OpenSearch `cosinesimil`（HNSW / m 16 / ef_construction 128） |
| Distinct_Sku_K | 1 / 10 / 33（上限 33 = floor(TopK 上限 100 ÷ 倉庫行数 3)） |
| 要求 TopK | 3 / 30 / 99（`TopK = 3 × Distinct_Sku_K`） |
| 対象言語 | `ja` / `en`（SKU ごとに独立生成した 2 本のベクトル） |
| 倉庫フィルタ | recall 測定・レイテンシ測定・キャパシティ測定のいずれも**適用なし（全倉庫）**。等価フィルタの受理は Q1 プローブの対照ケース（`warehouseId = WH-TOKYO`）で確認した |
| DynamoDB テーブル | `kiro-roasters-inventory-vector`（PK itemId / SK warehouseId / オンデマンド / **GSI 0 本** / Streams 無効 / PITR 無効） |
| DynamoDB インデックス | `byEmbeddingJa`（`embeddingJa`）/ `byEmbeddingEn`（`embeddingEn`）の 2 本。`SearchSchema` は `warehouseId` を `INLINE_FILTER` のみ、射影は `INCLUDE`（6 属性） |
| OpenSearch | Collection `kiro-inventory-vector`（VECTORSEARCH）/ Collection Group `kiro-inventory-vector-group`（NEXTGEN / min OCU 0 / max OCU 2 / standbyReplicas ENABLED）/ Index `inventory-vector` |
| 乱数シード | recall 測定のクエリ選定 20260805、キャパシティ測定のクエリベクトル 20260101 |

### 2.2 埋め込み生成（初回バッチ）

| 項目 | 値 | ラベル |
|---|---|---|
| Bedrock 呼び出し回数（バッチ本体） | **10,000 回**（5,000 SKU × 2 言語） | 実測 |
| 所要時間 | **95.0 分**（2026-08-20T22:45Z 〜 2026-08-21T00:20Z） | 実測（OCU 系列の区間分解で確定） |
| レート設定 | 120 リクエスト/分（既定値） | — |
| 3 倉庫行の扱い | 1 SKU の埋め込み 1 本を 3 行へ複製する。**呼び出し回数を 3 倍しない** | — |
| 入力トークン数合計 | 約 500,000 トークン（ja 約 60 / en 約 40 の平均 50 トークン想定） | **推定**（本検証は実測トークン数を記録していない。参考の実測点はクエリ 1 本で `inputTextTokenCount 29`） |
| Bedrock 概算費用 | 約 0.01 USD | **推定**（単価 0.02 USD / 100 万入力トークン。単価は本検証で実測していない前提値） |
| 埋め込み書き込み区間の OCU 消費 | 4.6833 OCU-hour（検索 3.1333 / インデックス 1.5500）= **1.12 USD** | 実測（単価 0.24 USD/OCU-hour） |
| Bedrock 成功埋め込みの通算 | **10,153 回**（バッチ 10,000 + 補償 6 + 18.3 の 2 + 19.2 の 1 + 13.17 の 132 + 13.18 の 12） | 実測 |

**`InvokeModel` の API 呼び出し回数は成功埋め込み回数の 2 倍になる。** クエリ埋め込みは必ずレイテンシ最適化推論を試して失敗し、標準推論で再試行するためである（知見 7）。台帳には**成功した埋め込みのみ**を計上している。

### 2.3 格納値の検証（要件 3.6 / 3.13〜3.18）

| 項目 | 値 | ラベル |
|---|---|---|
| 検証対象 | 10,000 組（5,000 SKU × 2 言語） | 実測 |
| 一致 | **10,000 / 10,000**（ja 5,000 / en 5,000） | 実測 |
| 不一致 | 0 | 実測 |
| 未格納 | 0 | 実測 |
| 判定 | `consistent: true` / `passed: true` / `failedCount: 0` | 実測 |
| Bedrock 呼び出し | **0 回**（再生成を伴わない） | 実測 |
| 経路 | Vector_Table 側 `GetItem` 5,000 回 / Vector_Collection 側 `_mget` 50 回 | 実測 |

両バックエンドに**次元数と全 1,024 次元の数値が完全一致した状態で**格納されていることを確認した。したがって以降のレイテンシ・recall の差はデータの差ではなく検索実装の差である。

### 2.4 Paired_Query_Set（全 60 件、要件 18.8）

同一の意味的意図を持つ日本語クエリと英語クエリを 1 対 1 で対応づけた固定集合である。内訳は flavor 20 / body 10 / origin 12 / usage 10 / material 8。乱数シード（20260805）はクエリの**選定順序にのみ**使うため、シードを変えても ja / en の対応は不変である。

| id | intent | 日本語 | English |
|---|---|---|---|
| q01 | flavor | 花のような香りで酸味の強い浅煎りの豆 | light roast beans with floral aroma and bright acidity |
| q02 | flavor | チョコレートのような甘さの深煎りブレンド | dark roast blend with chocolate sweetness |
| q03 | flavor | ジャスミンとレモンを思わせる華やかな風味 | vibrant flavor reminiscent of jasmine and lemon |
| q04 | flavor | ナッツとチョコレートの香ばしい風味 | toasty nutty and chocolate flavor |
| q05 | flavor | キャラメルとりんごのような甘い風味 | sweet flavor of caramel and apple |
| q06 | flavor | チョコレートとオレンジが重なる風味 | layered flavor of chocolate and orange |
| q07 | flavor | カシスとグレープフルーツのような果実感 | fruity notes of blackcurrant and grapefruit |
| q08 | flavor | スパイスとハーブと土の香りがある豆 | beans with spice, herbal and earthy aroma |
| q09 | flavor | ハニーとシトラスの明るい甘さ | bright sweetness of honey and citrus |
| q10 | flavor | ブラックティーとレモンを思わせる繊細な風味 | delicate flavor like black tea and lemon |
| q11 | flavor | ベリーのような酸味が際立つコーヒー | coffee with prominent berry acidity |
| q12 | flavor | フルーティーで華やかなブレンド | fruity and vibrant blend |
| q13 | flavor | ナッティで香ばしいブレンド | nutty and toasty blend |
| q14 | flavor | キャラメルのような甘みのあるブレンド | blend with caramel-like sweetness |
| q15 | flavor | スパイシーで個性的なブレンド | spicy and distinctive blend |
| q16 | flavor | シトラス系の爽やかな酸味のコーヒー | coffee with refreshing citrus acidity |
| q17 | flavor | 酸味がほとんどない苦味主体のダークロースト | dark roast with very low acidity and bitter forward taste |
| q18 | flavor | 酸味が穏やかでバランスの取れたミディアムロースト | medium roast with balanced and mild acidity |
| q19 | flavor | ビターチョコのような余韻が続くフレンチロースト | french roast with a lingering bitter chocolate finish |
| q20 | flavor | フローラルな香りが立つブレンド | blend with a pronounced floral aroma |
| q21 | body | 軽いボディで飲みやすいライトロースト | light roast with light body that is easy to drink |
| q22 | body | 重いボディでコクのあるフレンチロースト | french roast with full body and rich depth |
| q23 | body | しっかりしたボディのシティロースト | city roast with medium-full body |
| q24 | body | 非常に重いボディのダークロースト | dark roast with heavy body |
| q25 | body | なめらかな口当たりのブレンド | smooth-bodied blend |
| q26 | body | 力強いボディのエスプレッソ向けブレンド | bold-bodied blend for espresso |
| q27 | body | 軽やかで後味の軽いブレンド | light-bodied blend with a clean finish |
| q28 | body | 深く重いボディの深煎りブレンド | deep and full-bodied dark roast blend |
| q29 | body | ボディが中程度で毎日飲めるコーヒー | coffee with medium body for everyday drinking |
| q30 | body | コクが強くミルクに負けない豆 | beans with strong body that stand up to milk |
| q31 | origin | エチオピア産のベリー系の風味の豆 | beans from Ethiopia with berry flavor |
| q32 | origin | ブラジル産のナッツ感のある焙煎豆 | roasted beans from Brazil with nutty character |
| q33 | origin | コロンビア産のキャラメルのような甘さの豆 | beans from Colombia with caramel-like sweetness |
| q34 | origin | グアテマラ産のチョコレート感のある豆 | beans from Guatemala with chocolate character |
| q35 | origin | ケニア産の酸味が強い豆 | beans from Kenya with bright acidity |
| q36 | origin | インドネシア産の土の香りがする豆 | beans from Indonesia with earthy aroma |
| q37 | origin | コスタリカ産のハニーのような甘さの豆 | beans from Costa Rica with honey-like sweetness |
| q38 | origin | タンザニア産の紅茶のような風味の豆 | beans from Tanzania with black tea like flavor |
| q39 | origin | エチオピアのイルガチェフェの生豆 | green beans of Ethiopian Yirgacheffe |
| q40 | origin | ブラジルのサントスの生豆 | green beans of Brazilian Santos |
| q41 | origin | コロンビアのスプレモの焙煎豆 | roasted beans of Colombian Supremo |
| q42 | origin | グアテマラの SHB の未焙煎の豆 | unroasted beans of Guatemalan SHB |
| q43 | usage | ハンドドリップに向いた焙煎豆 | roasted beans suited for pour over brewing |
| q44 | usage | エスプレッソ抽出に向いた深煎り豆 | dark roast beans suited for espresso extraction |
| q45 | usage | 手軽に一杯だけ抽出できるドリップバッグ | drip bag for easily brewing a single cup |
| q46 | usage | 来客用に配りやすい個包装のドリップバッグ | individually packed drip bags that are easy to hand out to guests |
| q47 | usage | 1kg の業務用の大容量焙煎豆 | 1kg bulk roasted beans for commercial use |
| q48 | usage | 200g の小容量パックの焙煎豆 | 200g small pack roasted beans |
| q49 | usage | ギフトに向いたブレンドの詰め合わせ | blend assortment suited for gifts |
| q50 | usage | アイスコーヒー向けの深煎り豆 | dark roast beans for iced coffee |
| q51 | usage | 自家焙煎用に仕入れる未焙煎の生豆 | unroasted green beans purchased for in-house roasting |
| q52 | usage | 20個入のドリップバッグをまとめて買いたい | want to buy 20 pack drip bags in bulk |
| q53 | material | コーヒー豆を保存するためのバルブ付の袋 | bag with valve for storing coffee beans |
| q54 | material | ギフトセットの外装に使う箱 | box used as outer packaging for gift sets |
| q55 | material | 銘柄や焙煎日を表示するためのラベル | label for showing the blend name and roast date |
| q56 | material | 袋の封緘に使うシール | seal used to close bags |
| q57 | material | 梱包箱を封じるための粘着テープ | adhesive tape for sealing shipping boxes |
| q58 | material | ハンドドリップに使う紙のフィルター | paper filter used for pour over brewing |
| q59 | material | テイクアウト用のカップとフタ | cup and lid for takeout |
| q60 | material | ギフトラッピングを仕上げる綿のリボン | cotton ribbon to finish gift wrapping |

**クエリ件数 60 件**（要件 13.6 の下限 50 件を満たす）。60 件 × 2 言語 × 2 バックエンド × Distinct_Sku_K 3 種 = **720 観測**を実施し、失敗 0 件・欠落 0 件だった（実測）。

---

## 3. DynamoDB 側の実測値（要件 18.2）

### 3.1 レイテンシ

条件は Paired_Query_Set 5 件（q01 / q03 / q22 / q31 / q53）× 2 言語 × 3 回 = **30 試行**、要求 TopK 30。両バックエンドは同一 `queryId`（同一クエリベクトル）を共有する。**4 つの区間は別の量なので混ぜていない。**

| 区間 | 試行 | 最小 | 中央値 | 平均 | 最大 | ラベル |
|---|---|---|---|---|---|---|
| `searchLatencyMs`（`SearchVectors` 1 往復） | 30 | 9 | 19.5 | 44.0 | 398 | 実測 |
| `searchLatencyMs`（Cold_Start 除く） | 29 | 9 | 19 | 31.8 | 240 | 実測 |
| `handlerLatencyMs`（ハンドラ全体） | 30 | 15 | 27.5 | 78.4 | 687 | 実測 |
| `handlerLatencyMs`（Cold_Start 除く） | 29 | 15 | 27 | 57.4 | 440 | 実測 |

言語別（60 件の呼び出し記録から算出）。

| 言語 | 区間 | 試行 | 最小 | 中央値 | 平均 | 最大 | ラベル |
|---|---|---|---|---|---|---|---|
| ja | `searchLatencyMs` | 15 | 9 | 19 | 63.1 | 398 | 実測 |
| ja | `searchLatencyMs`（Cold_Start 除く） | 14 | 9 | 18.5 | 39.1 | 240 | 実測 |
| en | `searchLatencyMs` | 15 | 9 | 20 | 24.9 | 135 | 実測 |
| ja | `handlerLatencyMs` | 15 | 15 | 28 | 111.1 | 687 | 実測 |
| en | `handlerLatencyMs` | 15 | 16 | 26 | 45.7 | 219 | 実測 |

Cold_Start は ja の 1 回目に 1 件だけ発生し、`searchLatencyMs 398` / `handlerLatencyMs 687`（実測）。**各区間の最大値はこの 1 件が作っている。** en 側には Cold_Start が無いため、ja / en の平均差は言語差ではなく Cold_Start の混入である（Cold_Start を除くと ja 39.1 / en 24.9 に縮む）。

### 3.2 言語別 Recall_At_K

| 言語 | Distinct_Sku_K | 要求 TopK | 平均 | 最小 | 0.99 未満のクエリ | 判定（閾値 0.99） | ラベル |
|---|---|---|---|---|---|---|---|
| ja | 1 | 3 | 1.000 | 1.000 | 0 / 60 | 合格 | 実測 |
| ja | 10 | 30 | 0.995 | 0.700 | 1 / 60（q11） | 合格 | 実測 |
| ja | 33 | 99 | 0.993 | 0.818 | 4 / 60（q20 / q11 / q50 / q47） | 合格 | 実測 |
| en | 1 | 3 | 1.000 | 1.000 | 0 / 60 | 合格 | 実測 |
| en | 10 | 30 | 1.000 | 1.000 | 0 / 60 | 合格 | 実測 |
| en | 33 | 99 | 1.000 | 1.000 | 0 / 60 | 合格 | 実測 |

**DynamoDB は 6 群すべて合格。** en は 3 群すべてで平均・最小ともに 1.000 であり、Ground_Truth を完全に再現した。

### 3.3 ストレージ

`TableSizeBytes` と `IndexSizeBytes` は約 6 時間周期で更新されるため、**6 時間以上あけた連続 2 回の取得値の差が 1% 以内**であることを確認した値のみを採用した（要件 14.4）。採用値は `status: converged` / `determinate: true` / `estimatedErrorRange: null`、再取得回数は上限 3 回未満である。

| 項目 | 値 | ラベル |
|---|---|---|
| S1（埋め込み書き込み前）`TableSizeBytes` | 13,402,024 B = **13.40 MB** | 実測（2026-08-19T20:22Z、6.97 h 間隔で差 0%） |
| S2（埋め込み書き込み後）`TableSizeBytes` | 138,202,024 B = **138.20 MB** | 実測（2026-08-21T23:22Z、9.98 h 間隔で相対差 0.05%） |
| **ベクトル属性の寄与（S2 − S1）** | **124,800,000 B = 124.80 MB（119.02 MiB）** | 実測 |
| 1 レコードあたり平均増分 | **8,320.00 B**（÷ 15,000 レコード） | 実測 |
| 1 言語あたり | 4,160 B = 1,024 次元 × 4 B（f32）+ 64 B のオーバーヘッド | 実測（2 言語分で 1 次元あたり実効 4.0625 B） |
| `IndexSizeBytes`（`byEmbeddingJa`） | 74,602,024 B = **74.60 MB** / `ItemCount` 15,000 | 実測 |
| `IndexSizeBytes`（`byEmbeddingEn`） | 74,602,024 B = **74.60 MB** / `ItemCount` 15,000 | 実測 |
| **2 本の `IndexSizeBytes` 合計** | **149,204,048 B = 149.20 MB（142.29 MiB）** | 実測 |
| 総ストレージ（テーブル + インデックス 2 本） | 287,406,072 B = **287.41 MB（274.09 MiB）** | 実測 |
| インデックス 1 レコードあたり | 4,973.47 B（うち f32 本体 4,096 B、残り 877.47 B が HNSW グラフ・キー・射影 6 属性） | 実測（内訳の分解は推定） |

2 点の補足を明示する。

- **`IndexSizeBytes` と `ItemCount` は 2 本のインデックスそれぞれの `VectorIndexDescription` から直接取得した値である。`TableSizeBytes` スナップショットの差分からは算出していない**（要件 14.3、成果物の `derivedFromTableSizeDifference: false`）
- **Vector_Table は GSI を 1 本も持たないため、GSI 複製分を差し引く補正を適用していない**（要件 14.6、`gsiAdjustmentApplied: false`）。`TableSizeBytes` の差分がそのままベクトル属性の寄与になる。GSI が `ProjectionType: ALL` で存在する場合は差分が（1 + GSI 本数）倍に膨らむ（知見 1）

1 本目のスナップショットには `TableSizeBytes 138,127,144` / `IndexSizeBytes 74,557,051` / インデックスの `ItemCount 14,991` という値があり、そこから導いた `124,725,120 B` / `8,315.01 B` という数値が中間記録に残っている。**これらは収束判定前の未確定値であり、上表の採用値に置き換わっている。** 9 件の件数差も 2 本目で解消した（約 6 時間周期の概数更新の遅れであったことが裏付けられた）。

### 3.4 1 検索あたりの消費キャパシティ

**要件 18.2 が求める「RCU（小数第 1 位）」は測定不能である。** `SearchVectors` の `ConsumedCapacity` は `{ VectorSearchRequestBytes, VectorSearchUnits }` の 2 項目のみを返し、`CapacityUnits` / `ReadCapacityUnits` / `Table` / `Indexes` はいずれも返らない。`ReturnConsumedCapacity: INDEXES` を指定しても内訳は返らない（実測、知見 8）。したがって RCU 換算値は本検証では得られず、代わりに実際に返る 2 項目を記載する。

同一クエリベクトル（シード 20260101）/ TopK 30 / 言語ごとに 100 回 / 逐次実行。失敗 0 件・欠落 0 件（実測）。

| インデックス | 検索回数 | 平均 | 最小 | 最大 | 合計 | ラベル |
|---|---|---|---|---|---|---|
| `byEmbeddingJa` | 100 | **77,551.97 B** | 76,871 B | 77,874 B | 7,755,197 B | 実測 |
| `byEmbeddingEn` | 100 | **86,417.40 B** | 85,359 B | 87,347 B | 8,641,740 B | 実測 |
| 合計 | 200 | **81,984.685 B** | — | — | 16,396,937 B | 実測 |

CloudWatch メトリクス `VectorSearchRequestBytes`（ディメンション `TableName` + `VectorIndexName`、測定区間 2026-08-22T03:50:00Z 〜 03:51:00Z）を照会すると、`Sum` が同区間の `ConsumedCapacity` の総和と**差 0 B で完全一致**し、`SampleCount` も検索回数と一致した（実測）。2 つの経路は同一の量を数えている。

観測から言えること。

- **同一条件でも 1 検索あたりの値は一定でない**（ja の幅 1,003 B = 平均比 1.3% / en の幅 1,988 B = 2.3%）
- **同一 TopK でもインデックスによって水準が違う**（差 8,865 B = 11.4%）。クエリベクトルは 2 本とも同一なので、差はインデックス側（格納ベクトルの分布）に由来する
- `VectorSearchUnits` は**比較可能だった 270 件すべてで `VectorSearchRequestBytes` と同値**だった（実測）。ただし観測範囲は 1 テーブル / 2 インデックス / 1,024 次元 / COSINE / TopK 1〜100 に限る。**反例が無いことを示したのであり、API 仕様として常に同値であることを示したのではない**

### 3.5 TopK 依存性

TopK 1 での観測値 61,318 B が TopK 依存かを掃引で確認した（`byEmbeddingJa` / TopK ごとに 10 回 / 同一クエリベクトル）。

| TopK | 1 | 3 | 10 | 30 | 50 | 99 | 100 |
|---|---|---|---|---|---|---|---|
| 平均バイト数（実測） | 61,307.3 | 62,257.5 | 66,194.3 | 77,278.0 | 88,856.8 | 116,474.8 | 117,243.8 |

最小二乗フィット（推定）：**`bytes ≈ 60,559.8 + 565.51 × TopK`、R² = 0.999967、最大残差 247 B**。

- TopK 1 の実測平均 61,307.3 B は先行観測の 61,318 B と **0.02% 差**で一致した。61,318 B は TopK 1 の値であり固定量ではない
- TopK 100 では TopK 1 の **1.91 倍**になる
- **フィールド名に反して要求サイズではない。** 1,024 次元 f32 のクエリは 4,096 B 固定で、TopK を変えても要求本文は変わらないのに実測値は 61 KB → 117 KB まで動く
- **走査量に対応するとは断定しない。** 固定成分（約 60.6 KB）と比例成分（約 566 B/件）が何を数えているかは黒箱観測から確定できない。比例成分 565.5 B/件は 1 件の応答本文 1,125 B（実測）の半分程度であり、応答バイト数とも一致しない

---

## 4. OpenSearch 側の実測値（要件 18.3）

### 4.1 レイテンシ

DynamoDB 側と同一条件（30 試行 / 同一 `queryId` / TopK 30）。

| 区間 | 試行 | 最小 | 中央値 | 平均 | 最大 | ラベル |
|---|---|---|---|---|---|---|
| `took`（OpenSearch 内部） | 30 | 92 | 177 | 844.6 | 18,356 | 実測 |
| `took`（Cold_Start 除く） | 29 | 92 | 166 | 240.8 | 947 | 実測 |
| `searchLatencyMs`（`_search` 1 往復） | 30 | 116 | 213 | 895.7 | 18,962 | 実測 |
| `searchLatencyMs`（Cold_Start 除く） | 29 | 116 | 213 | 272.7 | 978 | 実測 |
| `handlerLatencyMs`（参考） | 30 | 124 | 222 | 914.7 | 19,202 | 実測 |

言語別（60 件の呼び出し記録から算出）。

| 言語 | 区間 | 試行 | 最小 | 中央値 | 平均 | 最大 | ラベル |
|---|---|---|---|---|---|---|---|
| ja | `searchLatencyMs` | 15 | 116 | 213 | 1,516.6 | 18,962 | 実測 |
| ja | `searchLatencyMs`（Cold_Start 除く） | 14 | 116 | 201.0 | 270.5 | 811 | 実測 |
| en | `searchLatencyMs` | 15 | 138 | 213 | 274.7 | 978 | 実測 |
| ja | `took`（Cold_Start 除く） | 14 | 92 | 162.0 | 235.3 | 761 | 実測 |
| en | `took` | 15 | 112 | 189 | 245.9 | 947 | 実測 |

**中央値の比は OpenSearch `searchLatencyMs` 213 ms ÷ DynamoDB `searchLatencyMs` 19.5 ms = 10.9 倍**（実測）。いずれも埋め込み生成を含まない 1 往復である。

**記載したクエリ埋め込みレイテンシは標準推論の値である**（要件 18.22）。実測 163 / 172 / 175 / 176 / 180 / 183 / 186 / 187 ms（10 回中 391 ms は 1 回目で Lambda の初期化を含む）。**`embeddingLatencyMs` には失敗したレイテンシ最適化推論の 1 往復が含まれる**ため、標準推論単体の所要時間より大きい側に振れる（知見 7）。

### 4.2 言語別 Recall_At_K

| 言語 | Distinct_Sku_K | 要求 TopK | 平均 | 最小 | 0.99 未満のクエリ | 判定（閾値 0.99） | ラベル |
|---|---|---|---|---|---|---|---|
| ja | 1 | 3 | 1.000 | 1.000 | 0 / 60 | 合格 | 実測 |
| ja | 10 | 30 | 0.993 | 0.800 | 3 / 60（q43 / q48 / q50） | 合格 | 実測 |
| ja | 33 | 99 | **0.987** | **0.758** | **8 / 60**（q21 / q11 / q46 / q43 / q48 / q50 / q47 / q51） | **不合格** | 実測 |
| en | 1 | 3 | 1.000 | 1.000 | 0 / 60 | 合格 | 実測 |
| en | 10 | 30 | 1.000 | 1.000 | 0 / 60 | 合格 | 実測 |
| en | 33 | 99 | 0.993 | 0.758 | 4 / 60（q30 / q48 / q49 / q47） | 合格 | 実測 |

**12 群のうち 11 群が合格、`opensearch` / `ja` / Distinct_Sku_K 33 の 1 群が不合格である。** 平均 0.987374 は閾値 0.99 を下回り、最小 0.757576、閾値未満のクエリは 8 件だった。これは緩和して書くべき事実ではないので、そのまま記録する。

#### 不合格の機構（実装の欠陥ではない）

最悪ケースの q43 / ja / Distinct_Sku_K 33 を両バックエンドで並べると原因がはっきりする（いずれも実測）。

| バックエンド | 返却行数 | 一意 SKU 件数 | 一致 SKU | Recall_At_K |
|---|---|---|---|---|
| DynamoDB | 99 | **33** | 33 / 33 | **1.000** |
| OpenSearch | 99 | **42** | 25 / 33 | **0.758** |

**DynamoDB は同一の TopK 99 で Ground_Truth を完全に再現している。** つまり「TopK 99 では取り切れない」のではない。差は一意 SKU 件数に現れており、OpenSearch は 33 SKU を返すべき 99 行の枠に 42 SKU を詰めている。

すなわち **HNSW の近似探索が、同一ベクトルを持つ 3 つの倉庫兄弟をすべて回収しきれず、1〜2 行しか返さない SKU が生じる。** その結果 99 行という窓に余分な SKU が入り込み、本来上位にあるべき SKU が窓の外へ押し出される。これは近似最近傍探索が同値の重複ベクトルに対して持つ性質であり、本実装の欠陥ではない。DynamoDB が同一条件で 1.000 を出していることが、Ground_Truth 側にも要求 TopK 側にも問題がないことの証拠である。

**含意は本番設計に効く。** 同一ベクトルを N 行に複製する構成は、TopK を N 分の 1 に希釈するだけでなく（知見 3）、**近似探索の recall そのものを劣化させる。** ベクトルを SKU 単位の 1 行に置けばこの劣化要因は消える。

#### 同値の頻度（測定上の危険要因）

同一ベクトルの 3 行複製により距離の完全同値が頻出する。境界での同値は 0 件だが、返却行の同値は支配的である（いずれも実測）。

| 項目 | 値 |
|---|---|
| 境界同値（ε = 1e-6）のクエリ件数 | **0 / 60**（6 群すべて） |
| 順位が一意に定まらなかった件数 | 0（6 群すべて） |
| 完全同値エントリ数 | 60（6 群すべて） |
| 返却行のうち距離が完全一致した行（例: ddb / ja / K=33） | 5,789 / 5,940 = **97.5%** |
| 同上（aoss / ja / K=33） | 5,907 / 5,940 = 99.4% |

Ground_Truth の順位は itemId 昇順で決定論的に確定しており、再現性は `recallDigest` / `groundTruthDigest` / `queryOrderDigest` の 3 つで検証済み（`verified: true`、実測）。

### 4.3 OCU 使用量

| 区間 | 区間長 | 消費 OCU-hour | ラベル |
|---|---|---|---|
| 検索継続区間（13.17 の recall 測定 / AOSS 側 360 検索） | 35.0 分 | **0.97**（0.9667。検索 0.9667 / インデックス 0.00） | 実測 |
| 検索継続区間（埋め込み投入。純粋な検索ではない） | 95.0 分 | **4.68**（4.6833。検索 3.1333 / インデックス 1.5500） | 実測 |
| アイドル区間 1（2026-08-19T20:50Z 〜 08-20T22:45Z） | 1,555.0 分 | **0.00** | 実測 |
| アイドル区間 2（2026-08-21T00:20Z 〜 12:45Z） | 745.0 分 | **0.00** | 実測 |
| アイドル区間 3（2026-08-21T13:50Z 〜 08-22T00:45Z） | 655.0 分 | **0.00** | 実測 |
| 全期間（2026-08-19T20:50Z 〜 08-22T04:25Z / 3,335 分 / 667 サンプル） | 55.58 時間 | **7.48**（7.4833） | 実測 |

**アイドル時の OCU 使用量は 3 区間すべて 0.00 OCU-hour である**（要件 18.3）。区間分解の総和は全期間の 7.4833 OCU-hour と一致した（欠落も重複もない）。

**要件 14.9 が意図する検索継続区間は 35.0 分 / 0.9667 OCU-hour の方である。** 95.0 分の区間は消費の 33% が `IndexingOCU` であり純粋な検索区間ではない。

### 4.4 Cold_Start 所要時間

**60 分以上の連続 0 OCU 状態からの Cold_Start は未実測である。** 本仕様が scale-to-zero と呼ぶ状態（連続 0 OCU 60 分以上）からの検索を 1 度も実行していない。アイドル記録を汚さないための利用者判断であり、測定不能ではない。

最も近い実測 2 例（いずれも要件 9.9 の打ち切り 30,000 ms 以内、実測）。

| 出典 | `took` | `searchLatencyMs` | `handlerLatencyMs` | 直前の確定 0 OCU |
|---|---|---|---|---|
| スコア正規化キャリブレーション | **19.3 秒** | 19.9 秒 | 20.1 秒 | 25.0 分 |
| レイテンシ測定 | **18.4 秒** | 19.0 秒 | 19.2 秒 | 5.0 分 |

**この 2 点から継続時間と Cold_Start の関係は判定できない**（5.0 分で 18.4 秒、25.0 分で 19.3 秒、差 0.9 秒、n = 2）。60 分以上でも同水準になるかは推定にとどまる。

なお、レイテンシ測定時に記録した「直前アイドル約 16 分」は **0 OCU 状態の長さではない。** それは AOSS への検索が無かった時間であり、`SearchOCU` が実際に 0 だったのは直前の 1 バケット（5.0 分）のみである。

**副産物：検索終了から `SearchOCU` が 0 に落ちるまで約 14 分の遅れがある**（2 例で観測、実測）。**課金は最終検索の時点では止まらない。**

### 4.5 `OCUUtilization`

**測定不能である。0 と記録してはならない。** 「使用率 0 を測定した」のではなく「メトリクスが公開されていない」。

| 確認 | 結果 |
|---|---|
| `ListMetrics --namespace AWS/AOSS` | 100 系列 / **15 メトリクス名**を返し `NextToken` なし。`2xx` / `4xx` / `ActiveCollection` / `DeletedDocuments` / `IndexingOCU` / `IngestionRequestErrors` / `IngestionRequestLatency` / `IngestionRequestRate` / `IngestionRequestSuccess` / `SearchOCU` / `SearchRequestErrors` / `SearchRequestLatency` / `SearchRequestRate` / `SearchableDocuments` / `StorageUsedInHot`。**`OCUUtilization` は含まれない** |
| `ListMetrics --metric-name OCUUtilization` | `{ "Metrics": [] }` |
| `GetMetricData` + `SEARCH()`（他 2 つと同一の次元キー集合・同一の式形 / 2026-08-17T04:20Z〜08-22T04:25Z / Minimum・Average・Maximum） | **系列 0 本 / データ点 0 件**。同じ式形で `SearchOCU` / `IndexingOCU` は系列 1 本 / データ点 667 件を返すため、次元指定の誤りによる空振りではなくメトリクスの不存在である |

**主張の範囲**：us-west-2 のこのアカウントの NextGen VECTORSEARCH Collection Group で公開されていないことを示した。AOSS の仕様として存在しないことを示したのではない（`ListMetrics` は直近約 14 日にデータのあるメトリクスのみを列挙する）。

したがって要件 7.8（右サイジング指標としての `OCUUtilization`）は本検証では満たせない。

---

## 5. 主張の検証（要件 18.19）

定義：「一桁ミリ秒」= 平均レイテンシ 10 ミリ秒未満、「recall 99% 以上」= Recall_At_K の平均値 0.99 以上。

### 5.1 一桁ミリ秒 → **未達**

| バックエンド | 言語 | `searchLatencyMs` 平均 | Cold_Start 除く平均 | 判定 |
|---|---|---|---|---|
| DynamoDB | ja | 63.1 ms | 39.1 ms | **未達** |
| DynamoDB | en | 24.9 ms | 24.9 ms | **未達** |
| OpenSearch | ja | 1,516.6 ms | 270.5 ms | 未達 |
| OpenSearch | en | 274.7 ms | 274.7 ms | 未達 |

DynamoDB は基準の 10 ms に対して Cold_Start を除いても ja 3.9 倍 / en 2.5 倍である（実測）。ただし**中央値は ja 19 ms / en 20 ms、最小は両言語とも 9 ms** で、一桁ミリ秒に到達する呼び出しは実在する。「平均 10 ms 未満」という基準では未達、という限定付きの判定である。区間の定義も明示しておく：`searchLatencyMs` は `SearchVectors` の 1 往復のみで、埋め込み生成（標準推論で 163〜187 ms）を含まない。**エンドツーエンドではさらに 1 桁上がる。**

### 5.2 recall 99% 以上 → **DynamoDB は達成 / OpenSearch は 1 群が未達**

| バックエンド | 言語 | K=1 | K=10 | K=33 | 判定 |
|---|---|---|---|---|---|
| DynamoDB | ja | 1.000 | 0.995 | 0.993 | **達成** |
| DynamoDB | en | 1.000 | 1.000 | 1.000 | **達成** |
| OpenSearch | ja | 1.000 | 0.993 | **0.987** | **未達（K=33）** |
| OpenSearch | en | 1.000 | 1.000 | 0.993 | 達成 |

DynamoDB Vector Search は 6 群すべてで 0.99 以上を満たした（実測）。**「recall 99% 以上」という主張は、本ワークロードの DynamoDB 側については達成と判定できる。**

---

## 6. 機能制約 6 項目の対比（要件 18.4）

| # | 制約 | DynamoDB Vector Search | OpenSearch Serverless VECTORSEARCH | 業務要件に対する判定 |
|---|---|---|---|---|
| 1 | TopK 上限 | **100 件**（`maxTopK: 100`、実測） | 同等の上限なし（`maxTopK: null`、実測） | **許容可**。ただし同一ベクトルの 3 行複製により実効的な一意 SKU 上限は 33 になる（知見 3） |
| 2 | フィルタ演算子の対応範囲 | **等価（`=`）のみ**。比較・範囲・`BETWEEN`・`IN` は実測で拒否（実測） | 等価 + 範囲（`supportedFilterKinds: ['equality','range']`、実測） | **許容不可**。価格帯や在庫数で絞ってから意味検索する要件を単独で満たせない。回避策は TopK 100 で取得後にアプリ側で絞ることだが、絞り込み後の件数が保証されない |
| 3 | 距離関数 | インデックス作成時に固定。**変更不可**（`distanceFunctionMutable: false`、実測） | 同じくインデックス作成時に固定（`distanceFunctionMutable: false`、実測） | **許容可**。COSINE で両バックエンドを揃えており、変更手順も文書化してある（第 12 節） |
| 4 | 課金モード | **オンデマンド必須**（`requiresOnDemandBilling: true`、実測） | 該当なし（`false`、実測） | **許容可**。本テンプレートの既存テーブルはすべてオンデマンドである |
| 5 | 次元数上限 | **4,096**（実測） | 16,000（実測） | **許容可**。Titan Text Embeddings V2 の最大が 1,024 であり上限に触れない。両バックエンドで同一次元を使う本構成の実効上限は 4,096 |
| 6 | `Query` / `Scan` / PartiQL による読み取り | **不可**（`readableByQueryScanPartiQL: false`、実測）。ベクトルインデックスは `SearchVectors` からのみ読める | 可（`true`、実測） | **許容可**。**インデックスが読めないだけで、基底テーブルのベクトル属性は `GetItem` で読める**（格納値検証の 5,000 回の `GetItem` で実証済み）。全件走査が必要な用途（Ground_Truth 計算）は基底テーブルの `Scan` で足りた |

上表の値は `GET /vector-search/capabilities` の実応答から取得したものであり、UI の機能制約比較表も同じ応答を唯一の供給源としている（画面側に固定値を持たせていない）。

**1 件の文面の不整合を明示する。** `capabilities` 応答の `filterKindsUnverified` は「実測で確定させる対象である」という文面のまま公開されている。第 7.1 節のとおり範囲フィルタは実測で「対応しない」と確定済みであり、`supportedFilterKinds: ['equality']` という判定内容自体は正しいが、**文面が確定済みの事実と食い違っている。** 修正には `amplify/functions/shared/vector/constraints.ts` の変更とデプロイを要するため、本検証では実施していない。

---

## 7. Open Questions の決着

### 7.1 Q1: `SearchConditionExpression` の範囲条件 → **対応しない**（要件 18.5）

**ドキュメント間の矛盾。** 開発者ガイドは `SearchConditionExpression` が等価（`=`）のみに対応し比較・範囲・`IN` は未提供と記述する。一方 SDK API リファレンスは、`HASH` 要素が `=` のみである一方 **`INLINE_FILTER` 要素は比較演算子および範囲演算子に対応する**と記述している。両者は矛盾している。

**実測条件。** 既存の本番インデックス `byEmbeddingJa`（`SearchSchema` は `warehouseId` を `INLINE_FILTER` のみ / `IndexStatus: ACTIVE` / `searchable: true`）に対し、対照ケースの等価条件を含む 8 通りの `SearchConditionExpression` を投げた。**使い捨てインデックスは作成していない**（既存インデックスで足りたため。テーブルあたり上限 5 本に対し観測 2 本 / 残り 3 枠）。

| ケース | 式 | HTTP | 結果 |
|---|---|---|---|
| 対照（等価） | `#f = :eq` | **200** | 受理 |
| 下限のみ | `#f > :lo` | 400 | `Invalid SearchConditionExpression: Invalid comparator used in SearchConditionExpression` |
| 下限のみ（境界含む） | `#f >= :lo` | 400 | 同上 |
| 上限のみ | `#f < :hi` | 400 | 同上 |
| 上限のみ（境界含む） | `#f <= :hi` | 400 | 同上 |
| 両方（AND 連結） | `#f >= :lo AND #f <= :hi` | 400 | 同上 |
| 両方（BETWEEN） | `#f BETWEEN :lo AND :hi` | 400 | `Invalid SearchConditionExpression: Invalid operator used in SearchConditionExpression` |
| 集合（IN） | `#f IN (:in0, :in1, :in2)` | 400 | 同上 |

**結論：対応しない。** エラー本文は 2 種類に分かれる。比較演算子（`>` `>=` `<` `<=`）は `Invalid comparator`、演算子そのものが未提供の `BETWEEN` / `IN` は `Invalid operator` である。**開発者ガイドの記述が正しく、SDK API リファレンスの `INLINE_FILTER` に関する記述が誤っている。** 実装の既定（等価条件のみ、範囲条件は `SearchVectors` を呼ばずに `RANGE_FILTER_UNSUPPORTED` で拒否）は変更していない。

追加コストは 8 回の `SearchVectors` 呼び出しのみで、`ConsumedCapacity` は対照ケースで `VectorSearchRequestBytes: 61,484` / `VectorSearchUnits: 61,484`（実測。拒否された 7 回はキャパシティを返さない）。

### 7.2 Q2: `cosinesimil` スコアからコサイン距離への逆算式 → **式 A**（要件 18.6）

実測条件は 2026-08-21 / us-west-2 / `SpaceType: cosinesimil` / 1,024 次元 / Paired_Query_Set から 5 本（ja 3 / en 2）× 上位 10 件 = **50 件**。各 `_id` に対応する格納ベクトルとクエリベクトルからローカルで厳密なコサイン距離を計算し、候補式の残差を比べた。

| 式 | 表現 | 出典 | 最大残差 | 判定 |
|---|---|---|---|---|
| **式 A** | **`d = 2 − 2 × score`** | 現行の k-NN spaces ドキュメント（`score = (2 − d) / 2`） | **1.23e-7** | **採用** |
| 式 B | `d = 1 / score − 1` | 旧版の nmslib / faiss 記述（`score = 1 / (1 + d)`） | 1.72e-1 | 棄却 |
| 参考 | `d = score` | DynamoDB 側に当てはまった対応 | 4.81e-1 | 棄却 |
| 参考 | `d = 1 − score` | score をコサイン類似度と解釈 | 2.95e-1 | 棄却 |

**式 A の最大残差 1.23e-7 は閾値 1e-3 を 4 桁下回った**（実測）。すなわち現行ドキュメントの `score = (2 − d) / 2` が AOSS の VECTORSEARCH コレクションに成立し、旧版の nmslib / faiss 記述は成立しない。50 件すべてで正規化距離が 0〜2 に収まり、距離基準の不一致フラグは 1 件も立たなかった。

設計が用意していた「faiss の取り込み時正規化と Titan の `normalize` 設定を含めた再検証」は**不要だった**。格納ベクトル 50 件とクエリベクトル 5 本のノルムがいずれも 1 ± 1e-7 であり、正規化状態の食い違いが存在しなかったためである（実測）。

**DynamoDB 側とは対応が異なる。** 混同しないこと（知見 8）。

### 7.3 Q6: 1 本目が非 ACTIVE のまま 2 本目の `UpdateTable` は受理されるか → **判定不能**

**判定不能である。** Q6 が問う条件（1 本目が非 ACTIVE のまま 2 本目を発行する）が構造上成立しないためである。`VectorIndexConstruct` は `resource.node.addDependency(previous)` で 2 本を逐次化しており、2 本目のカスタムリソースは 1 本目の CREATE_COMPLETE（= `IndexStatus` ACTIVE）を待ってから開始する。

実測された事実（CloudWatch Logs と CloudFormation スタックイベントからの事後回収値）。

| 項目 | 値 |
|---|---|
| 1 本目（`byEmbeddingJa`）の `UpdateTable` 発行 | 2026-08-20T21:12:53.689Z 〜 21:12:54.202Z（onEvent 区間 512.18 ms） |
| 1 本目の ACTIVE 判定 | 2026-08-20T21:21:59.850Z → **546 秒**（下限 545.648 / 上限 546.207） |
| 2 本目（`byEmbeddingEn`）の `UpdateTable` 発行 | 2026-08-20T21:22:07.446Z（1 本目 ACTIVE の **7.550 秒後**、CREATE_COMPLETE の 0.506 秒後に CREATE_IN_PROGRESS） |
| 2 本目の ACTIVE 判定 | 2026-08-20T21:31:10.296Z → **542 秒**（下限 542.328 / 上限 542.863） |
| `ResourceInUseException` / `LimitExceededException` | **観測されず**。再試行の痕跡もない（onEvent の実行時間が 512 / 521 ms で、再試行が 1 回でもあれば 15 秒以上になる） |

**例外が返らなかったことは「並行受理可能」の証拠にはならない。** 並行状態そのものが作られていないためである。ACTIVE 到達時刻はポーリング間隔 60 秒ぶんの不確かさを持つ（実際の遷移は ja 485.4〜546.2 秒 / en 482.1〜542.9 秒の区間内）。

**所要時間への含意：スケジュール見積りは設計の既定（逐次・約 360 分側）を維持する。** 段階 7 と 8 を 1 段にまとめる判断はできない。実装は変更していない。判定するには逐次化の依存を外した専用の検証が必要であり、現行の実装のままでは構造上観測できない。

なお ACTIVE 到達 546 / 542 秒は**バックフィル対象が 0 件の状態**での値である（埋め込み投入より前にインデックスを作る順序であるため）。埋め込み投入後は再度バックフィルが走る。

---

## 8. scale-to-zero の適用可否（要件 18.7 / 7.9）

### 8.1 判定 → **適用される**

| 項目 | 値 | ラベル |
|---|---|---|
| 設定した最小 OCU | **indexing 0 / search 0**（`capacityLimits` で受理を確認。max は 2 / 2） | 実測 |
| 判定基準 | `SearchOCU` と `IndexingOCU` がともに 0 の連続 1 時間以上の区間が存在するか | — |
| 0 OCU 区間 | **7 件 / 合計 3,135.0 分（窓の 94.0%）/ 最長 1,555.0 分** | 実測 |
| うち 60 分以上 | **4 件 / 合計 3,090.0 分** | 実測 |
| 60 分以上アイドル後の実測 OCU | **`SearchOCU` 0 / `IndexingOCU` 0**（区間の定義そのもの。最も条件の揃った区間は 655.0 分 / 131 サンプル全件 0） | 実測 |
| アイドル時月額 | **0 USD** | 実測 |
| 非適用時の常時課金月額 | **算出対象外**（適用可のため。要件 7.4 の見積は発生しない） | — |

基準の 1 時間に対して 25 倍以上の余裕で成立する。

**CloudWatch とは独立の経路でも裏を取った。** `BatchGetCollectionGroup` の `currentCapacity` が 2026-08-22T04:28Z 時点（最終検索から約 32 分後）で indexing / search ともに **0.0 OCU / `autoscalingStatus: NO_ACTION`** だった（実測）。

**要件 7.9 のリスク（OCU はインメモリベクトルに主に起因するため SEARCH タイプと同等のアイドルコストになるとは限らない）は、本測定で否定された。** 最も条件の揃った 655.0 分の区間は `SearchableDocuments` が 15,000 で一定、すなわち `knn_vector` 2 本 × 15,000 ドキュメントをインメモリ相当で保持しうる状態であり、そこで `SearchOCU` / `IndexingOCU` がともに 0 だった（実測）。ただし後述の 2 つの限定が付く。

### 8.2 窓の明示（統計は窓で意味が変わる）

**24 時間連続の専用観測は未実施である。** 壁時計 24 時間は短縮できないため、利用者判断で既存の CloudWatch 系列（遡及可能な全長）による確定を選んだ。以下の統計は**窓を明示せずに引用してはならない**。

| 窓 | 期間（UTC） | サンプル | `SearchOCU` 最小/平均/最大 | `IndexingOCU` 最小/平均/最大 | 累積 OCU-hour |
|---|---|---|---|---|---|
| A: 系列の全長 | 2026-08-19T20:50Z 〜 08-22T04:25Z（3,335 分 / 55.58 h / 欠測 0） | 667 | 0 / 0.103748 / 2 | 0 / 0.030885 / 1 | **7.4833** |
| B: 直近 24 時間 | 2026-08-21T04:25Z 〜 08-22T04:30Z | 289 | 0 / 0.109343 / 2 | 0 / 0.006920 / 1 | 2.8000 |
| C: 最も条件の揃ったアイドル | 2026-08-21T13:50Z 〜 08-22T00:45Z（655.0 分 / 10.92 h） | 131 | **0 / 0 / 0** | **0 / 0 / 0** | **0.0000** |

- **窓 A は要件 7.4 / 7.6 の二値判定の根拠である。** `--hours 72` と `--hours 120` で同一結果を得たため、これが系列の全長である
- **窓 B はアイドル時の値として引用してはならない。** 検索を実行した区間を 4 つ含む混合値である
- **窓 C が要件 7.3 の趣旨に最も近い。** 4 条件がすべて揃う唯一の区間である（131 サンプル全件で 0 / `SearchRequestRate` のデータ点 0 件 / `IngestionRequestRate` のデータ点 0 件 / `SearchableDocuments` = 15,000 で一定）。**24 時間に達しないのは、次のタスクの事前確認検索が区間を終了させたためである**

**最長の 0 OCU 区間（1,555.0 分 = 25.92 時間）は 24 時間を超えるが、要件 7.3 の代替として採用しない。** 失格理由は次の 3 点（いずれも実測）。

1. Collection の作成は 2026-08-20T21:10:42Z であり、この区間の先頭 24.33 時間は **Collection がまだ存在しない**（Collection Group のみ）
2. `SearchableDocuments` は区間の最終 5 分バケットまで 0 件である。**インメモリベクトルを 1 件も保持していない状態の 0 OCU** は、15,000 × 2 本を保持した Collection の 0 OCU の証拠にならない（要件 7.9 の趣旨）
3. リクエスト 0 件でもない（末尾のバケットに `SearchRequestRate` / `IngestionRequestRate`、Collection 作成時の `CreateIndex` に対応するデータ点がある）

**測定値が存在しない区間を 0 と扱っていない。** Collection Group の作成は 2026-08-18T16:28:38Z だが OCU 系列の最初のデータ点は 2026-08-19T20:50:00Z であり、その間の約 28.4 時間はデータ点が存在しない。

### 8.3 累積課金の監視（要件 7.7）

| 項目 | 値 | ラベル |
|---|---|---|
| 累積 OCU-hour | **7.4833** | 実測 |
| 単価 | 0.24 USD / OCU-hour（us-west-2） | 前提値 |
| 累積課金見積 | **1.80 USD**（上限 20 USD / 残り 18.20 USD） | 推定 |
| 閾値超過 | `thresholdCrossed: false`。**警告は発火していない** | 実測 |

**この 1.80 USD は下限見積である。** 積算対象は `SearchOCU` / `IndexingOCU` から導く OCU-hour のみであり、**OCU-hour に還元されない課金要素を含まない。** 本 Collection には `vectorOptions.ServerlessVectorAcceleration: ENABLED` が付いており、これに伴う課金があれば上乗せになる。実費の確定には請求データ（Cost Explorer / Billing の AOSS 利用種別）が必要である。

警告経路は発火していないため「発火した」とは主張しない。代わりに経路の存在をコードとテストで確認した（`accumulateSpend` が累積 OCU-hour × 単価 > 閾値を初めて満たした点で積算を打ち切り、削除対象を含む警告を生成する。63 サンプルで 20.16 USD に到達する系列を与えるテストで担保）。

**`--watch-spend` の既定の集計区間は直近 24 時間のローリングウィンドウであり、検証開始からの通算ではない**（知見 9）。本検証では `--hours 48` を明示し、`--hours 120` と同値であることをもって 48 時間窓が通算を覆っていることを確認した。

---

## 9. 日英比較（要件 18.8〜18.10）

### 9.1 前提

| 項目 | 値 |
|---|---|
| 埋め込みモデル | `amazon.titan-embed-text-v2:0` |
| 公式の言語サポート | **英語が正式サポート**、日本語を含む 100 言語以上は**プレビュー扱い** |
| 本検証の扱い | 注意書きに留めず、SKU ごとに日英 2 本のベクトルを独立生成して**言語別に Recall_At_K を実測**した |
| 比較の公平性 | 両バックエンドが**同一のベクトル**を使うため、DynamoDB 対 OpenSearch の比較の公平性は言語にかかわらず保たれる（格納一致 10,000/10,000 を実証済み） |
| Paired_Query_Set | **60 件**（全件は第 2.4 節） |

### 9.2 バックエンド × Distinct_Sku_K ごとの日英差

| バックエンド | Distinct_Sku_K | ja 平均 | en 平均 | 差（ja − en、小数第 3 位） | ラベル |
|---|---|---|---|---|---|
| DynamoDB | 1 | 1.000 | 1.000 | **0.000** | 実測 |
| DynamoDB | 10 | 0.995 | 1.000 | **−0.005** | 実測 |
| DynamoDB | 33 | 0.993 | 1.000 | **−0.007** | 実測 |
| OpenSearch | 1 | 1.000 | 1.000 | **0.000** | 実測 |
| OpenSearch | 10 | 0.993 | 1.000 | **−0.007** | 実測 |
| OpenSearch | 33 | 0.987 | 0.993 | **−0.006** | 実測 |

対応するクエリ集合は 6 群すべてで同一（`sharedQueryCount: 60` / `queryIdMismatch: false` / 対応の取れないクエリ 0 件、実測）。すなわち差は言語のみを変数とした差である。

**2 つの傾向が明確に読める。**

1. **日本語は一貫して悪い。** 差の符号は 6 群すべてで 0 以下であり、正の群は 1 つもない
2. **k を上げると差が広がる。** K=1 では両言語 1.000 で差が出ないが、K=10 / K=33 で −0.005〜−0.007 が現れる。上位 1 件を当てる用途では差が観測できず、上位 10〜33 件の並びで初めて差が出る

### 9.3 観察例（要件 18.9）

日本語クエリ 5 件と対応する英語クエリの上位結果を、同一 TopK 30 / Distinct_Sku_K 相当 10 で取得した。表示は一意 SKU の上位 5 件（`rank` は返却行の順位で、3 倉庫行の複製により 1 / 4 / 7 / 10 / 13 と 3 刻みになる）。距離は小さいほど近い。

**q01 flavor（`花のような香りで酸味の強い浅煎りの豆` / `light roast beans with floral aroma and bright acidity`）**

| 言語 | rank 1 | rank 4 | rank 7 | 距離（rank 1） |
|---|---|---|---|---|
| ja | グアテマラ サントス G2 ライト 1kg | グアテマラ サントス G1 ライト 500g | グアテマラ SHB SHB ライト 200g V315 | 0.5706 |
| en | Blend Floral light roast 200g | Blend Floral light roast 100g | Blend Floral light roast 500g | 0.3403 |

**これが日英差の質的な違いをもっともよく示す例である。** 英語は「Floral」というブレンド名の語彙に正面から当たり、日本語は「浅煎り」「酸味」に反応してグアテマラのライトロースト群を返した。日本語側の返却は誤りではない（浅煎りで酸味のある豆である）が、`floral` に対応する「フローラル」ブレンドを上位に上げられていない。距離の水準も日本語側が一貫して大きい（0.57 対 0.34）。

**q03 flavor（`ジャスミンとレモンを思わせる華やかな風味` / `vibrant flavor reminiscent of jasmine and lemon`）**

| 言語 | rank 1 | rank 4 | rank 7 | 距離（rank 1） |
|---|---|---|---|---|
| ja | エチオピア スプレモ G2 シティ 500g | エチオピア スプレモ G2 ミディアム 200g | エチオピア SHB SHB シティ 200g | 0.5901 |
| en | Drip bag Ethiopia mix 5 pack V288 | Drip bag Ethiopia mix 5 pack V272 | Drip bag Ethiopia mix 5 pack V248 | 0.6606 |

産地（エチオピア）は両言語で一致した。**カテゴリの選択が分かれ、日本語は焙煎豆、英語はドリップバッグを上位に置いた。** この例では日本語側の距離が小さい（0.59 対 0.66）。

**q22 body（`重いボディでコクのあるフレンチロースト` / `french roast with full body and rich depth`）**

| 言語 | rank 1 | rank 4 | rank 7 | 距離（rank 1） |
|---|---|---|---|---|
| ja | ブレンド リッチ フレンチ 200g | ブレンド エスプレッソ フレンチ 200g | ブレンド エスプレッソ フレンチ 200g V523 | 0.5356 |
| en | Blend Rich french roast 200g | Blend Rich french roast 500g | Blend Rich french roast 100g | 0.4438 |

**両言語が同じ SKU（リッチ / フレンチ / 200g）を 1 位に置いた。** 意味的意図が語彙に素直に対応するクエリでは日英が一致する。

**q31 origin（`エチオピア産のベリー系の風味の豆` / `beans from Ethiopia with berry flavor`）**

| 言語 | rank 1 | rank 4 | rank 7 | 距離（rank 1） |
|---|---|---|---|---|
| ja | エチオピア イルガチェフェ G1 シティ 500g V472 | エチオピア SHB G1 シティ 500g | エチオピア イルガチェフェ SHB シティ 500g | 0.5509 |
| en | Ethiopia Santos green beans | Ethiopia SHB G2 dark roast 200g | Ethiopia Santos G2 light roast 1kg | 0.3767 |

産地は両言語で完全に一致（全件エチオピア）。**日本語は焙煎豆に絞り、英語は生豆・焙煎豆を混ぜた。**

**q53 material（`コーヒー豆を保存するためのバルブ付の袋` / `bag with valve for storing coffee beans`）**

| 言語 | rank 1 | rank 4 | rank 7 | 距離（rank 1） |
|---|---|---|---|---|
| ja | 資材 袋 1kg用 バルブ付 | 資材 袋 100g用 バルブ付 V1128 | 資材 袋 200g用 バルブ付 | 0.3149 |
| en | Packaging material bag L with valve | Packaging material bag M with valve | Packaging material bag S with valve | 0.3458 |

**資材クエリは日英でほぼ同一の挙動である。** どちらも「袋 × バルブ付」に正確に当たり、サイズだけが並び順で異なる。語彙が具体物を指すクエリでは言語差がほとんど出ない。

なお 5 例すべてで、**同一クエリに対する DynamoDB と OpenSearch の上位 SKU と距離は一致している**（距離の表示桁は DynamoDB が f32 のフル桁、OpenSearch が式 A による逆算値のため末尾数桁の見え方が違う）。

### 9.4 風味クエリに対する Material_Sku の非出現（要件 18.10）

負例クラスの妥当性確認である。Material_Sku（袋・箱・ラベル・シール・テープ・包装紙・カップ・フタ・フィルター・タグ・リボン・カード。5,000 SKU 中 2,008 件）はフレーバー・ボディ・酸味を持たないため、風味クエリの上位に現れてはならない。

| 項目 | 値 | ラベル |
|---|---|---|
| 対象クエリ | `intent === 'flavor'` の **20 件**（q01〜q20。全文は第 2.4 節） |
| 集計単位 | バックエンド 2 × 言語 2 × Distinct_Sku_K 3 = **12 集計** |
| **上位に含まれた Material_Sku 件数** | **12 集計すべてで 0 件** | 実測 |
| 判定 | `materialSkuFree: true`（12 集計すべて）/ `allFlavorGroupsMaterialSkuFree: true` | 実測 |

**Distinct_Sku_K 33（上位 33 SKU）まで広げても 1 件も混入しなかった。** 意味検索が風味の有無というカテゴリ境界を正しく捉えていることを示す。

### 9.5 判定 → **実用可**

判定根拠。

1. **差の絶対値が小さい。** 6 群の最大差は 0.007（小数第 3 位）であり、業務上の体感差にならない水準である
2. **DynamoDB 側は日本語でも 6 群すべてで閾値 0.99 を満たした**（ja 1.000 / 0.995 / 0.993）
3. **上位 1 件では差が出ない**（両言語 1.000）。「最も近い 1 件を返す」用途では日本語のプレビュー扱いによる実害が観測されない
4. **質的にも破綻していない。** 観察例のとおり、日本語の返却は「誤った商品」ではなく「解釈の異なる正しい商品」である（q01 の浅煎り・酸味の豆、q31 の焙煎豆への絞り込み）

同時に、実用可という判定に付ける限定を明示する。

- **日本語が一貫して悪いという傾向は実在する。** 6 群すべてで差の符号が 0 以下であり、偶然の揺れではない
- **k を上げると差が広がる。** 上位 33 件の並びを業務的に意味のある順序として扱う用途（たとえば候補一覧をそのまま担当者に提示する）では、日本語側の劣化が見える可能性がある
- **OpenSearch の ja / K=33 は閾値を割った**（0.987）。ただしこれは言語の問題より近似探索と 3 行複製の相互作用が支配的である（第 4.2 節）

---

## 10. コスト（要件 14.10 / 14.11 / 18.18）

### 10.1 前提条件と採用単価

| 項目 | 値 | 出所 |
|---|---|---|
| リージョン | us-west-2 | — |
| 想定クエリ量 | 1 日 10,000 クエリ = **月 300,000 クエリ** | 要件 14.10 |
| OpenSearch OCU | **0.24 USD / OCU-hour** | 要件 14.10 の採用単価 |
| Bedrock Titan Text Embeddings V2 入力 | **0.00002 USD / 1,000 入力トークン**（= 0.02 USD / 100 万トークン） | **前提値。本検証で実測していない** |
| DynamoDB オンデマンド書き込み | **1.25 USD / 100 万 WRU** | 前提値 |
| DynamoDB オンデマンド読み取り | **0.25 USD / 100 万 RRU** | 前提値 |
| DynamoDB ストレージ | **0.25 USD / GB-月** | 前提値。**ベクトルインデックス分（`IndexSizeBytes`）も同一単価で課金される前提であり、これは未確認である** |
| DynamoDB ベクトル検索 | **単価未確定** | 後述 |

### 10.2 PoC 規模（5,000 SKU / 15,000 レコード / 2 言語）の月額内訳

| 項目 | 数量 | 月額 | ラベル |
|---|---|---|---|
| 埋め込み生成（**初回のみ**、2 言語分） | 10,000 回 / 約 500,000 入力トークン | **約 0.01 USD** | 推定（トークン数が推定、単価が前提値） |
| DynamoDB ストレージ | テーブル 138.20 MB + インデックス 149.20 MB = **287.41 MB（0.2874 GB）** | **約 0.07 USD** | 推定（数量は実測、単価は前提値） |
| DynamoDB 書き込み（**初回のみ**） | 複製 15,000 WRU + 埋め込み 150,000 WRU = 約 165,000 WRU | **約 0.21 USD** | 推定（1 レコード 9,213.5 B は実測。WRU 換算と単価は推定） |
| DynamoDB 検索 | 300,000 検索 × 81,984.685 B = **約 24.6 GB の `VectorSearchUnits`** | **算出不能（単価未確定）** | 数量は実測 |
| OpenSearch 検索時 OCU | 実測の検索密度で 300,000 検索 → 約 805 OCU-hour | **約 193 USD**（上限 350 USD） | 推定。**線形換算が成立しない。次項参照** |
| OpenSearch アイドル時 OCU | 0.00 OCU-hour | **0 USD** | 実測 |
| （参考）本検証で実際に発生した OCU 課金 | 7.4833 OCU-hour | **1.80 USD**（検証期間の総額） | 実測 |

**DynamoDB 検索の単価が未確定である点を明示する。** `SearchVectors` は `CapacityUnits` を返さず、`VectorSearchRequestBytes` / `VectorSearchUnits` の 2 項目のみを返す。本検証では `VectorSearchUnits` の単価を実測・確認していないため、金額に換算できない。**数量（1 検索 81,984.685 B / TopK 30、実測）だけを記録し、単価が判明した時点で乗じられる形にしてある。** 推測した単価を入れて金額を作ることはしない。

**OpenSearch 検索時 OCU の 193 USD は線形換算の産物であり、そのまま信じてはならない。** 算出根拠は「実測の検索区間 35.0 分で 360 検索 / 0.9667 OCU-hour（平均 1.657 OCU）」を検索密度一定として 300,000 検索まで延長したものである。実測時の密度は 0.17 検索/秒と低く、max 2 OCU の容量に対して余裕が大きい。**より高い密度で流せば同じクエリ数をより短い稼働時間で処理でき、OCU-hour は下がる。** 上限は max 2 OCU が常時稼働する場合の 2 × 0.24 × 730 = **350 USD/月**である。

### 10.3 本番想定規模（50,000 SKU × 3 倉庫 = 150,000 レコード、月 300,000 クエリ）

PoC の 10 倍のレコード数である。**線形換算が成立する項目と成立しない項目を分けて示す。**

| 項目 | 線形換算 | 本番想定の値 | ラベル |
|---|---|---|---|
| 埋め込み生成（初回のみ） | **成立**（SKU 数に比例） | 100,000 回 / 約 500 万トークン → **約 0.10 USD** | 推定 |
| 埋め込み生成の所要時間（初回のみ） | **成立**（レート上限に律速） | 95.0 分 × 10 = **950 分 ≈ 15.8 時間** | 推定（実測 95.0 分の 10 倍） |
| DynamoDB ストレージ | **成立**（レコード数に比例） | 2.874 GB → **約 0.72 USD/月** | 推定 |
| DynamoDB 書き込み（初回のみ） | **成立** | 約 1,650,000 WRU → **約 2.06 USD** | 推定 |
| DynamoDB 検索 | **クエリ数には比例するがレコード数への比例は不明** | 300,000 検索 × 81,984.685 B。**1 検索あたりのバイト数がデータ量に依存するかは未実測**（TopK 依存は実測済み） | 数量のみ / 単価未確定 |
| OpenSearch 検索時 OCU | **成立しない**（時間課金。稼働時間 × OCU で決まる） | 約 193 USD（実測密度の延長、上限 350 USD） | 推定 |
| OpenSearch アイドル時 OCU | **成立しない**（規模に依存しない固定項） | **0 USD** | 実測 |
| インデックス作成の所要時間 | **不明**（PoC はバックフィル対象 0 件での 546 / 542 秒しか測っていない） | **未実測** | — |

**線形換算が成立しない項目を 3 つ明記する。**

1. **OpenSearch の OCU は時間課金である。** クエリ件数にもレコード件数にも直接比例しない。稼働時間とその間の OCU 水準で決まる。加えて、インメモリのベクトル量が 10 倍になれば OCU 水準が上振れする可能性があるが、本検証は 15,000 ドキュメントでしか測っていない
2. **アイドル時 OCU は 0 USD の固定項である。** 規模を 10 倍にしても 0 USD であり、これが scale-to-zero の最大の価値である
3. **`VectorSearchRequestBytes` のレコード数依存は未実測である。** TopK 依存は 7 点で実測したが（`bytes ≈ 60,559.8 + 565.51 × TopK`）、テーブルのレコード数を変えた測定はしていない。走査量に対応するなら 10 倍のデータで固定成分が増える可能性がある

### 10.4 コストに関する結論

- **DynamoDB 側のストレージ費用は意思決定の要因にならない。** PoC 0.07 USD/月 / 本番想定 0.72 USD/月（推定）。次元数を削減する動機はストレージ費用ではない（第 13 節）
- **支配的なコストは OpenSearch の OCU である。** アイドルが 0 USD である一方、検索稼働時間がそのまま課金になる。**検索終了から `SearchOCU` が 0 に落ちるまで約 14 分の遅れがある**（実測）ため、散発的な検索が多いワークロードでは「1 検索あたり 14 分ぶんの OCU」に近い課金特性になる
- **DynamoDB 側は検索単価が未確定であるため総額比較ができない。** 本検証で言えるのはレイテンシ・recall・機能制約の比較までである

---

## 11. 知見

### 知見 1: GSI の射影がベクトル導入の前提条件になる（要件 18.11）

`ProjectionType: ALL` の GSI を持つテーブルにベクトル属性を追加すると、**ベクトルが全 GSI に複製され、ストレージと読み書きコストが GSI 本数に比例して増加する。**

Good_Table は GSI 3 本（`byWarehouse` / `byLocation` / `byUnitPrice`）すべてが `ProjectionType: ALL` である（実測）。ここに 1,024 次元のベクトルを日英 2 本追加した場合の試算（推定）は次のとおりである。

| 項目 | 現状（実測） | ベクトル 2 本を追加した場合（推定） |
|---|---|---|
| 基底テーブル | 3,074,326 B | 約 128 MB（+ 8,320 B × 15,000） |
| GSI 1 本あたり | 3,074,326 B | 約 128 MB |
| 合計（基底 + GSI 3 本） | **12,297,304 B（約 12.3 MB）** | **約 512 MB** |
| 在庫一覧の GSI Query 1 ページ | 約 5 KB / RCU 約 1 | 約 150 KB / RCU 約 19 |

2 つの倍率を混同しないこと。**ベクトル導入そのものによる増加が約 42 倍**（12.3 MB → 512 MB）で、そのうち **GSI 複製による係数が 4 倍**（基底 1 + GSI 3）である。GSI が 0 本なら約 10 倍で済む。書き込み増幅は GSI 複製の 4 倍がそのまま効く。結果として `docs/opensearch-comparison.md` に記録済みの検索パターン #1〜#12 の測定値が**無効化される。**

対策は 2 つある。**ベクトルを導入する前に GSI の射影を `KEYS_ONLY` または `INCLUDE` に変更する**か、**ベクトル専用テーブルへ分離する**（本検証が採った方法）である。前者は既存の GSI Query が射影外属性を必要としていないことの確認を要し、後者は知見 2 のトレードオフを負う。**既存テーブルの GSI 射影を確認せずにベクトル属性を追加するのは、本番環境では避けるべき変更である。**

**この対策が実際に効いていることを実測で確認した。** GSI 定義が不変であることだけでは不十分なので、次の 2 点を併せて根拠にした（いずれも実測）。

- 抽出 10 件すべての属性集合が既存 8 属性のみで、埋め込み属性（`embeddingJa` / `embeddingEn` / `embeddingModel` / `embeddingDimensions` / `embeddingUpdatedAt` / `metaJa` / `metaEn`）はいずれも不在
- Good_Table の `TableSizeBytes` 3,074,326 B に対し、3 本の GSI の `IndexSizeBytes` がいずれも **3,074,326 B で完全一致**。1 件あたり約 8 KB のベクトルが入っていれば一致しない（参考：Vector_Table は 138,202,024 B で約 45 倍）

### 知見 2: 専用テーブル分離のトレードオフ（要件 18.12）

**DynamoDB ベクトル検索の主要な価値は、ベクトルと業務データが同一テーブルに同居し、1 回の `SearchVectors` で業務属性まで取得できることにある。** 本 PoC は測定の分離（既存測定値の保全とベクトル寄与の単独測定）を優先して、**この価値を意図的に手放している。**

手放したものと得たものを並べる。

| 手放したもの | 得たもの |
|---|---|
| ベクトルと業務データの同居という本来の価値 | 既存 15,000 レコードの測定値（検索パターン #1〜#12）の保全 |
| 1 テーブルで完結する運用 | ベクトル寄与の単独測定（GSI 複製分を差し引く補正が不要になった。要件 14.6） |
| — | 撤収の単純化（テーブルごと消せるため属性除去が不要。第 14 節） |

**それでも比較結論は成立する。** キースキーマ（PK=itemId / SK=warehouseId）とデータセット（同一の 15,000 レコード、6 属性の値が同一）が Good_Table と同一であり、両バックエンドは同一のベクトルを使う。**本番設計では知見 1 の対策を施したうえで業務テーブルに同居させるのが本来の姿である。**

### 知見 3: 同一ベクトルの N 行複製が TopK を N 分の 1 に希釈する（要件 18.13）

同一 SKU の 3 倉庫行が同一ベクトルを持つ構成では、**TopK 10 の検索が返す一意 SKU は約 3 件にとどまる。** 返却行の itemId 集合を k で割る素朴な recall 算出は、完全な検索でも約 0.33 という値を返す（回帰テストで固定済み）。

したがって recall は **itemId 単位で重複排除した SKU 粒度**で測り、Distinct_Sku_K 件を得るために `TopK = 3 × Distinct_Sku_K` を要求する必要がある。TopK 上限 100 により、**測定可能な一意エンティティ単位の k の上限は `TopK ÷ N = 100 ÷ 3 = 33`** になる。本検証では N = 3 により Distinct_Sku_K の上限が 33 であった。

実測でこの構造が支配的であることを裏づける値（いずれも実測）。

- 返却行の 97.5%〜99.4% が距離の完全同値（K=33 の各群）
- 観察例の 5 クエリすべてで `returnedCount 30 / distinctSkuCount 10`（TopK 30 に対して一意 SKU が正確に 3 分の 1）
- 一意 SKU の順位が 1 / 4 / 7 / 10 / 13 と 3 刻みで現れる

**さらに本検証で 1 つ追加の害が判明した。** 3 行複製は TopK を希釈するだけでなく、**近似探索の recall そのものを劣化させる。** OpenSearch の ja / K=33 が閾値を割った原因がこれである（第 4.2 節）。HNSW は同一ベクトルの 3 兄弟をすべて回収しきれず、99 行の窓に 42 SKU を詰めてしまい、本来上位の SKU を押し出した。DynamoDB が同一条件で 1.000 を出しているため、これは実装の欠陥ではなく近似探索と重複ベクトルの相互作用である。

**本番設計への示唆は明確である。ベクトルは SKU 単位のレコードに 1 本だけ置き、倉庫別在庫を別レコード（または別テーブル）として保持する構成が有力である。** そうすれば TopK 100 がそのまま 100 件の一意 SKU に対応し、TopK 上限の制約が実質的に 3 倍緩み、上記の recall 劣化要因も消える。

### 知見 4: 日本語埋め込みの実用性は測定できる（要件 18.8 / 18.9）

「Titan Text Embeddings V2 の日本語サポートはプレビュー扱い」という事実は、**注意書きではなく実測値として提示できる。** 必要なのは 2 つだけである。同一の意味的意図を持つ日英クエリの対（Paired_Query_Set 60 件）と、SKU ごとに独立生成した日英 2 本のベクトルである。これがあれば言語だけを変数とした recall 差が測れる（第 9 節、最大差 0.007）。

両バックエンドが同一のベクトルを使うため、DynamoDB 対 OpenSearch の比較の公平性は言語にかかわらず保たれる。**「プレビュー扱いだからリスクがある」で止めずに、リスクの大きさを数値で出せる構造にしておくことに意味がある。**

### 知見 5: 書き込み後の読み出し検証は最小権限と衝突する（要件 18.20）

**「書き込んだら読み返して確かめる」という素朴な検証設計は、「書き込む主体には書き込み権限のみを与える」という最小権限の原則と正面から衝突する。**

旧要件 3.6（埋め込みバッチが両バックエンドから読み出して突き合わせる）と要件 17.7（埋め込みバッチロールは `aoss:WriteDocument` のみ）が同時に成立せず、実行時に全件が認可エラーになった。

| 実測値 | 値 |
|---|---|
| `storedCount` | 1712 |
| `bedrockCalls` | 1712 |
| `failedCount` | **0** |
| `truncatedCount` | 0 |
| `verifiedMatchedCount` | **0** |
| `verifiedMismatchedCount` | **1712** |
| 失敗一覧 100 件の内容（全件同一） | `stage: VERIFICATION` / `errorCode: ACCESS_DENIED_IAM` / `security_exception: [security_exception] Reason: Bad Authorization` |

**さらに悪いことに、旧実装は検証が 1 件も成立していないのに `failedCount` を 0 のままとし、バッチを COMPLETED として終了させていた。検証結果を失敗として計上しない設計は、検証そのものを無意味にする。**

**採用した解決：Vector_Verification_Path への分離。** 検証する主体を、既に読み取り権限を持つ主体（`aoss:ReadDocument` / `DescribeIndex` を持つ検索 Lambda）へ移した。当該 Lambda に Vector_Table のテーブル ARN のみを Resource とする `dynamodb:GetItem` を新規ステートメントとして追加し、`POST /vector-search/verify` を設けた。結果は 10,000 / 10,000 一致・不一致 0・未格納 0・Bedrock 呼び出し 0 回（実測、第 2.3 節）。

**却下した案：検証専用の新規 Lambda を追加する。** 却下理由は、その実行ロールがデータアクセスポリシーの **4 件目の Principal** になり、要件 17.7 が定める「Principal は 3 件のみ」という権限構成そのものが崩れることである。Principal は 3 件（検索 Lambda = 読み取りのみ / 埋め込みバッチ = 書き込みのみ / CloudFormation 実行ロール = インデックスライフサイクルのみ）を維持した。

**副作用：人が投入結果を直接確認する経路が存在しない。** 開発者の IAM ユーザーはデータアクセスポリシーの Principal に含まれないため、インデックスを直接読めない（`GetIndex` / cloudcontrol / エンドポイント直叩きがいずれも 403、実測）。これは意図した安全性だが、同時に **Vector_Verification_Path が投入の証拠を得る唯一の経路である**ことを意味する。検証経路を後付けの付属物ではなく設計の一部として置く必要がある。

### 知見 6: リソーススキーマの受理は実サービスの受理を意味しない（要件 18.21）

CloudFormation のリソーススキーマが許容する値であっても、実サービスが拒否する項目がある。本検証で遭遇した 3 件はいずれも**ローカルの合成テストでは原理的に検出できず、デプロイまで失敗が遅れた。**

| 項目 | スキーマ上の扱い | 実サービスの応答（実測） |
|---|---|---|
| `Method.Engine: faiss` | enum は `["nmslib","faiss","lucene"]` で `faiss` は有効値 | `[illegal_argument_exception] Field parameter 'engine' is not supported`。VECTORSEARCH では Faiss HNSW がコレクション種別側で固定されており、リクエストで選ぶ対象ではない |
| `Settings` の省略 | 任意プロパティ | 省略は「既定で k-NN 有効」ではなく `index.knn = false`。`Cannot set modelId or method parameters when index.knn setting is false` |
| `AttributeDefinitions` の省略（`UpdateTable`） | 任意プロパティ | `One element in SearchSchema is not defined in attribute definitions`。**テーブル側の既存定義とはマージされない** |

含意は 2 つある。

1. **スナップショットテストや `cdk synth` が通ることを「構成が正しい証拠」として扱えない。** 本検証は既存リソースの差分ゼロを CDK スナップショットで機械的に固定しているが、それは既存資産の保護には効いても新規リソースの受理可否には無力である
2. **実サービス固有の前提条件はスキーマから読み取れない。** `Settings.Index.Knn: true` が `Method` を指定するための前提条件であるという関係は、スキーマのどこにも書かれていない

対策として、この種の制約は要件と設計に**実測エラーメッセージ付きで**固定し、推測で書き換えないようにしてある。

### 知見 7: 要件が指定した最適化がモデル・リージョンで未対応だと、要件どおりの実装が全面的に壊れる（要件 18.22）

旧要件 10.1 は「レイテンシ最適化された推論呼び出しを使用して」と**無条件に**指定していた。実装（`createEmbeddingGenerator({ latencyOptimized: true })` → `performanceConfigLatency: 'optimized'`）は**要件どおりであり実装ミスではない。** しかし `amazon.titan-embed-text-v2:0` は us-west-2 でこれに未対応で、`POST /vector-search/embed` が**全リクエストに HTTP 400** を返した。

```json
{"stage":"EMBEDDING","errorCode":"INVALID_QUERY",
 "message":"クエリ文字列が空、または空白文字のみです。 Latency performance configuration is not supported for amazon.titan-embed-text-v2:0 in us-west-2"}
```

**A/B プローブで原因を切り分けた。** 同一モデル・同一リージョン・同一本文（`inputText` / `dimensions 1024` / `normalize true`）・同一資格情報で `performanceConfigLatency` の有無だけを変えた 2 回である（いずれも実測）。

| 呼び出し | 結果 |
|---|---|
| **指定なし** | **成功**（`dimensions` 1024 / `inputTextTokenCount` 29） |
| **`performanceConfigLatency: optimized`** | **`ValidationException` / HTTP 400**（`Latency performance configuration is not supported for amazon.titan-embed-text-v2:0 in us-west-2`） |

モデル・リージョン・IAM・本文はいずれも問題なく、当該指定のみが 400 の原因である。

**採用した対処：標準推論への 1 回限りのフォールバック。** 未対応を示すエラー（`ValidationException` かつメッセージが `latency performance configuration` と `not supported` を同時に含む）に限って標準推論で 1 回だけ再呼び出しし、使った経路を `inferencePath` として応答に載せる。モデル ID とリージョン名は判定条件に埋め込んでいない（他モデル・他リージョンでも成立させるため）。

**実環境での確認結果（実測）。**

| 項目 | 値 |
|---|---|
| `inferencePath`（ja / en 各 1 件） | **両方 `standard`**。`latency_optimized` は 1 件も観測していない |
| フォールバックの発生 | CloudWatch Logs に `vector-query-embed: fell back to standard inference.` が 1 リクエストにつき 1 行。同じ行の `calls: 2` が「最適化 1 回（失敗）+ 標準 1 回（成功）」の内訳 |
| フォールバックの単発性 | `calls` が 2 で止まり 3 以上にならない（Property 59 で担保） |
| スロットリング再試行への影響 | 0 回。フォールバックは別系統でありスロットリング再試行の回数に加算しない |
| `embeddingLatencyMs` | ja 446 ms / en 207 ms（この 2 件）。13.18 の測定では 163〜187 ms（1 回目のみ 391 ms） |

**記載したクエリ埋め込みレイテンシは標準推論の値である。** さらに **`embeddingLatencyMs` には失敗したレイテンシ最適化推論の 1 往復が含まれる**（計測が `generate()` の開始点から始まるため）。純粋な標準推論単体の所要時間より大きい側に振れる。

**フォールバックの根拠となったエラー本文は、本測定の CloudWatch Logs には現れない。** 実装がフォールバック分岐で例外を記録せずに再試行するためである。上記の本文は A/B プローブで実測した値を転記している。実環境から再取得するには Bedrock を直接叩くプローブが 1 回追加で必要になる。

含意は 3 つある。

1. **影響の非対称性。** 埋め込みバッチ側は `latencyOptimized: false` のため完走した。壊れたのはクエリ埋め込み経路のみである。ところが両検索エンドポイントは `queryId` しか受け付けず、`queryId` を発行できるのはこのエンドポイントだけであるため、**recall 測定とレイテンシ・キャパシティ・UI 検証が完全に止まった。** 単一の細い依存が測定全体を止める構造であり、性能最適化のような「あってもなくてもよい」設定を必須要件として書くとこの構造が露出する
2. **要件の書き方。** リージョン・モデル依存の最適化は「利用可能なら使う」と条件付きで書き、フォールバック先とどちらを使ったかの記録を要求すべきである
3. **エラー分類の誤誘導。** `classifyBadRequest` が HTTP 400 の既定分岐で `INVALID_QUERY` を付け、真因と無関係な定型文「クエリ文字列が空、または空白文字のみです。」を先頭に置いた。真因は詳細欄に残るため切り分け自体は可能だったが、**最初に読まれる 1 行が嘘をつく**のは実害である。**エラーコードの既定値は「該当条件を主張しないコード」（`INTERNAL_ERROR`）であるべきで、たまたま同じ HTTP ステータスを共有する具体的なコードを既定にしてはならない**

是正後の実環境確認（実測）：正常クエリ（ja / en）は HTTP 200 で `errorCode` を持たず、空文字・空白のみのクエリだけが `INVALID_QUERY` と当該定型文を返す（Lambda Duration 8.0 ms / 1.71 ms で Bedrock を呼んでいない）。修正前に観測された「`INVALID_QUERY` + 定型文 + Bedrock の本文の連結」は再現しない。

### 知見 8: スコアと距離の対応はバックエンドごとに異なり、実測でしか確定しない（要件 18.23）

両バックエンドを同一の距離基準に揃える作業で、**DynamoDB と OpenSearch で対応が逆向きだった**ことが実測で判明した。

| バックエンド | 生スコアの意味 | 距離への変換 | 厳密距離との最大残差 |
|---|---|---|---|
| DynamoDB `SearchVectors` | `SearchResults[].Score` は**コサイン距離（1 − cos）そのもの** | **変換不要** | **3.36e-8** |
| OpenSearch k-NN `cosinesimil` | `_score` は類似度側の値 | **`d = 2 − 2 × score`（式 A）** | **1.23e-7** |

棄却された式の残差は DynamoDB 側が 0.8 以上（`1 − Score` / `2 − 2 × Score` / `1/Score − 1` のいずれも）、OpenSearch 側が 1.72e-1 以上である。**採用式と棄却式の残差は数桁離れる**ため判別は容易であり、「返却行の格納ベクトルとクエリベクトルからローカルで厳密距離を計算して候補式の残差を比べる」という手続きを踏まずに推測でどちらかを選ぶ理由はない。

同時に確定した API 応答の実測事実を 3 件記録する。

1. **`ConsumedCapacity` は `{ VectorSearchRequestBytes, VectorSearchUnits }` の 2 項目のみを返す。** `VectorWriteRequestBytes` / `CapacityUnits` / `ReadCapacityUnits` / `Table` / `Indexes` はいずれも返らず、`ReturnConsumedCapacity: INDEXES` を指定しても内訳は返らない。**そして `VectorSearchUnits` は SDK の `VectorCapacity` モデルに存在しない。** SDK の型定義を信頼して読むと値が欠落するため、生応答から読んで応答に載せている
2. **観測値は両項目とも 61,318 であり、1,024 次元 f32 のクエリ（4 KiB）より一桁大きい。** フィールド名に反してリクエストサイズではなく走査量に応じた単位である可能性が高いが**断定しない。** TopK 依存であることは後続の掃引で実測した（第 3.5 節）
3. **`SearchVector` は `AttributeValue[]`（`[{"N":"..."}]`）でのみ受理される。** 素の数値配列は HTTP 400 `SerializationException` になる

### 知見 9: 応答に現れないフィールドは「偽」ではなく「測定不能」である（要件 18.24）

`DescribeTable` の `VectorIndexes[].Backfilling` は、**インデックスが ACTIVE に到達した後はキー自体が返らない。**

検索可否の判定（`IndexStatus === 'ACTIVE'` かつ `Backfilling !== true`）は「不在 = 偽」として意図どおり成立する。**しかしバックフィル完了までの経過時間（要件 5.14）は測定できない。** 「偽になるまで待つ」という設計は、フィールドが存在する前提に立っていた。**値の不在を偽と同一視する実装は、判定としては正しく動きながら、その値を使った測定を静かに無意味にする。**

対処として、判定ロジックは変更せず、`indexReadiness.backfillingPresent`（フィールドが応答に存在したか）を応答と測定出力に加え、経過時間を**測定不能**として明示的に記録するようにした（0 秒や即時完了として記録しない）。実環境での確認は `backfillingPresent: false`（実測）。

**フィールドの返却状況を正確に記録しておく。** 本検証には一見矛盾する 2 つの観測がある。

| 観測 | 状況 | `Backfilling` |
|---|---|---|
| Index_Provisioner の `isComplete`（インデックス作成中、`IndexStatus: CREATING`） | 各インデックスにつき 9 回のポーリング | **2 回目以降の 8 回すべてで `true`**（実測。1 回目は不在または `false`） |
| 測定スクリプトと検索 Lambda（インデックス ACTIVE 後、15,000 レコード投入後） | 複数回 | **キー不在**（実測） |

したがって正確には「**フィールドが一切返らない**」ではなく「**`CREATING` かつバックフィル中は `true` が返るが、ACTIVE 到達後は不在になり、`true → false` の遷移を一度も観測できない**」である。要件 5.14 が求めるのは後者の遷移時刻であり、**それが観測できないため経過時間は測定不能である**という結論は変わらない。「不在 = 偽」で検索可否が判定できることも変わらない。

同じ性質の運用上の落とし穴を 1 件併記する。**`--watch-spend` の既定の集計区間は直近 24 時間のローリングウィンドウであり、検証開始からの通算ではない。** 要件 7.7 の「累積 20 USD」を評価するには `--hours` を検証開始時点まで遡る値に明示的に広げる必要がある。既定値のまま読むと、複数日にわたる検証で累積額を過小評価する。本検証では `--hours 48` と `--hours 120` が同値であることをもって通算を覆っていることを確認した。

### 知見 10: SDK モデルの遅れは「拒否」ではなく「情報が黙って消える」形でも現れる（要件 18.21 / 18.23 の 4 例目）

知見 6 の 3 例はいずれも**リクエストが拒否される。** 本件は**リクエストが受理され、サービスが返した情報がクライアント側で黙って消える。** 同じ「スキーマ / モデルが実サービスに遅れる」パターンだが、種類が違う。

**症状。** 2 本のベクトルインデックスがともに存在し ACTIVE であるにもかかわらず、`POST /vector-search/dynamodb` が `byEmbeddingJa` に対して `INDEX_NOT_FOUND` を返した。

**原因の連鎖。**

1. `kiro-vector-search-ddb` が `@aws-sdk/client-dynamodb` を**外部モジュール（Lambda 同梱の SDK）として解決していた**（`aws-cdk-lib` 2.244.0 の `NodejsFunction` は Node 18+ で `externalModules: ['@aws-sdk/*']` を既定とする）
2. 同梱 SDK のモデルには `TableDescription.VectorIndexes` が無い
3. **AWS SDK v3 の逆シリアライズはモデル駆動であり、モデルに無いフィールドはエラーも警告もなく捨てられる**
4. `readVectorIndexDescriptions()` が `table?.VectorIndexes ?? []` を空配列として受け取り、インデックスが存在しないと判定した
5. 失敗が `INDEX_NOT_FOUND` という**別の症状に化けた**（ハンドラのロジック自体は要件どおり正しい）

**SDK バージョンの A/B（同一資格情報・同一テーブル、実測）。**

| バージョン | `VectorIndexes` |
|---|---|
| 3.1050.0 / 3.1081.0 / 3.1096.0 / 3.1100.0 / 3.1102.0 | **不在** |
| **3.1103.0** / 3.1104.0 / 3.1112.0 | **存在** |

境界は **3.1103.0** である。**AWS CLI 2.35.9 も当該フィールドを返さない**（実測）。そのため Good_Table のベクトルインデックスが 0 本であることの確認には CLI を使えず、リポジトリ同梱の SDK（3.1112.0）で行った。

**対処。** 当該関数 1 本にのみ `externalModules: []` を渡して SDK を同梱した。`commonProps` は変更していない（他の Lambda 12 本のバンドルを一切変えない）。

**回帰ガードを合成側に置いた理由が重要である。** ローカルの単体テストは `DescribeTable` を差し替えて `VectorIndexes` を返させるため、**原理的に本件を検出できない。** バンドル設定は合成テンプレートにも現れない（現れるのはアセットのハッシュのみ）。そのため `NodejsFunction` の構築引数を記録して「`@aws-sdk` を指す要素が 1 つも無いこと」を突き合わせるテスト（`amplify/custom/vector-search-ddb-bundling.test.ts`）を追加した。

**デプロイ後の直接確認（実測）。**

| 項目 | 修正前 | 修正後 |
|---|---|---|
| `index.js` | 161,128 B | **547,825 B** |
| Lambda `CodeSize` | 261,967 B | **760,111 B** |
| `require("@aws-sdk/client-dynamodb")` | 残存 | **0 件** |
| バンドル内の `VectorIndexes` / `VectorIndexDescription` | — | **3 件 / 5 件** |
| `POST /vector-search/dynamodb` | `INDEX_NOT_FOUND` | HTTP 200 / `indexStatus: ACTIVE` / `backfillingPresent: false` |

**共通の教訓。** `VectorSearchUnits`（SDK の `VectorCapacity` モデルに存在しない項目、知見 8）と同系であり、**実呼び出しでしか観測できない。** モデルに無い項目は、返ってきていても型を信じて読むと消える。新しい API パラメータやフィールドを使う Lambda は SDK を同梱し、かつ**デプロイ後に実際に呼んで応答を目で確認する**工程を省かないこと。

---

## 12. パーティションキーはセキュリティ境界にならない（要件 17.3）

**`SearchVectors` にはファイングレインアクセスコントロールの条件キーが効かない。** `dynamodb:LeadingKeys` / `dynamodb:Attributes` / `dynamodb:Select` はいずれも無効である。

したがって **`dynamodb:SearchVectors` を持つプリンシパルは任意の `warehouseId` を検索できる。** 倉庫単位のテナント分離をパーティションキーで表現しても、ベクトル検索に対しては分離として機能しない。

**アクセス制御はインデックス単位でのみ機能する。** 本検証の IAM は Resource を 2 本のインデックス ARN のみに限定しており（テーブル ARN を含まない）、これが実際に効く粒度である。言語別に 2 本のインデックスへ分けているため「日本語インデックスのみ検索可」という制御は表現できるが、「東京倉庫のみ検索可」は表現できない。

検証用途では許容した。**本番で倉庫単位やテナント単位の分離が必要な場合は、インデックスを分離単位ごとに作る（テーブルあたり上限 5 本）か、アプリケーション層で境界を設けるかのいずれかになる。**

---

## 13. 未実測・測定不能の一覧

**測定不能（サービスが値を返さない）**

| 項目 | 理由 |
|---|---|
| `OCUUtilization` の最小・平均・最大（要件 7.8 / 18.3） | us-west-2 の当該アカウント・当該 Collection Group で CloudWatch に公開されていない。3 通りの確認で系列 0 本（第 4.5 節）。**0 と記録してはならない** |
| バックフィル完了までの経過時間（要件 5.14） | ACTIVE 到達後は `Backfilling` キーが返らず、`true → false` の遷移を観測できない（知見 9） |
| `engine` の実際の値 | データプレーンが `engine` パラメータ自体を拒否するため、設定値としても応答としても取得できない（知見 6） |
| 1 検索あたりの RCU（要件 18.2） | `ConsumedCapacity` に `CapacityUnits` / `ReadCapacityUnits` が含まれない（知見 8） |

**未実測（測定可能だが実施していない）**

| 項目 | 理由 |
|---|---|
| 24 時間連続の専用アイドル観測（要件 7.3） | 壁時計 24 時間は短縮できず、利用者判断で遡及データによる確定を選んだ。二値判定と区間分解は確定済み（第 8.2 節） |
| 60 分以上の 0 OCU 状態からの Cold_Start（要件 18.3） | 検索を実行するとアイドル記録を汚し、承認スコープ外になるため実行しなかった。最も近い 2 例は 19.3 秒（0 OCU 25.0 分）と 18.4 秒（0 OCU 5.0 分）（第 4.4 節） |
| 512 / 256 次元のトレードオフ測定（要件 14.12） | 任意タスクであり核心の比較に不要。利用者判断で未実測として確定（次節） |
| 入力トークン数の実測 | バッチの返却 JSON を保存する運用にしていたが、トークン数の集計値を成果物として残していない |
| ブラウザ上での UI 操作 | 実行環境に手段が無い。UI が読む値の出所（共有関数と `capabilities` 応答）の実測と jsdom のコンポーネントテスト 17 件で代替した |

### 13.1 要件 14.12（次元数トレードオフ）の充足状況 → **未充足（未実測）**

**1,024 / 512 / 256 次元の対比表は得られていない。表を黙って省略せず、未実測であることとその理由を記録する。**

- **文面上は要件違反にならない。** 要件 14.12 は `WHERE 次元数を 512 または 256 に変更して測定を実施した場合` という条件節を持つため、未実施であれば条件が発火しない
- **しかし要件が得ようとしていた対比表は得られていないため、「未充足（未実測）」として扱う**
- **利用者判断である。** 3 案（全実施 / 一部実施 / 未実測として記録して閉じる）を提示し、3 番目が選択された
- **当該タスクは任意であり、核心の検証（1,024 次元での DynamoDB 対 OpenSearch 比較）には不要である**

**回避した所要時間と費用**（1 次元設定を 1 サイクルとし、512 と 256 で 2 サイクル）。

| 項目 | 1 サイクル | 2 サイクル | ラベル |
|---|---|---|---|
| 再埋め込みの呼び出し回数 | 10,000 回（5,000 SKU × 2 言語） | 20,000 回 | 実測由来 |
| 再埋め込みの所要時間 | 95.0 分 | 190.0 分 = 3.17 h | 実測由来 / 推定 |
| インデックス再作成の ACTIVE 到達 | 1,088 秒 = 18.1 分（ja 546 + en 542、逐次） | 36.3 分 | 実測由来 / 推定 |
| recall 再測定 | 35.0 分 | 70.0 分 | 実測由来 / 推定 |
| 実作業の小計 | 148.1 分 | 296.2 分 = 4.94 h | 推定 |
| **ストレージ収束待ち** | 12〜20 h | **24〜40 h** | 推定 |
| **壁時計の合計** | — | **約 30〜45 h** | 推定 |
| OpenSearch OCU | — | 約 11.30 OCU-hour ≈ **2.71 USD** | 推定（実測の区間値 × 2、単価 0.24 USD） |
| Bedrock | — | 約 0.02 USD | 推定 |
| DynamoDB 書き込み | — | 約 0.19 USD | 推定 |
| **費用の合計** | — | **約 2.92 USD** | 推定 |

**20 USD の上限は制約になっていない。実施しなかった理由を「上限に触れるから」と説明してはならない。** 実施後でも約 4.51 USD（上限の 23%）で、削除側 2 本 × 2 サイクルの所要時間は本検証が実測していないため見積を持たない（推定不能）。**短縮不能なのは収束待ちと再埋め込みで、両者が合計の 9 割以上を占める。**

**実施しなかった最も重い理由は非可逆性である。** 次元数はインデックス作成時に固定され変更できない。512 次元へ移るには 2 本のインデックスを削除して作り直し、`embeddingDimensions` が変わることでスキップ判定が全件不一致になり 5,000 SKU × 2 言語が全件再生成される。OpenSearch 側の `knn_vector` の Dimension も固定であるためインデックスの作り直しを要する。**その結果、収束確定させた採用値（S2 138,202,024 B / ベクトル寄与 124,800,000 B / `IndexSizeBytes` 合計 149,204,048 B）および recall・レイテンシを測定した状態は現物として失われる。** 本ドキュメントはこの状態を根拠に書いているため、1,024 次元へ戻す 3 サイクル目を実施しない限り再現できない。

**解析的に導ける範囲と導けない範囲を分ける。**

- **recall の劣化量は測定なしには得られない。** Titan v2 の次元縮約は行列学習に基づく切り詰めであり劣化量はモデル固有である。本検証は 1,024 次元の 1 点しか測っていないため外挿の根拠が無い。**「512 次元でも recall は同水準」と書いてはならない**
- **ストレージは部分的に解析導出できるが、1 点からは決まらない。** 実測 8,320.00 B / レコード（1 言語 4,160 B）に対して 2 つのモデルが同一の精度で適合する

| モデル | 512 次元 / 言語 | 256 次元 / 言語 |
|---|---|---|
| (a) `4 × d + 64`（f32 4 B/次元 + 固定 64 B） | 2,112 B | 1,088 B |
| (b) 実効 4.0625 B/次元 | 2,080 B | 1,040 B |

**512 次元の予測が 32 B（1.5%）分かれる。** どちらが正しいかは 2 点目の実測なしには決まらない。TopK について 7 点測って固定成分と比例成分を分離したのと同じ構図であり、**次元数についてはその 7 点に相当する実測が無い。**

参考値（モデル (a) / 15,000 レコード / **2 言語分として計上**、いずれも推定）：512 次元 → ベクトル寄与 **63,360,000 B（60.42 MiB）**、256 次元 → **32,640,000 B（31.13 MiB）**。

`IndexSizeBytes` の外挿はさらに弱い。実測 4,973.47 B / レコードから f32 の 4,096 B を引いた残り 877.47 B を次元に依らない成分と**仮定すれば** 512 次元 → 43,882,050 B / 本、256 次元 → 28,522,050 B / 本（推定）。**この分解も 1 点からの仮定であり検証されていない。**

**月額の対比（いずれも推定。前提は 0.25 USD/GB-月 / 本番想定 150,000 レコード / モデル (a) / 非ベクトル 893.5 B・インデックス 1 本あたり `4 × d + 877.47` B は 1,024 次元の実測からの外挿 / テーブル + インデックス 2 本の合計）。**

| 次元数 | ベクトル / レコード | テーブル | インデックス 2 本 | 合計 | 月額 |
|---|---|---|---|---|---|
| 1,024（**実測ベース**） | 8,320 B | 1.382 GB | 1.492 GB | **2.874 GB** | **約 0.72 USD** |
| 512（推定） | 4,224 B | 0.768 GB | 0.878 GB | 1.645 GB | 約 0.41 USD |
| 256（推定） | 2,176 B | 0.460 GB | 0.570 GB | 1.031 GB | 約 0.26 USD |

**差は月あたり 0.5 USD 未満である。** すなわち**次元削減の動機がストレージ費用にないことは、1,024 次元の実測だけで既に言える。** 動機になりうるのは Ground_Truth 計算時の読み取り量とインメモリのベクトル量（= OpenSearch の OCU 水準）であり、後者は本検証では未実測である。

---

## 14. 距離関数を変更する場合の再作成手順（要件 5.8）

距離関数はインデックス作成時に固定され、変更できない。COSINE 以外へ移す必要が生じた場合は次の順序になる。

| # | 手順 | 対象件数 | 想定所要時間 | ラベル |
|---|---|---|---|---|
| 1 | `VECTOR_COLLECTION_ENABLED=true` を保ったままデプロイする（false にすると Collection / Index / 検索 Lambda 4 本が消え、撤収手順そのものになる） | — | — | — |
| 2 | `byEmbeddingEn` → `byEmbeddingJa` の順に削除する（作成の逆順、1 回の `UpdateTable` で 1 本） | 2 本 | **未実測**（本検証は削除の所要時間を測っていない） | 未実測 |
| 3 | 新しい距離関数で `byEmbeddingJa` → `byEmbeddingEn` の順に再作成し、ACTIVE 到達を待つ（逐次） | 2 本 | **約 18.1 分**（ja 546 秒 + en 542 秒。ただしバックフィル対象 0 件での実測値） | 実測由来 |
| 4 | OpenSearch 側の `inventory-vector` も同一の距離基準で作り直す | 1 インデックス | **未実測**。Collection ごと作り直す必要があるか Index リソースの置換で足りるかは未確認であり、**ここが手順上の最大の未知である** | 未実測 |
| 5 | 全 SKU の両言語ベクトルを再投入する（`phase = "embed"`） | **5,000 SKU × 2 言語 = 10,000 回の埋め込み / 15,000 レコード × 2 言語分の書き込み** | **約 95.0 分** | 実測由来 |
| 6 | 両バックエンドの格納一致を再確認する（Verification_Run） | 10,000 組 | 数分 | 実測由来 |
| 7 | Ground_Truth を新しい距離基準で言語別に再計算する | 5,000 × 2 言語 | ローカル計算 | — |
| 8 | recall を再測定する | 720 観測 | **約 35.0 分** | 実測由来 |
| 9 | ストレージを再測定して収束判定する | — | **12〜20 h**（6 時間以上あけた 2 回が最小。実績間隔は約 10 h） | 推定 |

**実作業の合計は約 2.5 時間、収束待ちを含めた壁時計は約 15〜23 時間である（推定）。** 距離関数の変更は「設定を書き換えて再デプロイする」作業ではなく、**データセット全体の再投入を伴う移行である。** 距離関数の選定はインデックス作成前に確定させること。

**埋め込みベクトル自体は再生成しなくても理屈上は足りる**（距離関数はインデックス側の設定であり、格納ベクトルは同じもので構わない）。ただし本実装のスキップ判定は `embeddingModel` と `embeddingDimensions` の一致のみを見るため、次元数を変えない距離関数の変更では**スキップが効いて Bedrock を呼ばない。** 上記手順 5 の 95.0 分と Bedrock 費用は、次元数も同時に変える場合の値である。

---

## 15. Good_Table の不変性（要件 1.5 / 6.9）

**判定：ドリフトは 1 件も検出されなかった。比較した 27 項目すべて一致（相違 0 件）。**

基準は段階 0（2026-08-18T16:56:03Z）で取得したスナップショットで、**基準ファイルは読み取りのみで上書きしていない。** 確認は 2 つの独立した取得経路で行い、どちらも `identical: true` / 相違 0 件 / 突き合わせ 10 件 / 取得できなかったキー 0 件だった（実測）。

- 経路 A：段階 0 と完全に同一手順（`DescribeTable` + `DescribeContinuousBackups` + `Scan(Limit 40)` → `itemId#warehouseId` 昇順で先頭 10 件）。**選ばれた 10 キーが基準と同一であることを実際に確認した**
- 経路 B：基準の 10 キーを明示指定した `BatchGetItem`（`Scan` の返却順に依存しない照合）

| 項目 | 基準 | 現在 | 判定 |
|---|---|---|---|
| PK / SK | `itemId:HASH, warehouseId:RANGE` | 同一 | 一致 |
| GSI `byLocation` | `warehouseId:HASH, location:RANGE` / `ProjectionType: ALL` | 同一 | 一致 |
| GSI `byUnitPrice` | `warehouseId:HASH, unitPrice:RANGE` / `ProjectionType: ALL` | 同一 | 一致 |
| GSI `byWarehouse` | `warehouseId:HASH, itemId:RANGE` / `ProjectionType: ALL` | 同一 | 一致 |
| Streams | `StreamEnabled: true` / `NEW_AND_OLD_IMAGES` | 同一 | 一致（`LatestStreamLabel` がテーブル作成時刻のままで、無効化と再有効化を経ていない） |
| PITR | `ENABLED` | 同一 | 一致（`RecoveryPeriodInDays` 35 / `EarliestRestorableDateTime` が作成直後のまま） |
| アイテム件数 | 15,000 | 15,000 | 一致 |
| 抽出 10 件の属性集合 | 8 属性（`itemId` / `itemName` / `lastUpdated` / `location` / `lotNumber` / `quantity` / `unitPrice` / `warehouseId`） | 同一 | 一致 |
| 抽出 10 件のアイテムサイズ | 214 / 212 / 212 / 225 / 223 / 223 / 216 / 216 / 214 / 214 B | 同一 | **1 バイトも違わない** |
| `VectorIndexes` | — | **0 本** | 要件 1.6 を満たす |
| OSIS `kiro-inventory-pipeline` | `STOPPED` | **`STOPPED`**（`StatusReason: The pipeline is stopped`） | 一致 |

補足を 4 点。

- **`ProjectionType: ALL` の GSI は `NonKeyAttributes` を返さない**ため、射影属性の明示列挙は原理的に存在しない（基準・現在ともに「列挙なし」で一致）
- **Good_Table の `VectorIndexes` が 0 本であることは、SDK 未対応による不表示ではない。** 同一プロセス・同一 SDK（3.1112.0）で Vector_Table を引くと 2 本（ともに ACTIVE / `searchable: true` / 各 74,602,024 B / 15,000 件）が返る（知見 10）
- **`ItemCount` は約 6 時間周期の概数である。** 概数どうしが完全一致したため全件 `Scan` は実行していない（RRU 消費 0）。**「15,000 件を数えた」とは主張しない。「基準と同じ値を返している」ことを主張する。** 傍証として 3 GSI の `ItemCount` がいずれも 15,000、Vector_Table が 15,000、AOSS の `SearchableDocuments` が 15,000
- **OSIS の `LastUpdatedAt` は 2026-08-11** で、基準取得（2026-08-18）より前である。本検証の期間中にパイプライン設定が変更されていないことを示す。起動も設定変更も行っていない

**比較できなかった項目を明示する。** 基準に記録が無いため比較できないのは `TableSizeBytes`、GSI の `IndexSizeBytes` / `ItemCount`、`AttributeDefinitions`、`BillingModeSummary`、`DeletionProtectionEnabled`、`WarmThroughput`、`LatestStreamArn`、PITR の期間系、`TableId` / `CreationDateTime`、および**抽出 10 件の属性「値」**である。いずれも要件 1.5 の列挙項目には含まれない。

**とくに属性値は基準が属性名とサイズ推定しか持たないため、「同じ属性名・同じサイズで値だけが書き換わった」変更は本比較では検出できない。** 書き込みを行っていないことは IAM（Good_Table を Resource とする書き込み Action を 1 件も持たない）とコード（読み取り API のみを呼ぶ）で担保しており、本比較はその補強である。`TableId` と `CreationDateTime`（2026-08-08T07:42:43Z）が作成時のままであることは、テーブルが削除・再作成されていないことを示す。

---

## 16. 撤収手順（要件 18.14 / 18.15）

### 16.1 削除対象（全件）

| # | リソース | 種別 |
|---|---|---|
| 1 | `kiro-inventory-vector` | OpenSearch Serverless Collection（VECTORSEARCH） |
| 2 | `inventory-vector` | 上記 Collection のインデックス（Collection と同時に消える） |
| 3 | `kiro-inventory-vector-enc` / `-net` / `-data` | 暗号化 / ネットワーク / データアクセスポリシー |
| 4 | `kiro-inventory-vector-group` | Collection Group（NEXTGEN） |
| 5 | `byEmbeddingEn` / `byEmbeddingJa` | DynamoDB ベクトルインデックス 2 本 |
| 6 | `kiro-roasters-inventory-vector` | DynamoDB テーブル（Vector_Table） |
| 7 | `kiro-vector-query-cache` | DynamoDB テーブル（Query_Vector_Cache） |
| 8 | `kiro-vector-query-embed` / `kiro-vector-search-ddb` / `kiro-vector-search-aoss` / `kiro-vector-capabilities` / `kiro-vector-embed-batch` | Lambda 5 本 |
| 9 | Index_Provisioner（onEvent / isComplete / Provider framework） | Lambda とカスタムリソース |
| 10 | 上記 Lambda の実行ロールと、本検証で追加した IAM ポリシー | IAM |
| 11 | API Gateway の 6 ルート（`/vector-search/capabilities` / `embed` / `dynamodb` / `opensearch` / `embed-batch` / `verify`） | API Gateway |

**削除しないもの**：Good_Table とその 3 GSI、既存 Collection `kiro-inventory-search` と既存 Collection Group `kiro-inventory-group` と既存 3 ポリシー、OSIS `kiro-inventory-pipeline`（`STOPPED` のまま維持）、既存 Lambda 8 本。

### 16.2 実行順序

1. `vectorCollectionEnabled=false` で再デプロイする（Collection / Index / 検索 Lambda 4 本 / API ルートが削除される）
2. Collection Group `kiro-inventory-vector-group` を削除する
3. Index_Provisioner の Delete により `byEmbeddingEn` → `byEmbeddingJa` の順に `UpdateTable` の `VectorIndexUpdates[0].Delete` で削除される（**作成の逆順、1 回 1 本**）
4. Vector_Table（`RemovalPolicy.DESTROY`）を削除する
5. Query_Vector_Cache を削除する
6. 本検証で追加した IAM ポリシー・ロールと残る Lambda を削除する

**Vector_Table の削除によって 2 本のベクトルインデックスは同時に消える。** したがって手順 3 は Vector_Table を残す場合のみ必要である。

**Good_Table の 15,000 件のアイテムから属性を除去する操作は不要である**（要件 18.15）。ベクトル属性・埋め込みメタデータ・ベクトルインデックスはいずれも Vector_Table 側にのみ存在し、Good_Table には 1 つも書き込んでいない（第 15 節で実測確認済み）。専用テーブル方式を採ったことで撤収が単純になった。

### 16.3 確認方法

`npm run vector:measure -- --teardown-check` が次を確認する。

| 確認項目 | 期待値 |
|---|---|
| `ListTables` | `kiro-roasters-inventory-vector` と `kiro-vector-query-cache` が**無い** |
| `ListCollections` | `kiro-inventory-vector` が**無い**（`kiro-inventory-search` は残る） |
| `ListCollectionGroups` | `kiro-inventory-vector-group` が**無い**（`kiro-inventory-group` は残る） |
| `SearchOCU` / `IndexingOCU` | 0（課金対象リソースが 0 件） |
| Good_Table | 段階 0 のスナップショットと同一（PK / SK、3 GSI、Streams、PITR、15,000 件、抽出 10 件以上の属性集合とアイテムサイズ） |
| OSIS `kiro-inventory-pipeline` | `STOPPED` のまま |

### 16.4 確認結果

**未実施。** 撤収は本ドキュメントの執筆後に実行する工程であり、**実行後に本節へ結果を追記する**（削除完了後に課金対象リソースが 0 件であることの確認結果を含む）。

---

## 17. 測定成果物

本ドキュメントの数値の出所である。すべて `docs/measurements/` 配下にある。

| ファイル | 内容 |
|---|---|
| `good-table-snapshot-pre-check.json` | 段階 0 の Good_Table スナップショット（不変性比較の基準） |
| `measure-pre-check-2026-08-18T16-56-03-151Z.json` | 同上の生成物 |
| `vector-index-provisioning-logs-2026-08-20T22-22-48-974Z.json` | インデックス 2 本の ACTIVE 到達（546 / 542 秒）と Q6 の観測 |
| `verify-2026-08-21T12-52-43-942Z.json` | 格納値検証 10,000 / 10,000 一致（要件 3.6） |
| `measure-search-response-shape-2026-08-21T13-09-22-492Z.json` | `SearchVectors` の生応答の形（`ConsumedCapacity` 2 項目 / `AttributeValue[]` 要求） |
| `measure-search-score-mapping-2026-08-21T13-16-15-654Z.json` | DynamoDB 側の `Score` = コサイン距離（残差 3.36e-8） |
| `measure-score-calibration-2026-08-21T13-36-09-269Z.json` | OpenSearch 側の式 A 確定（残差 1.23e-7）と Q2 の候補式比較 |
| `measure-wait-index-2026-08-21T13-01-30-871Z.json` | `--wait-index` の観測（`Backfilling` 不在） |
| `storage-snapshots.json` | ストレージ台帳（14 件。追記のみで先行分を破棄していない） |
| `measure-storage-*.json`（6 件） | S1 / S2 / `IndexSizeBytes` のスナップショットと収束判定 |
| `range-filter-probe-2026-08-21T23-43-31-870Z.json` | Q1 の 8 ケースと `ValidationException` の本文 |
| `embed-inference-path-2026-08-21T23-34-07-000Z.json` | `inferencePath: standard` とフォールバックの証跡、エラー分類の是正確認 |
| `recall-blocked-index-not-found-2026-08-21T23-56-27-429Z.json` | SDK バージョン A/B（`VectorIndexes` の境界 3.1103.0） |
| `recall-2026-08-22.json` | 720 観測の recall 集計（統合レポート） |
| `recall-observations-2026-08-22T03-35-45Z.json` | 日英の観察例（商品名付き） |
| `capacity-latency-2026-08-22.json` | 消費キャパシティ・TopK 依存・レイテンシ・UI 検証（統合レポート） |
| `measure-capacity-2026-08-22T03-50-*.json`（2 件） | 同一条件 100 回 × 2 言語の生値 |
| `capacity-latency-2026-08-22T03-53-37-635Z.json` | TopK 掃引 7 点とレイテンシ 60 呼び出しの生値 |
| `ui-comparison-2026-08-22T03-56-32-025Z.json` | 重なり指標・機能制約比較表・言語切り替えの実応答 |
| `measure-ocu-2026-08-22T04-24-12-566Z.json` | OCU 系列（667 サンプル） |
| `scale-to-zero-2026-08-22.json` | scale-to-zero 判定・窓 A/B/C・区間分解・`OCUUtilization` 測定不能の証拠（統合レポート） |
| `measure-watch-spend-*.json`（3 件） | 累積課金の推移 |
| `good-table-immutability-2026-08-22.json` | Good_Table 不変性 27 項目の照合結果 |
| `ground-truth/`（2 件） | 言語別 Ground_Truth のローカルキャッシュ（各約 104 MiB。**サイズが大きいので直接開かないこと**） |

`ground-truth/` を除き、統合レポート 4 件（`recall-2026-08-22.json` / `capacity-latency-2026-08-22.json` / `scale-to-zero-2026-08-22.json` / `good-table-immutability-2026-08-22.json`）から読み始めるのが早い。
