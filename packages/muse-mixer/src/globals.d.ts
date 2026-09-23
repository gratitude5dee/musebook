// The package is platform-free (lib: ES2023, no DOM/node types), but every
// target it runs on — workerd and node — provides setTimeout/clearTimeout.
// Declare them structurally rather than pulling in a platform's type bundle.
declare function setTimeout(callback: () => void, ms: number): number;
declare function clearTimeout(id: number): void;

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare class TextDecoder {
  decode(input?: ArrayBufferView | ArrayBuffer): string;
}
declare function atob(data: string): string;
declare function btoa(data: string): string;
