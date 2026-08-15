# AGENTS.md — dsh-plugin-toggle

DSH 第三方插件开关：在设置页（设置 → 插件 → 「第三方插件」页签）列出各 profile 的非官方插件行并提供启用/禁用，页签底部另有 DSH 重启按钮。开关通过改写 profile 的 `cordis.patch.yml`（`disabled: true`）实现，DSH 热重载立即生效、重启后保持。

## 包结构

| 文件 | 角色 |
|---|---|
| `package.json` | bundle 清单：`dsh.bundle.patch` + `dsh.client`（web）；无运行时依赖 |
| `cordis.patch.yml` | bundle 补丁：插入行 `id: plugin-toggle` / `name: dsh-plugin-toggle` |
| `lib/index.js` | Host 半端（纯 ESM，无构建步骤） |
| `lib/client.js` | Client 半端（手写 `window.__ModuleLoader__.load` bundle，无构建步骤） |
| `README.md` / `LICENSE` | 使用文档 / MIT |

## 架构

### Host（lib/index.js）

- 插件导出：**命名导出** `export { apply, inject }`，`inject = ['webServer']`（硬依赖，见陷阱 1/2）。
- 通过 `ctx.webServer.register({ kind: 'prefix', path: '/plugin-toggle/api', handler })` 挂自定义路由。
- API：`POST /plugin-toggle/api/<method>`，响应统一 `{ ok: true, value }` 或 `{ ok: false, error: { code, message } }`。
  - `list`：枚举 `DSH_HOME/profiles/*`，返回每个 profile 的可管理第三方行 —— bundle 栈中**非 `@deepseek-ai/*`** 的 bundle（从该 bundle 的 `cordis.patch.yml` 的 insert 块解析行 id，并读其 package.json 拿版本/描述）+ 用户补丁插入的行。字段：`id`（patch 行 id）/`name`/`version`/`description`/`source`（bundle|user）/`enabled`（用户补丁中有无该行的 `disabled: true`）。
  - `set-enabled`：校验 profile/id 白名单后改写对应 profile 的 `cordis.patch.yml` —— 禁用 = 追加 `- id: <行id>` + `disabled: true`；启用 = 移除该条目。幂等。
  - `restart`：信任门槛（回路地址 + 同源 Origin + 无转发头）通过后调度自重启。
- 写补丁用 `node:fs` 直写（不经 ctx.fs / 沙盒）；`watchUserPatches` 监视补丁文件并热重载，立即生效。

### Client（lib/client.js）

- 手写 ModuleLoader bundle：`window.__ModuleLoader__.load({ id: "dsh-plugin-toggle", factory })`，factory 返回 `{ apply, inject }`。
- `inject = ['slots']`；`slots.inject('settings.plugins.tab', ...)` 注册页签 `id: 'third-party'`（order 20）。
- 组件用 `React.createElement`（无 JSX、无 import 语句），经 `fetch('/plugin-toggle/api/<method>')` 同源 POST JSON 与 Host 通信。
- 渲染时过滤 `row.id === 'plugin-toggle'`（不能自禁用自己）；`@deepseek-ai/*` 官方行由 Host 列表直接排除，无需客户端再滤。列表返回的是 patch 行 id（无 `include:` 运行时前缀问题）。

## 陷阱（改动前必读）

