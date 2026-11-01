import type { GroupSettings, Resolution, SettingKey } from '@/lib/groups';
import type { LimitView } from '@/lib/limits';
import type { LogEntry } from '@/lib/logs';
import type { Rule } from '@/lib/rules';
import type { Scenario } from '@/lib/studio';
import type { ModelKind } from '@/lib/servers';
import type { AppSettings } from '@/lib/settings';

export type { ModelKind, Scenario };
export type { GroupSettings, LimitView, LogEntry, Resolution, Rule, SettingKey, AppSettings };

export const VIEWS = ['overview', 'activity', 'guard', 'servers', 'groups', 'keys', 'context', 'rules', 'docs', 'schemas', 'studio', 'settings'] as const;
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
  /** Inherited context files this group turns off (sub-groups inherit that). */
  ctxExclude: number[];
  /** Effective MCP doc ids, inherited ones included. */
  docs: number[];
  /** MCP docs assigned to this group itself. */
  ownDocs: number[];
  docsMode: 'set' | 'add' | 'override' | null;
  /** Inherited MCP docs this group turns off. */
  docsExclude: number[];
}

/** A doc served to agents over MCP. */
export interface DocC {
  id: number;
  slug: string;
  title: string;
  description: string;
  tags: string[];
  body: string;
  version: number;
  created_at: number;
  updated_at: number;
  /** Groups that list it themselves. */
  groups: number[];
  /** Keys that get it as their own exception. */
  keys: number[];
  /** How many keys can read it. */
  reach: number;
}

/** What each key sees over MCP. */
export interface DocKeyC {
  id: number;
  name: string;
  owner: string;
  groupId: number;
  mcp: boolean;
  revoked: boolean;
  docs: number[];
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
  ipAllow: string[];
  canReveal: boolean;
  /** Tell the model who is calling (key name, owner), first in the context. */
  identity: { key: boolean; owner: boolean };
  /** May use the MCP docs server. */
  mcp: boolean;
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
  kind?: ModelKind | null;
  kind_override?: ModelKind | null;
  manual?: number;
  /** "decisions" for models only reachable on the Decisions API. */
  api?: string | null;
  structured?: number;
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
  weakSecret: boolean;
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
  scenarios: Scenario[];
  docs: DocC[];
  docKeys: DocKeyC[];
  /** The MCP endpoint path ("/mcp"). */
  mcpPath: string;
  mcpTools: { name: string; title: string; description: string }[];
}

export const KIND_LABEL: Record<ModelKind, string> = {
  text: 'Text',
  image: 'Image',
  audio: 'Audio',
  video: 'Video',
  embedding: 'Embedding',
  rerank: 'Rerank',
  classifier: 'Decision / classifier',
  other: 'Other',
};
export const KINDS = Object.keys(KIND_LABEL) as ModelKind[];
export const kindOf = (m: { kind?: ModelKind | null; kind_override?: ModelKind | null }): ModelKind => m.kind_override ?? m.kind ?? 'text';
