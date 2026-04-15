-- ============================================================
-- 주문 관리 시스템 - Supabase DB 스키마
-- 실행 순서: 01_schema → 02_functions → 03_rls
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ──────────────────────────────────────
-- 담당자 테이블
-- ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS managers (
  id          UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  code        VARCHAR(10)  UNIQUE NOT NULL,       -- 알파벳 코드 (A, AB, BC 등)
  name        VARCHAR(50)  NOT NULL,
  email       VARCHAR(100),
  phone       VARCHAR(20),
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────
-- 주문자 테이블
-- ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS buyers (
  id          UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id     VARCHAR(50),                        -- 쇼핑몰 아이디
  name        VARCHAR(50) NOT NULL,
  phone       VARCHAR(20),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_buyers_name    ON buyers(name);
CREATE INDEX IF NOT EXISTS idx_buyers_user_id ON buyers(user_id);

-- ──────────────────────────────────────
-- 위탁자 테이블
-- ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS consignors (
  id          UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  name        VARCHAR(100) NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────
-- 업로드 이력 테이블
-- ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS upload_history (
  id              UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  filename        VARCHAR(255) NOT NULL,
  upload_date     TIMESTAMPTZ  DEFAULT NOW(),
  status          VARCHAR(20)  DEFAULT '처리중'
                    CHECK (status IN ('처리중','완료','실패','롤백완료')),
  rows_processed  INTEGER DEFAULT 0,
  rows_inserted   INTEGER DEFAULT 0,
  rows_updated    INTEGER DEFAULT 0,
  error_message   TEXT,
  uploaded_by     UUID REFERENCES auth.users(id)
);
CREATE INDEX IF NOT EXISTS idx_upload_history_date ON upload_history(upload_date DESC);

-- ──────────────────────────────────────
-- 주문 테이블
-- ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id                 UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  order_no           VARCHAR(100) UNIQUE NOT NULL,   -- 고유번호 (예: AB260415-5(1/2))
  manager_id         UUID REFERENCES managers(id)    NOT NULL,
  buyer_id           UUID REFERENCES buyers(id)      NOT NULL,
  consignor_id       UUID REFERENCES consignors(id),
  order_date         DATE  NOT NULL,
  status             VARCHAR(20) DEFAULT '입고대기'
                       CHECK (status IN ('입고대기','입고','미송','품절','교환','환불','택배비','완료')),
  upload_history_id  UUID REFERENCES upload_history(id),   -- 롤백에 사용
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_order_no          ON orders(order_no);
CREATE INDEX IF NOT EXISTS idx_orders_manager_id        ON orders(manager_id);
CREATE INDEX IF NOT EXISTS idx_orders_order_date        ON orders(order_date DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status            ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_upload_history_id ON orders(upload_history_id);

-- ──────────────────────────────────────
-- 주문 상품 항목 테이블 (notes blob 제거 → 개별 컬럼)
-- ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_items (
  id              UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  order_id        UUID REFERENCES orders(id) ON DELETE CASCADE NOT NULL,
  product_name    VARCHAR(200) NOT NULL,
  quantity        INTEGER DEFAULT 1,
  color           VARCHAR(50),
  status          VARCHAR(20) DEFAULT '입고대기'
                    CHECK (status IN ('입고대기','입고','미송','품절','교환','환불','택배비','완료')),
  -- 기존 notes blob에서 분리된 개별 컬럼
  barcode         VARCHAR(100),
  brand           VARCHAR(100),
  size            VARCHAR(50),
  options         VARCHAR(100),
  wholesale_price VARCHAR(50),
  supplier        VARCHAR(100),
  item_notes      TEXT,           -- 비고
  recipient_name  VARCHAR(100),   -- 수령인 이름
  phone           VARCHAR(20),
  address         TEXT,           -- 주소 (쉼표 포함 가능)
  buyer_user_id   VARCHAR(50),
  delivery_msg    TEXT,           -- 배송 메세지 (쉼표 포함 가능)
  item_code       VARCHAR(50),
  -- 상태 변경 추적
  status_history  TEXT,
  change_log      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id     ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_status       ON order_items(status);
CREATE INDEX IF NOT EXISTS idx_order_items_product_name ON order_items(product_name);

-- ──────────────────────────────────────
-- 주문자+위탁자+담당자 조합별 기본번호 카운터
-- ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS buyer_consignor_counters (
  id             UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  buyer_id       UUID REFERENCES buyers(id)     NOT NULL,
  consignor_id   UUID REFERENCES consignors(id),           -- NULL 가능
  manager_code   VARCHAR(10) NOT NULL,
  base_number    INTEGER     NOT NULL,
  UNIQUE(buyer_id, consignor_id, manager_code)
);
CREATE INDEX IF NOT EXISTS idx_bcc_manager_code ON buyer_consignor_counters(manager_code);

-- NULL consignor_id 를 포함한 유니크 인덱스 (PostgreSQL의 NULL != NULL 이슈 해결)
CREATE UNIQUE INDEX IF NOT EXISTS idx_bcc_null_consignor
  ON buyer_consignor_counters(buyer_id, manager_code)
  WHERE consignor_id IS NULL;

-- ──────────────────────────────────────
-- 완료된 주문번호 재활용 풀
-- ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS completed_order_numbers (
  id             UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  order_no       VARCHAR(100) UNIQUE NOT NULL,
  manager_code   VARCHAR(10)  NOT NULL,
  base_number    INTEGER,                    -- 재활용할 기본번호
  completed_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_completed_manager ON completed_order_numbers(manager_code, completed_at);

-- ──────────────────────────────────────
-- 통합 조회 뷰 (프론트엔드에서 직접 사용)
-- ──────────────────────────────────────
CREATE OR REPLACE VIEW orders_full AS
SELECT
  m.code              AS manager_code,
  o.id                AS order_id,
  o.order_no,
  o.order_date,
  o.status            AS order_status,
  o.upload_history_id,
  b.name              AS buyer_name,
  b.user_id           AS buyer_user_id_ref,
  c.name              AS consignor_name,
  oi.id               AS item_id,
  oi.product_name,
  oi.quantity,
  oi.color,
  oi.status           AS item_status,
  oi.barcode,
  oi.brand,
  oi.size,
  oi.options,
  oi.wholesale_price,
  oi.supplier,
  oi.item_notes,
  oi.recipient_name,
  oi.phone,
  oi.address,
  oi.buyer_user_id,
  oi.delivery_msg,
  oi.item_code,
  oi.status_history,
  oi.change_log,
  oi.updated_at       AS item_updated_at
FROM orders o
JOIN managers    m  ON o.manager_id   = m.id
JOIN buyers      b  ON o.buyer_id     = b.id
LEFT JOIN consignors c ON o.consignor_id = c.id
JOIN order_items oi ON oi.order_id    = o.id
ORDER BY o.order_date DESC, o.order_no;
