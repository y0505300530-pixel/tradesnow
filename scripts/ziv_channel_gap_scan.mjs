#!/usr/bin/env node
/**
 * One-off: diff @cyclestrading channel vs YOUTUBE_CATALOG.md → YOUTUBE_CHANNEL_GAP_SCAN.md
 */
import fs from "fs";
import mysql from "mysql2/promise";

const CATALOG_IDS = new Set([
  "YoO8PLC4xTs", "lx_6phsV_qA", "F8-Hi9wYxSs", "eTVqiCxolTY", "3iqhYB8VNz0", "BxU463WI14M",
  "dyxOZJvr0zk", "VHM3p-mgMIk", "Xeae10txdI8", "zg-vZyQpGnM", "m8e1q4pnXVs", "G89tl2hjJQs",
  "ZeT5NIR8a-g", "paOvSBYcH6M", "FwQgQvb9QlU", "zryV1uyM-jg", "PEe_L73vGMI", "nI37JAmj9Eg", "dxgKTSxk3rY",
]);
const SERIES_REF = "gnqz24XJUoM";

const DB = {
  host: "127.0.0.1",
  user: "tradesnow",
  password: "TsV2026_LocalDb",
  database: "tradesnow",
  charset: "utf8mb4",
};

function decodeTitle(t) {
  return t.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function classify(title) {
  const t = title.toLowerCase();
  const he = title;

  if (/פרשת|פרשה|חוקת|קרח|שלח לך/i.test(he)) return ["P3", "promo — פרשת שבוע"];
  if (/כנס הקהילה|סיפורים אמיתיים.*קהילה|community.*stories|student stories/i.test(he + t))
    return ["P3", "promo — קהילה"];
  if (/ברוך הבא|welcome to.*academy/i.test(he + t)) return ["P3", "promo — הקדמה לאקדמיה"];
  if (/בני 40|יתרון בהשקעות/i.test(he)) return ["P3", "promo — lifestyle"];
  if (/השתלט.*כסף|take control of your money/i.test(he + t)) return ["P3", "promo — כללי"];

  const p0 = [
    /איך להתחיל לסחור|how to learn.*trad|25 years.*trad|top 1%/i,
    /חוקי המסחר|trading rules/i,
    /תמיכה והתנגדות|support.*resistance|זיהוי תמיכה/i,
    /פיבונאצ|fibonacci/i,
    /\brsi\b|מתנד/i,
    /יומן מסחר|trading journal/i,
    /ממוצעים נעים|moving average/i,
    /ראש וכתפיים|head and shoulder/i,
    /אסטרטגיה.*מאות|hundreds of percent|trail|שפל שבועי|weekly.*low/i,
    /לא להיות פראייר|buy.*peak|discount|דיסקאונט/i,
    /מניות מנצחות|winning stocks.*low risk/i,
    /החזקה לרווח|hold.*profit|position management/i,
    /הגדלת רווחים|increase profit/i,
    /מינוף.*מוחק|leverage.*wipe|leverage doesn't/i,
    /tradingview.*2026|tradingview.*guide|גרף שבועי או יומי|weekly.*daily chart/i,
    /שיטה.*רווחית|method.*profitable/i,
    /5 טעויות|common mistakes|lose money even when they know/i,
    /פומו|fomo/i,
    /mental mistake|פחד מרווחים|afraid of profit/i,
    /1929 crash|protect.*crash|הגן על הכסף/i,
    /להיכנס עכשיו או לחכות|enter now or wait/i,
  ];
  for (const re of p0) {
    if (re.test(he + " " + t)) {
      if (/פומו|fomo|טעויות|mistakes|mental|afraid|lose money/i.test(he + t))
        return ["P1", "פסיכולוגיה / משמעת"];
      if (/1929|crash|protect/i.test(he + t)) return ["P0", "מתודולוגיה — הגנה במשבר"];
      if (/tradingview|גרף שבועי/i.test(he + t)) return ["P0", "מתודולוגיה — כלי / TF"];
      if (/rsi|פיבונאצ|ממוצע|ראש וכתפיים/i.test(he + t)) return ["P0", "מתודולוגיה — אינדיקטור/תבנית"];
      if (/יומן/i.test(he + t)) return ["P0", "מתודולוגיה — תהליך (יומן)"];
      if (/חוקי|rules|learn.*trad|25 years/i.test(he + t)) return ["P0", "מתודולוגיה — manifesto"];
      if (/אסטרטגיה|מאות|trail|החזקה|רווחים|פראייר|מנצחות/i.test(he + t))
        return ["P0", "מתודולוגיה — ניהול/כניסה"];
      return ["P0", "מתודולוגיה"];
    }
  }

  if (
    /ניתחתי|analyzed \d+|דירגתי \d+|מניות.*התראות|watchlist|רשימת המעקב|הזדמנויות|stocks.*potential|מדדים|indices|ביטקוין|bitcoin|נפט|gold|oil|ראיון|interview|wall street|וול סטריט/i.test(
      he + " " + t,
    )
  ) {
    return ["P2", "סקירה שבועית / מקרה בוחן"];
  }

  if (/שוק|market|rally|correction|תיקון|ירידות|עליה|breakout|פריצה/i.test(he + " " + t)) {
    return ["P2", "מאקרו / תזמון שוק"];
  }

  return ["P3", "תוכן כללי / promo"];
}

function action(priority, inDb) {
  if (priority === "P0") return inDb ? "נתח + הוסף ל-YOUTUBE_CATALOG" : "סנכרן DB → נתח → קטלוג";
  if (priority === "P1") return inDb ? "נתח → קטלוג (Gap Guard)" : "סנכרן → נתח";
  if (priority === "P2") return inDb ? "סריקה לדוגמאות Engine" : "אופציונלי — סנכרן אם רלוונטי";
  return "דלג / ארכיון";
}

function fmtDate(d) {
  if (!d) return "—";
  const s = d instanceof Date ? d.toISOString() : String(d);
  if (s.startsWith("2020-01-01")) return "—";
  return s.slice(0, 10);
}

function escCell(s) {
  return String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

async function main() {
  const conn = await mysql.createConnection(DB);
  const [dbRows] = await conn.execute(
    "SELECT videoId, title, uploadDate FROM channelVideos WHERE mentor = ?",
    ["cycles_trading"],
  );
  await conn.end();

  const dbMap = Object.fromEntries(dbRows.map((r) => [r.videoId, r]));

  const channelLines = fs.readFileSync("/tmp/ziv_channel_videos.tsv", "utf8").trim().split("\n");
  const channelVideos = channelLines.map((line) => {
    const sep = line.includes("|") ? "|" : line.includes("\t") ? "\t" : "\\t";
    const idx = line.indexOf(sep);
    if (idx < 0) return { id: line.trim(), title: "Untitled" };
    return { id: line.slice(0, idx), title: decodeTitle(line.slice(idx + sep.length).trim()) };
  });

  const channelIds = new Set(channelVideos.map((v) => v.id));
  const catalogNotOnChannel = [...CATALOG_IDS, SERIES_REF].filter((id) => !channelIds.has(id));

  const missing = [];
  let catalogedOnChannel = 0;
  for (const v of channelVideos) {
    if (CATALOG_IDS.has(v.id)) {
      catalogedOnChannel++;
      continue;
    }
    const [priority, reason] = classify(v.title);
    const inDb = !!dbMap[v.id];
    missing.push({
      id: v.id,
      title: v.title,
      uploadDate: fmtDate(dbMap[v.id]?.uploadDate),
      priority,
      reason,
      inDb,
      action: action(priority, inDb),
    });
  }

  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  missing.forEach((m) => counts[m.priority]++);

  const priorityOrder = { P0: 0, P1: 1, P2: 2, P3: 3 };
  missing.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority] || a.title.localeCompare(b.title));

  const mustWatchIds = [
    "gnqz24XJUoM",
    "lx_6phsV_qA",
    "F8-Hi9wYxSs",
    "nI37JAmj9Eg",
    "zryV1uyM-jg",
    "PEe_L73vGMI",
    "dxgKTSxk3rY",
    "cJdSgZUz7uQ",
    "MH-RcExGAAc",
    "wm47UxvWH6Q",
    "ALSCCXioT1M",
    "YRnIccRr78Q",
    "7Wc9Wrs493o",
    "q3Hu3BWVOQM",
    "fR8MkqWSFWk",
    "YL0Xr2eFkDM",
    "to4w2LGO1Vo",
  ];

  const top10 = [];
  const seen = new Set();
  for (const id of mustWatchIds) {
    if (top10.length >= 10) break;
    const cv = channelVideos.find((v) => v.id === id);
    if (!cv || CATALOG_IDS.has(id)) continue;
    const [priority] = classify(cv.title);
    const why =
      id === "gnqz24XJUoM"
        ? "סדרת מאות אחוזים — חלק 0 (מוזכר בקטלוג, לא ברשימת 19)"
        : ["lx_6phsV_qA", "F8-Hi9wYxSs", "nI37JAmj9Eg", "zryV1uyM-jg", "PEe_L73vGMI", "dxgKTSxk3rY"].includes(id)
          ? "ברשימת 19 אך חסר מ-YOUTUBE_CATALOG sync / לא בערוץ כרגע"
          : missing.find((m) => m.id === id)?.reason ?? "מתודולוגיה ליבה";
    top10.push({ id, title: cv.title, priority, why });
    seen.add(id);
  }
  for (const m of missing) {
    if (top10.length >= 10) break;
    if (seen.has(m.id) || m.priority === "P3") continue;
    top10.push({ id: m.id, title: m.title, priority: m.priority, why: m.reason });
    seen.add(m.id);
  }

  const inDbNotCatalog = dbRows
    .filter((r) => !CATALOG_IDS.has(r.videoId))
    .map((r) => r.videoId);

  const lines = [];
  lines.push("# סריקת פערים — ערוץ Cycles Trading (@cyclestrading)");
  lines.push("");
  lines.push("**ערוץ:** [UChaPkfdV0OxX3bdX_D9qaOA](https://www.youtube.com/channel/UChaPkfdV0OxX3bdX_D9qaOA/videos)");
  lines.push("**מנטור DB:** `cycles_trading`");
  lines.push(`**נוצר:** ${new Date().toISOString().slice(0, 10)}`);
  lines.push("**מקורות:** `YOUTUBE_CATALOG.md` (19 סרטונים) · `yt-dlp --flat-playlist` · MySQL `channelVideos`");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## סיכום");
  lines.push("");
  lines.push("| מדד | ערך |");
  lines.push("|-----|-----|");
  lines.push(`| סה״כ סרטונים בערוץ (yt-dlp) | **${channelVideos.length}** |`);
  lines.push(`| כבר בקטלוג (YOUTUBE_CATALOG) | **${CATALOG_IDS.size}** |`);
  lines.push(`| מוזכר בקטלוג כסדרה (לא ב-19) | **1** (\`gnqz24XJUoM\`) |`);
  lines.push(`| קטלוג שמופיע בערוץ | **${catalogedOnChannel}** / 19 |`);
  lines.push(`| **חסרים מקטלוג** (בערוץ, לא ב-19) | **${missing.length}** |`);
  lines.push(`| שורות ב-DB (\`cycles_trading\`) | **${dbRows.length}** |`);
  lines.push(`| ב-DB אך לא בקטלוג | **${inDbNotCatalog.length}** |`);
  lines.push("");
  lines.push("### פילוח עדיפות — סרטונים חסרים");
  lines.push("");
  lines.push("| עדיפות | כמות | משמעות |");
  lines.push("|--------|------|--------|");
  lines.push(`| **P0** מתודולוגיה | ${counts.P0} | כללים ל-Ziv Engine |`);
  lines.push(`| **P1** פסיכולוגיה | ${counts.P1} | Gap Guard / משמעת |`);
  lines.push(`| **P2** מקרה בוחן | ${counts.P2} | סריקות שבועיות, דוגמאות |`);
  lines.push(`| **P3** promo | ${counts.P3} | קהילה, פרשות, lifestyle |`);
  lines.push("");

  if (catalogNotOnChannel.length) {
    lines.push("### סרטוני קטלוג שלא נמצאו בערוץ (private/מחוק?)");
    lines.push("");
    for (const id of catalogNotOnChannel) {
      lines.push(`- [\`${id}\`](https://www.youtube.com/watch?v=${id})`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("## Top 10 — חובה לבסיס הידע (מתודולוגיה Ziv)");
  lines.push("");
  lines.push("| # | videoId | כותרת | עדיפות | למה |");
  lines.push("|---|---------|--------|--------|-----|");
  top10.forEach((item, i) => {
    lines.push(
      `| ${i + 1} | [\`${item.id}\`](https://www.youtube.com/watch?v=${item.id}) | ${escCell(item.title)} | ${item.priority} | ${escCell(item.why)} |`,
    );
  });
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("## DB — `channelVideos` (cycles_trading)");
  lines.push("");
  lines.push("| videoId | כותרת DB | uploadDate | בקטלוג? |");
  lines.push("|---------|----------|------------|---------|");
  for (const r of dbRows.sort((a, b) => String(b.uploadDate).localeCompare(String(a.uploadDate)))) {
    const inCat = CATALOG_IDS.has(r.videoId) ? "✅" : "❌";
    lines.push(
      `| \`${r.videoId}\` | ${escCell(decodeTitle(r.title ?? ""))} | ${fmtDate(r.uploadDate)} | ${inCat} |`,
    );
  }
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push(`## טבלת סרטונים חסרים (${missing.length} שורות)`);
  lines.push("");
  lines.push("ממוין: P0 → P1 → P2 → P3. תאריך מ-DB כשקיים; אחרת —.");
  lines.push("");
  lines.push("| videoId | כותרת | תאריך | עדיפות | ב-DB? | פעולה מומלצת |");
  lines.push("|---------|--------|--------|--------|-------|--------------|");
  for (const m of missing) {
    lines.push(
      `| [\`${m.id}\`](https://www.youtube.com/watch?v=${m.id}) | ${escCell(m.title)} | ${m.uploadDate} | ${m.priority} | ${m.inDb ? "כן" : "לא"} | ${escCell(m.action)} |`,
    );
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("*נוצר ע״י `scripts/ziv_channel_gap_scan.mjs` — לא משנה קוד Engine.*");

  const outPath = "/root/tradesnow/docs/ziv-engine-spec/YOUTUBE_CHANNEL_GAP_SCAN.md";
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");

  console.log(
    JSON.stringify({
      outPath,
      totalChannel: channelVideos.length,
      missing: missing.length,
      counts,
      top5: top10.slice(0, 5),
      catalogNotOnChannel,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
