#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

// ── Paths ──────────────────────────────────────────────────────────────────

const ROOT = path.join(__dirname, "..");
const CONFIG_FILE = path.join(ROOT, "config.json");
const DATA_DIR = path.join(ROOT, "data");
const TAGS_FILE = path.join(DATA_DIR, "tags.json");
const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");
const SITE_DIR = path.join(DATA_DIR, "site");
const GAMES_DIR = path.join(DATA_DIR, "games");

// The --snapshot path may log; the MCP stdio path must never write to stdout.
const CLI_MODE = process.argv.includes("--snapshot");
function log(msg: string) {
  if (CLI_MODE) process.stdout.write(msg + "\n");
}

// ── Config ─────────────────────────────────────────────────────────────────

interface Config {
  trackedTags: number[];        // Steam tag IDs the site + snapshots cover
  horizonDays: number;          // how far ahead the site's calendar looks
  resultsPerCategory: number;   // rows captured per tag per snapshot
  useSteamSpy: boolean;         // third-party enrichment on/off
  allowAdult: boolean;          // include adult-only titles in the charts
  pinnedAppIds: number[];       // pinned to the top of output and the site
  storeThrottleMs: number;      // min gap between store.steampowered.com hits
  steamSpyThrottleMs: number;   // min gap between steamspy.com hits
  siteUrl: string;              // public GitHub Pages URL
}

function loadConfig(): Config {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return { ...defaultConfig(), ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) };
    } catch {}
  }
  return defaultConfig();
}

function defaultConfig(): Config {
  return {
    trackedTags: [1663, 122, 492, 1716],
    horizonDays: 120,
    resultsPerCategory: 50,
    useSteamSpy: true,
    allowAdult: false,
    pinnedAppIds: [],
    storeThrottleMs: 1500,
    steamSpyThrottleMs: 1100,
    siteUrl: "https://waligug.github.io/steam-tracker/",
  };
}

function saveConfig(cfg: Config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function ensureDirs() {
  for (const d of [DATA_DIR, SNAPSHOT_DIR, SITE_DIR, GAMES_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
  }
}

// ── Throttled fetch ────────────────────────────────────────────────────────
// One promise chain per host enforces a minimum gap between requests. Every
// network call in this file goes through here, so the rate limit holds no
// matter how many callers are in flight.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const hostQueues: Record<string, Promise<void>> = {};
const hostGaps: Record<string, number> = {
  "store.steampowered.com": 1500,
  "steamspy.com": 1100,
  "api.steampowered.com": 250,
};

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function applyThrottleConfig(cfg: Config) {
  hostGaps["store.steampowered.com"] = cfg.storeThrottleMs;
  hostGaps["steamspy.com"] = cfg.steamSpyThrottleMs;
}

// Returns parsed JSON, raw text, or null. Never throws.
async function throttledFetch(url: string, asText = false): Promise<any> {
  const host = new URL(url).host;
  const gap = hostGaps[host] ?? 500;

  const prior = hostQueues[host] ?? Promise.resolve();
  let release!: () => void;
  hostQueues[host] = new Promise<void>((r) => (release = r));
  await prior;

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(attempt === 1 ? 2000 : 6000);
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
          signal: AbortSignal.timeout(20000),
        });
        if (res.status === 429 || res.status >= 500) continue;
        if (!res.ok) return null;
        const body = await res.text();
        if (asText) return body;
        try { return JSON.parse(body); } catch { return null; }
      } catch {
        continue;
      }
    }
    return null;
  } finally {
    await sleep(gap);
    release();
  }
}

// ── Tags ───────────────────────────────────────────────────────────────────

interface TagStore {
  fetchedAt: string;
  tags: Record<string, string>;   // id -> name
  byName: Record<string, number>; // lowercased name -> id
}

async function loadTags(force = false): Promise<TagStore | null> {
  ensureDirs();
  if (!force && fs.existsSync(TAGS_FILE)) {
    try {
      const store: TagStore = JSON.parse(fs.readFileSync(TAGS_FILE, "utf8"));
      const ageDays = (Date.now() - Date.parse(store.fetchedAt)) / 86400000;
      if (ageDays < 30) return store;
    } catch {}
  }

  const json = await throttledFetch(
    "https://api.steampowered.com/IStoreService/GetTagList/v1/?language=english"
  );
  const list = json?.response?.tags;
  if (!Array.isArray(list) || list.length === 0) {
    // Network failed — fall back to whatever is on disk rather than nothing.
    if (fs.existsSync(TAGS_FILE)) {
      try { return JSON.parse(fs.readFileSync(TAGS_FILE, "utf8")); } catch {}
    }
    return null;
  }

  const store: TagStore = { fetchedAt: new Date().toISOString(), tags: {}, byName: {} };
  for (const t of list) {
    if (t?.tagid === undefined || !t?.name) continue;
    store.tags[String(t.tagid)] = t.name;
    store.byName[String(t.name).toLowerCase()] = t.tagid;
  }
  fs.writeFileSync(TAGS_FILE, JSON.stringify(store, null, 2));
  return store;
}

// "FPS, 122, Roguelike" -> [1663, 122, 1716]. Unknown names are dropped.
async function resolveTags(input: string): Promise<{ ids: number[]; unknown: string[] }> {
  const store = await loadTags();
  const ids: number[] = [];
  const unknown: string[] = [];
  for (const raw of input.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (/^\d+$/.test(raw)) { ids.push(parseInt(raw, 10)); continue; }
    const hit = store?.byName[raw.toLowerCase()];
    if (hit !== undefined) ids.push(hit);
    else unknown.push(raw);
  }
  return { ids, unknown };
}

function tagName(store: TagStore | null, id: number): string {
  return store?.tags[String(id)] ?? String(id);
}

// ── Store search + HTML row parsing ────────────────────────────────────────
// `json=1` on this endpoint returns rendered HTML in `results_html`, not data.
// Each field gets its own regex so a Valve markup change costs one column
// instead of the whole row. Only appid is mandatory.

