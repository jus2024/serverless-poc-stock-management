# Design Document

## Architecture Overview

本設計は、既存の InventoryDashboard に「テーブル切替トグル」と「在庫一覧ビュー」を追加し、バックエンドに倉庫別在庫一覧 API を新設する。設計方針は B案に基づく。

### システム構成

```
┌─────────────────────────────────────────────────────────────────┐
│ InventoryDashboard                                               │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Header: "在庫管理システム"  ───────────── [TableToggle: Good|Bad] │ │
│ └─────────────────────────────────────────────────────────────┘ │
│ ┌───────────┬───────────┬─────────────────┐                     │
│ │ 在庫管理   │ 負荷テスト │ 結果ダッシュボード │ (tabs)               │
│ └───────────┴───────────┴─────────────────┘                     │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Tab 1: InventoryListView(table=toggleState)                  │ │
│ │ Tab 2: LoadTestPanel (既存・変更なし)                          │ │
│ │ Tab 3: ResultsDashboard (既存・変更なし)                       │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼ listInventory / queryInventory / shipInventory
┌─────────────────────────────────────┐
│ API Client (src/lib/inventory/api.ts) │
└──────────────┬──────────────────────┘
               │ GET /inventory/{warehouseId}?table=good|bad&nextToken=...
               │ GET /inventory/{warehouseId}/{itemId}?table=good|bad
               │ POST /inventory/ship
               ▼
┌───────────────────────────────────────────┐
│ API Gateway (/inventory/{warehouseId})     │
└──────────────┬────────────────────────────┘
               ▼
┌───────────────────────────────────────────┐
│ inventory-query Lambda                     │
│ - itemId あり: GetItem (既存ロジック)        │
│ - itemId なし: Query (新規一覧ロジック)      │
│   - table=good → Good_Table GSI byWarehouse │
│   - table=bad  → Bad_Table PK=warehouseId   │
└──────────────┬────────────────────────────┘
               ▼
┌──────────────────────┐  ┌──────────────────────┐
│ Good_Table            │  │ Bad_Table             │
│ PK=itemId, SK=wh      │  │ PK=warehouseId,       │
│ GSI byWarehouse:      │  │ SK=itemId             │
│  PK=warehouseId       │  │ (GSI なし)            │
│  SK=itemId            │  │                       │
└──────────────────────┘  └──────────────────────┘
```

### データフロー

1. ユーザーが TableToggle を切り替える → Dashboard state (`table`) が更新される
2. InventoryListView が `table` prop の変更を検知 → アイテムリストをリセット＆再取得
3. API Client が `GET /inventory/{warehouseId}?table={value}` を送信
4. Lambda が `table` パラメータに基づきテーブル/GSI を選択し Query 実行
5. レスポンスの `items` と `nextToken` をフロントエンドに返却
6. InventoryListView がテーブル表示を更新

---

## Components

### フロントエンドコンポーネント

#### TableToggle

ヘッダー右端に配置する Good/Bad テーブル切替トグル。

```typescript
// src/components/inventory/TableToggle.tsx
import type { Table } from "@/src/lib/inventory/types";

interface TableToggleProps {
  value: Table;
  onChange: (table: Table) => void;
}

export default function TableToggle({ value, onChange }: TableToggleProps) {
  // セグメントコントロール形式
  // value === "bad" のとき赤系のインジケータ表示
}
```

**スタイル仕様:**
- コンパクトなセグメントコントロール（Good | Bad）
- デフォルト: "Good" が選択状態
- "Bad" 選択時: 赤系背景色でインジケータ表示（`#dc2626` 系）
- CSS Modules: `TableToggle.module.css`

#### InventoryListView

Tab 1 に表示される統合在庫管理コンポーネント。一覧表示・個別照会・出庫処理の 3 セクションを含む。

```typescript
// src/components/inventory/InventoryListView.tsx
import type { Table } from "@/src/lib/inventory/types";

interface InventoryListViewProps {
  table: Table;
}

export default function InventoryListView({ table }: InventoryListViewProps) {
  // table prop が変わったら items をリセットして再取得
  // 3 セクション: 在庫一覧、個別照会、出庫処理
}
```

