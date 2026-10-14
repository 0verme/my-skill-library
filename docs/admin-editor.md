# 可视化编辑器、草稿与来源保护

## 能力边界

Phase 3 在受 Access 保护的后台提供 `/admin/editor`：编辑已发布条目的名称、中文简介、类型、状态、分类、标签、支持工具、完整 Prompt、安装命令、封面、精选标记与画廊顺序。编辑器只生成并维护**浏览器本地草稿**：不写入仓库、不创建分支或 PR、不发布内容、不下载媒体、不调用 GitHub 写入 API。发布流程仍留给 Phase 4，页面会明确标注。

所有后台数据请求继续走 Phase 1 的 Worker 鉴权边界：页面 HTML 由 `run_worker_first` 交给 Worker 验证 Access JWT；目录数据通过 `GET /api/admin/editor/catalog` 读取；重新导入复用 Phase 2 的只读 `POST /api/admin/import/preview`（same-origin、`Idempotency-Key`、64 KiB）。本阶段没有新增写端点。

`GET /api/admin/editor/catalog` 由 Worker 读取构建期生成的 `/editor-catalog.json`（仅包含已完成发布、已公开渲染的字段），响应 `no-store`，失败返回 `503 editor_catalog_unavailable`。目录资产带 `X-Robots-Tag: noindex`、在 `robots.txt` 中禁止抓取并从 sitemap 排除；即使被公开读取也不包含任何凭据或未发布内容。

## 浏览器草稿

- 草稿存放于 `localStorage`，键为 `msl-editor-draft-v1:<slug>`；保存前会拒绝包含 `token`、`password`、`secret`、`authorization`、`credential` 等疑似凭据字段的对象，并限制为 512 KiB。
- 服务器不保存草稿；清除浏览器站点数据即删除草稿。草稿恢复只在同一浏览器会话中可用，不跨设备同步。
- 选择已发布条目时若检测到同 slug 草稿，会有显式“恢复草稿/丢弃草稿”选择，不会自动覆盖已发布内容。
- 每次输入会自动保存到浏览器；`保存草稿` 按钮提供显式反馈；`重置为已发布内容` 恢复发布基线并清除本地 override。

## 字段来源与 override

- 字段来源有三态：`manual`（草稿中显式修改的 override）、`published`（已发布基线）、`default`（新草稿默认值），保存在草稿的 `overrides` 中，路径支持 `gallery.0.alt` 等子字段。
- 手工修改的 override 优先于上游重新抓取：重新导入不会静默覆盖任何本地修改。
- 来源身份按大小写不敏感的 `repo + path` 匹配。匹配到已发布条目时保留原 slug，只更新原条目，不创建重复卡片；未匹配时才生成新草稿。
- slug 在已发布条目上保持只读稳定；新草稿可以设置安全 slug（小写字母、数字、连字符）。

## 上游更新与逐字段冲突

点击“重新导入来源”会通过只读预览 API 拉取当前上游候选，并与草稿/基线做字段级 diff：

- 本地未修改、上游已变化的字段默认“采用上游”，应用后写入新基线；
- 本地已修改且上游也变化、值不同的字段标记为冲突，必须逐字段选择“保留本地”或“采用上游”，全部冲突解决前“应用所选字段”按钮保持禁用；
- 本地保留的字段继续标记为 `manual` override，基线不前进，确保下次重新导入仍能看到未解决的上游差异；
- 许可状态/许可证变化始终作为需要显式确认的字段显示；
- 应用只更新当前草稿的本地状态并写入浏览器草稿，不发送写入请求。

## 预览

- 预览分为首页卡片、详情页与移动端三种视图，复用公开页面的类名、结构与纯文本展示语义；Playwright 会与构建后的公开 HTML 做结构 parity 断言。
- 预览只使用 DOM `textContent` 渲染，不执行或渲染上游 Markdown/HTML，不加载外部脚本。
- 移动端视图在 390px 宽的设备框内展示卡片预览；详情预览禁止渲染 Prompt/媒体的可执行内容。

## 发布前校验

`validateEditorDraft` 与内容 Zod Schema 对齐：名称、简介长度、分类、Prompt 必填、媒体地址（站内 `/skills/` 或免凭据 HTTPS）、画廊替代文本与前后对比配对、slug 与来源 SHA 格式、来源归属；发布就绪校验还要求许可状态为 `original`、`redistributable` 或 `not-applicable`。未知/限制许可只能保存 metadata-only 草稿，无法通过发布校验。

校验结果只提示本地草稿状态；Phase 3 不提供发布按钮，也不会绕过许可与安全门槛。

## 与导入页的交接

导入预览中勾选候选后可“在编辑器中打开”：候选（不含 Markdown 正文）暂存于 `localStorage` 的交接键并跳转到编辑器；编辑器按 `repo + path` 匹配已发布条目，保留原 slug 并展示字段级上游差异。交接数据同样不含凭据，使用后会从浏览器移除。

## 自动化与真实环境限制

`npm run test:editor` 覆盖草稿序列化/凭据拒绝/大小上限、发布前校验、provenance 优先级、冲突显式解决、稳定 slug 与去重、快照哈希、画廊操作与重置。`npm run test:worker` 覆盖编辑器目录 API 的 Access、fail-closed 与非 GET 拒绝；Playwright 覆盖条目录入、草稿恢复、校验、预览视口结构 parity、上游冲突选择、导入交接与后台整体 fail-closed。

真实 Cloudflare Access 身份仍未配置或验证；生产后台按设计 fail closed。编辑器草稿与目录读写都不代表真实发布链路已验证。
