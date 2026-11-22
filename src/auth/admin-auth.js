// Admin sign-in: official email + password (bcrypt). Sessions/tokens: see
// session-auth.js. Admins have their own cookies, JWT audience and sessions.
import bcrypt from "bcryptjs";
import { query } from "../db.js";
import { createSessionAuth } from "./session-auth.js";

export const hashPassword = (password) => bcrypt.hash(password, 12);
const DUMMY_HASH = bcrypt.hashSync("not-a-real-admin-password", 12);

// Returns the admin for an email + password, or null.
export async function verifyAdmin(email, password) {
  if (typeof email !== "string" || typeof password !== "string" || !password) {
    await bcrypt.compare("x", DUMMY_HASH);
    return null;
  }
  const { rows } = await query("SELECT * FROM admin_accounts WHERE email = ? AND active = 1", [email.trim().toLowerCase()]);
  const admin = rows[0];
  const ok = await bcrypt.compare(password, admin?.password_hash ?? DUMMY_HASH);
  return ok && admin ? admin : null;
}

const auth = createSessionAuth({
  role: "admin",
  accountTable: "admin_accounts",
  sessionTable: "admin_sessions",
  accountKey: "admin_id",
  columns: ["name", "email", "contact_number", "department"],
  accessCookie: "jc_aat",
  refreshCookie: "jc_art",
  basePath: "/admin",
});

export const { startSession, endSession, revokeAllFor } = auth;
export const getAdmin = auth.getAccount;

// Pages redirect to the login page; JSON API calls get a 401.
export const requireAdmin = auth.requireAccount((req, res) => {
  if (req.path.startsWith("/api/") || req.get("accept")?.includes("application/json")) {
    return res.status(401).json({ error: "Your session has ended. Please sign in again." });
  }
  if (req.method === "GET") return res.redirect("/admin/login");
  return res.status(401).render("admin/login", { title: "Admin Login", error: "Your session has ended. Please sign in again." });
});
