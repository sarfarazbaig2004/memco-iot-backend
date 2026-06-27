const mqtt = require("mqtt");
const prisma = require("./db");
const config = require("./config");

const {
  processMqttTelemetryForWelderArcEvents,
  updateActiveWelderSessionFromTelemetry,
  recoverOpenArcStates,
} = require("./welderSessions");

const { processTelemetryForProduction } = require("./productionTelemetry");

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

function parseNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function parseOptionalBoolean(value) {
  if (value === undefined || value === null || value === "") return null;
  return parseBoolean(value);
}

function parseOptionalString(value) {
  if (value === undefined || value === null) return null;
  const parsedValue = String(value).trim();
  return parsedValue || null;
}

function getFirstValidNumber(...values) {
  for (const value of values) {
    const parsedValue = parseNumber(value);
    if (parsedValue !== null) return parsedValue;
  }
  return null;
}

function deriveTemperature(...temperatures) {
  const validTemperatures = temperatures.filter((value) => value !== null);
  if (!validTemperatures.length) return null;
  return Math.max(...validTemperatures);
}

function buildMapUrl(gpsLat, gpsLng, mapUrl) {
  if (mapUrl) return mapUrl;
  if (gpsLat === null || gpsLng === null) return null;
  return `https://www.google.com/maps?q=${gpsLat},${gpsLng}`;
}

function parseTimestamp(value) {
  if (!value) return new Date();
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? new Date() : timestamp;
}

function parseDateTimePayload(payload) {
  const datePart = parseOptionalString(payload.Date);
  const timePart = parseOptionalString(payload.Time);
  const combinedDateTime = parseOptionalString(payload.time_date);

  if (combinedDateTime) return combinedDateTime;
  if (datePart && timePart) return `${datePart} ${timePart}`;

  return payload.timestamp;
}

function formatHms(hours, minutes, seconds) {
  return `${parseNumber(hours) || 0}:${parseNumber(minutes) || 0}:${parseNumber(seconds) || 0}`;
}

function parseProductionStats(data) {
  if (!Array.isArray(data)) return null;

  return {
    arcTime: formatHms(data[0], data[1], data[2]),
    idleTime: formatHms(data[3], data[4], data[5]),
    dcEnergy: parseNumber(data[6]) || 0,
    deposition: parseNumber(data[7]) || 0,
    wireFeedMeter: parseNumber(data[8]) || 0,
    arcCount: parseNumber(data[9]) || 0,
  };
}

function parseMachineIdentifier(payload, topic) {
  if (topic === "machine/data/M_data") {
    console.log("[mqtt] TEMP mapping M_data → WM-001");
    return "WM-001";
  }

  if (
    payload?.machineCode !== undefined &&
    payload?.machineCode !== null &&
    String(payload.machineCode).trim() !== ""
  ) {
    return String(payload.machineCode).trim();
  }

  if (payload?.machineId !== undefined && payload?.machineId !== null) {
    return String(payload.machineId).trim();
  }

  const topicPrefix = "machine/data/";

  if (typeof topic === "string" && topic.startsWith(topicPrefix)) {
    const identifier = topic.slice(topicPrefix.length).trim();
    if (identifier && !identifier.includes("/")) return identifier;
  }

  return null;
}

function hasTelemetryField(payload, fields) {
  return fields.some((field) => {
    const value = payload[field];
    return value !== undefined && value !== null && value !== "";
  });
}

function hasGpsPayload(payload) {
  return hasTelemetryField(payload, ["gpsLat", "gpsLng", "lat", "lon"]);
}

function hasWeldingPayload(payload) {
  return hasTelemetryField(payload, [
    "inputVoltage",
    "inputVoltageR",
    "inputVoltageY",
    "inputVoltageB",
    "outputVoltage",
    "outputCurrent",
    "temperature",
    "trafoCoreTemperature",
    "transformerCoreTemperature",
    "igbtTemperature",
    "heatSyncTemperature",
    "heatSinkTemperature",
    "fanPulsePerMin",
    "arcOn",
    "machineOn",
    "readings",
    "mPdata",
    "jPdata",
  ]);
}

function summarizeTelemetry(telemetry) {
  if (!telemetry) return null;

  return {
    machineIdentifier: telemetry.machineIdentifier,
    isGpsOnly: telemetry.isGpsOnly,
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
    runningJob: telemetry.runningJob,
    machineLifetime: telemetry.machineLifetime,
    gpsFix: telemetry.gpsFix,
    gpsLat: telemetry.gpsLat,
    gpsLng: telemetry.gpsLng,
    hasMapUrl: Boolean(telemetry.mapUrl),
  };
}

