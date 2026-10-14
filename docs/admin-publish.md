# 发布管线、受控自动合并与上线状态

## 能力与边界

Phase 4 为 `/admin/editor` 增加发布能力：管理员明确确认后，由 Worker 服务端通过 GitHub App 最小权限创建/更新 `content/<slug>` 分支与中文 PR，展示 `PR → 必需 CI → 受控合并 → Cloudflare 部署 → 上线/失败` 的每一步状态与可跳转链接。所有发布请求都先经过 Phase 1 的 Access 鉴权、same-origin、`Idempotency-Key` 与请求体大小限制。

发布管线不会：执行或复制上游 Skill 正文/媒体、绕过许可门槛、直接向 `main` 写入、在 PR 上触发生产部署、把“PR 创建成功”报告为“已上线”。合并后由既有 `main` CI 的 Cloudflare Deploy 步骤上线，状态接口读取该步骤的结论后才显示“已上线”。

## 端点

| 端点                             | 用途                         | 安全                                                                         |
| -------------------------------- | ---------------------------- | ---------------------------------------------------------------------------- |
| `POST /api/admin/publish`        | 校验后创建/更新分支与 PR     | Access + same-origin + 幂等键 + 256 KiB + 每批最多 8 条 + 每草稿 32 KiB 正文 |
| `POST /api/admin/publish/status` | 只读返回 PR/检查/部署阶段    | Access + same-origin + 幂等键 + slug 白名单                                  |
| `POST /api/admin/publish/merge`  | 服务端重新验证后执行受控合并 | Access + same-origin + 幂等键 + `confirmAutoMerge: true`                     |

所有写入都由服务端 GitHub App 完成；浏览器、静态资源与日志中都不出现 App 私钥或 installation token。响应错误使用固定代码，不包含上游响应体或凭据。

## 幂等与恢复

幂等以 GitHub 为事实源，而不是 isolate 内存 registry：

- 分支名固定为 `content/<slug>`，同一草稿重复发布只会更新该分支与原 PR；
- 先读取分支、目标文件与对应 head 的 PR；文件内容哈希相同且 PR 仍 open 时返回 `noop`，不产生空提交；
- 内容生成使用草稿的 `updatedAt`，未修改的草稿重复发布会得到完全相同的 Markdown 与 `noop`；
- GitHub 409/422 分支或 PR 冲突映射为 `publish_pr_conflict`，前端提示刷新后重试；
- 429 与 502/503 返回可重试错误并带 `Retry-After`；请求失败时不留下本地半状态；
- 合并已 merged 的 PR 视为幂等成功；`publish_merge_blocked` 与检查失败会保持 PR open 并列出阻止原因。

## 受控自动合并门槛

`POST /api/admin/publish/merge` 必须同时满足：

1. 请求显式携带 `confirmAutoMerge: true`；
2. 草稿重新通过发布前校验（名称/简介/正文大小、媒体安全、来源归属、slug 与 SHA 格式）；
3. 许可状态为 `original`、`redistributable` 或 `not-applicable`；未知/限制许可直接阻止；
4. 对应 PR 处于 open、`mergeable === true`（无冲突且 GitHub 已计算完成）；
5. 该 PR head 的必需 CI 全部成功：检查 `check-runs` 与 `actions/runs`，任一失败、pending 或缺失都阻止；
6. 合并方式固定为 squash，不允许更新 `main` 之外的基线或强推。

任一条件不满足时返回 `action: "blocked"` 与原因列表，绝不自动合并。服务端不读取或依赖仓库 Branch Protection 的隐藏配置；生产启用前应在 GitHub 为 `main` 配置必需的 PR/检查规则，作为第二道防线（见 SOP）。

## 状态机

`planned → pr_created → checks_running → checks_passed / checks_failed / merge_conflict → merged → deploying → deployed / deploy_failed`；`blocked`/`failed` 表示前置条件阻止或 GitHub 不可用。状态接口只在读取到 `main` CI 的 `Deploy Cloudflare Worker` 步骤成功后标记 `deployed`，并把 Actions 链接返回给管理员。

## 校验与内容生成

- 发布前重新执行与编辑器一致的 schema/媒体/许可校验，服务端不信任浏览器结论；
- Markdown 由 `yaml` 安全序列化 frontmatter：名称、简介、类型、分类、标签、支持工具、Prompt、安装命令、封面、画廊、正文、来源身份、许可状态、`importedSnapshotHash`、`createdAt`/`updatedAt`；
- 来源声明按草稿来源身份原样写入，手工修改不会丢弃或伪造 upstream 信息；
- 已有条目的正文在编辑器未修改时保留，修改后以编辑器内容为准；
- 发布内容超过 128 KiB Markdown 上限时拒绝。

## 真实配置 SOP（Phase 4 生产启用前）

1. GitHub App 只安装到 `0verme/my-skill-library`；权限最小化为 `Contents: Read and write`、`Pull requests: Read and write`、`Checks: Read-only`、`Actions: Read-only`。把 App ID、Installation ID 与私钥作为 Cloudflare Worker Secrets 配置，禁止写入仓库、日志或浏览器。
2. 在 GitHub 为 `main` 配置 Branch Protection / Ruleset：要求 PR、要求必需状态检查（CI）、禁止 force push。
3. 如启用自动合并，优先使用 GitHub 原生 Auto-merge 或本管线的显式 `confirmAutoMerge`；不得绕过失败检查或冲突。
4. 轮换私钥时先更新 Worker Secret，再撤销旧私钥并验证发布管线 fail closed 行为。
5. 首次真实发布前，用一条非生产 slug 验证 PR 创建、CI、合并、部署与状态刷新；失败时保持 PR open 并记录原因。

## 自动化与限制

`npm run test:publish` 覆盖发布请求校验、Markdown/YAML 生成与来源保留、幂等计划、受控合并门槛、状态机、GitHub client 的分页/错误/部署步骤解析与凭据不泄露。`npm run test:worker` 覆盖发布端点的 Access、same-origin、幂等、许可阻止、合并门槛、限流映射与未配置 fail closed。Playwright 覆盖编辑器发布面板的 PR/检查/合并/上线步骤与阻止状态。

**当前环境限制：** 仓库与 Cloudflare 中尚无真实 GitHub App 凭据或真实 Access 身份配置，因此本阶段只完成 Mock/fixture 验证与 SOP，不声称真实 PR、真实自动合并或真实部署已通过。Phase 4 结束时 Issue #5 是否关闭，取决于后续是否完成站内全链路真实验证；在此之前保持 OPEN。
