/**
 * SKU 生成ロジック — Kiro Roasters 命名規則に準拠
 *
 * カテゴリ別 SKU 数:
 *   green beans:   ~32
 *   roasted beans: ~960
 *   blends:        ~1,500
 *   drip bags:     ~500
 *   materials:     ~2,008
 *   合計:          5,000
 *
 * SKU フォーマット: ITEM#{産地略称}-{品種略称}-{グレード}-{焙煎度}-{容量}
 */

export interface SkuItem {
  itemId: string; // e.g., "ITEM#ETH-YIRG-G1-MEDIUM-200G"
  itemName: string; // e.g., "エチオピア イルガチェフェ G1 ミディアム 200g"
  quantity: number; // Random 10-1000
  lotNumber: string; // e.g., "LOT#2026-05-20-001"
  location: string; // e.g., "A-03-02"
  unitPrice: number; // Price in JPY
}

// ============================================================
// Master Data Definitions
// ============================================================

/** 産地マスター */
const ORIGINS = [
  { code: 'ETH', name: 'エチオピア' },
  { code: 'BRA', name: 'ブラジル' },
  { code: 'COL', name: 'コロンビア' },
  { code: 'GTM', name: 'グアテマラ' },
  { code: 'KEN', name: 'ケニア' },
  { code: 'IDN', name: 'インドネシア' },
  { code: 'CRI', name: 'コスタリカ' },
  { code: 'TZA', name: 'タンザニア' },
] as const;

/** 品種マスター（産地に紐づかない汎用） */
const VARIETIES = [
  { code: 'YIRG', name: 'イルガチェフェ' },
  { code: 'SANT', name: 'サントス' },
  { code: 'SUP', name: 'スプレモ' },
  { code: 'SHB', name: 'SHB' },
] as const;

/** グレードマスター */
const GRADES = ['G1', 'G2', 'NY2', 'SHB'] as const;

/** 焙煎度マスター */
const ROAST_LEVELS = [
  { code: 'LIGHT', name: 'ライト' },
  { code: 'MEDIUM', name: 'ミディアム' },
  { code: 'CITY', name: 'シティ' },
  { code: 'FRENCH', name: 'フレンチ' },
  { code: 'DARK', name: 'ダーク' },
] as const;

/** 容量（焙煎豆） */
const ROASTED_SIZES = [
  { code: '200G', name: '200g' },
  { code: '500G', name: '500g' },
  { code: '1KG', name: '1kg' },
] as const;

/** ブレンド名マスター */
const BLEND_NAMES = [
  { code: 'MORNING', name: 'モーニング' },
  { code: 'CLASSIC', name: 'クラシック' },
  { code: 'PREMIUM', name: 'プレミアム' },
  { code: 'ESPRESSO', name: 'エスプレッソ' },
  { code: 'HOUSE', name: 'ハウス' },
  { code: 'SEASONAL', name: 'シーズナル' },
  { code: 'ORIGINAL', name: 'オリジナル' },
  { code: 'RICH', name: 'リッチ' },
  { code: 'MILD', name: 'マイルド' },
  { code: 'DEEP', name: 'ディープ' },
  { code: 'SMOOTH', name: 'スムース' },
  { code: 'BOLD', name: 'ボールド' },
  { code: 'FLORAL', name: 'フローラル' },
  { code: 'FRUITY', name: 'フルーティー' },
  { code: 'NUTTY', name: 'ナッティ' },
  { code: 'CHOCO', name: 'チョコレート' },
  { code: 'CARAMEL', name: 'キャラメル' },
  { code: 'SPICY', name: 'スパイシー' },
  { code: 'CITRUS', name: 'シトラス' },
  { code: 'BERRY', name: 'ベリー' },
] as const;

/** ブレンド容量 */
const BLEND_SIZES = [
  { code: '100G', name: '100g' },
  { code: '200G', name: '200g' },
  { code: '500G', name: '500g' },
] as const;

/** ドリップバッグ パック数 */
const DRIP_PACK_SIZES = [
  { code: '5P', name: '5個入' },
  { code: '10P', name: '10個入' },
  { code: '20P', name: '20個入' },
  { code: '30P', name: '30個入' },
] as const;

