-- Saved chats, prompts, masks and settings for each Neon Auth user.
-- API keys are never stored here.
create table if not exists public.user_chat_state (
  user_id uuid primary key references neon_auth."user"(id) on delete cascade,
  state jsonb not null,
  updated_at timestamptz not null default now()
);
