-- supabase/migrations/20260922092200_citations.sql (M18) — agent-declared citations.
create table public.citations (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  post_id       uuid not null references public.posts(id) on delete cascade,
  content_hash  text not null,
  agent_id      uuid references public.agent_identities(id) on delete set null,
  user_id       uuid references public.users(id) on delete set null,
  surface       text not null,
  quote         text not null,
  char_start    integer,
  char_end      integer,
  destination   text,
  self_declared boolean not null default true,
  verified_url  text,
  constraint citations_hash_len check (length(content_hash) = 64),
  constraint citations_quote_len check (length(quote) between 1 and 4000),
  -- Every value is an AGENT_SURFACES member of §13.3's surface vocabulary; there is no bare 'http'.
  constraint citations_surface_allowed check (
    surface in ('mcp', 'webmcp', 'http_md', 'http_json', 'http_jsonld', 'http_html')
  ),
  constraint citations_span_ordered check (
    char_start is null or char_end is null or char_end >= char_start
  )
);
create index citations_post_idx on public.citations (post_id, created_at desc);
create index citations_hash_idx on public.citations (content_hash);
alter table public.citations enable row level security;
alter table public.citations force row level security;   -- §4: FORCE, or the owner is exempt
