/**
 * 模块职责：`view/template.ts` 的测试 —— 采集结果到模板变量名的那一层翻译
 * 依赖方向：被测模块
 * 生命周期：测试
 * 注意事项：**这一层是"名字对不上"的全部所在，故测试的重点就是名字。** 断言里写的是
 *          `templates/state.html` 真正读的那几个键（`redis_version`、`used_memory_human`、
 *          `visualData[].percentage.per`、`style.backdrop`……），而不是本插件内部的名字 ——
 *          一条只断言"字段还在"的测试没办法发现模板读的是另一个名字，而那正是这一层唯一的
 *          失败模式。
 *
 *          **模板里读到 `undefined` 不会报错，只会印出一片空白或字面量 `undefined`。**
 *          故每个板块都补一条"不该出现 undefined 字样"的断言 —— 这是这类翻译层里唯一
 *          能被自动测出来、又确实会坏得很难看的东西。
 *
 *          `toTemplateRedis` 有一组单独的用例，它落地前模板的整个 Redis 板块是渲染不出来的：
 *          采集层给的是驼峰字段，模板读的是 `INFO` 的原始键名。
 */

import { describe, expect, it } from "vitest"
import { RING_PERIMETER } from "../collect/resources.js"
import type { ResourceRing } from "../collect/resources.js"
import type { RedisView } from "../collect/redis.js"
import type { StateView } from "./build.js"
import { statusIcon, toBotCards, toOtherInfo, toTemplate, toTemplateRedis, toTemplateRing } from "./template.js"

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
      redisInfoValColor: "#000",
      highColor: "#F44336",
      mediumColor: "#FF9800",
      lowColor: "#2EC272"
    },
    ...overrides
  }
}

/**
 * 造一份 Redis 采集结果
 * @param raw `INFO` 原文
 * @returns 采集结果
 */
function makeRedis(raw: string): RedisView {
  return {
    raw,
    keyspace: { db0: { keys: 3, expires: 1, avg_ttl: 0 } },
    version: "7.2.4",
    uptime: "3天 04:05:06",
    usedMemory: "1.00MB",
    peakMemory: "2.00MB",
    clients: 4,
    blockedClients: 0,
    totalCommands: 100,
    ops: 1,
    role: "master",
    keys: 3,
    hits: 10,
    misses: 2,
    databases: 1,
    expiredKeys: 0,
    evictedKeys: 0
  }
}

/** 一份常见的 `INFO`，几个键都齐全 */
const INFO = [
  "# Server",
  "redis_version:7.2.4",
  "uptime_in_seconds:278706",
  "# Clients",
  "connected_clients:4",
  "blocked_clients:0",
  "# Memory",
  "used_memory:1048576",
  "used_memory_human:1.00M",
  "used_memory_peak:2097152",
  "used_memory_peak_human:2.00M",
  "maxmemory:0",
  "maxmemory_human:0B",
  "# Keyspace",
  "db0:keys=2,expires=1,avg_ttl=0"
].join("\r\n")

