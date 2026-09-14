# yenai-state

Yunzai NG 的机器人状态图插件，移植自 [yenai-plugin](https://github.com/yeyang52/yenai-plugin)
的「椰奶状态 / 椰奶状态pro / 椰奶监控」三条命令。

出图内容：账号卡片、系统信息、CPU / 内存 / SWAP / GPU 资源环、磁盘占用、实时网速与累计流量、
进程负载、fastfetch，以及 CPU / 内存 / 上下行网速 / 磁盘 IO 四条曲线。

本仓库是 [Yunzai NG](https://github.com/Yunzai-NG/yunzai-ng) 的官方可选插件，不随内核分发。

## 安装

克隆至主目录的 `plugins/` 下并自行编译：

```powershell
cd <主目录>\plugins
git clone https://github.com/Yunzai-NG/yenai-state.git
cd yenai-state
pnpm install
pnpm run build
```

随后在面板的插件页重载，或重启内核。

`dist/` 不进 git，故**不编译就没有入口**。收录进
[插件索引](https://github.com/yunzai-ng/plugin-index) 之后亦可经面板的插件市场安装 ——
那条路会由内核代跑 `pnpm install` 与 `build`（索引里声明 `setup.scripts: ["build"]`）。

## 使用

| 命令 | 说明 |
|---|---|
| `#椰奶状态` | 输出状态大图 |
| `#椰奶状态pro` | 同上，另加默认只在 pro 里出现的板块 |
| `#椰奶监控` | 只输出四条曲线 |
| `#状态debug` | 回一条文本，列出各采集模块的耗时与内存/CPU 增量 |

`pro` 与 `debug` 是同一个 action 的两个开关，不是另外的命令；`#椰奶状态debug` 亦可。
配置里 `defaultState` 开启后，「椰奶」前缀可以省略，写成 `#状态` 即可 —— 默认关闭，
因为「状态」是个太常用的词，让位给别的插件。

### 哪些板块只出现在 pro 里

由五个配置项各自决定，取值均为 `true` / `false` / `pro`（`showFastFetch` 另有 `default`，
表示与源插件一致）：

| 配置项 | 默认 | 板块 |
|---|---|---|
| `processLoad.show` | `pro` | 进程负载表 |
| `psTestSites.show` | `pro` | 对外连通性测试 |
| `chartsCfg.show` | `true` | 四条曲线 |
| `showFastFetch` | `default` | fastfetch |

默认值为 `pro` 的那两项**只在 pro 里取数**，不只是藏起来 —— 进程表与对外连通性测试都耗时
明显，非 pro 时根本不采，状态图因此快几百毫秒。

### 监控图要有数据才画得出来

「椰奶监控」的数据来自后台的采样任务（`monitor.open`，默认开，间隔 `monitor.getDataInterval`，
默认 60 秒）。内核刚启动、还没到第一拍时命令仍会出图，只是四条曲线是空的 —— 等一分钟即可。
曲线数据默认存进 KV（`monitor.openRedisSaveData`），故重启框架不会丢掉已采到的曲线。

## 配置

首次加载后于 `<主目录>/config/yenai-state.yaml` 生成配置文件，亦可在面板的插件页直接编辑。
字段名与源插件的 `state.yaml` 保持一致，便于从旧框架迁移。

几项值得单独说明：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `defaultState` | `false` | 是否允许不带「椰奶」前缀触发 |
| `noPro` | `false` | 禁用 pro；开着时 `#椰奶状态pro` 仍按普通状态出图 |
| `systemResources` | `[CPU, RAM, SWAP, GPU]` | 要画哪几枚环，顺序即图上从左到右 |
| `monitor.open` | `true` | 采样任务总开关 |
| `monitor.getDataInterval` | `60s` | 采样间隔，内核另有 1 秒的下限 |
| `style.backdrop` | `https://t.alcy.cc/mp` | 背景图；取不到时用 `style.backdropDefault` |
| `style.startColumn` | `true` | 板块过多时自动分列，避免出图过长 |

`systemResources` 里勾了 `SWAP` 或 `GPU` 而机器上取不到数据时，那一枚环会自行隐去，
不会留下一个空环。同理，未装 fastfetch、磁盘速率取不到时，对应板块整块不出现。

## 已知行为

**取不到的数据不会被当成 0。** 采集层对「这一版没有这个键」与「它的值确实是 0」做了区分：
前者不出现，后者才显示 0。这条约定的理由很实际 —— 一个恒为 0 的 CPU 环会被读成「机器闲着」，
而真相是没采到。源插件在 SWAP 上正是这么坏过（显示 `NaN`）。

**渲染器不可用时回纯文本，不是沉默。** 未安装 `renderer-puppeteer` 时命令会回一条文本，
把账号、系统、CPU、内存、磁盘等关键数字说出来。状态图看不见时，「CPU 12%、内存 4.2G/16G」
仍然是使用者想要的信息。

**Redis 板块不做。** 源插件的 `#椰奶状态` 里有一块 Redis 连接数与内存占用，本插件不画 ——
新内核的 Redis 句柄对插件只暴露 KV 读写，拿不到 `INFO` 全文；而源插件那一块在未连 Redis 的
机器上恒为空。曲线数据的持久化不受影响，那走的是 KV（见 `monitor.openRedisSaveData`）。

**状态图与监控图取同一份曲线数据。** 两者都从同一个采样器读，故不会出现「监控图上的 CPU
曲线与状态图上的不一样」—— 源插件把采样拆成了两个模块级单例，那是它真实存在过的现象。

**多条命令共用一个互斥锁。** 出图要采一圈系统信息、还要等 Chromium 截图，全过程好几秒；
连点两下时后一次会被跳过（日志里记一条 debug），而不是排队渲染两张一样的图。

## 手工验证

单测覆盖的是纯函数（格式化、时长解析、三态开关、进程表排序、环形缓冲、模板翻译，
以及交给渲染器的数据里前端脚本要读的项是否给全）；采集要真机器、渲染要 Chromium，
两者不做自动化测试，按下列步骤手工过一遍：

1. 起内核，敲 `#椰奶状态` → 确认出图，且账号 / 系统 / 资源环 / 磁盘 / 网速各板块都有内容
2. 敲 `#椰奶状态pro` → 确认图比上一步更大（多了进程表、站点测试等板块）
3. 等一个采样间隔，敲 `#椰奶监控` → 确认四条曲线有数据点
4. 敲 `#状态debug` → 确认回的是文本，且各模块耗时都列了出来
5. 把 `plugins/renderer-puppeteer` 移出插件目录后再敲 `#椰奶状态` → 确认回的是纯文本兜底
   而不是「没反应」
6. 重启框架后立刻敲 `#椰奶监控` → 确认曲线是从 KV 读回来的，而不是空的
7. 在状态图上确认**网络状态板块里那张上下行折线图真的画出来了**（有曲线、有 Y 轴刻度）
8. 确认 CPU 环下方写着型号（如 `Ryzen 9 8940HX with Radeon Graphics`），不是空白

第 6 步盯的是实机上撞到过的一个缺陷：采样器只在第一拍才去读 KV，而命令若在那一拍之前就
判断「有没有数据」，会对着存满一小时的曲线说「还没有采到数据」。

第 7、8 步各盯一个**只在浏览器里才看得见**的缺陷，内核日志一个字都不记：

- 第 7 步：两个前端脚本都在文件开头解构 `Config`（`Config.chartsCfg` / `Config.style`）。
  少给一项就在那一行抛 `TypeError`，**整个脚本从此不执行** —— 页面照常出图，只是曲线一块
  空白、配色全部落回 CSS 默认值。`js/chart.js` 里的报错只存在于浏览器控制台里。
- 第 8 步：CPU 型号由一次异步探测填入，而那次探测若被 `void` 掉，紧随其后的读取必然拿到
  `undefined` —— 表现为环下方没有型号那行、`info` 里是 `unknown ?核`。

## 开发

本插件依赖 `@yunzai-ng/core` 与 `@yunzai-ng/types`，两者声明为 `peerDependencies`
（运行期由宿主内核提供，插件目录内不应再装一份）。**框架发布至 npm 之前**，需先链接本地
框架 checkout：

```powershell
git clone https://github.com/Yunzai-NG/yunzai-ng.git
cd yunzai-ng
pnpm install
pnpm run build          # 必需：本插件的 tsc 读取框架的 dist/*.d.ts

cd ..\yenai-state
pnpm install
pnpm run link:framework # 在 node_modules/@yunzai-ng 下建立指向框架的链接
pnpm run verify         # build → typecheck:test → lint → test
```

`link:framework` 按 `YZNG_FRAMEWORK` 环境变量 → `../yunzai-ng` → `../../yunzai-ng` →
`../../code` 的顺序查找框架仓库。目录布局与上述不同时设置该环境变量即可：

```powershell
$env:YZNG_FRAMEWORK = "c:\path\to\yunzai-ng"
```

框架发布之后，`pnpm install` 即可满足依赖，该步骤不再必需。

### 目录结构

```
src/
├── index.ts        插件入口：三条命令、互斥锁、渲染兜底
├── config.ts       configSchema
├── monitor.ts      采样器：环形缓冲 + KV 持久化
├── collect/        各采集模块，每个都「取不到就 undefined」
├── view/           聚合、样式、背景，以及到模板变量名的翻译
└── util/           格式化、debug
templates/          art-template 模板（state.html / monitor.html / layout/）
resources/          css / icon / img / js，随模板一起送进浏览器
```

**模板与资源分两处**：渲染器注入的 `res` 指向 `<插件根>/resources`，而 `templateRoot` 固定
为 `<插件根>/templates`，故 `.html` 放前者、图片与脚本放后者。源插件把两者混在 `resources/`
下，移植时拆开了。

**`view/template.ts` 是一层翻译。** 搬过来的模板读的是 `BotStatusList` / `visualData` /
`disks.disksSize` 这些源自源插件内部结构的名字，与采集层定的名字对不上。改模板去
迁就采集层要动三个地方（模板、CSS 类名、`resources/js/` 里的选择器），加一层翻译只动一处。

## 许可

AGPL-3.0-or-later
