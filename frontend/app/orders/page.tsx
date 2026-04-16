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

const FETCH_PAGE_SIZE   = 1000; // Supabase 청크 크기
const DISPLAY_PAGE_SIZE = 5000; // 화면 1페이지당 표시 행 수

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
  // ── 상태 토글 필터 ──
  const [activeStatuses, setActiveStatuses] = useState<Set<OrderStatus>>(new Set(STATUS_LIST));
  // ── 페이지네이션 ──
  const [currentPage,    setCurrentPage]    = useState(1);
  const [showAll,        setShowAll]        = useState(false);

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

  // ── 주문 데이터 전체 로드 ──
  const loadOrders = useCallback(async () => {
    setLoading(true);
    setRows([]);
    setLoadedCount(0);
    setTotalCount(0);
    setCurrentPage(1);

    try {
      let countQ = supabase.from("orders_full").select("*", { count: "exact", head: true });
      if (filters.manager)    countQ = countQ.eq("manager_code", filters.manager);
      if (filters.status)     countQ = countQ.eq("item_status",  filters.status);
      if (filters.start_date) countQ = countQ.gte("order_date",  filters.start_date);
      if (filters.end_date)   countQ = countQ.lte("order_date",  filters.end_date);
      const { count } = await countQ;
      const total = count ?? 0;
      setTotalCount(total);

      if (total === 0) { setLoading(false); return; }

      const allRows: OrderRow[] = new Array(total);
      const pageCount  = Math.ceil(total / FETCH_PAGE_SIZE);
      const CONCURRENCY = 5;

      for (let batch = 0; batch < pageCount; batch += CONCURRENCY) {
        const batchPages = Array.from(
          { length: Math.min(CONCURRENCY, pageCount - batch) },
          (_, i) => batch + i
        );

        await Promise.all(batchPages.map(async (page) => {
          const from = page * FETCH_PAGE_SIZE;
          const to   = Math.min(from + FETCH_PAGE_SIZE - 1, total - 1);

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

        const loaded = Math.min((batch + CONCURRENCY) * FETCH_PAGE_SIZE, total);
        setLoadedCount(loaded);
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
    setCurrentPage(1);
  }, []);

  // ── 검색/필터 변경 시 첫 페이지로 ──
  useEffect(() => { setCurrentPage(1); }, [search]);

  // ── 로그아웃 ──
  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.replace("/login");
  };

  // ── 필터링된 전체 행 ──
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (!activeStatuses.has(r.item_status)) return false;
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return Object.values(r).some((v) => String(v ?? "").toLowerCase().includes(q));
    });
  }, [rows, search, activeStatuses]);

  // ── 페이지네이션 계산 ──
  const totalPages   = Math.max(1, Math.ceil(filteredRows.length / DISPLAY_PAGE_SIZE));
  const safePage     = Math.min(currentPage, totalPages);

  const paginatedRows = useMemo(() => {
    if (showAll) return filteredRows;
    const start = (safePage - 1) * DISPLAY_PAGE_SIZE;
    return filteredRows.slice(start, start + DISPLAY_PAGE_SIZE);
  }, [filteredRows, safePage, showAll]);

  // 페이지 버튼 목록 생성 (최대 7개 표시, 중간은 … 처리)
  const pageButtons = useMemo(() => {
    const all = Array.from({ length: totalPages }, (_, i) => i + 1);
    if (totalPages <= 7) return all as (number | "…")[];
    const visible = new Set<number>([1, totalPages]);
    for (let p = Math.max(1, safePage - 2); p <= Math.min(totalPages, safePage + 2); p++) visible.add(p);
    const sorted = Array.from(visible).sort((a, b) => a - b);
    const result: (number | "…")[] = [];
    sorted.forEach((p, i) => {
      if (i > 0 && p - sorted[i - 1] > 1) result.push("…");
      result.push(p);
    });
    return result;
  }, [totalPages, safePage]);

  const loadingLabel = totalCount > 0
    ? `로딩 중... ${loadedCount.toLocaleString()} / ${totalCount.toLocaleString()}행`
    : "데이터 로딩 중...";

  const pageStart = (safePage - 1) * DISPLAY_PAGE_SIZE + 1;
  const pageEnd   = Math.min(safePage * DISPLAY_PAGE_SIZE, filteredRows.length);

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
            <div className="flex flex-col flex-1 min-h-0 gap-2">
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

              {/* 테이블 영역 */}
              {loading && rows.length === 0
                ? <div className="text-center py-16 text-gray-400">{loadingLabel}</div>
                : <OrderTable
                    rows={paginatedRows}
                    globalFilter={search}
                    visibleColumns={visibleCols}
                    isLoadingMore={loading}
                    totalCount={totalCount}
                    activeStatuses={activeStatuses}
                    onToggleStatus={toggleStatus}
                  />
              }

              {/* ── 페이지네이션 바 ── */}
              {filteredRows.length > 0 && (
                <div className="shrink-0 flex items-center justify-between border-t border-gray-100 pt-2 flex-wrap gap-2">
                  {/* 좌측: 현재 범위 정보 */}
                  <span className="text-xs text-gray-500">
                    {showAll
                      ? `전체 ${filteredRows.length.toLocaleString()}건 표시 중`
                      : `${pageStart.toLocaleString()} ~ ${pageEnd.toLocaleString()}건 표시 / 전체 ${filteredRows.length.toLocaleString()}건`
                    }
                    {loading && (
                      <span className="ml-2 text-blue-500 animate-pulse">▌ 로딩 중</span>
                    )}
                  </span>

                  {/* 우측: 페이지 버튼들 + 전체보기 */}
                  <div className="flex items-center gap-1 flex-wrap">
                    {!showAll && (
                      <>
                        {/* 처음/이전 */}
                        <button
                          disabled={safePage === 1}
                          onClick={() => setCurrentPage(1)}
                          className="px-1.5 py-1 text-xs border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed"
                        >◀◀</button>
                        <button
                          disabled={safePage === 1}
                          onClick={() => setCurrentPage((p) => p - 1)}
                          className="px-2 py-1 text-xs border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed"
                        >◀</button>

                        {/* 페이지 번호 */}
                        {pageButtons.map((p, i) =>
                          p === "…"
                            ? <span key={`dot-${i}`} className="px-1 text-xs text-gray-400 select-none">…</span>
                            : <button
                                key={p}
                                onClick={() => setCurrentPage(p as number)}
                                className={`w-7 h-7 text-xs rounded border transition ${
                                  safePage === p
                                    ? "bg-blue-500 text-white border-blue-500 font-bold"
                                    : "border-gray-200 hover:bg-gray-50"
                                }`}
                              >{p}</button>
                        )}

                        {/* 다음/마지막 */}
                        <button
                          disabled={safePage === totalPages}
                          onClick={() => setCurrentPage((p) => p + 1)}
                          className="px-2 py-1 text-xs border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed"
                        >▶</button>
                        <button
                          disabled={safePage === totalPages}
                          onClick={() => setCurrentPage(totalPages)}
                          className="px-1.5 py-1 text-xs border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed"
                        >▶▶</button>
                      </>
                    )}

                    {/* 전체보기 / 페이지 보기 토글 */}
                    <button
                      onClick={() => { setShowAll((v) => !v); setCurrentPage(1); }}
                      className={`ml-1 px-2.5 py-1 text-xs rounded border transition font-medium ${
                        showAll
                          ? "bg-gray-800 text-white border-gray-800 hover:bg-gray-700"
                          : "border-gray-300 text-gray-600 hover:bg-gray-50"
                      }`}
                    >
                      {showAll ? "페이지 보기" : "전체보기"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === "upload" && (
            <div className="overflow-auto flex-1">
              <UploadSection onSuccess={() => { loadOrders(); loadHistory(); }} />
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
