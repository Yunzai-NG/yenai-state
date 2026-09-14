/**
 * 模块职责：`config.ts` 里两个判断函数的测试，外加 schema 本身与源插件配置的字段对齐
 * 依赖方向：被测模块
 * 生命周期：测试
 * 注意事项：**`showFor` 值得单独测，是因为源实现把它抄了七遍且抄错过。** 七处各写一遍
 *          `if (!show || (show === "pro" && !isPro))`，其中网络测试那处的比较顺序还反过。
 *          收敛到这一份之后，这几条断言就是那七处的共同契约。
 *
 *          **schema 的解析结果是 `{ ok, value, issues }`，不是 Zod 那套 `{ success, data }`。**
 *          内核自带的这一层刻意与 Zod 不同名，免得被当成可以互换的东西。缺省值用
 *          `defaults()` 取 —— 那就是"生成初始配置文件"的同一个入口。
 */

import { describe, expect, it } from "vitest"
import { CONFIG_SCHEMA, RESOURCE_ITEMS, showFastFetchFor, showFor } from "./config.js"

describe("showFor", () => {
  it("`true` 在任何情况下都显示", () => {
    expect(showFor("true", false)).toBe(true)
    expect(showFor("true", true)).toBe(true)
  })

  it("`false` 在任何情况下都不显示", () => {
    expect(showFor("false", false)).toBe(false)
    expect(showFor("false", true)).toBe(false)
  })

  it("`pro` 只在状态pro里显示", () => {
    expect(showFor("pro", false)).toBe(false)
    expect(showFor("pro", true)).toBe(true)
  })

  it("缺省或认不出的取值按不显示处理", () => {
    // 配置面板之外还可能被手改 yaml 或被旧版配置覆盖，认不出的值不该被当成「显示」
    expect(showFor(undefined, true)).toBe(false)
    expect(showFor(undefined, false)).toBe(false)
    expect(showFor("", true)).toBe(false)
    expect(showFor("yes", true)).toBe(false)
    expect(showFor("TRUE", true)).toBe(false)
  })
})

describe("showFastFetchFor", () => {
  it("`default` 在非 Windows 上正常显示", () => {
    expect(showFastFetchFor("default", false, false)).toBe(true)
  })

  it("`default` 在 Windows 上只在 Pro 里显示", () => {
    // 源插件的经验：Windows 上多半没装 fastfetch，普通状态图里留个空格子不好看
    expect(showFastFetchFor("default", false, true)).toBe(false)
    expect(showFastFetchFor("default", true, true)).toBe(true)
  })

  it("其余取值退回三态判断，与平台无关", () => {
    expect(showFastFetchFor("true", false, true)).toBe(true)
    expect(showFastFetchFor("false", true, false)).toBe(false)
    expect(showFastFetchFor("pro", false, false)).toBe(false)
    expect(showFastFetchFor("pro", true, false)).toBe(true)
  })

  it("缺省或认不出的取值按不显示处理", () => {
    expect(showFastFetchFor(undefined, true, false)).toBe(false)
    expect(showFastFetchFor("", true, true)).toBe(false)
  })
})

