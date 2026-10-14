/**
 * Phase 3 visual editor client.
 *
 * Browser-only behavior: drafts live in localStorage, never contain
 * credentials, and upstream updates always become explicit per-field choices.
 * All server calls go through the Access-protected Phase 1 admin API
 * (`/api/admin/editor/catalog` and the read-only import preview endpoint).
 */

import {
  addGalleryItem,
  applyUpstreamDecisions,
  buildUpstreamPlan,
  computeSnapshotHash,
  containsCredentialLikeKeys,
  createDraftFromCandidate,
  createDraftFromPublished,
  defaultEditorFields,
  EDITOR_DRAFT_SCHEMA_VERSION,
  EDITOR_HANDOFF_KEY,
  EDITOR_LICENSE_STATUS_LABELS,
  editorDraftStorageKey,
  editorFieldProvenance,
  joinEditorList,
  moveGalleryItem,
  normalizeEditorFields,
  parseEditorDraft,
  removeGalleryItem,
  resetEditorDraft,
  serializeEditorDraft,
  splitEditorList,
  toEditorPreviewModel,
  updateEditorField,
  validateEditorDraft,
  type EditorCatalogEntry,
  type EditorConflictChoice,
  type EditorDraft,
  type EditorGalleryItem,
  type EditorImportCandidate,
  type EditorLicenseStatus,
  type EditorSourceIdentity,
  type EditorUpstreamPlan,
} from '../lib/admin/editor-model.ts';
import { renderCardPreview, renderDetailPreview } from './editor-preview.ts';

const entrySelect = document.querySelector<HTMLSelectElement>('[data-entry-select]');
const newButton = document.querySelector<HTMLButtonElement>('[data-editor-new]');
const reimportButton = document.querySelector<HTMLButtonElement>('[data-editor-reimport]');
const statusElement = document.querySelector<HTMLElement>('[data-editor-status]');
const draftBanner = document.querySelector<HTMLElement>('[data-draft-banner]');
const restoreButton = document.querySelector<HTMLButtonElement>('[data-restore-draft]');
const discardButton = document.querySelector<HTMLButtonElement>('[data-discard-draft]');
const saveButton = document.querySelector<HTMLButtonElement>('[data-save-draft]');
const resetButton = document.querySelector<HTMLButtonElement>('[data-reset-published]');
const exportButton = document.querySelector<HTMLButtonElement>('[data-export-draft]');
const exportOutput = document.querySelector<HTMLElement>('[data-export-output]');
const validationList = document.querySelector<HTMLUListElement>('[data-validation-list]');
const validationSummary = document.querySelector<HTMLElement>('[data-validation-summary]');
const conflictPanel = document.querySelector<HTMLElement>('[data-conflict-panel]');
const conflictList = document.querySelector<HTMLElement>('[data-conflict-list]');
const applyConflictsButton = document.querySelector<HTMLButtonElement>('[data-apply-conflicts]');
const cancelConflictsButton = document.querySelector<HTMLButtonElement>('[data-cancel-conflicts]');
const galleryList = document.querySelector<HTMLElement>('[data-gallery-list]');
const galleryAddButton = document.querySelector<HTMLButtonElement>('[data-gallery-add]');
const galleryTemplate = document.querySelector<HTMLTemplateElement>('[data-gallery-template]');
const categoryOptions = document.querySelector<HTMLDataListElement>('[data-category-options]');
const cardPreviewRoot = document.querySelector<HTMLElement>('[data-preview-card]');
const detailPreviewRoot = document.querySelector<HTMLElement>('[data-preview-detail]');
const mobilePreviewRoot = document.querySelector<HTMLElement>('[data-preview-mobile]');
const descriptionCount = document.querySelector<HTMLElement>('[data-description-count]');
const slugHint = document.querySelector<HTMLElement>('[data-slug-hint]');

let catalog: EditorCatalogEntry[] = [];
let draft: EditorDraft | null = null;
let plan: EditorUpstreamPlan | null = null;
let lastCandidate: EditorImportCandidate | null = null;
let pendingRestore: EditorDraft | null = null;
let lastSavedSlug: string | null = null;
const decisions = new Map<string, EditorConflictChoice>();

const fieldPaths = [
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
  'gallery',
] as const;

const provenanceLabels: Record<string, string> = {
  manual: '手动修改',
  published: '已发布',
  default: '默认',
};

