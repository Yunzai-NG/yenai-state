/**
 * 模块职责：插件入口 —— 注册「椰奶状态」「椰奶状态pro」与「椰奶监控」两条命令
 * 依赖方向：`@yunzai-ng/core` 的 `definePlugin`、本目录的 collect / view / monitor / config
 * 生命周期：`setup` 时建采样器与命令，随插件卸载由内核一并清理
 * 注意事项：**两条命令共用一个互斥锁。** 状态图要采一圈系统信息、还要等 Chromium 截图，
 *          全过程好几秒；连点两下会同时跑两份采集、渲染两张图，而第二张的答案与第一张
 *          没有区别。源插件用一个模块级 `let interval` 布尔锁挡住，此处把那把锁移到
 *          `setup` 的闭包里 —— 放模块顶层的话，插件热重载后新旧两份代码各持一把锁，
 *          等于没有锁。
 *
 *          **渲染失败要有纯文本兜底。** `ctx.render()` 在没有任何可用渲染器时抛错，
 *          源插件用 `try/catch` + `logger.error` 咽掉了 —— 使用者看到的是「没反应」，
 *          而日志里那句英文他未必看得到。此处失败时回一条纯文本，把最关键的几个数字
 *          说出来：状态图看不见时，「CPU 12%、内存 4.2G/16G」仍然是使用者想要的信息。
 *
 *          **`pro` 与 `debug` 是同一个 action 的两个开关，不是两条命令。** 源实现是
 *          `e.isPro = e.msg.includes("pro")`，本插件用正则的具名捕获组拿到这两个词。
 *          用捕获组而非 `includes`：后者在「#状态debugpro」这种写法上会同时点亮两个，
 *          而那两个词在正则里的先后是明确的。
 */

import { createRequire } from "node:module"
import { join } from "node:path"
import { definePlugin, parseDuration } from "@yunzai-ng/core"
import type { AccountState, BotApi, Logger, MessageEvent } from "@yunzai-ng/types"
import { CONFIG_SCHEMA } from "./config.js"
import type { StateConfigRO } from "./config.js"
import { Monitor } from "./monitor.js"
import { buildState } from "./view/build.js"
import type { StateView } from "./view/build.js"
import { buildMonitor, describeInterval, pointCount } from "./view/monitor.js"
import type { MonitorView } from "./view/monitor.js"
import { toTemplate } from "./view/template.js"
import { collectBackdrop } from "./view/style.js"
import { copyrightLine } from "./collect/system.js"
import { DebugRecorder } from "./util/debug.js"

/** 状态图的模板名（相对本插件的 `templates/` 目录） */
const STATE_TEMPLATE = "state.html"

/** 监控图的模板名 */
const MONITOR_TEMPLATE = "monitor.html"

/** 布局模板的相对路径；旧框架注入 `defaultLayout`，新内核要插件自己给 */
const LAYOUT_FILE = "layout/default.html"

/**
 * 静态资源目录的目录名
 *
 * **`ctx.resource()` 是相对插件根拼的，故这一段要自己带上。** 少写它的症状极具迷惑性：
 * 路径拼得出来、文件不报错、渲染照常成功，只是 `<img>` 指向一个不存在的文件，
 * 图上那一格是空的 —— 而其它资源（图标那类是渲染器按 `<插件根>/resources/` 自己拼的）
 * 全都正常，于是看起来像"就那一张图坏了"。
 *
 * 导出它是为了测试能断言"这两条路径底下真有文件"，而不是比对字符串。
 */
export const RES_DIR = "resources"

/**
 * 状态命令的触发模式
 *
 * 两个具名捕获组就是那两个开关。整体匹配（`^...$`）而非前缀匹配：前缀匹配下
 * 「#状态怎么样」也会命中，而那显然不是在使用这条命令。
 */
const STATE_PATTERN = /^#?(?:椰奶)?状态(?<pro>pro)?(?<debug>debug)?$/

/** 监控命令的触发模式 */
const MONITOR_PATTERN = /^#?椰奶监控$/

/**
 * 被选中的账号
 *
 * 用别名而不是把 `ReturnType<typeof ...>` 那串写在函数签名里：那串在 `pickAccount` 的
 * 一行里出现过两次，本身就有五十多个字符，读的人会先花几秒确认两个是不是同一个类型。
 */
