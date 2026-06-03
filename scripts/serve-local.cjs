// cosmetics-reg 로컬 서버 — out/ 정적 서빙 + "브라우저 닫으면 자동 종료".
// (기존 `serve` 패키지는 브라우저 생존을 모름 → 창을 수동 종료해야 했음.)
//
// 동작:
//  - 모든 .html 응답에 heartbeat 스크립트 주입. 브라우저가 3초마다 /__alive ping.
//  - 마지막 ping 후 IDLE_MS(75초) 동안 신호 없으면 = 모든 탭 닫힘 → 서버 종료.
//    (탭 여러 개여도 하나라도 열려있으면 ping 유지. 백그라운드 탭은 브라우저가
//     타이머를 ~1분으로 throttle 하므로 IDLE_MS 를 그보다 길게 둠.)
//  - launch.cjs 가 이 프로세스를 spawn → 종료되면 launch 도 종료 → 숨은 창도 닫힘.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3010);
const ROOT = path.join(__dirname, "..", "out");
const IDLE_MS = Number(process.env.IDLE_MS || 75_000);

let lastBeat = Date.now();

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".ico": "image/x-icon", ".webp": "image/webp",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".map": "application/json",
};

const INJECT = `<script>(function(){
  function beat(){ fetch('/__alive',{cache:'no-store'}).catch(function(){}); }
  beat(); setInterval(beat, 3000);
  document.addEventListener('visibilitychange', function(){ if(!document.hidden) beat(); });
})();</script>`;

function safeJoin(root, urlPath) {
  const p = path.normalize(path.join(root, urlPath));
  return p.startsWith(root) ? p : null; // path traversal 차단
}

function sendFile(res, file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html") {
    let html = fs.readFileSync(file, "utf8");
    html = html.includes("</body>") ? html.replace("</body>", INJECT + "</body>") : html + INJECT;
    res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
    return res.end(html);
  }
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/__alive") { lastBeat = Date.now(); res.writeHead(200); return res.end("ok"); }

  let rel = urlPath;
  if (rel.endsWith("/")) rel += "index.html";
  let file = safeJoin(ROOT, rel);
  if (!file) { res.writeHead(403); return res.end("forbidden"); }

  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (fs.existsSync(file + ".html")) file = file + ".html";                 // /sources → sources.html
    else if (fs.existsSync(path.join(file, "index.html"))) file = path.join(file, "index.html"); // /sources/ → sources/index.html
    else { const nf = path.join(ROOT, "404.html"); if (fs.existsSync(nf)) { res.writeHead(404, { "Content-Type": MIME[".html"] }); return res.end(fs.readFileSync(nf)); } res.writeHead(404); return res.end("not found"); }
  }
  sendFile(res, file);
});

server.listen(PORT, () => console.log(`cosmetics-reg http://localhost:${PORT} (브라우저 모두 닫으면 ~${IDLE_MS / 1000}초 후 자동 종료)`));

setInterval(() => {
  if (Date.now() - lastBeat > IDLE_MS) { console.log("브라우저 닫힘 감지 — 서버 자동 종료"); process.exit(0); }
}, 5000);
