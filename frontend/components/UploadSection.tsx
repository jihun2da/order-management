"use client";
import { useState, useRef, useEffect } from "react";
import { uploadExcel } from "@/lib/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

interface UploadResult {
  upload_id?: string;
  inserted:   number;
  updated:    number;
  errors?:    string[];
}

interface Props { onSuccess: () => void; }

export default function UploadSection({ onSuccess }: Props) {
  const [file,       setFile]       = useState<File | null>(null);
  const [loading,    setLoading]    = useState(false);
  const [polling,    setPolling]    = useState(false);
  const [statusMsg,  setStatusMsg]  = useState("");
  const [result,     setResult]     = useState<UploadResult | null>(null);
  const [error,      setError]      = useState<string | null>(null);
  const inputRef  = useRef<HTMLInputElement>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // 언마운트 시 폴링 정리
  useEffect(() => () => {
    if (pollTimer.current) clearInterval(pollTimer.current);
  }, []);

  // 대용량 파일 처리 완료까지 폴링
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

          if (data.success) {
            setResult({
              upload_id: uploadId,
              inserted:  data.inserted ?? 0,
              updated:   data.updated  ?? 0,
            });
            setFile(null);
            if (inputRef.current) inputRef.current.value = "";
            onSuccess();
          } else {
            setError(data.error || "처리 실패");
          }
        } else {
          const rows = data.rows || 0;
          setStatusMsg(rows > 0 ? `처리 중... ${rows.toLocaleString()}행` : "처리 중...");
        }
      } catch {
        // 네트워크 오류 무시 (폴링 유지)
      }
    }, 2000);
  };

  const handleUpload = async () => {
    if (!file) return;
    setLoading(true);
    setResult(null);
    setError(null);
    setStatusMsg("");

    try {
      const res = await uploadExcel(file);

      if (res.processing) {
        // 대용량 → 폴링 시작
        startPolling(res.upload_id);
      } else {
        // 소용량 → 즉시 결과
        setLoading(false);
        setResult({
          upload_id: res.upload_id,
          inserted:  res.inserted ?? 0,
          updated:   res.updated  ?? 0,
          errors:    res.errors,
        });
        setFile(null);
        if (inputRef.current) inputRef.current.value = "";
        onSuccess();
      }
    } catch (e: unknown) {
      setLoading(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDownload = () => {
    if (!result?.upload_id) return;
    window.open(`${API_URL}/api/upload/${result.upload_id}/download`, "_blank");
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 max-w-2xl">
      <h2 className="font-semibold text-gray-700 mb-1">엑셀 업로드</h2>
      <p className="text-xs text-gray-400 mb-4">
        업로드 완료 후 고유번호가 기입된 파일을 다운로드할 수 있습니다.
      </p>

      <div className="flex items-center gap-3 flex-wrap">
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); setError(null); }}
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

      {/* 처리 중 표시 */}
      {loading && polling && (
        <div className="mt-3 flex items-center gap-2 text-sm text-blue-600 animate-pulse">
          <span className="inline-block animate-spin">⟳</span>
          <span>{statusMsg}</span>
        </div>
      )}

      {/* 오류 메시지 */}
      {error && (
        <div className="mt-3 px-3 py-2 rounded-lg text-sm bg-red-50 text-red-700 border border-red-200">
          {error}
        </div>
      )}

      {/* 성공 결과 + 다운로드 버튼 */}
      {result && (
        <div className="mt-3 px-4 py-3 rounded-lg bg-green-50 border border-green-200">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-sm text-green-700 font-medium">
              완료 — 신규 {result.inserted.toLocaleString()}건, 수정 {result.updated.toLocaleString()}건
              {result.errors?.length ? ` (오류 ${result.errors.length}건)` : ""}
            </span>
            {result.upload_id && (
              <button
                onClick={handleDownload}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white text-xs rounded-lg font-medium hover:bg-green-700 transition shadow-sm"
              >
                <span>📥</span>
                <span>고유번호 엑셀 다운로드</span>
              </button>
            )}
          </div>
          {result.errors && result.errors.length > 0 && (
            <div className="mt-2 text-xs text-orange-600">
              {result.errors.slice(0, 5).map((e, i) => <div key={i}>• {e}</div>)}
              {result.errors.length > 5 && <div>… 외 {result.errors.length - 5}건</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
