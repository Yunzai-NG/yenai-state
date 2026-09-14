/**
 * 模块职责：`collect/disk.ts` 里几个纯函数的测试 —— 挂载点归一化、配色分档、环偏移
 * 依赖方向：被测模块
 * 生命周期：测试
 * 注意事项：**`normalizeMount` 是这里唯一真正容易写错的一个。** 它要解决的是同一个盘在两份
 *          数据源里写法不同：内核的 `probeDisks()` 在 Windows 上给 `C:\`，而 `si.fsSize()`
 *          给 `C:`，Linux 上前者给 `/` 后者也给 `/`。配不上的后果是"文件系统 ext4"那一行
 *          在 Windows 上永远不出现，而不看代码根本看不出为什么。
 */

import { describe, expect, it } from "vitest"
import { DISK_HIGH, DISK_MEDIUM, DISK_PERIMETER, diskColor, diskOffset, normalizeMount, toDiskIo } from "./disk.js"

describe("normalizeMount", () => {
  it("Windows 盘符：`C:\\` 与 `C:` 收敛成同一个键", () => {
    // 这是本函数存在的全部理由
    expect(normalizeMount("C:\\")).toBe(normalizeMount("C:"))
    expect(normalizeMount("C:\\")).toBe("c")
  })

  it("大小写不敏感", () => {
    expect(normalizeMount("D:")).toBe(normalizeMount("d:"))
    expect(normalizeMount("/Data")).toBe(normalizeMount("/data"))
  })

  it("Linux 挂载点原样（小写化后）", () => {
    expect(normalizeMount("/")).toBe("/")
    expect(normalizeMount("/home")).toBe("/home")
    expect(normalizeMount("/mnt/data")).toBe("/mnt/data")
  })

  it("多个尾部反斜杠都去掉", () => {
    expect(normalizeMount("C:\\\\")).toBe("c")
  })

  it("只去掉反斜杠与盘符冒号，不碰正斜杠", () => {
    // Linux 挂载点里的 `/` 是路径的一部分，去掉尾部那个会让 `/a/b/` 与 `/a/b`
    // 变成同一个键 —— 而 `mount` 结尾带不带斜杠在 `si` 与 /proc/mounts 之间确实不一致，
    // 那正是这里该修的。这条断言记录的是"当前没做这件事"
    expect(normalizeMount("/a/b/")).toBe("/a/b/")
    expect(normalizeMount("/a/b")).toBe("/a/b")
  })

  it("尾部冒号只去掉一个", () => {
    expect(normalizeMount("C::")).toBe("c:")
  })

  it("空串给空串", () => {
    expect(normalizeMount("")).toBe("")
  })
})

describe("diskColor", () => {
  it("达到 90% 用高危色", () => {
    expect(diskColor(90, "#abc")).toBe("var(--high-color)")
    expect(diskColor(100, "#abc")).toBe("var(--high-color)")
    // 超过 100% 在只读挂载或配额场景下确实会出现，不该掉到别的档
    expect(diskColor(120, "#abc")).toBe("var(--high-color)")
  })

  it("达到 70% 用警戒色", () => {
    expect(diskColor(70, "#abc")).toBe("var(--medium-color)")
    expect(diskColor(89, "#abc")).toBe("var(--medium-color)")
  })

  it("未到阈值用使用者的配色", () => {
    expect(diskColor(0, "#abc")).toBe("#abc")
    expect(diskColor(69, "#abc")).toBe("#abc")
  })

  it("使用者配色缺失时回落到 CSS 变量", () => {
    expect(diskColor(50, undefined)).toBe("var(--low-color)")
  })

  it("阈值边界不含糊：69 与 70 分属两档，89 与 90 分属两档", () => {
    // 阈值是 90 与 70，比资源环的 0.9 / 0.8 更宽松 —— 一块 85% 的盘该提醒，
    // 而一个 85% 的 CPU 只是忙
    expect(diskColor(69, undefined)).not.toBe(diskColor(70, undefined))
    expect(diskColor(89, undefined)).not.toBe(diskColor(90, undefined))
  })

  it("常量与判断一致", () => {
    expect(DISK_HIGH).toBe(90)
    expect(DISK_MEDIUM).toBe(70)
  })
})

