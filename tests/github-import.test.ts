import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  discoverGitHubSkills,
  GITHUB_IMPORT_LIMITS,
  GitHubImportError,
  isSafeGitHubPath,
  parseGitHubSourceUrl,
  parseSkillMarkdown,
  type ExistingImportEntry,
} from '../src/lib/admin/github-import.ts';

const commit = 'a'.repeat(40);
const okBlob = 'b'.repeat(40);
const unknownBlob = 'c'.repeat(40);
const licenseBlob = 'd'.repeat(40);
const restrictedBlob = 'e'.repeat(40);
const maliciousBlob = 'f'.repeat(40);
const docxBlob = '2'.repeat(40);
const hash = (value: string) => createHash('sha1').update(value).digest('hex');

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/vnd.github+json; charset=utf-8', ...headers },
  });
}

function blobResponse(value: string) {
  return jsonResponse({
    encoding: 'base64',
    size: Buffer.byteLength(value),
    content: Buffer.from(value, 'utf8').toString('base64'),
  });
}

function skill(
  name = 'Example Skill',
  description = 'A safe test Skill.',
  body = 'Safe preview text.',
) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
}

function treeEntry(path: string, sha: string, size = 300, mode = '100644') {
  return { path, mode, type: 'blob', sha, size };
}

interface FixtureOptions {
  sourceRepo?: string;
  branch?: string;
  tree?: Array<Record<string, unknown>>;
  blobs?: Record<string, string>;
  defaultBranch?: string;
  rateLimit?: boolean;
  timeout?: boolean;
  truncated?: boolean;
}

function createGitHubFixture(options: FixtureOptions = {}) {
  const sourceRepo = options.sourceRepo ?? 'example/skills';
  const branch = options.branch ?? 'main';
  const repoSha = hash('a');
  const requests: string[] = [];
  const skillBodyReads: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    if (options.timeout) throw new DOMException('fixture timeout', 'AbortError');
    if (options.rateLimit && url.includes('/git/trees/')) {
      return new Response('rate limited', { status: 429, headers: { 'Retry-After': '17' } });
    }
    const base = `https://api.github.com/repos/${sourceRepo}`;
    if (url === base) return jsonResponse({ default_branch: options.defaultBranch ?? branch });
    const commitMatch = url.match(/\/commits\/([^/?]+)$/);
    if (commitMatch) {
      const ref = decodeURIComponent(commitMatch[1]!);
      return ref === branch
        ? jsonResponse({ sha: repoSha })
        : jsonResponse({ message: 'not found' }, 404);
    }
    if (url === `${base}/git/trees/${repoSha}?recursive=1`) {
      return jsonResponse({ tree: options.tree ?? [], truncated: options.truncated ?? false });
    }
    const blobMatch = url.match(/\/git\/blobs\/([a-f0-9]{40,64})$/i);
    if (blobMatch) {
      const sha = blobMatch[1]!;
      if (options.blobs?.[sha] !== undefined) {
        if (sha === okBlob || sha === unknownBlob || sha === maliciousBlob || sha === docxBlob) {
          skillBodyReads.push(sha);
        }
        return blobResponse(options.blobs[sha]!);
      }
      return jsonResponse({ message: 'not found' }, 404);
    }
    return jsonResponse({ message: 'not found' }, 404);
  };
  return { fetcher, requests, skillBodyReads, commit: repoSha };
}

function singleSkillFixture(body = skill(), license = 'SPDX-License-Identifier: Apache-2.0') {
  return createGitHubFixture({
    tree: [
      { path: 'skills', mode: '040000', type: 'tree', sha: hash('3') },
      { path: 'skills/demo', mode: '040000', type: 'tree', sha: hash('4') },
      treeEntry('skills/demo/LICENSE', licenseBlob, Buffer.byteLength(license)),
      treeEntry('skills/demo/SKILL.md', okBlob, Buffer.byteLength(body)),
    ],
    blobs: { [licenseBlob]: license, [okBlob]: body },
  });
}

