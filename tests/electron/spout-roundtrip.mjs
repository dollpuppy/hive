// Run: npm run test:spout  (Windows only). Exits 0 on PASS, 1 on FAIL.
import { app } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SenderDiscovery,
  createTextureBridge,
  createTextureReceiver,
} from "@napolab/texture-bridge-renderer";

const here = dirname(fileURLToPath(import.meta.url));
const NAME = "Hive-Roundtrip-Test";
const SIZE = 256;

app.whenReady().then(async () => {
  let bridge;
  let receiver;
  let bridgeDisposed = false;
  let receiverDisposed = false;

  function disposeAll() {
    if (receiver && !receiverDisposed) {
      receiverDisposed = true;
      receiver.dispose();
    }
    if (bridge && !bridgeDisposed) {
      bridgeDisposed = true;
      bridge.dispose();
    }
  }

  function finish(code, message) {
    console[code === 0 ? "log" : "error"](message);
    disposeAll();
    app.exit(code);
  }

  const timeout = setTimeout(() => finish(1, "FAIL: timed out after 20s"), 20_000);

  try {
    bridge = await createTextureBridge({
      name: NAME,
      width: SIZE,
      height: SIZE,
      frameRate: 30,
      rendererUrl: join(here, "fixtures/alpha-pattern.html"),
      includeAlpha: true,
      pixelExact: true,
    });
  } catch (err) {
    finish(1, `FAIL: createTextureBridge rejected: ${err.message}`);
    return;
  }
  bridge.on("error", (err) => finish(1, `FAIL: bridge error: ${err.message}`));

  const discovery = new SenderDiscovery();
  await new Promise((resolve) => {
    discovery.on("updated", (senders) => {
      if (senders.some((s) => s.name === NAME)) resolve();
    });
    discovery.start(250);
  });
  discovery.dispose();

  try {
    receiver = createTextureReceiver({ senderName: NAME });
  } catch (err) {
    finish(1, `FAIL: createTextureReceiver threw: ${err.message}`);
    return;
  }
  receiver.on("error", (err) => finish(1, `FAIL: receiver error: ${err.message}`));
  receiver.on("frame", (frame) => {
    // NOTE: despite the `ReceivedFrame` typing's "RGBA pixel data" comment,
    // the native receiver on Windows/Spout actually emits BGRA byte order
    // (confirmed empirically: a drawn rgb(255,0,0) pixel arrives as
    // [0, 0, 255, 255], i.e. B=0 G=0 R=255 A=255). Index accordingly.
    const px = (x, y) => {
      const i = (y * frame.width + x) * 4;
      const [b, g, r, a] = frame.data.subarray(i, i + 4);
      return { r, g, b, a };
    };
    const left = px(Math.floor(frame.width * 0.25), Math.floor(frame.height * 0.5));
    const right = px(Math.floor(frame.width * 0.75), Math.floor(frame.height * 0.5));
    console.log(`frame ${frame.width}x${frame.height} left=${JSON.stringify(left)} right=${JSON.stringify(right)}`);
    if (left.r < 200 || left.a < 200) return; // not painted yet
    clearTimeout(timeout);
    if (right.a > 30) finish(1, `FAIL: alpha lost on receive (right-half alpha=${right.a})`);
    else finish(0, "PASS: alpha survives Spout send -> receive");
  });
  receiver.start();
});
