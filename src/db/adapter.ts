export interface DbStatement {
  run(...params: unknown[]): Promise<{ changes: number; lastInsertRowid: number }>;
  get<T = unknown>(...params: unknown[]): Promise<T | undefined>;
  all<T = unknown>(...params: unknown[]): Promise<T[]>;
}

export interface Db {
  exec(sql: string): Promise<void>;
  prepare(sql: string): DbStatement;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}
