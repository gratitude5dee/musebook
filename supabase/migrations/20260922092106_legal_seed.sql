-- 20260922092106_legal_seed.sql — M11 §15.9. The legal_documents registry:
-- one row per shipped document; content_sha256 is the sha256 of the MDX file
-- under apps/web/content/legal/, and a CI check asserts equality — editing a
-- policy without bumping the version fails the build, which is the point.
-- subprocessors.json is not a legal_documents row: the /legal/subprocessors
-- page renders the JSON directly (§15.14), version 'v1' like the others.
insert into public.legal_documents (slug, version, effective_from, content_sha256, summary) values
  ('terms',          'v1', '2026-09-23', '801aef42eb6eac35251cddb6995c37c6e4a0f385ca905e80d868b1246378caa1', 'Initial terms of service — draft pending counsel review.'),
  ('privacy',        'v1', '2026-09-23', '894abc3d53f2210bb9d5d10913e6dd49ddb55530e2729d4b52bb6d05db7bbce3', 'Initial privacy policy — draft pending counsel review.'),
  ('agent-data',     'v1', '2026-09-23', '399b26d902ddfc06e6a970cccdc9de0a778c665bc50d455f229622dcd126b1a1', 'Initial agent data disclosure — draft pending counsel review.'),
  ('cookies',        'v1', '2026-09-23', '7e04cef45e941b98d02788e2d62e83a12f344c3953255e8495d5f7b654a43477', 'Initial cookie/storage inventory — draft pending counsel review.'),
  ('acceptable-use', 'v1', '2026-09-23', '03480165f24c81e1965fb5e3ed20833ed48787601b56d28a779c1b53fe28a57a', 'Initial acceptable-use + misbehavior ladder — draft pending counsel review.'),
  ('dmca',           'v1', '2026-09-23', 'd940aae4275cde6e95eb69e6df939b890286e72f3f88d2d589d42a00f1118e53', 'Initial DMCA notice-and-takedown — draft pending counsel review.'),
  ('security',       'v1', '2026-09-23', 'c6d3375a0bc7b1bfc9c345150d23a4b9fdf5f26913644cf89a8c833c5d2e85bf', 'Initial vulnerability disclosure policy — draft pending counsel review.')
on conflict (slug, version) do nothing;
