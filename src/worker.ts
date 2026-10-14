import {
  authenticateAdmin,
  type AccessEnvironment,
  type AccessResult,
} from './lib/admin/access.ts';
import {
  AdminInputError,
  assertSameOriginMutation,
  createAdminRateLimiter,
  isAdminApiPath,
  isAdminPagePath,
  jsonResponse,
  readJsonObject,
} from './lib/admin/http.ts';
import type { GitHubAppEnvironment } from './lib/admin/github-app.ts';
import {
  discoverGitHubSkills,
  GitHubImportError,
  type ExistingImportEntry,
} from './lib/admin/github-import.ts';

export interface WorkerEnvironment extends AccessEnvironment, GitHubAppEnvironment {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export interface WorkerDependencies {
  authenticate?: (request: Request, environment: WorkerEnvironment) => Promise<AccessResult>;
  allowRequest?: (
    identity: string,
    category: 'read' | 'write',
  ) => { allowed: boolean; retryAfter: number };
  makeRequestId?: () => string;
  fetchGitHub?: typeof fetch;
  loadImportCatalog?: (
    request: Request,
    environment: WorkerEnvironment,
  ) => Promise<ExistingImportEntry[]>;
}

async function readImportCatalog(request: Request, environment: WorkerEnvironment) {
  const catalogUrl = new URL('/import-catalog.json', request.url);
  const response = await environment.ASSETS.fetch(new Request(catalogUrl, { method: 'GET' }));
  if (!response.ok || !response.body) throw new Error('import_catalog_unavailable');
  if (Number(response.headers.get('Content-Length')) > 128 * 1024) {
    await response.body.cancel();
    throw new Error('import_catalog_unavailable');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 128 * 1024) {
      await reader.cancel();
      throw new Error('import_catalog_unavailable');
    }
    chunks.push(value);
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
    throw new Error('import_catalog_unavailable');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as { entries?: unknown }).entries)
  ) {
    throw new Error('import_catalog_unavailable');
  }
  return (value as { entries: ExistingImportEntry[] }).entries;
}

export function createWorkerHandler(dependencies: WorkerDependencies = {}) {
  const authenticate = dependencies.authenticate ?? authenticateAdmin;
  const allowRequest = dependencies.allowRequest ?? createAdminRateLimiter();
  const makeRequestId = dependencies.makeRequestId ?? (() => crypto.randomUUID());

  return async function handleRequest(
    request: Request,
    environment: WorkerEnvironment,
  ): Promise<Response> {
    const url = new URL(request.url);
    const isAdminApi = isAdminApiPath(url.pathname);
    const isAdminPage = isAdminPagePath(url.pathname);

    if (!isAdminApi && !isAdminPage) {
      return environment.ASSETS.fetch(request);
    }

    const requestId = makeRequestId();
    let authResult: AccessResult;
    try {
      authResult = await authenticate(request, environment);
    } catch {
      authResult = { ok: false, status: 503, code: 'authentication_unavailable' };
    }

    if (!authResult.ok) {
      console.warn(
        JSON.stringify({ event: 'admin_access_denied', code: authResult.code, requestId }),
      );
      return jsonResponse({ error: authResult.code }, authResult.status, requestId);
    }

    const category = ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ? 'read' : 'write';
    const rateLimit = allowRequest(authResult.identity.email, category);
    if (!rateLimit.allowed) {
      const response = jsonResponse({ error: 'rate_limited' }, 429, requestId);
      response.headers.set('Retry-After', String(rateLimit.retryAfter));
      return response;
    }

    if (isAdminApi) {
      if (category === 'write') {
        try {
          assertSameOriginMutation(request);
        } catch (error) {
          if (error instanceof AdminInputError) {
            return jsonResponse({ error: error.code }, error.status, requestId);
          }
          return jsonResponse({ error: 'invalid_request' }, 400, requestId);
        }
      }

      if (request.method === 'POST' && url.pathname === '/api/admin/import/preview') {
        try {
          const input = await readJsonObject(request);
          if (typeof input.sourceUrl !== 'string') {
            return jsonResponse({ error: 'invalid_source_url' }, 400, requestId);
          }
          let catalog: ExistingImportEntry[];
          try {
            catalog = dependencies.loadImportCatalog
              ? await dependencies.loadImportCatalog(request, environment)
              : await readImportCatalog(request, environment);
          } catch {
            return jsonResponse({ error: 'import_catalog_unavailable' }, 503, requestId);
          }
          const preview = await discoverGitHubSkills(input.sourceUrl, {
            ...(dependencies.fetchGitHub ? { fetcher: dependencies.fetchGitHub } : {}),
            catalog,
          });
          return jsonResponse(preview as unknown as Record<string, unknown>, 200, requestId);
        } catch (error) {
          if (error instanceof AdminInputError) {
            return jsonResponse({ error: error.code }, error.status, requestId);
          }
          if (error instanceof GitHubImportError) {
            const response = jsonResponse({ error: error.code }, error.status, requestId);
            if (error.retryAfter) response.headers.set('Retry-After', String(error.retryAfter));
            return response;
          }
          console.error(
            JSON.stringify({
              event: 'admin_import_preview_failure',
              name: error instanceof Error ? error.name : 'unknown',
              requestId,
            }),
          );
          return jsonResponse({ error: 'import_preview_failed' }, 500, requestId);
        }
      }

      if (request.method !== 'GET' || url.pathname !== '/api/admin/session') {
        return jsonResponse({ error: 'not_found' }, 404, requestId);
      }
      return jsonResponse(
        { authenticated: true, email: authResult.identity.email },
        200,
        requestId,
      );
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse({ error: 'method_not_allowed' }, 405, requestId);
    }

    try {
      const asset = await environment.ASSETS.fetch(request);
      const headers = new Headers(asset.headers);
      headers.set('Cache-Control', 'no-store, private');
      headers.set(
        'Content-Security-Policy',
        "default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; font-src 'self' data:; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
      );
      headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      headers.set('X-Frame-Options', 'DENY');
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Referrer-Policy', 'no-referrer');
      headers.set('X-Request-ID', requestId);
      return new Response(asset.body, {
        status: asset.status,
        statusText: asset.statusText,
        headers,
      });
    } catch {
      console.error(JSON.stringify({ event: 'admin_asset_failure', requestId }));
      return jsonResponse({ error: 'internal_error' }, 500, requestId);
    }
  };
}

const worker = {
  fetch: createWorkerHandler(),
};

export default worker;