async function ensureMachineExists(machineIdentifier) {
  const normalizedIdentifier = String(machineIdentifier || "").trim();
  if (!normalizedIdentifier) return null;

  const existingMachine = await prisma.machine.findFirst({
    where: { machineCode: normalizedIdentifier },
    select: { id: true, machineCode: true },
  });

  if (existingMachine) return existingMachine;

  const defaultCompany = await prisma.company.findFirst({
    orderBy: { id: "asc" },
    select: { id: true },
  });

  const createdMachine = await prisma.machine.create({
    data: {
      companyId: defaultCompany?.id || 1,
      machineCode: normalizedIdentifier,
      model: "Auto-created",
      machineType: "SINGLE_PHASE",
      location: "Shop Floor",
      status: "ACTIVE",
    },
    select: { id: true, machineCode: true },
  });

  console.log("[mqtt] created missing machine record", {
    machineIdentifier: normalizedIdentifier,
    machineId: createdMachine.id,
    machineCode: createdMachine.machineCode,
  });

  return createdMachine;
}

async function findMachineByIdentifier(machineIdentifier) {
  const normalizedIdentifier = String(machineIdentifier || "").trim();
  const numericMachineId = /^\d+$/.test(normalizedIdentifier)
    ? Number.parseInt(normalizedIdentifier, 10)
    : null;

  console.log("[mqtt] resolving machine identifier", {
    machineIdentifier: normalizedIdentifier,
    numericMachineId,
  });

  if (Number.isInteger(numericMachineId) && numericMachineId > 0) {
    const machineById = await prisma.machine.findUnique({
      where: { id: numericMachineId },
      select: { id: true, machineCode: true },
    });

    if (machineById) {
      console.log("[mqtt] machine lookup matched by id", {
        machineIdentifier: normalizedIdentifier,
        machineId: machineById.id,
        machineCode: machineById.machineCode,
      });
      return machineById;
    }
  }

  const machineByCode = await prisma.machine.findFirst({
    where: { machineCode: normalizedIdentifier },
    select: { id: true, machineCode: true },
  });

  if (machineByCode) {
    console.log("[mqtt] machine lookup matched by code", {
      machineIdentifier: normalizedIdentifier,
      machineId: machineByCode.id,
      machineCode: machineByCode.machineCode,
    });
    return machineByCode;
  }

  if (/^\d+$/.test(normalizedIdentifier)) {
    console.warn("[mqtt] machine lookup by numeric identifier returned no result", {
      machineIdentifier: normalizedIdentifier,
    });
    return null;
  }

  console.warn("[mqtt] machine lookup by code returned no result; creating a new machine entry", {
    machineIdentifier: normalizedIdentifier,
  });
  return ensureMachineExists(normalizedIdentifier);
}

