/**
 * 模块职责：网速显示与对外网站连通性测试
 * 依赖方向：内核的 `ctx.http`（经调用方注入）、同目录的 format、monitor 的最近一次采样
 * 生命周期：纯函数
 * 注意事项：**网速取自 monitor 的最近一次采样，不自己采。** `si.networkStats()` 给的是
 *          「自上次调用以来的平均速率」，它内部记着上一次的累计量 —— 若状态图自己再调一次，
 *          两次调用会互相把对方的基线冲掉，于是两处显示的两个数都不对（典型的症状是速率
 *          忽大忽小、除以二的倍数）。monitor 已经在按固定间隔采，状态图读它的结果即可。
 *
 *          **连通性测试的原始实现在并发控制上有个不易察觉的错。** 源插件递归地
 *          `_request()`，每个请求完成时启动下一个，看似是个滑动窗口，但它在 `nextIndex`
 *          已耗尽时直接 `return` 而不推进计数器；若某个请求静默失败（其 `catch` 分支里
 *          的 `error.message` 访问本身可能抛），`finishCount` 就永远到不了总数，
 *          **整个 Promise 永不 resolve，状态图因而永远不出现**。此处用一个明确的任务队列，
 *          每个任务的成败都必然推进一次计数。
 */

import type { HttpClient } from "@yunzai-ng/types"
import { getFileSize } from "../util/format.js"
import type { FileSizeParts } from "../util/format.js"

/** 一条网速数据在模板里所需的数据 */
export interface NetworkView {
  /** 实时速率，数值与单位分开（模板里单位要带 `/s`） */
  readonly speed: {
    readonly download: FileSizeParts
    readonly upload: FileSizeParts
  }
  /** 累计流量；累计量为 0 或取不到时不出现 */
  readonly traffic?: {
    readonly download: FileSizeParts
    readonly upload: FileSizeParts
  }
}

/** 网站测试的一条结果 */
export interface SiteResult {
  /** 显示名 */
  readonly name: string
  /** 状态码的 HTML（带颜色）；失败时是红色的 `-` */
  readonly status: string
  /** 延迟的 HTML（带颜色）；失败时是错误原因 */
  readonly delay: string
}

/** 最近一次采样的形状，与 monitor 的 `LatestSample.network` 一致 */
export interface NetworkSample {
  /** 网卡名 */
  readonly iface?: string
  /** 下行字节/秒 */
  readonly rx_sec?: number
  /** 上行字节/秒 */
  readonly tx_sec?: number
  /** 累计下行字节 */
  readonly rx_bytes?: number
  /** 累计上行字节 */
  readonly tx_bytes?: number
}

/** 延迟分档的配色阈值（毫秒） */
const DELAY_BAD_MS = 2000

/** 延迟中档的阈值（毫秒） */
const DELAY_AVERAGE_MS = 500

/** 各类颜色的取值，与源插件一致 */
const COLOR_GOOD = "#188038"
const COLOR_AVERAGE = "#d68100"
const COLOR_BAD = "#F44336"
const COLOR_WARNING = "#FF9800"
const COLOR_DANGER = "#9C27B0"
const COLOR_INFO = "#03A9F4"

/**
 * 把一次网络采样整理成模板要的形状
 *
 * 速率与累计量都要求成对出现：只有下行没有上行时，画出来的两个数字会让使用者以为
 * 上行真的是 0。宁可整块不显示。
 *
 * **`speed` 不一定在，模板必须判它。** `si` 的 `rx_sec` / `tx_sec` 是两次采样的差值，
 * 进程刚起来那会儿 `si` 给的是 `null` —— 此时只有 `rx_bytes` / `tx_bytes` 可用，
 * 本函数于是**只给 `traffic` 不给 `speed`**。而 `templates/state.html` 读的是
 * `network.speed.speed.upload`：外层那个 `speed` 是"有网速这一块"的开关（恒存在），
 * 内层那个才是本函数的返回值。模板少了内层判断就会在 `undefined` 上取 `.upload`，
 * 整张图渲染失败 —— 实机上报的是 `Cannot read properties of undefined (reading 'speed')`，
 * 且只在刚启动、还没采到第二拍时出现。
 * @param sample 采样；未采到时为 undefined
 * @returns 网速数据；无有效数据时 undefined（模板据此隐去整个板块）
 */
