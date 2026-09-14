/**
 * 模块职责：`collect/process.ts` 里纯函数的测试 —— 白名单表达式解析与排序
 * 依赖方向：被测模块
 * 生命周期：测试
 * 注意事项：**`resolvePattern` 是本插件里唯一一处"替代 `eval`"的代码，故它最需要盯着。**
 *          源插件对以 `$` 开头的白名单项直接 `globalThis.eval(i.replace("$", ""))`，
 *          而那些项来自使用者的配置文件 —— 等于把任意代码执行当成配置项。这里的实现
 *          只认三种实际会用到的写法，认不出的丢掉。故测试分两半：认得出的要认对，
 *          认不出的一律不许执行。
 */

import { describe, expect, it } from "vitest"
import { resolvePattern, resolvePatterns, topBy } from "./process.js"
import type { ProcessEntry } from "./process.js"

describe("resolvePattern", () => {
  it("不以 `$` 开头的项原样返回（去掉首尾空白）", () => {
    expect(resolvePattern("node")).toBe("node")
    expect(resolvePattern("  redis-server  ")).toBe("redis-server")
    expect(resolvePattern("")).toBe("")
  })

  it("`$process.title` 求值成进程标题", () => {
    expect(resolvePattern("$process.title")).toBe(process.title)
    expect(resolvePattern("$ process.title")).toBe(process.title)
  })

  it("`$process.env.NAME` 取环境变量", () => {
    process.env["YZNG_TEST_PROC"] = "my-proc"
    try {
      expect(resolvePattern("$process.env.YZNG_TEST_PROC")).toBe("my-proc")
    } finally {
      delete process.env["YZNG_TEST_PROC"]
    }
  })

  it("环境变量不存在时给 undefined —— 路径名会被当成进程名匹配，匹配不上就等于忽略", () => {
    expect(resolvePattern("$process.env.YZNG_SURELY_NOT_SET_12345")).toBeUndefined()
  })

  it("源配置里那一长串：候选环境变量 + 兜底字面量 + 取路径末段", () => {
    // 源配置里的实际写法。此处不解释这段 JS，而是认出它的三个部分
    process.env["YZNG_TEST_SHELL"] = "/usr/bin/zsh"
    try {
      const pattern =
        "$(process.env.YZNG_TEST_SHELL || process.env.YZNG_TEST_COMSPEC || 'sh').split(/\\\\/|\\\\/).at(-1)"
      expect(resolvePattern(pattern)).toBe("zsh")
    } finally {
      delete process.env["YZNG_TEST_SHELL"]
    }
  })

  it("候选按顺序取第一个非空的", () => {
    process.env["YZNG_TEST_B"] = "second"
    try {
      const pattern = "$(process.env.YZNG_TEST_A || process.env.YZNG_TEST_B || 'fallback').at(-1)"
      expect(resolvePattern(pattern)).toBe("second")
    } finally {
      delete process.env["YZNG_TEST_B"]
    }
  })

  it("候选全空时用兜底字面量", () => {
    const pattern = "$(process.env.YZNG_TEST_X || process.env.YZNG_TEST_Y || 'fallback').at(-1)"
    expect(resolvePattern(pattern)).toBe("fallback")
  })

  it("取路径末段：Windows 反斜杠路径", () => {
    process.env["YZNG_TEST_WIN"] = "C:\\WINDOWS\\system32\\cmd.exe"
    try {
      const pattern = "$(process.env.YZNG_TEST_WIN).at(-1)"
      expect(resolvePattern(pattern)).toBe("cmd.exe")
    } finally {
      delete process.env["YZNG_TEST_WIN"]
    }
  })

  it("不取末段时给出完整路径", () => {
    process.env["YZNG_TEST_PATH"] = "/usr/bin/node"
    try {
      expect(resolvePattern("$process.env.YZNG_TEST_PATH")).toBe("/usr/bin/node")
    } finally {
      delete process.env["YZNG_TEST_PATH"]
    }
  })

  it("认不出的表达式返回 undefined，绝不执行", () => {
    // 这一条是本函数存在的全部理由。若哪天有人把实现改回 eval，这几行会开始执行
    // 任意代码 —— 而它们的内容取自配置文件
    for (const evil of [
      "$process.exit(1)",
      "$require('node:fs').rmSync('/', { recursive: true })",
      "$globalThis.hacked = true",
      "$(() => { throw new Error('boom') })()",
      "$process.mainModule.require('child_process').execSync('echo pwned')",
      "$1+1",
      "$\n\n\n"
    ]) {
      expect(resolvePattern(evil), `不该执行：${evil}`).toBeUndefined()
    }
    // 副作用确实没发生
    expect("hacked" in globalThis).toBe(false)
  })

  it("空的 `$` 给 undefined", () => {
    expect(resolvePattern("$")).toBeUndefined()
    expect(resolvePattern("$   ")).toBeUndefined()
  })
})

