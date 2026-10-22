// Minimal Node typings for test files that run under vitest's node runtime
// (schema.test.ts). Deliberately hand-rolled instead of pulling @types/node:
// the worker tsconfig must not gain full Node globals, and AGENTS.md requires
// justifying new dependencies. Only what the tests actually use.

declare module "node:fs" {
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): { changes: number | bigint };
    };
    close(): void;
  }
}

declare const __dirname: string;
