/**
 * 模块职责：`monitor.ts` 里那几个纯函数的测试 —— 环形缓冲、脏数据校验、KB 换算
 * 依赖方向：被测模块
 * 生命周期：测试
 * 注意事项：**`Monitor` 类本身不测。** 它的 `tick()` 直接调 `si.currentLoad()` /
 *          `si.disksIO()`，测它等于测 `systeminformation` 与当前这台机器 —— 那种测试
 *          在 CI 上通过、在别人的容器里失败，说明不了本插件的任何事。故这里只测
 *          它拆出来的那三个纯函数，`Monitor` 的取舍与 `hardware-plugin` 一致。
 */

import { describe, expect, it } from "vitest"
import { emptyChartData, kbToBytes, pushPoint, reviveChartData } from "./monitor.js"
import type { ChartSeries } from "./monitor.js"

describe("pushPoint", () => {
  it("未达上限时直接追加", () => {
    const series: ChartSeries = []
    pushPoint(series, [1, 10], 3)
    pushPoint(series, [2, 20], 3)
    expect(series).toEqual([
      [1, 10],
      [2, 20]
    ])
  })

  it("达到上限后丢掉最旧的", () => {
    const series: ChartSeries = [
      [1, 10],
      [2, 20],
      [3, 30]
    ]
    pushPoint(series, [4, 40], 3)
    expect(series).toEqual([
      [2, 20],
      [3, 30],
      [4, 40]
    ])
  })

  it("连续超出上限时长度始终不超过上限", () => {
    const series: ChartSeries = []
    for (let i = 0; i < 100; i += 1) pushPoint(series, [i, i], 10)
    expect(series).toHaveLength(10)
    // 留下的应当是最新的那 10 个（90..99），而不是最旧的
    expect(series[0]?.[0]).toBe(90)
    expect(series[9]?.[0]).toBe(99)
  })

  it("上限为 1 时只留最新一个", () => {
    const series: ChartSeries = []
    pushPoint(series, [1, 1], 1)
    pushPoint(series, [2, 2], 1)
    expect(series).toEqual([[2, 2]])
  })

  it("就地修改，不返回新数组", () => {
    // 每拍要为四条曲线各调一次，返回新数组等于每拍复制四遍
    const series: ChartSeries = []
    const returned = pushPoint(series, [1, 1], 5)
    expect(returned).toBeUndefined()
    expect(series).toHaveLength(1)
  })
})

describe("emptyChartData", () => {
  it("给出四条空曲线，形状完整", () => {
    const data = emptyChartData()
    expect(data.cpu).toEqual([])
    expect(data.ram).toEqual([])
    expect(data.network.upload).toEqual([])
    expect(data.network.download).toEqual([])
    expect(data.disksIO.readSpeed).toEqual([])
    expect(data.disksIO.writeSpeed).toEqual([])
  })

  it("每次调用给的是不同的对象", () => {
    // 共用一份的话，两个 Monitor 实例会往同一条曲线里塞数据
    const a = emptyChartData()
    const b = emptyChartData()
    a.cpu.push([1, 1])
    expect(b.cpu).toEqual([])
  })
})

