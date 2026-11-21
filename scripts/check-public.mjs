import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";

const staged = process.argv.includes("--staged");
const gitArgs = staged
  ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
  : ["ls-files", "-z"];
const files = execFileSync("git", gitArgs, {encoding: "utf8"})
  .split("\0")
  .filter(Boolean);

const forbiddenNames = [
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:key|pem|p12|pfx))$/i
];
const contentRules = [
  {
    name: "private IPv4 address",
    pattern: /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g
  },
  {
    name: "absolute user home path",
    pattern: /\/(?:home|Users)\/[A-Za-z0-9._-]+(?:\/|\b)/g
  },
  {
    name: "high-precision location coordinate",
    pattern: /\b(?:latitude|longitude)\s*[:=]\s*-?\d{1,3}\.\d{6,}\b/gi
  },
  {
    name: "private infrastructure hostname",
    pattern: /(?:https?:\/\/|@)[A-Za-z0-9.-]*avantics\.co\.uk\b/gi
  },
  {
    name: "live Node-RED data path",
    pattern: /\/data\/(?:flows|node_modules|projects)(?:\/|\b)/g
  },
  {
    name: "private deployment repository URL",
    pattern: /gitlab\.com\/cptbucky\//gi
  },
  {
    name: "private key block",
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/g
  }
];

const findings = [];
for (const file of files) {
  if (forbiddenNames.some((pattern) => pattern.test(file))) {
    findings.push(`${file}: forbidden credential-like filename`);
    continue;
  }

  let content;
  try {
    content = staged
      ? execFileSync("git", ["show", `:${file}`])
      : readFileSync(file);
  } catch (error) {
    findings.push(`${file}: could not inspect (${error.message})`);
    continue;
  }
  if (content.includes(0)) continue;

  const text = content.toString("utf8");
  const lines = text.split("\n");
  for (const rule of contentRules) {
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(text)) !== null) {
      const line = text.slice(0, match.index).split("\n").length;
      findings.push(`${file}:${line}: ${rule.name}`);
      if (match[0].length === 0) rule.pattern.lastIndex += 1;
    }
  }
}

if (findings.length) {
  console.error("Public repository scan failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Public repository scan passed (${files.length} files).`);
