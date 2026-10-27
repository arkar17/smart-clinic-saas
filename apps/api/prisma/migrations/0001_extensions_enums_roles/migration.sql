-- SC-1 migration 0001 (Plan §5.5, Arch §21): extensions, enums, database roles.

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "platform_role" AS ENUM ('NONE', 'PLATFORM_ADMIN');

-- CreateEnum
CREATE TYPE "clinic_role" AS ENUM ('CLINIC_ADMIN', 'RECEPTIONIST', 'DOCTOR');

-- CreateEnum
CREATE TYPE "clinic_status" AS ENUM ('PENDING_SETUP', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "schedule_exception_kind" AS ENUM ('UNAVAILABLE', 'MODIFIED_HOURS');

-- CreateEnum
CREATE TYPE "actor_type" AS ENUM ('STAFF', 'PUBLIC_PATIENT', 'SYSTEM');


-- Roles: sc_owner owns/administers schema objects; sc_app is the application role (login roles are granted it per environment).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sc_owner') THEN CREATE ROLE sc_owner NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sc_app') THEN CREATE ROLE sc_app NOLOGIN; END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO sc_app;
GRANT USAGE ON TYPE platform_role, clinic_role, clinic_status, schedule_exception_kind, actor_type TO sc_app;
