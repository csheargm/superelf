// Waits for a visitor's background app build (lib/demo-build-job.mjs) to end; returns its job.
// `req(path, {token})` is the test file's own fetch helper.
import { waitFor } from './helpers-web.mjs';
import { BUILD_JOB_PATH } from '../lib/demo-build-job.mjs';

export const jobOf = async (req, v) => (await (await req(BUILD_JOB_PATH, { token: v.token })).json()).job;
export const waitBuilt = (req, v, opts) => waitFor(async () => { const j = await jobOf(req, v); return j && j.status !== 'building' && j; }, 'the build', opts);
