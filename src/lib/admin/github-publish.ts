/**
 * Server-side GitHub publish client.
 *
 * Wraps the least-privilege GitHub App installation token from
 * `github-app.ts` with the bounded REST operations needed by the Phase 4
 * publish pipeline. The token is only ever used server-side, is cached in
 * memory for its short lifetime, and never appears in responses or logs.
 *
 * All requests go to the fixed `https://api.github.com` host with an explicit
 * timeout and response byte budget. 401/403/429/5xx are translated into
 * deterministic publish errors so callers can show retryable states.
 */

import {
  createInstallationAccessToken,
  GitHubAppError,
  type GitHubAppEnvironment,
} from './github-app.ts';
import {
  PublishError,
  type CheckSummary,
  type DeployStatus,
  type PullSummary,
  type PublishFileSnapshot,
} from './publish.ts';

export interface GitHubPublishEnvironment extends GitHubAppEnvironment {
  GITHUB_PUBLISH_REPOSITORY?: string;
}

export interface GitHubPublishClient {
  repository: string;
  getRefSha(ref: string): Promise<string | null>;
  createRef(branch: string, sha: string): Promise<void>;
  getFile(path: string, ref: string): Promise<PublishFileSnapshot | null>;
  putFile(input: {
    path: string;
    branch: string;
    content: string;
    sha?: string;
    message: string;
  }): Promise<{ commitSha: string }>;
  findPull(headBranch: string): Promise<PullSummary | null>;
  createPull(input: {
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<PullSummary>;
  getPull(number: number): Promise<{
    pull: PullSummary;
    mergeable: boolean | null;
    mergeCommitSha?: string;
  }>;
  getChecks(sha: string): Promise<{ summary: CheckSummary; failing: string[] }>;
  getDeployStatus(sha: string): Promise<DeployStatus>;
  mergePull(input: {
    number: number;
    sha?: string;
  }): Promise<{ merged: boolean; message: string; sha?: string }>;
}

export interface GitHubPublishClientOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const SAFE_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const FAILURE_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
]);
const PENDING_STATES = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending']);

function readRepository(environment: GitHubPublishEnvironment): string {
  const repository = (environment.GITHUB_PUBLISH_REPOSITORY ?? '0verme/my-skill-library').trim();
  if (!SAFE_REPOSITORY.test(repository)) {
    throw new PublishError('publish_github_unconfigured', 503);
  }
  return repository;
}

function toBase64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8_000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function fromBase64(value: string) {
  const normalized = value.replace(/\s+/g, '');
  const binary = atob(normalized);
  return new TextDecoder('utf-8', { fatal: true }).decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

export function toPublishError(error: unknown): PublishError {
  if (error instanceof PublishError) return error;
  if (error instanceof GitHubAppError) {
    if (error.code === 'github_app_not_configured') {
      return new PublishError('publish_github_unconfigured', 503);
    }
    if (error.code === 'github_rate_limited') {
      return new PublishError('publish_rate_limited', 429, {
        ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
      });
    }
    return new PublishError('publish_github_unavailable', 502);
  }
  return new PublishError('publish_internal_error', 500);
}

interface RawPull {
  number?: unknown;
  html_url?: unknown;
  state?: unknown;
  merged_at?: unknown;
  head?: { sha?: unknown };
}

function mapPull(raw: unknown): PullSummary | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as RawPull;
  if (
    typeof record.number !== 'number' ||
    typeof record.html_url !== 'string' ||
    (record.state !== 'open' && record.state !== 'closed')
  ) {
    return null;
  }
  const state: PullSummary['state'] =
    typeof record.merged_at === 'string' && record.merged_at
      ? 'merged'
      : record.state === 'open'
        ? 'open'
        : 'closed';
  return {
    number: record.number,
    url: record.html_url,
    state,
    headSha: typeof record.head?.sha === 'string' ? record.head.sha : '',
  };
}

