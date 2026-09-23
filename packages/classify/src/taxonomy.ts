// packages/classify/src/taxonomy.ts
import { createHash } from "node:crypto";

export type TaxonomyNode = { label: string; children?: Record<string, TaxonomyNode> };

const leaf = (label: string): TaxonomyNode => ({ label });

export const MUSEBOOK_TAXONOMY: Record<string, TaxonomyNode> = {
  media: {
    label: "A finished creative work to be watched, heard, looked at or read.",
    children: {
      music: {
        label: "Music or audio as the primary work.",
        children: {
          original_track: leaf("An original composition or recording by the poster."),
          remix_cover: leaf("A remix, cover or edit of someone else's work."),
          sound_design: leaf("Sound effects, foley, ambience or audio branding."),
          live_set: leaf("A recorded live performance, DJ set or session."),
        },
      },
      film_video: {
        label: "Moving image as the primary work.",
        children: {
          short_film: leaf("Narrative or documentary short with a story."),
          music_video: leaf("Visuals made to accompany a piece of music."),
          vlog_talking_head: leaf("A person addressing camera; vlog, review or explainer."),
          ai_generated_video: leaf("Moving image synthesised by a generative model."),
        },
      },
      visual_art: {
        label: "Still images as the primary work.",
        children: {
          illustration: leaf("Drawn, painted or digitally illustrated artwork."),
          photography: leaf("Camera-captured photographs."),
          generative_image: leaf("Still images synthesised by a generative model."),
          design_asset: leaf("Typography, logos, icons, UI kits or templates."),
        },
      },
      writing: {
        label: "Prose as the primary work.",
        children: {
          essay: leaf("An argued or reflective piece for a general reader."),
          technical_writeup: leaf("A technical explanation, postmortem or how-to."),
          fiction_poetry: leaf("Fiction, poetry or other literary writing."),
          newsletter_update: leaf("A periodic update, changelog or roundup."),
        },
      },
    },
  },
  apps: {
    label: "Something runnable: an agent, a web application, or a developer tool.",
    children: {
      agent: {
        label: "An autonomous or semi-autonomous software agent.",
        children: {
          chat_agent: leaf("A conversational assistant a person talks to."),
          workflow_agent: leaf(
            "An agent that executes a multi-step task on a schedule or trigger.",
          ),
          mcp_server: leaf("An MCP server exposing tools or resources to other agents."),
          trading_agent: leaf("An agent that transacts, trades or manages funds."),
        },
      },
      web_app: {
        label: "An application a person uses in a browser.",
        children: {
          creative_tool: leaf("A tool for making images, audio, video or writing."),
          dashboard_analytics: leaf("A dashboard, report or analytics surface."),
          game: leaf("A playable game or interactive toy."),
          utility: leaf("A single-purpose utility: convert, calculate, look up."),
        },
      },
      dev_tool: {
        label: "Something another developer installs or runs.",
        children: {
          library_sdk: leaf("A library, SDK or framework consumed as a dependency."),
          cli: leaf("A command-line program."),
          template_starter: leaf("A starter template, boilerplate or scaffold."),
          infra_service: leaf("A deployable service, proxy, database or platform component."),
        },
      },
    },
  },
  artifacts: {
    label: "A reusable asset: a 3D model, an onchain contract, or a dataset.",
    children: {
      three_d: {
        label: "Three-dimensional or spatial assets.",
        children: {
          model_asset: leaf("A mesh, character or prop as a reusable file."),
          scene_environment: leaf("An assembled scene, level or environment."),
          xr_experience: leaf("A VR, AR or WebXR experience."),
          shader_procedural: leaf("A shader, material or procedural generator."),
        },
      },
      onchain: {
        label: "Assets that live on a blockchain.",
        children: {
          nft_collection: leaf("A minted collection or individual token artwork."),
          smart_contract: leaf("Deployed contract source or a protocol implementation."),
          token_economy: leaf("A token design, tokenomics model or incentive mechanism."),
        },
      },
      data: {
        label: "Data and models published for reuse.",
        children: {
          dataset: leaf("A structured dataset published for others to use."),
          model_weights: leaf("Trained model weights, adapters or LoRAs."),
          benchmark_eval: leaf("A benchmark, eval harness or measured comparison."),
        },
      },
    },
  },
};

export const TAXONOMY_VERSION = createHash("sha256")
  .update(JSON.stringify(MUSEBOOK_TAXONOMY))
  .digest("hex")
  .slice(0, 16);

/** leaf key -> its full path in MUSEBOOK_TAXONOMY. The flat fallback mode
 *  (§8.6) answers the leaf question in one shot and reconstructs the path
 *  from this static lookup — no walk requests. */
export const LEAF_TO_PATH: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  const visit = (node: Record<string, TaxonomyNode>, path: string[]) => {
    for (const [key, child] of Object.entries(node)) {
      const p = [...path, key];
      if (child.children && Object.keys(child.children).length > 0) {
        visit(child.children, p);
      } else {
        out[key] = p;
      }
    }
  };
  visit(MUSEBOOK_TAXONOMY, []);
  return out;
})();
