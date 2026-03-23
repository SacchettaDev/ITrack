/**
 * Base URL for market API routes.
 * - Dev (default): relative "/api/market" — Vite proxies to the backend (see vite.config.js).
 * - Override: set VITE_API_BASE_URL in .env (e.g. http://localhost:5106/api/market for no proxy).
 */
export function getMarketApiBaseUrl() {
  const raw = import.meta.env.VITE_API_BASE_URL;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim().replace(/\/+$/, "");
  }
  return "/api/market";
}
