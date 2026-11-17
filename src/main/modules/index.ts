/**
 * 主进程功能模块注册中心。
 *
 * 新增一个功能模块只需：
 *   1. 在 `src/main/ipc/<feature>.ts` 写好 `registerXxxHandlers()`
 *   2. 在下面 `MODULES` 里加一行
 *   （若还需在渲染进程加面板，见 `src/renderer/src/modules/registry.tsx`）
 *
 * 详见 docs/EXTENDING.md。
 */
import { registerLibraryHandlers } from '../ipc/library'
import { registerAttachmentHandlers } from '../ipc/attachments'
import { registerReaderHandlers } from '../ipc/reader'
import { registerNotesHandlers } from '../ipc/notes'
import { registerMetadataHandlers } from '../ipc/metadata'
import { registerDiscoveryHandlers } from '../ipc/discovery'
import { registerTranslateHandlers } from '../ipc/translate'
import { registerSearchHandlers } from '../ipc/search'
import { registerBatchHandlers } from '../ipc/batch'
import { registerOrganizeHandlers } from '../ipc/organize'
import { registerSystemHandlers } from '../ipc/system'
import { registerSettingsHandlers } from '../ipc/settings'
import { registerDataHandlers } from '../ipc/data'
import { registerAppHandlers } from '../ipc/app'
import { registerFilesHandlers } from '../ipc/files'
import { registerAuthorsHandlers } from '../ipc/authors'
import { registerSkillsHandlers } from '../ipc/skills'
import { registerJournalsHandlers } from '../ipc/journals'
import { registerAnalysisHandlers } from '../ipc/analysis'
import { registerBiblioHandlers } from '../ipc/biblio'
import { registerConnectorHandlers } from '../ipc/connector'
import { registerSurveyHandlers } from '../ipc/survey'
import { registerKnowledgeHandlers } from '../ipc/knowledge'
import { registerPageEditHandlers } from '../ipc/pages'

export interface MainModule {
  /** 唯一标识（也用于日志/调试） */
  id: string
  /** 中文名（展示用） */
  title: string
  /** 注册该模块的 IPC handler */
  registerIpc: () => void
  /** 可选：应用启动后调用 */
  onStartup?: () => void | Promise<void>
  /** 可选：应用退出前调用 */
  onShutdown?: () => void
}

export const MODULES: MainModule[] = [
  { id: 'library', title: '文库', registerIpc: registerLibraryHandlers },
  { id: 'attachments', title: '附件', registerIpc: registerAttachmentHandlers },
  { id: 'reader', title: '阅读与批注', registerIpc: registerReaderHandlers },
  { id: 'page-edit', title: '页面编辑', registerIpc: registerPageEditHandlers },
  { id: 'notes', title: '笔记', registerIpc: registerNotesHandlers },
  { id: 'metadata', title: '作者/引用识别', registerIpc: registerMetadataHandlers },
  { id: 'discovery', title: '相关论文', registerIpc: registerDiscoveryHandlers },
  { id: 'translate', title: '翻译', registerIpc: registerTranslateHandlers },
  { id: 'search', title: '检索与问答', registerIpc: registerSearchHandlers },
  { id: 'batch', title: '批处理', registerIpc: registerBatchHandlers, onStartup: undefined },
  { id: 'organize', title: '智能整理', registerIpc: registerOrganizeHandlers },
  { id: 'system', title: '服务自检', registerIpc: registerSystemHandlers },
  { id: 'settings', title: '设置', registerIpc: registerSettingsHandlers },
  { id: 'data', title: '数据安全', registerIpc: registerDataHandlers },
  { id: 'app', title: '应用', registerIpc: registerAppHandlers },
  { id: 'files', title: '文件', registerIpc: registerFilesHandlers },
  { id: 'authors', title: '作者信息', registerIpc: registerAuthorsHandlers },
  { id: 'skills', title: '翻译技能', registerIpc: registerSkillsHandlers },
  { id: 'journals', title: '期刊速查', registerIpc: registerJournalsHandlers },
  { id: 'analysis', title: '论文拆解', registerIpc: registerAnalysisHandlers },
  { id: 'survey', title: '领域调研', registerIpc: registerSurveyHandlers },
  { id: 'biblio', title: '文献网络', registerIpc: registerBiblioHandlers },
  { id: 'connector', title: 'Zotero 连接器', registerIpc: registerConnectorHandlers },
  { id: 'knowledge', title: '知识库', registerIpc: registerKnowledgeHandlers }
]

/** 注册所有模块（main/index.ts 启动时调用） */
export function registerAllModules(): void {
  for (const m of MODULES) {
    m.registerIpc()
    console.log(`[paperdesk] module loaded: ${m.id} (${m.title})`)
  }
}

export function shutdownModules(): void {
  for (const m of MODULES) {
    try {
      m.onShutdown?.()
    } catch (e) {
      console.warn(`[paperdesk] module ${m.id} shutdown error:`, e)
    }
  }
}
