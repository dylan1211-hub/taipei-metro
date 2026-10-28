#!/usr/bin/env node
// 從 TDX 抓台北捷運（TRTC）與環狀線（NTMC）的靜態資料，轉成網頁用的 metro-data.js
//
// 用法：
//   1. 在同一個資料夾建立 .env，內容：
//        TDX_CLIENT_ID=你的 Client ID
//        TDX_CLIENT_SECRET=你的 Client Secret
//   2. node fetch-tdx.mjs           一般執行（資料沒變動就沿用舊檔）
//      node fetch-tdx.mjs --force   不管有沒有變動都重抓
//      node fetch-tdx.mjs --offline 不連線，只用 tdx-raw/ 裡已存的資料重新轉檔
//
// 需要 Node.js 18 以上（內建 fetch）。

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.join(DIR, "tdx-raw");
const OUT = path.join(DIR, "metro-data.js");
const USAGE = path.join(DIR, "tdx-usage.json");
const MONTHLY_BUDGET = Number(process.env.TDX_MONTHLY_BUDGET || 500); // 自訂的每月上限，避免把 3,000 次額度用光
const FORCE = process.argv.includes("--force");
const OFFLINE = process.argv.includes("--offline");

const BASE = "https://tdx.transportdata.tw/api/basic/v2/Rail/Metro";
const TOKEN_URL = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const OPERATORS = ["TRTC", "NTMC"]; // 台北捷運、新北捷運（環狀線）
const TYPES = ["Station", "StationOfLine", "S2STravelTime", "Frequency", "FirstLastTimetable", "LineTransfer", "StationExit", "Shape"];

// ---------- 小工具 ----------
async function loadEnv() {
  try {
    const txt = await fs.readFile(path.join(DIR, ".env"), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* 沒有 .env 就用系統環境變數 */ }
}
const readJSON = async (f, d) => { try { return JSON.parse(await fs.readFile(f, "utf8")); } catch { return d; } };
const norm = s => String(s || "").replace(/臺/g, "台").trim();
const zh = o => norm(o && (o.Zh_tw ?? o.Zh_TW ?? o.zh_tw ?? o));
const r1 = x => Math.round(x * 10) / 10;
const toMin = t => { if (!t) return null; const [h, m] = String(t).split(":").map(Number); let v = h * 60 + m; if (v < 240) v += 1440; return v; };
// 車站代碼 → 網頁用的路線代號（支線單獨一條）
function lineOf(stationId) {
  const id = String(stationId || "");
  if (id === "R22A") return "RB";
  if (id === "G03A") return "GB";
  const m = id.match(/^[A-Z]+/); return m ? m[0] : null;
}
const PAGE_LINES = new Set(["BR", "R", "RB", "G", "GB", "O", "BL", "Y"]);
const BRANCH_END = { G03: "G03A", G03A: "G03", R22: "R22A", R22A: "R22" }; // 支線兩端

// ---------- 呼叫次數紀錄 ----------
async function useCall(n = 1) {
  const month = new Date().toISOString().slice(0, 7);
  const u = await readJSON(USAGE, {});
  if (u.month !== month) { u.month = month; u.calls = 0; }
  if (u.calls + n > MONTHLY_BUDGET && !FORCE) {
    throw new Error(`本月已呼叫 ${u.calls} 次，超過自訂上限 ${MONTHLY_BUDGET}。要繼續請加 --force，或在 .env 設 TDX_MONTHLY_BUDGET。`);
  }
  u.calls += n; await fs.writeFile(USAGE, JSON.stringify(u, null, 2));
  return u.calls;
}

// ---------- 抓資料 ----------
async function getToken() {
  const id = process.env.TDX_CLIENT_ID, secret = process.env.TDX_CLIENT_SECRET;
  if (!id || !secret) throw new Error("找不到 TDX_CLIENT_ID 或 TDX_CLIENT_SECRET，請先建立 .env 檔。");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret })
  });
  if (!res.ok) throw new Error(`取得 token 失敗（HTTP ${res.status}）：請確認 Client ID / Secret 是否正確。\n${await res.text()}`);
  return (await res.json()).access_token;
}

