ALTER TABLE "Telemetry"
ADD COLUMN "machineOn" BOOLEAN;

CREATE TABLE "MachineLatestTelemetry" (
    "id" SERIAL NOT NULL,
    "machineId" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "inputVoltage" DOUBLE PRECISION,
    "outputVoltage" DOUBLE PRECISION,
    "outputCurrent" DOUBLE PRECISION,
    "temperature" DOUBLE PRECISION,
    "trafoCoreTemperature" DOUBLE PRECISION,
    "igbtTemperature" DOUBLE PRECISION,
    "heatSyncTemperature" DOUBLE PRECISION,
    "machineOn" BOOLEAN,
    "arcOn" BOOLEAN,
    "state" TEXT NOT NULL,
    "gpsFix" BOOLEAN,
    "gpsLat" DOUBLE PRECISION,
    "gpsLng" DOUBLE PRECISION,
    "mapUrl" TEXT,
    "telemetryId" INTEGER,
    "lastReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MachineLatestTelemetry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MachineProductionEvent" (
    "id" SERIAL NOT NULL,
    "machineId" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MachineProductionEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DailyProductionSummary" (
    "id" SERIAL NOT NULL,
    "machineId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "arcSeconds" INTEGER NOT NULL DEFAULT 0,
    "idleSeconds" INTEGER NOT NULL DEFAULT 0,
    "offSeconds" INTEGER NOT NULL DEFAULT 0,
    "offlineSeconds" INTEGER NOT NULL DEFAULT 0,
    "machineOnSeconds" INTEGER NOT NULL DEFAULT 0,
    "noOfArcs" INTEGER NOT NULL DEFAULT 0,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyProductionSummary_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MachineLatestTelemetry_machineId_key" ON "MachineLatestTelemetry"("machineId");
CREATE INDEX "MachineLatestTelemetry_state_idx" ON "MachineLatestTelemetry"("state");
CREATE INDEX "MachineLatestTelemetry_timestamp_idx" ON "MachineLatestTelemetry"("timestamp");

CREATE INDEX "MachineProductionEvent_machineId_startTime_idx" ON "MachineProductionEvent"("machineId", "startTime");
CREATE INDEX "MachineProductionEvent_machineId_state_idx" ON "MachineProductionEvent"("machineId", "state");
CREATE INDEX "MachineProductionEvent_machineId_endTime_idx" ON "MachineProductionEvent"("machineId", "endTime");

CREATE UNIQUE INDEX "DailyProductionSummary_machineId_date_key" ON "DailyProductionSummary"("machineId", "date");
CREATE INDEX "DailyProductionSummary_date_idx" ON "DailyProductionSummary"("date");

ALTER TABLE "MachineLatestTelemetry"
ADD CONSTRAINT "MachineLatestTelemetry_machineId_fkey"
FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MachineProductionEvent"
ADD CONSTRAINT "MachineProductionEvent_machineId_fkey"
FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DailyProductionSummary"
ADD CONSTRAINT "DailyProductionSummary_machineId_fkey"
FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
