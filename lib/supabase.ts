import { createBrowserClient } from '@supabase/ssr'

const DEFAULT_URL = 'https://dczropngwfoxybdmybgw.supabase.co'
const DEFAULT_PUBLISHABLE_KEY = 'sb_publishable_Y65sof58bUDmppRbUwwV4g_yraQyqy3'

export function supabaseBrowser() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || DEFAULT_PUBLISHABLE_KEY
  return createBrowserClient(url, key)
}
