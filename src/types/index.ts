export type Role = "PRE" | "MANAGER" | "COO";

export interface User {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  name: string;
  shift: "morning" | "night";
  created_at: number;
  updated_at: number;
}

export interface JwtPayload {
  id: number;
  username: string;
  role: Role;
  name: string;
  pre?: string | null;
}

export interface WardRow {
  id: number;
  name: string;
  floor_id: number | null;
  pre_code: string;
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
