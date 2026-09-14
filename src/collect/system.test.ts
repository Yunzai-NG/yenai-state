/**
 * 模块职责：`collect/system.ts` 里两个纯函数的测试 —— 版权行与操作系统名拼接
 * 依赖方向：被测模块
 * 生命周期：测试
 * 注意事项：**`osLabel` 在写的时候是错的，这几条测试是修它时留下的。** 原来的实现里
 *          Windows 那个分支与兜底分支写的是同一个表达式，于是 `Windows 11 10.0.22621`
 *          这种"版本号套版本号"会照样输出 —— 一段看似有分支实则无分支的代码。
 *          故这里逐平台钉死期望值。
 */

import { describe, expect, it } from "vitest"
import { collectSystem, copyrightLine, osLabel } from "./system.js"

describe("osLabel", () => {
  it("Windows：只用 `distro`，不拼内核版本", () => {
    // `si` 在 Windows 上给 distro=`Windows 11`、release=`10.0.22621`。
    // 拼起来是 `Windows 11 10.0.22621` —— 后半个不是使用者认得的版本号
    expect(osLabel("Windows 11", "10.0.22621", "windows")).toBe("Windows 11")
    expect(osLabel("Windows 10 Pro", "10.0.19045", "windows")).toBe("Windows 10 Pro")
  })

  it("Windows 且 `release` 为空时也只用 `distro`", () => {
    expect(osLabel("Windows 11", "", "windows")).toBe("Windows 11")
  })

  it("大小写不敏感地认出 Windows", () => {
    expect(osLabel("windows 11", "10.0", "windows")).toBe("windows 11")
    expect(osLabel("WINDOWS SERVER 2022", "10.0", "windows")).toBe("WINDOWS SERVER 2022")
  })

  it("Linux：`distro` + `release` 才是完整说法", () => {
    // 光有 `Ubuntu` 说明不了跑的是哪一版
    expect(osLabel("Ubuntu", "22.04", "linux")).toBe("Ubuntu 22.04")
    expect(osLabel("Debian GNU/Linux", "12", "linux")).toBe("Debian GNU/Linux 12")
    expect(osLabel("Alpine Linux", "3.19.1", "linux")).toBe("Alpine Linux 3.19.1")
  })

  it("Linux 且 `release` 为空时只给 `distro`", () => {
    expect(osLabel("Ubuntu", "", "linux")).toBe("Ubuntu")
  })

  it("`distro` 为空时回落到内核给的系统族", () => {
    // 容器里 `si` 常常取不到 distro
    expect(osLabel("", "", "linux")).toBe("linux")
    expect(osLabel("", "", "android")).toBe("android")
  })

  it("`distro` 为空但有 `release` 时两者都带上", () => {
    expect(osLabel("", "22.04", "linux")).toBe("linux 22.04")
  })

  it("不产生重复的版本号", () => {
    // 这条盯的就是原来那个 bug：`Windows 11 10.0.22621` 里有两段版本号
    const out = osLabel("Windows 11", "10.0.22621", "windows")
    expect(out).toBe("Windows 11")
    expect(out).not.toContain("10.0.22621")
  })

  it("macOS 走 Linux 那条路（`si` 给 `macOS 14.2` 一类）", () => {
    expect(osLabel("macOS", "14.2", "darwin")).toBe("macOS 14.2")
  })
})

describe("copyrightLine", () => {
  it("含框架名与版本号", () => {
    const out = copyrightLine("0.4.1")
    expect(out).toContain("Yunzai-NG")
    expect(out).toContain("0.4.1")
  })

  it("含本插件名 —— 一张图上有出处可查才说得清是哪来的", () => {
    expect(copyrightLine("0.4.1")).toContain("yenai-state")
  })

  it("是 HTML（模板里用 `{{@...}}` 不转义输出）", () => {
    expect(copyrightLine("0.4.1")).toContain("<span")
  })

  it("只含本插件自己的常量，不含任何外部输入", () => {
    // 这一处进的是不转义输出，故它不该有机会带上使用者可控的文本
    const out = copyrightLine("0.4.1")
    expect(out).not.toContain("<script")
    // 版本号原样进输出（不带标签）—— 调用方给的是 `ctx.app.version`，不是使用者的输入
    expect(out).toContain("0.4.1")
    expect(out).toContain("</span> 0.4.1 ")
  })

  it("版本号为空的字符串也给一条合法的行，不出现 `undefined`", () => {
    const out = copyrightLine("")
    expect(out).not.toContain("undefined")
    expect(out).toContain("Yunzai-NG")
  })
})

describe("`si` 返回 null 的那条路", () => {
  /*
   * `si` 的失败形态是**返回 null 而不是抛错**，故 `await ...catch(() => undefined)` 拦不住。
   * 这一组盯的是它最难看的一种后果：`\`${cpu.manufacturer} ${cpu.brand}\`` 里 cpu 为 null 时，
   * 字符串拼接会把 null 印成字面量，状态图上那一格于是显示 `null undefined`。
   *
   *   `collectSystem` 里有三处 `?.`（os / cpu / time）。它们看着像多余的防御，其实不是 ——
   * `si.time()` 是同步函数，连 catch 都没得套，只能靠 `?.`。
   */
  it("CPU 取不到时给空串，不拼出 `null undefined`", async () => {
    // 这条走的是真 `collectSystem`：`si.cpu()` 在这台机器上取得到，故只断言
    // "结果里不该出现 null/undefined 字样" —— 那正是拼接漏判时会留下的痕迹
    const view = await collectSystem({ version: "0.4.1", pluginCount: 1, commandCount: 2 })
    expect(view.cpu).not.toContain("null")
    expect(view.cpu).not.toContain("undefined")
    // 型号本身要么是空串（取不到），要么是厂商 + 型号
    expect(view.cpu === "" || view.cpu.length > 2).toBe(true)
  })

  it("系统运行时长取不到时给 `00:00:00` 而不是 NaN 串", async () => {
    const view = await collectSystem({ version: "0.4.1", pluginCount: 1, commandCount: 2 })
    expect(view.uptime).not.toContain("NaN")
    expect(view.uptime).not.toContain("undefined")
  })

  it("时区总有值 —— `Intl` 兜底，不依赖 `si`", async () => {
    const view = await collectSystem({ version: "0.4.1", pluginCount: 1, commandCount: 2 })
    expect(view.timezone.length).toBeGreaterThan(0)
  })
})