**内部構成:**
- 在庫一覧セクション: 倉庫セレクター + 検索ボタン + InventoryTable
- 個別照会セクション: itemId 入力 + 照会ボタン + 結果表示
- 出庫処理セクション: warehouseId/itemId/quantity 入力 + 出庫ボタン + 結果表示

#### InventoryTable

在庫一覧をテーブル形式で表示するサブコンポーネント。

```typescript
// src/components/inventory/InventoryTable.tsx
import type { InventoryRecord } from "@/src/lib/inventory/types";

interface InventoryTableProps {
  items: InventoryRecord[];
  nextToken: string | null;
  onLoadMore: () => void;
  loading: boolean;
}

export default function InventoryTable({
  items,
  nextToken,
  onLoadMore,
  loading,
}: InventoryTableProps) {
  // テーブルヘッダー: itemId, itemName, quantity, lotNumber, location, unitPrice, lastUpdated
  // nextToken が存在する場合のみ「次のページ」ボタン表示
}
```

#### InventoryDashboard (変更)

既存コンポーネントへの変更:
- ヘッダータイトル: "在庫管理検証システム" → "在庫管理システム"
- タブラベル: "在庫照会" → "在庫管理"
- `table` state を追加し、TableToggle と InventoryListView に渡す
- Tab 1 のコンテンツを InventoryQueryPanel → InventoryListView に変更

```typescript
// src/components/inventory/InventoryDashboard.tsx (変更後)
export default function InventoryDashboard() {
  const [activeTab, setActiveTab] = useState<Tab>("inventory");
  const [table, setTable] = useState<Table>("good"); // 新規: トグル state

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerBrand}>☕ Kiro Roasters</div>
        <h1 className={styles.headerTitle}>在庫管理システム</h1>
        <TableToggle value={table} onChange={setTable} /> {/* 新規 */}
      </header>
      {/* tabs: "在庫管理" | "負荷テスト" | "結果ダッシュボード" */}
      <main>
        {activeTab === "inventory" && <InventoryListView table={table} />}
        {activeTab === "loadtest" && <LoadTestPanel />}
        {activeTab === "results" && <ResultsDashboard />}
      </main>
    </div>
  );
}
```

### バックエンドコンポーネント

#### inventory-query Lambda (変更)

既存の GetItem ロジックに加え、倉庫別一覧取得（Query）ロジックを追加する。

**ルーティング判定:**
- `pathParameters.itemId` が存在する → 既存の GetItem ロジック
- `pathParameters.itemId` が存在しない → 新規の Query ロジック

```typescript
// amplify/functions/inventory-query/handler.ts (変更後の疑似コード)
export const handler = async (event: APIGatewayProxyEvent) => {
  const warehouseId = event.pathParameters?.warehouseId;
  const itemId = event.pathParameters?.itemId;
  const table = event.queryStringParameters?.table ?? "good";
  const nextToken = event.queryStringParameters?.nextToken;

  if (!warehouseId) return errorResponse(400, "INVALID_PARAMETERS", "...");

  if (itemId) {
    // 既存ロジック: GetItem
    return handleGetItem(warehouseId, itemId, table);
  } else {
    // 新規ロジック: Query (一覧取得)
    return handleListInventory(warehouseId, table, nextToken);
  }
};
```

**handleListInventory ロジック:**

