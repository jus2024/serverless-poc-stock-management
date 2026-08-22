"use client";

import { useCallback, useEffect, useState } from "react";
import type { Table, OnlineImpactTestResponse } from "@/src/lib/inventory/types";
import BrandIcon from "@/src/components/common/BrandIcon";
import InventoryListView from "./InventoryListView";
import LoadTestPanel from "./LoadTestPanel";
import OnlineImpactPanel from "./OnlineImpactPanel";
import OnlineImpactComparison from "./OnlineImpactComparison";
import SearchComparisonView from "./SearchComparisonView";
import VectorSearchComparisonView from "./VectorSearchComparisonView";
import styles from "./InventoryDashboard.module.css";

type Tab = "inventory" | "loadtest" | "results" | "search" | "vectorSearch";

/** オンライン影響テスト結果の localStorage キー */
const IMPACT_RESULTS_STORAGE_KEY = "kiro-online-impact-results";

const tabs: { key: Tab; label: string }[] = [
  { key: "inventory", label: "在庫管理" },
  { key: "loadtest", label: "負荷テスト" },
  { key: "results", label: "結果ダッシュボード" },
  { key: "search", label: "検索比較" },
  { key: "vectorSearch", label: "ベクトル検索比較" },
];

export default function InventoryDashboard() {
  const [activeTab, setActiveTab] = useState<Tab>("inventory");
  const table: Table = "good";
  const [impactResults, setImpactResults] = useState<OnlineImpactTestResponse[]>([]);
  const [restored, setRestored] = useState(false);

  // 初回マウント時に localStorage から復元（SSR 対策で useEffect 内で読む）
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(IMPACT_RESULTS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setImpactResults(parsed as OnlineImpactTestResponse[]);
        }
      }
    } catch {
      // パース失敗時は空配列のまま
    }
    setRestored(true);
  }, []);

  // 結果が変化したら localStorage に保存（復元完了後のみ）
  useEffect(() => {
    if (!restored) return;
    try {
      window.localStorage.setItem(
        IMPACT_RESULTS_STORAGE_KEY,
        JSON.stringify(impactResults)
      );
    } catch {
      // 容量超過の可能性があるため、requests を落とした軽量版で再試行
      try {
        const light = impactResults.map((r) => ({ ...r, requests: [] }));
        window.localStorage.setItem(
          IMPACT_RESULTS_STORAGE_KEY,
          JSON.stringify(light)
        );
      } catch {
        console.warn("オンライン影響テスト結果の保存に失敗しました（localStorage 容量超過の可能性）");
      }
    }
  }, [impactResults, restored]);

  const handleImpactResult = useCallback((result: OnlineImpactTestResponse) => {
    setImpactResults((prev) => [...prev, result]);
  }, []);

  const handleClearImpactResults = useCallback(() => {
    setImpactResults([]);
    try {
      window.localStorage.removeItem(IMPACT_RESULTS_STORAGE_KEY);
    } catch {
      console.warn("オンライン影響テスト結果の削除に失敗しました");
    }
  }, []);

  return (
    <div className={styles.container}>
      {/* Header Bar */}
      <header className={styles.header}>
        <div className={styles.headerBrand}>
          <BrandIcon size={20} />
          <span>Kiro Roasters</span>
        </div>
        <h1 className={styles.headerTitle}>在庫管理システム</h1>
      </header>

      {/* Tab Navigation */}
      <nav className={styles.tabs} role="tablist" aria-label="メインナビゲーション">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            role="tab"
            aria-selected={activeTab === tab.key}
            aria-controls={`panel-${tab.key}`}
            className={`${styles.tab} ${activeTab === tab.key ? styles.tabActive : ""}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Content Area */}
      <main className={styles.content}>
        <div
          id="panel-inventory"
          role="tabpanel"
          aria-labelledby="tab-inventory"
          hidden={activeTab !== "inventory"}
        >
          {activeTab === "inventory" && <InventoryListView table={table} />}
        </div>
        <div
          id="panel-loadtest"
          role="tabpanel"
          aria-labelledby="tab-loadtest"
          hidden={activeTab !== "loadtest"}
        >
          {activeTab === "loadtest" && (
            <div className={styles.loadTestSections}>
              <LoadTestPanel />
              <hr className={styles.sectionDivider} />
              <OnlineImpactPanel onResult={handleImpactResult} />
            </div>
          )}
        </div>
        <div
          id="panel-results"
          role="tabpanel"
          aria-labelledby="tab-results"
          hidden={activeTab !== "results"}
        >
          {activeTab === "results" && (
            <OnlineImpactComparison
              results={impactResults}
              onClear={handleClearImpactResults}
            />
          )}
        </div>
        <div
          id="panel-search"
          role="tabpanel"
          aria-labelledby="tab-search"
          hidden={activeTab !== "search"}
        >
          {activeTab === "search" && <SearchComparisonView />}
        </div>
        <div
          id="panel-vectorSearch"
          role="tabpanel"
          aria-labelledby="tab-vectorSearch"
          hidden={activeTab !== "vectorSearch"}
        >
          {activeTab === "vectorSearch" && <VectorSearchComparisonView />}
        </div>
      </main>
    </div>
  );
}