function byField<T extends Element>(path: string) {
  return document.querySelector<T>(`[data-field="${path}"]`);
}

function byProvenance(path: string) {
  return document.querySelector<HTMLElement>(`[data-provenance="${path}"]`);
}

function setStatus(message: string, state: 'info' | 'success' | 'error' | 'warning' = 'info') {
  if (!statusElement) return;
  statusElement.textContent = message;
  statusElement.dataset['state'] = state;
}

function readCandidates(payload: unknown): EditorCatalogEntry[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const entries = (payload as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  const parsed: EditorCatalogEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.slug !== 'string' || !record.slug) continue;
    if (containsCredentialLikeKeys(entry)) continue;
    const rawIdentity =
      record.identity && typeof record.identity === 'object' && !Array.isArray(record.identity)
        ? (record.identity as Record<string, unknown>)
        : {};
    const licenseStatus =
      typeof rawIdentity.licenseStatus === 'string' &&
      Object.keys(EDITOR_LICENSE_STATUS_LABELS).includes(rawIdentity.licenseStatus)
        ? (rawIdentity.licenseStatus as EditorLicenseStatus)
        : undefined;
    const identity: EditorSourceIdentity = {};
    const stringKeys = [
      'sourceRepo',
      'sourcePath',
      'sourceSha',
      'importedSnapshotHash',
      'license',
      'sourceAttribution',
      'createdAt',
      'updatedAt',
    ] as const;
    for (const key of stringKeys) {
      const value = rawIdentity[key];
      if (typeof value === 'string' && value) identity[key] = value;
    }
    if (licenseStatus) identity.licenseStatus = licenseStatus;
    parsed.push({
      slug: record.slug,
      identity,
      fields: normalizeEditorFields(
        record.fields && typeof record.fields === 'object' && !Array.isArray(record.fields)
          ? (record.fields as Parameters<typeof normalizeEditorFields>[0])
          : {},
      ),
    });
  }
  return parsed;
}

function readHandoff(): EditorImportCandidate | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(EDITOR_HANDOFF_KEY);
  } catch {
    return null;
  }
  if (!raw || raw.length > 64 * 1024) {
    try {
      localStorage.removeItem(EDITOR_HANDOFF_KEY);
    } catch {
      // Storage may be unavailable; nothing else to clean up.
    }
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { schemaVersion?: unknown; candidate?: unknown };
    if (parsed.schemaVersion !== 1 || !parsed.candidate) return null;
    if (containsCredentialLikeKeys(parsed.candidate)) return null;
    const candidate = parsed.candidate as Record<string, unknown>;
    const licenseStatus = candidate.licenseStatus;
    if (
      typeof candidate.sourceRepo !== 'string' ||
      typeof candidate.sourcePath !== 'string' ||
      typeof candidate.sourceSha !== 'string' ||
      typeof candidate.sourceAttribution !== 'string' ||
      typeof candidate.license !== 'string' ||
      typeof candidate.name !== 'string' ||
      (candidate.description !== null && typeof candidate.description !== 'string') ||
      typeof candidate.suggestedSlug !== 'string' ||
      (licenseStatus !== 'redistributable' &&
        licenseStatus !== 'restricted' &&
        licenseStatus !== 'unknown')
    ) {
      return null;
    }
    return {
      sourceRepo: candidate.sourceRepo,
      sourcePath: candidate.sourcePath,
      sourceSha: candidate.sourceSha,
      sourceAttribution: candidate.sourceAttribution,
      license: candidate.license,
      licenseStatus,
      name: candidate.name,
      description: candidate.description,
      suggestedSlug: candidate.suggestedSlug,
    };
  } catch {
    return null;
  }
}

function readStoredDraft(slug: string): EditorDraft | null {
  try {
    return parseEditorDraft(localStorage.getItem(editorDraftStorageKey(slug)));
  } catch {
    return null;
  }
}

function removeStoredDraft(slug: string) {
  try {
    localStorage.removeItem(editorDraftStorageKey(slug));
  } catch {
    // Ignore storage failures; the draft simply remains in memory.
  }
}

