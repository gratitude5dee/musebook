// packages/classify/src/walk.ts
import { choice } from "@typesafe-ai/sdk";
import type { ClassifyClient } from "./gateway.js";
import { MUSEBOOK_TAXONOMY, type TaxonomyNode } from "./taxonomy.js";

export const BEAM_MAX_WIDTH = 2; // never more than 2 questions per level
export const BEAM_MARGIN = 0.2; // widen only when p_top - p_i < 0.20
export const MIN_EDGE_PROB = 0.05; // prune anything below this outright

type Beam = {
  path: string[];
  node: Record<string, TaxonomyNode>;
  logProb: number;
  decisions: number;
};

export type TaxonomyResult = {
  path: string[];
  leaf: string | null;
  score: number; // geometric-mean edge probability
  levels: {
    level: number;
    probabilities: Record<string, number>;
    confidence: number | null;
  }[];
  requests: number;
};

function criteriaFor(node: Record<string, TaxonomyNode>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, child] of Object.entries(node)) out[key] = child.label;
  out.none_of_these = "None of the options above describes this post.";
  return out;
}

/** Keep the top option, plus any option within BEAM_MARGIN of it, capped at BEAM_MAX_WIDTH. */
function selectEdges(probabilities: Record<string, number>): [string, number][] {
  const ranked = Object.entries(probabilities)
    .filter(([label, p]) => label !== "none_of_these" && p >= MIN_EDGE_PROB)
    .sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return [];
  const top = ranked[0]![1];
  return ranked.filter(([, p]) => top - p < BEAM_MARGIN).slice(0, BEAM_MAX_WIDTH);
}

/**
 * @param rootLabel the `taxonomy_l1` answer from the battery, or null when it
 *                  was `none_of_these` (in which case no walk is performed).
 */
export async function walkTaxonomy(
  client: ClassifyClient,
  state: unknown,
  rootLabel: string | null,
  rootProbability: number,
): Promise<TaxonomyResult> {
  const levels: TaxonomyResult["levels"] = [];
  if (!rootLabel || !MUSEBOOK_TAXONOMY[rootLabel]) {
    return { path: [], leaf: null, score: 0, levels, requests: 0 };
  }

  let frontier: Beam[] = [
    {
      path: [rootLabel],
      node: MUSEBOOK_TAXONOMY[rootLabel].children ?? {},
      logProb: Math.log(Math.max(rootProbability, MIN_EDGE_PROB)),
      decisions: 1,
    },
  ];
  const finished: Beam[] = [];
  let requests = 0;

  for (let level = 2; level <= 3 && frontier.length > 0; level++) {
    const questions: Record<string, ReturnType<typeof choice>> = {};
    frontier.forEach((beam, i) => {
      questions[`lvl${level}_b${i}`] = choice(
        {
          task: "Which category does this post belong to?",
          path_so_far: beam.path.join(" > "),
          rule: "Choose the single best fit. Choose none_of_these only if no option applies.",
        },
        criteriaFor(beam.node),
      );
    });

    // ONE request per level, carrying every live beam as its own question.
    const { answers } = await client.systemOne({ state: state as never, questions });
    requests += 1;

    const next: Beam[] = [];
    frontier.forEach((beam, i) => {
      const answer = answers[`lvl${level}_b${i}`];
      if (!answer || answer.type !== "choice") return;
      levels.push({
        level,
        probabilities: { ...answer.probabilities },
        confidence: answer.confidence ?? null,
      });
      for (const [label, p] of selectEdges(answer.probabilities)) {
        const child = beam.node[label];
        if (!child) continue;
        const grown: Beam = {
          path: [...beam.path, label],
          node: child.children ?? {},
          logProb: beam.logProb + Math.log(p),
          decisions: beam.decisions + 1,
        };
        if (child.children && Object.keys(child.children).length > 0) next.push(grown);
        else finished.push(grown);
      }
    });

    next.sort((a, b) => b.logProb / b.decisions - a.logProb / a.decisions);
    frontier = next.slice(0, BEAM_MAX_WIDTH);
  }

  const ranked = [...finished, ...frontier]
    .map((b) => ({ path: b.path, score: Math.exp(b.logProb / Math.max(1, b.decisions)) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  return best
    ? {
        path: best.path,
        leaf: best.path[best.path.length - 1] ?? null,
        score: best.score,
        levels,
        requests,
      }
    : {
        path: [rootLabel],
        leaf: null,
        score: Math.exp(Math.log(rootProbability)),
        levels,
        requests,
      };
}
