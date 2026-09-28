import { QUAD_VS, bindFullscreenQuad, createProgram, createVideoTexture } from "./gl";

const UNPACK_FS = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_srcPremultiplied;
uniform float u_packedWidth;
void main() {
  float halfTexel = 0.5 / u_packedWidth;
  float rgbU = clamp(v_uv.x * 0.5, halfTexel, 0.5 - halfTexel);
  float aU = clamp(0.5 + v_uv.x * 0.5, 0.5 + halfTexel, 1.0 - halfTexel);
  vec3 rgb = texture2D(u_tex, vec2(rgbU, v_uv.y)).rgb;
  vec4 aSample = texture2D(u_tex, vec2(aU, v_uv.y));
  float a = dot(aSample.rgb, vec3(0.2126, 0.7152, 0.0722));
  a = clamp((a - 2.0 / 255.0) * (255.0 / 253.0), 0.0, 1.0);
  gl_FragColor = u_srcPremultiplied > 0.5 ? vec4(min(rgb, vec3(a)), a) : vec4(rgb * a, a);
}`;

/** Renders a packed [RGB | A] frame onto a transparent canvas (premultiplied output). */
export class AlphaUnpacker {
  private gl!: WebGLRenderingContext;
  private uSrcPremultiplied!: WebGLUniformLocation;
  private uPackedWidth!: WebGLUniformLocation;
  private readonly srcPremultiplied: boolean;
  private readonly preserveDrawingBuffer: boolean;
  private contextLost = false;
  private disposed = false;
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
      console.error("[hive] AlphaUnpacker: could not re-initialise the restored WebGL context", err);
    }
  };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    opts: { srcPremultiplied?: boolean; preserveDrawingBuffer?: boolean } = {},
  ) {
    this.srcPremultiplied = opts.srcPremultiplied ?? false;
    this.preserveDrawingBuffer = opts.preserveDrawingBuffer ?? false;
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    this.init();
  }

  private init(): void {
    const gl = this.canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      preserveDrawingBuffer: this.preserveDrawingBuffer,
    });
    if (!gl) throw new Error("WebGL unavailable");
    this.gl = gl;
    const program = createProgram(gl, QUAD_VS, UNPACK_FS);
    bindFullscreenQuad(gl, program);
    createVideoTexture(gl, gl.NEAREST);
    const uSrcPremultiplied = gl.getUniformLocation(program, "u_srcPremultiplied");
    if (!uSrcPremultiplied) throw new Error("u_srcPremultiplied missing");
    this.uSrcPremultiplied = uSrcPremultiplied;
    const uPackedWidth = gl.getUniformLocation(program, "u_packedWidth");
    if (!uPackedWidth) throw new Error("u_packedWidth missing");
    this.uPackedWidth = uPackedWidth;
    gl.uniform1f(this.uSrcPremultiplied, this.srcPremultiplied ? 1 : 0);
    gl.clearColor(0, 0, 0, 0);
  }

  /** Returns false when the source has no frame yet, or the context is currently lost. */
  draw(source: TexImageSource, packedWidth: number, packedHeight: number): boolean {
    if (this.contextLost) return false;
    if (packedWidth < 2 || packedHeight < 1) return false;
    const w = Math.floor(packedWidth / 2);
    if (this.canvas.width !== w || this.canvas.height !== packedHeight) {
      this.canvas.width = w;
      this.canvas.height = packedHeight;
    }
    const gl = this.gl;
    gl.viewport(0, 0, w, packedHeight);
    gl.uniform1f(this.uPackedWidth, packedWidth);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }

  clear(): void {
    if (this.contextLost) return;
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  dispose(): void {
    this.disposed = true;
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
