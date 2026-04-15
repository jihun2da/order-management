"use client";
import { useState, useMemo } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  ColumnDef,
  SortingState,
} from "@tanstack/react-table";
import { OrderRow, OrderStatus, STATUS_COLORS } from "@/lib/types";
import StatusBadge from "./StatusBadge";

interface Props {
  rows:            OrderRow[];
  globalFilter:    string;
  visibleColumns:  string[];
}

export default function OrderTable({ rows, globalFilter, visibleColumns }: Props) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [data,    setData]    = useState<OrderRow[]>(rows);

  // rows가 바뀌면 동기화
  useMemo(() => setData(rows), [rows]);

  const handleStatusUpdate = (itemId: string, newStatus: OrderStatus) => {
    setData((prev) =>
      prev.map((r) => r.item_id === itemId ? { ...r, item_status: newStatus } : r)
    );
  };

  const allColumns: ColumnDef<OrderRow>[] = [
    { accessorKey: "manager_code",    header: "알파벳",    size: 70  },
    { accessorKey: "barcode",         header: "미등록주문", size: 90  },
    { accessorKey: "order_date",      header: "주문일",    size: 90  },
    { accessorKey: "buyer_user_id_ref", header: "아이디(주문)", size: 110 },
    { accessorKey: "order_no",        header: "고유번호",  size: 160 },
    { accessorKey: "buyer_name",      header: "주문자명",  size: 90  },
    { accessorKey: "consignor_name",  header: "위탁자명",  size: 90  },
    { accessorKey: "brand",           header: "브랜드",    size: 90  },
    {
      accessorKey: "product_name",
      header: "상품명",
      size: 200,
      cell: ({ row, getValue }) => {
        const status = row.original.item_status;
        const colors = STATUS_COLORS[status] || STATUS_COLORS["입고대기"];
        return (
          <span className={`px-1 rounded text-sm ${colors.bg} ${colors.text}`}>
            {getValue() as string}
          </span>
        );
      },
    },
    { accessorKey: "color",           header: "색상",      size: 70  },
    { accessorKey: "size",            header: "사이즈",    size: 70  },
    { accessorKey: "quantity",        header: "수량",      size: 55  },
    { accessorKey: "options",         header: "상가",      size: 90  },
    { accessorKey: "wholesale_price", header: "도매가",    size: 80  },
    { accessorKey: "supplier",        header: "미송",      size: 80  },
    { accessorKey: "item_notes",      header: "비고",      size: 100 },
    { accessorKey: "recipient_name",  header: "이름",      size: 80  },
    { accessorKey: "phone",           header: "전화번호",  size: 120 },
    { accessorKey: "address",         header: "주소",      size: 200 },
    { accessorKey: "buyer_user_id",   header: "아이디(구매)", size: 110 },
    { accessorKey: "delivery_msg",    header: "배송메세지", size: 150 },
    { accessorKey: "item_code",       header: "코드",      size: 70  },
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
    { accessorKey: "status_history",  header: "상태이력",  size: 180 },
    { accessorKey: "change_log",      header: "변경내용",  size: 250 },
  ];

  const columns = useMemo(
    () => visibleColumns.length
      ? allColumns.filter((c) => visibleColumns.includes(c.accessorKey as string))
      : allColumns,
    [visibleColumns, data]
  );

  const table = useReactTable({
    data,
    columns,
    state:              { sorting, globalFilter },
    onSortingChange:    setSorting,
    getCoreRowModel:    getCoreRowModel(),
    getSortedRowModel:  getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const totalQty = data.reduce((s, r) => s + (Number(r.quantity) || 0), 0);

  return (
    <div>
      <p className="text-xs text-gray-500 mb-2">
        총 {table.getRowModel().rows.length}건 | 총 수량 {totalQty}
      </p>
      <div className="table-container rounded-lg border border-gray-200 shadow-sm">
        <table className="w-full text-xs border-collapse">
          <thead className="bg-gray-100 sticky top-0 z-10">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    style={{ width: h.getSize(), minWidth: h.getSize() }}
                    className="px-2 py-2 text-left font-semibold text-gray-600 border-b border-gray-200 cursor-pointer select-none whitespace-nowrap"
                    onClick={h.column.getToggleSortingHandler()}
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
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="text-center py-12 text-gray-400">
                  데이터가 없습니다.
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row, i) => (
                <tr
                  key={row.id}
                  className={`border-b border-gray-100 hover:bg-blue-50 transition ${
                    i % 2 === 0 ? "bg-white" : "bg-gray-50/50"
                  }`}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className="px-2 py-1.5 whitespace-nowrap overflow-hidden text-ellipsis"
                      style={{ maxWidth: cell.column.getSize() }}
                      title={String(cell.getValue() ?? "")}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
