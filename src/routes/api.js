const express = require("express");
const PDFDocument = require("pdfkit");
const prisma = require("../db");
const {
  hashPassword,
  sanitizeUser,
  signToken,
  verifyPassword,
} = require("../auth");
const {
  updateActiveWelderSessionFromTelemetry,
  buildArcEngineDiagnostics,
} = require("../welderSessions");
const {
  getDailyProductionSummary,
  getProductionTimeline,
  parseProductionDate,
  processTelemetryForProduction,
} = require("../productionTelemetry");

const router = express.Router();

// ============================================================================
// 1. CONSTANTS & IN-MEMORY STATE
// ============================================================================

const TELEMETRY_FRESHNESS_SECONDS = 5 * 60;
const DEFAULT_CURRENT_SETTING = 0;
const MODULE_KEYS = [
  "fleet",
  "overview",
  "production",
  "engineering",
  "calibration",
  "reports",
];
const WELDER_TRACKING_MODES = ["MANUAL", "RFID", "MIXED", "DISABLED"];

// In-memory state (Note: In a multi-instance production environment, move this to Redis)
const machineControlState = new Map();
const machineEngineeringState = new Map();

// ============================================================================
// 2. DATA PARSING & FORMATTING HELPERS
// ============================================================================

function parseMachineId(rawId) {
  const machineId = Number.parseInt(rawId, 10);
  return Number.isInteger(machineId) && machineId > 0 ? machineId : null;
}

function parseMachineIds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(parseMachineId).filter(Boolean))];
}

function parseMachineIdentifier(rawId) {
  if (rawId === undefined || rawId === null) return null;
  return String(rawId).trim() || null;
}

function parseRequiredText(value) {
  if (value === undefined || value === null) return null;
  return String(value).trim() || null;
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : Number.NaN;
}

