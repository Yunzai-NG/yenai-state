/**
 * 模块职责：采集「资源使用」那一排环形进度条 —— CPU / RAM / SWAP / GPU / Node
 * 依赖方向：`systeminformation`、`@yunzai-ng/core` 的 `probeGpus`、同目录的 format
 * 生命周期：纯函数 + 两处一次性缓存（CPU 型号、内存规格），缓存随进程存活
 * 注意事项：**每个采集函数取不到数据时返回 `undefined`，绝不返回一个看起来像真数据的 0。**
 *          这是本插件贯穿始终的约定，理由在内核 `platform/system.ts` 的文件头里写得很清楚：
 *          「空数组会被读成确实有 0 块显卡，0% 会被读成 GPU 空闲」。落在这一排环上尤其要紧：
 *          **一个恒为 0% 的 SWAP 环会被读成「交换空间很空闲」，而真相是这台机器没有交换空间。**
 *
 *          **GPU 占用复用内核的 `probeGpus()`，不调 `si.graphics()` 取占用率。** 理由与
 *          `hardware-plugin` 相同：两份 nvidia-smi 解析迟早给出两个数，而「同一块卡在两处
 *          显示不同占用」是最难察觉的那类不一致。型号与显存总量仍取 `si.graphics()` ——
 *          那是内核的 `probeGpus()` 给不出的（它只认 N 卡且不含标称显存）。
 *
 *          源实现在模块顶层用 IIFE 探测型号并赋值给模块级变量（`let cpu = null; (async () => {cpu = await si.cpu()})()`），
 *          这有两个毛病：一是首次请求必然拿到 `null`，于是 CPU 型号在头几秒是空的；二是探测失败
 *          会静默地永远为 `null`。此处改为「首次用到时才探、探过就记住、失败也记住不再重试」。
 */

import si from "systeminformation"
import { probeGpus } from "@yunzai-ng/core"
import { getFileSize } from "../util/format.js"

/** 环的周长计算用的半径；与模板 CSS 里 `stroke-dasharray` 的取值必须一致 */
const RING_RADIUS = 88

/** 环的周长 */
const RING_PERIMETER = 3.14 * RING_RADIUS

/** 一环在模板里所需的数据 */
export interface ResourceRing {
  /** 标题，如 `CPU` */
  readonly title: string
  /** 环中央的文字，如 `42%` */
  readonly inner: string
  /** 环下方的补充说明，通常是型号；没有时不出现 */
  readonly detailed?: string
  /** 环下方的各行文字 */
  readonly info: readonly string[]
  /** 环的描边与进度，由 `toRing()` 填入 */
  readonly percentage?: { readonly per: number; readonly color: string }
  /** RAM 专属：缓冲区/缓存那第二圈 */
  readonly buffcache?: {
    readonly percentage: { readonly per: number; readonly color: string }
    readonly isBuff: boolean
  }
}

/** 已实现的环种类 */
export type ResourceKind = "CPU" | "RAM" | "SWAP" | "GPU" | "Node"

/** 环形进度的配色阈值，与源插件一致 */
export const HIGH_THRESHOLD = 0.9
export const MEDIUM_THRESHOLD = 0.8

/** 探测告警方式 */
export type RingWarn = (message: string, err: unknown) => void

/**
 * 把占用率换算成模板要的环参数
 *
 * **这个函数只负责画环，不管取色。** 取色要按占用率分档，而分档用的阈值在这里；
 * 但"用户自定义的低档色"是逐个环依次取用的，那份计数在调用处 —— 混在一起会让这个
 * 纯函数变成有状态的。
 * @param ratio 占用率（0-1）；超出范围会被夹住
 * @param userColor 使用者配置的正常色，未超出阈值时使用
 * @returns 描边样式
 */
export function toRing(ratio: number, userColor: string | undefined): { per: number; color: string } {
  const safe = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 0
  const per = RING_PERIMETER - RING_PERIMETER * safe
  const color =
    safe >= HIGH_THRESHOLD
      ? "var(--high-color)"
      : safe >= MEDIUM_THRESHOLD
        ? "var(--medium-color)"
        : (userColor ?? "var(--low-color)")
  return { per, color }
}

