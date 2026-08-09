# DynamoDB と RDS の検索パターン比較 — 業務システムのフルサーバレス化における課題

## 1. はじめに

業務システムにおける「検索」は、以下のような機能が当然のように期待される:

- **曖昧検索**: 商品名の一部で絞り込む（`LIKE '%キリマンジャロ%'`）
- **範囲検索**: 在庫数が 10〜100 の商品を抽出
- **ソート**: 更新日時の降順、在庫数の昇順
- **ページネーション**: 50 件ずつ安定して取得
- **複合条件**: 倉庫 = '東京' AND カテゴリ = 'シングルオリジン' AND 在庫 > 0

RDS（PostgreSQL, MySQL）では、これらはすべて SQL の `WHERE` / `ORDER BY` / `LIMIT` / `OFFSET` で自然に実現できる。開発者は検索条件をそのまま SQL に変換するだけでよい。

**DynamoDB では根本的にアプローチが異なる。** DynamoDB は「検索エンジン」ではなく「高速 Key-Value ストア」であり、上記の検索パターンの多くを直接サポートしていない。この違いを理解せずにフルサーバレスアーキテクチャを選択すると、後から大きな設計変更を迫られることになる。

---

## 2. RDS の検索モデル（リレーショナル DB）

### SQL ベースの柔軟なクエリ

```sql
SELECT * FROM inventory
WHERE warehouse_id = 'tokyo'
  AND product_name LIKE '%キリマンジャロ%'
  AND quantity BETWEEN 10 AND 100
ORDER BY updated_at DESC
LIMIT 50 OFFSET 100;
```

このクエリは DynamoDB では **直接表現できない**。RDS ではこれが「普通」。

### 主な特徴

| 機能 | 説明 |
|------|------|
| WHERE 句 | 任意の列に対して条件指定可能 |
| LIKE | 前方一致・部分一致・後方一致すべて対応 |
| BETWEEN | 任意の数値・日付列で範囲検索 |
| ORDER BY | 任意の列でソート（複合ソートも可能） |
| LIMIT / OFFSET | 安定したページネーション |
| JOIN | 関連テーブルを結合して一括取得 |
| 集計関数 | COUNT, SUM, AVG, GROUP BY が即座に使える |

### インデックスによる最適化

- **B-tree インデックス**: 等値・範囲検索の高速化
- **GIN インデックス**: JSONB や配列の検索（PostgreSQL）
- **Full-text インデックス**: 全文検索（pg_trgm, MeCab 等）
- **複合インデックス**: 複数列の組み合わせで最適化

### 向いているケース

- アドホッククエリ（事前にアクセスパターンを網羅できない）
- 複雑な検索条件の組み合わせ
- レポーティング・集計処理
- 管理画面の一覧検索

---

## 3. DynamoDB の検索モデル（NoSQL）

### パーティションキー必須 — Query は PK 指定が前提

DynamoDB の `Query` オペレーションは、**パーティションキー（PK）の等値条件が必須**。PK を指定せずに「全レコードから条件に合うものを探す」ことは `Scan` でしかできない。

```
// これが DynamoDB の Query の前提
KeyConditionExpression: "warehouseId = :wh"
```

### ソートキーでできること

PK を指定した上で、ソートキー（SK）に対しては以下が使える:

- `begins_with(sk, 'prefix')` — 前方一致
- `sk BETWEEN :a AND :b` — 範囲
- `sk < :val`, `sk > :val`, `sk <= :val`, `sk >= :val` — 比較

**ただし、PK 内のデータに対してのみ**。別の PK のデータとは横断的に比較できない。

### GSI の SK でも同じ演算子が使える

上記の SK 演算子（`begins_with`, `BETWEEN`, `<`, `>` 等）は **GSI のソートキーでも同様に使える**。テーブルの SK と GSI の SK で使える KeyConditionExpression の演算子に違いはない。

