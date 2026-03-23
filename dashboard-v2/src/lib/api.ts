const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('jarvis_token');
}

function clearAuth() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('jarvis_token');
  window.location.href = '/v2/login';
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401) {
    clearAuth();
    throw new ApiError('Unauthorized', 401);
  }
  if (!res.ok) {
    throw new ApiError(`API error: ${res.statusText}`, res.status);
  }
  return res.json();
}

export async function apiPost<T = unknown>(path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    clearAuth();
    throw new ApiError('Unauthorized', 401);
  }
  if (!res.ok) {
    throw new ApiError(`API error: ${res.statusText}`, res.status);
  }
  return res.json();
}

export function isAuthenticated(): boolean {
  return !!getToken();
}

export function logout() {
  clearAuth();
}
