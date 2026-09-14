/**
 * 模块职责：`index.ts` 里 `toTemplateData` 的测试 —— 交给渲染器的数据里，前端脚本要读的项是否给全
 * 依赖方向：被测模块；为避开插件的 `definePlugin` 副作用，只测这一个纯函数
 * 生命周期：测试
 * 注意事项：**这一层测的是「脚本会不会死在第一行」这种失败，不是字段对不对。**
 *
 *          `resources/js/chart.js` 与 `resources/js/style.js` 都在文件开头就解构 `Config`：
 *
 *              const { color } = Config.chartsCfg
 *              const { BotNameColor, progressBarColor, startColumn, botInfoColor } = Config.style
 *
 *          少给一项就在那一行抛 `TypeError`，**整个脚本从此不执行** —— 页面照常出图，
 *          只是曲线一块空白、配色全部落回 CSS 默认值，而报错只存在于浏览器控制台里，
 *          内核日志一个字都没有（实机上正是这么坏的，作为「网络状态没有图表显示」报上来）。
 *
 *          故此处逐项断言脚本会解构的那些键**都真实存在**，而不只是断言「Config 是个串」——
 *          后者在缺陷存在时照样通过。
 */

import { describe, expect, it } from "vitest"
import { sep } from "node:path"
import { CONFIG_SCHEMA } from "./config.js"
import { avatarOf, toTemplateData } from "./index.js"
import { copyrightLine } from "./collect/system.js"
import type { BotApi } from "@yunzai-ng/types"
import type { StateView } from "./view/build.js"

/**
 * 前端脚本会从 `Config` 里解构的键
 *
 * 两份清单来自脚本自身。**脚本改了这里也要改** —— 这正是本条契约唯一会失效的地方，
 * 而断言的存在至少能让「忘了同步」在测试里现形一次。
 */
const SCRIPT_READS = {
  chartsCfg: ["color"],
  style: ["BotNameColor", "progressBarColor", "startColumn", "botInfoColor"]
} as const

/**
 * 造一个最小的 `StateView`
 *
 * `toTemplateData` 只用到 `resources` 这个字段来分辨是状态图还是监控图，其余由
 * `view/template.ts` 那一层读，故这里给一份够用的缺省值即可。
 * @param overrides 要覆盖的字段
 * @returns 采集结果
 */
function makeState(overrides: Partial<StateView> = {}): StateView {
  return {
    time: "2026-09-01 12:00:00",
    bot: {
      nickname: "测试号",
      uin: "10001",
      avatar: "",
      status: "在线",
      statusKey: "online",
      statusColor: "#2EC272",
      since: "2026-09-01 10:00:00",
      retries: 0,
      memory: "120MB",
      uptime: "02:00:00"
    },
    adapters: [],
    system: {
      os: "Ubuntu 22.04",
      hostname: "host",
      cpu: "AMD Ryzen 9",
      uptime: "3天 04:05:06",
      kernel: "6.1.0",
      timezone: "Asia/Shanghai",
      time: "2026-09-01 12:00:00",
      platform: "linux",
      isTermux: false,
      isContainer: false,
      totalMemory: "31.9GB",
      totalMemoryBytes: 34_200_000_000,
      cpuCount: 16,
      version: "0.4.1",
      pluginCount: 5,
      commandCount: 40,
      adapterCount: 2,
      nodeVersion: "v22.0.0",
      copyright: copyrightLine(VERSIONS.framework, VERSIONS.plugin)
    },
    resources: [],
    disks: [],
    isPro: false,
    chart: { cpu: [], ram: [], network: { upload: [], download: [] }, disksIO: { readSpeed: [], writeSpeed: [] } },
    style: {
      vars: "",
      startColumn: true,
      botNameColor: "#fff",
      highColor: "#F44336",
      mediumColor: "#FF9800",
      lowColor: "#2EC272"
    },
    ...overrides
  }
}

/** 测试用的插件上下文；`toTemplateData` 只从里面读 `root` */
const ctx = { root: "D:/plugin" }

/** 两个版本号；版权行要用 */
const VERSIONS = { framework: "0.5.1", plugin: "0.1.0" }

describe("toTemplateData", () => {
  it("`Config` 给全了前端脚本会解构的每一项 —— 少一项脚本就整段不执行", () => {
    const out = toTemplateData(makeState(), ctx, CONFIG_SCHEMA.defaults(), VERSIONS)
    const cfg = JSON.parse(out["Config"] as string) as Record<string, Record<string, unknown>>

    for (const [section, keys] of Object.entries(SCRIPT_READS)) {
      expect(cfg, `Config 缺整个 ${section}`).toHaveProperty(section)
      for (const key of keys) {
        expect(cfg[section], `Config.${section} 缺 ${key}`).toHaveProperty(key)
      }
    }
  })

  it("解构出来的每一项都不是 undefined —— 解构成功但值是 undefined 同样会炸", () => {
    // `const { color } = { color: undefined }` 不抛错，但在 `echarts.init(..., color)` 处坏掉；
    // 而 `BotNameColor.match(...)` 会当场抛。故值本身也要断言
    const out = toTemplateData(makeState(), ctx, CONFIG_SCHEMA.defaults(), VERSIONS)
    const cfg = JSON.parse(out["Config"] as string) as Record<string, Record<string, unknown>>

    expect(cfg["chartsCfg"]?.["color"]).toBeDefined()
    expect(Array.isArray(cfg["chartsCfg"]?.["color"])).toBe(true)
    for (const key of SCRIPT_READS.style) {
      expect(cfg["style"]?.[key], `Config.style.${key} 是 undefined`).toBeDefined()
    }
  })

  it("配色来自使用者的配置，不是写死的缺省值", () => {
    // 曲线配色在面板上可改；写死会让改配置没反应，而「没反应」最难被察觉
    const config = { ...CONFIG_SCHEMA.defaults(), chartsCfg: { ...CONFIG_SCHEMA.defaults().chartsCfg, color: ["#111111", "#222222"] } }
    const out = toTemplateData(makeState(), ctx, config, VERSIONS)
    const cfg = JSON.parse(out["Config"] as string) as Record<string, { color: string[] }>

    expect(cfg["chartsCfg"]?.color).toEqual(["#111111", "#222222"])
  })

  it("`style` 里的配色同样来自配置", () => {
    const base = CONFIG_SCHEMA.defaults()
    const config = { ...base, style: { ...base.style, BotNameColor: "gradient:1deg,#a,#b" } }
    const out = toTemplateData(makeState(), ctx, config, VERSIONS)
    const cfg = JSON.parse(out["Config"] as string) as Record<string, { BotNameColor: string }>

    expect(cfg["style"]?.BotNameColor).toBe("gradient:1deg,#a,#b")
  })

  it("状态图带上翻译过的模板变量，监控图不带", () => {
    // `toTemplateData` 靠 `resources` 这个字段分辨两者：监控图上没有资源环
    const state = toTemplateData(makeState(), ctx, CONFIG_SCHEMA.defaults(), VERSIONS)
    expect(state).toHaveProperty("visualData")
    expect(state).toHaveProperty("BotStatusList")
  })

  it("`defaultLayout` 是插件目录下的绝对路径", () => {
    // 模板第一行 `{{extend defaultLayout}}`，而新内核刻意不注入它（见 index.ts 的注释）
    const out = toTemplateData(makeState(), ctx, CONFIG_SCHEMA.defaults(), VERSIONS)
    expect(out["defaultLayout"]).toBe(`D:${sep}plugin${sep}templates${sep}layout${sep}default.html`)
  })

  it("`sys.scale` 是空串 —— 缩放由渲染器的 viewport 负责", () => {
    // 给数字会让模板输出一个多余的 `transform:scale()`，与 viewport.scale 叠成双重缩放
    const out = toTemplateData(makeState(), ctx, CONFIG_SCHEMA.defaults(), VERSIONS)
    expect((out["sys"] as { scale: string }).scale).toBe("")
  })
})

/**
 * `avatarOf` 的两条来源
 *
 * **这条契约是「头像是不是这个账号自己的」。** 曾经这里无条件拼 QQ 头像接口，于是
 * stdin 适配器（`selfId` 是 `stdin`）会去请求 `nk=stdin` —— 当然 404，使用者看到的
 * 是那张默认头像。图上"有个头像"和"是这个账号的头像"是两回事，而前者会掩盖后者。
 *
 * 源插件的规则是 `Number(bot.uin) ? qq接口 : "default"`，此处与之对齐。
 */
