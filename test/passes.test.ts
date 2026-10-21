import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { TranslationPasses, readCoinpayWebhook, verifyCoinpaySignature, propertyOf, SESSION_COIN, type CoinpayWebhookEvent } from "../src/passes.ts";

const BUSINESS = "11111111-2222-4333-8444-555555555555";
const KEY = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SESSION = "cs_AbCdEfGhIjKlMnOpQrStUvWx";
const PAYMENT = "99999999-8888-4777-8666-555555555555";

interface Call { url: string; method: string; body: any; auth: string }
function coinpay(session: { status: string; amount?: number } = { status: "open" }) {
  const calls: Call[] = [];
  const state = { session: { ...session } };
  const fetcher = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input), method = init.method ?? "GET";
    calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : null, auth: String((init.headers as Record<string, string>)?.["authorization"] ?? "") });
    if (url.endsWith("/api/supported-coins")) return Response.json({ success: true, business_id: BUSINESS, coins: [{ symbol: "USDC_POL", is_active: true, has_wallet: true }] });
    if (url.endsWith("/api/checkout/sessions") && method === "POST") {
      return Response.json({ success: true, id: SESSION, url: `https://coinpayportal.com/checkout/${SESSION}`, status: "open", methods: [{ code: "USDC_POL" }, { code: "PAYPAL" }] }, { status: 201 });
    }
    if (url.endsWith(`/api/checkout/sessions/${SESSION}`)) {
      return Response.json({ success: true, session: { id: SESSION, status: state.session.status, amount: state.session.amount ?? 1, currency: "USD",
        payment_id: state.session.status === "paid" ? PAYMENT : null, paypal_transaction_id: null } });
    }
    if (url.endsWith("/api/payments/create")) return Response.json({ success: true, payment: { id: PAYMENT } });
    if (url.endsWith(`/api/payments/${PAYMENT}`)) return Response.json({ success: true, payment: { id: PAYMENT, status: "confirmed", amount: 1, currency: "USD" } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { calls, fetcher, state };
}

async function passes(fake = coinpay(), extra: Partial<ConstructorParameters<typeof TranslationPasses>[0]> = {}) {
  const db = new PGlite();
  const service = new TranslationPasses({ db, key: "cp_live_test", site: "https://www.example.com", fetcher: fake.fetcher, app: "example",
    redirect: order => `https://www.example.com/vod?translation_order=${order}`, ...extra });
  return { db, service, fake };
}

test("a checkout with the buyer's email opens one CoinPay hosted session with property, account and email", async () => {
  const { service, fake, db } = await passes();
  const access = await service.access("user-1");
  assert.equal(access.checkout, "session");
  assert.equal(access.available, true);
  const first = await service.checkout("user-1", "day", "", KEY, { email: "Buyer@Example.com" });
  assert.equal(first.url, `https://coinpayportal.com/checkout/${SESSION}`);
  const posts = fake.calls.filter(call => call.url.endsWith("/api/checkout/sessions"));
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.auth, "Bearer cp_live_test");
  assert.deepEqual(posts[0]!.body, {
    amount: 1, currency: "USD", description: "Translated audio: Day pass",
    customer_email: "buyer@example.com", account_id: "user-1", property: "example.com",
    metadata: { app: "example", product: "translation", order_id: first.id },
    success_url: `https://www.example.com/vod?translation_order=${first.id}`,
    cancel_url: `https://www.example.com/vod?translation_order=${first.id}`, expires_in_minutes: 60,
  });
  // Retrying the same request resumes the same session.
  const again = await service.checkout("user-1", "day", "", KEY, { email: "buyer@example.com" });
  assert.deepEqual(again, first);
  assert.equal(fake.calls.filter(call => call.url.endsWith("/api/checkout/sessions")).length, 1);
  const row = (await db.query<Record<string, unknown>>("SELECT coin, session_id, customer_email, payment_id FROM translation_orders")).rows[0]!;
  assert.deepEqual(row, { coin: SESSION_COIN, session_id: SESSION, customer_email: "buyer@example.com", payment_id: null });
  assert.deepEqual((await service.access("user-1")).orders.map(order => order.url), [first.url]);
});

test("an explicit account id and property are sent as given", async () => {
  const { service, fake } = await passes(coinpay(), { property: "bittorrented.com" });
  await service.checkout("user-2", "month", "", KEY, { email: "a@b.co", accountId: "acct-42" });
  const body = fake.calls.find(call => call.url.endsWith("/api/checkout/sessions"))!.body;
  assert.equal(body.amount, 5);
  assert.equal(body.account_id, "acct-42");
  assert.equal(body.property, "bittorrented.com");
});

