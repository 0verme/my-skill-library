import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const entries = [
  { slug: 'photo-anime', title: '照片动漫化' },
  { slug: 'paper-diorama', title: 'Paper Diorama 纸艺微缩' },
  { slug: 'product-film', title: '产品宣传片' },
  { slug: 'ui-design-assistant', title: 'UI 设计辅助' },
];

test('首页展示四个可访问的演示条目，并能逐个打开详情', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/My Skill Library/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('好用的 AI Skills');
  await expect(page.locator('[data-card]')).toHaveCount(4);

  for (const entry of entries) {
    const card = page.locator(`a[data-card][href="/skills/${entry.slug}"]`);
    await expect(card).toBeVisible();
    await expect(card.getByRole('heading', { level: 3 })).toHaveText(entry.title);
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/skills/${entry.slug}$`));
    await expect(page.getByRole('heading', { level: 1, name: entry.title })).toBeVisible();
    await expect(page.getByRole('heading', { name: '完整 Prompt' })).toBeVisible();
    await page.goto('/');
  }

  await page.setViewportSize({ width: 1280, height: 3000 });
  const screenshotHeight = await page.evaluate(() => {
    const footer = document.querySelector('.site-footer')!;
    return Math.ceil(footer.getBoundingClientRect().bottom + window.scrollY);
  });
  await page.screenshot({
    path: 'test-results/homepage.png',
    clip: { x: 0, y: 0, width: 1280, height: screenshotHeight },
  });
});

test('搜索、分类筛选和无结果状态可用', async ({ page }) => {
  await page.goto('/');
  const visibleCards = page.locator('[data-card]:visible');
  const search = page.getByRole('searchbox', { name: '搜索作品、分类或标签' });

  await search.fill('paper diorama');
  await expect(visibleCards).toHaveCount(1);
  await expect(page.locator('[data-card]:visible h3')).toHaveText('Paper Diorama 纸艺微缩');

  await page.getByRole('button', { name: '清除搜索' }).click();
  await expect(visibleCards).toHaveCount(4);
  const categoryButton = page.getByRole('button', { name: '品牌影像' });
  await categoryButton.click();
  await expect(categoryButton).toHaveAttribute('aria-pressed', 'true');
  await expect(visibleCards).toHaveCount(1);
  await expect(page.locator('[data-card]:visible h3')).toHaveText('产品宣传片');

  await search.fill('肯定不存在的关键词 xyz-404');
  await expect(visibleCards).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '没有找到匹配的作品' })).toBeVisible();
});

test('详情页包含正式域名 SEO 信息，Prompt 可以复制', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'http://127.0.0.1:4321',
  });
  await page.goto('/skills/paper-diorama');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Paper Diorama 纸艺微缩' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: '使用说明' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '作品画廊' })).toBeVisible();
  await expect(page.locator('.media-attribution').first()).toHaveText('项目原创 SVG 示意图');
  await expect(page.getByText('原创内容声明')).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    'https://skill.overme.cn/skills/paper-diorama',
  );
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    'content',
    'Paper Diorama 纸艺微缩 — My Skill Library',
  );
  await expect(page.getByRole('heading', { name: '安装命令' })).toHaveCount(0);

  const prompt = await page
    .locator('#prompt-code')
    .evaluate((element) => element.textContent ?? '');
  await page.getByRole('button', { name: '复制完整 Prompt' }).click();
  await expect(page.locator('[data-copy-status]')).toHaveText('已复制到剪贴板');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(prompt);
});

test('缺失媒体资源会显示优雅降级占位', async ({ page }) => {
  await page.route('**/skills/paper-diorama/cover.svg', (route) =>
    route.fulfill({ status: 404, body: '' }),
  );
  await page.goto('/skills/paper-diorama');
  const image = page.locator('[data-media-frame] img[data-fallback-image]').first();
  await expect(image).toBeHidden();
  await expect(page.locator('[data-image-fallback]').first()).toBeVisible();
});

test('移动端布局不产生横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('searchbox', { name: '搜索作品、分类或标签' })).toBeVisible();
  await expect(page.locator('[data-card]')).toHaveCount(4);
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
    columns: getComputedStyle(document.querySelector('.skill-grid')!).gridTemplateColumns,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.columns.trim().split(/\s+/)).toHaveLength(1);

  await page.setViewportSize({ width: 390, height: 3500 });
  const screenshotHeight = await page.evaluate(() => {
    const footer = document.querySelector('.site-footer')!;
    return Math.ceil(footer.getBoundingClientRect().bottom + window.scrollY);
  });
  await page.screenshot({
    path: 'test-results/mobile.png',
    clip: { x: 0, y: 0, width: 390, height: screenshotHeight },
  });
});

test('首页和详情页通过自动化无障碍审计', async ({ page }) => {
  for (const path of ['/', '/skills/paper-diorama']) {
    await page.goto(path);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, `${path}: ${JSON.stringify(results.violations, null, 2)}`).toEqual(
      [],
    );
  }
});

test('后台页面与管理 API 在 Access 尚未配置时由 Worker fail closed', async ({ request }) => {
  for (const path of [
    '/admin',
    '/admin/import',
    '/admin%2Fimport',
    '/api/admin/session',
    '/api/admin/import',
    '/api/admin/import/preview',
    '/api/admin/editor/catalog',
    '/api/admin/publish',
    '/api/admin/publish/status',
    '/api/admin/publish/merge',
    '/api/admin%2Fsession',
  ]) {
    const response = await request.get(path);
    expect(response.status(), `${path} should reject requests without Access configuration.`).toBe(
      503,
    );
    await expect(response.json()).resolves.toEqual({ error: 'access_not_configured' });
  }
});

test('导入预览 UI 默认不全选，以纯文本显示不可信 API 内容且仅做本地选择', async ({ page }) => {
  const html = await readFile(new URL('../dist/admin/import/index.html', import.meta.url), 'utf8');
  await page.route('**/admin/import', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: html }),
  );
  await page.route('**/api/admin/import/preview', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(route.request().headers()['content-type']).toContain('application/json');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sourceRepo: 'anthropics/skills',
        resolvedRef: 'main',
        sourceSha: 'a'.repeat(40),
        partial: false,
        warnings: [],
        errors: [],
        candidates: [
          {
            sourceRepo: 'anthropics/skills',
            sourcePath: 'skills/frontend-design/SKILL.md',
            sourceUrl: `https://github.com/anthropics/skills/blob/${'a'.repeat(40)}/skills/frontend-design/SKILL.md`,
            sourceSha: 'a'.repeat(40),
            sourceAttribution: 'anthropics/skills',
            license: 'Apache-2.0',
            licenseStatus: 'redistributable',
            sourceStatus: 'unverified',
            name: 'Frontend <img src=x onerror=alert(1)>',
            description: '<script>not executable</script>',
            suggestedSlug: 'frontend-design',
            mode: 'content-preview',
            markdownPreview: '[inert](javascript:alert(1))',
            markdownWarnings: ['unsafe_markdown_link'],
            state: 'new',
            updateRequiresConfirmation: false,
            preserveLocalChanges: false,
            selectable: true,
          },
          {
            sourceRepo: 'anthropics/skills',
            sourcePath: 'skills/docx/SKILL.md',
            sourceUrl: `https://github.com/anthropics/skills/blob/${'a'.repeat(40)}/skills/docx/SKILL.md`,
            sourceSha: 'a'.repeat(40),
            sourceAttribution: 'anthropics/skills',
            license: 'Proprietary skill-specific terms',
            licenseStatus: 'restricted',
            sourceStatus: 'unverified',
            name: 'docx',
            description: null,
            suggestedSlug: 'docx',
            mode: 'metadata-only',
            markdownWarnings: [],
            state: 'new',
            updateRequiresConfirmation: false,
            preserveLocalChanges: false,
            selectable: true,
          },
        ],
      }),
    });
  });

  await page.goto('/admin/import');
  await page.getByLabel('GitHub URL').fill('https://github.com/anthropics/skills');
  await page.getByRole('button', { name: '解析来源' }).click();
  await expect(page.locator('.import-candidate')).toHaveCount(2);
  await expect(page.locator('.import-candidate input[type="checkbox"]:checked')).toHaveCount(0);
  await expect(page.locator('[data-selection-summary]')).toContainText('已选择 0 项');
  await expect(page.locator('.import-candidate img, .import-candidate script')).toHaveCount(0);
  await expect(page.locator('.candidate-description')).toHaveText(
    '<script>not executable</script>',
  );
  await expect(page.locator('.markdown-preview')).toHaveText('[inert](javascript:alert(1))');
  await expect(page.locator('.candidate-facts dd').filter({ hasText: /限制再分发/ })).toBeVisible();

  await page.locator('.import-candidate input[type="checkbox"]').first().check();
  await expect(page.locator('[data-selection-summary]')).toContainText('已选择 1 项');
  const selectedPreviewButton = page.getByRole('button', { name: '预览所选条目' });
  await expect(selectedPreviewButton).toBeEnabled();
  await selectedPreviewButton.click();
  await expect(page.locator('[data-selected-preview]')).toContainText('1 项');
  await expect(page.locator('[data-selected-preview]')).toContainText(
    '不会创建草稿文件、分支或 PR',
  );
});

