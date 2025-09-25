// static/app.js
// Optional: set window.API_BASE (e.g., via inline script or ?api=) to point to your dedicated stock server.
// Fallback: same-origin.
const API_BASE = (function(){
    try {
        if (typeof window !== 'undefined') {
            if (window.API_BASE) return String(window.API_BASE).replace(/\/$/, '');
            const url = new URL(window.location.href);
            const qp = url.searchParams.get('api');
            if (qp) return String(qp).replace(/\/$/, '');
        }
    } catch {}
    return '';
})();
const els = {
    feed: document.getElementById("feed"),
    searchBox: document.getElementById("searchBox"),
    runAllBtn: document.getElementById("runAllBtn"),
    // resetOrderBtn will be injected next to runAllBtn
    fabAdd: document.getElementById("fabAdd"),
    // modal
    postDlg: document.getElementById("postDlg"),
    dlgTitle: document.getElementById("dlgTitle"),
    pTitle: document.getElementById("pTitle"),
    pTickers: document.getElementById("pTickers"),
    pDesc: document.getElementById("pDesc"),
    pPurchases: document.getElementById("pPurchases"),
    pOptions: document.getElementById("pOptions"),
    cancelDlg: document.getElementById("cancelDlg"),
    saveDlg: document.getElementById("saveDlg"),
    // detail
    detailDlg: document.getElementById("detailDlg"),
    dTitle: document.getElementById("dTitle"),
    dContent: document.getElementById("dContent"),
    dAnalyze: document.getElementById("dAnalyze"),
    dEdit: document.getElementById("dEdit"),
    dDelete: document.getElementById("dDelete"),
    dClose: document.getElementById("dClose"),
    serverState: document.getElementById("serverState"),
};

let POSTS = [];
let HAS_CUSTOM_ORDER = (function(){
    try { return localStorage.getItem('feed:customOrder') === '1'; } catch { return false; }
})(); // once user reorders, respect the saved order
let editingId = null;
let currentDetailId = null;
let STREAMS = new Map(); // pid -> EventSource
let REFRESHING = new Set(); // dedupe snapshot refresh calls
let LAST_REFRESH = new Map(); // pid -> timestamp ms

// --- utils
const $ = (sel, root = document) => root.querySelector(sel);
const fmtMoney = (x) => (x == null || isNaN(x)) ? "" : `$${Number(x).toFixed(2)}`;
const fmtPct = (x) => (x == null || isNaN(x)) ? "" : `${(x).toFixed(2)}%`;
const toList = (s) => (s || "").split(",").map(t => t.trim()).filter(Boolean);
function parsePurchases(str) {
    const m = {};
    toList(str).forEach(pair => {
        const [k, v] = pair.split("=").map(z => z.trim());
        if (k && v && !isNaN(parseFloat(v))) m[k.toUpperCase()] = parseFloat(v);
    });
    return m;
}
function optionsFromJson(text) {
    if (!text || !text.trim()) return {};
    try { return JSON.parse(text); } catch { return {}; }
}
function classBySuggestion(s) {
    const v = String(s || "").toLowerCase();
    if (v === "buy") return "buy";
    if (v === "sell") return "sell";
    return "hold";
}

// Simple toast helper
function showToast(message, opts = {}) {
    const div = document.createElement('div');
    div.className = 'toast';
    div.textContent = String(message || '');
    document.body.appendChild(div);
    // Force reflow to enable animation class
    void div.offsetWidth; 
    div.classList.add('show');
    const ttl = Math.max(1200, opts.duration || 1800);
    setTimeout(() => {
        div.classList.remove('show');
        setTimeout(() => { div.remove(); }, 250);
    }, ttl);
}

// --- API
async function api(path, opts) {
    const url = /^https?:/i.test(path) ? path : (API_BASE + path);
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
}

async function loadConfig() {
    try {
        const j = await api("/api/config");
        els.serverState.textContent = j.server ? "server: online" : "server: offline";
    } catch {
        els.serverState.textContent = "server: unknown";
    }
}

async function loadPosts() {
    POSTS = await api("/api/stocks");
    // Detect if server order differs from time-sorted order; if so, treat as custom order
    try {
        const byTime = POSTS.slice().sort((a, b) => (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || ""));
        const same = (POSTS.length === byTime.length) && POSTS.every((p, i) => p.id === byTime[i].id);
        if (!same) HAS_CUSTOM_ORDER = true;
    } catch {}
    // if server returned posts in a specific order, respect it; HAS_CUSTOM_ORDER persists during session
    renderFeed();
}

