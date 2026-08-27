import { Provider } from 'urql'
import { BrowserRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom'
import { client } from './api/client'
import LibraryPage from './pages/LibraryPage'
import SearchPage from './pages/SearchPage'
import MangaDetailPage from './pages/MangaDetailPage'
import ReaderPage from './pages/ReaderPage'
import SettingsPage from './pages/SettingsPage'
import SourcesPage from './pages/SourcesPage'
import DownloadsPage from './pages/DownloadsPage'
import OAuthCallbackPage from './pages/OAuthCallbackPage'
import { t, useLanguage } from './utils/i18n'
import toriHeader from './assets/tori-header.png'
import './App.css'

function AppLayout() {
  const location = useLocation()
  const readerActive = location.pathname.includes('/chapter/')

  return (
    <div className={readerActive ? 'app reader-active' : 'app'}>
      {!readerActive && (
        <header className="app-header">
          <NavLink to="/" className="brand" aria-label={t('Stremio4Manga library')}>
            <span className="brand-mark" aria-hidden="true">
              <img src={toriHeader} alt="" />
            </span>
          </NavLink>
          <nav className="topnav" aria-label={t('Main navigation')}>
            <NavLink to="/">{t('Library')}</NavLink>
            <NavLink to="/search">{t('Discover')}</NavLink>
            <NavLink to="/sources">{t('Sources')}</NavLink>
            <NavLink to="/downloads">{t('Downloads')}</NavLink>
            <NavLink to="/settings">{t('Settings')}</NavLink>
          </nav>
        </header>
      )}
      <main className={readerActive ? 'content reader-content' : 'content'}>
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/sources" element={<SourcesPage />} />
          <Route path="/manga/:mangaId" element={<MangaDetailPage />} />
          <Route path="/manga/:mangaId/chapter/:chapterIndex" element={<ReaderPage />} />
          <Route path="/downloads" element={<DownloadsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/handle/oauth/result" element={<OAuthCallbackPage />} />
        </Routes>
      </main>
    </div>
  )
}

function App() {
  const language = useLanguage()

  return (
    <Provider value={client}>
      <BrowserRouter>
        <AppLayout key={language} />
      </BrowserRouter>
    </Provider>
  )
}

export default App
