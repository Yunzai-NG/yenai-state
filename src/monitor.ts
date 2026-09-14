/**
 * 模块职责：周期采样 CPU / 内存 / 网络 / 磁盘速率，维护四条环形曲线，并供状态图取用最近一次采样
 * 依赖方向：`systeminformation`、内核的 `ctx.every` / `ctx.kv`、同目录的 disk 类型
 * 生命周期：**挂在 `setup` 里创建，随插件卸载自动停**（内核的 `ctx.every` 会摘除定时器）
 * 注意事项：**采样器是实例而非模块级单例。** 源插件用 `export default new class { ... }()`
 *          在模块加载期就把 `si.observe` 的定时器启起来了 —— 插件热重载后旧实例的定时器
 *          无人清理，于是同一台机器上会有两份采样在跑，曲线数据也彼此覆盖。内核的
 *          `ctx.every()` 在卸载时自动摘除，因此这里只在 `setup` 内创建，不做模块级副作用。
 *
 *          **`ctx.every()` 的 `overlap` 缺省为 `"skip"`**，即上一拍没跑完就跳过这一拍。
 *          这正是源插件那个 `let interval` 布尔锁的语义，且由内核保证，不必自己写。
 *          采样本身可能比间隔还慢（`si.processes()` 在进程多的机器上要几百毫秒，
 *          而网络速率依赖上一次的累计量），跳过比排队正确：排队会让曲线的时间轴挤在一起。
 *
 *          **速率靠两次累计量作差，因此首次采样时速率为 undefined 而非 0。** 0 会被读成
 *          「当前无流量」，而真相是「还没有第二个采样点」。这与内核 `platform/system.ts`
 *          里 `cpuLoad()` 首采样返回 undefined 是同一条理由。
 *
 *          **曲线数据可存入 Redis（`openRedisSaveData`）**，重启后接着画。存取失败一律只记日志、
 *          不抛出 —— 一台没连 Redis 的机器上，状态图的其他部分照常该能用。
 */

import si from "systeminformation"
import type { KvNamespace, Logger, TaskFn } from "@yunzai-ng/types"
import type { DiskIoSample } from "./collect/disk.js"

/** 曲线里的一条，`[时间戳, 数值]` 的数组 */
export type ChartSeries = [number, number][]

/** 四条曲线 */
export interface ChartData {
  /** 上行速率（字节/秒） */
  network: { upload: ChartSeries; download: ChartSeries }
  /** 磁盘读写速率（字节/秒） */
  disksIO: { readSpeed: ChartSeries; writeSpeed: ChartSeries }
  /** CPU 占用（百分数） */
  cpu: ChartSeries
  /** 内存占用（字节，取 `active`） */
  ram: ChartSeries
}

/** 最近一次采样，供状态图显示「当前网速」「当前磁盘速率」 */
export interface LatestSample {
  /** 网卡速率与累计量 */
  network?: {
    /** 网卡名 */
    iface?: string
    /** 下行字节/秒 */
    rx_sec?: number
    /** 上行字节/秒 */
    tx_sec?: number
    /** 累计下行字节 */
    rx_bytes?: number
    /** 累计上行字节 */
    tx_bytes?: number
  }
  /** 磁盘速率 */
  disksIO?: readonly DiskIoSample[]
}

/** 采样器构造参数 */
export interface MonitorOptions {
  /** 采样间隔毫秒 */
  readonly intervalMs: number
  /** 每条曲线保留的数据点个数 */
  readonly saveDataNumber: number
  /** 是否把曲线数据存入 KV */
  readonly persist: boolean
  /** 日志 */
  readonly logger: Logger
  /** 插件 KV，用于持久化曲线 */
  readonly kv: KvNamespace
}

/** 曲线数据的 KV 键；沿用源插件的键名，便于从椰奶迁过来时已有数据仍可用 */
export const CHART_DATA_KEY = "state:chartData"

/**
 * `ctx.kv` 写入用 `DurationLike`（毫秒数或 `"12h"` 一类字符串）。
 *
 * `si` 那边没有可复用的东西，故此处手写一个常量：写死毫秒数会被读成"这个魔数是什么"，
 * 写字符串则一眼可见。
 */
const CHART_TTL = "12h"

/**
 * 往一条曲线里追加一个点，超出上限就丢掉最旧的
 *
 * 就地修改而不返回新数组：这个方法每拍要为四条曲线各调一次，每次都复制整个数组
 * 是没必要的开销（曲线最长也就几十个点，但四条加起来每拍复制一遍是纯浪费）。
 * @param series 曲线
 * @param point 数据点
 * @param max 上限
 */
export function pushPoint(series: ChartSeries, point: [number, number], max: number): void {
  if (series.length >= max) series.shift()
  series.push(point)
}

