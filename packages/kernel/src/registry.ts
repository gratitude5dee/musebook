// packages/kernel/src/registry.ts — the one mutable cell in the package (§6.3).
import type { KernelPorts } from "./ports.js";

let configured: KernelPorts | null = null;

export function setPorts(ports: KernelPorts): void {
  configured = ports;
}

export function getPorts(): KernelPorts {
  if (configured === null) {
    throw new Error("@musebook/kernel: configureKernel() has not been called in this process.");
  }
  return configured;
}
