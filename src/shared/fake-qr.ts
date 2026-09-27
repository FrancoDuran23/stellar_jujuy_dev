// QR de mentira para los modos simulados (FakeProvider, CosmoPay mock).

import { createHash } from "node:crypto";

/**
 * Imagen con aspecto de QR (SVG válido, 25×25 módulos) derivada de `seed`,
 * para que la app muestre algo real en demos (eSIM y pago simulados). NO es
 * escaneable: lo que representa no existe.
 */
export function fakeQrDataUri(seed: string): string {
  const size = 25;
  const bits = createHash("sha512").update(`fake-qr:${seed}`).digest();
  const inFinder = (x: number, y: number) =>
    (x < 8 && y < 8) || (x >= size - 8 && y < 8) || (x < 8 && y >= size - 8);
  const finder = (ox: number, oy: number) =>
    `<rect x="${ox}" y="${oy}" width="7" height="7" fill="#0F172A"/>` +
    `<rect x="${ox + 1}" y="${oy + 1}" width="5" height="5" fill="#FFFFFF"/>` +
    `<rect x="${ox + 2}" y="${oy + 2}" width="3" height="3" fill="#0F172A"/>`;
  let modules = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inFinder(x, y)) continue;
      const i = y * size + x;
      if ((bits[i % bits.length]! >> (i % 8)) & 1) {
        modules += `<rect x="${x}" y="${y}" width="1" height="1" fill="#0F172A"/>`;
      }
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${size + 4} ${size + 4}" width="240" height="240" shape-rendering="crispEdges">` +
    `<rect x="-2" y="-2" width="${size + 4}" height="${size + 4}" fill="#FFFFFF"/>` +
    finder(0, 0) + finder(size - 7, 0) + finder(0, size - 7) + modules +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
