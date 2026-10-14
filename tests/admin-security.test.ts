import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign, verify as verifySignature } from 'node:crypto';
import { test } from 'node:test';
import { createAdminAuthenticator, type AccessEnvironment } from '../src/lib/admin/access.ts';
import {
  assertSameOriginMutation,
  AdminInputError,
  createAdminRateLimiter,
  createIdempotencyRegistry,
  IdempotencyError,
  isAdminApiPath,
  isAdminPagePath,
  readJsonObject,
  requireIdempotencyKey,
} from '../src/lib/admin/http.ts';
import {
  createGitHubAppJwt,
  createInstallationAccessToken,
  GitHubAppError,
  type GitHubAppEnvironment,
} from '../src/lib/admin/github-app.ts';
import { createWorkerHandler, type WorkerEnvironment } from '../src/worker.ts';
import type { ExistingImportEntry } from '../src/lib/admin/github-import.ts';

const now = Date.UTC(2026, 9, 14, 12, 0, 0);
const nowSeconds = Math.floor(now / 1_000);
const teamIssuer = 'https://my-team.cloudflareaccess.com';
const audience = 'library-admin-audience';
const { privateKey: accessPrivatePem, publicKey: accessPublicPem } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const accessPublicJwk = {
  ...(createPublicKey(accessPublicPem).export({ format: 'jwk' }) as JsonWebKey),
  kid: 'access-fixture-key',
  alg: 'RS256',
  use: 'sig',
};
const allowedEnvironment: AccessEnvironment = {
  CF_ACCESS_TEAM_DOMAIN: 'my-team.cloudflareaccess.com',
  CF_ACCESS_AUD: audience,
  ADMIN_EMAILS: 'Admin@example.com',
};

