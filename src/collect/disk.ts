/**
 * 模块职责：磁盘分区占用与磁盘读写速率
 * 依赖方向：`@yunzai-ng/core` 的 `probeDisks`，以及同目录的 format
 * 生命周期：纯函数
 * 注意事项：**分区列表复用内核的 `probeDisks()`，不调 `si.fsSize()`。** 内核那份已经处理了
 *          三件麻烦事：Windows 逐个盘符试访问（`statfs` 在未插卡的读卡器上会等到超时）、
 *          Linux 从 `/proc/mounts` 里排除十余种伪文件系统、以及取 `bavail` 而非 `bfree`
 *          （后者含 ext4 给 root 预留的 5%，会让"可用"偏小）。这些判断写两份必然漂移，
 *          而"同一块盘在两个页面显示不同占用"最难察觉。
 *
 *          代价是内核返回的 `DiskInfo` 只有 `mount / total / free / used` 四项，**没有文件
 *          系统类型**（源插件的模板里要显示 `文件系统 ext4` 那一行）。`si.fsSize()` 才给
 *          `type`。此处按挂载点把两份数据配起来，配不上的就不显示该行 —— 宁缺一个字段，
 *          不为此另起一份分区枚举。
 *
 *          **读写速率的采样由 monitor 负责**，本模块只负责把采到的数格式化成模板要的形状。
 *          `si.fsSize()` 不提供速率，源插件从 `si.observe` 的 `disksIO` 或 fastfetch 拿，
 *          本插件的对应物是 `Monitor`。
 */

import { probeDisks } from "@yunzai-ng/core"
import si from "systeminformation"
import { getFileSize } from "../util/format.js"

/** 磁盘环的周长计算用的半径；与模板 CSS 里 `stroke-dasharray` 的取值必须一致 */
const DISK_RADIUS = 54

/** 磁盘环的周长 */
const DISK_PERIMETER = 3.14 * DISK_RADIUS

/** 一个分区在模板里所需的数据 */
export interface DiskView {
  /** 挂载点；根分区会被加上「(根目录)」后缀 */
  readonly mount: string
  /** 文件系统类型；取不到时不出现，模板据此隐去那一行 */
  readonly type?: string
  /** 已用容量，已格式化 */
  readonly used: string
  /** 总容量，已格式化 */
  readonly size: string
  /** 可用容量，已格式化 */
  readonly available: string
  /** 占用百分比，已取整 */
  readonly use: number
  /** 进度条与环的配色 */
  readonly color: string
  /** 环的 `stroke-dashoffset` */
  readonly per: number
}

/** 磁盘占用率的分档阈值，与源插件一致 */
export const DISK_HIGH = 90
export const DISK_MEDIUM = 70

/** 探测告警方式 */
export type DiskWarn = (message: string, err: unknown) => void

/**
 * 按占用率给一个分区取色
 *
 * 阈值是 90 与 70（百分数），比资源环的 0.9 / 0.8 更宽松 —— 一块 85% 的盘确实该提醒，
 * 而一个 85% 的 CPU 只是忙。同一个数字在不同东西上含义不同，阈值也就不该相同。
 * @param use 占用百分比
 * @param userColor 使用者配置的正常色
 * @returns CSS 颜色
 */
export function diskColor(use: number, userColor: string | undefined): string {
  if (use >= DISK_HIGH) return "var(--high-color)"
  if (use >= DISK_MEDIUM) return "var(--medium-color)"
  return userColor ?? "var(--low-color)"
}

/**
 * 占用率换算成环的 `stroke-dashoffset`
 * @param ratio 占用率（0-1）
 * @returns 偏移量
 */
export function diskOffset(ratio: number): number {
  const safe = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 0
  return DISK_PERIMETER - DISK_PERIMETER * safe
}

/**
 * 取各分区的文件系统类型，按挂载点索引
 *
 * `/proc/mounts` 与 `si.fsSize()` 给出的挂载点写法可能不同（前者是 `/`，后者在 Windows 上
 * 是 `C:` 而内核给的是 `C:\`），故做一次归一化再配。
 * @returns 挂载点到类型的映射；取不到时为空表
 */
