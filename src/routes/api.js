const express = require("express");

const prisma = require("../db");

const router = express.Router();

const TELEMETRY_FRESHNESS_SECONDS = 60;
const DEFAULT_CURRENT_SETTING = 0;
const machineControlState = new Map();

function parseMachineId(rawId) {
  const machineId = Number.parseInt(rawId, 10);

  return Number.isInteger(machineId) && machineId > 0 ? machineId : null;
}

function parseMachineIdentifier(rawId) {
  if (rawId === undefined || rawId === null) {
    return null;
  }

  const machineIdentifier = String(rawId).trim();

  return machineIdentifier || null;
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

  if (!telemetry) {
    return {
      health: "GREY",
      alarms,
      warnings,
    };
  }

  if ((telemetry.temperature || 0) > 80) alarms.push("OVERHEAT");
  if ((telemetry.inputVoltage || 0) > 450) alarms.push("HIGH_VOLTAGE");
  if ((telemetry.outputCurrent || 0) > 350) alarms.push("OVER_CURRENT");

  if (
    (telemetry.temperature || 0) > 70 &&
    (telemetry.temperature || 0) <= 80
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
    warningCount: 0,
    alarmCount: 0,
    warnings: [],
    alarms: [],
    welder: "Unknown",
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

router.post("/telemetry", async (req, res) => {
  try {
    const {
      machineId,
      timestamp,
      inputVoltage,
      outputVoltage,
      outputCurrent,
      temperature,
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
    const parsedTemperature = parseOptionalNumber(temperature);
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
      Number.isNaN(parsedTemperature)
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
        arcOn: parsedArcOn,
      },
    });

    return res.json({
      message: "Telemetry inserted successfully",
      telemetry,
      alert:
        telemetry.temperature !== null && telemetry.temperature > 80
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

    const [telemetry, historyRaw] = await Promise.all([
      prisma.telemetry.findFirst({
        where: { machineId: machine.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
      prisma.telemetry.findMany({
        where: { machineId: machine.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 20,
      }),
    ]);

    if (!telemetry) {
      return res.json(buildEmptyOverview(machine));
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
      temperature: isFresh ? telemetry.temperature || 0 : null,
      weldingCurrent: isFresh ? telemetry.outputCurrent || 0 : 0,
      weldingVoltage: isFresh ? telemetry.outputVoltage || 0 : 0,
      currentSetting: controls.currentSetting,
      fanSpeed: 0,
      inputVoltage: {
        R: isFresh ? telemetry.inputVoltage || 0 : 0,
        Y: isFresh ? telemetry.inputVoltage || 0 : 0,
        B: isFresh ? telemetry.inputVoltage || 0 : 0,
      },
      temperatures: {
        trafoCore: isFresh ? telemetry.temperature || 0 : null,
        igbt: isFresh ? telemetry.temperature || 0 : null,
        heatSync: isFresh ? telemetry.temperature || 0 : null,
      },
      alarms,
      warnings,
      trend,
    });
  } catch (error) {
    return sendInternalError("Machine overview error", error, res);
  }
});

router.get("/machines/overview", async (req, res) => {
  try {
    const machines = await prisma.machine.findMany({
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
          },
        },
      },
    });

    const result = machines.map((machine) => {
      const latest = machine.telemetry[0] || null;
      const status = getMachineStatus(latest);

      if (status === "OFFLINE") {
        return buildOfflineFleetMachine(machine, latest);
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
        temperature: latest?.temperature || 0,
        warningCount: warnings.length,
        alarmCount: alarms.length,
        warnings,
        alarms,
        welder: "Unknown",
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
