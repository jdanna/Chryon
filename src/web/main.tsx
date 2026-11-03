import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import WebApp from './WebApp'
import '@renderer/styles/tokens.css'
import '@renderer/styles/global.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WebApp />
  </StrictMode>
)
