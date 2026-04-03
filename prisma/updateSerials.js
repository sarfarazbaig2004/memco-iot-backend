require("dotenv").config();

const prisma = require("../src/db");

async function main() {
  const machines = await prisma.machine.findMany({
    orderBy: { id: "asc" },
  });

  for (let i = 0; i < machines.length; i++) {
    const serial = `MEMCO-ARC-2026-${(i + 1).toString().padStart(4, "0")}`;

    await prisma.machine.update({
      where: { id: machines[i].id },
      data: { serialNumber: serial },
    });
  }

  console.log("✅ Serial numbers updated");
}

main()
  .catch((err) => {
    console.error("❌ Update error:", err);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });