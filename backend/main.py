# -*- coding: utf-8 -*-
"""
주문 관리 시스템 - FastAPI 백엔드
역할: 엑셀 파일 파싱 + 주문번호 생성 + Supabase 저장
비동기 처리: 대용량 파일은 background thread로 처리 후 polling
"""
import os
import io
import threading
from fastapi import FastAPI, UploadFile, File, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from supabase import create_client, Client
from excel_processor import process_excel_file, export_to_excel
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL         = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
FRONTEND_URL         = os.getenv("FRONTEND_URL", "*")

if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    raise RuntimeError("SUPABASE_URL, SUPABASE_SERVICE_KEY 환경 변수를 설정해 주세요.")

app = FastAPI(title="주문 관리 API", version="2.5.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_URL, "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_supabase() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)


def _run_in_background(contents: bytes, filename: str):
    """별도 스레드에서 엑셀 처리 (대용량 파일 타임아웃 방지)"""
    try:
        supabase = get_supabase()
        process_excel_file(contents, filename, supabase)
    except Exception as e:
        import traceback
        print(f"[BG ERROR] {e}\n{traceback.format_exc()}")


# ─────────────────────────────────────
# 헬스 체크
# ─────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "healthy"}


# ─────────────────────────────────────
# 엑셀 업로드 (비동기)
# ─────────────────────────────────────
@app.post("/api/upload")
async def upload_excel(file: UploadFile = File(...)):
    """
    엑셀 파일을 받아 백그라운드에서 처리합니다.
    - 즉시 upload_id 반환 (processing: true)
    - 프론트엔드는 /api/upload/status/{upload_id} 로 폴링
    - 소규모 파일(≤500행)은 동기 처리 후 즉시 결과 반환
    """
    try:
        if not (file.filename or "").lower().endswith((".xlsx", ".xls")):
            raise HTTPException(status_code=400, detail="Excel(.xlsx/.xls) 파일만 업로드 가능합니다.")

        contents = await file.read()
        if len(contents) > 50 * 1024 * 1024:  # 50MB 제한
            raise HTTPException(status_code=413, detail="파일 크기가 50MB를 초과합니다.")

        filename = file.filename or "upload.xlsx"

        # 파일 크기로 처리 방식 결정
        # 1MB 이하 소파일 → 동기 처리 (즉시 결과)
        if len(contents) <= 1 * 1024 * 1024:
            supabase = get_supabase()
            result = process_excel_file(contents, filename, supabase)
            if not result.get("success"):
                raise HTTPException(status_code=422, detail=result.get("error", "처리 중 오류 발생"))
            return result

        # 대용량 → upload_history 먼저 생성 후 백그라운드 실행
        supabase = get_supabase()
        hist = supabase.table("upload_history").insert({
            "filename": filename, "status": "처리중"
        }).execute()
        upload_id = hist.data[0]["id"]

        # 백그라운드 스레드 시작
        def bg_task():
            try:
                result = process_excel_file(contents, filename, supabase,
                                            pre_upload_id=upload_id)
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
        return {
            "success":    is_done and row["status"] != "실패",
            "processing": not is_done,
            "upload_id":  upload_id,
            "status":     row["status"],
            "inserted":   row.get("rows_inserted") or 0,
            "updated":    row.get("rows_updated") or 0,
            "rows":       row.get("rows_processed") or 0,
            "error":      row.get("error_message"),
            "filename":   row.get("filename"),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
# 엑셀 내보내기
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
