# 管理后台与服务端鉴权

## 保护边界

- `/admin`、`/admin/import` 页面由 Wrangler Worker Static Assets 的 `run_worker_first` 路由先交给 `src/worker.ts`。Worker 在读取静态 HTML 前验证 Cloudflare Access JWT 的 RS256 签名、issuer、audience、有效期和管理员邮箱。
- Worker 同样保护 `workers.dev`、正式域名及其他绑定主机；不以隐藏链接、浏览器状态或 `Cf-Access-Jwt-Assertion` 请求头存在本身作为鉴权。JWT 必须使用 Access 团队 JWKS 验签。
- 未配置 `CF_ACCESS_TEAM_DOMAIN`、`CF_ACCESS_AUD` 或 `ADMIN_EMAILS` 时受保护路由返回 `503 access_not_configured`。JWT 缺失或无效返回 `401`，有效但不在 allowlist 返回 `403`。配置读取失败、JWKS 超时或验签服务不可用都 fail closed。
- `/api/admin/session` 仅返回经过服务端验证的身份。Phase 2 只新增 `/api/admin/import/preview` 的只读 POST：经同源/Origin、`Idempotency-Key` 和 64 KiB JSON 限制后，服务端仅访问固定 `api.github.com` 公共 API；不接收任意站点，不使用 GitHub App Token，不创建分支/PR、不写内容、不发布。Phase 3 新增 `GET /api/admin/editor/catalog`：同样先验证 Access，再读取仅含已发布字段的静态 `/editor-catalog.json`（失败 `503 editor_catalog_unavailable`），响应 `no-store`；`/admin/editor` 的草稿只存在浏览器 `localStorage` 且拒绝凭据字段。Phase 4 新增 `POST /api/admin/publish`、`/api/admin/publish/status`、`/api/admin/publish/merge`：同样先验证 Access/same-origin/幂等键/256 KiB 请求体，再由服务端 GitHub App 最小权限创建/更新 `content/<slug>` 分支与中文 PR；仅当必需 CI 全绿、PR 无冲突且无许可/校验门槛、且显式 `confirmAutoMerge: true` 时才执行受控合并；PR 不触发生产部署。未知/限制许可不会读取或返回上游 Skill 正文；未来其他写入也必须通过持久化幂等、Schema 验证和许可证/安全门槛。API 不开放跨域 CORS。
- `createIdempotencyRegistry` 为未来处理器提供按 identity/scope/key 隔离、SHA-256 请求体匹配、并发 single-flight、响应重放、内容冲突 `409` 与容量 `503` 的 isolate-local 基础。它不跨 Cloudflare isolates、冷启动或并发部署持久化，发布管线不依赖它做跨实例去重：发布以 GitHub 的 `content/<slug>` 分支、PR head 与内容哈希作为幂等事实源。合并与状态读取不跨请求缓存。
- Worker 内存中的按管理员身份限流是每个 isolate 的辅助保护（只读 30 次/分钟、写入 10 次/分钟），不等于全局配额；生产环境还应配置 Cloudflare WAF/Rate Limiting 规则。超限响应含 `Retry-After`。
- 日志仅记录固定事件名、固定错误代码与随机 request ID；不记录 Access JWT、GitHub App 私钥、installation token、请求正文或用户提供的 URL。API 响应设置 `no-store`；受保护 HTML 另设最小化 CSP、`frame-ancestors 'none'`、`X-Frame-Options: DENY` 和 `no-referrer`。

## Access 配置 SOP（需有 Cloudflare 管理员权限）

1. 在 Cloudflare Zero Trust 建立自托管应用，覆盖生产主机与 `workers.dev` 实际 Worker hostname 的 `/admin*`、`/api/admin*`；两个主机都必须使用同等的 Access policy，不能用一个未经保护的备用域名绕过登录。Access 允许策略只授予站长指定 identity/group，并要求 IdP MFA；不要使用全员 allow policy。
2. 在 Worker 环境变量中设置：
   - `CF_ACCESS_TEAM_DOMAIN`：Access JWT 的 issuer 主机（通常为 `team-name.cloudflareaccess.com`）。必须与 JWT 的 `iss` 完全对应且该 issuer 的 `/cdn-cgi/access/certs` 可用；不要仅凭登录页自定义域名或站点域名推断 issuer。
   - `CF_ACCESS_AUD`：该 Access 应用的唯一 AUD tag。
   - `ADMIN_EMAILS`：逗号分隔的规范化管理员邮箱 allowlist。
3. 不要把实际邮箱/AUD/Access 域名或开发身份写进公开前端代码、静态资源、Issue 或提交记录。每个 Preview/Production 环境分别配置，并使用 Access 控制台显示的准确 hostname。

Worker 自身会对 Access JWT 做密码学验证，因此 Access 控制台配置漏失不会让伪造请求头通过；缺少 Worker 变量时后台拒绝访问。配置完成后，分别从 `https://skill.overme.cn/admin`、`workers.dev/admin` 与两个主机的 `/api/admin/session` 验证未登录拒绝、允许 identity 成功、其他用户拒绝。现阶段真实 Access policy/JWT 验证尚未完成，不要将 Mock 结果视为线上鉴权通过。

## GitHub App 与服务端凭据 SOP（Phase 4 发布前配置）

1. 为 `0verme/my-skill-library` 创建专用 GitHub App，只安装到该仓库；installation token 请求也显式限制 `repositories: ["my-skill-library"]`。权限最小化为 `Contents: Read and write`、`Pull requests: Read and write`、`Checks: Read-only`、`Actions: Read-only`。App 创建私钥/安装授权应由仓库管理员在 GitHub 操作，不在 Agent/浏览器中生成或分享。
2. 在 Cloudflare Worker 服务端变量中设置 `GITHUB_APP_ID`、`GITHUB_APP_INSTALLATION_ID`；把 GitHub 下载的私钥作为 Cloudflare Worker Secret `GITHUB_APP_PRIVATE_KEY`。Worker 仅在服务端用该私钥签短期 JWT、换取限制了目标安装与上述权限的短期 installation token；token 不写入 KV/D1、HTML、API 响应或日志。
3. 如私钥工具要求 PKCS#8 PEM，GitHub 提供的 RSA 私钥可在管理员自己的安全终端离线转换后直接粘贴到 Cloudflare Secret 输入框；禁止把私钥放到仓库、Shell history、Agent 对话或此文档。勿使用个人 PAT 或超出上述权限的全仓令牌。
4. 轮换时先在 Cloudflare 更新 Secret，再在 GitHub 撤销旧 App 私钥并验证下一次服务端 App token 请求；不要打印 token 作为验证证据。

示例设置仅在管理员的安全本地终端执行并按提示粘贴私钥（不要把值写入命令参数）：

```sh
npx wrangler secret put GITHUB_APP_PRIVATE_KEY
```

本项目目前没有 Cloudflare Access 凭据或 GitHub App 私钥可用于真实配置。Access 自动化测试使用本地生成的临时 RSA key/Mock JWKS；导入安全测试使用固定 Mock GitHub API fixture。它们仅证明代码逻辑和资源边界，不代表真实 Access 身份集成或 GitHub 实时来源验证已通过。Phase 2 读取公开 GitHub API 不需要 GitHub App；未来写 PR 才需要按 Phase 4 最小权限 SOP 配置 GitHub App。
