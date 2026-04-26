require("dotenv").config();

const prisma = require("../src/db");
const { hashPassword } = require("../src/auth");

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

  await prisma.welder.upsert({
    where: { rfidCardNo: "RFID-000127" },
    create: {
      name: "Mohd. Arif",
      employeeCode: "WLD-019",
      rfidCardNo: "RFID-000127",
      active: true,
    },
    update: {
      name: "Mohd. Arif",
      employeeCode: "WLD-019",
      active: true,
    },
  });

  console.log("✅ Demo welder RFID-000127 created or already present");

  await prisma.user.upsert({
    where: { email: "superadmin@memco.com" },
    create: {
      name: "MEMCO Super Admin",
      email: "superadmin@memco.com",
      passwordHash: hashPassword("Admin@123"),
      role: "SUPER_ADMIN",
      active: true,
    },
    update: {
      name: "MEMCO Super Admin",
      role: "SUPER_ADMIN",
      active: true,
    },
  });

  const demoCustomer = await prisma.user.upsert({
    where: { email: "customer@demo.com" },
    create: {
      name: "Demo Customer",
      email: "customer@demo.com",
      passwordHash: hashPassword("Customer@123"),
      role: "CUSTOMER",
      active: true,
    },
    update: {
      name: "Demo Customer",
      role: "CUSTOMER",
      active: true,
    },
  });

  await prisma.user.upsert({
    where: { email: "genzprotech@gmail.com" },
    create: {
      name: "Genz Protech",
      email: "genzprotech@gmail.com",
      passwordHash: hashPassword("Mohamed@7867"),
      role: "SUPER_ADMIN",
      active: true,
    },
    update: {
      name: "Genz Protech",
      role: "SUPER_ADMIN",
      active: true,
    },
  });

  console.log("✅ Demo auth users created or already present");

  await prisma.userModuleAccess.deleteMany({
    where: { userId: demoCustomer.id },
  });
  await prisma.userModuleAccess.createMany({
    data: [
      {
        userId: demoCustomer.id,
        moduleKey: "reports",
        enabled: true,
      },
    ],
  });

  const demoMachines = await prisma.machine.findMany({
    where: { machineCode: { in: ["WM-001", "WM-002"] } },
    select: { id: true },
  });

  await prisma.userMachineAccess.deleteMany({
    where: { userId: demoCustomer.id },
  });

  if (demoMachines.length > 0) {
    await prisma.userMachineAccess.createMany({
      data: demoMachines.map((machine) => ({
        userId: demoCustomer.id,
        machineId: machine.id,
      })),
    });
  }

  console.log("✅ Demo customer access created or already present");
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
