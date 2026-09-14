/**
 * 模块职责：调用外部 `fastfetch` 取一份系统摘要，渲染成状态图顶部那一行
 * 依赖方向：`node:child_process`、同目录的 format
 * 生命周期：纯函数
 * 注意事项：**这是一个可选依赖，装了才有。** `fastfetch` / `neofetch` 是使用者自己装的
 *          命令行工具，本插件不打包、不安利、不代装。取不到就当这个功能不存在 ——
 *          **不显示任何「fastfetch 未安装」的提示**：状态图上出现一行"你没装 X"是噪音，
 *          使用者没要求过这个功能。源插件在 `pro` 模式且开关为 `default` 时会在 Windows
 *          上隐去整个板块，原因相同。开关的三态由 `showFastFetchFor()` 判定。
 *
 *          **必须设超时。** `fastfetch` 在有些机器上会卡住（读 SMBIOS / 等某个设备），
 *          而它是同步等子进程的 —— 不设超时的话整张状态图就永远不出来，且看不出卡在哪。
 *          故用 `execFile` 的 `timeout`，并对超时的子进程补一次 `kill`。
 *
 *          **输出要按行剥掉 ANSI 色码再取。** `fastfetch` 默认带颜色（除非传 `--pipe`），
 *          色码直接写进 HTML 会在图上显示成一堆 `^[[38;2;...m`。`--pipe` 参数能让它输出
 *          不带色码的文本，但旧版本不认这个参数会直接退出 —— 故两条路都留着：优先传
 *          `--pipe`，同时无论如何都做一次色码剥离。
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/** 子进程超时毫秒 */
const TIMEOUT_MS = 3000

/** 接受的输出上限；`fastfetch` 正常输出只有几百字节，超过这个数说明它在刷屏 */
const MAX_BUFFER = 64 * 1024

/** fastfetch 板块在模板里所需的数据 */
export interface FastfetchView {
  /** 主机名行，通常形如 `user@host` */
  readonly title: string
  /** 条目行，已剥掉色码 */
  readonly lines: readonly { readonly key: string; readonly value: string }[]
}

/** 探测告警方式 */
export type FastfetchWarn = (message: string, err: unknown) => void

/**
 * 剥掉 ANSI 色码与光标控制序列
 *
 * 覆盖 CSI 序列（`ESC [ ... m` 及同类）与 OSC 序列（`ESC ] ... BEL`，fastfetch 用它设置
 * 终端标题），最后再清一次裸的 `ESC`。
 *
 * 三条正则都**用 `String.fromCharCode` 拼出 ESC 与 BEL 而不是写字面量**：`no-control-regex`
 * 会拦下正则里的裸控制字符，而这里要匹配的正是控制字符 —— 于是要么关掉那条规则
 * （那会连真正的笔误一起放过），要么把这两个字符拼出来。选后者。
 * @param text 原文
 * @returns 纯文本
 */
export function stripAnsi(text: string): string {
  const esc = String.fromCharCode(0x1b)
  const bel = String.fromCharCode(0x07)
  return text
    // OSC：`ESC ] ... BEL` 或 `ESC ] ... ESC \`
    .replace(new RegExp(`${esc}][^${bel}${esc}]*(?:${bel}|${esc}\\\\)`, "g"), "")
    // CSI：`ESC [ 参数 终止字母`
    .replace(new RegExp(`${esc}\\[[0-9;?]*[A-Za-z]`, "g"), "")
    // 其余的单字符转义
    .replace(new RegExp(`${esc}.`, "g"), "")
}

/**
 * 把 `fastfetch` 的输出切成标题与条目
 *
 * 输出形如：
 *
 * ```
 * user@host
 * ---------
 * OS: Windows 11
 * Kernel: 10.0.22621
 * ```
 *
 * 分隔行（整行都是 `-` 或 `─`）丢掉，第一行当标题，其余按第一个 `:` 切成键值。
 * **按第一个冒号切**：值里常含冒号（`Shell: C:\WINDOWS\...`），按最后一个切会把键名截坏。
 * @param raw 子进程输出
 * @returns 标题与条目
 */
export function parseFastfetch(raw: string): FastfetchView {
  const text = stripAnsi(raw)
  const lines = text.split(/\r?\n/).map(line => line.trimEnd())
  /** 标题：第一条非空且不是分隔行、不含冒号的行 */
  let title = ""
  const items: { key: string; value: string }[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    // 分隔行：整行只由 `-` 或制表符组成
    if (/^[-─=\s]+$/.test(trimmed)) continue

    const at = trimmed.indexOf(":")
    if (at <= 0) {
      // 还没有标题时，第一条无冒号的行就是标题（`user@host`）
      if (title === "") title = trimmed
      continue
    }
    const key = trimmed.slice(0, at).trim()
    const value = trimmed.slice(at + 1).trim()
    // 值为空的行（某些版本在取不到某个字段时会留空）不显示 —— 一行只有键名没有值没有意义
    if (key === "" || value === "") continue
    items.push({ key, value })
  }

  return { title, lines: items }
}

/**
 * 取一份 `fastfetch` 输出
 *
 * 先试 `fastfetch`，认不出参数时退到不带 `--pipe` 再试一次；再不行试 `neofetch`
 * （它的输出结构类似，且不少机器上装的是它）。三种都失败就返回 undefined。
 * @param warn 告知方式
 * @returns 板块数据；取不到时 undefined（模板据此隐去整个板块）
 */
export async function collectFastfetch(warn: FastfetchWarn): Promise<FastfetchView | undefined> {
  const attempts: readonly { readonly file: string; readonly args: readonly string[] }[] = [
    // `--pipe` 关掉 logo 与色码，只要几行文本
    { file: "fastfetch", args: ["--pipe", "--logo", "none"] },
    // 旧版不认识 `--pipe`，会带上 logo（下面的解析会把 logo 那些无冒号的行丢掉一部分）
    { file: "fastfetch", args: [] },
    { file: "neofetch", args: ["--stdout"] }
  ]

  for (const attempt of attempts) {
    try {
      const { stdout } = await execFileAsync(attempt.file, [...attempt.args], {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        // 输出按 UTF-8 解，避免中文主机名变成乱码
        encoding: "utf8"
      })
      const parsed = parseFastfetch(stdout)
      if (parsed.lines.length > 0) return parsed
      // 跑通了但没有条目：说明这个版本不认参数，换下一种
    } catch (err) {
      // ENOENT（没装）是最常见的一种，不必每次都记日志刷屏 ——
      // 但也不能完全吞掉：使用者确实需要知道"为什么这一块不见了"。故只在最后一
      // 种尝试也失败时才记一条
      if (attempt === attempts[attempts.length - 1]) {
        warn("未找到可用的 fastfetch / neofetch，状态图中将不显示该板块", err)
      }
    }
  }

  return undefined
}
