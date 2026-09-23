// apps/worker/test/helpers/jev.ts — canned POST /v1/systemone responder for
// the classify consumer. Answers every question shape generically: first
// non-escape choice label, mid-rubric score, fixed noul. Deterministic — the
// idempotence test compares written rows byte for byte.
export interface JevCall {
  url: string;
  questions: string[];
}

/** Builds a fetch handler that answers /v1/systemone and records every call. */
export function stubJev(
  calls: JevCall[],
  opts: { status?: number; inputTokens?: number } = {},
): (input: unknown, init?: { body?: string }) => Promise<Response> {
  return async (input: unknown, init?: { body?: string }) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : ((input as { url?: string }).url ?? "");
    if (!url.includes("/v1/systemone")) {
      // Anything else on the wire (embeddings et al.) gets an empty success —
      // classify suites never exercise it.
      return new Response("{}", { status: 200 });
    }
    const req = JSON.parse(init?.body ?? "{}") as {
      questions?: Record<string, { type: string; criteria?: unknown }>;
    };
    const names = Object.keys(req.questions ?? {});
    calls.push({ url, questions: names });
    if (opts.status && opts.status >= 400) {
      return new Response(JSON.stringify({ error: "jev unavailable" }), {
        status: opts.status,
        headers: { "content-type": "application/json" },
      });
    }
    const answers: Record<string, unknown> = {};
    for (const [name, q] of Object.entries(req.questions ?? {})) {
      if (q.type === "noul") {
        answers[name] = { type: "noul", noul: 0.73 };
      } else if (q.type === "score") {
        const levels = Array.isArray(q.criteria) ? q.criteria.length : 4;
        answers[name] = {
          type: "score",
          score: Math.min(2, levels - 1),
          confidence: 0.8,
          legend: {},
          probabilities: {},
        };
      } else {
        const labels = Object.keys((q.criteria ?? {}) as object).filter(
          (l) => l !== "none_of_these",
        );
        const pick = labels[0] ?? "none_of_these";
        const probabilities = Object.fromEntries([
          ...labels.map((l) => [l, 0.05] as const),
          ["none_of_these", 0.05] as const,
        ]);
        probabilities[pick] = 0.9;
        answers[name] = {
          type: "choice",
          choice: pick,
          confidence: 0.9,
          probabilities,
        };
      }
    }
    return new Response(
      JSON.stringify({
        model: "jev-test",
        answers,
        usage: { input_tokens: opts.inputTokens ?? 111, output_tokens: 0 },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-typesafe-request-id": "req_test_1",
        },
      },
    );
  };
}
