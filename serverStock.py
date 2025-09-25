# server.py
import os, json, uuid, threading, time, traceback
from datetime import datetime, timedelta
from typing import Dict, Any, List
from flask import Flask, jsonify, request, send_from_directory, render_template, Response, stream_with_context
from zoneinfo import ZoneInfo

# Optional deps:
# - tradingagents: provides analyze() or similar. We'll adapt via a safe wrapper.
# - yfinance: fetches price history for chart.
try:
    import tradingagents  # placeholder import; your env should provide this
except Exception:
    tradingagents = None

try:
    import yfinance as yf
except Exception:
    yf = None

# -------------------
# Config
# -------------------
APP_TZ = ZoneInfo("America/Los_Angeles")  # market-close scheduler
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
os.makedirs(DATA_DIR, exist_ok=True)
DATA_FILE = os.path.join(DATA_DIR, "stocks.json")
DATA_LOCK = threading.RLock()

AUTO_REGEN_ENABLED = True
# Approx daily close time: 1:00 PM PT (can drift for DST). We'll run 1:10 PM PT.
DAILY_REGEN_HOUR = 13
DAILY_REGEN_MIN = 10

# -------------------
# App
# -------------------
app = Flask(__name__, static_folder="static", template_folder="templates")

# -------------------
# Data helpers
# -------------------
def _read() -> List[Dict[str, Any]]:
    with DATA_LOCK:
        try:
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return []

def _write(obj: List[Dict[str, Any]]):
    with DATA_LOCK:
        tmp = DATA_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
        os.replace(tmp, DATA_FILE)

def _utcnow_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"

def _find(posts, pid):
    for p in posts:
        if str(p.get("id")) == str(pid):
            return p
    return None

def _update_post(pid: str, mutator):
    """Thread-safe read-modify-write for a single post."""
    with DATA_LOCK:
        posts = _read()
        p = _find(posts, pid)
        if not p:
            return False
        mutator(p)
        _write(posts)
        return True

# -------------------
# TradingAgents adapter
# -------------------
def run_tradingagents_analysis(tickers: List[str], options: Dict[str, Any]) -> Dict[str, Any]:
    """
    Drive TradingAgents via TradingAgentsGraph to produce a Buy/Hold/Sell per ticker.

    options (all optional):
      - date: 'YYYY-MM-DD' (default: today in APP_TZ)
      - debug: bool (default False)
      - selected_analysts: list[str] e.g. ["market","social","news","fundamentals"]
      - config: dict of overrides merged into DEFAULT_CONFIG (e.g., llm_provider, models, flags)
      - top-level overrides also accepted: llm_provider, deep_think_llm, quick_think_llm, backend_url, online_tools, max_debate_rounds, project_dir
    """
    def _norm(s: str) -> str:
        v = (s or "").strip().lower()
        if "buy" in v:
            return "Buy"
        if "sell" in v:
            return "Sell"
        return "Hold"

    if tradingagents is None:
        # Graceful fallback when package isn't available
        pseudo = {"summary": "TradingAgents not installed; using Hold placeholder.", "per_ticker": {}}
        for t in tickers:
            pseudo["per_ticker"][t] = {"suggestion": "Hold", "signals": {"note": "stub"}}
        return pseudo

    # Import concrete API as per README
    try:
        from tradingagents.graph.trading_graph import TradingAgentsGraph
        from tradingagents.default_config import DEFAULT_CONFIG
    except Exception as e:
        return {"summary": f"TradingAgents import error: {e}", "per_ticker": {t: {"suggestion": "Hold", "signals": {"error": str(e)}} for t in tickers}}

    opts = options or {}
    # Build config baseline
    try:
        cfg = DEFAULT_CONFIG.copy()
    except Exception:
        cfg = {}
    # Shallow-merge top-level known overrides
    for k in [
        "llm_provider", "deep_think_llm", "quick_think_llm", "backend_url",
        "online_tools", "max_debate_rounds", "project_dir"
    ]:
        if k in opts:
            cfg[k] = opts[k]
    # Merge nested config dict
    if isinstance(opts.get("config"), dict):
        cfg.update(opts["config"])  # shallow update by design

    selected_analysts = opts.get("selected_analysts") or ["market", "social", "news", "fundamentals"]
    debug = bool(opts.get("debug", False))
    date_str = (opts.get("date") or datetime.now(APP_TZ).date().isoformat())

    result: Dict[str, Any] = {"summary": "", "per_ticker": {}}
    lines: List[str] = []
    for t in tickers:
        try:
            ta = TradingAgentsGraph(selected_analysts=selected_analysts, debug=debug, config=cfg)
            final_state, decision = ta.propagate(t, date_str)
            sug = _norm(decision)
            signals = {
                "final_trade_decision": final_state.get("final_trade_decision"),
                "investment_plan": final_state.get("investment_plan"),
                "judge_decision_invest": (final_state.get("investment_debate_state") or {}).get("judge_decision"),
                "judge_decision_risk": (final_state.get("risk_debate_state") or {}).get("judge_decision"),
            }
            result["per_ticker"][t] = {"suggestion": sug, "signals": signals}
            lines.append(f"{t}: {sug} ({date_str})")
        except Exception as e:
            result["per_ticker"][t] = {"suggestion": "Hold", "signals": {"error": str(e)}}
            lines.append(f"{t}: Hold (error)")

    result["summary"] = "\n".join(lines)
    return result

