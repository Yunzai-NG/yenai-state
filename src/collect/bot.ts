/**
 * 模块职责：账号自身的状态 —— 头像、在线状态、好友/群计数、各账号的适配器状态
 * 依赖方向：内核的 `ctx.app.accounts` / `ctx.app.bots`（由调用方取好后传入）、同目录的 format
 * 生命周期：纯函数
 * 注意事项：**好友数与群数走 Bot 的接口，不读全局 Map。** 源插件读的是 TRSS-Yunzai 挂在
 *          `Bot.fl` / `Bot.gl` 上的 Map；新内核把这些收进了 `BotApi.getFriendList()` /
 *          `getGroupList()`，是**异步**的，且一个刚启动还没连上的账号根本调不了。
 *          故此处把「取不到」与「0」区分开：取不到时那一项不出现，0 才显示 0 ——
 *          显示「0 个好友」会让人以为号被清了。
 *
 *          **这两次调用是可以不发生的。** 群列表在有些适配器上要遍历全部分组、几百毫秒
 *          才回来，而状态图是同步渲染的。故它们受 `showCounts` 开关控制，且默认只在
 *          「状态pro」里开启 —— 与进程表同一个理由。
 *
 *          **头像走 `ctx.http` 下载后转成 `data:` URL。** 源插件把网络头像地址直接写进
 *          HTML，由 Chromium 去取 —— 那意味着渲染进程里多一次外部请求，取不到时图上是
 *          一块空白，且渲染要等它。改成先在 Node 侧取回并内联：取不到就用本地那张
 *          `default_avatar.jpg`，渲染时间可控。这是本插件唯一一处把二进制内联进模板的地方。
 */

import type { HttpClient } from "@yunzai-ng/types"
import { getFileSize, formatDuration } from "../util/format.js"

/** 账号板块在模板里所需的数据 */
export interface BotView {
  /** 账号昵称 */
  readonly nickname: string
  /** 账号号码 */
  readonly uin: string
  /** 头像的 `data:` URL，或本地默认头像的 `file://` 地址 */
  readonly avatar: string
  /** 在线状态文案 */
  readonly status: string
  /** 状态对应的配色 */
  readonly statusColor: string
  /** 好友数；取不到时不出现 */
  readonly friendCount?: number
  /** 群数；取不到时不出现 */
  readonly groupCount?: number
  /** 账号状态自何时起，已格式化 */
  readonly since: string
  /** 已重连次数 */
  readonly retries: number
  /** 机器人这个进程自己占的内存，已格式化 */
  readonly memory: string
  /** 本进程已运行时长，已格式化 */
  readonly uptime: string
}

/** 一个适配器在模板里所需的数据 */
export interface AdapterView {
  /** 适配器名 */
  readonly name: string
  /** 该适配器下的账号数 */
  readonly accounts: number
  /** 在线数 */
  readonly online: number
  /** 状态文案 */
  readonly status: string
  /** 状态配色 */
  readonly statusColor: string
}

/** 采账号信息所需的外部输入 */
export interface BotInput {
  /** 账号昵称；内核未取到时为空串 */
  readonly nickname: string
  /** 平台账号 id */
  readonly selfId: string
  /** 账号状态，取自 `AccountState.status` */
  readonly status: string
  /** 进入当前状态的时间戳 */
  readonly since: number
  /** 已重连次数 */
  readonly retries: number
  /** 头像地址；未取到时不下载 */
  readonly avatarUrl?: string
  /** 好友数；不取或取不到时 undefined */
  readonly friendCount?: number
  /** 群数；不取或取不到时 undefined */
  readonly groupCount?: number
  /** 该适配器下的账号数 */
  readonly adapterAccounts: number
  /** 其中在线的几个 */
  readonly adapterOnline: number
  /** 适配器名 */
  readonly adapterName: string
}

