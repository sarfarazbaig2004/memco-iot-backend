const prisma = require("./db");

const PRODUCTION_STATES = {
  ARC: "ARC",
  IDLE: "IDLE",
  OFF: "OFF",
  OFFLINE: "OFFLINE",
};

const OFFLINE_AFTER_SECONDS = 5 * 60;
const MS_PER_SECOND = 1000;
const MS_PER_DAY = 24 * 60 * 60 * MS_PER_SECOND;
const SLOW_QUERY_MS = 250;
const machineProcessingQueues = new Map();

async function measureQuery(operation, query) {
  const startedAt = Date.now();

  try {
    return await query();
  } finally {
    const elapsedMs = Date.now() - startedAt;
    const log = elapsedMs >= SLOW_QUERY_MS ? console.warn : console.log;
    log("[production] Prisma operation completed", { operation, elapsedMs });
  }
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function getUtcDayStart(date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

function parseProductionDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) {
    return null;
  }

  const dateText = String(value);
  const date = new Date(`${dateText}T00:00:00.000Z`);

  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== dateText
    ? null
    : date;
}

function getDayRange(date) {
  const start = getUtcDayStart(date);
  const end = new Date(start.getTime() + MS_PER_DAY);

  return { start, end };
}

function getDurationSeconds(startTime, endTime) {
  const start = toDate(startTime);
  const end = toDate(endTime);

  if (!start || !end || end <= start) {
    return 0;
  }

  return Math.floor((end.getTime() - start.getTime()) / MS_PER_SECOND);
}

function deriveMachineProductionState(telemetry) {
  if (telemetry?.machineOn === false) {
    return PRODUCTION_STATES.OFF;
  }

  if (telemetry?.machineOn === true) {
    return telemetry.arcOn === true
      ? PRODUCTION_STATES.ARC
      : PRODUCTION_STATES.IDLE;
  }

  if (telemetry?.arcOn === true) {
    return PRODUCTION_STATES.ARC;
  }

  const hasLiveValue = [
    telemetry?.inputVoltage,
    telemetry?.outputVoltage,
    telemetry?.outputCurrent,
  ].some((value) => Number(value) > 0);

  return hasLiveValue ? PRODUCTION_STATES.IDLE : PRODUCTION_STATES.OFF;
}

function getSummaryFieldForState(state) {
  if (state === PRODUCTION_STATES.ARC) return "arcSeconds";
  if (state === PRODUCTION_STATES.IDLE) return "idleSeconds";
  if (state === PRODUCTION_STATES.OFF) return "offSeconds";
  if (state === PRODUCTION_STATES.OFFLINE) return "offlineSeconds";
  return null;
}

function isMachineOnState(state) {
  return state === PRODUCTION_STATES.ARC || state === PRODUCTION_STATES.IDLE;
}

function buildDurationIncrements(state, seconds) {
  const field = getSummaryFieldForState(state);
  const data = { lastUpdatedAt: new Date() };

  if (field && seconds > 0) {
    data[field] = { increment: seconds };
  }

  if (isMachineOnState(state) && seconds > 0) {
    data.machineOnSeconds = { increment: seconds };
  }

  return data;
}

async function incrementDailySummary(tx, machineId, date, data) {
  await measureQuery("dailyProductionSummary.upsert", () =>
    tx.dailyProductionSummary.upsert({
      where: {
        machineId_date: {
          machineId,
          date,
        },
      },
      create: {
        machineId,
        date,
        arcSeconds: data.arcSeconds?.increment || 0,
        idleSeconds: data.idleSeconds?.increment || 0,
        offSeconds: data.offSeconds?.increment || 0,
        offlineSeconds: data.offlineSeconds?.increment || 0,
        machineOnSeconds: data.machineOnSeconds?.increment || 0,
        noOfArcs: data.noOfArcs?.increment || 0,
        lastUpdatedAt: data.lastUpdatedAt || new Date(),
      },
      update: data,
    })
  );
}

