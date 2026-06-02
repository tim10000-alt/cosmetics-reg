const fs = require("node:fs");

// 충돌 패턴: <<<<<<< Updated upstream\n<remote>\n=======\n<stashed>\n>>>>>>> Stashed changes
// "Stashed changes" 부분 keep — 우리 cn-iecic-kcia 출력 (latest).

function fixFile(filepath) {
  const content = fs.readFileSync(filepath, "utf8");
  if (!content.includes("<<<<<<<")) return false;
  const re = /<<<<<<< Updated upstream\r?\n[\s\S]*?\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> Stashed changes\r?\n?/g;
  const fixed = content.replace(re, (_, stashed) => stashed);
  try {
    JSON.parse(fixed);
  } catch (e) {
    console.error(`  X ${filepath}: still invalid — ${e.message.slice(0, 100)}`);
    fs.writeFileSync(filepath + ".broken", fixed);
    return false;
  }
  fs.writeFileSync(filepath, fixed);
  console.log(`  OK ${filepath}`);
  return true;
}

const targets = [
  "public/data/ingredients.json",
  "public/data/meta.json",
  ...fs.readdirSync("public/data/regulations").filter((f) => f.endsWith(".json")).map((f) => "public/data/regulations/" + f),
];
let fixed = 0;
for (const t of targets) {
  if (fixFile(t)) fixed++;
}
console.log(`\nfixed ${fixed}/${targets.length} files`);
