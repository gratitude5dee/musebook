// apps/web/components/post/webmcp-tools.tsx  ('use client')
"use client";
import { useEffect } from "react";
import { registerPostTools } from "@/lib/webmcp/register";
import type { PostView } from "@musebook/schema";

declare global {
  interface Window {
    musebookCheckout?: {
      open(opts: { postId: string; maxUsd?: number }): Promise<{ message: string; ok?: boolean }>;
    };
  }
}

export function WebMcpTools({ post }: { post: PostView }) {
  useEffect(() => {
    // pay_and_unlock's backing: the SAME checkout the Unlock button opens,
    // driven in a popup so the agent stays on this page. max_usd declines
    // before the window opens when the known badge price already exceeds it.
    window.musebookCheckout = {
      open({ postId, maxUsd }) {
        const price = Number(post.accessBadge.priceUsd);
        if (maxUsd !== undefined && Number.isFinite(price) && price > maxUsd) {
          return Promise.resolve({
            message: `Declined: the $${post.accessBadge.priceUsd} price is above the $${maxUsd} cap.`,
            ok: false,
          });
        }
        const w = window.open(`/pay/${postId}`, "musebook-pay", "width=520,height=720,popup=yes");
        if (w === null) {
          return Promise.resolve({
            message: `Open ${location.origin}/pay/${postId} to buy this article.`,
            ok: false,
          });
        }
        return new Promise((resolve) => {
          const t = setInterval(() => {
            if (w.closed) {
              clearInterval(t);
              resolve({
                message: "Checkout closed. Call read_article again to fetch the unlocked body.",
              });
            }
          }, 500);
        });
      },
    };

    const controller = new AbortController();
    void registerPostTools(post, controller.signal);
    return () => {
      controller.abort(); // AbortSignal is how WebMCP unregisters
      delete window.musebookCheckout;
    };
  }, [post.postId]);
  return null;
}
