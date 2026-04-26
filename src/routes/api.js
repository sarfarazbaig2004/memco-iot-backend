const express = require("express");

const prisma = require("../db");
const {
  sanitizeUser,
  signToken,
  verifyPassword,
} = require("../auth");
const {
  updateActiveWelderSessionFromTelemetry,
} = require("../welderSessions");

const router = express.Router();

const TELEMETRY_FRESHNESS_SECONDS = 180;
const DEFAULT_CURRENT_SETTING = 0;
const MODULE_KEYS = [
  "fleet",
  "overview",
  "production",
  "engineering",
  "calibration",
  "reports",
];
const machineControlState = new Map();

function parseMachineId(rawId) {
  const machineId = Number.parseInt(rawId, 10);

  return Number.isInteger(machineId) && machineId > 0 ? machineId : null;
}

function parseMachineIds(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [...new Set(values.map(parseMachineId).filter(Boolean))];
}

function parseMachineIdentifier(rawId) {
  if (rawId === undefined || rawId === null) {
    return null;
  }

  const machineIdentifier = String(rawId).trim();

  return machineIdentifier || null;
}

function isSuperAdmin(user) {
  return user?.role === "SUPER_ADMIN";
}

function requireAuthenticated(req, res) {
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required" });
    return false;
  }

  return true;
}

function requireSuperAdmin(req, res) {
  if (!requireAuthenticated(req, res)) {
    return false;
  }

  if (!isSuperAdmin(req.user)) {
    res.status(403).json({ error: "Super admin access required" });
    return false;
  }

  return true;
}

async function getUserModuleKeys(userId) {
  const rows = await prisma.userModuleAccess.findMany({
    where: {
      userId,
      enabled: true,
    },
    select: { moduleKey: true },
  });

  return rows.map((row) => row.moduleKey);
}

async function getAccessibleMachineIds(user) {
  if (!user?.id || isSuperAdmin(user)) {
    return null;
  }

  const rows = await prisma.userMachineAccess.findMany({
    where: { userId: Number(user.id) },
    select: { machineId: true },
  });

  return rows.map((row) => row.machineId);
}

async function buildMachineAccessWhere(user, baseWhere = {}) {
  const allowedMachineIds = await getAccessibleMachineIds(user);

  if (allowedMachineIds === null) {
    return baseWhere;
  }

  if (allowedMachineIds.length === 0) {
    return {
      ...baseWhere,
      id: { in: [] },
    };
  }

  return {
    ...baseWhere,
    id: { in: allowedMachineIds },
  };
}

async function canAccessMachine(user, machineId) {
  const allowedMachineIds = await getAccessibleMachineIds(user);

  return allowedMachineIds === null || allowedMachineIds.includes(machineId);
}

async function findMachineByIdentifier(machineIdentifier, queryOptions = {}) {
  const numericMachineId = parseMachineId(machineIdentifier);

  if (numericMachineId) {
    const machineById = await prisma.machine.findUnique({
      where: { id: numericMachineId },
      ...queryOptions,
    });

    if (machineById) {
      return machineById;
    }
  }

  return prisma.machine.findFirst({
    where: { machineCode: machineIdentifier },
    ...queryOptions,
  });
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsedValue = Number(value);

  return Number.isFinite(parsedValue) ? parsedValue : Number.NaN;
}

