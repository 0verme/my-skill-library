import { isAlias, isMap, isSeq, parseDocument } from 'yaml';
import { unified } from 'unified';
import remarkParse from 'remark-parse';

export const GITHUB_IMPORT_LIMITS = {
  requestTimeoutMs: 8_000,
  maxTotalDurationMs: 30_000,
  maxApiRequests: 64,
  maxApiResponseBytes: 2 * 1024 * 1024,
  maxTotalApiBytes: 5 * 1024 * 1024,
  maxDiscoveredSkills: 24,
  maxSkillBytes: 128 * 1024,
  maxLicenseBytes: 32 * 1024,
  maxFrontmatterBytes: 16 * 1024,
  maxMarkdownNodes: 10_000,
  maxPathDepth: 24,
  maxRefSegments: 12,
  concurrency: 3,
} as const;

export type ImportLicenseStatus = 'redistributable' | 'restricted' | 'unknown';
export type ImportCandidateState =
  'new' | 'already-imported' | 'update-available' | 'slug-conflict';

export interface ExistingImportEntry {
  slug: string;
  sourceRepo?: string;
  sourcePath?: string;
  sourceSha?: string;
  importedSnapshotHash?: string;
}

export interface ImportCandidate {
  sourceRepo: string;
  sourcePath: string;
  sourceUrl: string;
  sourceSha: string;
  sourceAttribution: string;
  license: string;
  licenseStatus: ImportLicenseStatus;
  sourceStatus: 'unverified';
  name: string;
  description: string | null;
  suggestedSlug: string;
  mode: 'content-preview' | 'metadata-only';
  markdownPreview?: string;
  markdownWarnings: string[];
  state: ImportCandidateState;
  existingSlug?: string;
  updateRequiresConfirmation: boolean;
  preserveLocalChanges: boolean;
  selectable: boolean;
}

export interface ImportPreview {
  requestedUrl: string;
  sourceRepo: string;
  resolvedRef: string;
  sourceSha: string;
  candidates: ImportCandidate[];
  errors: Array<{ code: string; path?: string }>;
  warnings: string[];
  partial: boolean;
}

export type GitHubImportErrorCode =
  | 'invalid_source_url'
  | 'unsupported_github_url'
  | 'invalid_repository_path'
  | 'skill_file_required'
  | 'repository_not_found_or_private'
  | 'invalid_github_response'
  | 'github_rate_limited'
  | 'github_timeout'
  | 'github_unavailable'
  | 'api_request_limit'
  | 'response_too_large'
  | 'total_response_limit'
  | 'tree_too_large_or_truncated'
  | 'invalid_source_path'
  | 'no_skill_files'
  | 'invalid_frontmatter'
  | 'invalid_skill_metadata'
  | 'invalid_skill_encoding';

export class GitHubImportError extends Error {
  readonly status: number;
  readonly code: GitHubImportErrorCode;
  readonly retryAfter?: number;

  constructor(code: GitHubImportErrorCode, status: number, options: { retryAfter?: number } = {}) {
    super(code);
    this.name = 'GitHubImportError';
    this.code = code;
    this.status = status;
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter;
  }
}

interface ParsedGitHubSource {
  owner: string;
  repository: string;
  sourceRepo: string;
  mode: 'repository' | 'tree' | 'blob';
  tail: string[];
  requestedUrl: string;
}

interface GitTreeEntry {
  path: string;
  mode?: string;
  type?: string;
  sha?: string;
  size?: number;
}

const SAFE_REPOSITORY_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const SAFE_REPOSITORY_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const FULL_GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const REDISTRIBUTABLE_SPDX = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
]);
const DIRECT_LICENSE_NAMES = new Set(['LICENSE', 'LICENSE.MD', 'LICENSE.TXT', 'COPYING']);
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function hasControlCharacters(value: string) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function decodeUrlSegment(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new GitHubImportError('invalid_source_url', 400);
  }
  if (
    !decoded ||
    decoded.includes('/') ||
    decoded.includes('\\') ||
    decoded === '.' ||
    decoded === '..' ||
    hasControlCharacters(decoded) ||
    /%[0-9a-f]{2}/i.test(decoded)
  ) {
    throw new GitHubImportError('invalid_repository_path', 400);
  }
  return decoded;
}

