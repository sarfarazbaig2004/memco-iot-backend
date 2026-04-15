const express = require("express");

const prisma = require("../db");

const router = express.Router();

function parseMachineId(rawId) {
  const machineId = Number.parseInt(rawId, 10);

  return Number.isInteger(machineId) && machineId > 0 ? machineId : null;
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

function buildMachineStatus(telemetry) {
  if (!telemetry) {
    return "OFF";
  }

  if (telemetry.arcOn === true && (telemetry.outputCurrent || 0) > 50) {
    return "WELDING";
  }

  if ((telemetry.inputVoltage || 0) > 100) {
    return "IDLE";
  }

  return "OFF";
}

function buildHealthState(telemetry) {
  const alarms = [];
  const warnings = [];

  if (!telemetry) {
    return {
      health: "GREEN",
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

function buildEmptyOverview(machine) {
  return {
    machineId: machine.id,
    machineCode: machine.machineCode,
    serialNumber: machine.serialNumber || "",
    location: machine.location || "Shop Floor",
    status: "OFF",
    health: "GREEN",
    alarmCount: 0,
    warningCount: 0,
    lastUpdatedAt: null,
    weldingCurrent: 0,
    weldingVoltage: 0,
    currentSetting: 400,
    fanSpeed: 0,
    inputVoltage: {
      R: 0,
      Y: 0,
      B: 0,
    },
    temperature: {
      trafoCore: 0,
      igbt: 0,
      heatSync: 0,
    },
    alarms: [],
    warnings: [],
    trend: [],
  };
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

    const parsedMachineId = parseMachineId(machineId);

    if (!parsedMachineId) {
      return res.status(400).json({
        error: "machineId must be a positive integer",
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

    const machine = await prisma.machine.findUnique({
      where: { id: parsedMachineId },
      select: { id: true },
    });

    if (!machine) {
      return res.status(404).json({
        error: `Machine with id ${parsedMachineId} not found`,
      });
    }

    const telemetry = await prisma.telemetry.create({
      data: {
        machineId: parsedMachineId,
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
    const machineId = parseMachineId(req.params.id);

    if (!machineId) {
      return res.status(400).json({
        error: "Machine id must be a positive integer",
      });
    }

    const machine = await prisma.machine.findUnique({
      where: { id: machineId },
      include: {
        company: true,
        telemetry: {
          orderBy: [{ timestamp: "desc" }, { id: "desc" }],
        },
      },
    });

    if (!machine) {
      return res.status(404).json({
        error: "Machine not found",
      });
    }

    return res.json(machine);
  } catch (error) {
    return sendInternalError("Get machine error", error, res);
  }
});

router.get("/machine/:id/latest", async (req, res) => {
  try {
    const machineId = parseMachineId(req.params.id);

    if (!machineId) {
      return res.status(400).json({
        error: "Machine id must be a positive integer",
      });
    }

    const latestTelemetry = await prisma.telemetry.findFirst({
      where: { machineId },
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
    const machineId = parseMachineId(req.params.id);

    if (!machineId) {
      return res.status(400).json({
        error: "Machine id must be a positive integer",
      });
    }

    const [machine, telemetry, historyRaw] = await Promise.all([
      prisma.machine.findUnique({
        where: { id: machineId },
        select: {
          id: true,
          machineCode: true,
          serialNumber: true,
          location: true,
        },
      }),
      prisma.telemetry.findFirst({
        where: { machineId },
        orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      }),
      prisma.telemetry.findMany({
        where: { machineId },
        orderBy: [{ timestamp: "desc" }, { id: "desc" }],
        take: 20,
      }),
    ]);

    if (!machine) {
      return res.status(404).json({
        error: "Machine not found",
      });
    }

    if (!telemetry) {
      return res.json(buildEmptyOverview(machine));
    }

    const { health, alarms, warnings } = buildHealthState(telemetry);
    const status = buildMachineStatus(telemetry);
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
      alarmCount: alarms.length,
      warningCount: warnings.length,
      lastUpdatedAt: telemetry.timestamp || telemetry.createdAt,
      weldingCurrent: telemetry.outputCurrent || 0,
      weldingVoltage: telemetry.outputVoltage || 0,
      currentSetting: 400,
      fanSpeed: 0,
      inputVoltage: {
        R: telemetry.inputVoltage || 0,
        Y: telemetry.inputVoltage || 0,
        B: telemetry.inputVoltage || 0,
      },
      temperature: {
        trafoCore: telemetry.temperature || 0,
        igbt: telemetry.temperature || 0,
        heatSync: telemetry.temperature || 0,
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
          orderBy: [{ timestamp: "desc" }, { id: "desc" }],
          take: 1,
          select: {
            arcOn: true,
            inputVoltage: true,
            outputCurrent: true,
            temperature: true,
          },
        },
      },
    });

    const result = machines.map((machine) => {
      const latest = machine.telemetry[0] || null;
      const { health } = buildHealthState(latest);

      return {
        id: machine.id,
        code: machine.machineCode,
        serialNumber: machine.serialNumber || "",
        location: machine.location || "Shop Floor",
        status: buildMachineStatus(latest),
        health,
        current: latest?.outputCurrent || 0,
        temperature: latest?.temperature || 0,
        welder: "Unknown",
      };
    });

    return res.json(result);
  } catch (error) {
    return sendInternalError("Fleet overview error", error, res);
  }
});

module.exports = router;
