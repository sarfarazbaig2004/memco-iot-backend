const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const config = require("./config");

const connectionString = config.databaseUrl;

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

let connectPromise;

function getConnectionTarget() {
  try {
    const url = new URL(connectionString);

    return {
      host: url.hostname || "localhost",
      port: url.port || "5432",
      database: url.pathname.replace(/^\//, "") || "postgres",
    };
  } catch (_error) {
    return {
      host: "localhost",
      port: "5432",
      database: "memco_iot",
    };
  }
}

async function connectDB() {
  if (!connectPromise) {
    connectPromise = prisma
      .$connect()
      .then(async () => {
        await prisma.$executeRawUnsafe("SELECT 1");

        const target = getConnectionTarget();
        console.log(
          `✅ Database connected successfully (${target.host}:${target.port}/${target.database})`
        );
      })
      .catch((err) => {
        connectPromise = null;

        const target = getConnectionTarget();
        const errorCode = err.code || err.cause?.code;
        const errorMessage = err.message || err.cause?.message || "";
        const isP1001 =
          errorCode === "P1001" ||
          errorCode === "ECONNREFUSED" ||
          errorCode === "ECONNRESET" ||
          errorCode === "EHOSTUNREACH" ||
          errorCode === "ENOTFOUND" ||
          errorCode === "ETIMEDOUT" ||
          errorCode === "EPERM" ||
          errorMessage.includes("Can't reach database server");

        if (isP1001) {
          console.error(
            `❌ Prisma could not reach PostgreSQL at ${target.host}:${target.port}.`
          );
          console.error(
            `   Check DATABASE_URL and make sure the database "${target.database}" is reachable.`
          );
          console.error(
            "   If this is a Render database, verify the service is up and the connection string is still valid."
          );
        } else {
          console.error("❌ Database connection failed:", errorMessage);
        }

        throw err;
      });
  }

  return connectPromise;
}

module.exports = prisma;
module.exports.connectDB = connectDB;
