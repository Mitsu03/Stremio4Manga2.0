// Backup restore is the one call in the app that sends a file. The shared urql client is
// [cacheExchange, fetchExchange] and always posts JSON, so it cannot carry a multipart body; rather
// than swap in a multipart exchange for a single operation, these two calls are posted by hand.

import { apiFetch } from '../api/session'
import { t } from './i18n'

const GRAPHQL_URL = '/api/graphql'

interface GraphQLResponse<T> {
  data?: T
  errors?: Array<{ message: string }>
}

/**
 * Post an operation that takes a file, following the GraphQL multipart request spec.
 *
 * The file must be a **top-level** variable. `JavalinGraphQLRequestParser` resolves a map path with
 * `substringBefore('.')`, so `variables.backup` finds the `backup` variable but `variables.input.backup`
 * would look for a variable called `input` and inject nothing — the server would then reject the
 * request for a missing file. Write the operation as `($backup: Upload!)` and reference it from the
 * inline input object.
 */
export async function uploadGraphQL<T>(query: string, file: File): Promise<T> {
  const body = new FormData()
  body.append('operations', JSON.stringify({ query, variables: { backup: null } }))
  body.append('map', JSON.stringify({ 0: ['variables.backup'] }))
  body.append('0', file)

  // No Content-Type header: the browser has to set it so the multipart boundary comes with it.
  const response = await apiFetch(GRAPHQL_URL, { method: 'POST', body })
  if (!response.ok) throw new Error(`Server refused the upload (${response.status})`)

  const payload = (await response.json()) as GraphQLResponse<T>
  if (payload.errors?.length) throw new Error(payload.errors[0].message)
  if (!payload.data) throw new Error('The server returned no data for the upload.')

  return payload.data
}

export const VALIDATE_BACKUP_QUERY = `
  query ValidateBackup($backup: Upload!) {
    validateBackup(input: { backup: $backup }) {
      missingSources { id name }
      missingTrackers { name }
    }
  }
`

export const RESTORE_BACKUP_MUTATION = `
  mutation RestoreBackup($backup: Upload!) {
    restoreBackup(input: { backup: $backup }) {
      id
      status { state totalManga mangaProgress }
    }
  }
`

export const RESTORE_STATUS_QUERY = `
  query RestoreStatus($id: String!) {
    restoreStatus(id: $id) { state totalManga mangaProgress }
  }
`

// The backups the server takes on its own. Unlike everything above, none of these send a file: the
// server already holds them, so a filename it reported is the whole request.
export const AUTOMATED_BACKUPS_QUERY = `
  query AutomatedBackups {
    automatedBackups {
      lastRun
      files { filename sizeBytes createdAt }
    }
    settings {
      backupInterval
      backupTime
      backupTTL
      autoBackupIncludeManga
      autoBackupIncludeCategories
      autoBackupIncludeChapters
      autoBackupIncludeTracking
      autoBackupIncludeHistory
      autoBackupIncludeClientData
      autoBackupIncludeServerSettings
    }
  }
`

export const VALIDATE_AUTOMATED_BACKUP_QUERY = `
  query ValidateAutomatedBackup($filename: String!) {
    validateAutomatedBackup(filename: $filename) {
      missingSources { id name }
      missingTrackers { name }
    }
  }
`

export const RESTORE_AUTOMATED_BACKUP_MUTATION = `
  mutation RestoreAutomatedBackup($filename: String!) {
    restoreAutomatedBackup(input: { filename: $filename }) {
      id
      status { state totalManga mangaProgress }
    }
  }
`

// backupInterval and backupTTL are Int days — 0 means off for the first and "keep forever" for the
// second — and backupTime is "HH:MM".
export const SET_BACKUP_SCHEDULE_MUTATION = `
  mutation SetBackupSchedule($interval: Int!, $time: String!, $ttl: Int!) {
    setSettings(input: { settings: { backupInterval: $interval, backupTime: $time, backupTTL: $ttl } }) {
      settings { backupInterval backupTime backupTTL }
    }
  }
`

/** `Long` on the server, so all three of these arrive as strings and need `Number()` first. */
export interface AutomatedBackupFile {
  filename: string
  sizeBytes: string
  createdAt: string
}

