// /compose/[postId] — edit an existing draft or a published post. loadDraft
// runs the author's own JWT, so the RPC's can_write_post check applies here.
import { notFound } from "next/navigation";
import { loadDraft, saveDraft } from "@/lib/compose/actions";
import { ComposeClient } from "@/components/compose/compose-client";

export const dynamic = "force-dynamic";

export default async function EditPage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  const initial = await loadDraft(postId);
  if (initial === null) notFound();
  return <ComposeClient saveDraft={saveDraft} initial={initial} />;
}
