// FS-first 本地 Capture Store（ADR-003；E-04 行为语义逐条落地，零三方依赖）。
//
// 布局（root = SIFT_STORE_ROOT ?? %LOCALAPPDATA%\Sift\store）：
//   blobs/<h2>/<hex>        内容寻址 blob（不可变；key 为 'sha256:<hex>'，落盘用 hex）
//   observations.jsonl      观察 journal（事实来源；行 = envelope JSON + '\n'，UTF-8 无 BOM）
//   page-states/<pid>.json  Page State（tmp+rename 原子替换；落后于 journal 时重放补齐）
//   staging/<uuid>          同卷暂存（打开时清空 = 崩溃孤儿回收）
//   meta.json               配额记账缓存（权威值每次打开时重算）
//
// 写入序（ADR-003 §3）：幂等检查 → 配额复核 → staging 写+fsync+长度校验 → rename →
//   journal append(fsync) → page-state 替换 → meta 刷新。
// 崩溃窗口（§4）：staging 孤儿打开时清；rename 后 journal 前孤儿 blob 容忍记账；
//   journal 后 page-state 前靠重放恢复；journal 断尾截断；中段坏行/blob 缺失或
//   hash 不符 → store_corrupt 拒绝打开。
// host 是唯一写者（批准限制 #1）；不自动 TTL 清理（#2），TTL 常量仅记录。
import { createHash, randomUUID } from 'node:crypto'
import { FileHandle, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ObservationEnvelope } from '@sift/shared'
import { GLOBAL_QUOTA_BYTES, SESSION_QUOTA_BYTES, TTL_DAYS } from '@sift/shared/limits'
import { PAGE_INSTANCE_ID_PATTERN, SHA256_HASH_PATTERN } from '@sift/shared/wire'
import {
  parsePageState,
  reducePageState,
  serializePageState,
  type PageStateDoc,
  type SnapshotReplaceInfo,
} from './page-state'

// —— 错误分类（capture-protocol 按 siftStoreError 字段结构化识别） ——

export type SiftStoreErrorCode = 'quota_exceeded' | 'store_corrupt' | 'storage_error'

export class SiftStoreError extends Error {
  readonly siftStoreError: SiftStoreErrorCode
  constructor(code: SiftStoreErrorCode, message: string) {
    super(message)
    this.name = 'SiftStoreError'
    this.siftStoreError = code
  }
}

const corrupt = (message: string): SiftStoreError => new SiftStoreError('store_corrupt', message)

// —— 查询/提交结果形状（与 @sift/host 的 CaptureStore 结构接口一致） ——

export interface ObservationRef {
  readonly payloadHash: string
}

export interface PageWatermark {
  readonly stateVersion: number
  readonly lastAppliedSequence: number
}

export interface StoreCommitResult {
  readonly deduplicated: boolean
  readonly payloadHash: string
  readonly stateVersion: number
  readonly lastAppliedSequence: number
}

/** 门面接口：fs 实现的完整形状（host-main 直接注入 capture-protocol）。 */
export interface SiftStore {
  appendObservation(envelope: ObservationEnvelope, payload: Uint8Array): Promise<StoreCommitResult>
  findObservationById(id: string): Promise<ObservationRef | null>
  findObservationBySequence(pageInstanceId: string, sequence: number): Promise<ObservationRef | null>
  getSequenceHighWater(pageInstanceId: string): Promise<number | null>
  getPageWatermark(pageInstanceId: string): Promise<PageWatermark | null>
  close(): Promise<void>
}

export interface OpenSiftStoreOptions {
  readonly rootDir: string
  /** 打开期恢复动作（断尾截断、page-state 重放补齐等）的诊断回调（宿主接 stderr）。 */
  readonly onRecover?: (message: string) => void
}

/** 默认 root：SIFT_STORE_ROOT 覆盖，否则 %LOCALAPPDATA%\Sift\store（退回 ~/.sift/store）。 */
export function defaultStoreRoot(): string {
  const override = process.env.SIFT_STORE_ROOT
  if (override !== undefined && override !== '') return override
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData !== undefined && localAppData !== '') return join(localAppData, 'Sift', 'store')
  return join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.sift', 'store')
}

// —— 内部记账 ——

