require("dotenv").config();

const prisma = require("../src/db");

async function main() {
  for (let i = 1; i <= 50; i++) {
    const code = `WM-${i.toString().padStart(3, "0")}`;

    const existing = await prisma.machine.findFirst({
      where: { machineCode: code },
    });

    if (!existing) {
      await prisma.machine.create({
        data: {
          machineCode: code,
          model: "400A Inverter",
          machineType: "SMAW",
          companyId: 1,
          location: `Bay ${i}`,
          status: "IDLE",
        },
      });
    }
  }

  console.log("✅ 50 machines created or already present");
}

main()
  .catch((err) => {
    console.error("❌ Seed error:", err);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });