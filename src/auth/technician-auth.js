// Technician authentication.
//
// - Login is passcode only. The passcode is looked up by HMAC (keyed with
//   PASSCODE_PEPPER) and then verified against a bcrypt hash.
// - On success a DB session row is created and two httpOnly cookies are set:
//     jc_tat  short-lived access token (JWT, 15 min) carrying { sub, sid }
//     jc_trt  long-lived refresh token "<sessionId>.<random>" (7 days), stored hashed
// - Every protected request verifies the access JWT and that its session is
//   still active. When the access token has expired the refresh token is used
//   to mint a new pair (rotation). Presenting an old refresh token outside a
//   short grace window is treated as theft and revokes the session.
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { query } from "../db.js";

const ACCESS_TTL_SEC = 15 * 60;
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ROTATION_GRACE_MS = 30 * 1000; // tolerate parallel requests racing a rotation
const ISSUER = "iacs-jobcard";
const AUDIENCE = "technician";

export const ACCESS_COOKIE = "jc_tat";
export const REFRESH_COOKIE = "jc_trt";
export const PASSCODE_LENGTH = 6;

const isProd = process.env.NODE_ENV === "production";

function requireSecret(name) {
  const v = process.env[name];
  if (!v || v.length < 32) throw new Error(`${name} must be set in .env (at least 32 characters).`);
  return v;
}
const JWT_SECRET = requireSecret("JWT_SECRET");
const PASSCODE_PEPPER = requireSecret("PASSCODE_PEPPER");

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const passcodeLookup = (passcode) =>
  crypto.createHmac("sha256", PASSCODE_PEPPER).update(passcode).digest("hex");
export const hashPasscode = (passcode) => bcrypt.hash(passcode, 12);

// A dummy hash so failed lookups take as long as real ones (no timing hint).
const DUMMY_HASH = bcrypt.hashSync("000000-not-a-real-passcode", 12);

const cookieBase = { httpOnly: true, secure: isProd, sameSite: "strict" };

function setAuthCookies(res, accessToken, refreshToken) {
  res.cookie(ACCESS_COOKIE, accessToken, { ...cookieBase, path: "/", maxAge: ACCESS_TTL_SEC * 1000 });
  res.cookie(REFRESH_COOKIE, refreshToken, { ...cookieBase, path: "/technician", maxAge: REFRESH_TTL_MS });
}

export function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, { ...cookieBase, path: "/" });
  res.clearCookie(REFRESH_COOKIE, { ...cookieBase, path: "/technician" });
}

const signAccess = (techId, sid) =>
  jwt.sign({ sid }, JWT_SECRET, {
    subject: String(techId),
    expiresIn: ACCESS_TTL_SEC,
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithm: "HS256",
  });

const newRefreshSecret = () => crypto.randomBytes(32).toString("base64url");

// Returns the technician for a passcode, or null.
export async function verifyPasscode(passcode) {
  if (typeof passcode !== "string" || !new RegExp(`^\\d{${PASSCODE_LENGTH}}$`).test(passcode)) {
    await bcrypt.compare("x", DUMMY_HASH);
    return null;
  }
  const { rows } = await query(
    "SELECT * FROM technician_accounts WHERE passcode_lookup = $1 AND active",
    [passcodeLookup(passcode)],
  );
  const tech = rows[0];
  const ok = await bcrypt.compare(passcode, tech?.passcode_hash ?? DUMMY_HASH);
  return ok && tech ? tech : null;
}

export async function startSession(res, tech, req) {
  const sid = crypto.randomUUID();
  const secret = newRefreshSecret();
  await query(
    `INSERT INTO technician_sessions (id, technician_id, refresh_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, now() + $4 * interval '1 millisecond', $5, $6)`,
    [sid, tech.id, sha256(secret), REFRESH_TTL_MS, req.get("user-agent")?.slice(0, 300) ?? null, req.ip],
  );
  setAuthCookies(res, signAccess(tech.id, sid), `${sid}.${secret}`);
}

