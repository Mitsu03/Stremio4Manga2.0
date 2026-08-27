import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from 'urql'
import { Link } from 'react-router-dom'
import { friendlyError } from '../utils/errors'
import { t } from '../utils/i18n'
import {
  cleanupReassurance,
  CLEAR_DOWNLOADER_MUTATION,
  DELETE_DOWNLOADS_MUTATION,
  DEQUEUE_DOWNLOADS_MUTATION,
  DOWNLOADED_CHAPTERS_QUERY,
  REORDER_DOWNLOAD_MUTATION,
  START_DOWNLOADER_MUTATION,
  STOP_DOWNLOADER_MUTATION,
  cleanupQuestion,
  describeDownload,
  useDownloadQueue,
} from '../utils/downloads'

interface DownloadedChapter {
  id: number
  name: string
  sourceOrder: number
  chapterNumber: number
  isRead: boolean
  manga: { id: number; title: string; thumbnailUrl: string | null }
}

interface DownloadedChaptersResult {
  chapters: { nodes: DownloadedChapter[] }
}

/** Which delete a row is asking about: everything it holds, or only the chapters already read. */
type DeleteScope = 'all' | 'read'

type IconName = 'start' | 'stop' | 'clear' | 'cleanRead' | 'up' | 'down' | 'remove' | 'confirm' | 'cancel'

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    start: <path d="M7 4.5 19 12 7 19.5V4.5Z" />,
    stop: <><path d="M8 5.5h2.5v13H8zM13.5 5.5H16v13h-2.5z" /></>,
    clear: <><path d="M5 7h14" /><path d="M9 7V5h6v2" /><path d="M7 7v12a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 17 19V7" /></>,
    // A narrower bin with a tick hanging off its corner: next to `clear`'s full-width bin the
    // silhouettes differ at 16px, which two bins distinguished only by an inner mark do not.
    cleanRead: <><path d="M3.5 9h9" /><path d="M6.5 9V7h3v2" /><path d="M5 9v10.5a1.5 1.5 0 0 0 1.5 1.5h3a1.5 1.5 0 0 0 1.5-1.5V9" /><path d="m14.5 7.5 2.25 2.25L21 5" /></>,
    up: <><path d="M12 19V6" /><path d="m6 12 6-6 6 6" /></>,
    down: <><path d="M12 5v13" /><path d="m6 12 6 6 6-6" /></>,
    remove: <path d="M6 6l12 12M18 6 6 18" />,
    confirm: <path d="m5 12.5 4.5 4.5L19 7.5" />,
    cancel: <path d="M6 6l12 12M18 6 6 18" />,
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>
}