/* ────────────────────────────── 一次性探测 ────────────────────────────── */

/** CPU 型号与核数，探过一次就记住 */
let cpuModel: { brand?: string; manufacturer?: string; cores?: number; speed?: number } | undefined
let cpuProbed = false

/** 内存规格，同上 */
let memoryClock: number | undefined
let memoryProbed = false

/** 显卡型号表，同上 */
let gpuModels: { name: string; memoryTotal?: number }[] | undefined
let gpuProbed = false

/**
 * 探一次 CPU 型号
 *
 * 三个 `si` 调用并发，彼此无关。任一项失败只让该项缺失，不影响其余 —— Termux 上
 * 取不到型号是常态。
 * @param warn 告警方式
 * @returns 探完即结束
 */
async function probeCpu(warn: RingWarn): Promise<void> {
  cpuProbed = true
  try {
    const cpu = await si.cpu()
    // 同上：`si` 的失败形态是返回 null，不是抛错
    if (cpu == null) return
    cpuModel = {
      ...(cpu.brand === undefined || cpu.brand === "" ? {} : { brand: cpu.brand }),
      ...(cpu.manufacturer === undefined || cpu.manufacturer === "" ? {} : { manufacturer: cpu.manufacturer }),
      ...(typeof cpu.cores === "number" && cpu.cores > 0 ? { cores: cpu.cores } : {}),
      ...(typeof cpu.speed === "number" && cpu.speed > 0 ? { speed: cpu.speed } : {})
    }
  } catch (err) {
    warn("探测 CPU 型号失败", err)
  }
}

/**
 * 探一次内存规格与显卡型号
 * @param warn 告警方式
 * @returns 探完即结束
 */
async function probeMemoryAndGpu(warn: RingWarn): Promise<void> {
  memoryProbed = true
  gpuProbed = true
  const [memory, graphics] = await Promise.all([
    si.memLayout().catch((err: unknown) => {
      warn("探测内存规格失败", err)
      return undefined
    }),
    si.graphics().catch((err: unknown) => {
      warn("探测显卡型号失败", err)
      return undefined
    })
  ])

  // 混插不同规格的内存条时取第一根；把「DDR4 + DDR5」完整呈现出来需要一整个列表，不值得
  const stick = memory?.find(item => item != null && Number(item.size) > 0)
  const clock = Number(stick?.clockSpeed)
  memoryClock = Number.isFinite(clock) && clock > 0 ? clock : undefined

  // `vram` 单位是 MB。虚拟显示器（远程串流装的假屏、Windows 未装驱动的兜底适配器）
  // 通常给 0 或很小的值，按名字排掉 —— 与 hardware-plugin 的启发式一致
  gpuModels = (graphics?.controllers ?? [])
    .map(item => ({
      name: item.model ?? "",
      ...(typeof item.vram === "number" && item.vram > 0 ? { memoryTotal: item.vram * 1024 * 1024 } : {})
    }))
    .filter(item => item.name !== "" && !looksFakeGpu(item.name))
}

/** 判定为虚拟显示器的名字特征，与 `hardware-plugin` 保持同一份清单 */
const FAKE_GPU_HINTS = [
  "virtual",
  "usbmmidd",
  "iddsample",
  "todesk",
  "gameviewer",
  "parsec",
  "sunshine",
  "oray",
  "basic display",
  "mirror driver"
]

/**
 * 这个名字看起来是不是虚拟显示器
 * @param name 型号名
 * @returns 是否应排掉
 */
export function looksFakeGpu(name: string): boolean {
  const lower = name.toLowerCase()
  return FAKE_GPU_HINTS.some(hint => lower.includes(hint))
}

/* ────────────────────────────── 各环 ────────────────────────────── */

