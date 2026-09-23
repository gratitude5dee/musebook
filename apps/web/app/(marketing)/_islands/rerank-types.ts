// apps/web/app/(marketing)/_islands/rerank-types.ts — §14.3 S1 verbatim.
import type { PostKind } from "@musebook/schema";

export type InterestKey =
  | "genvideo"
  | "artifacts3d"
  | "agenttooling"
  | "longform"
  | "designsystems"
  | "payments"
  | "music"
  | "research"
  | "shitposts"
  | "launches";

export interface DemoPost {
  id: string;
  kind: PostKind;
  title: string;
  authorHandle: string;
  posterUrl: string;
  features: Record<InterestKey, number>;
  isSample: boolean;
}

export interface RerankDemoProps {
  posts: DemoPost[];
  sampleNotice: string | null;
}
