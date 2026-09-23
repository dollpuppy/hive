import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/web/alpha/gl", () => ({
  QUAD_VS: "",
  createProgram: () => ({}),
  bindFullscreenQuad: () => undefined,
  createVideoTexture: () => ({}),
}));

import { AlphaPacker } from "../../src/web/alpha/alpha-packer";
import { AlphaUnpacker } from "../../src/web/alpha/alpha-unpacker";

function fakeGl() {
  return {
    TEXTURE_2D: 0,
    RGBA: 0,
    UNSIGNED_BYTE: 0,
    COLOR_BUFFER_BIT: 0,
    TRIANGLE_STRIP: 0,
    getUniformLocation: () => ({}),
    clearColor: vi.fn(),
    clear: vi.fn(),
    viewport: vi.fn(),
    uniform1f: vi.fn(),
    drawArrays: vi.fn(),
    texImage2D: vi.fn(),
    getExtension: () => null,
  };
}

function fakeCanvas() {
  const listeners = new Map<string, (e: Event) => void>();
  let gl: ReturnType<typeof fakeGl> | null = fakeGl();
  return {
    width: 0,
    height: 0,
    get gl() {
      return gl;
    },
    set gl(v) {
      gl = v;
    },
    getContext: vi.fn(() => gl),
    addEventListener: (type: string, l: (e: Event) => void) => listeners.set(type, l),
    removeEventListener: (type: string) => listeners.delete(type),
    fire: (type: string) => listeners.get(type)?.({ preventDefault: () => undefined } as Event),
  };
}

let canvas: ReturnType<typeof fakeCanvas>;

beforeEach(() => {
  canvas = fakeCanvas();
  vi.stubGlobal("document", { createElement: () => canvas });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GL context restore failure", () => {
  it("AlphaPacker stays lost (draws no-op) and logs instead of throwing", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const packer = new AlphaPacker(4, 2);
    const first = canvas.gl!;
    canvas.fire("webglcontextlost");
    canvas.gl = null; // restore fails: no context
    expect(() => canvas.fire("webglcontextrestored")).not.toThrow();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("AlphaPacker"), expect.any(Error));
    packer.draw({} as TexImageSource, 4, 2);
    packer.redraw();
    expect(first.texImage2D).not.toHaveBeenCalled();
    // A later successful restore resumes drawing.
    canvas.gl = fakeGl();
    canvas.fire("webglcontextrestored");
    packer.draw({} as TexImageSource, 4, 2);
    expect(canvas.gl.texImage2D).toHaveBeenCalledTimes(1);
  });

  it("AlphaUnpacker stays lost and logs instead of throwing", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const unpacker = new AlphaUnpacker(canvas as unknown as HTMLCanvasElement);
    canvas.fire("webglcontextlost");
    canvas.gl = null;
    expect(() => canvas.fire("webglcontextrestored")).not.toThrow();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("AlphaUnpacker"), expect.any(Error));
    expect(unpacker.draw({} as TexImageSource, 4, 2)).toBe(false);
  });
});
