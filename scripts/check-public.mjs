import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

export const forbiddenNames = [
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:key|pem|p12|pfx))$/i
];

// Names reserved for documentation and tests (RFC 2606, RFC 6761), plus
// GitHub's no-reply commit addresses. A rule's `allow` skips a match only
// when it is one of these, never by widening the rule itself.
const reservedDomain = /(?:^|[.@])(?:example\.(?:com|org|net)|example|invalid|test|localhost|users\.noreply\.github\.com)$/i;

export const contentRules = [
  {
    name: "private IPv4 address",
    pattern: /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g
  },
  {
    name: "carrier-grade NAT address",
    pattern: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}\b/g
  },
  {
    name: "private IPv6 address",
    pattern: /\b(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):(?:[0-9a-f]{0,4}:){1,6}[0-9a-f]{0,4}\b/gi
  },
  {
    name: "local network hostname",
    pattern: /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.(?:local|lan|home\.arpa)\b(?![-.\w])/gi
  },
  {
    name: "MAC address",
    pattern: /\b[0-9a-f]{2}(?:([:-])[0-9a-f]{2})(?:\1[0-9a-f]{2}){4}\b/gi
  },
  {
    name: "email address",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
    allow: (match) => reservedDomain.test(match)
  },
  {
    name: "Zigbee IEEE address",
    pattern: /\b0x[0-9a-f]{16}\b/gi
  },
  {
    name: "absolute user home path",
    pattern: /\/(?:home|Users)\/[A-Za-z0-9._-]+(?:\/|\b)/g
  },
  {
    name: "high-precision location coordinate",
    pattern: /\b(?:latitude|longitude|lat|lon|lng)"?\s*[:=]\s*-?\d{1,3}\.\d{6,}\b/gi
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
    name: "Home Assistant entity identifier",
    pattern: /\b(?:binary_sensor|device_tracker|input_boolean|input_number|input_select|media_player)\.[a-z0-9_]+\b/g
  },
  {
    // Common-word domains clash with code and file names (select.payload,
    // package-lock.json), so these need a token start and an underscore in
    // the object id, as Home Assistant writes multi-word entity ids.
    name: "Home Assistant entity identifier",
    pattern: /(?<![\w.-])(?:alarm_control_panel|automation|button|camera|climate|cover|fan|humidifier|input_button|input_text|light|lock|person|remote|scene|script|select|sensor|siren|switch|vacuum|water_heater|zone)\.[a-z0-9]+_[a-z0-9_]+\b/g,
    // Service names (remote.send_command) share the shape but name no device.
    allow: (match) => /\.(?:turn_on|turn_off|toggle|send_command|reload|select_option|press|set_[a-z_]+)$/.test(match)
  },
  {
    // A placeholder after the slash (<device>, {device}, $device) names no
    // device; HTML pages write it as &lt;device&gt;, which must be closed.
    name: "Zigbee2MQTT device topic",
    pattern: /\bzigbee2mqtt\/(?!bridge\b|<|&lt;[^/&]*&gt;|\{|\$)[^\s"'`<>{}/]+/gi
  },
  {
    name: "Node-RED flow or node identifier",
    pattern: /\b[a-f0-9]{16}\b/g
  },
  {
    name: "private key block",
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/g
  }
];

export const pageRules = [
  {
    // Device brands may appear: the package supports them by name, and the
    // docs must name them to explain setup. Room names describe a home, so
    // they stay out of the public site.
    name: "deployment-specific room name in Pages",
    pattern: /\b(?:Kitchen|Hallway|Lounge)\b/gi
  },
  {
    name: "installation-status wording in Pages",
    pattern: /\b(?:live|deployed|installed)\b/gi
  }
];

// Findings for one file's text, as "file:line: rule name".
export function scanText(file, text) {
  const findings = [];
  const activeRules = file.startsWith("docs/") || file.startsWith("docs-src/") ? [...contentRules, ...pageRules] : contentRules;
  for (const rule of activeRules) {
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(text)) !== null) {
      if (match[0].length === 0) rule.pattern.lastIndex += 1;
      if (rule.allow?.(match[0])) continue;
      const line = text.slice(0, match.index).split("\n").length;
      findings.push(`${file}:${line}: ${rule.name}`);
    }
  }
  return findings;
}

function main() {
  const staged = process.argv.includes("--staged");
  const gitArgs = staged
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
    : ["ls-files", "-z"];
  const files = execFileSync("git", gitArgs, {encoding: "utf8"})
    .split("\0")
    .filter(Boolean);

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
    findings.push(...scanText(file, content.toString("utf8")));
  }

  if (findings.length) {
    console.error("Public repository scan failed:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exit(1);
  }

  console.log(`Public repository scan passed (${files.length} files).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