function parseOptionalBoolean(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function parseOptionalString(value) {
  if (value === undefined || value === null) return null;
  return String(value).trim() || null;
}

function parseOptionalDate(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsedValue = new Date(value);
  return Number.isNaN(parsedValue.getTime()) ? null : parsedValue;
}

function parseTimestamp(value) {
  if (!value) return new Date();
  const parsedValue = new Date(value);
  return Number.isNaN(parsedValue.getTime()) ? null : parsedValue;
}

function parseWelderTrackingMode(value, fallback = "MANUAL") {
  const mode = parseRequiredText(value)?.toUpperCase();
  return WELDER_TRACKING_MODES.includes(mode) ? mode : fallback;
}

function firstPresentNumber(...values) {
  for (const value of values) {
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function uniqueTextValues(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function formatDurationSeconds(seconds) {
  const totalSeconds = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function getErrorDetails(error) {
  return {
    name: error?.name,
    code: error?.code,
    message: error?.message || String(error),
    meta: error?.meta,
    stack: error?.stack,
  };
}

function getPayloadKeys(payload) {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? Object.keys(payload)
    : [];
}

// ============================================================================
// 3. AUTHENTICATION & ACCESS CONTROL HELPERS
// ============================================================================

function isSuperAdmin(user) {
  return ["SUPER_ADMIN", "SOFTWARE_SUPER_ADMIN", "COMPANY_SUPER_ADMIN"].includes(user?.role);
}

function hasFullAccess(user) {
  return isSuperAdmin(user);
}

function requireAuthenticated(req, res) {
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required" });
    return false;
  }
  return true;
}

function requireSuperAdmin(req, res) {
  if (!requireAuthenticated(req, res)) return false;
  if (!isSuperAdmin(req.user)) {
    res.status(403).json({ error: "Super admin access required" });
    return false;
  }
  return true;
}

async function getCompanySuperAdmin(req) {
  if (!req.user?.id) return null;
  const user = await prisma.user.findUnique({
    where: { id: Number(req.user.id) },
    select: { id: true, name: true, email: true, role: true, active: true },
  });
  if (!user || !user.active || user.role !== "COMPANY_SUPER_ADMIN") return null;
  return user;
}

async function requireCompanySuperAdmin(req, res) {
  const user = await getCompanySuperAdmin(req);
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  if (!user) {
    res.status(403).json({ error: "COMPANY_SUPER_ADMIN access required" });
    return null;
  }
  return user;
}

async function getAccessUser(req) {
  const email = req.headers["x-user-email"];
  if (!email) return null;
  return prisma.user.findUnique({
    where: { email: String(email) },
    include: { machineAccesses: true },
  });
}

function sanitizeCustomerUser(user) {
  if (!user) return null;
  const { passwordHash: _passwordHash, ...safeUser } = user;
  return safeUser;
}

async function getUserModuleKeys(userId) {
  const rows = await prisma.userModuleAccess.findMany({
    where: { userId, enabled: true },
    select: { moduleKey: true },
  });
  return rows.map((row) => row.moduleKey);
}

async function getAccessibleMachineIds(user) {
  if (!user?.id || hasFullAccess(user)) return null;

  const [userMachineAccessRows, customerAccessRows, customerMachineAccessRows] = await Promise.all([
    prisma.userMachineAccess.findMany({
      where: { userId: Number(user.id) },
      select: { machineId: true },
    }),
    user.role === "CUSTOMER"
      ? getCustomerAccessByEmail(user.email)
      : Promise.resolve(null),
    user.role === "CUSTOMER"
      ? prisma.customer
          .findFirst({
            where: { userId: Number(user.id) },
            select: { id: true },
          })
          .then((customer) =>
            customer
              ? prisma.customerMachineAccess.findMany({
                  where: { customerId: customer.id },
                  select: { machineId: true },
                })
              : []
          )
      : Promise.resolve([]),
  ]);

  const accessibleMachineIds = new Set([
    ...userMachineAccessRows.map((row) => row.machineId),
    ...(customerAccessRows?.machineIds || []),
    ...(customerMachineAccessRows || []).map((row) => row.machineId),
  ]);

  return [...accessibleMachineIds];
}

async function buildMachineAccessWhere(user, baseWhere = {}) {
  const allowedMachineIds = await getAccessibleMachineIds(user);
  if (allowedMachineIds === null) return baseWhere;
  if (allowedMachineIds.length === 0) return { ...baseWhere, id: { in: [] } };
  return { ...baseWhere, id: { in: allowedMachineIds } };
}

async function canAccessMachine(user, machineId) {
  const allowedMachineIds = await getAccessibleMachineIds(user);
  return allowedMachineIds === null || allowedMachineIds.includes(machineId);
}

function customerAllowedMachineIds(user) {
  return user?.machineAccesses?.map((access) => access.machineId) || [];
}

function isCustomerForbiddenForMachine(user, machineId) {
  if (!user || user.role !== "CUSTOMER") return false;
  return !customerAllowedMachineIds(user).includes(Number(machineId));
}

function sendForbiddenMachineAccess(res) {
  return res.status(403).json({
    error: "FORBIDDEN",
    message: "You do not have access to this machine",
  });
}

// ============================================================================
// 4. BUSINESS LOGIC & DOMAIN HELPERS
// ============================================================================

async function getDefaultCompany(client = prisma) {
  const memco = await client.company.findUnique({ where: { code: "MEMCO" } });
  if (memco) return memco;
  return client.company.findFirst({ orderBy: { id: "asc" } });
}

async function findMachineByIdentifier(machineIdentifier, queryOptions = {}) {
  const numericMachineId = parseMachineId(machineIdentifier);
  if (numericMachineId) {
    const machineById = await prisma.machine.findUnique({
      where: { id: numericMachineId },
      ...queryOptions,
    });
    if (machineById) return machineById;
  }
  return prisma.machine.findFirst({
    where: { machineCode: machineIdentifier },
    ...queryOptions,
  });
}

function deriveTelemetryTemperature(telemetry) {
  if (!telemetry) return null;
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
    return { trafoCore: emptyValue, igbt: emptyValue, heatSync: emptyValue };
  }
  const fallbackTemperature = deriveTelemetryTemperature(telemetry);
  return {
    trafoCore: firstPresentNumber(telemetry.trafoCoreTemperature, fallbackTemperature),
    igbt: firstPresentNumber(telemetry.igbtTemperature, fallbackTemperature),
    heatSync: firstPresentNumber(telemetry.heatSyncTemperature, fallbackTemperature),
  };
}

function getTelemetryTime(telemetry) {
  if (!telemetry) return null;
  return telemetry.timestamp || telemetry.createdAt || null;
}

function getSecondsSinceLastTelemetry(telemetry) {
  const lastTime = getTelemetryTime(telemetry);
  if (!lastTime) return null;
  const parsedLastTime = new Date(lastTime);
  if (Number.isNaN(parsedLastTime.getTime())) return null;
  return Math.floor((Date.now() - parsedLastTime.getTime()) / 1000);
}

function getMachineStatus(telemetry) {
  if (!telemetry) return "OFFLINE";
  const secondsSinceLastTelemetry = getSecondsSinceLastTelemetry(telemetry);
  
  if (secondsSinceLastTelemetry === null || secondsSinceLastTelemetry > TELEMETRY_FRESHNESS_SECONDS) {
    return "OFFLINE";
  }
  if (telemetry.machineOn === false) return "OFF";
  if (telemetry.arcOn === true || Number(telemetry.outputCurrent) > 20) return "WELDING";
  
  return "IDLE";
}

function buildHealthState(telemetry) {
  const alarms = [];
  const warnings = [];
  const temperature = deriveTelemetryTemperature(telemetry);

  if (!telemetry) return { health: "GREY", alarms, warnings };

  if ((temperature || 0) > 80) alarms.push("OVERHEAT");
  if ((telemetry.inputVoltage || 0) > 450) alarms.push("HIGH_VOLTAGE");
  if ((telemetry.outputCurrent || 0) > 350) alarms.push("OVER_CURRENT");

  if ((temperature || 0) > 70 && (temperature || 0) <= 80) warnings.push("TEMP_WARNING");
  if ((telemetry.inputVoltage || 0) > 420 && (telemetry.inputVoltage || 0) <= 450) warnings.push("VOLTAGE_WARNING");

  let health = "GREEN";
  if (alarms.length > 0) health = "RED";
  else if (warnings.length > 0) health = "YELLOW";

  return { health, alarms, warnings };
}

function getHealthLabel(health) {
  if (health === "RED") return "CRITICAL";
  if (health === "YELLOW") return "WARNING";
  if (health === "GREEN") return "HEALTHY";
  return "GREY";
}

function getMachineControls(machineId) {
  return machineControlState.get(machineId) || { currentSetting: DEFAULT_CURRENT_SETTING };
}

function setMachineControls(machineId, controls) {
  const nextControls = { ...getMachineControls(machineId), ...controls };
  machineControlState.set(machineId, nextControls);
  return nextControls;
}

function resetMachineControls(machineId) {
  return setMachineControls(machineId, { currentSetting: DEFAULT_CURRENT_SETTING });
}

function getMachineEngineeringSetpoints(machineId) {
  return machineEngineeringState.get(machineId) || {
    acVoltageThresholds: { acLow: null, acLowLow: null, acHigh: null, acHighHigh: null },
    temperatureThresholds: { temp1H: null, temp1HH: null, temp2H: null, temp2HH: null, temp3H: null, temp3HH: null },
    parameterSettings: { depositionCoefficient: null, machineRatedCurrentLimit: null, machineRatedCurrent: null },
    fanAndWirefeed: { normalFanPulsePerMin: null, wireFeedPulseCount: null },
    updatedAt: null,
  };
}

function setMachineEngineeringSetpoints(machineId, updates) {
  const current = getMachineEngineeringSetpoints(machineId);
  const next = {
    ...current,
    acVoltageThresholds: { ...current.acVoltageThresholds, ...(updates.acVoltageThresholds || {}) },
    temperatureThresholds: { ...current.temperatureThresholds, ...(updates.temperatureThresholds || {}) },
    parameterSettings: { ...current.parameterSettings, ...(updates.parameterSettings || {}) },
    fanAndWirefeed: { ...current.fanAndWirefeed, ...(updates.fanAndWirefeed || {}) },
    updatedAt: new Date().toISOString(),
  };
  machineEngineeringState.set(machineId, next);
  return next;
}

// ----------------------------------------------------------------------------
// Customer Access & formatting payloads
// ----------------------------------------------------------------------------

async function getCustomerAccessRecord(email, client = prisma) {
  if (!email || !client.customerAccess) return null;
  return client.customerAccess.findUnique({ where: { email } });
}

async function findCustomerForUser(user, client = prisma) {
  if (!user || !client.customer) return null;
  return client.customer.findFirst({
    where: { OR: [{ userId: user.id }, { email: user.email }] },
  });
}

async function getCustomerAccessByEmail(email) {
  const normalizedEmail = parseRequiredText(email)?.toLowerCase();
  if (!normalizedEmail) return null;

  const savedAccess = await getCustomerAccessRecord(normalizedEmail);
  if (savedAccess) return normalizeCustomerAccessRecord(savedAccess);

  const customer = prisma.customer
    ? await prisma.customer.findUnique({
        where: { email: normalizedEmail },
        include: { machineAccess: true, moduleAccess: true, featureAccess: true, parameterAccess: true },
      })
    : null;

  if (!customer) return null;

  const access = buildCustomerAccessPayload(customer);
  return {
    email: normalizedEmail,
    allowedMachines: access.machines,
    machineIds: access.machines,
    allowedModules: access.modules,
    allowedFeatures: access.features,
    allowedParameters: access.parameters,
    updatedAt: customer.updatedAt,
  };
}

async function syncCustomerAccessRows(tx, user, access) {
  if (!user || user.role !== "CUSTOMER") return null;

  const company = await getDefaultCompany(tx);
  const now = new Date();
  const customer = await findCustomerForUser(user, tx);

  const savedCustomer = customer || (company && tx.customer
    ? await tx.customer.create({
        data: { name: user.name, email: user.email, companyId: company.id, userId: user.id, active: true, updatedAt: now },
      })
    : null);

  await tx.userModuleAccess.deleteMany({ where: { userId: user.id } });
  await tx.userMachineAccess.deleteMany({ where: { userId: user.id } });

  if (access.allowedModules.length > 0) {
    await tx.userModuleAccess.createMany({
      data: access.allowedModules.map((moduleKey) => ({ userId: user.id, moduleKey, enabled: true })),
    });
  }

  if (access.machineIds.length > 0) {
    await tx.userMachineAccess.createMany({
      data: access.machineIds.map((machineId) => ({ userId: user.id, machineId })),
    });
  }

  if (!savedCustomer) return null;

  await tx.customer.update({ where: { id: savedCustomer.id }, data: { updatedAt: now } });

  // Clean customer tables
  await tx.customerModuleAccess.deleteMany({ where: { customerId: savedCustomer.id } });
  await tx.customerMachineAccess.deleteMany({ where: { customerId: savedCustomer.id } });
  await tx.customerFeatureAccess.deleteMany({ where: { customerId: savedCustomer.id } });
  await tx.customerParameterAccess.deleteMany({ where: { customerId: savedCustomer.id } });

  // Re-insert customer tables
  if (access.allowedModules.length > 0) {
    await tx.customerModuleAccess.createMany({
      data: access.allowedModules.map((moduleKey) => ({ customerId: savedCustomer.id, moduleKey, enabled: true, updatedAt: now })),
    });
  }
  if (access.machineIds.length > 0) {
    await tx.customerMachineAccess.createMany({
      data: access.machineIds.map((machineId) => ({ customerId: savedCustomer.id, machineId })),
    });
  }
  if (access.allowedFeatures.length > 0) {
    await tx.customerFeatureAccess.createMany({
      data: access.allowedFeatures.map((featureKey) => ({ customerId: savedCustomer.id, featureKey, enabled: true, updatedAt: now })),
    });
  }
  if (access.allowedParameters.length > 0) {
    await tx.customerParameterAccess.createMany({
      data: access.allowedParameters.map((parameterKey) => ({ customerId: savedCustomer.id, parameterKey, enabled: true, updatedAt: now })),
    });
  }
  return savedCustomer;
}

// ----------------------------------------------------------------------------
// Formatting Output Payloads
// ----------------------------------------------------------------------------

function getTelemetryGps(telemetry) {
  return {
    gpsFix: telemetry?.gpsFix ?? null,
    gpsLat: telemetry?.gpsLat ?? null,
    gpsLng: telemetry?.gpsLng ?? null,
    gpsAltitude: telemetry?.gpsAltitude ?? null,
    mapUrl: telemetry?.mapUrl ?? null,
  };
}

function buildMapUrl(gpsLat, gpsLng, mapUrl) {
  if (mapUrl) return mapUrl;
  if (gpsLat === null || gpsLng === null) return null;
  return `https://www.google.com/maps?q=${gpsLat},${gpsLng}`;
}

function buildUserAccessSummary(user, machineCount) {
  const assignedMachineCount = user?.machineAccesses?.length || 0;
  return {
    modules: user?.moduleAccesses?.filter((a) => a.enabled).map((a) => a.moduleKey) || [],
    machines: user?.machineAccesses?.map((a) => a.machineId) || [],
    features: [],
    parameters: [],
    allMachines: machineCount > 0 && assignedMachineCount === machineCount,
  };
}

async function buildUserAccessPayload(user) {
  if (!user) return { modules: [], machines: [] };

  if (hasFullAccess(user)) {
    return {
      modules: MODULE_KEYS, machines: [], allMachines: true, machineIds: [],
      allowedMachines: "ALL", allowedModules: "ALL", allowedFeatures: "ALL", allowedParameters: "ALL",
    };
  }

  const [moduleRows, machineRows, savedAccess] = await Promise.all([
    prisma.userModuleAccess.findMany({ where: { userId: user.id, enabled: true }, orderBy: { moduleKey: "asc" } }),
    prisma.userMachineAccess.findMany({
      where: { userId: user.id }, orderBy: { machineId: "asc" },
      include: { machine: { select: { id: true, machineCode: true, serialNumber: true, location: true } } },
    }),
    user.role === "CUSTOMER" ? getCustomerAccessByEmail(user.email) : null,
  ]);

  const machineIds = machineRows.map((row) => row.machineId);
  const modules = moduleRows.map((row) => row.moduleKey);

  return {
    modules,
    machines: machineRows.map((row) => row.machine),
    features: savedAccess?.allowedFeatures || [],
    parameters: savedAccess?.allowedParameters || [],
    allMachines: false,
    machineIds,
    allowedMachines: savedAccess?.allowedMachines || machineIds,
    allowedModules: savedAccess?.allowedModules || modules,
    allowedFeatures: savedAccess?.allowedFeatures || [],
    allowedParameters: savedAccess?.allowedParameters || [],
  };
}

function normalizeCustomerAccessRecord(record) {
  return {
    email: record.email,
    allowedMachines: Array.isArray(record.allowedMachines) ? record.allowedMachines : [],
    machineIds: record.machineIds || [],
    allowedModules: record.allowedModules || [],
    allowedFeatures: record.allowedFeatures || [],
    allowedParameters: record.allowedParameters || [],
    updatedAt: record.updatedAt,
  };
}

function parseCustomerAccessInput(body) {
  const email = parseRequiredText(body.email)?.toLowerCase();
  const machineIds = parseMachineIds(body.machineIds ?? body.machines);
  const allowedModules = uniqueTextValues(body.allowedModules ?? body.modules);
  const allowedFeatures = uniqueTextValues(body.allowedFeatures ?? body.features);
  const allowedParameters = uniqueTextValues(body.allowedParameters ?? body.parameters);
  const allowedMachines = Array.isArray(body.allowedMachines) ? body.allowedMachines : machineIds;

  return { email, allowedMachines, machineIds, allowedModules, allowedFeatures, allowedParameters };
}

function buildCustomerAccessPayload(customer, allMachines = false) {
  return {
    modules: customer?.moduleAccess?.filter((a) => a.enabled).map((a) => a.moduleKey) || [],
    machines: customer?.machineAccess?.map((a) => a.machineId) || [],
    features: customer?.featureAccess?.filter((a) => a.enabled).map((a) => a.featureKey) || [],
    parameters: customer?.parameterAccess?.filter((a) => a.enabled).map((a) => a.parameterKey) || [],
    allMachines,
  };
}

// ----------------------------------------------------------------------------
// Formatting Welder & Session Output
// ----------------------------------------------------------------------------

function formatWelderSession(session) {
  if (!session) return null;
  const latestTelemetry = session.machine?.latestTelemetry || session.machine?.telemetry?.[0] || null;
  const machineStatus = getMachineStatus(latestTelemetry);
  const isWelding = machineStatus === "WELDING";

  return {
    id: session.id,
    status: machineStatus,
    assignmentStatus: session.status,
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
    current: isWelding ? latestTelemetry?.outputCurrent || 0 : 0,
    voltage: isWelding ? latestTelemetry?.outputVoltage || 0 : 0,
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
  if (!formattedSession || hasFullAccess(user)) return formattedSession;

  const {
    inputVoltage: _inputVoltage,
    temperature: _temperature,
    trafoCoreTemperature: _trafoCoreTemperature,
    igbtTemperature: _igbtTemperature,
    heatSyncTemperature: _heatSyncTemperature,
    energy: _energy,
    deposition: _deposition,
    idleTimeSeconds: _idleTimeSeconds,
    idleTime: _idleTime,
    ...customerSession
  } = formattedSession;
  return customerSession;
}

function formatWelderSessionsForUser(sessions, user) {
  return sessions.map((session) => formatWelderSessionForUser(session, user));
}

function formatLiveWelderAssignment(assignment) {
  const latestTelemetry = assignment.machine?.latestTelemetry || null;
  const status = getMachineStatus(latestTelemetry);
  const isWelding = status === "WELDING";
  const now = new Date();
  const completedArcSeconds = assignment.arcEvents.reduce(
    (total, event) => total + (event.durationSeconds || 0),
    0
  );
  const openArcSeconds = assignment.arcEvents.reduce(
    (total, event) => total + (!event.endTime ? Math.max(0, Math.floor((now - event.startTime) / 1000)) : 0),
    0
  );
  const arcingTimeSeconds = completedArcSeconds + openArcSeconds;
  const elapsedSeconds = Math.max(0, Math.floor((now - assignment.startedAt) / 1000));

  return {
    id: assignment.id,
    status,
    assignmentStatus: assignment.status,
    trackingMode: assignment.trackingMode,
    startedAt: assignment.startedAt,
    endedAt: assignment.endedAt,
    lastTelemetryAt: getTelemetryTime(latestTelemetry),
    arcingTimeSeconds,
    idleTimeSeconds: Math.max(0, elapsedSeconds - arcingTimeSeconds),
    arcingTime: formatDurationSeconds(arcingTimeSeconds),
    idleTime: formatDurationSeconds(Math.max(0, elapsedSeconds - arcingTimeSeconds)),
    arcCount: assignment.arcEvents.length,
    current: isWelding ? latestTelemetry?.outputCurrent || 0 : 0,
    voltage: isWelding ? latestTelemetry?.outputVoltage || 0 : 0,
    inputVoltage: status === "OFFLINE" ? 0 : latestTelemetry?.inputVoltage || 0,
    temperature: status === "OFFLINE" ? null : deriveTelemetryTemperature(latestTelemetry),
    telemetryAt: getTelemetryTime(latestTelemetry),
    welder: {
      id: assignment.welder?.id || null,
      name: assignment.welderName || assignment.welder?.name || "UNKNOWN",
      employeeCode: assignment.employeeCode || assignment.welder?.employeeCode || null,
      rfidCardNo: assignment.rfidCardNo || assignment.welder?.rfidCardNo || null,
      active: assignment.welder?.active ?? true,
    },
    machine: assignment.machine
      ? {
          id: assignment.machine.id,
          machineCode: assignment.machine.machineCode,
          serialNumber: assignment.machine.serialNumber || "",
          location: assignment.machine.location || "Shop Floor",
        }
      : null,
  };
}

function formatLiveWelderAssignmentForUser(assignment, user) {
  const formattedAssignment = formatLiveWelderAssignment(assignment);
  if (hasFullAccess(user)) return formattedAssignment;

  const {
    inputVoltage: _inputVoltage,
    temperature: _temperature,
    idleTimeSeconds: _idleTimeSeconds,
    idleTime: _idleTime,
    ...customerAssignment
  } = formattedAssignment;

  return customerAssignment;
}

function formatWelderAssignment(assignment) {
  if (!assignment) return null;
  return {
    id: assignment.id,
    machineId: assignment.machineId,
    welderId: assignment.welderId,
    trackingMode: assignment.trackingMode,
    status: assignment.status,
    welderName: assignment.welderName || assignment.welder?.name || "UNKNOWN",
    employeeCode: assignment.employeeCode || assignment.welder?.employeeCode || null,
    rfidCardNo: assignment.rfidCardNo || assignment.welder?.rfidCardNo || null,
    startedAt: assignment.startedAt,
    endedAt: assignment.endedAt,
    createdAt: assignment.createdAt,
    updatedAt: assignment.updatedAt,
    machine: assignment.machine ? { id: assignment.machine.id, machineCode: assignment.machine.machineCode, serialNumber: assignment.machine.serialNumber || "", location: assignment.machine.location || "Shop Floor" } : null,
    welder: assignment.welder ? { id: assignment.welder.id, name: assignment.welder.name, employeeCode: assignment.welder.employeeCode, rfidCardNo: assignment.welder.rfidCardNo, active: assignment.welder.active } : null,
  };
}

function formatWelderArcEvent(event) {
  if (!event) return null;
  return {
    id: event.id,
    machineId: event.machineId,
    assignmentId: event.assignmentId,
    welderId: event.welderId,
    trackingMode: event.trackingMode,
    welderName: event.welderName || event.welder?.name || "UNKNOWN",
    employeeCode: event.employeeCode || event.welder?.employeeCode || null,
    rfidCardNo: event.rfidCardNo || event.welder?.rfidCardNo || null,
    startTime: event.startTime,
    endTime: event.endTime,
    durationSeconds: event.durationSeconds,
    startTelemetryId: event.startTelemetryId,
    endTelemetryId: event.endTelemetryId,
    startOutputVoltage: event.startOutputVoltage,
    startOutputCurrent: event.startOutputCurrent,
    endOutputVoltage: event.endOutputVoltage,
    endOutputCurrent: event.endOutputCurrent,
    machine: event.machine ? { id: event.machine.id, machineCode: event.machine.machineCode, serialNumber: event.machine.serialNumber || "", location: event.machine.location || "Shop Floor" } : null,
    welder: event.welder ? { id: event.welder.id, name: event.welder.name, employeeCode: event.welder.employeeCode, rfidCardNo: event.welder.rfidCardNo } : null,
  };
}

async function findActiveWelderSession(machineId) {
  return prisma.welderSession.findFirst({
    where: { machineId, status: "ACTIVE", endedAt: null },
    orderBy: { startedAt: "desc" },
    include: {
      welder: true,
      machine: { include: { telemetry: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 } } },
    },
  });
}

async function findActiveWelderAssignment(machineId) {
  return prisma.activeWelderAssignment.findFirst({
    where: { machineId, status: "ACTIVE", endedAt: null },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    include: { welder: true },
  });
}

async function closeActiveWelderSessions(where, endedAt = new Date()) {
  return prisma.welderSession.updateMany({
    where: { ...where, status: "ACTIVE", endedAt: null },
    data: { status: "CLOSED", endedAt },
  });
}

// ----------------------------------------------------------------------------
// Formatting Machine Output
// ----------------------------------------------------------------------------

function buildEmptyOverview(machine) {
  const controls = getMachineControls(machine.id);
  return {
    machineId: machine.id, machineCode: machine.machineCode, serialNumber: machine.serialNumber || "", location: machine.location || "Shop Floor",
    status: "OFFLINE", health: "GREY", healthLabel: "GREY", alarmCount: 0, warningCount: 0,
    lastUpdatedAt: null, secondsSinceLastTelemetry: null, outputCurrent: 0, temperature: 0,
    trafoCoreTemperature: 0, igbtTemperature: 0, heatSyncTemperature: 0,
    ...getTelemetryGps(null),
    weldingCurrent: 0, weldingVoltage: 0, currentSetting: controls.currentSetting, fanSpeed: 0,
    inputVoltage: { R: 0, Y: 0, B: 0 }, temperatures: { trafoCore: 0, igbt: 0, heatSync: 0 },
    alarms: [], warnings: [], trend: [], activeWelderSession: null, activeWelder: null,
  };
}

function buildOfflineFleetMachine(machine, latestTelemetry = null) {
  return {
    id: machine.id, machineId: machine.id, code: machine.machineCode, machineCode: machine.machineCode, serialNumber: machine.serialNumber || "", location: machine.location || "Shop Floor",
    status: "OFFLINE", health: "GREY", healthLabel: "GREY", isLive: false,
    lastSeen: getTelemetryTime(latestTelemetry), lastUpdatedAt: getTelemetryTime(latestTelemetry), secondsSinceLastTelemetry: getSecondsSinceLastTelemetry(latestTelemetry),
    current: 0, outputCurrent: 0, temperature: null, trafoCoreTemperature: null, igbtTemperature: null, heatSyncTemperature: null,
    ...getTelemetryGps(latestTelemetry), warningCount: 0, alarmCount: 0, warnings: [], alarms: [],
    welder: "Unknown", activeWelderSession: null,
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
      if (machine.healthLabel === "WARNING") summary.warningMachines += 1;
      if (machine.healthLabel === "CRITICAL") summary.criticalMachines += 1;
      return summary;
    },
    { totalMachines: 0, liveMachines: 0, offlineMachines: 0, warningMachines: 0, criticalMachines: 0 }
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

function buildZeroTelemetryData(machineId) {
  return {
    machineId, timestamp: new Date(), inputVoltage: 0, outputVoltage: 0, outputCurrent: 0,
    temperature: 0, trafoCoreTemperature: 0, igbtTemperature: 0, heatSyncTemperature: 0,
    machineOn: false, arcOn: false, gpsFix: null, gpsLat: null, gpsLng: null, mapUrl: null,
  };
}

function buildZeroProductionStats() {
  return {
    arcTime: "0:0:0",
    idleTime: "0:0:0",
    dcEnergy: 0,
    deposition: 0,
    wireFeedMeter: 0,
    arcCount: 0,
  };
}

async function resetMachineTelemetry(machine, options = {}) {
  const now = new Date();
  const zeroProductionStats = buildZeroProductionStats();
  const zeroTelemetry = {
    ...buildZeroTelemetryData(machine.id),
    timestamp: now,
    currentSetting: DEFAULT_CURRENT_SETTING,
    runningJob: zeroProductionStats,
    ...(options.clearHistory ? { machineLifetime: zeroProductionStats } : {}),
  };

  resetMachineControls(machine.id);

  if (options.clearHistory) {
    return prisma.$transaction(async (tx) => {
      await tx.telemetry.deleteMany({ where: { machineId: machine.id } });
      await tx.machineProductionEvent.deleteMany({ where: { machineId: machine.id } });
      await tx.dailyProductionSummary.deleteMany({ where: { machineId: machine.id } });

      return tx.machineLatestTelemetry.upsert({
        where: { machineId: machine.id },
        create: {
          ...zeroTelemetry,
          state: "OFF",
          telemetryId: null,
          lastReceivedAt: now,
        },
        update: {
          ...zeroTelemetry,
          state: "OFF",
          telemetryId: null,
          lastReceivedAt: now,
        },
      });
    });
  }

  const latest = await prisma.machineLatestTelemetry.findUnique({
    where: { machineId: machine.id },
  });

  if (latest) {
    return prisma.machineLatestTelemetry.update({
      where: { machineId: machine.id },
      data: {
        runningJob: zeroProductionStats,
        currentSetting: DEFAULT_CURRENT_SETTING,
      },
    });
  }

  return prisma.machineLatestTelemetry.create({
    data: {
      ...zeroTelemetry,
      state: "OFF",
      machineLifetime: zeroProductionStats,
      telemetryId: null,
      lastReceivedAt: now,
    },
  });
}

// ----------------------------------------------------------------------------
// Error Handling Wrappers
// ----------------------------------------------------------------------------

function sendInternalError(context, error, res) {
  console.error(context, getErrorDetails(error));
  res.status(500).json({ error: "Internal server error" });
}

function sendPrismaWriteError(context, error, res) {
  console.error(context, getErrorDetails(error));
  if (error.code === "P2002") {
    return res.status(409).json({ error: "A record with the same unique value already exists" });
  }
  if (error.code === "P2003") {
    return res.status(400).json({ error: "The request references a related record that does not exist" });
  }
  return res.status(500).json({ error: "Internal server error" });
}

// ============================================================================
// 5. API ROUTES: AUTHENTICATION
// ============================================================================

router.post("/auth/login", async (req, res) => {
  try {
    const email = parseRequiredText(req.body.email)?.toLowerCase();
    const password = parseRequiredText(req.body.password);

    if (!email || !password) return res.status(400).json({ error: "email and password are required" });

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.active || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const sanitizedUser = sanitizeUser(user);
    const token = signToken(sanitizedUser);
    const access = await buildUserAccessPayload(user);

    return res.json({ token, user: sanitizedUser, access });
  } catch (error) {
    return sendInternalError("Login error", error, res);
  }
});

router.get("/auth/me", async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });

  try {
    const user = await prisma.user.findUnique({ where: { id: Number(req.user.id) } });
    if (!user || !user.active) return res.status(401).json({ error: "Authentication required" });

    const access = await buildUserAccessPayload(user);
    return res.json({ user: sanitizeUser(user), access });
  } catch (error) {
    return sendInternalError("Current user error", error, res);
  }
});

router.get("/me/access", async (req, res) => {
  try {
    const email = String(req.headers["x-user-email"] || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "x-user-email header is required" });

    const user = await prisma.user.findUnique({ where: { email }, include: { moduleAccesses: true, machineAccesses: true } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const isCustomer = user.role === "CUSTOMER";
    const access = buildUserAccessSummary(user, 0);
    const savedAccess = isCustomer ? await getCustomerAccessByEmail(email) : null;

    return res.json({
      role: user.role,
      company: null,
      customer: null,
      allowedMachines: isCustomer ? savedAccess?.allowedMachines || access.machines : "ALL",
      machineIds: isCustomer ? savedAccess?.machineIds || access.machines : "ALL",
      allowedModules: isCustomer ? savedAccess?.allowedModules || access.modules : "ALL",
      allowedFeatures: isCustomer ? savedAccess?.allowedFeatures || [] : "ALL",
      allowedParameters: isCustomer ? savedAccess?.allowedParameters || [] : "ALL",
    });
  } catch (error) {
    console.error("Get current access error", getErrorDetails(error));
    return res.status(500).json({
      error: process.env.NODE_ENV === "development" ? error.message || "Internal server error" : "Internal server error",
    });
  }
});

// ============================================================================
// 6. API ROUTES: ADMIN & ACCESS MANAGEMENT
// ============================================================================

router.get("/admin/customer-access", async (req, res) => {
  const adminUser = await requireCompanySuperAdmin(req, res);
  if (!adminUser) return;

  try {
    const email = parseRequiredText(req.query.email)?.toLowerCase();
    if (email) {
      const access = await getCustomerAccessByEmail(email);
      if (!access) return res.status(404).json({ error: "Customer access not found" });
      return res.json(access);
    }
    const records = await prisma.customerAccess.findMany({ orderBy: { email: "asc" } });
    return res.json(records.map(normalizeCustomerAccessRecord));
  } catch (error) {
    return sendInternalError("List customer access error", error, res);
  }
});

router.post("/admin/customer-access", async (req, res) => {
  const adminUser = await requireCompanySuperAdmin(req, res);
  if (!adminUser) return;

  try {
    const access = parseCustomerAccessInput(req.body);
    if (!access.email) return res.status(400).json({ error: "email is required" });

    if (access.machineIds.length > 0) {
      const machineCount = await prisma.machine.count({ where: { id: { in: access.machineIds } } });
      if (machineCount !== access.machineIds.length) return res.status(400).json({ error: "One or more machine ids do not exist" });
    }

    const user = await prisma.user.findUnique({ where: { email: access.email } });
    if (!user || user.role !== "CUSTOMER") return res.status(404).json({ error: "Customer user not found" });

    const saved = await prisma.$transaction(async (tx) => {
      const record = await tx.customerAccess.upsert({
        where: { email: access.email },
        update: { allowedMachines: access.allowedMachines, machineIds: access.machineIds, allowedModules: access.allowedModules, allowedFeatures: access.allowedFeatures, allowedParameters: access.allowedParameters },
        create: { email: access.email, allowedMachines: access.allowedMachines, machineIds: access.machineIds, allowedModules: access.allowedModules, allowedFeatures: access.allowedFeatures, allowedParameters: access.allowedParameters },
      });
      await syncCustomerAccessRows(tx, user, access);
      return record;
    }, { timeout: 20000 });

    return res.json(normalizeCustomerAccessRecord(saved));
  } catch (error) {
    return sendPrismaWriteError("Save customer access error", error, res);
  }
});

router.post("/admin/customers", async (req, res) => {
  const adminUser = await requireCompanySuperAdmin(req, res);
  if (!adminUser) return;

  try {
    const name = parseRequiredText(req.body.name);
    const email = parseRequiredText(req.body.email)?.toLowerCase();
    const password = parseRequiredText(req.body.password);

    if (!name || !email || !password) return res.status(400).json({ error: "name, email, and password are required" });

    const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existingUser) return res.status(409).json({ error: "A user with this email already exists" });

    const existingCustomer = prisma.customer ? await prisma.customer.findUnique({ where: { email }, select: { id: true } }) : null;
    if (existingCustomer) return res.status(409).json({ error: "A customer with this email already exists" });

    const company = await getDefaultCompany();
    if (!company) return res.status(400).json({ error: "A company must exist before creating customers" });

    const now = new Date();
    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { name, email, passwordHash: hashPassword(password), role: "CUSTOMER", active: true } });
      const customer = tx.customer ? await tx.customer.create({ data: { name, email, companyId: company.id, userId: user.id, active: true, updatedAt: now }, include: { machineAccess: true, moduleAccess: true, featureAccess: true, parameterAccess: true } }) : null;
      return { user, customer };
    });

    return res.status(201).json({
      ...sanitizeCustomerUser(created.user),
      access: { modules: [], machines: [], features: [], parameters: [], allMachines: false },
    });
  } catch (error) {
    return sendPrismaWriteError("Create admin customer error", error, res);
  }
});

