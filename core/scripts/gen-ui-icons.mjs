import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "../assets/ui");

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcBuf), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function setPixel(rgba, w, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= w || y >= w) return;
  const i = (y * w + x) * 4;
  rgba[i] = r;
  rgba[i + 1] = g;
  rgba[i + 2] = b;
  rgba[i + 3] = a;
}

function fillCircle(rgba, w, cx, cy, rad, r, g, b, a = 255) {
  const r2 = rad * rad;
  for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) {
    for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) setPixel(rgba, w, x, y, r, g, b, a);
    }
  }
}

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function drawLine(rgba, w, x0, y0, x1, y1, r, g, b, a, thickness) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    fillCircle(rgba, w, x, y, thickness, r, g, b, a);
  }
}

function drawEnergy(size = 64) {
  const rgba = Buffer.alloc(size * size * 4);
  fillCircle(rgba, size, 32, 32, 30, 42, 36, 28, 255);
  const bolt = [
    [28, 10],
    [40, 10],
    [30, 28],
    [42, 28],
    [22, 54],
    [26, 34],
    [16, 34],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (pointInPoly(x, y, bolt)) setPixel(rgba, size, x, y, 236, 186, 74, 255);
    }
  }
  return encodePng(size, size, rgba);
}

function drawOrganization(size = 64) {
  const rgba = Buffer.alloc(size * size * 4);
  fillCircle(rgba, size, 32, 32, 30, 32, 40, 36, 255);
  const nodes = [
    [32, 18],
    [18, 42],
    [46, 42],
  ];
  for (const [a, b] of [
    [0, 1],
    [0, 2],
    [1, 2],
  ]) {
    drawLine(rgba, size, nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1], 140, 180, 150, 255, 3);
  }
  for (const [x, y] of nodes) {
    fillCircle(rgba, size, x, y, 6, 190, 220, 195, 255);
  }
  return encodePng(size, size, rgba);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "energy.png"), drawEnergy());
writeFileSync(join(outDir, "organization_point.png"), drawOrganization());
console.log("wrote assets/ui/energy.png & organization_point.png");
