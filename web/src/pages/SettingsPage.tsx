import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import { useMutation, useQuery } from 'urql'
import { client } from '../api/client'
import { gatewayAccount, signOut, type GatewayAccount } from '../api/session'
import { friendlyError } from '../utils/errors'
import {
  AUTOMATED_BACKUPS_QUERY,
  RESTORE_AUTOMATED_BACKUP_MUTATION,
  RESTORE_BACKUP_MUTATION,
  RESTORE_STATUS_QUERY,
  SET_BACKUP_SCHEDULE_MUTATION,
  VALIDATE_AUTOMATED_BACKUP_QUERY,
  VALIDATE_BACKUP_QUERY,
  describeRestore,
  describeSchedule,
  excludedFromAutoBackup,
  formatBackupSize,
  formatBackupTaken,
  isRestoreFinished,
  uploadGraphQL,
} from '../utils/backup'
import type {
  AutomatedBackupsResult,
  BackupRestoreStatus,
  RestoreAutomatedBackupResult,
  RestoreBackupResult,
  ValidateAutomatedBackupResult,
  ValidateBackupResult,
} from '../utils/backup'
import {
  CATEGORIES_QUERY,
  CREATE_CATEGORY_MUTATION,
  DEFAULT_CATEGORY_ID,
  DELETE_CATEGORY_MUTATION,
  RENAME_CATEGORY_MUTATION,
  REORDER_CATEGORY_MUTATION,
  sortedCategories,
} from '../utils/categories'
import type { CategoriesResult } from '../utils/categories'
import { getThemePreference, setThemePreference } from '../utils/theme'
import { setLanguage, t, useLanguage } from '../utils/i18n'
import type { Language } from '../utils/i18n'
import {
  BOUND_UNREAD_QUERY,
  DOWNLOADED_CHAPTERS_QUERY,
  LIBRARY_QUERY,
  boundSourceIds,
  countLibrary,
  meanScore,
} from '../utils/libraryStats'
import type { BoundStatsResult, DownloadedChaptersResult, LibraryStatsResult } from '../utils/libraryStats'
import type { ThemePreference } from '../utils/theme'
import { ANILIST_TRACKER_ID, LAST_SYNC_QUERY, SET_LAST_SYNC_MUTATION, formatSince, lastSyncFromMeta, statusNames, trackKey, TRACKER_SLUGS } from '../utils/tracking'
import { startTrackerLogin } from '../utils/oauth'

// What the connection is actually worth, counted the way the library shelves count it: one entry
// per AniList title, deduplicated by remoteId because a series imported from AniList and the same
// series added from a source are two rows pointing at one record.
//
// score rides along for the statistics pane. It is on this query rather than on one of its own so
// the mean and the "titles tracked" beside it are read off the same records — a second query could
// average over a set the count above does not describe.
const TRACKED_TITLES_QUERY = `
  query TrackedTitles {
    mangas(condition: { inLibrary: true }) {
      nodes {
        id
        trackRecords { nodes { trackerId remoteId status score lastChapterRead } }
      }
    }
  }
`

interface TrackedTitlesResult {
  mangas: { nodes: Array<{ id: number; trackRecords: { nodes: Array<{ trackerId: number; remoteId: string; status: number; score: number; lastChapterRead: number }> } }> }
}

// Every tracker the server has, rather than AniList by id: which ones exist is the server's answer,
// and asking for the list is what lets a second one appear here without a change to this file.
//
// user is resolved from the tracker itself the first time it is asked for, so a connection made
// before the server cached the profile still fills in — it stays null when the tracker is
// unreachable.
const SETTINGS_QUERY = `
  query AppSettings {
    trackers {
      id
      name
      icon
      isLoggedIn
      authUrl
      authRequiresVerifier
      user {
        name
        avatarUrl
      }
    }
  }
`

const LOGOUT_TRACKER_MUTATION = `
  mutation LogoutTracker($trackerId: Int!) {
    logoutTracker(input: { trackerId: $trackerId }) {
      isLoggedIn
    }
  }
`

const IMPORT_LIBRARY_MUTATION = `
  mutation ImportAnilistLibrary {
    importAnilistLibrary(input: {}) {
      manga { id }
    }
  }
`

// No flags: the server falls back to BackupFlags.DEFAULT, which covers the whole library.
const CREATE_BACKUP_MUTATION = `
  mutation CreateBackup {
    createBackup(input: {}) {
      url
    }
  }
`

interface CreateBackupResult {
  createBackup: { url: string }
}

interface RestoreStatusResult {
  restoreStatus: BackupRestoreStatus | null
}

type Validation = ValidateBackupResult['validateBackup']

interface TrackerConnection {
  id: number
  name: string
  icon: string
  isLoggedIn: boolean
  authUrl: string | null
  authRequiresVerifier: boolean
  user: { name: string; avatarUrl: string | null } | null
}

interface SettingsResult {
  trackers: TrackerConnection[]
}

interface ImportLibraryResult {
  importAnilistLibrary: { manga: Array<{ id: number }> }
}

// A palette's name is a proper noun and stays as it is in every language; the sentence around it
// is not, and goes through t() like everything else. Kept deliberately short: every token added to
// index.css from here on has to be added to each of these, and each has a second copy on the
// sign-in page. Two named palettes is a feature; nine is a maintenance surface.
const themeOptions: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'Use device theme' },
  { value: 'light', label: 'Use light theme' },
  { value: 'dark', label: 'Use dark theme' },
  { value: 'tokyo-night', label: 'Use the Tokyo Night palette' },
  { value: 'sepia', label: 'Use the Sepia palette' },
]

// The two-letter tag is the control: a language is one of the few things that can be drawn as the
// word for itself, and each option is written in its own language so it reads to the person looking
// for it rather than to the person already using the app.
const languageOptions: Array<{ value: Language; tag: string; label: string }> = [
  { value: 'en', tag: 'EN', label: 'Use English' },
  { value: 'pt', tag: 'PT', label: 'Usar português de Portugal' },
]

