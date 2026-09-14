/**
 * 模块职责：采集各模块耗时与进程 CPU/内存增量，供「状态debug」回一条文本
 * 依赖方向：只依赖 `@yunzai-ng/core` 的日志类型与同目录的 format
 * 生命周期：每次「状态debug」新建一个实例，随该次渲染结束而废弃
 * 注意事项：**这个模块存在的唯一理由是回答「状态图为什么慢」。** 因此它必须记录的是**各模块各自的
 *          耗时**，而不是总耗时 —— 总耗时使用者自己掐表就有，各模块的耗时只有插件自己知道。
 *
 *          **不写全局变量。** 源实现把 si 挂在 `global.yenai_debug` 上，还往每个事件对象上挂
 *          `e.debugFun`。前者在插件热重载后残留，后者污染内核的事件对象 —— 内核并不知道
 *          `debugFun` 是什么东西（`EventExtensions` 是给插件扩展事件用的，不是给内部临时变量用的）。
 *          此处改为按需 new，由调用方持有。
 *
 *          **未开启 debug 时不记录。** `#add` 仍然正常返回值，只是不往 messages 里写 ——
 *          这样调用处的写法在开关两种情形下完全一致，不必到处 `if (isDebug)`。
 */

/** 一次采样的进程资源占用，与 `process.cpuUsage()` / `process.memoryUsage()` 同形 */
export interface UsageMark {
  /** CPU 累计微秒数 */
  readonly cpu: { readonly user: number; readonly system: number }
  /** RSS 字节数 */
  readonly rss: number
}

/** 采一个进程资源占用点 */
export function markUsage(): UsageMark {
  const cpu = process.cpuUsage()
  return { cpu: { user: cpu.user, system: cpu.system }, rss: process.memoryUsage().rss }
}

/**
 * 把一段微秒数说成易读的毫秒
 *
 * `process.cpuUsage()` 给的是微秒，而"CPU 增量 12345.6ms"比"12345600μs"好读。
 * @param micros 微秒数
 * @returns 毫秒字符串
 */
function ms(micros: number): string {
  return `${(micros / 1000).toFixed(1)} ms`
}

/**
 * 各模块耗时的收集器
 *
 * 用法是固定的三步：`#times()` 包住每个阶段的 Promise、渲染前 `#flush()` 把结果写进日志、
 * 最后 `#report()` 取回那条给使用者看的文本。
 */
export class DebugRecorder {
  /** 是否真的收集 */
  readonly #enabled: boolean

  /** 各模块的耗时，按记录顺序 */
  readonly #timings: { name: string; ms: number }[] = []

  /** 开始时与结束时的进程占用 */
  readonly #begin: UsageMark | undefined
  #end: UsageMark | undefined

  /**
   * @param enabled 是否收集。关掉时本类的一切方法都是空操作（除了照常透传返回值）
   */
  constructor(enabled: boolean) {
    this.#enabled = enabled
    this.#begin = enabled ? markUsage() : undefined
  }

  /**
   * 是否在收集
   * @returns 是否开启
   */
  get enabled(): boolean {
    return this.#enabled
  }

  /**
   * 计时一个 Promise
   *
   * **无论是否在收集都照常透传结果与异常。** 一个只在 debug 模式下才正常工作的状态图，
   * 比一个慢的状态图更难查。
   * @param work 要做的事
   * @param name 模块名，出现在 debug 文本里
   * @returns `work` 的结果
   */
  async time<T>(work: Promise<T>, name: string): Promise<T> {
    if (!this.#enabled) return work
    const start = Date.now()
    try {
      return await work
    } finally {
      this.#timings.push({ name, ms: Date.now() - start })
    }
  }

  /**
   * 并发计时一组 Promise
   * @param works 各任务，与 `names` 一一对应
   * @param names 各任务的名字
   * @returns 各任务的结果，顺序与入参一致
   */
  async times<T>(works: readonly Promise<T>[], names: readonly string[]): Promise<T[]> {
    return Promise.all(works.map((work, index) => this.time(work, names[index] ?? String(index))))
  }

  /** 记录结束时刻的占用 */
  finish(): void {
    if (this.#enabled) this.#end = markUsage()
  }

  /**
   * 生成给使用者看的那条文本
   * @returns 多行文本
   */
  report(): string {
    const begin = this.#begin
    const end = this.#end ?? markUsage()
    const lines = ["-----------状态debug------------", "------------模块执行时间------------"]

    for (const item of this.#timings) lines.push(`${item.name}: ${item.ms} ms`)
    // 总耗时是有意义的一项：它比各模块之和大出的部分就是聚合与渲染之外的等待
    const total = this.#timings.reduce((sum, item) => sum + item.ms, 0)
    lines.push(`（各模块之和: ${total} ms）`)

    if (begin !== undefined) {
      lines.push("-----------资源增量----------")
      const cpuUser = end.cpu.user - begin.cpu.user
      const cpuSystem = end.cpu.system - begin.cpu.system
      const rss = end.rss - begin.rss
      lines.push(`CPU 增量 (user): ${ms(cpuUser)}`)
      lines.push(`CPU 增量 (system): ${ms(cpuSystem)}`)
      // 内存可能因为一次 GC 而变少，故不取绝对值 —— 负增量也是有意义的信息
      lines.push(`内存增量 (RSS): ${(rss / 1024 / 1024).toFixed(2)} MB`)
    }

    lines.push("---------------END---------------")
    return lines.join("\n")
  }
}
