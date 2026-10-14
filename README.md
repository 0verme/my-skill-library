# My Skill Library

一个中文优先的个人 AI Skills、Prompts 与 Workflows 展示馆。公开作品由 Astro Content Collections 从 Markdown 静态生成；公开画廊不需要登录、数据库或在线 AI 服务。管理后台通过 Cloudflare Worker 服务端鉴权，与公开画廊分开保护。

> v0.1 里的四个条目、提示词与 SVG 均为项目原创的**演示内容**，不代表第三方 Skill 已运行或通过验证。预期正式域名为 `https://skill.overme.cn`，域名绑定与线上可用性需单独核验。

## 技术栈

- Astro 7 + TypeScript，默认静态生成（SSG）
- Astro Content Collections + Zod Schema
- Tailwind CSS 4（Vite 插件）与少量手写设计系统
- GitHub Actions：类型/内容检查、Mock 安全测试、格式检查、正式构建、Wrangler dry-run、Playwright 浏览器冒烟
- Cloudflare Worker + Workers Static Assets：公开页面使用 `dist/`，`/admin` 与 `/api/admin` 先经过 Worker JWT 验证

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

Astro 会在终端显示本地地址（通常为 `http://localhost:4321`）。`npm run dev` 只用于静态页面开发，不会模拟 Cloudflare Worker 鉴权；验证后台安全请使用 Wrangler Worker 集成测试（`npm run test:e2e`）。

```bash
npm run check        # Astro、TypeScript、Content Collection Schema 检查
npm run test:schema  # Skill 可省略 prompt，Prompt 必须提供 prompt
npm run test:worker  # Mock Access JWT / JWKS、同源、幂等、限流、GitHub App 安全测试
npm run test:import  # GitHub URL/ref、frontmatter、许可、路径、限流与资源边界 fixture
npm run test:editor  # 草稿序列化/凭据拒绝、发布前校验、provenance、逐字段冲突与稳定 slug
npm run test:publish # 发布校验/幂等计划/受控合并门槛/状态机与 GitHub client 边界
npm run format:check # Prettier 格式检查
npm run build        # 生产静态构建，产物在 dist/
npm run test:seo    # 校验 canonical、OG、sitemap、robots 的正式域名
npm run preview      # 预览 Astro 静态构建
npm run test:e2e     # 构建后经 Wrangler Worker 跑 Chromium 冒烟（首次需安装浏览器）
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
type: skill # skill | prompt | workflow
category: 视觉实验 # 首页分类由内容自动汇总
# tags: [示例, 灵感]
# cover: /skills/example/cover.svg
gallery: [] # 可选：无媒体时详情页会显示统一空状态
supportedTools: []
# Skill 不要求提供完整 Prompt；type: prompt 时 prompt 必填。
# prompt: |
#   仅在维护 Prompt 条目时填写结构化内容。
featured: false
status: demo # demo | unverified | verified
license: 未提供
createdAt: 2026-10-14
updatedAt: 2026-10-14
---
## 使用场景

在 Markdown 正文维护使用说明、场景和步骤。只有 `type: prompt` 的条目必须提供 `prompt` 字段；Skill 可只提供经审阅的简介、使用说明、来源链接与来源元数据。
```

Schema 还支持 `sourceUrl`、`repoUrl`、`sourceRepo`、`sourcePath`、`sourceSha`、`sourceAttribution`、`importedSnapshotHash`、`skillPath`、`license`、`licenseStatus`、`installCommand` 和 `gallery`。来源身份优先使用 `sourceRepo + sourcePath`，Commit SHA 用于记录解析版本；旧字段 `repoUrl`、`skillPath` 保持兼容。许可状态为 `original`、`redistributable`、`restricted`、`unknown` 或 `not-applicable`；未知许可不能视为授权转载。画廊项支持 `type: image | video`、`src`、`alt`、`caption`、`before` / `after`、`attribution` 和可选 `sourceUrl`；安装命令、视频、封面和外部来源均可缺省。详情页只展示命令，不会执行它。

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