export async function endSession(req, res) {
  const sid = sessionIdFromCookies(req);
  if (sid) await query("UPDATE technician_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [sid]);
  clearAuthCookies(res);
}

function sessionIdFromCookies(req) {
  const at = req.cookies?.[ACCESS_COOKIE];
  if (at) {
    const decoded = jwt.decode(at);
    if (decoded?.sid) return decoded.sid;
  }
  const rt = req.cookies?.[REFRESH_COOKIE];
  const sid = rt?.split(".")[0];
  return /^[0-9a-f-]{36}$/.test(sid ?? "") ? sid : null;
}

async function loadActiveSession(sid, techId) {
  const { rows } = await query(
    `SELECT s.*, t.id AS tech_id, t.name, t.phone, t.section
       FROM technician_sessions s
       JOIN technician_accounts t ON t.id = s.technician_id
      WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND t.active
        ${techId ? "AND t.id = $2" : ""}`,
    techId ? [sid, techId] : [sid],
  );
  return rows[0] ?? null;
}

const toTechnician = (row) => ({ id: row.tech_id, name: row.name, phone: row.phone, section: row.section, sid: row.id });

// Use the refresh cookie to issue a new token pair. Returns the technician or null.
async function refresh(req, res) {
  const raw = req.cookies?.[REFRESH_COOKIE];
  if (!raw || !raw.includes(".")) return null;
  const [sid, secret] = raw.split(".");
  if (!/^[0-9a-f-]{36}$/.test(sid) || !secret) return null;

  const session = await loadActiveSession(sid);
  if (!session) return null;

  const presented = sha256(secret);
  const isCurrent = crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(session.refresh_hash));

  if (!isCurrent) {
    const isRecentPrev =
      session.prev_refresh_hash &&
      crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(session.prev_refresh_hash)) &&
      Date.now() - new Date(session.rotated_at).getTime() < ROTATION_GRACE_MS;
    if (!isRecentPrev) {
      // An old refresh token was replayed: assume it leaked and kill the session.
      await query("UPDATE technician_sessions SET revoked_at = now() WHERE id = $1", [sid]);
      return null;
    }
    // A parallel request already rotated; just hand out a fresh access token.
    res.cookie(ACCESS_COOKIE, signAccess(session.tech_id, sid), { ...cookieBase, path: "/", maxAge: ACCESS_TTL_SEC * 1000 });
    return toTechnician(session);
  }

  const nextSecret = newRefreshSecret();
  await query(
    `UPDATE technician_sessions
        SET prev_refresh_hash = refresh_hash, refresh_hash = $2, rotated_at = now(), last_used_at = now()
      WHERE id = $1`,
    [sid, sha256(nextSecret)],
  );
  setAuthCookies(res, signAccess(session.tech_id, sid), `${sid}.${nextSecret}`);
  return toTechnician(session);
}

// Resolve the signed-in technician (refreshing tokens if needed), or null.
export async function getTechnician(req, res) {
  const at = req.cookies?.[ACCESS_COOKIE];
  if (at) {
    try {
      const payload = jwt.verify(at, JWT_SECRET, { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"] });
      const session = await loadActiveSession(payload.sid, Number(payload.sub));
      if (session) return toTechnician(session);
      clearAuthCookies(res); // session revoked or technician deactivated
      return null;
    } catch {
      // expired or invalid: fall through to refresh
    }
  }
  return refresh(req, res);
}

// Middleware for technician pages and actions.
export async function requireTechnician(req, res, next) {
  try {
    const tech = await getTechnician(req, res);
    if (!tech) {
      clearAuthCookies(res);
      if (req.method === "GET") return res.redirect("/technician/login");
      return res.status(401).render("technician/login", { title: "Technician Login", error: "Your session has ended. Please log in again." });
    }
    req.technician = tech;
    res.locals.technician = tech;
    next();
  } catch (err) {
    next(err);
  }
}

// Blocks cross-site form posts (CSRF) in addition to SameSite=Strict cookies.
export function sameOriginOnly(req, res, next) {
  const origin = req.get("origin");
  if (origin && origin !== `${req.protocol}://${req.get("host")}`) {
    return res.status(403).send("Cross-site request blocked.");
  }
  next();
}
