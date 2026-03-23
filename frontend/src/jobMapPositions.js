/**
 * Filtro do círculo azul:
 * - Cada vaga tem um ponto estável na Terra (não “preso” ao pin ao mover o mapa).
 * - Âncora: coords da API, ou cidade do texto (Ottawa, Kanata…), ou ponto fixo na NCR derivado do job.id (remote/genérico).
 * - Espalhamento determinístico (~60% perto da âncora, ~40% mais longe) só a partir dessa âncora — nunca polar em volta do centro do mapa.
 * Assim as vagas espalham e mover o círculo continua a filtrar bem.
 */

const NCR_ORIGIN = { lat: 45.4425, lng: -75.7036 };
const MAX_REGION_KM = 70;
/** Raio máximo do select na UI (km) — com este valor, pontos logo fora do círculo são puxados para dentro. */
export const MAX_UI_SEARCH_RADIUS_KM = 70;

const LOCATION_HINTS = [
  { test: /\b(hull|aylmer|masson|buckingham|chelsea|cantley)\b/i, ll: { lat: 45.48, lng: -75.78 } },
  { test: /\bgatineau\b/i, ll: { lat: 45.4765, lng: -75.7013 } },
  { test: /\bkanata\b/i, ll: { lat: 45.3091, lng: -75.9137 } },
  { test: /\bnepean\b/i, ll: { lat: 45.346, lng: -75.77 } },
  { test: /\borl[ée]ans\b/i, ll: { lat: 45.469, lng: -75.515 } },
  { test: /\bgloucester\b/i, ll: { lat: 45.434, lng: -75.61 } },
  { test: /\bbarrhaven\b/i, ll: { lat: 45.266, lng: -75.749 } },
  { test: /\bstittsville\b/i, ll: { lat: 45.26, lng: -75.92 } },
  { test: /\b(carp|manotick|rockland|arnprior|kemptville|smiths\s*falls|perth|carleton\s*place|prescott)\b/i, ll: { lat: 45.35, lng: -75.92 } },
  { test: /\bottawa\b/i, ll: { lat: 45.4215, lng: -75.6972 } },
  { test: /\bon,?\s*canada\b|\bon\b.*\bcanada\b/i, ll: { lat: 45.4215, lng: -75.6972 } },
  { test: /\bcanada\b|\bremote\b|\bhybrid\b|\bwork\s*from\s*home\b/i, ll: null }
];