describe("diskOffset", () => {
  it("占用 0 时偏移是整周长（环不画）", () => {
    expect(diskOffset(0)).toBe(DISK_PERIMETER)
  })

  it("占用 1 时偏移是 0（整圈）", () => {
    expect(diskOffset(1)).toBe(0)
  })

  it("占用一半时偏移是一半", () => {
    expect(diskOffset(0.5)).toBeCloseTo(DISK_PERIMETER / 2, 10)
  })

  it("超出 0-1 的一律截断", () => {
    // 模板里这个值直接进 SVG 的 `stroke-dashoffset`，负数会让环反向绕出来
    expect(diskOffset(-1)).toBe(DISK_PERIMETER)
    expect(diskOffset(2)).toBe(0)
  })

  it("非有限值一律按 0 处理，给整周长（环不画）", () => {
    // `Number.isFinite` 那道判断把三者都收敛成 ratio 0。若少了它，`NaN` 会传下去
    // 让 SVG 的 `stroke-dashoffset` 变成字面量 `NaN`，环整个不显示
    expect(diskOffset(Number.NaN)).toBe(DISK_PERIMETER)
    expect(diskOffset(Number.POSITIVE_INFINITY)).toBe(DISK_PERIMETER)
    expect(diskOffset(Number.NEGATIVE_INFINITY)).toBe(DISK_PERIMETER)
  })

  it("周长与模板 CSS 里的半径一致", () => {
    // 半径 54 是写死在 CSS 里的；这里改了而 CSS 没改，环会画不圆
    expect(DISK_PERIMETER).toBeCloseTo(3.14 * 54, 10)
  })
})

describe("toDiskIo", () => {
  it("没有采样时给 undefined —— 模板据此隐去那一行", () => {
    expect(toDiskIo(undefined)).toBeUndefined()
    expect(toDiskIo([])).toBeUndefined()
  })

  it("把字节数格式化成带 span 的 HTML", () => {
    const out = toDiskIo([{ name: "Disk IO", rIO_sec: 1024, wIO_sec: 2048 }])
    expect(out).toHaveLength(1)
    expect(out?.[0]?.name).toBe("Disk IO")
    expect(out?.[0]?.rIO_sec).toBe("<span>1.00 KB</span>")
    expect(out?.[0]?.wIO_sec).toBe("<span>2.00 KB</span>")
  })

  it("缺的速率按 0 显示，缺的合计则不出现", () => {
    // `si` 有时不给合计。给 0 会让人以为读+写真的等于 0
    const out = toDiskIo([{ name: "Disk IO", rIO_sec: 1024 }])
    expect(out?.[0]?.rIO_sec).toBe("<span>1.00 KB</span>")
    // `showByte: false` 对 0 也生效：连 `B` 都不给，因为后面跟着的 `/s` 已说明单位
    expect(out?.[0]?.wIO_sec).toBe("<span>0</span>")
    expect(out?.[0]?.tIO_sec).toBeUndefined()
    expect("tIO_sec" in (out?.[0] ?? {})).toBe(false)
  })

  it("合计存在时一并格式化", () => {
    const out = toDiskIo([{ name: "Disk IO", rIO_sec: 1024, wIO_sec: 1024, tIO_sec: 2048 }])
    expect(out?.[0]?.tIO_sec).toBe("<span>2.00 KB</span>")
  })

  it("`showByte: false`：小于 1K 时不带 `B` 后缀", () => {
    // 这一行后面跟着 `/s`，单位已经由它说明了
    const out = toDiskIo([{ name: "Disk IO", rIO_sec: 512, wIO_sec: 512 }])
    expect(out?.[0]?.rIO_sec).toBe("<span>512</span>")
  })

  it("多个设备各出一行", () => {
    const out = toDiskIo([
      { name: "nvme0n1", rIO_sec: 1024 },
      { name: "sda", rIO_sec: 2048 }
    ])
    expect(out?.map(item => item.name)).toEqual(["nvme0n1", "sda"])
  })

  it("负数归零（显示层的事，不是采集层的）", () => {
    const out = toDiskIo([{ name: "Disk IO", rIO_sec: -1024, wIO_sec: 0 }])
    expect(out?.[0]?.rIO_sec).toBe("<span>0</span>")
  })
})
