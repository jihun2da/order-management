# -*- coding: utf-8 -*-
"""
주문 관리 시스템 - FastAPI 백엔드
역할: 엑셀 파일 파싱 + 주문번호 생성 + Supabase 저장
"""
import os
import io
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

app = FastAPI(title="주문 관리 API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_URL, "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_supabase() -> Client:
    """Service Role 키로 연결 (RLS 우회)"""
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
    엑셀 파일을 받아 주문번호를 생성하고 Supabase에 저장합니다.
    - 셀 색상 → 상태 변환 (입고/미송/품절/교환/환불/택배비)
    - 주문번호 Race Condition 방지: DB 함수(SELECT FOR UPDATE) 사용
    - 동일 주문 재업로드 시 상태/수량 변경 이력 자동 기록
    """
    if not (file.filename or "").lower().endswith((".xlsx", ".xls")):
        raise HTTPException(status_code=400, detail="Excel(.xlsx/.xls) 파일만 업로드 가능합니다.")

    contents = await file.read()
    if len(contents) > 20 * 1024 * 1024:  # 20MB 제한
        raise HTTPException(status_code=413, detail="파일 크기가 20MB를 초과합니다.")

    supabase = get_supabase()
    result = process_excel_file(contents, file.filename, supabase)

    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("error", "처리 중 오류 발생"))

    return result


# ─────────────────────────────────────
# 업로드 롤백
# ─────────────────────────────────────
@app.post("/api/rollback/{upload_id}")
async def rollback_upload(upload_id: str):
    """
    업로드 ID로 해당 업로드의 모든 주문을 삭제합니다.
    upload_history_id 직접 연결 방식 → 타임스탬프 비교 버그 없음
    """
    supabase = get_supabase()
    try:
        result = supabase.rpc("rollback_upload", {"p_upload_id": upload_id}).execute()
        return result.data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─────────────────────────────────────
# 엑셀 내보내기 (색상 포함)
# ─────────────────────────────────────
@app.get("/api/export")
async def export_excel(
    manager: str = Query(None),
    status:  str = Query(None),
    start:   str = Query(None),
    end:     str = Query(None),
):
    """
    현재 필터 조건에 맞는 주문을 색상이 입혀진 엑셀로 내보냅니다.
    """
    supabase = get_supabase()
    try:
        query = supabase.from_("orders_full").select("*")
        if manager:
            query = query.eq("manager_code", manager)
        if status:
            query = query.eq("item_status", status)
        if start:
            query = query.gte("order_date", start)
        if end:
            query = query.lte("order_date", end)

        rows = query.order("order_date", desc=True).execute().data
        excel_bytes = export_to_excel(rows)

        from datetime import datetime
        filename = f"orders_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
        return StreamingResponse(
            io.BytesIO(excel_bytes),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
