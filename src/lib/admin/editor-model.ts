/**
 * Phase 3 visual editor model.
 *
 * This module is intentionally browser-safe and side-effect free so the admin
 * client script, the Worker and the Node tests can share the exact same rules.
 * It never stores credentials, never talks to the network and never publishes
 * anything: drafts live in the browser only and upstream updates are always
 * presented as explicit per-field decisions.
 */

export const EDITOR_DRAFT_SCHEMA_VERSION = 1;
export const EDITOR_DRAFT_MAX_BYTES = 512 * 1024;
export const EDITOR_DRAFT_STORAGE_PREFIX = 'msl-editor-draft-v1:';
export const EDITOR_HANDOFF_KEY = 'msl-editor-handoff-v1';
export const EDITOR_DESCRIPTION_MAX_LENGTH = 220;
export const EDITOR_NAME_MAX_LENGTH = 120;

export type EditorSkillType = 'skill' | 'prompt' | 'workflow';
export type EditorSkillStatus = 'demo' | 'unverified' | 'verified';
export type EditorLicenseStatus =
  'original' | 'redistributable' | 'restricted' | 'unknown' | 'not-applicable';
export type EditorFieldProvenance = 'manual' | 'published' | 'default';

export interface EditorGalleryItem {
  type: 'image' | 'video';
  src: string;
  alt: string;
  caption?: string;
  attribution?: string;
  sourceUrl?: string;
  before?: string;
  after?: string;
}

export interface EditorFields {
  name: string;
  description: string;
  type: EditorSkillType;
  category: string;
  tags: string[];
  supportedTools: string[];
  prompt?: string;
  installCommand?: string;
  cover?: string;
  gallery: EditorGalleryItem[];
  featured: boolean;
  status: EditorSkillStatus;
}

export interface EditorSourceIdentity {
  sourceRepo?: string;
  sourcePath?: string;
  sourceSha?: string;
  importedSnapshotHash?: string;
  license?: string;
  licenseStatus?: EditorLicenseStatus;
  sourceAttribution?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface EditorCatalogEntry {
  slug: string;
  identity: EditorSourceIdentity;
  fields: EditorFields;
}

export interface EditorImportCandidate {
  sourceRepo: string;
  sourcePath: string;
  sourceSha: string;
  sourceAttribution: string;
  license: string;
  licenseStatus: 'redistributable' | 'restricted' | 'unknown';
  name: string;
  description: string | null;
  suggestedSlug: string;
}

export interface EditorDraft {
  schemaVersion: typeof EDITOR_DRAFT_SCHEMA_VERSION;
  kind: 'new' | 'update';
  slug: string;
  identity: EditorSourceIdentity;
  fields: EditorFields;
  /** Published value at the time the draft was opened; used for diffing. */
  baseline: EditorFields;
  /** Explicit manual overrides keyed by field path, e.g. `name`, `gallery.0.alt`. */
  overrides: Record<string, true>;
  basedOnSourceSha?: string;
  updatedAt: string;
}

export interface EditorValidationIssue {
  code: string;
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export interface EditorUpstreamPlanField {
  path: string;
  label: string;
  current: string | null;
  upstream: string | null;
  base: string | null;
  localChanged: boolean;
  upstreamChanged: boolean;
  manuallyOverridden: boolean;
  /** Both sides changed to different values, or the change requires review. */
  requiresDecision: boolean;
  conflict: boolean;
}

export interface EditorUpstreamPlan {
  sourceRepo: string;
  sourcePath: string;
  candidateName: string;
  candidateSha: string;
  candidateDescription: string | null;
  license: string;
  licenseStatus: EditorLicenseStatus;
  fields: EditorUpstreamPlanField[];
  requiresExplicitDecision: boolean;
}

export type EditorConflictChoice = 'keep-local' | 'take-upstream';

export type EditorDraftErrorCode =
  | 'invalid_draft'
  | 'draft_too_large'
  | 'credentials_not_allowed'
  | 'unresolved_upstream_conflict'
  | 'invalid_field_path';

export class EditorDraftError extends Error {
  readonly code: EditorDraftErrorCode;