interface PickedAccount {
  /** 账号状态快照 */
  readonly account: AccountState
  /** 该账号的 Bot；未连接时 undefined */
  readonly bot: BotApi | undefined
}

export default definePlugin({
  name: "yenai-state",
  version: "0.1.0",
  description: "椰奶状态 / 状态pro / 监控 —— 机器人运行状况一览",
  author: "Yunzai-NG",
  homepage: "https://github.com/Yunzai-NG/yenai-state",
  configSchema: CONFIG_SCHEMA,

  setup(ctx) {
    const logger = ctx.logger

    /*
     * 启动期只读一次配置
     *
     * 只取采样器启动需要的那几项 —— 那些不随运行期改变。命令执行时另走
     * `ctx.config.get()`：配置可以在 WebUI 里改，把整个对象读一次存下来，
     * 改过之后就会一直跑旧值。
     */
    const startup = ctx.config.get()
    const intervalMs = parseDuration(startup.monitor.getDataInterval, 60_000)

    const monitor = new Monitor({
      intervalMs,
      saveDataNumber: startup.monitor.saveDataNumber,
      persist: startup.monitor.openRedisSaveData,
      logger,
      kv: ctx.kv
    })

    /*
     * 采样定时器
     *
     * `ctx.every()` 的 `overlap` 缺省是 `"skip"`，即上一拍没跑完就跳过这一拍 ——
     * 正是源插件那把 `interval` 布尔锁的语义，由内核保证。卸载时内核摘除定时器，
     * 不必自己 `clearInterval`。
     */
    if (startup.monitor.open) {
      ctx.every(intervalMs, monitor.task())
      /*
       * 立刻采第一拍
       *
       * 否则刚启动后的第一张状态图上，网速与磁盘速率那一块是空的 —— 那两项取自
       * 「最近一次采样」，而第一次采样要等一个完整间隔（缺省 60 秒）之后才发生。
       * 不 await：`setup` 有超时，而采样可能要几百毫秒。
       */
      void monitor.tick().catch((err: unknown) => {
        logger.warn(`首次采样失败：${err instanceof Error ? err.message : String(err)}`)
      })
    }

    /*
     * 两个版本号，给版权行用
     *
     * 框架版本在运行期固定、插件版本更是编译期常量，故在这里取一次即可 —— 与 `startup`
     * 不同，它们不会在 WebUI 里被改。插件版本从自己的 `package.json` 读（`PLUGIN_VERSION`
     * 在文件末尾由 `createRequire` 取），不写死一个字符串：写死的话改了 `package.json`
     * 的版本号、图上还是旧的那个，而那种不一致最难被察觉。
     */
    const versions = { framework: ctx.app.version, plugin: PLUGIN_VERSION }

    /** 互斥锁：同时只渲染一张图，见文件头 */
    let busy = false

    /**
     * 跑一次带锁的任务
     * @param what 这是哪条命令，锁冲突时写进日志
     * @param work 要做的事
     * @returns 跑完即结束；已在跑时立即返回
     */
    const exclusive = async (what: string, work: () => Promise<void>): Promise<void> => {
      if (busy) {
        logger.debug(`上一次渲染还没结束，跳过这次「${what}」`)
        return
      }
      busy = true
      try {
        await work()
      } finally {
        // 放在 finally 里：中途抛错也必须解锁，否则这个插件的图从此再也出不来
        busy = false
      }
    }

    /**
     * 渲染并回复，失败时回纯文本兜底
     *
     * 见文件头第 2 条。`summarize` 为 undefined 时（监控图）没有可概括的数字，
     * 就只说失败原因。
     * @param e 事件
     * @param render 出图的动作
     * @param summarize 失败时用来生成兜底文案
     * @returns 发送完即结束
     */
    const replyImage = async (
      e: MessageEvent,
      render: () => Promise<unknown>,
      summarize: (() => string) | undefined
    ): Promise<void> => {
      try {
        await e.reply((await render()) as never)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        logger.warn(`渲染失败：${reason}`)
        await e.reply(summarize === undefined ? `渲染失败：${reason}` : summarize())
      }
    }

    /**
     * 取本次要画的那个账号
     *
     * 规则是「消息来自哪个号就画哪个号」，取不到退到第一个在线的，再退到第一个。
     * 多号场景下这才是使用者想问的那个 —— 他在 A 号上发「#状态」，想看的是 A。
     * @param e 事件
     * @returns 账号状态快照与它的 Bot；一个账号都没配时 undefined
     */
    const pickAccount = (e: MessageEvent): PickedAccount | undefined => {
      const accounts = ctx.app.accounts.list()
      const mine =
        accounts.find(account => account.record.selfId === e.selfId) ??
        accounts.find(account => account.status === "online") ??
        accounts[0]
      if (mine === undefined) return undefined
      const selfId = mine.record.selfId ?? e.selfId
      return { account: mine, bot: ctx.app.bots.bySelfId(selfId) }
    }

    ctx.command(STATE_PATTERN, { desc: "查看机器人状态；加 pro 显示更多，加 debug 只看耗时" }).action(
      async e => {
        const groups = e.command?.groups ?? {}
        const isPro = groups["pro"] !== undefined
        const isDebug = groups["debug"] !== undefined
        const config = ctx.config.get()

        if (isPro && config.noPro) {
          await e.reply("配置里已禁用 pro 状态图（noPro：true）")
          return
        }

        await exclusive("状态", async () => {
          const recorder = new DebugRecorder(isDebug)
          const picked = pickAccount(e)
          if (picked === undefined) {
            await e.reply("还没有配置任何账号，状态图没有可显示的对象")
            return
          }

          /*
           * 头像要先取，因为取它本身是异步的（要问适配器）
           *
           * 放在 `recorder.time` 之外：那一步计的是采集耗时，而问适配器是网络往返，
           * 混进去会让「采集慢」与「平台响应慢」分不开 —— 后者不是本插件的问题
           */
          const selfId = picked.account.record.selfId ?? e.selfId
          const avatar = await avatarOf(picked.bot, selfId)

          const view = await recorder.time(
            buildState({
              config,
              isPro,
              version: versions.framework,
              pluginVersion: versions.plugin,
              pluginCount: ctx.app.plugins.list().length,
              commandCount: ctx.app.plugins.commands().length,
              adapters: ctx.app.adapters.list().map(adapter => ({ id: adapter.id, name: adapter.name })),
              accounts: ctx.app.accounts.list().map(account => ({
                adapterId: account.record.adapterId,
                status: account.status,
                since: account.since,
                retries: account.retries
              })),
              selfId,
              nickname: picked.account.nickname ?? picked.bot?.nickname ?? "",
              status: picked.account.status,
              since: picked.account.since,
              retries: picked.account.retries,
              ...(avatar === undefined ? {} : { avatarUrl: avatar }),
              monitor,
              http: ctx.http,
              bgDir: ctx.resource(RES_DIR, "img", "bg"),
              defaultAvatar: ctx.resource(RES_DIR, "img", "default_avatar.jpg"),
              logger
            }),
            "buildState"
          )

          if (isDebug) {
            await e.reply(recorder.report())
            return
          }

          await replyImage(
            e,
            () =>
              ctx.render(STATE_TEMPLATE, toTemplateData(view, ctx, config, versions), {
                selector: "#container",
                type: "jpeg",
                quality: 92
              }),
            () => plainSummary(view)
          )
        })
      }
    )

    ctx.command(MONITOR_PATTERN, { desc: "查看 CPU / 内存 / 网络 / 磁盘的占用曲线" }).action(async e => {
      await exclusive("监控", async () => {
        const config = ctx.config.get()
        // 背景与状态图共用同一份取法（含 5 分钟缓存），故两张图的背景是同一张
        const backdrop = await collectBackdrop(
          ctx.http,
          config.style.backdrop,
          config.style.backdropDefault,
          ctx.resource(RES_DIR, "img", "bg"),
          (message, err) =>
            logger.warn(`[背景] ${message}：${err instanceof Error ? err.message : String(err)}`)
        ).catch(() => undefined)

        /*
         * 先把上一次运行存下的曲线读回来，再判断有没有数据
         *
         * `Monitor` 只在第一拍采样时才去读 KV，故一个刚启动、还没到第一拍的进程里
         * `monitor.chart` 是空的 —— 即便 Redis 里存着满满一小时的曲线。少了这一句，
         * 「椰奶监控」在那种情形下会回一句「还没有采到数据，请稍后再试」，
         * 而数据其实就在手边（实机上撞到过）。
         */
        await monitor.restore()
        const view = buildMonitor(monitor, config, backdrop?.css)
        const fresh = pointCount(monitor) === 0
        await replyImage(
          e,
          () =>
            ctx.render(MONITOR_TEMPLATE, toTemplateData(view, ctx, config, versions), {
              selector: "#container",
              type: "jpeg",
              quality: 92
            }),
          // 一条数据都没有时说明原因，否则只说渲染失败 —— 见 view/monitor.ts 的文件头
          fresh
            ? () =>
                config.monitor.open
                  ? `还没有采到数据，${describeInterval(parseDuration(config.monitor.getDataInterval, 60_000))}采一次，请稍后再试`
                  : "监控已关闭（配置里 monitor.open 为 false），开启后才会采样"
            : undefined
        )
      })
    })
  }
})