interface Row {
  appid: number;
  rank: number;
  name: string;
  releaseDateRaw: string;
  releaseDateISO: string | null;
  priceCents: number | null;
  priceText: string | null;
  tagIds: number[];
  descIds: number[];
  capsule: string | null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Best-effort ISO for sorting only. The raw string is always kept and shown.
function parseReleaseDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  // "10 Sep, 2026" / "10 September 2026"
  let m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\,?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo !== undefined) return iso(parseInt(m[3], 10), mo, parseInt(m[1], 10));
  }
  // "Sep 10, 2026"
  m = s.match(/^([A-Za-z]{3,})\s+(\d{1,2})\,?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo !== undefined) return iso(parseInt(m[3], 10), mo, parseInt(m[2], 10));
  }
  // "Sep 2026" / "September 2026"
  m = s.match(/^([A-Za-z]{3,})\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo !== undefined) return iso(parseInt(m[2], 10), mo, 28);
  }
  // "Q4 2026"
  m = s.match(/^Q([1-4])\s+(\d{4})$/i);
  if (m) return iso(parseInt(m[2], 10), parseInt(m[1], 10) * 3 - 1, 28);
  // "2026"
  m = s.match(/^(\d{4})$/);
  if (m) return iso(parseInt(m[1], 10), 11, 31);

  return null; // "Coming soon", "To be announced", localized oddities -> TBA
}

function iso(y: number, mo: number, d: number): string {
  const dt = new Date(Date.UTC(y, mo, d));
  return dt.toISOString().slice(0, 10);
}

const ADULT_DESCIDS = [3, 4];

function isAdult(r: Row): boolean {
  return r.descIds.some((d) => ADULT_DESCIDS.includes(d));
}

function parseRows(html: string, startRank: number): Row[] {
  const rows: Row[] = [];
  const chunks = html.split(/(?=<a[^>]*class="[^"]*search_result_row)/);
  let rank = startRank;

  for (const chunk of chunks) {
    const idMatch = chunk.match(/data-ds-appid="(\d+)/);
    if (!idMatch) continue;

    const tagMatch = chunk.match(/data-ds-tagids="\[([\d,\s]*)\]"/);
    const nameMatch = chunk.match(/<span class="title">([\s\S]*?)<\/span>/);
    const dateMatch = chunk.match(/class="[^"]*search_released[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const priceMatch = chunk.match(/data-price-final="(\d+)"/);
    const priceTextMatch = chunk.match(/class="discount_final_price[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const imgMatch = chunk.match(/<img[^>]+src="([^"]+)"/);
    const descMatch = chunk.match(/data-ds-descids="\[([\d,\s]*)\]"/);

    const releaseDateRaw = dateMatch ? decodeEntities(dateMatch[1].replace(/<[^>]*>/g, "")) : "";

    rows.push({
      appid: parseInt(idMatch[1], 10),
      rank: rank++,
      name: nameMatch ? decodeEntities(nameMatch[1].replace(/<[^>]*>/g, "")) : "(unknown)",
      releaseDateRaw,
      releaseDateISO: parseReleaseDate(releaseDateRaw),
      priceCents: priceMatch ? parseInt(priceMatch[1], 10) : null,
      priceText: priceTextMatch ? decodeEntities(priceTextMatch[1].replace(/<[^>]*>/g, "")) : null,
      tagIds: tagMatch
        ? tagMatch[1].split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))
        : [],
      descIds: descMatch
        ? descMatch[1].split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => !isNaN(n))
        : [],
      capsule: imgMatch ? imgMatch[1] : null,
    });
  }
  return rows;
}

interface SearchResult {
  rows: Row[];
  totalCount: number;
  parseWarning: string | null;
}

// filter: "comingsoon" (date order) or "popularcomingsoon" (wishlist order)
async function searchUpcoming(
  tagIds: number[],
  filter: "comingsoon" | "popularcomingsoon",
  wanted: number,
  allowAdult = false
): Promise<SearchResult> {
  const rows: Row[] = [];
  let totalCount = 0;
  let parseWarning: string | null = null;

  for (let start = 0; start < wanted; start += 50) {
    const count = Math.min(50, wanted - start);
    const params = new URLSearchParams({
      query: "",
      start: String(start),
      count: String(count),
      dynamic_data: "",
      force_infinite: "1",
      infinite: "1",
      json: "1",
      category1: "998",           // Games only (excludes DLC, soundtracks, tools)
      filter,
    });
    if (filter === "comingsoon") params.set("sort_by", "Released_ASC");
    if (tagIds.length) params.set("tags", tagIds.join(","));

    const json = await throttledFetch(
      `https://store.steampowered.com/search/results/?${params.toString()}`
    );
    if (!json || typeof json.results_html !== "string") {
      parseWarning = `[FETCH WARNING] no results_html at start=${start}`;
      break;
    }
    totalCount = json.total_count ?? totalCount;

    const raw = parseRows(json.results_html, start + 1);
    const batch = allowAdult ? raw : raw.filter((r) => !isAdult(r));
    if (raw.length === 0) {
      // Distinguish "Valve changed the markup" from "genuinely out of results".
      if (json.results_html.includes("search_result_row")) {
        parseWarning = `[PARSE WARNING] extracted 0 rows from non-empty results_html at start=${start}`;
      }
      break;
    }
    rows.push(...batch);
    if (raw.length < count) break;
  }

  // Re-rank after filtering so ranks stay contiguous and comparable between days.
  rows.forEach((r, i) => (r.rank = i + 1));
  return { rows, totalCount, parseWarning };
}

// ── Snapshots ──────────────────────────────────────────────────────────────

interface Snapshot {
  takenAt: string;
  categories: Record<string, { tagName: string; totalCount: number; ranked: Row[] }>;
}

