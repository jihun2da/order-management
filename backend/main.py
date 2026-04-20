# -*- coding: utf-8 -*-
"""
주문 관리 시스템 - FastAPI 백엔드 v3.1
역할: 엑셀 파일 파싱 + 주문번호 생성(로컬) + Supabase 저장
v3.1: 업로드 후 고유번호 기입된 엑셀 다운로드 기능 추가
"""
import os
import io
import re
import sys
import threading
import urllib.parse
from typing import List
from fastapi import FastAPI, UploadFile, File, HTTPException, Query, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from supabase import create_client, Client
from excel_processor import process_excel_file, export_to_excel
from dotenv import load_dotenv

# stdout 즉시 출력 (Railway 로그 버퍼링 방지)
sys.stdout.reconfigure(line_buffering=True) if hasattr(sys.stdout, 'reconfigure') else None

load_dotenv()

SUPABASE_URL         = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
SUPABASE_ANON_KEY    = os.getenv("SUPABASE_ANON_KEY", "")
FRONTEND_URL         = os.getenv("FRONTEND_URL", "*")

# ─── 관리자 이메일 목록 ───
ADMIN_EMAILS = {"jihun2da@naver.com"}

if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    raise RuntimeError("SUPABASE_URL, SUPABASE_SERVICE_KEY 환경 변수를 설정해 주세요.")

# ── 다운로드 파일 임시 저장 ──
DOWNLOAD_DIR = "/tmp/order_downloads"
os.makedirs(DOWNLOAD_DIR, exist_ok=True)


def _save_download(upload_id: str, excel_bytes: bytes):
    try:
        path = os.path.join(DOWNLOAD_DIR, f"{upload_id}.xlsx")
        with open(path, "wb") as f:
            f.write(excel_bytes)
        print(f"[DOWNLOAD] 저장 완료: {upload_id} ({len(excel_bytes):,} bytes)")
    except Exception as e:
        print(f"[WARN] download 저장 실패: {e}")


app = FastAPI(title="주문 관리 API", version="3.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_URL, "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_supabase() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)


# ─────────────────────────────────────
# 관리자 JWT 검증
# ─────────────────────────────────────
async def verify_admin(authorization: str = Header(None)) -> dict:
    """Authorization: Bearer <supabase_access_token> 헤더를 검증 후 관리자 확인"""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="인증 헤더가 없습니다.")
    token = authorization.split(" ", 1)[1]
    try:
        # Supabase service client로 사용자 JWT 검증
        sb = get_supabase()
        resp = sb.auth.get_user(token)
        user = resp.user
        if not user:
            raise HTTPException(status_code=401, detail="유효하지 않은 토큰입니다.")
        email = user.email or ""
        if email not in ADMIN_EMAILS:
            raise HTTPException(status_code=403, detail="관리자 권한이 없습니다.")
        return {"id": user.id, "email": email}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"인증 실패: {str(e)}")


class DeleteItemsRequest(BaseModel):
    item_ids: List[str]


# ─────────────────────────────────────
# 헬스 체크
# ─────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "healthy"}



