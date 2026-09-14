/**
 * 模块职责：本插件的配置 schema —— 面板上状态图的那一页表单
 * 依赖方向：仅依赖 `@yunzai-ng/core` 的 schema 工具
 * 生命周期：模块加载期构造一次，之后只读
 * 注意事项：**字段名与源插件（椰奶）的 `state.yaml` 逐一对齐，取值形态也对齐。** 这是刻意的：
 *          从椰奶迁过来的使用者应当能把原来的 yaml 抄进来，而不是面对一套近义的新名字。
 *          因此 `showRedisInfo` / `showFastFetch` / `processLoad.show` 这些项保留了源插件的
 *          `true | false | pro` 三态语义，而不是被"改良"成布尔 —— 三态里 `pro` 与 `true` 的区别
 *          是使用者实际依赖的（"只在状态pro里显示"）。
 *
 *          **三态一律用 `s.select(...)` 而不是 `s.enum(...)`。** enum 在面板上渲染为一个下拉，
 *          每项只有取值本身；select 允许给每项配 label 与 description，于是"pro 是什么意思"
 *          写在选项上，而不必让使用者去翻文档 —— 一个 `pro` 字样的下拉项没有说明是无法猜的。
 *
 *          **每组都写 `group`**：这一页有二十多个字段，不分组的表单没人愿意看。
 */

import { s } from "@yunzai-ng/core"
import type { Infer } from "@yunzai-ng/core"
import type { DeepReadonly } from "@yunzai-ng/types"

/**
 * 三态开关：显示 / 不显示 / 仅状态pro显示
 *
 * 单独抽出来是因为它在源配置里出现四次，而四次都必须给出同样的三项说明 —— 抄写必然漂移。
 */
const SHOW_MODES = [
  { value: "true", label: "显示", description: "任何状态下都显示" },
  { value: "false", label: "不显示", description: "任何状态下都不显示" },
  { value: "pro", label: "仅 Pro", description: "只有「椰奶状态pro」里显示" }
] as const

/** 已实现的可选系统资源环 */
const RESOURCE_ITEMS = [
  { value: "CPU", label: "CPU", description: "整机 CPU 占用" },
  { value: "RAM", label: "RAM", description: "物理内存占用，并附带缓冲区/缓存的第二圈" },
  { value: "SWAP", label: "SWAP", description: "交换空间占用。未配置交换空间的机器上本项不显示" },
  { value: "GPU", label: "GPU", description: "显卡占用。取不到显卡数据时不显示（无 N 卡的机器即如此）" },
  { value: "Node", label: "Node", description: "本进程的内存占用，占整机已用内存的比例" }
] as const

