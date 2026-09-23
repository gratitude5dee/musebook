#!/usr/bin/env node
import { main } from "../dist/index.js";

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
