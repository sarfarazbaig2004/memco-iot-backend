const express = require("express");
const cors = require("cors");

const config = require("./config");
const prisma = require("./db");
const {
  startTelemetryService,
  stopTelemetryService,
} = require("./mqttClient");

const app = express();
let server = null;
let isShuttingDown = false;

app.disable("x-powered-by");
app.use(
  cors(
    config.corsOrigins.length > 0
      ? {
          origin: config.corsOrigins,
        }
      : undefined
  )
);
app.use(express.json({ limit: "1mb" }));

const apiRoutes = require("./routes/api");
app.use("/api", apiRoutes);

app.get(["/", "/health"], (req, res) => {
  res.status(200).json({
    status: "OK",
    message: "MEMCO IoT Backend Running",
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.get("/ready", async (req, res) => {
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
    res.status(200).json({
      status: "READY",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Readiness check failed:", error);
    res.status(503).json({
      status: "NOT_READY",
      timestamp: new Date().toISOString(),
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: "Route not found",
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  console.error("Unhandled request error:", error);
  res.status(500).json({
    error: "Internal server error",
  });
});

async function startServer() {
  await prisma.connectDB();
  startTelemetryService();

  await new Promise((resolve) => {
    server = app.listen(config.port, config.host, resolve);
  });

  console.log(
    `HTTP server listening on http://${config.host}:${config.port} (${config.nodeEnv})`
  );
}

async function shutdown(signal, error) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  const exitCode = error ? 1 : 0;

  console.log(`Shutting down application (${signal})`);

  const forceExitTimer = setTimeout(() => {
    console.error("Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, config.gracefulShutdownTimeoutMs);

  forceExitTimer.unref?.();

  try {
    await stopTelemetryService();

    if (server) {
      await new Promise((resolve, reject) => {
        server.close((closeError) => {
          if (closeError) {
            reject(closeError);
            return;
          }

          resolve();
        });
      });
    }

    await prisma.$disconnect();
    clearTimeout(forceExitTimer);
    process.exit(exitCode);
  } catch (shutdownError) {
    clearTimeout(forceExitTimer);
    console.error("Shutdown failed:", shutdownError);
    process.exit(1);
  }
}

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  void shutdown("uncaughtException", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  void shutdown(
    "unhandledRejection",
    reason instanceof Error ? reason : new Error(String(reason))
  );
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

startServer().catch((error) => {
  console.error("Application startup failed:", error);
  process.exit(1);
});