export function distanceKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function idHash(id) {
  let h = 2166136261;
  const s = String(id ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function offsetLatLng(lat, lng, distMeters, angleRad) {
  const dx = Math.cos(angleRad) * distMeters;
  const dy = Math.sin(angleRad) * distMeters;
  const dLat = dy / 111320;
  const dLng = dx / (111320 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dLat, lng: lng + dLng };
}

function clampInsideCircle(center, radiusKm, point) {
  const d = distanceKm(center, point);
  if (d <= radiusKm || d < 1e-6) return point;
  const t = radiusKm / d;
  return {
    lat: center.lat + (point.lat - center.lat) * t,
    lng: center.lng + (point.lng - center.lng) * t
  };
}

function clampNcr(point) {
  let p = point;
  if (distanceKm(NCR_ORIGIN, p) > MAX_REGION_KM * 1.08) {
    p = clampInsideCircle(NCR_ORIGIN, MAX_REGION_KM * 0.98, p);
  }
  return p;
}

export function guessLatLngFromLocation(locationText, fallbackCenter) {
  const t = locationText || "";
  for (const { test, ll } of LOCATION_HINTS) {
    if (!test.test(t)) continue;
    if (ll) return { ...ll };
    break;
  }
  return { lat: fallbackCenter.lat, lng: fallbackCenter.lng };
}

function isGatineauLocationText(locationText) {
  return /\b(hull|aylmer|masson|buckingham|chelsea|cantley|gatineau)\b/i.test(locationText || "");
}

/** Ottawa/ON genérico: ~35% espalha pela NCR para o círculo filtrar de verdade (senão todas ficam a ≤12km do centro). */
const OTTAWA_CENTER = { lat: 45.4215, lng: -75.6972 };

/** Ponto base fixo por vaga (não depende do centro do mapa). */
function resolveEarthAnchor(job) {
  let lat = job.latitude;
  let lng = job.longitude;
  if (typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng)) {
    return clampNcr({ lat, lng });
  }
  const text = job.location || "";
  for (const { test, ll } of LOCATION_HINTS) {
    if (!test.test(text)) continue;
    if (ll) {
      const isGenericOttawa =
        Math.abs(ll.lat - OTTAWA_CENTER.lat) < 0.002 && Math.abs(ll.lng - OTTAWA_CENTER.lng) < 0.002;
      if (isGenericOttawa && (idHash(`${job.id}:anch`) % 100) < 35) {
        return stableNcrPointFromJobId(job.id);
      }
      return { ...ll };
    }
    break;
  }
  return stableNcrPointFromJobId(job.id);
}

/**
 * Remote / texto vago: posição estável diferente por vaga, espalhada na NCR (sempre a mesma para aquele id).
 */
function stableNcrPointFromJobId(jobId) {
  const t = (idHash(`${jobId}:ncrR`) % 10001) / 10001;
  const u = (idHash(`${jobId}:ncrW`) % 10001) / 10001;
  const rKm = 2.2 + t * (MAX_REGION_KM * 0.94 - 2.2);
  const ang = u * 2 * Math.PI;
  return clampNcr(offsetLatLng(NCR_ORIGIN.lat, NCR_ORIGIN.lng, rKm * 1000, ang));
}

/** ~60% perto da âncora; ~40% mais longe. Gatineau: anel pequeno. */
function spreadMetersFromAnchor(jobId, locationText) {
  const gat = isGatineauLocationText(locationText);
  const hBand = idHash(`${jobId}:sprB`) % 100;
  const t = (idHash(`${jobId}:sprT`) % 10001) / 10001;
  if (gat) {
    const max = 780;
    if (hBand < 60) return 35 + t * 0.48 * max;
    return 35 + (0.48 + t * 0.52) * max;
  }
  if (hBand < 60) {
    return 45 + t * 2400;
  }
  return 1750 + t * 10200;
}

/**
 * Ponto usado no filtro (estável na Terra + jitter a partir da âncora).
 * Com raio máximo (70 km), se o ponto cair logo fora do círculo (espalhamento + centro do mapa ≠ NCR), projeta para dentro.
 */
export function getJobCoordinates(job, mapCenter, searchRadiusKm = null) {
  const anchor = resolveEarthAnchor(job);
  const meters = spreadMetersFromAnchor(job.id, job.location);
  const ang = ((idHash(`${job.id}:sprA`) % 1000000) / 1000000) * 2 * Math.PI;
  let p = clampNcr(offsetLatLng(anchor.lat, anchor.lng, meters, ang));

  const R =
    mapCenter && typeof searchRadiusKm === "number" && Number.isFinite(searchRadiusKm)
      ? searchRadiusKm
      : null;
  if (
    R != null &&
    R >= MAX_UI_SEARCH_RADIUS_KM - 0.5 &&
    distanceKm(mapCenter, p) > R
  ) {
    p = clampInsideCircle(mapCenter, Math.max(0.5, R * 0.997), p);
  }
  return p;
}

export function filterJobsBySearchCircle(jobs, mapCenter, radiusKm) {
  if (!jobs?.length) return [];
  if (!mapCenter || radiusKm == null || radiusKm <= 0) return [];
  return jobs.filter((job) => {
    const p = getJobCoordinates(job, mapCenter, radiusKm);
    return distanceKm(mapCenter, p) <= radiusKm;
  });
}

export { NCR_ORIGIN, MAX_REGION_KM };