| 演算子 | テーブルの SK | GSI の SK |
|---|---|---|
| `=` | ✅ | ✅ |
| `<`, `>`, `<=`, `>=` | ✅ | ✅ |
| `BETWEEN` | ✅ | ✅ |
| `begins_with` | ✅ | ✅ |
| `contains`（部分一致） | ❌ KeyCondition 不可 | ❌ KeyCondition 不可 |

`contains` は FilterExpression でしか使えない。つまり「部分一致」は SK や GSI の SK に入れても KeyConditionExpression では表現できない。

### Query の KeyCondition は PK + SK の 1 組しか指定できない

KeyConditionExpression では **1 回の Query で PK の等値条件 + SK の 1 つの条件** しか指定できない。複数の属性に対して同時に KeyCondition を適用することはできない。

```
// ❌ これは不可能 — SK は 1 つの条件しか受け付けない
KeyConditionExpression: "warehouseId = :wh AND begins_with(location, :loc) AND unitPrice BETWEEN :min AND :max"

// ✅ 実際にできるのはこれだけ
KeyConditionExpression: "warehouseId = :wh AND begins_with(location, :loc)"
// もう一方の条件は FilterExpression に逃がすしかない
FilterExpression: "unitPrice BETWEEN :min AND :max"
```

つまり **GSI を 2 つ追加しても、1 回の Query で両方の条件を KeyCondition として使うことはできない**。異なる GSI に対して別々に Query を実行し、アプリ側で結果を突き合わせるか、一方を FilterExpression にする必要がある。

これは RDS の `WHERE a = 1 AND b > 2 AND c LIKE 'prefix%'` が 1 クエリで完結するのとの大きな違いであり、DynamoDB で複合条件検索が難しい根本原因の一つ。

> **補足（GSI のマルチ属性キー対応）**: GSI に限り、PK・SK をそれぞれ最大 4 属性で構成できるようになった（合計 8 属性）。これにより 1 回の Query で複数属性を KeyCondition に含められる。ただし SK 属性は定義順に左から指定する必要があり、途中を飛ばせない。詳細は後述の「GSI のマルチ属性キースキーマ」を参照。

### FilterExpression — 読み取り後のフィルタリング

```
FilterExpression: "quantity > :min AND productName CONTAINS :keyword"
```

一見便利だが、**重大な罠がある**:

1. FilterExpression は Query/Scan で読み取った**後**に適用される
2. 読み取りキャパシティユニット（RCU）は FilterExpression 適用**前**のデータ量で消費される
3. `Limit` パラメータも FilterExpression 適用**前**に適用される

つまり `Limit: 20` を指定しても、FilterExpression で半分が除外されると **結果は 10 件**になる。

### GSI（Global Secondary Index）

アクセスパターンごとにインデックスを追加できる。ただし:

- テーブルあたり最大 20 個
- 書き込み時に GSI も更新されるため、WCU が追加で消費される
- GSI は結果整合性（Strongly Consistent Read 不可）

### LSI（Local Secondary Index）— テーブル作成時限定の軽量インデックス

LSI はテーブルと同じ PK を共有し、別の SK を持つインデックス。GSI と異なり **テーブル作成時にしか追加できない**（後から追加不可）。

| | GSI | LSI |
|---|---|---|
| PK | 任意（テーブルと異なる PK が可能） | **テーブルと同じ PK 固定** |
| SK | 任意 | 任意（テーブルと異なる SK） |
| 追加タイミング | いつでも | **テーブル作成時のみ** |
| 整合性 | 結果整合性のみ | **強い整合性（ConsistentRead）も可能** |
| 制限 | テーブルあたり 20 個 | テーブルあたり 5 個 |
| WCU | 別途消費（GSI 固有のスループット） | テーブルの WCU を共有（追加コストなし） |
| パーティションサイズ制限 | なし | PK あたり 10GB まで |

**LSI が有効なケース:**

PK が検索の起点と一致する場合、LSI は GSI より軽量で整合性が高い。例えば Bad Table（PK=warehouseId）に対して:

```
// テーブル作成時に LSI を定義
LSI byLocation: PK = warehouseId, SK = location
LSI byUnitPrice: PK = warehouseId, SK = unitPrice
```

これで `warehouseId` を起点にロケーション前方一致・単価範囲検索が実現でき、GSI のような追加 WCU も不要。

**LSI が使えないケース:**

Good Table（PK=itemId）の場合、検索の起点が `warehouseId`（テーブルの PK と異なる）なので LSI では対応できず、GSI が必要。

**設計上の教訓:** 検索要件はテーブル作成前に洗い出し、LSI で対応可能なものは LSI で定義しておくべき。後から「LSI があれば…」と思っても追加できない。

### 複合ソートキー（Composite Sort Key）— 従来のテクニック

> ⚠️ **GSI についてはこのテクニックは不要になった。** DynamoDB の GSI がマルチ属性キースキーマに対応したため、文字列連結による複合キーを自前で組む必要はなくなっている（後述）。以下はベーステーブル・LSI や、既存設計を理解するための参考として残す。

SK に複数の属性を区切り文字で結合して格納するテクニック。GSI を追加せずに疑似的な複合条件検索を実現する。

```
// 例: SK にロケーションと単価を結合
SK = "A-03-02#001640"
     └ location ┘ └ unitPrice (ゼロパディング) ┘
```

`begins_with` で左から段階的に絞り込める:

```
begins_with(SK, "A-03")        → ロケーション A-03 で始まるもの
begins_with(SK, "A-03-02")     → ロケーション A-03-02 のもの
```

**制約:**

1. **条件の順序が固定** — 左から順にしか絞れない。「ロケーションを飛ばして単価だけ」は不可能
2. **BETWEEN は最後の要素にしか使えない** — 途中の要素に範囲条件は適用できない
3. **数値はゼロパディング必須** — `"100"` < `"99"` になるため、`"000100"` のようにパディングが必要
4. **区切り文字の選定** — データ中に出現しない文字を使う必要がある（`#` が一般的）

**有効なケース（検索階層が固定）:**

```
// 商品カテゴリの階層検索
SK = "ROASTED#SINGLE#ETHIOPIA"
begins_with(SK, "ROASTED")               → 焙煎豆すべて
begins_with(SK, "ROASTED#SINGLE")        → シングルオリジン焙煎豆
begins_with(SK, "ROASTED#SINGLE#ETH")    → エチオピア産

// 時系列の範囲検索
SK = "2024-12-01T10:30:00"
SK BETWEEN "2024-12-01" AND "2024-12-02" → 12/1 のデータ
```

**不向きなケース（独立した検索軸）:**

今回の在庫管理のように「商品 ID」「ロケーション」「単価」が独立した検索軸で、どれか 1 つだけで検索したいケースでは、複合キーだと 1 つの軸しかカバーできない。GSI を分けた設計が適切。

**結論:** 複合ソートキーは「固定された検索階層」に強い。独立した複数の検索軸がある場合は GSI を分ける方が柔軟。ただし GSI であればマルチ属性キースキーマを使う方が、型を保てて実装も単純になる。

### GSI のマルチ属性キースキーマ（Multi-attribute Key Schema）

GSI の PK・SK をそれぞれ**最大 4 属性**で構成できる（合計最大 8 属性）。従来は文字列連結で自前の複合キー属性を作る必要があったが、その手間がなくなった。

```typescript
// 従来: 連結した合成属性をアイテムに持たせる必要があった
{
  itemId: 'ITEM#ETH-YIRG-G1',
  warehouseId: 'WH-TOKYO',
  location: 'A-03-02',
  unitPrice: 1640,
  // GSI 用の合成属性（アプリ側で生成・維持が必要）
  gsiPk: 'WH-TOKYO',
  gsiSk: 'A-03-02#001640',  // ゼロパディングも必要
}

// マルチ属性キー: 元の属性をそのまま使える
{
  itemId: 'ITEM#ETH-YIRG-G1',
  warehouseId: 'WH-TOKYO',
  location: 'A-03-02',
  unitPrice: 1640,
}
// GSI 定義側で warehouseId を PK、location + unitPrice を SK として指定する
```

