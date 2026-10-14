# GitHub Skill 导入预览安全说明

## 当前能力边界

`POST /api/admin/import/preview` 由 Cloudflare Worker 先验证 Access 身份，再验证 same-origin、`Idempotency-Key`、`application/json` 和 64 KiB 流式请求体上限。接口只接受受限的 `https://github.com/<owner>/<repo>`、`/tree/<ref>/<path>`、`/blob/<ref>/<path>/SKILL.md` URL；后端只访问固定 `https://api.github.com`。不读取浏览器提交的访问令牌、不抓取任意 URL、不写 GitHub、不创建分支/PR、不改动 Markdown、不发布内容。真实 Access 配置缺失仍会 fail closed。

页面里的 Markdown 预览使用 DOM `textContent`/`<pre>`，不是 HTML 渲染，不执行脚本、命令、安装指令或 Agent 提示。禁止让 Agent 或其他自动化把上游 Skill 正文当作系统/开发指令。导入只是待人工审阅的数据，不是可信代码。

`/import-catalog.json` 是构建期从 Content Collection 生成的公开索引，只包含 slug、sourceRepo、sourcePath、sourceSha 和可选 snapshot hash，用于检测相同来源、上游更新及 slug 冲突；不包含私密数据或导入正文。Worker 无法读取该索引时，预览以 `503 import_catalog_unavailable` 失败关闭。

## URL 与路径解析

- 接受仓库 URL（解析其 API `default_branch`）、目录 tree URL，以及只指向 `SKILL.md` 的 blob URL；不假设默认分支叫 `main`。
- tree/blob URL 中 ref/path 边界有歧义时，按候选 ref 调用 GitHub Commit API，并要求 ref 对应的 tree 确实包含指定路径/Skill。最多尝试 12 个 ref 段；含斜杠分支按 API 实际解析，不能仅把 URL 的第一个段硬当 branch。
- 拒绝非 HTTPS、伪装域名、userinfo、端口、查询/片段、非法 percent 编码、编码斜线/反斜线、`.`/`..` 和双重编码。Blob 必须以 `SKILL.md` 结尾。仅公开 GitHub API 可读的仓库可用；私有/不可读来源统一报不可访问，不使用用户 PAT。
- `sourcePath` 是仓库内 `SKILL.md` 文件路径；canonical `sourceUrl` 固定指向解析得到的完整 Git Commit SHA，`sourceRepo`、`sourceAttribution`（仓库归属）、`license`、`licenseStatus` 与 `sourceStatus: unverified` 随候选返回。

## 资源预算与失败语义

| 限制                       |    上限 |
| -------------------------- | ------: |
| 单个 GitHub API 请求超时   |    8 秒 |
| 单次解析总时长             |   30 秒 |
| 单次解析 GitHub API 请求数 |      64 |
| API 单响应 / Git tree      |   2 MiB |
| API 累计响应字节           |   5 MiB |
| Skill 数量                 |      24 |
| 单个 `SKILL.md`            | 128 KiB |
| Skill 目录内许可文件       |  32 KiB |
| YAML frontmatter           |  16 KiB |
| Markdown AST 节点          |  10,000 |
| 路径深度                   |   24 段 |
| 文件读取并发               |       3 |

GitHub 429 或带限流标记的 403 会转为 429，并将有效 `Retry-After`（或 rate-limit reset）传回响应；不自动重试，避免继续消耗配额。超时返回 504。无法完整枚举的截断 tree 会返回可安全确认的部分候选并附警告；无 Skill、超限、失效 frontmatter、危险 Markdown 链接、symlink/submodule、部分文件错误均以固定错误码/警告返回，不把失败伪装成完整成功。限量发现时返回部分结果和警告。

## Frontmatter、Markdown 与不可信输入

