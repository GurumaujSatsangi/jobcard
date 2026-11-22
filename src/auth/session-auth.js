// Shared login sessions for technicians and admins.
//
// - On sign-in a DB session row is created and two httpOnly, SameSite=Strict
//   cookies are set:
//     access   short-lived JWT (15 min) carrying { sub, sid }, audience = role
//     refresh  "<sessionId>.<random>" (7 days), stored only as a SHA-256 hash
// - Every protected request verifies the access JWT and that its session is
//   still active. When the access token has expired the refresh token is used
//   to mint a new pair (rotation). Presenting an old refresh token outside a
//   short grace window is treated as theft and revokes the session.
// - Each role has its own cookies, JWT audience and session table, so a
//   technician token can never be used as an admin token.
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { query } from "../db.js";

const ACCESS_TTL_SEC = 15 * 60;
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ROTATION_GRACE_MS = 30 * 1000; // tolerate parallel requests racing a rotation
const ISSUER = "iacs-jobcard";

const isProd = process.env.NODE_ENV === "production";

export function requireSecret(name) {
  const v = process.env[name];
  if (!v || v.length < 32) throw new Error(`${name} must be set in .env (at least 32 characters).`);
  return v;
}
const JWT_SECRET = requireSecret("JWT_SECRET");

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const newRefreshSecret = () => crypto.randomBytes(32).toString("base64url");
const SID_RE = /^[0-9a-f-]{36}$/;

/**
 * @param {object} o
 * @param {string} o.role            JWT audience, e.g. "technician" or "admin"
 * @param {string} o.accountTable    e.g. "technician_accounts"
 * @param {string} o.sessionTable    e.g. "technician_sessions"
 * @param {string} o.accountKey      session column holding the account id
 * @param {string[]} o.columns       account columns to load (besides id)
 * @param {string} o.accessCookie
 * @param {string} o.refreshCookie
 * @param {string} o.basePath        URL prefix the refresh cookie is limited to
 */
