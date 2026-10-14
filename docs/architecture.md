# 架构与内容模型

## 静态架构

Astro 以 `output: 'static'` 构建首页、`/skills/<slug>/` 详情、`/admin` 后台静态壳、404、sitemap、`/import-catalog.json` 与 `/editor-catalog.json` 索引及静态资源。所有条目在构建阶段由 `src/content.config.ts` 的 `glob()` Markdown loader 读取，并通过 Zod Schema 校验；没有 SSR Adapter、数据库、D1、KV 或 R2。`src/worker.ts` 是 Cloudflare Workers Static Assets 前置 Worker，为后台执行服务端 Access JWT 验证，并仅代理公开 GitHub API 的有界只读预览；公开页面保持静态。

首页与动态详情页共用 Collection 数据。文件名生成稳定的内容 ID/URL slug，`/skills/[slug].astro` 的 `getStaticPaths()` 为每条记录输出一个页面。卡片、分类导航与推荐条目均由内容生成。简单搜索/筛选和复制使用少量原生 TypeScript，不含 UI 框架 hydration。

## 内容模型

| 字段                                                 | 用途                                                     |
| ---------------------------------------------------- | -------------------------------------------------------- |
| Markdown 文件名                                      | 唯一 slug / 静态详情 URL                                 |
| `name`, `description`                                | 卡片、详情标题与 SEO 摘要                                |
| `type`, `category`, `tags`                           | Skill / Prompt / Workflow、筛选和推荐                    |
| `cover`, `gallery[]`                                 | 可选封面、图片/视频、前后对比、说明和归属                |
| `supportedTools[]`                                   | 声明兼容工具；不代表执行或验证                           |
| `prompt`                                             | Prompt 类型必填；Skill / Workflow 可缺省，用于展示和复制 |
| Markdown 正文                                        | 场景、步骤、注意事项等使用说明，不重复维护 Prompt        |
| `sourceUrl`, `sourceRepo`, `sourcePath`, `sourceSha` | 来源链接、GitHub 仓库/路径及解析 Commit SHA              |
| `sourceAttribution`, `importedSnapshotHash`          | 来源归属与用于未来显式更新/本地编辑冲突检测的快照摘要    |
| `license`, `licenseStatus`                           | 许可证名称与再分发状态；未知状态不代表获准转载           |
| `installCommand`                                     | 可选展示/复制的命令；永不自动执行                        |
| `featured`, `status`                                 | 首页精选和 `demo` / `unverified` / `verified` 状态       |
| `createdAt`, `updatedAt`                             | 来源/更新元数据，为未来导入保留                          |

媒体只接受站内 `/skills/` 路径或 HTTPS URL；来源链接只接受 HTTP(S)；仓库路径拒绝绝对路径、反斜杠和 `..` 段。媒体加载失败显示占位。URL Schema 只能校验格式/协议，不能替代内容作者对外部来源、许可和可用性的审核。来源字段记录仓库、相对路径、Commit SHA、归属与许可状态；媒体可分别记录来源链接与 attribution，未知许可不能当作再分发授权。Phase 2 只在 Skill 目录内发现可识别的许可文件；不会仅凭仓库根目录许可推定子 Skill 可复制。未知/限制许可仅输出来源元数据，不读取或复制 Skill 正文和媒体。分类值从当前 Collection 生成，不维护页面级分类清单。

Markdown HTML 经 `rehype-sanitize` 清理，语法块经 Shiki 构建高亮。站点展示而非解释/执行第三方 Skill；导入流程必须继续使用同一 Zod Schema，并补充来源、许可、媒体和资源限制审查。

## 管理后台与 Worker 边界

`wrangler.jsonc` 将 `src/worker.ts` 设为 Worker 入口，并通过 `assets.run_worker_first` 令 `/admin*`、`/api/admin*` 先经过鉴权再读取静态内容；正式域名和 `workers.dev` 均走相同处理器。Worker 校验 RS256 签名、Access issuer/AUD/有效期和管理员邮箱；配置缺失返回 503，登录缺失/失败返回 401，未授权管理员返回 403。它不把请求头存在本身当作认证，也不会向日志或浏览器写入凭据。

