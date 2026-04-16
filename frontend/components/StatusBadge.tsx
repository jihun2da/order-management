"use client";
import { useState, useRef, useEffect } from "react";
import { OrderStatus, STATUS_LIST, STATUS_COLORS } from "@/lib/types";
import { supabase } from "@/lib/supabase";

interface Props {
  itemId:        string;
  currentStatus: OrderStatus;
  onUpdated:     (newStatus: OrderStatus) => void;
}

export default function StatusBadge({ itemId, currentStatus, onUpdated }: Props) {
  const [open,    setOpen]    = useState(false);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const colors = STATUS_COLORS[currentStatus] || STATUS_COLORS["입고대기"];

  // 바깥 클릭 시 닫기
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSelect = async (newStatus: OrderStatus) => {
    if (newStatus === currentStatus) { setOpen(false); return; }
    setLoading(true);
    setOpen(false);
    try {
      // Supabase RPC로 상태 변경 (변경 이력 자동 기록)
      await supabase.rpc("update_item_status", {
        p_item_id:    itemId,
        p_new_status: newStatus,
      });
      onUpdated(newStatus);
    } catch (e) {
      console.error("상태 변경 실패:", e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={loading}
        className={`status-cell px-2 py-0.5 rounded-full text-xs font-semibold ${colors.bg} ${colors.text} border border-transparent hover:border-gray-300 transition`}
        title="클릭하여 상태 변경"
      >
        {loading ? "…" : currentStatus}
      </button>

      {open && (
        <div className="absolute z-50 mt-1 left-0 bg-white border border-gray-200 rounded-lg shadow-lg min-w-[100px]">
          {STATUS_LIST.map((s) => {
            const c = STATUS_COLORS[s];
            return (
              <button
                key={s}
                onClick={() => handleSelect(s)}
                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 first:rounded-t-lg last:rounded-b-lg ${
                  s === currentStatus ? "font-bold" : ""
                }`}
              >
                <span className={`inline-block px-2 py-0.5 rounded-full ${c.bg} ${c.text}`}>{s}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
