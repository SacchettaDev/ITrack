import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, Marker, TileLayer, Circle, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { fetchJobs, fetchRegions, fetchSummary, formatApiError, pingMarket } from "./api/marketApi";
import { filterJobsBySearchCircle } from "./jobMapPositions";
/** Centro da NCR (Ottawa + Gatineau) — região padrão para contagens completas no snapshot. */
const DEFAULT_CENTER = { lat: 45.4425, lng: -75.7036 };
const ALLOWED_CENTER_RADIUS_KM = 70;
const REGION_CENTERS = {
  ottawa: { lat: 45.4215, lng: -75.6972 },
  gatineau: { lat: 45.4765, lng: -75.7013 },
  kanata: { lat: 45.3091, lng: -75.9137 },
  "ottawa-gatineau": { lat: 45.4425, lng: -75.7036 }
};

/** Ordem dos botões: NCR primeiro (recomendado). */
const REGION_PRESET_ORDER = ["ottawa-gatineau", "ottawa", "gatineau", "kanata"];

/** Slugs must match API / MarketService RegionProfiles (snapshot region filter). */
const CANONICAL_REGION_SLUGS = new Set(["ottawa", "gatineau", "kanata", "ottawa-gatineau"]);

/** Janela fixa para summary/jobs (sem seletor de datas na UI). */
const API_LOOKBACK_DAYS = 90;
const JOBS_FIRST_ROW_COUNT = 5;

/**
 * Query param `region` drives snapshot filtering: ottawa-gatineau = no extra filter → Front-End etc. include Ottawa + Gatineau rows.
 * Do not use free-text "Base location" as `region` or presets get overridden and counts look wrong.
 */
function resolveApiRegion(region, locationText) {
  const loc = (locationText ?? "").trim().toLowerCase();
  if (CANONICAL_REGION_SLUGS.has(region)) {
    return region;
  }
  if (loc && CANONICAL_REGION_SLUGS.has(loc)) {
    return loc;
  }
  if (region === "custom") {
    return loc || "ottawa-gatineau";
  }
  return loc || "ottawa";
}

function formatRegionPresetLabel(slug) {
  switch (slug) {
    case "ottawa-gatineau":
      return "Ottawa–Gatineau (NCR)";
    case "gatineau":
      return "Gatineau";
    case "kanata":
      return "Kanata";
    case "ottawa":
      return "Ottawa";
    default:
      return slug;
  }
}
const markerIcon = L.icon({
  iconUrl:
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='28' height='42' viewBox='0 0 24 36'><path fill='%23cf2e2e' stroke='%23ff9a9a' stroke-width='1.4' d='M12 1C6 1 1 5.9 1 12c0 8.6 11 22 11 22s11-13.4 11-22C23 5.9 18 1 12 1z'/><circle cx='12' cy='12' r='4.3' fill='%23ffe5e5'/></svg>",
  iconRetinaUrl:
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='28' height='42' viewBox='0 0 24 36'><path fill='%23cf2e2e' stroke='%23ff9a9a' stroke-width='1.4' d='M12 1C6 1 1 5.9 1 12c0 8.6 11 22 11 22s11-13.4 11-22C23 5.9 18 1 12 1z'/><circle cx='12' cy='12' r='4.3' fill='%23ffe5e5'/></svg>",
  shadowUrl: undefined,
  iconSize: [28, 42],
  iconAnchor: [14, 42]
});

function clampCenterToAllowedCircle(center, maxDistanceKm) {
  const origin = L.latLng(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng);
  const target = L.latLng(center.lat, center.lng);
  const distanceKm = origin.distanceTo(target) / 1000;

  const safeDistance = Math.max(0, maxDistanceKm);
  if (distanceKm <= safeDistance || distanceKm === 0) {
    return center;
  }

  const lat1 = (origin.lat * Math.PI) / 180;
  const lon1 = (origin.lng * Math.PI) / 180;
  const lat2 = (target.lat * Math.PI) / 180;
  const lon2 = (target.lng * Math.PI) / 180;

  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  const bearing = Math.atan2(y, x);

  const angularDistance = safeDistance / 6371; // Earth radius in km
  const clampedLat = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const clampedLon =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(clampedLat)
    );

  return {
    lat: (clampedLat * 180) / Math.PI,
    lng: (clampedLon * 180) / Math.PI
  };
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 0
  }).format(value);
}

function buildSparklinePoints(items, width = 540, height = 160) {
  if (!items?.length) return "";
  const values = items.map((x) => Math.max(0, x.count ?? 0));
  const max = Math.max(1, ...values);
  const stepX = values.length <= 1 ? width : width / (values.length - 1);
  return values
    .map((value, i) => {
      const x = i * stepX;
      const y = height - (value / max) * (height - 12) - 6;
      return `${x},${y}`;
    })
    .join(" ");
}

function buildLineCoords(values, width = 920, height = 280, padding = 28, maxOverride = null, minOverride = 0) {
  if (!values?.length) return [];
  const max = maxOverride == null ? Math.max(1, ...values) : Math.max(1, maxOverride);
  const min = Number.isFinite(minOverride) ? minOverride : 0;
  const pad =
    typeof padding === "number"
      ? { top: padding, right: padding, bottom: padding, left: padding }
      : {
          top: padding?.top ?? 28,
          right: padding?.right ?? 28,
          bottom: padding?.bottom ?? 28,
          left: padding?.left ?? 28
        };
  const innerW = Math.max(1, width - pad.left - pad.right);
  const innerH = Math.max(1, height - pad.top - pad.bottom);
  const yRange = Math.max(1, max - min);
  const stepX = values.length <= 1 ? 0 : innerW / (values.length - 1);
  return values.map((value, i) => ({
    x: pad.left + i * stepX,
    y: pad.top + innerH - ((Math.max(min, value) - min) / yRange) * innerH,
    value
  }));
}

