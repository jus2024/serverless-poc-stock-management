/**
 * Capabilities Lambda（`kiro-vector-capabilities`）
 *
 * `GET /vector-search/capabilities` の読み取り専用エンドポイント。
 * `shared/vector/constraints.ts` の `VECTOR_CAPABILITIES` を**加工せずそのまま**返す。
 *
 * 検索を 1 度も実行していない状態でも機能制約比較表と埋め込み言語の注意書きを
 * 描画できるようにするために存在する（要件 15.1 / 15.5）。画面側は TopK 上限・
 * 対応フィルタ種別・次元数上限を一切ハードコードせず、この応答と各検索応答の
 * `constraints` から取得する（要件 15.6）。したがって制約値の変更は
 * `constraints.ts` の編集だけで UI に反映される。
 *
 * AWS SDK を呼ばず、環境変数も参照しない。外部 I/O がないため定数の直列化のみを行う。
 *
 * 要件: 15.1, 15.5, 15.6
 * 設計: Capabilities Lambda / API Contract
 */

import type { APIGatewayProxyResult } from 'aws-lambda';
import { VECTOR_CAPABILITIES } from '../shared/vector/constraints';

/** CORS ヘッダー共通定義（既存ハンドラと同一の方式・同一のヘッダー構成） */
const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * 機能制約メタデータ取得ハンドラー
 *
 * GET /vector-search/capabilities
 *
 * リクエストの内容に依存しないため `event` を参照しない。
 * クエリパラメータ・パスパラメータによる分岐を持たず、常に同一の応答を返す。
 */
export const handler = async (): Promise<APIGatewayProxyResult> => {
  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify(VECTOR_CAPABILITIES),
  };
};
