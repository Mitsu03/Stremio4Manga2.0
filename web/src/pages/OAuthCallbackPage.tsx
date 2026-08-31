import { useEffect, useRef, useState } from 'react'
import { useMutation } from 'urql'
import { Link } from 'react-router-dom'
import { friendlyError } from '../utils/errors'
import { t } from '../utils/i18n'
import { takeVerifier } from '../utils/oauth'

const LOGIN_TRACKER_MUTATION = `
  mutation LoginTrackerOAuth($trackerId: Int!, $callbackUrl: String!, $codeVerifier: String) {
    loginTrackerOAuth(input: { trackerId: $trackerId, callbackUrl: $callbackUrl, codeVerifier: $codeVerifier }) {
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
  const [status, setStatus] = useState(t('Finishing sign-in...'))
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
        // The callback still contains the token, and AniList's id is the stable
        // default this route had before any second tracker existed.
      }
    }

    // Null for an implicit grant, which has nothing to redeem; the server ignores
    // it in that case rather than the client having to know which grant this was.
    const codeVerifier = takeVerifier(trackerId)

    loginTracker({ trackerId, callbackUrl: window.location.href, codeVerifier }).then((result) => {
      if (result.error || !result.data?.loginTrackerOAuth.isLoggedIn) {
        setStatus(friendlyError(result.error, t('The sign-in could not be completed.')))
        return
      }
      setComplete(true)
      setStatus(t('{name} is connected.', { name: result.data.loginTrackerOAuth.tracker.name }))
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
