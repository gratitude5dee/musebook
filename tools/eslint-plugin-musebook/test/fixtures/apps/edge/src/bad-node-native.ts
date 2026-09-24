// M16 gate fixture — must produce exactly one musebook/no-node-native-in-worker problem.
import { readFileSync } from "node:fs";
export const body = readFileSync("/tmp/x", "utf8");
