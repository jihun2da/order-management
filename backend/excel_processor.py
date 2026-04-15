# -*- coding: utf-8 -*-
"""
엑셀 처리 엔진
- 셀 색상 → 상태 변환 (기존 로직 완전 보존)
- 주문번호 생성: Supabase DB 함수 호출 (Race Condition 없음)
- notes blob 제거 → order_items 개별 컬럼 저장
"""
import io
import re
from datetime import datetime
from collections import defaultdict
from typing import Optional

from openpyxl import load_workbook, Workbook
from openpyxl.styles import PatternFill
from openpyxl.styles.colors import COLOR_INDEX

# ──────────────────────────────────────
# 색상 → 상태 매핑 (기존 시스템과 동일)
# ──────────────────────────────────────
EXACT_RGB_MAP = {
    "FFFFFF00": "입고", "FFFF00": "입고",
    "FF00FFFF": "미송", "00FFFF": "미송",
    "FFFF0000": "품절", "FF0000": "품절",
    "FFFFC000": "교환", "FFC000": "교환",
    "FFE6B8B7": "환불", "E6B8B7": "환불",
    "FFBFBFBF": "택배비", "BFBFBF": "택배비",
}
THEME_PATTERN_MAP = {
    (0, -0.249977): "택배비",
    (5, 0.599994): "환불",
}
DEFAULT_OFFICE_THEME = {
    0: (0,0,0), 1:(255,255,255), 2:(238,236,225),
    3:(31,73,125), 4:(79,129,189), 5:(192,80,77),
}
STATUS_COLORS = {
    "입고":   "FFFFFF00",
    "미송":   "FF00FFFF",
    "품절":   "FFFF0000",
    "교환":   "FFFFC000",
    "환불":   "FFE6B8B7",
    "택배비": "FFBFBFBF",
}


def _color_to_rgb(color_obj) -> Optional[str]:
    if not color_obj:
        return None
    if color_obj.type == "rgb":
        rgb = color_obj.rgb
        return rgb[2:] if len(rgb) == 8 else rgb
    elif color_obj.type == "theme":
        tid = color_obj.theme
        tint = color_obj.tint or 0.0
        if (tid, round(tint, 6)) in THEME_PATTERN_MAP:
            return None
        if tid in DEFAULT_OFFICE_THEME:
            return "%02x%02x%02x" % DEFAULT_OFFICE_THEME[tid]
    elif color_obj.type == "indexed":
        try:
            rgb = COLOR_INDEX[color_obj.indexed]
            return rgb[2:] if len(rgb) == 8 else rgb
        except Exception:
            pass
    return None


def _get_cell_status(cell) -> str:
    if not cell.fill or not cell.fill.start_color:
        return "입고대기"
    color = cell.fill.start_color
    if color.type == "theme":
        key = (color.theme, round(color.tint or 0.0, 6))
        if key in THEME_PATTERN_MAP:
            return THEME_PATTERN_MAP[key]
    rgb = _color_to_rgb(color)
    if rgb:
        return EXACT_RGB_MAP.get(rgb.upper(), "입고대기")
    return "입고대기"


def _parse_date(val):
    if isinstance(val, datetime):
        return val.date().isoformat()
    if isinstance(val, str):
        val = val.strip()
        for fmt in ("%Y%m%d", "%Y-%m-%d", "%Y/%m/%d"):
            try:
                return datetime.strptime(val, fmt).date().isoformat()
            except ValueError:
                pass
    return datetime.today().date().isoformat()


def _extract_manager_code(val) -> str:
    if val and isinstance(val, str):
        m = re.match(r"^([A-Za-z]+)", val.strip())
        if m:
            return m.group(1).upper()[:2]
    return "XX"


def _get_col_map(ws) -> dict:
    col_map = {}
    for c in range(1, ws.max_column + 1):
        v = ws.cell(1, c).value
        if v:
            col_map[str(v).strip()] = c

    def fc(name, default):
        return col_map.get(name, default)

    return {
        "manager":        fc("알파벳",    1),
        "barcode":        fc("미등록주문", 2),
        "order_date":     fc("주문일",    3),
        "user_id":        4,
        "order_no":       fc("고유번호",  5),
        "buyer":          fc("주문자명",  6),
        "consignor":      fc("위탁자명",  7),
        "brand":          fc("브랜드",    8),
        "product":        fc("상품명",    9),
        "color":          fc("색상",     10),
        "size":           fc("사이즈",   11),
        "quantity":       fc("수량",     12),
        "options":        fc("상가",     13),
        "wholesale":      fc("도매가",   14),
        "supplier":       fc("미송",     15),
        "notes":          fc("비고",     16),
        "recipient_name": fc("이름",     17),
        "phone":          fc("전화번호", 18),
        "address":        fc("주소",     19),
        "buyer_user_id":  20,
        "delivery_msg":   fc("배송메세지", 21),
        "code":           fc("코드",     22),
    }


def _val(ws, row, col):
    v = ws.cell(row, col).value
    if v is None:
        return ""
    return str(v).strip()


