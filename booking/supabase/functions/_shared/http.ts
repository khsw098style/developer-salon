// api-design.md の「エラーレスポンスの共通フォーマット」に対応するヘルパー。

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "LINK_EXPIRED"
  | "CANCELLATION_CLOSED"
  | "SLOT_UNAVAILABLE"
  | "STAFF_MENU_MISMATCH"
  | "INVALID_STATUS_TRANSITION"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  LINK_EXPIRED: 410,
  CANCELLATION_CLOSED: 409,
  SLOT_UNAVAILABLE: 409,
  STAFF_MENU_MISMATCH: 409,
  INVALID_STATUS_TRANSITION: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: HeadersInit } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

// ルートハンドラのcatchブロックから呼ぶ想定。ApiErrorはそのまま返し、
// それ以外(DBエラー・実装バグ等)はログに残した上で500として返す(詳細は外に漏らさない)。
export function errorResponse(err: unknown, headers: HeadersInit): Response {
  if (err instanceof ApiError) {
    return jsonResponse(
      { error: { code: err.code, message: err.message } },
      { status: STATUS_BY_CODE[err.code], headers },
    );
  }

  console.error("Unhandled error:", err);
  return jsonResponse(
    { error: { code: "INTERNAL_ERROR", message: "予期しないエラーが発生しました。時間をおいて再度お試しください。" } },
    { status: 500, headers },
  );
}