# -------------------
# yfinance helpers
# -------------------
def get_latest_price(ticker: str) -> float | None:
    if yf is None:
        return None
    try:
        info = yf.Ticker(ticker)
        px = info.history(period="1d", interval="1m")
        if px is not None and not px.empty:
            return float(px["Close"].iloc[-1])
        # fallback to last close
        px2 = info.history(period="5d", interval="1d")
        if px2 is not None and not px2.empty:
            return float(px2["Close"].iloc[-1])
    except Exception:
        pass
    return None

def get_chart_data(ticker: str, period="6mo", interval="1d") -> Dict[str, Any]:
    if yf is None:
        return {"timestamps": [], "closes": []}
    try:
        # For 4h, yfinance does not have a direct 4h interval; aggregate 1h into 4h
        agg4h = False
        req_interval = interval
        if interval == "4h":
            agg4h = True
            req_interval = "1h"
        df = yf.Ticker(ticker).history(period=period, interval=req_interval)
        if df is None or df.empty:
            return {"timestamps": [], "closes": []}
        if agg4h:
            # Resample to 4-hour buckets using the mean close; align to start of bucket
            try:
                df = df.resample('4H').agg({'Close':'mean'})
                df = df.dropna()
            except Exception:
                pass
        ts = [int(pdts.timestamp() * 1000) for pdts in df.index.to_pydatetime()]
        closes = [float(x) for x in df["Close"].tolist()]
        return {"timestamps": ts, "closes": closes}
    except Exception:
        return {"timestamps": [], "closes": []}

def _sse(data: Dict[str, Any]) -> str:
    return f"data: {json.dumps(data)}\n\n"

def _wrap_text(s: str, width: int = 120) -> str:
    try:
        out_lines = []
        for line in str(s).splitlines():
            if len(line) <= width:
                out_lines.append(line)
                continue
            # simple whitespace wrap
            start = 0
            n = len(line)
            while start < n:
                end = min(start + width, n)
                # try to break at last space before end
                space_idx = line.rfind(" ", start, end)
                if space_idx == -1 or space_idx <= start:
                    out_lines.append(line[start:end])
                    start = end
                else:
                    out_lines.append(line[start:space_idx])
                    start = space_idx + 1
        return "\n".join(out_lines)
    except Exception:
        return str(s)

# -------------------
# Calculations
# -------------------
def percent_change(purchase: float | None, current: float | None) -> float | None:
    if purchase is None or current is None or purchase == 0:
        return None
    return (current - purchase) / purchase * 100.0

def row_suggestion(analysis: Dict[str, Any], primary: str) -> str:
    per = analysis.get("per_ticker", {})
    rec = per.get(primary) or {}
    return rec.get("suggestion", "Hold")

# -------------------
# API
# -------------------
@app.get("/api/config")
def api_config():
    return jsonify({"server": True})

@app.get("/api/stocks")
def list_posts():
    return jsonify(_read())

