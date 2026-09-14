/**
 * 模块职责：进程负载表 —— 占用最高的若干进程 + 配置里指定的白名单进程
 * 依赖方向：`systeminformation`、同目录的 format
 * 生命周期：纯函数
 * 注意事项：**这份数据在进程多的机器上取数最慢**（`si.processes()` 要遍历整张进程表，
 *          实测几百毫秒），故默认只在「状态pro」里出现。这不是随意的取舍：状态图是同步
 *          渲染的，多几百毫秒就是使用者多等几百毫秒。
 *
 *          **白名单项以 `$` 开头时会被求值。** 源配置里有一项是
 *          `"$(process.env.SHELL || process.env.COMSPEC || 'sh').split(/\\/|\\\\/).at(-1)"`，
 *          即"当前用的 shell 叫什么"。我保留了这个能力，但**用的是受控求值而非 `eval`**：
 *          见 `resolvePattern`。源实现直接 `globalThis.eval(i.replace("$", ""))`，
 *          而那份配置来自使用者的配置文件 —— 一个 `eval` 一个使用者的配置文件，
 *          等于把任意代码执行写进了配置项。能做的替代是识别那几种实际会用到的写法。
 *
 *          **子进程计数按 pid 归并**：一个 node 主进程带十个 worker，逐个列出只会让表格
 *          全是同名行。源实现的做法是数子进程并在名字后加 `(3)`，此处照办，但把
 *          "谁是子进程"的判断改为按 `parentPid` 相等而非源实现里那个 `includes` 扫描 ——
 *          后者在进程表上万时是 O(n×m)。
 */

import si from "systeminformation"
import { getFileSize } from "../util/format.js"

/** 进程表在模板里所需的一行 */
export interface ProcessRow {
  /** 进程名（或完整命令行），带子进程数后缀 */
  readonly name: string
  /** 进程号 */
  readonly pid: string
  /** CPU 占用，已格式化，如 `12.3%` */
  readonly cpu: string
  /** 内存占用，已格式化 */
  readonly mem: string
  /** 进程状态，模板据此上色 */
  readonly state: string
}

/** 进程表板块的完整数据 */
export interface ProcessView {
  /** 总进程数 */
  readonly all: number
  /** 各状态的计数：运行中 */
  readonly running: number
  /** 各状态的计数：阻塞 */
  readonly blocked: number
  /** 各状态的计数：休眠 */
  readonly sleeping: number
  /** 各状态的计数：状态名认不出来的那些 */
  readonly unknown: number
  /** 行；`"hr"` 表示一条分隔线 */
  readonly list: readonly (ProcessRow | "hr")[]
  /** 当前排序方式，模板据此给表头上色 */
  readonly order: string
}

/** 统计与配置 */
export interface ProcessOptions {
  /** 是否显示完整命令行 */
  readonly showCmd: boolean
  /** 是否列出占用最高的进程 */
  readonly showMax: boolean
  /** 列几个 */
  readonly showNum: number
  /** 排序方式 */
  readonly order: string
  /** 白名单：进程名、命令行，或以 `$` 开头的表达式 */
  readonly list: readonly string[]
  /** 排除的进程名，精确匹配 */
  readonly filterList: readonly string[]
}

/** 告知方式 */
export type ProcessWarn = (message: string, err: unknown) => void

/**
 * 解析一条白名单项
 *
 * **这是对源实现 `eval` 的替代。** 源插件对以 `$` 开头的项直接求值，而该项来自配置文件 ——
 * 那等于把「配置文件里能写任意代码」当成特性。实际上会被用到的只有几种：取环境变量、
 * 取 `process.title`、以及对前者取路径末段。此处显式支持这几种，认不出来的一律当作
 * 普通进程名丢掉（当作进程名去匹配必然匹配不上，效果等同于忽略）。
 * @param pattern 白名单原文
 * @returns 解析出的字面值；无法安全解析时 undefined
 */
export function resolvePattern(pattern: string): string | undefined {
  const text = pattern.trim()
  if (!text.startsWith("$")) return text

  const expr = text.slice(1).trim()

  // `process.title`：最常见的写法，直接支持
  if (/^process\.title$/.test(expr)) return process.title

  // `process.env.NAME`：取环境变量
  const envOnly = /^process\.env\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(expr)
  if (envOnly?.[1] !== undefined) return process.env[envOnly[1]]

  /*
   * `(process.env.A || process.env.B || 'fallback').split(...).at(-1)`
   *
   * 源配置里那一长串。不解释这段 JS，而是认出它的三个部分：候选环境变量、兜底字面量、
   * 以及末尾那次「取路径末段」。这样既支持了实际写法，又不必执行任何代码。
   */
  const candidates = [...expr.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1] ?? "")
  const fallbackMatch = /['"]([^'"]*)['"]\s*\)/.exec(expr)
  const takeBasename = /\.at\(-1\)|\.pop\(\)/.test(expr)

  if (candidates.length > 0) {
    let value: string | undefined
    for (const name of candidates) {
      const found = process.env[name]
      if (found !== undefined && found !== "") {
        value = found
        break
      }
    }
    value ??= fallbackMatch?.[1]
    if (value === undefined || value === "") return undefined
    return takeBasename ? value.split(/[\\/]/).at(-1) : value
  }

  // 认不出来的一律忽略，不去猜
  return undefined
}

/**
 * 把配置里的白名单解析成一组字面值
 * @param patterns 白名单原文
 * @returns 进程名或命令行的候选值
 */
export function resolvePatterns(patterns: readonly string[]): string[] {
  const out: string[] = []
  for (const pattern of patterns) {
    const value = resolvePattern(pattern)
    if (value !== undefined && value !== "") out.push(value)
  }
  return out
}

/**
 * 按 CPU 或内存取前 N 个进程
 * @param list 进程表
 * @param key 排序依据
 * @param count 取几个
 * @returns 前 N 个
 */
export function topBy(
  list: readonly ProcessEntry[],
  key: "cpu" | "mem",
  count: number
): ProcessEntry[] {
  return [...list].sort((a, b) => num(b[key]) - num(a[key])).slice(0, Math.max(0, count))
}

/**
 * 把值收敛成有限数
 *
 * `si.processes()` 的 `cpu` 与 `mem` 在部分平台上会给 null 或字符串，直接比较会让
 * 排序结果带上 undefined 而看不出原因。
 * @param value 原值
 * @returns 有限数；非法时为 0
 */
function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** `si.processes()` 里一项的可用部分 */
export interface ProcessEntry {
  /** 进程名 */
  readonly name?: string
  /** 完整命令行 */
  readonly command?: string
  /** 进程号 */
  readonly pid?: number
  /** 父进程号 */
  readonly parentPid?: number
  /** CPU 占用百分数 */
  readonly cpu?: number
  /** 常驻内存（KB） */
  readonly memRss?: number
  /** 状态 */
  readonly state?: string
  /** 以 `mem` 排序时 `si` 给的百分数 */
  readonly mem?: number
}

/**
 * 采集进程表
 * @param opts 配置
 * @param warn 告知方式
 * @returns 进程表；开关关闭或取数失败时 undefined
 */
