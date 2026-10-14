# My Skill Library

一个中文优先的个人 AI Skills、Prompts 与 Workflows 展示馆。作品由 Astro Content Collections 从 Markdown 静态生成；不需要登录、后端、数据库或在线 AI 服务。

> v0.1 里的四个条目、提示词与 SVG 均为项目原创的**演示内容**，不代表第三方 Skill 已运行或通过验证。计划域名为 `https://skills.overme.cn`，尚未部署。

## 技术栈

- Astro 7 + TypeScript，默认静态生成（SSG）
- Astro Content Collections + Zod Schema
- Tailwind CSS 4（Vite 插件）与少量手写设计系统
- GitHub Actions：类型/内容检查、格式检查、正式构建、Wrangler dry-run、Playwright 浏览器冒烟
- Cloudflare Workers Static Assets，Wrangler 静态资源目录为 `dist/`

没有 SSR Adapter、客户端组件框架、数据库、D1、KV 或 R2。

## 预览截图

- [桌面首页](docs/screenshots/homepage.png)
- [移动首页](docs/screenshots/mobile.png)

## 本地开发

要求 Node.js `>=22.12.0` 与 npm。

```bash
npm ci
npm run dev
```

Astro 会在终端显示本地地址（通常为 `http://localhost:4321`）。

```bash
npm run check        # Astro、TypeScript、Content Collection Schema 检查
npm run format:check # Prettier 格式检查
npm run build        # 生产静态构建，产物在 dist/
npm run preview      # 预览 Astro 静态构建
npm run test:e2e     # Chromium 浏览器冒烟测试（首次需安装浏览器）
```

Playwright 首次安装：

```bash
npx playwright install chromium
```

Cloudflare 配置可在本地无账号构建检查：

```bash
npm run cf:check     # Wrangler 静态资源 dry-run，不会部署
npm run build && npm run cf:dev # Wrangler 本地预览 dist/
```

## 添加一个 Skill / Prompt / Workflow

新增 `src/content/skills/<slug>.md`。文件名就是稳定 URL slug，并自动生成首页卡片与 `/skills/<slug>` 详情页；无需修改页面组件或手工维护路由。

```yaml
---
name: 示例作品
description: 简洁的一句话介绍。
type: prompt # skill | prompt | workflow
category: 视觉实验 # 首页分类由内容自动汇总
# tags: [示例, 灵感]
# cover: /skills/example/cover.svg
gallery: [] # 可选：无媒体时详情页会显示统一空状态
supportedTools: []
prompt: |
  将你自己的完整提示词写在这里。
featured: false
status: demo # demo | unverified | verified
license: 未提供
createdAt: 2026-10-14
updatedAt: 2026-10-14
---
## 使用场景

在 Markdown 正文维护使用说明、场景和步骤。Prompt 只维护在 `prompt` 字段，避免与正文出现两份冲突副本。
```

Schema 还支持 `sourceUrl`、`repoUrl`、`skillPath`、`installCommand` 和 `gallery`。画廊项支持 `type: image | video`、`src`、`alt`、`caption`、`before` / `after` 与 `attribution`；安装命令、视频、封面和外部来源均可缺省。详情页只展示命令，不会执行它。

本地媒体放在 `public/skills/<slug>/`，内容中引用为 `/skills/<slug>/filename.svg`。外部媒体只接受 HTTPS；来源链接只接受 HTTP(S)。缺失资源会降级显示占位。Markdown HTML 会经 `rehype-sanitize` 清理，页面不会执行 Skill 内容或第三方代码。

`category` 由内容驱动：新增分类会自动出现在首页筛选中。`status` 用于区分演示、未验证与已验证；请勿把未实际验证的条目标成 `verified`。

## 更新作品画廊

修改或新增 `src/content/skills/*.md`，并将原创/获授权媒体放入 `public/skills/<slug>/`。执行 `npm run check && npm run build` 预览变更。由 Markdown 内容和 Git 历史管理变更，不需要 CMS。

## Cloudflare Workers Static Assets 部署

仓库提供 `wrangler.jsonc`：`assets.directory` 指向 `./dist`，默认使用 Workers 的 `workers.dev` 测试域名；没有 Cloudflare Account ID、密钥、SSR Adapter 或额外资源绑定。

首次在本机授权并部署：

```bash
npx wrangler login
npm run deploy
```

Wrangler 会在部署时要求选择/使用当前账号，并输出 Worker 的默认测试 URL。CI 中的 `npm run cf:check` 仅用于 dry-run，不会发布。仓库的 `.github/workflows/ci.yml` 在 PR 上只做校验；当提交推送到 `main` 且所有检查（包括 Playwright）通过后，才会调用 [`0verme/ci-workflows` 的 Cloudflare Worker Deploy composite action](https://github.com/0verme/ci-workflows/tree/main/.github/actions/cloudflare-worker-deploy)（`@v1`），复用本次构建的 `dist/`，执行 `wrangler deploy`。部署时从 **my-skill-library 仓库的 Actions Secrets**（或对该仓库开放的组织级 Secrets）读取 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。首次部署前请确认 Token 有 Workers 部署权限，且 Cloudflare 账号正确。自动部署成功不代表自定义域名已经绑定。

绑定计划域名 `skills.overme.cn`：在 Cloudflare Dashboard 打开部署的 Worker，进入 **Settings → Domains & Routes → Add → Custom Domain**，输入 `skills.overme.cn` 并按页面提示确认 DNS/域名条件。也可以之后以 Wrangler `custom_domain` route 配置管理。此步骤需要域名和 Cloudflare 账号权限；当前仓库没有执行域名绑定，不能据此视为已上线。

静态站点地址在 `astro.config.ts` 集中预设，因此 canonical、Open Graph 与 sitemap 指向预期域名。部署到其他域名时请先更新该 `site` 配置与 `public/robots.txt`。

## 页面与内容结构

- `src/pages/index.astro`：首页搜索、数据驱动分类、精选卡片和空结果状态
- `src/pages/skills/[slug].astro`：由 Collection 自动生成的静态详情页
- `src/content.config.ts`：Zod 内容模型与 URL/媒体路径校验
- `src/content/skills/`：Markdown 条目
- `public/skills/`：原创封面与画廊素材
- `src/styles/global.css`：设计 Tokens、响应式与 reduced-motion 样式
- `tests/`：Playwright 导航、搜索、筛选、复制、缺图、移动端、404 与 Axe 无障碍审计用例
- `docs/screenshots/`：Playwright 捕获的桌面与移动首页截图
- `docs/architecture.md`：内容与部署架构说明

## 参考与复用

查看 [架构说明](docs/architecture.md) 中关于模板评估、许可证、设计参考和复用边界的记录。没有复制第三方品牌、图片、文案或模板页面资源。
