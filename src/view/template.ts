/**
 * 模块职责：把各采集模块的结果翻译成模板真正认的那些变量名
 * 依赖方向：`src/collect/*` 与 `src/view/build.ts` 的类型
 * 生命周期：纯函数
 * 注意事项：**这一层存在的唯一理由是模板没改。** `templates/state.html` 是从椰奶原样搬过来的
 *          （只把硬编码路径换成了 `{{_res_path}}`），它读的是 `BotStatusList` / `otherInfo` /
 *          `visualData` / `disks.disksSize` / `network.speed.speed` 这些名字 —— 那些名字来自
 *          源插件的内部结构，与我在 `collect/` 里定的名字对不上。两条路：改模板去迁就新的
 *          采集结构，或者加一层翻译。选了后者，因为模板里那些名字与 CSS 的类名、
 *          `js/style.js` 里的选择器是绑在一起的（例如 `data-boxInfo='FastFetch'` 与
 *          `.fastFetch`），改一个名字要同时改三个地方，而翻译层只在一处。
 *
 *          **`chartData` 与 `Config` 是 JSON 字符串而不是对象。** 模板里写的是
 *          `JSON.parse(`{{@chartData}}`)` —— 直接把对象塞进去会被 art-template 输出成
 *          `[object Object]`。故这两个变量在这里先 `JSON.stringify` 一次。
 */

import type { StateView } from "./build.js"
import type { ResourceRing } from "../collect/resources.js"
import { RING_PERIMETER } from "../collect/resources.js"
import type { DiskView } from "../collect/disk.js"
import type { RedisKeyspaceEntry, RedisView } from "../collect/redis.js"
import { infoNumber, parseInfo } from "../collect/redis.js"
import type { FastfetchView } from "../collect/fastfetch.js"
import type { ProcessView } from "../collect/process.js"
import type { FileSizeParts } from "../util/format.js"

/**
 * 资源环在模板里的形状（`visualData` 的一项）
 *
 * `title` 必须是 `CPU` / `RAM` / `SWAP` / `GPU` / `Node` 五个之一：模板里
 * `group.title == "RAM"` 那个判断用来决定要不要画 buff/cache 的第二圈。
 */
export interface TemplateRing {
  /** 环的标题，如 `CPU` */
  readonly title: string
  /** 环中央的文字，如 `42%` */
  readonly inner: string
  /** 环下方的补充说明，通常是型号 */
  readonly detailed?: string
  /** 环下方的各行文字 */
  readonly info: readonly string[]
  /** 环的描边与偏移 */
  readonly percentage: { readonly color: string; readonly per: number }
  /** RAM 专属：缓冲区/缓存那第二圈 */
  readonly buffcache?: {
    /** 描边与偏移 */
    readonly percentage: { readonly per: number; readonly color: string }
    /** 固定为 true，模板用它判断要不要画这一圈 */
    readonly isBuff: boolean
  }
}

/** `otherInfo` 的每一项都是「主行 + 次行」 */
interface TemplatePair {
  /** 主行，字号大 */
  readonly main: string
  /** 次行，字号小；没有时不显示 */
  readonly secondary?: string
}

/** 模板要的一整个对象 */
export interface StateTemplateData {
  /** 曲线，JSON 串 */
  readonly chartData: string
  /** 前端图表配置，JSON 串 */
  readonly Config: string
  /** 是否为 pro，模板用来在时间那一格加「状态Pro」 */
  readonly isPro: boolean
  /** 采集时刻 */
  readonly time: string
  /** 背景的 CSS 值 */
  readonly backdrop?: string
  /** 账号卡片列表 */
  readonly BotStatusList: readonly BotCard[]
  /** 系统信息四格 */
  readonly otherInfo: {
    /** 操作系统 */
    readonly osInfo: TemplatePair
    /** 主机名 */
    readonly hostname: TemplatePair
    /** 运行时间 */
    readonly sysTime: TemplatePair
    /** 插件数 */
    readonly pluginNum: TemplatePair
  }
  /** 资源环 */
  readonly visualData: readonly TemplateRing[]
  /** 磁盘 */
  readonly disks: {
    /** 各分区占用 */
    readonly disksSize: readonly DiskView[]
    /** 各设备读写速率；未采到时整块不显示 */
    readonly disksIo?: readonly DiskIoRow[]
  }
  /** 网络 */
  /** 网络；网速与连通性测试都没有时整块不显示 */
  readonly network?: {
    /** 网速；未采到时这一块里只显示连通性测试 */
    readonly speed?: {
      /** 实时速率 */
      readonly speed: {
        /** 上行 */
        readonly upload: FileSizeParts
        /** 下行 */
        readonly download: FileSizeParts
      }
      /** 累计流量；累计量为 0 时不出现 */
      readonly traffic?: {
        /** 上行累计 */
        readonly upload: FileSizeParts
        /** 下行累计 */
        readonly download: FileSizeParts
      }
    }
    /** 对外连通性测试 */
    readonly psTest?: readonly SiteRow[]
  }
  /**
   * Redis 板块
   *
   * **即便没连上 Redis 也必须给一个值。** 模板第 16 行是
   * `var redisChartData = JSON.parse(`{{@redis.connectionData}}`)` —— 它在 `{{if redis}}`
   * **之外**，无论有没有 Redis 都要执行一次。不给这个变量，`redis` 就是 undefined，
   * 渲染时抛 `Cannot read properties of undefined (reading 'connectionData')`，
   * **整张状态图都出不来**（实机上撞到过）。给空壳后，`{{if redis}}` 那一块因为
   * 各字段为空而正常跳过 —— 没配 Redis 的部署本来就不该看到那一块。
   */
  readonly redis: TemplateRedis
  /** 进程表 */
  readonly processLoad?: ProcessView
  /** fastfetch */
  readonly fastFetch?: FastfetchView["lines"]
  /**
   * 样式变量
   *
   * `backdrop` **同上，必须是字符串**：模板第 7 行的 `background-image:url({{style.backdrop}})`
   * 也在任何 `{{if}}` 之外。取不到背景时给空串，`url()` 落空即回落到 CSS 里的底色。
   */
  readonly style: StateView["style"] & { readonly backdrop: string }
}

/**
 * Redis 板块在模板里的形状
 *
 * **字段名用的是 `INFO` 自己的键名，不是驼峰。** `templates/state.html` 读的是
 * `redis.redis_version` / `redis.used_memory_human` / `redis.maxmemory` /
 * `redis.connectionData` 这些 —— 它们是原插件从 `INFO` 里直接取的原始名字。把模板改成读
 * 驼峰字段要连 CSS 的类名与 `resources/js/connectedChart.js` 一起动（那个脚本按元素 id
 * 取数据），不如在这一层翻译一次。
 *
 * 几个不是直接照搬 `INFO` 的字段单独说明：
 * - `memoryUsage`：**模板同时把它当进度条宽度与百分数文字用**（一行 `style="width: ..."`
 *   的 `<div>`，另一行「占用物理内存的 X」）。故它必须带 `%`，且只能是一个值。
 * - `connectionData`：给 `resources/js/connectedChart.js` 的 JSON 串，形如 `[时间, 连接数][]`。
 *   连上 Redis 只发生在这一次渲染里，没有历史序列可取，故给一个单点。
 * - `Keyspace`：`{{each redis.Keyspace v k}}` 遍历它，故必须是对象（`each` 遍历对象时
 *   `k` 是键、`v` 是值），且值上要有 `keys` / `expires` / `avg_ttl` 三个字段。
 */
export interface TemplateRedis {
  /** 版本号 */
  readonly redis_version: string
  /** 运行时长，`INFO` 里那个 `3天 04:05:06` 形式的串 */
  readonly uptime: string
  /** 是否限制了最大内存；模板据此决定显示「限制」还是「占用物理内存的 X」 */
  readonly maxmemory: string
  /** 已用内存，`INFO` 给的 `1.00M` 这类短串 */
  readonly used_memory_human: string
  /** 峰值内存 */
  readonly used_memory_peak_human: string
  /** 已用内存占上限的百分比，带 `%`；模板既当宽度也当文字 */
  readonly memoryUsage: string
  /** 已连接的客户端数 */
  readonly connected_clients: string
  /** 阻塞的客户端数 */
  readonly blocked_clients: string
  /** 各库的键值统计，键名形如 `db0` */
  readonly Keyspace: Readonly<Record<string, RedisKeyspaceEntry>>
  /** 连接数曲线，JSON 串 */
  readonly connectionData: string
}

