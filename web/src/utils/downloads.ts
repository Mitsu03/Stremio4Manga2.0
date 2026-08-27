/**
 * The chapter downloader — the queue, what is already on disk, and the poll that keeps both live.
 *
 * Shared because the chapter list and the Downloads screen are two views of one queue: a chapter row
 * showing its own progress and a screen showing everybody's.
 */
import { useEffect } from 'react'
import { useQuery } from 'urql'

export type DownloadState = 'QUEUED' | 'DOWNLOADING' | 'FINISHED' | 'ERROR'
export type DownloaderState = 'STARTED' | 'STOPPED'

export interface DownloadItem {
  position: number
  /** 0 to 1. */
  progress: number
  state: DownloadState
  tries: number
  chapter: { id: number; name: string; sourceOrder: number }
  manga: { id: number; title: string; thumbnailUrl: string | null }
}

export interface DownloadStatus {
  state: DownloaderState
  queue: DownloadItem[]
}

export interface DownloadStatusResult {
  downloadStatus: DownloadStatus
}

import { t } from './i18n'

export const DOWNLOAD_STATUS_QUERY = `
  query DownloadStatus {
    downloadStatus {
      state
      queue {
        position
        progress
        state
        tries
        chapter { id name sourceOrder }
        manga { id title thumbnailUrl }
      }
    }
  }
`

// What survives a finished download: the queue entry is gone the moment the chapter is written, so
// this is the only way to answer "what is on disk".
//
// `isRead` rides along because a chapter that has been read is the one worth reclaiming the disk
// from, and nothing tells the client when a chapter flipped: the reader reports a page number and the
// *server* sets `isRead` on the last one, so the only way to know is to ask.
export const DOWNLOADED_CHAPTERS_QUERY = `
  query DownloadedChapters {
    chapters(filter: { isDownloaded: { equalTo: true } }) {
      nodes {
        id
        name
        sourceOrder
        chapterNumber
        isRead
        manga { id title thumbnailUrl }
      }
    }
  }
`

export const ENQUEUE_DOWNLOADS_MUTATION = `
  mutation EnqueueDownloads($ids: [Int!]!) {
    enqueueChapterDownloads(input: { ids: $ids }) {
      downloadStatus { state queue { position chapter { id } } }
    }
  }
`

export const DEQUEUE_DOWNLOADS_MUTATION = `
  mutation DequeueDownloads($ids: [Int!]!) {
    dequeueChapterDownloads(input: { ids: $ids }) {
      downloadStatus { state queue { position chapter { id } } }
    }
  }
`

export const START_DOWNLOADER_MUTATION = `
  mutation StartDownloader {
    startDownloader(input: {}) { downloadStatus { state } }
  }
`

export const STOP_DOWNLOADER_MUTATION = `
  mutation StopDownloader {
    stopDownloader(input: {}) { downloadStatus { state } }
  }
`

export const CLEAR_DOWNLOADER_MUTATION = `
  mutation ClearDownloader {
    clearDownloader(input: {}) { downloadStatus { state queue { position } } }
  }
`

export const REORDER_DOWNLOAD_MUTATION = `
  mutation ReorderDownload($chapterId: Int!, $to: Int!) {
    reorderChapterDownload(input: { chapterId: $chapterId, to: $to }) {
      downloadStatus { queue { position chapter { id } } }
    }
  }
`

export const DELETE_DOWNLOADS_MUTATION = `
  mutation DeleteDownloads($ids: [Int!]!) {
    deleteDownloadedChapters(input: { ids: $ids }) {
      chapters { id isDownloaded }
    }
  }
`

/**
 * The queue, polled while there is anything happening.
 *
 * Enqueuing does **not** start the downloader — a chapter sits at QUEUED with the downloader STOPPED
 * until something calls `startDownloader` — so every caller that enqueues also starts, and the
 * downloader puts itself back to STOPPED when the queue drains.
 *
 * A second per tick while it runs, nothing at all while it does not: `DownloadUpdate` only arrives
 * over a subscription this client has no transport for, and an idle tab must not sit there asking
 * forever.
 *
 * `queueKey` is the membership of the queue rather than its progress, so it changes exactly when a
 * chapter joins or leaves — and a chapter *leaving* is the only signal that it was written to disk,
 * since the entry is gone before anything reports it finished. Anything holding `isDownloaded` has to
 * re-read on that, not on the queue draining: a chapter finishing while eight others are still
 * queued would otherwise go unnoticed.
 */
export function useDownloadQueue(pause = false): {
  status: DownloadStatus | null
  running: boolean
  queueKey: string
  refresh: () => void
} {
  const [{ data }, refetch] = useQuery<DownloadStatusResult>({
    query: DOWNLOAD_STATUS_QUERY,
    pause,
    requestPolicy: 'cache-and-network',
  })
  const status = data?.downloadStatus ?? null
  const running = Boolean(status && (status.state === 'STARTED' || status.queue.length > 0))

  useEffect(() => {
    if (pause || !running) return
    const timer = window.setInterval(() => refetch({ requestPolicy: 'network-only' }), 1000)
    return () => window.clearInterval(timer)
  }, [pause, refetch, running])

  const queueKey = (status?.queue ?? []).map((item) => item.chapter.id).join(',')

  return { status, running, queueKey, refresh: () => refetch({ requestPolicy: 'network-only' }) }
}

/** The queue keyed by chapter, for a row that wants to know about itself. */
export function queueByChapter(status: DownloadStatus | null): Map<number, DownloadItem> {
  return new Map((status?.queue ?? []).map((item) => [item.chapter.id, item]))
}

/**
 * The question both cleanup confirmations ask, so the chapter list and the Downloads screen word the
 * same destructive action the same way.
 *
 * Nothing deletes a read chapter on its own: `deleteDownloadedChapters` is only ever reached from a
 * button someone pressed, and the second press is what confirms it.
 */
export function cleanupQuestion(chapters: number, titles?: number): string {
  const count = t(chapters === 1 ? '{count} read chapter' : '{count} read chapters', { count: chapters })
  const scope = titles === undefined
    ? ''
    : t(titles === 1 ? ' across {count} title' : ' across {count} titles', { count: titles })
  return t('Delete {what}{scope} from this device?', { what: count, scope })
}

/** Why the deletion is recoverable — files go, read state and the ability to re-download stay. */
export const cleanupReassurance = (): string => t('They stay read, and can be downloaded again.')

export function describeDownload(item: DownloadItem): string {
  if (item.state === 'ERROR') {
    return item.tries > 0
      ? t(item.tries === 1 ? 'Failed after {count} try' : 'Failed after {count} tries', { count: item.tries })
      : t('Failed')
  }
  if (item.state === 'DOWNLOADING') return `${Math.round(item.progress * 100)}%`
  if (item.state === 'FINISHED') return t('Done')
  return t('Queued')
}
