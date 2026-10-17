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
      { key: "zoning", label: "Is your block mostly single-family (R-1) homes?", type: "select", options: ["Yes - 51% of residents/businesses must sign the petition", "No - 25% must sign", "Not sure"] },
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
      { key: "permit_kind", label: "Which permit do you need?", type: "select", options: ["Residential - tied to one vehicle ($41 first, $51 second, $95 third, $148 fourth+)", "Visitor - usable in any vehicle ($72 each, max 2)"] },
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
      { key: "sellers_permit", label: "Will you sell goods (retail or wholesale)?", type: "select", options: ["Yes - I have a California Seller's Permit", "Yes - I still need a Seller's Permit", "No"], hint: "Retail and wholesale need a state Seller's Permit (CDTFA) before the city license issues." },
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
  council_comment: {
    title: "Public Comment to City Council",
    intro: "Written public comment is forwarded to the City Clerk and the Council and entered into the record for the meeting you pick. Check the agenda for the deadline; speaking at the meeting is separate.",
    source: "https://www.santamonica.gov/city-council",
    fields: [
      { key: "meeting", label: "Which meeting?", type: "select", options: [] }, // options = the jurisdiction's upcoming meetings, filled by server.js withMeetings()
      { key: "agenda_item", label: "Agenda item number or topic", type: "text", optional: true, placeholder: "e.g. Item 7A, pier parking rates", hint: "Leave blank for general public comment on something not on the agenda." },
      { key: "position", label: "Your position", type: "select", options: ["Support", "Oppose", "Neutral / information only"] },
      { key: "comment", label: "Your comment", type: "textarea", hint: "Entered into the public record as written. About 250 words reads in two minutes." },
      { key: "address", label: "Street address or neighborhood", type: "text", optional: true, hint: "Optional. Tells the Council which part of the city is speaking." },
      ...contact,
    ],
  },
  illegal_dumping: {
    title: "Illegal Dumping Report",
    intro: "Report items dumped on a street, alley, sidewalk or public lot. Santa Monica 311 routes it to the crew that collects it; hazardous materials (paint, chemicals, oil) get a separate pickup.",
    source: "https://www.santamonica.gov/311",
    fields: [
      { key: "address", label: "Where is it?", type: "text", placeholder: "Street address, alley or nearest intersection" },
      { key: "category", label: "What was dumped?", type: "select", options: ["Furniture or mattress", "Construction debris", "Bags of trash", "Appliance or electronics", "Hazardous (paint, chemicals, oil, needles)", "Other"] },
      { key: "amount", label: "How much is there?", type: "select", options: ["A few items", "About a pickup-truck load", "More than a truck load"] },
      { key: "blocking", label: "Is it blocking anything?", type: "select", options: ["Sidewalk", "Street, bike lane or driveway", "Alley", "No"] },
      { key: "description", label: "Anything else?", type: "textarea", optional: true, hint: "A vehicle description or plate if you saw it happen; a landmark that helps the crew find it." },
      ...contact,
    ],
  },
  graffiti_removal: {
    title: "Graffiti Removal Request",
    intro: "Graffiti on public property is removed by the city; on private property the owner is notified. Offensive or hate graffiti is prioritized.",
    source: "https://www.santamonica.gov/311",
    fields: [
      { key: "address", label: "Where is it?", type: "text", placeholder: "Street address or nearest intersection" },
      { key: "category", label: "What is it on?", type: "select", options: ["Public building, sign or bench", "Sidewalk, curb or street", "Utility box, pole or meter", "Wall or fence on private property", "Other"] },
      { key: "offensive", label: "Is it hateful, obscene or gang-related?", type: "select", options: yesNo, hint: "These are prioritized." },
      { key: "size", label: "How big is it?", type: "select", options: ["Smaller than a sheet of paper", "Up to a door", "Larger than a door"] },
      { key: "description", label: "Anything else?", type: "textarea", optional: true, hint: "Which side of the building, how high up, colors used." },
      ...contact,
    ],
  },
  pothole_street_repair: {
    title: "Pothole / Street Repair Request",
    intro: "Potholes, sunken or broken pavement and missing utility covers on city streets. Santa Monica 311 routes it to the street crew; state highways (PCH, Lincoln south of the 10) go to Caltrans.",
    source: "https://www.santamonica.gov/311",
    fields: [
      { key: "address", label: "Where is it?", type: "text", placeholder: "Street address or nearest intersection" },
      { key: "category", label: "What's the problem?", type: "select", options: ["Pothole", "Sunken or raised pavement", "Cracked or broken pavement", "Missing or loose manhole / utility cover", "Other"] },
      { key: "lane", label: "Where in the street?", type: "select", options: ["Travel lane", "Bike lane", "Parking lane or gutter", "Alley", "Crosswalk or intersection"] },
      { key: "size", label: "How big is it?", type: "select", options: ["Smaller than a dinner plate", "Dinner plate to tire-sized", "Larger than a tire"] },
      { key: "description", label: "Anything else?", type: "textarea", optional: true, hint: "Direction of travel, which side of the street, whether it has damaged a vehicle." },
      ...contact,
    ],
  },
  streetlight_outage: {
    title: "Streetlight Outage Report",
    intro: "Streetlights that are out, flickering, on during the day or damaged. A pole number gets the crew to the right light fastest.",
    source: "https://www.santamonica.gov/311",
    fields: [
      { key: "address", label: "Where is the light?", type: "text", placeholder: "Street address or nearest intersection" },
      { key: "pole_number", label: "Pole number, if you can see it", type: "text", optional: true, hint: "Printed on a metal tag on the pole, about eye level." },
      { key: "category", label: "What's wrong?", type: "select", options: ["Out completely", "Flickering or cycling on and off", "On during the day", "Pole damaged or leaning", "Exposed wires or open panel"] },
      { key: "extent", label: "How many lights?", type: "select", options: ["One light", "Several on the block", "The whole block or street"] },
      { key: "description", label: "Anything else?", type: "textarea", optional: true, hint: "Which side of the street, which corner, when you noticed it." },
      ...contact,
    ],
  },
  missed_trash_pickup: {
    title: "Missed Trash Pickup",
    intro: "Report a missed trash, recycling or organics collection. Report it the next business day after your service day; containers left out past then may be charged a return trip.",
    source: "https://www.santamonica.gov/311",
    fields: [
      { key: "address", label: "Service address", type: "text", placeholder: "Street address (including unit)" },
      { key: "category", label: "Which container was missed?", type: "select", options: ["Trash (black)", "Recycling (blue)", "Organics / green waste", "All of them"] },
      { key: "service_day", label: "What was your scheduled collection day?", type: "select", options: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] },
      { key: "out_on_time", label: "Was the container at the curb by 6 a.m.?", type: "select", options: yesNo },
      { key: "description", label: "Anything else?", type: "textarea", optional: true, hint: "Container blocked, lid open, overfilled, or a note left by the driver." },
      ...contact,
    ],
  },
  "311_service_request": {
    title: "311 Service Request",
    intro: "Routed to the responsible city division; most requests are acknowledged within 2 business days. Emergencies: call 911.",
    source: "https://www.santamonica.gov/311",
    fields: [
      { key: "category", label: "What needs attention?", type: "select", options: ["Abandoned vehicle", "Sidewalk repair", "Tree issue", "Noise or code complaint", "Homeless outreach request", "Other"] }, // potholes, graffiti, streetlights, dumping, missed pickups have their own cards
      { key: "address", label: "Where is it?", type: "text", placeholder: "Street address or nearest intersection" },
      { key: "description", label: "Describe the problem", type: "textarea" },
      ...contact,
    ],
  },
};

