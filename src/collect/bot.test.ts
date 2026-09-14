/**
 * 模块职责：`collect/bot.ts` 里各纯函数的测试 —— 状态翻译、图片类型嗅探、路径转 URL、适配器归拢
 * 依赖方向：被测模块
 * 生命周期：测试
 * 注意事项：**`sniffImageMime` 不读响应头的 `Content-Type`，这条要靠测试记着。** QQ 的头像
 *          接口返回的常常是 `application/octet-stream`，照抄那个类型写进 `data:` URL 会让
 *          Chromium 拒绝渲染 —— 而"图裂了"这种现象不看代码根本追不到这里。
 *
 *          `fetchAvatar` 与 `collectBot` 要真发请求 / 真读 `process.memoryUsage()`，故不测。
 *          它们里面真正有判断的只有"取不到就回落"，那一条由 `toFileUrl` 与 `sniffImageMime`
 *          的测试间接覆盖。
 */

import { describe, expect, it } from "vitest"
import { collectAdapters, formatSince, sniffImageMime, toFileUrl, translateStatus } from "./bot.js"

describe("translateStatus", () => {
  it("五个人内核定义的状态都有中文", () => {
    expect(translateStatus("online")).toEqual({ text: "在线", color: "#25a55f" })
    expect(translateStatus("offline")).toEqual({ text: "离线", color: "#8a8a8a" })
    expect(translateStatus("connecting")).toEqual({ text: "连接中", color: "#f0a020" })
    expect(translateStatus("error")).toEqual({ text: "出错", color: "#d03050" })
    expect(translateStatus("disabled")).toEqual({ text: "已禁用", color: "#8a8a8a" })
  })

  it("大小写不敏感", () => {
    expect(translateStatus("ONLINE").text).toBe("在线")
    expect(translateStatus("Online").text).toBe("在线")
  })

  it("认不出的状态原文原样显示，取中性灰", () => {
    // 适配器可能给出内核没定义的词（`mute` / `dnd` 之类），显示原文比显示「未知」有用
    expect(translateStatus("mute")).toEqual({ text: "mute", color: "#8a8a8a" })
    expect(translateStatus("dnd")).toEqual({ text: "dnd", color: "#8a8a8a" })
  })

  it("空值与 undefined 给「未知」", () => {
    expect(translateStatus(undefined)).toEqual({ text: "未知", color: "#8a8a8a" })
    expect(translateStatus("")).toEqual({ text: "未知", color: "#8a8a8a" })
  })

  it("在线与离线颜色不同 —— 图上靠颜色分辨，同色等于没显示", () => {
    expect(translateStatus("online").color).not.toBe(translateStatus("offline").color)
    expect(translateStatus("error").color).not.toBe(translateStatus("connecting").color)
  })
})

describe("sniffImageMime", () => {
  it("认得 PNG / GIF / WEBP / JPEG", () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe("image/png")
    expect(sniffImageMime(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("image/gif")
    expect(sniffImageMime(Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00]))).toBe("image/webp")
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg")
  })

  it("认不出的按 JPEG 处理 —— QQ 头像绝大多数是 JPEG", () => {
    expect(sniffImageMime(Buffer.from([0x00, 0x01, 0x02]))).toBe("image/jpeg")
    expect(sniffImageMime(Buffer.alloc(0))).toBe("image/jpeg")
    expect(sniffImageMime(Buffer.from("not an image at all"))).toBe("image/jpeg")
  })

  it("按内容而非响应头判断 —— 这正是本函数存在的理由", () => {
    // 一个"Content-Type: application/octet-stream"的 PNG 响应，内容仍是 PNG
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    expect(sniffImageMime(png)).toBe("image/png")
  })

  it("数据比魔数短时不会越界读", () => {
    expect(sniffImageMime(Buffer.from([0x89]))).toBe("image/jpeg")
    expect(sniffImageMime(Buffer.from([0x89, 0x50]))).toBe("image/jpeg")
  })
})

describe("toFileUrl", () => {
  it("POSIX 路径给三段式的 `file:///`", () => {
    expect(toFileUrl("/home/user/a.jpg")).toBe("file:///home/user/a.jpg")
  })

  it("Windows 盘符变成 `/D:/...` —— 否则 Chromium 会把 `D:` 当主机名", () => {
    expect(toFileUrl("D:\\Yunzai-NG\\a.jpg")).toBe("file:///D:/Yunzai-NG/a.jpg")
    expect(toFileUrl("C:\\x.jpg")).toBe("file:///C:/x.jpg")
  })

  it("反斜杠统一成正斜杠", () => {
    expect(toFileUrl("D:\\a\\b\\c.jpg")).not.toContain("\\")
  })

  it("空格与中文被转义 —— 不转义则 Chromium 解析出的 URL 是坏的", () => {
    expect(toFileUrl("D:\\My Dir\\背景 图.jpg")).toBe("file:///D:/My%20Dir/%E8%83%8C%E6%99%AF%20%E5%9B%BE.jpg")
  })

  it("路径里已有的 `%` 会被双重转义 —— 这是可接受的：真实路径里罕见，且转义后仍能打开", () => {
    expect(toFileUrl("/a%20b.jpg")).toBe("file:///a%2520b.jpg")
  })

  it("已经以 `/` 开头的不重复加斜杠", () => {
    expect(toFileUrl("/a.jpg")).toBe("file:///a.jpg")
    expect(toFileUrl("/a.jpg")).not.toContain("file:////")
  })
})

describe("formatSince", () => {
  /** 造一个「多少秒之前」的时间戳 */
  const ago = (seconds: number): number => Date.now() - seconds * 1000

  it("一分钟内是「刚刚」", () => {
    expect(formatSince(ago(0))).toBe("刚刚")
    expect(formatSince(ago(59))).toBe("刚刚")
  })

  it("分 / 时 / 天各一档", () => {
    expect(formatSince(ago(60))).toBe("1 分钟前")
    expect(formatSince(ago(3599))).toBe("59 分钟前")
    expect(formatSince(ago(3600))).toBe("1 小时前")
    expect(formatSince(ago(86399))).toBe("23 小时前")
    expect(formatSince(ago(86400))).toBe("1 天前")
    expect(formatSince(ago(86400 * 3))).toBe("3 天前")
  })

  it("非法时间戳给「未知」", () => {
    // 账号刚起来时 `since` 可能还没填
    expect(formatSince(0)).toBe("未知")
    expect(formatSince(-1)).toBe("未知")
    expect(formatSince(Number.NaN)).toBe("未知")
    expect(formatSince(Number.POSITIVE_INFINITY)).toBe("未知")
  })
})

describe("collectAdapters", () => {
  const adapters = [
    { id: "onebot", name: "OneBot 11" },
    { id: "stdin", name: "标准输入" }
  ]

  it("按 adapterId 归拢账号数", () => {
    const out = collectAdapters(adapters, [
      { adapterId: "onebot", status: "online" },
      { adapterId: "onebot", status: "online" },
      { adapterId: "stdin", status: "offline" }
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ name: "OneBot 11", accounts: 2, online: 2, status: "在线" })
    expect(out[1]).toMatchObject({ name: "标准输入", accounts: 1, online: 0, status: "离线" })
  })

  it("一个号都没有的适配器标「未配置」而非「离线」", () => {
    // 那说明适配器装了但没配账号，与"配了但掉线"是不同的事
    const out = collectAdapters([{ id: "nobody", name: "空适配器" }], [])
    expect(out[0]).toMatchObject({ accounts: 0, online: 0, status: "未配置" })
  })

  it("部分在线单独一档", () => {
    const out = collectAdapters(adapters, [
      { adapterId: "onebot", status: "online" },
      { adapterId: "onebot", status: "offline" }
    ])
    expect(out[0]?.status).toBe("部分在线")
    expect(out[0]?.statusColor).toBe("#f0a020")
  })

  it("四种状态的配色各不相同（至少在线 / 离线 / 部分在线三者）", () => {
    const colors = [
      collectAdapters([{ id: "a", name: "a" }], []), // 未配置
      collectAdapters([{ id: "a", name: "a" }], [{ adapterId: "a", status: "online" }]), // 在线
      collectAdapters([{ id: "a", name: "a" }], [{ adapterId: "a", status: "offline" }]), // 离线
      collectAdapters([{ id: "a", name: "a" }], [
        { adapterId: "a", status: "online" },
        { adapterId: "a", status: "offline" }
      ]) // 部分在线
    ].map(out => out[0]?.statusColor)
    expect(new Set(colors).size).toBeGreaterThanOrEqual(3)
  })

  it("没有适配器时给空数组", () => {
    expect(collectAdapters([], [{ adapterId: "x", status: "online" }])).toEqual([])
  })

  it("有账号但适配器已卸载时不凭空多出一行", () => {
    // 以适配器列表为准，脏的账号记录不该让它出现在图上
    const out = collectAdapters([], [
      { adapterId: "gone", status: "online" },
      { adapterId: "gone", status: "online" }
    ])
    expect(out).toEqual([])
  })

  it("保持适配器的入参顺序", () => {
    const out = collectAdapters(adapters, [])
    expect(out.map(item => item.name)).toEqual(["OneBot 11", "标准输入"])
  })

  it("counts 里的 `online` 只认精确的 `online`", () => {
    // `connecting` / `error` 都不算在线
    const out = collectAdapters([{ id: "a", name: "a" }], [
      { adapterId: "a", status: "connecting" },
      { adapterId: "a", status: "error" },
      { adapterId: "a", status: "ONLINE" }
    ])
    expect(out[0]).toMatchObject({ accounts: 3, online: 0, status: "离线" })
  })
})
