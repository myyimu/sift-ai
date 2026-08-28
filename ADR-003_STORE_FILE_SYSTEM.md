# ADR-003：P0 阶段 Store 用纯文件系统实现（E-04 引擎后置）

- **状态：已批准（2026-08-27，用户批准）**
- **批准范围**：
  1. P0 最小捕获闭环的 Store 用纯文件系统实现（内容寻址 blob 目录 + JSONL
     观察 journal + page-state JSON），不引入 better-sqlite3；
  2. `SiftStore` 接口与 E-04 冻结的**行为语义**（幂等、staging→hash 校验→
     原子 rename、TTL/配额复核、store_corrupt 失败关闭）不变，逐条落地；
  3. 允许在 ADR-001 E-04 与 P0_DEMO_SCOPE §2.3 添加批注（已添加）。
- **批准限制（持续生效）**：
  1. host 进程是 store 的**唯一写者**（UI/工具只读 dump），无跨进程写锁协议；
  2. 只在 Host 启动且尚未取得 journal 写句柄时自动回收超过 7 天的捕获；UI 启动时回收超过 7 天的派生答案；
  3. 引擎替换为 SQLite 属后续独立决策，需新 ADR。
- **日期：2026-08-27**
- **关联：ADR-001_DEMO_ENGINEERING.md（E-04，已批注）、P0_DEMO_SCOPE.md §2.3（已批注）**

## 1. 背景与动机

ADR-001 E-04 选定 better-sqlite3 + WAL + `BEGIN IMMEDIATE`。实现前发现一个
工程约束：**host 进程运行在 `ELECTRON_RUN_AS_NODE=1`（Electron ABI），而
vitest 运行在纯 Node（Node ABI）**，同一个原生模块（`.node` 二进制）无法同时
满足两个运行时——安装期 prebuild 只能择一，另一个上下文加载即报
NODE_MODULE_VERSION 不匹配。要让两边都工作需要：按 electron 目标重新拉取
prebuild、把 node_modules 暂存进 extraResources、并在仓库里维护双份二进制。

P0 的目标是"最小捕获闭环"（授权 → 脱敏快照 → Native Host → 本地保存），
安全与协议正确性才是本阶段的主体工作量。存储引擎的引入会把显著的打包工程
风险提前到闭环验证之前，且 SQLite 的查询能力（投影、配额 SQL）在投影器落地
前并无消费者。

## 2. 决定

P0 阶段 `@sift/store` 用纯文件系统实现（`fs-store.ts`），零三方依赖：

```
<root>/
├── blobs/<hash[0:2]>/<hash>          # 内容寻址 blob（不可变，同 hash 复用）
├── observations.jsonl                 # 追加式观察 journal（幂等索引来源）
├── page-states/<pageInstanceId>.json  # Page State（tmp + rename 原子替换）
├── staging/<uuid>                     # 同卷暂存（commit 前的落点）
└── meta.json                          # 配额记账（session/global 字节）
```

root 默认 `%LOCALAPPDATA%\Sift\store`（Windows），`SIFT_STORE_ROOT`
环境变量可覆盖（测试/演示用）。

## 3. E-04 行为语义 → 文件系统映射

| E-04 冻结语义（SQLite 原文） | FS 落地 |
|---|---|
| WAL + busy_timeout + BEGIN IMMEDIATE（多写者串行化） | 本阶段 host 唯一写者（批准限制 #1）；journal append 前整行构造完毕 + fsync，把 torn-write 窗口压到进程崩溃瞬间 |
| 事务提交索引与 blob 引用 | 写入顺序：staging 写 → 长度 + hash 校验 → fsync → 幂等/TTL/配额复核 → rename 或复用 → journal append（fsync）→ page-state 替换 → meta 更新 |
| blob 同卷暂存 + 原子 rename | `staging/` 与 `blobs/` 同在 root 下，rename 同卷原子 |
| 幂等检查（commit ack 的 deduplicated） | 打开时扫 journal 建 `id → payloadHash` 索引；同 id 同 hash → deduplicated；同 id 异 hash → hash_mismatch 失败关闭 |
| refCount / reconciliation | 打开时扫 journal 重建每 blob 引用计数；孤儿 blob（rename 后崩溃）容忍并记账，不自动删除（保守） |
| store_corrupt 失败关闭 | journal 断尾（末行不完整）→ 截断恢复；中段坏行 / 引用 blob 缺失或 hash 不符 → 拒绝打开 |
| TTL 7 天 / Session 250 MiB / 全局 1 GiB 配额复核 | Host 启动时先回收过期行与不可达 blob；append 前复核配额，超限 → QuotaExceeded（错误码 quota_exceeded，host 失败关闭，SW 暂停捕获） |
| 表结构（observations/page_states/sessions/blobs/blob_refs/projections） | journal 行 = observations；page-states/*.json = page_states；blobs 目录 = blobs；引用计数在内存 + 打开时重建；sessions/projections 表暂无消费者，后置 |

## 4. 一致性模型与恢复

- **journal 是事实来源**。page-state 落后于 journal（page-state 替换前崩溃）时，
  打开时确定性重放 journal 中的 dom_snapshot 补齐（replace 语义、stateVersion、
  lastAppliedSequence 重算），不依赖 page-state 文件自身。
- **崩溃窗口分析**：
  - staging 写后崩溃 → 留下孤儿 staging 文件，打开时清空 staging 目录；
  - blob rename 后、journal append 前崩溃 → 孤儿 blob（无引用），容忍并记账；
  - journal append 后、page-state 替换前崩溃 → 重放恢复；
  - journal append 半行崩溃 → 断尾截断。
- 任何一步都无法产生"journal 有行但 blob 缺失/hash 不符"的状态——该状态只可能
  来自外部篡改或磁盘故障，判定 store_corrupt 拒绝启动。

## 5. 退出条件（何时换 SQLite）

出现任一条件时提出新 ADR 替换引擎：

1. 出现第二个写者（UI 写入投影/会话状态）需要跨进程事务；
2. journal 规模使打开期全量扫描成为瓶颈（行数 > 数万或打开 > 500ms）；
3. 需要投影/配额的 SQL 查询（P0.5 投影器落地时）。

届时数据迁移以 blob 目录 + journal 为源重放进 SQLite。

## 6. 已接受的限制

- 打开成本随 journal 线性增长（P0 演示量级可忽略）；
- 无跨进程写锁（UI 只读；dump 工具只读）；

> **批注（2026-08-28，验收门 14 最小实现）**：`packages/store/src/maintenance.ts`
> 增加 UI 侧**维护性删除例外**——`deleteSessionData(root, sessionId)`（journal 按
> session 分区重写 tmp+rename、按幸存 pid 回收 page-states、按幸存 hash 引用 GC
> blob）与 `deleteAllData(root)`（清空 store 内容 + 可选 answers 姊妹目录；根目录
> 保留）。host 仍是唯一捕获写者；删除不与捕获并发。**store_busy 语义（Windows
> 细节）**：Node 打开文件带 `FILE_SHARE_DELETE`，对被占用文件 unlink/rm 会"成功"
> 留下孤儿句柄（POSIX 语义）——故 busy 探测用 journal 上的 tmp+rename 覆盖探测
> （rename 覆盖被占用文件会被系统诚实拒绝 EPERM/EBUSY），失败返回
> `SiftStoreError('storage_error','store_busy: …')` 而非伪造成功（验收门 13 风格）。
> 单测覆盖：精确删除断言、幂等、writer 句柄占用 → store_busy 且 journal 字节不变。
- 引用计数不实时持久化（打开时重建，关闭即弃）。