describe("toTemplateRedis", () => {
  it("给出模板读的那几个 `INFO` 键名 —— 这是整块能不能渲染出来的前提", () => {
    const out = toTemplateRedis(makeRedis(INFO), 34_200_000_000)
    // 模板第 317/321/330/335/339/346/347 行读的就是这些
    expect(out.redis_version).toBe("7.2.4")
    expect(out.uptime).toBe("3天 04:05:06")
    expect(out.used_memory_human).toBe("1.00M")
    expect(out.used_memory_peak_human).toBe("2.00M")
    expect(out.connected_clients).toBe("4")
    expect(out.blocked_clients).toBe("0")
  })

  it("没有一处是 undefined —— 模板读到 undefined 会印出一片空白", () => {
    const out = toTemplateRedis(makeRedis(INFO), 34_200_000_000)
    expect(JSON.stringify(out)).not.toContain("undefined")
  })

  it("`maxmemory` 为 0 时给空串，模板据此显示「未设置限制」", () => {
    // 模板里是 `{{if !redis.maxmemory}}` —— 空串与 "0" 在 art-template 里都为假，
    // 但给 "0" 会让 `{{if redis.maxmemory}}` 那一支在别的版本里成真，故显式归一成空串
    const out = toTemplateRedis(makeRedis(INFO), 34_200_000_000)
    expect(out.maxmemory).toBe("")
  })

  it("设了上限时原样给出", () => {
    const raw = INFO.replace("maxmemory:0", "maxmemory:1073741824")
    expect(toTemplateRedis(makeRedis(raw), 34_200_000_000).maxmemory).toBe("1073741824")
  })

  it("`memoryUsage` 带 `%` —— 模板同时把它当宽度与文字用", () => {
    const out = toTemplateRedis(makeRedis(INFO), 34_200_000_000)
    expect(out.memoryUsage).toMatch(/^\d+(\.\d+)?%$/)
    // 行内样式的 `width: {{redis.memoryUsage}}` 少了 `%` 就是无效值，进度条不显示
    expect(out.memoryUsage).toContain("%")
  })

  it("设了上限时占用比按上限算", () => {
    // used_memory 1MiB，上限 4MiB → 25%
    const raw = INFO.replace("maxmemory:0", `maxmemory:${String(4 * 1024 * 1024)}`)
    expect(toTemplateRedis(makeRedis(raw), 34_200_000_000).memoryUsage).toBe("25.0%")
  })

  it("没设上限时占用比按物理内存算", () => {
    // 1MiB / 32MiB = 3.125% → 3.1%
    expect(toTemplateRedis(makeRedis(INFO), 32 * 1024 * 1024).memoryUsage).toBe("3.1%")
  })

  it("上限与物理内存都取不到时退到 `0%`，而不是 `NaN%`", () => {
    const out = toTemplateRedis(makeRedis(INFO), 0)
    expect(out.memoryUsage).toBe("0.0%")
    expect(out.memoryUsage).not.toContain("NaN")
  })

  it("占用比不超过 100% —— 超了会把进度条画到框外", () => {
    // 上限给个比已用还小的值
    const raw = INFO.replace("maxmemory:0", "maxmemory:1024")
    expect(toTemplateRedis(makeRedis(raw), 34_200_000_000).memoryUsage).toBe("100.0%")
  })

  it("`Keyspace` 是对象而不是数组 —— 模板用 `{{each redis.Keyspace v k}}`", () => {
    // art-template 的 `each` 遍历对象时给的是 (值, 键)，遍历数组时给的是 (值, 下标)，
    // 故这里必须是对象，且值上要有 keys / expires / avg_ttl
    const out = toTemplateRedis(makeRedis(INFO), 34_200_000_000)
    expect(Array.isArray(out.Keyspace)).toBe(false)
    expect(out.Keyspace.db0).toEqual({ keys: 3, expires: 1, avg_ttl: 0 })
  })

  it("`Keyspace` 里三项都是数字 —— 模板直接印出来，不能是 undefined", () => {
    const out = toTemplateRedis(makeRedis(INFO), 34_200_000_000)
    for (const entry of Object.values(out.Keyspace)) {
      expect(typeof entry.keys).toBe("number")
      expect(typeof entry.expires).toBe("number")
      expect(typeof entry.avg_ttl).toBe("number")
    }
  })

  it("`connectionData` 是 JSON 串 —— 模板里 `JSON.parse()` 它的原文", () => {
    const out = toTemplateRedis(makeRedis(INFO), 34_200_000_000)
    expect(typeof out.connectionData).toBe("string")
    const parsed = JSON.parse(out.connectionData) as number[][]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.[1]).toBe(4)
  })

  it("`INFO` 里缺某个键时给空串，不从别处猜一个值", () => {
    // 5.0 之前没有 avg_ttl，7.x 里 `maxmemory_human` 也可能缺
    const raw = "# Server\r\nredis_version:6.0.0\r\n"
    const out = toTemplateRedis(makeRedis(raw), 34_200_000_000)
    expect(out.uptime).toBe("3天 04:05:06") // 这个来自采集层算好的字段
    expect(out.used_memory_human).toBe("")
    expect(out.connected_clients).toBe("")
  })

  it("`Keyspace` 直接取采集层解析好的那份，不在这里重解一遍", () => {
    // 采集层的 `parseKeyspace` 与这里若各解一次，两份结果迟早对不上 ——
    // 表格里 `db0` 有 3 个键、而别处说总共 3 个键，这种不一致最难查
    const redis = makeRedis(INFO)
    expect(toTemplateRedis(redis, 34_200_000_000).Keyspace).toBe(redis.keyspace)
  })

  it("版本号里的点不会被当成数字解析掉", () => {
    // 这正是采集层文件头里说的那个坑：一律 `Number()` 会把 `7.2.4` 变成 NaN
    expect(toTemplateRedis(makeRedis(INFO), 34_200_000_000).redis_version).toBe("7.2.4")
  })
})

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
  it("认得出的状态原样给", () => {
    for (const s of ["在线", "离线", "连接中", "出错", "未知"]) expect(statusIcon(s)).toBe(s)
  })

  it("认不出的一律给「离线」—— 那个图标最中性", () => {
    expect(statusIcon("奇怪的状态")).toBe("离线")
    expect(statusIcon("")).toBe("离线")
  })

  it("给的是文件名而不是路径 —— 模板自己拼 `{{_res_path}}icon/`", () => {
    expect(statusIcon("在线")).not.toContain("/")
    expect(statusIcon("在线")).not.toContain(".")
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

  it("没连 Redis 时也给一个空壳 —— 少了它整张图渲染不出来", () => {
    /*
     * 模板第 16 行 `var redisChartData = JSON.parse(`{{@redis.connectionData}}`)` 在
     * `{{if redis}}` 之外，无条件执行。不给 `redis`，art-template 会在取 `connectionData`
     * 时抛 `Cannot read properties of undefined`，**整张状态图都出不来** ——
     * 实机上正是这么坏的，回落到纯文本才发现。
     */
    const out = toTemplate(makeState())
    expect(out.redis).toBeDefined()
    expect(out.redis.connectionData).toBe("[]")
    // 空壳的每一格都要能正常判假 / 空转，而不是留下 undefined 让模板印出来
    expect(JSON.stringify(out.redis)).not.toContain("undefined")
    expect(out.redis.maxmemory).toBe("")
    expect(out.redis.Keyspace).toEqual({})
  })

  it("Redis 出现时是翻译过的形状，不是采集层的原样透传", () => {
    // 这条盯的就是那个已修好的缺陷：透传 RedisView 会让模板读到 `redis.redis_version`
    // 为 undefined，整个板块渲染成空白
    const out = toTemplate(makeState({ redis: makeRedis(INFO) }))
    expect(out.redis?.redis_version).toBe("7.2.4")
    expect(out.redis?.Keyspace.db0?.keys).toBe(3)
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
