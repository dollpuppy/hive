import { AlphaPacker } from "../../../src/web/alpha/alpha-packer";
import { AlphaUnpacker } from "../../../src/web/alpha/alpha-unpacker";

const W = 320;
const H = 180;
type Px = [number, number, number, number];

const pattern = document.createElement("canvas");
pattern.width = W;
pattern.height = H;
const p = pattern.getContext("2d")!;
p.clearRect(0, 0, W, H);
p.fillStyle = "rgba(255,0,0,1)";
p.fillRect(0, 0, W / 2, H / 2);
p.fillStyle = "rgba(0,255,0,0.5)";
p.fillRect(W / 2, 0, W / 2, H / 2);
p.fillStyle = "rgba(0,0,255,1)";
p.fillRect(0, H / 2, W / 2, H / 2);

const packer = new AlphaPacker(W, H);
setInterval(() => packer.draw(pattern, W, H), 33);
packer.draw(pattern, W, H);

const out = document.getElementById("out") as HTMLCanvasElement;
const unpacker = new AlphaUnpacker(out);

function sample(): Record<string, Px> {
  const gl = out.getContext("webgl")!;
  const read = (x: number, yTop: number): Px => {
    const buf = new Uint8Array(4);
    gl.readPixels(x, H - 1 - yTop, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return [buf[0]!, buf[1]!, buf[2]!, buf[3]!];
  };
  return { tl: read(W / 4, H / 4), tr: read((3 * W) / 4, H / 4), bl: read(W / 4, (3 * H) / 4), br: read((3 * W) / 4, (3 * H) / 4) };
}

async function direct(): Promise<Record<string, Px>> {
  unpacker.draw(packer.canvas, W * 2, H);
  return sample();
}

async function throughWebRtc(): Promise<Record<string, Px>> {
  const stream = packer.canvas.captureStream(30);
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && void b.addIceCandidate(e.candidate);
  b.onicecandidate = (e) => e.candidate && void a.addIceCandidate(e.candidate);
  a.addTransceiver(stream.getVideoTracks()[0]!, { direction: "sendonly", sendEncodings: [{ maxBitrate: 4_000_000 }] });
  const video = document.getElementById("v") as HTMLVideoElement;
  b.ontrack = (e) => {
    video.srcObject = new MediaStream([e.track]);
  };
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription!);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription!);
  await new Promise<void>((resolve) => {
    const check = (): void => (video.videoWidth === W * 2 && video.currentTime > 1 ? resolve() : void setTimeout(check, 50));
    check();
  });
  unpacker.draw(video, video.videoWidth, video.videoHeight);
  return sample();
}

(window as unknown as { alphaTest: unknown }).alphaTest = { direct, throughWebRtc };
