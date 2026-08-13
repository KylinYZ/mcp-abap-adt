export type Sm21Severity = 'ALL' | 'ERROR' | 'WARNING' | 'ERROR_WARNING';

export interface Sm21ReadRequest {
  from: string;
  to: string;
  instances: string[];
  users: string[];
  programs: string[];
  tcodes: string[];
  messageIds: string[];
  severity: Sm21Severity;
  offset: number;
  pageSize: number;
}

export interface Sm21LogEntry {
  timestamp: string;
  instance: string;
  client: string;
  user: string;
  program: string;
  tcode: string;
  messageId: string;
  severity: string;
  process: string;
  text: string;
}

export interface Sm21ReadResult {
  logs: Sm21LogEntry[];
  hasMore: boolean;
  total: number;
}

export interface Sm21Client {
  read(request: Sm21ReadRequest): Promise<Sm21ReadResult>;
}

export interface Sm21RuntimeConfig {
  timeZone: string;
  maxWindowHours: number;
  defaultPageSize: number;
  maxPageSize: number;
}