@app.post("/api/stocks/reorder")
def reorder_posts():
    """
    Persist a new custom order of posts.
    Body: {"order": [id1, id2, ...]}
    Any ids not present will retain their relative order and be appended.
    """
    payload = request.get_json(force=True, silent=True) or {}
    order = payload.get("order") or []
    if not isinstance(order, list):
        return jsonify({"message": "order must be a list of ids"}), 400

    posts = _read()
    # Build mapping and preserve original order for unspecified ids
    by_id = {str(p.get("id")): p for p in posts}
    used = set()
    new_posts = []
    for pid in order:
        pid_s = str(pid)
        if pid_s in by_id and pid_s not in used:
            new_posts.append(by_id[pid_s])
            used.add(pid_s)
    # Append any remaining posts in their original order
    for p in posts:
        pid_s = str(p.get("id"))
        if pid_s not in used:
            new_posts.append(p)
            used.add(pid_s)

    _write(new_posts)
    return jsonify({"message": "ok", "order": [p.get("id") for p in new_posts]})

@app.post("/api/stocks")
def create_post():
    payload = request.get_json(force=True, silent=True) or {}
    # shape:
    # {
    #   "title": str,
    #   "description": str,
    #   "tickers": [str, ...],
    #   "options": {...},           # TradingAgents options
    #   "purchases": {"TICK": 123}  # per-ticker purchase price (optional)
    # }
    now = _utcnow_iso()
    p = {
        "id": str(uuid.uuid4()),
        "createdAt": now,
        "updatedAt": now,
        "title": (payload.get("title") or "").strip() or "Untitled",
        "description": (payload.get("description") or "").strip(),
        "tickers": [t.strip().upper() for t in (payload.get("tickers") or []) if t.strip()],
        "options": payload.get("options") or {},
        "purchases": payload.get("purchases") or {},  # {ticker: price}
        "analysis": None,  # last TradingAgents run
        "snapshot": {}     # {ticker: {"current": float, "pct": float}}
    }
    posts = _read()
    posts.append(p)
    _write(posts)
    return jsonify(p), 201

@app.get("/api/summarize/<pid>")
def summarize_post(pid):
    """
    Compute and persist a summary for the post immediately based on current analysis.
    For each ticker, prefer per_ticker suggestion; if missing, attempt to parse from report text.
    """
    posts = _read()
    p = _find(posts, pid)
    if not p:
        return jsonify({"message": "Not found"}), 404

    analysis = p.get("analysis") or {}
    per = analysis.get("per_ticker") or {}
    report_text = (analysis.get("report") or "")
    opts = p.get("options") or {}
    date_str = (opts.get("date") or datetime.now(APP_TZ).date().isoformat())

    def parse_from_report(tk: str) -> str | None:
        try:
            if not report_text:
                return None
            # Scan lines mentioning this ticker for last clear decision
            decision = None
            for line in report_text.splitlines():
                if tk.upper() not in line.upper():
                    continue
                low = line.lower()
                if ("final" in low) or ("proposal" in low) or ("decision" in low) or (":" in low):
                    if "buy" in low:
                        decision = "Buy"
                    elif "sell" in low:
                        decision = "Sell"
                    elif "hold" in low:
                        decision = "Hold"
            return decision
        except Exception:
            return None

    lines = []
    for tk in (p.get("tickers") or []):
        sug = (per.get(tk) or {}).get("suggestion")
        if not sug:
            sug = parse_from_report(tk) or "Hold"
        lines.append(f"{tk}: {sug} ({date_str})")

    if lines:
        p.setdefault("analysis", {})
        p["analysis"]["summary"] = "\n".join(lines)
        p["analysis"]["updatedAt"] = _utcnow_iso()
        p["updatedAt"] = _utcnow_iso()
        _write(posts)
    return jsonify(p)

@app.put("/api/stocks/<pid>")
def update_post(pid):
    payload = request.get_json(force=True, silent=True) or {}
    posts = _read()
    p = _find(posts, pid)
    if not p:
        return jsonify({"message": "Not found"}), 404

    # editable fields
    if "title" in payload: p["title"] = (payload["title"] or "").strip() or "Untitled"
    if "description" in payload: p["description"] = (payload["description"] or "").strip()
    if "tickers" in payload: p["tickers"] = [t.strip().upper() for t in payload.get("tickers") or [] if t.strip()]
    if "options" in payload: p["options"] = payload.get("options") or {}
    if "purchases" in payload: p["purchases"] = payload.get("purchases") or {}
    p["updatedAt"] = _utcnow_iso()
    _write(posts)
    return jsonify(p)

@app.delete("/api/stocks/<pid>")
def delete_post(pid):
    posts = _read()
    new_posts = [x for x in posts if str(x.get("id")) != str(pid)]
    if len(new_posts) == len(posts):
        return jsonify({"message": "Not found"}), 404
    _write(new_posts)
    return jsonify({"message": "deleted"})

@app.post("/api/analyze/<pid>")
def analyze_post(pid):
    """
    Triggers TradingAgents analysis and yfinance snapshot for all tickers in this post.
    Stores the analysis + snapshot back into the post.
    """
    posts = _read()
    p = _find(posts, pid)
    if not p:
        return jsonify({"message": "Not found"}), 404

    tickers = p.get("tickers") or []
    opts = p.get("options") or {}
    try:
        analysis = run_tradingagents_analysis(tickers, opts)
    except Exception as e:
        analysis = {"summary": f"Analysis failed: {e}", "per_ticker": {}}

    snapshot = {}
    for t in tickers:
        cur = get_latest_price(t)
        buy = None
        if isinstance(p.get("purchases"), dict):
            # if multiple, per-ticker
            buy = p["purchases"].get(t)
        elif isinstance(p.get("purchases"), (int, float)):
            buy = p["purchases"]
        pct = percent_change(buy, cur) if buy is not None else None
        snapshot[t] = {"current": cur, "pct": pct}

    p["analysis"] = {"updatedAt": _utcnow_iso(), **analysis}
    p["snapshot"] = snapshot
    p["updatedAt"] = _utcnow_iso()
    _write(posts)
    return jsonify(p)

@app.get("/api/refresh-snapshot/<pid>")
def refresh_snapshot(pid):
    """
    Refreshes current price snapshot for all tickers in the post without running analysis.
    Updates the post's snapshot and updatedAt, and returns the full post.
    """
    posts = _read()
    p = _find(posts, pid)
    if not p:
        return jsonify({"message": "Not found"}), 404

    tickers = p.get("tickers") or []
    snapshot = {}
    for t in tickers:
        cur = get_latest_price(t)
        buy = None
        if isinstance(p.get("purchases"), dict):
            buy = (p.get("purchases") or {}).get(t)
        elif isinstance(p.get("purchases"), (int, float)):
            buy = p.get("purchases")
        pct = percent_change(buy, cur) if buy is not None else None
        snapshot[t] = {"current": cur, "pct": pct}

    p["snapshot"] = snapshot
    p["updatedAt"] = _utcnow_iso()
    _write(posts)
    return jsonify(p)

