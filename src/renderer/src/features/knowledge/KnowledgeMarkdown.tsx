import { Children } from 'react'
import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { splitCiteText } from '@shared/cite'

/**
 * 知识库正文渲染（PD50）。
 *
 * 为什么必须走 react-markdown 而不是把字符串塞进 dangerouslySetInnerHTML：
 * 正文是 AI 拆解 / 批处理产物，属于不可信输入；这里用 react-markdown + remark-gfm
 * 的 AST 渲染，**不用** rehype-raw（原始 HTML 一律 `skipHtml` 丢掉），
 * 因此不可能被内容注入脚本。
 *
 * 三条硬约束：
 *  1. 链接只放行 https?/mailto，点击一律 preventDefault 后交主进程 shell.openExternal，
 *     绝不在应用内导航；
 *  2. 图片不加载（远程图片会泄露使用行为、也常是死链），只渲染成一段链接文字；
 *  3. `[p.7, Tab.3]` 这类引用标记渲染成 chip，不把原始标记留在正文里。
 */

/** 只放行外链与邮件；其余（javascript:/file:/相对路径）一律清空 */
const SAFE_URL = /^(?:https?:|mailto:)/iu

const safeUrl = (url: string): string => (SAFE_URL.test(String(url ?? '').trim()) ? url : '')

/** 打开外链：主进程统一走 shell.openExternal（E2E 用 PAPERDESK_E2E_NO_EXTERNAL 记录而不真开浏览器） */
function openExternal(url: string): void {
  try {
    void window.api?.app?.openExternal(url)
  } catch {
    /* 无 preload 的独立渲染场景：静默忽略，不阻断阅读 */
  }
}

/**
 * 纯文本里的引用标记 → chip。
 * 不可识别的写法（如 `[见第 7 页]`）原样保留为文本，不吞字符。
 */
export function CiteText({ text }: { text: string }): React.JSX.Element {
  const segments = splitCiteText(text)
  if (segments.length === 0) return <>{text}</>
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'cite' ? (
          <span
            className="stage-chip stage-chip--cite"
            data-testid="knowledge-cite-chip"
            data-cite={segment.text}
            key={`cite-${index}`}
            title={`引用定位：${segment.text}`}
          >
            {segment.label}
          </span>
        ) : (
          <span key={`text-${index}`}>{segment.text}</span>
        )
      )}
    </>
  )
}

/** 把一段 children 里的纯文本节点换成带 chip 的文本（元素节点原样保留） */
function withCite(children: ReactNode): ReactNode {
  return Children.map(children, (child) =>
    typeof child === 'string' ? <CiteText text={child} /> : child
  )
}

export interface KnowledgeMarkdownProps {
  /** 条目正文（Markdown 源码） */
  source: string
  /** 无正文时的占位文案 */
  placeholder?: string
}

/**
 * 知识库条目正文：标题 / 粗体 / 列表 / 表格 / 行内代码都成文，
 * 表格横向可滚动，引用标记成 chip。
 */
export function KnowledgeMarkdown({
  source,
  placeholder = '（该条目正文为空）'
}: KnowledgeMarkdownProps): React.JSX.Element {
  const text = String(source ?? '')
  if (!text.trim()) {
    return (
      <div className="knowledge-md" data-testid="knowledge-markdown">
        <p className="knowledge-md__empty">{placeholder}</p>
      </div>
    )
  }
  return (
    <div className="knowledge-md" data-testid="knowledge-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrl}
        skipHtml
        components={{
          p: ({ children }) => <p>{withCite(children)}</p>,
          li: ({ children }) => <li>{withCite(children)}</li>,
          td: ({ children }) => <td>{withCite(children)}</td>,
          th: ({ children }) => <th>{withCite(children)}</th>,
          h1: ({ children }) => <h1>{withCite(children)}</h1>,
          h2: ({ children }) => <h2>{withCite(children)}</h2>,
          h3: ({ children }) => <h3>{withCite(children)}</h3>,
          h4: ({ children }) => <h4>{withCite(children)}</h4>,
          h5: ({ children }) => <h5>{withCite(children)}</h5>,
          h6: ({ children }) => <h6>{withCite(children)}</h6>,
          blockquote: ({ children }) => <blockquote>{withCite(children)}</blockquote>,
          strong: ({ children }) => <strong>{withCite(children)}</strong>,
          em: ({ children }) => <em>{withCite(children)}</em>,
          del: ({ children }) => <del>{withCite(children)}</del>,
          // 表格可能比面板宽：外层给一个可横向滚动的容器（CSS 负责 overflow）
          table: ({ children }) => (
            <div className="knowledge-md__tablewrap">
              <table>{children}</table>
            </div>
          ),
          a: ({ href, children, title }) => {
            const url = typeof href === 'string' ? href.trim() : ''
            if (!SAFE_URL.test(url)) return <span className="knowledge-md__link">{children}</span>
            return (
              <a
                className="knowledge-md__link"
                href={url}
                title={typeof title === 'string' && title ? title : url}
                rel="noreferrer noopener"
                onClick={(event) => {
                  event.preventDefault()
                  openExternal(url)
                }}
              >
                {children}
              </a>
            )
          },
          // 图片只当链接文字，不产生 <img>，因此不会发起任何远程请求
          img: ({ src, alt }) => {
            const url = typeof src === 'string' ? src.trim() : ''
            const label = (typeof alt === 'string' ? alt.trim() : '') || url || '（图片）'
            if (!SAFE_URL.test(url)) return <span className="knowledge-md__imglink">{label}</span>
            return (
              <a
                className="knowledge-md__imglink"
                href={url}
                title={url}
                rel="noreferrer noopener"
                onClick={(event) => {
                  event.preventDefault()
                  openExternal(url)
                }}
              >
                {label}
              </a>
            )
          }
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
