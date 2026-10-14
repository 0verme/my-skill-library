import {
  containsCredentialLikeKeys,
  EDITOR_HANDOFF_KEY,
  type EditorImportCandidate,
} from '../lib/admin/editor-model.ts';

interface ImportCandidate {
  sourceRepo: string;
  sourcePath: string;
  sourceUrl: string;
  sourceSha: string;
  sourceAttribution: string;
  license: string;
  licenseStatus: 'redistributable' | 'restricted' | 'unknown';
  sourceStatus: 'unverified';
  name: string;
  description: string | null;
  suggestedSlug: string;
  mode: 'content-preview' | 'metadata-only';
  markdownPreview?: string;
  markdownWarnings: string[];
  state: 'new' | 'already-imported' | 'update-available' | 'slug-conflict';
  existingSlug?: string;
  updateRequiresConfirmation: boolean;
  preserveLocalChanges: boolean;
  selectable: boolean;
}

interface ImportPreview {
  sourceRepo: string;
  resolvedRef: string;
  sourceSha: string;
  candidates: ImportCandidate[];
  errors: Array<{ code: string; path?: string }>;
  warnings: string[];
  partial: boolean;
}

const form = document.querySelector<HTMLFormElement>('[data-import-form]');
const input = document.querySelector<HTMLInputElement>('#github-source');
const submitButton = document.querySelector<HTMLButtonElement>('[data-import-submit]');
const status = document.querySelector<HTMLElement>('[data-import-status]');
const results = document.querySelector<HTMLElement>('[data-import-results]');
const selectionSummary = document.querySelector<HTMLElement>('[data-selection-summary]');
const selectedButton = document.querySelector<HTMLButtonElement>('[data-preview-selected]');
const selectedPreview = document.querySelector<HTMLElement>('[data-selected-preview]');
let currentSelection = new Map<string, ImportCandidate>();

const errorMessages: Record<string, string> = {
  invalid_source_url: '请提供有效的 GitHub HTTPS 链接。',
  unsupported_github_url: '仅支持 github.com 仓库、tree 目录和 blob/SKILL.md 链接。',
  invalid_repository_path: '来源路径包含非法或编码路径片段。',
  skill_file_required: '文件链接必须指向大小写准确的 SKILL.md。',
  repository_not_found_or_private: '仓库不存在、不是公开仓库，或当前 GitHub API 无法读取。',
  invalid_github_response: 'GitHub API 返回了无法安全解析的数据。',
  github_rate_limited: 'GitHub API 已限流，请等待 Retry-After 后重试。',
  github_timeout: 'GitHub API 请求超时；没有执行或保存任何来源内容。',
  github_unavailable: '暂时无法连接 GitHub API，请稍后重试。',
  api_request_limit: '本次来源解析触发了 API 请求数量保护上限。',
  response_too_large: '来源文件或响应超过单项大小限制。',
  total_response_limit: '本次解析超过累计字节限制。',
  tree_too_large_or_truncated:
    '仓库 Git tree 过大或被 GitHub 截断，请改用更具体的 Skill 目录链接。',
  invalid_source_path: '没有找到与来源 ref/path 对应的有效目录或 SKILL.md。',
  no_skill_files: '此来源中没有可导入的 SKILL.md。',
  invalid_frontmatter: 'SKILL.md 的 YAML frontmatter 缺失、无效或包含不安全结构。',
  invalid_skill_metadata: 'SKILL.md 必须包含有效的字符串 name 与 description。',
  invalid_skill_encoding: '上游 Skill 文件不是有效的 UTF-8 文本。',
  unsafe_upstream_path: '上游路径不安全，已跳过此项目。',
  unsafe_or_deep_source_path: '上游路径包含非法结构或超过最大深度，已跳过。',
  unsupported_skill_file_type: 'SKILL.md 不是受支持的普通文件，已跳过。',
  symlink_or_submodule_not_imported: 'symlink 或 submodule 不会被跟随或导入。',
  skill_file_too_large: 'SKILL.md 超过单文件大小上限，已跳过。',
  license_read_failed: '无法安全读取该项目的许可文件，已跳过正文预览。',
  import_catalog_unavailable: '无法读取当前内容目录，已停止解析以避免覆盖或重复导入。',
  payload_too_large: '请求内容超过安全大小限制。',
  unsupported_media_type: '请求格式不受支持。',
  invalid_json: '请求格式无效。',
  cross_origin_request: '跨站请求被拒绝。',
  idempotency_key_required: '缺少幂等请求标识，请重新提交。',
  authentication_unavailable: '管理身份验证暂不可用，请稍后重试。',
};

