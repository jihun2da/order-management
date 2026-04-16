"use client";
import { useState, useMemo, useEffect, useRef } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  ColumnDef,
  SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { OrderRow, OrderStatus, STATUS_ROW_COLORS } from "@/lib/types";
import StatusBadge from "./StatusBadge";

interface Props {
  rows:           OrderRow[];
  globalFilter:   string;
  visibleColumns: string[];
  isLoadingMore?: boolean;
  totalCount?:    number;
}

const ROW_HEIGHT = 30; // px — 가상 스크롤 행 높이

export default function OrderTable({
  rows, globalFilter, visibleColumns, isLoadingMore, totalCount,
}: Props) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [data,    setData]    = useState<OrderRow[]>(rows);
  const parentRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setData(rows); }, [rows]);

  const handleStatusUpdate = (itemId: string, newStatus: OrderStatus) => {
    setData((prev) =>
      prev.map((r) => r.item_id === itemId ? { ...r, item_status: newStatus } : r)
    );
  };

  const allColumns: ColumnDef<OrderRow>[] = useMemo(() => [
    { accessorKey: "manager_code",      header: "알파벳",      size: 70  },
    { accessorKey: "barcode",           header: "미등록주문",   size: 90  },
    { accessorKey: "order_date",        header: "주문일",      size: 90  },
    { accessorKey: "buyer_user_id_ref", header: "아이디(주문)", size: 110 },
    { accessorKey: "order_no",          header: "고유번호",    size: 160 },
    { accessorKey: "buyer_name",        header: "주문자명",    size: 90  },
    { accessorKey: "consignor_name",    header: "위탁자명",    size: 90  },
    { accessorKey: "brand",             header: "브랜드",      size: 90  },
    { accessorKey: "product_name",      header: "상품명",      size: 200 },
    { accessorKey: "color",             header: "색상",        size: 70  },
    { accessorKey: "size",              header: "사이즈",      size: 70  },
    { accessorKey: "quantity",          header: "수량",        size: 55  },
    { accessorKey: "options",           header: "상가",        size: 90  },
    { accessorKey: "wholesale_price",   header: "도매가",      size: 80  },
    { accessorKey: "supplier",          header: "미송",        size: 80  },
    { accessorKey: "item_notes",        header: "비고",        size: 100 },
    { accessorKey: "recipient_name",    header: "이름",        size: 80  },
    { accessorKey: "phone",             header: "전화번호",    size: 120 },
    { accessorKey: "address",           header: "주소",        size: 200 },
    { accessorKey: "buyer_user_id",     header: "아이디(구매)", size: 110 },
    { accessorKey: "delivery_msg",      header: "배송메세지",   size: 150 },
    { accessorKey: "item_code",         header: "코드",        size: 70  },
    {
      accessorKey: "item_status",
      header: "상품상태",
      size: 100,
      cell: ({ row }) => (
        <StatusBadge
          itemId={row.original.item_id}
          currentStatus={row.original.item_status}
          onUpdated={(ns) => handleStatusUpdate(row.original.item_id, ns)}
        />
      ),
    },
    { accessorKey: "status_history",    header: "상태이력",    size: 180 },
    { accessorKey: "change_log",        header: "변경내용",    size: 250 },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  const columns = useMemo(
    () => visibleColumns.length
      ? allColumns.filter((c) => {
          const key = (c as { accessorKey?: string }).accessorKey;
          return key ? visibleColumns.includes(key) : false;
        })
      : allColumns,
    [visibleColumns, allColumns]
  );

  const table = useReactTable({
    data,
    columns,
    state:               { sorting, globalFilter },
    onSortingChange:     setSorting,
    getCoreRowModel:     getCoreRowModel(),
    getSortedRowModel:   getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const tableRows = table.getRowModel().rows;

  // ── 가상 스크롤 ──
  const virtualizer = useVirtualizer({
    count:           tableRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize:    () => ROW_HEIGHT,
    overscan:        30, // 화면 밖 위아래 30행 미리 렌더
  });

  const virtualItems  = virtualizer.getVirtualItems();
  const totalHeight   = virtualizer.getTotalSize();
  const paddingTop    = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom = virtualItems.length > 0
    ? totalHeight - virtualItems[virtualItems.length - 1].end
    : 0;

  const displayCount = tableRows.length;
  const totalQty     = data.reduce((s, r) => s + (Number(r.quantity) || 0), 0);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* ── 상단: 통계 + 색상 범례 ── */}
      <div className="flex flex-wrap items-center gap-2 mb-1.5 shrink-0">
        <span className="text-xs text-gray-600 font-medium">
          {displayCount.toLocaleString()}건 표시
          {totalCount && totalCount > data.length
            ? ` (전체 ${totalCount.toLocaleString()}건 로딩 중…)`
            : ` / 총 수량 ${totalQty.toLocaleString()}`}
        </span>
        {isLoadingMore && (
          <span className="text-xs text-blue-500 animate-pulse">▌ 데이터 수신 중</span>
        )}
        <span className="text-xs text-gray-300 mx-1">|</span>
        {(["입고대기","입고","미송","품절","교환","환불","택배비","완료"] as OrderStatus[]).map((s) => {
          const c = STATUS_ROW_COLORS[s];
          return (
            <span
              key={s}
              className="text-xs px-1.5 py-0.5 rounded border border-gray-300"
              style={{ backgroundColor: c.bg || "#f9fafb", color: c.text }}
            >
              {s}
            </span>
          );
        })}
      </div>

      {/* ── 테이블 (가상 스크롤) ── */}
      <div
        ref={parentRef}
        className="flex-1 overflow-auto rounded-lg border border-gray-200 shadow-sm min-h-0"
        style={{ willChange: "transform" }}
      >
        <table className="text-xs border-collapse" style={{ tableLayout: "fixed", width: "max-content", minWidth: "100%" }}>
          {/* 컬럼 너비 고정 */}
          <colgroup>
            {columns.map((col) => (
              <col
                key={(col as { accessorKey?: string }).accessorKey}
                style={{ width: col.size ?? 100, minWidth: col.size ?? 100 }}
              />
            ))}
          </colgroup>

          <thead className="bg-gray-100 sticky top-0 z-10">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    className="px-2 py-2 text-left font-semibold text-gray-600 border-b border-gray-200 cursor-pointer select-none whitespace-nowrap overflow-hidden text-ellipsis"
                    onClick={h.column.getToggleSortingHandler()}
                    title={String(h.column.columnDef.header ?? "")}
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {h.column.getIsSorted() === "asc"  ? " ↑" : ""}
                    {h.column.getIsSorted() === "desc" ? " ↓" : ""}
                  </th>
                ))}
              </tr>
            ))}
          </thead>

          <tbody>
            {tableRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="text-center py-12 text-gray-400">
                  데이터가 없습니다.
                </td>
              </tr>
            ) : (
              <>
                {/* 위쪽 패딩 (가상 스크롤용) */}
                {paddingTop > 0 && (
                  <tr><td colSpan={columns.length} style={{ height: paddingTop, padding: 0 }} /></tr>
                )}

                {/* 화면에 보이는 행만 렌더링 */}
                {virtualItems.map((vRow) => {
                  const row = tableRows[vRow.index];
                  if (!row) return null;
                  const rowColor = STATUS_ROW_COLORS[row.original.item_status] ?? STATUS_ROW_COLORS["입고대기"];
                  return (
                    <tr
                      key={row.id}
                      data-index={vRow.index}
                      style={{
                        height:          ROW_HEIGHT,
                        backgroundColor: rowColor.bg || "#ffffff",
                        color:           rowColor.text,
                      }}
                      className="border-b border-gray-200/60 hover:brightness-95 transition-[filter]"
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td
                          key={cell.id}
                          className="px-2 whitespace-nowrap overflow-hidden text-ellipsis"
                          style={{ maxWidth: cell.column.getSize() }}
                          title={String(cell.getValue() ?? "")}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  );
                })}

                {/* 아래쪽 패딩 */}
                {paddingBottom > 0 && (
                  <tr><td colSpan={columns.length} style={{ height: paddingBottom, padding: 0 }} /></tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