/**
 * 取这个账号的头像地址
 *
 * 两条来源，顺序与源插件一致：**先问适配器，问不到再按 QQ 号拼接口。**
 *
 *   1. `BotApi.getSelfInfo()` 返回的 `UserInfo.avatar` —— 平台给了就用平台给的。
 *      微信、QQ 频道这类非 QQ 号的适配器只有走这条才有头像
 *   2. 上面没有、且 `selfId` **是纯数字**（即 QQ 号）时，拼 `q1.qlogo.cn` 的固定格式
 *
 * 第 2 条的那个「是纯数字」判断不能省。曾经这里是无条件拼的，于是 stdin 适配器
 * （`selfId` 是 `stdin`）会去请求 `nk=stdin` —— 那当然 404，使用者看到的是那张默认
 * 头像，而不是这个账号该有的样子。源插件写的是 `Number(bot.uin) ? ... : "default"`，
 * 同一个道理。
 *
 * 两条都没结果时回 `undefined`，由 `collect/bot.ts` 落到自带的那张默认头像。
 * @param bot 账号对应的 Bot；未连接时 undefined
 * @param selfId 平台账号 id
 * @returns 头像地址；两条来源都没有时 undefined
 */
export async function avatarOf(bot: BotApi | undefined, selfId: string): Promise<string | undefined> {
  // 平台自己给的最准，优先
  const fromAdapter = await bot
    ?.getSelfInfo()
    .then(info => info.avatar)
    .catch(() => undefined)
  if (fromAdapter !== undefined && fromAdapter !== "") return fromAdapter

  /*
   * 退到 QQ 头像接口
   *
   * `/^\d+$/` 而不是 `Number(selfId)`：后者对 `" "`、`"1e3"`、`"0x10"` 都算数，
   * 而那些都不是 QQ 号；且它把 `"0123"` 与 `"123"` 看成同一个号。
   */
  return /^\d+$/.test(selfId)
    ? `https://q1.qlogo.cn/g?b=qq&s=640&nk=${encodeURIComponent(selfId)}`
    : undefined
}

/**
 * 把采集结果加上模板需要的环境变量
 *
 * **`defaultLayout` 必须由插件自己给。** 旧框架的 `runtime.js` 会往渲染数据里注入它，
 * 新内核的 `prepareData()` 刻意不注入（其注释里写明「该变量应由发起渲染的插件自行填充」），
 * 而模板第一行就是 `{{extend defaultLayout}}`。
 *
 * **用 `ctx.root` 拼，不用 `ctx.resource("..", ...)`。** 后者看着更"正规"，但
 * `resource()` 走的是 `safeJoin()`，而那是**先做词法检查再解析**的 —— 只要路径片段里
 * 出现 `..` 就当场抛「路径越界」，哪怕解析完确实落在插件目录内。`templates/` 是
 * `resources/` 的兄弟目录，要够到它必须往上一级，于是 `resource()` 这条路走不通
 * （实机上是渲染直接失败、回落到纯文本兜底）。`ctx.root` 本来就是插件安装目录的绝对
 * 路径，拿它拼出绝对路径交给渲染器即可 —— 渲染器的 `resolveTemplate` 明说绝对路径原样通行。
 *
 * 顺带把 `StateView` / `MonitorView` 翻译成模板认的那些变量名（见 `view/template.ts` 的文件头）。
 *
 * **`Config` 要把前端脚本读的那几项给全。** 两个脚本都在文件开头就解构 `Config`：
 * `js/chart.js` 读 `Config.chartsCfg.color`，`js/style.js` 读 `Config.style` 的
 * `BotNameColor` / `progressBarColor` / `startColumn` / `botInfoColor` 等项。
 * 少给一项就在那一行抛 `TypeError`，**整个脚本从此不执行** —— 曲线图一块空白、配色全部
 * 落回 CSS 里的默认值（实机上撞到过）。这两项都是使用者的配置，故原样从配置里取。
 *
 * 把整个 `config.style` 递出去而不是逐个挑字段：脚本要哪几项由脚本决定，这里逐个挑
 * 等于把那份清单抄了两遍，脚本那侧一改就漏。`Config` 是 JSON 串，多带的字段无害。
 * @param data 采集结果
 * @param ctx 插件上下文
 * @param config 插件配置
 * @param versions 两个版本号，给版权行用
 * @returns 可直接交给 `ctx.render()` 的数据
 */
