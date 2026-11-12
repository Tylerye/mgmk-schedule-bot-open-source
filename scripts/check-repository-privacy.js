import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";

// Only inspect files selected for Git. Never print matching content or values.
function walk(dir = ".") {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const name = dir === "." ? entry.name : `${dir}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not supported in release scan: ${name}`);
    if (entry.isDirectory()) return [".git", "node_modules", ".wrangler", "output"].includes(entry.name) ? [] : walk(name);
    return [name];
  });
}
const directoryMode = process.argv.includes("--directory");
const files = directoryMode ? walk() : execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const forbidden = /(^|\/)(?:\.env(?:\..+)?|\.dev\.vars(?:\..+)?|AGENTS\.md|wrangler\.(?:personal\.)?(?:jsonc?|toml))$|^(?:docs\/agent|data|\.wrangler|\.agents|\.codex|secrets|credentials)(?:\/|$)|\.(?:pem|key|p12|pfx|sqlite3?|db)(?:-wal|-shm)?$|^(?:AUDIT|CLOUDFLARE|DISCOVERY|TEACHERS)\.md$/i;
const secrets = [
  ["Telegram token", /\b\d{6,12}:AA[A-Za-z0-9_-]{30,}\b/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["Cloudflare user token", /\bcfut_[A-Za-z0-9_-]{40,}\b/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];
let failed = false;
const publicMode=process.argv.includes('--public');
for (const file of files) {
  if (file !== ".env.example" && forbidden.test(file)) {
    console.error(`Private file must not be tracked: ${file}`);
    failed = true;
  }
  if (!existsSync(file)) continue;
  const content = readFileSync(file).toString("utf8");
  if(publicMode && /^(src|cloudflare|personal)\//.test(file) && /(?:userId|CURATOR_USER_ID)\s*[:=]\s*["']?[1-9]\d{5,}/.test(content)) {console.error('Numeric privilege binding must not be embedded in public runtime: '+file);failed=true;}
  if(/^(src|cloudflare|personal)\//.test(file) && /(?:PARSER_SHARED_SECRET|HEALTH_READ_SECRET|MAINTENANCE_SIGNING_SECRET|PERSONAL_SHARED_SECRET)\s*[:=]\s*["'][A-Za-z0-9_-]{24,}["']/.test(content)){console.error('Possible embedded credential: '+file+'; value omitted');failed=true;}
  for (const [kind, pattern] of secrets) if (pattern.test(content)) {
    console.error(`Possible ${kind} in ${file}; value omitted`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log(`Privacy check passed for ${files.length} ${directoryMode ? "distribution" : "tracked"} files (current tree only).`);
