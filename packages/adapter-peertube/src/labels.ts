/** PeerTube's fixed lists (server/core/initializers/constants.ts), in English. */

export const CATEGORIES: Record<number, string> = {
  1: "Music",
  2: "Films",
  3: "Vehicles",
  4: "Art",
  5: "Sports",
  6: "Travels",
  7: "Gaming",
  8: "People",
  9: "Comedy",
  10: "Entertainment",
  11: "News & Politics",
  12: "How To",
  13: "Education",
  14: "Activism",
  15: "Science & Technology",
  16: "Animals",
  17: "Kids",
  18: "Food",
};

export const LICENCES: Record<number, string> = {
  1: "Attribution",
  2: "Attribution - Share Alike",
  3: "Attribution - No Derivatives",
  4: "Attribution - Non Commercial",
  5: "Attribution - Non Commercial - Share Alike",
  6: "Attribution - Non Commercial - No Derivatives",
  7: "Public Domain Dedication",
};

export const PRIVACIES: Record<number, string> = {
  1: "Public",
  2: "Unlisted",
  3: "Private",
  4: "Internal",
  5: "Password protected",
};

export const PLAYLIST_PRIVACIES: Record<number, string> = { 1: "Public", 2: "Unlisted", 3: "Private" };

export const STATES: Record<number, string> = {
  1: "Published",
  2: "To transcode",
  3: "To import",
  4: "Waiting for livestream",
  5: "Livestream ended",
  6: "To move to an external storage",
  7: "Transcoding failed",
  8: "External storage move failed",
  9: "To edit using studio edition",
};

/** The languages PeerTube offers most often; any other code is shown as itself. */
export const LANGUAGES: Record<string, string> = {
  ar: "Arabic",
  ca: "Catalan",
  cs: "Czech",
  da: "Danish",
  de: "German",
  el: "Greek",
  en: "English",
  eo: "Esperanto",
  es: "Spanish",
  eu: "Basque",
  fa: "Persian",
  fi: "Finnish",
  fr: "French",
  ga: "Irish",
  gd: "Gaelic",
  gl: "Galician",
  he: "Hebrew",
  hi: "Hindi",
  hu: "Hungarian",
  id: "Indonesian",
  is: "Icelandic",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  mi: "Maori",
  nl: "Dutch",
  no: "Norwegian",
  oc: "Occitan",
  pl: "Polish",
  pt: "Portuguese",
  ro: "Romanian",
  ru: "Russian",
  sk: "Slovak",
  sv: "Swedish",
  th: "Thai",
  tr: "Turkish",
  uk: "Ukrainian",
  vi: "Vietnamese",
  zh: "Chinese",
};

export const label = <K extends string | number>(table: Record<K, string>, id: K | null | undefined, unknown = "Unknown") => ({
  id: id ?? null,
  label: id === null || id === undefined ? unknown : (table[id] ?? String(id)),
});
