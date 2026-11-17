# 扩展指南：如何新增一个功能模块

本项目把「功能」拆成**主进程模块**与**渲染进程面板**两类，二者独立、可选择性添加。

```
新增网络源/后台能力  ──▶  主进程模块（src/main/modules/index.ts 加一行）
新增一个右侧面板 UI  ──▶  渲染进程面板（src/renderer/src/modules/registry.tsx 加一行）
二者都要            ──▶  两处都加
```

---

## 一、新增主进程模块

以「导出 BibTeX」为例。

### 1. 写 service（可选）
`src/main/services/export.ts`：放纯业务逻辑（不要碰 electron 的 UI API）。

### 2. 写 IPC handler
`src/main/ipc/export.ts`：

```ts
import { ipcMain } from 'electron'
import { CH } from '../../shared/channels'
import { exportBibtex } from '../services/export'

export function registerExportHandlers(): void {
  ipcMain.handle(CH.export.bibtex, (_e, itemId: number): string => exportBibtex(itemId))
}
```

### 3. 声明通道 + 类型 + API
- `src/shared/channels.ts`：加 `export: { bibtex: 'export:bibtex' }`
- `src/shared/api.ts`：在 `PaperdeskApi` 里加 `export: { bibtex(itemId: number): Promise<string> }`
- `src/preload/index.ts`：在 `api` 对象里加
  ```ts
  export: { bibtex: (itemId) => ipcRenderer.invoke(CH.export.bibtex, itemId) }
  ```

> 这三处保证渲染进程能**类型安全**地调用（`window.api.export.bibtex(...)`）。

### 4. 注册模块
`src/main/modules/index.ts` 的 `MODULES` 加一行：

```ts
{ id: 'export', title: '导出', registerIpc: registerExportHandlers },
```

完成。启动时 `registerAllModules()` 会自动注册并打印 `module loaded: export (导出)`。

---

## 二、新增渲染进程面板

以「标签管理」面板为例。

### 1. 写组件
`src/renderer/src/features/tags/TagsPanel.tsx`：

```tsx
import type { PanelContext } from '../../modules/registry'

export function TagsPanel({ itemId }: PanelContext): React.JSX.Element {
  return <div className="panel">当前条目：{itemId ?? '无'}</div>
}
```

`PanelContext` 里可直接拿到：`itemId` / `attachmentId` / `notesRefresh` /
`onDeepLink(url)` / `onOpenTarget({itemId, attachmentId, page})` / `onLibraryChanged()`。

### 2. 注册面板
`src/renderer/src/modules/registry.tsx` 的 `PANELS` 加一行：

```tsx
{ id: 'tags', title: '标签', render: (c) => <TagsPanel {...c} /> }
```

右侧标签栏会自动出现「标签」按钮（由 `PANELS` 生成）。

---

## 三、新增一类「批处理任务」

批处理是本项目预留的**一类功能**扩展点，加一个任务只需两步。

### 1. 写处理器
`src/main/services/batch/registry.ts` 里加一个 `BatchTaskHandler`：

```ts
const myTask: BatchTaskHandler = {
  id: 'my-task',
  title: '我的批处理任务',
  description: '说明文字',
  input: 'attachment',        // 或 'item'
  usesLlm: true,              // 会调用模型（影响低峰调度提示）
  paramFields: [              // 会在面板上渲染成表单
    { key: 'mode', label: '模式', type: 'select', default: 'a',
      options: [{ value: 'a', label: 'A' }] },
    { key: 'template', label: '范式', type: 'textarea', rows: 6,
      hint: '每行一节',
      presets: [{ name: '默认', value: '问题\n方法\n结论' }] }
  ],
  async run(input, ctx) {
    // input.item / input.attachment 是解析好的实体
    // ctx.outDir 是本次作业的产物目录；ctx.log() 会实时推到 UI
    writeFileSync(join(ctx.outDir, `${input.attachment!.key}.txt`), 'hello', 'utf8')
    return { outputs: ['<文件名>'], message: '完成' }
  },
  // 可选：全部条目跑完后执行一次，用于跨条目汇总（如生成对比表）
  async finalize(ctx, results) {
    writeFileSync(join(ctx.outDir, 'summary.md'), '…', 'utf8')
    return { outputs: ['summary.md'], message: `汇总 ${results.length} 条` }
  }
}
```

### 2. 加进注册表
```ts
export const TASKS: BatchTaskHandler[] = [..., myTask]
```

完成。面板的任务下拉、参数表单、并发/低峰调度、进度事件、产物目录都自动生效。

### 关于低峰时段
`queue.ts` 的 `batchWindowStatus()` 读取设置 `batch.offPeakStart/offPeakEnd/offPeakOnly`；
作业创建时若勾选「仅低峰执行」且当前不在窗口内，会置为 `scheduled`，调度器每分钟检查一次自动放行。
适合把「批量调用大模型」的任务排到模型折扣时段执行。

---

## 四、约定与建议

- **ID 用 `key` 不用自增 id**：对外暴露、深链、文件命名都用 `key`，稳定可迁移。
- **IPC 入参做校验**：参考 `src/main/ipc/reader.ts` 的 `validate()`。
- **重活放 Python sidecar**：见 `python/app/`，主进程只做编排（`services/*.ts` 里用 `ensureSidecar()`）。
- **可插拔后端**：翻译/AI 都走「设置 > 环境变量 > 默认」的解析（`services/settings.ts` 的 `effective()` / `effectiveSecret()`）。
- **新表/新索引**：直接加到 `src/main/db/schema.sql`（全部是 `IF NOT EXISTS`，启动时自动补建，无需迁移脚本）。
- **加测试**：
  - 纯逻辑 → `python/tests/` 或 `scripts/test-*.ts`
  - 端到端 → 在 `scripts/e2e.cjs` 里加一段，用 CDP `evaluate` 断言
- **进程回收**：若新模块起了子进程/长连接，记得在 `MainModule.onShutdown` 或 `app.on('before-quit')` 里清理。

---

## 五、现有模块清单

| 模块 id | 说明 | 主进程 | 面板 |
|---|---|---|---|
| library | 文库/导入 | ✅ | 左侧栏 |
| attachments | 附件 | ✅ | — |
| reader | 阅读与批注 | ✅ | 中间阅读器 |
| notes | Markdown 笔记 + 深链 | ✅ | 笔记 |
| metadata | 作者/引用识别（sidecar） | ✅ | 元数据 |
| discovery | 相关论文图谱（OpenAlex） | ✅ | 相关论文 |
| translate | 保版式翻译（sidecar） | ✅ | 工具栏切换 |
| search | 全文检索 + RAG 问答（含语义） | ✅ | 搜索框 / 问答 |
| batch | 批处理（任务注册 + 队列 + 低峰调度） | ✅ | 批处理 |
| settings | 设置（AI/翻译/语义/批处理/外观） | ✅ | ⚙ 弹窗 |
| app | 打开外链等 | ✅ | — |
