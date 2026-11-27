import type { ReactNode } from "react";
import type { InstallWay } from "../install.ts";

/** A card at the top of Discover that offers one thing, with two equal answers. One shows at a time. */
export function PromptCard({ id, title, children, yes, no, onYes, onNo }: {
  id: string; title: string; children: ReactNode; yes: string; no?: string; onYes(): void; onNo?(): void;
}) {
  return (
    <section className="prompt" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{title}</h2>
      <p>{children}</p>
      <div className="prompt-actions">
        <button type="button" className="bar-btn" onClick={onYes}>{yes}</button>
        {no && onNo && <button type="button" className="bar-btn" onClick={onNo}>{no}</button>}
      </div>
    </section>
  );
}

/** Offered after the first save, where the browser can show notifications. */
export function RemindersPrompt({ onYes, onNo }: { onYes(): void; onNo(): void }) {
  return (
    <PromptCard id="reminders" title="Get reminders?" yes="Turn on" no="Not now" onYes={onYes} onNo={onNo}>
      We’ll remind you at 6 pm the day before and 2 hours before the events you save. Turn them off any time in Saved.
    </PromptCard>
  );
}

/** Offered after a few saves (on iPhone, after the first: reminders there need it). */
export function InstallPrompt({ way, onYes, onNo }: { way: Exclude<InstallWay, null>; onYes(): void; onNo(): void }) {
  if (way === "ios") {
    return (
      <PromptCard id="install" title="Add it to your Home Screen?" yes="OK" onYes={onNo}>
        Tap Share, then Add to Home Screen. It opens like an app, and on iPhone that’s what lets it send reminders.
      </PromptCard>
    );
  }
  return (
    <PromptCard id="install" title="Add it to your home screen?" yes="Add" no="Not now" onYes={onYes} onNo={onNo}>
      Open what’s on in one tap, like any other app.
    </PromptCard>
  );
}
