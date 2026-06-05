/**
 * Subcontractor-portal payments page — the public, magic-link-authed surface
 * where a subcontractor lists and submits payment applications.
 *
 * Auth model (NOT the internal JWT):
 *   - A magic-link lands here as /portal/payments?token=<magic-link>. On mount
 *     we consume it via POST /portal/auth/consume, store the returned session
 *     token in sessionStorage, then strip ?token from the URL.
 *   - On a return visit the stored session token is reused.
 *   - A 401 anywhere clears the token and drops back to the sign-in prompt so
 *     the user re-opens their invitation link.
 *
 * This deliberately renders WITHOUT the internal app shell (it is reachable by
 * external subcontractors), mirroring features/buyer-portal.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { Loader2, AlertCircle, KeyRound } from 'lucide-react';
import { Card, EmptyState } from '@/shared/ui';
import { PaymentApplicationList } from './PaymentApplicationList';
import { PaymentApplicationForm } from './PaymentApplicationForm';
import { PaymentApplicationDetailModal } from './PaymentApplicationDetailModal';
import { consumePortalMagicLink, getPortalSessionToken } from './api';

type View = 'list' | 'form';

export function PortalPaymentsPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const magicToken = params.get('token');

  const [authed, setAuthed] = useState<boolean>(() => !!getPortalSessionToken());
  const [authError, setAuthError] = useState<string | null>(null);
  const [consuming, setConsuming] = useState<boolean>(!!magicToken);
  const [view, setView] = useState<View>('list');
  const [openId, setOpenId] = useState<string | null>(null);

  // Consume a magic-link token if present in the URL, then clean the URL.
  useEffect(() => {
    if (!magicToken) return;
    let cancelled = false;
    setConsuming(true);
    setAuthError(null);
    consumePortalMagicLink(magicToken)
      .then(() => {
        if (cancelled) return;
        setAuthed(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setAuthError(err instanceof Error ? err.message : 'Sign-in failed');
      })
      .finally(() => {
        if (cancelled) return;
        setConsuming(false);
        // Strip the one-time token from the address bar.
        const next = new URLSearchParams(params);
        next.delete('token');
        setParams(next, { replace: true });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [magicToken]);

  if (consuming) {
    return (
      <CenteredShell>
        <Card padding="lg" className="flex flex-col items-center gap-3 text-center">
          <Loader2 className="animate-spin text-oe-blue" size={28} />
          <p className="text-sm text-content-secondary">
            {t('payportal.signing_in', { defaultValue: 'Signing you in…' })}
          </p>
        </Card>
      </CenteredShell>
    );
  }

  if (!authed) {
    return (
      <CenteredShell>
        <Card padding="none" className="w-full max-w-md">
          <EmptyState
            icon={authError ? <AlertCircle size={22} /> : <KeyRound size={22} />}
            title={
              authError
                ? t('payportal.signin_failed', { defaultValue: 'Sign-in failed' })
                : t('payportal.signin_title', {
                    defaultValue: 'Sign in to the subcontractor portal',
                  })
            }
            description={
              authError ??
              t('payportal.signin_prompt', {
                defaultValue: 'Open the secure link from your invitation email to continue.',
              })
            }
          />
        </Card>
      </CenteredShell>
    );
  }

  // Authenticated surface.
  return (
    <CenteredShell>
      <div className="w-full max-w-2xl">
        {view === 'form' ? (
          <PaymentApplicationForm
            onCancel={() => setView('list')}
            onDone={() => setView('list')}
          />
        ) : (
          <PaymentApplicationList onNew={() => setView('form')} onOpen={setOpenId} />
        )}
      </div>
      {openId ? (
        <PaymentApplicationDetailModal id={openId} onClose={() => setOpenId(null)} />
      ) : null}
    </CenteredShell>
  );
}

function CenteredShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-surface-secondary px-4 py-6">
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center">{children}</div>
    </div>
  );
}