test('GitHub API 429 的 Retry-After 在后台 UI 清晰可见', async ({ page }) => {
  const html = await readFile(new URL('../dist/admin/import/index.html', import.meta.url), 'utf8');
  await page.route('**/admin/import', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: html }),
  );
  await page.route('**/api/admin/import/preview', (route) =>
    route.fulfill({
      status: 429,
      headers: { 'Retry-After': '17' },
      contentType: 'application/json',
      body: JSON.stringify({ error: 'github_rate_limited' }),
    }),
  );
  await page.goto('/admin/import');
  await page.getByLabel('GitHub URL').fill('https://github.com/anthropics/skills');
  await page.getByRole('button', { name: '解析来源' }).click();
  await expect(page.locator('[data-import-status]')).toContainText('等待 17 秒后重试');
});

test('不存在的详情路由显示站内 404 页面', async ({ page }) => {
  const response = await page.goto('/skills/not-a-real-skill');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1, name: '页面未找到' })).toBeVisible();
  await expect(page.getByRole('link', { name: /返回首页/ })).toHaveAttribute('href', '/');
});

const editorSha = 'a'.repeat(40);
const editorUpstreamSha = 'b'.repeat(40);

const editorCatalogPayload = {
  entries: [
    {
      slug: 'demo-skill',
      identity: {
        sourceRepo: 'anthropics/skills',
        sourcePath: 'skills/demo/SKILL.md',
        sourceSha: editorSha,
        license: 'Apache-2.0',
        licenseStatus: 'redistributable',
        sourceAttribution: 'anthropics/skills',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-10T00:00:00.000Z',
      },
      fields: {
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
            src: '/skills/demo-skill/cover.svg',
            alt: '示例图',
            attribution: 'Example creator',
          },
        ],
        body: '## 使用说明\n\n已发布正文。',
        featured: false,
        status: 'verified',
      },
    },
  ],
};

async function routeEditorPage(page: import('@playwright/test').Page) {
  const html = await readFile(new URL('../dist/admin/editor/index.html', import.meta.url), 'utf8');
  await page.route('**/admin/editor', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: html }),
  );
  await page.route('**/api/admin/editor/catalog', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(editorCatalogPayload),
    }),
  );
}

test('编辑器载入已发布条目、保留稳定 slug，并只在浏览器保存草稿', async ({ page }) => {
  await routeEditorPage(page);
  await page.goto('/admin/editor');
  await page.selectOption('[data-entry-select]', 'demo-skill');
  await expect(page.locator('[data-field="name"]')).toHaveValue('已发布名称');
  await expect(page.locator('[data-provenance="name"]')).toHaveText('已发布');
  await expect(page.locator('#editor-slug')).toHaveValue('demo-skill');
  await expect(page.locator('#editor-slug')).toHaveAttribute('readonly', '');

  await page.locator('[data-field="name"]').fill('本地名称');
  await expect(page.locator('[data-provenance="name"]')).toHaveText('手动修改');
  await expect(page.locator('[data-preview-card] .card-copy h3')).toHaveText('本地名称');
  await page.getByRole('button', { name: '保存草稿' }).click();
  await expect(page.locator('[data-editor-status]')).toContainText('草稿已保存');

  const storage = await page.evaluate(() => {
    const keys = Object.keys(localStorage);
    const firstKey = keys[0];
    const raw = firstKey ? (localStorage.getItem(firstKey) ?? '') : '';
    return { keys, raw };
  });
  expect(storage.keys).toEqual(['msl-editor-draft-v1:demo-skill']);
  expect(storage.raw).not.toMatch(/"(?:token|password|secret|authorization)"/i);
  expect(storage.raw).toContain('本地名称');

  await page.goto('/admin/editor');
  await page.selectOption('[data-entry-select]', 'demo-skill');
  await expect(page.locator('[data-draft-banner]')).toBeVisible();
  await page.getByRole('button', { name: '恢复草稿' }).click();
  await expect(page.locator('[data-field="name"]')).toHaveValue('本地名称');
  await expect(page.locator('[data-draft-banner]')).toBeHidden();
});

test('编辑器校验与公开预览复用公开渲染语义，并支持详情与移动端视图', async ({ page }) => {
  await page.goto('/');
  const publicParts = await page
    .locator('[data-card]')
    .first()
    .evaluate((card) => {
      const selectors = [
        '.card-art',
        '.card-copy',
        '.card-meta',
        '.category-label',
        '.type-label',
        '.card-bottom',
        '.status-pill',
        '.card-detail',
      ];
      return selectors.filter((selector) => card.querySelector(selector));
    });
  expect(publicParts.length).toBeGreaterThanOrEqual(8);

  await routeEditorPage(page);
  await page.goto('/admin/editor');
  await page.selectOption('[data-entry-select]', 'demo-skill');
  const previewParts = await page.locator('[data-preview-card]').evaluate((card) => {
    const selectors = [
      '.card-art',
      '.card-copy',
      '.card-meta',
      '.category-label',
      '.type-label',
      '.card-bottom',
      '.status-pill',
      '.card-detail',
    ];
    return selectors.filter((selector) => card.querySelector(selector));
  });
  expect(previewParts).toEqual(publicParts);

  await page.locator('[data-field="name"]').fill('');
  await expect(page.locator('[data-validation-list]')).toContainText('名称不能为空');
  const description = page.locator('[data-field="description"]');
  await expect(description).toHaveAttribute('maxlength', '220');
  await description.fill('x'.repeat(300));
  await expect(page.locator('[data-description-count]')).toHaveText('220');
  await page.locator('[data-field="name"]').fill('有效名称');
  await description.fill('有效简介。');
  await expect(page.locator('[data-validation-summary]')).toContainText('校验通过');

  await page.getByRole('tab', { name: '详情页' }).click();
  await expect(page.locator('[data-preview-panel="detail"]')).toBeVisible();
  await expect(page.locator('[data-preview-detail] .detail-hero h1')).toHaveText('有效名称');
  await expect(page.locator('[data-preview-detail] .fact-list')).toContainText('许可证');

  await page.getByRole('tab', { name: '移动端' }).click();
  const mobile = page.locator('[data-preview-panel="mobile"] .mobile-frame');
  await expect(mobile).toBeVisible();
  expect(await mobile.evaluate((element) => element.getBoundingClientRect().width)).toBe(390);
});

test('编辑器重新导入时逐字段解决上游冲突，绝不静默覆盖', async ({ page }) => {
  await routeEditorPage(page);
  await page.route('**/api/admin/import/preview', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sourceRepo: 'anthropics/skills',
        resolvedRef: 'main',
        sourceSha: editorUpstreamSha,
        partial: false,
        warnings: [],
        errors: [],
        candidates: [
          {
            sourceRepo: 'anthropics/skills',
            sourcePath: 'skills/demo/SKILL.md',
            sourceSha: editorUpstreamSha,
            sourceAttribution: 'anthropics/skills',
            license: 'Apache-2.0',
            licenseStatus: 'redistributable',
            name: '上游新名称',
            description: '上游新简介。',
            suggestedSlug: 'demo-skill',
          },
        ],
      }),
    });
  });
  await page.goto('/admin/editor');
  await page.selectOption('[data-entry-select]', 'demo-skill');
  await page.locator('[data-field="name"]').fill('我的名称');

  await page.getByRole('button', { name: '重新导入来源' }).click();
  await expect(page.locator('[data-conflict-panel]')).toBeVisible();
  const applyButton = page.getByRole('button', { name: '应用所选字段' });
  await expect(applyButton).toBeDisabled();
  await expect(page.locator('[data-conflict-item="name"]')).toContainText('本地：我的名称');
  await expect(page.locator('[data-conflict-item="name"]')).toContainText('上游：上游新名称');
  await expect(page.locator('[data-conflict-item="description"]')).toContainText('本地未修改');

  await page.locator('input[data-conflict-choice="name:keep-local"]').check();
  await expect(applyButton).toBeEnabled();
  await applyButton.click();
  await expect(page.locator('[data-field="name"]')).toHaveValue('我的名称');
  await expect(page.locator('[data-field="description"]')).toHaveValue('上游新简介。');
  await expect(page.locator('[data-provenance="name"]')).toHaveText('手动修改');
  await expect(page.locator('[data-editor-status]')).toContainText('已按所选字段应用');
  await expect(page.locator('[data-conflict-panel]')).toBeHidden();
});

test('导入页候选交接后在编辑器中按 repo+path 更新原条目而非新建重复卡片', async ({ page }) => {
  const importHtml = await readFile(
    new URL('../dist/admin/import/index.html', import.meta.url),
    'utf8',
  );
  await routeEditorPage(page);
  await page.route('**/admin/import', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: importHtml }),
  );
  await page.route('**/api/admin/import/preview', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sourceRepo: 'anthropics/skills',
        resolvedRef: 'main',
        sourceSha: editorUpstreamSha,
        partial: false,
        warnings: [],
        errors: [],
        candidates: [
          {
            sourceRepo: 'anthropics/skills',
            sourcePath: 'skills/demo/SKILL.md',
            sourceSha: editorUpstreamSha,
            sourceAttribution: 'anthropics/skills',
            license: 'Apache-2.0',
            licenseStatus: 'redistributable',
            name: '上游新名称',
            description: '上游新简介。',
            suggestedSlug: 'demo-skill',
            markdownWarnings: [],
            selectable: true,
            state: 'new',
          },
        ],
      }),
    }),
  );
  await page.goto('/admin/import');
  await page.getByLabel('GitHub URL').fill('https://github.com/anthropics/skills');
  await page.getByRole('button', { name: '解析来源' }).click();
  await expect(page.locator('.import-candidate')).toHaveCount(1);
  await page.locator('.import-candidate input[type="checkbox"]').check();
  await page.getByRole('button', { name: '预览所选条目' }).click();
  await page.getByRole('button', { name: '在编辑器中打开' }).click();

  await expect(page).toHaveURL(/\/admin\/editor$/);
  await expect(page.locator('[data-entry-select]')).toHaveValue('demo-skill');
  await expect(page.locator('#editor-slug')).toHaveValue('demo-skill');
  await expect(page.locator('[data-field="name"]')).toHaveValue('已发布名称');
  await expect(page.locator('[data-conflict-panel]')).toBeVisible();
  await expect(page.locator('[data-conflict-item="identity.sourceSha"]')).toContainText(
    '本地未修改',
  );
  await page.getByRole('button', { name: '应用所选字段' }).click();
  await expect(page.locator('[data-field="name"]')).toHaveValue('上游新名称');
  await expect(page.locator('[data-conflict-panel]')).toBeHidden();
  await expect(page.locator('[data-editor-status]')).toContainText('已按所选字段应用');
});

test('编辑器发布到 PR，状态逐步推进且 PR 创建不等于上线', async ({ page }) => {
  await routeEditorPage(page);
  let published = false;
  await page.route('**/api/admin/publish', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    const body = route.request().postDataJSON() as {
      entries: Array<{ slug: string; confirmPublish: boolean }>;
    };
    expect(body.entries[0]?.slug).toBe('demo-skill');
    expect(body.entries[0]?.confirmPublish).toBe(true);
    published = true;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        entries: [
          {
            slug: 'demo-skill',
            stage: 'pr_created',
            pull: {
              number: 12,
              url: 'https://github.com/0verme/my-skill-library/pull/12',
              state: 'open',
              headSha: 'b'.repeat(40),
            },
            mergeable: null,
            checks: 'none',
            failingChecks: [],
            deploy: { state: 'unknown' },
            updatedAt: new Date().toISOString(),
            action: 'create',
          },
        ],
      }),
    });
  });
  await page.route('**/api/admin/publish/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        entries: [
          {
            slug: 'demo-skill',
            stage: 'checks_passed',
            pull: {
              number: 12,
              url: 'https://github.com/0verme/my-skill-library/pull/12',
              state: 'open',
              headSha: 'b'.repeat(40),
            },
            mergeable: true,
            checks: 'passed',
            failingChecks: [],
            deploy: { state: 'unknown' },
            updatedAt: new Date().toISOString(),
          },
        ],
      }),
    }),
  );
  await page.route('**/api/admin/publish/merge', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        entries: [
          {
            slug: 'demo-skill',
            stage: 'deployed',
            pull: {
              number: 12,
              url: 'https://github.com/0verme/my-skill-library/pull/12',
              state: 'merged',
              headSha: 'b'.repeat(40),
            },
            mergeable: true,
            checks: 'passed',
            failingChecks: [],
            deploy: {
              state: 'success',
              runUrl: 'https://github.com/0verme/my-skill-library/actions/runs/1',
            },
            updatedAt: new Date().toISOString(),
            action: 'merged',
          },
        ],
      }),
    }),
  );

  await page.goto('/admin/editor');
  await page.selectOption('[data-entry-select]', 'demo-skill');
  await expect(page.locator('.publish-panel')).toContainText('PR 创建不等于已上线');
  const publishButton = page.getByRole('button', { name: '发布到 PR' });
  await expect(publishButton).toBeEnabled();
  await publishButton.click();
  await expect(page.locator('[data-publish-status]')).toContainText('PR 已创建');
  await expect(page.locator('[data-step="pr"]')).toHaveAttribute('data-state', 'done');
  await expect(page.locator('[data-step="live"]')).toHaveAttribute('data-state', 'pending');
  expect(published).toBe(true);
  const mergeButton = page.getByRole('button', { name: '受控合并' });
  await expect(mergeButton).toBeDisabled();

  await page.getByRole('button', { name: '刷新状态' }).click();
  await expect(page.locator('[data-publish-status]')).toContainText('必需 CI 已通过');
  await expect(mergeButton).toBeEnabled();

  await mergeButton.click();
  await expect(page.locator('[data-publish-status]')).toContainText('已上线');
  await expect(page.locator('[data-step="live"]')).toHaveAttribute('data-state', 'done');
  await expect(page.locator('[data-step="deploy"]')).toHaveAttribute('data-state', 'done');
  await expect(mergeButton).toBeDisabled();
});

test('发布被许可或校验门槛阻止时显示错误且不启用合并', async ({ page }) => {
  await routeEditorPage(page);
  await page.route('**/api/admin/publish', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        entries: [
          {
            slug: 'demo-skill',
            stage: 'blocked',
            pull: null,
            mergeable: null,
            checks: 'none',
            failingChecks: [],
            deploy: { state: 'unknown' },
            updatedAt: new Date().toISOString(),
            action: 'blocked',
            blockedReasons: ['validation_failed', 'license_blocked'],
          },
        ],
      }),
    }),
  );
  await page.goto('/admin/editor');
  await page.selectOption('[data-entry-select]', 'demo-skill');
  await page.getByRole('button', { name: '发布到 PR' }).click();
  await expect(page.locator('[data-publish-status]')).toContainText('发布被阻止');
  await expect(page.getByRole('button', { name: '受控合并' })).toBeDisabled();
  await expect(page.locator('[data-step="pr"]')).toHaveAttribute('data-state', 'failed');
});