  constructor(code: EditorDraftErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'EditorDraftError';
    this.code = code;
  }
}

const DEFAULT_FIELDS: EditorFields = {
  name: '',
  description: '',
  type: 'skill',
  category: '',
  tags: [],
  supportedTools: [],
  gallery: [],
  featured: false,
  status: 'unverified',
};

const CREDENTIAL_KEYS = new Set([
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'credential',
  'credentials',
  'privatekey',
  'private_key',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'client_secret',
  'clientsecret',
  'session',
  'cookie',
]);

const SAFE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const EDITABLE_FIELD_KEYS = new Set([
  'name',
  'description',
  'type',
  'category',
  'tags',
  'supportedTools',
  'prompt',
  'installCommand',
  'cover',
  'featured',
  'status',
]);

export const EDITOR_TYPE_LABELS: Record<EditorSkillType, string> = {
  skill: 'Skill',
  prompt: 'Prompt',
  workflow: 'Workflow',
};

export const EDITOR_STATUS_LABELS: Record<EditorSkillStatus, string> = {
  demo: '示例 · 未声称真实运行',
  unverified: '未验证',
  verified: '已验证',
};

export const EDITOR_LICENSE_STATUS_LABELS: Record<EditorLicenseStatus, string> = {
  original: '原创内容声明',
  redistributable: '已确认可按许可再分发',
  restricted: '限制再分发',
  unknown: '许可未知',
  'not-applicable': '不适用',
};

export function defaultEditorFields(): EditorFields {
  return cloneFields(DEFAULT_FIELDS);
}

function cloneFields(fields: EditorFields): EditorFields {
  return JSON.parse(JSON.stringify(fields)) as EditorFields;
}

function cloneIdentity(identity: EditorSourceIdentity): EditorSourceIdentity {
  return JSON.parse(JSON.stringify(identity)) as EditorSourceIdentity;
}

function cloneDraft(draft: EditorDraft): EditorDraft {
  return JSON.parse(JSON.stringify(draft)) as EditorDraft;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function isSafeSlug(value: string) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 96 &&
    SAFE_SLUG_PATTERN.test(value)
  );
}

export function isSafeMediaSource(value: string) {
  if (typeof value !== 'string' || !value || value.length > 2_048) return false;
  if (value.startsWith('/skills/')) {
    try {
      const decoded = decodeURIComponent(value);
      return (
        decoded.startsWith('/skills/') &&
        !decoded.includes('\\') &&
        !decoded.split('/').some((segment) => segment === '.' || segment === '..')
      );
    } catch {
      return false;
    }
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function splitEditorList(value: string): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const raw of value.split(/[,，\n;；]/)) {
    const item = raw.trim();
    if (!item || item.length > 60) continue;
    const key = item.toLocaleLowerCase('zh-CN');
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length >= 16) break;
  }
  return items;
}

export function joinEditorList(value: string[]): string {
  return value.join(', ');
}

/** Returns true when any key in the object graph looks like a credential. */
export function containsCredentialLikeKeys(value: unknown, depth = 0): boolean {
  if (depth > 12 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsCredentialLikeKeys(item, depth + 1));
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (CREDENTIAL_KEYS.has(key.toLocaleLowerCase('en-US'))) return true;
    if (containsCredentialLikeKeys(item, depth + 1)) return true;
  }
  return false;
}

