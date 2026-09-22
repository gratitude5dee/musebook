// /studio — the creator's own posts: drafts first, then published. Editing a
// row opens /compose/{post_id}; the list itself is a PostgREST read (§5.4).
import { cookies } from "next/headers";
import Link from "next/link";
import { serviceDb } from "@/lib/db/service";
import { readSession } from "@/lib/auth/read-session";

export const dynamic = "force-dynamic";

interface PostRow {
  post_id: string;
  slug: string;
  title: string | null;
  status: string;
  kind: string;
  updated_at: string;
  published_at: string | null;
}

export default async function StudioPage() {
  const cookieHeader = (await cookies())
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const session = await readSession(
    new Request("https://musebook.local/", { headers: { cookie: cookieHeader } }),
  );
  if (session === null) {
    return (
      <div className="mx-auto max-w-2xl px-4">
        <h1 className="font-serif text-3xl">Studio</h1>
        <p className="mt-4 text-muted-foreground">Sign in to see your posts.</p>
      </div>
    );
  }
  const { data: rows } = await serviceDb
    .from("posts")
    .select("post_id, slug, title, status, kind, updated_at, published_at")
    .eq("author_user_id", session.userId)
    .order("updated_at", { ascending: false })
    .limit(50)
    .returns<PostRow[]>();

  const drafts = (rows ?? []).filter((r) => r.status === "draft");
  const published = (rows ?? []).filter((r) => r.status !== "draft");

  return (
    <div className="mx-auto max-w-2xl px-4">
      <div className="flex items-baseline justify-between">
        <h1 className="font-serif text-3xl">Studio</h1>
        <Link href="/compose" className="text-sm text-primary hover:underline">
          New post
        </Link>
      </div>
      {[
        { label: "Drafts", items: drafts },
        { label: "Published", items: published },
      ].map(({ label, items }) => (
        <section key={label} className="mt-6">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </h2>
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
            {items.map((r) => (
              <li key={r.post_id}>
                <Link
                  href={`/compose/${r.post_id}`}
                  className="flex items-center justify-between gap-3 p-3 hover:bg-muted/50"
                >
                  <span className="truncate">{r.title ?? r.slug}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {r.kind} · {r.status}
                  </span>
                </Link>
              </li>
            ))}
            {items.length === 0 && <li className="p-3 text-sm text-muted-foreground">None yet.</li>}
          </ul>
        </section>
      ))}
    </div>
  );
}
