/**
 * 模块职责：`collect/resources.ts` 里几个纯函数的测试 —— 环的换算、虚拟显卡判名、显卡名匹配
 * 依赖方向：被测模块
 * 生命周期：测试
 * 注意事项：**`toRing` 的阈值分档是这一排环上唯一"会自己变色"的东西。** 阈值是 0.9 与 0.8，
 *          比磁盘的 90 / 70 更严格 —— 一个 85% 的 CPU 只是忙，而一块 85% 的盘该提醒。
 *          同一个数字在不同东西上含义不同，故这两组阈值不该被"统一"。
 */

import { describe, expect, it } from "vitest"
import { HIGH_THRESHOLD, MEDIUM_THRESHOLD, RING_PERIMETER, looksFakeGpu, namesMatch, toRing } from "./resources.js"

describe("toRing", () => {
  it("占用 0 时偏移是整周长（环不画）", () => {
    expect(toRing(0, undefined).per).toBe(RING_PERIMETER)
  })

  it("占用 1 时偏移是 0（整圈）", () => {
    expect(toRing(1, undefined).per).toBe(0)
  })

  it("占用一半时偏移是一半", () => {
    expect(toRing(0.5, undefined).per).toBeCloseTo(RING_PERIMETER / 2, 10)
  })

  it("达到 0.9 用高危色", () => {
    expect(toRing(0.9, "#abc").color).toBe("var(--high-color)")
    expect(toRing(0.95, "#abc").color).toBe("var(--high-color)")
  })

  it("达到 0.8 用警戒色", () => {
    expect(toRing(0.8, "#abc").color).toBe("var(--medium-color)")
    expect(toRing(0.89, "#abc").color).toBe("var(--medium-color)")
  })

  it("未到阈值用使用者的配色", () => {
    expect(toRing(0, "#abc").color).toBe("#abc")
    expect(toRing(0.79, "#abc").color).toBe("#abc")
  })

  it("使用者配色缺失时回落到 CSS 变量", () => {
    expect(toRing(0.5, undefined).color).toBe("var(--low-color)")
  })

  it("阈值比磁盘的更严格 —— 85% 的 CPU 只是忙，85% 的盘该提醒", () => {
    // 资源环用 0.9 / 0.8，磁盘用 90 / 70
    expect(HIGH_THRESHOLD).toBe(0.9)
    expect(MEDIUM_THRESHOLD).toBe(0.8)
    expect(toRing(0.85, undefined).color).toBe("var(--medium-color)")
  })

  it("超出 0-1 的一律截断", () => {
    // 这个值直接进 SVG 的 `stroke-dashoffset`，负数会让环反向绕出来
    expect(toRing(-1, undefined).per).toBe(RING_PERIMETER)
    expect(toRing(2, undefined).per).toBe(0)
    expect(toRing(1.5, undefined).color).toBe("var(--high-color)")
  })

  it("非有限值按 0 处理", () => {
    // `NaN / NaN` 在取不到数据时确实会出现，而 `NaN` 传进 SVG 会让环整个消失
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(toRing(bad, undefined).per).toBe(RING_PERIMETER)
      expect(toRing(bad, undefined).color).toBe("var(--low-color)")
    }
  })

  it("周长与模板 CSS 里的半径一致", () => {
    // 半径 88 是写死在 CSS 里的；改了这里而没改 CSS，环会画不圆
    expect(RING_PERIMETER).toBeCloseTo(3.14 * 88, 10)
  })

  it("与磁盘环的周长不同 —— 两者半径不同，共用一个常量会让其中一个画不对", () => {
    expect(RING_PERIMETER).not.toBeCloseTo(3.14 * 54, 10)
  })
})

describe("looksFakeGpu", () => {
  it("认出常见的虚拟显示器", () => {
    for (const name of [
      "Virtual Display",
      "USB Mobile Monitor Virtual Display",
      "IddSampleDriver Device",
      "ToDesk Virtual Display",
      "GameViewer Virtual Display",
      "Parsec Virtual Display Adapter",
      "Sunshine Virtual Display",
      "Oray Virtual Display",
      "Microsoft Basic Display Adapter",
      "Mirror Driver"
    ]) {
      expect(looksFakeGpu(name), `该排掉：${name}`).toBe(true)
    }
  })

  it("不误伤真实显卡", () => {
    for (const name of [
      "NVIDIA GeForce RTX 4090",
      "AMD Radeon RX 7900 XTX",
      "Intel(R) UHD Graphics 630",
      "Apple M2 Pro"
    ]) {
      expect(looksFakeGpu(name), `不该排掉：${name}`).toBe(false)
    }
  })

  it("大小写不敏感", () => {
    expect(looksFakeGpu("VIRTUAL DISPLAY")).toBe(true)
    expect(looksFakeGpu("todesk Mirror")).toBe(true)
  })

  it("空名字不算虚拟 —— 那由调用处的 `name !== ''` 判断管", () => {
    expect(looksFakeGpu("")).toBe(false)
  })
})

describe("namesMatch", () => {
  it("完全相同算同一块", () => {
    expect(namesMatch("RTX 4090", "RTX 4090")).toBe(true)
  })

  it("包含式比较：nvidia-smi 报全名而 `si` 可能只报型号", () => {
    // 精确比较会让型号总是配不上，表现为环下那行字退化成 nvidia-smi 的啰嗦名字
    expect(namesMatch("NVIDIA GeForce RTX 4090", "RTX 4090")).toBe(true)
    expect(namesMatch("RTX 4090", "NVIDIA GeForce RTX 4090")).toBe(true)
  })

  it("大小写不敏感", () => {
    expect(namesMatch("rtx 4090", "RTX 4090")).toBe(true)
  })

  it("首尾空白被忽略", () => {
    expect(namesMatch("  RTX 4090  ", "RTX 4090")).toBe(true)
  })

  it("不同型号不匹配", () => {
    expect(namesMatch("RTX 4090", "RTX 3080")).toBe(false)
  })

  it("空名字一律不匹配 —— 否则空串会被任何名字「包含」", () => {
    // `'anything'.includes('')` 是 true，少了这个判断会让空名字配上第一块卡
    expect(namesMatch("", "RTX 4090")).toBe(false)
    expect(namesMatch("RTX 4090", "")).toBe(false)
    expect(namesMatch("", "")).toBe(false)
    expect(namesMatch("   ", "RTX 4090")).toBe(false)
  })

  it("短名字是长名字子串时也算同一块（单卡机器上够用）", () => {
    // 这条是上面那条包含式比较的另一面：多卡机器上两块同系列的卡会互相配上，
    // 那时取到的是"先扫到的那个型号"——显示上不准确，但不会崩
    expect(namesMatch("GeForce RTX 4090", "RTX 4090 Ti")).toBe(false)
    expect(namesMatch("4090", "RTX 4090")).toBe(true)
  })
})
