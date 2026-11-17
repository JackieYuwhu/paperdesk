// pdf.js 单例配置（在渲染进程 import 一次即可）
import * as pdfjsLib from 'pdfjs-dist'
// Vite: 用 ?url 拿到 worker 资源地址（不要用 webpack 的 worker-loader 写法）
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export { pdfjsLib }