function isSafeGitRef(ref: string) {
  return (
    ref.length > 0 &&
    ref.length <= 250 &&
    !ref.startsWith('/') &&
    !ref.endsWith('/') &&
    !ref.includes('//') &&
    !ref.includes('..') &&
    !ref.includes('@{') &&
    !ref.endsWith('.lock') &&
    !/[\u0000-\u0020~^:?*[\\]/.test(ref)
  );
}

export function isSafeGitHubPath(value: string) {
  if (!value || value.startsWith('/') || value.includes('\\') || hasControlCharacters(value)) {
    return false;
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false;
  try {
    const decoded = segments.map((segment) => decodeURIComponent(segment));
    return decoded.every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.includes('/') &&
        !segment.includes('\\') &&
        !hasControlCharacters(segment) &&
        !/%[0-9a-f]{2}/i.test(segment),
    );
  } catch {
    return false;
  }
}

export function parseGitHubSourceUrl(input: string): ParsedGitHubSource {
  if (typeof input !== 'string' || input.length > 2_048 || input.trim() !== input || !input) {
    throw new GitHubImportError('invalid_source_url', 400);
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new GitHubImportError('invalid_source_url', 400);
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new GitHubImportError('unsupported_github_url', 400);
  }

  const rawPathMatch = input.match(/^https:\/\/github\.com\/([^?#]*)$/i);
  if (!rawPathMatch) throw new GitHubImportError('invalid_source_url', 400);
  const rawParts = rawPathMatch[1]!.split('/');
  if (rawParts.at(-1) === '') rawParts.pop();
  if (rawParts.some((part) => !part)) throw new GitHubImportError('invalid_repository_path', 400);
  const parts = rawParts.map(decodeUrlSegment);
  if (parts.length < 2) throw new GitHubImportError('invalid_source_url', 400);

  const owner = parts[0]!;
  const rawRepository = parts[1]!;
  const repository = rawRepository.endsWith('.git') ? rawRepository.slice(0, -4) : rawRepository;
  if (
    !SAFE_REPOSITORY_SEGMENT.test(owner) ||
    !SAFE_REPOSITORY_NAME.test(repository) ||
    repository === '.' ||
    repository === '..'
  ) {
    throw new GitHubImportError('invalid_source_url', 400);
  }

  let mode: ParsedGitHubSource['mode'] = 'repository';
  let tail: string[] = [];
  if (parts.length > 2) {
    if (parts[2] !== 'tree' && parts[2] !== 'blob') {
      throw new GitHubImportError('unsupported_github_url', 400);
    }
    mode = parts[2];
    tail = parts.slice(3);
    if (mode === 'blob' && (tail.length < 2 || tail.at(-1) !== 'SKILL.md')) {
      throw new GitHubImportError('skill_file_required', 400);
    }
    if (tail.length > GITHUB_IMPORT_LIMITS.maxPathDepth + GITHUB_IMPORT_LIMITS.maxRefSegments) {
      throw new GitHubImportError('invalid_repository_path', 400);
    }
    if (tail.some((part) => part === '.' || part === '..')) {
      throw new GitHubImportError('invalid_repository_path', 400);
    }
  }

  return {
    owner,
    repository,
    sourceRepo: `${owner}/${repository}`,
    mode,
    tail,
    requestedUrl: input,
  };
}

function retryAfterSeconds(headers: Headers, now: number) {
  const retryAfter = headers.get('Retry-After');
  if (retryAfter) {
    const value = Number(retryAfter);
    if (Number.isFinite(value) && value >= 0) return Math.max(1, Math.min(3_600, Math.ceil(value)));
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) {
      return Math.max(1, Math.min(3_600, Math.ceil((timestamp - now) / 1_000)));
    }
  }
  const reset = Number(headers.get('X-RateLimit-Reset'));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(1, Math.min(3_600, Math.ceil(reset - now / 1_000)));
  }
  return 60;
}

async function readResponseText(
  response: Response,
  maxBytes: number,
  addBytes: (size: number) => void,
): Promise<string> {
  const declaredLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new GitHubImportError('response_too_large', 413);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new GitHubImportError('response_too_large', 413);
      }
      addBytes(value.byteLength);
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof GitHubImportError) throw error;
    throw new GitHubImportError('github_unavailable', 502);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new GitHubImportError('invalid_github_response', 502);
  }
}

class GitHubApiClient {
  private requestCount = 0;
  private totalBytes = 0;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly startedAt = Date.now();

