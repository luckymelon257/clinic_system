-- 001: розширення, ENUM-типи, домени, послідовності, часовий пояс

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Часовий пояс лікарні: для нових сесій (ALTER DATABASE) і поточної сесії (SET)
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone = %L', current_database(), 'Europe/Kyiv');
END $$;
SET timezone = 'Europe/Kyiv';

-- ENUM-типи (мітки 1:1 з packages/contracts/src/enums.ts)
CREATE TYPE user_role          AS ENUM ('admin', 'registrar', 'doctor', 'lab_technician', 'cashier', 'patient');
CREATE TYPE sex_type           AS ENUM ('male', 'female');
CREATE TYPE blood_type         AS ENUM ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-');
CREATE TYPE appointment_status AS ENUM ('scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show');
CREATE TYPE diagnosis_kind     AS ENUM ('primary', 'secondary');
CREATE TYPE medication_form    AS ENUM ('tablet', 'capsule', 'syrup', 'injection', 'ointment', 'drops', 'inhaler');
CREATE TYPE lab_priority       AS ENUM ('routine', 'urgent');
CREATE TYPE lab_order_status   AS ENUM ('ordered', 'in_progress', 'completed', 'cancelled');
CREATE TYPE ward_type          AS ENUM ('general', 'semi_private', 'private', 'icu');
CREATE TYPE bed_status         AS ENUM ('available', 'occupied', 'maintenance');
CREATE TYPE admission_status   AS ENUM ('active', 'discharged');
CREATE TYPE invoice_status     AS ENUM ('draft', 'issued', 'partially_paid', 'paid', 'cancelled');
CREATE TYPE invoice_item_type  AS ENUM ('consultation', 'lab_test', 'stay', 'medication', 'procedure');
CREATE TYPE payment_method     AS ENUM ('cash', 'card', 'bank_transfer', 'insurance');
CREATE TYPE audit_operation    AS ENUM ('INSERT', 'UPDATE', 'DELETE', 'SOFT_DELETE', 'RESTORE');

-- Домени
CREATE DOMAIN d_phone AS text
  CONSTRAINT ck_d_phone_format CHECK (VALUE ~ '^\+?[0-9 ()-]{7,20}$');
CREATE DOMAIN d_money AS numeric(12, 2)
  CONSTRAINT ck_d_money_nonnegative CHECK (VALUE >= 0);

-- Номери рахунків
CREATE SEQUENCE invoice_number_seq;