/** 本插件的配置 schema */
export const CONFIG_SCHEMA = s.object({
  /* ────────────────────────────── 触发 ────────────────────────────── */

  defaultState: s
    .boolean()
    .default(false)
    .title("不带「椰奶」前缀也触发")
    .desc(
      "开启后单独的「状态」二字就会出图。关着时须写成「椰奶状态」—— " +
        "「状态」是个太常用的词，默认让位给别的插件"
    )
    .group("触发")
    .order(1),

  noPro: s
    .boolean()
    .default(false)
    .title("禁用状态Pro")
    .desc("开启后「椰奶状态pro」不再响应，仍按普通状态出图之外的任何 pro 专属板块也一并不显示")
    .group("触发")
    .order(2),

  /* ────────────────────────────── 资源环 ────────────────────────────── */

  systemResources: s
    .array(s.enum(["CPU", "RAM", "SWAP", "GPU", "Node"]))
    .default(["CPU", "RAM", "SWAP", "GPU"])
    .title("显示的系统资源")
    .desc(
      "勾选要画的环，顺序即图上从左到右的顺序。SWAP 与 GPU 取不到数据时会各自隐去，" +
        "因此勾了也不必担心出现一个空环"
    )
    .group("资源环")
    .order(10),

  /* ────────────────────────────── 各板块的显隐 ────────────────────────────── */

  showRedisInfo: s
    .select([...SHOW_MODES])
    .default("true")
    .title("Redis 信息")
    .desc("Redis 的连接数、内存占用与键值统计。未连接 Redis 时本板块自动隐去")
    .group("板块显隐")
    .order(20),

  showFastFetch: s
    .select([
      { value: "true", label: "显示", description: "任何状态下都显示" },
      { value: "false", label: "不显示", description: "任何状态下都不显示" },
      { value: "pro", label: "仅 Pro", description: "只有「椰奶状态pro」里显示" },
      {
        value: "default",
        label: "与源插件一致",
        description: "Windows 上仅 Pro 显示，Linux 等其他系统正常显示 —— 因为 Windows 往往没有 fastfetch"
      }
    ])
    .default("default")
    .title("fastfetch 系统信息")
    .desc("须自行安装 fastfetch（https://github.com/fastfetch-cli/fastfetch）。取不到时本板块隐去，不报错")
    .group("板块显隐")
    .order(21),

  chartsCfg: s
    .object({
      show: s
        .select([...SHOW_MODES])
        .default("true")
        .title("显示网络曲线")
        .desc("状态图里那张上下行网速折线图。数据来自监控任务，故监控未开启时无曲线可画"),
      color: s
        .array(s.string())
        .default(["#2ec7c9", "#b6a2de"])
        .title("曲线配色")
        .desc("依次用于上行、下行两条线")
    })
    .title("网络曲线")
    .group("板块显隐")
    .order(22),

  /* ────────────────────────────── 网络测试 ────────────────────────────── */

  psTestSites: s
    .object({
      show: s
        .select([...SHOW_MODES])
        .default("pro")
        .title("显示网站测试")
        .desc("逐条请求下列网址并报告状态码与延迟"),
      list: s
        .array(
          s.object({
            name: s.string().default("").title("名称").desc("表格里显示的名字"),
            url: s.string().default("").title("网址").desc("要访问的完整 URL"),
            useProxy: s
              .boolean()
              .default(false)
              .title("走代理")
              .desc("使用框架的全局代理访问。境外站点通常需要打开")
          })
        )
        .default([
          { name: "Baidu", url: "https://baidu.com", useProxy: false },
          { name: "Google", url: "https://google.com", useProxy: true }
        ])
        .title("测试的网址"),
      timeout: s
        .duration()
        .default("5s")
        .title("单条超时")
        .desc("超过该时长即计为超时并在表格里标红"),
      concurNum: s
        .number()
        .int()
        .min(1)
        .max(50)
        .default(5)
        .title("并发数")
        .desc("同时发起几条请求。网址较多时调大可以更快出图")
    })
    .title("网站测试")
    .group("网络")
    .order(30),

  /* ────────────────────────────── 监控任务 ────────────────────────────── */

  monitor: s
    .object({
      open: s
        .boolean()
        .default(true)
        .title("开启监控任务")
        .desc("按下方间隔持续采样，为「椰奶监控」与状态图的曲线提供数据。关闭后两者都没有数据可画"),
      getDataInterval: s
        .duration()
        .default("60s")
        .title("采样间隔")
        .desc("间隔越短曲线越精确，代价是采样本身的开销。内核另有 1 秒的下限"),
      saveDataNumber: s
        .number()
        .int()
        .min(5)
        .max(1440)
        .default(60)
        .title("保留数据点")
        .desc("每条曲线最多保留多少个采样点，超出后丢弃最旧的。60 个点按 60 秒间隔即一小时"),
      openRedisSaveData: s
        .boolean()
        .default(true)
        .title("把曲线数据存进 Redis")
        .desc(
          "存入后重启框架不会丢掉已有曲线。未连接 Redis 或存取报错时会自动跳过，" +
            "但每次都会记一条错误日志 —— 若日志里反复出现该错误，关掉本项即可"
        )
    })
    .title("监控任务")
    .group("监控")
    .order(40),

  /* ────────────────────────────── 进程负载 ────────────────────────────── */

  processLoad: s
    .object({
      show: s
        .select([...SHOW_MODES])
        .default("pro")
        .title("显示进程负载")
        .desc("列出占用最高的若干进程。进程表在进程多的机器上取数较慢，故默认只在 Pro 里出现"),
      showCmd: s
        .boolean()
        .default(false)
        .title("显示完整命令行")
        .desc("开启后显示进程的完整命令行而非进程名。同名多开的进程据此才能区分"),
      showMax: s
        .object({
          show: s.boolean().default(true).title("显示占用最高的进程").desc("关掉则只显示下方白名单里的进程"),
          showNum: s
            .number()
            .int()
            .min(1)
            .max(50)
            .default(6)
            .title("显示个数")
            .desc("按下方排序方式取前几名"),
          order: s
            .select([
              { value: "cpu", label: "按 CPU", description: "取 CPU 占用最高的若干" },
              { value: "mem", label: "按内存", description: "取内存占用最高的若干" },
              {
                value: "cpu_mem",
                label: "CPU 与内存各半",
                description: "前一半取 CPU 最高的，后一半取内存最高的，中间以分隔线隔开"
              }
            ])
            .default("mem")
            .title("排序方式")
            .desc("以哪一项占用决定谁是「最高」")
        })
        .title("最高占用"),
      list: s
        .array(s.string())
        .default(["node", "redis-server", "chromium"])
        .title("白名单进程")
        .desc(
          "这些进程即使占用不高也会列出。以 $ 开头的项会被当作表达式求值，" +
            "故源配置里的 `$process.title` 在本插件里同样可用"
        ),
      filterList: s
        .array(s.string())
        .default(["System Idle Process"])
        .title("过滤的进程名")
        .desc("精确匹配，命中的进程不出现在列表里。默认滤掉 Windows 的「System Idle Process」" +
          "—— 它的 CPU 占用是「空闲」而非「忙碌」，显示出来只会误导")
    })
    .title("进程负载")
    .group("进程")
    .order(50),

  avatarDownloader: s
    .boolean()
    .default(false)
    .title("用内置下载器取头像")
    .desc(
      "开启后框架主动下载每个账号的头像并以 base64 内嵌，出图不必等浏览器去 QQ 的图床取图。" +
        "取不到时回落到直接引用头像地址"
    )
    .group("账号")
    .order(60),

  /* ────────────────────────────── 样式 ────────────────────────────── */

  style: s
    .object({
      startColumn: s
        .boolean()
        .default(true)
        .title("内容过长时自动分列")
        .desc("板块太多导致图片过高时自动排成 2 至 4 列。关掉则始终单列，图片会很长"),
      backdrop: s
        .string()
        .default("https://t.alcy.cc/mp")
        .title("背景图地址")
        .desc("状态图的整张背景。留空或请求失败时使用下方的兜底背景"),
      backdropDefault: s
        .string()
        .default("random")
        .title("兜底背景")
        .desc(
          "填 random 表示从 resources/img/bg 目录里随机取一张；也可以直接填该目录下的文件名。" +
            "本插件自带 1.jpg 与 2.jpg 两张"
        ),
      BotNameColor: s
        .string()
        .default("#000")
        .title("账号昵称颜色")
        .desc(
          "以 gradient: 开头即为渐变色，如 gradient:271.14deg,#001bff 0.98%,#00f0ff 25.79%"
        ),
      progressBarColor: s
        .object({
          high: s.string().default("#d73403").title("高危色").desc("占用达到 90% 及以上时使用"),
          medium: s.string().default("#ffa500").title("警戒色").desc("占用达到 70% 及以上时使用"),
          low: s
            .array(s.string())
            .default(["#84A0DF", "#2EC272", "#8070F9"])
            .title("正常色")
            .desc("可填多个，各环与各磁盘依次取用，取完从头再来。只有一个时全部使用该色")
        })
        .title("进度条配色"),
      redisInfoValColor: s.string().default("#485ab6").title("Redis 数值颜色").desc("Redis 板块里数字的颜色"),
      botInfoColor: s
        .object({
          botVersion: s.string().default("#FBE0F3").title("版本标签底色").desc("版本号标签的背景色"),
          platform: s.string().default("#F0EDF2").title("平台标签底色").desc("协议端标签的背景色"),
          botRunTime: s.string().default("#F1EBFA").title("运行时长标签底色").desc("运行时长标签的背景色"),
          contacts: s
            .array(s.string())
            .default(["#F1EDFE", "#FDF1E6", "#E9F4FC"])
            .title("联系人标签底色")
            .desc("好友、群组、群员等标签依次取用，取完从头再来")
        })
        .title("账号信息配色")
    })
    .title("样式")
    .group("样式")
    .order(70)
})

