"use client";
import { useState, useRef } from "react";
import { uploadExcel } from "@/lib/api";

interface Props { onSuccess: () => void; }

export default function UploadSection({ onSuccess }: Props) {
  const [file,    setFile]    = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [result,  setResult]  = useState<{ success: boolean; msg: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleUpload = async () => {
    if (!file) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await uploadExcel(file);
      setResult({
        success: true,
        msg: `완료 — 신규 ${res.inserted}건, 수정 ${res.updated}건${
          res.errors?.length ? ` (오류 ${res.errors.length}건)` : ""
        }`,
      });
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      onSuccess();
    } catch (e: unknown) {
      setResult({ success: false, msg: String(e instanceof Error ? e.message : e) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <h2 className="font-semibold text-gray-700 mb-3">엑셀 업로드</h2>
      <div className="flex items-center gap-3 flex-wrap">
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-sm file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 cursor-pointer"
        />
        <button
          onClick={handleUpload}
          disabled={!file || loading}
          className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded-lg font-medium hover:bg-blue-700 disabled:opacity-40 transition"
        >
          {loading ? "처리 중..." : "업로드 실행"}
        </button>
      </div>

      {result && (
        <div className={`mt-3 px-3 py-2 rounded-lg text-sm ${
          result.success
            ? "bg-green-50 text-green-700 border border-green-200"
            : "bg-red-50 text-red-700 border border-red-200"
        }`}>
          {result.msg}
        </div>
      )}
    </div>
  );
}
