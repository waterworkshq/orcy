/**
 * Transport seam — shared HTTP helpers used by the API client and (in Phase 2)
 * by per-domain modules. Owns auth-header injection, JSON content-type defaults,
 * base-path prefixing, error parsing, blob downloads, and XHR uploads.
 */
export type RequestOptions = RequestInit;

const BASE = "/api";

/**
 * Error thrown when the server returns a non-2xx response. Carries the HTTP
 * status so callers (e.g. react-query retry predicates) can branch on it
 * without resorting to `error: any`.
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function getToken(): string | null {
  return localStorage.getItem("orcy_token");
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${path.startsWith("/sse") ? "" : BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(
      (body as { error?: string }).error ?? `HTTP ${res.status}`,
      res.status,
    );
  }

  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
}

async function requestBlob(
  path: string,
  options: RequestInit = {},
): Promise<{ blob: Blob; headers: Headers }> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(
      (body as { error?: string }).error ?? `HTTP ${res.status}`,
      res.status,
    );
  }

  const blob = await res.blob();
  return { blob, headers: res.headers };
}

async function uploadFile<T>(
  path: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<T> {
  const token = getToken();
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE}${path}`);
    if (token) {
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    }

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as T);
        } catch {
          resolve({} as T);
        }
      } else {
        try {
          const body = JSON.parse(xhr.responseText);
          reject(new ApiError(body.error ?? `HTTP ${xhr.status}`, xhr.status));
        } catch {
          reject(new ApiError(`HTTP ${xhr.status}`, xhr.status));
        }
      }
    });

    xhr.addEventListener("error", () => reject(new Error("Upload failed")));
    xhr.addEventListener("abort", () => reject(new Error("Upload aborted")));

    const formData = new FormData();
    formData.append("file", file);
    xhr.send(formData);
  });
}

export { request, requestBlob, uploadFile };
