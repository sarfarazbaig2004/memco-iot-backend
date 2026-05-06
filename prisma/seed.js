require("dotenv").config();

const prisma = require("../src/db");
const { hashPassword } = require("../src/auth");

async function main() {
  const company = await prisma.company.upsert({
    where: { code: "MEMCO" },
    update: {
      name: "Miraj Electrical & Mechanical Company Private Limited",
    },
    create: {
      name: "Miraj Electrical & Mechanical Company Private Limited",
      code: "MEMCO",
    },
  });

  await prisma.user.upsert({
    where: { email: "genzprotech@gmail.com" },
    update: {
      name: "Super Admin",
      passwordHash: "test",
      role: "SOFTWARE_SUPER_ADMIN",
      active: true,
    },
    create: {
      name: "Super Admin",
      email: "genzprotech@gmail.com",
      passwordHash: "test",
      role: "SOFTWARE_SUPER_ADMIN",
      active: true,
    },
  });

  const companyAdmin = await prisma.user.upsert({
    where: { email: "memcosarfaraz@memcoin.com" },
    update: {
      name: "Sarfaraz",
      passwordHash: hashPassword("Admin@1234"),
      role: "COMPANY_SUPER_ADMIN",
      active: true,
    },
    create: {
      name: "Sarfaraz",
      email: "memcosarfaraz@memcoin.com",
      passwordHash: hashPassword("Admin@1234"),
      role: "COMPANY_SUPER_ADMIN",
      active: true,
    },
  });

  await prisma.userModuleAccess.deleteMany({
    where: { userId: companyAdmin.id },
  });

  await prisma.userMachineAccess.deleteMany({
    where: { userId: companyAdmin.id },
  });

  const demoCustomerUser = await prisma.user.upsert({
    where: { email: "demo@memcoin.com" },
    update: {
      name: "Demo Customer",
      passwordHash: hashPassword("Demo@1234"),
      role: "CUSTOMER",
      active: true,
    },
    create: {
      name: "Demo Customer",
      email: "demo@memcoin.com",
      passwordHash: hashPassword("Demo@1234"),
      role: "CUSTOMER",
      active: true,
    },
  });

  const demoCustomer = await prisma.customer.upsert({
    where: { email: "demo@memcoin.com" },
    update: {
      name: "Demo Customer",
      companyId: company.id,
      userId: demoCustomerUser.id,
      active: true,
      updatedAt: new Date(),
    },
    create: {
      name: "Demo Customer",
      email: "demo@memcoin.com",
      companyId: company.id,
      userId: demoCustomerUser.id,
      active: true,
      updatedAt: new Date(),
    },
  });

  await prisma.userModuleAccess.deleteMany({
    where: { userId: demoCustomerUser.id },
  });

  await prisma.userMachineAccess.deleteMany({
    where: { userId: demoCustomerUser.id },
  });

  await prisma.customerModuleAccess.deleteMany({
    where: { customerId: demoCustomer.id },
  });

  await prisma.customerMachineAccess.deleteMany({
    where: { customerId: demoCustomer.id },
  });

  await prisma.customerFeatureAccess.deleteMany({
    where: { customerId: demoCustomer.id },
  });

  await prisma.customerParameterAccess.deleteMany({
    where: { customerId: demoCustomer.id },
  });

  const machine = await prisma.machine.findFirst({
    where: { machineCode: "WM-001" },
  });

  if (!machine) {
    console.log("⚠️ WM-001 not found, skipping machine assignment");
    return;
  }

  await prisma.machine.update({
    where: { id: machine.id },
    data: {
      machineType: "SINGLE_PHASE",
      inputVoltageMode: "SINGLE",
      showInputVoltageSingle: true,
      showPhaseVoltageR: false,
      showPhaseVoltageY: false,
      showPhaseVoltageB: false,
    },
  });

  await prisma.customerMachineAccess.upsert({
    where: {
      customerId_machineId: {
        customerId: demoCustomer.id,
        machineId: machine.id,
      },
    },
    update: {},
    create: {
      customerId: demoCustomer.id,
      machineId: machine.id,
    },
  });

  const modules = [
    "fleet",
    "overview",
    "production",
    "reports",
  ];

  for (const moduleKey of modules) {
    await prisma.customerModuleAccess.upsert({
      where: {
        customerId_moduleKey: {
          customerId: demoCustomer.id,
          moduleKey,
        },
      },
      update: {
        enabled: true,
        updatedAt: new Date(),
      },
      create: {
        customerId: demoCustomer.id,
        moduleKey,
        enabled: true,
        updatedAt: new Date(),
      },
    });
  }

  console.log("✅ Clean seed completed");
}

prisma
  .connectDB()
  .then(main)
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });