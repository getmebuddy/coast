/**
 * Minimal JSON fetch helpers for the Subscription Action Center UI.
 *
 * Envelope: { ok: true, data } / { ok: false, error, message }.
 * No offline submit: these throw on network failure; callers show an error
 * and never claim the action was recorded.
 */

export class ApiError extends Error {
  error: string;
  status: number;

  constructor(error: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.error = error;
    this.status = status;
  }
}

interface Envelope<T> {
  ok?: boolean;
  data?: T;
  error?: string;
  message?: string;
}

async function parse<T>(res: Response): Promise<T> {
  let json: Envelope<T> | null = null;
  try {
    json = (await res.json()) as Envelope<T>;
  } catch {
    json = null;
  }
  if (!res.ok || !json || json.ok !== true) {
    throw new ApiError(
      json?.error ?? "request_failed",
      json?.message ?? `Request failed (HTTP ${res.status}).`,
      res.status
    );
  }
  return json.data as T;
}

export function getJSON<T>(url: string): Promise<T> {
  return fetch(url, { credentials: "same-origin" }).then(parse<T>);
}

export function postJSON<T>(url: string, body?: unknown): Promise<T> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(parse<T>);
}

export function patchJSON<T>(url: string, body: unknown): Promise<T> {
  return fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  }).then(parse<T>);
}
