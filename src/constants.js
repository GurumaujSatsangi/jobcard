// Sections that accept job cards, with their help-desk extension numbers.
export const SECTIONS = [
  { value: "AC_REFRIGERATION", label: "Air Conditioning & Refrigeration Section", extension: "2170", icon: "snow", arnCode: "AC" },
  { value: "GLASS_BLOWING", label: "Glass Blowing Section", extension: "1703", icon: "cup-straw", arnCode: "GB" },
  { value: "ELECTRICAL", label: "Electrical Section", extension: "1704", icon: "lightning-charge", arnCode: "ELEC" },
  { value: "MECHANICAL", label: "Mechanical Section", extension: "1700 / 1164", icon: "gear", arnCode: "MECH" },
  { value: "INTERCOM_EPABX", label: "Intercom / EPABX Section", extension: "9", icon: "telephone", arnCode: "EPABX" },
];

export const AC_ITEM_TYPES = [
  { value: "AIR_CONDITIONER", label: "Air Conditioners (CREW Number required)" },
  { value: "REFRIGERATOR", label: "Refrigerators (Non AC Items - Refrigerators/ Chillers, Etc.)" },
];

// Job card lifecycle, in order.
export const STATUS = {
  SUBMITTED: "APPLICATION SUBMITTED",
  TECHNICIAN_ASSIGNED: "TECHNICIAN ASSIGNED",
  MATERIAL_ISSUED: "MATERIAL ISSUED BY STORE IN-CHARGE",
  CLOSED: "APPLICATION CLOSED",
};

// Preventive services: four per AC per year, raised by an admin.
export const PREVENTIVE_TYPES = [1, 2, 3, 4].map((n) => ({ value: n, label: `Preventive Service ${n}` }));
export const PS_STATUS = { ASSIGNED: "ASSIGNED", CLOSED: "CLOSED" };

export const OFFICIAL_EMAIL_DOMAIN = "iacs.res.in";

export const HELPDESK = {
  email: "onlinejobcard@iacs.res.in",
  extension: "1703",
};

// CREW serial numbers look like "IACS/CREW/AC/00001". People may type just the
// number ("1", "00001") or the full code in any case; turn all of those into
// the full code. Anything else is returned upper-cased and simply won't match.
export function normalizeCrewSerial(input) {
  const s = String(input ?? "").trim();
  const m = s.match(/^(?:IACS\s*\/\s*CREW\s*\/\s*AC\s*\/\s*)?0*(\d{1,5})$/i);
  return m ? `IACS/CREW/AC/${m[1].padStart(5, "0")}` : s.toUpperCase();
}

export const sectionLabel = (value) => SECTIONS.find((s) => s.value === value)?.label ?? value;
export const itemTypeLabel = (value) => AC_ITEM_TYPES.find((t) => t.value === value)?.label ?? value;

// Store units of measurement. `decimal` = can be issued in fractions (15.46 cm).
export const STORE_UNITS = [
  { value: "Nos", label: "Units (Number)", decimal: false },
  { value: "kg", label: "Kilogram (Kg)", decimal: true },
  { value: "Boxes", label: "Number of Boxes", decimal: false },
  { value: "Canes", label: "Number of Canes", decimal: false },
  { value: "m", label: "Metre (m)", decimal: true },
  { value: "cm", label: "Centimetre (cm)", decimal: true },
  { value: "L", label: "Litre (L)", decimal: true },
  { value: "inch", label: "Inch", decimal: true },
  { value: "ft", label: "Feet", decimal: true },
  { value: "g", label: "Gram", decimal: true },
  { value: "sq inch", label: "Square Inch", decimal: true },
];

// Application Reference Numbers: WS/<section code>/<7-digit counter>, e.g.
// WS/AC/0000001. Each section has its own counter (arn_counters prefix = code,
// year = 0 because the number never resets).
export const arnFor = (section, n) =>
  `WS/${SECTIONS.find((s) => s.value === section).arnCode}/${String(n).padStart(7, "0")}`;

// ARNs contain "/", which some web servers refuse inside a URL path even when
// encoded. In URLs we write them with "-" (WS-AC-0000001) and turn them back
// here. Older ARNs (JC2026000001) have no "-" or "/" and pass through as-is.
export const arnFromParam = (v) => String(v ?? "").trim().toUpperCase().replace(/-/g, "/");
export const arnPath = (arn) => encodeURIComponent(String(arn).replace(/\//g, "-"));

// Sections whose job cards ask for the Room / Lab number.
export const ROOM_SECTIONS = ["ELECTRICAL", "INTERCOM_EPABX"];
