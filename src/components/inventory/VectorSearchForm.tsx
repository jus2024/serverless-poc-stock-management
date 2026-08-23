"use client";

/**
 * ベクトル検索比較の検索フォーム
 *
 * 自然言語クエリ入力欄（最大 200 文字）、検索言語セレクター（「日本語」/「English」、初期
 * 選択「日本語」）、倉庫セレクター（初期「全倉庫」）、TopK 指定欄（1〜100 の整数、初期値 30）、
 * 検索ボタンを提供する（要件 11.2 / 11.3 / 11.5 / 11.7）。
 *
 * 既存 `SearchForm.tsx` と同じ構成を踏襲し、入力値は本コンポーネントが内部 state として保持し、
 * 送信時に確定値を 1 つのオブジェクトとして `onSearch` へ渡す。言語は `VectorSearchComparisonView`
 * 側で単一の state として保持され、`POST /vector-search/embed` の 1 回の呼び出しにのみ渡る。
 * 2 つの検索リクエストは `queryId` しか持たないため、片側だけ言語が変わることが起こらない（要件 11.4）。
 *
 * 検索の実行・中断・レイテンシ表示は `VectorSearchComparisonView`（task 10.6）の責務であり、
 * 本コンポーネントは API を呼ばない。実行中かどうかは `isSearching` として受け取る。
 *
 * 要件: 11.2, 11.3, 11.5, 11.6, 11.7, 11.9, 11.10
 * 設計: UI コンポーネント / 検索フォーム（言語セレクター含む）
 */

import { useState } from "react";
import type { VectorLanguage } from "@/src/lib/inventory/vector-types";
import styles from "./VectorSearchForm.module.css";

/** 自然言語クエリの最大文字数（要件 11.2） */
export const MAX_QUERY_LENGTH = 200;

/**
 * TopK の許容範囲（要件 11.5 / 11.6）。
 *
 * バックエンドの唯一の判定経路は `amplify/functions/shared/vector/topk.ts` の
 * `normalizeTopK()` だが、フロントエンドは `amplify/` から import できないため、
 * `vector-types.ts` と同じ理由で値のみを再掲する。画面側の検証は「検索を実行しない」ための
 * 前段であり、適用値の決定（101 以上の丸め等）は引き続きサーバー側が行う。
 */
export const MIN_TOP_K = 1;
export const MAX_TOP_K = 100;

/** TopK の初期値。TopK 30 は一意 SKU 約 10 件に相当する（要件 11.5、設計 TopK 初期値 30 の根拠） */
export const DEFAULT_TOP_K = 30;

/** 許容範囲を示すエラー文（要件 11.6） */
const TOP_K_ERROR_MESSAGE = `TopK は ${MIN_TOP_K}〜${MAX_TOP_K} の整数で指定してください。`;

/** 検索言語の選択肢。ja / en の 2 値のみ、初期選択は ja（要件 11.3） */
const LANGUAGES: ReadonlyArray<{ value: VectorLanguage; label: string }> = [
  { value: "ja", label: "日本語" },
  { value: "en", label: "English" },
];

/** 倉庫の選択肢。既存 `SearchForm.tsx` と同一の一覧。空文字は「全倉庫」（要件 11.7） */
const WAREHOUSES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "全倉庫" },
  { value: "WH-TOKYO", label: "WH-TOKYO（東京）" },
  { value: "WH-OSAKA", label: "WH-OSAKA（大阪）" },
  { value: "WH-FUKUOKA", label: "WH-FUKUOKA（福岡）" },
];

/** 検索実行時に確定した入力値 */
export interface VectorSearchFormValues {
  /** 生のクエリ文字列。正規化はサーバー側の `normalizeText` が唯一の経路 */
  query: string;
  /** 検索言語。埋め込み生成にのみ渡る（要件 11.4） */
  language: VectorLanguage;
  /**
   * 倉庫フィルタ。「全倉庫」を選んだ場合は undefined になり、
   * `VectorSearchRequest.warehouseId`（任意項目）へそのまま渡せる（要件 11.7 / 11.8）
   */
  warehouseId?: string;
  /** 1 以上 100 以下の整数。検証を通った値のみが渡る（要件 11.5 / 11.6） */
  topK: number;
}

interface VectorSearchFormProps {
  /** 検証を通った入力値で検索を開始する。検証に失敗した場合は呼ばれない（要件 11.6） */
  onSearch: (values: VectorSearchFormValues) => void;
  /** 検索リクエストの実行中。ボタンを操作不可にし実行中表示を出す（要件 11.10） */
  isSearching?: boolean;
}

