/* Marathon Readiness tracker
 * Parses a Strava or Garmin running-history CSV, renders a dashboard,
 * and projects when the athlete may be ready for 2:45 marathon pace.
 * Everything runs client-side.
 */

const TARGET_PACE_MIN_PER_KM = 3 + 54 / 60; // 3:54 / km = 3.9
const TARGET_PACE_LABEL = "3:54 / km";

// ----- DOM -----
const $ = (sel) => document.querySelector(sel);
const csvInput = $("#csvInput");
const clearBtn = $("#clearBtn");
const emptyState = $("#emptyState");
const dashboard = $("#dashboard");
const errorBox = $("#errorBox");

// Chart handles so we can destroy them on re-upload
let mileageChart, paceChart, longRunChart;

// All parsed data — kept for re-rendering when the view range changes
let _allRuns = [];
let _allWeeks = [];

// "3m" = last 3 months (default), "all" = full history
let chartView = "3m";

const btn3m = $("#btn3m");
const btnAll = $("#btnAll");

csvInput.addEventListener("change", handleFile);
clearBtn.addEventListener("click", resetAll);
btn3m.addEventListener("click", () => setChartView("3m"));
btnAll.addEventListener("click", () => setChartView("all"));

// ================================================================
// CSV parsing
// ================================================================

function handleFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  hideError();
  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete: (res) => {
      try {
        const runs = extractRuns(res.data, res.meta.fields || []);
        if (!runs.length) {
          showError("No running activities were found in that CSV. Make sure it contains runs (not just rides or swims).");
          return;
        }
        runs.sort((a, b) => a.date - b.date);
        render(runs);
      } catch (err) {
        console.error(err);
        showError("Could not read that file: " + err.message);
      }
    },
    error: (err) => showError("CSV parse error: " + err.message),
  });
}

// Find the first header that matches any candidate (case-insensitive)
function pickField(fields, candidates) {
  const lower = fields.map((f) => (f || "").trim().toLowerCase());
  for (const c of candidates) {
    const idx = lower.indexOf(c.toLowerCase());
    if (idx !== -1) return fields[idx];
  }
  return null;
}

function extractRuns(rows, fields) {
  const typeKey = pickField(fields, ["Activity Type"]);
  const dateKey = pickField(fields, ["Activity Date", "Date", "Start Time"]);
  const distKey = pickField(fields, ["Distance", "Distance (km)"]);
  const timeKey = pickField(fields, ["Moving Time", "Elapsed Time", "Time", "Duration"]);
  const nameKey = pickField(fields, ["Activity Name", "Title", "Name"]);
  const paceKey = pickField(fields, ["Avg Pace", "Average Pace"]);

  if (!dateKey || !distKey) {
    throw new Error("CSV is missing a date or distance column.");
  }

  const runs = [];
  for (const row of rows) {
    const type = (typeKey ? row[typeKey] : "") || "";
    if (!isRunType(type)) continue;

    const date = parseDate(row[dateKey]);
    if (!date || isNaN(date.getTime())) continue;

    const distanceKm = parseDistanceKm(row[distKey]);
    if (!isFinite(distanceKm) || distanceKm <= 0) continue;

    let seconds = timeKey ? parseDurationSeconds(row[timeKey]) : NaN;

    // Fall back to avg pace if duration is missing/invalid
    if (!isFinite(seconds) || seconds <= 0) {
      const paceMin = paceKey ? parsePaceMinPerKm(row[paceKey]) : NaN;
      if (isFinite(paceMin) && paceMin > 0) seconds = paceMin * 60 * distanceKm;
    }
    if (!isFinite(seconds) || seconds <= 0) continue;

    const paceMinPerKm = seconds / 60 / distanceKm;
    // Filter absurd values (walking / paused activities)
    if (paceMinPerKm < 2 || paceMinPerKm > 12) continue;

    runs.push({
      date,
      name: (nameKey && row[nameKey]) || "Run",
      distanceKm,
      seconds,
      paceMinPerKm,
    });
  }
  return runs;
}

function isRunType(type) {
  if (!type) {
    // If there's no type column at all, assume all rows are runs.
    return true;
  }
  const t = type.toLowerCase();
  if (!t.includes("run")) return false;
  // Exclude "walk-run" or similar if someone has those; keep trail/treadmill runs.
  return true;
}