- 使用 YAML 1.2 core schema；拒绝 parser error、重复键、alias/anchor、复杂/超深/超量对象、非普通对象、prototype 敏感键及非字符串的 `name`/`description`。不执行 YAML 自定义 tag。
- 只从合法、可再分发许可文件的 Skill 读取 `SKILL.md` 正文。Markdown 通过 `remark-parse` 解析链接与 raw HTML；`javascript:`/其他危险 scheme、未解析相对链接、原始 HTML 等会隐藏正文预览并显示警告。HTTP 链接需人工审核。
- 预览只显示纯文本。外部图片/视频永不下载；媒体许可、HTTPS、MIME/大小及归属必须在后续编辑阶段单独核验，不会因为上游 Markdown 含有媒体 URL 就自动复制或信任。
- GitHub Tree 中的 symlink、submodule、非法路径和过深路径不会被跟随或递归读取。

## 许可策略

- 每个 Skill 独立检查同一目录的 `LICENSE`、`LICENSE.md`、`LICENSE.txt` 或 `COPYING`；不会将仓库 README 或根目录许可自动推定为所有子 Skill 的授权。许可文件超出 32 KiB 时按未知许可处理并显示警告；许可请求发生单项错误时返回该项的部分错误，不丢弃其他安全候选。
- 当前自动允许正文只读预览的明确许可识别白名单：MIT、Apache-2.0、BSD-2-Clause/3-Clause、ISC、0BSD、CC0-1.0。许可文本未知、未识别或超出白名单均不代表授权，按 metadata-only 处理；限制性许可也只返回来源路径/Commit/许可状态及自行撰写简介提示，不读取或返回 Skill 正文/媒体。
- Anthropic `skills/docx` 按 Issue #5 的明确限制视为 proprietary/restricted，即使仓库其他 Skill 采用宽松许可，也不会下载或复制 docx 正文/媒体。`frontend-design`、`skill-creator`、`webapp-testing` 和 `docx` 的自动化用例使用本地 fixture，不等于确认当前上游网络响应或许可文本。对授权不确定时，由站长人工查看上游正式许可并决定；代码不会自行扩大 allowlist。
- 即使白名单许可下的只读 Markdown 预览也不是再发布授权的法律意见；发布前仍需人工逐条审查并确认归属。Phase 2 没有发布操作。

## 重复、更新与 slug

来源身份按大小写不敏感的 repository + 精确 repository-relative `sourcePath` 匹配。相同 source SHA 显示“已收录且版本相同”并禁选；SHA 变化显示“上游已有更新”，要求明确后续确认并标记 `preserveLocalChanges`；不同来源使用同一 slug 时显示 `slug-conflict` 并禁选，绝不覆盖。snapshot hash 仅供后续阶段判断上次生成字段是否改变；没有基线时采取保守策略，不把既有内容当成可安全覆盖。

Phase 2 只预览，不会处理任何更新；后续 CMS/发布阶段必须保留原 slug、来源身份和人工修改，以显式 diff/字段级确认解决冲突，不可用新上游版本静默覆盖。

## 自动化与真实网络验收

`npm run test:import` 以本地 fixture 测试仓库/目录/文件 URL、带斜杠 ref、无 Skill、无效 YAML、重复/更新、slug 冲突、Apache/未知/限制许可、docx 限制、危险链接、路径穿越、symlink、429/Retry-After、timeout、tree 截断和字节/深度/条目上限。测试从不执行或采纳 fixture Skill 内容。

**实时检查记录（2026-10-14）：** 通过本实现的 GitHub API client 对 `frontend-design`、`skill-creator`、`webapp-testing` 三个目录各自解析成功，检测到 per-Skill `Apache-2.0`，只读预览成功；`docx` 返回 `restricted` / `metadata-only`，实现不请求其 `SKILL.md` blob。解析得到的固定 Commit 为 `dbd4588f9e1033efb41dad4bef2f7947c8993d44`。随后对整仓 URL 的实时枚举收到 GitHub `429` secondary rate limit（`Retry-After: 3493`）；实现未自动重试，故**整仓实时枚举尚未验证**，仅由 fixture 覆盖。以上仅验证公开 GitHub API 来源，不代表 Cloudflare Access 真实身份验证通过；后者仍按 `docs/admin-security.md` SOP 单独完成。