**従来の複合ソートキーと比べたメリット:**

| 観点 | 複合ソートキー（連結） | マルチ属性キー |
|---|---|---|
| 合成属性の管理 | アプリ側で生成・更新が必要 | 不要（元の属性をそのまま使う） |
| 数値の扱い | ゼロパディング必須（`"001640"`） | ネイティブな数値型のまま |
| 区切り文字 | データに出現しない文字を選ぶ必要あり | 不要 |
| 既存テーブルへの追加 | 全アイテムのバックフィルが必要 | 不要（自動でインデックスされる） |
| 型の保持 | すべて文字列に潰れる | 属性ごとの型を維持 |

**クエリ時の制約（従来の複合キーと同じ考え方）:**

1. **PK 属性はすべて等値条件が必須** — 4 属性で PK を構成したら、4 つすべてを `=` で指定する
2. **SK 属性は定義順に左から** — 1 番目だけ、1〜2 番目、…と絞れるが、**途中を飛ばせない**
3. **不等号は最後の条件のみ** — `>`, `<`, `BETWEEN`, `begins_with()` はクエリ内の最後の条件でなければならない

```
// GSI: PK = [warehouseId], SK = [location, unitPrice] と定義した場合

✅ warehouseId = :wh
✅ warehouseId = :wh AND location = :loc
✅ warehouseId = :wh AND begins_with(location, :locPrefix)      // 不等号が最後
✅ warehouseId = :wh AND location = :loc AND unitPrice BETWEEN :min AND :max

❌ warehouseId = :wh AND unitPrice BETWEEN :min AND :max        // location を飛ばせない
❌ warehouseId = :wh AND begins_with(location, :p) AND unitPrice > :min  // 不等号が2つ
```

**適用範囲の注意:**

- **GSI のみ** — ベーステーブルのキースキーマと LSI は対象外（従来どおり PK 1 属性 + SK 1 属性）
- ホットパーティション対策として、PK を複数属性で構成してカーディナリティを上げる使い方もできる

**設計上の意味:** 「検索軸ごとに GSI を分ける」ケースの一部は、1 本のマルチ属性 GSI に統合できる。GSI の本数（上限 20）と書き込みコストを節約できる可能性がある。ただし「独立した軸をどれか 1 つだけで検索したい」要件は、左から順に指定する制約があるため依然として複数 GSI が必要。

### Limit の挙動 — 結果件数が不安定

```typescript
// 「20 件取得」のつもりが...
const params = {
  TableName: 'inventory',
  KeyConditionExpression: 'warehouseId = :wh',
  FilterExpression: 'quantity > :min',
  Limit: 20, // ← FilterExpression の前に適用される！
};
```

`Limit: 20` は「20 件読み取って、そこから FilterExpression で絞る」という意味。結果が 5 件しか返らないこともある。「常に 20 件返す」には、ループで `LastEvaluatedKey` を使って繰り返し取得する必要がある。

#### 重要: KeyConditionExpression のみなら Limit は安定する

上記の「件数がバラつく」問題は **FilterExpression を使った場合のみ** 発生する。検索条件を KeyConditionExpression だけで表現できれば、`Limit: 20` は「条件に合うレコードを 20 件返す」として正確に機能する。

```
// FilterExpression なし — 常に 20 件返る（データが 20 件以上ある限り）
KeyConditionExpression: "warehouseId = :wh AND begins_with(itemId, :prefix)"
Limit: 20
→ 安定して 20 件

// FilterExpression あり — 0〜20 件のどこかになる
KeyConditionExpression: "warehouseId = :wh"
FilterExpression: "quantity > :min"
Limit: 20
→ 不安定（Limit は読み取り件数であり、返却件数ではない）
```

つまり **検索条件を GSI の PK/SK 設計に落とし込めれば、ページサイズは安定する**。逆に言うと、FilterExpression が必要な検索条件を追加するたびにページネーションの安定性が犠牲になる。これが「GSI で解決できる検索」と「OpenSearch が必要な検索」の分かれ目になる。

