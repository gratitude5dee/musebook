// compose-client.tsx — binds the package Composer to this app's three verbs.
// saveDraft is a server action (passes through as a callable reference);
// publish/upload run on the browser against musebook-edge.
"use client";

import { Composer, type ComposerActions, type ComposerInitial } from "@musebook/ui";
import { publishPost, uploadMedia } from "@/lib/compose/transport";

export function ComposeClient({
  initial,
  saveDraft,
}: {
  initial: ComposerInitial;
  saveDraft: ComposerActions["saveDraft"];
}) {
  return <Composer initial={initial} actions={{ saveDraft, publish: publishPost, uploadMedia }} />;
}