function snapshotFiles(): string[] {
  ensureDirs();
  try {
    return fs.readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

function readSnapshot(file: string): Snapshot | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, file), "utf8"));
  } catch {
    return null;
  }
}

function newestSnapshot(): { file: string; snap: Snapshot } | null {
  const files = snapshotFiles();
  for (let i = files.length - 1; i >= 0; i--) {
    const snap = readSnapshot(files[i]);
    if (snap) return { file: files[i], snap };
  }
  return null;
}

// The snapshot closest to `days` ago, for diffing. Falls back to the oldest.
function snapshotNDaysAgo(days: number): { file: string; snap: Snapshot } | null {
  const files = snapshotFiles();
  if (files.length < 2) return null;
  const target = Date.now() - days * 86400000;
  let best: { file: string; snap: Snapshot } | null = null;
  let bestDist = Infinity;
  for (const f of files.slice(0, -1)) {
    const snap = readSnapshot(f);
    if (!snap) continue;
    const dist = Math.abs(Date.parse(snap.takenAt) - target);
    if (dist < bestDist) { bestDist = dist; best = { file: f, snap }; }
  }
  return best;
}

async function takeSnapshot(cfg: Config, tagIds: number[]): Promise<{ snap: Snapshot; warnings: string[] }> {
  ensureDirs();
  const store = await loadTags();
  const snap: Snapshot = { takenAt: new Date().toISOString(), categories: {} };
  const warnings: string[] = [];

  for (const id of tagIds) {
    const name = tagName(store, id);
    log(`Fetching ${name} (${id})...`);
    // Wishlist order is the only pre-release traction signal Steam exposes.
    const res = await searchUpcoming([id], "popularcomingsoon", cfg.resultsPerCategory, cfg.allowAdult);
    if (res.parseWarning) warnings.push(`${name}: ${res.parseWarning}`);
    snap.categories[String(id)] = {
      tagName: name,
      totalCount: res.totalCount,
      ranked: res.rows,
    };
    log(`  ${res.rows.length} rows (of ${res.totalCount} upcoming)`);
  }

  const stamp = snap.takenAt.slice(0, 10);
  fs.writeFileSync(path.join(SNAPSHOT_DIR, `${stamp}.json`), JSON.stringify(snap, null, 2));
  return { snap, warnings };
}

// Daily for 90 days, then weekly. Keeps the repo from growing without bound.
function pruneSnapshots() {
  const files = snapshotFiles();
  const cutoff = Date.now() - 90 * 86400000;
  for (const f of files) {
    const d = Date.parse(f.replace(".json", ""));
    if (isNaN(d) || d >= cutoff) continue;
    const dow = new Date(d).getUTCDay();
    if (dow === 1) continue; // keep Mondays
    try { fs.unlinkSync(path.join(SNAPSHOT_DIR, f)); } catch {}
  }
}

// ── Diffing ────────────────────────────────────────────────────────────────

interface Move {
  appid: number;
  name: string;
  releaseDateRaw: string;
  releaseDateISO: string | null;
  priceCents: number | null;
  priceText: string | null;
  capsule: string | null;
  tagId: number;
  tagName: string;
  rank: number;
  prevRank: number | null;
  delta: number | null;      // positive = climbing
  status: "rising" | "falling" | "new" | "flat";
}

function diffSnapshots(newer: Snapshot, older: Snapshot | null, tagIds: number[]): Move[] {
  const moves: Move[] = [];

  for (const id of tagIds) {
    const cat = newer.categories[String(id)];
    if (!cat) continue;
    const prev = older?.categories[String(id)];
    const prevRank = new Map<number, number>();
    for (const r of prev?.ranked ?? []) prevRank.set(r.appid, r.rank);

    for (const row of cat.ranked) {
      const before = prevRank.has(row.appid) ? prevRank.get(row.appid)! : null;
      const delta = before === null ? null : before - row.rank;
      let status: Move["status"] = "flat";
      if (before === null) status = prev ? "new" : "flat";
      else if (delta! > 0) status = "rising";
      else if (delta! < 0) status = "falling";

      moves.push({
        appid: row.appid,
        name: row.name,
        releaseDateRaw: row.releaseDateRaw,
        releaseDateISO: row.releaseDateISO,
        priceCents: row.priceCents,
        priceText: row.priceText,
        capsule: row.capsule,
        tagId: id,
        tagName: cat.tagName,
        rank: row.rank,
        prevRank: before,
        delta,
        status,
      });
    }
  }
  return moves;
}

// Rank is noisy in the tail (positions 40-50 shuffle on tiny wishlist deltas)
// and compressed at the head, so require bigger moves the further down we are.
function significant(m: Move): boolean {
  if (m.delta === null) return false;
  const threshold = m.rank <= 10 ? 2 : m.rank <= 25 ? 4 : 6;
  return Math.abs(m.delta) >= threshold;
}

// ── Site data ──────────────────────────────────────────────────────────────

function bucketFor(isoDate: string | null): string {
  if (!isoDate) return "TBA";
  const now = Date.now();
  const t = Date.parse(isoDate);
  const days = (t - now) / 86400000;
  if (days < 0) return "Releasing now";
  if (days <= 7) return "This week";
  if (days <= 30) return "Next 30 days";
  if (days <= 120) return "Next 4 months";
  return "Further out";
}

const BUCKET_ORDER = ["Releasing now", "This week", "Next 30 days", "Next 4 months", "Further out", "TBA"];

