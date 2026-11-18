// 主进程纯逻辑单元测试（Node 原生 TS 类型擦除直接运行）
// 运行: node scripts/test-unit.ts   （或 npm run test:unit）
import { isPositiveInt, validateCreateInput } from '../src/main/services/batch/validate.ts'
import {
  AI_TOOLS,
  AI_TOOL_CATEGORIES,
  AI_TOOL_PERMISSIONS,
  aiToolBlockReason,
  findAiTool,
  findToolState,
  isToolUsable,
  resolveToolState,
  stateToOverrides
} from '../src/shared/ai-tools.ts'
import {
  TranslationJobs,
  TranslationServiceExited,
  TranslationTerminationUnconfirmed,
  pollTranslationStatus
} from '../src/main/services/translation-jobs.ts'
import { earlyExitMessage, spawnErrorMessage } from '../src/main/sidecar/errors.ts'
import { resolveDataDir } from '../src/main/db/paths.ts'
import { BACKFILLS, COLUMN_MIGRATIONS, migrate } from '../src/main/db/migrate.ts'
import {
  chunkContentHash,
  chunkEvidencePrecision,
  locateChunkInModule,
  migrateKnowledgeBackfill,
  readChunkEvidence
} from '../src/main/services/knowledge-index.ts'
import {
  REQUIRED_BACKUP_TABLES,
  inspectBackupDatabase,
  restoreDatabase,
  type BackupBackend
} from '../src/main/services/backup.ts'
import {
  SEARCH_FAULT_MESSAGE,
  SEARCH_QUERY_CHANNEL,
  TEST_FAULT_ENV,
  TEST_FAULT_READER,
  activeTestFault,
  installSearchFaultInjection,
  parseTestFault,
  resolveTestFault,
  testFaultActive
} from '../src/main/test-profile.ts'
import { CH } from '../src/shared/channels.ts'
import {
  SHORT_SEGMENT_CHARS,
  chooseAnalysisModel,
  modelTierFor,
  splitByBudget
} from '../src/main/services/analysis-chunk.ts'
import { clampInt, mapWithConcurrency, runWithRetryMap } from '../src/main/services/concurrency.ts'
import { appendOverviewRow, checkAnalysis, formatQuality } from '../src/shared/analysis-check.ts'
import { markdownToHtml, sectionOutline, splitBySections } from '../src/shared/md-html.ts'
import {
  isTableBlock,
  looksLikeMarkdownTable,
  markdownTableToCsv,
  markdownTableToRows,
  mergeTranslatedBlocks,
  normalizeMarkdownTable,
  projectRows,
  splitTextBlocks,
  splitTranslatableBlocks,
  stripCodeFence,
  tableRowsToCsv,
  visibleColumnIndexes
} from '../src/shared/md-table.ts'
import { nextSortState, sortRowsByColumn } from '../src/shared/md-table-sort.ts'
import { callsPerUnit, estimateBatch } from '../src/shared/batch-estimate.ts'
import { fallbackDomain } from '../src/shared/domain.ts'
import { retryTargets } from '../src/main/services/batch/retry.ts'
import { selectRetryAllPlan } from '../src/shared/batch-retry-all.ts'
import { diffStats, lineDiff } from '../src/shared/diff.ts'
import { doiFromUrl, mapScholarResults, normalizeTitle, pickBestWork } from '../src/shared/scholar.ts'
import {
  GROUP_ALL,
  GROUP_NAME_MAX,
  GROUP_UNGROUPED,
  buildGroupTree,
  distinctGroupNames,
  filterItemsByGroup,
  flattenGroupTree,
  groupSelectOptions,
  groupWithDescendants,
  isGroupCollapsed,
  normalizeGroupName,
  toggleGroupCollapsed,
  visibleGroupNodes
} from '../src/shared/library-groups.ts'
import {
  GROUP_PANE_DEFAULT_HEIGHT,
  GROUP_PANE_LIST_MIN_HEIGHT,
  GROUP_PANE_MIN_HEIGHT,
  clampGroupPaneHeight,
  groupPaneHeightFromDrag,
  maxGroupPaneHeight,
  resetGroupPaneHeight
} from '../src/renderer/src/features/library/group-split.ts'
import {
  GROUP_ABSTRACT_CHARS,
  GROUP_CHUNK_CHARS,
  GROUP_CHUNKS_PER_PAPER,
  GROUP_MAX_PAPERS,
  buildGroupContext,
  groupPaperCount,
  type GroupHit,
  type GroupPaper
} from '../src/shared/ai-group.ts'
import { extractDoiFromHtml, isPdfHeader, summarizeResolveFailure } from '../src/main/services/fetch-pdf.ts'
import {
  normalizeTitle as normalizeEnrichTitle,
  pickBestByTitle,
  titleSimilarity
} from '../src/main/services/enrich.ts'
import { extractAnalysisSection } from '../src/shared/note-sections.ts'
import { safeBatchStem } from '../src/shared/batch-filename.ts'
import { mapSemanticResults, semanticYearParam } from '../src/shared/semantic-scholar.ts'
import { canReuseTranslation, type ReuseSignature } from '../src/shared/translation-reuse.ts'
import { translationMarkdownToHtml } from '../src/shared/chat-md.ts'
import {
  canContinueLine,
  formatPdGeom,
  joinAcrossLines,
  parsePdGeom,
  reflowLines,
  reflowTextBlocks
} from '../src/shared/text-reflow.ts'
import {
  failedItemsToCsv,
  failedItemsToMarkdown,
  NO_FAIL_MESSAGE,
  normalizeFailMessage,
  topFailReasons
} from '../src/shared/batch-fail.ts'
import {
  filterJobs,
  parseBatchJobFilter,
  serializeBatchJobFilter
} from '../src/shared/batch-filter.ts'
import {
  collectFailReasonOptions,
  selectJobIdsByFailureReason,
  selectJobIdsByFailureReasons
} from '../src/shared/batch-fail-filter.ts'
import {
  analysisSectionKey,
  clampSectionIndex,
  parseSectionIndex
} from '../src/shared/analysis-state.ts'
import { filterOutlineIndexes } from '../src/shared/outline-search.ts'
import { seedFindQuery } from '../src/shared/find-request.ts'
import { extractPdfLinks, normalizeIdentifier, parseBulkInput } from '../src/main/services/fetch-pdf.ts'
import { checkToken, parseImportRequest } from '../src/main/services/connector.ts'
import {
  buildCoAuthorGraph,
  buildCoCitationGraph,
  buildCouplingGraph,
  buildKeywordGraph,
  clusterByLabelPropagation,
  toGexf,
  toPajek,
  topSubgraph,
  vosLayout
} from '../src/shared/biblio.ts'
import type { BiblioGraph } from '../src/shared/biblio.ts'
import { pickTranslation } from '../src/shared/translation-pick.ts'
import { figureCropRegion, parseRefNums } from '../src/shared/figref.ts'
import {
  pickCaptionModule,
  pickRefModules,
  matchChunkToModule,
  matchChunkToModules
} from '../src/shared/modules.ts'
import {
  associateCitations,
  detectStructuralRefs,
  expandCiteNumbers,
  parseCitations,
  parseCiteNumber,
  recognizeCiteTypes,
  resolveCitationTargets
} from '../src/shared/citations.ts'
import { validateFormulaLatex, isBalanced } from '../src/shared/formula-validate.ts'
import { deriveStructuralConfidence, pickCandidate } from '../src/shared/formula-ocr.ts'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { registerHooks } from 'node:module'
import {
  ACCEPT_REASON_PLACEHOLDER,
  EDIT_ACCEPT_REASON_PLACEHOLDER,
  NOTE_IMPORT_BATCH_TASK,
  TRANSLATION_IMPORT_BATCH_TASK,
  acceptProposal,
  buildImportKnowledgePlan,
  collectItemImportSources,
  collectBatchDigestPapers,
  createBatch,
  createProposal,
  editAndAccept,
  getBatch,
  getEntry,
  getProposalDetail,
  knowledgeContentHash,
  knowledgeStatusAt,
  knowledgeValidation,
  listBatchPapers,
  listBatches,
  listEntries,
  listProposals,
  publishBatch,
  rejectProposal,
  runInTransaction,
  syncBatchProposals,
  syncBatchProposalsByPaper,
  syncDigestProposals,
  syncImportProposals
} from '../src/main/services/knowledge.ts'
import {
  KNOWLEDGE_AI_TOOL_NAMES,
  createKnowledgeAiTools
} from '../src/main/services/knowledge-ai.ts'
import * as knowledgeAiNamespace from '../src/main/services/knowledge-ai.ts'
import {
  SCOPE_ITEM_LIMIT,
  buildLikeMatch,
  buildScopeSql,
  groupScopeFromPaperIds,
  normalizeSearchScope
} from '../src/shared/knowledge-query.ts'
import { searchKnowledge } from '../src/main/services/knowledge-search.ts'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chatMarkdownToHtml, linkifyHtml } from '../src/shared/chat-md.ts'
import { formatCiteLabel, hasCite, parseCiteInner, splitCiteText } from '../src/shared/cite.ts'
import {
  docStateKey,
  mergeDocState,
  parseDocState,
  serializeDocState
} from '../src/shared/doc-state.ts'
import {
  BATCH_DIGEST_BATCH_TASK,
  BATCH_SYNC_BATCH_TASK,
  DIGEST_BATCH_TASK,
  STAGING_IMPORT_NO_ACTIVE_PAPER,
  STAGING_SCOPE_NOTE,
  STAGING_SOURCE_GUIDES,
  applyProposalStatus,
  applyPublishedProposals,
  approveAllDisabledTitle,
  batchSourceLabel,
  buildApproveAllOutcome,
  buildApproveAllPlan,
  buildBatchKnowledgePlan,
  buildDigestKnowledgePlan,
  buildEditAcceptPatch,
  buildPublishPlan,
  createMindMapDoc,
  describeApproveAllConfirm,
  describeApproveAllResult,
  describeBatchSyncResult,
  describeDigestSyncResult,
  describeImportResult,
  describePublishConflicts,
  describePublishResult,
  digestFingerprint,
  digestPointNodeText,
  digestPointsFromMarkdown,
  embedBackingFrom,
  exportSettingsPayload,
  fuseHybrid,
  groupProposalsByOp,
  isBatchDigestTask,
  knowledgeEmbedHint,
  knowledgeEmptyState,
  groupKnowledgeEntries,
  KNOWLEDGE_UNLINKED_PAPER,
  MINDMAP_DIGEST_SNIPPET_CHARS,
  mergeDigestPointsIntoMindMap,
  newlyImportedItemIds,
  resolveRetrievalMode,
  resolveStagingImportTarget,
  retrievalModeLabel,
  selectStagingProposals,
  stagingEmptyState,
  summarizeFolderImport
} from '../src/shared/api.ts'
import type { KnowledgeProposalSummary } from '../src/shared/types.ts'
import type { Translation } from '../src/shared/types.ts'
import {
  dedupeWorks,
  isSameWork,
  paperQueryFromQuestion,
  sourceLabel,
  webAnswerFromSources,
  webContextBlock,
  webOfflineNote,
  workKey,
  workOpenUrl,
  workPdfUrl
} from '../src/shared/paper-hits.ts'
import type { WebSource, WorkHit } from '../src/shared/types.ts'
import {
  classifyNetError,
  describeHttpStatus,
  getWebSearchEnabled,
  parseDdgHtml,
  parseProxyRules,
  searchWeb,
  TOTAL_BUDGET_MS,
  webAnswerContext,
  webForAnswer
} from '../src/main/services/web-search.ts'
import { mapSelectionRects, type SelectionRects } from '../src/shared/selection-map.ts'
import type { TranslationMap, TranslationMapBlock } from '../src/shared/types.ts'
import {
  MINDMAP_AI_NOT_CONFIGURED,
  MINDMAP_EXPAND_MAX,
  MINDMAP_EXPAND_MIN,
  MINDMAP_NODE_MAX_W,
  MINDMAP_NODE_MIN_H,
  MINDMAP_NODE_MIN_W,
  MindmapAiError,
  buildExpandPrompt,
  buildSupportPrompt,
  contextFromDoc,
  describeMindmapAiError,
  expandMindMapNode,
  findSupportingPassage,
  measureMindmapNode,
  buildMapOptimizePrompt,
  mapOutlineFromDoc,
  parseMapOptimizeResult,
  parseSupportResult,
  stripMarkdownForMap,
  summarizeMindMapNode
} from '../src/shared/mindmap-ai.ts'
import type { MindmapPromptContext } from '../src/shared/mindmap-ai.ts'
import {
  MINDMAP_AI_SOURCE,
  MINDMAP_DEFAULT_TEXT,
  MINDMAP_DIGEST_SOURCE,
  MINDMAP_ROOT_ID,
  MINDMAP_SKELETON_MAX_NODES,
  MINDMAP_SKELETON_MAX_TITLE,
  MINDMAP_UNTITLED,
  addChild,
  applyAiExpansion,
  childrenOf,
  countDescendants,
  createMindMap,
  findNode,
  flattenOutline,
  hasChildNodes,
  mergeDigestNodes,
  mergeSkeleton,
  normalizeMindMap,
  parseMindMapJson,
  removeDigestNodes,
  removeNode,
  renameNode,
  serializeMindMap,
  setNodePosition,
  undoAiExpansion
} from '../src/renderer/src/features/mindmap/mindmap-model.ts'
import {
  MINDMAP_MERGE_SIMILARITY,
  applyOptimizePreview,
  buildOptimizePreview,
  textSimilarity
} from '../src/renderer/src/features/mindmap/mindmap-optimize.ts'
import {
  MINDMAP_MAP_SOURCE,
  applyMapOptimize,
  buildMapOptimizePreview
} from '../src/renderer/src/features/mindmap/mindmap-map-optimize.ts'
import { dedupeMathGlyphs, normalizeSelectionText } from '../src/renderer/src/features/reader/selection-text.ts'
import {
  anchorToScrollTop,
  HALF_PAGE_STEP_RATIO,
  halfPageScrollTop,
  locateByMid,
  pickBlockIndex,
  scrollEdgeFlags,
  type ScrollPageBox
} from '../src/renderer/src/features/reader/scroll-locate.ts'
import {
  MINDMAP_EXPORT_EMPTY,
  escapeMermaidLabel,
  exportFileBaseName,
  hasExportableContent,
  orderMindmapNodes,
  toMarkdownOutline,
  toMermaid
} from '../src/shared/mindmap-export.ts'
import {
  MINDMAP_CHILD_DX as SCOPE_CHILD_DX,
  MINDMAP_ROOT_X as SCOPE_ROOT_X,
  MINDMAP_ROOT_Y as SCOPE_ROOT_Y,
  MINDMAP_SCOPE_CHILD_LIMIT,
  MINDMAP_SCOPE_COL_W,
  MINDMAP_SCOPE_MISSING_SUFFIX,
  MINDMAP_SCOPE_PAPER_MAX_CHARS,
  MINDMAP_SCOPE_ROW_GAP,
  buildScopedMindMap,
  normalizeMindmapScope
} from '../src/shared/mindmap-scope.ts'
import type { MindmapScopePaper } from '../src/shared/mindmap-scope.ts'
import {
  detectExplainIntent,
  detectRequestedLang,
  detectTranslateIntent,
  evidenceLabel,
  parseWebMode,
  pickSourceSelection,
  planAsk,
  splitForTranslation,
  wantsWebSearch,
  webModeAllowsRequest
} from '../src/shared/ask-intent.ts'
import {
  groupPaneHeightFromContent,
  groupTreeContentHeight,
  readStoredGroupPaneHeight
} from '../src/renderer/src/features/library/group-split.ts'
import {
  applyManualPublication,
  catalogLabel,
  describeCitation,
  emptyCitationRecord,
  emptyPublicationInfo,
  formatPublicationLine,
  mergePublicationInfo,
  normalizePublicationType,
  publicationFromCrossref,
  publicationFromOpenAlex,
  publicationFromPdfText,
  resolveCitationMatch,
  upgradePreprintToFormal
} from '../src/shared/publication.ts'
import { HIGHLIGHT_PALETTE, HIGHLIGHT_STATES, resolveHighlight } from '../src/shared/annotation-colors.ts'
import {
  buildOrganizePrompt,
  diffDraftNodes,
  extractJsonObject,
  knowledgeKindOf,
  normalizeOrganizeDraft,
  organizeEntryKindLabel,
  organizeNodeKindLabel,
  organizePurposeLabel,
  organizeTargetLabel,
  quoteMatchesSource,
  suggestMerges,
  summarizeDraft,
  titleSimilarity as organizeTitleSimilarity
} from '../src/shared/organize.ts'
import { isOpenCodeBaseUrl, modelAuthHeaders } from '../src/shared/model-auth.ts'
import type { MindMapDoc } from '../src/shared/types.ts'
import {
  MINDMAP_ANCHOR_MIN_QUOTE,
  anchorQuote,
  locateAnchor,
  locateQuoteSpan,
  normalizeMindmapAnchor,
  parseChunkRect,
  parseMindmapAnchor,
  serializeMindmapAnchor
} from '../src/shared/mindmap-anchor.ts'
import {
  MINDMAP_SKELETON_MAX_NODE_CHARS as MINDMAP_STRUCT_MAX_NODE_CHARS,
  MINDMAP_SKELETON_MAX_NODES as MINDMAP_STRUCT_MAX_NODES,
  MINDMAP_SKELETON_MIN_NODES as MINDMAP_STRUCT_MIN_NODES,
  MINDMAP_SKELETON_ROOT_ID,
  applySkeletonToMindMap,
  buildRuleSkeleton,
  buildSkeletonResult,
  cleanSkeletonText,
  hasSkeletonMarkup,
  parseSkeletonAiResult,
  skeletonNodeId
} from '../src/shared/mindmap-skeleton.ts'
import {
  MINDMAP_AI_TOOLS,
  MINDMAP_AI_TOOL_IDS,
  getMindmapAiTool,
  runMindmapAiTool
} from '../src/main/services/mindmap-ai-tools.ts'
import { parseOptimizeResult } from '../src/shared/mindmap-ai.ts'
import { AI_PRESETS, presetFor } from '../src/renderer/src/features/ai/presets.ts'
import {
  AI_CHAT_MAX_TOOL_CALLS,
  AI_CHAT_TOOLS,
  AI_CHAT_TOOL_IDS,
  CHAT_TOOL_PROTOCOL,
  buildToolResultsBlock,
  executeToolCalls,
  getAiChatTool,
  isReadonlyAiChatTool,
  parseToolCalls,
  runAiChatTool,
  stripToolCallLines,
  type AiChatToolIo
} from '../src/main/services/ai-chat-tools.ts'

// ---------------------------------------------------------------------------
// F02：批处理取消传播。queue.ts / registry.ts 依赖 electron + better-sqlite3，
// node 单测默认无法 import；这里用 Node 的同步模块钩子 stub 掉 electron、
// better-sqlite3 与 schema.sql?raw，并补上无扩展名模块的解析，使单测能加载
// 真实实现，对 runBatchItemLoop 跑并发用例（而不是用源码文本断言冒充行为验证）。
// 钩子只影响本进程后续的动态 import，不改变被测代码。
// ---------------------------------------------------------------------------
const F02_ELECTRON_STUB =
  'data:text/javascript;charset=utf-8,' +
  encodeURIComponent(`
export const app = {
  getPath: () => process.env.PAPERDESK_DATA || process.cwd(),
  getName: () => 'paperdesk-test',
  getVersion: () => '0.0.0',
  isPackaged: false,
  on() {}, once() {}, whenReady: () => Promise.resolve(), quit() {},
  setAppUserModelId() {}, requestSingleInstanceLock: () => true, onSecondInstance() {},
  getAppPath: () => process.cwd(), getLocale: () => 'zh-CN'
}
export class BrowserWindow {
  static getAllWindows() { return [] }
  static fromWebContents() { return null }
  constructor() {}
  isDestroyed() { return false }
  webContents = { send() {}, session: { webRequest: { onBeforeRequest() {} } } }
  loadURL() { return Promise.resolve() }
  loadFile() { return Promise.resolve() }
  on() {} once() {} show() {} hide() {} focus() {} close() {}
}
export const shell = { openPath: async () => '', openExternal: async () => '', showItemInFolder() {} }
export const ipcMain = { handle() {}, on() {}, removeHandler() {}, emit() {} }
export const ipcRenderer = { invoke: async () => ({}), on() {}, send() {}, once() {}, removeAllListeners() {} }
export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: '' }),
  showMessageBox: async () => ({ response: 0 })
}
export const nativeTheme = { shouldUseDarkColors: false, themeSource: 'system', on() {} }
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s) => Buffer.from(String(s)),
  decryptString: (b) => String(b)
}
export const Menu = { setApplicationMenu() {}, buildFromTemplate: () => ({}) }
export const clipboard = { writeText() {}, readText: () => '' }
export const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 }, scaleFactor: 1 }) }
export const contextBridge = { exposeInMainWorld() {} }
export default { app, BrowserWindow, shell, ipcMain, dialog, nativeTheme, safeStorage, Menu, clipboard, screen }
`)

const F02_SQLITE_STUB =
  'data:text/javascript;charset=utf-8,' +
  encodeURIComponent(`
export default class Database {
  constructor() {}
  pragma() {}
  exec() {}
  prepare() {
    return {
      run() { return { changes: 0, lastInsertRowid: 0 } },
      get() { return undefined },
      all() { return [] }
    }
  }
  close() {}
  transaction(fn) { return fn }
}
`)

registerHooks({
  resolve(specifier: string, context: any, nextResolve: any) {
    if (specifier === 'electron') return { url: F02_ELECTRON_STUB, format: 'module', shortCircuit: true }
    if (specifier === 'better-sqlite3') return { url: F02_SQLITE_STUB, format: 'module', shortCircuit: true }
    if (specifier.endsWith('?raw')) {
      return { url: new URL(specifier, context.parentURL).href, shortCircuit: true }
    }
    try {
      return nextResolve(specifier, context)
    } catch (e) {
      if ((specifier.startsWith('.') || specifier.startsWith('/')) && context.parentURL) {
        const base = new URL(specifier, context.parentURL)
        for (const candidate of [base.href + '.ts', base.href + '/index.ts', base.href + '.tsx']) {
          if (existsSync(fileURLToPath(candidate))) return { url: candidate, shortCircuit: true }
        }
      }
      throw e
    }
  },
  load(url: string, context: any, nextLoad: any) {
    if (url.includes('?raw')) {
      const parsed = new URL(url)
      const file = fileURLToPath(new URL(parsed.pathname, parsed))
      return {
        format: 'module',
        source: `export default ${JSON.stringify(readFileSync(file, 'utf8'))}`,
        shortCircuit: true
      }
    }
    return nextLoad(url, context)
  }
})

// ---------------------------------------------------------------------------
// GD：分组顺序与移动需要真实 SQL。这里追加第二个解析钩子接管 better-sqlite3：
// globalThis.__GD_SQLITE_FACTORY 为空时沿用 no-op 假类（与上方桩一致），
// 测试里注入 node:sqlite(DatabaseSync) 适配后 initDb/getDb 便在真实 SQLite 上运行。
// 链式 resolve 会继续走到旧钩子，因此无扩展名模块与 ?raw 的处理不受影响。
// ---------------------------------------------------------------------------
const GD_SQLITE_STUB =
  'data:text/javascript;charset=utf-8,' +
  encodeURIComponent(`
class FallbackDb {
  pragma() {}
  exec() {}
  prepare() {
    return {
      run() { return { changes: 0, lastInsertRowid: 0 } },
      get() { return undefined },
      all() { return [] }
    }
  }
  close() {}
  transaction(fn) { return fn }
}
export default class Database {
  constructor(...args) {
    const factory = globalThis.__GD_SQLITE_FACTORY
    return factory ? factory(...args) : new FallbackDb()
  }
}
`)

registerHooks({
  resolve(specifier: string, context: any, nextResolve: any) {
    if (specifier === 'better-sqlite3') {
      return { url: GD_SQLITE_STUB, format: 'module', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  }
})

// ---------------------------------------------------------------------------
// BLOCKS：getModules（src/main/services/modules.ts）消费侧车 /modules 响应，
// 但 ensureSidecar（src/main/sidecar/manager.ts）会真 spawn python——单测不可走。
// 把 '../sidecar/manager' 解析到内存桩（返回假的 base URL，配合下方
// blocksPassthroughTests 的 fetch 注入）。钩子链继续传递：electron / better-sqlite3 /
// ?raw 依旧由上方既有钩子处理。
// ---------------------------------------------------------------------------
// globalThis.__BLOCKS_TEST_STUB_SIDECAR 在整个测试会话内恒为真（进程内默认）：
// translation/figures 等早期用例就会建立 services/modules 的模块缓存，其静态依赖
// '../sidecar/manager' 只在**首次解析**时走钩子——若此时标志位为假便永久落到真
// manager.ts（Node ESM 里 __dirname 不存在，ensureSidecar 必抛错）。按组动态开关
// 对已缓存的解析无效，故改为全程启用；桩自身无副作用（fetch 由各用例自行注入）。
const BLOCKS_SIDECAR_STUB =
  'data:text/javascript;charset=utf-8,' +
  encodeURIComponent(`
export async function ensureSidecar() {
  return globalThis.__BLOCKS_TEST_SIDECAR_BASE || 'http://sidecar.test/'
}
export function stopSidecar() {}
export function isSidecarRunning() { return false }
export function sidecarLogTail() { return '' }
`)
registerHooks({
  resolve(specifier: string, context: any, nextResolve: any) {
    if (globalThis.__BLOCKS_TEST_STUB_SIDECAR && /sidecar[\\/]manager$/.test(specifier)) {
      return { url: BLOCKS_SIDECAR_STUB, format: 'module', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  }
})
globalThis.__BLOCKS_TEST_STUB_SIDECAR = true

let f02QueueModule: Promise<any> | null = null
function loadF02Queue(): Promise<any> {
  if (!f02QueueModule) f02QueueModule = import(new URL('../src/main/services/batch/queue.ts', import.meta.url).href)
  return f02QueueModule
}

let translateModule: Promise<any> | null = null
function loadTranslate(): Promise<any> {
  if (!translateModule) translateModule = import(new URL('../src/main/services/translate.ts', import.meta.url).href)
  return translateModule
}

let failed = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name} ${extra}`)
  }
}

function throws(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

const knownTask = (id: string): boolean => id === 'translate' || id === 'export-doc'

console.log('主进程单元测试')

// ---------- 批处理入参校验（回归：非法请求必须被拒绝，避免静默「处理全部」） ----------
const ok = validateCreateInput(
  { task: 'translate', scope: 'attachment', attachmentId: 3, params: { lang: 'zh' } },
  knownTask
)
check('合法 attachment 请求通过并原样返回', ok && ok.attachmentId === 3)

check(
  'scope=attachment 缺 attachmentId 被拒绝',
  !!throws(() => validateCreateInput({ task: 'translate', scope: 'attachment' }, knownTask))
)
check(
  'scope=attachment attachmentId=0 被拒绝',
  !!throws(() =>
    validateCreateInput({ task: 'translate', scope: 'attachment', attachmentId: 0 }, knownTask)
  )
)
check(
  '未知 task 被拒绝',
  !!throws(() => validateCreateInput({ task: 'nope', scope: 'all' }, knownTask))
)
check(
  'scope 非法被拒绝',
  !!throws(() => validateCreateInput({ task: 'translate', scope: 'everything' }, knownTask))
)
check(
  'scope=item 缺 itemId 被拒绝',
  !!throws(() => validateCreateInput({ task: 'translate', scope: 'item' }, knownTask))
)
check(
  'scope=select 空 itemIds 被拒绝',
  !!throws(() => validateCreateInput({ task: 'translate', scope: 'select', itemIds: [] }, knownTask))
)
check(
  'scope=select 含非正整数被拒绝',
  !!throws(() =>
    validateCreateInput({ task: 'translate', scope: 'select', itemIds: [1, -2] }, knownTask)
  )
)
check(
  'params 为数组被拒绝',
  !!throws(() =>
    validateCreateInput({ task: 'translate', scope: 'all', params: [] }, knownTask)
  )
)
check(
  'scope=all 无目标也合法',
  !!validateCreateInput({ task: 'translate', scope: 'all' }, knownTask)
)
check(
  'scope=group 缺 group 被拒绝',
  !!throws(() => validateCreateInput({ task: 'translate', scope: 'group' }, knownTask))
)
check(
  'scope=group 合法且保留分组路径',
  validateCreateInput({ task: 'translate', scope: 'group', group: '父/子' }, knownTask).group ===
    '父/子'
)
check(
  'scope=tag 缺标签被拒绝',
  !!throws(() => validateCreateInput({ task: 'translate', scope: 'tag' }, knownTask))
)
check(
  'scope=tag 合法且保留标签名',
  validateCreateInput({ task: 'translate', scope: 'tag', tag: '强化学习' }, knownTask).tag ===
    '强化学习'
)

// ---------- 多级分组树（回归：旧 a/b 路径补父级、悬停子组、父组批量含后代） ----------
const gtree = buildGroupTree([
  { name: '父/子', parent_name: '父', count: 3 },
  { name: '父/子/孙', parent_name: '父/子', count: 1 },
  { name: '空组', parent_name: null, count: 0 }
])
const gflat = flattenGroupTree(gtree)
check(
  '多级分组树补出父级并保持父子关系',
  gflat.some((g) => g.name === '父' && g.depth === 0) &&
    gflat.some((g) => g.name === '父/子' && g.depth === 1) &&
    gflat.some((g) => g.name === '父/子/孙' && g.depth === 2)
)
check(
  '父分组批量目标包含全部后代',
  groupWithDescendants(
    [
      { name: '父', parent_name: null, count: 0 },
      { name: '父/子', parent_name: '父', count: 3 },
      { name: '父/子/孙', parent_name: '父/子', count: 1 },
      { name: '无关', parent_name: null, count: 0 }
    ],
    '父'
  ).join(',') === '父,父/子,父/子/孙'
)

// ---------- 分组树折叠（VSCode 式：有子分组默认收起；折叠只影响显示，不影响选中分组） ----------
const ctree = buildGroupTree([
  { name: '折叠根', parent_name: null, count: 5 },
  { name: '折叠根/子1', parent_name: '折叠根', count: 2 },
  { name: '折叠根/子2', parent_name: '折叠根', count: 1 },
  { name: '叶子组', parent_name: null, count: 1 }
])
const cRoot = ctree.find((n) => n.name === '折叠根')!
const cLeaf = ctree.find((n) => n.name === '叶子组')!

check('折叠默认收起：有子分组的组默认收起', isGroupCollapsed({}, cRoot) === true)
check('无子分组的组默认展开', isGroupCollapsed({}, cLeaf) === false)

const cExpandedState = toggleGroupCollapsed({}, cRoot)
check(
  '点箭头展开：toggle 把默认收起的分组翻转为展开',
  isGroupCollapsed(cExpandedState, cRoot) === false,
)
const cRecollapsed = toggleGroupCollapsed(cExpandedState, cRoot)
check('再点收起：toggle 把已展开的分组翻回收起', isGroupCollapsed(cRecollapsed, cRoot) === true)
const cBefore: Record<string, boolean> = {}
toggleGroupCollapsed(cBefore, cRoot)
check('toggle 不修改入参状态', '折叠根' in cBefore === false && Object.keys(cRecollapsed).join(',') === '折叠根')
check(
  '显式展开标记不被默认规则覆盖',
  isGroupCollapsed({ 折叠根: false }, cRoot) === false &&
    isGroupCollapsed({ 叶子组: true }, cLeaf) === true
)
check(
  '折叠不影响选中分组：收起状态只影响显示，子孙分组的集合不变',
  isGroupCollapsed({}, cRoot) === true &&
    groupWithDescendants(
      [
        { name: '折叠根', parent_name: null, count: 5 },
        { name: '折叠根/子1', parent_name: '折叠根', count: 2 },
        { name: '折叠根/子2', parent_name: '折叠根', count: 1 }
      ],
      '折叠根'
    ).join(',') === '折叠根,折叠根/子1,折叠根/子2'
)
check(
  '收起父组不影响子孙组的过滤语义',
  filterItemsByGroup([{ group_name: '折叠根/子1' }, { group_name: '折' }], '折叠根/子1').length === 1
)

check('isPositiveInt 边界', isPositiveInt(1) && !isPositiveInt(0) && !isPositiveInt(1.5) && !isPositiveInt('1'))

// ---------- 分组级 AI 问答上下文（PD19：多篇论文 + 显式截断） ----------
const gPapers: GroupPaper[] = [
  { itemId: 11, title: '扩散模型的采样加速', abstract: '比较三类加速采样方法。' },
  { itemId: 12, title: '一致性模型的少步生成', abstract: null, attachmentId: 3 }
]
const gHits: GroupHit[] = [
  { chunkId: 101, itemId: 11, attachmentId: 1, page: 3, snippet: 'DDIM 把步数降到 20。', text: 'DDIM 把步数降到 20 步。' },
  { chunkId: 102, itemId: 12, attachmentId: 3, page: 5, snippet: '一致性蒸馏一步生成。', text: '一致性蒸馏可以一步生成。' },
  { chunkId: 103, itemId: 99, page: 1, snippet: '不属于本分组', text: '不应进入上下文' },
  { chunkId: 101, itemId: 11, page: 9, snippet: '重复块', text: '重复内容' }
]
const gctx = buildGroupContext(gPapers, gHits)
check(
  '分组上下文纳入两篇不同论文的引用',
  new Set(gctx.citations.map((c) => c.itemId)).size === 2 && gctx.usedPapers === 2 && gctx.paperCount === 2,
  `${gctx.usedPapers}/${gctx.paperCount}`
)
check(
  '分组引用编号从 1 连续',
  gctx.citations.every((c, i) => c.index === i + 1) && gctx.citations.length >= 4,
  String(gctx.citations.length)
)
check(
  '分组上下文含标题与条目 id',
  gctx.context.includes('扩散模型的采样加速') &&
    gctx.context.includes('条目 #11') &&
    gctx.context.includes('条目 #12')
)
check(
  '不属于分组的命中被忽略且重复 chunk 去重',
  gctx.citations.every((c) => c.itemId !== 99 && c.chunkId !== 103) &&
    gctx.citations.filter((c) => c.chunkId === 101).length === 1
)
check(
  '每篇论文正文片段不超过上限',
  gctx.citations.filter((c) => c.itemId === 11 && c.chunkId !== 0).length <= GROUP_CHUNKS_PER_PAPER
)

// 预算不足：显式截断而不是静默超长
const gTight = buildGroupContext(gPapers, gHits, 60)
check(
  '分组上下文预算不足时标记 truncatedBody 且不超预算',
  gTight.truncatedBody === true && gTight.context.length <= 60,
  `${gTight.context.length}/${gTight.truncatedBody}`
)
check('预算极小时不伪造引用', buildGroupContext(gPapers, gHits, 0).citations.length === 0)

const gEmpty = buildGroupContext([], [])
check(
  '空分组上下文为空且无引用',
  gEmpty.citations.length === 0 && gEmpty.context === '' && gEmpty.paperCount === 0
)

const gManyPapers: GroupPaper[] = Array.from({ length: GROUP_MAX_PAPERS + 3 }, (_, i) => ({
  itemId: i + 1,
  title: `论文 ${i + 1}`,
  abstract: '摘要'
}))
const gMany = buildGroupContext(gManyPapers, [])
check(
  '论文数超上限时标记 truncatedPapers 并保留真实总数',
  gMany.truncatedPapers === true &&
    gMany.paperCount === GROUP_MAX_PAPERS + 3 &&
    gMany.usedPapers === GROUP_MAX_PAPERS,
  `${gMany.usedPapers}/${gMany.paperCount}`
)

const gLongAbs = buildGroupContext(
  [{ itemId: 1, title: '超长摘要', abstract: '细'.repeat(GROUP_ABSTRACT_CHARS + 50) }],
  []
)
check(
  '摘要按 GROUP_ABSTRACT_CHARS 截断且引用摘要不超过 200 字',
  gLongAbs.context.includes('…') &&
    gLongAbs.context.length < GROUP_ABSTRACT_CHARS + 80 &&
    (gLongAbs.citations[0]?.snippet.length ?? 0) <= 200,
  String(gLongAbs.context.length)
)

const gLongBody = buildGroupContext(
  [{ itemId: 1, title: '长正文', abstract: '摘要' }],
  [{ chunkId: 7, itemId: 1, page: 2, snippet: '片段', text: '正'.repeat(GROUP_CHUNK_CHARS + 100) }]
)
check(
  '正文片段按 GROUP_CHUNK_CHARS 截断',
  gLongBody.context.includes('…') && gLongBody.context.length < GROUP_CHUNK_CHARS + 100,
  String(gLongBody.context.length)
)

const gCountItems = [
  { group_name: '父' },
  { group_name: '父/子' },
  { group_name: '父/子/孙' },
  { group_name: '父2' },
  { group_name: null }
]
check('分组论文计数包含全部子分组', groupPaperCount(gCountItems, '父') === 3)
check(
  '分组论文计数不误计同名前缀、未知分组为 0',
  groupPaperCount(gCountItems, '父2') === 1 &&
    groupPaperCount(gCountItems, ' 父 ') === 3 &&
    groupPaperCount(gCountItems, null) === 0 &&
    groupPaperCount(gCountItems, '__none__') === 0
)

// ---------- sidecar 错误文案（回归：缺 Python 要给出可操作提示） ----------
const enoent = spawnErrorMessage({ code: 'ENOENT', message: 'spawn python ENOENT' })
check('ENOENT → 提示安装 Python', enoent.includes('未找到 Python') && enoent.includes('PAPERDESK_PYTHON'), enoent)
const other = spawnErrorMessage({ code: 'EACCES', message: 'permission denied' })
check('其它 spawn 错误包含原因', other.includes('permission denied'), other)
check(
  '提前退出文案含 code',
  earlyExitMessage(1, null).includes('code=1') &&
    earlyExitMessage(null, 'SIGKILL').includes('SIGKILL'),
  earlyExitMessage(1, null)
)

// ---------- 数据目录覆盖（回归：测试可用 PAPERDESK_DATA 隔离真实数据） ----------
check(
  '默认数据目录 = <userData>/data',
  resolveDataDir('C:/Users/x/AppData/Roaming/paperdesk', {} as NodeJS.ProcessEnv).replace(/\\/g, '/').endsWith(
    'paperdesk/data'
  )
)
check(
  'PAPERDESK_DATA 覆盖生效',
  resolveDataDir('/x/userData', { PAPERDESK_DATA: 'D:/tmp/iso' } as NodeJS.ProcessEnv) ===
    'D:/tmp/iso'
)
check(
  'PAPERDESK_DATA 为空则回退默认',
  resolveDataDir('/x/userData', { PAPERDESK_DATA: '   ' } as NodeJS.ProcessEnv).replace(/\\/g, '/').endsWith(
    'userData/data'
  )
)

// ---------- 列迁移（回归：旧库升级补列，且不中断） ----------
function runMigrate(tables: Record<string, string[]>, throwFor?: string): {
  alters: string[]
  warned: number
} {
  const alters: string[] = []
  let warned = 0
  const db = {
    prepare(sql: string) {
      const m = /PRAGMA table_info\((\w+)\)/.exec(sql)
      const t = m ? m[1] : ''
      if (throwFor && t === throwFor) throw new Error('boom')
      return { all: () => (tables[t] ?? []).map((name) => ({ name })) }
    },
    exec(sql: string) {
      alters.push(sql)
    }
  }
  migrate(db, { info: () => {}, warn: () => (warned += 1) })
  return { alters, warned }
}

check(
  '每个迁移项都有 table/column/ddl',
  COLUMN_MIGRATIONS.every((m) => !!m.table && !!m.column && !!m.ddl) &&
    COLUMN_MIGRATIONS.some((m) => m.column === 'pinned')
)

const oldTranslations = ['id', 'key', 'path', 'engine', 'backend', 'status', 'date_added']
const m1 = runMigrate({ translations: oldTranslations })
check(
  '旧 translations 表补齐 html_path/qa/pinned 等列',
  m1.alters.some((s) => s.includes('translations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0')) &&
    m1.alters.some((s) => s.includes('translations ADD COLUMN qa TEXT')) &&
    m1.alters.some((s) => s.includes('translations ADD COLUMN html_path TEXT')),
  JSON.stringify(m1.alters)
)

const m2 = runMigrate({ translations: oldTranslations })
check(
  '表不存在（items 缺失）时不发 ALTER',
  !m2.alters.some((s) => s.includes('items ADD COLUMN'))
)

// 分组是加列迁移：老库的 items 表没有 group_name，必须补上且不丢数据
const itemsMig = runMigrate({ items: ['id', 'key', 'doi', 'title', 'date_added'] })
check(
  '旧 items 表补齐 group_name TEXT（分组）',
  itemsMig.alters.some((s) => s.includes('items ADD COLUMN group_name TEXT')),
  JSON.stringify(itemsMig.alters)
)
check(
  'items.group_name 已存在时不重复迁移（幂等）',
  !runMigrate({ items: ['id', 'group_name'] }).alters.some((s) =>
    s.includes('items ADD COLUMN group_name')
  )
)

const allCols = COLUMN_MIGRATIONS.filter((m) => m.table === 'translations').map((m) => m.column)
check(
  '列已存在则跳过（幂等）',
  runMigrate({ translations: allCols }).alters.length === 0
)

const m3 = runMigrate({ translations: ['id'] }, 'translations')
check('单列迁移异常只告警不抛出', m3.warned > 0 && m3.alters.length === 0, `warned=${m3.warned}`)

// ---------- 长文分段（splitByBudget）：纯函数 ----------
const pages = [0, 1, 2, 3, 4].map((p) => ({ page_index: p, text: 'x'.repeat(100) }))
const oneChunk = splitByBudget(pages, 10000)
check(
  'splitByBudget：预算足够时只切一段（覆盖 1–5 页）',
  oneChunk.length === 1 && oneChunk[0].from === 1 && oneChunk[0].to === 5,
  JSON.stringify(oneChunk.map((c) => [c.from, c.to]))
)
const manyChunks = splitByBudget(pages, 250)
check(
  'splitByBudget：预算小则多段、页序不倒退、覆盖完整',
  manyChunks.length >= 3 &&
    manyChunks[0].from === 1 &&
    manyChunks[manyChunks.length - 1].to === 5 &&
    manyChunks.every((c, i) => i === 0 || c.from >= manyChunks[i - 1].to) &&
    manyChunks.every((c) => c.text.length > 0),
  JSON.stringify(manyChunks.map((c) => [c.from, c.to]))
)
check('splitByBudget：空输入返回空', splitByBudget([], 100).length === 0)

// ---------- 并发工具（保序 / 限流 / 失败隔离 / 取消） ----------
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

check(
  'clampInt：并发参数规整到 1–8（非法值用默认）',
  clampInt('4', 4, 1, 8) === 4 &&
    clampInt('20', 4, 1, 8) === 8 &&
    clampInt('0', 4, 1, 8) === 1 &&
    clampInt('abc', 4, 1, 8) === 4 &&
    clampInt(3.9, 4, 1, 8) === 3 &&
    clampInt(undefined, 4, 1, 8) === 4,
  JSON.stringify([clampInt('20', 4, 1, 8), clampInt('abc', 4, 1, 8)])
)

{
  let active = 0
  let peak = 0
  const got = await mapWithConcurrency(
    Array.from({ length: 9 }, (_, i) => i),
    3,
    async (n) => {
      active += 1
      peak = Math.max(peak, active)
      await sleep(5)
      active -= 1
      return n * 10
    }
  )
  check('mapWithConcurrency：峰值并发不超过 limit', peak === 3, `peak=${peak}`)
  check(
    'mapWithConcurrency：结果与输入同序',
    got.length === 9 && got.every((v, i) => v === i * 10),
    JSON.stringify(got)
  )
  check(
    'mapWithConcurrency：空输入返回空',
    (await mapWithConcurrency([], 4, async () => 1)).length === 0
  )
}

{
  const got = await mapWithConcurrency(
    [1, 2, 3, 4],
    2,
    async (n) => {
      if (n === 2 || n === 4) throw new Error('boom')
      return n
    },
    { fallback: (_item, index) => -(index + 1) }
  )
  check(
    'mapWithConcurrency：单项失败走 fallback，其它项不受影响',
    JSON.stringify(got) === '[1,-2,3,-4]',
    JSON.stringify(got)
  )
}

{
  const ctrl = new AbortController()
  ctrl.abort()
  const got = await mapWithConcurrency([1, 2, 3], 2, async (n) => n * 2, {
    signal: ctrl.signal,
    fallback: (n) => -n
  })
  check(
    'mapWithConcurrency：已取消时不再执行，未执行项按 fallback 占位且保序',
    JSON.stringify(got) === '[-1,-2,-3]',
    JSON.stringify(got)
  )

  const ctrl2 = new AbortController()
  let ran = 0
  const p = mapWithConcurrency(
    [1, 2, 3],
    1,
    async (n) => {
      ran += 1
      await sleep(10)
      return n
    },
    { signal: ctrl2.signal }
  )
  ctrl2.abort()
  let abortName = ''
  try {
    await p
  } catch (e) {
    abortName = e instanceof Error ? e.name : String(e)
  }
  check(
    'mapWithConcurrency：取消且无 fallback → 抛 AbortError，不再领取新任务',
    abortName === 'AbortError' && ran === 1,
    `name=${abortName} ran=${ran}`
  )
}

{
  const { results, calls, failures } = await runWithRetryMap({
    items: ['a', 'b', 'c'],
    limit: 2,
    attempts: 2,
    run: async (item) => {
      if (item === 'b') throw new Error('HTTP 429')
      return item.toUpperCase()
    },
    fallback: (item, _i, e) => `（${item} 分析失败：${(e as Error).message}）`
  })
  check('runWithRetryMap：失败重试 1 次，调用次数准确', calls === 4, `calls=${calls}`)
  check(
    'runWithRetryMap：失败隔离为占位，成功项与顺序不变',
    results[0] === 'A' &&
      results[1] === '（b 分析失败：HTTP 429）' &&
      results[2] === 'C' &&
      failures === 1,
    JSON.stringify({ results, failures })
  )
}

{
  // 模拟长文分段的 calls 计算（fake generate）：5 段、1 段连续失败
  const parts = [1200, 800, 2000, 500, 900]
  let fakeCalls = 0
  const { results, calls, failures } = await runWithRetryMap({
    items: parts,
    limit: 3,
    attempts: 2,
    run: async (chars) => {
      fakeCalls += 1
      await sleep(2)
      if (chars === 500) throw new Error('HTTP 503')
      return `片段${chars}`
    },
    fallback: (chars) => `（该段分析失败：${chars}）`
  })
  check(
    '长文分段：calls = 5 段 + 1 次重试（实际发起 6 次）',
    calls === 6 && fakeCalls === 6,
    `calls=${calls} fakeCalls=${fakeCalls}`
  )
  check(
    '长文分段：失败段写占位、按原顺序拼接、其它段保留',
    results.length === 5 &&
      results[0] === '片段1200' &&
      results[1] === '片段800' &&
      results[3] === '（该段分析失败：500）' &&
      results[4] === '片段900' &&
      failures === 1,
    JSON.stringify(results)
  )
}

// ---------- 模型智能路由（纯函数） ----------
const routeAll = { fastModel: 'fast-m', strongModel: 'strong-m', defaultModel: 'def-m' }
check(
  '路由：短分段（<4000 字）→ 快速模型',
  chooseAnalysisModel({ phase: 'segment', chars: SHORT_SEGMENT_CHARS - 1, ...routeAll }) ===
    'fast-m'
)
check(
  '路由：长分段（≥4000 字）→ 强模型',
  chooseAnalysisModel({ phase: 'segment', chars: SHORT_SEGMENT_CHARS, ...routeAll }) ===
    'strong-m'
)
check('路由：合并 → 强模型', chooseAnalysisModel({ phase: 'merge', ...routeAll }) === 'strong-m')
check('路由：批次对比 → 强模型', chooseAnalysisModel({ phase: 'compare', ...routeAll }) === 'strong-m')
check(
  '路由：单篇一次成稿 → 强模型（质量优先）',
  chooseAnalysisModel({ phase: 'single', ...routeAll }) === 'strong-m'
)
check(
  '路由：未配置快速模型 → 短分段回退默认模型',
  chooseAnalysisModel({
    phase: 'segment',
    chars: 100,
    fastModel: '',
    strongModel: 'strong-m',
    defaultModel: 'def-m'
  }) === 'def-m'
)
check(
  '路由：未配置强模型 → 合并回退默认模型',
  chooseAnalysisModel({
    phase: 'merge',
    fastModel: 'fast-m',
    strongModel: '   ',
    defaultModel: 'def-m'
  }) === 'def-m'
)
check('路由：都没配置 → 空串（由 llm 用默认模型）', chooseAnalysisModel({ phase: 'merge' }) === '')
check(
  '路由：modelTierFor 阈值正确',
  SHORT_SEGMENT_CHARS === 4000 &&
    modelTierFor('segment', 3999) === 'fast' &&
    modelTierFor('segment', 4000) === 'strong' &&
    modelTierFor('merge', 10) === 'strong'
)

// ---------- 拆解证据自检（纯函数） ----------
const sample = [
  '## 论文 A（Zhang, 2021, Nature）',
  '- 阅读覆盖：全文 [p.1]',
  '### 3 核心贡献',
  '- 提出了一个方法，在 3 个数据集上提升了 12%。[p.4]',
  '- 该方法明显优于基线。',
  '### 5 证据与结果',
  '- 消融实验表明各模块都有贡献 [Tab.2]。',
  '```',
  '### 9 代码块里的伪小节不应计入',
  '```',
  '### 6 可信度与局限',
  '- 样本量偏小。'
].join('\n')
const q = checkAnalysis(sample)
check('q.locators 统计到 3 处定位', q.locators === 3, JSON.stringify(q))
check('q.sections 识别 3/5/6（忽略代码块）', JSON.stringify(q.sections) === '[3,5,6]', JSON.stringify(q.sections))
check('q.claims 至少 4 条、且带定位 3 条', q.claims >= 4 && q.claimsWithLocator === 3, JSON.stringify(q))
check('missing 收录缺定位的结论行', q.missing.length >= 1 && q.missing[0].includes('基线'), JSON.stringify(q.missing))
check('formatQuality 含「定位」与「带定位」', /定位 \d+ 处/.test(formatQuality(q)) && /条带定位/.test(formatQuality(q)), formatQuality(q))

const ov1 = appendOverviewRow('', ['job-1', '2026-01-01', '2', 'brief', 'all', '5/9'])
check('appendOverviewRow：空输入生成表头 + 一行', ov1.includes('批次 | 时间') && ov1.includes('job-1'), ov1)
const ov2 = appendOverviewRow(ov1, ['job-2', '2026-01-02', '3', 'standard', 'core', '7/10'])
check(
  'appendOverviewRow：累加且不重复表头',
  (ov2.match(/\|\s*job-\d/g) || []).length === 2 && (ov2.match(/批次 \| 时间/g) || []).length === 1,
  ov2
)

// ---------- Markdown → HTML（导出折叠报告，纯函数） ----------
const html = markdownToHtml(
  ['# 论文 A', '### 3 核心贡献', '- 提升了 **12%** [p.4]', '> 仅供定性参考', '```', '<b>raw</b>', '```', '### 5 证据'].join('\n'),
  { title: '论文 A 拆解', note: '离线占位' }
)
check('mdHtml：小节折叠为 details', (html.match(/<details class="sec"/g) || []).length === 2, html)
check('mdHtml：定位变为锚点', html.includes('href="#p4"'), html)
check('mdHtml：粗体与代码块', html.includes('<strong>12%</strong>') && html.includes('<pre><code>'), html)
check('mdHtml：代码块内标签被转义（防注入）', html.includes('&lt;b&gt;raw&lt;/b&gt;'), html)
check('mdHtml：含标题与说明', html.includes('<title>论文 A 拆解</title>') && html.includes('class="note"'), html)

// ---------- 译文 Markdown → 结构化 HTML（PD22：段落 / 列表 / 标题） ----------
const transMd = [
  '<!-- 第 1 页 -->',
  '',
  '# 论文标题',
  '',
  '## 1 引言',
  '',
  '第一段：组合优化问题很常见，含行内公式 $a^2 + b^2 = c^2$、\\(x_i\\) 与引用 (Mara et al., 2022)。',
  '',
  '第二段：带编号引用 [14, 40] 的正文，不能与上一段合并。',
  '',
  '第三段：最后一段正文。',
  '',
  '- 项目符号一',
  '- 项目符号二',
  '  - 嵌套条目 A',
  '  - 嵌套条目 B',
  '',
  '1. 有序步骤一',
  '2. 有序步骤二',
  '',
  '2.1 子标题',
  '',
  '<!-- 第 2 页 -->',
  '',
  '## 2 方法',
  '',
  '第四段：第二页正文。',
  ''
].join('\n')
const transHtml = translationMarkdownToHtml(transMd)
check(
  '译文 md：页注释转分页 section，且不以正文出现',
  (transHtml.match(/<section class="tpage"/g) || []).length === 2 &&
    transHtml.includes('data-page="2"') &&
    !transHtml.includes('<!--') &&
    !transHtml.includes('第 1 页'),
  transHtml
)
check(
  '译文 md：4 段各自成块（不合并成少数大段）',
  (transHtml.match(/<p>/g) || []).length === 4,
  transHtml
)
check(
  '译文 md：标题层级 # / ## / 编号子标题 2.1',
  transHtml.includes('<h1>论文标题</h1>') &&
    transHtml.includes('<h2>1 引言</h2>') &&
    transHtml.includes('<h2>2 方法</h2>') &&
    transHtml.includes('<h3>2.1 子标题</h3>'),
  transHtml
)
check(
  '译文 md：项目符号保留为 ul（含 2 层嵌套）',
  (transHtml.match(/<ul>/g) || []).length === 2 &&
    (transHtml.match(/<li>/g) || []).length === 6 &&
    /<li>项目符号二<ul>/.test(transHtml),
  transHtml
)
check(
  '译文 md：有序列表保留条目与顺序',
  (transHtml.match(/<ol>/g) || []).length === 1 &&
    transHtml.includes('<li>有序步骤一</li><li>有序步骤二</li>'),
  transHtml
)
check(
  '译文 md：行内公式与引用标记原样保留',
  transHtml.includes('$a^2 + b^2 = c^2$') &&
    transHtml.includes('\\(x_i\\)') &&
    transHtml.includes('(Mara et al., 2022)') &&
    transHtml.includes('[14, 40]'),
  transHtml
)
const transOlStart = translationMarkdownToHtml('3. 三\n4. 四')
check('译文 md：有序列表起始序号保留', transOlStart.includes('<ol start="3">'), transOlStart)
const transFormula = translationMarkdownToHtml('· · · T (T (z, H), H), H')
check(
  '译文 md：连续 · 的公式行不当列表',
  transFormula.includes('<p>') && !transFormula.includes('<ul>'),
  transFormula
)
const transDup = translationMarkdownToHtml('<!-- 第 1 页 -->\n# 页眉\n\n<!-- 第 2 页 -->\n# 页眉\n')
check(
  '译文 md：跨页重复页眉只保留一个标题',
  (transDup.match(/<h1>/g) || []).length === 1 && transDup.includes('tpage__muted'),
  transDup
)
const transJoin = translationMarkdownToHtml('第一行\n第二行')
check('译文 md：块内折行并回同一段（中文不插空格）', transJoin.includes('<p>第一行第二行</p>'), transJoin)

// ---------- 批处理调用估算（纯函数） ----------
check('callsPerUnit：拆解按档位', callsPerUnit('analyze-paper', { depth: 'deep' }) === 3 && callsPerUnit('analyze-paper', {}) === 2, '')
check('callsPerUnit：embed 为 0', callsPerUnit('embed', undefined) === 0, '')
const est = estimateBatch('analyze-paper', { depth: 'standard' }, 4)
check('estimateBatch：篇数×每篇次数', est.count === 4 && est.calls === 8, JSON.stringify(est))
check('estimateBatch：含「粗略」说明', /粗略/.test(est.note), est.note)
const estCmp = estimateBatch('compare', undefined, 3)
check('estimateBatch：compare 另加 1 次汇总', estCmp.calls === 4, JSON.stringify(estCmp))
const estZero = estimateBatch('analyze-paper', {}, 0)
check('estimateBatch：0 项', estZero.calls === 0, JSON.stringify(estZero))

// ---------- 只重试失败项（retryTargets，纯函数） ----------
const fakeJob = (over: Record<string, unknown> = {}): any => ({
  id: 1,
  key: 'k',
  task: 'analyze-paper',
  title: 't',
  params: JSON.stringify({ depth: 'brief' }),
  status: 'failed',
  off_peak_only: 0,
  total: 3,
  done: 3,
  message: null,
  out_dir: null,
  error: null,
  date_created: '',
  date_started: null,
  date_finished: null,
  ...over
})
const fakeItem = (over: Record<string, unknown> = {}): any => ({
  id: 1,
  job_id: 1,
  item_id: null,
  attachment_id: null,
  label: null,
  status: 'pending',
  output: null,
  message: null,
  ...over
})

const rp = retryTargets(fakeJob(), [
  fakeItem({ id: 1, item_id: 10, status: 'failed' }),
  fakeItem({ id: 2, item_id: 11, attachment_id: 20, status: 'failed' }),
  fakeItem({ id: 3, item_id: 12, status: 'done' })
])
check(
  'retryTargets：只返回失败项（含参数与任务）',
  !!rp && rp.task === 'analyze-paper' && rp.params.depth === 'brief' && rp.targets.length === 2,
  JSON.stringify(rp)
)
check(
  'retryTargets：目标保留 itemId / attachmentId',
  !!rp && rp.targets[1].itemId === 11 && rp.targets[1].attachmentId === 20,
  JSON.stringify(rp && rp.targets)
)
check(
  'retryTargets：status=running 返回 null',
  retryTargets(fakeJob({ status: 'running' }), [fakeItem({ status: 'failed', item_id: 1 })]) === null
)
check(
  'retryTargets：无失败项返回 null',
  retryTargets(fakeJob(), [fakeItem({ status: 'done', item_id: 1 })]) === null
)
const rpSkip = retryTargets(fakeJob(), [
  fakeItem({ id: 1, item_id: null, attachment_id: null, status: 'failed' }),
  fakeItem({ id: 2, item_id: 5, status: 'failed' })
])
check(
  'retryTargets：跳过无 item_id / attachment_id 的失败项',
  !!rpSkip && rpSkip.targets.length === 1 && rpSkip.targets[0].itemId === 5,
  JSON.stringify(rpSkip)
)
check('retryTargets：作业缺失返回 null', retryTargets(null, [fakeItem({ status: 'failed', item_id: 1 })]) === null)
check(
  'retryTargets：params 已是对象也能解析',
  (() => {
    const p = retryTargets(fakeJob({ params: { lang: 'zh' } }), [
      fakeItem({ status: 'failed', item_id: 1 })
    ])
    return !!p && p.params.lang === 'zh'
  })()
)

// ---------- 跨作业「重跑全部失败项」计划（selectRetryAllPlan，纯函数） ----------
const retryAllSame = selectRetryAllPlan(
  [
    fakeJob({ id: 1, task: 'analyze-paper', status: 'failed' }),
    fakeJob({ id: 2, task: 'analyze-paper', status: 'done' })
  ],
  [
    { jobId: 1, items: [fakeItem({ job_id: 1, item_id: 10, status: 'failed' })] },
    { jobId: 2, items: [fakeItem({ job_id: 2, item_id: 11, status: 'failed' })] }
  ]
)
check(
  'selectRetryAllPlan：同任务两个作业合并为一个计划',
  retryAllSame.length === 1 &&
    retryAllSame[0].task === 'analyze-paper' &&
    retryAllSame[0].targets.length === 2,
  JSON.stringify(retryAllSame)
)

const retryAllSplit = selectRetryAllPlan(
  [
    fakeJob({ id: 1, task: 'analyze-paper', status: 'failed' }),
    fakeJob({ id: 2, task: 'embed', status: 'failed' })
  ],
  [
    { jobId: 1, items: [fakeItem({ job_id: 1, item_id: 10, status: 'failed' })] },
    { jobId: 2, items: [fakeItem({ job_id: 2, item_id: 11, status: 'failed' })] }
  ]
)
check(
  'selectRetryAllPlan：不同任务拆分为多个计划',
  retryAllSplit.length === 2 && retryAllSplit.map((p) => p.task).join(',') === 'analyze-paper,embed',
  JSON.stringify(retryAllSplit.map((p) => p.task))
)

const retryAllNonTerminal = selectRetryAllPlan(
  [fakeJob({ id: 1, task: 'analyze-paper', status: 'running' })],
  [{ jobId: 1, items: [fakeItem({ job_id: 1, item_id: 10, status: 'failed' })] }]
)
check(
  'selectRetryAllPlan：忽略非终态作业',
  retryAllNonTerminal.length === 0,
  JSON.stringify(retryAllNonTerminal)
)

const retryAllSkipIds = selectRetryAllPlan(
  [fakeJob({ id: 1, task: 'analyze-paper', status: 'failed' })],
  [
    {
      jobId: 1,
      items: [
        fakeItem({ job_id: 1, item_id: null, attachment_id: null, status: 'failed' }),
        fakeItem({ job_id: 1, item_id: 5, status: 'failed' })
      ]
    }
  ]
)
check(
  'selectRetryAllPlan：跳过无 item_id / attachment_id 的失败项',
  retryAllSkipIds.length === 1 &&
    retryAllSkipIds[0].targets.length === 1 &&
    retryAllSkipIds[0].targets[0].itemId === 5,
  JSON.stringify(retryAllSkipIds)
)

const retryAllDedup = selectRetryAllPlan(
  [
    fakeJob({ id: 1, task: 'analyze-paper', status: 'failed' }),
    fakeJob({ id: 2, task: 'analyze-paper', status: 'failed' })
  ],
  [
    {
      jobId: 1,
      items: [fakeItem({ job_id: 1, item_id: 10, attachment_id: 20, status: 'failed' })]
    },
    {
      jobId: 2,
      items: [
        fakeItem({ job_id: 2, item_id: 10, attachment_id: 20, status: 'failed' }),
        fakeItem({ job_id: 2, item_id: 11, attachment_id: null, status: 'failed' })
      ]
    }
  ]
)
check(
  'selectRetryAllPlan：跨作业去重相同目标对',
  retryAllDedup.length === 1 && retryAllDedup[0].targets.length === 2,
  JSON.stringify(retryAllDedup)
)

check(
  'selectRetryAllPlan：无可重跑项返回空数组',
  selectRetryAllPlan(
    [fakeJob({ status: 'done' })],
    [{ jobId: 1, items: [fakeItem({ status: 'done', item_id: 1 })] }]
  ).length === 0
)

// ---------- 小节切分 / 表格转 CSV（纯函数） ----------
const sec = splitBySections(
  ['引言一段。', '### 1 研究问题', '- 问题 A [p.1]', '### 2 缺口', '```', '### 假的', '```', '正文'].join(
    '\n'
  )
)
check('splitBySections：引言与 2 个小节', sec.lead.includes('引言') && sec.sections.length === 2, JSON.stringify(sec))
check(
  'splitBySections：小节标题/正文正确（代码块内 ### 不算）',
  sec.sections[0].title === '1 研究问题' &&
    sec.sections[0].body.includes('问题 A') &&
    sec.sections[1].title === '2 缺口' &&
    sec.sections[1].body.includes('### 假的'),
  JSON.stringify(sec.sections)
)

// ---------- 小节大纲（可点击导航，纯函数） ----------
const outline = sectionOutline(sample)
check(
  'sectionOutline：条数与标题与 splitBySections 一致',
  outline.length === splitBySections(sample).sections.length &&
    outline.every((e, i) => e.title === splitBySections(sample).sections[i].title),
  JSON.stringify(outline)
)
check(
  'sectionOutline：忽略代码块内 ###（3 条 3/5/6）',
  outline.length === 3 &&
    outline.map((e) => e.title).join(',') === '3 核心贡献,5 证据与结果,6 可信度与局限',
  JSON.stringify(outline)
)
check(
  'sectionOutline：index 等于数组位置',
  outline.every((e, i) => e.index === i),
  JSON.stringify(outline)
)

const csv = markdownTableToCsv(
  ['前文', '| 论文 | 方法 | 备注 |', '|---|---|---|', '| A | **GNN** | 含,逗号 |', '| B | 简单 | "引号" |', '', '结尾'].join(
    '\n'
  )
)
check(
  'markdownTableToCsv：跳过表头分隔行',
  csv.split('\n').filter(Boolean).length === 3 && csv.includes('论文,方法,备注'),
  csv
)
check('markdownTableToCsv：去粗体 + 逗号单元格加引号', csv.includes('GNN') && csv.includes('"含,逗号"'), csv)
check('markdownTableToCsv：引号转义', csv.includes('""引号""'), csv)
check('markdownTableToCsv：无表格返回空', markdownTableToCsv('没有表格') === '', '')

// ---------- 表格按维度浏览（表头 + 数据行，纯函数） ----------
const tbl = markdownTableToRows(
  ['前文', '| 论文 | 方法 | 备注 |', '|---|---|---|', '| A | **GNN** | x |', '| B | 简单 | y |', '', '结尾'].join(
    '\n'
  )
)
check(
  'markdownTableToRows：表头 3 列 + 2 数据行',
  tbl.header.length === 3 && tbl.rows.length === 2,
  JSON.stringify(tbl)
)
check(
  'markdownTableToRows：跳过表头分隔行',
  tbl.header.join(',') === '论文,方法,备注' && tbl.rows[0][0] === 'A',
  JSON.stringify(tbl.header)
)
check('markdownTableToRows：去掉 **粗体**', tbl.rows[0][1] === 'GNN', JSON.stringify(tbl.rows))
check(
  'markdownTableToRows：无表格返回空结构',
  (() => {
    const e = markdownTableToRows('没有表格')
    return e.header.length === 0 && e.rows.length === 0
  })(),
  ''
)

// ---------- 表格「表头 + 数据行」转 CSV（导出当前筛选，纯函数） ----------
const rCsv = tableRowsToCsv(
  ['论文', '方法'],
  [
    ['A', 'GNN'],
    ['B', '含,逗号'],
    ['C', '带"引号"']
  ]
)
check(
  'tableRowsToCsv：拼接表头 + 数据行并以换行结尾',
  rCsv === '论文,方法\nA,GNN\nB,"含,逗号"\nC,"带""引号"""\n',
  rCsv
)
check('tableRowsToCsv：含逗号单元格加引号', rCsv.includes('"含,逗号"'), rCsv)
check('tableRowsToCsv：双引号转义为 ""', rCsv.includes('"带""引号"""'), rCsv)
check('tableRowsToCsv：空表头返回空', tableRowsToCsv([], [['A']]) === '', '')

// ---------- 表格图片 → Markdown 表格（规范化，纯函数） ----------
const mt = normalizeMarkdownTable('| 论文 | 方法 |\n| --- | --- |\n| A | GNN |\n| B | CRF |')
check(
  'normalizeMarkdownTable：标准表原样保留（表头 + 分隔行 + 数据行）',
  mt === '| 论文 | 方法 |\n| --- | --- |\n| A | GNN |\n| B | CRF |',
  mt
)
check(
  'looksLikeMarkdownTable：标准表为 true',
  looksLikeMarkdownTable('| a | b |\n| --- | --- |\n| 1 | 2 |') === true,
  ''
)
check(
  'looksLikeMarkdownTable：无分隔行的竖线文本为 false',
  looksLikeMarkdownTable('| a | b |\n| 1 | 2 |') === false,
  ''
)
check('normalizeMarkdownTable：无分隔行返回空', normalizeMarkdownTable('| a | b |\n| 1 | 2 |') === '', '')
const mtPad = normalizeMarkdownTable(
  '| a | b | c |\n| --- | --- | --- |\n| 1 |\n| 1 | 2 | 3 | 4 |'
)
check(
  'normalizeMarkdownTable：短行补齐、长行截断到表头列数',
  mtPad === '| a | b | c |\n| --- | --- | --- |\n| 1 |  |  |\n| 1 | 2 | 3 |',
  mtPad
)
const mtPipe = normalizeMarkdownTable('| expr | 说明 |\n| --- | --- |\n| a\\|b | c |')
check(
  'normalizeMarkdownTable：单元格内竖线转义为 \\|',
  mtPipe === '| expr | 说明 |\n| --- | --- |\n| a\\|b | c |',
  mtPipe
)
const mtFence = normalizeMarkdownTable(
  '这是识别结果：\n```markdown\n| x | y |\n| --- | --- |\n| 1 | 2 |\n```\n希望有帮助'
)
check(
  'normalizeMarkdownTable：去掉 ```markdown 围栏与前后解释文字',
  mtFence === '| x | y |\n| --- | --- |\n| 1 | 2 |',
  mtFence
)
check(
  'normalizeMarkdownTable：接受 :---: 对齐分隔行并统一输出 | --- |',
  normalizeMarkdownTable('| a | b |\n|:---|---:|\n| 1 | 2 |') ===
    '| a | b |\n| --- | --- |\n| 1 | 2 |',
  normalizeMarkdownTable('| a | b |\n|:---|---:|\n| 1 | 2 |')
)
check(
  'normalizeMarkdownTable：纯散文返回空',
  normalizeMarkdownTable('这张图片里只有一段说明文字，没有任何表格结构。') === '',
  ''
)
check('stripCodeFence：无围栏时原样返回（去首尾空白）', stripCodeFence('  | a |  ') === '| a |', '')
check('stripCodeFence：未闭合的起始围栏也去掉', stripCodeFence('```md\n| a |') === '| a |', '')

// ---------- 表格块识别：表格不送翻译、原样保留（PD23） ----------
// 1) 标准带表头表格（Markdown 表头 + 分隔行）
const tbHeader =
  '| Operator | Meaning | Count |\n| --- | --- | --- |\n| Identity | No change | 120 |\n| Replacement | Replace one character | 98 |'
check('isTableBlock：标准带表头表格为 true', isTableBlock(tbHeader) === true, '')
// 2) 无表头表格（连续两行以上、同列数的竖线行）
const tbNoHeader = '| 方法 | 准确率 |\n| GNN | 0.91 |\n| CRF | 0.88 |'
check('isTableBlock：无表头表格为 true', isTableBlock(tbNoHeader) === true, '')
// 3) 长文本单元格（多空格对齐的三列表格）
const tbLong = [
  'Operator             Description                                  Count',
  'Identity             No change whatsoever, the character stays    120',
  'Replacement (one)    Replace exactly one character in string      98'
].join('\n')
check('isTableBlock：多空格对齐的长文本单元格表格为 true', isTableBlock(tbLong) === true, '')
// 4) 制表符对齐的表格
const tbTab = '方法\t准确率\t样本数\nGNN\t0.91\t1200\nCRF\t0.88\t980'
check('isTableBlock：制表符对齐表格为 true', isTableBlock(tbTab) === true, '')
// 5) 普通段落负例：不含多个连续列分隔符
check(
  'isTableBlock：普通段落为 false',
  isTableBlock('本文提出一种新的图神经网络方法，并在三个数据集上做了验证。\n实验表明该方法优于已有基线。') === false,
  ''
)
check(
  'isTableBlock：句中单个竖线（A|B）为 false',
  isTableBlock('在论文里我们用 A|B 表示两种可选方案，这不是表格。') === false,
  ''
)
check(
  'isTableBlock：两行普通文字带双空格（列数一致但不足 3 行）为 false',
  isTableBlock('摘要  本文研究表格识别。\n关键词  深度学习，表格') === false,
  ''
)
check(
  'isTableBlock：列数不一致的竖线文本为 false',
  isTableBlock('| a | b |\n| c |') === false,
  ''
)
check('isTableBlock：单行为 false', isTableBlock('| a | b |') === false, '')

// 6) 块切分：散文块 + 表格块，表格块单独标出
const tbMixed = `本文提出 X 方法。

${tbHeader}

结论段落。`
const tbSegs = splitTranslatableBlocks(tbMixed)
check(
  'splitTranslatableBlocks：散文与表格切成 3 块且表格块被标出',
  tbSegs.length === 3 &&
    tbSegs[0].table === false &&
    tbSegs[1].table === true &&
    tbSegs[1].text === tbHeader &&
    tbSegs[2].table === false,
  JSON.stringify(tbSegs.map((b) => [b.table, b.text.slice(0, 12)]))
)
check(
  'splitTextBlocks：空行切块、块内换行保留',
  splitTextBlocks('第一段。\n\n第二段。').length === 2 &&
    splitTextBlocks('第一段。\n\n第二段。')[1].text === '第二段。',
  JSON.stringify(splitTextBlocks('第一段。\n\n第二段。'))
)
// 段落与表格紧贴（无空行）时也要把表格段单独切出来
const tbTight = '下面是对比结果。\nA\tB\n1\t2\n3\t4'
const tbTightSegs = splitTranslatableBlocks(tbTight)
check(
  'splitTranslatableBlocks：段落紧跟表格时单独切出表格块',
  tbTightSegs.length === 2 && tbTightSegs[0].table === false && tbTightSegs[1].table === true,
  JSON.stringify(tbTightSegs.map((b) => [b.table, b.text.slice(0, 10)]))
)

// 7) 回填：表格块原样保留，文字块按序取译文
const tbMerged = mergeTranslatedBlocks(tbSegs, ['【译】本文提出 X 方法。', '【译】结论段落。'])
check(
  'mergeTranslatedBlocks：表格块原样保留、文字块按序替换',
  tbMerged ===
    `【译】本文提出 X 方法。\n\n${tbHeader}\n\n【译】结论段落。`,
  tbMerged
)
check(
  'mergeTranslatedBlocks：表格数字与行列不被改写',
  tbMerged.includes('| Identity | No change | 120 |') && tbMerged.includes('| Replacement | Replace one character | 98 |'),
  ''
)
check(
  'mergeTranslatedBlocks：缺译文时回退原文（不丢内容）',
  mergeTranslatedBlocks(tbSegs, []) === tbMixed,
  mergeTranslatedBlocks(tbSegs, [])
)

// ---------- 对比表列「显示 / 隐藏」（纯函数） ----------
const vcHeader = ['论文', '方法', '备注']
check(
  'visibleColumnIndexes：隐藏中间列得到其余索引（按序）',
  visibleColumnIndexes(vcHeader, [1]).join(',') === '0,2',
  JSON.stringify(visibleColumnIndexes(vcHeader, [1]))
)
check(
  'visibleColumnIndexes：无隐藏返回全部',
  visibleColumnIndexes(vcHeader, []).join(',') === '0,1,2',
  JSON.stringify(visibleColumnIndexes(vcHeader, []))
)
check(
  'visibleColumnIndexes：全部隐藏回退为 [0]',
  visibleColumnIndexes(vcHeader, [0, 1, 2]).join(',') === '0',
  JSON.stringify(visibleColumnIndexes(vcHeader, [0, 1, 2]))
)
check(
  'visibleColumnIndexes：越界索引被忽略',
  visibleColumnIndexes(vcHeader, [-1, 9, 1]).join(',') === '0,2',
  JSON.stringify(visibleColumnIndexes(vcHeader, [-1, 9, 1]))
)
check(
  'projectRows：按索引取单元格并补空',
  JSON.stringify(projectRows([['A', 'B', 'C'], ['D']], [0, 2])) === '[["A","C"],["D",""]]',
  JSON.stringify(projectRows([['A', 'B', 'C'], ['D']], [0, 2]))
)
check(
  'projectRows：空输入返回空',
  projectRows([], [0]).length === 0 && projectRows([['A']], []).length === 1,
  JSON.stringify([projectRows([], [0]), projectRows([['A']], [])])
)

// ---------- 对比表「按列排序」（纯函数） ----------
const sortInput = [
  ['banana', '3'],
  ['Apple', '10'],
  ['cherry', '2'],
  ['', ''],
  ['Apple', '4'],
  ['date', '1']
]
const sortAsc = sortRowsByColumn(sortInput, 0, 'asc')
check(
  'sortRowsByColumn：升序（不分大小写，空值最后）',
  sortAsc.map((r) => r[0]).join(',') === 'Apple,Apple,banana,cherry,date,',
  JSON.stringify(sortAsc.map((r) => r[0]))
)
check(
  'sortRowsByColumn：稳定（相等键保持原始顺序）',
  sortAsc[0][1] === '10' && sortAsc[1][1] === '4',
  JSON.stringify(sortAsc.map((r) => r[1]))
)
const sortDesc = sortRowsByColumn(sortInput, 0, 'desc')
check(
  'sortRowsByColumn：降序（空值仍最后）',
  sortDesc.map((r) => r[0]).join(',') === 'date,cherry,banana,Apple,Apple,',
  JSON.stringify(sortDesc.map((r) => r[0]))
)
const sortNumAsc = sortRowsByColumn(sortInput, 1, 'asc')
check(
  'sortRowsByColumn：数值感知（2 在 10 前）且空值最后',
  sortNumAsc.map((r) => r[1]).join(',') === '1,2,3,4,10,',
  JSON.stringify(sortNumAsc.map((r) => r[1]))
)
const sortNumDesc = sortRowsByColumn(sortInput, 1, 'desc')
check(
  'sortRowsByColumn：数值降序（10,4,3,2,1）且空值最后',
  sortNumDesc.map((r) => r[1]).join(',') === '10,4,3,2,1,',
  JSON.stringify(sortNumDesc.map((r) => r[1]))
)
check(
  'sortRowsByColumn：不修改入参且返回新数组',
  sortInput[0][0] === 'banana' && sortAsc !== sortInput,
  JSON.stringify(sortInput.map((r) => r[0]))
)
check(
  'nextSortState：首次点击某列 → asc',
  JSON.stringify(nextSortState(null, 2)) === JSON.stringify({ col: 2, dir: 'asc' }),
  JSON.stringify(nextSortState(null, 2))
)
check(
  'nextSortState：同列再次点击 → desc',
  JSON.stringify(nextSortState({ col: 2, dir: 'asc' }, 2)) === JSON.stringify({ col: 2, dir: 'desc' }),
  JSON.stringify(nextSortState({ col: 2, dir: 'asc' }, 2))
)
check(
  'nextSortState：同列第三次点击回到 asc',
  JSON.stringify(nextSortState({ col: 2, dir: 'desc' }, 2)) === JSON.stringify({ col: 2, dir: 'asc' }),
  JSON.stringify(nextSortState({ col: 2, dir: 'desc' }, 2))
)
check(
  'nextSortState：切换到不同列 → 该列 asc',
  JSON.stringify(nextSortState({ col: 2, dir: 'desc' }, 0)) === JSON.stringify({ col: 0, dir: 'asc' }),
  JSON.stringify(nextSortState({ col: 2, dir: 'desc' }, 0))
)

// ---------- 技能模板预览对比：行级差异（纯函数） ----------
const dSame = lineDiff(['a', 'b'], ['a', 'b'])
check(
  'lineDiff：完全相同全部为 =',
  dSame.length === 2 && dSame.every((r) => r.type === '='),
  JSON.stringify(dSame)
)
const dChange = diffStats(lineDiff(['a', 'b'], ['a', 'c']))
check(
  'lineDiff/diffStats：一处改动的增删同计数',
  dChange.added === 1 && dChange.removed === 1 && dChange.same === 1,
  JSON.stringify(dChange)
)

// ---------- 失败原因聚合（纯函数） ----------
const fr1 = topFailReasons([
  { status: 'failed', message: '缺少附件' },
  { status: 'failed', message: '缺少附件' },
  { status: 'failed', message: '超时' },
  { status: 'done', message: '缺少附件' },
  { status: 'running', message: null }
])
check(
  'topFailReasons：重复消息分组计数、忽略非失败项、total 只计失败',
  fr1.total === 3 &&
    fr1.reasons.length === 2 &&
    fr1.reasons[0].message === '缺少附件' &&
    fr1.reasons[0].count === 2 &&
    fr1.reasons[1].message === '超时' &&
    fr1.reasons[1].count === 1,
  JSON.stringify(fr1)
)

const fr2 = topFailReasons([
  { status: 'failed', message: '   ' },
  { status: 'failed', message: null },
  { status: 'failed', message: '真实原因' }
])
check(
  'topFailReasons：空/空白消息折叠为（无信息）',
  fr2.total === 3 &&
    fr2.reasons[0].message === '（无信息）' &&
    fr2.reasons[0].count === 2 &&
    fr2.reasons[1].message === '真实原因',
  JSON.stringify(fr2)
)

const fr3 = topFailReasons(
  [
    { status: 'failed', message: 'a' },
    { status: 'failed', message: 'b' },
    { status: 'failed', message: 'c' },
    { status: 'failed', message: 'd' }
  ],
  2
)
check(
  'topFailReasons：top 截断返回但 total 仍计全部失败',
  fr3.reasons.length === 2 && fr3.total === 4 && fr3.reasons[0].message === 'a',
  JSON.stringify(fr3)
)

const fr4 = topFailReasons([
  { status: 'done', message: 'x' },
  { status: 'queued', message: 'y' }
])
check(
  'topFailReasons：无失败项返回空结构',
  fr4.reasons.length === 0 && fr4.total === 0,
  JSON.stringify(fr4)
)

const failRows = [
  { label: '文档A', status: 'failed', message: '缺少附件' },
  { label: '文档B', status: 'failed', message: '缺少附件' },
  { label: null, status: 'failed', message: '超时,重试' },
  { label: '文档C', status: 'done', message: '缺少附件' }
]
const failMd = failedItemsToMarkdown(failRows)
check(
  'failedItemsToMarkdown：含标题、Top 原因计数、每条失败项一行明细',
  failMd.includes('# 批处理失败清单') &&
    failMd.includes('## 失败原因') &&
    failMd.includes('缺少附件 ×2') &&
    failMd.includes('## 明细') &&
    failMd.includes('- 文档A：缺少附件') &&
    failMd.includes('- （未命名）：超时,重试') &&
    failMd.split('\n').filter((l) => l.startsWith('- 文档') || l.startsWith('- （')).length === 3,
  JSON.stringify(failMd)
)

const failCsv = failedItemsToCsv(failRows)
check(
  'failedItemsToCsv：表头 + 每条失败项一行，含逗号的消息加引号',
  failCsv.split('\n')[0] === '标签,失败原因' &&
    failCsv.split('\n').filter(Boolean).length === 4 &&
    failCsv.includes('"超时,重试"') &&
    failCsv.includes('文档A,缺少附件'),
  JSON.stringify(failCsv)
)

check(
  'failedItemsToMarkdown/Csv：无失败项返回空串',
  failedItemsToMarkdown([{ status: 'done', message: 'x' }]) === '' &&
    failedItemsToCsv([{ status: 'queued', message: 'y' }]) === '',
  JSON.stringify([
    failedItemsToMarkdown([{ status: 'done' }]),
    failedItemsToCsv([{ status: 'done' }])
  ])
)

// ---------- 上次查看小节的持久化键 / 解析 / 钳制（纯函数） ----------
check(
  'analysisSectionKey：包含附件 key',
  analysisSectionKey('ATT01') === 'paperdesk.analysis.lastSection.ATT01',
  analysisSectionKey('ATT01')
)
check(
  'parseSectionIndex：null/-1/x/2.5 → 0',
  parseSectionIndex(null) === 0 &&
    parseSectionIndex('-1') === 0 &&
    parseSectionIndex('x') === 0 &&
    parseSectionIndex('2.5') === 0,
  JSON.stringify([
    parseSectionIndex(null),
    parseSectionIndex('-1'),
    parseSectionIndex('x'),
    parseSectionIndex('2.5')
  ])
)
check('parseSectionIndex：3 → 3', parseSectionIndex('3') === 3, String(parseSectionIndex('3')))
check(
  'clampSectionIndex：越界/负数/空集合钳制',
  clampSectionIndex(9, 3) === 2 && clampSectionIndex(-1, 3) === 0 && clampSectionIndex(1, 0) === 0,
  JSON.stringify([clampSectionIndex(9, 3), clampSectionIndex(-1, 3), clampSectionIndex(1, 0)])
)

// ---------- 批处理作业列表筛选（filterJobs，纯函数） ----------
const jobOf = (id: number, status: string, title: string): any => ({ id, status, title })
const allJobs = [
  jobOf(1, 'queued', '翻译论文 A'),
  jobOf(2, 'scheduled', 'Export Paper B'),
  jobOf(3, 'running', '拆解论文 C'),
  jobOf(4, 'done', '翻译论文 D'),
  jobOf(5, 'failed', '翻译论文 E'),
  jobOf(6, 'cancelled', '翻译论文 F')
]
check(
  'filterJobs：active 只保留 queued/scheduled/running',
  filterJobs(allJobs, 'active', '').map((j) => j.id).join(',') === '1,2,3',
  JSON.stringify(filterJobs(allJobs, 'active', '').map((j) => j.id))
)
check(
  'filterJobs：done 精确匹配',
  filterJobs(allJobs, 'done', '').map((j) => j.id).join(',') === '4',
  JSON.stringify(filterJobs(allJobs, 'done', '').map((j) => j.id))
)
check(
  'filterJobs：failed 精确匹配',
  filterJobs(allJobs, 'failed', '').map((j) => j.id).join(',') === '5',
  JSON.stringify(filterJobs(allJobs, 'failed', '').map((j) => j.id))
)
check(
  'filterJobs：all 含 cancelled 且保持输入顺序',
  filterJobs(allJobs, 'all', '').map((j) => j.id).join(',') === '1,2,3,4,5,6',
  JSON.stringify(filterJobs(allJobs, 'all', '').map((j) => j.id))
)
check(
  'filterJobs：关键词不区分大小写',
  filterJobs(allJobs, 'all', 'export').map((j) => j.id).join(',') === '2' &&
    filterJobs(allJobs, 'all', 'EXPORT').map((j) => j.id).join(',') === '2',
  JSON.stringify(filterJobs(allJobs, 'all', 'export').map((j) => j.id))
)
check(
  'filterJobs：空/空白关键词返回全部',
  filterJobs(allJobs, 'all', '').length === 6 && filterJobs(allJobs, 'all', '   ').length === 6,
  String(filterJobs(allJobs, 'all', '   ').length)
)
check(
  'filterJobs：状态与关键词为「与」关系',
  filterJobs(allJobs, 'done', '翻译').map((j) => j.id).join(',') === '4',
  JSON.stringify(filterJobs(allJobs, 'done', '翻译').map((j) => j.id))
)
check('filterJobs：空列表返回空', filterJobs([], 'all', 'x').length === 0)

// ---------- 作业筛选持久化（parseBatchJobFilter / serializeBatchJobFilter，纯函数） ----------
const emptyFilter = JSON.stringify({ status: 'all', keyword: '' })
check(
  'parseBatchJobFilter：null / 空串 / 非法 JSON 回退默认值',
  JSON.stringify(parseBatchJobFilter(null)) === emptyFilter &&
    JSON.stringify(parseBatchJobFilter('')) === emptyFilter &&
    JSON.stringify(parseBatchJobFilter('{bad')) === emptyFilter,
  JSON.stringify([parseBatchJobFilter(null), parseBatchJobFilter(''), parseBatchJobFilter('{bad')])
)
const unknownStatus = parseBatchJobFilter(JSON.stringify({ status: 'zzz', keyword: 'x' }))
check(
  'parseBatchJobFilter：未知状态回退 all',
  unknownStatus.status === 'all' && unknownStatus.keyword === 'x',
  JSON.stringify(unknownStatus)
)
const validFilter = parseBatchJobFilter(JSON.stringify({ status: 'failed', keyword: '  翻译  ' }))
check(
  'parseBatchJobFilter：合法状态 + 关键词保留并 trim',
  validFilter.status === 'failed' && validFilter.keyword === '翻译',
  JSON.stringify(validFilter)
)
check(
  'serializeBatchJobFilter → parseBatchJobFilter 往返一致',
  JSON.stringify(parseBatchJobFilter(serializeBatchJobFilter('done', '论文'))) ===
    JSON.stringify({ status: 'done', keyword: '论文' }),
  serializeBatchJobFilter('done', '论文')
)

// ---------- 失败原因归一化与按原因筛选（纯函数） ----------
check(
  'normalizeFailMessage：trim 后空/空白/null 折叠为 NO_FAIL_MESSAGE',
  normalizeFailMessage('  ') === NO_FAIL_MESSAGE &&
    normalizeFailMessage('') === NO_FAIL_MESSAGE &&
    normalizeFailMessage(null) === NO_FAIL_MESSAGE &&
    normalizeFailMessage(undefined) === NO_FAIL_MESSAGE,
  JSON.stringify([
    normalizeFailMessage('  '),
    normalizeFailMessage(null),
    normalizeFailMessage(undefined)
  ])
)
check(
  'normalizeFailMessage：保留有效原因并去首尾空白',
  normalizeFailMessage('  超时  ') === '超时' && normalizeFailMessage('缺少附件') === '缺少附件',
  normalizeFailMessage('  超时  ')
)

// selectJobIdsByFailureReason：空原因返回全部（输入顺序）
const reasonMap: Record<number, string[]> = {
  1: ['超时', '缺少附件'],
  2: ['缺少附件'],
  3: ['网络错误']
}
check(
  'selectJobIdsByFailureReason：空/空白原因返回全部 id（保持输入顺序）',
  selectJobIdsByFailureReason([{ id: 3 }, { id: 1 }, { id: 2 }], reasonMap, '').join(',') === '3,1,2' &&
    selectJobIdsByFailureReason([{ id: 3 }, { id: 1 }, { id: 2 }], reasonMap, '   ').join(',') === '3,1,2',
  JSON.stringify([
    selectJobIdsByFailureReason([{ id: 3 }, { id: 1 }, { id: 2 }], reasonMap, ''),
    selectJobIdsByFailureReason([{ id: 3 }, { id: 1 }, { id: 2 }], reasonMap, '   ')
  ])
)
check(
  'selectJobIdsByFailureReason：精确匹配仅保留命中作业',
  selectJobIdsByFailureReason([{ id: 1 }, { id: 2 }, { id: 3 }], reasonMap, '缺少附件').join(',') === '1,2',
  JSON.stringify(selectJobIdsByFailureReason([{ id: 1 }, { id: 2 }, { id: 3 }], reasonMap, '缺少附件'))
)
check(
  'selectJobIdsByFailureReason：原因经 trim 后匹配',
  selectJobIdsByFailureReason([{ id: 1 }, { id: 2 }, { id: 3 }], reasonMap, ' 网络错误 ').join(',') === '3',
  JSON.stringify(selectJobIdsByFailureReason([{ id: 1 }, { id: 2 }, { id: 3 }], reasonMap, ' 网络错误 '))
)
check(
  'selectJobIdsByFailureReason：reasonByJob 中缺失的作业被跳过',
  selectJobIdsByFailureReason([{ id: 1 }, { id: 9 }], reasonMap, '缺少附件').join(',') === '1',
  JSON.stringify(selectJobIdsByFailureReason([{ id: 1 }, { id: 9 }], reasonMap, '缺少附件'))
)

// selectJobIdsByFailureReasons：多选筛选
check(
  'selectJobIdsByFailureReasons：空/全空白原因返回全部 id（保持输入顺序）',
  selectJobIdsByFailureReasons([{ id: 3 }, { id: 1 }, { id: 2 }], reasonMap, []).join(',') === '3,1,2' &&
    selectJobIdsByFailureReasons([{ id: 3 }, { id: 1 }, { id: 2 }], reasonMap, ['', '   ']).join(',') ===
      '3,1,2',
  JSON.stringify([
    selectJobIdsByFailureReasons([{ id: 3 }, { id: 1 }, { id: 2 }], reasonMap, []),
    selectJobIdsByFailureReasons([{ id: 3 }, { id: 1 }, { id: 2 }], reasonMap, ['', '   '])
  ])
)
check(
  'selectJobIdsByFailureReasons：命中任一选中原因即保留',
  selectJobIdsByFailureReasons([{ id: 1 }, { id: 2 }, { id: 3 }], reasonMap, ['超时', '网络错误']).join(
    ','
  ) === '1,3',
  JSON.stringify(
    selectJobIdsByFailureReasons([{ id: 1 }, { id: 2 }, { id: 3 }], reasonMap, ['超时', '网络错误'])
  )
)
check(
  'selectJobIdsByFailureReasons：均未命中的作业被丢弃',
  selectJobIdsByFailureReasons([{ id: 1 }, { id: 2 }, { id: 3 }], reasonMap, ['不存在的原因']).length ===
    0,
  JSON.stringify(
    selectJobIdsByFailureReasons([{ id: 1 }, { id: 2 }, { id: 3 }], reasonMap, ['不存在的原因'])
  )
)
check(
  'selectJobIdsByFailureReasons：原因经 trim 后匹配',
  selectJobIdsByFailureReasons([{ id: 1 }, { id: 2 }, { id: 3 }], reasonMap, [' 缺少附件 ', ' 超时 ']).join(
    ','
  ) === '1,2',
  JSON.stringify(
    selectJobIdsByFailureReasons([{ id: 1 }, { id: 2 }, { id: 3 }], reasonMap, [' 缺少附件 ', ' 超时 '])
  )
)
check(
  'selectJobIdsByFailureReasons：重复/重叠原因不产生重复 id',
  selectJobIdsByFailureReasons([{ id: 1 }, { id: 2 }, { id: 3 }], reasonMap, ['超时', '超时', '缺少附件']).join(
    ','
  ) === '1,2',
  JSON.stringify(
    selectJobIdsByFailureReasons([{ id: 1 }, { id: 2 }, { id: 3 }], reasonMap, ['超时', '超时', '缺少附件'])
  )
)

// collectFailReasonOptions：跨作业合并计数并截断 top
const rowsOf = (jobId: number, specs: Array<[string, string | null]>): {
  jobId: number
  items: any[]
} => ({
  jobId,
  items: specs.map(([status, message], i) => ({
    id: jobId * 100 + i,
    job_id: jobId,
    item_id: null,
    attachment_id: null,
    label: null,
    status,
    output: null,
    message
  }))
})
const opt = collectFailReasonOptions(
  [
    rowsOf(1, [
      ['failed', '缺少附件'],
      ['failed', '超时'],
      ['done', '缺少附件']
    ]),
    rowsOf(2, [
      ['failed', '缺少附件'],
      ['failed', '   ']
    ])
  ],
  5
)
check(
  'collectFailReasonOptions：跨作业合并计数、忽略非失败项、空消息折叠',
  opt.length === 3 &&
    opt[0].message === '缺少附件' &&
    opt[0].count === 2 &&
    opt.slice(1).some((r) => r.message === NO_FAIL_MESSAGE && r.count === 1) &&
    opt.slice(1).some((r) => r.message === '超时' && r.count === 1),
  JSON.stringify(opt)
)
const optTop = collectFailReasonOptions(
  [
    rowsOf(1, [
      ['failed', 'a'],
      ['failed', 'b'],
      ['failed', 'c'],
      ['failed', 'd']
    ])
  ],
  2
)
check(
  'collectFailReasonOptions：top 截断',
  optTop.length === 2 && optTop[0].message === 'a' && optTop[1].message === 'b',
  JSON.stringify(optTop)
)
check('collectFailReasonOptions：空输入返回空', collectFailReasonOptions([], 5).length === 0)

// ---------- 大纲「搜索小节」过滤（纯函数） ----------
const outlineEntries = [{ title: 'Alpha' }, { title: 'Beta' }, { title: 'Gamma' }]
check(
  'filterOutlineIndexes：空查询返回全部下标且保持原序',
  filterOutlineIndexes(outlineEntries, '').join(',') === '0,1,2',
  JSON.stringify(filterOutlineIndexes(outlineEntries, ''))
)
check(
  'filterOutlineIndexes：全空白查询视同空查询',
  filterOutlineIndexes(outlineEntries, '   ').join(',') === '0,1,2',
  JSON.stringify(filterOutlineIndexes(outlineEntries, '   '))
)
check(
  'filterOutlineIndexes：大小写不敏感匹配',
  filterOutlineIndexes(outlineEntries, 'BET').join(',') === '1',
  JSON.stringify(filterOutlineIndexes(outlineEntries, 'BET'))
)
check(
  'filterOutlineIndexes：无匹配返回空数组',
  filterOutlineIndexes(outlineEntries, 'zzz').length === 0,
  JSON.stringify(filterOutlineIndexes(outlineEntries, 'zzz'))
)
check(
  'filterOutlineIndexes：保留原始下标（仅第 3 项匹配 → [2]）',
  filterOutlineIndexes(outlineEntries, 'mma').join(',') === '2',
  JSON.stringify(filterOutlineIndexes(outlineEntries, 'mma'))
)


// ---------- 从链接 / DOI 导入：标识符归一化 + PDF 链接嗅探（纯函数） ----------
const doiNorm = { kind: 'doi', value: '10.1234/abc' }
check(
  'normalizeIdentifier：裸 DOI 归一化并小写',
  JSON.stringify(normalizeIdentifier('10.1234/AbC')) === JSON.stringify(doiNorm),
  JSON.stringify(normalizeIdentifier('10.1234/AbC'))
)
check(
  'normalizeIdentifier：doi: 前缀',
  JSON.stringify(normalizeIdentifier('doi: 10.1234/AbC')) === JSON.stringify(doiNorm),
  JSON.stringify(normalizeIdentifier('doi: 10.1234/AbC'))
)
check(
  'normalizeIdentifier：doi.org 链接（含 dx.）',
  JSON.stringify(normalizeIdentifier('https://doi.org/10.1234/AbC')) === JSON.stringify(doiNorm) &&
    JSON.stringify(normalizeIdentifier('https://dx.doi.org/10.1234/AbC')) === JSON.stringify(doiNorm),
  JSON.stringify(normalizeIdentifier('https://doi.org/10.1234/AbC'))
)
check(
  'normalizeIdentifier：arXiv 前缀 / abs / pdf 三种写法等价',
  JSON.stringify(normalizeIdentifier('arXiv:2101.00001')) ===
    JSON.stringify({ kind: 'arxiv', value: '2101.00001' }) &&
    JSON.stringify(normalizeIdentifier('https://arxiv.org/abs/2101.00001')) ===
      JSON.stringify({ kind: 'arxiv', value: '2101.00001' }) &&
    JSON.stringify(normalizeIdentifier('https://arxiv.org/pdf/2101.00001.pdf')) ===
      JSON.stringify({ kind: 'arxiv', value: '2101.00001' }),
  JSON.stringify([
    normalizeIdentifier('arXiv:2101.00001'),
    normalizeIdentifier('https://arxiv.org/abs/2101.00001'),
    normalizeIdentifier('https://arxiv.org/pdf/2101.00001.pdf')
  ])
)
check(
  'normalizeIdentifier：普通网址 → url',
  JSON.stringify(normalizeIdentifier('https://example.com/paper?id=1')) ===
    JSON.stringify({ kind: 'url', value: 'https://example.com/paper?id=1' }),
  JSON.stringify(normalizeIdentifier('https://example.com/paper?id=1'))
)
check(
  'normalizeIdentifier：空 / 非链接 → null',
  normalizeIdentifier('') === null &&
    normalizeIdentifier('   ') === null &&
    normalizeIdentifier('不是链接') === null,
  JSON.stringify([normalizeIdentifier(''), normalizeIdentifier('不是链接')])
)

const metaNameFirst = extractPdfLinks(
  '<meta name="citation_pdf_url" content="/files/a.pdf">',
  'https://journal.org/article/1'
)
check(
  'extractPdfLinks：citation_pdf_url（name 在前）并解析相对路径',
  metaNameFirst.length === 1 && metaNameFirst[0] === 'https://journal.org/files/a.pdf',
  JSON.stringify(metaNameFirst)
)
const metaContentFirst = extractPdfLinks(
  '<meta content="https://cdn.org/b.pdf" name="citation_pdf_url">',
  'https://journal.org/article/1'
)
check(
  'extractPdfLinks：citation_pdf_url（content 在前）',
  metaContentFirst.length === 1 && metaContentFirst[0] === 'https://cdn.org/b.pdf',
  JSON.stringify(metaContentFirst)
)
const linkAlt = extractPdfLinks(
  '<link rel="alternate" type="application/pdf" href="x.pdf">',
  'https://journal.org/a/b/'
)
check(
  'extractPdfLinks：link alternate 相对 href 相对 base 解析',
  linkAlt.length === 1 && linkAlt[0] === 'https://journal.org/a/b/x.pdf',
  JSON.stringify(linkAlt)
)
const dedup = extractPdfLinks(
  [
    '<meta name="citation_pdf_url" content="https://x.org/p.pdf">',
    '<a href="https://x.org/p.pdf">重复</a>',
    '<a href="https://x.org/other.pdf?download=1">另一个（带 query，仍识别为 PDF）</a>',
    '<a href="https://x.org/page.html">非 PDF</a>'
  ].join('\n'),
  'https://x.org/'
)
check(
  'extractPdfLinks：去重且忽略非 PDF，保持优先级顺序',
  dedup.length === 2 &&
    dedup[0] === 'https://x.org/p.pdf' &&
    dedup[1] === 'https://x.org/other.pdf?download=1',
  JSON.stringify(dedup)
)
check(
  'extractPdfLinks：无 PDF 时返回空数组',
  extractPdfLinks('<html><body><a href="/x.html">hi</a></body></html>', 'https://x.org/')
    .length === 0 &&
    extractPdfLinks('', 'https://x.org/').length === 0,
  JSON.stringify(extractPdfLinks('<a href="/x.html">hi</a>', 'https://x.org/'))
)

// ---------- 批量导入：输入切分（parseBulkInput，纯函数） ----------
check(
  'parseBulkInput：按换行/逗号/分号切分',
  JSON.stringify(parseBulkInput('a\nb,c;d')) === JSON.stringify(['a', 'b', 'c', 'd']),
  JSON.stringify(parseBulkInput('a\nb,c;d'))
)
check(
  'parseBulkInput：trim 并丢弃空项',
  JSON.stringify(parseBulkInput('  a  \n\n  , ;\t b \n')) === JSON.stringify(['a', 'b']),
  JSON.stringify(parseBulkInput('  a  \n\n  , ;\t b \n'))
)
check(
  'parseBulkInput：丢弃 # 注释行',
  JSON.stringify(parseBulkInput('# 注释\n10.1/x\n  # 另一注释\nz')) ===
    JSON.stringify(['10.1/x', 'z']),
  JSON.stringify(parseBulkInput('# 注释\n10.1/x\n  # 另一注释\nz'))
)
check(
  'parseBulkInput：去重且保留首次出现顺序',
  JSON.stringify(parseBulkInput('b\na\nb\nc\na')) === JSON.stringify(['b', 'a', 'c']),
  JSON.stringify(parseBulkInput('b\na\nb\nc\na'))
)
check(
  'parseBulkInput：不按空格切分（DOI 可含空格外的连续串）',
  JSON.stringify(parseBulkInput('10.1/a 10.1/b')) === JSON.stringify(['10.1/a 10.1/b']),
  JSON.stringify(parseBulkInput('10.1/a 10.1/b'))
)
check(
  'parseBulkInput：空 / 纯空白 / 纯注释 → 空数组',
  parseBulkInput('').length === 0 &&
    parseBulkInput('   \n\t').length === 0 &&
    parseBulkInput('# x\n# y').length === 0,
  JSON.stringify([
    parseBulkInput(''),
    parseBulkInput('   \n\t'),
    parseBulkInput('# x\n# y')
  ])
)

// ---------- 文献网络（合著 / 关键词共现 / 聚类 / 取前 N 子图） ----------
const co = buildCoAuthorGraph([
  { itemId: 1, authorId: 1, name: 'A' },
  { itemId: 1, authorId: 2, name: 'B' },
  { itemId: 2, authorId: 1, name: 'A' }
])
const coN1 = co.nodes.find((n) => n.id === 'a1')
const coN2 = co.nodes.find((n) => n.id === 'a2')
check(
  'buildCoAuthorGraph：节点 id/权重（a1 出现 2 篇、a2 出现 1 篇）',
  !!coN1 && !!coN2 && coN1.weight === 2 && coN2.weight === 1 && co.kind === 'authors',
  JSON.stringify(co.nodes)
)
check(
  'buildCoAuthorGraph：共现边无向且权重=同篇次数（A-B=1）',
  co.edges.length === 1 &&
    co.edges[0].source === 'a1' &&
    co.edges[0].target === 'a2' &&
    co.edges[0].weight === 1 &&
    co.edges.every((e) => e.source < e.target && e.source !== e.target),
  JSON.stringify(co.edges)
)

const co2 = buildCoAuthorGraph([
  { itemId: 1, authorId: 1, name: 'A' },
  { itemId: 1, authorId: 2, name: 'B' },
  { itemId: 2, authorId: 1, name: 'A' },
  { itemId: 2, authorId: 2, name: 'B' }
])
check(
  'buildCoAuthorGraph：两篇共同出现 → 边权重 2',
  co2.edges.length === 1 && co2.edges[0].weight === 2,
  JSON.stringify(co2.edges)
)

const kw = buildKeywordGraph([
  { itemId: 1, tagId: 5, name: 'ML' },
  { itemId: 1, tagId: 6, name: 'NLP' },
  { itemId: 2, tagId: 5, name: 'ML' }
])
const kwN5 = kw.nodes.find((n) => n.id === 't5')
const kwN6 = kw.nodes.find((n) => n.id === 't6')
check(
  'buildKeywordGraph：节点权重与标签（t5=2, t6=1）',
  kw.kind === 'keywords' && !!kwN5 && !!kwN6 && kwN5.weight === 2 && kwN6.weight === 1,
  JSON.stringify(kw.nodes)
)
check(
  'buildKeywordGraph：共现边 t5-t6 权重 1',
  kw.edges.length === 1 &&
    kw.edges[0].source === 't5' &&
    kw.edges[0].target === 't6' &&
    kw.edges[0].weight === 1,
  JSON.stringify(kw.edges)
)

// 两个不相连的三角形 → 恰好 2 个聚类（且稠密化为 0/1）
const triEdges = [
  { source: 'a1', target: 'a2', weight: 1 },
  { source: 'a2', target: 'a3', weight: 1 },
  { source: 'a1', target: 'a3', weight: 1 },
  { source: 'a4', target: 'a5', weight: 1 },
  { source: 'a5', target: 'a6', weight: 1 },
  { source: 'a4', target: 'a6', weight: 1 }
]
const triCl = clusterByLabelPropagation(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], triEdges)
check(
  'clusterByLabelPropagation：两个连通分量 → 2 个聚类（0/1）',
  new Set(Object.values(triCl)).size === 2 &&
    triCl.a1 === triCl.a2 &&
    triCl.a2 === triCl.a3 &&
    triCl.a4 === triCl.a5 &&
    triCl.a5 === triCl.a6 &&
    triCl.a1 !== triCl.a4 &&
    new Set(Object.values(triCl)).has(0) &&
    new Set(Object.values(triCl)).has(1),
  JSON.stringify(triCl)
)
check(
  'clusterByLabelPropagation：孤立节点各自成为独立聚类',
  (() => {
    const iso = clusterByLabelPropagation(['a1', 'a2', 'a3'], [])
    return new Set(Object.values(iso)).size === 3
  })(),
  ''
)

const big = buildCoAuthorGraph([
  { itemId: 1, authorId: 1, name: 'A' },
  { itemId: 1, authorId: 2, name: 'B' },
  { itemId: 1, authorId: 3, name: 'C' },
  { itemId: 2, authorId: 1, name: 'A' },
  { itemId: 2, authorId: 2, name: 'B' },
  { itemId: 3, authorId: 1, name: 'A' }
])
const top2 = topSubgraph(big, 2)
check(
  'topSubgraph：保留权重最高的 2 个节点并丢弃相关边',
  top2.nodes.length === 2 &&
    top2.nodes.map((n) => n.id).join(',') === 'a1,a2' &&
    top2.edges.length === 1 &&
    top2.edges[0].source === 'a1' &&
    top2.edges[0].target === 'a2',
  JSON.stringify({ nodes: top2.nodes, edges: top2.edges })
)
check(
  'topSubgraph：保留节点重新聚类并给出聚类数',
  top2.clusters === 1 && top2.nodes.every((n) => n.cluster === 0),
  JSON.stringify({ clusters: top2.clusters, nodes: top2.nodes })
)
const top1 = topSubgraph(big, 1)
check(
  'topSubgraph：仅保留 1 个节点 → 无边、各自成簇',
  top1.nodes.length === 1 && top1.edges.length === 0 && top1.clusters === 1,
  JSON.stringify({ n: top1.nodes.length, e: top1.edges.length, c: top1.clusters })
)
check(
  'topSubgraph：空图返回空结构',
  (() => {
    const empty = topSubgraph(buildCoAuthorGraph([]), 10)
    return empty.nodes.length === 0 && empty.edges.length === 0 && empty.clusters === 0
  })(),
  ''
)

// ---------- 文献耦合 / 共被引 / VOS 式布局 ----------
const cpl = buildCouplingGraph([
  { itemId: 1, itemTitle: 'P1', refKey: 'w1' },
  { itemId: 1, itemTitle: 'P1', refKey: 'w2' },
  { itemId: 2, itemTitle: 'P2', refKey: 'w1' },
  { itemId: 2, itemTitle: 'P2', refKey: 'w3' },
  { itemId: 3, itemTitle: 'P3', refKey: 'w9' }
])
const cplN1 = cpl.nodes.find((n) => n.id === 'i1')
const cplN2 = cpl.nodes.find((n) => n.id === 'i2')
check(
  'buildCouplingGraph：节点权重=不同参考文献数（i1=2/i2=2）且携带 itemId',
  cpl.kind === 'coupling' &&
    !!cplN1 &&
    !!cplN2 &&
    cplN1.weight === 2 &&
    cplN2.weight === 2 &&
    cplN1.itemId === 1 &&
    cplN2.itemId === 2,
  JSON.stringify(cpl.nodes)
)
check(
  'buildCouplingGraph：共享 1 篇参考文献 → 边权重 1（无向、无自环）',
  cpl.edges.length === 1 &&
    cpl.edges[0].source === 'i1' &&
    cpl.edges[0].target === 'i2' &&
    cpl.edges[0].weight === 1 &&
    cpl.edges.every((e) => e.source < e.target && e.source !== e.target),
  JSON.stringify(cpl.edges)
)
const cpl2 = buildCouplingGraph([
  { itemId: 1, itemTitle: 'P1', refKey: 'w1' },
  { itemId: 1, itemTitle: 'P1', refKey: 'w2' },
  { itemId: 2, itemTitle: 'P2', refKey: 'w1' },
  { itemId: 2, itemTitle: 'P2', refKey: 'w2' }
])
check(
  'buildCouplingGraph：共享 2 篇 → 边权重 2',
  cpl2.edges.length === 1 && cpl2.edges[0].weight === 2,
  JSON.stringify(cpl2.edges)
)

const coc = buildCoCitationGraph([
  { itemId: 1, refKey: 'w1', refLabel: 'Ref A' },
  { itemId: 1, refKey: 'w2', refLabel: 'Ref B' },
  { itemId: 2, refKey: 'w1', refLabel: 'Ref A' }
])
const cocN1 = coc.nodes.find((n) => n.id === 'rw1')
const cocN2 = coc.nodes.find((n) => n.id === 'rw2')
check(
  'buildCoCitationGraph：节点权重=引用论文数（rw1=2/rw2=1），itemId 未设置',
  coc.kind === 'cocitation' &&
    !!cocN1 &&
    !!cocN2 &&
    cocN1.weight === 2 &&
    cocN2.weight === 1 &&
    cocN1.itemId == null &&
    cocN2.itemId == null,
  JSON.stringify(coc.nodes)
)
check(
  'buildCoCitationGraph：同一论文共引两篇 → 边权重 1',
  coc.edges.length === 1 &&
    coc.edges[0].source === 'rw1' &&
    coc.edges[0].target === 'rw2' &&
    coc.edges[0].weight === 1,
  JSON.stringify(coc.edges)
)

const layoutNodes = [
  { id: 'n1', weight: 2 },
  { id: 'n2', weight: 2 },
  { id: 'n3', weight: 1 },
  { id: 'n4', weight: 1 },
  { id: 'n5', weight: 1 },
  { id: 'n6', weight: 1 }
]
const layoutEdges = [
  { source: 'n1', target: 'n2', weight: 3 },
  { source: 'n2', target: 'n3', weight: 2 }
]
const LAYOUT_W = 200
const LAYOUT_H = 200
const L1 = vosLayout(layoutNodes, layoutEdges, { width: LAYOUT_W, height: LAYOUT_H })
const L2 = vosLayout(layoutNodes, layoutEdges, { width: LAYOUT_W, height: LAYOUT_H })
check(
  'vosLayout：确定性（两次调用结果完全一致，无随机）',
  JSON.stringify(L1) === JSON.stringify(L2),
  ''
)
check(
  'vosLayout：所有坐标有限且落在 [0,width]×[0,height]',
  Object.values(L1).every(
    (p) =>
      Number.isFinite(p.x) &&
      Number.isFinite(p.y) &&
      p.x >= 0 &&
      p.x <= LAYOUT_W &&
      p.y >= 0 &&
      p.y <= LAYOUT_H
  ),
  JSON.stringify(L1)
)
check(
  'vosLayout：相连节点比未连节点更近（平均距离，松散校验）',
  (() => {
    const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
      Math.hypot(a.x - b.x, a.y - b.y)
    const connected = new Set(layoutEdges.map((e) => `${e.source}\u0000${e.target}`))
    let edgeSum = 0
    for (const e of layoutEdges) edgeSum += dist(L1[e.source], L1[e.target])
    const avgEdge = edgeSum / layoutEdges.length
    let unSum = 0
    let unCnt = 0
    for (let i = 0; i < layoutNodes.length; i++) {
      for (let j = i + 1; j < layoutNodes.length; j++) {
        const a = layoutNodes[i].id
        const b = layoutNodes[j].id
        if (connected.has(`${a}\u0000${b}`) || connected.has(`${b}\u0000${a}`)) continue
        unSum += dist(L1[a], L1[b])
        unCnt++
      }
    }
    const avgUn = unCnt > 0 ? unSum / unCnt : 0
    return unCnt > 0 && avgEdge < avgUn
  })(),
  JSON.stringify(L1)
)

// ---------- 文献网络导出（Pajek / GEXF，纯函数） ----------
const exportGraph: BiblioGraph = {
  kind: 'authors',
  nodes: [
    { id: 'a1', label: 'A & <B>', weight: 2, cluster: 0 },
    { id: 'a2', label: 'B', weight: 1, cluster: 0 }
  ],
  edges: [{ source: 'a1', target: 'a2', weight: 3 }],
  clusters: 1
}
const net = toPajek(exportGraph)
check(
  'toPajek：含 *Vertices N 与各节点标签',
  net.includes('*Vertices 2') && net.includes('"A & <B>"') && net.includes('"B"'),
  net
)
check('toPajek：*Edges 行含「1 2 权重」', /\*Edges\b/.test(net) && net.includes('1 2 3'), net)
const netQuoted = toPajek({
  kind: 'authors',
  nodes: [{ id: 'a1', label: 'He said "hi"', weight: 1, cluster: 0 }],
  edges: [],
  clusters: 1
})
check('toPajek：双引号转义为 \\"', netQuoted.includes('"He said \\"hi\\""'), netQuoted)

const gexf = toGexf(exportGraph)
check(
  'toGexf：含 <gexf 根与每个 <node id=',
  gexf.includes('<gexf') && gexf.includes('<node id="a1"') && gexf.includes('<node id="a2"'),
  gexf
)
check(
  'toGexf：含 <edge source= 与权重',
  gexf.includes('<edge source="a1"') && gexf.includes('target="a2"') && gexf.includes('weight="3"'),
  gexf
)
check(
  'toGexf：标签中的 & 与 < 被转义',
  gexf.includes('A &amp; &lt;B&gt;') && !gexf.includes('& <B>'),
  gexf
)

const emptyGraph: BiblioGraph = { kind: 'authors', nodes: [], edges: [], clusters: 0 }
const netEmpty = toPajek(emptyGraph)
check('toPajek：空图输出含 *Vertices 0', netEmpty.includes('*Vertices 0'), netEmpty)
const gexfEmpty = toGexf(emptyGraph)
check(
  'toGexf：空图仍是良构（含 <gexf/<nodes>/<edges>）',
  gexfEmpty.includes('<gexf') && gexfEmpty.includes('<nodes>') && gexfEmpty.includes('<edges>'),
  gexfEmpty
)

// ---------- 每篇文档阅读状态（doc-state，纯函数） ----------
check(
  'docStateKey：包含条目 id',
  docStateKey(42) === 'paperdesk.doc.42' && docStateKey(7).startsWith('paperdesk.doc.'),
  docStateKey(42)
)
check(
  'parseDocState：null / 空串 / 非法 JSON / 非对象 → {}',
  JSON.stringify(parseDocState(null)) === '{}' &&
    JSON.stringify(parseDocState('')) === '{}' &&
    JSON.stringify(parseDocState('{bad')) === '{}' &&
    JSON.stringify(parseDocState('[]')) === '{}' &&
    JSON.stringify(parseDocState('"x"')) === '{}',
  JSON.stringify([
    parseDocState(null),
    parseDocState(''),
    parseDocState('{bad'),
    parseDocState('[]'),
    parseDocState('"x"')
  ])
)
check(
  'parseDocState：忽略类型不符的字段',
  JSON.stringify(parseDocState('{"page":"3","scale":"x","rcCollapsed":"yes","viewMode":1}')) === '{}',
  parseDocState('{"page":"3","scale":"x","rcCollapsed":"yes","viewMode":1}').constructor.name
)
const dsSample = {
  attachmentId: 12,
  viewMode: 'split',
  page: 4,
  scale: 1.35,
  zoomFit: false,
  rcCollapsed: true
}
check(
  'serializeDocState → parseDocState 往返一致',
  JSON.stringify(parseDocState(serializeDocState(dsSample))) === JSON.stringify(dsSample),
  serializeDocState(dsSample)
)
check(
  'parseDocState：保留 null 缩放与合法布尔',
  (() => {
    const s = parseDocState('{"scale":null,"rcCollapsed":false,"page":2}')
    return s.scale === null && s.rcCollapsed === false && s.page === 2
  })(),
  ''
)
check(
  'mergeDocState：局部补丁保留其余字段',
  (() => {
    const m = mergeDocState({ page: 3, scale: 1.2, viewMode: 'pdf' }, { page: 5 })
    return m.page === 5 && m.scale === 1.2 && m.viewMode === 'pdf'
  })(),
  ''
)
check(
  'mergeDocState：不修改入参且显式 undefined 不覆盖',
  (() => {
    const prev = { page: 3, viewMode: 'html' as const }
    const m = mergeDocState(prev, { page: undefined, rcCollapsed: true })
    return prev.page === 3 && m.page === 3 && m.viewMode === 'html' && m.rcCollapsed === true
  })(),
  ''
)
check(
  'mergeDocState：空补丁返回等价副本',
  (() => {
    const prev = { page: 1 }
    const m = mergeDocState(prev, {})
    return m.page === 1 && m !== prev
  })(),
  ''
)

// ---------- 译文选择（pickTranslation，纯函数） ----------
const tCached = { id: 1 } as Translation
const tFetched = { id: 2 } as Translation
check('pickTranslation：缓存 + 查询 → 用查询结果', pickTranslation(tCached, tFetched) === tFetched)
check('pickTranslation：仅查询 → 用查询结果', pickTranslation(null, tFetched) === tFetched)
check('pickTranslation：仅缓存 → 回退缓存', pickTranslation(tCached, null) === tCached)
check('pickTranslation：都为空 → null', pickTranslation(null, null) === null)

// ---------- Zotero 连接器：令牌校验 / 请求体解析（纯函数） ----------
check('checkToken：匹配返回 true', checkToken('abc', 'abc') === true)
check(
  'checkToken：不匹配 / 空输入 / 空期望 → false',
  checkToken('abc', 'abd') === false &&
    checkToken('', 'abc') === false &&
    checkToken(null, 'abc') === false &&
    checkToken('abc', '') === false &&
    checkToken('abc', '  ') === false,
  JSON.stringify([
    checkToken('abc', 'abd'),
    checkToken('', 'abc'),
    checkToken(null, 'abc'),
    checkToken('abc', '')
  ])
)

const piUrl = parseImportRequest({ url: 'http://x/y.pdf' })
check(
  'parseImportRequest：{url} → input',
  'input' in piUrl && piUrl.input === 'http://x/y.pdf',
  JSON.stringify(piUrl)
)
const piDoi = parseImportRequest({ doi: '10.1/x' })
check(
  'parseImportRequest：{doi} → input（原样）',
  'input' in piDoi && piDoi.input === '10.1/x',
  JSON.stringify(piDoi)
)
const piTrim = parseImportRequest({ url: '  http://x/y.pdf  ' })
check(
  'parseImportRequest：输入 trim',
  'input' in piTrim && piTrim.input === 'http://x/y.pdf',
  JSON.stringify(piTrim)
)
check(
  'parseImportRequest：{} / 空对象 → error',
  'error' in parseImportRequest({}) && 'error' in parseImportRequest(Object.create(null)),
  JSON.stringify([parseImportRequest({})])
)
check(
  'parseImportRequest：非对象 → error',
  'error' in parseImportRequest(null) &&
    'error' in parseImportRequest('http://x/y.pdf') &&
    'error' in parseImportRequest(42) &&
    'error' in parseImportRequest([{ url: 'x' }]),
  JSON.stringify([parseImportRequest(null), parseImportRequest([1])])
)
check(
  'parseImportRequest：字段类型非法 → error',
  'error' in parseImportRequest({ url: 123 }) &&
    'error' in parseImportRequest({ doi: { a: 1 } }) &&
    'error' in parseImportRequest({ url: '' }) &&
    'error' in parseImportRequest({ url: '   ' }),
  JSON.stringify([parseImportRequest({ url: 123 }), parseImportRequest({ url: '' })])
)
check(
  'parseImportRequest：超长输入 → error',
  'error' in parseImportRequest({ url: 'a'.repeat(3000) }),
  JSON.stringify(parseImportRequest({ url: 'a'.repeat(3000) }))
)

// ---- figureCropRegion：多子图合并 + 不吞远处图形 ----
{
  const cap: [number, number, number, number] = [60, 300, 300, 310] // 题注（底边原点，y 向上）
  const regions: Array<[number, number, number, number]> = [
    [70, 320, 280, 420], // 下子图
    [70, 425, 280, 540], // 上子图（与下子图仅隔 5pt）
    [70, 700, 280, 760] // 同页另一处图形（远离题注，不应被合并）
  ]
  const r = figureCropRegion(regions, cap, 600, 800, 20)
  check(
    'figureCropRegion：合并相邻多子图（不吞远处图形）',
    r[1] <= 320 && r[3] >= 540 && r[3] < 700,
    JSON.stringify(r)
  )
  const r2 = figureCropRegion([], cap, 600, 800, 20, 520)
  check(
    'figureCropRegion：无矢量区域时回退到题注上方',
    r2[1] <= 310 && r2[3] === 520,
    JSON.stringify(r2)
  )
  // 传入 capBottom（图注块下边界）→ 裁剪区域应包含题注文字
  const r3 = figureCropRegion(regions, cap, 600, 800, 20, undefined, 280)
  check('figureCropRegion：capBottom 让区域包含图注', r3[1] <= 280, JSON.stringify(r3))
  const r4 = figureCropRegion([], cap, 600, 800, 20, 520, 280)
  check('figureCropRegion：回退路径也包含图注', r4[1] <= 280 && r4[3] === 520, JSON.stringify(r4))
}

// ---- parseRefNums：引用编号解析（单篇 / 连续 / 多个）----check('parseRefNums：单篇 [1]', JSON.stringify(parseRefNums('1')) === '[1]', JSON.stringify(parseRefNums('1')))
check(
  'parseRefNums：连续 [1-3]',
  JSON.stringify(parseRefNums('1-3')) === '[1,2,3]',
  JSON.stringify(parseRefNums('1-3'))
)
check(
  'parseRefNums：多个 [1, 3, 5]',
  JSON.stringify(parseRefNums('1, 3, 5')) === '[1,3,5]',
  JSON.stringify(parseRefNums('1, 3, 5'))
)
check(
  'parseRefNums：混合 [1-2, 5] 且去重',
  JSON.stringify(parseRefNums('1-2, 5, 5')) === '[1,2,5]',
  JSON.stringify(parseRefNums('1-2, 5, 5'))
)

// ---- 结构化模块：题注按类型消歧 / 参考文献按编号选择 ----
{
  const caps: Array<{
    n: number
    letter: string
    kind: 'figure' | 'table'
    page: number
    rect: [number, number, number, number]
  }> = [
    { n: 1, letter: '', kind: 'figure', page: 3, rect: [50, 400, 300, 412] },
    { n: 1, letter: '', kind: 'table', page: 5, rect: [50, 300, 300, 312] },
    { n: 2, letter: 'a', kind: 'figure', page: 7, rect: [50, 200, 300, 212] },
    { n: 2, letter: 'b', kind: 'figure', page: 7, rect: [320, 200, 560, 212] }
  ]
  check(
    'pickCaptionModule：引用 Table 1 只命中表格（不命中 Figure 1）',
    pickCaptionModule(caps, 1, '', 'table')?.page === 5,
    JSON.stringify(pickCaptionModule(caps, 1, '', 'table'))
  )
  check(
    'pickCaptionModule：引用 Figure 1 只命中图',
    pickCaptionModule(caps, 1, '', 'figure')?.page === 3,
    JSON.stringify(pickCaptionModule(caps, 1, '', 'figure'))
  )
  check(
    'pickCaptionModule：带字母 2b 命中对应子图',
    pickCaptionModule(caps, 2, 'b', 'figure')?.rect[0] === 320,
    JSON.stringify(pickCaptionModule(caps, 2, 'b', 'figure'))
  )
  check(
    'pickCaptionModule：字母不匹配时退化为同编号同类型',
    pickCaptionModule(caps, 2, 'z', 'figure')?.n === 2,
    JSON.stringify(pickCaptionModule(caps, 2, 'z', 'figure'))
  )
  check('pickCaptionModule：找不到返回 null', pickCaptionModule(caps, 9, '', 'any') === null)

  const refs = [
    { n: 1, page: 9, text: '[1] A. One', rect: [50, 100, 300, 112] },
    { n: 3, page: 9, text: '[3] C. Three', rect: [50, 130, 300, 142] },
    { n: 5, page: 10, text: '[5] E. Five', rect: [50, 160, 300, 172] }
  ]
  const picked = pickRefModules(refs, [1, 3, 5])
  check('pickRefModules：按顺序返回多篇', picked.length === 3 && picked[2].n === 5, JSON.stringify(picked))
  check(
    'pickRefModules：缺项跳过（不猜测）',
    pickRefModules(refs, [1, 2, 5]).map((r) => r.n).join(',') === '1,5',
    JSON.stringify(pickRefModules(refs, [1, 2, 5]))
  )
  check(
    'pickRefModules：去重',
    pickRefModules(refs, [1, 1, 3]).map((r) => r.n).join(',') === '1,3',
    JSON.stringify(pickRefModules(refs, [1, 1, 3]))
  )
}

// ---- 聊天 Markdown 渲染（问答气泡）----
{
  const h1 = chatMarkdownToHtml('**粗体** 与 *斜体* 和 `code`')
  check(
    'chatMd：粗体/斜体/行内 code',
    h1.includes('<strong>粗体</strong>') && h1.includes('<em>斜体</em>') && h1.includes('<code>code</code>'),
    h1
  )
  const h2 = chatMarkdownToHtml('- 甲\n- 乙')
  check('chatMd：无序列表', h2.includes('<ul><li>甲</li><li>乙</li></ul>'), h2)
  const h3 = chatMarkdownToHtml('1. 一\n2. 二')
  check('chatMd：有序列表', h3.includes('<ol><li>一</li><li>二</li></ol>'), h3)
  const h4 = chatMarkdownToHtml('## 小标题')
  check('chatMd：标题层级降级', h4.includes('<h4>小标题</h4>'), h4)
  const h5 = chatMarkdownToHtml('结论见 [1] 与 [1,3]。')
  check('chatMd：行内引用标记变小号 span', (h5.match(/cite-mark/g) ?? []).length === 2, h5)
  const h6 = chatMarkdownToHtml('<script>alert(1)</script>')
  check('chatMd：HTML 先转义（防注入）', !h6.includes('<script>') && h6.includes('&lt;script&gt;'), h6)
  const h7 = chatMarkdownToHtml('a\n\nb')
  check('chatMd：段落拆分', (h7.match(/<p>/g) ?? []).length === 2, h7)
}

// ---- 命中块 → 结构化模块映射（问答引用与预览/跳转共用同一套定位）----
{
  const mods = [
    { id: 'p2-t1', type: 'paragraph' as const, page: 2, column: 0, rect: [50, 600, 550, 640] as [number, number, number, number], text: 'We propose a deep learning approach for temporal transportation network dismantling.' },
    { id: 'p2-g0', type: 'figure' as const, page: 2, column: 0, rect: [50, 300, 550, 580] as [number, number, number, number], text: '' },
    { id: 'p3-t2', type: 'paragraph' as const, page: 3, column: 1, rect: [320, 400, 560, 430] as [number, number, number, number], text: 'Another paragraph on a different page entirely.' }
  ]
  const m1 = matchChunkToModule(
    mods,
    2,
    'We propose a deep learning approach for temporal transportation network dismantling. Then more text.'
  )
  check('matchChunkToModule：命中同页模块', m1?.id === 'p2-t1', JSON.stringify(m1))
  check(
    'matchChunkToModule：返回模块矩形（供精确高亮）',
    !!m1 && m1.rect[0] === 50 && m1.rect[1] === 600,
    JSON.stringify(m1?.rect)
  )
  check(
    'matchChunkToModule：不跨页误配',
    matchChunkToModule(mods, 2, 'Another paragraph on a different page entirely.') === null,
    'cross-page'
  )
  check(
    'matchChunkToModule：不可靠时不返回（不猜位置）',
    matchChunkToModule(mods, 2, 'zzz totally unrelated content here') === null,
    'unrelated'
  )
  check(
    'matchChunkToModule：跳过无正文的图形模块',
    matchChunkToModule(mods, 2, 'figure caption text') === null,
    'figure'
  )
  // 跨多个模块时：按阅读顺序（栏 → 从上到下）返回，跳转落在段首
  const multi = matchChunkToModules(
    [
      { id: 'p4-t9', type: 'paragraph' as const, page: 4, column: 1, rect: [320, 500, 560, 530] as [number, number, number, number], text: 'AAA BBB CCC shared passage text goes here for overlap testing' },
      { id: 'p4-t1', type: 'paragraph' as const, page: 4, column: 0, rect: [50, 500, 280, 530] as [number, number, number, number], text: 'AAA BBB CCC shared passage text goes here for overlap testing' },
      { id: 'p4-t5', type: 'paragraph' as const, page: 4, column: 0, rect: [50, 700, 280, 730] as [number, number, number, number], text: 'AAA BBB CCC shared passage text goes here for overlap testing' }
    ],
    4,
    'AAA BBB CCC shared passage text goes here for overlap testing'
  )
  check(
    'matchChunkToModules：跨多模块按阅读顺序返回（左栏在上者优先）',
    multi.length === 3 && multi[0].id === 'p4-t5' && multi[1].id === 'p4-t1' && multi[2].id === 'p4-t9',
    JSON.stringify(multi.map((m) => m.id))
  )

  // 结构性提问：图 3 / Table 2 / [1,3] / 公式 (5)
  const sr = detectStructuralRefs('请比较图 3 与 Table 2，并解释公式 (5)，参考 [1,3] 与 [7-8]')
  check(
    'detectStructuralRefs：识别图/表（含类型）',
    sr.figures.length === 2 &&
      sr.figures[0].kind === 'figure' &&
      sr.figures[0].n === 3 &&
      sr.figures[1].kind === 'table' &&
      sr.figures[1].n === 2,
    JSON.stringify(sr.figures)
  )
  check(
    'detectStructuralRefs：识别引用编号（展开区间）',
    JSON.stringify(sr.refs) === '[1,3,7,8]',
    JSON.stringify(sr.refs)
  )
  check('detectStructuralRefs：识别公式编号', JSON.stringify(sr.formulas) === '["5"]', JSON.stringify(sr.formulas))
  check(
    'detectStructuralRefs：普通提问不误报',
    (() => {
      const x = detectStructuralRefs('这篇论文的主要贡献是什么？')
      return x.figures.length === 0 && x.refs.length === 0 && x.formulas.length === 0
    })(),
    JSON.stringify(detectStructuralRefs('这篇论文的主要贡献是什么？'))
  )
}

// ---- 引用解析（三步式）：类型识别 → 编号解析 → 目标匹配 ----
{
  const t1 = recognizeCiteTypes('见 Fig. 3 与 Table 2、公式 (2.1a)、参考文献 [4]')
  check(
    'recognizeCiteTypes：识别图/表/公式/文献别名',
    t1.map((x) => x.kind).join(',') === 'figure,table,equation,reference',
    JSON.stringify(t1)
  )
  const n1 = parseCiteNumber('S3')
  check('parseCiteNumber：补充材料 S3', !!n1 && n1.main === 'S3' && n1.supplementary, JSON.stringify(n1))
  const n2 = parseCiteNumber('(2.1a)')
  check('parseCiteNumber：括号 + 字母后缀 2.1a', !!n2 && n2.main === '2.1' && n2.letters[0] === 'a', JSON.stringify(n2))
  const n3 = parseCiteNumber('3–5')
  check('parseCiteNumber：区间 3–5', !!n3 && n3.start === 3 && n3.end === 5, JSON.stringify(n3))
  check(
    'expandCiteNumbers：区间展开',
    n3 ? expandCiteNumbers(n3).map((x) => x.main).join(',') === '3,4,5' : false
  )
  const n4 = parseCiteNumber('2a,b')
  check('parseCiteNumber：多字母 2a,b', !!n4 && n4.main === '2' && n4.letters.join(',') === 'a,b', JSON.stringify(n4))
  check('parseCiteNumber：非编号返回 null', parseCiteNumber('结论') === null)

  const parsed = parseCitations('比较 Fig. S3 与 Table 2，参考 [1,3] 与 [7-8]')
  const refNums = parsed
    .filter((p) => p.kind === 'reference')
    .flatMap((p) => expandCiteNumbers(p.number).map((x) => x.main))
  check(
    'parseCitations：含补充材料图 + 表 + 方括号文献（区间展开）',
    parsed.some((p) => p.kind === 'figure' && p.number.supplementary) &&
      parsed.some((p) => p.kind === 'table' && p.number.main === '2') &&
      refNums.join(',') === '1,3,7,8',
    JSON.stringify({ all: parsed.map((p) => `${p.kind}:${p.number.main}`), refNums })
  )

  // 步骤 3：目标匹配（补充材料编号不应误配普通图；字母后缀要匹配到对应子图）
  const doc = {
    captions: [
      { page: 3, n: 2, letter: '', kind: 'table' as const, rect: [50, 300, 300, 312] as [number, number, number, number], captionId: 'p3-t1', figureId: 'p3-g0', figureRect: [50, 100, 300, 290] as [number, number, number, number] },
      { page: 7, n: 2, letter: 'a', kind: 'figure' as const, rect: [50, 200, 300, 212] as [number, number, number, number], captionId: 'p7-t1', figureId: 'p7-g0', figureRect: [50, 100, 300, 190] as [number, number, number, number] }
    ],
    refs: [{ n: 3, page: 9, text: '[3] C. Three', rect: [50, 130, 300, 142] as [number, number, number, number], id: 'p9-t3' }],
    formulas: [],
    modules: [{ id: 'p3-t1', text: 'Table 2. Results' }, { id: 'p7-t1', text: 'Fig. 2a. Sub figure' }]
  }
  const targets = resolveCitationTargets(doc, parseCitations('Table 2 与 Fig. 2a，见 [3]'))
  check(
    'resolveCitationTargets：表注/子图/文献各自命中',
    targets.length === 3 &&
      targets[0].kind === 'table' &&
      targets[0].page === 3 &&
      targets[1].kind === 'figure' &&
      targets[1].rect?.[0] === 50 &&
      targets[2].kind === 'reference' &&
      targets[2].label === '[3]',
    JSON.stringify(targets)
  )
  check(
    'resolveCitationTargets：补充材料 S3 无对应目标时不误配',
    resolveCitationTargets(doc, parseCitations('Fig. S3')).length === 0
  )

  // 识别 / 关联分离：区间不当作文献；找不到目标保留 unresolved（不否定身份）
  const doc2 = {
    captions: [],
    refs: [{ n: 3, page: 9, text: '[3] C', rect: [0, 0, 0, 0] as [number, number, number, number], id: 'p9-t3' }],
    formulas: [],
    modules: []
  }
  const assoc1 = associateCitations(doc2, parseCitations('见 [0,1] 区间'))
  check(
    '识别/关联分离：[0,1] 判为区间（不产生文献目标、也不计入未解析）',
    assoc1.targets.length === 0 && assoc1.unresolved.length === 0,
    JSON.stringify(assoc1)
  )
  const assoc2 = associateCitations(doc2, parseCitations('见 [3] 与 [99]'))
  check(
    '识别/关联分离：无目标时保留 unresolved（不否定引用身份）',
    assoc2.targets.length === 1 && assoc2.unresolved.length === 1 && assoc2.unresolved[0].number.main === '99',
    JSON.stringify(assoc2)
  )
  check(
    'parseCiteNumber：子编号后缀字段',
    parseCiteNumber('2.1a')?.suffix === 'a' && parseCiteNumber('2a,b')?.suffix === 'ab',
    JSON.stringify([parseCiteNumber('2.1a'), parseCiteNumber('2a,b')])
  )

  // 引用匹配准确率（人工核对样例）
  const CASES: Array<[string, string]> = [
    ['Table 2 讲了什么', 'table:p3-g0'],
    ['见图 2a 的细节', 'figure:p7-g0'],
    ['参考 [3] 的说法', 'reference:p9-t3'],
    ['Fig. 2a 与 Table 2 对比', 'figure:p7-g0,table:p3-g0'],
    ['[1,3] 这两篇', 'reference:p9-t3'],
    ['这篇论文的主要贡献是什么', ''],
    ['图 9 在哪里', ''],
    ['Table 5 的结果', '']
  ]
  let hit = 0
  for (const [q, want] of CASES) {
    const got = resolveCitationTargets(doc, parseCitations(q))
      .map((t) => `${t.kind}:${t.moduleId}`)
      .sort()
      .join(',')
    const wantSorted = want.split(',').filter(Boolean).sort().join(',')
    if (got === wantSorted) hit++
    else console.log(`  · 引用匹配不符：${q}\n      期望 ${wantSorted || '(无)'}\n      实际 ${got || '(无)'}`)
  }
  const citeAcc = hit / CASES.length
  console.log(`引用匹配准确率 ${hit}/${CASES.length} = ${Math.round(citeAcc * 100)}%`)
  check('引用匹配准确率 ≥ 85%', citeAcc >= 0.85, `${Math.round(citeAcc * 100)}%`)
}

// ---- 公式候选验证（低置信度回退：不覆盖原文）----
{
  const v1 = validateFormulaLatex('E = mc^2', 'E=mc^{2}')
  check('validateFormulaLatex：正常候选通过', v1.ok && v1.issues.length === 0, JSON.stringify(v1))
  const v2 = validateFormulaLatex('x = (a+b', 'x = (a+b')
  check('validateFormulaLatex：括号不配对 → 不通过', !v2.ok && !v2.balanced, JSON.stringify(v2))
  const v3 = validateFormulaLatex('T = {τ1, τ2}', 'T = \\{ 1, 2\\}')
  check(
    'validateFormulaLatex：关键符号遗漏（τ）→ 不通过',
    !v3.ok && v3.missingSymbols.includes('τ'),
    JSON.stringify(v3)
  )
  const v4 = validateFormulaLatex('∑ x', '\\sum x')
  check('validateFormulaLatex：符号映射后视为未遗漏', v4.ok, JSON.stringify(v4))
  const v5 = validateFormulaLatex('\ufffd\ufffd = \ufffd\ufffd', 'x = y')
  check('validateFormulaLatex：原文乱码比例高 → 不通过', !v5.ok, JSON.stringify(v5))
  const v6 = validateFormulaLatex('a = b', '')
  check('validateFormulaLatex：空候选 → 不通过', !v6.ok, JSON.stringify(v6))
  const v7 = validateFormulaLatex('\\begin{pmatrix}a\\end{pmatrix}', '\\begin{pmatrix}a')
  check('validateFormulaLatex：环境不配对 → 不通过', !v7.ok && !v7.balanced, JSON.stringify(v7))
  check('isBalanced：花括号计数', isBalanced('\\frac{a}{b}') && !isBalanced('\\frac{a}{b'))
}

// ---- 公式识别：多引擎候选 + 分引擎阈值选择 ----
{
  const okV = { ok: true, issues: [], missingSymbols: [], balanced: true, garbleRatio: 0 }
  const badV = { ok: false, issues: ['括号/环境不配对'], missingSymbols: [], balanced: false, garbleRatio: 0 }
  const mk = (engine: string, latex: string, conf: number | null, v: typeof okV) => ({
    engine,
    engineVersion: 'v1',
    latex,
    confidence: conf,
    validation: v
  })
  const p1 = pickCandidate([
    mk('vision', '\\frac{a}{b}', 0.9, okV),
    mk('pix2tex', '\\frac{a}{b}', 0.95, okV)
  ])
  check('pickCandidate：按引擎优先级（pix2tex 先于 vision）', p1.chosen?.engine === 'pix2tex', JSON.stringify(p1))

  const p2 = pickCandidate([mk('pix2tex', 'x', 0.5, okV), mk('vision', 'x', 0.9, okV)])
  check(
    'pickCandidate：pix2tex 低于其阈值 → 回落到 vision',
    p2.chosen?.engine === 'vision' && p2.rejected.some((r) => r.engine === 'pix2tex'),
    JSON.stringify(p2)
  )

  const p3 = pickCandidate([mk('vision', 'x', 0.9, badV)])
  check('pickCandidate：验证不通过 → 拒绝', p3.chosen === null && p3.rejected[0].reason.startsWith('validation'), JSON.stringify(p3))

  const p4 = pickCandidate([mk('vision', 'x', null, okV)])
  check(
    'pickCandidate：无自报置信度 → 用结构置信度兜底（通过）',
    p4.chosen?.engine === 'vision',
    JSON.stringify(p4)
  )

  const p5 = pickCandidate([mk('vision', '', 0.9, okV)])
  check('pickCandidate：空候选 → 拒绝', p5.chosen === null && p5.rejected[0].reason === 'empty', JSON.stringify(p5))

  check(
    'deriveStructuralConfidence：验证越好分越高',
    deriveStructuralConfidence(okV) > deriveStructuralConfidence(badV),
    `${deriveStructuralConfidence(okV)} vs ${deriveStructuralConfidence(badV)}`
  )
  check(
    'deriveStructuralConfidence：关键符号遗漏会扣分',
    deriveStructuralConfidence({ ...okV, missingSymbols: ['τ', '∑'] }) < deriveStructuralConfidence(okV)
  )
}

// ---- Google Scholar (SerpAPI) 结果映射 ----
if (true) {
  const hits = mapScholarResults([
    {
      result_id: 'abc',
      title: 'A paper',
      link: 'https://doi.org/10.1038/s42256-026-01307-8',
      snippet: 'abstract text',
      publication_info: {
        summary: 'A. Author, B. Author - Nature Machine Intelligence, 2025 - nature.com',
        authors: [{ name: 'A. Author' }, { name: 'B. Author' }]
      },
      inline_links: { cited_by: { total: 42 } },
      resources: [{ link: 'https://example.org/paper.pdf' }]
    }
  ])
  check(
    'scholar: title/doi/year/venue',
    !!hits[0] &&
      hits[0].doi === '10.1038/s42256-026-01307-8' &&
      hits[0].year === 2025 &&
      hits[0].venue === 'Nature Machine Intelligence',
    JSON.stringify(hits[0])
  )
  check(
    'scholar: authors/cited/pdf',
    hits[0].authors.length === 2 &&
      hits[0].citedBy === 42 &&
      !!hits[0].oaUrl &&
      hits[0].oaUrl.endsWith('.pdf') &&
      hits[0].isOa,
    JSON.stringify(hits[0])
  )
  check('scholar: doi extraction trims punctuation', doiFromUrl('https://doi.org/10.1000/xyz.') === '10.1000/xyz')
  check('scholar: non-doi link returns null', doiFromUrl('https://example.org/x') === null)
}

// ---- Semantic Scholar 结果映射 ----
if (true) {
  const hits = mapSemanticResults([
    {
      paperId: 's2-1',
      title: 'A semantic paper',
      year: 2023,
      venue: 'TestConf',
      citationCount: 11,
      authors: [{ name: 'C. Author' }, { name: 'D. Author' }],
      externalIds: { DOI: '10.5555/s2.2023' },
      openAccessPdf: { url: 'https://example.org/s2.pdf' },
      abstract: 's2 abstract'
    }
  ])
  check(
    'semantic: title/doi/year/venue',
    !!hits[0] &&
      hits[0].doi === '10.5555/s2.2023' &&
      hits[0].year === 2023 &&
      hits[0].venue === 'TestConf',
    JSON.stringify(hits[0])
  )
  check(
    'semantic: authors/cited/pdf',
    hits[0].authors.length === 2 &&
      hits[0].citedBy === 11 &&
      hits[0].oaUrl === 'https://example.org/s2.pdf' &&
      hits[0].isOa,
    JSON.stringify(hits[0])
  )
  check('semantic: year range 2020-2024', semanticYearParam(2020, 2024) === '2020-2024')
  check('semantic: open-ended year', semanticYearParam(2020, null) === '2020-')
  check('semantic: no year filter', semanticYearParam(null, null) === null)
}

{
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return new Response('{}')
  }
  try {
    const jobs = new TranslationJobs()
    jobs.begin('A'); jobs.begin('B')
    await jobs.attach('A', 'http://test', 'jobA')
    await jobs.attach('B', 'http://test', 'jobB')
    await jobs.cancel('A')
    check('translation: cancel targets A only', calls.length === 1 && calls[0].endsWith('/jobA'))
    jobs.finish('A')
    await jobs.cancel('B')
    check('translation: finishing A preserves B', calls.length === 2 && calls[1].endsWith('/jobB'))
    jobs.begin('pending')
    await jobs.cancel('pending')
    await jobs.attach('pending', 'http://test', 'pendingJob')
    check('translation: cancel before start is delivered', calls.at(-1)?.endsWith('/pendingJob'))
    jobs.finish('B')
    await jobs.cancel('B')
    check('translation: finished requests cannot cancel another job', calls.length === 3)
  } finally {
    globalThis.fetch = originalFetch
  }

  let attempts = 0
  let progress = 0
  const deps = {
    isRunning: () => true,
    isCancelled: () => false,
    cancel: async () => {},
    reconnecting: () => { progress++ },
    pause: async (_ms: number) => {},
    fetcher: (async () => {
      attempts++
      if (attempts === 1) throw new Error('temporary disconnect')
      return new Response('{}', { status: attempts === 2 ? 503 : 200 })
    }) as typeof fetch
  }
  const response = await pollTranslationStatus('http://test/status/same-job', deps)
  check('translation: transport and 503 recover on same job', response.ok && attempts === 3 && progress === 2)
  let exited = false
  try {
    await pollTranslationStatus('http://test', {
      ...deps, isRunning: () => false,
      fetcher: async () => { throw new Error('offline') }
    })
  } catch (e) { exited = e instanceof TranslationServiceExited }
  check('translation: confirmed process exit is distinct', exited)
  let clock = 0
  let cancelled = false
  let timeoutMessage = ''
  await pollTranslationStatus('http://test', {
    ...deps, now: () => clock, pause: async () => { clock += 60_000 },
    cancel: async () => { cancelled = true },
    fetcher: async () => { throw new Error('offline') }
  }).catch((e) => { timeoutMessage = e.message })
  check('translation: bounded recovery requests cancel without claiming termination',
    cancelled && timeoutMessage.includes('尚未确认后台终止'))
  let userCancelled = ''
  await pollTranslationStatus('http://test', {
    ...deps, isCancelled: () => true,
    fetcher: async () => { throw new Error('offline') }
  }).catch((e) => { userCancelled = e.message })
  check('translation: cancel remains available during disconnect', userCancelled.includes('已请求取消'))
}

// ---- 翻译复用：后端/模型/源文件指纹 ----
if (true) {
  const sig: ReuseSignature = {
    backend: 'openai',
    model: 'model-a',
    fingerprint: '100:200',
    engineKey: 'simple'
  }
  const row = (patch: Record<string, unknown>) => ({
    status: 'done',
    engine: 'simple',
    backend: 'openai',
    qa: JSON.stringify({ reuse: sig }),
    ...patch
  })
  check('reuse: same backend/model/fingerprint', canReuseTranslation(row({}), sig, 'openai'))
  check('reuse: mock result never satisfies openai', !canReuseTranslation(row({ backend: 'mock' }), sig, 'openai'))
  check('reuse: mock request reuses mock result', canReuseTranslation(row({ backend: 'mock', qa: null }), { ...sig, backend: 'mock' }, 'mock'))
  check('reuse: model change invalidates', !canReuseTranslation(row({ qa: JSON.stringify({ reuse: { ...sig, model: 'model-b' } }) }), sig, 'openai'))
  check('reuse: source change invalidates', !canReuseTranslation(row({ qa: JSON.stringify({ reuse: { ...sig, fingerprint: '100:201' } }) }), sig, 'openai'))
  check('reuse: legacy row without signature not reused', !canReuseTranslation(row({ qa: null }), sig, 'openai'))
  check('reuse: engine/mode mismatch invalidates', !canReuseTranslation(row({ engine: 'simple:coarse' }), sig, 'openai'))
  check('reuse: non-done not reused', !canReuseTranslation(row({ status: 'superseded' }), sig, 'openai'))
  check(
    'reuse: layout change invalidates',
    !canReuseTranslation(
      row({ qa: JSON.stringify({ reuse: { ...sig, layout: 'strict' } }) }),
      { ...sig, layout: 'reflow' },
      'openai'
    )
  )
  check(
    'reuse: same strict layout reuses',
    canReuseTranslation(
      row({ qa: JSON.stringify({ reuse: { ...sig, layout: 'strict' } }) }),
      { ...sig, layout: 'strict' },
      'openai'
    )
  )
  check(
    'reuse: explicit backend change invalidates',
    !canReuseTranslation(
      row({ qa: JSON.stringify({ reuse: { ...sig, backend: 'openai' } }) }),
      { ...sig, backend: 'gateway-b' },
      'gateway-b'
    )
  )
  check(
    'reuse: stored signature records backend and model',
    (() => {
      const stored = JSON.parse(String(row({}).qa)).reuse
      return stored.backend === 'openai' && stored.model === 'model-a'
    })()
  )
  // 真实实现（translate.ts 的 decideTranslationReuse）：force 语义与提示文案
  const decide = (await loadTranslate()).decideTranslationReuse as (i: any) => {
    reuse: boolean
    message: string
  }
  const forced = decide({ force: true, fingerprint: sig.fingerprint, existing: row({}), sig, backend: 'openai' })
  check(
    'reuse: force skips reuse with explicit hint',
    !forced.reuse && forced.message.includes('强制重译') && forced.message.includes('重新翻译'),
    JSON.stringify(forced)
  )
  const reused = decide({ fingerprint: sig.fingerprint, existing: row({}), sig, backend: 'openai' })
  check(
    'reuse: matching signature reuses with backend/model hint',
    reused.reuse && reused.message.includes('openai') && reused.message.includes('model-a'),
    JSON.stringify(reused)
  )
  const switchedModel = decide({
    fingerprint: sig.fingerprint,
    existing: row({ qa: JSON.stringify({ reuse: { ...sig, model: 'model-b' } }) }),
    sig,
    backend: 'openai'
  })
  check('reuse: model switch does not reuse old translation', !switchedModel.reuse)
  const switchedBackend = decide({
    fingerprint: sig.fingerprint,
    existing: row({}),
    sig: { ...sig, backend: 'gateway-b' },
    backend: 'gateway-b'
  })
  check('reuse: backend switch does not reuse old translation', !switchedBackend.reuse)
  const mockThenReal = decide({
    fingerprint: sig.fingerprint,
    existing: row({ backend: 'mock', qa: JSON.stringify({ reuse: { ...sig, backend: 'mock', model: '' } }) }),
    sig,
    backend: 'openai'
  })
  check('reuse: mock run does not satisfy a real model request', !mockThenReal.reuse)
  const noFingerprint = decide({
    fingerprint: '',
    existing: row({}),
    sig: { ...sig, fingerprint: '' },
    backend: 'openai'
  })
  check('reuse: missing fingerprint never reuses', !noFingerprint.reuse && noFingerprint.message.includes('指纹'))
}

// ---- F04: unconfirmed termination keeps identity until reconciled ----
if (true) {
  let now = 0
  const jobs = new TranslationJobs(() => now)
  jobs.begin('f04-a')
  await jobs.attach('f04-a', 'http://127.0.0.1:1', 'job-a')
  jobs.markUnconfirmed('f04-a')
  jobs.finish('f04-a')
  check(
    'f04: unconfirmed survives finish',
    jobs.pending().length === 1 && jobs.pending()[0]?.jobId === 'job-a',
    JSON.stringify(jobs.pending())
  )
  jobs.confirm('f04-a')
  check('f04: confirm releases identity', jobs.pending().length === 0)

  jobs.begin('f04-b')
  await jobs.attach('f04-b', 'http://x', 'job-b')
  jobs.markUnconfirmed('f04-b')
  now += 31 * 60_000
  check('f04: expired unconfirmed released', jobs.releaseExpired().includes('f04-b'))
  await jobs.cancel('f04-b')
}

if (true) {
  let ticks = 0
  let cancels = 0
  let unconfirmed = false
  try {
    await pollTranslationStatus('http://x/status', {
      isRunning: () => true,
      isCancelled: () => false,
      cancel: async () => {
        cancels++
      },
      reconnecting: () => undefined,
      fetcher: (async () => {
        throw new Error('down')
      }) as unknown as typeof fetch,
      now: () => (ticks += 60_000),
      pause: async () => undefined
    })
  } catch (e) {
    unconfirmed = e instanceof TranslationTerminationUnconfirmed
  }
  check(
    'f04: poll reports unconfirmed after the window',
    unconfirmed && cancels === 1,
    `unconfirmed=${unconfirmed} cancels=${cancels}`
  )
}

if (true) {
  check('title 归一化：去标点/小写', normalizeTitle('A Study: of  Things!') === 'a study of things', normalizeTitle('A Study: of  Things!'))
  const r = (title: string, doi: string | null, cited: number) => ({
    id: title,
    doi,
    title,
    year: null,
    venue: null,
    citedBy: cited,
    authors: [],
    oaUrl: null,
    isOa: false
  })
  check(
    '被引匹配：DOI 优先',
    pickBestWork([r('Other', '10.1/x', 5), r('Target', '10.1/y', 7)], 'Target', '10.1/y')?.citedBy === 7,
    ''
  )
  check(
    '被引匹配：标题近似（大小写/标点不同）',
    pickBestWork([r('A Study of Things', null, 3)], 'a study of things', null)?.citedBy === 3,
    ''
  )
  check(
    '被引匹配：不相关不误配',
    pickBestWork([r('Completely Different', null, 9)], 'Target Paper', null) === null,
    ''
  )

  const body =
    '<!-- paperdesk:论文拆解（fine） -->\n\n## 论文拆解（fine）\n\n- 问题：X\n- 方法：Y\n\n<!-- /paperdesk:论文拆解（fine） -->\n\n## 批注\n\n其它'
  const sec = extractAnalysisSection(body)
  check(
    '拆解小节：提取正文并去掉标题',
    !!sec && sec.title === '论文拆解（fine）' && sec.markdown.includes('问题：X') && !sec.markdown.includes('## '),
    JSON.stringify(sec)
  )
  check('拆解小节：没有拆解时返回 null', extractAnalysisSection('## 目录\n- 笔记') === null, '')
  check(
    '拆解小节：兼容旧的无注释块标题',
    extractAnalysisSection('## 论文拆解（coarse）\n旧内容\n\n## 其它\nx')?.markdown.startsWith('旧内容') === true,
    ''
  )
  check(
    '拆解小节：多次归档取最新一份',
    extractAnalysisSection('## 论文拆解（fine）\n旧结论\n\n## 论文拆解（fine）\n新结论\n')?.markdown.startsWith(
      '新结论'
    ) === true,
    ''
  )
}

// ---- 期刊/来源补全：标题归一化与相似度（Crossref/OpenAlex 标题检索用） ----
if (true) {
  check(
    'enrich 标题归一化：去标签/实体/标点并小写',
    normalizeEnrichTitle('Attention <i>Is</i> All You &amp; Need.') === 'attention is all you need',
    normalizeEnrichTitle('Attention <i>Is</i> All You &amp; Need.')
  )
  check(
    'enrich 相似度：大小写/标点不同视为同一标题（=1）',
    titleSimilarity('Attention Is All You Need', 'attention  is all-you-need.') === 1,
    String(titleSimilarity('Attention Is All You Need', 'attention  is all-you-need.'))
  )
  check(
    'enrich 相似度：带副标题（完整包含）仍 >= 阈值 0.9',
    titleSimilarity(
      'Deep Residual Learning for Image Recognition',
      'Deep Residual Learning for Image Recognition: A Survey'
    ) >= 0.9,
    String(
      titleSimilarity(
        'Deep Residual Learning for Image Recognition',
        'Deep Residual Learning for Image Recognition: A Survey'
      )
    )
  )
  check(
    'enrich 相似度：不相关标题 < 阈值 0.9',
    titleSimilarity('Attention Is All You Need', 'Mamba: Linear-Time Sequence Modeling') < 0.9,
    String(titleSimilarity('Attention Is All You Need', 'Mamba: Linear-Time Sequence Modeling'))
  )
  check(
    'enrich 选优：DOI 精确优先（忽略标题差异，大小写/doi.org 前缀不敏感）',
    pickBestByTitle(
      [
        { title: 'Completely Different', doi: 'https://doi.org/10.1234/ABC' },
        { title: 'Target Paper', doi: '10.9999/other' }
      ],
      'Target Paper',
      '10.1234/abc'
    )?.doi === 'https://doi.org/10.1234/ABC',
    JSON.stringify(
      pickBestByTitle(
        [
          { title: 'Completely Different', doi: 'https://doi.org/10.1234/ABC' },
          { title: 'Target Paper', doi: '10.9999/other' }
        ],
        'Target Paper',
        '10.1234/abc'
      )
    )
  )
  check(
    'enrich 选优：无 DOI 时按标题挑最佳，低于阈值返回 null',
    pickBestByTitle(
      [
        { title: 'Mamba: Linear-Time Sequence Modeling', doi: '10.1/m' },
        { title: 'Attention Is All You Need', doi: '10.1/a' }
      ],
      'attention is all you need',
      null
    )?.doi === '10.1/a' &&
      pickBestByTitle([{ title: 'Completely Different', doi: null }], 'Target Paper', null) ===
        null,
    JSON.stringify(
      pickBestByTitle(
        [
          { title: 'Mamba: Linear-Time Sequence Modeling', doi: '10.1/m' },
          { title: 'Attention Is All You Need', doi: '10.1/a' }
        ],
        'attention is all you need',
        null
      )
    )
  )
}

check(
  '批处理文件名：保留可读标题并清理 Windows 禁用字符',
  safeBatchStem('ReEvo: LLM / Hyper-Heuristics?') === 'ReEvo LLM Hyper-Heuristics',
  safeBatchStem('ReEvo: LLM / Hyper-Heuristics?')
)
check(
  '批处理文件名：过长标题在空格处截断，不留下半个单词',
  safeBatchStem('Large Language Models discover complementary heuristics for combinatorial optimization', 40) ===
    'Large Language Models discover',
  safeBatchStem(
    'Large Language Models discover complementary heuristics for combinatorial optimization',
    40
  )
)
check(
  '批处理文件名：空标题有稳定回退',
  safeBatchStem('   ') === '未命名论文',
  safeBatchStem('   ')
)
check(
  '批处理文件名：Windows 保留名追加下划线',
  safeBatchStem('CON') === 'CON_',
  safeBatchStem('CON')
)

// ---------- 文库分组（纯函数）：名称归一化 / 按组过滤 / 下拉选项 ----------
check('分组名：去首尾空格并折叠内部空白', normalizeGroupName('  实验   组 A ') === '实验 组 A')
check(
  '分组名：空串/纯空白/非字符串一律视为未分组',
  normalizeGroupName('') === null &&
    normalizeGroupName('   ') === null &&
    normalizeGroupName(null) === null &&
    normalizeGroupName(42) === null
)
check(
  '分组名：超长名截断到上限',
  (normalizeGroupName('x'.repeat(GROUP_NAME_MAX + 10)) ?? '').length === GROUP_NAME_MAX
)

const groupItems = [
  { group_name: null },
  { group_name: ' alpha ' },
  { group_name: 'beta' },
  { group_name: 'alpha' }
]
check(
  '分组过滤：全部保持原顺序',
  filterItemsByGroup(groupItems, GROUP_ALL).length === groupItems.length
)
check(
  '分组过滤：未分组只保留空值',
  filterItemsByGroup(groupItems, GROUP_UNGROUPED).length === 1
)
check(
  '分组过滤：按组名过滤并归一化两侧空白',
  filterItemsByGroup(groupItems, 'alpha').every((i) => normalizeGroupName(i.group_name) === 'alpha') &&
    filterItemsByGroup(groupItems, 'alpha').length === 2
)
check(
  '分组过滤：未知组名返回空列表',
  filterItemsByGroup(groupItems, '不存在的组').length === 0
)
check(
  '分组列表：去重 + 排序 + 忽略空值',
  distinctGroupNames(groupItems).join(',') === 'alpha,beta'
)
const groupOpts = groupSelectOptions(groupItems)
check(
  '分组下拉：全部/未分组在前，真实组名随后',
  groupOpts[0]?.value === GROUP_ALL &&
    groupOpts[1]?.value === GROUP_UNGROUPED &&
    groupOpts.slice(2).map((o) => o.value).join(',') === 'alpha,beta'
)

// ---------- 导入识别（纯函数）：DOI / arXiv / 链接 / PDF 魔数 / 网页 DOI ----------
check(
  '导入识别：裸 DOI 归一化为小写',
  normalizeIdentifier(' 10.1038/S41586-020-2649-2 ')?.kind === 'doi' &&
    normalizeIdentifier('10.1038/S41586-020-2649-2')?.value === '10.1038/s41586-020-2649-2'
)
check(
  '导入识别：doi.org 链接按 DOI 处理',
  normalizeIdentifier('https://doi.org/10.1000/xyz')?.kind === 'doi' &&
    normalizeIdentifier('https://doi.org/10.1000/xyz')?.value === '10.1000/xyz'
)
check(
  '导入识别：arXiv 前缀与 abs/pdf 链接',
  normalizeIdentifier('arXiv:2101.00001v2')?.kind === 'arxiv' &&
    normalizeIdentifier('arXiv:2101.00001v2')?.value === '2101.00001v2' &&
    normalizeIdentifier('https://arxiv.org/pdf/2101.00001')?.value === '2101.00001'
)
check(
  '导入识别：普通网页链接',
  normalizeIdentifier('https://example.com/paper')?.kind === 'url'
)
check(
  '导入识别：无法识别返回 null',
  normalizeIdentifier('not a link') === null && normalizeIdentifier('  ') === null
)
const enc = new TextEncoder()
check(
  'PDF 魔数：%PDF 命中（容忍前导空白）',
  isPdfHeader(enc.encode('%PDF-1.7')) && isPdfHeader(enc.encode('  %PDF-1.4\n'))
)
check(
  'PDF 魔数：HTML 登录页/空值不命中（避免把拦截页入库）',
  !isPdfHeader(enc.encode('<html>login</html>')) && !isPdfHeader(null)
)
check(
  '网页元信息：citation_doi 可提取 DOI',
  extractDoiFromHtml('<meta name="citation_doi" content="10.1016/j.cell.2020.01.001">') ===
    '10.1016/j.cell.2020.01.001'
)
check(
  '网页元信息：没有 DOI 元信息时返回 null',
  extractDoiFromHtml('<meta name="citation_title" content="x">') === null
)
check(
  '解析失败提示：聚合各来源的具体原因',
  (() => {
    const msg = summarizeResolveFailure('doi', [
      { step: 'OpenAlex', ok: false, detail: 'HTTP 404' },
      { step: 'Unpaywall', ok: false, detail: '未找到开放获取版本' }
    ])
    return msg.includes('OpenAlex') && msg.includes('HTTP 404') && msg.includes('Unpaywall')
  })()
)
check(
  '解析失败提示：网络错误使用单独话术',
  summarizeResolveFailure('url', [{ step: 'URL 页面', ok: false, detail: '网络错误 ENOTFOUND' }]).startsWith(
    '网络请求失败'
  )
)

// ---- fallbackDomain：模型不可用时的领域标签兜底 ----
check(
  'fallbackDomain：ResNet → 计算机视觉',
  fallbackDomain('Deep Residual Learning for Image Recognition', '') === '计算机视觉'
)
check(
  'fallbackDomain：Attention → 自然语言处理',
  fallbackDomain('Attention Is All You Need', '') === '自然语言处理'
)
check(
  'fallbackDomain：LLM 启发式设计 → 自动启发式设计',
  fallbackDomain('Generative Large Neighborhood Search for LLM-Based Automatic Heuristic Design', '') ===
    '自动启发式设计'
)
check('fallbackDomain：未知标题有兜底', fallbackDomain('A Study of Something', '') === '综合研究')

// ---- seedFindQuery：文库全文命中打开「尚未打开」的文档时查找框初值（PD15 回归） ----
// 新文档挂载时 PdfViewer 是新建的：初值若为空，首帧回传会把父级刚设置的命中词打回空，
// 待定位请求随后被「用户已改词」判定丢弃 → 查找框空、命中 0、无高亮。
check(
  'seedFindQuery：请求词优先（已带入的命中词不被外部旧词覆盖）',
  seedFindQuery({ query: 'np.ndarray', page: 3, nonce: 1 }, 'TSP_ACO') === 'np.ndarray'
)
check('seedFindQuery：外部词兜底（无命中请求时沿用工具栏查找词）', seedFindQuery(null, 'TSP_ACO') === 'TSP_ACO')
check(
  'seedFindQuery：两者皆空 → 空串',
  seedFindQuery(null, undefined) === '' && seedFindQuery({ query: '', page: 1, nonce: 2 }, '') === ''
)
check(
  'seedFindQuery：纯空白词视为未设置（请求词空白回退外部词，两者皆空白 → 空串）',
  seedFindQuery({ query: '   ', page: 2, nonce: 3 }, 'np.ndarray') === 'np.ndarray' &&
    seedFindQuery({ query: ' \t ', page: 2, nonce: 4 }, undefined) === ''
)

// ---------- PD20：聊天链接化（联网回答里的来源必须可点击，且仍然安全） ----------
const pd20Link = chatMarkdownToHtml('参考 https://example.com/a?x=1 与 https://b.test/p。')
check(
  'chat-md：裸链接变成可点击 <a>（验收 1 的来源可点击）',
  pd20Link.includes('<a href="https://example.com/a?x=1" target="_blank" rel="noopener noreferrer">') &&
    pd20Link.includes('<a href="https://b.test/p"')
)
check('chat-md：中文句号不吞进 href', !pd20Link.includes('https://b.test/p。'))
const pd20Xss = chatMarkdownToHtml('<img src=x onerror=alert(1)> https://ok.test')
check('chat-md：HTML 先转义（不产生 <img>）', pd20Xss.includes('&lt;img') && !pd20Xss.includes('<img'))
const pd20JsLink = chatMarkdownToHtml('[点我](javascript:alert(1)) data:text/html,hi')
check(
  'chat-md：javascript:/data: 不生成 href',
  !pd20JsLink.includes('href="javascript:') && !pd20JsLink.includes('href="data:')
)
const pd20Cite = chatMarkdownToHtml('结论 [1]，同时参考网页 [W2]。')
check(
  'chat-md：论文引用 [1] 与网页引用 [W2] 都保留为引用标记',
  pd20Cite.includes('cite-mark">[1]</span>') && pd20Cite.includes('cite-mark">[W2]</span>')
)
check('linkifyHtml：纯文本同样可点击', linkifyHtml('见 https://c.test/x').includes('href="https://c.test/x"'))

// ---------- PD20：找论文去重 / 来源标注 / 打开链接 ----------
const pd20AsWork = (p: Partial<WorkHit>): WorkHit => ({
  id: '',
  doi: null,
  title: '',
  year: null,
  venue: null,
  citedBy: 0,
  authors: [],
  oaUrl: null,
  isOa: false,
  ...p
})
check(
  'paper-hits：workKey 归一化 DOI（doi.org 前缀 / 大小写 / 尾标点）',
  workKey(pd20AsWork({ doi: 'https://doi.org/10.1000/ABC.1.' })) === 'doi:10.1000/abc.1'
)
check(
  'paper-hits：同 DOI 不同写法视为同一篇',
  isSameWork(pd20AsWork({ doi: '10.1000/X' }), pd20AsWork({ doi: 'https://doi.org/10.1000/x' }))
)
check(
  'paper-hits：同标题（忽略大小写与标点）视为同一篇',
  isSameWork(
    pd20AsWork({ title: 'Attention Is All You Need' }),
    pd20AsWork({ title: 'attention is all you need.' })
  )
)
const pd20Merged = dedupeWorks([
  pd20AsWork({
    id: 'oa1',
    title: 'Attention Is All You Need',
    year: 2017,
    authors: ['Vaswani'],
    citedBy: 10,
    source: 'openalex'
  }),
  pd20AsWork({
    id: 'cr1',
    title: 'attention is all you need.',
    doi: '10.1000/x',
    authors: ['Shazeer'],
    citedBy: 99,
    source: 'crossref'
  }),
  pd20AsWork({ id: 'sem1', title: 'Other', doi: 'https://doi.org/10.1000/X', source: 'semantic' })
])
check(
  'paper-hits：同标题 + 同 DOI 合并为一条（验收 4）',
  pd20Merged.length === 1,
  `len=${pd20Merged.length}`
)
check(
  'paper-hits：合并补齐 DOI / 作者 / 被引且来源并集',
  pd20Merged.length === 1 &&
    pd20Merged[0].doi === '10.1000/x' &&
    pd20Merged[0].citedBy === 99 &&
    pd20Merged[0].authors.includes('Vaswani') &&
    pd20Merged[0].authors.includes('Shazeer') &&
    pd20Merged[0].sources?.includes('openalex') === true &&
    pd20Merged[0].sources?.includes('crossref') === true &&
    pd20Merged[0].sources?.includes('semantic') === true
)
check(
  'paper-hits：来源标注 OpenAlex + Crossref + Semantic Scholar',
  pd20Merged.length === 1 && sourceLabel(pd20Merged[0]) === 'OpenAlex + Crossref + Semantic Scholar',
  pd20Merged.length === 1 ? sourceLabel(pd20Merged[0]) : ''
)
check(
  'paper-hits：无关结果不被误合并',
  dedupeWorks([
    pd20AsWork({ id: 'a', title: 'Alpha', doi: '10.1/a' }),
    pd20AsWork({ id: 'b', title: 'Beta', doi: '10.1/b' })
  ]).length === 2
)
check(
  'paper-hits：workOpenUrl DOI 优先、其次 oaUrl',
  workOpenUrl(pd20AsWork({ doi: '10.1/a' })) === 'https://doi.org/10.1/a' &&
    workOpenUrl(pd20AsWork({ oaUrl: 'https://oa.test/paper.pdf' })) === 'https://oa.test/paper.pdf' &&
    workOpenUrl(pd20AsWork({})) === null
)
check(
  'paper-hits：workPdfUrl 只接受 http(s)',
  workPdfUrl(pd20AsWork({ oaUrl: 'https://oa.test/p.pdf' })) === 'https://oa.test/p.pdf' &&
    workPdfUrl(pd20AsWork({ oaUrl: 'javascript:alert(1)' })) === null
)
const pd20Query = paperQueryFromQuestion('帮我找 2023 年关于扩散模型的论文')
check(
  'paper-hits：口语需求提取检索词（去掉「帮我找…的论文」）',
  pd20Query.includes('扩散模型') && !pd20Query.includes('帮我找') && !pd20Query.includes('的论文'),
  pd20Query
)

// ---------- PD20：联网降级文案 / 上下文 / 无模型回答 ----------
const pd20Sources: WebSource[] = [
  {
    index: 1,
    title: 'Diffusion 综述',
    url: 'https://a.test/diffusion',
    site: 'a.test',
    snippet: '扩散模型的基本思想',
    fetched: true
  }
]
check('paper-hits：未联网前缀明确写「未联网」并带原因', webOfflineNote('请求超时') === '（未联网：请求超时）')
check('paper-hits：未联网前缀无原因时也标注未联网', webOfflineNote(null) === '（未联网）')
const pd20CtxBlock = webContextBlock(pd20Sources)
check(
  'paper-hits：模型上下文用 [W1] 编号并带完整 URL',
  pd20CtxBlock.includes('[W1] Diffusion 综述') && pd20CtxBlock.includes('URL: https://a.test/diffusion')
)
const pd20WebAnswer = webAnswerFromSources('扩散模型是什么', pd20Sources)
check(
  'paper-hits：无模型时仍给出带 URL 的可点击回答（验收 1）',
  pd20WebAnswer.includes('[W1]') && pd20WebAnswer.includes('https://a.test/diffusion')
)

// ---------- PD20：联网检索（本地 fixture，不依赖真实网络） ----------
async function pd20NetworkTests(): Promise<void> {
  let base = ''
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const q = url.searchParams.get('q') ?? ''
    if (url.pathname === '/search') {
      if (q.includes('FAIL500')) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('boom')
        return
      }
      if (q.includes('HANG')) {
        // 永不响应：验证客户端超时与 3 秒总预算
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          results: [
            { title: 'Diffusion 综述', url: `${base}/page1`, snippet: '搜索摘要一' },
            { title: '扩散模型入门', url: `${base}/page2`, snippet: '搜索摘要二' }
          ]
        })
      )
      return
    }
    if (url.pathname === '/page1') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><body><h1>扩散模型</h1><p>fixture 正文：扩散模型用加噪与去噪学习分布。</p></body></html>')
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  base = `http://127.0.0.1:${port}`
  const prev = process.env.PAPERDESK_WEBSEARCH_BASE
  process.env.PAPERDESK_WEBSEARCH_BASE = base
  try {
    // PD21：联网检索缺省关（纯 Node 没有 settings，正好命中「读不到设置」分支）
    check(
      'getWebSearchEnabled：读不到设置时缺省关闭（联网按需开启）',
      (await getWebSearchEnabled()) === false
    )
    const defaultOff = await webForAnswer('扩散模型')
    check(
      'webForAnswer：未显式开启时默认 status=off、零来源（不发外网请求）',
      defaultOff.status === 'off' && defaultOff.sources.length === 0 && defaultOff.text === '',
      JSON.stringify({ status: defaultOff.status, n: defaultOff.sources.length })
    )
    const search = await searchWeb('扩散模型')
    check(
      'searchWeb：fixture 返回结构化结果并标注来源',
      search.ok && search.provider === 'fixture' && search.hits.length === 2,
      JSON.stringify(search)
    )
    check('searchWeb：空查询直接拒绝（不发请求）', (await searchWeb('   ')).ok === false)
    const ctx = await webAnswerContext('扩散模型', { limit: 2, timeoutMs: 2000 })
    check(
      'webAnswerContext：搜索 + 至少抓到 1 页正文（验收 1）',
      ctx.ok && ctx.fetched >= 1 && ctx.sources.length === 2,
      JSON.stringify({ ok: ctx.ok, fetched: ctx.fetched, error: ctx.error })
    )
    check(
      'webAnswerContext：[W1] 上下文带 URL，正文来自真实抓取',
      ctx.text.includes('[W1]') &&
        ctx.text.includes(`${base}/page1`) &&
        ctx.text.includes('fixture 正文'),
      ctx.text.slice(0, 200)
    )
    const on = await webForAnswer('扩散模型', true)
    check(
      'webForAnswer：开启时 status=on 且有来源（验收 1）',
      on.status === 'on' && on.sources.length === 2 && on.fetched >= 1,
      JSON.stringify({ status: on.status, n: on.sources.length })
    )
    const off = await webForAnswer('扩散模型', false)
    check(
      'webForAnswer：关闭时 status=off、零来源零上下文（验收 5）',
      off.status === 'off' && off.sources.length === 0 && off.text === ''
    )
    // PD25：离线快速降级——HTTP 非 200 / 目标不响应都要在 3 秒内收敛成可读原因
    const http500 = await searchWeb('FAIL500')
    check(
      'searchWeb：HTTP 非 200 → reason=http 且 error 带状态码（验收 2）',
      http500.ok === false && http500.reason === 'http' && /HTTP 500/.test(http500.error ?? ''),
      JSON.stringify(http500)
    )
    const hangT0 = Date.now()
    const hang = await webForAnswer('HANG', true)
    const hangMs = Date.now() - hangT0
    check(
      'webForAnswer：目标不响应时在预算内失败（不空等、不阻塞问答）',
      hang.status === 'failed' && hangMs < TOTAL_BUDGET_MS + 1000 && /超时/.test(hang.error ?? ''),
      JSON.stringify({ ms: hangMs, status: hang.status, reason: hang.reason, error: hang.error })
    )
  } finally {
    if (prev === undefined) delete process.env.PAPERDESK_WEBSEARCH_BASE
    else process.env.PAPERDESK_WEBSEARCH_BASE = prev
    // HANG 用例会留下未响应的连接：先断开再 close，避免测试挂住
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  // ---- PD25：显式代理注入（本地假代理；目标地址故意不可达，只有走代理才可能成功） ----
  const proxySeen: string[] = []
  const proxyServer = http.createServer((req, res) => {
    // absolute-form：req.url 是完整目标 URL，代理据此转发
    proxySeen.push(req.url ?? '')
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (u.pathname === '/search') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          results: [{ title: 'Proxy 结果', url: 'http://127.0.0.1:1/page1', snippet: '代理摘要' }]
        })
      )
      return
    }
    if (u.pathname === '/page1') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><body><p>proxy 正文：来自代理的网页。</p></body></html>')
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', () => resolve()))
  const proxyAddr = proxyServer.address()
  const proxyPort = typeof proxyAddr === 'object' && proxyAddr ? proxyAddr.port : 0
  const proxy = `http://127.0.0.1:${proxyPort}`
  const prevProxyBase = process.env.PAPERDESK_WEBSEARCH_BASE
  process.env.PAPERDESK_WEBSEARCH_BASE = 'http://127.0.0.1:1'
  try {
    const viaProxy = await searchWeb('扩散模型', { proxy, timeoutMs: 2000 })
    check(
      'searchWeb：显式代理注入（目标不可达，请求经代理成功）',
      viaProxy.ok &&
        viaProxy.hits.length === 1 &&
        proxySeen.some((u) => u.includes('127.0.0.1:1/search')),
      JSON.stringify({ ok: viaProxy.ok, hits: viaProxy.hits.length, seen: proxySeen.slice(0, 2) })
    )
    const proxyCtx = await webAnswerContext('扩散模型', { proxy, timeoutMs: 2000 })
    check(
      'webAnswerContext：走代理完成 搜索→解析命中→取正文 全链路',
      proxyCtx.ok && proxyCtx.fetched === 1 && proxyCtx.text.includes('proxy 正文'),
      JSON.stringify({ ok: proxyCtx.ok, fetched: proxyCtx.fetched, error: proxyCtx.error })
    )
    const proxyAnswer = await webForAnswer('扩散模型', true, proxy)
    check(
      'webForAnswer：proxy 参数一路传到检索（开启时 status=on 且有来源）',
      proxyAnswer.status === 'on' && proxyAnswer.sources.length === 1,
      JSON.stringify({ status: proxyAnswer.status, n: proxyAnswer.sources.length })
    )
    const deadProxy = await searchWeb('扩散模型', { proxy: '127.0.0.1:1', timeoutMs: 800 })
    check(
      'searchWeb：代理不可达 → reason=proxy 且 error 提示检查代理',
      deadProxy.ok === false && deadProxy.reason === 'proxy' && /代理/.test(deadProxy.error ?? ''),
      JSON.stringify(deadProxy)
    )
  } finally {
    if (prevProxyBase === undefined) delete process.env.PAPERDESK_WEBSEARCH_BASE
    else process.env.PAPERDESK_WEBSEARCH_BASE = prevProxyBase
    proxyServer.closeAllConnections()
    await new Promise<void>((resolve) => proxyServer.close(() => resolve()))
  }

  // 网络不可达：必须收敛成失败对象（不抛错），交给 ai.ts 降级为「未联网」回答
  process.env.PAPERDESK_WEBSEARCH_BASE = 'http://127.0.0.1:1'
  try {
    const bad = await searchWeb('扩散模型')
    check(
      'searchWeb：网络不可达时 ok=false、reason=network 且 error 可读（验收 2）',
      bad.ok === false && bad.reason === 'network' && /网络不可达|填写代理/.test(bad.error ?? ''),
      JSON.stringify(bad)
    )
    const failure = await webForAnswer('扩散模型', true)
    check(
      'webForAnswer：失败时 status=failed + error，从不抛错（验收 2）',
      failure.status === 'failed' && !!failure.error && failure.sources.length === 0
    )
  } finally {
    delete process.env.PAPERDESK_WEBSEARCH_BASE
  }
}

const ddgHtml =
  '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpaper&amp;rut=x">Example <b>Paper</b></a>' +
  '<a class="result__snippet" href="#">A short snippet</a>'
const ddgHits = parseDdgHtml(ddgHtml)
check(
  'parseDdgHtml：协议相对 href 解出真实外链与摘要',
  ddgHits.length === 1 &&
    ddgHits[0].url === 'https://example.org/paper' &&
    ddgHits[0].snippet === 'A short snippet',
  JSON.stringify(ddgHits)
)

// ---------- PD25：代理解析 / 失败分类 / HTTP 状态文案（纯函数，不联网） ----------
check(
  'parseProxyRules：空值 → null（交给系统代理，再退回直连）',
  parseProxyRules('') === null && parseProxyRules('   ') === null && parseProxyRules(null) === null
)
check(
  'parseProxyRules：host:port 简写补 http://，完整 URL 原样保留',
  parseProxyRules('127.0.0.1:7993') === 'http://127.0.0.1:7993' &&
    parseProxyRules('socks5://127.0.0.1:1080') === 'socks5://127.0.0.1:1080'
)
const eTimeout = Object.assign(new Error('aborted'), { name: 'AbortError' })
check(
  'classifyNetError：超时 → reason=timeout 且提示 3 秒/代理',
  classifyNetError(eTimeout).reason === 'timeout' && /代理/.test(classifyNetError(eTimeout).message)
)
const eProxy = Object.assign(new Error('net::ERR_PROXY_CONNECTION_FAILED'), { name: 'TypeError' })
check(
  'classifyNetError：Chromium 代理错误 → reason=proxy',
  classifyNetError(eProxy, 'http://127.0.0.1:7993').reason === 'proxy'
)
const eDns = Object.assign(new Error('fetch failed'), {
  name: 'TypeError',
  cause: { code: 'ENOTFOUND' }
})
check(
  'classifyNetError：DNS 失败无代理 → reason=network 且建议填写代理',
  classifyNetError(eDns).reason === 'network' && /填写代理/.test(classifyNetError(eDns).message)
)
check(
  'classifyNetError：同一错误配置了代理 → reason=proxy',
  classifyNetError(eDns, '127.0.0.1:7993').reason === 'proxy'
)
check(
  'describeHttpStatus：403/429/5xx 都给出可读说明',
  describeHttpStatus(403).includes('反爬') &&
    describeHttpStatus(429).includes('限流') &&
    describeHttpStatus(503).includes('服务端')
)
check(
  'parseDdgHtml：空 HTML / 无结果页 → 零命中且不抛错',
  parseDdgHtml('').length === 0 && parseDdgHtml('<html><body>没有结果</body></html>').length === 0
)
check('TOTAL_BUDGET_MS：联网总预算 8 秒（阶段一放宽，仍有界）', TOTAL_BUDGET_MS === 8000)

// ---------------- PD26：选区 → 另一侧高亮（按句对齐，双向） ----------------
function pd26SelectionMapTests(): void {
  type R4 = [number, number, number, number]
  const R = (x0: number, y0: number, x1: number, y1: number): R4 => [x0, y0, x1, y1]
  // 三行正文、两句：第 1 句 = 第 1 行整行 + 第 2 行左半；第 2 句 = 第 2 行右半 + 第 3 行。
  // 译文按同样结构落版（行宽/行高略有差异，模拟真实重排）。
  const sL1 = R(50, 660, 350, 690)
  const sL2L = R(50, 630, 170, 660)
  const sL2R = R(170, 630, 350, 660)
  const sL3 = R(50, 600, 350, 630)
  const dL1 = R(40, 660, 340, 690)
  const dL2L = R(40, 630, 160, 660)
  const dL2R = R(160, 630, 340, 660)
  const dL3 = R(40, 600, 340, 630)
  const bSrc = R(50, 600, 350, 700)
  const bDst = R(40, 600, 340, 700)
  const key = (r: R4): string => r.map((v) => Math.round(v * 10) / 10).join(',')
  const mk = (blocks: TranslationMapBlock[]): TranslationMap => ({ pageCount: 1, blocks })
  const mapSegs = mk([
    {
      id: 'b1',
      page: 1,
      src: bSrc,
      dst: bDst,
      segs: [
        [sL1, dL1],
        [sL2L, dL2L],
        [sL2R, dL2R],
        [sL3, dL3]
      ]
    }
  ])
  const mapPlain = mk([{ id: 'b1', page: 1, src: bSrc, dst: bDst }])
  const go = (
    map: TranslationMap | null,
    rects: R4[],
    dir: 'src2dst' | 'dst2src',
    page = 1
  ): SelectionRects | null => mapSelectionRects(map, { page, rects }, dir)
  const keys = (sel: SelectionRects | null): string[] => (sel?.rects ?? []).map(key)

  // 1) 左 → 右：只选中源文第 1 行 → 只高亮第 1 句的译文片段
  const a = go(mapSegs, [sL1], 'src2dst')
  check(
    'PD26：选中源文一句 → 只高亮对应译句片段（不是整块）',
    keys(a).length === 1 && keys(a)[0] === key(dL1),
    JSON.stringify(keys(a))
  )

  // 2) 左 → 右：同一行里选第 2 句 → 不把整行/邻句一起点亮
  const b = go(mapSegs, [sL2R], 'src2dst')
  check(
    'PD26：同行相邻句 → 只高亮该句片段（不共享整行）',
    keys(b).length === 1 && keys(b)[0] === key(dL2R),
    JSON.stringify(keys(b))
  )

  // 3) 左 → 右：整行选中（两句）→ 两个句级片段，都不是整块
  const c = go(mapSegs, [R(50, 630, 350, 660)], 'src2dst')
  check(
    'PD26：整行两句 → 映射成两个句级片段，且不含整块矩形',
    keys(c).length === 2 &&
      keys(c).includes(key(dL2L)) &&
      keys(c).includes(key(dL2R)) &&
      !keys(c).includes(key(bDst)),
    JSON.stringify(keys(c))
  )

  // 4) 右 → 左：反向同样按句对齐
  const d = go(mapSegs, [dL2R], 'dst2src')
  check(
    'PD26：译文一句 → 反向只高亮对应原文句片段',
    keys(d).length === 1 && keys(d)[0] === key(sL2R),
    JSON.stringify(keys(d))
  )
  const e = go(mapSegs, [dL1], 'dst2src')
  check(
    'PD26：反向选译文第一句 → 原文只亮第一句片段',
    keys(e).length === 1 && keys(e)[0] === key(sL1),
    JSON.stringify(keys(e))
  )

  // 5) 多行多句选区 → 多个句级片段，全部与选区真实相交
  const f = go(mapSegs, [sL1, sL2R], 'src2dst')
  check(
    'PD26：跨行多句选区 → 多个句级片段（不含块矩形）',
    keys(f).length === 2 && keys(f).includes(key(dL1)) && keys(f).includes(key(dL2R)),
    JSON.stringify(keys(f))
  )

  // 6) 无句级字段（图/公式/旧译文）且只选局部 → 不整块兜底
  const g = go(mapPlain, [sL1], 'src2dst')
  check(
    'PD26：无句级片段且非整段 → 不高亮（不再整块兜底）',
    !!g && g.rects.length === 0,
    JSON.stringify(keys(g))
  )
  const h = go(mapPlain, [dL2R], 'dst2src')
  check('PD26：反向同上（不整块兜底）', !!h && h.rects.length === 0, JSON.stringify(keys(h)))

  // 7) 真的整段全选 → 允许整块矩形
  const i = go(mapPlain, [bSrc], 'src2dst')
  check(
    'PD26：整段全选 → 才允许整块矩形',
    keys(i).length === 1 && keys(i)[0] === key(bDst),
    JSON.stringify(keys(i))
  )

  // 8) 有句级片段时整段全选 → 每个句级片段都给，且没有整块矩形
  const j = go(mapSegs, [bSrc], 'src2dst')
  check(
    'PD26：整段全选（有句级字段）→ 四个片段，不含整块矩形',
    keys(j).length === 4 && !keys(j).includes(key(bDst)),
    JSON.stringify(keys(j))
  )

  // 9) 空选区 / 无 map / 跨页
  check('PD26：没有选区 → null', mapSelectionRects(mapSegs, null, 'src2dst') === null)
  const k = go(null, [R(10, 10, 20, 20)], 'src2dst')
  check(
    'PD26：旧译文没有 map → 不猜测另一侧的位置',
    keys(k).length === 0,
    JSON.stringify(keys(k))
  )
  const l = go(mapSegs, [sL1], 'src2dst', 2)
  check('PD26：跨页选区 → 不高亮', !!l && l.rects.length === 0, JSON.stringify(keys(l)))

  // 10) 块选择：选区完全落在相邻小图注里时，不被更大的正文块抢走
  const mapCaption = mk([
    { id: 'body', page: 1, src: bSrc, dst: bDst },
    { id: 'cap', page: 1, src: R(60, 660, 340, 690), dst: R(60, 650, 340, 676) }
  ])
  const m = go(mapCaption, [R(60, 660, 340, 690)], 'src2dst')
  check(
    'PD26：同等覆盖时选更小的块（图注不被正文抢走）',
    keys(m).length === 1 && keys(m)[0] === key(R(60, 650, 340, 676)),
    JSON.stringify(keys(m))
  )
}

function pd27MindmapTests(): void {
  console.log('\n[PD27] 思维地图模型')

  const base = createMindMap(7, '示例论文')
  check(
    'PD27：新建地图的根节点使用文献标题',
    base.version === 1 &&
      base.rootId === MINDMAP_ROOT_ID &&
      base.nodes.length === 1 &&
      base.nodes[0].text === '示例论文'
  )
  check('PD27：新文献没有标题时仍有可用根节点', createMindMap(8, null).nodes[0].text === MINDMAP_UNTITLED)

  const withChild = addChild(base, base.rootId)
  const child = withChild.nodes[1]
  check(
    'PD27：新增子节点挂到父节点下并生成唯一 id',
    withChild.nodes.length === 2 && child.parentId === base.rootId && child.id !== base.rootId
  )
  check(
    'PD27：默认子节点文本与兄弟节点位置递增',
    child.text === MINDMAP_DEFAULT_TEXT && addChild(withChild, base.rootId).nodes[2].y > child.y
  )

  const renamed = renameNode(withChild, child.id, '  方法  ')
  check(
    'PD27：改名去掉首尾空白，空文本不覆盖原标题',
    renamed.nodes[1].text === '方法' &&
      renameNode(renamed, child.id, '   ').nodes[1].text === '方法'
  )

  const deep = addChild(renamed, child.id)
  const grandChildId = deep.nodes[2].id
  const pruned = removeNode(deep, child.id)
  check(
    'PD27：删除节点会连同整棵子树一起删除（根节点除外）',
    pruned.nodes.length === 1 &&
      pruned.nodes[0].id === deep.rootId &&
      removeNode(deep, deep.rootId).nodes.length === deep.nodes.length &&
      countDescendants(deep, child.id) === 1
  )
  check(
    'PD27：childrenOf 只返回直接子节点',
    childrenOf(deep, child.id).length === 1 &&
      childrenOf(deep, child.id)[0].id === grandChildId &&
      childrenOf(deep, deep.rootId).length === 1
  )

  const moved = setNodePosition(deep, grandChildId, 321.6, 87.4)
  check('PD27：拖动坐标取整并保留', moved.nodes[2].x === 322 && moved.nodes[2].y === 87)

  const roundTrip = parseMindMapJson(serializeMindMap(moved), 7, '示例论文')
  check(
    'PD27：序列化/反序列化保持节点、父子关系与坐标',
    JSON.stringify(roundTrip.nodes) === JSON.stringify(moved.nodes)
  )

  const broken = normalizeMindMap(
    {
      version: 1,
      itemId: 7,
      rootId: 'gone',
      nodes: [
        { id: 'a', parentId: 'ghost', text: 42, x: 'bad', y: 3 },
        { id: 'a', parentId: null, text: '重复', x: 1, y: 2 },
        { id: 'b', parentId: 'a', text: '子', x: 10, y: 20 }
      ]
    },
    7,
    '回退标题'
  )
  check(
    'PD27：坏数据补根、去重、孤立父级挂回根并修正非法坐标',
    broken.nodes.length === 2 &&
      broken.rootId === 'a' &&
      broken.nodes[0].x === 0 &&
      broken.nodes[0].text === MINDMAP_DEFAULT_TEXT &&
      broken.nodes[1].parentId === 'a'
  )

  const cyclic = normalizeMindMap(
    {
      version: 1,
      itemId: 1,
      rootId: 'r',
      nodes: [
        { id: 'r', parentId: null, text: 'R', x: 0, y: 0 },
        { id: 'a', parentId: 'b', text: 'A', x: 1, y: 1 },
        { id: 'b', parentId: 'a', text: 'B', x: 2, y: 2 }
      ]
    },
    1,
    'R'
  )
  check(
    'PD27：环形父链会被修复成从根可达的树',
    cyclic.nodes.length === 3 && countDescendants(cyclic, cyclic.rootId) === 2
  )

  check(
    'PD27：空/非法 JSON 回退为带标题的新地图',
    parseMindMapJson('{oops', 7, '标题A').nodes[0].text === '标题A' &&
      normalizeMindMap(null, 7, '标题B').nodes[0].text === '标题B'
  )

  const other = createMindMap(9, '另一篇')
  check(
    'PD27：地图按文献独立（itemId 与内容互不影响）',
    other.itemId === 9 &&
      moved.itemId === 7 &&
      other.nodes.length === 1 &&
      moved.nodes.length === 3
  )
}

/**
 * PD28：思维地图自动骨架的纯函数（大纲展平、层级挂载、非破坏性合并）。
 * GUI 侧的读 PDF / 二次确认由 GUI 验收覆盖，这里只锁数据变换。
 */
function pd28MindmapSkeletonTests(): void {
  console.log('\n[PD28] 思维地图自动骨架')

  const textOf = (entries: Array<{ title: string; level: number }>): string =>
    entries.map((entry) => `${entry.level}:${entry.title}`).join('|')
  const nodeByText = (
    doc: { nodes: Array<{ id: string; parentId: string | null; text: string }> },
    text: string
  ): { id: string; parentId: string | null; text: string } | undefined =>
    doc.nodes.find((node) => node.text === text)

  // 1) 有 outline：按实际嵌套生成多级节点
  const outline = [
    {
      title: '1 Introduction',
      items: [
        { title: '1.1 Background', items: [{ title: '1.1.1 Prior work', items: [] }] },
        { title: '1.2 Contributions', items: [] }
      ]
    },
    { title: '2 Method', items: [] }
  ]
  const entries = flattenOutline(outline)
  check(
    'PD28：大纲展平保持阅读顺序与 1/2/3 级层级',
    textOf(entries) ===
      '1:1 Introduction|2:1.1 Background|3:1.1.1 Prior work|2:1.2 Contributions|1:2 Method',
    textOf(entries)
  )

  const base = createMindMap(7, '示例论文')
  const tree = mergeSkeleton(base, entries)
  const intro = nodeByText(tree, '1 Introduction')
  const background = nodeByText(tree, '1.1 Background')
  const prior = nodeByText(tree, '1.1.1 Prior work')
  check(
    'PD28：骨架生成成多级树，根节点仍是文献标题且一级/二级/三级父子正确',
    tree !== base &&
      tree.nodes.length === 6 &&
      tree.nodes.find((node) => node.id === tree.rootId)?.text === '示例论文' &&
      intro?.parentId === tree.rootId &&
      background?.parentId === intro?.id &&
      prior?.parentId === background?.id,
    JSON.stringify(tree.nodes)
  )

  // 2) 无 outline：返回空条目，合并原样返回同一引用（调用方据此提示「无可用章节结构」）
  check(
    'PD28：没有 outline 时展平为空且合并返回原文档引用',
    flattenOutline(null).length === 0 &&
      flattenOutline(undefined).length === 0 &&
      flattenOutline([]).length === 0 &&
      mergeSkeleton(base, []) === base &&
      mergeSkeleton(base, flattenOutline(null)) === base
  )

  // 3) 层级嵌套：跳级挂最近祖先、深嵌套保持父子、空白标题丢弃但子标题保留
  const jumped = mergeSkeleton(createMindMap(8, '跳级'), [
    { title: 'A', level: 1 },
    { title: 'B', level: 3 },
    { title: 'C', level: 2 },
    { title: 'D', level: 4 }
  ])
  check(
    'PD28：level 跳级时挂到最近的上级（不造中间层）',
    nodeByText(jumped, 'B')?.parentId === nodeByText(jumped, 'A')?.id &&
      nodeByText(jumped, 'C')?.parentId === nodeByText(jumped, 'A')?.id &&
      nodeByText(jumped, 'D')?.parentId === nodeByText(jumped, 'C')?.id &&
      jumped.nodes.length === 5,
    JSON.stringify(jumped.nodes)
  )

  const blankParent = flattenOutline([{ title: '   ', items: [{ title: '仅子标题', items: [] }] }])
  const blankMerged = mergeSkeleton(createMindMap(8, '空标题'), blankParent)
  check(
    'PD28：空白大纲标题被丢弃，其子标题仍生成并挂到根下',
    textOf(blankParent) === '2:仅子标题' &&
      blankMerged.nodes.length === 2 &&
      nodeByText(blankMerged, '仅子标题')?.parentId === blankMerged.rootId
  )

  // 4) 无结构：空标题 / 全空白 / 非法条目都不产生节点
  check(
    'PD28：拿不到章节结构时不生成伪结构（合并沿用原文档引用）',
    mergeSkeleton(base, [{ title: '   ', level: 1 }, { title: '', level: 2 }]) === base &&
      mergeSkeleton(base, null) === base &&
      flattenOutline([{ title: 42, items: [] }, { title: '  ', items: null }]).length === 0
  )

  // 5) 合并到已有地图：手动节点 id/文本/父级/坐标一律不动，新节点父为 root 且 id 唯一
  const manualAdded = addChild(base, base.rootId)
  const manual = renameNode(manualAdded, manualAdded.nodes[1].id, '我手动建的节点')
  const manualSnapshot = JSON.stringify(manual.nodes)
  const merged = mergeSkeleton(manual, entries)
  const keptNode = merged.nodes.find((node) => node.id === manual.nodes[1].id)
  const newNodes = merged.nodes.slice(manual.nodes.length)
  const ids = merged.nodes.map((node) => node.id)
  const knownIds = new Set<string>([merged.rootId])
  const linked = newNodes.every((node) => {
    const ok = knownIds.has(node.parentId ?? '')
    knownIds.add(node.id)
    return ok
  })
  check(
    'PD28：已有手动节点不被覆盖（id/文本/父级/坐标不变），新节点挂在根下且 id 唯一',
    merged !== manual &&
      merged.nodes.length === manual.nodes.length + entries.length &&
      JSON.stringify(merged.nodes.slice(0, manual.nodes.length)) === manualSnapshot &&
      keptNode?.text === '我手动建的节点' &&
      newNodes[0].parentId === merged.rootId &&
      linked &&
      new Set(ids).size === ids.length
  )

  // 6) 坐标：新节点从既有根子节点之后排，彼此不重叠且都落在根右侧
  const ys = newNodes.map((node) => node.y)
  check(
    'PD28：骨架节点坐标按层级/行号排布，互不重叠且在根节点右侧',
    new Set(ys).size === ys.length &&
      newNodes.every((node) => node.x > (merged.nodes[0].x ?? 0)) &&
      newNodes.every((node) => !manual.nodes.some((old) => old.x === node.x && old.y === node.y)),
    JSON.stringify(newNodes)
  )

  // 7) 上限与标题截断
  const many = mergeSkeleton(
    createMindMap(9, '超长目录'),
    Array.from({ length: MINDMAP_SKELETON_MAX_NODES + 50 }, (_, i) => ({
      title: `Section ${i}`,
      level: 1
    }))
  )
  const longTitle = mergeSkeleton(createMindMap(9, '长标题'), [
    { title: 'x'.repeat(MINDMAP_SKELETON_MAX_TITLE + 60), level: 1 }
  ])
  check(
    'PD28：骨架节点数有上限，超长标题按上限截断',
    many.nodes.length === MINDMAP_SKELETON_MAX_NODES + 1 &&
      longTitle.nodes[1].text.length === MINDMAP_SKELETON_MAX_TITLE
  )

  // 8) hasChildNodes：空地图 vs 已手动建过节点
  check(
    'PD28：hasChildNodes 只在根节点下已有内容时为真',
    hasChildNodes(base) === false && hasChildNodes(manual) === true
  )
}

/**
 * PD31：知识库占位（纯函数桩）。只验证「占位状态 / 目录自动创建 / 重复读取幂等」，
 * 不涉及索引、向量、检索、上传解析或任何网络调用。
 */
function pd31KnowledgePlaceholderTests(): void {
  console.log('\n[PD31] 知识库占位')

  const tmp = mkdtempSync(join(tmpdir(), 'paperdesk-pd31-'))
  try {
    const dataDir = join(tmp, 'data')
    const root = join(dataDir, 'knowledge')

    // 1) 默认占位状态：永远 enabled=false / status='placeholder'
    const status = knowledgeStatusAt(dataDir)
    check(
      'PD31：默认返回占位状态（enabled=false、status=placeholder、root=数据目录/knowledge）',
      status.enabled === false && status.status === 'placeholder' && status.root === root,
      JSON.stringify(status)
    )

    // 2) 首次读取自动创建空目录（数据目录本身不存在时也能递归创建）
    check(
      'PD31：首次读取会自动创建空的 knowledge 目录',
      existsSync(root) && statSync(root).isDirectory() && readdirSync(root).length === 0
    )

    // 3) 幂等：预置哨兵文件后再读一次，目录内容不变
    writeFileSync(join(root, 'sentinel.txt'), 'keep', 'utf8')
    const again = knowledgeStatusAt(dataDir)
    check(
      'PD31：重复读取幂等（不改动目录里已有的内容）',
      again.root === root &&
        readdirSync(root).join('|') === 'sentinel.txt' &&
        readFileSync(join(root, 'sentinel.txt'), 'utf8') === 'keep'
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * PD29：思维地图节点级 AI（shared/mindmap-ai 纯模块 + 地图模型）。
 * 覆盖：摘要成功 / provider 未配置 / 请求失败不动机器 / 展开 2–4 条且可一次性撤销
 * （JSON 序列化后 source 仍在）/ 支撑段落命中 / 支撑段落未命中（不得编造页码）。
 * 全部注入假的 complete 函数，不联网、不读数据库、不依赖 Electron。
 */
async function pd29MindmapAiTests(): Promise<void> {
  console.log('\n[PD29] 思维地图节点级 AI')

  async function rejection(fn: () => Promise<unknown>): Promise<unknown> {
    try {
      await fn()
      return null
    } catch (error) {
      return error
    }
  }

  // 一份地图：根（文献标题）+ 手动节点「消息传递机制」
  const base = createMindMap(77, '图神经网络综述')
  const withChild = addChild(base, base.rootId)
  const manualId = withChild.nodes[1].id
  const doc = renameNode(withChild, manualId, '消息传递机制')
  const passages = [
    {
      page: 5,
      text: '本文提出的方法在图神经网络上取得了明显提升，并且验证了消息传递机制的有效性。'
    },
    { page: 9, text: '这一段只讨论实验环境，与主题无关。' }
  ]
  const ctx: MindmapPromptContext = contextFromDoc(doc, manualId, '图神经网络综述', passages)

  // 1) 摘要成功：提示词基于标题 + 节点上下文，返回解析后的摘要
  let summaryUser = ''
  const summary = await summarizeMindMapNode(async (system, user) => {
    summaryUser = user
    return '{"summary":"消息传递机制通过邻居聚合迭代更新节点表示，是图神经网络的核心。"}'
  }, ctx)
  check(
    'PD29：摘要成功返回模型内容，提示词包含论文标题与选中节点',
    summary.summary.includes('邻居聚合') &&
      summaryUser.includes('图神经网络综述') &&
      summaryUser.includes('消息传递机制') &&
      summaryUser.length > 0
  )

  // 2) provider 未配置：错误可读且指向设置，不返回假摘要
  const notConfigured = await rejection(() =>
    summarizeMindMapNode(async () => {
      throw new MindmapAiError('not-configured', MINDMAP_AI_NOT_CONFIGURED)
    }, ctx)
  )
  const notConfiguredText = describeMindmapAiError(notConfigured)
  check(
    'PD29：provider 未配置时给出「未配置 AI + 去设置」的可操作提示，不返回假结果',
    notConfigured instanceof MindmapAiError &&
      notConfigured.code === 'not-configured' &&
      notConfiguredText.includes('未配置') &&
      notConfiguredText.includes('设置') &&
      notConfiguredText.includes('API Key')
  )

  // 3) 请求失败：HTTP 401 映射为可读文案；失败不写地图（文档保持原样）
  const beforeFailure = JSON.stringify(doc.nodes)
  const failed = await rejection(() =>
    expandMindMapNode(async () => {
      throw new Error('HTTP 401 {"error":{"message":"invalid api key"}}')
    }, ctx)
  )
  const failedText = describeMindmapAiError(failed)
  check(
    'PD29：请求失败抛可读错误（提示检查 API Key），且不修改地图',
    failed instanceof MindmapAiError &&
      failed.code === 'request-failed' &&
      failedText.includes('API Key') &&
      JSON.stringify(doc.nodes) === beforeFailure
  )

  // 4) 展开：最多 4 条、少于 2 条报错；写入后带 ai-generated，JSON 序列化再读仍在
  const expansion = await expandMindMapNode(
    async () =>
      JSON.stringify(['邻居聚合', '更新规则', '读出层', '残差连接', '多余的一条', '再多一条']),
    ctx
  )
  check(
    'PD29：展开结果解析为 2–4 条（超出上限截断）',
    expansion.texts.length === MINDMAP_EXPAND_MAX && expansion.texts[0] === '邻居聚合',
    JSON.stringify(expansion.texts)
  )
  const tooFew = await rejection(() =>
    expandMindMapNode(async () => JSON.stringify(['只有一条']), ctx)
  )
  check(
    'PD29：展开少于 2 条视为失败，提示重试而不是写入半成品',
    tooFew instanceof MindmapAiError &&
      tooFew.code === 'bad-response' &&
      tooFew.message.includes('2–4')
  )
  const expandPrompt = buildExpandPrompt(ctx)
  check(
    'PD29：展开提示词要求 2–4 个子节点并带上已有子节点上下文',
    expandPrompt.user.includes(String(MINDMAP_EXPAND_MIN)) &&
      expandPrompt.user.includes(String(MINDMAP_EXPAND_MAX)) &&
      expandPrompt.system.length > 0
  )

  const grown = applyAiExpansion(doc, manualId, expansion.texts)
  const grownNodes = grown.doc.nodes.filter((node) => grown.ids.includes(node.id))
  const roundTrip = normalizeMindMap(JSON.parse(serializeMindMap(grown.doc)), 77, '图神经网络综述')
  check(
    'PD29：展开写入地图且标记 ai-generated，JSON 序列化后标记仍在',
    grown.ids.length === MINDMAP_EXPAND_MAX &&
      grownNodes.every((node) => node.source === MINDMAP_AI_SOURCE && node.parentId === manualId) &&
      roundTrip.nodes.filter((node) => node.source === 'ai-generated').length === MINDMAP_EXPAND_MAX
  )

  // 5) 一次性撤销：只删本次 AI 子树，手动节点保留；同一批 id 不能重复撤销
  const undone = undoAiExpansion(roundTrip, grown.ids)
  check(
    'PD29：撤销本次展开只删 AI 节点及子树，手动节点保留',
    undone.nodes.length === doc.nodes.length &&
      undone.nodes.some((node) => node.id === manualId) &&
      !undone.nodes.some((node) => grown.ids.includes(node.id))
  )
  check(
    'PD29：撤销是一次性的（同一批 id 再撤销不改图）且不会误删手动节点',
    undoAiExpansion(undone, grown.ids) === undone && undoAiExpansion(undone, [manualId]) === undone
  )

  // 6) 支撑段落命中：页码取自命中的原文块，不采用模型给的页码
  const hit = await findSupportingPassage(
    async () => '{"found":true,"quote":"验证了消息传递机制的有效性","page":42}',
    ctx
  )
  check(
    'PD29：支撑段落命中时返回原文页码与逐字引用（忽略模型自报页码）',
    hit.found &&
      hit.page === 5 &&
      hit.quote === '验证了消息传递机制的有效性' &&
      passages[0].text.includes(hit.quote),
    JSON.stringify(hit)
  )

  // 7) 支撑段落未命中：模型引文在原文里核对不上 → found:false，不编造位置
  const miss = await findSupportingPassage(
    async () => '{"found":true,"quote":"这句引用在本文里根本不存在","page":7}',
    ctx
  )
  check(
    'PD29：支撑引文核对不上时返回「未找到」，不采用模型给的页码',
    miss.found === false && miss.page === null && miss.reason.includes('未找到') && miss.quote === ''
  )

  // 8) 显式未找到 / 过短引文同样按未找到处理
  const explicitMiss = parseSupportResult('{"found":false}', passages)
  const shortQuote = parseSupportResult('{"found":true,"quote":"消息"}', passages)
  check(
    'PD29：显式未找到 / 过短引文都返回「未找到」而不是编造位置',
    explicitMiss.found === false && explicitMiss.reason.includes('未找到') && shortQuote.found === false
  )

  // 9) 支撑提示词带上了原文片段，避免凭空编造
  const supportPrompt = buildSupportPrompt(ctx)
  check(
    'PD29：支撑提示词包含论文标题与原文片段，并要求只引用原文',
    supportPrompt.user.includes('图神经网络综述') &&
      supportPrompt.user.includes('验证了消息传递机制的有效性') &&
      supportPrompt.user.includes('原文')
  )

  // 10) 节点不存在时的上下文构造必须失败并给出可操作提示
  const missingNode = (() => {
    try {
      contextFromDoc(doc, 'nope', '图神经网络综述', passages)
      return null
    } catch (error) {
      return error
    }
  })()
  check(
    'PD29：节点不存在时上下文构造失败并给出可操作提示',
    missingNode instanceof MindmapAiError && missingNode.message.includes('选中')
  )
}

/**
 * PD30：思维地图导出（shared/mindmap-export 纯模块）。
 * 覆盖：Markdown 缩进层级与顺序、Mermaid graph TD 结构与边、特殊字符转义/还原、
 * 只有根节点时不产生空内容、导出默认文件名清洗。
 * 全部是纯函数断言，不弹保存框、不写磁盘、不依赖 Electron。
 */
function pd30MindmapExportTests(): void {
  console.log('\n[PD30] 思维地图导出 Markdown / Mermaid')

  // 一棵有分支的树（插入顺序即 doc.nodes 顺序）：
  // root → 消息传递机制 → 邻居聚合；root → 特殊字符节点
  const base = createMindMap(88, '图神经网络综述')
  const withA = addChild(base, base.rootId, '消息传递机制')
  const aId = withA.nodes[withA.nodes.length - 1].id
  const withB = addChild(withA, base.rootId, '特殊节点：引号"斜杠/括号()[]{}')
  const doc = addChild(withB, aId, '邻居聚合')

  // 1) DFS 前序：root → 消息传递机制 → 邻居聚合 → 特殊节点（与画布渲染顺序一致）
  check(
    'PD30：导出遍历是根起 DFS 前序，子节点按地图数组先后',
    orderMindmapNodes(doc)
      .map((entry) => entry.node.text)
      .join('|') === '图神经网络综述|消息传递机制|邻居聚合|特殊节点：引号"斜杠/括号()[]{}',
    orderMindmapNodes(doc)
      .map((entry) => entry.node.text)
      .join('|')
  )

  // 2) Markdown：每层 2 空格缩进、`- ` 前缀、行尾换行、不加标题行、文本逐字保留
  const expectedMarkdown = [
    '- 图神经网络综述',
    '  - 消息传递机制',
    '    - 邻居聚合',
    '  - 特殊节点：引号"斜杠/括号()[]{}',
    ''
  ].join('\n')
  check(
    'PD30：Markdown 导出的层级/顺序/文本与地图逐行一致',
    toMarkdownOutline(doc) === expectedMarkdown,
    JSON.stringify(toMarkdownOutline(doc))
  )

  // 3) Mermaid：首行 graph TD、节点标签 mm<i>["…"]、边为 父 --> 子，整体逐行对齐
  const expectedMermaid = [
    'graph TD',
    '  mm0["图神经网络综述"]',
    '  mm1["消息传递机制"]',
    '  mm2["邻居聚合"]',
    '  mm3["特殊节点：引号#quot;斜杠/括号#40;#41;#91;#93;#123;#125;"]',
    '  mm0 --> mm1',
    '  mm1 --> mm2',
    '  mm0 --> mm3',
    ''
  ].join('\n')
  const mermaid = toMermaid(doc)
  check(
    'PD30：Mermaid 导出为 graph TD，节点数=地图节点数、边数=节点数-1 且父子对应',
    mermaid === expectedMermaid,
    JSON.stringify(mermaid)
  )

  // 4) 特殊字符：标签里不残留裸引号/括号，实体可逆还原成原文；# 必须最先转义
  const labelLine = mermaid.split('\n').find((line) => line.startsWith('  mm3[')) ?? ''
  const label = labelLine.slice(labelLine.indexOf('["') + 2, labelLine.lastIndexOf('"]'))
  const restoreLabel = (text: string): string =>
    text
      .replace(/#125;/gu, '}')
      .replace(/#123;/gu, '{')
      .replace(/#93;/gu, ']')
      .replace(/#91;/gu, '[')
      .replace(/#41;/gu, ')')
      .replace(/#40;/gu, '(')
      .replace(/#quot;/gu, '"')
      .replace(/#35;/gu, '#')
  const original = '特殊节点：引号"斜杠/括号()[]{}'
  check(
    'PD30：Mermaid 标签转义特殊字符（引号/方括号/圆括号/花括号）后可无损还原，斜杠保留',
    label.length > 0 &&
      !/["[\](){}]/u.test(label) &&
      label.includes('#quot;') &&
      label.includes('#40;') &&
      label.includes('#91;') &&
      label.includes('#123;') &&
      label.includes('/') &&
      restoreLabel(label) === original,
    label
  )
  check(
    'PD30：Mermaid 转义顺序正确（# 先转义成实体，不被二次转义）且换行折成空格',
    escapeMermaidLabel('a#b') === 'a#35;b' &&
      escapeMermaidLabel('第一行\n第二行') === '第一行 第二行' &&
      escapeMermaidLabel('(a) [b] {c} "d"') === '#40;a#41; #91;b#93; #123;c#125; #quot;d#quot;',
    escapeMermaidLabel('(a) [b] {c} "d"')
  )

  // 5) 只有根节点：不导出空内容，提示明确（IPC 与面板共用同一条文案）
  const rootOnly = createMindMap(89, '只有根节点的地图')
  check(
    'PD30：空地图/只有根节点时两种格式都返回空串并给出明确提示，不产生空文件',
    !hasExportableContent(rootOnly) &&
      toMarkdownOutline(rootOnly) === '' &&
      toMermaid(rootOnly) === '' &&
      toMarkdownOutline(doc).length > 0 &&
      MINDMAP_EXPORT_EMPTY.includes('子节点') &&
      MINDMAP_EXPORT_EMPTY.includes('导出')
  )

  // 6) 保存框默认文件名：Windows 非法字符转下划线、扩展名按格式、空标题兜底
  check(
    'PD30：导出默认文件名清洗（斜杠/冒号转下划线，md/mmd 扩展名，空标题兜底）',
    exportFileBaseName('a/b:c', 'markdown') === 'a_b_c.md' &&
      exportFileBaseName('图神经网络综述', 'mermaid') === '图神经网络综述.mmd' &&
      exportFileBaseName('', 'markdown') === 'mindmap.md' &&
      exportFileBaseName('x'.repeat(200), 'markdown').length <= 'x'.repeat(80).length + 3
  )
}

/* --------------------- PD33：知识库数据层与提案 API --------------------- */

const PD33_TABLES = [
  'knowledge_entries',
  'knowledge_relations',
  'evidence_links',
  'knowledge_versions',
  'proposal_batches',
  'knowledge_proposals',
  'proposal_reviews'
]

/** 只允许查询本批新增的 7 张表，避免测试里拼出任意 SQL 表名 */
function pd33CountRows(db: any, table: string): number {
  if (!PD33_TABLES.includes(table)) throw new Error(`未知表：${table}`)
  return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c)
}

function pd33KnowledgeTests(): void {
  const schemaPath = fileURLToPath(new URL('../src/main/db/schema.sql', import.meta.url))
  const schemaSql = readFileSync(schemaPath, 'utf8')
  const stamp = '2026-11-03T00:00:00.000Z'
  const existingTables = (db: any): number =>
    PD33_TABLES.filter(
      (name) =>
        !!db
          .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(name)
    ).length

  const makeDb = (): any => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(schemaSql)
    migrate(db as never)
    db.prepare('INSERT INTO items (key, title, date_added, date_modified) VALUES (?, ?, ?, ?)').run(
      'item-alpha',
      '论文 Alpha',
      stamp,
      stamp
    )
    db.prepare('INSERT INTO items (key, title, date_added, date_modified) VALUES (?, ?, ?, ?)').run(
      'item-beta',
      '论文 Beta',
      stamp,
      stamp
    )
    return db
  }

  // 1) 老库原地升级 + 迁移幂等：先建 PD33 之前的库（截掉新增段），再跑 schema + migrate 两次
  const markerAt = schemaSql.indexOf('CREATE TABLE IF NOT EXISTS knowledge_entries')
  const legacy = new DatabaseSync(':memory:')
  legacy.exec('PRAGMA foreign_keys = ON')
  legacy.exec(schemaSql.slice(0, markerAt))
  migrate(legacy as never)
  const legacyBefore = existingTables(legacy)
  legacy.exec(schemaSql)
  migrate(legacy as never)
  const upgraded = existingTables(legacy)
  legacy.exec(schemaSql)
  migrate(legacy as never)
  const upgradedAgain = existingTables(legacy)
  check(
    'PD33：老库原地升级补齐 7 张知识库表，重复执行 schema/migrate 幂等',
    markerAt > 0 && legacyBefore === 0 && upgraded === 7 && upgradedAgain === 7,
    `before=${legacyBefore} upgraded=${upgraded} again=${upgradedAgain}`
  )

  // 2) migrate.ts 不会对已存在的新表发多余 ALTER（fake db 断言零 DDL）
  const kbColumns: Record<string, string[]> = {
    knowledge_entries: [
      'id', 'key', 'kind', 'title', 'body', 'content_nature', 'item_id', 'attachment_id',
      'source_type', 'source_ref', 'content_hash', 'version', 'state', 'created_at', 'updated_at'
    ],
    proposal_batches: [
      'id', 'key', 'title', 'task', 'scope_type', 'scope_ref', 'status', 'origin',
      'ai_config_ref', 'workflow_version', 'skill_version', 'idempotency_key', 'created_at', 'updated_at'
    ],
    knowledge_proposals: [
      'id', 'key', 'batch_id', 'item_id', 'op', 'target_entry_id', 'target_key', 'base_version',
      'patch_json', 'before_json', 'reason', 'content_nature', 'source_type', 'source_ref', 'status',
      'verification', 'checks_json', 'idempotency_key', 'published_at', 'created_at', 'updated_at'
    ],
    knowledge_versions: [
      'id', 'entry_id', 'version', 'snapshot_json', 'change_reason', 'proposal_id', 'created_by', 'created_at'
    ],
    evidence_links: [
      'id', 'entry_id', 'proposal_id', 'source_type', 'source_ref', 'item_id', 'attachment_id',
      'page_index', 'page_end', 'module_id', 'rect', 'char_start', 'char_end', 'quote',
      'section_path', 'precision', 'content_hash', 'verified', 'created_at'
    ],
    knowledge_relations: [
      'id', 'from_entry_id', 'to_entry_id', 'relation_type', 'source_type', 'source_ref', 'state', 'created_at'
    ],
    proposal_reviews: [
      'id', 'proposal_id', 'action', 'edited_patch_json', 'reason', 'reviewer', 'created_at'
    ]
  }
  const zeroAlters1 = runMigrate(kbColumns)
  const zeroAlters2 = runMigrate(kbColumns)
  check(
    'PD33：既有新表再跑 migrate 不产生 ALTER（迁移幂等）',
    zeroAlters1.alters.length === 0 && zeroAlters2.alters.length === 0,
    `alters=${zeroAlters1.alters.length + zeroAlters2.alters.length}`
  )

  // 3) 批次：建批次 + 幂等键重复返回同一条
  const db = makeDb()
  const batch = createBatch(db, {
    title: '论文 Alpha 知识抽取',
    task: 'extract',
    idempotencyKey: 'pd33-batch-1'
  })
  const batchAgain = createBatch(db, {
    title: '论文 Alpha 知识抽取',
    task: 'extract',
    idempotencyKey: 'pd33-batch-1'
  })
  check(
    'PD33：创建提案批次，幂等键重复不产生第二个批次',
    batch.id === batchAgain.id &&
      batch.status === 'draft' &&
      pd33CountRows(db, 'proposal_batches') === 1
  )

  const verifiedEvidence = [
    {
      sourceType: 'paper',
      itemId: 1,
      pageIndex: 3,
      pageEnd: 4,
      quote: '图神经网络通过消息传递聚合邻居表示。',
      sectionPath: '2 方法'
    }
  ]

  // 4) 提案创建：性质与来源落库，可定位来源 → verified
  const createProp = createProposal(db, batch.id, {
    op: 'create',
    itemId: 1,
    content: { kind: 'concept', title: '消息传递', body: '消息传递是图神经网络的核心计算范式。' },
    contentNature: 'author_claim',
    sourceType: 'paper',
    sourceRef: { documentId: 11 },
    evidence: verifiedEvidence,
    reason: '论文 §2 明确定义'
  })
  check(
    'PD33：创建（新增）提案，性质与来源写入且状态为待审核',
    createProp.op === 'create' &&
      createProp.status === 'pending_review' &&
      createProp.contentNature === 'author_claim' &&
      createProp.sourceType === 'paper' &&
      createProp.verification === 'verified' &&
      createProp.needsVerification === false
  )

  // 5) 缺来源 → 待核验，不伪造页码/引文
  const noSrc = createProposal(db, batch.id, {
    op: 'create',
    itemId: 1,
    content: { kind: 'note', title: '未定位的笔记', body: '对话里提到但尚未定位到原文。' },
    contentNature: 'ai_suggestion',
    sourceType: 'conversation',
    sourceRef: { conversationId: 'conv-9' },
    evidence: [],
    reason: '对话中提及'
  })
  check(
    'PD33：缺来源证据的提案标记为待核验（problems 说明原因）',
    noSrc.verification === 'pending' &&
      noSrc.needsVerification === true &&
      noSrc.problems.length > 0 &&
      noSrc.problems.join('').includes('待核验')
  )

  // 6) 敏感字段与文献范围检查
  const sentinel = 'SENTINEL-NOT-A-KEY'
  const secretErr = throws(() =>
    createProposal(db, batch.id, {
      op: 'create',
      itemId: 1,
      content: { kind: 'note', title: '越权写入', body: 'x' },
      contentNature: 'ai_suggestion',
      sourceType: 'user',
      sourceRef: { apiKey: sentinel },
      evidence: [],
      reason: '越权测试'
    })
  )
  const badItemErr = throws(() =>
    createProposal(db, batch.id, {
      op: 'create',
      itemId: 999999,
      content: { kind: 'note', title: '越界文献', body: 'x' },
      contentNature: 'user_decision',
      sourceType: 'user',
      evidence: [],
      reason: '范围校验'
    })
  )
  const sentinelRows = db
    .prepare('SELECT COUNT(*) AS c FROM knowledge_proposals WHERE source_ref LIKE ?')
    .get(`%${sentinel}%`)
  check(
    'PD33：拒绝敏感字段（密钥不入库）且校验文献范围',
    typeof secretErr === 'string' &&
      secretErr.includes('敏感字段') &&
      secretErr.includes('apiKey') &&
      Number(sentinelRows.c) === 0 &&
      typeof badItemErr === 'string' &&
      badItemErr.includes('无效的文献 id'),
    `secret=${JSON.stringify(secretErr)} item=${JSON.stringify(badItemErr)}`
  )

  // 7) 范围过滤：批次 / 论文 / 状态
  const betaProp = createProposal(db, batch.id, {
    op: 'create',
    itemId: 2,
    content: { kind: 'result', title: '论文 Beta 的主要发现', body: 'Beta 在三个数据集上均优于基线。' },
    contentNature: 'author_claim',
    sourceType: 'paper',
    sourceRef: { documentId: 22 },
    evidence: [
      {
        sourceType: 'paper',
        itemId: 2,
        pageIndex: 7,
        quote: 'Beta 在三个数据集上均优于基线。',
        sectionPath: '4 实验'
      }
    ],
    reason: '论文 §4'
  })
  const byBatch = listProposals(db, { batchId: batch.id })
  const byItem = listProposals(db, { itemId: 2 })
  const byStatus = listProposals(db, { status: 'pending_review' })
  const byApproved = listProposals(db, { batchId: batch.id, status: 'approved' })
  check(
    'PD33：待审提案支持按批次/论文/状态过滤',
    byBatch.length === 3 &&
      byItem.length === 1 &&
      byItem[0].id === betaProp.id &&
      byStatus.length === 3 &&
      byApproved.length === 0
  )

  // 8) 接受：只改提案状态，不写正式条目
  const accepted = acceptProposal(db, createProp.id, { reason: '核对原文后接受' })
  const detail = getProposalDetail(db, createProp.id)
  check(
    'PD33：接受提案转为 approved 且不触碰正式条目',
    accepted.status === 'approved' &&
      pd33CountRows(db, 'knowledge_entries') === 0 &&
      pd33CountRows(db, 'knowledge_versions') === 0 &&
      detail !== null &&
      detail.before === null &&
      detail.content.title === '消息传递' &&
      detail.evidence.length === 1 &&
      detail.evidence[0].pageIndex === 3 &&
      detail.reviews.some((r) => r.action === 'accept')
  )

  // 9) 拒绝：必须写理由，且发布被拒
  const rejectNoReason = throws(() => rejectProposal(db, noSrc.id, { reason: '   ' }))
  const rejected = rejectProposal(db, noSrc.id, { reason: '来源未定位，退回补充' })
  const publishRejected = publishBatch(db, { batchId: batch.id, proposalIds: [noSrc.id] })
  check(
    'PD33：拒绝提案留痕，未接受/已拒绝的提案不能发布',
    typeof rejectNoReason === 'string' &&
      rejected.status === 'rejected' &&
      publishRejected.ok === false &&
      publishRejected.conflicts.length === 1 &&
      publishRejected.conflicts[0].reason.includes('尚未接受')
  )

  // 10) 编辑后接受：内容被改写并留痕
  const edited = editAndAccept(db, betaProp.id, {
    content: {
      kind: 'result',
      title: '论文 Beta 的主要发现（已编辑）',
      body: 'Beta 在三个数据集上均优于基线（已核对）。'
    },
    reason: '改写标题与正文'
  })
  const editedDetail = getProposalDetail(db, betaProp.id)
  check(
    'PD33：编辑后接受写入新内容、留下 edit_accept 记录',
    edited.status === 'approved' &&
      editedDetail !== null &&
      editedDetail.content.title === '论文 Beta 的主要发现（已编辑）' &&
      editedDetail.reviews.some((r) => r.action === 'edit_accept')
  )

  // 11) 部分发布：只写入选中的提案，批次状态 partially_published
  const partial = publishBatch(db, { batchId: batch.id, proposalIds: [betaProp.id] })
  const entryId = partial.entryIds[0]
  const publishedEntry = entryId ? getEntry(db, entryId) : null
  check(
    'PD33：部分发布只写选中提案（条目/版本/证据各一条）',
    partial.ok === true &&
      partial.publishedProposalIds.length === 1 &&
      partial.batchStatus === 'partially_published' &&
      pd33CountRows(db, 'knowledge_entries') === 1 &&
      pd33CountRows(db, 'knowledge_versions') === 1 &&
      pd33CountRows(db, 'evidence_links') === 1 &&
      publishedEntry !== null &&
      publishedEntry.title === '论文 Beta 的主要发现（已编辑）' &&
      publishedEntry.version === 1
  )

  // 12) 重复发布幂等：整批发布跳过已拒绝提案，已发布提案不重复写
  const beforeRepeatEntries = pd33CountRows(db, 'knowledge_entries')
  const beforeRepeatVersions = pd33CountRows(db, 'knowledge_versions')
  const firstFull = publishBatch(db, { batchId: batch.id })
  const repeat = publishBatch(db, { batchId: batch.id })
  check(
    'PD33：重复发布同一批次不产生重复条目或版本',
    firstFull.ok === true &&
      firstFull.publishedProposalIds.length === 1 &&
      repeat.ok === true &&
      repeat.alreadyPublished === true &&
      repeat.publishedProposalIds.length === 0 &&
      pd33CountRows(db, 'knowledge_entries') === beforeRepeatEntries + 1 &&
      pd33CountRows(db, 'knowledge_versions') === beforeRepeatVersions + 1,
    JSON.stringify({
      published: firstFull.publishedProposalIds,
      entries: pd33CountRows(db, 'knowledge_entries'),
      versions: pd33CountRows(db, 'knowledge_versions')
    })
  )

  // 13) 版本冲突：审核期间正式条目被改动 → 发布被拒，条目不变
  const batch2 = createBatch(db, { title: '修订批次', task: 'update' })
  const updateProp = createProposal(db, batch2.id, {
    op: 'update',
    itemId: 2,
    targetEntryId: entryId,
    baseVersion: 1,
    content: { kind: 'result', title: '论文 Beta 的主要发现（修订）', body: '修订后的结论。' },
    contentNature: 'user_decision',
    sourceType: 'paper',
    sourceRef: { documentId: 22 },
    evidence: [
      { sourceType: 'paper', itemId: 2, pageIndex: 8, quote: '修订后的结论。', sectionPath: '4 实验' }
    ],
    reason: '补充页码'
  })
  const updateDetail = getProposalDetail(db, updateProp.id)
  acceptProposal(db, updateProp.id)
  db.prepare('UPDATE knowledge_entries SET version = 2, title = ? WHERE id = ?').run(
    '论文 Beta 的主要发现（他人修订）',
    entryId
  )
  const conflict = publishBatch(db, { batchId: batch2.id })
  const afterConflict = getEntry(db, entryId)
  check(
    'PD33：版本冲突时发布被拒且不改正式条目（修改类提案保留基线快照）',
    conflict.ok === false &&
      conflict.conflicts.some((c) => c.reason.includes('版本冲突')) &&
      afterConflict !== null &&
      afterConflict.title === '论文 Beta 的主要发现（他人修订）' &&
      afterConflict.version === 2 &&
      pd33CountRows(db, 'knowledge_versions') === 2 &&
      updateDetail !== null &&
      updateDetail.before !== null &&
      updateDetail.before.title === '论文 Beta 的主要发现（已编辑）' &&
      updateDetail.before.version === 1,
    JSON.stringify({ conflicts: conflict.conflicts, version: afterConflict?.version })
  )

  // 14) 单事务：同一发布中第二条失败 → 整批回滚（第一条也不落库）
  const batch3 = createBatch(db, { title: '并发修改批次', task: 'update' })
  const mkUpdate = (title: string) =>
    createProposal(db, batch3.id, {
      op: 'update',
      itemId: 2,
      targetEntryId: entryId,
      baseVersion: 2,
      content: { kind: 'result', title, body: '并发写入测试。' },
      contentNature: 'user_decision',
      sourceType: 'paper',
      sourceRef: { documentId: 22 },
      evidence: [
        { sourceType: 'paper', itemId: 2, pageIndex: 9, quote: '并发写入测试。', sectionPath: '4 实验' }
      ],
      reason: '并发'
    })
  const concurrencyA = mkUpdate('并发改法 A')
  const concurrencyB = mkUpdate('并发改法 B')
  acceptProposal(db, concurrencyA.id)
  acceptProposal(db, concurrencyB.id)
  const versionsBeforeRollback = pd33CountRows(db, 'knowledge_versions')
  const rollbackErr = throws(() => publishBatch(db, { batchId: batch3.id }))
  const afterRollback = getEntry(db, entryId)
  check(
    'PD33：发布在单个 SQLite 事务内，中途失败整体回滚',
    typeof rollbackErr === 'string' &&
      rollbackErr.includes('版本冲突') &&
      afterRollback !== null &&
      afterRollback.title === '论文 Beta 的主要发现（他人修订）' &&
      afterRollback.version === 2 &&
      pd33CountRows(db, 'knowledge_versions') === versionsBeforeRollback,
    JSON.stringify({ err: rollbackErr, versions: pd33CountRows(db, 'knowledge_versions') })
  )

  // 15) 越权不可达：AI 工具只提议，不能发布/删除/执行 SQL/读密钥
  const aiDb = makeDb()
  const aiBatch = createBatch(aiDb, { title: 'AI 抽取批次', task: 'extract' })
  const aiTools = createKnowledgeAiTools(aiDb, { createProposal })
  const aiNames = aiTools.map((t) => t.name).sort().join(',')
  const aiNamespaceExports = Object.keys(knowledgeAiNamespace).join(',')
  const aiForbiddenExport = /(publish|release|delete|remove|sql|exec|file|secret|apikey)/i.test(
    aiNamespaceExports
  )
  check(
    'PD33：AI 工具只暴露 propose_create / propose_update，导出无发布/删除/SQL/文件/密钥入口',
    aiNames === 'propose_create,propose_update' &&
      KNOWLEDGE_AI_TOOL_NAMES.length === 2 &&
      !aiForbiddenExport &&
      aiTools.every((t) => !('publish' in t) && !('delete' in t))
  )

  const aiCreate = aiTools[0].run({
    batchId: aiBatch.id,
    itemId: 1,
    kind: 'concept',
    title: 'AI 提议的概念',
    body: 'AI 只能写提案，不能直接发布。',
    sourceType: 'paper',
    evidence: [
      { sourceType: 'paper', itemId: 1, pageIndex: 2, quote: 'AI 只能写提案，不能直接发布。' }
    ],
    reason: '模型建议'
  })
  const aiNatureErr = throws(() =>
    aiTools[0].run({
      batchId: aiBatch.id,
      kind: 'note',
      title: 'x',
      body: 'y',
      sourceType: 'user',
      contentNature: 'user_decision',
      evidence: []
    })
  )
  const aiPublishErr = throws(() =>
    aiTools[0].run({
      batchId: aiBatch.id,
      kind: 'note',
      title: 'x',
      body: 'y',
      sourceType: 'user',
      publish: true,
      evidence: []
    })
  )
  check(
    'PD33：AI 创建强制 ai_suggestion、只落提案；自定性质/发布参数被拒',
    aiCreate.contentNature === 'ai_suggestion' &&
      aiCreate.status === 'pending_review' &&
      pd33CountRows(aiDb, 'knowledge_entries') === 0 &&
      typeof aiNatureErr === 'string' &&
      aiNatureErr.includes('不接受参数') &&
      typeof aiPublishErr === 'string' &&
      aiPublishErr.includes('不接受参数')
  )

  db.close()
  aiDb.close()
  legacy.close()
}

/* --------------------- PD34：暂存区审核界面（纯逻辑 + 发布一致性） --------------------- */

/** 构造一条提案摘要：只覆盖需要的字段，其余取默认值 */
function pd34Prop(
  over: Partial<KnowledgeProposalSummary> & { id: number }
): KnowledgeProposalSummary {
  return {
    id: over.id,
    key: `kp-${over.id}`,
    batchId: 1,
    itemId: 1,
    op: 'create',
    status: 'pending_review',
    verification: 'pending',
    kind: 'concept',
    title: `提案 ${over.id}`,
    contentNature: 'ai_suggestion',
    sourceType: 'paper',
    sourceRef: {},
    targetEntryId: null,
    targetKey: null,
    baseVersion: null,
    reason: '',
    needsVerification: true,
    problems: [],
    createdAt: '2026-11-03T00:00:00.000Z',
    updatedAt: '2026-11-03T00:00:00.000Z',
    ...over
  }
}

function pd34StagingTests(): void {
  // 1) 分组与数量：固定「新增 → 修改」顺序，数量与可审核数分别统计
  const list: KnowledgeProposalSummary[] = [
    pd34Prop({ id: 1, op: 'create', status: 'pending_review' }),
    pd34Prop({
      id: 2,
      op: 'create',
      status: 'approved',
      verification: 'verified',
      needsVerification: false
    }),
    pd34Prop({ id: 3, op: 'update', status: 'needs_edit' }),
    pd34Prop({
      id: 4,
      op: 'update',
      status: 'approved',
      verification: 'verified',
      needsVerification: false,
      targetEntryId: 9,
      baseVersion: 1
    }),
    pd34Prop({
      id: 5,
      op: 'create',
      status: 'published',
      verification: 'verified',
      needsVerification: false
    })
  ]
  const groups = groupProposalsByOp(list)
  const emptyGroups = groupProposalsByOp([])
  check(
    'PD34：暂存区按新增/修改分组，分组数量与可审核数正确（空组保留）',
    groups.length === 2 &&
      groups[0].id === 'create' &&
      groups[0].label === '新增条目' &&
      groups[0].count === 3 &&
      groups[0].reviewable === 2 &&
      groups[1].id === 'update' &&
      groups[1].label === '修改条目' &&
      groups[1].count === 2 &&
      groups[1].reviewable === 2 &&
      emptyGroups.length === 2 &&
      emptyGroups[0].count === 0 &&
      emptyGroups[1].count === 0,
    JSON.stringify(groups.map((g) => [g.id, g.count, g.reviewable]))
  )

  // 2) 批量发布受影响条目数：可发布 / 阻塞 / 覆盖风险 / 已发布分别计数
  const plan = buildPublishPlan(list)
  check(
    'PD34：发布前统计受影响条目数（可发布 2、阻塞 2、覆盖类 1、已发布 1）',
    plan.selected === 5 &&
      plan.publishable === 2 &&
      plan.blocked === 2 &&
      plan.risky === 1 &&
      plan.alreadyPublished === 1 &&
      plan.publishableIds.join(',') === '2,4' &&
      plan.blockedIds.join(',') === '1,3' &&
      plan.riskyIds.join(',') === '4',
    JSON.stringify(plan)
  )

  // 3) 编辑后接受的补丁校验：trim、空标题/空正文、未改动必须写理由
  const current = {
    kind: 'concept' as const,
    title: '消息传递',
    body: '消息传递聚合邻居表示。'
  }
  const draftOk = buildEditAcceptPatch(current, {
    title: '  消息传递（补充）  ',
    body: ' 消息传递聚合邻居表示，并堆叠多层。 ',
    reason: ' 补充层级说明 '
  })
  const draftNoop = buildEditAcceptPatch(current, {
    title: current.title,
    body: current.body
  })
  const draftEmpty = buildEditAcceptPatch(current, {
    title: '   ',
    body: current.body,
    reason: 'x'
  })
  check(
    'PD34：编辑后接受的补丁校验（trim、空标题报错、未改动需理由）',
    draftOk.ok &&
      draftOk.patch?.content.title === '消息传递（补充）' &&
      draftOk.patch?.content.body === '消息传递聚合邻居表示，并堆叠多层。' &&
      draftOk.patch?.reason === '补充层级说明' &&
      !draftNoop.ok &&
      draftNoop.errors.join('').includes('内容未修改') &&
      !draftEmpty.ok &&
      draftEmpty.errors.join('').includes('标题不能为空'),
    JSON.stringify({ noop: draftNoop.errors, empty: draftEmpty.errors })
  )

  const schemaPath = fileURLToPath(new URL('../src/main/db/schema.sql', import.meta.url))
  const schemaSql = readFileSync(schemaPath, 'utf8')
  const stamp = '2026-11-03T00:00:00.000Z'
  const makeDb = (): any => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(schemaSql)
    migrate(db as never)
    db.prepare('INSERT INTO items (key, title, date_added, date_modified) VALUES (?, ?, ?, ?)').run(
      'item-pd34',
      '论文 PD34',
      stamp,
      stamp
    )
    return db
  }
  const evidence = [
    {
      sourceType: 'paper' as const,
      itemId: 1,
      pageIndex: 2,
      quote: '暂存区提案必须人工审核后才能发布。',
      sectionPath: '3 审核'
    }
  ]

  const db = makeDb()
  const batch = createBatch(db, { title: 'PD34 审核批次', task: 'extract' })
  const pending = createProposal(db, batch.id, {
    op: 'create',
    itemId: 1,
    content: { kind: 'note', title: '未审核条目', body: '仅存在于提案中。' },
    contentNature: 'ai_suggestion',
    sourceType: 'paper',
    evidence,
    reason: '来自论文 §3'
  })

  // 4) 未审核内容不可见：提案存在、正式条目为空；接受但未发布仍不可见
  const visibleBefore = listEntries(db, {})
  const acceptedOnly = acceptProposal(db, pending.id, { reason: '先接受但尚未发布' })
  const visibleAccepted = listEntries(db, {})
  check(
    'PD34：未审核/仅接受的提案不进入正式条目（listEntries 为空）',
    pending.verification === 'verified' &&
      acceptedOnly.status === 'approved' &&
      visibleBefore.length === 0 &&
      visibleAccepted.length === 0 &&
      pd33CountRows(db, 'knowledge_entries') === 0 &&
      pd33CountRows(db, 'knowledge_versions') === 0,
    `before=${visibleBefore.length} accepted=${visibleAccepted.length}`
  )

  // 5) 编辑后接受：补丁写入提案、留 edit_accept 记录，仍不写正式条目
  const editPatch = buildEditAcceptPatch(
    { kind: 'note', title: '未审核条目', body: '仅存在于提案中。' },
    {
      title: '未审核条目（已改写）',
      body: '改写后的正文，来自人工审核。',
      reason: '人工补全正文'
    }
  )
  const edited = editAndAccept(db, pending.id, {
    content: editPatch.patch?.content,
    reason: editPatch.patch?.reason
  })
  const editedDetail = getProposalDetail(db, pending.id)
  check(
    'PD34：编辑后接受把人工改写写入提案并留痕（不写正式条目）',
    editPatch.ok &&
      edited.status === 'approved' &&
      editedDetail !== null &&
      editedDetail.content.title === '未审核条目（已改写）' &&
      editedDetail.reviews.some((r) => r.action === 'edit_accept') &&
      listEntries(db, {}).length === 0
  )

  // 6) 发布：写入正式条目，暂存区状态立即刷新且已发布提案不再显示
  const published = publishBatch(db, { batchId: batch.id, proposalIds: [pending.id] })
  const notice = describePublishResult(published)
  const visibleAfter = listEntries(db, {})
  const afterAccept = applyProposalStatus(list, 1, 'approved')
  const afterPublish = selectStagingProposals(
    applyPublishedProposals(afterAccept, published.publishedProposalIds)
  )
  check(
    'PD34：发布后正式条目可检索，暂存区立即刷新并移除已发布提案',
    published.ok === true &&
      published.publishedProposalIds.length === 1 &&
      visibleAfter.length === 1 &&
      visibleAfter[0].title === '未审核条目（已改写）' &&
      afterAccept.find((p) => p.id === 1)?.status === 'approved' &&
      afterPublish.length === 3 &&
      !afterPublish.some((p) => p.id === 1) &&
      !afterPublish.some((p) => p.id === 5) &&
      groupProposalsByOp(afterPublish)[0].count === 1 &&
      notice.ok &&
      notice.tone === 'ok' &&
      notice.message.includes('已发布 1 条提案'),
    JSON.stringify({
      published: published.publishedProposalIds,
      notice: notice.message,
      visible: visibleAfter.map((e) => e.title),
      afterAccept: afterAccept.find((p) => p.id === 1)?.status,
      afterPublish: afterPublish.map((p) => p.id),
      createCount: groupProposalsByOp(afterPublish)[0].count
    })
  )

  // 7) 版本冲突：审核期间条目被另一条提案改写 → 发布被拒并点名冲突原因
  const entryId = published.entryIds[0]
  const conflictBatch = createBatch(db, { title: 'PD34 修订批次', task: 'update' })
  const updateA = createProposal(db, conflictBatch.id, {
    op: 'update',
    itemId: 1,
    targetEntryId: entryId,
    baseVersion: 1,
    content: { kind: 'note', title: '未审核条目（修订 A）', body: 'A 正文。' },
    contentNature: 'user_decision',
    sourceType: 'paper',
    evidence,
    reason: '修订 A'
  })
  const updateB = createProposal(db, conflictBatch.id, {
    op: 'update',
    itemId: 1,
    targetEntryId: entryId,
    baseVersion: 1,
    content: { kind: 'note', title: '未审核条目（修订 B）', body: 'B 正文。' },
    contentNature: 'user_decision',
    sourceType: 'paper',
    evidence,
    reason: '修订 B'
  })
  acceptProposal(db, updateA.id, { reason: '接受修订 A' })
  acceptProposal(db, updateB.id, { reason: '接受修订 B' })
  const firstUpdate = publishBatch(db, { batchId: conflictBatch.id, proposalIds: [updateA.id] })
  const conflicted = publishBatch(db, { batchId: conflictBatch.id, proposalIds: [updateB.id] })
  const conflictViews = describePublishConflicts(conflicted.conflicts)
  const conflictNotice = describePublishResult(conflicted)
  check(
    'PD34：版本冲突发布被拒并给出具体原因（当前版本 vs 提案基线）',
    firstUpdate.ok === true &&
      conflicted.ok === false &&
      conflictViews.length === 1 &&
      conflictViews[0].kind === 'version_conflict' &&
      conflictViews[0].message.includes('版本冲突') &&
      conflictViews[0].message.includes('v2') &&
      conflictNotice.ok === false &&
      conflictNotice.tone === 'error' &&
      conflictNotice.message.includes('版本冲突'),
    JSON.stringify(conflictViews)
  )

  db.close()
}

/**
 * PD35：暂存区审核动作的理由处理。
 * 背景：界面「接受」不填理由，IPC 曾把 undefined 合成为 ''，optionalText('') 抛
 * 「无效的审核理由：不能为空」→ 接受必然失败。本组用例锁死三条语义：
 *   1) optionalText 对空串/纯空白按「未提供」返回 null，requireText 仍拒空串；
 *   2) 接受 / 编辑后接受在理由为空时写可识别的审计占位，不丢记录、不写 null；
 *   3) 拒绝仍在服务层必填理由，缺理由直接失败且不产生任何审计记录。
 */
function pd35KnowledgeReviewTests(): void {
  // 1) 校验语义：空串=未提供；必填仍拒空串
  const emptyOptionalIsNull = knowledgeValidation.optionalText('', '审核理由', 20) === null
  const blankOptionalIsNull = knowledgeValidation.optionalText('   ', '审核理由', 20) === null
  const trimmedOptional = knowledgeValidation.optionalText('  有理由  ', '审核理由', 20) === '有理由'
  const emptyRequiredError = throws(() => knowledgeValidation.requireText('', '拒绝理由', 20))
  const blankRequiredError = throws(() => knowledgeValidation.requireText('   ', '拒绝理由', 20))
  const badTypeError = throws(() => knowledgeValidation.optionalText(42, '审核理由', 20))
  check(
    'PD35：optionalText 把空串/纯空白视为未提供，requireText 仍拒空串',
    emptyOptionalIsNull &&
      blankOptionalIsNull &&
      trimmedOptional &&
      emptyRequiredError !== null &&
      emptyRequiredError.includes('拒绝理由') &&
      emptyRequiredError.includes('不能为空') &&
      blankRequiredError !== null &&
      blankRequiredError.includes('不能为空') &&
      badTypeError !== null &&
      badTypeError.includes('无效的审核理由'),
    JSON.stringify({ emptyRequiredError, badTypeError })
  )

  const schemaPath = fileURLToPath(new URL('../src/main/db/schema.sql', import.meta.url))
  const schemaSql = readFileSync(schemaPath, 'utf8')
  const stamp = '2026-11-03T00:00:00.000Z'
  const makeDb = (): any => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(schemaSql)
    migrate(db as never)
    db.prepare('INSERT INTO items (key, title, date_added, date_modified) VALUES (?, ?, ?, ?)').run(
      'item-pd35',
      '论文 PD35',
      stamp,
      stamp
    )
    return db
  }
  const evidence = [
    {
      sourceType: 'paper' as const,
      itemId: 1,
      pageIndex: 3,
      quote: '接受与拒绝都必须留下可追溯的审计记录。',
      sectionPath: '4 审核留痕'
    }
  ]
  const mkProposal = (db: any, batchId: number, title: string): any =>
    createProposal(db, batchId, {
      op: 'create',
      itemId: 1,
      content: { kind: 'note', title, body: `${title}的正文。` },
      contentNature: 'ai_suggestion',
      sourceType: 'paper',
      evidence,
      reason: 'PD35 审核用例'
    })

  const db = makeDb()
  const batch = createBatch(db, { title: 'PD35 审核批次', task: 'extract' })

  // 2) 接受：界面不填理由（空串）必须成功，状态进批次统计，审计落占位
  const acceptProp = mkProposal(db, batch.id, 'PD35 空理由接受')
  const accepted = acceptProposal(db, acceptProp.id, { reason: '' })
  const acceptedDetail = getProposalDetail(db, acceptProp.id)
  const acceptReviews = (acceptedDetail?.reviews ?? []).filter((r) => r.action === 'accept')
  const batchAfterAccept = getBatch(db, batch.id)
  check(
    'PD35：接受可带空理由成功（状态 approved、批次统计 approved=1、审计写占位理由）',
    accepted.status === 'approved' &&
      acceptReviews.length === 1 &&
      acceptReviews[0].reason === ACCEPT_REASON_PLACEHOLDER &&
      acceptReviews[0].reviewer === 'user' &&
      acceptReviews[0].createdAt.trim() !== '' &&
      batchAfterAccept.counts.approved === 1 &&
      batchAfterAccept.counts.pending === 0,
    JSON.stringify({
      status: accepted.status,
      reviews: acceptedDetail?.reviews,
      counts: batchAfterAccept.counts
    })
  )

  // 3) 接受：界面完全不传 reason（undefined 透传）同样成功，占位可识别
  const undefProp = mkProposal(db, batch.id, 'PD35 缺省理由接受')
  const acceptedUndef = acceptProposal(db, undefProp.id)
  const undefReviews = (getProposalDetail(db, undefProp.id)?.reviews ?? []).filter(
    (r) => r.action === 'accept'
  )
  check(
    'PD35：接受缺省理由（undefined）同样成功且审计占位可识别',
    acceptedUndef.status === 'approved' &&
      undefReviews.length === 1 &&
      undefReviews[0].reason === ACCEPT_REASON_PLACEHOLDER,
    JSON.stringify({ status: acceptedUndef.status, reviews: undefReviews })
  )

  // 4) 拒绝：服务层仍必填理由 → 空串/纯空白都失败，且状态与审计都不变
  const rejectProp = mkProposal(db, batch.id, 'PD35 拒绝用例')
  const rejectNoReason = throws(() => rejectProposal(db, rejectProp.id, { reason: '' }))
  const rejectBlankReason = throws(() => rejectProposal(db, rejectProp.id, { reason: '   ' }))
  const rejectAfterFailure = getProposalDetail(db, rejectProp.id)
  check(
    'PD35：拒绝缺理由被拒（状态不变、不产生审计记录）',
    rejectNoReason !== null &&
      rejectNoReason.includes('拒绝理由') &&
      rejectNoReason.includes('不能为空') &&
      rejectBlankReason !== null &&
      rejectBlankReason.includes('不能为空') &&
      rejectAfterFailure?.status === 'pending_review' &&
      (rejectAfterFailure?.reviews.length ?? -1) === 0,
    JSON.stringify({
      rejectNoReason,
      rejectBlankReason,
      status: rejectAfterFailure?.status,
      reviews: rejectAfterFailure?.reviews.length
    })
  )

  // 5) 拒绝：界面填写理由（带首尾空白）→ 拒绝成功，审计记录里是 trim 后的用户理由
  const rejected = rejectProposal(db, rejectProp.id, {
    reason: '  来源未定位到原文，退回补充  '
  })
  const rejectReviews = (getProposalDetail(db, rejectProp.id)?.reviews ?? []).filter(
    (r) => r.action === 'reject'
  )
  check(
    'PD35：拒绝带理由成功，审计记录保留用户填写的理由/reviewer/时间',
    rejected.status === 'rejected' &&
      rejectReviews.length === 1 &&
      rejectReviews[0].reason === '来源未定位到原文，退回补充' &&
      rejectReviews[0].reviewer === 'user' &&
      rejectReviews[0].createdAt.trim() !== '',
    JSON.stringify({ status: rejected.status, reviews: rejectReviews })
  )

  // 6) 编辑后接受：空理由成功，内容写入、留 edit_accept、edited_patch_json 非空
  const editProp = mkProposal(db, batch.id, 'PD35 编辑前标题')
  const edited = editAndAccept(db, editProp.id, {
    content: { kind: 'note', title: 'PD35 编辑后标题', body: '人工改写后的正文。' },
    reason: ''
  })
  const editedDetail = getProposalDetail(db, editProp.id)
  const editReviews = (editedDetail?.reviews ?? []).filter((r) => r.action === 'edit_accept')
  check(
    'PD35：编辑后接受可带空理由成功（内容落库、edit_accept 留痕、editedPatch 非空）',
    edited.status === 'approved' &&
      editedDetail !== null &&
      editedDetail.content.title === 'PD35 编辑后标题' &&
      editReviews.length === 1 &&
      editReviews[0].reason === EDIT_ACCEPT_REASON_PLACEHOLDER &&
      editReviews[0].reviewer === 'user' &&
      editReviews[0].editedPatch !== null &&
      (editReviews[0].editedPatch as any)?.content?.title === 'PD35 编辑后标题' &&
      editReviews[0].createdAt.trim() !== '',
    JSON.stringify({ status: edited.status, title: editedDetail?.content.title, reviews: editReviews })
  )

  // 7) 审计完整性：四条审核动作都有 action / 非空 reason / reviewer / 时间，一条不丢
  const allReviews = db
    .prepare('SELECT action, reason, reviewer, created_at FROM proposal_reviews ORDER BY id ASC')
    .all() as any[]
  check(
    'PD35：审计记录完整（accept/accept/reject/edit_accept 四条，理由均非空可识别）',
    allReviews.length === 4 &&
      allReviews.map((r) => r.action).join(',') === 'accept,accept,reject,edit_accept' &&
      allReviews.every(
        (r) =>
          typeof r.reason === 'string' &&
          r.reason.trim() !== '' &&
          r.reason !== 'null' &&
          r.reviewer === 'user' &&
          typeof r.created_at === 'string' &&
          r.created_at.trim() !== ''
      ),
    JSON.stringify(allReviews)
  )

  db.close()
}

/**
 * PD36：知识库 / 暂存区入口与「什么数据会进来」的说明文案。
 * 文案本身是产品承诺，所以按精确字符串断言；空态按四种状态分支断言，
 * 避免再出现「没选批次却提示该批次没有提案」的语义错位。
 */
function pd36EntryVisibilityTests(): void {
  // 1) 暂存区三类来源：顺序、精确 label、producer/detail 均有内容
  check(
    'PD36：暂存区三来源精确为 论文拆解 / 批处理整理 / AI 助手提案 且说明非空',
    STAGING_SOURCE_GUIDES.length === 3 &&
      STAGING_SOURCE_GUIDES.map((guide) => guide.id).join(',') === 'analysis,batch,assistant' &&
      STAGING_SOURCE_GUIDES.map((guide) => guide.label).join(',') ===
        '论文拆解,批处理整理,AI 助手提案' &&
      STAGING_SOURCE_GUIDES.every(
        (guide) => guide.producer.trim() !== '' && guide.detail.trim() !== ''
      ),
    JSON.stringify(STAGING_SOURCE_GUIDES)
  )

  check(
    'PD36：暂存区范围说明写明「只存提案、显式发布后才进知识库」',
    STAGING_SCOPE_NOTE.includes('提案') &&
      STAGING_SCOPE_NOTE.includes('发布') &&
      STAGING_SCOPE_NOTE.includes('知识库'),
    STAGING_SCOPE_NOTE
  )

  // 2) 暂存区空态四分支（PD51 起只保留标题 + 一句说明，不再有步骤引导）
  const noBatch = stagingEmptyState({ batchCount: 0, hasActiveBatch: false, proposalCount: 0 })
  check(
    'PD36：无批次时空态说明数据从哪来并给出下一步',
    noBatch !== null &&
      noBatch.title.trim() !== '' &&
      noBatch.detail.trim() !== '' &&
      noBatch.detail.includes('知识库'),
    JSON.stringify(noBatch)
  )

  const noActive = stagingEmptyState({ batchCount: 2, hasActiveBatch: false, proposalCount: 0 })
  check(
    'PD36：有批次但未选中时提示先选批次（不再误报「该批次没有提案」）',
    noActive !== null &&
      noActive.title !== noBatch?.title &&
      !noActive.title.includes('该批次没有') &&
      noActive.detail.trim() !== '',
    JSON.stringify(noActive)
  )

  const emptyBatch = stagingEmptyState({ batchCount: 2, hasActiveBatch: true, proposalCount: 0 })
  check(
    'PD36：选中批次但无提案时给出独立文案',
    emptyBatch !== null &&
      emptyBatch.title !== noBatch?.title &&
      emptyBatch.title !== noActive?.title &&
      emptyBatch.detail.trim() !== '',
    JSON.stringify(emptyBatch)
  )

  check(
    'PD36：批次里有提案时不再显示空态',
    stagingEmptyState({ batchCount: 1, hasActiveBatch: true, proposalCount: 3 }) === null
  )

  // 3) 知识库空态：把用户引到「暂存区 → 显式发布」
  const emptyKnowledge = knowledgeEmptyState(0)
  check(
    'PD36：知识库空态指向暂存区与显式发布',
    emptyKnowledge !== null &&
      emptyKnowledge.title.trim() !== '' &&
      emptyKnowledge.steps.some((step) => step.includes('暂存区')) &&
      emptyKnowledge.steps.some((step) => step.includes('发布')),
    JSON.stringify(emptyKnowledge)
  )

  check(
    'PD36：知识库有条目时不显示空态',
    knowledgeEmptyState(1) === null && knowledgeEmptyState(250) === null
  )
}

/**
 * PD51：暂存区一键批准 / 导入自动归属 / 长文本。
 * 统计聚合、禁用判断、导入归属都抽成 shared/api.ts 纯函数在这里断言，
 * 保证 UI 只做编排，不会把「跳过 / 失败」算成成功；另加源码级断言防止
 * 解释块、五步引导、条目选择器被悄悄加回来。
 */
function pd51StagingPanelTests(): void {
  console.log('PD51 暂存区一键批准 / 导入自动归属')
  let seq = 0
  const proposal = (
    overrides: Partial<KnowledgeProposalSummary> = {}
  ): KnowledgeProposalSummary => {
    seq += 1
    return {
      id: seq,
      key: `pd51-${seq}`,
      batchId: 1,
      itemId: 7,
      op: 'create',
      status: 'pending_review',
      verification: 'verified',
      kind: 'concept',
      title: `提案 ${seq}`,
      contentNature: 'author_claim',
      sourceType: 'note',
      sourceRef: {},
      contentHash: `pd51-hash-${seq}`,
      targetEntryId: null,
      targetKey: null,
      baseVersion: null,
      reason: 'PD51 测试',
      needsVerification: false,
      problems: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides
    }
  }

  // 1) 统计聚合：待审 + 已核验 → 先接受再发布；未核验 → 失败；已发布 / 已拒绝 → 跳过
  const pending = proposal({ title: '待审已核验' })
  const unverified = proposal({ title: '待审未核验', verification: 'pending' })
  const published = proposal({ title: '已发布', status: 'published' })
  const rejected = proposal({ title: '已拒绝', status: 'rejected' })
  const plan = buildApproveAllPlan([pending, unverified, published, rejected])
  check(
    'PD51：一键批准计划 = 待审数 / 先接受 / 可发布 / 跳过 / 阻塞',
    plan.pending === 2 &&
      plan.acceptIds.length === 1 &&
      plan.acceptIds[0] === pending.id &&
      plan.publishableIds.length === 1 &&
      plan.publishableIds[0] === pending.id &&
      plan.blocked.length === 1 &&
      plan.blocked[0].id === unverified.id &&
      plan.skippedIds.length === 2 &&
      plan.skippedIds.includes(published.id) &&
      plan.skippedIds.includes(rejected.id),
    JSON.stringify(plan)
  )

  const approved = proposal({ title: '已接受', status: 'approved' })
  const acceptedPlan = buildApproveAllPlan([approved])
  check(
    'PD51：已接受且已核验的提案不再重复接受，直接发布',
    acceptedPlan.acceptIds.length === 0 && acceptedPlan.publishableIds[0] === approved.id,
    JSON.stringify(acceptedPlan)
  )

  // 2) 无待审时按钮禁用判断
  check('PD51：有待审时按钮可用', approveAllDisabledTitle(plan) === null)
  const noPendingDisabled = approveAllDisabledTitle(
    buildApproveAllPlan([published, rejected])
  )
  check(
    'PD51：无待审时按钮禁用并给出原因',
    typeof noPendingDisabled === 'string' && noPendingDisabled.includes('待审'),
    String(noPendingDisabled)
  )
  const acceptedOnly = approveAllDisabledTitle(buildApproveAllPlan([approved]))
  check(
    'PD51：只剩已接受提案时提示走「发布所选」',
    typeof acceptedOnly === 'string' && acceptedOnly.includes('发布所选'),
    String(acceptedOnly)
  )

  // 3) 确认文案带当前待审条数与将发生的动作
  const confirm = describeApproveAllConfirm(plan)
  check(
    'PD51：确认文案含待审条数、接受与发布说明',
    confirm.includes('全部 2 条待审提案') &&
      confirm.includes('先接受其中 1 条') &&
      confirm.includes('再一次性发布 1 条') &&
      confirm.includes('1 条来源待核验会记为失败') &&
      confirm.includes('2 条已处理会跳过'),
    confirm
  )

  // 4) 结果聚合：已发布 / 跳过 / 失败计数与可展开明细
  const outcome = buildApproveAllOutcome([pending, unverified, published, rejected], plan, {
    publishedIds: [pending.id],
    failureReasons: []
  })
  check(
    'PD51：结果聚合为 已发布 1 / 跳过 2 / 失败 1，明细 4 条',
    outcome.published === 1 &&
      outcome.skipped === 2 &&
      outcome.failed === 1 &&
      outcome.details.length === 4,
    JSON.stringify(outcome)
  )
  check(
    'PD51：结果文案格式为「已发布 N · 跳过 M · 失败 K」',
    describeApproveAllResult(outcome) === '已发布 1 · 跳过 2 · 失败 1',
    describeApproveAllResult(outcome)
  )
  check(
    'PD51：跳过项写明原因',
    outcome.details
      .filter((detail) => detail.outcome === 'skipped')
      .every((detail) => detail.reason.length > 0)
  )
  const failedOutcome = buildApproveAllOutcome(
    [pending],
    buildApproveAllPlan([pending]),
    { publishedIds: [], failureReasons: [{ id: pending.id, reason: '批次冲突' }] }
  )
  check(
    'PD51：发布失败时进入失败明细并带原因',
    failedOutcome.failed === 1 && failedOutcome.details[0].reason === '批次冲突',
    JSON.stringify(failedOutcome)
  )
  const unpublished = buildApproveAllOutcome(
    [pending],
    buildApproveAllPlan([pending]),
    { publishedIds: [], failureReasons: [] }
  )
  check(
    'PD51：可发布却没出现在结果里也记为失败（不静默丢条）',
    unpublished.failed === 1 && unpublished.published === 0,
    JSON.stringify(unpublished)
  )

  // 5) 导入归属：有当前论文 / 没有当前论文
  const target = resolveStagingImportTarget({
    activeItemId: 7,
    attachmentId: 12,
    items: [{ id: 7, title: '样例论文' }]
  })
  check(
    'PD51：导入自动归属当前论文并带附件',
    target.ok &&
      target.target.itemId === 7 &&
      target.target.attachmentId === 12 &&
      target.target.title === '样例论文',
    JSON.stringify(target)
  )
  const noPaper = resolveStagingImportTarget({
    activeItemId: null,
    items: [{ id: 7, title: '样例论文' }]
  })
  check(
    'PD51：没有当前论文时给出可读提示且不可提交',
    !noPaper.ok && noPaper.reason === STAGING_IMPORT_NO_ACTIVE_PAPER,
    JSON.stringify(noPaper)
  )
  const missing = resolveStagingImportTarget({
    activeItemId: 9,
    items: [{ id: 7, title: '样例论文' }]
  })
  check(
    'PD51：当前论文不在文库时提示重新打开',
    !missing.ok && missing.reason.includes('不在文库列表'),
    JSON.stringify(missing)
  )
  const zeroAttachment = resolveStagingImportTarget({
    activeItemId: 7,
    attachmentId: 0,
    items: [{ id: 7, title: '样例论文' }]
  })
  check(
    'PD51：非法 attachmentId 折叠为 null（不传假附件）',
    zeroAttachment.ok && zeroAttachment.target.attachmentId === null,
    JSON.stringify(zeroAttachment)
  )
  const importText = describeImportResult(
    {
      itemId: 7,
      source: 'note',
      batchId: 3,
      batchKey: 'pd51-import',
      pointCount: 2,
      createdProposals: 2,
      reusedProposals: 0,
      skippedDuplicates: 0
    },
    '样例论文'
  )
  check(
    'PD51：导入结果带上所属论文标题',
    importText.includes('归属论文「样例论文」') && importText.includes('2'),
    importText
  )

  // 6) 源码级：解释块 / 五步引导 / 条目选择器不得回归；工具栏与 silent 刷新必须存在
  const tsx = readFileSync(
    fileURLToPath(new URL('../src/renderer/src/features/knowledge/StagingPanel.tsx', import.meta.url)),
    'utf8'
  ).replace(/\r\n/g, '\n')
  const css = readFileSync(
    fileURLToPath(new URL('../src/renderer/src/styles.css', import.meta.url)),
    'utf8'
  ).replace(/\r\n/g, '\n')
  check(
    'PD51：暂存区不再渲染解释段落与五步引导',
    !tsx.includes('staging-empty-steps') &&
      !tsx.includes('STAGING_SCOPE_NOTE') &&
      !tsx.includes('STAGING_SOURCE_GUIDES') &&
      !tsx.includes('data-testid="staging-sources"')
  )
  check(
    'PD51：工具栏 / 一键批准 / 结果 / 确认入口齐全',
    tsx.includes('data-testid="staging-toolbar"') &&
      tsx.includes('data-testid="staging-approve-all"') &&
      tsx.includes('data-testid="staging-approve-all-result"') &&
      tsx.includes('data-testid="staging-approve-all-confirm"') &&
      tsx.includes('data-testid="staging-approve-all-detail"')
  )
  check(
    'PD51：导入表单不再让用户选择条目',
    !tsx.includes('staging-import-item') && tsx.includes('staging-import-target')
  )
  check(
    'PD51：逐条接受与批量对账的刷新都走 silent（不整表 loading）',
    tsx.includes('bulkApproveRef') &&
      /loadProposals\([^)]*silent:\s*true/s.test(tsx) &&
      !/setLoading\(true\)[\s\S]{0,200}onKnowledgeChanged/.test(tsx)
  )

  const blockOf = (selector: string): string => {
    const at = css.indexOf(`\n${selector} {`)
    if (at < 0) return ''
    const start = at + 1
    const end = css.indexOf('}', start)
    return css.slice(start, end + 1)
  }
  const metaStart = css.indexOf('.stage-batch__meta,')
  const metaBlock =
    metaStart < 0 ? '' : css.slice(metaStart, css.indexOf('}', metaStart) + 1)
  check(
    'PD51：长标题在样式层换行（.stage-item__title / .stage-batch__meta）',
    blockOf('.stage-item__title').includes('overflow-wrap: anywhere') &&
      metaBlock.includes('overflow-wrap: anywhere'),
    blockOf('.stage-item__title') + metaBlock
  )
}

/**
 * PD37：问答面板空态功能按键（预设提示）。
 * 按键顺序、文案与写入输入框的提示都会直接呈现在界面上，且提示属产品文案，
 * 因此按精确字符串断言；改文案必须同步这里，避免按钮与提示静默漂移。
 */
function pd37AiPresetTests(): void {
  const requiredKeys = ['overview', 'method', 'results', 'limitations', 'related', 'term']
  const requiredLabels = ['论文概要', '方法拆解', '实验结果', '研究局限', '相关文献', '术语解释']
  const keys = AI_PRESETS.map((preset) => preset.key)

  check(
    'PD37：至少 6 个功能按键，且覆盖 论文概要/方法拆解/实验结果/研究局限/相关文献/术语解释',
    AI_PRESETS.length >= 6 && requiredKeys.every((key) => keys.includes(key)),
    JSON.stringify(keys)
  )

  check(
    'PD37：六个按键的文案与顺序精确匹配验收要求',
    requiredKeys.every((key, i) => presetFor(key)?.label === requiredLabels[i]),
    JSON.stringify(AI_PRESETS.map((preset) => preset.label))
  )

  check(
    'PD37：按键 key 唯一且 label/prompt 均为非空文本（无空壳按钮）',
    new Set(keys).size === keys.length &&
      AI_PRESETS.every(
        (preset) => preset.label.trim() !== '' && preset.prompt.trim() !== ''
      ),
    JSON.stringify(AI_PRESETS)
  )

  // 点击按键 → 写入输入框的提示文本：逐条锁定映射（≥6 条）
  const expectedPrompts: Record<string, string> = {
    overview: '请概括当前范围内论文的研究问题、核心方法与主要贡献。',
    method: '请拆解当前范围内论文的方法：整体流程、关键模块与每一步的作用。',
    results: '请总结当前范围内论文的实验结果：数据集、评价指标、关键数值与结论。',
    limitations: '请分析当前范围内论文的研究局限与可改进方向。',
    related: '请列出与当前范围内论文密切相关的代表性工作，并说明关联点。',
    term: '请解释当前范围内论文的关键术语，并给出通俗说明。'
  }
  for (const [key, prompt] of Object.entries(expectedPrompts)) {
    check(
      `PD37：presetFor(${key}) 返回与按键对应的提示文本`,
      presetFor(key)?.prompt === prompt,
      JSON.stringify({ key, got: presetFor(key), expected: prompt })
    )
  }

  check(
    'PD37：未知 key 的 presetFor 返回 null（testid 拼错时安全降级、不写入 undefined）',
    presetFor('nope') === null && presetFor('') === null && presetFor('OVERVIEW') === null
  )
}

/**
 * PD38：论文拆解结果同步到知识库（提案批次）与思维地图（节点）。
 * 两条链路都要求幂等：同一份拆解重复同步不产生重复批次/提案/节点；
 * 知识库只允许生成 pending_review 提案，绝不写 knowledge_entries。
 */
function pd38DigestSyncTests(): void {
  const schemaPath = fileURLToPath(new URL('../src/main/db/schema.sql', import.meta.url))
  const schemaSql = readFileSync(schemaPath, 'utf8')
  const stamp = '2026-11-03T00:00:00.000Z'
  const makeDb = (): any => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(schemaSql)
    migrate(db as never)
    db.prepare('INSERT INTO items (key, title, date_added, date_modified) VALUES (?, ?, ?, ?)').run(
      'item-pd38',
      '论文 PD38',
      stamp,
      stamp
    )
    return db
  }
  // 与 IPC 同一条路径：shared/api 生成计划 → runInTransaction(createBatch+createProposal×N)
  const syncDigestToKnowledge = (
    db: any,
    input: { itemId: number; markdown: string; title?: string | null }
  ): any => runInTransaction(db, () => syncDigestProposals(db, buildDigestKnowledgePlan(input)))
  const markdown = [
    '## 论文拆解',
    '',
    '### 研究问题',
    '现有方法在长文档上丢失跨段引用，导致问答答案缺少出处。',
    '',
    '### 方法设计',
    '提出两阶段检索与引用校验流程，并在生成前做一致性过滤。',
    '',
    '### 实验结果',
    '在三个数据集上 F1 提升 4.2 个点，引用命中率提升 9 个点。',
    ''
  ].join('\n')

  // 1) 共享纯函数：H3 拆点、类型推导、指纹稳定、幂等键
  const points = digestPointsFromMarkdown(markdown)
  check(
    'PD38：拆解 markdown 按 H3 拆成要点并推导条目类型',
    points.length === 3 &&
      points[0].title === '研究问题' &&
      points[0].kind === 'question' &&
      points[1].kind === 'method' &&
      points[2].kind === 'result' &&
      points.every((point) => point.id.startsWith('dg-') && point.body.trim() !== ''),
    JSON.stringify(points)
  )

  const plan = buildDigestKnowledgePlan({ itemId: 1, markdown })
  check(
    'PD38：同一份拆解的指纹稳定，批次幂等键=digest:<itemId>:<指纹>',
    digestFingerprint(points) === digestFingerprint(digestPointsFromMarkdown(markdown)) &&
      plan.fingerprint.length === 16 &&
      plan.batch.idempotencyKey === `digest:1:${plan.fingerprint}` &&
      plan.batch.task === DIGEST_BATCH_TASK &&
      plan.batch.origin === 'ai_workflow' &&
      plan.proposals.length === points.length &&
      plan.proposals.every(
        (proposal) => proposal.sourceType === 'digest' && proposal.op === 'create'
      ),
    JSON.stringify({ fingerprint: plan.fingerprint, batch: plan.batch, proposals: plan.proposals.length })
  )

  // 2) 知识库链路：首次同步只建待审提案，重复同步幂等
  const db = makeDb()
  const entriesBefore = pd33CountRows(db, 'knowledge_entries')
  const first = syncDigestToKnowledge(db, { itemId: 1, markdown })
  const batchesAfterFirst = listBatches(db)
  const proposalsAfterFirst = listProposals(db, { batchId: first.batchId })
  const entriesAfterFirst = pd33CountRows(db, 'knowledge_entries')
  check(
    'PD38：首次同步只创建一个 digest 批次，提案全部 pending_review 且不写正式条目',
    first.createdProposals === points.length &&
      first.reusedProposals === 0 &&
      batchesAfterFirst.length === 1 &&
      batchesAfterFirst[0].task === DIGEST_BATCH_TASK &&
      batchesAfterFirst[0].status !== 'published' &&
      proposalsAfterFirst.length === points.length &&
      proposalsAfterFirst.every(
        (proposal) => proposal.status === 'pending_review' && proposal.sourceType === 'digest'
      ) &&
      entriesAfterFirst === entriesBefore,
    JSON.stringify({
      first,
      tasks: batchesAfterFirst.map((batch) => batch.task),
      batchStatus: batchesAfterFirst[0]?.status,
      proposals: proposalsAfterFirst.map((proposal) => [proposal.status, proposal.sourceType]),
      entriesBefore,
      entriesAfterFirst
    })
  )

  const second = syncDigestToKnowledge(db, { itemId: 1, markdown })
  const batchesAfterSecond = listBatches(db)
  const proposalsAfterSecond = listProposals(db, { batchId: second.batchId })
  check(
    'PD38：重复同步同一份拆解幂等（同批次、零新增提案、返回复用数量）',
    second.batchId === first.batchId &&
      second.batchKey === first.batchKey &&
      second.createdProposals === 0 &&
      second.reusedProposals === points.length &&
      batchesAfterSecond.length === 1 &&
      proposalsAfterSecond.length === points.length &&
      describeDigestSyncResult(second).includes('没有重复写入'),
    JSON.stringify({
      first: { batchId: first.batchId, created: first.createdProposals },
      second,
      batchCount: batchesAfterSecond.length,
      proposalCount: proposalsAfterSecond.length
    })
  )

  // 3) 失败路径：空拆解报可读错误，且不建批次、不写条目
  const failDb = makeDb()
  const emptyError = throws(() => syncDigestToKnowledge(failDb, { itemId: 1, markdown: '   ' }))
  const failBatches = listBatches(failDb)
  const failEntries = pd33CountRows(failDb, 'knowledge_entries')
  check(
    'PD38：空拆解报可读错误且不创建批次、不写条目（既有数据不受影响）',
    emptyError !== null &&
      emptyError.includes('要点') &&
      failBatches.length === 0 &&
      failEntries === 0 &&
      batchSourceLabel(DIGEST_BATCH_TASK) === '论文拆解' &&
      describeDigestSyncResult(first).includes('暂存区'),
    JSON.stringify({ emptyError, batchCount: failBatches.length, failEntries })
  )

  // 4) 思维地图链路：要点写入根节点下，重复合并幂等且不覆盖用户改名
  const doc = createMindMap(1, '论文 PD38')
  const merged = mergeDigestNodes(doc, points)
  const digestNodes = merged.doc.nodes.filter((node) => node.source === MINDMAP_DIGEST_SOURCE)
  check(
    'PD38：拆解要点写入思维地图根节点下（source=digest、数量与要点一致）',
    merged.added === points.length &&
      merged.ids.length === points.length &&
      digestNodes.length === points.length &&
      digestNodes.every(
        (node) => node.parentId === merged.doc.rootId && node.source === MINDMAP_DIGEST_SOURCE
      ) &&
      merged.doc.nodes.filter((node) => node.id === merged.doc.rootId).length === 1,
    JSON.stringify({ added: merged.added, reused: merged.reused, nodes: merged.doc.nodes.length })
  )

  const renamedId = merged.ids[0]
  const renamedDoc = renameNode(merged.doc, renamedId, '我自己改过的标题')
  const manualDoc = addChild(renamedDoc, renamedDoc.rootId, '手工节点')
  const again = mergeDigestNodes(manualDoc, points)
  const renamedNode = again.doc.nodes.find((node) => node.id === renamedId)
  check(
    'PD38：重复同步地图幂等（不重复节点、不覆盖用户改过的标题、保留手工节点）',
    again.added === 0 &&
      again.reused === points.length &&
      again.doc.nodes.length === manualDoc.nodes.length &&
      renamedNode?.text === '我自己改过的标题' &&
      again.doc.nodes.some((node) => node.text === '手工节点') &&
      again.doc.nodes.filter((node) => node.source === MINDMAP_DIGEST_SOURCE).length === points.length,
    JSON.stringify({
      added: again.added,
      reused: again.reused,
      text: renamedNode?.text,
      nodes: again.doc.nodes.length
    })
  )

  // 5) 撤销与重新载入：清除只删 digest 节点，normalizeMindMap 保留来源标记
  const cleared = removeDigestNodes(again.doc)
  const normalized = normalizeMindMap(again.doc as unknown, 1, '论文 PD38')
  check(
    'PD38：清除拆解节点只删 digest 节点（保留根与手工节点），重新载入后来源标记不丢',
    cleared.nodes.some((node) => node.id === cleared.rootId) &&
      cleared.nodes.some((node) => node.text === '手工节点') &&
      cleared.nodes.every((node) => node.source !== MINDMAP_DIGEST_SOURCE) &&
      cleared.nodes.length === again.doc.nodes.length - points.length &&
      normalized.nodes.filter((node) => node.source === MINDMAP_DIGEST_SOURCE).length === points.length,
    JSON.stringify({
      before: again.doc.nodes.length,
      after: cleared.nodes.length,
      normalizedDigest: normalized.nodes.filter((node) => node.source === MINDMAP_DIGEST_SOURCE)
        .length
    })
  )
}

/**
 * PD41：笔记与译文知识化（来源区分 + 提案导入）。
 *
 * 验收覆盖：来源范围条件在 SQL 侧（不先取全库再 JS 过滤）；同一段重复内容只生成
 * 一条提案但可挂多条证据；笔记与译文里的同段内容不重复生成；导入只写 pending_review
 * 提案，绝不写正式条目；接受并发布后条目 source_type / content_hash 与提案一致；
 * AI 工具层没有导入通道（导入只能由界面触发）。
 */
function pd41ImportTests(): void {
  const schemaSql = readFileSync(
    fileURLToPath(new URL('../src/main/db/schema.sql', import.meta.url)),
    'utf8'
  )
  const stamp = '2026-11-03T00:00:00.000Z'
  const dataDir = mkdtempSync(join(tmpdir(), 'pd41-import-'))
  const writeText = (rel: string, body: string): void => {
    const abs = join(dataDir, ...rel.split('/'))
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body, 'utf8')
  }

  // 同一段正文在笔记里写了两遍；另一语言译文里也出现一次 → 证据合并与跨来源去重用例
  const sharedParagraph = '这篇论文的核心论点是长文档问答必须先检索再生成，否则引用会漂移。'
  writeText(
    'notes/n1.md',
    ['---', 'title: 我的阅读笔记', '---', '', sharedParagraph, '', sharedParagraph, ''].join('\n')
  )
  writeText(
    'notes/n2.md',
    [
      '## 方法',
      '',
      '两阶段检索：先用稀疏召回，再用交叉编码器重排，降低长文噪声。',
      '',
      '## 结果',
      '',
      '三个数据集上 F1 提升 4.2 个点，引用命中率提升 9 个点。',
      ''
    ].join('\n')
  )
  writeText('notes/other.md', '这条笔记属于另一篇文献，PD41 的范围查询不应该把它选进来。\n')
  writeText('translated/a1.zh.md', '## 摘要\n\n本文提出两阶段检索流程，并在生成前做引用一致性校验。\n')
  writeText('translated/a1.en.md', `${sharedParagraph}\n`)
  writeText('translated/a1.failed.md', '这条译文没有跑完，导入时必须跳过，不能当成已完成译文。\n')
  writeText('translated/a2.zh.md', '这篇译文属于另一篇文献，PD41 的范围查询不应该把它选进来。\n')

  const makeDb = (): any => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(schemaSql)
    migrate(db as never)
    const item = db.prepare(
      'INSERT INTO items (id, key, title, date_added, date_modified) VALUES (?, ?, ?, ?, ?)'
    )
    item.run(1, 'item-pd41-a', '论文 PD41 A', stamp, stamp)
    item.run(2, 'item-pd41-b', '论文 PD41 B', stamp, stamp)
    const attachment = db.prepare(
      'INSERT INTO attachments (id, key, item_id, path, date_added) VALUES (?, ?, ?, ?, ?)'
    )
    attachment.run(1, 'att-pd41-a', 1, 'a.pdf', stamp)
    attachment.run(2, 'att-pd41-b', 2, 'b.pdf', stamp)
    const note = db.prepare(
      'INSERT INTO notes (key, item_id, title, md_path, date_added, date_modified) VALUES (?, ?, ?, ?, ?, ?)'
    )
    note.run('n1', 1, '我的阅读笔记', 'notes/n1.md', stamp, stamp)
    note.run('n2', 1, '方法与结果', 'notes/n2.md', stamp, stamp)
    note.run('n3', 2, '另一篇文献的笔记', 'notes/other.md', stamp, stamp)
    const translation = db.prepare(
      'INSERT INTO translations (key, attachment_id, lang, path, md_path, status, date_added) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    translation.run('a1.zh', 1, 'zh', 'a1.zh.html', 'a1.zh.md', 'done', stamp)
    translation.run('a1.en', 1, 'en', 'a1.en.html', 'a1.en.md', 'done', stamp)
    translation.run('a1.failed', 1, 'zh', 'a1.failed.html', 'a1.failed.md', 'failed', stamp)
    translation.run('a1.null', 1, 'zh', 'a1.null.html', null, 'done', stamp)
    translation.run('a2.zh', 2, 'zh', 'a2.zh.html', 'a2.zh.md', 'done', stamp)
    return db
  }
  const db = makeDb()

  // 1) 来源读取：范围条件在 SQL 侧，另一篇文献的笔记/译文不会进来
  const noteSources = collectItemImportSources(db, dataDir, 1, 'note')
  check(
    'PD41：笔记来源只取目标条目（SQL 侧 WHERE item_id，另一篇文献的笔记不进计划）',
    noteSources.sources.length === 2 &&
      noteSources.skippedEmpty === 0 &&
      noteSources.sources.every(
        (source) => source.sourceType === 'note' && source.attachmentId === null
      ) &&
      noteSources.sources
        .map((source) => source.refId)
        .sort()
        .join(',') === '1,2' &&
      !noteSources.sources.some((source) => source.body.includes('另一篇文献')),
    JSON.stringify({
      count: noteSources.sources.length,
      refIds: noteSources.sources.map((source) => source.refId)
    })
  )

  const translationSources = collectItemImportSources(db, dataDir, 1, 'translation')
  check(
    'PD41：译文来源只取目标条目下 status=done 且有 md_path 的译文（SQL 侧 JOIN attachments）',
    translationSources.sources.length === 2 &&
      translationSources.sources.every(
        (source) => source.sourceType === 'translation' && source.attachmentId === 1
      ) &&
      translationSources.sources
        .map((source) => source.lang)
        .sort()
        .join(',') === 'en,zh' &&
      !translationSources.sources.some(
        (source) => source.refId === 3 || source.refId === 4 || source.refId === 5
      ),
    JSON.stringify({
      count: translationSources.sources.length,
      refIds: translationSources.sources.map((source) => source.refId)
    })
  )

  // 2) 计划：note 来源、observation 性质、document 精度；同段只一条提案多证据
  const notePlan = buildImportKnowledgePlan({
    itemId: 1,
    source: 'note',
    sources: noteSources.sources
  })
  const plannedProposals = notePlan.proposals
  const mergedPlanned = plannedProposals.find((proposal) => proposal.content.body === sharedParagraph)
  check(
    'PD41：笔记计划生成 note 来源提案（observation、document 精度、origin=import、幂等键）',
    notePlan.batch.task === NOTE_IMPORT_BATCH_TASK &&
      notePlan.batch.origin === 'import' &&
      notePlan.batch.scopeType === 'item' &&
      notePlan.batch.scopeRef === '1' &&
      notePlan.fingerprint.length === 64 &&
      notePlan.batch.idempotencyKey === `import:note:1:${notePlan.fingerprint}` &&
      notePlan.skippedDuplicates === 0 &&
      plannedProposals.length === 3 &&
      plannedProposals.every((proposal) => {
        const evidence = proposal.evidence ?? []
        return (
          proposal.sourceType === 'note' &&
          proposal.contentNature === 'observation' &&
          proposal.op === 'create' &&
          evidence.length > 0 &&
          evidence.every((one) => one.precision === 'document' && one.itemId === 1)
        )
      }),
    JSON.stringify({ batch: notePlan.batch, proposals: plannedProposals.length })
  )
  check(
    'PD41：同一笔记里重复的段落只生成一条提案，但挂多条证据',
    mergedPlanned !== undefined &&
      plannedProposals.filter((proposal) => proposal.content.body === sharedParagraph).length === 1 &&
      (mergedPlanned.evidence ?? []).length === 2 &&
      mergedPlanned.sourceRef?.['noteId'] === 1,
    JSON.stringify({ evidence: (mergedPlanned?.evidence ?? []).length })
  )

  // 3) 落库：只写 pending_review 提案，不写正式条目；重复导入幂等
  const entriesBefore = pd33CountRows(db, 'knowledge_entries')
  const noteResult = runInTransaction(db, () => syncImportProposals(db, notePlan))
  const batchesAfterNote = listBatches(db)
  const storedNoteProposals = listProposals(db, { batchId: noteResult.batchId })
  check(
    'PD41：导入只创建 1 个 note 批次与 pending_review 提案，不写正式条目',
    noteResult.createdProposals === plannedProposals.length &&
      noteResult.reusedProposals === 0 &&
      noteResult.skippedDuplicates === 0 &&
      batchesAfterNote.length === 1 &&
      batchesAfterNote[0].task === NOTE_IMPORT_BATCH_TASK &&
      storedNoteProposals.length === plannedProposals.length &&
      storedNoteProposals.every(
        (proposal) =>
          proposal.status === 'pending_review' &&
          proposal.sourceType === 'note' &&
          /^[0-9a-f]{64}$/.test(proposal.contentHash)
      ) &&
      pd33CountRows(db, 'knowledge_entries') === entriesBefore,
    JSON.stringify({
      noteResult,
      batchCount: batchesAfterNote.length,
      statuses: storedNoteProposals.map((proposal) => proposal.status),
      entriesBefore,
      entriesAfter: pd33CountRows(db, 'knowledge_entries')
    })
  )

  const noteAgain = runInTransaction(db, () => syncImportProposals(db, notePlan))
  check(
    'PD41：重复导入同一份笔记幂等（同批次、零新增、返回复用数量）',
    noteAgain.batchId === noteResult.batchId &&
      noteAgain.createdProposals === 0 &&
      noteAgain.reusedProposals === plannedProposals.length &&
      listBatches(db).length === 1 &&
      listProposals(db, { batchId: noteResult.batchId }).length === plannedProposals.length,
    JSON.stringify(noteAgain)
  )

  // 4) 译文导入 + 跨来源同段去重（笔记已导入的那一段不再生成提案）
  const translationPlan = buildImportKnowledgePlan({
    itemId: 1,
    source: 'translation',
    sources: translationSources.sources
  })
  const translationResult = runInTransaction(db, () => syncImportProposals(db, translationPlan))
  const storedTranslationProposals = listProposals(db, { batchId: translationResult.batchId })
  check(
    'PD41：译文导入生成 translation/author_claim 提案，且与笔记同段内容不重复生成',
    translationPlan.proposals.length === 2 &&
      translationPlan.proposals.every(
        (proposal) =>
          proposal.sourceType === 'translation' && proposal.contentNature === 'author_claim'
      ) &&
      translationResult.source === 'translation' &&
      translationResult.skippedDuplicates === 1 &&
      translationResult.createdProposals === 1 &&
      storedTranslationProposals.length === 1 &&
      storedTranslationProposals[0].sourceType === 'translation' &&
      listBatches(db).length === 2,
    JSON.stringify({ translationResult, stored: storedTranslationProposals.length })
  )

  // 5) 接受 + 发布：条目 source_type / content_hash 与提案一致
  const storedDetails = storedNoteProposals.map((proposal) => getProposalDetail(db, proposal.id))
  const targetDetail = storedDetails.find((detail) => detail.content.body === sharedParagraph)
  acceptProposal(db, targetDetail!.id, { reason: 'PD41 单测接受' })
  const published = publishBatch(db, {
    batchId: noteResult.batchId,
    proposalIds: [targetDetail!.id]
  })
  const publishedAgain = getProposalDetail(db, targetDetail!.id)
  const entryRow =
    published.entryIds.length === 1
      ? (db
          .prepare('SELECT source_type, content_hash FROM knowledge_entries WHERE id = ?')
          .get(published.entryIds[0]) as any)
      : null
  check(
    'PD41：接受并发布后条目 source_type/content_hash 与提案一致（同一内容指纹）',
    published.ok &&
      published.entryIds.length === 1 &&
      entryRow !== null &&
      entryRow.source_type === 'note' &&
      entryRow.content_hash === targetDetail!.contentHash &&
      publishedAgain.status === 'published' &&
      targetDetail!.contentHash ===
        knowledgeContentHash(
          targetDetail!.content.kind,
          targetDetail!.content.title,
          targetDetail!.content.body
        ) &&
      pd33CountRows(db, 'knowledge_entries') === entriesBefore + 1,
    JSON.stringify({
      ok: published.ok,
      conflicts: published.conflicts,
      entryRow,
      proposalHash: targetDetail!.contentHash
    })
  )

  // 6) AI 工具层没有导入通道；空来源报可读错误且不建空批次
  const importTools = KNOWLEDGE_AI_TOOL_NAMES.filter((name) => /import|note|translation/i.test(name))
  const importExports = Object.keys(knowledgeAiNamespace).filter((name) => /import/i.test(name))
  check(
    'PD41：AI 工具层没有笔记/译文导入工具（导入只能由界面触发）',
    KNOWLEDGE_AI_TOOL_NAMES.length === 2 &&
      importTools.length === 0 &&
      importExports.length === 0 &&
      batchSourceLabel(NOTE_IMPORT_BATCH_TASK) === '我的笔记' &&
      batchSourceLabel(TRANSLATION_IMPORT_BATCH_TASK) === '我的译文',
    JSON.stringify({ tools: [...KNOWLEDGE_AI_TOOL_NAMES], importTools, importExports })
  )

  const emptyNoteError = throws(() =>
    buildImportKnowledgePlan({ itemId: 99, source: 'note', sources: [] })
  )
  const emptyTranslationError = throws(() =>
    buildImportKnowledgePlan({ itemId: 99, source: 'translation', sources: [] })
  )
  const missingSources = collectItemImportSources(db, dataDir, 99, 'note')
  check(
    'PD41：没有笔记/译文时报可读错误且不创建空批次（既有数据不受影响）',
    emptyNoteError !== null &&
      emptyNoteError.includes('暂无笔记') &&
      emptyTranslationError !== null &&
      emptyTranslationError.includes('暂无已翻译段落') &&
      missingSources.sources.length === 0 &&
      listBatches(db).length === 2 &&
      pd33CountRows(db, 'knowledge_entries') === entriesBefore + 1,
    JSON.stringify({ emptyNoteError, emptyTranslationError, batches: listBatches(db).length })
  )

  // 7) 内容指纹：NFKC 规范化 + 标题去空白，全角/半角同哈希
  check(
    'PD41：内容指纹做 NFKC 规范化（全角半角同哈希，可跨来源去重）',
    knowledgeContentHash('note', '标题', 'ＡＢＣ') === knowledgeContentHash('note', '标题', 'ABC') &&
      knowledgeContentHash('note', ' 标题 ', '正文') ===
        knowledgeContentHash('note', '标题', '正文'),
    knowledgeContentHash('note', '标题', 'ＡＢＣ')
  )

  rmSync(dataDir, { recursive: true, force: true })
}

/**
 * PD39：检索范围条件进 SQL（先范围、后排序、再 LIMIT）。
 *
 * search.ts / ai.ts 依赖 electron + better-sqlite3，本脚本无法直接 import；因此这里用
 * 共享构造器 buildScopeSql 生成片段，在 node:sqlite 内存库上真实执行与 search.ts 同形状的
 * chunks_fts 查询复现「A 50 块 / B 3 块、limit=10」场景，再对调用点做源码断言
 * （四源都插入范围片段、searchHybrid 没有附件后置 filter、retrieveGroup 没有 paperIds.has）。
 */
function pd39ScopedSearchTests(): void {
  const schemaSql = readFileSync(
    fileURLToPath(new URL('../src/main/db/schema.sql', import.meta.url)),
    'utf8'
  )
  const stamp = '2026-11-03T00:00:00.000Z'

  const makeDb = (): any => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(schemaSql)
    migrate(db as never)
    return db
  }
  const addItem = (db: any, id: number, key: string, title: string, groupName: string | null = null): void => {
    db.prepare(
      'INSERT INTO items (id, key, title, group_name, date_added, date_modified) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, key, title, groupName, stamp, stamp)
  }
  const addAttachment = (db: any, id: number, key: string, itemId: number): void => {
    db.prepare(
      'INSERT INTO attachments (id, key, item_id, path, date_added) VALUES (?, ?, ?, ?, ?)'
    ).run(id, key, itemId, `/tmp/${key}.pdf`, stamp)
  }
  const addChunk = (db: any, attachmentId: number, text: string): void => {
    db.prepare('INSERT INTO chunks (attachment_id, page_index, text) VALUES (?, ?, ?)').run(
      attachmentId,
      0,
      text
    )
  }
  const addNote = (db: any, id: number, itemId: number, title: string): void => {
    db.prepare('INSERT INTO notes (id, key, item_id, title, date_added, date_modified) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      `note-${id}`,
      itemId,
      title,
      stamp,
      stamp
    )
    db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)').run(
      id,
      title,
      `${title} 正文`
    )
  }
  const addEntry = (
    db: any,
    key: string,
    title: string,
    body: string,
    itemId: number | null,
    attachmentId: number | null,
    state = 'active'
  ): number => {
    const info = db
      .prepare(
        `INSERT INTO knowledge_entries
           (key, kind, title, body, content_nature, item_id, attachment_id, source_type,
            content_hash, state, created_at, updated_at)
         VALUES (?, 'concept', ?, ?, 'fact', ?, ?, 'paper_digest', ?, ?, ?, ?)`
      )
      .run(key, title, body, itemId, attachmentId, `hash-${key}`, state, stamp, stamp)
    return Number(info.lastInsertRowid)
  }
  const ftsQuery = (raw: string): string => {
    const tokens = (raw || '')
      .split(/\s+/)
      .map((t) => t.replace(/["'()*:^-]/g, '').trim())
      .filter(Boolean)
    return tokens.length === 0 ? '' : tokens.map((t) => `"${t}"*`).join(' AND ')
  }
  // 与 search.ts 的 chunks 来源同形状：WHERE 里 MATCH 之后插范围片段，再 ORDER BY，最后 LIMIT
  const searchChunks = (
    db: any,
    q: string,
    limit: number,
    scope: ReturnType<typeof normalizeSearchScope>
  ): Array<{ id: number; itemId: number; attachmentId: number }> => {
    const scoped = buildScopeSql(scope, 'chunks')
    if (!scoped.applicable) return []
    return db
      .prepare(
        `SELECT c.id AS id, a.item_id AS itemId, c.attachment_id AS attachmentId
           FROM chunks_fts
           JOIN chunks c ON c.id = chunks_fts.rowid
           JOIN attachments a ON a.id = c.attachment_id
          WHERE chunks_fts MATCH ?${scoped.sql}
          ORDER BY bm25(chunks_fts) LIMIT ?`
      )
      .all(q, ...scoped.params, limit) as any
  }

  // ---------- 1) 53 块、目标论文只有 3 块：后置过滤取不到，SQL 范围能取全 ----------
  const sdb = makeDb()
  addItem(sdb, 1, 'paper-a', '论文 A')
  addItem(sdb, 2, 'paper-b', '论文 B')
  addAttachment(sdb, 11, 'att-a', 1)
  addAttachment(sdb, 12, 'att-b', 2)
  for (let i = 0; i < 50; i += 1) addChunk(sdb, 11, `needle alpha 论文 A 的第 ${i} 个块`)
  for (let i = 0; i < 3; i += 1) addChunk(sdb, 12, `needle alpha 论文 B 的第 ${i} 个块`)
  const q = ftsQuery('needle')
  const oldHits = searchChunks(sdb, q, 20, null).filter((h) => h.attachmentId === 12)
  const scopedHits = searchChunks(sdb, q, 20, normalizeSearchScope({ attachmentId: 12 }))
  check(
    'PD39：53 块里目标论文仅 3 块——旧「先取 20 条再过滤」得 0 条',
    oldHits.length === 0,
    JSON.stringify({ got: oldHits.length })
  )
  check(
    'PD39：范围进 SQL 后按 limit=10 的候选池（20）取回目标论文全部 3 条命中',
    scopedHits.length === 3 && scopedHits.every((h) => h.attachmentId === 12),
    JSON.stringify({ got: scopedHits.length, rows: scopedHits })
  )
  check(
    'PD39：itemId 范围同样进 SQL（目标论文 3 条，且不串入 A）',
    (() => {
      const rows = searchChunks(sdb, q, 20, normalizeSearchScope({ itemId: 2 }))
      return rows.length === 3 && rows.every((h) => h.itemId === 2)
    })()
  )
  check(
    'PD39：itemIds 分组范围进 SQL（items 2 取 3 条）',
    (() => {
      const rows = searchChunks(sdb, q, 20, normalizeSearchScope({ itemIds: [2] }))
      return rows.length === 3 && rows.every((h) => h.itemId === 2)
    })()
  )
  check(
    'PD39：空分组（itemIds=[]）在 SQL 层 AND 0，不退化成全库检索',
    searchChunks(sdb, q, 20, groupScopeFromPaperIds([], '空组')).length === 0
  )

  // ---------- 2) noteId 范围：chunks 来源不适用，notes 来源只命中该条笔记 ----------
  addNote(sdb, 101, 1, '笔记 1 needle')
  addNote(sdb, 102, 2, '笔记 2 needle')
  check(
    'PD39：按 noteId 限定时 chunks 来源标记为不适用（不生成 SQL、不返全库结果）',
    (() => {
      const scoped = buildScopeSql(normalizeSearchScope({ noteId: 102 }), 'chunks')
      return scoped.applicable === false && scoped.sql === ''
    })()
  )
  check(
    'PD39：notes 来源按 noteId 进 SQL，仅命中指定笔记',
    (() => {
      const scope = normalizeSearchScope({ noteId: 102 })
      const scoped = buildScopeSql(scope, 'notes')
      const rows = sdb
        .prepare(
          `SELECT n.id AS id FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
            WHERE notes_fts MATCH ?${scoped.sql} ORDER BY bm25(notes_fts) LIMIT ?`
        )
        .all(q, ...scoped.params, 10) as Array<{ id: number }>
      return rows.length === 1 && rows[0].id === 102
    })()
  )

  // ---------- 3) 范围归一化：空范围不加条件、非法范围抛可读错误、参数不含用户输入 ----------
  check(
    'PD39：空范围（null/{}）归一化为 null，SQL 片段为空串（不加任何条件）',
    normalizeSearchScope(null) === null &&
      normalizeSearchScope({}) === null &&
      buildScopeSql(null, 'items').sql === '' &&
      buildScopeSql(normalizeSearchScope({}), 'chunks').sql === ''
  )
  check(
    'PD39：非法范围抛可读错误（itemId=0 / attachmentId 负数 / 字符串 / 超 500 项）',
    (() => {
      const zero = throws(() => normalizeSearchScope({ itemId: 0 }))
      const negative = throws(() => normalizeSearchScope({ attachmentId: -3 }))
      const str = throws(() => normalizeSearchScope({ itemId: '3' as unknown as number }))
      const big = throws(() =>
        normalizeSearchScope({ itemIds: Array.from({ length: SCOPE_ITEM_LIMIT + 1 }, (_, i) => i + 1) })
      )
      return (
        !!zero &&
        zero.includes('检索范围非法') &&
        !!negative &&
        negative.includes('attachmentId') &&
        !!str &&
        !!big &&
        big.includes(String(SCOPE_ITEM_LIMIT))
      )
    })()
  )
  check(
    'PD39：只有 groupId 时纯模块报错（分组必须先经 groupScopeFromPaperIds 解析成 itemIds）',
    (() => {
      const msg = throws(() => normalizeSearchScope({ groupId: '方向/组A' }))
      return !!msg && msg.includes('groupScopeFromPaperIds')
    })()
  )
  check(
    'PD39：范围片段参数化——SQL 文本不含 id 数字与用户输入，参数只含 id',
    (() => {
      const scoped = buildScopeSql(normalizeSearchScope({ itemIds: [7, 8] }), 'chunks')
      return (
        scoped.sql ===
          ' AND (EXISTS (SELECT 1 FROM attachments sc WHERE sc.id = c.attachment_id AND sc.item_id IN (?,?)))' &&
        scoped.sql.indexOf('7') === -1 &&
        scoped.sql.indexOf('8') === -1 &&
        JSON.stringify(scoped.params) === '[7,8]'
      )
    })()
  )
  check(
    'PD39：LIKE 词项做 ESCAPE 转义，SQL 里不内联用户输入',
    (() => {
      const like = buildLikeMatch('100%_x needle')
      const scoped = buildLikeMatch('needle')
      return (
        like.patterns.includes('%100\\%\\_x%') &&
        scoped.where.indexOf('needle') === -1 &&
        scoped.score.indexOf('needle') === -1 &&
        JSON.stringify(scoped.whereParams) === '["%needle%","%needle%"]' &&
        buildLikeMatch('   ').ok === false
      )
    })()
  )

  // ---------- 4) 知识库检索：state='active' + 范围进 SQL + 排序后 LIMIT ----------
  const kdb = makeDb()
  addItem(kdb, 1, 'k-paper-a', '论文 A')
  addItem(kdb, 2, 'k-paper-b', '论文 B')
  addAttachment(kdb, 11, 'k-att-a', 1)
  addAttachment(kdb, 12, 'k-att-b', 2)
  for (let i = 0; i < 50; i += 1) {
    addEntry(kdb, `a-${i}`, `A 条目 ${i}`, `关于 needle 的正文 ${i}`, 1, 11)
  }
  for (let i = 0; i < 3; i += 1) {
    addEntry(kdb, `b-${i}`, `B 条目 ${i} needle`, `论文 B 正文 ${i}`, 2, 12)
  }
  addEntry(kdb, 'b-archived', 'B 已归档 needle', '归档正文', 2, 12, 'archived')
  addEntry(kdb, 'b-no-att', 'B 无附件 needle', '无附件正文', 2, null)
  const linkEntryId = addEntry(kdb, 'a-linked', 'A 证据条目', '通过证据链接归属 B 的 needle', 1, null)
  kdb
    .prepare(
      `INSERT INTO evidence_links (entry_id, source_type, source_ref, item_id, attachment_id, quote, precision, content_hash, created_at)
       VALUES (?, 'chunk', '{}', ?, ?, '引文', 'exact', 'hash-link', '2024-01-01T00:00:00.000Z')`
    )
    .run(linkEntryId, 1, 12)

  const kScoped = searchKnowledge(kdb, 'needle', { scope: { attachmentId: 12 }, limit: 10 })
  check(
    'PD39：知识库按附件范围进 SQL——命中 3 条本附件条目 + 1 条证据链接指向本附件的条目',
    kScoped.length === 4 &&
      kScoped.filter((h) => h.attachmentId === 12).length === 3 &&
      kScoped.some((h) => h.id === linkEntryId),
    JSON.stringify(kScoped.map((h) => ({ id: h.id, att: h.attachmentId, score: h.score })))
  )
  check(
    'PD39：知识库检索只返回 state=active（归档条目不出现）',
    !kScoped.some((h) => h.title.includes('已归档')) &&
      searchKnowledge(kdb, '已归档', { limit: 10 }).length === 0
  )
  check(
    'PD39：知识库按 itemId 范围进 SQL（论文 B 的 3 条 + 无附件 1 条）',
    (() => {
      const rows = searchKnowledge(kdb, 'needle', { scope: { itemId: 2 }, limit: 50 })
      return rows.length === 4 && rows.every((h) => h.itemId === 2)
    })()
  )
  check(
    'PD39：知识库空查询返回 []，noteId 范围对 knowledge 来源不适用',
    searchKnowledge(kdb, '   ', { limit: 10 }).length === 0 &&
      searchKnowledge(kdb, 'needle', { scope: { noteId: 1 }, limit: 10 }).length === 0
  )
  check(
    'PD39：知识库 groupId 未解析时抛可读错误（不静默全库检索）',
    (() => {
      const msg = throws(() => searchKnowledge(kdb, 'needle', { scope: { groupId: '方向/组A' } }))
      return !!msg && msg.includes('groupScopeFromPaperIds')
    })()
  )
  check(
    'PD39：知识库 SQL 顺序为「范围 WHERE → ORDER BY → LIMIT」，且不内联用户输入',
    (() => {
      const captured: Array<{ sql: string; params: unknown[] }> = []
      const wrap = {
        exec: (sql: string) => kdb.exec(sql),
        prepare: (sql: string) => {
          const stmt = kdb.prepare(sql)
          return {
            get: (...p: unknown[]) => stmt.get(...p),
            all: (...p: unknown[]) => {
              captured.push({ sql, params: p })
              return stmt.all(...p)
            },
            run: (...p: unknown[]) => stmt.run(...p)
          }
        }
      }
      const rows = searchKnowledge(wrap as never, 'needle', { scope: { itemId: 2 }, limit: 5 })
      const first = captured[0]
      return (
        !!first &&
        first.sql.indexOf('needle') === -1 &&
        first.sql.indexOf('e.item_id = ?') > first.sql.indexOf('FROM knowledge_entries') &&
        first.sql.indexOf('e.item_id = ?') < first.sql.indexOf('ORDER BY') &&
        first.sql.indexOf('ORDER BY') < first.sql.indexOf('LIMIT') &&
        JSON.stringify(first.params.slice(-2)) === '[2,5]' &&
        rows.length === 4
      )
    })()
  )
  check(
    'PD39：知识库打分排序——标题命中（2 分）排在仅正文命中（1 分）之前',
    (() => {
      const rows = searchKnowledge(kdb, 'needle', { limit: 100 })
      const firstBodyOnly = rows.findIndex((h) => !h.title.includes('needle'))
      return (
        firstBodyOnly > 0 &&
        rows.slice(0, firstBodyOnly).every((h) => h.score === 2) &&
        rows.slice(firstBodyOnly).every((h) => h.score === 1)
      )
    })()
  )

  // ---------- 5) 分组问答：范围进 SQL 后，引用仍全部来自本组论文 ----------
  const gdb = makeDb()
  addItem(gdb, 1, 'g-paper-1', '组内论文 1', '方向/组A')
  addItem(gdb, 2, 'g-paper-2', '组内论文 2', '方向/组A')
  addItem(gdb, 3, 'g-paper-3', '组外论文', '方向/组B')
  addAttachment(gdb, 11, 'g-att-1', 1)
  addAttachment(gdb, 12, 'g-att-2', 2)
  addAttachment(gdb, 13, 'g-att-3', 3)
  for (let i = 0; i < 2; i += 1) addChunk(gdb, 11, `needle 组内论文 1 片段 ${i}`)
  for (let i = 0; i < 2; i += 1) addChunk(gdb, 12, `needle 组内论文 2 片段 ${i}`)
  for (let i = 0; i < 50; i += 1) addChunk(gdb, 13, `needle 组外论文 片段 ${i}`)
  const groupScope = groupScopeFromPaperIds([1, 2], '方向/组A')
  const groupRows = searchChunks(gdb, q, 24, groupScope)
  const groupHits: GroupHit[] = groupRows.map((r, i) => ({
    chunkId: r.id,
    itemId: r.itemId,
    attachmentId: r.attachmentId,
    page: 1,
    snippet: `片段 ${i}`,
    text: `needle 正文 ${i}`
  }))
  const groupPapers: GroupPaper[] = [
    { itemId: 1, title: '组内论文 1', abstract: '摘要 1', attachmentId: 11 },
    { itemId: 2, title: '组内论文 2', abstract: '摘要 2', attachmentId: 12 }
  ]
  const groupCtx = buildGroupContext(groupPapers, groupHits)
  check(
    'PD39：分组检索范围进 SQL 后只命中本组论文（组外 50 块不挤占候选）',
    groupRows.length === 4 && groupRows.every((r) => r.itemId === 1 || r.itemId === 2)
  )
  check(
    'PD39：分组问答 citation.attachmentId 全部属于本组论文的附件',
    groupCtx.citations.length > 0 &&
      groupCtx.citations.every(
        (c) => c.attachmentId != null && [11, 12].includes(Number(c.attachmentId))
      ),
    JSON.stringify(groupCtx.citations.map((c) => ({ item: c.itemId, att: c.attachmentId })))
  )
  check(
    'PD39：空分组范围得到 empty 标记（buildScopeSql 直接 AND 0）',
    groupScopeFromPaperIds([], '空组').empty === true &&
      buildScopeSql(groupScopeFromPaperIds([], '空组'), 'knowledge').sql === ' AND 0'
  )

  // ---------- 6) 调用点源码断言（search.ts / ai.ts 无法直接 import） ----------
  const searchSrc = readFileSync(
    fileURLToPath(new URL('../src/main/services/search.ts', import.meta.url)),
    'utf8'
  )
  const aiSrc = readFileSync(
    fileURLToPath(new URL('../src/main/services/ai.ts', import.meta.url)),
    'utf8'
  )
  check(
    'PD39：search.ts 四个 FTS 来源都在 MATCH 之后插入范围 SQL 片段',
    ['itemsScope', 'chunksScope', 'notesScope', 'translationsScope'].every((name) =>
      searchSrc.includes('${' + name + '.sql}')
    ) &&
      (searchSrc.match(/MATCH \?\$\{/g) ?? []).length === 4
  )
  check(
    'PD39：search.ts 的 search() 暴露可选范围参数，searchHybrid 删除附件后置 filter',
    searchSrc.includes('export function search(raw: string, limit = 20, scopeInput?: SearchScopeInput | null)') &&
      !searchSrc.includes('attachmentId === opts.attachmentId') &&
      searchSrc.includes('buildScopeSql(scope, source)')
  )
  check(
    'PD39：ai.ts 单篇检索传 scope、分组检索传 groupScopeFromPaperIds，且没有 paperIds.has 后置过滤',
    aiSrc.includes('scope: opts.attachmentId != null ? { attachmentId: opts.attachmentId } : null') &&
      aiSrc.includes('groupScopeFromPaperIds(') &&
      !aiSrc.includes('paperIds.has(') &&
      !aiSrc.includes("h.attachmentId === opts.attachmentId")
  )
  check(
    'PD39：mindmap.ts 未在本任务改动（仍为后置筛，属 PD39 之外，行为保持不变）',
    (() => {
      const mindmapSrc = readFileSync(
        fileURLToPath(new URL('../src/main/services/mindmap.ts', import.meta.url)),
        'utf8'
      )
      return mindmapSrc.includes('passagesFromHits(itemId, hits)') &&
        !mindmapSrc.includes('knowledge-query')
    })()
  )
}

function pd40ChunkEvidenceTests(): void {
  const schemaSql = readFileSync(
    fileURLToPath(new URL('../src/main/db/schema.sql', import.meta.url)),
    'utf8'
  )
  const stamp = '2026-11-03T00:00:00.000Z'

  /* ---------- 1) 老库迁移：chunks 补四列，重复执行零 ALTER ---------- */
  const legacy = new DatabaseSync(':memory:')
  legacy.exec(
    `CREATE TABLE chunks (
       id INTEGER PRIMARY KEY,
       attachment_id INTEGER NOT NULL,
       page_index INTEGER,
       section TEXT,
       bbox TEXT,
       text TEXT NOT NULL
     )`
  )
  const ddl: string[] = []
  const legacyDb = {
    prepare: (sql: string) => legacy.prepare(sql),
    exec: (sql: string) => {
      ddl.push(sql)
      legacy.exec(sql)
    }
  }
  migrate(legacyDb as never)
  const legacyCols = (legacy.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>).map(
    (c) => c.name
  )
  const ddlAfterFirst = ddl.length
  migrate(legacyDb as never)
  check(
    'PD40：老库 chunks 原地补齐 module_id/char_start/char_end/content_hash 四列',
    ['module_id', 'char_start', 'char_end', 'content_hash'].every((c) => legacyCols.includes(c)) &&
      ddl.some((s) => /chunks ADD COLUMN module_id TEXT/.test(s)) &&
      ddl.some((s) => /chunks ADD COLUMN char_start INTEGER/.test(s)) &&
      ddl.some((s) => /chunks ADD COLUMN char_end INTEGER/.test(s)) &&
      ddl.some((s) => /chunks ADD COLUMN content_hash TEXT/.test(s)),
    JSON.stringify({ cols: legacyCols, ddl })
  )
  check(
    'PD40：chunks 四列迁移幂等（第二次执行零 ALTER）',
    ddlAfterFirst > 0 && ddl.length === ddlAfterFirst,
    JSON.stringify({ first: ddlAfterFirst, second: ddl.length - ddlAfterFirst })
  )

  /* ---------- 2) 预置数据：可回填 / 不可回填 两个附件 ---------- */
  const makeDb = (): any => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(schemaSql)
    migrate(db as never)
    return db
  }
  const moduleText =
    '引言 graphneedle 图神经网络通过消息传递聚合邻居表示，这一机制在引文网络与分子图上都成立。'
  const moduleRow = {
    id: 'm-1',
    type: 'paragraph',
    page: 1,
    column: 0,
    rect: [0, 0, 400, 120],
    text: moduleText
  }
  const makeDbWithChunks = (): any => {
    const db = makeDb()
    db.prepare(
      'INSERT INTO items (id, key, title, date_added, date_modified) VALUES (?, ?, ?, ?, ?)'
    ).run(1, 'pd40-paper', 'PD40 论文', stamp, stamp)
    db.prepare(
      'INSERT INTO attachments (id, key, item_id, path, date_added) VALUES (?, ?, ?, ?, ?)'
    ).run(11, 'pd40-att-a', 1, '/tmp/pd40-a.pdf', stamp)
    db.prepare(
      'INSERT INTO attachments (id, key, item_id, path, date_added) VALUES (?, ?, ?, ?, ?)'
    ).run(12, 'pd40-att-b', 1, '/tmp/pd40-b.pdf', stamp)
    db.prepare(
      'INSERT INTO paper_modules (attachment_id, doc_json, page_count, created_at) VALUES (?, ?, ?, ?)'
    ).run(11, JSON.stringify({ modules: [moduleRow] }), 1, stamp)
    // 历史块：四列全 NULL（模拟 PD40 之前的库）
    db.prepare(
      'INSERT INTO chunks (id, attachment_id, page_index, text) VALUES (?, ?, ?, ?)'
    ).run(101, 11, 0, 'graphneedle 图神经网络通过消息传递聚合邻居表示')
    db.prepare(
      'INSERT INTO chunks (id, attachment_id, page_index, text) VALUES (?, ?, ?, ?)'
    ).run(102, 12, 0, 'pageonlyneedle 没有模块信息的另一段正文')
    return db
  }
  const db = makeDbWithChunks()
  const ftsHits = (): number[] =>
    (
      db
        .prepare(
          `SELECT c.id AS id FROM chunks_fts
             JOIN chunks c ON c.id = chunks_fts.rowid
            WHERE chunks_fts MATCH ?
            ORDER BY c.id`
        )
        .all('"graphneedle"*') as Array<{ id: number }>
    ).map((r) => Number(r.id))
  const hitsBefore = ftsHits()
  const rowsBefore = Number(db.prepare('SELECT COUNT(*) AS c FROM chunks').get().c)

  const first = migrateKnowledgeBackfill(db, { info: () => {}, warn: () => {} })
  const c101 = readChunkEvidence(db, 101)
  const c102 = readChunkEvidence(db, 102)
  check(
    'PD40：可回填块拿到模块 id、模块正文 UTF-16 区间与内容指纹',
    first.status === 'ok' &&
      first.filled === 1 &&
      first.hashed === 1 &&
      c101?.moduleId === 'm-1' &&
      c101?.charStart !== null &&
      c101?.charEnd !== null &&
      c101.charEnd > c101.charStart &&
      c101.contentHash === chunkContentHash('graphneedle 图神经网络通过消息传递聚合邻居表示') &&
      moduleText
        .slice(c101.charStart, c101.charEnd)
        .replace(/\s+/gu, '')
        .includes('消息传递聚合邻居表示') &&
      c101.precision === 'module',
    JSON.stringify({ first, c101 })
  )
  check(
    'PD40：不可回填块 module_id 保持 NULL、只补内容指纹（页级证据）',
    first.status === 'ok' &&
      c102?.moduleId === null &&
      c102?.charStart === null &&
      c102?.charEnd === null &&
      c102.contentHash === chunkContentHash('pageonlyneedle 没有模块信息的另一段正文') &&
      c102.precision === 'page' &&
      locateChunkInModule(moduleText, 'totally unrelated text') === null
  )
  check(
    'PD40：精度判定要求 module_id 与区间同时成立（半截证据一律 page）',
    chunkEvidencePrecision({ moduleId: 'm-1', charStart: 3, charEnd: 9 }) === 'module' &&
      chunkEvidencePrecision({ moduleId: 'm-1', charStart: null, charEnd: null }) === 'page' &&
      chunkEvidencePrecision({ moduleId: null, charStart: 0, charEnd: 5 }) === 'page' &&
      chunkEvidencePrecision({ moduleId: 'm-1', charStart: 5, charEnd: 5 }) === 'page'
  )

  /* ---------- 3) 幂等 + FTS 命中集合不变 ---------- */
  const hitsAfter = ftsHits()
  const rowsAfter = Number(db.prepare('SELECT COUNT(*) AS c FROM chunks').get().c)
  const second = migrateKnowledgeBackfill(db, { info: () => {}, warn: () => {} })
  const c101Again = readChunkEvidence(db, 101)
  check(
    'PD40：重复回填零写出、行数不变，回填前后 FTS 命中 id 集合一致',
    second.status === 'ok' &&
      second.filled === 0 &&
      second.hashed === 0 &&
      rowsAfter === rowsBefore &&
      hitsBefore.join(',') === hitsAfter.join(',') &&
      hitsBefore.join(',') === '101' &&
      c101Again?.moduleId === 'm-1' &&
      c101Again?.charStart === c101?.charStart,
    JSON.stringify({ first, second, rowsBefore, rowsAfter, hitsBefore, hitsAfter })
  )
  check(
    'PD40：内容指纹归一化稳定（NFKC + 空白折叠），不是语义哈希',
    chunkContentHash('  ﬁgure   A  ') === chunkContentHash('figure a') &&
      chunkContentHash('figure a') !== chunkContentHash('figure b')
  )

  /* ---------- 4) 失败降级：坏 doc_json 只告警，不中断启动 ---------- */
  const bad = makeDb()
  bad.prepare(
    'INSERT INTO items (id, key, title, date_added, date_modified) VALUES (?, ?, ?, ?, ?)'
  ).run(1, 'pd40-bad', 'PD40 坏缓存', stamp, stamp)
  bad.prepare(
    'INSERT INTO attachments (id, key, item_id, path, date_added) VALUES (?, ?, ?, ?, ?)'
  ).run(13, 'pd40-att-c', 1, '/tmp/pd40-c.pdf', stamp)
  bad.prepare(
    'INSERT INTO paper_modules (attachment_id, doc_json, page_count, created_at) VALUES (?, ?, ?, ?)'
  ).run(13, '{not valid json', 1, stamp)
  bad.prepare('INSERT INTO chunks (id, attachment_id, page_index, text) VALUES (?, ?, ?, ?)').run(
    103,
    13,
    0,
    'brokenneedle 坏缓存下的正文'
  )
  const degraded = migrateKnowledgeBackfill(bad, { info: () => {}, warn: () => {} })
  const c103 = readChunkEvidence(bad, 103)
  check(
    'PD40：doc_json 解析失败降级为 degraded，仍补内容指纹且不抛错',
    degraded.status === 'degraded' &&
      degraded.degraded > 0 &&
      degraded.errors.length > 0 &&
      c103?.moduleId === null &&
      c103?.contentHash === chunkContentHash('brokenneedle 坏缓存下的正文')
  )

  /* ---------- 5) 提案精度显式化：无区间→page，有区间→module ---------- */
  const batch = createBatch(db, { title: 'PD40 证据精度批次', task: 'extract' })
  const proposal = createProposal(db, batch.id, {
    op: 'create',
    itemId: 1,
    content: { kind: 'concept', title: '消息传递', body: '图神经网络通过消息传递聚合邻居表示。' },
    contentNature: 'author_claim',
    sourceType: 'paper',
    sourceRef: { documentId: 1 },
    evidence: [
      {
        sourceType: 'paper',
        itemId: 1,
        pageIndex: 0,
        moduleId: 'm-1',
        quote: '图神经网络通过消息传递聚合邻居表示',
        sectionPath: '1 引言'
      },
      {
        sourceType: 'paper',
        itemId: 1,
        pageIndex: 0,
        moduleId: 'm-1',
        charStart: 3,
        charEnd: 21,
        quote: '消息传递聚合邻居表示',
        sectionPath: '1 引言'
      }
    ],
    reason: 'PD40 精度测试'
  })
  const detail = getProposalDetail(db, proposal.id)
  const evNoSpan = detail?.evidence.find((e) => !e.charStart && !e.charEnd)
  const evWithSpan = detail?.evidence.find((e) => e.charStart === 3 && e.charEnd === 21)
  check(
    'PD40：仅 moduleId 无区间的证据降级 page，有模块+区间才是 module',
    evNoSpan?.precision === 'page' &&
      evWithSpan?.precision === 'module' &&
      evNoSpan.moduleId === 'm-1' &&
      evWithSpan.moduleId === 'm-1',
    JSON.stringify({ evidence: detail?.evidence })
  )
}

/**
 * PD42：检索模式显式标注。
 * 这组断言覆盖验收 1（哈希后端一律 lexical、排序与纯词法一致）与验收 4（导出无明文 Key），
 * 都是纯函数，不需要 electron / 数据库。
 */
function pd42RetrievalModeTests(): void {
  /* ---------- 1) 默认设置 = 本地哈希，绝不能宣称语义 ---------- */
  const defaultSettings = {
    embed: { enabled: '1', mode: 'local' },
    provider: { mode: 'auto', baseUrl: '', apiKeySet: false, embedModel: '' }
  }
  const hashBacking = embedBackingFrom(defaultSettings)
  check(
    'PD42：默认设置解析为 mock + local-hash-64，semantic=false',
    hashBacking.backend === 'mock' &&
      hashBacking.model === 'local-hash-64' &&
      hashBacking.semantic === false,
    JSON.stringify(hashBacking)
  )

  const mockInfo = resolveRetrievalMode('hybrid', hashBacking, { rerank: true })
  check(
    'PD42：哈希后端请求 hybrid + 重排仍降级 lexical，并写明原因',
    mockInfo.mode === 'lexical' &&
      mockInfo.degraded === true &&
      mockInfo.reason.includes('local-hash-64'),
    JSON.stringify(mockInfo)
  )
  check(
    'PD42：词法模式徽标写「词法检索（无向量）」',
    retrievalModeLabel(mockInfo) === '词法检索（无向量）',
    retrievalModeLabel(mockInfo)
  )

  /* ---------- 2) 语义重排默认关闭 ---------- */
  const offInfo = resolveRetrievalMode('hybrid', hashBacking, { rerank: false })
  check(
    'PD42：重排默认关闭时只做词法，且不谎称降级',
    offInfo.mode === 'lexical' && offInfo.degraded === false && offInfo.rerank === false,
    JSON.stringify(offInfo)
  )

  /* ---------- 3) 只有真向量后端才允许语义 ---------- */
  const openaiBacking = embedBackingFrom({
    embed: { enabled: '1', mode: 'provider' },
    provider: {
      mode: 'auto',
      baseUrl: 'https://api.example.com/v1',
      apiKeySet: true,
      embedModel: 'text-embedding-3-large'
    }
  })
  check(
    'PD42：配好 provider 时后端为 openai，semantic=true',
    openaiBacking.backend === 'openai' &&
      openaiBacking.model === 'text-embedding-3-large' &&
      openaiBacking.semantic === true,
    JSON.stringify(openaiBacking)
  )
  const semanticInfo = resolveRetrievalMode('semantic', openaiBacking, { rerank: true })
  check(
    'PD42：真向量 + 重排开启才标 semantic，徽标带模型名',
    semanticInfo.mode === 'semantic' &&
      semanticInfo.degraded === false &&
      retrievalModeLabel(semanticInfo) === '语义检索 · text-embedding-3-large',
    retrievalModeLabel(semanticInfo)
  )
  const hybridInfo = resolveRetrievalMode('hybrid', openaiBacking, { rerank: true })
  check(
    'PD42：真向量 + hybrid 显示「词法 + 语义（RRF）」',
    hybridInfo.mode === 'hybrid' &&
      retrievalModeLabel(hybridInfo).includes('RRF') &&
      retrievalModeLabel(hybridInfo).includes('text-embedding-3-large'),
    retrievalModeLabel(hybridInfo)
  )
  const openaiNoRerank = resolveRetrievalMode('hybrid', openaiBacking, { rerank: false })
  check(
    'PD42：有语义后端但重排关闭 → lexical，徽标说明「重排未开启」',
    openaiNoRerank.mode === 'lexical' &&
      retrievalModeLabel(openaiNoRerank) === '词法检索（语义重排未开启）',
    retrievalModeLabel(openaiNoRerank)
  )
  const noIndex = resolveRetrievalMode('semantic', openaiBacking, { rerank: true, hasIndex: false })
  check(
    'PD42：没有向量索引时语义请求降级 lexical 并写原因',
    noIndex.mode === 'lexical' && noIndex.degraded === true && noIndex.reason.includes('索引'),
    JSON.stringify(noIndex)
  )

  /* ---------- 4) 关闭向量 / 配置不全一律词法 ---------- */
  const noneBacking = embedBackingFrom({ embed: { enabled: '0' } })
  check(
    'PD42：embed.enabled=0 → backend none',
    noneBacking.backend === 'none' && noneBacking.semantic === false,
    JSON.stringify(noneBacking)
  )
  const noneInfo = resolveRetrievalMode('semantic', noneBacking, { rerank: true })
  check(
    'PD42：none 后端请求语义 → lexical，原因写「无向量」',
    noneInfo.mode === 'lexical' &&
      noneInfo.degraded === true &&
      noneInfo.reason.includes('无向量'),
    JSON.stringify(noneInfo)
  )
  const providerIncomplete = embedBackingFrom({
    embed: { enabled: '1', mode: 'provider' },
    provider: { mode: 'auto', baseUrl: '', apiKeySet: false, embedModel: '' }
  })
  check(
    'PD42：provider 模式缺 baseUrl/key 时退回哈希后端',
    providerIncomplete.backend === 'mock' &&
      providerIncomplete.model === 'local-hash-64' &&
      providerIncomplete.semantic === false,
    JSON.stringify(providerIncomplete)
  )

  /* ---------- 5) 排序：mock 后端与纯词法完全一致（验收 1 的可断言形式） ---------- */
  const lexical = [
    { kind: 'chunk', id: 3, score: -1.2, title: 'c3' },
    { kind: 'chunk', id: 1, score: -1.5, title: 'c1' },
    { kind: 'item', id: 9, score: -2, title: 'i9' }
  ]
  const semantic = [
    { chunkId: 7, score: 0.95 },
    { chunkId: 1, score: 0.9 },
    { chunkId: 3, score: 0.4 }
  ]
  const key = (h: { kind: string; id: number }): string => `${h.kind}:${h.id}`
  const mockOrder = fuseHybrid(lexical, semantic, {
    eligible: mockInfo.mode !== 'lexical' && mockInfo.semantic,
    limit: 20,
    materialize: (id, score) => ({ kind: 'chunk', id, score, title: `c${id}` })
  })
  check(
    'PD42：mock/哈希后端下 RRF 排序与纯词法完全一致',
    mockOrder.map(key).join('>') === lexical.map(key).join('>'),
    mockOrder.map(key).join('>')
  )
  const semanticOrder = fuseHybrid(lexical, semantic, {
    eligible: true,
    limit: 20,
    materialize: (id, score) => ({ kind: 'chunk', id, score, title: `c${id}` })
  })
  check(
    'PD42：eligible=true 时语义命中确实参与排序（开关有实际作用）',
    semanticOrder.map(key).join('>') !== lexical.map(key).join('>') &&
      semanticOrder.some((h) => h.id === 7),
    semanticOrder.map(key).join('>')
  )

  /* ---------- 6) 导出脱敏（验收 4） ---------- */
  const legacy = {
    provider: { apiKeySet: true },
    openalex: { mailto: 'a@b.c', apiKey: 'sk-openalex-PLAINTEXT' },
    scholar: { apiKey: 'sk-scholar-PLAINTEXT' },
    semantic: { apiKey: 'sk-s2-PLAINTEXT' }
  }
  const payload = exportSettingsPayload(legacy)
  const exported = JSON.stringify(payload)
  const openalex = payload.openalex as Record<string, unknown>
  const scholar = payload.scholar as Record<string, unknown>
  const semanticSection = payload.semantic as Record<string, unknown>
  check(
    'PD42：设置导出不含任何明文 Key',
    !exported.includes('PLAINTEXT') && !exported.includes('sk-'),
    exported
  )
  check(
    'PD42：导出只保留 apiKeySet 布尔',
    openalex.apiKeySet === true &&
      openalex.apiKey === undefined &&
      scholar.apiKeySet === true &&
      scholar.apiKey === undefined &&
      semanticSection.apiKeySet === true &&
      semanticSection.apiKey === undefined,
    JSON.stringify({ openalex, scholar, semanticSection })
  )
  check(
    'PD42：导出脱敏不修改原设置对象',
    legacy.scholar.apiKey === 'sk-scholar-PLAINTEXT' &&
      legacy.semantic.apiKey === 'sk-s2-PLAINTEXT',
    JSON.stringify(legacy)
  )
}

/**
 * PD43：一次批处理 = 一个提案批次。
 * 覆盖：首跑建一个批次 / 重跑不重复 / 失败续跑只补缺失 / 追加新论文进同一批次 /
 * 暂存区按论文聚合与按论文筛选（筛选条件走 SQL，不做事后过滤）。
 */
function pd43BatchSyncTests(): void {
  const schemaPath = fileURLToPath(new URL('../src/main/db/schema.sql', import.meta.url))
  const schemaSql = readFileSync(schemaPath, 'utf8')
  const stamp = '2026-11-03T00:00:00.000Z'
  const dir = mkdtempSync(join(tmpdir(), 'pd43-batch-'))
  const report = (name: string, titles: string[]): string => {
    const lines = ['## 批处理拆解', '']
    for (const title of titles) {
      lines.push(`### ${title}`, `这是「${title}」的要点内容，用于验证批处理产物同步链路。`, '')
    }
    writeFileSync(join(dir, name), lines.join('\n'), 'utf8')
    return name
  }
  const fileA = report('a.analysis.md', ['研究问题', '方法设计', '实验结果'])
  const fileB = report('b.analysis.md', ['研究问题', '方法设计'])
  const fileC = report('c.analysis.md', ['研究问题'])

  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(schemaSql)
  migrate(db as never)
  const insertItem = db.prepare(
    'INSERT INTO items (key, title, date_added, date_modified) VALUES (?, ?, ?, ?)'
  )
  insertItem.run('item-pd43-a', '论文 A', stamp, stamp)
  insertItem.run('item-pd43-b', '论文 B', stamp, stamp)
  insertItem.run('item-pd43-c', '论文 C', stamp, stamp)

  const addJob = (runId: string, key: string, task: string): number =>
    Number(
      db
        .prepare(
          `INSERT INTO batch_jobs
             (key, batch_run_id, task, title, params, status, off_peak_only, total, done, out_dir, date_created)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(key, runId, task, `批处理 · ${key}`, '{}', 'done', 0, 1, 1, dir, stamp).lastInsertRowid
    )
  const addItem = (jobId: number, itemId: number, status: string, output: string | null): void => {
    db.prepare(
      'INSERT INTO batch_items (job_id, item_id, attachment_id, label, status, output) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(jobId, itemId, null, `论文 #${itemId}`, status, output)
  }
  // 与 IPC 同一条路径：采集（SQL）→ shared 计划 → 单事务写提案
  const syncRun = (runId: string): any => {
    const collected = collectBatchDigestPapers(db, runId)
    return runInTransaction(db, () =>
      syncBatchProposals(
        db,
        buildBatchKnowledgePlan({ runId, papers: collected.papers, skipped: collected.skipped })
      )
    )
  }
  const proposalRows = (): any[] =>
    db.prepare('SELECT * FROM knowledge_proposals ORDER BY id').all() as any[]
  const batchRows = (): any[] =>
    db.prepare('SELECT * FROM proposal_batches ORDER BY id').all() as any[]
  const entryCount = (): number =>
    Number((db.prepare('SELECT COUNT(*) AS n FROM knowledge_entries').get() as any).n)

  const runId = 'br-pd43-run'
  const job1 = addJob(runId, 'job-pd43-1', 'analyze-paper')
  addItem(job1, 1, 'done', JSON.stringify([fileA]))
  addItem(job1, 2, 'failed', null)

  const first = syncRun(runId)
  check(
    'PD43：首跑按 batchRunId 建一个提案批次，只收已完成论文',
    first.papers === 1 &&
      first.createdProposals === 3 &&
      first.skippedPapers.length === 1 &&
      batchRows().length === 1 &&
      batchRows()[0].idempotency_key === `batch:${runId}` &&
      batchRows()[0].task === BATCH_DIGEST_BATCH_TASK,
    JSON.stringify({ first, batches: batchRows() })
  )
  check(
    'PD43：批处理提案全部是 pending_review，绝不直接写正式条目',
    proposalRows().length === 3 &&
      proposalRows().every((row) => row.status === 'pending_review') &&
      entryCount() === 0,
    JSON.stringify(proposalRows().map((row) => row.status))
  )

  const rerun = syncRun(runId)
  check(
    'PD43：同一 batchRunId 重跑命中同一批次且零新增',
    rerun.batchId === first.batchId &&
      rerun.createdProposals === 0 &&
      rerun.reusedProposals === 3 &&
      batchRows().length === 1 &&
      proposalRows().length === 3,
    JSON.stringify(rerun)
  )

  // 失败续跑：B 重试成功后只补 B 的要点，A 的提案原样保留
  const job2 = addJob(runId, 'job-pd43-retry', 'analyze-paper')
  addItem(job2, 2, 'done', JSON.stringify([fileB]))
  const aIds = proposalRows()
    .filter((row) => row.item_id === 1)
    .map((row) => row.id)
  const resume = syncRun(runId)
  const afterResume = proposalRows()
  check(
    'PD43：失败续跑只补缺失论文，不覆盖已成功提案',
    resume.batchId === first.batchId &&
      resume.createdProposals === 2 &&
      resume.papers === 2 &&
      afterResume.length === 5 &&
      aIds.every((id) => afterResume.some((row) => row.id === id)) &&
      afterResume.filter((row) => row.item_id === 2).length === 2,
    JSON.stringify(resume)
  )

  // 追加新论文：同一个 run 里新增 C（translate-analyze 同样产出拆解报告）
  const job3 = addJob(runId, 'job-pd43-3', 'translate-analyze')
  addItem(job3, 3, 'done', JSON.stringify([fileC]))
  const appended = syncRun(runId)
  check(
    'PD43：新增论文追加进同一批次，批次内论文数增加',
    appended.batchId === first.batchId &&
      appended.createdProposals === 1 &&
      appended.papers === 3 &&
      proposalRows().length === 6 &&
      batchRows().length === 1,
    JSON.stringify(appended)
  )

  // 非拆解任务不进同步集合
  const job4 = addJob(runId, 'job-pd43-translate', 'translate')
  addItem(job4, 1, 'done', JSON.stringify(['a.md']))
  const ignored = collectBatchDigestPapers(db, runId)
  check(
    'PD43：非拆解任务（translate）不进同步集合',
    ignored.papers.length === 3 &&
      ignored.papers.every((paper) => paper.itemId !== 1 || paper.batchJobId === job1),
    JSON.stringify(ignored.papers.map((paper) => [paper.itemId, paper.batchJobId]))
  )

  // 暂存区：论文聚合 + 按论文筛选全部走 SQL
  const papers = listBatchPapers(db, first.batchId)
  const onlyB = listProposals(db, { batchId: first.batchId, itemId: 2 })
  check(
    'PD43：暂存区按论文聚合（每篇条数与待审数）',
    papers.length === 3 &&
      papers[0].itemId === 1 &&
      papers[0].total === 3 &&
      papers[0].pending === 3 &&
      papers[1].itemId === 2 &&
      papers[1].total === 2 &&
      papers[1].title === '论文 B',
    JSON.stringify(papers)
  )
  check(
    'PD43：按论文筛选在 SQL 里生效（itemId 过滤）',
    onlyB.length === 2 && onlyB.every((proposal) => proposal.itemId === 2 && proposal.itemTitle === '论文 B'),
    JSON.stringify(onlyB.map((proposal) => [proposal.itemId, proposal.itemTitle]))
  )
  const listed = listBatches(db)
  check(
    'PD43：批次摘要带 papers（来自批处理 N 篇）',
    listed.length === 1 && listed[0].counts.total === 6 && listed[0].counts.papers === 3,
    JSON.stringify(listed[0]?.counts)
  )

  // 重试作业沿用源作业的 batch_run_id（selectRetryAllPlan 按 run 分组）
  const fakeJob = (id: number, run: string, task: string): any => ({
    id,
    key: `k${id}`,
    status: 'failed',
    task,
    batch_run_id: run,
    params: '{}'
  })
  const fakeItem = (jobId: number, itemId: number): any => ({
    id: jobId * 10,
    job_id: jobId,
    item_id: itemId,
    attachment_id: null,
    label: '',
    status: 'failed',
    output: null,
    message: null
  })
  const retryPlans = selectRetryAllPlan(
    [fakeJob(1, 'run-x', 'analyze-paper'), fakeJob(2, 'run-y', 'analyze-paper')],
    [
      { jobId: 1, items: [fakeItem(1, 7)] },
      { jobId: 2, items: [fakeItem(2, 8)] }
    ]
  )
  check(
    'PD43：重跑失败项按 batchRunId 分组，重试作业沿用原批次',
    retryPlans.length === 2 &&
      retryPlans[0].batchRunId === 'run-x' &&
      retryPlans[1].batchRunId === 'run-y' &&
      retryPlans[0].targets.length === 1,
    JSON.stringify(retryPlans)
  )

  // 迁移：老库补 batch_run_id 并回填，重复执行幂等
  const migration = runMigrate({ batch_jobs: ['id', 'key', 'task'] })
  check(
    'PD43：老库 batch_jobs 补 batch_run_id 并按 key 回填',
    migration.alters.some((sql) => sql.includes('batch_jobs ADD COLUMN batch_run_id')) &&
      migration.alters.some((sql) => sql.startsWith('UPDATE batch_jobs SET batch_run_id')),
    JSON.stringify(migration.alters)
  )
  const legacy = new DatabaseSync(':memory:')
  legacy.exec(
    `CREATE TABLE batch_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL,
       task TEXT NOT NULL, title TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}')`
  )
  legacy.prepare("INSERT INTO batch_jobs (key, task, title) VALUES ('OLDKEY1', 'analyze-paper', '旧作业')").run()
  migrate(legacy as never, { info: () => {}, warn: () => {} })
  migrate(legacy as never, { info: () => {}, warn: () => {} })
  const backfilled = legacy.prepare('SELECT batch_run_id FROM batch_jobs').all() as any[]
  check(
    'PD43：老库原地升级后 batch_run_id=key，迁移可重复执行',
    backfilled.length === 1 && backfilled[0].batch_run_id === 'OLDKEY1',
    JSON.stringify(backfilled)
  )

  check(
    'PD43：同步文案区分「提交到暂存区」与「已经同步过」',
    describeBatchSyncResult({
      runId,
      batchId: first.batchId,
      batchKey: '',
      papers: 3,
      pointCount: 6,
      createdProposals: 6,
      reusedProposals: 0,
      skippedPapers: []
    }).includes('暂存区') &&
      describeBatchSyncResult({
        runId,
        batchId: first.batchId,
        batchKey: '',
        papers: 3,
        pointCount: 6,
        createdProposals: 0,
        reusedProposals: 6,
        skippedPapers: []
      }).includes('已经同步过') &&
      isBatchDigestTask('translate-analyze') &&
      !isBatchDigestTask('translate') &&
      batchSourceLabel(BATCH_DIGEST_BATCH_TASK) === '批处理拆解' &&
      BACKFILLS.length === 2 &&
      BACKFILLS[0].table === 'batch_jobs' &&
      BACKFILLS[1].table === 'library_groups'
  )

  rmSync(dir, { recursive: true, force: true })
}

/**
 * PD44：批处理产物同步到知识库/思维地图。
 * - 勾选论文的 itemIds 必须进 SQL（不做事后过滤）；
 * - 知识库只建 pending_review 提案、一个 run 一个批次、重复执行幂等、已发布不受影响；
 * - 单篇失败不阻塞其余论文；
 * - 思维地图按 digestPointId 幂等，且保留用户改过的节点标题。
 */
function pd44BatchSyncTests(): void {
  const schemaPath = fileURLToPath(new URL('../src/main/db/schema.sql', import.meta.url))
  const schemaSql = readFileSync(schemaPath, 'utf8')
  const stamp = '2026-11-03T00:00:00.000Z'
  const dir = mkdtempSync(join(tmpdir(), 'pd44-batch-'))
  const report = (name: string, titles: string[]): string => {
    const lines = ['## 批处理拆解', '']
    for (const title of titles) {
      lines.push(`### ${title}`, `这是「${title}」的要点内容，用于验证 PD44 批处理同步。`, '')
    }
    writeFileSync(join(dir, name), lines.join('\n'), 'utf8')
    return name
  }
  const fileA = report('pd44-a.analysis.md', ['研究问题', '方法设计'])
  const fileB = report('pd44-b.analysis.md', ['研究问题'])

  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(schemaSql)
  migrate(db as never)
  const insertItem = db.prepare(
    'INSERT INTO items (key, title, date_added, date_modified) VALUES (?, ?, ?, ?)'
  )
  insertItem.run('item-pd44-a', '论文 A', stamp, stamp)
  insertItem.run('item-pd44-b', '论文 B', stamp, stamp)

  const runId = 'br-pd44-run'
  const jobId = Number(
    db
      .prepare(
        `INSERT INTO batch_jobs
           (key, batch_run_id, task, title, params, status, off_peak_only, total, done, out_dir, date_created)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('job-pd44-1', runId, 'analyze-paper', '批处理 · PD44', '{}', 'done', 0, 2, 2, dir, stamp)
      .lastInsertRowid
  )
  const addBatchItem = (
    job: number,
    itemId: number,
    status: string,
    output: string | null
  ): void => {
    db.prepare(
      'INSERT INTO batch_items (job_id, item_id, attachment_id, label, status, output) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(job, itemId, null, `论文 #${itemId}`, status, output)
  }
  addBatchItem(jobId, 1, 'done', JSON.stringify([fileA]))
  addBatchItem(jobId, 2, 'done', JSON.stringify([fileB]))
  addBatchItem(jobId, 3, 'failed', null)

  const collect = (itemIds?: number[]): { papers: any[]; skipped: any[] } =>
    collectBatchDigestPapers(db, runId, itemIds ? { itemIds } : {}) as any
  const planFor = (papers: any[], skipped: any[], run: string = runId): any =>
    buildBatchKnowledgePlan({
      runId: run,
      papers,
      skipped,
      task: BATCH_SYNC_BATCH_TASK,
      sourceType: 'batch'
    })
  const proposalRows = (): any[] =>
    db.prepare('SELECT * FROM knowledge_proposals ORDER BY id').all() as any[]
  const batchRows = (): any[] =>
    db.prepare('SELECT * FROM proposal_batches ORDER BY id').all() as any[]
  const entryCount = (): number =>
    Number((db.prepare('SELECT COUNT(*) AS n FROM knowledge_entries').get() as any).n)

  // 1) 勾选范围进 SQL：只请求 item 1 时，item 2 的连接/读文件都不该发生
  const scoped = collect([1])
  check(
    'PD44：勾选论文按 itemIds 在 SQL 里限定范围（不做事后过滤）',
    scoped.papers.length === 1 &&
      scoped.papers[0].itemId === 1 &&
      scoped.papers[0].batchItemId != null &&
      scoped.skipped.length === 0,
    JSON.stringify({ papers: scoped.papers.map((p) => p.itemId), skipped: scoped.skipped })
  )

  // 2) 首跑：一个批次、全部 pending_review、来源标 batch/task=batch-sync
  const full = collect()
  const first = syncBatchProposalsByPaper(db, planFor(full.papers, full.skipped))
  check(
    'PD44：首跑一个批次，知识库只建 pending_review 提案且来源=批处理',
    first.batchId > 0 &&
      batchRows().length === 1 &&
      batchRows()[0].task === BATCH_SYNC_BATCH_TASK &&
      batchRows()[0].workflow_version === 'pd44' &&
      batchRows()[0].idempotency_key === `batch:${runId}` &&
      proposalRows().length === 3 &&
      proposalRows().every((row) => row.status === 'pending_review' && row.source_type === 'batch') &&
      entryCount() === 0 &&
      first.success === 2 &&
      first.skipped === 1 &&
      first.createdProposals === 3,
    JSON.stringify({ first, batches: batchRows(), statuses: proposalRows().map((r) => r.status) })
  )

  // 2b) PD52：批处理提案必须带论文归属（item_id 非空），且仍只进待审
  check(
    'PD52：批处理提案带论文归属（knowledge_proposals.item_id 非空）',
    proposalRows().length === 3 &&
      proposalRows().every((row) => row.item_id != null && row.status === 'pending_review') &&
      new Set(proposalRows().map((row) => row.item_id)).size === 2,
    JSON.stringify(
      proposalRows().map((row) => ({ id: row.id, item_id: row.item_id, status: row.status }))
    )
  )

  // 3) 重复执行幂等：同一批次、零新增、不产生重复提案
  const rerun = syncBatchProposalsByPaper(db, planFor(collect().papers, collect().skipped))
  check(
    'PD44：重复执行幂等（同一批次、零新增、提案数不变）',
    rerun.batchId === first.batchId &&
      rerun.createdProposals === 0 &&
      rerun.success === 0 &&
      rerun.skipped === 3 &&
      batchRows().length === 1 &&
      proposalRows().length === 3,
    JSON.stringify(rerun)
  )

  // 4) 已发布条目不受影响：模拟用户已接受发布一条，再同步不得改动它
  const publishedProposal = proposalRows()[0]
  db.prepare("UPDATE knowledge_proposals SET status = 'published', published_at = ? WHERE id = ?").run(
    stamp,
    publishedProposal.id
  )
  db.prepare(
    `INSERT INTO knowledge_entries
       (key, kind, title, body, content_nature, item_id, source_type, source_ref,
        content_hash, version, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'entry-pd44-published',
    'concept',
    '已发布条目',
    '用户已发布的正式条目，同步不得覆盖',
    'fact',
    1,
    'batch',
    '{}',
    'hash-pd44',
    1,
    'active',
    stamp,
    stamp
  )
  const afterPublish = syncBatchProposalsByPaper(db, planFor(collect().papers, collect().skipped))
  check(
    'PD44：已发布条目与已发布提案不被同步覆盖（只新增待审）',
    afterPublish.createdProposals === 0 &&
      entryCount() === 1 &&
      (db.prepare('SELECT status FROM knowledge_proposals WHERE id = ?').get(publishedProposal.id) as any)
        .status === 'published' &&
      (db.prepare('SELECT body FROM knowledge_entries WHERE key = ?').get('entry-pd44-published') as any)
        .body === '用户已发布的正式条目，同步不得覆盖',
    JSON.stringify({ afterPublish, entries: entryCount() })
  )

  // 5) 部分失败：不存在的文献排在前，后面的正常论文仍要写入
  const fakePaper = {
    itemId: 999,
    attachmentId: null,
    batchRunId: 'br-pd44-partial',
    batchJobId: jobId,
    batchItemId: 9001,
    title: '已删除的论文',
    markdown: '### 不存在的要点\n\n这条写入会因为文献不存在而失败。\n'
  }
  const realPaper = {
    ...full.papers[0],
    batchRunId: 'br-pd44-partial',
    title: '论文 A（新批次）'
  }
  const partialPlan = buildBatchKnowledgePlan({
    runId: 'br-pd44-partial',
    papers: [fakePaper as never, realPaper],
    task: BATCH_SYNC_BATCH_TASK,
    sourceType: 'batch'
  })
  const partial = syncBatchProposalsByPaper(db, partialPlan)
  const failedItem = (partial.items ?? []).find((item) => item.status === 'failed')
  check(
    'PD44：单篇失败不阻塞其余论文，逐篇给出成功/跳过/失败与原因',
    partial.failed === 1 &&
      partial.success === 1 &&
      failedItem != null &&
      failedItem.itemId === 999 &&
      String(failedItem.reason).length > 0 &&
      partial.createdProposals === 2 &&
      batchRows().length === 2,
    JSON.stringify({ partial, failedItem })
  )

  // 6) 思维地图：同一批要点重复合并不新增；用户改过的节点标题保留
  const points = [
    { title: '研究问题', body: '要点内容' },
    { title: '方法设计', body: '方法内容' }
  ]
  const baseMap = createMindMapDoc(1, '论文 A')
  const firstMerge = mergeDigestPointsIntoMindMap(baseMap, points)
  const secondMerge = mergeDigestPointsIntoMindMap(firstMerge.doc, points)
  const root = secondMerge.doc.nodes.find((node) => node.id === secondMerge.doc.rootId) as any
  const renamed = {
    ...secondMerge.doc,
    nodes: secondMerge.doc.nodes.map((node) =>
      node.id === firstMerge.ids[0] ? { ...node, text: '我改过的标题' } : node
    )
  }
  const thirdMerge = mergeDigestPointsIntoMindMap(renamed, points)
  const renamedNode = thirdMerge.doc.nodes.find((node) => node.id === firstMerge.ids[0]) as any
  check(
    'PD44：思维地图重复同步不新增节点，且不覆盖用户改名的节点标题',
    firstMerge.added === 2 &&
      secondMerge.added === 0 &&
      secondMerge.reused === 2 &&
      thirdMerge.added === 0 &&
      renamedNode?.text === '我改过的标题' &&
      firstMerge.doc.nodes.filter((node) => node.parentId === root.id).length === 2 &&
      firstMerge.doc.nodes.every(
        (node) => node.source !== 'digest' || node.id.startsWith('dg-')
      ),
    JSON.stringify({ firstMerge, secondMerge, thirdMerge, renamedNode })
  )

  // 8) PD52：节点文本带摘要片段，二次同步节点数与 id 严格稳定
  const digestTexts = firstMerge.doc.nodes
    .filter((node) => node.source === MINDMAP_DIGEST_SOURCE)
    .map((node) => node.text)
  check(
    'PD52：思维地图要点节点写入标题 + 摘要片段',
    digestTexts.length === 2 &&
      digestTexts.every((text) => text.includes('\n')) &&
      digestTexts[0].startsWith('研究问题') &&
      digestTexts[0].includes('要点内容') &&
      digestTexts[1].startsWith('方法设计') &&
      digestTexts[1].includes('方法内容'),
    JSON.stringify(digestTexts)
  )
  check(
    'PD52：二次同步节点数与 id 完全稳定（幂等）',
    secondMerge.doc.nodes.length === firstMerge.doc.nodes.length &&
      JSON.stringify(secondMerge.doc.nodes.map((node) => node.id)) ===
        JSON.stringify(firstMerge.doc.nodes.map((node) => node.id)) &&
      JSON.stringify(secondMerge.ids) === JSON.stringify(firstMerge.ids),
    JSON.stringify({
      firstIds: firstMerge.doc.nodes.map((node) => node.id),
      secondIds: secondMerge.doc.nodes.map((node) => node.id)
    })
  )
  const longBody = `### 标题\n\n**加粗**与 \`code\` 和 [链接](https://example.com/paper)${'字'.repeat(MINDMAP_DIGEST_SNIPPET_CHARS)}`
  const nodeText = digestPointNodeText('研究问题', longBody)
  check(
    'PD52：摘要片段去掉 Markdown 记号、折叠空白并截断',
    digestPointNodeText(
      '研究问题',
      '### 要点\n\n**加粗**与 `code` 和 [链接](https://example.com/paper)'
    ) === '研究问题\n要点 加粗与 code 和 链接' &&
      digestPointNodeText('只有标题', '   ') === '只有标题' &&
      nodeText.startsWith('研究问题\n标题 加粗与 code 和 链接') &&
      nodeText.includes('…') &&
      nodeText.length < longBody.length,
    JSON.stringify({
      plain: digestPointNodeText(
        '研究问题',
        '### 要点\n\n**加粗**与 `code` 和 [链接](https://example.com/paper)'
      ),
      clipped: nodeText
    })
  )

  // 7) 文案与来源标签
  check(
    'PD44：批处理来源显示「批处理」，文案区分知识库暂存区与思维地图',
    batchSourceLabel(BATCH_SYNC_BATCH_TASK) === '批处理' &&
      describeBatchSyncResult(first).includes('暂存区') &&
      describeBatchSyncResult({
        ...first,
        target: 'mindmap',
        items: first.items?.map((item) => ({ ...item, added: 1, reused: 0 }))
      }).includes('思维地图'),
    JSON.stringify({
      label: batchSourceLabel(BATCH_SYNC_BATCH_TASK),
      knowledge: describeBatchSyncResult(first),
      mindmap: describeBatchSyncResult({
        ...first,
        target: 'mindmap',
        items: first.items?.map((item) => ({ ...item, added: 1, reused: 0 }))
      })
    })
  )

  rmSync(dir, { recursive: true, force: true })
}

/**
 * PD46：设计令牌落地与基础控件统一（docs/UI-SPEC.md §1.1-§1.4、§1.6、§1.8、§4.1）。
 * 只读断言 styles.css，不启动 GUI：
 * - :root / 暗色块令牌齐全、取值符合规范、两主题键集合完全一致；
 * - 兼容别名只做 var() 引用，不成为第二套真值；
 * - 既有 --r-sm/md/lg/xl、--shadow-sm/md/lg 值未被改动；
 * - ^button { 唯一、主按钮/输入框/标签页/卡片/空态容器改用令牌；
 * - 主按钮 / 输入框 / 空态卡在浅色与暗色下对比度 >= 4.5。
 * data-testid 零变更由「本轮未改任何 .tsx」+ styles.css 不含 data-testid 共同保证。
 */
function pd46DesignTokenTests(): void {
  console.log('PD46 设计令牌与基础控件')
  const cssPath = fileURLToPath(new URL('../src/renderer/src/styles.css', import.meta.url))
  // 仓库里 styles.css 是 CRLF：先归一化，否则含换行的选择器（如 input,\nselect,\ntextarea）取不到块。
  const css = readFileSync(cssPath, 'utf8').replace(/\r\n/g, '\n')
  if (css.length === 0) {
    check('PD46：styles.css 可读取', false, cssPath)
    return
  }

  /** 折叠空白并规整逗号，便于比较令牌取值（不改变语义） */
  const norm = (value: string): string =>
    value
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/\s*,\s*/g, ', ')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')

  /** 取出某个选择器后的第一个声明块（含嵌套花括号计数） */
  const blockOf = (selector: string): string => {
    const start = css.indexOf(`${selector} {`)
    if (start < 0) return ''
    let depth = 1
    let out = ''
    for (let i = start + selector.length + 2; i < css.length; i++) {
      const ch = css[i]
      if (ch === '{') depth++
      if (ch === '}') {
        depth--
        if (depth === 0) break
      }
      out += ch
    }
    return out
  }

  /** 解析块内 `--name: value;` 声明（值里的换行折叠为空格） */
  const varsOf = (block: string): Map<string, string> => {
    const map = new Map<string, string>()
    const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/g
    let match: RegExpExecArray | null = re.exec(block)
    while (match !== null) {
      map.set(match[1], norm(match[2]))
      match = re.exec(block)
    }
    return map
  }

  const root = varsOf(blockOf(':root'))
  const dark = varsOf(blockOf("html[data-theme='dark']"))

  const expectedRoot: Record<string, string> = {
    '--space-1': '4px',
    '--space-2': '8px',
    '--space-3': '12px',
    '--space-4': '16px',
    '--space-5': '24px',
    '--space-6': '32px',
    '--text-xs': '12px',
    '--text-sm': '13px',
    '--text-md': '14px',
    '--text-lg': '16px',
    '--text-xl': '20px',
    '--lh-xs': '18px',
    '--lh-sm': '20px',
    '--lh-md': '22px',
    '--lh-lg': '24px',
    '--lh-xl': '28px',
    '--control-h-sm': '28px',
    '--control-h-md': '30px',
    '--control-h-lg': '32px',
    '--control-h-xl': '36px',
    '--r-xs': '4px',
    '--r-pill': '999px',
    '--shadow-page': '0 6px 22px rgba(0, 0, 0, 0.22)',
    '--bar-h': '46px',
    '--tree-indent': '14px',
    '--opacity-disabled': '0.45',
    '--focus-ring': '0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent)',
    '--page-bg': '#ffffff',
    '--danger-fg': '#ffffff',
    '--warn': '#b25e09',
    '--warn-bg': 'rgba(240, 173, 78, 0.12)',
    '--st-queued': '#94a3b8',
    '--st-scheduled': '#f59e0b',
    '--st-running': '#3b82f6',
    '--st-done': '#12a150',
    '--st-failed': '#e5484d',
    '--st-cancelled': '#6b7280'
  }
  const keys = Object.keys(expectedRoot)
  const missingRoot = keys.filter((key) => !root.has(key))
  const wrongRoot = keys.filter((key) => root.has(key) && root.get(key) !== expectedRoot[key])
  check(
    'PD46：:root 令牌齐全且取值符合规范（§1.1-§1.4、§1.6）',
    missingRoot.length === 0 && wrongRoot.length === 0,
    JSON.stringify({ missingRoot, wrongRoot })
  )

  // 暗色块：与主题无关的令牌同值成对；颜色类按 §4.2 给不同值
  const darkOnly: Record<string, string> = {
    '--shadow-page': '0 6px 22px rgba(0, 0, 0, 0.5)',
    '--danger-fg': '#2a1213',
    '--warn': '#f5b544',
    '--warn-bg': 'rgba(240, 173, 78, 0.16)',
    '--st-queued': '#7c8798',
    '--st-scheduled': '#f5b544',
    '--st-running': '#60a5fa',
    '--st-done': '#3dd68c',
    '--st-failed': '#f2555a',
    '--st-cancelled': '#98a1ae'
  }
  const missingDark = keys.filter((key) => !dark.has(key))
  const wrongDark = keys.filter((key) => {
    if (!dark.has(key)) return false
    const expected = darkOnly[key] ?? root.get(key)
    return dark.get(key) !== expected
  })
  check(
    'PD46：暗色块逐条成对声明且取值符合 §4.2',
    missingDark.length === 0 && wrongDark.length === 0,
    JSON.stringify({ missingDark, wrongDark })
  )

  const onlyRoot = [...root.keys()].filter((key) => !dark.has(key))
  const onlyDark = [...dark.keys()].filter((key) => !root.has(key))
  check(
    'PD46：两主题令牌键集合完全一致（UI-SPEC §4.1）',
    onlyRoot.length === 0 && onlyDark.length === 0 && root.size > 80 && dark.size > 80,
    JSON.stringify({ onlyRoot, onlyDark, rootKeys: root.size, darkKeys: dark.size })
  )

  const aliases: Array<[string, string]> = [
    ['--sp-1', '--space-1'],
    ['--sp-2', '--space-2'],
    ['--sp-3', '--space-3'],
    ['--sp-4', '--space-4'],
    ['--sp-5', '--space-5'],
    ['--sp-6', '--space-6'],
    ['--fs-xs', '--text-xs'],
    ['--fs-sm', '--text-sm'],
    ['--fs-md', '--text-md'],
    ['--fs-lg', '--text-lg'],
    ['--fs-xl', '--text-xl'],
    ['--ctl-sm', '--control-h-sm'],
    ['--ctl-md', '--control-h-md'],
    ['--ctl-lg', '--control-h-lg']
  ]
  const badAliases = aliases.filter(
    ([alias, target]) =>
      root.get(alias) !== `var(${target})` || dark.get(alias) !== `var(${target})`
  )
  check(
    'PD46：--sp-*/--fs-*/--ctl-* 只是 var() 别名且两主题都有（§1.8）',
    badAliases.length === 0,
    JSON.stringify(badAliases)
  )

  const legacy: Record<string, string> = {
    '--r-sm': '6px',
    '--r-md': '8px',
    '--r-lg': '12px',
    '--r-xl': '16px',
    '--shadow-sm': '0 1px 2px rgba(16, 24, 40, 0.06), 0 1px 3px rgba(16, 24, 40, 0.08)',
    '--shadow-md': '0 4px 12px rgba(16, 24, 40, 0.08), 0 2px 4px rgba(16, 24, 40, 0.05)',
    '--shadow-lg': '0 16px 40px rgba(16, 24, 40, 0.18)'
  }
  const changedLegacy = Object.keys(legacy).filter((key) => root.get(key) !== legacy[key])
  check(
    'PD46：既有 --r-sm/md/lg/xl 与 --shadow-sm/md/lg 值未被改动',
    changedLegacy.length === 0,
    JSON.stringify(changedLegacy.map((key) => ({ key, actual: root.get(key) })))
  )

  // 基础控件 token 化
  const buttonBlocks = (css.match(/^button\s*\{/gm) ?? []).length
  const baseButton = blockOf('button')
  check(
    'PD46：^button { 仅一处，且高度/内边距/禁用态改用令牌',
    buttonBlocks === 1 &&
      /height:\s*var\(--control-h-lg\)/.test(baseButton) &&
      /padding:\s*0 var\(--space-3\)/.test(baseButton) &&
      /gap:\s*var\(--space-2\)/.test(baseButton) &&
      /button:disabled\s*\{[^}]*opacity:\s*var\(--opacity-disabled\)/.test(css),
    JSON.stringify({ buttonBlocks })
  )

  const primary = blockOf('button.primary')
  check(
    'PD46：主按钮前景用 --accent-fg（不再硬编码 #fff）',
    /color:\s*var\(--accent-fg\)/.test(primary) && !/#fff/i.test(primary),
    primary.slice(0, 160)
  )

  const inputRule = blockOf('input,\nselect,\ntextarea')
  check(
    'PD46：输入框/下拉改用 --control-h-md 与 --space-*，焦点环统一 --focus-ring',
    /padding:\s*0 var\(--space-3\)/.test(inputRule) &&
      /input:not\(\[type='checkbox'\]\):not\(\[type='radio'\]\):not\(\[type='range'\]\),\s*select\s*\{[^}]*height:\s*var\(--control-h-md\)/.test(
        css
      ) &&
      /textarea\s*\{[^}]*padding:\s*var\(--space-2\) var\(--space-3\)/.test(css) &&
      /input:focus,[\s\S]{0,40}select:focus,[\s\S]{0,40}textarea:focus\s*\{[^}]*box-shadow:\s*var\(--focus-ring\)/.test(
        css
      ),
    inputRule.slice(0, 160)
  )

  const tabsRule = blockOf('.rightcol__tabs')
  const tabButtonRule = blockOf('.rightcol__tabs button')
  check(
    'PD46：标签页基础样式改用 --space-*/--control-h-sm/--text-xs',
    /gap:\s*var\(--space-1\)/.test(tabsRule) &&
      /padding:\s*var\(--space-2\) var\(--space-3\)/.test(tabsRule) &&
      /height:\s*var\(--control-h-sm\)/.test(tabButtonRule) &&
      /font-size:\s*var\(--text-xs\)/.test(tabButtonRule),
    JSON.stringify({ tabsRule, tabButtonRule }).slice(0, 240)
  )

  const toolbarRule = blockOf('.toolbar')
  check(
    'PD46：工具栏/面板栏改用 --bar-h/--space-*（阅读区高度仍为 46px）',
    /min-height:\s*var\(--bar-h\)/.test(toolbarRule) &&
      /padding:\s*0 var\(--space-4\)/.test(toolbarRule) &&
      /gap:\s*var\(--space-2\)/.test(toolbarRule) &&
      /padding:\s*var\(--space-3\)/.test(blockOf('.panel__bar')),
    toolbarRule.slice(0, 200)
  )

  check(
    'PD46：列表提示、空态与错误态容器改用令牌',
    /padding:\s*var\(--space-3\) var\(--space-2\)/.test(blockOf('.list__hint')) &&
      /gap:\s*var\(--space-3\)/.test(blockOf('.empty')) &&
      /font-size:\s*var\(--text-sm\)/.test(blockOf('.empty')) &&
      /padding:\s*var\(--space-5\)/.test(blockOf('.errbox')) &&
      /font-size:\s*var\(--text-md\)/.test(blockOf('.errbox__title')),
    [blockOf('.list__hint'), blockOf('.empty')].join(' | ').slice(0, 200)
  )

  check(
    'PD46：卡片与纸张改用 --r-*/--shadow-page/--page-bg',
    /border-radius:\s*var\(--r-md\)/.test(blockOf('.knowledge-entry')) &&
      /border-radius:\s*var\(--r-md\)/.test(blockOf('.stage-paper')) &&
      /background:\s*var\(--page-bg\)/.test(blockOf('.pageContainer')) &&
      /box-shadow:\s*var\(--shadow-page\)/.test(blockOf('.pageContainer')),
    blockOf('.pageContainer').slice(0, 200)
  )

  check(
    'PD46：警告色统一走 --warn/--warn-bg（#b25e09 只保留令牌定义）',
    (css.match(/#b25e09/gi) ?? []).length === 1 &&
      /\.stage-notice--warn\s*\{[^}]*color:\s*var\(--warn\)[^}]*background:\s*var\(--warn-bg\)/.test(css) &&
      /\.stage-chip--pending\s*\{[^}]*color:\s*var\(--warn\)/.test(css)
  )

  check(
    'PD46：.ai__preset 删除自绘焦点环，按钮统一由全局 :focus-visible 承担（§1.9）',
    !/\.ai__preset:focus-visible\s*\{/.test(css) && /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/.test(css),
    blockOf(':focus-visible')
  )

  check(
    'PD46：styles.css 不再引用未定义令牌 var(--bg)，且不含 data-testid',
    !/var\(--bg\)/.test(css) && !/data-testid/.test(css)
  )

  // 对比度：WCAG 2.1 相对亮度（纯函数，不依赖 DOM）
  const luminance = (color: string): number => {
    const match = /^#([0-9a-f]{6})$/i.exec(color)
    if (!match) throw new Error(`invalid hex color: ${color}`)
    const value = parseInt(match[1], 16)
    const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
      const s = channel / 255
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  }
  const contrastRatio = (fg?: string, bg?: string): number => {
    const a = luminance(fg ?? '')
    const b = luminance(bg ?? '')
    const hi = Math.max(a, b)
    const lo = Math.min(a, b)
    return (hi + 0.05) / (lo + 0.05)
  }
  const pairs = [
    { name: '主按钮·浅色', fg: root.get('--accent-fg'), bg: root.get('--accent-strong') },
    { name: '主按钮·暗色', fg: dark.get('--accent-fg'), bg: dark.get('--accent-strong') },
    { name: '输入框·浅色', fg: root.get('--text'), bg: root.get('--bg-panel') },
    { name: '输入框·暗色', fg: dark.get('--text'), bg: dark.get('--bg-panel') },
    { name: '空态卡·浅色', fg: root.get('--text-muted'), bg: root.get('--bg-inset') },
    { name: '空态卡·暗色', fg: dark.get('--text-muted'), bg: dark.get('--bg-inset') }
  ]
  const ratios = pairs.map(({ name, fg, bg }) => ({
    name,
    ratio: Math.round(contrastRatio(fg, bg) * 100) / 100
  }))
  check(
    'PD46：主按钮/输入框/空态卡在浅色与暗色下对比度均 >= 4.5',
    ratios.every((item) => item.ratio >= 4.5),
    JSON.stringify(ratios)
  )
}

function scopePaperDoc(itemId: number, rootText: string, childTexts: string[]): MindMapDoc {
  return {
    version: 1,
    itemId,
    rootId: 'root',
    updatedAt: '',
    nodes: [
      { id: 'root', parentId: null, text: rootText, x: 0, y: 0 },
      ...childTexts.map((text, index) => ({
        id: `c${index + 1}`,
        parentId: 'root',
        text,
        x: index * 10,
        y: index * 10
      }))
    ]
  }
}

function pd48MindmapScopeTests(): void {
  console.log('\n[PD48] 思维地图分级（scope 纯函数）')

  const empty = buildScopedMindMap({
    scope: { kind: 'all' },
    label: '全部论文思维地图',
    papers: []
  })
  check(
    'PD48：空语料只有根节点且 paperCount=0',
    empty.rootId === 'scope:root' &&
      empty.nodes.length === 1 &&
      empty.nodes[0].id === 'scope:root' &&
      empty.nodes[0].parentId === null &&
      empty.nodes[0].text === '全部论文思维地图' &&
      empty.nodes[0].x === SCOPE_ROOT_X &&
      empty.nodes[0].y === SCOPE_ROOT_Y &&
      empty.paperCount === 0 &&
      empty.missingCount === 0
  )
  check(
    'PD48：聚合 doc 仍是 version=1、itemId=0、updatedAt 空串且只读',
    empty.version === 1 && empty.itemId === 0 && empty.updatedAt === '' && empty.readOnly === true
  )

  const singlePaper: MindmapScopePaper = {
    itemId: 1,
    title: '论文 A',
    group: '分组一',
    doc: scopePaperDoc(1, '论文 A', ['子节点 1', '子节点 2'])
  }
  const single = buildScopedMindMap({
    scope: { kind: 'all' },
    label: '全部论文思维地图',
    papers: [singlePaper]
  })
  const paperNode = single.nodes.find((node) => node.id === 'paper:1')
  const grandchildren = single.nodes.filter((node) => node.parentId === 'paper:1')
  check(
    'PD48：单篇有地图时生成论文节点并复制根的直接子节点',
    !!paperNode &&
      paperNode.parentId === 'scope:root' &&
      paperNode.text === '论文 A' &&
      paperNode.ref?.level === 'item' &&
      paperNode.ref?.itemId === 1 &&
      grandchildren.length === 2 &&
      grandchildren[0].id === 'paper:1/c1' &&
      grandchildren[1].text === '子节点 2' &&
      grandchildren.every((node) => node.ref?.itemId === 1) &&
      single.paperCount === 1 &&
      single.missingCount === 0
  )
  check(
    'PD57：论文网格与孙节点按测量宽度分列、按测量高度堆叠（不再截断）',
    !!paperNode &&
      paperNode.x === SCOPE_ROOT_X + SCOPE_CHILD_DX &&
      paperNode.y === SCOPE_ROOT_Y &&
      grandchildren[0].x === paperNode.x + MINDMAP_SCOPE_COL_W &&
      grandchildren[1].y === paperNode.y + 46 + MINDMAP_SCOPE_ROW_GAP &&
      grandchildren.every((node) => !node.text.endsWith('…'))
  )

  const mixed: MindmapScopePaper[] = [
    { itemId: 2, title: '有图', group: 'A', doc: scopePaperDoc(2, '有图', ['x']) },
    { itemId: 3, title: '缺图', group: 'A', doc: null },
    { itemId: 4, title: '   ', group: 'B', doc: null },
    { itemId: 5, title: '也有图', group: 'B', doc: scopePaperDoc(5, '也有图', []) }
  ]
  const mixedDoc = buildScopedMindMap({
    scope: { kind: 'all' },
    label: '全部论文思维地图',
    papers: mixed
  })
  const missingNode = mixedDoc.nodes.find((node) => node.id === 'paper:3')
  const untitledNode = mixedDoc.nodes.find((node) => node.id === 'paper:4')
  check(
    'PD48：多篇混合分别统计有图/无图且无图论文不加子节点',
    mixedDoc.paperCount === 4 &&
      mixedDoc.missingCount === 2 &&
      mixedDoc.nodes.filter((node) => node.parentId === 'scope:root').length === 4 &&
      !mixedDoc.nodes.some((node) => node.parentId === 'paper:3') &&
      !!missingNode &&
      missingNode.text.endsWith(MINDMAP_SCOPE_MISSING_SUFFIX) &&
      !!untitledNode &&
      untitledNode.text === `未命名文献${MINDMAP_SCOPE_MISSING_SUFFIX}`
  )

  const grouped = buildScopedMindMap({
    scope: { kind: 'group', group: 'A' },
    label: '分组：A',
    papers: mixed
  })
  check(
    'PD48：分组范围只保留 group_name 完全匹配的论文',
    grouped.paperCount === 2 &&
      grouped.missingCount === 1 &&
      grouped.nodes.some((node) => node.id === 'paper:2') &&
      grouped.nodes.some((node) => node.id === 'paper:3') &&
      !grouped.nodes.some((node) => node.id === 'paper:4' || node.id === 'paper:5')
  )
  const emptyGroup = buildScopedMindMap({
    scope: { kind: 'group', group: '不存在' },
    label: '分组：不存在',
    papers: mixed
  })
  check('PD48：分组无匹配时只剩根节点', emptyGroup.paperCount === 0 && emptyGroup.nodes.length === 1)

  const duplicates = buildScopedMindMap({
    scope: { kind: 'all' },
    label: '全部论文思维地图',
    papers: [
      { itemId: 9, title: '第一条', group: null, doc: null },
      { itemId: 9, title: '第二条', group: null, doc: null }
    ]
  })
  check(
    'PD48：重复 itemId 只取第一条',
    duplicates.paperCount === 1 &&
      duplicates.nodes.filter((node) => node.parentId === 'scope:root').length === 1 &&
      duplicates.nodes.some((node) => node.text.startsWith('第一条'))
  )

  const longTitle = '标'.repeat(MINDMAP_SCOPE_PAPER_MAX_CHARS + 5)
  const truncated = buildScopedMindMap({
    scope: { kind: 'all' },
    label: '全部论文思维地图',
    papers: [{ itemId: 10, title: longTitle, group: null, doc: null }]
  })
  const truncatedNode = truncated.nodes.find((node) => node.id === 'paper:10')
  check(
    'PD57：聚合论文节点显示完整标题（不再截断加省略号）',
    !!truncatedNode &&
      truncatedNode.text === `${longTitle}${MINDMAP_SCOPE_MISSING_SUFFIX}` &&
      !truncatedNode.text.includes('…')
  )

  const manyChildren = buildScopedMindMap({
    scope: { kind: 'all' },
    label: '全部论文思维地图',
    papers: [
      {
        itemId: 11,
        title: '多子节点',
        group: null,
        doc: scopePaperDoc(11, '多子节点', [
          '长'.repeat(65),
          ...Array.from({ length: 8 }, (_, i) => `子 ${i}`)
        ])
      }
    ]
  })
  check(
    'PD57：每篇论文最多复制 6 个子节点，且长文本完整保留（不截断）',
    manyChildren.nodes.filter((node) => node.parentId === 'paper:11').length === MINDMAP_SCOPE_CHILD_LIMIT &&
      manyChildren.nodes.some(
        (node) => node.parentId === 'paper:11' && node.text.length > 60 && !node.text.endsWith('…')
      )
  )

  const duplicateIds = buildScopedMindMap({
    scope: { kind: 'all' },
    label: '全部论文思维地图',
    papers: [
      {
        itemId: 12,
        title: '重复子 id',
        group: null,
        doc: {
          version: 1,
          itemId: 12,
          rootId: 'root',
          updatedAt: '',
          nodes: [
            { id: 'root', parentId: null, text: '重复子 id', x: 0, y: 0 },
            { id: 'dup', parentId: 'root', text: '甲', x: 0, y: 0 },
            { id: 'dup', parentId: 'root', text: '乙', x: 0, y: 0 }
          ]
        }
      }
    ]
  })
  const allIds = duplicateIds.nodes.map((node) => node.id)
  check(
    'PD48：node id 冲突时追加 -2 后缀保证全局唯一',
    new Set(allIds).size === allIds.length &&
      allIds.includes('paper:12/dup') &&
      allIds.includes('paper:12/dup-2')
  )

  const twice = [
    buildScopedMindMap({ scope: { kind: 'all' }, label: '全部论文思维地图', papers: mixed }),
    buildScopedMindMap({ scope: { kind: 'all' }, label: '全部论文思维地图', papers: mixed })
  ]
  check(
    'PD48：同一输入两次调用结果完全一致（确定性）',
    JSON.stringify(twice[0]) === JSON.stringify(twice[1])
  )

  const invalidScopes: Array<[string, unknown]> = [
    ['null', null],
    ['未知 kind', { kind: 'root' }],
    ['空分组', { kind: 'group', group: '' }],
    ['纯空白分组', { kind: 'group', group: '   ' }],
    ['itemId=0', { kind: 'item', itemId: 0 }],
    ['itemId 为负', { kind: 'item', itemId: -1 }],
    ['itemId 非整数', { kind: 'item', itemId: 1.5 }],
    ['itemId 非数字', { kind: 'item', itemId: '1' }]
  ]
  const invalidMessages = invalidScopes.map(([, raw]) => throws(() => normalizeMindmapScope(raw)))
  check(
    'PD48：非法 scope 统一抛中文可读「思维地图范围无效：…」',
    invalidMessages.every((message) => !!message && message.startsWith('思维地图范围无效：')),
    JSON.stringify(invalidMessages)
  )
  const normalizedGroup = normalizeMindmapScope({ kind: 'group', group: '  分组一  ' })
  const normalizedItem = normalizeMindmapScope({ kind: 'item', itemId: 3 })
  check(
    'PD48：合法 scope 归一化（分组去首尾空白、单篇保留正整数）',
    normalizedGroup.kind === 'group' &&
      normalizedGroup.group === '分组一' &&
      normalizedItem.kind === 'item' &&
      normalizedItem.itemId === 3 &&
      normalizeMindmapScope({ kind: 'all' }).kind === 'all'
  )
}

/**
 * PD50：知识库条目归属 + 引用 chip + 语义引导。
 *
 * 归属走真实 SQL（knowledge.ts::listEntries/getEntry 的三表 LEFT JOIN），
 * 引用解析与分组是纯函数，直接 import。四篇论文拆解出的条目必须能区分来源，
 * 所以这里逐条核对「有 item_id / 只有 attachment_id / 都没有 / 孤儿 item_id」。
 */
function pd50PaperAndCiteTests(): void {
  const schemaSql = readFileSync(
    fileURLToPath(new URL('../src/main/db/schema.sql', import.meta.url)),
    'utf8'
  )
  const stamp = '2026-11-04T00:00:00.000Z'

  // 孤儿 item_id 需要关掉外键（模拟「论文被硬删除但条目还留着」的历史数据）
  const makeDb = (foreignKeys: boolean): any => {
    // node:sqlite 的连接级选项比 PRAGMA 更可靠：关掉后才能写入「论文已被硬删除」的孤儿行
    const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: foreignKeys })
    db.exec(schemaSql) // schema.sql 末尾自带 PRAGMA foreign_keys = ON，所以要在建表后再按需覆盖
    db.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`)
    migrate(db as never)
    db.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`)
    return db
  }
  const addItem = (db: any, id: number, key: string, title: string): void => {
    db.prepare(
      'INSERT INTO items (id, key, title, date_added, date_modified) VALUES (?, ?, ?, ?, ?)'
    ).run(id, key, title, stamp, stamp)
  }
  const addAttachment = (db: any, id: number, key: string, itemId: number): void => {
    db.prepare('INSERT INTO attachments (id, key, item_id, path, date_added) VALUES (?, ?, ?, ?, ?)').run(
      id,
      key,
      itemId,
      `/tmp/${key}.pdf`,
      stamp
    )
  }
  const addEntry = (
    db: any,
    key: string,
    title: string,
    itemId: number | null,
    attachmentId: number | null,
    state = 'active'
  ): number => {
    const info = db
      .prepare(
        `INSERT INTO knowledge_entries
           (key, kind, title, body, content_nature, item_id, attachment_id, source_type,
            content_hash, state, created_at, updated_at)
         VALUES (?, 'concept', ?, ?, 'author_claim', ?, ?, 'digest', ?, ?, ?, ?)`
      )
      .run(key, title, `${title} 的正文`, itemId, attachmentId, `hash-${key}`, state, stamp, stamp)
    return Number(info.lastInsertRowid)
  }

  // ---------- 1) 四种归属 ----------
  const db = makeDb(true)
  addItem(db, 1, 'paper-one', '论文一：注意力机制综述')
  addItem(db, 2, 'paper-two', '论文二：检索增强生成')
  addAttachment(db, 11, 'att-one', 1)
  addAttachment(db, 12, 'att-two', 2)

  const directId = addEntry(db, 'e-direct', '直接归属条目', 1, null)
  const viaAttId = addEntry(db, 'e-att', '附件兜底条目', null, 12)
  const noneId = addEntry(db, 'e-none', '无归属条目', null, null)
  addEntry(db, 'e-archived', '已归档条目', 1, null, 'archived')

  const list = listEntries(db, {})
  const byId = new Map(list.map((entry) => [entry.id, entry]))
  check(
    'PD50：item_id 命中 items → paperItemId/paperTitle 取该论文',
    list.length === 4 &&
      byId.get(directId)?.paperItemId === 1 &&
      byId.get(directId)?.paperTitle === '论文一：注意力机制综述',
    JSON.stringify(byId.get(directId))
  )
  check(
    'PD50：只有 attachment_id → 用 attachments.item_id 兜底出论文',
    byId.get(viaAttId)?.paperItemId === 2 &&
      byId.get(viaAttId)?.paperTitle === '论文二：检索增强生成',
    JSON.stringify(byId.get(viaAttId))
  )
  check(
    'PD50：既无 item_id 也无 attachment_id → null/null（未关联论文）',
    byId.get(noneId)?.paperItemId === null && byId.get(noneId)?.paperTitle === null,
    JSON.stringify(byId.get(noneId))
  )
  const activeOnly = listEntries(db, { state: 'active' })
  check(
    'PD50：state/limit 过滤语义不变（active 不含归档，limit 生效）',
    list.some((entry) => entry.title === '已归档条目') &&
      activeOnly.length === 3 &&
      activeOnly.every((entry) => entry.title !== '已归档条目') &&
      listEntries(db, { state: 'archived' }).length === 1 &&
      listEntries(db, { limit: 2 }).length === 2,
    JSON.stringify({
      total: list.length,
      active: activeOnly.length,
      limited: listEntries(db, { limit: 2 }).length
    })
  )

  const directDetail = getEntry(db, directId)
  const attDetail = getEntry(db, viaAttId)
  check(
    'PD50：getEntry 与 listEntries 用同一份 JOIN，Detail 的归属字段一致',
    directDetail?.paperItemId === 1 &&
      directDetail?.paperTitle === '论文一：注意力机制综述' &&
      attDetail?.paperItemId === 2 &&
      attDetail?.paperTitle === '论文二：检索增强生成',
    JSON.stringify({ direct: directDetail?.paperTitle, att: attDetail?.paperTitle })
  )

  // ---------- 2) 孤儿 item_id：不伪造归属，也不偷偷回退到附件论文 ----------
  const orphanDb = makeDb(false)
  addItem(orphanDb, 1, 'paper-one', '论文一：注意力机制综述')
  addAttachment(orphanDb, 11, 'att-one', 1)
  const orphanId = addEntry(orphanDb, 'e-orphan', '孤儿引用条目', 999, 11)
  const orphan = listEntries(orphanDb, {}).find((entry) => entry.id === orphanId)
  check(
    'PD50：item 已删除（孤儿 item_id）→ null/null，不回退到附件论文',
    orphan?.paperItemId === null && orphan?.paperTitle === null,
    JSON.stringify(orphan)
  )

  // ---------- 3) 分组：按论文聚拢、无归属组永远最后 ----------
  const groups = groupKnowledgeEntries([
    { ...byId.get(noneId)!, title: '无归属条目' },
    { ...byId.get(viaAttId)!, title: '附件兜底条目' },
    { ...byId.get(directId)!, title: '直接归属条目' },
    { ...byId.get(directId)!, id: 9999, title: '同一篇论文的另一条' }
  ])
  check(
    'PD50：分组顺序=首次出现顺序、无归属组殿后、同论文合并为一组',
    groups.length === 3 &&
      groups[0].key === '2' &&
      groups[1].key === '1' &&
      groups[1].entries.length === 2 &&
      groups[2].key === 'none' &&
      groups[2].paperTitle === KNOWLEDGE_UNLINKED_PAPER,
    JSON.stringify(groups.map((group) => ({ key: group.key, n: group.entries.length })))
  )
  check(
    'PD50：null/undefined/空数组分组不崩（无条目 → 无分组）',
    groupKnowledgeEntries(null).length === 0 &&
      groupKnowledgeEntries(undefined).length === 0 &&
      groupKnowledgeEntries([]).length === 0
  )

  // ---------- 4) 引用解析：≥6 种合法写法 ----------
  const citeCases: Array<[string, string]> = [
    ['p.7', '第 7 页'],
    ['p.7, Tab.3', 'Tab.3 · 第 7 页'],
    ['p.7–9', '第 7–9 页'],
    ['p.7, p.9', '第 7 页 · 第 9 页'],
    ['Tab.3, p.21', 'Tab.3 · 第 21 页'],
    ['§2.3', '§2.3'],
    ['Fig.4', 'Fig.4'],
    ['pp.12-14', '第 12–14 页'],
    ['Eq.5', 'Eq.5']
  ]
  const citeBad = citeCases.filter(([inner, want]) => formatCiteLabel(inner) !== want)
  check(
    'PD50：引用解析（页/表/图/节/式、范围、逗号多段）共 9 种写法',
    citeBad.length === 0,
    JSON.stringify(citeBad.map(([inner]) => [inner, formatCiteLabel(inner)]))
  )

  // ---------- 5) 非法写法：原样保留、不抛异常 ----------
  const invalidInners = ['见第 7 页', 'p.9–3', 'p.', '', 'p.7, 未知']
  const invalidOk = invalidInners.every((inner) => {
    try {
      return formatCiteLabel(inner) === null && parseCiteInner(inner) === null
    } catch {
      return false
    }
  })
  check('PD50：非法引用写法（≥2 种）一律返回 null，不抛异常', invalidOk, JSON.stringify(invalidInners))

  const mixed = '结论见 [p.7, Tab.3]，另见 [见附录]，末页 [p.12]。'
  const segments = splitCiteText(mixed)
  const rebuilt = segments.map((segment) => segment.text).join('')
  check(
    'PD50：正文切分不吞字符、chip 只替换可识别引用',
    rebuilt === mixed &&
      segments.filter((segment) => segment.kind === 'cite').length === 2 &&
      segments.some((segment) => segment.kind === 'cite' && segment.label === 'Tab.3 · 第 7 页') &&
      segments.some((segment) => segment.kind === 'text' && segment.text.includes('[见附录]')),
    JSON.stringify(segments)
  )
  check(
    'PD50：hasCite 只对可识别引用为真（纯文本/未闭合括号为假）',
    hasCite('见 [Tab.3, p.21]') && !hasCite('普通正文 [p.7') && !hasCite('见附录') && !hasCite('')
  )

  // ---------- 6) 语义引导文案 ----------
  const hashInfo = resolveRetrievalMode('hybrid', embedBackingFrom({ embed: { mode: 'local' } }))
  const noneInfo = resolveRetrievalMode('hybrid', embedBackingFrom({ embed: { mode: 'off' } }))
  const semanticInfo = resolveRetrievalMode(
    'hybrid',
    embedBackingFrom({
      embed: { mode: 'provider', enabled: '1' },
      provider: { mode: 'openai', baseUrl: 'https://api.example.com/v1', apiKeySet: true }
    })
  )
  const hashHint = knowledgeEmbedHint(hashInfo)
  const noneHint = knowledgeEmbedHint(noneInfo)
  check(
    'PD50：哈希后端提示含 local-hash-64/词法检索/不参与语义排序//embeddings 四要素',
    hashInfo.semantic === false &&
      hashHint.includes('local-hash-64') &&
      hashHint.includes('只有词法检索生效') &&
      hashHint.includes('不参与语义排序') &&
      hashHint.includes('/embeddings'),
    hashHint
  )
  check(
    'PD50：未配置向量后端时提示仍写明「只有词法检索生效」与 /embeddings 入口',
    noneInfo.semantic === false &&
      noneHint.includes('只有词法检索生效') &&
      noneHint.includes('/embeddings'),
    noneHint
  )
  check(
    'PD50：真语义后端不显示配置引导（提示为空）',
    semanticInfo.semantic === true && knowledgeEmbedHint(semanticInfo) === '',
    JSON.stringify({ semantic: semanticInfo.semantic, backend: semanticInfo.backend })
  )
}

/**
 * PD53：思维地图面板的三处修复不能靠「看起来对」，这里直接只读断言源码文本：
 * - 工具栏可换行（flex-wrap/row-gap）且按钮不折行，论文名不再是 ellipsis 单行裁切；
 * - 节点宽度自适应（max-width 小于聚合子节点间距 248px，避免压住连线）；
 * - 聚合视图有「编辑这篇」入口与只读提示，编辑走 activeItemId（不改既有 IPC）。
 * 几何断言（两个视口下按钮两两不重叠）由 e2e 的 CDP 视口覆盖负责，这里不重复。
 */
function pd53MindmapPanelTests(): void {
  console.log('PD53 思维地图工具栏/论文名/聚合编辑')
  const cssPath = fileURLToPath(new URL('../src/renderer/src/styles.css', import.meta.url))
  const tsxPath = fileURLToPath(
    new URL('../src/renderer/src/features/mindmap/MindMapPanel.tsx', import.meta.url)
  )
  const css = readFileSync(cssPath, 'utf8').replace(/\r\n/g, '\n')
  const tsx = readFileSync(tsxPath, 'utf8').replace(/\r\n/g, '\n')

  /** 取出某个选择器后的第一个声明块（含嵌套花括号计数） */
  const blockOf = (selector: string): string => {
    const start = css.indexOf(`${selector} {`)
    if (start < 0) return ''
    let depth = 1
    let out = ''
    for (let i = start + selector.length + 2; i < css.length; i++) {
      const ch = css[i]
      if (ch === '{') depth++
      if (ch === '}') {
        depth--
        if (depth === 0) break
      }
      out += ch
    }
    return out
  }

  const toolbar = blockOf('.mindmap__toolbar')
  check(
    'PD53：工具栏允许换行且行间距 6px',
    /flex-wrap:\s*wrap/.test(toolbar) && /row-gap:\s*6px/.test(toolbar),
    toolbar.slice(0, 220)
  )
  const toolbarGhost = blockOf('.mindmap__toolbar .ghost')
  check(
    'PD53：工具栏按钮文字不折行（white-space: nowrap）',
    /white-space:\s*nowrap/.test(toolbarGhost) && /flex:\s*none/.test(toolbarGhost),
    toolbarGhost
  )
  const hint = blockOf('.mindmap__hint')
  check(
    'PD53：工具栏提示文字可换行且不再被 ellipsis 裁掉',
    /white-space:\s*normal/.test(hint) &&
      /overflow-wrap:\s*anywhere/.test(hint) &&
      /text-overflow:\s*clip/.test(hint) &&
      !/text-overflow:\s*ellipsis/.test(hint),
    hint
  )

  const paper = blockOf('.mindmap__paper')
  check(
    'PD57：头部论文名完整换行显示，不再用 line-clamp 截断',
    !/-webkit-line-clamp/.test(paper) &&
      /overflow-wrap:\s*anywhere/.test(paper) &&
      !/white-space:\s*nowrap/.test(paper) &&
      !/text-overflow:\s*ellipsis/.test(paper),
    paper
  )
  const node = blockOf('.mindmap__node')
  const maxWidth = /max-width:\s*(\d+)px/.exec(node)
  const minWidth = /min-width:\s*(\d+)px/.exec(node)
  check(
    'PD57：节点宽度 160–420px 自适应（长标题换行而非省略）',
    maxWidth != null &&
      Number(maxWidth[1]) === 420 &&
      minWidth != null &&
      Number(minWidth[1]) === 160,
    maxWidth ? `min-width: ${minWidth?.[1]}px; max-width: ${maxWidth[1]}px` : node.slice(0, 160)
  )
  const nodeText = blockOf('.mindmap__node-text')
  check(
    'PD57：节点文本显示全文（无 clamp/ellipsis）且行高固定，供连边端点按实际高度计算',
    !/-webkit-line-clamp/.test(nodeText) &&
      !/text-overflow:\s*ellipsis/.test(nodeText) &&
      !/overflow:\s*hidden/.test(nodeText) &&
      /overflow-wrap:\s*anywhere/.test(nodeText) &&
      /white-space:\s*pre-wrap/.test(nodeText) &&
      /word-break:\s*break-word/.test(nodeText) &&
      /line-height:\s*17px/.test(nodeText),
    nodeText
  )

  const knowledgeGroupTitle = blockOf('.knowledge-group__title')
  check(
    'PD59：知识库组头显示完整论文名（无 clamp/ellipsis，长名换行）',
    knowledgeGroupTitle.length > 0 &&
      !/-webkit-line-clamp/.test(knowledgeGroupTitle) &&
      !/line-clamp/.test(knowledgeGroupTitle) &&
      !/text-overflow:\s*ellipsis/.test(knowledgeGroupTitle) &&
      !/overflow:\s*hidden/.test(knowledgeGroupTitle) &&
      /overflow-wrap:\s*anywhere/.test(knowledgeGroupTitle),
    knowledgeGroupTitle
  )

  check(
    'PD53：论文级工具栏带 mindmap-toolbar 测试标识',
    tsx.includes('data-testid="mindmap-toolbar"'),
    'MindMapPanel.tsx'
  )
  check(
    'PD53：聚合视图有只读提示与「编辑这篇」入口',
    tsx.includes('data-testid="mindmap-readonly-hint"') &&
      tsx.includes('data-testid="mindmap-edit-paper"') &&
      tsx.includes('聚合视图只读，点『编辑这篇』进入可编辑地图'),
    'MindMapPanel.tsx'
  )
  check(
    'PD53：编辑态有「返回聚合视图」入口',
    tsx.includes('data-testid="mindmap-edit-return"') && tsx.includes('返回聚合视图'),
    'MindMapPanel.tsx'
  )
  check(
    'PD53：编辑另一篇论文走 activeItemId（不改既有 IPC 名称）',
    /window\.api\.mindmap\s*\.load\(activeItemId\)/.test(tsx) &&
      /const activeItemId = editingPaperId \?\? itemId/.test(tsx) &&
      tsx.includes('window.api.library.get(target.itemId)'),
    'MindMapPanel.tsx'
  )
  check(
    'PD53：节点尺寸按测量结果渲染（测量函数接入渲染与连边）',
    /measureMindmapNode\(/.test(tsx) &&
      /const sizeOf = useCallback/.test(tsx) &&
      /sizeOf\(node\.id\)\.width/.test(tsx) &&
      /const parentSize = sizeOf\(parent\.id\)/.test(tsx),
    'MindMapPanel.tsx'
  )
  check(
    'PD53：返回聚合视图前等待落盘（否则聚合读到旧子节点）',
    /inflightSaveRef/.test(tsx) &&
      /if \(!next\) return inflightSaveRef\.current/.test(tsx) &&
      /inflightSaveRef\.current\.then\(/.test(tsx),
    'MindMapPanel.tsx'
  )
  check(
    'PD53：不引入 dangerouslySetInnerHTML / rehype-raw',
    !tsx.includes('dangerouslySetInnerHTML') && !tsx.includes('rehype-raw'),
    'MindMapPanel.tsx'
  )
}

/** PD54：AI 工具库（分类清单 + 权限开关）纯逻辑 */
/** PD63（本任务）：AI 问答工具注册表 —— 工具名/参数校验/未知工具拒绝/只读越权拒绝 */
async function pd63AiChatToolTests(): Promise<void> {
  const ids = AI_CHAT_TOOL_IDS

  // ---- 注册表：至少 3 个只读工具，id 唯一，写入类默认关闭 ----
  const readonlyIds = ids.filter((id) => AI_CHAT_TOOLS[id].readonly)
  check(
    'PD63：问答工具注册表至少 3 个只读工具且 id 唯一',
    ids.length >= 3 && new Set(ids).size === ids.length && readonlyIds.length >= 3,
    ids.join(',')
  )
  check(
    'PD63：只读工具覆盖读全文/读指定页/翻译文本',
    (['read-paper', 'read-page', 'translate-text'] as string[]).every((id) =>
      readonlyIds.includes(id as never)
    ),
    readonlyIds.join(',')
  )
  check(
    'PD63：note-append 是写入类（不在只读集合），其余均为只读',
    !isReadonlyAiChatTool('note-append') &&
      ids.every((id) => id === 'note-append' || isReadonlyAiChatTool(id))
  )
  check(
    'PD63：每个只读工具都有参数说明（协议提示）',
    readonlyIds.every((id) => AI_CHAT_TOOLS[id].paramsHint.length > 0)
  )
  check(
    'PD63：每个只读工具的参数说明里都写明 1 基页码口径（避免模型猜 0 基）',
    AI_CHAT_TOOLS['read-paper'].paramsHint.includes('1 基') &&
      AI_CHAT_TOOLS['read-page'].paramsHint.includes('1 基')
  )
  check(
    'PD63：system 协议列出全部只读工具并写明协议行格式',
    readonlyIds.every((id) => CHAT_TOOL_PROTOCOL.includes(id)) &&
      CHAT_TOOL_PROTOCOL.includes('TOOL_CALL ')
  )

  // ---- 参数校验 ----
  check(
    'PD63：read-paper 校验拒绝 page<1 与 pages 越界',
    !AI_CHAT_TOOLS['read-paper'].validate({ page: 0 }).ok &&
      !AI_CHAT_TOOLS['read-paper'].validate({ pages: 99 }).ok
  )
  check(
    'PD63：read-paper 缺省参数给默认值（从第 1 页读 3 页）',
    (() => {
      const v = AI_CHAT_TOOLS['read-paper'].validate({})
      return v.ok && v.args.page === 1 && v.args.pages === 3
    })()
  )
  check(
    'PD63：read-paper 校验接受字符串页码并补默认值',
    (() => {
      const v = AI_CHAT_TOOLS['read-paper'].validate({ page: '2', pages: '3' })
      return v.ok && v.args.page === 2 && v.args.pages === 3
    })()
  )
  check(
    'PD63：read-page 校验要求 ≥1 整数页码，缺省/负数/浮点字符串都拒绝',
    !AI_CHAT_TOOLS['read-page'].validate({}).ok &&
      !AI_CHAT_TOOLS['read-page'].validate({ page: -1 }).ok &&
      !AI_CHAT_TOOLS['read-page'].validate({ page: '3.5' }).ok &&
      AI_CHAT_TOOLS['read-page'].validate({ page: 3 }).ok
  )
  check(
    'PD63：translate-text 校验拒绝空文本并回默认 lang=zh',
    !AI_CHAT_TOOLS['translate-text'].validate({ text: '  ' }).ok &&
      (() => {
        const v = AI_CHAT_TOOLS['translate-text'].validate({ text: ' hello ' })
        return v.ok && v.args.text === 'hello' && v.args.lang === 'zh'
      })()
  )
  check(
    'PD63：note-append 校验要求 section/content 且限长',
    !AI_CHAT_TOOLS['note-append'].validate({ section: '结论' }).ok &&
      !AI_CHAT_TOOLS['note-append'].validate({ content: 'x' }).ok &&
      AI_CHAT_TOOLS['note-append'].validate({ section: '结论', content: '要点' }).ok
  )

  // ---- mock Io ----
  const makeIo = (pages: number, pageText: (p: number) => string): AiChatToolIo => ({
    pageCount: async () => pages,
    pageText: async (p) => pageText(p),
    translate: async (text, lang) => ({ backend: 'test-backend', text: `${lang}:${text}` }),
    appendNote: async (section, content) => ({ noteTitle: `笔记#${section}#${content}` })
  })
  const io = makeIo(5, (p) => `第${p}页正文`)

  // ---- 未知工具拒绝 / io 缺失 / 越权 / 参数错误 ----
  try {
    await runAiChatTool('not-a-tool', {}, io)
    check('PD63：未知工具被拒绝', false, 'should throw')
  } catch (e) {
    check('PD63：未知工具被拒绝', (e as Error).message.includes('未知的问答工具：not-a-tool'))
  }
  try {
    await runAiChatTool('read-page', { page: 3 }, null)
    check('PD63：io 缺失被拒绝', false, 'should throw')
  } catch (e) {
    check('PD63：io 缺失被拒绝', (e as Error).message.includes('问答工具当前不可用'))
  }
  // ---- 只读工具越权拒绝（写入类默认关闭）----
  try {
    await runAiChatTool('note-append', { section: '结论', content: '要点' }, io)
    check('PD63：写入类工具默认关闭', false, 'should throw')
  } catch (e) {
    check('PD63：写入类工具默认关闭', (e as Error).message.includes('写入类工具已默认关闭'))
  }
  try {
    await runAiChatTool('note-append', { section: '结论', content: '要点' }, io, {
      writeToolsEnabled: true
    })
    check('PD63：未授权写入仍被拒绝', false, 'should throw')
  } catch (e) {
    check('PD63：未授权写入仍被拒绝', (e as Error).message.includes('未授权写入'))
  }
  try {
    await runAiChatTool('read-page', { page: 0 }, io)
    check('PD63：参数错误被拒绝', false, 'should throw')
  } catch (e) {
    check('PD63：参数错误被拒绝', (e as Error).message.includes('read-page 参数错误'))
  }
  // ---- 只读工具执行 ----
  const rp = await runAiChatTool('read-paper', { page: 3, pages: 2 }, io)
  check(
    'PD63：read-paper 分页返回（1 基页码，from/to 正确，hasMore=true）',
    rp.pageCount === 5 && rp.from === 3 && rp.to === 4 && rp.hasMore === true,
    JSON.stringify(rp)
  )
  const rpTxt = await runAiChatTool('read-paper', { page: 4, pages: 2 }, io)
  check(
    'PD63：read-paper 拼接连续页文本',
    String(rpTxt.text).includes('第4页正文') && String(rpTxt.text).includes('第5页正文')
  )
  const rpEmpty = await runAiChatTool('read-paper', {}, makeIo(0, () => ''))
  check('PD63：read-paper 无正文时如实报 empty', rpEmpty.empty === true)
  const rpClamp = await runAiChatTool('read-paper', { page: 9, pages: 2 }, io)
  check(
    'PD63：read-paper 起始页夹取到最后一页',
    rpClamp.from === 5 && rpClamp.to === 5,
    JSON.stringify(rpClamp)
  )
  const rpage = await runAiChatTool('read-page', { page: 9 }, io)
  check(
    'PD63：read-page 越界页码如实报错不伪造',
    rpage.empty === true && String(rpage.message).includes('共 5 页')
  )
  const okPage = await runAiChatTool('read-page', { page: 2 }, io)
  check('PD63：read-page 返回指定页文本', okPage.page === 2 && String(okPage.text) === '第2页正文')
  const tr = await runAiChatTool('translate-text', { text: 'hello' }, io)
  check(
    'PD63：translate-text 走注入的翻译后端',
    tr.backend === 'test-backend' && tr.text === 'zh:hello'
  )
  // ---- 写入类：双重开关打开才执行 ----
  const appended: string[] = []
  const ioWrite = makeIo(1, () => '')
  ioWrite.appendNote = async (section, content) => {
    appended.push(`${section}=${content}`)
    return { noteTitle: '阅读笔记' }
  }
  const wn = await runAiChatTool('note-append', { section: '结论', content: '要点' }, ioWrite, {
    allowWrite: true,
    writeToolsEnabled: true
  })
  check(
    'PD63：写入类工具双重开关后可执行',
    wn.ok === true && wn.noteTitle === '阅读笔记' && appended[0] === '结论=要点'
  )
  // ---- executeToolCalls：失败不中断、结果限长 ----
  const records = await executeToolCalls(
    [
      { name: 'read-page', args: { page: 1 } },
      { name: 'translate-text', args: { text: '' } },
      { name: 'unknown-x', args: {} }
    ],
    io
  )
  check(
    'PD63：executeToolCalls 单条失败不中断',
    records.length === 3 &&
      records[0].ok &&
      !records[1].ok &&
      records[2].ok === false &&
      records[2].body.includes('未知的问答工具：unknown-x')
  )

  // ---- parseToolCalls / stripToolCallLines / 结果块 ----
  const sample =
    '先读一下。\nTOOL_CALL {"name":"read-page","args":{"page":3}}\nTOOL_CALL not-json\n' +
    'TOOL_CALL {"name":"translate-text","args":{"text":"hi"}}'
  const calls = parseToolCalls(sample)
  check(
    'PD63：parseToolCalls 解析合法行、忽略坏 JSON 行',
    calls.length === 2 && calls[0].name === 'read-page' && calls[0].args.page === 3
  )
  check(
    'PD63：parseToolCalls 超过上限只取前 AI_CHAT_MAX_TOOL_CALLS 条',
    parseToolCalls(
      Array.from({ length: 10 }, (_, i) => `TOOL_CALL {"name":"read-page","args":{"page":${i + 1}}}`).join('\n')
    ).length === AI_CHAT_MAX_TOOL_CALLS
  )
  check(
    'PD63：stripToolCallLines 只删协议行',
    stripToolCallLines(sample) === '先读一下。\nTOOL_CALL not-json'
  )
  check(
    'PD63：块状围栏里的 TOOL_CALL 行也能被解析',
    parseToolCalls('```json\nTOOL_CALL {"name":"read-paper","args":{"page":1}}\n```').length === 1
  )
  const block = buildToolResultsBlock(1, [
    { name: 'read-page', ok: true, body: '{"page":3,"text":"结论片段"}' }
  ])
  check(
    'PD63：结果块包含工具名/结果与「最终回答不用再调用」的指令',
    block.includes('read-page') &&
      block.includes('结论片段') &&
      block.includes('FINAL answer') &&
      block.includes('Do NOT output any TOOL_CALL line')
  )
  check(
    'PD63：getAiChatTool 对未知/非字符串返回 null',
    getAiChatTool('nope') === null && getAiChatTool(123) === null
  )
}

function pd54AiToolsTests(): void {
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
  const ids = AI_TOOLS.map((def) => def.id)
  const defaults = resolveToolState(AI_TOOLS)

  check(
    'PD54：内置清单至少 6 项且 id 唯一',
    AI_TOOLS.length >= 6 && new Set(ids).size === ids.length,
    ids.join(',')
  )
  check(
    'PD54：清单覆盖问答/联网/拆解/拆解同步/地图 AI/批处理同步',
    ['ai-chat', 'web-search', 'paper-digest', 'digest-sync', 'mindmap-ai', 'batch-sync'].every(
      (id) => ids.includes(id)
    ),
    ids.join(',')
  )
  check(
    'PD54：分类与所需能力都是合法值',
    AI_TOOLS.every(
      (def) =>
        AI_TOOL_CATEGORIES.includes(def.category) &&
        def.requires.every((p) => AI_TOOL_PERMISSIONS.includes(p)) &&
        def.name.length > 0 &&
        def.description.length > 0 &&
        def.entryHint.length > 0
    ),
    'categories/permissions'
  )
  check(
    'PD54：web-search 需要联网、digest-sync 需要写入知识库、mindmap-ai 属于思维地图',
    same(findAiTool('web-search')?.requires, ['network']) &&
      same(findAiTool('digest-sync')?.requires, ['write-knowledge']) &&
      findAiTool('mindmap-ai')?.category === 'mindmap',
    'requires'
  )
  check(
    'PD54：默认状态全部启用、全部权限打开',
    defaults.length === ids.length &&
      defaults.every(
        (s) => s.enabled && AI_TOOL_PERMISSIONS.every((p) => s.permissions[p] === true)
      ),
    'defaults'
  )

  const closed = resolveToolState(AI_TOOLS, { 'web-search': { enabled: false } })
  check(
    'PD54：关闭开关只影响该工具',
    findToolState(closed, 'web-search')?.enabled === false &&
      closed.filter((s) => s.id !== 'web-search').every((s) => s.enabled),
    'web-search disabled'
  )

  const noWrite = resolveToolState(AI_TOOLS, {
    'digest-sync': { permissions: { 'write-knowledge': false } }
  })
  const noWriteState = findToolState(noWrite, 'digest-sync')
  check(
    'PD54：权限被覆盖时不误伤同一工具的其它权限',
    noWriteState?.permissions['write-knowledge'] === false &&
      noWriteState?.permissions.model === true &&
      noWriteState?.permissions.network === true,
    'permissions'
  )

  const unknownId = resolveToolState(AI_TOOLS, {
    'no-such-tool': { enabled: false },
    'web-search': { enabled: false }
  })
  check(
    'PD54：未知 id 被忽略（不新增条目、不影响其它）',
    unknownId.length === ids.length &&
      !unknownId.some((s) => s.id === 'no-such-tool') &&
      findToolState(unknownId, 'web-search')?.enabled === false,
    'unknown id'
  )

  const badInputs: unknown[] = [
    undefined,
    null,
    'off',
    42,
    [1, 2],
    { 'web-search': 'off' },
    { 'web-search': { enabled: 'no' } },
    { 'web-search': { permissions: { network: 0 } } },
    { 'web-search': { permissions: null } }
  ]
  check(
    'PD54：非法输入一律回退默认（全开）',
    badInputs.every((bad) => {
      const states = resolveToolState(AI_TOOLS, bad)
      return (
        states.length === ids.length &&
        states.every((s) => s.enabled && AI_TOOL_PERMISSIONS.every((p) => s.permissions[p] === true))
      )
    }),
    'fallback'
  )

  check(
    'PD54：isToolUsable 依据 enabled 与所需权限',
    isToolUsable(findToolState(defaults, 'web-search'), 'network') === true &&
      isToolUsable(findToolState(closed, 'web-search'), 'network') === false &&
      isToolUsable(findToolState(noWrite, 'digest-sync'), 'write-knowledge') === false &&
      isToolUsable(findToolState(noWrite, 'digest-sync'), 'model') === true &&
      isToolUsable(undefined, 'network') === true,
    'isToolUsable'
  )

  check(
    'PD54：关闭原因文案（验收约定的三处提示）',
    aiToolBlockReason(closed, [{ id: 'web-search', permission: 'network' }]) ===
      '已在 AI 工具库关闭联网检索' &&
      aiToolBlockReason(resolveToolState(AI_TOOLS, { 'mindmap-ai': { enabled: false } }), [
        { id: 'mindmap-ai' }
      ]) === '已在 AI 工具库关闭思维地图 AI' &&
      aiToolBlockReason(noWrite, [{ id: 'digest-sync', permission: 'write-knowledge' }]).includes(
        '拆解同步'
      ) &&
      aiToolBlockReason(noWrite, [{ id: 'digest-sync', permission: 'write-knowledge' }]).includes(
        '写入知识库'
      ) &&
      aiToolBlockReason(defaults, [{ id: 'web-search', permission: 'network' }]) === '',
    'block reason'
  )

  check(
    'PD54：持久化只写非默认项（全开时为空对象）',
    same(stateToOverrides(defaults), {}) &&
      same(stateToOverrides(closed), { 'web-search': { enabled: false } }) &&
      same(stateToOverrides(noWrite), {
        'digest-sync': { permissions: { 'write-knowledge': false } }
      }),
    'overrides'
  )

  check(
    'PD54：五个分类齐全，翻译分类暂无工具（界面显示 0）',
    AI_TOOL_CATEGORIES.length === 5 &&
      AI_TOOL_CATEGORIES.includes('translation') &&
      AI_TOOLS.filter((d) => d.category === 'translation').length === 0,
    'categories'
  )
}

/**
 * PD55：思维地图数据层（点锚点 / 规则与 AI 骨架 / 覆盖同步幂等 / AI 工具注册表）。
 * 全部是纯函数或注入式调用，不启动 GUI、不访问网络。
 */
async function pd55MindmapDataTests(): Promise<void> {
  const chunkText = '第一句讲研究问题。第二句跨句给出方法，第三句收尾结论。'
  const chunk = { text: chunkText, page: 7, bbox: '[10,20,30,40]', moduleId: 'mod-3' }

  // 1) 点锚点：句首 / 句中 / 句尾 / 跨句 / 找不到
  const atHead = locateAnchor(chunkText, '第一句讲研究问题', chunk)
  const atMiddle = locateAnchor(chunkText, '跨句给出方法', chunk)
  const atEnd = locateAnchor(chunkText, '第三句收尾结论', chunk)
  const across = locateAnchor(chunkText, '第二句跨句给出方法，第三句收尾', chunk)
  const missing = locateAnchor(chunkText, '完全不存在的引用内容', chunk)
  check(
    'PD55：点锚点覆盖句首/句中/句尾/跨句，偏移可在原文复现',
    !!atHead &&
      atHead.quoteStart === 0 &&
      !!atMiddle &&
      atMiddle.quoteStart === chunkText.indexOf('跨句给出方法') &&
      !!atEnd &&
      atEnd.quoteStart === chunkText.indexOf('第三句') &&
      !!across &&
      across.quoteStart === chunkText.indexOf('第二句') &&
      across.quoteEnd > across.quoteStart &&
      missing === null,
    JSON.stringify({ atHead, atMiddle, atEnd, across, missing })
  )
  check(
    'PD55：锚点透传页码/bbox/moduleId，bbox 为 NULL 时 rect=null',
    atMiddle.page === 7 &&
      JSON.stringify(atMiddle.rect) === JSON.stringify([10, 20, 30, 40]) &&
      atMiddle.moduleId === 'mod-3' &&
      locateAnchor(chunkText, '跨句给出方法', { text: chunkText, page: 1, bbox: null })?.rect ===
        null &&
      parseChunkRect('[10,20,30,40]') !== null &&
      parseChunkRect('bad') === null &&
      locateQuoteSpan(chunkText, '研究') === null &&
      MINDMAP_ANCHOR_MIN_QUOTE === 6,
    JSON.stringify({ atMiddle, rectNull: parseChunkRect(null) })
  )
  const serialized = serializeMindmapAnchor(atMiddle!)
  const reparsed = parseMindmapAnchor(serialized)
  check(
    'PD55：锚点可序列化并原样反解，坏数据不抛异常',
    JSON.stringify(reparsed) === JSON.stringify(normalizeMindmapAnchor(atMiddle)) &&
      serialized.includes('"quoteStart"') &&
      parseMindmapAnchor('{"page":1}') === null &&
      anchorQuote(chunkText, atMiddle!).replace(/\s+/g, '') === '跨句给出方法',
    serialized
  )

  // 2) 规则骨架：3 层 / 8–40 节点 / ≤80 字 / 禁 Markdown / id 稳定
  const markdownA = [
    '## 研究问题',
    '- 大模型推理成本高',
    '- 缺少可复现评测',
    '## 方法设计',
    '- 提出分层缓存',
    '- 引入自适应批处理',
    '## 实验结果',
    '- 延迟下降三成',
    '- 准确率保持不变',
    '## 数据与局限',
    '- 两个公开数据集',
    '- 长文本仍然偏慢'
  ].join('\n')
  const ruleA = buildRuleSkeleton({ title: '论文 A', markdown: markdownA })
  const ruleA2 = buildRuleSkeleton({ title: '论文 A', markdown: markdownA })
  const ruleTexts = ruleA.nodes.map((node) => node.text)
  check(
    'PD55：规则骨架为根→主题→要点三层，节点 8–40 且单节点 ≤80 字',
    ruleA.mode === 'rule' &&
      ruleA.nodes[0].id === MINDMAP_SKELETON_ROOT_ID &&
      ruleA.nodes[0].parentId === null &&
      ruleA.nodes.length >= MINDMAP_STRUCT_MIN_NODES &&
      ruleA.nodes.length <= MINDMAP_STRUCT_MAX_NODES &&
      ruleA.nodes.filter((node) => node.level === 2).length >= 2 &&
      ruleA.nodes.every(
        (node) =>
          node.text.length > 0 &&
          node.text.length <= MINDMAP_STRUCT_MAX_NODE_CHARS &&
          !hasSkeletonMarkup(node.text) &&
          (node.level === 1 ? node.parentId === null : typeof node.parentId === 'string')
      ),
    JSON.stringify({ nodes: ruleA.nodes.length, texts: ruleTexts })
  )
  check(
    'PD55：相同输入两次生成 id 与文本完全一致（幂等基础）',
    JSON.stringify(ruleA.nodes.map((node) => [node.id, node.text, node.parentId])) ===
      JSON.stringify(ruleA2.nodes.map((node) => [node.id, node.text, node.parentId])) &&
      skeletonNodeId(['论文 A', '研究问题']) ===
        ruleA.nodes.find((node) => node.text === '研究问题')?.id,
    ruleA.nodes.map((node) => node.id).join(',')
  )
  check(
    'PD55：节点文本清洗 Markdown 与省略号，截断不补省略号',
    cleanSkeletonText('**加粗**与 `code` 和[链接](https://x.test)…') ===
      '加粗与 code 和链接' &&
      !cleanSkeletonText('字'.repeat(200)).includes('…') &&
      cleanSkeletonText('字'.repeat(200)).length === MINDMAP_STRUCT_MAX_NODE_CHARS &&
      hasSkeletonMarkup('## 标题') &&
      !hasSkeletonMarkup('普通结论句'),
    cleanSkeletonText('**加粗**与 `code` 和[链接](https://x.test)…')
  )

  // 3) AI 骨架：合法 JSON 稳定 id；非法/不足回退规则并给可读 warning
  const aiRaw = JSON.stringify({
    topics: [
      { title: '研究问题', points: ['推理成本高', '评测缺失', '长尾明显', '跨域不足'] },
      { title: '方法', points: ['分层缓存', '自适应批处理', '调度优化', '量化压缩'] }
    ]
  })
  const aiNodes = parseSkeletonAiResult(aiRaw, { title: '论文 A', markdown: markdownA })
  const aiNodesAgain = parseSkeletonAiResult(aiRaw, { title: '论文 A', markdown: markdownA })
  const aiResult = buildSkeletonResult(
    { title: '论文 A', markdown: markdownA },
    aiNodes,
    null
  )
  const fallback = buildSkeletonResult(
    { title: '论文 A', markdown: markdownA },
    null,
    'AI 返回的骨架结构不完整，已回退到规则骨架'
  )
  check(
    'PD55：AI 严格 JSON 骨架可用时 mode=ai，id 由路径重算且两次一致',
    !!aiNodes &&
      aiNodes.length === 11 &&
      aiResult.mode === 'ai' &&
      aiResult.warnings.length === 0 &&
      JSON.stringify(aiNodesAgain?.map((node) => node.id)) ===
        JSON.stringify(aiNodes.map((node) => node.id)) &&
      aiNodes.every((node) => !hasSkeletonMarkup(node.text)),
    JSON.stringify({ count: aiNodes?.length, mode: aiResult.mode })
  )
  check(
    'PD55：非法 JSON / 节点不足回退规则骨架，warning 为可读中文且不抛异常',
    parseSkeletonAiResult('{坏 JSON', { title: '论文 A', markdown: markdownA }) === null &&
      parseSkeletonAiResult(
        '{"topics":[{"title":"只有一组","points":["a","b"]}]}',
        { title: '论文 A', markdown: markdownA }
      ) === null &&
      fallback.mode === 'rule' &&
      fallback.warnings.some((warning) => warning.includes('回退到规则骨架')) &&
      fallback.nodes.length >= MINDMAP_STRUCT_MIN_NODES,
    JSON.stringify(fallback.warnings)
  )

  // 4) 覆盖式同步：A→B 只剩 B + 用户节点；同内容 0/0；改名节点保留
  const userNode = { id: 'user-1', parentId: 'root', text: '我的笔记', x: 10, y: 360 }
  const baseDoc: MindMapDoc = {
    ...createMindMapDoc(1, '论文 A'),
    nodes: [...createMindMapDoc(1, '论文 A').nodes, userNode]
  }
  const skA = buildRuleSkeleton({ title: '论文 A', markdown: markdownA })
  const first = applySkeletonToMindMap(baseDoc, skA.nodes, { syncId: 'sync-a', mode: 'rule' })
  const docA = first.doc
  const markdownB = [
    '## 新的主题',
    '- 只保留这一批要点甲',
    '- 只保留这一批要点乙',
    '## 新的方法',
    '- 新方法要点丙',
    '- 新方法要点丁',
    '## 新的结果',
    '- 新结果要点戊',
    '- 新结果要点己'
  ].join('\n')
  const skB = buildRuleSkeleton({ title: '论文 A', markdown: markdownB })
  const second = applySkeletonToMindMap(docA, skB.nodes, { syncId: 'sync-b', mode: 'rule' })
  const docB = second.doc
  const third = applySkeletonToMindMap(docB, skB.nodes, { syncId: 'sync-b', mode: 'rule' })
  const oldSyncIds = docA.nodes
    .filter((node) => node.provenance?.source === 'sync')
    .map((node) => node.id)
  check(
    'PD55：覆盖同步 A→B 删除上一次同步节点、保留用户节点',
    first.added > 0 &&
      docA.nodes.some((node) => node.id === 'user-1') &&
      second.removed === oldSyncIds.length &&
      second.added > 0 &&
      docB.nodes.some((node) => node.id === 'user-1') &&
      oldSyncIds.every((id) => !docB.nodes.some((node) => node.id === id)) &&
      docB.nodes.every(
        (node) => node.provenance?.source !== 'sync' || node.provenance.syncId === 'sync-b'
      ),
    JSON.stringify({ first: first.added, second, userKept: true })
  )
  check(
    'PD55：同一份内容重复同步 added=0/removed=0（幂等）',
    third.added === 0 &&
      third.removed === 0 &&
      third.kept === 0 &&
      JSON.stringify(third.doc.nodes.map((node) => node.id)) ===
        JSON.stringify(docB.nodes.map((node) => node.id)),
    JSON.stringify({ added: third.added, removed: third.removed })
  )

  const target = docB.nodes.find(
    (node) => node.provenance?.source === 'sync' && node.provenance.syncId === 'sync-b'
  )!
  const renamedDoc: MindMapDoc = {
    ...docB,
    nodes: docB.nodes.map((node) => (node.id === target.id ? { ...node, text: '我改过的同步节点' } : node))
  }
  const markdownC = markdownB.replace('只保留这一批要点甲', '完全不同的第三批要点甲')
  const skC = buildRuleSkeleton({ title: '论文 A', markdown: markdownC })
  const fourth = applySkeletonToMindMap(renamedDoc, skC.nodes, { syncId: 'sync-c', mode: 'rule' })
  check(
    'PD55：用户改过名的同步节点不被覆盖/删除，并计入 kept',
    fourth.kept === 1 &&
      fourth.doc.nodes.some(
        (node) => node.id === target.id && node.text === '我改过的同步节点'
      ) &&
      fourth.doc.nodes.some((node) => node.id === 'user-1') &&
      fourth.doc.nodes.filter((node) => node.provenance?.source === 'sync').length ===
        skC.nodes.length - 1 &&
      fourth.doc.nodes
        .filter((node) => node.provenance?.source === 'sync')
        .every((node) => node.id === target.id || node.provenance?.syncId === 'sync-c'),
    JSON.stringify({
      kept: fourth.kept,
      removed: fourth.removed,
      skc: skC.nodes.length,
      syncCount: fourth.doc.nodes.filter((node) => node.provenance?.source === 'sync').length,
      textThere: fourth.doc.nodes.some(
        (node) => node.id === target.id && node.text === '我改过的同步节点'
      ),
      oldSync: fourth.doc.nodes
        .filter((node) => node.provenance?.source === 'sync' && node.id !== target.id)
        .filter((node) => node.provenance?.syncId !== 'sync-c').length
    })
  )
  const legacyDoc: MindMapDoc = {
    version: 1,
    itemId: 2,
    rootId: 'root',
    nodes: [
      { id: 'root', parentId: null, text: '老地图', x: 48, y: 48 },
      { id: 'legacy-1', parentId: 'root', text: '老节点', x: 296, y: 48 }
    ],
    updatedAt: new Date().toISOString()
  }
  const legacyApplied = applySkeletonToMindMap(legacyDoc, skA.nodes, {
    syncId: 'sync-legacy',
    mode: 'rule'
  })
  check(
    'PD55：无 provenance 的老节点按用户节点对待，永不被同步删除',
    legacyApplied.doc.nodes.some((node) => node.id === 'legacy-1') &&
      legacyApplied.removed === 0 &&
      legacyApplied.added === skA.nodes.length - 1,
    JSON.stringify({ added: legacyApplied.added, removed: legacyApplied.removed })
  )

  // 5) AI 工具注册表：5 个动作集中注册；support 透传可复现 anchor
  const supportPassage = {
    page: 7,
    text: chunkText,
    chunkText,
    bbox: '[10,20,30,40]',
    moduleId: 'mod-3'
  }
  const ctx: MindmapPromptContext = {
    paperTitle: '论文 A',
    nodeText: '方法',
    ancestors: [],
    children: [],
    passages: [supportPassage]
  }
  let supportAnchor: any = null
  let skeletonThroughRegistry: any = null
  const complete = async (system: string, user: string): Promise<string> => {
    void user
    if (system.includes('思维导图骨架')) return aiRaw
    return '{"found":true,"quote":"第二句跨句给出方法","page":7}'
  }
  supportAnchor = await runMindmapAiTool('node-support', { ctx }, complete)
  skeletonThroughRegistry = await runMindmapAiTool(
    'map-skeleton',
    { skeleton: { title: '论文 A', markdown: markdownA } },
    complete
  )
  check(
    'PD55：注册表集中登记 AI 动作（含 PD58 整图优化），旧 mindmap-ai 总开关保留',
    MINDMAP_AI_TOOL_IDS.length === 6 &&
      [
        'map-skeleton',
        'map-optimize',
        'node-summarize',
        'node-optimize',
        'node-expand',
        'node-support'
      ].every((id) => getMindmapAiTool(id)?.requires === 'model') &&
      getMindmapAiTool('unknown') === null &&
      Object.keys(MINDMAP_AI_TOOLS).length === 6 &&
      AI_TOOLS.filter((tool) => tool.category === 'mindmap').length >= 6 &&
      findAiTool('mindmap-ai')?.category === 'mindmap',
    JSON.stringify(MINDMAP_AI_TOOL_IDS)
  )
  const optimize = parseOptimizeResult(
    '{"topics":[{"title":"问题","points":["成本高","评测缺失"]},{"title":"方法","points":["缓存"]}]}'
  )
  check(
    'PD55：注册表 support 动作透传可复现 anchor，skeleton 动作走同一注册表',
    !!supportAnchor?.found &&
      supportAnchor.anchor?.page === 7 &&
      supportAnchor.anchor.quoteStart === chunkText.indexOf('第二句跨句给出方法') &&
      supportAnchor.anchor.quoteEnd ===
        chunkText.indexOf('第二句跨句给出方法') + '第二句跨句给出方法'.length - 1 &&
      JSON.stringify(supportAnchor.anchor.rect) === JSON.stringify([10, 20, 30, 40]) &&
      supportAnchor.anchor.moduleId === 'mod-3' &&
      anchorQuote(chunkText, supportAnchor.anchor).replace(/\s+/g, '') === '第二句跨句给出方法' &&
      Array.isArray(skeletonThroughRegistry) &&
      skeletonThroughRegistry.length === 11 &&
      skeletonThroughRegistry[0].id === MINDMAP_SKELETON_ROOT_ID,
    JSON.stringify({ anchor: supportAnchor?.anchor, skeleton: skeletonThroughRegistry?.length })
  )
  check(
    'PD55：AI 优化结果清洗为 2–6 个分组，少于 2 组时不可用',
    optimize.topics.length === 2 &&
      optimize.topics[0].text === '问题' &&
      optimize.topics[0].points.length === 2 &&
      parseOptimizeResult('{"topics":[{"title":"单组","points":["a"]}]}').topics.length === 1,
    JSON.stringify(optimize)
  )
}

/** PD57：节点全文显示 / 去 Markdown / AI 优化差异预览 */
function pd57MindmapRenderTests(): void {
  const markdownCases: Array<[string, string]> = [
    ['**粗体**', '粗体'],
    ['*斜体*', '斜体'],
    ['`行内代码`', '行内代码'],
    ['# 一级标题', '一级标题'],
    ['### 三级标题', '三级标题'],
    ['- 无序列表项', '· 无序列表项'],
    ['* 另一种列表符', '· 另一种列表符'],
    ['1. 有序列表项', '· 有序列表项'],
    ['> 引用的一句', '引用的一句'],
    ['[链接文字](https://example.com/a)', '链接文字'],
    ['![图注](pic.png)', '图注'],
    ['~~删除线~~', '删除线'],
    ['__加粗替代写法__', '加粗替代写法'],
    ['| 列一 | 列二 |', '列一 列二'],
    ['---', ''],
    ['- [ ] 待办事项', '· 待办事项'],
    ['- [x] 已完成', '· 已完成']
  ]
  const markdownFailures = markdownCases.filter(
    ([input, expected]) => stripMarkdownForMap(input) !== expected
  )
  check(
    'PD57：stripMarkdownForMap 覆盖 ≥10 种 Markdown 写法且保留文字',
    markdownFailures.length === 0,
    markdownFailures
      .map(([input, expected]) => `${input} → ${JSON.stringify(stripMarkdownForMap(input))}（期望 ${expected}）`)
      .join('；')
  )
  check(
    'PD57：多行 Markdown 保留换行但不保留列表/标题记号',
    stripMarkdownForMap('# 标题\n- 第一点\n- 第二点') === '标题\n· 第一点\n· 第二点',
    JSON.stringify(stripMarkdownForMap('# 标题\n- 第一点\n- 第二点'))
  )

  const longChinese =
    '这是一篇关于检索增强生成与长上下文推理的论文标题它故意写得很长用来验证节点不会出现省略号而是完整换行显示'
  const longEnglish =
    'A Very Long English Paper Title About Retrieval Augmented Generation With Long Context Reasoning And Evaluation'
  const shortSize = measureMindmapNode('短标题')
  const cnSize = measureMindmapNode(longChinese)
  const enSize = measureMindmapNode(longEnglish)
  check(
    'PD57：长中英文标题按 160–420px 测量并增高换行（不截断）',
    shortSize.width >= MINDMAP_NODE_MIN_W &&
      shortSize.width <= MINDMAP_NODE_MAX_W &&
      shortSize.height === MINDMAP_NODE_MIN_H &&
      cnSize.width === MINDMAP_NODE_MAX_W &&
      cnSize.height > MINDMAP_NODE_MIN_H &&
      enSize.width === MINDMAP_NODE_MAX_W &&
      enSize.height > MINDMAP_NODE_MIN_H &&
      !longChinese.includes('…') &&
      !measureMindmapNode('**' + longChinese + '**').width.toString().includes('…'),
    JSON.stringify({ shortSize, cnSize, enSize })
  )
  check(
    'PD57：测量使用去 Markdown 后的文本，粗体记号不撑宽节点',
    measureMindmapNode('**短标题**').width === shortSize.width &&
      measureMindmapNode('**短标题**').height === shortSize.height,
    JSON.stringify({ plain: shortSize, bold: measureMindmapNode('**短标题**') })
  )

  const optimized = parseOptimizeResult(
    JSON.stringify({
      rationale: '依据原文的方法与实验结论，只做措辞整理和去重',
      summary: '精简后的节点措辞',
      children: ['有依据的新子节点'],
      mergedIds: [],
      topics: [
        { title: '问题', points: ['成本高', '评测缺失'] },
        { title: '方法', points: ['缓存'] }
      ]
    })
  )
  check(
    'PD57：parseOptimizeResult 兼容 topics 并解析 summary/children/rationale',
    optimized.topics.length === 2 &&
      optimized.summary === '精简后的节点措辞' &&
      optimized.children?.length === 1 &&
      (optimized.rationale ?? '').includes('去重'),
    JSON.stringify(optimized)
  )
  check(
    'PD57：旧版只有 topics 的结果仍可用（向后兼容）',
    (() => {
      const legacy = parseOptimizeResult(
        '{"topics":[{"title":"问题","points":["成本高"]},{"title":"方法","points":["缓存"]}]}'
      )
      return legacy.topics.length === 2 && legacy.summary === undefined && (legacy.children?.length ?? 0) === 0
    })(),
    'legacy topics'
  )

  let doc = createMindMap(7, '论文 A')
  doc = addChild(doc, MINDMAP_ROOT_ID, '**粗体** 观点')
  doc = addChild(doc, MINDMAP_ROOT_ID, '重复的观点')
  doc = addChild(doc, MINDMAP_ROOT_ID, '重复的观点')
  const rootId = doc.rootId
  const beforeChildren = doc.nodes.filter((node) => node.parentId === rootId).length
  check(
    'PD57：textSimilarity 对完全相同文本返回 1，对无关文本低于合并阈值',
    textSimilarity('重复的观点', '重复的观点') === 1 &&
      textSimilarity('完全不同的内容', '另一个无关话题') < MINDMAP_MERGE_SIMILARITY,
    JSON.stringify({ same: textSimilarity('重复的观点', '重复的观点'), diff: textSimilarity('完全不同的内容', '另一个无关话题') })
  )
  const preview = buildOptimizePreview(doc, rootId, optimized)
  check(
    'PD57：优化预览同时包含精简措辞、补子节点、合并重复三类改动',
    !!preview &&
      preview.changes.some((change) => change.kind === 'rename') &&
      preview.changes.some((change) => change.kind === 'child') &&
      preview.changes.some((change) => change.kind === 'merge') &&
      (preview?.rationale ?? '').includes('去重'),
    JSON.stringify(preview?.changes)
  )

  const renameOnly = preview?.changes.find((change) => change.kind === 'rename')
  const renameResult = preview
    ? applyOptimizePreview(doc, preview, renameOnly ? [renameOnly.id] : [])
    : null
  check(
    'PD57：只接受「精简措辞」时仅改该节点文字，不增删子节点',
    !!renameResult &&
      renameResult.applied === 1 &&
      findNode(renameResult.doc, rootId)?.text === '精简后的节点措辞' &&
      renameResult.doc.nodes.filter((node) => node.parentId === rootId).length === beforeChildren,
    JSON.stringify({ applied: renameResult?.applied })
  )

  const allResult = preview
    ? applyOptimizePreview(doc, preview, preview.changes.map((change) => change.id))
    : null
  check(
    'PD57：应用全部改动后新增 3 个子节点、重复项只保留 1 条，改名生效',
    !!allResult &&
      allResult.applied === 5 &&
      findNode(allResult.doc, rootId)?.text === '精简后的节点措辞' &&
      allResult.doc.nodes.filter((node) => node.parentId === rootId).length ===
        beforeChildren + 3 - 1 &&
      allResult.doc.nodes.filter((node) => node.parentId === rootId && node.text === '重复的观点')
        .length === 1,
    JSON.stringify({ applied: allResult?.applied })
  )
  check(
    'PD57：未勾选任何改动时地图保持原样（可放弃）',
    (() => {
      if (!preview) return false
      const untouched = applyOptimizePreview(doc, preview, [])
      return untouched.applied === 0 && serializeMindMap(untouched.doc) === serializeMindMap(doc)
    })(),
    'empty acceptedIds'
  )
  check(
    'PD57：节点全文显示后长标题不会被 cleanNodeText 追加省略号',
    (() => {
      const cleaned = stripMarkdownForMap(longChinese.repeat(3))
      return !cleaned.endsWith('…') && cleaned.length > 60
    })(),
    'long title'
  )
}

/** PD58：整图 AI 优化（解析、大纲、差异预览、应用） */
function pd58MapOptimizeTests(): void {
  const parsed = parseMapOptimizeResult(
    JSON.stringify({
      rationale: '按问题/方法/结论重排',
      groups: [
        { title: '**问题** 定义', points: ['成本高', '成本高', '评测缺失'] },
        { title: '方法', points: ['缓存分层'] },
        { title: '结论', points: ['速度提升'] }
      ]
    })
  )
  check(
    'PD58：parseMapOptimizeResult 去掉 Markdown、去重要点并保留分组顺序',
    parsed.groups.length === 3 &&
      parsed.groups[0]?.title === '问题 定义' &&
      parsed.groups[0]?.points.length === 2 &&
      (parsed.rationale ?? '').includes('问题/方法'),
    JSON.stringify(parsed)
  )
  check(
    'PD58：要点与标题相同、空标题、非字符串要点都会被丢掉',
    (() => {
      const result = parseMapOptimizeResult(
        JSON.stringify({
          groups: [
            { title: '   ', points: ['A'] },
            { title: '问题', points: ['问题', 42, '', '真要点'] },
            { title: '只有空要点', points: [] }
          ]
        })
      )
      return (
        result.groups.length === 1 &&
        result.groups[0]?.title === '问题' &&
        result.groups[0]?.points.length === 1 &&
        result.groups[0]?.points[0] === '真要点'
      )
    })(),
    'filtered groups'
  )
  check(
    'PD58：坏 JSON 返回空分组而不是抛错（由上层给出可读提示）',
    parseMapOptimizeResult('not json at all').groups.length === 0 &&
      parseMapOptimizeResult('```json\n{"groups":[]}\n```').groups.length === 0,
    'garbage'
  )

  const base = addChild(
    addChild(createMindMap(58, '论文 B'), MINDMAP_ROOT_ID, '引言与**背景**'),
    MINDMAP_ROOT_ID,
    '方法概述'
  )
  const outline = mapOutlineFromDoc(base)
  check(
    'PD58：mapOutlineFromDoc 输出带缩进的大纲且去掉 Markdown 记号',
    outline.includes('- 引言与背景') && outline.includes('- 方法概述'),
    outline
  )

  const preview = buildMapOptimizePreview(base, {
    rationale: '合并重复',
    groups: [
      { title: '背景', points: ['领域现状', '领域现状', '方法概述'] },
      { title: '方法概述', points: ['新细节'] }
    ]
  })
  check(
    'PD58：预览复用已有根子节点（含包含关系）、跳过重复要点，并统计新增数',
    preview.groups.length === 2 &&
      preview.groups[0]?.reuseId != null &&
      preview.groups[1]?.reuseId != null &&
      preview.added === 3 &&
      preview.reused >= 2,
    JSON.stringify(preview)
  )
  check(
    'PD58：预览是纯函数，生成后原文档不变',
    serializeMindMap(base) === serializeMindMap(addChild(createMindMap(58, '论文 B'), MINDMAP_ROOT_ID, '引言与**背景**'))
      ? true
      : base.nodes.length === 3,
    'immutability'
  )

  const applied = applyMapOptimize(base, preview, preview.groups.map((group) => group.id))
  check(
    'PD58：应用预览新增分组与要点，并把它们标记为 AI 生成',
    applied.addedIds.length === preview.added &&
      applied.doc.nodes.length === base.nodes.length + preview.added &&
      applied.addedIds.every((id) => findNode(applied.doc, id)?.source === MINDMAP_MAP_SOURCE),
    JSON.stringify({ added: applied.addedIds.length, expected: preview.added })
  )
  check(
    'PD58：不勾选任何分组时文档原样返回',
    (() => {
      const untouched = applyMapOptimize(base, preview, [])
      return untouched.addedIds.length === 0 && serializeMindMap(untouched.doc) === serializeMindMap(base)
    })(),
    'empty accepted'
  )
  check(
    'PD58：用户手写节点不会被整图优化删除（只合并 AI/同步生成的重复叶子）',
    (() => {
      const doc = addChild(base, MINDMAP_ROOT_ID, '领域现状')
      const merged = applyMapOptimize(
        doc,
        buildMapOptimizePreview(doc, {
          groups: [{ title: '背景', points: ['领域现状'] }]
        }),
        ['group-1']
      )
      return merged.removedIds.length === 0 && merged.doc.nodes.some((node) => node.text === '领域现状' && !node.source)
    })(),
    'user node kept'
  )
  const prompt = buildMapOptimizePrompt({
    paperTitle: '论文 B',
    outline: '- 论文 B\n- 引言',
    passages: [{ page: 2, text: '原文片段', chunkId: null, bbox: null, moduleId: null }]
  })
  check(
    'PD58：整图优化提示词列出分组数量与输出 JSON 契约，且不含 Markdown 要求',
    prompt.user.includes('2') && prompt.user.includes('groups') && prompt.user.includes('论文 B'),
    prompt.user.slice(0, 120)
  )
}

/**
 * FA01：测试副本可控故障注入。
 * 两类注入（copy-fail / search-fail）都只在 IS_TEST_COPY 为真时生效；
 * 生产不可达由 resolveTestFault(false, ...) 恒返回 null 保证。
 */
function fa01TestFaultTests(): void {
  console.log('FA01 故障注入：测试副本可控、生产不可达')

  type Listener = (event: unknown, ...args: unknown[]) => unknown
  const makeHost = (): {
    host: { handle: (channel: string, listener: Listener) => void }
    registered: Array<{ channel: string; listener: Listener }>
  } => {
    const registered: Array<{ channel: string; listener: Listener }> = []
    return {
      host: {
        handle: (channel: string, listener: Listener): void => {
          registered.push({ channel, listener })
        }
      },
      registered
    }
  }

  // 1) 解析：只认受支持值，大小写与空白归一
  check('FA01：copy-fail 可解析', parseTestFault('copy-fail') === 'copy-fail')
  check('FA01：大写与空白归一为 search-fail', parseTestFault('  Search-FAIL \n') === 'search-fail')
  check('FA01：空值不生效', parseTestFault('') === null && parseTestFault(undefined) === null)
  check('FA01：未知故障不生效', parseTestFault('delete-all') === null)

  // 2) 生产不可达：非测试副本一律 null，环境变量与控制文件都不读
  check('FA01：生产忽略 copy-fail', resolveTestFault(false, 'copy-fail') === null)
  check('FA01：生产忽略 search-fail', resolveTestFault(false, 'search-fail') === null)
  check('FA01：测试副本识别 copy-fail', resolveTestFault(true, 'copy-fail') === 'copy-fail')
  check(
    'FA01：注入通道与 CH.search.query 一致',
    SEARCH_QUERY_CHANNEL === CH.search.query,
    SEARCH_QUERY_CHANNEL
  )
  check(
    'FA01：恢复读取器与 test-profile 共用同一 Symbol',
    TEST_FAULT_READER === Symbol.for('paperdesk.testFaultReader')
  )

  // 3) 环境变量只在测试副本里被读取
  const savedFaultEnv = process.env[TEST_FAULT_ENV]
  try {
    process.env[TEST_FAULT_ENV] = 'copy-fail'
    check('FA01：生产模式下环境变量无行为', activeTestFault(false) === null)
    check('FA01：生产模式下 testFaultActive 恒 false', testFaultActive('copy-fail', false) === false)
    check('FA01：测试副本读到环境变量', activeTestFault(true) === 'copy-fail')
    process.env[TEST_FAULT_ENV] = 'nonsense'
    check('FA01：无法识别的环境变量等于未开启', activeTestFault(true) === null)
  } finally {
    if (savedFaultEnv === undefined) delete process.env[TEST_FAULT_ENV]
    else process.env[TEST_FAULT_ENV] = savedFaultEnv
  }

  // 4) IPC 注入：只包装搜索查询通道，命中故障抛可读错误
  {
    const { host, registered } = makeHost()
    installSearchFaultInjection({ host, fault: () => 'search-fail', isTestCopy: true })
    const listListener: Listener = () => 'listed'
    const searchListener: Listener = () => 'hits'
    host.handle(CH.library.list, listListener)
    host.handle(CH.search.query, searchListener)
    const other = registered.find((entry) => entry.channel === CH.library.list)
    const search = registered.find((entry) => entry.channel === CH.search.query)
    check('FA01：非搜索通道原样注册', !!other && other.listener === listListener)
    check('FA01：搜索通道被包装而非直接注册', !!search && search.listener !== searchListener)
    const failure = search ? throws(() => search.listener({})) : null
    check('FA01：search-fail 命中时抛出注入错误', failure === SEARCH_FAULT_MESSAGE, String(failure))
    check('FA01：错误文案提示如何恢复', (failure ?? '').includes('test-fault.txt'))
  }

  // 5) 故障清除后同一通道立即恢复（无需重启）
  {
    const { host, registered } = makeHost()
    let fault: 'search-fail' | null = 'search-fail'
    installSearchFaultInjection({ host, fault: () => fault, isTestCopy: true })
    const searchListener: Listener = () => 'hits'
    host.handle(CH.search.query, searchListener)
    const search = registered.find((entry) => entry.channel === CH.search.query)!
    check('FA01：故障期间搜索被拦下', throws(() => search.listener({})) === SEARCH_FAULT_MESSAGE)
    fault = null
    check('FA01：清除故障后重试返回正常结果', search.listener({}) === 'hits')
  }

  // 6) 非测试副本根本不接管 ipcMain
  {
    const { host, registered } = makeHost()
    installSearchFaultInjection({ host, fault: () => 'search-fail', isTestCopy: false })
    host.handle(CH.search.query, () => 'hits')
    check(
      'FA01：非测试副本不接管 IPC 注册',
      registered.length === 1 && registered[0]!.listener({}) === 'hits'
    )
  }

  // 7) 源码级：GUI 的恢复链默认读 activeTestFault()，且注入发生在替换 live 之前
  const backupSrc = readFileSync(
    fileURLToPath(new URL('../src/main/services/backup.ts', import.meta.url)),
    'utf8'
  ).replace(/\r\n/g, '\n')
  const faultAt = backupSrc.indexOf("testFault === 'copy-fail'")
  check('FA01：恢复流程默认读取测试故障开关', backupSrc.includes('activeTestFault()'))
  check(
    'FA01：copy-fail 注入点在关闭/改名现有库之前',
    faultAt > 0 && faultAt < backupSrc.indexOf('renameSync(live, rollback)')
  )
}

/**
 * FA02：故障注入写进文档与回归自检，并在设置页暴露当前注入状态。
 * 文档必须字面列出两个取值；smoke 自检在未设置变量时输出 disabled 且 exit 0；
 * 设置页/契约接线各有源码断言（渲染层没有 DOM 单测基建，最终以 GUI 验收为准）。
 */
function fa02TestFaultUiTests(): void {
  console.log('FA02 故障注入：文档、冒烟自检与设置页状态')

  const rootOf = (rel: string): string =>
    fileURLToPath(new URL(rel, import.meta.url)).replace(/\\/g, '/')

  // 1) 文档必须字面写出环境变量名与两个受支持取值
  const codeMap = readFileSync(rootOf('../docs/CODE-MAP.md'), 'utf8').replace(/\r\n/g, '\n')
  check('FA02：CODE-MAP 提到 PAPERDESK_TEST_FAULT', codeMap.includes('PAPERDESK_TEST_FAULT'))
  check('FA02：CODE-MAP 提到 copy-fail', codeMap.includes('copy-fail'))
  check('FA02：CODE-MAP 提到 search-fail', codeMap.includes('search-fail'))

  // 2) 未设置环境变量时 smoke --fault-status 输出 disabled 且退出码 0（不依赖 Electron dist）
  const env = { ...process.env }
  delete env[TEST_FAULT_ENV]
  const smoke = spawnSync(
    process.execPath,
    [rootOf('../scripts/smoke-run.cjs'), '--fault-status'],
    { env, encoding: 'utf8', timeout: 30_000 }
  )
  const smokeOut = `${smoke.stdout ?? ''}${smoke.stderr ?? ''}`
  check('FA02：smoke --fault-status 退出码 0', smoke.status === 0, `status=${String(smoke.status)}`)
  check(
    'FA02：未设置变量时 smoke 输出 disabled',
    (smoke.stdout ?? '').includes('[smoke] test fault: disabled'),
    (smoke.stdout ?? '').trim()
  )
  check('FA02：--fault-status 不加载 Electron', !smokeOut.includes("Cannot find module 'electron'"), smokeOut.trim())

  // 3) 设置页源码：数据安全区块挂 testid，未启用/处理中/故障三种文案都在
  const settingsSrc = readFileSync(
    rootOf('../src/renderer/src/features/settings/SettingsDialog.tsx'),
    'utf8'
  )
  check('FA02：设置页暴露 test-fault-status', settingsSrc.includes('data-testid="test-fault-status"'))
  check('FA02：设置页展示未启用文案', settingsSrc.includes("'未启用'"))
  check(
    'FA02：设置页通过 IPC 取数',
    settingsSrc.includes('window.api.data') && settingsSrc.includes('.testFault()')
  )

  // 4) 契约接线：通道、preload、主进程 handler 三处都在
  check('FA02：CH.data.testFault 存在', CH.data.testFault === 'data:testFault')
  const preloadSrc = readFileSync(rootOf('../src/preload/index.ts'), 'utf8')
  check('FA02：preload 转发 testFault', preloadSrc.includes('CH.data.testFault'))
  const ipcSrc = readFileSync(rootOf('../src/main/ipc/data.ts'), 'utf8')
  check(
    'FA02：主进程注册 testFault 并读 activeTestFault',
    ipcSrc.includes('CH.data.testFault') && ipcSrc.includes('activeTestFault()')
  )
}

/**
 * G05：翻译设置面板的 GUI 复核契约。
 * 渲染层没有 DOM 单测基建，这里只锁「翻译模型/引擎控件可定位」与「保存载荷带上两者」；
 * 可见、可切换与保存后回读仍以 GUI 验收（设置弹窗截图 + window.api.settings.get 回读）为准。
 */
function g05TranslationSettingsUiTests(): void {
  console.log('G05 翻译设置面板：控件定位与保存载荷')
  const rootOf = (rel: string): string =>
    fileURLToPath(new URL(rel, import.meta.url)).replace(/\\/g, '/')
  const settingsSrc = readFileSync(
    rootOf('../src/renderer/src/features/settings/SettingsDialog.tsx'),
    'utf8'
  )
  check('G05：设置页「翻译模型」输入可定位', settingsSrc.includes('data-testid="set-provider-mtmodel"'))
  check('G05：设置页「引擎」下拉可定位', settingsSrc.includes('data-testid="set-mt-engine"'))
  check(
    'G05：引擎选项覆盖 simple/vision/pdf2zh',
    ['simple', 'vision', 'pdf2zh'].every((v) => settingsSrc.includes(`<option value="${v}">`))
  )
  check(
    'G05：保存载荷包含翻译模型与引擎',
    settingsSrc.includes('mtModel: s.provider.mtModel') && settingsSrc.includes('engine: s.mt.engine')
  )
}

/* ---------- F02：批处理取消传播到正在执行的翻译 ---------- */
async function f02BatchCancelTests(): Promise<void> {
  const queue = await loadF02Queue()
  const srcOf = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n')

  // 1) 两篇文档：首篇执行中取消 → 第二篇不得自动开始，取消后不再广播 running
  {
    let cancel = false
    const started: number[] = []
    const registered: number[] = []
    const cancelledItems: number[] = []
    const failedItems: number[] = []
    const runningBroadcasts: number[] = []
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const plan = (id: number): any => ({
      start: () => started.push(id),
      run: async () => {
        await gate
        throw new Error('已取消')
      },
      done: () => registered.push(id),
      cancelled: () => cancelledItems.push(id),
      failed: () => failedItems.push(id)
    })
    const loopPromise = queue.runBatchItemLoop({
      items: [plan(1), plan(2)],
      isCancelled: () => cancel,
      broadcastRunning: () => runningBroadcasts.push(1)
    })
    await new Promise((r) => setTimeout(r, 5))
    check('F02：首篇开始后第二篇尚未启动', started.length === 1 && started[0] === 1, JSON.stringify(started))
    cancel = true
    release!()
    const loop = await loopPromise
    check(
      'F02：取消后不再发起新的翻译请求（等待条目不会自动开始）',
      started.join(',') === '1',
      JSON.stringify(started)
    )
    check(
      'F02：取消终止的条目不记失败、不登记结果',
      loop.outcomes.join(',') === 'cancelled,skipped' &&
        cancelledItems.join(',') === '1' &&
        failedItems.length === 0 &&
        registered.length === 0,
      JSON.stringify({ outcomes: loop.outcomes, cancelledItems, failedItems, registered })
    )
    check('F02：取消后不再广播 running', runningBroadcasts.length === 0, String(runningBroadcasts.length))
  }

  // 2) 首篇完成后立刻取消 → 等待中的条目不会自动开始
  {
    let cancel = false
    const started: number[] = []
    const registered: number[] = []
    const runningBroadcasts: number[] = []
    const plan = (id: number): any => ({
      start: () => started.push(id),
      run: async () => ({ outputs: [`f${id}`] }),
      done: () => registered.push(id),
      cancelled: () => {},
      failed: () => {}
    })
    const loop = await queue.runBatchItemLoop({
      items: [plan(1), plan(2)],
      isCancelled: () => cancel,
      broadcastRunning: () => runningBroadcasts.push(1),
      progress: () => {
        cancel = true
      }
    })
    check(
      'F02：条目完成后取消，等待中的条目不再启动',
      started.join(',') === '1' && loop.outcomes.join(',') === 'done,skipped',
      JSON.stringify({ started, outcomes: loop.outcomes })
    )
    check('F02：已完成条目照常登记', registered.join(',') === '1')
    check('F02：取消后进度不再广播 running', runningBroadcasts.length === 0)
  }

  // 3) 取消与完成同时到达：完成优先，登记完成；作业仍标记取消
  {
    let cancel = false
    const registered: number[] = []
    const runningBroadcasts: number[] = []
    const plan = (id: number): any => ({
      start: () => {},
      run: async () => {
        if (id === 1) cancel = true
        return { outputs: [`f${id}`] }
      },
      done: () => registered.push(id),
      cancelled: () => {
        throw new Error('完成的条目不应走取消分支')
      },
      failed: () => {
        throw new Error('完成的条目不应走失败分支')
      }
    })
    const loop = await queue.runBatchItemLoop({
      items: [plan(1), plan(2)],
      isCancelled: () => cancel,
      broadcastRunning: () => runningBroadcasts.push(1)
    })
    check(
      'F02：取消与完成同时到达时完成优先登记',
      loop.outcomes[0] === 'done' && registered.join(',') === '1',
      JSON.stringify({ outcomes: loop.outcomes, registered })
    )
    check('F02：完成优先后等待条目不启动', loop.outcomes.join(',') === 'done,skipped')
    check('F02：完成优先后作业仍归属取消', loop.cancelled === true)
    check(
      'F02：取消后 running 广播闸门关闭',
      queue.shouldBroadcastRunning(true) === false && queue.shouldBroadcastRunning(false) === true
    )
  }

  // 4) 未取消时的失败路径保持原语义（失败计入 failed，不误判为取消）
  {
    const plan = (id: number, boom: boolean): any => ({
      start: () => {},
      run: async () => {
        if (boom) throw new Error('翻译失败')
        return { outputs: [`f${id}`] }
      },
      done: () => {},
      cancelled: () => {},
      failed: () => {}
    })
    const loop = await queue.runBatchItemLoop({
      items: [plan(1, false), plan(2, true), plan(3, false)],
      isCancelled: () => false,
      broadcastRunning: () => {}
    })
    check(
      'F02：未取消时失败条目正常计入 failed 且继续执行',
      loop.outcomes.join(',') === 'done,failed,done' &&
        loop.failed === 1 &&
        loop.processed === 3 &&
        loop.cancelled === false,
      JSON.stringify(loop)
    )
  }

  // 5) 源码级接线：queue 使用纯逻辑执行器与广播闸门，取消不再写成 failed/清零进度
  const queueSrc = srcOf('../src/main/services/batch/queue.ts')
  check('F02：queue 使用 runBatchItemLoop 执行条目', queueSrc.includes('await runBatchItemLoop({'))
  check(
    'F02：queue 的 running 广播经取消闸门',
    queueSrc.includes('shouldBroadcastRunning(cancelled.has(job.id))') &&
      queueSrc.includes('broadcastRunning: () => emitRunning()')
  )
  check(
    'F02：取消条目记为 cancelled 而不是 failed',
    queueSrc.includes("status = 'cancelled', message = '已取消' WHERE id = ?") &&
      !queueSrc.includes("status = 'failed', message = '已取消'")
  )
  check(
    'F02：cancelJob 只为运行中作业留内存标记并保留真实进度',
    queueSrc.includes('if (wasRunning) cancelled.add(jobId)') &&
      queueSrc.includes('done: job.done') &&
      !queueSrc.includes("status: 'cancelled', done: 0, total: 0")
  )

  // 6) 源码级接线：翻译任务把 ctx.isCancelled 传给两个 runTranslation 调用点
  const registrySrc = srcOf('../src/main/services/batch/registry.ts')
  check(
    'F02：translate 与 translate-archive 都把取消信号传入 runTranslation',
    (registrySrc.match(/ctx\.isCancelled\s*\n\s*\)/g) ?? []).length === 2
  )
  check(
    'F02：取消后不再发起新模型请求（任务入口与归档前均检查）',
    (registrySrc.match(/if \(ctx\.isCancelled\(\)\) throw new Error\('已取消'\)/g) ?? []).length >= 5
  )
}

// 分组区 / 文献列表上下分栏：高度夹取（上下限）与双击复位
function groupSplitterTests(): void {
  check(
    '分栏：低于下限被夹到最小高度',
    clampGroupPaneHeight(GROUP_PANE_MIN_HEIGHT - 80) === GROUP_PANE_MIN_HEIGHT,
    String(clampGroupPaneHeight(GROUP_PANE_MIN_HEIGHT - 80))
  )
  check(
    '分栏：高于上限被夹到「可用高度 - 列表最小高度」',
    clampGroupPaneHeight(9999, 700) === 700 - GROUP_PANE_LIST_MIN_HEIGHT &&
      maxGroupPaneHeight(700) === 700 - GROUP_PANE_LIST_MIN_HEIGHT,
    `${clampGroupPaneHeight(9999, 700)} / ${maxGroupPaneHeight(700)}`
  )
  check(
    '分栏：窗口很矮时上限不低于最小高度',
    maxGroupPaneHeight(200) === GROUP_PANE_MIN_HEIGHT &&
      clampGroupPaneHeight(9999, 200) === GROUP_PANE_MIN_HEIGHT
  )
  check(
    '分栏：非数字高度退回默认值',
    clampGroupPaneHeight(Number.NaN) === GROUP_PANE_DEFAULT_HEIGHT
  )
  check(
    '分栏：拖动按位移增减高度',
    groupPaneHeightFromDrag(GROUP_PANE_DEFAULT_HEIGHT, 60, 800) ===
      GROUP_PANE_DEFAULT_HEIGHT + 60 &&
      groupPaneHeightFromDrag(GROUP_PANE_DEFAULT_HEIGHT, -60, 800) ===
        GROUP_PANE_DEFAULT_HEIGHT - 60
  )
  check(
    '分栏：拖动越过下限/上限仍被夹取',
    groupPaneHeightFromDrag(GROUP_PANE_DEFAULT_HEIGHT, -9999, 800) ===
      GROUP_PANE_MIN_HEIGHT &&
      groupPaneHeightFromDrag(GROUP_PANE_DEFAULT_HEIGHT, 9999, 700) ===
        700 - GROUP_PANE_LIST_MIN_HEIGHT
  )
  check(
    '分栏：双击复位回到默认高度（矮窗口按同一套夹取规则）',
    resetGroupPaneHeight(800) === GROUP_PANE_DEFAULT_HEIGHT &&
      resetGroupPaneHeight(200) === GROUP_PANE_MIN_HEIGHT
  )
}

void (async () => {
  await groupOrderTests()
  await blocksPassthroughTests()
  await blocksAdapterSettingTests()
  groupSplitterTests()
  pd46DesignTokenTests()
  await pd55MindmapDataTests()
  pd31KnowledgePlaceholderTests()
  pd33KnowledgeTests()
  pd34StagingTests()
  pd35KnowledgeReviewTests()
  pd36EntryVisibilityTests()
  pd37AiPresetTests()
  pd38DigestSyncTests()
  pd41ImportTests()
  pd39ScopedSearchTests()
  pd40ChunkEvidenceTests()
  pd42RetrievalModeTests()
  pd43BatchSyncTests()
  pd44BatchSyncTests()
  pd30MindmapExportTests()
  pd48MindmapScopeTests()
  pd50PaperAndCiteTests()
  pd51StagingPanelTests()
  pd53MindmapPanelTests()
  pd57MindmapRenderTests()
  pd58MapOptimizeTests()
  pd64SelectionTextTests()
  textReflowTests()
  readerHalfPageScrollTests()
  readerSyncAnchorTests()
  pd54AiToolsTests()
  await pd63AiChatToolTests()
  await pd29MindmapAiTests()
  pd28MindmapSkeletonTests()
  pd27MindmapTests()
  pd26SelectionMapTests()
  pd01RestoreSafetyTests()
  fa01TestFaultTests()
  fa02TestFaultUiTests()
  g05TranslationSettingsUiTests()
  pd02LibraryImportGroupingTests()
  await pd20NetworkTests()
  p1AskIntentTests()
  p2GroupPaneTests()
  p4PublicationTests()
  p6OrganizeTests()
  p5PdfPageTests()
  await f02BatchCancelTests()
  // ---------- 模型鉴权：按接口协议选 x-api-key / Authorization（阶段四修正） ----------
  const protocol = await import('../src/shared/model-protocol.ts')
  check('协议：完整端点不重复拼接', protocol.modelEndpoint('https://relay.example/v1/messages', 'anthropic') === 'https://relay.example/v1/messages')
  check('协议：根地址补全 v1', protocol.modelEndpoint('https://api.openai.com') === 'https://api.openai.com/v1/chat/completions')
  const wire = protocol.chatRequest('https://relay.example/v1/messages', 'synthetic-test-key', {
    model: 'claude-test', stream: true, messages: [{ role: 'system', content: 'system prompt' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }]
  })
  const anthropicBody = wire.body as any
  check('协议：Anthropic 独立 system 与 max_tokens', anthropicBody.system === 'system prompt' && anthropicBody.max_tokens > 0 && anthropicBody.messages.length === 1)
  check('协议：Anthropic 视觉图片转换', anthropicBody.messages[0].content[0].source.media_type === 'image/png')
  check('协议：Anthropic 使用版本头和 x-api-key', wire.headers['anthropic-version'] === '2023-06-01' && wire.headers['x-api-key'] === 'synthetic-test-key' && !wire.headers.Authorization)
  check('协议：忽略 thinking 块，只取文本', protocol.chatResponseText({ content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'answer' }] }) === 'answer')
  check('协议：Anthropic 流式文本增量', protocol.chatStreamText({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'delta' } }) === 'delta')
  let streamError = false
  try { protocol.chatStreamText({ type: 'error', error: { message: 'overloaded' } }) } catch { streamError = true }
  check('协议：流式错误不能被吞掉', streamError)
  const ocAuth = modelAuthHeaders('https://opencode.ai/zen/go/v1/chat/completions', 'sk-test')
  check(
    '鉴权：OpenAI 兼容端点（哪怕是 OpenCode 域名）用 Authorization Bearer',
    ocAuth.Authorization === 'Bearer sk-test' && !('x-api-key' in ocAuth),
    JSON.stringify(ocAuth)
  )
  const anthropicAuth = modelAuthHeaders('https://api.anthropic.com/v1/messages', 'sk-test')
  check(
    '鉴权：Anthropic /messages 用 x-api-key',
    anthropicAuth['x-api-key'] === 'sk-test' && !('Authorization' in anthropicAuth),
    JSON.stringify(anthropicAuth)
  )
  check(
    '鉴权：显式协议优先于 URL 推断',
    modelAuthHeaders('https://relay.example.com/v1/messages', 'sk-test', 'openai').Authorization ===
      'Bearer sk-test'
  )
  check(
    '鉴权：/zen/go 路径也算 OpenCode 端点',
    isOpenCodeBaseUrl('https://relay.example.com/zen/go/v1') === true
  )
  const oaAuth = modelAuthHeaders('https://api.openai.com/v1', 'sk-test')
  check(
    '鉴权：其它 baseUrl 仍用 Authorization Bearer',
    oaAuth.Authorization === 'Bearer sk-test' && !('x-api-key' in oaAuth),
    JSON.stringify(oaAuth)
  )
  check(
    '鉴权：未配置 key 不生成鉴权头',
    Object.keys(modelAuthHeaders('https://api.openai.com/v1', '')).length === 0
  )
  console.log(failed === 0 ? 'UNIT_OK' : `UNIT_FAIL (${failed})`)
  process.exitCode = failed === 0 ? 0 : 1
})()

// READER-HALF-PAGE：滚动位置 ↔ 页码/页内偏移换算（含边界）与「上一页/下一页」半页连续滚动
function readerHalfPageScrollTests(): void {
  // 三页文档：页高 800/820/900，页间留白 30px（首页末尾 800，次页顶边 830）
  const pages: ScrollPageBox[] = [
    { page: 0, offsetTop: 0, offsetHeight: 800 },
    { page: 1, offsetTop: 830, offsetHeight: 820 },
    { page: 2, offsetTop: 1670, offsetHeight: 900 }
  ]

  // —— locateByMid：视口中线 → 页码 + 页内比例（常规 + 边界）——
  const midFirst = locateByMid(400, pages)
  check(
    '翻页换算：中线在首页中部 → 0 基页 0，页内比例 0.5',
    midFirst.page === 0 && Math.abs(midFirst.frac - 0.5) < 1e-9,
    JSON.stringify(midFirst)
  )
  const atTop = locateByMid(0, pages)
  check(
    '翻页换算：中线恰在首页顶边 → 0 基页 0，比例 0',
    atTop.page === 0 && atTop.frac === 0,
    JSON.stringify(atTop)
  )
  const inGap = locateByMid(815, pages)
  check(
    '翻页换算：中线落在页间留白（< 次页顶边）→ 属首页，比例夹取为 1',
    inGap.page === 0 && inGap.frac === 1,
    JSON.stringify(inGap)
  )
  const atBoundary = locateByMid(830, pages)
  check(
    '翻页换算：中线恰在次页顶边 → 算次页（0 基页 1），比例 0',
    atBoundary.page === 1 && atBoundary.frac === 0,
    JSON.stringify(atBoundary)
  )
  const midLast = locateByMid(2120, pages)
  check(
    '翻页换算：中线在末页中部（1670+450）→ 0 基页 2，比例 0.5',
    midLast.page === 2 && Math.abs(midLast.frac - 0.5) < 1e-9,
    JSON.stringify(midLast)
  )
  const pastTail = locateByMid(1e6, pages)
  check(
    '翻页换算：中线越过末页尾部（末页滚动被夹取的形态）→ 末页，比例夹取为 1',
    pastTail.page === 2 && pastTail.frac === 1,
    JSON.stringify(pastTail)
  )
  const aboveAll = locateByMid(-50, pages)
  check(
    '翻页换算：中线高于所有页顶边 → 首页兜底，比例 0',
    aboveAll.page === 0 && aboveAll.frac === 0,
    JSON.stringify(aboveAll)
  )
  const emptyBox = locateByMid(100, [])
  check(
    '翻页换算：空容器（隐藏视图无布局）→ 兜底 0 基页 0，比例 0',
    emptyBox.page === 0 && emptyBox.frac === 0,
    JSON.stringify(emptyBox)
  )
  const badMid = locateByMid(Number.NaN, pages)
  check(
    '翻页换算：mid 非有限 → 兜底 0 基页 0，比例 0',
    badMid.page === 0 && badMid.frac === 0,
    JSON.stringify(badMid)
  )
  const zeroHeight = locateByMid(950, [{ page: 0, offsetTop: 0, offsetHeight: 0 }])
  check(
    '翻页换算：零页高不错除 → 比例按 1 页高计，仍得 0 基页 0',
    zeroHeight.page === 0 && zeroHeight.frac === 0,
    JSON.stringify(zeroHeight)
  )
  const singlePage = locateByMid(1600, [{ page: 0, offsetTop: 0, offsetHeight: 800 }])
  check(
    '翻页换算：单页文档中线越界 → 末页（也是首页），比例夹取为 1',
    singlePage.page === 0 && singlePage.frac === 1,
    JSON.stringify(singlePage)
  )

  // —— halfPageScrollTop：半页步进（上一页/下一页按钮的连续滚动落点）——
  const step = (a: Partial<Parameters<typeof halfPageScrollTop>[0]>): number =>
    halfPageScrollTop({
      scrollTop: 0,
      viewport: 600,
      scrollMax: 4000,
      dir: 1,
      ...a
    } as Parameters<typeof halfPageScrollTop>[0])

  check('半页步进：下一半页 0 → 300（半个视口）', step({ scrollTop: 0 }) === 300, step({ scrollTop: 0 }))
  check(
    '半页步进：上一半页 700 → 400',
    step({ scrollTop: 700, dir: -1 }) === 400,
    step({ scrollTop: 700, dir: -1 })
  )
  check(
    '半页步进：接近底部时向下夹取到文档底（4000）',
    step({ scrollTop: 3900 }) === 4000,
    step({ scrollTop: 3900 })
  )
  check(
    '半页步进：接近顶部时向上夹取到文档顶（0）',
    step({ scrollTop: 100, dir: -1 }) === 0,
    step({ scrollTop: 100, dir: -1 })
  )
  check(
    '半页步进：隐藏视图（viewport 0）→ 原值不动',
    step({ scrollTop: 120, viewport: 0 }) === 120,
    step({ scrollTop: 120, viewport: 0 })
  )
  check(
    '半页步进：无滚动余量（scrollMax <= 0）→ 夹取到 0',
    step({ scrollTop: 50, scrollMax: -5 }) === 0,
    step({ scrollTop: 50, scrollMax: -5 })
  )
  check(
    '半页步进：自定义比例 0.75 → 450',
    step({ scrollTop: 0, ratio: 0.75 }) === 450,
    step({ scrollTop: 0, ratio: 0.75 })
  )
  check(
    '半页步进：越界比例夹取到 1 → 整个视口（600）',
    step({ scrollTop: 0, ratio: 1.5 }) === 600,
    step({ scrollTop: 0, ratio: 1.5 })
  )
  check('半页步进：默认比例常量为 0.5', HALF_PAGE_STEP_RATIO === 0.5)

  // —— scrollEdgeFlags：翻页按钮禁用所依据的文档顶/底边标记 ——
  const edges = (scrollTop: number, viewport = 600, scrollHeight = 4000): { top: boolean; bottom: boolean } =>
    scrollEdgeFlags({ scrollTop, viewport, scrollHeight })

  check(
    '滚动边缘：文档顶 → top=true底下=false，上一页按钮禁用',
    JSON.stringify(edges(0)) === '{"top":true,"bottom":false}',
    JSON.stringify(edges(0))
  )
  check(
    '滚动边缘：顶边 1px 容差内 → top=true',
    edges(1).top === true,
    JSON.stringify(edges(1))
  )
  check(
    '滚动边缘：文档中部 → 两侧都未贴边（按钮双双可用）',
    JSON.stringify(edges(1600)) === '{"top":false,"bottom":false}',
    JSON.stringify(edges(1600))
  )
  check(
    '滚动边缘：恰在文档底（scrollHeight-viewport=3400）→ bottom=true',
    JSON.stringify(edges(3400)) === '{"top":false,"bottom":true}',
    JSON.stringify(edges(3400))
  )
  check(
    '滚动边缘：底边 1px 容差内 → bottom=true',
    edges(3399, 600, 4000).bottom === true,
    JSON.stringify(edges(3399, 600, 4000))
  )
  check(
    '滚动边缘：越界滚动 → bottom=true（夹取形态）',
    edges(3500, 600, 4000).bottom === true,
    JSON.stringify(edges(3500, 600, 4000))
  )
  check(
    '滚动边缘：隐藏视图 / 空容器 → 双 false（不锁死按钮）',
    JSON.stringify(edges(0, 0, 0)) === '{"top":false,"bottom":false}' &&
      JSON.stringify(edges(0, 600, 200)) === '{"top":false,"bottom":false}',
    `${JSON.stringify(edges(0, 0, 0))} ${JSON.stringify(edges(0, 600, 200))}`
  )
}

// PD-READER-SYNC：对照视图双向联动的锚点映射（页号 + 页内比例 ↔ 滚动偏移；可逆、越界夹取）
function readerSyncAnchorTests(): void {
  // 与 readerHalfPageScrollTests 同一三页文档：{页码, offsetTop, offsetHeight}
  const pages: ScrollPageBox[] = [
    { page: 0, offsetTop: 0, offsetHeight: 800 },
    { page: 1, offsetTop: 830, offsetHeight: 820 },
    { page: 2, offsetTop: 1670, offsetHeight: 900 }
  ]
  const viewport = 600
  const scrollMax = 1670 + 900 - viewport

  // 1) 基础映射：页顶锚点 → 该页顶部出现在视口顶（frac=0 目标在页顶再退半个视口，受文档顶端夹取）
  check(
    '锚点映射：第 1 页 frac 0 → 滚到文档顶（viewport 未达全页高时夹取为 0）',
    anchorToScrollTop({ page: 0, frac: 0, boxes: pages, viewport, scrollMax }) === 0,
    String(anchorToScrollTop({ page: 0, frac: 0, boxes: pages, viewport, scrollMax }))
  )
  // 第 2 页（offsetTop 830）frac 0：目标 = 830 - 300 = 530
  check(
    '锚点映射：第 2 页 frac 0 → 页顶 - 半视口',
    anchorToScrollTop({ page: 1, frac: 0, boxes: pages, viewport, scrollMax }) === 530,
    String(anchorToScrollTop({ page: 1, frac: 0, boxes: pages, viewport, scrollMax }))
  )
  // 第 2 页 frac 0.5：目标 = 830 + 410 - 300 = 940
  check(
    '锚点映射：第 2 页 frac 0.5 → 页顶 + 半页高 - 半视口',
    anchorToScrollTop({ page: 1, frac: 0.5, boxes: pages, viewport, scrollMax }) === 940,
    String(anchorToScrollTop({ page: 1, frac: 0.5, boxes: pages, viewport, scrollMax }))
  )

  // 2) 双向可逆：锚点 → 滚动 → locateByMid 读回 → 再映射 → 同一锚点（视口内未夹取时）
  for (const [pg, fr] of [
    [0, 0.5],
    [1, 0.25],
    [1, 0.75],
    [2, 0.5]
  ] as Array<[number, number]>) {
    const st = anchorToScrollTop({ page: pg, frac: fr, boxes: pages, viewport, scrollMax })
    if (st === null) {
      check(`锚点映射：可逆（${pg} 页 ${fr}）`, false, 'anchor 返回 null')
      continue
    }
    const back = locateByMid(st + viewport / 2, pages)
    const st2 = anchorToScrollTop({ page: back.page, frac: back.frac, boxes: pages, viewport, scrollMax })
    check(
      `锚点映射：可逆（${pg} 页 ${fr}）`,
      st2 !== null && Math.abs(st2 - st) < 0.5 && back.page === pg,
      `st=${st} back=${JSON.stringify(back)} st2=${st2}`
    )
  }

  // 3) 越界夹取：页码 / frac / 落点
  check(
    '锚点夹取：页码超出末页 → 夹到最后一页',
    anchorToScrollTop({ page: 99, frac: 0, boxes: pages, viewport, scrollMax }) !== null &&
      locateByMid(
        (anchorToScrollTop({ page: 99, frac: 0, boxes: pages, viewport, scrollMax }) as number) + viewport / 2,
        pages
      ).page === 2,
    String(anchorToScrollTop({ page: 99, frac: 0, boxes: pages, viewport, scrollMax }))
  )
  check(
    '锚点夹取：frac 越界（1.7）→ 按 frac 1 落到页尾，文档底端夹取',
    anchorToScrollTop({ page: 1, frac: 1.7, boxes: pages, viewport, scrollMax }) ===
      Math.min(scrollMax, 830 + 820 - viewport / 2),
    String(anchorToScrollTop({ page: 1, frac: 1.7, boxes: pages, viewport, scrollMax }))
  )
  check(
    '锚点夹取：负 frac → 按 0 处理',
    anchorToScrollTop({ page: 1, frac: -0.4, boxes: pages, viewport, scrollMax }) === 530,
    String(anchorToScrollTop({ page: 1, frac: -0.4, boxes: pages, viewport, scrollMax }))
  )
  check(
    '锚点夹取：文档末页 frac 1 → 落点夹在 scrollMax',
    anchorToScrollTop({ page: 2, frac: 1, boxes: pages, viewport, scrollMax }) === scrollMax,
    String(anchorToScrollTop({ page: 2, frac: 1, boxes: pages, viewport, scrollMax }))
  )

  // 4) 无效输入防御：空页框 / NaN viewport / NaN frac → null（调用方跳过本次锚点）
  check(
    '锚点防御：空 boxes / NaN viewport / NaN frac → null',
    anchorToScrollTop({ page: 0, frac: 0, boxes: [], viewport, scrollMax }) === null &&
      anchorToScrollTop({ page: 0, frac: 0, boxes: pages, viewport: Number.NaN, scrollMax }) === null &&
      anchorToScrollTop({ page: Number.NaN, frac: Number.NaN, boxes: pages, viewport, scrollMax }) === null,
    'invalid-input checks'
  )

  // 5) 最近块判定（pickBlockIndex）：高亮「同一段落」用
  const blocks = [
    { offsetTop: 0, offsetHeight: 100 },
    { offsetTop: 120, offsetHeight: 60 },
    { offsetTop: 200, offsetHeight: 80 }
  ]
  check(
    '最近块：中线在块 1 中心 → 命中 index 1',
    pickBlockIndex(blocks, 150) === 1,
    String(pickBlockIndex(blocks, 150))
  )
  check(
    '最近块：中线在两块之间（180）→ 距块 1 中心 150 比 30 近，仍命中 index 1',
    pickBlockIndex(blocks, 180) === 1,
    String(pickBlockIndex(blocks, 180))
  )
  check(
    '最近块：中线 240 → 块 2 中心 240 正中命中',
    pickBlockIndex(blocks, 240) === 2,
    String(pickBlockIndex(blocks, 240))
  )
  check(
    '最近块：空数组 / 无效坐标 → -1',
    pickBlockIndex([], 10) === -1 && pickBlockIndex(blocks, Number.NaN) === -1,
    'pickBlockIndex invalid'
  )
}

// PD-TEXT-REFLOW：结构化文本段落重建（物理行 → 自然段，保留行号与页内坐标）
function textReflowTests(): void {
  // 1) 行尾无标点 + 下一行小写开头 → 合并（ADAS 句子被 PDF 物理行拆开的真实形态）
  const split = reflowLines([
    { text: 'ADAS（Hu et al., 2024b）及其后续工作（Zhang', page: 1, line: 3, rect: [60, 700, 420, 712] },
    { text: 'et al., 2025）进一步扩展到城市道路场景。', page: 1, line: 4, rect: [60, 686, 400, 698] }
  ])
  check(
    '文本重建：行尾无标点+下行小写 → 合并成一段',
    split.length === 1 && split[0].merged === 2,
    JSON.stringify(split)
  )
  check(
    '文本重建：中英混排补空格、不粘词',
    split.length === 1 && split[0].text.includes('（Zhang et al., 2025）'),
    split[0]?.text ?? ''
  )
  check('文本重建：合并后保留原始行号区间', split[0]?.lineFrom === 3 && split[0]?.lineTo === 4)
  check(
    '文本重建：合并后 rect 取并集覆盖两行',
    JSON.stringify(split[0]?.rect) === '[60,686,420,712]',
    JSON.stringify(split[0]?.rect)
  )

  // 2) 行尾有句号 → 不合并
  const sentences = reflowLines([
    { text: '第一句已经说完。', page: 1, line: 1, rect: [0, 0, 0, 0] },
    { text: '第二句以小写继续 here', page: 1, line: 2, rect: [0, 0, 0, 0] }
  ])
  check('文本重建：行尾有句号 → 不合并', sentences.length === 2, JSON.stringify(sentences))

  // 3) 下一行是标题 / 列表 / 行距过大 / 换页 → 不合并
  const headBreak = reflowLines([
    { text: '这一段没有句号所以看起来还能继续', page: 1, line: 1, rect: [0, 0, 0, 0] },
    { text: '## 2 方法', page: 1, line: 2, rect: [0, 0, 0, 0] }
  ])
  check('文本重建：下一行是标题 → 不合并', headBreak.length === 2, JSON.stringify(headBreak))
  const listBreak = reflowLines([
    { text: '这一段没有句号所以看起来还能继续', page: 1, line: 1, rect: [0, 0, 0, 0] },
    { text: '- 列表项 one', page: 1, line: 2, rect: [0, 0, 0, 0] }
  ])
  check('文本重建：下一行是列表项 → 不合并', listBreak.length === 2, JSON.stringify(listBreak))
  const gapBreak = reflowLines([
    { text: '这一段没有句号所以看起来还能继续', page: 1, line: 1, rect: [60, 700, 420, 712] },
    { text: '下一行离得很远但还是小写开头', page: 1, line: 5, rect: [60, 640, 420, 652] }
  ])
  check('文本重建：行距过大 → 不合并', gapBreak.length === 2, JSON.stringify(gapBreak))
  const pageBreak = reflowLines([
    { text: '这一段没有句号所以看起来还能继续', page: 1, line: 60, rect: [0, 0, 0, 0] },
    { text: '下一页继续小写开头', page: 2, line: 1, rect: [0, 0, 0, 0] }
  ])
  check('文本重建：跨页 → 不合并', pageBreak.length === 2, JSON.stringify(pageBreak))

  // 4) 中英文混排拼接规则
  check(
    '文本重建：英文行之间补一个空格',
    joinAcrossLines('the model achieves', 'high accuracy') === 'the model achieves high accuracy',
    joinAcrossLines('the model achieves', 'high accuracy')
  )
  check(
    '文本重建：中文行之间不补空格',
    joinAcrossLines('模型的', '准确率更高') === '模型的准确率更高',
    joinAcrossLines('模型的', '准确率更高')
  )
  check('文本重建：行尾连字符断词直接接上', joinAcrossLines('multi-', 'modal') === 'multimodal')
  check(
    '文本重建：标点前不补空格',
    joinAcrossLines('accuracy', ', and robustness') === 'accuracy, and robustness',
    joinAcrossLines('accuracy', ', and robustness')
  )
  check(
    '文本重建：中文接英文补空格不粘词',
    joinAcrossLines('使用 ViT 主干', 'backbone 训练') === '使用 ViT 主干 backbone 训练',
    joinAcrossLines('使用 ViT 主干', 'backbone 训练')
  )

  // 5) 合并判据的边界
  check('文本重建：canContinueLine 合并中文续行', canContinueLine('这一段没有句号结尾的正文', '中文下一行继续') === true)
  check('文本重建：canContinueLine 句末标点断开', canContinueLine('已经说完一句。', '下一行小写') === false)
  check('文本重建：canContinueLine 标题断开', canContinueLine('没有句号的正文段落', '## 2 方法') === false)
  check('文本重建：canContinueLine 列表断开', canContinueLine('没有句号的正文段落', '- 列表项') === false)
  check('文本重建：canContinueLine 太短的行不合并', canContinueLine('标签', '下一行内容') === false)
  check('文本重建：canContinueLine 大写开头视为新句', canContinueLine('没有句号的正文段落结尾', 'A new sentence starts.') === false)

  // 6) 块级重建保留 lineFrom/lineTo/rect（双向联动定位用）
  const blocks = reflowTextBlocks([
    {
      text: 'ADAS（Hu et al., 2024b）及其后续工作（Zhang',
      page: 2,
      geometry: { page: 2, lineFrom: 11, lineTo: 11, rect: [60, 640, 420, 652] }
    },
    {
      text: 'et al., 2025）进一步扩展到城市道路场景。',
      page: 2,
      geometry: { page: 2, lineFrom: 12, lineTo: 12, rect: [60, 626, 400, 638] }
    }
  ])
  check('文本重建：块级合并成一段', blocks.length === 1 && blocks[0].merged === 2, JSON.stringify(blocks))
  check(
    '文本重建：块级合并保留行号区间与并集矩形',
    blocks[0]?.geometry?.page === 2 &&
      blocks[0]?.geometry?.lineFrom === 11 &&
      blocks[0]?.geometry?.lineTo === 12 &&
      JSON.stringify(blocks[0]?.geometry?.rect) === '[60,626,420,652]',
    JSON.stringify(blocks[0]?.geometry)
  )

  // 7) 端到端：译文 md 的位置标记 → data-pd-* 属性 + 段间合并
  const reflowMd = [
    '<!-- 第 2 页 -->',
    'ADAS（Hu et al., 2024b）及其后续工作（Zhang <!--pd p=2 l=11-11 r=60.0,640.0,420.0,652.0-->',
    '',
    'et al., 2025）进一步扩展到城市道路场景。 <!--pd p=2 l=12-12 r=60.0,626.0,400.0,638.0-->',
    '',
    '下一段已经有句号。 <!--pd p=2 l=14-14 r=60.0,600.0,420.0,612.0-->'
  ].join('\n')
  const reflowHtml = translationMarkdownToHtml(reflowMd)
  check('文本重建：译文 md 段间合并成完整段落', reflowHtml.includes('（Zhang et al., 2025）'), reflowHtml)
  check(
    '文本重建：合并段落带 data-pd 行号区间与坐标',
    reflowHtml.includes('data-pd-lines="11-12"') &&
      reflowHtml.includes('data-pd-rect="60.0,626.0,420.0,652.0"') &&
      reflowHtml.includes('data-pd-merged="2"'),
    reflowHtml
  )
  check(
    '文本重建：句号结尾的下一段不与上段合并',
    (reflowHtml.match(/data-pd-lines=/g) || []).length === 2,
    reflowHtml
  )
  check('文本重建：位置标记不出现在正文里', !reflowHtml.includes('<!--pd'), reflowHtml)

  // 8) 标记解析 / 生成往返
  const parsedMark = parsePdGeom('正文一句话 <!--pd p=3 l=7-8 r=10.0,20.0,300.5,40.0-->')
  check(
    '文本重建：解析 pd 标记得到行号与坐标',
    parsedMark.text === '正文一句话' &&
      parsedMark.geometry?.page === 3 &&
      parsedMark.geometry?.lineFrom === 7 &&
      parsedMark.geometry?.lineTo === 8 &&
      JSON.stringify(parsedMark.geometry?.rect) === '[10,20,300.5,40]',
    JSON.stringify(parsedMark)
  )
  check(
    '文本重建：pd 标记生成与解析往返一致',
    formatPdGeom({ page: 3, lineFrom: 7, lineTo: 8, rect: [10, 20, 300.5, 40] }) ===
      '<!--pd p=3 l=7-8 r=10.0,20.0,300.5,40.0-->',
    formatPdGeom({ page: 3, lineFrom: 7, lineTo: 8, rect: [10, 20, 300.5, 40] })
  )
  check('文本重建：无标记的文本原样返回', parsePdGeom('普通一行').geometry === null)
}

// PD64：划词文本清理（数学符号被文本层重复绘制）
function pd64SelectionTextTests(): void {
  check('PD64：𝒯𝒯 去重为 𝒯', dedupeMathGlyphs('𝒯𝒯') === '𝒯', dedupeMathGlyphs('𝒯𝒯'))
  check('PD64：𝒪𝒪𝒪 收敛为 𝒪', dedupeMathGlyphs('𝒪𝒪𝒪') === '𝒪', dedupeMathGlyphs('𝒪𝒪𝒪'))
  check('PD64：普通数字 11 不受影响', dedupeMathGlyphs('11') === '11')
  check('PD64：英文单词 coo 不受影响', dedupeMathGlyphs('coo') === 'coo')
  check(
    'PD64：混合串只去重数学符号',
    dedupeMathGlyphs('𝒯𝒯 x = 𝒫𝒫, 𝒪𝒪𝒪(TT)') === '𝒯 x = 𝒫, 𝒪(TT)',
    dedupeMathGlyphs('𝒯𝒯 x = 𝒫𝒫, 𝒪𝒪𝒪(TT)')
  )
  check('PD64：normalizeSelectionText 去尾随空白', normalizeSelectionText('𝒯𝒯  ') === '𝒯', JSON.stringify(normalizeSelectionText('𝒯𝒯  ')))
  check('PD64：normalizeSelectionText 保留换行', normalizeSelectionText('a\n𝒫𝒫') === 'a\n𝒫')
  check('PD64：空串安全', normalizeSelectionText('') === '' && dedupeMathGlyphs('') === '')
}

/* ============================ 阶段一：AI 意图 / 阶段二：分组区 / 阶段四：论文详情 ============================ */

/* ==================== 本轮：高亮配色 / 译文公式与字号 / 删除页 ==================== */

function p5PdfPageTests(): void {
  console.log('\n== 高亮配色 / 译文行内公式与字号 / 删除页 ==')
  const rel = (p: string): string => fileURLToPath(new URL('../' + p, import.meta.url))
  const srcText = (p: string): string => readFileSync(rel(p), 'utf8').replace(/\r\n/g, '\n')

  // 1) 高亮：逐色透明度 / 旧色兼容 / 状态区分
  const palette = HIGHLIGHT_PALETTE
  check(
    '高亮：四种颜色齐全（黄/绿/蓝/粉）',
    palette.length === 4 && palette.map((p) => p.id).join(',') === 'yellow,green,blue,pink'
  )
  check(
    '高亮：每色透明度在 0.42–0.62（白底明显且不遮字）',
    palette.every((p) => p.alpha >= 0.42 && p.alpha <= 0.62 && p.darkAlpha >= 0.36 && p.darkAlpha <= 0.6)
  )
  check('高亮：四色互不相同（不是统一透明度）', new Set(palette.map((p) => p.hex + p.alpha)).size === 4)
  check(
    '高亮：旧批注颜色映射到同色系（保留颜色语义）',
    resolveHighlight('#a8e05f').id === 'green' &&
      resolveHighlight('#7cc4ff').id === 'blue' &&
      resolveHighlight('#ff9bd2').id === 'pink'
  )
  check(
    '高亮：当前色板色值拿到自己的透明度（蓝 0.46 / 绿 0.52 / 粉 0.46），不落未知色分支',
    resolveHighlight('#2f8cff').alpha === 0.52 &&
      resolveHighlight('#2f8cff').id === 'blue' &&
      resolveHighlight('#7ac93c').alpha === 0.55 &&
      resolveHighlight('#ff5fb0').alpha === 0.5
  )
  const unknown = resolveHighlight('#123456')
  check(
    '高亮：未知颜色保留原色相并给可用透明度',
    unknown.hex.toLowerCase() === '#123456' && unknown.alpha > 0.3
  )
  check('高亮：选中比悬停更强', HIGHLIGHT_STATES.activeDelta > HIGHLIGHT_STATES.hoverDelta)

  const cssText = srcText('src/renderer/src/styles.css')
  check(
    '高亮：CSS 按色变量着色，不是写死单一 opacity',
    cssText.includes('var(--ann-alpha') && cssText.includes('var(--ann-color') && /mix-blend-mode:\s*multiply/.test(cssText)
  )
  check(
    '高亮：悬停与选中是分开的规则（状态不混淆）',
    /\.ann--highlight:hover/.test(cssText) && /\.ann--highlight\.is-active/.test(cssText)
  )
  const pdfViewer = srcText('src/renderer/src/features/reader/PdfViewer.tsx')
  check(
    '高亮：批注层按色写入 CSS 变量',
    pdfViewer.includes("setProperty('--ann-color'") && pdfViewer.includes('highlightColorValues()')
  )

  // 2) 译文：行内公式走 htmlbox，字号增量来自唯一设置
  const py = srcText('python/app/translate.py')
  check('译文：行内公式单独走 _draw_inline_math_box', py.includes('_draw_inline_math_box(') && py.includes('inline_math_html('))
  check('译文：宁可溢出也不缩字（scale_low 下限）', /scale_low\s*=\s*float\(\s*min_scale\s*\)/.test(py))
  check(
    '译文：字号增量参与落版，且默认 +1.5pt',
    /size_delta=float\(\s*font_delta/.test(py) && py.includes('DEFAULT_FONT_DELTA = 1.5')
  )
  check('译文：不可还原的公式命令会写进 warning', py.includes('未能可靠还原'))
  const inlineMath = srcText('python/app/inline_math.py')
  check('译文：上下标生成 sup/sub，不是普通文字', inlineMath.includes('<sup>') && inlineMath.includes('<sub>'))
  const translateSvc = srcText('src/main/services/translate.ts')
  check('译文：字号进入复用签名（改字号必须重译）', translateSvc.includes(':f' + '${effFontDelta}'))
  check('译文：整篇与单页都透传 fontDelta', (translateSvc.match(/fontDelta/g) ?? []).length >= 3)
  const panel = srcText('src/renderer/src/features/translate/TranslationPanel.tsx')
  check('译文：面板有字号选择', panel.includes('data-testid="translate-font-delta"'))
  check('译文：旧译文提示需要重新生成', panel.includes('data-testid="translate-stale-hint"'))
  const settingsSrc = srcText('src/main/services/settings.ts')
  check('译文：设置里 clamp 到 0–4pt', /Math\.max\(0, Math\.min\(4, n\)\)/.test(settingsSrc))

  // 3) 详情页：去掉冗余「打开论文」，保留附件信息
  const detail = srcText('src/renderer/src/features/library/ItemDetailPanel.tsx')
  check('详情：不再有常驻「打开论文」按钮', !detail.includes('打开论文'))
  check(
    '详情：附件保留文件名/页数/大小',
    detail.includes('detail-files') && detail.includes('page_count') && detail.includes('formatSize')
  )

  // 4) 删除页：备份 → 原子替换 → 页映射 → 可撤销
  const edit = srcText('src/main/services/pdf-edit.ts')
  check('删页：先备份当前文件再改', edit.indexOf('backupCurrent') < edit.indexOf('renameSync(tmp, abs)'))
  check('删页：写临时文件后原子替换', edit.includes('renameSync(tmp, abs)'))
  check('删页：不能删光所有页', edit.includes('不能删除全部页面'))
  check('删页：被删页的批注置 -1，不挂到其他页', /mapped\s*===?\s*undefined\s*\|\|\s*mapped\s*<\s*0\s*\?\s*-1\s*:\s*mapped/.test(edit))
  check('删页：删后移除旧译文，避免页码错配', edit.includes('DELETE FROM translations WHERE attachment_id = ?'))
  check('删页：版本里保存批注与块的页号快照', edit.includes('chunks_json') && edit.includes('annotations_json'))
  check('删页：撤销按快照恢复，不按比例猜', edit.includes('chunks_json'))
  check('删页：有任务在跑时拒绝编辑', edit.includes('activeTaskOf') && edit.includes('请等任务结束'))
  check('删页：失败时保留原文件（临时文件改名 .failed）', edit.includes('.failed'))
  const sidecar = srcText('python/app/main.py')
  check('删页：侧车提供缩略图与删页接口', sidecar.includes('/pdf/thumbs') && sidecar.includes('/pdf/delete-pages'))
  check('删页：侧车校验不能删光', sidecar.includes('至少保留 1 页'))
  const app = srcText('src/renderer/src/App.tsx')
  check('删页：阅读工具栏有入口', app.includes('data-testid="toolbar-page-edit"'))
  check('删页：删除后清译文并强制重载 PDF', app.includes('setTranslationEpoch((n) => n + 1)'))
  const dialog = srcText('src/renderer/src/features/reader/PageEditDialog.tsx')
  check('删页：弹窗有缩略图选择与版本恢复', dialog.includes('page-edit-grid') && dialog.includes('page-edit-versions'))
  check('删页：选中全部页面时禁用删除', /allSelected/.test(dialog) && dialog.includes('disabled'))
}

function p1AskIntentTests(): void {
  console.log('\n== 阶段一：AI 问答 / 翻译意图 ==')
  check('意图：讨论「机器翻译」不是翻译任务', (() => {
    const q = '什么是机器翻译？'
    return detectTranslateIntent(q) === false && detectExplainIntent(q) === true
  })())
  check('意图：解释翻译模型原理不是翻译任务', detectTranslateIntent('解释一下翻译模型的原理') === false)
  check('意图：翻译质量这类名词不是翻译指令', detectTranslateIntent('请比较两篇论文的翻译质量差异') === false)
  check('意图：解释器不是术语解释指令', detectExplainIntent('解释器是什么') === false)
  check('意图：真正的翻译指令仍被识别', (() =>
    detectTranslateIntent('翻译上面这段') &&
    detectTranslateIntent('Translate this paragraph into Chinese') &&
    detectTranslateIntent('把这段英文翻译一下')))
  check('语种：用户显式指定优先于文字比例', (() =>
    detectRequestedLang('请翻译成中文：Hello world') === 'zh' &&
    detectRequestedLang('把 Hello 世界翻译成英文') === 'en' &&
    detectRequestedLang('翻译这段') === null))
  const planZh = planAsk('请翻译成中文：Hello world', [], 'qa', null, 'auto')
  check('计划：显式中文不被字符比翻转成英文', (() =>
    planZh.task === 'translate' && planZh.targetLang === 'zh' &&
    planZh.inlineText === 'Hello world'))
  const planMixed = planAsk('把这段翻译成英文：机器学习模型可以过拟合。', [], 'qa', null, 'auto')
  check('计划：中英混合文本也遵守指定语言', planMixed.targetLang === 'en')
  const planPref = planAsk('翻译：Hello world', [], 'qa', null, 'en')
  check('计划：界面选择优先于自动推断', planPref.targetLang === 'en')
  const planAuto = planAsk('翻译：Hello world', [], 'qa', null, 'auto')
  check('计划：自动模式仍按原文字符比推断', planAuto.targetLang === 'zh')
  check('联网意图：最新进展/联网查询需要搜索', (() =>
    wantsWebSearch('帮我联网查询最新的 SOTA 结果') &&
    wantsWebSearch('最近的研究有什么进展') &&
    !wantsWebSearch('这篇论文的方法是什么')))
  check('联网模式：三态解析与开关', (() =>
    parseWebMode('auto') === 'auto' && parseWebMode('always') === 'always' &&
    parseWebMode(undefined) === 'off' && webModeAllowsRequest('auto') && !webModeAllowsRequest('off')))
  check('证据分层：论文/知识库/网页/模型知识各有标签', (() =>
    evidenceLabel('paper') === '论文原文' && evidenceLabel('knowledge') === '知识库' &&
    evidenceLabel('web') === '网页来源' && evidenceLabel('model') === '模型知识'))
  check('分段：超长原文按句切开且不丢内容', (() => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about heuristic optimization.`).join(' ')
    const chunks = splitForTranslation(long, 300)
    return chunks.length > 1 && chunks.every((c) => c.length <= 300) &&
      chunks.join(' ').replace(/\s+/g, ' ').includes('Sentence number 39')
  })())
  check('选区：历史里「翻译：X」取 X 而不是整句', (() => {
    const picked = pickSourceSelection([
      { role: 'user', content: '翻译：Machine learning models can overfit the training data.' }
    ])
    return !!picked && picked.text.startsWith('Machine learning') && !picked.text.startsWith('翻译')
  })())

  const ai = readFileSync(fileURLToPath(new URL('../src/main/services/ai.ts', import.meta.url)), 'utf8')
  check('主进程：检索为空不再直接早退阻断模型回答', !/citations\.length === 0 && web\.status !== 'on'\)\s*\{\s*return/.test(ai))
  check('主进程：兜底片段不算真实命中（primary 判据）', ai.includes('primary === 0 && kb.hits.length === 0'))
  check('主进程：术语分支也接联网', ai.includes('wantWeb'))
  check('主进程：知识库检索接入问答', ai.includes('searchKnowledge(getDb()'))
  check('主进程：翻译逐段推送并透传取消信号', (() =>
    ai.includes('translateTexts([chunks[i]], targetLang, { signal })') &&
    ai.includes('已取消：完成')))
  check('主进程：取消登记表存在', ai.includes('askControllers.set(requestId, controller)'))
}

function p2GroupPaneTests(): void {
  console.log('\n== 阶段二：分组区高度 ==')
  check('分组区：少量分组按内容高度（行高合计 + 间距）', groupTreeContentHeight([22, 22, 22]) === 68)
  check('分组区：单行与空列表', groupTreeContentHeight([22]) === 22 && groupTreeContentHeight([]) === 0)
  check('分组区：忽略隐藏/异常行高', groupTreeContentHeight([22, 0, NaN, 22]) === 45)
  check('分组区：多行累加而不是读容器高度', (() =>
    groupTreeContentHeight([22, 22, 22, 22, 22]) === 114 && groupTreeContentHeight([22, 22]) === 45))
  check('分组区：内容高度换算面板高度时留出 chrome', (() =>
    groupPaneHeightFromContent(200, 800) === 244 &&
    groupPaneHeightFromContent(4000, 800) === 800 - GROUP_PANE_LIST_MIN_HEIGHT))
  check('分组区：高度记忆只接受正数', (() =>
    readStoredGroupPaneHeight('312') === 312 &&
    readStoredGroupPaneHeight(null) === null &&
    readStoredGroupPaneHeight('abc') === null &&
    readStoredGroupPaneHeight('-5') === null))
}

function p4PublicationTests(): void {
  console.log('\n== 阶段四：发表信息 / 被引记录 ==')
  check('发表类型：Crossref 类型归一', (() =>
    normalizePublicationType('journal-article') === 'journal' &&
    normalizePublicationType('proceedings-article') === 'conference' &&
    normalizePublicationType('posted-content') === 'preprint' &&
    normalizePublicationType('book-chapter') === 'unknown' &&
    normalizePublicationType('') === 'unknown'))
  const journal = publicationFromCrossref({
    type: 'journal-article',
    'container-title': ['Nature Machine Intelligence'],
    volume: '6',
    issue: '3',
    page: '45-67',
    issued: { 'date-parts': [[2024]] },
    DOI: '10.1038/XYZ'
  })
  check('Crossref 期刊：刊名/年/卷期页/DOI', (() =>
    journal.type === 'journal' && journal.venue === 'Nature Machine Intelligence' &&
    journal.year === 2024 && journal.volume === '6' && journal.issue === '3' &&
    journal.pages === '45-67' && journal.formalDoi === '10.1038/xyz'))
  const conf = publicationFromCrossref({
    type: 'proceedings-article',
    'container-title': ['Advances in Neural Information Processing Systems 37'],
    event: { name: 'Conference on Neural Information Processing Systems', acronym: 'NeurIPS' },
    issued: { 'date-parts': [[2024]] }
  })
  check('Crossref 会议：会议名/简称/论文集', (() =>
    conf.type === 'conference' && conf.event?.includes('Neural Information') &&
    conf.venueShort === 'NeurIPS' && !!conf.proceedings))
  const pre = publicationFromCrossref({
    type: 'posted-content',
    group: { title: 'arXiv' },
    issued: { 'date-parts': [[2025]] }
  })
  check('Crossref 预印本：平台识别为 arXiv 而不是会议', (() =>
    pre.type === 'preprint' && pre.preprintPlatform === 'arXiv' && !pre.event))
  const oa = publicationFromOpenAlex({
    primary_location: {
      source: { type: 'repository', display_name: 'arXiv (Cornell University)' }
    },
    locations: [{ landing_page_url: 'https://arxiv.org/abs/2505.20881v2' }],
    biblio: { volume: '1', issue: '2', first_page: '3', last_page: '9' }
  })
  check('OpenAlex 预印本：arXiv 号去掉版本号', (() =>
    oa.type === 'preprint' && oa.preprintId === '2505.20881'))
  const fromPdf = publicationFromPdfText('arXiv:2402.01145\nPublished as a conference paper at ICLR 2026')
  check('PDF 正文：论文自报会议 + 保留 arXiv 号', (() =>
    fromPdf.type === 'conference' && fromPdf.year === 2026 &&
    fromPdf.preprintId === '2402.01145'))
  check('合并：只补空，不覆盖已确认字段', (() => {
    const merged = mergePublicationInfo(journal, { ...journal, venue: 'Other Venue', year: 1999 })
    return merged.venue === 'Nature Machine Intelligence' && merged.year === 2024
  })())
  check('手动修正：标记 userFixed 且来源为手动', (() => {
    const fixed = applyManualPublication(journal, { type: 'conference', venue: 'NeurIPS 2024' })
    return fixed.type === 'conference' && fixed.source === 'user' &&
      fixed.userFixed.includes('type') && fixed.userFixed.includes('venue')
  })())
  check('合并：用户修正过的字段不被自动补全覆盖', (() => {
    const fixed = applyManualPublication(journal, { venue: 'NeurIPS 2024' })
    const merged = mergePublicationInfo(fixed, { ...journal, venue: 'Nature Machine Intelligence' })
    return merged.venue === 'NeurIPS 2024'
  })())
  check('升级：预印本有正式版时补正式会议并保留 arXiv 线索', (() => {
    const upgraded = upgradePreprintToFormal(pre, conf)
    return upgraded.type === 'conference' && upgraded.preprintPlatform === 'arXiv' &&
      upgraded.venue?.includes('Neural Information')
  })())
  check('展示：期刊/会议/预印本/未知各有文案', (() => {
    const j = formatPublicationLine(journal)
    const c = formatPublicationLine(conf)
    const p = formatPublicationLine(pre)
    const u = formatPublicationLine(emptyPublicationInfo())
    return j.startsWith('期刊：') && c.startsWith('会议：') && p.startsWith('预印本：') &&
      (u.includes('暂无发表信息') || u.includes('待确认'))
  })())
  check('目录：没有内部目录时显示「暂无目录匹配」而不是未收录', (() =>
    catalogLabel(false) === '暂无目录匹配'))
  const neverRec = emptyCitationRecord(1)
  check('被引：没有记录时是「尚未查询」', (() =>
    neverRec.status === 'never' && describeCitation(neverRec).includes('尚未查询')))
  check('被引：0 次与接口未提供、未匹配、失败区分开', (() => {
    const base = { ...neverRec, queriedAt: '2026-11-13T00:00:00.000Z' }
    const zero = describeCitation({ ...base, status: 'ok', count: 0 })
    const none = describeCitation({ ...base, status: 'no_count', count: null })
    const nf = describeCitation({ ...base, status: 'not_found' })
    const fail = describeCitation({ ...base, status: 'failed', lastError: 'HTTP 401' })
    return zero.includes('0') && !zero.includes('未提供') &&
      none.includes('未提供') && nf.includes('未找到') && fail.includes('失败')
  })())
  check('被引：未配置 Key 时提示去设置', (() =>
    describeCitation({ ...neverRec, status: 'unconfigured' }).includes('SerpAPI')))
  const hit = (over: Record<string, unknown>) => ({
    id: 'x',
    doi: null,
    title: null,
    year: null,
    venue: null,
    citedBy: 0,
    authors: [],
    oaUrl: null,
    isOa: false,
    ...over
  })
  check('被引匹配：DOI 精确命中优先', (() => {
    const res = resolveCitationMatch(
      [
        hit({ title: 'ReEvo: Large Language Models as Hyper-Heuristics', doi: '10.52202/079017-1381', citedBy: 128 }),
        hit({ title: 'Some other paper', citedBy: 4 })
      ],
      { title: 'ReEvo', doi: '10.52202/079017-1381', year: 2024, authors: [] }
    )
    return res.kind === 'matched' && res.best?.citedBy === 128
  })())
  check('被引匹配：两个近分候选不擅自挑一个', (() => {
    const res = resolveCitationMatch(
      [
        hit({ title: 'Heuristic Generation with LLMs', citedBy: 10 }),
        hit({ title: 'Heuristic Generation with LLMs', citedBy: 99 })
      ],
      { title: 'Heuristic Generation with LLMs', doi: null, year: 2024, authors: [] }
    )
    return res.kind === 'ambiguous' && (res.candidates?.length ?? 0) >= 2
  })())
  check('被引候选：无关结果不算匹配', (() =>
    resolveCitationMatch(
      [hit({ title: 'Quantum chromodynamics', citedBy: 3 })],
      { title: 'ReEvo heuristic', doi: null, year: 2024, authors: [] }
    ).kind === 'none'))

  const worksSrc = readFileSync(fileURLToPath(new URL('../src/main/services/works.ts', import.meta.url)), 'utf8')
  check('被引：读记录不发网络请求', /export function getCitationRecord\([^)]*\)[^{]*\{[^}]*SELECT/.test(worksSrc) &&
    !/getCitationRecord[\s\S]{0,400}fetch\(/.test(worksSrc))
  check('被引：只走 SerpAPI Google Scholar，不抓网页', (() =>
    worksSrc.includes('google_scholar') && !worksSrc.includes('semantic')))
  check('被引：并发点击复用同一请求', worksSrc.includes('citationPending.get(itemId)'))
  check('被引：失败保留上次成功次数', worksSrc.includes("status: 'failed'") && worksSrc.includes('count: prev.count'))
  check('被引：未配置 Key 不发请求', worksSrc.includes('unconfigured'))
  const detail = readFileSync(
    fileURLToPath(new URL('../src/renderer/src/features/library/ItemDetailPanel.tsx', import.meta.url)),
    'utf8'
  )
  check('详情页：打开只读本地记录，查询只在点击后', (() =>
    detail.includes('.citation(itemId)') && detail.includes('citationQuery') &&
    !detail.includes('.citations(itemId')))
  check('详情页：主操作是查询/刷新', detail.includes('detail-cite-query'))
  check('详情页：Scholar 外链收进次级菜单', detail.includes('detail__more'))
  const schemaSql = readFileSync(fileURLToPath(new URL('../src/main/db/schema.sql', import.meta.url)), 'utf8')
  check('数据库：item_citations 与 publication_json 并存，保留既有 venue', (() =>
    schemaSql.includes('item_citations') && schemaSql.includes('publication_json') &&
    schemaSql.includes('venue')))
}

/* ============================ 阶段三：智能整理 ============================ */

function p6OrganizeTests(): void {
  console.log('\n== 阶段三：批处理后智能整理 ==')
  const rel = (p: string): string => fileURLToPath(new URL('../' + p, import.meta.url))
  const srcText = (p: string): string => readFileSync(rel(p), 'utf8').replace(/\r\n/g, '\n')

  check('整理标签：目标/目的/节点/条目', (() =>
    organizeTargetLabel('mindmap') === '思维地图' &&
    organizeTargetLabel('knowledge') === '知识库' &&
    organizePurposeLabel('theme').includes('主题') &&
    organizeNodeKindLabel('gap').includes('空白') &&
    organizeEntryKindLabel('result').includes('结论')))

  const baseEntry = { key: 'k', title: 't', body: 'b', itemId: 1, evidence: [], inferred: false } as const
  check('知识条目类型映射：方法/结论/主张/问题/概念', (() =>
    knowledgeKindOf({ ...baseEntry, kind: 'method' }) === 'method' &&
    knowledgeKindOf({ ...baseEntry, kind: 'result' }) === 'result' &&
    knowledgeKindOf({ ...baseEntry, kind: 'claim' }) === 'claim' &&
    knowledgeKindOf({ ...baseEntry, kind: 'question' }) === 'question' &&
    knowledgeKindOf({ ...baseEntry, kind: 'concept' }) === 'concept'))

  const prompt = buildOrganizePrompt(
    { target: 'mindmap', purpose: 'theme', title: '跨论文整理' },
    [
      { itemId: 7, title: 'Paper A', markdown: 'A 的内容：方法 M1。' },
      { itemId: 8, title: 'Paper B', markdown: 'B 的内容：结论 R1。' }
    ]
  )
  check('整理提示词：层次/来源/推断三条硬规则写在 system 里', (() =>
    prompt.system.includes('1 个根节点') &&
    prompt.system.includes('绝不编造页码或原文') &&
    prompt.system.includes('inferred') &&
    prompt.system.includes('共同方法') && prompt.system.includes('研究空白')))
  check('整理提示词：两篇论文都进入 user（带 itemId 与标题）', (() =>
    prompt.user.includes('Paper A') && prompt.user.includes('Paper B') &&
    prompt.user.includes('7') && prompt.user.includes('8')))

  check('JSON 提取：容忍 ```json 包裹与前后说明', (() => {
    const a = extractJsonObject('```json\n{"summary":"x","nodes":[]}\n```') as { summary?: string }
    const b = extractJsonObject('说明文字\n{"summary":"y"}\n结束') as { summary?: string }
    return a?.summary === 'x' && b?.summary === 'y'
  })())

  check('引文核对：空白与标点差异仍算命中，改写则不算', (() => {
    const source = 'We propose a new heuristic optimizer, ReEvo, trained with reinforcement learning.'
    return (
      quoteMatchesSource('new heuristic optimizer ReEvo', source) &&
      !quoteMatchesSource('a completely different sentence about cats', source) &&
      !quoteMatchesSource('short', source)
    )
  })())

  const ctx = {
    papers: [{ itemId: 7, title: 'Paper A', markdown: 'Paper A 正文：我们提出 ReEvo，一种新的启发式优化器。' }],
    pageCounts: { 7: 3 },
    textByItem: { 7: 'Paper A 正文：我们提出 ReEvo，一种新的启发式优化器。' }
  }
  const draft = normalizeOrganizeDraft(
    {
      summary: '一篇论文的结构',
      nodes: [
        { id: 'r', parentId: null, text: 'ReEvo', kind: 'root' },
        { id: 't1', parentId: 'r', text: '方法', kind: 'method', itemId: 7, page: 2, quote: '我们提出 ReEvo' },
        { id: 't2', parentId: 'r', text: '编造的结论', kind: 'conclusion', itemId: 99, page: 1 },
        { id: 't3', parentId: 'r', text: '页码越界', kind: 'conclusion', itemId: 7, page: 99 },
        { id: 't4', parentId: 'r', text: '引文对不上', kind: 'conclusion', itemId: 7, page: 1, quote: '原文里没有这句话' }
      ],
      entries: [
        { key: 'e1', kind: 'method', title: 'ReEvo', body: '用强化学习训练启发式优化器', itemId: 7, page: 2, quote: '我们提出 ReEvo' }
      ]
    },
    ctx,
    { target: 'mindmap', purpose: 'structure', title: 'Paper A' }
  )
  check('校验：不属于纳入论文的来源节点被丢弃', !draft.nodes.some((n) => n.itemId === 99))
  check('校验：页码超出页数 → 清空页码并标为推断', (() => {
    const n = draft.nodes.find((x) => x.text === '页码越界')
    return !!n && n.page === null && n.inferred
  })())
  check('校验：引文在原文里找不到 → 清空引文并标为推断', (() => {
    const n = draft.nodes.find((x) => x.text === '引文对不上')
    return !!n && !n.quote && n.inferred
  })())
  check('校验：保留核对通过的页码与引文', (() => {
    const n = draft.nodes.find((x) => x.text === '方法')
    return !!n && n.page === 2 && !!n.quote && !n.inferred
  })())
  check('校验：根唯一且形成两层结构', (() =>
    draft.nodes.filter((n) => n.parentId == null).length === 1 &&
    draft.nodes.filter((n) => n.parentId === draft.nodes[0].id).length >= 2))
  check('校验：条目 evidence 只保留核对通过的来源', (() => {
    const e = draft.entries[0]
    return !!e && e.evidence.length === 1 && e.evidence[0].itemId === 7
  })())
  check('校验：草稿记录纳入论文与引擎', (() =>
    draft.included.length === 1 && draft.included[0].itemId === 7 &&
    draft.engine === 'model' && draft.title === 'Paper A'))

  const flat = normalizeOrganizeDraft(
    {
      nodes: [
        { id: 'r', parentId: null, text: '根', kind: 'root' },
        { id: 'a', parentId: 'r', text: '要点一', kind: 'topic' },
        { id: 'b', parentId: 'r', text: '要点二', kind: 'topic' },
        { id: 'c', parentId: 'r', text: '要点三', kind: 'method' },
        { id: 'd', parentId: 'r', text: '要点四', kind: 'conclusion' }
      ]
    },
    ctx,
    { target: 'mindmap', purpose: 'structure', title: 'flatten' }
  )
  check('校验：要点全平铺在根下 → 给出层级警告', flat.warnings.some((w) => w.includes('层级')))

  const orphan = normalizeOrganizeDraft(
    { nodes: [{ id: 'x', parentId: 'missing', text: '孤儿', kind: 'topic' }] },
    ctx,
    { target: 'mindmap', purpose: 'structure', title: 'orphan' }
  )
  check('校验：孤儿节点挂到根上，不丢内容', orphan.nodes.some((n) => n.text === '孤儿' && n.parentId != null))

  check('相似度：同义标题高、无关标题低', (() => {
    const same = organizeTitleSimilarity('强化学习训练启发式优化器', '强化学习训练启发式优化器（ReEvo）')
    const diff = organizeTitleSimilarity('强化学习训练启发式优化器', '量子色动力学的渐近自由')
    return same >= 0.62 && diff < 0.62
  })())
  const merges = suggestMerges([
    { key: 'a', kind: 'method', title: '强化学习训练启发式优化器', body: 'x', itemId: 7, evidence: [], inferred: false },
    { key: 'b', kind: 'method', title: '强化学习训练启发式优化器 ReEvo', body: 'y', itemId: 8, evidence: [], inferred: false },
    { key: 'c', kind: 'result', title: '强化学习训练启发式优化器', body: 'z', itemId: 8, evidence: [], inferred: false }
  ])
  check('合并建议：只对同类相似条目提建议，不自动合并', (() =>
    merges.length === 1 && merges[0].key === 'b' && merges[0].mergeInto === 'a' && !!merges[0].reason))

  const mkNode = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
    id, parentId: null, text, kind: 'topic' as const, itemId: null, page: null,
    quote: null, inferred: false, userEdited: false, ...extra
  })
  const diff = diffDraftNodes(
    [mkNode('n1', '旧节点'), mkNode('n2', '手改节点', { userEdited: true })],
    [mkNode('n1', '新节点'), mkNode('n2', '手改节点', { userEdited: true }), mkNode('n3', '新增节点')]
  )
  check('差异预览：新增/更新/未变/手改分别统计', (() =>
    diff.added.length === 1 && diff.changed.length === 1 &&
    diff.unchanged.length === 1 && diff.protectedNodes.length === 1))
  const summary = summarizeDraft(draft)
  check('草稿摘要：节点/条目/来源论文都给出', (() =>
    summary.nodes >= 2 && summary.entries === 1 && summary.papers === 1))

  const organizeService = srcText('src/main/services/organize.ts')
  check('主进程：版本快照表支撑撤销与恢复', (() =>
    organizeService.includes('organize_versions') &&
    organizeService.includes('restoreOrganizeVersion') &&
    organizeService.includes('listOrganizeVersions')))
  check('主进程：撤销只撤回本批次待审提案', organizeService.includes('pending_review'))
  check('主进程：恢复版本能读到保存在快照顶层的批次号（阶段三修正）', (() =>
    organizeService.includes('payload.batchId ?? before.batchId') &&
    organizeService.includes('DELETE FROM proposal_batches')))
  check('主进程：用户手改节点不被覆盖', (() =>
    organizeService.includes('userEdited') && organizeService.includes('protectedNodes')))
  check('主进程：模型失败退回规则整理并说明', (() =>
    organizeService.includes('已退回规则整理') && organizeService.includes("engine: 'rules'")))
  check('主进程：知识库只生成待审提案，不直接发布', (() =>
    organizeService.includes('createProposal') && !organizeService.includes('publishBatch')))
  check('主进程：跨论文整理记录未纳入论文', organizeService.includes('skipped'))

  const panelSrc = srcText('src/renderer/src/features/batch/BatchPanel.tsx')
  check('入口：批处理面板有「智能整理」按钮并挂载面板', (() =>
    panelSrc.includes('batch-organize') && panelSrc.includes('OrganizePanel') && panelSrc.includes('organizeRun')))
  const ui = srcText('src/renderer/src/features/batch/OrganizePanel.tsx')
  check('界面：预览含来源/推断/差异/保存/撤销/版本恢复', (() =>
    ui.includes('organize-generate') && ui.includes('organize-apply') &&
    ui.includes('organize-undo') && ui.includes('organize-versions') &&
    ui.includes('organize-diff') && ui.includes('organize-skipped') && ui.includes('organize-tree')))
  check('界面：打开面板即列出本批次历史版本（阶段三修正）', (() =>
    ui.includes('`run:${runId}`') && ui.includes('window.api.organize.versions(')))
  const channelsSrc = srcText('src/shared/channels.ts')
  check('通道：整理预览/保存/版本/恢复/候选都注册', (() =>
    channelsSrc.includes("preview: 'organize:preview'") &&
    channelsSrc.includes('organize:apply') && channelsSrc.includes('organize:versions') &&
    channelsSrc.includes('organize:restore') && channelsSrc.includes('organize:candidates')))
  const ipcSrc = srcText('src/main/ipc/organize.ts')
  check('IPC：五个整理通道都绑到服务函数', (() =>
    ipcSrc.includes('CH.organize.preview') && ipcSrc.includes('CH.organize.apply') &&
    ipcSrc.includes('CH.organize.versions') && ipcSrc.includes('CH.organize.restore') &&
    ipcSrc.includes('CH.organize.candidates')))
  const schemaSrc = srcText('src/main/db/schema.sql')
  check('数据库：organize_versions 建表进 schema（带索引）', (() =>
    schemaSrc.includes('organize_versions') && schemaSrc.includes('idx_organize_versions_scope')))
}

/* ============================ PD01：恢复安全 ============================ */

type Pd01Backend = BackupBackend & {
  calls: { snapshot: number; init: number; close: number }
  failSnapshot: Error | null
  failInitOnce: boolean
  failCloseOnce: boolean
}

/**
 * PD01：数据库恢复失败时保留现有库。
 *
 * 用 node:sqlite 搭一个与真实后端同 shape 的 BackupBackend（VACUUM INTO 做安全备份、
 * 只读探针做校验），覆盖：损坏/非 SQLite 输入、缺表缺列、安全备份失败、
 * 安装前后失败回滚、以及正常恢复 + 退出重开一致。
 */
function pd01RestoreSafetyTests(): void {
  const schemaSql = readFileSync(
    fileURLToPath(new URL('../src/main/db/schema.sql', import.meta.url)),
    'utf8'
  )
  const stamp = '2026-11-08T00:00:00.000Z'
  const root = mkdtempSync(join(tmpdir(), 'pd01-'))

  const readRows = (file: string): { titles: string[]; notes: string[]; annotations: number } => {
    const db = new DatabaseSync(file)
    try {
      const titles = (db.prepare('SELECT title FROM items ORDER BY id').all() as Array<
        Record<string, unknown>
      >).map((row) => String(row.title))
      const notes = (db.prepare('SELECT title FROM notes ORDER BY id').all() as Array<
        Record<string, unknown>
      >).map((row) => String(row.title))
      const count = db.prepare('SELECT COUNT(*) AS n FROM annotations').get() as
        | Record<string, unknown>
        | undefined
      return { titles, notes, annotations: Number(count?.n ?? 0) }
    } finally {
      db.close()
    }
  }

  const createLibrary = (
    file: string,
    title: string,
    noteTitle: string,
    annotationText: string
  ): void => {
    const db = new DatabaseSync(file)
    try {
      db.exec('PRAGMA foreign_keys = ON')
      db.exec(schemaSql)
      db.prepare(
        'INSERT INTO items (id, key, title, date_added, date_modified) VALUES (1, ?, ?, ?, ?)'
      ).run('item-1', title, stamp, stamp)
      db.prepare(
        'INSERT INTO attachments (id, key, item_id, path, date_added) VALUES (1, ?, 1, ?, ?)'
      ).run('att-1', '/tmp/a.pdf', stamp)
      db.prepare(
        "INSERT INTO annotations (id, key, attachment_id, type, text, page_index, position, date_added, date_modified) VALUES (1, ?, 1, 'highlight', ?, 0, ?, ?, ?)"
      ).run('ann-1', annotationText, '{"rects":[]}', stamp, stamp)
      db.prepare(
        'INSERT INTO notes (id, key, item_id, title, date_added, date_modified) VALUES (1, ?, 1, ?, ?, ?)'
      ).run('note-1', noteTitle, stamp, stamp)
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('theme', 'light')
    } finally {
      db.close()
    }
  }

  const makeBackend = (dir: string): Pd01Backend => {
    const live = join(dir, 'library.sqlite')
    let liveDb: DatabaseSync | null = null
    const openLive = (): DatabaseSync => {
      if (!liveDb) {
        liveDb = new DatabaseSync(live)
        liveDb.exec('PRAGMA journal_mode = WAL')
        liveDb.exec('PRAGMA foreign_keys = ON')
      }
      return liveDb
    }
    const backend: Pd01Backend = {
      dataDir: () => dir,
      snapshotLive(dest: string) {
        if (backend.failSnapshot) throw backend.failSnapshot
        backend.calls.snapshot += 1
        openLive().exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
      },
      async backupLive(dest: string) {
        backend.snapshotLive(dest)
      },
      openProbe(file: string) {
        const probe = new DatabaseSync(file, { readOnly: true })
        return {
          prepare(sql: string) {
            const statement = probe.prepare(sql)
            return { all: (...params: unknown[]) => statement.all(...(params as never[])) }
          },
          close: () => probe.close()
        }
      },
      close() {
        backend.calls.close += 1
        if (backend.failCloseOnce) throw new Error('模拟关闭连接失败')
        liveDb?.close()
        liveDb = null
      },
      init() {
        backend.calls.init += 1
        if (backend.failInitOnce && backend.calls.init === 1) throw new Error('模拟重新打开失败')
        openLive()
      },
      calls: { snapshot: 0, init: 0, close: 0 },
      failSnapshot: null,
      failInitOnce: false,
      failCloseOnce: false
    }
    return backend
  }

  const leftovers = (dir: string): string[] =>
    readdirSync(dir).filter((name) => /\.(restore|pre-restore)-|\.bak$|\.tmp$/.test(name))

  const expectOriginal = (label: string, file: string): void => {
    const rows = readRows(file)
    check(
      label + '：条目保留',
      rows.titles.length === 1 && rows.titles[0] === '旧论文',
      JSON.stringify(rows.titles)
    )
    check(
      label + '：笔记保留',
      rows.notes.length === 1 && rows.notes[0] === '旧笔记',
      JSON.stringify(rows.notes)
    )
    check(label + '：批注保留', rows.annotations === 1, String(rows.annotations))
  }

  try {
    // 1) 损坏 / 非 SQLite / 空文件 / 不存在：直接拒绝，现有库不动
    {
      const dir = join(root, 'bad-input')
      mkdirSync(dir, { recursive: true })
      const live = join(dir, 'library.sqlite')
      createLibrary(live, '旧论文', '旧笔记', '旧批注')
      const backend = makeBackend(dir)

      const missing = inspectBackupDatabase(join(root, 'missing.sqlite'), backend.openProbe)
      check('PD01：不存在的备份文件判定不可用', !missing.ok, missing.reason)
      const emptyFile = join(root, 'empty.sqlite')
      writeFileSync(emptyFile, '')
      const empty = inspectBackupDatabase(emptyFile, backend.openProbe)
      check('PD01：空备份文件判定不可用', !empty.ok && empty.reason.includes('为空'), empty.reason)

      const garbage = join(root, 'garbage.sqlite')
      writeFileSync(garbage, Buffer.from('这不是一个 SQLite 数据库'.repeat(64)))
      const denied = throws(() => restoreDatabase(garbage, backend))
      check(
        'PD01：损坏/非 SQLite 备份被拒绝恢复',
        !!denied && denied.includes('恢复被拒绝（备份不可用）'),
        denied
      )
      check('PD01：拒绝后现有数据库文件仍在', existsSync(live))
      expectOriginal('PD01 损坏输入', live)
      check('PD01：拒绝后未留下临时文件', leftovers(dir).length === 0, leftovers(dir).join(','))
      backend.close()
    }

    // 2) 合法 SQLite 但缺必要表：拒绝
    {
      const dir = join(root, 'missing-schema')
      mkdirSync(dir, { recursive: true })
      const live = join(dir, 'library.sqlite')
      createLibrary(live, '旧论文', '旧笔记', '旧批注')
      const backend = makeBackend(dir)

      const partial = join(root, 'partial.sqlite')
      const partialDb = new DatabaseSync(partial)
      partialDb.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)')
      partialDb.close()
      const partialCheck = inspectBackupDatabase(partial, backend.openProbe)
      check(
        'PD01：缺表的 SQLite 判定不可用',
        !partialCheck.ok && partialCheck.reason.includes('缺少必要数据表'),
        partialCheck.reason
      )
      check(
        'PD01：拒绝原因点名缺失的必要表',
        REQUIRED_BACKUP_TABLES.some((table) => partialCheck.reason.includes(table)),
        partialCheck.reason
      )
      const denied = throws(() => restoreDatabase(partial, backend))
      check(
        'PD01：缺少必要表时拒绝恢复',
        !!denied && denied.includes('恢复被拒绝（备份不可用）'),
        denied
      )
      expectOriginal('PD01 缺表', live)
      check('PD01：缺表拒绝后无残留', leftovers(dir).length === 0, leftovers(dir).join(','))
      backend.close()
    }

    // 3) 表齐全但关键列缺失：拒绝
    {
      const dir = join(root, 'missing-columns')
      mkdirSync(dir, { recursive: true })
      const live = join(dir, 'library.sqlite')
      createLibrary(live, '旧论文', '旧笔记', '旧批注')
      const backend = makeBackend(dir)

      const narrow = join(root, 'narrow.sqlite')
      const narrowDb = new DatabaseSync(narrow)
      narrowDb.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, key TEXT);
CREATE TABLE attachments (id INTEGER PRIMARY KEY, key TEXT, item_id INTEGER, path TEXT, date_added TEXT);
CREATE TABLE annotations (id INTEGER PRIMARY KEY, key TEXT, attachment_id INTEGER, page_index INTEGER, position TEXT, date_added TEXT);
CREATE TABLE notes (id INTEGER PRIMARY KEY, key TEXT, item_id INTEGER, title TEXT, date_added TEXT, date_modified TEXT);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`)
      narrowDb.close()
      const narrowCheck = inspectBackupDatabase(narrow, backend.openProbe)
      check(
        'PD01：缺关键列的 SQLite 判定不可用',
        !narrowCheck.ok && narrowCheck.reason.includes('缺少必要列'),
        narrowCheck.reason
      )
      const denied = throws(() => restoreDatabase(narrow, backend))
      check(
        'PD01：缺少必要列时拒绝恢复',
        !!denied && denied.includes('恢复被拒绝（备份不可用）'),
        denied
      )
      expectOriginal('PD01 缺列', live)
      check('PD01：缺列拒绝后无残留', leftovers(dir).length === 0, leftovers(dir).join(','))
      backend.close()
    }

    // 4) 安全备份失败：拒绝恢复，绝不删除现有库
    {
      const dir = join(root, 'snapshot-failure')
      mkdirSync(dir, { recursive: true })
      const live = join(dir, 'library.sqlite')
      createLibrary(live, '旧论文', '旧笔记', '旧批注')
      const source = join(root, 'good-source.sqlite')
      createLibrary(source, '新论文', '新笔记', '新批注')
      const backend = makeBackend(dir)
      backend.failSnapshot = new Error('模拟磁盘已满')

      const failed = throws(() => restoreDatabase(source, backend))
      check(
        'PD01：安全备份失败时取消恢复',
        !!failed && failed.includes('安全备份失败，已取消恢复'),
        failed
      )
      check(
        'PD01：安全备份失败提示现有数据库保持不变',
        !!failed && failed.includes('现有数据库保持不变'),
        failed
      )
      check('PD01：安全备份失败时原库未被删除', existsSync(live))
      expectOriginal('PD01 安全备份失败', live)
      check('PD01：安全备份失败后无残留', leftovers(dir).length === 0, leftovers(dir).join(','))
      backend.close()
    }

    // 5) 复制完成、安装前关闭连接失败：回滚并保留原库
    {
      const dir = join(root, 'close-failure')
      mkdirSync(dir, { recursive: true })
      const live = join(dir, 'library.sqlite')
      createLibrary(live, '旧论文', '旧笔记', '旧批注')
      const source = join(root, 'good-source.sqlite')
      const backend = makeBackend(dir)
      backend.failCloseOnce = true

      const failed = throws(() => restoreDatabase(source, backend))
      check(
        'PD01：安装前失败时回滚到原数据库',
        !!failed && failed.includes('恢复失败，已回滚到原数据库'),
        failed
      )
      check('PD01：回滚后原库文件仍在', existsSync(live))
      expectOriginal('PD01 安装前失败', live)
      check(
        'PD01：回滚后清理临时副本',
        leftovers(dir).filter((name) => name.includes('library.restore-')).length === 0,
        leftovers(dir).join(',')
      )
      check(
        'PD01：回滚保留恢复前安全备份',
        readdirSync(join(dir, 'backups')).some((name) => name.startsWith('pre-restore-'))
      )
      backend.failCloseOnce = false
      backend.close()
    }

    // 6) 安装后重新打开失败：回滚，条目/批注/笔记全部保留
    {
      const dir = join(root, 'init-failure')
      mkdirSync(dir, { recursive: true })
      const live = join(dir, 'library.sqlite')
      createLibrary(live, '旧论文', '旧笔记', '旧批注')
      const source = join(root, 'good-source.sqlite')
      const backend = makeBackend(dir)
      backend.failInitOnce = true

      const failed = throws(() => restoreDatabase(source, backend))
      check(
        'PD01：安装后重开失败时回滚',
        !!failed && failed.includes('恢复失败，已回滚到原数据库'),
        failed
      )
      expectOriginal('PD01 安装后失败', live)
      check(
        'PD01：安装后失败清理临时文件',
        leftovers(dir).filter((name) => name.includes('library.restore-')).length === 0,
        leftovers(dir).join(',')
      )
      const safetyNames = readdirSync(join(dir, 'backups')).filter((name) =>
        name.startsWith('pre-restore-')
      )
      check('PD01：回滚时保留恢复前安全备份', safetyNames.length === 1, safetyNames.join(','))
      if (safetyNames.length === 1) {
        const safetyRows = readRows(join(dir, 'backups', safetyNames[0]))
        check(
          'PD01：安全备份内容是恢复前的旧库',
          safetyRows.titles[0] === '旧论文',
          JSON.stringify(safetyRows.titles)
        )
      }
      backend.close()
      expectOriginal('PD01 回滚后重开', live)
    }

    // 7) 正常恢复：成功后退出重开数据一致
    {
      const dir = join(root, 'success')
      mkdirSync(dir, { recursive: true })
      const live = join(dir, 'library.sqlite')
      createLibrary(live, '旧论文', '旧笔记', '旧批注')
      const source = join(root, 'good-source.sqlite')
      const backend = makeBackend(dir)

      const result = restoreDatabase(source, backend)
      check('PD01：正常恢复返回 restored', result.restored === 'library.sqlite', result.restored)
      check(
        'PD01：正常恢复留下安全备份',
        !!result.safety && existsSync(result.safety),
        String(result.safety)
      )
      const rows = readRows(live)
      check('PD01：恢复后条目来自备份', rows.titles[0] === '新论文', JSON.stringify(rows.titles))
      check('PD01：恢复后笔记来自备份', rows.notes[0] === '新笔记', JSON.stringify(rows.notes))
      check('PD01：恢复后批注来自备份', rows.annotations === 1, String(rows.annotations))
      const integrity = inspectBackupDatabase(live, backend.openProbe)
      check('PD01：恢复后数据库完整性 ok', integrity.ok, integrity.reason)
      backend.close()

      const reopened = readRows(live)
      check(
        'PD01：退出重开后条目一致',
        reopened.titles.length === 1 && reopened.titles[0] === '新论文',
        JSON.stringify(reopened.titles)
      )
      check(
        'PD01：退出重开后笔记一致',
        reopened.notes.length === 1 && reopened.notes[0] === '新笔记',
        JSON.stringify(reopened.notes)
      )
      check('PD01：退出重开后批注一致', reopened.annotations === 1, String(reopened.annotations))
      check(
        'PD01：成功恢复后无临时文件或 .bak 残留',
        leftovers(dir).length === 0,
        leftovers(dir).join(',')
      )
      const safetyRows = readRows(result.safety as string)
      check(
        'PD01：安全备份保存的是恢复前旧库',
        safetyRows.titles[0] === '旧论文',
        JSON.stringify(safetyRows.titles)
      )
    }

    // 7.5) FA01 copy-fail 注入：恢复失败，但原库一个字节都不动
    {
      const dir = join(root, 'copy-fail')
      mkdirSync(dir, { recursive: true })
      const live = join(dir, 'library.sqlite')
      createLibrary(live, '旧论文', '旧笔记', '旧批注')
      const source = join(root, 'fault-source.sqlite')
      createLibrary(source, '新论文', '新笔记', '新批注')
      const backend = makeBackend(dir)
      const before = statSync(live).size
      const message = throws(() => restoreDatabase(source, backend, { testFault: 'copy-fail' }))
      check('FA01：copy-fail 让恢复失败', message !== null)
      check(
        'FA01：copy-fail 失败提示写明现有数据库不变',
        (message ?? '').includes('copy-fail') && (message ?? '').includes('现有数据库保持不变'),
        String(message)
      )
      check(
        'FA01：copy-fail 不关闭现有数据库连接',
        backend.calls.close === 0,
        String(backend.calls.close)
      )
      check('FA01：copy-fail 不重新初始化数据库', backend.calls.init === 0, String(backend.calls.init))
      check(
        'FA01：copy-fail 后 library.sqlite 仍在且字节数不变',
        existsSync(live) && statSync(live).size === before,
        `${String(existsSync(live))} ${statSync(live).size}/${before}`
      )
      check(
        'FA01：copy-fail 不留下 restore 临时文件',
        leftovers(dir).filter((name) => name.startsWith('library.restore-')).length === 0,
        leftovers(dir).join(',')
      )
      const safetyNames = readdirSync(join(dir, 'backups')).filter((name) =>
        name.startsWith('pre-restore-')
      )
      check('FA01：copy-fail 仍保留恢复前安全备份', safetyNames.length === 1, safetyNames.join(','))
      backend.close()
      expectOriginal('FA01 copy-fail 失败后重开', live)
    }

    // 7.6) FA01 接线：默认（不传 options）时读测试副本登记的读取器
    {
      const dir = join(root, 'copy-fail-wiring')
      mkdirSync(dir, { recursive: true })
      const live = join(dir, 'library.sqlite')
      createLibrary(live, '旧论文', '旧笔记', '旧批注')
      const source = join(root, 'wiring-source.sqlite')
      createLibrary(source, '新论文', '新笔记', '新批注')
      const backend = makeBackend(dir)
      const before = statSync(live).size
      const previous = Object.getOwnPropertyDescriptor(globalThis, TEST_FAULT_READER)
      try {
        Object.defineProperty(globalThis, TEST_FAULT_READER, {
          value: () => 'copy-fail',
          configurable: true,
          writable: true
        })
        const message = throws(() => restoreDatabase(source, backend))
        check(
          'FA01：默认恢复路径读到已登记的测试故障',
          (message ?? '').includes('copy-fail'),
          String(message)
        )
        check('FA01：接线生效时原库字节数不变', statSync(live).size === before, String(before))
        check('FA01：接线生效时不关闭现有连接', backend.calls.close === 0, String(backend.calls.close))
      } finally {
        if (previous) Object.defineProperty(globalThis, TEST_FAULT_READER, previous)
        else Reflect.deleteProperty(globalThis, TEST_FAULT_READER)
      }
      backend.close()
      expectOriginal('FA01 默认路径故障后重开', live)
    }

    // 7.7) FA01 接线：没有登记读取器（正式构建形态）时默认恢复照常成功
    {
      const dir = join(root, 'no-reader')
      mkdirSync(dir, { recursive: true })
      const live = join(dir, 'library.sqlite')
      createLibrary(live, '旧论文', '旧笔记', '旧批注')
      const source = join(root, 'no-reader-source.sqlite')
      createLibrary(source, '新论文', '新笔记', '新批注')
      const backend = makeBackend(dir)
      const previous = Object.getOwnPropertyDescriptor(globalThis, TEST_FAULT_READER)
      try {
        Reflect.deleteProperty(globalThis, TEST_FAULT_READER)
        const result = restoreDatabase(source, backend)
        check('FA01：没有登记读取器时恢复成功', result.restored === 'library.sqlite', result.restored)
        const rows = readRows(live)
        check(
          'FA01：没有登记读取器时数据来自备份',
          rows.titles[0] === '新论文',
          JSON.stringify(rows.titles)
        )
      } finally {
        if (previous) Object.defineProperty(globalThis, TEST_FAULT_READER, previous)
      }
      backend.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

/**
 * PD02：导入只给本次新增文献归组。
 * 纯函数断言「本次新增」口径（重复/取消/失败都不算），源码断言导入链路
 * 不再给既有条目补分组，且文件 / 文件夹 / DOI / URL 四个入口都返回本次新增 id。
 */
function pd02LibraryImportGroupingTests(): void {
  console.log('PD02 导入归属：只给本次新增文献归组')

  const rootOf = (rel: string): string =>
    fileURLToPath(new URL(rel, import.meta.url)).replace(/\\/g, '/')

  // 1) 新增 id 收集：重复条目、取消、失败、非法 id 都不算本次新增
  const mixed = newlyImportedItemIds([
    { itemId: 11 },
    { itemId: 11, duplicate: true },
    { itemId: 12 },
    { itemId: 0 },
    { itemId: -3 },
    { itemId: 1.5 },
    { itemId: undefined },
    { itemId: null },
    { itemId: 7, duplicate: true }
  ])
  check(
    'PD02：只收集非重复的合法条目 id，去重且保序',
    JSON.stringify(mixed) === JSON.stringify([11, 12]),
    JSON.stringify(mixed)
  )
  check(
    'PD02：取消/失败（无 id）不产生归组目标',
    newlyImportedItemIds([{}, { itemId: null }, { itemId: 0 }]).length === 0
  )

  // 2) 两个导入交错：各自只拿到自己的新增 id，命中重复也不会抢对方条目
  const importA = newlyImportedItemIds([{ itemId: 101 }, { itemId: 102 }])
  const importB = newlyImportedItemIds([{ itemId: 201 }, { itemId: 202, duplicate: true }])
  check(
    'PD02：并行导入各自只返回自己的新增 id',
    JSON.stringify(importA) === JSON.stringify([101, 102]) &&
      JSON.stringify(importB) === JSON.stringify([201]),
    `A=${JSON.stringify(importA)} B=${JSON.stringify(importB)}`
  )
  check(
    'PD02：并行导入的归属互不重叠',
    !importA.some((id) => importB.includes(id)),
    `A=${JSON.stringify(importA)} B=${JSON.stringify(importB)}`
  )
  const importC = newlyImportedItemIds([{ itemId: 101, duplicate: true }, { itemId: 301 }])
  check(
    'PD02：第三方导入命中重复文件时不把 A 的条目算成自己的',
    JSON.stringify(importC) === JSON.stringify([301]),
    JSON.stringify(importC)
  )

  // 3) 文件夹口径：重复与失败计入 skipped，只有新增算 imported
  const folder = summarizeFolderImport([{}, { duplicate: true }, { error: true }, {}])
  check(
    'PD02：文件夹导入重复/失败计入 skipped',
    folder.imported === 2 && folder.skipped === 2,
    JSON.stringify(folder)
  )
  const emptyFolder = summarizeFolderImport([])
  check(
    'PD02：空文件夹/取消导入计数为 0',
    emptyFolder.imported === 0 && emptyFolder.skipped === 0,
    JSON.stringify(emptyFolder)
  )

  // 4) 源码级：importPdfFromPath 只在 INSERT 时写 group，重复分支不动旧条目
  const lib = readFileSync(rootOf('../src/main/ipc/library.ts'), 'utf8').replace(/\r\n/g, '\n')
  const fnStart = lib.indexOf('export function importPdfFromPath(')
  const fnEnd = lib.indexOf('/** 后台识别', fnStart)
  const importFn = fnStart >= 0 && fnEnd > fnStart ? lib.slice(fnStart, fnEnd) : ''
  check('PD02：能定位 importPdfFromPath', importFn.length > 0)
  const groupUpdates = importFn.match(/group_name\s*=\s*\?/g) ?? []
  check(
    'PD02：导入函数不再 UPDATE 既有条目的 group_name',
    groupUpdates.length === 0,
    `找到 ${groupUpdates.length} 处`
  )
  check(
    'PD02：新增条目在入库事务里写入 group_name',
    importFn.includes('INSERT INTO items (key, title, type, group_name') &&
      importFn.includes('group || null')
  )
  const dupStart = importFn.indexOf('if (duplicate) {')
  const dupEnd = importFn.indexOf('const itemKey', dupStart)
  const dupBranch = dupStart >= 0 && dupEnd > dupStart ? importFn.slice(dupStart, dupEnd) : ''
  check('PD02：能定位重复文件分支', dupBranch.length > 0)
  check(
    'PD02：重复文件分支不建组、不改已有条目分组',
    !dupBranch.includes('ensureGroupPath') && !dupBranch.includes('UPDATE items')
  )

  // 5) 源码级：文件 / 文件夹入口都返回本次新增 itemIds，取消返回空数组
  check(
    'PD02：多选文件入口返回 canceled/items/message/itemIds',
    lib.includes('Promise<ImportPdfsOutcome>') &&
      lib.includes('return { canceled: false, items, itemIds, message }')
  )
  check(
    'PD02：取消导入返回空 itemIds 且不触碰分组',
    lib.includes("return { canceled: true, items: [], message: '已取消导入', itemIds: [] }")
  )
  check(
    'PD02：文件夹入口逐条收集新增 id 并用统一口径计数',
    lib.includes('result.itemIds.push(imported.item.id)') &&
      lib.includes('summarizeFolderImport(entries)')
  )

  // 6) 源码级：DOI/URL 两条通道区分新增与重复，并返回 itemIds
  const fetchSrc = readFileSync(
    rootOf('../src/main/services/fetch-pdf.ts'),
    'utf8'
  ).replace(/\r\n/g, '\n')
  check(
    'PD02：链接导入命中重复文件时按跳过处理',
    fetchSrc.includes("message: '已存在（跳过重复文件）'") && fetchSrc.includes('itemIds: []')
  )
  check('PD02：链接导入成功只返回本次新增 id', fetchSrc.includes('itemIds: [result.item.id]'))
  check(
    'PD02：批量链接按输入下标汇总，避免并发串号',
    fetchSrc.includes('idsByIndex[i] = ok && !wasSkipped ? newIds : []') &&
      fetchSrc.includes('seenIds.has(id)')
  )

  // 7) 渲染层：刷新/清空依据返回的 itemIds，不再用 imported+skipped 推断
  const renderer = readFileSync(
    rootOf('../src/renderer/src/features/library/LibraryList.tsx'),
    'utf8'
  ).replace(/\r\n/g, '\n')
  check(
    'PD02：渲染层用 itemIds 判断是否刷新',
    renderer.includes('res.itemIds.length > 0') && !renderer.includes('setGroupMany')
  )

  // 8) API 契约：四个入口都声明 itemIds 返回类型
  const apiSrc = readFileSync(rootOf('../src/shared/api.ts'), 'utf8').replace(/\r\n/g, '\n')
  check(
    'PD02：API 契约声明四个入口的本次新增 id',
    apiSrc.includes('Promise<ImportPdfsOutcome>') &&
      apiSrc.includes('Promise<ImportFolderOutcome | null>') &&
      apiSrc.includes('Promise<ImportUrlOutcome>') &&
      apiSrc.includes('Promise<ImportManyOutcome>')
  )
}

// ---------------------------------------------------------------------------
// GD：分组排序与移动（data 层）。
// - 纯函数 buildDocOrder / compareGroupSiblings（同层 sort_order 优先、名称兜底、不丢行）；
// - migrate：旧库（无 sort_order 行）升级后每个分组都有确定的 sort_order，
//   顺序稳定可重复、迁移可幂等——library_groups 的 BACKFILLS 由 1 条扩为 2 条；
// - services（better-sqlite3 → 上方 GD_SQLITE_STUB 临时注入 node:sqlite 适配）：
//   新建组挂同层尾、移动后代路径与 items.group_name 同步、原/新父级列表完整、
//   目标同名分组抛错零修改、移到自身/后代抛错零修改、同层 position 重排连续。
// ---------------------------------------------------------------------------

function gdMakeSqliteAdapter(): { raw: any; wrapper: any } {
  const raw = new DatabaseSync(':memory:')
  const stmts = new Map<string, any>()
  let txnDepth = 0
  let spSeq = 0
  const prepared = (sql: string): any => {
    let s = stmts.get(sql)
    if (!s) {
      s = raw.prepare(sql)
      stmts.set(sql, s)
    }
    return {
      run: (...a: unknown[]) => s.run(...a),
      get: (...a: unknown[]) => s.get(...a),
      all: (...a: unknown[]) => s.all(...a)
    }
  }
  const wrapper = {
    pragma(sql: string): void {
      raw.exec(`PRAGMA ${sql}`)
    },
    exec(sql: string): void {
      raw.exec(sql)
    },
    prepare(sql: string): any {
      return prepared(sql)
    },
    close(): void {
      raw.close()
    },
    backup(_dest: string): void {
      throw new Error('测试适配不支持 backup()')
    },
    transaction(fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
      // 与真实 better-sqlite3 语义一致：嵌套调用用 SAVEPOINT 而不是再开 BEGIN
      // （writeCache→writeFormulas 会出现事务套事务）。
      return (...args: unknown[]): unknown => {
        if (txnDepth > 0) {
          const sp = 'sp' + ++spSeq
          try {
            raw.exec('SAVEPOINT ' + sp)
            const out = fn(...args)
            raw.exec('RELEASE SAVEPOINT ' + sp)
            return out
          } catch (e) {
            try {
              raw.exec('ROLLBACK TO SAVEPOINT ' + sp)
            } catch {
              // 保存点已失效，忽略
            }
            try {
              raw.exec('RELEASE SAVEPOINT ' + sp)
            } catch {
              // 忽略
            }
            throw e
          }
        }
        raw.exec('BEGIN IMMEDIATE')
        try {
          txnDepth++
          const out = fn(...args)
          raw.exec('COMMIT')
          return out
        } catch (e) {
          try {
            raw.exec('ROLLBACK')
          } catch {
            // 事务尚未开启/已回滚，忽略
          }
          throw e
        } finally {
          txnDepth = Math.max(0, txnDepth - 1)
        }
      }
    }
  }
  return { raw, wrapper }
}

async function groupOrderTests(): Promise<void> {
  const globalAny = globalThis as unknown as Record<string, unknown>

  // —— ① 旧库 migrate：补 sort_order、顺序稳定、可重复、幂等 ——
  const buildOldLibrary = (): any => {
    const oldDb = new DatabaseSync(':memory:')
    oldDb.exec(
      `CREATE TABLE library_groups (
        name TEXT PRIMARY KEY,
        parent_name TEXT,
        date_created TEXT NOT NULL,
        date_modified TEXT,
        description TEXT
      )`
    )
    const ins = oldDb.prepare(
      'INSERT INTO library_groups (name, parent_name, date_created, date_modified, description) VALUES (?, ?, ?, ?, ?)'
    )
    for (const [i, name] of [
      '语言模型/微调',
      '多模态',
      '语言模型/推理',
      '自然语言处理',
      '语言模型'
    ].entries()) {
      const parts = name.split('/')
      ins.run(
        name,
        parts.length > 1 ? parts.slice(0, -1).join('/') : null,
        `2026-01-01T00:00:0${i}.000Z`,
        `2026-01-01T00:00:0${i}.000Z`,
        null
      )
    }
    return oldDb
  }
  const orderMap = (db: any): Record<string, number | null> => {
    const rows = db.prepare('SELECT name, sort_order FROM library_groups').all() as any[]
    const map: Record<string, number | null> = {}
    for (const r of rows) map[String(r.name)] = r.sort_order == null ? null : Number(r.sort_order)
    return map
  }
  const migrateWarns: string[] = []
  const oldA = buildOldLibrary()
  migrate(oldA, { info: (): void => {}, warn: (m: unknown): void => migrateWarns.push(String(m)) })
  const mapA = orderMap(oldA)
  check(
    '分组排序：旧库升级后每个分组都有确定的 sort_order',
    migrateWarns.length === 0 &&
      mapA['多模态'] === 1 &&
      mapA['自然语言处理'] === 2 &&
      mapA['语言模型'] === 3 &&
      mapA['语言模型/微调'] === 1 &&
      mapA['语言模型/推理'] === 2,
    JSON.stringify({ warns: migrateWarns, map: mapA })
  )
  const oldB = buildOldLibrary()
  migrate(oldB, { info: (): void => {}, warn: (m: unknown): void => migrateWarns.push(String(m)) })
  check(
    '分组排序：旧库升级首次列出顺序稳定且可重复',
    migrateWarns.length === 0 && JSON.stringify(mapA) === JSON.stringify(orderMap(oldB)),
    JSON.stringify({ got: orderMap(oldB), want: mapA })
  )
  migrate(oldA, { info: (): void => {}, warn: (m: unknown): void => migrateWarns.push(String(m)) })
  check(
    '分组排序：migrate 可重复执行（幂等）',
    migrateWarns.length === 0 && JSON.stringify(mapA) === JSON.stringify(orderMap(oldA))
  )

  // —— ② services：真实 SQL 行为 ——
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gd-group-order-'))
  const prevDataEnv = process.env.PAPERDESK_DATA
  process.env.PAPERDESK_DATA = tmpRoot
  let currentAdapter: { raw: any; wrapper: any } | null = null
  let dbm: any = null
  try {
    globalAny.__GD_SQLITE_FACTORY = (): any => {
      currentAdapter = gdMakeSqliteAdapter()
      return currentAdapter.wrapper
    }
    dbm = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/library-groups.ts', import.meta.url).href)
    const shared = await import(new URL('../src/shared/library-groups.ts', import.meta.url).href)

    // ②-A 纯函数：buildDocOrder / compareGroupSiblings
    const docOrdered = shared
      .buildDocOrder([
        { name: 'g/a', parent_name: null },
        { name: 'g/b', sort_order: 25 },
        { name: 'g', path: 'g' },
        { name: 'g/c' }
      ])
      .filter((r: any) => r.name)
      .map((r: any) => r.name)
    check(
      '分组排序：buildDocOrder 同层 sort_order 优先、父在上且不丢行',
      docOrdered.join('|') === 'g|g/b|g/a|g/c',
      docOrdered.join('|')
    )
    check(
      '分组排序：compareGroupSiblings 层级优先序与稳定兜底',
      shared.compareGroupSiblings({ name: 'a', sort_order: 2 }, { name: 'b', sort_order: 1 }) > 0 &&
        shared.compareGroupSiblings({ name: 'a', sort_order: 1 }, { name: 'b', sort_order: null }) < 0 &&
        shared.compareGroupSiblings({ name: 'b', sort_order: null }, { name: 'a', sort_order: null }) > 0,
      JSON.stringify([
        shared.compareGroupSiblings({ name: 'a', sort_order: 2 }, { name: 'b', sort_order: 1 }),
        shared.compareGroupSiblings({ name: 'a', sort_order: 1 }, { name: 'b', sort_order: null })
      ])
    )

    // ②-B 新建分组：同层挂尾（next_sibling_order），列表层序稳定可重复
    dbm.initDb()
    svc.createLibraryGroup('自然语言处理')
    svc.createLibraryGroup('语言模型')
    svc.createLibraryGroup('微调', '语言模型')
    svc.createLibraryGroup('推理', '语言模型')
    svc.createLibraryGroup('评测', '语言模型')
    const singleList = (): string =>
      (svc.listLibraryGroups() as any[])
        .filter((r: any) =>
          [
            '自然语言处理',
            '语言模型',
            '语言模型/微调',
            '语言模型/推理',
            '语言模型/评测'
          ].includes(r.name)
        )
        .map((r: any) => `${r.name}#${r.sort_order}`)
        .join(',')
    const listFirst = singleList()
    check(
      '分组排序：新建分组挂同层尾且 sort_order 连续',
      listFirst ===
        '自然语言处理#1,语言模型#2,语言模型/微调#1,语言模型/推理#2,语言模型/评测#3',
      listFirst
    )
    check('分组排序：listLibraryGroups 结果可重复', singleList() === listFirst)

    // ②-C 移动分组到另一分组下：自身路径、items.group_name、原/新父级列表
    svc.createLibraryGroup('科学')
    svc.createLibraryGroup('计算', '科学')
    svc.createLibraryGroup('视图', '科学/计算')
    svc.createLibraryGroup('人文')
    const itemTs = '2026-01-02T00:00:00.000Z'
    const insItem = dbm
      .getDb()
      .prepare('INSERT INTO items (key, group_name, date_added, date_modified) VALUES (?, ?, ?, ?)')
    insItem.run('g1', '科学/计算/视图', itemTs, itemTs)
    insItem.run('g2', '科学/计算/视图', itemTs, itemTs)
    svc.updateLibraryGroup('科学/计算/视图', { parent: '人文' })
    const moved = svc.getLibraryGroup('人文/视图')
    check(
      '分组排序：移动到另一分组下后自身路径与 parent 更新',
      moved != null && moved.parent_name === '人文',
      JSON.stringify(moved)
    )
    const oldPath = currentAdapter.raw
      .prepare('SELECT name FROM library_groups WHERE name = ?')
      .all('科学/计算/视图')
    check('分组排序：移动后旧路径行已消失', oldPath.length === 0)
    const itemRows = currentAdapter.raw
      .prepare('SELECT key, group_name FROM items ORDER BY key')
      .all()
    check(
      '分组排序：移动后代 items.group_name 同步更新',
      itemRows.length === 2 && itemRows.every((r: any) => String(r.group_name) === '人文/视图'),
      JSON.stringify(itemRows)
    )
    const afterListAll = svc.listLibraryGroups() as any[]
    check(
      '分组排序：原父级列表仍完整（科学/计算 保留）',
      afterListAll.some((r: any) => r.name === '科学/计算' && r.parent_name === '科学')
    )
    check(
      '分组排序：新父级列表完整（人文 含 移动后的 视图）',
      afterListAll.some((r: any) => r.name === '人文/视图' && r.parent_name === '人文')
    )

    // ②-D 目标位置存在同名分组：抛错且零行修改
    svc.createLibraryGroup('图集', '人文')
    const snapshotBefore = (): string =>
      JSON.stringify({
        groups: currentAdapter.raw.prepare('SELECT * FROM library_groups ORDER BY name').all(),
        items: currentAdapter.raw.prepare('SELECT * FROM items ORDER BY id').all()
      })
    const beforeClash = snapshotBefore()
    const clashError = throws(() =>
      svc.updateLibraryGroup('科学/计算', { parent: '人文', leaf: '图集' })
    )
    check('分组排序：目标位置同名分组抛错', clashError === '目标分组已存在', String(clashError))
    check('分组排序：同名冲突时数据库零行修改', snapshotBefore() === beforeClash)

    // ②-E 移到自身/后代：抛错且零行修改
    const beforeCycle = snapshotBefore()
    const selfError = throws(() => svc.updateLibraryGroup('科学', { parent: '科学' }))
    const descError = throws(() => svc.updateLibraryGroup('科学', { parent: '科学/计算' }))
    check('分组排序：移动到自己抛错', selfError === '不能把分组移动到它自己或它的后代下', String(selfError))
    check(
      '分组排序：移动到自己的后代抛错',
      descError === '不能把分组移动到自己的子分组下',
      String(descError)
    )
    check('分组排序：非法移动时数据库零行修改', snapshotBefore() === beforeCycle)

    // ②-F 移动到顶层：叶名保留、parent 置空并挂到顶层尾
    svc.updateLibraryGroup('语言模型/评测', { parent: null })
    const toTop = svc.getLibraryGroup('评测')
    check(
      '分组排序：移动到顶层保留叶名并置空父级',
      toTop != null && toTop.parent_name == null,
      JSON.stringify(toTop)
    )

    // ②-G 同层重排：第 3 位移到第 1 位，顺序改变且 sort_order 连续无重复
    svc.createLibraryGroup('实验')
    svc.createLibraryGroup('实验布局', '实验')
    svc.createLibraryGroup('评估', '实验')
    svc.createLibraryGroup('对照', '实验')
    const layerBefore = (svc.listLibraryGroups() as any[])
      .filter((r: any) => r.parent_name === '实验')
      .map((r: any) => `${r.name}#${r.sort_order}`)
    check(
      '分组排序：重排前按创建顺序排列',
      layerBefore.join(',') === '实验/实验布局#1,实验/评估#2,实验/对照#3',
      layerBefore.join(',')
    )
    svc.updateLibraryGroup('实验/对照', { position: 1 })
    const layerAfter = (svc.listLibraryGroups() as any[])
      .filter((r: any) => r.parent_name === '实验')
      .map((r: any) => `${r.name}#${r.sort_order}`)
    check(
      '分组排序：同层第 3 位移到第 1 位且 sort_order 连续无重复',
      layerAfter.join(',') === '实验/对照#1,实验/实验布局#2,实验/评估#3',
      layerAfter.join(',')
    )

    // ②-H 删除分组：默认拒绝带子分组；叶子文献并入父级；withDescendants 整棵删除
    svc.createLibraryGroup('清理')
    svc.createLibraryGroup('空组', '清理')
    svc.createLibraryGroup('子组', '清理')
    svc.createLibraryGroup('孙子组', '清理/子组')
    svc.createLibraryGroup('有文', '清理')
    insItem.run('d1', '清理/有文', itemTs, itemTs)
    insItem.run('d2', '清理/有文', itemTs, itemTs)
    insItem.run('d3', '清理/子组/孙子组', itemTs, itemTs)

    const beforeDelete = snapshotBefore()
    const deleteReject = throws(() => svc.deleteLibraryGroup('清理'))
    check(
      '分组删除：带子分组默认拒绝并提示子分组数量',
      deleteReject === '分组「清理」下还有 3 个子分组，请确认是否一并删除',
      String(deleteReject)
    )
    check('分组删除：默认拒绝时数据库零行修改', snapshotBefore() === beforeDelete)

    const emptyDel = svc.deleteLibraryGroup('清理/空组')
    check(
      '分组删除：删除空叶子分组只删自身',
      emptyDel.name === '清理/空组' &&
        emptyDel.removed.join(',') === '清理/空组' &&
        emptyDel.movedItems === 0 &&
        emptyDel.parent_name === '清理',
      JSON.stringify(emptyDel)
    )
    check(
      '分组删除：空分组删掉后分组行消失',
      !(svc.listLibraryGroups() as any[]).some((r: any) => r.name === '清理/空组')
    )
    const layerAfterEmpty = (svc.listLibraryGroups() as any[])
      .filter((r: any) => r.parent_name === '清理')
      .map((r: any) => `${r.name}#${r.sort_order}`)
    check(
      '分组删除：删除空分组后同层 sort_order 紧凑为 1..n',
      layerAfterEmpty.join(',') === '清理/子组#1,清理/有文#2',
      layerAfterEmpty.join(',')
    )

    const leafDel = svc.deleteLibraryGroup('清理/有文')
    const movedLeafRows = currentAdapter.raw
      .prepare("SELECT key, group_name FROM items WHERE key IN ('d1','d2') ORDER BY key")
      .all()
    check(
      '分组删除：叶子分组其文献移入父分组',
      leafDel.movedItems === 2 &&
        leafDel.movedTo === '清理' &&
        movedLeafRows.length === 2 &&
        movedLeafRows.every((r: any) => String(r.group_name) === '清理'),
      JSON.stringify({ leafDel, movedLeafRows })
    )
    const layerAfterLeaf = (svc.listLibraryGroups() as any[])
      .filter((r: any) => r.parent_name === '清理')
      .map((r: any) => `${r.name}#${r.sort_order}`)
    check(
      '分组删除：删除有文献分组后同层重新紧凑',
      layerAfterLeaf.join(',') === '清理/子组#1',
      layerAfterLeaf.join(',')
    )

    const wholeDel = svc.deleteLibraryGroup('清理', { withDescendants: true })
    const orphanItems = currentAdapter.raw
      .prepare("SELECT key, group_name FROM items WHERE key IN ('d1','d2','d3') ORDER BY key")
      .all()
    check(
      '分组删除：withDescendants 整棵删除并返回全部路径',
      wholeDel.removed.includes('清理') &&
        wholeDel.removed.includes('清理/子组') &&
        wholeDel.removed.includes('清理/子组/孙子组') &&
        wholeDel.movedTo == null,
      JSON.stringify(wholeDel.removed)
    )
    check(
      '分组删除：整棵删除后子树文献变为未分组且不留幽灵分组',
      orphanItems.length === 3 &&
        orphanItems.every((r: any) => r.group_name == null) &&
        !(svc.listLibraryGroups() as any[]).some(
          (r: any) => r.name === '清理' || String(r.name).startsWith('清理/')
        ),
      JSON.stringify(orphanItems)
    )
  } finally {
    try {
      if (dbm) dbm.closeDb()
    } catch {
      // 已关闭则忽略
    }
    globalAny.__GD_SQLITE_FACTORY = undefined
    if (prevDataEnv === undefined) delete process.env.PAPERDESK_DATA
    else process.env.PAPERDESK_DATA = prevDataEnv
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// BLOCKS：getModules 对「统一结构化块」（阶段 B PoC，src/shared/blocks.ts）的
// 主进程透传与老数据兼容。复用 groupOrderTests 的真实 SQLite 注入方式
// （__GD_SQLITE_FACTORY → node:sqlite 适配），并用上面的侧车桩 + fetch 注入
// /modules 响应（不 spawn 真 python）。两条断言对应验收口径：
// ① 带 blocks 的响应能透传（组装成 BlocksPayload，写缓存后重读不丢）；
// ② 不带 blocks 的老数据不报错（blocks 保持 undefined，其余字段完好）。
// ---------------------------------------------------------------------------
async function blocksPassthroughTests(): Promise<void> {
  const globalAny = globalThis as unknown as Record<string, unknown>
  const stamp = '2026-01-02T03:04:05.000Z'
  const tmpRoot = mkdtempSync(join(tmpdir(), 'blocks-passthrough-'))
  const prevDataEnv = process.env.PAPERDESK_DATA
  const prevFetch = globalThis.fetch
  process.env.PAPERDESK_DATA = tmpRoot
  let currentBody: Record<string, unknown> = {}
  globalAny.fetch = (async (): Promise<Response> =>
    new Response(JSON.stringify(currentBody), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })) as unknown as typeof fetch
  let currentAdapter: { raw: any; wrapper: any } | null = null
  let dbm: any = null
  try {
    globalAny.__GD_SQLITE_FACTORY = (): any => {
      currentAdapter = gdMakeSqliteAdapter()
      return currentAdapter.wrapper
    }
    dbm = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/modules.ts', import.meta.url).href)
    dbm.initDb()
    dbm
      .getDb()
      .prepare('INSERT INTO items (id, key, title, date_added, date_modified) VALUES (?, ?, ?, ?, ?)')
      .run(701, 'blocks-paper', 'BLOCKS 论文', stamp, stamp)
    const insAtt = dbm
      .getDb()
      .prepare('INSERT INTO attachments (id, key, item_id, path, date_added) VALUES (?, ?, ?, ?, ?)')
    insAtt.run(901, 'blocks-passthrough', 701, '/tmp/blocks-on.pdf', stamp)
    insAtt.run(902, 'blocks-old-data', 701, '/tmp/blocks-old.pdf', stamp)

    // ① 带 blocks 的响应用于 getModules(901)：透传 → 组装成 BlocksPayload
    const bodyWithBlocks: Record<string, unknown> = {
      pageCount: 1,
      extractorVersion: 'formula-tree-2',
      pages: [{ page: 1, w: 500, h: 800, rects: [] }],
      modules: [
        { id: 'p1-t0', type: 'paragraph', page: 1, column: 0, rect: [0, 0, 400, 120], text: '统一结构化块' }
      ],
      captions: [],
      refs: [],
      formulas: [],
      columns: [{ page: 1, columns: 1 }],
      counts: { modules: 1, captions: 0, figures: 0, tables: 0, references: 0 },
      warnings: [],
      // 侧车平铺字段（attach_blocks 产物形态；数组 + 版本字符串）：
      adapterVersion: 'blocks-adapter/1',
      blocks: [
        {
          stableId: 'p1-b0',
          blockType: 'paragraph',
          sourceRegion: { page: 1, rect: [0, 0, 400, 120], rects: [[0, 0, 400, 60]] },
          text: '统一结构化块',
          moduleId: 'p1-t0'
        },
        {
          stableId: 'p1-b1',
          blockType: 'equation',
          sourceRegion: { page: 1, rect: [0, 140, 300, 180] },
          orphan: true
        }
      ]
    }
    const baseOldBody: Record<string, unknown> = {
      pageCount: 1,
      pages: [{ page: 1, w: 500, h: 800, rects: [] }],
      modules: [
        { id: 'p1-t0', type: 'paragraph', page: 1, column: 0, rect: [0, 0, 400, 120], text: '老形状文档' }
      ],
      captions: [],
      refs: [],
      formulas: [],
      columns: [{ page: 1, columns: 1 }],
      counts: { modules: 1, captions: 0, figures: 0, tables: 0, references: 0 },
      warnings: []
    }
    currentBody = bodyWithBlocks
    const doc1 = await svc.getModules(901)
    // 命中 readCache（假路径 → file_key/document_fingerprint 均为 'unknown' 且一致）
    const doc1r = await svc.getModules(901)
    const b0 = doc1.blocks?.blocks[0]
    const b1 = doc1.blocks?.blocks[1]
    check(
      'blocks：带 blocks 的响应透传为 BlocksPayload（adapterVersion/stableId/blockType/sourceRegion/orphan 完整，写缓存后重读不丢）',
      doc1.blocks != null &&
        doc1.blocks.adapterVersion === 'blocks-adapter/1' &&
        Array.isArray(doc1.blocks.blocks) &&
        doc1.blocks.blocks.length === 2 &&
        b0 != null &&
        b0.stableId === 'p1-b0' &&
        b0.blockType === 'paragraph' &&
        b0.sourceRegion != null &&
        b0.sourceRegion.page === 1 &&
        JSON.stringify(b0.sourceRegion.rect) === '[0,0,400,120]' &&
        b0.moduleId === 'p1-t0' &&
        b0.orphan === undefined &&
        b1 != null &&
        b1.stableId === 'p1-b1' &&
        b1.blockType === 'equation' &&
        b1.orphan === true &&
        doc1r.blocks != null &&
        doc1r.blocks.blocks.length === 2 &&
        doc1r.blocks.blocks[0].stableId === 'p1-b0' &&
        doc1r.blocks.blocks[1].orphan === true,
      JSON.stringify({ blocks: doc1.blocks, readback: doc1r.blocks })
    )

    // ② 老数据不报错：手工预置一张「适配层出现前」形状的缓存行（无 blocks/adapterVersion），
    // 哈希五列直接复用 ① 写出的真实值（同进程同一配置 → readCache 必命中，不触发 fetch）。
    const row901 = (currentAdapter as { raw: any }).raw
      .prepare(
        'SELECT file_key, document_fingerprint, extractor_version, config_hash, ocr_model_version FROM paper_modules WHERE attachment_id = 901'
      )
      .get() as {
      file_key: string
      document_fingerprint: string
      extractor_version: string
      config_hash: string
      ocr_model_version: string
    }
    ;(currentAdapter as { raw: any }).raw
      .prepare(
        `INSERT INTO paper_modules
           (attachment_id, doc_json, page_count, file_key, document_fingerprint,
            extractor_version, config_hash, ocr_model_version, stale, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
      )
      .run(
        902,
        JSON.stringify(baseOldBody),
        1,
        row901.file_key,
        row901.document_fingerprint,
        row901.extractor_version,
        row901.config_hash,
        row901.ocr_model_version,
        stamp
      )
    const doc2 = await svc.getModules(902)
    check(
      'blocks：不带 blocks 的老数据不报错（blocks 为 undefined，pageCount/modules/warnings 完好）',
      doc2 != null &&
        (doc2 as { blocks?: unknown }).blocks === undefined &&
        doc2.pageCount === 1 &&
        Array.isArray(doc2.modules) &&
        (doc2.modules[0] as { id?: string } | undefined)?.id === 'p1-t0' &&
        Array.isArray(doc2.warnings) &&
        doc2.warnings.length === 0,
      JSON.stringify({ blocks: (doc2 as { blocks?: unknown }).blocks, keys: Object.keys(doc2) })
    )
  } finally {
    try {
      if (dbm) dbm.closeDb()
    } catch {
      // 已关闭则忽略
    }
    globalAny.__GD_SQLITE_FACTORY = undefined
    if (prevFetch === undefined) delete (globalThis as { fetch?: unknown }).fetch
    else globalThis.fetch = prevFetch
    if (prevDataEnv === undefined) delete process.env.PAPERDESK_DATA
    else process.env.PAPERDESK_DATA = prevDataEnv
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// BLOCKS-TOGGLE：结构化解析开关进设置面板（持久化 + 注入侧车 env）。
// ① 真行为：真实 SQLite（__GD_SQLITE_FACTORY → node:sqlite 适配）+ electron 桩，
//    直接跑 src/main/services/settings.ts：默认 false → 写 true 读回 true →
//    设置表落 ai.blocksAdapter='1' → 再写 false 回 false。
// ② 源码契约：manager.ts 在单测进程里被侧车桩替换（见上方 BLOCKS 钩子），
//    spawn env 的注入只能源码断言；设置页 / 解析检查空态 / 设计文档同法锁定。
// ---------------------------------------------------------------------------
async function blocksAdapterSettingTests(): Promise<void> {
  console.log('BLOCKS 开关：设置持久化、侧车注入与面板接线')
  const rootOf = (rel: string): string =>
    fileURLToPath(new URL(rel, import.meta.url)).replace(/\\/g, '/')

  // —— ① 真实设置服务行为 ——
  const globalAny = globalThis as unknown as Record<string, unknown>
  const tmpRoot = mkdtempSync(join(tmpdir(), 'blocks-toggle-'))
  const prevDataEnv = process.env.PAPERDESK_DATA
  const prevFlagEnv = process.env.PAPERDESK_BLOCKS_ADAPTER
  process.env.PAPERDESK_DATA = tmpRoot
  delete process.env.PAPERDESK_BLOCKS_ADAPTER
  let currentAdapter: { raw: any; wrapper: any } | null = null
  let dbm: any = null
  try {
    globalAny.__GD_SQLITE_FACTORY = (): any => {
      currentAdapter = gdMakeSqliteAdapter()
      return currentAdapter.wrapper
    }
    dbm = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/settings.ts', import.meta.url).href)
    dbm.initDb()

    check(
      'BLOCKS：默认关闭（getPublicSettings().blocksAdapter 为 false）',
      svc.getPublicSettings().blocksAdapter === false
    )
    check('BLOCKS：blocksAdapterEnabled() 默认 false', svc.blocksAdapterEnabled() === false)

    const savedOn = svc.savePublicSettings({ blocksAdapter: true })
    check('BLOCKS：写 true 后返回 true', savedOn.blocksAdapter === true)
    check(
      'BLOCKS：写 true 后读回 true（设置服务 + 布尔访问器）',
      svc.getPublicSettings().blocksAdapter === true && svc.blocksAdapterEnabled() === true
    )
    const rowOn = (currentAdapter as { raw: any }).raw
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('ai.blocksAdapter') as { value?: string } | undefined
    check('BLOCKS：设置表落键 ai.blocksAdapter=1', rowOn?.value === '1', JSON.stringify(rowOn))

    const savedOff = svc.savePublicSettings({ blocksAdapter: false })
    check(
      'BLOCKS：写 false 后读回 false',
      savedOff.blocksAdapter === false && svc.blocksAdapterEnabled() === false
    )
    const rowOff = (currentAdapter as { raw: any }).raw
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('ai.blocksAdapter') as { value?: string } | undefined
    check('BLOCKS：设置表落键 ai.blocksAdapter=0', rowOff?.value === '0', JSON.stringify(rowOff))

    // 局部 patch：设置页开关只提交这一个键，不能连带清掉其它设置行
    svc.setRaw('ui.theme', 'dark')
    const only = svc.savePublicSettings({ blocksAdapter: true })
    check(
      'BLOCKS：局部 patch 只改 blocksAdapter（其它设置行保持）',
      only.blocksAdapter === true && svc.getRaw('ui.theme') === 'dark'
    )
  } finally {
    try {
      if (dbm) dbm.closeDb()
    } catch {
      // 已关闭则忽略
    }
    globalAny.__GD_SQLITE_FACTORY = undefined
    if (prevDataEnv === undefined) delete process.env.PAPERDESK_DATA
    else process.env.PAPERDESK_DATA = prevDataEnv
    if (prevFlagEnv === undefined) delete process.env.PAPERDESK_BLOCKS_ADAPTER
    else process.env.PAPERDESK_BLOCKS_ADAPTER = prevFlagEnv
    rmSync(tmpRoot, { recursive: true, force: true })
  }

  // —— ② 源码契约 ——
  const managerSrc = readFileSync(rootOf('../src/main/sidecar/manager.ts'), 'utf8')
  check(
    'BLOCKS：manager.ts 按设置取值（blocksAdapterEnabled）',
    managerSrc.includes('blocksAdapterEnabled')
  )
  check(
    'BLOCKS：manager.ts 出现 PAPERDESK_BLOCKS_ADAPTER',
    managerSrc.includes('PAPERDESK_BLOCKS_ADAPTER')
  )
  check(
    "BLOCKS：manager.ts 只在开启时注入 '1'，绝不注入 '0'",
    /blocksAdapterEnabled\(\)\s*\?\s*\{[^}]*PAPERDESK_BLOCKS_ADAPTER:\s*'1'/.test(managerSrc) &&
      !/PAPERDESK_BLOCKS_ADAPTER:\s*'0'/.test(managerSrc)
  )

  const settingsDlg = readFileSync(
    rootOf('../src/renderer/src/features/settings/SettingsDialog.tsx'),
    'utf8'
  )
  check(
    'BLOCKS：设置页出现「结构化解析」分区与开关',
    settingsDlg.includes('结构化解析') && settingsDlg.includes('data-testid="set-blocks-adapter"')
  )
  check(
    'BLOCKS：设置页切换走 settings.save({ blocksAdapter })',
    settingsDlg.includes('blocksAdapter: next')
  )

  const parsePanel = readFileSync(
    rootOf('../src/renderer/src/features/reader/ParseCheckPanel.tsx'),
    'utf8'
  )
  check('BLOCKS：解析检查空态指向设置面板开关', parsePanel.includes('设置 → 结构化解析'))
  check(
    'BLOCKS：解析检查空态保留环境变量备选',
    parsePanel.includes('PAPERDESK_BLOCKS_ADAPTER')
  )

  const docs = readFileSync(rootOf('../docs/design/blocks-adapter.md'), 'utf8')
  check('BLOCKS：设计文档含「在应用内开启」小节', docs.includes('## 在应用内开启'))
  const typesSrc = readFileSync(rootOf('../src/shared/types.ts'), 'utf8')
  check(
    'BLOCKS：PublicSettings 与 SettingsPatch 都带 blocksAdapter',
    (typesSrc.match(/blocksAdapter\?: boolean/g) ?? []).length >= 2
  )
}
