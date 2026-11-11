import { createServer } from "node:http";

export function healthSnapshot(state) {
  return {
    ok: true,
    startedAt: state.health.startedAt,
    telegramReachableAt: state.health.lastTelegramSuccessAt,
    lastSourcePollAt: state.health.lastSourcePollAt,
    lastSuccessfulSourcePollAt: state.health.lastSourcePollSuccessAt,
    lastSourceChangeAt: state.health.lastSourceChangeAt,
    lastParserSuccessAt: state.health.lastParserSuccessAt,
    configuredChat: Boolean(state.chatId),
    pinnedScheduleDate: state.pinnedSchedule?.date ?? null,
    canPinMessages: state.pinCapability?.canPin ?? null,
    nextSourcePollAt: state.health.nextSourcePollAt,
    lastError: state.health.lastError,
  };
}

export function startHealthServer({ store, port, host = "127.0.0.1", logger }) {
  const server = createServer((request, response) => {
    if (request.url !== "/healthz") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"not_found"}\n');
      return;
    }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(`${JSON.stringify(healthSnapshot(store.state))}\n`);
  });
  server.listen(port, host, () => logger.info("health_server_started", { host, port }));
  return server;
}