function generateSiteData(cfg: Config) {
  ensureDirs();
  const current = newestSnapshot();
  if (!current) return;

  const week = snapshotNDaysAgo(7);
  const tagIds = Object.keys(current.snap.categories).map((k) => parseInt(k, 10));
  const moves = diffSnapshots(current.snap, week?.snap ?? null, tagIds);

  // Rank history per game, shared by both output files for sparklines.
  const files = snapshotFiles().slice(-30);
  const series = new Map<number, { date: string; rank: number }[]>();
  for (const f of files) {
    const snap = readSnapshot(f);
    if (!snap) continue;
    const date = snap.takenAt.slice(0, 10);
    for (const cat of Object.values(snap.categories)) {
      for (const r of cat.ranked) {
        if (!series.has(r.appid)) series.set(r.appid, []);
        const arr = series.get(r.appid)!;
        const prior = arr.find((p) => p.date === date);
        if (!prior) arr.push({ date, rank: r.rank });
        else if (r.rank < prior.rank) prior.rank = r.rank; // best rank across tags
      }
    }
  }

  // upcoming.json — one entry per game (deduped across tags), date-bucketed.
  const byApp = new Map<number, any>();
  for (const m of moves) {
    const existing = byApp.get(m.appid);
    if (existing) {
      if (!existing.tags.includes(m.tagName)) existing.tags.push(m.tagName);
      if (existing.bestRank > m.rank) { existing.bestRank = m.rank; existing.delta = m.delta; }
      continue;
    }
    byApp.set(m.appid, {
      appid: m.appid,
      name: m.name,
      releaseDateRaw: m.releaseDateRaw,
      releaseDateISO: m.releaseDateISO,
      priceCents: m.priceCents,
      priceText: m.priceText,
      capsule: m.capsule,
      tags: [m.tagName],
      bestRank: m.rank,
      delta: m.delta,
      bucket: bucketFor(m.releaseDateISO),
      pinned: cfg.pinnedAppIds.includes(m.appid),
      series: series.get(m.appid) ?? [],
    });
  }
  const games = [...byApp.values()].sort((a, b) => {
    const ba = BUCKET_ORDER.indexOf(a.bucket), bb = BUCKET_ORDER.indexOf(b.bucket);
    if (ba !== bb) return ba - bb;
    if (a.releaseDateISO && b.releaseDateISO) return a.releaseDateISO.localeCompare(b.releaseDateISO);
    return a.bestRank - b.bestRank;
  });
  fs.writeFileSync(path.join(SITE_DIR, "upcoming.json"),
    JSON.stringify({ buckets: BUCKET_ORDER, games }, null, 2));

  // trending.json — significant movers only.
  const movers = moves.filter(significant);
  const decorate = (m: Move) => ({ ...m, series: series.get(m.appid) ?? [] });
  fs.writeFileSync(path.join(SITE_DIR, "trending.json"), JSON.stringify({
    comparedTo: week?.snap.takenAt ?? null,
    risers: movers.filter((m) => m.status === "rising").sort((a, b) => b.delta! - a.delta!).slice(0, 40).map(decorate),
    fallers: movers.filter((m) => m.status === "falling").sort((a, b) => a.delta! - b.delta!).slice(0, 20).map(decorate),
    newcomers: moves.filter((m) => m.status === "new").sort((a, b) => a.rank - b.rank).slice(0, 30).map(decorate),
  }, null, 2));

  // meta.json — header line on the site.
  const all = snapshotFiles();
  fs.writeFileSync(path.join(SITE_DIR, "meta.json"), JSON.stringify({
    lastUpdated: current.snap.takenAt,
    snapshotCount: all.length,
    oldestSnapshot: all[0]?.replace(".json", "") ?? null,
    trackedTags: Object.values(current.snap.categories).map((c) => c.tagName),
    gameCount: games.length,
  }, null, 2));
}

// ── Game enrichment ────────────────────────────────────────────────────────

interface GameDetail {
  appid: number;
  fetchedAt: string;
  name: string;
  comingSoon: boolean;
  releaseDateRaw: string;
  shortDescription: string;
  genres: string[];
  developers: string[];
  publishers: string[];
  priceText: string | null;
  headerImage: string | null;
  reviews: { total: number; positive: number; scoreDesc: string } | null;
  playerCount: number | null;
  steamSpy: { owners: string; ccu: number; topTags: string[] } | null;
}

