const mqtt = require("mqtt");
const prisma = require("./db");
const config = require("./config");

let client = null;
let demoTelemetryInterval = null;
let isStarted = false;

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

function normalizeTelemetryPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Payload must be a JSON object");
  }

  const machineId = Number.parseInt(payload.machineId, 10);

  if (!Number.isInteger(machineId) || machineId <= 0) {
    throw new Error("machineId must be a positive integer");
  }

  return {
    machineId,
    inputVoltage: parseNumber(payload.inputVoltage),
    outputVoltage: parseNumber(payload.outputVoltage),
    outputCurrent: parseNumber(payload.outputCurrent),
    temperature: parseNumber(payload.temperature),
    arcOn: parseBoolean(payload.arcOn),
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
    console.log(`Saved telemetry for machine ${telemetry.machineId}`);
  } catch (error) {
    console.error(`Failed to process telemetry message on ${topic}:`, error);
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
    console.log("MQTT ingestion disabled by configuration");
    return;
  }

  if (client) {
    return;
  }

  client = mqtt.connect(config.mqttUrl, {
    clientId: config.mqttClientId,
    connectTimeout: config.mqttConnectTimeoutMs,
    reconnectPeriod: 5000,
    clean: true,
  });

  client.on("connect", () => {
    console.log(`MQTT connected to ${config.mqttUrl}`);

    client.subscribe(config.mqttTopic, (error) => {
      if (error) {
        console.error("MQTT subscribe error:", error);
        return;
      }

      console.log(`Subscribed to MQTT topic ${config.mqttTopic}`);
    });
  });

  client.on("message", (topic, message) => {
    void handleIncomingMessage(topic, message);
  });

  client.on("reconnect", () => {
    console.warn("MQTT reconnecting...");
  });

  client.on("offline", () => {
    console.warn("MQTT client is offline");
  });

  client.on("close", () => {
    console.warn("MQTT connection closed");
  });

  client.on("error", (error) => {
    console.error("MQTT client error:", error);
  });
}

function startTelemetryService() {
  if (isStarted) {
    return;
  }

  isStarted = true;
  startMqttSubscription();
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

    console.log("MQTT client stopped");
  }

  isStarted = false;
}

module.exports = {
  startTelemetryService,
  stopTelemetryService,
};
