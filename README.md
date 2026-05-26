# Restaurant POS Billing App

A Windows desktop POS for a single-item (Thali) restaurant.

- **Roles**: Manager (billing only) · Owner (billing + analytics + settings)
- **Billing**: split layout — quick plate-count buttons on the left, +/− counter, payment mode (cash/online), and lunch/dinner toggle on the right
- **Lunch / Dinner**: separate per-plate prices, toggleable from the header
- **Offline-first**: all bills are saved to local SQLite immediately; printing and syncing run in the background
- **Cloud backup**: pending bills are upserted to Supabase whenever internet is available
- **Token printing**: 80mm thermal printer (Hewlett BillQuick Lite H80i) via `electron-pos-printer` — uses the Windows printer driver

## Tech

- Electron + React + TypeScript + Vite
- better-sqlite3 (local DB) · Supabase JS (cloud) · Tailwind · Recharts

## First-time setup

```powershell
# 1. Install dependencies
npm install

# 2. Rebuild native modules for Electron (better-sqlite3)
npm run rebuild

# 3. Run in dev mode
npm run dev
```

Default logins (change them from Settings after first login):

- **manager** / `manager123`
- **owner** / `owner123`

## Setting up the printer

1. Install the manufacturer's Windows driver for the **Hewlett BillQuick Lite H80i** printer.
   - The H80i typically connects via USB and uses ESC/POS. Some units ship with a generic "Generic / Text Only" driver — that works too.
   - In the driver setup, set paper width to **80mm (576px / 48 chars/line)**.
2. **Critical driver settings** (Windows Settings → Printers → POS80/H80i → Printing Preferences → Page Settings → Print Options):
   - **Page End** → anything *except* `Ignore page tails blank`. The default trims the bottom whitespace and the cutter ends up clipping the last printed line.
   - **Feed after print** → set to ~7.5 mm (e.g. `2 × 3.75mm`). With "No Feed", the cutter has no clearance below the last line regardless of CSS.
2. In Windows → Settings → Bluetooth & devices → Printers, copy the printer's exact name.
3. Log in as **owner** → Settings → paste the name into "Windows Printer Name" → Save.

If you leave the field blank, it'll use the system default printer.

## Setting up Supabase backup (optional)

1. Create a free project at https://supabase.com.
2. Open the SQL Editor and paste the contents of [`supabase/schema.sql`](supabase/schema.sql). Run it.
3. In your Supabase project settings, copy:
   - Project URL (e.g. `https://xxxx.supabase.co`)
   - `anon` public API key
4. In the app, log in as **owner** → Settings → paste both → Save → click **Sync Now**.

After this, every new bill will be queued and synced to Supabase whenever the machine is online. If the internet is down, billing keeps working — bills sit in the local DB with `sync_status = 'pending'` and flush automatically when connectivity returns.

## Building the Windows installer

```powershell
npm run build
```

The `.exe` installer ends up in `release/`.

## Where data lives

- Local DB: `%APPDATA%\Restaurant POS\pos.db` (when packaged) or your Electron `userData` folder in dev
- Cloud DB: your Supabase `public.bills` table

## Project layout

```
electron/        Main process: DB, IPC, printer, sync
src/             React renderer (UI)
  pages/         LoginPage, BillingPage, AnalyticsPage, SettingsPage
  components/    AppLayout (header + meal toggle + sync indicator)
supabase/        SQL schema for the cloud table
```

## Notes

- Token numbers reset daily (sequence per calendar date).
- Lunch/dinner toggle defaults based on time of day (lunch 11:00–16:59).
- The sync queue retries automatically on the `online` event and when the user clicks **Sync Now**.