async function savePost() {
    const body = {
        title: els.pTitle.value.trim() || "Untitled",
        tickers: toList(els.pTickers.value),
        description: els.pDesc.value.trim(),
        purchases: parsePurchases(els.pPurchases.value),
        options: optionsFromJson(els.pOptions.value),
    };
    const wasEditingId = editingId;
    let saved;
    if (!editingId) {
        saved = await api("/api/stocks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } else {
        saved = await api(`/api/stocks/${encodeURIComponent(editingId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    }
    els.postDlg.close();
    editingId = null;
    await loadPosts();
    // If the detail dialog is open for this post, re-open it to reflect new tickers immediately
    if (currentDetailId && wasEditingId && currentDetailId === wasEditingId) {
        openDetail(wasEditingId);
    }
}

async function runAnalysis(id) {
    const res = await api(`/api/analyze/${encodeURIComponent(id)}`, { method: "POST" });
    const idx = POSTS.findIndex(p => p.id === id);
    if (idx >= 0) POSTS[idx] = res;
    renderFeed();
    openDetail(id);
}

function runAnalysisStream(id) {
    // Close existing stream for this id
    stopAnalysisStream(id);
    const url = (API_BASE + `/api/analyze-stream/${encodeURIComponent(id)}`);
    const es = new EventSource(url);
    STREAMS.set(id, es);

    const logElm = () => document.getElementById('dReport');
    const snapshotHost = () => document.getElementById('dSnapshot');

    function appendLog(line) {
        const pre = logElm();
        if (!pre) return;
        pre.textContent += (pre.textContent ? "\n" : "") + line;
        pre.scrollTop = pre.scrollHeight;
    }

    es.onmessage = (e) => {
        try {
            const data = JSON.parse(e.data || '{}');
            if (!data || currentDetailId !== id) return; // only update visible entry
            if (data.type === 'start') {
                // Do not clear existing report; just note the new stream start
                appendLog('Streaming started…');
            } else if (data.type === 'log') {
                appendLog(String(data.message || ''));
            } else if (data.type === 'ticker-done') {
                // Update local POSTS cache
                const idx = POSTS.findIndex(p => p.id === id);
                if (idx >= 0) {
                    const p = POSTS[idx];
                    p.analysis = p.analysis || { per_ticker: {} };
                    p.analysis.per_ticker = p.analysis.per_ticker || {};
                    if (data.ticker) {
                        p.analysis.per_ticker[data.ticker] = { suggestion: data.suggestion || 'Hold', signals: p.analysis.per_ticker[data.ticker]?.signals || {} };
                        p.snapshot = p.snapshot || {};
                        p.snapshot[data.ticker] = { current: data.current, pct: data.pct };
                        p.updatedAt = new Date().toISOString();
                    }
                    // Update snapshot section live
                    if (snapshotHost()) { snapshotHost().innerHTML = renderSnapshotTable(p); }
                    // Update feed row highlighting and values
                    renderFeed();
                }
            } else if (data.type === 'ticker-error') {
                appendLog(`Error for ${data.ticker}: ${data.error}`);
            } else if (data.type === 'done') {
                appendLog('Streaming complete.');
                // Refresh posts to get final summary
                loadPosts().then(async () => {
                    // Ensure summary exists even if upstream didn't populate
                    try { await api(`/api/summarize/${encodeURIComponent(id)}`); } catch {}
                    if (currentDetailId === id) openDetail(id);
                });
                stopAnalysisStream(id);
            } else if (data.type === 'error') {
                appendLog(`Error: ${data.message || ''}`);
                stopAnalysisStream(id);
            }
        } catch (err) {
            console.error('SSE parse error', err);
        }
    };

    es.onerror = () => {
        appendLog('Stream error.');
        stopAnalysisStream(id);
    };
}

function stopAnalysisStream(id) {
    const es = STREAMS.get(id);
    if (es) { try { es.close(); } catch {} STREAMS.delete(id); }
}

// --- UI
function renderFeed() {
    const q = (els.searchBox.value || "").toLowerCase().trim();
    let filtered = POSTS.filter(p => {
        if (!q) return true;
        const hay = [p.title || "", p.description || "", ...(p.tickers || [])].join(" ").toLowerCase();
        return hay.includes(q);
    });
    // Only auto-sort by timestamps if the user hasn't created a custom order yet
    if (!HAS_CUSTOM_ORDER) {
        filtered = filtered.slice().sort((a, b) => (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || ""));
    }

    if (!filtered.length) {
        els.feed.innerHTML = `<div class="empty-state">
          <div class="muted">No posts yet or failed to load data. Click the + button to add a post, or refresh if the server just started.</div>
        </div>`;
        return;
    }

    const table = document.createElement("table");
    table.className = "table";
        table.innerHTML = `
    <thead>
      <tr>
                <th style="width:24px"></th>
        <th style="width:28%">Title</th>
        <th style="width:24%">Tickers</th>
        <th style="width:16%;text-align:right">Purchase Price</th>
        <th style="width:16%;text-align:right">Current Price</th>
        <th style="width:10%;text-align:right">% Change</th>
        <th style="width:6%">Suggestion</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
    const tbody = table.querySelector("tbody");

    for (const p of filtered) {
        const primary = (p.tickers || [])[0] || "";
        const snap = (p.snapshot || {})[primary] || {};
        const purchase = (p.purchases || {})[primary];
        const suggestion = rowSuggestion(p, primary);

        const tr = document.createElement("tr");
        tr.className = `rowAccent ${classBySuggestion(suggestion)}`;
        tr.setAttribute('data-id', p.id);
        tr.innerHTML = `
      <td class="drag-cell"><span class="drag-handle" title="Drag to reorder" aria-label="Drag to reorder" draggable="false">⋮⋮</span></td>
      <td>
        <div style="font-weight:600">${escapeHtml(p.title || "Untitled")}</div>
        <div class="muted">${p.description ? escapeHtml(p.description.slice(0, 100)) : ""}</div>
      </td>
      <td>${(p.tickers || []).map(t => `<span class="tickerpill">${t}</span>`).join("")}</td>
      <td style="text-align:right">${fmtMoney(purchase)}</td>
      <td style="text-align:right">${fmtMoney(snap.current)}</td>
      <td style="text-align:right">${snap.pct == null ? "" : fmtPct(snap.pct)}</td>
      <td><span class="badge suggestion ${classBySuggestion(suggestion)}">${suggestion || ""}</span></td>
    `;
        // Avoid triggering click while dragging
        let dragStarted = false;
        const handle = tr.querySelector('.drag-handle');
        if (handle) {
            handle.setAttribute('draggable', 'true');
            handle.addEventListener('dragstart', (e) => {
                dragStarted = true;
                tr.classList.add('dragging');
                // data
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', p.id);
                // custom drag image (ghost)
                try {
                    const ghost = document.createElement('div');
                    ghost.className = 'drag-ghost';
                    ghost.textContent = p.title || 'Untitled';
                    document.body.appendChild(ghost);
                    e.dataTransfer.setDragImage(ghost, 10, 10);
                    window._dragGhost = ghost;
                } catch {}
            });
            handle.addEventListener('dragend', () => {
                dragStarted = false;
                tr.classList.remove('dragging');
                tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drop-before','drop-after'));
                if (window._dragGhost) { try { window._dragGhost.remove(); } catch {} window._dragGhost = null; }
            });
        }
        // Row-level delegates for visual indicator and live reflow while dragging
        tr.addEventListener('dragover', (e) => {
            e.preventDefault();
            const draggingRow = tbody.querySelector('tr.dragging');
            if (!draggingRow || draggingRow === tr) return;
            // Clear previous indicators
            tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drop-before','drop-after'));
            const rect = tr.getBoundingClientRect();
            const before = (e.clientY - rect.top) < rect.height / 2;
            if (before) {
                tr.classList.add('drop-before');
                tbody.insertBefore(draggingRow, tr);
            } else {
                tr.classList.add('drop-after');
                tbody.insertBefore(draggingRow, tr.nextSibling);
            }
        });
        tr.addEventListener('dragleave', () => tr.classList.remove('drop-before','drop-after'));
        tr.addEventListener('drop', async (e) => {
            e.preventDefault();
            tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drop-before','drop-after'));
            // Persist new order
            const newOrder = Array.from(tbody.querySelectorAll('tr')).map(r => r.getAttribute('data-id')).filter(Boolean);
            try {
                await api('/api/stocks/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order: newOrder }) });
                HAS_CUSTOM_ORDER = true;
                try { localStorage.setItem('feed:customOrder', '1'); } catch {}
                // Reflect local POSTS order immediately without reloading
                const byId = new Map(POSTS.map(x => [x.id, x]));
                POSTS = newOrder.map(id => byId.get(id)).filter(Boolean).concat(POSTS.filter(x => !newOrder.includes(x.id)));
                showToast('Order saved');
            } catch (err) {
                console.warn('Failed to save order', err);
            }
        });
        tr.addEventListener("click", (ev) => {
            if (dragStarted) return; // ignore click if it was a drag
            // ignore clicks on handle that might be slight
            if (ev.target && ev.target.closest('.drag-handle')) return;
            openDetail(p.id);
        });
        tbody.appendChild(tr);
    }

    els.feed.innerHTML = "";
    els.feed.appendChild(table);

    // Background-refresh current prices for visible rows, throttled
    const now = Date.now();
    const toRefresh = filtered.slice(0, 10); // cap to avoid flooding
    toRefresh.forEach((p, i) => {
        const last = LAST_REFRESH.get(p.id) || 0;
        if (now - last < 60000) return; // skip if refreshed in last 60s
        setTimeout(() => refreshSnapshot(p.id), i * 200);
    });
}

function rowSuggestion(p, primary) {
    const a = p.analysis || {};
    const pt = (a.per_ticker || {})[primary] || {};
    return pt.suggestion || "Hold";
}

function openNew() {
    editingId = null;
    els.dlgTitle.textContent = "New Post";
    els.pTitle.value = "";
    els.pTickers.value = "";
    els.pDesc.value = "";
    els.pPurchases.value = "";
    els.pOptions.value = "";
    els.postDlg.showModal();
}

function openEdit(p) {
    editingId = p.id;
    els.dlgTitle.textContent = "Edit Post";
    els.pTitle.value = p.title || "";
    els.pTickers.value = (p.tickers || []).join(", ");
    els.pDesc.value = p.description || "";
    const kv = Object.entries(p.purchases || {}).map(([k, v]) => `${k}=${v}`).join(", ");
    els.pPurchases.value = kv;
    els.pOptions.value = JSON.stringify(p.options || {}, null, 2);
    els.postDlg.showModal();
}

async function removePost(id) {
    if (!confirm("Delete this post?")) return;
    await api(`/api/stocks/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadPosts();
    els.detailDlg.close();
}

function openDetail(id) {
    currentDetailId = id;
    const p = POSTS.find(x => x.id === id);
    if (!p) return;

    els.dTitle.textContent = p.title || "Post";

    const tickers = p.tickers || [];
    const primary = tickers[0] || "";
    const report = (p.analysis && (p.analysis.report || p.analysis.summary))
        ? (p.analysis.report || p.analysis.summary)
        : (p.analysis ? "" : "(No analysis yet. Click “Run Analysis”.)");
    const summary = (p.analysis && typeof p.analysis.summary === 'string')
        ? p.analysis.summary
        : (p.analysis ? "" : "(No summary yet.)");

    const tabs = document.createElement("div");
    tabs.className = "inline";
    for (const t of tickers) {
        const b = document.createElement("button");
        b.textContent = t;
        b.addEventListener("click", () => loadChartInto(t));
        tabs.appendChild(b);
    }

    const chart = document.createElement("div");
    chart.className = "chartWrap";
            chart.innerHTML = `
            <div class="chartHead">
                <div class="inline"><strong>Price</strong> <span class="muted" id="cMeta"></span></div>
            </div>
            <div class="chartCanvasWrap">
                <canvas id="chartCanvas"></canvas>
                <div class="ctrl ctrl-top-left">
                    <button id="cZoomIn" class="ghost" title="Zoom in">＋</button>
                    <button id="cZoomOut" class="ghost" title="Zoom out">－</button>
                </div>
                <div class="ctrl ctrl-mid-left">
                    <button id="cLeft" class="ghost" title="Pan left">◀</button>
                </div>
                <div class="ctrl ctrl-mid-right">
                    <button id="cRight" class="ghost" title="Pan right">▶</button>
                </div>
            </div>
            <div class="chartFooter">
                <div class="footerControls">
                    <select id="cPeriod">
                        <option value="1wk">1W</option>
                        <option value="1mo">1M</option><option value="3mo">3M</option>
                        <option value="6mo" selected>6M</option><option value="1y">1Y</option>
                        <option value="2y">2Y</option><option value="5y">5Y</option>
                    </select>
                    <select id="cInterval">
                        <option value="1h">1H</option><option value="4h">4H</option>
                        <option value="1d" selected>1D</option><option value="1wk">1W</option><option value="1mo">1M</option>
                    </select>
                </div>
            </div>
        `;

        const info = document.createElement("div");
        info.innerHTML = `
        <h3>Summary</h3>
        <pre id="dSummary" class="pre-card" style="white-space:pre-wrap;margin-bottom:10px">${escapeHtml(summary)}</pre>
        <div class="inline" style="align-items:center; gap:8px; justify-content:space-between">
            <h3 style="margin:0">Report</h3>
            <button id="copyReportBtn" class="ghost" title="Copy report to clipboard">Copy</button>
        </div>
        <pre id="dReport" class="log" style="white-space:pre-wrap">${escapeHtml(report)}</pre>
    `;

        const meta = document.createElement("div");
        meta.innerHTML = `
        <h3>Snapshot</h3>
        <div id="dSnapshot">${renderSnapshotTable(p)}</div>
    `;

    const wrap = document.createElement("div");
    wrap.appendChild(tabs);
    wrap.appendChild(chart);
    wrap.appendChild(meta);
    wrap.appendChild(info);

    els.dContent.innerHTML = "";
    els.dContent.appendChild(wrap);

    const periodSel = $("#cPeriod", chart);
    const intervalSel = $("#cInterval", chart);
    periodSel.addEventListener("change", () => loadChartInto((window._activeTicker || primary)));
    intervalSel.addEventListener("change", () => {
        const v = intervalSel.value; const p = periodSel.value;
        if ((v === '1h' || v === '4h') && (p === '2y' || p === '5y')) {
            periodSel.value = '1y';
        }
        loadChartInto((window._activeTicker || primary));
    });

    loadChartInto(primary);
    els.detailDlg.showModal();

    // Prefer streaming analysis for live updates; fallback remains available if needed
    els.dAnalyze.onclick = () => runAnalysisStream(id);
    els.dEdit.onclick = () => openEdit(p);
    els.dDelete.onclick = () => removePost(id);

    // Immediately refresh current prices for this post without waiting for analysis
    refreshSnapshot(id);

    // Proactively compute summary based on existing analysis (handles partial runs or prior state)
    api(`/api/summarize/${encodeURIComponent(id)}`).then((res) => {
        const idx = POSTS.findIndex(p => p.id === id);
        if (idx >= 0) {
            POSTS[idx] = res;
            if (currentDetailId === id) {
                const pre = document.getElementById('dSummary');
                if (pre && res.analysis && typeof res.analysis.summary === 'string') {
                    pre.textContent = res.analysis.summary;
                }
            }
        }
    }).catch(() => {});

    // Wire copy button
    const copyBtn = document.getElementById('copyReportBtn');
    if (copyBtn) {
        copyBtn.onclick = async () => {
            const pre = document.getElementById('dReport');
            const text = pre ? pre.textContent : '';
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(text);
                } else {
                    // Fallback copy
                    const ta = document.createElement('textarea');
                    ta.value = text; document.body.appendChild(ta); ta.select();
                    document.execCommand('copy'); document.body.removeChild(ta);
                }
                copyBtn.textContent = 'Copied';
                setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
            } catch (e) {
                copyBtn.textContent = 'Copy failed';
                setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
            }
        };
    }
}

// Refresh only the snapshot (current prices) for a post without running analysis
async function refreshSnapshot(id) {
    if (REFRESHING.has(id)) return;
    const last = LAST_REFRESH.get(id) || 0;
    const now = Date.now();
    if (now - last < 10000) return; // hard throttle 10s per post
    REFRESHING.add(id);
    try {
        const res = await api(`/api/refresh-snapshot/${encodeURIComponent(id)}`);
        const idx = POSTS.findIndex(p => p.id === id);
        if (idx >= 0) {
            POSTS[idx].snapshot = res.snapshot || {};
            POSTS[idx].updatedAt = res.updatedAt || new Date().toISOString();
            // Update feed row values
            renderFeed();
            // If detail is open for this post, update the snapshot table live
            if (currentDetailId === id) {
                const host = document.getElementById('dSnapshot');
                if (host) host.innerHTML = renderSnapshotTable(POSTS[idx]);
                // Also update chart meta current price for the active ticker
                if (window._activeTicker) updateChartMeta(window._activeTicker);
            }
        }
        LAST_REFRESH.set(id, now);
    } catch (e) {
        // ignore errors; transient network/yfinance issues
        console.warn('refreshSnapshot failed', e);
    } finally {
        REFRESHING.delete(id);
    }
}

function renderSnapshotTable(p) {
    const rows = [];
    const sn = p.snapshot || {};
    const purchases = p.purchases || {};
    (p.tickers || []).forEach(t => {
        const s = sn[t] || {};
        rows.push(`
      <tr>
        <td>${t}</td>
        <td style="text-align:right">${fmtMoney(purchases[t])}</td>
        <td style="text-align:right">${fmtMoney(s.current)}</td>
        <td style="text-align:right">${s.pct == null ? "" : fmtPct(s.pct)}</td>
        <td style="text-align:center"><span class="badge suggestion ${classBySuggestion(rowSuggestion(p, t))}">${rowSuggestion(p, t)}</span></td>
      </tr>
    `);
    });
    return `
    <table class="table" style="margin-top:6px">
      <thead><tr><th>Ticker</th><th style="text-align:right">Purchase</th><th style="text-align:right">Current</th><th style="text-align:right">% Change</th><th>Suggestion</th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>
  `;
}

// Helpers for chart state persistence
function chartStateKey(ticker, period, interval) {
    return `chartState:v1:${ticker}:${period}:${interval}`;
}
function loadChartStateFromLS(ticker, period, interval, total) {
    try {
        const raw = localStorage.getItem(chartStateKey(ticker, period, interval));
        if (!raw) return null;
        const s = JSON.parse(raw);
        if (!s || typeof s.start !== 'number' || typeof s.end !== 'number') return null;
        // clamp to current total
        const start = Math.max(0, Math.min(s.start, Math.max(0, total - 1)));
        const end = Math.max(start + 1, Math.min(s.end, total));
        return { ...s, start, end };
    } catch { return null; }
}
function saveChartStateToLS(ticker, period, interval, state) {
    try {
        const payload = { start: state.start, end: state.end };
        localStorage.setItem(chartStateKey(ticker, period, interval), JSON.stringify(payload));
    } catch {}
}

// Lightweight line chart with grid, axis labels, and optional hover marker
function drawLineChart(canvas, xs, ys, opts = {}) {
    const dpr = (window.devicePixelRatio || 1);
    const ctx = canvas.getContext("2d");
    const cssW = canvas.clientWidth || canvas.offsetWidth || 300;
    const w = canvas.width = Math.max(100, cssW) * dpr;
    const h = canvas.height = 240 * dpr;
    ctx.clearRect(0, 0, w, h);

    if (!xs.length || !ys.length) {
        ctx.fillStyle = "#9ca3af";
        ctx.font = `${12*dpr}px sans-serif`;
        ctx.fillText("No data", 12*dpr, 20*dpr);
        return;
    }

    // Viewport support: if the array passed is a slice already, just use it
    const N = ys.length;
    const padL = 46 * dpr; // left padding for y labels
    const padR = 10 * dpr, padT = 10 * dpr, padB = 22 * dpr; // extra bottom for x labels
    const plotW = Math.max(1, w - padL - padR);
    const plotH = Math.max(1, h - padT - padB);
    const min = Math.min(...ys), max = Math.max(...ys);
    const range = Math.max(1e-9, max - min);
    const scaleX = (i) => padL + plotW * (i / Math.max(1, (N - 1)));
    const scaleY = (v) => padT + plotH * (1 - (v - min) / range);

    // Grid
    ctx.strokeStyle = "#1f2937"; ctx.lineWidth = 1 * dpr;
    ctx.globalAlpha = 0.7;
    const hLines = 4;
    // responsive vLines: fewer on narrow widths
    const vLines = (plotW/dpr < 360) ? 3 : (plotW/dpr < 640) ? 4 : 6;
    ctx.beginPath();
    for (let i = 0; i <= hLines; i++) {
        const y = padT + (plotH * i / hLines);
        ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y);
    }
    for (let i = 0; i <= vLines; i++) {
        const x = padL + (plotW * i / vLines);
        ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Y labels
    ctx.fillStyle = "#9ca3af"; ctx.font = `${Math.max(9, 11)*dpr}px sans-serif`;
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let i = 0; i <= hLines; i++) {
        const v = max - range * (i / hLines);
        const y = padT + (plotH * i / hLines);
        let label = "";
        if (isFinite(v)) {
            const abs = Math.abs(v);
            if (abs >= 1e9) label = `$${(v/1e9).toFixed(2)}B`;
            else if (abs >= 1e6) label = `$${(v/1e6).toFixed(2)}M`;
            else if (abs >= 1e3) label = `$${(v/1e3).toFixed(0)}K`;
            else label = `$${v.toFixed(2)}`;
        }
        ctx.fillText(label, padL - 6 * dpr, y);
    }

    // X labels (time)
    ctx.fillStyle = "#9ca3af"; ctx.textAlign = "center"; ctx.textBaseline = "top";
    const firstTs = xs[0]; const lastTs = xs[xs.length - 1];
    const toDate = (t) => {
        let n = t;
        if (typeof n === 'string') { const m = Date.parse(n); if (!isNaN(m)) return new Date(m); }
        if (typeof n === 'number') { if (n > 1e12) return new Date(n); return new Date(n * 1000); }
        return null;
    };
    const d0 = toDate(firstTs), d1 = toDate(lastTs);
    let fmt = (d) => d ? `${d.getMonth()+1}/${d.getDate()}` : '';
    if (d0 && d1) {
        const spanDays = Math.max(1, Math.round((d1 - d0) / 86400000));
        if (spanDays > 365) fmt = (d) => d ? `${d.getFullYear()}` : '';
        else if (spanDays > 60) fmt = (d) => d ? `${d.toLocaleString(undefined,{month:'short'})} ${String(d.getFullYear()).slice(-2)}` : '';
        else fmt = (d) => d ? `${d.getMonth()+1}/${d.getDate()}` : '';
    }
    for (let i = 0; i <= vLines; i++) {
        const idx = Math.round((i / vLines) * (N - 1));
        const x = scaleX(idx);
        const d = toDate(xs[idx]);
        const label = fmt(d);
        if (label) ctx.fillText(label, x, padT + plotH + 4 * dpr);
    }

    // Line
    ctx.lineWidth = 2 * dpr; ctx.strokeStyle = "#60a5fa";
    ctx.beginPath();
    ctx.moveTo(scaleX(0), scaleY(ys[0]));
    for (let i = 1; i < ys.length; i++) { ctx.lineTo(scaleX(i), scaleY(ys[i])); }
    ctx.stroke();

    // Hover marker overlay
    if (opts.hoverIdx != null && opts.hoverIdx >= 0 && opts.hoverIdx < N) {
        const i = opts.hoverIdx;
        const x = scaleX(i);
        const y = scaleY(ys[i]);
        // vertical line
        ctx.strokeStyle = "#93c5fd"; ctx.lineWidth = 1 * dpr; ctx.globalAlpha = 0.9;
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
        ctx.globalAlpha = 1;
        // price tag with dollar
        const label = `$${isFinite(ys[i]) ? Number(ys[i]).toFixed(2) : ''}`;
        ctx.font = `${11*dpr}px sans-serif`;
        const tw = ctx.measureText(label).width;
        const bx = Math.min(Math.max(x - tw/2 - 6*dpr, padL), padL + plotW - (tw + 12*dpr));
        const by = Math.max(padT + 2*dpr, Math.min(y - 14*dpr, padT + plotH - 18*dpr));
        ctx.fillStyle = "#111827"; ctx.strokeStyle = "#374151";
        ctx.lineWidth = 1 * dpr; ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(bx, by, tw + 12*dpr, 16*dpr, 4*dpr) : ctx.rect(bx, by, tw + 12*dpr, 16*dpr);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = "#e5e7eb"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(label, bx + 6*dpr, by + 8*dpr);
    }
}

async function loadChartInto(ticker) {
    window._activeTicker = ticker;
    const chartHost = document.querySelector(".chartWrap");
    if (!chartHost) return;
    const period = document.getElementById("cPeriod").value;
    const interval = document.getElementById("cInterval").value;
    updateChartMeta(ticker);
    const canvas = document.getElementById("chartCanvas");
    try {
        const data = await api(`/api/chart?ticker=${encodeURIComponent(ticker)}&period=${encodeURIComponent(period)}&interval=${encodeURIComponent(interval)}`);
        const xs = data.timestamps || [], ys = data.closes || [];
        // Store chart state per ticker+period+interval to enable pan/zoom and persistence
        if (!window.__chartStates) window.__chartStates = new Map();
        const key = chartStateKey(ticker, period, interval);
        const full = { xs, ys };
        // try load persisted state
        let state = loadChartStateFromLS(ticker, period, interval, ys.length);
        if (!state) {
            const visCount = Math.max(10, Math.min(ys.length, Math.round(ys.length))); // default: full range
            state = { start: Math.max(0, ys.length - visCount), end: ys.length };
        }
        // Clamp and attach
        state.start = Math.max(0, Math.min(state.start, Math.max(0, ys.length - 1)));
        state.end = Math.max(state.start + 1, Math.min(state.end, ys.length));
        state.full = full;
        window.__chartStates.set(key, state);
        drawViewport(canvas, state);
        initChartInteractions(canvas);
    } catch {
        drawLineChart(canvas, [], []);
    }
}

// Update chart meta title to include current price if available: "TICKER $123.45 • period/interval"
function updateChartMeta(ticker) {
    const meta = document.getElementById('cMeta');
    if (!meta) return;
    const period = document.getElementById('cPeriod')?.value || '6mo';
    const interval = document.getElementById('cInterval')?.value || '1d';
    const p = POSTS.find(x => x.id === currentDetailId);
    const cur = p?.snapshot?.[ticker]?.current;
    const pricePart = (typeof cur === 'number' && isFinite(cur)) ? ` ${fmtMoney(cur)}` : '';
    meta.textContent = `${ticker}${pricePart} • ${period}/${interval}`;
}

function drawViewport(canvas, state) {
    const { full, start, end } = state;
    const xs = full.xs.slice(start, end);
    const ys = full.ys.slice(start, end);
    drawLineChart(canvas, xs, ys, { hoverIdx: state.hoverIdx != null ? Math.max(0, Math.min(state.hoverIdx, ys.length-1)) : null });
}

function initChartInteractions(canvas) {
    if (canvas.__chartInited) return; // one-time binders per canvas
    canvas.__chartInited = true;
    const dpr = (window.devicePixelRatio || 1);
    const getTicker = () => window._activeTicker;
    const getPeriod = () => document.getElementById('cPeriod')?.value || '6mo';
    const getInterval = () => document.getElementById('cInterval')?.value || '1d';
    const getKey = () => chartStateKey(getTicker(), getPeriod(), getInterval());
    function getState() { return window.__chartStates.get(getKey()); }
    function setState(s) {
        window.__chartStates.set(getKey(), s);
        saveChartStateToLS(getTicker(), getPeriod(), getInterval(), s);
        drawViewport(canvas, s);
    }

    // Pan and zoom helpers
    function panBy(deltaIdx) {
        const st = getState(); if (!st) return;
        const N = st.full.ys.length; const win = st.end - st.start;
        let start = Math.max(0, Math.min(st.start + deltaIdx, N - win));
        let end = start + win; if (end > N) { end = N; start = Math.max(0, N - win); }
        setState({ ...st, start, end });
    }
    function zoomBy(factor, centerFrac = 0.5) {
        const st = getState(); if (!st) return;
        const N = st.full.ys.length; const win = st.end - st.start;
        let newWin = Math.max(5, Math.min(N, Math.round(win * factor)));
        const center = st.start + Math.round(win * centerFrac);
        let start = Math.max(0, Math.min(center - Math.round(newWin/2), N - newWin));
        let end = start + newWin; if (end > N) { end = N; start = Math.max(0, N - newWin); }
        setState({ ...st, start, end });
    }
    function resetView() {
        const st = getState(); if (!st) return;
        const N = st.full.ys.length;
        setState({ ...st, start: 0, end: N, hoverIdx: null });
    }

    // Mouse drag to pan
    let dragging = false; let lastX = 0;
    canvas.addEventListener('mousedown', (e) => { dragging = true; lastX = e.clientX; });
    window.addEventListener('mouseup', () => { dragging = false; });
    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const st = getState(); if (!st) return;
        const rect = canvas.getBoundingClientRect();
        const plotW = rect.width; // CSS pixels
        const dx = e.clientX - lastX; lastX = e.clientX;
        const win = st.end - st.start;
        const deltaIdx = -Math.round(dx / Math.max(1, plotW) * win);
        if (deltaIdx) panBy(deltaIdx);
    });

    // Hover to show vertical marker and price label
    canvas.addEventListener('mousemove', (e) => {
        const st = getState(); if (!st) return;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const padLpx = 46; const padRpx = 10; // keep in sync with drawLineChart pads (CSS px)
        const plotW = Math.max(1, rect.width - padLpx - padRpx);
        const frac = Math.max(0, Math.min(1, (x - padLpx) / plotW));
        const win = st.end - st.start;
        const idx = Math.round(frac * (win - 1));
        const hoverIdx = Math.max(0, Math.min(win - 1, idx));
        if (st.hoverIdx !== hoverIdx) setState({ ...st, hoverIdx });
    });
    canvas.addEventListener('mouseleave', () => {
        const st = getState(); if (!st) return;
        if (st.hoverIdx != null) setState({ ...st, hoverIdx: null });
    });

    // Wheel to zoom
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const st = getState(); if (!st) return;
        const rect = canvas.getBoundingClientRect();
        const padLpx = 46; const padRpx = 10; // keep in sync with drawLineChart pads (CSS px)
        const plotW = Math.max(1, rect.width - padLpx - padRpx);
        const centerFrac = Math.max(0, Math.min(1, ((e.clientX - rect.left) - padLpx) / plotW));
        const factor = (e.deltaY < 0) ? 0.8 : 1.25;
        zoomBy(factor, centerFrac);
    }, { passive: false });

    // Double click to reset
    canvas.addEventListener('dblclick', resetView);

    // Buttons in chart head (added in openDetail)
    const leftBtn = document.getElementById('cLeft');
    const rightBtn = document.getElementById('cRight');
    const zinBtn = document.getElementById('cZoomIn');
    const zoutBtn = document.getElementById('cZoomOut');
    if (leftBtn && !leftBtn.__wired) { leftBtn.__wired = true; leftBtn.addEventListener('click', () => panBy(Math.round((getState().end - getState().start) * -0.2))); }
    if (rightBtn && !rightBtn.__wired) { rightBtn.__wired = true; rightBtn.addEventListener('click', () => panBy(Math.round((getState().end - getState().start) * 0.2))); }
    if (zinBtn && !zinBtn.__wired) { zinBtn.__wired = true; zinBtn.addEventListener('click', () => zoomBy(0.8)); }
    if (zoutBtn && !zoutBtn.__wired) { zoutBtn.__wired = true; zoutBtn.addEventListener('click', () => zoomBy(1.25)); }

    // Arrow keys: left/right pan, up zoom-in, down zoom-out
    window.addEventListener('keydown', (e) => {
        // ignore when typing in inputs
        const tag = (e.target && e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
        // only when detail dialog is open
        if (!els.detailDlg || !els.detailDlg.open) return;
        const st = getState(); if (!st) return;
        const win = st.end - st.start;
        if (e.key === 'ArrowLeft') { e.preventDefault(); panBy(-Math.max(1, Math.round(win * 0.1))); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); panBy(Math.max(1, Math.round(win * 0.1))); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); zoomBy(0.85); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); zoomBy(1.15); }
    });

    // Redraw on resize (responsive)
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { const st = getState(); if (st) drawViewport(canvas, st); }, 100);
    });
}

// --- events
document.getElementById("cancelDlg").addEventListener("click", () => els.postDlg.close());
document.getElementById("saveDlg").addEventListener("click", savePost);
document.getElementById("dClose").addEventListener("click", () => els.detailDlg.close());
// Stop any active stream when dialog closes
els.detailDlg.addEventListener('close', () => {
    if (currentDetailId) stopAnalysisStream(currentDetailId);
});
els.runAllBtn.addEventListener("click", async () => {
    els.runAllBtn.disabled = true;
    try { await api("/api/analyze-all", { method: "POST" }); await loadPosts(); }
    finally { els.runAllBtn.disabled = false; }
});
els.searchBox.addEventListener("input", renderFeed);
els.fabAdd.addEventListener("click", openNew);

// --- boot
(async function init() {
    try { await loadConfig(); } catch { /* non-fatal */ }
    try {
        await loadPosts();
    } catch (e) {
        console.error("Failed to load posts:", e);
        els.feed.innerHTML = `<div class="empty-state">
          <div class="muted">Failed to load posts. Ensure the server is running and try again.</div>
        </div>`;
    }
    // Inject "Reset order" button next to Run All
    if (els.runAllBtn && !document.getElementById('resetOrderBtn')) {
        const btn = document.createElement('button');
        btn.id = 'resetOrderBtn';
        btn.className = 'ghost';
        btn.type = 'button';
        btn.title = 'Switch back to timestamp sorting';
        btn.textContent = 'Reset order';
        // place after runAllBtn
        els.runAllBtn.parentNode.insertBefore(btn, els.runAllBtn.nextSibling);
        btn.addEventListener('click', () => {
            HAS_CUSTOM_ORDER = false;
            try { localStorage.removeItem('feed:customOrder'); } catch {}
            // Sort POSTS by time immediately and re-render
            POSTS = POSTS.slice().sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
            renderFeed();
            showToast('Order reset');
        });
    }
})();

// --- tiny HTML escape
function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