Phase 2 在 `/api/admin/import/preview` 增加仅 POST、只读公开 GitHub 导入预览，Worker 先验证 Access，再验证 same-origin、幂等键与 64 KiB 请求体；API 不接收任意外站 URL、不用用户 Token，也不写仓库或 GitHub。Phase 3 增加 `GET /api/admin/editor/catalog`：同样先验证 Access，再通过 ASSETS 读取只含已发布字段的 `/editor-catalog.json`（失败 `503 editor_catalog_unavailable`）；`/admin/editor` 的编辑状态只存在于浏览器 `localStorage`，不新增写端点。Phase 4 新增 `POST /api/admin/publish`、`/status` 与 `/merge`：同样先验证 Access/same-origin/幂等键/请求体，再由服务端 GitHub App 最小权限创建/更新 `content/<slug>` 分支与中文 PR，仅当必需 CI 全绿、无冲突且无许可/校验门槛时显式受控合并；PR 不触发生产部署。URL 解析和资源预算见 `docs/github-import.md`，编辑器与草稿/冲突规则见 `docs/admin-editor.md`，发布状态机与自动合并门槛见 `docs/admin-publish.md`。静态 `/import-catalog.json` 仅包含公开条目的 slug/sourceRepo/sourcePath/sourceSha/snapshot hash，供 Worker 判重和提示冲突。`createIdempotencyRegistry` 仍只在单个 isolate 存活；Phase 3/4 若启用写入，必须使用持久化/共享幂等机制或 GitHub 条件写，不能承诺内存实现跨实例恰好一次。受保护页面加 `no-store`、`noindex` 并从 sitemap 排除，`robots.txt` 同时排除 `/admin` 与 `/api/admin`。完整 Cloudflare Access / GitHub App 凭据设置见 `docs/admin-security.md`；Mock 测试不等同真实身份集成。

## 浏览器行为

- 首页在静态 HTML 中包含全部卡片；原生脚本仅执行关键词匹配和分类筛选。
- 详情页的 Prompt/命令使用 `navigator.clipboard`，不可用时使用基于文本框的兼容回退，并报告结果。
- `<video controls preload="metadata">` 只在条目选择 video 且媒体 URL 可用时生成，不自动播放。
- 图片/视频错误时显示缺失状态；无封面和空 gallery 使用独立画廊占位，不阻断 Prompt 与正文。
- 组件无客户端 hydration；样式对窄屏重新排版并尊重 `prefers-reduced-motion`。

## 参考调研和复用边界

- **Mohammedaljer/astro-portfolio-template**：GitHub 元数据显示 MIT。检查了 README 和 `package.json`；它使用 Astro 5、Tailwind 4、Content Collections，同时附带 Three.js 3D 展示、暗色模式、英/德国际化及额外交互。其项目/画廊概念有参考价值，但本项目聚焦中文静态作品馆，因此没有 fork/复制模板组件或资产，避免不需要的 Three.js 与主题/多语言范围。直接用 Astro Content Collections 的构建期路由模型，并从零实现本项目布局。
- **MengTo/Skills**：GitHub License API 确认 MIT；阅读 README/Demo 目录约定。参考其将可展示 Demo 与提示词关联的内容组织思想。本项目没有复制其 Skill 文本、演示、截图、HTML 或资源。
- **Skillry 中文目录**：仅用公开目录观察“作品优先、分类入口清楚”的信息层级；没有复用其品牌、文案、图片、截图或 CSS。该产品定位与本项目不同，本项目不做市场/注册表/搜索引擎。

参考仓库许可证和依赖声明不是对其全部依赖或内容的完整安全审计。v0.1 只复用开放标准和 Astro/Tailwind/Wrangler 工具链；没有导入第三方模板代码或媒体。

## SEO 和部署

`astro.config.ts` 将站点地址集中设为 `https://skill.overme.cn`，用于每页 canonical、Open Graph 和 sitemap；`public/robots.txt` 使用同一 sitemap 地址。配置正确不表示 DNS 已绑定或服务已上线。静态资源使用 `wrangler.jsonc` 的 `assets.directory: './dist'` 与 404 文档回退，受保护后台路由由同一 Worker 先处理；Access 配置没有完成时安全拒绝后台请求，不影响公开静态画廊。

## 验证

`tests/admin-security.test.ts` 使用 Mock JWKS、临时 RSA keys 与 Mock GitHub API 覆盖 Access 签名/声明、主机 fail-closed、同源、请求体大小、限流、日志脱敏、App 最小权限、编辑器目录 API 与发布端点的 Access/幂等/许可阻止/合并门槛。`tests/github-import.test.ts` 用 fixture 覆盖 GitHub URL/ref 路径解析、目录/单文件发现、frontmatter、许可证、去重、恶意 Markdown、路径与 API 资源限制；fixture 通过不等于真实网络验收。`tests/editor-model.test.ts` 用纯函数覆盖草稿序列化/凭据拒绝、发布前校验、provenance 优先级、逐字段冲突解决、稳定 slug/去重与快照哈希，`tests/publish-model.test.ts`、`tests/publish-github.test.ts` 覆盖发布计划、状态机、受控合并门槛与 GitHub client 的错误/部署步骤解析。`tests/library.spec.ts` 通过 Wrangler Worker 覆盖首页与四卡片点击、搜索、分类、详情内容/SEO、后台无配置拒绝、剪贴板、断图降级、移动视口、404、导入预览、编辑器草稿/预览/冲突/交接、发布步骤面板及 Axe 自动化无障碍审计。桌面和移动首页截图由浏览器用例生成于 `docs/screenshots/`。CI 另执行 `astro check`、Prettier、正式构建及 `wrangler deploy --dry-run`。浏览器用例验证内容/可见状态，不以 HTTP 状态码单独作为功能验收。
