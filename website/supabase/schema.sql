-- unsnooze website feedback board — run this in the Supabase SQL editor.
--
-- The site talks to this table with the public anon key only:
--   * anyone may INSERT a new visible entry (kind/title/details/contact)
--   * anyone may SELECT entries that aren't hidden
--   * nobody anonymous may UPDATE or DELETE — you triage from the
--     Supabase dashboard (set status, or hidden = true to remove spam).
--
-- Wire the site to it with two build-time env vars:
--   VITE_SUPABASE_URL      = https://<project>.supabase.co
--   VITE_SUPABASE_ANON_KEY = <anon public key>
-- Locally: put them in website/.env.local. On GitHub Pages: repo
-- Settings → Secrets and variables → Actions → Variables (the deploy
-- workflow passes them into the build).

create table public.feedback (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind       text not null check (kind in ('bug', 'idea')),
  title      text not null check (char_length(title) between 3 and 120),
  details    text check (details is null or char_length(details) <= 4000),
  contact    text check (contact is null or char_length(contact) <= 120),
  status     text not null default 'new'
             check (status in ('new', 'planned', 'in-progress', 'shipped', 'declined')),
  hidden     boolean not null default false
);

alter table public.feedback enable row level security;

create policy "anyone can submit"
  on public.feedback for insert
  to anon
  with check (status = 'new' and hidden = false);

create policy "anyone can read visible entries"
  on public.feedback for select
  to anon
  using (hidden = false);

create index feedback_visible_recent
  on public.feedback (created_at desc)
  where hidden = false;
