// apps/web/app/pay/[postId]/page.tsx — /pay/{postId}, §7.10's checkout: the
// wallet hand-off and the no-JS checkout. Vercel-rendered, never gated.
import { notFound } from "next/navigation";
import { serviceDb } from "@/lib/db/service";
import { UnlockCard } from "./_islands/unlock-card";

export const dynamic = "force-dynamic";

export default async function PayPage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  const { data: post } = await serviceDb
    .from("posts")
    .select("slug, price_atomic, author_user_id")
    .eq("id", postId)
    .in("status", ["published", "unlisted"])
    .maybeSingle()
    .returns<{
      slug: string;
      price_atomic: string;
      author_user_id: string;
    }>();
  if (post === null) notFound();

  const { data: profile } = await serviceDb
    .from("profiles")
    .select("handle")
    .eq("user_id", post.author_user_id)
    .maybeSingle()
    .returns<{ handle: string }>();

  const priceUsd = (Number(post.price_atomic) / 1e6).toFixed(2);
  const authorHandle = profile?.handle ?? "author";

  return (
    <main className="mx-auto flex max-w-[720px] flex-col gap-6 px-6 py-16">
      <UnlockCard
        slug={post.slug}
        postId={postId}
        authorHandle={authorHandle}
        priceUsd={priceUsd}
      />
      <noscript>
        {/* §14.4.2's no-JS checkout: the same payment an agent sends — the
            reader pays it from any x402-capable client. */}
        <p>
          This post costs ${priceUsd} USDC on Base. Pay it with any x402 client: GET /p/{post.slug}
          .json, sign the offered TransferWithAuthorization, and retry with a PAYMENT-SIGNATURE
          header.
        </p>
      </noscript>
    </main>
  );
}