export function createSessionAuth(o) {
  const cookieBase = { httpOnly: true, secure: isProd, sameSite: "strict" };
  const accessOpts = { ...cookieBase, path: "/", maxAge: ACCESS_TTL_SEC * 1000 };
  const refreshOpts = { ...cookieBase, path: o.basePath, maxAge: REFRESH_TTL_MS };

  const setCookies = (res, access, refresh) => {
    res.cookie(o.accessCookie, access, accessOpts);
    if (refresh) res.cookie(o.refreshCookie, refresh, refreshOpts);
  };
  const clearCookies = (res) => {
    res.clearCookie(o.accessCookie, { ...cookieBase, path: "/" });
    res.clearCookie(o.refreshCookie, { ...cookieBase, path: o.basePath });
  };

  const signAccess = (accountId, sid) =>
    jwt.sign({ sid }, JWT_SECRET, {
      subject: String(accountId),
      expiresIn: ACCESS_TTL_SEC,
      issuer: ISSUER,
      audience: o.role,
      algorithm: "HS256",
    });

  const cols = o.columns.map((c) => `a.${c}`).join(", ");
  async function loadActiveSession(sid, accountId) {
    const { rows } = await query(
      `SELECT s.*, a.id AS account_id, ${cols}
         FROM ${o.sessionTable} s
         JOIN ${o.accountTable} a ON a.id = s.${o.accountKey}
        WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP(3) AND a.active = 1
          ${accountId ? "AND a.id = ?" : ""}`,
      accountId ? [sid, accountId] : [sid],
    );
    return rows[0] ?? null;
  }

  const toAccount = (row) => {
    const acc = { id: row.account_id, sid: row.id };
    for (const c of o.columns) acc[c] = row[c];
    return acc;
  };

  async function startSession(res, account, req) {
    const sid = crypto.randomUUID();
    const secret = newRefreshSecret();
    await query(
      `INSERT INTO ${o.sessionTable} (id, ${o.accountKey}, refresh_hash, expires_at, user_agent, ip)
       VALUES (?, ?, ?, UTC_TIMESTAMP(3) + INTERVAL ? SECOND, ?, ?)`,
      [sid, account.id, sha256(secret), Math.round(REFRESH_TTL_MS / 1000), req.get("user-agent")?.slice(0, 300) ?? null, req.ip],
    );
    setCookies(res, signAccess(account.id, sid), `${sid}.${secret}`);
  }

  function sessionIdFromCookies(req) {
    const at = req.cookies?.[o.accessCookie];
    if (at) {
      const decoded = jwt.decode(at);
      if (decoded?.sid && decoded.aud === o.role) return decoded.sid;
    }
    const sid = req.cookies?.[o.refreshCookie]?.split(".")[0];
    return SID_RE.test(sid ?? "") ? sid : null;
  }

  async function endSession(req, res) {
    const sid = sessionIdFromCookies(req);
    if (sid) await query(`UPDATE ${o.sessionTable} SET revoked_at = UTC_TIMESTAMP(3) WHERE id = ? AND revoked_at IS NULL`, [sid]);
    clearCookies(res);
  }

  async function revokeAllFor(accountId) {
    await query(`UPDATE ${o.sessionTable} SET revoked_at = UTC_TIMESTAMP(3) WHERE ${o.accountKey} = ? AND revoked_at IS NULL`, [accountId]);
  }

  async function refresh(req, res) {
    const raw = req.cookies?.[o.refreshCookie];
    if (!raw || !raw.includes(".")) return null;
    const [sid, secret] = raw.split(".");
    if (!SID_RE.test(sid) || !secret) return null;

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
        await query(`UPDATE ${o.sessionTable} SET revoked_at = UTC_TIMESTAMP(3) WHERE id = ?`, [sid]);
        return null;
      }
      // A parallel request already rotated; just hand out a fresh access token.
      setCookies(res, signAccess(session.account_id, sid));
      return toAccount(session);
    }

    // Rotate only if nobody rotated since we read the row (MySQL applies SET
    // left to right, so prev_refresh_hash receives the old value).
    const nextSecret = newRefreshSecret();
    const rotated = await query(
      `UPDATE ${o.sessionTable}
          SET prev_refresh_hash = refresh_hash, refresh_hash = ?,
              rotated_at = UTC_TIMESTAMP(3), last_used_at = UTC_TIMESTAMP(3)
        WHERE id = ? AND refresh_hash = ?`,
      [sha256(nextSecret), sid, session.refresh_hash],
    );
    if (!rotated.rowCount) {
      setCookies(res, signAccess(session.account_id, sid)); // a parallel request rotated first
      return toAccount(session);
    }
    setCookies(res, signAccess(session.account_id, sid), `${sid}.${nextSecret}`);
    return toAccount(session);
  }

  // The signed-in account (refreshing tokens if needed), or null.
  async function getAccount(req, res) {
    const at = req.cookies?.[o.accessCookie];
    if (at) {
      try {
        const payload = jwt.verify(at, JWT_SECRET, { issuer: ISSUER, audience: o.role, algorithms: ["HS256"] });
        const session = await loadActiveSession(payload.sid, Number(payload.sub));
        if (session) return toAccount(session);
        clearCookies(res); // session revoked or account deactivated
        return null;
      } catch {
        // expired or invalid: fall through to refresh
      }
    }
    return refresh(req, res);
  }

  // Express middleware. onMissing(req, res) decides how to answer when not signed in.
  const requireAccount = (onMissing) => async (req, res, next) => {
    try {
      const account = await getAccount(req, res);
      if (!account) {
        clearCookies(res);
        return onMissing(req, res);
      }
      req[o.role] = account;
      res.locals[o.role] = account;
      next();
    } catch (err) {
      next(err);
    }
  };

  return { startSession, endSession, getAccount, requireAccount, clearCookies, revokeAllFor };
}

// Blocks cross-site form posts (CSRF) in addition to SameSite=Strict cookies.
export function sameOriginOnly(req, res, next) {
  const origin = req.get("origin");
  if (origin && origin !== `${req.protocol}://${req.get("host")}`) {
    return res.status(403).send("Cross-site request blocked.");
  }
  next();
}
