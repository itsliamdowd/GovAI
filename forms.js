// Predefined applications: the exact information the city asks for, taken from the cited santamonica.gov page.
// The browser renders FORMS[type] as a one-question-at-a-time card; toApplication() maps answers to submitApplication's shape.
const contact = [
  { key: "applicant_name", label: "Your full name", type: "text" },
  { key: "email", label: "Email address", type: "email", hint: "Confirmation and department follow-up go here." },
  { key: "phone", label: "Phone number", type: "tel" },
];
const yesNo = ["Yes", "No"];

export const FORMS = {
  block_party_permit: {
    title: "Block Party Permit",
    intro: "Fee $100.95, paid after approval. Apply at least 14 calendar days ahead (30 around holidays). Transportation Planning reviews it.",
    source: "https://www.santamonica.gov/process-explainers/how-to-get-a-block-party-permit",
    fields: [
      { key: "event_date", label: "Date of the block party", type: "date", minDays: 14, hint: "At least 14 calendar days from today; 30 if it's around a holiday." },
      { key: "event_hours", label: "Start and end time", type: "timerange" },
      { key: "street_block", label: "Street and block to close", type: "text", placeholder: "e.g. 1100 block of Euclid St, between Wilshire and California", hint: "Must be an eligible street on the city's block party map." },
      { key: "zoning", label: "Is your block mostly single-family (R-1) homes?", type: "select", options: ["Yes — 51% of residents/businesses must sign the petition", "No — 25% must sign", "Not sure"] },
      { key: "petition", label: "Neighbor petition signatures", type: "select", options: ["Already collected", "Will collect through the online petition", "Need the paper petition form"] },
      { key: "expected_attendance", label: "Expected number of people", type: "number" },
      { key: "address", label: "Your address on the block", type: "text" },
      ...contact,
    ],
  },
  preferential_parking_permit: {
    title: "Preferential Parking Permit",
    intro: "Residential permits (vehicle-specific) $41 for the first; visitor permits (any vehicle, max 2) $72. Processing takes 3–5 business days.",
    source: "https://www.santamonica.gov/process-explainers/how-to-obtain-a-preferential-parking-permit",
    fields: [
      { key: "permit_kind", label: "Which permit do you need?", type: "select", options: ["Residential — tied to one vehicle ($41 first, $51 second, $95 third, $148 fourth+)", "Visitor — usable in any vehicle ($72 each, max 2)"] },
      { key: "quantity", label: "How many permits?", type: "number" },
      { key: "address", label: "Your Santa Monica address (including unit)", type: "text", hint: "Must be inside a preferential parking zone." },
      { key: "zone", label: "Your parking zone", type: "select", options: ["Zone 1", "Zone 2", "Zone 3", "Zone 4", "Zone 5", "Not sure"] },
      { key: "vehicle", label: "Vehicle license plate, make and model", type: "text", hint: "Residential permits only. DMV registration must match your name and this address. Type N/A for visitor permits.", placeholder: "e.g. 8ABC123, Toyota Prius" },
      { key: "id_type", label: "Government-issued photo ID you will upload", type: "select", options: ["Driver's license", "Passport", "Other government ID"] },
      { key: "residency_proof", label: "Proof of residency you will upload (dated within 30 days, in your name, at this address)", type: "select", options: ["Utility, cable or internet bill", "Bank, credit card or mortgage statement"] },
      ...contact,
    ],
  },
  bulky_item_pickup: {
    title: "Bulky Item Pickup",
    intro: "Up to 5 items per request; collected Monday–Friday, usually within 7–10 days. No construction debris or hazardous waste.",
    source: "https://www.santamonica.gov/process-explainers/how-to-request-bulky-and-abandoned-item-collection",
    fields: [
      { key: "address", label: "Pickup address", type: "text" },
      { key: "unit", label: "Unit number", type: "text", optional: true, hint: "If you live in an apartment or condo." },
      { key: "items", label: "What are the items? (max 5)", type: "textarea", placeholder: "e.g. 1 queen mattress, 1 couch, 1 bookshelf", hint: "Refrigerators and freezers are picked up by a separate truck. Tree trimmings: bundles under 3 ft and 10 lb, max 4." },
      { key: "placement", label: "Where will the items be?", type: "select", options: ["Front curb", "Alley behind the property"] },
      ...contact,
    ],
  },
  business_license: {
    title: "Business License Application",
    intro: "Required for any business operating or based in Santa Monica. Review takes about 5 business days; you may not open until the certificate is issued.",
    source: "https://www.santamonica.gov/process-explainers/starting-a-business-in-santa-monica",
    fields: [
      { key: "business_name", label: "Business name", type: "text" },
      { key: "business_type", label: "What does the business do?", type: "text", placeholder: "e.g. coffee shop, graphic design, general contractor" },
      { key: "business_address", label: "Business address in Santa Monica", type: "text", hint: "Home-based businesses use the home address." },
      { key: "start_date", label: "Planned start date", type: "date" },
      { key: "structure", label: "Ownership structure", type: "select", options: ["Sole proprietor", "Partnership", "LLC", "Corporation", "Non-profit"] },
      { key: "sellers_permit", label: "Will you sell goods (retail or wholesale)?", type: "select", options: ["Yes — I have a California Seller's Permit", "Yes — I still need a Seller's Permit", "No"], hint: "Retail and wholesale need a state Seller's Permit (CDTFA) before the city license issues." },
      { key: "special", label: "Does it involve alcohol, live entertainment, firearms, secondhand goods, massage or industrial wastewater?", type: "select", options: ["No", "Yes"], hint: "These need a supplemental police or wastewater permit." },
      ...contact,
    ],
  },
  dog_license: {
    title: "Dog License",
    intro: "Annual license from the Santa Monica Animal Shelter: $37.26 spayed/neutered, $74.52 otherwise. Current rabies vaccination certificate required.",
    source: "https://www.santamonica.gov/categories/services/animal-services",
    fields: [
      { key: "dog_name", label: "Dog's name", type: "text" },
      { key: "dog_description", label: "Breed, color and age", type: "text", placeholder: "e.g. Labrador mix, black, 3 years" },
      { key: "altered", label: "Spayed or neutered?", type: "select", options: ["Yes ($37.26/yr)", "No ($74.52/yr)"] },
      { key: "rabies_expiry", label: "Rabies vaccination expiration date", type: "date", hint: "You will upload the vaccination certificate from your vet." },
      { key: "address", label: "Owner's address", type: "text" },
      ...contact,
    ],
  },
  community_event_permit: {
    title: "Community Event Permit",
    intro: "For events of 150+ people, street closures or temporary structures. Apply 30 days ahead (60 for street closures); Police/Fire approvals due 10 days before the event.",
    source: "https://www.santamonica.gov/process-explainers/how-to-obtain-a-community-event-permit",
    fields: [
      { key: "event_name", label: "Event name", type: "text" },
      { key: "event_date", label: "Event date", type: "date" },
      { key: "event_hours", label: "Start and end time (including setup and cleanup)", type: "timerange" },
      { key: "address", label: "Location (park, beach, street or venue)", type: "text" },
      { key: "expected_attendance", label: "Expected attendance", type: "number" },
      { key: "street_closure", label: "Will any street or sidewalk be closed?", type: "select", options: yesNo },
      { key: "alcohol", label: "Will alcohol be served or sold?", type: "select", options: yesNo, hint: "Requires a state ABC license." },
      { key: "amplified_sound", label: "Amplified sound, tents, generators or cooking?", type: "select", options: yesNo, hint: "Tents, generators and cooking need Fire Department permits." },
      { key: "organization", label: "Organization (or 'individual')", type: "text" },
      ...contact,
    ],
  },
  "311_service_request": {
    title: "311 Service Request",
    intro: "Routed to the responsible city division; most requests are acknowledged within 2 business days. Emergencies: call 911.",
    source: "https://www.santamonica.gov/311",
    fields: [
      { key: "category", label: "What needs attention?", type: "select", options: ["Pothole", "Graffiti", "Streetlight out", "Missed trash/recycling pickup", "Illegal dumping", "Abandoned vehicle", "Sidewalk repair", "Tree issue", "Noise or code complaint", "Other"] },
      { key: "address", label: "Where is it?", type: "text", placeholder: "Street address or nearest intersection" },
      { key: "description", label: "Describe the problem", type: "textarea" },
      ...contact,
    ],
  },
};

export const FORM_TYPES = Object.keys(FORMS);

// Validates answers against the form and returns the submit_application input, or throws with a resident-readable message.
export function toApplication(type, fields = {}) {
  const f = FORMS[type]; if (!f) throw new Error(`No form for ${type}`);
  const v = (k) => String(fields[k] ?? "").trim();
  for (const fld of f.fields) if (!fld.optional && !v(fld.key)) throw new Error(`${fld.label} is required`);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v("email"))) throw new Error("Email address looks invalid");
  const used = new Set(["applicant_name", "email", "phone"]);
  const pick = (...keys) => { for (const k of keys) if (v(k)) { used.add(k); return v(k); } return ""; };
  const address = pick("address", "street_block", "business_address");
  const requested_date = pick("event_date", "start_date");
  const headline = pick("event_name", "business_name", "dog_name", "category", "items", "permit_kind");
  const details = f.fields.filter((x) => !used.has(x.key) && v(x.key)).map((x) => `${x.label}: ${v(x.key)}`).join("\n");
  return { type, applicant_name: v("applicant_name"), email: v("email"), phone: v("phone"), address, requested_date,
    summary: headline ? `${f.title} — ${headline.split("\n")[0].slice(0, 80)}` : f.title, details };
}
