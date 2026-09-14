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
  /** 该账号所用适配器的名字；取不到时不出现 */
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
      // 按状态原文取图标，不是按中文文案 —— 见 statusIcon 的注释
      status: statusIcon(bot.statusKey),
      botVersion: `v${view.system.version}`,
      // 该账号实际用的那一个适配器；取不到时整项不放，模板里 `{{if $value.platform}}` 会跳过
      ...(view.bot.adapterName === "" ? {} : { platform: view.bot.adapterName }),
      botRunTime: bot.uptime,
      countContacts: contacts,
      messageCount: {}
    }
  ]
}

/**
 * 把账号状态映射成在线小圆点的图标文件名
 *
 * 模板里写的是 `{{_res_path}}icon/{{$value.status}}.png`，故这里要给出的是**文件名**。
 *
 * **映射的输入是内核的 `AccountStatus` 原文（`bot.statusKey`），不是那层中文文案。** 源插件的
 * `status` 直接就是 QQ 的状态码（`const { status = 11 } = bot`），模板于是拼出
 * `icon/11.png` —— `icon/` 里那六个 `11/31/41/50/60/70.png` 正是 QQ 的在线状态码。
 * 本移植版把 `status` 改成了中文，若仍拿文案去反推文件名，拼出的是
 * `icon/在线.png`，而图标目录里没有这个文件，圆点就永远是一块空白（实机上撞到过）。
 *
 * 故这里按 `AccountStatus` 的五种取值直接落到源插件那几个码上，中文文案只作展示、
 * 不参与取图标。
 * @param status 内核的 `AccountStatus` 原文
 * @returns 图标文件名（不含扩展名）；只含数字，故不会出现路径分隔符
 */
export function statusIcon(status: string): string {
  /*
   * 五个取值映到源插件的六个状态码里最贴切的那个：
   * 11 = 我在线上，31 = 离开，41 = 隐身，50 = 忙碌，70 = 请勿打扰。
   * `disabled` 用 41（隐身）—— 那个号根本没登，画成隐身最不误导。
   */
  const byStatus: Record<string, string> = {
    online: "11",
    connecting: "31",
    offline: "41",
    error: "50",
    disabled: "41"
  }
  // 认不出的一律给 41：内核之外的状态词（适配器自定义的 `mute` 之类）无从对应，
  // 而「隐身」是几个码里最中性的一个
  return byStatus[status] ?? "41"
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
