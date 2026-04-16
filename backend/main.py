# -*- coding: utf-8 -*-
"""
주문 관리 시스템 - FastAPI 백엔드 v3.1
역할: 엑셀 파일 파싱 + 주문번호 생성(로컬) + Supabase 저장
v3.1: 업로드 후 고유번호 기입된 엑셀 다운로드 기능 추가
"""
import os
import io
import sys
import threading
import urllib.parse
from fastapi import FastAPI, UploadFile, File, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from supabase import create_client, Client
from excel_processor import process_excel_file, export_to_excel
from dotenv import load_dotenv

# stdout 즉시 출력 (Railway 로그 버퍼링 방지)
sys.stdout.reconfigure(line_buffering=True) if hasattr(sys.stdout, 'reconfigure') else None

load_dotenv()

SUPABASE_URL         = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
FRONTEND_URL         = os.getenv("FRONTEND_URL", "*")

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