router.get("/admin/customers", async (req, res) => {
  const adminUser = await requireCompanySuperAdmin(req, res);
  if (!adminUser) return;

  try {
    const [users, machineCount] = await Promise.all([
      prisma.user.findMany({ where: { role: "CUSTOMER" }, orderBy: { name: "asc" }, include: { moduleAccesses: true, machineAccesses: true } }),
      prisma.machine.count(),
    ]);

    return res.json(users.map((user) => ({
      id: user.id, name: user.name, email: user.email, role: user.role, active: user.active, access: buildUserAccessSummary(user, machineCount),
    })));
  } catch (error) {
    return sendInternalError("List admin customers error", error, res);
  }
});

router.put("/admin/customers/:id/access", async (req, res) => {
  const adminUser = await requireCompanySuperAdmin(req, res);
  if (!adminUser) return;

  try {
    const userId = parseMachineId(req.params.id);
    if (!userId) return res.status(400).json({ error: "Valid customer user id is required" });

    const user = await prisma.user.findUnique({ where: { id: userId }, include: { moduleAccesses: true, machineAccesses: true } });
    if (!user || user.role !== "CUSTOMER") return res.status(404).json({ error: "Customer user not found" });

    const customer = await findCustomerForUser(user);
    const modules = uniqueTextValues(req.body.modules);
    const features = uniqueTextValues(req.body.features);
    const parameters = uniqueTextValues(req.body.parameters);
    const allMachines = req.body.allMachines === true;
    const requestedMachineIds = parseMachineIds(req.body.machines ?? req.body.machineIds);
    
    const machineIds = allMachines ? (await prisma.machine.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map((machine) => machine.id) : requestedMachineIds;

    if (machineIds.length > 0) {
      const machineCount = await prisma.machine.count({ where: { id: { in: machineIds } } });
      if (machineCount !== machineIds.length) return res.status(400).json({ error: "One or more machine ids do not exist" });
    }

    const now = new Date();
    const updatedCustomer = await prisma.$transaction(async (tx) => {
      await tx.userModuleAccess.deleteMany({ where: { userId } });
      await tx.userMachineAccess.deleteMany({ where: { userId } });

      if (customer) {
        if (tx.customerModuleAccess) await tx.customerModuleAccess.deleteMany({ where: { customerId: customer.id } });
        if (tx.customerMachineAccess) await tx.customerMachineAccess.deleteMany({ where: { customerId: customer.id } });
        if (tx.customerFeatureAccess) await tx.customerFeatureAccess.deleteMany({ where: { customerId: customer.id } });
        if (tx.customerParameterAccess) await tx.customerParameterAccess.deleteMany({ where: { customerId: customer.id } });
      }

      if (modules.length > 0) {
        await tx.userModuleAccess.createMany({ data: modules.map((moduleKey) => ({ userId, moduleKey, enabled: true })) });
        if (customer && tx.customerModuleAccess) await tx.customerModuleAccess.createMany({ data: modules.map((moduleKey) => ({ customerId: customer.id, moduleKey, enabled: true, updatedAt: now })) });
      }

      if (machineIds.length > 0) {
        await tx.userMachineAccess.createMany({ data: machineIds.map((machineId) => ({ userId, machineId })) });
        if (customer && tx.customerMachineAccess) await tx.customerMachineAccess.createMany({ data: machineIds.map((machineId) => ({ customerId: customer.id, machineId })) });
      }

      if (customer && tx.customerFeatureAccess && features.length > 0) {
        await tx.customerFeatureAccess.createMany({ data: features.map((featureKey) => ({ customerId: customer.id, featureKey, enabled: true, updatedAt: now })) });
      }

      if (customer && tx.customerParameterAccess && parameters.length > 0) {
        await tx.customerParameterAccess.createMany({ data: parameters.map((parameterKey) => ({ customerId: customer.id, parameterKey, enabled: true, updatedAt: now })) });
      }

      await tx.customerAccess.upsert({
        where: { email: user.email },
        update: { allowedMachines: machineIds, machineIds, allowedModules: modules, allowedFeatures: features, allowedParameters: parameters },
        create: { email: user.email, allowedMachines: machineIds, machineIds, allowedModules: modules, allowedFeatures: features, allowedParameters: parameters },
      });

      return tx.user.findUnique({ where: { id: userId }, include: { moduleAccesses: true, machineAccesses: true } });
    }, { timeout: 20000 });

    // Build a full access payload (includes customer-level saved access)
    const accessPayload = await buildUserAccessPayload(updatedCustomer);
    accessPayload.features = features;
    accessPayload.parameters = parameters;
    accessPayload.allMachines = allMachines === true;

    return res.json({
      id: updatedCustomer.id, name: updatedCustomer.name, email: updatedCustomer.email, role: updatedCustomer.role, active: updatedCustomer.active,
      access: accessPayload,
    });
  } catch (error) {
    return sendPrismaWriteError("Update admin customer access error", error, res);
  }
});

router.get("/access/modules", async (req, res) => {
  if (!requireAuthenticated(req, res)) return;
  try {
    return res.json({ modules: isSuperAdmin(req.user) ? MODULE_KEYS : await getUserModuleKeys(Number(req.user.id)), availableModules: MODULE_KEYS });
  } catch (error) {
    return sendInternalError("Get module access error", error, res);
  }
});

router.get("/access/users", async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const users = await prisma.user.findMany({ orderBy: [{ role: "asc" }, { name: "asc" }], select: { id: true, name: true, email: true, role: true, active: true, createdAt: true } });
    return res.json(users);
  } catch (error) {
    return sendInternalError("List access users error", error, res);
  }
});