export interface BackupScheduleSettings {
  backupInterval: number
  backupTime: string
  backupTTL: number
  autoBackupIncludeManga: boolean
  autoBackupIncludeCategories: boolean
  autoBackupIncludeChapters: boolean
  autoBackupIncludeTracking: boolean
  autoBackupIncludeHistory: boolean
  autoBackupIncludeClientData: boolean
  autoBackupIncludeServerSettings: boolean
}

export interface AutomatedBackupsResult {
  automatedBackups: { lastRun: string | null; files: AutomatedBackupFile[] }
  settings: BackupScheduleSettings
}

export interface ValidateAutomatedBackupResult {
  validateAutomatedBackup: ValidateBackupResult['validateBackup']
}

export interface RestoreAutomatedBackupResult {
  restoreAutomatedBackup: { id: string; status: BackupRestoreStatus | null }
}

/** The schedule in one line, or what its being off means. */
export function describeSchedule(settings: BackupScheduleSettings): string {
  if (settings.backupInterval <= 0) return t('Switched off — nothing is being backed up on its own')
  const every = settings.backupInterval === 1
    ? t('Every day')
    : t('Every {count} days', { count: settings.backupInterval })
  const kept = settings.backupTTL <= 0
    ? t('kept until deleted')
    : t(settings.backupTTL === 1 ? 'kept {count} day' : 'kept {count} days', { count: settings.backupTTL })
  return t('{every} at {time}, {kept}', { every, time: settings.backupTime, kept })
}

/**
 * Which parts of the library the nightly backup leaves out.
 *
 * All seven default to on, so this is normally empty — and a list of switches for narrowing your own
 * safety net is not worth building. What is worth saying is when one of them is already off.
 */
export function excludedFromAutoBackup(settings: BackupScheduleSettings): string[] {
  const parts: Array<[boolean, string]> = [
    [settings.autoBackupIncludeManga, t('titles')],
    [settings.autoBackupIncludeCategories, t('categories')],
    [settings.autoBackupIncludeChapters, t('chapters')],
    [settings.autoBackupIncludeTracking, t('tracking')],
    [settings.autoBackupIncludeHistory, t('history')],
    [settings.autoBackupIncludeClientData, t('app data')],
    [settings.autoBackupIncludeServerSettings, t('server settings')],
  ]
  return parts.filter(([included]) => !included).map(([, name]) => name)
}

/**
 * When a backup was taken, worded like the chapter dates in the chapter list — same date, same
 * hour-and-minute, no seconds: which night a backup is from is the question, not which second.
 */
export function formatBackupTaken(createdAt: string): { label: string; iso: string } {
  const taken = new Date(Number(createdAt))
  return {
    label: `${taken.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}, ${taken.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`,
    iso: taken.toISOString(),
  }
}

export function formatBackupSize(sizeBytes: string): string {
  const bytes = Number(sizeBytes)
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export type BackupRestoreState =
  | 'IDLE'
  | 'SUCCESS'
  | 'FAILURE'
  | 'RESTORING_CATEGORIES'
  | 'RESTORING_MANGA'
  | 'RESTORING_META'
  | 'RESTORING_SETTINGS'

export interface BackupRestoreStatus {
  state: BackupRestoreState
  totalManga: number
  mangaProgress: number
}

export interface ValidateBackupResult {
  validateBackup: {
    missingSources: Array<{ id: string; name: string }>
    missingTrackers: Array<{ name: string }>
  }
}

export interface RestoreBackupResult {
  restoreBackup: { id: string; status: BackupRestoreStatus | null }
}

/** Restoring is done when the server reports either terminal state; everything else is in-flight. */
export function isRestoreFinished(state: BackupRestoreState): boolean {
  return state === 'SUCCESS' || state === 'FAILURE'
}

export function describeRestore(status: BackupRestoreStatus): string {
  switch (status.state) {
    case 'SUCCESS': return t('Restore complete')
    case 'FAILURE': return t('Restore failed')
    case 'RESTORING_CATEGORIES': return t('Restoring categories…')
    case 'RESTORING_META': return t('Restoring metadata…')
    case 'RESTORING_SETTINGS': return t('Restoring settings…')
    case 'RESTORING_MANGA':
      return status.totalManga > 0
        ? t('Restoring titles… {done}/{total}', { done: status.mangaProgress, total: status.totalManga })
        : t('Restoring titles…')
    default: return t('Waiting for the server…')
  }
}