export function normalizeEditorFields(
  input: Partial<EditorFields> | undefined | null,
): EditorFields {
  const fields = input ?? {};
  const gallery = Array.isArray(fields.gallery)
    ? fields.gallery
        .filter((item): item is EditorGalleryItem => Boolean(item) && typeof item === 'object')
        .map((item) => normalizeGalleryItem(item))
    : [];
  return {
    name: typeof fields.name === 'string' ? fields.name : '',
    description: typeof fields.description === 'string' ? fields.description : '',
    type:
      fields.type === 'prompt' || fields.type === 'workflow' || fields.type === 'skill'
        ? fields.type
        : 'skill',
    category: typeof fields.category === 'string' ? fields.category : '',
    tags: Array.isArray(fields.tags) ? fields.tags.filter((tag) => typeof tag === 'string') : [],
    supportedTools: Array.isArray(fields.supportedTools)
      ? fields.supportedTools.filter((tool) => typeof tool === 'string')
      : [],
    ...(typeof fields.prompt === 'string' ? { prompt: fields.prompt } : {}),
    ...(typeof fields.installCommand === 'string' ? { installCommand: fields.installCommand } : {}),
    ...(typeof fields.cover === 'string' ? { cover: fields.cover } : {}),
    gallery,
    featured: fields.featured === true,
    status:
      fields.status === 'demo' || fields.status === 'verified' || fields.status === 'unverified'
        ? fields.status
        : 'unverified',
  };
}

function normalizeGalleryItem(input: EditorGalleryItem): EditorGalleryItem {
  const item: EditorGalleryItem = {
    type: input.type === 'video' ? 'video' : 'image',
    src: typeof input.src === 'string' ? input.src : '',
    alt: typeof input.alt === 'string' ? input.alt : '',
  };
  if (typeof input.caption === 'string' && input.caption) item.caption = input.caption;
  if (typeof input.attribution === 'string' && input.attribution)
    item.attribution = input.attribution;
  if (typeof input.sourceUrl === 'string' && input.sourceUrl) item.sourceUrl = input.sourceUrl;
  if (typeof input.before === 'string' && input.before) item.before = input.before;
  if (typeof input.after === 'string' && input.after) item.after = input.after;
  return item;
}

export function normalizeEditorDraft(input: unknown): EditorDraft | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const candidate = input as Partial<EditorDraft>;
  if (candidate.schemaVersion !== EDITOR_DRAFT_SCHEMA_VERSION) return null;
  if (candidate.kind !== 'new' && candidate.kind !== 'update') return null;
  if (typeof candidate.slug !== 'string' || !candidate.slug) return null;
  return {
    schemaVersion: EDITOR_DRAFT_SCHEMA_VERSION,
    kind: candidate.kind,
    slug: candidate.slug,
    identity:
      candidate.identity && typeof candidate.identity === 'object'
        ? cloneIdentity(candidate.identity)
        : {},
    fields: normalizeEditorFields(candidate.fields),
    baseline: normalizeEditorFields(candidate.baseline),
    overrides:
      candidate.overrides &&
      typeof candidate.overrides === 'object' &&
      !Array.isArray(candidate.overrides)
        ? Object.fromEntries(
            Object.entries(candidate.overrides as Record<string, unknown>)
              .filter(([, value]) => value === true)
              .map(([key]) => [key, true] as const),
          )
        : {},
    ...(typeof candidate.basedOnSourceSha === 'string'
      ? { basedOnSourceSha: candidate.basedOnSourceSha }
      : {}),
    updatedAt:
      typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date().toISOString(),
  };
}

export function editorDraftStorageKey(slug: string) {
  return `${EDITOR_DRAFT_STORAGE_PREFIX}${slug}`;
}

export function serializeEditorDraft(draft: EditorDraft): string {
  const normalized = normalizeEditorDraft(draft);
  if (!normalized) throw new EditorDraftError('invalid_draft');
  if (containsCredentialLikeKeys(normalized)) {
    throw new EditorDraftError('credentials_not_allowed');
  }
  const serialized = JSON.stringify(normalized);
  if (new TextEncoder().encode(serialized).byteLength > EDITOR_DRAFT_MAX_BYTES) {
    throw new EditorDraftError('draft_too_large');
  }
  return serialized;
}