router.get("/access/users/:id", async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const userId = parseMachineId(req.params.id);
    if (!userId) return res.status(400).json({ error: "Valid user id is required" });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, role: true, active: true, createdAt: true } });
    if (!user) return res.status(404).json({ error: `User with id ${userId} not found` });

    const access = await buildUserAccessPayload(user);
    return res.json({ user, access, availableModules: MODULE_KEYS });
  } catch (error) {
    return sendInternalError("Get user access error", error, res);
  }
});

router.put("/access/users/:id", async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const userId = parseMachineId(req.params.id);
    if (!userId) return res.status(400).json({ error: "Valid user id is required" });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
    if (!user) return res.status(404).json({ error: `User with id ${userId} not found` });

    const moduleKeys = Array.isArray(req.body.modules) ? req.body.modules.map((m) => String(m).trim()).filter((m) => MODULE_KEYS.includes(m)) : [];
    const machineIds = parseMachineIds(req.body.machineIds);

    if (machineIds.length > 0) {
      const machineCount = await prisma.machine.count({ where: { id: { in: machineIds } } });
      if (machineCount !== machineIds.length) return res.status(400).json({ error: "One or more machineIds do not exist" });
    }

    await prisma.$transaction(async (tx) => {
      await tx.userModuleAccess.deleteMany({ where: { userId } });
      await tx.userMachineAccess.deleteMany({ where: { userId } });

      if (!isSuperAdmin(user)) {
        if (moduleKeys.length > 0) await tx.userModuleAccess.createMany({ data: moduleKeys.map((moduleKey) => ({ userId, moduleKey, enabled: true })) });
        if (machineIds.length > 0) await tx.userMachineAccess.createMany({ data: machineIds.map((machineId) => ({ userId, machineId })) });
      }
    });

    const updatedUser = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, role: true, active: true, createdAt: true } });
    const access = await buildUserAccessPayload(updatedUser);
    return res.json({ message: "User access updated successfully", user: updatedUser, access, availableModules: MODULE_KEYS });
  } catch (error) {
    return sendPrismaWriteError("Update user access error", error, res);
  }
});