/** 資材タイプ */
const MATERIAL_TYPES = [
  { code: 'BAG', name: '袋' },
  { code: 'BOX', name: '箱' },
  { code: 'LABEL', name: 'ラベル' },
  { code: 'SEAL', name: 'シール' },
  { code: 'TAPE', name: 'テープ' },
  { code: 'WRAP', name: '包装紙' },
  { code: 'CUP', name: 'カップ' },
  { code: 'LID', name: 'フタ' },
  { code: 'FILTER', name: 'フィルター' },
  { code: 'TAG', name: 'タグ' },
  { code: 'RIBBON', name: 'リボン' },
  { code: 'CARD', name: 'カード' },
] as const;

/** 資材サイズ */
const MATERIAL_SIZES = [
  { code: '100G', name: '100g用' },
  { code: '200G', name: '200g用' },
  { code: '500G', name: '500g用' },
  { code: '1KG', name: '1kg用' },
  { code: 'S', name: 'S' },
  { code: 'M', name: 'M' },
  { code: 'L', name: 'L' },
  { code: 'XL', name: 'XL' },
] as const;

/** 資材素材 */
const MATERIAL_MATERIALS = [
  { code: 'KRAFT', name: 'クラフト' },
  { code: 'VALVE', name: 'バルブ付' },
  { code: 'CLEAR', name: 'クリア' },
  { code: 'ALU', name: 'アルミ' },
  { code: 'PE', name: 'ポリエチレン' },
  { code: 'PAPER', name: '紙' },
  { code: 'COTTON', name: '綿' },
] as const;

// ============================================================
// Seeded Random Number Generator (deterministic)
// ============================================================

/**
 * 簡易シード付き乱数生成器 (mulberry32)
 * テスト再現性のためシード固定
 */
