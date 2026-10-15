import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './app/App'
import { AppErrorBoundary } from './components/shared/AppErrorBoundary'
import './styles/index.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('Root element #root was not found in index.html.')
}

createRoot(container).render(
  <StrictMode>
    <AppErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AppErrorBoundary>
  </StrictMode>,
)
