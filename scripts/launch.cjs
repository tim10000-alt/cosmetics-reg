// 100% 로컬 런처 — node scripts/launch.cjs (또는 npm start, start.bat 더블클릭).
// 자동: 의존성 설치 → 데이터 다운로드 → 빌드 → 정적 서버 → 브라우저.
// tsx 의존 없이 vanilla Node — 첫 실행에도 작동.

const { existsSync, mkdirSync } = require("node:fs");
const { writeFile } = require("node:fs/promises");
const { spawn, spawnSync } = require("node:child_process");
const { platform } = require("node:os");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");

const PORT = 3010;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "public", "data");
// 19국 split — countries.json 받은 다음 cc 별 regulations/{cc}.json 받음.
const TOPLEVEL_DATA_FILES = ["meta.json", "countries.json", "ingredients.json", "quarantine.json", "kcia-articles.json", "sources-pdf.json"];
const DATA_BASE_URL = "https://raw.githubusercontent.com/tim10000-alt/cosmetics-reg/main/public/data";
process.chdir(ROOT);

const isWin = platform() === "win32";

// Windows 에선 npm/npx 가 .cmd 래퍼. Node 22+ 의 BatBadBut 패치로 .cmd 직접 spawn 은
// EINVAL. shell:true + args 배열 조합은 DEP0190 warning. cmd.exe /c 로 감싸는 방식은
// shell:false 유지 + EINVAL 회피 + 경고 0. (serve 는 이제 node serve-local.cjs 직접 spawn.)
function spawnSyncCmd(executable, args, opts) {
  if (isWin) return spawnSync("cmd.exe", ["/c", executable, ...args], { ...opts, shell: false });
  return spawnSync(executable, args, { ...opts, shell: false });
}

function run(cmd, args) {
  const r = spawnSyncCmd(cmd, args, { stdio: "inherit" });
  return r.status ?? 1;
}

function ensureInstalled() {
  if (existsSync("node_modules")) return;
  console.log("");
  console.log("==================================================");
  console.log(" 첫 실행: 의존성 설치 (1-2분, 인터넷 필요)");
  console.log("==================================================");
  console.log("");
  if (run("npm", ["install"]) !== 0) {
    console.error("");
    console.error("[X] npm install 실패.");
    console.error("    - 인터넷 연결 확인");
    console.error("    - Windows 면 antivirus 가 npm 차단 안 하는지 확인");
    process.exit(1);
  }
}

// 자동 git pull — GitHub Actions 가 매일 갱신한 1차 소스 데이터를 사용자 PC 로 가져옴.
// .git 없으면 (zip 다운로드 등) skip. --no-pull 플래그 또는 OFFLINE=1 환경변수로 끄기.
function autoUpdate() {
  if (!existsSync(".git")) return;
  if (process.argv.includes("--no-pull") || process.env.OFFLINE === "1") return;
  process.stdout.write("최신 데이터 확인... ");
  const r = spawnSyncCmd("git", ["pull", "--ff-only", "--quiet"], { stdio: "pipe" });
  if (r.status === 0) {
    process.stdout.write("✓\n");
    // out/ 도 stale — 데이터 변경 시 재빌드 필요
    if (existsSync(path.join("out", "data", "meta.json"))) {
      const fs = require("node:fs");
      try {
        const srcMeta = JSON.parse(fs.readFileSync(path.join("public", "data", "meta.json"), "utf8"));
        const outMeta = JSON.parse(fs.readFileSync(path.join("out", "data", "meta.json"), "utf8"));
        if (srcMeta.generated_at !== outMeta.generated_at) {
          console.log("데이터 갱신 — 재빌드 필요");
          fs.rmSync(path.join("out"), { recursive: true, force: true });
        }
      } catch {}
    }
  } else {
    process.stdout.write("(skip — offline 또는 conflict)\n");
  }
}

function ensureBuilt() {
  if (existsSync(path.join("out", "index.html"))) return;
  console.log("정적 사이트 빌드 중 (~30초)...");
  if (run("npm", ["run", "build"]) !== 0) {
    console.error("[X] 빌드 실패.");
    process.exit(1);
  }
}

function downloadFile(url, dest, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("too many redirects"));
    https
      .get(url, { headers: { "User-Agent": "cosmetics-reg-launcher" } }, (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          return downloadFile(res.headers.location, dest, redirectCount + 1).then(resolve).catch(reject);
        }
        if (code !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${code}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => writeFile(dest, Buffer.concat(chunks)).then(resolve).catch(reject));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function ensureData() {
  if (existsSync(path.join(DATA_DIR, "meta.json"))) return;
  console.log("데이터 다운로드 중 (~70MB, 1-2분)...");
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(path.join(DATA_DIR, "regulations"), { recursive: true });

  // 1) top-level files (meta + countries + ingredients + quarantine 등)
  for (const f of TOPLEVEL_DATA_FILES) {
    try {
      await downloadFile(`${DATA_BASE_URL}/${f}`, path.join(DATA_DIR, f));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 옵션 파일 (kcia/sources-pdf) 은 fail 허용
      if (f === "kcia-articles.json" || f === "sources-pdf.json") {
        console.warn(`  - ${f} skip (${msg})`);
        continue;
      }
      console.error(`데이터 다운로드 실패 (${f}): ${msg}`);
      process.exit(1);
    }
  }

  // 2) regulations/{cc}.json — countries.json 의 code 목록 기반.
  try {
    const fs = require("node:fs");
    const countries = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "countries.json"), "utf8")).rows;
    let downloaded = 0;
    for (const c of countries) {
      const file = `regulations/${c.code}.json`;
      try {
        await downloadFile(`${DATA_BASE_URL}/${file}`, path.join(DATA_DIR, file));
        downloaded++;
      } catch (e) {
        console.warn(`  - ${file} skip (${e instanceof Error ? e.message : e})`);
      }
    }
    console.log(`  ✓ regulations: ${downloaded}/${countries.length} 국가`);
  } catch (e) {
    console.error(`regulations 다운로드 실패: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

function openBrowser(url) {
  if (isWin) {
    spawn("cmd.exe", ["/c", "start", "", url], { stdio: "ignore", shell: false, detached: true }).unref();
  } else {
    const cmd = platform() === "darwin" ? "open" : "xdg-open";
    spawn(cmd, [url], { stdio: "ignore", shell: false, detached: true }).unref();
  }
}

function waitReady() {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tick = () => {
      attempts++;
      const req = http.get(BASE, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (attempts >= 60) reject(new Error("server timeout"));
        else setTimeout(tick, 500);
      });
    };
    tick();
  });
}

async function main() {
  ensureInstalled();
  autoUpdate();
  await ensureData();
  ensureBuilt();

  // 로컬 서버 = scripts/serve-local.cjs — out/ 정적 서빙 + "브라우저 모두 닫으면
  // 자동 종료"(heartbeat). serve 패키지 의존 X, node 직접 실행. 이 프로세스가 종료되면
  // 아래 server.on("exit") → launch 종료 → (숨은) 창도 닫힘.
  const server = spawn(process.execPath, [path.join("scripts", "serve-local.cjs")], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, PORT: String(PORT) },
  });

  let shuttingDown = false;
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { server.kill(); } catch {}
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  server.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`server stopped (exit ${code})`);
      process.exit(code ?? 1);
    }
  });

  try {
    await waitReady();
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : e}`);
    shutdown(1);
    return;
  }

  console.log(`${BASE}  (Ctrl+C 종료)`);
  openBrowser(BASE);

  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
