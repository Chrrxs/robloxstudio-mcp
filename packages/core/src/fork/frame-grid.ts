// frame_strip: lay N frames out as one grid image, left to right, top to bottom.

export const GRID_GAP_PX = 2;
const BACKGROUND = [32, 32, 32, 255] as const;

export interface Frame {
  rgba: Buffer;
  width: number;
  height: number;
}

export function gridShape(frames: number): { cols: number; rows: number } {
  const cols = Math.ceil(Math.sqrt(frames));
  return { cols, rows: Math.ceil(frames / cols) };
}

/** Longest tile side so the whole grid fits within maxPx. */
export function tileMaxPx(frames: number, maxPx: number): number {
  const { cols, rows } = gridShape(frames);
  const cells = Math.max(cols, rows);
  return Math.max(16, Math.floor((maxPx - GRID_GAP_PX * (cells - 1)) / cells));
}

export function composeGrid(frames: readonly Frame[]): Frame {
  const { cols, rows } = gridShape(frames.length);
  const tileW = Math.max(...frames.map((frame) => frame.width));
  const tileH = Math.max(...frames.map((frame) => frame.height));
  const width = cols * tileW + (cols - 1) * GRID_GAP_PX;
  const height = rows * tileH + (rows - 1) * GRID_GAP_PX;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set(BACKGROUND, i);
  frames.forEach((frame, index) => {
    const left = (index % cols) * (tileW + GRID_GAP_PX);
    const top = Math.floor(index / cols) * (tileH + GRID_GAP_PX);
    for (let row = 0; row < frame.height; row++) {
      frame.rgba.copy(rgba, ((top + row) * width + left) * 4, row * frame.width * 4, (row + 1) * frame.width * 4);
    }
  });
  return { rgba, width, height };
}