  constructor(options: { fetcher?: typeof fetch; now?: () => number } = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getJson(path: string, maxResponseBytes = GITHUB_IMPORT_LIMITS.maxApiResponseBytes) {
    this.requestCount += 1;
    if (this.requestCount > GITHUB_IMPORT_LIMITS.maxApiRequests) {
      throw new GitHubImportError('api_request_limit', 413);
    }

    const remainingTime = GITHUB_IMPORT_LIMITS.maxTotalDurationMs - (Date.now() - this.startedAt);
    if (remainingTime <= 0) throw new GitHubImportError('github_timeout', 504);
    const controller = new AbortController();
    const timeoutMs = Math.min(GITHUB_IMPORT_LIMITS.requestTimeoutMs, remainingTime);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetcher(`https://api.github.com${path}`, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'my-skill-library-safe-import/1.0',
        },
        redirect: 'error',
        signal: controller.signal,
      });

      if (response.status === 404 || response.status === 422) {
        await response.body?.cancel();
        return null;
      }
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.has('Retry-After') ||
            response.headers.get('X-RateLimit-Remaining') === '0'))
      ) {
        const retryAfter = retryAfterSeconds(response.headers, this.now());
        await response.body?.cancel();
        throw new GitHubImportError('github_rate_limited', 429, { retryAfter });
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new GitHubImportError('repository_not_found_or_private', 404);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new GitHubImportError('github_unavailable', 502);
      }

      const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? '';
      if (!contentType.includes('application/json') && !contentType.includes('+json')) {
        await response.body?.cancel();
        throw new GitHubImportError('invalid_github_response', 502);
      }
      const text = await readResponseText(response, maxResponseBytes, (size) => {
        this.totalBytes += size;
        if (this.totalBytes > GITHUB_IMPORT_LIMITS.maxTotalApiBytes) {
          throw new GitHubImportError('total_response_limit', 413);
        }
      });
      if (
        controller.signal.aborted ||
        Date.now() - this.startedAt > GITHUB_IMPORT_LIMITS.maxTotalDurationMs
      ) {
        throw new GitHubImportError('github_timeout', 504);
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new GitHubImportError('invalid_github_response', 502);
      }
      if (json === null || typeof json !== 'object' || Array.isArray(json)) {
        throw new GitHubImportError('invalid_github_response', 502);
      }
      return json as Record<string, unknown>;
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        throw new GitHubImportError('github_timeout', 504);
      }
      if (error instanceof GitHubImportError) throw error;
      throw new GitHubImportError('github_unavailable', 502);
    } finally {
      clearTimeout(timer);
    }
  }
}

function apiRepoPath(sourceRepo: string, path: string) {
  const [owner, repository] = sourceRepo.split('/');
  return `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repository!)}${path}`;
}

function base64BlobPath(sourceRepo: string, sha: string) {
  return apiRepoPath(sourceRepo, `/git/blobs/${encodeURIComponent(sha)}`);
}

async function getJsonForRepo(
  api: GitHubApiClient,
  sourceRepo: string,
  path: string,
  maxBytes?: number,
) {
  return api.getJson(apiRepoPath(sourceRepo, path), maxBytes);
}

async function getBlobTextForRepo(
  api: GitHubApiClient,
  sourceRepo: string,
  sha: string,
  maxBytes: number,
) {
  const blob = await api.getJson(base64BlobPath(sourceRepo, sha), maxBytes * 2 + 16 * 1024);
  if (!blob || blob.encoding !== 'base64' || typeof blob.content !== 'string') {
    throw new GitHubImportError('invalid_github_response', 502);
  }
  const encoded = blob.content.replace(/\s+/g, '');
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    throw new GitHubImportError('invalid_github_response', 502);
  }
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new GitHubImportError('invalid_github_response', 502);
  }
  if (binary.length > maxBytes || (typeof blob.size === 'number' && blob.size > maxBytes)) {
    throw new GitHubImportError('response_too_large', 413);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new GitHubImportError('invalid_skill_encoding', 422);
  }
}

async function resolveCommitAndTree(
  api: GitHubApiClient,
  sourceRepo: string,
  ref: string,
): Promise<{ commitSha: string; tree: GitTreeEntry[]; truncated: boolean } | null> {
  if (!isSafeGitRef(ref)) return null;
  const commit = await getJsonForRepo(api, sourceRepo, `/commits/${encodeURIComponent(ref)}`);
  if (!commit) return null;
  const commitSha = typeof commit.sha === 'string' ? commit.sha : '';
  if (!FULL_GIT_SHA.test(commitSha)) throw new GitHubImportError('invalid_github_response', 502);
  const treeResponse = await getJsonForRepo(
    api,
    sourceRepo,
    `/git/trees/${encodeURIComponent(commitSha)}?recursive=1`,
  );
  if (!treeResponse || !Array.isArray(treeResponse.tree)) {
    throw new GitHubImportError('invalid_github_response', 502);
  }
  const tree: GitTreeEntry[] = [];
  for (const item of treeResponse.tree) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>).path === 'string' &&
      typeof (item as Record<string, unknown>).type === 'string'
    ) {
      tree.push(item as GitTreeEntry);
    }
  }
  return { commitSha, tree, truncated: treeResponse.truncated === true };
}