type IconName = 'connect' | 'disconnect' | 'import' | 'export' | 'restore'
  | 'add' | 'rename' | 'remove' | 'up' | 'down' | 'confirm' | 'cancel' | 'signout'

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    add: <><path d="M12 5v14M5 12h14" /></>,
    rename: <><path d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5 4 20Z" /><path d="M13.5 7.5 16.5 10.5" /></>,
    remove: <><path d="M5 7h14" /><path d="M9 7V5h6v2" /><path d="M7 7v12a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 17 19V7" /><path d="M10.5 11v6M13.5 11v6" /></>,
    up: <><path d="M12 19V6" /><path d="m6 12 6-6 6 6" /></>,
    down: <><path d="M12 5v13" /><path d="m6 12 6 6 6-6" /></>,
    confirm: <><path d="m5 12.5 4.5 4.5L19 7.5" /></>,
    cancel: <><path d="M6 6l12 12M18 6 6 18" /></>,
    connect: <><path d="M10 14 14 10" /><path d="M8.2 16.8 6 19a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0" /><path d="M15.8 7.2 18 5a3.5 3.5 0 1 1 5 5l-3 3a3.5 3.5 0 0 1-5 0" /></>,
    disconnect: <><path d="m9 15-3 3a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 4.8-.2" /><path d="m15 9 3-3a3.5 3.5 0 1 1 5 5l-3 3a3.5 3.5 0 0 1-4.8.2" /><path d="m4 4 16 16" /></>,
    import: <><path d="M12 3v11" /><path d="m8 10 4 4 4-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></>,
    // Export drops a file onto the floor line; restore lifts one up to the server line.
    export: <><path d="M12 4v10" /><path d="m8 10 4 4 4-4" /><path d="M4 19h16" /></>,
    restore: <><path d="M12 20V10" /><path d="m8 14 4-4 4 4" /><path d="M4 5h16" /></>,
    // A door with an arrow leaving through it — the one glyph everybody already reads as "sign out".
    signout: <><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" /><path d="M16 8l4 4-4 4" /><path d="M20 12H10" /></>,
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>
}

type SettingsTab = 'tracking' | 'statistics' | 'categories' | 'backup' | 'appearance' | 'language'

const settingsTabs: Array<{ id: SettingsTab; label: string }> = [
  { id: 'tracking', label: 'Tracking' },
  { id: 'statistics', label: 'Statistics' },
  { id: 'categories', label: 'Categories' },
  { id: 'backup', label: 'Backup & restore' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'language', label: 'Language' },
]

/**
 * The rail: sections on top, who you are at the bottom.
 *
 * The account sits with the navigation rather than in the pane because it is context for everything
 * the pane can show, not one more thing to configure. Against a local server there is no account to
 * show, so the chip is simply absent and the rail is the section list — the chip appearing is itself
 * the signal that this deployment has real accounts behind it.
 */
function SettingsRail({ active, onSelect }: { active: SettingsTab; onSelect: (tab: SettingsTab) => void }) {
  return (
    <nav className="settings-rail" aria-label={t('Settings sections')}>
      <span className="settings-rail-label">{t('Settings')}</span>
      {settingsTabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`settings-rail-item${active === tab.id ? ' active' : ''}`}
          aria-current={active === tab.id ? 'page' : undefined}
          onClick={() => onSelect(tab.id)}
        >{t(tab.label)}</button>
      ))}
      <AccountRail />
    </nav>
  )
}

function AccountRail() {
  const [account, setAccount] = useState<GatewayAccount | null>(null)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void gatewayAccount().then((found) => {
      if (!cancelled) setAccount(found)
    })
    return () => { cancelled = true }
  }, [])

  if (!account) return null

  return (
    <div className="account-rail">
      <div className="account-rail-chip">
        <span className="account-monogram" aria-hidden="true">{account.displayName.slice(0, 1).toUpperCase()}</span>
        <span className="account-rail-who">
          <strong>{account.displayName}</strong>
          <small><span className="status-dot online" />{t('Signed in')}</small>
        </span>
        {/* Sign out reuses the disconnect chip rather than getting a look of its own: ending a session
            and dropping a connection are the same gesture to the person doing it. */}
        <button
          type="button"
          className={`settings-icon-button account-rail-signout${leaving ? ' loading' : ''}`}
          disabled={leaving}
          onClick={() => { setLeaving(true); void signOut() }}
          aria-label={t('Sign out')}
          title={t('Sign out')}
        ><Icon name="signout" /></button>
      </div>
    </div>
  )
}

/**
 * The shelf split as one bar. The widths are shares of the tracked total, so it says nothing the
 * numbers beside it do not — it says it at a glance. Drawn only when there is more than one shelf: a
 * single full-width bar is a decoration, not a comparison.
 */