# ──────────────────────────────────────
# 메인 처리 함수
# ──────────────────────────────────────
def process_excel_file(file_contents: bytes, filename: str, supabase) -> dict:
    # 업로드 이력 생성
    hist = supabase.table("upload_history").insert({
        "filename": filename, "status": "처리중"
    }).execute()
    upload_id = hist.data[0]["id"]

    try:
        wb = load_workbook(io.BytesIO(file_contents))
        ws = wb.active
        col = _get_col_map(ws)

        # ─── 1단계: 모든 행 읽기 ───
        raw_rows = []
        for r in range(2, ws.max_row + 1):
            buyer_name   = _val(ws, r, col["buyer"])
            product_name = _val(ws, r, col["product"])
            if not buyer_name or not product_name:
                continue

            raw_rows.append({
                "row_idx":        r,
                "manager_code":   _extract_manager_code(_val(ws, r, col["manager"])),
                "buyer_name":     buyer_name,
                "buyer_user_id":  _val(ws, r, col["user_id"]),
                "consignor_name": _val(ws, r, col["consignor"]),
                "order_date":     _parse_date(ws.cell(r, col["order_date"]).value),
                "product_name":   product_name,
                "status":         _get_cell_status(ws.cell(r, col["product"])),
                "quantity":       int(ws.cell(r, col["quantity"]).value or 1),
                "color":          _val(ws, r, col["color"]),
                "barcode":        _val(ws, r, col["barcode"]),
                "brand":          _val(ws, r, col["brand"]),
                "size":           _val(ws, r, col["size"]),
                "options":        _val(ws, r, col["options"]),
                "wholesale":      _val(ws, r, col["wholesale"]),
                "supplier":       _val(ws, r, col["supplier"]),
                "item_notes":     _val(ws, r, col["notes"]),
                "recipient_name": _val(ws, r, col["recipient_name"]),
                "phone":          _val(ws, r, col["phone"]),
                "address":        _val(ws, r, col["address"]),          # 쉼표 포함 OK
                "delivery_msg":   _val(ws, r, col["delivery_msg"]),     # 쉼표 포함 OK
                "item_code":      _val(ws, r, col["code"]),
                "bx_user_id":     _val(ws, r, col["buyer_user_id"]),
            })

        if not raw_rows:
            supabase.table("upload_history").update(
                {"status": "완료", "rows_processed": 0}
            ).eq("id", upload_id).execute()
            return {"success": True, "upload_id": upload_id,
                    "inserted": 0, "updated": 0, "errors": []}

        # ─── 2단계: (buyer, consignor, date, manager) 기준으로 그룹화 ───
        groups: dict = defaultdict(list)
        for row in raw_rows:
            key = (row["buyer_name"], row["consignor_name"],
                   row["order_date"],  row["manager_code"])
            groups[key].append(row)

        # ─── 3단계: 그룹별 seq 번호 부여 ───
        for (buyer_name, consignor_name, order_date, manager_code), items in groups.items():
            total = len(items)
            for idx, item in enumerate(items, 1):
                item["seq_num"]     = idx
                item["total_count"] = total
                item["is_consignment"] = (buyer_name == consignor_name)

        # ─── 4단계: DB에 저장 ───
        inserted = 0
        updated  = 0
        errors   = []
        now_str  = datetime.now().strftime("%Y-%m-%d %H:%M")

        for row in raw_rows:
            try:
                # 담당자
                mgr_res = supabase.rpc("get_or_create_manager",
                                       {"p_code": row["manager_code"]}).execute()
                manager_id = mgr_res.data

                # 주문자
                buyer_res = supabase.rpc("get_or_create_buyer", {
                    "p_name":    row["buyer_name"],
                    "p_user_id": row["buyer_user_id"] or None,
                    "p_phone":   row["phone"] or None,
                }).execute()
                buyer_id = buyer_res.data

                # 위탁자
                consignor_id = None
                if row["consignor_name"]:
                    con_res = supabase.rpc("get_or_create_consignor",
                                           {"p_name": row["consignor_name"]}).execute()
                    consignor_id = con_res.data

                # 주문번호 생성 (DB 함수: Race Condition 완전 해결)
                order_no = supabase.rpc("generate_order_no", {
                    "p_manager_code":   row["manager_code"],
                    "p_order_date":     row["order_date"],
                    "p_buyer_id":       buyer_id,
                    "p_consignor_id":   consignor_id,
                    "p_is_consignment": row["is_consignment"],
                    "p_seq_num":        row["seq_num"],
                    "p_total_count":    row["total_count"],
                }).execute().data

                # 주문 조회 또는 생성
                existing_order = supabase.table("orders").select("id").eq(
                    "order_no", order_no).execute().data

                if existing_order:
                    order_id = existing_order[0]["id"]
                    updated += 1
                else:
                    new_order = supabase.table("orders").insert({
                        "order_no":          order_no,
                        "manager_id":        manager_id,
                        "buyer_id":          buyer_id,
                        "consignor_id":      consignor_id,
                        "order_date":        row["order_date"],
                        "status":            row["status"],
                        "upload_history_id": upload_id,
                    }).execute()
                    order_id = new_order.data[0]["id"]
                    inserted += 1

                # 주문 아이템 조회 또는 생성/수정
                existing_item = supabase.table("order_items").select("id,status,quantity,color").eq(
                    "order_id", order_id).eq("product_name", row["product_name"]).execute().data

                if existing_item:
                    item = existing_item[0]
                    changes = []
                    patch = {}

                    if item["status"] != row["status"]:
                        changes.append(f"상태: {item['status']} → {row['status']}")
                        patch["status"]         = row["status"]
                        patch["status_history"] = (item.get("status_history") or item["status"]) + " → " + row["status"]

                    if item["quantity"] != row["quantity"]:
                        changes.append(f"수량: {item['quantity']} → {row['quantity']}")
                        patch["quantity"] = row["quantity"]

                    if item["color"] != row["color"] and row["color"]:
                        changes.append(f"색상: {item['color'] or '없음'} → {row['color']}")
                        patch["color"] = row["color"]

                    if changes:
                        patch["change_log"] = f"[{now_str}] {', '.join(changes)}"

                    if patch:
                        supabase.table("order_items").update(patch).eq("id", item["id"]).execute()
                else:
                    supabase.table("order_items").insert({
                        "order_id":       order_id,
                        "product_name":   row["product_name"],
                        "quantity":       row["quantity"],
                        "color":          row["color"] or None,
                        "status":         row["status"],
                        "barcode":        row["barcode"]   or None,
                        "brand":          row["brand"]     or None,
                        "size":           row["size"]      or None,
                        "options":        row["options"]   or None,
                        "wholesale_price": row["wholesale"] or None,
                        "supplier":       row["supplier"]  or None,
                        "item_notes":     row["item_notes"] or None,
                        "recipient_name": row["recipient_name"] or None,
                        "phone":          row["phone"]     or None,
                        "address":        row["address"]   or None,   # 쉼표 OK
                        "buyer_user_id":  row["bx_user_id"] or None,
                        "delivery_msg":   row["delivery_msg"] or None, # 쉼표 OK
                        "item_code":      row["item_code"] or None,
                        "status_history": row["status"],
                        "change_log":     f"[{now_str}] 신규 등록",
                    }).execute()

            except Exception as e:
                errors.append(f"행 {row['row_idx']}: {e}")

        # 업로드 이력 최종 업데이트
        supabase.table("upload_history").update({
            "status":         "완료" if not errors else "완료(오류있음)",
            "rows_processed": len(raw_rows),
            "rows_inserted":  inserted,
            "rows_updated":   updated,
            "error_message":  "\n".join(errors[:20]) if errors else None,
        }).eq("id", upload_id).execute()

        return {
            "success":   True,
            "upload_id": upload_id,
            "inserted":  inserted,
            "updated":   updated,
            "errors":    errors,
        }

    except Exception as e:
        supabase.table("upload_history").update({
            "status": "실패", "error_message": str(e)
        }).eq("id", upload_id).execute()
        return {"success": False, "error": str(e), "upload_id": upload_id}