### ページネーション — カーソルベース

DynamoDB のページネーションは `LastEvaluatedKey`（カーソル）ベース:

- 「3 ページ目に直接飛ぶ」ができない
- `OFFSET` 相当の機能がない
- 前のページに戻るには、カーソルを保持しておく必要がある

### Scan — フルテーブルスキャン

`Scan` はテーブル全体を読み取る。小規模テーブルなら問題ないが:

- テーブルサイズに比例して RCU を消費する
- 大規模テーブルでは高コスト・低パフォーマンス
- 本番環境での安易な Scan は非推奨

### 向いているケース

- キー指定のポイントアクセス（GetItem）
- 大量書き込み（IoT、ログ、イベント）
- 予測可能なアクセスパターン
- ミリ秒レベルのレイテンシが必要な場面

---

## 4. 具体的な検索パターン比較表

| 検索パターン | RDS | DynamoDB | DynamoDB での代替策 |
|---|---|---|---|
| **部分一致**（LIKE '%keyword%'） | `WHERE name LIKE '%keyword%'` — インデックス非効率だが動作する | **不可** — `contains()` は FilterExpression のみ（RCU 消費大） | OpenSearch Service と連携 |
| **前方一致**（LIKE 'prefix%'） | `WHERE name LIKE 'prefix%'` — B-tree インデックス利用可 | SK に対して `begins_with()` — **PK 指定が前提** | SK 設計で対応 or GSI 追加 |
| **数値範囲**（BETWEEN） | `WHERE qty BETWEEN 10 AND 100` — 任意列 | SK に対して `BETWEEN` — **PK 内のみ** / FilterExpression は RCU 消費 | GSI の SK に数値を配置 or FilterExpression（小規模データのみ） |
| **複合条件**（AND/OR） | `WHERE a = 1 AND (b = 2 OR c = 3)` — 自由に組み合わせ可 | KeyCondition は PK+SK のみ / FilterExpression で AND は可能だが OR は制限的 | 複数 Query の UNION をアプリ側で実装 or OpenSearch |
| **ソート**（ORDER BY 任意列） | `ORDER BY updated_at DESC` — 任意列 | **SK の昇順/降順のみ**（`ScanIndexForward`） | ソート用 GSI を追加（SK に日時等を設定） |
| **ページネーション**（OFFSET/LIMIT） | `LIMIT 50 OFFSET 100` — 安定した件数 | `Limit` + `LastEvaluatedKey` — カーソルベース、OFFSET 不可 | フロント側で全カーソルを管理 or 諦めて「次へ」のみ |
| **全文検索** | PostgreSQL: `to_tsvector` + `GIN` / MySQL: `FULLTEXT` | **不可** | OpenSearch Service |
| **集計**（COUNT, SUM, AVG） | `SELECT COUNT(*), SUM(qty) FROM ...` — 即座に実行可 | **不可** — Scan で全件取得してアプリ側集計（非現実的） | DynamoDB Streams → 集計テーブルに書き込み or Athena |

---

## 5. DynamoDB で「検索」を実現するアーキテクチャパターン

### パターン A: GSI 追加

**条件**: アクセスパターンが事前に明確で、パターン数が限定的（20 以下）

```
GSI: byCategory
  PK = categoryId
  SK = updatedAt（降順ソート用）
```

- メリット: DynamoDB のみで完結、低レイテンシ
- デメリット: パターンが増えるたびに GSI 追加が必要、WCU コスト増

### パターン B: FilterExpression

**条件**: PK 内のデータ件数が少ない場合（数百件以下）

```typescript
{
  KeyConditionExpression: 'warehouseId = :wh',
  FilterExpression: 'quantity > :min AND contains(productName, :keyword)',
}
```

- メリット: 追加インフラ不要
- デメリット: データ件数が増えると RCU 消費が膨大に、結果件数が不安定

### パターン C: DynamoDB + OpenSearch

