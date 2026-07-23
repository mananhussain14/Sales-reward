import { BrandLockup } from "@/components/ui/brand";
import { cn } from "@/components/ui/cn";
import { CheckIcon, MailIcon } from "@/components/ui/icons";

/**
 * The focused onboarding surface shared by every invitation screen.
 *
 * A calm, centered card under the brand lockup, with an optional stage indicator
 * and a tinted icon disc — a secure, unhurried visual language for someone
 * joining the platform. It is presentation only: it renders whatever title,
 * body and controls the caller supplies and reveals nothing on its own, so the
 * invitation pages keep full control over their deliberately generic wording.
 */
type DiscTone = "indigo" | "emerald" | "amber";

const DISC_TONES: Record<DiscTone, string> = {
  indigo: "bg-indigo-50 text-indigo-600 ring-indigo-100",
  emerald: "bg-emerald-50 text-emerald-600 ring-emerald-100",
  amber: "bg-amber-50 text-amber-600 ring-amber-100",
};

/**
 * A three-segment onboarding progress bar. Labels are generic ("Invite → Set up
 * → Done"), so no stage discloses anything about the specific invitation.
 */
export function StageIndicator({
  steps,
  activeStep,
}: {
  steps: string[];
  activeStep: number;
}) {
  return (
    <ol className="mb-6 flex items-center gap-2" aria-label="Onboarding progress">
      {steps.map((label, index) => {
        const done = index < activeStep;
        const active = index === activeStep;
        return (
          <li key={label} className="flex flex-1 flex-col items-center gap-1.5">
            <span className="flex w-full items-center gap-2">
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[0.7rem] font-semibold ring-1 ring-inset transition-colors",
                  done && "bg-indigo-600 text-white ring-indigo-600",
                  active && "bg-indigo-50 text-indigo-700 ring-indigo-300",
                  !done && !active && "bg-slate-100 text-slate-400 ring-slate-200",
                )}
                aria-current={active ? "step" : undefined}
              >
                {done ? <CheckIcon className="h-3.5 w-3.5" /> : index + 1}
              </span>
              {index < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-0.5 flex-1 rounded-full",
                    done ? "bg-indigo-600" : "bg-slate-200",
                  )}
                />
              )}
            </span>
            <span
              className={cn(
                "text-center text-[0.7rem] font-medium",
                active ? "text-indigo-700" : "text-slate-400",
              )}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function InvitationShell({
  icon,
  iconTone = "indigo",
  title,
  description,
  steps,
  activeStep = 0,
  children,
}: {
  icon?: React.ReactNode;
  iconTone?: DiscTone;
  title: React.ReactNode;
  description?: React.ReactNode;
  steps?: string[];
  activeStep?: number;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 py-12">
      <main className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <BrandLockup size={40} idSuffix="-invite" />
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-card sm:p-8">
          {steps && <StageIndicator steps={steps} activeStep={activeStep} />}

          <div className="flex flex-col items-center text-center">
            <span
              aria-hidden="true"
              className={cn(
                "mb-4 flex h-12 w-12 items-center justify-center rounded-2xl ring-1 ring-inset",
                DISC_TONES[iconTone],
              )}
            >
              {icon ?? <MailIcon className="h-6 w-6" />}
            </span>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">
              {title}
            </h1>
            {description && (
              <p className="mt-2 text-sm text-slate-500">{description}</p>
            )}
          </div>

          {children && <div className="mt-6 text-left">{children}</div>}
        </div>
      </main>
    </div>
  );
}
