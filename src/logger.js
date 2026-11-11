const levels = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = "info") {
  const threshold = levels[level] ?? levels.info;
  const logger = {};
  for (const [name, value] of Object.entries(levels)) {
    logger[name] = (message, fields = {}) => {
      if (value < threshold) return;
      const record = { time: new Date().toISOString(), level: name, message, ...fields };
      const output = JSON.stringify(record, (key, field) => {
        if (/token|secret|password|authorization/iu.test(key)) return "[redacted]";
        return typeof field === "string" ? field
          .replace(/https:\/\/api\.telegram\.org\/bot[^/\s]+/giu, "https://api.telegram.org/bot[redacted]")
          .replace(/\bBearer\s+[^\s"']+/giu, "Bearer [redacted]")
          .replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/gu, "[redacted]") : field;
      });
      (name === "error" ? console.error : console.log)(output);
    };
  }
  return logger;
}
