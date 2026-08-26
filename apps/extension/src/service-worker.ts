// Sift MV3 service worker —— 骨架（ADR-001 §9 步骤 2/3 实现）。
//
// 冻结的边界（P0_DEMO_SCOPE §2.2 / ADR-001 E-04）：
//  - 仅在 Chrome 认可的用户手势（action 点击）后 scripting.executeScript 注入固定文件；
//  - manifest 无 host_permissions，跨 origin 后停止并要求重新授权（验收门 3）；
//  - 唯一网络出口是 chrome.runtime.sendNativeMessage -> com.dj.sift.demo
//    （allowed_origins 只含固定 demo Extension ID jhkdmlohebjffokfonhiijhhmocfcppo）；
//  - 大 payload 应用层分块 <= 256 KiB；host 原子写入完成后才视为 commit。
export const SIFT_SERVICE_WORKER_MARKER = 'sift-service-worker-v0'
