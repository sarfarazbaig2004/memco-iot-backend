# Virtual MEMCO Welding Machine Simulator

The Virtual MEMCO Welding Machine Simulator is a local digital twin for MEMCO welding machines. It publishes firmware-shaped JSON packets to the same MQTT topics used by real ESP32/STM32 controllers:

```text
machine/data/<machineCode>
```

The simulator does not write directly to Prisma or the database. Every packet follows the normal production path:

```text
Virtual Simulator -> MQTT -> mqttClient.js -> normalizeTelemetryPayload()
-> persistTelemetry() -> Prisma -> REST APIs -> Flutter Dashboard
```

## Packet Contract

Simulator payloads intentionally use the firmware packet shape, not a simulator-specific format:

```json
{
  "hbt": 1,
  "lat": 19.401178,
  "lon": 72.823517,
  "sat": 9,
  "Date": "2026-07-14",
  "Time": "10:11:12",
  "time_date": "2026-07-14 10:11:12",
  "readings": [48, 54, 51, 202, 0, 26, 0, 0, 217, 406, 408, 404, 2025],
  "mPdata": [8, 0, 5, 3, 0, 0, 51.209, 4.609, 1296.23, 126],
  "jPdata": [0, 0, 5, 0, 0, 0, 0.029, 0.001, 0.23, 1]
}
```

Machine identity comes from the MQTT topic suffix, exactly like hardware:

```text
machine/data/WM-001
machine/data/WM-002
machine/data/WM-003
```

## Enable Locally

Set these environment variables:

```env
ENABLE_MQTT=true
ENABLE_VIRTUAL_MEMCO_SIMULATOR=true
MQTT_BROKER_URL="mqtt://localhost:1883"
MQTT_TOPIC="machine/data/#"
VIRTUAL_MEMCO_MACHINE_CODES="WM-001,WM-002,WM-003"
VIRTUAL_MEMCO_INTERVAL_MS=5000
VIRTUAL_MEMCO_SCENARIO="mixed"
VIRTUAL_MEMCO_FAULT_SCENARIO="none"
```

Then start the backend normally:

```sh
npm start
```

## Environment Variables

`ENABLE_VIRTUAL_MEMCO_SIMULATOR`
: Enables or disables the simulator. Keep this `false` in production.

`VIRTUAL_MEMCO_MACHINE_CODES`
: Comma-separated machine codes. Each code publishes independently to `machine/data/<machineCode>`.

`VIRTUAL_MEMCO_INTERVAL_MS`
: Publish interval in milliseconds. Minimum is `1000`.

`VIRTUAL_MEMCO_PUBLISH_QOS`
: MQTT publish QoS. Defaults to `1`.

`VIRTUAL_MEMCO_CLIENT_ID`
: MQTT client ID used by the simulator.

`VIRTUAL_MEMCO_SCENARIO`
: Machine state behavior. Supported values are `mixed`, `off`, `idle`, and `welding`.

`VIRTUAL_MEMCO_FAULT_SCENARIO`
: Fault behavior. Supported values are `none`, `low_voltage`, `high_temperature`, `heartbeat_loss`, `restart`, and `demo_faults`.

## Supported Scenarios

`mixed`
: Cycles through `OFF`, `IDLE`, `WELDING`, and `COOLING`.

`off`
: Emits zero electrical readings so the backend derives machine state as OFF.

`idle`
: Emits powered-on input voltage, cooling fan activity, and zero welding output.

`welding`
: Emits active output current/voltage and accumulating production data.

## Fault Scenarios

`low_voltage`
: Lowers phase input voltages so warning/alarm behavior can be tested.

`high_temperature`
: Gradually raises transformer, IGBT, and heat sink temperatures.

`heartbeat_loss`
: Holds `hbt` constant to simulate missed firmware heartbeat updates.

`restart`
: Emits a machine restart/off packet with zero electrical output.

`demo_faults`
: Rotates through low voltage, high temperature, heartbeat loss, and restart windows.

MQTT reconnect behavior is handled by the existing MQTT client reconnect logic. Restart or stop the broker while the simulator is running to verify reconnect behavior.

## Add More Virtual Machines

Add machine codes to `VIRTUAL_MEMCO_MACHINE_CODES`:

```env
VIRTUAL_MEMCO_MACHINE_CODES="WM-001,WM-002,WM-003,WM-004"
```

Each virtual machine keeps its own heartbeat, temperatures, arc time, idle time, energy, deposition, and arc count.

## Disable For Production

Set:

```env
ENABLE_VIRTUAL_MEMCO_SIMULATOR=false
```

Replacing the simulator with a real ESP32/STM32 requires no changes to MQTT topics, backend code, database schema, REST APIs, or the Flutter frontend. Stop the simulator and connect hardware that publishes the same firmware packet to the same `machine/data/<machineCode>` topic.

## Verification Checklist

Check `/health`:

```sh
curl http://localhost:5000/health
```

The response includes MQTT state plus simulator status, machine count, scenario, and fault scenario.

Check dashboard/API behavior through the existing endpoints:

```sh
curl http://localhost:5000/api/machines/overview
curl http://localhost:5000/api/machine/WM-001/overview
```

The same telemetry feeds fleet overview, latest telemetry, production, reports, and Flutter dashboard views through the existing backend contracts.
