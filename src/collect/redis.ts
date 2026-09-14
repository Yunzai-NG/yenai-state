/**
 * 模块职责：解析 Redis `INFO` 文本，给出状态图里那个 Redis 板块的数据
 * 依赖方向：不依赖任何东西（解析是纯函数）；取数由调用方用 `ctx.redis` 注入
 * 生命周期：纯函数
 * 注意事项：**解析 `INFO` 的文本而不是读 `redis.info()` 的对象。** 内核的 Redis 句柄是
 *          ioredis，它的 `info()` 返回的就是这段文本，而这段文本的格式是「`# Section` 标题行、
 *          `key:value` 数据行、空行分隔」—— 解析它只需十来行且不依赖 ioredis 的类型。
 *          用 ioredis 的另一条路（`client.serverInfo`）要等一次 `info` 调用且形态随版本变。
 *
 *          **数值要按需解析，不能一律 `Number()`。** `INFO` 里既有 `used_memory:1048576`
 *          这样的纯数字，也有 `redis_version:7.0.11` 这样的点分版本号，还有
 *          `uptime_in_seconds` 与 `connected_clients`。一律转数字会把版本号变成 `NaN`。
 *          故此处只对调用方点名要的那几个键做数字转换，其余保持字符串。
 *
 *          **`INFO` 的键在不同版本间会增减**（`mem_fragmentation_ratio` 在 7.x 里被
 *          `allocator_frag_ratio` 部分取代），故取不到的键**返回 undefined 而不是 0** ——
 *          与整个插件的采集约定一致：0 会被读成"确实是 0"，而真相是"这一版没有这个键"。
 *
 *          **原始文本与整理后的字段一并给出。** 下面的驼峰字段是给测试与将来的调用方用的
 *          （它们不依赖 `INFO` 的命名），而 `raw` 与 `keyspace` 是给模板用的 —— 模板读的是
 *          `redis.used_memory_human` 这一类 `INFO` 自己的名字。两套名字并存是有意的：把模板
 *          改成读驼峰字段就要连 CSS 与那个前端图表脚本一起动，而搬过来的模板不该为了整齐
 *          再改一遍。翻译在视图层做（`view/template.ts` 的 `toTemplateRedis`）。
 */

/** 一个库的键值统计（`Keyspace` 段里的一行） */
export interface RedisKeyspaceEntry {
  /** 键数 */
  readonly keys: number
  /** 设了过期时间的键数 */
  readonly expires: number
  /** 平均存活毫秒数 */
  readonly avg_ttl: number
}

/** Redis 板块在模板里所需的数据 */
export interface RedisView {
  /**
   * `INFO` 的原文
   *
   * **原始文本要一路留到视图层**，因为模板读的是 `INFO` 自己的键名
   * （`redis.redis_version`、`redis.used_memory_human`、`redis.maxmemory`、
   * `redis.Keyspace.db0.keys`），而那些名字与本结构体下面的驼峰字段是两套体系。
   * 在视图层按需翻译比在这里把两套名字都备一份更省事 —— 模板要什么就现取什么，
   * 不必先在这里猜全。
   */
  readonly raw: string
  /** 各库的键值统计；模板按 `db0` / `db1` 这样的键名遍历 */
  readonly keyspace: Readonly<Record<string, RedisKeyspaceEntry>>
  /** 版本号，如 `7.0.11` */
  readonly version: string
  /** 运行时长，已格式化成 `3天 04:05:06` */
  readonly uptime: string
  /** 已用内存，已格式化 */
  readonly usedMemory: string
  /** 峰值内存，已格式化 */
  readonly peakMemory: string
  /** 内存碎片率，如 `1.02`；取不到时不出现 */
  readonly fragmentation?: string
  /** 客户端连接数 */
  readonly clients: number
  /** 阻塞的客户端数 */
  readonly blockedClients: number
  /** 累计处理的命令数 */
  readonly totalCommands: number
  /** 每秒命令数 */
  readonly ops: number
  /** 角色，如 `master` */
  readonly role: string
  /** 键总数 */
  readonly keys: number
  /** 命中次数 */
  readonly hits: number
  /** 未命中次数 */
  readonly misses: number
  /** 命中率百分数，已取整；样本为 0 时不出现 */
  readonly hitRate?: number
  /** 库数量 */
  readonly databases: number
  /** 已过期键数 */
  readonly expiredKeys: number
  /** 被驱逐的键数 */
  readonly evictedKeys: number
}

/**
 * 解析 `INFO` 文本成一张扁平的表
 *
 * 段标题（`# Server`）被丢掉，只留 `key:value`。**同名的键取最后一次出现的值** ——
 * `INFO` 的 `Keyspace` 段里 `db0:keys=1,expires=0` 这种行没有冒号分隔的短键，
 * 不会与本表的键冲突；而 `Commandstats` 段的 `cmdstat_get:...` 也一样。故不必区分段落。
 * @param text `INFO` 的原文
 * @returns 键到值的映射
 */
export function parseInfo(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    // 空行与段标题（`# Server`）都不是数据
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const at = trimmed.indexOf(":")
    if (at <= 0) continue
    out.set(trimmed.slice(0, at), trimmed.slice(at + 1))
  }
  return out
}

