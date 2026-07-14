const config = require("./config");

let mqtt = null;
let simulatorClient = null;
let simulatorInterval = null;
let simulatorStates = [];
let isStarted = false;

const simulatorStatus = {
  enabled: config.enableVirtualMemcoSimulator,
  connected: false,
  publishing: false,
  machines: config.virtualMemcoMachineCodes,
  machineCount: config.virtualMemcoMachineCodes.length,
  scenario: config.virtualMemcoScenario,
  faultScenario: config.virtualMemcoFaultScenario,
  lastPublishedAt: null,
  lastError: null,
};

function getMqtt() {
  if (!mqtt) {
    mqtt = require("mqtt");
  }
  return mqtt;
}

function round(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function createMachineState(machineCode, index = 0) {
  return {
    machineCode,
    tick: index * 3,
    heartbeat: index % 11,
    jobArcSeconds: 0,
    jobIdleSeconds: 0,
    jobArcCount: 0,
    lifetimeArcSeconds: 8 * 60 * 60 + index * 360,
    lifetimeIdleSeconds: 3 * 60 * 60 + index * 180,
    lifetimeArcCount: 125 + index * 12,
    temperature: 43 + index * 2,
    lastMode: "OFF",
    restartUntilTick: null,
  };
}

function getModeForTick(tick, scenario = "mixed") {
  const normalizedScenario = String(scenario || "mixed").toLowerCase();

  if (normalizedScenario === "idle") return "IDLE";
  if (normalizedScenario === "welding") return "WELDING";
  if (normalizedScenario === "off") return "OFF";

  const phase = tick % 18;
  if (phase < 2) return "OFF";
  if (phase < 7) return "IDLE";
  if (phase < 14) return "WELDING";
  return "COOLING";
}

function formatHms(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return `${hours}:${minutes}:${remainingSeconds}`;
}

function formatFirmwareDateTime(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const datePart = `${year}-${month}-${day}`;
  const timePart = `${hours}:${minutes}:${seconds}`;

  return {
    Date: datePart,
    Time: timePart,
    time_date: `${datePart} ${timePart}`,
  };
}

function buildProductionArray(arcSeconds, idleSeconds, energy, deposition, wireFeedMeter, arcCount) {
  const arcHours = Math.floor(arcSeconds / 3600);
  const arcMinutes = Math.floor((arcSeconds % 3600) / 60);
  const arcRemainingSeconds = Math.floor(arcSeconds % 60);
  const idleHours = Math.floor(idleSeconds / 3600);
  const idleMinutes = Math.floor((idleSeconds % 3600) / 60);
  const idleRemainingSeconds = Math.floor(idleSeconds % 60);

  return [
    arcHours,
    arcMinutes,
    arcRemainingSeconds,
    idleHours,
    idleMinutes,
    idleRemainingSeconds,
    round(energy, 3),
    round(deposition, 3),
    round(wireFeedMeter, 2),
    arcCount,
  ];
}

function getFaultForTick(tick, faultScenario = "none") {
  const normalizedFault = String(faultScenario || "none").toLowerCase();

  if (normalizedFault === "low_voltage") return "LOW_INPUT_VOLTAGE";
  if (normalizedFault === "high_temperature") return "HIGH_TEMPERATURE";
  if (normalizedFault === "heartbeat_loss") return "HEARTBEAT_LOSS";
  if (normalizedFault === "restart") return "RESTART";

  if (normalizedFault !== "demo_faults") return null;

  const phase = tick % 48;
  if (phase >= 8 && phase < 14) return "LOW_INPUT_VOLTAGE";
  if (phase >= 22 && phase < 29) return "HIGH_TEMPERATURE";
  if (phase >= 34 && phase < 38) return "HEARTBEAT_LOSS";
  if (phase >= 42 && phase < 45) return "RESTART";
  return null;
}

function buildVirtualMemcoPayload(state, options = {}) {
  const intervalSeconds = (options.intervalMs || config.virtualMemcoIntervalMs) / 1000;
  const scenario = options.scenario || config.virtualMemcoScenario;
  const faultScenario = options.faultScenario || config.virtualMemcoFaultScenario;
  const random = options.random || Math.random;
  const tick = state.tick;
  const fault = getFaultForTick(tick, faultScenario);
  const mode = fault === "RESTART" ? "OFF" : getModeForTick(tick, scenario);
  const isOff = mode === "OFF";
  const isWelding = mode === "WELDING";
  const machineOn = !isOff;
  const inputBase =
    isOff || fault === "RESTART"
      ? 0
      : fault === "LOW_INPUT_VOLTAGE"
        ? 305 + Math.sin(tick / 3) * 3
        : 406 + Math.sin(tick / 3) * 5;
  const inputVoltageR = machineOn ? round(inputBase + (random() - 0.5) * 4) : 0;
  const inputVoltageY = machineOn ? round(inputBase + 2 + (random() - 0.5) * 4) : 0;
  const inputVoltageB = machineOn ? round(inputBase - 2 + (random() - 0.5) * 4) : 0;
  const outputCurrent = isWelding ? round(155 + random() * 95) : 0;
  const outputVoltage = isWelding ? round(22 + random() * 8) : 0;
  const currentSetting = isWelding ? round(clamp(outputCurrent + 15, 120, 280), 0) : 160;
  const fanPulsePerMin = machineOn ? round(isWelding ? 1850 + random() * 350 : 950 + random() * 200, 0) : 0;

  if (isWelding) {
    state.jobArcSeconds += intervalSeconds;
    state.lifetimeArcSeconds += intervalSeconds;
    state.temperature = clamp(state.temperature + 0.8 + random() * 1.2, 38, 82);
    state.jobArcCount += state.tick % 6 === 0 ? 1 : 0;
    state.lifetimeArcCount += state.tick % 6 === 0 ? 1 : 0;
  } else if (machineOn) {
    state.jobIdleSeconds += intervalSeconds;
    state.lifetimeIdleSeconds += intervalSeconds;
    state.temperature = clamp(state.temperature - 0.4 + random() * 0.3, 36, 82);
  } else {
    state.temperature = clamp(state.temperature - 0.8, 30, 82);
  }

  if (fault === "HIGH_TEMPERATURE") {
    state.temperature = clamp(state.temperature + 2.8 + random(), 30, 96);
  }

  if (fault !== "HEARTBEAT_LOSS") {
    state.heartbeat = (state.heartbeat + 1) % 11;
  }

  state.tick += 1;
  state.lastMode = mode;

  const trafoCoreTemperature = machineOn ? round(state.temperature + 3 + random() * 2) : null;
  const igbtTemperature = machineOn ? round(state.temperature + (isWelding ? 7 : 2) + random() * 2) : null;
  const heatSyncTemperature = machineOn ? round(state.temperature + (isWelding ? 4 : 1) + random() * 2) : null;
  const energy = (state.jobArcSeconds / 3600) * outputVoltage * outputCurrent / 1000;
  const deposition = state.jobArcSeconds * 0.00016;
  const wireFeedMeter = state.jobArcSeconds * 0.045;
  const gpsLat = round(19.401178 + Math.sin(state.tick / 20) * 0.0005, 6);
  const gpsLng = round(72.823517 + Math.cos(state.tick / 20) * 0.0005, 6);
  const dateTime = formatFirmwareDateTime(options.now || new Date());

  return {
    hbt: state.heartbeat,
    lat: gpsLat,
    lon: gpsLng,
    sat: machineOn ? 9 : 0,
    Date: dateTime.Date,
    Time: dateTime.Time,
    time_date: dateTime.time_date,
    readings: [
      trafoCoreTemperature,
      igbtTemperature,
      heatSyncTemperature,
      outputCurrent,
      0,
      outputVoltage,
      0,
      0,
      currentSetting,
      inputVoltageR,
      inputVoltageY,
      inputVoltageB,
      fanPulsePerMin,
    ],
    mPdata: buildProductionArray(
      state.lifetimeArcSeconds,
      state.lifetimeIdleSeconds,
      (state.lifetimeArcSeconds / 3600) * 6.4,
      state.lifetimeArcSeconds * 0.00016,
      state.lifetimeArcSeconds * 0.045,
      state.lifetimeArcCount
    ),
    jPdata: buildProductionArray(
      state.jobArcSeconds,
      state.jobIdleSeconds,
      energy,
      deposition,
      wireFeedMeter,
      state.jobArcCount
    ),
  };
}

function getSimulatorStatus() {
  return {
    ...simulatorStatus,
    running: isStarted,
    machines: [...simulatorStatus.machines],
  };
}

function publishSimulatorTick() {
  if (!simulatorClient || !simulatorStatus.connected) return;

  for (const state of simulatorStates) {
    const topic = `machine/data/${state.machineCode}`;
    const payload = buildVirtualMemcoPayload(state);

    simulatorClient.publish(
      topic,
      JSON.stringify(payload),
      { qos: config.virtualMemcoPublishQos },
      (error) => {
        if (error) {
          simulatorStatus.lastError = error.message || String(error);
          console.error("[virtual-memco] publish failed", {
            topic,
            error: simulatorStatus.lastError,
          });
          return;
        }

        simulatorStatus.lastPublishedAt = new Date().toISOString();
        console.log("[virtual-memco] published telemetry", {
          topic,
          mode: state.lastMode,
          outputCurrent: payload.readings[3],
          outputVoltage: payload.readings[5],
          temperature: payload.readings[0],
        });
      }
    );
  }
}

function startVirtualMemcoSimulator() {
  if (!config.enableVirtualMemcoSimulator) return;
  if (isStarted || simulatorClient) return;

  isStarted = true;
  simulatorStates = config.virtualMemcoMachineCodes.map(createMachineState);
  simulatorStatus.machines = config.virtualMemcoMachineCodes;
  simulatorStatus.machineCount = config.virtualMemcoMachineCodes.length;
  simulatorStatus.scenario = config.virtualMemcoScenario;
  simulatorStatus.faultScenario = config.virtualMemcoFaultScenario;
  simulatorStatus.publishing = false;
  simulatorStatus.lastError = null;

  if (!config.enableMqtt) {
    console.warn(
      "[virtual-memco] ENABLE_MQTT is false; simulator will publish, but this backend will not ingest the messages"
    );
  }

  simulatorClient = getMqtt().connect(config.mqttBrokerUrl, {
    clientId: config.virtualMemcoClientId,
    connectTimeout: config.mqttConnectTimeoutMs,
    reconnectPeriod: config.mqttReconnectPeriodMs,
    keepalive: config.mqttKeepaliveSeconds,
    username: config.mqttUsername || undefined,
    password: config.mqttPassword || undefined,
    clean: true,
  });

  simulatorClient.on("connect", () => {
    simulatorStatus.connected = true;
    simulatorStatus.publishing = true;
    simulatorStatus.lastError = null;

    console.log("[virtual-memco] connected", {
      broker: config.mqttBrokerUrl,
      clientId: config.virtualMemcoClientId,
      machines: config.virtualMemcoMachineCodes,
      intervalMs: config.virtualMemcoIntervalMs,
      scenario: config.virtualMemcoScenario,
      faultScenario: config.virtualMemcoFaultScenario,
    });

    publishSimulatorTick();
    if (!simulatorInterval) {
      simulatorInterval = setInterval(publishSimulatorTick, config.virtualMemcoIntervalMs);
      simulatorInterval.unref?.();
    }
  });

  simulatorClient.on("reconnect", () => {
    simulatorStatus.connected = false;
    simulatorStatus.publishing = false;
    console.warn("[virtual-memco] reconnecting to MQTT broker");
  });

  simulatorClient.on("offline", () => {
    simulatorStatus.connected = false;
    simulatorStatus.publishing = false;
    console.warn("[virtual-memco] MQTT client is offline");
  });

  simulatorClient.on("close", () => {
    simulatorStatus.connected = false;
    simulatorStatus.publishing = false;
  });

  simulatorClient.on("error", (error) => {
    simulatorStatus.lastError = error.message || String(error);
    console.error("[virtual-memco] MQTT client error:", error);
  });
}

async function stopVirtualMemcoSimulator() {
  if (simulatorInterval) {
    clearInterval(simulatorInterval);
    simulatorInterval = null;
  }

  if (simulatorClient) {
    const activeClient = simulatorClient;
    simulatorClient = null;

    await new Promise((resolve) => {
      activeClient.end(true, {}, resolve);
    });
  }

  simulatorStatus.connected = false;
  simulatorStatus.publishing = false;
  isStarted = false;
}

module.exports = {
  getSimulatorStatus,
  startVirtualMemcoSimulator,
  stopVirtualMemcoSimulator,
  _test: {
    buildVirtualMemcoPayload,
    createMachineState,
    getModeForTick,
    getFaultForTick,
  },
};