绑定正式域名 `skill.overme.cn`：在 Cloudflare Dashboard 打开部署的 Worker，进入 **Settings → Domains & Routes → Add → Custom Domain**，输入 `skill.overme.cn` 并按页面提示确认 DNS/域名条件。也可以之后以 Wrangler `custom_domain` route 配置管理。此步骤需要域名和 Cloudflare 账号权限，不会由静态构建自动完成。代码配置本身不能证明域名绑定或生产内容正确，仍需检查线上响应、canonical、sitemap 与页面版本。

静态站点地址在 `astro.config.ts` 集中预设，因此 canonical、Open Graph 与 sitemap 指向预期域名。部署到其他域名时请先更新该 `site` 配置与 `public/robots.txt`。

## 管理后台与外部鉴权

管理页面位于 `/admin`、`/admin/import` 与 `/admin/editor`。生产 Worker 会在返回管理 HTML 或处理 `/api/admin/*` 前，服务端验证 Cloudflare Access JWT 签名、issuer、audience、有效期和管理员邮箱；`workers.dev` 与正式域名复用同一验证。未配置 Access 环境变量时受保护路径默认返回 `503`。Phase 2 仅启用经过同源、幂等键和请求大小校验的公开 GitHub **只读预览** API；Phase 3 增加 `GET /api/admin/editor/catalog` 读取已发布条目，并在 `/admin/editor` 提供可视化编辑、公开语义预览与浏览器本地草稿（不含凭据）。Phase 4 增加 Access 鉴权的 `POST /api/admin/publish`、`/api/admin/publish/status` 与 `/api/admin/publish/merge`：由服务端 GitHub App 最小权限创建/更新 `content/<slug>` 分支与中文 PR，仅当必需 CI 全绿、PR 无冲突且无许可/校验门槛时才能显式受控合并；PR 不触发生产部署，合并后仍由既有 main CI 部署。URL、许可证、安全限制见 [GitHub 导入安全说明](docs/github-import.md)；草稿、provenance 与逐字段冲突规则见 [可视化编辑器说明](docs/admin-editor.md)；发布状态机、幂等与自动合并门槛见 [发布管线说明](docs/admin-publish.md)。

真实 Cloudflare Access policy、管理员 allowlist 和 GitHub App 凭据需要仓库/账号管理员在 Cloudflare/GitHub 完成配置；当前没有真实身份集成凭据，Mock 自动化测试不代表生产鉴权或外部 GitHub 网络验证已通过。请按 [管理后台安全配置与最小权限 SOP](docs/admin-security.md) 操作。禁止把 GitHub App 私钥、installation token 或 Access JWT 写入仓库、静态资源、日志或浏览器代码。

## 页面与内容结构

- `src/pages/index.astro`：首页搜索、数据驱动分类、精选卡片和空结果状态
- `src/pages/skills/[slug].astro`：由 Collection 自动生成的静态详情页
- `src/pages/admin/`：受 Worker 中间件保护的管理页面（含导入预览与可视化编辑器，并从 Sitemap 排除）
- `src/worker.ts`、`src/lib/admin/`：Worker 请求路由、Access JWT、CSRF、幂等基础、限流、安全 GitHub API 预览、编辑器目录 API 与服务端 GitHub App 基础
- `src/scripts/admin-editor.ts`、`src/scripts/editor-preview.ts`：浏览器草稿、字段 provenance/冲突 UI、发布状态面板与公开语义预览
- `src/lib/admin/editor-model.ts`、`src/lib/admin/publish.ts`、`src/lib/admin/github-publish.ts`：草稿/校验/冲突纯函数、发布计划与状态机、服务端 GitHub App 发布 client
- `src/content.config.ts`：Zod 内容模型与 URL/媒体路径校验
- `src/content/skills/`：Markdown 条目
- `public/skills/`：原创封面与画廊素材
- `src/styles/global.css`：设计 Tokens、响应式与 reduced-motion 样式
- `tests/`：Playwright 导航、搜索、筛选、复制、缺图、移动端、404 与 Axe 无障碍审计用例
- `docs/screenshots/`：Playwright 捕获的桌面与移动首页截图
- `docs/architecture.md`：内容与部署架构说明

## 参考与复用

查看 [架构说明](docs/architecture.md) 中关于模板评估、许可证、设计参考和复用边界的记录。没有复制第三方品牌、图片、文案或模板页面资源。
