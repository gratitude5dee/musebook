-- 11. Agents: scopes, connectors, delegations, delegation_spend,
--     agent_spend_reservations, approval_queue, agent_post_schedules, audit_log.

-- The scope catalog. `delegations.scopes` and `connectors.default_scopes` are text[]
-- of these keys (arrays, so no FK); this table is the one place a scope's meaning,
-- its default approval requirement and whether it can move money are written down.
-- The thirteen v1 rows are seeded in 4.15 from section 5.7.3's ALL_SCOPES tuple, which
-- is the TypeScript half of the same list; section 7.6.2's `scopes_supported` serves it.
create table public.scopes (
  scope                     text primary key,
  description               text not null,
  requires_approval_default boolean not null default false,
  is_spend_bearing          boolean not null default false,
  is_grantable              boolean not null default true,
  created_at                timestamptz not null default now(),
  constraint scopes_shape check (scope ~ '^[a-z][a-z0-9_]{1,30}:[a-z][a-z0-9_]{1,30}$')
);

-- Manifest-driven registry. Adding a vendor is a row, not a deploy.
create table public.connectors (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null,
  display_name  text not null,
  vendor        text,
  transport     text not null,  -- 'mcp_http' | 'a2a_card' | 'http_openapi' | 'bridge_token'
  base_url      text,
  auth_kind     text not null,  -- 'oauth2' | 'bearer' | 'bridge_token' | 'none'
  manifest      jsonb not null,
  default_scopes text[] not null default '{}',
  is_verified   boolean not null default false,
  is_enabled    boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint connectors_slug_shape check (slug ~ '^[a-z0-9][a-z0-9_-]{1,40}$'),
  constraint connectors_transport_allowed
    check (transport in ('mcp_http','a2a_card','http_openapi','bridge_token')),
  constraint connectors_auth_allowed
    check (auth_kind in ('oauth2','bearer','bridge_token','none'))
);
create unique index connectors_slug_uniq on public.connectors (slug);
create index connectors_manifest_gin on public.connectors using gin (manifest jsonb_path_ops);

create table public.delegations (
  id                uuid primary key default gen_random_uuid(),
  owner_user_id     uuid not null references public.users(id) on delete cascade,
  connector_id      uuid not null references public.connectors(id) on delete restrict,
  agent_identity_id uuid not null references public.agent_identities(id) on delete restrict,
  state             delegation_state not null default 'active',
  scopes            text[] not null default '{}',
  token_sha256      text not null,
  -- Budget. The window is floor(extract(epoch from now()) / extract(epoch from spend_window))
  -- so every reader computes the same window_start; see section 10.7.2.
  spend_cap_atomic  numeric(78,0) not null default 0,
  spend_window      interval not null default '24 hours',
  rate_limit_per_hour integer not null default 60,
  requires_approval boolean not null default true,
  -- Per-action caps read by section 11's media pipeline at submit time.
  per_action_cap_atomic        numeric(78,0) not null default 500000,   -- $0.50
  requires_approval_over_atomic numeric(78,0) not null default 250000,  -- $0.25 -> approval_queue
  generations_per_day          integer not null default 20,
  -- Reputation ladder maintained by section 10.9; read by reserve_agent_spend.
  quarantined_until timestamptz,
  reputation        numeric(5,2) not null default 50.00,
  strikes           integer not null default 0,
  clean_approvals   integer not null default 0,
  first_publish_at  timestamptz,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz,
  revoked_at        timestamptz,
  last_used_at      timestamptz,
  constraint delegations_token_hash_len check (length(token_sha256) = 64),
  constraint delegations_spend_cap_non_negative check (spend_cap_atomic >= 0),
  constraint delegations_rate_limit_bounded check (rate_limit_per_hour between 1 and 10000),
  constraint delegations_per_action_cap_non_negative check (per_action_cap_atomic >= 0),
  constraint delegations_approval_threshold_non_negative check (requires_approval_over_atomic >= 0),
  constraint delegations_generations_per_day_bounded check (generations_per_day between 0 and 1000),
  constraint delegations_reputation_range check (reputation between 0 and 100),
  constraint delegations_strikes_non_negative check (strikes >= 0)
);
create unique index delegations_token_uniq on public.delegations (token_sha256);
create index delegations_owner_idx on public.delegations (owner_user_id, created_at desc);
create unique index delegations_one_active_per_pair
  on public.delegations (owner_user_id, connector_id, agent_identity_id)
  where state = 'active';

