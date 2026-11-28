// The Meerkot logo in the app. The files are in web/public/icons (precached, vite.config.ts → includeAssets):
// icon.svg and mascot.svg are the designer's vector exports; the PNG icons are rendered from icon.svg.

/** The app icon, beside a screen's title. */
export const Brand = () => <img className="brand" src="/icons/icon.svg" alt="Meerkot" width={44} height={44} />;

/** The meerkat standing at the bottom of an empty card. */
export const Mascot = () => <img className="empty-mascot" src="/icons/mascot.svg" alt="" width={150} height={177} />;
