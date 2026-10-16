/* 定时任务：把 ntfy 上的成绩消息合并进 data/scores.json（永久保存）
   由 .github/workflows/collect.yml 每 10 分钟跑一次。
   ntfy 公共主题只保留 12 小时，所以必须在消息过期前收下来；收下来之后就永久留在仓库里。 */
const fs = require("fs");
const TOPIC = "suika-renda-board-4b8e2d17c5";
const SRC = "https://ntfy.sh/" + TOPIC + "/json?poll=1&since=12h";
const FILE = "data/scores.json";
const MAX_RECENT = 300;
const MAX_SEEN = 8000;

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (raw && typeof raw === "object") {
      raw.players = raw.players && typeof raw.players === "object" ? raw.players : {};
      raw.seen = Array.isArray(raw.seen) ? raw.seen : [];
      raw.recent = Array.isArray(raw.recent) ? raw.recent : [];
      return raw;
    }
  } catch (e) {
    /* 文件不存在或损坏：从空库开始 */
  }
  return { updated: 0, seen: [], players: {}, recent: [] };
}

function num(v, lo, hi) {
  v = Number(v);
  if (!isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

async function main() {
  const db = load();
  const seen = new Set(db.seen);
  const res = await fetch(SRC, { headers: { cache: "no-store" } });
  if (!res.ok) throw new Error("ntfy HTTP " + res.status);
  const text = await res.text();

  let added = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let env;
    try { env = JSON.parse(line); } catch (e) { continue; }
    if (!env || typeof env.id !== "string" || !env.id || seen.has(env.id)) continue;
    seen.add(env.id);
    let p = null;
    try { p = JSON.parse(env.message || "null"); } catch (e) { continue; }
    if (!p || typeof p.n !== "string" || !p.n) continue;
    const name = p.n.slice(0, 12);
    const rec = db.players[name] || (db.players[name] = { best: 0, earned: 0, plays: 0, spent: 0, last: 0 });
    const when = num(p.t, 0, 9e15) || (env.time ? env.time * 1000 : 0);
    if (when > rec.last) rec.last = when;
    if (typeof p.s === "number" && p.s > 0 && !p.spend) {
      const s = num(p.s, 0, 1e9);
      /* d = 这一局新增的分（用复活币续命时 s 会重复上报，累计只加 d） */
      const add = typeof p.d === "number" && p.d >= 0 ? num(p.d, 0, 1e9) : s;
      rec.earned += add;
      if (add > 0) rec.plays += 1;
      if (s > rec.best) rec.best = s;
      db.recent.unshift({ n: name, s: s, d: add, t: when });
    }
    if (typeof p.spend === "number" && p.spend > 0) {
      rec.spent += num(p.spend, 0, 1e9);
      rec.plays += 1;
    }
    added++;
  }

  db.recent = db.recent.slice(0, MAX_RECENT);
  db.seen = Array.from(seen).slice(-MAX_SEEN);
  /* 只有真的收进了新消息才更新时间戳：否则内容不变、不会产生提交，
     免得每 10 分钟白刷一次仓库（一天 144 次提交）。 */
  if (added > 0) db.updated = Date.now();
  // 榜单只保留有成绩的人，且按累计分排序输出，方便前端直接读
  const mine = Object.keys(db.players).filter(function (k) {
    const r = db.players[k];
    return r.earned > 0 || r.spent > 0 || r.best > 0;
  });
  db.rank = mine
    .map(function (k) {
      const r = db.players[k];
      return { n: k, best: r.best, earned: r.earned, spent: r.spent, plays: r.plays, last: r.last };
    })
    .sort(function (a, b) { return b.best - a.best || b.earned - a.earned; })
    .slice(0, 200);

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db));
  fs.writeFileSync("data/count.json", JSON.stringify({ players: mine.length, updated: db.updated }));
  console.log("merged=" + added + " players=" + mine.length + " recent=" + db.recent.length);
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