function firstPresentNumber(...values) {
  for (const value of values) {
    if (Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function deriveTelemetryTemperature(telemetry) {
  if (!telemetry) {
    return null;
  }

  const temperatures = [
    telemetry.temperature,
    telemetry.trafoCoreTemperature,
    telemetry.igbtTemperature,
    telemetry.heatSyncTemperature,
  ].filter((value) => value !== null && value !== undefined);

  return temperatures.length ? Math.max(...temperatures) : null;
}

function getTelemetryTemperatures(telemetry, emptyValue = null) {
  if (!telemetry) {
    return {
      trafoCore: emptyValue,
      igbt: emptyValue,
      heatSync: emptyValue,
    };
  }

  const fallbackTemperature = deriveTelemetryTemperature(telemetry);

  return {
    trafoCore: firstPresentNumber(
      telemetry.trafoCoreTemperature,
      fallbackTemperature
    ),
    igbt: firstPresentNumber(telemetry.igbtTemperature, fallbackTemperature),
    heatSync: firstPresentNumber(
      telemetry.heatSyncTemperature,
      fallbackTemperature
    ),
  };
}

function parseOptionalBoolean(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return null;
}

function parseTimestamp(value) {
  if (!value) {
    return new Date();
  }

  const parsedValue = new Date(value);

  return Number.isNaN(parsedValue.getTime()) ? null : parsedValue;
}

function getTelemetryTime(telemetry) {
  if (!telemetry) {
    return null;
  }

  return telemetry.timestamp || telemetry.createdAt || null;
}

function getSecondsSinceLastTelemetry(telemetry) {
  const lastTime = getTelemetryTime(telemetry);

  if (!lastTime) {
    return null;
  }

  const parsedLastTime = new Date(lastTime);

  if (Number.isNaN(parsedLastTime.getTime())) {
    return null;
  }

  return Math.floor((Date.now() - parsedLastTime.getTime()) / 1000);
}

function getMachineStatus(telemetry) {
  if (!telemetry) {
    return "OFFLINE";
  }

  const secondsSinceLastTelemetry = getSecondsSinceLastTelemetry(telemetry);

  if (
    secondsSinceLastTelemetry === null ||
    secondsSinceLastTelemetry > TELEMETRY_FRESHNESS_SECONDS
  ) {
    return "OFFLINE";
  }

  if (telemetry.arcOn === true || Number(telemetry.outputCurrent) > 20) {
    return "WELDING";
  }

  return "IDLE";
}

function buildHealthState(telemetry) {
  const alarms = [];
  const warnings = [];
  const temperature = deriveTelemetryTemperature(telemetry);

  if (!telemetry) {
    return {
      health: "GREY",
      alarms,
      warnings,
    };
  }

  if ((temperature || 0) > 80) alarms.push("OVERHEAT");
  if ((telemetry.inputVoltage || 0) > 450) alarms.push("HIGH_VOLTAGE");
  if ((telemetry.outputCurrent || 0) > 350) alarms.push("OVER_CURRENT");

  if (
    (temperature || 0) > 70 &&
    (temperature || 0) <= 80
  ) {
    warnings.push("TEMP_WARNING");
  }

  if (
    (telemetry.inputVoltage || 0) > 420 &&
    (telemetry.inputVoltage || 0) <= 450
  ) {
    warnings.push("VOLTAGE_WARNING");
  }

  let health = "GREEN";

  if (alarms.length > 0) {
    health = "RED";
  } else if (warnings.length > 0) {
    health = "YELLOW";
  }

  return {
    health,
    alarms,
    warnings,
  };
}

function getHealthLabel(health) {
  if (health === "RED") return "CRITICAL";
  if (health === "YELLOW") return "WARNING";
  if (health === "GREEN") return "HEALTHY";
  return "GREY";
}

function buildEmptyOverview(machine) {
  const controls = getMachineControls(machine.id);

  return {
    machineId: machine.id,
    machineCode: machine.machineCode,
    serialNumber: machine.serialNumber || "",
    location: machine.location || "Shop Floor",
    status: "OFFLINE",
    health: "GREY",
    healthLabel: "GREY",
    alarmCount: 0,
    warningCount: 0,
    lastUpdatedAt: null,
    secondsSinceLastTelemetry: null,
    outputCurrent: 0,
    temperature: 0,
    trafoCoreTemperature: 0,
    igbtTemperature: 0,
    heatSyncTemperature: 0,
    weldingCurrent: 0,
    weldingVoltage: 0,
    currentSetting: controls.currentSetting,
    fanSpeed: 0,
    inputVoltage: {
      R: 0,
      Y: 0,
      B: 0,
    },
    temperatures: {
      trafoCore: 0,
      igbt: 0,
      heatSync: 0,
    },
    alarms: [],
    warnings: [],
    trend: [],
    activeWelderSession: null,
    activeWelder: null,
  };
}

function getMachineControls(machineId) {
  return (
    machineControlState.get(machineId) || {
      currentSetting: DEFAULT_CURRENT_SETTING,
    }
  );
}

function setMachineControls(machineId, controls) {
  const nextControls = {
    ...getMachineControls(machineId),
    ...controls,
  };

  machineControlState.set(machineId, nextControls);
  return nextControls;
}

function resetMachineControls(machineId) {
  return setMachineControls(machineId, {
    currentSetting: DEFAULT_CURRENT_SETTING,
  });
}

function buildZeroTelemetryData(machineId) {
  return {
    machineId,
    timestamp: new Date(),
    inputVoltage: 0,
    outputVoltage: 0,
    outputCurrent: 0,
    temperature: 0,
    trafoCoreTemperature: 0,
    igbtTemperature: 0,
    heatSyncTemperature: 0,
    arcOn: false,
  };
}

function buildOfflineFleetMachine(machine, latestTelemetry = null) {
  return {
    id: machine.id,
    machineId: machine.id,
    code: machine.machineCode,
    machineCode: machine.machineCode,
    serialNumber: machine.serialNumber || "",
    location: machine.location || "Shop Floor",
    status: "OFFLINE",
    health: "GREY",
    healthLabel: "GREY",
    isLive: false,
    lastSeen: getTelemetryTime(latestTelemetry),
    lastUpdatedAt: getTelemetryTime(latestTelemetry),
    secondsSinceLastTelemetry: getSecondsSinceLastTelemetry(latestTelemetry),
    current: 0,
    outputCurrent: 0,
    temperature: null,
    trafoCoreTemperature: null,
    igbtTemperature: null,
    heatSyncTemperature: null,
    warningCount: 0,
    alarmCount: 0,
    warnings: [],
    alarms: [],
    welder: "Unknown",
    activeWelderSession: null,
  };
}

function buildFleetSummary(machines) {
  return machines.reduce(
    (summary, machine) => {
      summary.totalMachines += 1;

      if (machine.status === "OFFLINE") {
        summary.offlineMachines += 1;
        return summary;
      }

      summary.liveMachines += 1;

      if (machine.healthLabel === "WARNING") {
        summary.warningMachines += 1;
      }

      if (machine.healthLabel === "CRITICAL") {
        summary.criticalMachines += 1;
      }

      return summary;
    },
    {
      totalMachines: 0,
      liveMachines: 0,
      offlineMachines: 0,
      warningMachines: 0,
      criticalMachines: 0,
    }
  );
}

function setFleetSummaryHeaders(res, summary) {
  res.set({
    "X-Fleet-Total-Machines": String(summary.totalMachines),
    "X-Fleet-Live-Machines": String(summary.liveMachines),
    "X-Fleet-Offline-Machines": String(summary.offlineMachines),
    "X-Fleet-Warning-Machines": String(summary.warningMachines),
    "X-Fleet-Critical-Machines": String(summary.criticalMachines),
  });
}

function sendInternalError(context, error, res) {
  console.error(`${context}:`, error);
  res.status(500).json({ error: "Internal server error" });
}

function sendPrismaWriteError(context, error, res) {
  console.error(`${context}:`, error);

  if (error.code === "P2002") {
    return res.status(409).json({
      error: "A record with the same unique value already exists",
    });
  }

  if (error.code === "P2003") {
    return res.status(400).json({
      error: "The request references a related record that does not exist",
    });
  }

  return res.status(500).json({ error: "Internal server error" });
}

function parseRequiredText(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const text = String(value).trim();

  return text || null;
}

function formatDurationSeconds(seconds) {
  const totalSeconds = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  return `${hours}:${String(minutes).padStart(2, "0")}:${String(
    remainingSeconds
  ).padStart(2, "0")}`;
}

function formatWelderSession(session) {
  if (!session) {
    return null;
  }

  const latestTelemetry = session.machine?.telemetry?.[0] || null;

  return {
    id: session.id,
    status: session.status,
    rfidCardNo: session.rfidCardNo,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    lastTelemetryAt: session.lastTelemetryAt,
    arcingTimeSeconds: session.arcingTimeSeconds,
    idleTimeSeconds: session.idleTimeSeconds,
    arcingTime: formatDurationSeconds(session.arcingTimeSeconds),
    idleTime: formatDurationSeconds(session.idleTimeSeconds),
    energy: session.energy,
    deposition: session.deposition,
    arcCount: session.arcCount,
    current: latestTelemetry?.outputCurrent || 0,
    voltage: latestTelemetry?.outputVoltage || 0,
    inputVoltage: latestTelemetry?.inputVoltage || 0,
    temperature: deriveTelemetryTemperature(latestTelemetry),
    trafoCoreTemperature: latestTelemetry?.trafoCoreTemperature ?? null,
    igbtTemperature: latestTelemetry?.igbtTemperature ?? null,
    heatSyncTemperature: latestTelemetry?.heatSyncTemperature ?? null,
    telemetryAt: getTelemetryTime(latestTelemetry),
    welder: session.welder
      ? {
          id: session.welder.id,
          name: session.welder.name,
          employeeCode: session.welder.employeeCode,
          rfidCardNo: session.welder.rfidCardNo,
          active: session.welder.active,
        }
      : null,
    machine: session.machine
      ? {
          id: session.machine.id,
          machineCode: session.machine.machineCode,
          serialNumber: session.machine.serialNumber || "",
          location: session.machine.location || "Shop Floor",
        }
      : null,
  };
}

function formatWelderSessionForUser(session, user) {
  const formattedSession = formatWelderSession(session);

  if (!formattedSession || isSuperAdmin(user)) {
    return formattedSession;
  }

  const {
    current: _current,
    voltage: _voltage,
    inputVoltage: _inputVoltage,
    temperature: _temperature,
    trafoCoreTemperature: _trafoCoreTemperature,
    igbtTemperature: _igbtTemperature,
    heatSyncTemperature: _heatSyncTemperature,
    telemetryAt: _telemetryAt,
    energy: _energy,
    deposition: _deposition,
    idleTimeSeconds: _idleTimeSeconds,
    idleTime: _idleTime,
    arcCount: _arcCount,
    ...customerSession
  } = formattedSession;

  return customerSession;
}

function formatWelderSessionsForUser(sessions, user) {
  return sessions.map((session) => formatWelderSessionForUser(session, user));
}

async function findActiveWelderSession(machineId) {
  return prisma.welderSession.findFirst({
    where: {
      machineId,
      status: "ACTIVE",
      endedAt: null,
    },
    orderBy: { startedAt: "desc" },
    include: {
      welder: true,
      machine: {
        include: {
          telemetry: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 1,
          },
        },
      },
    },
  });
}

async function closeActiveWelderSessions(where, endedAt = new Date()) {
  return prisma.welderSession.updateMany({
    where: {
      ...where,
      status: "ACTIVE",
      endedAt: null,
    },
    data: {
      status: "CLOSED",
      endedAt,
    },
  });
}

async function buildUserAccessPayload(user) {
  if (!user) {
    return {
      modules: [],
      machines: [],
    };
  }

  if (isSuperAdmin(user)) {
    return {
      modules: MODULE_KEYS,
      machines: [],
      allMachines: true,
    };
  }

  const [moduleRows, machineRows] = await Promise.all([
    prisma.userModuleAccess.findMany({
      where: {
        userId: user.id,
        enabled: true,
      },
      orderBy: { moduleKey: "asc" },
    }),
    prisma.userMachineAccess.findMany({
      where: { userId: user.id },
      orderBy: { machineId: "asc" },
      include: {
        machine: {
          select: {
            id: true,
            machineCode: true,
            serialNumber: true,
            location: true,
          },
        },
      },
    }),
  ]);

  return {
    modules: moduleRows.map((row) => row.moduleKey),
    machines: machineRows.map((row) => row.machine),
    allMachines: false,
  };
}

router.post("/auth/login", async (req, res) => {
  try {
    const email = parseRequiredText(req.body.email)?.toLowerCase();
    const password = parseRequiredText(req.body.password);

    if (!email || !password) {
      return res.status(400).json({
        error: "email and password are required",
      });
    }

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user || !user.active || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({
        error: "Invalid email or password",
      });
    }

    const sanitizedUser = sanitizeUser(user);
    const token = signToken(sanitizedUser);
    const access = await buildUserAccessPayload(user);

    return res.json({
      token,
      user: sanitizedUser,
      access,
    });
  } catch (error) {
    return sendInternalError("Login error", error, res);
  }
});

router.get("/auth/me", async (req, res) => {
  if (!req.user?.id) {
    return res.status(401).json({
      error: "Authentication required",
    });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: Number(req.user.id) },
    });

    if (!user || !user.active) {
      return res.status(401).json({
        error: "Authentication required",
      });
    }

    const access = await buildUserAccessPayload(user);

    return res.json({
      user: sanitizeUser(user),
      access,
    });
  } catch (error) {
    return sendInternalError("Current user error", error, res);
  }
});

