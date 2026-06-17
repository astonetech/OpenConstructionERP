/**
 * Two-click scale calibration dialog.
 *
 * Called with the measured pixel distance between the two points the
 * user clicked on the PDF.  The user enters a real-world length and
 * picks one of four units (m, mm, ft, in).  On confirm, we convert the
 * value to meters and ask the parent to persist the new `ScaleConfig`
 * via `deriveScale()`.
 *
 * Keyboard:
 *   - Enter confirms (if the input is valid)
 *   - Esc cancels (handled by WideModal)
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ruler, Sparkles } from 'lucide-react';
import {
  type CalibrationUnit,
  deriveScale,
  presetScale,
  toMeters,
  type ScaleConfig,
} from '../../../modules/pdf-takeoff/data/scale-helpers';
import { WideModal } from '@/shared/ui/WideModal';
import { Button } from '@/shared/ui';
import { takeoffApi, type ScaleDetectionCandidate } from '../api';

/** What the user actually typed, for honest badge display.
 *
 *  The derived {@link ScaleConfig} is intentionally **metric-canonical**
 *  (`pixelsPerUnit` is always px-per-metre, `unitLabel` is always `'m'`),
 *  because every downstream consumer — preset scales, `ratioFromScale`,
 *  the recalc effect — assumes metres (see scale-helpers `deriveScale`).
 *  An estimator who calibrated in feet would otherwise see a bare `'m'`
 *  with no hint their feet were honoured (D-TKC-016).  We surface the
 *  raw entry so the calibration badge can show `10 ft → 3.05 m`. */
export interface CalibrationEntry {
  /** The number the user typed. */
  realLength: number;
  /** The unit the user picked in the dialog. */
  unit: CalibrationUnit;
}

export interface CalibrationDialogProps {
  /** Measured pixel distance between the two picked points. */
  pixelDistance: number;
  /** Called when the user confirms a valid calibration.  The second
   *  argument echoes the user's raw entry (value + chosen unit) so the
   *  caller can label the calibration in the unit the estimator actually
   *  used, even though `scale` itself stays metric-canonical. */
  onConfirm: (scale: ScaleConfig, entry: CalibrationEntry) => void;
  /** Called when the user cancels (Esc, backdrop click, Cancel button). */
  onCancel: () => void;
  /** Optional initial real-length value (defaults to 1). */
  initialRealLength?: number;
  /** Optional initial unit (defaults to meters). */
  initialUnit?: CalibrationUnit;
  /** Optional uploaded-document id. When provided, the dialog asks the backend
   *  to detect an explicit drawing scale from the PDF's text layer (tier-1,
   *  AI-free) and offers a one-click "Use this" suggestion. Omitted (e.g. a
   *  local-only PDF with no server document) -> no detection, dialog behaves
   *  exactly as the manual two-click calibration it always was. */
  documentId?: string | null;
  /** Current 1-based page; the detected scale for this page is preferred over
   *  the document-wide best (a title-block scale can differ per sheet). */
  page?: number;
}

const UNIT_OPTIONS: { value: CalibrationUnit; label: string }[] = [
  { value: 'm', label: 'm (meters)' },
  { value: 'mm', label: 'mm (millimeters)' },
  { value: 'ft', label: 'ft (feet)' },
  { value: 'in', label: 'in (inches)' },
];

