// Technician sign-in: 6-digit passcode only (no user ID).
// The passcode is looked up by HMAC (keyed with PASSCODE_PEPPER) and then
// verified against a bcrypt hash. Sessions/tokens: see session-auth.js.
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { query } from "../db.js";
import { createSessionAuth, requireSecret, sameOriginOnly } from "./session-auth.js";

export const PASSCODE_LENGTH = 6;
const PASSCODE_PEPPER = requireSecret("PASSCODE_PEPPER");

export const passcodeLookup = (passcode) =>
  crypto.createHmac("sha256", PASSCODE_PEPPER).update(passcode).digest("hex");
export const hashPasscode = (passcode) => bcrypt.hash(passcode, 12);

// A dummy hash so failed lookups take as long as real ones (no timing hint).
const DUMMY_HASH = bcrypt.hashSync("000000-not-a-real-passcode", 12);

// Returns the technician for a passcode, or null.
export async function verifyPasscode(passcode) {
  if (typeof passcode !== "string" || !new RegExp(`^\\d{${PASSCODE_LENGTH}}$`).test(passcode)) {
    await bcrypt.compare("x", DUMMY_HASH);
    return null;
  }
  const { rows } = await query(
    "SELECT * FROM technician_accounts WHERE passcode_lookup = ? AND active = 1",
    [passcodeLookup(passcode)],
  );
  const tech = rows[0];
  const ok = await bcrypt.compare(passcode, tech?.passcode_hash ?? DUMMY_HASH);
  return ok && tech ? tech : null;
}

const auth = createSessionAuth({
  role: "technician",
  accountTable: "technician_accounts",
  sessionTable: "technician_sessions",
  accountKey: "technician_id",
  columns: ["name", "phone", "section"],
  accessCookie: "jc_tat",
  refreshCookie: "jc_trt",
  basePath: "/technician",
});

export const { startSession, endSession, revokeAllFor } = auth;
export const getTechnician = auth.getAccount;
export const clearAuthCookies = auth.clearCookies;

export const requireTechnician = auth.requireAccount((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Your session has ended. Please log in again." });
  }
  if (req.method === "GET") return res.redirect("/technician/login");
  return res.status(401).render("technician/login", {
    title: "Technician Login",
    error: "Your session has ended. Please log in again.",
  });
});

export { sameOriginOnly };
