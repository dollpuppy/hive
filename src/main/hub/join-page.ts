import type { HttpRoute } from "./local-server";

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join on Hive</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f1113; color: #e7e9ec; font: 15px system-ui, sans-serif; }
  main { width: min(460px, calc(100vw - 32px)); background: #171a1d; border: 1px solid #2a2f35; border-radius: 12px; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { color: #8a939d; line-height: 1.5; }
  a.button { display: inline-block; background: #a855f7; color: #fff; font-weight: 600; text-decoration: none; padding: 10px 16px; border-radius: 8px; }
  input { width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 6px; border: 1px solid #2a2f35; background: #0f1113; color: #e7e9ec; font: inherit; }
</style>
</head>
<body>
<main>
  <h1>Join a Hive co-stream</h1>
  <p>Hive should open automatically. If it doesn't, click the button.</p>
  <p><a class="button" id="open" href="#">Open in Hive</a></p>
  <p>Or copy this link and paste it into Hive's join box:</p>
  <input id="link" readonly>
</main>
<script>
  var link = location.href;
  var deep = "hive://join?link=" + encodeURIComponent(link);
  document.getElementById("open").href = deep;
  var input = document.getElementById("link");
  input.value = link;
  input.addEventListener("focus", function () { input.select(); });
  location.href = deep;
</script>
</body>
</html>`;

/** GET /join — the only HTTP page reachable through the tunnel. */
export function joinRoute(): HttpRoute {
  return (req, res, ctx) => {
    if (req.method !== "GET" || ctx.path !== "/join") return false;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      "x-frame-options": "DENY",
    });
    res.end(PAGE);
    return true;
  };
}
