// Receives payment/subscription events from Hubla and automatically marks
// (or unmarks) the matching community member as a supporter in Supabase.
//
// How it's wired up:
//   Hubla -> POST https://comunidade-de-ora-o.vercel.app/api/hubla-webhook -> this file -> Supabase
//
// This file lives in /api, so Vercel automatically turns it into a live
// serverless endpoint the moment it's deployed — no extra configuration needed.

const SUPABASE_URL = "https://xqtrjkdletubffqmruut.supabase.co";
const SUPABASE_KEY = "sb_publishable_EjNrqY8rH9KPGKxTbpWOkg_TuX41JzD";
const HUBLA_TOKEN = "FEAdxNDqmTI6yN4KHBwX3jxC4UFoJ7KFZadpGCUdsB1FfPYFwCk1FYA4NPK9jDS8";

// Event names that mean "this person paid / subscription is active" -> grant the badge.
const GRANT_EVENTS = [
  "invoice.payment_succeeded",
  "subscription.activated",
  "subscription.created",
  "sale.created",
  "sale.approved",
];

// Event names that mean "this person stopped paying" -> remove the badge.
const REVOKE_EVENTS = [
  "subscription.canceled",
  "subscription.cancelled",
  "subscription.suspended",
  "subscription.expired",
  "invoice.payment_failed",
  "sale.refunded",
  "sale.chargeback",
];

async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null };
}

// Hubla's exact payload shape can vary a bit by event/product, so we check
// every likely spot an e-mail address could be hiding.
function extractEmail(body) {
  const candidates = [
    body?.email,
    body?.buyer?.email,
    body?.customer?.email,
    body?.payload?.email,
    body?.payload?.buyer?.email,
    body?.payload?.customer?.email,
    body?.data?.email,
    body?.data?.buyer?.email,
    body?.data?.customer?.email,
    body?.invoice?.buyer?.email,
    body?.invoice?.customer?.email,
    body?.subscription?.buyer?.email,
    body?.subscription?.customer?.email,
    body?.user?.email,
  ];
  return candidates.find((e) => typeof e === "string" && e.includes("@"));
}

function extractEventType(body) {
  return body?.event || body?.type || body?.eventType || body?.name || "";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Confirm this really came from Hubla.
  const incomingToken = req.headers["x-hubla-token"];
  if (!incomingToken || incomingToken !== HUBLA_TOKEN) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  // Always respond fast — do the real work, but never make Hubla wait or retry.
  res.status(200).json({ received: true });

  try {
    const body = req.body || {};
    const eventType = extractEventType(body);
    const email = extractEmail(body);

    if (!email) return; // nothing we can match without an e-mail

    const cleanEmail = email.trim().toLowerCase();
    const found = await sb(`users?email=eq.${encodeURIComponent(cleanEmail)}&select=id,is_supporter&limit=1`);
    const profile = found.data && found.data[0];
    if (!profile) return; // this person hasn't joined the community app yet

    if (GRANT_EVENTS.includes(eventType) && !profile.is_supporter) {
      await sb(`users?id=eq.${profile.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_supporter: true, supporter_since: new Date().toISOString() }),
      });
    } else if (REVOKE_EVENTS.includes(eventType) && profile.is_supporter) {
      await sb(`users?id=eq.${profile.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_supporter: false }),
      });
    }
  } catch (e) {
    // Swallow errors here — the 200 response was already sent above.
  }
}
