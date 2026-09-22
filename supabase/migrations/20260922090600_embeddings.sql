-- 07. Retrieval: pgvector 0.8.0 embeddings with an HNSW index.

create table public.post_embeddings (
  content_hash text primary key references public.post_bodies(content_hash) on delete cascade,
  post_id      uuid not null references public.posts(id) on delete cascade,
  model        text not null default 'text-embedding-3-small',
  dim          smallint not null default 1536,
  embedding    extensions.vector(1536) not null,
  created_at   timestamptz not null default now(),
  constraint post_embeddings_dim_matches check (dim = 1536)
);
create index post_embeddings_post_idx on public.post_embeddings (post_id);

-- Cosine ANN index. m/ef_construction are the pgvector defaults stated explicitly
-- so a later tuning change is a visible diff rather than an implicit default shift.
create index post_embeddings_hnsw
  on public.post_embeddings
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Author-level taste vector, the "who is like me" retrieval tower.
create table public.user_embeddings (
  user_id    uuid primary key references public.users(id) on delete cascade,
  model      text not null default 'text-embedding-3-small',
  embedding  extensions.vector(1536) not null,
  n_events   integer not null default 0,
  updated_at timestamptz not null default now()
);
create index user_embeddings_hnsw
  on public.user_embeddings
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

alter table public.post_embeddings enable row level security;  -- jobs plane only (4.14)
alter table public.user_embeddings enable row level security;  -- jobs plane only (4.14)