function parseDate(str) {
  if (!str) return null;
  // Strava: "Sep 1, 2023, 6:30:00 AM" — parseable by Date in most browsers.
  // Garmin: "2024-05-12 07:30:15" — convert space to T for safety.
  const cleaned = String(str).trim().replace(/^"|"$/g, "");
  let d = new Date(cleaned);
  if (!isNaN(d.getTime())) return d;
  d = new Date(cleaned.replace(" ", "T"));
  if (!isNaN(d.getTime())) return d;
  return null;
}

function parseDistanceKm(str) {
  if (str == null) return NaN;
  const s = String(str).replace(/,/g, "").trim();
  const n = parseFloat(s);
  return n;
}

// Accepts "01:23:45", "1:23:45", "23:45", "12.5" (minutes) or pure seconds.
function parseDurationSeconds(str) {
  if (str == null || str === "") return NaN;
  const s = String(str).trim();
  if (s.includes(":")) {
    const parts = s.split(":").map((p) => parseFloat(p));
    if (parts.some(isNaN)) return NaN;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0];
  }
  const n = parseFloat(s);
  if (!isFinite(n)) return NaN;
  // Heuristic: Strava's Moving Time column is seconds.
  return n;
}

// "4:32" -> 4.533 min/km
function parsePaceMinPerKm(str) {
  if (!str) return NaN;
  const s = String(str).trim();
  if (s.includes(":")) {
    const [m, sec] = s.split(":").map(parseFloat);
    if (isNaN(m) || isNaN(sec)) return NaN;
    return m + sec / 60;
  }
  return parseFloat(s);
}

// ================================================================
// Aggregation
// ================================================================

// Monday-start week key (YYYY-MM-DD of that Monday)
function weekStart(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  return d;
}

function weekKey(date) {
  const d = weekStart(date);
  return d.toISOString().slice(0, 10);
}

function aggregateWeeks(runs) {
  const map = new Map();
  for (const r of runs) {
    const key = weekKey(r.date);
    if (!map.has(key)) {
      map.set(key, {
        weekStart: weekStart(r.date),
        distanceKm: 0,
        longestKm: 0,
        totalSeconds: 0,
        weightedPaceNumer: 0, // sum(pace * dist)
        weightedPaceDenom: 0, // sum(dist)
        runs: 0,
      });
    }
    const w = map.get(key);
    w.distanceKm += r.distanceKm;
    w.longestKm = Math.max(w.longestKm, r.distanceKm);
    w.totalSeconds += r.seconds;
    w.weightedPaceNumer += r.paceMinPerKm * r.distanceKm;
    w.weightedPaceDenom += r.distanceKm;
    w.runs += 1;
  }
  const weeks = Array.from(map.values()).sort((a, b) => a.weekStart - b.weekStart);
  for (const w of weeks) {
    w.avgPace = w.weightedPaceDenom > 0 ? w.weightedPaceNumer / w.weightedPaceDenom : null;
  }
  // Fill missing weeks with zeros for a continuous mileage chart
  if (weeks.length > 1) {
    const filled = [];
    const first = weeks[0].weekStart;
    const last = weeks[weeks.length - 1].weekStart;
    const byKey = new Map(weeks.map((w) => [w.weekStart.toISOString().slice(0, 10), w]));
    for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 7)) {
      const k = d.toISOString().slice(0, 10);
      if (byKey.has(k)) {
        filled.push(byKey.get(k));
      } else {
        filled.push({
          weekStart: new Date(d),
          distanceKm: 0,
          longestKm: 0,
          totalSeconds: 0,
          weightedPaceNumer: 0,
          weightedPaceDenom: 0,
          avgPace: null,
          runs: 0,
        });
      }
    }
    return filled;
  }
  return weeks;
}

// Rolling average pace weighted by distance over a window of runs (by date)
function rollingPace(runs, windowDays) {
  const out = [];
  const ms = windowDays * 86400000;
  let j = 0;
  let sumNum = 0, sumDen = 0;
  const sorted = runs.slice().sort((a, b) => a.date - b.date);
  const window = [];
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    window.push(r);
    sumNum += r.paceMinPerKm * r.distanceKm;
    sumDen += r.distanceKm;
    while (window.length && (r.date - window[0].date) > ms) {
      const old = window.shift();
      sumNum -= old.paceMinPerKm * old.distanceKm;
      sumDen -= old.distanceKm;
    }
    out.push({ x: r.date, y: sumDen > 0 ? sumNum / sumDen : null });
  }
  return out;
}

