/// <reference types="vite/client" />
import type { MaxineApi } from '@shared/types'

declare global {
  interface Window {
    maxine: MaxineApi
  }
}