function isRegularBlob(entry: GitTreeEntry | undefined) {
  return Boolean(
    entry &&
    entry.type === 'blob' &&
    entry.mode !== '120000' &&
    entry.mode !== '160000' &&
    typeof entry.sha === 'string' &&
    FULL_GIT_SHA.test(entry.sha),
  );
}

function treeHasDirectory(tree: GitTreeEntry[], directory: string) {
  if (!directory) return true;
  return (
    tree.some(
      (entry) => entry.path === directory && entry.type === 'tree' && entry.mode !== '160000',
    ) || tree.some((entry) => entry.path.startsWith(`${directory}/`))
  );
}

function treeMatchesRequest(
  tree: GitTreeEntry[],
  mode: 'repository' | 'tree' | 'blob',
  requestedPath: string,
  truncated = false,
) {
  if (mode === 'blob') return tree.some((entry) => entry.path === requestedPath);
  if (!treeHasDirectory(tree, requestedPath)) return false;
  if (truncated) return true;
  const prefix = requestedPath ? `${requestedPath}/` : '';
  return tree.some((entry) => entry.path.startsWith(prefix) && entry.path.endsWith('SKILL.md'));
}

interface ResolvedSource {
  commitSha: string;
  resolvedRef: string;
  tree: GitTreeEntry[];
  requestedPath: string;
  mode: 'repository' | 'tree' | 'blob';
  truncated: boolean;
}

async function resolveSource(
  source: ParsedGitHubSource,
  api: GitHubApiClient,
): Promise<ResolvedSource> {
  if (source.mode === 'repository') {
    const repository = await getJsonForRepo(api, source.sourceRepo, '');
    const defaultBranch = repository?.default_branch;
    if (typeof defaultBranch !== 'string' || !isSafeGitRef(defaultBranch)) {
      throw new GitHubImportError('repository_not_found_or_private', 404);
    }
    const resolved = await resolveCommitAndTree(api, source.sourceRepo, defaultBranch);
    if (!resolved) throw new GitHubImportError('repository_not_found_or_private', 404);
    return {
      ...resolved,
      resolvedRef: defaultBranch,
      requestedPath: '',
      mode: 'repository',
    };
  }

  if (source.mode === 'blob' && source.tail.at(-1) !== 'SKILL.md') {
    throw new GitHubImportError('skill_file_required', 400);
  }
  if (source.tail.length === 0) throw new GitHubImportError('invalid_source_path', 400);

  const minSplit = source.mode === 'blob' ? 1 : 1;
  const maxSplit = source.mode === 'blob' ? source.tail.length - 1 : source.tail.length;
  let attempts = 0;
  let sawTruncatedTree = false;
  for (let split = maxSplit; split >= minSplit; split -= 1) {
    const refParts = source.tail.slice(0, split);
    if (refParts.length > GITHUB_IMPORT_LIMITS.maxRefSegments) continue;
    const ref = refParts.join('/');
    if (!isSafeGitRef(ref)) continue;
    const requestedPath = source.tail.slice(split).join('/');
    if (requestedPath && !isSafeGitHubPath(requestedPath)) continue;
    if (source.mode === 'blob' && !requestedPath.endsWith('SKILL.md')) continue;
    attempts += 1;
    if (attempts > GITHUB_IMPORT_LIMITS.maxRefSegments) break;

    const resolved = await resolveCommitAndTree(api, source.sourceRepo, ref);
    if (!resolved) continue;
    if (resolved.truncated) sawTruncatedTree = true;
    if (!treeMatchesRequest(resolved.tree, source.mode, requestedPath, resolved.truncated))
      continue;
    return {
      ...resolved,
      resolvedRef: ref,
      requestedPath,
      mode: source.mode,
    };
  }
  if (attempts === 0) throw new GitHubImportError('invalid_repository_path', 400);
  if (sawTruncatedTree) throw new GitHubImportError('tree_too_large_or_truncated', 413);
  throw new GitHubImportError('invalid_source_path', 404);
}

function countPathDepth(value: string) {
  return value ? value.split('/').length : 0;
}

function safeSlugFromPath(sourcePath: string) {
  const directory = sourcePath.split('/').slice(0, -1).at(-1) ?? sourcePath.replace(/\.md$/i, '');
  const slug = directory
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return slug || 'imported-skill';
}

