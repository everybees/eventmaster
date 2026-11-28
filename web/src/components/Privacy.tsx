import { useEffect, useRef, type ReactNode } from "react";
import { IconX } from "./icons.tsx";
import { PromptCard } from "./Prompts.tsx";

// Who runs the app and how to reach them, set at build time (Netlify → Environment variables) so they
// aren't in the public repo. The notice needs a contact before a public launch.
const OPERATOR = (import.meta.env.VITE_OPERATOR_NAME as string | undefined)?.trim();
const CONTACT = (import.meta.env.VITE_PRIVACY_EMAIL as string | undefined)?.trim();
const UPDATED = "27 November 2026"; // change when the notice changes

/** The privacy notice, as a sheet. Also at /privacy. */
export function PrivacyNotice({ onClose }: { onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);

  const write = CONTACT ? <a href={`mailto:${CONTACT}`}>{CONTACT}</a> : null;
  return (
    <dialog ref={dialog} className="sheet notice" aria-labelledby="privacy-title"
      onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div className="sheet-body">
        <div className="sheet-head">
          <h2 id="privacy-title">Privacy notice</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><IconX /></button>
        </div>
        <p className="fine">Last updated {UPDATED}</p>

        <p>
          Meerkot shows what’s on in your city. This notice explains what the app collects, why, who else
          handles it, and how you control it. There are no accounts: we never ask for your name, email address or
          phone number.
        </p>

        <Section title="Who we are">
          <p>
            {OPERATOR || "The team behind Meerkot"} runs this app and is responsible for your data.
            {write && <> For questions or requests, write to {write}.</>}
          </p>
        </Section>

        <Section title="What we collect">
          <ul>
            <li>
              <b>A random ID for this device.</b> The app makes it the first time it runs. It isn’t linked to your
              name, phone number or advertising ID; it’s how we tell your data apart from other people’s.
            </li>
            <li>
              <b>Your activity, only if you allow it.</b> The events you see, save, pass or move to later; opening an
              event’s details; tapping its tickets, map, web page, share or calendar buttons; saying you’re going; and
              your answers to “Did you go?” and how it was. Each comes with the time, the category you were browsing,
              and whether you swiped or tapped. We also keep your latest choice for each event (saved, passed or
              later).
            </li>
            <li>
              <b>Reminders, only if you turn them on.</b> Your browser gives us an address at its push service
              (Google, Apple, Mozilla or Microsoft, depending on the browser), and the app sends us the saved events
              still ahead, so we can remind you at 6 pm the day before and 2 hours before. Reminders are encrypted, so
              the push service can’t read them.
            </li>
            <li>
              <b>Counts with no ID at all:</b> how many people a day answer yes or no to sharing their activity, and
              how many install the app.
            </li>
            <li>
              <b>Cities you ask us to add:</b> the place, when you asked, and your device ID. We use these to count how
              many people want each city and to limit requests to five a day per device.
            </li>
            <li>
              <b>Events you suggest:</b> the link, the city, anything you write with it, when you sent it, and your
              device ID. We use them to add events to the app and to limit suggestions to ten a day per device. An
              event we add is public like any other, but it doesn’t say who suggested it, and your suggestion isn’t
              shown to anyone.
            </li>
            <li>
              <b>Your location, only when you tap “Use my location”.</b> Your browser asks your permission first. If
              you’re within 25 km of a city we cover, the app works that out on your phone and sends nothing.
              Otherwise it sends your position rounded to about 10 km, only to name your city or town. We don’t store
              it.
            </li>
            <li>
              <b>Technical data.</b> As with any website, our hosting provider receives your IP address and browser
              details to deliver the app, and may keep them in its logs for a short time for security. We don’t store
              your IP address with your data.
            </li>
          </ul>
          <p>
            The city you picked and your saved events are kept on your phone, in your browser’s storage. The app
            doesn’t use cookies or advertising trackers. Its fonts come from our own servers, and event pictures
            usually do too; when our copy of a picture can’t be made, your browser loads it from the site it comes
            from, which then sees your IP address, as with any web page.
          </p>
        </Section>

        <Section title="Why we use it">
          <ul>
            <li>to show events in your city and remember your choices</li>
            <li>to send the reminders you asked for</li>
            <li>
              to learn which events and kinds of events people are interested in, so we can improve and rank the
              feed (for example, “popular this week”, counted across many people)
            </li>
            <li>to decide which cities to add next, and to add the events people tell us about</li>
            <li>to keep the service running and stop abuse</li>
          </ul>
          <p>
            We don’t sell your data, share it with advertisers, or combine it with information about you from
            elsewhere. The app shows counts across many people, such as “40 interested”, only once at least 10 people
            have shown interest in an event; those never identify anyone, and we keep them after events end.
          </p>
        </Section>

        <Section title="Who else handles it">
          <ul>
            <li>
              <b>Netlify</b> hosts the app and <b>MongoDB Atlas</b> stores the data. They handle it only on our
              behalf, under contracts that require them to protect it. Their servers may be outside your country,
              including in the United States.
            </li>
            <li>
              <b>Your browser’s push service</b> delivers reminders, if you turn them on. It sees that a message is
              on its way to your device, not what it says.
            </li>
            <li>
              <b>Sites you choose to open.</b> “Get tickets”, map links and an event’s own page take you to that site
              (a ticket seller, Google Maps, the organizer), where its own privacy policy applies. Some ticket links
              are affiliate links: the seller can tell you came from us and may pay us a commission. We don’t send
              them anything about you.
            </li>
          </ul>
        </Section>

        <Section title="How long we keep it">
          <p>
            Until you delete it. Your activity, choices, city requests and suggestions stay on our servers until you tap{" "}
            <b>Delete my data</b> in the Saved tab. Reminder details stay until you turn reminders off or delete your
            data, and we delete them ourselves if the push service tells us the address no longer works.
          </p>
          <p>
            Delete your data before you uninstall the app or clear your browser’s data. The device ID lives in your
            browser, and without it we can’t tell which data is yours. <b>Download my data</b> gives you a file with
            the ID in it{write ? <>; send it to {write} and we’ll delete the data for you</> : null}.
          </p>
        </Section>

        <Section title="Your choices and rights">
          <ul>
            <li>
              <b>Activity sharing</b> is off until you allow it, and you can switch it on or off at any time in the
              Saved tab. Turning it off stops anything more being sent.
            </li>
            <li><b>Reminders</b> are off until you turn them on, and the switch in Saved turns them off again.</li>
            <li><b>See your data:</b> “Download my data” gives you everything we hold for this device.</li>
            <li>
              <b>Delete your data:</b> “Delete my data” erases your activity, choices, reminders, city requests and
              suggestions from our servers, and the app starts over with a new ID. Events we added from your
              suggestions stay listed.
            </li>
            <li>
              <b>Location:</b> you can decline the browser’s prompt, or turn location off for this site in your
              browser’s settings.
            </li>
          </ul>
          <p>
            You can also ask us what we hold about you, ask us to correct or delete it, or withdraw your consent
            {write ? <>, by writing to {write}</> : null}. We’ll reply within 30 days. If you’re not satisfied, you
            can complain to the{" "}
            <a href="https://www.priv.gc.ca" target="_blank" rel="noopener noreferrer">Office of the Privacy Commissioner of Canada</a>
            {" "}in Canada, the{" "}
            <a href="https://ndpc.gov.ng" target="_blank" rel="noopener noreferrer">Nigeria Data Protection Commission</a>
            {" "}in Nigeria, or your local data protection authority elsewhere.
          </p>
        </Section>

        <Section title="Security">
          <p>
            Data travels over encrypted connections (HTTPS) and is stored encrypted by our database provider. Only the
            people who run the app can access it.
          </p>
        </Section>

        <Section title="Children">
          <p>The app isn’t aimed at children. If you’re under 18, ask a parent or guardian before allowing activity sharing.</p>
        </Section>

        <Section title="Changes">
          <p>
            If we change this notice, we’ll update the date at the top. If a change affects what we collect, the app
            will ask you again.
          </p>
        </Section>
      </div>
    </dialog>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** Asked once, on the Discover screen: nothing about what they do is recorded until they answer yes. */
export function ConsentBanner({ onAnswer, onReadMore }: { onAnswer(yes: boolean): void; onReadMore(): void }) {
  return (
    <PromptCard id="consent" title="Help improve the feed?" yes="Allow" no="No thanks"
      onYes={() => onAnswer(true)} onNo={() => onAnswer(false)}>
      With your OK, the app sends what you see, save and tap, with a random ID for this device. No name, email or
      precise location. You can change this any time in Saved.{" "}
      <button type="button" className="inline-link" onClick={onReadMore}>Privacy notice</button>
    </PromptCard>
  );
}