function createSeededRng(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** シード固定の乱数生成器（generateSkus 呼び出し毎にリセット） */
let rng = createSeededRng(42);

/** RNG をリセット（決定的出力のため） */
function resetRng(): void {
  rng = createSeededRng(42);
}

/** 指定範囲のランダム整数 [min, max] */
function randomInt(min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

// ============================================================
// Helper Functions
// ============================================================

function generateQuantity(): number {
  return randomInt(10, 1000);
}

function generateLotNumber(index: number): string {
  const day = (index % 28) + 1;
  const seq = (index % 999) + 1;
  return `LOT#2026-05-${String(day).padStart(2, '0')}-${String(seq).padStart(3, '0')}`;
}

function generateLocation(index: number): string {
  const aisles = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const aisle = aisles[index % aisles.length];
  const rack = (index % 20) + 1;
  const shelf = (index % 5) + 1;
  return `${aisle}-${String(rack).padStart(2, '0')}-${String(shelf).padStart(2, '0')}`;
}

function generateUnitPrice(min: number, max: number): number {
  // 10 円単位で丸める
  return Math.round(randomInt(min, max) / 10) * 10;
}

// ============================================================
// Category SKU Generators
// ============================================================

/** Green Beans: ~32 SKUs (8 origins × 4 varieties = 32) */
function generateGreenBeans(): SkuItem[] {
  const items: SkuItem[] = [];
  let idx = 0;

  for (const origin of ORIGINS) {
    for (const variety of VARIETIES) {
      const itemId = `ITEM#${origin.code}-${variety.code}-RAW`;
      const itemName = `${origin.name} ${variety.name} 生豆`;
      items.push({
        itemId,
        itemName,
        quantity: generateQuantity(),
        lotNumber: generateLotNumber(idx),
        location: generateLocation(idx),
        unitPrice: generateUnitPrice(800, 3000),
      });
      idx++;
    }
  }

  return items;
}

/** Roasted Beans: ~960 SKUs (8 origins × 4 varieties × 4 grades (cycle) × 5 roasts × 3 sizes ≈ need to slice/adjust) */
function generateRoastedBeans(): SkuItem[] {
  const items: SkuItem[] = [];
  let idx = 0;
  const TARGET = 960;

  for (const origin of ORIGINS) {
    for (const variety of VARIETIES) {
      for (const roast of ROAST_LEVELS) {
        for (const size of ROASTED_SIZES) {
          if (items.length >= TARGET) break;
          // Cycle through grades based on index
          const grade = GRADES[idx % GRADES.length];
          const itemId = `ITEM#${origin.code}-${variety.code}-${grade}-${roast.code}-${size.code}`;
          const itemName = `${origin.name} ${variety.name} ${grade} ${roast.name} ${size.name}`;
          items.push({
            itemId,
            itemName,
            quantity: generateQuantity(),
            lotNumber: generateLotNumber(idx + 100),
            location: generateLocation(idx + 100),
            unitPrice: generateUnitPrice(1000, 5000),
          });
          idx++;
        }
        if (items.length >= TARGET) break;
      }
      if (items.length >= TARGET) break;
    }
    if (items.length >= TARGET) break;
  }

  // If we haven't reached the target, add numbered variants
  let variantNum = 1;
  while (items.length < TARGET) {
    const origin = ORIGINS[variantNum % ORIGINS.length];
    const variety = VARIETIES[variantNum % VARIETIES.length];
    const roast = ROAST_LEVELS[variantNum % ROAST_LEVELS.length];
    const size = ROASTED_SIZES[variantNum % ROASTED_SIZES.length];
    const grade = GRADES[variantNum % GRADES.length];
    const itemId = `ITEM#${origin.code}-${variety.code}-${grade}-${roast.code}-${size.code}-V${variantNum}`;
    const itemName = `${origin.name} ${variety.name} ${grade} ${roast.name} ${size.name} V${variantNum}`;
    items.push({
      itemId,
      itemName,
      quantity: generateQuantity(),
      lotNumber: generateLotNumber(idx + 100),
      location: generateLocation(idx + 100),
      unitPrice: generateUnitPrice(1000, 5000),
    });
    idx++;
    variantNum++;
  }

  return items;
}

/** Blends: ~1,500 SKUs (20 blends × 5 roasts × 3 sizes = 300 base, add numbered variants) */
function generateBlends(): SkuItem[] {
  const items: SkuItem[] = [];
  let idx = 0;
  const TARGET = 1500;

  // Base combinations: 20 × 5 × 3 = 300
  for (const blend of BLEND_NAMES) {
    for (const roast of ROAST_LEVELS) {
      for (const size of BLEND_SIZES) {
        const itemId = `ITEM#BLEND-${blend.code}-${roast.code}-${size.code}`;
        const itemName = `ブレンド ${blend.name} ${roast.name} ${size.name}`;
        items.push({
          itemId,
          itemName,
          quantity: generateQuantity(),
          lotNumber: generateLotNumber(idx + 1200),
          location: generateLocation(idx + 1200),
          unitPrice: generateUnitPrice(800, 3000),
        });
        idx++;
      }
    }
  }

  // Add numbered variants to reach target
  let variantNum = 1;
  while (items.length < TARGET) {
    const blend = BLEND_NAMES[variantNum % BLEND_NAMES.length];
    const roast = ROAST_LEVELS[variantNum % ROAST_LEVELS.length];
    const size = BLEND_SIZES[variantNum % BLEND_SIZES.length];
    const itemId = `ITEM#BLEND-${blend.code}-${roast.code}-${size.code}-V${variantNum}`;
    const itemName = `ブレンド ${blend.name} ${roast.name} ${size.name} V${variantNum}`;
    items.push({
      itemId,
      itemName,
      quantity: generateQuantity(),
      lotNumber: generateLotNumber(idx + 1200),
      location: generateLocation(idx + 1200),
      unitPrice: generateUnitPrice(800, 3000),
    });
    idx++;
    variantNum++;
  }

  return items;
}

/** Drip Bags: ~500 SKUs */
function generateDripBags(): SkuItem[] {
  const items: SkuItem[] = [];
  let idx = 0;
  const TARGET = 500;

  // Base: 8 origins × 4 varieties × 4 pack sizes = 128
  for (const origin of ORIGINS) {
    for (const variety of VARIETIES) {
      for (const pack of DRIP_PACK_SIZES) {
        const itemId = `ITEM#DRIP-${origin.code}-${variety.code}-${pack.code}`;
        const itemName = `ドリップバッグ ${origin.name} ${variety.name} ${pack.name}`;
        items.push({
          itemId,
          itemName,
          quantity: generateQuantity(),
          lotNumber: generateLotNumber(idx + 2800),
          location: generateLocation(idx + 2800),
          unitPrice: generateUnitPrice(300, 2000),
        });
        idx++;
      }
    }
  }

  // Add blend drip bags: 20 blends × 4 pack sizes = 80
  for (const blend of BLEND_NAMES) {
    for (const pack of DRIP_PACK_SIZES) {
      if (items.length >= TARGET) break;
      const itemId = `ITEM#DRIP-BLEND-${blend.code}-${pack.code}`;
      const itemName = `ドリップバッグ ブレンド ${blend.name} ${pack.name}`;
      items.push({
        itemId,
        itemName,
        quantity: generateQuantity(),
        lotNumber: generateLotNumber(idx + 2800),
        location: generateLocation(idx + 2800),
        unitPrice: generateUnitPrice(300, 2000),
      });
      idx++;
    }
    if (items.length >= TARGET) break;
  }

  // Add numbered variants to reach target
  let variantNum = 1;
  while (items.length < TARGET) {
    const origin = ORIGINS[variantNum % ORIGINS.length];
    const pack = DRIP_PACK_SIZES[variantNum % DRIP_PACK_SIZES.length];
    const itemId = `ITEM#DRIP-${origin.code}-MIX-${pack.code}-V${variantNum}`;
    const itemName = `ドリップバッグ ${origin.name} ミックス ${pack.name} V${variantNum}`;
    items.push({
      itemId,
      itemName,
      quantity: generateQuantity(),
      lotNumber: generateLotNumber(idx + 2800),
      location: generateLocation(idx + 2800),
      unitPrice: generateUnitPrice(300, 2000),
    });
    idx++;
    variantNum++;
  }

  return items;
}

/** Materials: ~2,008 SKUs */
function generateMaterials(): SkuItem[] {
  const items: SkuItem[] = [];
  let idx = 0;
  const TARGET = 2008;

  // Base: 12 types × 8 sizes × 7 materials = 672
  for (const type of MATERIAL_TYPES) {
    for (const size of MATERIAL_SIZES) {
      for (const material of MATERIAL_MATERIALS) {
        if (items.length >= TARGET) break;
        const itemId = `ITEM#MAT-${type.code}-${size.code}-${material.code}`;
        const itemName = `資材 ${type.name} ${size.name} ${material.name}`;
        items.push({
          itemId,
          itemName,
          quantity: generateQuantity(),
          lotNumber: generateLotNumber(idx + 3300),
          location: generateLocation(idx + 3300),
          unitPrice: generateUnitPrice(50, 500),
        });
        idx++;
      }
      if (items.length >= TARGET) break;
    }
    if (items.length >= TARGET) break;
  }

  // Add numbered variants to reach target
  let variantNum = 1;
  while (items.length < TARGET) {
    const type = MATERIAL_TYPES[variantNum % MATERIAL_TYPES.length];
    const size = MATERIAL_SIZES[variantNum % MATERIAL_SIZES.length];
    const material = MATERIAL_MATERIALS[variantNum % MATERIAL_MATERIALS.length];
    const itemId = `ITEM#MAT-${type.code}-${size.code}-${material.code}-V${variantNum}`;
    const itemName = `資材 ${type.name} ${size.name} ${material.name} V${variantNum}`;
    items.push({
      itemId,
      itemName,
      quantity: generateQuantity(),
      lotNumber: generateLotNumber(idx + 3300),
      location: generateLocation(idx + 3300),
      unitPrice: generateUnitPrice(50, 500),
    });
    idx++;
    variantNum++;
  }

  return items;
}

// ============================================================
// Main Export
// ============================================================

/**
 * 5,000 SKU を生成して返す。
 * SKU ID の生成は決定的（毎回同じ ID セット）。
 * quantity, lotNumber, location, unitPrice もシード固定で決定的。
 */
export function generateSkus(): SkuItem[] {
  // RNG をリセットして毎回同じ結果を保証
  resetRng();

  const greenBeans = generateGreenBeans();
  const roastedBeans = generateRoastedBeans();
  const blends = generateBlends();
  const dripBags = generateDripBags();
  const materials = generateMaterials();

  const allSkus = [
    ...greenBeans,
    ...roastedBeans,
    ...blends,
    ...dripBags,
    ...materials,
  ];

  // 一意性の確認（開発時のセーフティネット）
  const ids = new Set(allSkus.map((s) => s.itemId));
  if (ids.size !== allSkus.length) {
    throw new Error(
      `SKU ID duplication detected: ${allSkus.length} items, ${ids.size} unique IDs`
    );
  }

  if (allSkus.length !== 5000) {
    throw new Error(
      `Expected 5,000 SKUs, got ${allSkus.length}`
    );
  }

  return allSkus;
}

/**
 * カテゴリ別の SKU 数を返す（テスト用）
 */
export function getSkuCategoryCounts(): {
  greenBeans: number;
  roastedBeans: number;
  blends: number;
  dripBags: number;
  materials: number;
} {
  return {
    greenBeans: generateGreenBeans().length,
    roastedBeans: generateRoastedBeans().length,
    blends: generateBlends().length,
    dripBags: generateDripBags().length,
    materials: generateMaterials().length,
  };
}