function normalizeTelemetryPayload(payload, topic) {
  console.log("[mqtt] normalizing telemetry payload", {
    topic,
    payloadKeys: getPayloadKeys(payload),
  });

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Payload must be a JSON object");
  }

  const normalizedPayload = { ...payload };

  if (Array.isArray(normalizedPayload.readings)) {
    const readings = normalizedPayload.readings;

    normalizedPayload.machineCode = normalizedPayload.machineCode || "WM-001";

    normalizedPayload.trafoCoreTemperature =
      normalizedPayload.trafoCoreTemperature ?? parseNumber(readings[0]);

    normalizedPayload.igbtTemperature =
      normalizedPayload.igbtTemperature ?? parseNumber(readings[1]);

    normalizedPayload.heatSyncTemperature =
      normalizedPayload.heatSyncTemperature ?? parseNumber(readings[2]);

    normalizedPayload.temperature =

  normalizedPayload.temperature ??

  Math.max(

    normalizedPayload.trafoCoreTemperature || 0,

    normalizedPayload.igbtTemperature || 0,

    normalizedPayload.heatSyncTemperature || 0

  );

    normalizedPayload.outputCurrent =
      normalizedPayload.outputCurrent ?? parseNumber(readings[3]);

    normalizedPayload.outputVoltage =
      normalizedPayload.outputVoltage ?? parseNumber(readings[5]);

    normalizedPayload.currentSetting =
      normalizedPayload.currentSetting ?? parseNumber(readings[8]);

    normalizedPayload.inputVoltageR =
      normalizedPayload.inputVoltageR ?? parseNumber(readings[9]);

    normalizedPayload.inputVoltageY =
      normalizedPayload.inputVoltageY ?? parseNumber(readings[10]);

    normalizedPayload.inputVoltageB =
      normalizedPayload.inputVoltageB ?? parseNumber(readings[11]);

    normalizedPayload.fanPulsePerMin =
      normalizedPayload.fanPulsePerMin ?? parseNumber(readings[12]);

    normalizedPayload.inputVoltage =
      normalizedPayload.inputVoltage ??
      Math.max(
        normalizedPayload.inputVoltageR || 0,
        normalizedPayload.inputVoltageY || 0,
        normalizedPayload.inputVoltageB || 0
      );

    normalizedPayload.machineOn = true;
    

    normalizedPayload.arcOn =
      normalizedPayload.arcOn ?? (normalizedPayload.outputCurrent || 0) > 15;
  }

  normalizedPayload.runningJob =
    normalizedPayload.runningJob ?? parseProductionStats(normalizedPayload.jPdata);

  normalizedPayload.machineLifetime =
    normalizedPayload.machineLifetime ?? parseProductionStats(normalizedPayload.mPdata);

  normalizedPayload.gpsLat =
    normalizedPayload.gpsLat ?? parseNumber(normalizedPayload.lat);

  normalizedPayload.gpsLng =
    normalizedPayload.gpsLng ?? parseNumber(normalizedPayload.lon);

  const machineIdentifier = parseMachineIdentifier(normalizedPayload, topic);

  if (!machineIdentifier) {
    throw new Error("machineId, machineCode, or machine topic suffix is required");
  }

  const inputVoltage = parseNumber(normalizedPayload.inputVoltage);
const outputVoltage = parseNumber(normalizedPayload.outputVoltage);
const outputCurrent = parseNumber(normalizedPayload.outputCurrent);

const weldingCurrent =
  outputCurrent !== null && outputCurrent >= 10
    ? outputCurrent
    : 0;

const weldingVoltage =
  outputCurrent !== null && outputCurrent >= 10
    ? outputVoltage
    : 0;

  const trafoCoreTemperature = getFirstValidNumber(
    normalizedPayload.trafoCoreTemperature,
    normalizedPayload.transformerCoreTemperature
  );

  const igbtTemperature = parseNumber(normalizedPayload.igbtTemperature);

  const heatSyncTemperature = getFirstValidNumber(
    normalizedPayload.heatSyncTemperature,
    normalizedPayload.heatSinkTemperature
  );

  const temperature = getFirstValidNumber(
    normalizedPayload.temperature,
    deriveTemperature(
      trafoCoreTemperature,
      igbtTemperature,
      heatSyncTemperature
    )
  );

  const rawGpsFix = parseOptionalBoolean(normalizedPayload.gpsFix);
  const gpsLat = parseNumber(normalizedPayload.gpsLat);
  const gpsLng = parseNumber(normalizedPayload.gpsLng);
  const gpsFix = rawGpsFix ?? (gpsLat !== null && gpsLng !== null ? true : null);

  const mapUrl = buildMapUrl(
    gpsLat,
    gpsLng,
    parseOptionalString(normalizedPayload.mapUrl)
  );

  const arcOn =
    normalizedPayload.arcOn === undefined || normalizedPayload.arcOn === null
      ? outputCurrent !== null
        ? outputCurrent > 15
        : false
      : parseBoolean(normalizedPayload.arcOn);

  const machineOn = true;

  const containsWeldingData = hasWeldingPayload(normalizedPayload);
  const containsGpsData = hasGpsPayload(normalizedPayload);
  const isGpsOnly = containsGpsData && !containsWeldingData;

  if (containsWeldingData && arcOn === null) {
    throw new Error('arcOn must be a boolean or "true"/"false" string');
  }

  if (
    normalizedPayload.machineOn !== undefined &&
    normalizedPayload.machineOn !== null &&
    normalizedPayload.machineOn !== "" &&
    machineOn === null
  ) {
    throw new Error('machineOn must be a boolean or "true"/"false" string');
  }

  if (
    normalizedPayload.gpsFix !== undefined &&
    normalizedPayload.gpsFix !== null &&
    normalizedPayload.gpsFix !== "" &&
    rawGpsFix === null
  ) {
    throw new Error('gpsFix must be a boolean or "true"/"false" string');
  }

  if (
    (normalizedPayload.gpsLat !== undefined &&
      normalizedPayload.gpsLat !== null &&
      gpsLat === null) ||
    (normalizedPayload.gpsLng !== undefined &&
      normalizedPayload.gpsLng !== null &&
      gpsLng === null)
  ) {
    throw new Error("gpsLat and gpsLng must be valid numbers when provided");
  }

  return {
    machineIdentifier,
    timestamp: parseTimestamp(parseDateTimePayload(normalizedPayload)),
    inputVoltage,
    outputVoltage,
    outputCurrent,
    weldingCurrent,
    weldingVoltage,
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
    runningJob: normalizedPayload.runningJob,
    machineLifetime: normalizedPayload.machineLifetime,
    isGpsOnly,
  };
}

