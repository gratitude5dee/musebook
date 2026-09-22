// /feed — public web twin: recent published posts as cards, each carrying the
// Worker's own accessBadge projection (the .json twin is the only read that
// resolves the badge — PostgREST can't see the decision).
import Link from "next/link";
import { AccessBadge } from "@musebook/ui";
import { serviceDb } from "@/lib/db/service";
import { fetchJsonTwin, type TwinEnvelope } from "@/lib/edge/twin";

export const dynamic = "force-dynamic";

interface PostRow {
  slug: string;
  title: string | null;
  summary: string | null;
  kind: string;
  author_handle: string;
  author_display_name: string;
  published_at: string | null;
  og_image_url: string | null;
}

export default async function FeedPage() {
  const { data: rows } = await serviceDb
    .from("posts")
    .select(
      "slug, title, summary, kind, author_handle, author_display_name, published_at, og_image_url",
    )
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(24)
    .returns<PostRow[]>();

  const twins = await Promise.all((rows ?? []).map((r) => fetchJsonTwin(r.slug).catch(() => null)));
  const cards = (rows ?? []).map((r, i) => ({ row: r, twin: twins[i] as TwinEnvelope | null }));

  return (
    <div className="mx-auto max-w-2xl px-4">
      <h1 className="font-serif text-3xl">Feed</h1>
      <ul className="mt-6 space-y-4">
        {cards.map(({ row, twin }) => (
          <li key={row.slug} className="rounded-lg border border-border bg-surface p-4">
            <Link href={`/p/${row.slug}`} className="group block">
              <div className="flex items-start justify-between gap-3">
                <h2 className="font-serif text-xl leading-snug group-hover:underline">
                  {row.title ?? row.slug}
                </h2>
                {twin !== null && <AccessBadge view={twin.accessBadge} size="sm" />}
              </div>
              {row.summary !== null && (
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{row.summary}</p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                {row.author_display_name} · {row.kind}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
