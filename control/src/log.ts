export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  event: string;
  level?: LogLevel;
  request_id?: string;
  [k: string]: unknown;
}

export function log(fields: LogFields): void {
  const { level = 'info', ...rest } = fields;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    ...rest,
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
