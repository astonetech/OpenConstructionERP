import { useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, ExternalLink, X } from 'lucide-react';

/**
 * VideoNewsCard - a compact, dismissible promo card in the sidebar that links
 * to a featured YouTube video. It reuses UpdateNotification's card frame
 * (same width, radius, shadow, and entrance animation) but is image-forward:
 * the bundled thumbnail carries a play overlay and a "Video" badge, with a
 * short title and subtitle below. Dismissal is remembered per-video in
 * localStorage, so swapping in a future featured video re-shows the card.
 */

const VIDEO_ID = 'R_PQQHXY-rQ';
const VIDEO_URL = 'https://youtu.be/R_PQQHXY-rQ';
const THUMBNAIL = '/brand/uberization-construction.jpg';
const DISMISS_KEY = 'oe_video_news_dismissed';

export function VideoNewsCard() {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === VIDEO_ID;
    } catch {
      return false;
    }
  });

  if (dismissed) return null;

  const handleDismiss = (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, VIDEO_ID);
    } catch {
      /* ignore storage failures (e.g. private mode) */
    }
  };

  const title = t('sidebar.video_news.title', { defaultValue: 'Uberization of Construction' });
  const watch = t('sidebar.video_news.watch', { defaultValue: 'Watch' });

  return (
    <div
      data-testid="sidebar-video-news"
      className="group mx-2 mb-2 relative overflow-hidden rounded-lg border border-border-light bg-surface-elevated shadow-md shadow-black/5 ring-1 ring-black/5 transition-shadow animate-card-in hover:shadow-lg dark:ring-white/5"
    >
      <a
        href={VIDEO_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${title} - ${watch}`}
        data-testid="sidebar-video-news-link"
        className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60"
      >
        <div className="relative aspect-video w-full overflow-hidden bg-black">
          <img
            src={THUMBNAIL}
            alt={title}
            loading="lazy"
            draggable={false}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
          {/* Legibility gradient for the badge + play button. */}
          <div
            className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/0 to-black/10"
            aria-hidden="true"
          />
          {/* "Video" badge. */}
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white backdrop-blur-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />
            {t('sidebar.video_news.badge', { defaultValue: 'Video' })}
          </span>
          {/* Play overlay. */}
          <div className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white/20 shadow-lg ring-1 ring-white/50 backdrop-blur-md transition duration-200 group-hover:scale-105 group-hover:bg-white/30">
              <Play size={18} className="ml-0.5 fill-white text-white" />
            </span>
          </div>
        </div>
        <div className="px-3 py-2.5">
          <p className="break-words text-[13px] font-bold leading-tight text-content-primary">
            {title}
          </p>
          <p className="mt-1 text-[11px] leading-snug text-content-secondary">
            {t('sidebar.video_news.subtitle', {
              defaultValue: 'Open data, transparency, and the idea behind the platform',
            })}
          </p>
          <div className="mt-2 flex items-center justify-end gap-1 text-[11px] font-semibold text-blue-600 dark:text-sky-300">
            {watch}
            <ExternalLink size={11} />
          </div>
        </div>
      </a>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label={t('common.dismiss', { defaultValue: 'Dismiss' })}
        data-testid="sidebar-video-news-dismiss"
        className="absolute right-1.5 top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded bg-black/35 text-white/85 backdrop-blur-sm transition-colors hover:bg-black/55 hover:text-white"
      >
        <X size={11} />
      </button>
    </div>
  );
}