async function addDurationToDailySummaries(tx, machineId, state, startTime, endTime) {
  let cursor = toDate(startTime);
  const end = toDate(endTime);

  if (!cursor || !end || end <= cursor) {
    return;
  }

  while (cursor < end) {
    const dayStart = getUtcDayStart(cursor);
    const nextDayStart = new Date(dayStart.getTime() + MS_PER_DAY);
    const segmentEnd = nextDayStart < end ? nextDayStart : end;
    const seconds = getDurationSeconds(cursor, segmentEnd);

    if (seconds > 0) {
      await incrementDailySummary(
        tx,
        machineId,
        dayStart,
        buildDurationIncrements(state, seconds)
      );
    }

    cursor = segmentEnd;
  }
}

async function incrementArcCount(tx, machineId, startTime) {
  await incrementDailySummary(tx, machineId, getUtcDayStart(startTime), {
    noOfArcs: { increment: 1 },
    lastUpdatedAt: new Date(),
  });
}

async function closeEvent(tx, event, endTime) {
  const durationSeconds = getDurationSeconds(event.startTime, endTime);

  await tx.machineProductionEvent.update({
    where: { id: event.id },
    data: {
      endTime,
      durationSeconds,
    },
  });

  await addDurationToDailySummaries(
    tx,
    event.machineId,
    event.state,
    event.startTime,
    endTime
  );

  return durationSeconds;
}

async function createEvent(tx, machineId, state, startTime, previousState) {
  const event = await tx.machineProductionEvent.create({
    data: {
      machineId,
      state,
      startTime,
    },
  });

  if (state === PRODUCTION_STATES.ARC && previousState !== PRODUCTION_STATES.ARC) {
    await incrementArcCount(tx, machineId, startTime);
  }

  return event;
}

function buildLatestTelemetryData(telemetry, state) {
  return {
    machineId: telemetry.machineId,
    timestamp: telemetry.timestamp,
    inputVoltage: telemetry.inputVoltage,
    inputVoltageR: telemetry.inputVoltageR,
    inputVoltageY: telemetry.inputVoltageY,
    inputVoltageB: telemetry.inputVoltageB,
    outputVoltage: telemetry.outputVoltage,
    outputCurrent: telemetry.outputCurrent,
    currentSetting: telemetry.currentSetting,
    fanPulsePerMin: telemetry.fanPulsePerMin,
    temperature: telemetry.temperature,
    trafoCoreTemperature: telemetry.trafoCoreTemperature,
    igbtTemperature: telemetry.igbtTemperature,
    heatSyncTemperature: telemetry.heatSyncTemperature,
    machineOn: telemetry.machineOn,
    arcOn: telemetry.arcOn,
    state,
    gpsFix: telemetry.gpsFix,
    gpsLat: telemetry.gpsLat,
    gpsLng: telemetry.gpsLng,
    gpsAltitude: telemetry.gpsAltitude,
    mapUrl: telemetry.mapUrl,
    ...(telemetry.alarms !== null ? { alarms: telemetry.alarms } : {}),
    ...(telemetry.warnings !== null ? { warnings: telemetry.warnings } : {}),
    ...(telemetry.runningJob !== null ? { runningJob: telemetry.runningJob } : {}),
    ...(telemetry.machineLifetime !== null ? { machineLifetime: telemetry.machineLifetime } : {}),
    telemetryId: telemetry.id,
    lastReceivedAt: new Date(),
  };
}

async function applyProductionSummaryEffects(machineId, effects) {
  for (const effect of effects) {
    if (effect.type === "duration") {
      await addDurationToDailySummaries(
        prisma,
        machineId,
        effect.state,
        effect.startTime,
        effect.endTime
      );
    } else if (effect.type === "arcCount") {
      await incrementArcCount(prisma, machineId, effect.startTime);
    }
  }
}

