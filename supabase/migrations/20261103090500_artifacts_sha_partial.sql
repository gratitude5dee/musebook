-- §11.17.3 fork artifacts are pointer rows: they share the source bundle's
-- sha256 verbatim, so a global unique index on sha256 makes every fork
-- insert collide. Dedup belongs to first-publish content; lineage pointers
-- are exempt.
drop index if exists public.artifacts_sha_uniq;
create unique index artifacts_sha_uniq on public.artifacts (sha256)
  where fork_of_artifact_id is null;
