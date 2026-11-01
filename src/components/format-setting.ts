import type { LayerOpt, SettingKey, SettingValue } from '@/lib/groups';

/** Human text for a stored or effective group setting. */
export function display(key: SettingKey, v: SettingValue, list: { docs?: { id: number; title: string }[]; files: { id: number; name: string }[]; servers: { id: number; name: string }[]; layers?: { id: string; name: string }[] }): string {
  if (key === 'servers') return v === null ? 'All servers' : (v as number[]).map((id) => list.servers.find((s) => s.id === id)?.name ?? '?').join(', ') || 'None';
  if (key === 'models') return (v as string[]).includes('*') ? 'All models' : (v as string[]).join(', ') || 'None';
  if (key === 'mcp_docs') return (v as number[]).map((id) => list.docs?.find((d) => d.id === id)?.title ?? `doc ${id}`).join(', ') || 'None';
  if (key === 'context') return (v as number[]).map((id) => list.files.find((f) => f.id === id)?.name ?? '?').join(', ') || 'None';
  if (key === 'layers') {
    const e = Object.entries((v ?? {}) as Record<string, boolean>);
    return e.length ? e.map(([id, on]) => `${list.layers?.find((l) => l.id === id)?.name ?? id} ${on ? 'on' : 'off'}`).join(', ') : 'Layer defaults';
  }
  if (key === 'layer_opts') {
    const e = Object.entries((v ?? {}) as Record<string, LayerOpt & { threshold?: number | null; prompt_parts?: unknown[] }>);
    const parts = e.flatMap(([id, o]) => {
      const name = list.layers?.find((l) => l.id === id)?.name ?? id;
      const out: string[] = [];
      if (o.threshold != null) out.push(`${name} at ${Number(o.threshold).toFixed(2)}`);
      const lines = o.prompt ? 1 : (o.prompt_parts?.length ?? 0);
      if (lines) out.push(`${name} + ${lines} prompt part${lines > 1 ? 's' : ''}`);
      return out;
    });
    return parts.join(', ') || 'Layer defaults';
  }
  if (key === 'rate_limit') return `${v} per min`;
  const t = String(v ?? '');
  return t.length > 70 ? t.slice(0, 70).trim() + '…' : t || 'Empty';
}

