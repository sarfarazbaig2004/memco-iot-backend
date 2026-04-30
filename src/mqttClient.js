const mqtt = require("mqtt");
const prisma = require("./db");
const config = require("./config");
const {
  updateActiveWelderSessionFromTelemetry,
} = require("./welderSessions");
const {
  processTelemetryForProduction,
} = require("./productionTelemetry");

let client = null;
let demoTelemetryInterval = null;
let isStarted = false;
const mqttState = {
  enabled: config.enableMqtt,
  connected: false,
  subscribedTopic: null,
  lastError: null,
};

function getErrorDetails(error) {
  return {
    name: error?.name,
    code: error?.code,
    message: error?.message || String(error),
    meta: error?.meta,
    stack: error?.stack,
  };
}

function getPayloadKeys(payload) {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? Object.keys(payload)
    : [];
}

function truncateForLog(value, maxLength = 500) {
  const text = String(value);

  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function summarizeTelemetry(telemetry) {
  if (!telemetry) {
    return null;
  }

  return {
    machineIdentifier: telemetry.machineIdentifier,
    timestamp: telemetry.timestamp?.toISOString?.() || telemetry.timestamp,
    inputVoltage: telemetry.inputVoltage,
    outputVoltage: telemetry.outputVoltage,
    outputCurrent: telemetry.outputCurrent,
    temperature: telemetry.temperature,
    trafoCoreTemperature: telemetry.trafoCoreTemperature,
    igbtTemperature: telemetry.igbtTemperature,
    heatSyncTemperature: telemetry.heatSyncTemperature,
    machineOn: telemetry.machineOn,
    arcOn: telemetry.arcOn,
    gpsFix: telemetry.gpsFix,
    gpsLat: telemetry.gpsLat,
    gpsLng: telemetry.gpsLng,
    hasMapUrl: Boolean(telemetry.mapUrl),
  };
}

function parseNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsedValue = Number(value);

  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function parseMachineIdentifierFromTopic(topic) {
  if (typeof topic !== "string") {
    return null;
  }

  const topicPrefix = "machine/data/";

  if (!topic.startsWith(topicPrefix)) {
    return null;
  }

  const machineIdentifier = topic.slice(topicPrefix.length).trim();

  return machineIdentifier && !machineIdentifier.includes("/")
    ? machineIdentifier
    : null;
}

function parseMachineIdentifier(payload, topic) {
  const hasMachineCode =
    hasOwnValue(payload, "machineCode") &&
    payload.machineCode !== undefined &&
    payload.machineCode !== null &&
    String(payload.machineCode).trim() !== "";
  const rawIdentifier = hasMachineCode
    ? payload.machineCode
    : payload.machineId;

  if (rawIdentifier !== undefined && rawIdentifier !== null) {
    const machineIdentifier = String(rawIdentifier).trim();

    if (machineIdentifier) {
      return machineIdentifier;
    }
  }

  return parseMachineIdentifierFromTopic(topic);
}

async function findMachineByIdentifier(machineIdentifier) {
  const numericMachineId = /^\d+$/.test(machineIdentifier)
    ? Number.parseInt(machineIdentifier, 10)
    : null;

  console.log("[mqtt] resolving machine identifier", {
    machineIdentifier,
    numericMachineId,
  });

  if (Number.isInteger(numericMachineId) && numericMachineId > 0) {
    const machineById = await prisma.machine.findUnique({
      where: { id: numericMachineId },
      select: { id: true, machineCode: true },
    });

    if (machineById) {
      console.log("[mqtt] machine lookup matched by id", {
        machineIdentifier,
        machineId: machineById.id,
        machineCode: machineById.machineCode,
      });
      return machineById;
    }

    console.warn("[mqtt] machine lookup by id returned no result", {
      machineIdentifier,
      numericMachineId,
    });
  }

  const machineByCode = await prisma.machine.findFirst({
    where: { machineCode: machineIdentifier },
    select: { id: true, machineCode: true },
  });

  if (machineByCode) {
    console.log("[mqtt] machine lookup matched by code", {
      machineIdentifier,
      machineId: machineByCode.id,
      machineCode: machineByCode.machineCode,
    });
  } else {
    console.warn("[mqtt] machine lookup by code returned no result", {
      machineIdentifier,
    });
  }

  return machineByCode;
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

function parseOptionalBoolean(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  return parseBoolean(value);
}

function parseOptionalString(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const parsedValue = String(value).trim();

  return parsedValue || null;
}

function buildMapUrl(gpsLat, gpsLng, mapUrl) {
  if (mapUrl) {
    return mapUrl;
  }

  if (gpsLat === null || gpsLng === null) {
    return null;
  }

  return `https://www.google.com/maps?q=${gpsLat},${gpsLng}`;
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

function getFirstValidNumber(...values) {
  for (const value of values) {
    const parsedValue = parseNumber(value);

    if (parsedValue !== null) {
      return parsedValue;
    }
  }

  return null;
}

function deriveTemperature(...temperatures) {
  const validTemperatures = temperatures.filter((value) => value !== null);

  if (!validTemperatures.length) {
    return null;
  }

  return Math.max(...validTemperatures);
}

function normalizeTelemetryPayload(payload, topic) {
  console.log("[mqtt] normalizing telemetry payload", {
    topic,
    payloadKeys: getPayloadKeys(payload),
  });

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Payload must be a JSON object");
  }

  const requiredFields = [
    "inputVoltage",
    "outputVoltage",
    "outputCurrent",
    "arcOn",
  ];

  for (const field of requiredFields) {
    if (!hasOwnValue(payload, field)) {
      throw new Error(`Missing required telemetry field: ${field}`);
    }
  }

  const machineIdentifier = parseMachineIdentifier(payload, topic);

  if (!machineIdentifier) {
    throw new Error(
      "machineId, machineCode, or machine topic suffix is required"
    );
  }

  const inputVoltage = parseNumber(payload.inputVoltage);
  const outputVoltage = parseNumber(payload.outputVoltage);
  const outputCurrent = parseNumber(payload.outputCurrent);
  const trafoCoreTemperature = getFirstValidNumber(
    payload.trafoCoreTemperature,
    payload.transformerCoreTemperature
  );
  const igbtTemperature = parseNumber(payload.igbtTemperature);
  const heatSyncTemperature = getFirstValidNumber(
    payload.heatSyncTemperature,
    payload.heatSinkTemperature
  );
  const rawGpsFix = parseOptionalBoolean(payload.gpsFix);
  const gpsLat = parseNumber(payload.gpsLat);
  const gpsLng = parseNumber(payload.gpsLng);
  const mapUrl = buildMapUrl(gpsLat, gpsLng, parseOptionalString(payload.mapUrl));
  const gpsFix = rawGpsFix ?? (gpsLat !== null && gpsLng !== null ? true : null);
  const temperature = getFirstValidNumber(
    payload.temperature,
    deriveTemperature(
      trafoCoreTemperature,
      igbtTemperature,
      heatSyncTemperature
    )
  );
  const arcOn = parseBoolean(payload.arcOn);
  const machineOn = parseOptionalBoolean(payload.machineOn);

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

  if (
    payload.machineOn !== undefined &&
    payload.machineOn !== null &&
    payload.machineOn !== "" &&
    machineOn === null
  ) {
    throw new Error('machineOn must be a boolean or "true"/"false" string');
  }

  if (
    payload.gpsFix !== undefined &&
    payload.gpsFix !== null &&
    payload.gpsFix !== "" &&
    rawGpsFix === null
  ) {
    throw new Error('gpsFix must be a boolean or "true"/"false" string');
  }

  if (
    (payload.gpsLat !== undefined && payload.gpsLat !== null && gpsLat === null) ||
    (payload.gpsLng !== undefined && payload.gpsLng !== null && gpsLng === null)
  ) {
    throw new Error("gpsLat and gpsLng must be valid numbers when provided");
  }

  const telemetry = {
    machineIdentifier,
    inputVoltage,
    outputVoltage,
    outputCurrent,
    temperature,
    trafoCoreTemperature,
    igbtTemperature,
    heatSyncTemperature,
    machineOn,
    arcOn,
    gpsFix,
    gpsLat,
    gpsLng,
    mapUrl,
    timestamp: parseTimestamp(payload.timestamp),
  };

  console.log("[mqtt] normalized telemetry payload", summarizeTelemetry(telemetry));

  return telemetry;
}

async function persistTelemetry(telemetry) {
  const startedAt = Date.now();
  console.log("[mqtt] telemetry persistence started", summarizeTelemetry(telemetry));

  const machine = await findMachineByIdentifier(telemetry.machineIdentifier);

  if (!machine) {
    throw new Error(
      `Machine not found for identifier ${telemetry.machineIdentifier}`
    );
  }

  console.log(
    `[mqtt] machine resolved ${telemetry.machineIdentifier} -> id ${machine.id}`
  );

  console.log("[mqtt] creating telemetry row", {
    machineId: machine.id,
    machineCode: machine.machineCode,
    telemetry: summarizeTelemetry(telemetry),
  });

  const savedTelemetry = await prisma.telemetry.create({
    data: {
      machineId: machine.id,
      timestamp: telemetry.timestamp,
      inputVoltage: telemetry.inputVoltage,
      outputVoltage: telemetry.outputVoltage,
      outputCurrent: telemetry.outputCurrent,
      temperature: telemetry.temperature,
      trafoCoreTemperature: telemetry.trafoCoreTemperature,
      igbtTemperature: telemetry.igbtTemperature,
      heatSyncTemperature: telemetry.heatSyncTemperature,
      machineOn: telemetry.machineOn,
      arcOn: telemetry.arcOn,
      gpsFix: telemetry.gpsFix,
      gpsLat: telemetry.gpsLat,
      gpsLng: telemetry.gpsLng,
      mapUrl: telemetry.mapUrl,
    },
  });

  console.log("[mqtt] telemetry row created", {
    telemetryId: savedTelemetry.id,
    machineId: savedTelemetry.machineId,
    createdAt: savedTelemetry.createdAt,
    elapsedMs: Date.now() - startedAt,
  });

  console.log("[mqtt] updating active welder session from telemetry", {
    telemetryId: savedTelemetry.id,
    machineId: savedTelemetry.machineId,
  });

  await updateActiveWelderSessionFromTelemetry(savedTelemetry);
  const productionResult = await processTelemetryForProduction(savedTelemetry);

  console.log("[mqtt] active welder session update completed", {
    telemetryId: savedTelemetry.id,
    machineId: savedTelemetry.machineId,
    productionState: productionResult.state,
    elapsedMs: Date.now() - startedAt,
  });

  return {
    machine,
    telemetry: savedTelemetry,
  };
}

async function handleIncomingMessage(topic, message) {
  let payload;
  const rawMessage = message.toString();

  try {
    payload = JSON.parse(rawMessage);
    console.log("[mqtt] MQTT received", {
      topic,
      byteLength: message.length,
      payloadKeys: getPayloadKeys(payload),
      machineIdentifier: parseMachineIdentifier(payload, topic),
    });
  } catch (error) {
    console.warn("[mqtt] ignoring non-JSON payload", {
      topic,
      byteLength: message.length,
      rawPreview: truncateForLog(rawMessage),
      error: getErrorDetails(error),
    });
    return;
  }

  try {
    const telemetry = normalizeTelemetryPayload(payload, topic);

    const result = await persistTelemetry(telemetry);
    console.log(
      `[mqtt] telemetry saved for ${result.machine.machineCode} (id ${result.machine.id}) from topic ${topic}`
    );
  } catch (error) {
    mqttState.lastError = error.message || String(error);

    if (String(error.message || "").startsWith("Machine not found")) {
      console.error("[mqtt] machine lookup failed while processing telemetry", {
        topic,
        payloadKeys: getPayloadKeys(payload),
        machineIdentifier: parseMachineIdentifier(payload, topic),
        error: getErrorDetails(error),
      });
      return;
    }

    console.error("[mqtt] failed to process telemetry message", {
      topic,
      payloadKeys: getPayloadKeys(payload),
      machineIdentifier: parseMachineIdentifier(payload, topic),
      error: getErrorDetails(error),
    });
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
      trafoCoreTemperature: 50 + Math.random() * 40,
      igbtTemperature: 45 + Math.random() * 35,
      heatSyncTemperature: 40 + Math.random() * 30,
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
