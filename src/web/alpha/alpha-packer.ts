import { type Rect, containRect } from "./contain-rect";
import { QUAD_VS, bindFullscreenQuad, createProgram, createVideoTexture } from "./gl";

const PACK_FS = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_mode;
void main() {
  vec4 c = texture2D(u_tex, v_uv);
  gl_FragColor = u_mode < 0.5 ? vec4(c.rgb, 1.0) : vec4(c.a, c.a, c.a, 1.0);
}`;

/** Draws RGBA frames into a 2W×H opaque canvas: [RGB | A]. */
export class AlphaPacker {
  readonly canvas: HTMLCanvasElement;
  private gl!: WebGLRenderingContext;
  private uMode!: WebGLUniformLocation;
  private readonly preserveDrawingBuffer: boolean;
  private contextLost = false;
  private disposed = false;
  /** Rect from the last draw()'s containRect, so redraw() can re-run it without a fresh upload. */
  private lastRect: Rect | null = null;
  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
  };
  private readonly onContextRestored = (): void => {
    if (this.disposed) return;
    try {
      this.init();
      this.contextLost = false;
    } catch (err) {
      // Stay "lost" (draws are no-ops) rather than throw out of the event handler.
      console.error("[hive] AlphaPacker: could not re-initialise the restored WebGL context", err);
    }
  };

  constructor(
    private readonly width: number,
    private readonly height: number,
    opts: { preserveDrawingBuffer?: boolean } = {},
  ) {
    if (width % 2 !== 0) throw new Error("AlphaPacker width must be even");
    this.preserveDrawingBuffer = opts.preserveDrawingBuffer ?? false;
    this.canvas = document.createElement("canvas");
    this.canvas.width = width * 2;
    this.canvas.height = height;
    this.canvas.addEventListener("webglcontextlost", this.onContextLost);
    this.canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    this.init();
  }

  private init(): void {
    // A restored context has a fresh, empty texture, so any pending redraw() is stale.
    this.lastRect = null;
    const gl = this.canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: this.preserveDrawingBuffer,
    });
    if (!gl) throw new Error("WebGL unavailable");
    this.gl = gl;
    const program = createProgram(gl, QUAD_VS, PACK_FS);
    bindFullscreenQuad(gl, program);
    createVideoTexture(gl);
    const uMode = gl.getUniformLocation(program, "u_mode");
    if (!uMode) throw new Error("u_mode missing");
    this.uMode = uMode;
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Must be called synchronously with a live frame (texture-bridge closes it after the handler). */
  draw(source: TexImageSource, sourceWidth: number, sourceHeight: number): void {
    if (this.contextLost) return;
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, source);
    const r = containRect(sourceWidth, sourceHeight, this.width, this.height);
    this.lastRect = r;
    this.paint(r);
  }

  /**
   * Re-runs the last draw() from the already-uploaded texture (it keeps its data after
   * the source VideoFrame is closed) without re-uploading anything. Used by the idle
   * keepalive to mark the canvas dirty with unchanged content so captureStream() emits
   * a frame. No-op before the first draw(), or while the context is lost/was just
   * restored (its texture is fresh and empty).
   */
  redraw(): void {
    if (this.contextLost || !this.lastRect) return;
    this.paint(this.lastRect);
  }

  private paint(r: Rect): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.width * 2, this.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(r.x, r.y, r.w, r.h);
    gl.uniform1f(this.uMode, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.viewport(this.width + r.x, r.y, r.w, r.h);
    gl.uniform1f(this.uMode, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose(): void {
    this.disposed = true;
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