/** 磁盘读写速率在模板里的一行 */
interface DiskIoRow {
  /** 设备名 */
  readonly name: string
  /** 读速率，已格式化并带单位后缀的 HTML */
  readonly rIO_sec: string
  /** 写速率 */
  readonly wIO_sec: string
  /** 合计；`si` 有时不给 */
  readonly tIO_sec?: string
}

/** 连通性测试在模板里的一行 */
interface SiteRow {
  /** 显示名 */
  readonly name: string
  /** 状态码的 HTML（带颜色） */
  readonly status: string
  /** 延迟的 HTML（带颜色）；失败时是错误原因 */
  readonly delay: string
}

/** 账号卡片的形状 */
export interface BotCard {
  /** 账号昵称 */
  readonly nickname: string
  /** 头像；取不到时模板会显示一个空框 */
  readonly avatar?: { readonly path: string }
  /** 状态图标的文件名（不含扩展名），如 `在线` */
  readonly status: string
  /** 框架版本 */
  readonly botVersion: string
  /** 已加载的适配器名，用 ` / ` 连接 */
  readonly platform?: string
  /** 本进程已运行时长 */
  readonly botRunTime: string
  /** 联系人计数，键是图标名、值是数字 */
  readonly countContacts: Record<string, string>
  /** 消息计数；当前不填 */
  readonly messageCount: Record<string, string>
}

/**
 * 把一个资源环翻译成模板的形状
 *
 * **是近乎原样的透传，但仍走这一层**：`ResourceRing` 的可选字段（`percentage` /
 * `detailed` / `buffcache`）在模板里都是 `{{if}}` 判空用的，直接展开一个显式的
 * `undefined` 与"这个键不存在"在 art-template 里表现一致，但没有这一层的话，
 * 采集侧一改字段名就会在渲染时炸，而报错点在模板里、离现场很远。
 * @param ring 采集到的环
 * @returns 模板形状的环
 */
export function toTemplateRing(ring: ResourceRing): TemplateRing {
  return {
    title: ring.title,
    inner: ring.inner,
    ...(ring.detailed === undefined ? {} : { detailed: ring.detailed }),
    info: ring.info,
    // 取不到描边时给一个空环：模板里 `stroke-dashoffset:{{group.percentage.per}}`
    // 拿到 undefined 会输出成字符串 `undefined`，那在 SVG 里是无效值、环会整整一圈
    percentage: ring.percentage ?? { per: RING_PERIMETER, color: "var(--low-color)" },
    ...(ring.buffcache === undefined ? {} : { buffcache: ring.buffcache })
  }
}

/**
 * 拼系统信息四格
 * @param view 采集结果
 * @returns `otherInfo`
 */
export function toOtherInfo(view: StateView): StateTemplateData["otherInfo"] {
  const { system } = view
  return {
    // 操作系统：主行给名字，次行给内核版本 —— 一格里放不下两者，分成主次
    osInfo: { main: system.os, ...(system.kernel === "" ? {} : { secondary: `内核 ${system.kernel}` }) },
    hostname: { main: system.hostname },
    // 系统运行时长是主角，本进程的运行时长放次行 —— 排查时两者都要看，但先看前者
    sysTime: { main: system.uptime, secondary: `Bot 已运行 ${view.bot.uptime}` },
    pluginNum: {
      main: `${String(system.pluginCount)} 个`,
      secondary: `${String(system.commandCount)} 条命令 · ${String(system.adapterCount ?? 0)} 个适配器`
    }
  }
}