-- Committed spend per window. Written only by settle_agent_spend (section 10.7.2).
create table public.delegation_spend (
  delegation_id uuid not null references public.delegations(id) on delete cascade,
  window_start  timestamptz not null,
  spent_atomic  numeric(78,0) not null default 0,
  actions_count integer not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (delegation_id, window_start),
  constraint delegation_spend_non_negative
    check (spent_atomic >= 0 and actions_count >= 0)
);
create index delegation_spend_window_idx on public.delegation_spend (window_start);

-- Two-phase holds. reserve_agent_spend inserts a 'held' row BEFORE the provider call;
-- settle_agent_spend converts it to committed spend at the actual amount on the
-- webhook; release_agent_spend drops it on failure, cancel or revocation. Two-phase
-- is required because media jobs are asynchronous: the estimate must be held
-- against the window while the provider works, and the true cost is only known
-- when the webhook lands. All three functions take FOR UPDATE on the delegations row.
create table public.agent_spend_reservations (
  id              uuid primary key default gen_random_uuid(),
  delegation_id   uuid not null references public.delegations(id) on delete cascade,
  window_start    timestamptz not null,
  purpose         text not null,
  estimate_atomic numeric(78,0) not null,
  actual_atomic   numeric(78,0),
  state           text not null default 'held',
  -- How to cancel the far side. 'media_job' + media_jobs.id, 'mcp' + task id, ...
  external_kind   text,
  external_ref    text,
  idempotency_key text not null,
  created_at      timestamptz not null default now(),
  closed_at       timestamptz,
  constraint agent_spend_reservations_state_allowed
    check (state in ('held','settled','released','cancelled')),
  constraint agent_spend_reservations_estimate_non_negative
    check (estimate_atomic >= 0),
  constraint agent_spend_reservations_purpose_allowed
    check (purpose in ('media.generate','connector.call','distribution.publish','wallet.spend')),
  constraint agent_spend_reservations_closed_has_time
    check (state = 'held' or closed_at is not null)
);
create unique index agent_spend_reservations_idem_uniq
  on public.agent_spend_reservations (delegation_id, idempotency_key);
create index agent_spend_reservations_held_idx
  on public.agent_spend_reservations (delegation_id, window_start)
  where state = 'held';
create index agent_spend_reservations_external_idx
  on public.agent_spend_reservations (external_kind, external_ref)
  where state = 'held';

create table public.approval_queue (
  id            uuid primary key default gen_random_uuid(),
  delegation_id uuid not null references public.delegations(id) on delete cascade,
  owner_user_id uuid not null references public.users(id) on delete cascade,
  kind          text not null,   -- 'publish' | 'comment' | 'spend' | 'connect_channel'
  payload       jsonb not null,
  state         approval_state not null default 'pending',
  requested_at  timestamptz not null default now(),
  decided_at    timestamptz,
  decided_by_user_id uuid references public.users(id) on delete set null,
  expires_at    timestamptz not null default (now() + interval '48 hours'),
  constraint approval_queue_kind_allowed
    check (kind in ('publish','comment','spend','connect_channel'))
);
create index approval_queue_owner_pending_idx on public.approval_queue (owner_user_id, requested_at)
  where state = 'pending';
create index approval_queue_expiry_idx on public.approval_queue (expires_at) where state = 'pending';

