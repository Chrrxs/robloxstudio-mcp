import { runBuildExecutor } from '../tools/build-executor.js';

const PALETTE: Record<string, [string, string]> = {
  a: ['Dark stone grey', 'Cobblestone'],
  b: ['Brown', 'WoodPlanks'],
  c: ['Really red', 'Slate'],
  d: ['Reddish brown', 'Wood'],
};

describe('runBuildExecutor', () => {
  it('runs the documented example build', () => {
    const code = `
room(0,0,0,8,4,6,"a","b","a")
roof(0,4,0,8,6,"gable","c")
wall(-4,-2,4,-2,4,1,"a")
part(0,2,3,3,3,0.3,"a","Block",0.4)
row(-2,0,-1,3,0,2,(i,cx,cy,cz)=>{pew(cx,0,cz,3,2,"d")})
column(-3,0,-2,4,0.5,"a","b")
column(3,0,-2,4,0.5,"a","b")
part(0,2,0,2,1,1,"b")
`;
    const result = runBuildExecutor(code, PALETTE);
    expect(result.partCount).toBeGreaterThan(20);
    expect(result.bounds.length).toBe(3);
  });

  it('supports loops, functions, arrays, objects, and Math', () => {
    const code = `
const heights = [2, 3, 4];
function tower(x, h) {
  for (let i = 0; i < h; i++) part(x, i + 0.5, 0, 1, 1, 1, "a");
}
heights.forEach((h, i) => tower(i * 2, h));
const cfg = { radius: Math.max(1, 2) };
part(10, cfg.radius, 0, 1, 1, 1, "b");
grid(0, 0, 10, 2, 2, 3, 3, (ix, iz, cx, cy, cz) => {
  part(cx, cy + 0.5, cz, 1, 1, 1, "c");
});
`;
    const result = runBuildExecutor(code, PALETTE);
    expect(result.partCount).toBe(2 + 3 + 4 + 1 + 4);
  });

  it('rng() is deterministic per seed', () => {
    const code = `part(rng() * 10, 1, 0, 1, 1, 1, "a")`;
    const a = runBuildExecutor(code, PALETTE, 7);
    const b = runBuildExecutor(code, PALETTE, 7);
    const c = runBuildExecutor(code, PALETTE, 8);
    expect(a.parts[0][0]).toBe(b.parts[0][0]);
    expect(a.parts[0][0]).not.toBe(c.parts[0][0]);
  });

  it('still enforces palette keys and part limits', () => {
    expect(() => runBuildExecutor(`part(0,0,0,1,1,1,"nope")`, PALETTE)).toThrow(/palette key/);
    expect(() =>
      runBuildExecutor(`for (let i = 0; i < 99999; i++) part(i,0,0,1,1,1,"a")`, PALETTE, 42, { maxParts: 100 }),
    ).toThrow(/Part limit exceeded/);
  });

  it('terminates runaway code', () => {
    expect(() =>
      runBuildExecutor(`part(0,0,0,1,1,1,"a"); while (true) {}`, PALETTE, 42, { timeout: 200 }),
    ).toThrow(/timed out/);
  });

  describe('sandbox escapes are blocked', () => {
    const attempts: Array<[string, string]> = [
      ['constructor chain', `part(({}).constructor.constructor("return process")(), 0,0,1,1,1,"a")`],
      ['function constructor', `const f = (() => {}).constructor("return globalThis"); part(0,0,0,1,1,1,"a")`],
      ['__proto__ access', `const x = {}; x.__proto__.polluted = true; part(0,0,0,1,1,1,"a")`],
      ['prototype access', `part.prototype; part(0,0,0,1,1,1,"a")`],
      ['Math.constructor', `Math.constructor.constructor("return process")(); part(0,0,0,1,1,1,"a")`],
      ['computed constructor', `const k = "const" + "ructor"; ({})[k]; part(0,0,0,1,1,1,"a")`],
      ['process global', `process.exit(1)`],
      ['globalThis', `globalThis.process.exit(1)`],
      ['require', `require("child_process")`],
      ['import()', `import("fs")`],
      ['new Function via array', `[].map.constructor("return this")()`],
      ['this at top level', `this.constructor`],
      ['new expression', `new Array(5)`],
      ['bind/call/apply', `part.call(undefined, 0,0,0,1,1,1,"a")`],
      ['mutating frozen Math', `Math.max = () => 1; part(0,0,0,1,1,1,"a")`],
    ];

    it.each(attempts)('%s', (_name, code) => {
      expect(() => runBuildExecutor(code, PALETTE)).toThrow();
      // And nothing leaked into the host realm:
      expect((Object.prototype as any).polluted).toBeUndefined();
      expect(Math.max(1, 2)).toBe(2);
    });
  });
});
