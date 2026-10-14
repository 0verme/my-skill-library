import tailwindcss from '@tailwindcss/vite';
import { rehypeShiki, unified } from '@astrojs/markdown-remark';
import sitemap from '@astrojs/sitemap';
import rehypeSanitize from 'rehype-sanitize';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://skills.overme.cn',
  output: 'static',
  trailingSlash: 'never',
  integrations: [sitemap()],
  markdown: {
    syntaxHighlight: false,
    processor: unified({
      rehypePlugins: [rehypeSanitize, [rehypeShiki, { theme: 'github-light' }]],
    }),
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