**条件**: 全文検索・複合検索・ファセット検索が必要な場合

```
DynamoDB → DynamoDB Streams → Lambda → OpenSearch Service
                                              ↑
                                    アプリからの検索クエリ
```

- メリット: 検索要件をほぼ無制限に対応可能
- デメリット: インフラコスト増、データ同期の遅延（数秒）、運用複雑度増

### パターン D: DynamoDB Streams + 集計テーブル

**条件**: カウント・合計・平均などの集計値が必要な場合

```
DynamoDB (在庫テーブル)
  → Streams → Lambda → DynamoDB (集計テーブル)
                          - PK: warehouseId
                          - totalItems: 1500
                          - totalQuantity: 45000
```

- メリット: リアルタイムに近い集計値を低レイテンシで取得
- デメリット: 集計ロジックの実装・テストが複雑、Streams の処理失敗時のリカバリ

### パターン E: クライアントサイドフィルタ

**条件**: 1 ページ内のデータ量が少なく（数十件）、UX 優先の場合

```typescript
// フロントエンド側
const filtered = items.filter(item =>
  item.productName.includes(searchKeyword) &&
  item.quantity >= minQuantity
);
```

- メリット: 実装が最も簡単、バックエンド変更不要
- デメリット: 全件取得が前提、大量データでは非現実的

### パターン F: S3 + Athena

**条件**: アドホック分析・レポーティング（バッチ処理許容）

```
DynamoDB → Export to S3 (Parquet) → Athena (SQL クエリ)
```

- メリット: 標準 SQL で自由にクエリ、大規模データ対応
- デメリット: リアルタイム性なし（Export は数分〜数時間）、インタラクティブ UI には不向き

---

## 6. 本プロジェクト（Kiro Roasters 在庫管理）での実例

### 現在の設計

本プロジェクトでは 2 つのテーブル設計を比較検証している:

**Bad Table（ホットスポット発生設計）:**
```
PK = warehouseId（カーディナリティ 3: tokyo, osaka, fukuoka）
SK = itemId
```

**Good Table（分散設計）:**
```
PK = itemId（カーディナリティ 5,000）
SK = warehouseId
GSI byWarehouse: PK = warehouseId, SK = itemId
```

現在の検索は `warehouseId` を指定した Query のみ:

```typescript
// handler.ts での実装
const params: QueryCommandInput = {
  TableName: GOOD_TABLE_NAME,
  IndexName: 'byWarehouse',
  KeyConditionExpression: 'warehouseId = :wh',
  ExpressionAttributeValues: { ':wh': { S: warehouseId } },
  Limit: 20,
  ExclusiveStartKey: exclusiveStartKey,
};
```

### 検索条件追加の要望に対するトレードオフ分析

#### 商品名の曖昧検索

> 「キリマンジャロ」で商品を絞り込みたい

| 方式 | 実現性 | コスト | 備考 |
|------|--------|--------|------|
| FilterExpression (`contains`) | △ | 低〜中 | PK 内のデータ数が少なければ実用的。1 倉庫 5,000 件なら全件読み取り |
| OpenSearch 連携 | ○ | 高 | 日本語形態素解析も対応可能。検索要件が今後も増えるなら投資価値あり |
| クライアントサイド | △ | 低 | 1 ページ分（20 件）のみの絞り込みなら OK |

#### 数量の範囲検索

> 「在庫 10 個以下の商品を表示」

| 方式 | 実現性 | コスト | 備考 |
|------|--------|--------|------|
| FilterExpression | △ | 低 | `Limit: 20` + FilterExpression → 結果が 0〜20 件で不安定 |
| GSI（SK=quantity） | ○ | 中 | `quantity BETWEEN :min AND :max` で安定取得。ただし GSI 追加 |
| Streams + 集計テーブル | ○ | 中 | 「在庫切れアラート一覧」等の固定パターンなら有効 |

#### 商品 ID の前方一致

> 「ETH-」で始まる商品（エチオピア産）を一覧」

