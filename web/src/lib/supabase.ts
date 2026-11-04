import { createClient } from '@supabase/supabase-js'

/**
 * The client needs only the project's address (https://<ref>.supabase.co). Copying "…/rest/v1/" or a trailing slash
 * from the dashboard is common, and it makes every sign-in fail with "Invalid path specified in request URL",
 * so anything after the address is dropped.
 */
function projectUrl(raw: string | undefined): string | undefined {
  const text = raw?.trim()
  if (!text) return undefined
  try {
    return new URL(text).origin
  } catch {
    return text
  }
}

const url = projectUrl(import.meta.env.VITE_SUPABASE_URL)
const key = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()

/** False until .env.local has been filled in; the app then shows a setup screen instead of failing. */
export const isConfigured = Boolean(url && key)

// The same project URL and anon/publishable key are used by the Flutter app.
// Never ship the service_role key in a client.
export const supabase = createClient(
  url ?? 'http://localhost:54321',
  key ?? 'not-configured',
  { auth: { persistSession: true, autoRefreshToken: true } },
)