function persist(announce: boolean) {
  if (!draft) return;
  if (!draft.slug) {
    setStatus('请先填写安全的 slug 再保存草稿。', 'error');
    return;
  }
  try {
    const serialized = serializeEditorDraft(draft);
    const key = editorDraftStorageKey(draft.slug);
    if (lastSavedSlug && lastSavedSlug !== draft.slug) removeStoredDraft(lastSavedSlug);
    localStorage.setItem(key, serialized);
    lastSavedSlug = draft.slug;
    if (announce) setStatus('草稿已保存到当前浏览器（不含凭据，服务器不保存）。', 'success');
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
    if (code === 'credentials_not_allowed') {
      setStatus('草稿中检测到疑似凭据字段，已拒绝保存。', 'error');
    } else if (code === 'draft_too_large') {
      setStatus('草稿过大，无法安全保存到浏览器。', 'error');
    } else {
      setStatus('草稿保存失败；请检查浏览器存储权限。', 'error');
    }
  }
}

function renderEntrySelect() {
  if (!entrySelect) return;
  entrySelect.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '选择条目以载入草稿…';
  entrySelect.append(placeholder);
  for (const entry of catalog) {
    const option = document.createElement('option');
    option.value = entry.slug;
    option.textContent = entry.slug;
    entrySelect.append(option);
  }
  if (categoryOptions) {
    categoryOptions.replaceChildren();
    for (const category of [...new Set(catalog.map((entry) => entry.fields.category))].sort()) {
      const option = document.createElement('option');
      option.value = category;
      categoryOptions.append(option);
    }
  }
}

function openPublishedEntry(slug: string) {
  const entry = catalog.find((item) => item.slug === slug);
  if (!entry) return;
  draft = createDraftFromPublished(entry);
  plan = null;
  lastCandidate = null;
  decisions.clear();
  pendingRestore = readStoredDraft(slug);
  if (draftBanner) draftBanner.hidden = !pendingRestore;
  renderAll();
  setStatus(
    pendingRestore
      ? '已载入已发布条目；检测到浏览器草稿，请选择恢复或丢弃。'
      : `已载入已发布条目 ${slug}；slug 与来源身份保持稳定。`,
    'info',
  );
}

function openNewDraft() {
  const now = new Date();
  const fields = defaultEditorFields();
  fields.name = '新条目';
  fields.description = '请填写 220 字以内的中文简介。';
  fields.category = '未分类';
  draft = {
    schemaVersion: EDITOR_DRAFT_SCHEMA_VERSION,
    kind: 'new',
    slug: `draft-${now.getTime().toString(36)}`,
    identity: { createdAt: now.toISOString(), updatedAt: now.toISOString() },
    fields,
    baseline: JSON.parse(JSON.stringify(fields)) as typeof fields,
    overrides: {},
    updatedAt: now.toISOString(),
  };
  plan = null;
  lastCandidate = null;
  pendingRestore = null;
  decisions.clear();
  if (draftBanner) draftBanner.hidden = true;
  if (entrySelect) entrySelect.value = '';
  renderAll();
  setStatus('已创建新草稿；可编辑 slug，保存不会发布或写入仓库。', 'info');
}

function openHandoff(candidate: EditorImportCandidate) {
  const { draft: next, matchedEntry } = createDraftFromCandidate(candidate, catalog);
  draft = next;
  lastCandidate = candidate;
  decisions.clear();
  plan = buildUpstreamPlan(draft, candidate);
  pendingRestore = readStoredDraft(draft.slug);
  if (draftBanner) draftBanner.hidden = !pendingRestore;
  if (entrySelect) entrySelect.value = matchedEntry ? matchedEntry.slug : '';
  try {
    localStorage.removeItem(EDITOR_HANDOFF_KEY);
  } catch {
    // Ignore; the handoff is only a convenience.
  }
  renderAll();
  setStatus(
    matchedEntry
      ? '已按 repo+path 匹配到已发布条目，保留原 slug；请审阅来自上游的字段更新。'
      : '已创建新来源草稿；保存不会发布内容。',
    'info',
  );
}

function renderAll() {
  if (!draft) {
    if (validationSummary) validationSummary.textContent = '选择条目后显示校验结果。';
    if (validationList) validationList.replaceChildren();
    if (conflictPanel) conflictPanel.hidden = true;
    if (cardPreviewRoot) cardPreviewRoot.textContent = '选择条目后显示首页卡片预览。';
    if (detailPreviewRoot) detailPreviewRoot.textContent = '选择条目后显示详情页预览。';
    if (mobilePreviewRoot) mobilePreviewRoot.textContent = '选择条目后显示移动端预览。';
    updateReimportState();
    return;
  }
  renderFormValues();
  renderGallery();
  renderBadges();
  renderPreview();
  renderValidation();
  updateReimportState();
  renderConflicts();
}