export function toNetworkView(sample: NetworkSample | undefined): NetworkView | undefined {
  if (sample === undefined) return undefined

  const { rx_sec: rx, tx_sec: tx, rx_bytes: rxBytes, tx_bytes: txBytes } = sample
  const hasSpeed = typeof rx === "number" && typeof tx === "number"
  const hasTraffic = typeof rxBytes === "number" && typeof txBytes === "number"
  // 累计量全为 0 时视为"还没采到"而非"确实没流量"：刚启动时 `si` 给的累计量就是 0
  const showTraffic = hasTraffic && rxBytes + txBytes > 0

  if (!hasSpeed && !showTraffic) return undefined

  // `showByte: false` 让 512B 显示成 `512` 而非 `512B` —— 后面紧跟的 `/s` 已经说明了单位
  const parts = (value: number): FileSizeParts =>
    getFileSize(value, { showByte: false, aloneUnit: true })

  return {
    ...(hasSpeed ? { speed: { download: parts(rx), upload: parts(tx) } } : {}),
    ...(showTraffic ? { traffic: { download: parts(rxBytes), upload: parts(txBytes) } } : {})
  } as NetworkView
}

/**
 * 按延迟给一个颜色
 * @param delay 毫秒
 * @returns CSS 颜色
 */
export function delayColor(delay: number): string {
  if (delay > DELAY_BAD_MS) return COLOR_BAD
  if (delay > DELAY_AVERAGE_MS) return COLOR_AVERAGE
  return COLOR_GOOD
}

/**
 * 按状态码给一个颜色
 *
 * 5xx 用紫色而非红色，是为了与 4xx 的红区分开 —— 两者都是失败，但 4xx 是「请求本身有问题」
 * （网址填错了），5xx 是「对面挂了」。混成一色会让使用者排查错方向。
 * @param status 状态码
 * @returns CSS 颜色
 */
export function statusColor(status: number): string {
  if (status >= 500) return COLOR_DANGER
  if (status >= 400) return COLOR_BAD
  if (status >= 300) return COLOR_WARNING
  if (status >= 200) return COLOR_GOOD
  if (status >= 100) return COLOR_INFO
  return ""
}

/**
 * 一段带颜色的 HTML
 *
 * **模板用 `{{@...}}` 不转义输出这两项**，故此处必须自己确保内容里没有使用者可控的
 * HTML。颜色是硬编码的常量，数字来自 `Number()`，唯一含使用者输入的是下面的错误文案，
 * 那里做了转义。
 * @param color CSS 颜色
 * @param text 内容
 * @returns HTML 片段
 */
function colored(color: string, text: string): string {
  return color === "" ? text : `<span style='color:${color}'>${text}</span>`
}

/**
 * 转义 HTML 特殊字符
 *
 * 只用于错误文案 —— 它可能含使用者填的网址。这个板块是唯一一处把错误信息放进
 * 不转义输出的地方，因此这一处必须转义。
 * @param text 原文
 * @returns 转义后的文本
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * 测一个网址的延迟
 *
 * 用 `HEAD` 而非 `GET`：这里只关心「通不通、多快」，不需要任何响应体。某些站点不支持 HEAD
 * 会返回 405，那也是一个有效的结果（说明连通），故不因状态码非 2xx 而算失败 —— 失败只指
 * 连不上或超时。
 * @param http 内核的 HTTP 客户端
 * @param url 网址
 * @param timeoutMs 超时毫秒
 * @param useProxy 是否走代理
 * @returns 状态码与延迟
 */