/**
 * 拼账号卡片
 *
 * **只做一张卡，不做 `BotStatusList` 那个"多账号列表"。** 源插件会为每个 Bot 各出一张卡，
 * 但新内核的多账号是「同一个机器人用不同协议接了两份账号配置」，画成两张几乎一样的卡
 * 只会让人以为是两套系统。当前命令只画使用者说话的那个号。
 * @param view 采集结果
 * @returns 卡片数组（当前恒为一项）
 */
export function toBotCards(view: StateView): BotCard[] {
  const { bot } = view
  /** 联系人计数；取不到的那几项直接不放，模板里 `{{if v}}` 会跳过 */
  const contacts: Record<string, string> = {}
  if (bot.friendCount !== undefined) contacts["好友"] = String(bot.friendCount)
  if (bot.groupCount !== undefined) contacts["群"] = String(bot.groupCount)

  return [
    {
      nickname: bot.nickname,
      ...(bot.avatar === "" ? {} : { avatar: { path: bot.avatar } }),
      status: statusIcon(bot.status),
      botVersion: `v${view.system.version}`,
      platform: view.adapters.map(adapter => adapter.name).join(" / "),
      botRunTime: bot.uptime,
      countContacts: contacts,
      messageCount: {}
    }
  ]
}

/**
 * 把状态中文反推成图标的文件名
 *
 * 模板里写的是 `{{_res_path}}icon/{{$value.status}}.png`，故这里要给出的是**文件名**，
 * 不是文案。图标文件是现成的：在线.png / 离线.png / 连接中.png / 出错.png。
 * 认不出的一律给「离线」—— 那个图标最中性。
 * @param status 状态文案
 * @returns 图标文件名（不含扩展名）
 */
export function statusIcon(status: string): string {
  const known = ["在线", "离线", "连接中", "出错", "未知"]
  return known.includes(status) ? status : "离线"
}

/**
 * 把 `RedisView` 翻译成模板读的那套 `INFO` 键名
 *
 * **这是本插件里唯一一处"名字对不上"需要逐个映射的地方**，其余板块的名字要么本来就一致，
 * 要么在采集层就照模板取的。这里逐个说明几个不能照搬的：
 *
 * - `memoryUsage`：`INFO` 里没有这个键。源插件算的是「已用 / 上限」，没有上限时改用
 *   「已用 / 物理内存总量」。模板把它同时当进度条宽度与百分数文字，故必须带 `%`。
 *   **上限为 0 或缺 `maxmemory` 时不写 `0%`** —— 那会被读成"一点没用"，而真相是
 *   "没有上限可比"；此时按物理内存算，物理内存也取不到才退到 `0%`。
 * - `uptime`：`INFO` 给的是 `uptime_in_seconds`（秒数），模板那一格要的是人话，
 *   故用采集层已经格式化好的那个串。
 * - `connectionData`：`resources/js/connectedChart.js` 要的是一串坐标。这里只在渲染的
 *   那一瞬间连了一次 Redis，拿不到历史，故给一个单点 —— 图上只有一个点，是诚实的呈现
 *   （"只采过一次"）。源插件靠模块级的定时采样攒点，本插件的采样器只采 CPU/内存/网络/IO，
 *   不含连接数，故这里没有历史可给。
 * - `redis_version` / `used_memory_human` / `used_memory_peak_human` / `connected_clients` /
 *   `blocked_clients`：`INFO` 里本来就有，直接取；取不到时给空串而不是 `undefined`，
 *   免得模板印出 `undefined`。
 * @param redis 采集结果
 * @param totalMemoryBytes 物理内存总量，用于没设 `maxmemory` 时算占用比；取不到时 0
 * @returns 模板数据
 */
