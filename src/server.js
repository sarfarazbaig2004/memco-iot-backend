require("dotenv").config();

const express = require("express");
const cors = require("cors");

// Initialize app
const app = express();

// Core services
require("./db");
if (process.env.ENABLE_MQTT === "true") {
  require("./mqttClient");
}

// Routes
const apiRoutes = require("./routes/api");

// Middleware
app.use(cors());
app.use(express.json());

// API Routes
app.use("/api", apiRoutes);

// Health check route
app.get("/", (req, res) => {
  res.status(200).send("MEMCO IoT Backend Running");
});

// Port config
const PORT = process.env.PORT || 5000;

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});