/** 新建一份空曲线 */
export function emptyChartData(): ChartData {
  return {
    network: { upload: [], download: [] },
    disksIO: { readSpeed: [], writeSpeed: [] },
    cpu: [],
    ram: []
  }
}

/**
 * 把外部读来的曲线数据归并进一份空曲线
 *
 * **只接受形状对得上的项。** 这份数据可能来自上一个版本的本插件、或一个被手改过的
 * KV 值；直接展开会让一个缺 `network` 字段的对象把模板搞崩，而那是在渲染时才炸的，
 * 排查起来离现场很远。逐项校验的代价是几行代码，收益是"脏数据最多丢一条曲线"。
 * @param raw 读到的值
 * @returns 归并后的曲线
 */
export function reviveChartData(raw: unknown): ChartData {
  const out = emptyChartData()
  if (typeof raw !== "object" || raw === null) return out
  const source = raw as Record<string, unknown>

  /**
   * 取出一条合法的曲线，非法时保留空数组
   * @param value 待校验的值
   * @returns 合法的曲线
   */
  const series = (value: unknown): ChartSeries => {
    if (!Array.isArray(value)) return []
    return value.filter(
      (item): item is [number, number] =>
        Array.isArray(item) &&
        item.length === 2 &&
        typeof item[0] === "number" &&
        Number.isFinite(item[0]) &&
        typeof item[1] === "number" &&
        Number.isFinite(item[1])
    )
  }

  const net = source["network"] as Record<string, unknown> | undefined
  const io = source["disksIO"] as Record<string, unknown> | undefined
  out.network.upload = series(net?.["upload"])
  out.network.download = series(net?.["download"])
  out.disksIO.readSpeed = series(io?.["readSpeed"])
  out.disksIO.writeSpeed = series(io?.["writeSpeed"])
  out.cpu = series(source["cpu"])
  out.ram = series(source["ram"])
  return out
}

/**
 * 磁盘速率的采样值换算成字节
 *
 * `si` 给的是 KB/s（其文档写作 kbytes），而曲线与显示都用字节。**这是 `si` 的通病：
 * `disksIO` 系列以 KB 计，`networkStats` 系列以字节计**，两者不一致且都不在返回值里标明，
 * 只能各自按文档处理。弄错的后果是磁盘速率恒显示为实际的 1/1024。
 *
 * 参数接 `number | null | undefined`：`si` 的类型声明里这些字段是可空的，而它自己的
 * catch 分支也确实会给出 null。
 * @param value `si` 给出的 KB/s
 * @returns 字节/秒；取不到时 undefined
 */
export function kbToBytes(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value * 1024 : undefined
}

/**
 * 采样器
 *
 * 只做两件事：每拍记一条曲线，以及保留最近一次采样给状态图。它**不渲染**，也不认识
 * 命令 —— 于是「椰奶监控」与状态图上的曲线图取的是同一份数据，两处不会出现两条不同的曲线。
 */
export class Monitor {
  /** 四条曲线 */
  readonly chart: ChartData = emptyChartData()

  /** 最近一次采样 */
  latest: LatestSample = {}

  /** 采到的图表配色等由调用方决定，此处只存原样 */

  readonly #opts: MonitorOptions

  /** 已尝试读回持久化数据的标记，避免每拍都去读一次 */
  #restored = false

  /**
   * @param opts 构造参数
   */
  constructor(opts: MonitorOptions) {
    this.#opts = opts
  }

