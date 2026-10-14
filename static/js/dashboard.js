/**
 * CloudOps NOC Dashboard — Main Module
 * Handles data fetching, chart rendering, DOM updates
 */

"use strict";

/* ─── Constants ──────────────────────────────────────────────────────────── */
const REFRESH_MS     = 2000;
const MAX_CHART_PTS  = 30;

/* ─── Module state ───────────────────────────────────────────────────────── */
const State = {
  charts: {},
  lastPayload: null,
  failCount: 0,
};

/* ─── Utility ────────────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const fmt = (n, d = 1) => Number(n).toFixed(d);

function severityClass(sev) {
  const map = { OK: "ok", WARNING: "warning", CRITICAL: "critical", NONE: "none" };
  return map[sev] || "ok";
}

function meterColor(pct) {
  if (pct >= 85) return "var(--red)";
  if (pct >= 70) return "var(--orange)";
  return "var(--green)";
}

function textColor(sev) {
  const map = { OK: "var(--green)", WARNING: "var(--orange)", CRITICAL: "var(--red)", NONE: "var(--green)" };
  return map[sev] || "var(--green)";
}

function formatBytes(bytes) {
  if (bytes > 1e9) return (bytes / 1e9).toFixed(2) + " GB";
  if (bytes > 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  if (bytes > 1e3) return (bytes / 1e3).toFixed(0) + " KB";
  return bytes + " B";
}

/* ─── Chart factory ──────────────────────────────────────────────────────── */
function makeGradient(ctx, color) {
  const g = ctx.createLinearGradient(0, 0, 0, ctx.canvas.offsetHeight || 150);
  const hex = color.replace("var(--", "").replace(")", "");
  const colorMap = {
    "chart-cpu":     ["rgba(41,121,255,0.4)",  "rgba(41,121,255,0)"],
    "chart-mem":     ["rgba(0,217,126,0.35)",  "rgba(0,217,126,0)"],
    "chart-disk":    ["rgba(255,159,67,0.35)", "rgba(255,159,67,0)"],
    "chart-net-in":  ["rgba(0,212,255,0.35)",  "rgba(0,212,255,0)"],
    "chart-net-out": ["rgba(124,77,255,0.3)",  "rgba(124,77,255,0)"],
  };
  const [top, bottom] = colorMap[hex] || ["rgba(255,255,255,0.2)", "rgba(255,255,255,0)"];
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  return g;
}

const CHART_DEFAULTS = {
  type: "line",
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 0 },
    interaction: { intersect: false, mode: "index" },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "rgba(13,17,23,0.95)",
        borderColor: "rgba(41,121,255,0.3)",
        borderWidth: 1,
        titleColor: "#8899aa",
        bodyColor: "#e2eaf4",
        padding: 10,
        titleFont: { family: "'JetBrains Mono', monospace", size: 10 },
        bodyFont:  { family: "'JetBrains Mono', monospace", size: 12 },
        callbacks: {
          label(ctx) { return ` ${ctx.dataset.label}: ${fmt(ctx.raw)}${ctx.dataset.unit || "%"}`; }
        }
      },
    },
    scales: {
      x: {
        display: true,
        ticks: {
          color: "#4a5568",
          font: { family: "'JetBrains Mono', monospace", size: 9 },
          maxTicksLimit: 6,
          maxRotation: 0,
        },
        grid: { color: "rgba(30,45,61,0.8)" },
      },
      y: {
        min: 0,
        max: 100,
        display: true,
        ticks: {
          color: "#4a5568",
          font: { family: "'JetBrains Mono', monospace", size: 9 },
          callback: (v) => v + "%",
          maxTicksLimit: 5,
        },
        grid: { color: "rgba(30,45,61,0.6)" },
      },
    },
  },
};

