require("dotenv").config();

const os = require("os");

function getRequiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is missing in the environment`);
  }

  return value;
}

function parseIntegerEnv(name, defaultValue, options = {}) {
  const rawValue = process.env[name];

  if (rawValue === undefined || rawValue === "") {
    return defaultValue;
  }

  const value = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }

  if (options.min !== undefined && value < options.min) {
    throw new Error(`${name} must be greater than or equal to ${options.min}`);
  }

  if (options.max !== undefined && value > options.max) {
    throw new Error(`${name} must be less than or equal to ${options.max}`);
  }

  return value;
}

function parseBooleanEnv(name, defaultValue = false) {
  const rawValue = process.env[name];

  if (rawValue === undefined || rawValue === "") {
    return defaultValue;
  }

  if (rawValue === "true") {
    return true;
  }

  if (rawValue === "false") {
    return false;
  }

  throw new Error(`${name} must be either "true" or "false"`);
}

function parseOrigins(value) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

module.exports = Object.freeze({
  nodeEnv: process.env.NODE_ENV || "development",
  host: process.env.HOST || "0.0.0.0",
  port: parseIntegerEnv("PORT", 5000, { min: 1, max: 65535 }),
  databaseUrl: getRequiredEnv("DATABASE_URL"),
  corsOrigins: parseOrigins(process.env.CORS_ORIGIN),
  enableMqtt: parseBooleanEnv("ENABLE_MQTT", false),
  mqttUrl: process.env.MQTT_URL || "mqtt://localhost:1883",
  mqttClientId:
    process.env.MQTT_CLIENT_ID || `memco-backend-${os.hostname()}-${process.pid}`,
  mqttTopic: process.env.MQTT_TOPIC || "machine/data",
  mqttConnectTimeoutMs: parseIntegerEnv("MQTT_CONNECT_TIMEOUT_MS", 10000, {
    min: 1000,
  }),
  enableDemoTelemetry: parseBooleanEnv("ENABLE_DEMO_TELEMETRY", false),
  demoTelemetryIntervalMs: parseIntegerEnv("DEMO_TELEMETRY_INTERVAL_MS", 120000, {
    min: 1000,
  }),
  gracefulShutdownTimeoutMs: parseIntegerEnv(
    "GRACEFUL_SHUTDOWN_TIMEOUT_MS",
    10000,
    { min: 1000 }
  ),
});
