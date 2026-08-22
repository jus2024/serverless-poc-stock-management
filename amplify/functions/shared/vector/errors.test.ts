import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  INPUT_VALIDATION_ONLY_ERROR_CODES,
  MAX_ERROR_MESSAGE_LENGTH,
  VECTOR_ERROR_BASE_MESSAGES,
  VECTOR_ERROR_CODES,
  VECTOR_ERROR_RETRY_POLICY,
  VECTOR_ERROR_STAGES,
  classifyError,
  dimensionMismatchError,
  isRetryableErrorCode,
  queryExpiredError,
  toClientError,
  type VectorErrorCode,
  type VectorErrorResponse,
} from './errors';

/**
 * エラー分類と情報漏洩防止の property テスト（task 3.10）。
 *
 * 下位サービス（Bedrock / DynamoDB / OpenSearch）は呼ばない。分類対象は
 * 例外インスタンス・非例外オブジェクト・プリミティブ・getter が例外を投げる値・
 * 循環参照を含む値で構成する。
 */

/** 応答に載せてよいプロパティ。これ以外が現れたら情報漏洩とみなす（要件 16.9） */
const ALLOWED_RESPONSE_KEYS = ['stage', 'errorCode', 'message', 'retryable', 'retryAfterSeconds'];

/** 再試行可のコード。方針表と一致することを検証する（要件 4.7 / 16.7） */
const RETRYABLE_CODES: readonly VectorErrorCode[] = [
  'THROTTLED',
  'INDEX_BUILDING',
  'QUERY_EXPIRED',
  'OPENSEARCH_TIMEOUT',
];

const stageArb = fc.constantFrom(...VECTOR_ERROR_STAGES);

/** 既知・未知の例外名（SDK の `__type` 形式を含む） */
const errorNameArb = fc.constantFrom(
  'ThrottlingException',
  'ProvisionedThroughputExceededException',
  'AccessDeniedException',
  'ExpiredTokenException',
  'ResourceNotFoundException',
  'ResourceInUseException',
  'ValidationException',
  'TimeoutError',
  'index_not_found_exception',
  'InternalServerError',
  'com.amazonaws.dynamodb#ThrottlingException',
  'SomeUnknownExceptionName',
  'Error'
);

/** 下位サービスが返しうるメッセージ */
const errorMessageArb = fc.oneof(
  fc.constantFrom(
    'dimension mismatch',
    'top_k must be less than or equal to 100',
    'range filter is not supported',
    'index_not_found_exception: no such index',
    'Backfilling is in progress',
    'data access policy denies aoss:APIAccessAll',
    'Access denied',
    'request timed out',
    'Rate exceeded',
    'queryId is not found in cache',
    'unsupported language',
    'input text is too long',
    'query is empty',
    'something went wrong',
    ''
  ),
  fc.string({ maxLength: 40 })
);

const httpStatusArb = fc.oneof(
  fc.constantFrom(undefined, 400, 401, 403, 404, 408, 409, 410, 422, 429, 500, 503, 504, 524),
  fc.integer({ min: 100, max: 599 })
);

/** getter が例外を投げるオブジェクト */
function createHostileError(): unknown {
  return {
    get name(): string {
      throw new Error('name getter exploded');
    },
    get message(): string {
      throw new Error('message getter exploded');
    },
    get $metadata(): unknown {
      throw new Error('$metadata getter exploded');
    },
  };
}

/** 循環参照を含む例外 */
function createCircularError(): unknown {
  const error = new Error('Rate exceeded') as Error & { self?: unknown; $metadata?: unknown };
  error.name = 'ThrottlingException';
  error.self = error;
  error.$metadata = { httpStatusCode: 429, attempts: 3, self: error };
  return error;
}

/** 分類対象の値。例外・非例外・プリミティブ・敵対的な値を混ぜる */
const errorLikeArb = fc.oneof(
  fc
    .record({ name: errorNameArb, message: errorMessageArb, status: httpStatusArb })
    .map(({ name, message, status }) => {
      const error = new Error(message) as Error & { $metadata?: unknown };
      error.name = name;
      if (status !== undefined) error.$metadata = { httpStatusCode: status };
      return error as unknown;
    }),
  fc
    .record({ __type: errorNameArb, Message: errorMessageArb, statusCode: httpStatusArb })
    .map((value) => value as unknown),
  fc.record({ code: errorNameArb, reason: errorMessageArb }).map((value) => value as unknown),
  errorMessageArb.map((value) => value as unknown),
  fc.constantFrom(null, undefined, 0, 42, true, false, Number.NaN),
  fc.constant(createHostileError()),
  fc.constant(createCircularError()),
  fc.anything()
);