async function persistTelemetry(telemetry) {
  const startedAt = Date.now();

  console.log("[mqtt] telemetry persistence started", summarizeTelemetry(telemetry));

  const machine = await findMachineByIdentifier(telemetry.machineIdentifier);

  if (!machine) {
    throw new Error(`Machine not found for identifier ${telemetry.machineIdentifier}`);
  }

  console.log(`[mqtt] machine resolved ${telemetry.machineIdentifier} -> id ${machine.id}`);

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
    outputCurrent: savedTelemetry.outputCurrent,
    outputVoltage: savedTelemetry.outputVoltage,
    inputVoltage: savedTelemetry.inputVoltage,
    arcOn: savedTelemetry.arcOn,
    machineOn: savedTelemetry.machineOn,
    runningJob: telemetry.runningJob,
    machineLifetime: telemetry.machineLifetime,
    elapsedMs: Date.now() - startedAt,
  });

  await updateActiveWelderSessionFromTelemetry(savedTelemetry);
  await processMqttTelemetryForWelderArcEvents(savedTelemetry);

  const productionResult = await processTelemetryForProduction(savedTelemetry);

  console.log("[mqtt] production update completed", {
    telemetryId: savedTelemetry.id,
    machineId: savedTelemetry.machineId,
    productionState: productionResult?.state,
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

    if (telemetry.isGpsOnly) {
      console.log("[mqtt] GPS-only payload normalized; skipping save", {
        topic,
        telemetry: summarizeTelemetry(telemetry),
      });
      return;
    }

    const result = await persistTelemetry(telemetry);

    console.log(
      `[mqtt] telemetry saved for ${result.machine.machineCode} id ${result.machine.id} from topic ${topic}`
    );
  } catch (error) {
    mqttState.lastError = error.message || String(error);

    if (String(error.message || "").startsWith("Machine not found")) {
      console.error("[mqtt] machine lookup failed", {
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
      machineOn: true,
      arcOn: isWelding,
    };
  });

  await prisma.telemetry.createMany({
    data: rows,
  });

  console.log(`Inserted ${rows.length} demo telemetry records`);
}

function startDemoTelemetry() {
  if (!config.enableDemoTelemetry || demoTelemetryInterval) return;

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
    console.log("[mqtt] ingestion disabled. Set ENABLE_MQTT=true to enable.");
    return;
  }

  if (client) {
    console.log("[mqtt] client already initialized");
    return;
  }

  client = mqtt.connect(config.mqttBrokerUrl, {
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

    console.log(`[mqtt] connected to ${config.mqttBrokerUrl} as ${config.mqttClientId}`);

    client.subscribe(config.mqttTopic, { qos: config.mqttSubscribeQos }, (error) => {
      if (error) {
        mqttState.lastError = error.message || String(error);
        console.error(`[mqtt] subscribe error for ${config.mqttTopic}:`, error);
        return;
      }

      mqttState.subscribedTopic = config.mqttTopic;

      console.log(
        `[mqtt] subscribed to topic ${config.mqttTopic} with qos ${config.mqttSubscribeQos}`
      );
    });
  });

  client.on("message", (topic, message) => {
    void handleIncomingMessage(topic, message);
  });

  client.on("reconnect", () => {
    mqttState.connected = false;
    console.warn(`[mqtt] reconnecting in ${config.mqttReconnectPeriodMs} ms...`);
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

async function startTelemetryService() {
  if (isStarted) return;

  isStarted = true;

  try {
    await recoverOpenArcStates();
  } catch (error) {
    console.error("[mqtt] failed to recover open arc state:", error);
  }

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