interface OpenedIndex {
  readonly rows: readonly ObservationEnvelope[]
  readonly byId: Map<string, string>
  readonly bySeq: Map<string, string>
  readonly highWater: Map<string, number>
  readonly blobRefs: Map<string, number>
  readonly blobBytes: Map<string, number>
  readonly sessionHashes: Map<string, Set<string>>
  readonly pageStates: Map<string, PageStateDoc>
}

const BLOB_PREFIX_LEN = 'sha256:'.length // 7

function blobHexOf(hash: string): string {
  return hash.slice(BLOB_PREFIX_LEN)
}

function sha256Of(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

// —— 打开：目录准备 + journal 扫描 + blob 校验 + page-state 对账 ——

async function readJournal(
  journalPath: string,
  onRecover?: (message: string) => void,
): Promise<ObservationEnvelope[]> {
  let buf: Buffer
  try {
    buf = await readFile(journalPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new SiftStoreError('storage_error', `journal 读取失败: ${(error as NodeJS.ErrnoException).code}`)
  }
  if (buf.length === 0) return []

  // 断尾：末行无 '\n' 终结 = 写入中途崩溃 → 截断到最后一个完整行
  if (buf[buf.length - 1] !== 0x0a) {
    const lastNl = buf.lastIndexOf(0x0a)
    const goodLen = lastNl === -1 ? 0 : lastNl + 1
    await truncateFile(journalPath, goodLen)
    onRecover?.(`journal 断尾截断：丢弃 ${buf.length - goodLen} 字节不完整尾部`)
    buf = buf.subarray(0, goodLen)
  }

  const rows: ObservationEnvelope[] = []
  const text = buf.toString('utf8')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line === '') continue
    try {
      rows.push(JSON.parse(line) as ObservationEnvelope)
    } catch {
      // 断尾已被上面处理；中段坏行只可能来自外部篡改/磁盘故障 → 拒绝启动
      throw corrupt(`journal 第 ${i + 1} 行不是合法 JSON（store_corrupt，拒绝打开）`)
    }
  }
  return rows
}

async function truncateFile(path: string, length: number): Promise<void> {
  const handle = await open(path, 'r+')
  try {
    await handle.truncate(length)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function verifyBlob(root: string, hash: string): Promise<number> {
  const hex = blobHexOf(hash)
  const path = join(root, 'blobs', hex.slice(0, 2), hex)
  let content: Buffer
  try {
    content = await readFile(path)
  } catch {
    throw corrupt(`journal 引用的 blob 缺失: ${hash.slice(0, 16)}…`)
  }
  if (sha256Of(content) !== hash) {
    throw corrupt(`blob 内容与 hash 不符: ${hash.slice(0, 16)}…`)
  }
  return content.length
}

/** journal 重放构建 page-state（含 dom_snapshot payload 的 url/title 提取）。 */
async function replayPageStates(
  root: string,
  rows: readonly ObservationEnvelope[],
): Promise<Map<string, PageStateDoc>> {
  const states = new Map<string, PageStateDoc>()
  for (const envelope of rows) {
    let snapshot: SnapshotReplaceInfo | null = null
    if (envelope.type === 'dom_snapshot') {
      const hex = blobHexOf(envelope.payloadHash)
      const raw = await readFile(join(root, 'blobs', hex.slice(0, 2), hex))
      let payload: { url?: unknown; title?: unknown }
      try {
        payload = JSON.parse(raw.toString('utf8')) as { url?: unknown; title?: unknown }
      } catch {
        throw corrupt(`dom_snapshot payload 无法解析: ${envelope.id}`)
      }
      if (typeof payload.url !== 'string' || typeof payload.title !== 'string') {
        throw corrupt(`dom_snapshot payload 缺 url/title: ${envelope.id}`)
      }
      snapshot = { url: payload.url, title: payload.title, payloadHash: envelope.payloadHash }
    }
    states.set(
      envelope.pageInstanceId,
      reducePageState(states.get(envelope.pageInstanceId) ?? null, envelope, snapshot),
    )
  }
  return states
}

/** page-state 文件与 journal 重放结果对账：落后/缺文件 → 重写；超前 → store_corrupt。 */
async function reconcilePageStates(
  root: string,
  states: Map<string, PageStateDoc>,
  onRecover?: (message: string) => void,
): Promise<void> {
  const dir = join(root, 'page-states')
  const entries = await readdir(dir)
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const pid = name.slice(0, -'.json'.length)
    if (!PAGE_INSTANCE_ID_PATTERN.test(pid)) continue // 非本 store 命名域的文件不碰
    let doc: PageStateDoc
    try {
      doc = parsePageState(await readFile(join(dir, name), 'utf8'))
    } catch {
      continue // 坏/半写的派生文件：下面按 journal 权威重写（或忽略）
    }
    const replayed = states.get(pid)
    if (replayed === undefined) {
      if (doc.lastAppliedSequence > 0 || doc.observationCount > 0) {
        throw corrupt(`page-state 无 journal 支撑却非空: ${pid}`)
      }
      continue
    }
    if (doc.lastAppliedSequence > replayed.lastAppliedSequence) {
      throw corrupt(`page-state 领先于 journal: ${pid}`)
    }
  }
  for (const [pid, doc] of states) {
    const path = join(dir, `${pid}.json`)
    let current: string | null = null
    try {
      current = await readFile(path, 'utf8')
    } catch {
      current = null
    }
    if (current !== serializePageState(doc)) {
      await writePageStateAtomically(dir, pid, doc)
      onRecover?.(`page-state 按 journal 重放补齐: ${pid}（stateVersion=${doc.stateVersion}）`)
    }
  }
}

async function writePageStateAtomically(
  dir: string,
  pageInstanceId: string,
  doc: PageStateDoc,
): Promise<void> {
  const finalPath = join(dir, `${pageInstanceId}.json`)
  const tmpPath = join(dir, `.tmp-${pageInstanceId}`)
  const handle = await open(tmpPath, 'w')
  try {
    await handle.writeFile(Buffer.from(serializePageState(doc), 'utf8'))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmpPath, finalPath)
}

// —— 门面实现 ——

export class SiftFsStore implements SiftStore {
  private readonly root: string
  private readonly journalPath: string
  private readonly journal: FileHandle
  private readonly rows: readonly ObservationEnvelope[]
  private readonly byId: Map<string, string>
  private readonly bySeq: Map<string, string>
  private readonly highWater: Map<string, number>
  private readonly blobRefs: Map<string, number>
  private readonly blobBytes: Map<string, number>
  private readonly sessionHashes: Map<string, Set<string>>
  private readonly pageStates: Map<string, PageStateDoc>
  private closed = false

  private constructor(root: string, journal: FileHandle, index: OpenedIndex) {
    this.root = root
    this.journalPath = join(root, 'observations.jsonl')
    this.journal = journal
    this.rows = index.rows
    this.byId = index.byId
    this.bySeq = index.bySeq
    this.highWater = index.highWater
    this.blobRefs = index.blobRefs
    this.blobBytes = index.blobBytes
    this.sessionHashes = index.sessionHashes
    this.pageStates = index.pageStates
  }

  static async open(opts: OpenSiftStoreOptions): Promise<SiftFsStore> {
    const { rootDir, onRecover } = opts
    const blobsDir = join(rootDir, 'blobs')
    const statesDir = join(rootDir, 'page-states')
    const stagingDir = join(rootDir, 'staging')
    await mkdir(blobsDir, { recursive: true })
    await mkdir(statesDir, { recursive: true })
    await mkdir(stagingDir, { recursive: true })
    // staging 孤儿回收（staging 写后崩溃的残留）
    for (const name of await readdir(stagingDir)) {
      await unlink(join(stagingDir, name))
    }

    const journalPath = join(rootDir, 'observations.jsonl')
    const rows = await readJournal(journalPath, onRecover)

    // 扫 journal 建幂等索引与引用计数
    const byId = new Map<string, string>()
    const bySeq = new Map<string, string>()
    const highWater = new Map<string, number>()
    const blobRefs = new Map<string, number>()
    const sessionHashes = new Map<string, Set<string>>()
    for (const envelope of rows) {
      const prevId = byId.get(envelope.id)
      if (prevId !== undefined && prevId !== envelope.payloadHash) {
        throw corrupt(`journal 同 id 异 hash: ${envelope.id}`)
      }
      byId.set(envelope.id, envelope.payloadHash)
      bySeq.set(`${envelope.pageInstanceId}#${envelope.sequence}`, envelope.payloadHash)
      highWater.set(
        envelope.pageInstanceId,
        Math.max(highWater.get(envelope.pageInstanceId) ?? -1, envelope.sequence),
      )
      blobRefs.set(envelope.payloadHash, (blobRefs.get(envelope.payloadHash) ?? 0) + 1)
      let hashes = sessionHashes.get(envelope.sessionId)
      if (hashes === undefined) {
        hashes = new Set<string>()
        sessionHashes.set(envelope.sessionId, hashes)
      }
      hashes.add(envelope.payloadHash)
    }

    // 引用完整性：journal 引用的 blob 必须存在且 hash 相符
    const blobBytes = new Map<string, number>()
    for (const hash of blobRefs.keys()) {
      blobBytes.set(hash, await verifyBlob(rootDir, hash))
    }

    const pageStates = await replayPageStates(rootDir, rows)
    await reconcilePageStates(rootDir, pageStates, onRecover)

    const journal = await open(journalPath, 'a')
    const store = new SiftFsStore(rootDir, journal, {
      rows,
      byId,
      bySeq,
      highWater,
      blobRefs,
      blobBytes,
      sessionHashes,
      pageStates,
    })
    await store.refreshMeta()
    return store
  }

  private globalBytes(): number {
    let total = 0
    for (const n of this.blobBytes.values()) total += n
    return total
  }

  private sessionBytes(sessionId: string): number {
    let total = 0
    for (const hash of this.sessionHashes.get(sessionId) ?? []) {
      total += this.blobBytes.get(hash) ?? 0
    }
    return total
  }

  /** meta.json 只是记账缓存：权威值每次打开时由 blob 目录 + journal 重算。 */
  private async refreshMeta(): Promise<void> {
    const sessions: Record<string, number> = {}
    for (const sessionId of this.sessionHashes.keys()) {
      sessions[sessionId] = this.sessionBytes(sessionId)
    }
    const meta = {
      schemaVersion: 1,
      ttlDays: TTL_DAYS,
      globalBytes: this.globalBytes(),
      globalQuotaBytes: GLOBAL_QUOTA_BYTES,
      sessionQuotaBytes: SESSION_QUOTA_BYTES,
      observationCount: this.byId.size,
      sessions,
      updatedAt: new Date().toISOString(),
    }
    const tmp = join(this.root, 'meta.json.tmp')
    await writeFile(tmp, `${JSON.stringify(meta)}\n`, 'utf8')
    await rename(tmp, join(this.root, 'meta.json'))
  }

  async appendObservation(
    envelope: ObservationEnvelope,
    payload: Uint8Array,
  ): Promise<StoreCommitResult> {
    if (this.closed) throw new SiftStoreError('storage_error', 'store 已关闭')

    // 防御纵深：落盘路径/引用只接受协议字符集（协议层已校验，此处再核）
    if (!PAGE_INSTANCE_ID_PATTERN.test(envelope.pageInstanceId)) {
      throw corrupt(`pageInstanceId 非法: ${envelope.pageInstanceId}`)
    }
    if (!SHA256_HASH_PATTERN.test(envelope.payloadHash) || envelope.payloadRef !== envelope.payloadHash) {
      throw corrupt('payloadHash 形状非法或与 payloadRef 不一致')
    }
    const actual = sha256Of(payload)
    if (actual !== envelope.payloadHash) {
      throw new SiftStoreError('storage_error', `payload 实际 hash 与 envelope 声明不符（${actual.slice(0, 16)}…）`)
    }

    // 幂等：同 id 同 hash → deduplicated（commit_ack 丢失后的合法重发）
    const existing = this.byId.get(envelope.id)
    if (existing !== undefined) {
      if (existing !== envelope.payloadHash) throw corrupt(`同 id 异 hash: ${envelope.id}`)
      const watermark = this.pageStates.get(envelope.pageInstanceId)
      return {
        deduplicated: true,
        payloadHash: envelope.payloadHash,
        stateVersion: watermark?.stateVersion ?? 0,
        lastAppliedSequence: watermark?.lastAppliedSequence ?? envelope.sequence,
      }
    }

    // snapshot 信息在 journal 写入**之前**解析：杜绝"journal 有行但 payload 不可解析"
    // 的毒行（该状态会使下次打开期重放直接 store_corrupt）
    let snapshot: SnapshotReplaceInfo | null = null
    if (envelope.type === 'dom_snapshot') {
      let parsed: { url?: unknown; title?: unknown }
      try {
        parsed = JSON.parse(Buffer.from(payload).toString('utf8')) as { url?: unknown; title?: unknown }
      } catch {
        throw corrupt(`dom_snapshot payload 无法解析: ${envelope.id}`)
      }
      if (typeof parsed.url !== 'string' || typeof parsed.title !== 'string') {
        throw corrupt(`dom_snapshot payload 缺 url/title: ${envelope.id}`)
      }
      snapshot = { url: parsed.url, title: parsed.title, payloadHash: envelope.payloadHash }
    }

    // blob 复用或新写
    const knownBytes = this.blobBytes.get(envelope.payloadHash)
    if (knownBytes === undefined) {
      // 配额复核（新字节才计）
      if (this.globalBytes() + payload.length > GLOBAL_QUOTA_BYTES) {
        throw new SiftStoreError('quota_exceeded', '全局配额超限（1GiB）')
      }
      if (this.sessionBytes(envelope.sessionId) + payload.length > SESSION_QUOTA_BYTES) {
        throw new SiftStoreError('quota_exceeded', `Session 配额超限: ${envelope.sessionId}`)
      }
      // staging 同卷写 → fsync → 读回长度+hash 校验 → rename（原子）
      const hex = blobHexOf(envelope.payloadHash)
      const blobDir = join(this.root, 'blobs', hex.slice(0, 2))
      await mkdir(blobDir, { recursive: true })
      const stagingPath = join(this.root, 'staging', randomUUID())
      const stagingHandle = await open(stagingPath, 'w')
      try {
        await stagingHandle.writeFile(Buffer.from(payload))
        await stagingHandle.sync()
      } finally {
        await stagingHandle.close()
      }
      const written = await readFile(stagingPath).catch(() => null)
      if (written === null || written.length !== payload.length || sha256Of(written) !== envelope.payloadHash) {
        await unlink(stagingPath).catch(() => {})
        throw new SiftStoreError('storage_error', 'staging 读回校验失败（长度或 hash）')
      }
      await rename(stagingPath, join(blobDir, hex))
      this.blobBytes.set(envelope.payloadHash, payload.length)
    }

    // journal append（fsync）——事实来源；此后崩溃都可恢复
    const line = Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8')
    await this.journal.write(line)
    await this.journal.sync()

    // 内存索引推进
    this.byId.set(envelope.id, envelope.payloadHash)
    this.bySeq.set(`${envelope.pageInstanceId}#${envelope.sequence}`, envelope.payloadHash)
    this.highWater.set(
      envelope.pageInstanceId,
      Math.max(this.highWater.get(envelope.pageInstanceId) ?? -1, envelope.sequence),
    )
    this.blobRefs.set(envelope.payloadHash, (this.blobRefs.get(envelope.payloadHash) ?? 0) + 1)
    let hashes = this.sessionHashes.get(envelope.sessionId)
    if (hashes === undefined) {
      hashes = new Set<string>()
      this.sessionHashes.set(envelope.sessionId, hashes)
    }
    hashes.add(envelope.payloadHash)

    // page-state 替换
    const doc = reducePageState(this.pageStates.get(envelope.pageInstanceId) ?? null, envelope, snapshot)
    this.pageStates.set(envelope.pageInstanceId, doc)
    await writePageStateAtomically(join(this.root, 'page-states'), envelope.pageInstanceId, doc)

    await this.refreshMeta()
    return {
      deduplicated: false,
      payloadHash: envelope.payloadHash,
      stateVersion: doc.stateVersion,
      lastAppliedSequence: doc.lastAppliedSequence,
    }
  }

  async findObservationById(id: string): Promise<ObservationRef | null> {
    const h = this.byId.get(id)
    return h === undefined ? null : { payloadHash: h }
  }

  async findObservationBySequence(pageInstanceId: string, sequence: number): Promise<ObservationRef | null> {
    const h = this.bySeq.get(`${pageInstanceId}#${sequence}`)
    return h === undefined ? null : { payloadHash: h }
  }

  async getSequenceHighWater(pageInstanceId: string): Promise<number | null> {
    return this.highWater.get(pageInstanceId) ?? null
  }

  async getPageWatermark(pageInstanceId: string): Promise<PageWatermark | null> {
    const doc = this.pageStates.get(pageInstanceId)
    return doc === undefined ? null : { stateVersion: doc.stateVersion, lastAppliedSequence: doc.lastAppliedSequence }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.journal.close()
  }
}

/** 打开（或创建）一个 FS store；任何完整性违例 → SiftStoreError(store_corrupt)。 */
export async function openSiftStore(opts: OpenSiftStoreOptions): Promise<SiftFsStore> {
  return SiftFsStore.open(opts)
}