async function processTelemetryForProductionNow(telemetry) {
  const startedAt = Date.now();
  const telemetryTime = toDate(telemetry?.timestamp || telemetry?.createdAt);

  if (!telemetry?.machineId || !telemetryTime) {
    throw new Error("Telemetry must include machineId and a valid timestamp");
  }

  const state = deriveMachineProductionState(telemetry);
  const latest = await measureQuery("machineLatestTelemetry.findUnique", () =>
    prisma.machineLatestTelemetry.findUnique({
      where: { machineId: telemetry.machineId },
    })
  );

  const isOlderThanLatest = latest && telemetryTime < latest.timestamp;

  if (isOlderThanLatest) {
    return {
      state,
      skippedHistory: true,
      reason: "Telemetry timestamp is older than the latest processed sample",
    };
  }

  const transactionResult = await measureQuery(
    "machineProductionEvent.transaction",
    () => prisma.$transaction(async (tx) => {
      const summaryEffects = [];
      const openEvent = await measureQuery("machineProductionEvent.findOpen", () =>
        tx.machineProductionEvent.findFirst({
          where: {
            machineId: telemetry.machineId,
            endTime: null,
          },
          orderBy: [{ startTime: "desc" }, { id: "desc" }],
        })
      );

      if (!openEvent) {
        const previousEvent = await measureQuery("machineProductionEvent.findPrevious", () =>
          tx.machineProductionEvent.findFirst({
            where: { machineId: telemetry.machineId },
            orderBy: [{ startTime: "desc" }, { id: "desc" }],
          })
        );

        await measureQuery("machineProductionEvent.create", () =>
          tx.machineProductionEvent.create({
            data: { machineId: telemetry.machineId, state, startTime: telemetryTime },
          })
        );

        if (state === PRODUCTION_STATES.ARC && previousEvent?.state !== state) {
          summaryEffects.push({ type: "arcCount", startTime: telemetryTime });
        }

        return { result: { state, eventChanged: true }, summaryEffects };
      }

      if (telemetryTime <= openEvent.startTime) {
        return {
          result: {
            state,
            eventChanged: false,
            reason: "Telemetry timestamp is not newer than current event start",
          },
          summaryEffects,
        };
      }

      const previousTelemetryTime = latest?.timestamp ? toDate(latest.timestamp) : null;
      const offlineStart =
        previousTelemetryTime &&
        telemetryTime.getTime() - previousTelemetryTime.getTime() >
          OFFLINE_AFTER_SECONDS * MS_PER_SECOND
          ? new Date(
              previousTelemetryTime.getTime() +
                OFFLINE_AFTER_SECONDS * MS_PER_SECOND
            )
          : null;

      if (offlineStart && offlineStart > openEvent.startTime) {
        await measureQuery("machineProductionEvent.closeForOfflineGap", () =>
          tx.machineProductionEvent.update({
            where: { id: openEvent.id },
            data: {
              endTime: offlineStart,
              durationSeconds: getDurationSeconds(openEvent.startTime, offlineStart),
            },
          })
        );
        summaryEffects.push({
          type: "duration",
          state: openEvent.state,
          startTime: openEvent.startTime,
          endTime: offlineStart,
        });

        if (telemetryTime > offlineStart) {
          await measureQuery("machineProductionEvent.createOfflineGap", () =>
            tx.machineProductionEvent.create({
              data: {
                machineId: telemetry.machineId,
                state: PRODUCTION_STATES.OFFLINE,
                startTime: offlineStart,
                endTime: telemetryTime,
                durationSeconds: getDurationSeconds(offlineStart, telemetryTime),
              },
            })
          );
          summaryEffects.push({
            type: "duration",
            state: PRODUCTION_STATES.OFFLINE,
            startTime: offlineStart,
            endTime: telemetryTime,
          });
        }

        await measureQuery("machineProductionEvent.createAfterOfflineGap", () =>
          tx.machineProductionEvent.create({
            data: { machineId: telemetry.machineId, state, startTime: telemetryTime },
          })
        );
        if (state === PRODUCTION_STATES.ARC) {
          summaryEffects.push({ type: "arcCount", startTime: telemetryTime });
        }

        return {
          result: { state, eventChanged: true, offlineGapRecorded: true },
          summaryEffects,
        };
      }

      if (openEvent.state === state) {
        return { result: { state, eventChanged: false }, summaryEffects };
      }

      await measureQuery("machineProductionEvent.closeForStateChange", () =>
        tx.machineProductionEvent.update({
          where: { id: openEvent.id },
          data: {
            endTime: telemetryTime,
            durationSeconds: getDurationSeconds(openEvent.startTime, telemetryTime),
          },
        })
      );
      summaryEffects.push({
        type: "duration",
        state: openEvent.state,
        startTime: openEvent.startTime,
        endTime: telemetryTime,
      });

      await measureQuery("machineProductionEvent.createForStateChange", () =>
        tx.machineProductionEvent.create({
          data: { machineId: telemetry.machineId, state, startTime: telemetryTime },
        })
      );
      if (state === PRODUCTION_STATES.ARC) {
        summaryEffects.push({ type: "arcCount", startTime: telemetryTime });
      }

      return { result: { state, eventChanged: true }, summaryEffects };
    })
  );

  await measureQuery("machineLatestTelemetry.upsert", () =>
    prisma.machineLatestTelemetry.upsert({
      where: { machineId: telemetry.machineId },
      create: buildLatestTelemetryData({ ...telemetry, timestamp: telemetryTime }, state),
      update: buildLatestTelemetryData({ ...telemetry, timestamp: telemetryTime }, state),
    })
  );

  await applyProductionSummaryEffects(
    telemetry.machineId,
    transactionResult.summaryEffects
  );

  console.log("[production] telemetry processing completed", {
    machineId: telemetry.machineId,
    telemetryId: telemetry.id,
    elapsedMs: Date.now() - startedAt,
  });

  return transactionResult.result;
}