function encodeSegment(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function accessToken(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  signer: string | Buffer = accessPrivatePem,
) {
  const tokenHeader = encodeSegment({
    alg: 'RS256',
    typ: 'JWT',
    kid: 'access-fixture-key',
    ...header,
  });
  const tokenClaims = encodeSegment({
    iss: teamIssuer,
    aud: [audience],
    exp: nowSeconds + 300,
    iat: nowSeconds - 10,
    email: 'admin@example.com',
    ...claims,
  });
  const signingInput = `${tokenHeader}.${tokenClaims}`;
  return `${signingInput}.${sign('RSA-SHA256', Buffer.from(signingInput), signer).toString('base64url')}`;
}

function invalidSignatureToken() {
  const tokenHeader = encodeSegment({ alg: 'RS256', typ: 'JWT', kid: 'access-fixture-key' });
  const tokenClaims = encodeSegment({
    iss: teamIssuer,
    aud: [audience],
    exp: nowSeconds + 300,
    email: 'admin@example.com',
  });
  return `${tokenHeader}.${tokenClaims}.${Buffer.alloc(256, 7).toString('base64url')}`;
}

function createFixture(
  options: {
    fetchGitHub?: typeof fetch;
    loadImportCatalog?: (
      request: Request,
      environment: WorkerEnvironment,
    ) => Promise<ExistingImportEntry[]>;
  } = {},
) {
  let jwksRequests = 0;
  let unavailable = false;
  const fetcher: typeof fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    assert.equal(url, `${teamIssuer}/cdn-cgi/access/certs`);
    jwksRequests += 1;
    if (unavailable) throw new Error('fixture network error containing no credentials');
    return new Response(JSON.stringify({ keys: [accessPublicJwk] }), {
      status: 200,
      headers: { 'Cache-Control': 'public, max-age=60', 'Content-Type': 'application/json' },
    });
  };
  const authenticate = createAdminAuthenticator({ fetcher, now: () => now });
  let assetFetches = 0;
  const environment: WorkerEnvironment = {
    ...allowedEnvironment,
    ASSETS: {
      fetch: async (request) => {
        assetFetches += 1;
        return new Response(`static:${new URL(request.url).pathname}`, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      },
    },
  };
  const worker = {
    fetch: createWorkerHandler({
      authenticate,
      allowRequest: createAdminRateLimiter({ limit: 100, writeLimit: 20, now: () => now }),
      makeRequestId: () => 'request-fixture-id',
      ...(options.fetchGitHub ? { fetchGitHub: options.fetchGitHub } : {}),
      ...(options.loadImportCatalog ? { loadImportCatalog: options.loadImportCatalog } : {}),
    }),
  };
  return {
    environment,
    worker,
    get assetFetches() {
      return assetFetches;
    },
    get jwksRequests() {
      return jwksRequests;
    },
    set unavailable(value: boolean) {
      unavailable = value;
    },
  };
}

test('管理路径匹配覆盖编码斜线与双重编码，不误伤相似公开路径', () => {
  assert.equal(isAdminPagePath('/admin'), true);
  assert.equal(isAdminPagePath('/admin%2Fimport'), true);
  assert.equal(isAdminPagePath('/admin%252Fimport'), true);
  assert.equal(isAdminApiPath('/api/admin%2Fsession'), true);
  assert.equal(isAdminApiPath('/api/admin%252Fimport'), true);
  assert.equal(isAdminPagePath('/administrator'), false);
  assert.equal(isAdminApiPath('/api/administrator'), false);
});

test('管理页面与 API 在正式域名和 workers.dev 均默认拒绝且不信任伪造请求头', async () => {
  let assetFetches = 0;
  const worker = { fetch: createWorkerHandler({ makeRequestId: () => 'request-id' }) };
  const environment: WorkerEnvironment = {
    ASSETS: {
      fetch: async () => {
        assetFetches += 1;
        return new Response('private');
      },
    },
  };
  const forgedHeader = 'not-a-signed-access-jwt';

  for (const host of ['skill.overme.cn', 'my-skill-library.workers.dev']) {
    for (const path of [
      '/admin',
      '/admin/import',
      '/api/admin/session',
      '/api/admin/import/preview',
      '/api/admin/publish',
    ]) {
      const response = await worker.fetch(
        new Request(`https://${host}${path}`, {
          headers: { 'Cf-Access-Jwt-Assertion': forgedHeader },
        }),
        environment,
      );
      assert.equal(response.status, 503, `${host}${path} must fail closed without Access config.`);
      assert.deepEqual(await response.json(), { error: 'access_not_configured' });
    }
  }
  assert.equal(assetFetches, 0, 'Unauthenticated requests must not reach protected static assets.');
});

test('缺少 Access JWT 或签名无效时，两个主机都不能访问后台资源', async () => {
  const fixture = createFixture();
  for (const host of ['skill.overme.cn', 'my-skill-library.workers.dev']) {
    const missing = await fixture.worker.fetch(
      new Request(`https://${host}/admin`),
      fixture.environment,
    );
    assert.equal(missing.status, 401);

    const invalid = await fixture.worker.fetch(
      new Request(`https://${host}/admin`, {
        headers: { 'Cf-Access-Jwt-Assertion': invalidSignatureToken() },
      }),
      fixture.environment,
    );
    assert.equal(invalid.status, 401);
  }
  assert.equal(fixture.assetFetches, 0);
  assert.equal(fixture.jwksRequests, 1, 'JWKS is cached after the first verification attempt.');
});

test('签名、issuer、audience、时间及管理员 allowlist 均需满足', async () => {
  const fixture = createFixture();
  const invalidTokens = [
    `${accessToken()}.extra`,
    accessToken({ iss: 'https://attacker.example' }),
    accessToken({ aud: ['other-audience'] }),
    accessToken({ aud: audience }),
    accessToken({ exp: nowSeconds - 1 }),
    accessToken({ nbf: nowSeconds + 120 }),
    accessToken({ iat: nowSeconds + 120 }),
    accessToken({ email: 'someone@example.net' }),
    accessToken({}, { kid: 'unknown-key-id' }),
  ];

  for (const token of invalidTokens) {
    const response = await fixture.worker.fetch(
      new Request('https://skill.overme.cn/api/admin/session', {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      }),
      fixture.environment,
    );
    assert.ok([401, 403].includes(response.status));
  }
  assert.equal(fixture.assetFetches, 0);

  const nonAdministrator = await fixture.worker.fetch(
    new Request('https://skill.overme.cn/api/admin/session', {
      headers: {
        'Cf-Access-Jwt-Assertion': accessToken({ email: 'other@example.net' }),
      },
    }),
    fixture.environment,
  );
  assert.equal(nonAdministrator.status, 403);
  assert.deepEqual(await nonAdministrator.json(), { error: 'administrator_required' });
});

test('有效的签名 Access JWT 允许指定管理员读取会话及受保护 HTML', async () => {
  const fixture = createFixture();
  const token = accessToken();
  for (const host of ['skill.overme.cn', 'my-skill-library.workers.dev']) {
    const session = await fixture.worker.fetch(
      new Request(`https://${host}/api/admin/session`, {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      }),
      fixture.environment,
    );
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), { authenticated: true, email: 'admin@example.com' });
    assert.equal(session.headers.get('Cache-Control'), 'no-store, private');
    assert.equal(session.headers.get('X-Request-ID'), 'request-fixture-id');

    const page = await fixture.worker.fetch(
      new Request(`https://${host}/admin`, {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      }),
      fixture.environment,
    );
    assert.equal(page.status, 200);
    assert.equal(await page.text(), 'static:/admin');
    assert.equal(page.headers.get('Cache-Control'), 'no-store, private');
    assert.match(page.headers.get('Content-Security-Policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(page.headers.get('X-Frame-Options'), 'DENY');
  }
  assert.equal(fixture.assetFetches, 2);
});

test('Access JWKS 失败时 fail closed，日志不含伪造 token', async () => {
  const fixture = createFixture();
  fixture.unavailable = true;
  const secretLookingValue = 'very-secret@example.com';
  const token = accessToken({ email: secretLookingValue });
  const originalWarn = console.warn;
  const logs: unknown[][] = [];
  console.warn = ((...values: unknown[]) => logs.push(values)) as typeof console.warn;
  try {
    const response = await fixture.worker.fetch(
      new Request('https://my-skill-library.workers.dev/api/admin/session', {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      }),
      fixture.environment,
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'authentication_unavailable' });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(logs.length, 1);
  assert.ok(!JSON.stringify(logs).includes(secretLookingValue));
  assert.ok(!JSON.stringify(logs).includes(token));
});

test('所有非安全方法要求同源 Origin；恶意跨站写请求被拒绝', async () => {
  const fixture = createFixture();
  const token = accessToken();
  const crossSite = await fixture.worker.fetch(
    new Request('https://skill.overme.cn/api/admin/publish', {
      method: 'POST',
      headers: {
        'Cf-Access-Jwt-Assertion': token,
        Origin: 'https://evil.example',
        'Sec-Fetch-Site': 'cross-site',
        'Content-Type': 'application/json',
      },
      body: '{}',
    }),
    fixture.environment,
  );
  assert.equal(crossSite.status, 403);
  assert.deepEqual(await crossSite.json(), { error: 'cross_origin_request' });

  const missingOrigin = new Request('https://skill.overme.cn/api/admin/publish', {
    method: 'POST',
    headers: { 'Cf-Access-Jwt-Assertion': token },
    body: '{}',
  });
  assert.throws(
    () => assertSameOriginMutation(missingOrigin),
    (error: unknown) => {
      assert.ok(error instanceof AdminInputError);
      assert.equal(error.code, 'cross_origin_request');
      return true;
    },
  );

  const sameOriginUnknownWrite = await fixture.worker.fetch(
    new Request('https://skill.overme.cn/api/admin/publish', {
      method: 'POST',
      headers: {
        'Cf-Access-Jwt-Assertion': token,
        Origin: 'https://skill.overme.cn',
        'Sec-Fetch-Site': 'same-origin',
        'Idempotency-Key': 'request-key-000001',
      },
      body: '{}',
    }),
    fixture.environment,
  );
  assert.equal(sameOriginUnknownWrite.status, 404, 'No write endpoint is enabled in Phase 1.');
});

test('同源 mutation 必须提供格式有效的幂等键', () => {
  const valid = new Request('https://skill.overme.cn/api/admin/import', {
    method: 'POST',
    headers: {
      Origin: 'https://skill.overme.cn',
      'Idempotency-Key': 'request-key-000001',
    },
    body: '{}',
  });
  assertSameOriginMutation(valid);
  assert.equal(requireIdempotencyKey(valid), 'request-key-000001');

  for (const key of ['short', 'contains spaces and is too long']) {
    const invalid = new Request('https://skill.overme.cn/api/admin/import', {
      method: 'POST',
      headers: { Origin: 'https://skill.overme.cn', 'Idempotency-Key': key },
      body: '{}',
    });
    assert.throws(
      () => assertSameOriginMutation(invalid),
      (error: unknown) => {
        assert.ok(error instanceof AdminInputError);
        assert.equal(error.code, 'invalid_idempotency_key');
        return true;
      },
    );
  }

  const missing = new Request('https://skill.overme.cn/api/admin/import', {
    method: 'POST',
    headers: { Origin: 'https://skill.overme.cn' },
    body: '{}',
  });
  assert.throws(
    () => requireIdempotencyKey(missing),
    (error: unknown) => {
      assert.ok(error instanceof AdminInputError);
      assert.equal(error.code, 'idempotency_key_required');
      return true;
    },
  );
});

test('幂等 registry 并发合并重试、冲突拒绝且按 TTL 回收', async () => {
  let clock = now;
  const runIdempotent = createIdempotencyRegistry({
    maxEntries: 1,
    ttlMs: 1_000,
    now: () => clock,
  });
  const key = 'request-key-000001';
  const payload = new TextEncoder().encode('{"name":"draft"}');
  let executions = 0;
  const run = () =>
    runIdempotent('admin@example.com', '/api/admin/import', key, payload, async () => {
      executions += 1;
      await Promise.resolve();
      return new Response('created', { status: 201 });
    });

  const [first, replay] = await Promise.all([run(), run()]);
  assert.equal(executions, 1, 'Concurrent identical requests execute one operation per isolate.');
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(await first.response.text(), 'created');
  assert.equal(await replay.response.text(), 'created');

  await assert.rejects(
    runIdempotent(
      'admin@example.com',
      '/api/admin/import',
      key,
      new TextEncoder().encode('{"name":"different"}'),
      async () => new Response('must not run'),
    ),
    (error: unknown) => error instanceof IdempotencyError && error.status === 409,
  );
  await assert.rejects(
    runIdempotent(
      'another-admin@example.com',
      '/api/admin/import',
      'request-key-000002',
      payload,
      async () => new Response('must not run'),
    ),
    (error: unknown) => error instanceof IdempotencyError && error.status === 503,
  );

  clock += 1_001;
  const afterExpiry = await run();
  assert.equal(afterExpiry.replayed, false);
  assert.equal(executions, 2);
});

test('JSON API body 强制 application/json、对象类型和大小上限', async () => {
  const valid = await readJsonObject(
    new Request('https://skill.overme.cn/api/admin/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ url: 'https://github.com/example/skill' }),
    }),
  );
  assert.equal(valid.url, 'https://github.com/example/skill');

  await assert.rejects(
    readJsonObject(
      new Request('https://skill.overme.cn/api/admin/import', { method: 'POST', body: '{}' }),
    ),
    (error: unknown) => error instanceof AdminInputError && error.code === 'unsupported_media_type',
  );
  await assert.rejects(
    readJsonObject(
      new Request('https://skill.overme.cn/api/admin/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '100' },
        body: '{}',
      }),
      10,
    ),
    (error: unknown) => error instanceof AdminInputError && error.status === 413,
  );
  await assert.rejects(
    readJsonObject(
      new Request('https://skill.overme.cn/api/admin/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"oversized":"value"}',
      }),
      10,
    ),
    (error: unknown) => error instanceof AdminInputError && error.status === 413,
  );
  await assert.rejects(
    readJsonObject(
      new Request('https://skill.overme.cn/api/admin/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '[1,2,3]',
      }),
    ),
    (error: unknown) => error instanceof AdminInputError && error.code === 'invalid_json',
  );
});

