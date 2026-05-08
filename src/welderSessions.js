const prisma = require("./db");
const config = require("./config");

const MAX_SESSION_GAP_SECONDS = 300;
const WELDER_TRACKING_DISABLED = "DISABLED";
const UNKNOWN_WELDER_LABEL = "UNKNOWN";
const DEPOSITION_KG_PER_KWH = 0.05;
const activeArcStates = new Map();
const arcCounters = {
  totalArcEvents: 0,
  unstableArcs: 0,
  failedStarts: 0,
  unknownWelders: 0,
};

function getTelemetryTime(telemetry) {
  return telemetry.timestamp || telemetry.createdAt || new Date();
}

function getElapsedSeconds(previousTime, nextTime) {
  if (!previousTime) {
    return 0;
  }

  const previous = new Date(previousTime).getTime();
  const next = new Date(nextTime).getTime();

  if (Number.isNaN(previous) || Number.isNaN(next) || next <= previous) {
    return 0;
  }

  return Math.min(
    MAX_SESSION_GAP_SECONDS,
    Math.floor((next - previous) / 1000)
  );
}

async function updateActiveWelderSessionFromTelemetry(telemetry) {
  const telemetryTime = getTelemetryTime(telemetry);
  const session = await prisma.welderSession.findFirst({
    where: {
      machineId: telemetry.machineId,
      status: "ACTIVE",
      endedAt: null,
    },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      lastTelemetryAt: true,
      lastArcOn: true,
    },
  });

  if (!session) {
    return null;
  }

  const elapsedSeconds = getElapsedSeconds(session.lastTelemetryAt, telemetryTime);
  const outputVoltage = Number(telemetry.outputVoltage) || 0;
  const outputCurrent = Number(telemetry.outputCurrent) || 0;
  const energy = (outputVoltage * outputCurrent * elapsedSeconds) / 3600000;
  const isArcOn = telemetry.arcOn === true;
  const arcStarted = isArcOn && session.lastArcOn !== true;

  return prisma.welderSession.update({
    where: { id: session.id },
    data: {
      lastTelemetryAt: telemetryTime,
      arcingTimeSeconds: {
        increment: isArcOn ? elapsedSeconds : 0,
      },
      idleTimeSeconds: {
        increment: isArcOn ? 0 : elapsedSeconds,
      },
      energy: {
        increment: energy,
      },
      arcCount: {
        increment: arcStarted ? 1 : 0,
      },
      lastArcOn: isArcOn,
    },
  });
}

function getDurationSeconds(startTime, endTime) {
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();

  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
    return 0;
  }

  return Math.floor((end - start) / 1000);
}

function getDurationMs(startTime, endTime) {
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();

  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
    return 0;
  }

  return end - start;
}

function buildWelderArcSnapshot(assignment) {
  return {
    assignmentId: assignment?.id || null,
    welderId: assignment?.welderId || null,
    trackingMode: assignment?.trackingMode || null,
    welderName: assignment?.welderName || assignment?.welder?.name || null,
    employeeCode:
      assignment?.employeeCode || assignment?.welder?.employeeCode || null,
    rfidCardNo: assignment?.rfidCardNo || assignment?.welder?.rfidCardNo || null,
  };
}

function buildRfidWelderArcSnapshot(session) {
  return {
    assignmentId: null,
    welderId: session?.welderId || null,
    trackingMode: "RFID",
    welderName: session?.welder?.name || null,
    employeeCode: session?.welder?.employeeCode || null,
    rfidCardNo: session?.rfidCardNo || session?.welder?.rfidCardNo || null,
  };
}

async function findActiveAssignment(tx, machineId, telemetryTime) {
  return tx.activeWelderAssignment.findFirst({
    where: {
      machineId,
      status: "ACTIVE",
      startedAt: { lte: telemetryTime },
      OR: [{ endedAt: null }, { endedAt: { gt: telemetryTime } }],
    },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    include: {
      welder: true,
    },
  });
}

async function findActiveRfidSession(tx, machineId, telemetryTime) {
  return tx.welderSession.findFirst({
    where: {
      machineId,
      status: "ACTIVE",
      startedAt: { lte: telemetryTime },
      OR: [{ endedAt: null }, { endedAt: { gt: telemetryTime } }],
    },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    include: {
      welder: true,
    },
  });
}

function getNumericTelemetryValue(value) {
  const parsedValue = Number(value);

  return Number.isFinite(parsedValue) ? parsedValue : 0;
}

