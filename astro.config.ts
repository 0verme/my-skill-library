import tailwindcss from '@tailwindcss/vite';
import { rehypeShiki, unified } from '@astrojs/markdown-remark';
import sitemap from '@astrojs/sitemap';
import rehypeSanitize from 'rehype-sanitize';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://skill.overme.cn',
  output: 'static',
  trailingSlash: 'never',
  integrations: [
    sitemap({
      filter: (page) => {
        const pathname = new URL(page).pathname;
        return (
          pathname !== '/admin' &&
          !pathname.startsWith('/admin/') &&
          pathname !== '/import-catalog.json'
        );
      },
    }),
  ],
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
