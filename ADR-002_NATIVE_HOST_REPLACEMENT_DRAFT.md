# ADR-002：Native Host 进程模型替代方案（E-03 spike 未通过的后续决定）

- **状态：已批准（2026-08-26，用户批准）**
- **批准范围**：
  1. host 形态：`SiftHost.cmd → ELECTRON_RUN_AS_NODE=1 → Sift.exe resources\host-main.js`；
  2. `packages/host` 契约保持不变；
  3. `SiftHost.cmd` 纳入正式打包（extraFiles）并执行真实 Chrome E2E；
  4. 允许在 ADR-001 中添加"由 ADR-002 取代"批注（已添加，3 处）。
- **批准限制（持续生效）**：
  1. **暂不授权写入注册表**——执行任何注册表脚本前必须再次征得用户确认；
  2. **真实 Chrome E2E 通过前，不宣称 Native Messaging 全链路完成**；
  3. `SiftHost.cmd` 保持纯 ASCII、路径全引号；host 侧保持失败关闭；不突破
     P0 权限边界（manifest 仅 activeTab/scripting/nativeMessaging/storage）。
- **日期：2026-08-26**
- **关联：ADR-001_DEMO_ENGINEERING.md（E-03，已批注取代）、P0_DEMO_SCOPE.md（§2.1 单机 Demo）**

## 1. 背景与结论

ADR-001 E-03 选定"主 exe 双模式"（同一 Sift.exe 既做 UI 又做 native messaging
host），并设置限时 spike 验证门：打包产物在 UI 开/关两种状态下各 100 次
connect/disconnect + framed ping/pong 全部通过。

**Spike 实测结论：双模式单 exe 在 Windows/Electron 33 上不可行。** 根因是打包 exe
的 GUI（Chromium）引导在用户代码执行之前无条件向 stdout 写入 2 字节垃圾
（`0d 0a`），Chrome native messaging 的帧解析器会将其读作长度前缀而失效。
本文档提议的替代架构已用**同一完成门**验证通过（200/200 往返全过）。

## 2. 证据（全部可复现，工具保留于 tools/spike/）

| # | 实验 | 结果 |
|---|------|------|
| E-1 | 打包 exe（GUI 模式，任意参数/环境变量）spawn 后捕获 stdout | 恒定出现 2 字节 `0d 0a`（crlf-probe.mjs / crlf-suppress-probe.mjs） |
| E-2 | CRLF 到达时刻测量 | t≈28-45ms；对照 main.js 首个 stderr 输出 t≈600ms —— **早于任何用户代码** |
| E-3 | 抑制尝试：`--enable-logging=stderr`、`--no-sandbox`、`ELECTRON_NO_ATTACH_CONSOLE`、`ELECTRON_ENABLE_LOGGING=false` | 全部无效（4/4 仍写 CRLF） |
| E-4 | 打包主进程 Node 层 stdio：`process.stdout.write(帧)` | 行缓冲文本流：帧被扣（无换行不flush），仅 `\n→\r\n` 翻译泄露 |
| E-5 | `process.stdin`（data 监听） | data 事件从不触发；close 立即触发——**收不到 Chrome 的帧** |
| E-6 | `fs.createReadStream/WriteStream({fd:0/1})` | 同样不通（无 data、无 error，静默） |
| E-7 | 同一 exe 以 `ELECTRON_RUN_AS_NODE=1` + 纯 Node 入口（resources/host-main.js） | **stdout 完全干净**：`22 00 00 00` + JSON 帧零污染；stdin 帧正常接收；退出码语义正常 |
| E-8 | 真实部署链路 `cmd.exe /c SiftHost.cmd <origin> --parent-window=1` | 干净帧 + 自退出 0（manual-roundtrip.mjs） |
| E-9 | 替代架构完成门：UI 未运行 100 轮 + UI 运行中 100 轮 + 单实例锁断言 | **PASS**：A 相 100/100（p50=84ms p95=90ms max=102ms）；锁断言通过（第二 UI 实例 456ms 退码 0）；B 相 100/100（p50=86ms p95=95ms max=103ms） |

结论推导：E-2/E-3 ⇒ CRLF 无法在 JS 层抑制；E-4/E-5/E-6 ⇒ 主进程 Node stdio 与
fd 重定向均不可用 ⇒ **双模式单 exe 无工程出路**。E-7/E-8/E-9 ⇒ 替代架构成立。

## 3. 决定（提议）

**host 与 UI 分离为两种启动形态、一份发布物：**

```
Chrome native messaging
  └─ manifest: path = <安装目录>\SiftHost.cmd        ← 唯一注册入口
       └─ cmd 设置 ELECTRON_RUN_AS_NODE=1（不改 stdio 字节流，已实测零污染）
            └─ Sift.exe resources\host-main.js        ← 纯 Node 进程
                 └─ runNativeHostLoop（@sift/host，契约不变）
UI（用户双击/桌面）
  └─ Sift.exe（GUI 模式）→ dist/main.ts UI 分支（单实例锁、面板）
```

要点：

1. **`packages/host` 契约不变**（E-03 的硬约束）：framing/mode/host-loop/protocol
   全部原样复用；替代只发生在"exe 如何进入 host 形态"这一层。
2. **host-main.js 自带三条件联合校验**（allowed origin 严格相等 +
   `--parent-window=<非负十进制>` + stdio 均管道）——独立 host 必须自证启动合法，
   失败即退出（失败关闭）。校验逻辑复用 `@sift/host/mode`，不新增实现。
3. **main.ts 对 host 形态参数失败关闭**（stderr + exit 1）：GUI 引导必然污染
   stdout，此路径永远不该被使用；manifest 误指 Sift.exe 时快速显性失败。
