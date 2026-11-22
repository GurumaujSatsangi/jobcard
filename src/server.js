import "dotenv/config";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import { initDb } from "./db.js";
import apiRouter, { UPLOAD_DIR } from "./routes/api.js";
import technicianRouter from "./routes/technician.js";
import adminRouter from "./routes/admin.js";
import { SECTIONS, AC_ITEM_TYPES, HELPDESK, OFFICIAL_EMAIL_DOMAIN } from "./constants.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Set TRUST_PROXY=1 when running behind nginx / a load balancer so req.ip and
// rate limiting use the real client address.
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
app.disable("x-powered-by");

app.set("view engine", "ejs");
app.set("views", path.resolve("views"));

app.use((_req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
  });
  next();
});
// Key for signed cookies (one-time flash messages), derived from JWT_SECRET.
const cookieSecret = crypto.createHmac("sha256", process.env.JWT_SECRET ?? "").update("cookie-signing").digest("hex");
app.use(cookieParser(cookieSecret));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.resolve("public")));
app.use("/vendor/bootstrap", express.static(path.resolve("node_modules/bootstrap/dist")));
app.use("/vendor/bootstrap-icons", express.static(path.resolve("node_modules/bootstrap-icons/font")));

app.locals.SECTIONS = SECTIONS;
app.locals.AC_ITEM_TYPES = AC_ITEM_TYPES;
app.locals.HELPDESK = HELPDESK;
app.locals.OFFICIAL_EMAIL_DOMAIN = OFFICIAL_EMAIL_DOMAIN;
app.locals.year = new Date().getFullYear();

app.get("/", (_req, res) => res.render("index", { title: "Online Job Card Portal" }));

// Placeholder until the store module is built.
app.get("/store/login", (_req, res) => res.render("store/login", { title: "Store Login" }));

app.use("/api", apiRouter);
app.use("/technician", technicianRouter);
app.use("/admin", adminRouter);

app.use((_req, res) => res.redirect("/"));

app.use((err, req, res, _next) => {
  console.error(err);
  if (req.path.startsWith("/api")) {
    return res.status(500).json({ error: "Something went wrong. Please try again later." });
  }
  res.status(500).send("Something went wrong.");
});

await initDb();
app.listen(PORT, () => console.log(`Job Card Portal running at http://localhost:${PORT}`));