# ─────────────────────────────────────
# 엑셀 업로드
# ─────────────────────────────────────
@app.post("/api/upload")
async def upload_excel(file: UploadFile = File(...)):
    """
    엑셀 파일을 받아 처리 후 고유번호 기입된 파일 다운로드 지원
    - 소파일(≤1MB): 동기 처리 후 즉시 결과 반환
    - 대파일: 백그라운드 처리, /api/upload/status/{id} 폴링
    - 완료 후: /api/upload/{id}/download 로 결과 파일 다운로드
    """
    try:
        if not (file.filename or "").lower().endswith((".xlsx", ".xls")):
            raise HTTPException(status_code=400, detail="Excel(.xlsx/.xls) 파일만 업로드 가능합니다.")

        contents = await file.read()
        if len(contents) > 50 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="파일 크기가 50MB를 초과합니다.")

        filename = file.filename or "upload.xlsx"

        # 소파일 → 동기 처리
        if len(contents) <= 1 * 1024 * 1024:
            supabase = get_supabase()
            result = process_excel_file(contents, filename, supabase)
            if not result.get("success"):
                raise HTTPException(status_code=422, detail=result.get("error", "처리 중 오류 발생"))
            # 다운로드 파일 저장
            dl = result.pop("download_bytes", None)
            if dl and result.get("upload_id"):
                _save_download(result["upload_id"], dl)
            return result

        # 대파일 → 백그라운드 처리
        supabase = get_supabase()
        hist = supabase.table("upload_history").insert({
            "filename": filename, "status": "처리중"
        }).execute()
        upload_id = hist.data[0]["id"]

        def bg_task():
            try:
                result = process_excel_file(contents, filename, supabase,
                                            pre_upload_id=upload_id)
                dl = result.pop("download_bytes", None)
                if dl:
                    _save_download(upload_id, dl)
                print(f"[BG DONE] upload_id={upload_id} inserted={result.get('inserted')} updated={result.get('updated')}")
            except Exception as e:
                import traceback
                print(f"[BG ERROR] {e}\n{traceback.format_exc()}")
                try:
                    supabase.table("upload_history").update({
                        "status": "실패", "error_message": str(e)
                    }).eq("id", upload_id).execute()
                except: pass

        t = threading.Thread(target=bg_task, daemon=True)
        t.start()

        return {
            "success":    True,
            "upload_id":  upload_id,
            "processing": True,
            "inserted":   0,
            "updated":    0,
            "errors":     [],
        }

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        print(f"[UPLOAD ERROR] {e}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"서버 오류: {str(e)}")


# ─────────────────────────────────────
# 업로드 상태 조회 (폴링용)
# ─────────────────────────────────────
@app.get("/api/upload/status/{upload_id}")
async def upload_status(upload_id: str):
    supabase = get_supabase()
    try:
        result = supabase.table("upload_history").select(
            "id,filename,status,rows_processed,rows_inserted,rows_updated,error_message,upload_date"
        ).eq("id", upload_id).execute()
        if not result.data:
            raise HTTPException(status_code=404, detail="업로드 이력을 찾을 수 없습니다")
        row = result.data[0]
        is_done = row["status"] not in ("처리중",)
        # 다운로드 파일 존재 여부 확인
        dl_ready = os.path.exists(os.path.join(DOWNLOAD_DIR, f"{upload_id}.xlsx"))
        return {
            "success":     is_done and row["status"] != "실패",
            "processing":  not is_done,
            "upload_id":   upload_id,
            "status":      row["status"],
            "inserted":    row.get("rows_inserted") or 0,
            "updated":     row.get("rows_updated") or 0,
            "rows":        row.get("rows_processed") or 0,
            "error":       row.get("error_message"),
            "filename":    row.get("filename"),
            "download_ready": dl_ready,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─────────────────────────────────────
# 고유번호 기입 엑셀 다운로드
# ─────────────────────────────────────
@app.get("/api/upload/{upload_id}/download")
async def download_excel(upload_id: str):
    """업로드 처리 후 고유번호가 기입된 원본 형식 엑셀 파일 반환"""
    dl_path = os.path.join(DOWNLOAD_DIR, f"{upload_id}.xlsx")
    if not os.path.exists(dl_path):
        raise HTTPException(
            status_code=404,
            detail="다운로드 파일이 없습니다. 처리가 완료된 후 다시 시도하거나 신규 주문이 없는 경우 생성되지 않을 수 있습니다."
        )

    # 원본 파일명 조회
    try:
        supabase = get_supabase()
        row = supabase.table("upload_history").select("filename").eq("id", upload_id).execute()
        original_name = row.data[0]["filename"] if row.data else "주문서.xlsx"
    except Exception:
        original_name = "주문서.xlsx"

    base = original_name.rsplit(".", 1)[0]
    download_name = f"{base}_고유번호.xlsx"
    encoded_name  = urllib.parse.quote(download_name)

    with open(dl_path, "rb") as f:
        content = f.read()

    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_name}"},
    )


# ─────────────────────────────────────
# 업로드 롤백
# ─────────────────────────────────────
@app.post("/api/rollback/{upload_id}")
async def rollback_upload(upload_id: str):
    supabase = get_supabase()
    try:
        result = supabase.rpc("rollback_upload", {"p_upload_id": upload_id}).execute()
        return result.data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─────────────────────────────────────
# 처리중 stuck 업로드 정리 (관리자용)
# ─────────────────────────────────────
@app.post("/api/admin/cleanup-stuck")
async def cleanup_stuck_uploads():
    """5분 이상 '처리중' 상태로 남아있는 업로드를 '실패'로 일괄 업데이트"""
    supabase = get_supabase()
    try:
        from datetime import datetime, timezone, timedelta
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()

        stuck = supabase.table("upload_history").select("id,filename,upload_date") \
            .eq("status", "처리중") \
            .lt("upload_date", cutoff) \
            .execute()

        if not stuck.data:
            return {"updated": 0, "message": "정리할 항목 없음"}

        ids = [r["id"] for r in stuck.data]
        for uid in ids:
            supabase.table("upload_history").update({
                "status": "실패",
                "error_message": "처리 시간 초과 (서버 재시작 또는 타임아웃으로 중단됨)"
            }).eq("id", uid).execute()

        return {
            "updated": len(ids),
            "message": f"{len(ids)}건을 '실패'로 업데이트했습니다",
            "items": [{"id": r["id"][:8] + "...", "filename": r["filename"]} for r in stuck.data]
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─────────────────────────────────────
# 관리자 — 주문 항목 삭제
# ─────────────────────────────────────
@app.delete("/api/admin/items")
async def delete_items(
    body: DeleteItemsRequest,
    admin: dict = Depends(verify_admin),
):
    """
    선택된 order_items를 삭제.
    - order_item_status_logs는 ON DELETE CASCADE로 자동 삭제
    - 삭제 후 order_items가 하나도 없는 orphan orders도 함께 정리
    """
    if not body.item_ids:
        raise HTTPException(status_code=400, detail="삭제할 항목 ID가 없습니다.")
    if len(body.item_ids) > 5000:
        raise HTTPException(status_code=400, detail="한 번에 최대 5,000건까지 삭제 가능합니다.")

    supabase = get_supabase()
    try:
        print(f"[ADMIN DELETE] {admin['email']} → {len(body.item_ids)}건 삭제 요청")

        # 1) 삭제 대상 order_items의 order_id 수집 (orphan 정리용)
        items_resp = supabase.table("order_items").select("id, order_id") \
            .in_("id", body.item_ids).execute()
        order_ids = list({r["order_id"] for r in (items_resp.data or [])})

        # 2) order_items 삭제 (status_logs는 CASCADE 자동 삭제)
        del_resp = supabase.table("order_items") \
            .delete().in_("id", body.item_ids).execute()
        deleted_count = len(del_resp.data or [])

        # 3) orphan orders 정리 (order_items가 0건인 orders 삭제)
        orphan_deleted  = 0
        recycled_count  = 0
        if order_ids:
            remaining = supabase.table("order_items").select("order_id") \
                .in_("order_id", order_ids).execute()
            remaining_ids = {r["order_id"] for r in (remaining.data or [])}
            orphan_ids = [oid for oid in order_ids if oid not in remaining_ids]

            if orphan_ids:
                # ── 3-a) orphan orders 상세 조회 (삭제 전에 수집해야 함) ──
                orphan_orders = supabase.table("orders") \
                    .select("id, order_no, buyer_id, consignor_id, manager_id") \
                    .in_("id", orphan_ids).execute().data or []

                # manager_id → manager_code 매핑
                mgr_ids = list({o["manager_id"] for o in orphan_orders if o.get("manager_id")})
                mgr_map: dict = {}
                if mgr_ids:
                    mgrs = supabase.table("managers").select("id, code") \
                        .in_("id", mgr_ids).execute().data or []
                    mgr_map = {m["id"]: m["code"] for m in mgrs}

                # ── 3-b) orphan orders 삭제 (기존 로직 유지) ──
                orphan_resp  = supabase.table("orders") \
                    .delete().in_("id", orphan_ids).execute()
                orphan_deleted = len(orphan_resp.data or [])

                # ── 3-c) 번호 재활용 처리 (rollback_upload 와 동일 로직) ──
                for order in orphan_orders:
                    buyer_id     = order.get("buyer_id")
                    consignor_id = order.get("consignor_id")
                    manager_id   = order.get("manager_id")
                    order_no     = order.get("order_no", "")
                    mc           = mgr_map.get(manager_id, "") if manager_id else ""
                    if not mc or not order_no:
                        continue

                    # 같은 (buyer, consignor, manager) 그룹의 다른 orders 가 남아있는지 확인
                    # → 남아있다면 카운터가 여전히 사용 중이므로 재활용 안 함
                    chk_q = supabase.table("orders").select("id", count="exact") \
                        .eq("buyer_id", buyer_id).eq("manager_id", manager_id)
                    if consignor_id:
                        chk_q = chk_q.eq("consignor_id", consignor_id)
                    else:
                        chk_q = chk_q.is_("consignor_id", "null")
                    other_count = (chk_q.execute().count or 0)

                    if other_count > 0:
                        # 같은 그룹의 주문이 아직 있으므로 카운터 유지
                        continue

                    # base_number 추출: order_no 패턴 "-숫자(" (롤백 SQL 정규식과 동일)
                    m = re.search(r"-(\d+)\(", order_no)
                    if not m:
                        continue
                    base_num = int(m.group(1))

                    # completed_order_numbers 에 추가 (중복 방지)
                    existing_recycled = supabase.table("completed_order_numbers") \
                        .select("id") \
                        .eq("manager_code", mc) \
                        .eq("base_number", base_num) \
                        .execute().data or []
                    if not existing_recycled:
                        supabase.table("completed_order_numbers").insert({
                            "order_no":     order_no,
                            "manager_code": mc,
                            "base_number":  base_num,
                        }).execute()
                        recycled_count += 1
                        print(f"[ADMIN DELETE] 번호 재활용 등록: {order_no} (mc={mc}, base={base_num})")

                    # buyer_consignor_counters 카운터 해제
                    del_ctr_q = supabase.table("buyer_consignor_counters") \
                        .delete() \
                        .eq("buyer_id", buyer_id) \
                        .eq("manager_code", mc)
                    if consignor_id:
                        del_ctr_q = del_ctr_q.eq("consignor_id", consignor_id)
                    else:
                        del_ctr_q = del_ctr_q.is_("consignor_id", "null")
                    del_ctr_q.execute()

        print(f"[ADMIN DELETE] 완료 — items:{deleted_count}, orphan orders:{orphan_deleted}, recycled:{recycled_count}")
        return {
            "deleted":              deleted_count,
            "orphan_orders_deleted": orphan_deleted,
            "recycled_numbers":     recycled_count,
            "message":              f"{deleted_count}건 삭제 완료 (번호 {recycled_count}개 재활용 등록)",
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─────────────────────────────────────
# 관리자 — 이메일 확인
# ─────────────────────────────────────
@app.get("/api/admin/me")
async def admin_me(admin: dict = Depends(verify_admin)):
    """관리자 여부 확인용 (프론트엔드 초기화 시 호출)"""
    return {"email": admin["email"], "is_admin": True}


# ─────────────────────────────────────
# 엑셀 내보내기 (주문목록 전체)
# ─────────────────────────────────────
@app.get("/api/export")
async def export_excel(
    manager: str = Query(None),
    status:  str = Query(None),
    start:   str = Query(None),
    end:     str = Query(None),
):
    supabase = get_supabase()
    try:
        query = supabase.from_("orders_full").select("*")
        if manager: query = query.eq("manager_code", manager)
        if status:  query = query.eq("item_status", status)
        if start:   query = query.gte("order_date", start)
        if end:     query = query.lte("order_date", end)

        rows = query.order("order_date", desc=True).execute().data
        excel_bytes = export_to_excel(rows)

        from datetime import datetime
        fname = f"orders_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
        return StreamingResponse(
            io.BytesIO(excel_bytes),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename={fname}"},
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
