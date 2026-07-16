export interface ApiError {
  code: string;
  message: string;
  details: Record<string, unknown> | null;
}

export interface Envelope<T> {
  data: T | null;
  meta: Record<string, unknown> | null;
  error: ApiError | null;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`/api/v1${path}`, init);
  const body = (await resp.json()) as Envelope<T>;
  if (!resp.ok || body.error) {
    throw new Error(body.error?.message ?? `Request failed: ${resp.status}`);
  }
  return body.data as T;
}