test("a checkout without an email and without a coin asks for the email; a bad email is refused", async () => {
  const { service } = await passes();
  await assert.rejects(service.checkout("user-1", "day", "", KEY), /email/);
  await assert.rejects(service.checkout("user-1", "day", "", KEY, { email: "nope" }), /valid email/);
});

test("an older client with only a coin still gets the one-coin invoice", async () => {
  const { service, fake } = await passes();
  const order = await service.checkout("user-1", "day", "USDC_POL", KEY);
  assert.equal(order.url, `https://coinpayportal.com/pay/${PAYMENT}`);
  assert.equal(fake.calls.filter(call => call.url.endsWith("/api/checkout/sessions")).length, 0);
});

test("a signed nested session webhook settles the order once, by asking CoinPay for the session", async () => {
  const fake = coinpay();
  const { service, db } = await passes(fake);
  const order = await service.checkout("user-1", "day", "", KEY, { email: "buyer@example.com" });
  const body = JSON.stringify({ id: `evt_${PAYMENT}_1`, type: "payment.confirmed", data: { payment_id: PAYMENT, status: "confirmed",
    checkout_session_id: SESSION, customer_email: "buyer@example.com", account_id: "user-1", property: "example.com", metadata: { order_id: order.id } } });
  const t = Math.floor(Date.now() / 1000);
  const header = `t=${t},v1=${createHmac("sha256", "whsec").update(`${t}.${body}`).digest("hex")}`;
  assert.equal(verifyCoinpaySignature(body, header, "whsec"), true);
  assert.equal(verifyCoinpaySignature(body + " ", header, "whsec"), false);
  const event: CoinpayWebhookEvent = readCoinpayWebhook(JSON.parse(body));
  assert.deepEqual({ ...event, metadata: undefined }, { type: "payment.confirmed", paymentId: PAYMENT, status: "confirmed", sessionId: SESSION,
    customerEmail: "buyer@example.com", accountId: "user-1", property: "example.com", metadata: undefined });

  // CoinPay has not marked the session paid yet: nothing is credited.
  assert.deepEqual(await service.settle(event), { settled: false, status: "pending" });
  fake.state.session.status = "paid";
  assert.deepEqual(await service.settle(event), { settled: true, status: "paid" });
  assert.deepEqual(await service.settle(event), { settled: true, status: "paid" }, "a second delivery credits nothing twice");
  const wallet = (await db.query<Record<string, unknown>>("SELECT balance_micros FROM translation_wallets WHERE by_account = 'user-1'")).rows[0]!;
  assert.equal(Number(wallet["balance_micros"]), 1_000_000);
  const row = (await db.query<Record<string, unknown>>("SELECT status, payment_id FROM translation_orders")).rows[0]!;
  assert.deepEqual(row, { status: "paid", payment_id: PAYMENT });
  assert.deepEqual(await service.settle({ paymentId: "00000000-0000-4000-8000-000000000000" }), { settled: false, reason: "unknown payment" });
});

test("a session paid for the wrong amount credits nothing; an expired session expires the order", async () => {
  const fake = coinpay({ status: "paid", amount: 0.5 });
  const { service } = await passes(fake);
  const order = await service.checkout("user-1", "day", "", KEY, { email: "buyer@example.com" });
  assert.equal((await service.check("user-1", order.id)).status, "pending");
  fake.state.session = { status: "expired" };
  assert.equal((await service.settle({ sessionId: SESSION })).status, "expired");
});

test("an older one-coin order in flight still settles from its payment id (flat or nested)", async () => {
  const { service } = await passes();
  await service.checkout("user-1", "day", "USDC_POL", KEY);
  assert.equal(readCoinpayWebhook({ id: PAYMENT, status: "confirmed" }).paymentId, PAYMENT);
  assert.deepEqual(await service.settle(readCoinpayWebhook({ id: "evt_x", data: { payment_id: PAYMENT, status: "confirmed" } }).paymentId), { settled: true, status: "paid" });
});

test("propertyOf strips scheme, www and path", () => {
  assert.equal(propertyOf("https://www.nixamp.com/a?b"), "nixamp.com");
  assert.equal(propertyOf("bittorrented.com"), "bittorrented.com");
});
