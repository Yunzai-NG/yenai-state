/**
 * 模块职责：`collect/redis.ts` 的测试 —— `INFO` 文本解析与板块数据成形
 * 依赖方向：被测模块
 * 生命周期：测试
 * 注意事项：**这里测的是一段真实 `INFO` 输出，而不是构造出来的理想输入。** 那段文本的
 *          麻烦处在于它混了四种形态：段标题行（`# Server`）、纯数字（`used_memory`）、
 *          点分版本号（`redis_version`）、以及 `db0:keys=1,expires=0` 这种值里带 `=` 的。
 *          一个"看起来对"的解析器会在这四种里挂掉至少一种。
 */

import { describe, expect, it } from "vitest"
import { countDatabases, countKeys, infoNumber, parseInfo, parseKeyspace, toRedisView } from "./redis.js"

/** 一段真实的 `INFO` 输出，含四个段与 `Keyspace` 里的两个库 */
const INFO = `# Server
redis_version:7.0.11
redis_git_sha1:00000000
redis_mode:standalone
os:Linux 5.15.0-91-generic x86_64
arch_bits:64
uptime_in_seconds:123456
uptime_in_days:1

# Clients
connected_clients:5
blocked_clients:0
maxclients:10000

# Memory
used_memory:1048576
used_memory_human:1.00M
used_memory_peak:2097152
mem_fragmentation_ratio:1.02

# Stats
total_commands_processed:987654
instantaneous_ops_per_sec:12
expired_keys:3
evicted_keys:0
keyspace_hits:1000
keyspace_misses:100

# Replication
role:master

# Keyspace
db0:keys=12,expires=3,avg_ttl=0
db1:keys=8,expires=0,avg_ttl=0
`

/** 字节格式化，与 `getFileSize` 的输出对齐但更简单，测的是"有没有把数传对" */
const bytes = (n: number): string => `${String(n)}B`
/** 秒格式化 */
const uptime = (s: number): string => `${String(s)}s`

describe("parseInfo", () => {
  it("留下键值对，丢掉段标题与空行", () => {
    const info = parseInfo(INFO)
    expect(info.get("redis_version")).toBe("7.0.11")
    expect(info.get("used_memory")).toBe("1048576")
    // 段标题不该成为键
    expect(info.has("# Server")).toBe(false)
    expect([...info.keys()].some(key => key.startsWith("#"))).toBe(false)
    // 空行不该成为键
    expect(info.has("")).toBe(false)
  })

  it("值里的 `=` 与 `,` 原样保留", () => {
    // `db0:keys=12,expires=3` 的第一个冒号在 `db0` 之后，按第一个切才正确
    expect(parseInfo(INFO).get("db0")).toBe("keys=12,expires=3,avg_ttl=0")
  })

  it("处理 CRLF", () => {
    expect(parseInfo("a:1\r\nb:2\r\n").get("b")).toBe("2")
  })

  it("丢掉没有冒号的行与冒号在行首的行", () => {
    const info = parseInfo(["no colon here", ":novalue", "ok:1"].join("\n"))
    expect(info.size).toBe(1)
    expect(info.get("ok")).toBe("1")
  })

  it("同名键取最后一次", () => {
    expect(parseInfo("a:1\na:2").get("a")).toBe("2")
  })

  it("空文本给空表", () => {
    expect(parseInfo("").size).toBe(0)
  })
})

describe("infoNumber", () => {
  it("取整数", () => {
    const info = parseInfo(INFO)
    expect(infoNumber(info, "used_memory")).toBe(1048576)
    expect(infoNumber(info, "connected_clients")).toBe(5)
    expect(infoNumber(info, "blocked_clients")).toBe(0)
  })

  it("缺失的键给 undefined 而不是 0", () => {
    // 0 会被读成"确实是 0"，而真相是"这一版没有这个键"
    expect(infoNumber(parseInfo(INFO), "nonexistent")).toBeUndefined()
  })

  it("非数字的值给 undefined —— `redis_version` 这类不能一律转数字", () => {
    const info = parseInfo(INFO)
    expect(infoNumber(info, "redis_version")).toBeUndefined()
    expect(infoNumber(info, "role")).toBeUndefined()
  })

  it("空串给 0 —— `Number('')` 是 0，那是「确实为空」而非缺失", () => {
    expect(infoNumber(parseInfo("a:"), "a")).toBe(0)
  })
})

