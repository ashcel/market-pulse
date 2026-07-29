import { createServerFn } from "@tanstack/react-start";
// Assuming there's some utility. Or we can just use the absolute URL or localhost if running locally
// In production, the backend is on a specific port or proxied.
// Let's check how other server functions fetch.

export const fetchHealthServer = createServerFn({ method: "GET" }).handler(async () => {
  try {
    // If not using getBackendUrl, let's just fetch localhost:3000 or from environment
    const baseUrl = process.env.VITE_API_URL || "http://127.0.0.1:8002";
    const res = await fetch(`${baseUrl}/api/v1/health`);
    if (!res.ok) {
      return { status: "unknown", environment: "local", version: "unknown" };
    }
    const data = await res.json();
    return data.data;
  } catch (error) {
    return { status: "error", environment: "local", version: "unknown" };
  }
});
