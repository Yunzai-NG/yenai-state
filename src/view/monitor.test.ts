/**
 * 模块职责：`view/monitor.ts` 的测试 —— 采样间隔的中文说明与数据点计数
 * 依赖方向：被测模块
 * 生命周期：测试
 * 注意事项：**这里用的 `Monitor` 是走了构造函数的真实例，而不是一个替身。** 本模块只读
 *          `monitor.chart` 与 `config.monitor.*`，两样都不碰系统 —— 于是可以拿真对象来测，
 *          测的就是"真对象长这样"。用一个手写的假对象反而容易与真类漂移。
 */

import { describe, expect, it } from "vitest"
import { buildMonitor, describeInterval, pointCount } from "./monitor.js"
import { Monitor } from "../monitor.js"
import { CONFIG_SCHEMA } from "../config.js"
import type { Logger } from "@yunzai-ng/types"

/** 什么都不做的日志，只为满足构造参数 */
const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
} as unknown as Logger

/**
 * 造一个采样器
 * @param overrides 要覆盖的构造参数
 * @returns 采样器实例
 */
function makeMonitor(overrides: Partial<ConstructorParameters<typeof Monitor>[0]> = {}): Monitor {
  return new Monitor({
    intervalMs: 60_000,
    saveDataNumber: 60,
    // 关掉持久化：这几条测试不碰 KV
    persist: false,
    logger: silentLogger,
    kv: { get: async () => undefined, set: async () => undefined } as never,
    ...overrides
  })
}

/** 缺省配置，几个 describe 共用一份 */
const config = CONFIG_SCHEMA.defaults()

describe("describeInterval", () => {
  it("不足一分钟按秒说", () => {
    expect(describeInterval(1000)).toBe("每 1 秒")
    expect(describeInterval(30_000)).toBe("每 30 秒")
    expect(describeInterval(59_999)).toBe("每 60 秒")
  })

  it("不足一小时按分钟说", () => {
    expect(describeInterval(60_000)).toBe("每 1 分钟")
    expect(describeInterval(300_000)).toBe("每 5 分钟")
    expect(describeInterval(3_599_999)).toBe("每 60 分钟")
  })

  it("一小时以上按小时说", () => {
    expect(describeInterval(3_600_000)).toBe("每 1 小时")
    expect(describeInterval(7_200_000)).toBe("每 2 小时")
  })

  it("四舍五入到最近的整数", () => {
    expect(describeInterval(1500)).toBe("每 2 秒")
    expect(describeInterval(90_000)).toBe("每 2 分钟")
  })

  it("极小与零也给一个可读的说法，不出现 `每 0 秒` 之外的意外", () => {
    expect(describeInterval(0)).toBe("每 0 秒")
    expect(describeInterval(100)).toBe("每 0 秒")
  })

  it("非有限值不产生 `每 NaN 秒`", () => {
    // 配置里填个非法值时会走到这里，而"每 NaN 秒"会显示在图上
    const out = describeInterval(Number.NaN)
    expect(out).not.toContain("NaN")
  })
})

describe("pointCount", () => {
  it("空采样器是 0", () => {
    expect(pointCount(makeMonitor())).toBe(0)
  })

  it("把六条曲线的点数加起来", () => {
    const monitor = makeMonitor()
    monitor.chart.cpu.push([1, 1], [2, 2])
    monitor.chart.ram.push([1, 1])
    monitor.chart.network.upload.push([1, 1])
    monitor.chart.network.download.push([1, 1], [2, 2])
    monitor.chart.disksIO.readSpeed.push([1, 1], [2, 2], [3, 3])
    monitor.chart.disksIO.writeSpeed.push([1, 1])
    expect(pointCount(monitor)).toBe(10)
  })

  it("只有一条曲线有点时也算有数据", () => {
    const monitor = makeMonitor()
    monitor.chart.cpu.push([1, 50])
    expect(pointCount(monitor)).toBe(1)
  })
})

