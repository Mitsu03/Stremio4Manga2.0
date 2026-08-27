import { Client, cacheExchange, fetchExchange } from 'urql'
import { apiFetch } from './session'

export const client = new Client({
  url: '/api/graphql',
  preferGetMethod: false,
  // Behind the gateway a 401 means the session ended, and every query on the page will report it at
  // once. Routing them all through one fetch is what lets a single sign-in redirect answer the lot.
  fetch: apiFetch,
  exchanges: [cacheExchange, fetchExchange],
})
