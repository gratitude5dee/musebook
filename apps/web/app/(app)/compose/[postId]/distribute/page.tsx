// /compose/[postId]/distribute — §12.3.7's fan-out review. Server component
// loads channels + constraints + platform_variants; the island owns actions.
import { notFound } from "next/navigation";
import { DistributeClient } from "@/components/distribute/distribute-client";
import { loadDistributeView } from "@/lib/distribute/data";

export const dynamic = "force-dynamic";

export default async function DistributePage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  const view = await loadDistributeView(postId);
  if (view === null) notFound();
  return <DistributeClient view={view} />;
}
