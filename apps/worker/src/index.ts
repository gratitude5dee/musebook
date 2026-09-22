// musebook-worker — 14 queue consumers + Cron, no public surface (§3.1).
// One queue() entrypoint switches on batch.queue; one scheduled() entrypoint
// switches on event.cron against the canonical crons array in wrangler.jsonc.
export default {
  queue(batch: MessageBatch, env: Env): void {
    void env.HYPERDRIVE_FRESH;
    void env.HYPERDRIVE_CACHED;
    void env.PUBLIC_MEDIA;
    void env.PAID_MEDIA;
    void env.ARTIFACTS;
    void env.UPLOADS;
    void env.GRANTS;
    void env.TELEMETRY;
    void env.PAYWALL;
    void env.Q_CLASSIFY;
    void env.Q_MEDIA;
    void env.Q_MEDIA_FINALIZE;
    void env.Q_DISTRIBUTE;
    void env.Q_EMBED;
    void env.Q_AGENT_CANCEL;
    void env.Q_R2_EVENTS;
    // Consumers land from M4 (the outbox sweeper is O8 — ships with the first queue).
    for (const message of batch.messages) {
      message.ack();
    }
  },
  scheduled(event: ScheduledEvent, env: Env): void {
    void env;
    void event;
  },
};

// musebook-edge calls this entrypoint inside ctx.waitUntil() to kick a stale
// slate rebuild (CF-SPINE §4, §9.21). Declared now so the MIXER service
// binding resolves; the implementation lands with the slate writer (M6/M9).
export class SlateBuilder {
  fetch(): Response {
    return new Response("SlateBuilder: not yet implemented", { status: 501 });
  }
}
