/**
 * 模块职责：`util/format.ts` 的测试 —— 单位进位、边界值、以及源实现里那几处被修掉的行为
 * 依赖方向：被测模块
 * 生命周期：测试
 * 注意事项：**这里盯的主要是"源实现会被当成 bug 的地方"。** `getFileSize` 是状态图上每个
 *          数字都要过的函数，它继承自椰奶的 `model/State/utils.js`，而那份实现有几处刻意
 *          或非刻意的行为（B 与 KB 之间不补小数、负数不归零、小数位数非整数时抛错）。
 *          移植时改掉了后两条，故这两条要有测试盯着，免得日后被"改回去"。
 */

import { describe, expect, it } from "vitest"
import { formatDateTime, formatDuration, getFileSize } from "./format.js"

describe("getFileSize", () => {
  it("小于 1K 时停在 B 这一级，且不补小数", () => {
    // 源实现写成 `512.00B`；`ls -h` 是不补的，状态图上也更该是不补的
    expect(getFileSize(0)).toBe("0 B")
    expect(getFileSize(1)).toBe("1 B")
    expect(getFileSize(512)).toBe("512 B")
    expect(getFileSize(1023)).toBe("1023 B")
  })

  it("按 1024 进位", () => {
    expect(getFileSize(1024)).toBe("1.00 KB")
    expect(getFileSize(1536)).toBe("1.50 KB")
    expect(getFileSize(1024 ** 2)).toBe("1.00 MB")
    expect(getFileSize(1024 ** 3)).toBe("1.00 GB")
    expect(getFileSize(1024 ** 4)).toBe("1.00 TB")
    expect(getFileSize(1024 ** 5)).toBe("1.00 PB")
  })

  it("顶到单位表末端就不再进位", () => {
    // P 是最后一档。再乘 1024 仍应留在 P，而不是变成一个不存在的单位
    expect(getFileSize(1024 ** 6)).toBe("1024.00 PB")
  })

  it("非有限值与负数一律按 0 —— 源实现会输出 `-1.00MB` 这种", () => {
    expect(getFileSize(-1)).toBe("0 B")
    expect(getFileSize(-(1024 ** 2))).toBe("0 B")
    expect(getFileSize(Number.NaN)).toBe("0 B")
    expect(getFileSize(Number.POSITIVE_INFINITY)).toBe("0 B")
    expect(getFileSize(Number.NEGATIVE_INFINITY)).toBe("0 B")
  })

  it("小数位数非整数时取整而不抛错", () => {
    // 源实现抛错。为一个小数位数把整张状态图弄崩不值得 —— 见模块文件头
    expect(getFileSize(1536, { decimalPlaces: 1.9 })).toBe("1.5 KB")
    expect(getFileSize(1536, { decimalPlaces: -1 })).toBe("2 KB")
    expect(getFileSize(1536, { decimalPlaces: 0 })).toBe("2 KB")
  })

  it("decimalPlaces 上限是 10", () => {
    // 超过 10 位对一张状态图没有意义，且 toFixed 在极端值上会抛
    expect(getFileSize(1536, { decimalPlaces: 50 })).toBe("1.5000000000 KB")
  })

  it("showByte 关掉时，小于 1K 的数值连单位一起省掉", () => {
    expect(getFileSize(512, { showByte: false })).toBe("512")
    // 大于 1K 的不受影响 —— 它的单位是有信息量的
    expect(getFileSize(1536, { showByte: false })).toBe("1.50 KB")
  })

  it("showSuffix 关掉时单位不带 B", () => {
    expect(getFileSize(1536, { showSuffix: false })).toBe("1.50 K")
    expect(getFileSize(1024 ** 2, { showSuffix: false })).toBe("1.00 M")
    // B 这一档本来就不带后缀，开关对它无影响
    expect(getFileSize(512, { showSuffix: false })).toBe("512 B")
  })

  it("aloneUnit 把数值与单位拆开，单位带前导空格", () => {
    expect(getFileSize(1536, { aloneUnit: true })).toEqual({ size: "1.50", suffix: " KB" })
    expect(getFileSize(512, { aloneUnit: true })).toEqual({ size: "512", suffix: " B" })
  })

  it("aloneUnit 与 showByte 组合：网速那一格用的就是这个组合", () => {
    // 模板里 `{{size}}{{suffix}}/s`，512 字节应当是 `512/s` 而非 `512B/s`
    expect(getFileSize(512, { aloneUnit: true, showByte: false })).toEqual({
      size: "512",
      suffix: " B"
    })
  })

  it("可选参数一个都不传时按缺省值走", () => {
    expect(getFileSize(1536)).toBe("1.50 KB")
  })
})

describe("formatDuration", () => {
  it("不足一天时不给天数", () => {
    expect(formatDuration(0)).toBe("00:00:00")
    expect(formatDuration(1)).toBe("00:00:01")
    expect(formatDuration(59)).toBe("00:00:59")
    expect(formatDuration(60)).toBe("00:01:00")
    expect(formatDuration(3599)).toBe("00:59:59")
    expect(formatDuration(86399)).toBe("23:59:59")
  })

  it("满一天才出现天数", () => {
    expect(formatDuration(86400)).toBe("1天 00:00:00")
    expect(formatDuration(86400 + 3661)).toBe("1天 01:01:01")
    expect(formatDuration(86400 * 3 + 61)).toBe("3天 00:01:01")
  })

  it("小数秒向下取整", () => {
    expect(formatDuration(1.99)).toBe("00:00:01")
  })

  it("非有限值与负数按 0", () => {
    expect(formatDuration(-1)).toBe("00:00:00")
    expect(formatDuration(Number.NaN)).toBe("00:00:00")
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("00:00:00")
  })

  it("各段都补零", () => {
    // 源插件用 moment 的 `HH:mm:ss`，缺零会变成 `1:1:1`
    expect(formatDuration(3661)).toBe("01:01:01")
  })
})

describe("formatDateTime", () => {
  it("给出 `YYYY-MM-DD HH:mm:ss` 且各段补零", () => {
    // 用固定时间戳而非当前时刻：断言才能确定。2023-01-02 03:04:05 UTC
    const at = Date.UTC(2023, 0, 2, 3, 4, 5)
    const out = formatDateTime(at)
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    // 年与秒不受时区影响的部分
    expect(out).toContain("2023-")
    expect(out.endsWith(":05")).toBe(true)
  })

  it("缺省用当前时刻", () => {
    const now = formatDateTime()
    expect(now).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    // 与"现在"同年，说明确实取的是当前时刻
    expect(now.startsWith(String(new Date().getFullYear()))).toBe(true)
  })

  it("时区取本地而非 UTC", () => {
    // 同一时间戳在 UTC 与本地各格式化一次。只有本机时区恰好是 UTC 时两者才相等 ——
    // 那种情况下这条断言退化成恒真，不算错
    const at = Date.UTC(2023, 0, 2, 3, 4, 5)
    const local = new Date(at)
    const expected = `${String(local.getFullYear())}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`
    expect(formatDateTime(at).startsWith(expected)).toBe(true)
  })

  it("24 小时制：午夜是 00 而非 12", () => {
    const local = new Date(2023, 0, 2, 0, 30, 0).getTime()
    expect(formatDateTime(local)).toMatch(/ 00:30:00$/)
  })
})