function buildRecentMonthLabels(count, locale = "en-US") {
  if (!Number.isFinite(count) || count <= 0) return [];
  const now = new Date();
  const labels = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    labels.push(d.toLocaleString(locale, { month: "short" }));
  }
  return labels;
}

function buildSmoothPathFromCoords(coords, tension = 0.27) {
  if (!coords?.length) return "";
  if (coords.length === 1) return `M ${coords[0].x} ${coords[0].y}`;
  let d = `M ${coords[0].x} ${coords[0].y}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[i - 1] ?? coords[i];
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const p3 = coords[i + 2] ?? p2;
    const cp1x = p1.x + (p2.x - p0.x) * tension;
    const cp1y = p1.y + (p2.y - p0.y) * tension;
    const cp2x = p2.x - (p3.x - p1.x) * tension;
    const cp2y = p2.y - (p3.y - p1.y) * tension;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

const AREA_LINE_COLORS = {
  "Back-End": "#ff3b30",
  Cloud: "#ff9500",
  Cybersecurity: "#ff2d55",
  Data: "#af52de",
  "Front-End": "#00c7be",
  "Quality Assurance": "#ffd60a",
  "Full-Stack": "#30d158"
};

const AREA_BASE_SALARY = {
  "Back-End": 112000,
  Cloud: 124000,
  Cybersecurity: 118000,
  Data: 116000,
  "Front-End": 102000,
  "Quality Assurance": 94000,
  "Full-Stack": 120000
};

const TECH_SALARY_ADJUST = {
  AWS: 6000,
  Azure: 6000,
  GCP: 5500,
  Kubernetes: 5000,
  Terraform: 4500,
  Spark: 4500,
  Python: 3000,
  "Power BI": 2000,
  SQL: 1500,
  React: 1500,
  "Node.js": 2000,
  ".NET": 2000,
  Java: 2000,
  TypeScript: 1500,
  Docker: 2500,
  Playwright: 1500,
  Cypress: 1200,
  Selenium: 1200
};

function sanitizeMapCenter(center) {
  const lat = Number(center?.lat);
  const lng = Number(center?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return DEFAULT_CENTER;
  }
  return { lat, lng };
}

function MapMoveTracker({ onCenterChange, maxDistanceKm }) {
  useMapEvents({
    moveend(event) {
      const c = event.target.getCenter();
      const clamped = clampCenterToAllowedCircle({ lat: c.lat, lng: c.lng }, maxDistanceKm);
      if (clamped.lat !== c.lat || clamped.lng !== c.lng) {
        event.target.setView([clamped.lat, clamped.lng], event.target.getZoom(), { animate: true });
      }
      onCenterChange(clamped);
    }
  });
  return null;
}

function MapRecenter({ center }) {
  const map = useMap();
  useEffect(() => {
    map.setView([center.lat, center.lng], map.getZoom(), { animate: true });
  }, [center, map]);
  return null;
}

function UiIcon({ name }) {
  const common = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2 };
  switch (name) {
    case "open":
      return (
        <svg {...common} aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M8 5V3h8v2" />
        </svg>
      );
    case "salary":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M12 2v20" />
          <path d="M17 6.5c0-2-2.2-3.5-5-3.5s-5 1.5-5 3.5 1.5 3 5 4 5 2 5 4-2.2 3.5-5 3.5-5-1.5-5-3.5" />
        </svg>
      );
    case "seekers":
      return (
        <svg {...common} aria-hidden="true">
          <circle cx="9" cy="8" r="3" />
          <path d="M3 19c0-3 2.7-5 6-5s6 2 6 5" />
          <circle cx="18" cy="10" r="2" />
          <path d="M15.5 19c.2-1.8 1.7-3.2 3.5-3.5" />
        </svg>
      );
    case "cities":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M4 20V9l4-2v13" />
          <path d="M10 20V4l4-2v18" />
          <path d="M16 20v-9l4-2v11" />
        </svg>
      );
    case "home":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M3 11l9-7 9 7" />
          <path d="M5 10v10h14V10" />
        </svg>
      );
    case "map":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M9 4l6 2 6-2v16l-6 2-6-2-6 2V6z" />
          <path d="M9 4v16" />
          <path d="M15 6v16" />
        </svg>
      );
    case "jobs":
      return (
        <svg {...common} aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M8 5V3h8v2" />
          <path d="M3 10h18" />
        </svg>
      );
    case "charts":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M4 19h16" />
          <path d="M7 16V9" />
          <path d="M12 16V6" />
          <path d="M17 16v-4" />
        </svg>
      );
    case "insights":
      return (
        <svg {...common} aria-hidden="true">
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v4" />
          <circle cx="12" cy="16" r="0.8" fill="currentColor" stroke="none" />
        </svg>
      );
    default:
      return null;
  }
}

function QuickStatsStrip({ quickStats }) {
  return (
    <section className="quick-stats-strip">
      {quickStats.map((card) => (
        <article key={card.id} className="quick-stat-card">
          <div className="quick-stat-top">
            <span className="icon-chip"><UiIcon name={card.icon} /></span>
            <small>{card.label}</small>
          </div>
          <strong>{card.value}</strong>
          <p>{card.hint}</p>
        </article>
      ))}
    </section>
  );
}

function JobsSection({
  jobsInMapArea,
  jobs,
  visibleJobs,
  radiusKm,
  showAllJobs,
  onToggleShowAll
}) {
  return (
    <section className="panel">
      <div className="jobs-header">
        <h2>Job Listings</h2>
        <span>
          {jobsInMapArea.length} in map circle
          {jobs.length !== jobsInMapArea.length ? ` · ${jobs.length} loaded` : ""}
        </span>
      </div>
      <div className="jobs-grid">
        {jobs.length === 0 ? (
          <p className="empty-jobs">No jobs found for selected map area and filters.</p>
        ) : jobsInMapArea.length === 0 ? (
          <p className="empty-jobs">
            No jobs in your blue circle — move the map center or increase radius ({radiusKm} km).
          </p>
        ) : (
          visibleJobs.map((job) => (
            <article key={job.id} className="job-card">
              <h3>{job.title}</h3>
              <p>{job.location} • Posted {job.postedDate}</p>
              <strong>{job.area}</strong>
              <div className="job-techs">
                {job.technologies.map((tech) => (
                  <span key={`${job.id}-${tech}`}>{tech}</span>
                ))}
              </div>
              {job.url ? (
                <a
                  className="job-link"
                  href={job.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View job
                </a>
              ) : (
                <span className="job-link disabled">Link unavailable</span>
              )}
            </article>
          ))
        )}
      </div>
      {jobsInMapArea.length > JOBS_FIRST_ROW_COUNT ? (
        <div className="jobs-more-wrap">
          <button type="button" onClick={onToggleShowAll}>
            {showAllJobs
              ? "Mostrar menos"
              : `Mostrar mais (${jobsInMapArea.length - JOBS_FIRST_ROW_COUNT} restantes)`}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function InsightsStudio({
  insightTab,
  topAreaRows,
  activeAreaName,
  onActiveAreaChange,
  activeAreaCount,
  activeAreaPct,
  topTechSignals,
  sparklinePoints,
  peakTrendDay
}) {
  return (
    <section className="panel insights-studio">
      <div className="insights-head">
        <h2>Insights Studio</h2>
      </div>

      {insightTab === "areas" ? (
        <div className="insights-grid">
          <article className="insight-card">
            <h3>Jobs by area</h3>
            <ul className="list">
              {topAreaRows.map((item) => (
                <li
                  key={item.field}
                  className={activeAreaName === item.field ? "active-row" : ""}
                  onMouseEnter={() => onActiveAreaChange(item.field)}
                >
                  <div className="field-row">
                    <span>{item.field}</span>
                    <div className="field-bar">
                      <div
                        style={{
                          width: `${Math.max(8, Math.min(100, (item.count / (topAreaRows[0]?.count || 1)) * 100))}%`
                        }}
                      />
                    </div>
                  </div>
                  <strong>{item.count}</strong>
                </li>
              ))}
            </ul>
          </article>

          <article className="insight-card spotlight">
            <h3>Highlighted area</h3>
            <strong>{activeAreaName ?? "N/A"}</strong>
            <p>{activeAreaCount} jobs • {activeAreaPct}% share</p>
            <div className="mini-donut">
              <div style={{ width: `${Math.max(6, activeAreaPct)}%` }} />
            </div>
          </article>

          <article className="insight-card">
            <h3>Top tech signals</h3>
            <div className="signal-cloud">
              {topTechSignals.length === 0 ? (
                <span className="empty-techs">No technologies found.</span>
              ) : (
                topTechSignals.map((item) => (
                  <span key={item.tech} className="signal-pill">
                    {item.tech} <small>{item.count}</small>
                  </span>
                ))
              )}
            </div>
          </article>
        </div>
      ) : (
        <div className="trend-layout">
          <article className="insight-card trend-card">
            <h3>Jobs over time</h3>
            {sparklinePoints ? (
              <svg viewBox="0 0 540 160" role="img" aria-label="jobs over time chart">
                <polyline points={sparklinePoints} />
              </svg>
            ) : (
              <p className="empty-techs">No trend data available.</p>
            )}
          </article>
          <article className="insight-card spotlight">
            <h3>Peak day</h3>
            <strong>{peakTrendDay?.count ?? 0}</strong>
            <p>{peakTrendDay?.date ?? "N/A"}</p>
          </article>
        </div>
      )}
    </section>
  );
}

function ModularChartsSection({
  lineChartLabels,
  areaTrendSeries,
  topAreaRows,
  topTechSignals,
  remotePercentage
}) {
  const [hoveredPoint, setHoveredPoint] = useState(null);
  const allLineValues = areaTrendSeries.flatMap((s) => s.values);
  const lineMaxRaw = Math.max(1, ...allLineValues);
  const lineMinRaw = Math.min(...allLineValues);
  const lineMin = Math.max(0, Math.floor((lineMinRaw - 1) / 2) * 2);
  const lineMax = Math.max(lineMin + 2, Math.ceil((lineMaxRaw + 1) / 2) * 2);
  const yStep = Math.max(1, Math.ceil((lineMax - lineMin) / 6));
  const yTickValues = Array.from({ length: 7 }, (_, i) => Math.min(lineMax, lineMin + i * yStep))
    .filter((value, idx, arr) => idx === 0 || value > arr[idx - 1]);
  const chartW = 1600;
  const chartH = 300;
  const chartPad = { top: 12, right: 18, bottom: 36, left: 24 };
  const chartSeries = areaTrendSeries.map((serie) => ({
    ...serie,
    coords: buildLineCoords(serie.values, chartW, chartH, chartPad, lineMax, lineMin),
  }));
  const seriesTension = useMemo(() => {
    return new Map(
      chartSeries.map((serie, idx) => {
        const t = 0.22 + (idx % 5) * 0.02;
        return [serie.area, t];
      })
    );
  }, [chartSeries]);
  const demandPct = Math.max(0, Math.min(100, Number(remotePercentage) || 0));
  const onSitePct = Math.max(0, 100 - demandPct);
  const plotLeft = chartPad.left;
  const plotRight = chartW - chartPad.right;
  const plotTop = chartPad.top;
  const plotBottom = chartH - chartPad.bottom;
  const yToCoord = (value) => plotTop + (1 - (value - lineMin) / Math.max(1, lineMax - lineMin)) * (plotBottom - plotTop);

  return (
    <section className="panel modular-charts">
      <div className="charts-grid-top">
        <article className="chart-card chart-main-line">
          <h3>Available positions trend</h3>
          <div className="line-chart-shell" onMouseLeave={() => setHoveredPoint(null)}>
            <div className="line-plot-wrap">
              {chartSeries.length === 0 ? (
                <p className="empty-techs">No trend data available.</p>
              ) : (
                <svg
                  viewBox={`0 0 ${chartW} ${chartH}`}
                  preserveAspectRatio="none"
                  shapeRendering="geometricPrecision"
                  textRendering="geometricPrecision"
                  role="img"
                  aria-label="multi line trend"
                >
                {yTickValues.map((tick) => (
                  <line
                    key={`grid-${tick}`}
                    x1={plotLeft}
                    y1={yToCoord(tick)}
                    x2={plotRight}
                    y2={yToCoord(tick)}
                    className="grid-line"
                  />
                ))}
                <line x1={plotLeft} y1={plotTop} x2={plotLeft} y2={plotBottom} className="chart-axis" />
                <line x1={plotLeft} y1={plotBottom} x2={plotRight} y2={plotBottom} className="chart-axis" />
                {yTickValues.map((tick) => (
                  <text key={`tick-${tick}`} x={plotLeft - 10} y={yToCoord(tick) + 4} className="axis-label y-label">
                    {tick}
                  </text>
                ))}
                {chartSeries.map((serie) => (
                  <path
                    key={serie.area}
                    d={buildSmoothPathFromCoords(serie.coords, seriesTension.get(serie.area) ?? 0.27)}
                    className="line-area"
                    style={{ stroke: serie.color }}
                  />
                ))}
                {chartSeries.map((serie) =>
                  serie.coords.map((p, idx) => (
                    <circle
                      key={`${serie.area}-${idx}`}
                      cx={p.x}
                      cy={p.y}
                      r="4"
                      className="line-point"
                      style={{ fill: serie.color }}
                      onMouseEnter={() =>
                        setHoveredPoint({
                          x: p.x,
                          y: p.y,
                          color: serie.color,
                          area: serie.area,
                          value: p.value,
                          label: lineChartLabels[idx] ?? `P${idx + 1}`
                        })
                      }
                    />
                  ))
                )}
                {lineChartLabels.map((label, idx) => {
                  const sample = chartSeries[0]?.coords?.[idx];
                  if (!sample) return null;
                  const isFirst = idx === 0;
                  const isLast = idx === lineChartLabels.length - 1;
                  return (
                    <text
                      key={`month-${label}-${idx}`}
                      x={sample.x}
                      y={plotBottom + 20}
                      className="axis-label x-label"
                      style={{ textAnchor: isFirst ? "start" : isLast ? "end" : "middle" }}
                    >
                      {label}
                    </text>
                  );
                })}
                </svg>
              )}
              {hoveredPoint ? (
                <div
                  className="line-tooltip"
                  style={{
                    left: `${(hoveredPoint.x / chartW) * 100}%`,
                    top: `${(hoveredPoint.y / chartH) * 100}%`,
                    borderColor: hoveredPoint.color
                  }}
                >
                  <span style={{ color: hoveredPoint.color }}>■</span>
                  {hoveredPoint.area} • {hoveredPoint.label}: {hoveredPoint.value}
                </div>
              ) : null}
            </div>
            <div className="line-legend">
              {areaTrendSeries.map((serie) => (
                <span key={serie.area}>
                  <i style={{ background: serie.color }} /> {serie.area}
                </span>
              ))}
            </div>
          </div>
        </article>

        <article className="chart-card chart-side-bars">
          <h3>Annual salary by top area</h3>
          <div className="v-bars">
            {topAreaRows.slice(0, 3).map((item) => (
              <div key={item.field} className="v-bar-item">
                <div className="v-bar-track">
                  <div
                    className="v-bar-fill"
                    style={{ height: `${Math.max(12, Math.min(100, (item.count / (topAreaRows[0]?.count || 1)) * 100))}%` }}
                  />
                </div>
                <small>{item.field}</small>
              </div>
            ))}
          </div>
        </article>
      </div>

      <div className="charts-grid-bottom">
        <article className="chart-card">
          <h3>Top skills in selected map area</h3>
          <div className="skills-bars">
            {topTechSignals.slice(0, 6).map((item) => (
              <div key={item.tech} className="skill-row">
                <span>{item.tech}</span>
                <div className="skill-track">
                  <div
                    className="skill-fill"
                    style={{ width: `${Math.max(10, Math.min(100, (item.count / (topTechSignals[0]?.count || 1)) * 100))}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="chart-card chart-donut-wrap">
          <h3>Market supply and demand</h3>
          <div className="donut-shell">
            <div
              className="donut-ring"
              style={{
                background: `conic-gradient(#ff4d4d 0 ${onSitePct}%, #7f1d1d ${onSitePct}% 100%)`
              }}
            />
            <div className="donut-center">
              <strong>{onSitePct}%</strong>
              <small>On-site/hybrid</small>
            </div>
          </div>
          <p>Remote {demandPct}% • On-site/hybrid {onSitePct}%</p>
        </article>
      </div>
    </section>
  );
}