const licenseLabels: Record<ImportCandidate['licenseStatus'], string> = {
  redistributable: '已识别可再分发许可（仍需人工检查）',
  restricted: '限制再分发：仅显示来源元数据',
  unknown: '许可未知：仅显示来源元数据',
};

const stateLabels: Record<ImportCandidate['state'], string> = {
  new: '新来源',
  'already-imported': '已收录且版本相同',
  'update-available': '上游已有更新',
  'slug-conflict': 'Slug 冲突，不能覆盖',
};

const warningLabels: Record<string, string> = {
  license_file_too_large: '许可文件超过读取上限，按未知许可处理且不预览正文。',
  discovery_depth_limit_reached: '超过最大目录深度的项目已跳过。',
  discovery_item_limit_reached: '仅显示安全上限内的项目；请改用更具体的目录。',
  upstream_tree_truncated: 'GitHub 返回的目录树被截断，结果可能不完整。',
  raw_html_not_rendered: '检测到原始 HTML，预览被隐藏且不会渲染。',
  unsafe_markdown_link: '检测到危险 Markdown 链接，正文预览已隐藏。',
  invalid_markdown_link: '检测到无效 Markdown 链接，正文预览已隐藏。',
  relative_link_not_resolved: '检测到未解析的相对链接，正文预览已隐藏。',
  http_link_requires_review: '正文含 HTTP 链接；需要人工审查后再使用。',
  external_media_not_copied: '外部媒体不会下载或复制，必须单独核验许可与归属。',
  markdown_parse_failed: 'Markdown 无法安全解析，正文预览已隐藏。',
  markdown_node_limit_reached: 'Markdown 结构超过安全解析上限，正文预览已隐藏。',
};

function messageFor(code: string) {
  return errorMessages[code] ?? `解析未完成（${code}）。`;
}

function appendText(
  parent: HTMLElement,
  tag: keyof HTMLElementTagNameMap,
  text: string,
  className?: string,
) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  parent.append(element);
  return element;
}

function safeGitHubHref(value: string) {
  try {
    const url = new URL(value);
    if (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      !url.username &&
      !url.password
    ) {
      return url.href;
    }
  } catch {
    // Malformed server data is displayed as plain text instead of a link.
  }
  return undefined;
}

function requestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function renderErrorList(parent: HTMLElement, errors: Array<{ code: string; path?: string }>) {
  if (!errors.length) return;
  const list = document.createElement('ul');
  list.className = 'import-error-list';
  for (const error of errors) {
    const item = document.createElement('li');
    const message = messageFor(error.code);
    item.textContent = error.path ? `${error.path}：${message}` : message;
    list.append(item);
  }
  parent.append(list);
}

