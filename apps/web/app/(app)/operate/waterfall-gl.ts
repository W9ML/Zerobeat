/**
 * WebGL2 waterfall renderer. Rows live in a ring texture on the GPU (R = level,
 * G = row flags: 1 a cycle-boundary marker, 0.5 our own transmission), so scrolling is a uniform change, not a pixel copy: the
 * picture moves by fractions of a row every frame instead of jumping when rows arrive.
 *
 *   2D  full-screen quad; each pixel takes the max of the rows and bins it covers, so
 *       narrow signals never flicker in and out as the picture scrolls.
 *   3D  a height-field mesh, one mesh row per data row (or per 2–3 rows on long spans),
 *       offset in depth by the playhead's fraction so it glides instead of stepping.
 */

export const HIST = 1600; // rows kept on the GPU: 80 s at 20 rows/s
const GX = 256; // 3D mesh columns
const GY = 200; // 3D mesh rows

const QUAD_VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FLAT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uData;
uniform sampler2D uPal;
uniform float uHead;   // playhead, rows, modulo HIST
uniform float uAvail;  // rows behind the playhead that hold data
uniform float uRows;   // rows shown top to bottom
uniform float uHist;
uniform float uBins;
uniform vec2 uPx;
uniform float uLo;
uniform float uSpan;
float toDb(float v) { return v * 102.0 - 10.0; }
vec3 txColour(float t) {
  vec3 c = mix(vec3(0.0), vec3(1.0, 0.5, 0.15), smoothstep(0.12, 0.4, t));
  return mix(c, vec3(1.0, 0.93, 0.75), smoothstep(0.45, 0.8, t));
}
void main() {
  float age = (1.0 - vUv.y) * uRows;
  float rpp = uRows / uPx.y;
  float bpp = uBins / uPx.x;
  // Average over time (calms the noise; signals last seconds anyway), max over
  // frequency (a narrow signal never drops out when bins outnumber pixels).
  float sum = 0.0;
  float n = 0.0;
  float mark = 0.0;
  float tx = 0.0;
  int steps = rpp > 1.0 ? 4 : 1;
  for (int i = 0; i < 4; i++) {
    if (i >= steps) break;
    float back = age + rpp * float(i) * 0.25;
    if (back + 1.0 > uAvail) break;
    float v = (uHead - 1.0 - back + 0.5) / uHist;
    float m = 0.0;
    for (int j = 0; j < 2; j++) {
      float u = (vUv.x * uBins + bpp * float(j) * 0.5 + 0.5) / uBins;
      m = max(m, texture(uData, vec2(u, v)).r);
      // Flags from the row itself, not blended: a cycle mark (1) filtered against its
      // neighbours (0) passes through 0.5 and drew every cycle line as transmit red.
      float g = texelFetch(uData, ivec2(int(min(u * uBins, uBins - 1.0)), int(mod(floor(v * uHist), uHist))), 0).g;
      mark = max(mark, step(0.75, g));
      tx = max(tx, step(0.3, g) * (1.0 - step(0.75, g)));
    }
    sum += m;
    n += 1.0;
  }
  // No audio for this row yet (just opened, or history not filled): black, not the
  // bottom of the colour scale.
  if (n == 0.0) {
    o = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float t = clamp((toDb(sum / n) - uLo) / uSpan, 0.0, 1.0);
  vec3 c = texture(uPal, vec2(t * 255.0 / 256.0 + 0.5 / 256.0, 0.5)).rgb;
  // Our transmission: the signal in transmit orange on black, as bright as
  // a strong received signal (the old ramp only reached full orange at the top of the scale).
  c = mix(c, txColour(t), tx);
  o = vec4(mix(c, vec3(1.0), mark * 0.1), 1.0);
}`;

const MESH_VS = `#version 300 es
precision highp float;
in vec2 aGrid;
uniform sampler2D uData;
uniform sampler2D uPal;
uniform float uBase;   // newest data row of mesh row 0, modulo HIST
uniform float uAvail;
uniform float uFrac;
uniform float uStep;
uniform float uHist;
uniform float uBins;
uniform float uLo;
uniform float uSpan;
uniform vec3 uBg;
out vec3 vCol;
const float GX = ${GX}.0;
const float GY = ${GY}.0;
float toDb(float v) { return v * 102.0 - 10.0; }
vec2 level(float col, float j) {
  float bpc = uBins / GX;
  float m = 0.0;
  float mark = 0.0;
  for (int k = 0; k < 3; k++) {
    if (float(k) >= uStep) break;
    float back = j * uStep + float(k);
    if (back + 1.0 > uAvail) break;
    int y = int(mod(uBase - back + uHist, uHist));
    for (int b = 0; b < 3; b++) {
      if (float(b) >= bpc) break;
      int x = int(min(floor(col * bpc) + float(b), uBins - 1.0));
      vec2 s = texelFetch(uData, ivec2(x, y), 0).rg;
      m = max(m, s.r);
      mark = max(mark, s.g);
    }
  }
  return vec2(clamp((toDb(m) - uLo) / uSpan, 0.0, 1.0), mark);
}
float txOf(float g) { return step(0.3, g) * (1.0 - step(0.75, g)); }
vec3 txColour(float t) {
  vec3 c = mix(vec3(0.0), vec3(1.0, 0.5, 0.15), smoothstep(0.12, 0.4, t));
  return mix(c, vec3(1.0, 0.93, 0.75), smoothstep(0.45, 0.8, t));
}
void main() {
  float col = aGrid.x;
  float j = aGrid.y;
  vec2 s = level(col, j);
  float h = s.x;
  float hx = level(min(col + 1.0, GX - 1.0), j).x;
  float hz = level(col, min(j + 1.0, GY - 1.0)).x;
  float u = col / (GX - 1.0);
  float d = (j + uFrac) / GY;
  float sc = 1.0 / (1.0 + 2.4 * d);
  gl_Position = vec4((u * 2.0 - 1.0) * sc, -0.94 + (1.0 - sc) * 2.0 + h * 0.95 * sc, d * 2.0 - 1.0, 1.0);
  // Shade from the surface slope: world width 2, depth 3, height 0.6.
  float sx = (hx - h) * 0.6 / (2.0 / (GX - 1.0));
  float sz = (hz - h) * 0.6 / (3.0 / GY);
  vec3 n = normalize(vec3(-sx, 1.0, -sz));
  float diff = max(dot(n, normalize(vec3(-0.25, 0.85, -0.55))), 0.0);
  vec3 c = texture(uPal, vec2(h * 255.0 / 256.0 + 0.5 / 256.0, 0.5)).rgb;
  float tx = txOf(s.y);
  c = mix(c, txColour(h), tx);
  c = mix(c, vec3(1.0), step(0.75, s.y) * 0.15) * (0.45 + 0.65 * diff);
  // Rows with no audio yet are black.
  c *= step(j * uStep + 1.0, uAvail);
  vCol = mix(c, uBg, d * 0.55);
}`;

const MESH_FS = `#version 300 es
precision highp float;
in vec3 vCol;
out vec4 o;
void main() { o = vec4(vCol, 1.0); }`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`waterfall shader: ${gl.getShaderInfoLog(sh)}`);
    gl.attachShader(p, sh);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`waterfall program: ${gl.getProgramInfoLog(p)}`);
  return p;
}

export interface Frame {
  view: "flat" | "3d";
  /** Playhead in absolute rows (fractional). Rows below it are visible. */
  head: number;
  /** Rows shown (flat) or covered (3D). */
  rows: number;
  lo: number;
  span: number;
}

export class WaterfallGL {
  private readonly gl: WebGL2RenderingContext;
  private readonly flat: WebGLProgram;
  private readonly mesh: WebGLProgram;
  private readonly quadVao: WebGLVertexArrayObject;
  private readonly meshVao: WebGLVertexArrayObject;
  private readonly meshCount: number;
  private readonly palTex: WebGLTexture;
  private dataTex: WebGLTexture | null = null;
  private bins = 0;
  private scratch = new Uint8Array(0);
  private loc = new Map<string, WebGLUniformLocation | null>();
  /** Rows written so far. */
  total = 0;

  static supported(): boolean {
    try {
      return !!document.createElement("canvas").getContext("webgl2");
    } catch {
      return false;
    }
  }

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.flat = compile(gl, QUAD_VS, FLAT_FS);
    this.mesh = compile(gl, MESH_VS, MESH_FS);

    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const qa = gl.getAttribLocation(this.flat, "aPos");
    gl.enableVertexAttribArray(qa);
    gl.vertexAttribPointer(qa, 2, gl.FLOAT, false, 0, 0);

    this.meshVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.meshVao);
    const grid = new Float32Array(GX * GY * 2);
    for (let j = 0; j < GY; j++)
      for (let c = 0; c < GX; c++) {
        grid[(j * GX + c) * 2] = c;
        grid[(j * GX + c) * 2 + 1] = j;
      }
    const idx = new Uint16Array((GX - 1) * (GY - 1) * 6);
    let n = 0;
    // Far rows first so equal-depth ties resolve toward the viewer.
    for (let j = GY - 2; j >= 0; j--)
      for (let c = 0; c < GX - 1; c++) {
        const a = j * GX + c;
        idx[n++] = a;
        idx[n++] = a + 1;
        idx[n++] = a + GX;
        idx[n++] = a + 1;
        idx[n++] = a + GX + 1;
        idx[n++] = a + GX;
      }
    this.meshCount = n;
    const gb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, gb);
    gl.bufferData(gl.ARRAY_BUFFER, grid, gl.STATIC_DRAW);
    const ga = gl.getAttribLocation(this.mesh, "aGrid");
    gl.enableVertexAttribArray(ga);
    gl.vertexAttribPointer(ga, 2, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    this.palTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.palTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(256 * 4));
  }

  setPalette(rgba: Uint8Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.palTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  }

  private ensureData(bins: number): void {
    if (bins === this.bins && this.dataTex) return;
    const gl = this.gl;
    if (this.dataTex) gl.deleteTexture(this.dataTex);
    this.bins = bins;
    this.total = 0;
    this.scratch = new Uint8Array(bins * 2);
    this.dataTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, bins, HIST, 0, gl.RG, gl.UNSIGNED_BYTE, new Uint8Array(bins * HIST * 2));
  }

  /** Append one row. `mark` draws a faint line (a transmit-cycle boundary); `tx` tints it as ours. */
  push(row: Uint8Array, mark: boolean, tx = false): void {
    this.ensureData(row.length);
    const gl = this.gl;
    const s = this.scratch;
    const m = mark ? 255 : tx ? 128 : 0;
    for (let i = 0; i < row.length; i++) {
      s[i * 2] = row[i]!;
      s[i * 2 + 1] = m;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, this.total % HIST, row.length, 1, gl.RG, gl.UNSIGNED_BYTE, s);
    this.total++;
  }

  private u(p: WebGLProgram, name: string): WebGLUniformLocation | null {
    const key = `${p === this.flat ? "f" : "m"}:${name}`;
    if (!this.loc.has(key)) this.loc.set(key, this.gl.getUniformLocation(p, name));
    return this.loc.get(key)!;
  }

  /** Match the drawing buffer to the canvas's CSS size. */
  private fit(): [number, number] {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    return [w, h];
  }

  render(f: Frame): void {
    const gl = this.gl;
    const [w, h] = this.fit();
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.027, 0.035, 0.05, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.dataTex) return;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.palTex);

    if (f.view === "flat") {
      const p = this.flat;
      gl.useProgram(p);
      gl.disable(gl.DEPTH_TEST);
      gl.uniform1i(this.u(p, "uData"), 0);
      gl.uniform1i(this.u(p, "uPal"), 1);
      gl.uniform1f(this.u(p, "uHead"), f.head % HIST);
      gl.uniform1f(this.u(p, "uAvail"), Math.min(f.head, HIST - 2));
      gl.uniform1f(this.u(p, "uRows"), f.rows);
      gl.uniform1f(this.u(p, "uHist"), HIST);
      gl.uniform1f(this.u(p, "uBins"), this.bins);
      gl.uniform2f(this.u(p, "uPx"), w, h);
      gl.uniform1f(this.u(p, "uLo"), f.lo);
      gl.uniform1f(this.u(p, "uSpan"), f.span);
      gl.bindVertexArray(this.quadVao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } else {
      const p = this.mesh;
      gl.useProgram(p);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      const step = Math.min(3, Math.max(1, Math.round(f.rows / GY)));
      const base = Math.floor(f.head / step) * step;
      gl.uniform1i(this.u(p, "uData"), 0);
      gl.uniform1i(this.u(p, "uPal"), 1);
      gl.uniform1f(this.u(p, "uBase"), (((base - 1) % HIST) + HIST) % HIST);
      gl.uniform1f(this.u(p, "uAvail"), Math.min(base, HIST - 2));
      gl.uniform1f(this.u(p, "uFrac"), (f.head - base) / step);
      gl.uniform1f(this.u(p, "uStep"), step);
      gl.uniform1f(this.u(p, "uHist"), HIST);
      gl.uniform1f(this.u(p, "uBins"), this.bins);
      gl.uniform1f(this.u(p, "uLo"), f.lo);
      gl.uniform1f(this.u(p, "uSpan"), f.span);
      gl.uniform3f(this.u(p, "uBg"), 0.027, 0.035, 0.05);
      gl.bindVertexArray(this.meshVao);
      gl.drawElements(gl.TRIANGLES, this.meshCount, gl.UNSIGNED_SHORT, 0);
    }
    gl.bindVertexArray(null);
  }

  /** Free GPU objects. The context itself is kept: a remount on the same canvas reuses it. */
  dispose(): void {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    if (this.dataTex) gl.deleteTexture(this.dataTex);
    gl.deleteTexture(this.palTex);
    gl.deleteVertexArray(this.quadVao);
    gl.deleteVertexArray(this.meshVao);
    gl.deleteProgram(this.flat);
    gl.deleteProgram(this.mesh);
    this.dataTex = null;
  }
}
