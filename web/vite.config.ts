import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // The dev server has no API of its own: `/api` belongs to the Node server, which serves the
      // built UI itself in production and listens on 8080 by default (`server/src/config.ts`).
      //
      // Overridable because a server started for a test run is deliberately *not* on the default
      // port — an isolated instance leaves the real one alone — and a proxy that cannot follow it
      // points the dev UI at a port nobody is on:
      // `S4M_DEV_PROXY=http://localhost:8099 npm run dev`.
      '/api': {
        target: process.env.S4M_DEV_PROXY ?? 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
})