function isAboveStartThresholds(sample) {
  return (
    sample.current > config.arcStartCurrentThreshold &&
    sample.voltage > config.arcStartVoltageThreshold
  );
}

function isAboveEndThresholds(sample) {
  return (
    sample.current > config.arcEndCurrentThreshold &&
    sample.voltage > config.arcEndVoltageThreshold
  );
}

function addArcSample(state, sample) {
  state.samples.push(sample);
  state.currentSamples.push(sample.current);
  state.voltageSamples.push(sample.voltage);
  state.timestamps.push(sample.timestamp);
  state.lastTelemetryId = sample.telemetryId;
  state.lastOutputCurrent = sample.current;
  state.lastOutputVoltage = sample.voltage;
  state.lastSampleTime = sample.timestamp;
}

function serializeArcSample(sample) {
  return {
    telemetryId: sample.telemetryId,
    timestamp: sample.timestamp,
    current: sample.current,
    voltage: sample.voltage,
  };
}

function calculateAverage(values) {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundMetric(value, digits = 4) {
  return Number(Number(value || 0).toFixed(digits));
}

function calculateQualityStatus(metrics) {
  if (!metrics.sampleCount || metrics.durationSeconds <= 0) {
    return "UNKNOWN";
  }

  if (
    metrics.avgCurrent < config.arcStartCurrentThreshold ||
    metrics.avgVoltage < config.arcStartVoltageThreshold
  ) {
    return "LOW_HEAT";
  }

  if (
    metrics.minCurrent < config.arcEndCurrentThreshold ||
    metrics.minVoltage < config.arcEndVoltageThreshold
  ) {
    return "UNSTABLE";
  }

  return "GOOD";
}

function buildArcMetrics(state, endTime) {
  const durationSeconds = getDurationSeconds(state.startTime, endTime);
  const avgCurrent = calculateAverage(state.currentSamples);
  const avgVoltage = calculateAverage(state.voltageSamples);
  const peakCurrent = Math.max(...state.currentSamples);
  const peakVoltage = Math.max(...state.voltageSamples);
  const minCurrent = Math.min(...state.currentSamples);
  const minVoltage = Math.min(...state.voltageSamples);
  const energyKwh = (avgVoltage * avgCurrent * durationSeconds) / 3600000;
  const depositionKg = energyKwh * DEPOSITION_KG_PER_KWH;
  const metrics = {
    sampleCount: state.samples.length,
    durationSeconds,
    avgCurrent,
    avgVoltage,
    peakCurrent,
    peakVoltage,
    minCurrent,
    minVoltage,
    energyKwh,
    depositionKg,
  };

  return {
    durationSeconds,
    avgCurrent: roundMetric(avgCurrent, 2),
    avgVoltage: roundMetric(avgVoltage, 2),
    peakCurrent: roundMetric(peakCurrent, 2),
    peakVoltage: roundMetric(peakVoltage, 2),
    minCurrent: roundMetric(minCurrent, 2),
    minVoltage: roundMetric(minVoltage, 2),
    energyKwh: roundMetric(energyKwh, 6),
    depositionKg: roundMetric(depositionKg, 6),
    qualityStatus: calculateQualityStatus(metrics),
  };
}

async function getNextElectrodeRunNo(tx, machineId, startTime) {
  const previousEvent = await tx.welderArcEvent.findFirst({
    where: {
      machineId,
      endTime: { not: null },
    },
    orderBy: [{ endTime: "desc" }, { id: "desc" }],
    select: {
      endTime: true,
      electrodeRunNo: true,
    },
  });

  if (!previousEvent?.endTime) {
    return 1;
  }

  const gapSeconds = getDurationSeconds(previousEvent.endTime, startTime);

  return gapSeconds > config.newElectrodeGapSeconds
    ? (previousEvent.electrodeRunNo || 1) + 1
    : previousEvent.electrodeRunNo || 1;
}

async function findOpenArcEvent(tx, machineId) {
  return tx.welderArcEvent.findFirst({
    where: { machineId, endTime: null },
    orderBy: [{ startTime: "desc" }, { id: "desc" }],
  });
}

function isDuplicateArcSample(state, sample) {
  if (
    state.lastTelemetryId != null &&
    sample.telemetryId != null &&
    state.lastTelemetryId === sample.telemetryId
  ) {
    return true;
  }

  const lastTimestamp = state.timestamps[state.timestamps.length - 1];

  return (
    lastTimestamp?.getTime() === sample.timestamp.getTime() &&
    sample.current === state.lastOutputCurrent &&
    sample.voltage === state.lastOutputVoltage
  );
}

function buildStateFromOpenEvent(event) {
  const samples = Array.isArray(event.rawSamples) ? event.rawSamples : [];
  const currentSamples = samples.map((item) => getNumericTelemetryValue(item.current));
  const voltageSamples = samples.map((item) => getNumericTelemetryValue(item.voltage));
  const timestamps = samples.map((item) => new Date(item.timestamp));
  const lastTelemetryId = samples.length
    ? samples[samples.length - 1].telemetryId || event.startTelemetryId
    : event.startTelemetryId;
  const lastOutputCurrent = samples.length
    ? currentSamples[currentSamples.length - 1]
    : event.startOutputCurrent;
  const lastOutputVoltage = samples.length
    ? voltageSamples[voltageSamples.length - 1]
    : event.startOutputVoltage;
  const lastSampleTime = samples.length
    ? timestamps[timestamps.length - 1]
    : event.startTime;

  return {
    machineId: event.machineId,
    eventId: event.id,
    assignmentId: event.assignmentId || null,
    welderId: event.welderId || null,
    trackingMode: event.trackingMode || null,
    welderName: event.welderName || UNKNOWN_WELDER_LABEL,
    employeeCode: event.employeeCode || null,
    rfidCardNo: event.rfidCardNo || null,
    startTime: event.startTime,
    startTelemetryId: event.startTelemetryId,
    startOutputVoltage: event.startOutputVoltage,
    startOutputCurrent: event.startOutputCurrent,
    belowThresholdSince: null,
    samples,
    currentSamples: currentSamples.length ? currentSamples : [event.startOutputCurrent],
    voltageSamples: voltageSamples.length ? voltageSamples : [event.startOutputVoltage],
    timestamps: timestamps.length ? timestamps : [event.startTime],
    lastTelemetryId,
    lastOutputCurrent,
    lastOutputVoltage,
    lastSampleTime,
    electrodeRunNo: event.electrodeRunNo,
    recovered: true,
  };
}

async function startArcState(telemetry, sample) {
  return prisma.$transaction(async (tx) => {
    const machine = await tx.machine.findUnique({
      where: { id: telemetry.machineId },
      select: { id: true, welderTrackingMode: true },
    });

    if (!machine || machine.welderTrackingMode === WELDER_TRACKING_DISABLED) {
      arcCounters.failedStarts += 1;
      return {
        eventChanged: false,
        reason: "Welder tracking is disabled",
      };
    }

    const openEvent = await findOpenArcEvent(tx, telemetry.machineId);

    if (openEvent) {
      return {
        eventChanged: false,
        reason: "Open arc event already exists",
      };
    }

    const snapshot = await getWelderSnapshotForTelemetry(
      tx,
      telemetry.machineId,
      sample.timestamp
    );
    const electrodeRunNo = await getNextElectrodeRunNo(
      tx,
      telemetry.machineId,
      sample.timestamp
    );

    const event = await tx.welderArcEvent.create({
      data: {
        machineId: telemetry.machineId,
        assignmentId: snapshot.assignmentId || null,
        welderId: snapshot.welderId || null,
        trackingMode: snapshot.trackingMode || null,
        welderName: snapshot.welderName || UNKNOWN_WELDER_LABEL,
        employeeCode: snapshot.employeeCode || null,
        rfidCardNo: snapshot.rfidCardNo || null,
        startTime: sample.timestamp,
        startTelemetryId: sample.telemetryId || null,
        startOutputVoltage: sample.voltage,
        startOutputCurrent: sample.current,
        electrodeRunNo,
      },
    });

    const state = {
      machineId: telemetry.machineId,
      eventId: event.id,
      startTime: sample.timestamp,
      startTelemetryId: sample.telemetryId,
      startOutputVoltage: sample.voltage,
      startOutputCurrent: sample.current,
      belowThresholdSince: null,
      samples: [sample],
      currentSamples: [sample.current],
      voltageSamples: [sample.voltage],
      timestamps: [sample.timestamp],
      lastTelemetryId: sample.telemetryId,
      lastOutputCurrent: sample.current,
      lastOutputVoltage: sample.voltage,
      lastSampleTime: sample.timestamp,
      electrodeRunNo,
      ...snapshot,
    };

    if (!state.welderId) {
      arcCounters.unknownWelders += 1;
    }

    activeArcStates.set(telemetry.machineId, state);

    console.log("[arc-event] START", {
      machineId: telemetry.machineId,
      telemetryId: sample.telemetryId,
      startedAt: sample.timestamp,
      current: sample.current,
      voltage: sample.voltage,
      electrodeRunNo,
      welderId: state.welderId,
      welderName: state.welderName || UNKNOWN_WELDER_LABEL,
    });

    return { eventChanged: true, action: "STARTED" };
  });
}

async function saveCompletedArcEvent(state, endSample) {
  const endTime = endSample.timestamp;
  const metrics = buildArcMetrics(state, endTime);
  const durationMs = getDurationMs(state.startTime, endTime);

  if (durationMs < config.arcMinDurationMs) {
    arcCounters.failedStarts += 1;

    if (state.eventId) {
      await prisma.welderArcEvent.delete({
        where: { id: state.eventId },
      });
    }

    console.log("[arc-event] DISCARDED_SHORT_SPIKE", {
      machineId: state.machineId,
      durationMs,
      sampleCount: state.samples.length,
      telemetryId: endSample.telemetryId,
    });

    return null;
  }

  const updateData = {
    endTime,
    durationSeconds: metrics.durationSeconds,
    endTelemetryId: endSample.telemetryId || state.lastTelemetryId || null,
    endOutputVoltage: endSample.voltage,
    endOutputCurrent: endSample.current,
    avgCurrent: metrics.avgCurrent,
    avgVoltage: metrics.avgVoltage,
    peakCurrent: metrics.peakCurrent,
    peakVoltage: metrics.peakVoltage,
    minCurrent: metrics.minCurrent,
    minVoltage: metrics.minVoltage,
    energyKwh: metrics.energyKwh,
    depositionKg: metrics.depositionKg,
    qualityStatus: metrics.qualityStatus,
    ...(config.rawWaveformRetention
      ? { rawSamples: state.samples.map(serializeArcSample) }
      : {}),
  };

  const event = await prisma.welderArcEvent.update({
    where: { id: state.eventId },
    data: updateData,
  });

  arcCounters.totalArcEvents += 1;

  if (metrics.qualityStatus === "UNSTABLE") {
    arcCounters.unstableArcs += 1;
  }

  console.log("[arc-event] SAVED", {
    eventId: event.id,
    machineId: state.machineId,
    durationSeconds: metrics.durationSeconds,
    sampleCount: state.samples.length,
    avgCurrent: metrics.avgCurrent,
    avgVoltage: metrics.avgVoltage,
    qualityStatus: metrics.qualityStatus,
    electrodeRunNo: state.electrodeRunNo,
  });

  return event;
}

function buildArcEngineDiagnostics(machineId) {
  const state = activeArcStates.get(machineId);
  const activeArcState = state
    ? {
        machineId: state.machineId,
        eventId: state.eventId,
        startTime: state.startTime,
        startTelemetryId: state.startTelemetryId,
        lastTelemetryId: state.lastTelemetryId,
        startOutputCurrent: state.startOutputCurrent,
        startOutputVoltage: state.startOutputVoltage,
        lastOutputCurrent: state.lastOutputCurrent,
        lastOutputVoltage: state.lastOutputVoltage,
        lastSampleTime: state.lastSampleTime,
        belowThresholdSince: state.belowThresholdSince,
        sampleCount: state.samples.length,
        currentSampleCount: state.currentSamples.length,
        voltageSampleCount: state.voltageSamples.length,
        recovery: state.recovered || false,
      }
    : null;

  return {
    activeArcState,
    thresholds: {
      arcStartCurrentThreshold: config.arcStartCurrentThreshold,
      arcEndCurrentThreshold: config.arcEndCurrentThreshold,
      arcStartVoltageThreshold: config.arcStartVoltageThreshold,
      arcEndVoltageThreshold: config.arcEndVoltageThreshold,
      arcMinDurationMs: config.arcMinDurationMs,
      arcEndDebounceMs: config.arcEndDebounceMs,
      rawWaveformRetention: config.rawWaveformRetention,
    },
    debounceState: state ? { belowThresholdSince: state.belowThresholdSince } : null,
    sampleCounts: state
      ? {
          totalSamples: state.samples.length,
          currentSamples: state.currentSamples.length,
          voltageSamples: state.voltageSamples.length,
        }
      : null,
    counters: { ...arcCounters },
  };
}

let arcRecoveryInterval = null;

async function cleanupStaleOpenArcs() {
  const now = new Date();
  const closeThresholdMs = Math.max(
    config.arcEndDebounceMs * 2,
    config.arcMinDurationMs,
    10000
  );

  for (const [machineId, state] of activeArcStates.entries()) {
    if (!state.lastSampleTime) {
      continue;
    }

    const inactivityMs = now.getTime() - state.lastSampleTime.getTime();

    if (inactivityMs < closeThresholdMs) {
      continue;
    }

    console.log("[arc-event] RECOVERY_CLOSE", {
      machineId,
      inactivityMs,
      eventId: state.eventId,
      lastSampleTime: state.lastSampleTime,
    });

    activeArcStates.delete(machineId);
    await saveCompletedArcEvent(state, {
      telemetryId: state.lastTelemetryId,
      timestamp: state.lastSampleTime,
      current: state.lastOutputCurrent,
      voltage: state.lastOutputVoltage,
    });
  }
}

function ensureArcRecoveryTimer() {
  if (arcRecoveryInterval) {
    return;
  }

  arcRecoveryInterval = setInterval(() => {
    void cleanupStaleOpenArcs().catch((error) => {
      console.error("[arc-event] recovery cleanup failed:", error);
    });
  }, Math.max(config.arcEndDebounceMs, 5000));

  arcRecoveryInterval.unref?.();
}

async function recoverOpenArcStates() {
  const openEvents = await prisma.welderArcEvent.findMany({
    where: { endTime: null },
    orderBy: [{ startTime: "asc" }, { id: "asc" }],
  });

  if (!openEvents.length) {
    ensureArcRecoveryTimer();
    return {
      recovered: 0,
      openEvents: 0,
    };
  }

  for (const event of openEvents) {
    const state = buildStateFromOpenEvent(event);
    activeArcStates.set(event.machineId, state);

    console.log("[arc-event] RECOVERED_OPEN_STATE", {
      machineId: event.machineId,
      eventId: event.id,
      startTime: event.startTime,
      recoveredSampleCount: state.samples.length,
    });
  }

  ensureArcRecoveryTimer();

  return {
    recovered: openEvents.length,
    openEvents: openEvents.length,
  };
}

async function processMqttTelemetryForWelderArcEvents(telemetry) {
  const telemetryTime = getTelemetryTime(telemetry);

  if (!telemetry?.machineId || !telemetryTime) {
    return null;
  }

  const sample = {
    telemetryId: telemetry.id || null,
    timestamp: telemetryTime,
    current: getNumericTelemetryValue(telemetry.outputCurrent),
    voltage: getNumericTelemetryValue(telemetry.outputVoltage),
  };
  const state = activeArcStates.get(telemetry.machineId);
  const aboveStartThresholds = isAboveStartThresholds(sample);
  const aboveEndThresholds = isAboveEndThresholds(sample);

  if (!state && aboveStartThresholds) {
    return startArcState(telemetry, sample);
  }

  if (!state) {
    return { eventChanged: false };
  }

  if (isDuplicateArcSample(state, sample)) {
    return { eventChanged: false, action: "DUPLICATE_SAMPLE" };
  }

  addArcSample(state, sample);

  if (aboveEndThresholds) {
    state.belowThresholdSince = null;
    return { eventChanged: false, action: "SAMPLED" };
  }

  if (!state.belowThresholdSince) {
    state.belowThresholdSince = sample.timestamp;
  }

  const belowThresholdMs =
    sample.timestamp.getTime() - state.belowThresholdSince.getTime();

  if (belowThresholdMs < config.arcEndDebounceMs) {
    return { eventChanged: false, action: "DEBOUNCING_END" };
  }

  activeArcStates.delete(telemetry.machineId);

  console.log("[arc-event] END", {
    machineId: telemetry.machineId,
    telemetryId: sample.telemetryId,
    endedAt: sample.timestamp,
    debounceMs: belowThresholdMs,
    current: sample.current,
    voltage: sample.voltage,
    sampleCount: state.samples.length,
  });

  const event = await saveCompletedArcEvent(state, sample);

  return { eventChanged: true, action: "ENDED", event };
}

module.exports = {
  activeArcStates,
  processMqttTelemetryForWelderArcEvents,
  updateActiveWelderSessionFromTelemetry,
  recoverOpenArcStates,
  buildArcEngineDiagnostics,
};
