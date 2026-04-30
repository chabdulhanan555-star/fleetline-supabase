# FleetLine Dashboard Production Domain

`localhost` is only for testing on this computer. The live dashboard needs a frontend host such as Vercel, Netlify, Cloudflare Pages, or another static hosting service.

Supabase is the backend database/auth/API. It does not automatically host this Vite React dashboard.

## Production Build

```powershell
cd "C:\Users\Dell\Documents\Codex\2026-04-22-git-for-windows-is-required-to"
npm.cmd run build
```

The production files are created in:

```text
dist
```

## Vercel Setup

Use these settings if deploying on Vercel:

```text
Framework preset: Vite
Build command: npm run build
Output directory: dist
Install command: npm install
```

Environment variables:

```text
VITE_SUPABASE_URL=https://chwspnooeooddezsfcdp.supabase.co
VITE_SUPABASE_ANON_KEY=your Supabase anon public key
```

After deployment, connect your custom domain in Vercel Project Settings -> Domains.

## Supabase Auth URLs

In Supabase Dashboard -> Authentication -> URL Configuration:

```text
Site URL: https://your-dashboard-domain.com
Redirect URLs:
https://your-dashboard-domain.com/**
http://localhost:5174/**
```

Keep localhost only for development. Admins and riders should use the production domain.

## Database Migrations

Before testing Phase 5/6 on the domain, run:

```powershell
cd "C:\Users\Dell\Documents\Codex\2026-04-22-git-for-windows-is-required-to"
npm.cmd run supabase:db:push
```

This creates the latest route learning and geofence alert tables used by the dashboard.
