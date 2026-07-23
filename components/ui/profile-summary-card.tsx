import { cardClasses } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { InitialsAvatar, type AvatarTone } from "@/components/ui/avatar";

/**
 * A polished identity/profile summary — an avatar, a name, a status badge, and a
 * grid of labelled facts. Used for a settled, successful entity such as an active
 * Retailer Owner.
 *
 * It renders ONLY what the caller passes. It never derives, fetches, or exposes
 * an identifier: the avatar is built from the display name alone, and the details
 * are whatever display-safe facts the server already resolved. Do not pass it any
 * value the surrounding page would not otherwise render.
 */
export type ProfileDetail = { label: string; value: React.ReactNode };

export function ProfileSummaryCard({
  name,
  avatarTone = "emerald",
  badge,
  details,
  accent,
  className,
}: {
  name: string;
  avatarTone?: AvatarTone;
  badge?: React.ReactNode;
  details?: ProfileDetail[];
  /** Optional completed-state accent shown top-right (e.g. a check chip). */
  accent?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cardClasses("standard", cn("p-6", className))}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <InitialsAvatar name={name} tone={avatarTone} size="lg" />
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold text-slate-900">{name}</p>
            {badge && <div className="mt-1">{badge}</div>}
          </div>
        </div>
        {accent && <div className="shrink-0">{accent}</div>}
      </div>

      {details && details.length > 0 && (
        <dl className="mt-6 grid grid-cols-1 gap-x-6 gap-y-4 border-t border-slate-100 pt-5 sm:grid-cols-2">
          {details.map((detail) => (
            <div key={detail.label}>
              <dt className="text-xs font-medium text-slate-500">{detail.label}</dt>
              <dd className="mt-0.5 break-words text-sm text-slate-900">
                {detail.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