function renderFormValues() {
  if (!draft) return;
  const current = draft;
  const value = (path: string, fallback = '') => {
    switch (path) {
      case 'name':
        return current.fields.name;
      case 'description':
        return current.fields.description;
      case 'type':
        return current.fields.type;
      case 'category':
        return current.fields.category;
      case 'tags':
        return joinEditorList(current.fields.tags);
      case 'supportedTools':
        return joinEditorList(current.fields.supportedTools);
      case 'prompt':
        return current.fields.prompt ?? fallback;
      case 'installCommand':
        return current.fields.installCommand ?? fallback;
      case 'cover':
        return current.fields.cover ?? fallback;
      case 'status':
        return current.fields.status;
      default:
        return fallback;
    }
  };
  for (const path of fieldPaths) {
    if (path === 'gallery' || path === 'featured') continue;
    const element = byField<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(path);
    if (!element) continue;
    element.value = String(value(path));
  }
  const featured = byField<HTMLInputElement>('featured');
  if (featured) featured.checked = current.fields.featured;
  const slugInput = byField<HTMLInputElement>('slug');
  if (slugInput) {
    slugInput.value = current.slug;
    const locked = current.kind === 'update';
    slugInput.readOnly = locked;
    if (slugHint) {
      slugHint.textContent = locked
        ? '已发布条目的 slug 保持稳定；重新导入只会更新原条目，不会创建重复卡片。'
        : '新草稿可使用小写字母、数字与连字符；发布后 slug 保持稳定。';
    }
  }
  if (descriptionCount) descriptionCount.textContent = String(current.fields.description.length);
}

function renderBadges() {
  if (!draft) return;
  for (const path of [...fieldPaths, 'slug']) {
    const badge = byProvenance(path);
    if (!badge) continue;
    const provenance = path === 'slug' ? 'published' : editorFieldProvenance(draft, path);
    badge.textContent = provenanceLabels[provenance] ?? provenance;
    badge.dataset['state'] = provenance;
  }
}

function renderGallery() {
  if (!galleryList || !draft) return;
  galleryList.replaceChildren();
  draft.fields.gallery.forEach((item, index) => {
    if (!galleryTemplate) return;
    const fragment = galleryTemplate.content.cloneNode(true) as DocumentFragment;
    const row = fragment.querySelector<HTMLElement>('[data-gallery-row]');
    if (!row) return;
    for (const input of row.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      '[data-gallery-field]',
    )) {
      const key = input.dataset['galleryField'] as keyof EditorGalleryItem | undefined;
      if (!key) continue;
      const current = item[key] ?? '';
      input.value = String(current);
      input.addEventListener('input', () => {
        if (!draft) return;
        const value = input.value;
        draft = updateEditorField(draft, `gallery.${index}.${key}`, value);
        renderPreview();
        renderValidation();
        renderBadges();
        persist(false);
      });
    }
    row.querySelector('[data-gallery-up]')?.addEventListener('click', () => {
      if (!draft) return;
      draft = moveGalleryItem(draft, index, index - 1);
      renderGallery();
      renderPreview();
      renderValidation();
      persist(false);
    });
    row.querySelector('[data-gallery-down]')?.addEventListener('click', () => {
      if (!draft) return;
      draft = moveGalleryItem(draft, index, index + 1);
      renderGallery();
      renderPreview();
      renderValidation();
      persist(false);
    });
    row.querySelector('[data-gallery-remove]')?.addEventListener('click', () => {
      if (!draft) return;
      draft = removeGalleryItem(draft, index);
      renderGallery();
      renderPreview();
      renderValidation();
      renderBadges();
      persist(false);
    });
    galleryList.append(fragment);
  });
}

function renderPreview() {
  if (!draft) return;
  const model = toEditorPreviewModel(draft);
  if (cardPreviewRoot) renderCardPreview(cardPreviewRoot, model);
  if (detailPreviewRoot) renderDetailPreview(detailPreviewRoot, model);
  if (mobilePreviewRoot) renderCardPreview(mobilePreviewRoot, model);
}