function processTelemetryForProduction(telemetry) {
  const machineId = telemetry?.machineId;
  const previous = machineProcessingQueues.get(machineId) || Promise.resolve();
  const queued = previous
    .catch(() => undefined)
    .then(() => processTelemetryForProductionNow(telemetry));

  machineProcessingQueues.set(machineId, queued);

  return queued.finally(() => {
    if (machineProcessingQueues.get(machineId) === queued) {
      machineProcessingQueues.delete(machineId);
    }
  });
}

async function ensureMachineOfflineState(machineId, asOf = new Date()) {
  const now = toDate(asOf) || new Date();

  return prisma.$transaction(async (tx) => {
    const latest = await tx.machineLatestTelemetry.findUnique({
      where: { machineId },
    });

    if (!latest) {
      return null;
    }

    const offlineStart = new Date(
      latest.timestamp.getTime() + OFFLINE_AFTER_SECONDS * MS_PER_SECOND
    );

    if (offlineStart > now) {
      return null;
    }

    const openEvent = await tx.machineProductionEvent.findFirst({
      where: {
        machineId,
        endTime: null,
      },
      orderBy: [{ startTime: "desc" }, { id: "desc" }],
    });

    if (openEvent?.state === PRODUCTION_STATES.OFFLINE) {
      return openEvent;
    }

    if (openEvent && offlineStart > openEvent.startTime) {
      await closeEvent(tx, openEvent, offlineStart);
    }

    const existingOfflineEvent = await tx.machineProductionEvent.findFirst({
      where: {
        machineId,
        state: PRODUCTION_STATES.OFFLINE,
        endTime: null,
      },
      orderBy: [{ startTime: "desc" }, { id: "desc" }],
    });

    if (existingOfflineEvent) {
      return existingOfflineEvent;
    }

    return tx.machineProductionEvent.create({
      data: {
        machineId,
        state: PRODUCTION_STATES.OFFLINE,
        startTime: offlineStart,
      },
    });
  });
}

function addOpenEventContribution(summary, event, rangeStart, rangeEnd, asOf) {
  if (!event || event.endTime) {
    return summary;
  }

  const effectiveEnd = new Date(
    Math.min(rangeEnd.getTime(), (toDate(asOf) || new Date()).getTime())
  );
  const effectiveStart = new Date(
    Math.max(rangeStart.getTime(), event.startTime.getTime())
  );
  const seconds = getDurationSeconds(effectiveStart, effectiveEnd);
  const field = getSummaryFieldForState(event.state);

  if (seconds <= 0 || !field) {
    return summary;
  }

  return {
    ...summary,
    [field]: summary[field] + seconds,
    machineOnSeconds: isMachineOnState(event.state)
      ? summary.machineOnSeconds + seconds
      : summary.machineOnSeconds,
  };
}

