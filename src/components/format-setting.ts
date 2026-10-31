import type { SettingKey, SettingValue } from '@/lib/groups';

/** Human text for a stored or effective group setting. */
export function display(key: SettingKey, v: SettingValue, list: { files: { id: number; name: string }[]; servers: { id: number; name: string }[]; layers?: { id: string; name: string }[] }): string {
  if (key === 'servers') return v === null ? 'All servers' : (v as number[]).map((id) => list.servers.find((s) => s.id === id)?.name ?? '?').join(', ') || 'None';
  if (key === 'models') return (v as string[]).includes('*') ? 'All models' : (v as string[]).join(', ') || 'None';
  if (key === 'context') return (v as number[]).map((id) => list.files.find((f) => f.id === id)?.name ?? '?').join(', ') || 'None';
  if (key === 'piguard_enabled' || key === 'oss_enabled') return v === true ? 'On' : 'Off';
  if (key === 'layers') {
    const e = Object.entries((v ?? {}) as Record<string, boolean>);
    return e.length ? e.map(([id, on]) => `${list.layers?.find((l) => l.id === id)?.name ?? id} ${on ? 'on' : 'off'}`).join(', ') : 'Layer defaults';
  }
  if (key === 'piguard_threshold') return Number(v).toFixed(2);
  if (key === 'rate_limit') return `${v} per min`;
  const t = String(v ?? '');
  return t.length > 70 ? t.slice(0, 70).trim() + '…' : t || 'Empty';
}

