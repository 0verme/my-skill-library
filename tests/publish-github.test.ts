import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { GitHubAppError } from '../src/lib/admin/github-app.ts';
import { createGitHubPublishClient, toPublishError } from '../src/lib/admin/github-publish.ts';
import { PublishError } from '../src/lib/admin/publish.ts';

const now = Date.UTC(2026, 9, 14, 12, 0, 0);
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const environment = {
  GITHUB_APP_ID: '1',
  GITHUB_APP_INSTALLATION_ID: '2',
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_PUBLISH_REPOSITORY: '0verme/my-skill-library',
};

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function tokenResponse() {
  return json({
    token: `ghs_${'x'.repeat(30)}`,
    expires_at: new Date(now + 55 * 60 * 1_000).toISOString(),
  });
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body?: string;
}

function createClient(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const requests: RecordedRequest[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const body = typeof init?.body === 'string' ? init.body : undefined;
    requests.push({
      url,
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      headers,
      ...(body ? { body } : {}),
    });
    return handler(url, init ?? {});
  };
  return {
    client: createGitHubPublishClient(environment, { fetcher, now: () => now }),
    requests,
  };
}

test('GitHub 发布客户端使用安装令牌、固定主机与有界请求', async () => {
  const token = tokenResponse();
  const { client, requests } = createClient(async (url) => {
    if (url.endsWith('/app/installations/2/access_tokens')) return token;
    if (url.endsWith('/git/ref/heads/main')) return json({ object: { sha: 'a'.repeat(40) } });
    if (url.endsWith('/git/refs')) return json({ ref: 'refs/heads/content/demo' }, 201);
    if (url.includes('/git/ref/heads/missing')) return json({ message: 'Not Found' }, 404);
    return json({ message: 'unexpected' }, 500);
  });

  assert.equal(await client.getRefSha('main'), 'a'.repeat(40));
  await client.createRef('content/demo', 'a'.repeat(40));
  assert.equal(await client.getRefSha('missing'), null);
  assert.equal(await client.getRefSha('main'), 'a'.repeat(40));
  // Token is cached: only one installation-token request despite three API calls.
  assert.equal(requests.filter((request) => request.url.endsWith('/access_tokens')).length, 1);
  const apiRequests = requests.filter((request) => !request.url.endsWith('/access_tokens'));
  for (const request of apiRequests) {
    assert.ok(request.url.startsWith('https://api.github.com/'), request.url);
    assert.equal(request.headers.get('Authorization'), `Bearer ghs_${'x'.repeat(30)}`);
  }
  const createRefRequest = apiRequests.find((request) => request.method === 'POST');
  assert.ok(createRefRequest);
  const body = JSON.parse(createRefRequest.body ?? '{}') as Record<string, unknown>;
  assert.equal(body['ref'], 'refs/heads/content/demo');
  assert.equal(body['sha'], 'a'.repeat(40));
});

test('文件读取/写入使用 Contents API 并限制大小', async () => {
  const markdown = '---\nname: Demo\n---\n\n正文';
  const encoded = Buffer.from(markdown, 'utf8').toString('base64');
  const { client, requests } = createClient(async (url, init) => {
    if (url.endsWith('/app/installations/2/access_tokens')) return tokenResponse();
    if (url.includes('/contents/src/content/skills/demo.md') && (init.method ?? 'GET') === 'GET') {
      if (url.includes('ref=missing')) return json({ message: 'Not Found' }, 404);
      return json({
        sha: 'b'.repeat(40),
        size: markdown.length,
        encoding: 'base64',
        content: encoded,
      });
    }
    if (url.includes('/contents/src/content/skills/demo.md') && init.method === 'PUT') {
      return json({ commit: { sha: 'c'.repeat(40) } }, 201);
    }
    if (url.includes('/contents/src/content/skills/large.md')) {
      return json({ sha: 'd'.repeat(40), size: 300 * 1024, encoding: 'base64', content: encoded });
    }
    return json({ message: 'unexpected' }, 500);
  });

  const file = await client.getFile('src/content/skills/demo.md', 'main');
  assert.equal(file?.sha, 'b'.repeat(40));
  assert.equal(file?.text, markdown);
  assert.equal(await client.getFile('src/content/skills/demo.md', 'missing'), null);
  await assert.rejects(
    client.getFile('src/content/skills/large.md', 'main'),
    (error: unknown) => error instanceof PublishError && error.code === 'publish_content_too_large',
  );

  const result = await client.putFile({
    path: 'src/content/skills/demo.md',
    branch: 'content/demo',
    content: markdown,
    sha: 'b'.repeat(40),
    message: 'content: 更新 Demo',
  });
  assert.equal(result.commitSha, 'c'.repeat(40));
  const put = requests.find((request) => request.method === 'PUT');
  const putBody = JSON.parse(put?.body ?? '{}') as Record<string, unknown>;
  assert.equal(putBody['branch'], 'content/demo');
  assert.equal(putBody['sha'], 'b'.repeat(40));
  assert.equal(Buffer.from(String(putBody['content']), 'base64').toString('utf8'), markdown);
  assert.equal(putBody['message'], 'content: 更新 Demo');
});

