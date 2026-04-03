const mqtt = require("mqtt");
const prisma = require("./db");

const client = mqtt.connect("mqtt://localhost:1883", {
  clientId: "memco-backend-01",
});

client.on("connect", () => {
  console.log("✅ MQTT Connected");

  client.subscribe("machine/data", (err) => {
    if (!err) {
      console.log("📡 Subscribed to machine/data");
    } else {
      console.error("❌ MQTT Subscribe Error:", err);
    }
  });

  // Generate one batch immediately on startup
  generateFleetTelemetry();

  // Then repeat every 2 minutes
  setInterval(generateFleetTelemetry, 120000);
});

client.on("message", async (topic, message) => {
  try {
    const data = JSON.parse(message.toString());

    console.log("📥 Received:", data);

    await prisma.telemetry.create({
      data: {
        machineId: data.machineId,
        inputVoltage: data.inputVoltage ?? 0,
        outputVoltage: data.outputVoltage ?? 0,
        outputCurrent: data.outputCurrent ?? 0,
        temperature: data.temperature ?? 0,
        arcOn: data.arcOn ?? false,
        timestamp: data.timestamp ? new Date(data.timestamp) : new Date(),
      },
    });

    console.log("✅ Saved to telemetry table");
  } catch (err) {
    console.error("❌ MQTT Error:", err);
  }
});

async function generateFleetTelemetry() {
  console.log("⏱ Generating telemetry for all machines...");

  for (let i = 1; i <= 50; i++) {
    const isWelding = Math.random() > 0.5;

    const payload = {
      machineId: i,
      inputVoltage: 400 + Math.random() * 20,
      outputVoltage: isWelding ? 28 : 0,
      outputCurrent: isWelding ? 200 + Math.random() * 150 : 0,
      temperature: 50 + Math.random() * 40,
      arcOn: isWelding,
      timestamp: new Date(),
    };

    try {
      await prisma.telemetry.create({
        data: payload,
      });
    } catch (err) {
      console.log(`❌ Error inserting telemetry for machine ${i}:`, err.message);
    }
  }

  console.log("✅ Telemetry updated for all machines");
}

module.exports = client;