```typescript
async function handleListInventory(
  warehouseId: string,
  table: "bad" | "good",
  nextToken?: string
): Promise<APIGatewayProxyResult> {
  // nextToken のデコード
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;
  if (nextToken) {
    try {
      const decoded = Buffer.from(nextToken, "base64url").toString("utf-8");
      exclusiveStartKey = JSON.parse(decoded);
    } catch {
      return errorResponse(400, "INVALID_TOKEN", "nextToken が不正です");
    }
  }

  // テーブル/インデックス選択
  const params: QueryCommandInput =
    table === "good"
      ? {
          TableName: GOOD_TABLE_NAME,
          IndexName: "byWarehouse",
          KeyConditionExpression: "warehouseId = :wh",
          ExpressionAttributeValues: { ":wh": { S: warehouseId } },
          Limit: 50,
          ExclusiveStartKey: exclusiveStartKey,
        }
      : {
          TableName: BAD_TABLE_NAME,
          KeyConditionExpression: "warehouseId = :wh",
          ExpressionAttributeValues: { ":wh": { S: warehouseId } },
          Limit: 50,
          ExclusiveStartKey: exclusiveStartKey,
        };

  const result = await client.send(new QueryCommand(params));

  // レスポンス構築
  const items = (result.Items ?? []).map((item) => unmarshall(item));
  const responseNextToken = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64url")
    : null;

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ items, nextToken: responseNextToken }),
  };
}
```

#### API Gateway (変更)

新規リソース追加:
- `GET /inventory/{warehouseId}` → inventory-query Lambda（itemId なしパス）

```typescript
// amplify/custom/api-gateway.ts (追加部分)
// 既存: GET /inventory/{warehouseId}/{itemId}
// 追加: GET /inventory/{warehouseId} (一覧取得用)
warehouseId.addMethod("GET", queryIntegration);
```

---

## Interfaces

### API エンドポイント

#### GET /inventory/{warehouseId}

倉庫別在庫一覧を取得する。

**パスパラメータ:**
| パラメータ | 型 | 必須 | 説明 |
|---|---|---|---|
| warehouseId | string | Yes | 倉庫 ID (WH-TOKYO, WH-OSAKA, WH-FUKUOKA) |

**クエリパラメータ:**
| パラメータ | 型 | 必須 | デフォルト | 説明 |
|---|---|---|---|---|
| table | "good" \| "bad" | No | "good" | 対象テーブル |
| nextToken | string | No | - | ページネーショントークン (base64url) |

**成功レスポンス (200):**
```json
{
  "items": [
    {
      "warehouseId": "WH-TOKYO",
      "itemId": "ITEM#ETH-YIRG-G1-MEDIUM-200G",
      "itemName": "エチオピア イルガチェフェ G1 中挽き 200g",
      "quantity": 150,
      "lotNumber": "LOT-2024-001",
      "location": "A-03-02",
      "unitPrice": 2800,
      "lastUpdated": "2024-12-01T10:30:00Z"
    }
  ],
  "nextToken": "eyJ3YXJlaG91c2VJZCI6..." // or null
}
```

**エラーレスポンス:**
| Status | error | 条件 |
|---|---|---|
| 400 | INVALID_PARAMETERS | warehouseId 未指定 |
| 400 | INVALID_TABLE | table が "good"/"bad" 以外 |
| 400 | INVALID_TOKEN | nextToken のデコード失敗 |
| 500 | THROTTLED | DynamoDB スロットリング |
| 500 | INTERNAL_ERROR | その他のエラー |

### API Client インターフェース

```typescript
// src/lib/inventory/api.ts に追加

/**
 * 在庫一覧レスポンス型
 */
export interface ListInventoryResponse {
  items: InventoryRecord[];
  nextToken: string | null;
}

/**
 * 倉庫別在庫一覧取得
 */
export async function listInventory(
  warehouseId: string,
  table: Table,
  nextToken?: string
): Promise<ListInventoryResponse> {
  const baseUrl = getBaseUrl();
  const params = new URLSearchParams({ table });
  if (nextToken) params.set("nextToken", nextToken);
  const url = `${baseUrl}/inventory/${encodeURIComponent(warehouseId)}?${params.toString()}`;

  const response = await fetch(url);
  if (!response.ok) {
    await handleErrorResponse(response);
  }
  return response.json();
}
```

### コンポーネント Props インターフェース

