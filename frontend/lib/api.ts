const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export async function uploadExcel(file: File) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_URL}/api/upload`, { method: "POST", body: form });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "업로드 실패");
  }
  return res.json();
}

export async function rollbackUpload(uploadId: string) {
  const res = await fetch(`${API_URL}/api/rollback/${uploadId}`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "롤백 실패");
  }
  return res.json();
}

export function getExportUrl(params: Record<string, string>) {
  const q = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v))
  );
  return `${API_URL}/api/export?${q.toString()}`;
}
