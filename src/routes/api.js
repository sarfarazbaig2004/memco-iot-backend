const express = require("express");
const router = express.Router();
const prisma = require("../db");

// Create Company
router.post("/company", async (req, res) => {
  try {
    const { name, code, email, mobile } = req.body;

    if (!name || !code) {
      return res.status(400).json({
        error: "name and code are required",
      });
    }

    const data = await prisma.company.create({
      data: {
        name,
        code,
        email: email || null,
        mobile: mobile || null,
      },
    });

    res.json(data);
  } catch (error) {
    console.error("Create company error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Create Machine
router.post("/machine", async (req, res) => {
  try {
    const { companyId, machineCode, model, machineType, location, status } =
      req.body;

    if (!companyId || !machineCode || !model || !machineType) {
      return res.status(400).json({
        error: "companyId, machineCode, model, and machineType are required",
      });
    }

    const company = await prisma.company.findUnique({
      where: { id: Number(companyId) },
    });

    if (!company) {
      return res.status(404).json({
        error: `Company with id ${companyId} not found`,
      });
    }

    const data = await prisma.machine.create({
      data: {
        companyId: Number(companyId),
        machineCode,
        model,
        machineType,
        location: location || null,
        status: status || "ACTIVE",
      },
    });

    res.json(data);
  } catch (error) {
    console.error("Create machine error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Insert Telemetry
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

    if (!machineId) {
      return res.status(400).json({
        error: "machineId is required",
      });
    }

    const machine = await prisma.machine.findUnique({
      where: { id: Number(machineId) },
    });

    if (!machine) {
      return res.status(404).json({
        error: `Machine with id ${machineId} not found`,
      });
    }

    const payload = {
      machineId: Number(machineId),
      timestamp: timestamp ? new Date(timestamp) : new Date(),
      inputVoltage:
        inputVoltage !== undefined && inputVoltage !== null
          ? Number(inputVoltage)
          : null,
      outputVoltage:
        outputVoltage !== undefined && outputVoltage !== null
          ? Number(outputVoltage)
          : null,
      outputCurrent:
        outputCurrent !== undefined && outputCurrent !== null
          ? Number(outputCurrent)
          : null,
      temperature:
        temperature !== undefined && temperature !== null
          ? Number(temperature)
          : null,
      arcOn: arcOn !== undefined ? Boolean(arcOn) : null,
    };

    if (Number.isNaN(payload.timestamp.getTime())) {
      return res.status(400).json({
        error: "Invalid timestamp format",
      });
    }

    const data = await prisma.telemetry.create({
      data: payload,
    });

    let alert = null;

    if (data.temperature !== null && data.temperature > 80) {
      alert = "OVERHEAT ALERT";
    }

    res.json({
      message: "Telemetry inserted successfully",
      telemetry: data,
      alert,
    });
  } catch (error) {
    console.error("Telemetry insert error:", error);
    res.status(500).json({
      error: error.message,
      details: error.meta || null,
    });
  }
});

// Get all telemetry
router.get("/telemetry", async (req, res) => {
  try {
    const data = await prisma.telemetry.findMany({
      orderBy: { createdAt: "desc" },
    });
    res.json(data);
  } catch (error) {
    console.error("Get telemetry error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get machine with company + telemetry
router.get("/machine/:id", async (req, res) => {
  try {
    const machineId = Number(req.params.id);

    const data = await prisma.machine.findUnique({
      where: { id: machineId },
      include: {
        company: true,
        telemetry: {
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!data) {
      return res.status(404).json({
        error: "Machine not found",
      });
    }

    res.json(data);
  } catch (error) {
    console.error("Get machine error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get latest telemetry
router.get("/machine/:id/latest", async (req, res) => {
  try {
    const machineId = Number(req.params.id);

    const latestTelemetry = await prisma.telemetry.findFirst({
      where: { machineId },
      orderBy: { createdAt: "desc" },
    });

    if (!latestTelemetry) {
      return res.status(404).json({
        error: "No telemetry found for this machine",
      });
    }

    res.json(latestTelemetry);
  } catch (error) {
    console.error("Get latest telemetry error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Single Machine Overview
router.get("/machine/:id/overview", async (req, res) => {
  try {
    const machineId = Number(req.params.id);

    const telemetry = await prisma.telemetry.findFirst({
      where: { machineId },
      orderBy: { createdAt: "desc" },
    });

    if (!telemetry) {
      return res.status(404).json({
        error: "No telemetry found",
      });
    }

    const historyRaw = await prisma.telemetry.findMany({
      where: { machineId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    const history = historyRaw.reverse();

    let status = "OFF";

    if (telemetry.arcOn === true && (telemetry.outputCurrent || 0) > 50) {
      status = "WELDING";
    } else if (
      telemetry.arcOn === false &&
      (telemetry.inputVoltage || 0) > 100
    ) {
      status = "IDLE";
    }

    const alarms = [];
    const warnings = [];

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
    if (alarms.length > 0) health = "RED";
    else if (warnings.length > 0) health = "YELLOW";

    const overview = {
      status,
      health,
      alarmCount: alarms.length,
      warningCount: warnings.length,
      lastUpdatedAt: telemetry.createdAt,

      weldingCurrent: telemetry.outputCurrent,
      weldingVoltage: telemetry.outputVoltage,
      currentSetting: 400,
      fanSpeed: 0,

      inputVoltage: {
        R: telemetry.inputVoltage,
        Y: telemetry.inputVoltage,
        B: telemetry.inputVoltage,
      },

      temperature: {
        trafoCore: telemetry.temperature,
        igbt: telemetry.temperature,
        heatSync: telemetry.temperature,
      },

      alarms,
      warnings,

      trend: history.map((item) => ({
        time: item.createdAt,
        current: item.outputCurrent,
        voltage: item.outputVoltage,
      })),
    };

    res.json(overview);
  } catch (error) {
    console.error("Machine overview error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Fleet Overview
router.get("/machines/overview", async (req, res) => {
  try {
    const machines = await prisma.machine.findMany({
      include: {
        telemetry: {
          orderBy: { timestamp: "desc" },
          take: 1,
        },
      },
    });

    const result = machines.map((m) => {
      const latest = m.telemetry[0] || {};

      return {
        id: m.id,
        code: m.machineCode,
        serialNumber: m.serialNumber || "",
        location: m.location || "Shop Floor",
        status: latest.arcOn ? "WELDING" : "IDLE",
        health:
          latest.temperature > 80
            ? "RED"
            : latest.temperature > 70
            ? "YELLOW"
            : "GREEN",
        current: latest.outputCurrent || 0,
        temperature: latest.temperature || 0,
        welder: "Unknown",
      };
    });

    res.json(result);
  } catch (error) {
    console.error("Fleet overview error:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;