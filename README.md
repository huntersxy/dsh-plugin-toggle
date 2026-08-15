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
- **进程控制**：页签底部提供两段式确认的「重启 DSH」与「关闭 DSH」按钮——重启以原启动命令重新拉起进程（加载插件/配置变更）；关闭仅终止进程、不自动重启。重启日志落在系统临时目录（`dsh-plugin-toggle-restart-*.log`）。

## 工作原理

- **Host**：注册自定义 Web 路由 `POST /plugin-toggle/api/<method>`（`list` / `set-enabled` / `restart` / `stop`），读取各 profile 的 bundle 栈与补丁文件，改写补丁。路由仅接受本机回路 + 同源请求，重启/关闭端点另有转发头校验。
- **Client**：`__ModuleLoader__` bundle，注册到 `settings.plugins.tab`（页签 id `third-party`）。
- 为什么不用内置 settings RPC：DSH 的 api-proxy 对第三方 settings 命名空间有写死的暴露白名单（`WEB_SETTINGS_NAMESPACES`），第三方插件无法通过该通道写入，因此本插件采用与 `dsh-better-sidebar` 一致的自定义路由通道。

## 局限

- 列表来自 profile 补丁文件的静态解析：只管理 bundle 栈中非 `@deepseek-ai/*` 的 bundle 行与用户补丁插入的行；`include:` 运行时前缀会自动归一化。
- 修改 bundle 栈（安装/卸载插件）需要重启生效，可用页签里的重启按钮完成。

## 发布（CI）

打 `v*` 标签自动发布到 npm（GitHub Actions，凭据为仓库 Secret `NPM_TOKEN`）：

```bash
# bump package.json 版本号并提交后：
git tag v0.1.1
git push origin v0.1.1
```

### NPM_TOKEN 的获取与轮换

npm 已于 2025 年起取消"永不过期"的 token（[官方变更说明](https://github.blog/changelog/2025-09-29-strengthening-npm-security-important-changes-to-authentication-and-token-management/)），最长约 1 年。做法：

1. https://www.npmjs.com/settings/huntersxy/tokens 创建 token，选**最长期限**（约 1 年）：
   - classic 类型选 **Automation**，或 granular 类型勾选 **Bypass 2FA**（否则 CI 发布会 403）；
2. 仓库 Settings → Secrets and variables → Actions → New repository secret，Name 填 `NPM_TOKEN`，粘贴 token；
3. **每年到期前轮换一次**：新建 token → 更新同名 secret，全程 1 分钟。GitHub secret 本身不设期限，过期的只是其中的 token 值。

## License

MIT