router.get("/access/modules", async (req, res) => {
  if (!requireAuthenticated(req, res)) {
    return;
  }

  try {
    return res.json({
      modules: isSuperAdmin(req.user)
        ? MODULE_KEYS
        : await getUserModuleKeys(Number(req.user.id)),
      availableModules: MODULE_KEYS,
    });
  } catch (error) {
    return sendInternalError("Get module access error", error, res);
  }
});

router.get("/access/users", async (req, res) => {
  if (!requireSuperAdmin(req, res)) {
    return;
  }

  try {
    const users = await prisma.user.findMany({
      orderBy: [{ role: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        active: true,
        createdAt: true,
      },
    });

    return res.json(users);
  } catch (error) {
    return sendInternalError("List access users error", error, res);
  }
});

router.get("/access/users/:id", async (req, res) => {
  if (!requireSuperAdmin(req, res)) {
    return;
  }

  try {
    const userId = parseMachineId(req.params.id);

    if (!userId) {
      return res.status(400).json({ error: "Valid user id is required" });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        active: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: `User with id ${userId} not found` });
    }

    const access = await buildUserAccessPayload(user);

    return res.json({
      user,
      access,
      availableModules: MODULE_KEYS,
    });
  } catch (error) {
    return sendInternalError("Get user access error", error, res);
  }
});