describe("resolvePatterns", () => {
  it("丢掉解析不出与解析成空串的项", () => {
    process.env["YZNG_TEST_KEEP"] = "keep"
    try {
      const out = resolvePatterns(["node", "$process.env.YZNG_TEST_KEEP", "$bogus()", "$process.env.YZNG_UNSET_99"])
      expect(out).toEqual(["node", "keep"])
    } finally {
      delete process.env["YZNG_TEST_KEEP"]
    }
  })

  it("空数组给空数组", () => {
    expect(resolvePatterns([])).toEqual([])
  })

  it("重复项不合并（交给下游的 `includes` 判断，那时是集合语义）", () => {
    expect(resolvePatterns(["node", "node"])).toEqual(["node", "node"])
  })
})

describe("topBy", () => {
  /** 造一条进程记录 */
  const entry = (name: string, cpu: number, mem: number): ProcessEntry => ({ name, cpu, mem })

  it("按 CPU 降序取前 N", () => {
    const list = [entry("a", 1, 100), entry("b", 50, 1), entry("c", 10, 50)]
    expect(topBy(list, "cpu", 2).map(item => item.name)).toEqual(["b", "c"])
  })

  it("按内存降序取前 N", () => {
    const list = [entry("a", 1, 100), entry("b", 50, 1), entry("c", 10, 50)]
    expect(topBy(list, "mem", 2).map(item => item.name)).toEqual(["a", "c"])
  })

  it("N 超过长度时全给", () => {
    const list = [entry("a", 1, 1), entry("b", 2, 2)]
    expect(topBy(list, "cpu", 10)).toHaveLength(2)
  })

  it("N 为 0 或负数时给空数组", () => {
    const list = [entry("a", 1, 1)]
    expect(topBy(list, "cpu", 0)).toEqual([])
    expect(topBy(list, "cpu", -5)).toEqual([])
  })

  it("不修改传入的数组", () => {
    // 就地排序会让调用方手里那份顺序悄悄变掉
    const list = [entry("a", 1, 1), entry("b", 2, 2)]
    topBy(list, "cpu", 2)
    expect(list.map(item => item.name)).toEqual(["a", "b"])
  })

  it("null / 非法数值按 0 参与排序，不产生 NaN 比较", () => {
    // `si` 在部分平台上给 null。`undefined - undefined` 是 NaN，比较结果不可预期
    const list: ProcessEntry[] = [
      { name: "a", cpu: undefined, mem: null as unknown as number },
      { name: "b", cpu: 5, mem: 1 },
      { name: "c", cpu: Number.NaN, mem: 2 }
    ]
    expect(topBy(list, "cpu", 3).map(item => item.name)).toEqual(["b", "a", "c"])
  })

  it("排序列全为 0 时顺序稳定（不抛错）", () => {
    const list = [entry("a", 0, 0), entry("b", 0, 0)]
    expect(topBy(list, "cpu", 2)).toHaveLength(2)
  })
})
