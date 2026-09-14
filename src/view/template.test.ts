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

import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { RING_PERIMETER } from "../collect/resources.js"
import type { ResourceRing } from "../collect/resources.js"
import { toNetworkView } from "../collect/network.js"
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
    bots: [
      {
        nickname: "测试号",
        uin: "10001",
        avatar: "file:///a.png",
        status: "在线",
        statusKey: "online",
        statusColor: "#2EC272",
        since: "2026-09-01 10:00:00",
        retries: 0,
        adapterName: "",
        memory: "120MB",
        uptime: "02:00:00"
      }
    ],
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
  it("一个号一张卡", () => {
    expect(toBotCards(makeState())).toHaveLength(1)
  })

  it("**有几个号就出几张卡，顺序原样** —— 只画一个号是这条命令曾经的样子", () => {
    /*
     * 这一条守的是「列出所有账号」这件事本身。曾经的实现是 `pickAccount`（单数）
     * 加一句硬写的注释，理由是"多账号是同一个机器人接了两份账号配置，画成两张
     * 几乎一样的卡会让人以为是两套系统" —— 但那是实现者的判断，不是使用者的：
     * 两个号就是两个号，名字、头像、在线状态、好友数各是各的，合掉一张等于少说一个。
     *
     * 只给一个号的夹具发现不了这件事（`slice(0, 1)` 也能过），故这里必须给两个，
     * 且两个号的昵称不同 —— 断言的是"两张卡各自带着自己的名字"，而不只是"长度是 2"。
     */
    const first = makeState().bots[0]!
    const state = makeState({
      bots: [first, { ...first, nickname: "第二个号", uin: "10002", statusKey: "offline" }]
    })
    const cards = toBotCards(state)
    expect(cards).toHaveLength(2)
    expect(cards[0]?.nickname).toBe("测试号")
    expect(cards[1]?.nickname).toBe("第二个号")
    // 状态图标也得各取各的，不能两张卡共用第一个号的
    expect(cards[0]?.status).toBe("11")
    expect(cards[1]?.status).toBe("41")
  })

  it("头像空时不出现 `avatar` —— 模板据此显示空框而不是坏图", () => {
    const state = makeState({ bots: [{ ...makeState().bots[0]!, avatar: "" }] })
    expect("avatar" in toBotCards(state)[0]!).toBe(false)
  })

  it("联系人数取不到时不放进 `countContacts`", () => {
    const state = makeState({
      bots: [{ ...makeState().bots[0]!, friendCount: undefined, groupCount: undefined }]
    })
    expect(toBotCards(state)[0]?.countContacts).toEqual({})
  })

  it("联系人数给到时按键放进去", () => {
    const state = makeState({ bots: [{ ...makeState().bots[0]!, friendCount: 12, groupCount: 3 }] })
    expect(toBotCards(state)[0]?.countContacts).toEqual({ 好友: "12", 群: "3" })
  })

  it("**`platform` 只放该账号用的那一个适配器**，不把注册了的全列出来", () => {
    /*
     * 这一条盯的是一个真实出现过的现象：账号上写着「NapCat (OneBot v11) / 标准输入」，
     * 而那个账号用的只是标准输入。原因是这里曾取 `view.adapters`（`adapters.list()` 的
     * 全体，那是给面板「添加账号」页选类型用的）拼起来 —— 与账号无关，装了几个适配器
     * 插件就显示几个名字。故夹具里同时给两个适配器，断言只出账号名下的那个。
     */
    const state = makeState({
      bots: [{ ...makeState().bots[0]!, adapterName: "标准输入" }],
      adapters: [
        { name: "NapCat (OneBot v11)", accounts: 1, online: 1, status: "在线", statusColor: "#2EC272" },
        { name: "标准输入", accounts: 1, online: 1, status: "在线", statusColor: "#2EC272" }
      ]
    })
    expect(toBotCards(state)[0]?.platform).toBe("标准输入")
  })

  it("适配器取不到时整项不放 —— 模板里 `{{if $value.platform}}` 会跳过那一行", () => {
    // 放空串的话模板会画出一个带图标的空标签，比不画更难看
    expect("platform" in toBotCards(makeState())[0]!).toBe(false)
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

  it("有累计量、没有瞬时速率时：外层 `speed` 在，内层 `speed` 不在", () => {
    // 这是刚启动时的常态（`si` 的 `rx_sec` 要两次采样才算得出来）。
    // 模板读的是 `network.speed.speed.upload` —— 外层是开关、内层是数据，
    // 内层缺失正是 `Cannot read properties of undefined (reading 'speed')` 的来源
    const traffic = toNetworkView({ rx_bytes: 1024 ** 3, tx_bytes: 1024 ** 3 })
    expect(traffic?.speed).toBeUndefined()
    expect(traffic?.traffic).toBeDefined()

    const out = toTemplate(makeState({ network: traffic }))
    const net = out.network as { speed?: { speed?: unknown; traffic?: unknown } }
    expect(net.speed, "外层 speed 是板块开关，必须恒在").toBeDefined()
    expect(net.speed?.speed, "内层的瞬时速率此时不该出现").toBeUndefined()
    expect(net.speed?.traffic).toBeDefined()
  })
})