function renderValidation() {
  if (!validationList || !validationSummary) return;
  validationList.replaceChildren();
  if (!draft) {
    validationSummary.textContent = '选择条目后显示校验结果。';
    return;
  }
  const issues = validateEditorDraft(draft, { forPublish: true });
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  validationSummary.textContent =
    errors.length === 0 && warnings.length === 0
      ? '校验通过：没有发现阻止发布的错误。'
      : `发现 ${errors.length} 个错误、${warnings.length} 个提醒。`;
  if (issues.length === 0) {
    const item = document.createElement('li');
    item.dataset['severity'] = 'ok';
    item.textContent = '结构与许可校验通过。';
    validationList.append(item);
    return;
  }
  for (const issue of issues) {
    const item = document.createElement('li');
    item.dataset['severity'] = issue.severity;
    item.textContent = `${issue.path}：${issue.message}`;
    validationList.append(item);
  }
}

function renderConflicts() {
  if (!conflictPanel || !conflictList || !applyConflictsButton) return;
  conflictList.replaceChildren();
  if (!draft || !plan) {
    conflictPanel.hidden = true;
    applyConflictsButton.disabled = true;
    return;
  }
  const changed = plan.fields.filter((field) => field.upstreamChanged);
  if (changed.length === 0) {
    conflictPanel.hidden = true;
    applyConflictsButton.disabled = true;
    return;
  }
  conflictPanel.hidden = false;
  for (const field of changed) {
    const item = document.createElement('div');
    item.className = 'conflict-item';
    item.dataset['conflictItem'] = field.path;
    const title = document.createElement('strong');
    title.textContent = `${field.label}（${field.path}）`;
    item.append(title);
    const values = document.createElement('div');
    values.className = 'conflict-values';
    const local = document.createElement('div');
    local.textContent = `本地：${field.current ?? '（空）'}`;
    const upstream = document.createElement('div');
    upstream.textContent = `上游：${field.upstream ?? '（空）'}`;
    values.append(local, upstream);
    item.append(values);
    if (field.requiresDecision) {
      const options = document.createElement('div');
      for (const [choice, label] of [
        ['keep-local', '保留本地'],
        ['take-upstream', '采用上游'],
      ] as const) {
        const optionLabel = document.createElement('label');
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = `conflict:${field.path}`;
        radio.value = choice;
        radio.dataset['conflictChoice'] = `${field.path}:${choice}`;
        radio.checked = decisions.get(field.path) === choice;
        radio.addEventListener('change', () => {
          decisions.set(field.path, choice);
          renderConflicts();
        });
        optionLabel.append(radio, ` ${label} `);
        options.append(optionLabel);
      }
      item.append(options);
    } else {
      const note = document.createElement('p');
      note.textContent = '本地未修改，应用时会采用上游值。';
      item.append(note);
    }
    conflictList.append(item);
  }
  applyConflictsButton.disabled = plan.fields.some(
    (field) => field.upstreamChanged && field.requiresDecision && !decisions.has(field.path),
  );
  if (plan.fields.some((field) => field.upstreamChanged && field.requiresDecision)) {
    conflictList.dataset['requiresDecision'] = 'true';
  } else {
    delete conflictList.dataset['requiresDecision'];
  }
}

function updateReimportState() {
  if (!reimportButton) return;
  reimportButton.disabled = !draft?.identity.sourceRepo || !draft.identity.sourcePath;
}

function applyDomValue(element: HTMLElement, path: string) {
  if (!draft) return;
  let value: unknown;
  if (element instanceof HTMLInputElement) {
    value = element.type === 'checkbox' ? element.checked : element.value;
  } else if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    value = element.value;
  } else {
    return;
  }
  if (path === 'slug') {
    const slugValue = String(value).trim();
    draft = { ...draft, slug: slugValue, updatedAt: new Date().toISOString() };
  } else if (path === 'tags' || path === 'supportedTools') {
    draft = updateEditorField(draft, path, splitEditorList(String(value)));
  } else {
    draft = updateEditorField(draft, path, value);
  }
  if (path === 'description' && descriptionCount) {
    descriptionCount.textContent = String(draft.fields.description.length);
  }
  if (path === 'type' || path === 'status') renderFormValues();
  renderBadges();
  renderPreview();
  renderValidation();
  persist(false);
}