test('按已验证管理员身份执行读写限流并返回退避时间', () => {
  let clock = now;
  const allow = createAdminRateLimiter({
    limit: 2,
    writeLimit: 1,
    windowMs: 60_000,
    now: () => clock,
  });
  assert.equal(allow('admin@example.com', 'read').allowed, true);
  assert.equal(allow('admin@example.com', 'read').allowed, true);
  assert.deepEqual(allow('admin@example.com', 'read'), { allowed: false, retryAfter: 60 });
  assert.equal(allow('admin@example.com', 'write').allowed, true);
  assert.deepEqual(allow('admin@example.com', 'write'), { allowed: false, retryAfter: 60 });
  clock += 60_001;
  assert.equal(allow('admin@example.com', 'write').allowed, true);
});

test('公开静态路径不依赖后台鉴权中间件', async () => {
  let assetFetches = 0;
  const worker = { fetch: createWorkerHandler({ makeRequestId: () => 'public-request' }) };
  const response = await worker.fetch(new Request('https://skill.overme.cn/'), {
    ASSETS: {
      fetch: async () => {
        assetFetches += 1;
        return new Response('public site');
      },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'public site');
  assert.equal(assetFetches, 1);
});

test('GitHub App JWT 使用私钥签发短期 RS256 token，私钥仅在服务端', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const environment: GitHubAppEnvironment = {
    GITHUB_APP_ID: '12345',
    GITHUB_APP_INSTALLATION_ID: '67890',
    GITHUB_APP_PRIVATE_KEY: privateKey,
  };
  const token = await createGitHubAppJwt(environment, { now: () => now });
  const [header, claims, signature] = token.split('.');
  assert.equal(JSON.parse(Buffer.from(header!, 'base64url').toString()).alg, 'RS256');
  const payload = JSON.parse(Buffer.from(claims!, 'base64url').toString()) as {
    iss: string;
    iat: number;
    exp: number;
  };
  assert.equal(payload.iss, '12345');
  assert.equal(payload.exp - payload.iat, 600);
  assert.equal(
    verifySignature(
      'RSA-SHA256',
      Buffer.from(`${header}.${claims}`),
      createPublicKey(publicKey),
      Buffer.from(signature!, 'base64url'),
    ),
    true,
  );
  await assert.rejects(
    createGitHubAppJwt({}, { now: () => now }),
    (error: unknown) =>
      error instanceof GitHubAppError && error.code === 'github_app_not_configured',
  );
});

test('GitHub installation token API 请求限定仓库安装及最小权限，错误不回显响应体', async () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const environment: GitHubAppEnvironment = {
    GITHUB_APP_ID: '12345',
    GITHUB_APP_INSTALLATION_ID: '67890',
    GITHUB_APP_PRIVATE_KEY: privateKey,
  };
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    requestUrl = input instanceof Request ? input.url : String(input);
    requestInit = init;
    return new Response(
      JSON.stringify({
        token: 'ghs_fixture_installation_token_1234567890',
        expires_at: new Date(now + 60 * 60 * 1_000).toISOString(),
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
  };
  const result = await createInstallationAccessToken(environment, {
    fetcher,
    now: () => now,
    timeoutMs: 1_000,
  });
  assert.equal(requestUrl, 'https://api.github.com/app/installations/67890/access_tokens');
  assert.equal(result.token, 'ghs_fixture_installation_token_1234567890');
  const headers = new Headers(requestInit?.headers);
  assert.match(headers.get('Authorization') ?? '', /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  assert.ok(requestInit?.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    repositories: ['my-skill-library'],
    permissions: {
      actions: 'read',
      checks: 'read',
      contents: 'write',
      pull_requests: 'write',
    },
  });

  const failingFetcher: typeof fetch = async () =>
    new Response('fixture body must not be propagated', {
      status: 403,
      headers: { 'Retry-After': '17' },
    });
  await assert.rejects(
    createInstallationAccessToken(environment, { fetcher: failingFetcher, now: () => now }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubAppError);
      assert.equal(error.code, 'github_rate_limited');
      assert.equal(error.retryAfter, 17);
      assert.ok(!error.message.includes('fixture body'));
      return true;
    },
  );
});

test('导入预览 API 仅在有效 Access、同源、幂等键与静态目录可用时查询 GitHub', async () => {
  const commit = 'a'.repeat(40);
  const blob = 'b'.repeat(40);
  let githubRequests = 0;
  const fetchGitHub: typeof fetch = async (input) => {
    githubRequests += 1;
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://api.github.com/repos/example/skills') {
      return new Response(JSON.stringify({ default_branch: 'main' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/commits/main')) {
      return new Response(JSON.stringify({ sha: commit }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith(`/git/trees/${commit}?recursive=1`)) {
      return new Response(
        JSON.stringify({
          truncated: false,
          tree: [
            { path: 'skills/demo/SKILL.md', mode: '100644', type: 'blob', sha: blob, size: 80 },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
    assert.fail(`Unexpected GitHub request ${url}`);
  };
  const fixture = createFixture({ fetchGitHub, loadImportCatalog: async () => [] });
  const token = accessToken();
  const request = (headers: Record<string, string> = {}) =>
    new Request('https://skill.overme.cn/api/admin/import/preview', {
      method: 'POST',
      headers: {
        'Cf-Access-Jwt-Assertion': token,
        Origin: 'https://skill.overme.cn',
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'request-key-000001',
        ...headers,
      },
      body: JSON.stringify({ sourceUrl: 'https://github.com/example/skills' }),
    });

  const crossOrigin = await fixture.worker.fetch(
    request({ Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }),
    fixture.environment,
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal(githubRequests, 0);

  const missingIdempotency = await fixture.worker.fetch(
    request({ 'Idempotency-Key': '' }),
    fixture.environment,
  );
  assert.equal(missingIdempotency.status, 400);
  assert.equal(githubRequests, 0);

  const response = await fixture.worker.fetch(request(), fixture.environment);
  const responsePayload = await response.clone().json();
  assert.equal(response.status, 200, JSON.stringify({ payload: responsePayload, githubRequests }));
  assert.equal(response.headers.get('Cache-Control'), 'no-store, private');
  assert.equal(response.headers.get('X-Request-ID'), 'request-fixture-id');
  const payload = await response.json();
  assert.equal((payload as { candidates: unknown[] }).candidates.length, 1);
  assert.equal(githubRequests, 3);
  assert.ok(!JSON.stringify(payload).includes(token));

  const rateLimitFetcher: typeof fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://api.github.com/repos/example/skills') {
      return new Response(JSON.stringify({ default_branch: 'main' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/commits/main')) {
      return new Response(JSON.stringify({ sha: commit }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/git/trees/')) {
      return new Response('rate limited', { status: 429, headers: { 'Retry-After': '17' } });
    }
    assert.fail(`Unexpected rate-limit fixture request ${url}`);
  };
  const rateLimited = createFixture({
    fetchGitHub: rateLimitFetcher,
    loadImportCatalog: async () => [],
  });
  const limitedResponse = await rateLimited.worker.fetch(request(), rateLimited.environment);
  assert.equal(limitedResponse.status, 429);
  assert.equal(limitedResponse.headers.get('Retry-After'), '17');
  assert.deepEqual(await limitedResponse.json(), { error: 'github_rate_limited' });
});
