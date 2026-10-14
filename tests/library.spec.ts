import AxeBuilder from '@axe-core/playwright';
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

test('不存在的详情路由显示站内 404 页面', async ({ page }) => {
  const response = await page.goto('/skills/not-a-real-skill');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1, name: '页面未找到' })).toBeVisible();
  await expect(page.getByRole('link', { name: /返回首页/ })).toHaveAttribute('href', '/');
});
