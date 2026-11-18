import { useEffect, useState } from 'react'
import type { ArticleTerm } from '@shared/glossary'

export function GlossaryPanel({ attachmentId }: { attachmentId: number | null }): React.JSX.Element {
  const [terms, setTerms] = useState<ArticleTerm[]>([])
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<number | undefined>()
  const [term, setTerm] = useState(''), [sense, setSense] = useState(''), [translation, setTranslation] = useState(''), [context, setContext] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    let stopped = false
    setTerms([]); setError(''); setEditing(undefined); setTerm(''); setSense(''); setTranslation(''); setContext('')
    if (attachmentId != null) void window.api.translate.glossary(attachmentId).then((v) => { if (!stopped) setTerms(v) }).catch((e) => { if (!stopped) setError(String(e)) })
    return () => { stopped = true }
  }, [attachmentId])
  const reset = (): void => { setEditing(undefined); setTerm(''); setSense(''); setTranslation(''); setContext('') }
  if (attachmentId == null) return <div className="panel">请先打开一篇论文。</div>
  const run = async (action: () => Promise<ArticleTerm[]>): Promise<void> => {
    setBusy(true); setError('')
    try { setTerms(await action()) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  return <section className="panel glossary-panel" data-testid="article-glossary">
    <p>本文术语库 · A–Z。翻译优先匹配词义；用户保存的译法会锁定。模型及联网建议需要核对。</p>
    <button disabled={busy} onClick={() => void run(() => window.api.translate.prepareGlossary(attachmentId))}>{busy ? '正在处理…' : '提取术语并联网查译名'}</button>
    <small>将使用已配置的模型及联网检索。已有术语保留；修改后可用“重译本页”应用译法。</small>
    {error && <p role="alert">{error}</p>}
    <input aria-label="搜索术语" placeholder="搜索原词、译法或词义" value={query} onChange={(e) => setQuery(e.target.value)} />
    <form onSubmit={(e) => { e.preventDefault(); void run(async () => {
      const result = await window.api.translate.saveTerm({ id: editing, attachmentId, term, sense, translation, context, locked: true }); reset(); return result
    }) }}>
      <input required aria-label="原词或词组" placeholder="原词或词组" value={term} onChange={(e) => setTerm(e.target.value)} />
      <input aria-label="词义与领域" placeholder="词义与领域，如优化算法中的候选集合" value={sense} onChange={(e) => setSense(e.target.value)} />
      <input required aria-label="首选译法" placeholder="首选译法" value={translation} onChange={(e) => setTranslation(e.target.value)} />
      <textarea aria-label="适用上下文" placeholder="适用语境或论文例句（可选）" value={context} onChange={(e) => setContext(e.target.value)} />
      <div><button disabled={busy} type="submit">{editing == null ? '添加并锁定' : '保存并锁定'}</button> <button type="button" onClick={reset}>清空</button></div>
    </form>
    {terms.filter((e) => `${e.term} ${e.sense} ${e.translation}`.toLowerCase().includes(query.toLowerCase())).map((e) => <article key={e.id}>
      <strong>{e.term}</strong> → {e.translation}<p>{e.sense}</p><small>{e.context}</small>
      <p>{e.locked ? '用户锁定' : e.source === 'web' ? '联网参考 · 待确认' : '模型建议 · 待确认'}{e.sourceUrl && <button onClick={() => void window.api.app.openExternal(e.sourceUrl)}>查看来源</button>}</p>
      <button disabled={busy} onClick={() => { setEditing(e.id); setTerm(e.term); setSense(e.sense); setTranslation(e.translation); setContext(e.context) }}>编辑</button>
      <button disabled={busy} onClick={() => void run(() => window.api.translate.removeTerm(attachmentId, e.id))}>删除</button>
    </article>)}
    {!terms.length && <p>尚无术语。可以手动添加，或提取本文专有词汇。</p>}
  </section>
}
