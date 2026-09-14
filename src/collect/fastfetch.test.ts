/**
 * 模块职责：`collect/fastfetch.ts` 里两个纯函数的测试 —— 色码剥离与输出解析
 * 依赖方向：被测模块
 * 生命周期：测试
 * 注意事项：**色码那三条正则值得盯紧，因为它们写得"不直观"。** 为了绕开
 *          `no-control-regex`，ESC 与 BEL 是用 `String.fromCharCode` 拼出来的，
 *          正则里于是出现了给读者看的反斜杠 —— 而那正是容易写错一层的地方
 *          （先前的确写错过一次：`\\]` 少了一个反斜杠，正则就把 `]` 当字面量匹配了）。
 *          故这里用真实的转义字节做输入，而不是用 `\u001b` 这种文本。
 */

import { describe, expect, it } from "vitest"
import { parseFastfetch, stripAnsi } from "./fastfetch.js"

/** 真实的 ESC 字节 */
const ESC = "\u001b"
/** 真实的 BEL 字节 */
const BEL = "\u0007"

describe("stripAnsi", () => {
  it("剥掉 SGR 色码", () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe("red")
    expect(stripAnsi(`${ESC}[38;2;255;0;0;48;2;0;0;0mX${ESC}[m`)).toBe("X")
  })

  it("剥掉带问号参数与多字母终止符的 CSI 序列", () => {
    // 光标控制：`ESC [ ?25l` 隐藏光标、`ESC [ 2J` 清屏
    expect(stripAnsi(`${ESC}[?25lhidden${ESC}[2J`)).toBe("hidden")
    expect(stripAnsi(`a${ESC}[1;2Hb`)).toBe("ab")
  })

  it("剥掉以 BEL 结尾的 OSC 序列", () => {
    // fastfetch 用 OSC 设置终端标题
    expect(stripAnsi(`${ESC}]0;title${BEL}text`)).toBe("text")
    expect(stripAnsi(`${ESC}]8;;http://example.com${BEL}link${ESC}]8;;${BEL}`)).toBe("link")
  })

  it("剥掉以 `ESC \\` 结尾的 OSC 序列", () => {
    // 另一种 OSC 终止符。这一条先前写错过 —— 正则里少了一层反斜杠，
    // 于是 `]` 与 `\` 都成了字面量，序列剥不掉
    expect(stripAnsi(`${ESC}]0;title${ESC}\\text`)).toBe("text")
  })

  it("剥掉裸的单字符转义", () => {
    expect(stripAnsi(`a${ESC}Mb`)).toBe("ab")
    expect(stripAnsi(`${ESC}c`)).toBe("")
  })

  it("没有色码时原样返回", () => {
    expect(stripAnsi("plain text")).toBe("plain text")
    expect(stripAnsi("")).toBe("")
    expect(stripAnsi("中文与符号：a-b_c[1]")).toBe("中文与符号：a-b_c[1]")
  })

  it("剥掉连续的多个序列", () => {
    const input = `${ESC}[1m${ESC}[31m${ESC}[4m加粗红下划线${ESC}[0m`
    expect(stripAnsi(input)).toBe("加粗红下划线")
  })

  it("不误伤普通方括号", () => {
    // `[0-9;?]*[A-Za-z]` 若漏了 ESC 前缀，`[abc` 这种普通文本会被吃掉
    expect(stripAnsi("array[0] 与 [abc]")).toBe("array[0] 与 [abc]")
  })
})

describe("parseFastfetch", () => {
  it("解析出标题与条目", () => {
    const raw = ["user@host", "-----------", "OS: Windows 11", "Kernel: 10.0.22621"].join("\n")
    const view = parseFastfetch(raw)
    expect(view.title).toBe("user@host")
    expect(view.lines).toEqual([
      { key: "OS", value: "Windows 11" },
      { key: "Kernel", value: "10.0.22621" }
    ])
  })

  it("按第一个冒号切分 —— 值里常含冒号", () => {
    // `Shell: C:\WINDOWS\system32\cmd.exe`：按最后一个冒号切会把键名截坏
    const view = parseFastfetch("Shell: C:\\WINDOWS\\system32\\cmd.exe")
    expect(view.lines).toEqual([{ key: "Shell", value: "C:\\WINDOWS\\system32\\cmd.exe" }])
  })

  it("丢掉分隔行（`-` / `─` / `=`）", () => {
    const raw = ["host", "------", "OS: Linux", "═════", "Kernel: 6.1"].join("\n")
    const view = parseFastfetch(raw)
    expect(view.title).toBe("host")
    expect(view.lines.map(item => item.key)).toEqual(["OS", "Kernel"])
  })

  it("第一条无冒号的行是标题，其后无冒号的行丢掉", () => {
    // fastfetch 的 logo 与 `--pipe` 没关掉的图形会落在这里
    const raw = ["host", "logo line without colon", "OS: Linux"].join("\n")
    const view = parseFastfetch(raw)
    expect(view.title).toBe("host")
    expect(view.lines).toEqual([{ key: "OS", value: "Linux" }])
  })

  it("丢掉空值的行", () => {
    // 某些版本在取不到某个字段时会留一行只有键名的
    const raw = ["host", "OS: Linux", "GPU:", "Disk: "].join("\n")
    const view = parseFastfetch(raw)
    expect(view.lines).toEqual([{ key: "OS", value: "Linux" }])
  })

  it("处理 CRLF（Windows 上 fastfetch 的输出）", () => {
    const raw = "host\r\n------\r\nOS: Windows 11\r\n"
    const view = parseFastfetch(raw)
    expect(view.title).toBe("host")
    expect(view.lines).toEqual([{ key: "OS", value: "Windows 11" }])
  })

  it("先剥色码再解析", () => {
    const raw = `${ESC}[1mhost${ESC}[0m\n${ESC}[34mOS${ESC}[0m: ${ESC}[32mLinux${ESC}[0m`
    const view = parseFastfetch(raw)
    expect(view.title).toBe("host")
    expect(view.lines).toEqual([{ key: "OS", value: "Linux" }])
  })

  it("空输入给空结果", () => {
    expect(parseFastfetch("")).toEqual({ title: "", lines: [] })
    expect(parseFastfetch("\n\n  \n")).toEqual({ title: "", lines: [] })
  })

  it("冒号在行首时不当成键值对", () => {
    // `at <= 0` 的判断就是为这个：`at === 0` 时键名会是空串。它要么当标题，
    // 要么在标题已定之后被丢掉 —— 无论哪种，都不该产出一个空键名的条目
    expect(parseFastfetch(": leading colon").lines).toEqual([])
    expect(parseFastfetch("host\n: x").lines).toEqual([])
  })

  it("保留值里的前导缩进之外的空白", () => {
    const view = parseFastfetch("OS:   Linux   ")
    expect(view.lines).toEqual([{ key: "OS", value: "Linux" }])
  })
})
