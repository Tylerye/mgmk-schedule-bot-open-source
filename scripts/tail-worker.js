import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "tail", "--format=json"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
let buffer = "", depth = 0, quoted = false, escaped = false;
child.stdout.on("data", chunk => {
  for (const character of chunk.toString()) {
    if (!depth && character !== "{") continue;
    buffer += character;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{") depth++;
    else if (character === "}") depth--;
    if (!depth) {
      try {
        const event = JSON.parse(buffer);
        console.log(JSON.stringify({ outcome: event.outcome, at: event.eventTimestamp, cron: event.event?.cron, cpuTime: event.cpuTime,
          path: event.event?.request?.url ? new URL(event.event.request.url).pathname : undefined,
          exceptions: event.exceptions?.map(item => ({ name: item.name, message: String(item.message).replace(/https?:\/\/\S+/g, "[url]") })),
          logs: event.logs?.flatMap(log => log.message.flatMap(message => {
            try { const item = JSON.parse(message); return [{ event: item.message, lane: item.lane, error: typeof item.error === "string" ? item.error.replace(/https?:\/\/\S+/g, "[url]") : undefined, latencyMs: item.latencyMs, operation: item.operation }]; }
            catch { return []; }
          })) }));
      } catch {}
      buffer = "";
    }
  }
});
child.stderr.on("data", () => {});
setTimeout(() => child.kill(), Number(process.env.BOT_TAIL_MS || 55000));
