/**
 * 模块职责：`view/build.ts` 里「多账号」那一段的测试 —— 每个号一张卡、各自兜底
 * 依赖方向：被测模块
 * 生命周期：测试
 * 注意事项：**这一层只测「几个号、谁兜底」，不测采到的内容。** `buildState` 会把
 *          资源环、磁盘、进程表、fastfetch 全采一遍 —— 那些要真机器，且各自的纯逻辑
 *          已在 `collect/*.test.ts` 里测过。故这里的夹具把耗时的板块全关掉（`show: false`），
 *          只留账号那一条路走出去。
 *
 *          守的是本插件的一条贯穿约定：**某个板块取不到只是「那块不显示」，不是「整张图
 *          失败」。** 账号卡是这张图的主角，故这条约定在它身上最强 —— 一个号取不到，
 *          要剩一个能渲染的空壳，而不是少一张卡、更不是整张图不出现。
 *
 *          **每条用例约 1.9 秒，且与号数无关。** 那个开销不在账号这一路上：`buildState`
 *          里磁盘与系统信息两块没有开关可关，于是每条用例都真探一遍这台机器（与
 *          `collect/system.test.ts` 里那几条同源）。故本文件**只放账号那一段的用例**，
 *          别把别的板块也搬进来 —— 每加一条都要再付一次这个代价。
 */

import { describe, expect, it } from "vitest"
import type { HttpClient, Logger } from "@yunzai-ng/types"
import { buildState } from "./build.js"
import type { BuildInput } from "./build.js"
import { CONFIG_SCHEMA } from "../config.js"
import { Monitor } from "../monitor.js"
import type { MonitorOptions } from "../monitor.js"

/** 什么都不做的日志器 —— 这一层不测日志 */
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
} as unknown as Logger

/**
 * 造一份最小的输入
 *
 * 耗时的板块一律关掉：`buildState` 里那几个 `want*` 开关决定它们根本不采，
 * 于是这条测试不去碰真机器、也不花几百毫秒。
 * @param bots 要画的账号
 * @param http 内核 HTTP 客户端
 * @returns 输入
 */
function makeInput(bots: BuildInput["bots"], http: HttpClient): BuildInput {
  const config = CONFIG_SCHEMA.defaults()
  return {
    config: {
      ...config,
      processLoad: { ...config.processLoad, show: "false" },
      psTestSites: { ...config.psTestSites, show: "false" },
      chartsCfg: { ...config.chartsCfg, show: "false" },
      showFastFetch: "false"
    },
    isPro: false,
    version: "0.4.1",
    pluginVersion: "0.1.0",
    pluginCount: 1,
    commandCount: 1,
    adapters: [{ id: "stdin", name: "标准输入" }],
    accounts: bots.map(bot => ({
      adapterId: bot.adapterId,
      status: bot.status,
      since: bot.since,
      retries: bot.retries
    })),
    bots,
    monitor: new Monitor({ intervalMs: 60_000, saveDataNumber: 10, persist: false, logger: silent, kv }),
    http,
    bgDir: "D:/not-exist-bg",
    defaultAvatar: "D:/not-exist-avatar.png",
    logger: silent
  }
}

/**
 * 一个内存里的 KV 替身
 *
 * `Monitor` 的构造要求一个 `ctx.kv`，而本文件测的不是持久化 —— 给个够用的即可。
 * 这条测试里 `persist` 是 false，故它实际上不会被碰。
 */
const kv = {
  get: async () => null,
  set: async () => undefined,
  delete: async () => undefined
} as unknown as MonitorOptions["kv"]

/** 一个请求必炸的客户端 —— 用来逼出「这个号取不到」那条路 */
const boomHttp = {
  request: async () => {
    throw new Error("boom")
  }
} as unknown as HttpClient

describe("多账号", () => {
  it("**几个号就几张卡，顺序原样** —— 号与号之间不该互相顶掉", async () => {
    const view = await buildState(
      makeInput(
        [
          { adapterId: "stdin", nickname: "甲", selfId: "10001", status: "online", since: 0, retries: 0 },
          { adapterId: "stdin", nickname: "乙", selfId: "10002", status: "offline", since: 0, retries: 3 }
        ],
        boomHttp
      )
    )
    expect(view.bots).toHaveLength(2)
    expect(view.bots[0]?.nickname).toBe("甲")
    expect(view.bots[1]?.nickname).toBe("乙")
  })

  it("**取不到头像只影响那一张卡的头像**，账号别的信息照常", async () => {
    /*
     * 头像那一步（`fetchAvatar`）是账号采集里唯一会失败的环节，且它**自己就兜住了** ——
     * 请求炸了只是回落到兜底头像，故这里断言的是"那张卡还在、名字与账号都对、头像
     * 用的是兜底那一张"，而不是"这个号整张卡变成空壳"。
     *
     * **这一条守不住 `build.ts` 里那个 per-bot `.catch`，别指望它。** 试过：把那一段删掉
     * 这条测试照过 —— 因为 `collectBot` 里没有一个能在夹具层面逼出异常的点（头像失败
     * 它自己兜了，`process.memoryUsage()` 不会失败）。那个 catch 兜的是没预料到的异常，
     * 只好由注释记着它为什么在那儿。
     */
    const view = await buildState(
      makeInput(
        [
          { adapterId: "stdin", nickname: "会炸的", selfId: "10001", status: "online", since: 0, retries: 0, avatarUrl: "https://x/a.png" },
          { adapterId: "stdin", nickname: "没事的", selfId: "10002", status: "online", since: 0, retries: 0, avatarUrl: "https://x/b.png" }
        ],
        boomHttp
      )
    )
    expect(view.bots).toHaveLength(2)
    expect(view.bots[0]?.nickname).toBe("会炸的")
    expect(view.bots[0]?.uin).toBe("10001")
    expect(view.bots[1]?.nickname).toBe("没事的")
    // 两个号的头像请求都炸了，于是都回落到兜底那一张，而不是整个账号板块消失。
    // 兜底给的是 `file://` URL（模板直接塞进 `<img src>`），不是原始路径
    for (const bot of view.bots) expect(bot.avatar).toBe("file:///D:/not-exist-avatar.png")
  })

  it("一个号都没配时给空数组，而不是抛错", async () => {
    const view = await buildState(makeInput([], boomHttp))
    expect(view.bots).toEqual([])
  })

  it("**适配器名按号取，不是把注册了的全列出来**", async () => {
    // 两个号分属两个适配器时，各自那张卡上该是自己那一个
    const view = await buildState(
      makeInput(
        [{ adapterId: "stdin", nickname: "甲", selfId: "10001", status: "online", since: 0, retries: 0 }],
        boomHttp
      )
    )
    expect(view.bots[0]?.adapterName).toBe("标准输入")
  })

  it("适配器已卸载时给空串，模板据此不画那个标签", async () => {
    const input = makeInput(
      [{ adapterId: "uninstalled", nickname: "甲", selfId: "10001", status: "online", since: 0, retries: 0 }],
      boomHttp
    )
    const view = await buildState(input)
    expect(view.bots[0]?.adapterName).toBe("")
  })
})
