// apps/web/app/p/[slug]/page.tsx — §7.12. The page NEVER builds an Actor,
// loads a Resource or calls resolveAccess — all three are illegal here
// (§14.4.2). It reads x-mb-plane/x-mb-access-badge off the forwarded headers
// and gets body+license+access off the JSON twin.
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { loadPostView } from "@/lib/db/posts";
import { PostViewTracker } from "@/components/post/post-view-tracker";

/** A direct `/p/{slug}` open was not served from a slate — the all-zero uuid
 *  keeps spine invariant 3's non-null columns honest while saying exactly that. */
const UNSERVED_SLATE = "00000000-0000-0000-0000-000000000000";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = await loadPostView(slug);
  if (!post) return { title: "Not found" };
  const url = `${process.env.NEXT_PUBLIC_SITE_URL}/p/${post.slug}`;
  return {
    title: post.title ?? post.summary?.slice(0, 60) ?? "Musebook",
    description: post.summary ?? undefined,
    alternates: {
      canonical: url,
      types: {
        "text/markdown": `${url}.md`,
        "application/json": `${url}.json`,
        "application/ld+json": `${url}.jsonld`,
        "application/rss+xml": `${process.env.NEXT_PUBLIC_SITE_URL}/feed.xml`,
      },
    },
    openGraph: {
      type: post.kind === "article" ? "article" : "website",
      url,
      title: post.title ?? "Musebook",
      description: post.summary ?? undefined,
      siteName: "Musebook",
      publishedTime: post.publishedAt ?? undefined,
      modifiedTime: post.updatedAt,
      authors: [`${process.env.NEXT_PUBLIC_SITE_URL}/@${post.authorHandle}`],
      images: post.ogImageUrl ? [{ url: post.ogImageUrl, width: 1200, height: 630 }] : undefined,
    },
    twitter: { card: "summary_large_image" },
  };
}

export default async function PostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = await loadPostView(slug);
  if (post === null) notFound();

  // Facts the Worker forwarded — trustworthy because it stripped every inbound
  // x-mb-* first and authenticated the hop with x-musebook-edge (§6.12.2).
  const h = await headers();
  const badge = post.accessBadge;

  return (
    <main className="mx-auto max-w-[720px] px-4 py-10">
      {badge.kind === "toll" ? (
        <div className="mb-6 rounded-md bg-gate-tint px-4 text-[13px] leading-10 text-gate">
          Free for you. Agents pay {badge.priceUsd !== undefined ? `$${badge.priceUsd}` : "a fee"}{" "}
          to crawl this.
        </div>
      ) : null}
      {post.title !== null ? <h1 className="mb-2 text-3xl font-semibold">{post.title}</h1> : null}
      <p className="mb-8 text-sm text-muted-foreground">
        <a href={`/@${post.authorHandle}`}>{post.authorDisplayName}</a>
        {post.publishedAt !== null ? ` · ${post.publishedAt.slice(0, 10)}` : ""}
      </p>
      <PostViewTracker
        postId={post.postId}
        contentHash={post.contentHash}
        slateId={UNSERVED_SLATE}
        position={0}
      >
        <div className="prose max-w-[68ch] whitespace-pre-wrap">{post.body}</div>
      </PostViewTracker>
      {post.jsonld !== null ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(post.jsonld) }}
        />
      ) : null}
      {void h}
    </main>
  );
}
