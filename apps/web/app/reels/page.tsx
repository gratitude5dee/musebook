import type { Metadata } from "next";
import { ReelsPager } from "./reels-pager";

export const metadata: Metadata = { title: "Reels" };

export default function ReelsPage() {
  return <ReelsPager />;
}