test('PR 查询优先 open，创建冲突映射为 409', async () => {
  const { client } = createClient(async (url, init) => {
    if (url.endsWith('/app/installations/2/access_tokens')) return tokenResponse();
    if (url.includes('/pulls?head=') && (init.method ?? 'GET') === 'GET') {
      return json([
        {
          number: 1,
          html_url: 'https://github.com/o/r/pull/1',
          state: 'closed',
          head: { sha: 'a'.repeat(40) },
        },
        {
          number: 2,
          html_url: 'https://github.com/o/r/pull/2',
          state: 'closed',
          merged_at: '2026-10-14T00:00:00Z',
          head: { sha: 'b'.repeat(40) },
        },
        {
          number: 3,
          html_url: 'https://github.com/o/r/pull/3',
          state: 'open',
          head: { sha: 'c'.repeat(40) },
        },
      ]);
    }
    if (url.endsWith('/pulls') && init.method === 'POST') {
      return json({ message: 'Validation Failed' }, 422);
    }
    return json({ message: 'unexpected' }, 500);
  });

  const pull = await client.findPull('content/demo');
  assert.equal(pull?.number, 3);
  assert.equal(pull?.state, 'open');
  await assert.rejects(
    client.createPull({ title: 't', body: 'b', head: 'content/demo', base: 'main' }),
    (error: unknown) => error instanceof PublishError && error.code === 'publish_pr_conflict',
  );
});

test('检查状态综合 check-runs 与 workflow runs', async () => {
  function handlerWith(checkRuns: unknown[], workflowRuns: unknown[]) {
    return createClient(async (url) => {
      if (url.endsWith('/app/installations/2/access_tokens')) return tokenResponse();
      if (url.includes('/check-runs')) return json({ check_runs: checkRuns });
      if (url.includes('/actions/runs')) return json({ workflow_runs: workflowRuns });
      return json({ message: 'unexpected' }, 500);
    }).client;
  }

  const failing = handlerWith([{ name: 'build', status: 'completed', conclusion: 'failure' }], []);
  assert.deepEqual(await failing.getChecks('a'.repeat(40)), {
    summary: 'failed',
    failing: ['build'],
  });

  const pending = handlerWith([{ name: 'build', status: 'in_progress', conclusion: null }], []);
  assert.deepEqual(await pending.getChecks('a'.repeat(40)), { summary: 'pending', failing: [] });

  const passed = handlerWith([], [{ name: 'CI', status: 'completed', conclusion: 'success' }]);
  assert.deepEqual(await passed.getChecks('a'.repeat(40)), { summary: 'passed', failing: [] });

  const none = handlerWith([], [{ name: 'CI', status: 'completed', conclusion: 'skipped' }]);
  assert.deepEqual(await none.getChecks('a'.repeat(40)), { summary: 'none', failing: [] });
});