/**
 * 模板本身能不能编译
 *
 * **这一条测的不是翻译层，是模板的语法。** 模板坏掉时没有任何前置信号：`pnpm run verify`
 * 全绿、类型检查全绿，直到真机上敲一次 `#状态` 才在渲染器的日志里冒出来一行
 * `CompileError: Invalid or unexpected token`，而那时人已经在别处排查了（实机上撞到过，
 * 起因是我往模板里加了花括号包起来的块注释 —— 这套 art-template 不认那种写法，
 * 它把里面的内容当成一个 JS 表达式求值）。
 *
 * 故直接编译一遍。`art-template` 是渲染器的依赖、不是本插件的，故用 `createRequire`
 * 从渲染器那里解 —— 解不到就跳过，避免本插件的测试因为"没装渲染器"而红。
 */
describe("templates/state.html", () => {
  /** 本插件的 `templates/` 目录 */
  const templatesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates")

  it("整份模板能被 art-template 编译 —— 语法错只在真机渲染时才暴露", () => {
    const require = createRequire(import.meta.url)
    let art: { compile: (src: string, opts: Record<string, unknown>) => unknown }
    try {
      // 从渲染器解析：art-template 归它管，本插件不重复声明
      art = require(
        require.resolve("art-template", {
          paths: [join(templatesDir, "..", "..", "renderer-puppeteer")]
        })
      ) as typeof art
    } catch {
      return // 没装渲染器，跳过
    }

    const src = readFileSync(join(templatesDir, "state.html"), "utf8")
    expect(() =>
      art.compile(src, {
        filename: join(templatesDir, "state.html"),
        // 编译期只做语法检查，不求值，故这些给什么都行 —— 但必须给，
        // 否则未声明的标识符会被当成"运行时再说"而放过去
        imports: { _res_path: "", defaultLayout: "" }
      })
    ).not.toThrow()
  })

  it("模板里没有 `{{/* ... */}}` —— 这套 art-template 不认这种注释", () => {
    // 它把 `{{/* x */}}` 解析成 `{{` + 表达式 `/* x */` + `}}`，生成
    // `$$out+=$escape(* x */)`，编译期即炸。注释用 HTML 的 `<!-- -->`
    const src = readFileSync(join(templatesDir, "state.html"), "utf8")
    expect(src).not.toMatch(/\{\{\s*\/\*/)
  })
})

/**
 * 背景值的形状
 *
 * **`Backdrop.css` 本身就是一整个 `url(...)` 值，模板不能再包一层。** 曾经两张模板里
 * 写的都是 `background-image:url({{...backdrop}})`，于是拼出 `url(url("data:..."))` ——
 * 浏览器把这个值解析成空串**默默丢弃**，`.container` 就一直是 CSS 里的灰底。
 *
 * 这条缺陷没有任何前置信号：背景图下载是成功的（`from: "network"`）、日志一个字都不报、
 * 渲染也成功出图，只是图里没有背景。故这里从两头夹住 —— 产出侧断言形状，
 * 模板侧断言没有再包一层。
 */
describe("背景值", () => {
  /** 本插件的 `templates/` 目录 */
  const templatesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates")

  it("`Backdrop.css` 是完整的 `url(...)` 值", async () => {
    const { pickBuiltinBackdrop } = await import("./style.js")
    const bgDir = join(templatesDir, "..", "resources", "img", "bg")
    const backdrop = await pickBuiltinBackdrop(bgDir)
    expect(backdrop).toBeDefined()
    expect(backdrop?.css.startsWith("url(")).toBe(true)
    expect(backdrop?.css.endsWith(")")).toBe(true)
  })

  it("模板直接输出背景值，**既不再套 `url()`、也不能被转义**", () => {
    /*
     * 两处都必须对，而错任何一处的症状是同一个：浏览器把值丢成空串、图里没有背景，
     * 且日志一个字都不报。
     *
     *   1. 值本身就是 `url("data:...")`，模板再包一层就是 `url(url(...))` —— 非法，丢成空串
     *   2. 值里带双引号，走 `{{ }}` 会被 HTML 转义成 `&#34;`；而它在 `<style>` 里是 CSS、
     *      不是 HTML，浏览器不解实体 —— 于是 `url(&#34;data:...&#34;)` 同样非法
     *
     * 故这里要求恰好是 `{{@...}}`（art-template 的不转义输出），且前面不带 `url(`。
     */
    for (const file of ["state.html", "monitor.html"]) {
      const src = readFileSync(join(templatesDir, file), "utf8")
      expect(src, `${file} 又把背景值套了一层 url()`).not.toMatch(/background-image:\s*url\(\s*\{\{/)
      expect(src, `${file} 的背景走了转义输出，引号会变成 &#34;`).toMatch(
        /background-image:\s*\{\{@[^}]+\}\}/
      )
    }
  })

  it("背景取不到时给空串，模板里 `background-image:` 落空是安全的", () => {
    // 浏览器把空值恢复成 `none`、不动 background-color，故不必为这种情况在模板里加判断
    const out = toTemplate(makeState())
    expect(out.style.backdrop).toBe("")
    expect(() => {
      const src = readFileSync(join(templatesDir, "state.html"), "utf8")
      return src.replace("{{style.backdrop}}", out.style.backdrop)
    }).not.toThrow()
  })
})