// ============================================================================
// 7. API ROUTES: COMPANIES & MACHINES
// ============================================================================

router.post("/company", async (req, res) => {
  try {
    const { name, code, email, mobile } = req.body;
    if (!name || !code) return res.status(400).json({ error: "name and code are required" });

    const company = await prisma.company.create({
      data: { name: String(name).trim(), code: String(code).trim(), email: email ? String(email).trim() : null, mobile: mobile ? String(mobile).trim() : null },
    });
    return res.json(company);
  } catch (error) {
    return sendPrismaWriteError("Create company error", error, res);
  }
});

router.post("/machine", async (req, res) => {
  try {
    const { companyId, machineCode, model, machineType, location, status } = req.body;
    const parsedCompanyId = parseMachineId(companyId);

    if (!parsedCompanyId || !machineCode || !model || !machineType) {
      return res.status(400).json({ error: "companyId, machineCode, model, and machineType are required" });
    }

    const company = await prisma.company.findUnique({ where: { id: parsedCompanyId }, select: { id: true } });
    if (!company) return res.status(404).json({ error: `Company with id ${parsedCompanyId} not found` });

    const machine = await prisma.machine.create({
      data: { companyId: parsedCompanyId, machineCode: String(machineCode).trim(), model: String(model).trim(), machineType: String(machineType).trim(), location: location ? String(location).trim() : null, status: status ? String(status).trim() : "ACTIVE" },
    });
    return res.json(machine);
  } catch (error) {
    return sendPrismaWriteError("Create machine error", error, res);
  }
});

// ============================================================================
// 8. API ROUTES: WELDERS & ASSIGNMENTS
// ============================================================================

router.post("/welders", async (req, res) => {
  try {
    const name = parseRequiredText(req.body.name);
    const employeeCode = parseRequiredText(req.body.employeeCode);
    const rfidCardNo = parseRequiredText(req.body.rfidCardNo ?? req.body.rfid ?? req.body.cardNo);
    const active = parseOptionalBoolean(req.body.active);

    if (!name || !employeeCode || !rfidCardNo) {
      return res.status(400).json({ error: "name, employeeCode, and rfidCardNo are required" });
    }

    const welder = await prisma.welder.upsert({
      where: { rfidCardNo },
      create: { name, employeeCode, rfidCardNo, active: active ?? true },
      update: { name, employeeCode, active: active ?? true },
    });
    return res.json(welder);
  } catch (error) {
    return sendPrismaWriteError("Upsert welder error", error, res);
  }
});

router.post("/welder-assignments/manual", async (req, res) => {
  const adminUser = await requireCompanySuperAdmin(req, res);
  if (!adminUser) return;

  try {
    const machineIdentifier = parseMachineIdentifier(req.body.machineId ?? req.body.machineCode ?? req.body.machine);
    const startedAt = parseOptionalDate(req.body.startedAt) || new Date();
    const welderId = parseMachineId(req.body.welderId);
    const employeeCode = parseRequiredText(req.body.employeeCode);
    const rfidCardNo = parseRequiredText(req.body.rfidCardNo ?? req.body.rfid ?? req.body.cardNo);
    const requestedWelderName = parseRequiredText(req.body.welderName ?? req.body.name);
    const trackingMode = parseWelderTrackingMode(req.body.trackingMode, "MANUAL");

    if (!machineIdentifier) return res.status(400).json({ error: "machineId or machineCode is required" });
    if (trackingMode === "DISABLED") return res.status(400).json({ error: "Manual assignments cannot be started with DISABLED tracking mode" });

    const machine = await findMachineByIdentifier(machineIdentifier, { select: { id: true, machineCode: true, serialNumber: true, location: true } });
    if (!machine) return res.status(404).json({ error: `Machine with identifier ${machineIdentifier} not found` });

    let welder = null;
    if (welderId) {
      welder = await prisma.welder.findUnique({ where: { id: welderId } });
      if (!welder) return res.status(404).json({ error: `Welder with id ${welderId} not found` });
    } else if (rfidCardNo) {
      welder = await prisma.welder.findUnique({ where: { rfidCardNo } });
    } else if (employeeCode) {
      welder = await prisma.welder.findUnique({ where: { employeeCode } });
    }

    const assignment = await prisma.$transaction(async (tx) => {
      await tx.activeWelderAssignment.updateMany({
        where: { machineId: machine.id, status: "ACTIVE", endedAt: null },
        data: { status: "ENDED", endedAt: startedAt, endedByUserId: Number(adminUser.id) },
      });

      if (welder) {
        await tx.activeWelderAssignment.updateMany({
          where: { welderId: welder.id, status: "ACTIVE", endedAt: null },
          data: { status: "ENDED", endedAt: startedAt, endedByUserId: Number(adminUser.id) },
        });
      }

      return tx.activeWelderAssignment.create({
        data: { machineId: machine.id, welderId: welder?.id || null, trackingMode, status: "ACTIVE", welderName: welder?.name || requestedWelderName || "UNKNOWN", employeeCode: welder?.employeeCode || employeeCode || null, rfidCardNo: welder?.rfidCardNo || rfidCardNo || null, startedAt, createdByUserId: Number(adminUser.id) },
        include: { machine: true, welder: true },
      });
    });

    return res.status(201).json({ message: "Manual welder assignment started", assignment: formatWelderAssignment(assignment) });
  } catch (error) {
    return sendPrismaWriteError("Start manual welder assignment error", error, res);
  }
});

router.post("/welder-assignments/:id/end", async (req, res) => {
  const adminUser = await requireCompanySuperAdmin(req, res);
  if (!adminUser) return;

  try {
    const assignmentId = parseMachineId(req.params.id);
    const endedAt = parseOptionalDate(req.body.endedAt) || new Date();
    if (!assignmentId) return res.status(400).json({ error: "Valid assignment id is required" });

    const existing = await prisma.activeWelderAssignment.findUnique({ where: { id: assignmentId }, include: { machine: true, welder: true } });
    if (!existing) return res.status(404).json({ error: `Active welder assignment with id ${assignmentId} not found` });

    const assignment = await prisma.$transaction(async (tx) => {
      const updated = await tx.activeWelderAssignment.update({
        where: { id: assignmentId },
        data: { status: "ENDED", endedAt, endedByUserId: Number(adminUser.id) },
        include: { machine: true, welder: true },
      });

      const openArcEvent = await tx.welderArcEvent.findFirst({ where: { assignmentId, endTime: null }, orderBy: [{ startTime: "desc" }, { id: "desc" }] });
      if (openArcEvent && endedAt > openArcEvent.startTime) {
        await tx.welderArcEvent.update({
          where: { id: openArcEvent.id },
          data: { endTime: endedAt, durationSeconds: Math.floor((endedAt.getTime() - openArcEvent.startTime.getTime()) / 1000) },
        });
      }
      return updated;
    });

    return res.json({ message: "Welder assignment ended", assignment: formatWelderAssignment(assignment) });
  } catch (error) {
    return sendPrismaWriteError("End welder assignment error", error, res);
  }
});

router.get("/welder-assignments/active", async (req, res) => {
  if (!requireAuthenticated(req, res)) return;
  try {
    const machineIdentifier = parseMachineIdentifier(req.query.machineId);
    const allowedMachineIds = await getAccessibleMachineIds(req.user);
    let machineId = null;

    if (machineIdentifier) {
      const machine = await findMachineByIdentifier(machineIdentifier, { select: { id: true } });
      if (!machine) return res.status(404).json({ error: `Machine with identifier ${machineIdentifier} not found` });
      if (!(await canAccessMachine(req.user, machine.id))) return res.status(403).json({ error: "Machine access denied" });
      machineId = machine.id;
    }

    const assignments = await prisma.activeWelderAssignment.findMany({
      where: { status: "ACTIVE", endedAt: null, ...(machineId ? { machineId } : {}), ...(allowedMachineIds === null || machineId ? {} : { machineId: { in: allowedMachineIds } }) },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      include: { machine: true, welder: true },
    });
    return res.json(assignments.map(formatWelderAssignment));
  } catch (error) {
    return sendInternalError("List active welder assignments error", error, res);
  }
});

// ============================================================================
// 9. API ROUTES: TELEMETRY & IOT INGESTION
// ============================================================================

