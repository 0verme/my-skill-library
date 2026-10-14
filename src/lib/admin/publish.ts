/**
 * Phase 4 publish model.
 *
 * Pure, side-effect free logic shared by the Worker publish endpoints and the
 * Node tests. It never talks to GitHub itself: callers provide bounded
 * snapshots, and every decision (validation, idempotent action, state machine,
 * auto-merge gate) is deterministic and testable.
 *
 * Idempotency is anchored in GitHub (deterministic `content/<slug>` branch +
 * PR head lookup + content hash), never in isolate-local memory.
 */

import { stringify as stringifyYaml } from 'yaml';
import {
  computeSnapshotHash,
  normalizeEditorDraft,
  validateEditorDraft,
  type EditorDraft,
  type EditorGalleryItem,
  type EditorValidationIssue,
} from './editor-model.ts';

export const PUBLISH_LIMITS = {
  maxEntries: 8,
  maxRequestBytes: 256 * 1024,
  maxMarkdownBytes: 128 * 1024,
  maxPullBodyBytes: 16 * 1024,
} as const;

export const PUBLISH_BRANCH_PREFIX = 'content/';
export const PUBLISH_BASE_REF = 'main';

export type PublishErrorCode =
  | 'invalid_publish_request'
  | 'publish_validation_failed'
  | 'publish_confirmation_required'
  | 'publish_content_too_large'
  | 'publish_license_blocked'
  | 'publish_github_unconfigured'
  | 'publish_pr_conflict'
  | 'publish_not_ready'
  | 'publish_merge_blocked'
  | 'publish_rate_limited'
  | 'publish_github_unavailable'
  | 'publish_internal_error';

export class PublishError extends Error {
  readonly code: PublishErrorCode;
  readonly status: number;
  readonly retryAfter?: number;
  readonly issues?: EditorValidationIssue[];

  constructor(
    code: PublishErrorCode,
    status: number,
    options: { retryAfter?: number; issues?: EditorValidationIssue[] } = {},
  ) {
    super(code);
    this.name = 'PublishError';
    this.code = code;
    this.status = status;
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter;
    if (options.issues) this.issues = options.issues;
  }
}

export interface PublishEntryRequest {
  slug: string;
  draft: EditorDraft;
}

export interface PublishFileSnapshot {
  /** Raw published Markdown currently on the target branch, if any. */
  text: string | null;
  /** Blob sha of the existing file (needed by the contents API to update). */
  sha?: string;
}

export interface PullSummary {
  number: number;
  url: string;
  state: 'open' | 'closed' | 'merged';
  headSha: string;
}

export interface PublishEntryPlan {
  slug: string;
  branch: string;
  path: string;
  content: string;
  contentHash: string;
  action: 'create' | 'update' | 'noop' | 'blocked';
  blockedReasons: string[];
  validationIssues: EditorValidationIssue[];
  existingPull?: PullSummary;
  fileSha?: string;
}

export interface PublishSnapshot {
  file: PublishFileSnapshot | null;
  pull: PullSummary | null;
  /** True when the deterministic branch already exists. */
  branchExists: boolean;
}

export interface PublishValidationSummary {
  ok: boolean;
  issues: EditorValidationIssue[];
}

export function validatePublishEntryRequest(input: unknown): PublishEntryRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PublishError('invalid_publish_request', 400);
  }
  const record = input as Record<string, unknown>;
  const draft = normalizeEditorDraft(record.draft);
  if (!draft) throw new PublishError('invalid_publish_request', 400);
  const slug = typeof record.slug === 'string' ? record.slug.trim() : '';
  if (!slug || slug !== draft.slug) throw new PublishError('invalid_publish_request', 400);
  if (record.confirmPublish !== true) {
    throw new PublishError('publish_confirmation_required', 400);
  }
  return { slug, draft };
}

export function validatePublishRequest(input: unknown): PublishEntryRequest[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PublishError('invalid_publish_request', 400);
  }
  const entries = (input as Record<string, unknown>).entries;
  if (
    !Array.isArray(entries) ||
    entries.length === 0 ||
    entries.length > PUBLISH_LIMITS.maxEntries
  ) {
    throw new PublishError('invalid_publish_request', 400);
  }
  const seen = new Set<string>();
  const requests: PublishEntryRequest[] = [];
  for (const entry of entries) {
    const request = validatePublishEntryRequest(entry);
    if (seen.has(request.slug)) throw new PublishError('invalid_publish_request', 400);
    seen.add(request.slug);
    requests.push(request);
  }
  return requests;
}

export function branchNameForSlug(slug: string) {
  return `${PUBLISH_BRANCH_PREFIX}${slug}`;
}

export function publishPathForSlug(slug: string) {
  return `src/content/skills/${slug}.md`;
}

export function publishValidation(draft: EditorDraft): PublishValidationSummary {
  const issues = validateEditorDraft(draft, { forPublish: true });
  return { ok: issues.every((issue) => issue.severity !== 'error'), issues };
}