-- Musebook-initiated drafting: "connect your agent and have it post for you".
-- One row per delegation that the owner has asked to draft on a cadence. Drained by
-- the agent-draft Cron Worker on '*/15 * * * *' (section 10.15): due rows go
-- reserve_agent_spend -> connector.draftPost(DraftRequest) -> insert posts row with
-- status = 'pending_approval' (while approvals remain) or 'published' -> the post +
-- job_outbox('distribute') single statement (4.13) -> settle_agent_spend. Approval
-- happens in the existing approval_queue. cadence = 'manual' rows never fire on the
-- schedule; they are fired by hand by setting next_run_at, which the same Worker picks
-- up on its next tick.
create table public.agent_post_schedules (
  id                uuid primary key default gen_random_uuid(),
  delegation_id     uuid not null references public.delegations(id) on delete cascade,
  cadence           text not null check (cadence in ('hourly','daily','weekly','manual')),
  prompt_template   text,
  target_platforms  text[] not null default '{}',   -- platforms.slug values; '{}' = Musebook only
  max_posts_per_day int not null default 3,
  approval_mode     text not null default 'first_n'
                      check (approval_mode in ('always','first_n','never')),
  approval_n        int default 3,
  next_run_at       timestamptz,
  last_run_at       timestamptz,
  enabled           boolean default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint agent_post_schedules_max_posts_bounded check (max_posts_per_day between 1 and 48),
  constraint agent_post_schedules_approval_n_non_negative check (approval_n is null or approval_n >= 0),
  constraint agent_post_schedules_first_n_has_n check (approval_mode <> 'first_n' or approval_n is not null),
  constraint agent_post_schedules_scheduled_has_next_run check (cadence = 'manual' or next_run_at is not null)
);
-- The drain reads exactly this: enabled, scheduled, due.
create index agent_post_schedules_due_idx on public.agent_post_schedules (next_run_at)
  where enabled and cadence <> 'manual';
create index agent_post_schedules_delegation_idx on public.agent_post_schedules (delegation_id);

-- Append-only. Every agent action, every delegation change, every money movement.
create table public.audit_log (
  id             bigint generated always as identity primary key,
  at             timestamptz not null default now(),
  actor          actor_class not null,
  actor_user_id  uuid,
  actor_agent_id uuid,
  delegation_id  uuid,
  action         text not null,
  target_kind    text,
  target_id      uuid,
  before_state   jsonb,
  after_state    jsonb,
  request_id     text,
  ip_hash        text
);
create index audit_log_at_idx on public.audit_log (at desc);
create index audit_log_agent_idx on public.audit_log (actor_agent_id, at desc)
  where actor_agent_id is not null;
create index audit_log_target_idx on public.audit_log (target_kind, target_id, at desc);

revoke update, delete on public.audit_log from public, anon, authenticated;

create trigger connectors_set_updated_at before update on public.connectors
  for each row execute function app.set_updated_at();
create trigger agent_post_schedules_set_updated_at before update on public.agent_post_schedules
  for each row execute function app.set_updated_at();

alter table public.scopes                   enable row level security;
alter table public.delegations              enable row level security;
alter table public.approval_queue           enable row level security;
alter table public.agent_post_schedules     enable row level security;
alter table public.connectors               enable row level security;
alter table public.delegation_spend         enable row level security;  -- jobs plane only (4.14)
alter table public.agent_spend_reservations enable row level security;  -- jobs plane only (4.14)
alter table public.audit_log                enable row level security;  -- jobs plane only (4.14)

-- The scope catalog is public: the consent screen and the OAuth metadata document
-- (section 7.6.2) both render it, and it describes capabilities, not grants.
grant select on public.scopes to anon, authenticated;
create policy scopes_public_read on public.scopes
  for select to anon, authenticated using (true);

grant select on public.connectors to anon, authenticated;
create policy connectors_public_read on public.connectors
  for select to anon, authenticated using (is_enabled);

grant select on public.delegations, public.approval_queue, public.agent_post_schedules to authenticated;
-- token_sha256 is in this table; the client reads it but it is a hash, not a token.
-- The raw token is returned exactly once, at mint time, and never stored.
create policy delegations_owner_read on public.delegations
  for select to authenticated using (owner_user_id = (select auth.uid()));
create policy approval_queue_owner_read on public.approval_queue
  for select to authenticated using (owner_user_id = (select auth.uid()));
create policy agent_post_schedules_owner_read on public.agent_post_schedules
  for select to authenticated
  using (exists (select 1 from public.delegations d
                 where d.id = agent_post_schedules.delegation_id
                   and d.owner_user_id = (select auth.uid())));
