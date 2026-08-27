import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initializeTheme } from './utils/theme'
import { initializeLanguage } from './utils/i18n'
import { flushSettings, loadSettings, migrateLegacySettings } from './utils/settings'

// Before anything reads a preference: the settings that used to have a `localStorage` key each are
// brought under the one store, so moving them to the account does not read as the app forgetting them.
migrateLegacySettings()

// Painted from the mirror, which is why these two run before the query below rather than after it.
initializeTheme()
initializeLanguage()

// Not awaited: the app renders from the mirror and adopts the server's copy whenever it lands. A
// first visit on a new machine is the only case that visibly settles, and it settles in one frame.
void loadSettings()

// A setting changed and the tab closed a moment later would otherwise sit unsent in the debounce.
// `visibilitychange` rather than `pagehide`: it fires early enough for the request to actually go.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void flushSettings()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