async function fsTypes(warn: DiskWarn): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  try {
    const list = await si.fsSize()
    // `si` 取不到数据时返回 null 而不是抛错 —— 见 monitor.ts 里那条注释，
    // 少了这一条 `for...of null` 会抛，而这张表本来就只是"锦上添花"（文件系统类型）
    if (list == null) return out
    for (const item of list) {
      const mount = String(item.mount ?? "")
      const type = String(item.type ?? "")
      if (mount === "" || type === "") continue
      out.set(normalizeMount(mount), type)
    }
  } catch (err) {
    warn("获取文件系统类型失败", err)
  }
  return out
}

/**
 * 归一化挂载点写法
 *
 * Windows 上内核给 `C:\` 而 `si.fsSize()` 给 `C:`；两处都收敛成 `c`。
 * @param mount 挂载点
 * @returns 归一化后的键
 */
export function normalizeMount(mount: string): string {
  return mount
    .replace(/\\+$/, "")
    .replace(/:$/, "")
    .toLowerCase()
}

/**
 * 采集磁盘分区
 * @param palette 未到阈值时各分区依次取用的配色
 * @param warn 告警方式
 * @returns 各分区；一块也探不到时为空数组（模板据此隐去整个板块）
 */
export async function collectDisks(palette: readonly string[], warn: DiskWarn): Promise<DiskView[]> {
  const [disks, types] = await Promise.all([
    probeDisks().catch((err: unknown) => {
      warn("探测磁盘失败", err)
      return []
    }),
    fsTypes(warn)
  ])

  const usable = palette.filter(item => item !== "")
  let cursor = 0
  const out: DiskView[] = []

  for (const disk of disks) {
    if (disk.total <= 0) continue
    const use = Math.round((disk.used / disk.total) * 100)
    // 只有"没到阈值"的分区才从调色盘里取色，理由同资源环
    const color = diskColor(use, undefined)
    const userColor = color === "var(--low-color)" && usable.length > 0 ? usable[cursor++ % usable.length] : undefined
    const type = types.get(normalizeMount(disk.mount))

    out.push({
      // 根分区加后缀，是因为一张图上「/」很难让人一眼认出那是根目录
      mount: disk.mount === "/" ? "/ (根目录)" : disk.mount,
      ...(type === undefined ? {} : { type }),
      used: getFileSize(disk.used),
      size: getFileSize(disk.total),
      available: getFileSize(disk.free),
      use,
      color: userColor ?? color,
      per: diskOffset(disk.used / disk.total)
    })
  }
  return out
}

/** 磁盘读写速率在模板里所需的数据 */
export interface DiskIoView {
  /** 设备名，如 `nvme0n1` */
  readonly name: string
  /** 读速率，已格式化并带单位后缀的 HTML */
  readonly rIO_sec: string
  /** 写速率 */
  readonly wIO_sec: string
  /** 读写合计；取不到时不出现，模板据此隐去那一段 */
  readonly tIO_sec?: string
}

/**
 * 把一次采样到的磁盘速率格式化成模板要的形状
 *
 * **返回值里的 HTML span 是刻意的**：模板用的是 `{{@...}}` 不转义输出，而源模板即按
 * 富文本处理这三项。数值本身来自 `si`，不含使用者输入，故不构成注入面。
 * @param sample 采样到的速率，单位字节/秒；未采到时为 undefined
 * @returns 各设备的速率；无数据时 undefined（模板据此隐去该行）
 */
export function toDiskIo(sample: readonly DiskIoSample[] | undefined): DiskIoView[] | undefined {
  if (sample === undefined || sample.length === 0) return undefined
  return sample.map(item => ({
    name: item.name,
    rIO_sec: `<span>${getFileSize(item.rIO_sec ?? 0, { showByte: false })}</span>`,
    wIO_sec: `<span>${getFileSize(item.wIO_sec ?? 0, { showByte: false })}</span>`,
    ...(item.tIO_sec === undefined
      ? {}
      : { tIO_sec: `<span>${getFileSize(item.tIO_sec, { showByte: false })}</span>` })
  }))
}

/** 一次磁盘速率采样的原始形状，由 monitor 提供 */
export interface DiskIoSample {
  /** 设备名 */
  readonly name: string
  /** 读字节/秒 */
  readonly rIO_sec?: number
  /** 写字节/秒 */
  readonly wIO_sec?: number
  /** 合计字节/秒；`si` 有时不给 */
  readonly tIO_sec?: number
}

export { DISK_PERIMETER }
