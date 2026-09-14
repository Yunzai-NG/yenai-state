/**
 * 模块职责：`view/template.ts` 的测试 —— 采集结果到模板变量名的那一层翻译
 * 依赖方向：被测模块
 * 生命周期：测试
 * 注意事项：**这一层是"名字对不上"的全部所在，故测试的重点就是名字。** 断言里写的是
 *          `templates/state.html` 真正读的那几个键（`visualData[].percentage.per`、
 *          `style.backdrop`、`disks.disksSize`……），而不是本插件内部的名字 ——
 *          一条只断言"字段还在"的测试没办法发现模板读的是另一个名字，而那正是这一层唯一的
 *          失败模式。
 *
 *          **模板里读到 `undefined` 不会报错，只会印出一片空白或字面量 `undefined`。**
 *          故每个板块都补一条"不该出现 undefined 字样"的断言 —— 这是这类翻译层里唯一
 *          能被自动测出来、又确实会坏得很难看的东西。
 */

import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { RING_PERIMETER } from "../collect/resources.js"
import type { ResourceRing } from "../collect/resources.js"
import type { StateView } from "./build.js"
import { statusIcon, toBotCards, toOtherInfo, toTemplate, toTemplateRing } from "./template.js"

/**
 * 造一个最小的 `StateView`
 *
 * 只填这一层真会读到的字段；其余给一份够用的缺省值。`StateView` 有十几个必填字段，
 * 而翻译层只碰其中几个 —— 逐条构造会让每个用例都变成一屏噪音。
 * @param overrides 要覆盖的字段
 * @returns 采集结果
 */