```typescript
// TableToggle
interface TableToggleProps {
  value: Table;
  onChange: (table: Table) => void;
}

// InventoryListView
interface InventoryListViewProps {
  table: Table;
}

// InventoryTable
interface InventoryTableProps {
  items: InventoryRecord[];
  nextToken: string | null;
  onLoadMore: () => void;
  loading: boolean;
}
```

---

## Data Models

### 既存型の再利用

`src/lib/inventory/types.ts` に定義済みの型をそのまま使用:
- `Table`: `"bad" | "good"`
- `Warehouse`: `"WH-TOKYO" | "WH-OSAKA" | "WH-FUKUOKA"`
- `InventoryRecord`: 在庫レコード
- `ErrorResponse`: エラーレスポンス

### 新規型追加

```typescript
// src/lib/inventory/types.ts に追加

/** 在庫一覧レスポンス */
export interface ListInventoryResponse {
  items: InventoryRecord[];
  nextToken: string | null;
}
```

### DynamoDB アクセスパターン

| 操作 | table=good | table=bad |
|---|---|---|
| 一覧取得 | Query GSI `byWarehouse` (PK=warehouseId) | Query テーブル (PK=warehouseId) |
| 個別取得 | GetItem (PK=itemId, SK=warehouseId) | GetItem (PK=warehouseId, SK=itemId) |

---

## Error Handling

### フロントエンド

| エラー種別 | 表示方法 |
|---|---|
| THROTTLED | 赤色アラートで「DynamoDB スロットリング発生」メッセージを表示 |
| NOT_FOUND | 黄色注意で「アイテムが見つかりません」メッセージを表示 |
| INVALID_PARAMETERS | フォームバリデーションで事前防止 |
| INTERNAL_ERROR | 赤色アラートでエラーメッセージを表示 |
| ネットワークエラー | 赤色アラートで接続失敗メッセージを表示 |

### バックエンド

| 例外 | レスポンス |
|---|---|
| ProvisionedThroughputExceededException | 500 / THROTTLED |
| base64url デコード失敗 | 400 / INVALID_TOKEN |
| JSON パース失敗 (nextToken) | 400 / INVALID_TOKEN |
| パラメータ不正 | 400 / INVALID_PARAMETERS or INVALID_TABLE |
| その他 | 500 / INTERNAL_ERROR |

---

## State Management

### Dashboard レベル State

```typescript
// InventoryDashboard
const [activeTab, setActiveTab] = useState<Tab>("inventory");
const [table, setTable] = useState<Table>("good");
```

- `table` state は Dashboard が所有し、TableToggle と InventoryListView に prop として渡す
- LoadTestPanel は自身の中に独自の Bad/Good 選択を保持（既存動作を維持）
- Dashboard の `table` state と LoadTestPanel の内部 state は独立

### InventoryListView 内部 State

```typescript
const [warehouseId, setWarehouseId] = useState<Warehouse>("WH-TOKYO");
const [items, setItems] = useState<InventoryRecord[]>([]);
const [nextToken, setNextToken] = useState<string | null>(null);
const [loading, setLoading] = useState(false);
const [error, setError] = useState<string | null>(null);
```

**table prop 変更時の動作:**
- `useEffect` で `table` の変更を監視
- 変更検知時: `items` を空配列にリセット → `nextToken` を null にリセット → 再取得実行

---

## File Structure

```
src/components/inventory/
├── InventoryDashboard.tsx          (変更)
├── InventoryDashboard.module.css   (変更: header flexbox 調整)
├── TableToggle.tsx                 (新規)
├── TableToggle.module.css          (新規)
├── InventoryListView.tsx           (新規)
├── InventoryListView.module.css    (新規)
├── InventoryTable.tsx              (新規)
├── InventoryTable.module.css       (新規)
├── InventoryQueryPanel.tsx         (既存・変更なし、Tab 1 からは除外)
├── InventoryQueryPanel.module.css  (既存)
├── LoadTestPanel.tsx               (既存・変更なし)
└── LoadTestPanel.module.css        (既存)

src/lib/inventory/
├── api.ts                          (変更: listInventory 追加)
└── types.ts                        (変更: ListInventoryResponse 追加)

amplify/functions/inventory-query/
└── handler.ts                      (変更: handleListInventory 追加)

amplify/custom/
└── api-gateway.ts                  (変更: GET /inventory/{warehouseId} 追加)
```

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Toggle state propagation to all API operations

