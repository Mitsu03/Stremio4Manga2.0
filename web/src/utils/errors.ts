import { t } from './i18n'

// The default is a default *parameter*, evaluated on every call, so it is translated at the moment
// the error is reported rather than at import time.
export function friendlyError(
  error: { message: string } | null | undefined,
  fallback = t('Something went wrong. Please try again.'),
): string {
  const firstLine = error?.message.split(/\r?\n/, 1)[0]?.trim()
  if (!firstLine) return fallback

  return firstLine
    .replace(/^\[(?:GraphQL|Network)\]\s*/, '')
    .replace(/^Exception while fetching data \([^)]*\)\s*:\s*/, '')
}
