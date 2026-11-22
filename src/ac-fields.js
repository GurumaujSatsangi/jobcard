// The editable ac_units columns, shared by the admin AC form (rendered in the
// browser) and server-side validation. crew_serial_number is derived from sr_no.
//
// type: text | date | money | yesno | choice
export const AC_FIELDS = [
  { key: "sr_no", label: "SR No.", type: "int", group: "Identification", required: true, help: "CREW serial number becomes IACS/CREW/AC/<SR No.>" },
  { key: "brand", label: "Brand", type: "text", group: "Unit", max: 64 },
  { key: "ac_type", label: "Type", type: "choice", group: "Unit", options: ["Split", "Window", "Cassette", "Ductable", "Package", "Air Handling Unit", "EMSON"] },
  { key: "capacity_tr", label: "Capacity (Ton)", type: "text", group: "Unit", max: 16 },
  { key: "indoor_serial_no", label: "Indoor unit serial no.", type: "text", group: "Unit", max: 64 },
  { key: "outdoor_serial_no", label: "Outdoor unit serial no.", type: "text", group: "Unit", max: 64 },
  { key: "timer_installed", label: "Timer installed", type: "yesno", group: "Unit" },
  { key: "working_condition", label: "Working condition (01-05-2023)", type: "choice", group: "Unit", options: ["Yes", "No", "New"] },

  { key: "room_number", label: "Room No.", type: "text", group: "Location", max: 128 },
  { key: "in_charge", label: "Faculty / Staff / In-charge", type: "text", group: "Location", max: 255 },
  { key: "school", label: "School", type: "text", group: "Location", max: 128 },
  { key: "installation_date", label: "Date of installation", type: "date", group: "Location" },

  { key: "gem_order_no", label: "GeM order no.", type: "text", group: "Purchase", max: 64 },
  { key: "gem_order_date", label: "GeM order date", type: "date", group: "Purchase" },
  { key: "unit_price", label: "Unit price (₹)", type: "money", group: "Purchase" },
  { key: "purchase_type", label: "Replacement or new - details", type: "text", group: "Purchase", max: 64 },

  { key: "under_warranty", label: "Under warranty", type: "yesno", group: "Warranty & AMC" },
  { key: "warranty_start_date", label: "Warranty start", type: "date", group: "Warranty & AMC" },
  { key: "warranty_end_date", label: "Warranty end", type: "date", group: "Warranty & AMC" },
  { key: "amc", label: "AMC", type: "choice", group: "Warranty & AMC", options: ["Yes", "No", "New"] },
  { key: "amc_work_order_no", label: "AMC work order no.", type: "text", group: "Warranty & AMC", max: 255 },
  { key: "amc_start_date", label: "AMC start", type: "date", group: "Warranty & AMC" },
  { key: "amc_end_date", label: "AMC end", type: "date", group: "Warranty & AMC" },

  { key: "replaced", label: "Replaced", type: "yesno", group: "Replacement unit" },
  { key: "replacement_capacity_tr", label: "Capacity (Ton)", type: "text", group: "Replacement unit", max: 16 },
  { key: "replacement_indoor_serial_no", label: "Indoor unit serial no.", type: "text", group: "Replacement unit", max: 64 },
  { key: "replacement_outdoor_serial_no", label: "Outdoor unit serial no.", type: "text", group: "Replacement unit", max: 64 },
  { key: "replacement_brand", label: "Replaced brand", type: "text", group: "Replacement unit", max: 64 },
  { key: "replacement_gem_order", label: "GeM order details", type: "text", group: "Replacement unit", max: 255 },
  { key: "replacement_installation_date", label: "Date of installation", type: "date", group: "Replacement unit" },
  { key: "replacement_unit_price", label: "Unit price (₹)", type: "money", group: "Replacement unit" },
];

// Validate a submitted AC. Returns { data, errors } with data ready for SQL.
export function validateAc(body) {
  const data = {};
  const errors = {};
  for (const f of AC_FIELDS) {
    const raw = body[f.key];
    const v = raw === null || raw === undefined ? "" : String(raw).trim();
    if (!v) {
      if (f.required) errors[f.key] = `${f.label} is required.`;
      data[f.key] = null;
      continue;
    }
    switch (f.type) {
      case "int":
        if (!/^\d{1,5}$/.test(v) || Number(v) < 1) errors[f.key] = "Enter a number from 1 to 99999.";
        else data[f.key] = Number(v);
        break;
      case "money":
        if (!/^\d{1,10}(\.\d{1,2})?$/.test(v)) errors[f.key] = "Enter an amount like 45000 or 45000.50.";
        else data[f.key] = v;
        break;
      case "date": {
        const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        const ok = m && !Number.isNaN(Date.UTC(+m[1], +m[2] - 1, +m[3])) && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDate() === +m[3];
        if (!ok) errors[f.key] = "Enter a valid date.";
        else data[f.key] = v;
        break;
      }
      case "yesno":
        if (!["0", "1"].includes(v)) errors[f.key] = "Choose Yes or No.";
        else data[f.key] = Number(v);
        break;
      case "choice":
        if (!f.options.includes(v)) errors[f.key] = "Choose one of the options.";
        else data[f.key] = v;
        break;
      default:
        if (f.max && v.length > f.max) errors[f.key] = `Keep it under ${f.max} characters.`;
        else data[f.key] = v;
    }
  }
  return { data, errors };
}
