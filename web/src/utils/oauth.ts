/**
 * Starting a tracker's OAuth handshake, for the two kinds of handshake there are.
 *
 * AniList uses implicit grant: the browser comes back with the token in the fragment and there is
 * nothing to remember. MyAnimeList uses authorization code with PKCE, which needs a verifier that
 * outlives a full navigation away from this app — so the client is the only party still around to
 * hold it, and this is where it is held.
 *
 * `sessionStorage`, not `localStorage`: a half-finished sign-in belongs to this tab and should not
 * survive the browser being closed. It is cleared as it is read, so a stale verifier cannot be
 * replayed against a later attempt.
 */

const VERIFIER_KEY = 'stremio4manga:oauth-verifier'

/**
 * A PKCE verifier: 43-128 characters from the unreserved set, per RFC 7636. MyAnimeList accepts
 * only `code_challenge_method=plain`, so this string is also the challenge — which is why it can be
 * put straight on the auth URL without hashing anything.
 */
function newVerifier(): string {
  const bytes = new Uint8Array(64)
  crypto.getRandomValues(bytes)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}

function keyFor(trackerId: number): string {
  return `${VERIFIER_KEY}:${trackerId}`
}

/** The verifier this tab stashed before navigating away, removed as it is handed over. */
export function takeVerifier(trackerId: number): string | null {
  try {
    const key = keyFor(trackerId)
    const value = sessionStorage.getItem(key)
    sessionStorage.removeItem(key)
    return value
  } catch {
    // Private modes and locked-down browsers throw rather than returning null.
    return null
  }
}

export interface TrackerAuth {
  id: number
  authUrl: string | null
  authRequiresVerifier: boolean
}

/**
 * Send the browser to the tracker.
 *
 * `state` carries the tracker id as well as the redirect URL, because the single callback route is
 * shared and the page that receives it has to know whose callback it is holding before it can name
 * the verifier to send back.
 */
export function startTrackerLogin(tracker: TrackerAuth): void {
  if (!tracker.authUrl) return
  const url = new URL(tracker.authUrl)

  if (tracker.authRequiresVerifier) {
    const verifier = newVerifier()
    try {
      sessionStorage.setItem(keyFor(tracker.id), verifier)
    } catch {
      // Nothing to be done about a browser that will not keep it; the exchange
      // will fail with a message naming the missing verifier rather than here.
    }
    url.searchParams.set('code_challenge', verifier)
  }

  url.searchParams.set('state', JSON.stringify({
    redirectUrl: `${window.location.origin}/handle/oauth/result`,
    trackerId: tracker.id,
  }))
  window.location.assign(url)
}
