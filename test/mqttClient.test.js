const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("../src/mqttClient");

test("machine topic suffix remains authoritative for each machine", () => {
  for (const machineCode of ["WM-001", "WM-002", "WM-003"]) {
    const telemetry = _test.normalizeTelemetryPayload(
      { readings: [30, 31, 32, 100, 0, 24] },
      `machine/data/${machineCode}`
    );

    assert.equal(telemetry.machineIdentifier, machineCode);
  }
});

test("topic machine identifier overrides a conflicting payload identifier", () => {
  assert.equal(
    _test.parseMachineIdentifier(
      { machineCode: "WM-001" },
      "machine/data/WM-003"
    ),
    "WM-003"
  );
});

test("legacy M_data topic retains its explicit temporary mapping", () => {
  assert.equal(
    _test.parseMachineIdentifier({}, "machine/data/M_data"),
    "WM-001"
  );
});

test("normalizes the device heartbeat value", () => {
  const telemetry = _test.normalizeTelemetryPayload(
    { hbt: 7, readings: [30, 31, 32, 100, 0, 24] },
    "machine/data/WM-001"
  );

  assert.equal(telemetry.heartbeat, 7);
});

test("accepts heartbeat boundary values", () => {
  assert.equal(_test.parseHeartbeat(0), 0);
  assert.equal(_test.parseHeartbeat(10), 10);
});

test("rejects an invalid heartbeat value", () => {
  assert.throws(
    () => _test.parseHeartbeat(11),
    /hbt must be an integer from 0 to 10/
  );
});
