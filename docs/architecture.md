# 架构与内容模型

## 静态架构

Astro 以 `output: 'static'` 构建首页、`/skills/<slug>/` 静态详情、404、sitemap 与静态资源。所有条目在构建阶段由 `src/content.config.ts` 的 `glob()` Markdown loader 读取，并通过 Zod Schema 校验；没有 SSR Adapter、运行时 Worker 业务逻辑、API、数据库或登录。

首页与动态详情页共用 Collection 数据。文件名生成稳定的内容 ID/URL slug，`/skills/[slug].astro` 的 `getStaticPaths()` 为每条记录输出一个页面。卡片、分类导航与推荐条目均由内容生成。简单搜索/筛选和复制使用少量原生 TypeScript，不含 UI 框架 hydration。

## 内容模型

| 字段                                           | 用途                                               |
| ---------------------------------------------- | -------------------------------------------------- |
| Markdown 文件名                                | 唯一 slug / 静态详情 URL                           |
| `name`, `description`                          | 卡片、详情标题与 SEO 摘要                          |
| `type`, `category`, `tags`                     | Skill / Prompt / Workflow、筛选和推荐              |
| `cover`, `gallery[]`                           | 可选封面、图片/视频、前后对比、说明和归属          |
| `supportedTools[]`                             | 声明兼容工具；不代表执行或验证                     |
| `prompt`                                       | 唯一结构化 Prompt 来源，用于展示和复制             |
| Markdown 正文                                  | 场景、步骤、注意事项等使用说明，不重复维护 Prompt  |
| `sourceUrl`, `repoUrl`, `skillPath`, `license` | 可选来源仓库、路径与许可溯源                       |
| `installCommand`                               | 可选展示/复制的命令；永不自动执行                  |
| `featured`, `status`                           | 首页精选和 `demo` / `unverified` / `verified` 状态 |
| `createdAt`, `updatedAt`                       | 来源/更新元数据，为未来导入保留                    |

媒体只接受站内 `/skills/` 路径或 HTTPS URL；来源链接只接受 HTTP(S)；仓库路径拒绝绝对路径、反斜杠和 `..` 段。媒体加载失败显示占位。URL Schema 只能校验格式/协议，不能替代内容作者对外部来源、许可和可用性的审核。分类值从当前 Collection 生成，不维护页面级分类清单。

Markdown HTML 经 `rehype-sanitize` 清理，语法块经 Shiki 构建高亮。站点展示而非解释/执行第三方 Skill；导入流程必须继续使用同一 Zod Schema，并补充来源、许可、媒体和资源限制审查。

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

`astro.config.ts` 将站点地址集中设为计划域名 `https://skills.overme.cn`，用于每页 canonical、Open Graph 和 sitemap。`public/robots.txt` 提供 sitemap 地址。该值是未来部署配置，不表示 DNS 已绑定或服务已上线。静态资源使用 `wrangler.jsonc` 的 `assets.directory: './dist'` 与 404 文档回退，开发预览使用 Wrangler，无生产 Worker API。

## 验证

`tests/library.spec.ts` 覆盖首页与四卡片点击、搜索、分类、详情内容/SEO、剪贴板、断图降级、移动视口、404 及首页/详情页 Axe 自动化无障碍审计。桌面和移动首页截图由浏览器用例生成于 `docs/screenshots/`。CI 另执行 `astro check`、Prettier、正式构建及 `wrangler deploy --dry-run`。浏览器用例验证内容/可见状态，不以 HTTP 状态码单独作为功能验收。