function bindFormField(path: string) {
  const element = byField<HTMLElement>(path);
  if (!element || path === 'gallery') return;
  const event =
    element instanceof HTMLSelectElement
      ? 'change'
      : element instanceof HTMLInputElement && element.type === 'checkbox'
        ? 'change'
        : 'input';
  element.addEventListener(event, () => applyDomValue(element, path));
}

async function reimportSource() {
  if (!draft?.identity.sourceRepo || !draft.identity.sourcePath) return;
  const sourceUrl = buildSourceUrl(draft);
  if (!sourceUrl) {
    setStatus('缺少可用的来源链接，无法重新导入。', 'error');
    return;
  }
  if (reimportButton) reimportButton.disabled = true;
  setStatus('正在通过受保护的只读 API 重新解析来源；不会写入仓库。', 'info');
  try {
    const response = await fetch('/api/admin/import/preview', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Idempotency-Key': randomKey(),
      },
      body: JSON.stringify({ sourceUrl }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      const code = typeof body.error === 'string' ? body.error : 'import_preview_failed';
      const retryAfter = response.headers.get('Retry-After');
      setStatus(
        response.status === 429 && retryAfter
          ? `上游限流，请等待 ${retryAfter} 秒后重试（${code}）。`
          : `重新导入失败：${code}。`,
        'error',
      );
      return;
    }
    const candidates = body.candidates;
    if (!Array.isArray(candidates)) {
      setStatus('上游返回了无法解析的候选列表。', 'error');
      return;
    }
    const repoKey = draft.identity.sourceRepo.toLocaleLowerCase('en-US');
    const match = candidates.find(
      (item): item is Record<string, unknown> =>
        Boolean(item) &&
        typeof item === 'object' &&
        (item as Record<string, unknown>).sourceRepo === draft?.identity.sourceRepo &&
        (item as Record<string, unknown>).sourcePath === draft?.identity.sourcePath &&
        String((item as Record<string, unknown>).sourceRepo).toLocaleLowerCase('en-US') === repoKey,
    );
    if (!match) {
      setStatus('来源中没有找到与 repo+path 匹配的条目；不会创建重复卡片。', 'error');
      return;
    }
    const candidate: EditorImportCandidate = {
      sourceRepo: String(match['sourceRepo']),
      sourcePath: String(match['sourcePath']),
      sourceSha: String(match['sourceSha']),
      sourceAttribution: String(
        match['sourceAttribution'] ?? draft.identity.sourceAttribution ?? '',
      ),
      license: String(match['license'] ?? draft.identity.license ?? ''),
      licenseStatus:
        match['licenseStatus'] === 'redistributable' ||
        match['licenseStatus'] === 'restricted' ||
        match['licenseStatus'] === 'unknown'
          ? match['licenseStatus']
          : 'unknown',
      name: String(match['name'] ?? draft.fields.name),
      description:
        typeof match['description'] === 'string'
          ? match['description']
          : match['description'] === null
            ? null
            : draft.fields.description,
      suggestedSlug: String(match['suggestedSlug'] ?? draft.slug),
    };
    lastCandidate = candidate;
    decisions.clear();
    plan = buildUpstreamPlan(draft, candidate);
    if (plan.fields.every((field) => !field.upstreamChanged)) {
      plan = null;
      renderConflicts();
      setStatus('来源与当前草稿一致，没有需要处理的更新。', 'success');
      return;
    }
    renderConflicts();
    conflictPanel?.scrollIntoView({ block: 'nearest' });
    setStatus(
      plan.requiresExplicitDecision
        ? '检测到本地修改与上游更新冲突，请逐字段选择后再应用。'
        : '检测到上游更新；确认后应用所选字段。',
      'warning',
    );
  } catch {
    setStatus('重新导入请求失败；未修改任何本地内容。', 'error');
  } finally {
    updateReimportState();
  }
}

function buildSourceUrl(current: EditorDraft): string | undefined {
  if (!current.identity.sourceRepo || !current.identity.sourcePath) return undefined;
  const repo = current.identity.sourceRepo;
  const path = current.identity.sourcePath;
  const ref = current.identity.sourceSha ?? 'HEAD';
  const encoded = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `https://github.com/${repo}/blob/${ref}/${encoded}`;
}

