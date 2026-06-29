-- Speed up MQTT machine-code resolution and open production-event lookup.
CREATE INDEX "Machine_machineCode_idx" ON "Machine"("machineCode");

DROP INDEX IF EXISTS "MachineProductionEvent_machineId_endTime_idx";
CREATE INDEX "MachineProductionEvent_machineId_endTime_startTime_idx"
ON "MachineProductionEvent"("machineId", "endTime", "startTime");
