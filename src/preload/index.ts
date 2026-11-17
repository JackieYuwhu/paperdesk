import { contextBridge, ipcRenderer } from 'electron'
import { CH, EVT } from '../shared/channels'
import type { PaperdeskApi } from '../shared/api'

const api: PaperdeskApi = {
  library: {
    list: () => ipcRenderer.invoke(CH.library.list),
    get: (id) => ipcRenderer.invoke(CH.library.get, id),
    importPdf: (group) => ipcRenderer.invoke(CH.library.importPdf, group),
    importPdfs: (group) => ipcRenderer.invoke(CH.library.importPdfs, group),
    importFolder: (group) => ipcRenderer.invoke(CH.library.importFolder, group),
    importFromUrl: (input, group) => ipcRenderer.invoke(CH.library.importFromUrl, input, group),
    importManyFromUrls: (text, group) =>
      ipcRenderer.invoke(CH.library.importManyFromUrls, text, group),
    addMetadata: (input) => ipcRenderer.invoke(CH.library.addMetadata, input),
    rename: (itemId, title) => ipcRenderer.invoke(CH.library.rename, itemId, title),
    delete: (itemId) => ipcRenderer.invoke(CH.library.delete, itemId),
    setGroup: (itemId, group) => ipcRenderer.invoke(CH.library.setGroup, itemId, group),
    setGroupMany: (itemIds, group) => ipcRenderer.invoke(CH.library.setGroupMany, itemIds, group),
    listGroups: () => ipcRenderer.invoke(CH.library.listGroups),
    createGroup: (name, parent) => ipcRenderer.invoke(CH.library.createGroup, name, parent),
    getGroup: (name) => ipcRenderer.invoke(CH.library.getGroup, name),
    updateGroup: (name, patch) => ipcRenderer.invoke(CH.library.updateGroup, name, patch),
    deleteGroup: (name, options) => ipcRenderer.invoke(CH.library.deleteGroup, name, options),
    listTags: () => ipcRenderer.invoke(CH.library.listTags),
    tagsForItems: (itemIds) => ipcRenderer.invoke(CH.library.tagsForItems, itemIds),
    setTags: (itemId, names) => ipcRenderer.invoke(CH.library.setTags, itemId, names),
    enrich: (itemId) => ipcRenderer.invoke(CH.library.enrich, itemId)
  },
  attachments: {
    listByItem: (itemId) => ipcRenderer.invoke(CH.attachments.listByItem, itemId),
    readBytes: (id) => ipcRenderer.invoke(CH.attachments.readBytes, id),
    getByKey: (key) => ipcRenderer.invoke(CH.attachments.getByKey, key),
    getByPath: (path) => ipcRenderer.invoke(CH.attachments.getByPath, path)
  },
  reader: {
    pageThumbs: (attachmentId: number, pages?: number[]) =>
      ipcRenderer.invoke(CH.reader.pageThumbs, attachmentId, pages),
    deletePages: (attachmentId: number, pages: number[]) =>
      ipcRenderer.invoke(CH.reader.deletePages, attachmentId, pages),
    pageEdits: (attachmentId: number) => ipcRenderer.invoke(CH.reader.pageEdits, attachmentId),
    restorePageEdit: (versionId: number) =>
      ipcRenderer.invoke(CH.reader.restorePageEdit, versionId),
    listAnnotations: (attachmentId) =>
      ipcRenderer.invoke(CH.reader.listAnnotations, attachmentId),
    figures: (attachmentId) => ipcRenderer.invoke(CH.reader.figures, attachmentId),
    modules: (attachmentId) => ipcRenderer.invoke(CH.reader.modules, attachmentId),
    formulas: (attachmentId) => ipcRenderer.invoke(CH.reader.formulas, attachmentId),
    saveModuleLatex: (attachmentId, moduleId, latex, source, validation) =>
      ipcRenderer.invoke(CH.reader.saveModuleLatex, attachmentId, moduleId, latex, source, validation),
    figureImage: (attachmentId, page, rect, scale) =>
      ipcRenderer.invoke(CH.reader.figureImage, attachmentId, page, rect, scale),
    createAnnotation: (payload) => ipcRenderer.invoke(CH.reader.createAnnotation, payload),
    deleteAnnotation: (id) => ipcRenderer.invoke(CH.reader.deleteAnnotation, id)
  },
  notes: {
    listByItem: (itemId) => ipcRenderer.invoke(CH.notes.listByItem, itemId),
    getForItem: (itemId) => ipcRenderer.invoke(CH.notes.getForItem, itemId),
    getByPath: (path) => ipcRenderer.invoke(CH.notes.getByPath, path),
    create: (itemId, title) => ipcRenderer.invoke(CH.notes.create, itemId, title),
    save: (id, body) => ipcRenderer.invoke(CH.notes.save, id, body),
    delete: (id) => ipcRenderer.invoke(CH.notes.delete, id),
    addAnnotation: (itemId, annotationId) =>
      ipcRenderer.invoke(CH.notes.addAnnotation, itemId, annotationId)
  },
  mindmap: {
    load: (itemId) => ipcRenderer.invoke(CH.mindmap.load, itemId),
    save: (itemId, doc) => ipcRenderer.invoke(CH.mindmap.save, itemId, doc),
    summarize: (itemId, nodeId) => ipcRenderer.invoke(CH.mindmap.summarize, itemId, nodeId),
    expand: (itemId, nodeId) => ipcRenderer.invoke(CH.mindmap.expand, itemId, nodeId),
    findSupport: (itemId, nodeId) => ipcRenderer.invoke(CH.mindmap.findSupport, itemId, nodeId),
    optimize: (itemId, nodeId) => ipcRenderer.invoke(CH.mindmap.optimize, itemId, nodeId),
    optimizeMap: (itemId) => ipcRenderer.invoke(CH.mindmap.optimizeMap, itemId),
    syncDigest: (input) => ipcRenderer.invoke(CH.mindmap.syncDigest, input),
    export: (itemId, format, doc) =>
      ipcRenderer.invoke(CH.mindmap.export, itemId, format, doc),
    loadScope: (scope) => ipcRenderer.invoke(CH.mindmap.loadScope, scope),
    openPaper: (itemId) => ipcRenderer.invoke(CH.mindmap.openPaper, itemId)
  },
  metadata: {
    extract: (attachmentId, opts) => ipcRenderer.invoke(CH.metadata.extract, attachmentId, opts),
    structure: (attachmentId) => ipcRenderer.invoke(CH.metadata.structure, attachmentId),
    get: (itemId) => ipcRenderer.invoke(CH.metadata.get, itemId)
  },
  discovery: {
    graph: (itemId, source, query, sort) =>
      ipcRenderer.invoke(CH.discovery.graph, itemId, source, query, sort),
    cached: (itemId) => ipcRenderer.invoke(CH.discovery.cached, itemId),
    diagnose: (itemId) => ipcRenderer.invoke(CH.discovery.diagnose, itemId)
  },
  works: {
    search: (query, opts) => ipcRenderer.invoke(CH.works.search, query, opts),
    savePdf: (url, name) => ipcRenderer.invoke(CH.works.savePdf, url, name),
    citation: (itemId) => ipcRenderer.invoke(CH.works.citation, itemId),
    citationQuery: (itemId, opts) => ipcRenderer.invoke(CH.works.citationQuery, itemId, opts),
    openScholar: (query) => ipcRenderer.invoke(CH.works.openScholar, query)
  },
  publication: {
    get: (itemId) => ipcRenderer.invoke(CH.publication.get, itemId),
    enrich: (itemId, opts) => ipcRenderer.invoke(CH.publication.enrich, itemId, opts),
    save: (itemId, patch) => ipcRenderer.invoke(CH.publication.save, itemId, patch)
  },
  survey: {
    run: (opts) => ipcRenderer.invoke(CH.survey.run, opts)
  },
  translate: {
    run: (attachmentId, opts) => ipcRenderer.invoke(CH.translate.run, attachmentId, opts),
    retranslatePage: (id, page) =>
      ipcRenderer.invoke(CH.translate.retranslatePage, id, page),
    cancel: (requestId) => ipcRenderer.invoke(CH.translate.cancel, requestId),
    get: (attachmentId, lang) => ipcRenderer.invoke(CH.translate.get, attachmentId, lang),
    history: (attachmentId, lang) => ipcRenderer.invoke(CH.translate.history, attachmentId, lang),
    getById: (id) => ipcRenderer.invoke(CH.translate.getById, id),
    remove: (id, removeFiles) => ipcRenderer.invoke(CH.translate.remove, id, removeFiles),
    prune: (attachmentId, lang, keep) => ipcRenderer.invoke(CH.translate.prune, attachmentId, lang, keep),
    setPinned: (id, pinned) => ipcRenderer.invoke(CH.translate.setPinned, id, pinned),
    previewPrune: (attachmentId, lang, keep) =>
      ipcRenderer.invoke(CH.translate.previewPrune, attachmentId, lang, keep),
    rollback: (id) => ipcRenderer.invoke(CH.translate.rollback, id),
    readMarkdown: (id, which) => ipcRenderer.invoke(CH.translate.readMarkdown, id, which),
    orphans: () => ipcRenderer.invoke(CH.translate.orphans),
    cleanOrphans: (names) => ipcRenderer.invoke(CH.translate.cleanOrphans, names),
    saveReport: (defaultName, content) =>
      ipcRenderer.invoke(CH.translate.saveReport, defaultName, content),
    getByPath: (path) => ipcRenderer.invoke(CH.translate.getByPath, path),
    diagnose: (attachmentId) => ipcRenderer.invoke(CH.translate.diagnose, attachmentId),
    read: (translationId) => ipcRenderer.invoke(CH.translate.read, translationId),
    map: (translationId) => ipcRenderer.invoke(CH.translate.map, translationId),
    readHtml: (translationId) => ipcRenderer.invoke(CH.translate.readHtml, translationId),
    readHtmlMarked: (translationId, query) =>
      ipcRenderer.invoke(CH.translate.readHtmlMarked, translationId, query),
    readBilingual: (translationId) => ipcRenderer.invoke(CH.translate.readBilingual, translationId),
    readBilingualMarked: (translationId, query) =>
      ipcRenderer.invoke(CH.translate.readBilingualMarked, translationId, query),
    openHtml: (translationId) => ipcRenderer.invoke(CH.translate.openHtml, translationId),
    saveHtml: (translationId) => ipcRenderer.invoke(CH.translate.saveHtml, translationId),
    saveMarkdown: (translationId, which) =>
      ipcRenderer.invoke(CH.translate.saveMarkdown, translationId, which),
    exportToNote: (translationId, which) =>
      ipcRenderer.invoke(CH.translate.exportToNote, translationId, which),
    exportZip: (translationId) => ipcRenderer.invoke(CH.translate.exportZip, translationId),
    archiveAll: (translationId) => ipcRenderer.invoke(CH.translate.archiveAll, translationId),
    exportQa: (translationId) => ipcRenderer.invoke(CH.translate.exportQa, translationId),
    exportQaToNote: (translationId) =>
      ipcRenderer.invoke(CH.translate.exportQaToNote, translationId),
    saveSnapshot: (translationId, query, theme, kind) =>
      ipcRenderer.invoke(CH.translate.saveSnapshot, translationId, query, theme, kind),
    text: (text, lang) => ipcRenderer.invoke(CH.translate.text, text, lang)
  },
  system: {
    health: () => ipcRenderer.invoke(CH.system.health),
    testProvider: () => ipcRenderer.invoke(CH.system.testProvider)
  },
  search: {
    query: (text, limit) => ipcRenderer.invoke(CH.search.query, text, limit),
    index: (attachmentId) => ipcRenderer.invoke(CH.search.index, attachmentId)
  },
  ai: {
    ask: (question, opts) => ipcRenderer.invoke(CH.ai.ask, question, opts),
    askStream: (question, opts, onDelta) => {
      const listener = (_e: unknown, payload: { streamId?: string; delta?: string }): void => {
        if (payload && payload.streamId === opts?.streamId) onDelta(payload.delta ?? '')
      }
      ipcRenderer.on(EVT.aiStream, listener)
      return ipcRenderer
        .invoke(CH.ai.askStream, question, opts)
        .finally(() => ipcRenderer.removeListener(EVT.aiStream, listener))
    },
    formula: (imageB64, mime) => ipcRenderer.invoke(CH.ai.formula, imageB64, mime),
    table: (imageB64, mime) => ipcRenderer.invoke(CH.ai.table, imageB64, mime),
    formulaCandidates: (imageB64, rawText) =>
      ipcRenderer.invoke(CH.ai.formulaCandidates, imageB64, rawText),
    latex: (text) => ipcRenderer.invoke(CH.ai.latex, text),
    listConversations: (limit) => ipcRenderer.invoke(CH.ai.listConversations, limit),
    getConversation: (id) => ipcRenderer.invoke(CH.ai.getConversation, id),
    createConversation: (input) => ipcRenderer.invoke(CH.ai.createConversation, input),
    appendMessage: (conversationId, msg) =>
      ipcRenderer.invoke(CH.ai.appendMessage, conversationId, msg),
    renameConversation: (id, title) => ipcRenderer.invoke(CH.ai.renameConversation, id, title),
    deleteConversation: (id) => ipcRenderer.invoke(CH.ai.deleteConversation, id),
    generateTitle: (id, force) => ipcRenderer.invoke(CH.ai.generateTitle, id, force),
    findPapers: (question, opts) => ipcRenderer.invoke(CH.ai.findPapers, question, opts),
    cancel: (requestId) => ipcRenderer.invoke(CH.ai.cancel, requestId),
    onProgress: (cb) => {
      const listener = (_e: unknown, p: { requestId?: string } & Record<string, unknown>): void => {
        cb(p as never)
      }
      ipcRenderer.on(EVT.aiProgress, listener)
      return () => ipcRenderer.removeListener(EVT.aiProgress, listener)
    }
  },
  settings: {
    get: () => ipcRenderer.invoke(CH.settings.get),
    save: (patch) => ipcRenderer.invoke(CH.settings.save, patch),
    exportFile: () => ipcRenderer.invoke(CH.settings.export),
    importFile: () => ipcRenderer.invoke(CH.settings.import),
    webSearchGet: () => ipcRenderer.invoke(CH.settings.webSearchGet),
    webSearchSet: (mode) => ipcRenderer.invoke(CH.settings.webSearchSet, mode),
    strictEvidenceGet: () => ipcRenderer.invoke(CH.settings.strictEvidenceGet),
    strictEvidenceSet: (on) => ipcRenderer.invoke(CH.settings.strictEvidenceSet, on),
    knowledgeStatus: () => ipcRenderer.invoke(CH.settings.knowledgeStatus)
  },
  knowledge: {
    createBatch: (input) => ipcRenderer.invoke(CH.knowledge.batchCreate, input),
    listBatches: (limit) => ipcRenderer.invoke(CH.knowledge.batchList, limit),
    getBatch: (batchId) => ipcRenderer.invoke(CH.knowledge.batchGet, batchId),
    createProposal: (batchId, input) =>
      ipcRenderer.invoke(CH.knowledge.proposalCreate, batchId, input),
    listProposals: (filter) => ipcRenderer.invoke(CH.knowledge.proposalList, filter),
    getProposal: (proposalId) => ipcRenderer.invoke(CH.knowledge.proposalGet, proposalId),
    acceptProposal: (proposalId, reason) =>
      ipcRenderer.invoke(CH.knowledge.proposalAccept, proposalId, reason),
    rejectProposal: (proposalId, reason) =>
      ipcRenderer.invoke(CH.knowledge.proposalReject, proposalId, reason),
    editAndAccept: (proposalId, patch) =>
      ipcRenderer.invoke(CH.knowledge.proposalEditAccept, proposalId, patch),
    listEntries: (filter) => ipcRenderer.invoke(CH.knowledge.entryList, filter),
    getEntry: (entryId) => ipcRenderer.invoke(CH.knowledge.entryGet, entryId),
    publishBatch: (batchId, proposalIds) =>
      ipcRenderer.invoke(CH.knowledge.publishBatch, { batchId, proposalIds }),
    syncDigest: (input) => ipcRenderer.invoke(CH.knowledge.digestSync, input),
    noteImport: (input) => ipcRenderer.invoke(CH.knowledge.noteImport, input),
    translationImport: (input) =>
      ipcRenderer.invoke(CH.knowledge.translationImport, input),
    batchPapers: (batchId) => ipcRenderer.invoke(CH.knowledge.batchPapers, batchId),
    batchSync: (input) => ipcRenderer.invoke(CH.knowledge.batchSync, input)
  },
  data: {
    backupDir: () => ipcRenderer.invoke(CH.data.backupDir),
    backup: () => ipcRenderer.invoke(CH.data.backup),
    restore: () => ipcRenderer.invoke(CH.data.restore),
    backupTo: (dest) => ipcRenderer.invoke(CH.data.backupTo, dest),
    restoreFrom: (src) => ipcRenderer.invoke(CH.data.restoreFrom, src),
    testFault: () => ipcRenderer.invoke(CH.data.testFault)
  },
  batch: {
    tasks: () => ipcRenderer.invoke(CH.batch.tasks),
    create: (input) => ipcRenderer.invoke(CH.batch.create, input),
    list: () => ipcRenderer.invoke(CH.batch.list),
    items: (jobId) => ipcRenderer.invoke(CH.batch.items, jobId),
    cancel: (jobId) => ipcRenderer.invoke(CH.batch.cancel, jobId),
    remove: (jobId) => ipcRenderer.invoke(CH.batch.remove, jobId),
    openOutput: (jobId) => ipcRenderer.invoke(CH.batch.openOutput, jobId),
    status: () => ipcRenderer.invoke(CH.batch.status),
    estimate: (input) => ipcRenderer.invoke(CH.batch.estimate, input),
    retryFailed: (jobId) => ipcRenderer.invoke(CH.batch.retryFailed, jobId),
    retryAllFailed: () => ipcRenderer.invoke(CH.batch.retryAllFailed),
    startPending: () => ipcRenderer.invoke(CH.batch.startPending),
    runOnce: (taskId, target, params) =>
      ipcRenderer.invoke(CH.batch.runOnce, taskId, target, params)
  },
  organize: {
    preview: (request) => ipcRenderer.invoke(CH.organize.preview, request),
    apply: (drafts, opts) => ipcRenderer.invoke(CH.organize.apply, drafts, opts),
    versions: (scopeKey) => ipcRenderer.invoke(CH.organize.versions, scopeKey),
    restore: (versionId) => ipcRenderer.invoke(CH.organize.restore, versionId),
    candidates: () => ipcRenderer.invoke(CH.organize.candidates)
  },
  app: {
    openExternal: (url) => ipcRenderer.invoke(CH.app.openExternal, url),
    copyText: (text) => ipcRenderer.invoke(CH.app.copyText, text)
  },
  journals: {
    summarize: (journalId) => ipcRenderer.invoke(CH.journals.summarize, journalId)
  },
  analysis: {
    run: (opts) => ipcRenderer.invoke(CH.analysis.run, opts),
    compare: (opts) => ipcRenderer.invoke(CH.analysis.compare, opts),
    getSkill: (name) => ipcRenderer.invoke(CH.analysis.getSkill, name),
    saveSkill: (text, name) => ipcRenderer.invoke(CH.analysis.saveSkill, text, name),
    resetSkill: (name) => ipcRenderer.invoke(CH.analysis.resetSkill, name),
    listSkills: () => ipcRenderer.invoke(CH.analysis.listSkills),
    copySkill: (from, to) => ipcRenderer.invoke(CH.analysis.copySkill, from, to),
    deleteSkill: (name) => ipcRenderer.invoke(CH.analysis.deleteSkill, name)
  },
  files: {
    list: (path) => ipcRenderer.invoke(CH.files.list, path),
    open: (path) => ipcRenderer.invoke(CH.files.open, path),
    reveal: (path) => ipcRenderer.invoke(CH.files.reveal, path),
    vscode: (path) => ipcRenderer.invoke(CH.files.vscode, path)
  },
  authors: {
    search: (query, limit) => ipcRenderer.invoke(CH.authors.search, query, limit),
    forItem: (itemId) => ipcRenderer.invoke(CH.authors.forItem, itemId),
    forItemLocal: (itemId) => ipcRenderer.invoke(CH.authors.forItemLocal, itemId),
    forItemsLocal: (itemIds) => ipcRenderer.invoke(CH.authors.forItemsLocal, itemIds),
    profile: (id) => ipcRenderer.invoke(CH.authors.profile, id),
    link: (input) => ipcRenderer.invoke(CH.authors.link, input),
    cleanup: () => ipcRenderer.invoke(CH.authors.cleanup),
    importByOrcid: (orcidText) => ipcRenderer.invoke(CH.authors.importByOrcid, orcidText)
  },
  biblio: {
    get: (kind, limit) => ipcRenderer.invoke(CH.biblio.get, kind, limit),
    export: (kind, format) => ipcRenderer.invoke(CH.biblio.export, kind, format)
  },
  connector: {
    status: () => ipcRenderer.invoke(CH.connector.status),
    setEnabled: (enabled) => ipcRenderer.invoke(CH.connector.setEnabled, enabled)
  },
  skills: {
    list: () => ipcRenderer.invoke(CH.skills.list),
    save: (id, system, skip, scope) => ipcRenderer.invoke(CH.skills.save, id, system, skip, scope),
    reset: () => ipcRenderer.invoke(CH.skills.reset),
    exportFile: () => ipcRenderer.invoke(CH.skills.export),
    importFile: () => ipcRenderer.invoke(CH.skills.import),
    applyImport: (force, only) => ipcRenderer.invoke(CH.skills.applyImport, force, only)
  },
  aiTools: {
    list: () => ipcRenderer.invoke(CH.aiTools.list),
    update: (input) => ipcRenderer.invoke(CH.aiTools.update, input),
    reset: () => ipcRenderer.invoke(CH.aiTools.reset)
  },
  onDeepLink: (cb) => {
    const listener = (_e: unknown, url: string): void => cb(url)
    ipcRenderer.on(EVT.deeplink, listener)
    return () => ipcRenderer.removeListener(EVT.deeplink, listener)
  },
  onTranslateProgress: (cb) => {
    const listener = (_e: unknown, p: unknown): void => cb(p as never)
    ipcRenderer.on(EVT.translateProgress, listener)
    return () => ipcRenderer.removeListener(EVT.translateProgress, listener)
  },
  onBatchProgress: (cb) => {
    const listener = (_e: unknown, p: unknown): void => cb(p as never)
    ipcRenderer.on(EVT.batchProgress, listener)
    return () => ipcRenderer.removeListener(EVT.batchProgress, listener)
  },
  onLibraryChanged: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on(EVT.libraryChanged, listener)
    return () => ipcRenderer.removeListener(EVT.libraryChanged, listener)
  },
  onKnowledgeChanged: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on(EVT.knowledgeChanged, listener)
    return () => ipcRenderer.removeListener(EVT.knowledgeChanged, listener)
  },
  onAiToolsChanged: (cb) => {
    const listener = (_e: unknown, p: unknown): void => cb(p as never)
    ipcRenderer.on(EVT.aiToolsChanged, listener)
    return () => ipcRenderer.removeListener(EVT.aiToolsChanged, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
