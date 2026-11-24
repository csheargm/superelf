// Built-in app pages that existed BEFORE the repo had them · 入库前的内置应用版本
// tools/gen-builtin-app-versions.mjs builds lib/builtin-app-versions.json from git history; a page
// copied INTO the repo from a node was never in that history, so the node's copy looked "edited" and
// was never upgraded. Each hash here is such an original, checked line by line against the first
// repo commit (the only difference being an approved change such as the 中文-first flip).
export const PAST_VERSIONS = {
  // The private node's English-first copy that ac98ca8 imported; every changed line of ac98ca8's
  // page is a reorder of this one (each "English · 中文" pair flipped to "中文 · English").
  'sunday-study': ['a0c5b5993e67029647a2d4d939e48fb4e1773219321ab4539b4cecf274e0f38a'],
};
