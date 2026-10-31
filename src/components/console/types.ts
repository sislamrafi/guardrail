import type { GroupSettings, Resolution, SettingKey } from '@/lib/groups';
import type { LimitView } from '@/lib/limits';
import type { LogEntry } from '@/lib/logs';
import type { Rule } from '@/lib/rules';
import type { AppSettings } from '@/lib/settings';

export type { GroupSettings, LimitView, LogEntry, Resolution, Rule, SettingKey, AppSettings };

export const VIEWS = ['overview', 'activity', 'guard', 'servers', 'groups', 'keys', 'context', 'rules', 'schemas', 'studio', 'settings'] as const;
export type View = (typeof VIEWS)[number];

export interface GroupC {
  id: number;
  name: string;
  parentId: number | null;
  description: string;
  settings: GroupSettings;
  path: string;
  depth: number;
  keyCount: number;
  childCount: number;
  /** Effective context file ids, inherited ones included. */
  context: number[];
  /** Files attached to this group itself. */
  own: number[];
  mode: 'set' | 'add' | 'override' | null;
}

export interface FileC {
  id: number;
  name: string;
  body: string;
  version: number;
  updated_at: number;
  tokens: number;
  usedBy: string[];
  reach: number;
}

export interface KeyC {
  id: number;
  name: string;
  owner: string;
  groupId: number;
  prefix: string;
  exceptions: GroupSettings;
  revoked: boolean;
  expiresAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
  requestsToday: number;
  groupName: string;
  groupPath: string;
}

export interface ModelC {
  id: number;
  server_id: number;
  name: string;
  context_len: number | null;
  price_in?: number | null;
  price_out?: number | null;
  enabled: number;
  present: number;
}

export interface ServerC {
  id: number;
  name: string;
  url: string;
  role: 'inference' | 'guard';
  status: 'online' | 'down' | 'unknown';
  latency_ms: number | null;
  last_error: string | null;
  last_checked: number | null;
  cache_hit_rate: number | null;
  hasKey: boolean;
  models: ModelC[];
}

export interface Summary {
  online: number;
  servers: number;
  groups: number;
  keys: number;
  guard: boolean;
  blockedToday: number;
  name: string;
  authEnabled: boolean;
}

export interface Data {
  groups: GroupC[];
  files: FileC[];
  keys: KeyC[];
  servers: ServerC[];
  limits: LimitView[];
  /** model id -> names of groups that can call it */
  access: Record<string, string[]>;
  models: string[];
  modelServers: Record<string, string[]>;
  settings: AppSettings;
  cache: { name: string; rate: number }[];
  summary: Summary;
  rules: Rule[];
}