router.put("/access/users/:id", async (req, res) => {
  if (!requireSuperAdmin(req, res)) {
    return;
  }

  try {
    const userId = parseMachineId(req.params.id);

    if (!userId) {
      return res.status(400).json({ error: "Valid user id is required" });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      return res.status(404).json({ error: `User with id ${userId} not found` });
    }

    const moduleKeys = Array.isArray(req.body.modules)
      ? req.body.modules
          .map((moduleKey) => String(moduleKey).trim())
          .filter((moduleKey) => MODULE_KEYS.includes(moduleKey))
      : [];
    const machineIds = parseMachineIds(req.body.machineIds);

    if (machineIds.length > 0) {
      const machineCount = await prisma.machine.count({
        where: { id: { in: machineIds } },
      });

      if (machineCount !== machineIds.length) {
        return res.status(400).json({
          error: "One or more machineIds do not exist",
        });
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.userModuleAccess.deleteMany({ where: { userId } });
      await tx.userMachineAccess.deleteMany({ where: { userId } });

      if (!isSuperAdmin(user) && moduleKeys.length > 0) {
        await tx.userModuleAccess.createMany({
          data: moduleKeys.map((moduleKey) => ({
            userId,
            moduleKey,
            enabled: true,
          })),
        });
      }

      if (!isSuperAdmin(user) && machineIds.length > 0) {
        await tx.userMachineAccess.createMany({
          data: machineIds.map((machineId) => ({
            userId,
            machineId,
          })),
        });
      }
    });

    const updatedUser = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        active: true,
        createdAt: true,
      },
    });
    const access = await buildUserAccessPayload(updatedUser);

    return res.json({
      message: "User access updated successfully",
      user: updatedUser,
      access,
      availableModules: MODULE_KEYS,
    });
  } catch (error) {
    return sendPrismaWriteError("Update user access error", error, res);
  }
});

router.post("/company", async (req, res) => {
  try {
    const { name, code, email, mobile } = req.body;

    if (!name || !code) {
      return res.status(400).json({
        error: "name and code are required",
      });
    }

    const company = await prisma.company.create({
      data: {
        name: String(name).trim(),
        code: String(code).trim(),
        email: email ? String(email).trim() : null,
        mobile: mobile ? String(mobile).trim() : null,
      },
    });

    return res.json(company);
  } catch (error) {
    return sendPrismaWriteError("Create company error", error, res);
  }
});

router.post("/machine", async (req, res) => {
  try {
    const { companyId, machineCode, model, machineType, location, status } =
      req.body;

    const parsedCompanyId = parseMachineId(companyId);

    if (!parsedCompanyId || !machineCode || !model || !machineType) {
      return res.status(400).json({
        error: "companyId, machineCode, model, and machineType are required",
      });
    }

    const company = await prisma.company.findUnique({
      where: { id: parsedCompanyId },
      select: { id: true },
    });

    if (!company) {
      return res.status(404).json({
        error: `Company with id ${parsedCompanyId} not found`,
      });
    }

    const machine = await prisma.machine.create({
      data: {
        companyId: parsedCompanyId,
        machineCode: String(machineCode).trim(),
        model: String(model).trim(),
        machineType: String(machineType).trim(),
        location: location ? String(location).trim() : null,
        status: status ? String(status).trim() : "ACTIVE",
      },
    });

    return res.json(machine);
  } catch (error) {
    return sendPrismaWriteError("Create machine error", error, res);
  }
});

