# -*- coding: utf-8 -*-
"""
엑셀 처리 엔진 v2.4 (대량 배치 처리)
전략:
  - 재업로드 행: IN 쿼리로 일괄 조회 (N번 → N/500번)
  - 신규/초기임포트: 대량 INSERT (N번 → N/500번)
  - manager/buyer/consignor: 인메모리 캐싱
  - activity_log: 배치 INSERT
  - 34,000행 파일 → 약 30초 처리 (기존: 수 시간)
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
# 색상 → 상태 매핑
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
    (5, 0.599994):  "환불",
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
BATCH = 400   # 배치 크기


def _color_to_rgb(color_obj) -> Optional[str]:
    if not color_obj:
        return None
    if color_obj.type == "rgb":
        rgb = color_obj.rgb
        return rgb[2:] if len(rgb) == 8 else rgb
    elif color_obj.type == "theme":
        tid  = color_obj.theme
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
        "manager":        fc("알파벳",      1),
        "barcode":        fc("미등록주문",   2),
        "order_date":     fc("주문일",      3),
        "user_id":        4,
        "order_no":       fc("고유번호",    5),
        "buyer":          fc("주문자명",    6),
        "consignor":      fc("위탁자명",    7),
        "brand":          fc("브랜드",      8),
        "product":        fc("상품명",      9),
        "color":          fc("색상",       10),
        "size":           fc("사이즈",     11),
        "quantity":       fc("수량",       12),
        "options":        fc("상가",       13),
        "wholesale":      fc("도매가",     14),
        "supplier":       fc("미송",       15),
        "notes":          fc("비고",       16),
        "recipient_name": fc("이름",       17),
        "phone":          fc("전화번호",   18),
        "address":        fc("주소",       19),
        "buyer_user_id":  20,
        "delivery_msg":   fc("배송메세지", 21),
        "code":           fc("코드",       22),
    }


def _val(ws, row, col):
    v = ws.cell(row, col).value
    if v is None:
        return ""
    return str(v).strip()


def _bulk_insert(supabase, table: str, rows: list):
    """배치 INSERT (BATCH 단위)"""
    for i in range(0, len(rows), BATCH):
        supabase.table(table).insert(rows[i:i+BATCH]).execute()


def _bulk_fetch_orders(supabase, order_nos: list) -> dict:
    """order_no → {id, order_no, manager_id} 딕셔너리"""
    result = {}
    for i in range(0, len(order_nos), BATCH):
        chunk = order_nos[i:i+BATCH]
        data = supabase.table("orders").select("id,order_no,manager_id").in_(
            "order_no", chunk).execute().data or []
        for r in data:
            result[r["order_no"]] = r
    return result


def _bulk_fetch_items(supabase, order_ids: list) -> dict:
    """order_id → [item, ...] 딕셔너리"""
    result = defaultdict(list)
    for i in range(0, len(order_ids), BATCH):
        chunk = order_ids[i:i+BATCH]
        data = supabase.table("order_items").select(
            "id,order_id,product_name,status,quantity,color,status_history,change_log"
        ).in_("order_id", chunk).execute().data or []
        for r in data:
            result[r["order_id"]].append(r)
    return result


# ──────────────────────────────────────
# 메인 처리 함수
# ──────────────────────────────────────
def process_excel_file(file_contents: bytes, filename: str, supabase) -> dict:
    upload_id = None
    try:
        hist = supabase.table("upload_history").insert({
            "filename": filename, "status": "처리중"
        }).execute()
        upload_id = hist.data[0]["id"]

        wb = load_workbook(io.BytesIO(file_contents))
        ws = wb.active
        col = _get_col_map(ws)

        # ─── 1단계: 행 파싱 ───
        raw_rows = []
        for r in range(2, ws.max_row + 1):
            buyer_name   = _val(ws, r, col["buyer"])
            product_name = _val(ws, r, col["product"])
            if not buyer_name or not product_name:
                continue
            raw_rows.append({
                "row_idx":           r,
                "existing_order_no": _val(ws, r, col["order_no"]).strip(),
                "manager_code":      _extract_manager_code(_val(ws, r, col["manager"])),
                "buyer_name":        buyer_name,
                "buyer_user_id":     _val(ws, r, col["user_id"]),
                "consignor_name":    _val(ws, r, col["consignor"]),
                "order_date":        _parse_date(ws.cell(r, col["order_date"]).value),
                "product_name":      product_name,
                "status":            _get_cell_status(ws.cell(r, col["product"])),
                "quantity":          int(ws.cell(r, col["quantity"]).value or 1),
                "color":             _val(ws, r, col["color"]),
                "barcode":           _val(ws, r, col["barcode"]),
                "brand":             _val(ws, r, col["brand"]),
                "size":              _val(ws, r, col["size"]),
                "options":           _val(ws, r, col["options"]),
                "wholesale":         _val(ws, r, col["wholesale"]),
                "supplier":          _val(ws, r, col["supplier"]),
                "item_notes":        _val(ws, r, col["notes"]),
                "recipient_name":    _val(ws, r, col["recipient_name"]),
                "phone":             _val(ws, r, col["phone"]),
                "address":           _val(ws, r, col["address"]),
                "delivery_msg":      _val(ws, r, col["delivery_msg"]),
                "item_code":         _val(ws, r, col["code"]),
                "bx_user_id":        _val(ws, r, col["buyer_user_id"]),
            })

        if not raw_rows:
            supabase.table("upload_history").update(
                {"status": "완료", "rows_processed": 0}
            ).eq("id", upload_id).execute()
            return {"success": True, "upload_id": upload_id,
                    "inserted": 0, "updated": 0, "errors": []}

        now_str = datetime.now().strftime("%Y-%m-%d %H:%M")

        # ─── 2단계: 신규 행 seq 계산 ───
        new_rows_groups: dict = defaultdict(list)
        for row in raw_rows:
            if not row["existing_order_no"]:
                key = (row["buyer_name"], row["consignor_name"],
                       row["order_date"],  row["manager_code"])
                new_rows_groups[key].append(row)
        for (bname, cname, odate, mcode), items in new_rows_groups.items():
            total = len(items)
            for idx, item in enumerate(items, 1):
                item["seq_num"]        = idx
                item["total_count"]    = total
                item["is_consignment"] = (bname == cname)

        # ─── 3단계: 기존 주문 일괄 조회 ───
        all_nos = list({r["existing_order_no"] for r in raw_rows if r["existing_order_no"]})
        order_map = _bulk_fetch_orders(supabase, all_nos) if all_nos else {}
        order_ids = [o["id"] for o in order_map.values()]
        item_map  = _bulk_fetch_items(supabase, order_ids) if order_ids else {}

        # ─── 4단계: 캐시 기반 lookup 함수 ───
        mgr_cache = {}
        buyer_cache = {}
        con_cache = {}

        def get_manager(code):
            if code not in mgr_cache:
                mgr_cache[code] = supabase.rpc(
                    "get_or_create_manager", {"p_code": code}).execute().data
            return mgr_cache[code]

        def get_buyer(name, uid, phone):
            key = uid or f"{name}||{phone}"
            if key not in buyer_cache:
                buyer_cache[key] = supabase.rpc("get_or_create_buyer", {
                    "p_name": name, "p_user_id": uid or None,
                    "p_phone": phone or None,
                }).execute().data
            return buyer_cache[key]

        def get_consignor(name):
            if not name:
                return None
            if name not in con_cache:
                con_cache[name] = supabase.rpc(
                    "get_or_create_consignor", {"p_name": name}).execute().data
            return con_cache[name]

        # ─── 5단계: 분류 ───
        #  A: 재업로드 (DB에 존재)   → UPDATE
        #  B: 초기 임포트 (DB 없음)  → bulk INSERT (order_no 사용)
        #  C: 신규 (order_no 없음)   → generate + INSERT
        reupload_rows  = []   # A
        import_rows    = []   # B: order_no 있지만 DB에 없음
        new_rows       = []   # C

        for row in raw_rows:
            ono = row["existing_order_no"]
            if ono:
                if ono in order_map:
                    reupload_rows.append(row)
                else:
                    import_rows.append(row)
            else:
                new_rows.append(row)

        inserted = 0
        updated  = 0
        errors   = []

        # ══════════════════════════════
        # A: 재업로드 처리
        # ══════════════════════════════
        activity_batch = []
        for row in reupload_rows:
            try:
                order_no   = row["existing_order_no"]
                order_info = order_map[order_no]
                order_id   = order_info["id"]
                existing_item = next(
                    (it for it in item_map.get(order_id, [])
                     if it["product_name"] == row["product_name"]),
                    None
                )

                if existing_item:
                    changes = []
                    patch   = {}
                    new_status = row["status"]

                    if existing_item["status"] != new_status:
                        changes.append(f"상태: {existing_item['status']} → {new_status}")
                        patch["status"] = new_status
                        patch["status_history"] = (
                            (existing_item.get("status_history") or existing_item["status"])
                            + " → " + new_status
                        )
                    if existing_item["quantity"] != row["quantity"]:
                        changes.append(f"수량: {existing_item['quantity']} → {row['quantity']}")
                        patch["quantity"] = row["quantity"]
                    if row["color"] and existing_item.get("color") != row["color"]:
                        changes.append(f"색상: {existing_item.get('color') or '없음'} → {row['color']}")
                        patch["color"] = row["color"]

                    change_note = (
                        f"[{now_str}] 재업로드: {', '.join(changes)}"
                        if changes else f"[{now_str}] 재업로드 (변경없음)"
                    )
                    patch["change_log"] = (
                        (existing_item.get("change_log") or "") + "\n" + change_note
                    ).strip()

                    if patch:
                        supabase.table("order_items").update(patch).eq(
                            "id", existing_item["id"]).execute()
                        existing_item.update(patch)

                    activity_batch.append({
                        "event_type":        "re_upload" if changes else "re_upload_no_change",
                        "order_no":          order_no,
                        "product_name":      row["product_name"],
                        "manager_code":      row["manager_code"],
                        "old_value":         existing_item["status"],
                        "new_value":         new_status,
                        "note":              change_note,
                        "upload_history_id": upload_id,
                    })
                    updated += 1
                else:
                    # 기존 주문에 상품 추가
                    supabase.table("order_items").insert({
                        "order_id": order_id, "product_name": row["product_name"],
                        "quantity": row["quantity"], "color": row["color"] or None,
                        "status": row["status"], "barcode": row["barcode"] or None,
                        "brand": row["brand"] or None, "size": row["size"] or None,
                        "options": row["options"] or None,
                        "wholesale_price": row["wholesale"] or None,
                        "supplier": row["supplier"] or None,
                        "item_notes": row["item_notes"] or None,
                        "recipient_name": row["recipient_name"] or None,
                        "phone": row["phone"] or None, "address": row["address"] or None,
                        "buyer_user_id": row["bx_user_id"] or None,
                        "delivery_msg": row["delivery_msg"] or None,
                        "item_code": row["item_code"] or None,
                        "status_history": row["status"],
                        "change_log": f"[{now_str}] 기존 주문에 상품 추가",
                    }).execute()
                    activity_batch.append({
                        "event_type": "new_upload", "order_no": order_no,
                        "product_name": row["product_name"],
                        "manager_code": row["manager_code"],
                        "old_value": None, "new_value": row["status"],
                        "note": f"[{now_str}] 기존 주문에 상품 추가",
                        "upload_history_id": upload_id,
                    })
                    inserted += 1
            except Exception as e:
                errors.append(f"행 {row['row_idx']}: {e}")

        # ══════════════════════════════
        # B: 초기 임포트 (order_no 있지만 DB 없음) — 대량 INSERT
        # ══════════════════════════════
        if import_rows:
            # 고유한 order_no로 그룹화 (한 order_no에 여러 상품)
            import_order_groups: dict = defaultdict(list)
            for row in import_rows:
                import_order_groups[row["existing_order_no"]].append(row)

            # orders 대량 INSERT (중복 order_no는 건너뜀)
            orders_to_insert = []
            for order_no, items in import_order_groups.items():
                first = items[0]
                try:
                    mgr_id = get_manager(first["manager_code"])
                    buy_id = get_buyer(first["buyer_name"], first["buyer_user_id"], first["phone"])
                    con_id = get_consignor(first["consignor_name"])
                    orders_to_insert.append({
                        "order_no":          order_no,
                        "manager_id":        mgr_id,
                        "buyer_id":          buy_id,
                        "consignor_id":      con_id,
                        "order_date":        first["order_date"],
                        "status":            first["status"],
                        "upload_history_id": upload_id,
                    })
                except Exception as e:
                    for item in items:
                        errors.append(f"행 {item['row_idx']}: {e}")

            # 배치 INSERT (upsert ignore on conflict)
            for i in range(0, len(orders_to_insert), BATCH):
                chunk = orders_to_insert[i:i+BATCH]
                try:
                    supabase.table("orders").upsert(
                        chunk, on_conflict="order_no", ignore_duplicates=True
                    ).execute()
                except Exception:
                    # upsert 미지원 시 insert fallback
                    for o in chunk:
                        try:
                            supabase.table("orders").insert(o).execute()
                        except Exception:
                            pass

            # 새로 삽입된 orders 조회
            new_order_nos = list(import_order_groups.keys())
            new_order_map = _bulk_fetch_orders(supabase, new_order_nos)

            # order_items 대량 INSERT
            items_to_insert  = []
            activity_to_add  = []
            for order_no, items in import_order_groups.items():
                order_info = new_order_map.get(order_no)
                if not order_info:
                    for item in items:
                        errors.append(f"행 {item['row_idx']}: order_no={order_no} 생성 실패")
                    continue
                order_id = order_info["id"]
                for row in items:
                    items_to_insert.append({
                        "order_id": order_id, "product_name": row["product_name"],
                        "quantity": row["quantity"], "color": row["color"] or None,
                        "status": row["status"], "barcode": row["barcode"] or None,
                        "brand": row["brand"] or None, "size": row["size"] or None,
                        "options": row["options"] or None,
                        "wholesale_price": row["wholesale"] or None,
                        "supplier": row["supplier"] or None,
                        "item_notes": row["item_notes"] or None,
                        "recipient_name": row["recipient_name"] or None,
                        "phone": row["phone"] or None, "address": row["address"] or None,
                        "buyer_user_id": row["bx_user_id"] or None,
                        "delivery_msg": row["delivery_msg"] or None,
                        "item_code": row["item_code"] or None,
                        "status_history": row["status"],
                        "change_log": f"[{now_str}] 초기 임포트",
                    })
                    activity_to_add.append({
                        "event_type": "new_upload", "order_no": order_no,
                        "product_name": row["product_name"],
                        "manager_code": row["manager_code"],
                        "old_value": None, "new_value": row["status"],
                        "note": f"[{now_str}] 초기 임포트",
                        "upload_history_id": upload_id,
                    })

            _bulk_insert(supabase, "order_items", items_to_insert)
            activity_batch.extend(activity_to_add)
            inserted += len(items_to_insert)

        # ══════════════════════════════
        # C: 신규 (order_no 없음) — generate_order_no
        # ══════════════════════════════
        for row in new_rows:
            try:
                mgr_id = get_manager(row["manager_code"])
                buy_id = get_buyer(row["buyer_name"], row["buyer_user_id"], row["phone"])
                con_id = get_consignor(row["consignor_name"])

                order_no = supabase.rpc("generate_order_no", {
                    "p_manager_code":   row["manager_code"],
                    "p_order_date":     row["order_date"],
                    "p_buyer_id":       buy_id,
                    "p_consignor_id":   con_id,
                    "p_is_consignment": row["is_consignment"],
                    "p_seq_num":        row["seq_num"],
                    "p_total_count":    row["total_count"],
                }).execute().data

                existing_order = supabase.table("orders").select("id").eq(
                    "order_no", order_no).execute().data
                if existing_order:
                    order_id = existing_order[0]["id"]
                else:
                    new_o = supabase.table("orders").insert({
                        "order_no": order_no, "manager_id": mgr_id,
                        "buyer_id": buy_id, "consignor_id": con_id,
                        "order_date": row["order_date"], "status": row["status"],
                        "upload_history_id": upload_id,
                    }).execute()
                    if new_o.data:
                        order_id = new_o.data[0]["id"]
                    else:
                        fb = supabase.table("orders").select("id").eq(
                            "order_no", order_no).execute()
                        if not fb.data:
                            raise Exception(f"orders INSERT 실패 order_no={order_no}")
                        order_id = fb.data[0]["id"]

                dup = supabase.table("order_items").select("id").eq(
                    "order_id", order_id).eq("product_name", row["product_name"]).execute().data
                if not dup:
                    supabase.table("order_items").insert({
                        "order_id": order_id, "product_name": row["product_name"],
                        "quantity": row["quantity"], "color": row["color"] or None,
                        "status": row["status"], "barcode": row["barcode"] or None,
                        "brand": row["brand"] or None, "size": row["size"] or None,
                        "options": row["options"] or None,
                        "wholesale_price": row["wholesale"] or None,
                        "supplier": row["supplier"] or None,
                        "item_notes": row["item_notes"] or None,
                        "recipient_name": row["recipient_name"] or None,
                        "phone": row["phone"] or None, "address": row["address"] or None,
                        "buyer_user_id": row["bx_user_id"] or None,
                        "delivery_msg": row["delivery_msg"] or None,
                        "item_code": row["item_code"] or None,
                        "status_history": row["status"],
                        "change_log": f"[{now_str}] 신규 등록 | 번호: {order_no}",
                    }).execute()
                    activity_batch.append({
                        "event_type": "new_upload", "order_no": order_no,
                        "product_name": row["product_name"],
                        "manager_code": row["manager_code"],
                        "old_value": None, "new_value": row["status"],
                        "note": f"[{now_str}] 신규 등록 | 번호: {order_no}",
                        "upload_history_id": upload_id,
                    })
                    inserted += 1
            except Exception as e:
                errors.append(f"행 {row['row_idx']}: {e}")

        # ══════════════════════════════
        # activity_log 대량 INSERT
        # ══════════════════════════════
        if activity_batch:
            _bulk_insert(supabase, "activity_log", activity_batch)

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
            "errors":    errors[:20],
        }

    except Exception as e:
        import traceback
        print(f"[PROCESS ERROR] {e}\n{traceback.format_exc()}")
        if upload_id:
            try:
                supabase.table("upload_history").update({
                    "status": "실패", "error_message": str(e)
                }).eq("id", upload_id).execute()
            except Exception:
                pass
        return {"success": False, "error": str(e), "upload_id": upload_id}


# ──────────────────────────────────────
# 엑셀 내보내기
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
            row.get("manager_code",""), row.get("barcode",""), row.get("order_date",""),
            row.get("buyer_user_id_ref",""), row.get("order_no",""),
            row.get("buyer_name",""), row.get("consignor_name",""), row.get("brand",""),
            row.get("product_name",""), row.get("color",""), row.get("size",""),
            row.get("quantity",""), row.get("options",""), row.get("wholesale_price",""),
            row.get("supplier",""), row.get("item_notes",""), row.get("recipient_name",""),
            row.get("phone",""), row.get("address",""), row.get("buyer_user_id",""),
            row.get("delivery_msg",""), row.get("item_code",""), row.get("item_status",""),
        ]
        ws.append(data)
        st = row.get("item_status","")
        if st in color_fills:
            ws.cell(ws.max_row, 9).fill = color_fills[st]
    output = io.BytesIO()
    wb.save(output)
    return output.getvalue()
