const prisma = require("./db");

const MAX_SESSION_GAP_SECONDS = 300;

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

module.exports = {
  updateActiveWelderSessionFromTelemetry,
};
