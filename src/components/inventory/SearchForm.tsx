"use client";

import { useState } from "react";
import styles from "./SearchForm.module.css";

export interface SearchState {
  warehouseId: string;
  itemPrefix: string;
  locationPrefix: string;
  itemName: string;
  minPrice: string;
  maxPrice: string;
  minQuantity: string;
  maxQuantity: string;
}

interface SearchFormProps {
  onSearch: (params: Partial<SearchState>) => void;
}

const WAREHOUSES = [
  { value: "", label: "全倉庫" },
  { value: "WH-TOKYO", label: "WH-TOKYO（東京）" },
  { value: "WH-OSAKA", label: "WH-OSAKA（大阪）" },
  { value: "WH-FUKUOKA", label: "WH-FUKUOKA（福岡）" },
];

const initialState: SearchState = {
  warehouseId: "",
  itemPrefix: "",
  locationPrefix: "",
  itemName: "",
  minPrice: "",
  maxPrice: "",
  minQuantity: "",
  maxQuantity: "",
};

export default function SearchForm({ onSearch }: SearchFormProps) {
  const [state, setState] = useState<SearchState>(initialState);

  function handleChange(field: keyof SearchState, value: string) {
    setState((prev) => ({ ...prev, [field]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Only pass non-empty fields
    const params: Partial<SearchState> = {};
    for (const [key, value] of Object.entries(state)) {
      if (value.trim() !== "") {
        params[key as keyof SearchState] = value.trim();
      }
    }

    onSearch(params);
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      {/* Row 1: warehouseId, itemPrefix, locationPrefix, itemName */}
      <div className={styles.row}>
        <div className={styles.fieldGroup}>
          <label className={styles.label} htmlFor="sf-warehouse">
            倉庫
          </label>
          <select
            id="sf-warehouse"
            className={styles.select}
            value={state.warehouseId}
            onChange={(e) => handleChange("warehouseId", e.target.value)}
          >
            {WAREHOUSES.map((wh) => (
              <option key={wh.value} value={wh.value}>
                {wh.label}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.label} htmlFor="sf-item-prefix">
            商品 ID（前方一致）
          </label>
          <input
            id="sf-item-prefix"
            type="text"
            className={styles.input}
            value={state.itemPrefix}
            onChange={(e) => handleChange("itemPrefix", e.target.value)}
            placeholder="ITEM#ETH-"
          />
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.label} htmlFor="sf-location-prefix">
            ロケーション（前方一致）
          </label>
          <input
            id="sf-location-prefix"
            type="text"
            className={styles.input}
            value={state.locationPrefix}
            onChange={(e) => handleChange("locationPrefix", e.target.value)}
            placeholder="A-03"
          />
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.label} htmlFor="sf-item-name">
            商品名（部分一致）
          </label>
          <input
            id="sf-item-name"
            type="text"
            className={styles.input}
            value={state.itemName}
            onChange={(e) => handleChange("itemName", e.target.value)}
            placeholder="エチオピア"
          />
        </div>
      </div>

      {/* Row 2: price range, quantity range, search button */}
      <div className={styles.row2}>
        <div className={styles.rangeGroup}>
          <span className={styles.label}>単価範囲</span>
          <div className={styles.rangeInputs}>
            <input
              type="number"
              className={styles.rangeInput}
              value={state.minPrice}
              onChange={(e) => handleChange("minPrice", e.target.value)}
              placeholder="min"
              min="0"
              aria-label="単価 最小値"
            />
            <span className={styles.rangeSeparator}>〜</span>
            <input
              type="number"
              className={styles.rangeInput}
              value={state.maxPrice}
              onChange={(e) => handleChange("maxPrice", e.target.value)}
              placeholder="max"
              min="0"
              aria-label="単価 最大値"
            />
          </div>
        </div>

        <div className={styles.rangeGroup}>
          <span className={styles.label}>数量範囲</span>
          <div className={styles.rangeInputs}>
            <input
              type="number"
              className={styles.rangeInput}
              value={state.minQuantity}
              onChange={(e) => handleChange("minQuantity", e.target.value)}
              placeholder="min"
              min="0"
              aria-label="数量 最小値"
            />
            <span className={styles.rangeSeparator}>〜</span>
            <input
              type="number"
              className={styles.rangeInput}
              value={state.maxQuantity}
              onChange={(e) => handleChange("maxQuantity", e.target.value)}
              placeholder="max"
              min="0"
              aria-label="数量 最大値"
            />
          </div>
        </div>

        <div className={styles.spacer} />

        <button type="submit" className={styles.searchBtn}>
          検索
        </button>
      </div>
    </form>
  );
}
