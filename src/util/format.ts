/**
 * 模块职责：字节数与时长的格式化 —— 状态图上每一个数字都要经过这里
 * 依赖方向：不依赖任何东西
 * 生命周期：纯函数
 * 注意事项：**`getFileSize()` 是本插件唯一一处"每个数字都要过"的代码，故它比看起来重要。**
 *          源实现（椰奶的 `model/State/utils.js`）有几处会被读者当成 bug 的行为，此处逐一
 *          处理掉，并把理由写在各自的位置上：
 *
 *          - 单位进位用 1024 而在 B 与 KB 之间**不写小数点**（`512B` 而非 `512.00B`），
 *            与 `ls -h` 一致；
 *          - 负数与 `NaN` 一律当作 0：进程的 CPU 占用、网卡的累计量作差都可能出现负值，
 *            而"-1.00MB"显示在状态图上只会让人以为算错了；
 *          - `decimalPlaces` 非整数时**不抛错**（源实现抛），改为取整 —— 这是个展示函数，
 *            为一个小数位数把整张状态图弄崩不值得。
 */

/** 单位表，从字节起按 1024 进位 */
const UNITS = ["B", "K", "M", "G", "T", "P"] as const

/** `getFileSize()` 的选项 */
export interface FileSizeOptions {
  /** 保留几位小数，缺省 2 */
  readonly decimalPlaces?: number
  /** 小于 1K 时是否显示 `B` 单位，缺省 true；关掉则较小的数只给数字 */
  readonly showByte?: boolean
  /** 数值与单位是否分开返回，缺省 false */
  readonly aloneUnit?: boolean
  /** 单位是否带 `B` 后缀（`MB` 对 `M`），缺省 true */
  readonly showSuffix?: boolean
}

/** `aloneUnit` 为真时 `getFileSize()` 的返回值 */
export interface FileSizeParts {
  /** 数值部分，已按 `decimalPlaces` 格式化 */
  readonly size: string
  /** 单位部分，带前导空格 */
  readonly suffix: string
}

/**
 * 把字节数格式化成易读的字符串
 *
 * 两个重载而非一个联合返回类型：`aloneUnit` 这一项直接决定了返回的是字符串还是拆分后的
 * 两部分，让调用方拿着 `string | FileSizeParts` 自己去收窄是没道理的 —— 它本来就知道
 * 自己传了哪个开关。
 * @param size 字节数；非有限值或负数一律按 0 处理
 * @param opts 格式化选项；`aloneUnit` 不为真
 * @returns 形如 `1.50 MB` 的字符串
 */
export function getFileSize(size: number, opts?: FileSizeOptions & { aloneUnit?: false }): string
/**
 * 把字节数格式化成拆分的数值与单位
 *
 * 数值与单位分开，是因为模板里要在两者之间插一个 `/s`（网速那一格）——
 * 拼成一个字符串之后再切开去插，是更脆的做法。
 * @param size 字节数；非有限值或负数一律按 0 处理
 * @param opts 格式化选项；`aloneUnit` 为真
 * @returns 数值与单位两部分
 */
/* eslint-disable no-redeclare, jsdoc/require-jsdoc -- 重载 + 实现体是 TS 的合法写法，这两个规则要断言的东西正与它冲突 */
export function getFileSize(size: number, opts: FileSizeOptions & { aloneUnit: true }): FileSizeParts
/*
 * 实现体
 *
 * 实现签名不对外 —— 使用者只看得到上面两个重载，文档写在那两处，此处不重复。
 * 用块注释而非 JSDoc：落在重载之后的 JSDoc 会被 `jsdoc/require-jsdoc` 当成第三个
 * 重载的文档，而它并不是。
 */
export function getFileSize(size: number, opts: FileSizeOptions = {}): string | FileSizeParts {
/* eslint-enable no-redeclare, jsdoc/require-jsdoc */
  const { aloneUnit = false } = opts
  // `Math.trunc` 而非 `Math.round`：小数位数给 1.5 时按 1 处理，可预期
  const places = Math.min(Math.max(Math.trunc(opts.decimalPlaces ?? 2), 0), 10)
  const showSuffix = opts.showSuffix ?? true
  const showByte = opts.showByte ?? true

  // 非有限值（NaN / Infinity）与负数都归零，理由见文件头
  const bytes = Number.isFinite(size) && size > 0 ? size : 0

  // 小于 1K 时停在 B 这一级，且不补小数（`512B` 而非 `512.00B`）
  let index = 0
  let value = bytes
  if (bytes >= 1024) {
    while (index < UNITS.length - 1 && value >= 1024) {
      value /= 1024
      index += 1
    }
  }

  const isByte = index === 0
  const text = isByte ? String(Math.round(value)) : value.toFixed(places)
  const suffix = ` ${UNITS[index]}${isByte || !showSuffix ? "" : "B"}`

  if (aloneUnit) return { size: text, suffix }
  // `showByte` 关掉时，小于 1K 的数值连单位一起省掉
  if (isByte && !showByte) return text
  return text + suffix
}

/**
 * 把秒数格式化成 `3天 04:05:06` 一类的时长
 *
 * 源插件用 moment 做这件事，而整份代码里 moment 只被用了这一处 —— 为一个格式化函数
 * 引一个三百多 KB 的包不值得。此处手写，且**天数只在非零时出现**：`00:12:34` 比
 * `0天 00:12:34` 好读。
 * @param seconds 秒数；非有限值或负数按 0 处理
 * @returns 时长字符串
 */
export function formatDuration(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60

  const clock = [hours, minutes, secs].map(part => String(part).padStart(2, "0")).join(":")
  return days > 0 ? `${days}天 ${clock}` : clock
}

/**
 * 按当前本地时间给出 `YYYY-MM-DD HH:mm:ss`
 *
 * 同样是为了不引 moment。用 `Intl` 的 `sv-SE` 区域（其日期格式恰是 ISO 那样的
 * `YYYY-MM-DD`）再拼时间，比手写 `getMonth() + 1` 可靠 —— 后者的补零容易漏。
 * @param at 时间戳，缺省当前时刻
 * @returns 格式化后的时间
 */
export function formatDateTime(at: number = Date.now()): string {
  // `sv-SE` 的日期部分天然是 `YYYY-MM-DD`，时间部分是 `HH:mm:ss`
  const parts = new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(at))
  return parts.replace(",", "")
}