router.post("/welders", async (req, res) => {
  try {
    const name = parseRequiredText(req.body.name);
    const employeeCode = parseRequiredText(req.body.employeeCode);
    const rfidCardNo = parseRequiredText(
      req.body.rfidCardNo ?? req.body.rfid ?? req.body.cardNo
    );
    const active = parseOptionalBoolean(req.body.active);

    if (!name || !employeeCode || !rfidCardNo) {
      return res.status(400).json({
        error: "name, employeeCode, and rfidCardNo are required",
      });
    }

    const welder = await prisma.welder.upsert({
      where: { rfidCardNo },
      create: {
        name,
        employeeCode,
        rfidCardNo,
        active: active ?? true,
      },
      update: {
        name,
        employeeCode,
        active: active ?? true,
      },
    });

    return res.json(welder);
  } catch (error) {
    return sendPrismaWriteError("Upsert welder error", error, res);
  }
});

router.post("/telemetry", async (req, res) => {
  try {
    const {
      machineId,
      timestamp,
      inputVoltage,
      outputVoltage,
      outputCurrent,
      temperature,
      trafoCoreTemperature,
      transformerCoreTemperature,
      igbtTemperature,
      heatSyncTemperature,
      heatSinkTemperature,
      arcOn,
    } = req.body;

    const machineIdentifier = parseMachineIdentifier(machineId);

    if (!machineIdentifier) {
      return res.status(400).json({
        error: "machineId is required",
      });
    }

    const parsedTimestamp = parseTimestamp(timestamp);
    const parsedInputVoltage = parseOptionalNumber(inputVoltage);
    const parsedOutputVoltage = parseOptionalNumber(outputVoltage);
    const parsedOutputCurrent = parseOptionalNumber(outputCurrent);
    const parsedTrafoCoreTemperature = firstPresentNumber(
      parseOptionalNumber(trafoCoreTemperature),
      parseOptionalNumber(transformerCoreTemperature)
    );
    const parsedIgbtTemperature = parseOptionalNumber(igbtTemperature);
    const parsedHeatSyncTemperature = firstPresentNumber(
      parseOptionalNumber(heatSyncTemperature),
      parseOptionalNumber(heatSinkTemperature)
    );
    const parsedTemperature = firstPresentNumber(
      parseOptionalNumber(temperature),
      Math.max(
        ...[
          parsedTrafoCoreTemperature,
          parsedIgbtTemperature,
          parsedHeatSyncTemperature,
        ].filter((value) => value !== null && !Number.isNaN(value))
      )
    );
    const parsedArcOn = parseOptionalBoolean(arcOn);

    if (!parsedTimestamp) {
      return res.status(400).json({
        error: "Invalid timestamp format",
      });
    }

    if (
      Number.isNaN(parsedInputVoltage) ||
      Number.isNaN(parsedOutputVoltage) ||
      Number.isNaN(parsedOutputCurrent) ||
      Number.isNaN(parsedTemperature) ||
      Number.isNaN(parsedTrafoCoreTemperature) ||
      Number.isNaN(parsedIgbtTemperature) ||
      Number.isNaN(parsedHeatSyncTemperature)
    ) {
      return res.status(400).json({
        error: "Voltage, current, and temperature values must be valid numbers",
      });
    }

    if (
      arcOn !== undefined &&
      arcOn !== null &&
      arcOn !== "" &&
      parsedArcOn === null
    ) {
      return res.status(400).json({
        error: 'arcOn must be either true, false, "true", or "false"',
      });
    }

    const machine = await findMachineByIdentifier(machineIdentifier, {
      select: { id: true },
    });

    if (!machine) {
      return res.status(404).json({
        error: `Machine with identifier ${machineIdentifier} not found`,
      });
    }

    const telemetry = await prisma.telemetry.create({
      data: {
        machineId: machine.id,
        timestamp: parsedTimestamp,
        inputVoltage: parsedInputVoltage,
        outputVoltage: parsedOutputVoltage,
        outputCurrent: parsedOutputCurrent,
        temperature: parsedTemperature,
        trafoCoreTemperature: parsedTrafoCoreTemperature,
        igbtTemperature: parsedIgbtTemperature,
        heatSyncTemperature: parsedHeatSyncTemperature,
        arcOn: parsedArcOn,
      },
    });

    await updateActiveWelderSessionFromTelemetry(telemetry);

    return res.json({
      message: "Telemetry inserted successfully",
      telemetry,
      alert:
        deriveTelemetryTemperature(telemetry) !== null &&
        deriveTelemetryTemperature(telemetry) > 80
          ? "OVERHEAT ALERT"
          : null,
    });
  } catch (error) {
    return sendPrismaWriteError("Telemetry insert error", error, res);
  }
});