describe("countDatabases", () => {
  it("数 `dbN` 形式的键", () => {
    expect(countDatabases(parseInfo(INFO))).toBe(2)
  })

  it("没有 Keyspace 段时是 0", () => {
    expect(countDatabases(parseInfo("# Server\nredis_version:7.0.11"))).toBe(0)
  })

  it("不把 `db` 之外的相似键算进去", () => {
    // `databases` 是 `INFO` 里真实存在的配置项，形如 `databases:16`
    const info = parseInfo(["databases:16", "db0:keys=1", "dbx:keys=1", "db:0"].join("\n"))
    expect(countDatabases(info)).toBe(1)
  })
})

describe("countKeys", () => {
  it("把各库的 `keys=` 加起来", () => {
    expect(countKeys(parseInfo(INFO))).toBe(20)
  })

  it("没有 Keyspace 段时是 0", () => {
    expect(countKeys(parseInfo("redis_version:7.0.11"))).toBe(0)
  })

  it("键数为 0 的库也算进去（结果是 0，不报错）", () => {
    expect(countKeys(parseInfo("db0:keys=0,expires=0"))).toBe(0)
  })

  it("非 `dbN` 的键不计入 —— `keyspace_hits` 里也有个 `keys`", () => {
    // 正则锚在 `^|,` 上，若不限制键名，`keyspace_hits:1000` 会被误读
    expect(countKeys(parseInfo("keyspace_hits:1000\nonlykeys=5"))).toBe(0)
  })

  it("值里没有 `keys=` 时不加", () => {
    expect(countKeys(parseInfo("db0:expires=3,avg_ttl=0"))).toBe(0)
  })

  it("`keys=` 不在开头也能认出来", () => {
    expect(countKeys(parseInfo("db0:expires=3,keys=7,avg_ttl=0"))).toBe(7)
  })
})

describe("toRedisView", () => {
  it("把一段完整的 INFO 整理成板块数据", () => {
    const view = toRedisView(INFO, bytes, uptime)
    expect(view).toBeDefined()
    if (view === undefined) return

    expect(view.version).toBe("7.0.11")
    expect(view.uptime).toBe("123456s")
    expect(view.usedMemory).toBe("1048576B")
    expect(view.peakMemory).toBe("2097152B")
    expect(view.fragmentation).toBe("1.02")
    expect(view.clients).toBe(5)
    expect(view.blockedClients).toBe(0)
    expect(view.totalCommands).toBe(987654)
    expect(view.ops).toBe(12)
    expect(view.role).toBe("master")
    expect(view.keys).toBe(20)
    expect(view.hits).toBe(1000)
    expect(view.misses).toBe(100)
    expect(view.databases).toBe(2)
    expect(view.expiredKeys).toBe(3)
    expect(view.evictedKeys).toBe(0)
  })

  it("命中率按 `hits/(hits+misses)` 取整", () => {
    const view = toRedisView(INFO, bytes, uptime)
    // 1000 / 1100 = 90.9...%
    expect(view?.hitRate).toBe(91)
  })

  it("空文本给 undefined —— 那表示没连上 Redis，是正常配置不是错误", () => {
    expect(toRedisView("", bytes, uptime)).toBeUndefined()
    expect(toRedisView("   \n  ", bytes, uptime)).toBeUndefined()
  })

  it("没有版本号时给 undefined —— 说明拿到的不是 INFO 的响应", () => {
    expect(toRedisView("# Server\nrole:master", bytes, uptime)).toBeUndefined()
    // 任意非 INFO 的文本
    expect(toRedisView("PONG", bytes, uptime)).toBeUndefined()
  })

  it("样本为 0 时不给命中率（`0/0` 是未定义，写成 0% 会显得命中率极差）", () => {
    const view = toRedisView("redis_version:7.0.11", bytes, uptime)
    expect(view).toBeDefined()
    expect(view?.hitRate).toBeUndefined()
  })

  it("碎片率缺失时不出现那一项（而不给 `0.00`，那意味着配置出了问题）", () => {
    const view = toRedisView("redis_version:7.0.11\nused_memory:1", bytes, uptime)
    expect(view).toBeDefined()
    expect(view?.fragmentation).toBeUndefined()
    expect("fragmentation" in (view ?? {})).toBe(false)
  })

  it("只给版本号时其余字段有一份合法的零值，不会崩", () => {
    const view = toRedisView("redis_version:7.0.11", bytes, uptime)
    expect(view).toBeDefined()
    if (view === undefined) return
    expect(view.usedMemory).toBe("0B")
    expect(view.clients).toBe(0)
    expect(view.role).toBe("")
    expect(view.keys).toBe(0)
    expect(view.databases).toBe(0)
  })

  it("把取到的数值原样交给格式化函数，不自己换算", () => {
    // 换算归 getFileSize；这里插一层换算会让两处对不上
    const seen: number[] = []
    const spy = (n: number): string => {
      seen.push(n)
      return String(n)
    }
    toRedisView("redis_version:7\nused_memory:123\nused_memory_peak:456", spy, uptime)
    expect(seen).toEqual([123, 456])
  })

  it("把运行秒数原样交给时长格式化函数", () => {
    const seen: number[] = []
    const spy = (s: number): string => {
      seen.push(s)
      return String(s)
    }
    toRedisView("redis_version:7\nuptime_in_seconds:999", bytes, spy)
    expect(seen).toEqual([999])
  })
})

