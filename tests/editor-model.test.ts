import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addGalleryItem,
  applyUpstreamDecisions,
  buildUpstreamPlan,
  clearEditorOverride,
  computeSnapshotHash,
  containsCredentialLikeKeys,
  createDraftFromCandidate,
  createDraftFromPublished,
  editorFieldProvenance,
  EditorDraftError,
  moveGalleryItem,
  parseEditorDraft,
  removeGalleryItem,
  resetEditorDraft,
  serializeEditorDraft,
  sourceUrlForIdentity,
  updateEditorField,
  validateEditorDraft,
  type EditorCatalogEntry,
  type EditorDraft,
  type EditorFields,
  type EditorImportCandidate,
} from '../src/lib/admin/editor-model.ts';

const shaA = 'a'.repeat(40);
const shaB = 'b'.repeat(40);

const publishedFields: EditorFields = {
  name: '已发布名称',
  description: '已发布简介。',
  type: 'skill',
  category: '设计',
  tags: ['标签一'],
  supportedTools: ['ChatGPT'],
  prompt: '原始 Prompt',
  installCommand: 'npm install example',
  cover: '/skills/demo-skill/cover.svg',
  gallery: [
    {
      type: 'image',
      src: 'https://example.com/a.png',
      alt: '示例图',
      attribution: 'Example creator',
      sourceUrl: 'https://example.com/source',
    },
  ],
  featured: true,
  status: 'verified',
};

function publishedEntry(): EditorCatalogEntry {
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
    fields: publishedFields,
  };
}

function candidate(overrides: Partial<EditorImportCandidate> = {}): EditorImportCandidate {
  return {
    sourceRepo: 'anthropics/skills',
    sourcePath: 'skills/demo/SKILL.md',
    sourceSha: shaB,
    sourceAttribution: 'anthropics/skills',
    license: 'Apache-2.0',
    licenseStatus: 'redistributable',
    name: '上游新名称',
    description: '上游新简介。',
    suggestedSlug: 'demo-skill',
    ...overrides,
  };
}

test('草稿序列化往返，拒绝凭据字段与超大草稿', () => {
  const draft = createDraftFromPublished(publishedEntry());
  const edited = updateEditorField(draft, 'name', '我的名称');
  const roundTripped = parseEditorDraft(serializeEditorDraft(edited));
  assert.ok(roundTripped);
  assert.deepEqual(roundTripped.fields, edited.fields);
  assert.equal(roundTripped.slug, 'demo-skill');
  assert.deepEqual(roundTripped.overrides, { name: true });

  const withCredential = clone(edited) as unknown as Record<string, unknown>;
  (withCredential['identity'] as Record<string, unknown>)['access_token'] = 'not-allowed';
  assert.throws(
    () => serializeEditorDraft(withCredential as unknown as EditorDraft),
    (error: unknown) =>
      error instanceof EditorDraftError && error.code === 'credentials_not_allowed',
  );

  const oversized = clone(edited);
  oversized.fields.name = 'x'.repeat(600_000);
  assert.throws(
    () => serializeEditorDraft(oversized),
    (error: unknown) => error instanceof EditorDraftError && error.code === 'draft_too_large',
  );

  assert.equal(parseEditorDraft('{not json'), null);
  assert.equal(parseEditorDraft(JSON.stringify({ ...edited, schemaVersion: 99 })), null);
  const storedCredential = JSON.parse(JSON.stringify(edited)) as Record<string, unknown>;
  storedCredential.token = 'secret';
  assert.equal(parseEditorDraft(JSON.stringify(storedCredential)), null);

  assert.equal(containsCredentialLikeKeys({ attribution: 'Example creator' }), false);
  assert.equal(containsCredentialLikeKeys({ nested: { refresh_token: 'x' } }), true);
});