| 方式 | 実現性 | コスト | 備考 |
|------|--------|--------|------|
| Bad Table の SK `begins_with` | ○ | 低 | `begins_with(itemId, 'ETH-')` — PK 内で直接使える |
| Good Table の GSI byWarehouse SK | ○ | 低 | GSI の SK が itemId なので同様に対応可 |

### 結論

現時点では FilterExpression + クライアントサイドフィルタの組み合わせで対応可能だが、以下の条件を満たす場合は OpenSearch Service との組み合わせが現実的:

1. 部分一致検索が主要ユースケースとして要求される
2. 複数条件の AND/OR を自由に組み合わせたい
3. 日本語の全文検索（形態素解析）が必要
4. 安定したページサイズ（常に N 件返す）が求められる

---

## 7. 設計指針まとめ

### DynamoDB を使うときの心構え

1. **DynamoDB は「検索エンジン」ではなく「高速 Key-Value ストア」**
   - キーを指定して取得する（GetItem, Query）のが本来の使い方
   - 「何でも検索できる」ことを期待してはいけない

2. **アクセスパターンを先に設計し、テーブル設計に反映する**
   - 「後から検索条件を追加」は DynamoDB では高コスト
   - シングルテーブルデザイン: すべてのアクセスパターンを 1 テーブル + GSI で表現する設計思想

3. **「何でも検索できる」は RDS の強み**
   - DynamoDB に同じことを求めると、複雑なアーキテクチャが必要になる
   - 要件を正直に評価し、RDS が適切なら RDS を選ぶ

### フルサーバレスで検索が主要ユースケースの場合

| 選択肢 | 特徴 |
|--------|------|
| **DynamoDB + OpenSearch Serverless** | DynamoDB の書き込みスケーラビリティ + OpenSearch の検索柔軟性。コスト高め |
| **Aurora Serverless v2 + Data API** | SQL の柔軟性をサーバレスで享受。コールドスタートあり（数秒）。VPC 必要 |
| **DynamoDB 単体** | アクセスパターンが固定的で、検索が限定的なら最適。検索要件が拡大すると辛い |

### 判断フローチャート

```
検索要件を分析
  │
  ├─ アクセスパターンが 5 個以下 → DynamoDB + GSI で十分
  │
  ├─ 部分一致・全文検索が必須 → DynamoDB + OpenSearch
  │
  ├─ アドホッククエリ・複雑な集計 → Aurora Serverless v2
  │
  └─ 全部必要 → Aurora Serverless v2（検索主体ならこちらがシンプル）
```

### 本プロジェクトの現在地

Kiro Roasters 在庫管理 PoC は DynamoDB のパーティション設計を学ぶ目的で構築されている。現時点では `warehouseId` 指定の Query + ページネーションで要件を満たしているが、検索要件が業務アプリとして拡大する場合は:

- **短期**: FilterExpression の追加（PK 内データが少ない前提）
- **中期**: OpenSearch Serverless との連携（全文検索・複合条件）
- **長期**: 検索が中心の機能なら Aurora Serverless v2 + Data API への移行も選択肢

---

## 8. 参考リンク

- [DynamoDB Best Practices](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/best-practices.html)
- [DynamoDB パーティションキーの設計](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html)
- [GSI のマルチ属性キースキーマ](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html)
- [Multi-key support for Global Secondary Index in Amazon DynamoDB (AWS Database Blog)](https://aws.amazon.com/blogs/database/multi-key-support-for-global-secondary-index-in-amazon-dynamodb)
- [Single Table Design](https://www.alexdebrie.com/posts/dynamodb-single-table/)
- [DynamoDB + OpenSearch 統合](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/OpenSearch.html)
- [Aurora Serverless v2](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.html)
- [Aurora Data API](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.html)
- [OpenSearch Serverless](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless.html)
- [DynamoDB Streams と OpenSearch の連携パターン](https://aws.amazon.com/blogs/database/indexing-amazon-dynamodb-content-with-amazon-opensearch-service-using-aws-lambda/)
