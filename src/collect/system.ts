/**
 * 模块职责：整机与框架层面的信息 —— 系统版本、主机名、运行时长、插件数、版权行
 * 依赖方向：内核的 `detectPlatform` / `formatBytes`、同目录的 format
 * 生命周期：纯函数
 * 注意事项：**系统运行时长与 CPU 型号取自 `systeminformation`，不由内核提供。**
 *          内核的 `sampleSystem()` 只给磁盘与显卡，`sampleUsage()` 给的是**本进程**的
 *          运行时长与内存 —— 后两者与「这台机器开了多久」是两回事，混用会让状态图上
 *          写着「运行时长 3 分钟」而机器已经开了半个月。故这里直接用 `si.time().uptime`
 *          与 `si.cpu().brand`。
 *
 *          **插件数与命令数从 `ctx.app.plugins.list()` 数，不读 `./plugins` 目录。**
 *          新内核的插件可以来自目录之外的来源，数目录会数出一批非插件的东西、又漏掉
 *          非目录来源的插件。且插件可以加载失败 —— 那种插件不该计入。
 */

import si from "systeminformation"
import { detectPlatform, formatBytes } from "@yunzai-ng/core"
import { formatDuration, formatDateTime } from "../util/format.js"

/** 系统信息板块在模板里所需的数据 */
export interface SystemView {
  /** 操作系统与版本，如 `Windows 11 22H2` */
  readonly os: string
  /** 主机名 */
  readonly hostname: string
  /** CPU 型号 */
  readonly cpu: string
  /** 系统运行时长，已格式化 */
  readonly uptime: string
  /** 内核版本 */
  readonly kernel: string
  /** 时区 */
  readonly timezone: string
  /** 当前时间，已格式化 */
  readonly time: string
  /** 操作系统族，如 `windows`；模板据此决定是否显示 Windows 专属的提示 */
  readonly platform: string
  /** 是否在 Termux / 安卓里跑 */
  readonly isTermux: boolean
  /** 是否在容器里跑 */
  readonly isContainer: boolean
  /** 物理内存总量，已格式化 */
  readonly totalMemory: string
  /**
   * 物理内存总量的字节数
   *
   * 与上面那个格式化过的串并存，是因为采集层要拿它算「占整机内存的比例」
   * 物理内存」—— 那个百分比要的是一个数，而不是 `31.9GB` 这样的串。让调用方去反解
   * 格式化后的串是最容易出错的做法。
   */
  readonly totalMemoryBytes: number
  /** 逻辑 CPU 数 */
  readonly cpuCount: number
  /** 框架版本 */
  readonly version: string
  /** 插件数量 */
  readonly pluginCount: number
  /** 命令数量 */
  readonly commandCount: number
  /** 已加载的适配器数；取不到时 undefined */
  readonly adapterCount?: number
  /** Node 版本 */
  readonly nodeVersion: string
  /** 版权行；模板用 `{{@...}}` 不转义输出，故此处已拼好 HTML */
  readonly copyright: string
}

/** 采系统信息所需的外部输入 */
export interface SystemInput {
  /** 框架版本 */
  readonly version: string
  /** 本插件的版本 */
  readonly pluginVersion: string
  /** 插件数 */
  readonly pluginCount: number
  /** 命令数 */
  readonly commandCount: number
  /** 适配器数；内核未提供时 undefined */
  readonly adapterCount?: number
}

/**
 * 拼出版权行
 *
 * 输出的是 HTML（模板里那处用的是 `{{@...}}`），故只放本插件自己的常量，不含使用者输入。
 * @param version 框架版本
 * @param pluginVersion 本插件的版本
 * @returns HTML 片段
 */
export function copyrightLine(version: string, pluginVersion: string): string {
  return (
    `<span style='color:#0077ff'>LYLN - State</span> v${pluginVersion} · ` +
    `<span style='color:#0077ff'>Yunzai-NG</span> ${version}`
  )
}

/**
 * 拼出操作系统名
 *
 * `si.osInfo()` 在 Windows 上给的 `distro` 已经是 `Windows 11`，而 Linux 上给的是 `Ubuntu`
 * 或 `Debian GNU/Linux` —— 后者不带版本号，光有它说明不了跑的是哪一版。故两者的拼法不同：
 *
 * - Windows：`distro` 已含版本号，`release` 是内核版本（`10.0.22621`），拼上去会变成
 *   `Windows 11 10.0.22621` —— 那不是使用者认得的版本号，丢掉；
 * - 其他：`distro` + `release`（`Ubuntu 22.04`）才是完整说法。
 *
 * 两者都给不上时回落到内核的 `detectPlatform().os`。
 * @param distro `si` 给的发行版名
 * @param release `si` 给的发行版版本
 * @param fallback 内核给的系统族
 * @returns 操作系统名
 */
export function osLabel(distro: string, release: string, fallback: string): string {
  if (distro === "") return release === "" ? fallback : `${fallback} ${release}`
  // Windows 的 `release` 是内核版本而非发行版版本，拼上去反而看不懂
  if (/^Windows/i.test(distro)) return distro
  return release === "" ? distro : `${distro} ${release}`
}

/**
 * 采集系统信息
 * @param input 由调用方从内核取好的计数
 * @returns 板块数据
 */
export async function collectSystem(input: SystemInput): Promise<SystemView> {
  // 内核这三项都是防御式的，取不到给 undefined 或缓存值，不抛
  const platform = detectPlatform()

  // 两项系统信息互不依赖，并发取；各自 catch 成 undefined，取不到的那一项留空。
  // `si.time()` 是**同步**的（它只读 process.uptime 与 Intl），另两项才是异步 ——
  // 给同步的那个套 catch 会被类型系统拦住，这正合适
  const time = si.time()
  const [os, cpu] = await Promise.all([
    si.osInfo().catch(() => undefined),
    si.cpu().catch(() => undefined)
  ])
  // 三个 `si` 调用都可能是 null（它的失败形态是返回 null 而非抛错），故下面一律
  // 走 `?.` 取字段；此处显式标明，免得后来者以为这几个 `?.` 是多余的

  return {
    os: osLabel(os?.distro ?? "", os?.release ?? "", platform.os),
    hostname: os?.hostname ?? "",
    // `cpu == null` 而不是 `=== undefined`：`si.cpu()` 取不到时给的是 null，
    // 漏掉它会让这一格印出 `null undefined`（拼接把 null 变成了字面量）
    cpu: cpu == null ? "" : `${cpu.manufacturer} ${cpu.brand}`.trim(),
    // `si.time().uptime` 是**系统**运行秒数；`os.uptime()` 是毫秒，两者单位不同且都不在
    // 返回值里标明 —— 这是 `si` 里最容易搞混的一处
    uptime: formatDuration(time?.uptime ?? 0),
    kernel: os?.kernel ?? "",
    timezone: time?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    time: formatDateTime(),
    platform: platform.os,
    isTermux: platform.isTermux,
    isContainer: platform.isContainer,
    totalMemory: formatBytes(platform.totalMemory),
    totalMemoryBytes: platform.totalMemory,
    cpuCount: platform.cpus,
    version: input.version,
    pluginCount: input.pluginCount,
    commandCount: input.commandCount,
    // 0 与 undefined 的区别在这里有意义：用 WebUI 而没挂适配器时确实是 0，
    // 而内核尚未完成加载时是 undefined —— 后者不该显示成「0 个适配器」
    ...(input.adapterCount === undefined ? {} : { adapterCount: input.adapterCount }),
    nodeVersion: `v${platform.nodeVersion}`,
    copyright: copyrightLine(input.version, input.pluginVersion)
  }
}
