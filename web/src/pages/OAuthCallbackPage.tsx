import { useEffect, useRef, useState } from 'react'
import { useMutation } from 'urql'
import { Link } from 'react-router-dom'
import { friendlyError } from '../utils/errors'
import { t } from '../utils/i18n'

const LOGIN_TRACKER_MUTATION = `
  mutation LoginTrackerOAuth($trackerId: Int!, $callbackUrl: String!) {
    loginTrackerOAuth(input: { trackerId: $trackerId, callbackUrl: $callbackUrl }) {
      isLoggedIn
      tracker {
        name
      }
    }
  }
`

export default function OAuthCallbackPage() {
  const [, loginTracker] = useMutation(LOGIN_TRACKER_MUTATION)
  const callbackStarted = useRef(false)
  const [status, setStatus] = useState(t('Finishing AniList sign-in...'))
  const [complete, setComplete] = useState(false)

  useEffect(() => {
    if (callbackStarted.current) return
    callbackStarted.current = true

    const params = new URLSearchParams(window.location.search)
    const state = params.get('state')
    let trackerId = 2
    if (state) {
      try {
        trackerId = Number(JSON.parse(state).trackerId) || trackerId
      } catch {
        // The callback still contains the token; the AniList tracker id is stable.
      }
    }

    loginTracker({ trackerId, callbackUrl: window.location.href }).then((result) => {
      if (result.error || !result.data?.loginTrackerOAuth.isLoggedIn) {
        setStatus(friendlyError(result.error, t('AniList sign-in could not be completed.')))
        return
      }
      setComplete(true)
      setStatus(t('AniList is connected.'))
    })
  }, [loginTracker])

  return (
    <section className="state-panel">
      <span className="eyebrow">{t('Account connection')}</span>
      <h1>{status}</h1>
      <p>{complete ? t('You can now import your reading list.') : t('Keep this tab open while the server verifies the callback.')}</p>
      {complete && <Link className="button primary" to="/search">{t('Import my library')}</Link>}
    </section>
  )
}