/**
 * 从解析结果里取一个整数
 * @param info 解析结果
 * @param key 键名
 * @returns 整数；缺失或非数字时 undefined
 */
export function infoNumber(info: Map<string, string>, key: string): number | undefined {
  const raw = info.get(key)
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/**
 * 从解析结果里取一个字符串
 * @param info 解析结果
 * @param key 键名
 * @returns 值；缺失时空串
 */
function infoText(info: Map<string, string>, key: string): string {
  return info.get(key) ?? ""
}

/**
 * 数一数 `Keyspace` 段里有几个库
 *
 * 键名形如 `db0` / `db1`，值是 `keys=1,expires=0,avg_ttl=0`。
 * @param info 解析结果
 * @returns 库数量
 */
export function countDatabases(info: Map<string, string>): number {
  let count = 0
  for (const key of info.keys()) {
    if (/^db\d+$/.test(key)) count += 1
  }
  return count
}

/**
 * 数一数所有库里的键总数
 *
 * 取值为 `keys=12,expires=3,avg_ttl=0` 这样的形式，从中摘出 `keys=` 后面那个数。
 * @param info 解析结果
 * @returns 键总数
 */
export function countKeys(info: Map<string, string>): number {
  let total = 0
  for (const [key, value] of info) {
    if (!/^db\d+$/.test(key)) continue
    const found = /(?:^|,)keys=(\d+)/.exec(value)
    if (found?.[1] !== undefined) total += Number(found[1])
  }
  return total
}

/**
 * 解析 `Keyspace` 段
 *
 * 每行的形式是 `db0:keys=12,expires=3,avg_ttl=0`，其中 `avg_ttl` 只在 5.0 之后才有 ——
 * 取不到时留 0（模板里那一格画不出东西，但表格的列数不会错位）。
 * @param info 解析结果
 * @returns 库名到统计的映射
 */
export function parseKeyspace(info: Map<string, string>): Record<string, RedisKeyspaceEntry> {
  const out: Record<string, RedisKeyspaceEntry> = {}
  for (const [key, value] of info) {
    if (!/^db\d+$/.test(key)) continue
    out[key] = {
      keys: readField(value, "keys"),
      expires: readField(value, "expires"),
      avg_ttl: readField(value, "avg_ttl")
    }
  }
  return out
}

/**
 * 从一个 `k=v,k=v` 形式的串里取一个整数
 * @param value 串
 * @param field 字段名
 * @returns 数值；缺失或非数字时 0
 */
function readField(value: string, field: string): number {
  const found = new RegExp(`(?:^|,)${field}=(\\d+)`).exec(value)
  const num = found?.[1] === undefined ? Number.NaN : Number(found[1])
  return Number.isFinite(num) ? num : 0
}

/**
 * 把一份 `INFO` 文本整理成模板要的形状
 *
 * @param text `INFO` 原文
 * @param formatBytes 字节格式化函数（由调用方注入 `getFileSize`，避免此处反向依赖 util）
 * @param formatUptime 时长格式化函数
 * @returns 板块数据；**文本为空（没连上 Redis）时 undefined**，模板据此隐去整个板块
 */
export function toRedisView(
  text: string,
  formatBytes: (bytes: number) => string,
  formatUptime: (seconds: number) => string
): RedisView | undefined {
  if (text.trim() === "") return undefined
  const info = parseInfo(text)
  // 一句 `INFO` 里连版本号都没有，说明拿到的不是 INFO 的响应
  const version = infoText(info, "redis_version")
  if (version === "") return undefined

  const hits = infoNumber(info, "keyspace_hits") ?? 0
  const misses = infoNumber(info, "keyspace_misses") ?? 0
  const totalHits = hits + misses
  const fragmentation = infoText(info, "mem_fragmentation_ratio")

  return {
    raw: text,
    keyspace: parseKeyspace(info),
    version,
    uptime: formatUptime(infoNumber(info, "uptime_in_seconds") ?? 0),
    usedMemory: formatBytes(infoNumber(info, "used_memory") ?? 0),
    peakMemory: formatBytes(infoNumber(info, "used_memory_peak") ?? 0),
    // 取不到这个键时不显示那一行：显示 `0.00` 会让人以为碎片率真的是 0（那意味着配置出了问题）
    ...(fragmentation === "" ? {} : { fragmentation }),
    clients: infoNumber(info, "connected_clients") ?? 0,
    // 这个键在 4.0 之前叫 `blocked_clients`，之后也有 `blocked_clients`；旧版没有时算 0
    blockedClients: infoNumber(info, "blocked_clients") ?? 0,
    totalCommands: infoNumber(info, "total_commands_processed") ?? 0,
    ops: infoNumber(info, "instantaneous_ops_per_sec") ?? 0,
    role: infoText(info, "role"),
    keys: countKeys(info),
    hits,
    misses,
    // 一次命中记录都没有时不给命中率：`0/0` 是未定义，写成 0% 会让人以为命中率极差
    ...(totalHits === 0 ? {} : { hitRate: Math.round((hits / totalHits) * 100) }),
    databases: countDatabases(info),
    expiredKeys: infoNumber(info, "expired_keys") ?? 0,
    evictedKeys: infoNumber(info, "evicted_keys") ?? 0
  }
}
