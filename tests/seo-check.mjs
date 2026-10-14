import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const siteOrigin = 'https://skill.overme.cn';
const outputRoot = path.resolve('dist');

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? collectFiles(entryPath) : [entryPath];
    }),
  );
  return files.flat();
}

const files = await collectFiles(outputRoot);
const htmlFiles = files.filter((file) => file.endsWith('.html'));
const sitemapFiles = files.filter((file) => /sitemap.*\.xml$/.test(file));
assert.ok(htmlFiles.length >= 2, 'Production build must include home and detail HTML pages.');
assert.ok(sitemapFiles.length > 0, 'Production build must include a sitemap.');

for (const file of htmlFiles) {
  const html = await readFile(file, 'utf8');
  const canonical = html.match(/<link rel="canonical" href="([^"]+)"/);
  const openGraphUrl = html.match(/<meta property="og:url" content="([^"]+)"/);
  const openGraphImage = html.match(/<meta property="og:image" content="([^"]+)"/);
  assert.ok(canonical, `${path.relative(outputRoot, file)} is missing canonical URL.`);
  assert.ok(openGraphUrl, `${path.relative(outputRoot, file)} is missing Open Graph URL.`);
  assert.ok(openGraphImage, `${path.relative(outputRoot, file)} is missing Open Graph image.`);
  assert.equal(
    new URL(canonical[1]).origin,
    siteOrigin,
    'Canonical must use the production domain.',
  );
  assert.equal(
    new URL(openGraphUrl[1]).origin,
    siteOrigin,
    'Open Graph URL must use the production domain.',
  );
  assert.equal(
    new URL(openGraphImage[1]).origin,
    siteOrigin,
    'Open Graph image must use the production domain.',
  );
  assert.ok(
    !html.includes('https://skills.overme.cn'),
    'Legacy plural domain must not appear in HTML.',
  );
}

const adminHtmlFiles = htmlFiles.filter((file) =>
  path.relative(outputRoot, file).startsWith(`admin${path.sep}`),
);
assert.equal(adminHtmlFiles.length, 2, 'Both protected admin pages must be statically generated.');
for (const file of adminHtmlFiles) {
  const html = await readFile(file, 'utf8');
  assert.match(html, /<meta name="robots" content="noindex, nofollow"/);
}

const robots = await readFile(path.join(outputRoot, 'robots.txt'), 'utf8');
assert.ok(robots.includes(`Sitemap: ${siteOrigin}/sitemap-index.xml`));
assert.ok(robots.includes('Disallow: /admin'));
assert.ok(robots.includes('Disallow: /api/admin'));
assert.ok(robots.includes('Disallow: /import-catalog.json'));
assert.ok(!robots.includes('skills.overme.cn'));

for (const file of sitemapFiles) {
  const sitemap = await readFile(file, 'utf8');
  assert.ok(
    sitemap.includes(siteOrigin),
    `${path.relative(outputRoot, file)} must use the production domain.`,
  );
  assert.ok(
    !sitemap.includes('skills.overme.cn'),
    'Sitemap must not contain the legacy plural domain.',
  );
  assert.ok(
    !sitemap.includes(`${siteOrigin}/admin`),
    'Admin routes must not be indexed in sitemap.',
  );
  assert.ok(
    !sitemap.includes(`${siteOrigin}/import-catalog.json`),
    'Internal source index must not be indexed.',
  );
}

console.log(
  `SEO checks passed: ${htmlFiles.length} HTML pages, ${sitemapFiles.length} sitemap files, robots.txt.`,
);
