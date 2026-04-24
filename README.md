# FleetLine Supabase

FleetLine is a React PWA for small motorcycle-fleet odometer submissions and fuel-cost reporting. This version targets Supabase instead of Firebase and keeps v1 focused on riders, readings, photos, admin tools, CSV export, WhatsApp share, and offline queueing.

## Local Development

```powershell
npm.cmd install
npm.cmd run dev
```

Open `http://localhost:5173/`.

If `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are missing, the app runs in local demo mode so the UI can be reviewed without a backend.

Demo mode credentials:

```text
Admin: any email + any password
Rider: Ali or Sara, PIN 1234
```

## Environment

Create `.env.local` for local development:

```text
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

Only `VITE_` values are exposed to the browser. Do not commit service-role keys or Supabase JWT secrets.

## Supabase

The project includes:

```text
supabase/migrations/0001_init.sql
supabase/functions/rider-login
supabase/functions/invite-admin
supabase/functions/cleanup-old-photos
supabase/functions/reset-rider-pin
```

Useful commands:

```powershell
npm.cmd run supabase:login
npm.cmd run supabase:link -- --project-ref YOUR_PROJECT_REF
npm.cmd run supabase:db:push
npm.cmd run supabase:functions:deploy
```

Set Edge Function secrets before production rider login:

```powershell
npm.cmd run supabase -- secrets set JWT_SECRET=YOUR_PROJECT_JWT_SECRET CLEANUP_TOKEN=YOUR_RANDOM_CLEANUP_TOKEN
```

`JWT_SECRET` comes from Supabase Dashboard -> Project Settings -> API -> JWT Secret.

## GitHub

This repository should remain private until production secrets, Supabase RLS, and staging verification are complete.
