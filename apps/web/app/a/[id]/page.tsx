// apps/web/app/a/[id]/page.tsx — §11.16's artifact detail surface.
// The frame always points at artifacts.musebook.dev: public artifacts at the
// immutable /a/{id}/{version}/{entry} URL, paid ones at a 300-second ticketed
// URL minted client-side by the §11.18 endpoint. The page itself never reads
// the bucket — the Worker route does.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArtifactFrame } from "@musebook/ui";
import { serviceDb } from "@/lib/db/service";
import { TicketedArtifact } from "@/components/artifact/ticketed-artifact";

export const dynamic = "force-dynamic";

const ARTIFACT_ORIGIN = "https://artifacts.musebook.dev";

interface ArtifactRow {
  id: string;
  status: string;
  kind: string;
  current_version: string | null;
  entry_path: string;
  posts: { title: string | null; slug: string; author_handle: string } | null;
  artifact_versions: { visibility: string; entry_path: string }[] | null;
}

async function loadArtifact(id: string): Promise<ArtifactRow | null> {
  const { data, error } = await serviceDb
    .from("artifacts")
    .select(
      "id, status, kind, current_version, entry_path, posts(title, slug, author_handle), artifact_versions(visibility, entry_path)",
    )
    .eq("id", id)
    .maybeSingle<ArtifactRow>();
  if (error || data === null) return null;
  return data;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const artifact = await loadArtifact(id);
  const title = artifact?.posts?.title ?? "Musebook artifact";
  return { title, robots: { index: false } };
}

export default async function ArtifactPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const artifact = await loadArtifact(id);
  if (artifact === null || artifact.status !== "live" || artifact.current_version === null) {
    notFound();
  }

  const version = artifact.artifact_versions?.[0];
  const entry = version?.entry_path ?? artifact.entry_path;
  const title = artifact.posts?.title ?? "Untitled artifact";

  // Private artifacts never receive a public URL — the client mints a
  // 300-second ticket against the edge route and frames THAT URL instead.
  const isPublic = version?.visibility !== "private";

  return (
    <div className="mx-auto flex h-dvh max-w-5xl flex-col px-4 py-6">
      <header className="mb-4">
        <h1 className="font-serif text-2xl">{title}</h1>
        <p className="text-sm text-neutral-500">
          by @{artifact.posts?.author_handle ?? "unknown"} · v{artifact.current_version}
        </p>
      </header>
      <div className="min-h-0 flex-1">
        {isPublic ? (
          <ArtifactFrame
            src={`${ARTIFACT_ORIGIN}/a/${artifact.id}/${artifact.current_version}/${entry}`}
            title={title}
          />
        ) : (
          <TicketedArtifact artifactId={artifact.id} title={title} />
        )}
      </div>
    </div>
  );
}
