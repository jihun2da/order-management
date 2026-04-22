"use client";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { getExportUrl, deleteItems, checkAdminMe } from "@/lib/api";
import { OrderRow, OrderStatus, UploadHistory, Filters, STATUS_LIST } from "@/lib/types";
import OrderTable         from "@/components/OrderTable";
import UploadSection      from "@/components/UploadSection";
import UploadHistoryPanel from "@/components/UploadHistory";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

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

const FETCH_PAGE_SIZE   = 1000;
const DISPLAY_PAGE_SIZE = 5000;

interface UploadBanner {
  uploadId: string;
  inserted: number;
  updated:  number;
  errors?:  string[];
}

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
  const [activeStatuses, setActiveStatuses] = useState<Set<OrderStatus>>(new Set(STATUS_LIST));
  const [currentPage,    setCurrentPage]    = useState(1);
  const [showAll,        setShowAll]        = useState(false);

  // ── 업로드 완료 배너 (탭과 무관하게 상단에 표시) ──
  const [uploadBanner, setUploadBanner] = useState<UploadBanner | null>(null);

  // ── 관리자 삭제 모드 ──
  const [isAdmin,        setIsAdmin]        = useState(false);
  const [accessToken,    setAccessToken]    = useState<string>("");
  const [deleteMode,     setDeleteMode]     = useState(false);
  const [selectedItems,  setSelectedItems]  = useState<Set<string>>(new Set());
  const [deleteLoading,  setDeleteLoading]  = useState(false);
  const [deleteMsg,      setDeleteMsg]      = useState<string | null>(null);
  const [deleteProgress, setDeleteProgress] = useState<{ done: number; total: number } | null>(null);

  const DELETE_CHUNK_SIZE = 500; // 청크당 최대 항목 수 (타임아웃 방지)

  // ── 인증 확인 + 관리자 여부 ──
  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) { router.replace("/login"); return; }
      setAccessToken(session.access_token);
      // 관리자 확인 (백엔드 JWT 검증)
      const admin = await checkAdminMe(session.access_token).catch(() => false);
      setIsAdmin(admin);
    });
  }, [router]);

  // ── 담당자 목록 로드 ──
  useEffect(() => {
    supabase.from("managers").select("code").eq("is_active", true)
      .order("code").then(({ data }) => {
        if (data) setManagers(data.map((m) => m.code));
      });
  }, []);

  // ── 주문 데이터 병렬 청크 로드 ──
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

  // ── 상태 토글 필터 ──
  const toggleStatus = useCallback((s: OrderStatus) => {
    setActiveStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
    setCurrentPage(1);
  }, []);

  useEffect(() => { setCurrentPage(1); }, [search]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.replace("/login");
  };

  // ── 관리자 삭제 핸들러 ──
  const handleSelectItem = useCallback((itemId: string, checked: boolean) => {
    setSelectedItems((prev) => {
      const next = new Set(prev);
      if (checked) next.add(itemId);
      else next.delete(itemId);
      return next;
    });
  }, []);

  // handleSelectAll — paginatedRows 정의 후 아래에서 선언
  const handleSelectAllRef = useCallback((checked: boolean, pageRows: OrderRow[]) => {
    setSelectedItems(checked ? new Set(pageRows.map((r) => r.item_id)) : new Set());
  }, []);

  const handleDeleteSelected = async () => {
    if (selectedItems.size === 0) return;
    if (!confirm(
      `선택된 ${selectedItems.size.toLocaleString()}건을 삭제합니다.\n이 작업은 되돌릴 수 없습니다. 계속하시겠습니까?`
    )) return;

    setDeleteLoading(true);
    setDeleteMsg(null);
    setDeleteProgress(null);

    // 500개씩 청크 분할 (Railway 타임아웃 방지)
    const allIds   = Array.from(selectedItems);
    const chunks: string[][] = [];
    for (let i = 0; i < allIds.length; i += DELETE_CHUNK_SIZE) {
      chunks.push(allIds.slice(i, i + DELETE_CHUNK_SIZE));
    }

    let totalDeleted = 0;
    try {
      for (let i = 0; i < chunks.length; i++) {
        setDeleteProgress({ done: i, total: chunks.length });
        const res = await deleteItems(chunks[i], accessToken);
        totalDeleted += (res.deleted as number) || 0;
      }
      setDeleteProgress({ done: chunks.length, total: chunks.length });
      setDeleteMsg(`✅ ${totalDeleted.toLocaleString()}건 삭제 완료`);
      setSelectedItems(new Set());
      setDeleteMode(false);
      await loadOrders();
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      setDeleteMsg(
        `❌ 삭제 중 오류 (${totalDeleted.toLocaleString()}건 완료 후): ${errMsg}`
      );
    } finally {
      setDeleteLoading(false);
      setDeleteProgress(null);
    }
  };

  // ── 필터링 + 페이지네이션 ──
  const filteredRows = useMemo(() => rows.filter((r) => {
    if (!activeStatuses.has(r.item_status)) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return Object.values(r).some((v) => String(v ?? "").toLowerCase().includes(q));
  }), [rows, search, activeStatuses]);

  const totalPages    = Math.max(1, Math.ceil(filteredRows.length / DISPLAY_PAGE_SIZE));
  const safePage      = Math.min(currentPage, totalPages);
  const paginatedRows = useMemo(() => {
    if (showAll) return filteredRows;
    const start = (safePage - 1) * DISPLAY_PAGE_SIZE;
    return filteredRows.slice(start, start + DISPLAY_PAGE_SIZE);
  }, [filteredRows, safePage, showAll]);

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
        <h1 className="text-lg font-bold text-gray-800">
          주문 관리 시스템
          {isAdmin && <span className="ml-2 text-xs bg-red-100 text-red-600 border border-red-200 px-1.5 py-0.5 rounded font-normal">관리자</span>}
        </h1>
        <div className="flex items-center gap-3">
          {/* 관리자 전용: 삭제 모드 토글 */}
          {isAdmin && (
            <button
              onClick={() => { setDeleteMode((v) => !v); setSelectedItems(new Set()); setDeleteMsg(null); }}
              className={`px-3 py-1.5 text-sm rounded-lg font-medium border transition ${
                deleteMode
                  ? "bg-red-600 text-white border-red-600 hover:bg-red-700"
                  : "bg-red-50 text-red-600 border-red-200 hover:bg-red-100"
              }`}
            >
              {deleteMode ? "✕ 삭제 모드 종료" : "🗑️ 삭제 모드"}
            </button>
          )}
          <a
            href={getExportUrl({ manager: filters.manager, status: filters.status, start: filters.start_date, end: filters.end_date })}
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

      {/* ══════════════════════════════════════════════════════
          업로드 완료 배너 — 탭과 무관하게 항상 헤더 바로 아래 표시
          어떤 탭으로 이동해도 사라지지 않음
      ══════════════════════════════════════════════════════ */}
      {uploadBanner && (
        <div className="bg-green-50 border-b border-green-200 px-4 py-3 flex items-center justify-between gap-4 flex-wrap sticky top-[57px] z-10 shadow-sm">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-semibold text-green-800">
              ✅ 업로드 완료 — 신규 {uploadBanner.inserted.toLocaleString()}건
              {uploadBanner.updated > 0 ? `, 수정 ${uploadBanner.updated.toLocaleString()}건` : ""}
              {uploadBanner.errors?.length ? ` (오류 ${uploadBanner.errors.length}건)` : ""}
            </span>
            <span className="text-xs text-green-600">
              고유번호가 기입된 엑셀 파일을 다운로드하세요 — 다른 탭으로 이동해도 이 버튼은 유지됩니다
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <a
              href={`${API_URL}/api/upload/${uploadBanner.uploadId}/download`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-4 py-2 bg-green-600 text-white text-sm rounded-lg font-semibold hover:bg-green-700 transition shadow-sm"
            >
              📥 고유번호 엑셀 다운로드
            </a>
            <button
              onClick={() => setUploadBanner(null)}
              className="text-green-400 hover:text-green-700 text-2xl leading-none px-1 transition"
              title="배너 닫기"
            >
              ×
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">

        {/* ── 사이드바 필터 ── */}
        <aside className="w-56 bg-white border-r border-gray-200 p-4 flex flex-col gap-4 overflow-y-auto shrink-0">
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">담당자</label>
            <select value={filters.manager}
              onChange={(e) => setFilters((f) => ({ ...f, manager: e.target.value }))}
              className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm"
            >
              <option value="">전체</option>
              {managers.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">상품상태</label>
            <select value={filters.status}
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
          {loading && totalCount > 0 && (
            <div className="mt-2">
              <div className="text-xs text-gray-500 mb-1">{loadingLabel}</div>
              <div className="w-full bg-gray-200 rounded-full h-1.5">
                <div className="bg-blue-500 h-1.5 rounded-full transition-all"
                  style={{ width: `${Math.round((loadedCount / totalCount) * 100)}%` }}
                />
              </div>
            </div>
          )}
        </aside>

        {/* ── 메인 컨텐츠 ── */}
        <main className="flex-1 p-4 overflow-hidden flex flex-col">

          {/* 탭 버튼 */}
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

          {/* ── 주문 목록 탭 ── */}
          {tab === "orders" && (
            <div className="flex flex-col flex-1 min-h-0 gap-2">
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
                  >컬럼 선택 ▾</button>
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

              {/* 관리자 삭제 모드 액션 바 */}
              {deleteMode && (
                <div className="shrink-0 flex flex-col gap-1.5 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-sm text-red-700 font-medium">
                      {selectedItems.size > 0
                        ? `${selectedItems.size.toLocaleString()}건 선택됨`
                        : "삭제할 항목을 체크하세요"}
                    </span>
                    <button
                      onClick={handleDeleteSelected}
                      disabled={selectedItems.size === 0 || deleteLoading}
                      className="px-3 py-1.5 bg-red-600 text-white text-sm rounded-lg font-medium hover:bg-red-700 disabled:opacity-40 transition"
                    >
                      {deleteLoading
                        ? (deleteProgress
                            ? `삭제 중... ${deleteProgress.done}/${deleteProgress.total}`
                            : "삭제 중...")
                        : `🗑️ 선택 삭제 (${selectedItems.size.toLocaleString()}건)`}
                    </button>
                    <button
                      onClick={() => setSelectedItems(new Set())}
                      disabled={selectedItems.size === 0 || deleteLoading}
                      className="px-3 py-1.5 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-100 disabled:opacity-40 transition"
                    >
                      선택 해제
                    </button>
                    {deleteMsg && (
                      <span className={`text-sm font-medium ${deleteMsg.startsWith("✅") ? "text-green-700" : "text-red-700"}`}>
                        {deleteMsg}
                      </span>
                    )}
                  </div>
                  {/* 진행률 프로그레스 바 (삭제 중에만 표시) */}
                  {deleteLoading && deleteProgress && deleteProgress.total > 1 && (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-red-200 rounded-full h-1.5 overflow-hidden">
                        <div
                          className="bg-red-600 h-1.5 rounded-full transition-all duration-300"
                          style={{ width: `${Math.round((deleteProgress.done / deleteProgress.total) * 100)}%` }}
                        />
                      </div>
                      <span className="text-xs text-red-600 whitespace-nowrap">
                        {Math.round((deleteProgress.done / deleteProgress.total) * 100)}%
                      </span>
                    </div>
                  )}
                </div>
              )}

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
                    deleteMode={deleteMode}
                    selectedItems={selectedItems}
                    onSelectItem={handleSelectItem}
                    onSelectAll={(checked) => handleSelectAllRef(checked, paginatedRows)}
                  />
              }

              {filteredRows.length > 0 && (
                <div className="shrink-0 flex items-center justify-between border-t border-gray-100 pt-2 flex-wrap gap-2">
                  <span className="text-xs text-gray-500">
                    {showAll
                      ? `전체 ${filteredRows.length.toLocaleString()}건 표시 중`
                      : `${pageStart.toLocaleString()} ~ ${pageEnd.toLocaleString()}건 표시 / 전체 ${filteredRows.length.toLocaleString()}건`
                    }
                    {loading && <span className="ml-2 text-blue-500 animate-pulse">▌ 로딩 중</span>}
                  </span>
                  <div className="flex items-center gap-1 flex-wrap">
                    {!showAll && (
                      <>
                        <button disabled={safePage === 1} onClick={() => setCurrentPage(1)}
                          className="px-1.5 py-1 text-xs border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-30">◀◀</button>
                        <button disabled={safePage === 1} onClick={() => setCurrentPage((p) => p - 1)}
                          className="px-2 py-1 text-xs border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-30">◀</button>
                        {pageButtons.map((p, i) =>
                          p === "…"
                            ? <span key={`dot-${i}`} className="px-1 text-xs text-gray-400">…</span>
                            : <button key={p} onClick={() => setCurrentPage(p as number)}
                                className={`w-7 h-7 text-xs rounded border transition ${
                                  safePage === p ? "bg-blue-500 text-white border-blue-500 font-bold" : "border-gray-200 hover:bg-gray-50"
                                }`}>{p}</button>
                        )}
                        <button disabled={safePage === totalPages} onClick={() => setCurrentPage((p) => p + 1)}
                          className="px-2 py-1 text-xs border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-30">▶</button>
                        <button disabled={safePage === totalPages} onClick={() => setCurrentPage(totalPages)}
                          className="px-1.5 py-1 text-xs border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-30">▶▶</button>
                      </>
                    )}
                    <button
                      onClick={() => { setShowAll((v) => !v); setCurrentPage(1); }}
                      className={`ml-1 px-2.5 py-1 text-xs rounded border transition font-medium ${
                        showAll ? "bg-gray-800 text-white border-gray-800 hover:bg-gray-700" : "border-gray-300 text-gray-600 hover:bg-gray-50"
                      }`}
                    >{showAll ? "페이지 보기" : "전체보기"}</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── 엑셀 업로드 탭 ── */}
          {tab === "upload" && (
            <div className="overflow-auto flex-1">
              <UploadSection
                onSuccess={() => { loadOrders(); loadHistory(); }}
                onUploadComplete={(result) => {
                  // 결과를 page 레벨 배너로 올림 — 탭 이동해도 배너 유지
                  setUploadBanner(result);
                }}
              />
            </div>
          )}

          {/* ── 업로드 이력 탭 ── */}
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