4. **SiftHost.cmd 必须纯 ASCII**：cmd.exe 按 OEM 代码页解析脚本，非 ASCII 字节
   会破坏行结构（实测：中文注释导致 `set` 未执行、参数错乱）。
5. host 进程从不申请单实例锁；UI 单实例锁语义不变（已实测互不干扰，E-9）。

## 4. 备选方案与弃用理由

| 方案 | 弃用理由 |
|------|----------|
| 双模式单 exe（ADR-001 原案） | E-1~E-6，stdout 引导期污染不可抑制 |
| 主进程内 `fs.writeSync(1)` 直写 | stdin 侧无解（E-5/E-6：收帧不可能），且 CRLF 已在引导期入管道 |
| 打包第二枚轻量 host exe（pkg/bun/deno compile/自研） | 引入新工具链与供应链面，违背 Demo 工程最小依赖原则；且同一 Electron 二进制已具备纯 Node 能力（E-7），无需第二份二进制 |
| manifest 直接指向 node.exe | Demo 机器不保证装 Node；多一份运行时依赖 |
| manifest 指向 Sift.exe + 期待 Chrome 侧容错 | Chrome 帧解析严格，2 字节垃圾即断连；不可依赖 |

### 与 ADR-001"被否决的备选"的关系澄清

ADR-001 §2 曾否决"`.bat` wrapper 启动 node 脚本"，否决点有二：依赖机器上的
node、以及 Chrome 对 bat 的引号/编码行为不可靠。本方案不冲突：

1. `SiftHost.cmd` 启动的是**打包产物 Sift.exe**（自带完整运行时，机器无需装
   Node），与"启动 node 脚本"有本质区别；
2. 引号/编码行为已在本机实测定证（E-8：`"%~dp0..."` 全引号 + 纯 ASCII 下
   字节流零污染），消解了原否决依据的不确定性；纯 ASCII 作为硬约束写入 §3；
3. E-03 的失败出口要求"独立轻量 host **可执行文件**"的本意是避免**第二条构建
   链**；本方案零新增构建链（同一 electron-builder 产物 + 一个静态 .cmd 文件），
   精神实质一致。

## 5. 实施影响

已随 spike 落地（不改变任何冻结契约）：

- `apps/desktop/src/host-main.ts`：纯 Node host 入口（三条件自校验）；
- `apps/desktop/src/main.ts`：host 形态参数失败关闭 + 注释记录全部实测证据；
- `apps/desktop/build.mjs`：双入口打包（dist/main.js + dist/host-main.js）；
- `apps/desktop/electron-builder.yml`：host-main.js 经 extraResources 发布在
  asar 外；**SiftHost.cmd 经 extraFiles 发布在安装根目录（2026-08-26 已落地，
  源文件 `apps/desktop/build/SiftHost.cmd`，纯 ASCII + CRLF + 全引号，产物
  字节一致性已验证）**；
- `tools/spike/run-e03-spike.mjs`：驱动注入等价环境（cmd 链路单独验证），
  完成门定义不变；正式打包产物复验 200/200 全过
  （A 相 100/100 p50=84ms；B 相 100/100 p50=102ms）。

批准后待办（2026-08-26 更新）：

- [x] SiftHost.cmd 纳入 electron-builder extraFiles；
- [x] ADR-001 E-03 章节批注（3 处：决策总表、§2 标题下、spike 段落后）；
- [x] 注册表注册/查询/回滚脚本已就绪（`tools/scripts/register-sift-native-host.mjs`，
      仅 HKCU、Chrome 键、可 `status`/`remove`）——**2026-08-27 用户确认后执行
      register 并复核通过**（manifest 指向 pack2 `SiftHost.cmd`，origins 锁定
      固定 Extension ID；回滚随时可用 `remove`）。上述是历史验证记录；若开发机
      注册表或打包目录被重置，必须重新执行 `register`，并以 `node
      tools/scripts/demo-preflight.mjs` 的当前结果为准，不能仅凭本记录宣称已注册；
- [x] 真实 Chrome E2E（`tools/spike/run-chrome-e2e.mjs`，临时测试扩展与产品扩展
      同 key → 同 ID；单向报告协议；UI 开/关两态）——**2026-08-27 PASS（exit 0）**：
      管道自检先行通过（CfT 151 + `--no-sandbox`，全链触达且如期回报
      "host not found"）；正式运行 CfT 真实 Chrome，阶段 A（UI 未运行）100/100、
      阶段 B（UI 运行中）100/100，往返延迟 p50=116ms p95=130ms max=305ms。
      **至此 Native Messaging 全链路（Chrome 注册表发现 → SiftHost.cmd →
      RUN_AS_NODE → host-main.js 帧往返）在真实浏览器下验证完成。**

## 6. 风险与缓解

- **cmd.exe 依赖**：Chrome CreateProcess 原生支持 `.cmd`（经 `%COMSPEC%`），
  Demo 单机已验证；cmd 不向管道写任何字节（E-8）。风险：AutoRun 注册表项理论上
  可注入输出——Demo 机器可控，正式产品化时再评估。
- **路径含空格/中文**：`"%~dp0..."` 已加引号；安装目录含空格可正常执行
  （pack2 路径实测）。
- **杀软对 node→cmd.exe 链的启发式**：开发机实测一次拦截（同目录残留 0 字节假
  `cmd.exe` 导致 CreateProcess 解析失败，非 AV 行为，已定位并清除）；Chrome→cmd
  链路为浏览器常规行为，不在高危模式内。
