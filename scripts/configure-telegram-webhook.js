import {credentialOrigin} from "../src/credential-origin.js";
const token = process.env.BOT_TOKEN;
const workerBaseUrl = credentialOrigin(process.env.WORKER_BASE_URL);
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!token || !workerBaseUrl || !webhookSecret) throw new Error("BOT_TOKEN, WORKER_BASE_URL, and TELEGRAM_WEBHOOK_SECRET are required");

const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST", redirect:"error",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: `${workerBaseUrl}/telegram/webhook`,
    secret_token: webhookSecret,
    allowed_updates: ["message", "callback_query", "chat_member"],
    drop_pending_updates: false,
  }),
});
const payload = await response.json();
if (!response.ok || !payload.ok) throw new Error(`Telegram setWebhook failed: ${payload.description ?? `HTTP ${response.status}`}`);
console.log(JSON.stringify({ event: "telegram_webhook_configured", ok: true }));
