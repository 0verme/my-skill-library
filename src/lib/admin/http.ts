export const MAX_ADMIN_BODY_BYTES = 64 * 1024;

export type AdminInputErrorCode =
  | 'cross_origin_request'
  | 'idempotency_key_required'
  | 'invalid_idempotency_key'
  | 'invalid_idempotency_scope'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'invalid_json';

export class AdminInputError extends Error {
  readonly status: 400 | 403 | 413 | 415;
  readonly code: AdminInputErrorCode;

  constructor(status: 400 | 403 | 413 | 415, code: AdminInputErrorCode) {
    super(code);
    this.name = 'AdminInputError';
    this.status = status;
    this.code = code;
  }
}

function decodePathname(pathname: string) {
  let decoded = pathname;
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

export function isAdminPagePath(pathname: string) {
  const decoded = decodePathname(pathname);
  return decoded === '/admin' || decoded.startsWith('/admin/');
}

export function isAdminApiPath(pathname: string) {
  const decoded = decodePathname(pathname);
  return decoded === '/api/admin' || decoded.startsWith('/api/admin/');
}

export function hasSameOrigin(request: Request) {
  const origin = request.headers.get('Origin');
  if (!origin) return false;

  try {
    if (new URL(origin).origin !== new URL(request.url).origin) return false;
  } catch {
    return false;
  }

  const fetchSite = request.headers.get('Sec-Fetch-Site');
  return fetchSite === null || fetchSite === 'same-origin';
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function requireIdempotencyKey(request: Request) {
  const key = request.headers.get('Idempotency-Key');
  if (!key) throw new AdminInputError(400, 'idempotency_key_required');
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new AdminInputError(400, 'invalid_idempotency_key');
  }
  return key;
}

export function assertSameOriginMutation(request: Request) {
  if (!hasSameOrigin(request)) throw new AdminInputError(403, 'cross_origin_request');
  requireIdempotencyKey(request);
}

export type IdempotencyErrorCode = 'idempotency_conflict' | 'idempotency_capacity';

export class IdempotencyError extends Error {
  readonly code: IdempotencyErrorCode;
  readonly status: 409 | 503;

  constructor(code: IdempotencyErrorCode) {
    super(code);
    this.name = 'IdempotencyError';
    this.code = code;
    this.status = code === 'idempotency_conflict' ? 409 : 503;
  }
}

interface IdempotencyEntry {
  fingerprint: string;
  expiresAt: number;
  pending: Promise<Response> | undefined;
  response: Response | undefined;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function createIdempotencyRegistry(
  options: { maxEntries?: number; ttlMs?: number; now?: () => number } = {},
) {
  const maxEntries = Math.max(1, Math.min(options.maxEntries ?? 1_000, 10_000));
  const ttlMs = Math.max(
    1_000,
    Math.min(options.ttlMs ?? 24 * 60 * 60 * 1_000, 7 * 24 * 60 * 60 * 1_000),
  );
  const now = options.now ?? Date.now;
  const entries = new Map<string, IdempotencyEntry>();

  return async function runIdempotent(
    identity: string,
    scope: string,
    key: string,
    payload: Uint8Array,
    operation: () => Promise<Response>,
  ): Promise<{ response: Response; replayed: boolean }> {
    if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw new AdminInputError(400, 'invalid_idempotency_key');
    }
    if (!identity || identity.length > 254 || !scope.startsWith('/') || scope.length > 1_024) {
      throw new AdminInputError(400, 'invalid_idempotency_scope');
    }

    const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(payload));
    const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    const mapKey = JSON.stringify([identity, scope, key]);
    const current = now();
    const existing = entries.get(mapKey);

    if (existing && (existing.pending || existing.expiresAt > current)) {
      if (existing.fingerprint !== fingerprint) throw new IdempotencyError('idempotency_conflict');
      if (existing.response) return { response: existing.response.clone(), replayed: true };
      if (existing.pending) return { response: (await existing.pending).clone(), replayed: true };
    }

    for (const [entryKey, entry] of entries) {
      if (!entry.pending && entry.expiresAt <= current) entries.delete(entryKey);
    }
    if (entries.size >= maxEntries) throw new IdempotencyError('idempotency_capacity');

    const entry: IdempotencyEntry = {
      fingerprint,
      expiresAt: current + ttlMs,
      pending: undefined,
      response: undefined,
    };
    const pending = Promise.resolve().then(operation);
    entry.pending = pending;
    entries.set(mapKey, entry);

    try {
      const response = (await pending).clone();
      entry.response = response;
      entry.pending = undefined;
      return { response: response.clone(), replayed: false };
    } catch (error) {
      entries.delete(mapKey);
      throw error;
    }
  };
}

export async function readJsonObject(
  request: Request,
  maxBytes = MAX_ADMIN_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new AdminInputError(415, 'unsupported_media_type');
  }

  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes) {
      throw new AdminInputError(413, 'payload_too_large');
    }
  }

  if (!request.body) throw new AdminInputError(400, 'invalid_json');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AdminInputError(413, 'payload_too_large');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AdminInputError) throw error;
    throw new AdminInputError(400, 'invalid_json');
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new AdminInputError(400, 'invalid_json');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AdminInputError(400, 'invalid_json');
  }
  return value as Record<string, unknown>;
}

export function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
  requestId?: string,
): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, private',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  if (requestId) headers.set('X-Request-ID', requestId);
  return new Response(JSON.stringify(body), { status, headers });
}

export function createAdminRateLimiter(
  options: { limit?: number; writeLimit?: number; windowMs?: number; now?: () => number } = {},
) {
  const readLimit = options.limit ?? 30;
  const writeLimit = options.writeLimit ?? 10;
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now;
  const buckets = new Map<string, { startedAt: number; count: number }>();

  return function allowRequest(
    identity: string,
    category: 'read' | 'write' = 'read',
  ): { allowed: boolean; retryAfter: number } {
    const current = now();
    const key = `${category}:${identity}`;
    const limit = category === 'write' ? writeLimit : readLimit;
    let bucket = buckets.get(key);
    if (!bucket || current - bucket.startedAt >= windowMs || current < bucket.startedAt) {
      bucket = { startedAt: current, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (buckets.size > 1_000) {
      for (const [key, value] of buckets) {
        if (current - value.startedAt >= windowMs) buckets.delete(key);
      }
    }

    if (bucket.count <= limit) return { allowed: true, retryAfter: 0 };
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((bucket.startedAt + windowMs - current) / 1_000)),
    };
  };
}