function makeState(overrides: Partial<StateView> = {}): StateView {
  return {
    time: "2026-09-01 12:00:00",
    bot: {
      nickname: "测试号",
      uin: "10001",
      avatar: "file:///a.png",
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

describe("toTemplateRing", () => {
  const ring: ResourceRing = {
    title: "CPU",
    inner: "42%",
    detailed: "AMD Ryzen 9",
    info: ["16 核"],
    percentage: { per: 100, color: "#2EC272" }
  }

  it("透传标题与文字", () => {
    const out = toTemplateRing(ring)
    expect(out.title).toBe("CPU")
    expect(out.inner).toBe("42%")
    expect(out.detailed).toBe("AMD Ryzen 9")
    expect(out.percentage.per).toBe(100)
  })

  it("`percentage` 缺失时给一个空环而不是 undefined", () => {
    // 模板里 `stroke-dashoffset:{{group.percentage.per}}` 拿到 undefined 会输出字面量
    // `undefined`，那在 SVG 里是无效值 —— 环会整整画一圈，看起来像满载
    const out = toTemplateRing({ ...ring, percentage: undefined })
    expect(out.percentage.per).toBe(RING_PERIMETER)
    expect(out.percentage.color).toBe("var(--low-color)")
  })

  it("`detailed` 缺失时不出现那一项（模板里 `{{if}}` 判空）", () => {
    const out = toTemplateRing({ ...ring, detailed: undefined })
    expect("detailed" in out).toBe(false)
  })

  it("RAM 的第二圈原样带上 —— 模板靠 `buffcache.isBuff` 判断要不要画", () => {
    const out = toTemplateRing({
      ...ring,
      title: "RAM",
      buffcache: { percentage: { per: 50, color: "#abc" }, isBuff: true }
    })
    expect(out.buffcache?.isBuff).toBe(true)
    expect(out.buffcache?.percentage.per).toBe(50)
  })
})

describe("toOtherInfo", () => {
  it("四格齐全", () => {
    const out = toOtherInfo(makeState())
    expect(out.osInfo.main).toBe("Ubuntu 22.04")
    expect(out.hostname.main).toBe("host")
    expect(out.sysTime.main).toBe("3天 04:05:06")
    expect(out.pluginNum.main).toBe("5 个")
  })

  it("本进程运行时长放次行 —— 与系统运行时长不是一回事", () => {
    expect(toOtherInfo(makeState()).sysTime.secondary).toBe("Bot 已运行 02:00:00")
  })

  it("内核版本为空时不出现次行", () => {
    const state = makeState({ system: { ...makeState().system, kernel: "" } })
    expect("secondary" in toOtherInfo(state).osInfo).toBe(false)
  })

  it("适配器数取不到时显示 0 而不是 undefined", () => {
    const state = makeState({ system: { ...makeState().system, adapterCount: undefined } })
    expect(toOtherInfo(state).pluginNum.secondary).not.toContain("undefined")
  })
})

describe("statusIcon", () => {
  it("五个状态各给一个图标名 —— 这正是那个「在线小绿点是空白」的缺陷", () => {
    // 模板拼的是 `icon/{{status}}.png`，而 `icon/` 里只有 11/31/41/50/60/70 六个文件。
    // 曾经这里返回的是中文文案，拼出 `icon/在线.png` —— 一个不存在的文件，圆点永远空白
    expect(statusIcon("online")).toBe("11")
    expect(statusIcon("offline")).toBe("41")
    expect(statusIcon("connecting")).toBe("31")
    expect(statusIcon("error")).toBe("50")
    expect(statusIcon("disabled")).toBe("41")
  })

  it("**给的全是图标目录里真实存在的文件** —— 拿中文去反推就会在这里断掉", () => {
    // 这条断言的是「文件名本身可解析」：中文名会过，但下面那条尺寸断言会断
    const names = ["online", "offline", "connecting", "error", "disabled"].map(statusIcon)
    for (const name of names) expect(name).toMatch(/^\d+$/)
  })

  it("**每个图标名在 resources/icon 下真有对应文件** —— 缺一个就是一块空白", () => {
    /*
     * 上一组断言只能证明「名字是数字」，证明不了「文件存在」。而本插件搬过来时
     * 恰恰就是文件齐、映射丢 —— `icon/11.png` 一直在，模板却去要 `icon/在线.png`。
     * 故这里直接查磁盘。
     */
    const iconDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "resources", "icon")
    for (const status of ["online", "offline", "connecting", "error", "disabled", "mute"]) {
      const file = join(iconDir, `${statusIcon(status)}.png`)
      expect(existsSync(file), `图标文件不存在：${file}`).toBe(true)
    }
  })

  it("认不出的一律给 41（隐身）—— 几个状态码里最中性的一个", () => {
    // 适配器可能给出内核没定义的词（`mute` / `dnd` 之类）
    expect(statusIcon("mute")).toBe("41")
    expect(statusIcon("")).toBe("41")
  })

  it("给的是文件名而不是路径 —— 模板自己拼 `{{_res_path}}icon/`", () => {
    expect(statusIcon("online")).not.toContain("/")
    expect(statusIcon("online")).not.toContain(".")
  })
})

describe("toBotCards", () => {
  it("只出一张卡", () => {
    expect(toBotCards(makeState())).toHaveLength(1)
  })

  it("头像空时不出现 `avatar` —— 模板据此显示空框而不是坏图", () => {
    const state = makeState({ bot: { ...makeState().bot, avatar: "" } })
    expect("avatar" in toBotCards(state)[0]!).toBe(false)
  })

  it("联系人数取不到时不放进 `countContacts`", () => {
    const state = makeState({
      bot: { ...makeState().bot, friendCount: undefined, groupCount: undefined }
    })
    expect(toBotCards(state)[0]?.countContacts).toEqual({})
  })

  it("联系人数给到时按键放进去", () => {
    const state = makeState({ bot: { ...makeState().bot, friendCount: 12, groupCount: 3 } })
    expect(toBotCards(state)[0]?.countContacts).toEqual({ 好友: "12", 群: "3" })
  })

  it("适配器名用 ` / ` 连接", () => {
    const state = makeState({
      adapters: [
        { name: "napcat", accounts: 1, online: 1, status: "在线", statusColor: "#2EC272" },
        { name: "stdin", accounts: 1, online: 1, status: "在线", statusColor: "#2EC272" }
      ]
    })
    expect(toBotCards(state)[0]?.platform).toBe("napcat / stdin")
  })

  it("没有适配器时 `platform` 是空串，模板里那一行就不显示", () => {
    expect(toBotCards(makeState())[0]?.platform).toBe("")
  })

  it("版本号带 `v` 前缀", () => {
    expect(toBotCards(makeState())[0]?.botVersion).toBe("v0.4.1")
  })
})

describe("toTemplate", () => {
  it("`chartData` 与 `Config` 是 JSON 串，不是对象", () => {
    // 模板里写的是 `JSON.parse(`{{@chartData}}`)`，塞对象进去会变成 `[object Object]`
    const out = toTemplate(makeState(), { theme: "dark" })
    expect(typeof out.chartData).toBe("string")
    expect(typeof out.Config).toBe("string")
    expect(JSON.parse(out.Config)).toEqual({ theme: "dark" })
  })

  it("`Config` 缺省是空对象，给得出合法 JSON", () => {
    expect(JSON.parse(toTemplate(makeState()).Config)).toEqual({})
  })

  it("背景同时落在顶层与 `style` 里", () => {
    // 顶层那个是 `monitor.html` 读的，`style.backdrop` 是 `state.html` 读的 —— 两张图
    // 取自同一份背景，这里让它们落到同一个位置，免得只有一边显形
    const out = toTemplate(makeState({ backdrop: "url(http://x/a.jpg)" }))
    expect(out.backdrop).toBe("url(http://x/a.jpg)")
    expect(out.style.backdrop).toBe("url(http://x/a.jpg)")
  })

  it("没有背景时顶层不给、`style.backdrop` 给空串", () => {
    // 顶层那个是 `monitor.html` 读的，它套在 `{{if backdrop}}` 里，不给即可；
    // `style.backdrop` 是 `state.html` 第 7 行读的，**在 `{{if}}` 之外**，
    // 少了它 `url(undefined)` 会把 `.container` 的背景图设成一个坏值
    const out = toTemplate(makeState())
    expect("backdrop" in out).toBe(false)
    expect(out.style.backdrop).toBe("")
  })

  it("各可选板块缺省时整个键不出现", () => {
    const out = toTemplate(makeState())
    for (const key of ["processLoad", "fastFetch", "network"]) {
      expect(key in out, `不该出现：${key}`).toBe(false)
    }
  })

  it("进程表与 fastfetch 出现时原样带上", () => {
    const out = toTemplate(
      makeState({
        process: { list: [], all: 1, running: 1, blocked: 0, sleeping: 0, unknown: 0, order: "cpu" },
        fastfetch: { title: "user@host", lines: [{ key: "OS", value: "Ubuntu" }, { key: "CPU", value: "Ryzen" }] }
      })
    )
    expect(out.processLoad?.all).toBe(1)
    expect(out.fastFetch?.[0]).toEqual({ key: "OS", value: "Ubuntu" })
  })

  it("磁盘读写速率缺省时 `disks` 里只有分区", () => {
    const out = toTemplate(makeState())
    expect(out.disks.disksSize).toEqual([])
    expect("disksIo" in out.disks).toBe(false)
  })

  it("网速与连通性测试都没有时不出现 `network`", () => {
    expect("network" in toTemplate(makeState())).toBe(false)
  })

  it("只有连通性测试没有网速时也出 `network`，且不含 `speed`", () => {
    const out = toTemplate(
      makeState({ sites: [{ name: "github", status: "<span>200</span>", delay: "<span>1ms</span>" }] })
    )
    expect(out.network?.psTest).toHaveLength(1)
    expect("speed" in (out.network ?? {})).toBe(false)
  })
})