function randomKey() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function bindStaticEvents() {
  entrySelect?.addEventListener('change', () => {
    if (entrySelect.value) openPublishedEntry(entrySelect.value);
    else setStatus('已清空选择；已载入的草稿仍保留在本浏览器。', 'info');
  });
  newButton?.addEventListener('click', openNewDraft);
  reimportButton?.addEventListener('click', () => void reimportSource());
  restoreButton?.addEventListener('click', () => {
    if (!pendingRestore) return;
    draft = pendingRestore;
    pendingRestore = null;
    if (draftBanner) draftBanner.hidden = true;
    if (lastCandidate) plan = buildUpstreamPlan(draft, lastCandidate);
    renderAll();
    setStatus('已恢复浏览器草稿；请检查校验与来源差异。', 'info');
  });
  discardButton?.addEventListener('click', () => {
    if (!draft) return;
    removeStoredDraft(draft.slug);
    pendingRestore = null;
    if (draftBanner) draftBanner.hidden = true;
    setStatus('已丢弃浏览器草稿；当前显示的是已发布内容。', 'info');
  });
  saveButton?.addEventListener('click', () => persist(true));
  resetButton?.addEventListener('click', () => {
    if (!draft) return;
    draft = resetEditorDraft(draft);
    plan = null;
    decisions.clear();
    renderAll();
    persist(false);
    setStatus('已重置为已发布基线；本地修改已清除。', 'info');
  });
  exportButton?.addEventListener('click', () => void exportDraft());
  applyConflictsButton?.addEventListener('click', () => {
    if (!draft || !plan) return;
    try {
      draft = applyUpstreamDecisions(draft, plan, Object.fromEntries(decisions));
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
      setStatus(
        code === 'unresolved_upstream_conflict'
          ? '仍有冲突字段未选择，已取消应用。'
          : '应用上游更新失败，未修改本地内容。',
        'error',
      );
      return;
    }
    plan = null;
    lastCandidate = null;
    decisions.clear();
    renderAll();
    persist(false);
    setStatus('已按所选字段应用上游更新；本地保留项仍标记为手动修改。', 'success');
  });
  cancelConflictsButton?.addEventListener('click', () => {
    plan = null;
    lastCandidate = null;
    decisions.clear();
    renderConflicts();
    setStatus('已取消上游更新；本地草稿未改变。', 'info');
  });
  galleryAddButton?.addEventListener('click', () => {
    if (!draft) return;
    draft = addGalleryItem(draft);
    renderGallery();
    renderBadges();
    renderPreview();
    renderValidation();
    persist(false);
  });
  for (const path of fieldPaths) bindFormField(path);
  bindFormField('slug');
  for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-preview-tab]')) {
    tab.addEventListener('click', () => {
      const target = tab.dataset['previewTab'];
      for (const candidate of document.querySelectorAll<HTMLButtonElement>('[data-preview-tab]')) {
        candidate.setAttribute('aria-selected', String(candidate === tab));
      }
      for (const panel of document.querySelectorAll<HTMLElement>('[data-preview-panel]')) {
        panel.hidden = panel.dataset['previewPanel'] !== target;
      }
    });
  }
}

async function exportDraft() {
  if (!draft || !exportOutput) return;
  let snapshotHash = '';
  try {
    snapshotHash = await computeSnapshotHash(draft.fields);
  } catch {
    snapshotHash = '';
  }
  const payload = {
    schemaVersion: EDITOR_DRAFT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    snapshotHash,
    nextStep: 'Phase 4 publish pipeline is not enabled yet; this payload is local only.',
    draft,
  };
  exportOutput.textContent = JSON.stringify(payload, null, 2);
  exportOutput.hidden = false;
  setStatus('已在本页生成更新草稿 JSON；未发送到服务器、未写入仓库。', 'success');
}

async function bootstrap() {
  bindStaticEvents();
  try {
    const response = await fetch('/api/admin/editor/catalog', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!response.ok) {
      setStatus('无法读取已发布条目；后台可能尚未完成 Access 配置。', 'error');
      return;
    }
    catalog = readCandidates(await response.json());
    renderEntrySelect();
  } catch {
    setStatus('无法读取已发布条目；请检查网络与 Access 会话。', 'error');
    return;
  }

  const handoff = readHandoff();
  if (handoff) {
    openHandoff(handoff);
    return;
  }
  setStatus('选择已发布条目，或从导入页选择候选后在编辑器中打开。', 'info');
}

void bootstrap();

export {};