// ================================================================
// Readiness projection
// ================================================================
//
// Approach: we fit a linear regression to the weekly weighted-average pace
// of runs >= 10 km (marathon-relevant efforts). If the slope is negative
// (improving), we project when the trend line crosses 3:54 / km.
// If already faster, we say "ready now". If flat or worsening, we say so.

function projectReadiness(runs) {
  const longish = runs.filter((r) => r.distanceKm >= 10);
  const source = longish.length >= 6 ? longish : runs;

  // Weekly weighted pace points
  const weeklyMap = new Map();
  for (const r of source) {
    const k = weekKey(r.date);
    if (!weeklyMap.has(k)) {
      weeklyMap.set(k, { t: weekStart(r.date).getTime(), num: 0, den: 0 });
    }
    const w = weeklyMap.get(k);
    w.num += r.paceMinPerKm * r.distanceKm;
    w.den += r.distanceKm;
  }
  const points = Array.from(weeklyMap.values())
    .filter((w) => w.den > 0)
    .map((w) => ({ t: w.t, pace: w.num / w.den }))
    .sort((a, b) => a.t - b.t);

  if (points.length < 4) {
    return { status: "insufficient", message: "Not enough data yet (need at least ~4 weeks of running)." };
  }

  // Use the last 26 weeks (~6 months) for a responsive trend
  const trailing = points.slice(-26);

  // Linear regression: pace = a + b * (days since first point)
  const t0 = trailing[0].t;
  const xs = trailing.map((p) => (p.t - t0) / 86400000);
  const ys = trailing.map((p) => p.pace);
  const n = xs.length;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  if (den === 0) {
    return { status: "flat", message: "Pace trend is flat over the trailing weeks." };
  }
  const slope = num / den; // min/km per day
  const intercept = meanY - slope * meanX;

  const latestPace = trailing[trailing.length - 1].pace;
  const now = Date.now();

  if (latestPace <= TARGET_PACE_MIN_PER_KM) {
    return {
      status: "ready",
      message: "Your recent long-run pace is already at or below 3:54 / km. Go race.",
      slope,
      latestPace,
    };
  }

  if (slope >= 0) {
    return {
      status: "no-trend",
      message: "No improving trend in the last 6 months. Keep building fitness and check back.",
      slope,
      latestPace,
    };
  }

  // Solve: target = intercept + slope * x  =>  x = (target - intercept) / slope
  const xTarget = (TARGET_PACE_MIN_PER_KM - intercept) / slope;
  const targetMs = t0 + xTarget * 86400000;
  const daysFromNow = (targetMs - now) / 86400000;

  if (daysFromNow < 0) {
    return {
      status: "ready",
      message: "Trend line has already crossed target pace — you may be ready now.",
      slope,
      latestPace,
    };
  }
  if (daysFromNow > 365 * 5) {
    return {
      status: "far",
      message: "At your current rate of improvement, 3:54 / km is more than 5 years away.",
      slope,
      latestPace,
    };
  }

  return {
    status: "projected",
    date: new Date(targetMs),
    daysFromNow,
    slope,
    latestPace,
    message: `Projected from your pace trend (${formatPace(latestPace)} now, improving ${formatSlope(slope)}).`,
  };
}

function formatSlope(slopeMinPerKmPerDay) {
  // Convert to seconds/km per week
  const secPerWeek = slopeMinPerKmPerDay * 60 * 7;
  return `${secPerWeek.toFixed(1)} s/km per week`;
}

// ================================================================
// Rendering
// ================================================================

function render(runs) {
  emptyState.hidden = true;
  dashboard.hidden = false;
  clearBtn.hidden = false;
  chartView = "3m";
  btn3m.classList.add("active");
  btnAll.classList.remove("active");

  _allRuns = runs;
  _allWeeks = aggregateWeeks(runs);

  renderStats(runs);
  renderCharts();
  renderRecentTable(runs);
  renderReadiness(runs);
}

