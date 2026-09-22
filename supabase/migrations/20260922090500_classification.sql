-- 06. Classification: narrow + raw.

create table public.post_classifications (
  content_hash      text primary key references public.post_bodies(content_hash) on delete cascade,
  provider          text not null default 'typesafe_jev',
  model             text not null,             -- e.g. 'jev-latest'
  primary_topic     text,
  topics            text[] not null default '{}',
  language_code     text,
  quality           real,                      -- 0..1
  toxicity          real,
  spam              real,
  commercial_intent real,
  is_nsfw           boolean not null default false,
  is_ai_generated   boolean,
  classified_at     timestamptz not null default now(),
  latency_ms        integer,
  constraint post_classifications_scores_bounded check (
    (quality is null or quality between 0 and 1) and
    (toxicity is null or toxicity between 0 and 1) and
    (spam is null or spam between 0 and 1) and
    (commercial_intent is null or commercial_intent between 0 and 1)
  )
);
create index post_classifications_primary_topic_idx on public.post_classifications (primary_topic)
  where primary_topic is not null;
create index post_classifications_topics_gin on public.post_classifications using gin (topics);
create index post_classifications_quality_idx on public.post_classifications (quality desc nulls last);
create index post_classifications_safety_idx on public.post_classifications (is_nsfw, toxicity);

create table public.post_classifications_raw (
  content_hash text primary key references public.post_bodies(content_hash) on delete cascade,
  provider     text not null,
  request_id   text,
  raw          jsonb not null,
  created_at   timestamptz not null default now()
);
create index post_classifications_raw_gin on public.post_classifications_raw
  using gin (raw jsonb_path_ops);

alter table public.post_classifications     enable row level security;
alter table public.post_classifications_raw enable row level security;  -- jobs plane only (4.14)

grant select on public.post_classifications to anon, authenticated;
create policy post_classifications_public_read on public.post_classifications
  for select to anon, authenticated using (true);