describe("buildMonitor", () => {

  it("曲线被序列化成 JSON 串（模板里 `JSON.parse()` 它的原文）", () => {
    // 直接塞对象会被 art-template 输出成 `[object Object]`
    const monitor = makeMonitor()
    monitor.chart.cpu.push([1000, 42])
    const view = buildMonitor(monitor, config, undefined)

    expect(typeof view.chartData).toBe("string")
    const parsed = JSON.parse(view.chartData) as { cpu: number[][] }
    expect(parsed.cpu).toEqual([[1000, 42]])
  })

  it("曲线为空时也给合法的 JSON，而不是 undefined", () => {
    const view = buildMonitor(makeMonitor(), config, undefined)
    const parsed = JSON.parse(view.chartData) as Record<string, unknown>
    expect(parsed.cpu).toEqual([])
    expect(parsed.network).toBeDefined()
    expect(parsed.disksIO).toBeDefined()
  })

  it("背景取不到时不出现那一项（模板回落到 CSS 底色）", () => {
    const view = buildMonitor(makeMonitor(), config, undefined)
    expect(view.backdrop).toBeUndefined()
    expect("backdrop" in view).toBe(false)
  })

  it("背景取到时带上", () => {
    const view = buildMonitor(makeMonitor(), config, "url(http://x/a.jpg)")
    expect(view.backdrop).toBe("url(http://x/a.jpg)")
  })

  it("间隔说明与最大点数取自配置", () => {
    const view = buildMonitor(makeMonitor(), config, undefined)
    // 缺省是 60s / 60 个点
    expect(view.interval).toBe("每 1 分钟")
    expect(view.maxPoints).toBe(60)
  })

  it("配置改了就跟着变 —— 不写死在内核里", () => {
    const custom = { ...config, monitor: { ...config.monitor, getDataInterval: "5m", saveDataNumber: 30 } }
    const view = buildMonitor(makeMonitor(), custom, undefined)
    expect(view.interval).toBe("每 5 分钟")
    expect(view.maxPoints).toBe(30)
  })

  it("配置里的间隔非法时退到缺省的 60 秒，而不是崩溃", () => {
    const bad = { ...config, monitor: { ...config.monitor, getDataInterval: "not a duration" } }
    const view = buildMonitor(makeMonitor(), bad, undefined)
    expect(view.interval).toBe("每 1 分钟")
  })
})

describe("从 KV 读回曲线 —— `#椰奶监控` 刚启动那一会儿的数据来源", () => {
  /** 一份存进 KV 的曲线；形状与 `Monitor.chart` 一致 */
  const SAVED = {
    cpu: [[1000, 12]],
    ram: [[1000, 4096]],
    network: { upload: [[1000, 10]], download: [[1000, 20]] },
    disksIO: { readSpeed: [[1000, 5]], writeSpeed: [[1000, 7]] }
  }

  /**
   * 造一个"KV 里存着一份曲线"的采样器
   * @returns 采样器实例
   */
  const withSaved = (): Monitor =>
    makeMonitor({
      persist: true,
      kv: { get: async () => SAVED, set: async () => undefined } as never
    })

  it("读回之前是空的 —— 这正是那条缺陷的现场", async () => {
    // 插件刚起来、还没到第一拍时，`chart` 里一条数据都没有，即便 KV 里存着满满一小时的曲线
    const monitor = withSaved()
    expect(pointCount(monitor)).toBe(0)
  })

  it("读回之后数得出数据点 —— 调用方必须先 await `restore()` 再判断有没有数据", async () => {
    const monitor = withSaved()
    await monitor.restore()
    // 六个序列各一个点
    expect(pointCount(monitor)).toBe(6)
  })

  it("读回后 `buildMonitor` 给出的曲线是满的，而不是一张空网格", async () => {
    /*
     * 这条盯的是实机上撞到的那个缺陷：`buildMonitor` 不 await `restore()`，于是
     * `#椰奶监控` 在重启后的第一次调用里回一句「还没有采到数据，请稍后再试」——
     * 而数据就在手边。`pointCount` 是 `index.ts` 里判断 fresh 的那一句。
     */
    const monitor = withSaved()
    await monitor.restore()
    const fresh = pointCount(monitor) === 0
    expect(fresh).toBe(false)
    expect(JSON.parse(buildMonitor(monitor, config, undefined).chartData).cpu).toHaveLength(1)
  })

  it("`restore()` 是幂等的，连着调两次不会把曲线叠成两份", async () => {
    const monitor = withSaved()
    await monitor.restore()
    await monitor.restore()
    expect(pointCount(monitor)).toBe(6)
  })

  it("没开持久化时 `restore()` 什么也不做", async () => {
    const monitor = makeMonitor({ persist: false })
    await monitor.restore()
    expect(pointCount(monitor)).toBe(0)
  })
})
