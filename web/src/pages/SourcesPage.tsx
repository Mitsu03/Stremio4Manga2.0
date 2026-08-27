import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, UIEvent } from 'react'
import { useMutation, useQuery } from 'urql'
import { friendlyError } from '../utils/errors'
import { t } from '../utils/i18n'

/* The catalogue this page browses is the server's own. Sources are written into the server rather
   than installed as Android extensions, so there is no third-party index to point at and no
   version of a source that could be newer than the server running it. */
const BUILTIN_CATALOGUE = 'builtin:stremio4manga'
const BUILTIN_CATALOGUE_SITE = 'https://github.com/Mitsu03/Stremio4Manga2.0'

/* The index carries well over a thousand extensions. Drawing them all costs a visible pause, so the
   dialog renders a page of matches at a time and adds another every time you reach the bottom. */
const CATALOGUE_PAGE = 60

/* How close to the bottom counts as "reached it". A page of rows loads before the scrollbar actually
   stops, so the list keeps moving rather than jolting at the end of every page. */
const CATALOGUE_REACH = 320

const EXTENSIONS_QUERY = `
  query Extensions {
    extensions(order: [{ by: NAME }]) {
      nodes {
        pkgName name lang iconUrl contentWarning
        isInstalled hasUpdate isObsolete
        source { totalCount }
      }
    }
    extensionStores { nodes { name indexUrl } }
  }
`

const UPDATE_EXTENSION_MUTATION = `
  mutation UpdateExtension($id: String!, $patch: UpdateExtensionPatchInput!) {
    updateExtension(input: { id: $id, patch: $patch }) {
      extension { pkgName isInstalled hasUpdate }
    }
  }
`

const FETCH_EXTENSIONS_MUTATION = `
  mutation FetchExtensions { fetchExtensions(input: {}) { extensions { pkgName } } }
`

const ADD_EXTENSION_STORE_MUTATION = `
  mutation AddExtensionStore($indexUrl: String!) {
    addExtensionStore(input: { indexUrl: $indexUrl }) {
      extensionStore { name indexUrl }
    }
  }
`

interface ExtensionNode {
  pkgName: string
  name: string
  lang: string
  iconUrl: string
  contentWarning: 'SAFE' | 'MIXED' | 'NSFW' | 'UNSPECIFIED'
  isInstalled: boolean
  hasUpdate: boolean
  isObsolete: boolean
  source: { totalCount: number }
}

interface ExtensionStore { name: string; indexUrl: string }
interface ExtensionsData {
  extensions: { nodes: ExtensionNode[] }
  extensionStores: { nodes: ExtensionStore[] }
}

type ExtensionAction = 'install' | 'update' | 'uninstall'
type IconName = 'refresh' | 'upgrade' | 'plus' | 'search' | 'shield' | 'download' | 'trash' | 'check' | 'close'

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    refresh: <><path d="M20 6v5h-5" /><path d="M4 18v-5h5" /><path d="M18.5 11A7 7 0 0 0 6.1 7.3L4 11M5.5 13A7 7 0 0 0 17.9 16.7L20 13" /></>,
    upgrade: <><circle cx="12" cy="12" r="8.5" /><path d="M12 16.5V8" /><path d="m8.5 11.5 3.5-3.5 3.5 3.5" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></>,
    shield: <><path d="M12 3 19 6v5c0 4.7-3 8-7 10-4-2-7-5.3-7-10V6l7-3Z" /><path d="M9.5 12 11 13.5l3.5-4" /></>,
    download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" /></>,
    trash: <><path d="M4 7h16M10 11v5M14 11v5M9 7l.7-3h4.6l.7 3M6 7l.8 13h10.4L18 7" /></>,
    check: <><path d="m5 12.5 4.5 4.5L19 7.5" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>
}