function canonicalSkillUrl(sourceRepo: string, commitSha: string, path: string) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${sourceRepo}/blob/${commitSha}/${encodedPath}`;
}

function normalizeIdentityRepo(value: string) {
  return value.toLowerCase();
}

function sameSource(entry: ExistingImportEntry, sourceRepo: string, sourcePath: string) {
  return (
    typeof entry.sourceRepo === 'string' &&
    typeof entry.sourcePath === 'string' &&
    normalizeIdentityRepo(entry.sourceRepo) === normalizeIdentityRepo(sourceRepo) &&
    entry.sourcePath === sourcePath
  );
}

function entrySlug(entry: ExistingImportEntry) {
  return typeof entry.slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.slug)
    ? entry.slug
    : undefined;
}

function getImportState(
  catalog: ExistingImportEntry[],
  sourceRepo: string,
  sourcePath: string,
  sourceSha: string,
  suggestedSlug: string,
) {
  const match = catalog.find((entry) => sameSource(entry, sourceRepo, sourcePath));
  if (match) {
    const slug = entrySlug(match);
    const existing = slug ? { existingSlug: slug } : {};
    if (match.sourceSha?.toLowerCase() === sourceSha.toLowerCase()) {
      return { state: 'already-imported' as const, ...existing, selectable: false };
    }
    return { state: 'update-available' as const, ...existing, selectable: true };
  }
  const slugCollision = catalog.find(
    (entry) => entrySlug(entry)?.toLowerCase() === suggestedSlug.toLowerCase(),
  );
  if (slugCollision) {
    const existing = entrySlug(slugCollision);
    return {
      state: 'slug-conflict' as const,
      ...(existing ? { existingSlug: existing } : {}),
      selectable: false,
    };
  }
  return { state: 'new' as const, selectable: true };
}

function hasYamlAliasOrAnchor(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  if (isAlias(node)) return true;
  if (isMap(node)) {
    if (node.anchor) return true;
    return node.items.some(
      (item) => hasYamlAliasOrAnchor(item.key) || hasYamlAliasOrAnchor(item.value),
    );
  }
  if (isSeq(node)) {
    if (node.anchor) return true;
    return node.items.some((item) => hasYamlAliasOrAnchor(item));
  }
  return 'anchor' in node && Boolean((node as { anchor?: unknown }).anchor);
}

function assertSafeYamlValue(
  value: unknown,
  depth = 0,
  budget = { count: 0 },
): asserts value is unknown {
  budget.count += 1;
  if (budget.count > 2_000 || depth > 16) throw new GitHubImportError('invalid_frontmatter', 422);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new GitHubImportError('invalid_frontmatter', 422);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSafeYamlValue(item, depth + 1, budget);
    return;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new GitHubImportError('invalid_frontmatter', 422);
    }
    for (const [key, item] of Object.entries(value)) {
      if (PROTOTYPE_KEYS.has(key)) throw new GitHubImportError('invalid_frontmatter', 422);
      assertSafeYamlValue(item, depth + 1, budget);
    }
    return;
  }
  throw new GitHubImportError('invalid_frontmatter', 422);
}

interface ParsedSkillMarkdown {
  name: string;
  description: string;
  body: string;
}

export function parseSkillMarkdown(markdown: string): ParsedSkillMarkdown {
  const frontmatterMatch = markdown.match(
    /^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[\t ]*(?:\r?\n|$)/,
  );
  if (!frontmatterMatch) throw new GitHubImportError('invalid_frontmatter', 422);
  const frontmatter = frontmatterMatch[1]!;
  if (new TextEncoder().encode(frontmatter).byteLength > GITHUB_IMPORT_LIMITS.maxFrontmatterBytes) {
    throw new GitHubImportError('invalid_frontmatter', 422);
  }

  let document;
  try {
    document = parseDocument(frontmatter, { schema: 'core', strict: true, uniqueKeys: true });
  } catch {
    throw new GitHubImportError('invalid_frontmatter', 422);
  }
  if (
    document.errors.length > 0 ||
    !isMap(document.contents) ||
    hasYamlAliasOrAnchor(document.contents)
  ) {
    throw new GitHubImportError('invalid_frontmatter', 422);
  }

  let metadata: unknown;
  try {
    metadata = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new GitHubImportError('invalid_frontmatter', 422);
  }
  assertSafeYamlValue(metadata);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new GitHubImportError('invalid_frontmatter', 422);
  }
  const fields = metadata as Record<string, unknown>;
  const name = fields.name;
  const description = fields.description;
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 160 ||
    hasControlCharacters(name) ||
    typeof description !== 'string' ||
    !description.trim() ||
    hasControlCharacters(description)
  ) {
    throw new GitHubImportError('invalid_skill_metadata', 422);
  }
  const body = markdown.slice(frontmatterMatch[0].length).replace(/^\r?\n/, '');
  if (new TextEncoder().encode(body).byteLength > GITHUB_IMPORT_LIMITS.maxSkillBytes) {
    throw new GitHubImportError('response_too_large', 413);
  }
  return { name: name.trim(), description: description.trim(), body };
}

interface MarkdownAudit {
  warnings: string[];
  safeToPreview: boolean;
}

interface MarkdownNode {
  type?: string;
  url?: unknown;
  children?: MarkdownNode[];
}

function auditMarkdown(markdown: string): MarkdownAudit {
  const warnings = new Set<string>();
  let tree: MarkdownNode;
  try {
    tree = unified().use(remarkParse).parse(markdown) as MarkdownNode;
  } catch {
    return { warnings: ['markdown_parse_failed'], safeToPreview: false };
  }

  const pending = [tree];
  let visitedNodes = 0;
  while (pending.length > 0) {
    const node = pending.pop()!;
    visitedNodes += 1;
    if (visitedNodes > GITHUB_IMPORT_LIMITS.maxMarkdownNodes) {
      warnings.add('markdown_node_limit_reached');
      break;
    }
    if (node.type === 'html') warnings.add('raw_html_not_rendered');
    if (node.type === 'image') warnings.add('external_media_not_copied');
    if (node.type === 'link' || node.type === 'image') {
      if (typeof node.url !== 'string') {
        warnings.add('invalid_markdown_link');
      } else {
        const destination = node.url.trim();
        if (destination.startsWith('#')) {
          // In-document anchors are inert in the text-only preview.
        } else {
          try {
            const parsed = new URL(destination);
            if (parsed.protocol === 'http:') warnings.add('http_link_requires_review');
            else if (
              parsed.protocol !== 'https:' ||
              parsed.username ||
              parsed.password ||
              !parsed.hostname
            ) {
              warnings.add('unsafe_markdown_link');
            }
          } catch {
            warnings.add('relative_link_not_resolved');
          }
        }
      }
    }
    const children = node.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]!);
    }
  }
  const unsafeWarnings = new Set([
    'raw_html_not_rendered',
    'unsafe_markdown_link',
    'invalid_markdown_link',
    'relative_link_not_resolved',
    'markdown_parse_failed',
    'markdown_node_limit_reached',
  ]);
  return {
    warnings: [...warnings],
    safeToPreview: ![...warnings].some((warning) => unsafeWarnings.has(warning)),
  };
}

function classifyLicense(
  licenseText: string | undefined,
  sourceRepo: string,
  skillDirectory: string,
) {
  if (
    normalizeIdentityRepo(sourceRepo) === 'anthropics/skills' &&
    skillDirectory === 'skills/docx'
  ) {
    return { license: 'Proprietary skill-specific terms', licenseStatus: 'restricted' as const };
  }
  if (!licenseText)
    return { license: 'Unknown (no per-Skill license found)', licenseStatus: 'unknown' as const };

  const spdx = licenseText.match(/^\s*SPDX-License-Identifier\s*:\s*([^\r\n]+)\s*$/im)?.[1]?.trim();
  if (spdx && REDISTRIBUTABLE_SPDX.has(spdx)) {
    return { license: spdx, licenseStatus: 'redistributable' as const };
  }
  if (spdx) {
    if (/proprietary|all rights reserved|license.?ref/i.test(spdx)) {
      return { license: spdx.slice(0, 120), licenseStatus: 'restricted' as const };
    }
    return { license: spdx.slice(0, 120), licenseStatus: 'unknown' as const };
  }

  const normalized = licenseText.toLowerCase();
  if (
    /proprietary|all rights reserved|not licensed for redistribution|may not be redistributed|no permission to redistribute|confidential/.test(
      normalized,
    )
  ) {
    return {
      license: 'Proprietary / redistribution restricted',
      licenseStatus: 'restricted' as const,
    };
  }
  if (/^\s*apache license,?\s+version\s+2\.0\s*$/im.test(licenseText)) {
    return { license: 'Apache-2.0', licenseStatus: 'redistributable' as const };
  }
  if (/^\s*mit license\s*$/im.test(licenseText)) {
    return { license: 'MIT', licenseStatus: 'redistributable' as const };
  }
  if (/^\s*bsd[- ]3[- ]clause(?: license)?\s*$/im.test(licenseText)) {
    return { license: 'BSD-3-Clause', licenseStatus: 'redistributable' as const };
  }
  if (/^\s*bsd[- ]2[- ]clause(?: license)?\s*$/im.test(licenseText)) {
    return { license: 'BSD-2-Clause', licenseStatus: 'redistributable' as const };
  }
  if (/^\s*isc license\s*$/im.test(licenseText)) {
    return { license: 'ISC', licenseStatus: 'redistributable' as const };
  }
  return { license: 'Unknown (license text requires review)', licenseStatus: 'unknown' as const };
}

function licenseFileForDirectory(tree: GitTreeEntry[], skillDirectory: string) {
  return tree.find((entry) => {
    if (!isRegularBlob(entry)) return false;
    const slash = entry.path.lastIndexOf('/');
    const parent = slash < 0 ? '' : entry.path.slice(0, slash);
    const filename = entry.path.slice(slash + 1).toUpperCase();
    return parent === skillDirectory && DIRECT_LICENSE_NAMES.has(filename);
  });
}

interface CandidateBuildResult {
  candidate?: ImportCandidate;
  error?: { code: string; path?: string };
}

async function buildCandidate(
  source: ParsedGitHubSource,
  sourceSha: string,
  tree: GitTreeEntry[],
  skillEntry: GitTreeEntry,
  api: GitHubApiClient,
  catalog: ExistingImportEntry[],
): Promise<CandidateBuildResult> {
  const sourcePath = skillEntry.path;
  if (
    !isSafeGitHubPath(sourcePath) ||
    countPathDepth(sourcePath) > GITHUB_IMPORT_LIMITS.maxPathDepth
  ) {
    return { error: { code: 'unsafe_or_deep_source_path', path: sourcePath } };
  }
  if (!isRegularBlob(skillEntry) || typeof skillEntry.sha !== 'string') {
    return { error: { code: 'unsupported_skill_file_type', path: sourcePath } };
  }
  if (typeof skillEntry.size === 'number' && skillEntry.size > GITHUB_IMPORT_LIMITS.maxSkillBytes) {
    return { error: { code: 'skill_file_too_large', path: sourcePath } };
  }

  const skillDirectory = sourcePath.slice(0, -'/SKILL.md'.length);
  const directory = sourcePath === 'SKILL.md' ? '' : skillDirectory;
  const licenseEntry = licenseFileForDirectory(tree, directory);
  let licenseText: string | undefined;
  let licenseWarning: string | undefined;
  if (licenseEntry && typeof licenseEntry.sha === 'string') {
    if (
      typeof licenseEntry.size === 'number' &&
      licenseEntry.size > GITHUB_IMPORT_LIMITS.maxLicenseBytes
    ) {
      licenseWarning = 'license_file_too_large';
    } else {
      try {
        licenseText = await getBlobTextForRepo(
          api,
          source.sourceRepo,
          licenseEntry.sha,
          GITHUB_IMPORT_LIMITS.maxLicenseBytes,
        );
      } catch (error) {
        if (error instanceof GitHubImportError && (error.status === 429 || error.status === 504)) {
          throw error;
        }
        return {
          error: {
            code: error instanceof GitHubImportError ? error.code : 'license_read_failed',
            path: licenseEntry.path,
          },
        };
      }
    }
  }

  const licenseInfo = classifyLicense(licenseText, source.sourceRepo, directory);
  const sourceUrl = canonicalSkillUrl(source.sourceRepo, sourceSha, sourcePath);
  const suggestedSlug = safeSlugFromPath(sourcePath);
  const importState = getImportState(
    catalog,
    source.sourceRepo,
    sourcePath,
    sourceSha,
    suggestedSlug,
  );
  const baseCandidate: ImportCandidate = {
    sourceRepo: source.sourceRepo,
    sourcePath,
    sourceUrl,
    sourceSha,
    sourceAttribution: source.sourceRepo,
    license: licenseInfo.license,
    licenseStatus: licenseInfo.licenseStatus,
    sourceStatus: 'unverified',
    name:
      sourcePath === 'SKILL.md' ? source.sourceRepo.split('/')[1]! : sourcePath.split('/').at(-2)!,
    description: null,
    suggestedSlug,
    mode: 'metadata-only',
    markdownWarnings: licenseWarning ? [licenseWarning] : [],
    ...importState,
    updateRequiresConfirmation: importState.state === 'update-available',
    preserveLocalChanges: importState.state === 'update-available',
  };

  if (licenseInfo.licenseStatus !== 'redistributable') {
    return { candidate: baseCandidate };
  }

  try {
    const markdown = await getBlobTextForRepo(
      api,
      source.sourceRepo,
      skillEntry.sha,
      GITHUB_IMPORT_LIMITS.maxSkillBytes,
    );
    const parsed = parseSkillMarkdown(markdown);
    const audit = auditMarkdown(parsed.body);
    baseCandidate.name = parsed.name;
    baseCandidate.description = parsed.description;
    baseCandidate.mode = 'content-preview';
    baseCandidate.markdownWarnings = [...baseCandidate.markdownWarnings, ...audit.warnings];
    if (audit.safeToPreview) baseCandidate.markdownPreview = parsed.body;
    return { candidate: baseCandidate };
  } catch (error) {
    const code = error instanceof GitHubImportError ? error.code : 'invalid_skill_markdown';
    if (error instanceof GitHubImportError && (error.status === 429 || error.status === 504))
      throw error;
    return { error: { code, path: sourcePath } };
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  callback: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await callback(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizeCatalog(catalog: ExistingImportEntry[]) {
  return catalog.filter((entry) => {
    return (
      entry &&
      typeof entry === 'object' &&
      typeof entry.slug === 'string' &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.slug) &&
      (!entry.sourceRepo ||
        /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(entry.sourceRepo)) &&
      (!entry.sourcePath || isSafeGitHubPath(entry.sourcePath)) &&
      (!entry.sourceSha || FULL_GIT_SHA.test(entry.sourceSha))
    );
  });
}

export async function discoverGitHubSkills(
  inputUrl: string,
  options: {
    fetcher?: typeof fetch;
    now?: () => number;
    catalog?: ExistingImportEntry[];
  } = {},
): Promise<ImportPreview> {
  const source = parseGitHubSourceUrl(inputUrl);
  const api = new GitHubApiClient({
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const catalog = normalizeCatalog(options.catalog ?? []);
  const resolved = await resolveSource(source, api);
  const warnings = new Set<string>();
  if (resolved.truncated) warnings.add('upstream_tree_truncated');

  let entries: GitTreeEntry[];
  if (resolved.mode === 'blob') {
    const selected = resolved.tree.find((entry) => entry.path === resolved.requestedPath);
    entries = selected ? [selected] : [];
  } else {
    const prefix = resolved.requestedPath ? `${resolved.requestedPath}/` : '';
    entries = resolved.tree.filter(
      (entry) => entry.path.startsWith(prefix) && entry.path.endsWith('SKILL.md'),
    );
  }

  const errors: Array<{ code: string; path?: string }> = [];
  const safeEntries = entries.filter((entry) => {
    if (!isSafeGitHubPath(entry.path)) {
      errors.push({ code: 'unsafe_upstream_path' });
      return false;
    }
    if (countPathDepth(entry.path) > GITHUB_IMPORT_LIMITS.maxPathDepth) {
      warnings.add('discovery_depth_limit_reached');
      return false;
    }
    if (entry.mode === '120000' || entry.mode === '160000') {
      errors.push({ code: 'symlink_or_submodule_not_imported', path: entry.path });
      return false;
    }
    return isRegularBlob(entry);
  });
  safeEntries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  if (safeEntries.length > GITHUB_IMPORT_LIMITS.maxDiscoveredSkills) {
    warnings.add('discovery_item_limit_reached');
  }
  const limitedEntries = safeEntries.slice(0, GITHUB_IMPORT_LIMITS.maxDiscoveredSkills);
  if (limitedEntries.length === 0) {
    if (errors.length > 0 || resolved.truncated) {
      return {
        requestedUrl: source.requestedUrl,
        sourceRepo: source.sourceRepo,
        resolvedRef: resolved.resolvedRef,
        sourceSha: resolved.commitSha,
        candidates: [],
        errors,
        warnings: [...warnings],
        partial: true,
      };
    }
    throw new GitHubImportError('no_skill_files', 422);
  }

  const results = await mapWithConcurrency(
    limitedEntries,
    GITHUB_IMPORT_LIMITS.concurrency,
    (entry) => buildCandidate(source, resolved.commitSha, resolved.tree, entry, api, catalog),
  );
  const candidates: ImportCandidate[] = [];
  for (const result of results) {
    if (result.candidate) candidates.push(result.candidate);
    if (result.error) errors.push(result.error);
  }
  return {
    requestedUrl: source.requestedUrl,
    sourceRepo: source.sourceRepo,
    resolvedRef: resolved.resolvedRef,
    sourceSha: resolved.commitSha,
    candidates,
    errors,
    warnings: [...warnings],
    partial: errors.length > 0 || warnings.size > 0,
  };
}