export async function probeSite(
  http: HttpClient,
  url: string,
  timeoutMs: number,
  useProxy: boolean
): Promise<{ status: number; delay: number }> {
  const start = Date.now()
  const response = await http.request(url, {
    method: "HEAD",
    timeout: timeoutMs,
    // `proxy` 的取值是「代理地址」或 `false`（关闭）；不传则用全局配置。
    // 配置项 `useProxy` 是个布尔，开启时把它翻译成"用全局代理"即不传本字段，
    // 关闭时显式传 `false` —— 传 `true` 是错的，内核会把 true 当代理地址解析
    ...(useProxy ? {} : { proxy: false as const }),
    // 4xx / 5xx 本身就是要报告的结果，不是异常。缺省值 true 会让一个 503 变成
    // 一条"请求失败"，而模板里那个格子本该显示 `503`
    throwOnError: false,
    responseType: "none"
  })
  return { status: response.status, delay: Date.now() - start }
}

/**
 * 并发测试一批网址
 *
 * 用一个共享的下标做工作队列：每个工作者取完一个号就去测，测完（无论成败）再取下一个。
 * **成败都必须推进下标**，这是与源实现的关键差别 —— 见文件头。
 * @param http 内核的 HTTP 客户端
 * @param sites 要测的网址
 * @param concurrency 同时几个
 * @param timeoutMs 单条超时
 * @param onWarn 单条失败时的告知方式
 * @returns 各条结果，顺序与入参一致
 */
export async function probeSites(
  http: HttpClient,
  sites: readonly { readonly name: string; readonly url: string; readonly useProxy?: boolean }[],
  concurrency: number,
  timeoutMs: number,
  onWarn: (message: string, err: unknown) => void
): Promise<SiteResult[]> {
  if (sites.length === 0) return []

  const results: SiteResult[] = new Array<SiteResult>(sites.length)
  let cursor = 0
  const workers = Math.max(1, Math.min(concurrency, sites.length))

  /**
   * 一个工作者：不断取号、测试、写下结果，直到没有号可取了
   * @returns 该工作者跑完即结束
   */
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= sites.length) return
      const site = sites[index]
      if (site === undefined) continue
      results[index] = await probeOne(http, site, timeoutMs, onWarn)
    }
  }

  await Promise.all(Array.from({ length: workers }, worker))
  // 理论上不会有空洞（每个下标都会被某个工作者取到），兜一层以免模板拿到 undefined
  return results.map(
    (item, index) =>
      item ?? { name: sites[index]?.name ?? "", status: colored(COLOR_BAD, "-"), delay: colored(COLOR_BAD, "Error") }
  )
}

/**
 * 测一个网址并整理成模板要的形状，任何失败都变成一行红色的说明
 * @param http 内核的 HTTP 客户端
 * @param site 网址
 * @param timeoutMs 单条超时
 * @param onWarn 告知方式
 * @returns 该条结果
 */
async function probeOne(
  http: HttpClient,
  site: { readonly name: string; readonly url: string; readonly useProxy?: boolean },
  timeoutMs: number,
  onWarn: (message: string, err: unknown) => void
): Promise<SiteResult> {
  try {
    const { status, delay } = await probeSite(http, site.url, timeoutMs, site.useProxy ?? false)
    return {
      name: site.name,
      status: colored(statusColor(status), String(status)),
      delay: colored(delayColor(delay), `${delay}ms`)
    }
  } catch (err) {
    // 超时与连不上是两种不同的失败：前者是"对面太慢"，后者是"根本到不了"。
    // 分开写出来，使用者才知道该等还是该查网络
    const reason = errorReason(err)
    onWarn(`测试 ${site.name} 失败`, err)
    return {
      name: site.name,
      status: colored(COLOR_BAD, "-"),
      delay: colored(COLOR_BAD, escapeHtml(reason))
    }
  }
}

/**
 * 把异常归纳成一个短标签
 *
 * 显示的是一张图里的一格，写不下完整的错误消息，故只取最能区分问题的那几个字。
 * @param err 异常
 * @returns 短标签
 */
export function errorReason(err: unknown): string {
  if (!(err instanceof Error)) return "Error"
  const name = err.name
  const message = err.message
  if (name === "AbortError" || /abort/i.test(message)) return "Timeout"
  if (/ECONNRESET/i.test(message)) return "Econnreset"
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return "DNS"
  if (/ECONNREFUSED/i.test(message)) return "Refused"
  if (/certificate|self-signed|CERT_/i.test(message)) return "TLS"
  return "Error"
}