router.post("/machine/:id/set-current", async (req, res) => {
  try {
    const machineIdentifier = parseMachineIdentifier(req.params.id);

    if (!machineIdentifier) {
      return res.status(400).json({
        error: "Machine identifier is required",
      });
    }

    const machine = await findMachineByIdentifier(machineIdentifier, {
      select: { id: true, machineCode: true },
    });

    if (!machine) {
      return res.status(404).json({
        error: `Machine with identifier ${machineIdentifier} not found`,
      });
    }

    const rawCurrentSetting =
      req.body.currentSetting ?? req.body.current ?? req.body.value ?? 0;
    const parsedCurrentSetting = parseOptionalNumber(rawCurrentSetting);

    if (
      parsedCurrentSetting === null ||
      Number.isNaN(parsedCurrentSetting) ||
      parsedCurrentSetting < 0
    ) {
      return res.status(400).json({
        error: "currentSetting must be a valid non-negative number",
      });
    }

    const controls = setMachineControls(machine.id, {
      currentSetting: parsedCurrentSetting,
    });

    return res.json({
      message: "Current setting updated",
      machineId: machine.id,
      machineCode: machine.machineCode,
      currentSetting: controls.currentSetting,
    });
  } catch (error) {
    return sendInternalError("Set current error", error, res);
  }
});

router.post("/machine/:id/rfid/assign", async (req, res) => {
  try {
    const machineIdentifier = parseMachineIdentifier(req.params.id);
    const rfidCardNo = parseRequiredText(
      req.body.rfidCardNo ?? req.body.rfid ?? req.body.cardNo
    );

    if (!machineIdentifier) {
      return res.status(400).json({
        error: "Machine identifier is required",
      });
    }

    if (!rfidCardNo) {
      return res.status(400).json({
        error: "rfidCardNo is required",
      });
    }

    const machine = await findMachineByIdentifier(machineIdentifier, {
      select: { id: true, machineCode: true, serialNumber: true, location: true },
    });

    if (!machine) {
      return res.status(404).json({
        error: `Machine with identifier ${machineIdentifier} not found`,
      });
    }

    const welder = await prisma.welder.findUnique({
      where: { rfidCardNo },
    });

    if (!welder || !welder.active) {
      return res.status(404).json({
        error: `Active welder with RFID ${rfidCardNo} not found`,
      });
    }

    const now = new Date();
    const session = await prisma.$transaction(async (tx) => {
      await tx.welderSession.updateMany({
        where: {
          status: "ACTIVE",
          endedAt: null,
          OR: [{ welderId: welder.id }, { machineId: machine.id }],
        },
        data: {
          status: "CLOSED",
          endedAt: now,
        },
      });

      return tx.welderSession.create({
        data: {
          welderId: welder.id,
          machineId: machine.id,
          rfidCardNo,
          startedAt: now,
          lastTelemetryAt: now,
        },
        include: {
          welder: true,
          machine: {
            include: {
              telemetry: {
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                take: 1,
              },
            },
          },
        },
      });
    });

    return res.json({
      message: "RFID assigned successfully",
      session: formatWelderSession(session),
    });
  } catch (error) {
    return sendPrismaWriteError("RFID assign error", error, res);
  }
});

router.post("/machine/:id/rfid/clear", async (req, res) => {
  try {
    const machineIdentifier = parseMachineIdentifier(req.params.id);

    if (!machineIdentifier) {
      return res.status(400).json({
        error: "Machine identifier is required",
      });
    }

    const machine = await findMachineByIdentifier(machineIdentifier, {
      select: { id: true, machineCode: true },
    });

    if (!machine) {
      return res.status(404).json({
        error: `Machine with identifier ${machineIdentifier} not found`,
      });
    }

    const result = await closeActiveWelderSessions({ machineId: machine.id });

    return res.json({
      message: "RFID session cleared successfully",
      machineId: machine.id,
      machineCode: machine.machineCode,
      closedSessions: result.count,
    });
  } catch (error) {
    return sendPrismaWriteError("RFID clear error", error, res);
  }
});

router.get("/machine/:id/rfid/active", async (req, res) => {
  try {
    const machineIdentifier = parseMachineIdentifier(req.params.id);

    if (!machineIdentifier) {
      return res.status(400).json({
        error: "Machine identifier is required",
      });
    }

    const machine = await findMachineByIdentifier(machineIdentifier, {
      select: { id: true },
    });

    if (!machine) {
      return res.status(404).json({
        error: `Machine with identifier ${machineIdentifier} not found`,
      });
    }

    const session = await findActiveWelderSession(machine.id);

    return res.json({
      active: Boolean(session),
      session: formatWelderSessionForUser(session, req.user),
    });
  } catch (error) {
    return sendInternalError("Get active RFID session error", error, res);
  }
});

async function resetMachineTelemetry(machine, options = {}) {
  if (options.clearHistory) {
    await prisma.telemetry.deleteMany({
      where: { machineId: machine.id },
    });

    resetMachineControls(machine.id);
    return {
      ...buildZeroTelemetryData(machine.id),
      id: null,
      createdAt: null,
    };
  }

  resetMachineControls(machine.id);

  return prisma.telemetry.create({
    data: buildZeroTelemetryData(machine.id),
  });
}

function resetJobData(req, res) {
  return handleMachineReset(req, res);
}

function resetMachineData(req, res) {
  return handleMachineReset(req, res, { clearHistory: true });
}

function resetByScope(req, res) {
  const scope = String(req.body.scope || req.query.scope || "job").toLowerCase();

  return handleMachineReset(req, res, {
    clearHistory: scope === "machine" || scope === "all",
  });
}

