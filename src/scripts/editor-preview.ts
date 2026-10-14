/**
 * Public-render-semantics preview builders for the Phase 3 editor.
 *
 * The admin editor is a static Astro page, so it cannot reuse the Astro
 * components directly. These builders intentionally mirror the public card and
 * detail markup (classes, structure and text-only handling) so what the editor
 * shows is what the public pages render. Playwright asserts class parity with
 * the built public pages.
 */

import type { EditorPreviewModel } from '../lib/admin/editor-model.ts';

function appendText<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  text: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  parent.append(element);
  return element;
}

function safeLinkHref(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function renderCardPreview(root: HTMLElement, model: EditorPreviewModel) {
  root.replaceChildren();
  const card = document.createElement('a');
  card.className = model.featured ? 'skill-card skill-card-featured' : 'skill-card';
  card.href = `/skills/${model.slug}`;
  card.setAttribute('data-card', 'preview');
  card.setAttribute('aria-label', `查看${model.name}：${model.description}`);

  const art = document.createElement('div');
  art.className = 'card-art';
  art.setAttribute('data-media-frame', '');
  if (model.cover) {
    const image = document.createElement('img');
    image.src = model.cover;
    image.alt = `${model.name}封面预览`;
    image.width = 1200;
    image.height = 900;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.setAttribute('data-fallback-image', '');
    image.addEventListener('error', () => {
      image.hidden = true;
      fallback.hidden = false;
    });
    const fallback = document.createElement('div');
    fallback.className = 'media-fallback card-fallback';
    fallback.hidden = true;
    fallback.setAttribute('aria-hidden', 'true');
    appendText(fallback, 'span', '预览暂不可用');
    art.append(image, fallback);
  } else {
    const fallback = document.createElement('div');
    fallback.className = 'card-fallback card-fallback-visible';
    fallback.setAttribute('aria-hidden', 'true');
    appendText(fallback, 'span', '暂无作品预览');
    art.append(fallback);
  }
  if (model.featured) appendText(art, 'span', '编辑精选', 'featured-stamp');
  const open = appendText(art, 'span', '↗', 'card-open');
  open.setAttribute('aria-hidden', 'true');
  card.append(art);

  const copy = document.createElement('div');
  copy.className = 'card-copy';
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  appendText(meta, 'span', model.category, 'category-label');
  appendText(meta, 'span', model.typeLabel, 'type-label');
  copy.append(meta);
  appendText(copy, 'h3', model.name);
  appendText(copy, 'p', model.description);
  const bottom = document.createElement('div');
  bottom.className = 'card-bottom';
  appendText(bottom, 'span', model.statusLabel, `status-pill status-${model.status}`);
  const detail = appendText(bottom, 'span', '查看详情 ', 'card-detail');
  const arrow = appendText(detail, 'span', '→');
  arrow.setAttribute('aria-hidden', 'true');
  copy.append(bottom);
  card.append(copy);

  root.append(card);
}

export function renderDetailPreview(root: HTMLElement, model: EditorPreviewModel) {
  root.replaceChildren();
  const detail = document.createElement('div');
  detail.className = 'detail-page';
  detail.setAttribute('data-preview-detail', '');

  const hero = document.createElement('header');
  hero.className = 'detail-hero';
  const meta = document.createElement('div');
  meta.className = 'detail-meta';
  appendText(meta, 'span', model.category, 'category-label');
  appendText(meta, 'span', model.typeLabel, 'type-label');
  appendText(meta, 'span', model.statusLabel, `status-pill status-${model.status}`);
  hero.append(meta);
  appendText(hero, 'h1', model.name);
  appendText(hero, 'p', model.description, 'detail-description');
  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  if (model.sourceUrl) {
    const link = document.createElement('a');
    link.className = 'action-link';
    link.href = model.sourceUrl;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = '查看来源仓库 ↗';
    actions.append(link);
  } else {
    appendText(actions, 'span', '暂无第三方来源记录', 'action-muted');
  }
  hero.append(actions);
  detail.append(hero);

  const gallerySection = document.createElement('section');
  gallerySection.className = 'detail-section';
  const galleryHeading = document.createElement('div');
  galleryHeading.className = 'detail-section-heading';
  appendText(galleryHeading, 'h2', '作品画廊');
  appendText(galleryHeading, 'p', '媒体归属与来源信息以各项说明为准；未标注不代表已获转载授权。');
  gallerySection.append(galleryHeading);
  if (model.gallery.length > 0) {
    const grid = document.createElement('div');
    grid.className = 'gallery-grid';
    for (const item of model.gallery) {
      const figure = document.createElement('figure');
      figure.className = 'gallery-item';
      const frame = document.createElement('div');
      frame.className = 'media-frame';
      frame.setAttribute('data-media-frame', '');
      if (item.type === 'video') {
        appendText(frame, 'span', `视频：${item.alt}`, 'media-preview-note');
      } else if (item.before && item.after) {
        const comparison = document.createElement('div');
        comparison.className = 'media-comparison';
        for (const sample of [item.before, item.after]) {
          const panel = document.createElement('div');
          panel.className = 'comparison-panel';
          const image = document.createElement('img');
          image.src = sample;
          image.alt = item.alt;
          image.width = 900;
          image.height = 760;
          panel.append(image);
          comparison.append(panel);
        }
        frame.append(comparison);
      } else {
        const image = document.createElement('img');
        image.src = item.src;
        image.alt = item.alt;
        image.width = 1200;
        image.height = 900;
        frame.append(image);
      }
      figure.append(frame);
      if (item.caption || item.attribution || item.sourceUrl) {
        const caption = document.createElement('figcaption');
        caption.className = 'media-caption';
        if (item.caption) appendText(caption, 'span', item.caption);
        if (item.attribution) appendText(caption, 'span', item.attribution, 'media-attribution');
        const sourceHref = safeLinkHref(item.sourceUrl);
        if (sourceHref) {
          const link = document.createElement('a');
          link.href = sourceHref;
          link.target = '_blank';
          link.rel = 'noreferrer';
          link.textContent = '媒体来源 ↗';
          caption.append(link);
        }
        figure.append(caption);
      }
      grid.append(figure);
    }
    gallerySection.append(grid);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'gallery-placeholder';
    const inner = document.createElement('div');
    appendText(inner, 'strong', '作品预览稍后补充');
    appendText(inner, 'p', '这个条目目前没有封面或画廊资源，其余内容说明仍可正常查看。');
    placeholder.append(inner);
    gallerySection.append(placeholder);
  }
  detail.append(gallerySection);

  const columns = document.createElement('div');
  columns.className = 'detail-columns';
  const article = document.createElement('section');
  article.className = 'article-panel detail-section';
  const articleHeading = document.createElement('div');
  articleHeading.className = 'detail-section-heading';
  appendText(articleHeading, 'h2', '使用说明');
  appendText(articleHeading, 'p', '由 Markdown 内容文件维护');
  article.append(articleHeading);
  const articleBody = document.createElement('article');
  articleBody.className = 'markdown-body';
  appendText(articleBody, 'p', '编辑器预览不渲染或执行上游 Markdown 正文。');
  article.append(articleBody);
  columns.append(article);

  const sidebar = document.createElement('aside');
  sidebar.className = 'sidebar-panel detail-section';
  appendText(sidebar, 'h2', '条目信息');
  const facts = document.createElement('dl');
  facts.className = 'fact-list';
  const factRows: Array<[string, string]> = [
    ['类型', model.typeLabel],
    ['分类', model.category],
    ['支持工具', model.supportedTools.length ? model.supportedTools.join('、') : '未指定'],
    ['许可证', model.license ?? '未提供'],
    ['许可状态', model.licenseStatusLabel ?? '尚未核验'],
  ];
  if (model.sourcePath) factRows.push(['来源路径', model.sourcePath]);
  if (model.sourceAttribution) factRows.push(['来源归属', model.sourceAttribution]);
  for (const [term, value] of factRows) {
    const row = document.createElement('div');
    appendText(row, 'dt', term);
    appendText(row, 'dd', value);
    facts.append(row);
  }
  sidebar.append(facts);
  if (model.tags.length > 0) {
    appendText(sidebar, 'p', `标签：${model.tags.join(' · ')}`, 'result-count');
  }
  columns.append(sidebar);
  detail.append(columns);

  if (model.prompt) {
    const panel = document.createElement('section');
    panel.className = 'prompt-panel';
    appendText(panel, 'h2', '完整 Prompt');
    const pre = document.createElement('pre');
    pre.className = 'prompt-code';
    appendText(pre, 'code', model.prompt);
    panel.append(pre);
    detail.append(panel);
  }
  if (model.installCommand) {
    const panel = document.createElement('section');
    panel.className = 'prompt-panel';
    appendText(panel, 'h2', '安装命令');
    const pre = document.createElement('pre');
    pre.className = 'prompt-code';
    appendText(pre, 'code', model.installCommand);
    panel.append(pre);
    detail.append(panel);
  }

  root.append(detail);
}
