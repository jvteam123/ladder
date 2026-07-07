# Open Play / Host a Game — Design Plan

## How this fits into the existing app

Maezku Ladder today is a **single-device session tool**: one host runs check-in,
rotation, and scoring on one phone/tablet at the venue. Everything lives in
IndexedDB on that device.

"Post open play / host a game" is a **different feature**: it needs to be visible
to *other people, on their own phones*, before and independent of that in-person
session. So this becomes a new layer:

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  EXISTING: Ladder Session    │        │  NEW: Open Play Discovery    │
│  (device-local, IndexedDB)   │        │  (Supabase, cross-device)    │
│  - Check-in, Queue, Match    │  ---->│  - Post a game (host)        │
│  - Rankings, Stats, History  │  links │  - Discover / RSVP (player)  │
└─────────────────────────────┘        └──────────────────────────────┘
```

A hosted game can optionally **launch into** a ladder session once people show up
(reuses your existing Match/Queue engine), but the posting/discovery/RSVP part is
new and lives in Supabase so it works across everyone's phones.

## Backend: Supabase

Free tier is enough to start (Postgres + Auth + Realtime, ~500MB DB, unlimited
API requests on the pause-free plan). You create the project; I only need:
- Project URL (`https://xxxx.supabase.co`)
- `anon` public API key

Nothing else — no server to run, no billing required to get started.

## Data model

```sql
-- profiles: one row per signed-in user
profiles (
  id uuid primary key references auth.users,
  display_name text not null,
  avatar_url text,
  home_city text,
  dupr_id text,              -- optional, mirrors Reclub's DUPR link
  created_at timestamptz default now()
)

-- open_play_events: a posted game/session, "host a game"
open_play_events (
  id uuid primary key default gen_random_uuid(),
  host_id uuid references profiles(id) not null,
  title text not null,
  sport text default 'pickleball',
  location_name text not null,
  lat double precision,
  lng double precision,
  start_time timestamptz not null,
  end_time timestamptz,
  max_players int default 8,
  skill_min numeric,          -- optional DUPR-style rating band
  skill_max numeric,
  fee_amount numeric,
  fee_note text,              -- e.g. "GCash, see payment tab"
  status text default 'open', -- open | full | cancelled | completed
  created_at timestamptz default now()
)

-- rsvps: players joining a posted event
rsvps (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references open_play_events(id) on delete cascade,
  player_id uuid references profiles(id),
  status text default 'confirmed', -- requested | confirmed | waitlist | cancelled
  created_at timestamptz default now(),
  unique(event_id, player_id)
)
```

Row-level security: anyone can read `open_play_events` where `status='open'`;
only the host can update/cancel their own event; a user can only insert/delete
their own `rsvps` row.

## New UI additions (matches existing dark theme / tab pattern)

Two new entries added to `NAV_SECTIONS`, following your existing pattern exactly:

- **Discover** — browse open play events near you (list, filter by date/sport),
  tap to view details, tap **Join** to RSVP (mirrors Reclub's Discover tab).
- **Host** — "+" button → form (title, location, date/time, max players, skill
  range, fee) → **Post** → generates the event and a shareable link.

Auth: lightweight — email magic-link or phone OTP via Supabase Auth (no
passwords to manage). A player only needs to sign in once to RSVP or host.

## Build order

1. Supabase project + schema + RLS policies (you create project, I write the SQL)
2. Auth screen (sign in / display name)
3. **Host a Game** form → writes to `open_play_events`
4. **Discover** list + event detail + RSVP → reads/writes `open_play_events` / `rsvps`
5. Realtime: event list and RSVP count update live (Supabase Realtime subscription)
6. Optional later: tie a hosted event into your existing check-in/Match flow so
   confirmed RSVPs pre-populate the player list when the host starts the session

## What I need from you to start building for real

- A Supabase project URL + anon key (steps: supabase.com → New project → Settings
  → API → copy "Project URL" and "anon public" key)

Until then, I can build steps 2–4 fully in the UI against **mock local data**
so you can see and click through the flow — then it's a drop-in swap to real
Supabase calls once you've got the project.