async function fetchAll() {
  await fs.mkdir(RAW, { recursive: true });
  const meta = await readJSON(path.join(RAW, "_meta.json"), {});
  const token = await getToken();
  let changed = 0;
  for (const op of OPERATORS) for (const type of TYPES) {
    const key = `${type}_${op}`, file = path.join(RAW, key + ".json");
    const url = `${BASE}/${type}/${op}?%24format=JSON`;
    const headers = { authorization: `Bearer ${token}`, "accept-encoding": "br,gzip" };
    if (!FORCE && meta[key]?.lastModified) headers["if-modified-since"] = meta[key].lastModified;
    let n, res;
    for (let attempt = 0; ; attempt++) {
      n = await useCall();
      res = await fetch(url, { headers });
      if (res.status !== 429) break;
      if (attempt >= 3) {
        await fs.writeFile(path.join(RAW, "_meta.json"), JSON.stringify(meta, null, 2));
        throw new Error("TDX 回應 429：呼叫太頻繁或額度用完，請稍後再試。");
      }
      const wait = (Number(res.headers.get("retry-after")) || 5 * 2 ** attempt) * 1000;
      console.warn(`  ${key.padEnd(28)} 太頻繁（429），等 ${wait / 1000} 秒後重試`);
      await new Promise(r => setTimeout(r, wait));
    }
    if (res.status === 304) { console.log(`  ${key.padEnd(28)} 沒有變動（本月第 ${n} 次呼叫）`); continue; }
    if (!res.ok) { console.warn(`  ${key.padEnd(28)} 失敗 HTTP ${res.status}，略過`); continue; }
    const body = await res.text();
    await fs.writeFile(file, body);
    const count = (() => { try { const j = JSON.parse(body); return Array.isArray(j) ? j.length : "?"; } catch { return "?"; } })();
    meta[key] = { lastModified: res.headers.get("last-modified"), fetchedAt: new Date().toISOString(), count };
    changed++;
    console.log(`  ${key.padEnd(28)} ${count} 筆（本月第 ${n} 次呼叫）`);
    if (count === 30 || count === 1000) console.warn(`    ⚠ 剛好 ${count} 筆，可能被分頁截斷，請檢查`);
    await fs.writeFile(path.join(RAW, "_meta.json"), JSON.stringify(meta, null, 2)); // 每抓完一類就存進度
    await new Promise(r => setTimeout(r, 1000)); // 放慢一點，避免 429 太頻繁
  }
  await fs.writeFile(path.join(RAW, "_meta.json"), JSON.stringify(meta, null, 2));
  return changed;
}

// ---------- 轉成網頁格式 ----------
async function raw(type) {
  const out = [];
  for (const op of OPERATORS) out.push(...await readJSON(path.join(RAW, `${type}_${op}.json`), []));
  return out;
}
// TDX 的線型是順序打亂的小段，依端點把它們接成連續的線（端點相距 40 公尺內視為相連，岔路選方向最順的）
function chainParts(parts, tol = 40) {
  const dist = (p, q) => Math.hypot((p[0] - q[0]) * 111000, (p[1] - q[1]) * 101000);
  const dir = (p, q) => Math.atan2(q[0] - p[0], (q[1] - p[1]) * 0.906);
  const turn = (a, b) => { const d = Math.abs(a - b) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; };
  const left = parts.map(p => p.slice()).sort((a, b) => b.length - a.length), out = [];
  // 從 cur 的尾端往外接；回傳要接上的小段（已調整方向），沒有就回傳 null
  const extend = cur => {
    const end = cur[cur.length - 1], heading = dir(cur[cur.length - 2], end);
    let best = null;
    left.forEach((p, i) => {
      for (const q of [p, p.slice().reverse()]) {
        if (dist(end, q[0]) > tol) continue;
        const t = turn(heading, dir(q[0], q[1]));
        if (!best || t < best.t) best = { i, q, t };
      }
    });
    if (!best || best.t > Math.PI / 2) return null; // 急轉彎通常是接到反方向或機廠支線，不接
    left.splice(best.i, 1);
    return best.q;
  };
  while (left.length) {
    let cur = left.shift();
    for (let side = 0; side < 2; side++) {
      for (let q; (q = extend(cur));) cur.push(...(dist(cur[cur.length - 1], q[0]) < 1 ? q.slice(1) : q));
      cur.reverse();
    }
    out.push(cur);
  }
  return out;
}

const isWeekday = sd => !sd || sd.Monday === 1 || sd.Monday === true || /平日|Weekday/i.test(sd.ServiceTag || "");

