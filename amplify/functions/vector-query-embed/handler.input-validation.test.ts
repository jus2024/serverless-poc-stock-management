/**
 * Query_Embedding_Lambda の入力検証応答の固定（task 18.2）
 *
 * task 18.2 は `errors.ts` の分類経路から `INVALID_QUERY` / `QUERY_TOO_LONG` を外す。
 * これらのコードは**ハンドラ側の入力検証だけが付与する**という規則に変えるため、
 * **実際に空クエリ・上限超過・未対応言語を渡したときの応答が変わっていないこと**を
 * 本ファイルで固定する（要件 10.6 / 10.7 / 10.9）。
 *
 * 応答本文を丸ごと突き合わせるので、エラーコード・説明文・再試行可否・段階識別子の
 * いずれかが変わったら落ちる。分類経路の是正が入力検証の応答へ波及していないことの証拠になる。
 *
 * ## モックの境界
 *
 * AWS へは一切接続しない。差し替えるのは SDK クライアント 2 つだけで、`errors.ts` と
 * `embedding-text.ts` は素のまま動かす。入力検証はいずれも Bedrock 呼び出しより前に返るため、
 * **Bedrock 呼び出し回数 0** も同時に観測する。
 *
 * 要件: 10.6, 10.7, 10.9, 16.10, 16.11
 * 設計: Error Handling / 分類の実装
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

/** モックとテスト本体で共有する記録簿。`vi.mock` のファクトリより先に評価される */
const recorder = vi.hoisted(() => ({
  invokeModelCalls: 0,
  putItemCalls: 0,
}));

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class InvokeModelCommand {
    constructor(readonly input: unknown) {}
  }

  class BedrockRuntimeClient {
    async send(): Promise<never> {
      recorder.invokeModelCalls += 1;
      // 入力検証で返る経路のみを対象にするため、ここへ到達したら失敗させる
      throw new Error('Bedrock must not be called for input validation failures');
    }
  }

  return { BedrockRuntimeClient, InvokeModelCommand };
});

vi.mock('@aws-sdk/client-dynamodb', () => {
  class PutItemCommand {
    constructor(readonly input: unknown) {}
  }

  class DynamoDBClient {
    async send(): Promise<Record<string, never>> {
      recorder.putItemCalls += 1;
      return {};
    }
  }

  return { DynamoDBClient, PutItemCommand };
});

const DIMENSIONS = 256;

process.env.AWS_REGION = 'ap-northeast-1';
process.env.QUERY_CACHE_TABLE_NAME = 'test-vector-query-cache';
process.env.VECTOR_EMBEDDING_DIMENSIONS = String(DIMENSIONS);

let handler: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;

beforeAll(async () => {
  ({ handler } = await import('./handler'));
});

beforeEach(() => {
  recorder.invokeModelCalls = 0;
  recorder.putItemCalls = 0;
});

function embedEvent(payload: unknown): APIGatewayProxyEvent {
  return { body: JSON.stringify(payload), isBase64Encoded: false } as unknown as APIGatewayProxyEvent;
}

describe('vector-query-embed handler / 入力検証応答の固定（task 18.2 の非波及）', () => {
  // 要件 10.6: 空文字・空白のみ。分類経路の是正前と同一の応答であること
  it('空クエリの応答が変わっていない（INVALID_QUERY と定型文をそのまま返す）', async () => {
    // 空文字、半角スペース、全角スペース、タブ、改行、混在。いずれも同一の応答になる
    for (const query of ['', ' ', '   ', '\u3000', '\t', '\n', ' \t\u3000\n ']) {
      const result = await handler(embedEvent({ query, language: 'ja' }));

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body)).toEqual({
        stage: 'EMBEDDING',
        errorCode: 'INVALID_QUERY',
        message:
          'クエリ文字列が空、または空白文字のみです。 クエリ文字列を 1 文字以上（空白文字以外を含む形で）指定してください。',
        retryable: false,
      });
    }

    // 入力検証は Bedrock 呼び出しより前に完了する
    expect(recorder.invokeModelCalls).toBe(0);
    expect(recorder.putItemCalls).toBe(0);
  });

  // 要件 10.9: 前処理後 1,000 文字超過。分類経路の是正前と同一の応答であること
  it('上限文字数超過の応答が変わっていない（QUERY_TOO_LONG と定型文をそのまま返す）', async () => {
    const result = await handler(embedEvent({ query: 'a'.repeat(1_001), language: 'en' }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      stage: 'EMBEDDING',
      errorCode: 'QUERY_TOO_LONG',
      message:
        'クエリ文字列が上限文字数を超えています。 上限 1000 文字に対して前処理後 1001 文字です。切り詰めは行いません。',
      retryable: false,
    });

    expect(recorder.invokeModelCalls).toBe(0);
    expect(recorder.putItemCalls).toBe(0);
  });

  // 要件 10.7: ja / en 以外。分類経路の是正の対象外だが、同じ入力検証の並びにあるため併せて固定する
  it('未対応言語の応答が変わっていない（INVALID_LANGUAGE と許容値の一覧を返す）', async () => {
    const result = await handler(embedEvent({ query: 'コーヒー豆', language: 'fr' }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      stage: 'EMBEDDING',
      errorCode: 'INVALID_LANGUAGE',
      message: '検索言語は ja または en のみを受け付けます。 許容値: ja / en。',
      retryable: false,
    });

    expect(recorder.invokeModelCalls).toBe(0);
    expect(recorder.putItemCalls).toBe(0);
  });
});
