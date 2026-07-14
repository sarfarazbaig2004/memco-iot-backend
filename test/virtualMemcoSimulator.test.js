const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { _test: mqttTest } = require("../src/mqttClient");
const { _test, getSimulatorStatus } = require("../src/virtualMemcoSimulator");

test("virtual MEMCO simulator publishes payloads compatible with MQTT normalization", () => {
  const state = _test.createMachineState("WM-001");
  const payload = _test.buildVirtualMemcoPayload(state, {
    intervalMs: 5000,
    scenario: "welding",
    now: new Date(2026, 6, 14, 10, 11, 12),
    random: () => 0.5,
  });

  const telemetry = mqttTest.normalizeTelemetryPayload(
    payload,
    "machine/data/WM-001"
  );

  assert.deepEqual(Object.keys(payload), [
    "hbt",
    "lat",
    "lon",
    "sat",
    "Date",
    "Time",
    "time_date",
    "readings",
    "mPdata",
    "jPdata",
  ]);
  assert.equal(payload.Date, "2026-07-14");
  assert.equal(payload.Time, "10:11:12");
  assert.equal(payload.time_date, "2026-07-14 10:11:12");
  assert.equal(payload.readings.length, 13);
  assert.equal(payload.jPdata.length, 10);
  assert.equal(payload.mPdata.length, 10);

  assert.equal(telemetry.machineIdentifier, "WM-001");
  assert.equal(telemetry.machineOn, true);
  assert.equal(telemetry.arcOn, true);
  assert.equal(telemetry.inputVoltage, Math.max(payload.readings[9], payload.readings[10], payload.readings[11]));
  assert.equal(telemetry.inputVoltageR, payload.readings[9]);
  assert.equal(telemetry.inputVoltageY, payload.readings[10]);
  assert.equal(telemetry.inputVoltageB, payload.readings[11]);
  assert.equal(telemetry.outputVoltage, payload.readings[5]);
  assert.equal(telemetry.outputCurrent, payload.readings[3]);
  assert.equal(telemetry.currentSetting, payload.readings[8]);
  assert.equal(telemetry.fanPulsePerMin, payload.readings[12]);
  assert.equal(telemetry.gpsLat, payload.lat);
  assert.equal(telemetry.gpsLng, payload.lon);
  assert.deepEqual(telemetry.runningJob, {
    arcTime: "0:0:5",
    idleTime: "0:0:0",
    dcEnergy: payload.jPdata[6],
    deposition: payload.jPdata[7],
    wireFeedMeter: payload.jPdata[8],
    arcCount: payload.jPdata[9],
  });
});

test("virtual MEMCO mixed scenario cycles through off, idle, welding, and cooling", () => {
  assert.equal(_test.getModeForTick(0, "mixed"), "OFF");
  assert.equal(_test.getModeForTick(2, "mixed"), "IDLE");
  assert.equal(_test.getModeForTick(7, "mixed"), "WELDING");
  assert.equal(_test.getModeForTick(14, "mixed"), "COOLING");
});

test("virtual MEMCO off payload keeps the machine off through MQTT normalization", () => {
  const state = _test.createMachineState("WM-001");
  const payload = _test.buildVirtualMemcoPayload(state, {
    intervalMs: 5000,
    scenario: "off",
    random: () => 0.5,
  });

  const telemetry = mqttTest.normalizeTelemetryPayload(
    payload,
    "machine/data/WM-001"
  );

  assert.equal(telemetry.machineOn, false);
  assert.equal(telemetry.arcOn, false);
});

test("virtual MEMCO telemetry changes gradually during welding", () => {
  const state = _test.createMachineState("WM-001");
  const first = _test.buildVirtualMemcoPayload(state, {
    intervalMs: 5000,
    scenario: "welding",
    random: () => 0.5,
  });
  const second = _test.buildVirtualMemcoPayload(state, {
    intervalMs: 5000,
    scenario: "welding",
    random: () => 0.5,
  });

  assert.ok(Math.abs(second.readings[3] - first.readings[3]) <= 25);
  assert.ok(Math.abs(second.readings[5] - first.readings[5]) <= 5);
  assert.ok(Math.abs(second.readings[9] - first.readings[9]) <= 8);
  assert.ok(Math.abs(second.readings[0] - first.readings[0]) <= 4);
  assert.ok(Math.abs(second.readings[1] - first.readings[1]) <= 4);
  assert.ok(Math.abs(second.readings[12] - first.readings[12]) <= 250);
});

test("virtual MEMCO production statistics accumulate over repeated arc packets", () => {
  const state = _test.createMachineState("WM-001");
  const first = _test.buildVirtualMemcoPayload(state, {
    intervalMs: 5000,
    scenario: "welding",
    random: () => 0.5,
  });
  const second = _test.buildVirtualMemcoPayload(state, {
    intervalMs: 5000,
    scenario: "welding",
    random: () => 0.5,
  });

  assert.equal(first.jPdata[2], 5);
  assert.equal(second.jPdata[2], 10);
  assert.ok(second.jPdata[6] > first.jPdata[6]);
  assert.ok(second.jPdata[7] > first.jPdata[7]);
  assert.ok(second.jPdata[8] > first.jPdata[8]);
});

test("virtual MEMCO fault scenarios use firmware-shaped packets", () => {
  const lowVoltage = _test.buildVirtualMemcoPayload(_test.createMachineState("WM-001"), {
    scenario: "idle",
    faultScenario: "low_voltage",
    random: () => 0.5,
  });
  const highTemperature = _test.buildVirtualMemcoPayload(_test.createMachineState("WM-001"), {
    scenario: "welding",
    faultScenario: "high_temperature",
    random: () => 0.5,
  });
  const heartbeatLossState = _test.createMachineState("WM-001");
  const beforeHeartbeat = heartbeatLossState.heartbeat;
  const heartbeatLoss = _test.buildVirtualMemcoPayload(heartbeatLossState, {
    scenario: "idle",
    faultScenario: "heartbeat_loss",
    random: () => 0.5,
  });
  const restart = _test.buildVirtualMemcoPayload(_test.createMachineState("WM-001"), {
    scenario: "welding",
    faultScenario: "restart",
    random: () => 0.5,
  });

  assert.ok(Math.max(lowVoltage.readings[9], lowVoltage.readings[10], lowVoltage.readings[11]) < 340);
  assert.ok(highTemperature.readings[1] > 55);
  assert.equal(heartbeatLoss.hbt, beforeHeartbeat);
  assert.equal(restart.readings[3], 0);
  assert.equal(restart.readings[5], 0);
});

test("virtual MEMCO simulator does not bypass MQTT ingestion with Prisma writes", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/virtualMemcoSimulator.js"),
    "utf8"
  );

  assert.equal(source.includes('require("./db")'), false);
  assert.equal(source.includes("prisma."), false);
});

test("virtual MEMCO simulator status exposes health endpoint fields", () => {
  const status = getSimulatorStatus();

  assert.equal(typeof status.enabled, "boolean");
  assert.equal(typeof status.running, "boolean");
  assert.equal(status.machineCount, status.machines.length);
  assert.equal(typeof status.scenario, "string");
  assert.equal(typeof status.faultScenario, "string");
  assert.ok(Array.isArray(status.machines));
});