async function getDailyProductionSummary(machineId, date, asOf = new Date()) {
  const { start, end } = getDayRange(date);
  await ensureMachineOfflineState(machineId, asOf);

  const [storedSummary, openEvent] = await Promise.all([
    prisma.dailyProductionSummary.findUnique({
      where: {
        machineId_date: {
          machineId,
          date: start,
        },
      },
    }),
    prisma.machineProductionEvent.findFirst({
      where: {
        machineId,
        endTime: null,
        startTime: { lt: end },
      },
      orderBy: [{ startTime: "desc" }, { id: "desc" }],
    }),
  ]);

  const baseSummary = {
    arcSeconds: storedSummary?.arcSeconds || 0,
    idleSeconds: storedSummary?.idleSeconds || 0,
    offSeconds: storedSummary?.offSeconds || 0,
    offlineSeconds: storedSummary?.offlineSeconds || 0,
    machineOnSeconds: storedSummary?.machineOnSeconds || 0,
    noOfArcs: storedSummary?.noOfArcs || 0,
    lastUpdatedAt: storedSummary?.lastUpdatedAt || null,
  };
  const summary = addOpenEventContribution(
    baseSummary,
    openEvent,
    start,
    end,
    asOf
  );
  const trackedSeconds =
    summary.arcSeconds +
    summary.idleSeconds +
    summary.offSeconds +
    summary.offlineSeconds;

  return {
    machineId,
    date: start.toISOString().slice(0, 10),
    arcTime: summary.arcSeconds,
    idleTime: summary.idleSeconds,
    offTime: summary.offSeconds,
    offlineTime: summary.offlineSeconds,
    machineOnTime: summary.machineOnSeconds,
    arcSeconds: summary.arcSeconds,
    idleSeconds: summary.idleSeconds,
    offSeconds: summary.offSeconds,
    offlineSeconds: summary.offlineSeconds,
    machineOnSeconds: summary.machineOnSeconds,
    noOfArcs: summary.noOfArcs,
    utilizationPercent:
      trackedSeconds > 0
        ? Number(((summary.machineOnSeconds / trackedSeconds) * 100).toFixed(2))
        : 0,
    arcEfficiencyPercent:
      summary.machineOnSeconds > 0
        ? Number(((summary.arcSeconds / summary.machineOnSeconds) * 100).toFixed(2))
        : 0,
    trackedSeconds,
    lastUpdatedAt: summary.lastUpdatedAt,
  };
}

async function getProductionTimeline(machineId, date, asOf = new Date()) {
  const { start, end } = getDayRange(date);
  await ensureMachineOfflineState(machineId, asOf);

  const events = await prisma.machineProductionEvent.findMany({
    where: {
      machineId,
      startTime: { lt: end },
      OR: [{ endTime: null }, { endTime: { gt: start } }],
    },
    orderBy: [{ startTime: "asc" }, { id: "asc" }],
  });

  const now = toDate(asOf) || new Date();

  return events.map((event) => {
    const effectiveStart = new Date(Math.max(event.startTime.getTime(), start.getTime()));
    const rawEnd = event.endTime || now;
    const effectiveEnd = new Date(Math.min(rawEnd.getTime(), end.getTime()));

    return {
      startTime: effectiveStart,
      endTime: event.endTime ? effectiveEnd : null,
      state: event.state,
      durationSeconds: event.endTime
        ? getDurationSeconds(effectiveStart, effectiveEnd)
        : getDurationSeconds(effectiveStart, effectiveEnd),
    };
  });
}

module.exports = {
  OFFLINE_AFTER_SECONDS,
  PRODUCTION_STATES,
  deriveMachineProductionState,
  ensureMachineOfflineState,
  getDailyProductionSummary,
  getProductionTimeline,
  parseProductionDate,
  processTelemetryForProduction,
};