async function fetchGame(appid: number, cfg: Config): Promise<GameDetail | null> {
  ensureDirs();
  const cacheFile = path.join(GAMES_DIR, `${appid}.json`);
  if (fs.existsSync(cacheFile)) {
    try {
      const cached: GameDetail = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (Date.now() - Date.parse(cached.fetchedAt) < 24 * 3600 * 1000) return cached;
    } catch {}
  }

  // appdetails accepts exactly one appid — multi-appid returns null.
  const detailsJson = await throttledFetch(
    `https://store.steampowered.com/api/appdetails?appids=${appid}&l=english`
  );
  const d = detailsJson?.[String(appid)]?.data;
  if (!d) {
    if (fs.existsSync(cacheFile)) {
      try { return JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch {}
    }
    return null;
  }

  const comingSoon = !!d.release_date?.coming_soon;

  // Reviews and player counts are structurally zero before release — don't
  // even ask for them, and never show a misleading 0.
  let reviews: GameDetail["reviews"] = null;
  let playerCount: number | null = null;
  if (!comingSoon) {
    const rev = await throttledFetch(
      `https://store.steampowered.com/appreviews/${appid}?json=1&language=all&purchase_type=all&num_per_page=0`
    );
    const q = rev?.query_summary;
    if (q && q.total_reviews > 0) {
      reviews = { total: q.total_reviews, positive: q.total_positive, scoreDesc: q.review_score_desc ?? "" };
    }
    const pc = await throttledFetch(
      `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appid}`
    );
    if (pc?.response?.result === 1) playerCount = pc.response.player_count;
  }

  let steamSpy: GameDetail["steamSpy"] = null;
  if (cfg.useSteamSpy) {
    const ss = await throttledFetch(`https://steamspy.com/api.php?request=appdetails&appid=${appid}`);
    if (ss && ss.appid) {
      const tags = ss.tags && typeof ss.tags === "object" ? Object.keys(ss.tags).slice(0, 8) : [];
      steamSpy = { owners: ss.owners ?? "", ccu: ss.ccu ?? 0, topTags: tags };
    }
  }

  const detail: GameDetail = {
    appid,
    fetchedAt: new Date().toISOString(),
    name: d.name ?? "(unknown)",
    comingSoon,
    releaseDateRaw: d.release_date?.date ?? "",
    shortDescription: (d.short_description ?? "").replace(/<[^>]*>/g, ""),
    genres: (d.genres ?? []).map((g: any) => g.description),
    developers: d.developers ?? [],
    publishers: d.publishers ?? [],
    priceText: d.is_free ? "Free" : d.price_overview?.final_formatted ?? null,
    headerImage: d.header_image ?? null,
    reviews,
    playerCount,
    steamSpy,
  };
  fs.writeFileSync(cacheFile, JSON.stringify(detail, null, 2));
  return detail;
}

// ── Formatting helpers ─────────────────────────────────────────────────────

function pad(s: string, n: number): string {
  const str = s.length > n ? s.slice(0, n - 1) + "…" : s;
  return str + " ".repeat(Math.max(0, n - str.length));
}

function priceLabel(r: { priceCents: number | null; priceText: string | null }): string {
  if (r.priceText) return r.priceText;
  if (r.priceCents === null || r.priceCents === 0) return "TBA";
  return "$" + (r.priceCents / 100).toFixed(2);
}

function formatRows(rows: Row[], store: TagStore | null, pinned: number[]): string[] {
  const lines: string[] = [];
  lines.push(`${pad("#", 5)}${pad("RELEASES", 16)}${pad("NAME", 42)}${pad("PRICE", 10)}TAGS`);
  for (const r of rows) {
    const tags = r.tagIds.slice(0, 3).map((t) => tagName(store, t)).join(", ");
    const mark = pinned.includes(r.appid) ? "*" : "";
    lines.push(
      pad(mark + String(r.rank), 5) +
      pad(r.releaseDateRaw || "TBA", 16) +
      pad(r.name, 42) +
      pad(priceLabel(r), 10) +
      tags
    );
  }
  return lines;
}

function daysUntil(isoDate: string | null): number | null {
  if (!isoDate) return null;
  return Math.round((Date.parse(isoDate) - Date.now()) / 86400000);
}

// ── Git ────────────────────────────────────────────────────────────────────

function gitPush(message: string): string {
  if (!fs.existsSync(path.join(ROOT, ".git"))) return "Not a git repo — nothing pushed.";
  const run = (args: string[]) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });

  run(["add", "data/"]);
  const staged = run(["diff", "--staged", "--quiet"]);
  if (staged.status === 0) return "No data changes to push.";

  const commit = run(["commit", "-m", message]);
  if (commit.status !== 0) return `Commit failed: ${(commit.stderr || "").trim().split("\n").pop()}`;
  run(["pull", "--rebase"]);
  const push = run(["push"]);
  if (push.status !== 0) return `Commit made, but push failed: ${(push.stderr || "").trim().split("\n").pop()}`;
  return "Committed and pushed — the live site will update in about a minute.";
}

