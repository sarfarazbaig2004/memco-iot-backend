const mqtt = require("mqtt");
const prisma = require("./db");
const config = require("./config");

let client = null;
let demoTelemetryInterval = null;
let isStarted = false;
const mqttState = {
  enabled: config.enableMqtt,
  connected: false,
  subscribedTopic: null,
  lastError: null,
};

function parseNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsedValue = Number(value);

  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function parseBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return null;
}

function parseTimestamp(value) {
  if (!value) {
    return new Date();
  }

  const timestamp = new Date(value);

  return Number.isNaN(timestamp.getTime()) ? new Date() : timestamp;
}

function hasOwnValue(payload, key) {
  return Object.prototype.hasOwnProperty.call(payload, key);
}

function normalizeTelemetryPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Payload must be a JSON object");
  }

  // Reject incomplete telemetry packets so downstream analytics stay consistent.
  const requiredFields = [
    "machineId",
    "inputVoltage",
    "outputVoltage",
    "outputCurrent",
    "temperature",
    "arcOn",
  ];

  for (const field of requiredFields) {
    if (!hasOwnValue(payload, field)) {
      throw new Error(`Missing required telemetry field: ${field}`);
    }
  }

  const machineId = Number.parseInt(payload.machineId, 10);

  if (!Number.isInteger(machineId) || machineId <= 0) {
    throw new Error("machineId must be a positive integer");
  }

  const inputVoltage = parseNumber(payload.inputVoltage);
  const outputVoltage = parseNumber(payload.outputVoltage);
  const outputCurrent = parseNumber(payload.outputCurrent);
  const temperature = parseNumber(payload.temperature);
  const arcOn = parseBoolean(payload.arcOn);

  if (inputVoltage === null) {
    throw new Error("inputVoltage must be a valid number");
  }

  if (outputVoltage === null) {
    throw new Error("outputVoltage must be a valid number");
  }

  if (outputCurrent === null) {
    throw new Error("outputCurrent must be a valid number");
  }

  if (temperature === null) {
    throw new Error("temperature must be a valid number");
  }

  if (arcOn === null) {
    throw new Error('arcOn must be a boolean or "true"/"false" string');
  }

  return {
    machineId,
    inputVoltage,
    outputVoltage,
    outputCurrent,
    temperature,
    arcOn,
    timestamp: parseTimestamp(payload.timestamp),
  };
}

async function persistTelemetry(telemetry) {
  try {
    await prisma.telemetry.create({
      data: telemetry,
    });
  } catch (error) {
    if (error.code === "P2003") {
      console.warn(
        `Skipping telemetry for unknown machine ${telemetry.machineId}`
      );
      return;
    }

    throw error;
  }
}

async function handleIncomingMessage(topic, message) {
  let payload;

  try {
    payload = JSON.parse(message.toString());
  } catch (_error) {
    console.warn(`Ignoring non-JSON payload received on topic ${topic}`);
    return;
  }

  try {
    const telemetry = normalizeTelemetryPayload(payload);

    await persistTelemetry(telemetry);
    console.log(
      `[mqtt] saved telemetry for machine ${telemetry.machineId} from topic ${topic}`
    );
  } catch (error) {
    mqttState.lastError = error.message || String(error);
    console.error(`[mqtt] failed to process message on ${topic}:`, error);
  }
}

async function generateFleetTelemetry() {
  const machines = await prisma.machine.findMany({
    select: { id: true },
    orderBy: { id: "asc" },
  });

  if (!machines.length) {
    console.warn("Skipping demo telemetry generation because no machines exist");
    return;
  }

  const timestamp = new Date();
  const rows = machines.map((machine) => {
    const isWelding = Math.random() > 0.5;

    return {
      machineId: machine.id,
      timestamp,
      inputVoltage: 400 + Math.random() * 20,
      outputVoltage: isWelding ? 24 + Math.random() * 8 : 0,
      outputCurrent: isWelding ? 180 + Math.random() * 170 : 0,
      temperature: 50 + Math.random() * 40,
      arcOn: isWelding,
    };
  });

  await prisma.telemetry.createMany({
    data: rows,
  });

  console.log(`Inserted ${rows.length} demo telemetry records`);
}

