// preload —— 渲染层唯一桥（contextIsolation + sandbox）。只暴露类型化 invoke 包装，
// 不暴露 ipcRenderer 本体、不暴露任何 Node/Electron 能力。渲染层拿到的数据全部
// 经过主进程 qa-service（store 只读摘要 / 投影 / 答案），不含 API key。
import { contextBridge, ipcRenderer } from 'electron'
import type { DemoMetricEvent, StoreOverview, BuildProjectionResult, StoredAnswerSummary } from '../qa-service'
import type { ModelConfigSummary } from '@sift/model'
import type { QuestionProjection } from '@sift/shared'
import type { TopicDetailResult, TopicGenerationResult, TopicPreviewResult } from '../topic-service'
import type { TopicProjection } from '@sift/topics'

export interface IpcFail {
  readonly ok: false
  readonly message: string
}
type IpcOk<T> = { readonly ok: true; readonly value: T }
export type IpcResult<T> = IpcOk<T> | IpcFail

/** ask-model 通道的结果联合（主进程已把失败折叠成可渲染形状）。 */
export type AskModelIpc =
  | { readonly status: 'ok'; readonly answer: import('../qa-service').StoredAnswer; readonly answerPath: string }
  | { readonly status: 'failed'; readonly code: string; readonly message: string }
  | { readonly status: 'model_unconfigured'; readonly missing: readonly string[]; readonly reason: string }

export interface SiftBridge {
  overview(): Promise<IpcResult<StoreOverview>>
  buildProjection(scopeRaw: string, question: string): Promise<IpcResult<BuildProjectionResult | { status: 'scope_parse_error'; message: string }>>
  generateTopics(scopeRaw: string, from: string, to: string): Promise<IpcResult<TopicGenerationResult | { status: 'scope_parse_error' | 'invalid_input' | 'model_unconfigured'; message?: string; missing?: readonly string[]; reason?: string }>>
  previewTopics(scopeRaw: string, from: string, to: string): Promise<IpcResult<TopicPreviewResult | { status: 'scope_parse_error' | 'invalid_input'; message?: string }>>
  topicDetail(scopeRaw: string, projection: TopicProjection, topicId: string): Promise<IpcResult<TopicDetailResult | { status: 'scope_parse_error' | 'invalid_input'; message?: string }>>
  topicCacheStatus(): Promise<IpcResult<{ readonly stale: boolean }>>
  askModel(projection: QuestionProjection): Promise<IpcResult<AskModelIpc>>
  listAnswers(): Promise<IpcResult<readonly StoredAnswerSummary[]>>
  deleteSession(sessionId: string): Promise<IpcResult<{ removedObservations: number; removedPages: number; removedBlobs: number }>>
  deletePage(pageInstanceId: string): Promise<IpcResult<{ removedObservations: number; removedPages: number; removedBlobs: number }>>
  deleteAll(): Promise<IpcResult<undefined>>
  modelConfig(): Promise<IpcResult<ModelConfigSummary>>
  openSource(url: string): Promise<IpcResult<undefined>>
  recordDemoMetric(event: DemoMetricEvent): Promise<IpcResult<undefined>>
  onOverviewUpdated(cb: () => void): void
}

const bridge: SiftBridge = {
  overview: () => ipcRenderer.invoke('sift:overview') as Promise<IpcResult<StoreOverview>>,
  buildProjection: (scopeRaw, question) =>
    ipcRenderer.invoke('sift:build-projection', { scopeRaw, question }) as Promise<
      IpcResult<BuildProjectionResult | { status: 'scope_parse_error'; message: string }>
    >,
  generateTopics: (scopeRaw, from, to) => ipcRenderer.invoke('sift:generate-topics', { scopeRaw, from, to }) as Promise<IpcResult<TopicGenerationResult | { status: 'scope_parse_error' | 'invalid_input' | 'model_unconfigured'; message?: string; missing?: readonly string[]; reason?: string }>>,
  previewTopics: (scopeRaw, from, to) => ipcRenderer.invoke('sift:preview-topics', { scopeRaw, from, to }) as Promise<IpcResult<TopicPreviewResult | { status: 'scope_parse_error' | 'invalid_input'; message?: string }>>,
  topicDetail: (scopeRaw, projection, topicId) => ipcRenderer.invoke('sift:topic-detail', { scopeRaw, projection, topicId }) as Promise<IpcResult<TopicDetailResult | { status: 'scope_parse_error' | 'invalid_input'; message?: string }>>,
  topicCacheStatus: () => ipcRenderer.invoke('sift:topic-cache-status') as Promise<IpcResult<{ readonly stale: boolean }>>,
  askModel: projection => ipcRenderer.invoke('sift:ask-model', { projection }) as Promise<IpcResult<AskModelIpc>>,
  listAnswers: () => ipcRenderer.invoke('sift:list-answers') as Promise<IpcResult<readonly StoredAnswerSummary[]>>,
  deleteSession: sessionId =>
    ipcRenderer.invoke('sift:delete-session', { sessionId }) as Promise<IpcResult<{ removedObservations: number; removedPages: number; removedBlobs: number }>>,
  deletePage: pageInstanceId =>
    ipcRenderer.invoke('sift:delete-page', { pageInstanceId }) as Promise<IpcResult<{ removedObservations: number; removedPages: number; removedBlobs: number }>>,
  deleteAll: () => ipcRenderer.invoke('sift:delete-all') as Promise<IpcResult<undefined>>,
  modelConfig: () => ipcRenderer.invoke('sift:model-config') as Promise<IpcResult<ModelConfigSummary>>,
  openSource: url => ipcRenderer.invoke('sift:open-source', { url }) as Promise<IpcResult<undefined>>,
  recordDemoMetric: event => ipcRenderer.invoke('sift:record-demo-metric', event) as Promise<IpcResult<undefined>>,
  onOverviewUpdated: cb => ipcRenderer.on('sift:overview-updated', () => cb()),
}

contextBridge.exposeInMainWorld('sift', bridge)
