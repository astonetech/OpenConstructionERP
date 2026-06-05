import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, Gauge, Loader2, RefreshCw } from 'lucide-react';

import { Breadcrumb, Button, Card, EmptyState } from '@/shared/ui';
import { projectsApi } from '@/features/projects/api';
import { useProjectContextStore } from '@/stores/useProjectContextStore';

import type { ControlsKPI } from './api';
import { useControlsSnapshot } from './api';
import { ControlsTile } from './ControlsTile';
import { DrillDrawer } from './DrillDrawer';

const PORTFOLIO = '__portfolio__';

/**
 * Executive cross-module controls dashboard (connective-tissue feature 09).
 *
 * One screen, six domains (Cost, Schedule, Quality, Safety, Risk, Changes),
 * every number status-banded and traceable back to the owning module via
 * the drill drawer. Reads the single consolidated /snapshot endpoint.
 */
export function ProjectControlsPage() {
  const { t } = useTranslation();
  const activeProjectId = useProjectContextStore((s) => s.activeProjectId);
  const [scope, setScope] = useState<string>(activeProjectId ?? PORTFOLIO);
  const [drillKpi, setDrillKpi] = useState<ControlsKPI | null>(null);

  const projectId = scope === PORTFOLIO ? null : scope;

  const projectsQ = useQuery({
    queryKey: ['projects', 'list', 'controls'],
    queryFn: () => projectsApi.list(),
  });

  const snapshotQ = useControlsSnapshot(projectId);
  const snapshot = snapshotQ.data;

  const alerts = snapshot?.alerts ?? [];
  const criticalCount = useMemo(
    () => alerts.filter((a) => a.severity === 'critical').length,
    [alerts],
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <Breadcrumb
        items={[
          { label: t('nav.group_analytics', { defaultValue: 'Analytics' }) },
          {
            label: t('nav.project_controls', {
              defaultValue: 'Project Controls',
            }),
          },
        ]}
      />

      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Gauge className="h-5 w-5 text-accent" />
          <h1 className="text-lg font-semibold text-content-primary">
            {t('controls.title', { defaultValue: 'Project Controls' })}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            aria-label={t('controls.scope', { defaultValue: 'Scope' })}
            className="rounded-md border border-border-subtle bg-surface-secondary px-2.5 py-1.5 text-sm text-content-primary"
          >
            <option value={PORTFOLIO}>
              {t('controls.portfolio', { defaultValue: 'Portfolio' })}
            </option>
            {(projectsQ.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => snapshotQ.refetch()}
            disabled={snapshotQ.isFetching}
          >
            <RefreshCw
              className={snapshotQ.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'}
            />
          </Button>
        </div>
      </div>

      <p className="mt-1 text-sm text-content-tertiary">
        {t('controls.subtitle', {
          defaultValue:
            'Cost, schedule, quality, safety, risk and change KPIs in one view. Click a tile to trace it back to the source records.',
        })}
      </p>

      {/* Alerts banner */}
      {alerts.length > 0 && (
        <div
          className={`mt-4 flex items-start gap-2 rounded-lg border p-3 text-sm ${
            criticalCount > 0
              ? 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
              : 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
          }`}
        >
          {criticalCount > 0 ? (
            <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">
              {t('controls.alerts_heading', {
                defaultValue: '{{n}} KPIs need attention',
                n: alerts.length,
              })}
            </span>
            {alerts.slice(0, 5).map((a) => (
              <span key={a.kpi_code}>{a.message}</span>
            ))}
          </div>
        </div>
      )}

      {/* Spine */}
      {snapshotQ.isLoading ? (
        <div className="mt-8 flex items-center gap-2 text-sm text-content-tertiary">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('common.loading', { defaultValue: 'Loading…' })}
        </div>
      ) : snapshotQ.isError ? (
        <EmptyState
          className="mt-8"
          title={t('controls.load_error', {
            defaultValue: 'Could not load the controls snapshot',
          })}
        />
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {(snapshot?.groups ?? []).map((group) => (
            <Card key={group.domain} className="p-4">
              <h2 className="mb-3 text-sm font-semibold text-content-secondary">
                {t(`controls.domain.${group.domain}`, {
                  defaultValue: group.label,
                })}
              </h2>
              <div className="grid grid-cols-2 gap-2.5">
                {group.kpis.map((kpi) => (
                  <ControlsTile key={kpi.code} kpi={kpi} onDrill={setDrillKpi} />
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      <DrillDrawer
        kpi={drillKpi}
        projectId={projectId}
        open={drillKpi !== null}
        onClose={() => setDrillKpi(null)}
      />
    </div>
  );
}
