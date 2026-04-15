// 주문 통합 뷰 타입 (orders_full 뷰와 1:1 매핑)
export interface OrderRow {
  manager_code:      string;
  order_id:          string;
  order_no:          string;
  order_date:        string;
  order_status:      string;
  upload_history_id: string;
  buyer_name:        string;
  buyer_user_id_ref: string;
  consignor_name:    string;
  item_id:           string;
  product_name:      string;
  quantity:          number;
  color:             string;
  item_status:       OrderStatus;
  barcode:           string;
  brand:             string;
  size:              string;
  options:           string;
  wholesale_price:   string;
  supplier:          string;
  item_notes:        string;
  recipient_name:    string;
  phone:             string;
  address:           string;
  buyer_user_id:     string;
  delivery_msg:      string;
  item_code:         string;
  status_history:    string;
  change_log:        string;
  item_updated_at:   string;
}

export type OrderStatus =
  | "입고대기" | "입고" | "미송" | "품절"
  | "교환"    | "환불" | "택배비" | "완료";

export const STATUS_LIST: OrderStatus[] = [
  "입고대기","입고","미송","품절","교환","환불","택배비","완료"
];

export const STATUS_COLORS: Record<OrderStatus, { bg: string; text: string }> = {
  "입고대기": { bg: "bg-gray-100",   text: "text-gray-700"  },
  "입고":     { bg: "bg-yellow-100", text: "text-yellow-800"},
  "미송":     { bg: "bg-cyan-100",   text: "text-cyan-800"  },
  "품절":     { bg: "bg-red-100",    text: "text-red-800"   },
  "교환":     { bg: "bg-orange-100", text: "text-orange-800"},
  "환불":     { bg: "bg-pink-100",   text: "text-pink-800"  },
  "택배비":   { bg: "bg-slate-200",  text: "text-slate-700" },
  "완료":     { bg: "bg-green-100",  text: "text-green-800" },
};

// 엑셀 원본 색상 (행 배경에 직접 적용)
export const STATUS_ROW_COLORS: Record<OrderStatus, { bg: string; text: string }> = {
  "입고대기": { bg: "",          text: "#374151" },
  "입고":     { bg: "#FFFF00",   text: "#374151" },
  "미송":     { bg: "#00FFFF",   text: "#374151" },
  "품절":     { bg: "#FF0000",   text: "#ffffff" },
  "교환":     { bg: "#FFC000",   text: "#374151" },
  "환불":     { bg: "#E6B8B7",   text: "#374151" },
  "택배비":   { bg: "#BFBFBF",   text: "#374151" },
  "완료":     { bg: "#92D050",   text: "#374151" },
};

export interface UploadHistory {
  id:             string;
  filename:       string;
  upload_date:    string;
  status:         string;
  rows_processed: number;
  rows_inserted:  number;
  rows_updated:   number;
  error_message:  string | null;
}

export interface Filters {
  manager:    string;
  status:     string;
  start_date: string;
  end_date:   string;
}
