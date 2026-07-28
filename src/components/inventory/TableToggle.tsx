"use client";

import type { Table } from "@/src/lib/inventory/types";
import styles from "./TableToggle.module.css";

interface TableToggleProps {
  value: Table;
  onChange: (table: Table) => void;
}

const OPTIONS: { value: Table; label: string; title: string; isBad: boolean }[] = [
  { value: "bad", label: "Bad", title: "PK=warehouseId / GSI なし / プロビジョンド", isBad: true },
  { value: "good", label: "Good", title: "PK=itemId / GSI なし / プロビジョンド（一覧は Scan）", isBad: false },
  { value: "goodGsi", label: "Good+GSI", title: "PK=itemId / GSI 3本 / プロビジョンド", isBad: false },
  { value: "badOnDemand", label: "Bad+OD", title: "PK=warehouseId / GSI なし / オンデマンド", isBad: true },
];

export default function TableToggle({ value, onChange }: TableToggleProps) {
  return (
    <div className={styles.toggle}>
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`${styles.option} ${
            value === opt.value
              ? opt.isBad
                ? styles.optionBadActive
                : styles.optionActive
              : ""
          }`}
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          title={opt.title}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
