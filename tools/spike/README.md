# tools/spike —— E-03 Native Host 进程模型验证

`run-e03-spike.mjs` 是 ADR-001 E-03 的限时 spike 验证门：模拟 Chrome 的 native
messaging 行为（spawn `Sift.exe <allowed-origin> --parent-window=<id>` + stdio 管道上的
长度前缀帧），对**打包后**的 exe 执行：

- 阶段 A：UI 未运行，≥100 次 connect/disconnect + framed ping/pong round-trip；
- 阶段 B：UI 实例运行中重复阶段 A，并断言第二个 UI 实例因单实例锁快速退出且
  不影响 host 模式（“不因单实例锁冲突回退 host 模式”）。

帧编解码在脚本内独立实现，故意不复用 `@sift/host`（交叉验证线上格式）。

## 运行

```bash
pnpm --filter @sift/desktop build        # esbuild -> dist/main.js
pnpm --filter @sift/desktop package:dir  # electron-builder --dir -> pack/win-unpacked/Sift.exe
node tools/spike/run-e03-spike.mjs       # 默认 100 轮/阶段
node tools/spike/run-e03-spike.mjs --rounds 10   # 快速冒烟
```

判定：两阶段全部轮次 ok 且单实例锁断言通过 -> PASS；任一失败 -> FAIL，
按 ADR 约定另开替代 ADR（独立轻量 host，`packages/host` 契约不变）。