export function parseEditorDraft(raw: string | null | undefined): EditorDraft | null {
  if (typeof raw !== 'string' || !raw) return null;
  if (new TextEncoder().encode(raw).byteLength > EDITOR_DRAFT_MAX_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (containsCredentialLikeKeys(value)) return null;
  return normalizeEditorDraft(value);
}

function normalizePath(path: string) {
  return path.split('.').filter(Boolean).join('.');
}

function setFieldPath(fields: EditorFields, path: string, value: unknown) {
  const segments = path.split('.');
  if (segments[0] !== 'gallery') throw new EditorDraftError('invalid_field_path', path);
  if (segments.length === 1) {
    fields.gallery = Array.isArray(value) ? (value as EditorGalleryItem[]) : [];
    return;
  }
  const index = Number(segments[1]);
  if (!Number.isInteger(index) || index < 0 || index >= fields.gallery.length) {
    throw new EditorDraftError('invalid_field_path', path);
  }
  const item = fields.gallery[index]!;
  if (segments.length === 2) {
    fields.gallery[index] = normalizeGalleryItem(value as EditorGalleryItem);
    return;
  }
  const key = segments[2]!;
  if (
    !['type', 'src', 'alt', 'caption', 'attribution', 'sourceUrl', 'before', 'after'].includes(key)
  ) {
    throw new EditorDraftError('invalid_field_path', path);
  }
  if (value === undefined || value === null || value === '') {
    delete (item as unknown as Record<string, unknown>)[key];
  } else {
    (item as unknown as Record<string, unknown>)[key] = value;
  }
}

function hasOverride(draft: EditorDraft, path: string) {
  const normalized = normalizePath(path);
  return Object.keys(draft.overrides).some((key) => {
    const candidate = normalizePath(key);
    return candidate === normalized || normalized.startsWith(`${candidate}.`);
  });
}

export function setEditorOverride(draft: EditorDraft, path: string, manual = true): EditorDraft {
  const next = cloneDraft(draft);
  const normalized = normalizePath(path);
  if (manual) next.overrides[normalized] = true;
  else delete next.overrides[normalized];
  return next;
}

export function updateEditorField(draft: EditorDraft, path: string, value: unknown): EditorDraft {
  const next = cloneDraft(draft);
  if (path === 'identity.license' || path === 'identity.licenseStatus') {
    if (path === 'identity.license') next.identity.license = String(value ?? '');
    if (path === 'identity.licenseStatus') {
      next.identity.licenseStatus = value as EditorLicenseStatus;
    }
    next.overrides[path] = true;
    next.updatedAt = new Date().toISOString();
    return next;
  }
  if (path.startsWith('gallery')) {
    setFieldPath(next.fields, path, value);
  } else if (EDITABLE_FIELD_KEYS.has(path)) {
    (next.fields as unknown as Record<string, unknown>)[path] = value;
  } else {
    throw new EditorDraftError('invalid_field_path', path);
  }
  next.overrides = { ...next.overrides, [normalizePath(path)]: true };
  next.updatedAt = new Date().toISOString();
  return next;
}

export function clearEditorOverride(draft: EditorDraft, path: string): EditorDraft {
  const next = cloneDraft(draft);
  const normalized = normalizePath(path);
  delete next.overrides[normalized];
  const baselineValue = editorFieldValue(next.baseline, normalized);
  if (baselineValue !== undefined) {
    if (normalized.startsWith('gallery.')) setFieldPath(next.fields, normalized, baselineValue);
    else (next.fields as unknown as Record<string, unknown>)[normalized] = baselineValue;
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

export function editorFieldProvenance(draft: EditorDraft, path: string): EditorFieldProvenance {
  if (hasOverride(draft, path)) return 'manual';
  return draft.kind === 'update' ? 'published' : 'default';
}

export function editorFieldValue(fields: EditorFields, path: string): unknown {
  const segments = normalizePath(path).split('.');
  let current: unknown = fields;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function moveGalleryItem(draft: EditorDraft, from: number, to: number): EditorDraft {
  const next = cloneDraft(draft);
  const { gallery } = next.fields;
  if (from < 0 || to < 0 || from >= gallery.length || to >= gallery.length || from === to)
    return next;
  const [item] = gallery.splice(from, 1);
  gallery.splice(to, 0, item!);
  next.overrides.gallery = true;
  next.updatedAt = new Date().toISOString();
  return next;
}

export function removeGalleryItem(draft: EditorDraft, index: number): EditorDraft {
  const next = cloneDraft(draft);
  if (index < 0 || index >= next.fields.gallery.length) return next;
  next.fields.gallery.splice(index, 1);
  next.overrides.gallery = true;
  next.updatedAt = new Date().toISOString();
  return next;
}

export function addGalleryItem(draft: EditorDraft, item?: Partial<EditorGalleryItem>): EditorDraft {
  const next = cloneDraft(draft);
  next.fields.gallery.push(
    normalizeGalleryItem({
      type: item?.type === 'video' ? 'video' : 'image',
      src: item?.src ?? '',
      alt: item?.alt ?? '',
      ...(item?.caption ? { caption: item.caption } : {}),
      ...(item?.attribution ? { attribution: item.attribution } : {}),
      ...(item?.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
      ...(item?.before ? { before: item.before } : {}),
      ...(item?.after ? { after: item.after } : {}),
    }),
  );
  next.overrides.gallery = true;
  next.updatedAt = new Date().toISOString();
  return next;
}

export function resetEditorDraft(draft: EditorDraft): EditorDraft {
  const next = cloneDraft(draft);
  next.fields = cloneFields(next.baseline);
  next.overrides = {};
  if (next.basedOnSourceSha) next.identity.sourceSha = next.basedOnSourceSha;
  next.updatedAt = new Date().toISOString();
  return next;
}

export function createDraftFromPublished(entry: EditorCatalogEntry, now = new Date()): EditorDraft {
  const fields = normalizeEditorFields(entry.fields);
  return {
    schemaVersion: EDITOR_DRAFT_SCHEMA_VERSION,
    kind: 'update',
    slug: entry.slug,
    identity: cloneIdentity(entry.identity),
    fields: cloneFields(fields),
    baseline: cloneFields(fields),
    overrides: {},
    ...(entry.identity.sourceSha ? { basedOnSourceSha: entry.identity.sourceSha } : {}),
    updatedAt: now.toISOString(),
  };
}

export function findEditorCatalogEntry(
  entries: EditorCatalogEntry[],
  sourceRepo: string | undefined,
  sourcePath: string | undefined,
): EditorCatalogEntry | undefined {
  if (!sourceRepo || !sourcePath) return undefined;
  const repoKey = sourceRepo.toLocaleLowerCase('en-US');
  return entries.find(
    (entry) =>
      (entry.identity.sourceRepo ?? '').toLocaleLowerCase('en-US') === repoKey &&
      entry.identity.sourcePath === sourcePath,
  );
}

export function createDraftFromCandidate(
  candidate: EditorImportCandidate,
  catalog: EditorCatalogEntry[],
  now = new Date(),
): { draft: EditorDraft; matchedEntry?: EditorCatalogEntry } {
  const matchedEntry = findEditorCatalogEntry(catalog, candidate.sourceRepo, candidate.sourcePath);
  if (matchedEntry) {
    return { draft: createDraftFromPublished(matchedEntry, now), matchedEntry };
  }
  const touching = candidate.description?.trim() ?? '';
  const fields = normalizeEditorFields({
    name: candidate.name,
    description: touching,
    type: 'skill',
    category: '未分类',
    gallery: [],
    status: 'unverified',
  });
  const identity: EditorSourceIdentity = {
    sourceRepo: candidate.sourceRepo,
    sourcePath: candidate.sourcePath,
    sourceSha: candidate.sourceSha,
    license: candidate.license,
    licenseStatus: candidate.licenseStatus,
    sourceAttribution: candidate.sourceAttribution,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  return {
    draft: {
      schemaVersion: EDITOR_DRAFT_SCHEMA_VERSION,
      kind: 'new',
      slug: candidate.suggestedSlug,
      identity,
      fields: cloneFields(fields),
      baseline: cloneFields(fields),
      overrides: {},
      basedOnSourceSha: candidate.sourceSha,
      updatedAt: now.toISOString(),
    },
  };
}

export function sourceUrlForIdentity(identity: EditorSourceIdentity): string | undefined {
  if (!identity.sourceRepo || !identity.sourcePath) return undefined;
  if (!SAFE_REPOSITORY.test(identity.sourceRepo)) return undefined;
  const encodedPath = identity.sourcePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const ref = identity.sourceSha ?? 'HEAD';
  return `https://github.com/${identity.sourceRepo}/blob/${ref}/${encodedPath}`;
}

export function validateEditorDraft(
  draft: EditorDraft,
  options: { forPublish?: boolean } = {},
): EditorValidationIssue[] {
  const issues: EditorValidationIssue[] = [];
  const fields = draft.fields;
  const push = (code: string, severity: 'error' | 'warning', path: string, message: string) =>
    issues.push({ code, severity, path, message });

  if (!isSafeSlug(draft.slug)) {
    push('slug_invalid', 'error', 'slug', '条目标识必须是小写字母、数字和连字符组成的安全 slug。');
  }
  if (!fields.name.trim()) {
    push('name_required', 'error', 'name', '名称不能为空。');
  } else if (fields.name.length > EDITOR_NAME_MAX_LENGTH) {
    push('name_too_long', 'error', 'name', `名称不能超过 ${EDITOR_NAME_MAX_LENGTH} 个字符。`);
  }
  if (!fields.description.trim()) {
    push('description_required', 'error', 'description', '简介不能为空。');
  } else if (fields.description.length > EDITOR_DESCRIPTION_MAX_LENGTH) {
    push(
      'description_too_long',
      'error',
      'description',
      `简介不能超过 ${EDITOR_DESCRIPTION_MAX_LENGTH} 个字符。`,
    );
  }
  if (!fields.category.trim()) {
    push('category_required', 'error', 'category', '分类不能为空。');
  }
  if (fields.type === 'prompt' && !(fields.prompt ?? '').trim()) {
    push('prompt_required_for_prompt', 'error', 'prompt', 'Prompt 类型必须填写完整 Prompt。');
  }
  if (fields.installCommand !== undefined && !fields.installCommand.trim()) {
    push(
      'install_command_invalid',
      'warning',
      'installCommand',
      '安装命令为空时建议直接删除该字段。',
    );
  }
  if (fields.cover !== undefined && !isSafeMediaSource(fields.cover)) {
    push('cover_unsafe', 'error', 'cover', '封面必须是 /skills/ 站内路径或不含凭据的 HTTPS 链接。');
  }
  fields.gallery.forEach((item, index) => {
    const itemPath = `gallery.${index}`;
    if (item.type !== 'image' && item.type !== 'video') {
      push('gallery_type_invalid', 'error', `${itemPath}.type`, '媒体类型必须是 image 或 video。');
    }
    if (!item.alt.trim()) {
      push('gallery_alt_required', 'error', `${itemPath}.alt`, '每项媒体都需要替代文本。');
    }
    if (!item.src.trim()) {
      push('gallery_src_required', 'error', `${itemPath}.src`, '每项媒体都需要媒体地址。');
    } else if (!isSafeMediaSource(item.src)) {
      push(
        'gallery_src_unsafe',
        'error',
        `${itemPath}.src`,
        '媒体地址必须是 /skills/ 站内路径或不含凭据的 HTTPS 链接。',
      );
    }
    if (item.sourceUrl !== undefined && item.sourceUrl && !isSafeMediaSource(item.sourceUrl)) {
      push(
        'gallery_src_unsafe',
        'error',
        `${itemPath}.sourceUrl`,
        '媒体来源必须是不含凭据的 HTTPS 链接。',
      );
    }
    if (item.before || item.after) {
      if (item.type === 'video') {
        push('gallery_video_comparison_unsupported', 'error', itemPath, '视频不支持前后对比字段。');
      } else if (!item.before || !item.after) {
        push('gallery_comparison_pair_required', 'error', itemPath, '前后对比需要同时提供两张图。');
      }
    }
  });
  if (draft.identity.sourceRepo && !(draft.identity.sourceAttribution ?? '').trim()) {
    push(
      'source_attribution_required',
      'error',
      'identity.sourceAttribution',
      '保留来源时必须填写来源归属。',
    );
  }
  if (
    draft.identity.sourceRepo &&
    draft.identity.sourceSha &&
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(draft.identity.sourceSha)
  ) {
    push('source_sha_invalid', 'error', 'identity.sourceSha', '来源 Commit 必须是完整的 Git SHA。');
  }
  if (options.forPublish) {
    const status = draft.identity.licenseStatus;
    if (status !== 'original' && status !== 'redistributable' && status !== 'not-applicable') {
      push(
        'license_not_publishable',
        'error',
        'identity.licenseStatus',
        '许可未知或限制再分发时不能发布复制自上游的内容；请人工核验许可或改为原创内容声明。',
      );
    }
  }
  return issues;
}

export function buildUpstreamPlan(
  draft: EditorDraft,
  candidate: EditorImportCandidate,
): EditorUpstreamPlan {
  const fields: EditorUpstreamPlanField[] = [];
  const baseName = draft.baseline.name;
  const baseDescription = draft.baseline.description;
  const add = (
    path: string,
    label: string,
    current: string | null,
    upstream: string | null,
    base: string | null,
    manuallyOverridden: boolean,
    requiresDecision = false,
  ) => {
    const localChanged = current !== base;
    const upstreamChanged = upstream !== base;
    const conflict = localChanged && upstreamChanged && current !== upstream;
    fields.push({
      path,
      label,
      current,
      upstream,
      base,
      localChanged,
      upstreamChanged,
      manuallyOverridden,
      requiresDecision: requiresDecision || conflict,
      conflict,
    });
  };

  add('name', '名称', draft.fields.name, candidate.name, baseName, hasOverride(draft, 'name'));
  if (candidate.description !== null) {
    add(
      'description',
      '简介',
      draft.fields.description,
      candidate.description,
      baseDescription,
      hasOverride(draft, 'description'),
    );
  }
  add(
    'identity.sourceSha',
    '上游 Commit',
    draft.identity.sourceSha ?? null,
    candidate.sourceSha,
    draft.basedOnSourceSha ?? draft.identity.sourceSha ?? null,
    hasOverride(draft, 'identity.sourceSha'),
  );
  if (candidate.licenseStatus !== draft.identity.licenseStatus) {
    add(
      'identity.licenseStatus',
      '许可状态',
      draft.identity.licenseStatus ?? null,
      candidate.licenseStatus,
      draft.identity.licenseStatus ?? null,
      hasOverride(draft, 'identity.licenseStatus'),
      true,
    );
  }
  if (candidate.license !== (draft.identity.license ?? '')) {
    add(
      'identity.license',
      '许可证',
      draft.identity.license ?? null,
      candidate.license,
      draft.identity.license ?? null,
      hasOverride(draft, 'identity.license'),
      true,
    );
  }

  return {
    sourceRepo: candidate.sourceRepo,
    sourcePath: candidate.sourcePath,
    candidateName: candidate.name,
    candidateSha: candidate.sourceSha,
    candidateDescription: candidate.description,
    license: candidate.license,
    licenseStatus: candidate.licenseStatus,
    fields,
    requiresExplicitDecision: fields.some(
      (field) => field.requiresDecision && field.upstreamChanged,
    ),
  };
}

export function applyUpstreamDecisions(
  draft: EditorDraft,
  plan: EditorUpstreamPlan,
  decisions: Record<string, EditorConflictChoice>,
  now = new Date(),
): EditorDraft {
  const next = cloneDraft(draft);

  for (const field of plan.fields) {
    if (!field.upstreamChanged) continue;
    const decision = decisions[field.path];
    const effective = decision ?? (field.requiresDecision ? undefined : 'take-upstream');
    if (!effective) {
      throw new EditorDraftError('unresolved_upstream_conflict', field.path);
    }
    if (effective === 'keep-local') {
      next.overrides[field.path] = true;
      continue;
    }
    if (field.path === 'name' || field.path === 'description') {
      (next.fields as unknown as Record<string, unknown>)[field.path] = field.upstream ?? '';
      delete next.overrides[field.path];
      (next.baseline as unknown as Record<string, unknown>)[field.path] = field.upstream ?? '';
    } else if (field.path === 'identity.sourceSha') {
      if (field.upstream) next.identity.sourceSha = field.upstream;
      if (field.upstream) next.basedOnSourceSha = field.upstream;
      delete next.overrides['identity.sourceSha'];
    } else if (field.path === 'identity.licenseStatus') {
      if (field.upstream) next.identity.licenseStatus = field.upstream as EditorLicenseStatus;
      delete next.overrides['identity.licenseStatus'];
    } else if (field.path === 'identity.license') {
      next.identity.license = field.upstream ?? '';
      delete next.overrides['identity.license'];
    }
  }

  next.updatedAt = now.toISOString();
  return next;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

export async function computeSnapshotHash(fields: EditorFields): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(fields));
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface EditorPreviewModel {
  slug: string;
  name: string;
  description: string;
  type: EditorSkillType;
  typeLabel: string;
  status: EditorSkillStatus;
  statusLabel: string;
  category: string;
  tags: string[];
  supportedTools: string[];
  cover?: string;
  gallery: EditorGalleryItem[];
  prompt?: string;
  installCommand?: string;
  featured: boolean;
  license?: string;
  licenseStatusLabel?: string;
  sourcePath?: string;
  sourceUrl?: string;
  sourceRepo?: string;
  sourceAttribution?: string;
  updatedAt?: string;
}

export function toEditorPreviewModel(draft: EditorDraft): EditorPreviewModel {
  const sourceUrl = sourceUrlForIdentity(draft.identity);
  return {
    slug: draft.slug,
    name: draft.fields.name,
    description: draft.fields.description,
    type: draft.fields.type,
    typeLabel: EDITOR_TYPE_LABELS[draft.fields.type],
    status: draft.fields.status,
    statusLabel: EDITOR_STATUS_LABELS[draft.fields.status],
    category: draft.fields.category,
    tags: [...draft.fields.tags],
    supportedTools: [...draft.fields.supportedTools],
    ...(draft.fields.cover ? { cover: draft.fields.cover } : {}),
    gallery: cloneFields(draft.fields).gallery,
    ...(draft.fields.prompt ? { prompt: draft.fields.prompt } : {}),
    ...(draft.fields.installCommand ? { installCommand: draft.fields.installCommand } : {}),
    featured: draft.fields.featured,
    ...(draft.identity.license ? { license: draft.identity.license } : {}),
    ...(draft.identity.licenseStatus
      ? { licenseStatusLabel: EDITOR_LICENSE_STATUS_LABELS[draft.identity.licenseStatus] }
      : {}),
    ...(draft.identity.sourcePath ? { sourcePath: draft.identity.sourcePath } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(draft.identity.sourceRepo ? { sourceRepo: draft.identity.sourceRepo } : {}),
    ...(draft.identity.sourceAttribution
      ? { sourceAttribution: draft.identity.sourceAttribution }
      : {}),
    ...(draft.updatedAt ? { updatedAt: draft.updatedAt } : {}),
  };
}
