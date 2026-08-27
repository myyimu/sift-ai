# tools/spike —— E-03 Native Host 进程模型验证

`run-e03-spike.mjs` 是 ADR-001 E-03 的限时 spike 验证门（实测结论与替代架构见
**ADR-002**）。模拟 Chrome 的 native messaging 行为（stdio 管道上的长度前缀帧
ping/pong），对**打包后**的产物执行：

- 阶段 A：UI 未运行，≥100 次 connect/disconnect + framed round-trip；
- 阶段 B：UI 实例运行中重复阶段 A，并断言第二个 UI 实例因单实例锁快速退出且
  不影响 host 模式。

## host 形态（E-03 实测后修正）

打包 Sift.exe 的 GUI 引导会向 stdout 无条件写 2 字节垃圾（0d 0a），双模式单 exe
不可行（证据见 ADR-002）。替代架构：

```
Chrome -> SiftHost.cmd（设 ELECTRON_RUN_AS_NODE=1）
      -> Sift.exe resources/host-main.js（纯 Node，stdio 干净）
```

驱动直接注入等价环境（`spawnHost`），`.cmd` 仅设置这一个变量、不改 stdio 字节流；
真实 `.cmd` 链路用 `manual-roundtrip.mjs` 单独验证（当前即指向 SiftHost.cmd）。

帧编解码在脚本内独立实现，故意不复用 `@sift/host`（交叉验证线上格式）。

## 运行

```bash
pnpm --filter @sift/desktop build        # esbuild -> dist/main.js + dist/host-main.js
pnpm --filter @sift/desktop package:dir  # electron-builder --dir -> pack/win-unpacked/Sift.exe
                                          # （res 被锁时：npx electron-builder --dir
                                          #   --config.directories.output=pack2）
# 手动放置 SiftHost.cmd（ADR-002 草案期间；正式化后由 extraFiles 打包）：
#   @echo off
#   set "ELECTRON_RUN_AS_NODE=1"
#   "%~dp0Sift.exe" "%~dp0resources\host-main.js" %*
# （必须纯 ASCII——cmd.exe 按 OEM 代码页解析，非 ASCII 字节会破坏行结构）

node tools/spike/run-e03-spike.mjs       # 默认 100 轮/阶段（pack2 产物）
node tools/spike/run-e03-spike.mjs --rounds 10    # 快速冒烟
node tools/spike/manual-roundtrip.mjs    # 单次真实 .cmd 链路诊断
```

判定：两阶段全部轮次 ok 且单实例锁断言通过 -> PASS；任一失败 -> FAIL。

## 真实 Chrome E2E（ADR-002；2026-08-27 已 PASS）

`run-chrome-e2e.mjs`：临时测试扩展（与产品扩展同 manifest key -> 同 Extension ID，
不触碰产品代码/权限）-> `chrome.runtime.connectNative` -> SiftHost.cmd -> host-main.js，
UI 开/关两态各 N 轮。协议为**单向**：扩展只 POST 结果到 127.0.0.1 报告端点 +
轮询只读的 `/phase-b` 标志（无指令通道）。

```bash
node tools/spike/run-chrome-e2e.mjs --cft --plumbing   # 管道自检（无需注册表，预期 connect 失败并回报）
node tools/spike/run-chrome-e2e.mjs --cft               # 正式（前置：register-sift-native-host.mjs register）
```

正式结果（2026-08-27，CfT 151，100 轮/阶段）：**PASS**——阶段 A（UI 未运行）
100/100，阶段 B（UI 运行中）100/100，往返延迟 p50=116ms p95=130ms max=305ms。

- `--cft`：自动下载 Chrome for Testing（官方真实 Chrome 构建，支持 `--load-extension`；
  npmmirror 镜像，缓存于 `tools/.cache/cft`）。本机品牌 Chrome 151 已实测忽略
  `--load-extension`；不用 `--cft` 时 harness 会给出一次性手动 Load unpacked 指引。
  CfT 启动强制附加 `--no-sandbox`：CfT 二进制未签名，本机安全软件注入会使 Win32
  沙箱初始化失败——进程 ~400ms 内静默退出 code=3（无 stderr、profile 连 Default/
  都不建）。一次性测试 profile 属标准做法；native host 由浏览器主进程 spawn（本就
  不在沙箱内），不影响被测链路。
- `--plumbing`：验证 Chrome 启动/扩展加载/SW/报告通道/native 调用全链触达
  （注册表未注册 -> 每轮失败并回报错误即通过条件）。
  **2026-08-27 已通过**（exit 0，两阶段均回报
  `Specified native messaging host not found.`——即预期的注册表缺失）。
- 注册表：`tools/scripts/register-sift-native-host.mjs status|register|remove`
  （仅 HKCU + Chrome 键；**register 执行前需用户确认**）。

## 已知环境坑（Windows）

诊断工具（保留用于复现 ADR-002 证据）：
- `crlf-probe.mjs`：GUI 模式 vs RUN_AS_NODE 模式的 stdout 字节流对比；
- `crlf-suppress-probe.mjs`：CRLF 到达时机（t≈30ms，早于 main.js）与抑制变体
  （env/参数均无效）。

## 已知环境坑（Windows）

- Electron 系 IDE 集成终端带 `ELECTRON_RUN_AS_NODE=1`，子进程继承会改变 Sift.exe
  行为——驱动一律剔除（UI 轮）或显式注入（host 轮）；
- IDE 文件监视器/预览可能锁住 `app.asar` 导致重打包失败——换输出目录绕过
  （`.vscode/settings.json` 已排除监视）；
- **当前目录存在假 `cmd.exe`（如 0 字节残留文件）会让 Node spawn cmd.exe 全部
  UNKNOWN 失败**（CreateProcess 先搜当前目录）——排障时优先检查；
- **service worker 禁止 top-level await**：Chrome 直接 SyntaxError 杀死 SW 且
  外部零报错——SW 内的异步调度必须包进 `void (async () => {...})()`；
- **Chrome 静默早退**：harness 只等扩展联系不监控进程退出时，会为死浏览器白等
  5 分钟（run-chrome-e2e.mjs 现已挂 `exit` 监测快速失败）。
