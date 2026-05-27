/**
 * Built-in Supabase credentials.
 *
 * Paste your project's URL and anon (public) key below. These get baked into
 * the packaged installer so a freshly downloaded `.exe` syncs out of the box —
 * no per-install Settings step needed.
 *
 * The anon key is **safe to commit** to a public repo: it has no privileged
 * access on its own. Row Level Security policies in `supabase/schema.sql`
 * are what actually gate reads/writes. Never paste the `service_role` key here.
 *
 * Settings-page values (entered by an owner at runtime) and `process.env.*`
 * still take precedence over these constants — see `electron/sync.ts`.
 */
export const BUILT_IN_SUPABASE_URL = 'https://eenjkohufyjdlzjiabww.supabase.co';
export const BUILT_IN_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVlbmprb2h1ZnlqZGx6amlhYnd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4MDk2NDAsImV4cCI6MjA5NTM4NTY0MH0.cf2AkZmEkblCajkAeFQ4igg3BmW25IuXplS5K4jemqs';