function createChart(canvasId, label, color, yMax = 100, unit = "%") {
  const canvas = $(canvasId);
  if (!canvas) return null;
  const ctx = canvas.getContext("2d");

  const cfg = JSON.parse(JSON.stringify(CHART_DEFAULTS));
  cfg.options.scales.y.max = yMax;
  cfg.options.scales.y.ticks.callback = yMax === 100 ? (v) => v + "%" : (v) => v.toFixed(1);

  return new Chart(ctx, {
    ...cfg,
    data: {
      labels: [],
      datasets: [{
        label,
        unit,
        data: [],
        borderColor: color,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: color,
        tension: 0.4,
        fill: true,
        backgroundColor: () => makeGradient(ctx, color),
      }],
    },
  });
}

/* ─── Chart update ───────────────────────────────────────────────────────── */
function updateChart(chart, labels, data, colorFn) {
  if (!chart) return;

  // trim to last MAX_CHART_PTS
  const maxLen = MAX_CHART_PTS;
  const trimmed = {
    labels: labels.slice(-maxLen),
    data:   data.slice(-maxLen),
  };

  chart.data.labels = trimmed.labels;
  chart.data.datasets[0].data = trimmed.data;

  // threshold-aware stroke colour
  if (colorFn) {
    const lastVal = trimmed.data[trimmed.data.length - 1] ?? 0;
    chart.data.datasets[0].borderColor = colorFn(lastVal);
  }

  chart.update("none");
}

function dynamicColor(pct) {
  if (pct >= 85) return "var(--red)";
  if (pct >= 70) return "var(--orange)";
  return "var(--chart-cpu)";
}

function netColor(mb) {
  if (mb > 10) return "var(--red)";
  if (mb > 5)  return "var(--orange)";
  return "var(--chart-net-in)";
}

/* ─── DOM helpers ────────────────────────────────────────────────────────── */
function setMetricCard(prefix, value, sev, sub) {
  const valEl  = $(`${prefix}-value`);
  const sevEl  = $(`${prefix}-badge`);
  const barEl  = $(`${prefix}-bar`);
  const subEl  = $(`${prefix}-sub`);

  if (valEl) {
    valEl.textContent = fmt(value);
    valEl.style.color = textColor(sev);
  }
  if (sevEl) {
    sevEl.textContent = sev;
    sevEl.className   = `card-badge badge-${severityClass(sev)}`;
  }
  if (barEl) {
    barEl.style.width           = Math.min(value, 100) + "%";
    barEl.style.backgroundColor = meterColor(value);
  }
  if (subEl && sub !== undefined) subEl.textContent = sub;
}

function updateGauge(score) {
  const r = 28;
  const circ = 2 * Math.PI * r;
  const fill  = $("gauge-fill");
  const numEl = $("gauge-number");
  if (!fill || !numEl) return;

  const offset = circ - (score / 100) * circ;
  fill.style.strokeDasharray  = `${circ}`;
  fill.style.strokeDashoffset = `${offset}`;

  const color = score >= 80 ? "var(--green)" : score >= 60 ? "var(--orange)" : "var(--red)";
  fill.style.stroke  = color;
  numEl.style.color  = color;
  numEl.textContent  = score;
}

function updateIncidents(incidents) {
  const list = $("incident-list");
  if (!list || !incidents?.length) return;

  list.innerHTML = incidents.map(inc => `
    <li class="incident-item">
      <span class="incident-dot dot-${severityClass(inc.severity)}"></span>
      <span class="incident-time">${inc.time}</span>
      <span class="incident-msg">${inc.message}</span>
    </li>
  `).join("");
}

function updateAlerts(alerts) {
  const body = $("alerts-body");
  if (!body) return;

  if (!alerts?.length) {
    body.innerHTML = `<div class="no-alerts">✓ No active alerts — all systems nominal</div>`;
    return;
  }

  body.innerHTML = alerts.map(a => {
    const sevClass = a.level === "CRITICAL" ? "sev-critical"
                   : a.level === "WARNING"  ? "sev-warning"
                   : "sev-info";
    return `
      <div class="alert-item">
        <span class="alert-severity ${sevClass}">${a.level}</span>
        <span class="alert-time">${a.time}</span>
        <span class="alert-msg">${a.message}</span>
      </div>
    `;
  }).join("");
}