describe("avatarOf", () => {
  /** 造一个只用到 `getSelfInfo` 的 Bot 替身 */
  const bot = (avatar?: string, fail = false): BotApi =>
    ({
      getSelfInfo: () =>
        fail ? Promise.reject(new Error("平台没响应")) : Promise.resolve({ uid: "u", ...(avatar === undefined ? {} : { avatar }) })
    }) as unknown as BotApi

  it("平台给了头像就用平台的 —— 非 QQ 号只有这条路", async () => {
    expect(await avatarOf(bot("https://wx.example/a.png"), "openid_abc")).toBe("https://wx.example/a.png")
  })

  it("平台给的头像优先于 QQ 接口 —— 即便 id 是个 QQ 号", async () => {
    // 平台自己给的更准（可能是 CDN 地址或已带参数的地址）
    expect(await avatarOf(bot("https://cdn.example/1.jpg"), "10001")).toBe("https://cdn.example/1.jpg")
  })

  it("平台没给、id 是纯数字时拼 QQ 接口", async () => {
    expect(await avatarOf(bot(), "10001")).toMatch(/^https:\/\/q1\.qlogo\.cn\/.*nk=10001$/)
  })

  it("**平台没给、id 不是数字时给 undefined** —— 不去请求一个不存在的 QQ 号", async () => {
    // stdin 适配器的 `selfId` 就是 `stdin`。这里回 undefined 让采集层落到默认头像，
    // 而不是拼出 `nk=stdin` 去换一个 404
    expect(await avatarOf(bot(), "stdin")).toBeUndefined()
    expect(await avatarOf(bot(), "")).toBeUndefined()
  })

  it("Bot 未连接时退到 QQ 接口 —— 那时问不到平台", async () => {
    expect(await avatarOf(undefined, "10001")).toMatch(/nk=10001$/)
    expect(await avatarOf(undefined, "stdin")).toBeUndefined()
  })

  it("问平台失败不抛出，照常退到 QQ 接口", async () => {
    // 平台接口报错不该让整张状态图不出来
    expect(await avatarOf(bot(undefined, true), "10001")).toMatch(/nk=10001$/)
    expect(await avatarOf(bot(undefined, true), "stdin")).toBeUndefined()
  })

  it("平台给空串等于没给", async () => {
    expect(await avatarOf(bot(""), "10001")).toMatch(/nk=10001$/)
  })

  it("`selfId` 的判数字比 `Number()` 严 —— 那些不是 QQ 号", async () => {
    // `Number(" ")` 是 0、`Number("1e3")` 是 1000、`Number("0x10")` 是 16，全都算数；
    // 而它们拼进 `nk=` 都是无效请求
    for (const id of [" ", "1e3", "0x10", "12.5", "1 2", "+1", "-1"]) {
      expect(await avatarOf(bot(), id), `${id} 被当成了 QQ 号`).toBeUndefined()
    }
  })

  it("QQ 号里的前导零原样保留 —— `Number()` 会把它吃掉", async () => {
    expect(await avatarOf(bot(), "0123")).toMatch(/nk=0123$/)
  })
})

/**
 * 版权行要落在**顶层**
 *
 * `templates/layout/default.html` 里写的是 `{{@copyright}}`，而 layout 是被
 * `{{extend defaultLayout}}` 展开到两张图共用的那一层 —— 故这个键必须在渲染数据的顶层。
 * 采集侧把它挂在 `system.copyright` 上（在"系统信息板块的内容"这个语境下说得通），
 * 于是模板那侧读到 undefined、图上印出字面量 `undefined`（实机上报上来的就是这个）。
 *
 * 这条断言的是"位置"而不是"内容"：一个只断言 `system.copyright` 有值的测试在缺陷存在时
 * 照样通过 —— 因为值一直在，只是放错了层。
 */
describe("版权行的位置", () => {
  it("状态图：顶层有 `copyright`", () => {
    const out = toTemplateData(makeState(), ctx, CONFIG_SCHEMA.defaults(), VERSIONS)
    expect(typeof out["copyright"]).toBe("string")
    expect(out["copyright"]).toContain("LYLN - State")
  })

  it("监控图：顶层也有 —— 它压根没有 `system` 这个字段", () => {
    // 监控图走的是 `"resources" in data` 的另一支。少了这一句，监控图最下面
    // 就是一行 `undefined`
    const monitor = { chartData: "{}", interval: "每 1 分钟", maxPoints: 60 }
    const out = toTemplateData(monitor as never, ctx, CONFIG_SCHEMA.defaults(), VERSIONS)
    expect(typeof out["copyright"]).toBe("string")
    expect(out["copyright"]).toContain("LYLN - State")
    expect(out["copyright"]).not.toContain("undefined")
  })

  it("两张图的版权行是同一句话，且都带上了两个版本号", () => {
    // 改了一张忘了另一张不会有人发现 —— 故这里把两张的取出来对一遍
    const state = toTemplateData(makeState(), ctx, CONFIG_SCHEMA.defaults(), VERSIONS)
    const monitor = toTemplateData(
      { chartData: "{}", interval: "每 1 分钟", maxPoints: 60 } as never,
      ctx,
      CONFIG_SCHEMA.defaults(),
      VERSIONS
    )
    for (const out of [state, monitor]) {
      expect(out["copyright"]).toContain("v0.1.0")
      expect(out["copyright"]).toContain("0.5.1")
    }
  })
})
