import { containRect } from "./contain-rect";
import { QUAD_VS, bindFullscreenQuad, createProgram, createVideoTexture } from "./gl";

const PACK_FS = `
precision mediump float;
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
  private readonly gl: WebGLRenderingContext;
  private readonly uMode: WebGLUniformLocation;

  constructor(private readonly width: number, private readonly height: number) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = width * 2;
    this.canvas.height = height;
    const gl = this.canvas.getContext("webgl", { alpha: false, antialias: false, preserveDrawingBuffer: true });
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
    const gl = this.gl;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    const r = containRect(sourceWidth, sourceHeight, this.width, this.height);
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
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
