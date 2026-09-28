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

const packer = new AlphaPacker(W, H, { preserveDrawingBuffer: true });
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
  const track = stream.getVideoTracks()[0]!;
  track.contentHint = "detail";
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  try {
    a.onicecandidate = (e) => e.candidate && void b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && void a.addIceCandidate(e.candidate);
    const transceiver = a.addTransceiver(track, { direction: "sendonly", sendEncodings: [{ maxBitrate: 4_000_000 }] });
    try {
      const sender = transceiver.sender;
      const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
      params.degradationPreference = "maintain-resolution";
      await sender.setParameters(params);
    } catch {
      // degradationPreference unsupported; not fatal for the test.
    }
    const video = document.getElementById("v") as HTMLVideoElement;
    b.ontrack = (e) => {
      video.srcObject = new MediaStream([e.track]);
    };
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription!);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription!);
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 15_000;
      const check = (): void => {
        if (video.videoWidth === W * 2 && video.currentTime > 1) {
          resolve();
        } else if (Date.now() > deadline) {
          reject(new Error(`throughWebRtc: timed out waiting for frame (videoWidth=${video.videoWidth}, currentTime=${video.currentTime})`));
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
    unpacker.draw(video, video.videoWidth, video.videoHeight);
    return sample();
  } finally {
    a.close();
    b.close();
    stream.getTracks().forEach((t) => t.stop());
  }
}

const PILLARBOX_SIZE = 180;

function pillarbox(): Record<string, Px> {
  const square = document.createElement("canvas");
  square.width = PILLARBOX_SIZE;
  square.height = PILLARBOX_SIZE;
  const sctx = square.getContext("2d")!;
  sctx.fillStyle = "rgba(255,0,0,1)";
  sctx.fillRect(0, 0, PILLARBOX_SIZE, PILLARBOX_SIZE);

  const pbPacker = new AlphaPacker(W, H, { preserveDrawingBuffer: true });
  pbPacker.draw(square, PILLARBOX_SIZE, PILLARBOX_SIZE);

  const pbCanvas = document.createElement("canvas");
  const pbUnpacker = new AlphaUnpacker(pbCanvas);
  pbUnpacker.draw(pbPacker.canvas, W * 2, H);

  const gl = pbCanvas.getContext("webgl")!;
  const read = (x: number, yTop: number): Px => {
    const buf = new Uint8Array(4);
    gl.readPixels(x, H - 1 - yTop, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return [buf[0]!, buf[1]!, buf[2]!, buf[3]!];
  };
  const result = { centre: read(W / 2, H / 2), left: read(20, H / 2), right: read(300, H / 2) };

  pbPacker.dispose();
  pbUnpacker.dispose();
  return result;
}

(window as unknown as { alphaTest: unknown }).alphaTest = { direct, throughWebRtc, pillarbox };
