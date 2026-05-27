/**
 * SmartViewBuilder — visual rule-tree editor for the BIM module.
 *
 * Replaces the legacy IFC-biased "filter chips + property search" UI with a
 * canonical-format-aware rule builder that works for ANY CAD source
 * (RVT / IFC / DWG / DGN / PDF photo-takeoff).  Built around three pickers
 * (Property → Operator → Value) plus AND/OR groups that can nest.
 *
 * Backend wires:
 *   GET  /v1/bim_hub/smart-views/properties?model_id=<id>
 *        — Property Catalog grouped by Identity / Geometry / Quantities /
 *          Properties with sample-value previews + source-format badges.
 *   POST /v1/bim_hub/smart-views/preview
 *        — Live count of matching elements (drives the "234 match" pill).
 *
 * Sub-components in this file (kept local to avoid an explosion of tiny
 * files — every one of them is < 90 LoC and only the builder is exported):
 *   - PropertyPicker — search-as-you-type, grouped dropdown, source badges
 *   - OperatorPicker — type-aware operator menu
 *   - ValueInput     — type-aware input (enum dropdown / number / between)
 *   - QuickPresets   — one-click rule recipes for common queries
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Plus, Search, Trash2, X, Zap } from 'lucide-react';
import {
  fetchSmartViewProperties,
  previewSmartView,
  type SmartViewGroup,
  type SmartViewLeaf,
  type SmartViewOp,
  type SmartViewProperty,
  type SmartViewPropertyCatalog,
} from './api';

/* ── Helpers ────────────────────────────────────────────────────────────── */

/** All operators in the engine, grouped by which data_type they apply to. */
const STRING_OPS: SmartViewOp[] = [
  '=',
  '!=',
  'contains',
  'starts_with',
  'ends_with',
  'regex',
  'in',
  'not_in',
  'is_empty',
  'is_not_empty',
];
const NUMERIC_OPS: SmartViewOp[] = [
  '=',
  '!=',
  '>',
  '<',
  '>=',
  '<=',
  'between',
  'in',
  'not_in',
  'is_empty',
  'is_not_empty',
];

/** Human-readable label for each operator — keyed by op symbol. */
function opLabel(op: SmartViewOp): string {
  const table: Record<SmartViewOp, string> = {
    '=': 'equals',
    '!=': 'not equals',
    contains: 'contains',
    starts_with: 'starts with',
    ends_with: 'ends with',
    regex: 'matches regex',
    '>': 'greater than',
    '<': 'less than',
    '>=': 'at least',
    '<=': 'at most',
    between: 'between',
    in: 'is any of',
    not_in: 'is none of',
    is_empty: 'is empty',
    is_not_empty: 'is set',
  };
  return table[op];
}

function isGroup(node: SmartViewLeaf | SmartViewGroup): node is SmartViewGroup {
  return (
    typeof (node as SmartViewGroup).op === 'string' &&
    ((node as SmartViewGroup).op === 'AND' || (node as SmartViewGroup).op === 'OR')
  );
}

/** Build a deep clone of the tree so we can mutate immutably. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/* ── Quick presets — pre-built rule recipes ─────────────────────────────── */

interface Preset {
  id: string;
  label: string;
  build: () => SmartViewGroup;
}