function stableGallery(item: EditorGalleryItem): Record<string, string> {
  const output: Record<string, string> = { type: item.type, src: item.src, alt: item.alt };
  if (item.caption) output.caption = item.caption;
  if (item.before) output.before = item.before;
  if (item.after) output.after = item.after;
  if (item.attribution) output.attribution = item.attribution;
  if (item.sourceUrl) output.sourceUrl = item.sourceUrl;
  return output;
}

function isoDate(value: string | undefined, fallback: Date) {
  if (value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return value;
  }
  return fallback.toISOString();
}

export interface PublishedMarkdownResult {
  path: string;
  content: string;
  snapshotHash: string;
  contentHash: string;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function buildPublishedMarkdown(
  draft: EditorDraft,
  options: { existingBody?: string; now?: Date } = {},
): Promise<PublishedMarkdownResult> {
  const validation = publishValidation(draft);
  if (!validation.ok) {
    throw new PublishError('publish_validation_failed', 422, { issues: validation.issues });
  }
  const fields = draft.fields;
  const now = options.now ?? new Date();
  const body = fields.body.trim() ? fields.body : (options.existingBody ?? '').trim();
  const snapshotHash = await computeSnapshotHash(fields);
  const frontmatter: Record<string, unknown> = {
    name: fields.name,
    description: fields.description,
    type: fields.type,
    category: fields.category,
    tags: fields.tags,
    supportedTools: fields.supportedTools,
    ...(fields.prompt ? { prompt: fields.prompt } : {}),
    ...(fields.installCommand ? { installCommand: fields.installCommand } : {}),
    ...(fields.cover ? { cover: fields.cover } : {}),
    gallery: fields.gallery.map((item) => stableGallery(item)),
    ...(draft.identity.sourceRepo ? { sourceRepo: draft.identity.sourceRepo } : {}),
    ...(draft.identity.sourcePath ? { sourcePath: draft.identity.sourcePath } : {}),
    ...(draft.identity.sourceSha ? { sourceSha: draft.identity.sourceSha } : {}),
    ...(draft.identity.sourceAttribution
      ? { sourceAttribution: draft.identity.sourceAttribution }
      : {}),
    ...(draft.identity.license ? { license: draft.identity.license } : {}),
    ...(draft.identity.licenseStatus ? { licenseStatus: draft.identity.licenseStatus } : {}),
    importedSnapshotHash: snapshotHash,
    featured: fields.featured,
    status: fields.status,
    createdAt: isoDate(draft.identity.createdAt, now),
    // Deterministic per draft edit so republishing an unchanged draft is a no-op.
    updatedAt: isoDate(draft.updatedAt, now),
  };
  let yaml: string;
  try {
    yaml = stringifyYaml(frontmatter, { lineWidth: 0, defaultStringType: 'QUOTE_DOUBLE' });
  } catch {
    throw new PublishError('publish_internal_error', 500);
  }
  const content = `---\n${yaml}---\n\n${body}\n`;
  if (new TextEncoder().encode(content).byteLength > PUBLISH_LIMITS.maxMarkdownBytes) {
    throw new PublishError('publish_content_too_large', 413);
  }
  const contentHash = await sha256Hex(content);
  return {
    path: publishPathForSlug(draft.slug),
    content,
    snapshotHash,
    contentHash,
  };
}

export async function buildPublishPlan(
  request: PublishEntryRequest,
  snapshot: PublishSnapshot,
  options: { now?: Date } = {},
): Promise<PublishEntryPlan> {
  const validation = publishValidation(request.draft);
  const blockedReasons: string[] = [];
  if (!validation.ok) {
    blockedReasons.push('validation_failed');
    if (
      validation.issues.some(
        (issue) => issue.code === 'license_not_publishable' && issue.severity === 'error',
      )
    ) {
      blockedReasons.push('license_blocked');
    }
  }
  let content = '';
  let contentHash = '';
  if (blockedReasons.length === 0) {
    const existingBody = snapshot.file?.text ? extractBody(snapshot.file.text) : undefined;
    const built = await buildPublishedMarkdown(request.draft, {
      ...(existingBody ? { existingBody } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    content = built.content;
    contentHash = built.contentHash;
  }
  const identical = snapshot.file !== null && snapshot.file.text === content;
  let action: PublishEntryPlan['action'];
  if (blockedReasons.length > 0) action = 'blocked';
  else if (snapshot.pull && snapshot.pull.state === 'open' && identical) action = 'noop';
  else if (snapshot.pull && snapshot.pull.state === 'open') action = 'update';
  else action = 'create';
  return {
    slug: request.slug,
    branch: branchNameForSlug(request.slug),
    path: publishPathForSlug(request.slug),
    content,
    contentHash,
    action,
    blockedReasons,
    validationIssues: validation.issues,
    ...(snapshot.pull ? { existingPull: snapshot.pull } : {}),
    ...(snapshot.file?.sha ? { fileSha: snapshot.file.sha } : {}),
  };
}

export function extractBody(markdown: string): string {
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return match?.[1] ?? '';
}

export function pullTitleForEntry(draft: EditorDraft): string {
  const verb = draft.kind === 'update' ? '更新' : '发布';
  return `content: ${verb} ${draft.fields.name} (${draft.slug})`;
}

export function pullBodyForEntry(
  draft: EditorDraft,
  validation: PublishValidationSummary,
  options: { now?: Date } = {},
): string {
  const now = options.now ?? new Date();
  const lines: string[] = [
    `本 PR 由站内发布管线创建或更新，内容以 Git 为事实源。`,
    '',
    `- 条目：\`${draft.slug}\`（${draft.kind === 'update' ? '更新' : '新建'}）`,
    `- 来源：${draft.identity.sourceRepo ? `\`${draft.identity.sourceRepo}/${draft.identity.sourcePath ?? ''}\`` : '原创内容（无上游仓库）'}`,
    `- 来源 Commit：${draft.identity.sourceSha ? `\`${draft.identity.sourceSha}\`` : '未提供'}`,
    `- 许可状态：${draft.identity.licenseStatus ?? '原创/未声明'}`,
    `- 本地校验：${validation.ok ? '通过' : '存在错误'}`,
    `- 确认时间：${now.toISOString()}`,
    '',
    '## 发布检查',
    '',
    '- [ ] 必需 CI 全部通过',
    '- [ ] 不存在未解决的许可或冲突项',
    '- [ ] 人工确认过来源、归属与媒体许可',
    '',
    '> 此 PR 不会触发生产部署；合并到 `main` 后才由既有 Cloudflare Worker 部署流程上线。',
  ];
  let body = lines.join('\n');
  if (new TextEncoder().encode(body).byteLength > PUBLISH_LIMITS.maxPullBodyBytes) {
    body = body.slice(0, PUBLISH_LIMITS.maxPullBodyBytes);
  }
  return body;
}

export type CheckSummary = 'pending' | 'passed' | 'failed' | 'none';

export interface PullStatusInput {
  pull: PullSummary | null;
  mergeable: boolean | null;
  checks: CheckSummary;
  failingChecks: string[];
  licenseAllowed: boolean;
}

export interface AutoMergeDecision {
  allowed: boolean;
  reasons: string[];
}

export function evaluateAutoMerge(
  input: PullStatusInput,
  explicitConfirm: boolean,
): AutoMergeDecision {
  const reasons: string[] = [];
  if (!explicitConfirm) reasons.push('confirmation_required');
  if (!input.pull) reasons.push('pull_missing');
  else {
    if (input.pull.state !== 'open') reasons.push('pull_not_open');
    if (input.mergeable !== true)
      reasons.push(input.mergeable === null ? 'mergeable_unknown' : 'merge_conflict');
    if (input.checks !== 'passed') reasons.push(`checks_${input.checks}`);
    if (input.failingChecks.length > 0) reasons.push('checks_failed');
    if (!input.licenseAllowed) reasons.push('license_not_publishable');
  }
  return { allowed: reasons.length === 0, reasons };
}

export interface DeployStatus {
  state: 'unknown' | 'running' | 'success' | 'failure';
  runUrl?: string;
}

export type PublishStage =
  | 'planned'
  | 'blocked'
  | 'pr_created'
  | 'checks_running'
  | 'checks_failed'
  | 'checks_passed'
  | 'merge_conflict'
  | 'merged'
  | 'deploying'
  | 'deployed'
  | 'deploy_failed'
  | 'failed';

export interface PublishEntryStatus {
  slug: string;
  stage: PublishStage;
  pull: PullSummary | null;
  mergeable: boolean | null;
  checks: CheckSummary;
  failingChecks: string[];
  autoMerge: AutoMergeDecision;
  deploy: DeployStatus;
  updatedAt: string;
}

export function mapPublishStage(input: PullStatusInput, deploy: DeployStatus): PublishStage {
  if (!input.pull) return 'planned';
  if (input.pull.state === 'merged') {
    if (deploy.state === 'success') return 'deployed';
    if (deploy.state === 'running') return 'deploying';
    if (deploy.state === 'failure') return 'deploy_failed';
    return 'merged';
  }
  if (input.pull.state === 'closed') return 'failed';
  if (input.mergeable === false) return 'merge_conflict';
  if (input.checks === 'failed') return 'checks_failed';
  if (input.checks === 'pending') return 'checks_running';
  if (input.checks === 'passed') return 'checks_passed';
  return 'pr_created';
}

export interface PublishEntryReport {
  slug: string;
  stage: PublishStage;
  pull: PullSummary | null;
  mergeable: boolean | null;
  checks: CheckSummary;
  failingChecks: string[];
  deploy: DeployStatus;
  updatedAt: string;
  action?: 'create' | 'update' | 'noop' | 'blocked' | 'merged' | 'failed';
  blockedReasons?: string[];
  validationIssues?: EditorValidationIssue[];
  error?: { code: string; retryAfter?: number };
}

export interface PublishStatusResponse {
  entries: PublishEntryReport[];
  generatedAt: string;
}
