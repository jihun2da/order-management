-- ============================================================
-- 마이그레이션: 롤백 v2
--   1) order_item_status_logs 테이블 추가 (상태변경 이력)
--   2) rollback_upload 함수 재작성
--      - 상태변경 이력 복원 (입고대기 → 입고 → 롤백 시 입고대기로)
--      - 롤백된 주문번호 재활용 풀에 추가
--      - buyer_consignor_counters 정리 (남은 주문 없는 그룹 해제)
-- Supabase SQL 에디터에서 실행
-- ============================================================

-- ──────────────────────────────────────
-- 1. 상태 변경 이력 테이블
-- ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_item_status_logs (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_history_id UUID        NOT NULL REFERENCES upload_history(id) ON DELETE CASCADE,
  order_item_id     UUID        NOT NULL REFERENCES order_items(id)    ON DELETE CASCADE,
  old_status        TEXT        NOT NULL,
  new_status        TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oisl_upload ON order_item_status_logs(upload_history_id);
CREATE INDEX IF NOT EXISTS idx_oisl_item   ON order_item_status_logs(order_item_id);

-- ──────────────────────────────────────
-- 2. rollback_upload 함수 재작성
-- ──────────────────────────────────────
CREATE OR REPLACE FUNCTION rollback_upload(p_upload_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_deleted_count  INTEGER := 0;
  v_restored_count INTEGER := 0;
  v_log_rec        RECORD;
  v_grp_rec        RECORD;
  v_other_count    INTEGER;
  v_base_num       INTEGER;
  v_rep_order_no   TEXT;
BEGIN

  -- ① 상태 변경 복원
  --    이 업로드로 UPDATE된 기존 order_items의 status를 이전 값으로 되돌림
  FOR v_log_rec IN
    SELECT order_item_id, old_status, new_status
    FROM   order_item_status_logs
    WHERE  upload_history_id = p_upload_id
    ORDER  BY created_at DESC
  LOOP
    UPDATE order_items SET
      status     = v_log_rec.old_status,
      change_log = COALESCE(change_log, '') ||
                   E'\n[' ||
                   TO_CHAR(NOW() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') ||
                   '] 롤백: ' || v_log_rec.new_status || '→' || v_log_rec.old_status,
      updated_at = NOW()
    WHERE id = v_log_rec.order_item_id;
    v_restored_count := v_restored_count + 1;
  END LOOP;

  -- 로그 삭제
  DELETE FROM order_item_status_logs WHERE upload_history_id = p_upload_id;


  -- ② 이 업로드로 생성된 신규 주문 그룹 처리 (삭제 전 수행)
  --    각 (buyer_id, consignor_id, manager_code) 조합별로:
  --      - 다른 업로드 주문이 없으면 → 번호 재활용 풀 등록 + 카운터 해제
  --      - 다른 업로드 주문이 있으면 → 카운터 유지 (번호 재사용 유지)
  FOR v_grp_rec IN
    SELECT DISTINCT
      o.buyer_id,
      o.consignor_id,
      m.code AS manager_code
    FROM   orders   o
    JOIN   managers m ON m.id = o.manager_id
    WHERE  o.upload_history_id = p_upload_id
  LOOP

    -- 다른 업로드에도 이 그룹 주문이 남아있는지 확인
    SELECT COUNT(*) INTO v_other_count
    FROM   orders   o2
    JOIN   managers m2 ON m2.id = o2.manager_id
    WHERE  o2.buyer_id      = v_grp_rec.buyer_id
      AND  m2.code          = v_grp_rec.manager_code
      AND  o2.upload_history_id <> p_upload_id
      AND  (
             (v_grp_rec.consignor_id IS NULL AND o2.consignor_id IS NULL)
          OR o2.consignor_id = v_grp_rec.consignor_id
           );

    IF v_other_count = 0 THEN
      -- 이 그룹의 주문이 이 업로드에만 있음 → 번호 해제

      -- representative order_no + base_number 조회
      SELECT
        (regexp_match(o.order_no, '-(\d+)\('))[1]::INTEGER,
        o.order_no
      INTO v_base_num, v_rep_order_no
      FROM   orders   o
      JOIN   managers m ON m.id = o.manager_id
      WHERE  o.buyer_id      = v_grp_rec.buyer_id
        AND  m.code          = v_grp_rec.manager_code
        AND  o.upload_history_id = p_upload_id
        AND  (
               (v_grp_rec.consignor_id IS NULL AND o.consignor_id IS NULL)
            OR o.consignor_id = v_grp_rec.consignor_id
             )
      LIMIT 1;

      -- 재활용 풀에 추가 (같은 manager_code + base_number가 없을 때만)
      IF v_base_num IS NOT NULL THEN
        INSERT INTO completed_order_numbers (order_no, manager_code, base_number)
        SELECT v_rep_order_no, v_grp_rec.manager_code, v_base_num
        WHERE  NOT EXISTS (
          SELECT 1 FROM completed_order_numbers
          WHERE  manager_code = v_grp_rec.manager_code
            AND  base_number  = v_base_num
        );
      END IF;

      -- buyer_consignor_counters 해제
      DELETE FROM buyer_consignor_counters
      WHERE  buyer_id      = v_grp_rec.buyer_id
        AND  manager_code  = v_grp_rec.manager_code
        AND  (
               (v_grp_rec.consignor_id IS NULL AND consignor_id IS NULL)
            OR consignor_id = v_grp_rec.consignor_id
             );

    END IF;
    -- v_other_count > 0 → 다른 업로드 주문이 남아있으므로 카운터 유지
  END LOOP;


  -- ③ 주문 삭제 (CASCADE → order_items 자동 삭제)
  SELECT COUNT(*) INTO v_deleted_count
  FROM   orders
  WHERE  upload_history_id = p_upload_id;

  DELETE FROM orders WHERE upload_history_id = p_upload_id;


  -- ④ 업로드 이력 상태 갱신
  UPDATE upload_history SET status = '롤백완료' WHERE id = p_upload_id;

  RETURN jsonb_build_object(
    'success',   TRUE,
    'deleted',   v_deleted_count,
    'restored',  v_restored_count
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
