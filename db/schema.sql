-- ============================================================================
-- hantu DB — 보드 신호 히스토리 저장소
-- MySQL 8.x / InnoDB / utf8mb4
--
-- 설계 결정 (2026-05-17):
--   - board_name + signal_kind 두 컬럼으로 funnel stage까지 표현
--     예: board_name='QVA2_WATCHLIST', signal_kind='VVI2_FIRED'
--   - stocks 마스터 테이블은 1차 제외 (stocks.json 활용)
--   - outcomes는 별도 cron(populate-signal-outcomes)이 채움
--   - signal_links는 별도 cron(reconcile-signal-links)이 자동 생성
--
-- 적용 (자격증명은 .env의 DB_*를 사용):
--   mysqlsh --sql --uri "${DB_USER}:${DB_PASSWORD_URL_ENCODED}@${DB_HOST}:${DB_PORT}/${DB_NAME}" --file db/schema.sql
--   (URL encode: '@' → '%40', ':' → '%3A' 등. .env 변수는 셸에서 풀어 사용)
--
-- 재실행 안전: 모든 DDL은 CREATE TABLE IF NOT EXISTS 또는 INDEX IF NOT EXISTS
-- ============================================================================

-- 1) board_runs — 보드 generator 1회 실행 단위 기록
CREATE TABLE IF NOT EXISTS board_runs (
  id                  BIGINT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  board_name          VARCHAR(64)     NOT NULL COMMENT '예: ONE_DAY_SURGE, QVA2_WATCHLIST',
  run_date            DATE            NOT NULL COMMENT '실행 일자 (KST)',
  as_of_date          DATE            NULL     COMMENT '보드 분석 기준일 (= meta.analysisDate)',
  source_file         VARCHAR(255)    NULL     COMMENT '읽어 들인 보드 JSON 경로',
  report_json_path    VARCHAR(500)    NULL,
  report_html_path    VARCHAR(500)    NULL,
  candidate_count     INT             NOT NULL DEFAULT 0,
  created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  meta_json           JSON            NULL     COMMENT '보드별 추가 메타 (marketState 등)',

  KEY idx_board_runs_board_date (board_name, run_date),
  KEY idx_board_runs_asof       (as_of_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='보드 generator 실행 기록 (같은 날 재실행 시 row 추가)';

-- 2) board_signals — 가장 중요한 테이블. 후보 1개 = 1행
CREATE TABLE IF NOT EXISTS board_signals (
  id                  BIGINT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id              BIGINT          NOT NULL,

  board_name          VARCHAR(64)     NOT NULL COMMENT '보드 식별자 (예: ONE_DAY_SURGE, QVA2_WATCHLIST)',
  signal_kind         VARCHAR(64)     NOT NULL COMMENT 'funnel stage / 신호 종류 (예: QVA2_NEW, VVI2_FIRED, ATTACK_TOP, MAIN)',
  source_type         VARCHAR(32)     NOT NULL DEFAULT 'DAILY_RUN' COMMENT '출처: DAILY_RUN(매일 cron) / CACHE_BACKFILL(과거 JSON 임포트)',

  signal_date         DATE            NOT NULL COMMENT '신호 발생 거래일',
  as_of_date          DATE            NULL     COMMENT '보드 생성 시 analysisDate',

  stock_code          VARCHAR(20)     NOT NULL,
  stock_name          VARCHAR(100)    NOT NULL,
  market              VARCHAR(20)     NULL,

  signal_price        DECIMAL(18,4)   NULL,
  signal_open         DECIMAL(18,4)   NULL,
  signal_high         DECIMAL(18,4)   NULL,
  signal_low          DECIMAL(18,4)   NULL,
  signal_close        DECIMAL(18,4)   NULL,

  volume              BIGINT          NULL,
  trading_value       BIGINT          NULL,

  score               DECIMAL(10,4)   NULL,
  rank_no             INT             NULL,
  grade               VARCHAR(32)     NULL,
  status_label        VARCHAR(100)    NULL,

  tags_json           JSON            NULL COMMENT '태그 배열 (attackTags, riskTags, auxTags 등)',
  metrics_json        JSON            NULL COMMENT '계산 메트릭 (정해진 표시용 필드)',
  raw_json            JSON            NULL COMMENT '원본 후보 객체 전체 (스키마 진화 대비 보존)',

  created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- 같은 보드의 같은 신호종류의 같은 날 같은 종목은 1행 (upsert)
  UNIQUE KEY uq_signal_unique (board_name, signal_kind, signal_date, stock_code),
  KEY idx_signal_stock_date   (stock_code, signal_date),
  KEY idx_signal_board_date   (board_name, signal_date),
  KEY idx_signal_kind_date    (signal_kind, signal_date),
  KEY idx_signal_source       (source_type),
  KEY idx_signal_name         (stock_name),
  KEY idx_signal_run          (run_id),

  CONSTRAINT fk_signal_run FOREIGN KEY (run_id) REFERENCES board_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='보드 후보 신호 (1차 운영 보드부터 누적)';

-- 3) board_signal_outcomes — 신호 후 D+N 성과
CREATE TABLE IF NOT EXISTS board_signal_outcomes (
  id                   BIGINT         NOT NULL AUTO_INCREMENT PRIMARY KEY,
  signal_id            BIGINT         NOT NULL,
  horizon_days         INT            NOT NULL COMMENT '신호일로부터 거래일수 (1/3/5/10/20)',

  base_price           DECIMAL(18,4)  NULL COMMENT '기준가 (= board_signals.signal_price 복사)',
  close_price          DECIMAL(18,4)  NULL COMMENT 'D+horizon 종가',
  high_price           DECIMAL(18,4)  NULL,
  low_price            DECIMAL(18,4)  NULL,

  max_high_price       DECIMAL(18,4)  NULL COMMENT 'D+1~D+horizon 구간 최고가',
  min_low_price        DECIMAL(18,4)  NULL COMMENT '동 구간 최저가',

  close_return_pct     DECIMAL(10,4)  NULL,
  max_high_return_pct  DECIMAL(10,4)  NULL,
  min_low_return_pct   DECIMAL(10,4)  NULL,

  hit_3                TINYINT(1)     NOT NULL DEFAULT 0,
  hit_5                TINYINT(1)     NOT NULL DEFAULT 0,
  hit_10               TINYINT(1)     NOT NULL DEFAULT 0,
  hit_15               TINYINT(1)     NOT NULL DEFAULT 0,
  hit_20               TINYINT(1)     NOT NULL DEFAULT 0,
  hit_30               TINYINT(1)     NOT NULL DEFAULT 0,

  fail_3               TINYINT(1)     NOT NULL DEFAULT 0,
  fail_5               TINYINT(1)     NOT NULL DEFAULT 0,
  fail_10              TINYINT(1)     NOT NULL DEFAULT 0,

  outcome_json         JSON           NULL COMMENT '추가 계산값 (필요 시)',

  created_at           DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_signal_horizon (signal_id, horizon_days),
  KEY idx_outcome_horizon      (horizon_days),
  KEY idx_outcome_hit10        (hit_10),
  KEY idx_outcome_hit20        (hit_20),
  KEY idx_outcome_hit30        (hit_30),

  CONSTRAINT fk_outcome_signal FOREIGN KEY (signal_id) REFERENCES board_signals(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='신호 후 D+N 성과 (populate-signal-outcomes cron이 채움)';

-- 4) signal_links — 시그널 간 시퀀스 연결 (QVA→VVI 등)
CREATE TABLE IF NOT EXISTS signal_links (
  id                  BIGINT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  from_signal_id      BIGINT          NOT NULL,
  to_signal_id        BIGINT          NOT NULL,
  link_type           VARCHAR(64)     NOT NULL COMMENT '예: QVA2_TO_VVI2, VVI2_TO_BREAKOUT_SUCCESS, ONE_DAY_SURGE_MAIN_TO_ATTACK_TOP',
  days_between        INT             NULL,
  link_note           VARCHAR(255)    NULL,
  meta_json           JSON            NULL,
  created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_signal_link (from_signal_id, to_signal_id, link_type),
  KEY idx_link_type         (link_type),
  KEY idx_link_from         (from_signal_id),
  KEY idx_link_to           (to_signal_id),

  CONSTRAINT fk_link_from FOREIGN KEY (from_signal_id) REFERENCES board_signals(id) ON DELETE CASCADE,
  CONSTRAINT fk_link_to   FOREIGN KEY (to_signal_id)   REFERENCES board_signals(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='보드 간 신호 시퀀스 (reconcile-signal-links cron이 채움)';

-- ============================================================================
-- 확인 쿼리 (수동 sanity)
--   SHOW TABLES;
--   SELECT COUNT(*) FROM board_runs;
--   SELECT COUNT(*) FROM board_signals;
--   DESCRIBE board_signals;
-- ============================================================================
