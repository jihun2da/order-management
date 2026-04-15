-- ============================================================
-- 주문 관리 시스템 - PostgreSQL 함수 & 트리거
-- Race Condition 완전 해결: SELECT FOR UPDATE / SKIP LOCKED 사용
-- ============================================================

-- ──────────────────────────────────────
-- updated_at 자동 갱신 트리거 함수
-- ──────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER trg_order_items_updated_at
  BEFORE UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER trg_buyers_updated_at
  BEFORE UPDATE ON buyers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER trg_managers_updated_at
  BEFORE UPDATE ON managers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ──────────────────────────────────────
-- 주문자 조회/생성 (동명이인 버그 수정)
-- user_id 우선 → name+phone 조합 → name만
-- ──────────────────────────────────────
CREATE OR REPLACE FUNCTION get_or_create_buyer(
  p_name    TEXT,
  p_user_id TEXT DEFAULT NULL,
  p_phone   TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  v_buyer_id UUID;
BEGIN
  -- 1순위: user_id로 검색 (가장 정확)
  IF p_user_id IS NOT NULL AND p_user_id <> '' THEN
    SELECT id INTO v_buyer_id FROM buyers WHERE user_id = p_user_id LIMIT 1;
    IF FOUND THEN RETURN v_buyer_id; END IF;
  END IF;

  -- 2순위: name + phone 조합
  IF p_phone IS NOT NULL AND p_phone <> '' THEN
    SELECT id INTO v_buyer_id FROM buyers
    WHERE name = p_name AND phone = p_phone LIMIT 1;
    IF FOUND THEN RETURN v_buyer_id; END IF;
  END IF;

  -- 3순위: name만 (phone 없는 경우)
  IF (p_phone IS NULL OR p_phone = '') AND (p_user_id IS NULL OR p_user_id = '') THEN
    SELECT id INTO v_buyer_id FROM buyers
    WHERE name = p_name AND phone IS NULL AND user_id IS NULL LIMIT 1;
    IF FOUND THEN RETURN v_buyer_id; END IF;
  END IF;

  -- 신규 생성
  INSERT INTO buyers (user_id, name, phone)
  VALUES (NULLIF(p_user_id,''), p_name, NULLIF(p_phone,''))
  RETURNING id INTO v_buyer_id;

  RETURN v_buyer_id;
END;
$$ LANGUAGE plpgsql;

-- ──────────────────────────────────────
-- 위탁자 조회/생성
-- ──────────────────────────────────────
CREATE OR REPLACE FUNCTION get_or_create_consignor(p_name TEXT)
RETURNS UUID AS $$
DECLARE
  v_id UUID;
BEGIN
  SELECT id INTO v_id FROM consignors WHERE name = p_name LIMIT 1;
  IF NOT FOUND THEN
    INSERT INTO consignors (name) VALUES (p_name) RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- ──────────────────────────────────────
-- 담당자 조회/생성
-- ──────────────────────────────────────
CREATE OR REPLACE FUNCTION get_or_create_manager(p_code TEXT)
RETURNS UUID AS $$
DECLARE
  v_id UUID;
BEGIN
  SELECT id INTO v_id FROM managers WHERE code = p_code LIMIT 1;
  IF NOT FOUND THEN
    INSERT INTO managers (code, name) VALUES (p_code, '담당자'||p_code) RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- ──────────────────────────────────────
-- 핵심 함수: 주문번호용 기본번호 조회/생성
-- SELECT FOR UPDATE 로 동시접속 Race Condition 완전 차단
-- ──────────────────────────────────────
CREATE OR REPLACE FUNCTION get_or_create_base_number(
  p_buyer_id      UUID,
  p_consignor_id  UUID,
  p_manager_code  TEXT
) RETURNS INTEGER AS $$
DECLARE
  v_base_number   INTEGER;
  v_max_base      INTEGER;
  v_recycled_base INTEGER;
  v_recycled_id   UUID;
BEGIN
  -- 기존 번호 조회 (행 잠금으로 동시 접근 방지)
  IF p_consignor_id IS NOT NULL THEN
    SELECT base_number INTO v_base_number
    FROM buyer_consignor_counters
    WHERE buyer_id     = p_buyer_id
      AND consignor_id = p_consignor_id
      AND manager_code = p_manager_code
    FOR UPDATE;
  ELSE
    SELECT base_number INTO v_base_number
    FROM buyer_consignor_counters
    WHERE buyer_id     = p_buyer_id
      AND consignor_id IS NULL
      AND manager_code = p_manager_code
    FOR UPDATE;
  END IF;

  IF FOUND THEN
    RETURN v_base_number;
  END IF;

  -- 재활용 풀에서 가장 오래된 번호 가져오기 (SKIP LOCKED: 다른 트랜잭션 충돌 방지)
  SELECT id, base_number INTO v_recycled_id, v_recycled_base
  FROM completed_order_numbers
  WHERE manager_code = p_manager_code
    AND base_number IS NOT NULL
  ORDER BY completed_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF FOUND THEN
    -- 재활용 풀에서 제거
    DELETE FROM completed_order_numbers WHERE id = v_recycled_id;
    v_base_number := v_recycled_base;
  ELSE
    -- 이 담당자의 현재 최대 번호 + 1
    SELECT COALESCE(MAX(base_number), 0) + 1 INTO v_max_base
    FROM buyer_consignor_counters
    WHERE manager_code = p_manager_code;
    v_base_number := v_max_base;
  END IF;

  -- 새 카운터 삽입
  INSERT INTO buyer_consignor_counters (buyer_id, consignor_id, manager_code, base_number)
  VALUES (p_buyer_id, p_consignor_id, p_manager_code, v_base_number)
  ON CONFLICT DO NOTHING;

  RETURN v_base_number;
END;
$$ LANGUAGE plpgsql;

-- ──────────────────────────────────────
-- 주문번호 생성 최종 함수
-- 형식: {prefix}{manager_code}{YYMMDD}-{base_number}({seq}/{total})
-- 예시: AB260415-5(1/2), #CD260415-12(2/2)
-- ──────────────────────────────────────
CREATE OR REPLACE FUNCTION generate_order_no(
  p_manager_code   TEXT,
  p_order_date     DATE,
  p_buyer_id       UUID,
  p_consignor_id   UUID,
  p_is_consignment BOOLEAN,
  p_seq_num        INTEGER,
  p_total_count    INTEGER
) RETURNS TEXT AS $$
DECLARE
  v_base_number INTEGER;
  v_prefix      TEXT;
  v_ymd         TEXT;
BEGIN
  v_base_number := get_or_create_base_number(p_buyer_id, p_consignor_id, p_manager_code);
  v_prefix := CASE WHEN p_is_consignment THEN '#' ELSE '' END;
  v_ymd    := TO_CHAR(p_order_date, 'YYMMDD');

  RETURN v_prefix || p_manager_code || v_ymd || '-' || v_base_number
         || '(' || p_seq_num || '/' || p_total_count || ')';
END;
$$ LANGUAGE plpgsql;

-- ──────────────────────────────────────
-- 주문 아이템 상태 변경 함수 (변경 이력 자동 기록)
-- ──────────────────────────────────────
CREATE OR REPLACE FUNCTION update_item_status(
  p_item_id   UUID,
  p_new_status TEXT
) RETURNS VOID AS $$
DECLARE
  v_item    order_items%ROWTYPE;
  v_change  TEXT;
  v_now     TEXT;
BEGIN
  SELECT * INTO v_item FROM order_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '아이템을 찾을 수 없습니다: %', p_item_id; END IF;
  IF v_item.status = p_new_status THEN RETURN; END IF;

  v_now := TO_CHAR(NOW() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI');
  v_change := '[' || v_now || '] 상태: ' || v_item.status || ' → ' || p_new_status;

  UPDATE order_items SET
    status         = p_new_status,
    status_history = COALESCE(status_history, v_item.status) || ' → ' || p_new_status,
    change_log     = CASE
                       WHEN change_log IS NULL THEN v_change
                       ELSE change_log || E'\n' || v_change
                     END,
    updated_at     = NOW()
  WHERE id = p_item_id;
END;
$$ LANGUAGE plpgsql;

-- ──────────────────────────────────────
-- 트리거: 모든 아이템이 완료되면 주문 자동 완료 + 번호 재활용 풀에 추가
-- ──────────────────────────────────────
CREATE OR REPLACE FUNCTION check_order_completion()
RETURNS TRIGGER AS $$
DECLARE
  v_all_done   BOOLEAN;
  v_order      orders%ROWTYPE;
  v_manager    managers%ROWTYPE;
  v_base_num   INTEGER;
BEGIN
  -- 이 주문의 미완료 아이템이 있는지 확인
  SELECT NOT EXISTS (
    SELECT 1 FROM order_items
    WHERE order_id = NEW.order_id
      AND status NOT IN ('완료')
  ) INTO v_all_done;

  IF v_all_done THEN
    SELECT * INTO v_order FROM orders WHERE id = NEW.order_id FOR UPDATE;

    IF v_order.status <> '완료' THEN
      SELECT * INTO v_manager FROM managers WHERE id = v_order.manager_id;

      -- order_no에서 base_number 추출: AB260415-5(1/2) → 5
      BEGIN
        v_base_num := (regexp_match(v_order.order_no, '-(\d+)\('))[1]::INTEGER;
      EXCEPTION WHEN OTHERS THEN
        v_base_num := NULL;
      END;

      -- 재활용 풀에 추가
      INSERT INTO completed_order_numbers (order_no, manager_code, base_number)
      VALUES (v_order.order_no, v_manager.code, v_base_num)
      ON CONFLICT (order_no) DO NOTHING;

      -- 주문 상태를 완료로 변경
      UPDATE orders SET status = '완료', updated_at = NOW()
      WHERE id = NEW.order_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_check_order_completion
  AFTER UPDATE OF status ON order_items
  FOR EACH ROW
  WHEN (NEW.status = '완료')
  EXECUTE FUNCTION check_order_completion();

-- ──────────────────────────────────────
-- 업로드 롤백 함수 (upload_history_id 기반 → 타임스탬프 비교 버그 해결)
-- ──────────────────────────────────────
CREATE OR REPLACE FUNCTION rollback_upload(p_upload_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_deleted_count INTEGER := 0;
  v_order_rec     RECORD;
BEGIN
  -- 해당 업로드의 주문 삭제 (CASCADE로 order_items 자동 삭제)
  FOR v_order_rec IN
    SELECT id, order_no FROM orders WHERE upload_history_id = p_upload_id
  LOOP
    -- 재활용 풀에 있다면 제거 (롤백이므로 번호도 복구)
    DELETE FROM completed_order_numbers WHERE order_no = v_order_rec.order_no;
    DELETE FROM orders WHERE id = v_order_rec.id;
    v_deleted_count := v_deleted_count + 1;
  END LOOP;

  -- 업로드 이력 상태 업데이트
  UPDATE upload_history SET status = '롤백완료' WHERE id = p_upload_id;

  RETURN jsonb_build_object('success', TRUE, 'deleted', v_deleted_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