async function transform() {
  const notes = [];
  // 車站座標、代碼 → 站名
  const coords = {}, idName = {};
  for (const s of await raw("Station")) {
    const n = zh(s.StationName), p = s.StationPosition || {};
    idName[s.StationID] = n;
    if (p.PositionLat && p.PositionLon && !coords[n]) coords[n] = [p.PositionLat, p.PositionLon];
  }
  const nameOf = (id, nameObj) => idName[id] || zh(nameObj);

  // 站間時間（行駛＋停站，分鐘）
  const seg = {}, routeSt = {}; // routeSt：各營運路線（RouteID）停靠的站名
  for (const line of await raw("S2STravelTime")) {
    const tt = line.TravelTimes || [];
    if (line.RouteID && tt.length) routeSt[line.RouteID] = { line: line.LineID, st: [tt[0].FromStationID, ...tt.map(t => t.ToStationID)].map(id => idName[id]).filter(Boolean) };
    for (const t of tt) {
      const a = nameOf(t.FromStationID, t.FromStationName), b = nameOf(t.ToStationID, t.ToStationName);
      const v = ((t.RunTime || 0) + (t.StopTime || 0)) / 60;
      if (a && b && v > 0 && !seg[`${a}>${b}`]) seg[`${a}>${b}`] = r1(v);
    }
  }

  // 班距：平日尖峰、離峰、深夜
  // 同時依「路線」和「營運路線 RouteID」累計；班距 0 代表該時段不開，記在 none
  const hwAcc = {}, rtAcc = {};
  for (const f of await raw("Frequency")) {
    if (!isWeekday(f.ServiceDay)) continue;
    const L = f.LineID || f.LineNo; if (!L) continue;
    const a = hwAcc[L] ||= { peak: [], off: [], night: [] };
    const ra = f.RouteID ? (rtAcc[f.RouteID] ||= { peak: [], off: [], night: [], none: new Set() }) : null;
    for (const h of f.Headways || []) {
      const mid = ((h.MinHeadwayMins ?? h.MinHeadwayMin ?? 0) + (h.MaxHeadwayMins ?? h.MaxHeadwayMin ?? 0)) / 2;
      const start = toMin(h.StartTime) ?? 0;
      const peak = String(h.PeakFlag) === "1" || h.PeakFlag === true;
      const k = peak ? "peak" : start >= 23 * 60 ? "night" : "off";
      if (!mid) { ra?.none.add(k); continue; }
      a[k].push(mid); ra?.[k].push(mid);
    }
  }
  const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
  const headway = {};
  for (const L in hwAcc) {
    const a = hwAcc[L], off = avg(a.off) ?? avg(a.peak);
    if (!off) continue;
    headway[L] = { peak: r1(avg(a.peak) ?? off), off: r1(off), night: r1(avg(a.night) ?? off * 1.4) };
  }
  if (!Object.keys(headway).length) notes.push("班距資料沒有轉出來，網頁會繼續用估計值");

  // 各營運路線的停靠站與班距（null＝該時段不開），網頁用來算主幹合併班距與區間車
  const routes = [];
  for (const id in rtAcc) {
    const a = rtAcc[id], r = routeSt[id];
    if (!r || r.st.length < 2) continue;
    const v = k => { const x = avg(a[k]); return x != null ? r1(x) : null; };
    let peak = v("peak"), off = v("off"), night = v("night");
    if (off == null && !a.none.has("off")) off = peak;
    if (peak == null && !a.none.has("peak")) peak = off;
    if (night == null && !a.none.has("night")) night = off; // 沒有另列深夜時段＝全天同一班距
    if (peak == null && off == null) continue;
    routes.push({ id, line: r.line, st: r.st, peak, off, night });
  }

  // 轉乘步行時間
  const xfer = {};
  for (const t of await raw("LineTransfer")) {
    const a = lineOf(t.FromStationID) || t.FromLineID, b = lineOf(t.ToStationID) || t.ToLineID;
    const n = nameOf(t.FromStationID, t.FromStationName), n2 = nameOf(t.ToStationID, t.ToStationName);
    const v = Number(t.TransferTime);
    if (!a || !b || a === b || !(v > 0) || !PAGE_LINES.has(a) || !PAGE_LINES.has(b)) continue;
    const key = n === n2 ? `${n}|${[a, b].sort().join("|")}` : `${[n, n2].sort().join("~")}|${[a, b].sort().join("|")}`;
    xfer[key] = xfer[key] ? r1((xfer[key] + v) / 2) : v;
  }

  // 首末班車
  const firstLast = {};
  for (const e of await raw("FirstLastTimetable")) {
    if (!isWeekday(e.ServiceDay)) continue;
    const n = nameOf(e.StationID, e.StationName);
    const destId = e.DestinationStaionID ?? e.DestinationStationID;
    // TDX 的支線班次目的地會寫成本站（例如七張→七張），改成支線另一端
    const dest = destId === e.StationID && BRANCH_END[destId] ? idName[BRANCH_END[destId]]
      : nameOf(destId, e.DestinationStaionName ?? e.DestinationStationName ?? e.TripHeadSign);
    const first = toMin(e.FirstTrainTime), last = toMin(e.LastTrainTime);
    if (!n || !dest || first == null || last == null) continue;
    const list = firstLast[n] ||= [];
    if (!list.some(x => x.dest === dest)) list.push({ dest, first, last });
  }

  // 出入口
  const exits = {};
  for (const x of await raw("StationExit")) {
    const n = nameOf(x.StationID, x.StationName), p = x.ExitPosition || {};
    if (!n || !p.PositionLat) continue;
    const list = exits[n] ||= [];
    if (list.some(e => e.id === x.ExitID)) continue; // 轉乘站各線會重複列同一個出口
    // 出口名稱去掉站名，例如「台北車站M1」→「M1」、「頂埔站出口1」→「出口1」
    const name = zh(x.ExitName).replace(n, "").replace(/^站/, "") || x.ExitID;
    list.push({ id: x.ExitID, name, en: x.ExitName?.En || "", desc: norm(x.LocationDescription), lat: p.PositionLat, lng: p.PositionLon, elevator: !!x.Elevator });
  }

  // 路線線型（WKT → [[lat,lng],...]）
  const shapes = {};
  for (const s of await raw("Shape")) {
    const L = s.LineID || s.LineNo, wkt = s.Geometry || s.WKT || "";
    if (!L || !wkt) continue;
    const parts = [...wkt.matchAll(/\(([^()]+)\)/g)].map(m => m[1].split(",").map(pt => { const [x, y] = pt.trim().split(/\s+/).map(Number); return [Math.round(y * 1e5) / 1e5, Math.round(x * 1e5) / 1e5]; }));
    (shapes[L] ||= []).push(...parts.filter(p => p.length > 1));
  }
  for (const L in shapes) shapes[L] = chainParts(shapes[L]);

  const meta = await readJSON(path.join(RAW, "_meta.json"), {});
  const data = {
    source: "TDX 運輸資料流通服務平臺",
    generatedAt: new Date().toISOString(),
    counts: { stations: Object.keys(coords).length, segments: Object.keys(seg).length, headwayLines: Object.keys(headway).length, headwayRoutes: routes.length, transfers: Object.keys(xfer).length, firstLastStations: Object.keys(firstLast).length, exitStations: Object.keys(exits).length, shapeLines: Object.keys(shapes).length },
    fetched: Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v.fetchedAt])),
    coords, seg, headway, routes, xfer, firstLast, exits, shapes
  };
  await fs.writeFile(OUT, "// 由 fetch-tdx.mjs 自動產生，請勿手動修改\nwindow.METRO_DATA=" + JSON.stringify(data) + ";\n");
  console.log("\n已產生 metro-data.js：");
  for (const [k, v] of Object.entries(data.counts)) console.log(`  ${k.padEnd(18)} ${v}`);
  for (const n of notes) console.warn("  ⚠ " + n);
  if (!data.counts.stations) console.warn("  ⚠ 沒有抓到任何車站，請檢查 tdx-raw/ 裡的檔案內容");
}

// ---------- 主程式 ----------
(async () => {
  await loadEnv();
  try {
    if (!OFFLINE) {
      console.log("從 TDX 抓資料…");
      const changed = await fetchAll();
      if (!changed && !FORCE && await fs.access(OUT).then(() => true, () => false)) { console.log("\n資料都沒有變動，沿用現有的 metro-data.js。"); return; }
    }
    await transform();
  } catch (e) {
    console.error("\n錯誤：" + e.message);
    process.exit(1);
  }
})();
