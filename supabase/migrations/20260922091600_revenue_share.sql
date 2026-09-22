-- 20260922091600_revenue_share.sql — plan.md §6.10, verbatim.
-- Additive to §4.10. A new table + two columns; no existing DDL is altered.
-- Must apply BEFORE the first settlement: revenue_share_version is copied onto
-- the x402_settlements row at settle time and a settlement written without it
-- is a split that can never be reconstructed.

create table public.revenue_share_policies (
  version          text primary key,
  platform_fee_bps integer not null,
  effective_from   timestamptz not null default now(),
  note             text,
  constraint revenue_share_bps_range check (platform_fee_bps between 0 and 5000)
);

-- effective_from is pinned, not defaulted: the dump hash of two seeded
-- databases must be identical (G-SEED), and now() would drift per reset.
insert into public.revenue_share_policies (version, platform_fee_bps, effective_from, note)
values ('rs_2026_09_v1', 1000, '2026-09-01 00:00:00+00',
        'Launch default: 10% platform, 90% creator.');

alter table public.posts
  add column revenue_share_version text not null default 'rs_2026_09_v1'
    references public.revenue_share_policies(version);

alter table public.x402_settlements
  add column revenue_share_version text
    references public.revenue_share_policies(version);

alter table public.revenue_share_policies enable row level security;
grant select on public.revenue_share_policies to authenticated, anon;
create policy revenue_share_public_read on public.revenue_share_policies
  for select to authenticated, anon using (true);

-- The kernel plane reads platform_fee_bps off the version pinned on the
-- settlement (gate 11); the public browser roles are covered by the policy above.
grant select on public.revenue_share_policies to musebook_kernel;

-- RLS counterpart to the grant above: the public-read policy names
-- authenticated/anon only, which filters the table to zero rows for the kernel
-- plane even with the SELECT grant.
create policy revenue_share_kernel_read on public.revenue_share_policies
  for select to musebook_kernel using (true);