// ── MCP server ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: "steam-tracker", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "find_upcoming",
      description: "Find upcoming Steam releases filtered by tag/genre, sorted by release date or by wishlist popularity",
      inputSchema: {
        type: "object",
        properties: {
          tags: { type: "string", description: "Comma-separated tag names or IDs, e.g. 'FPS,Roguelike' or '1663,1716'. Multiple tags = AND. Omit for all upcoming games." },
          sort: { type: "string", description: "'date' for soonest first, or 'popular' for wishlist rank. Default 'date'." },
          withinDays: { type: "number", description: "Only show games releasing within this many days. Omit for no limit." },
          limit: { type: "number", description: "Max results, default 25." },
        },
      },
    },
    {
      name: "whats_trending",
      description: "Compare snapshots to show which upcoming games are climbing or falling in Steam's wishlist rankings",
      inputSchema: {
        type: "object",
        properties: {
          tags: { type: "string", description: "Comma-separated tag names or IDs. Omit to use the tracked categories." },
          since: { type: "number", description: "Compare against the snapshot from this many days ago. Default 7." },
          kind: { type: "string", description: "'risers' (default), 'fallers', 'new', or 'all'." },
          limit: { type: "number", description: "Max results, default 15." },
        },
      },
    },
    {
      name: "list_tags",
      description: "Look up Steam tag IDs by name — needed because the store filters by numeric tag ID",
      inputSchema: {
        type: "object",
        properties: {
          search: { type: "string", description: "Substring to match against tag names, e.g. 'rogue'. Omit to list the tracked tags." },
        },
      },
    },
    {
      name: "get_game",
      description: "Full detail and every available traction signal for one game",
      inputSchema: {
        type: "object",
        properties: {
          appid: { type: "number", description: "Steam app ID." },
          name: { type: "string", description: "Game name, if the app ID is unknown. Searched against the latest snapshot." },
        },
      },
    },
    {
      name: "take_snapshot",
      description: "Fetch current wishlist standings for the tracked categories, save a dated snapshot, rebuild the site data, and push to GitHub",
      inputSchema: {
        type: "object",
        properties: {
          tags: { type: "string", description: "Override the tracked tags for this run." },
          push: { type: "boolean", description: "Commit and push so the live site updates. Default true." },
        },
      },
    },
    {
      name: "set_categories",
      description: "Add or remove tracked tags/genres, set the release horizon, NSFW filtering, and pinned games",
      inputSchema: {
        type: "object",
        properties: {
          tags: { type: "string", description: "Comma-separated tag names or IDs — REPLACES the tracked list." },
          addTags: { type: "string", description: "Comma-separated tag names or IDs to ADD to the tracked list, keeping the existing ones." },
          removeTags: { type: "string", description: "Comma-separated tag names or IDs to stop tracking." },
          horizonDays: { type: "number", description: "How far ahead the site's calendar looks." },
          resultsPerCategory: { type: "number", description: "Rows captured per tag per snapshot. Default 50." },
          useSteamSpy: { type: "boolean", description: "Enable third-party SteamSpy enrichment." },
          allowAdult: { type: "boolean", description: "Include adult-only titles. Default false — the broad-tag charts are otherwise swamped by them." },
          pinnedAppIds: { type: "string", description: "Comma-separated app IDs to pin to the top of output and the site." },
        },
      },
    },
    {
      name: "get_config",
      description: "Show tracked categories, snapshot history, and the live site URL",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;
  const cfg = loadConfig();
  applyThrottleConfig(cfg);

  try {
    switch (name) {
      case "get_config": {
        const files = snapshotFiles();
        const current = newestSnapshot();
        const store = await loadTags();
        const lines = [
          "STEAM TRACKER",
          "",
          `Site:          ${cfg.siteUrl}`,
          `Tracked tags:  ${cfg.trackedTags.map((t) => `${tagName(store, t)} (${t})`).join(", ") || "(none)"}`,
          `Horizon:       ${cfg.horizonDays} days`,
          `Per category:  ${cfg.resultsPerCategory} games`,
          `SteamSpy:      ${cfg.useSteamSpy ? "on" : "off"}`,
          `Adult titles:  ${cfg.allowAdult ? "included" : "filtered out"}`,
          `Pinned:        ${cfg.pinnedAppIds.join(", ") || "(none)"}`,
          "",
          `Snapshots:     ${files.length}`,
          `Oldest:        ${files[0]?.replace(".json", "") ?? "(none)"}`,
          `Newest:        ${current ? current.snap.takenAt : "(none)"}`,
        ];
        if (files.length < 2) {
          lines.push("", "NOTE: trend data needs at least two snapshots on different days.");
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "set_categories": {
        const changes: string[] = [];
        const store0 = await loadTags();
        const nameOf = (id: number) => `${tagName(store0, id)} (${id})`;

        if (a.tags !== undefined) {
          const { ids, unknown } = await resolveTags(String(a.tags));
          if (ids.length) { cfg.trackedTags = ids; changes.push(`tracking only: ${ids.map(nameOf).join(", ")}`); }
          if (unknown.length) changes.push(`unrecognized (ignored): ${unknown.join(", ")}`);
        }
        if (a.addTags !== undefined) {
          const { ids, unknown } = await resolveTags(String(a.addTags));
          const added = ids.filter((i) => !cfg.trackedTags.includes(i));
          const dupes = ids.filter((i) => cfg.trackedTags.includes(i));
          cfg.trackedTags = [...cfg.trackedTags, ...added];
          if (added.length) changes.push(`added: ${added.map(nameOf).join(", ")}`);
          if (dupes.length) changes.push(`already tracked: ${dupes.map(nameOf).join(", ")}`);
          if (unknown.length) changes.push(`unrecognized (ignored): ${unknown.join(", ")} — try list_tags`);
        }
        if (a.removeTags !== undefined) {
          const { ids, unknown } = await resolveTags(String(a.removeTags));
          const gone = ids.filter((i) => cfg.trackedTags.includes(i));
          cfg.trackedTags = cfg.trackedTags.filter((i) => !ids.includes(i));
          if (gone.length) changes.push(`removed: ${gone.map(nameOf).join(", ")}`);
          if (unknown.length) changes.push(`unrecognized (ignored): ${unknown.join(", ")}`);
        }
        if (a.allowAdult !== undefined) { cfg.allowAdult = a.allowAdult as boolean; changes.push(`allowAdult -> ${cfg.allowAdult}`); }
        if (a.horizonDays !== undefined) { cfg.horizonDays = a.horizonDays as number; changes.push(`horizonDays -> ${cfg.horizonDays}`); }
        if (a.resultsPerCategory !== undefined) { cfg.resultsPerCategory = a.resultsPerCategory as number; changes.push(`resultsPerCategory -> ${cfg.resultsPerCategory}`); }
        if (a.useSteamSpy !== undefined) { cfg.useSteamSpy = a.useSteamSpy as boolean; changes.push(`useSteamSpy -> ${cfg.useSteamSpy}`); }
        if (a.pinnedAppIds !== undefined) {
          cfg.pinnedAppIds = String(a.pinnedAppIds).split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
          changes.push(`pinnedAppIds -> ${cfg.pinnedAppIds.join(", ") || "(none)"}`);
        }
        if (!changes.length) return { content: [{ type: "text", text: "Nothing to change." }] };
        saveConfig(cfg);
        return { content: [{ type: "text", text: ["CONFIG UPDATED", ...changes.map((c) => "  " + c)].join("\n") }] };
      }

      case "list_tags": {
        const store = await loadTags();
        if (!store) return { content: [{ type: "text", text: "Could not load the Steam tag list and nothing is cached. Check your connection." }] };
        const search = a.search === undefined ? "" : String(a.search).toLowerCase();

        if (!search) {
          const lines = ["TRACKED TAGS", ""];
          for (const id of cfg.trackedTags) lines.push(`  ${pad(String(id), 8)}${tagName(store, id)}`);
          lines.push("", "Pass a search term to look up other tags, e.g. search: \"rogue\"");
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        const hits = Object.entries(store.tags)
          .filter(([, n]) => n.toLowerCase().includes(search))
          .sort((x, y) => x[1].length - y[1].length)
          .slice(0, 30);
        if (!hits.length) return { content: [{ type: "text", text: `No tags matching "${search}".` }] };
        const lines = [`TAGS MATCHING "${search}"`, ""];
        for (const [id, n] of hits) lines.push(`  ${pad(id, 8)}${n}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "find_upcoming": {
        const store = await loadTags();
        const limit = (a.limit as number) ?? 25;
        const sort = String(a.sort ?? "date").toLowerCase();
        const filter = sort.startsWith("pop") ? "popularcomingsoon" : "comingsoon";
        const withinDays = a.withinDays as number | undefined;

        let ids: number[] = [];
        let unknown: string[] = [];
        if (a.tags !== undefined) ({ ids, unknown } = await resolveTags(String(a.tags)));

        // Ask for extra rows when filtering by date, since many get dropped.
        const want = withinDays ? Math.min(200, limit * 4) : limit;
        const res = await searchUpcoming(ids, filter as any, want, cfg.allowAdult);

        if (!res.rows.length) {
          const msg = res.parseWarning
            ? `No results. ${res.parseWarning} — Steam may have changed its store markup.`
            : "No results. Try different tags, or check your connection.";
          return { content: [{ type: "text", text: msg }] };
        }

        let rows = res.rows;
        if (withinDays !== undefined) {
          rows = rows.filter((r) => {
            const d = daysUntil(r.releaseDateISO);
            return d !== null && d >= 0 && d <= withinDays;
          });
        }
        rows = rows.slice(0, limit);

        const header = [
          filter === "popularcomingsoon" ? "MOST WISHLISTED UPCOMING" : "UPCOMING BY RELEASE DATE",
          ids.length ? `Tags: ${ids.map((i) => tagName(store, i)).join(" + ")}` : "Tags: (all games)",
          withinDays !== undefined ? `Window: next ${withinDays} days` : `Total upcoming in this filter: ${res.totalCount}`,
          "",
        ];
        const lines = [...header, ...formatRows(rows, store, cfg.pinnedAppIds)];
        if (unknown.length) lines.push("", `[IGNORED] unrecognized tags: ${unknown.join(", ")} — try list_tags`);
        if (res.parseWarning) lines.push("", res.parseWarning);
        if (withinDays !== undefined && rows.length === 0) {
          lines.push("", "Nothing has a confirmed date in that window — most upcoming games are listed as TBA or a quarter.");
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "whats_trending": {
        const files = snapshotFiles();
        if (files.length === 0) {
          return { content: [{ type: "text", text: "No snapshots yet. Run take_snapshot, then come back tomorrow — rank movement needs two days to exist." }] };
        }
        if (files.length === 1) {
          return { content: [{ type: "text", text: `Only one snapshot so far (${files[0].replace(".json", "")}). Rank movement needs a second one from a different day. The GitHub Action takes one daily.` }] };
        }

        const current = newestSnapshot()!;
        const since = (a.since as number) ?? 7;
        const older = snapshotNDaysAgo(since);
        if (!older) return { content: [{ type: "text", text: "Could not read an older snapshot to compare against." }] };

        let ids = cfg.trackedTags;
        if (a.tags !== undefined) {
          const r = await resolveTags(String(a.tags));
          if (r.ids.length) ids = r.ids;
        }
        ids = ids.filter((i) => current.snap.categories[String(i)]);
        if (!ids.length) {
          const have = Object.values(current.snap.categories).map((c) => c.tagName).join(", ");
          return { content: [{ type: "text", text: `Those tags aren't in the snapshot history. Snapshots currently cover: ${have || "(nothing)"}. Use set_categories to change what's tracked.` }] };
        }

        const kind = String(a.kind ?? "risers").toLowerCase();
        const limit = (a.limit as number) ?? 15;
        const moves = diffSnapshots(current.snap, older.snap, ids);

        const risers = moves.filter((m) => m.status === "rising" && significant(m)).sort((x, y) => y.delta! - x.delta!);
        const fallers = moves.filter((m) => m.status === "falling" && significant(m)).sort((x, y) => x.delta! - y.delta!);
        const newcomers = moves.filter((m) => m.status === "new").sort((x, y) => x.rank - y.rank);

        const gap = Math.round((Date.parse(current.snap.takenAt) - Date.parse(older.snap.takenAt)) / 86400000);
        const lines = [
          `WISHLIST MOVEMENT — last ${gap} day${gap === 1 ? "" : "s"}`,
          `${older.snap.takenAt.slice(0, 10)} → ${current.snap.takenAt.slice(0, 10)}`,
          `Categories: ${ids.map((i) => tagName(null, i) === String(i) ? current.snap.categories[String(i)].tagName : String(i)).join(", ")}`,
          "",
        ];

        const render = (m: Move, tag: string) => {
          const d = daysUntil(m.releaseDateISO);
          const when = m.releaseDateRaw || "TBA";
          const soon = d !== null && d >= 0 && d <= 30 ? " [SOON]" : "";
          const delta = m.delta === null ? "" : (m.delta > 0 ? `+${m.delta}` : String(m.delta));
          const movement = m.prevRank === null ? `entered at #${m.rank}` : `#${m.prevRank} → #${m.rank}`;
          return `${pad(tag, 12)}${pad(delta, 6)}${pad(m.name, 40)}${pad(movement, 18)}${when}${soon}`;
        };

        let any = false;
        if (kind === "risers" || kind === "all") {
          lines.push("CLIMBING");
          if (risers.length) { risers.slice(0, limit).forEach((m) => lines.push(render(m, `[RISING] ${m.tagName}`.slice(0, 11)))); any = true; }
          else lines.push("  (no significant climbers)");
          lines.push("");
        }
        if (kind === "fallers" || kind === "all") {
          lines.push("SLIDING");
          if (fallers.length) { fallers.slice(0, limit).forEach((m) => lines.push(render(m, `[FALLING]`))); any = true; }
          else lines.push("  (no significant fallers)");
          lines.push("");
        }
        if (kind === "new" || kind === "all") {
          lines.push("NEW TO THE CHART");
          if (newcomers.length) { newcomers.slice(0, limit).forEach((m) => lines.push(render(m, `[NEW]`))); any = true; }
          else lines.push("  (nothing new)");
          lines.push("");
        }
        if (!any) lines.push("Nothing moved enough to be worth reporting over this window. Try a longer `since`.");
        lines.push(`Full chart: ${cfg.siteUrl}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "get_game": {
        let appid = a.appid as number | undefined;
        if (!appid && a.name !== undefined) {
          const needle = String(a.name).toLowerCase();
          const current = newestSnapshot();
          outer: for (const cat of Object.values(current?.snap.categories ?? {})) {
            for (const r of cat.ranked) {
              if (r.name.toLowerCase().includes(needle)) { appid = r.appid; break outer; }
            }
          }
          if (!appid) {
            const res = await searchUpcoming([], "popularcomingsoon", 100, cfg.allowAdult);
            const hit = res.rows.find((r) => r.name.toLowerCase().includes(needle));
            if (hit) appid = hit.appid;
          }
          if (!appid) return { content: [{ type: "text", text: `Couldn't find a game matching "${a.name}". Try the app ID from its Steam URL.` }] };
        }
        if (!appid) return { content: [{ type: "text", text: "Give me an appid or a name." }] };

        const g = await fetchGame(appid, cfg);
        if (!g) return { content: [{ type: "text", text: `Steam returned nothing for app ${appid}. It may be delisted or region-locked.` }] };

        const lines = [
          g.name.toUpperCase(),
          "",
          `App ID:        ${g.appid}`,
          `Release:       ${g.releaseDateRaw || "TBA"}${g.comingSoon ? "  (unreleased)" : ""}`,
          `Price:         ${g.priceText ?? "unannounced"}`,
          `Developer:     ${g.developers.join(", ") || "unknown"}`,
          `Publisher:     ${g.publishers.join(", ") || "unknown"}`,
          `Genres:        ${g.genres.join(", ") || "unknown"}`,
          "",
        ];
        if (g.shortDescription) lines.push(g.shortDescription, "");

        if (g.comingSoon) {
          lines.push("PRE-RELEASE — no player counts or reviews exist yet.");
          // Substitute the one signal that does exist for unreleased games.
          const current = newestSnapshot();
          const older = snapshotNDaysAgo(7);
          const found: string[] = [];
          for (const [id, cat] of Object.entries(current?.snap.categories ?? {})) {
            const row = cat.ranked.find((r) => r.appid === appid);
            if (!row) continue;
            const prev = older?.snap.categories[id]?.ranked.find((r) => r.appid === appid);
            const delta = prev ? prev.rank - row.rank : null;
            const move = delta === null ? "no history yet" : delta === 0 ? "unchanged" : `${delta > 0 ? "+" : ""}${delta} vs a week ago (#${prev!.rank})`;
            found.push(`  ${pad(cat.tagName, 18)}#${pad(String(row.rank), 6)}${move}`);
          }
          if (found.length) lines.push("", "Wishlist rank in tracked categories:", ...found);
          else lines.push("", "Not in any tracked category's top list.");
        } else {
          if (g.reviews) {
            const pct = Math.round((g.reviews.positive / g.reviews.total) * 100);
            lines.push(`Reviews:       ${g.reviews.scoreDesc} — ${pct}% of ${g.reviews.total.toLocaleString()}`);
          } else {
            lines.push("Reviews:       none yet");
          }
          lines.push(`Playing now:   ${g.playerCount === null ? "unavailable" : g.playerCount.toLocaleString()}`);
        }

        if (g.steamSpy) {
          lines.push("", `Owners est.:   ${g.steamSpy.owners || "unknown"}  (SteamSpy)`);
          if (g.steamSpy.topTags.length) lines.push(`Top tags:      ${g.steamSpy.topTags.join(", ")}`);
        }
        lines.push("", `https://store.steampowered.com/app/${g.appid}/`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "take_snapshot": {
        let ids = cfg.trackedTags;
        if (a.tags !== undefined) {
          const r = await resolveTags(String(a.tags));
          if (r.ids.length) ids = r.ids;
        }
        if (!ids.length) return { content: [{ type: "text", text: "No tags tracked. Run set_categories first." }] };

        const before = snapshotFiles().length;
        const { snap, warnings } = await takeSnapshot(cfg, ids);
        const total = Object.values(snap.categories).reduce((n, c) => n + c.ranked.length, 0);

        if (total === 0) {
          return { content: [{ type: "text", text: ["SNAPSHOT FAILED — 0 games captured, nothing saved to history.", ...warnings].join("\n") }] };
        }

        pruneSnapshots();
        generateSiteData(cfg);

        const lines = [
          `SNAPSHOT SAVED — ${Object.keys(snap.categories).length} categories, ${total} games`,
          `History: ${snapshotFiles().length} snapshots (was ${before})`,
        ];
        for (const w of warnings) lines.push(w);

        if (a.push !== false) lines.push("", gitPush(`Snapshot ${snap.takenAt.slice(0, 10)}`));
        lines.push("", cfg.siteUrl);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err}` }] };
  }
});

// ── Entry ──────────────────────────────────────────────────────────────────

if (CLI_MODE) {
  // What the GitHub Action runs. Exits non-zero on a total failure so a
  // broken parser fails the workflow instead of committing an empty snapshot.
  (async () => {
    const cfg = loadConfig();
    applyThrottleConfig(cfg);
    if (!cfg.trackedTags.length) { log("No tracked tags in config.json."); process.exit(1); }

    const { snap, warnings } = await takeSnapshot(cfg, cfg.trackedTags);
    const total = Object.values(snap.categories).reduce((n, c) => n + c.ranked.length, 0);
    warnings.forEach(log);

    if (total === 0) {
      log("FAILED - 0 games captured. Not committing an empty snapshot.");
      try { fs.unlinkSync(path.join(SNAPSHOT_DIR, `${snap.takenAt.slice(0, 10)}.json`)); } catch {}
      process.exit(1);
    }

    pruneSnapshots();
    generateSiteData(cfg);
    log(`Done - ${total} games across ${Object.keys(snap.categories).length} categories.`);
    process.exit(0);
  })();
} else {
  const transport = new StdioServerTransport();
  server.connect(transport);
}
