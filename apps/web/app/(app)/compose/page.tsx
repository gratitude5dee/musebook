// /compose — a fresh draft, prefilled from the creator's publishing defaults
// (§14.4.5). Writes ride the saveDraft server action; publish/upload ride
// musebook-edge (§14.4.3).
import { loadDefaults, saveDraft } from "@/lib/compose/actions";
import { ComposeClient } from "@/components/compose/compose-client";
import { TollContractNote } from "./toll-note";

export const dynamic = "force-dynamic";

export default async function ComposePage() {
  const d = await loadDefaults();
  return (
    <>
      <ComposeClient
        saveDraft={saveDraft}
        initial={{
          postId: null,
          slug: null,
          contentHash: null,
          status: "draft",
          liveGrantCount: 0,
          kind: "note",
          markdown: "",
          title: null,
          summary: null,
          access: d.access,
          priceUsd: d.priceUsd,
          licenseSpdx: d.licenseSpdx,
          trainAi: d.trainAi,
          aiUse: d.aiUse,
          searchIndexable: d.searchIndexable,
          tags: [],
        }}
      />
      <TollContractNote />
    </>
  );
}