export default function DownloadsPage() {
  const { status, queueKey, refresh } = useDownloadQueue()
  const [{ data: diskData, fetching: diskFetching, error: diskError }, refetchDisk] = useQuery<DownloadedChaptersResult>({
    query: DOWNLOADED_CHAPTERS_QUERY,
    requestPolicy: 'cache-and-network',
  })
  const [, startDownloader] = useMutation(START_DOWNLOADER_MUTATION)
  const [, stopDownloader] = useMutation(STOP_DOWNLOADER_MUTATION)
  const [, clearDownloader] = useMutation(CLEAR_DOWNLOADER_MUTATION)
  const [, dequeueDownloads] = useMutation(DEQUEUE_DOWNLOADS_MUTATION)
  const [, reorderDownload] = useMutation(REORDER_DOWNLOAD_MUTATION)
  const [, deleteDownloads] = useMutation(DELETE_DOWNLOADS_MUTATION)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  // Which row is asking, and about which of its two deletes. One piece of state for both, because a
  // row can only be asking one question at a time.
  const [confirmingDelete, setConfirmingDelete] = useState<{ mangaId: number; scope: DeleteScope } | null>(null)
  const [confirmingCleanup, setConfirmingCleanup] = useState(false)

  const queue = useMemo(() => [...(status?.queue ?? [])].sort((a, b) => a.position - b.position), [status])

  // A chapter leaving the queue is what "it is on disk now" looks like — the entry vanishes when it
  // is written, and nothing else announces it. Waiting for the whole queue to drain would leave this
  // list stale for as long as the queue is busy, which is exactly when it is being watched.
  const seenQueue = useRef(queueKey)
  useEffect(() => {
    if (seenQueue.current === queueKey) return
    seenQueue.current = queueKey
    refetchDisk({ requestPolicy: 'network-only' })
  }, [queueKey, refetchDisk])

  const run = async (action: Promise<{ error?: { message: string } | null }>, alsoDisk = false) => {
    setBusy(true)
    setFailure(null)
    const result = await action
    if (result.error) setFailure(friendlyError(result.error))
    refresh()
    if (alsoDisk) await refetchDisk({ requestPolicy: 'network-only' })
    setBusy(false)
  }

  // One title's downloads, newest chapter first, so a long-running series reads top-down like the
  // chapter list does. `read` is carried alongside rather than filtered out: the row reports how much
  // of what it holds has been read, and the cleanup button acts on exactly that.
  const onDisk = useMemo(() => {
    const groups = new Map<number, { manga: DownloadedChapter['manga']; chapters: DownloadedChapter[]; read: DownloadedChapter[] }>()
    for (const chapter of diskData?.chapters.nodes ?? []) {
      const group = groups.get(chapter.manga.id) ?? { manga: chapter.manga, chapters: [], read: [] }
      group.chapters.push(chapter)
      if (chapter.isRead) group.read.push(chapter)
      groups.set(chapter.manga.id, group)
    }
    for (const group of groups.values()) group.chapters.sort((a, b) => b.chapterNumber - a.chapterNumber || b.sourceOrder - a.sourceOrder)
    return [...groups.values()].sort((a, b) => a.manga.title.localeCompare(b.manga.title))
  }, [diskData])

  const downloadedCount = diskData?.chapters.nodes.length ?? 0
  // Everything read across every title, for the one action that reclaims the disk in a single press.
  const readOnDisk = useMemo(() => (diskData?.chapters.nodes ?? []).filter((chapter) => chapter.isRead), [diskData])
  const readTitles = useMemo(() => new Set(readOnDisk.map((chapter) => chapter.manga.id)).size, [readOnDisk])

  return (
    <div className="downloads-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">{t('Offline')}</span>
          <h1>{t('Downloads')}</h1>
        </div>
        <div className="heading-actions">
          <p>{queue.length > 0 ? t('{count} queued', { count: queue.length }) : t('Queue empty')}</p>
          {status?.state === 'STARTED' ? (
            <button
              type="button"
              className="download-icon-button active"
              onClick={() => run(stopDownloader({}))}
              disabled={busy}
              aria-label={t('Pause the downloader')}
              title={t('Pause')}
            ><Icon name="stop" /></button>
          ) : (
            <button
              type="button"
              className="download-icon-button"
              onClick={() => run(startDownloader({}))}
              disabled={busy || queue.length === 0}
              aria-label={t('Start the downloader')}
              title={t('Start')}
            ><Icon name="start" /></button>
          )}
          <button
            type="button"
            className="download-icon-button danger"
            onClick={() => run(clearDownloader({}))}
            disabled={busy || queue.length === 0}
            aria-label={t('Clear the queue')}
            title={t('Clear the queue')}
          ><Icon name="clear" /></button>
        </div>
      </header>

      {failure && <div className="notice error">{failure}</div>}

      <section className="shelf">
        <div className="shelf-heading">
          <h2>{t('Queue')}</h2>
          <span>{status?.state === 'STARTED' ? t('running') : queue.length > 0 ? t('paused') : t('idle')}</span>
        </div>
        {queue.length === 0 ? (
          <div className="state-panel compact">
            <p>{t('Nothing is downloading. Send chapters here from a title\u2019s chapter list.')}</p>
          </div>
        ) : (
          <ul className="download-list">
            {queue.map((item, index) => (
              <li key={item.chapter.id} className={`download-row${item.state === 'ERROR' ? ' failed' : ''}`}>
                {item.manga.thumbnailUrl
                  ? <img src={item.manga.thumbnailUrl} alt="" loading="lazy" />
                  : <div className="cover-placeholder" />}
                <div className="download-copy">
                  <Link to={`/manga/${item.manga.id}`}><strong>{item.manga.title}</strong></Link>
                  <small>{item.chapter.name}</small>
                  <div className="download-progress" aria-hidden="true">
                    <i style={{ width: `${Math.round(item.progress * 100)}%` }} />
                  </div>
                </div>
                <span className="download-state">{describeDownload(item)}</span>
                <button
                  type="button"
                  className="download-icon-button small"
                  onClick={() => run(reorderDownload({ chapterId: item.chapter.id, to: index - 1 }))}
                  disabled={busy || index === 0}
                  aria-label={t('Move {name} up the queue', { name: item.chapter.name })}
                  title={t('Move up')}
                ><Icon name="up" /></button>
                <button
                  type="button"
                  className="download-icon-button small"
                  onClick={() => run(reorderDownload({ chapterId: item.chapter.id, to: index + 1 }))}
                  disabled={busy || index === queue.length - 1}
                  aria-label={t('Move {name} down the queue', { name: item.chapter.name })}
                  title={t('Move down')}
                ><Icon name="down" /></button>
                <button
                  type="button"
                  className="download-icon-button small danger"
                  onClick={() => run(dequeueDownloads({ ids: [item.chapter.id] }))}
                  disabled={busy}
                  aria-label={t('Take {name} out of the queue', { name: item.chapter.name })}
                  title={t('Remove')}
                ><Icon name="remove" /></button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="shelf">
        <div className="shelf-heading">
          <h2>{t('On this device')}</h2>
          <span>{t(downloadedCount === 1 ? '{count} chapter' : '{count} chapters', { count: downloadedCount })}{readOnDisk.length > 0 ? t(' · {count} read', { count: readOnDisk.length }) : ''}</span>
          {/* Nothing deletes a read chapter on its own — this is the only thing that reclaims the
              disk in one press, and it still asks first. */}
          {readOnDisk.length > 0 && !confirmingCleanup && (
            <button
              type="button"
              className="download-icon-button small danger shelf-heading-action"
              onClick={() => setConfirmingCleanup(true)}
              disabled={busy}
              aria-label={t(readOnDisk.length === 1
                ? 'Delete the {count} read chapter stored on this device'
                : 'Delete the {count} read chapters stored on this device', { count: readOnDisk.length })}
              title={t('Delete read chapters')}
            ><Icon name="cleanRead" /></button>
          )}
        </div>
        {confirmingCleanup && (
          <div className="notice cleanup-notice">
            <span>{cleanupQuestion(readOnDisk.length, readTitles)} {cleanupReassurance()}</span>
            <button
              type="button"
              className="button danger"
              onClick={async () => {
                await run(deleteDownloads({ ids: readOnDisk.map((chapter) => chapter.id) }), true)
                setConfirmingCleanup(false)
              }}
              disabled={busy}
            >{t('Delete')}</button>
            <button type="button" className="button quiet" onClick={() => setConfirmingCleanup(false)} disabled={busy}>{t('Keep')}</button>
          </div>
        )}
        {diskError && <div className="notice error">{friendlyError(diskError)}</div>}
        {onDisk.length === 0 ? (
          <div className="state-panel compact">
            <p>{diskFetching ? t('Looking…') : t('No chapters are stored on this device yet.')}</p>
          </div>
        ) : (
          <ul className="download-list">
            {onDisk.map(({ manga, chapters, read }) => {
              const asking = confirmingDelete?.mangaId === manga.id ? confirmingDelete.scope : null
              const doomed = asking === 'read' ? read : chapters
              return (
                <li key={manga.id} className="download-row">
                  {manga.thumbnailUrl
                    ? <img src={manga.thumbnailUrl} alt="" loading="lazy" />
                    : <div className="cover-placeholder" />}
                  <div className="download-copy">
                    <Link to={`/manga/${manga.id}`}><strong>{manga.title}</strong></Link>
                    <small>
                      {t(chapters.length === 1 ? '{count} chapter' : '{count} chapters', { count: chapters.length })}
                      {read.length > 0 ? t(' · {count} read', { count: read.length }) : ''}{t(' · newest {name}', { name: chapters[0].name })}
                    </small>
                  </div>
                  {asking ? (
                    <>
                      <span className="download-state">{asking === 'read'
                        ? t('Delete {count} read?', { count: doomed.length })
                        : t('Delete {count}?', { count: doomed.length })}</span>
                      <button
                        type="button"
                        className="download-icon-button small danger"
                        onClick={async () => {
                          await run(deleteDownloads({ ids: doomed.map((chapter) => chapter.id) }), true)
                          setConfirmingDelete(null)
                        }}
                        disabled={busy}
                        aria-label={asking === 'read'
                          ? t(read.length === 1
                            ? 'Delete the {count} read downloaded chapter of {title}'
                            : 'Delete the {count} read downloaded chapters of {title}', { count: read.length, title: manga.title })
                          : t('Delete every downloaded chapter of {title}', { title: manga.title })}
                        title={t('Delete')}
                      ><Icon name="confirm" /></button>
                      <button
                        type="button"
                        className="download-icon-button small"
                        onClick={() => setConfirmingDelete(null)}
                        disabled={busy}
                        aria-label={t('Keep them')}
                        title={t('Keep')}
                      ><Icon name="cancel" /></button>
                    </>
                  ) : (
                    <>
                      {/* Only offered where it says something the delete-everything button does not:
                          with every chapter read the two would delete the same files. */}
                      {read.length > 0 && read.length < chapters.length && (
                        <button
                          type="button"
                          className="download-icon-button small danger"
                          onClick={() => setConfirmingDelete({ mangaId: manga.id, scope: 'read' })}
                          disabled={busy}
                          aria-label={t(read.length === 1
                            ? 'Delete the {count} read downloaded chapter of {title}'
                            : 'Delete the {count} read downloaded chapters of {title}', { count: read.length, title: manga.title })}
                          title={t('Delete read chapters')}
                        ><Icon name="cleanRead" /></button>
                      )}
                      <button
                        type="button"
                        className="download-icon-button small danger"
                        onClick={() => setConfirmingDelete({ mangaId: manga.id, scope: 'all' })}
                        disabled={busy}
                        aria-label={t('Delete the downloads of {title}', { title: manga.title })}
                        title={t('Delete downloads')}
                      ><Icon name="clear" /></button>
                    </>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