describe("parseKeyspace", () => {
  it("摘出每个库的键数、过期数与平均存活", () => {
    const info = parseInfo("db0:keys=12,expires=3,avg_ttl=0\ndb1:keys=1,expires=0,avg_ttl=900")
    expect(parseKeyspace(info)).toEqual({
      db0: { keys: 12, expires: 3, avg_ttl: 0 },
      db1: { keys: 1, expires: 0, avg_ttl: 900 }
    })
  })

  it("只认 `db数字` 形式的键，不把别的段拉进来", () => {
    // `INFO` 里有一堆长得像键值对的东西（`cmdstat_get:...`），它们不是库
    const info = parseInfo("redis_version:7\ndb0:keys=1,expires=0,avg_ttl=0\ncmdstat_get:calls=5")
    expect(Object.keys(parseKeyspace(info))).toEqual(["db0"])
  })

  it("`avg_ttl` 缺失时给 0 而不是 NaN —— 表格里那一格会直接印出来", () => {
    // 5.0 之前没有这个字段
    const info = parseInfo("db0:keys=7,expires=2")
    expect(parseKeyspace(info)).toEqual({ db0: { keys: 7, expires: 2, avg_ttl: 0 } })
  })

  it("一个库也没有时给空对象", () => {
    expect(parseKeyspace(parseInfo("redis_version:7"))).toEqual({})
  })

  it("字段顺序不影响结果 —— `keys` 不在第一个也是它", () => {
    const info = parseInfo("db0:expires=4,keys=9,avg_ttl=1")
    expect(parseKeyspace(info).db0).toEqual({ keys: 9, expires: 4, avg_ttl: 1 })
  })

  it("只认前面是行首或逗号的 `keys=` —— 否则 `nokeys=5` 会被读成 5 个键", () => {
    // 用 `/(?:^|,)keys=(\d+)/` 而不是 `/keys=(\d+)/` 就是为这个：后者会把任何以
    // `keys=` 结尾的字段名都算进来，于是 `db0:nokeys=5` 也能"数出" 5 个键 ——
    // 数出来的是个不存在的字段，而图的表格里那一格会照印
    expect(parseKeyspace(parseInfo("db0:nokeys=5,expires=1")).db0?.keys).toBe(0)
    expect(parseKeyspace(parseInfo("db0:mykeys=7")).db0?.keys).toBe(0)
    // 真字段仍然认得出来，包括排在逗号后面的
    expect(parseKeyspace(parseInfo("db0:expires=1,keys=5")).db0?.keys).toBe(5)
  })
})
