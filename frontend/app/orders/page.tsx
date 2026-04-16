"use client";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { getExportUrl } from "@/lib/api";
import { OrderRow, OrderStatus, UploadHistory, Filters, STATUS_LIST } from "@/lib/types";
import OrderTable         from "@/components/OrderTable";
import UploadSection      from "@/components/UploadSection";
import UploadHistoryPanel from "@/components/UploadHistory";

const ALL_COLUMN_KEYS = [
  "manager_code","barcode","order_date","buyer_user_id_ref","order_no",
  "buyer_name","consignor_name","brand","product_name","color","size",
  "quantity","options","wholesale_price","supplier","item_notes",
  "recipient_name","phone","address","buyer_user_id","delivery_msg",
  "item_code","item_status","status_history","change_log",
];
const COLUMN_LABELS: Record<string, string> = {
  manager_code:"알파벳", barcode:"미등록주문", order_date:"주문일",
  buyer_user_id_ref:"아이디(주문)", order_no:"고유번호",
  buyer_name:"주문자명", consignor_name:"위탁자명", brand:"브랜드",
  product_name:"상품명", color:"색상", size:"사이즈", quantity:"수량",
  options:"상가", wholesale_price:"도매가", supplier:"미송",
  item_notes:"비고", recipient_name:"이름", phone:"전화번호",
  address:"주소", buyer_user_id:"아이디(구매)", delivery_msg:"배송메세지",
  item_code:"코드", item_status:"상품상태", status_history:"상태이력",
  change_log:"변경내용",
};

const PAGE_SIZE = 1000; // Supabase 기본 최대값