function updateServices(services) {
  const grid = $("services-grid");
  if (!grid || !services?.length) return;

  grid.innerHTML = services.map(svc => {
    const ledClass    = `led-${svc.status}`;
    const statusClass = `status-${svc.status}`;
    const icons = {
      nginx: "🌐", flask: "🔥", ssh: "🔐",
      monitor: "📡", postgresql: "🗄️", redis: "⚡",
    };
    return `
      <div class="service-tile">
        <span class="svc-led ${ledClass}"></span>
        <div class="svc-info">
          <div class="svc-name">${icons[svc.key] || "🔧"} ${svc.name}</div>
          <div class="svc-status ${statusClass}">${svc.status.toUpperCase()}</div>
        </div>
      </div>
    `;
  }).join("");
}

function updateNetwork(net, data) {
  // bars — normalise to max 20 MB/s scale
  const scale = 20;
  const inPct  = Math.min((net.mb_in  / scale) * 100, 100);
  const outPct = Math.min((net.mb_out / scale) * 100, 100);

  const inBar  = $("net-in-bar");
  const outBar = $("net-out-bar");
  const inVal  = $("net-in-val");
  const outVal = $("net-out-val");
  const conns  = $("net-connections");

  if (inBar)  inBar.style.width  = inPct + "%";
  if (outBar) outBar.style.width = outPct + "%";
  if (inVal)  inVal.textContent  = fmt(net.mb_in, 2)  + " MB/s";
  if (outVal) outVal.textContent = fmt(net.mb_out, 2) + " MB/s";
  if (conns)  conns.textContent  = net.connections;

  const pktTotal = $("net-packets");
  const errTotal = $("net-errors");
  const bytesR   = $("net-bytes-recv");
  const bytesS   = $("net-bytes-sent");

  if (pktTotal) pktTotal.textContent = ((net.packets_recv + net.packets_sent) / 1000).toFixed(1) + "K";
  if (errTotal) errTotal.textContent = (net.errors_in + net.errors_out);
  if (bytesR)   bytesR.textContent   = formatBytes(net.bytes_recv);
  if (bytesS)   bytesS.textContent   = formatBytes(net.bytes_sent);
}

function updateInsights(sys, net) {
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set("sys-load",    sys.load_avg  + " / " + sys.load_5 + " / " + sys.load_15);
  set("sys-procs",   sys.processes);
  set("sys-swap",    sys.swap_pct + "%");
  set("sys-uptime",  sys.uptime);
  set("sys-temp",    sys.temperature !== null ? sys.temperature + "°C" : "N/A");
  set("net-conns2",  net?.connections ?? "—");
}

/* ─── Connection indicator ───────────────────────────────────────── */
function setOnline(ok) {
  const dot    = $("live-dot");
  const pill   = $("live-pill");
  const text   = $("live-text");
  const banner = $("conn-banner");

  if (ok) {
    banner?.classList.remove("visible");
    if (dot) { dot.style.background = "var(--green)"; dot.classList.add("pulse-live"); }
    if (text) text.textContent = "LIVE";
    if (pill) pill.style.color = "var(--green)";
    State.failCount = 0;
  } else {
    banner?.classList.add("visible");
    if (dot) { dot.style.background = "var(--red)"; }
    if (text) text.textContent = "OFFLINE";
    if (pill) pill.style.color = "var(--red)";
  }
}