for (const f of Object.values(FORMS)) f.jur ??= "santa-monica"; // the definitions above are Santa Monica's exact process and fees
export const FORM_TYPES = Object.keys(FORMS);
export const formsFor = () => FORM_TYPES; // every jurisdiction gets every card (see formFor)

// Every city gets the same cards. In Santa Monica the card is the exact city process; elsewhere it collects the common
// fields, says it's filed with that city, and the city confirms fees, deadlines and documents on review.
// ponytail: one generic variant per type; add a per-city override table when a city's real process is wired in.
const GENERIC = {
  block_party_permit: { intro: "Closing a street for a block party needs the city's approval; most cities want 2–4 weeks' notice and a neighbor petition, and confirm the fee on review.", drop: ["zoning"],
    fields: { petition: { label: "Have your neighbors on the block agreed?", options: ["Yes, most have signed or agreed", "Not yet", "Not sure what's required"] }, street_block: { hint: "" }, event_date: { hint: "Give the city at least two weeks; more around holidays." } } },
  preferential_parking_permit: { intro: "Residential parking permits are issued for homes inside a permit zone; fees and proof-of-residency rules vary by city.",
    fields: { permit_kind: { options: ["Residential - tied to one vehicle", "Visitor - usable in any vehicle"] }, address: { label: "Your address (including unit)", hint: "Must be inside a permit parking zone." }, zone: { type: "text", label: "Your parking zone or district, if you know it", optional: true, options: undefined }, vehicle: { hint: "Residential permits only. Registration must match your name and this address. Type N/A for visitor permits." } } },
  bulky_item_pickup: { intro: "Most cities and their trash haulers collect large items from the curb by appointment, usually within 1–2 weeks. No construction debris or hazardous waste.", fields: { items: { hint: "Appliances with refrigerant are often a separate pickup." } } },
  business_license: { intro: "Required for any business operating or based in the city; the city confirms its fee and any extra permits on review.", fields: { business_address: { label: "Business address in the city" } } },
  dog_license: { intro: "Annual dog license from the city or its animal-services provider. A current rabies vaccination certificate is required; fees depend on spay/neuter status.", fields: { altered: { options: ["Yes", "No"] } } },
  community_event_permit: { intro: "For larger public events, street closures or temporary structures. Most cities want 30–60 days' notice and police/fire sign-off.", fields: {} },
  "311_service_request": { title: "Service Request", intro: "Routed to the responsible department. Emergencies: call 911.", fields: {} },
  illegal_dumping: { intro: "Report dumped items on public property; the city or its hauler collects them. Hazardous materials get a separate pickup.", fields: {} },
  graffiti_removal: { intro: "The city removes graffiti on public property; private owners are notified. Hate graffiti is prioritized in most cities.", fields: {} },
  pothole_street_repair: { intro: "Potholes and pavement failures on city streets; state highways go to Caltrans.", fields: {} },
  streetlight_outage: { intro: "Streetlight outages and damage. Some cities' lights are maintained by the utility; the city forwards those.", fields: {} },
  missed_trash_pickup: { intro: "Missed trash, recycling or organics collection; the city or its hauler schedules a return trip.", fields: { out_on_time: { label: "Was the container at the curb on time?" } } },
  council_comment: { title: "Public Comment", intro: "Written comment is forwarded to the clerk and the council or board for the meeting you pick and entered into its record.", fields: {} },
};
export function formFor(type, j) {
  const f = FORMS[type]; if (!f) return null;
  if (!j || j.id === f.jur) return f;
  const g = GENERIC[type] ?? {};
  const fields = f.fields.filter((x) => !(g.drop ?? []).includes(x.key)).map((x) => ({ ...x, ...(g.fields?.[x.key] ?? {}) }));
  return { ...f, ...(g.title ? { title: g.title } : {}), intro: `Filed with the ${j.name}. ${g.intro ?? f.intro}`, source: j.site, fields, jur: j.id };
}