export default function OrdersPage() {
  const router = useRouter();
  const [rows,        setRows]        = useState<OrderRow[]>([]);
  const [history,     setHistory]     = useState<UploadHistory[]>([]);
  const [managers,    setManagers]    = useState<string[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [loadedCount, setLoadedCount] = useState(0);
  const [totalCount,  setTotalCount]  = useState(0);
  const [search,      setSearch]      = useState("");
  const [filters,     setFilters]     = useState<Filters>({
    manager: "", status: "", start_date: "", end_date: ""
  });
  const [visibleCols,    setVisibleCols]    = useState<string[]>(ALL_COLUMN_KEYS);
  const [showColMenu,    setShowColMenu]    = useState(false);
  const [tab,            setTab]            = useState<"orders"|"upload"|"history">("orders");
  // ── 상태 토글 필터 (처음엔 전부 ON) ──
  const [activeStatuses, setActiveStatuses] = useState<Set<OrderStatus>>(new Set(STATUS_LIST));

  // ── 인증 확인 ──
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) router.replace("/login");
    });
  }, [router]);

  // ── 담당자 목록 로드 ──
  useEffect(() => {
    supabase.from("managers").select("code").eq("is_active", true)
      .order("code").then(({ data }) => {
        if (data) setManagers(data.map((m) => m.code));
      });
  }, []);

  // ── 주문 데이터 전체 로드 (1000행씩 청크, 순차 fetch) ──
  const loadOrders = useCallback(async () => {
    setLoading(true);
    setRows([]);
    setLoadedCount(0);
    setTotalCount(0);

    try {
      // 1단계: 전체 행 수 파악
      let countQ = supabase.from("orders_full").select("*", { count: "exact", head: true });
      if (filters.manager)    countQ = countQ.eq("manager_code", filters.manager);
      if (filters.status)     countQ = countQ.eq("item_status",  filters.status);
      if (filters.start_date) countQ = countQ.gte("order_date",  filters.start_date);
      if (filters.end_date)   countQ = countQ.lte("order_date",  filters.end_date);
      const { count } = await countQ;
      const total = count ?? 0;
      setTotalCount(total);

      if (total === 0) { setLoading(false); return; }

      // 2단계: 병렬 fetch (최대 5개 동시)
      const allRows: OrderRow[] = new Array(total);
      const pageCount = Math.ceil(total / PAGE_SIZE);
      const CONCURRENCY = 5;

      for (let batch = 0; batch < pageCount; batch += CONCURRENCY) {
        const batchPages = Array.from(
          { length: Math.min(CONCURRENCY, pageCount - batch) },
          (_, i) => batch + i
        );

        await Promise.all(batchPages.map(async (page) => {
          const from = page * PAGE_SIZE;
          const to   = Math.min(from + PAGE_SIZE - 1, total - 1);

          let q = supabase.from("orders_full").select("*");
          if (filters.manager)    q = q.eq("manager_code", filters.manager);
          if (filters.status)     q = q.eq("item_status",  filters.status);
          if (filters.start_date) q = q.gte("order_date",  filters.start_date);
          if (filters.end_date)   q = q.lte("order_date",  filters.end_date);
          q = q.order("order_date", { ascending: false }).range(from, to);

          const { data, error } = await q;
          if (error) throw error;
          if (data) {
            for (let i = 0; i < data.length; i++) allRows[from + i] = data[i] as OrderRow;
          }
        }));

        const loaded = Math.min((batch + CONCURRENCY) * PAGE_SIZE, total);
        setLoadedCount(loaded);
        // 점진적 업데이트: 처음 5000행 로드 후 미리 표시
        if (batch === 0) setRows(allRows.filter(Boolean).slice(0, loaded));
      }

      setRows(allRows.filter(Boolean) as OrderRow[]);
    } catch (e) {
      console.error("데이터 로드 실패:", e);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  // ── 업로드 이력 로드 ──
  const loadHistory = useCallback(async () => {
    const { data } = await supabase
      .from("upload_history")
      .select("*")
      .order("upload_date", { ascending: false })
      .limit(50);
    setHistory((data as UploadHistory[]) || []);
  }, []);

  useEffect(() => { loadOrders(); }, [loadOrders]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  // ── 상태 토글 ──
  const toggleStatus = useCallback((s: OrderStatus) => {
    setActiveStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }, []);

  // ── 로그아웃 ──
  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.replace("/login");
  };

  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      // 상태 토글 필터
      if (!activeStatuses.has(r.item_status)) return false;
      // 텍스트 검색
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return Object.values(r).some((v) => String(v ?? "").toLowerCase().includes(q));
    });
  }, [rows, search, activeStatuses]);

  const loadingLabel = totalCount > 0
    ? `로딩 중... ${loadedCount.toLocaleString()} / ${totalCount.toLocaleString()}행`
    : "데이터 로딩 중...";

  return (
    <div className="flex flex-col min-h-screen">
      {/* ── 상단 헤더 ── */}
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between sticky top-0 z-20 shadow-sm">
        <h1 className="text-lg font-bold text-gray-800">주문 관리 시스템</h1>
        <div className="flex items-center gap-3">
          <a
            href={getExportUrl({
              manager: filters.manager,
              status:  filters.status,
              start:   filters.start_date,
              end:     filters.end_date,
            })}
            className="px-3 py-1.5 bg-green-600 text-white text-sm rounded-lg font-medium hover:bg-green-700 transition"
          >
            엑셀 다운로드
          </a>
          <button
            onClick={handleLogout}
            className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg transition"
          >
            로그아웃
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* ── 사이드바 필터 ── */}
        <aside className="w-56 bg-white border-r border-gray-200 p-4 flex flex-col gap-4 overflow-y-auto shrink-0">
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">담당자</label>
            <select
              value={filters.manager}
              onChange={(e) => setFilters((f) => ({ ...f, manager: e.target.value }))}
              className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm"
            >
              <option value="">전체</option>
              {managers.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">상품상태</label>
            <select
              value={filters.status}
              onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
              className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm"
            >
              <option value="">전체</option>
              {STATUS_LIST.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">주문일 시작</label>
            <input type="date" value={filters.start_date}
              onChange={(e) => setFilters((f) => ({ ...f, start_date: e.target.value }))}
              className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">주문일 종료</label>
            <input type="date" value={filters.end_date}
              onChange={(e) => setFilters((f) => ({ ...f, end_date: e.target.value }))}
              className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm"
            />
          </div>
          <button
            onClick={() => setFilters({ manager:"", status:"", start_date:"", end_date:"" })}
            className="text-xs text-blue-600 hover:underline text-left"
          >
            필터 초기화
          </button>

          {/* 로딩 진행률 */}
          {loading && totalCount > 0 && (
            <div className="mt-2">
              <div className="text-xs text-gray-500 mb-1">{loadingLabel}</div>
              <div className="w-full bg-gray-200 rounded-full h-1.5">
                <div
                  className="bg-blue-500 h-1.5 rounded-full transition-all"
                  style={{ width: `${Math.round((loadedCount / totalCount) * 100)}%` }}
                />
              </div>
            </div>
          )}
        </aside>

        {/* ── 메인 컨텐츠 ── */}
        <main className="flex-1 p-4 overflow-hidden flex flex-col">
          {/* 탭 */}
          <div className="flex gap-1 mb-4 border-b border-gray-200 shrink-0">
            {(["orders","upload","history"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition ${
                  tab === t ? "border-blue-500 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                {{ orders:"주문 목록", upload:"엑셀 업로드", history:"업로드 이력" }[t]}
              </button>
            ))}
          </div>

          {tab === "orders" && (
            <div className="flex flex-col flex-1 min-h-0 gap-3">
              {/* 검색 + 컬럼 선택 */}
              <div className="flex items-center gap-3 flex-wrap shrink-0">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="주문자명 / 고유번호 / 상품명 등 검색..."
                  className="flex-1 min-w-[200px] border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                />
                <div className="relative">
                  <button
                    onClick={() => setShowColMenu((v) => !v)}
                    className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50"
                  >
                    컬럼 선택 ▾
                  </button>
                  {showColMenu && (
                    <div className="absolute right-0 top-9 z-30 bg-white border border-gray-200 rounded-xl shadow-lg p-3 w-64 grid grid-cols-2 gap-1">
                      {ALL_COLUMN_KEYS.map((k) => (
                        <label key={k} className="flex items-center gap-1 text-xs cursor-pointer">
                          <input
                            type="checkbox"
                            checked={visibleCols.includes(k)}
                            onChange={(e) =>
                              setVisibleCols((prev) =>
                                e.target.checked ? [...prev, k] : prev.filter((c) => c !== k)
                              )
                            }
                          />
                          {COLUMN_LABELS[k]}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {loading && rows.length === 0
                ? <div className="text-center py-16 text-gray-400">{loadingLabel}</div>
                : <OrderTable
                    rows={filteredRows}
                    globalFilter={search}
                    visibleColumns={visibleCols}
                    isLoadingMore={loading}
                    totalCount={totalCount}
                    activeStatuses={activeStatuses}
                    onToggleStatus={toggleStatus}
                  />
              }
            </div>
          )}

          {tab === "upload" && (
            <div className="overflow-auto flex-1">
              <UploadSection onSuccess={() => { loadOrders(); loadHistory(); setTab("orders"); }} />
            </div>
          )}

          {tab === "history" && (
            <div className="overflow-auto flex-1">
              <UploadHistoryPanel
                history={history}
                onRollback={() => { loadOrders(); loadHistory(); }}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
