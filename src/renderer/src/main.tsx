import React, { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
const App = lazy(() => import('./App'))
import { ErrorBoundary } from './components/ErrorBoundary'
const StandaloneMindMap = lazy(() => import('./features/mindmap/StandaloneMindMap').then((m) => ({ default: m.StandaloneMindMap })))
import './styles.css'

// 独立思维地图窗口复用同一渲染入口：主进程用 ?mwindow=<itemId> 打开
const mwindowRaw = new URLSearchParams(window.location.search).get('mwindow')
const mwindowParsed = mwindowRaw == null ? NaN : Number(mwindowRaw)
const mwindowItemId =
  Number.isInteger(mwindowParsed) && mwindowParsed > 0 ? mwindowParsed : null

// 全局兜底日志：错误边界捕获不到的（事件回调 / 异步 / 资源加载）也记录下来，便于排查。
window.addEventListener('error', (e) => {
  console.error('[ui] window error:', e.error ?? e.message)
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('[ui] unhandled rejection:', (e as PromiseRejectionEvent).reason)
})

performance.mark('paperdesk-renderer-start')
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Suspense fallback={<div className="workspace-loading" role="status">正在打开 PaperDesk…</div>}>
    {mwindowItemId != null ? (
      <ErrorBoundary label="思维地图出错了">
        <StandaloneMindMap itemId={mwindowItemId} />
      </ErrorBoundary>
    ) : (
      <ErrorBoundary label="应用出错了">
        <App />
      </ErrorBoundary>
    )}
    </Suspense>
  </React.StrictMode>
)