export function CalibrationDialog({
  pixelDistance,
  onConfirm,
  onCancel,
  initialRealLength = 1,
  initialUnit = 'm',
  documentId,
  page = 1,
}: CalibrationDialogProps) {
  const { t } = useTranslation();
  const [realLength, setRealLength] = useState<string>(String(initialRealLength));
  const [unit, setUnit] = useState<CalibrationUnit>(initialUnit);
  const inputRef = useRef<HTMLInputElement>(null);

  // Tier-1 scale auto-detect from the PDF text layer. Runs once per
  // (documentId, page) when a server document id is available; a null result
  // (module disabled, no scale note, or a fetch error) simply hides the
  // suggestion so the manual flow is never blocked.
  const [detected, setDetected] = useState<ScaleDetectionCandidate | null>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    if (!documentId) {
      setDetected(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await takeoffApi.detectScale(documentId);
        if (cancelled || !res) {
          if (!cancelled) setDetected(null);
          return;
        }
        // Prefer a candidate found on the page being calibrated (a per-sheet
        // title block can carry its own scale); otherwise fall back to the
        // document-wide best.
        const forPage = res.candidates.find((c) => c.page === page);
        setDetected(forPage ?? res.best ?? null);
      } catch {
        // Detection is a best-effort convenience; never surface an error or
        // block the manual two-click calibration if it fails.
        if (!cancelled) setDetected(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [documentId, page]);

  const parsed = Number(realLength);
  const isValid = Number.isFinite(parsed) && parsed > 0 && pixelDistance > 0;

  const handleConfirm = () => {
    if (!isValid) return;
    const meters = toMeters(parsed, unit);
    // `scale` stays metric-canonical (deriveScale always labels in metres
    // — every downstream consumer assumes that).  We additionally hand the
    // caller the raw entry so the calibration badge can honour the unit
    // the estimator actually typed (D-TKC-016).
    onConfirm(deriveScale(pixelDistance, meters), { realLength: parsed, unit });
  };

  /** Apply a detected paper scale through the SAME calibration path as a
   *  manual entry. ``presetScale`` turns the ``1:N`` ratio into the canonical
   *  pixels-per-metre config; the entry echoes the real-world length of the
   *  reference line the user picked at that scale so the existing badge / toast
   *  render meaningfully (metric-canonical, like every other calibration). */
  const handleUseDetected = () => {
    if (!detected) return;
    const scale = presetScale(detected.ratio);
    if (scale.invalid || scale.pixelsPerUnit <= 0) return;
    const meters = pixelDistance > 0 ? pixelDistance / scale.pixelsPerUnit : 0;
    onConfirm(scale, { realLength: meters, unit: 'm' });
  };

  return (
    <WideModal
      open
      onClose={onCancel}
      title={t('takeoff_viewer.calibrate_title', { defaultValue: 'Calibrate Scale' })}
      size="sm"
      subtitle={
        <span className="inline-flex items-center gap-1.5">
          <Ruler size={12} className="text-purple-500" />
          {t('takeoff_viewer.calibrate_desc', {
            defaultValue:
              'You picked a line of {{pixels}} pixels. Enter its real-world length:',
            pixels: pixelDistance.toFixed(0),
          })}
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            disabled={!isValid}
            data-testid="calibration-confirm"
          >
            {t('takeoff_viewer.calibrate_confirm', {
              defaultValue: 'Apply calibration',
            })}
          </Button>
        </>
      }
    >
      <div data-testid="calibration-dialog">
        {detected && (
          <div
            className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-purple-500/30 bg-purple-500/5 px-3 py-2"
            data-testid="detected-scale-banner"
          >
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-xs font-medium text-content-primary">
                <Sparkles size={12} className="shrink-0 text-purple-500" />
                {t('takeoff_viewer.detect_scale_found', {
                  defaultValue: 'Detected scale: {{label}}',
                  label: detected.label,
                })}
              </p>
              {detected.evidence && (
                <p
                  className="mt-0.5 truncate text-[10px] text-content-tertiary"
                  title={detected.evidence}
                  data-testid="detected-scale-evidence"
                >
                  {t('takeoff_viewer.detect_scale_evidence', {
                    defaultValue: 'Found "{{evidence}}" on page {{page}}',
                    evidence: detected.evidence,
                    page: detected.page,
                  })}
                </p>
              )}
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleUseDetected}
              data-testid="detected-scale-use"
            >
              {t('takeoff_viewer.detect_scale_use', { defaultValue: 'Use this' })}
            </Button>
          </div>
        )}
        {detected && (
          <p className="mb-3 text-[10px] text-content-quaternary">
            {t('takeoff_viewer.detect_scale_or_manual', {
              defaultValue: 'or calibrate manually from the line you picked:',
            })}
          </p>
        )}
        <div className="grid grid-cols-[1fr_auto] gap-2 mb-4">
          <input
            ref={inputRef}
            type="number"
            value={realLength}
            onChange={(e) => setRealLength(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && isValid) handleConfirm();
            }}
            className="rounded border border-border bg-surface-secondary px-2 py-1.5 text-sm text-content-primary"
            min={0}
            step={0.01}
            aria-label={t('takeoff_viewer.calibrate_length', {
              defaultValue: 'Real-world length',
            })}
            data-testid="calibration-length-input"
          />
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value as CalibrationUnit)}
            className="rounded border border-border bg-surface-secondary px-2 py-1.5 text-sm text-content-primary"
            aria-label={t('takeoff_viewer.calibrate_unit', { defaultValue: 'Unit' })}
            data-testid="calibration-unit-select"
          >
            {UNIT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        {isValid && unit !== 'm' && (
          <p
            className="text-[10px] text-purple-500/90 mb-2 tabular-nums"
            data-testid="calibration-metric-note"
          >
            {t('takeoff_viewer.calibrate_metric_note', {
              defaultValue:
                '{{value}} {{unit}} = {{meters}} m - measurements display in metres (metric-canonical).',
              value: parsed,
              unit,
              meters: toMeters(parsed, unit).toFixed(3),
            })}
          </p>
        )}
        <p className="text-[10px] text-content-tertiary">
          {t('takeoff_viewer.calibrate_hint', {
            defaultValue:
              'Tip: pick two points along a known dimension (door, wall, grid line).',
          })}
        </p>
      </div>
    </WideModal>
  );
}

export default CalibrationDialog;
