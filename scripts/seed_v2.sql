BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. CLEAN
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM bed_details;
DELETE FROM wards;
UPDATE users SET block_id = NULL;
DELETE FROM blocks;
DELETE FROM users WHERE role = 'NURSE';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. BLOCKS  (one per BLOCK NAME from the spreadsheet)
--    name_key = URL-safe slug, sort_order follows spreadsheet row order
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO blocks (name, name_key, label, sort_order, created_at, updated_at) VALUES
  -- Block A
  ('GF Emergency',                  'a-gf-em',     'A',  1, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('1F Day Care - Renova',           'a-1f-dcr',    'A',  2, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('1F Day Care - Gastro',           'a-1f-dcg',    'A',  3, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('2F Economy MGW',                 'a-2f-mgw',    'A',  4, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('2F Economy FGW',                 'a-2f-fgw',    'A',  5, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('2F PICU - GW',                   'a-2f-picugw', 'A',  6, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('2F PICU - Peads',                'a-2f-picup',  'A',  7, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('2F NICU',                        'a-2f-nicu',   'A',  8, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('2F Maternity ICU - Renova',      'a-2f-micur',  'A',  9, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('2F HDU - Renova',                'a-2f-hdur',   'A', 10, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('2F Dialysis - Renova',           'a-2f-dialr',  'A', 11, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('2F Positive Dialysis - Renova',  'a-2f-pdialr', 'A', 12, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('2F Dialysis',                    'a-2f-dial',   'A', 13, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('3F Premium Block - Single Room', 'a-3f-pbsr',   'A', 14, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('3F Premium Block - Suite Room',  'a-3f-pbsuite','A', 15, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('3F MICU I',                      'a-3f-micu1',  'A', 16, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('3F MICU II',                     'a-3f-micu2',  'A', 17, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('3F Post OP',                     'a-3f-postop', 'A', 18, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('3F Pre OP',                      'a-3f-preop',  'A', 19, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('4F MICU - Renova',               'a-4f-micur',  'A', 20, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('4F SICU - Renova',               'a-4f-sicur',  'A', 21, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('4F BMT - Renova',                'a-4f-bmtr',   'A', 22, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('4F Single Room - Renova',        'a-4f-srr',    'A', 23, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('4F Twin Sharing - Renova',       'a-4f-tsr',    'A', 24, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  -- Block B
  ('1F General Ward - I',            'b-1f-gw1',    'B', 25, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('1F General Ward - II',           'b-1f-gw2',    'B', 26, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('1F Economy Ward - Single Room',  'b-1f-ewsr',   'B', 27, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('1F Economy Ward - Twin Sharing', 'b-1f-ewts',   'B', 28, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('1F LT / KT Ward - Sharing',      'b-1f-lktsh',  'B', 29, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('1F LT / KT Ward - Single',       'b-1f-lktsr',  'B', 30, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('1F LT / KT Ward - ICU',          'b-1f-lktic',  'B', 31, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('2F Executive - Single Room',     'b-2f-exsr',   'B', 32, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('2F Economy - Sharing Room',      'b-2f-econts', 'B', 33, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('2F Economy - Single Room',       'b-2f-econsr', 'B', 34, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('4F Post Cath ICU',               'b-4f-pcicu',  'B', 35, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('4F CT ICU',                      'b-4f-cticu',  'B', 36, EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. WARDS (each ward → its block by name_key, pre_code used for bed insertion)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO wards (name, block_id, total_beds, nursing_station, unit_type, room_type, pre_code, created_at, updated_at)
SELECT v.ward_name,
       (SELECT id FROM blocks WHERE name_key = v.bk),
       v.total_beds, v.nursing_station, v.unit_type, v.room_type, v.pre_code,
       EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint
FROM (VALUES
  -- Block A
  ('a-gf-em',     'Emergency',                   12, 'Emergency',       'KIMS',          'Emergency',           'A-GF-EM'),
  ('a-1f-dcr',    'Day Care - Renova',            10, 'Chemo Daycare',   'KIMS - Renova', 'Renova - Day Care',   'A-1F-DCR'),
  ('a-1f-dcg',    'Day Care - Gastro',             5, 'Chemo Daycare',   'KIMS',          'Day Care',            'A-1F-DCG'),
  ('a-2f-mgw',    'Economy MGW',                  13, 'General Male',    'KIMS',          'MGW NON AC',          'A-2F-MGW'),
  ('a-2f-fgw',    'Economy FGW',                   8, 'General Female',  'KIMS',          'FGW NON AC',          'A-2F-FGW'),
  ('a-2f-picugw', 'PICU - GW',                     6, NULL,              'KIMS',          'GW (AC)',             'A-2F-PICUGW'),
  ('a-2f-picup',  'PICU - Peads',                  5, NULL,              'KIMS',          'PICU',                'A-2F-PICUP'),
  ('a-2f-nicu',   'NICU',                          16, NULL,              'KIMS',          'NICU',                'A-2F-NICU'),
  ('a-2f-micur',  'Maternity ICU - Renova',         4, 'Z1 Chemo',        'KIMS - Renova', 'Renova - ICU',        'A-2F-MICUR'),
  ('a-2f-hdur',   'HDU - Renova',                   4, 'Z1 Chemo',        'KIMS - Renova', 'Renova - Day Care',   'A-2F-HDUR'),
  ('a-2f-dialr',  'Dialysis - Renova',              8, 'Executive Chemo', 'KIMS - Renova', 'Renova - Day Care',   'A-2F-DIALR'),
  ('a-2f-pdialr', 'Positive Dialysis - Renova',     4, 'Executive Chemo', 'KIMS - Renova', 'Renova - Day Care',   'A-2F-PDIALR'),
  ('a-2f-dial',   'Dialysis',                      10, 'Dialysis',        'KIMS',          'Dialysis',            'A-2F-DIAL'),
  ('a-3f-pbsr',   'Premium Block - Single Room',   11, NULL,              'KIMS',          'SINGLE ROOM - AC',    'A-3F-PBSR'),
  ('a-3f-pbsuite','Premium Block - Suite Room',     1, NULL,              'KIMS',          'SINGLE ROOM - AC',    'A-3F-PBSUITE'),
  ('a-3f-micu1',  'MICU I',                         8, NULL,              'KIMS',          'ICU',                 'A-3F-MICU1'),
  ('a-3f-micu2',  'MICU II',                        8, NULL,              'KIMS',          'ICU',                 'A-3F-MICU2'),
  ('a-3f-postop', 'Post OP',                        5, NULL,              'KIMS',          'OR - Obs',            'A-3F-POSTOP'),
  ('a-3f-preop',  'Pre OP',                         6, NULL,              'KIMS',          'OR - Obs',            'A-3F-PREOP'),
  ('a-4f-micur',  'MICU - Renova',                  5, NULL,              'KIMS - Renova', 'ICU',                 'A-4F-MICUR'),
  ('a-4f-sicur',  'SICU - Renova',                  5, NULL,              'KIMS - Renova', 'ICU',                 'A-4F-SICUR'),
  ('a-4f-bmtr',   'BMT - Renova',                   3, NULL,              'KIMS - Renova', 'BMT',                 'A-4F-BMTR'),
  ('a-4f-srr',    'Single Room - Renova',            7, NULL,              'KIMS - Renova', 'SINGLE ROOM - AC',    'A-4F-SRR'),
  ('a-4f-tsr',    'Twin Sharing - Renova',           6, NULL,              'KIMS - Renova', 'TWIN SHARING - AC',   'A-4F-TSR'),
  -- Block B
  ('b-1f-gw1',    'General Ward - I',              10, NULL,              'KIMS',          'General Ward',          'B-1F-GW1'),
  ('b-1f-gw2',    'General Ward - II',             10, NULL,              'KIMS',          'General Ward',          'B-1F-GW2'),
  ('b-1f-ewsr',   'Economy Ward - Single Room',     2, NULL,              'KIMS',          'SINGLE ROOM - NON AC',  'B-1F-EWSRN'),
  ('b-1f-ewsr',   'Economy Ward - Single Room',     1, NULL,              'KIMS',          'SINGLE ROOM - AC',      'B-1F-EWSRA'),
  ('b-1f-ewts',   'Economy Ward - Twin Sharing',   10, NULL,              'KIMS',          'TWIN SHARING - AC',     'B-1F-EWTSA'),
  ('b-1f-ewts',   'Economy Ward - Twin Sharing',    2, NULL,              'KIMS',          'TWIN SHARING - NON AC', 'B-1F-EWTSN'),
  ('b-1f-lktsh',  'LT / KT Ward - Sharing Rooms',  4, NULL,              'KIMS - Renova', 'TWIN SHARING - AC',     'B-1F-LKTSH'),
  ('b-1f-lktsr',  'LT / KT Ward - Single Rooms',   6, NULL,              'KIMS - Renova', 'SINGLE ROOM - AC',      'B-1F-LKTSR'),
  ('b-1f-lktic',  'LT / KT Ward - ICU',             3, NULL,              'KIMS - Renova', 'LT KT ICU',             'B-1F-LKTIC'),
  ('b-2f-exsr',   'Executive - Single Room',       11, NULL,              'KIMS',          'SINGLE ROOM - AC',      'B-2F-EXSR'),
  ('b-2f-econts', 'Economy - Sharing Room',        12, NULL,              'KIMS',          'TWIN SHARING - AC',     'B-2F-ECONTS'),
  ('b-2f-econsr', 'Economy - Single Room',          3, NULL,              'KIMS',          'SINGLE ROOM - NON AC',  'B-2F-ECONSR'),
  ('b-4f-pcicu',  'Post Cath ICU',                 11, NULL,              'KIMS',          'CICU',                  'B-4F-PCICU'),
  ('b-4f-cticu',  'CT ICU',                         7, NULL,              'KIMS',          'CTICU',                 'B-4F-CTICU')
) AS v(bk, ward_name, total_beds, nursing_station, unit_type, room_type, pre_code);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. BEDS — Block A
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='A-GF-EM'), n::text, 'Non-Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(1,12) n;

INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='A-1F-DCR'), 'CDC '||n, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(1,10) n;

INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='A-1F-DCG'), 'CDC '||n, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(11,15) n;

INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='A-2F-MGW'), 'GM '||n, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(1,13) n;

INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='A-2F-FGW'), 'GF '||n, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(1,8) n;

INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='A-2F-PICUGW'), 'PICU '||n, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(1,6) n;

INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='A-2F-PICUP'), 'PICU '||n, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(7,11) n;

INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='A-2F-NICU'), 'NICU '||n, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(1,16) n;

INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='A-2F-MICUR'), 'CHEMO '||n, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(1,4) n;

INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='A-2F-HDUR'), 'Z3 CHEMO '||n, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(1,4) n;

INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='A-2F-DIALR'), 'Z1 CHEMO '||n, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(1,8) n;

INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='A-2F-PDIALR'), 'Z2 CHEMO '||n, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(1,4) n;

INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='A-2F-DIAL'), 'D '||n, 'Non-Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(1,10) n;

-- 301-304, 306-312
INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='A-3F-PBSR'), n::text, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM (SELECT generate_series(301,304) UNION ALL SELECT generate_series(306,312)) t(n);

INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
VALUES ((SELECT id FROM wards WHERE pre_code='A-3F-PBSUITE'), '305', 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint);

INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='A-3F-MICU1'), 'MICU I-'||n, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(1,8) n;

INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='A-3F-MICU2'), 'MICU II-'||n, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(1,8) n;

INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='A-3F-POSTOP'), 'POST '||n, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(1,5) n;

INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='A-3F-PREOP'), 'PRE '||n, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(1,6) n;

INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='A-4F-MICUR'), 'MICU III-'||n, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(1,5) n;

INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='A-4F-SICUR'), 'SICU '||n, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(1,5) n;

INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='A-4F-BMTR'), 'BMT '||n, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(1,3) n;

-- 403-407, 409, 410
INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='A-4F-SRR'), n::text, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM (SELECT generate_series(403,407) UNION ALL VALUES (409),(410)) t(n);

-- 401A/B, 402A/B, 408A/B
INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='A-4F-TSR'), n::text||s, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM (VALUES (401),(402),(408)) nums(n) CROSS JOIN (VALUES ('A'),('B')) suffs(s) ORDER BY n, s;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. BEDS — Block B
-- ─────────────────────────────────────────────────────────────────────────────

-- ASRI 1-10 (not operational)
INSERT INTO bed_details (ward_id, bed_name, bed_type, operational_status, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='B-1F-GW1'), 'ASRI '||n, 'Census', false, 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(1,10) n;

-- ASRI 11-20 (not operational)
INSERT INTO bed_details (ward_id, bed_name, bed_type, operational_status, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='B-1F-GW2'), 'ASRI '||n, 'Census', false, 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(11,20) n;

-- 108, 110
INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='B-1F-EWSRN'), n::text, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM (VALUES (108),(110)) t(n);

-- 109
INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
VALUES ((SELECT id FROM wards WHERE pre_code='B-1F-EWSRA'), '109', 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint);

-- 101A/B, 102A/B, 103A/B, 105A/B, 106A/B
INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='B-1F-EWTSA'), n::text||s, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM (VALUES (101),(102),(103),(105),(106)) nums(n) CROSS JOIN (VALUES ('A'),('B')) suffs(s) ORDER BY n, s;

-- 104A/B
INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='B-1F-EWTSN'), '104'||s, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM (VALUES ('A'),('B')) t(s);

-- LTKT 117A/B, LTKT 118A/B
INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='B-1F-LKTSH'), 'LTKT '||n::text||s, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM (VALUES (117),(118)) nums(n) CROSS JOIN (VALUES ('A'),('B')) suffs(s) ORDER BY n, s;

-- LTKT 111-116
INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='B-1F-LKTSR'), 'LTKT '||n, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(111,116) n;

-- LTKT ICU 1-3
INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='B-1F-LKTIC'), 'LTKT ICU '||n, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(1,3) n;

-- 210-220
INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='B-2F-EXSR'), n::text, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(210,220) n;

-- 201A/B - 206A/B
INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='B-2F-ECONTS'), n::text||s, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(201,206) n CROSS JOIN (VALUES ('A'),('B')) suffs(s) ORDER BY n, s;

-- 207-209
INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='B-2F-ECONSR'), n::text, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(207,209) n;

-- ANGIO 1-11
INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='B-4F-PCICU'), 'ANGIO '||n, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(1,11) n;

-- CTICU 1-7
INSERT INTO bed_details (ward_id, bed_name, bed_type, physical_status, reservation_status, updated_at)
SELECT (SELECT id FROM wards WHERE pre_code='B-4F-CTICU'), 'CTICU '||n, 'Census', 'VACANT', 'NONE', EXTRACT(EPOCH FROM NOW())::bigint
FROM generate_series(1,7) n;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. NURSE ACCOUNTS  (password: nurse123)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO users (username, password_hash, name, role, nursing_station, created_at, updated_at)
VALUES
  ('nurse_em',   '$2a$10$vNe1cw9ZP3POoN4/H6eF9.sEmc/ADs6VDZxFFF4tFfoAe28KGKZUa', 'Emergency Nurse In-Charge',       'NURSE', 'Emergency',       EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('nurse_cdc',  '$2a$10$vNe1cw9ZP3POoN4/H6eF9.sEmc/ADs6VDZxFFF4tFfoAe28KGKZUa', 'Chemo Daycare Nurse In-Charge',   'NURSE', 'Chemo Daycare',   EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('nurse_gm',   '$2a$10$vNe1cw9ZP3POoN4/H6eF9.sEmc/ADs6VDZxFFF4tFfoAe28KGKZUa', 'General Male Nurse In-Charge',    'NURSE', 'General Male',    EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('nurse_gf',   '$2a$10$vNe1cw9ZP3POoN4/H6eF9.sEmc/ADs6VDZxFFF4tFfoAe28KGKZUa', 'General Female Nurse In-Charge',  'NURSE', 'General Female',  EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('nurse_z1',   '$2a$10$vNe1cw9ZP3POoN4/H6eF9.sEmc/ADs6VDZxFFF4tFfoAe28KGKZUa', 'Z1 Chemo Nurse In-Charge',        'NURSE', 'Z1 Chemo',        EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('nurse_exc',  '$2a$10$vNe1cw9ZP3POoN4/H6eF9.sEmc/ADs6VDZxFFF4tFfoAe28KGKZUa', 'Executive Chemo Nurse In-Charge', 'NURSE', 'Executive Chemo', EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint),
  ('nurse_dial', '$2a$10$vNe1cw9ZP3POoN4/H6eF9.sEmc/ADs6VDZxFFF4tFfoAe28KGKZUa', 'Dialysis Nurse In-Charge',        'NURSE', 'Dialysis',        EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint)
ON CONFLICT (username) DO UPDATE
  SET nursing_station = EXCLUDED.nursing_station, name = EXCLUDED.name, updated_at = EXCLUDED.updated_at;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. SUMMARY
-- ─────────────────────────────────────────────────────────────────────────────
SELECT b.label AS "Block", b.name AS "Block Name", w.name AS "Ward",
       w.nursing_station AS "Station", w.unit_type AS "Unit",
       w.room_type AS "Room Type", COUNT(bd.id) AS "Beds"
FROM blocks b
JOIN wards w ON w.block_id = b.id
LEFT JOIN bed_details bd ON bd.ward_id = w.id
GROUP BY b.label, b.sort_order, b.name, w.id, w.name, w.nursing_station, w.unit_type, w.room_type
ORDER BY b.sort_order, w.id;

COMMIT;
