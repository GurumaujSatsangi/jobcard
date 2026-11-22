// Sections that accept job cards, with their help-desk extension numbers.
export const SECTIONS = [
  { value: "AC_REFRIGERATION", label: "Air Conditioning & Refrigeration Section", extension: "2170", icon: "snow" },
  { value: "GLASS_BLOWING", label: "Glass Blowing Section", extension: "1703", icon: "cup-straw" },
  { value: "ELECTRICAL", label: "Electrical Section", extension: "1704", icon: "lightning-charge" },
  { value: "MECHANICAL", label: "Mechanical Section", extension: "1700 / 1164", icon: "gear" },
  { value: "INTERCOM_EPABX", label: "Intercom / EPABX Section", extension: "9", icon: "telephone" },
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
