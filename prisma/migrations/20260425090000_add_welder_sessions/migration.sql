CREATE TABLE "Welder" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "rfidCardNo" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Welder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WelderSession" (
    "id" SERIAL NOT NULL,
    "welderId" INTEGER NOT NULL,
    "machineId" INTEGER NOT NULL,
    "rfidCardNo" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "arcingTimeSeconds" INTEGER NOT NULL DEFAULT 0,
    "idleTimeSeconds" INTEGER NOT NULL DEFAULT 0,
    "lastTelemetryAt" TIMESTAMP(3),
    "energy" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "deposition" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "arcCount" INTEGER NOT NULL DEFAULT 0,
    "lastArcOn" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "WelderSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Welder_employeeCode_key" ON "Welder"("employeeCode");
CREATE UNIQUE INDEX "Welder_rfidCardNo_key" ON "Welder"("rfidCardNo");
CREATE INDEX "WelderSession_machineId_status_idx" ON "WelderSession"("machineId", "status");
CREATE INDEX "WelderSession_welderId_status_idx" ON "WelderSession"("welderId", "status");
CREATE INDEX "WelderSession_rfidCardNo_idx" ON "WelderSession"("rfidCardNo");

ALTER TABLE "WelderSession" ADD CONSTRAINT "WelderSession_welderId_fkey" FOREIGN KEY ("welderId") REFERENCES "Welder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WelderSession" ADD CONSTRAINT "WelderSession_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