test('发布前校验覆盖内容 schema、媒体安全与许可门槛', () => {
  const draft = createDraftFromPublished(publishedEntry());
  assert.deepEqual(validateEditorDraft(draft), []);

  const missingName = clone(draft);
  missingName.fields.name = '   ';
  assert.ok(
    validateEditorDraft(missingName).some(
      (issue) => issue.code === 'name_required' && issue.severity === 'error',
    ),
  );

  const longDescription = clone(draft);
  longDescription.fields.description = 'x'.repeat(221);
  assert.ok(
    validateEditorDraft(longDescription).some((issue) => issue.code === 'description_too_long'),
  );

  const promptWithoutBody = clone(draft);
  promptWithoutBody.fields.type = 'prompt';
  promptWithoutBody.fields.prompt = '';
  assert.ok(
    validateEditorDraft(promptWithoutBody).some(
      (issue) => issue.code === 'prompt_required_for_prompt',
    ),
  );

  const unsafeCover = clone(draft);
  unsafeCover.fields.cover = 'javascript:alert(1)';
  assert.ok(validateEditorDraft(unsafeCover).some((issue) => issue.code === 'cover_unsafe'));

  const credentialCover = clone(draft);
  credentialCover.fields.cover = 'https://user:pass@example.com/cover.png';
  assert.ok(validateEditorDraft(credentialCover).some((issue) => issue.code === 'cover_unsafe'));

  const badGallery = clone(draft);
  badGallery.fields.gallery = [
    {
      type: 'video',
      src: 'https://example.com/v.mp4',
      alt: '视频',
      before: 'https://example.com/a.png',
    },
    { type: 'image', src: '', alt: '' },
  ];
  const galleryIssues = validateEditorDraft(badGallery);
  assert.ok(galleryIssues.some((issue) => issue.code === 'gallery_video_comparison_unsupported'));
  assert.ok(galleryIssues.some((issue) => issue.code === 'gallery_src_required'));
  assert.ok(galleryIssues.some((issue) => issue.code === 'gallery_alt_required'));

  const unpaired = clone(draft);
  unpaired.fields.gallery = [
    {
      type: 'image',
      src: 'https://example.com/a.png',
      alt: '示例',
      before: 'https://example.com/b.png',
    },
  ];
  assert.ok(
    validateEditorDraft(unpaired).some(
      (issue) => issue.code === 'gallery_comparison_pair_required',
    ),
  );

  const badSlug = clone(draft);
  badSlug.slug = 'Bad Slug';
  assert.ok(validateEditorDraft(badSlug).some((issue) => issue.code === 'slug_invalid'));

  const missingAttribution = clone(draft);
  missingAttribution.identity.sourceAttribution = '';
  assert.ok(
    validateEditorDraft(missingAttribution).some(
      (issue) => issue.code === 'source_attribution_required',
    ),
  );

  const unknownLicense = clone(draft);
  unknownLicense.identity.licenseStatus = 'unknown';
  assert.ok(
    !validateEditorDraft(unknownLicense).some((issue) => issue.code === 'license_not_publishable'),
  );
  assert.ok(
    validateEditorDraft(unknownLicense, { forPublish: true }).some(
      (issue) => issue.code === 'license_not_publishable' && issue.severity === 'error',
    ),
  );
});

test('手工 override 优先，上游冲突必须逐字段显式选择且绝不静默覆盖', () => {
  const draft = updateEditorField(createDraftFromPublished(publishedEntry()), 'name', '我的名称');
  assert.equal(editorFieldProvenance(draft, 'name'), 'manual');
  assert.equal(editorFieldProvenance(draft, 'description'), 'published');

  const plan = buildUpstreamPlan(draft, candidate());
  const nameField = plan.fields.find((field) => field.path === 'name');
  assert.ok(nameField);
  assert.equal(nameField.conflict, true);
  assert.equal(nameField.requiresDecision, true);
  assert.equal(nameField.manuallyOverridden, true);
  assert.equal(nameField.current, '我的名称');
  assert.equal(nameField.upstream, '上游新名称');
  assert.equal(nameField.base, '已发布名称');
  const descriptionField = plan.fields.find((field) => field.path === 'description');
  assert.ok(descriptionField);
  assert.equal(descriptionField.localChanged, false);
  assert.equal(descriptionField.upstreamChanged, true);
  assert.equal(descriptionField.requiresDecision, false);
  assert.equal(plan.requiresExplicitDecision, true);

  assert.throws(
    () => applyUpstreamDecisions(draft, plan, {}),
    (error: unknown) =>
      error instanceof EditorDraftError && error.code === 'unresolved_upstream_conflict',
  );

  const kept = applyUpstreamDecisions(draft, plan, { name: 'keep-local' });
  assert.equal(kept.fields.name, '我的名称');
  assert.equal(kept.overrides['name'], true);
  assert.equal(kept.baseline.name, '已发布名称');
  assert.equal(kept.fields.description, '上游新简介。');
  assert.equal(kept.overrides['description'], undefined);
  assert.equal(kept.baseline.description, '上游新简介。');
  assert.equal(kept.identity.sourceSha, shaB);
  assert.equal(kept.basedOnSourceSha, shaB);

  const taken = applyUpstreamDecisions(draft, plan, { name: 'take-upstream' });
  assert.equal(taken.fields.name, '上游新名称');
  assert.equal(taken.overrides['name'], undefined);
  assert.equal(taken.baseline.name, '上游新名称');
  assert.equal(taken.fields.description, '上游新简介。');
});

