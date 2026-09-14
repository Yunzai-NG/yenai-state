/**
 * 模块职责：给状态图选一张背景，取不到就回落到本地那张
 * 依赖方向：内核的 `ctx.http`（由调用方注入）、同目录的 format
 * 生命周期：纯函数 + 一份短命缓存
 * 注意事项：**背景图必须在本进程里取回并转成 `data:` URL，不能让 Chromium 去取。**
 *          源插件的做法是把网址直接写进内联样式，于是每渲染一次就有一个渲染进程去拉一次
 *          外部图片 —— 那张图往往是几 MB 的壁纸，而出图要等它下完。取不到时更糟：
 *          渲染本身成功了，但出来的是一张纯色底的图，看起来像"插件坏了"。
 *
 *          **缓存是刻意的。** 状态图会被连着看几次（`#状态` 看完看 `#状态pro`），
 *          每次都重下一张几 MB 的图没有意义。缓存 5 分钟，且**只缓存成功的那一次** ——
 *          网络失败时缓存一个"失败"会让使用者在网络恢复后仍然看不到背景。
 *
 *          **`backdropDefault` 与 `backdrop` 是两回事。** 前者是取不到网络图时用的兜底
 *          （配置里默认 `random`，表示从自带的两张图里随机挑一张），后者是正常要用的那张。
 *          源插件把这两个名字混着用在好几处，此处分开：`backdrop` 是首选，取不到才轮到
 *          `backdropDefault`，而 `backdropDefault` 若是 `random` 就从自带图里随机。
 */

import { readFile } from "node:fs/promises"
import { extname } from "node:path"
import type { HttpClient } from "@yunzai-ng/types"

/** 自带背景图的文件名（相对本插件的 resources/img/bg/） */
export const BUILTIN_BACKDROPS = ["1.jpg", "2.jpg"] as const

/** 网络背景图的缓存时长 */
const CACHE_TTL_MS = 5 * 60 * 1000

/** 单张背景图的下载上限；超过这个大小的图渲染起来比下载还慢 */
const MAX_BYTES = 12 * 1024 * 1024

/** 扩展名到 MIME 的对照 */
const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif"
}

/** 一张背景在模板里所需的形式 */
export interface Backdrop {
  /** 可直接写进 `background-image` 的值，如 `url("data:image/jpeg;base64,...")` */
  readonly css: string
  /** 来源说明，用于 debug 输出 */
  readonly from: "network" | "builtin"
}

/** 上一次成功的网络背景 */
let cached: { url: string; backdrop: Backdrop; at: number } | undefined

/** 清掉缓存，仅测试用 */
export function resetBackdropCache(): void {
  cached = undefined
}

/**
 * 把一张本地图片读成 `data:` URL
 *
 * 用 `data:` 而不是 `file://`：`file://` 需要渲染器允许本地文件访问，而本图是在
 * 模板里当 CSS 用的，走 `data:` 就绕开了这个开关。
 * @param path 绝对路径
 * @returns `data:` URL；读不到时 undefined
 */
export async function readLocalImage(path: string): Promise<string | undefined> {
  try {
    const buffer = await readFile(path)
    if (buffer.length === 0) return undefined
    const mime = MIME_BY_EXT[extname(path).toLowerCase()] ?? "image/jpeg"
    return `data:${mime};base64,${buffer.toString("base64")}`
  } catch {
    // 自带图片读不到说明插件装坏了，但那时还有 CSS 里的兜底色，不必抛出
    return undefined
  }
}

/**
 * 从自带的两张图里随机挑一张
 * @param bgDir 自带背景图所在目录的绝对路径
 * @returns 背景；一张都读不到时 undefined
 */
export async function pickBuiltinBackdrop(bgDir: string): Promise<Backdrop | undefined> {
  const names = [...BUILTIN_BACKDROPS]
  // 洗牌后逐个试，避免"随机挑中的那张恰好坏了"就让整张图失去背景
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const a = names[i]
    const b = names[j]
    if (a === undefined || b === undefined) continue
    names[i] = b
    names[j] = a
  }

  for (const name of names) {
    const data = await readLocalImage(`${bgDir}/${name}`)
    if (data !== undefined) return { css: `url("${data}")`, from: "builtin" }
  }
  return undefined
}

/**
 * 取一张背景
 *
 * 顺序是：配置的 `backdrop` → 配置的 `backdropDefault`（若是网址）→ 自带图随机。
 * 任何一步失败都往下走一步，**绝不抛** —— 状态图没有背景也是能看的，为背景失败
 * 而整张图不出来是本末倒置。
 * @param http 内核的 HTTP 客户端
 * @param preferred 首选网址；空串表示不用网络图
 * @param fallback 兜底；是网址则当网址，是 `random` 或空则用自带图
 * @param bgDir 自带背景图目录的绝对路径
 * @param warn 告知方式
 * @returns 背景；连自带图都读不到时 undefined（模板会留 CSS 的兜底色）
 */
export async function collectBackdrop(
  http: HttpClient,
  preferred: string,
  fallback: string,
  bgDir: string,
  warn: (message: string, err: unknown) => void
): Promise<Backdrop | undefined> {
  const urls = [preferred, fallback].filter(
    url => url !== "" && /^https?:\/\//i.test(url)
  )

  for (const url of urls) {
    const downloaded = await downloadBackdrop(http, url, warn)
    if (downloaded !== undefined) return downloaded
  }

  return pickBuiltinBackdrop(bgDir)
}

/**
 * 下载一张网络背景图
 * @param http 内核的 HTTP 客户端
 * @param url 网址
 * @param warn 告知方式
 * @returns 背景；失败时 undefined（由调用方决定下一步）
 */
async function downloadBackdrop(
  http: HttpClient,
  url: string,
  warn: (message: string, err: unknown) => void
): Promise<Backdrop | undefined> {
  // 缓存命中：同一个网址且没过期，直接用上次那份
  if (cached !== undefined && cached.url === url && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.backdrop
  }

  try {
    const response = await http.request<Buffer>(url, {
      responseType: "buffer",
      timeout: 15_000,
      throwOnError: false,
      // 背景图服务常做重定向（`t.alcy.cc/mp` 就是），要跟着走
      followRedirect: true
    })
    if (response.status >= 400) {
      warn(`背景图返回 ${response.status}，改用兜底背景`, url)
      return undefined
    }

    const buffer = Buffer.from(response.data)
    if (buffer.length === 0) return undefined
    if (buffer.length > MAX_BYTES) {
      // 一张比 12MB 还大的图当背景，渲染耗时远超过它带来的观感提升
      warn(`背景图超过 ${MAX_BYTES / 1024 / 1024}MB，改用兜底背景`, url)
      return undefined
    }

    // 按内容猜类型而非照抄响应头：图床常给 `application/octet-stream`
    const mime = sniffMime(buffer)
    const backdrop: Backdrop = { css: `url("data:${mime};base64,${buffer.toString("base64")}")`, from: "network" }
    // 只缓存成功的那一次，理由见文件头
    cached = { url, backdrop, at: Date.now() }
    return backdrop
  } catch (err) {
    warn("下载背景图失败，改用兜底背景", err)
    return undefined
  }
}

/**
 * 按魔数猜图片类型
 * @param buffer 图片数据
 * @returns MIME 类型；认不出时按 jpeg
 */
export function sniffMime(buffer: Buffer): string {
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png"
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return "image/gif"
  // RIFF....WEBP
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[8] === 0x57) return "image/webp"
  return "image/jpeg"
}