function startDemoTelemetry() {
  if (!config.enableDemoTelemetry || demoTelemetryInterval) {
    return;
  }

  console.warn(
    `Demo telemetry generation is enabled every ${config.demoTelemetryIntervalMs} ms`
  );

  void generateFleetTelemetry().catch((error) => {
    console.error("Initial demo telemetry generation failed:", error);
  });

  demoTelemetryInterval = setInterval(() => {
    void generateFleetTelemetry().catch((error) => {
      console.error("Scheduled demo telemetry generation failed:", error);
    });
  }, config.demoTelemetryIntervalMs);

  demoTelemetryInterval.unref?.();
}

function startMqttSubscription() {
  if (!config.enableMqtt) {
    console.log(
      "[mqtt] ingestion disabled by configuration (set ENABLE_MQTT=true to enable it)"
    );
    return;
  }

  if (client) {
    console.log("[mqtt] client already initialized");
    return;
  }

  client = mqtt.connect(config.mqttBrokerUrl, {
    // A stable client ID lets Mosquitto track this backend across reconnects.
    clientId: config.mqttClientId,
    connectTimeout: config.mqttConnectTimeoutMs,
    reconnectPeriod: config.mqttReconnectPeriodMs,
    keepalive: config.mqttKeepaliveSeconds,
    username: config.mqttUsername || undefined,
    password: config.mqttPassword || undefined,
    clean: true,
    resubscribe: true,
  });

  client.on("connect", () => {
    mqttState.connected = true;
    mqttState.lastError = null;
    console.log(
      `[mqtt] connected to ${config.mqttBrokerUrl} as ${config.mqttClientId}`
    );

    client.subscribe(
      config.mqttTopic,
      { qos: config.mqttSubscribeQos },
      (error) => {
        if (error) {
          mqttState.lastError = error.message || String(error);
          console.error(`[mqtt] subscribe error for ${config.mqttTopic}:`, error);
          return;
        }

        mqttState.subscribedTopic = config.mqttTopic;
        console.log(
          `[mqtt] subscribed to topic ${config.mqttTopic} with qos ${config.mqttSubscribeQos}`
        );
      }
    );
  });

  client.on("message", (topic, message) => {
    void handleIncomingMessage(topic, message);
  });

  client.on("reconnect", () => {
    mqttState.connected = false;
    console.warn(
      `[mqtt] reconnecting in ${config.mqttReconnectPeriodMs} ms...`
    );
  });

  client.on("offline", () => {
    mqttState.connected = false;
    console.warn("[mqtt] client is offline");
  });

  client.on("close", () => {
    mqttState.connected = false;
    console.warn("[mqtt] connection closed");
  });

  client.on("error", (error) => {
    mqttState.lastError = error.message || String(error);
    console.error("[mqtt] client error:", error);
  });

  client.on("end", () => {
    mqttState.connected = false;
    console.log("[mqtt] client ended");
  });
}

function startTelemetryService() {
  if (isStarted) {
    return;
  }

  isStarted = true;
  // MQTT startup is isolated so broker issues never prevent the API from serving traffic.
  try {
    startMqttSubscription();
  } catch (error) {
    mqttState.lastError = error.message || String(error);
    console.error("[mqtt] startup failed, continuing without MQTT:", error);
  }

  startDemoTelemetry();
}

async function stopTelemetryService() {
  if (demoTelemetryInterval) {
    clearInterval(demoTelemetryInterval);
    demoTelemetryInterval = null;
  }

  if (client) {
    const activeClient = client;
    client = null;

    await new Promise((resolve) => {
      activeClient.end(true, {}, resolve);
    });

    mqttState.connected = false;
    mqttState.subscribedTopic = null;
    console.log("[mqtt] client stopped");
  }

  isStarted = false;
}

module.exports = {
  getTelemetryServiceStatus: () => ({
    ...mqttState,
    topic: config.mqttTopic,
    clientId: config.mqttClientId,
    url: config.mqttBrokerUrl,
  }),
  startTelemetryService,
  stopTelemetryService,
};