/**
 * CPU 环
 *
 * 用 `si.currentLoad().currentLoad`，即整机占用。**不用 `process.cpuUsage()`** ——
 * 那个数只讲本进程，而这一环的标题是「CPU」，会被读成整机。
 * @param warn 告警方式
 * @returns 环数据；取不到时 undefined
 */
async function collectCpu(warn: RingWarn): Promise<ResourceRing | undefined> {
  /*
   * **必须 await，不能 `void`。** 下面第 33 行要读模块级的 `cpuModel`，而它是
   * `probeCpu()` 异步填进去的 —— `void` 掉之后紧接着读，首次调用必然拿到 `undefined`，
   * 表现为状态图上 CPU 环没有型号那一行（实机上撞到过）。`cpuProbed` 这个标记只省掉
   * 后续调用，故只有第一次多等一次 `si.cpu()`，代价可忽略。
   */
  if (!cpuProbed) await probeCpu(warn)

  let load: number | undefined
  try {
    const data = await si.get({ currentLoad: "currentLoad" })
    const value = Number(data.currentLoad.currentLoad)
    if (Number.isFinite(value)) load = value
  } catch (err) {
    warn("获取 CPU 占用失败", err)
  }
  if (load === undefined) return undefined

  const model = cpuModel
  // 厂商名往往是一长串（`GenuineIntel`、`Advanced Micro Devices, Inc.`），取第一个词
  const manufacturer = model?.manufacturer?.split(" ")[0] ?? "unknown"
  const speedText = model?.speed === undefined ? "" : ` ${model.speed}GHz`

  return {
    title: "CPU",
    percentage: toRing(load / 100, undefined),
    inner: `${Math.round(load)}%`,
    ...(model?.brand === undefined ? {} : { detailed: model.brand }),
    info: [`${manufacturer} ${model?.cores ?? "?"}核${speedText}`]
  }
}

/**
 * 内存环
 *
 * `percentage` 用 `active / total`，而 `info` 显示 `active / total` —— 与任务管理器同源。
 * **另附一圈表示 `used / total`**（含缓冲区与缓存），那圈是灰的：两者之差正是"系统为了
 * 加速而占着、真要用了随时能还"的部分，画出来使用者才明白为什么另一个工具显示的数字不同。
 * @returns 环数据；取不到时 undefined
 */
async function collectRam(warn: RingWarn): Promise<ResourceRing | undefined> {
  // 同上，必须 await：下面的 `memoryClock` 由那次探测填入
  if (!memoryProbed) await probeMemoryAndGpu(warn)

  let total = 0
  let used = 0
  let active = 0
  let buffcache = 0
  try {
    const data = await si.get({ mem: "total,used,active,buffcache" })
    total = Number(data.mem.total)
    used = Number(data.mem.used)
    active = Number(data.mem.active)
    buffcache = Number(data.mem.buffcache)
  } catch (err) {
    warn("获取内存占用失败", err)
  }
  if (!Number.isFinite(total) || total <= 0) return undefined

  const activeRatio = Number.isFinite(active) && active > 0 ? active / total : 0
  const usedRatio = Number.isFinite(used) && used > 0 ? used / total : 0
  const isBuff = Number.isFinite(buffcache) && buffcache > 0
  const clock = memoryClock

  return {
    title: "RAM",
    percentage: toRing(activeRatio, undefined),
    inner: `${Math.round(activeRatio * 100)}%`,
    ...(clock === undefined ? {} : { detailed: `${clock}MHz` }),
    info: [
      `${getFileSize(active)} / ${getFileSize(total)}`,
      isBuff ? `缓冲区/缓存 ${getFileSize(buffcache)}` : ""
    ],
    buffcache: {
      // 那一圈恒为灰色，不参与阈值分档 —— 它标示的是"可回收"，不是"危险"
      percentage: { ...toRing(usedRatio, undefined), color: "#bcbbbbb0" },
      isBuff
    }
  }
}

/**
 * 交换空间环
 *
 * **未配置交换空间时返回 undefined，整个环不出现。** 源实现在这种机器上会算出
 * `0/0 = NaN`，于是环上写着 `NaN%` —— 那正是本插件要修掉的那类缺陷。
 * @returns 环数据；未配置或取不到时 undefined
 */