# ──────────────────────────────────────
# 엑셀 내보내기 (색상 포함)
# ──────────────────────────────────────
def export_to_excel(rows: list) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "주문목록"

    headers = [
        "알파벳","미등록주문","주문일","아이디(주문)","고유번호",
        "주문자명","위탁자명","브랜드","상품명","색상","사이즈","수량",
        "상가","도매가","미송","비고","이름","전화번호","주소",
        "아이디(구매)","배송메세지","코드","상품상태",
    ]
    ws.append(headers)

    color_fills = {
        s: PatternFill(start_color=c, end_color=c, fill_type="solid")
        for s, c in STATUS_COLORS.items()
    }

    for row in rows:
        data = [
            row.get("manager_code",""),
            row.get("barcode",""),
            row.get("order_date",""),
            row.get("buyer_user_id_ref",""),
            row.get("order_no",""),
            row.get("buyer_name",""),
            row.get("consignor_name",""),
            row.get("brand",""),
            row.get("product_name",""),
            row.get("color",""),
            row.get("size",""),
            row.get("quantity",""),
            row.get("options",""),
            row.get("wholesale_price",""),
            row.get("supplier",""),
            row.get("item_notes",""),
            row.get("recipient_name",""),
            row.get("phone",""),
            row.get("address",""),
            row.get("buyer_user_id",""),
            row.get("delivery_msg",""),
            row.get("item_code",""),
            row.get("item_status",""),
        ]
        ws.append(data)
        # 상태에 따른 색상 (상품명 컬럼 = 9번째)
        item_status = row.get("item_status","")
        if item_status in color_fills:
            ws.cell(ws.max_row, 9).fill = color_fills[item_status]

    output = io.BytesIO()
    wb.save(output)
    return output.getvalue()
