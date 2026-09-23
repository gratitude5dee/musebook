// apps/web/lib/distribute/data.ts — the fan-out review's server-side read
// path (§12.3.7). The page renders one card per connected channel; reads are
// serviceDb (service role — server-only) scoped explicitly to the session's
// owner so another author's jobs are never selected.
import "server-only";
import { cookies } from "next/headers";
import { toConstraint, type PlatformConstraint } from "@musebook/distributor/constraints";
import type { VariantCandidate } from "@musebook/distributor/validate";
import { readSession } from "@/lib/auth/read-session";
import { serviceDb } from "@/lib/db/service";

export interface ChannelJob {
  state: string;
  scheduledFor: string | null;
  lastError: string | null;
  platformPostUrl: string | null;
}

export interface ChannelCard {
  channelId: string;
  platform: string;
  handle: string | null;
  displayName: string | null;
  constraint: PlatformConstraint;
  /** null until the variant stage has produced one — the Send action is how
   *  a channel gets its first variant. */
  candidate: VariantCandidate | null;
  generatedBy: string | null;
  job: ChannelJob | null;
}

export interface DistributeView {
  postId: string;
  postVersionId: string;
  slug: string;
  /** Derived from price_atomic — the publish-mode column name never leaves
   *  the kernel (§3.4), and priced is the only signal the banner needs. */
  priced: boolean;
  canonicalUrl: string;
  channels: ChannelCard[];
}

interface StoredMedia {
  url?: string;
  path?: string;
  contentType?: string;
  alt?: string | null;
  widthPx?: number | null;
  heightPx?: number | null;
  durationSeconds?: number | null;
  thumbnailUrl?: string | null;
}

function mediaOf(raw: unknown): VariantCandidate["media"] {
  if (!Array.isArray(raw)) return [];
  return (raw as StoredMedia[]).map((m) => ({
    url: typeof m.url === "string" ? m.url : typeof m.path === "string" ? m.path : "",
    contentType: typeof m.contentType === "string" ? m.contentType : "image/png",
    alt: m.alt ?? null,
    widthPx: m.widthPx ?? null,
    heightPx: m.heightPx ?? null,
    durationSeconds: m.durationSeconds ?? null,
    thumbnailUrl: m.thumbnailUrl ?? null,
  }));
}

export async function loadDistributeView(postId: string): Promise<DistributeView | null> {
  const cookieHeader = (await cookies())
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const session = await readSession(
    new Request("https://musebook.local/", { headers: { cookie: cookieHeader } }),
  );
  if (session === null) return null;

  const { data: post } = await serviceDb
    .from("posts")
    .select("id, slug, price_atomic, status, current_version, canonical_url")
    .eq("id", postId)
    .eq("author_user_id", session.userId)
    .maybeSingle()
    .returns<{
      id: string;
      slug: string;
      price_atomic: string;
      status: string;
      current_version: number;
      canonical_url: string | null;
    }>();
  if (post === null || post === undefined) return null;

  const { data: version } = await serviceDb
    .from("post_versions")
    .select("id, content_hash")
    .eq("post_id", postId)
    .eq("version", post.current_version)
    .maybeSingle()
    .returns<{ id: string; content_hash: string }>();
  if (version === null || version === undefined) return null;

  const [channelsRes, variantsRes, jobsRes, platformsRes, overridesRes] = await Promise.all([
    serviceDb
      .from("channels")
      .select("id, platform, handle, display_name, disabled_at")
      .eq("owner_user_id", session.userId)
      .is("disabled_at", null)
      .returns<
        { id: string; platform: string; handle: string | null; display_name: string | null }[]
      >(),
    serviceDb
      .from("platform_variants")
      .select("id, platform, body, media, thread_parts, generated_by")
      .eq("post_version_id", version.id)
      .returns<
        {
          id: string;
          platform: string;
          body: string;
          media: unknown;
          thread_parts: unknown;
          generated_by: string;
        }[]
      >(),
    serviceDb
      .from("distribution_jobs")
      .select("channel_id, state, scheduled_for, last_error, platform_post_url")
      .eq("post_version_id", version.id)
      .returns<
        {
          channel_id: string;
          state: string;
          scheduled_for: string | null;
          last_error: string | null;
          platform_post_url: string | null;
        }[]
      >(),
    serviceDb.from("platforms").select("*").returns<Record<string, unknown>[]>(),
    serviceDb
      .from("channel_constraint_overrides")
      .select("channel_id, max_chars, rules_text")
      .returns<{ channel_id: string; max_chars: number | null; rules_text: string | null }[]>(),
  ]);

  const canonicalUrl = post.canonical_url ?? `https://musebook.dev/p/${post.slug}`;
  const variantByPlatform = new Map((variantsRes.data ?? []).map((v) => [v.platform, v]));
  const jobByChannel = new Map((jobsRes.data ?? []).map((j) => [j.channel_id, j]));
  const platformBySlug = new Map((platformsRes.data ?? []).map((p) => [p.slug as string, p]));
  const overrideByChannel = new Map((overridesRes.data ?? []).map((o) => [o.channel_id, o]));

  const channels: ChannelCard[] = (channelsRes.data ?? []).flatMap((c) => {
    const row = platformBySlug.get(c.platform);
    if (row === undefined) return [];
    const override = overrideByChannel.get(c.id) ?? null;
    const variant = variantByPlatform.get(c.platform);
    const job = jobByChannel.get(c.id);
    const threadParts = Array.isArray(variant?.thread_parts)
      ? (variant.thread_parts as unknown[]).filter((p): p is string => typeof p === "string")
      : [];
    return [
      {
        channelId: c.id,
        platform: c.platform,
        handle: c.handle,
        displayName: c.display_name,
        constraint: toConstraint(row as never, {
          override:
            override === null
              ? null
              : { max_chars: override.max_chars, rules_text: override.rules_text },
          cdnHost: process.env.CDN_HOST ?? "cdn.musebook.dev",
        }),
        candidate:
          variant === undefined
            ? null
            : {
                body: variant.body,
                threadParts,
                media: mediaOf(variant.media),
                title: null,
                canonicalUrl,
              },
        generatedBy: variant?.generated_by ?? null,
        job:
          job === undefined
            ? null
            : {
                state: job.state,
                scheduledFor: job.scheduled_for,
                lastError: job.last_error,
                platformPostUrl: job.platform_post_url,
              },
      },
    ];
  });

  return {
    postId: post.id,
    postVersionId: version.id,
    slug: post.slug,
    priced: BigInt(post.price_atomic) > 0n,
    canonicalUrl,
    channels,
  };
}
