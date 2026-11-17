import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Icon } from '../../components/Icon'
import { JOURNALS, type Journal } from '@shared/journals'
import type { Item } from '@shared/types'

/** 统计英文词数 / 中文按字数（粗略，用于对照参考上限） */
function countWords(s: string): number {
  const t = (s ?? '').trim()
  if (!t) return 0
  const cjk = (t.match(/[\u4e00-\u9fff]/g) ?? []).length
  if (cjk >= t.length * 0.3) return cjk
  return t.split(/\s+/).filter(Boolean).length
}

/** 论文文本（标题 + 摘要 + 期刊/会议）用于关键词匹配 */
function paperText(it: Item | null): string {
  if (!it) return ''
  return [it.title ?? '', it.abstract ?? '', it.venue ?? ''].join(' ').toLowerCase()
}

function matches(j: Journal, text: string): string[] {
  if (!text) return []
  return j.keywords.filter((k) => text.includes(k))
}

/** 研究 → 期刊：常见期刊/会议「简介 + 投稿要求要点」速查 */
export function JournalsPanel({ itemId }: { itemId: number | null }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [item, setItem] = useState<Item | null>(null)

  useEffect(() => {
    let cancelled = false
    if (itemId == null) {
      setItem(null)
      return
    }
    void window.api.library
      .get(itemId)
      .then((it) => {
        if (!cancelled) setItem(it)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [itemId])

  const text = useMemo(() => paperText(item), [item])

  const recommended = useMemo(() => {
    if (!text) return []
    return JOURNALS.map((j) => ({ j, hits: matches(j, text) }))
      .filter((x) => x.hits.length > 0)
      .sort((a, b) => b.hits.length - a.hits.length)
      .slice(0, 5)
  }, [text])

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return JOURNALS
    return JOURNALS.filter((j) =>
      [j.name, j.nameZh ?? '', j.publisher, j.scope, j.standing, j.keywords.join(' ')]
        .join(' ')
        .toLowerCase()
        .includes(q)
    )
  }, [query])

  const selected = JOURNALS.find((j) => j.id === selectedId) ?? null
  if (selected) {
    return <JournalDetail j={selected} item={item} onBack={() => setSelectedId(null)} />
  }

  return (
    <div className="panel">
      {item && recommended.length > 0 && (
        <>
          <h4 className="journals__h" style={{ margin: '10px 12px 6px' }}>
            按当前论文推荐（{item.title ?? ''}）
          </h4>
          <ul className="journals__list" data-testid="journals-recommend">
            {recommended.map(({ j, hits }) => (
              <li key={`rec-${j.id}`}>
                <button
                  className="journals__row"
                  data-testid={`journal-rec-${j.id}`}
                  onClick={() => setSelectedId(j.id)}
                >
                  <div className="journals__row-main">
                    <div className="journals__name">
                      {j.name}
                      <span className="journals__tag">{hits.length} 项匹配</span>
                    </div>
                    <div className="journals__sub meta__muted">匹配：{hits.slice(0, 6).join('、')}</div>
                  </div>
                  <Icon name="right" size={14} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="journals__search">
        <Icon name="search" size={13} />
        <input
          value={query}
          placeholder="搜索期刊 / 会议（名称、出版社、领域、关键词）"
          data-testid="journals-search"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <p className="modal__hint" style={{ margin: '0 12px 6px' }}>
        共 {list.length} 条 · 点击查看「简介 + 投稿要求要点」（<b>具体要求以官网作者指南为准</b>）
      </p>
      <ul className="journals__list" data-testid="journals-list">
        {list.map((j) => (
          <li key={j.id}>
            <button
              className="journals__row"
              data-testid={`journal-row-${j.id}`}
              onClick={() => setSelectedId(j.id)}
              title="查看简介与投稿要求"
            >
              <div className="journals__row-main">
                <div className="journals__name">
                  {j.name}
                  {j.nameZh ? <span className="meta__muted">（{j.nameZh}）</span> : null}
                  <span className={`journals__tag ${j.kind === 'conference' ? 'is-conf' : ''}`}>
                    {j.kind === 'conference' ? '会议' : '期刊'}
                  </span>
                </div>
                <div className="journals__sub meta__muted">
                  {j.publisher} · {j.scope}
                </div>
              </div>
              <Icon name="right" size={14} />
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="list__hint">没有匹配的结果</li>}
      </ul>
    </div>
  )
}

const REQ_LABEL: Array<[keyof Journal['requirements'], string]> = [
  ['language', '语言/写作'],
  ['length', '篇幅惯例'],
  ['abstract', '摘要'],
  ['references', '参考文献'],
  ['figures', '图表/补充材料'],
  ['dataCode', '数据与代码'],
  ['apc', '开放获取/费用'],
  ['review', '审稿与周期']
]

function JournalDetail({
  j,
  item,
  onBack
}: {
  j: Journal
  item: Item | null
  onBack: () => void
}): React.JSX.Element {
  const [ai, setAi] = useState<{ text: string; backend: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  const runAi = async (): Promise<void> => {
    setBusy(true)
    setNote('')
    try {
      setAi(await window.api.journals.summarize(j.id))
    } catch (e) {
      setNote('AI 生成失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  const copyChecklist = async (): Promise<void> => {
    const body = ai?.text ?? j.tips.map((t) => `- [ ] ${t}`).join('\n')
    await window.api.app.copyText(`# ${j.name} 投稿 checklist\n\n${body}\n\n官网：${j.guideUrl}\n`)
    setNote('已复制到剪贴板')
  }

  const absWords = item?.abstract ? countWords(item.abstract) : null
  const limits = j.limits

  return (
    <div className="panel">
      <div className="journals__head">
        <button className="icon ghost" title="返回列表" onClick={onBack} data-testid="journal-back">
          <Icon name="left" size={15} />
        </button>
        <span className="sidebar__title">
          {j.name}
          {j.nameZh ? ` · ${j.nameZh}` : ''}
        </span>
      </div>
      <div className="journals__body" data-testid="journal-detail">
        <div className="meta__muted" style={{ marginBottom: 8 }}>
          {j.kind === 'conference' ? '会议' : '期刊'} · {j.publisher}
        </div>
        <p className="journals__p">
          <b>简介：</b>
          {j.scope}
        </p>
        <p className="journals__p">
          <b>定位：</b>
          {j.standing}
        </p>

        <h4 className="journals__h">投稿要求要点</h4>
        <dl className="journals__reqs">
          {REQ_LABEL.map(([key, label]) => (
            <div key={key} className="journals__req">
              <dt>{label}</dt>
              <dd>{j.requirements[key]}</dd>
            </div>
          ))}
        </dl>

        {(limits || item) && (
          <>
            <h4 className="journals__h">与当前论文对照</h4>
            <ul className="journals__tips" data-testid="journal-check">
              {limits?.abstractWords != null && (
                <li>
                  摘要参考上限约 <b>{limits.abstractWords}</b> 词
                  {absWords != null && (
                    <>
                      ；当前论文摘要 <b>{absWords}</b> 词
                      {absWords > limits.abstractWords ? ' ⚠️ 超出，需要压缩' : ' ✅ 在范围内'}
                    </>
                  )}
                </li>
              )}
              {limits?.mainTextPages != null && (
                <li>
                  正文参考上限约 <b>{limits.mainTextPages}</b> 页
                  {limits.note ? `（${limits.note}）` : ''}
                </li>
              )}
              {!limits && (
                <li className="meta__muted">该刊未设定固定数值上限；请按官方指南核对页数/字数/图表数。</li>
              )}
              <li className="meta__muted">
                以上为<b>参考值</b>，最终以官网为准；摘要词数为本地粗略统计。
              </li>
            </ul>
          </>
        )}

        {j.tips.length > 0 && (
          <>
            <h4 className="journals__h">常见要求 / 易踩坑</h4>
            <ul className="journals__tips">
              {j.tips.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </>
        )}

        <div className="journals__actions">
          <button
            className="primary"
            data-testid="journal-guide"
            onClick={() => void window.api.app.openExternal(j.guideUrl)}
          >
            <Icon name="external" size={13} />
            打开作者指南
          </button>
          <button data-testid="journal-home" onClick={() => void window.api.app.openExternal(j.homeUrl)}>
            <Icon name="external" size={13} />
            期刊主页
          </button>
          <button
            data-testid="journal-ai"
            disabled={busy}
            onClick={() => void runAi()}
            title="用模型把要点整理成「摘要 + 投稿 checklist」"
          >
            <Icon name="sparkles" size={13} />
            {busy ? '生成中…' : 'AI 概括要求'}
          </button>
          <button data-testid="journal-copy" onClick={() => void copyChecklist()}>
            <Icon name="check" size={13} />
            复制 checklist
          </button>
        </div>

        {note && (
          <p className="modal__hint" style={{ marginTop: 8 }}>
            {note}
          </p>
        )}

        {ai && (
          <div className="journals__ai" data-testid="journal-ai-result">
            {ai.backend !== 'openai' && (
              <div className="modal__hint" style={{ marginBottom: 6 }}>
                当前为<b>离线占位</b>（未调用模型）：在「设置 → 模型服务」配置后可生成更贴合的版本。
              </div>
            )}
            <div className="journals__ai-md">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                urlTransform={(u) => u}
                components={{
                  a: ({ href, children }) => (
                    <a
                      href={href}
                      onClick={(e) => {
                        e.preventDefault()
                        if (href) void window.api.app.openExternal(href)
                      }}
                    >
                      {children}
                    </a>
                  )
                }}
              >
                {ai.text}
              </ReactMarkdown>
            </div>
            <p className="modal__hint" style={{ marginTop: 6 }}>
              ⚠️ AI 生成内容可能不准确或过时，<b>务必以官网 Author Guidelines 为准</b>。
            </p>
          </div>
        )}

        <p className="modal__hint" style={{ marginTop: 10 }}>
          以上为通用要点速查，<b>字数上限、格式模板、伦理/数据声明等以官网 Author Guidelines 为准</b>。
        </p>
      </div>
    </div>
  )
}