async function expectImportError(operation: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof GitHubImportError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

test('URL 解析支持仓库、含斜杠 ref 的目录和 SKILL.md 文件链接', () => {
  assert.deepEqual(parseGitHubSourceUrl('https://github.com/acme/skills'), {
    owner: 'acme',
    repository: 'skills',
    sourceRepo: 'acme/skills',
    mode: 'repository',
    tail: [],
    requestedUrl: 'https://github.com/acme/skills',
  });
  const tree = parseGitHubSourceUrl(
    'https://github.com/acme/skills/tree/feature/new-ui/skills/demo',
  );
  assert.equal(tree.mode, 'tree');
  assert.deepEqual(tree.tail, ['feature', 'new-ui', 'skills', 'demo']);
  const file = parseGitHubSourceUrl(
    'https://github.com/acme/skills/blob/main/skills/demo/SKILL.md',
  );
  assert.equal(file.mode, 'blob');
  assert.deepEqual(file.tail, ['main', 'skills', 'demo', 'SKILL.md']);
});

test('URL 和仓库路径拒绝非 GitHub、非 HTTPS、userinfo、查询、编码穿越与双重编码', () => {
  for (const url of [
    'http://github.com/acme/skills',
    'https://github.com.evil.example/acme/skills',
    'https://user@github.com/acme/skills',
    'https://github.com/acme/skills?ref=main',
    'https://github.com/acme/skills/tree/main/%2e%2e/private',
    'https://github.com/acme/skills/tree/main/skills%2Fdemo',
    'https://github.com/acme/skills/tree/main/%252e%252e/private',
    'https://github.com/acme/skills/blob/main/README.md',
  ]) {
    assert.throws(() => parseGitHubSourceUrl(url), GitHubImportError, url);
  }
  assert.equal(isSafeGitHubPath('skills/demo/SKILL.md'), true);
  assert.equal(isSafeGitHubPath('../private/SKILL.md'), false);
  assert.equal(isSafeGitHubPath('skills/%2e%2e/private/SKILL.md'), false);
  assert.equal(isSafeGitHubPath('skills%2Fprivate/SKILL.md'), false);
});

test('安全解析 frontmatter；拒绝缺失、重复键、别名、类型错误和危险 prototype key', () => {
  assert.deepEqual(parseSkillMarkdown(skill()), {
    name: 'Example Skill',
    description: 'A safe test Skill.',
    body: 'Safe preview text.',
  });
  for (const markdown of [
    '# No frontmatter',
    '---\nname: x\nname: y\ndescription: desc\n---\nbody',
    '---\nbase: &x { name: x }\ncopy: *x\nname: x\ndescription: d\n---\nbody',
    '---\nname: [not, a, string]\ndescription: d\n---\nbody',
    '---\n__proto__: { polluted: true }\nname: x\ndescription: d\n---\nbody',
  ]) {
    assert.throws(() => parseSkillMarkdown(markdown), GitHubImportError, markdown);
  }
});

test('仓库 URL 自动发现有效 Skill，固定 Commit 并返回归属和许可证', async () => {
  const fixture = singleSkillFixture();
  const preview = await discoverGitHubSkills('https://github.com/example/skills', {
    fetcher: fixture.fetcher,
  });
  assert.equal(preview.sourceRepo, 'example/skills');
  assert.equal(preview.sourceSha, fixture.commit);
  assert.equal(preview.candidates.length, 1);
  assert.deepEqual(
    {
      sourcePath: preview.candidates[0]!.sourcePath,
      sourceUrl: preview.candidates[0]!.sourceUrl,
      sourceRepo: preview.candidates[0]!.sourceRepo,
      sourceSha: preview.candidates[0]!.sourceSha,
      license: preview.candidates[0]!.license,
      licenseStatus: preview.candidates[0]!.licenseStatus,
      sourceStatus: preview.candidates[0]!.sourceStatus,
      sourceAttribution: preview.candidates[0]!.sourceAttribution,
      mode: preview.candidates[0]!.mode,
      markdownPreview: preview.candidates[0]!.markdownPreview,
    },
    {
      sourcePath: 'skills/demo/SKILL.md',
      sourceUrl: `https://github.com/example/skills/blob/${fixture.commit}/skills/demo/SKILL.md`,
      sourceRepo: 'example/skills',
      sourceSha: fixture.commit,
      license: 'Apache-2.0',
      licenseStatus: 'redistributable',
      sourceStatus: 'unverified',
      sourceAttribution: 'example/skills',
      mode: 'content-preview',
      markdownPreview: 'Safe preview text.',
    },
  );
});

test('tree 目录和 blob/SKILL.md 只预览所指目录或单个文件', async () => {
  const fixture = singleSkillFixture();
  const directory = await discoverGitHubSkills(
    'https://github.com/example/skills/tree/main/skills/demo',
    { fetcher: fixture.fetcher },
  );
  assert.equal(directory.candidates.length, 1);
  assert.equal(directory.candidates[0]!.sourcePath, 'skills/demo/SKILL.md');

  const file = await discoverGitHubSkills(
    'https://github.com/example/skills/blob/main/skills/demo/SKILL.md',
    { fetcher: fixture.fetcher },
  );
  assert.equal(file.candidates.length, 1);
  assert.equal(file.candidates[0]!.sourcePath, 'skills/demo/SKILL.md');
});

test('branch/ref 中含斜杠时按 API 实际存在的完整 ref 解析', async () => {
  const fixture = createGitHubFixture({
    branch: 'feature/new-ui',
    tree: [
      { path: 'skills', mode: '040000', type: 'tree', sha: hash('3') },
      { path: 'skills/demo', mode: '040000', type: 'tree', sha: hash('4') },
      treeEntry('skills/demo/LICENSE', licenseBlob),
      treeEntry('skills/demo/SKILL.md', okBlob),
    ],
    blobs: {
      [licenseBlob]: 'SPDX-License-Identifier: MIT',
      [okBlob]: skill(),
    },
  });
  const preview = await discoverGitHubSkills(
    'https://github.com/example/skills/tree/feature/new-ui/skills/demo',
    { fetcher: fixture.fetcher },
  );
  assert.equal(preview.resolvedRef, 'feature/new-ui');
  assert.equal(preview.candidates.length, 1);
});

test('无 SKILL.md、tree 截断和 invalid frontmatter 均清晰报告', async () => {
  const empty = createGitHubFixture({
    tree: [{ path: 'README.md', mode: '100644', type: 'blob', sha: hash('4') }],
  });
  await expectImportError(
    discoverGitHubSkills('https://github.com/example/skills', { fetcher: empty.fetcher }),
    'no_skill_files',
    422,
  );

  const truncated = createGitHubFixture({ truncated: true, tree: [treeEntry('SKILL.md', okBlob)] });
  const truncatedPreview = await discoverGitHubSkills('https://github.com/example/skills', {
    fetcher: truncated.fetcher,
  });
  assert.equal(truncatedPreview.candidates.length, 1);
  assert.equal(truncatedPreview.partial, true);
  assert.ok(truncatedPreview.warnings.includes('upstream_tree_truncated'));

  const invalid = singleSkillFixture('---\nname: [bad\ndescription: missing close\n---\nbody');
  const invalidPreview = await discoverGitHubSkills('https://github.com/example/skills', {
    fetcher: invalid.fetcher,
  });
  assert.equal(invalidPreview.candidates.length, 0);
  assert.equal(invalidPreview.partial, true);
  assert.equal(invalidPreview.errors[0]?.code, 'invalid_frontmatter');
});

test('unknown/restricted 许可仅提供 metadata，不读取或返回上游 SKILL 正文', async () => {
  const unknown = createGitHubFixture({
    tree: [treeEntry('skills/unknown/SKILL.md', unknownBlob)],
    blobs: { [unknownBlob]: skill('Secret Source Title', 'Do not copy this description.') },
  });
  const unknownPreview = await discoverGitHubSkills('https://github.com/example/skills', {
    fetcher: unknown.fetcher,
  });
  const unknownCandidate = unknownPreview.candidates[0]!;
  assert.equal(unknownCandidate.licenseStatus, 'unknown');
  assert.equal(unknownCandidate.mode, 'metadata-only');
  assert.equal(unknownCandidate.description, null);
  assert.equal(unknownCandidate.name, 'unknown');
  assert.equal(unknownCandidate.markdownPreview, undefined);
  assert.deepEqual(unknown.skillBodyReads, []);
  assert.ok(!JSON.stringify(unknownPreview).includes('Do not copy this description.'));

  const compositeLicense = createGitHubFixture({
    tree: [
      treeEntry('skills/composite/LICENSE', licenseBlob),
      treeEntry('skills/composite/SKILL.md', unknownBlob),
    ],
    blobs: {
      [licenseBlob]: 'SPDX-License-Identifier: MIT AND GPL-3.0-only',
      [unknownBlob]: skill('composite', 'A compound SPDX expression is not auto-approved.'),
    },
  });
  const compositePreview = await discoverGitHubSkills('https://github.com/example/skills', {
    fetcher: compositeLicense.fetcher,
  });
  assert.equal(compositePreview.candidates[0]?.licenseStatus, 'unknown');
  assert.equal(compositePreview.candidates[0]?.mode, 'metadata-only');
  assert.deepEqual(compositeLicense.skillBodyReads, []);

  const restricted = createGitHubFixture({
    sourceRepo: 'anthropics/skills',
    tree: [
      treeEntry('skills/docx/SKILL.md', docxBlob),
      treeEntry('skills/docx/LICENSE.txt', restrictedBlob),
    ],
    blobs: {
      [docxBlob]: skill('docx', 'Proprietary source description.'),
      [restrictedBlob]: 'All Rights Reserved. Proprietary. No permission to redistribute.',
    },
  });
  const restrictedPreview = await discoverGitHubSkills(
    'https://github.com/anthropics/skills/tree/main/skills/docx',
    {
      fetcher: restricted.fetcher,
    },
  );
  const docx = restrictedPreview.candidates[0]!;
  assert.equal(docx.licenseStatus, 'restricted');
  assert.equal(docx.mode, 'metadata-only');
  assert.equal(docx.description, null);
  assert.deepEqual(restricted.skillBodyReads, []);
  assert.ok(!JSON.stringify(restrictedPreview).includes('Proprietary source description.'));

  const oversizedLicenseSha = hash('oversized-license');
  const oversizedSkillSha = hash('oversized-skill');
  const oversizedLicense = createGitHubFixture({
    tree: [
      treeEntry(
        'skills/oversized/LICENSE',
        oversizedLicenseSha,
        GITHUB_IMPORT_LIMITS.maxLicenseBytes + 1,
      ),
      treeEntry('skills/oversized/SKILL.md', oversizedSkillSha),
    ],
    blobs: {
      [oversizedLicenseSha]: 'SPDX-License-Identifier: Apache-2.0',
      [oversizedSkillSha]: skill('oversized', 'Do not read while license is over budget.'),
    },
  });
  const oversizedPreview = await discoverGitHubSkills('https://github.com/example/skills', {
    fetcher: oversizedLicense.fetcher,
  });
  const oversizedCandidate = oversizedPreview.candidates[0]!;
  assert.equal(oversizedCandidate.licenseStatus, 'unknown');
  assert.equal(oversizedCandidate.mode, 'metadata-only');
  assert.ok(oversizedCandidate.markdownWarnings.includes('license_file_too_large'));
  assert.ok(
    !oversizedLicense.requests.includes(
      `https://api.github.com/repos/example/skills/git/blobs/${oversizedLicenseSha}`,
    ),
  );
  assert.ok(
    !oversizedLicense.requests.includes(
      `https://api.github.com/repos/example/skills/git/blobs/${oversizedSkillSha}`,
    ),
  );
});

test('单个许可文件读取失败返回部分错误，不丢弃其他可安全预览项目', async () => {
  const missingLicense = hash('missing-license');
  const availableLicense = hash('available-license');
  const unavailableSkill = hash('unavailable-skill');
  const availableSkill = hash('available-skill');
  const fixture = createGitHubFixture({
    tree: [
      treeEntry('skills/partial/LICENSE', missingLicense),
      treeEntry('skills/partial/SKILL.md', unavailableSkill),
      treeEntry('skills/valid/LICENSE', availableLicense),
      treeEntry('skills/valid/SKILL.md', availableSkill),
    ],
    blobs: {
      [unavailableSkill]: skill('partial', 'A candidate whose license read fails.'),
      [availableLicense]: 'SPDX-License-Identifier: Apache-2.0',
      [availableSkill]: skill('valid', 'A safe candidate returned alongside partial errors.'),
    },
  });
  const preview = await discoverGitHubSkills('https://github.com/example/skills', {
    fetcher: fixture.fetcher,
  });
  assert.equal(preview.partial, true);
  assert.deepEqual(
    preview.candidates.map((candidate) => candidate.name),
    ['valid'],
  );
  assert.deepEqual(preview.errors, [
    { code: 'invalid_github_response', path: 'skills/partial/LICENSE' },
  ]);
});

test('Anthropic 首批四个 Skill fixture：Apache 项可预览，docx 限制复制', async () => {
  const skills = ['frontend-design', 'skill-creator', 'webapp-testing', 'docx'];
  const tree: Array<Record<string, unknown>> = [];
  const blobs: Record<string, string> = {};
  const fileShaBySkill: Record<string, string> = {};
  skills.forEach((name, index) => {
    const licenseSha = hash(String(index + 10));
    const skillSha = hash(String(index + 20));
    const directory = `skills/${name}`;
    tree.push(
      { path: 'skills', mode: '040000', type: 'tree', sha: hash('8') },
      { path: directory, mode: '040000', type: 'tree', sha: hash(String(index + 9)) },
      treeEntry(`${directory}/LICENSE.txt`, licenseSha),
      treeEntry(`${directory}/SKILL.md`, skillSha),
    );
    blobs[licenseSha] =
      name === 'docx'
        ? 'All Rights Reserved. Proprietary. No permission to redistribute.'
        : 'SPDX-License-Identifier: Apache-2.0';
    blobs[skillSha] = skill(
      name,
      `Fixture for ${name}.`,
      `Only a non-executed preview for ${name}.`,
    );
    fileShaBySkill[name] = skillSha;
  });
  const fixture = createGitHubFixture({ sourceRepo: 'anthropics/skills', tree, blobs });
  const preview = await discoverGitHubSkills(
    'https://github.com/anthropics/skills/tree/main/skills',
    {
      fetcher: fixture.fetcher,
    },
  );
  const byPath = new Map(preview.candidates.map((candidate) => [candidate.sourcePath, candidate]));
  for (const name of ['frontend-design', 'skill-creator', 'webapp-testing']) {
    const candidate = byPath.get(`skills/${name}/SKILL.md`);
    assert.ok(
      candidate,
      `Missing ${name}; received ${JSON.stringify({ paths: [...byPath.keys()], errors: preview.errors })}`,
    );
    assert.equal(candidate?.license, 'Apache-2.0');
    assert.equal(candidate?.licenseStatus, 'redistributable');
    assert.equal(candidate?.mode, 'content-preview');
    assert.equal(candidate?.sourceStatus, 'unverified');
  }
  const docx = byPath.get('skills/docx/SKILL.md');
  assert.equal(docx?.licenseStatus, 'restricted');
  assert.equal(docx?.mode, 'metadata-only');
  assert.ok(!fixture.skillBodyReads.includes(fileShaBySkill.docx!));
});

test('重复來源按 repo+path 幂等提示，更新要求确认且保留本地修改，slug 冲突不覆盖', async () => {
  const fixture = singleSkillFixture();
  const base = { slug: 'demo', sourceRepo: 'EXAMPLE/skills', sourcePath: 'skills/demo/SKILL.md' };
  const same: ExistingImportEntry[] = [{ ...base, sourceSha: fixture.commit }];
  const samePreview = await discoverGitHubSkills('https://github.com/example/skills', {
    fetcher: fixture.fetcher,
    catalog: same,
  });
  assert.equal(samePreview.candidates[0]!.state, 'already-imported');
  assert.equal(samePreview.candidates[0]!.selectable, false);

  const updatedPreview = await discoverGitHubSkills('https://github.com/example/skills', {
    fetcher: fixture.fetcher,
    catalog: [{ ...base, sourceSha: hash('9'), importedSnapshotHash: hash('8') }],
  });
  assert.equal(updatedPreview.candidates[0]!.state, 'update-available');
  assert.equal(updatedPreview.candidates[0]!.updateRequiresConfirmation, true);
  assert.equal(updatedPreview.candidates[0]!.preserveLocalChanges, true);
  assert.equal(updatedPreview.candidates[0]!.existingSlug, 'demo');

  const collisionPreview = await discoverGitHubSkills('https://github.com/example/skills', {
    fetcher: fixture.fetcher,
    catalog: [
      {
        slug: 'demo',
        sourceRepo: 'someone/else',
        sourcePath: 'skills/other/SKILL.md',
        sourceSha: hash('7'),
      },
    ],
  });
  assert.equal(collisionPreview.candidates[0]!.state, 'slug-conflict');
  assert.equal(collisionPreview.candidates[0]!.selectable, false);
});

test('危险 Markdown 链接与 HTML 被识别并阻止正文预览；HTTP 与外部媒体明确警告', async () => {
  const malicious = singleSkillFixture(
    skill('Malicious Link', 'A test.', '[run](javascript:alert(1))\n\n<script>alert(2)</script>'),
  );
  const maliciousPreview = await discoverGitHubSkills('https://github.com/example/skills', {
    fetcher: malicious.fetcher,
  });
  assert.deepEqual(maliciousPreview.candidates[0]!.markdownPreview, undefined);
  assert.ok(maliciousPreview.candidates[0]!.markdownWarnings.includes('unsafe_markdown_link'));
  assert.ok(maliciousPreview.candidates[0]!.markdownWarnings.includes('raw_html_not_rendered'));

  const httpAndImage = singleSkillFixture(
    skill(
      'Media',
      'A test.',
      '[old link](http://example.com/image.png)\n\n![photo](https://example.com/photo.png)',
    ),
  );
  const mediaPreview = await discoverGitHubSkills('https://github.com/example/skills', {
    fetcher: httpAndImage.fetcher,
  });
  assert.ok(mediaPreview.candidates[0]!.markdownWarnings.includes('http_link_requires_review'));
  assert.ok(mediaPreview.candidates[0]!.markdownWarnings.includes('external_media_not_copied'));
  assert.ok(mediaPreview.candidates[0]!.markdownPreview?.includes('https://example.com/photo.png'));

  const largeAst = singleSkillFixture(skill('Large AST', 'A test.', '- item\n'.repeat(4_000)));
  const largeAstPreview = await discoverGitHubSkills('https://github.com/example/skills', {
    fetcher: largeAst.fetcher,
  });
  assert.equal(largeAstPreview.candidates[0]!.markdownPreview, undefined);
  assert.ok(
    largeAstPreview.candidates[0]!.markdownWarnings.includes('markdown_node_limit_reached'),
  );
});

test('symlink、路径深度和项目数限制显式拒绝或报告部分结果', async () => {
  const entries = [
    treeEntry('skills/link/SKILL.md', okBlob, 100, '120000'),
    treeEntry(
      `${Array.from({ length: 25 }, (_, index) => `d${index}`).join('/')}/SKILL.md`,
      okBlob,
    ),
    ...Array.from({ length: 26 }, (_, index) => treeEntry(`skills/item-${index}/SKILL.md`, okBlob)),
  ];
  const fixture = createGitHubFixture({
    tree: entries,
    blobs: { [okBlob]: skill(), [licenseBlob]: 'SPDX-License-Identifier: MIT' },
  });
  const preview = await discoverGitHubSkills('https://github.com/example/skills', {
    fetcher: fixture.fetcher,
  });
  assert.equal(preview.candidates.length, 24);
  assert.equal(preview.partial, true);
  assert.ok(preview.warnings.includes('discovery_item_limit_reached'));
  assert.ok(preview.errors.some((item) => item.code === 'symlink_or_submodule_not_imported'));
  assert.ok(preview.warnings.includes('discovery_depth_limit_reached'));

  for (const sourceUrl of [
    'https://github.com/example/skills/tree/main/skills/link',
    'https://github.com/example/skills/blob/main/skills/link/SKILL.md',
  ]) {
    const explicitPreview = await discoverGitHubSkills(sourceUrl, { fetcher: fixture.fetcher });
    assert.equal(explicitPreview.partial, true);
    assert.ok(
      explicitPreview.errors.some((item) => item.code === 'symlink_or_submodule_not_imported'),
    );
  }
});

test('GitHub 429 传递 Retry-After；请求超时明确转为 504', async () => {
  const rateLimit = createGitHubFixture({ rateLimit: true });
  await assert.rejects(
    discoverGitHubSkills('https://github.com/example/skills', { fetcher: rateLimit.fetcher }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubImportError);
      assert.equal(error.status, 429);
      assert.equal(error.code, 'github_rate_limited');
      assert.equal(error.retryAfter, 17);
      return true;
    },
  );

  const timeout = createGitHubFixture({ timeout: true });
  await expectImportError(
    discoverGitHubSkills('https://github.com/example/skills', { fetcher: timeout.fetcher }),
    'github_timeout',
    504,
  );
});

test('API 响应字节上限阻止超大 Git tree', async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://api.github.com/repos/example/skills')
      return jsonResponse({ default_branch: 'main' });
    if (url.endsWith('/commits/main')) return jsonResponse({ sha: commit });
    if (url.endsWith(`/git/trees/${commit}?recursive=1`)) {
      return new Response(JSON.stringify({ tree: [], truncated: false }), {
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(3 * 1024 * 1024),
        },
      });
    }
    return jsonResponse({ message: 'not found' }, 404);
  };
  await expectImportError(
    discoverGitHubSkills('https://github.com/example/skills', { fetcher }),
    'response_too_large',
    413,
  );
});