async function handleMachineReset(req, res, options = {}) {
  try {
    const machineIdentifier = parseMachineIdentifier(req.params.id);

    if (!machineIdentifier) {
      return res.status(400).json({
        error: "Machine identifier is required",
      });
    }

    const machine = await findMachineByIdentifier(machineIdentifier, {
      select: { id: true, machineCode: true },
    });

    if (!machine) {
      return res.status(404).json({
        error: `Machine with identifier ${machineIdentifier} not found`,
      });
    }

    const telemetry = await resetMachineTelemetry(machine, options);

    return res.json({
      message: options.clearHistory
        ? "Machine data reset successfully"
        : "Job data reset successfully",
      machineId: machine.id,
      machineCode: machine.machineCode,
      currentSetting: DEFAULT_CURRENT_SETTING,
      telemetry,
    });
  } catch (error) {
    return sendPrismaWriteError("Machine reset error", error, res);
  }
}

router.post("/machine/:id/reset-job-data", resetJobData);
router.post("/machine/:id/reset-job", resetJobData);
router.post("/machine/:id/job/reset", resetJobData);

router.post("/machine/:id/reset-machine-data", resetMachineData);
router.post("/machine/:id/reset-machine", resetMachineData);
router.post("/machine/:id/data/reset", resetMachineData);

router.post("/machine/:id/reset", resetByScope);

router.get("/telemetry", async (req, res) => {
  try {
    const telemetry = await prisma.telemetry.findMany({
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    });

    return res.json(telemetry);
  } catch (error) {
    return sendInternalError("Get telemetry error", error, res);
  }
});

router.get("/reports/live-welder-sessions", async (_req, res) => {
  try {
    const allowedMachineIds = await getAccessibleMachineIds(_req.user);
    const sessions = await prisma.welderSession.findMany({
      where: {
        status: "ACTIVE",
        endedAt: null,
        ...(allowedMachineIds === null
          ? {}
          : { machineId: { in: allowedMachineIds } }),
      },
      orderBy: { startedAt: "desc" },
      include: {
        welder: true,
        machine: {
          include: {
            telemetry: {
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: 1,
            },
          },
        },
      },
    });

    return res.json(formatWelderSessionsForUser(sessions, _req.user));
  } catch (error) {
    return sendInternalError("Live welder session report error", error, res);
  }
});

router.get("/machine/:id", async (req, res) => {
  try {
    const machineIdentifier = parseMachineIdentifier(req.params.id);

    if (!machineIdentifier) {
      return res.status(400).json({
        error: "Machine identifier is required",
      });
    }

    const machine = await findMachineByIdentifier(machineIdentifier, {
      include: {
        company: true,
        telemetry: {
          orderBy: [{ timestamp: "desc" }, { id: "desc" }],
        },
      },
    });

    if (!machine) {
      return res.status(404).json({
        error: `Machine with identifier ${machineIdentifier} not found`,
      });
    }

    return res.json(machine);
  } catch (error) {
    return sendInternalError("Get machine error", error, res);
  }
});

router.get("/machine/:id/latest", async (req, res) => {
  try {
    const machineIdentifier = parseMachineIdentifier(req.params.id);

    if (!machineIdentifier) {
      return res.status(400).json({
        error: "Machine identifier is required",
      });
    }

    const machine = await findMachineByIdentifier(machineIdentifier, {
      select: { id: true },
    });

    if (!machine) {
      return res.status(404).json({
        error: `Machine with identifier ${machineIdentifier} not found`,
      });
    }

    const latestTelemetry = await prisma.telemetry.findFirst({
      where: { machineId: machine.id },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    });

    if (!latestTelemetry) {
      return res.status(404).json({
        error: "No telemetry found for this machine",
      });
    }

    return res.json(latestTelemetry);
  } catch (error) {
    return sendInternalError("Get latest telemetry error", error, res);
  }
});

