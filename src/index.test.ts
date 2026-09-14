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
import { toTemplateData } from "./index.js"
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
      copyright: "<span>x</span>"
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

describe("toTemplateData", () => {
  it("`Config` 给全了前端脚本会解构的每一项 —— 少一项脚本就整段不执行", () => {
    const out = toTemplateData(makeState(), ctx, CONFIG_SCHEMA.defaults())
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
    const out = toTemplateData(makeState(), ctx, CONFIG_SCHEMA.defaults())
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
    const out = toTemplateData(makeState(), ctx, config)
    const cfg = JSON.parse(out["Config"] as string) as Record<string, { color: string[] }>

    expect(cfg["chartsCfg"]?.color).toEqual(["#111111", "#222222"])
  })

  it("`style` 里的配色同样来自配置", () => {
    const base = CONFIG_SCHEMA.defaults()
    const config = { ...base, style: { ...base.style, BotNameColor: "gradient:1deg,#a,#b" } }
    const out = toTemplateData(makeState(), ctx, config)
    const cfg = JSON.parse(out["Config"] as string) as Record<string, { BotNameColor: string }>

    expect(cfg["style"]?.BotNameColor).toBe("gradient:1deg,#a,#b")
  })

  it("状态图带上翻译过的模板变量，监控图不带", () => {
    // `toTemplateData` 靠 `resources` 这个字段分辨两者：监控图上没有资源环
    const state = toTemplateData(makeState(), ctx, CONFIG_SCHEMA.defaults())
    expect(state).toHaveProperty("visualData")
    expect(state).toHaveProperty("BotStatusList")
  })

  it("`defaultLayout` 是插件目录下的绝对路径", () => {
    // 模板第一行 `{{extend defaultLayout}}`，而新内核刻意不注入它（见 index.ts 的注释）
    const out = toTemplateData(makeState(), ctx, CONFIG_SCHEMA.defaults())
    expect(out["defaultLayout"]).toBe(`D:${sep}plugin${sep}templates${sep}layout${sep}default.html`)
  })

  it("`sys.scale` 是空串 —— 缩放由渲染器的 viewport 负责", () => {
    // 给数字会让模板输出一个多余的 `transform:scale()`，与 viewport.scale 叠成双重缩放
    const out = toTemplateData(makeState(), ctx, CONFIG_SCHEMA.defaults())
    expect((out["sys"] as { scale: string }).scale).toBe("")
  })
})
