// Store in-charge sign-in: official email + password (bcrypt). Sessions/tokens:
// see session-auth.js. Store users have their own cookies, JWT audience and sessions.
import bcrypt from "bcryptjs";
import { query } from "../db.js";
import { createSessionAuth } from "./session-auth.js";

export const hashPassword = (password) => bcrypt.hash(password, 12);
const DUMMY_HASH = bcrypt.hashSync("not-a-real-store-password", 12);

// Returns the store account for an email + password, or null.
export async function verifyStore(email, password) {
  if (typeof email !== "string" || typeof password !== "string" || !password) {
    await bcrypt.compare("x", DUMMY_HASH);
    return null;
  }
  const { rows } = await query("SELECT * FROM store_accounts WHERE email = ? AND active = 1", [email.trim().toLowerCase()]);
  const account = rows[0];
  const ok = await bcrypt.compare(password, account?.password_hash ?? DUMMY_HASH);
  return ok && account ? account : null;
}

const auth = createSessionAuth({
  role: "store",
  accountTable: "store_accounts",
  sessionTable: "store_sessions",
  accountKey: "store_id",
  columns: ["name", "email", "contact_number"],
  accessCookie: "jc_sat",
  refreshCookie: "jc_srt",
  basePath: "/store",
});

export const { startSession, endSession, revokeAllFor } = auth;
export const getStoreUser = auth.getAccount;

// Pages redirect to the login page; JSON API calls get a 401.
export const requireStore = auth.requireAccount((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Your session has ended. Please sign in again." });
  }
  if (req.method === "GET") return res.redirect("/store/login");
  return res.status(401).render("store/login", { title: "Store Login", error: "Your session has ended. Please sign in again.", email: "" });
});
