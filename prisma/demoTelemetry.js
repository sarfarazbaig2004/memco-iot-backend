require("dotenv").config();
const prisma = require("../src/db");

async function main() {
  const machines = await prisma.machine.findMany({
    select: { id: true },
    orderBy: { id: "asc" },
  });

  if (!machines.length) {
    console.log("No machines found");
    return;
  }

  for (const machine of machines) {
    const isWelding = Math.random() > 0.45;

    await prisma.telemetry.create({
      data: {
        machineId: machine.id,
        timestamp: new Date(),
        inputVoltage: Math.round(400 + Math.random() * 20),
        outputVoltage: isWelding ? Math.round(24 + Math.random() * 8) : 0,
        outputCurrent: isWelding ? Math.round(180 + Math.random() * 180) : 0,
        temperature: Math.round(50 + Math.random() * 40),
        arcOn: isWelding,
      },
    });
  }

  console.log("✅ Demo telemetry inserted for all machines");
}

prisma
  .connectDB()
  .then(main)
  .catch((err) => {
    console.error("❌ Demo telemetry error:", err);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