async function collectSwap(warn: RingWarn): Promise<ResourceRing | undefined> {
  let total = 0
  let used = 0
  let free = 0
  try {
    const data = await si.get({ mem: "swaptotal,swapused,swapfree" })
    total = Number(data.mem.swaptotal)
    used = Number(data.mem.swapused)
    free = Number(data.mem.swapfree)
  } catch (err) {
    warn("获取交换空间占用失败", err)
  }
  if (!Number.isFinite(total) || total <= 0) return undefined

  const safeUsed = Number.isFinite(used) ? Math.min(Math.max(used, 0), total) : 0
  const safeFree = Number.isFinite(free) ? Math.min(Math.max(free, 0), total) : total - safeUsed
  const ratio = safeUsed / total

  return {
    title: "SWAP",
    percentage: toRing(ratio, undefined),
    inner: `${Math.round(ratio * 100)}%`,
    detailed: `Available ${getFileSize(safeFree)}`,
    info: [`${getFileSize(safeUsed)} / ${getFileSize(total)}`]
  }
}

/**
 * 显卡环
 *
 * 占用率取内核的 `probeGpus()`。**内核返回 undefined（无 N 卡、或 nvidia-smi 缺失）
 * 时本环不出现**，而不是显示一个 0% —— 后者会被读成"显卡闲着"。集显与无 N 卡的机器上
 * 这个环本就是多余的：它给不出占用率，只给得出型号。
 * @param warn 告警方式
 * @returns 环数据；取不到时 undefined
 */
async function collectGpu(warn: RingWarn): Promise<ResourceRing | undefined> {
  // 同上，必须 await：下面的 `gpuModels` 由那次探测填入
  if (!gpuProbed) await probeMemoryAndGpu(warn)

  let cards: Awaited<ReturnType<typeof probeGpus>>
  try {
    cards = await probeGpus()
  } catch (err) {
    warn("探测显卡占用失败", err)
    return undefined
  }
  // 取第一块有占用率的卡。多卡机器上只画一块是刻意的：一圈环只能表达一个占用率，
  // 而"取了哪一块"写在 detailed 里，使用者能看见
  const card = cards?.find(item => item.load !== undefined)
  if (card?.load === undefined) return undefined

  // 型号与标称显存只有 `si.graphics()` 给得出，内核的 `probeGpus()` 不含这两项
  const model = gpuModels?.find(item => namesMatch(item.name, card.name))

  // `memoryUsed` 与 `memoryTotal` 单位都是字节
  const memText =
    card.memoryUsed === undefined || card.memoryTotal === undefined
      ? undefined
      : `${(card.memoryUsed / 1024 ** 3).toFixed(2)} GB / ${(card.memoryTotal / 1024 ** 3).toFixed(2)} GB`

  return {
    title: "GPU",
    percentage: toRing(card.load, undefined),
    inner: `${Math.round(card.load * 100)}%`,
    detailed: model?.name ?? card.name,
    info: memText === undefined ? [] : [memText]
  }
}

/**
 * 两个显卡名是否指同一块卡
 *
 * nvidia-smi 报的是 `NVIDIA GeForce RTX 4090`，而 `si.graphics()` 可能报
 * `NVIDIA GeForce RTX 4090` 或只报 `RTX 4090` —— 精确比较会让型号总是配不上，
 * 表现为环下那行字退化成 nvidia-smi 的名字（通常更啰嗦但不是错）。故做包含式比较。
 * @param a 名字一
 * @param b 名字二
 * @returns 是否认为是同一块
 */
export function namesMatch(a: string, b: string): boolean {
  const x = a.toLowerCase().trim()
  const y = b.toLowerCase().trim()
  if (x === "" || y === "") return false
  return x.includes(y) || y.includes(x)
}

