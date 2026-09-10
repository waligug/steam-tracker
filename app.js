// Reads the JSON the snapshot job commits. No fetching from Steam here — the
// page and the MCP server share one data layer so they can never disagree.

const state = { upcoming: null, trending: null, meta: null, view: "rising", tag: "" };

const $ = (sel) => document.querySelector(sel);
const main = $("#main");

async function loadJSON(name) {
  try {
    const res = await fetch(`data/site/${name}.json?t=${Date.now()}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function steamUrl(appid) {
  return `https://store.steampowered.com/app/${appid}/`;
}

// ── Sparkline ────────────────────────────────────────────────────────────
// Rank 1 is best, so the y-axis is inverted: a line going up means climbing.

function sparkPath(series, w, h, padY) {
  if (!series || series.length < 2) return null;
  const ranks = series.map((p) => p.rank);
  const min = Math.min(...ranks), max = Math.max(...ranks);
  const span = max - min || 1;
  const stepX = w / (series.length - 1);
  return series
    .map((p, i) => {
      const x = i * stepX;
      const y = padY + ((p.rank - min) / span) * (h - padY * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function sparkSVG(series, delta) {
  const d = sparkPath(series, 72, 24, 3);
  if (!d) return `<svg class="spark" viewBox="0 0 72 24" aria-hidden="true"></svg>`;
  const cls = delta > 0 ? "up" : delta < 0 ? "down" : "";
  return `<svg class="spark" viewBox="0 0 72 24" aria-hidden="true"><path class="${cls}" d="${d}"/></svg>`;
}

// ── Rows ─────────────────────────────────────────────────────────────────

function chip(g) {
  if (g.status === "new" || (g.delta === null && g.prevRank === null && g.status === "new"))
    return `<span class="chip new">NEW</span>`;
  if (g.delta === null || g.delta === undefined) return `<span class="chip flat">—</span>`;
  if (g.delta === 0) return `<span class="chip flat">0</span>`;
  const cls = g.delta > 0 ? "up" : "down";
  const sign = g.delta > 0 ? "▲" : "▼";
  return `<span class="chip ${cls}">${sign}${Math.abs(g.delta)}</span>`;
}

function rowHTML(g, opts = {}) {
  const rank = opts.showRank && g.rank ? `<span class="rank">#${g.rank}</span>` : "";
  const cap = g.capsule
    ? `<img class="cap" src="${esc(g.capsule)}" alt="" loading="lazy">`
    : `<span class="cap ph"></span>`;
  const tags = (g.tags || (g.tagName ? [g.tagName] : [])).join(" · ");
  return `<div class="row" data-appid="${g.appid}" tabindex="0">
    ${g.pinned ? '<span class="pin">★</span>' : ""}
    ${cap}
    <div class="meta">
      <div class="name">${esc(g.name)}</div>
      <div class="tags">${esc(tags)}</div>
    </div>
    ${sparkSVG(g.series, g.delta ?? 0)}
    ${rank}
    ${chip(g)}
    <div class="when">${esc(g.releaseDateRaw || "TBA")}</div>
    <div class="price">${esc(g.priceText || "")}</div>
  </div>`;
}

function section(title, count, rowsHTML, emptyMsg) {
  return `<div class="section-head"><h2>${esc(title)}</h2><span class="count">${count}</span></div>`
    + (rowsHTML || `<div class="empty">${esc(emptyMsg)}</div>`);
}

function matchesTag(g) {
  if (!state.tag) return true;
  if (g.tags) return g.tags.includes(state.tag);
  return g.tagName === state.tag;
}

// ── Views ────────────────────────────────────────────────────────────────

function renderRising() {
  const t = state.trending;
  const snaps = state.meta?.snapshotCount ?? 0;

  if (!t || snaps < 2) {
    main.innerHTML = `<div class="notice">
      <strong>Not enough history yet.</strong><br>
      Wishlist movement needs at least two snapshots taken on different days.
      There ${snaps === 1 ? "is 1 snapshot" : `are ${snaps} snapshots`} so far — the daily job will fill this in.
      <br><br>In the meantime, the <a href="#" data-goto="calendar">Calendar</a> tab shows what's coming.
    </div>`;
    return;
  }

  const risers = (t.risers || []).filter(matchesTag);
  const newcomers = (t.newcomers || []).filter(matchesTag);
  const fallers = (t.fallers || []).filter(matchesTag);
  const compared = t.comparedTo ? new Date(t.comparedTo).toLocaleDateString() : "the last snapshot";

  main.innerHTML =
    `<p class="sub">Movement since ${esc(compared)}. Higher = more wishlisted.</p>` +
    section("Climbing", risers.length, risers.map((g) => rowHTML(g, { showRank: true })).join(""),
      "Nothing moved significantly in this window.") +
    section("New to the chart", newcomers.length, newcomers.map((g) => rowHTML(g, { showRank: true })).join(""),
      "No new entries.") +
    section("Sliding", fallers.length, fallers.map((g) => rowHTML(g, { showRank: true })).join(""),
      "Nothing slid significantly.");
}

function renderCalendar() {
  const u = state.upcoming;
  if (!u || !u.games?.length) {
    main.innerHTML = `<div class="empty">No snapshot data yet.</div>`;
    return;
  }
  const games = u.games.filter(matchesTag);
  let html = "";
  for (const bucket of u.buckets) {
    const inBucket = games.filter((g) => g.bucket === bucket);
    if (!inBucket.length) continue;
    html += section(bucket, inBucket.length, inBucket.map((g) => rowHTML(g)).join(""), "");
  }
  main.innerHTML = html || `<div class="empty">Nothing matches that filter.</div>`;
}

function render() {
  document.querySelectorAll(".tab").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === state.view));
  if (state.view === "rising") renderRising();
  else renderCalendar();
}

// ── Drawer ───────────────────────────────────────────────────────────────

function findGame(appid) {
  const pools = [
    state.upcoming?.games ?? [],
    state.trending?.risers ?? [],
    state.trending?.newcomers ?? [],
    state.trending?.fallers ?? [],
  ];
  for (const pool of pools) {
    const hit = pool.find((g) => String(g.appid) === String(appid));
    if (hit) return hit;
  }
  return null;
}

function bigSpark(series) {
  if (!series || series.length < 2) {
    return `<div class="empty" style="margin-top:6px">Only one data point so far — the history builds up daily.</div>`;
  }
  const w = 360, h = 90;
  const d = sparkPath(series, w, h, 10);
  const ranks = series.map((p) => p.rank);
  const min = Math.min(...ranks), max = Math.max(...ranks);
  const span = max - min || 1;
  const last = series[series.length - 1];
  const cx = w, cy = 10 + ((last.rank - min) / span) * (h - 20);
  return `<svg class="bigspark" viewBox="0 -4 ${w + 6} ${h + 8}" preserveAspectRatio="none">
    <path d="${d}"/><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3.5"/>
  </svg>
  <div class="tags">Best rank #${min} · worst #${max} · ${series.length} snapshots</div>`;
}

function openDrawer(appid) {
  const g = findGame(appid);
  if (!g) return;
  const tags = (g.tags || (g.tagName ? [g.tagName] : [])).join(", ");
  const rankLine = g.prevRank != null && g.rank != null
    ? `#${g.prevRank} → #${g.rank}`
    : g.rank != null ? `#${g.rank}` : g.bestRank != null ? `#${g.bestRank}` : "—";

  $("#drawerPanel").innerHTML = `
    <button class="close" data-close>Close</button>
    ${g.capsule ? `<img class="hero" src="${esc(g.capsule)}" alt="">` : ""}
    <h3>${esc(g.name)}</h3>
    <div class="tags">${esc(tags)}</div>
    <dl>
      <dt>Releases</dt><dd>${esc(g.releaseDateRaw || "TBA")}</dd>
      <dt>Price</dt><dd>${esc(g.priceText || "unannounced")}</dd>
      <dt>Wishlist rank</dt><dd>${esc(rankLine)}</dd>
      <dt>App ID</dt><dd>${esc(g.appid)}</dd>
    </dl>
    <div class="tags">Rank history (higher = climbing)</div>
    ${bigSpark(g.series)}
    <p style="margin-top:18px"><a href="${steamUrl(g.appid)}" target="_blank" rel="noopener">Open on Steam →</a></p>
    <p class="tags">Unreleased games have no reviews or player counts — Steam doesn't publish wishlist totals either, so rank movement is the only pre-release signal.</p>
  `;
  $("#drawer").hidden = false;
}

function closeDrawer() { $("#drawer").hidden = true; }

// ── Wiring ───────────────────────────────────────────────────────────────

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) { closeDrawer(); return; }
  const goto = e.target.closest("[data-goto]");
  if (goto) { e.preventDefault(); state.view = goto.dataset.goto; render(); return; }
  const tab = e.target.closest(".tab");
  if (tab) { state.view = tab.dataset.view; render(); return; }
  const row = e.target.closest(".row");
  if (row) openDrawer(row.dataset.appid);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDrawer();
  if (e.key === "Enter" && e.target.classList?.contains("row")) openDrawer(e.target.dataset.appid);
});

$("#tagFilter").addEventListener("change", (e) => { state.tag = e.target.value; render(); });

(async function init() {
  const [upcoming, trending, meta] = await Promise.all([
    loadJSON("upcoming"), loadJSON("trending"), loadJSON("meta"),
  ]);
  state.upcoming = upcoming; state.trending = trending; state.meta = meta;

  if (!upcoming && !meta) {
    main.innerHTML = `<div class="empty">No data published yet. The daily snapshot job hasn't run.</div>`;
    $("#subtitle").textContent = "No data yet";
    return;
  }

  const tags = meta?.trackedTags ?? [];
  $("#subtitle").textContent = tags.length
    ? `${meta.gameCount ?? upcoming?.games?.length ?? 0} games tracked across ${tags.join(", ")}`
    : "Tracking upcoming Steam releases";
  $("#stamp").innerHTML = meta?.lastUpdated
    ? `Updated ${new Date(meta.lastUpdated).toLocaleString()}<br>${meta.snapshotCount} snapshot${meta.snapshotCount === 1 ? "" : "s"} of history`
    : "";

  const sel = $("#tagFilter");
  for (const t of tags) {
    const opt = document.createElement("option");
    opt.value = t; opt.textContent = t;
    sel.appendChild(opt);
  }

  render();
})();