router.post("/telemetry", async (req, res) => {
  const requestStartedAt = Date.now();
  try {
    const {
      machineId, timestamp, inputVoltage, inputVoltageR, inputVoltageY, inputVoltageB,
      outputVoltage, outputCurrent, currentSetting, fanPulsePerMin,
      temperature, trafoCoreTemperature, transformerCoreTemperature,
      igbtTemperature, heatSyncTemperature, heatSinkTemperature,
      machineOn, arcOn, gpsFix, gpsLat, gpsLng, gpsAltitude, mapUrl,
      alarms, warnings, runningJob, machineLifetime,
    } = req.body;

    const machineIdentifier = parseMachineIdentifier(machineId);
    if (!machineIdentifier) return res.status(400).json({ error: "machineId is required" });

    const parsedTimestamp = parseTimestamp(timestamp);
    const parsedInputVoltageR = parseOptionalNumber(inputVoltageR);
    const parsedInputVoltageY = parseOptionalNumber(inputVoltageY);
    const parsedInputVoltageB = parseOptionalNumber(inputVoltageB);
    const parsedInputVoltage = firstPresentNumber(
      parseOptionalNumber(inputVoltage),
      Math.max(...[parsedInputVoltageR, parsedInputVoltageY, parsedInputVoltageB].filter((value) => value !== null && !Number.isNaN(value)))
    );
    const parsedOutputVoltage = parseOptionalNumber(outputVoltage);
    const parsedOutputCurrent = parseOptionalNumber(outputCurrent);
    const parsedCurrentSetting = parseOptionalNumber(currentSetting);
    const parsedFanPulsePerMin = parseOptionalNumber(fanPulsePerMin);
    const parsedTrafoCoreTemperature = firstPresentNumber(parseOptionalNumber(trafoCoreTemperature), parseOptionalNumber(transformerCoreTemperature));
    const parsedIgbtTemperature = parseOptionalNumber(igbtTemperature);
    const parsedHeatSyncTemperature = firstPresentNumber(parseOptionalNumber(heatSyncTemperature), parseOptionalNumber(heatSinkTemperature));
    const parsedMachineOn = parseOptionalBoolean(machineOn);
    const rawGpsFix = parseOptionalBoolean(gpsFix);
    const parsedGpsLat = parseOptionalNumber(gpsLat);
    const parsedGpsLng = parseOptionalNumber(gpsLng);
    const parsedGpsAltitude = parseOptionalNumber(gpsAltitude);
    const parsedMapUrl = buildMapUrl(parsedGpsLat, parsedGpsLng, parseOptionalString(mapUrl));
    const parsedGpsFix = rawGpsFix ?? (parsedGpsLat !== null && parsedGpsLng !== null ? true : null);
    const parsedTemperature = firstPresentNumber(parseOptionalNumber(temperature), Math.max(...[parsedTrafoCoreTemperature, parsedIgbtTemperature, parsedHeatSyncTemperature].filter((value) => value !== null && !Number.isNaN(value))));
    const parsedArcOn = parseOptionalBoolean(arcOn);

    if (!parsedTimestamp) return res.status(400).json({ error: "Invalid timestamp format" });

    if (Number.isNaN(parsedInputVoltage) || Number.isNaN(parsedInputVoltageR) || Number.isNaN(parsedInputVoltageY) || Number.isNaN(parsedInputVoltageB) || Number.isNaN(parsedOutputVoltage) || Number.isNaN(parsedOutputCurrent) || Number.isNaN(parsedCurrentSetting) || Number.isNaN(parsedFanPulsePerMin) || Number.isNaN(parsedTemperature) || Number.isNaN(parsedTrafoCoreTemperature) || Number.isNaN(parsedIgbtTemperature) || Number.isNaN(parsedHeatSyncTemperature) || Number.isNaN(parsedGpsLat) || Number.isNaN(parsedGpsLng) || Number.isNaN(parsedGpsAltitude)) {
      return res.status(400).json({ error: "Voltage, current, temperature, and GPS coordinate values must be valid numbers" });
    }

    if (machineOn !== undefined && machineOn !== null && machineOn !== "" && parsedMachineOn === null) return res.status(400).json({ error: 'machineOn must be either true, false, "true", or "false"' });
    if (arcOn !== undefined && arcOn !== null && arcOn !== "" && parsedArcOn === null) return res.status(400).json({ error: 'arcOn must be either true, false, "true", or "false"' });
    if (gpsFix !== undefined && gpsFix !== null && gpsFix !== "" && rawGpsFix === null) return res.status(400).json({ error: 'gpsFix must be either true, false, "true", or "false"' });

    const machine = await findMachineByIdentifier(machineIdentifier, { select: { id: true } });
    if (!machine) return res.status(404).json({ error: `Machine with identifier ${machineIdentifier} not found` });

    const telemetry = await prisma.telemetry.create({
      data: {
        machineId: machine.id, timestamp: parsedTimestamp,
        inputVoltage: parsedInputVoltage, inputVoltageR: parsedInputVoltageR, inputVoltageY: parsedInputVoltageY, inputVoltageB: parsedInputVoltageB,
        outputVoltage: parsedOutputVoltage, outputCurrent: parsedOutputCurrent, currentSetting: parsedCurrentSetting, fanPulsePerMin: parsedFanPulsePerMin,
        temperature: parsedTemperature, trafoCoreTemperature: parsedTrafoCoreTemperature, igbtTemperature: parsedIgbtTemperature, heatSyncTemperature: parsedHeatSyncTemperature,
        machineOn: parsedMachineOn, arcOn: parsedArcOn,
        gpsFix: parsedGpsFix, gpsLat: parsedGpsLat, gpsLng: parsedGpsLng, gpsAltitude: parsedGpsAltitude, mapUrl: parsedMapUrl,
        ...(alarms !== undefined && alarms !== null ? { alarms } : {}),
        ...(warnings !== undefined && warnings !== null ? { warnings } : {}),
        ...(runningJob !== undefined && runningJob !== null ? { runningJob } : {}),
        ...(machineLifetime !== undefined && machineLifetime !== null ? { machineLifetime } : {}),
      },
    });

    await updateActiveWelderSessionFromTelemetry(telemetry);
    await processTelemetryForProduction(telemetry);

    return res.json({
      message: "Telemetry inserted successfully",
      telemetry,
      alert: deriveTelemetryTemperature(telemetry) !== null && deriveTelemetryTemperature(telemetry) > 80 ? "OVERHEAT ALERT" : null,
    });
  } catch (error) {
    return sendPrismaWriteError("Telemetry insert error", error, res);
  }
});

// ============================================================================
// 10. API ROUTES: MACHINE STATUS & OVERVIEW
// ============================================================================