test('稳定 slug、repo+path 去重与来源 URL', () => {
  const matched = createDraftFromCandidate(
    candidate({ sourceRepo: 'Anthropics/Skills', suggestedSlug: 'different-slug' }),
    [publishedEntry()],
  );
  assert.ok(matched.matchedEntry);
  assert.equal(matched.draft.kind, 'update');
  assert.equal(matched.draft.slug, 'demo-skill');
  assert.equal(matched.draft.fields.name, '已发布名称');
  assert.equal(matched.draft.basedOnSourceSha, shaA);

  const unmatched = createDraftFromCandidate(
    candidate({ sourcePath: 'skills/other/SKILL.md', suggestedSlug: 'other-skill' }),
    [publishedEntry()],
  );
  assert.equal(unmatched.matchedEntry, undefined);
  assert.equal(unmatched.draft.kind, 'new');
  assert.equal(unmatched.draft.slug, 'other-skill');
  assert.equal(unmatched.draft.identity.sourceRepo, 'anthropics/skills');
  assert.equal(unmatched.draft.identity.sourcePath, 'skills/other/SKILL.md');
  assert.equal(editorFieldProvenance(unmatched.draft, 'name'), 'default');

  const secondEdit = updateEditorField(matched.draft, 'category', '新分类');
  const restored = parseEditorDraft(serializeEditorDraft(secondEdit));
  assert.equal(restored?.slug, 'demo-skill');
  assert.equal(restored?.kind, 'update');

  assert.equal(
    sourceUrlForIdentity(publishedEntry().identity),
    `https://github.com/anthropics/skills/blob/${shaA}/skills/demo/SKILL.md`,
  );
  assert.equal(sourceUrlForIdentity({ sourceRepo: 'no-slash' }), undefined);
});

test('快照哈希稳定且随字段变化', async () => {
  const draft = createDraftFromPublished(publishedEntry());
  const reordered: EditorFields = {
    status: draft.fields.status,
    featured: draft.fields.featured,
    gallery: draft.fields.gallery,
    ...(draft.fields.cover !== undefined ? { cover: draft.fields.cover } : {}),
    ...(draft.fields.installCommand !== undefined
      ? { installCommand: draft.fields.installCommand }
      : {}),
    ...(draft.fields.prompt !== undefined ? { prompt: draft.fields.prompt } : {}),
    supportedTools: draft.fields.supportedTools,
    tags: draft.fields.tags,
    category: draft.fields.category,
    type: draft.fields.type,
    description: draft.fields.description,
    name: draft.fields.name,
  };
  const hashA = await computeSnapshotHash(draft.fields);
  const hashB = await computeSnapshotHash(reordered);
  assert.equal(hashA, hashB);
  assert.match(hashA, /^[a-f0-9]{64}$/);

  const changed = clone(draft).fields;
  changed.name = '另一个名称';
  assert.notEqual(await computeSnapshotHash(changed), hashA);
});

test('重置恢复发布基线，画廊排序与清除覆盖可回退', () => {
  let draft = createDraftFromPublished(publishedEntry());
  draft = updateEditorField(draft, 'name', '我的名称');
  draft = addGalleryItem(draft, {
    type: 'image',
    src: 'https://example.com/b.png',
    alt: '第二张',
  });
  draft = moveGalleryItem(draft, 1, 0);
  assert.equal(draft.fields.gallery[0]?.alt, '第二张');
  assert.equal(editorFieldProvenance(draft, 'gallery'), 'manual');

  const cleared = clearEditorOverride(draft, 'gallery');
  assert.deepEqual(cleared.fields.gallery, publishedFields.gallery);

  const removed = removeGalleryItem(draft, 1);
  assert.equal(removed.fields.gallery.length, 1);
  assert.equal(editorFieldProvenance(removed, 'gallery'), 'manual');

  const reset = resetEditorDraft(draft);
  assert.deepEqual(reset.fields, publishedFields);
  assert.deepEqual(reset.overrides, {});
  assert.equal(reset.identity.sourceSha, shaA);
  assert.equal(editorFieldProvenance(reset, 'name'), 'published');
});

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
