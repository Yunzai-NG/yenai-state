/**
 * 模块职责：把各采集模块的结果拼成模板要的那一个对象 —— `#状态` 命令的主干
 * 依赖方向：`src/collect/*`、`src/monitor.ts`、`src/view/style.ts`、`src/config.ts`
 * 生命周期：**每次命令调用构造一次**（背景图那张除外，它有 5 分钟缓存）
 * 注意事项：**所有板块并发取，且各自 catch。** 源实现是串行 `await`，一个慢的板块
 *          （进程表几百毫秒、群列表几百毫秒）会把整张图的时间线拉长；改成 `Promise.all`
 *          后总耗时是其中最慢的那一个，而非全部之和。代价是出错时的日志会挤在一起 ——
 *          故 `warn` 里带上板块名。
 *
 *          **每个板块失败都只是「这块不出现」，不是「整张图失败」。** 一台取不到磁盘速率的
 *          容器里，CPU 与内存的环照常该画出来。这是全插件的贯穿约定，出自 `hardware-plugin`
 *          的文件头「0 会被读成机器闲着」那条。
 *
 *          **`isPro` 决定取哪些数据，不只是隐藏哪些。** 进程表与好友数这两项耗时明显，
 *          非 pro 时**根本不取** —— 取回来再藏起来，等于白白让非 pro 的状态图慢几百毫秒。
 *          源实现在这一点上是"先全取、再按开关藏"，那是它状态图偏慢的一个原因。
 */

import type { HttpClient, Logger } from "@yunzai-ng/types"
import { parseDuration } from "@yunzai-ng/core"
import type { StateConfigRO, ShowMode } from "../config.js"
import { showFor, showFastFetchFor } from "../config.js"
import { markUsage } from "../util/debug.js"
import { formatDateTime } from "../util/format.js"
import type { Monitor } from "../monitor.js"
import { collectResources } from "../collect/resources.js"
import type { ResourceRing, ResourceKind } from "../collect/resources.js"
import { collectDisks, toDiskIo } from "../collect/disk.js"
import type { DiskView, DiskIoView } from "../collect/disk.js"
import { toNetworkView, probeSites, parseSiteLine } from "../collect/network.js"
import type { NetworkView, SiteResult } from "../collect/network.js"
import { collectProcesses } from "../collect/process.js"
import type { ProcessView } from "../collect/process.js"
import { collectBot, collectAdapters } from "../collect/bot.js"
import type { BotView, AdapterView } from "../collect/bot.js"
import { collectSystem, copyrightLine } from "../collect/system.js"
import type { SystemView } from "../collect/system.js"
import { collectFastfetch } from "../collect/fastfetch.js"
import type { FastfetchView } from "../collect/fastfetch.js"
import { collectBackdrop } from "./style.js"

/** 模板要的那一个对象 */
export interface StateView {
  /** 采集时刻，已格式化 */
  readonly time: string
  /** 背景图的 CSS 值；取不到时不出现，模板回落到 CSS 里的底色 */
  readonly backdrop?: string
  /** 各账号板块；按内核给出的账号顺序，一个号一张卡 */
  readonly bots: readonly BotView[]
  /** 各适配器 */
  readonly adapters: readonly AdapterView[]
  /** 系统板块 */
  readonly system: SystemView
  /** 资源环；按配置里点名的顺序 */
  readonly resources: readonly ResourceRing[]
  /** 磁盘分区；一块也探不到时为空数组 */
  readonly disks: readonly DiskView[]
  /** 磁盘读写速率；未采到时 undefined */
  readonly disksIO?: readonly DiskIoView[]
  /** 网速；未采到时 undefined */
  readonly network?: NetworkView
  /** 对外连通性测试；未开启或全部失败时 undefined */
  readonly sites?: readonly SiteResult[]
  /** 进程表；未开启或取不到时 undefined */
  readonly process?: ProcessView
  /** fastfetch；没装时 undefined */
  readonly fastfetch?: FastfetchView
  /** 本次是否为 pro */
  readonly isPro: boolean
  /** 曲线数据，交给模板里的 echarts */
  readonly chart: Monitor["chart"]
  /** 样式相关的取值 */
  readonly style: StyleValues
}

