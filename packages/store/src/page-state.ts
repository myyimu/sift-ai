// Page State —— CAPTURE_ARCHITECTURE §6 的物化页面状态（纯 reducer，可确定性重放）。
//
// 语义（§6 Reducer 约束的 P0 落地）：
//  - 同一 observation 重放两次结果不变：sequence ≤ lastAppliedSequence 直接返回原状态；
//  - journal 是事实来源：从空状态按 journal 顺序重放即可重建任意 page-state 文件
//    （page-state 落后于 journal 的崩溃窗口靠这个性质恢复）；
//  - documentDirty / pendingTriggerCount 属于 CS 侧运行时状态，落盘恒为 false / 0 占位；
//  - sequenceGaps 记录 Host 接受的 gap（诊断）；上限 64 段，溢出置 truncated 标记，
//    不静默丢弃。
// 序列化确定性：字段按本文件字面量键序构造（JSON.stringify 保插入序），同输入同字节。
import type { ObservationEnvelope, ObservationType } from '@sift/shared'

/** Host 接受的 sequence gap 区间（闭区间，诊断用）。 */
export interface PageStateGap {
  readonly start: number
  readonly end: number
}

/** sequenceGaps 最多记录的段数（溢出置 sequenceGapsTruncated）。 */
export const PAGE_STATE_MAX_GAPS = 64

/**
 * §6 字段全集的 P0 落盘形状。
 * snapshotBlobRef 在 FS store 中就是 payloadHash（内容寻址即引用）。
 */
export interface PageStateDoc {
  readonly schemaVersion: 1
  readonly pageInstanceId: string
  /** 每应用一条 observation 自增；幂等重放不增。 */
  readonly stateVersion: number
  readonly lastAppliedSequence: number
  readonly canonicalUrl: string
  readonly title: string
  readonly sanitizedSnapshotBlobRef: string
  readonly payloadHash: string
  readonly sourceObservationId: string
  readonly documentDirty: false
  readonly pendingTriggerCount: 0
  readonly lastEventId: string
  readonly lastEventType: ObservationType
  readonly lastEventReceivedAt: string
  readonly sequenceGaps: readonly PageStateGap[]
  readonly sequenceGapsTruncated: boolean
  readonly observationCount: number
}

/** dom_snapshot 落盘时从 payload 提取的替换信息（fs-store 解析后传入）。 */
export interface SnapshotReplaceInfo {
  readonly url: string
  readonly title: string
  readonly payloadHash: string
}

/** 应用一条 observation：dom_snapshot 替换快照字段，其余事件只前进水位。 */
export function reducePageState(
  prev: PageStateDoc | null,
  envelope: ObservationEnvelope,
  snapshot: SnapshotReplaceInfo | null,
): PageStateDoc {
  if (prev !== null && envelope.sequence <= prev.lastAppliedSequence) {
    return prev // 幂等：已应用过（或更早）的观察不改变状态
  }

  let gaps = prev?.sequenceGaps ?? []
  let gapsTruncated = prev?.sequenceGapsTruncated ?? false
  if (prev !== null && envelope.sequence > prev.lastAppliedSequence + 1) {
    const gap: PageStateGap = { start: prev.lastAppliedSequence + 1, end: envelope.sequence - 1 }
    if (gaps.length >= PAGE_STATE_MAX_GAPS) {
      gapsTruncated = true
    } else {
      gaps = [...gaps, gap]
    }
  }

  return {
    schemaVersion: 1,
    pageInstanceId: envelope.pageInstanceId,
    stateVersion: (prev?.stateVersion ?? 0) + 1,
    lastAppliedSequence: envelope.sequence,
    canonicalUrl: snapshot?.url ?? prev?.canonicalUrl ?? envelope.url,
    title: snapshot?.title ?? prev?.title ?? '',
    sanitizedSnapshotBlobRef: snapshot?.payloadHash ?? prev?.sanitizedSnapshotBlobRef ?? '',
    payloadHash: snapshot?.payloadHash ?? prev?.payloadHash ?? '',
    sourceObservationId: snapshot !== null ? envelope.id : prev?.sourceObservationId ?? '',
    documentDirty: false,
    pendingTriggerCount: 0,
    lastEventId: envelope.id,
    lastEventType: envelope.type,
    lastEventReceivedAt: envelope.receivedAt,
    sequenceGaps: gaps,
    sequenceGapsTruncated: gapsTruncated,
    observationCount: (prev?.observationCount ?? 0) + 1,
  }
}

/** 确定性序列化（固定键序 = 字面量序；page-state 文件字节只由内容决定）。 */
export function serializePageState(doc: PageStateDoc): string {
  return `${JSON.stringify(doc)}\n`
}

/** 解析 page-state 文件（打开期对账用；坏文件由调用方决定恢复策略）。 */
export function parsePageState(text: string): PageStateDoc {
  return JSON.parse(text) as PageStateDoc
}