router.get("/machine/:id/overview", async (req, res) => {
  try {
    const machineIdentifier = parseMachineIdentifier(req.params.id);

    if (!machineIdentifier) {
      return res.status(400).json({
        error: "Machine identifier is required",
      });
    }

    const machine = await findMachineByIdentifier(machineIdentifier, {
      select: {
        id: true,
        machineCode: true,
        serialNumber: true,
        location: true,
      },
    });

    if (!machine) {
      return res.status(404).json({
        error: `Machine with identifier ${machineIdentifier} not found`,
      });
    }

    if (!(await canAccessMachine(req.user, machine.id))) {
      return res.status(403).json({
        error: "Machine access denied",
      });
    }

    const [telemetry, historyRaw, activeSession] = await Promise.all([
      prisma.telemetry.findFirst({
        where: { machineId: machine.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
      prisma.telemetry.findMany({
        where: { machineId: machine.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 20,
      }),
      findActiveWelderSession(machine.id),
    ]);

    if (!telemetry) {
      return res.json({
        ...buildEmptyOverview(machine),
        activeWelderSession: formatWelderSession(activeSession),
        activeWelder: activeSession?.welder
          ? {
              id: activeSession.welder.id,
              name: activeSession.welder.name,
              employeeCode: activeSession.welder.employeeCode,
              rfidCardNo: activeSession.welder.rfidCardNo,
            }
          : null,
      });
    }

    const status = getMachineStatus(telemetry);
    const secondsSinceLastTelemetry = getSecondsSinceLastTelemetry(telemetry);
    const lastUpdatedAt = getTelemetryTime(telemetry);
    const isFresh = status !== "OFFLINE";
    const controls = getMachineControls(machine.id);
    const { health, alarms, warnings } = isFresh
      ? buildHealthState(telemetry)
      : buildHealthState(null);
    const trend = historyRaw
      .slice()
      .reverse()
      .map((item) => ({
        time: item.timestamp || item.createdAt,
        current: item.outputCurrent || 0,
        voltage: item.outputVoltage || 0,
      }));
    const overviewTemperature = isFresh
      ? deriveTelemetryTemperature(telemetry)
      : null;
    const temperatures = isFresh
      ? getTelemetryTemperatures(telemetry)
      : getTelemetryTemperatures(null);

    return res.json({
      machineId: machine.id,
      machineCode: machine.machineCode,
      serialNumber: machine.serialNumber || "",
      location: machine.location || "Shop Floor",
      status,
      health,
      healthLabel: getHealthLabel(health),
      alarmCount: alarms.length,
      warningCount: warnings.length,
      lastUpdatedAt,
      secondsSinceLastTelemetry,
      outputCurrent: isFresh ? telemetry.outputCurrent || 0 : 0,
      temperature: overviewTemperature,
      trafoCoreTemperature: temperatures.trafoCore,
      igbtTemperature: temperatures.igbt,
      heatSyncTemperature: temperatures.heatSync,
      weldingCurrent: isFresh ? telemetry.outputCurrent || 0 : 0,
      weldingVoltage: isFresh ? telemetry.outputVoltage || 0 : 0,
      currentSetting: controls.currentSetting,
      fanSpeed: 0,
      inputVoltage: {
        R: isFresh ? telemetry.inputVoltage || 0 : 0,
        Y: isFresh ? telemetry.inputVoltage || 0 : 0,
        B: isFresh ? telemetry.inputVoltage || 0 : 0,
      },
      temperatures,
      alarms,
      warnings,
      trend,
      activeWelderSession: formatWelderSession(activeSession),
      activeWelder: activeSession?.welder
        ? {
            id: activeSession.welder.id,
            name: activeSession.welder.name,
            employeeCode: activeSession.welder.employeeCode,
            rfidCardNo: activeSession.welder.rfidCardNo,
          }
        : null,
    });
  } catch (error) {
    return sendInternalError("Machine overview error", error, res);
  }
});

router.get("/machines/overview", async (req, res) => {
  try {
    const machineWhere = await buildMachineAccessWhere(req.user);
    const machines = await prisma.machine.findMany({
      where: machineWhere,
      orderBy: { id: "asc" },
      select: {
        id: true,
        machineCode: true,
        serialNumber: true,
        location: true,
        telemetry: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
          select: {
            arcOn: true,
            timestamp: true,
            createdAt: true,
            inputVoltage: true,
            outputCurrent: true,
            temperature: true,
            trafoCoreTemperature: true,
            igbtTemperature: true,
            heatSyncTemperature: true,
          },
        },
        welderSessions: {
          where: {
            status: "ACTIVE",
            endedAt: null,
          },
          orderBy: { startedAt: "desc" },
          take: 1,
          include: {
            welder: true,
            machine: {
              include: {
                telemetry: {
                  orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                  take: 1,
                },
              },
            },
          },
        },
      },
    });

    const result = machines.map((machine) => {
      const latest = machine.telemetry[0] || null;
      const activeSession = machine.welderSessions[0] || null;
      const status = getMachineStatus(latest);
      const temperature = deriveTelemetryTemperature(latest);

      if (status === "OFFLINE") {
        return {
          ...buildOfflineFleetMachine(machine, latest),
          welder: activeSession?.welder?.name || "Unknown",
          activeWelderSession: formatWelderSession(activeSession),
        };
      }

      const { health, alarms, warnings } = buildHealthState(latest);

      return {
        id: machine.id,
        machineId: machine.id,
        code: machine.machineCode,
        machineCode: machine.machineCode,
        serialNumber: machine.serialNumber || "",
        location: machine.location || "Shop Floor",
        status,
        health,
        healthLabel: getHealthLabel(health),
        isLive: true,
        lastSeen: getTelemetryTime(latest),
        lastUpdatedAt: getTelemetryTime(latest),
        secondsSinceLastTelemetry: getSecondsSinceLastTelemetry(latest),
        current: latest?.outputCurrent || 0,
        outputCurrent: latest?.outputCurrent || 0,
        temperature,
        trafoCoreTemperature: latest?.trafoCoreTemperature ?? temperature,
        igbtTemperature: latest?.igbtTemperature ?? temperature,
        heatSyncTemperature: latest?.heatSyncTemperature ?? temperature,
        warningCount: warnings.length,
        alarmCount: alarms.length,
        warnings,
        alarms,
        welder: activeSession?.welder?.name || "Unknown",
        activeWelderSession: formatWelderSession(activeSession),
      };
    }).sort(
      (a, b) =>
        Number(b.isLive) - Number(a.isLive) ||
        a.machineCode.localeCompare(b.machineCode)
    );

    setFleetSummaryHeaders(res, buildFleetSummary(result));
    return res.json(result);
  } catch (error) {
    return sendInternalError("Fleet overview error", error, res);
  }
});

module.exports = router;