/** 模板里各处会用到的样式取值，从配置里挑出来 */
export interface StyleValues {
  /** CSS 变量声明串，模板塞进 `<style>` */
  readonly vars: string
  /** 内容过长时是否自动分列 */
  readonly startColumn: boolean
  /** 账号名的颜色 */
  readonly botNameColor: string
  /** 进度条高档配色（占用 ≥ 90%） */
  readonly highColor: string
  /** 进度条中档配色（占用 ≥ 80%） */
  readonly mediumColor: string
  /** 进度条低档配色，也是使用者可自定义的那一档 */
  readonly lowColor: string
}

/** 采一次状态所需的全部输入 */
export interface BuildInput {
  /** 插件配置 */
  readonly config: StateConfigRO
  /** 是否为 pro */
  readonly isPro: boolean
  /** 框架版本 */
  readonly version: string
  /** 本插件的版本；只有版权行用它 */
  readonly pluginVersion: string
  /** 插件数 */
  readonly pluginCount: number
  /** 命令数 */
  readonly commandCount: number
  /** 各适配器（`ctx.app.adapters.list()`） */
  readonly adapters: readonly { readonly id: string; readonly name: string }[]
  /** 各账号状态（`ctx.app.accounts.list()`） */
  readonly accounts: readonly {
    readonly adapterId: string
    readonly status: string
    readonly since: number
    readonly retries: number
    readonly nickname?: string
  }[]
  /**
   * 要画的那几个账号，每个号一张卡
   *
   * **顺序即图上的顺序**，由调用方决定（内核给出的账号顺序）。
   * `avatarUrl` / `friendCount` / `groupCount` 三项是可选的：头像要问适配器、好友与群数
   * 要发请求，非 pro 时根本不取，故缺了就是"没取"，而不是"取到空"。
   */
  readonly bots: readonly {
    /** 该账号所属的适配器 id，用于查出它叫什么 */
    readonly adapterId: string
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
    /** 头像地址；未取到时不出现 */
    readonly avatarUrl?: string
    /** 好友数；不取或取不到时不出现 */
    readonly friendCount?: number
    /** 群数；不取或取不到时不出现 */
    readonly groupCount?: number
  }[]
  /** 采样器 */
  readonly monitor: Monitor
  /** 内核的 HTTP 客户端 */
  readonly http: HttpClient
  /** 自带背景图目录的绝对路径 */
  readonly bgDir: string
  /** 兜底头像的绝对路径 */
  readonly defaultAvatar: string
  /** 日志 */
  readonly logger: Logger
}

/**
 * 三态开关到布尔的换算，带上"是否为 pro"这一维
 * @param mode 配置里的三态值
 * @param isPro 是否为 pro
 * @returns 是否显示
 */
function on(mode: string | undefined, isPro: boolean): boolean {
  return showFor(mode, isPro)
}

/**
 * 是不是 Windows
 *
 * 抽成一个函数而不是在调用处直接写 `process.platform === "win32"`：本文件里有好几处
 * 需要这个判断，而其中一处（`emptySystem` 的兜底）在 `#process` 这个名字上会与
 * `Promise.all` 里那个 `process` 局部变量撞名 —— 那正是需要提出来才看得清的地方。
 * @returns 是否为 Windows
 */
function isWindows(): boolean {
  return process.platform === "win32"
}

/**
 * 拼出 CSS 变量声明串
 *
 * **放在内联样式里而不是改 CSS 文件**：配色是使用者的配置，而 CSS 是随插件发布的静态
 * 文件。把配置写进 CSS 就得在运行时生成或改写那个文件。
 * @param style 配置里的样式段
 * @returns 形如 `--high-color:#f00;` 的串
 */
export function styleVars(style: StateConfigRO["style"]): string {
  const progress = style.progressBarColor
  return [
    `--high-color:${progress.high[0] ?? "#F44336"}`,
    `--medium-color:${progress.medium[0] ?? "#FF9800"}`,
    `--low-color:${progress.low[0] ?? "#2EC272"}`,
    `--bot-name-color:${style.BotNameColor}`
  ].join(";")
}

/**
 * 采集一次状态
 *
 * 各板块并发取，每个都自带 catch —— 见文件头。返回的对象直接交给模板。
 * @param input 全部输入
 * @returns 模板数据
 */
export async function buildState(input: BuildInput): Promise<StateView> {
  const { config, isPro, logger } = input
  /** 告警；带上板块名，否则并发时的日志分不清是谁出的 */
  const warn =
    (section: string) =>
    (message: string, err: unknown): void => {
      logger.warn(`[${section}] ${message}：${err instanceof Error ? err.message : String(err)}`)
    }

  const timeout = parseDuration(config.psTestSites.timeout, 5000)
  const interval = parseDuration(config.monitor.getDataInterval, 60_000)

  /*
   * 哪些数据要取
   *
   * 见文件头：耗时的两项在非 pro 时根本不取。
   */
  const wantProcess = on(config.processLoad.show, isPro)
  const wantSites = on(config.psTestSites.show, isPro)
  const wantCharts = on(config.chartsCfg.show, isPro)
  const wantFastfetch = showFastFetchFor(config.showFastFetch, isPro, isWindows())
  const wantCounts = isPro

  const resourcesWanted = config.systemResources as readonly ResourceKind[]

  const [
    resources,
    disks,
    disksIO,
    network,
    sites,
    process,
    bots,
    system,
    fastfetch,
    backdrop
  ] = await Promise.all([
    collectResources(resourcesWanted, config.style.progressBarColor.low, warn("resources")).catch(
      (err: unknown) => {
        warn("resources")("采集资源环失败", err)
        return [] as ResourceRing[]
      }
    ),
    collectDisks(config.style.progressBarColor.low, warn("disks")).catch((err: unknown) => {
      warn("disks")("采集磁盘失败", err)
      return [] as DiskView[]
    }),
    Promise.resolve(toDiskIo(input.monitor.latest.disksIO)),
    Promise.resolve(toNetworkView(input.monitor.latest.network)),
    wantSites
      ? probeSites(
          input.http,
          // 配置里是「名称 | 网址 | 走代理」的行，先解析成 probeSites 要的形状；
          // 解析不了的行在此丢弃并各自告警一条（见 parseSiteLine）
          config.psTestSites.list.flatMap((line, i) => {
            const site = parseSiteLine(line, i, message => warn("sites")(message, new Error(message)))
            return site === undefined ? [] : [site]
          }),
          config.psTestSites.concurNum,
          timeout,
          warn("sites")
        ).catch((err: unknown) => {
          warn("sites")("连通性测试整体失败", err)
          return undefined
        })
      : Promise.resolve(undefined),
    wantProcess
      ? collectProcesses(
          {
            showCmd: config.processLoad.showCmd,
            showMax: config.processLoad.showMax.show,
            showNum: config.processLoad.showMax.showNum,
            order: config.processLoad.showMax.order,
            list: config.processLoad.list,
            filterList: config.processLoad.filterList
          },
          warn("process")
        ).catch((err: unknown) => {
          warn("process")("采集进程表失败", err)
          return undefined
        })
      : Promise.resolve(undefined),
    /*
     * 一个号一张卡，几个号并发取
     *
     * 每个号各自 catch：某个号取不到（头像下载失败、适配器已卸载）不该让别的号也跟着消失 ——
     * 与本文件"每块失败都只是这块不出现"的约定一致。
     */
    Promise.all(
      input.bots.map(bot =>
        collectBot(
          {
            nickname: bot.nickname,
            selfId: bot.selfId,
            status: bot.status,
            since: bot.since,
            retries: bot.retries,
            ...(bot.avatarUrl === undefined ? {} : { avatarUrl: bot.avatarUrl }),
            ...(bot.friendCount === undefined ? {} : { friendCount: bot.friendCount }),
            ...(bot.groupCount === undefined ? {} : { groupCount: bot.groupCount }),
            adapterAccounts: input.accounts.length,
            adapterOnline: input.accounts.filter(account => account.status === "online").length,
            // 该账号实际用的那个适配器 —— 不是 `input.adapters` 全体（那是"注册了哪几个"）
            adapterName: input.adapters.find(adapter => adapter.id === bot.adapterId)?.name ?? ""
          },
          input.http,
          input.defaultAvatar,
          warn("bot")
        ).catch((err: unknown) => {
          warn("bot")(`采集账号 ${bot.selfId} 的信息失败`, err)
          // 账号卡是这张图的主角之一，取不到也要给一个能渲染的空壳，而不是少一张卡
          return emptyBot(bot, input)
        })
      )
    ),
    collectSystem({
      version: input.version,
      pluginVersion: input.pluginVersion,
      pluginCount: input.pluginCount,
      commandCount: input.commandCount,
      adapterCount: input.adapters.length
    }).catch((err: unknown) => {
      warn("system")("采集系统信息失败", err)
      return undefined
    }),
    wantFastfetch
      ? collectFastfetch(warn("fastfetch")).catch(() => undefined)
      : Promise.resolve(undefined),
    collectBackdrop(
      input.http,
      config.style.backdrop,
      config.style.backdropDefault,
      input.bgDir,
      warn("style")
    ).catch(() => undefined)
  ])

  // 曲线数据：非 pro 时给空数组，免得模板里的 echarts 拿到一份用不上的数据
  const chart = wantCharts ? input.monitor.chart : { ...input.monitor.chart, cpu: [], ram: [], network: { upload: [], download: [] }, disksIO: { readSpeed: [], writeSpeed: [] } }

  logger.debug(
    `状态采集完成：资源 ${resources.length} 环 / 磁盘 ${disks.length} 块 / ` +
      `进程 ${process === undefined ? "未取" : String(process.list.length) + " 行"} / ` +
      `采样间隔 ${String(interval)}ms / wantCounts=${String(wantCounts)}`
  )
  markUsage()

  return {
    time: formatDateTime(),
    ...(backdrop === undefined ? {} : { backdrop: backdrop.css }),
    bots,
    adapters: collectAdapters(input.adapters, input.accounts),
    system: system ?? emptySystem(input),
    resources,
    disks,
    ...(disksIO === undefined ? {} : { disksIO }),
    ...(network === undefined ? {} : { network }),
    ...(sites === undefined || sites.length === 0 ? {} : { sites }),
    ...(process === undefined ? {} : { process }),
    ...(fastfetch === undefined ? {} : { fastfetch }),
    isPro,
    chart,
    style: {
      vars: styleVars(config.style),
      startColumn: config.style.startColumn,
      botNameColor: config.style.BotNameColor,
      highColor: config.style.progressBarColor.high[0] ?? "#F44336",
      mediumColor: config.style.progressBarColor.medium[0] ?? "#FF9800",
      lowColor: config.style.progressBarColor.low[0] ?? "#2EC272"
    }
  }
}

/**
 * 账号卡的兜底空壳
 *
 * 只兜这一个号 —— 别的号照常渲染。故它按号取参数，而不是拿整份 `BuildInput`：
 * 后者会让"这张空壳是哪個号的"变得含糊。
 * @param bot 该账号的输入
 * @param input 全部输入，只为查适配器名
 * @returns 一个能渲染的最小对象
 */
function emptyBot(bot: BuildInput["bots"][number], input: BuildInput): BotView {
  return {
    nickname: bot.nickname === "" ? "未知" : bot.nickname,
    uin: bot.selfId,
    // 适配器名与账号数据无关，兜底时照常给得出（账号取不到不是适配器没注册）
    adapterName: input.adapters.find(adapter => adapter.id === bot.adapterId)?.name ?? "",
    avatar: "",
    status: "未知",
    // 原文给空串：`statusIcon` 认不出时会退到最中性的那个图标
    statusKey: "",
    statusColor: "#8a8a8a",
    since: "未知",
    retries: bot.retries,
    memory: "0 B",
    uptime: "00:00:00"
  }
}

/**
 * 系统板块的兜底空壳
 * @param input 全部输入
 * @returns 一个能渲染的最小对象
 */
function emptySystem(input: BuildInput): SystemView {
  return {
    os: "",
    hostname: "",
    cpu: "",
    uptime: "00:00:00",
    kernel: "",
    timezone: "",
    time: formatDateTime(),
    platform: process.platform,
    isTermux: false,
    isContainer: false,
    totalMemory: "",
    totalMemoryBytes: 0,
    cpuCount: 0,
    version: input.version,
    pluginCount: input.pluginCount,
    commandCount: input.commandCount,
    nodeVersion: process.version,
    copyright: copyrightLine(input.version, input.pluginVersion)
  }
}

export type { ShowMode }