export async function collectProcesses(
  opts: ProcessOptions,
  warn: ProcessWarn
): Promise<ProcessView | undefined> {
  let raw: Awaited<ReturnType<typeof si.processes>> | null
  try {
    raw = await si.processes()
  } catch (err) {
    warn("获取进程表失败", err)
    return undefined
  }
  // `si` 取不到数据时**返回 null 而不是抛错**，故 try/catch 拦不住它 —— 少了这一条，
  // 下一行的 `raw.list` 会抛 `Cannot read properties of null`，而那是采集层不该有的崩溃
  if (raw == null) return undefined

  const filter = new Set(opts.filterList)
  const entries = (raw.list as ProcessEntry[]).filter(item => !filter.has(String(item.name ?? "")))

  /** 结果行；`"hr"` 是分隔线 */
  const picked: (ProcessEntry | "hr")[] = []

  if (opts.showMax && opts.showNum > 0) {
    if (opts.order === "cpu_mem") {
      // 各取一半，中间以分隔线隔开 —— 否则使用者会以为下半张表是"CPU 也很高"的那些
      const cpuCount = Math.ceil(opts.showNum / 2)
      picked.push(...topBy(entries, "cpu", cpuCount), "hr", ...topBy(entries, "mem", opts.showNum - cpuCount))
    } else {
      picked.push(...topBy(entries, opts.order === "mem" ? "mem" : "cpu", opts.showNum))
    }
  }

  if (opts.list.length > 0) {
    const patterns = resolvePatterns(opts.list)
    const isWindows = process.platform === "win32"
    /** 白名单命中的进程，按「显示名」归并 */
    const merged = new Map<string, { entry: ProcessEntry; pids: number[]; childNums: number }>()

    for (const entry of entries) {
      // 已经在前 N 名里出现过的进程不再重复列入
      if (picked.some(item => item !== "hr" && item.pid === entry.pid)) continue

      const name = String(entry.name ?? "")
      const command = String(entry.command ?? "")
      // Windows 上进程名带 `.exe` 而使用者配置里写的是不带后缀的
      const nameNoExt = isWindows ? name.replace(/\.exe$/i, "") : name

      const hit =
        patterns.includes(name) || patterns.includes(command) || patterns.includes(nameNoExt)
      if (!hit) continue

      const key = opts.showCmd ? command : name
      const found = merged.get(key)
      if (found === undefined) {
        merged.set(key, { entry, pids: entry.pid === undefined ? [] : [entry.pid], childNums: 0 })
      } else {
        // 同名多开：pid 归并成一串，占用相加 —— 分开列会让表格出现好几行一模一样的名字
        if (entry.pid !== undefined) found.pids.push(entry.pid)
        found.entry = {
          ...found.entry,
          cpu: num(found.entry.cpu) + num(entry.cpu),
          memRss: num(found.entry.memRss) + num(entry.memRss)
        }
        found.childNums += 1
      }
    }

    if (merged.size > 0) {
      if (picked.length > 0) picked.push("hr")
      for (const item of merged.values()) {
        picked.push({ ...item.entry, pid: undefined, parentPid: undefined, ...{ pids: item.pids, childNums: item.childNums } })
      }
    }
  }

  /*
   * 统计各状态的进程数
   *
   * 用 `si` 给的总表而非筛选后的表：使用者看到的"运行中 3"应当是整机的情况。
   */
  const counts = { running: 0, blocked: 0, sleeping: 0, unknown: 0 }
  for (const entry of raw.list as ProcessEntry[]) {
    const state = String(entry.state ?? "").toLowerCase()
    if (state.startsWith("run")) counts.running += 1
    else if (state.startsWith("block") || state.startsWith("wait")) counts.blocked += 1
    else if (state.startsWith("sleep") || state.startsWith("idle")) counts.sleeping += 1
    else counts.unknown += 1
  }

  // 子进程数：按 parentPid 分组数一次，O(n)
  const childCount = new Map<number, number>()
  for (const entry of raw.list as ProcessEntry[]) {
    const parent = num(entry.parentPid)
    if (parent > 0) childCount.set(parent, (childCount.get(parent) ?? 0) + 1)
  }

  const list = picked.map(item => {
    if (item === "hr") return "hr" as const
    const extra = item as ProcessEntry & { pids?: number[]; childNums?: number }
    const pids = extra.pids ?? (extra.pid === undefined ? [] : [extra.pid])
    const children = extra.childNums ?? pids.reduce((sum, pid) => sum + (childCount.get(pid) ?? 0), 0)
    const base = opts.showCmd ? String(item.command ?? item.name ?? "") : String(item.name ?? "")
    return {
      name: children > 0 ? `${base}(${children})` : base,
      pid: pids.join(","),
      cpu: `${num(item.cpu).toFixed(1)}%`,
      // `memRss` 的单位是 KB
      mem: getFileSize(num(item.memRss) * 1024),
      state: String(item.state ?? "")
    }
  })

  return {
    all: num(raw.all),
    ...counts,
    list,
    order: opts.order
  }
}