/** 账号状态配色；取值域是内核的 `AccountStatus` */
const STATUS_COLORS: Record<string, string> = {
  online: "#25a55f",
  offline: "#8a8a8a",
  connecting: "#f0a020",
  error: "#d03050",
  disabled: "#8a8a8a"
}

/** 账号状态原文到中文的对照 */
const STATUS_TEXT: Record<string, string> = {
  online: "在线",
  offline: "离线",
  connecting: "连接中",
  error: "出错",
  disabled: "已禁用"
}

/**
 * 把状态原文翻译成中文与配色
 *
 * 认不出来的状态原文原样显示、取中性灰 —— 适配器可能给出内核没定义的词
 * （`mute` / `dnd` 之类），此时显示原文比显示「未知」有用。
 * @param status 状态原文
 * @returns 文案与配色
 */
export function translateStatus(status: string | undefined): { text: string; color: string } {
  const key = (status ?? "").toLowerCase()
  return {
    text: STATUS_TEXT[key] ?? (status === undefined || status === "" ? "未知" : status),
    color: STATUS_COLORS[key] ?? "#8a8a8a"
  }
}

/** 各类图片的魔数到 MIME 的对照 */
const MIME_BY_MAGIC: readonly { readonly magic: readonly number[]; readonly mime: string }[] = [
  { magic: [0x89, 0x50, 0x4e, 0x47], mime: "image/png" },
  { magic: [0x47, 0x49, 0x46, 0x38], mime: "image/gif" },
  { magic: [0x52, 0x49, 0x46, 0x46], mime: "image/webp" },
  { magic: [0xff, 0xd8, 0xff], mime: "image/jpeg" }
]

/**
 * 看开头的几个字节猜图片类型
 *
 * 不看响应头里的 `Content-Type`：QQ 的头像接口返回的常常是 `application/octet-stream`，
 * 照抄那个类型写进 `data:` URL 会让 Chromium 拒绝渲染。按内容判断没有这个问题。
 * @param buffer 图片数据
 * @returns MIME 类型
 */
export function sniffImageMime(buffer: Buffer): string {
  for (const item of MIME_BY_MAGIC) {
    if (item.magic.every((byte, index) => buffer[index] === byte)) return item.mime
  }
  return "image/jpeg"
}

/**
 * 把一个本地路径转成 `file://` URL
 *
 * Windows 的盘符要变成 `/D:/...` 三段式，否则 Chromium 会把 `file://D:/x` 里的 `D:` 当成主机名。
 * @param path 绝对路径
 * @returns `file://` URL
 */
export function toFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/")
  const prefix = normalized.startsWith("/") ? "file://" : "file:///"
  // 路径里的空格与中文必须转义，否则 Chromium 解析出来的 URL 是坏的
  return prefix + encodeURI(normalized)
}

/**
 * 取回头像并转成 `data:` URL
 *
 * 失败一律回落到本地那张默认头像 —— **头像取不到不该让整张状态图失败**，而这恰恰是
 * 最常见的情形（机器人所在网络到不了头像服务器）。
 * @param http 内核的 HTTP 客户端
 * @param url 头像地址
 * @param fallback 兜底头像的绝对路径
 * @param warn 告知方式
 * @returns `data:` URL 或兜底的 `file://` 地址
 */
export async function fetchAvatar(
  http: HttpClient,
  url: string | undefined,
  fallback: string,
  warn: (message: string, err: unknown) => void
): Promise<string> {
  const fallbackUrl = toFileUrl(fallback)
  if (url === undefined || url === "") return fallbackUrl

  try {
    const response = await http.request<Buffer>(url, {
      responseType: "buffer",
      timeout: 10_000,
      // 头像地址是平台给的，可能是 http；不因证书问题让整张图失败
      throwOnError: false
    })
    const buffer = Buffer.from(response.data)
    if (buffer.length === 0) return fallbackUrl
    return `data:${sniffImageMime(buffer)};base64,${buffer.toString("base64")}`
  } catch (err) {
    warn("获取头像失败，改用默认头像", err)
    return fallbackUrl
  }
}

