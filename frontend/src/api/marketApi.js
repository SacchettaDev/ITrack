import { getMarketApiBaseUrl } from "./config";

function marketUrl(path) {
  const base = getMarketApiBaseUrl();
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

/**
 * User-facing hint when fetch fails (network / backend down / wrong URL).
 */
export function formatApiError(error) {
  if (error instanceof TypeError && String(error.message).toLowerCase().includes("fetch")) {
    return [
      "Cannot reach the ITrack API.",
      "• Backend: cd backend/ITrack.api && dotnet run  (port 5106)",
      "• Frontend: npm run dev  (port 5173; /api is proxied to the backend)",
      "• Custom URL: set VITE_API_BASE_URL in frontend/.env"
    ].join("\n");
  }
  return error?.message ?? "Request failed";
}

async function readJsonOrThrow(res) {
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      detail = j.message ?? j.title ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(`API ${res.status}: ${detail}`);
  }
  if (!text) return null;
  return JSON.parse(text);
}

export async function pingMarket() {
  const res = await fetch(marketUrl("/ping"));
  return readJsonOrThrow(res);
}

export async function fetchRegions() {
  const res = await fetch(marketUrl("/regions"));
  const data = await readJsonOrThrow(res);
  return Array.isArray(data) ? data : data?.value ?? [];
}

export async function fetchSummary(region, days, areas) {
  const q = new URLSearchParams({
    region,
    days: String(days)
  });
  if (areas?.length) {
    q.set("areas", areas.join(","));
  }
  const res = await fetch(`${marketUrl("/summary")}?${q.toString()}`);
  return readJsonOrThrow(res);
}

export async function fetchJobs({
  region,
  location,
  center,
  radiusKm,
  days,
  areas,
  techs
}) {
  const lat = Number(center?.lat);
  const lng = Number(center?.lng);
  const safeLat = Number.isFinite(lat) ? lat : 45.4215;
  const safeLng = Number.isFinite(lng) ? lng : -75.6972;

  const params = new URLSearchParams({
    region,
    location,
    centerLat: String(safeLat),
    centerLng: String(safeLng),
    radiusKm: String(radiusKm),
    days: String(days)
  });
  if (areas?.length) {
    params.set("areas", areas.join(","));
  }
  if (techs?.length) {
    params.set("techs", techs.join(","));
  }

  const res = await fetch(`${marketUrl("/jobs")}?${params.toString()}`);
  return readJsonOrThrow(res);
}
