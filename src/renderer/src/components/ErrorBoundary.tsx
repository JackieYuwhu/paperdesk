import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** 变更时自动重置错误（例如切换面板/附件后自动恢复） */
  resetKey?: unknown
  /** 出错时显示的标题 */
  label?: string
}

interface State {
  error: Error | null
}

/**
 * 错误边界：把「某个子树渲染抛异常」限制在局部。
 *
 * 目的：即使真有渲染 bug，也**不会整页白屏**——只在该面板/阅读器位置显示
 * 「出错了 + 重试/重新加载」，并把错误写进控制台日志便于排查。
 * （注意：错误边界只能捕获渲染/生命周期里的异常，捕获不到事件回调与异步错误；
 *   后者由 main.tsx 的全局监听负责记录。）
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui] 渲染出错:', error, info.componentStack)
  }

  componentDidUpdate(prev: Props): void {
    // 外部上下文变了（切面板/换附件）→ 自动清除错误，给一次自愈机会
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  private retry = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="errbox" data-testid="error-boundary">
        <div className="errbox__title">{this.props.label ?? '出错了'}</div>
        <div className="errbox__msg">{String(this.state.error.message || this.state.error)}</div>
        <div className="errbox__actions">
          <button className="primary" onClick={this.retry} data-testid="error-retry">
            重试
          </button>
          <button onClick={() => window.location.reload()} data-testid="error-reload">
            重新加载
          </button>
        </div>
      </div>
    )
  }
}
