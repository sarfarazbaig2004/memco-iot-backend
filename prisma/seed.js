require("dotenv").config();

const prisma = require("../src/db");

async function main() {
  const companyCode = "WM-001";

  let company = await prisma.company.findUnique({
    where: { code: companyCode },
  });

  if (!company) {
    company = await prisma.company.create({
      data: {
        name: "MEMCO",
        code: companyCode,
        email: "demo@memco.com",
        mobile: "9999999999",
      },
    });

    console.log(`✅ Company created with id ${company.id}`);
  } else {
    console.log(`✅ Company already exists with id ${company.id}`);
  }

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
          companyId: company.id,
          location: `Bay ${i}`,
          status: "IDLE",
        },
      });
    }
  }

  console.log("✅ 50 machines created or already present");
}

prisma
  .connectDB()
  .then(main)
  .catch((err) => {
    console.error("❌ Seed error:", err);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