@app.get("/api/analyze-stream/<pid>")
def analyze_post_stream(pid):
    """
    Server-Sent Events (SSE) endpoint that runs analysis and streams progress logs.
    It also appends logs and incremental results to stocks.json as they occur.
    """
    posts = _read()
    p = _find(posts, pid)
    if not p:
        return jsonify({"message": "Not found"}), 404

    tickers = p.get("tickers") or []
    opts = p.get("options") or {}

    def gen():
        # Initialize analysis log structure
        def init_analysis(pp):
            ana = pp.get("analysis") or {}
            if not isinstance(ana, dict):
                ana = {}
            if "report" not in ana:
                ana["report"] = ""
            if "per_ticker" not in ana:
                ana["per_ticker"] = {}
            ana["updatedAt"] = _utcnow_iso()
            pp["analysis"] = ana

        _update_post(pid, init_analysis)
        yield _sse({"type": "start", "id": pid, "tickers": tickers})

        # Import TA and prepare config
        try:
            from tradingagents.graph.trading_graph import TradingAgentsGraph
            from tradingagents.default_config import DEFAULT_CONFIG
        except Exception as e:
            # Log error and finish
            def log_err(pp):
                init_analysis(pp)
                rep = pp["analysis"].get("report", "")
                rep = rep + ("\n" if rep else "") + _wrap_text(f"ERROR: {e}")
                pp["analysis"]["report"] = rep
                pp["analysis"]["updatedAt"] = _utcnow_iso()
            _update_post(pid, log_err)
            yield _sse({"type": "error", "message": f"TradingAgents import error: {e}"})
            return

        cfg = None
        try:
            cfg = DEFAULT_CONFIG.copy()
        except Exception:
            cfg = {}

        # Shallow top-level overrides
        for k in ["llm_provider", "deep_think_llm", "quick_think_llm", "backend_url", "online_tools", "max_debate_rounds", "project_dir"]:
            if k in opts:
                cfg[k] = opts[k]
        if isinstance(opts.get("config"), dict):
            cfg.update(opts["config"])  # shallow merge

        selected_analysts = opts.get("selected_analysts") or ["market", "social", "news", "fundamentals"]
        debug = bool(opts.get("debug", False))
        date_str = (opts.get("date") or datetime.now(APP_TZ).date().isoformat())

        def log_line(msg, level="info"):
            wrapped = _wrap_text(msg)
            def m(pp):
                init_analysis(pp)
                rep = pp["analysis"].get("report", "")
                pp["analysis"]["report"] = rep + ("\n" if rep else "") + wrapped
                pp["analysis"]["updatedAt"] = _utcnow_iso()
            _update_post(pid, m)

        for t in tickers:
            yield _sse({"type": "ticker-start", "ticker": t})
            try:
                ta = TradingAgentsGraph(selected_analysts=selected_analysts, debug=debug, config=cfg)
                init_state = ta.propagator.create_initial_state(t, date_str)
                args = ta.propagator.get_graph_args()
                final_state = None
                last_decision_seen = None  # fallback if final_state lacks decision

                def _derive_decision_from_text(text: str) -> str | None:
                    try:
                        txt = (text or "").lower()
                        if not txt:
                            return None
                        # Prefer lines that look like a final decision
                        if "final" in txt or "proposal" in txt or "decision" in txt:
                            if "buy" in txt:
                                return "Buy"
                            if "sell" in txt:
                                return "Sell"
                            if "hold" in txt:
                                return "Hold"
                        # Fallback: any clear buy/sell/hold mention
                        if "buy" in txt:
                            return "Buy"
                        if "sell" in txt:
                            return "Sell"
                        if "hold" in txt:
                            return "Hold"
                        return None
                    except Exception:
                        return None
                for chunk in ta.graph.stream(init_state, **args):
                    if not chunk.get("messages"):
                        continue
                    message = chunk["messages"][-1]
                    content = getattr(message, "content", None)
                    if content and str(content).strip():
                        text = str(content).strip()
                        log_line(f"{t}: {text}")
                        # Remember the last seen explicit decision cue
                        d = _derive_decision_from_text(text)
                        if d:
                            last_decision_seen = d
                        yield _sse({"type": "log", "ticker": t, "message": text})
                    final_state = chunk

                if not final_state:
                    raise RuntimeError("No final state produced by graph.stream")

                # Decide
                decision = None
                if final_state and final_state.get("final_trade_decision"):
                    try:
                        decision = ta.process_signal(final_state["final_trade_decision"]) or ""
                    except Exception:
                        decision = str(final_state.get("final_trade_decision") or "")
                # Fallback to parsed streamed text if no final state decision
                if not decision:
                    decision = last_decision_seen or "Hold"
                norm = ("Buy" if "buy" in str(decision).lower() else "Sell" if "sell" in str(decision).lower() else "Hold")
                signals = {
                    "final_trade_decision": final_state.get("final_trade_decision"),
                    "investment_plan": final_state.get("investment_plan"),
                    "judge_decision_invest": (final_state.get("investment_debate_state") or {}).get("judge_decision"),
                    "judge_decision_risk": (final_state.get("risk_debate_state") or {}).get("judge_decision"),
                }

                def upd(pp):
                    init_analysis(pp)
                    per = pp["analysis"].setdefault("per_ticker", {})
                    per[t] = {"suggestion": norm, "signals": signals}
                    pp["analysis"]["updatedAt"] = _utcnow_iso()
                _update_post(pid, upd)

                # Update snapshot for this ticker
                cur = get_latest_price(t)
                buy = None
                if isinstance(p.get("purchases"), dict):
                    buy = (p.get("purchases") or {}).get(t)
                elif isinstance(p.get("purchases"), (int, float)):
                    buy = p.get("purchases")
                pct = percent_change(buy, cur) if buy is not None else None

                def upd_snap(pp):
                    pp.setdefault("snapshot", {})[t] = {"current": cur, "pct": pct}
                    pp["updatedAt"] = _utcnow_iso()
                _update_post(pid, upd_snap)

                yield _sse({"type": "ticker-done", "ticker": t, "suggestion": norm, "current": cur, "pct": pct})
            except Exception as e:
                # Handle known TA memory collection errors gracefully
                msg = str(e)
                if "already exists" in msg and "memory" in msg.lower():
                    log_line(f"{t}: warning Memory collection already exists; reusing existing memory.")
                else:
                    log_line(f"{t}: error {e}", level="error")
                def upd_err(pp):
                    init_analysis(pp)
                    per = pp["analysis"].setdefault("per_ticker", {})
                    per[t] = {"suggestion": per.get(t, {}).get("suggestion", "Hold"), "signals": {"error": str(e)}}
                    pp["analysis"]["updatedAt"] = _utcnow_iso()
                _update_post(pid, upd_err)
                yield _sse({"type": "ticker-error", "ticker": t, "error": str(e)})

        # Build final summary
        posts_now = _read()
        p_now = _find(posts_now, pid)
        per = (p_now.get("analysis") or {}).get("per_ticker") or {}
        # Preserve original ticker order in summary
        lines = []
        for tk in tickers:
            v = per.get(tk) or {}
            lines.append(f"{tk}: {v.get('suggestion','')} ({opts.get('date') or datetime.now(APP_TZ).date().isoformat()})")
        def set_summary(pp):
            init_analysis(pp)
            pp["analysis"]["summary"] = "\n".join(lines)
            pp["analysis"]["updatedAt"] = _utcnow_iso()
        _update_post(pid, set_summary)
        yield _sse({"type": "done", "id": pid})

    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Content-Type": "text/event-stream",
    }
    return Response(stream_with_context(gen()), headers=headers)

