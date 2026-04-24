require("dotenv").config();

const prisma = require("../src/db");

async function main() {
  console.log("🚀 Updating serial numbers...");

  const machines = await prisma.machine.findMany({
    orderBy: { id: "asc" },
  });

  for (let i = 0; i < machines.length; i++) {
    const serial = `MEMCO-ARC-2026-${(i + 1)
      .toString()
      .padStart(4, "0")}`;

    try {
      await prisma.machine.update({
        where: { id: machines[i].id },
        data: {
          // ⚠️ Only works if column exists
          serialNumber: serial,
        },
      });

      console.log(`✅ Machine ${machines[i].machineCode} → ${serial}`);
    } catch (err) {
      console.log(
        `⚠️ Skipped Machine ${machines[i].id} (serialNumber not present yet)`
      );
    }
  }

  console.log("🎯 Serial update process completed");
}

prisma
  .connectDB()
  .then(main)
  .catch((err) => {
    console.error("❌ Update error:", err);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
