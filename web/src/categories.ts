export interface CategoryStyle {
  short: string; // chip and card label
  fill: string;  // the category's colour block: pills, chip dots, cards without an image
  on: string;    // text on that fill (every pair passes 4.5:1)
}

const INK = "#111111";
const WHITE = "#FFFFFF";

// Category names come from crawler/events.py (CATEGORY_RULES); this is only how each one looks.
// Poster Pop: saturated blocks, each a different hue, always with a text label (never colour alone).
export const CATEGORY_STYLES: Record<string, CategoryStyle> = {
  "Music & Concerts": { short: "Music", fill: "#5B3DF5", on: WHITE },
  "Movies & Film": { short: "Movies", fill: "#FF7AB8", on: INK },
  "Arts & Theatre": { short: "Arts", fill: "#3DDC97", on: INK },
  "Exhibitions & Attractions": { short: "Exhibitions", fill: "#6CD4FF", on: INK },
  "Family & Kids": { short: "Family", fill: "#FFB020", on: INK },
  "Social, Dating & Games": { short: "Social", fill: "#FF5A36", on: INK },
  "Sports & Outdoors": { short: "Sports", fill: "#A3E635", on: INK },
  "Nightlife & Parties": { short: "Nightlife", fill: INK, on: "#FFE14D" },
  "Professional & Learning": { short: "Professional", fill: "#0F4C81", on: WHITE },
  "Talks & Lectures": { short: "Talks", fill: "#00B8D9", on: INK },
  "Community & Fundraisers": { short: "Community", fill: "#C9B8FF", on: INK },
  "Markets & Fairs": { short: "Markets", fill: "#FF9A4D", on: INK },
  Wellness: { short: "Wellness", fill: "#FFD6A5", on: INK },
  "Food & Drink": { short: "Food", fill: "#C81E3A", on: WHITE },
  Other: { short: "Other", fill: "#E5E5E5", on: INK },
};

export const CATEGORY_ORDER = Object.keys(CATEGORY_STYLES);

export const styleFor = (category: string): CategoryStyle => CATEGORY_STYLES[category] ?? CATEGORY_STYLES.Other;
