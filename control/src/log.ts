export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  event: string;
  level?: LogLevel;
  request_id?: string;
  [k: string]: unknown;
}

const SENSITIVE_KEY = /token|secret|authorization|cookie|password|private[_-]?key/i;
const DEVICE_TOKEN = /\bdt_[A-Za-z0-9_-]{16,}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

function redactString(value: string): string {
  return value.replace(DEVICE_TOKEN, "[REDACTED_DEVICE_TOKEN]").replace(JWT, "[REDACTED_JWT]");
}

function redact(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((entry) => redact(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
}

export function log(fields: LogFields): void {
  const { level = 'info', ...rest } = fields;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    ...(redact(rest) as Record<string, unknown>),
  });
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function newRequestId(): string {
  return crypto.randomUUID();
}
