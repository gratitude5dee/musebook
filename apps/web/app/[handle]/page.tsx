// apps/web/app/[handle]/page.tsx — §14.4: creator profile at /@{handle}.
// The byline on /p/{slug} has always linked here; without this route that
// link is dead. App Router has no literal-`@` segment (it is parallel-route
// slot syntax and `%40` escaping is unsupported), so this is a greedy
// single-segment param: /@x resolves the profile, any other unclaimed
// single segment still lands here and is rejected with notFound().
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { serviceDb } from "@/lib/db/service";

type ProfileRow = {
  user_id: string;
  handle: string;
  display_name: string | null;
  bio: string | null;
  website_url: string | null;
};

type PostRow = {
  slug: string;
  title: string | null;
  summary: string | null;
  kind: string;
  published_at: string | null;
};

async function loadProfile(handle: string): Promise<{ profile: ProfileRow; posts: PostRow[] } | null> {
  const { data: profile } = await serviceDb
    .from("profiles")
    .select("user_id, handle, display_name, bio, website_url")
    .eq("handle", handle)
    .maybeSingle()
    .returns<ProfileRow>();
  if (profile === null || profile === undefined) return null;

  const { data: posts } = await serviceDb
    .from("posts")
    .select("slug, title, summary, kind, published_at")
    .eq("author_user_id", profile.user_id)
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(50)
    .returns<PostRow[]>();

  return { profile, posts: posts ?? [] };
}

async function segmentHandle(params: Promise<Record<string, string>>): Promise<string> {
  // The param can arrive still percent-encoded (%40seed_creator) — decode
  // before testing the literal @.
  const segment = decodeURIComponent((await params)["handle"] ?? "");
  return segment.startsWith("@") ? segment.slice(1) : "";
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Record<string, string>>;
}): Promise<Metadata> {
  const handle = await segmentHandle(params);
  if (handle === "") return {};
  const loaded = await loadProfile(handle);
  if (loaded === null) return {};
  const name = loaded.profile.display_name ?? `@${loaded.profile.handle}`;
  return { title: `${name} — musebook` };
}

export default async function CreatorProfile({
  params,
}: {
  params: Promise<Record<string, string>>;
}) {
  const handle = await segmentHandle(params);
  if (handle === "") notFound();
  const loaded = await loadProfile(handle);
  if (loaded === null) notFound();
  const { profile, posts } = loaded;

  return (
    <main className="mx-auto max-w-[720px] px-4 py-10">
      <h1 className="mb-1 text-3xl font-semibold">{profile.display_name ?? `@${profile.handle}`}</h1>
      <p className="mb-4 text-sm text-muted-foreground">@{profile.handle}</p>
      {profile.bio !== null ? <p className="mb-8 whitespace-pre-wrap">{profile.bio}</p> : null}
      {profile.website_url !== null ? (
        <p className="mb-8 text-sm">
          <a href={profile.website_url} rel="me">{profile.website_url}</a>
        </p>
      ) : null}
      <h2 className="mb-3 text-lg font-medium">Posts</h2>
      {posts.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing published yet.</p>
      ) : (
        <ul className="space-y-4">
          {posts.map((post) => (
            <li key={post.slug}>
              <Link href={`/p/${post.slug}`} className="font-medium underline">
                {post.title ?? post.slug}
              </Link>
              {post.published_at !== null ? (
                <span className="ml-2 text-sm text-muted-foreground">
                  {post.published_at.slice(0, 10)}
                </span>
              ) : null}
              {post.summary !== null ? (
                <p className="text-sm text-muted-foreground">{post.summary}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