/**
 * 本进程环
 *
 * `percentage` 是「本进程 RSS 占整机已用内存的比例」，而不是占内存总量的比例 ——
 * 后者会让一个占 500MB 的进程在 32GB 的机器上显示成 2%，看不出它是否在膨胀。
 * @param systemUsed 整机已用内存（字节）；取不到时传 0
 * @returns 环数据
 */
function collectNode(systemUsed: number): ResourceRing {
  const usage = process.memoryUsage()
  const ratio = systemUsed > 0 ? usage.rss / systemUsed : 0

  return {
    title: "Node",
    percentage: toRing(ratio, undefined),
    inner: `${Math.round(ratio * 100)}%`,
    detailed: process.version,
    info: [`总 ${getFileSize(usage.rss)}`, `${getFileSize(usage.heapTotal)} | ${getFileSize(usage.heapUsed)}`]
  }
}

/**
 * 整机已用内存（字节）
 *
 * 与 RAM 环同源（`active / total` 里的 `active`），故两处出现的是同一个数。
 * `os.totalmem() - os.freemem()` 是另一个口径（它把缓冲区与缓存也算作已用），
 * 混用会让「Node 占了 40%」与「RAM 环写着 55%」看起来互相矛盾。
 * @param warn 告警方式
 * @returns 已用字节数；取不到时 0
 */
async function systemUsedMemory(warn: RingWarn): Promise<number> {
  try {
    const data = await si.get({ mem: "total,active" })
    const total = Number(data.mem.total)
    const active = Number(data.mem.active)
    if (!Number.isFinite(total) || total <= 0) return 0
    return Number.isFinite(active) && active > 0 ? Math.min(active, total) : 0
  } catch (err) {
    warn("获取整机内存占用失败", err)
    return 0
  }
}

/* ────────────────────────────── 汇总 ────────────────────────────── */

/**
 * 采集配置里勾选的各环
 *
 * 采集顺序即配置顺序，也就是图上从左到右的顺序。各环并发采集 —— 它们之间毫无关系，
 * 串行只是把耗时相加。
 * @param kinds 要采集的种类，按显示顺序
 * @param palette 未到阈值时各环依次取用的配色；空数组时一律用 `var(--low-color)`
 * @param warn 告警方式
 * @returns 各环；取不到的已在结果里去掉
 */
export async function collectResources(
  kinds: readonly ResourceKind[],
  palette: readonly string[],
  warn: RingWarn
): Promise<ResourceRing[]> {
  // 整机已用内存先取一次，只有配置里勾了 Node 环时才需要
  const needsSystemUsed = kinds.includes("Node")
  const systemUsed = needsSystemUsed ? await systemUsedMemory(warn) : 0

  const results = await Promise.all(
    kinds.map(async kind => {
      try {
        switch (kind) {
          case "CPU":
            return await collectCpu(warn)
          case "RAM":
            return await collectRam(warn)
          case "SWAP":
            return await collectSwap(warn)
          case "GPU":
            return await collectGpu(warn)
          case "Node":
            return collectNode(systemUsed)
          default:
            return undefined
        }
      } catch (err) {
        // 单个环出问题不该让整张图不出来
        warn(`采集 ${kind} 环失败`, err)
        return undefined
      }
    })
  )

  /*
   * 依次给未分档的环配上使用者自定义的低档色
   *
   * **只对"没到阈值"的环计数** —— 一个已经变红的环不该占用调色盘里的一个位置。
   * 源实现是按全部环统一计数，于是改一个环的占用率会让别的环跟着换色，
   * 那种"颜色自己会跳"的表现最难向使用者解释。
   */
  const usable = palette.filter(item => item !== "")
  let cursor = 0
  const out: ResourceRing[] = []
  for (const ring of results) {
    if (ring === undefined) continue
    const percentage = ring.percentage
    if (percentage !== undefined && percentage.color === "var(--low-color)" && usable.length > 0) {
      const color = usable[cursor % usable.length]
      cursor += 1
      out.push({ ...ring, percentage: { ...percentage, ...(color === undefined ? {} : { color }) } })
    } else {
      out.push(ring)
    }
  }
  return out
}

export { RING_PERIMETER }
