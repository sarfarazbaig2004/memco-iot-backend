require("dotenv").config();

const express = require("express");
const cors = require("cors");

// Initialize app
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// ----------------------
// Database Initialization
// ----------------------
try {
  require("./db");
  console.log("✅ Database initialized");
} catch (err) {
  console.error("❌ Database initialization failed:", err.message);
}

// ----------------------
// MQTT (optional)
// ----------------------
if (process.env.ENABLE_MQTT === "true") {
  try {
    require("./mqttClient");
    console.log("📡 MQTT client started");
  } catch (err) {
    console.error("❌ MQTT init failed:", err.message);
  }
} else {
  console.log("⚠️ MQTT disabled");
}

// ----------------------
// Routes
// ----------------------
const apiRoutes = require("./routes/api");
app.use("/api", apiRoutes);

// ----------------------
// Health Check
// ----------------------
app.get("/", (req, res) => {
  res.status(200).json({
    status: "OK",
    message: "MEMCO IoT Backend Running",
    timestamp: new Date(),
  });
});

// ----------------------
// Port config (Render compatible)
// ----------------------
const PORT = process.env.PORT || 5000;

// ----------------------
// Start Server
// ----------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// ----------------------
// Global Error Handling
// ----------------------
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("❌ Unhandled Rejection:", err);
});