1. **绝不要加 `export default`**。loader 的 `unwrapExports` 优先取 `.default` 当插件，命名导出的 `inject` 会丢失 → 启动报 `cannot get property "webServer" without inject`，整棵插件树加载失败。必须用命名导出（模块命名空间即插件），与 dsh-better-sidebar 一致。
2. **`inject: ['webServer']` 是必需的**。若用 `ctx.get('webServer')` + 静默 return，启动竞态下 webServer 尚未就绪会静默跳过，路由永不注册（行看起来正常、客户端正常，但接口 404）。
3. **补丁文件三种形态都要支持**：`[]`（空数组）、多行方括号数组（`[...]`）、裸列表（`- item` 行，无方括号）。`addDisable` 按"文件是否以顶层 `]` 结尾"决定"插到 `]` 前"还是"直接追加"；`removeDisable` 归零后兜底写 `[]\n`（空/仅注释文件解析为"无"，loader 要求顶层数组）。**历史上曾因在裸列表后追加孤立 `]` 写坏补丁导致 boot 崩溃**。
4. **settings wire 对第三方封闭**：api-proxy 的 `WEB_SETTINGS_NAMESPACES` 是写死的暴露白名单，第三方 settings 命名空间经 `api.settings.mutate` 必被拒（`settings-not-exposed`）。本插件因此走自定义 Web 路由通道，**不要改成 settings 通道**。
5. **client bundle 的 load id 必须等于包名**（boot graph 条目 id 即包名），否则 loader 匹配不上（`bundle loaded without registering "<id>"`）。
6. **重启机制**（`scheduleRestart`）：`dshArgv()` 重建启动命令（`process.argv[1]` 命中脚本形态（`bin.(js|ts|mjs|cjs)` 或任意 `js/ts/mjs/cjs`）时用 execPath+绝对入口、cwd 锚到入口目录以保持 tsx/esm 解析；兜底裸 `dsh` via shell 仅限极端情况）→ 派分离 helper 等 1.5s 以相同命令拉起替代进程（日志 `%TEMP%/dsh-plugin-toggle-restart-*.log`）→ 500ms 后 `process.kill(process.pid, 'SIGTERM')`。`restart` 处理器必须先返回响应再自杀。
   - **Windows 弹窗教训**：替代进程与 helper 都必须 `windowsHide: true`（CREATE_NO_WINDOW → 隐藏控制台）。否则服务器无控制台，其子进程（沙盒 spawner 用 0 创建标志、"共享宿主控制台"）会各自新建控制台窗口——表现为"每条工具命令弹一个命令行窗口"。曾因 `dshArgv` 落入 `cmd /c dsh` 兜底分支（`shell: true` + detached）触发此问题，err 日志留下 DEP0190 警告。
7. **信任校验**：路由级 `sameOrigin`；`restart` 额外要求 `req.socket.remoteAddress` 为回路地址且无 `forwarded`/`x-forwarded-for`/`x-real-ip`。

## 测试

当前测试脚本在工作区（`E:\workspace`），未随包分发：

- `pm-patch-logic-test.js`：补丁文本变换纯逻辑（三种形态、禁用/启用往返、无孤立 `]`）。
- `pm-real-e2e.mjs`：客户端 bundle 注册形状 + 用假 ctx/req 驱动真实 Host 代码，对**真实 DSH_HOME** 跑 list / set-enabled 往返 / restart 信任门槛。
  - ⚠️ 有真实副作用：会改写 `profiles/web/cordis.patch.yml`（结束时保持 better-sidebar 禁用）。
  - ⚠️ 不要在 e2e 里调 restart 快乐路径（会调度真重启并杀掉测试进程）；只测拒绝路径。
- 便携版应把 DSH_HOME 指到临时目录再跑。

改动后的同步与生效：

- 同步到已安装副本 `profiles/web/node_modules/dsh-plugin-toggle/`（宿主/清单变更），再重启（页签里的重启按钮即可）；仅 client bundle 变更只需刷新页面（rev 只是缓存破坏符，路由按当前文件下发）。

## 发布

- **CI 发布（首选，Trusted Publishing/OIDC）**：`.github/workflows/npm-publish.yml`，打 `v*` 标签自动 `npm publish --provenance`。流程：bump `package.json` 版本 → 提交 → `git tag vX.Y.Z` → `git push origin vX.Y.Z`。工作流校验 tag 版本与 package.json 一致；凭据走 npm Trusted Publishing（OIDC 短期凭证），**仓库里没有任何 token**。
- 首次配置（npm 侧一次性）：npmjs.com 包页 → Settings → Trusted Publishing → Connect a publisher → GitHub Actions → `huntersxy/dsh-plugin-toggle`，工作流 `publish-npm.yml`。未配置前 CI 发布会因未授权而失败。
- 手动发布（CI 不可用时的备选）：`npm publish`。
  - ⚠️ 用户级 `.npmrc` 里 `npm login` 留下的旧 token 会遮蔽 `NODE_AUTH_TOKEN` —— 用项目级 `.npmrc` 指定 bypass-2FA token 发布，发完删除该文件（参见历史：曾因此卡在 403）。
- 安装：`dsh plugin --profile web add dsh-plugin-toggle`。
- GitHub：huntersxy/dsh-plugin-toggle（本仓库）。