*For any* operation (listInventory, queryInventory, shipInventory) invoked from InventoryListView, the `table` parameter passed to the API client SHALL always equal the current `table` prop value of InventoryListView.

**Validates: Requirements 3.6, 3.7, 4.2, 6.2, 7.2**

### Property 2: Inventory record display completeness

*For any* InventoryRecord returned by the API, when displayed in either the InventoryTable (list view) or the individual query result view, all required fields (itemId, itemName, quantity, lotNumber, location, unitPrice, lastUpdated) SHALL be present in the rendered output.

**Validates: Requirements 4.3, 6.3**

### Property 3: Page size invariant

*For any* list of items returned from listInventory, the number of items displayed in the InventoryTable SHALL be at most 50.

**Validates: Requirements 4.4**

### Property 4: NextToken and pagination button biconditional

*For any* listInventory API response, the "次のページ" button SHALL be visible if and only if the response's `nextToken` field is non-null.

**Validates: Requirements 5.1, 5.3**

### Property 5: Pagination token passthrough

*For any* pagination request triggered by clicking "次のページ", the `nextToken` parameter sent to listInventory SHALL equal the `nextToken` value from the immediately preceding API response.

**Validates: Requirements 5.2**

### Property 6: Lambda table routing correctness

*For any* warehouseId and table parameter, the inventory-query Lambda SHALL route to Good_Table GSI byWarehouse when table="good", and to Bad_Table with PK=warehouseId when table="bad". In both cases, the KeyConditionExpression SHALL use the provided warehouseId.

**Validates: Requirements 8.2, 8.3**

### Property 7: NextToken encoding round-trip

*For any* DynamoDB LastEvaluatedKey object, encoding it as base64url and then decoding it back SHALL produce an object equal to the original LastEvaluatedKey. Equivalently, for any nextToken in a response, passing it as a query parameter and decoding it SHALL reconstruct a valid ExclusiveStartKey.

**Validates: Requirements 8.5, 8.6**

### Property 8: Query limit invariant

*For any* Query request sent by the inventory-query Lambda (list mode), the DynamoDB `Limit` parameter SHALL always be set to 50.

**Validates: Requirements 8.4**

### Property 9: List response structure

*For any* successful response from `GET /inventory/{warehouseId}`, the response body SHALL contain an `items` field (array) and a `nextToken` field (string or null), with no other top-level fields.

**Validates: Requirements 8.7**

### Property 10: Invalid token rejection

*For any* string that is not a valid base64url-encoded JSON object, passing it as `nextToken` to the inventory-query Lambda SHALL result in a 400 response with error code "INVALID_TOKEN".

**Validates: Requirements 8.8**

### Property 11: API client URL construction

*For any* warehouseId (string), table (Table), and optional nextToken (string), calling listInventory SHALL produce a GET request to the URL `/inventory/{warehouseId}` with `table` as a query parameter and `nextToken` as a query parameter only when provided.

**Validates: Requirements 9.2**

### Property 12: Throttle error format

*For any* ProvisionedThroughputExceededException caught by the inventory-query Lambda, the response SHALL have status 500 with a body containing `error: "THROTTLED"` and a non-empty `message` field.

**Validates: Requirements 10.2**

### Property 13: Error message display

*For any* error response (THROTTLED, INTERNAL_ERROR, or other API errors) received by the InventoryListView, the error message from the response SHALL be displayed to the user in the UI.

**Validates: Requirements 7.4, 10.3**

### Property 14: Toggle reset behavior

*For any* state of InventoryListView with loaded items, when the `table` prop changes, the component SHALL clear the existing items and nextToken before initiating a new fetch with the updated table value.

**Validates: Requirements 3.6**