export function toTemplateData(
  data: StateView | MonitorView,
  ctx: { readonly root: string },
  config: StateConfigRO,
  versions: { readonly framework: string; readonly plugin: string }
): Record<string, unknown> {
  const translated =
    "resources" in data
      ? toTemplate(data, {
          chartsCfg: { color: [...config.chartsCfg.color] },
          style: config.style
        })
      : data
  /*
   * 版权行提到**顶层**
   *
   * `templates/layout/default.html` 读的是 `{{@copyright}}`，而它是被
   * `{{extend defaultLayout}}` 展开到两张图共用的那一层 —— 故这个键必须在顶层。
   * 采集侧把它挂在 `system.copyright` 上（那是"系统信息板块的内容"这个语境下合理的
   * 归属），于是模板这一侧读到的是 undefined、图上印出字面量 `undefined`。
   *
   * 两张图都要有：监控图上根本没有 `system` 这个字段，只有顶层这一条路给它。
   */
  return {
    ...translated,
    copyright: "resources" in data ? data.system.copyright : copyrightLine(versions.framework, versions.plugin),
    defaultLayout: join(ctx.root, "templates", LAYOUT_FILE),
    // 模板里的 `{{sys.scale}}` 是拼进 `<body>` 的属性。它就是 `style="transform:scale(1)"`，
    // 而缩放由渲染器的 `viewport.scale` 负责 —— 故这里给空串，让那个属性不出现
    sys: { scale: "" }
  }
}

/**
 * 把状态数据说成一段纯文本
 *
 * 这是渲染失败时的兜底，也是「没装渲染器」这种部署下唯一能看到的东西。故它把状态图上
 * 最要紧的几项讲全，而不是只说一句"渲染失败"。
 * @param view 采集结果
 * @returns 纯文本
 */
export function plainSummary(view: StateView): string {
  const lines = [
    "状态图渲染失败，以下是关键数据：",
    `账号：${view.bot.nickname}（${view.bot.uin}）· ${view.bot.status}`,
    `系统：${view.system.os} ${view.system.hostname}`,
    `运行：${view.system.uptime} · Node ${view.system.nodeVersion}`
  ]

  for (const ring of view.resources) {
    lines.push(`${ring.title}：${ring.inner}`)
  }

  if (view.network !== undefined) {
    lines.push(
      `网速：↓${view.network.speed.download.size}${view.network.speed.download.suffix}/s ` +
        `↑${view.network.speed.upload.size}${view.network.speed.upload.suffix}/s`
    )
  }

  for (const disk of view.disks) {
    lines.push(`磁盘 ${disk.mount}：${disk.used} / ${disk.size}（${disk.use}%）`)
  }

  if (view.process !== undefined) {
    lines.push(`进程：共 ${view.process.all} 个，运行中 ${view.process.running} 个`)
  }

  lines.push(`插件 ${view.system.pluginCount} 个 · 命令 ${view.system.commandCount} 条`)
  return lines.join("\n")
}

/**
 * 本插件的版本，从自己的 `package.json` 读
 *
 * 用 `createRequire` 而不是 `import ... with { type: "json" }`：后者要求 import 断言，
 * 而本插件是 `NodeNext` 下编译的 ESM，加断言会让 `tsc` 的 target 与 Node 的最低版本
 * 要求一起往上走，为一个版本号不值得。
 */
export const PLUGIN_VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version

export type { Logger }