describe('classifyError / toClientError', () => {
  // Feature: vector-search-comparison, Property 51: エラー分類の全域性と一意性
  // 任意の下位サービスエラー（既知の例外型・未知の例外・非例外オブジェクトを含む）に対して、
  // 分類結果は定義済みエラーコード集合のちょうど 1 要素であり、再試行可否はエラーコードに対して
  // 一意に定まり、失敗段階は定義済みの 3 値のいずれか 1 つである。再試行可のコードのときのみ
  // 推奨待機秒数が設定され、その値は指定された範囲内（THROTTLED は 1〜60 秒、
  // INDEX_BUILDING は 1〜300 秒）に収まる。スロットリング以外のエラーでは再試行が発生しない。
  // 次元数不一致は検索 API を呼ばずに再試行不可のコードと両方の次元数を返す。
  // ハンドルの失効は再試行可のコードと埋め込みからの再実行が必要である旨を返す。
  // **Validates: Requirements 4.7, 16.1, 16.5, 16.6, 16.7**
  it('任意のエラー値を定義済みコードのちょうど 1 つへ分類し、再試行可否がコードに対して一意になる', () => {
    fc.assert(
      fc.property(errorLikeArb, stageArb, (error, stage) => {
        const response = classifyError(error, stage);

        // 分類結果は定義済み集合のちょうど 1 要素
        expect(VECTOR_ERROR_CODES.filter((code) => code === response.errorCode)).toHaveLength(1);
        // 失敗段階は定義済みの 3 値のいずれか 1 つ
        expect(VECTOR_ERROR_STAGES.filter((value) => value === response.stage)).toHaveLength(1);
        expect(response.stage).toBe(stage);

        // 再試行可否はコードに対して一意（入力の原文や段階では変わらない）
        const policy = VECTOR_ERROR_RETRY_POLICY[response.errorCode];
        expect(response.retryable).toBe(policy.retryable);
        expect(response.retryable).toBe(isRetryableErrorCode(response.errorCode));
        expect(classifyError(error, stage).errorCode).toBe(response.errorCode);

        if (response.retryable) {
          // 再試行が発生するのはスロットリング系の限られたコードのみ
          expect(RETRYABLE_CODES).toContain(response.errorCode);
          expect(typeof response.retryAfterSeconds).toBe('number');
          expect(response.retryAfterSeconds).toBeGreaterThanOrEqual(policy.minRetryAfterSeconds ?? 0);
          expect(response.retryAfterSeconds).toBeLessThanOrEqual(policy.maxRetryAfterSeconds ?? 0);
          if (response.errorCode === 'THROTTLED') {
            expect(response.retryAfterSeconds).toBeGreaterThanOrEqual(1);
            expect(response.retryAfterSeconds).toBeLessThanOrEqual(60);
          }
          if (response.errorCode === 'INDEX_BUILDING') {
            expect(response.retryAfterSeconds).toBeGreaterThanOrEqual(1);
            expect(response.retryAfterSeconds).toBeLessThanOrEqual(300);
          }
        } else {
          // 再試行不可のコードには推奨待機秒数を設定しない
          expect('retryAfterSeconds' in response).toBe(false);
          expect(response.retryAfterSeconds).toBeUndefined();
        }
      }),
      { numRuns: 100 }
    );

    // 次元数不一致は検索 API を呼ばずに再試行不可のコードと両方の次元数を返す
    fc.assert(
      fc.property(
        stageArb,
        fc.integer({ min: 1, max: 16000 }),
        fc.integer({ min: 1, max: 16000 }),
        (stage, queryDimensions, indexDimensions) => {
          const searchCalls: number[] = [];
          const response = dimensionMismatchError(stage, queryDimensions, indexDimensions);
          // 応答生成の経路に検索 API 呼び出しが存在しない
          expect(searchCalls).toEqual([]);

          expect(response.errorCode).toBe('DIMENSION_MISMATCH');
          expect(response.retryable).toBe(false);
          expect('retryAfterSeconds' in response).toBe(false);
          expect(response.message).toContain(String(queryDimensions));
          expect(response.message).toContain(String(indexDimensions));
        }
      ),
      { numRuns: 100 }
    );

    // ハンドルの失効は再試行可のコードと埋め込みからの再実行が必要である旨を返す
    fc.assert(
      fc.property(stageArb, (stage) => {
        const response = queryExpiredError(stage);
        expect(response.errorCode).toBe('QUERY_EXPIRED');
        expect(response.retryable).toBe(true);
        expect(response.retryAfterSeconds).toBe(0);
        expect(response.message).toContain('埋め込み');
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// エラー分類とエラー説明文の整合性（task 18.2、要件 16.10 / 16.11）
// ---------------------------------------------------------------------------

describe('下位サービスのエラー分類が入力検証専用コードを付与しない', () => {
  /**
   * V17 の実測本文。`amazon.titan-embed-text-v2:0` を us-west-2 で
   * `performanceConfigLatency: 'optimized'` 付きで呼んだときに Bedrock が返した
   * `ValidationException` のメッセージそのもの。
   */
  const LATENCY_UNSUPPORTED_MESSAGE =
    'Latency performance configuration is not supported for amazon.titan-embed-text-v2:0 in us-west-2';

  /** 旧実装が付与していた定型文。真因（レイテンシ最適化推論の未対応）と無関係である */
  const EMPTY_QUERY_STATEMENT = 'クエリ文字列が空、または空白文字のみです。';

  /** 実測された例外の形。SDK は `name` と `$metadata.httpStatusCode` の両方を載せる */
  function latencyUnsupportedValidationException(): Error {
    return Object.assign(new Error(LATENCY_UNSUPPORTED_MESSAGE), {
      name: 'ValidationException',
      $metadata: { httpStatusCode: 400, attempts: 1, totalRetryDelay: 0 },
    });
  }

  // 回帰テスト（要件 16.10 / 16.11）。旧挙動が再発したら落ちる。
  it('レイテンシ最適化推論の未対応エラーを INVALID_QUERY に分類せず、空クエリの定型文も付けない', () => {
    const response = classifyError(latencyUnsupportedValidationException(), 'EMBEDDING');

    // 旧挙動: errorCode が INVALID_QUERY になっていた
    expect(response.errorCode).not.toBe('INVALID_QUERY');
    // 旧挙動: 説明文の先頭に真因と無関係な定型文が付いていた
    expect(response.message).not.toContain(EMPTY_QUERY_STATEMENT);
    expect(response.message).not.toContain('空白文字のみ');

    // 要件 16.7 の既定分類へ落ちる（再試行不可）
    expect(response.errorCode).toBe('INTERNAL_ERROR');
    expect(response.retryable).toBe(false);
    expect(response.stage).toBe('EMBEDDING');

    // 真因は説明文に残る（分類先を変えたことで切り分けの手掛かりを失っていない）
    expect(response.message).toContain('Latency performance configuration is not supported');
  });

  // `$metadata` を持たない形・文字列だけの形でも同じ結論になることを押さえる
  it('例外名・HTTP ステータス・原文のいずれの経路からも INVALID_QUERY / QUERY_TOO_LONG が出ない', () => {
    const variants: unknown[] = [
      latencyUnsupportedValidationException(),
      Object.assign(new Error(LATENCY_UNSUPPORTED_MESSAGE), { name: 'ValidationException' }),
      { __type: 'com.amazon.bedrock#ValidationException', Message: LATENCY_UNSUPPORTED_MESSAGE },
      { message: LATENCY_UNSUPPORTED_MESSAGE, $metadata: { httpStatusCode: 400 } },
      LATENCY_UNSUPPORTED_MESSAGE,
      // クエリ文字列の妥当性を思わせる原文でも、分類経路は入力検証由来のコードを付けない
      Object.assign(new Error('Input text is too long'), { name: 'ValidationException' }),
      Object.assign(new Error('inputText must not be empty'), { name: 'ValidationException' }),
      { message: 'the value is blank', $metadata: { httpStatusCode: 400 } },
      { message: 'input exceeds maximum length', $metadata: { httpStatusCode: 422 } },
    ];

    for (const stage of VECTOR_ERROR_STAGES) {
      for (const error of variants) {
        const response = classifyError(error, stage);
        expect(INPUT_VALIDATION_ONLY_ERROR_CODES).not.toContain(response.errorCode);
        expect(response.message).not.toContain(EMPTY_QUERY_STATEMENT);
        expect(response.message).not.toContain(VECTOR_ERROR_BASE_MESSAGES.QUERY_TOO_LONG);
      }
    }
  });

  // ハンドラ側の入力検証は引き続き当該コードを付与できる（経路で切っているだけである）
  it('ハンドラ側の入力検証は INVALID_QUERY / QUERY_TOO_LONG を付与できる', () => {
    expect(toClientError('INVALID_QUERY', 'EMBEDDING').errorCode).toBe('INVALID_QUERY');
    expect(toClientError('INVALID_QUERY', 'EMBEDDING').message).toContain(EMPTY_QUERY_STATEMENT);
    expect(toClientError('QUERY_TOO_LONG', 'EMBEDDING').errorCode).toBe('QUERY_TOO_LONG');
  });

  // 定型文が互いの部分文字列でないこと。Property 60 の「他コードの定型文が現れない」判定が
  // 意味を持つ前提であり、崩れたら property テストが空振りする
  it('各コードの定型文は互いに部分文字列の関係にない', () => {
    for (const code of VECTOR_ERROR_CODES) {
      for (const other of VECTOR_ERROR_CODES) {
        if (code === other) continue;
        expect(VECTOR_ERROR_BASE_MESSAGES[code]).not.toContain(VECTOR_ERROR_BASE_MESSAGES[other]);
      }
    }
  });

  /** 400 系の細分に使われる語（次元数・TopK・範囲条件・言語）を含まない原文 */
  const unspecificValidationMessageArb = fc.constantFrom(
    'Latency performance configuration is not supported for amazon.titan-embed-text-v2:0 in us-west-2',
    'Malformed input request: extraneous key [foo] is not permitted.',
    'The provided request is invalid.',
    'Input text is too long',
    'inputText must not be empty',
    'normalize must be a boolean',
    ''
  );

  /** 下位サービスの原文が本モジュールの定型文をそのまま含む敵対的なケース */
  const echoedStatementArb = fc
    .constantFrom(...VECTOR_ERROR_CODES)
    .map((code) => `upstream said: ${VECTOR_ERROR_BASE_MESSAGES[code]} (code ${code})`);

  /** 分類対象。ValidationException 相当を厚めに、未知の形も混ぜる */
  const downstreamErrorArb = fc.oneof(
    fc
      .tuple(
        fc.constantFrom('ValidationException', 'ValidationError', 'InvalidRequestException'),
        unspecificValidationMessageArb,
        fc.constantFrom(undefined, 400, 422)
      )
      .map(([name, message, status]) => {
        const error = new Error(message) as Error & { $metadata?: unknown };
        error.name = name;
        if (status !== undefined) error.$metadata = { httpStatusCode: status };
        return error as unknown;
      }),
    fc
      .tuple(unspecificValidationMessageArb, fc.constantFrom(400, 422))
      .map(([message, status]) => ({ message, $metadata: { httpStatusCode: status } }) as unknown),
    echoedStatementArb.map((message) => new Error(message) as unknown),
    echoedStatementArb.map(
      (message) =>
        Object.assign(new Error(message), { name: 'ValidationException' }) as unknown
    ),
    errorLikeArb
  );

  // Feature: vector-search-comparison, Property 60: エラー説明文とエラーコードの発生条件の整合性
  // 任意の下位サービスエラーに対して、付与されたエラーコードの発生条件を満たさない失敗に、
  // 当該条件を述べる定型文が付与されることはない。とくに、クエリ文字列の妥当性（空文字、
  // 空白文字のみ、上限文字数超過）に起因しない `ValidationException` に対して `INVALID_QUERY`
  // は付与されず、要件 16.7 の分類規則に従うエラーコードが付与される。
  // **Validates: Requirements 16.10, 16.11**
  it('分類経路の説明文には付与したコードの定型文のみが現れる', () => {
    fc.assert(
      fc.property(downstreamErrorArb, stageArb, (error, stage) => {
        const response = classifyError(error, stage);

        // クエリ文字列の妥当性に起因するコードは分類経路から付与されない
        expect(INPUT_VALIDATION_ONLY_ERROR_CODES).not.toContain(response.errorCode);

        // 説明文は付与したコードの発生条件を述べる定型文で始まる
        expect(response.message.startsWith(VECTOR_ERROR_BASE_MESSAGES[response.errorCode])).toBe(
          true
        );

        // 他コードの発生条件を述べる定型文は現れない（原文が定型文を含む場合も除去される）
        for (const other of VECTOR_ERROR_CODES) {
          if (other === response.errorCode) continue;
          expect(response.message).not.toContain(VECTOR_ERROR_BASE_MESSAGES[other]);
        }
      }),
      { numRuns: 100 }
    );

    // 400 系のうち細分条件（次元数 / TopK / 範囲条件 / 言語）に当たらないものは
    // 要件 16.7 の既定である INTERNAL_ERROR（再試行不可）へ落ちる
    fc.assert(
      fc.property(unspecificValidationMessageArb, stageArb, (message, stage) => {
        const error = Object.assign(new Error(message), {
          name: 'ValidationException',
          $metadata: { httpStatusCode: 400 },
        });
        const response = classifyError(error, stage);
        expect(response.errorCode).toBe('INTERNAL_ERROR');
        expect(response.retryable).toBe(false);
        expect('retryAfterSeconds' in response).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});

describe('エラー応答の情報漏洩防止', () => {
  const accountIdArb = fc.integer({ min: 100000000000, max: 999999999999 }).map(String);

  const secretValueArb = fc
    .stringMatching(/^[A-Za-z0-9]{16,24}$/)
    .map((value) => `S${value}`);

  const credentialKeyArb = fc.constantFrom(
    'aws_secret_access_key',
    'AWS_ACCESS_KEY_ID',
    'secret_access_key',
    'session_token',
    'security_token',
    'credentials',
    'password',
    'passwd',
    'auth_token',
    'api_key',
    'bearer'
  );

  const accessKeyIdArb = fc.stringMatching(/^[A-Z0-9]{16}$/).map((value) => `AKIA${value}`);

  const benignArb = fc.constantFrom(
    'ValidationException',
    'request failed',
    '検索を実行できませんでした',
    'index byEmbeddingJa',
    'language ja',
    'dimension mismatch'
  );

  /** 内部由来の漏洩要因を含む文字列と、含まれる機微文字列の一覧 */
  const leakyMessageArb = fc
    .tuple(
      accountIdArb,
      credentialKeyArb,
      secretValueArb,
      accessKeyIdArb,
      fc.integer({ min: 1, max: 400 }),
      fc.integer({ min: 1, max: 80 }),
      fc.array(benignArb, { minLength: 0, maxLength: 4 })
    )
    .map(([accountId, credentialKey, secretValue, accessKeyId, line, column, benign]) => {
      const arn = `arn:aws:dynamodb:ap-northeast-1:${accountId}:table/Vector_Table/index/byEmbeddingJa`;
      const stack =
        `Error: internal failure\n    at searchVectors (/var/task/index.js:${line}:${column})` +
        `\n    at Runtime.handleOnceNonStreaming (/var/runtime/index.mjs:1173:17)`;
      const fragments = [
        ...benign,
        arn,
        `account ${accountId}`,
        `${credentialKey}=${secretValue}`,
        `"${credentialKey}": "${secretValue}"`,
        accessKeyId,
        stack,
      ];
      return {
        text: fragments.join(' '),
        secrets: [
          arn,
          'arn:aws',
          accountId,
          credentialKey,
          secretValue,
          accessKeyId,
          '/var/task/index.js',
          '/var/runtime/index.mjs',
        ],
      };
    });

  const codeArb = fc.constantFrom(...VECTOR_ERROR_CODES);

  /** 応答が機微情報を含まないことを検証する */
  function expectNoLeak(response: VectorErrorResponse, secrets: readonly string[]): void {
    // 応答はエラーコード・説明文・再試行可否（および推奨待機秒数）と失敗段階のみで構成される
    for (const key of Object.keys(response)) {
      expect(ALLOWED_RESPONSE_KEYS).toContain(key);
    }
    // 説明文の長さは 500 文字以下
    expect(response.message.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_LENGTH);

    const message = response.message;
    const lower = message.toLowerCase();
    for (const secret of secrets) {
      expect(lower).not.toContain(secret.toLowerCase());
    }
    // ARN・12 桁以上の数字列・スタックトレースのフレームが現れない
    expect(message).not.toMatch(/arn:aws/i);
    expect(message).not.toMatch(/\d{12,}/);
    expect(message).not.toMatch(/\bat\s+\S+\s+\(/);
  }

  // Feature: vector-search-comparison, Property 52: エラー応答の情報漏洩防止
  // 任意の内部エラー（ARN 形式の文字列、12 桁のアカウント ID、スタックトレース、
  // 資格情報を示すキー名を含むもの）に対して、外部へ返るエラー応答にはこれらのパターンが
  // 一切現れず、説明文の長さは 500 文字以下であり、応答はエラーコード・説明文・再試行可否
  // （および再試行可の場合の推奨待機秒数）のみで構成される。
  // **Validates: Requirements 16.9**
  it('ARN・アカウント ID・スタックトレース・資格情報のキー名が応答に現れない', () => {
    fc.assert(
      fc.property(leakyMessageArb, stageArb, codeArb, ({ text, secrets }, stage, code) => {
        const error = new Error(text);
        const responses: VectorErrorResponse[] = [
          classifyError(error, stage),
          classifyError(text, stage),
          classifyError({ Message: text, $metadata: { httpStatusCode: 500 } }, stage),
          toClientError(code, stage, { detail: text }),
        ];

        for (const response of responses) {
          expectNoLeak(response, secrets);
        }
      }),
      { numRuns: 100 }
    );
  });
});