function renderCandidate(
  candidate: ImportCandidate,
  selectedCandidates: Map<string, ImportCandidate>,
) {
  const article = document.createElement('article');
  article.className = 'import-candidate';
  const identity = `${candidate.sourceRepo}\n${candidate.sourcePath}`;
  const label = document.createElement('label');
  label.className = 'candidate-select';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = false;
  checkbox.disabled = !candidate.selectable;
  checkbox.dataset.candidateIdentity = identity;
  checkbox.setAttribute('aria-label', `选择 ${candidate.name} (${candidate.sourcePath})`);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) selectedCandidates.set(identity, candidate);
    else selectedCandidates.delete(identity);
    updateSelection(selectedCandidates);
  });
  label.append(checkbox);
  const labelText = document.createElement('span');
  labelText.textContent = '选择此条目（默认未选择）';
  label.append(labelText);
  article.append(label);

  appendText(article, 'h3', candidate.name, 'candidate-title');
  if (candidate.description)
    appendText(article, 'p', candidate.description, 'candidate-description');
  const path = document.createElement('p');
  path.className = 'candidate-path';
  path.textContent = `${candidate.sourceRepo}/${candidate.sourcePath}`;
  article.append(path);

  const sourceHref = safeGitHubHref(candidate.sourceUrl);
  if (sourceHref) {
    const sourceLink = document.createElement('a');
    sourceLink.href = sourceHref;
    sourceLink.target = '_blank';
    sourceLink.rel = 'noopener noreferrer';
    sourceLink.textContent = '查看固定版本来源 ↗';
    article.append(sourceLink);
  }

  const facts = document.createElement('dl');
  facts.className = 'candidate-facts';
  const factValues: Array<[string, string]> = [
    ['许可', `${candidate.license} · ${licenseLabels[candidate.licenseStatus] ?? '状态未知'}`],
    ['版本', candidate.sourceSha],
    ['归属', candidate.sourceAttribution],
    ['验证状态', candidate.sourceStatus === 'unverified' ? '未验证' : candidate.sourceStatus],
    ['建议 slug', candidate.suggestedSlug],
    ['现有 slug', candidate.existingSlug ?? '尚未收录'],
    ['导入状态', stateLabels[candidate.state] ?? candidate.state],
  ];
  for (const [term, value] of factValues) {
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    row.append(dt, dd);
    facts.append(row);
  }
  article.append(facts);

  if (candidate.state === 'update-available') {
    appendText(
      article,
      'p',
      '检测到同一来源的新 Commit。开始更新前必须再次确认；服务端不会覆盖已有条目，本地人工修改需要保留并逐字段审查。',
      'candidate-warning',
    );
  } else if (candidate.state === 'slug-conflict') {
    appendText(
      article,
      'p',
      '此 slug 已被其他来源使用；请在后续编辑阶段显式调整，不能覆盖现有条目。',
      'candidate-warning',
    );
  } else if (candidate.state === 'already-imported') {
    appendText(article, 'p', '来源与 Commit 均已收录，本次不会再次创建条目。', 'candidate-note');
  }

  if (candidate.mode === 'metadata-only') {
    appendText(
      article,
      'p',
      '没有复制上游正文或媒体。请按许可策略自行撰写简短说明，并保留来源链接与归属。',
      'candidate-warning',
    );
  } else if (candidate.markdownPreview) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '只读查看上游 Markdown（作为文本，不执行）';
    const preview = document.createElement('pre');
    preview.className = 'markdown-preview';
    preview.textContent = candidate.markdownPreview;
    details.append(summary, preview);
    article.append(details);
  }

  if (candidate.markdownWarnings.length) {
    const warningList = document.createElement('ul');
    warningList.className = 'import-warning-list';
    for (const warning of candidate.markdownWarnings) {
      const item = document.createElement('li');
      item.textContent = warningLabels[warning] ?? `需要人工检查：${warning}`;
      warningList.append(item);
    }
    article.append(warningList);
  }
  return article;
}

function updateSelection(selectedCandidates: Map<string, ImportCandidate>) {
  if (!selectionSummary || !selectedButton) return;
  const count = selectedCandidates.size;
  selectionSummary.textContent =
    count === 0
      ? '已选择 0 项。批量选择不会自动全选，也不会写入仓库。'
      : `已选择 ${count} 项。当前阶段仅生成只读预览，不会写入仓库。`;
  selectedButton.disabled = count === 0;
}

function showSelectedPreview(selectedCandidates: Map<string, ImportCandidate>) {
  if (!selectedPreview) return;
  selectedPreview.replaceChildren();
  selectedPreview.hidden = false;
  appendText(selectedPreview, 'h3', `所选预览（${selectedCandidates.size} 项）`);
  appendText(selectedPreview, 'p', '这些是待编辑候选；本阶段不会创建草稿文件、分支或 PR。');
  const list = document.createElement('ul');
  for (const candidate of selectedCandidates.values()) {
    const item = document.createElement('li');
    item.textContent = `${candidate.name} — ${candidate.sourceRepo}/${candidate.sourcePath} — ${candidate.licenseStatus}`;
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'import-button import-button-secondary';
    openButton.textContent = '在编辑器中打开';
    openButton.addEventListener('click', () => openInEditor(candidate, openButton));
    item.append(openButton);
    list.append(item);
  }
  selectedPreview.append(list);
}

