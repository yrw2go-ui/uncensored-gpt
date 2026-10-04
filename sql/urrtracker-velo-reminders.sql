-- Velo timed reminders ("remind me Friday at 9 to collect rent from Jane").
-- Additive only: one new table, its indexes and its RLS policies.
--
-- Delivery is in-app only: the app reads the caller's own due rows and pops
-- them from the Velo bubble / Velo Insights. No scheduler, no email.
--
-- Rows are written by /api/chat with a client signed in AS the caller, so RLS
-- below is what keeps everyone to their own reminders.

create table if not exists public.velo_reminders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade, -- who set it (and who sees it)
  owner_id    uuid,                                   -- account (data) owner at the time it was set; informational
  text        text not null check (char_length(text) between 1 and 300),
  nav_key     text check (nav_key is null or char_length(nav_key) <= 64), -- lib/atlasNav.js key ("Take me there")
  remind_at   timestamptz not null,
  time_zone   text not null check (char_length(time_zone) between 1 and 64), -- IANA zone it was set in
  status      text not null default 'pending' check (status in ('pending', 'sent', 'dismissed')),
  created_at  timestamptz not null default now(),
  sent_at     timestamptz                              -- first time it popped up in the app
);

create index if not exists velo_reminders_user_open_idx
  on public.velo_reminders (user_id, remind_at) where status <> 'dismissed';

alter table public.velo_reminders enable row level security;

revoke all on public.velo_reminders from anon;
grant select, insert, update, delete on public.velo_reminders to authenticated;

drop policy if exists velo_reminders_select_own on public.velo_reminders;
create policy velo_reminders_select_own on public.velo_reminders
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists velo_reminders_insert_own on public.velo_reminders;
create policy velo_reminders_insert_own on public.velo_reminders
  for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists velo_reminders_update_own on public.velo_reminders;
create policy velo_reminders_update_own on public.velo_reminders
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists velo_reminders_delete_own on public.velo_reminders;
create policy velo_reminders_delete_own on public.velo_reminders
  for delete to authenticated using (user_id = (select auth.uid()));