@app.post("/api/analyze-all")
def analyze_all():
    posts = _read()
    out = []
    for p in posts:
        try:
            pid = p["id"]
            # Reuse the single analyze route logic
            with app.test_request_context():
                out.append(json.loads(analyze_post(pid).response[0]))
        except Exception as e:
            out.append({"id": p.get("id"), "error": str(e)})
    return jsonify(out)

@app.get("/api/chart")
def chart():
    """
    Returns OHLC close series suitable for a quick line chart.
    Params: ticker, period=6mo, interval=1d
    """
    ticker = (request.args.get("ticker") or "").upper().strip()
    if not ticker:
        return jsonify({"timestamps": [], "closes": []})
    period = request.args.get("period") or "6mo"
    interval = request.args.get("interval") or "1d"
    return jsonify(get_chart_data(ticker, period, interval))

# -------------------
# Frontend
# -------------------
@app.get("/")
def home():
    return render_template("index.html")

@app.get("/static/<path:fn>")
def serve_static(fn):
    return send_from_directory(app.static_folder, fn)

# -------------------
# Daily auto-regeneration (market close)
# -------------------
def _sleep_until_next_run(now: datetime) -> float:
    target = now.replace(hour=DAILY_REGEN_HOUR, minute=DAILY_REGEN_MIN, second=0, microsecond=0)
    if now >= target:
        target = target + timedelta(days=1)
    delta = (target - now).total_seconds()
    return max(10.0, delta)

def auto_regen_loop():
    if not AUTO_REGEN_ENABLED:
        return
    while True:
        try:
            now_local = datetime.now(APP_TZ)
            wait = _sleep_until_next_run(now_local)
            time.sleep(wait)
            # Run after waking
            with app.app_context():
                try:
                    analyze_all()
                    print(f"[Auto] Regenerated at {datetime.now(APP_TZ)}")
                except Exception:
                    traceback.print_exc()
        except Exception:
            traceback.print_exc()
            time.sleep(60)

def start_regen_thread():
    t = threading.Thread(target=auto_regen_loop, daemon=True)
    t.start()

# Stock page route
@app.route('/stock')
def serve_stock():
    return render_template('stock.html')

@app.route('/stock.html')
def serve_stock_html():
    return render_template('stock.html')

if __name__ == "__main__":
    start_regen_thread()
    app.run(host="0.0.0.0", port=5055, debug=True)