/** TopK 入力欄の検証結果 */
type TopKValidation = { ok: true; value: number } | { ok: false; message: string };

/**
 * TopK 入力欄の文字列を検証する（要件 11.6）。
 *
 * `<input type="number">` は範囲外の値や `1e3` のような表記も文字列として渡してくるため、
 * 符号なし十進整数の表記であることを明示的に確認したうえで範囲を判定する。
 */
export function validateTopKInput(raw: string): TopKValidation {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, message: TOP_K_ERROR_MESSAGE };
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < MIN_TOP_K || value > MAX_TOP_K) {
    return { ok: false, message: TOP_K_ERROR_MESSAGE };
  }
  return { ok: true, value };
}

/**
 * クエリが空文字または空白のみか判定する（要件 11.9）。
 *
 * JavaScript の `\s` は全角スペース（U+3000）・タブ・改行を含む。
 */
export function isBlankQuery(query: string): boolean {
  return query.trim() === "";
}

export default function VectorSearchForm({ onSearch, isSearching = false }: VectorSearchFormProps) {
  const [query, setQuery] = useState("");
  const [language, setLanguage] = useState<VectorLanguage>("ja");
  const [warehouseId, setWarehouseId] = useState("");
  // TopK は「整数以外」を検出する必要があるため文字列で保持する
  const [topKInput, setTopKInput] = useState(String(DEFAULT_TOP_K));

  const topKValidation = validateTopKInput(topKInput);
  const queryBlank = isBlankQuery(query);
  // 検索ボタンの操作可否はクエリの空判定と実行中判定のみで決める（要件 11.9 / 11.10）。
  // TopK が不正な場合はボタンを押せる状態のまま検索を実行せず、エラーを表示する（要件 11.6）。
  const searchDisabled = queryBlank || isSearching;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // 実装ミスや Enter キーによる暗黙送信でも不変条件を崩さないよう、送信時に再判定する
    if (searchDisabled) return;
    if (!topKValidation.ok) return;

    onSearch({
      query,
      language,
      ...(warehouseId !== "" ? { warehouseId } : {}),
      topK: topKValidation.value,
    });
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <div className={styles.queryRow}>
        <div className={styles.queryGroup}>
          <label className={styles.label} htmlFor="vsf-query">
            検索クエリ（自然言語、最大 {MAX_QUERY_LENGTH} 文字）
          </label>
          <input
            id="vsf-query"
            type="text"
            className={styles.input}
            value={query}
            maxLength={MAX_QUERY_LENGTH}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="フルーティーで酸味のある浅煎り"
          />
          <span className={styles.counter}>
            {query.length} / {MAX_QUERY_LENGTH}
          </span>
        </div>
      </div>

      <div className={styles.controlRow}>
        <div className={styles.fieldGroup}>
          <label className={styles.label} htmlFor="vsf-language">
            検索言語
          </label>
          <select
            id="vsf-language"
            className={styles.select}
            value={language}
            onChange={(e) => setLanguage(e.target.value as VectorLanguage)}
          >
            {LANGUAGES.map((lang) => (
              <option key={lang.value} value={lang.value}>
                {lang.label}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.label} htmlFor="vsf-warehouse">
            倉庫
          </label>
          <select
            id="vsf-warehouse"
            className={styles.select}
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
          >
            {WAREHOUSES.map((wh) => (
              <option key={wh.value} value={wh.value}>
                {wh.label}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.label} htmlFor="vsf-topk">
            TopK（{MIN_TOP_K}〜{MAX_TOP_K} の整数）
          </label>
          <input
            id="vsf-topk"
            type="number"
            className={styles.input}
            value={topKInput}
            onChange={(e) => setTopKInput(e.target.value)}
            min={MIN_TOP_K}
            max={MAX_TOP_K}
            step={1}
            aria-invalid={!topKValidation.ok}
            aria-describedby={topKValidation.ok ? undefined : "vsf-topk-error"}
          />
          {!topKValidation.ok && (
            <span id="vsf-topk-error" className={styles.error} role="alert">
              {topKValidation.message}
            </span>
          )}
        </div>

        <div className={styles.spacer} />

        <div className={styles.submitGroup}>
          <button type="submit" className={styles.searchBtn} disabled={searchDisabled}>
            検索
          </button>
          {isSearching && (
            <span className={styles.status} role="status">
              検索中…
            </span>
          )}
        </div>
      </div>
    </form>
  );
}
