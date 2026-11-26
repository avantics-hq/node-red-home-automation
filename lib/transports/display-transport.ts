"use strict";

// The display's device I/O: the TV, screen and projector meter over HTTP.
// Kept apart from lib/'s pure reducers; it depends on the display
// reducer's types, never the reverse, and is used by the display node.
import type {DisplayDevice, DisplayMessage} from "../display-mode-controller";


interface CodedError extends Error {
  code?: string;
}
interface DeviceResponse {
  error?: unknown;
  result?: Array<{status?: unknown}>;
  current_pos?: unknown;
  state?: unknown;
  apower?: unknown;
}


export interface DisplayTransportOptions {
  tvHost: string;
  tvPsk: string;
  screenHost: string;
  projectorMeterHost: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface DisplayTransportCommand {
  device: DisplayDevice;
  operation: string;
  generation: number;
  power?: string;
  position?: number;
}

function host(value: unknown, name: string): string {
  const text = String(value || "").trim();
  if (!/^[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(text)) {
    throw new Error(`${name} must be a host or host:port`);
  }
  return text;
}

export function safeReason(error: unknown): string {
  if (!error || typeof error !== "object") return "transport-error";
  const candidate = error as {name?: unknown; code?: unknown};
  if (candidate.name === "TimeoutError" || candidate.name === "AbortError") return "timeout";
  if (typeof candidate.code === "string" && /^[a-z0-9_-]+$/i.test(candidate.code)) {
    return candidate.code.toLowerCase();
  }
  return "transport-error";
}

async function responseJson(response: Response, allowNull: true): Promise<DeviceResponse | null>;
async function responseJson(response: Response, allowNull?: false): Promise<DeviceResponse>;
async function responseJson(response: Response, allowNull = false): Promise<DeviceResponse | null> {
  if (!response.ok) {
    const error = new Error("HTTP request failed") as CodedError;
    error.code = `http_${response.status}`;
    throw error;
  }
  let body: DeviceResponse | null;
  try {
    const decoded: unknown = await response.json();
    if (decoded === null && allowNull) return null;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("response is not an object");
    }
    body = decoded as DeviceResponse;
  } catch {
    const error = new Error("Invalid JSON response") as CodedError;
    error.code = "invalid_json";
    throw error;
  }
  if (body.error) {
    const error = new Error("Device RPC failed") as CodedError;
    error.code = "rpc_error";
    throw error;
  }
  return body;
}

export class DisplayTransport {
  readonly tvHost: string;
  readonly tvPsk: string;
  readonly screenHost: string;
  readonly projectorMeterHost: string;
  readonly timeoutMs: number;
  readonly fetch: typeof globalThis.fetch;

  constructor(options: DisplayTransportOptions) {
    this.tvHost = host(options.tvHost, "tvHost");
    this.tvPsk = String(options.tvPsk || "");
    if (!this.tvPsk) throw new Error("tvPsk is required");
    this.screenHost = host(options.screenHost, "screenHost");
    this.projectorMeterHost = host(options.projectorMeterHost, "projectorMeterHost");
    this.timeoutMs = Math.max(250, Number(options.timeoutMs || 5000));
    this.fetch = options.fetch || globalThis.fetch;
    if (typeof this.fetch !== "function") throw new Error("fetch is unavailable");
  }

  signal(): AbortSignal {
    return AbortSignal.timeout(this.timeoutMs);
  }

  async bravia(method: string, params: unknown[]): Promise<DeviceResponse> {
    const response = await this.fetch(`http://${this.tvHost}/sony/system`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-PSK": this.tvPsk
      },
      body: JSON.stringify({method, id: method === "getPowerStatus" ? 50 : 55, params, version: "1.0"}),
      signal: this.signal()
    });
    return responseJson(response);
  }

  async shellyGet(deviceHost: string, component: string): Promise<DeviceResponse> {
    const response = await this.fetch(`http://${deviceHost}/rpc/${component}`, {signal: this.signal()});
    return responseJson(response);
  }

  async shellyPost(deviceHost: string, component: string, params: Record<string, unknown>): Promise<void> {
    const response = await this.fetch(`http://${deviceHost}/rpc/${component}`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(params),
      signal: this.signal()
    });
    await responseJson(response, true);
  }

  async execute(command: DisplayTransportCommand, now = new Date()): Promise<DisplayMessage | null> {
    const common = {
      generation: command.generation,
      observedAt: now.toISOString()
    };
    try {
      if (command.device === "tv" && command.operation === "query_power") {
        const body = await this.bravia("getPowerStatus", []);
        const value = String(body?.result?.[0]?.status || "").toLowerCase();
        const power = value === "active" || value === "on" ? "on"
          : value === "standby" || value === "off" ? "standby" : null;
        if (!power) {
          const error = new Error("Unknown Bravia power status") as CodedError;
          error.code = "invalid_power_status";
          throw error;
        }
        return {display: {kind: "observed", device: "tv", power, source: "bravia", ...common}};
      }
      if (command.device === "tv" && command.operation === "set_power") {
        await this.bravia("setPowerStatus", [{status: command.power === "on"}]);
        return null;
      }
      if (command.device === "screen" && command.operation === "query_position") {
        const body = await this.shellyGet(this.screenHost, "Cover.GetStatus?id=0");
        const position = body.current_pos;
        if (typeof position !== "number" || !Number.isFinite(position) || position < 0 || position > 100) {
          const error = new Error("Shelly cover reported no usable position") as CodedError;
          error.code = "invalid_screen_position";
          throw error;
        }
        return {
          display: {
            kind: "observed",
            device: "screen",
            position,
            state: String(body.state || "unknown"),
            source: "shelly-cover",
            ...common
          }
        };
      }
      if (command.device === "screen" && command.operation === "set_position") {
        await this.shellyPost(this.screenHost, "Cover.GoToPosition", {id: 0, pos: command.position});
        return null;
      }
      if (command.device === "projector" && command.operation === "query_power") {
        const body = await this.shellyGet(this.projectorMeterHost, "Switch.GetStatus?id=1");
        const watts = body.apower;
        if (typeof watts !== "number" || !Number.isFinite(watts) || watts < 0) {
          const error = new Error("Shelly switch reported no usable power") as CodedError;
          error.code = "invalid_projector_power";
          throw error;
        }
        return {
          display: {
            kind: "observed",
            device: "projector",
            watts,
            source: "shelly-power",
            ...common
          }
        };
      }
      throw new Error("Unsupported display transport command");
    } catch (error) {
      return {
        display: {
          kind: "transport_failed",
          device: command.device,
          operation: command.operation,
          generation: command.generation,
          reason: safeReason(error)
        }
      };
    }
  }
}