describe("CONFIG_SCHEMA", () => {
  it("缺省值能过自身校验 —— 面板上不改任何一项时也应当是合法的", () => {
    // 一个不合法的缺省值会让插件在没写过配置的机器上直接起不来
    expect(() => CONFIG_SCHEMA.defaults()).not.toThrow()
  })

  it("缺省配置填出了源插件 `state.yaml` 里的每一项", () => {
    /*
     * 字段名与源插件逐一对齐是本插件的明确约定（见 config.ts 文件头）——
     * 从椰奶迁过来的使用者应当能把原来的 yaml 抄进来。故这里逐项断言存在性，
     * 少一项就意味着一次抄不动。
     */
    const cfg = CONFIG_SCHEMA.defaults() as unknown as Record<string, unknown>

    for (const key of [
      "defaultState",
      "noPro",
      "systemResources",
      "showRedisInfo",
      "showFastFetch",
      "chartsCfg",
      "psTestSites",
      "monitor",
      "processLoad",
      "style"
    ]) {
      expect(cfg, `缺字段：${key}`).toHaveProperty(key)
    }
  })

  it("switch 类字段的缺省值落在三态之内", () => {
    const cfg = CONFIG_SCHEMA.defaults()

    // `showFastFetch` 多一个 `default`，故不放进这个循环
    for (const [name, value] of [
      ["showRedisInfo", cfg.showRedisInfo],
      ["chartsCfg.show", cfg.chartsCfg.show],
      ["psTestSites.show", cfg.psTestSites.show],
      ["processLoad.show", cfg.processLoad.show]
    ] as const) {
      expect(["true", "false", "pro"], `${name} 的缺省值非法`).toContain(value)
    }
    expect(["true", "false", "pro", "default"]).toContain(cfg.showFastFetch)
  })

  it("资源环的缺省值都在已实现的那几项之内", () => {
    const chosen = CONFIG_SCHEMA.defaults().systemResources
    const implemented = RESOURCE_ITEMS.map(item => item.value)

    expect(chosen.length).toBeGreaterThan(0)
    for (const item of chosen) {
      // 勾了一个采集侧不认识的环，图上会是一个永远空的格子
      expect(implemented, `未实现的资源环：${item}`).toContain(item)
    }
  })

  it("拒绝落单的非法资源环名", () => {
    expect(CONFIG_SCHEMA.safeParse({ systemResources: ["CPU", "FPGA"] }).ok).toBe(false)
  })

  it("拒绝非法的三态取值", () => {
    expect(CONFIG_SCHEMA.safeParse({ showRedisInfo: "maybe" }).ok).toBe(false)
    expect(CONFIG_SCHEMA.safeParse({ showFastFetch: "always" }).ok).toBe(false)
  })

  it("监控间隔接受时长写法", () => {
    expect(CONFIG_SCHEMA.safeParse({ monitor: { getDataInterval: "30s" } }).ok).toBe(true)
    expect(CONFIG_SCHEMA.safeParse({ monitor: { getDataInterval: "5m" } }).ok).toBe(true)
  })

  it("保留点数有上下限", () => {
    expect(CONFIG_SCHEMA.safeParse({ monitor: { saveDataNumber: 1 } }).ok).toBe(false)
    expect(CONFIG_SCHEMA.safeParse({ monitor: { saveDataNumber: 2000 } }).ok).toBe(false)
    expect(CONFIG_SCHEMA.safeParse({ monitor: { saveDataNumber: 60 } }).ok).toBe(true)
  })

  it("并发数有上下限", () => {
    expect(CONFIG_SCHEMA.safeParse({ psTestSites: { concurNum: 0 } }).ok).toBe(false)
    expect(CONFIG_SCHEMA.safeParse({ psTestSites: { concurNum: 100 } }).ok).toBe(false)
    expect(CONFIG_SCHEMA.safeParse({ psTestSites: { concurNum: 5 } }).ok).toBe(true)
  })

  it("进程个数有上下限", () => {
    const bad = { processLoad: { showMax: { showNum: 0 } } }
    expect(CONFIG_SCHEMA.safeParse(bad).ok).toBe(false)
    expect(CONFIG_SCHEMA.safeParse({ processLoad: { showMax: { showNum: 6 } } }).ok).toBe(true)
  })

  it("高级选项的键名与源插件一致", () => {
    const cfg = CONFIG_SCHEMA.defaults()

    expect(cfg.psTestSites.list).toHaveLength(2)
    expect(cfg.psTestSites.concurNum).toBe(5)
    // 默认过滤掉 Windows 那个"空闲"进程 —— 它的 CPU 占用语义是反的
    expect(cfg.processLoad.filterList).toContain("System Idle Process")
    expect(cfg.processLoad.showMax.order).toBe("mem")
    expect(cfg.style.startColumn).toBe(true)
    expect(cfg.monitor.open).toBe(true)
  })

  it("时长字段在缺省配置里是字符串（`s.duration()` 的读取要经 parseDuration）", () => {
    // 这一条是给 build.ts 里那两处 `parseDuration(...)` 兜底的：若哪天 duration 改成
    // 直接返回数字，那两处会静默按毫秒解释，"60s" 就成了 60 毫秒
    const cfg = CONFIG_SCHEMA.defaults()
    expect(typeof cfg.monitor.getDataInterval).toBe("string")
    expect(typeof cfg.psTestSites.timeout).toBe("string")
  })

  it("缺省配置里没有 URL 为空的白名单项之类会让采集侧崩掉的空值", () => {
    const cfg = CONFIG_SCHEMA.defaults()
    for (const site of cfg.psTestSites.list) {
      expect(site.url).not.toBe("")
      expect(site.name).not.toBe("")
    }
  })
})
