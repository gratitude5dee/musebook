// packages/classify/src/gateway.ts
// A systemOne-compatible client over the Vercel AI Gateway's OpenAI-compatible
// surface (§3.7's AI_GATEWAY_API_KEY). Jev's own /v1/systemone endpoint does
// not exist there, so the identical {state, questions} contract is served by
// ONE structured chat completion: the questions serialize verbatim into the
// request, and a JSON schema derived from their types constrains the answers.
// Everything downstream — the §8.4 question-count fallback, dispositionFor's
// status classes, and the narrow-row shape — is unchanged, because this file
// reuses the SDK's own APIPromise and APIError rather than inventing new ones.

import {
  APIConnectionError,
  APIError,
  APIPromise,
  APITimeoutError,
  TypeSafeError,
  type Fetch,
  type Questions,
  type SystemOneRequest,
  type SystemOneResult,
  type TypeSafeClient,
} from "@typesafe-ai/sdk";

export const GATEWAY_DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh/v1";
export const GATEWAY_DEFAULT_MODEL = "anthropic/claude-haiku-4.5";

/** Only the fields the gateway path reads. */
export type GatewayEnv = {
  AI_GATEWAY_API_KEY?: string;
  AI_GATEWAY_BASE_URL?: string;
  CLASSIFY_MODEL?: string;
};

/** The surface classifyOne/walkTaxonomy call; a TypeSafeClient satisfies it. */
export type ClassifyClient = Pick<TypeSafeClient, "systemOne">;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function questionSchema(q: Questions[string]): Record<string, unknown> {
  if (q.type === "noul") {
    return {
      type: "object",
      properties: { noul: { type: "number", minimum: 0, maximum: 1 } },
      required: ["noul"],
      additionalProperties: false,
    };
  }
  if (q.type === "choice") {
    const labels = Object.keys(q.criteria ?? {});
    return {
      type: "object",
      properties: {
        choice: { type: "string", enum: labels },
        probabilities: {
          type: "object",
          properties: Object.fromEntries(labels.map((l) => [l, { type: "number" }])),
          required: labels,
          additionalProperties: false,
        },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["choice", "probabilities", "confidence"],
      additionalProperties: false,
    };
  }
  if (q.type === "score") {
    const levels = Array.isArray(q.criteria) ? q.criteria.length : 0;
    if (levels < 2) throw new TypeSafeError("score criteria need at least two entries");
    const idx = Array.from({ length: levels }, (_, i) => `${i}`);
    return {
      type: "object",
      properties: {
        score: { type: "number", minimum: 0, maximum: levels - 1 },
        probabilities: {
          type: "object",
          properties: Object.fromEntries(idx.map((i) => [i, { type: "number" }])),
          required: idx,
          additionalProperties: false,
        },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["score", "probabilities", "confidence"],
      additionalProperties: false,
    };
  }
  throw new TypeSafeError(`unknown question type ${(q as { type?: string }).type}`);
}

function answersSchema(questions: Questions): Record<string, unknown> {
  const keys = Object.keys(questions);
  return {
    type: "object",
    properties: {
      answers: {
        type: "object",
        properties: Object.fromEntries(keys.map((k) => [k, questionSchema(questions[k]!)])),
        required: keys,
        additionalProperties: false,
      },
    },
    required: ["answers"],
    additionalProperties: false,
  };
}

const SYSTEM_PROMPT = `You are Jev, a deterministic classifier. You are given STATE — a post's fields — and QUESTIONS — named, typed. Answer EVERY question with a calibrated probabilistic judgment, on the post's content alone.

- noul: "noul" is P(the yes outcome), 0..1.
- choice: "probabilities" covers every listed label and sums to 1; "choice" is the argmax label; "confidence" is your certainty, 0..1.
- score: "probabilities" covers rubric indices 0..n-1 and sums to 1; "score" is the probability-weighted expected value on the rubric; "confidence" is your certainty, 0..1.

Every real post has a best fit: commit to the most defensible answer rather than abstaining. none_of_these exists only for content where NO offered option could conceivably apply — if the post is media, an app, or an artifact at any level of specificity, the correct label is a real one.

Follow each question's task, rule and criteria verbatim. Return strict JSON matching the schema.`;

const RETRYABLE = (s: number) => s === 408 || s === 429 || s >= 500;

function questionSetError(message: string, headers: Headers): APIError {
  // Shaped so isQuestionSetError recognizes it: detail[].loc contains
  // "questions", which is exactly what the §8.4 split fallback keys on.
  return APIError.fromResponse(
    422,
    { detail: [{ loc: ["body", "questions"], msg: message }] },
    headers,
  );
}

async function fetchWithRetries(
  url: string,
  init: RequestInit,
  fetchImpl: Fetch,
  timeoutMs: number,
  maxRetries: number,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (attempt < maxRetries) {
        await sleep(Math.min(5000, 500 * 2 ** attempt));
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (/(^| )timed? ?out|abort/i.test(msg)) throw new APITimeoutError(timeoutMs);
      throw new APIConnectionError(msg);
    }
    if (res.ok || attempt >= maxRetries || !RETRYABLE(res.status)) return res;
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(60_000, retryAfter * 1000)
        : Math.min(5000, 500 * 2 ** attempt),
    );
  }
}