export default function SourcesPage() {
  const [{ data, fetching, error }, refetch] = useQuery<ExtensionsData>({
    query: EXTENSIONS_QUERY,
    requestPolicy: 'cache-and-network',
  })
  const [, updateExtension] = useMutation(UPDATE_EXTENSION_MUTATION)
  const [, fetchExtensions] = useMutation(FETCH_EXTENSIONS_MUTATION)
  const [, addExtensionStore] = useMutation(ADD_EXTENSION_STORE_MUTATION)
  const [query, setQuery] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const [catalogueQuery, setCatalogueQuery] = useState('')
  const [showAdult, setShowAdult] = useState(true)
  // Installing drops a row out of the catalogue's own filter, which would make it vanish from under
  // the cursor. These stay on screen — as a tick rather than a button — until the dialog is closed.
  const [justInstalled, setJustInstalled] = useState<string[]>([])
  const [limit, setLimit] = useState(CATALOGUE_PAGE)
  const results = useRef<HTMLDivElement>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [catalogueBusy, setCatalogueBusy] = useState(false)
  const [updatingAll, setUpdatingAll] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const extensions = useMemo(() => data?.extensions.nodes ?? [], [data])
  const stores = useMemo(() => data?.extensionStores.nodes ?? [], [data])

  /* The page is the list of sources you actually have. An obsolete one stays on it rather than being
     filtered away like it is in the catalogue: it is installed, it no longer works, and this is the
     only screen that can remove it. */
  const installed = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return extensions
      .filter((extension) => extension.isInstalled)
      .filter((extension) => !needle || extension.name.toLocaleLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [extensions, query])

  const catalogue = useMemo(() => {
    const needle = catalogueQuery.trim().toLocaleLowerCase()
    return extensions
      .filter((extension) => !extension.isObsolete)
      .filter((extension) => !extension.isInstalled || justInstalled.includes(extension.pkgName))
      .filter((extension) => showAdult || extension.contentWarning === 'SAFE')
      // The language code is worth matching too: "pt" is how you find the Portuguese catalogues,
      // whose names rarely say which language they publish in.
      .filter((extension) => !needle
        || extension.name.toLocaleLowerCase().includes(needle)
        || extension.lang.toLocaleLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [extensions, catalogueQuery, showAdult, justInstalled])

  const outdated = useMemo(
    () => extensions.filter((extension) => extension.isInstalled && extension.hasUpdate && !extension.isObsolete),
    [extensions],
  )

  /* A new search is a new list: it starts at the top and at one page again, or the scroll position
     left over from the last one lands somewhere the shorter list has nothing to show. */
  useEffect(() => {
    setLimit(CATALOGUE_PAGE)
    results.current?.scrollTo({ top: 0 })
  }, [catalogueQuery, showAdult, browsing])

  const extend = (event: UIEvent<HTMLDivElement>) => {
    const list = event.currentTarget
    if (list.scrollHeight - list.scrollTop - list.clientHeight > CATALOGUE_REACH) return
    setLimit((current) => (current >= catalogue.length ? current : current + CATALOGUE_PAGE))
  }

  const closeCatalogue = () => {
    setBrowsing(false)
    setCatalogueQuery('')
    setJustInstalled([])
  }

  useEffect(() => {
    if (!browsing) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setBrowsing(false)
      setCatalogueQuery('')
      setJustInstalled([])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [browsing])

  const refreshCatalogue = async () => {
    setCatalogueBusy(true)
    setActionError(null)
    const result = await fetchExtensions({})
    setCatalogueBusy(false)
    if (result.error) { setActionError(friendlyError(result.error)); return }
    refetch({ requestPolicy: 'network-only' })
  }

  const addCatalogue = async () => {
    setCatalogueBusy(true)
    setActionError(null)
    const added = await addExtensionStore({ indexUrl: BUILTIN_CATALOGUE })
    if (added.error) {
      setCatalogueBusy(false)
      setActionError(friendlyError(added.error))
      return
    }
    const refreshed = await fetchExtensions({})
    setCatalogueBusy(false)
    if (refreshed.error) { setActionError(friendlyError(refreshed.error)); return }
    refetch({ requestPolicy: 'network-only' })
  }

  const act = async (extension: ExtensionNode, action: ExtensionAction) => {
    setBusyId(extension.pkgName)
    setActionError(null)
    const result = await updateExtension({ id: extension.pkgName, patch: { [action]: true } })
    setBusyId(null)
    if (result.error) { setActionError(friendlyError(result.error)); return }
    if (action === 'install') setJustInstalled((pending) => [...pending, extension.pkgName])
    refetch({ requestPolicy: 'network-only' })
  }

  const updateAll = async () => {
    if (outdated.length === 0) return
    setUpdatingAll(true)
    setActionError(null)
    const failed: string[] = []
    for (const extension of outdated) {
      setBusyId(extension.pkgName)
      const result = await updateExtension({ id: extension.pkgName, patch: { update: true } })
      if (result.error) failed.push(extension.name)
    }
    setBusyId(null)
    setUpdatingAll(false)
    if (failed.length > 0) setActionError(t('Could not update {names}.', { names: failed.join(', ') }))
    refetch({ requestPolicy: 'network-only' })
  }

  const installedCount = extensions.filter((extension) => extension.isInstalled).length
  const nothingToBrowse = extensions.every((extension) => extension.isInstalled)
  const shown = catalogue.slice(0, limit)

  return (
    <div className="sources-page">
      <header className="sources-header">
        <div><span className="eyebrow">{t('Stremio4Manga extensions')}</span><h1>{t('Sources')}</h1></div>
        <div className="sources-header-actions">
          <span>{t('{count} installed', { count: installedCount })}</span>
          <button type="button" className={`source-icon-button${catalogueBusy ? ' loading' : ''}`} disabled={catalogueBusy || stores.length === 0} onClick={refreshCatalogue} aria-label={t('Refresh catalogue')} title={t('Refresh catalogue')}><Icon name="refresh" /></button>
          <button
            type="button"
            className={`source-icon-button source-update-all${updatingAll ? ' loading' : ''}`}
            disabled={updatingAll || catalogueBusy || outdated.length === 0}
            onClick={updateAll}
            aria-label={outdated.length === 0
              ? t('All installed sources are up to date')
              : t(outdated.length === 1 ? 'Update {count} installed source' : 'Update {count} installed sources', { count: outdated.length })}
            title={outdated.length === 0 ? t('Everything up to date') : t('Update all ({count})', { count: outdated.length })}
          >
            <Icon name="upgrade" />
          </button>
          <button type="button" className="source-icon-button source-catalogue-add" onClick={() => setBrowsing(true)} aria-label={t('Add a source')} title={t('Add a source')}><Icon name="plus" /></button>
        </div>
      </header>

      {error && <div className="notice error">{friendlyError(error)}</div>}
      {actionError && <div className="notice error">{actionError}</div>}

      {/* A handful of installed sources are read at a glance, and a search field over them would be
          furniture. It appears once the list is long enough to need it. */}
      {installedCount > 6 && (
        <div className="source-toolbar">
          <div className="search-box source-search-box">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('Find an installed source')} aria-label={t('Find an installed source')} />
            <span className="source-search-mark"><Icon name="search" /></span>
          </div>
        </div>
      )}

      {fetching && extensions.length === 0 && <div className="state-panel compact"><p>{t('Loading extensions...')}</p></div>}

      {!fetching && installed.length === 0 && (
        <div className="state-panel compact sources-empty">
          <p>{query ? t('No installed source matches that.') : t('No sources installed yet. Add one from the catalogue.')}</p>
          {!query && <button type="button" className="source-icon-button source-catalogue-add" onClick={() => setBrowsing(true)} aria-label={t('Add a source')} title={t('Add a source')}><Icon name="plus" /></button>}
        </div>
      )}

      <div className="extension-list">
        {installed.map((extension) => {
          const busy = busyId === extension.pkgName
          const locked = busy || updatingAll
          const sourceCount = extension.source.totalCount || 1
          return (
            <article className="extension-row installed" key={extension.pkgName}>
              <img src={extension.iconUrl} alt="" loading="lazy" />
              <div className="extension-copy">
                <h2>{extension.name}</h2>
                <p>
                  {extension.lang} · {sourceCount} {t(sourceCount === 1 ? 'source' : 'sources')}
                  {extension.isObsolete && ` · ${t('no longer maintained')}`}
                </p>
              </div>
              <div className="extension-actions">
                {extension.hasUpdate && <button type="button" className={`source-icon-button source-update-button${busy ? ' loading' : ''}`} disabled={locked} onClick={() => act(extension, 'update')} aria-label={t('Update {name}', { name: extension.name })} title={t('Update')}><Icon name="refresh" /></button>}
                <button type="button" className={`source-icon-button source-remove-button${busy ? ' loading' : ''}`} disabled={locked} onClick={() => act(extension, 'uninstall')} aria-label={t('Remove {name}', { name: extension.name })} title={t('Remove')}><Icon name="trash" /></button>
              </div>
            </article>
          )
        })}
      </div>

      {/* Browsing the catalogue is a separate errand from managing what you already have, so it
          happens in a dialog: the tab behind it stays the list of your own sources. */}
      {browsing && (
        <div className="catalogue-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCatalogue() }}>
          <section className="catalogue-modal" role="dialog" aria-modal="true" aria-labelledby="catalogue-title">
            <header className="catalogue-modal-header">
              <div>
                <span className="eyebrow">{t('Extension catalogue')}</span>
                <h2 id="catalogue-title">{t('Add a source')}</h2>
              </div>
              <button type="button" className="anilist-modal-close" onClick={closeCatalogue} aria-label={t('Close')} title={t('Close')}><Icon name="close" /></button>
            </header>

            {stores.length === 0 ? (
              <div className="catalogue-callout">
                <div>
                  <h2>{t('Connect the source catalogue')}</h2>
                  <p>{t('Add the Keiyoushi community catalogue to browse and install Stremio4Manga-compatible sources.')}</p>
                </div>
                <button type="button" className={`source-icon-button source-catalogue-add${catalogueBusy ? ' loading' : ''}`} disabled={catalogueBusy} onClick={addCatalogue} aria-label={t('Add the Keiyoushi catalogue')} title={t('Add catalogue')}><Icon name="plus" /></button>
              </div>
            ) : (
              <>
                <div className="source-toolbar">
                  <div className="search-box source-search-box">
                    <input value={catalogueQuery} onChange={(event) => setCatalogueQuery(event.target.value)} placeholder={t('Find a source')} aria-label={t('Find a source')} />
                    <span className="source-search-mark"><Icon name="search" /></span>
                  </div>
                  <button type="button" className={`source-icon-button adult-filter-button${showAdult ? ' active' : ''}`} onClick={() => setShowAdult((enabled) => !enabled)} aria-pressed={showAdult} aria-label={t('Include adult catalogues')} title={showAdult ? t('Hide adult catalogues') : t('Include adult catalogues')}><Icon name="shield" /></button>
                  {/* The same refresh as the header behind, repeated here because this is where its
                      result is read — and because a catalogue that has never been pulled shows an
                      empty dialog, which would otherwise have no way out of itself. */}
                  <button type="button" className={`source-icon-button${catalogueBusy ? ' loading' : ''}`} disabled={catalogueBusy} onClick={refreshCatalogue} aria-label={t('Refresh catalogue')} title={t('Refresh catalogue')}><Icon name="refresh" /></button>
                </div>

                <div className="extension-list catalogue-results" ref={results} onScroll={extend}>
                  {shown.length === 0 && (
                    <div className="state-panel compact">
                      {/* Nothing to browse means the index has never been pulled (or everything in it
                          is already installed), and no amount of clearing filters will help — so the
                          empty dialog points at the refresh rather than at the search. */}
                      <p>{nothingToBrowse ? t('Nothing to add yet. Refresh the catalogue to pull the latest list.') : t('No sources match these filters.')}</p>
                    </div>
                  )}
                  {shown.map((extension) => {
                    const busy = busyId === extension.pkgName
                    const sourceCount = extension.source.totalCount || 1
                    return (
                      <article className={`extension-row${extension.isInstalled ? ' installed' : ''}`} key={extension.pkgName}>
                        <img src={extension.iconUrl} alt="" loading="lazy" />
                        <div className="extension-copy">
                          <h2>{extension.name}</h2>
                          <p>{extension.lang} · {sourceCount} {t(sourceCount === 1 ? 'source' : 'sources')}</p>
                        </div>
                        <div className="extension-actions">
                          {extension.isInstalled
                            ? <span className="extension-installed-mark" role="img" aria-label={t('Installed')} title={t('Installed')}><Icon name="check" /></span>
                            : <button type="button" className={`source-icon-button source-install-button${busy ? ' loading' : ''}`} disabled={busy} onClick={() => act(extension, 'install')} aria-label={t('Install {name}', { name: extension.name })} title={t('Install')}><Icon name="download" /></button>}
                        </div>
                      </article>
                    )
                  })}
                </div>

                <footer className="catalogue-modal-foot">
                  {catalogue.length > 0 && <p>{t('Showing {count} of {total}.', { count: shown.length, total: catalogue.length })}</p>}
                  <p>
                    {t('Catalogue: {names}', { names: stores.map((store) => store.name).join(', ') })}
                    {' · '}
                    <a href={BUILTIN_CATALOGUE_SITE} target="_blank" rel="noreferrer">Stremio4Manga</a>
                  </p>
                </footer>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