const PRESETS: Preset[] = [
  {
    id: 'walls',
    label: 'Walls only',
    build: () => ({
      op: 'OR',
      rules: [
        { field: 'element_type', op: 'in', value: ['IfcWall', 'Walls', 'wall'] },
        { field: 'category', op: '=', value: 'wall' },
      ],
    }),
  },
  {
    id: 'doors',
    label: 'Doors only',
    build: () => ({
      op: 'OR',
      rules: [
        { field: 'element_type', op: 'in', value: ['IfcDoor', 'Doors', 'door'] },
        { field: 'category', op: '=', value: 'door' },
      ],
    }),
  },
  {
    id: 'concrete',
    label: 'Concrete elements',
    build: () => ({
      op: 'AND',
      rules: [
        { field: 'properties.material', op: 'contains', value: 'concrete' },
      ],
    }),
  },
  {
    id: 'din330',
    label: 'DIN 276: Outer walls (330)',
    build: () => ({
      op: 'AND',
      rules: [{ field: 'identity.din276', op: '=', value: '330' }],
    }),
  },
  {
    id: 'tall',
    label: 'Tall elements (h > 3 m)',
    build: () => ({
      op: 'AND',
      rules: [
        { field: 'geometry.height_m', op: '>', value: 3 },
      ],
    }),
  },
  {
    id: 'no_material',
    label: 'Missing material',
    build: () => ({
      op: 'AND',
      rules: [{ field: 'properties.material', op: 'is_empty' }],
    }),
  },
];

/* ── Property Picker ────────────────────────────────────────────────────── */

interface PropertyPickerProps {
  catalog: SmartViewPropertyCatalog | null | undefined;
  value: string;
  onChange: (field: string, entry: SmartViewProperty | undefined) => void;
  disabled?: boolean;
}

