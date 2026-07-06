import { runRestrictedScript, ScriptTimeoutError } from './build-interpreter.js';

export interface BuildExecutorResult {
  parts: any[][];
  bounds: [number, number, number];
  partCount: number;
}

export interface BuildExecutorOptions {
  timeout?: number;
  maxParts?: number;
}

const DEFAULT_TIMEOUT = 10000;
const DEFAULT_MAX_PARTS = 10000;

const VALID_SHAPES = new Set(['Block', 'Wedge', 'Cylinder', 'Ball', 'CornerWedge']);

function createSeededRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0x100000000;
  };
}

function computeBoundsFromParts(parts: any[][]): [number, number, number] {
  let maxX = 0, maxY = 0, maxZ = 0;
  for (const p of parts) {
    const px = Math.abs(p[0]) + p[3] / 2;
    const py = Math.abs(p[1]) + p[4] / 2;
    const pz = Math.abs(p[2]) + p[5] / 2;
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
    maxZ = Math.max(maxZ, pz);
  }
  return [
    Math.round(maxX * 2 * 10) / 10,
    Math.round(maxY * 2 * 10) / 10,
    Math.round(maxZ * 2 * 10) / 10
  ];
}

export function runBuildExecutor(
  code: string,
  palette: Record<string, [string, string]>,
  seed?: number,
  options?: BuildExecutorOptions
): BuildExecutorResult {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
  const maxParts = options?.maxParts ?? DEFAULT_MAX_PARTS;
  const paletteKeys = new Set(Object.keys(palette));

  const parts: any[][] = [];

  function checkLimit() {
    if (parts.length >= maxParts) {
      throw new Error(`Part limit exceeded: max ${maxParts} parts allowed`);
    }
  }

  function validateKey(key: string, fnName: string) {
    if (!paletteKeys.has(key)) {
      throw new Error(`${fnName}: palette key "${key}" not found. Available keys: ${[...paletteKeys].join(', ')}`);
    }
  }

  function validateNumber(val: any, name: string) {
    if (typeof val !== 'number' || !isFinite(val)) {
      throw new Error(`${name} must be a finite number, got ${val}`);
    }
  }

  // -- Primitives --

  function partFn(
    x: number, y: number, z: number,
    sx: number, sy: number, sz: number,
    key: string,
    shape?: string,
    transparency?: number
  ) {
    validateNumber(x, 'part x'); validateNumber(y, 'part y'); validateNumber(z, 'part z');
    validateNumber(sx, 'part sx'); validateNumber(sy, 'part sy'); validateNumber(sz, 'part sz');
    validateKey(key, 'part');
    if (shape !== undefined && !VALID_SHAPES.has(shape)) {
      throw new Error(`part: invalid shape "${shape}". Valid: ${[...VALID_SHAPES].join(', ')}`);
    }
    checkLimit();

    const entry: any[] = [x, y, z, sx, sy, sz, 0, 0, 0, key];
    if (shape !== undefined) entry.push(shape);
    if (transparency !== undefined) entry.push(transparency);
    parts.push(entry);
  }

  function rpartFn(
    x: number, y: number, z: number,
    sx: number, sy: number, sz: number,
    rx: number, ry: number, rz: number,
    key: string,
    shape?: string,
    transparency?: number
  ) {
    validateNumber(x, 'rpart x'); validateNumber(y, 'rpart y'); validateNumber(z, 'rpart z');
    validateNumber(sx, 'rpart sx'); validateNumber(sy, 'rpart sy'); validateNumber(sz, 'rpart sz');
    validateNumber(rx, 'rpart rx'); validateNumber(ry, 'rpart ry'); validateNumber(rz, 'rpart rz');
    validateKey(key, 'rpart');
    if (shape !== undefined && !VALID_SHAPES.has(shape)) {
      throw new Error(`rpart: invalid shape "${shape}". Valid: ${[...VALID_SHAPES].join(', ')}`);
    }
    checkLimit();

    const entry: any[] = [x, y, z, sx, sy, sz, rx, ry, rz, key];
    if (shape !== undefined) entry.push(shape);
    if (transparency !== undefined) entry.push(transparency);
    parts.push(entry);
  }

  function fillFn(
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    key: string,
    unitSize?: [number, number, number]
  ) {
    validateKey(key, 'fill');
    [x1, y1, z1, x2, y2, z2].forEach((v, i) => validateNumber(v, `fill arg${i}`));

    if (!unitSize) {
      // Single part spanning the whole region
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      const cz = (z1 + z2) / 2;
      const sx = Math.abs(x2 - x1);
      const sy = Math.abs(y2 - y1);
      const sz = Math.abs(z2 - z1);
      checkLimit();
      parts.push([cx, cy, cz, sx, sy, sz, 0, 0, 0, key]);
    } else {
      const [ux, uy, uz] = unitSize;
      validateNumber(ux, 'fill unitSize[0]');
      validateNumber(uy, 'fill unitSize[1]');
      validateNumber(uz, 'fill unitSize[2]');

      const minX = Math.min(x1, x2);
      const minY = Math.min(y1, y2);
      const minZ = Math.min(z1, z2);
      const maxX = Math.max(x1, x2);
      const maxY = Math.max(y1, y2);
      const maxZ = Math.max(z1, z2);

      for (let x = minX + ux / 2; x < maxX; x += ux) {
        for (let y = minY + uy / 2; y < maxY; y += uy) {
          for (let z = minZ + uz / 2; z < maxZ; z += uz) {
            checkLimit();
            parts.push([
              Math.round(x * 1000) / 1000,
              Math.round(y * 1000) / 1000,
              Math.round(z * 1000) / 1000,
              ux, uy, uz, 0, 0, 0, key
            ]);
          }
        }
      }
    }
  }

  function beamFn(
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    thickness: number,
    key: string
  ) {
    validateKey(key, 'beam');
    [x1, y1, z1, x2, y2, z2, thickness].forEach((v, i) => validateNumber(v, `beam arg${i}`));

    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const cz = (z1 + z2) / 2;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dz = z2 - z1;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Compute rotation to orient the part along the beam direction
    const ry = Math.atan2(dx, dz) * (180 / Math.PI);
    const horizontalDist = Math.sqrt(dx * dx + dz * dz);
    const rx = -Math.atan2(dy, horizontalDist) * (180 / Math.PI);

    checkLimit();
    parts.push([
      Math.round(cx * 1000) / 1000,
      Math.round(cy * 1000) / 1000,
      Math.round(cz * 1000) / 1000,
      thickness, thickness, Math.round(length * 1000) / 1000,
      Math.round(rx * 100) / 100,
      Math.round(ry * 100) / 100,
      0,
      key
    ]);
  }

  function wallFn(
    x1: number, z1: number,
    x2: number, z2: number,
    height: number,
    thickness: number,
    key: string
  ) {
    validateKey(key, 'wall');
    [x1, z1, x2, z2, height, thickness].forEach((v, i) => validateNumber(v, `wall arg${i}`));

    const cx = (x1 + x2) / 2;
    const cz = (z1 + z2) / 2;
    const cy = height / 2;
    const dx = x2 - x1;
    const dz = z2 - z1;
    const wallLength = Math.sqrt(dx * dx + dz * dz);
    const ry = Math.atan2(dx, dz) * (180 / Math.PI);

    checkLimit();
    parts.push([
      Math.round(cx * 1000) / 1000,
      Math.round(cy * 1000) / 1000,
      Math.round(cz * 1000) / 1000,
      thickness,
      height,
      Math.round(wallLength * 1000) / 1000,
      0,
      Math.round(ry * 100) / 100,
      0,
      key
    ]);
  }

  function floorFn(
    x1: number, z1: number,
    x2: number, z2: number,
    y: number,
    thickness: number,
    key: string
  ) {
    validateKey(key, 'floor');
    [x1, z1, x2, z2, y, thickness].forEach((v, i) => validateNumber(v, `floor arg${i}`));

    const cx = (x1 + x2) / 2;
    const cz = (z1 + z2) / 2;
    const sx = Math.abs(x2 - x1);
    const sz = Math.abs(z2 - z1);

    checkLimit();
    parts.push([
      Math.round(cx * 1000) / 1000,
      y,
      Math.round(cz * 1000) / 1000,
      sx, thickness, sz,
      0, 0, 0,
      key
    ]);
  }

  function rowFn(
    x: number, y: number, z: number,
    count: number,
    spacingX: number, spacingZ: number,
    partFnCb: (i: number, cx: number, cy: number, cz: number) => void
  ) {
    validateNumber(x, 'row x'); validateNumber(y, 'row y'); validateNumber(z, 'row z');
    validateNumber(count, 'row count');
    validateNumber(spacingX, 'row spacingX'); validateNumber(spacingZ, 'row spacingZ');
    if (typeof partFnCb !== 'function') {
      throw new Error('row: partFn must be a function');
    }

    for (let i = 0; i < count; i++) {
      partFnCb(i, x + i * spacingX, y, z + i * spacingZ);
    }
  }

  function gridFn(
    x: number, y: number, z: number,
    countX: number, countZ: number,
    spacingX: number, spacingZ: number,
    partFnCb: (ix: number, iz: number, cx: number, cy: number, cz: number) => void
  ) {
    validateNumber(x, 'grid x'); validateNumber(y, 'grid y'); validateNumber(z, 'grid z');
    validateNumber(countX, 'grid countX'); validateNumber(countZ, 'grid countZ');
    validateNumber(spacingX, 'grid spacingX'); validateNumber(spacingZ, 'grid spacingZ');
    if (typeof partFnCb !== 'function') {
      throw new Error('grid: partFn must be a function');
    }

    for (let ix = 0; ix < countX; ix++) {
      for (let iz = 0; iz < countZ; iz++) {
        partFnCb(ix, iz, x + ix * spacingX, y, z + iz * spacingZ);
      }
    }
  }

  // -- High-level composite primitives --

  function roomFn(
    x: number, y: number, z: number,
    w: number, h: number, d: number,
    wallKey: string,
    floorKey?: string,
    ceilKey?: string,
    wallThickness?: number
  ) {
    const t = wallThickness ?? 1;
    const fk = floorKey ?? wallKey;
    const ck = ceilKey ?? wallKey;

    // Floor
    floorFn(x - w/2, z - d/2, x + w/2, z + d/2, y, t, fk);
    // Ceiling
    floorFn(x - w/2, z - d/2, x + w/2, z + d/2, y + h, t, ck);
    // 4 walls
    wallFn(x - w/2, z - d/2, x - w/2, z + d/2, h, t, wallKey); // left
    wallFn(x + w/2, z - d/2, x + w/2, z + d/2, h, t, wallKey); // right
    wallFn(x - w/2, z - d/2, x + w/2, z - d/2, h, t, wallKey); // back
    wallFn(x - w/2, z + d/2, x + w/2, z + d/2, h, t, wallKey); // front
  }

  function roofFn(
    x: number, y: number, z: number,
    w: number, d: number,
    style: string,
    key: string,
    overhang?: number
  ) {
    const oh = overhang ?? 1;
    validateKey(key, 'roof');

    if (style === 'flat') {
      floorFn(x - w/2 - oh, z - d/2 - oh, x + w/2 + oh, z + d/2 + oh, y, 1, key);
    } else if (style === 'gable') {
      // Two angled slopes along X axis, ridge along Z
      const peakH = w / 2 * 0.6; // roof pitch
      const slopeW = Math.sqrt((w/2 + oh) * (w/2 + oh) + peakH * peakH);
      const angle = Math.atan2(peakH, w/2 + oh) * (180 / Math.PI);
      // Left slope
      rpartFn(x - (w/4 + oh/2) * 0.5, y + peakH/2, z, slopeW, 0.5, d + oh * 2, -angle, 0, 0, key);
      // Right slope
      rpartFn(x + (w/4 + oh/2) * 0.5, y + peakH/2, z, slopeW, 0.5, d + oh * 2, angle, 0, 0, key);
    } else if (style === 'hip') {
      // Simple hip roof approximation - flat top with 4 wedge sides
      const peakH = w / 3;
      floorFn(x - w/4, z - d/4, x + w/4, z + d/4, y + peakH, 0.5, key);
      const slopeW = Math.sqrt((w/2 + oh) * (w/2 + oh) + peakH * peakH);
      const angle = Math.atan2(peakH, w/2 + oh) * (180 / Math.PI);
      rpartFn(x - w/4, y + peakH/2, z, slopeW * 0.6, 0.5, d + oh, -angle, 0, 0, key);
      rpartFn(x + w/4, y + peakH/2, z, slopeW * 0.6, 0.5, d + oh, angle, 0, 0, key);
    }
  }

  function stairsFn(
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    w: number,
    key: string
  ) {
    validateKey(key, 'stairs');
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dz = z2 - z1;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const stepCount = Math.max(2, Math.round(Math.abs(dy) / 0.5));
    const stepH = dy / stepCount;
    const stepDx = dx / stepCount;
    const stepDz = dz / stepCount;

    for (let i = 0; i < stepCount; i++) {
      checkLimit();
      const sx = x1 + stepDx * (i + 0.5);
      const sy = y1 + stepH * (i + 0.5);
      const sz = z1 + stepDz * (i + 0.5);
      const stepDepth = dist / stepCount;
      partFn(
        Math.round(sx * 100) / 100,
        Math.round(sy * 100) / 100,
        Math.round(sz * 100) / 100,
        w, Math.abs(stepH), stepDepth, key
      );
    }
  }

  function archFn(
    x: number, y: number, z: number,
    w: number, h: number,
    thickness: number,
    key: string,
    segments?: number
  ) {
    validateKey(key, 'arch');
    const segs = segments ?? 8;
    const radius = w / 2;
    const archH = h - radius; // straight part below arch curve

    // Straight sides
    if (archH > 0) {
      partFn(x - w/2, y + archH/2, z, thickness, archH, thickness, key);
      partFn(x + w/2, y + archH/2, z, thickness, archH, thickness, key);
    }

    // Curved top
    for (let i = 0; i < segs; i++) {
      const a1 = (Math.PI / segs) * i;
      const a2 = (Math.PI / segs) * (i + 1);
      const mx = x + radius * Math.cos((a1 + a2) / 2 + Math.PI / 2);
      const my = y + archH + radius * Math.sin((a1 + a2) / 2 + Math.PI / 2) * (radius / (radius || 1));
      checkLimit();
      const segLen = 2 * radius * Math.sin((a2 - a1) / 2);
      const angle = ((a1 + a2) / 2) * (180 / Math.PI);
      rpartFn(
        Math.round(mx * 100) / 100,
        Math.round(my * 100) / 100,
        z,
        segLen, thickness, thickness,
        0, 0, Math.round(angle * 100) / 100,
        key
      );
    }
  }

  function columnFn(
    x: number, y: number, z: number,
    height: number, radius: number,
    key: string,
    capKey?: string
  ) {
    validateKey(key, 'column');
    // Shaft - Roblox cylinders axis is X, so rotate 90 on Z to stand upright
    // Size: X=height (axis length), Y=diameter, Z=diameter
    rpartFn(x, y + height/2, z, height, radius * 2, radius * 2, 0, 0, 90, key, 'Cylinder');
    // Base
    const ck = capKey ?? key;
    validateKey(ck, 'column cap');
    partFn(x, y + 0.25, z, radius * 2.5, 0.5, radius * 2.5, ck);
    // Capital
    partFn(x, y + height - 0.25, z, radius * 2.5, 0.5, radius * 2.5, ck);
  }

  function pewFn(
    x: number, y: number, z: number,
    w: number, d: number,
    seatKey: string,
    legKey?: string
  ) {
    validateKey(seatKey, 'pew');
    const lk = legKey ?? seatKey;
    validateKey(lk, 'pew legs');
    // Seat
    partFn(x, y + 1.5, z, w, 0.3, d, seatKey);
    // Backrest
    partFn(x, y + 2.5, z - d/2 + 0.15, w, 2, 0.3, seatKey);
    // Legs
    partFn(x - w/2 + 0.25, y + 0.75, z, 0.5, 1.5, d, lk);
    partFn(x + w/2 - 0.25, y + 0.75, z, 0.5, 1.5, d, lk);
  }

  function fenceFn(
    x1: number, z1: number,
    x2: number, z2: number,
    y: number,
    key: string,
    postSpacing?: number
  ) {
    validateKey(key, 'fence');
    const spacing = postSpacing ?? 4;
    const dx = x2 - x1;
    const dz = z2 - z1;
    const length = Math.sqrt(dx * dx + dz * dz);
    const count = Math.max(2, Math.round(length / spacing) + 1);

    // Posts
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      checkLimit();
      partFn(x1 + dx * t, y + 1.5, z1 + dz * t, 0.5, 3, 0.5, key);
    }

    // Rails
    wallFn(x1, z1, x2, z2, 1, 0.3, key);
    // Top rail offset
    const cx = (x1 + x2) / 2;
    const cz = (z1 + z2) / 2;
    const ry = Math.atan2(dx, dz) * (180 / Math.PI);
    checkLimit();
    parts.push([
      Math.round(cx * 1000) / 1000,
      y + 2.5,
      Math.round(cz * 1000) / 1000,
      0.3, 0.3, Math.round(length * 1000) / 1000,
      0, Math.round(ry * 100) / 100, 0,
      key
    ]);
  }

  // -- Build the sandbox globals --

  const rng = createSeededRng(seed ?? 42);

  // Frozen copy of Math so build code can't mutate the real global Math
  // (Math's own properties are non-enumerable, so spread won't copy them).
  const safeMath = Object.freeze(
    Object.create(null, Object.getOwnPropertyDescriptors(Math)),
  );

  const sandbox: Record<string, any> = {
    part: partFn,
    rpart: rpartFn,
    fill: fillFn,
    beam: beamFn,
    wall: wallFn,
    floor: floorFn,
    row: rowFn,
    grid: gridFn,
    room: roomFn,
    roof: roofFn,
    stairs: stairsFn,
    arch: archFn,
    column: columnFn,
    pew: pewFn,
    fence: fenceFn,
    Math: safeMath,
    GRID_SIZE: 1,
    rng: rng,
    console: Object.freeze({ log: () => {}, warn: () => {}, error: () => {} }),
  };

  try {
    runRestrictedScript(code, sandbox, { timeoutMs: timeout });
  } catch (err: any) {
    if (err instanceof ScriptTimeoutError) {
      throw new Error(`Build code execution timed out after ${timeout}ms`);
    }
    throw new Error(`Build code execution error: ${err?.message ?? String(err)}`);
  }

  if (parts.length === 0) {
    throw new Error('Build code produced no parts. Make sure to call part(), wall(), floor(), etc.');
  }

  const bounds = computeBoundsFromParts(parts);

  return { parts, bounds, partCount: parts.length };
}
