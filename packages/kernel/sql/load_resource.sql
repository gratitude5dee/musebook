-- packages/kernel/sql/load_resource.sql — parameterized by ($1 slug)
select
  p.id                 as post_id,
  p.author_user_id,
  pr.display_name      as author_display_name,
  pr.handle            as author_handle,
  w.address            as author_wallet,
  p.kind::text         as kind,
  p.status::text       as status,
  p.publish_mode::text as publish_mode,
  p.slug,
  p.title,
  p.summary,
  p.canonical_url,
  p.language_code,
  p.tags,
  p.content_hash,
  b.canonical_markdown,
  p.price_atomic::text   as price_atomic,
  p.price_asset,
  p.price_network,
  p.revenue_share_version,
  p.license_spdx,
  p.license_url,
  p.train_ai,
  p.ai_use,
  p.search_indexable,
  p.attribution_required,
  p.citation_template,
  p.published_at,
  p.updated_at
from public.posts p
join public.post_bodies b on b.content_hash = p.content_hash
join public.profiles   pr on pr.user_id = p.author_user_id
left join lateral (
  select address from public.wallets
   where user_id = p.author_user_id and is_primary
   limit 1
) w on true
where p.slug = $1 and p.deleted_at is null;
