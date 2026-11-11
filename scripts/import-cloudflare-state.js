import { readFile } from "node:fs/promises";

const workerBaseUrl = process.env.WORKER_BASE_URL?.replace(/\/$/u, "");
const sharedSecret = process.env.PARSER_SHARED_SECRET;
const statePath = process.env.STATE_PATH || "./data/state.json";
if (!workerBaseUrl || !sharedSecret) throw new Error("WORKER_BASE_URL and PARSER_SHARED_SECRET are required");

const state = JSON.parse(await readFile(statePath, "utf8"));
const response = await fetch(`${workerBaseUrl}/internal/state/import`, {
  method: "POST",
  headers: { authorization: `Bearer ${sharedSecret}`, "content-type": "application/json" },
  body: JSON.stringify(state),
});
const result = await response.json();
if (!response.ok) throw new Error(`State import failed: HTTP ${response.status} ${result.error ?? ""}`.trim());
console.log(JSON.stringify({ event: "state_import_complete", schedules: result.schedules, documents: result.documents }));