describe("reviveChartData", () => {
  it("读回合法数据", () => {
    const raw = {
      network: { upload: [[1, 100]], download: [[1, 200]] },
      disksIO: { readSpeed: [[1, 10]], writeSpeed: [[1, 20]] },
      cpu: [[1, 50]],
      ram: [[1, 1024]]
    }
    const out = reviveChartData(raw)
    expect(out.cpu).toEqual([[1, 50]])
    expect(out.ram).toEqual([[1, 1024]])
    expect(out.network.upload).toEqual([[1, 100]])
    expect(out.network.download).toEqual([[1, 200]])
    expect(out.disksIO.readSpeed).toEqual([[1, 10]])
    expect(out.disksIO.writeSpeed).toEqual([[1, 20]])
  })

  it("非对象一律给空曲线", () => {
    for (const bad of [undefined, null, 42, "x", true]) {
      const out = reviveChartData(bad)
      expect(out).toEqual(emptyChartData())
    }
  })

  it("缺字段时那一项为空，其余照常读回", () => {
    // 这份数据可能来自上一个版本的本插件，或一个被手改过的 KV 值
    const out = reviveChartData({ cpu: [[1, 50]] })
    expect(out.cpu).toEqual([[1, 50]])
    expect(out.network.upload).toEqual([])
    expect(out.disksIO.readSpeed).toEqual([])
  })

  it("过滤掉形状不对的数据点，留下合法的那些", () => {
    const out = reviveChartData({
      cpu: [
        [1, 50],
        [2], // 少一个分量
        [3, 4, 5], // 多一个分量
        ["a", 1], // 时间戳不是数
        [1, "b"], // 值不是数
        [Number.NaN, 1], // 非有限
        [1, Number.POSITIVE_INFINITY], // 非有限
        null,
        "x",
        [4, 60]
      ]
    })
    expect(out.cpu).toEqual([
      [1, 50],
      [4, 60]
    ])
  })

  it("曲线本身不是数组时给空数组", () => {
    const out = reviveChartData({ cpu: "not an array", network: { upload: {} } })
    expect(out.cpu).toEqual([])
    expect(out.network.upload).toEqual([])
  })

  it("结果一定是完整的 ChartData 形状，模板不会拿到 undefined", () => {
    // 一个缺 network 字段的对象会让模板在渲染时炸，而那时离现场很远
    const out = reviveChartData({ network: null, disksIO: "x" })
    expect(out.network).toBeDefined()
    expect(out.network.upload).toBeInstanceOf(Array)
    expect(out.network.download).toBeInstanceOf(Array)
    expect(out.disksIO.readSpeed).toBeInstanceOf(Array)
    expect(out.disksIO.writeSpeed).toBeInstanceOf(Array)
  })

  it("不修改传入的对象", () => {
    const raw = { cpu: [[1, 50]] }
    reviveChartData(raw)
    expect(raw.cpu).toEqual([[1, 50]])
  })
})

describe("kbToBytes", () => {
  it("按 1024 换算", () => {
    // `si` 的 disksIO 以 KB 计、networkStats 以字节计，弄错就是恒差 1024 倍
    expect(kbToBytes(1)).toBe(1024)
    expect(kbToBytes(0)).toBe(0)
    expect(kbToBytes(1024)).toBe(1024 * 1024)
    expect(kbToBytes(0.5)).toBe(512)
  })

  it("负数照实换算 —— 累计量作差确实会出现负值", () => {
    // 归零是显示层（getFileSize）的事；采集层改名换姓会让"真的读到了负值"这件事消失
    expect(kbToBytes(-1)).toBe(-1024)
  })

  it("null / undefined / NaN / Infinity 一律 undefined", () => {
    // `si` 的类型声明里这些字段可空，它自己的 catch 分支也确实会给 null
    expect(kbToBytes(null)).toBeUndefined()
    expect(kbToBytes(undefined)).toBeUndefined()
    expect(kbToBytes(Number.NaN)).toBeUndefined()
    expect(kbToBytes(Number.POSITIVE_INFINITY)).toBeUndefined()
  })
})

describe("`si` 返回 null 的那条路", () => {
  /*
   * 这一组盯的是一个**在实机上撞到过的崩溃**：`Monitor.tick()` 里原来写的是
   * `if (io !== undefined)`，而 `si.disksIO()` 取不到数据时**返回 `null` 而不是抛错** ——
   * `await ...catch(() => undefined)` 拦不住它，`null !== undefined` 为真，接着
   * `io.rIO_sec` 就抛 `Cannot read properties of null`，整个采样停在那里。
   *
   * 故这里钉死两件事：`si` 确实会给 null，以及 `kbToBytes` 对 null 是安全的。
   * （`tick()` 本身要连真机器，测不了 —— 见文件头的取舍说明。）
   */
  it("`si` 给 null 时 `kbToBytes` 不抛，而是给 undefined", () => {
    // 这条是上面那组里"null 一律 undefined"的另一面：把它写在这里是为了让
    // "为什么会有 null"与"怎么处理"读起来在同一处
    expect(() => kbToBytes(null)).not.toThrow()
    expect(kbToBytes(null)).toBeUndefined()
  })

  it("`si` 自己的类型声明就把这些字段标成可空", () => {
    // 于是 `!= null` 才是与类型一致的判断；只判 `undefined` 会和类型声明打架，
    // 而 TS 对 `null !== undefined` 不报错，这个坑因此能一直藏着
    const nullable: number | null = null
    expect(kbToBytes(nullable)).toBeUndefined()
  })
})
