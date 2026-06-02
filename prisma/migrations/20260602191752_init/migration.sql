-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "username" VARCHAR(255) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" VARCHAR(20) NOT NULL,
    "name" TEXT NOT NULL,
    "shift" VARCHAR(20) NOT NULL DEFAULT 'morning',
    "created_at" BIGINT NOT NULL,
    "updated_at" BIGINT NOT NULL,
    "block_id" INTEGER,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "floors" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "floors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocks" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "label" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" BIGINT NOT NULL,
    "updated_at" BIGINT NOT NULL,

    CONSTRAINT "blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wards" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "total_beds" INTEGER NOT NULL,
    "created_at" BIGINT NOT NULL,
    "updated_at" BIGINT NOT NULL,
    "block_id" INTEGER,
    "floor_id" INTEGER,
    "pre_code" TEXT,

    CONSTRAINT "wards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "beds" (
    "ward_id" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "vacant" INTEGER,
    "reserved" INTEGER,
    "occupied" INTEGER,
    "updated_at" BIGINT,
    "updated_by" INTEGER,

    CONSTRAINT "beds_pkey" PRIMARY KEY ("ward_id")
);

-- CreateTable
CREATE TABLE "pre_assignments" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "pre_code" TEXT NOT NULL,
    "created_at" BIGINT NOT NULL,

    CONSTRAINT "pre_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bed_status_updates" (
    "id" SERIAL NOT NULL,
    "ward_id" INTEGER NOT NULL,
    "vacant" INTEGER NOT NULL,
    "reserved" INTEGER NOT NULL,
    "occupied" INTEGER NOT NULL,
    "updated_by" INTEGER,
    "created_at" BIGINT NOT NULL,

    CONSTRAINT "bed_status_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pre_rounds" (
    "id" SERIAL NOT NULL,
    "pre_code" TEXT NOT NULL,
    "user_id" INTEGER,
    "shift" VARCHAR(20) NOT NULL,
    "round_key" TEXT NOT NULL,
    "start_min" INTEGER NOT NULL,
    "submitted_at" BIGINT NOT NULL,
    "snapshot" TEXT,
    "block_id" INTEGER,

    CONSTRAINT "pre_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminders" (
    "id" SERIAL NOT NULL,
    "target_role" VARCHAR(20) NOT NULL,
    "interval_min" INTEGER NOT NULL,
    "window_start" VARCHAR(10) NOT NULL,
    "window_end" VARCHAR(10) NOT NULL,
    "active" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "start_time" VARCHAR(10) NOT NULL,
    "end_time" VARCHAR(10) NOT NULL,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" SERIAL NOT NULL,
    "ts" BIGINT NOT NULL,
    "user_id" INTEGER,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "detail" TEXT,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "occupancy_snapshots" (
    "id" SERIAL NOT NULL,
    "ts" BIGINT NOT NULL,
    "total" INTEGER NOT NULL,
    "vacant" INTEGER NOT NULL,
    "reserved" INTEGER NOT NULL,
    "occupied" INTEGER NOT NULL,

    CONSTRAINT "occupancy_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "endpoint" TEXT NOT NULL,
    "sub_json" TEXT NOT NULL,
    "created_at" BIGINT NOT NULL,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bed_details" (
    "id" SERIAL NOT NULL,
    "ward_id" INTEGER NOT NULL,
    "bed_number" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "updated_at" BIGINT NOT NULL,
    "updated_by" INTEGER,

    CONSTRAINT "bed_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bed_movements" (
    "id" SERIAL NOT NULL,
    "bed_id" INTEGER NOT NULL,
    "old_status" VARCHAR(20) NOT NULL,
    "new_status" VARCHAR(20) NOT NULL,
    "changed_by" INTEGER,
    "changed_at" BIGINT NOT NULL,

    CONSTRAINT "bed_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_views" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "created_by" INTEGER,
    "selected_wards" TEXT NOT NULL DEFAULT '[]',
    "is_shared" INTEGER NOT NULL DEFAULT 0,
    "is_system" INTEGER NOT NULL DEFAULT 0,
    "created_at" BIGINT NOT NULL,
    "updated_at" BIGINT NOT NULL,

    CONSTRAINT "saved_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "floors_name_key" ON "floors"("name");

-- CreateIndex
CREATE UNIQUE INDEX "blocks_name_key_key" ON "blocks"("name_key");

-- CreateIndex
CREATE INDEX "blocks_name_key_idx" ON "blocks"("name_key");

-- CreateIndex
CREATE INDEX "wards_block_id_idx" ON "wards"("block_id");

-- CreateIndex
CREATE INDEX "wards_pre_code_idx" ON "wards"("pre_code");

-- CreateIndex
CREATE INDEX "wards_floor_id_idx" ON "wards"("floor_id");

-- CreateIndex
CREATE INDEX "pre_assignments_user_id_idx" ON "pre_assignments"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "pre_assignments_user_id_pre_code_key" ON "pre_assignments"("user_id", "pre_code");

-- CreateIndex
CREATE INDEX "bed_status_updates_ward_id_created_at_idx" ON "bed_status_updates"("ward_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "pre_rounds_round_key_key" ON "pre_rounds"("round_key");

-- CreateIndex
CREATE INDEX "pre_rounds_pre_code_submitted_at_idx" ON "pre_rounds"("pre_code", "submitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "shifts_key_key" ON "shifts"("key");

-- CreateIndex
CREATE INDEX "audit_logs_ts_idx" ON "audit_logs"("ts");

-- CreateIndex
CREATE INDEX "occupancy_snapshots_ts_idx" ON "occupancy_snapshots"("ts");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscriptions"("user_id");

-- CreateIndex
CREATE INDEX "bed_details_ward_id_status_idx" ON "bed_details"("ward_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "bed_details_ward_id_bed_number_key" ON "bed_details"("ward_id", "bed_number");

-- CreateIndex
CREATE INDEX "bed_movements_bed_id_changed_at_idx" ON "bed_movements"("bed_id", "changed_at");

-- CreateIndex
CREATE INDEX "saved_views_created_by_idx" ON "saved_views"("created_by");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_block_id_fkey" FOREIGN KEY ("block_id") REFERENCES "blocks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wards" ADD CONSTRAINT "wards_block_id_fkey" FOREIGN KEY ("block_id") REFERENCES "blocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wards" ADD CONSTRAINT "wards_floor_id_fkey" FOREIGN KEY ("floor_id") REFERENCES "floors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "beds" ADD CONSTRAINT "beds_ward_id_fkey" FOREIGN KEY ("ward_id") REFERENCES "wards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "beds" ADD CONSTRAINT "beds_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_assignments" ADD CONSTRAINT "pre_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bed_status_updates" ADD CONSTRAINT "bed_status_updates_ward_id_fkey" FOREIGN KEY ("ward_id") REFERENCES "wards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bed_status_updates" ADD CONSTRAINT "bed_status_updates_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_rounds" ADD CONSTRAINT "pre_rounds_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_rounds" ADD CONSTRAINT "pre_rounds_block_id_fkey" FOREIGN KEY ("block_id") REFERENCES "blocks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bed_details" ADD CONSTRAINT "bed_details_ward_id_fkey" FOREIGN KEY ("ward_id") REFERENCES "wards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bed_details" ADD CONSTRAINT "bed_details_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bed_movements" ADD CONSTRAINT "bed_movements_bed_id_fkey" FOREIGN KEY ("bed_id") REFERENCES "bed_details"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bed_movements" ADD CONSTRAINT "bed_movements_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