/* ─── Fetch helpers ──────────────────────────────────────────────── */
async function apiFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ─── Main update loop ───────────────────────────────────────────── */
async function tick() {
  try {
    const [metrics, services, network] = await Promise.all([
      apiFetch("/metrics"),
      apiFetch("/services"),
      apiFetch("/network"),
    ]);

    setOnline(true);
    State.lastPayload = { metrics, services, network };

    // Header
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set("header-hostname", metrics.server.hostname);
    set("header-os",       metrics.server.os);
    set("header-ip",       metrics.server.public_ip);

    // Charts
    const h = metrics.history;
    updateChart(State.charts.cpu,     h.timestamps, h.cpu,     dynamicColor);
    updateChart(State.charts.mem,     h.timestamps, h.mem,     null);
    updateChart(State.charts.disk,    h.timestamps, h.disk,    null);
    updateChart(State.charts.net,     h.timestamps, h.net_in,  netColor);

    // Chart stats
    const c = metrics.current;
    set("cpu-stat",     fmt(c.cpu.value) + "%");
    set("mem-stat",     fmt(c.mem.value) + "%");
    set("disk-stat",    fmt(c.disk.value) + "%");
    set("net-in-stat",  fmt(c.net_in, 2)  + " MB/s");

    // Metric cards
    setMetricCard("cpu",    c.cpu.value,  c.cpu.severity,  null);
    setMetricCard("mem",    c.mem.value,  c.mem.severity,  `${c.mem.used_gb} / ${c.mem.total_gb} GB`);
    setMetricCard("disk",   c.disk.value, c.disk.severity, null);
    setMetricCard("netin",  Math.min((c.net_in  / 20) * 100, 100), "OK", `${fmt(c.net_in, 2)} MB/s`);
    setMetricCard("netout", Math.min((c.net_out / 20) * 100, 100), "OK", `${fmt(c.net_out, 2)} MB/s`);

    // Uptime card
    set("uptime-val", metrics.system.uptime);

    // Incidents
    updateGauge(metrics.health.score);
    const hel = $("health-label");
    const inc = metrics.health.incident;
    if (hel) {
      hel.textContent  = inc === "NONE" ? "All Systems Normal" : `Incident: ${inc}`;
      hel.className    = `health-label color-${severityClass(inc)}`;
    }
    const incBadge = $("incident-badge");
    if (incBadge) {
      incBadge.textContent = inc;
      incBadge.className   = `card-badge badge-${severityClass(inc)}`;
    }
    updateIncidents(metrics.incidents);
    updateAlerts(metrics.alerts);

    // Services
    updateServices(services.services);

    // Network panel
    updateNetwork(network, network);

    // System insights
    updateInsights(metrics.system, network);

  } catch (err) {
    State.failCount++;
    if (State.failCount >= 2) setOnline(false);
    console.warn("[CloudOps] Fetch error:", err.message);
  }
}

/* ─── Bootstrap ──────────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  // Chart.js defaults
  Chart.defaults.color          = "#8899aa";
  Chart.defaults.borderColor    = "rgba(30,45,61,0.6)";
  Chart.defaults.font.family    = "'JetBrains Mono', monospace";

  // Initialise charts
  State.charts.cpu  = createChart("chart-cpu",  "CPU",     "var(--chart-cpu)");
  State.charts.mem  = createChart("chart-mem",  "Memory",  "var(--chart-mem)");
  State.charts.disk = createChart("chart-disk", "Disk",    "var(--chart-disk)");
  State.charts.net  = createChart("chart-net",  "Net In",  "var(--chart-net-in)", 10, " MB/s");

  // Adjust net chart Y scale
  if (State.charts.net) {
    State.charts.net.options.scales.y.max = 10;
    State.charts.net.options.scales.y.ticks.callback = (v) => v + " MB/s";
    State.charts.net.update();
  }

  // Init gauge
  const r = 28;
  const circ = 2 * Math.PI * r;
  const fill = $("gauge-fill");
  if (fill) fill.style.strokeDasharray = `${circ} ${circ}`;

  // First tick immediately, then on interval
  tick();
  setInterval(tick, REFRESH_MS);
});
