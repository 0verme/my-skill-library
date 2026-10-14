import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const fixture = path.resolve(`src/content/skills/schema-compat-${process.pid}.md`);
const baseFrontmatter = `name: Schema compatibility fixture\ndescription: A test Skill without a copied prompt.\ncategory: Test\nstatus: unverified\nsourceRepo: example/skills\nsourcePath: skills/example\nsourceSha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nlicenseStatus: unknown\ncreatedAt: 2026-10-14\nupdatedAt: 2026-10-14\ngallery:\n  - type: image\n    src: https://example.org/example.png\n    alt: Example imported media\n    attribution: Example creator\n    sourceUrl: https://example.org/source`;

function runAstroCommand(script, ...args) {
  return spawnSync('npm', ['run', script, ...(args.length ? ['--', ...args] : [])], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 120_000,
  });
}

try {
  await writeFile(
    fixture,
    `---\ntype: skill\n${baseFrontmatter}\n---\n\nThis Skill intentionally has no prompt field.\n`,
    'utf8',
  );
  const skillResult = runAstroCommand('check');
  assert.equal(
    skillResult.status,
    0,
    `A Skill without a prompt must validate.\n${skillResult.stdout}\n${skillResult.stderr}`,
  );

  const buildDirectory = await mkdtemp(path.join(process.cwd(), '.astro', 'my-skill-schema-'));
  try {
    const buildResult = runAstroCommand('build', '--outDir', buildDirectory);
    assert.equal(
      buildResult.status,
      0,
      `A Skill without a prompt must build.\n${buildResult.stdout}\n${buildResult.stderr}`,
    );
    const detailPage = await readFile(
      path.join(buildDirectory, 'skills', `schema-compat-${process.pid}`, 'index.html'),
      'utf8',
    );
    assert.ok(
      !detailPage.includes('id="prompt-heading"'),
      'A Skill without prompt must not render an empty Prompt section.',
    );
    assert.ok(detailPage.includes('example/skills'), 'The source repository should be displayed.');
    assert.ok(detailPage.includes('skills/example'), 'The source path should be displayed.');
    assert.ok(detailPage.includes('许可未知'), 'The unknown license state should be displayed.');
    assert.ok(
      detailPage.includes('Example creator'),
      'Third-party media attribution should be displayed.',
    );
    assert.ok(
      detailPage.includes('https://example.org/source'),
      'Third-party media source should be linked.',
    );
  } finally {
    await rm(buildDirectory, { recursive: true, force: true });
  }

  await writeFile(
    fixture,
    `---\ntype: prompt\n${baseFrontmatter}\n---\n\nPrompt fixture missing its required prompt field.\n`,
    'utf8',
  );
  const promptResult = runAstroCommand('check');
  const diagnostics = `${promptResult.stdout}\n${promptResult.stderr}`;
  assert.notEqual(
    promptResult.status,
    0,
    'A Prompt without its required prompt must fail validation.',
  );
  assert.ok(
    diagnostics.includes('Prompt entries must include a non-empty prompt field.'),
    `The validation error should identify the missing Prompt field.\n${diagnostics}`,
  );

  console.log('Content schema compatibility passed: Skills may omit prompt; Prompts may not.');
} finally {
  await unlink(fixture).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}