test('部署状态读取 main CI 的 Deploy 步骤', async () => {
  function clientWithRun(run: unknown, steps: unknown[] = []) {
    return createClient(async (url) => {
      if (url.endsWith('/app/installations/2/access_tokens')) return tokenResponse();
      if (url.includes('/actions/runs?') && url.includes('event=push')) {
        return json({ workflow_runs: [run] });
      }
      if (url.includes('/jobs')) return json({ jobs: [{ name: 'Validate static site', steps }] });
      return json({ message: 'unexpected' }, 500);
    }).client;
  }

  const running = clientWithRun({
    id: 1,
    name: 'CI',
    status: 'in_progress',
    html_url: 'https://github.com/o/r/actions/runs/1',
  });
  assert.deepEqual(await running.getDeployStatus('a'.repeat(40)), {
    state: 'running',
    runUrl: 'https://github.com/o/r/actions/runs/1',
  });

  const failed = clientWithRun({
    id: 1,
    name: 'CI',
    status: 'completed',
    conclusion: 'failure',
    html_url: 'https://github.com/o/r/actions/runs/1',
  });
  assert.equal((await failed.getDeployStatus('a'.repeat(40))).state, 'failure');

  const deployed = clientWithRun(
    {
      id: 1,
      name: 'CI',
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://github.com/o/r/actions/runs/1',
    },
    [{ name: 'Deploy Cloudflare Worker', conclusion: 'success' }],
  );
  assert.equal((await deployed.getDeployStatus('a'.repeat(40))).state, 'success');

  const deployFailed = clientWithRun(
    {
      id: 1,
      name: 'CI',
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://github.com/o/r/actions/runs/1',
    },
    [{ name: 'Deploy Cloudflare Worker', conclusion: 'failure' }],
  );
  assert.equal((await deployFailed.getDeployStatus('a'.repeat(40))).state, 'failure');

  const unknown = createClient(async (url) => {
    if (url.endsWith('/app/installations/2/access_tokens')) return tokenResponse();
    return json({ workflow_runs: [] });
  }).client;
  assert.deepEqual(await unknown.getDeployStatus('a'.repeat(40)), { state: 'unknown' });
});

test('GitHub 429/5xx 映射为可重试的发布错误，且不泄露令牌', async () => {
  const rateLimited = createClient(async (url) => {
    if (url.endsWith('/app/installations/2/access_tokens')) return tokenResponse();
    return new Response('rate limited', { status: 429, headers: { 'Retry-After': '17' } });
  }).client;
  await assert.rejects(rateLimited.getRefSha('main'), (error: unknown) => {
    assert.ok(error instanceof PublishError);
    assert.equal(error.code, 'publish_rate_limited');
    assert.equal(error.retryAfter, 17);
    assert.ok(!error.message.includes('ghs_'));
    return true;
  });

  const unavailable = createClient(async (url) => {
    if (url.endsWith('/app/installations/2/access_tokens')) return tokenResponse();
    return new Response('boom', { status: 502 });
  }).client;
  await assert.rejects(
    unavailable.getRefSha('main'),
    (error: unknown) =>
      error instanceof PublishError && error.code === 'publish_github_unavailable',
  );

  const unauthorized = createClient(async (url) => {
    if (url.endsWith('/app/installations/2/access_tokens')) return tokenResponse();
    return new Response('unauthorized', { status: 401 });
  }).client;
  await assert.rejects(
    unauthorized.getRefSha('main'),
    (error: unknown) =>
      error instanceof PublishError && error.code === 'publish_github_unavailable',
  );
});

test('GitHub App 配置缺失或未配置仓库时 fail closed', async () => {
  const unconfigured = createGitHubPublishClient({});
  await assert.rejects(
    unconfigured.getRefSha('main'),
    (error: unknown) =>
      error instanceof PublishError && error.code === 'publish_github_unconfigured',
  );
  assert.throws(
    () => createGitHubPublishClient({ ...environment, GITHUB_PUBLISH_REPOSITORY: 'not-a-repo' }),
    (error: unknown) =>
      error instanceof PublishError && error.code === 'publish_github_unconfigured',
  );

  assert.equal(
    toPublishError(new GitHubAppError('github_app_not_configured')).code,
    'publish_github_unconfigured',
  );
  assert.equal(toPublishError(new GitHubAppError('github_rate_limited', 30)).retryAfter, 30);
  assert.equal(
    toPublishError(new GitHubAppError('github_service_unavailable')).code,
    'publish_github_unavailable',
  );
  const passthrough = new PublishError('publish_pr_conflict', 409);
  assert.equal(toPublishError(passthrough), passthrough);
});
