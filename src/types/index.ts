export type Role = "PRE" | "MANAGER" | "COO" | "NURSE";

export interface User {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  name: string;
  shift: "morning" | "night";
  block_id: number | null;
  nursing_station: string | null;
  created_at: number;
  updated_at: number;
}

export interface BlockRow {
  id: number;
  name: string;        // e.g. "1A"
  name_key: string;    // UPPER(TRIM(name))
  label: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface JwtPayload {
  id: number;
  username: string;
  role: Role;
  name: string;
  /** Block name (e.g. "1A") — null for MANAGER / COO / NURSE */
  block: string | null;
  /** Legacy alias kept so old JWT tokens don't crash the middleware */
  pre?: string | null;
  /** Nursing station name — set for NURSE role only */
  nursing_station?: string | null;
}

export interface WardRow {
  id: number;
  name: string;
  block_id: number | null;
  total_beds: number;
}

export interface BedRow {
  ward_id: number;
  total: number;
  vacant: number | null;
  reserved: number | null;
  occupied: number | null;
  updated_at: number | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: JwtPayload; }
  }
}