router.get("/machine/:id/overview", async (req, res) => {
  try {
    const machineIdentifier = parseMachineIdentifier(req.params.id);
    if (!machineIdentifier) return res.status(400).json({ error: "Machine identifier is required" });

    const machine = await findMachineByIdentifier(machineIdentifier, { select: { id: true, machineCode: true, serialNumber: true, location: true } });
    if (!machine) return res.status(404).json({ error: `Machine with identifier ${machineIdentifier} not found` });

    const accessUser = await getAccessUser(req);
    if (isCustomerForbiddenForMachine(accessUser, machine.id)) return sendForbiddenMachineAccess(res);
    if (!(await canAccessMachine(req.user, machine.id))) return res.status(403).json({ error: "Machine access denied" });

    const [telemetry, historyRaw, activeSession, activeAssignment] = await Promise.all([
      prisma.machineLatestTelemetry.findUnique({ where: { machineId: machine.id } }),
      prisma.telemetry.findMany({ where: { machineId: machine.id }, orderBy: [{ timestamp: "desc" }, { id: "desc" }], take: 20 }),
      findActiveWelderSession(machine.id),
      findActiveWelderAssignment(machine.id),
    ]);
    const activeWelder = activeSession?.welder
      ? { id: activeSession.welder.id, name: activeSession.welder.name, employeeCode: activeSession.welder.employeeCode, rfidCardNo: activeSession.welder.rfidCardNo }
      : activeAssignment
        ? { id: activeAssignment.welder?.id || null, name: activeAssignment.welderName || activeAssignment.welder?.name || "Unknown", employeeCode: activeAssignment.employeeCode || activeAssignment.welder?.employeeCode || null, rfidCardNo: activeAssignment.rfidCardNo || activeAssignment.welder?.rfidCardNo || null }
        : null;

    if (!telemetry) {
      return res.json({
        ...buildEmptyOverview(machine),
        activeWelderSession: formatWelderSession(activeSession),
        activeWelder,
      });
    }

    const status = getMachineStatus(telemetry);
    const secondsSinceLastTelemetry = getSecondsSinceLastTelemetry(telemetry);
    const lastUpdatedAt = getTelemetryTime(telemetry);
    const isFresh = status !== "OFFLINE" && telemetry.machineOn;
    const isWelding = status === "WELDING";
    const controls = getMachineControls(machine.id);
    const { health, alarms, warnings } = isFresh ? buildHealthState(telemetry) : buildHealthState(null);

    const trend = isFresh
      ? historyRaw.slice().reverse().map((item) => {
          const sampleIsWelding = item.arcOn === true || Number(item.outputCurrent) > 20;
          return {
            time: item.timestamp || item.createdAt,
            current: sampleIsWelding ? Math.min(Math.max(item.outputCurrent || 0, 0), 400) : 0,
            voltage: sampleIsWelding ? Math.min(Math.max(item.outputVoltage || 0, 0), 100) : 0,
          };
        })
      : [];

    const overviewTemperature = isFresh ? deriveTelemetryTemperature(telemetry) : null;
    const temperatures = isFresh ? getTelemetryTemperatures(telemetry) : getTelemetryTemperatures(null);
    const gps = getTelemetryGps(telemetry);

    return res.json({
      machineId: machine.id, machineCode: machine.machineCode, serialNumber: machine.serialNumber || "", location: machine.location || "Shop Floor",
      status, health, healthLabel: getHealthLabel(health), alarmCount: alarms.length, warningCount: warnings.length,
      lastUpdatedAt, secondsSinceLastTelemetry,
      outputCurrent: isWelding ? Math.min(Math.max(telemetry.outputCurrent || 0, 0), 400) : 0,
      temperature: overviewTemperature, trafoCoreTemperature: temperatures.trafoCore, igbtTemperature: temperatures.igbt, heatSyncTemperature: temperatures.heatSync,
      ...gps,
      weldingCurrent: isWelding ? Math.min(Math.max(telemetry.outputCurrent || 0, 0), 400) : 0,
      weldingVoltage: isWelding ? Math.min(Math.max(telemetry.outputVoltage || 0, 0), 100) : 0,
      currentSetting: telemetry.currentSetting ?? controls.currentSetting,
      fanSpeed: telemetry.fanPulsePerMin ?? 0,
      inputVoltage: {
        R: isFresh ? Math.min(Math.max(telemetry.inputVoltageR ?? telemetry.inputVoltage ?? 0, 0), 500) : 0,
        Y: isFresh ? Math.min(Math.max(telemetry.inputVoltageY ?? telemetry.inputVoltage ?? 0, 0), 500) : 0,
        B: isFresh ? Math.min(Math.max(telemetry.inputVoltageB ?? telemetry.inputVoltage ?? 0, 0), 500) : 0,
      },
      inputLineVoltage: {
        RY: isFresh ? Math.min(Math.max(telemetry.inputVoltageR ?? 0, 0), 500) : 0,
        YB: isFresh ? Math.min(Math.max(telemetry.inputVoltageY ?? 0, 0), 500) : 0,
        BR: isFresh ? Math.min(Math.max(telemetry.inputVoltageB ?? 0, 0), 500) : 0,
      },
      deviceAlarms: telemetry.alarms ?? null,
      deviceWarnings: telemetry.warnings ?? null,
      temperatures, alarms, warnings, trend,
      runningJob: telemetry.runningJob || { arcTime: "0:0:0", idleTime: "0:0:0", dcEnergy: 0, deposition: 0, wireFeedMeter: 0, arcCount: 0 },
      lifetime: telemetry.machineLifetime || { arcTime: "0:0:0", idleTime: "0:0:0", dcEnergy: 0, deposition: 0, wireFeedMeter: 0, arcCount: 0 },
      activeWelderSession: formatWelderSession(activeSession),
      activeWelder,
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
        id: true, machineCode: true, serialNumber: true, location: true,
        latestTelemetry: { select: { arcOn: true, timestamp: true, inputVoltage: true, outputVoltage: true, outputCurrent: true, temperature: true, trafoCoreTemperature: true, igbtTemperature: true, heatSyncTemperature: true, machineOn: true, gpsFix: true, gpsLat: true, gpsLng: true, gpsAltitude: true, mapUrl: true } },
        welderSessions: { where: { status: "ACTIVE", endedAt: null }, orderBy: { startedAt: "desc" }, take: 1, include: { welder: true, machine: { include: { telemetry: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 } } } } },
        activeWelderAssignments: { where: { status: "ACTIVE", endedAt: null }, orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: 1, include: { welder: true } },
      },
    });

    const result = machines.map((machine) => {
      const latest = machine.latestTelemetry || null;
      const activeSession = machine.welderSessions[0] || null;
      const activeAssignment = machine.activeWelderAssignments[0] || null;
      const welderName = activeSession?.welder?.name || activeAssignment?.welderName || activeAssignment?.welder?.name || "Unknown";
      const status = getMachineStatus(latest);
      const hasLiveReadings = status === "IDLE" || status === "WELDING";
      const isWelding = status === "WELDING";
      const temperature = deriveTelemetryTemperature(latest);
      const gps = getTelemetryGps(latest);

      if (status === "OFFLINE") {
        return { ...buildOfflineFleetMachine(machine, latest), welder: welderName, activeWelderSession: formatWelderSession(activeSession) };
      }

      const { health, alarms, warnings } = hasLiveReadings
        ? buildHealthState(latest)
        : buildHealthState(null);
      return {
        id: machine.id, machineId: machine.id, code: machine.machineCode, machineCode: machine.machineCode, serialNumber: machine.serialNumber || "", location: machine.location || "Shop Floor",
        status, health, healthLabel: getHealthLabel(health), isLive: true,
        lastSeen: getTelemetryTime(latest), lastUpdatedAt: getTelemetryTime(latest), secondsSinceLastTelemetry: getSecondsSinceLastTelemetry(latest),
        current: isWelding ? latest?.outputCurrent || 0 : 0, outputCurrent: isWelding ? latest?.outputCurrent || 0 : 0,
        voltage: isWelding ? latest?.outputVoltage || 0 : 0, outputVoltage: isWelding ? latest?.outputVoltage || 0 : 0,
        temperature: hasLiveReadings ? temperature : null,
        trafoCoreTemperature: hasLiveReadings ? latest?.trafoCoreTemperature ?? temperature : null,
        igbtTemperature: hasLiveReadings ? latest?.igbtTemperature ?? temperature : null,
        heatSyncTemperature: hasLiveReadings ? latest?.heatSyncTemperature ?? temperature : null,
        ...gps, warningCount: warnings.length, alarmCount: alarms.length, warnings, alarms,
        welder: welderName, activeWelderSession: formatWelderSession(activeSession),
      };
    }).sort((a, b) => Number(b.isLive) - Number(a.isLive) || a.machineCode.localeCompare(b.machineCode));

    setFleetSummaryHeaders(res, buildFleetSummary(result));
    return res.json(result);
  } catch (error) {
    return sendInternalError("Fleet overview error", error, res);
  }
});

// ============================================================================
// 11. API ROUTES: COMMANDS & SETPOINTS
// ============================================================================

router.post("/machine/:id/set-current", async (req, res) => {
  try {
    const machineIdentifier = parseMachineIdentifier(req.params.id);
    if (!machineIdentifier) return res.status(400).json({ error: "Machine identifier is required" });

    const machine = await findMachineByIdentifier(machineIdentifier, { select: { id: true, machineCode: true } });
    if (!machine) return res.status(404).json({ error: `Machine with identifier ${machineIdentifier} not found` });

    const rawCurrentSetting = req.body.currentSetting ?? req.body.current ?? req.body.value ?? 0;
    const parsedCurrentSetting = parseOptionalNumber(rawCurrentSetting);

    if (parsedCurrentSetting === null || Number.isNaN(parsedCurrentSetting) || parsedCurrentSetting < 0) {
      return res.status(400).json({ error: "currentSetting must be a valid non-negative number" });
    }

    const controls = setMachineControls(machine.id, { currentSetting: parsedCurrentSetting });
    return res.json({ message: "Current setting updated", machineId: machine.id, machineCode: machine.machineCode, currentSetting: controls.currentSetting });
  } catch (error) {
    return sendInternalError("Set current error", error, res);
  }
});

router.post("/machine/:id/rfid/assign", async (req, res) => {
  try {
    const machineIdentifier = parseMachineIdentifier(req.params.id);
    const rfidCardNo = parseRequiredText(req.body.rfidCardNo ?? req.body.rfid ?? req.body.cardNo);

    if (!machineIdentifier) return res.status(400).json({ error: "Machine identifier is required" });
    if (!rfidCardNo) return res.status(400).json({ error: "rfidCardNo is required" });

    const machine = await findMachineByIdentifier(machineIdentifier, { select: { id: true, machineCode: true, serialNumber: true, location: true } });
    if (!machine) return res.status(404).json({ error: `Machine with identifier ${machineIdentifier} not found` });

    const welder = await prisma.welder.findUnique({ where: { rfidCardNo } });
    if (!welder || !welder.active) return res.status(404).json({ error: `Active welder with RFID ${rfidCardNo} not found` });

    const now = new Date();
    const session = await prisma.$transaction(async (tx) => {
      await tx.welderSession.updateMany({ where: { status: "ACTIVE", endedAt: null, OR: [{ welderId: welder.id }, { machineId: machine.id }] }, data: { status: "CLOSED", endedAt: now } });
      return tx.welderSession.create({ data: { welderId: welder.id, machineId: machine.id, rfidCardNo, startedAt: now, lastTelemetryAt: now }, include: { welder: true, machine: { include: { telemetry: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 } } } } });
    });

    return res.json({ message: "RFID assigned successfully", session: formatWelderSession(session) });
  } catch (error) {
    return sendPrismaWriteError("RFID assign error", error, res);
  }
});

router.post("/machine/:id/rfid/clear", async (req, res) => {
  try {
    const machineIdentifier = parseMachineIdentifier(req.params.id);
    if (!machineIdentifier) return res.status(400).json({ error: "Machine identifier is required" });

    const machine = await findMachineByIdentifier(machineIdentifier, { select: { id: true, machineCode: true } });
    if (!machine) return res.status(404).json({ error: `Machine with identifier ${machineIdentifier} not found` });

    const result = await closeActiveWelderSessions({ machineId: machine.id });
    return res.json({ message: "RFID session cleared successfully", machineId: machine.id, machineCode: machine.machineCode, closedSessions: result.count });
  } catch (error) {
    return sendPrismaWriteError("RFID clear error", error, res);
  }
});

router.get("/machine/:id/rfid/active", async (req, res) => {
  try {
    const machineIdentifier = parseMachineIdentifier(req.params.id);
    if (!machineIdentifier) return res.status(400).json({ error: "Machine identifier is required" });

    const machine = await findMachineByIdentifier(machineIdentifier, { select: { id: true } });
    if (!machine) return res.status(404).json({ error: `Machine with identifier ${machineIdentifier} not found` });

    const session = await findActiveWelderSession(machine.id);
    return res.json({ active: Boolean(session), session: formatWelderSessionForUser(session, req.user) });
  } catch (error) {
    return sendInternalError("Get active RFID session error", error, res);
  }
});

router.get("/machine/:id/engineering/setpoints", async (req, res) => {
  try {
    const machineIdentifier = parseMachineIdentifier(req.params.id);
    if (!machineIdentifier) return res.status(400).json({ error: "Machine identifier is required" });

    const machine = await findMachineByIdentifier(machineIdentifier, { select: { id: true, machineCode: true } });
    if (!machine) return res.status(404).json({ error: `Machine with identifier ${machineIdentifier} not found` });
    if (!(await canAccessMachine(req.user, machine.id))) return res.status(403).json({ error: "Machine access denied" });

    return res.json({ machineId: machine.id, machineCode: machine.machineCode, setpoints: getMachineEngineeringSetpoints(machine.id) });
  } catch (error) {
    return sendInternalError("Get engineering setpoints error", error, res);
  }
});

router.post("/machine/:id/engineering/setpoints", async (req, res) => {
  try {
    const machineIdentifier = parseMachineIdentifier(req.params.id);
    if (!machineIdentifier) return res.status(400).json({ error: "Machine identifier is required" });

    const machine = await findMachineByIdentifier(machineIdentifier, { select: { id: true, machineCode: true } });
    if (!machine) return res.status(404).json({ error: `Machine with identifier ${machineIdentifier} not found` });
    if (!(await canAccessMachine(req.user, machine.id))) return res.status(403).json({ error: "Machine access denied" });

    const setpoints = setMachineEngineeringSetpoints(machine.id, req.body || {});
    return res.json({ message: "Engineering setpoints saved", machineId: machine.id, machineCode: machine.machineCode, setpoints });
  } catch (error) {
    return sendInternalError("Save engineering setpoints error", error, res);
  }
});

