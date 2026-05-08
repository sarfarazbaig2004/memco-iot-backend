CREATE TYPE "WelderTrackingMode" AS ENUM ('MANUAL', 'RFID', 'MIXED', 'DISABLED');

ALTER TABLE "Machine"
ADD COLUMN "welderTrackingMode" "WelderTrackingMode" NOT NULL DEFAULT 'MANUAL';

CREATE TABLE "ActiveWelderAssignment" (
    "id" SERIAL NOT NULL,
    "machineId" INTEGER NOT NULL,
    "welderId" INTEGER,
    "trackingMode" "WelderTrackingMode" NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "welderName" TEXT,
    "employeeCode" TEXT,
    "rfidCardNo" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdByUserId" INTEGER,
    "endedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActiveWelderAssignment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WelderArcEvent" (
    "id" SERIAL NOT NULL,
    "machineId" INTEGER NOT NULL,
    "assignmentId" INTEGER,
    "welderId" INTEGER,
    "trackingMode" "WelderTrackingMode",
    "welderName" TEXT,
    "employeeCode" TEXT,
    "rfidCardNo" TEXT,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "startTelemetryId" INTEGER,
    "endTelemetryId" INTEGER,
    "startOutputVoltage" DOUBLE PRECISION,
    "startOutputCurrent" DOUBLE PRECISION,
    "endOutputVoltage" DOUBLE PRECISION,
    "endOutputCurrent" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WelderArcEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ActiveWelderAssignment_machineId_status_idx" ON "ActiveWelderAssignment"("machineId", "status");
CREATE INDEX "ActiveWelderAssignment_machineId_startedAt_idx" ON "ActiveWelderAssignment"("machineId", "startedAt");
CREATE INDEX "ActiveWelderAssignment_welderId_status_idx" ON "ActiveWelderAssignment"("welderId", "status");
CREATE INDEX "ActiveWelderAssignment_trackingMode_idx" ON "ActiveWelderAssignment"("trackingMode");

CREATE INDEX "WelderArcEvent_machineId_startTime_idx" ON "WelderArcEvent"("machineId", "startTime");
CREATE INDEX "WelderArcEvent_machineId_endTime_idx" ON "WelderArcEvent"("machineId", "endTime");
CREATE INDEX "WelderArcEvent_assignmentId_idx" ON "WelderArcEvent"("assignmentId");
CREATE INDEX "WelderArcEvent_welderId_startTime_idx" ON "WelderArcEvent"("welderId", "startTime");

ALTER TABLE "ActiveWelderAssignment"
ADD CONSTRAINT "ActiveWelderAssignment_machineId_fkey"
FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ActiveWelderAssignment"
ADD CONSTRAINT "ActiveWelderAssignment_welderId_fkey"
FOREIGN KEY ("welderId") REFERENCES "Welder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WelderArcEvent"
ADD CONSTRAINT "WelderArcEvent_assignmentId_fkey"
FOREIGN KEY ("assignmentId") REFERENCES "ActiveWelderAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WelderArcEvent"
ADD CONSTRAINT "WelderArcEvent_machineId_fkey"
FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WelderArcEvent"
ADD CONSTRAINT "WelderArcEvent_welderId_fkey"
FOREIGN KEY ("welderId") REFERENCES "Welder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