  /**
   * 从 KV 读回上次的曲线
   *
   * 只在第一次采样前做一次。读不到或形状不对都从空曲线开始 —— 那只是"第一次运行"。
   * @returns 读回即结束
   */
  async restore(): Promise<void> {
    if (this.#restored || !this.#opts.persist) return
    this.#restored = true
    try {
      const raw = await this.#opts.kv.get<unknown>(CHART_DATA_KEY)
      if (raw === undefined || raw === null) return
      const revived = reviveChartData(raw)
      this.chart.network.upload = revived.network.upload
      this.chart.network.download = revived.network.download
      this.chart.disksIO.readSpeed = revived.disksIO.readSpeed
      this.chart.disksIO.writeSpeed = revived.disksIO.writeSpeed
      this.chart.cpu = revived.cpu
      this.chart.ram = revived.ram
      this.#opts.logger.debug("已从 KV 读回监控曲线")
    } catch (err) {
      // 读不回来不是错，只是重启后曲线从零开始
      this.#opts.logger.warn(`读回监控曲线失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 采一拍
   *
   * 四类数据并发取，各自带 catch：一台取不到磁盘速率的机器（容器里常见）仍该看得见
   * 网络曲线，反之亦然。取不到的那一条本拍不追加数据点，曲线因而"断"在那里 ——
   * 这比补一个 0 诚实：0 会被读成"这一拍确实没有流量"。
   * @returns 采完即结束
   */
  async tick(): Promise<void> {
    await this.restore()
    const now = Date.now()
    const max = this.#opts.saveDataNumber

    const [load, mem, net, io] = await Promise.all([
      si.currentLoad().catch(() => undefined),
      si.mem().catch(() => undefined),
      si.networkStats().catch(() => undefined),
      si.disksIO().catch(() => undefined)
    ])

    const cpu = Number(load?.currentLoad)
    if (Number.isFinite(cpu)) pushPoint(this.chart.cpu, [now, cpu], max)

    const active = Number(mem?.active)
    if (Number.isFinite(active) && active > 0) pushPoint(this.chart.ram, [now, active], max)

    /*
     * 网卡与磁盘各取第一项
     *
     * 一台机器上常有 lo、docker0、veth* 等若干个网卡，`networkStats()` 按名字排序后
     * 第一项是主网卡的可能性最大。要挑准需要判断"哪个是默认路由"，那要读路由表，
     * 而内核也没有这个能力 —— 取第一项并把网卡名显示出来，让使用者自己看出来对不对。
     */
    /* `si` 取不到数据时**返回 `null` 而不是抛错**，故 `.catch()` 拦不住它 ——
     * 这一条与下面磁盘那条都要 `!= null`：只判 `undefined` 会让 `null` 一路走进去，
     * 在第一次属性访问上炸掉整个采样（已在实机上撞到过：`Cannot read properties of
     * null (reading 'rIO_sec')`）。`si` 的类型声明把这些字段标成可空，正是这个缘故。
     */
    const iface = net?.[0]
    if (iface != null) {
      const rx = Number(iface.rx_sec)
      const tx = Number(iface.tx_sec)
      const rxBytes = Number(iface.rx_bytes)
      const txBytes = Number(iface.tx_bytes)
      this.latest.network = {
        ...(iface.iface === undefined ? {} : { iface: iface.iface }),
        ...(Number.isFinite(rx) ? { rx_sec: rx } : {}),
        ...(Number.isFinite(tx) ? { tx_sec: tx } : {}),
        ...(Number.isFinite(rxBytes) ? { rx_bytes: rxBytes } : {}),
        ...(Number.isFinite(txBytes) ? { tx_bytes: txBytes } : {})
      }
      if (Number.isFinite(rx) && Number.isFinite(tx)) {
        pushPoint(this.chart.network.download, [now, rx], max)
        pushPoint(this.chart.network.upload, [now, tx], max)
      }
    }

    if (io != null) {
      const read = kbToBytes(io.rIO_sec)
      const write = kbToBytes(io.wIO_sec)
      const total = kbToBytes(io.tIO_sec)
      this.latest.disksIO = [
        {
          // 源插件在这条名字前加「Disk IO ·」以区分于别的设备行，此处沿用
          name: "Disk IO",
          ...(read === undefined ? {} : { rIO_sec: read }),
          ...(write === undefined ? {} : { wIO_sec: write }),
          ...(total === undefined ? {} : { tIO_sec: total })
        }
      ]
      if (read !== undefined && write !== undefined) {
        pushPoint(this.chart.disksIO.readSpeed, [now, read], max)
        pushPoint(this.chart.disksIO.writeSpeed, [now, write], max)
      }
    }

    await this.persist()
  }

  /**
   * 把曲线写回 KV
   *
   * 失败只记一条日志，不抛出。**这条日志是刻意写得比较啰嗦的**：源插件在这里给出的提示
   * 是「如一直报错可进入配置文件将 state.yaml > monitor.openRedisSaveData 设置为 false」，
   * 那正是使用者需要知道的处置办法。
   * @returns 写回即结束
   */
  async persist(): Promise<void> {
    if (!this.#opts.persist) return
    try {
      await this.#opts.kv.set(CHART_DATA_KEY, this.chart, { ttl: CHART_TTL })
    } catch (err) {
      this.#opts.logger.error(
        "存储监控曲线出错。若日志里反复出现本条，请在配置里关闭「把曲线数据存进 Redis」。" +
          `原因：${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * 生成交给 `ctx.every` 的任务体
   *
   * 签名里那个 `signal` 是内核传进来的卸载信号。本任务不需要它 —— 采样是短时的，
   * 卸载时内核会摘掉定时器，正在跑的这一拍自然结束即可。显式接出来只为不去猜
   * `TaskFn` 的形状。
   * @returns 任务函数
   */
  task(): TaskFn {
    return async () => {
      try {
        await this.tick()
      } catch (err) {
        // 单拍失败不该让整个定时器被摘掉
        this.#opts.logger.warn(`采样失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}
