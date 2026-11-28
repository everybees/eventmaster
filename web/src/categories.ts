export interface CategoryStyle {
  short: string; // chip and card label
  fill: string;  // the category's colour block: pills, chip dots, cards without an image
  on: string;    // text on that fill (every pair passes 4.5:1)
}

const INK = "#3C1A0D"; // --ink in styles.css
const WHITE = "#FFFFFF";

// Category names come from crawler/events.py (CATEGORY_RULES); this is only how each one looks.
// Meerkot: warm blocks, each a different hue, always with a text label (never colour alone).
export const CATEGORY_STYLES: Record<string, CategoryStyle> = {
  "Music & Concerts": { short: "Music", fill: "#5B2C83", on: WHITE },
  "Movies & Film": { short: "Movies", fill: "#E879A0", on: INK },
  "Arts & Theatre": { short: "Arts", fill: "#5CC39A", on: INK },
  "Exhibitions & Attractions": { short: "Exhibitions", fill: "#8FCBEA", on: INK },
  "Family & Kids": { short: "Family", fill: "#F4B63F", on: INK },
  "Social, Dating & Games": { short: "Social", fill: "#F08A6C", on: INK },
  "Sports & Outdoors": { short: "Sports", fill: "#A8C256", on: INK },
  "Nightlife & Parties": { short: "Nightlife", fill: INK, on: "#F39A4E" },
  "Professional & Learning": { short: "Professional", fill: "#1F4E79", on: WHITE },
  "Talks & Lectures": { short: "Talks", fill: "#2A9DB0", on: INK },
  "Community & Fundraisers": { short: "Community", fill: "#C7B3EB", on: INK },
  "Markets & Fairs": { short: "Markets", fill: "#F39A4E", on: INK },
  Wellness: { short: "Wellness", fill: "#F9D3A8", on: INK },
  "Food & Drink": { short: "Food", fill: "#B8322B", on: WHITE },
  Other: { short: "Other", fill: "#EADBC8", on: INK },
};

export const CATEGORY_ORDER = Object.keys(CATEGORY_STYLES);

export const styleFor = (category: string): CategoryStyle => CATEGORY_STYLES[category] ?? CATEGORY_STYLES.Other;