function materialize(
  questions: Questions,
  rawAnswers: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, q] of Object.entries(questions)) {
    const raw = rawAnswers[key];
    if (raw == null || typeof raw !== "object") {
      throw new TypeSafeError(`model answer missing key ${key}`);
    }
    if (q.type === "noul") {
      out[key] = { type: "noul", noul: clamp(Number(raw.noul) || 0, 0, 1) };
    } else if (q.type === "choice") {
      const probabilities = (raw.probabilities ?? {}) as Record<string, number>;
      const labels = Object.keys(q.criteria ?? {});
      const argmax = labels.sort((a, b) => (probabilities[b] ?? 0) - (probabilities[a] ?? 0))[0];
      const choice = typeof raw.choice === "string" ? raw.choice : argmax;
      out[key] = {
        type: "choice",
        choice,
        confidence: raw.confidence == null ? null : clamp(Number(raw.confidence), 0, 1),
        probabilities,
      };
    } else {
      const criteria = Array.isArray(q.criteria) ? q.criteria : [];
      out[key] = {
        type: "score",
        score: clamp(Number(raw.score) || 0, 0, Math.max(0, criteria.length - 1)),
        confidence: raw.confidence == null ? null : clamp(Number(raw.confidence), 0, 1),
        legend: Object.fromEntries(criteria.map((d, i) => [`${i}`, d])),
        probabilities: raw.probabilities ?? {},
      };
    }
  }
  return out;
}

export function makeGatewayClient(env: GatewayEnv, fetchImpl?: Fetch): ClassifyClient {
  const key = env.AI_GATEWAY_API_KEY;
  if (!key) throw new TypeSafeError("AI_GATEWAY_API_KEY is required for CLASSIFY_PROVIDER=gateway");
  const base = (env.AI_GATEWAY_BASE_URL ?? GATEWAY_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const defaultModel = env.CLASSIFY_MODEL ?? GATEWAY_DEFAULT_MODEL;
  const doFetch: Fetch = fetchImpl ?? fetch;
  const timeoutMs = 30_000;
  const maxRetries = 2;

  return {
    systemOne(request: SystemOneRequest) {
      const questions = request.questions;
      const model = request.model ?? defaultModel;
      const schema = answersSchema(questions);
      const init: RequestInit = {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: JSON.stringify({ state: request.state, questions }),
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: "system_one", strict: true, schema },
          },
        }),
      };
      const responsePromise = fetchWithRetries(
        `${base}/chat/completions`,
        init,
        doFetch,
        timeoutMs,
        maxRetries,
      );
      return new APIPromise<SystemOneResult<Questions>>(responsePromise, async (res) => {
        const bodyText = await res.text();
        let body: unknown;
        try {
          body = bodyText ? JSON.parse(bodyText) : undefined;
        } catch {
          body = bodyText;
        }
        if (!res.ok) {
          // A 4xx complaining about the request shape is the gateway's
          // question-set rejection — the §8.4 split fallback handles it.
          const text = typeof body === "string" ? body : JSON.stringify(body ?? {});
          if (res.status === 400 && /response_format|json_schema|schema|questions/i.test(text)) {
            throw questionSetError(text.slice(0, 300), res.headers);
          }
          throw APIError.fromResponse(res.status, body, res.headers);
        }
        const json = body as {
          choices?: { message?: { content?: string } }[];
          model?: string;
          id?: string;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          provider_metadata?: {
            anthropic?: { usage?: { input_tokens?: number; output_tokens?: number } };
          };
        };
        const content = json.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content) {
          throw new TypeSafeError("gateway returned no content");
        }
        let parsed: { answers?: Record<string, Record<string, unknown>> };
        try {
          parsed = JSON.parse(content) as { answers?: Record<string, Record<string, unknown>> };
        } catch {
          throw new TypeSafeError("gateway returned unparseable JSON content");
        }
        const answers = materialize(questions, parsed.answers ?? {});
        const usage = json.usage ?? {};
        const anthroUsage = json.provider_metadata?.anthropic?.usage ?? {};
        return {
          model: json.model ?? model,
          answers: answers as SystemOneResult<Questions>["answers"],
          usage: {
            input_tokens: usage.prompt_tokens ?? anthroUsage.input_tokens ?? 0,
            output_tokens: usage.completion_tokens ?? anthroUsage.output_tokens ?? 0,
          },
        };
      }) as never;
    },
  };
}