export function toTemplateRedis(redis: RedisView, totalMemoryBytes: number): TemplateRedis {
  const info = parseInfo(redis.raw)
  const text = (key: string): string => info.get(key) ?? ""

  const usedBytes = infoNumber(info, "used_memory") ?? 0
  const maxBytes = infoNumber(info, "maxmemory") ?? 0
  // 有上限就按上限算，没有就按物理内存算；两者都没有时下限到 0，`memoryUsage` 会是 `0%`
  const basis = maxBytes > 0 ? maxBytes : totalMemoryBytes
  const ratio = basis > 0 ? Math.min(100, (usedBytes / basis) * 100) : 0

  return {
    redis_version: text("redis_version"),
    uptime: redis.uptime,
    // 空串表示"没设限制"，模板里 `{{if !redis.maxmemory}}` 正是这么判断的
    maxmemory: text("maxmemory") === "0" ? "" : text("maxmemory"),
    used_memory_human: text("used_memory_human"),
    used_memory_peak_human: text("used_memory_peak_human"),
    memoryUsage: `${ratio.toFixed(1)}%`,
    connected_clients: text("connected_clients"),
    blocked_clients: text("blocked_clients"),
    Keyspace: redis.keyspace,
    connectionData: JSON.stringify([[Date.now(), redis.clients]])
  }
}

/**
 * 没连上 Redis 时给的空壳
 *
 * 每一项都取"看不出内容"的值而不是 `undefined`：`{{if redis.maxmemory}}` 之类要能正常
 * 判假，`{{each redis.Keyspace}}` 要能正常空转。`connectionData` 给一个空数组的 JSON ——
 * 模板那句 `JSON.parse()` 会照常成功，而图表脚本拿到空数组就画一张空网格。
 * @returns 各字段皆为空的模板数据
 */
function emptyRedis(): TemplateRedis {
  return {
    redis_version: "",
    uptime: "",
    maxmemory: "",
    used_memory_human: "",
    used_memory_peak_human: "",
    memoryUsage: "0%",
    connected_clients: "",
    blocked_clients: "",
    Keyspace: {},
    connectionData: "[]"
  }
}

/**
 * 拼出模板要的一整个对象
 * @param view 采集结果
 * @param chartConfig 交给前端 echarts 的配置，通常是空对象（源插件的 `Config` 只放了主题名）
 * @returns 可直接合并进渲染数据的对象
 */
export function toTemplate(view: StateView, chartConfig: Record<string, unknown> = {}): StateTemplateData {
  return {
    // 这两个必须是 JSON 串，模板里 `JSON.parse()` 它们的原文 —— 见文件头
    chartData: JSON.stringify(view.chart),
    Config: JSON.stringify(chartConfig),
    isPro: view.isPro,
    time: view.time,
    ...(view.backdrop === undefined ? {} : { backdrop: view.backdrop }),
    BotStatusList: toBotCards(view),
    otherInfo: toOtherInfo(view),
    visualData: view.resources.map(toTemplateRing),
    disks: {
      disksSize: view.disks,
      ...(view.disksIO === undefined ? {} : { disksIo: view.disksIO })
    },
    ...(view.network === undefined && view.sites === undefined
      ? {}
      : {
          network: {
            // 模板里写的是 `network.speed.speed.upload` —— 外层那个 `speed` 是"有网速这一块"的
            // 开关，内层那个是数据本身。源插件就是这么套的，此处照搬以免改模板
            ...(view.network === undefined ? {} : { speed: view.network }),
            ...(view.sites === undefined ? {} : { psTest: view.sites })
          }
        }),
    // 见 `TemplateRedis` 与 `style` 的说明：这两个的缺失会让**整张图**渲染不出来，
    // 故不参与上面那种"没有就不给"的写法，一律给足
    redis:
      view.redis === undefined
        ? emptyRedis()
        : toTemplateRedis(view.redis, view.system.totalMemoryBytes),
    ...(view.process === undefined ? {} : { processLoad: view.process }),
    ...(view.fastfetch === undefined ? {} : { fastFetch: view.fastfetch.lines }),
    /*
     * 背景塞进 `style` 而不是留在顶层
     *
     * `templates/state.html` 第 7 行读的是 `{{style.backdrop}}`，而 `monitor.html` 读的是
     * 顶层的 `{{backdrop}}` —— 两张图取自同一份 `collectBackdrop()`，这里让它们落到同一个
     * 位置，免得"监控有背景、状态图没有"这类只在一边显形的毛病。两处都留着：模板没改，
     * 改模板要连着 CSS 一起动。
     */
    style: {
      ...view.style,
      backdrop: view.backdrop ?? ""
    }
  }
}

export type { FastfetchView, ProcessView, DiskView }