export function createGitHubPublishClient(
  environment: GitHubPublishEnvironment,
  options: GitHubPublishClientOptions = {},
): GitHubPublishClient {
  const repository = readRepository(environment);
  const [owner] = repository.split('/') as [string, string];
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 8_000, 15_000));
  const maxResponseBytes = Math.max(
    16 * 1024,
    Math.min(options.maxResponseBytes ?? 2 * 1024 * 1024, 4 * 1024 * 1024),
  );
  let cachedToken: { token: string; expiresAtMs: number } | null = null;

  async function token() {
    const current = now();
    if (cachedToken && cachedToken.expiresAtMs - 5 * 60 * 1_000 > current) {
      return cachedToken.token;
    }
    const result = await createInstallationAccessToken(environment, {
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      ...(options.now ? { now: options.now } : {}),
      timeoutMs,
    });
    const expiresAtMs = Date.parse(result.expiresAt);
    cachedToken = {
      token: result.token,
      expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : current + 50 * 60 * 1_000,
    };
    return cachedToken.token;
  }

  async function request(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: Record<string, unknown> | null; response: Response }> {
    let tokenValue: string;
    try {
      tokenValue = await token();
    } catch (error) {
      throw toPublishError(error);
    }
    let response: Response;
    try {
      response = await fetcher(`https://api.github.com${path}`, {
        method: init.method ?? 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${tokenValue}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'my-skill-library-publish/1.0',
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new PublishError('publish_github_unavailable', 502);
    }

    if (response.status === 401) {
      cachedToken = null;
      await response.body?.cancel();
      throw new PublishError('publish_github_unavailable', 502);
    }
    if (response.status === 403 || response.status === 429) {
      const retryAfter = Number(response.headers.get('Retry-After'));
      const rateLimited =
        response.status === 429 ||
        response.headers.has('Retry-After') ||
        response.headers.get('X-RateLimit-Remaining') === '0';
      await response.body?.cancel();
      if (rateLimited) {
        throw new PublishError('publish_rate_limited', 429, {
          retryAfter: Number.isFinite(retryAfter) ? Math.max(1, Math.min(retryAfter, 3_600)) : 60,
        });
      }
      throw new PublishError('publish_github_unavailable', 502);
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return { status: response.status, body: null, response };
    }
    if (response.status === 409 || response.status === 422) {
      await response.body?.cancel();
      return { status: response.status, body: null, response };
    }
    if (response.status >= 500) {
      await response.body?.cancel();
      throw new PublishError('publish_github_unavailable', 502);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new PublishError('publish_github_unavailable', 502);
    }
    if (response.status === 204) return { status: 204, body: null, response };

    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxResponseBytes) {
      throw new PublishError('publish_github_unavailable', 502);
    }
    if (text.length === 0) return { status: response.status, body: {}, response };
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object') {
        throw new Error('invalid');
      }
      return {
        status: response.status,
        body: (Array.isArray(parsed) ? { items: parsed } : parsed) as Record<string, unknown>,
        response,
      };
    } catch {
      throw new PublishError('publish_github_unavailable', 502);
    }
  }

  function encodePath(path: string) {
    return path
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
  }

  return {
    repository,
    async getRefSha(ref) {
      const { status, body } = await request(
        `/repos/${repository}/git/ref/heads/${encodeURIComponent(ref)}`,
      );
      if (status === 404 || !body) return null;
      const object = body.object as { sha?: unknown } | undefined;
      return typeof object?.sha === 'string' ? object.sha : null;
    },
    async createRef(branch, sha) {
      const { status } = await request(`/repos/${repository}/git/refs`, {
        method: 'POST',
        body: { ref: `refs/heads/${branch}`, sha },
      });
      if (status !== 201 && status !== 422) {
        throw new PublishError('publish_github_unavailable', 502);
      }
    },
    async getFile(path, ref) {
      const { status, body } = await request(
        `/repos/${repository}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
      );
      if (status === 404 || !body) return null;
      if (
        typeof body.sha !== 'string' ||
        typeof body.content !== 'string' ||
        body.encoding !== 'base64'
      ) {
        throw new PublishError('publish_github_unavailable', 502);
      }
      if (typeof body.size === 'number' && body.size > 256 * 1024) {
        throw new PublishError('publish_content_too_large', 413);
      }
      let text: string;
      try {
        text = fromBase64(body.content);
      } catch {
        throw new PublishError('publish_github_unavailable', 502);
      }
      return { text, sha: body.sha };
    },
    async putFile(input) {
      const { status, body } = await request(
        `/repos/${repository}/contents/${encodePath(input.path)}`,
        {
          method: 'PUT',
          body: {
            message: input.message,
            content: toBase64(input.content),
            branch: input.branch,
            ...(input.sha ? { sha: input.sha } : {}),
          },
        },
      );
      if (status === 409 || status === 422) {
        throw new PublishError('publish_pr_conflict', 409);
      }
      const commit = body?.commit as { sha?: unknown } | undefined;
      if (status !== 200 && status !== 201) {
        throw new PublishError('publish_github_unavailable', 502);
      }
      return { commitSha: typeof commit?.sha === 'string' ? commit.sha : '' };
    },
    async findPull(headBranch) {
      const { status, body } = await request(
        `/repos/${repository}/pulls?head=${encodeURIComponent(`${owner}:${headBranch}`)}&state=all&per_page=20`,
      );
      if (status === 404 || !body) return null;
      const items = body.items as unknown[] | undefined;
      if (!Array.isArray(items)) return null;
      const pulls = items.map(mapPull).filter((pull): pull is PullSummary => Boolean(pull));
      return pulls.find((pull) => pull.state === 'open') ?? pulls[0] ?? null;
    },
    async createPull(input) {
      const { status, body } = await request(`/repos/${repository}/pulls`, {
        method: 'POST',
        body: { title: input.title, body: input.body, head: input.head, base: input.base },
      });
      const pull = mapPull(body);
      if (status !== 201 || !pull) {
        if (status === 422) throw new PublishError('publish_pr_conflict', 409);
        throw new PublishError('publish_github_unavailable', 502);
      }
      return pull;
    },
    async getPull(number) {
      const { status, body } = await request(`/repos/${repository}/pulls/${number}`);
      const pull = status === 200 ? mapPull(body) : null;
      if (!pull || !body) throw new PublishError('publish_github_unavailable', 502);
      return {
        pull,
        mergeable: typeof body.mergeable === 'boolean' ? body.mergeable : null,
        ...(typeof body.merge_commit_sha === 'string' && body.merge_commit_sha
          ? { mergeCommitSha: body.merge_commit_sha }
          : {}),
      };
    },
    async getChecks(sha) {
      const failing = new Set<string>();
      let pending = false;
      let success = false;
      const checkRuns = await request(
        `/repos/${repository}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`,
      );
      if (checkRuns.status === 200 && checkRuns.body) {
        const items = checkRuns.body.check_runs as unknown[] | undefined;
        if (Array.isArray(items)) {
          for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            const record = item as { name?: unknown; status?: unknown; conclusion?: unknown };
            const checkName = typeof record.name === 'string' ? record.name : 'check';
            if (record.status !== 'completed') {
              pending = true;
            } else if (
              typeof record.conclusion === 'string' &&
              FAILURE_CONCLUSIONS.has(record.conclusion)
            ) {
              failing.add(checkName);
            } else if (record.conclusion === 'success') {
              success = true;
            }
          }
        }
      }
      const runs = await request(
        `/repos/${repository}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=20`,
      );
      if (runs.status === 200 && runs.body) {
        const items = runs.body.workflow_runs as unknown[] | undefined;
        if (Array.isArray(items)) {
          for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            const record = item as {
              name?: unknown;
              status?: unknown;
              conclusion?: unknown;
            };
            const runName = typeof record.name === 'string' ? record.name : 'workflow';
            if (typeof record.status === 'string' && PENDING_STATES.has(record.status)) {
              pending = true;
            } else if (
              typeof record.conclusion === 'string' &&
              FAILURE_CONCLUSIONS.has(record.conclusion)
            ) {
              failing.add(runName);
            } else if (record.conclusion === 'success') {
              success = true;
            }
          }
        }
      }
      const summary: CheckSummary =
        failing.size > 0 ? 'failed' : pending ? 'pending' : success ? 'passed' : 'none';
      return { summary, failing: [...failing] };
    },
    async getDeployStatus(sha) {
      const runs = await request(
        `/repos/${repository}/actions/runs?head_sha=${encodeURIComponent(sha)}&event=push&per_page=20`,
      );
      if (runs.status !== 200 || !runs.body) return { state: 'unknown' };
      const items = runs.body.workflow_runs as unknown[] | undefined;
      if (!Array.isArray(items)) return { state: 'unknown' };
      const run = items
        .filter(
          (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object',
        )
        .find((item) => item.name === 'CI');
      if (!run) return { state: 'unknown' };
      const runUrl = typeof run.html_url === 'string' ? run.html_url : undefined;
      const runId = typeof run.id === 'number' ? run.id : null;
      if (typeof run.status === 'string' && PENDING_STATES.has(run.status)) {
        return { state: 'running', ...(runUrl ? { runUrl } : {}) };
      }
      if (typeof run.conclusion === 'string' && FAILURE_CONCLUSIONS.has(run.conclusion)) {
        return { state: 'failure', ...(runUrl ? { runUrl } : {}) };
      }
      if (run.conclusion !== 'success') {
        return { state: 'unknown', ...(runUrl ? { runUrl } : {}) };
      }
      if (!runId) return { state: 'success', ...(runUrl ? { runUrl } : {}) };
      const jobs = await request(`/repos/${repository}/actions/runs/${runId}/jobs?per_page=50`);
      if (jobs.status !== 200 || !jobs.body)
        return { state: 'success', ...(runUrl ? { runUrl } : {}) };
      const jobItems = jobs.body.jobs as unknown[] | undefined;
      if (!Array.isArray(jobItems)) return { state: 'success', ...(runUrl ? { runUrl } : {}) };
      for (const job of jobItems) {
        if (!job || typeof job !== 'object') continue;
        const steps = (job as { steps?: unknown }).steps;
        if (!Array.isArray(steps)) continue;
        for (const step of steps) {
          if (!step || typeof step !== 'object') continue;
          const record = step as { name?: unknown; conclusion?: unknown };
          if (record.name === 'Deploy Cloudflare Worker') {
            if (record.conclusion === 'success')
              return { state: 'success', ...(runUrl ? { runUrl } : {}) };
            if (
              typeof record.conclusion === 'string' &&
              FAILURE_CONCLUSIONS.has(record.conclusion)
            ) {
              return { state: 'failure', ...(runUrl ? { runUrl } : {}) };
            }
            return { state: 'running', ...(runUrl ? { runUrl } : {}) };
          }
        }
      }
      return { state: 'success', ...(runUrl ? { runUrl } : {}) };
    },
    async mergePull(input) {
      const { status, body } = await request(`/repos/${repository}/pulls/${input.number}/merge`, {
        method: 'PUT',
        body: {
          merge_method: 'squash',
          ...(input.sha ? { sha: input.sha } : {}),
        },
      });
      if (status === 200) {
        const merged = body?.merged;
        return {
          merged: merged !== false,
          message: typeof body?.message === 'string' ? body.message : 'merged',
          ...(typeof body?.sha === 'string' && body.sha ? { sha: body.sha } : {}),
        };
      }
      if (status === 405 || status === 409) {
        return { merged: false, message: 'merge_blocked' };
      }
      throw new PublishError('publish_github_unavailable', 502);
    },
  };
}
