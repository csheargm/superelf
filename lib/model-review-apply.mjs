// Writing chat_models, and taking it back · 写入与撤销 chat_models (docs/adr/0017)
//
// The model review is the one job that edits config.json, and only its `chat_models` key:
//   - the file is re-read fresh and every other key is written back as it is;
//   - the WHOLE candidate goes through the loader's own validator (lib/config.mjs validateConfig)
//     before anything is written, so a list another key cannot live with (health_llm, assess_models,
//     research.llm, vision_default naming a removed id) is refused, never half-applied;
//   - the write is atomic (tmp + rename), and the running node's config watcher reloads it with no
//     restart (docs/adr/0011);
//   - model-review.json is written FIRST with what Undo needs, then config.json; if the config write
//     fails, the state is put back and the error rethrown, so a failed run changes nothing.
// Undo restores the list from before the last change, but only while config.json still holds
// exactly what the review wrote: an edit made since is the owner's, and Undo never overwrites it.
import fs from 'node:fs';
import { configPath, validateConfig } from './config.mjs';
import { writeJsonFile } from './atomicwrite.mjs';
import { readReviewState, writeReviewState, MODEL_REVIEW_FILENAME } from './model-review-config.mjs';

export const readRawConfig = (root) => JSON.parse(fs.readFileSync(configPath(root), 'utf8'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The list the file stands for: its own chat_models, or with no key the loader's defaults, minus
// the Research lane the loader appends when a Tavily key is set (writing it would freeze it in).
export function baseLanes(raw, root) {
  if (Array.isArray(raw.chat_models)) return raw.chat_models;
  const c = structuredClone(raw);
  delete c.chat_models;
  return validateConfig(c, root).chat_models.filter((m) => m.provider !== 'research');
}

// `lanes` null = drop the key (back to the loader's defaults). Throws when the loader refuses it.
function candidateWith(raw, lanes, root) {
  const c = { ...raw };
  if (lanes === null) delete c.chat_models; else c.chat_models = lanes;
  return { candidate: c, loaded: validateConfig(structuredClone(c), root) };
}

// State first, then config; a failed config write puts the state back (R5: both errors kept).
function writeBoth({ root, stateFile, prevState, nextState, candidate }) {
  writeReviewState(stateFile, nextState);
  try { writeJsonFile(configPath(root), candidate); }
  catch (e) {
    try { writeReviewState(stateFile, prevState); }
    catch (e2) { throw new Error(`${e.message}; putting back ${MODEL_REVIEW_FILENAME} failed too: ${e2.message}`, { cause: e }); }
    throw e;
  }
}

// { outcome: 'applied' | 'changed' | 'refused', why?, state } — `state` is what was written, or
// for changed/refused the state the caller writes (nothing touched config.json then).
// url: the ollama_url the run built its names for; the file now naming another endpoint is a change too.
export function applyReview({ root, stateFile, state, nextState, base, next, added, now, url }) {
  const raw = readRawConfig(root);
  if (!same(baseLanes(raw, root), base)) return { outcome: 'changed', state: nextState };
  let candidate, loaded;
  try { ({ candidate, loaded } = candidateWith(raw, next, root)); }
  catch (e) { return { outcome: 'refused', why: String((e && e.message) || e), state: nextState }; }
  if (url !== undefined && loaded.ollama_url !== url) return { outcome: 'changed', state: nextState };
  const hadKey = Array.isArray(raw.chat_models);
  const withUndo = { ...nextState, undo: { at: now, hadKey, previous: hadKey ? raw.chat_models : null, applied: next, added } };
  writeBoth({ root, stateFile, prevState: state, nextState: withUndo, candidate });
  return { outcome: 'applied', state: withUndo };
}

// null = nothing to undo. Otherwise { at, restored: [lanes] }. Throws, changing nothing, when the
// state is unreadable, config.json was edited since, or the loader refuses the old list.
export function undoReview({ root, stateFile }) {
  const state = readReviewState(stateFile);
  const u = state.undo;
  if (!u) return null;
  const raw = readRawConfig(root);
  if (!same(raw.chat_models, u.applied)) {
    throw new Error('config.json chat_models was edited after the review changed it, so Undo would overwrite that edit; nothing undone · '
      + '评测更改后 chat_models 又被修改，撤销会覆盖该修改，未作撤销');
  }
  const { candidate } = candidateWith(raw, u.hadKey ? u.previous : null, root);
  const nextState = { ...state, undo: null, declined: [...new Set([...state.declined, ...(u.added || [])])] };
  writeBoth({ root, stateFile, prevState: state, nextState, candidate });
  return { at: u.at, restored: baseLanes(candidate, root) };
}