function setChartView(range) {
  if (range === chartView) return;
  chartView = range;
  btn3m.classList.toggle("active", range === "3m");
  btnAll.classList.toggle("active", range === "all");
  renderCharts();
}

// Returns the cutoff Date for the current view (or null = no filter)
function viewCutoff() {
  if (chartView === "all") return null;
  const d = new Date();
  d.setMonth(d.getMonth() - 3);
  return d;
}

function renderCharts() {
  const cutoff = viewCutoff();
  const runs = cutoff ? _allRuns.filter((r) => r.date >= cutoff) : _allRuns;
  const weeks = cutoff ? _allWeeks.filter((w) => w.weekStart >= cutoff) : _allWeeks;
  renderMileageChart(weeks);
  renderPaceChart(runs);
  renderLongRunChart(weeks);
}

function renderStats(runs) {
  const now = new Date();
  const year = now.getFullYear();
  const monthStart = new Date(year, now.getMonth(), 1);
  const weekCutoff = weekStart(now); // Monday of current week

  // Runs this year
  const runsThisYear = runs.filter((r) => r.date.getFullYear() === year);
  $("#statRuns").textContent = runsThisYear.length.toLocaleString();

  // This week km
  const weekRuns = runs.filter((r) => r.date >= weekCutoff);
  const weekKm = weekRuns.reduce((s, r) => s + r.distanceKm, 0);
  $("#statWeek").textContent = `${weekKm.toFixed(1)} km`;

  // This month km
  const monthRuns = runs.filter((r) => r.date >= monthStart);
  const monthKm = monthRuns.reduce((s, r) => s + r.distanceKm, 0);
  $("#statMonth").textContent = `${monthKm.toFixed(1)} km`;

  // Last 4 weeks average pace (weighted by distance)
  const paceCutoff = Date.now() - 28 * 86400000;
  const recent = runs.filter((r) => r.date.getTime() >= paceCutoff);
  if (recent.length) {
    const num = recent.reduce((s, r) => s + r.paceMinPerKm * r.distanceKm, 0);
    const den = recent.reduce((s, r) => s + r.distanceKm, 0);
    $("#statPace").textContent = formatPace(num / den);
  } else {
    $("#statPace").textContent = "—";
  }
}

function renderReadiness(runs) {
  const r = projectReadiness(runs);
  const el = $("#statReady");
  const sub = $("#statReadySub");
  switch (r.status) {
    case "projected": {
      el.textContent = r.date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
      const months = (r.daysFromNow / 30.44).toFixed(1);
      sub.textContent = `~${months} months away · ${r.message}`;
      break;
    }
    case "ready":
      el.textContent = "Ready now";
      sub.textContent = r.message;
      break;
    case "no-trend":
    case "flat":
      el.textContent = "—";
      sub.textContent = r.message;
      break;
    case "far":
      el.textContent = "5+ years";
      sub.textContent = r.message;
      break;
    case "insufficient":
    default:
      el.textContent = "—";
      sub.textContent = r.message;
  }
}

function renderMileageChart(weeks) {
  if (mileageChart) mileageChart.destroy();
  const ctx = document.getElementById("mileageChart").getContext("2d");
  mileageChart = new Chart(ctx, {
    type: "bar",
    data: {
      datasets: [
        {
          label: "Weekly km",
          data: weeks.map((w) => ({ x: w.weekStart, y: +w.distanceKm.toFixed(1) })),
          backgroundColor: "#2563eb",
          borderRadius: 3,
        },
      ],
    },
    options: chartOptions({ yTitle: "km" }),
  });
}

function renderPaceChart(runs) {
  if (paceChart) paceChart.destroy();
  if (!runs.length) return;
  const ctx = document.getElementById("paceChart").getContext("2d");

  const scatter = runs.map((r) => ({ x: r.date, y: +r.paceMinPerKm.toFixed(3) }));
  const rolling = rollingPace(runs, 28).map((p) => ({ x: p.x, y: p.y != null ? +p.y.toFixed(3) : null }));
  const minX = runs[0].date;
  const maxX = runs[runs.length - 1].date;

  paceChart = new Chart(ctx, {
    type: "scatter",
    data: {
      datasets: [
        {
          label: "Run pace",
          data: scatter,
          backgroundColor: "rgba(37, 99, 235, 0.35)",
          pointRadius: 3,
          pointHoverRadius: 5,
        },
        {
          label: "4-week rolling avg",
          data: rolling,
          type: "line",
          borderColor: "#1d4ed8",
          backgroundColor: "rgba(29, 78, 216, 0.1)",
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.25,
        },
        {
          label: "2:45 target (3:54/km)",
          data: [
            { x: minX, y: TARGET_PACE_MIN_PER_KM },
            { x: maxX, y: TARGET_PACE_MIN_PER_KM },
          ],
          type: "line",
          borderColor: "#111827",
          borderWidth: 1.5,
          borderDash: [6, 4],
          pointRadius: 0,
        },
      ],
    },
    options: chartOptions({
      yTitle: "min / km",
      yReverse: true,
      yTickCallback: (v) => formatPace(v),
      tooltipY: (v) => formatPace(v),
    }),
  });
}

function renderLongRunChart(weeks) {
  if (longRunChart) longRunChart.destroy();
  const ctx = document.getElementById("longRunChart").getContext("2d");
  longRunChart = new Chart(ctx, {
    type: "line",
    data: {
      datasets: [
        {
          label: "Longest run (km)",
          data: weeks.map((w) => ({ x: w.weekStart, y: +w.longestKm.toFixed(1) })),
          borderColor: "#059669",
          backgroundColor: "rgba(5, 150, 105, 0.1)",
          fill: true,
          pointRadius: 2,
          tension: 0.2,
        },
      ],
    },
    options: chartOptions({ yTitle: "km" }),
  });
}

function renderRecentTable(runs) {
  const tbody = $("#recentTable tbody");
  tbody.innerHTML = "";
  const recent = runs.slice().reverse().slice(0, 15);
  for (const r of recent) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.date.toLocaleDateString()}</td>
      <td>${escapeHtml(r.name)}</td>
      <td class="num">${r.distanceKm.toFixed(2)} km</td>
      <td class="num">${formatDuration(r.seconds)}</td>
      <td class="num">${formatPace(r.paceMinPerKm)}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ================================================================
// Chart option helpers
// ================================================================

function chartOptions({ yTitle, yReverse = false, yTickCallback, tooltipY }) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "nearest", intersect: false },
    scales: {
      x: {
        type: "time",
        time: { unit: "month", tooltipFormat: "MMM d, yyyy" },
        grid: { color: "#f1f5f9" },
        ticks: { color: "#6b7280" },
      },
      y: {
        reverse: yReverse,
        title: { display: !!yTitle, text: yTitle, color: "#6b7280" },
        grid: { color: "#f1f5f9" },
        ticks: {
          color: "#6b7280",
          callback: yTickCallback || undefined,
        },
      },
    },
    plugins: {
      legend: {
        display: true,
        labels: { color: "#374151", boxWidth: 12, font: { size: 12 } },
      },
      tooltip: {
        callbacks: tooltipY
          ? { label: (c) => `${c.dataset.label}: ${tooltipY(c.parsed.y)}` }
          : undefined,
      },
    },
  };
}

// ================================================================
// Formatters
// ================================================================

function formatPace(minPerKm) {
  if (!isFinite(minPerKm) || minPerKm <= 0) return "—";
  const m = Math.floor(minPerKm);
  const s = Math.round((minPerKm - m) * 60);
  if (s === 60) return `${m + 1}:00 /km`;
  return `${m}:${s.toString().padStart(2, "0")} /km`;
}

function formatDuration(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// ================================================================
// UI helpers
// ================================================================

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}
function hideError() {
  errorBox.hidden = true;
  errorBox.textContent = "";
}
function resetAll() {
  csvInput.value = "";
  if (mileageChart) { mileageChart.destroy(); mileageChart = null; }
  if (paceChart) { paceChart.destroy(); paceChart = null; }
  if (longRunChart) { longRunChart.destroy(); longRunChart = null; }
  _allRuns = [];
  _allWeeks = [];
  chartView = "3m";
  btn3m.classList.add("active");
  btnAll.classList.remove("active");
  dashboard.hidden = true;
  emptyState.hidden = false;
  clearBtn.hidden = true;
  hideError();
}
