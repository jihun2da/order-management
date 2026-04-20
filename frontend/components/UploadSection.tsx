"use client";
import { useState, useRef, useEffect } from "react";
import { uploadExcel } from "@/lib/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

interface UploadResult {
  uploadId: string;
  inserted: number;
  updated:  number;
  errors?:  string[];
}

interface Props {
  onSuccess: () => void;
  /** 업로드 완료 시 결과를 부모(page)에 전달 — 탭에 관계없이 배너 표시용 */
  onUploadComplete?: (result: UploadResult) => void;
}

export default function UploadSection({ onSuccess, onUploadComplete }: Props) {
  const [file,      setFile]      = useState<File | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [polling,   setPolling]   = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [error,     setError]     = useState<string | null>(null);
  const inputRef  = useRef<HTMLInputElement>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // 언마운트 시 폴링 정리
  useEffect(() => () => {
    if (pollTimer.current) clearInterval(pollTimer.current);
  }, []);

  const notifyComplete = (uploadId: string, inserted: number, updated: number, errors?: string[]) => {
    onUploadComplete?.({ uploadId, inserted, updated, errors });
    onSuccess();
  };

  // 대용량 파일 — 폴링으로 완료 대기
  const startPolling = (uploadId: string) => {
    setPolling(true);
    setStatusMsg("처리 중...");
    pollTimer.current = setInterval(async () => {
      try {
        const res  = await fetch(`${API_URL}/api/upload/status/${uploadId}`);
        const data = await res.json();
        if (!data.processing) {
          clearInterval(pollTimer.current!);
          setPolling(false);
          setLoading(false);
          setFile(null);
          if (inputRef.current) inputRef.current.value = "";
          if (data.success) {
            notifyComplete(uploadId, data.inserted ?? 0, data.updated ?? 0);
          } else {
            setError(data.error || "처리 실패");
          }
        } else {
          const rows = data.rows || 0;
          setStatusMsg(rows > 0 ? `처리 중... ${rows.toLocaleString()}행` : "처리 중...");
        }
      } catch {
        // 네트워크 오류 — 폴링 유지
      }
    }, 2000);
  };

  const handleUpload = async () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    setStatusMsg("");

    try {
      const res = await uploadExcel(file);
      if (res.processing) {
        startPolling(res.upload_id);
      } else {
        setLoading(false);
        setFile(null);
        if (inputRef.current) inputRef.current.value = "";
        notifyComplete(res.upload_id, res.inserted ?? 0, res.updated ?? 0, res.errors);
      }
    } catch (e: unknown) {
      setLoading(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 max-w-2xl">
      <h2 className="font-semibold text-gray-700 mb-1">엑셀 업로드</h2>
      <p className="text-xs text-gray-400 mb-4">
        업로드 완료 후 상단에 나타나는 배너에서 고유번호 엑셀을 다운로드하세요.
      </p>

      <div className="flex items-center gap-3 flex-wrap">
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }}
          className="text-sm file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 cursor-pointer"
        />
        <button
          onClick={handleUpload}
          disabled={!file || loading}
          className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded-lg font-medium hover:bg-blue-700 disabled:opacity-40 transition"
        >
          {loading ? (polling ? statusMsg : "업로드 중...") : "업로드 실행"}
        </button>
      </div>

      {loading && polling && (
        <div className="mt-3 flex items-center gap-2 text-sm text-blue-600 animate-pulse">
          <span className="animate-spin inline-block">⟳</span>
          <span>{statusMsg}</span>
        </div>
      )}

      {error && (
        <div className="mt-3 px-3 py-2 rounded-lg text-sm bg-red-50 text-red-700 border border-red-200">
          {error}
        </div>
      )}
    </div>
  );
}