function openInEditor(candidate: ImportCandidate, button: HTMLButtonElement) {
  const handoff: EditorImportCandidate = {
    sourceRepo: candidate.sourceRepo,
    sourcePath: candidate.sourcePath,
    sourceSha: candidate.sourceSha,
    sourceAttribution: candidate.sourceAttribution,
    license: candidate.license,
    licenseStatus: candidate.licenseStatus,
    name: candidate.name,
    description: candidate.description,
    suggestedSlug: candidate.suggestedSlug,
  };
  if (containsCredentialLikeKeys(handoff)) {
    button.disabled = true;
    return;
  }
  try {
    localStorage.setItem(
      EDITOR_HANDOFF_KEY,
      JSON.stringify({ schemaVersion: 1, candidate: handoff }),
    );
  } catch {
    if (status) {
      status.textContent = '无法在当前浏览器保存编辑器交接数据；请检查隐私设置后重试。';
      status.dataset.state = 'error';
    }
    return;
  }
  window.location.assign('/admin/editor');
}

async function parseSource() {
  if (!form || !input || !submitButton || !status || !results) return;
  if (!form.reportValidity()) return;
  const sourceUrl = input.value;
  submitButton.disabled = true;
  status.textContent = '正在安全解析公开 GitHub API；此操作不会执行 Skill 内容或写入仓库。';
  results.replaceChildren();
  if (selectedPreview) {
    selectedPreview.replaceChildren();
    selectedPreview.hidden = true;
  }
  const selectedCandidates = new Map<string, ImportCandidate>();
  currentSelection = selectedCandidates;
  updateSelection(selectedCandidates);

  try {
    const response = await fetch('/api/admin/import/preview', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Idempotency-Key': requestId(),
      },
      body: JSON.stringify({ sourceUrl }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      const code = typeof body.error === 'string' ? body.error : 'import_preview_failed';
      const retryAfter = response.headers.get('Retry-After');
      const suffix =
        response.status === 429 && retryAfter ? ` 建议等待 ${retryAfter} 秒后重试。` : '';
      status.textContent = `${messageFor(code)}${suffix}`;
      status.dataset.state = 'error';
      return;
    }

    const preview = body as unknown as ImportPreview;
    if (
      !Array.isArray(preview.candidates) ||
      !Array.isArray(preview.errors) ||
      !Array.isArray(preview.warnings)
    ) {
      status.textContent = messageFor('invalid_github_response');
      status.dataset.state = 'error';
      return;
    }
    const summary = document.createElement('p');
    summary.className = 'import-result-summary';
    summary.textContent = `来源 ${preview.sourceRepo} · ref ${preview.resolvedRef} · Commit ${preview.sourceSha} · 发现 ${preview.candidates.length} 项`;
    results.append(summary);

    if (preview.partial) {
      appendText(
        results,
        'p',
        '本次解析有部分结果或限制项；请先逐项检查错误与警告。',
        'candidate-warning',
      );
    }
    for (const warning of preview.warnings) {
      appendText(
        results,
        'p',
        warningLabels[warning] ?? `解析警告：${warning}`,
        'candidate-warning',
      );
    }
    renderErrorList(results, preview.errors);

    const list = document.createElement('div');
    list.className = 'candidate-list';
    for (const candidate of preview.candidates) {
      if (
        !candidate ||
        typeof candidate.name !== 'string' ||
        typeof candidate.sourcePath !== 'string' ||
        typeof candidate.sourceRepo !== 'string' ||
        !Array.isArray(candidate.markdownWarnings)
      ) {
        continue;
      }
      list.append(renderCandidate(candidate, selectedCandidates));
    }
    results.append(list);
    if (preview.candidates.length === 0 && preview.errors.length === 0) {
      appendText(results, 'p', messageFor('no_skill_files'));
    }
    updateSelection(selectedCandidates);
    status.textContent = preview.candidates.length
      ? '解析完成。请核对来源、许可与状态；选择框默认未勾选。当前没有任何写入操作。'
      : '没有可预览的 Skill；请查看上方错误或调整来源链接。';
    status.dataset.state = preview.errors.length || preview.warnings.length ? 'warning' : 'success';
  } catch {
    status.textContent = '请求失败；请检查网络与 Access 会话后重试。不会保存部分结果。';
    status.dataset.state = 'error';
  } finally {
    submitButton.disabled = false;
  }
}

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  void parseSource();
});

selectedButton?.addEventListener('click', () => {
  if (currentSelection.size > 0) showSelectedPreview(currentSelection);
});

export {};
