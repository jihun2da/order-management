"use client";
import { useState } from "react";
import { UploadHistory as UH } from "@/lib/types";
import { rollbackUpload } from "@/lib/api";

interface Props { history: UH[]; onRollback: () => void; }

export default function UploadHistoryPanel({ history, onRollback }: Props) {
  const [loading, setLoading] = useState<string | null>(null);
  const [msg,     setMsg]     = useState<string | null>(null);

  const handleRollback = async (id: string, filename: string) => {
    if (!confirm(`"${filename}" 업로드를 롤백하면 해당 업로드로 생성된 주문이 모두 삭제됩니다.\n계속하시겠습니까?`)) return;
    setLoading(id);
    setMsg(null);
    try {
      const res = await rollbackUpload(id);
      setMsg(`롤백 완료 — ${res.deleted}건 삭제`);
      onRollback();
    } catch (e: unknown) {
      setMsg(`롤백 실패: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLoading(null);
    }
  };

  const statusColor = (s: string) => {
    if (s === "완료")      return "text-green-600";
    if (s === "실패")      return "text-red-600";
    if (s === "롤백완료")  return "text-gray-400";
    return "text-yellow-600";
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <h2 className="font-semibold text-gray-700 mb-3">업로드 이력 / 롤백</h2>
      {msg && (
        <div className="mb-3 px-3 py-2 rounded-lg text-sm bg-blue-50 text-blue-700 border border-blue-200">
          {msg}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              {["파일명","업로드일","상태","처리","신규","수정","롤백"].map((h) => (
                <th key={h} className="px-3 py-2 text-left font-semibold text-gray-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {history.length === 0 ? (
              <tr><td colSpan={7} className="text-center py-6 text-gray-400">업로드 이력이 없습니다.</td></tr>
            ) : (
              history.map((h) => (
                <tr key={h.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-1.5 max-w-[200px] truncate" title={h.filename}>{h.filename}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{h.upload_date.replace("T", " ").slice(0, 16)}</td>
                  <td className={`px-3 py-1.5 font-medium ${statusColor(h.status)}`}>{h.status}</td>
                  <td className="px-3 py-1.5">{h.rows_processed}</td>
                  <td className="px-3 py-1.5">{h.rows_inserted}</td>
                  <td className="px-3 py-1.5">{h.rows_updated}</td>
                  <td className="px-3 py-1.5">
                    {h.status === "완료" || h.status === "완료(오류있음)" ? (
                      <button
                        onClick={() => handleRollback(h.id, h.filename)}
                        disabled={loading === h.id}
                        className="px-2 py-0.5 bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100 disabled:opacity-40 transition text-xs"
                      >
                        {loading === h.id ? "처리중..." : "롤백"}
                      </button>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