router.post("/machine/:id/engineering/read-all", async (req, res) => {
  try {
    const machineIdentifier = parseMachineIdentifier(req.params.id);
    if (!machineIdentifier) return res.status(400).json({ error: "Machine identifier is required" });

    const machine = await findMachineByIdentifier(machineIdentifier, { select: { id: true, machineCode: true } });
    if (!machine) return res.status(404).json({ error: `Machine with identifier ${machineIdentifier} not found` });
    if (!(await canAccessMachine(req.user, machine.id))) return res.status(403).json({ error: "Machine access denied" });

    return res.json({ message: "Read all setpoints requested", machineId: machine.id, machineCode: machine.machineCode, setpoints: getMachineEngineeringSetpoints(machine.id), note: "MQTT device command will be added in next phase." });
  } catch (error) {
    return sendInternalError("Read engineering setpoints error", error, res);
  }
});

// ============================================================================
// 12. API ROUTES: REPORTS & TIMELINES
// ============================================================================

router.get("/reports/live-welder-sessions", async (req, res) => {
  try {
    const allowedMachineIds = await getAccessibleMachineIds(req.user);
    const machineFilter = allowedMachineIds === null ? {} : { machineId: { in: allowedMachineIds } };
    const [sessions, assignments] = await Promise.all([
      prisma.welderSession.findMany({
        where: { status: "ACTIVE", endedAt: null, ...machineFilter },
        orderBy: { startedAt: "desc" },
        include: { welder: true, machine: { include: { latestTelemetry: true } } },
      }),
      prisma.activeWelderAssignment.findMany({
        where: { status: "ACTIVE", endedAt: null, ...machineFilter },
        orderBy: { startedAt: "desc" },
        include: {
          welder: true,
          machine: { include: { latestTelemetry: true } },
          arcEvents: { select: { startTime: true, endTime: true, durationSeconds: true } },
        },
      }),
    ]);
    const liveAssignments = assignments.map((assignment) =>
      formatLiveWelderAssignmentForUser(assignment, req.user)
    );
    return res.json([
      ...formatWelderSessionsForUser(sessions, req.user),
      ...liveAssignments,
    ].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)));
  } catch (error) {
    return sendInternalError("Live welder session report error", error, res);
  }
});

router.get("/machine/:id/production/daily", async (req, res) => {
  try {
    const machineIdentifier = parseMachineIdentifier(req.params.id);
    if (!machineIdentifier) return res.status(400).json({ error: "Machine identifier is required" });

    const productionDate = parseProductionDate(req.query.date);
    if (!productionDate) return res.status(400).json({ error: "date query parameter must use YYYY-MM-DD" });

    const machine = await findMachineByIdentifier(machineIdentifier, { select: { id: true, machineCode: true } });
    if (!machine) return res.status(404).json({ error: `Machine with identifier ${machineIdentifier} not found` });

    const accessUser = await getAccessUser(req);
    if (isCustomerForbiddenForMachine(accessUser, machine.id)) return sendForbiddenMachineAccess(res);
    if (!(await canAccessMachine(req.user, machine.id))) return res.status(403).json({ error: "Machine access denied" });

    const summary = await getDailyProductionSummary(machine.id, productionDate);
    return res.json({ ...summary, machineCode: machine.machineCode });
  } catch (error) {
    return sendInternalError("Daily production summary error", error, res);
  }
});

router.get("/machine/:id/production/timeline", async (req, res) => {
  try {
    const machineIdentifier = parseMachineIdentifier(req.params.id);
    if (!machineIdentifier) return res.status(400).json({ error: "Machine identifier is required" });

    const productionDate = parseProductionDate(req.query.date);
    if (!productionDate) return res.status(400).json({ error: "date query parameter must use YYYY-MM-DD" });

    const machine = await findMachineByIdentifier(machineIdentifier, { select: { id: true } });
    if (!machine) return res.status(404).json({ error: `Machine with identifier ${machineIdentifier} not found` });

    const accessUser = await getAccessUser(req);
    if (isCustomerForbiddenForMachine(accessUser, machine.id)) return sendForbiddenMachineAccess(res);
    if (!(await canAccessMachine(req.user, machine.id))) return res.status(403).json({ error: "Machine access denied" });

    const events = await getProductionTimeline(machine.id, productionDate);
    return res.json(events);
  } catch (error) {
    return sendInternalError("Production timeline error", error, res);
  }
});

function escapeCsvValue(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

async function getWelderArcEventsForReport(req) {
  const machineIdentifier = parseMachineIdentifier(req.query.machineId);
  const reportDate = req.query.date ? parseProductionDate(req.query.date) : null;
  const from = parseOptionalDate(req.query.from);
  const to = parseOptionalDate(req.query.to);
  const allowedMachineIds = await getAccessibleMachineIds(req.user);
  let machineId = null;

  if (req.query.date && !reportDate) {
    const error = new Error("date query parameter must use YYYY-MM-DD");
    error.statusCode = 400;
    throw error;
  }

  if (machineIdentifier) {
    const machine = await findMachineByIdentifier(machineIdentifier, { select: { id: true } });
    if (!machine) {
      const error = new Error(`Machine with identifier ${machineIdentifier} not found`);
      error.statusCode = 404;
      throw error;
    }
    if (!(await canAccessMachine(req.user, machine.id))) {
      const error = new Error("Machine access denied");
      error.statusCode = 403;
      throw error;
    }
    machineId = machine.id;
  }

  const dateRange = reportDate
    ? { gte: reportDate, lt: new Date(reportDate.getTime() + 24 * 60 * 60 * 1000) }
    : { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };

  return prisma.welderArcEvent.findMany({
    where: {
      ...(machineId ? { machineId } : {}),
      ...(allowedMachineIds === null || machineId ? {} : { machineId: { in: allowedMachineIds } }),
      ...(Object.keys(dateRange).length ? { startTime: dateRange } : {}),
    },
    orderBy: [{ startTime: "desc" }, { id: "desc" }],
    take: 1000,
    include: { machine: true, welder: true },
  });
}

async function sendWelderArcEventsCsv(req, res) {
  if (!requireAuthenticated(req, res)) return;

  try {
    const events = await getWelderArcEventsForReport(req);
    const rows = [
      ["Machine", "Serial Number", "Welder", "Arc Start", "Arc End", "Duration Seconds", "Average Current", "Average Voltage", "Quality"],
      ...events.map((event) => [
        event.machine?.machineCode || event.machineId,
        event.machine?.serialNumber || "",
        event.welderName || event.welder?.name || "UNKNOWN",
        event.startTime.toISOString(),
        event.endTime?.toISOString() || "",
        event.durationSeconds ?? Math.max(0, Math.floor((Date.now() - event.startTime.getTime()) / 1000)),
        event.avgCurrent ?? event.startOutputCurrent ?? 0,
        event.avgVoltage ?? event.startOutputVoltage ?? 0,
        event.qualityStatus || (event.endTime ? "UNKNOWN" : "ACTIVE"),
      ]),
    ];

    const reportDate = req.query.date || new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="welder-arc-report-${reportDate}.csv"`
    );
    return res.send(rows.map((row) => row.map(escapeCsvValue).join(",")).join("\n"));
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    return sendInternalError("Welder arc CSV report error", error, res);
  }
}

async function sendWelderArcEventsPdf(req, res) {
  if (!requireAuthenticated(req, res)) return;

  try {
    const events = await getWelderArcEventsForReport(req);
    const document = new PDFDocument({ margin: 40, size: "A4" });
    const reportDate = req.query.date || new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="welder-arc-report-${reportDate}.pdf"`
    );
    document.pipe(res);
    document.fontSize(18).text("Welder Arc Events Report");
    document.moveDown(0.5);
    document.fontSize(10).text(`Date: ${req.query.date || "All available dates"}`);
    document.moveDown();

    if (!events.length) {
      document.text("No arc events found.");
    } else {
      for (const event of events) {
        const durationSeconds = event.durationSeconds ??
          Math.max(0, Math.floor((Date.now() - event.startTime.getTime()) / 1000));
        document
          .fontSize(10)
          .text(
            `${event.machine?.machineCode || event.machineId} | ` +
            `${event.welderName || event.welder?.name || "UNKNOWN"} | ` +
            `${event.startTime.toISOString()} | ${durationSeconds}s | ` +
            `${event.avgCurrent ?? event.startOutputCurrent ?? 0}A | ` +
            `${event.avgVoltage ?? event.startOutputVoltage ?? 0}V`
          );
        document.moveDown(0.4);
      }
    }

    document.end();
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    return sendInternalError("Welder arc PDF report error", error, res);
  }
}

router.get("/reports/welder-arc-events.csv", sendWelderArcEventsCsv);
router.get("/reports/welder-arc-events.pdf", sendWelderArcEventsPdf);
router.get("/welder-arc-events.csv", sendWelderArcEventsCsv);

router.get("/welder-arc-events", async (req, res) => {
  if (!requireAuthenticated(req, res)) return;
  try {
    const machineIdentifier = parseMachineIdentifier(req.query.machineId);
    const from = parseOptionalDate(req.query.from);
    const to = parseOptionalDate(req.query.to);
    const limit = Math.min(parseMachineId(req.query.limit) || 100, 500);
    const allowedMachineIds = await getAccessibleMachineIds(req.user);
    let machineId = null;

    if (machineIdentifier) {
      const machine = await findMachineByIdentifier(machineIdentifier, { select: { id: true } });
      if (!machine) return res.status(404).json({ error: `Machine with identifier ${machineIdentifier} not found` });
      if (!(await canAccessMachine(req.user, machine.id))) return res.status(403).json({ error: "Machine access denied" });
      machineId = machine.id;
    }

    const events = await prisma.welderArcEvent.findMany({
      where: {
        ...(machineId ? { machineId } : {}),
        ...(allowedMachineIds === null || machineId ? {} : { machineId: { in: allowedMachineIds } }),
        ...(from || to ? { startTime: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      orderBy: [{ startTime: "desc" }, { id: "desc" }],
      take: limit,
      include: { machine: true, welder: true },
    });
    return res.json(events.map(formatWelderArcEvent));
  } catch (error) {
    return sendInternalError("List welder arc events error", error, res);
  }
});

// Reset logic
function resetJobData(req, res) { return handleMachineReset(req, res); }
function resetMachineData(req, res) { return handleMachineReset(req, res, { clearHistory: true }); }
function resetByScope(req, res) {
  const scope = String(req.body.scope || req.query.scope || "job").toLowerCase();
  return handleMachineReset(req, res, { clearHistory: scope === "machine" || scope === "all" });
}

async function handleMachineReset(req, res, options = {}) {
  try {
    const machineIdentifier = parseMachineIdentifier(req.params.id);
    if (!machineIdentifier) return res.status(400).json({ error: "Machine identifier is required" });

    const machine = await findMachineByIdentifier(machineIdentifier, { select: { id: true, machineCode: true } });
    if (!machine) return res.status(404).json({ error: `Machine with identifier ${machineIdentifier} not found` });

    const telemetry = await resetMachineTelemetry(machine, options);
    return res.json({ message: options.clearHistory ? "Machine data reset successfully" : "Job data reset successfully", machineId: machine.id, machineCode: machine.machineCode, currentSetting: DEFAULT_CURRENT_SETTING, telemetry });
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

// Exports
module.exports = router;
