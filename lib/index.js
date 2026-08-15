// dsh-plugin-toggle — 第三方插件开关（Host 半端）
//
// 客户端通道：自定义 Web 路由（真实插件标准做法，与 dsh-better-sidebar 同款协议）
//   POST /plugin-toggle/api/<method>  →  { ok: true, value } | { ok: false, error: { code, message } }
//   methods: list（各 profile 的可管理第三方插件行）、set-enabled（改写补丁）
//
// 生效机制：改写各 profile 的 cordis.patch.yml（disabled 标记），DSH 的
// watchUserPatches 热重载该文件，立即生效；列表状态直接读补丁文件，单一事实源。
import { readFile, writeFile, stat, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const SAFE_ID = /^[A-Za-z0-9@._/-]+$/
const SAFE_PROFILE = /^[A-Za-z0-9._-]+$/
const API_PREFIX = '/plugin-toggle/api/'
const winCmdShim = process.platform === 'win32'

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

async function safeRead(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

async function safeReadJson(path) {
  const text = await safeRead(path)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function safeStatFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 提取 patch 文本里 insert 块插入的行 id（bundle 补丁或用户补丁）。 */
function insertedIds(patchText) {
  const ids = []
  const blockRe = /- insert:\s*\n((?:[ \t]+-[^\n]*\n?)*)/g
  let m
  while ((m = blockRe.exec(patchText))) {
    const block = m[1]
    const idRe = /[ \t]*- id:\s*([^\s#]+)/g
    let im
    while ((im = idRe.exec(block))) ids.push(im[1].replace(/^['"]|['"]$/g, ''))
  }
  if (!ids.length) {
    const anyRe = /[ \t]*- id:\s*([^\s#]+)/g
    let am
    while ((am = anyRe.exec(patchText))) ids.push(am[1].replace(/^['"]|['"]$/g, ''))
  }
  return [...new Set(ids)]
}

/** 用户补丁中是否存在 `- id: <id>` + `disabled: true` 条目。 */
function disabledInPatch(patchText, id) {
  const re = new RegExp('^[ \\t]*- id:[ \\t]*' + escapeRegExp(id) + '[ \\t]*\\n[ \\t]*disabled:[ \\t]*true', 'm')
  return re.test(patchText)
}

function trivialArray(text) {
  const stripped = text.replace(/^\s*#.*$/gm, '').trim()
  return stripped === '[]' || stripped === ''
}

function addDisable(text, id) {
  const entry = '- id: ' + id + '\n  disabled: true'
  // 空数组（[]）或仅注释 → 输出裸列表条目。
  if (trivialArray(text)) return entry + '\n'
  // 顶层是方括号数组（...]）→ 在收尾 ] 之前插入。
  const trimmed = text.replace(/\s+$/, '')
  if (trimmed.endsWith(']')) {
    const head = trimmed.slice(0, -1)
    return head + (head.trimEnd().endsWith('[') ? '' : '\n') + entry + '\n]\n'
  }
  // 顶层是裸列表（- item 行，无方括号）→ 直接追加。
  return trimmed + '\n' + entry + '\n'
}

function removeDisable(text, id) {
  const re = new RegExp('^[ \\t]*- id:[ \\t]*' + escapeRegExp(id) + '[ \\t]*\\n[ \\t]*disabled:[ \\t]*true\\n?', 'm')
  const out = text.replace(re, '')
  const stripped = out.replace(/^\s*#.*$/gm, '').trim()
  // 空或仅注释的文件会解析成“无”，loader 要求顶层数组，兜底为 []。
  if (stripped === '' || stripped === '[]') return '[]\n'
  return out
}

/** 解析 bundle 在 profile 下的可读目录（profile 内 node_modules 优先，其次扁平 fallback）。 */
async function bundleDir(profileRoot, profileName, bundle) {
  const candidates = [
    join(profileRoot, profileName, 'node_modules', bundle),
    join(profileRoot, 'node_modules', bundle),
  ]
  for (const dir of candidates) {
    if (await safeStatFile(join(dir, 'package.json'))) return dir
  }
  return undefined
}

/** 枚举 DSH_HOME 下各 profile 的可管理第三方插件行（非 @deepseek-ai/ 官方 bundle + 用户补丁插入）。 */
async function listProfiles(home) {
  const root = join(home, 'profiles')
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const profiles = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = join(root, e.name)
    const pkg = await safeReadJson(join(dir, 'package.json'))
    if (!pkg || !pkg.dsh || !pkg.dsh.profile || !Array.isArray(pkg.dsh.profile.bundles)) continue
    const userPatch = await safeRead(join(dir, 'cordis.patch.yml'))
    const rows = []
    for (const bundle of pkg.dsh.profile.bundles) {
      if (typeof bundle !== 'string' || bundle.startsWith('@deepseek-ai/')) continue
      const bdir = await bundleDir(root, e.name, bundle)
      const bpkg = bdir ? await safeReadJson(join(bdir, 'package.json')) : undefined
      const patch = bdir ? await safeRead(join(bdir, 'cordis.patch.yml')) : undefined
      const ids = patch ? insertedIds(patch) : []
      if (!ids.length) ids.push(bundle)
      for (const id of ids) {
        rows.push({
          id,
          name: bundle,
          bundle,
          version: bpkg && typeof bpkg.version === 'string' ? bpkg.version : undefined,
          description: bpkg && typeof bpkg.description === 'string' ? bpkg.description : undefined,
          source: 'bundle',
          enabled: !(userPatch !== undefined && disabledInPatch(userPatch, id)),
        })
      }
    }
    if (userPatch !== undefined) {
      for (const id of insertedIds(userPatch)) {
        if (rows.some((r) => r.id === id)) continue
        rows.push({ id, name: id, bundle: undefined, version: undefined, description: undefined, source: 'user', enabled: !disabledInPatch(userPatch, id) })
      }
    }
    profiles.push({ name: e.name, rows })
  }
  return profiles
}

/** 在指定 profile 的 cordis.patch.yml 上启用/禁用一行（幂等）。 */
async function setEnabled(home, profile, id, enabled) {
  const patchPath = join(home, 'profiles', profile, 'cordis.patch.yml')
  const text = (await safeRead(patchPath)) ?? '[]'
  const disabled = disabledInPatch(text, id)
  let next = text
  if (enabled && disabled) next = removeDisable(text, id)
  if (!enabled && !disabled) next = addDisable(text, id)
  if (next !== text) await writeFile(patchPath, next, 'utf8')
  return { changed: next !== text }
}

// ---- HTTP 协议辅助（与 dsh-better-sidebar 的 wire 约定一致）----

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (e) {
        const err = new Error('invalid JSON body')
        err.code = 'bad-request'
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function apiError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/** 仅接受同源 POST（浏览器 fetch 同源时会带 Origin；非浏览器无 Origin 放行，回路地址本身就是信任边界）。 */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  if (host === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

// ---- 重启（参考 dsh-market 的成熟实现：重建启动命令 + 分离 helper 延时拉起 + 自杀）----

/** 重建启动本进程的 dsh CLI 调用（全局 bin / 本地安装 / 源码 node --import 均可用）。 */
function dshArgv() {
  const entry = process.argv[1]
  // 放宽入口识别：bin.js/bin.ts/bin.mjs 等、任意 js/ts/mjs/cjs 脚本、或裸 dsh 名。
  // 避免落入下面的 cmd 壳分支（shell:true 会弹控制台窗口并触发 DEP0190）。
  const scriptLike = typeof entry === 'string' && entry !== ''
    && (/[\\/](?:bin\.(?:[cm]?[jt]s)|dsh)$/.test(entry) || /\.(?:[cm]?[jt]s)$/i.test(entry))
  if (scriptLike) {
    // 源码启动（pnpm dsh）传的是相对路径，子进程要按它自己的 cwd 解析；
    // 取绝对路径并把 cwd 锚到 entry 所在目录，保持 execArgv 导入（tsx/esm）可解析。
    const abs = resolve(entry)
    return { file: process.execPath, args: [...process.execArgv, abs], cwd: dirname(abs), viaShell: false }
  }
  // 兜底：裸 `dsh` 在 Windows 是 .cmd shim，只有 shell 能拉起（仅限极端情况）。
  return { file: 'dsh', args: [], cwd: undefined, viaShell: winCmdShim }
}

/**
 * 调度自重启：先派一个分离的 helper（等 1.5s 后以相同命令拉起替代进程，日志写 tmpdir），
 * 再在 500ms 后结束当前进程。helper 脱离我们存活，端口释放后替代进程接管。
 */
function scheduleRestart() {
  const launch = dshArgv()
  const args = [...launch.args, ...process.argv.slice(2)]
  const cwd = launch.cwd ?? process.cwd()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const logOut = join(tmpdir(), `dsh-plugin-toggle-restart-${stamp}.out.log`)
  const logErr = join(tmpdir(), `dsh-plugin-toggle-restart-${stamp}.err.log`)
  const helperCode = [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    `const file = ${JSON.stringify(launch.file)}`,
    `const args = ${JSON.stringify(args)}`,
    `const cwd = ${JSON.stringify(cwd)}`,
    `const viaShell = ${JSON.stringify(launch.viaShell)}`,
    `const logOut = ${JSON.stringify(logOut)}`,
    `const logErr = ${JSON.stringify(logErr)}`,
    'setTimeout(() => {',
    '  try {',
    '    const out = fs.openSync(logOut, "a")',
    '    const err = fs.openSync(logErr, "a")',
    '    // windowsHide: 替代进程以隐藏控制台运行，其子进程（工具命令等）继承该控制台，',
    '    // 不会再各自弹出命令行窗口（此前 detached 无控制台导致每条命令弹窗）。',
    '    const child = spawn(file, args, { cwd, detached: true, windowsHide: true, stdio: ["ignore", out, err], env: process.env, shell: viaShell })',
    '    child.unref()',
    '  } catch {}',
    '}, 1500)',
  ].join('\n')
  const helper = spawn(process.execPath, ['-e', helperCode], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: process.env,
  })
  helper.unref()
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500)
  return { pid: process.pid, helperPid: helper.pid, logOut, logErr }
}

/** 重启类请求的信任门槛：仅本机回路 + 无转发头 + 同源。 */
function trustedRestartRequest(req) {
  const address = req.socket && req.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  if (req.headers.forwarded !== undefined || req.headers['x-forwarded-for'] !== undefined || req.headers['x-real-ip'] !== undefined) return false
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

/** 构建路由分发表：methods 由插件自己拥有，与任何内置 RPC/设置白名单无关。 */
function buildApi() {
  return {
    list: async () => {
      const home = dshHome()
      const profiles = await listProfiles(home)
      return { home, profiles }
    },
    'set-enabled': async (payload) => {
      const p = (payload && typeof payload === 'object') ? payload : {}
      const profile = String(p.profile ?? '')
      const id = String(p.id ?? '')
      const enabled = !!p.enabled
      if (!SAFE_PROFILE.test(profile)) throw apiError('bad-request', '非法的 profile 名: ' + profile)
      if (!SAFE_ID.test(id)) throw apiError('bad-request', '非法的插件行 id: ' + id)
      const home = dshHome()
      const profiles = await listProfiles(home)
      const found = profiles.find((x) => x.name === profile)
      if (!found) throw apiError('not-found', '找不到 profile: ' + profile)
      if (!found.rows.some((r) => r.id === id)) throw apiError('not-found', '该 profile 下没有可管理的插件行: ' + id)
      const { changed } = await setEnabled(home, profile, id, enabled)
      return {
        changed,
        profile,
        id,
        enabled,
        message: enabled ? '已启用，DSH 热重载后立即生效' : '已禁用，DSH 热重载后立即生效',
      }
    },
    restart: async (_payload, req) => {
      if (!trustedRestartRequest(req)) throw apiError('forbidden', '仅允许本机同源请求触发重启')
      const info = scheduleRestart()
      return {
        message: '正在重启 DSH，页面将短暂断开，请稍后刷新',
        ...info,
      }
    },
    stop: async (_payload, req) => {
      if (!trustedRestartRequest(req)) throw apiError('forbidden', '仅允许本机同源请求触发关闭')
      // 先让响应发出，再终止进程（不重启，由用户手动启动）。
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 300)
      return {
        message: 'DSH 正在关闭，进程终止后请手动启动',
      }
    },
  }
}

const inject = ['webServer']

function apply(ctx) {
  // webServer 是硬依赖：声明 inject 让本行等待路由服务就绪后再激活，
  // 否则启动竞态下 webServer 尚未提供，apply 会静默跳过、路由永不注册。
  const webServer = ctx.webServer

  const api = buildApi()

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/plugin-toggle/api',
    handler: async (req, res) => {
      if (!sameOrigin(req)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : undefined
      if (method === undefined || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown plugin-toggle API method' } })
        return
      }
      try {
        const payload = await readJsonBody(req)
        const handler = api[method]
        if (handler === undefined) {
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown plugin-toggle API method "' + method + '"' } })
          return
        }
        writeJson(res, 200, { ok: true, value: await handler(payload, req) })
      } catch (error) {
        const code = (error && error.code) || 'internal'
        const message = error instanceof Error ? error.message : String(error)
        const status = code === 'bad-request' ? 400 : (code === 'not-found' ? 404 : 500)
        writeJson(res, status, { ok: false, error: { code, message } })
      }
    },
  }))
}

// 注意：不要加 `export default`——loader 的 unwrapExports 优先取 .default 当插件，
// 那样命名导出的 inject 会丢失（guard 报 cannot get property without inject）。
// 与 dsh-better-sidebar 一致，用命名导出把模块命名空间本身作为插件（{ apply, inject }）。
export { apply, inject }
