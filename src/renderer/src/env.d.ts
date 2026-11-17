/// <reference types="vite/client" />

import type { PaperdeskApi } from '@shared/api'

declare global {
  interface Window {
    api: PaperdeskApi
  }
}

export {}
