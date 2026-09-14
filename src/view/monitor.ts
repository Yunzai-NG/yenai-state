/**
 * 模块职责：为「椰奶监控」命令准备数据 —— 四条曲线 + 一张背景
 * 依赖方向：`src/monitor.ts`（数据源）、`src/view/style.ts`（背景）
 * 生命周期：每次命令调用一次
 * 注意事项：**监控图与状态图取的是同一份曲线数据。** 两者都从 `Monitor` 读，故不会出现
 *          「监控图上的 CPU 曲线与状态图上的不一样」—— 那是源插件里真实存在过的现象，
 *          因为它把采样分成了两个模块级单例。
 *
 *          **曲线为空时不当作错误。** 插件刚启动、或者 `monitor.open` 关着时，四条曲线都是
 *          空数组，模板里的 echarts 会画出一张空网格。这是诚实的呈现（"还没有数据"），
 *          比回一句"监控未开启"更有用 —— 后者让使用者以为命令坏了，而其实再等一分钟就有图。
 *          唯一的例外是一条数据都没有且监控本就是关的，那时确实该说明原因。
 */

import type { Monitor } from "../monitor.js"
import type { StateConfigRO } from "../config.js"
import { parseDuration } from "@yunzai-ng/core"

/** 监控模板要的数据 */
export interface MonitorView {
  /** 四条曲线，JSON 串（模板里 `JSON.parse()` 它） */
  readonly chartData: string
  /** 背景的 CSS 值；取不到时不出现，模板回落到 CSS 里的底色 */
  readonly backdrop?: string
  /** 采样间隔的中文说明，写在副标题里 */
  readonly interval: string
  /** 曲线里最多几个点 */
  readonly maxPoints: number
}

/**
 * 把毫秒间隔说成一句中文
 *
 * **非有限值一律退回缺省的一分钟。** 这个串会印在监控图上，而 `Math.round(NaN)` 会让它变成
 * 「每 NaN 小时」—— 那比一个不对的数字更糟，因为它看起来像程序坏了。调用方通常已经用
 * `parseDuration` 兜过一次，但配置可以被手改 yaml 绕过去。
 * @param ms 毫秒
 * @returns 形如 `每 60 秒` 的说明
 */
export function describeInterval(ms: number): string {
  const safe = Number.isFinite(ms) && ms >= 0 ? ms : 60_000
  if (safe < 60_000) return `每 ${String(Math.round(safe / 1000))} 秒`
  if (safe < 3_600_000) return `每 ${String(Math.round(safe / 60_000))} 分钟`
  return `每 ${String(Math.round(safe / 3_600_000))} 小时`
}

/**
 * 准备监控图的数据
 *
 * 背景**不在这里取**（那要 `ctx.http`，是异步的）。调用方取好后经 `backdrop` 传入 ——
 * 这样本函数是纯的，可以被测试直接调用。
 * @param monitor 采样器
 * @param config 配置
 * @param backdrop 背景的 CSS 值；取不到时 undefined
 * @returns 模板数据
 */
export function buildMonitor(
  monitor: Monitor,
  config: StateConfigRO,
  backdrop: string | undefined
): MonitorView {
  const intervalMs = parseDuration(config.monitor.getDataInterval, 60_000)
  return {
    chartData: JSON.stringify(monitor.chart),
    ...(backdrop === undefined ? {} : { backdrop }),
    interval: describeInterval(intervalMs),
    maxPoints: config.monitor.saveDataNumber
  }
}

/**
 * 四条曲线里一共有多少个数据点
 *
 * 给调用方用来判断「是不是一条数据都还没有」—— 那时该多说一句"等一分钟"。
 * @param monitor 采样器
 * @returns 数据点总数
 */
export function pointCount(monitor: Monitor): number {
  const { chart } = monitor
  return (
    chart.cpu.length +
    chart.ram.length +
    chart.network.upload.length +
    chart.network.download.length +
    chart.disksIO.readSpeed.length +
    chart.disksIO.writeSpeed.length
  )
}
