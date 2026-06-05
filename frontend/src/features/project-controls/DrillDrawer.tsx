import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ExternalLink, Loader2 } from 'lucide-react';

import { SideDrawer, EmptyState } from '@/shared/ui';

import type { ControlsKPI } from './api';
import { useControlsDrill } from './api';

/**
 * Opens on tile click and fetches the underlying source rows behind a KPI.
 * Each row that maps to an owning module renders a deep link so a click
 * jumps straight to the source record (e.g. a pending variation -> /variations).
 */
export function DrillDrawer({
  kpi,
  projectId,
  open,
  onClose,
}: {
  kpi: ControlsKPI | null;
  projectId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const drillQ = useControlsDrill(kpi?.code ?? null, projectId, open);

  const records = drillQ.data?.records ?? [];

  return (
    <SideDrawer
      open={open}
      onClose={onClose}
      title={kpi?.label ?? t('controls.drill_title', { defaultValue: 'Details' })}
      subtitle={
        kpi
          ? t('controls.drill_subtitle', {
              defaultValue: '{{n}} source records',
              n: drillQ.data?.record_count ?? 0,
            })
          : undefined
      }
    >
      {drillQ.isLoading ? (
        <div className="flex items-center gap-2 p-4 text-sm text-content-tertiary">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('common.loading', { defaultValue: 'Loading…' })}
        </div>
      ) : records.length === 0 ? (
        <EmptyState
          title={t('controls.drill_empty', {
            defaultValue: 'No underlying records',
          })}
        />
      ) : (
        <div className="flex flex-col gap-2 p-1">
          {records.map((rec, idx) => {
            const fields = rec.fields;
            const title =
              (fields['title'] as string) ||
              (fields['name'] as string) ||
              (fields['code'] as string) ||
              (fields['ncr_number'] as string) ||
              (fields['incident_number'] as string) ||
              (fields['id'] as string) ||
              `#${idx + 1}`;
            return (
              <div
                key={(fields['id'] as string) ?? idx}
                className="rounded-md border border-border-subtle bg-surface-secondary p-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium text-content-primary">
                    {title}
                  </span>
                  {rec.deep_link && (
                    <Link
                      to={rec.deep_link}
                      onClick={onClose}
                      className="flex items-center gap-1 text-xs text-accent hover:underline"
                    >
                      {t('controls.open', { defaultValue: 'Open' })}
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                  )}
                </div>
                <dl className="mt-1.5 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-2xs text-content-tertiary">
                  {Object.entries(fields)
                    .filter(([k]) => k !== 'id' && k !== 'kind' && k !== 'project_id')
                    .map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="font-medium">{k}</dt>
                        <dd className="truncate tabular-nums">{String(v ?? '')}</dd>
                      </div>
                    ))}
                </dl>
              </div>
            );
          })}
        </div>
      )}
    </SideDrawer>
  );
}
