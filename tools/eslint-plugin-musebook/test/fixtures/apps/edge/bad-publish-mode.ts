// Simulated apps/edge path — the Worker is deliberately NOT on the rule's allow-list.
const query = "select body, publish_mode from posts where id = $1";
export { query };
