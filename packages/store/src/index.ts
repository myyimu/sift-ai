// @sift/store —— SQLite + blob 目录的本地 Store —— 骨架（ADR-001 §9 步骤 3 / E-04）。
//
// E-04 已冻结的语义（实现时逐条落地，本包不引入任何静默放宽）：
//  - better-sqlite3 + WAL + busy_timeout=5000 + BEGIN IMMEDIATE；
//  - 表：observations / page_states / sessions / blobs(hash PK, refCount) /
//       blob_refs(ownerType, ownerId, hash, UNIQUE) / projections (kind, inputHash) 复合 PK；
//  - refCount 是 blob_refs 的事务内缓存；reconciliation 只在 UI 模式启动时执行；
//  - blob 写入顺序：staging 同卷 -> 校验长度 + hash + flush ->
//       BEGIN IMMEDIATE -> 幂等检查 + TTL/配额复核 -> rename/复用 -> 插入 -> commit；
//  - TTL 7 天 / Session 250 MiB / 全局 1 GiB；配额达到时暂停新捕获并要求用户删除，
//    不自动删除未过期 Session（P0_DEMO_SCOPE §2.3）；
//  - store_corrupt 失败关闭；打包时 better-sqlite3 走 asarUnpack。
//
// 步骤 3 引入 better-sqlite3 依赖（Windows 原生模块，骨架期不安装）。
import type { ObservationEnvelope } from '@sift/shared'

/** 幂等写入结果：commit ack 的数据部分（ADR-001 E-04）。 */
export interface CommitResult {
  /** 写入是否首次发生（false = 幂等复用已存在的相同内容）。 */
  deduplicated: boolean
  payloadHash: string
}

/** 步骤 3 的 Store 门面接口草案；实现前不可用，任何调用方不得假设其已存在。 */
export interface SiftStore {
  appendObservation(envelope: ObservationEnvelope, payload: Uint8Array): Promise<CommitResult>
}