/**
 * 本插件的配置类型，由 schema 推导，不另手写第二份
 *
 * **`Infer` 给的是可写形态，而 `ctx.config.get()` 返回的是 `DeepReadonly` 的它。**
 * 故凡是从上下文里取到配置再往下传的地方，参数类型要用 {@link StateConfigRO}——
 * 用可写的那份会在每个数组字段上报「`readonly string[]` 不能赋给 `string[]`」，
 * 而那正是 `progressBarColor.low` 这类字段的形态。
 */
export type StateConfig = Infer<typeof CONFIG_SCHEMA>

/** 从 `ctx.config.get()` 取到的只读配置 */
export type StateConfigRO = DeepReadonly<StateConfig>

/** 三态开关的取值 */
export type ShowMode = "true" | "false" | "pro"

/**
 * 判断某个三态开关在当前这次渲染里是否该显示
 *
 * 源实现把这条判断在七处各写了一遍（`if (!show || (show === "pro" && !e.isPro)) return false`），
 * 每处的写法都略有出入，其中网络测试那处还把 `true` 与 `"pro"` 的比较顺序写反过一次。
 * 收敛到这里，只此一份。
 * @param mode 配置值；缺省或非法时按不显示处理
 * @param isPro 当前是否为「状态pro」
 * @returns 是否显示
 */
export function showFor(mode: string | undefined, isPro: boolean): boolean {
  if (mode === "true") return true
  if (mode === "pro") return isPro
  return false
}

/**
 * `showFastFetch` 的四态判断
 *
 * 与其余三态不同，多一个 `default`：源插件认为 Windows 上多半没有 fastfetch，故默认只在
 * Pro 里显示，而 Linux 上正常显示。这条平台差异是使用者的实际经验，保留。
 * @param mode 配置值
 * @param isPro 当前是否为「状态pro」
 * @param isWindows 当前是否为 Windows
 * @returns 是否显示
 */
export function showFastFetchFor(mode: string | undefined, isPro: boolean, isWindows: boolean): boolean {
  if (mode === "default") return isPro || !isWindows
  return showFor(mode, isPro)
}

export { RESOURCE_ITEMS }
