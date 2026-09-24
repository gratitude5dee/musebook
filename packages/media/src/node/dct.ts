// packages/media/src/node/dct.ts — ~30 lines of separable type-II DCT, no
// dependency needed (§11.10). 32×32 grayscale in → flat 32×32 coefficients out.
export function dct2d(pixels: number[], size: number): number[] {
  const out = new Array<number>(size * size).fill(0);
  const scale = Math.PI / size;
  for (let u = 0; u < size; u++) {
    const cu = u === 0 ? Math.SQRT1_2 : 1;
    for (let v = 0; v < size; v++) {
      const cv = v === 0 ? Math.SQRT1_2 : 1;
      let sum = 0;
      for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
          sum +=
            pixels[x * size + y]! *
            Math.cos(((2 * x + 1) * u * scale) / 2) *
            Math.cos(((2 * y + 1) * v * scale) / 2);
        }
      }
      out[u * size + v] = (2 / size) * cu * cv * sum;
    }
  }
  return out;
}
