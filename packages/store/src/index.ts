// @sift/store —— 本地 Capture Store（ADR-003：P0 用纯文件系统实现，引擎后置）。
//
// E-04 冻结语义的 FS 映射（ADR-003 §3，逐条落地，无静默放宽）：
//  - 幂等：打开时扫 journal 建 id→payloadHash 索引；同 id 同 hash → deduplicated；
//  - staging → 长度+hash 读回校验 → fsync → 原子 rename（同卷）→ journal append(fsync)
//    → page-state tmp+rename 替换 → meta 刷新；
//  - store_corrupt 失败关闭：journal 中段坏行 / 引用 blob 缺失或 hash 不符 /
//    page-state 领先于 journal → 拒绝打开；断尾（末行不完整）→ 截断恢复；
//  - TTL 7 天不自动清理（ADR-003 批准限制 #2）；Session 250MiB / 全局 1GiB
//    配额在 append 前复核，超限抛 quota_exceeded；
//  - host 进程是唯一写者；journal 是事实来源，page-state 落后时按 journal 重放补齐。
//    读侧（UI/投影）经 openSiftStore({ readOnly: true }) 零写入共存：断尾内存容忍、
//    blob 惰性重验、page-state 按 journal 重放（不补写文件）。
// better-sqlite3 引入属后续独立决策（ADR-003 §5 退出条件）。
export {
  SiftFsStore,
  SiftStoreError,
  defaultStoreRoot,
  openSiftStore,
  type JournalFilter,
  type OpenSiftStoreOptions,
  type ObservationRef,
  type PageWatermark,
  type SiftStore,
  type SiftStoreErrorCode,
  type StoreCommitResult,
  type StorePageSummary,
  type StoreSessionSummary,
} from './fs-store'
export {
  PAGE_STATE_MAX_GAPS,
  parsePageState,
  reducePageState,
  serializePageState,
  type PageStateDoc,
  type PageStateGap,
  type SnapshotReplaceInfo,
} from './page-state'
export { deleteAllData, deleteSessionData, type SessionDeleteReport } from './maintenance'
