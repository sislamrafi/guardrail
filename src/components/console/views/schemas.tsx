'use client';

import { useEffect, useState } from 'react';
import type { Detection, SchemaDef } from '@/lib/schemas';
import { Field, Loading, Note, Page, Pill, Section, Seg } from '../kit';
import { api, useStore, useUi } from '../store';

const SAMPLES: Record<string, { path: string; headers: string; body: string }> = {
  'OpenAI chat (Cline)': {
    path: '/v1/chat/completions',
    headers: '{}',
    body: JSON.stringify({ model: 'qwen3-coder-30b', stream: true, messages: [{ role: 'system', content: 'You are Cline…' }, { role: 'user', content: 'Fix the failing test' }] }, null, 2),
  },
  'Anthropic Messages (Claude Code)': {
    path: '/v1/chat/completions',
    headers: '{"anthropic-version": "2023-06-01"}',
    body: JSON.stringify({ model: 'claude', max_tokens: 1024, system: 'You are Claude Code', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }, null, 2),
  },
  Gemini: {
    path: '/v1/chat/completions',
    headers: '{}',
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }], generationConfig: { temperature: 0.2 } }, null, 2),
  },
};

export function SchemasPage() {
  const { data } = useStore();
  const ui = useUi();
  const [schemas, setSchemas] = useState<SchemaDef[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sample, setSample] = useState('Anthropic Messages (Claude Code)');
  const [s, setS] = useState(SAMPLES[sample]);
  const [det, setDet] = useState<Detection | null>(null);
  useEffect(() => {
    api<{ schemas: SchemaDef[] }>('schemas').then((r) => setSchemas(r.schemas), (e) => setErr((e as Error).message));
  }, []);
  const policy = data?.settings.schemaPolicy ?? 'strict';
  const detect = () =>
    ui.run(
      async () => {
        let headers: Record<string, string>;
        try {
          headers = JSON.parse(s.headers || '{}');
        } catch {
          throw new Error('Headers must be a JSON object.');
        }
        setDet(await api<Detection>('schemas/detect', { body: { path: s.path, headers, body: s.body } }));
      },
      undefined,
      { reload: false },
    );
  return (
    <Page icon="braces" title="Schemas" sub="Every request is scored against the API formats GuardRail knows. The best match is logged with each request.">
      <section id="sec-policy">
        <Section title="Schema policy">
          <Seg value={policy} label="Schema policy" onChange={(p) => void ui.run(() => api('settings', { method: 'PATCH', body: { schemaPolicy: p } }), 'Schema policy saved')} options={[['strict', 'Strict'], ['accept_known', 'Log only']]} />
          <Note>
            {policy === 'strict'
              ? 'Strict: a request whose body looks like a different format than its endpoint expects is rejected with 422, naming the format it looks like.'
              : 'Log only: mismatches are logged, but the request still goes through as long as the endpoint can forward it.'}{' '}
            The gateway forwards OpenAI Chat Completions and legacy Completions; other formats are detected and named, not translated yet.
          </Note>
        </Section>
      </section>
      <section id="sec-known">
        <Section title="Known schemas">
          {!schemas ? (
            <Loading error={err} />
          ) : (
            <div className="cx-table-wrap">
              <table className="cx-table">
                <thead>
                  <tr>
                    <th>Schema</th>
                    <th>Path</th>
                    <th>Forwarded</th>
                  </tr>
                </thead>
                <tbody>
                  {schemas.map((x) => (
                    <tr key={x.id}>
                      <td>
                        <b>{x.name}</b>
                        <div className="cx-muted small">{x.description}</div>
                      </td>
                      <td className="mono">{x.path}</td>
                      <td>
                        <Pill tone={x.forwardable ? 'ok' : ''}>{x.forwardable ? 'Yes' : 'Detected only'}</Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </section>
      <section id="sec-decisions">
        <DecisionSchemas />
      </section>
      <section id="sec-tester">
        <Section
          title="Detection tester"
          actions={
            <select
              className="cx-input sm"
              value={sample}
              aria-label="Sample request"
              onChange={(e) => {
                setSample(e.target.value);
                setS(SAMPLES[e.target.value]);
                setDet(null);
              }}
            >
              {Object.keys(SAMPLES).map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          }
        >
          <div className="cx-form-row">
            <Field label="Path" grow>
              <input className="cx-input mono" value={s.path} onChange={(e) => setS({ ...s, path: e.target.value })} />
            </Field>
            <Field label="Headers (JSON)" grow>
              <input className="cx-input mono" value={s.headers} onChange={(e) => setS({ ...s, headers: e.target.value })} />
            </Field>
          </div>
          <Field label="Body">
            <textarea className="cx-input mono" rows={8} value={s.body} onChange={(e) => setS({ ...s, body: e.target.value })} />
          </Field>
          <div className="cx-form-row end">
            <button type="button" className="cx-btn pri" onClick={() => void detect()}>
              Detect
            </button>
          </div>
          {det && (
            <div className="cx-result" aria-live="polite">
              <div className="cx-form-row center">
                <Pill tone="info">
                  Looks like {det.best.name} ({Math.round(det.confidence * 100)}%)
                </Pill>
                {policy === 'strict' && det.best.path !== s.path && det.confidence >= 0.6 && s.path.endsWith('completions') && <Pill tone="bad">Strict would reject: 422</Pill>}
              </div>
              {det.scores.map((x) => (
                <div key={x.id} className="cx-bar-row">
                  <span>{x.name}</span>
                  <span className="cx-bar">
                    <i style={{ width: `${x.score * 100}%` }} />
                  </span>
                  <span className="mono cx-muted">{Math.round(x.score * 100)}%</span>
                </div>
              ))}
            </div>
          )}
        </Section>
      </section>
    </Page>
  );
}

/** Decision questions saved from a guard or router layer, to reuse in others. */
function DecisionSchemas() {
  const { data } = useStore();
  const ui = useUi();
  const list = data?.settings.decisionSchemas ?? [];
  const save = (next: typeof list, ok: string) => ui.run(() => api('settings', { method: 'PATCH', body: { decisionSchemas: next } }), ok);
  const used = (id: string) => {
    const s = list.find((x) => x.id === id)?.schema;
    return (data?.settings.guard.layers ?? []).filter((l) => s && JSON.stringify(l.decision) === JSON.stringify(s)).map((l) => l.name);
  };
  return (
    <Section title="Decision schemas" hint="Questions for decision models (Decisions API): what to ask, the answers it may give, and what each answer does. Save one from a guard or router layer with “Save as schema”, then pick it under “Start from” in any layer.">
      {list.length === 0 ? (
        <Note>No saved decision schemas yet. Open a guard or router layer that uses a decision model and press “Save as schema”.</Note>
      ) : (
        <div className="cx-table-wrap">
          <table className="cx-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Question</th>
                <th>Answers</th>
                <th>Used by</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {list.map((x) => {
                const answers = x.schema.criteria
                  .split('\n')
                  .map((l) => l.split('=')[0].trim())
                  .filter(Boolean);
                const by = used(x.id);
                return (
                  <tr key={x.id}>
                    <td>
                      <input
                        className="cx-input"
                        defaultValue={x.name}
                        aria-label="Schema name"
                        onBlur={(e) => {
                          const name = e.target.value.trim();
                          if (name && name !== x.name) void save(list.map((y) => (y.id === x.id ? { ...y, name } : y)), 'Renamed');
                        }}
                      />
                    </td>
                    <td>
                      <Pill>{x.schema.question === 'noul' ? 'Yes / no' : x.schema.question === 'choice' ? 'Choice' : 'Score'}</Pill>
                      <div className="cx-muted small">{x.schema.instructions.slice(0, 120)}</div>
                    </td>
                    <td className="mono small">{x.schema.question === 'score' ? `${answers.length} levels` : answers.join(' · ')}</td>
                    <td className="cx-muted small">{by.length ? by.join(', ') : '–'}</td>
                    <td>
                      <button
                        type="button"
                        className="cx-btn sm danger"
                        onClick={async () => {
                          if (await ui.confirm({ title: `Delete "${x.name}"?`, body: 'Layers that started from it keep their own copy of the question.', ok: 'Delete', danger: true })) void save(list.filter((y) => y.id !== x.id), 'Decision schema deleted');
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
