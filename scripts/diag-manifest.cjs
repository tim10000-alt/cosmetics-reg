const { chromium } = require("playwright");
const BASE = "https://tim10000-alt.github.io/cosmetics-reg/";
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto(BASE, { waitUntil: "networkidle" });
  const client = await p.context().newCDPSession(p);
  const m = await client.send("Page.getAppManifest");
  console.log("manifest url:", m.url);
  console.log("errors:", JSON.stringify(m.errors, null, 2));
  // SW 등록/제어 여부
  const sw = await p.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return { hasReg: !!reg, scope: reg && reg.scope, active: !!(reg && reg.active), controller: !!navigator.serviceWorker.controller };
  });
  console.log("SW:", JSON.stringify(sw));
  await b.close();
})();