// Validates answers against the form and returns the submit_application input, or throws with a resident-readable message.
export function toApplication(type, fields = {}, j = null) {
  const f = formFor(type, j); if (!f) throw new Error(`No form for ${type}`);
  const v = (k) => String(fields[k] ?? "").trim();
  for (const fld of f.fields) if (!fld.optional && !v(fld.key)) throw new Error(`${fld.label} is required`);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v("email"))) throw new Error("Email address looks invalid");
  const used = new Set(["applicant_name", "email", "phone"]);
  const pick = (...keys) => { for (const k of keys) if (v(k)) { used.add(k); return v(k); } return ""; };
  const address = pick("address", "street_block", "business_address");
  const requested_date = pick("event_date", "start_date") || (v("meeting").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? ""); // council_comment: the meeting's date
  const headline = pick("event_name", "business_name", "dog_name", "category", "items", "permit_kind", "meeting");
  const details = f.fields.filter((x) => !used.has(x.key) && v(x.key)).map((x) => `${x.label}: ${v(x.key)}`).join("\n");
  return { type, applicant_name: v("applicant_name"), email: v("email"), phone: v("phone"), address, requested_date,
    summary: headline ? `${f.title} - ${headline.split("\n")[0].slice(0, 80)}` : f.title, details };
}