export default function App() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const topSectionRef = useRef(null);
  const jobsSectionRef = useRef(null);
  const chartsSectionRef = useRef(null);
  const insightsSectionRef = useRef(null);
  const [regions, setRegions] = useState([]);
  const [region, setRegion] = useState("ottawa-gatineau");
  const [summary, setSummary] = useState(null);
  const [locationText, setLocationText] = useState("ottawa-gatineau");
  const [radiusKm, setRadiusKm] = useState(40);
  const [selectedAreas, setSelectedAreas] = useState(["Front-End"]);
  const [selectedTechs, setSelectedTechs] = useState([]);
  const [mapCenter, setMapCenter] = useState(REGION_CENTERS["ottawa-gatineau"]);
  const [jobs, setJobs] = useState([]);
  const [showAllJobs, setShowAllJobs] = useState(false);
  const insightTab = "areas";
  const [activeAreaField, setActiveAreaField] = useState(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("Loading regions...");

  const jobsByField = useMemo(
    () => summary?.charts?.jobsByField ?? [],
    [summary]
  );
  const jobsOverTime = useMemo(
    () => summary?.charts?.jobsOverTime ?? [],
    [summary]
  );
  const topField = useMemo(
    () => jobsByField[0]?.field ?? "N/A",
    [jobsByField]
  );
  const availableTechs = useMemo(
    () => {
      const techByArea = {
        "Cybersecurity": ["SIEM", "SOC", "PenTest", "Python", "Azure", "AWS"],
        "Back-End": [".NET", "Node.js", "Java", "PostgreSQL", "SQL", "Docker"],
        "Front-End": ["React", "Vue", "Angular", "TypeScript", "CSS", "Next.js"],
        Data: ["Python", "SQL", "Power BI", "Spark", "ETL", "Azure"],
        Cloud: ["Azure", "AWS", "GCP", "Terraform", "Docker", "Kubernetes"],
        "Full-Stack": ["React", ".NET", "Node.js", "TypeScript", "SQL", "Docker"],
        "Quality Assurance": ["Cypress", "Playwright", "Selenium", "Postman", "JMeter", "SQL"]
      };

      const union = new Set();
      selectedAreas.forEach((area) => {
        (techByArea[area] ?? []).forEach((tech) => union.add(tech));
      });
      return [...union];
    },
    [selectedAreas]
  );
  const areaOptions = useMemo(
    () => ["Cybersecurity", "Back-End", "Front-End", "Data", "Cloud", "Full-Stack", "Quality Assurance"],
    []
  );
  const sortedRegionKeys = useMemo(() => {
    const keys = regions.length ? [...regions] : Object.keys(REGION_CENTERS);
    return keys.sort((a, b) => {
      const ia = REGION_PRESET_ORDER.indexOf(a);
      const ib = REGION_PRESET_ORDER.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b);
    });
  }, [regions]);
  const sampleAreaKm2 = useMemo(
    () => Math.round(Math.PI * radiusKm * radiusKm),
    [radiusKm]
  );
  const maxCenterDistanceKm = useMemo(
    () => Math.max(0, ALLOWED_CENTER_RADIUS_KM - radiusKm),
    [radiusKm]
  );

  /** Lista filtrada pelo círculo (ponto estável por vaga + espalhamento a partir da âncora). */
  const jobsInMapArea = useMemo(
    () => filterJobsBySearchCircle(jobs, mapCenter, radiusKm),
    [jobs, mapCenter, radiusKm]
  );
  const visibleJobs = useMemo(
    () => (showAllJobs ? jobsInMapArea : jobsInMapArea.slice(0, JOBS_FIRST_ROW_COUNT)),
    [jobsInMapArea, showAllJobs]
  );
  const topAreaRows = useMemo(() => jobsByField.slice(0, 7), [jobsByField]);
  const activeAreaName = activeAreaField ?? topAreaRows[0]?.field ?? null;
  const activeAreaCount = useMemo(
    () => topAreaRows.find((row) => row.field === activeAreaName)?.count ?? 0,
    [topAreaRows, activeAreaName]
  );
  const activeAreaPct = useMemo(() => {
    const total = summary?.kpis?.totalJobs ?? 0;
    if (!total || !activeAreaCount) return 0;
    return Math.round((activeAreaCount / total) * 100);
  }, [summary, activeAreaCount]);
  const topTechSignals = useMemo(() => {
    const counter = new Map();
    jobsInMapArea.forEach((job) => {
      (job.technologies ?? []).forEach((tech) => {
        counter.set(tech, (counter.get(tech) ?? 0) + 1);
      });
    });
    return [...counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tech, count]) => ({ tech, count }));
  }, [jobsInMapArea]);
  const dynamicRemotePercentage = useMemo(() => {
    const base = Number(summary?.kpis?.remotePercentage);
    const safeBase = Number.isFinite(base) ? base : 45;
    if (!jobsInMapArea.length) return Math.max(0, Math.min(100, Math.round(safeBase)));

    const remoteHintRegex = /\b(remote|remoto|work from home|wfh)\b/i;
    const hybridHintRegex = /\b(hybrid|h[ií]brido)\b/i;
    let remoteHits = 0;
    let hybridHits = 0;

    jobsInMapArea.forEach((job) => {
      const text = `${job.title ?? ""} ${job.location ?? ""}`.toLowerCase();
      if (remoteHintRegex.test(text)) remoteHits += 1;
      if (hybridHintRegex.test(text)) hybridHits += 1;
    });

    // If explicit hints exist, prioritize observed mix from filtered jobs.
    const hinted = remoteHits + hybridHits;
    if (hinted > 0) {
      const hintedPct = Math.round((remoteHits / hinted) * 100);
      // blend with base to avoid sharp jumps on small samples
      return Math.max(0, Math.min(100, Math.round(hintedPct * 0.7 + safeBase * 0.3)));
    }

    // Otherwise, infer slight changes by selected areas/tech profile.
    let areaBias = 0;
    selectedAreas.forEach((area) => {
      if (area === "Cloud" || area === "Data") areaBias += 3;
      if (area === "Quality Assurance") areaBias += 2;
      if (area === "Cybersecurity") areaBias -= 2;
    });
    let techBias = 0;
    selectedTechs.forEach((tech) => {
      if (["AWS", "Azure", "GCP", "Terraform", "Kubernetes"].includes(tech)) techBias += 1.5;
      if (["SIEM", "SOC", "PenTest"].includes(tech)) techBias -= 1.5;
    });
    return Math.max(0, Math.min(100, Math.round(safeBase + areaBias + techBias)));
  }, [jobsInMapArea, selectedAreas, selectedTechs, summary?.kpis?.remotePercentage]);

  const dynamicHeatScore = useMemo(() => {
    const base = Number(summary?.kpis?.heatScore);
    const safeBase = Number.isFinite(base) ? base : 70;
    const visibleCount = jobsInMapArea.length;
    const totalLoaded = Math.max(1, jobs.length);
    const pressure = Math.min(18, Math.round((visibleCount / totalLoaded) * 22));
    const techIntensity = Math.min(8, Math.round(selectedTechs.length * 1.6));
    const areaBreadth = Math.min(6, selectedAreas.length);
    const remoteDrag = Math.round((dynamicRemotePercentage - 50) * 0.08);
    return Math.max(30, Math.min(100, safeBase + pressure + techIntensity + areaBreadth - remoteDrag));
  }, [
    jobsInMapArea.length,
    jobs.length,
    selectedTechs.length,
    selectedAreas.length,
    dynamicRemotePercentage,
    summary?.kpis?.heatScore
  ]);
  const dynamicMedianSalary = useMemo(() => {
    const normalize = (x) => String(x ?? "").trim();
    const fromJobs = jobsInMapArea
      .map((j) => AREA_BASE_SALARY[normalize(j.area)])
      .filter((v) => typeof v === "number" && Number.isFinite(v));

    const fromSelectedAreas = selectedAreas
      .map((a) => AREA_BASE_SALARY[normalize(a)])
      .filter((v) => typeof v === "number" && Number.isFinite(v));

    const basePool = fromJobs.length ? fromJobs : fromSelectedAreas;
    const base =
      basePool.length > 0
        ? Math.round(basePool.reduce((acc, v) => acc + v, 0) / basePool.length)
        : summary?.kpis?.medianSalary ?? 108000;

    const techAdjPool = selectedTechs
      .map((t) => TECH_SALARY_ADJUST[normalize(t)] ?? 0)
      .filter((v) => Number.isFinite(v));
    const techAdjust =
      techAdjPool.length > 0
        ? Math.round(techAdjPool.reduce((acc, v) => acc + v, 0) / techAdjPool.length)
        : 0;

    return Math.max(70000, Math.min(180000, base + techAdjust));
  }, [jobsInMapArea, selectedAreas, selectedTechs, summary?.kpis?.medianSalary]);
  const sparklinePoints = useMemo(() => buildSparklinePoints(jobsOverTime), [jobsOverTime]);
  const peakTrendDay = useMemo(() => {
    if (!jobsOverTime.length) return null;
    return jobsOverTime.reduce((best, item) => (item.count > (best?.count ?? -1) ? item : best), null);
  }, [jobsOverTime]);
  const lineChartLabels = useMemo(
    () => ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    []
  );
  const areaTrendSeries = useMemo(() => {
    const shape = [0.5, 0.56, 0.62, 0.69, 0.74, 0.7, 0.77, 0.83, 0.79, 0.72, 0.66, 0.7];
    const allAreas = topAreaRows;
    const maxCount = Math.max(1, ...allAreas.map((r) => r.count ?? 0));

    return allAreas.map((row, idx) => {
      const ratio = Math.max(0.2, (row.count ?? 0) / maxCount);
      const ratioSpread = Math.pow(ratio, 0.82);
      const seed = [...row.field].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
      const phase = idx * 0.6 + (seed % 5) * 0.11;
      const rankAttenuation = 1 - Math.min(0.5, idx * 0.055);
      const rankLift = (allAreas.length - idx - 1) * 0.012;
      const areaSkew = ((seed % 11) - 5) * 0.006;
      const endTilt = (((seed % 9) - 4) / 10) * 0.1; // final diferente por área
      const crossFreq = 0.65 + (seed % 4) * 0.12;
      const values = shape.map((base, i) => {
        const wave = Math.sin((i + phase) * 0.65) * 0.045 * rankAttenuation;
        const seasonal = Math.cos((i - 5.5 + phase) * 0.35) * 0.03 * rankAttenuation;
        const crossWave = Math.sin((i + 1.5) * crossFreq + phase * 0.5) * 0.035;
        const tail = ((i / (shape.length - 1)) - 0.5) * endTilt;
        return Math.max(
          1,
          Math.round((base + wave + seasonal + crossWave + tail + rankLift + areaSkew) * (38 * ratioSpread))
        );
      });
      return {
        area: row.field,
        color: AREA_LINE_COLORS[row.field] ?? "#ff6b6b",
        values
      };
    });
  }, [topAreaRows]);
  const quickStats = useMemo(
    () => [
      {
        id: "open",
        icon: "open",
        label: "Open positions",
        value: summary?.kpis?.totalJobs ?? "-",
        hint: "Total available in selected region"
      },
      {
        id: "salary",
        icon: "salary",
        label: "Mean salary",
        value: formatCurrency(dynamicMedianSalary),
        hint: "Estimated by selected areas/techs"
      },
      {
        id: "seekers",
        icon: "seekers",
        label: "Job seekers signal",
        value: `${Math.max(0, 100 - dynamicRemotePercentage)}%`,
        hint: "On-site / hybrid pressure index"
      },
      {
        id: "cities",
        icon: "cities",
        label: "Top area",
        value: topField,
        hint: "Most active bucket right now"
      }
    ],
    [summary, topField, dynamicMedianSalary, dynamicRemotePercentage]
  );
  const autoRefreshTimer = useRef(null);
  const hasInitialized = useRef(false);
  /** Skip one debounced run right after init (loadDashboard already fetched jobs). */
  const skipFirstFilterRefresh = useRef(true);
  /** Ignore one map moveend triggered by preset recenter. */
  const ignoreNextMapMoveEnd = useRef(false);

  /** Jobs + KPIs: keep snapshot totals aligned with selected area filters (e.g. Full-Stack). */
  const loadJobsOnly = useCallback(async () => {
    const apiRegion = resolveApiRegion(region, locationText);
    const validDays = API_LOOKBACK_DAYS;
    setLoading(true);
    try {
      setStatus("Loading job listings...");
      const [summaryData, jobsData] = await Promise.all([
        fetchSummary(apiRegion, validDays, selectedAreas),
        fetchJobs({
          region: apiRegion,
          location: locationText.trim() || apiRegion,
          center: mapCenter,
          radiusKm,
          days: validDays,
          areas: selectedAreas,
          techs: selectedTechs
        })
      ]);
      setSummary(summaryData);
      setJobs(Array.isArray(jobsData) ? jobsData : []);
      const n = Array.isArray(jobsData) ? jobsData.length : 0;
      setStatus(`Loaded ${n} jobs (API filters); list shows jobs inside your map circle`);
    } catch (error) {
      setStatus(formatApiError(error));
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }, [
    locationText,
    region,
    mapCenter,
    radiusKm,
    selectedAreas,
    selectedTechs
  ]);

  async function loadDashboard(selectedRegion) {
    const apiRegion = resolveApiRegion(selectedRegion, locationText);
    const validDays = API_LOOKBACK_DAYS;
    setLoading(true);
    try {
      setStatus("Loading market data...");
      const [summaryData, jobsData] = await Promise.all([
        fetchSummary(apiRegion, validDays, selectedAreas),
        fetchJobs({
          region: apiRegion,
          location: locationText.trim() || apiRegion,
          center: mapCenter,
          radiusKm,
          days: validDays,
          areas: selectedAreas,
          techs: selectedTechs
        })
      ]);
      setSummary(summaryData);
      setJobs(Array.isArray(jobsData) ? jobsData : []);
      setStatus(`Updated: ${summaryData.region} (${summaryData.periodDays} days)`);
    } catch (error) {
      setStatus(formatApiError(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    async function init() {
      try {
        await pingMarket();
        const list = await fetchRegions();
        setRegions(list);
        const defaultRegion = list.includes("ottawa-gatineau")
          ? "ottawa-gatineau"
          : list.includes("ottawa")
            ? "ottawa"
            : list[0] ?? "ottawa-gatineau";
        setRegion(defaultRegion);
        setMapCenter(REGION_CENTERS[defaultRegion] ?? DEFAULT_CENTER);
        setLocationText(defaultRegion);
        await loadDashboard(defaultRegion);
        hasInitialized.current = true;
      } catch (error) {
        setStatus(formatApiError(error));
      }
    }

    init();
  }, []);

  function applyAreaPreset(areaKey) {
    const center = REGION_CENTERS[areaKey] ?? DEFAULT_CENTER;
    const clamped = clampCenterToAllowedCircle(center, maxCenterDistanceKm);
    ignoreNextMapMoveEnd.current = true;
    setRegion(areaKey);
    setLocationText(areaKey);
    setMapCenter(clamped);
  }

  function handleMapCenterChange(center) {
    if (ignoreNextMapMoveEnd.current) {
      ignoreNextMapMoveEnd.current = false;
      setMapCenter(clampCenterToAllowedCircle(center, maxCenterDistanceKm));
      return;
    }
    setMapCenter(clampCenterToAllowedCircle(center, maxCenterDistanceKm));
    setRegion("custom");
  }

  function toggleTech(tech) {
    setSelectedTechs((prev) => {
      if (prev.includes(tech)) {
        return prev.filter((item) => item !== tech);
      }
      // Prevent selecting all technologies at once.
      if (availableTechs.length > 0 && prev.length >= availableTechs.length - 1) {
        return prev;
      }
      return [...prev, tech];
    });
  }

  function toggleArea(area) {
    setSelectedAreas((prev) => {
      if (prev.includes(area)) {
        return prev.filter((item) => item !== area);
      }
      // Prevent selecting all areas at once.
      if (prev.length >= areaOptions.length - 1) {
        return prev;
      }
      return [...prev, area];
    });
  }

  function handleGoHome() {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function scrollToSection(ref) {
    ref?.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  useEffect(() => {
    setSelectedTechs((prev) => prev.filter((tech) => availableTechs.includes(tech)));
  }, [availableTechs]);

  useEffect(() => {
    setShowAllJobs(false);
  }, [jobsInMapArea, radiusKm, region, locationText, selectedAreas, selectedTechs]);

  useEffect(() => {
    setActiveAreaField(null);
  }, [jobsByField]);

  useEffect(() => {
    if (!hasInitialized.current) return;
    if (skipFirstFilterRefresh.current) {
      skipFirstFilterRefresh.current = false;
      return;
    }
    if (autoRefreshTimer.current) {
      clearTimeout(autoRefreshTimer.current);
    }
    autoRefreshTimer.current = setTimeout(() => {
      loadJobsOnly();
    }, 750);
    return () => {
      if (autoRefreshTimer.current) clearTimeout(autoRefreshTimer.current);
    };
  }, [region, locationText, selectedAreas, selectedTechs, loadJobsOnly]);

  return (
    <main className={`app-shell ${isSidebarOpen ? "" : "sidebar-collapsed"}`}>
      <aside className="sidebar">
        <div className="brand-row">
          <h1>
            <span className="brand-it">IT</span>
            <span className="brand-track">rack</span>
          </h1>
          <button
            type="button"
            className="menu-glyph"
            aria-label="Toggle sidebar"
            onClick={() => setIsSidebarOpen((prev) => !prev)}
          >
            ☰
          </button>
        </div>
        <p>Ottawa Tech Market Intelligence</p>

        <div className="sidebar-nav">
          <button type="button" className="sidebar-link active" onClick={handleGoHome}>
            <UiIcon name="home" /> Dashboard
          </button>
          <button type="button" className="sidebar-link" onClick={() => scrollToSection(topSectionRef)}>
            <UiIcon name="map" /> Map & Filters
          </button>
          <button type="button" className="sidebar-link" onClick={() => scrollToSection(jobsSectionRef)}>
            <UiIcon name="jobs" /> Job Listings
          </button>
          <button type="button" className="sidebar-link" onClick={() => scrollToSection(chartsSectionRef)}>
            <UiIcon name="charts" /> Charts
          </button>
          <button type="button" className="sidebar-link" onClick={() => scrollToSection(insightsSectionRef)}>
            <UiIcon name="insights" /> Insights
          </button>
        </div>
      </aside>

      <section className="dashboard">
        {!isSidebarOpen ? (
          <button
            type="button"
            className="sidebar-reopen"
            aria-label="Open sidebar"
            onClick={() => setIsSidebarOpen(true)}
          >
            ☰ Menu
          </button>
        ) : null}
        <QuickStatsStrip quickStats={quickStats} />

        <section className="panel top-workspace" ref={topSectionRef}>
          <div className="top-filters">
            <section className="top-left">
            <div className="map-and-info">
              <div className="map-circle-wrap">
                <MapContainer
                  center={[mapCenter.lat, mapCenter.lng]}
                  zoom={8}
                  minZoom={7}
                  maxZoom={12}
                  scrollWheelZoom={true}
                  zoomControl={false}
                  attributionControl={true}
                  style={{ height: "100%", width: "100%" }}
                >
                  <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  />
                  <MapRecenter center={mapCenter} />
                  <MapMoveTracker
                    onCenterChange={handleMapCenterChange}
                    maxDistanceKm={maxCenterDistanceKm}
                  />
                  <Marker position={[mapCenter.lat, mapCenter.lng]} icon={markerIcon} />
                  <Circle
                    center={[DEFAULT_CENTER.lat, DEFAULT_CENTER.lng]}
                    radius={ALLOWED_CENTER_RADIUS_KM * 1000}
                    pathOptions={{ color: "#ff7a7a", fill: false, weight: 1.2, dashArray: "6 4" }}
                  />
                  <Circle
                    center={[mapCenter.lat, mapCenter.lng]}
                    radius={radiusKm * 1000}
                    pathOptions={{ color: "#cf2e2e", fillColor: "#cf2e2e", fillOpacity: 0.18 }}
                  />
                </MapContainer>
              </div>

              <article className="map-info panel-inset">
                <h3>Map insights</h3>
                <p>Active area: {locationText || "Ottawa"} • radius {radiusKm} km</p>
                <p>Estimated coverage: ~{sampleAreaKm2} km²</p>
              </article>
            </div>
            </section>

            <section className="top-right">
            <div className="location-controls">
              <label>
                  Base location
                <input
                  type="text"
                  value={locationText}
                  readOnly
                  aria-readonly="true"
                />
              </label>

              <label>
                  Radius
                <select value={radiusKm} onChange={(e) => setRadiusKm(Number(e.target.value))}>
                  <option value={5}>5 km</option>
                  <option value={10}>10 km</option>
                  <option value={20}>20 km</option>
                  <option value={30}>30 km</option>
                  <option value={40}>40 km</option>
                  <option value={50}>50 km</option>
                  <option value={70}>70 km (max)</option>
                </select>
              </label>

              <div className="area-presets">
                {sortedRegionKeys.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={region === item ? "active" : ""}
                    onClick={() => applyAreaPreset(item)}
                    title={
                      item === "ottawa-gatineau"
                        ? "Includes Ottawa + Gatineau curated jobs (same as API region filter off)"
                        : undefined
                    }
                  >
                    {formatRegionPresetLabel(item)}
                  </button>
                ))}
              </div>
            </div>

            <div className="panel-inset tech-filter">
              <h4>Areas and Technologies</h4>
              <p>Select one or more areas. Technologies update based on selected areas.</p>
              <p className="tech-hint">
                Tip: leave <strong>all</strong> technology chips unselected to list every job in the chosen areas.
                Selecting techs filters to postings tagged with those stacks (e.g. “JavaScript” alone won’t match “React”
                unless both overlap).
              </p>
              <div className="area-chips">
                {areaOptions.map((area) => (
                  <button
                    key={area}
                    type="button"
                    className={selectedAreas.includes(area) ? "active" : ""}
                    onClick={() => toggleArea(area)}
                  >
                    {area}
                  </button>
                ))}
              </div>
              <div className="tech-chips">
                {availableTechs.length === 0 ? (
                  <span className="empty-techs">Select at least one area.</span>
                ) : (
                  availableTechs.map((tech) => (
                    <button
                      key={tech}
                      type="button"
                      className={selectedTechs.includes(tech) ? "active" : ""}
                      onClick={() => toggleTech(tech)}
                    >
                      {tech}
                    </button>
                  ))
                )}
              </div>
            </div>
            </section>
          </div>

          <section className="kpis">
            <article className="card metric">
              <h3>Total jobs</h3>
              <strong>{summary?.kpis?.totalJobs ?? "-"}</strong>
            </article>
            <article className="card metric">
              <h3>Remote</h3>
              <strong>{dynamicRemotePercentage}%</strong>
            </article>
            <article className="card metric">
              <h3>Median salary</h3>
              <strong>{formatCurrency(dynamicMedianSalary)}</strong>
            </article>
            <article className="card metric">
              <h3>Heat score</h3>
              <strong>{dynamicHeatScore}</strong>
            </article>
          </section>
        </section>

        <section ref={jobsSectionRef}>
          <JobsSection
            jobsInMapArea={jobsInMapArea}
            jobs={jobs}
            visibleJobs={visibleJobs}
            radiusKm={radiusKm}
            showAllJobs={showAllJobs}
            onToggleShowAll={() => setShowAllJobs((prev) => !prev)}
          />
        </section>

        <section ref={chartsSectionRef}>
          <ModularChartsSection
            lineChartLabels={lineChartLabels}
            areaTrendSeries={areaTrendSeries}
            topAreaRows={topAreaRows}
            topTechSignals={topTechSignals}
            remotePercentage={dynamicRemotePercentage}
          />
        </section>

        <section ref={insightsSectionRef}>
          <InsightsStudio
            insightTab={insightTab}
            topAreaRows={topAreaRows}
            activeAreaName={activeAreaName}
            onActiveAreaChange={setActiveAreaField}
            activeAreaCount={activeAreaCount}
            activeAreaPct={activeAreaPct}
            topTechSignals={topTechSignals}
            sparklinePoints={sparklinePoints}
            peakTrendDay={peakTrendDay}
          />
        </section>

      </section>
    </main>
  );
}

