import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import {
  createDraftFromPublished,
  updateEditorField,
  validateEditorDraft,
  type EditorCatalogEntry,
  type EditorDraft,
  type EditorFields,
} from '../src/lib/admin/editor-model.ts';
import {
  branchNameForSlug,
  buildPublishPlan,
  buildPublishedMarkdown,
  evaluateAutoMerge,
  extractBody,
  mapPublishStage,
  PUBLISH_LIMITS,
  publishPathForSlug,
  publishValidation,
  PublishError,
  pullBodyForEntry,
  pullTitleForEntry,
  validatePublishRequest,
  type PullSummary,
} from '../src/lib/admin/publish.ts';

const shaA = 'a'.repeat(40);

const fields: EditorFields = {
  name: 'Demo Skill',
  description: '演示简介。',
  type: 'skill',
  category: '设计',
  tags: ['标签'],
  supportedTools: ['ChatGPT'],
  installCommand: 'npm install demo',
  cover: '/skills/demo-skill/cover.svg',
  gallery: [{ type: 'image', src: '/skills/demo-skill/cover.svg', alt: '封面' }],
  body: '## 使用说明\n\n正文内容。',
  featured: false,
  status: 'unverified',
};

function entry(): EditorCatalogEntry {
  return {
    slug: 'demo-skill',
    identity: {
      sourceRepo: 'anthropics/skills',
      sourcePath: 'skills/demo/SKILL.md',
      sourceSha: shaA,
      license: 'Apache-2.0',
      licenseStatus: 'redistributable',
      sourceAttribution: 'anthropics/skills',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-10T00:00:00.000Z',
    },
    fields,
  };
}

function draft(): EditorDraft {
  return createDraftFromPublished(entry(), new Date('2026-10-14T00:00:00.000Z'));
}

function request(current: EditorDraft = draft()) {
  return { slug: current.slug, draft: current, confirmPublish: true as const };
}

test('发布请求校验：结构、确认、数量、重复 slug 与草稿合法性', () => {
  const valid = validatePublishRequest({ entries: [request()] });
  assert.equal(valid.length, 1);
  assert.equal(valid[0]?.slug, 'demo-skill');

  assert.throws(
    () => validatePublishRequest({ entries: [{ ...request(), confirmPublish: false }] }),
    (error: unknown) =>
      error instanceof PublishError && error.code === 'publish_confirmation_required',
  );
  assert.throws(
    () => validatePublishRequest({ entries: [] }),
    (error: unknown) => error instanceof PublishError && error.code === 'invalid_publish_request',
  );
  assert.throws(
    () => validatePublishRequest({ entries: Array.from({ length: 9 }, () => request()) }),
    (error: unknown) => error instanceof PublishError && error.code === 'invalid_publish_request',
  );
  assert.throws(
    () => validatePublishRequest({ entries: [request(), request()] }),
    (error: unknown) => error instanceof PublishError && error.code === 'invalid_publish_request',
  );
  const mismatched = { ...request(), slug: 'other-slug' };
  assert.throws(
    () => validatePublishRequest({ entries: [mismatched] }),
    (error: unknown) => error instanceof PublishError && error.code === 'invalid_publish_request',
  );
  assert.throws(
    () =>
      validatePublishRequest({
        entries: [{ slug: 'demo-skill', draft: 'nope', confirmPublish: true }],
      }),
    (error: unknown) => error instanceof PublishError && error.code === 'invalid_publish_request',
  );
});

test('发布 Markdown 生成含来源身份、许可与正文，YAML 可安全往返', async () => {
  const result = await buildPublishedMarkdown(draft(), {
    now: new Date('2026-10-14T12:00:00.000Z'),
  });
  assert.equal(result.path, publishPathForSlug('demo-skill'));
  const match = result.content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  assert.ok(match, 'frontmatter should be present');
  const frontmatter = parseYaml(match[1]!) as Record<string, unknown>;
  assert.equal(frontmatter['name'], 'Demo Skill');
  assert.equal(frontmatter['sourceRepo'], 'anthropics/skills');
  assert.equal(frontmatter['sourcePath'], 'skills/demo/SKILL.md');
  assert.equal(frontmatter['sourceSha'], shaA);
  assert.equal(frontmatter['license'], 'Apache-2.0');
  assert.equal(frontmatter['licenseStatus'], 'redistributable');
  assert.equal(frontmatter['importedSnapshotHash'], result.snapshotHash);
  assert.equal(frontmatter['type'], 'skill');
  assert.equal(
    frontmatter['body'],
    undefined,
    'body must live in the Markdown body, not frontmatter',
  );
  assert.match(match[2]!, /正文内容/);
  assert.match(result.contentHash, /^[a-f0-9]{64}$/);
  assert.ok(!('token' in frontmatter));
  assert.ok(new TextEncoder().encode(result.content).byteLength < PUBLISH_LIMITS.maxMarkdownBytes);
});

test('发布 Markdown 保留已有正文，且不会静默改写来源声明', async () => {
  const sourceLess = draft();
  sourceLess.fields.body = '';
  delete sourceLess.identity.sourceRepo;
  delete sourceLess.identity.sourcePath;
  delete sourceLess.identity.sourceSha;
  delete sourceLess.identity.license;
  delete sourceLess.identity.licenseStatus;
  delete sourceLess.identity.sourceAttribution;
  sourceLess.identity.sourceAttribution = 'demo';
  const result = await buildPublishedMarkdown(sourceLess, {
    existingBody: '## 原有正文\n\n保留内容。',
    now: new Date('2026-10-14T12:00:00.000Z'),
  });
  const frontmatter = parseYaml(result.content.split('---')[1] ?? '') as Record<string, unknown>;
  assert.equal(frontmatter['sourceRepo'], undefined);
  assert.equal(frontmatter['license'], undefined);
  assert.match(result.content, /保留内容/);

  const keepBody = updateEditorField(draft(), 'body', '');
  const withExisting = await buildPublishedMarkdown(keepBody, { existingBody: '旧正文保留。' });
  assert.match(withExisting.content, /旧正文保留/);
});

test('许可与校验门槛阻止发布', async () => {
  const restricted = draft();
  restricted.identity.licenseStatus = 'restricted';
  const issues = validateEditorDraft(restricted, { forPublish: true });
  assert.ok(
    issues.some((issue) => issue.code === 'license_not_publishable' && issue.severity === 'error'),
  );
  await assert.rejects(
    buildPublishedMarkdown(restricted),
    (error: unknown) => error instanceof PublishError && error.code === 'publish_validation_failed',
  );

  const oversized = draft();
  oversized.fields.body = 'x'.repeat(33 * 1024);
  await assert.rejects(
    buildPublishedMarkdown(oversized),
    (error: unknown) =>
      error instanceof PublishError &&
      error.code === 'publish_validation_failed' &&
      Boolean(error.issues?.some((issue) => issue.code === 'body_too_long')),
  );

  const sourceLess = draft();
  delete sourceLess.identity.sourceRepo;
  delete sourceLess.identity.sourcePath;
  delete sourceLess.identity.sourceSha;
  delete sourceLess.identity.licenseStatus;
  assert.equal(publishValidation(sourceLess).ok, true);
});

test('幂等计划：创建、更新、无变化与阻止', async () => {
  const create = await buildPublishPlan(request(), { file: null, pull: null, branchExists: false });
  assert.equal(create.action, 'create');
  assert.equal(create.blockedReasons.length, 0);
  assert.match(create.branch, /^content\/demo-skill$/);
  assert.ok(create.content.includes('Demo Skill'));

  const existing = await buildPublishedMarkdown(draft());
  const update = await buildPublishPlan(request(), {
    file: { text: '---\nname: Old\n---\n\n旧正文', sha: 'b'.repeat(40) },
    pull: { number: 9, url: 'https://github.com/o/r/pull/9', state: 'open', headSha: shaA },
    branchExists: true,
  });
  assert.equal(update.action, 'update');
  assert.equal(update.fileSha, 'b'.repeat(40));
  assert.ok(update.content.includes('正文内容'), 'existing body is replaced by edited body');

  const noop = await buildPublishPlan(request(), {
    file: { text: existing.content, sha: 'c'.repeat(40) },
    pull: { number: 9, url: 'https://github.com/o/r/pull/9', state: 'open', headSha: shaA },
    branchExists: true,
  });
  assert.equal(noop.action, 'noop');

  const blockedDraft = draft();
  blockedDraft.identity.licenseStatus = 'unknown';
  const blocked = await buildPublishPlan(
    { slug: 'demo-skill', draft: blockedDraft },
    { file: null, pull: null, branchExists: false },
  );
  assert.equal(blocked.action, 'blocked');
  assert.ok(blocked.blockedReasons.includes('validation_failed'));
  assert.ok(blocked.blockedReasons.includes('license_blocked'));

  const merged = await buildPublishPlan(request(), {
    file: null,
    pull: { number: 9, url: 'https://github.com/o/r/pull/9', state: 'merged', headSha: shaA },
    branchExists: true,
  });
  assert.equal(
    merged.action,
    'create',
    'merging a PR leaves the branch; the next publish creates a new cycle',
  );
});

test('受控合并门槛逐项判定，任何未满足条件都阻止合并', () => {
  const open = {
    number: 1,
    url: 'https://github.com/o/r/pull/1',
    state: 'open' as const,
    headSha: shaA,
  };
  const allowed = evaluateAutoMerge(
    { pull: open, mergeable: true, checks: 'passed', failingChecks: [], licenseAllowed: true },
    true,
  );
  assert.equal(allowed.allowed, true);

  const cases: Array<[Parameters<typeof evaluateAutoMerge>[0], string]> = [
    [
      { pull: null, mergeable: null, checks: 'passed', failingChecks: [], licenseAllowed: true },
      'pull_missing',
    ],
    [
      { pull: open, mergeable: null, checks: 'passed', failingChecks: [], licenseAllowed: true },
      'mergeable_unknown',
    ],
    [
      { pull: open, mergeable: false, checks: 'passed', failingChecks: [], licenseAllowed: true },
      'merge_conflict',
    ],
    [
      { pull: open, mergeable: true, checks: 'pending', failingChecks: [], licenseAllowed: true },
      'checks_pending',
    ],
    [
      {
        pull: open,
        mergeable: true,
        checks: 'failed',
        failingChecks: ['CI'],
        licenseAllowed: true,
      },
      'checks_failed',
    ],
    [
      { pull: open, mergeable: true, checks: 'none', failingChecks: [], licenseAllowed: true },
      'checks_none',
    ],
    [
      { pull: open, mergeable: true, checks: 'passed', failingChecks: [], licenseAllowed: false },
      'license_not_publishable',
    ],
    [
      {
        pull: { ...open, state: 'closed' },
        mergeable: true,
        checks: 'passed',
        failingChecks: [],
        licenseAllowed: true,
      },
      'pull_not_open',
    ],
  ];
  for (const [input, reason] of cases) {
    const decision = evaluateAutoMerge(input, true);
    assert.equal(decision.allowed, false);
    assert.ok(decision.reasons.includes(reason), `missing ${reason}`);
  }

  const unconfirmed = evaluateAutoMerge(
    { pull: open, mergeable: true, checks: 'passed', failingChecks: [], licenseAllowed: true },
    false,
  );
  assert.ok(unconfirmed.reasons.includes('confirmation_required'));
});

test('状态机映射 PR → 检查 → 合并 → 部署 → 上线/失败', () => {
  const open = {
    number: 1,
    url: 'https://github.com/o/r/pull/1',
    state: 'open' as const,
    headSha: shaA,
  };
  const none = {
    pull: null,
    mergeable: null,
    checks: 'none' as const,
    failingChecks: [],
    licenseAllowed: true,
  };
  const staging = (pull: PullSummary | null, checks: 'pending' | 'passed' | 'failed' | 'none') => ({
    pull,
    mergeable: true,
    checks,
    failingChecks: checks === 'failed' ? ['CI'] : [],
    licenseAllowed: true,
  });

  assert.equal(mapPublishStage(none, { state: 'unknown' }), 'planned');
  assert.equal(mapPublishStage(staging(open, 'pending'), { state: 'unknown' }), 'checks_running');
  assert.equal(mapPublishStage(staging(open, 'failed'), { state: 'unknown' }), 'checks_failed');
  assert.equal(mapPublishStage(staging(open, 'passed'), { state: 'unknown' }), 'checks_passed');
  assert.equal(
    mapPublishStage({ ...staging(open, 'passed'), mergeable: false }, { state: 'unknown' }),
    'merge_conflict',
  );
  assert.equal(
    mapPublishStage(
      { ...staging(open, 'passed'), pull: { ...open, state: 'closed' } },
      { state: 'unknown' },
    ),
    'failed',
  );
  const mergedPull = { ...open, state: 'merged' as const };
  assert.equal(mapPublishStage(staging(mergedPull, 'passed'), { state: 'unknown' }), 'merged');
  assert.equal(mapPublishStage(staging(mergedPull, 'passed'), { state: 'running' }), 'deploying');
  assert.equal(mapPublishStage(staging(mergedPull, 'passed'), { state: 'success' }), 'deployed');
  assert.equal(
    mapPublishStage(staging(mergedPull, 'passed'), { state: 'failure' }),
    'deploy_failed',
  );
});

test('PR 标题/正文与正文提取', async () => {
  assert.equal(pullTitleForEntry(draft()), 'content: 更新 Demo Skill (demo-skill)');
  const body = pullBodyForEntry(draft(), publishValidation(draft()), {
    now: new Date('2026-10-14T12:00:00.000Z'),
  });
  assert.match(body, /content\/demo-skill|demo-skill/);
  assert.match(body, /anthropics\/skills/);
  assert.match(body, /不会触发生产部署/);
  assert.ok(!/token|password|secret/i.test(body));
  assert.equal(branchNameForSlug('demo-skill'), 'content/demo-skill');

  const extracted = extractBody('---\nname: Demo\n---\n\n## 正文');
  assert.match(extracted, /## 正文/);
});

test('来源缺失的新草稿允许发布原始内容，但不允许未知/限制许可', () => {
  const sourceLess = draft();
  sourceLess.kind = 'new';
  sourceLess.identity = { sourceAttribution: '原创' };
  assert.equal(publishValidation(sourceLess).ok, true);

  const unknown = draft();
  unknown.identity.licenseStatus = 'unknown';
  assert.equal(publishValidation(unknown).ok, false);
});
