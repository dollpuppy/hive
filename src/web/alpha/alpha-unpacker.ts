import { QUAD_VS, bindFullscreenQuad, createProgram, createVideoTexture } from "./gl";

const UNPACK_FS = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_srcPremultiplied;
void main() {
  vec3 rgb = texture2D(u_tex, vec2(v_uv.x * 0.5, v_uv.y)).rgb;
  float a = texture2D(u_tex, vec2(0.5 + v_uv.x * 0.5, v_uv.y)).r;
  gl_FragColor = u_srcPremultiplied > 0.5 ? vec4(rgb, a) : vec4(rgb * a, a);
}`;

/** Renders a packed [RGB | A] frame onto a transparent canvas (premultiplied output). */
export class AlphaUnpacker {
  private readonly gl: WebGLRenderingContext;

  constructor(private readonly canvas: HTMLCanvasElement, opts: { srcPremultiplied?: boolean } = {}) {
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL unavailable");
    this.gl = gl;
    const program = createProgram(gl, QUAD_VS, UNPACK_FS);
    bindFullscreenQuad(gl, program);
    createVideoTexture(gl);
    const uSrcPremultiplied = gl.getUniformLocation(program, "u_srcPremultiplied");
    if (!uSrcPremultiplied) throw new Error("u_srcPremultiplied missing");
    gl.uniform1f(uSrcPremultiplied, opts.srcPremultiplied ? 1 : 0);
    gl.clearColor(0, 0, 0, 0);
  }

  /** Returns false when the source has no frame yet. */
  draw(source: TexImageSource, packedWidth: number, packedHeight: number): boolean {
    if (packedWidth < 2 || packedHeight < 1) return false;
    const w = Math.floor(packedWidth / 2);
    if (this.canvas.width !== w || this.canvas.height !== packedHeight) {
      this.canvas.width = w;
      this.canvas.height = packedHeight;
    }
    const gl = this.gl;
    gl.viewport(0, 0, w, packedHeight);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }

  clear(): void {
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }
}