function PropertyPicker({ catalog, value, onChange, disabled }: PropertyPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const entries = catalog?.entries ?? [];
  const selected = entries.find((e) => e.field === value);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? entries.filter(
          (e) =>
            e.field.toLowerCase().includes(q) ||
            e.label.toLowerCase().includes(q) ||
            e.sample_values.some((s) => s.toLowerCase().includes(q)),
        )
      : entries;
    const out: Record<string, SmartViewProperty[]> = {
      identity: [],
      geometry: [],
      quantities: [],
      properties: [],
    };
    for (const e of filtered) out[e.group]?.push(e);
    return out;
  }, [entries, query]);

  const groupTitles: Record<string, string> = {
    identity: t('bim.smartview.group_identity', { defaultValue: 'Identity' }),
    geometry: t('bim.smartview.group_geometry', { defaultValue: 'Geometry' }),
    quantities: t('bim.smartview.group_quantities', { defaultValue: 'Quantities' }),
    properties: t('bim.smartview.group_properties', { defaultValue: 'Properties' }),
  };

  return (
    <div className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded border text-[11px] ${
          disabled
            ? 'border-border-light bg-surface-tertiary text-content-quaternary'
            : 'border-border-light bg-surface-secondary text-content-primary hover:bg-surface-tertiary'
        }`}
        title={selected?.field}
      >
        {selected ? (
          <>
            <span className="text-[9px] font-bold uppercase tracking-wider text-content-tertiary">
              {selected.group.slice(0, 3)}
            </span>
            <span className="font-medium">{selected.label}</span>
            {selected.source_formats[0] && (
              <span className="text-[8px] font-bold uppercase tracking-wider px-1 rounded bg-oe-blue/10 text-oe-blue">
                {selected.source_formats[0]}
              </span>
            )}
          </>
        ) : (
          <span className="text-content-tertiary">
            {t('bim.smartview.pick_property', { defaultValue: 'Pick a property…' })}
          </span>
        )}
        <ChevronDown size={10} className="text-content-quaternary" />
      </button>
      {open && (
        <div
          className="absolute z-30 mt-1 w-[320px] max-h-[420px] overflow-auto rounded-md border border-border-light bg-surface-primary shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          <div className="sticky top-0 bg-surface-primary border-b border-border-light p-2">
            <div className="relative">
              <Search
                size={12}
                className="absolute start-2 top-1/2 -translate-y-1/2 text-content-quaternary"
              />
              <input
                autoFocus
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('bim.smartview.search_properties', {
                  defaultValue: 'Search properties…',
                })}
                className="w-full ps-7 pe-2 py-1 text-[11px] rounded border border-border-light bg-surface-secondary focus:outline-none focus:ring-1 focus:ring-oe-blue"
              />
            </div>
          </div>
          {(['identity', 'geometry', 'quantities', 'properties'] as const).map(
            (g) => {
              const list = grouped[g];
              if (!list || list.length === 0) return null;
              return (
                <div key={g} className="py-1">
                  <div className="px-2 pt-1 pb-0.5 text-[9px] font-bold uppercase tracking-wider text-content-tertiary">
                    {groupTitles[g]}
                  </div>
                  {list.map((entry) => (
                    <button
                      key={entry.field}
                      type="button"
                      onClick={() => {
                        onChange(entry.field, entry);
                        setOpen(false);
                        setQuery('');
                      }}
                      className={`w-full flex items-center gap-1.5 px-2 py-1 text-[11px] text-start hover:bg-surface-secondary ${
                        value === entry.field
                          ? 'bg-oe-blue/10 text-oe-blue'
                          : 'text-content-primary'
                      }`}
                    >
                      <span className="font-medium truncate flex-1">
                        {entry.label}
                      </span>
                      <span className="text-[9px] text-content-quaternary tabular-nums shrink-0">
                        {entry.distinct_count}
                      </span>
                      {entry.source_formats[0] && (
                        <span className="text-[8px] font-bold uppercase px-1 rounded bg-surface-secondary text-content-tertiary">
                          {entry.source_formats[0]}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              );
            },
          )}
          {entries.length === 0 && (
            <div className="px-3 py-4 text-[11px] text-content-tertiary italic text-center">
              {t('bim.smartview.no_properties', {
                defaultValue: 'No properties discovered for this model yet.',
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Operator Picker ────────────────────────────────────────────────────── */

interface OperatorPickerProps {
  dataType: SmartViewProperty['data_type'] | undefined;
  value: SmartViewOp;
  onChange: (op: SmartViewOp) => void;
  disabled?: boolean;
}

function OperatorPicker({ dataType, value, onChange, disabled }: OperatorPickerProps) {
  const ops = useMemo(() => {
    if (dataType === 'number') return NUMERIC_OPS;
    return STRING_OPS;
  }, [dataType]);
  return (
    <select
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(e.target.value as SmartViewOp)}
      className="px-2 py-1 rounded border border-border-light bg-surface-secondary text-[11px] text-content-primary focus:outline-none focus:ring-1 focus:ring-oe-blue disabled:opacity-50"
    >
      {ops.map((op) => (
        <option key={op} value={op}>
          {opLabel(op)}
        </option>
      ))}
    </select>
  );
}

/* ── Value Input ────────────────────────────────────────────────────────── */

interface ValueInputProps {
  property: SmartViewProperty | undefined;
  op: SmartViewOp;
  value: unknown;
  onChange: (value: unknown) => void;
}

function ValueInput({ property, op, value, onChange }: ValueInputProps) {
  const { t } = useTranslation();

  // No value needed for empty checks.
  if (op === 'is_empty' || op === 'is_not_empty') {
    return <span className="text-[11px] text-content-quaternary italic">—</span>;
  }

  // between → two numeric inputs.
  if (op === 'between') {
    const tuple = Array.isArray(value) ? value : [];
    return (
      <div className="inline-flex items-center gap-1">
        <input
          type="number"
          value={(tuple[0] as number | undefined) ?? ''}
          onChange={(e) => onChange([Number(e.target.value), tuple[1] ?? 0])}
          className="w-16 px-1.5 py-1 rounded border border-border-light bg-surface-secondary text-[11px] focus:outline-none focus:ring-1 focus:ring-oe-blue"
          placeholder="min"
        />
        <span className="text-[10px] text-content-tertiary">…</span>
        <input
          type="number"
          value={(tuple[1] as number | undefined) ?? ''}
          onChange={(e) => onChange([tuple[0] ?? 0, Number(e.target.value)])}
          className="w-16 px-1.5 py-1 rounded border border-border-light bg-surface-secondary text-[11px] focus:outline-none focus:ring-1 focus:ring-oe-blue"
          placeholder="max"
        />
      </div>
    );
  }

  // in / not_in → comma-separated multi value (with autocomplete from
  // sample_values when the property is an enum).
  if (op === 'in' || op === 'not_in') {
    const arr = Array.isArray(value) ? value : [];
    return (
      <div className="inline-flex flex-wrap items-center gap-1 max-w-[280px]">
        {arr.map((v, i) => (
          <span
            key={`${String(v)}-${i}`}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-oe-blue/10 text-oe-blue"
          >
            {String(v)}
            <button
              type="button"
              onClick={() => onChange(arr.filter((_, j) => j !== i))}
              className="hover:text-rose-600"
            >
              <X size={9} />
            </button>
          </span>
        ))}
        <select
          value=""
          onChange={(e) => {
            const next = e.target.value;
            if (next && !arr.includes(next)) onChange([...arr, next]);
          }}
          className="px-1 py-0.5 rounded border border-border-light bg-surface-secondary text-[11px] focus:outline-none focus:ring-1 focus:ring-oe-blue"
        >
          <option value="">
            {t('bim.smartview.add_value', { defaultValue: '+ add' })}
          </option>
          {(property?.sample_values ?? []).map((sv) => (
            <option key={sv} value={sv}>
              {sv}
            </option>
          ))}
        </select>
      </div>
    );
  }

  // Numeric ops → number input.
  if (
    property?.data_type === 'number' ||
    op === '>' ||
    op === '<' ||
    op === '>=' ||
    op === '<='
  ) {
    return (
      <input
        type="number"
        value={(value as number | string | undefined) ?? ''}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-24 px-1.5 py-1 rounded border border-border-light bg-surface-secondary text-[11px] focus:outline-none focus:ring-1 focus:ring-oe-blue"
      />
    );
  }

  // Enum → dropdown with the model's distinct values.
  if (
    property?.data_type === 'enum' &&
    property.sample_values.length > 0 &&
    (op === '=' || op === '!=')
  ) {
    return (
      <select
        value={(value as string | undefined) ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="max-w-[180px] px-1.5 py-1 rounded border border-border-light bg-surface-secondary text-[11px] focus:outline-none focus:ring-1 focus:ring-oe-blue"
      >
        <option value="">{t('common.select', { defaultValue: 'Select…' })}</option>
        {property.sample_values.map((sv) => (
          <option key={sv} value={sv}>
            {sv}
          </option>
        ))}
      </select>
    );
  }

  // Default — free-text input.
  return (
    <input
      type="text"
      value={(value as string | undefined) ?? ''}
      onChange={(e) => onChange(e.target.value)}
      className="w-32 px-1.5 py-1 rounded border border-border-light bg-surface-secondary text-[11px] focus:outline-none focus:ring-1 focus:ring-oe-blue"
      placeholder={op === 'regex' ? '^foo.*$' : 'value'}
    />
  );
}

/* ── Recursive group renderer ──────────────────────────────────────────── */

interface GroupRendererProps {
  group: SmartViewGroup;
  path: number[];
  catalog: SmartViewPropertyCatalog | null | undefined;
  onChange: (next: SmartViewGroup) => void;
  depth: number;
}

function GroupRenderer({
  group,
  path,
  catalog,
  onChange,
  depth,
}: GroupRendererProps) {
  const { t } = useTranslation();
  const propertyByField = useMemo(() => {
    const map = new Map<string, SmartViewProperty>();
    for (const e of catalog?.entries ?? []) map.set(e.field, e);
    return map;
  }, [catalog]);

  const toggleOp = () => {
    const next = clone(group);
    next.op = next.op === 'AND' ? 'OR' : 'AND';
    onChange(next);
  };
  const addLeaf = () => {
    const next = clone(group);
    next.rules.push({ field: 'element_type', op: '=', value: '' });
    onChange(next);
  };
  const addGroup = () => {
    const next = clone(group);
    next.rules.push({ op: 'AND', rules: [] });
    onChange(next);
  };
  const removeChild = (idx: number) => {
    const next = clone(group);
    next.rules.splice(idx, 1);
    onChange(next);
  };
  const updateChild = (idx: number, child: SmartViewLeaf | SmartViewGroup) => {
    const next = clone(group);
    next.rules[idx] = child;
    onChange(next);
  };

  return (
    <div
      className={`rounded-md border p-2 space-y-1.5 ${
        depth === 0
          ? 'border-border-light bg-surface-primary'
          : 'border-dashed border-border-light bg-surface-secondary/40'
      }`}
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={toggleOp}
          className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
            group.op === 'AND'
              ? 'bg-oe-blue text-white'
              : 'bg-amber-500 text-white'
          }`}
          title={t('bim.smartview.toggle_andor', {
            defaultValue: 'Click to switch AND ↔ OR',
          })}
        >
          {group.op}
        </button>
        <span className="text-[10px] text-content-tertiary">
          {group.rules.length === 0
            ? t('bim.smartview.empty_group', {
                defaultValue: 'No rules yet — add one →',
              })
            : t('bim.smartview.rule_count', {
                defaultValue: '{{n}} rules',
                n: group.rules.length,
              })}
        </span>
        <div className="ms-auto flex items-center gap-1">
          <button
            type="button"
            onClick={addLeaf}
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-content-secondary hover:bg-surface-tertiary"
          >
            <Plus size={9} />
            {t('bim.smartview.add_rule', { defaultValue: 'Rule' })}
          </button>
          {depth < 5 && (
            <button
              type="button"
              onClick={addGroup}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-content-secondary hover:bg-surface-tertiary"
            >
              <Plus size={9} />
              {t('bim.smartview.add_group', { defaultValue: 'Group' })}
            </button>
          )}
        </div>
      </div>
      {group.rules.length > 0 && (
        <div className="space-y-1 ps-2 border-s-2 border-border-light/70">
          {group.rules.map((child, idx) => {
            if (isGroup(child)) {
              return (
                <div key={`g-${idx}`} className="flex items-start gap-1">
                  <div className="flex-1 min-w-0">
                    <GroupRenderer
                      group={child}
                      path={[...path, idx]}
                      catalog={catalog}
                      onChange={(next) => updateChild(idx, next)}
                      depth={depth + 1}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeChild(idx)}
                    className="mt-1 p-0.5 rounded text-content-quaternary hover:text-rose-600"
                    title={t('common.remove', { defaultValue: 'Remove' })}
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              );
            }
            const property = propertyByField.get(child.field);
            return (
              <div
                key={`l-${idx}`}
                className="flex items-center gap-1.5 flex-wrap text-[11px]"
              >
                <PropertyPicker
                  catalog={catalog}
                  value={child.field}
                  onChange={(field, entry) => {
                    // When the field type changes, reset value to a sane default.
                    const next: SmartViewLeaf = { ...child, field };
                    if (entry?.data_type === 'number') {
                      next.value = 0;
                      if (!NUMERIC_OPS.includes(child.op)) next.op = '=';
                    } else {
                      if (!STRING_OPS.includes(child.op)) next.op = '=';
                      next.value = '';
                    }
                    updateChild(idx, next);
                  }}
                />
                <OperatorPicker
                  dataType={property?.data_type}
                  value={child.op}
                  onChange={(op) => updateChild(idx, { ...child, op })}
                />
                <ValueInput
                  property={property}
                  op={child.op}
                  value={child.value}
                  onChange={(value) => updateChild(idx, { ...child, value })}
                />
                <button
                  type="button"
                  onClick={() => removeChild(idx)}
                  className="ms-auto p-0.5 rounded text-content-quaternary hover:text-rose-600"
                  title={t('common.remove', { defaultValue: 'Remove' })}
                >
                  <Trash2 size={10} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Public API ─────────────────────────────────────────────────────────── */

export interface SmartViewBuilderProps {
  modelId: string | null;
  projectId: string | null;
  /** Current rule tree.  Pass an empty AND group to start from scratch. */
  value: SmartViewGroup;
  onChange: (next: SmartViewGroup) => void;
  /** Optional CTA shown next to the live count — e.g. "Save as Smart View". */
  renderActions?: (matchedCount: number) => React.ReactNode;
}

/**
 * SmartViewBuilder — full visual rule builder.  Renders presets, the
 * group tree (with nesting), and a debounced live preview pill.
 */
export default function SmartViewBuilder({
  modelId,
  projectId,
  value,
  onChange,
  renderActions,
}: SmartViewBuilderProps) {
  const { t } = useTranslation();

  // ── Property catalog (cached per model) ──────────────────────────────
  const catalogQuery = useQuery<SmartViewPropertyCatalog>({
    queryKey: ['bim-smart-view-properties', modelId],
    enabled: !!modelId,
    queryFn: () => fetchSmartViewProperties(modelId!),
    staleTime: 5 * 60 * 1000,
  });
  const catalog = catalogQuery.data;

  // ── Live count preview (debounced) ───────────────────────────────────
  const [debouncedTree, setDebouncedTree] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedTree(value), 300);
    return () => clearTimeout(t);
  }, [value]);

  const previewQuery = useQuery({
    queryKey: ['bim-smart-view-preview', modelId, projectId, debouncedTree],
    enabled: !!modelId || !!projectId,
    queryFn: () =>
      previewSmartView({
        model_id: modelId,
        project_id: projectId,
        rule_tree: debouncedTree,
        sample_limit: 0,
      }),
    staleTime: 30 * 1000,
  });
  const matched = previewQuery.data?.matched_count ?? null;

  const applyPreset = useCallback(
    (preset: Preset) => {
      onChange(preset.build());
    },
    [onChange],
  );

  return (
    <div className="space-y-3">
      {/* Quick presets */}
      <div>
        <div className="flex items-center gap-1.5 mb-1.5">
          <Zap size={12} className="text-amber-500" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-content-tertiary">
            {t('bim.smartview.presets', { defaultValue: 'Quick presets' })}
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => applyPreset(p)}
              className="px-2 py-1 rounded-md border border-border-light bg-surface-secondary text-[10px] text-content-secondary hover:bg-oe-blue/5 hover:border-oe-blue/30 hover:text-oe-blue transition-colors"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Rule tree */}
      <div>
        <GroupRenderer
          group={value}
          path={[]}
          catalog={catalog}
          onChange={onChange}
          depth={0}
        />
      </div>

      {/* Live count pill + actions */}
      <div className="flex items-center gap-2 flex-wrap">
        {matched === null ? (
          previewQuery.isFetching ? (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] bg-surface-secondary text-content-tertiary">
              {t('bim.smartview.calculating', { defaultValue: 'Calculating…' })}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] bg-surface-secondary text-content-tertiary">
              —
            </span>
          )
        ) : (
          <span
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-semibold ${
              matched === 0
                ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
                : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
            }`}
            data-testid="smart-view-preview-count"
          >
            {t('bim.smartview.match_count', {
              defaultValue: '{{n}} elements match',
              n: matched,
            })}
          </span>
        )}
        {previewQuery.data?.truncated && (
          <span className="text-[10px] text-amber-600">
            {t('bim.smartview.truncated', {
              defaultValue: 'Scan capped at 50K elements',
            })}
          </span>
        )}
        {renderActions?.(matched ?? 0)}
      </div>
    </div>
  );
}

export { isGroup as isSmartViewGroup, PRESETS as SMART_VIEW_PRESETS };
