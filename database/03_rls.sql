-- ============================================================
-- Row Level Security (RLS) 정책
-- 로그인한 사용자는 모든 데이터 읽기/수정 가능
-- Service Role Key (FastAPI 백엔드)는 RLS 우회하여 전체 권한
-- ============================================================

ALTER TABLE managers                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE buyers                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE consignors                ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items               ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_history            ENABLE ROW LEVEL SECURITY;
ALTER TABLE buyer_consignor_counters  ENABLE ROW LEVEL SECURITY;
ALTER TABLE completed_order_numbers   ENABLE ROW LEVEL SECURITY;

-- ──────────────────────────────────────
-- 인증된 사용자: 읽기 전체 허용
-- ──────────────────────────────────────
CREATE POLICY "auth_read_managers"
  ON managers FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY "auth_read_buyers"
  ON buyers FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY "auth_read_consignors"
  ON consignors FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY "auth_read_orders"
  ON orders FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY "auth_read_order_items"
  ON order_items FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY "auth_read_upload_history"
  ON upload_history FOR SELECT TO authenticated USING (TRUE);

-- ──────────────────────────────────────
-- 인증된 사용자: 상태 업데이트 허용 (order_items)
-- ──────────────────────────────────────
CREATE POLICY "auth_update_order_items"
  ON order_items FOR UPDATE TO authenticated USING (TRUE);

-- ──────────────────────────────────────
-- orders_full 뷰는 RLS를 사용하는 테이블 기반이므로 별도 정책 불필요
-- ──────────────────────────────────────

-- ──────────────────────────────────────
-- 뷰에 대한 접근 권한 부여
-- ──────────────────────────────────────
GRANT SELECT ON orders_full TO authenticated;
GRANT SELECT ON orders_full TO anon;

-- ──────────────────────────────────────
-- 함수 실행 권한
-- ──────────────────────────────────────
GRANT EXECUTE ON FUNCTION rollback_upload(UUID)              TO authenticated;
GRANT EXECUTE ON FUNCTION update_item_status(UUID, TEXT)     TO authenticated;
GRANT EXECUTE ON FUNCTION get_or_create_buyer(TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION get_or_create_consignor(TEXT)      TO service_role;
GRANT EXECUTE ON FUNCTION get_or_create_manager(TEXT)        TO service_role;
GRANT EXECUTE ON FUNCTION get_or_create_base_number(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION generate_order_no(TEXT, DATE, UUID, UUID, BOOLEAN, INTEGER, INTEGER) TO service_role;