function ShelfSplit({ shelves, counts, total }: { shelves: string[]; counts: Map<string, number>; total: number }) {
  if (shelves.length < 2 || total === 0) return null
  return (
    <div className="anilist-split">
      <div className="anilist-split-heading"><h2>{t('How the shelves split')}</h2></div>
      <div className="anilist-split-bar" role="presentation">
        {shelves.map((label, index) => (
          <span
            key={label}
            className={`anilist-split-part part-${index % 3}`}
            style={{ width: `${((counts.get(label) ?? 0) / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="anilist-split-legend">
        {shelves.map((label, index) => (
          <span key={label}><i className={`part-${index % 3}`} />{t(label)} {counts.get(label)}</span>
        ))}
      </div>
    </div>
  )
}

/**
 * The connected account's picture, falling back to its initial. The avatar is served by AniList's
 * own CDN rather than proxied by us, so a blocked or dead image must not leave a broken-image icon
 * sitting in the card.
 */
function TrackerAvatar({ name, url }: { name: string; url: string | null }) {
  const [failed, setFailed] = useState(false)
  if (!url || failed) return <span className="tracker-avatar tracker-avatar-blank" aria-hidden="true">{name.slice(0, 1)}</span>
  return <img className="tracker-avatar" src={url} alt="" onError={() => setFailed(true)} />
}

/**
 * Create, rename, reorder and delete the shelves the library can group by.
 *
 * Default is rendered as a row with no controls: it is the server's virtual category, so it cannot be
 * renamed, moved or deleted, and hiding it entirely would leave the count of everything unfiled with
 * nowhere to appear.
 */
function CategoriesCard() {
  const [{ data, fetching, error }, refetch] = useQuery<CategoriesResult>({
    query: CATEGORIES_QUERY,
    requestPolicy: 'cache-and-network',
  })
  const [, createCategory] = useMutation(CREATE_CATEGORY_MUTATION)
  const [, renameCategory] = useMutation(RENAME_CATEGORY_MUTATION)
  const [, deleteCategory] = useMutation(DELETE_CATEGORY_MUTATION)
  const [, reorderCategory] = useMutation(REORDER_CATEGORY_MUTATION)
  const [newName, setNewName] = useState('')
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const categories = sortedCategories(data)
  const unfiled = data?.categories.nodes.find((category) => category.id === DEFAULT_CATEGORY_ID)?.mangas.totalCount ?? 0

  // Every action here is one mutation plus a re-read: the server renumbers `order` across the whole
  // list on a move, so trusting a local edit would leave the neighbours' numbers stale.
  const run = async (action: Promise<{ error?: { message: string } | null }>) => {
    setBusy(true)
    setFailure(null)
    const result = await action
    if (result.error) {
      setBusy(false)
      setFailure(friendlyError(result.error))
      return false
    }
    await refetch({ requestPolicy: 'network-only' })
    setBusy(false)
    return true
  }

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    const name = newName.trim()
    if (!name || busy) return
    if (await run(createCategory({ name }))) setNewName('')
  }

  const rename = async () => {
    const name = editing?.name.trim()
    if (!editing || !name || busy) return
    if (await run(renameCategory({ id: editing.id, name }))) setEditing(null)
  }

  // `position` is the order the category lands on, and Default holds 0, so the first real category
  // sits at 1 and cannot be moved above it.
  const move = (id: number, order: number, delta: number) => {
    const position = order + delta
    if (position < 1 || position > categories.length || busy) return
    void run(reorderCategory({ id, position }))
  }

  const remove = async (id: number) => {
    if (busy) return
    if (await run(deleteCategory({ id }))) setConfirmingDelete(null)
  }

  return (
    <section className="settings-card settings-categories-card">
      <div>
        <h2>{t('Categories')}</h2>
        <p>{t('Shelves you name yourself. The library can group by these instead of by AniList status. Deleting one never removes its titles from the library.')}</p>
      </div>
      <div className="connection-action">
        {error
          ? <span className="inline-error">{friendlyError(error)}</span>
          : <span>{fetching && !data
              ? t('Loading…')
              : categories.length === 0
                ? t('None yet')
                : t(categories.length === 1 ? '{count} category' : '{count} categories', { count: categories.length })}</span>}
      </div>

      <div className="category-manager">
        <form className="category-add" onSubmit={create}>
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder={t('New category')}
            aria-label={t('New category name')}
            maxLength={64}
          />
          <button
            type="submit"
            className="settings-icon-button settings-import-button"
            disabled={busy || newName.trim() === ''}
            aria-label={t('Create category')}
            title={t('Create category')}
          ><Icon name="add" /></button>
        </form>

        {failure && <p className="inline-error">{failure}</p>}

        <ul className="category-rows">
          {categories.map((category, index) => (
            <li key={category.id}>
              {editing?.id === category.id ? (
                <>
                  <input
                    className="category-rename"
                    value={editing.name}
                    autoFocus
                    onChange={(event) => setEditing({ id: category.id, name: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') { event.preventDefault(); void rename() }
                      if (event.key === 'Escape') setEditing(null)
                    }}
                    aria-label={t('Rename {name}', { name: category.name })}
                  />
                  <button type="button" className="settings-icon-button" onClick={rename} disabled={busy || editing.name.trim() === ''} aria-label={t('Save name')} title={t('Save')}><Icon name="confirm" /></button>
                  <button type="button" className="settings-icon-button" onClick={() => setEditing(null)} disabled={busy} aria-label={t('Cancel rename')} title={t('Cancel')}><Icon name="cancel" /></button>
                </>
              ) : confirmingDelete === category.id ? (
                <>
                  <span className="category-question">{t('Delete {name}? Its titles stay in the library.', { name: category.name })}</span>
                  <button type="button" className="settings-icon-button settings-disconnect-button" onClick={() => remove(category.id)} disabled={busy} aria-label={t('Delete {name}', { name: category.name })} title={t('Delete')}><Icon name="confirm" /></button>
                  <button type="button" className="settings-icon-button" onClick={() => setConfirmingDelete(null)} disabled={busy} aria-label={t('Keep the category')} title={t('Keep')}><Icon name="cancel" /></button>
                </>
              ) : (
                <>
                  <strong>{category.name}</strong>
                  <span className="category-count">{category.mangas.totalCount}</span>
                  <button type="button" className="settings-icon-button" onClick={() => move(category.id, category.order, -1)} disabled={busy || index === 0} aria-label={t('Move {name} up', { name: category.name })} title={t('Move up')}><Icon name="up" /></button>
                  <button type="button" className="settings-icon-button" onClick={() => move(category.id, category.order, 1)} disabled={busy || index === categories.length - 1} aria-label={t('Move {name} down', { name: category.name })} title={t('Move down')}><Icon name="down" /></button>
                  <button type="button" className="settings-icon-button" onClick={() => { setEditing({ id: category.id, name: category.name }); setConfirmingDelete(null) }} disabled={busy} aria-label={t('Rename {name}', { name: category.name })} title={t('Rename')}><Icon name="rename" /></button>
                  <button type="button" className="settings-icon-button settings-disconnect-button" onClick={() => { setConfirmingDelete(category.id); setEditing(null) }} disabled={busy} aria-label={t('Delete {name}', { name: category.name })} title={t('Delete')}><Icon name="remove" /></button>
                </>
              )}
            </li>
          ))}
          <li className="category-default">
            <strong>{t('Default')}</strong>
            <span className="category-count">{unfiled}</span>
            <small>{t('Everything you have not filed anywhere. The server keeps this one; it cannot be renamed or removed.')}</small>
          </li>
        </ul>
      </div>
    </section>
  )
}

/**
 * What the whole library adds up to, on the four queries that already know.
 *
 * Nothing here is asked of the server twice: the library and its bound sources are the documents the
 * library page runs, served out of the urql cache whenever that page has been open, and the tracked
 * titles are the AniList pane's own query one tab away. The only request this pane adds is the count
 * of downloaded chapters, which no other screen asks for.
 */
function LibraryStatsCard() {
  const [{ data, fetching, error }] = useQuery<LibraryStatsResult>({ query: LIBRARY_QUERY })
  const entries = useMemo(() => data?.mangas.nodes ?? [], [data])
  const ids = useMemo(() => boundSourceIds(entries), [entries])
  const [{ data: boundData }] = useQuery<BoundStatsResult>({
    query: BOUND_UNREAD_QUERY,
    variables: { ids },
    pause: ids.length === 0,
  })
  const [{ data: downloadedData }] = useQuery<DownloadedChaptersResult>({ query: DOWNLOADED_CHAPTERS_QUERY })
  const [{ data: trackedData }] = useQuery<TrackedTitlesResult>({ query: TRACKED_TITLES_QUERY })

  const totals = useMemo(() => countLibrary(entries, boundData?.mangas.nodes ?? []), [entries, boundData])

  // One remote record can hang off several library rows, so the scores are collected per link
  // before they are averaged — the same dedupe the connection pane counts tracked titles with. The
  // key carries the tracker, because a remote id is only unique inside its own.
  const scoreByRemote = new Map<string, number>()
  for (const node of trackedData?.mangas.nodes ?? []) {
    for (const record of node.trackRecords.nodes) {
      scoreByRemote.set(trackKey(record), record.score)
    }
  }
  const { mean, scored } = meanScore([...scoreByRemote.values()])
  const tracked = scoreByRemote.size

  return (
    <section className="settings-card settings-stats-card">
      <div>
        <h2>{t('Statistics')}</h2>
        <p>{t('What the shelves add up to. Every number is counted the way the library page counts, so the two can never tell different stories.')}</p>
      </div>
      {(error || (fetching && !data)) && (
        <div className="connection-action">
          {error ? <span className="inline-error">{friendlyError(error)}</span> : <span>{t('Counting…')}</span>}
        </div>
      )}

      <div className="library-stats">
        <div><strong>{totals.titles}</strong><small>{t('Titles in the library')}</small></div>
        <div><strong>{totals.completed}</strong><small>{t('Completed')}</small></div>
        <div><strong>{totals.chaptersRead} / {totals.chaptersTotal}</strong><small>{t('Chapters read')}</small></div>
        <div><strong>{downloadedData?.chapters.totalCount ?? 0}</strong><small>{t('Chapters on disk')}</small></div>
        <div><strong>{tracked}</strong><small>{t(tracked === 1 ? 'Title tracked' : 'Titles tracked')}</small></div>
        {/* An em dash, not a zero: no score given is not a score of nothing. */}
        <div><strong>{scored === 0 ? '—' : mean.toFixed(1)}</strong><small>{t('Mean score')}</small></div>
      </div>

      <p className="library-stats-note">
        {t('Chapters are counted as distinct chapter numbers on the source each title is read from, so a chapter published by three scanlation groups counts once. Chapters on disk are files, and every one of them counts.')}
        {' '}
        {scored === 0
          ? t('No tracked title carries a score yet.')
          : t(scored === 1 ? 'The mean is over the {count} tracked title that carries a score; records nobody scored are left out.' : 'The mean is over the {count} tracked titles that carry a score; records nobody scored are left out.', { count: scored })}
      </p>
    </section>
  )
}

export default function SettingsPage() {
  const [{ data, fetching, error }, refetch] = useQuery<SettingsResult>({ query: SETTINGS_QUERY })
  const [logoutResult, logoutTracker] = useMutation(LOGOUT_TRACKER_MUTATION)
  const [importResult, importLibrary] = useMutation<ImportLibraryResult>(IMPORT_LIBRARY_MUTATION)
  const [importedCount, setImportedCount] = useState<number | null>(null)
  const [{ data: trackedData }, refetchTracked] = useQuery<TrackedTitlesResult>({ query: TRACKED_TITLES_QUERY })
  const [{ data: syncData }, refetchSync] = useQuery<{ metas: { nodes: Array<{ key: string; value: string }> } }>({
    query: LAST_SYNC_QUERY,
    requestPolicy: 'cache-and-network',
  })
  const [, setLastSync] = useMutation(SET_LAST_SYNC_MUTATION)
  const [tab, setTab] = useState<SettingsTab>('tracking')
  const [theme, setTheme] = useState<ThemePreference>(() => getThemePreference())
  const language = useLanguage()

  const [backupResult, createBackup] = useMutation<CreateBackupResult>(CREATE_BACKUP_MUTATION)
  const [exportError, setExportError] = useState<string | null>(null)
  const filePickerRef = useRef<HTMLInputElement>(null)
  const [pendingBackup, setPendingBackup] = useState<File | null>(null)
  // The server's own nightly backups: a filename it reported, not a file to send.
  const [{ data: autoData, error: autoError }, refetchAuto] = useQuery<AutomatedBackupsResult>({
    query: AUTOMATED_BACKUPS_QUERY,
    requestPolicy: 'cache-and-network',
  })
  const [, restoreAutomatedBackup] = useMutation<RestoreAutomatedBackupResult>(RESTORE_AUTOMATED_BACKUP_MUTATION)
  const [, setBackupSchedule] = useMutation(SET_BACKUP_SCHEDULE_MUTATION)
  const [pendingAuto, setPendingAuto] = useState<string | null>(null)
  const [schedule, setSchedule] = useState<{ interval: number; time: string; ttl: number } | null>(null)
  const [scheduleError, setScheduleError] = useState<string | null>(null)
  const [savingSchedule, setSavingSchedule] = useState(false)
  const [validation, setValidation] = useState<Validation | null>(null)
  const [restoreId, setRestoreId] = useState<string | null>(null)
  const [restoreStatus, setRestoreStatus] = useState<BackupRestoreStatus | null>(null)
  const [busy, setBusy] = useState<'validating' | 'restoring' | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)

  const runExport = async () => {
    setExportError(null)
    const result = await createBackup({})
    const url = result.data?.createBackup.url
    if (!url) {
      setExportError(friendlyError(result.error))
      return
    }
    // The url is a relative same-origin path that Vite already proxies, so an anchor is enough —
    // there is no blob to assemble client-side.
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = ''
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
  }

  const clearRestore = () => {
    setPendingBackup(null)
    setPendingAuto(null)
    setValidation(null)
    setRestoreId(null)
    setRestoreStatus(null)
    setRestoreError(null)
    setBusy(null)
    // Reset the input too, or picking the same file twice in a row fires no change event.
    if (filePickerRef.current) filePickerRef.current.value = ''
  }

  // Validate as soon as a file is chosen: what a backup is missing has to be visible *before* the
  // user commits, because a restore cannot be undone.
  const chooseBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setRestoreError(null)
    setValidation(null)
    setRestoreStatus(null)
    setRestoreId(null)
    setPendingBackup(file)
    setBusy('validating')
    try {
      const data = await uploadGraphQL<ValidateBackupResult>(VALIDATE_BACKUP_QUERY, file)
      setValidation(data.validateBackup)
    } catch (error) {
      setRestoreError(friendlyError(error as { message: string }, 'That file could not be read as a backup.'))
      setPendingBackup(null)
    } finally {
      setBusy(null)
    }
  }

  // The same check, on a backup the server already holds: no upload, so this one goes through the
  // shared client rather than the hand-rolled multipart post.
  const chooseAutomatedBackup = async (filename: string) => {
    setRestoreError(null)
    setValidation(null)
    setRestoreStatus(null)
    setRestoreId(null)
    setPendingBackup(null)
    setPendingAuto(filename)
    setBusy('validating')
    const result = await client
      .query<ValidateAutomatedBackupResult>(VALIDATE_AUTOMATED_BACKUP_QUERY, { filename }, { requestPolicy: 'network-only' })
      .toPromise()
    setBusy(null)
    if (result.error || !result.data) {
      setRestoreError(friendlyError(result.error, 'That backup could not be read.'))
      setPendingAuto(null)
      return
    }
    setValidation(result.data.validateAutomatedBackup)
  }

  // Both restores are the same job once started — the difference is only whether the file travels.
  const confirmRestore = async () => {
    if (!pendingBackup && !pendingAuto) return
    setBusy('restoring')
    setRestoreError(null)
    try {
      if (pendingAuto) {
        const result = await restoreAutomatedBackup({ filename: pendingAuto })
        if (result.error || !result.data) throw result.error ?? new Error('The restore could not be started.')
        setRestoreStatus(result.data.restoreAutomatedBackup.status)
        setRestoreId(result.data.restoreAutomatedBackup.id)
        return
      }
      const data = await uploadGraphQL<RestoreBackupResult>(RESTORE_BACKUP_MUTATION, pendingBackup as File)
      setRestoreStatus(data.restoreBackup.status)
      setRestoreId(data.restoreBackup.id)
    } catch (error) {
      setRestoreError(friendlyError(error as { message: string }, 'The restore could not be started.'))
      setBusy(null)
    }
  }

  const saveSchedule = async () => {
    if (!schedule) return
    setSavingSchedule(true)
    setScheduleError(null)
    const result = await setBackupSchedule({ interval: schedule.interval, time: schedule.time, ttl: schedule.ttl })
    setSavingSchedule(false)
    if (result.error) {
      setScheduleError(friendlyError(result.error))
      return
    }
    // Changing the interval reschedules the job server-side, and it may run immediately if it decides
    // it missed a slot — so re-read rather than trusting the numbers just sent.
    setSchedule(null)
    refetchAuto({ requestPolicy: 'network-only' })
  }

  // Restoring runs server-side after the upload returns, so poll for the rest of it. The
  // libraryUpdateStatusChanged-style subscriptions need a websocket transport this client does not
  // have, and restoreStatus answers the same question over the existing one.
  useEffect(() => {
    if (!restoreId) return
    let cancelled = false
    let timer = 0

    const poll = async () => {
      const result = await client
        .query<RestoreStatusResult>(RESTORE_STATUS_QUERY, { id: restoreId }, { requestPolicy: 'network-only' })
        .toPromise()
      if (cancelled) return

      const status = result.data?.restoreStatus
      if (result.error || !status) {
        setRestoreError(friendlyError(result.error, 'Lost track of the restore. Check the server log.'))
        setBusy(null)
        return
      }

      setRestoreStatus(status)
      if (!isRestoreFinished(status.state)) {
        timer = window.setTimeout(poll, 1000)
        return
      }

      setBusy(null)
      setRestoreId(null)
      if (status.state === 'FAILURE') setRestoreError('The server reported the restore failed.')
      // A restore rewrites the library wholesale, so drop the cached queries with it — including the
      // backup schedule, which a backup carrying server settings can have changed under us.
      else {
        refetch({ requestPolicy: 'network-only' })
        refetchAuto({ requestPolicy: 'network-only' })
      }
    }

    poll()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [refetch, refetchAuto, restoreId])


  const runImport = async () => {
    setImportedCount(null)
    const result = await importLibrary({})
    if (!result.data) return
    setImportedCount(result.data.importAnilistLibrary.manga.length)
    // An import *is* a sync — it just pulls the whole list rather than the titles already here — so
    // it moves the same stamp the library's sync button moves, and the counts are re-read with it.
    await setLastSync({ stamp: String(Date.now()) })
    refetchSync({ requestPolicy: 'network-only' })
    refetchTracked({ requestPolicy: 'network-only' })
  }

  const chooseTheme = (preference: ThemePreference) => {
    setTheme(preference)
    setThemePreference(preference)
  }

  if (fetching) return <div className="state-panel"><p>{t('Loading settings...')}</p></div>
  if (error) return <div className="state-panel error"><h2>{t('Settings unavailable')}</h2><p>{friendlyError(error)}</p></div>

  const trackers = data?.trackers ?? []
  // AniList keeps one surface of its own: the list import, which is a bulk export of that service's
  // list rather than part of the tracking loop, and which is drawn on its card alone.
  const anyConnected = trackers.some((tracker) => tracker.isLoggedIn)
  const lastSync = lastSyncFromMeta(syncData?.metas.nodes)

  // One remote record can hang off several library rows (the imported stub and the copy added from
  // a source), so the shelf counts are taken over distinct links, tracker included.
  const byRemote = new Map<string, number>()
  for (const node of trackedData?.mangas.nodes ?? []) {
    for (const record of node.trackRecords.nodes) {
      byRemote.set(trackKey(record), record.status)
    }
  }
  const shelfCounts = new Map<string, number>()
  for (const status of byRemote.values()) {
    const label = statusNames[status] ?? 'Other'
    shelfCounts.set(label, (shelfCounts.get(label) ?? 0) + 1)
  }
  const shelves = ['Reading', 'Rereading', 'Planning', 'On Hold'].filter((label) => shelfCounts.has(label))

  // One confirm panel, and one "done" panel, for both restores — a file chosen from disk and one of
  // the server's own. Each is rendered inside whichever card started it, so the question appears where
  // it was asked rather than in the other card further down the page.
  const restoreConfirm = validation && !restoreId && !restoreStatus ? (
    <div className="restore-confirm">
      {validation.missingSources.length === 0 && validation.missingTrackers.length === 0 ? (
        <p>{t('Everything this backup references is installed.')}</p>
      ) : (
        <>
          <p>{t('This backup references things this server does not have:')}</p>
          <ul>
            {validation.missingSources.map((source) => (
              <li key={source.id}>{source.name} <small>({t('source')})</small></li>
            ))}
            {validation.missingTrackers.map((tracker) => (
              <li key={tracker.name}>{tracker.name} <small>({t('tracker')})</small></li>
            ))}
          </ul>
          <p>{t('Those titles will restore, but stay unreadable until the source is installed.')}</p>
        </>
      )}
      <div className="restore-confirm-actions">
        <button type="button" onClick={clearRestore} disabled={busy !== null}>{t('Cancel')}</button>
        <button type="button" className="danger" onClick={confirmRestore} disabled={busy !== null}>
          {busy === 'restoring' ? t('Restoring…') : t('Overwrite library')}
        </button>
      </div>
    </div>
  ) : null

  const restoreDone = restoreStatus?.state === 'SUCCESS' ? (
    <div className="restore-confirm">
      <p>{t('Library restored. Reload the app to see it.')}</p>
      <div className="restore-confirm-actions">
        <button type="button" onClick={clearRestore}>{t('Done')}</button>
      </div>
    </div>
  ) : null

  const excluded = autoData ? excludedFromAutoBackup(autoData.settings) : []
  // The form shows what has been typed if anything has, and the server's own numbers otherwise — so it
  // fills in on load and does not fight a schedule changed from somewhere else.
  const form = schedule ?? {
    interval: autoData?.settings.backupInterval ?? 0,
    time: autoData?.settings.backupTime ?? '00:00',
    ttl: autoData?.settings.backupTTL ?? 0,
  }
  const scheduleChanged = Boolean(autoData && schedule && (
    schedule.interval !== autoData.settings.backupInterval
    || schedule.time !== autoData.settings.backupTime
    || schedule.ttl !== autoData.settings.backupTTL
  ))

  const backupCard = (
  <section className="settings-card settings-backup-card">
    <div><h2>{t('Backup')}</h2><p>{t('Download a copy of your library, source bindings and tracking links.')}</p></div>
    <div className="connection-action">
      {exportError
        ? <span className="inline-error">{exportError}</span>
        : <span>{backupResult.fetching ? t('Preparing…') : t('Ready to export')}</span>}
      <button
        type="button"
        className={`settings-icon-button settings-export-button${backupResult.fetching ? ' loading' : ''}`}
        disabled={backupResult.fetching}
        onClick={runExport}
        aria-label={t('Export a backup')}
        title={t('Export a backup')}
      ><Icon name="export" /></button>
    </div>
  </section>
  )

  const restoreCard = (
  <section className="settings-card settings-restore-card">
    <div>
      <h2>{t('Restore')}</h2>
      <p>{t('Load a backup file back in. This overwrites the library — export one first if in doubt.')}</p>
    </div>
    <div className="connection-action">
      <input
        ref={filePickerRef}
        type="file"
        accept=".tachibk,.proto.gz"
        className="visually-hidden"
        onChange={chooseBackup}
      />
      {restoreError ? (
        <span className="inline-error">{restoreError}</span>
      ) : restoreStatus ? (
        <span>{describeRestore(restoreStatus)}</span>
      ) : busy === 'validating' ? (
        <span>{t('Checking the file…')}</span>
      ) : (
        <span>{pendingBackup ? pendingBackup.name : t('No file chosen')}</span>
      )}
      <button
        type="button"
        className="settings-icon-button settings-restore-button"
        disabled={busy !== null}
        onClick={() => filePickerRef.current?.click()}
        aria-label={t('Choose a backup file')}
        title={t('Choose a backup file')}
      ><Icon name="restore" /></button>
    </div>

    {!pendingAuto && restoreConfirm}
    {!pendingAuto && restoreDone}
  </section>
  )

  // The backups the server takes on its own. Nothing here was reachable before: the schedule was
  // readable as settings, but when the job last ran and what it left on disk were not.
  const autoBackupCard = (
  <section className="settings-card settings-auto-backup-card">
    <div>
      <h2>{t('Automatic backups')}</h2>
      <p>{t('The server backs itself up on a schedule and keeps the recent ones. They stay on the machine it runs on.')}</p>
    </div>
    <div className="auto-backup-panel">
      {autoError ? (
        <span className="inline-error">{friendlyError(autoError)}</span>
      ) : !autoData ? (
        <span>{t('Looking…')}</span>
      ) : (
        <>
          <p className="auto-backup-status">
            {describeSchedule(autoData.settings)}
            {autoData.automatedBackups.lastRun
              ? t(' · last run {since}', { since: formatSince(Number(autoData.automatedBackups.lastRun)) })
              : t(' · has not run yet')}
          </p>
          {excluded.length > 0 && (
            <p className="auto-backup-status warn">
              {t('Leaving out {names} — those are not in the nightly copy.', { names: excluded.join(', ') })}
            </p>
          )}

          <div className="auto-backup-schedule">
            <label>
              <span>{t('Every')}</span>
              <input
                type="number"
                min={0}
                max={30}
                value={form.interval}
                onChange={(event) => setSchedule({ ...form, interval: Number(event.target.value) })}
                aria-label={t('Days between automatic backups, 0 to switch them off')}
              />
              <small>{form.interval === 0 ? t('days (off)') : form.interval === 1 ? t('day') : t('days')}</small>
            </label>
            <label>
              <span>{t('at')}</span>
              <input
                type="time"
                value={form.time}
                onChange={(event) => setSchedule({ ...form, time: event.target.value })}
                aria-label={t('Time of day the automatic backup runs')}
              />
            </label>
            <label>
              <span>{t('keep')}</span>
              <input
                type="number"
                min={0}
                max={365}
                value={form.ttl}
                onChange={(event) => setSchedule({ ...form, ttl: Number(event.target.value) })}
                aria-label={t('Days to keep an automatic backup, 0 to keep them until deleted')}
              />
              <small>{form.ttl === 0 ? t('days (forever)') : form.ttl === 1 ? t('day') : t('days')}</small>
            </label>
            <button
              type="button"
              className="settings-icon-button"
              disabled={savingSchedule || !scheduleChanged}
              onClick={saveSchedule}
              aria-label={t('Save the backup schedule')}
              title={scheduleChanged ? t('Save the schedule') : t('Nothing to save')}
            ><Icon name="confirm" /></button>
          </div>
          {scheduleError && <span className="inline-error">{scheduleError}</span>}

          {autoData.automatedBackups.files.length === 0 ? (
            <p className="auto-backup-status">{t('Nothing kept yet.')}</p>
          ) : (
            <ul className="auto-backup-list">
              {autoData.automatedBackups.files.map((file) => {
                const taken = formatBackupTaken(file.createdAt)
                const size = formatBackupSize(file.sizeBytes)
                return (
                  <li key={file.filename} className={pendingAuto === file.filename ? 'chosen' : ''}>
                    <span>
                      <time dateTime={taken.iso}>{taken.label}</time>
                      {size && <small>{size}</small>}
                    </span>
                    <button
                      type="button"
                      className="settings-icon-button settings-restore-button"
                      disabled={busy !== null}
                      onClick={() => chooseAutomatedBackup(file.filename)}
                      aria-label={t('Restore the backup from {when}', { when: taken.label })}
                      title={t('Restore this backup')}
                    ><Icon name="restore" /></button>
                  </li>
                )
              })}
            </ul>
          )}

          {pendingAuto && (
            <p className="auto-backup-status">
              {restoreError
                ? <span className="inline-error">{restoreError}</span>
                : restoreStatus
                  ? describeRestore(restoreStatus)
                  : busy === 'validating' ? t('Checking that backup…') : t('Ready to restore')}
            </p>
          )}
          {pendingAuto && restoreConfirm}
          {pendingAuto && restoreDone}
        </>
      )}
    </div>
  </section>
  )

  const themeCard = (
  <section className="settings-card settings-theme-card">
    <div><h2>{t('Theme')}</h2><p>{t('Choose the desk that feels best for browsing and reading.')}</p></div>
    <div className="theme-options" role="group" aria-label={t('Theme')}>
      {themeOptions.map((option) => {
        const selected = theme === option.value
        return (
          <button
            key={option.value}
            type="button"
            className={`theme-option${selected ? ' active' : ''}`}
            aria-pressed={selected}
            aria-label={t(option.label)}
            title={t(option.label)}
            onClick={() => chooseTheme(option.value)}
          >
            <span className={`theme-preview ${option.value}`} aria-hidden="true"><i /><i /><i /></span>
          </button>
        )
      })}
    </div>
  </section>
  )

  // Only what the app itself writes changes language. A title, a chapter name and a genre come from
  // the source that published them, and translating those would be inventing them.
  const languageCard = (
  <section className="settings-card settings-language-card">
    <div><h2>{t('Language')}</h2><p>{t('The language the app speaks. Titles, chapters and anything else a source writes stay as that source published them.')}</p></div>
    <div className="language-options" role="group" aria-label={t('Language')}>
      {languageOptions.map((option) => {
        const selected = language === option.value
        return (
          <button
            key={option.value}
            type="button"
            className={`language-option${selected ? ' active' : ''}`}
            aria-pressed={selected}
            aria-label={option.label}
            title={option.label}
            onClick={() => setLanguage(option.value)}
          >
            <span aria-hidden="true">{option.tag}</span>
          </button>
        )
      })}
    </div>
  </section>
  )

  return (
    <div className="settings-page settings-shell">
      <SettingsRail active={tab} onSelect={setTab} />
      <div className="settings-pane">
        {/* The tracking pane says what the connections are worth as two numbers and a bar rather
            than a row of small print: the count and the last sync are the two things people come
            here to check, and the split is the shape of the library behind them. The numbers are
            across every tracker, because the reader has one library however many lists it is on. */}
        {tab === 'tracking' && (
          <div className="anilist-pane">
            <header className="settings-pane-header">
              <span className="eyebrow">{t('Connections')}</span>
              <h1>{t('Tracking')}</h1>
            </header>

            {/* One card per tracker the server registered, rather than one banner for AniList.
                Import appears only on AniList's: `importAnilistLibrary` is a bulk export of one
                service's list, not part of the tracking loop, and it keeps its name for that
                reason. A tracker the installation has no client id for arrives with a null
                authUrl and draws as unconnectable, which is the state this card already had. */}
            {trackers.map((tracker) => {
              const isAnilist = tracker.id === ANILIST_TRACKER_ID
              return (
                <section
                  className={`anilist-banner${TRACKER_SLUGS[tracker.id] ? ` tracker-${TRACKER_SLUGS[tracker.id]}` : ''}`}
                  key={tracker.id}
                >
                  <TrackerAvatar name={tracker.user?.name ?? tracker.name} url={tracker.user?.avatarUrl ?? null} />
                  <div className="anilist-banner-copy">
                    <span className="anilist-banner-status">
                      <span className={`status-dot ${tracker.isLoggedIn ? 'online' : ''}`} />
                      {tracker.isLoggedIn ? t('Connected as') : t('Not connected')}
                    </span>
                    <h2>
                      {tracker.isLoggedIn
                        ? tracker.user?.name ?? tracker.name
                        : tracker.authUrl
                          ? t('Connect {name}', { name: tracker.name })
                          : t('{name} is not configured on this server', { name: tracker.name })}
                    </h2>
                    {isAnilist && importResult.error && <span className="inline-error">{friendlyError(importResult.error)}</span>}
                    {logoutResult.error && <span className="inline-error">{friendlyError(logoutResult.error)}</span>}
                    {isAnilist && importedCount !== null && (
                      <span className="anilist-banner-note">
                        {t(importedCount === 1 ? '{count} title imported' : '{count} titles imported', { count: importedCount })}
                      </span>
                    )}
                  </div>
                  {/* Import carries its word: it is the one slow, whole-library action on the page, and an
                      icon alone made it look as incidental as the avatar beside it. */}
                  <div className="anilist-banner-actions">
                    {tracker.isLoggedIn ? (
                      <>
                        {isAnilist && (
                          <button
                            type="button"
                            className={`settings-text-button${importResult.fetching ? ' loading' : ''}`}
                            disabled={importResult.fetching}
                            onClick={runImport}
                            title={t('Import your AniList list into the library')}
                          ><Icon name="import" />{importResult.fetching ? t('Importing…') : t('Import list')}</button>
                        )}
                        <button
                          type="button"
                          className={`settings-icon-button settings-disconnect-button${logoutResult.fetching ? ' loading' : ''}`}
                          disabled={logoutResult.fetching}
                          onClick={async () => {
                            await logoutTracker({ trackerId: tracker.id })
                            refetch({ requestPolicy: 'network-only' })
                          }}
                          aria-label={t('Disconnect {name}', { name: tracker.name })}
                          title={t('Disconnect {name}', { name: tracker.name })}
                        ><Icon name="disconnect" /></button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="settings-text-button"
                        disabled={!tracker.authUrl}
                        onClick={() => startTrackerLogin(tracker)}
                        title={t('Connect {name}', { name: tracker.name })}
                      >
                        <Icon name="connect" />{t('Connect')}
                      </button>
                    )}
                  </div>
                </section>
              )
            })}

            {anyConnected && (
              <>
                <div className="anilist-stats">
                  <div>
                    <strong>{byRemote.size}</strong>
                    <small>{t(byRemote.size === 1 ? 'Title tracked' : 'Titles tracked')}</small>
                  </div>
                  <div>
                    <strong>{lastSync === null ? t('Never') : formatSince(lastSync)}</strong>
                    <small>{t('Since last sync')}</small>
                  </div>
                </div>
                <ShelfSplit shelves={shelves} counts={shelfCounts} total={byRemote.size} />
              </>
            )}
          </div>
        )}

        {tab === 'statistics' && <LibraryStatsCard />}
        {tab === 'categories' && <CategoriesCard />}
        {/* Restore and the automatic backups share one restore flow, so they share one pane: a confirm
            panel must never land on a tab the user cannot see. */}
        {tab === 'backup' && <>{backupCard}{restoreCard}{autoBackupCard}</>}
        {tab === 'appearance' && themeCard}
        {tab === 'language' && languageCard}
      </div>
    </div>
  )
}