/**
 * 采集账号信息
 * @param input 由调用方从内核取好的原始数据
 * @param http 内核的 HTTP 客户端
 * @param avatarFallback 兜底头像的绝对路径
 * @param warn 告知方式
 * @returns 板块数据；其中不含适配器列表（那个由调用方另取，见 `collectAdapters`）
 */
export async function collectBot(
  input: BotInput,
  http: HttpClient,
  avatarFallback: string,
  warn: (message: string, err: unknown) => void
): Promise<BotView> {
  const avatar = await fetchAvatar(http, input.avatarUrl, avatarFallback, warn)
  const status = translateStatus(input.status)
  const mem = process.memoryUsage()

  return {
    nickname: input.nickname === "" ? "未知" : input.nickname,
    uin: input.selfId,
    avatar,
    status: status.text,
    statusColor: status.color,
    // 0 与 undefined 的区别是有意义的：`friendCount: 0` 说明确实一个好友都没有，
    // 而 undefined 说明没去数（省时间）或还没连上、这个数还不知道
    ...(input.friendCount === undefined ? {} : { friendCount: input.friendCount }),
    ...(input.groupCount === undefined ? {} : { groupCount: input.groupCount }),
    since: formatSince(input.since),
    retries: input.retries,
    memory: getFileSize(mem.rss),
    // `process.uptime()` 是**本进程**的运行秒数，与系统运行时长是两回事
    uptime: formatDuration(process.uptime())
  }
}

/**
 * 算「进入当前状态多久了」
 *
 * 显示成「3 小时前进入在线」比一个时间戳有用 —— 排查掉线时看的是「它离线多久了」。
 * @param since 毫秒时间戳
 * @returns 时长文案
 */
export function formatSince(since: number): string {
  if (!Number.isFinite(since) || since <= 0) return "未知"
  const seconds = (Date.now() - since) / 1000
  if (seconds < 60) return "刚刚"
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  return `${Math.floor(seconds / 86400)} 天前`
}

/**
 * 把各适配器的账号数整理成模板要的形状
 *
 * 数据来自 `ctx.app.adapters.list()` 与 `ctx.app.accounts.list()` 两份 —— 按 `adapterId`
 * 归拢即可，不必去问适配器自己「你有几个号」（那要新增接口，而两份列表本来就在手边）。
 * @param adapters 已注册的适配器；元素只需 `id` 与 `name`
 * @param accounts 各账号状态；元素只需 `adapterId` 与 `status`
 * @returns 各适配器一行；一个都没有时为空数组
 */
export function collectAdapters(
  adapters: readonly { readonly id: string; readonly name: string }[],
  accounts: readonly { readonly adapterId: string; readonly status: string }[]
): AdapterView[] {
  const counts = new Map<string, { total: number; online: number }>()
  for (const account of accounts) {
    const found = counts.get(account.adapterId) ?? { total: 0, online: 0 }
    found.total += 1
    if (account.status === "online") found.online += 1
    counts.set(account.adapterId, found)
  }

  return adapters.map(adapter => {
    const found = counts.get(adapter.id) ?? { total: 0, online: 0 }
    // 有号全在线算「在线」，有号但没一个在线算「离线」，一个号都没有算「未配置」——
    // 第三种与前两种是不同的事：那说明这个适配器装了但没配账号
    const status = found.total === 0 ? "未配置" : found.online === found.total ? "在线" : found.online === 0 ? "离线" : "部分在线"
    const color = found.total === 0 ? "#8a8a8a" : found.online === found.total ? "#25a55f" : found.online === 0 ? "#8a8a8a" : "#f0a020"
    return {
      name: adapter.name,
      accounts: found.total,
      online: found.online,
      status,
      statusColor: color
    }
  })
}
