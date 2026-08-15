# dsh-plugin-toggle

第三方插件开关 —— 在 DSH Web 设置页里启用/禁用第三方插件。

A settings-page toggle for third-party plugins in DeepSeek Harness Web.

## 安装

```bash
dsh plugin --profile web add dsh-plugin-toggle
```

或本地包：

```bash
dsh plugin --profile web add ./dsh-plugin-toggle-0.1.0.tgz
```

安装后重启 `dsh web`。设置 → 插件 → 「第三方插件」页签即可使用。

## 功能

- **插件开关**：列出每个 profile 中非官方（第三方）插件行（bundle 栈里非 `@deepseek-ai/*` 的 bundle + 用户补丁插入的行），带版本/描述/状态，一键启用/禁用。
- **热重载生效**：开关直接改写 profile 的 `cordis.patch.yml`（`disabled: true` 标记），DSH 监视该文件并热重载，无需重启；状态持久，重启后保持。
- **刷新页面**：页签底部提供「刷新页面」按钮（纯客户端 `location.reload()`），修改插件/配置后刷新 Web 界面。

## 工作原理

- **Host**：注册自定义 Web 路由 `POST /plugin-toggle/api/<method>`（`list` / `set-enabled`），读取各 profile 的 bundle 栈与补丁文件，改写补丁。路由仅接受同源请求。
- **Client**：`__ModuleLoader__` bundle，注册到 `settings.plugins.tab`（页签 id `third-party`）。
- 为什么不用内置 settings RPC：DSH 的 api-proxy 对第三方 settings 命名空间有写死的暴露白名单（`WEB_SETTINGS_NAMESPACES`），第三方插件无法通过该通道写入，因此本插件采用与 `dsh-better-sidebar` 一致的自定义路由通道。

## 局限

- 列表来自 profile 补丁文件的静态解析：只管理 bundle 栈中非 `@deepseek-ai/*` 的 bundle 行与用户补丁插入的行；`include:` 运行时前缀会自动归一化。
- 修改 bundle 栈（安装/卸载插件）需要重启进程生效（页面上的刷新按钮只刷新页面，不重启进程）。

## 发布（CI）

打 `v*` 标签自动发布到 npm（GitHub Actions + **npm Trusted Publishing（OIDC）**，无需任何 token）：

```bash
# bump package.json 版本号并提交后：
git tag v0.1.1
git push origin v0.1.1
```

### 一次性配置（npm 侧，约 1 分钟）

1. 打开 https://www.npmjs.com/package/dsh-plugin-toggle → **Settings** → **Trusted Publishing**；
2. **Connect a publisher** → 选 **GitHub Actions** → 仓库填 `huntersxy/dsh-plugin-toggle`，工作流名填 `publish-npm.yml`（或留空允许任意）；
3. 保存。此后打 `v*` 标签，CI 通过 OIDC 换短期凭证自动发布（带 SLSA provenance 签名），**没有 token 需要存储或轮换**。

参考：npm 官方 [Trusted Publishing 说明](https://github.blog/changelog/2025-09-29-strengthening-npm-security-important-changes-to-authentication-and-token-management/)。

## License

MIT
