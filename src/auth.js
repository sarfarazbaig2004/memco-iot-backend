const crypto = require("crypto");

const TOKEN_VERSION = 1;
const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60 * 8;
const DEFAULT_JWT_SECRET = "change-this-memco-demo-secret";

function getJwtSecret() {
  return process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function signToken(payload, ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "HS256",
    typ: "JWT",
    v: TOKEN_VERSION,
  };
  const body = {
    ...payload,
    iat: now,
    exp: now + ttlSeconds,
  };
  const unsignedToken = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(
    JSON.stringify(body)
  )}`;
  const signature = crypto
    .createHmac("sha256", getJwtSecret())
    .update(unsignedToken)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${unsignedToken}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [header, body, signature] = parts;
  const unsignedToken = `${header}.${body}`;
  const expectedSignature = crypto
    .createHmac("sha256", getJwtSecret())
    .update(unsignedToken)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const providedSignature = Buffer.from(signature);
  const validSignature = Buffer.from(expectedSignature);
  if (
    providedSignature.length !== validSignature.length ||
    !crypto.timingSafeEqual(providedSignature, validSignature)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(body));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch (_error) {
    return null;
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .pbkdf2Sync(password, salt, 100000, 32, "sha256")
    .toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, passwordHash) {
  if (!password || !passwordHash || !passwordHash.includes(":")) {
    return false;
  }

  const [salt, storedHash] = passwordHash.split(":");
  const hash = crypto
    .pbkdf2Sync(password, salt, 100000, 32, "sha256")
    .toString("hex");

  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(storedHash));
}

function getPermissionsForRole(role) {
  switch (role) {
    case "SOFTWARE_SUPER_ADMIN":
    case "COMPANY_SUPER_ADMIN":
    case "SUPER_ADMIN":
      return [
        "view_fleet",
        "view_overview",
        "view_production",
        "view_engineering",
        "view_calibration",
        "view_reports",
        "view_arcing_time",
        "assign_rfid",
        "reset_machine",
      ];
    case "CUSTOMER":
      return ["view_reports", "view_arcing_time"];
    default:
      return [];
  }
}

function sanitizeUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    permissions: getPermissionsForRole(user.role),
  };
}

function authMiddleware(req, _res, next) {
  const authorization = req.headers.authorization || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : null;

  req.user = token ? verifyToken(token) : null;
  next();
}

module.exports = {
  authMiddleware,
  getPermissionsForRole,
  hashPassword,
  sanitizeUser,
  signToken,
  verifyPassword,
  verifyToken,
};
