export const QUAD_VS = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = (a_pos + 1.0) * 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

export function createProgram(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string): WebGLShader => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("createShader failed");
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
    }
    return shader;
  };
  const program = gl.createProgram();
  if (!program) throw new Error("createProgram failed");
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "program link failed");
  }
  gl.useProgram(program);
  return program;
}

export function bindFullscreenQuad(gl: WebGLRenderingContext, program: WebGLProgram): void {
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
}

export function createVideoTexture(gl: WebGLRenderingContext): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("createTexture failed");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  return tex;
}
