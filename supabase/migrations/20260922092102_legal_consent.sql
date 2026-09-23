-- legal_consent (M11): legal_documents, legal_acceptances, consent_events (§15.9).
create table public.legal_documents (
  slug          text not null,              -- 'terms' | 'privacy' | 'agent-data' | ...
  version       text not null,              -- '2026-09-22'
  effective_from timestamptz not null,
  content_sha256 text not null,             -- sha256 of the rendered MDX source
  summary        text,                      -- plain-language "what changed"
  primary key (slug, version),
  constraint legal_documents_sha_len check (length(content_sha256) = 64)
);

create table public.legal_acceptances (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  slug       text not null,
  version    text not null,
  accepted_at timestamptz not null default now(),
  ip_hash    text,                          -- per section 13.9.2, nulled at 7 days
  user_agent text,
  foreign key (slug, version) references public.legal_documents (slug, version)
);
create unique index legal_acceptances_uniq on public.legal_acceptances (user_id, slug, version);
create index legal_acceptances_user_idx on public.legal_acceptances (user_id, accepted_at desc);

-- Every consent state change is an append-only event, including withdrawals.
create table public.consent_events (
  id         bigint generated always as identity primary key,
  user_id    uuid references public.users(id) on delete cascade,
  anon_id    text,                          -- pre-signin consent, per section 13
  purpose    text not null,                 -- 'analytics' | 'marketing'
  granted    boolean not null,
  source     text not null,                 -- 'banner' | 'settings' | 'signup' | 'gpc' | 'dnt'
  at         timestamptz not null default now(),
  constraint consent_events_purpose_allowed check (purpose in ('analytics','marketing')),
  constraint consent_events_has_subject check (user_id is not null or anon_id is not null)
);
create index consent_events_user_idx on public.consent_events (user_id, purpose, at desc);

alter table public.legal_documents   enable row level security;
alter table public.legal_acceptances enable row level security;
alter table public.consent_events    enable row level security;
alter table public.legal_documents   force row level security;
alter table public.legal_acceptances force row level security;
alter table public.consent_events    force row level security;

-- Axis A: the browser.
grant select on public.legal_documents to anon, authenticated;
create policy legal_documents_public_read on public.legal_documents
  for select to anon, authenticated using (true);
grant select on public.legal_acceptances to authenticated;
create policy legal_acceptances_own_read on public.legal_acceptances
  for select to authenticated using (user_id = (select auth.uid()));

-- Axis B: the Worker planes (section 4.14). Without these, FORCE RLS plus zero
-- policies means the Worker cannot read its own tables either.
grant select on public.legal_documents to musebook_public_reader;
create policy legal_documents_reader on public.legal_documents
  for select to musebook_public_reader using (true);
grant select, insert on public.legal_acceptances, public.consent_events to musebook_kernel;
create policy legal_acceptances_kernel on public.legal_acceptances
  for all to musebook_kernel using (true) with check (true);
create policy consent_events_kernel on public.consent_events
  for all to musebook_kernel using (true) with check (true);
