// COO is the single management role, presented in the UI as "Admin".
// The former MANAGER role was merged into COO (migration 20260621000000).
// DOCTOR updates beds in assigned Doctor Blocks (migration 20260622000000).
// CONSULTANT — portal login for named consultants; read-only hospital view + discharge summary.
export type Role = "PRE" | "COO" | "NURSE" | "DOCTOR" | "FC" | "CONSULTANT" | "PHARMACY" | "MASTER_PHARMACY" | "MASTER_FC";

export interface User {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  name: string;
  block_id: number | null;       // legacy — kept for old tokens
  floor_id: number | null;       // legacy physical floor (no longer used for PRE)
  nursing_station: string | null;
  station_id: number | null;
  status: "active" | "inactive";
  remarks: string | null;
  created_at: number;
  updated_at: number;
}

export interface BuildingBlockRow {
  id: number;
  name: string;        // 'A', 'B'
  label: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

/** @deprecated kept so old code that references BlockRow still compiles */
export interface BlockRow {
  id: number;
  name: string;
  name_key: string;
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
  /** @deprecated physical floor id — kept so old tokens don't crash */
  floor_id?: number | null;
  /** @deprecated legacy block name kept so old PRE tokens don't crash */
  block?: string | null;
  pre?: string | null;
  /** Nursing station name — set for NURSE role only */
  nursing_station?: string | null;
  /** Nursing station FK id — set for NURSE role only */
  station_id?: number | null;
}

export interface WardRow {
  id: number;
  name: string;
  floor_id: number | null;
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
